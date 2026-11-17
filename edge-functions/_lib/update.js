import { ConfigError, UPDATE_ABIS } from './contract.js';

/**
 * 应用更新清单：云端代取 GitHub Releases，终端只访问自己的域名。
 *
 * 为什么必须放到云端：终端在国内经常连不上 api.github.com / raw.githubusercontent，
 * 第三方反代的可用性也时好时坏，导致「检查更新」直接失败。而 tv.1008618.xyz 是
 * 终端拉配置的同一个域名，一定可达——由边缘函数出网取 GitHub，终端只认自己的域名。
 *
 * 三级数据源（任一成功即返回，全部失败才报错）：
 *   1. api.github.com（配置 GITHUB_TOKEN 可把限额 60/h 提到 5000/h）
 *   2. 第三方 GitHub 反代前缀 + api.github.com（反代是否支持 API 需逐个试）
 *   3. 仓库里的静态清单 assets/version.json + assets/releases.json（只保底版本号与历史，
 *      没有 asset 的 size/digest，客户端会退化为 releases.json 的文件列表 + 大小校验）
 *
 * 缓存：进程内 5 分钟 + 响应头让 CDN 再缓 5 分钟。两层叠加之后 GitHub 实际被访问的
 * 频率是「每 PoP 每 5 分钟一次」量级，远不到限额；GitHub 全挂时进程内还留着一份
 * 24 小时内的旧结果可以续命（宁可报旧版本，也别让终端看到「检查更新失败」）。
 *
 * 安全：仓库名来自环境变量（UPDATE_GITHUB_REPO，形如 owner/repo），严格校验后拼 URL；
 * 不接受任何来自 query 的值，终端无法用它打任意地址。响应是只读清单，无需鉴权与 CORS。
 */

/** 默认仓库：与客户端 VersionUtil.updateOwner/updateRepository 保持一致。 */
export const DEFAULT_REPO = 'muzhi621/pu_tv_client';

/**
 * 第三方 GitHub 反代前缀（拼接在 github 原始 URL 之前使用）。
 *
 * 与客户端内置列表同源，但这里做成「云端可改」：反代经常挂，改一次 env 就能让所有
 * 终端换源，不用发版。顺序即优先级，越靠前越优先尝试。
 */
export const DEFAULT_PROXY_PREFIXES = [
  'https://cdn.gh-proxy.org/',
  'https://edgeone.gh-proxy.org/',
  'https://hk.gh-proxy.org/',
  'https://gh.noki.eu.org/',
  'https://gh-proxy.com/',
  'https://slink.ltd/',
  'https://ghproxy.link/',
  'https://gh-proxy.net/',
  'https://ghproxy.net/',
  'https://wget.la/',
];

const RAW_ORIGIN = 'https://raw.githubusercontent.com/';
const API_ORIGIN = 'https://api.github.com';
/** 清单里保留多少个历史版本；客户端的历史页只需要十几条。 */
const MAX_RELEASES = 12;
/** 单条更新说明最多保留多少字符：GitHub 的 body 可能上万字，全转给终端是浪费。 */
const MAX_BODY_CHARS = 4000;
/** 进程内缓存有效期。 */
const CACHE_TTL_MS = 5 * 60 * 1000;
/** GitHub 全部失败时，最多容忍多旧的缓存。 */
const STALE_OK_MS = 24 * 60 * 60 * 1000;
/** 单次出网超时。终端等 10s 就放弃，服务端必须更快。 */
const FETCH_TIMEOUT_MS = 8000;
/** 静态清单兜底所用的分支。 */
const MANIFEST_BRANCH = 'main';

const REPO_RE = /^[A-Za-z0-9_.-]{1,50}\/[A-Za-z0-9_.-]{1,80}$/;

/** 进程内缓存：{ key, at, payload }。边缘实例间不共享，靠 CDN 头补齐。 */
let memory = { key: '', at: 0, payload: null };

/** 解析仓库配置；非法配置直接回落到默认仓库，绝不让它拼进 URL。 */
export function repoOf(env = {}) {
  const raw = String(env.UPDATE_GITHUB_REPO || '').trim();
  const value = REPO_RE.test(raw) ? raw : DEFAULT_REPO;
  const [owner, repo] = value.split('/');
  return { owner, repo, slug: `${owner}/${repo}` };
}

/** 反代前缀列表：env 可覆盖（逗号分隔），只接受 https 前缀。 */
export function proxyPrefixes(env = {}) {
  const raw = String(env.UPDATE_PROXY_PREFIXES || '').trim();
  if (!raw) return DEFAULT_PROXY_PREFIXES;
  const list = raw
    .split(',')
    .map((item) => item.trim())
    .filter((item) => /^https:\/\/[^\s]+$/.test(item))
    .map((item) => (item.endsWith('/') ? item : `${item}/`));
  return list.length ? list : DEFAULT_PROXY_PREFIXES;
}

/**
 * `3.0.42` → 130042。
 *
 * 与仓库里手写的 `assets/version.json` 对齐（3.0.41 → 130041，首位 1 是产品位）：
 * 客户端只在清单缺 version_num 时才用它那套不带产品位的 30042 兜底，这里给出与
 * 发行文件一致的值，避免运维在两边看到两个不同的数字。
 */
export function flattenVersion(version) {
  const clean = String(version || '')
    .split(/[-+]/)[0]
    .replace(/^[vV]/, '')
    .trim();
  const parts = clean.split('.');
  const major = Number.parseInt(parts[0], 10);
  if (!Number.isFinite(major)) return 0;
  const minor = Number.parseInt(parts[1], 10);
  const patch = Number.parseInt(parts[2], 10);
  return 100000 + major * 10000 + (Number.isFinite(minor) ? minor : 0) * 100
    + (Number.isFinite(patch) ? patch : 0);
}

/** 从资产名判断 ABI；与客户端 abiForAssetName 的边界规则一致（arm64 ≠ armeabi）。 */
export function abiOf(name) {
  const lower = String(name || '').toLowerCase();
  for (const abi of ['arm64-v8a', 'armeabi-v7a', 'x86_64']) {
    if (new RegExp(`(^|[^a-z0-9])${abi}([^a-z0-9]|$)`).test(lower)) return abi;
  }
  return '';
}

/** 只保留 GFM 说明前 MAX_BODY_CHARS 个字符，避免把整个 release body 搬运过去。 */
function trimBody(body) {
  const text = String(body || '');
  return text.length > MAX_BODY_CHARS ? `${text.slice(0, MAX_BODY_CHARS)}\n…（完整说明见 Release 页）` : text;
}

/** `2026-11-17T12:00:00Z` → `2026-11-17`；历史列表按日期排序，只需要日期。 */
function dateOf(iso) {
  const value = String(iso || '').trim();
  return value.length >= 10 ? value.slice(0, 10) : '';
}

/** 字节数 → `39.4mb`：releases.json 的 size 就是这个格式，客户端会解析成字节做校验。 */
function sizeText(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value <= 0) return '';
  return `${(value / (1024 * 1024)).toFixed(1)}mb`;
}

/**
 * 把一条 GitHub release 转成 releases.json 的条目形状。
 *
 * 同时写 `changelog` 与 `changeLog`：仓库里的 releases.json 用前者，客户端 freezed
 * 模型的 JSON 键是后者，两个都带上才不会因为哪一侧改了命名而丢更新说明。
 */
function historyEntry(release) {
  const tag = String(release.tag_name || release.name || '').trim();
  const version = tag.replace(/^[vV]/, '');
  const body = trimBody(release.body);
  const author = release.author || {};
  return {
    version,
    title: String(release.name || tag).trim(),
    date: dateOf(release.published_at || release.created_at),
    github: String(release.html_url || '').trim(),
    author: {
      name: String(author.login || '').trim(),
      avatar: String(author.avatar_url || '').trim(),
      profile: String(author.html_url || '').trim(),
    },
    changelog: body,
    changeLog: body,
    files: (Array.isArray(release.assets) ? release.assets : [])
      .filter((asset) => String(asset?.name || '').toLowerCase().endsWith('.apk'))
      .map((asset) => ({
        // releases.json 里的 name 不带扩展名，这里保持一致的写法
        name: String(asset.name).replace(/\.apk$/i, ''),
        size: sizeText(asset.size),
        downloads: Number(asset.download_count) || 0,
        url: String(asset.browser_download_url || '').trim(),
      })),
  };
}

/** 只把 APK 资产转给终端：其它（源码包、校验文件）装了也没用。 */
function apkAssets(release) {
  return (Array.isArray(release.assets) ? release.assets : [])
    .filter((asset) => String(asset?.name || '').toLowerCase().endsWith('.apk'))
    .map((asset) => ({
      name: String(asset.name).trim(),
      url: String(asset.browser_download_url || '').trim(),
      size: Number(asset.size) || 0,
      // GitHub 的 digest 形如 sha256:<hex>；旧 release 没有这个字段，给空串让客户端跳过
      digest: String(asset.digest || '').trim(),
    }))
    .filter((asset) => asset.name && asset.url);
}

/**
 * 用 GitHub Releases API 的返回组装更新清单。
 *
 * 选版本的口径与客户端 selectReleaseEntry 一致：跳过 draft，取最新的非 prerelease；
 * 只有全是 prerelease 时才用第一条。
 */
export function buildFromReleases(releases, env = {}, source = 'github') {
  const list = (Array.isArray(releases) ? releases : [])
    .filter((item) => item && item.draft !== true && item.tag_name)
    .slice(0, MAX_RELEASES);
  if (!list.length) throw new Error('GitHub 返回的 release 列表为空');

  const latest = list.find((item) => item.prerelease !== true) || list[0];
  const version = String(latest.tag_name).replace(/^[vV]/, '').trim();
  const assets = apkAssets(latest);
  const abis = [...new Set(assets.map((asset) => abiOf(asset.name)).filter(Boolean))].sort();

  return {
    version,
    version_num: flattenVersion(version),
    version_desc: trimBody(latest.body),
    prerelease: latest.prerelease === true,
    android_abis: abis,
    download_url: String(latest.html_url || '').trim(),
    assets,
    releases: list.map(historyEntry),
    downloadPrefixes: proxyPrefixes(env),
    repo: repoOf(env).slug,
    source,
    fetchedAt: new Date().toISOString(),
  };
}

/**
 * 静态清单兜底：仓库里的 version.json / releases.json。
 *
 * 这条路径拿不到 asset 的精确字节数与 digest（客户端会退化为文件列表 + 容差校验），
 * 但能保证「有版本可报」——比让终端看到「检查更新失败」好得多。
 */
export function buildFromStatic(versionJson, releasesJson, env = {}, source = 'static') {
  const manifest = versionJson && typeof versionJson === 'object' ? versionJson : {};
  const version = String(manifest.version || '').replace(/^[vV]/, '').trim();
  if (!version) throw new Error('静态清单缺少 version 字段');
  const history = Array.isArray(releasesJson) ? releasesJson : (releasesJson?.releases || []);
  return {
    version,
    version_num: Number(manifest.version_num) || flattenVersion(version),
    version_desc: trimBody(manifest.version_desc),
    prerelease: manifest.prerelease === true,
    android_abis: Array.isArray(manifest.android_abis) ? manifest.android_abis.filter((abi) => abiOf(abi) === abi) : [],
    download_url: String(manifest.download_url || '').trim(),
    assets: [],
    releases: history.slice(0, MAX_RELEASES),
    downloadPrefixes: proxyPrefixes(env),
    repo: repoOf(env).slug,
    source,
    fetchedAt: new Date().toISOString(),
  };
}

/** 带超时的 JSON 拉取；非 2xx 直接抛，交给上层换下一个源。 */
async function fetchJson(url, { headers = {}, fetchImpl = globalThis.fetch, timeoutMs = FETCH_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { headers, signal: controller.signal, redirect: 'follow' });
    if (!response.ok) throw new Error(`HTTP ${response.status} @ ${url}`);
    const text = await response.text();
    if (!text || text.length > 4 * 1024 * 1024) throw new Error(`响应体异常 @ ${url}`);
    return JSON.parse(text);
  } finally {
    clearTimeout(timer);
  }
}

/** GitHub API 请求头：有 token 就带上（限额 5000/h），没有也能跑（60/h + CDN 缓存）。 */
function apiHeaders(env) {
  const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'pu-tv-cloud-update',
  };
  const token = String(env.GITHUB_TOKEN || '').trim();
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

/**
 * 依次尝试所有数据源，返回第一份可用清单。
 *
 * 顺序刻意是「官方 API → 各反代 + API → 静态清单」：官方 API 的字段最全
 * （带 size/digest），反代只是绕墙，静态清单是最后保底。
 */
export async function fetchAppUpdate(env = {}, { fetchImpl = globalThis.fetch } = {}) {
  const { owner, repo, slug } = repoOf(env);
  const apiUrl = `${API_ORIGIN}/repos/${slug}/releases?per_page=${MAX_RELEASES}`;
  const prefixes = proxyPrefixes(env);
  const errors = [];

  // 1) 官方 API（有 token 时优先，不然可能吃到共享出口 IP 的限额）
  try {
    const data = await fetchJson(apiUrl, { headers: apiHeaders(env), fetchImpl });
    return buildFromReleases(data, env, 'github');
  } catch (error) {
    errors.push(`github: ${error.message}`);
  }

  // 2) 反代 + 官方 API
  for (const prefix of prefixes) {
    try {
      const data = await fetchJson(`${prefix}${apiUrl}`, { headers: apiHeaders(env), fetchImpl });
      return buildFromReleases(data, env, 'proxy');
    } catch (error) {
      errors.push(`${prefix}: ${error.message}`);
    }
  }

  // 3) 静态清单兜底（version.json + releases.json）
  const rawBase = `${RAW_ORIGIN}${owner}/${repo}/${MANIFEST_BRANCH}/assets`;
  const versionUrl = `${rawBase}/version.json`;
  const releasesUrl = `${rawBase}/releases.json`;
  // 空前缀 = 直连 raw.githubusercontent；其余是「反代前缀 + 原始地址」。
  // 注意 rawTargets 本身已是绝对地址，不能再往它前面拼 RAW_ORIGIN。
  for (const prefix of ['', ...prefixes]) {
    try {
      const versionJson = await fetchJson(`${prefix}${versionUrl}`, { fetchImpl });
      const releasesJson = await fetchJson(`${prefix}${releasesUrl}`, { fetchImpl }).catch(() => []);
      return buildFromStatic(versionJson, releasesJson, env, 'static');
    } catch (error) {
      errors.push(`${prefix || RAW_ORIGIN}${versionUrl}: ${error.message}`);
    }
  }

  throw new Error(`所有数据源均不可用：${errors.slice(0, 4).join(' | ')}`);
}

/**
 * 带缓存的入口：缓存命中直接返回，过期才回源；回源失败时用 24 小时内的旧结果续命。
 *
 * 返回 `{ payload, cached }`：`cached` 供响应头决定 CDN 该缓多久。
 */
export async function loadAppUpdate(env = {}, { fetchImpl = globalThis.fetch, now = Date.now(), force = false } = {}) {
  const key = repoOf(env).slug;
  const fresh = memory.payload && memory.key === key && now - memory.at < CACHE_TTL_MS;
  if (fresh && !force) return { payload: memory.payload, cached: true };

  try {
    const payload = await fetchAppUpdate(env, { fetchImpl });
    memory = { key, at: now, payload };
    return { payload, cached: false };
  } catch (error) {
    // 陈旧但可用：给终端一个「没更新」的正常答案，而不是错误。
    if (memory.payload && memory.key === key && now - memory.at < STALE_OK_MS) {
      return { payload: { ...memory.payload, stale: true, staleReason: error.message }, cached: true };
    }
    throw error;
  }
}

/** 测试用：清掉进程内缓存。 */
export function resetAppUpdateCache() {
  memory = { key: '', at: 0, payload: null };
}

/* ---------------- 上传的清单（编辑器「上传文件」） ---------------- */

/**
 * 清洗一份人工上传的 version.json。
 *
 * 会传清单的人通常是想「不依赖 GitHub 也能发版」：把 APK 放到自己的 CDN，写一份
 * 清单传上来。所以这里只认终端真正会用到的字段，脏数据直接丢（不报错），
 * 但版本号必须合法——清单没有版本号，终端会把「检查更新」判成失败。
 *
 * 抛 ConfigError 让端点回 400 而不是 500。
 */
export function normalizeUploadedManifest(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ConfigError('清单必须是 JSON 对象');
  }
  const version = String(raw.version ?? '').trim().replace(/^[vV]/, '');
  if (!/^\d+(?:\.\d+){1,3}$/.test(version)) {
    throw new ConfigError('清单缺少合法的 version（形如 3.0.42）');
  }
  const expected = flattenVersion(version);
  const given = Number.parseInt(String(raw.version_num ?? ''), 10);
  if (Number.isFinite(given) && given > 0 && given !== expected) {
    throw new ConfigError(`version_num=${given} 与 version=${version} 不一致（应为 ${expected}）`);
  }

  const manifest = {
    version,
    version_num: Number.isFinite(given) && given > 0 ? given : expected,
    version_desc: String(raw.version_desc ?? '').slice(0, 20000),
    prerelease: raw.prerelease === true,
  };

  const abis = Array.isArray(raw.android_abis)
    ? raw.android_abis.map((item) => String(item).trim()).filter((abi) => UPDATE_ABIS.includes(abi))
    : [];
  manifest.android_abis = abis.length ? [...new Set(abis)] : [...UPDATE_ABIS];

  const downloadUrl = String(raw.download_url ?? '').trim();
  manifest.download_url = /^https?:\/\//i.test(downloadUrl) ? downloadUrl.slice(0, 500) : '';

  // assets / releases 是可选附加信息，终端没有它们也能工作（只少一个大小/校验和）。
  const assets = Array.isArray(raw.assets) ? raw.assets : [];
  manifest.assets = assets.map(cleanManifestAsset).filter(Boolean).slice(0, 20);

  const releases = Array.isArray(raw.releases) ? raw.releases : [];
  manifest.releases = releases
    .filter((item) => item && typeof item === 'object' && String(item.version || '').trim())
    .slice(0, 30)
    .map((item) => {
      const changelog = String(item.changelog ?? item.changeLog ?? '').slice(0, 20000);
      return {
        version: String(item.version).trim().slice(0, 32),
        title: String(item.title ?? '').slice(0, 200),
        date: String(item.date ?? '').slice(0, 20),
        github: String(item.github ?? '').slice(0, 500),
        changelog,
        // releases.json 用 changelog、客户端模型读 changeLog，两个都给。
        changeLog: changelog,
        files: Array.isArray(item.files) ? item.files.slice(0, 20).map((file) => ({
          name: String((file && file.name) ?? '').slice(0, 200),
          size: String((file && file.size) ?? '').slice(0, 20),
          downloads: Number.isFinite(Number(file && file.downloads)) ? Number(file.downloads) : 0,
          url: String((file && file.url) ?? '').slice(0, 500),
        })) : [],
      };
    });

  return manifest;
}

/** APK 资产：只留终端能下载的（http 直链 + .apk 结尾），size/digest 非法就当没有。 */
function cleanManifestAsset(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const name = String(entry.name || '').trim();
  const url = String(entry.url || '').trim();
  if (!/\.apk$/i.test(name) || !/^https?:\/\//i.test(url)) return null;
  const size = Number(entry.size);
  const digest = String(entry.digest || '').trim();
  return {
    name: name.slice(0, 200),
    url: url.slice(0, 500),
    size: Number.isFinite(size) && size > 0 ? Math.round(size) : 0,
    digest: /^sha256:[0-9a-f]{64}$/i.test(digest) ? digest.toLowerCase() : '',
  };
}
