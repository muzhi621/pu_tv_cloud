/**
 * 配置契约（EdgeOne Edge Functions 版）。
 *
 * 与 cloud/schema.py 逐条对齐：四节校验、未知/退役 id 过滤、空列表兜底、
 * 类型错误 400、内容问题记 warning 后自动兜底。终端 APK 拿到的 JSON 结构
 * 与阿里云 FC 版完全一致，切换部署目标不需要改客户端。
 *
 * 依赖的 SEED / CATALOG 由 scripts/build_edgeone_assets.py 从
 * config/seed.json 与 config/site_catalog.json 生成，切勿手改 data.js。
 */
import { SEED, CATALOG, SCHEMA_VERSION } from './data.js';

export { SCHEMA_VERSION };
export { CATALOG };

export const SECTION_KEYS = ['sites', 'navigation', 'startup', 'update', 'iptv'];
const MAX_TEXT_LEN = 20000;
const MAX_LIST_ITEMS = 200;
/** 单份配置文档必须能塞进 Edge Functions 的请求体上限，频道列表要设硬上限。 */
export const MAX_IPTV_CHANNELS = 3000;
export const MAX_DOCUMENT_BYTES = 900 * 1024;
const VERSION_RE = /^\d+(?:\.\d+){0,3}$/;
const URL_RE = /^https?:\/\/[^\s]+$/i;
const IPTV_URL_RE = /^(https?|rtmp|rtsp|udp|mms|p2p):\/\/[^\s]+$/i;

const VALID_SITE_IDS = CATALOG.sites.filter((item) => !item.retired).map((item) => item.id);
const RETIRED_SITE_IDS = new Set(CATALOG.sites.filter((item) => item.retired).map((item) => item.id));
const VALID_MENU_IDS = CATALOG.menus.map((item) => item.id);

/**
 * 大小写无关索引：小写 → catalog 中的原始 id。
 * 客户端使用驼峰 id（favoriteAreas / moviePlayback），若直接转小写比对会全部
 * 判为未知并被丢弃；这里只把「比对」降级为大小写无关，写回时仍用原始 id。
 */
function idIndex(ids) {
  const map = new Map();
  for (const id of ids) map.set(String(id).trim().toLowerCase(), id);
  return map;
}

const VALID_SITE_BY_LOWER = idIndex(VALID_SITE_IDS);
const RETIRED_SITE_BY_LOWER = idIndex([...RETIRED_SITE_IDS]);
const VALID_MENU_BY_LOWER = idIndex(VALID_MENU_IDS);
const VALID_PROMPTS = new Set(CATALOG.updatePrompts);
const VALID_NOTICE_MODES = new Set(CATALOG.noticeModes);

export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

const clone = (value) => JSON.parse(JSON.stringify(value));

export function nowIso() {
  // 与 Python datetime.now(timezone(+8)).isoformat(timespec="seconds") 同形状。
  const shifted = new Date(Date.now() + 8 * 3600 * 1000);
  return shifted.toISOString().replace(/\.\d{3}Z$/, '') + '+08:00';
}

export function seedDocument() {
  return clone(SEED);
}

export function etagFor(revision) {
  return `"${revision}"`;
}

function bool(value, fallback, field) {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'boolean') return value;
  throw new ConfigError(`${field} 必须是布尔值`);
}

function int(value, fallback, low, high, field) {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new ConfigError(`${field} 必须是整数`);
  }
  if (value < low || value > high) {
    throw new ConfigError(`${field} 必须在 ${low}~${high} 之间`);
  }
  return value;
}

function str(value, fallback, field, limit = 200) {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'string') throw new ConfigError(`${field} 必须是字符串`);
  return value.trim().slice(0, limit);
}

/** undefined 表示「未提供」，调用方保留 seed 值。 */
function strList(value, field) {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw new ConfigError(`${field} 必须是字符串数组`);
  if (value.length > MAX_LIST_ITEMS) throw new ConfigError(`${field} 最多 ${MAX_LIST_ITEMS} 项`);
  if (value.some((item) => typeof item !== 'string')) {
    throw new ConfigError(`${field} 必须是字符串数组`);
  }
  return value.map((item) => item.trim()).filter(Boolean);
}

function i18n(value, field) {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new ConfigError(`${field} 必须是 {locale: text} 对象`);
  }
  const result = {};
  for (const [key, text] of Object.entries(value)) {
    if (typeof text === 'string') result[key.trim().slice(0, 16)] = text.slice(0, MAX_TEXT_LEN);
  }
  return result;
}

function enumeration(value, fallback, allowed, field) {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'string' || !allowed.has(value)) {
    throw new ConfigError(`${field} 必须是 ${[...allowed].sort().join('/')} 之一`);
  }
  return value;
}

function urls(value, field) {
  const items = strList(value, field);
  if (items === undefined) return [];
  return items.filter((item) => URL_RE.test(item)).slice(0, 50);
}

function filterIds(raw, validIndex, seed, field, warnings) {
  if (raw === undefined) return [...seed];
  const result = [];
  const seen = new Set();
  for (const item of raw) {
    const key = item.trim().toLowerCase();
    if (RETIRED_SITE_BY_LOWER.has(key)) {
      warnings.push(`${field}: 忽略退役站点 ${key}`);
      continue;
    }
    const canonical = validIndex.get(key);
    if (canonical === undefined) {
      warnings.push(`${field}: 忽略未知 id ${key}`);
      continue;
    }
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(canonical);
  }
  if (result.length === 0) {
    warnings.push(`${field}: 白名单为空，回退内置全量（防止客户端 .first 崩溃）`);
    return [...seed];
  }
  return result;
}

function normalizeSites(part, warnings) {
  const base = clone(SEED.sections.sites);
  base.managed = bool(part.managed, false, 'sites.managed');
  let policy = str(part.policy, 'whitelist', 'sites.policy', 32);
  if (policy !== 'whitelist') {
    warnings.push('sites.policy: v1 仅支持 whitelist，已回退');
    policy = 'whitelist';
  }
  base.policy = policy;
  base.enabledSiteIds = filterIds(
    strList(part.enabledSiteIds, 'sites.enabledSiteIds'),
    VALID_SITE_BY_LOWER,
    base.enabledSiteIds,
    'sites.enabledSiteIds',
    warnings,
  );
  return base;
}

function normalizeNavigation(part, warnings) {
  const base = clone(SEED.sections.navigation);
  base.managed = bool(part.managed, false, 'navigation.managed');
  base.railMenuIds = filterIds(
    strList(part.railMenuIds, 'navigation.railMenuIds'),
    VALID_MENU_BY_LOWER,
    base.railMenuIds,
    'navigation.railMenuIds',
    warnings,
  );
  base.sidebarExpanded = bool(part.sidebarExpanded, base.sidebarExpanded, 'navigation.sidebarExpanded');
  base.homeKeepAlive = bool(part.homeKeepAlive, base.homeKeepAlive, 'navigation.homeKeepAlive');

  // P1 预留节：v1 只允许隐藏已有条目，不允许新增。
  const settingsPart = part.settings;
  if (settingsPart !== undefined && settingsPart !== null) {
    if (typeof settingsPart !== 'object' || Array.isArray(settingsPart)) {
      throw new ConfigError('navigation.settings 必须是对象');
    }
    const settings = clone(base.settings);
    settings.managed = bool(settingsPart.managed, false, 'navigation.settings.managed');
    const paths = strList(settingsPart.enabledEntryPaths, 'navigation.settings.enabledEntryPaths');
    if (paths !== undefined) settings.enabledEntryPaths = paths.slice(0, 200);
    base.settings = settings;
  }
  return base;
}

function normalizeStartup(part, warnings) {
  const base = clone(SEED.sections.startup);
  base.managed = bool(part.managed, false, 'startup.managed');

  const agreement = part.agreement;
  if (agreement !== undefined && agreement !== null) {
    if (typeof agreement !== 'object' || Array.isArray(agreement)) {
      throw new ConfigError('startup.agreement 必须是对象');
    }
    const target = clone(base.agreement);
    target.enabled = bool(agreement.enabled, target.enabled, 'startup.agreement.enabled');
    target.requiredVersion = int(agreement.requiredVersion, target.requiredVersion, 0, 100000,
      'startup.agreement.requiredVersion');
    if ('titleI18n' in agreement) target.titleI18n = i18n(agreement.titleI18n, 'startup.agreement.titleI18n');
    if ('bodyI18n' in agreement) target.bodyI18n = i18n(agreement.bodyI18n, 'startup.agreement.bodyI18n');
    base.agreement = target;
  }

  const notice = part.notice;
  if (notice !== undefined && notice !== null) {
    if (typeof notice !== 'object' || Array.isArray(notice)) {
      throw new ConfigError('startup.notice 必须是对象');
    }
    const target = clone(base.notice);
    target.enabled = bool(notice.enabled, target.enabled, 'startup.notice.enabled');
    target.mode = enumeration(notice.mode, target.mode, VALID_NOTICE_MODES, 'startup.notice.mode');
    target.dismissible = bool(notice.dismissible, true, 'startup.notice.dismissible');
    if ('titleI18n' in notice) target.titleI18n = i18n(notice.titleI18n, 'startup.notice.titleI18n');
    if ('bodyI18n' in notice) target.bodyI18n = i18n(notice.bodyI18n, 'startup.notice.bodyI18n');
    base.notice = target;
  }

  base.showSplashPage = bool(part.showSplashPage, base.showSplashPage, 'startup.showSplashPage');
  if (base.notice.enabled && !base.notice.dismissible) {
    warnings.push('startup.notice: 不可关闭公告有阻断主界面风险，请复核');
  }
  return base;
}

function normalizeUpdate(part, warnings) {
  const base = clone(SEED.sections.update);
  base.managed = bool(part.managed, false, 'update.managed');
  base.autoCheck = bool(part.autoCheck, base.autoCheck, 'update.autoCheck');
  base.checkIntervalHours = int(part.checkIntervalHours, base.checkIntervalHours, 0, 8760,
    'update.checkIntervalHours');
  base.prompt = enumeration(part.prompt, base.prompt, VALID_PROMPTS, 'update.prompt');
  const version = str(part.minSupportedVersion, '', 'update.minSupportedVersion', 32);
  if (version && !VERSION_RE.test(version)) {
    throw new ConfigError('update.minSupportedVersion 格式应为 3.0.7 这样的数字点分版本');
  }
  base.minSupportedVersion = version;
  base.allowPrerelease = bool(part.allowPrerelease, base.allowPrerelease, 'update.allowPrerelease');
  base.allowUserOverride = bool(part.allowUserOverride, base.allowUserOverride, 'update.allowUserOverride');
  base.mirrorUrls = urls(part.mirrorUrls, 'update.mirrorUrls');
  if ('changelogI18n' in part) base.changelogI18n = i18n(part.changelogI18n, 'update.changelogI18n');
  if (base.prompt === 'force') {
    warnings.push('update.prompt=force 会阻断旧版本使用，请确认已配置可用下载地址');
  }
  return base;
}

/**
 * IPTV 源节：编辑器把 M3U / M3U8 / TXT 解析成精简频道列表后写进这里，
 * 云端只做校验与下发，不代理任何播放流量。
 *
 * channels[] 每项 {name, url, group, logo}，按 url 去重，硬上限 MAX_IPTV_CHANNELS。
 * sources[] 仅留原始订阅地址便于在编辑器里回显来源；epgUrl 可选。
 */
function normalizeIptv(part, warnings) {
  const base = clone(SEED.sections.iptv);
  base.managed = bool(part.managed, false, 'iptv.managed');

  const epg = str(part.epgUrl, '', 'iptv.epgUrl', 500);
  base.epgUrl = epg && URL_RE.test(epg) ? epg : '';
  if (epg && !base.epgUrl) warnings.push('iptv.epgUrl: 仅支持 http(s)，已忽略');

  const sources = strList(part.sources, 'iptv.sources');
  if (sources !== undefined) {
    base.sources = sources.filter((item) => URL_RE.test(item)).slice(0, 20);
    if (base.sources.length < sources.length) {
      warnings.push('iptv.sources: 已忽略非 http(s) 地址');
    }
  }

  const groups = strList(part.groups, 'iptv.groups');
  if (groups !== undefined) base.groups = groups.slice(0, MAX_LIST_ITEMS);

  const raw = part.channels;
  if (raw !== undefined && raw !== null) {
    if (!Array.isArray(raw)) throw new ConfigError('iptv.channels 必须是数组');
    const seen = new Set();
    const channels = [];
    let truncated = false;
    for (const item of raw) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
      const name = String(item.name == null ? '' : item.name).trim().slice(0, 120);
      const url = String(item.url == null ? '' : item.url).trim().slice(0, 1000);
      if (!name || !IPTV_URL_RE.test(url)) continue;
      const key = url.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      channels.push({
        name,
        url,
        group: String(item.group == null ? '' : item.group).trim().slice(0, 64),
        logo: String(item.logo == null ? '' : item.logo).trim().slice(0, 300),
      });
      if (channels.length >= MAX_IPTV_CHANNELS) { truncated = true; break; }
    }
    if (truncated) warnings.push(`iptv.channels: 超过 ${MAX_IPTV_CHANNELS} 条上限，已截断`);
    base.channels = channels;
  }
  return base;
}

const NORMALIZERS = {
  sites: normalizeSites,
  navigation: normalizeNavigation,
  startup: normalizeStartup,
  update: normalizeUpdate,
  iptv: normalizeIptv,
};

export function normalizeSections(raw) {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ConfigError('sections 必须是对象');
  }
  const warnings = [];
  const sections = clone(SEED.sections);
  const unknown = Object.keys(raw).filter((key) => !SECTION_KEYS.includes(key));
  if (unknown.length) warnings.push(`忽略未知节: ${unknown.sort().join(', ')}`);
  for (const key of SECTION_KEYS) {
    const part = raw[key];
    if (part === undefined || part === null) continue;
    if (typeof part !== 'object' || Array.isArray(part)) {
      throw new ConfigError(`${key} 必须是对象`);
    }
    sections[key] = NORMALIZERS[key](part, warnings);
  }
  return [sections, warnings];
}

export function buildDocument(sections, revision, updatedAt) {
  return {
    schemaVersion: SCHEMA_VERSION,
    revision,
    updatedAt: updatedAt || nowIso(),
    sections,
  };
}

export function normalizeDocument(raw) {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ConfigError('配置文档必须是对象');
  }
  if (raw.schemaVersion !== SCHEMA_VERSION) {
    throw new ConfigError(`不支持的 schemaVersion: ${JSON.stringify(raw.schemaVersion)}（当前 ${SCHEMA_VERSION}）`);
  }
  const [sections, warnings] = normalizeSections(raw.sections);
  const revision = raw.revision === undefined ? 0 : raw.revision;
  if (typeof revision !== 'number' || !Number.isInteger(revision) || revision < 0) {
    throw new ConfigError('revision 必须是非负整数');
  }
  return [buildDocument(sections, revision, raw.updatedAt), warnings];
}
