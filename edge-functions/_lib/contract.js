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

export const SECTION_KEYS = ['sites', 'navigation', 'startup', 'update', 'iptv', 'vod'];
const MAX_TEXT_LEN = 20000;
const MAX_LIST_ITEMS = 200;
/** 单份配置文档必须能塞进 Edge Functions 的请求体上限，频道列表要设硬上限。 */
export const MAX_IPTV_CHANNELS = 3000;
export const MAX_DOCUMENT_BYTES = 900 * 1024;
/** 套餐库上限：套餐里的频道是「频道库」，只在 GET 时展开到 channels，不重复存两份。 */
export const MAX_IPTV_PACKAGES = 12;
export const MAX_PACKAGE_CHANNELS_TOTAL = 5000;
const PACKAGE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const VERSION_RE = /^\d+(?:\.\d+){0,3}$/;
const URL_RE = /^https?:\/\/[^\s]+$/i;
const IPTV_URL_RE = /^(https?|rtmp|rtsp|udp|mms|p2p):\/\/[^\s]+$/i;

/**
 * 把 TVBox 配置里的 `./xxx` / `/xxx` 相对引用按配置地址解析成绝对 URL。
 *
 * 真实配置（例如饭太硬 m.json）里 `spider`、`ext`、`api` 大量写成
 * `./libs/market.json`，只有按配置所在目录解析才拿得到资源。中文路径交给
 * URL 构造器自动做 percent-encode，避免「IPTV 中文路径 400」同类问题。
 * 已经是 http(s) 的、或 base 不合法的原样返回，不会凭空造地址。
 */
export function resolveVodAsset(ref, baseUrl = '') {
  const value = typeof ref === 'string' ? ref.trim() : '';
  if (!value || /^https?:\/\//i.test(value)) return value;
  // 只有 "./" 或 "/" 开头才是相对资源引用。csp_Xxx、普通 ext 文本、
  // 127.0.0.1 之外的自定义 scheme 一律原样返回，别被 URL 构造器改写成
  // "https://host/box/csp_Xxx"。
  if (!/^\.?\//.test(value)) return value;
  if (!/^https?:\/\//i.test(baseUrl)) return value;
  try {
    // 去掉开头的 "./" 后交给 URL：相对 base 所在目录解析；
    // 以 "/" 开头则相对域名根，语义与浏览器一致。
    return new URL(value.replace(/^\.\//, ''), baseUrl).href;
  } catch (_) {
    return value;
  }
}

/**
 * 拆 TVBox 的 spider 字段。常见形态：
 *   "https://x/fty.jar"
 *   "./fty.jar;md5;3d161697458ecbcd2651a749db761ba1"
 *   "./fty.jar;md5"                     （只声明算法，不带 hash）
 *   "https://x/fty.jar;<hash>"
 * 返回 { jar, md5 }；jar 一定是绝对 http(s) 地址或空串。
 *
 * FongMi 的 `BaseLoader.parseJar(spider, true)` 就是按 `url;md5;hash` 拆的。
 * 编辑器已经拆过一次，云端这里做防御性兼容：老数据或手工填写的
 * 带后缀字符串也不会被 URL_RE 判非法后整个丢掉。
 */
export function parseSpiderField(raw, baseUrl = '') {
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (!text) return { jar: '', md5: '' };
  const parts = text.split(';').map((item) => item.trim()).filter(Boolean);
  const jar = resolveVodAsset(parts[0] || '', baseUrl);
  let md5 = '';
  for (let i = 1; i < parts.length; i += 1) {
    if (/^md5$/i.test(parts[i])) continue;
    if (/^[0-9a-f]{16,64}$/i.test(parts[i])) { md5 = parts[i]; break; }
  }
  return { jar: jar && URL_RE.test(jar) ? jar : '', md5 };
}

/**
 * spider 契约流派。FongMi :catvod 与 TVBoxOS 的 Spider 基类互不兼容
 * （前者 abstract + AutoCloseable + dialog，后者有 initApi/proxyLocal/client），
 * 两套 jar 不能混用宿主。缺省一律按 fongmi —— 现有 catvod-api.jar 就是这个契约。
 */
const VOD_FLAVORS = new Set(['fongmi', 'tvboxos']);
function vodFlavor(value) {
  return typeof value === 'string' && VOD_FLAVORS.has(value) ? value : 'fongmi';
}

/* ---------------- 全局资源库（与设备文档解耦） ----------------
 * 库独立存在 library_current，设备只保存 id 引用：
 *   iptv.packageIds → library.iptv.packages[].id
 *   vod.sourceIds / vod.siteIds → library.vod.sources[].id / sites[].id
 * 这样改库即可对「未锁定」的设备批量生效，设备文档也不会重复存几百 KB 频道。
 */
export const LIBRARY_SCHEMA_VERSION = 1;
export const MAX_LIBRARY_SOURCES = 30;
export const MAX_VOD_SOURCES = 20;
export const MAX_VOD_SITES = 500;
export const MAX_VOD_SITES_PER_SOURCE = 200;
export const MAX_LIBRARY_BYTES = MAX_DOCUMENT_BYTES;
/** 库内 id 由编辑器生成，格式固定，便于设备侧引用时做正则校验。 */
const LIB_SOURCE_ID_RE = /^s_[0-9a-f]{8}$/;
const LIB_PACKAGE_ID_RE = /^pkg_[0-9a-f]{8}$/;
const LIB_VOD_SOURCE_ID_RE = /^vs_[0-9a-f]{8}$/;
/** TVBox 站点 id = `${sourceId}:${key}`，会作为设备 vod.siteIds 的引用值。 */
const VOD_SITE_ID_RE = /^[A-Za-z0-9_:-]{1,96}$/;

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
  const document = clone(SEED);
  ensureSectionDefaults(document.sections);
  return document;
}

/** vod（TVBox 源/站点）节默认值：老文档没有这一节，读出时按此补齐。 */
export const DEFAULT_VOD = {
  managed: false,
  sourceIds: [],
  siteIds: [],
  // 展开后的产物（GET 时由 expandVodSites 写入），也是锁定快照的载体：
  // lockLibrary 为 true 时终端只认这两个字段，不再跟随资源库。
  sources: [],
  sites: [],
  lockLibrary: false,
  libraryRevision: 0,
};

export function ensureVodSection(sections) {
  if (!sections || typeof sections !== 'object') return sections;
  if (!sections.vod || typeof sections.vod !== 'object' || Array.isArray(sections.vod)) {
    sections.vod = clone(DEFAULT_VOD);
  }
  return sections;
}

/**
 * data.js 由脚本从 config/ 生成，暂不包含资源库相关字段；
 * 这里在运行时补齐，保证老文档/新种子读出来结构一致，客户端不必判空。
 */
export function ensureSectionDefaults(sections) {
  ensureVodSection(sections);
  const iptv = sections && sections.iptv;
  if (iptv && typeof iptv === 'object' && !Array.isArray(iptv)) {
    if (!Array.isArray(iptv.packageIds)) iptv.packageIds = [];
    if (!Array.isArray(iptv.selectedPackageIds)) iptv.selectedPackageIds = [];
    if (typeof iptv.lockLibrary !== 'boolean') iptv.lockLibrary = false;
    if (!Number.isInteger(iptv.libraryRevision) || iptv.libraryRevision < 0) iptv.libraryRevision = 0;
  }
  return sections;
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

/** 定长上限的字符串数组（设备侧 siteIds 需要 500 项，超出 strList 的 200 上限）。 */
function stringArray(value, field, limit) {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw new ConfigError(`${field} 必须是字符串数组`);
  if (value.some((item) => typeof item !== 'string')) {
    throw new ConfigError(`${field} 必须是字符串数组`);
  }
  return value.map((item) => item.trim()).filter(Boolean).slice(0, limit);
}

/** 库内 id：前缀 + 8 位十六进制，由服务端在缺省时补发。 */
function randomLibraryId(prefix, taken) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const hex = Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, '0').slice(-8);
    const id = `${prefix}${hex}`;
    if (!taken || !taken.has(id)) return id;
  }
  return `${prefix}${(Date.now() % 0xffffffff).toString(16).padStart(8, '0').slice(-8)}`;
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

/**
 * TVBox 配置里的开关字段五花八门：0/1、true/false、"1"/""。
 * 库是「导入别人的配置」，这里做宽松归一，避免一个布尔值让整库保存失败。
 */
function lenientInt(value, fallback, low, high) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value ? 1 : 0;
  const num = typeof value === 'number' ? value : Number(String(value).trim());
  if (!Number.isFinite(num) || !Number.isInteger(num)) return fallback;
  return Math.min(high, Math.max(low, num));
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

/** 一级导航块：IPTV / 影音（类 TVBox）/ 直播 / 设置；二级项沿用菜单 id。 */
const VALID_GROUP_IDS = new Set(['iptv', 'vod', 'live', 'settings']);
const VALID_CHILD_IDS = new Set([...VALID_MENU_IDS, 'settings']);
const MAX_NAV_GROUPS = 8;

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

  // 一级块 + 二级菜单：选中某个块后右侧展开它的 children。
  // 结构与客户端内置默认分组一致；未下发时客户端使用内置默认，保证旧配置平滑升级。
  const groups = part.groups;
  if (groups !== undefined && groups !== null) {
    if (!Array.isArray(groups)) throw new ConfigError('navigation.groups 必须是数组');
    if (groups.length > MAX_NAV_GROUPS) {
      warnings.push(`navigation.groups: 超过 ${MAX_NAV_GROUPS} 个上限，已截断`);
    }
    const seen = new Set();
    base.groups = [];
    for (const item of groups.slice(0, MAX_NAV_GROUPS)) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
      const id = String(item.id == null ? '' : item.id).trim().toLowerCase();
      if (!VALID_GROUP_IDS.has(id) || seen.has(id)) {
        warnings.push(`navigation.groups: 忽略非法或重复的一级块 ${id}`);
        continue;
      }
      const children = strList(item.children, `navigation.groups[${id}].children`) || [];
      const validChildren = [];
      for (const child of children) {
        if (VALID_CHILD_IDS.has(child)) validChildren.push(child);
        else warnings.push(`navigation.groups[${id}]: 忽略未知二级项 ${child}`);
      }
      seen.add(id);
      base.groups.push({
        id,
        label: str(item.label, id, `navigation.groups[${id}].label`, 32),
        icon: str(item.icon, '', `navigation.groups[${id}].icon`, 64),
        children: [...new Set(validChildren)].slice(0, 30),
      });
    }
    if (!base.groups.length) {
      warnings.push('navigation.groups: 全部非法，已回退内置默认分组');
      base.groups = clone(SEED.sections.navigation.groups);
    }
  }
  if (part.defaultGroupId !== undefined && part.defaultGroupId !== null) {
    const wanted = str(part.defaultGroupId, '', 'navigation.defaultGroupId', 32).toLowerCase();
    if (base.groups.some((group) => group.id === wanted)) base.defaultGroupId = wanted;
    else {
      warnings.push(`navigation.defaultGroupId: ${wanted} 不在分组里，已回退 ${base.defaultGroupId}`);
    }
  }
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

  // 退出 App 时的告别/确认弹窗，与开机公告对称，由云端下发（v3.0.14 起）。
  // enabled=false 表示不接管，终端沿用本地写死的原弹窗，保证升级平滑。
  const exitDialog = part.exitDialog;
  if (exitDialog !== undefined && exitDialog !== null) {
    if (typeof exitDialog !== 'object' || Array.isArray(exitDialog)) {
      throw new ConfigError('startup.exitDialog 必须是对象');
    }
    const target = clone(base.exitDialog);
    target.enabled = bool(exitDialog.enabled, target.enabled, 'startup.exitDialog.enabled');
    target.mode = enumeration(exitDialog.mode, target.mode, VALID_NOTICE_MODES,
      'startup.exitDialog.mode');
    target.dismissible = bool(exitDialog.dismissible, target.dismissible,
      'startup.exitDialog.dismissible');
    target.showDonate = bool(exitDialog.showDonate, target.showDonate,
      'startup.exitDialog.showDonate');
    if ('titleI18n' in exitDialog) {
      target.titleI18n = i18n(exitDialog.titleI18n, 'startup.exitDialog.titleI18n');
    }
    if ('bodyI18n' in exitDialog) {
      target.bodyI18n = i18n(exitDialog.bodyI18n, 'startup.exitDialog.bodyI18n');
    }
    base.exitDialog = target;
  }

  base.showSplashPage = bool(part.showSplashPage, base.showSplashPage, 'startup.showSplashPage');
  if (base.notice.enabled && !base.notice.dismissible) {
    warnings.push('startup.notice: 不可关闭公告有阻断主界面风险，请复核');
  }
  if (base.exitDialog.enabled && !base.exitDialog.dismissible) {
    warnings.push('startup.exitDialog: 不可取消的退出弹窗会让用户无法留在 App，请复核');
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
/** 顶层 channels 与 packages[].channels 共用同一套校验（协议白名单、去重、上限）。 */
function normalizeChannelList(raw, field, warnings) {
  if (!Array.isArray(raw)) throw new ConfigError(`${field} 必须是数组`);
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
  if (truncated) warnings.push(`${field}: 超过 ${MAX_IPTV_CHANNELS} 条上限，已截断`);
  return channels;
}

/**
 * 套餐 = 命名的频道库。编辑器把一次或多次 M3U/TXT 解析结果存进 packages，
 * 每台设备只在 selectedPackageIds 里勾选要下发的套餐；GET /api/config 时由
 * expandIptvChannels 展开成终端认识的 channels 字段，终端无需任何改动。
 */
function normalizeIptv(part, warnings) {
  const base = clone(SEED.sections.iptv);
  if (!Array.isArray(base.selectedPackageIds)) base.selectedPackageIds = [];
  if (!Array.isArray(base.packageIds)) base.packageIds = [];
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

  const rawPackages = part.packages;
  if (rawPackages !== undefined && rawPackages !== null) {
    if (!Array.isArray(rawPackages)) throw new ConfigError('iptv.packages 必须是数组');
    if (rawPackages.length > MAX_IPTV_PACKAGES) {
      warnings.push(`iptv.packages: 超过 ${MAX_IPTV_PACKAGES} 个上限，已截断`);
    }
    const ids = new Set();
    let total = 0;
    base.packages = [];
    for (const item of rawPackages.slice(0, MAX_IPTV_PACKAGES)) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
      const id = String(item.id == null ? '' : item.id).trim();
      if (!PACKAGE_ID_RE.test(id) || ids.has(id)) {
        warnings.push('iptv.packages: 忽略非法或重复的套餐 id');
        continue;
      }
      const room = MAX_PACKAGE_CHANNELS_TOTAL - total;
      if (room <= 0) {
        warnings.push(`iptv.packages: 频道总数达到 ${MAX_PACKAGE_CHANNELS_TOTAL} 上限，已截断`);
        break;
      }
      const channels = normalizeChannelList(item.channels || [],
        `iptv.packages[${id}].channels`, warnings).slice(0, room);
      const pkgSources = strList(item.sources, `iptv.packages[${id}].sources`) || [];
      total += channels.length;
      ids.add(id);
      base.packages.push({
        id,
        name: str(item.name, id, `iptv.packages[${id}].name`, 64),
        sources: pkgSources.filter((url) => URL_RE.test(url)).slice(0, 20),
        channels,
      });
    }
  }

  const rawSelected = part.selectedPackageIds;
  if (rawSelected !== undefined && rawSelected !== null) {
    if (!Array.isArray(rawSelected) || rawSelected.some((id) => typeof id !== 'string')) {
      throw new ConfigError('iptv.selectedPackageIds 必须是字符串数组');
    }
    const valid = new Set(base.packages.map((pkg) => pkg.id));
    const picked = [];
    for (const raw of rawSelected) {
      const id = String(raw).trim();
      if (!valid.has(id)) {
        warnings.push(`iptv.selectedPackageIds: 忽略不存在的套餐 ${id}`);
        continue;
      }
      if (!picked.includes(id)) picked.push(id);
      if (picked.length >= MAX_IPTV_PACKAGES) break;
    }
    base.selectedPackageIds = picked;
  }

  // v1.1：设备只存「全局资源库」里的套餐 id 引用，库改了所有未锁定设备自动跟着变。
  const rawPackageIds = part.packageIds;
  if (rawPackageIds !== undefined && rawPackageIds !== null) {
    if (!Array.isArray(rawPackageIds) || rawPackageIds.some((id) => typeof id !== 'string')) {
      throw new ConfigError('iptv.packageIds 必须是字符串数组');
    }
    const picked = [];
    for (const raw of rawPackageIds) {
      const id = String(raw).trim();
      if (!id) continue;
      if (!PACKAGE_ID_RE.test(id)) {
        warnings.push(`iptv.packageIds: 忽略格式非法的套餐 id ${id}`);
        continue;
      }
      if (picked.includes(id)) continue;
      if (picked.length >= MAX_IPTV_PACKAGES) {
        warnings.push(`iptv.packageIds: 超过 ${MAX_IPTV_PACKAGES} 个上限，已截断`);
        break;
      }
      picked.push(id);
    }
    base.packageIds = picked;
  }
  base.lockLibrary = bool(part.lockLibrary, false, 'iptv.lockLibrary');
  base.libraryRevision = int(part.libraryRevision, 0, 0, 1e9, 'iptv.libraryRevision');

  if (part.channels !== undefined && part.channels !== null) {
    base.channels = normalizeChannelList(part.channels, 'iptv.channels', warnings);
  }
  // 选了套餐就只由套餐派生 channels，避免存储两份重复频道把文档撑爆 900 KB。
  if (base.selectedPackageIds.length) base.channels = [];
  return base;
}

/**
 * 把套餐频道按 id 顺序合并去重，写进 iptv.channels（供终端读取）。
 *
 * 展开优先级（引用库后设备文档只存 id，不存频道）：
 *   1. iptv.lockLibrary === true：完全忽略 library，只用设备内联内容（锁定快照）
 *   2. packageIds 非空且库可用：按顺序取 library.iptv.packages 的频道
 *   3. 否则回退旧的 selectedPackageIds + 内联 packages
 * 最后并入设备内联 channels（第 3 种情况除外，旧行为保持字节级兼容）。
 *
 * library 参数可选：不传时行为与旧版本完全一致。
 */
export function expandIptvChannels(sections, library = null) {
  const iptv = sections && sections.iptv;
  if (!iptv) return sections;
  const locked = iptv.lockLibrary === true;
  const inlinePackages = Array.isArray(iptv.packages) ? iptv.packages : [];
  const libPackages = (library && library.iptv && Array.isArray(library.iptv.packages))
    ? library.iptv.packages : [];
  const refIds = (!locked && Array.isArray(iptv.packageIds)) ? iptv.packageIds : [];
  const useLibrary = refIds.length > 0
    && libPackages.some((pkg) => refIds.includes(pkg.id));
  const ids = useLibrary
    ? refIds
    : (Array.isArray(iptv.selectedPackageIds) ? iptv.selectedPackageIds : []);
  if (!ids.length) return sections;
  const byId = new Map((useLibrary ? libPackages : inlinePackages).map((pkg) => [pkg.id, pkg]));
  const seen = new Set();
  const channels = [];
  for (const id of ids) {
    const pkg = byId.get(id);
    if (!pkg || !Array.isArray(pkg.channels)) continue;
    for (const channel of pkg.channels) {
      const key = String(channel.url || '').toLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      channels.push(channel);
      if (channels.length >= MAX_IPTV_CHANNELS) break;
    }
    if (channels.length >= MAX_IPTV_CHANNELS) break;
  }
  // 引用库时再并入设备自有的内联频道（库频道优先，URL 去重）。
  if (useLibrary && Array.isArray(iptv.channels)) {
    for (const channel of iptv.channels) {
      if (!channel || typeof channel !== 'object') continue;
      const key = String(channel.url || '').toLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      channels.push(channel);
      if (channels.length >= MAX_IPTV_CHANNELS) break;
    }
  }
  const out = clone(sections);
  out.iptv.channels = channels;
  out.iptv.groups = [...new Set(channels.map((c) => c.group).filter(Boolean))]
    .slice(0, MAX_LIST_ITEMS);
  return out;
}

/**
 * GET 视图：终端只拿展开后的 channels，不带套餐库里的全量频道（否则 15 分钟
 * 一次的心跳会重复传几百 KB）。编辑器带 ?withPackages=1 才拿完整套餐库。
 *
 * 设备引用了全局资源库时，轻量视图里的 packages 摘要同时覆盖「引用的库套餐」
 * 与「设备内联套餐」，终端据此展示套餐名而无需额外请求库。
 */
export function viewDocument(document, withPackages = false, library = null) {
  const out = clone(document);
  if (!out.sections) return out;
  ensureSectionDefaults(out.sections);
  // vod 与 iptv 彼此独立：只有 vod 的文档也要能展开 TVBox 站点，
  // 所以先展开 vod，再对 iptv 做原有的早退判断。
  out.sections = expandVodSites(out.sections, library);
  if (!out.sections.iptv) return out;
  out.sections = expandIptvChannels(out.sections, library);

  const iptv = out.sections.iptv;
  const inline = Array.isArray(iptv.packages) ? iptv.packages : [];
  const inlineIds = new Set(inline.map((pkg) => pkg.id));
  const refIds = iptv.lockLibrary === true ? [] : (Array.isArray(iptv.packageIds) ? iptv.packageIds : []);
  const referenced = [];
  const seenRef = new Set();
  for (const id of refIds) {
    if (seenRef.has(id) || inlineIds.has(id)) continue;
    seenRef.add(id);
    const pkg = ((library && library.iptv && library.iptv.packages) || [])
      .find((item) => item.id === id);
    if (pkg) referenced.push(pkg);
  }
  if (withPackages) {
    iptv.packages = [...inline, ...referenced];
    return out;
  }
  const summarize = (pkg) => ({
    id: pkg.id,
    name: pkg.name,
    sources: pkg.sources || [],
    channelCount: Array.isArray(pkg.channels) ? pkg.channels.length : 0,
  });
  iptv.packages = [...inline.map(summarize), ...referenced.map(summarize)];
  return out;
}

/**
 * vod 节（TVBox 源 / 站点）：与 iptv 解耦，设备只保存库里的 id 引用。
 * 源与站点都由「全局资源库」维护，设备侧只表达「我用哪几个源/哪几个站点」。
 */
function normalizeVod(part, warnings) {
  const base = clone(DEFAULT_VOD);
  base.managed = bool(part.managed, false, 'vod.managed');

  const rawSourceIds = stringArray(part.sourceIds, 'vod.sourceIds', MAX_VOD_SOURCES);
  if (rawSourceIds !== undefined) {
    if ((part.sourceIds || []).length > MAX_VOD_SOURCES) {
      warnings.push(`vod.sourceIds: 超过 ${MAX_VOD_SOURCES} 个上限，已截断`);
    }
    const picked = [];
    for (const raw of rawSourceIds) {
      if (!LIB_VOD_SOURCE_ID_RE.test(raw)) {
        warnings.push(`vod.sourceIds: 忽略格式非法的源 id ${raw}`);
        continue;
      }
      if (!picked.includes(raw)) picked.push(raw);
    }
    base.sourceIds = picked.slice(0, MAX_VOD_SOURCES);
  }

  const rawSiteIds = stringArray(part.siteIds, 'vod.siteIds', MAX_VOD_SITES);
  if (rawSiteIds !== undefined) {
    if ((part.siteIds || []).length > MAX_VOD_SITES) {
      warnings.push(`vod.siteIds: 超过 ${MAX_VOD_SITES} 个上限，已截断`);
    }
    const picked = [];
    const seen = new Set();
    for (const raw of rawSiteIds) {
      if (!VOD_SITE_ID_RE.test(raw)) {
        warnings.push(`vod.siteIds: 忽略格式非法的站点 id ${raw}`);
        continue;
      }
      if (seen.has(raw)) continue;
      seen.add(raw);
      picked.push(raw);
      if (picked.length >= MAX_VOD_SITES) break;
    }
    base.siteIds = picked;
  }

  base.lockLibrary = bool(part.lockLibrary, false, 'vod.lockLibrary');
  base.libraryRevision = int(part.libraryRevision, 0, 0, 1e9, 'vod.libraryRevision');

  // 锁定快照 / 手工内联：只做字段级裁剪，不深究语义（它们本来就是从
  // expandVodSites 产物或编辑器写回来的，结构已经受控）。
  base.sources = inlineVodSources(part.sources, warnings);
  base.sites = inlineVodSites(part.sites, warnings);
  return base;
}

/** 设备内联的源：展开产物或人工添加，字段少且固定。 */
function inlineVodSources(raw, warnings) {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    warnings.push('vod.sources: 必须是数组，已忽略');
    return [];
  }
  const out = [];
  for (const entry of raw.slice(0, MAX_VOD_SOURCES)) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const id = str(entry.id, '', 'vod.sources.id', 32);
    const name = str(entry.name, '', 'vod.sources.name', 64);
    // 内联源通常已经由编辑器拆过，但手工填的仍可能是 "url;md5;hash"。
    const parsed = parseSpiderField(entry.jar, '');
    if (!id) continue;
    out.push({
      id,
      name: name || id,
      jar: parsed.jar,
      spiderMd5: str(entry.spiderMd5, parsed.md5, 'vod.sources.spiderMd5', 64),
      spiderFlavor: vodFlavor(entry.spiderFlavor),
    });
  }
  if (raw.length > MAX_VOD_SOURCES) {
    warnings.push(`vod.sources: 超过 ${MAX_VOD_SOURCES} 个上限，已截断`);
  }
  return out;
}

/**
 * 设备内联的站点。与库里的站点同构，但不再做「必须属于某个源」的校验：
 * 锁定快照里源和站点是同一个时刻拍下来的，可能已经和当前库对不上。
 */
function inlineVodSites(raw, warnings) {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    warnings.push('vod.sites: 必须是数组，已忽略');
    return [];
  }
  const out = [];
  const seen = new Set();
  for (const entry of raw.slice(0, MAX_VOD_SITES)) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const id = str(entry.id, '', 'vod.sites.id', 96);
    const api = str(entry.api, '', 'vod.sites.api', 500);
    if (!id || !api || seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      sourceId: str(entry.sourceId, '', 'vod.sites.sourceId', 32),
      name: str(entry.name, '', 'vod.sites.name', 64) || id,
      api,
      ext: str(entry.ext, '', 'vod.sites.ext', 1000),
      type: lenientInt(entry.type, 0, 0, 4),
      searchable: lenientInt(entry.searchable, 0, 0, 2),
      quickSearch: lenientInt(entry.quickSearch, 0, 0, 2),
    });
  }
  if (raw.length > MAX_VOD_SITES) {
    warnings.push(`vod.sites: 超过 ${MAX_VOD_SITES} 个上限，已截断`);
  }
  return out;
}

/**
 * 把设备 vod 节的 id 引用展开成终端可以直接用的源与站点列表。
 *
 * 和 IPTV 是同一套做法：库改了设备不用改，GET 的时候按当前库实时展开。
 *   1. `lockLibrary === true`：只用设备内联的 sources/sites（锁定快照），
 *      资源库再改也不影响这台设备。
 *   2. `sourceIds` 为空：同样只认内联内容，等价于「这台设备没选源」。
 *   3. `sourceIds` 非空：从库里取这些源；站点默认取这些源下的全部，
 *      只有 `siteIds` 里显式列了白名单时才收窄。
 *
 * 输出字段刻意压到终端真正需要的量：站点只带 id/name/api/ext/type 与两个
 * 搜索标记，把 note、addedAt 之类纯管理字段丢掉，心跳体才不至于过大。
 */
export function expandVodSites(sections, library = null) {
  const vod = sections && sections.vod;
  if (!vod) return sections;
  const out = clone(sections);
  const locked = vod.lockLibrary === true;
  const inlineSources = Array.isArray(vod.sources) ? vod.sources : [];
  const inlineSites = Array.isArray(vod.sites) ? vod.sites : [];
  const refSourceIds = (!locked && Array.isArray(vod.sourceIds)) ? vod.sourceIds : [];
  if (!refSourceIds.length) {
    out.vod.sources = inlineSources;
    out.vod.sites = inlineSites;
    return out;
  }

  const libSources = (library && library.vod && Array.isArray(library.vod.sources))
    ? library.vod.sources : [];
  const libSites = (library && library.vod && Array.isArray(library.vod.sites))
    ? library.vod.sites : [];
  const picked = [];
  for (const id of refSourceIds) {
    const source = libSources.find((item) => item.id === id);
    if (source) picked.push(source);
  }
  const sourceIdSet = new Set(picked.map((item) => item.id));
  const allowSiteIds = Array.isArray(vod.siteIds) && vod.siteIds.length
    ? new Set(vod.siteIds)
    : null;
  const sites = [];
  for (const site of libSites) {
    if (!sourceIdSet.has(site.sourceId)) continue;
    if (allowSiteIds && !allowSiteIds.has(site.id)) continue;
    sites.push({
      id: site.id,
      sourceId: site.sourceId,
      name: site.name,
      api: site.api,
      ext: site.ext || '',
      type: site.type,
      searchable: site.searchable,
      quickSearch: site.quickSearch,
    });
    if (sites.length >= MAX_VOD_SITES) break;
  }
  out.vod.sources = picked.map((item) => ({
    id: item.id,
    name: item.name,
    jar: item.jar || '',
    spiderMd5: item.spiderMd5 || '',
    spiderFlavor: vodFlavor(item.spiderFlavor),
  }));
  out.vod.sites = sites;
  return out;
}

const NORMALIZERS = {
  sites: normalizeSites,
  navigation: normalizeNavigation,
  startup: normalizeStartup,
  update: normalizeUpdate,
  iptv: normalizeIptv,
  vod: normalizeVod,
};

export function normalizeSections(raw) {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ConfigError('sections 必须是对象');
  }
  const warnings = [];
  const sections = clone(SEED.sections);
  ensureSectionDefaults(sections);
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

/* ================= 全局资源库 ================= */

/** 空库：GET /api/library 在没有写过库时也返回结构完整的文档（revision 0）。 */
export function emptyLibrary() {
  return {
    schemaVersion: LIBRARY_SCHEMA_VERSION,
    revision: 0,
    updatedAt: '',
    iptv: { sources: [], packages: [], epgUrl: '' },
    vod: { sources: [], sites: [] },
  };
}

function libraryObject(part, field) {
  if (part === undefined || part === null) return {};
  if (typeof part !== 'object' || Array.isArray(part)) {
    throw new ConfigError(`${field} 必须是对象`);
  }
  return part;
}

function libraryItem(item, field, warnings) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) {
    warnings.push(`${field}: 忽略非对象条目`);
    return null;
  }
  return item;
}

/** 库内 id 是引用目标，格式错了会静默失效，因此直接 400 而不是 warning。 */
function libraryId(item, prefix, re, field) {
  const raw = item.id === undefined || item.id === null ? '' : String(item.id).trim();
  if (!raw) return '';
  if (!re.test(raw)) {
    throw new ConfigError(`${field}: 非法 id ${raw}（应为 ${prefix} 加 8 位十六进制）`);
  }
  return raw;
}

function normalizeLibraryIptv(part, warnings) {
  const raw = libraryObject(part, 'library.iptv');
  const out = { sources: [], packages: [], epgUrl: '' };

  const epg = str(raw.epgUrl, '', 'library.iptv.epgUrl', 500);
  out.epgUrl = epg && URL_RE.test(epg) ? epg : '';
  if (epg && !out.epgUrl) warnings.push('library.iptv.epgUrl: 仅支持 http(s)，已忽略');

  if (raw.sources !== undefined && raw.sources !== null) {
    if (!Array.isArray(raw.sources)) throw new ConfigError('library.iptv.sources 必须是数组');
    if (raw.sources.length > MAX_LIBRARY_SOURCES) {
      warnings.push(`library.iptv.sources: 超过 ${MAX_LIBRARY_SOURCES} 个上限，已截断`);
    }
    const taken = new Set();
    for (const entry of raw.sources.slice(0, MAX_LIBRARY_SOURCES)) {
      const item = libraryItem(entry, 'library.iptv.sources', warnings);
      if (!item) continue;
      let id = libraryId(item, 's_', LIB_SOURCE_ID_RE, 'library.iptv.sources');
      if (!id) id = randomLibraryId('s_', taken);
      if (taken.has(id)) {
        warnings.push(`library.iptv.sources: 忽略重复的源 id ${id}`);
        continue;
      }
      const url = str(item.url, '', 'library.iptv.sources.url', 1000);
      if (!url || !URL_RE.test(url)) {
        warnings.push(`library.iptv.sources: 忽略非法订阅地址 ${url || '(空)'}（仅支持 http(s)）`);
        continue;
      }
      taken.add(id);
      out.sources.push({
        id,
        name: str(item.name, '', 'library.iptv.sources.name', 64) || url,
        url,
        type: (str(item.type, 'm3u', 'library.iptv.sources.type', 16) || 'm3u').toLowerCase(),
        channelCount: lenientInt(item.channelCount, 0, 0, MAX_IPTV_CHANNELS),
        addedAt: str(item.addedAt, nowIso(), 'library.iptv.sources.addedAt', 40),
        note: str(item.note, '', 'library.iptv.sources.note', 200),
      });
    }
  }

  if (raw.packages !== undefined && raw.packages !== null) {
    if (!Array.isArray(raw.packages)) throw new ConfigError('library.iptv.packages 必须是数组');
    if (raw.packages.length > MAX_IPTV_PACKAGES) {
      warnings.push(`library.iptv.packages: 超过 ${MAX_IPTV_PACKAGES} 个上限，已截断`);
    }
    const sourceIds = new Set(out.sources.map((item) => item.id));
    const taken = new Set();
    let total = 0;
    for (const entry of raw.packages.slice(0, MAX_IPTV_PACKAGES)) {
      const item = libraryItem(entry, 'library.iptv.packages', warnings);
      if (!item) continue;
      let id = libraryId(item, 'pkg_', LIB_PACKAGE_ID_RE, 'library.iptv.packages');
      if (!id) id = randomLibraryId('pkg_', taken);
      if (taken.has(id)) {
        warnings.push(`library.iptv.packages: 忽略重复的套餐 id ${id}`);
        continue;
      }
      const room = MAX_PACKAGE_CHANNELS_TOTAL - total;
      if (room <= 0) {
        warnings.push(`library.iptv.packages: 频道总数达到 ${MAX_PACKAGE_CHANNELS_TOTAL} 上限，已截断`);
        break;
      }
      const channels = normalizeChannelList(item.channels === undefined || item.channels === null
        ? [] : item.channels, `library.iptv.packages[${id}].channels`, warnings).slice(0, room);
      const refs = stringArray(item.sources, `library.iptv.packages[${id}].sources`,
        MAX_LIBRARY_SOURCES) || [];
      const sources = [];
      for (const ref of refs) {
        // 编辑器历史版本存的是订阅 URL，这里兼容成 sourceId，避免来源信息丢失。
        let sourceId = ref;
        if (!sourceIds.has(sourceId) && URL_RE.test(ref)) {
          const hit = out.sources.find((src) => src.url.toLowerCase() === ref.toLowerCase());
          if (hit) sourceId = hit.id;
        }
        if (!sourceIds.has(sourceId)) {
          warnings.push(`library.iptv.packages[${id}]: 忽略不存在的源 ${ref}`);
          continue;
        }
        if (!sources.includes(sourceId)) sources.push(sourceId);
      }
      total += channels.length;
      taken.add(id);
      out.packages.push({
        id,
        name: str(item.name, '', `library.iptv.packages[${id}].name`, 64) || id,
        sources,
        channels,
      });
    }
  }
  return out;
}

function normalizeLibraryVod(part, warnings) {
  const raw = libraryObject(part, 'library.vod');
  const out = { sources: [], sites: [] };

  if (raw.sources !== undefined && raw.sources !== null) {
    if (!Array.isArray(raw.sources)) throw new ConfigError('library.vod.sources 必须是数组');
    if (raw.sources.length > MAX_VOD_SOURCES) {
      warnings.push(`library.vod.sources: 超过 ${MAX_VOD_SOURCES} 个上限，已截断`);
    }
    const taken = new Set();
    for (const entry of raw.sources.slice(0, MAX_VOD_SOURCES)) {
      const item = libraryItem(entry, 'library.vod.sources', warnings);
      if (!item) continue;
      let id = libraryId(item, 'vs_', LIB_VOD_SOURCE_ID_RE, 'library.vod.sources');
      if (!id) id = randomLibraryId('vs_', taken);
      if (taken.has(id)) {
        warnings.push(`library.vod.sources: 忽略重复的源 id ${id}`);
        continue;
      }
      const url = str(item.url, '', 'library.vod.sources.url', 1000);
      if (!url || !URL_RE.test(url)) {
        warnings.push(`library.vod.sources: 忽略非法接口地址 ${url || '(空)'}（仅支持 http(s)）`);
        continue;
      }
      taken.add(id);
      // jar 是这个源的爬虫包地址（TVBox 配置里的 spider 字段）。
      // 站点 api 以 csp_ 开头时终端必须靠它加载代码，缺失则该源下的
      // csp_ 站点全部不可用，所以这里允许为空但要在编辑器侧提示。
      // 编辑器导入时已拆过 "url;md5;hash"，这里再兼容一次老数据 / 手填值。
      const parsed = parseSpiderField(item.jar, url);
      out.sources.push({
        id,
        name: str(item.name, '', 'library.vod.sources.name', 64) || url,
        url,
        jar: parsed.jar,
        spiderMd5: str(item.spiderMd5, parsed.md5, 'library.vod.sources.spiderMd5', 64),
        spiderFlavor: vodFlavor(item.spiderFlavor),
        siteCount: lenientInt(item.siteCount, 0, 0, MAX_VOD_SITES),
        addedAt: str(item.addedAt, nowIso(), 'library.vod.sources.addedAt', 40),
        note: str(item.note, '', 'library.vod.sources.note', 200),
      });
    }
  }

  if (raw.sites !== undefined && raw.sites !== null) {
    if (!Array.isArray(raw.sites)) throw new ConfigError('library.vod.sites 必须是数组');
    if (raw.sites.length > MAX_VOD_SITES) {
      warnings.push(`library.vod.sites: 超过 ${MAX_VOD_SITES} 个上限，已截断`);
    }
    const sourceIds = new Set(out.sources.map((item) => item.id));
    // 站点里的 ext / api 若写成 "./libs/xxx.json"，按所属源的配置地址解析。
    const sourceUrlById = new Map(out.sources.map((item) => [item.id, item.url]));
    const perSource = new Map();
    const seen = new Set();
    for (const entry of raw.sites.slice(0, MAX_VOD_SITES)) {
      const item = libraryItem(entry, 'library.vod.sites', warnings);
      if (!item) continue;
      const sourceId = str(item.sourceId, '', 'library.vod.sites.sourceId', 32);
      if (!LIB_VOD_SOURCE_ID_RE.test(sourceId) || !sourceIds.has(sourceId)) {
        warnings.push(`library.vod.sites: 忽略未知源 ${sourceId || '(空)'} 下的站点`);
        continue;
      }
      const key = str(item.key, '', 'library.vod.sites.key', 96);
      // 客户端传来的 id 可能是对 key 做过字符替换的版本，合法且属于同一源就沿用。
      const providedId = str(item.id, '', 'library.vod.sites.id', 96);
      const id = (VOD_SITE_ID_RE.test(providedId) && providedId.startsWith(`${sourceId}:`))
        ? providedId
        : `${sourceId}:${key}`;
      if (!key || !VOD_SITE_ID_RE.test(id)) {
        warnings.push(`library.vod.sites: 忽略非法站点 key ${key || '(空)'}`);
        continue;
      }
      if (seen.has(id)) {
        warnings.push(`library.vod.sites: 忽略重复站点 ${id}`);
        continue;
      }
      const used = perSource.get(sourceId) || 0;
      if (used >= MAX_VOD_SITES_PER_SOURCE) {
        warnings.push(`library.vod.sites: 源 ${sourceId} 超过 ${MAX_VOD_SITES_PER_SOURCE} 个站点上限，已截断`);
        continue;
      }
      const sourceUrl = sourceUrlById.get(sourceId) || '';
      const api = resolveVodAsset(str(item.api, '', 'library.vod.sites.api', 500), sourceUrl);
      if (!api) {
        warnings.push(`library.vod.sites[${id}]: 缺少 api，已忽略`);
        continue;
      }
      perSource.set(sourceId, used + 1);
      seen.add(id);
      out.sites.push({
        id,
        sourceId,
        key,
        name: str(item.name, '', `library.vod.sites[${id}].name`, 64) || key,
        api,
        // ext 是站点的扩展参数，spider 初始化时原样透传（token、接口地址等）。
        // 大量站点离了它就取不到数据，所以必须存进库、随配置下发。
        // 绝对地址（含 127.0.0.1 本地代理）原样保留，"./" 开头才解析。
        ext: resolveVodAsset(str(item.ext, '', `library.vod.sites[${id}].ext`, 1000), sourceUrl),
        type: lenientInt(item.type, 0, 0, 4),
        searchable: lenientInt(item.searchable, 0, 0, 2),
        quickSearch: lenientInt(item.quickSearch, 0, 0, 2),
        note: str(item.note, '', `library.vod.sites[${id}].note`, 200),
      });
    }
  }
  return out;
}

/** 校验并规范化整库（PUT /api/library 用）。返回 [library, warnings]。 */
export function normalizeLibrary(raw) {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ConfigError('资源库文档必须是对象');
  }
  const warnings = [];
  return [
    {
      schemaVersion: LIBRARY_SCHEMA_VERSION,
      revision: 0,
      updatedAt: '',
      iptv: normalizeLibraryIptv(raw.iptv, warnings),
      vod: normalizeLibraryVod(raw.vod, warnings),
    },
    warnings,
  ];
}
