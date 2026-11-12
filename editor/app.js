/* 纯粹直播 TV · 云端配置编辑器（零依赖，直接由配置服务同源托管） */
'use strict';

const state = {
  base: '',
  token: '',          // 读令牌：GET /api/* 与 /health
  writeToken: '',     // 写令牌：PUT /api/config、POST rollback；留空时回退读令牌
  deviceId: '',       // 空 = 全局模板；非空 = 某台终端的独立配置
  devices: [],        // 上线终端注册表
  blocked: [],        // 已拉黑（彻底删除）的设备 id
  onlineWindow: 30,   // 云端在线判定窗口（分钟）
  showHiddenDevices: false,
  checkedDevices: new Set(),
  drawerDeviceId: '', // 单终端全设置面板当前设备
  // ---- 资源库（与设备无关，GET/PUT /api/library） ----
  library: null,          // 资源库文档；null = 尚未加载
  libraryState: 'idle',   // idle | loading | ready | unsupported | error
  libraryError: '',
  libraryDirty: false,
  libUrlText: '',         // 导入区：订阅地址（一行一个）
  libPasteText: '',       // 导入区：粘贴/文件内容
  libSummary: '',         // 最近一次解析摘要
  libParsed: [],          // 最近一次解析出的频道（待入库）
  libSourcesUsed: [],     // 本次解析涉及的 URL 源 [{name,url,channelCount}]
  libPreviewId: '',       // 展开预览的套餐 id
  libAppendTo: '',        // 「追加到已有套餐」当前选择
  tvboxUrl: '',           // TVBox 配置地址输入
  tvboxSummary: '',       // TVBox 最近一次导入摘要
  doc: null,
  original: null,
  catalog: null,
  revision: 0,
  activeTab: 'sites',
  extraMode: null,
  extraData: null,
  dirty: false,
  devMode: false,
};

const $ = (id) => document.getElementById(id);
const clone = (value) => JSON.parse(JSON.stringify(value));
const esc = (value) => String(value == null ? '' : value)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

function getPath(obj, path) {
  return path.split('.').reduce((acc, key) => (acc == null ? undefined : acc[key]), obj);
}

function setPath(obj, path, value) {
  const keys = path.split('.');
  let cursor = obj;
  for (let i = 0; i < keys.length - 1; i += 1) {
    if (typeof cursor[keys[i]] !== 'object' || cursor[keys[i]] === null) cursor[keys[i]] = {};
    cursor = cursor[keys[i]];
  }
  cursor[keys[keys.length - 1]] = value;
}

function headers(extra, token) {
  const base = { 'Content-Type': 'application/json' };
  // 服务端读写令牌分离：读接口只认 CONFIG_READ_TOKEN，写接口只认
  // CONFIG_WRITE_TOKEN。这里按请求类型选令牌，避免「能加载但保存 401」。
  const value = token === undefined ? state.token : token;
  if (value) base.Authorization = 'Bearer ' + value;
  return Object.assign(base, extra || {});
}

async function request(path, options) {
  const opts = options || {};
  // 配置类接口按设备隔离：全局模板不带 deviceId，选中终端后所有读写都指向它。
  // /health、/api/config/catalog、/api/devices 不需要带设备范围。
  let url = state.base.replace(/\/$/, '') + path;
  if (state.deviceId && /^\/api\/config(?:\/|\?|$)/.test(path)) {
    url += (url.includes('?') ? '&' : '?') + 'deviceId=' + encodeURIComponent(state.deviceId);
  }
  // 编辑器需要完整套餐库来增删改；终端心跳不带此参数，只拿展开后的轻量文档。
  if (/^\/api\/config(?:\/|\?|$)/.test(path)) {
    url += (url.includes('?') ? '&' : '?') + 'withPackages=1';
  }
  const token = opts.write ? (state.writeToken || state.token) : state.token;
  const response = await fetch(url, {
    method: opts.method || 'GET',
    headers: headers(opts.headers, token),
    body: opts.body,
  });
  const text = await response.text();
  let data = null;
  if (text) {
    try { data = JSON.parse(text); } catch (_) { data = text; }
  }
  if (!response.ok) {
    const error = new Error((data && data.message) || ('HTTP ' + response.status));
    error.status = response.status;
    error.data = data;
    throw error;
  }
  return data;
}

function toast(message) {
  const node = $('toast');
  node.textContent = message;
  node.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { node.hidden = true; }, 2600);
}

function message(text, kind) {
  const node = $('message');
  node.className = 'message ' + (kind || 'info');
  node.innerHTML = esc(text);
  node.hidden = false;
}

function clearMessage() {
  $('message').hidden = true;
  $('message').innerHTML = '';
}

/** 服务端在 503 等场景会给可执行提示（hint），贴出来免得用户只看一句「内部错误」。 */
function hintOf(error) {
  const hint = error && error.data && error.data.hint;
  return hint ? '\n\n' + hint : '';
}

function markDirty() {
  if (!state.doc || !state.original) return;
  state.dirty = JSON.stringify(state.doc.sections) !== JSON.stringify(state.original.sections);
  $('btnSave').disabled = !state.dirty;
}

function statusText(text) { $('statusText').textContent = text; }

/* ---------------- 渲染 ---------------- */

function managedHtml(section, label) {
  const model = state.doc.sections[section];
  return '<div class="managed">' +
    '<input class="switch" type="checkbox" data-path="' + section + '.managed"' +
    (model.managed ? ' checked' : '') + '>' +
    '<label>由云端接管' + esc(label) + '</label>' +
    '<span>关闭时终端完全使用本地设置，本节改动不会下发</span></div>';
}

function checkline(path, text, note) {
  const value = !!getPath(state.doc.sections, path);
  return '<div class="checkline"><input class="switch" type="checkbox" data-path="' + path + '"' +
    (value ? ' checked' : '') + '><span>' + esc(text) + '</span>' +
    (note ? '<small>' + esc(note) + '</small>' : '') + '</div>';
}

function textField(path, label, type, note) {
  const value = getPath(state.doc.sections, path);
  return '<div class="field"><span>' + esc(label) + '</span>' +
    '<input type="' + (type || 'text') + '" data-path="' + path + '" value="' + esc(value) + '">' +
    (note ? '<small class="muted">' + esc(note) + '</small>' : '') + '</div>';
}

function textArea(path, label, note) {
  const value = getPath(state.doc.sections, path) || '';
  return '<div class="field"><span>' + esc(label) + '</span>' +
    '<textarea data-path="' + path + '">' + esc(value) + '</textarea>' +
    (note ? '<small class="muted">' + esc(note) + '</small>' : '') + '</div>';
}

function selectField(path, label, options) {
  const current = getPath(state.doc.sections, path);
  return '<div class="field"><span>' + esc(label) + '</span><select data-path="' + path + '">' +
    options.map((item) => {
      const value = typeof item === 'string' ? item : item.value;
      const name = typeof item === 'string' ? item : item.label;
      return '<option value="' + esc(value) + '"' + (value === current ? ' selected' : '') + '>' + esc(name) + '</option>';
    }).join('') + '</select></div>';
}

function renderSites() {
  const model = state.doc.sections.sites;
  const selected = new Set(model.enabledSiteIds || []);
  const sites = state.catalog.sites || [];
  const cards = sites.map((site) => {
    const retired = !!site.retired;
    return '<label class="site' + (retired ? ' retired' : '') + '">' +
      '<input class="switch" type="checkbox" data-site="' + esc(site.id) + '"' +
      (selected.has(site.id) ? ' checked' : '') + (retired ? ' disabled' : '') + '>' +
      '<span class="name">' + esc(site.name) + '</span>' +
      (retired ? '<span class="tag">退役</span>' : '') +
      '<code>' + esc(site.id) + '</code></label>';
  }).join('');
  return '<h2>直播平台显示</h2>' +
    '<p class="hint">取消勾选「斗鱼」，终端冷启动后斗鱼的菜单与页签即不显示。至少保留 1 个平台；退役站点由终端自动剔除。</p>' +
    managedHtml('sites', '平台白名单') +
    '<div class="toolbar">' +
      '<button class="tiny" data-action="sites-all">全选</button>' +
      '<button class="tiny" data-action="sites-none">全不选</button>' +
      '<button class="tiny" data-action="sites-seed">恢复内置全量</button>' +
      '<button class="tiny" data-action="sites-off-douyu">示例：关闭斗鱼</button>' +
    '</div><div class="grid">' + cards + '</div>';
}

function renderNavigation() {
  const model = state.doc.sections.navigation;
  const order = model.railMenuIds || [];
  const catalog = state.catalog.menus || [];
  const byId = new Map(catalog.map((item) => [item.id, item]));
  const chosen = order.filter((id) => byId.has(id));
  const rest = catalog.map((item) => item.id).filter((id) => !chosen.includes(id));

  const chosenRows = chosen.map((id, index) => {
    const item = byId.get(id);
    return '<div class="menu-item"><span class="idx">' + (index + 1) + '</span>' +
      '<input class="switch" type="checkbox" data-menu="' + esc(id) + '" checked>' +
      '<span class="name">' + esc(item.name) + '</span><code>' + esc(id) + '</code>' +
      '<button class="tiny" data-action="menu-up" data-id="' + esc(id) + '"' + (index === 0 ? ' disabled' : '') + '>上移</button>' +
      '<button class="tiny" data-action="menu-down" data-id="' + esc(id) + '"' + (index === chosen.length - 1 ? ' disabled' : '') + '>下移</button></div>';
  }).join('');
  const restRows = rest.map((id) => {
    const item = byId.get(id);
    return '<div class="menu-item"><span class="idx">–</span>' +
      '<input class="switch" type="checkbox" data-menu="' + esc(id) + '">' +
      '<span class="name">' + esc(item.name) + '</span><code>' + esc(id) + '</code>' +
      '<small class="muted">未显示</small></div>';
  }).join('');

  const settings = model.settings || { managed: false, enabledEntryPaths: [] };
  return '<h2>首页导航栏</h2>' +
    '<p class="hint">白名单 + 顺序一起下发。终端会在启动迁移之后、runApp 之前应用，因此首帧不会出现被隐藏的菜单。</p>' +
    managedHtml('navigation', '导航白名单') +
    '<div class="menu-list">' + chosenRows + restRows + '</div>' +
    '<div class="row" style="margin-top:18px">' +
      checkline('navigation.sidebarExpanded', '侧栏默认展开') +
      checkline('navigation.homeKeepAlive', '首页页面缓存') +
    '</div>' +
    '<h2 style="margin-top:24px">设置菜单目录（P1 预留）</h2>' +
    '<p class="hint">P0 终端尚未接线，此处填写不会生效；P1 上线后可按 AppRoutes 路径隐藏已有设置条目，不允许新增。</p>' +
    '<div class="checkline"><input class="switch" type="checkbox" data-path="navigation.settings.managed"' +
      (settings.managed ? ' checked' : '') + '><span>由云端接管设置菜单</span></div>' +
    '<div class="field"><span>允许显示的路由路径（每行一个）</span>' +
      '<textarea data-special="settings-paths">' + esc((settings.enabledEntryPaths || []).join('\n')) + '</textarea></div>';
}

function renderStartup() {
  return '<h2>开机弹窗与协议</h2>' +
    '<p class="hint">协议用 requiredVersion 控制重新同意；公告默认可关闭，任何解析失败都不会阻断主界面。</p>' +
    managedHtml('startup', '启动行为') +
    '<h3>用户协议</h3>' +
    checkline('startup.agreement.enabled', '显示协议页') +
    textField('startup.agreement.requiredVersion', '要求同意的版本号', 'number',
      '已同意版本低于此值时重新弹协议；不要通过翻 isFirstInApp 实现') +
    '<div class="row">' +
      textField('startup.agreement.titleI18n.zh', '协议标题（中文）') +
      textField('startup.agreement.titleI18n.en', '协议标题（英文）') +
    '</div>' +
    textArea('startup.agreement.bodyI18n.zh', '协议正文（中文）') +
    textArea('startup.agreement.bodyI18n.en', '协议正文（英文）') +
    '<h3 style="margin-top:24px">公告</h3>' +
    checkline('startup.notice.enabled', '启用公告') +
    checkline('startup.notice.dismissible', '允许关闭', '强烈建议保持开启') +
    selectField('startup.notice.mode', '显示频率', [
      { value: 'once_per_revision', label: '每个 revision 一次' },
      { value: 'always', label: '每次启动' },
      { value: 'never', label: '不显示' },
    ]) +
    '<div class="row">' +
      textField('startup.notice.titleI18n.zh', '公告标题（中文）') +
      textField('startup.notice.titleI18n.en', '公告标题（英文）') +
    '</div>' +
    textArea('startup.notice.bodyI18n.zh', '公告正文（中文）') +
    textArea('startup.notice.bodyI18n.en', '公告正文（英文）') +
    '<h3 style="margin-top:24px">其他</h3>' +
    checkline('startup.showSplashPage', '显示启动页');
}

function renderUpdate() {
  const mirrors = (getPath(state.doc.sections, 'update.mirrorUrls') || []).join('\n');
  return '<h2>在线更新策略</h2>' +
    '<p class="hint">云端接管时，终端以云端为版本真值；本地 assets/version.json 降级为离线兜底。</p>' +
    managedHtml('update', '更新策略') +
    checkline('update.autoCheck', '自动检查更新') +
    '<div class="row">' +
      textField('update.checkIntervalHours', '检查间隔（小时，0 = 每次启动）', 'number') +
      selectField('update.prompt', '提示策略', [
        { value: 'silent', label: '静默（不弹窗）' },
        { value: 'dialog', label: '弹窗提示' },
        { value: 'force', label: '强制更新（谨慎）' },
      ]) +
    '</div>' +
    '<div class="row">' +
      textField('update.minSupportedVersion', '最低支持版本', 'text', '例如 3.0.7，留空表示不限制') +
      textField('update.changelogI18n.zh', '更新日志（中文）') +
    '</div>' +
    checkline('update.allowPrerelease', '允许预发布版本') +
    checkline('update.allowUserOverride', '允许终端本地覆盖', '关闭后设置页对应开关置灰') +
    '<div class="field"><span>version.json 完整 URL 列表（每行一个 http/https 地址，留空 = 使用内置 GitHub 镜像）</span>' +
      '<textarea data-special="mirror-urls">' + esc(mirrors) + '</textarea></div>';
}


/* ---------------- 终端与 IPTV ---------------- */

const IPTV_PROTOCOL_RE = /^(https?|rtmp|rtsp|udp|mms|p2p):\/\/[^\s]+$/i;
const MAX_IPTV_CHANNELS = 3000;

function deviceLabel() {
  if (!state.deviceId) return '全局模板';
  const item = state.devices.find((d) => d.id === state.deviceId);
  return item && item.alias ? item.alias + '（' + state.deviceId + '）' : state.deviceId;
}

function renderDeviceSelect() {
  const select = $('deviceSelect');
  if (!select) return;
  const rows = ['<option value="">全局模板（新设备初始值）</option>'];
  for (const d of state.devices) {
    const label = d.alias ? esc(d.alias) + ' · ' + esc(d.id) : esc(d.id);
    rows.push('<option value="' + esc(d.id) + '"' +
      (d.id === state.deviceId ? ' selected' : '') + '>' + label + '</option>');
  }
  if (state.deviceId && !state.devices.some((d) => d.id === state.deviceId)) {
    rows.push('<option value="' + esc(state.deviceId) + '" selected>' + esc(state.deviceId) + '</option>');
  }
  select.innerHTML = rows.join('');
}

/**
 * 前端解析 M3U / M3U Plus / TXT genre，产出云端 iptv 节的精简频道列表。
 * 云端只存解析结果并做二次校验，不代理任何播放流量。
 */
function parsePlaylist(text) {
  const channels = [];
  const seen = new Set();
  const groups = [];
  let pending = null;
  let group = '';
  let truncated = false;
  const push = (name, url, grp, logo) => {
    const n = String(name || '').trim().slice(0, 120);
    const u = String(url || '').trim().slice(0, 1000);
    if (!n || !IPTV_PROTOCOL_RE.test(u)) return;
    const key = u.toLowerCase();
    if (seen.has(key) || truncated) return;
    seen.add(key);
    const g = String(grp || '').trim().slice(0, 64);
    if (g && !groups.includes(g)) groups.push(g);
    channels.push({ name: n, url: u, group: g, logo: String(logo || '').trim().slice(0, 300) });
    if (channels.length >= MAX_IPTV_CHANNELS) truncated = true;
  };
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (/^#EXTINF/i.test(line)) {
      const gm = /group-title="([^"]*)"/i.exec(line);
      const lm = /tvg-logo="([^"]*)"/i.exec(line);
      const comma = line.lastIndexOf(',');
      pending = {
        name: comma >= 0 ? line.slice(comma + 1).trim() : '',
        group: gm ? gm[1].trim() : group,
        logo: lm ? lm[1].trim() : '',
      };
      continue;
    }
    if (/^#EXTGRP/i.test(line)) { group = line.replace(/^#EXTGRP:?/i, '').trim(); continue; }
    if (line.startsWith('#')) continue;
    if (line.includes(',#genre#')) {
      group = line.split(',')[0].trim();
      if (group && !groups.includes(group)) groups.push(group);
      continue;
    }
    if (IPTV_PROTOCOL_RE.test(line)) {
      push(pending ? pending.name : '', line, pending ? pending.group : group,
        pending ? pending.logo : '');
      pending = null;
      continue;
    }
    // TXT: 名称,url1#url2（多线路）
    if (line.includes(',')) {
      const parts = line.split(',');
      const name = parts.shift();
      for (const u of parts.join(',').split('#')) push(name, u, group, '');
    }
  }
  return { channels, groups, truncated };
}

function iptvSection() {
  const sections = state.doc.sections;
  if (!sections.iptv) {
    sections.iptv = {
      managed: false, sources: [], groups: [], channels: [], epgUrl: '',
      packages: [], selectedPackageIds: [], packageIds: [], lockLibrary: false,
    };
  }
  const iptv = sections.iptv;
  if (!Array.isArray(iptv.packages)) iptv.packages = [];
  if (!Array.isArray(iptv.selectedPackageIds)) iptv.selectedPackageIds = [];
  // packageIds 指向资源库套餐；老文档只有 selectedPackageIds + 内联 packages。
  if (!Array.isArray(iptv.packageIds)) iptv.packageIds = [];
  if (!Array.isArray(iptv.channels)) iptv.channels = [];
  if (!Array.isArray(iptv.groups)) iptv.groups = [];
  if (!Array.isArray(iptv.sources)) iptv.sources = [];
  return iptv;
}

function mergeChannels(existing, incoming) {
  const seen = new Set((existing || []).map((c) => String(c.url || '').toLowerCase()));
  const out = (existing || []).slice();
  for (const channel of incoming || []) {
    const key = String(channel.url || '').toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(channel);
    if (out.length >= 3000) break;
  }
  return out;
}

/* ---------------- 资源库公共（与设备无关） ---------------- */

const LIBRARY_UNSUPPORTED_HINT = '当前服务端不支持资源库（GET /api/library 未实现），请先升级云端。'
  + '其它页签不受影响，升级后点「重新加载资源库」即可。';

function arr(value) { return Array.isArray(value) ? value : []; }
function isObj(value) { return !!value && typeof value === 'object' && !Array.isArray(value); }
function nowIso() { return new Date().toISOString(); }

/** 服务端要求库 id 形如 pkg_1a2b3c4d / s_… / vs_…（8 位十六进制）。 */
function hexId(prefix) {
  const bytes = new Uint8Array(4);
  if (window.crypto && typeof window.crypto.getRandomValues === 'function') {
    window.crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 4; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  }
  return prefix + Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function newLibraryId(kind) {
  const prefix = kind === 'src' ? 's_' : (kind === 'vod' ? 'vs_' : 'pkg_');
  const lib = state.library;
  const taken = new Set();
  if (lib) {
    if (kind === 'pkg') for (const pkg of arr(lib.iptv.packages)) taken.add(pkg.id);
    if (kind === 'src') for (const src of arr(lib.iptv.sources)) taken.add(src.id);
    if (kind === 'vod') for (const src of arr(lib.vod.sources)) taken.add(src.id);
  }
  let id = hexId(prefix);
  // 8 位十六进制空间够大，正常一两次就够；加个上限防止 RNG 异常时死循环。
  for (let i = 0; i < 20 && taken.has(id); i += 1) id = hexId(prefix);
  return id;
}

/** 连接参数以输入框为准：单独刷新资源库时也要先同步，否则会用到旧令牌。 */
function syncConnection() {
  state.base = $('apiBase').value.trim();
  state.token = $('apiToken').value.trim();
  state.writeToken = $('apiWriteToken').value.trim();
}

/** 兼容老服务端/半成品数据：缺失的数组一律补空，避免渲染时到处判空。 */
function ensureLibrary(raw) {
  const doc = isObj(raw) ? raw : {};
  doc.schemaVersion = Number(doc.schemaVersion) || 1;
  doc.revision = Number(doc.revision) || 0;
  doc.updatedAt = typeof doc.updatedAt === 'string' ? doc.updatedAt : '';
  if (!isObj(doc.iptv)) doc.iptv = { sources: [], packages: [], epgUrl: '' };
  if (!isObj(doc.vod)) doc.vod = { sources: [], sites: [] };
  if (typeof doc.iptv.epgUrl !== 'string') doc.iptv.epgUrl = '';
  if (!Array.isArray(doc.iptv.sources)) doc.iptv.sources = [];
  if (!Array.isArray(doc.iptv.packages)) doc.iptv.packages = [];
  if (!Array.isArray(doc.vod.sources)) doc.vod.sources = [];
  if (!Array.isArray(doc.vod.sites)) doc.vod.sites = [];
  for (const pkg of doc.iptv.packages) {
    if (!isObj(pkg)) continue;
    if (!Array.isArray(pkg.channels)) pkg.channels = [];
    if (!Array.isArray(pkg.sources)) pkg.sources = [];
  }
  return doc;
}

/** 可用时返回套餐数组；返回 null 表示服务端不支持资源库（区分「空库」与「不支持」）。 */
function libraryPackages() {
  if (state.libraryState !== 'ready' || !state.library || !isObj(state.library.iptv)) return null;
  return arr(state.library.iptv.packages);
}
function libraryVodSources() {
  if (state.libraryState !== 'ready' || !state.library || !isObj(state.library.vod)) return null;
  return arr(state.library.vod.sources);
}
function libraryVodSites() {
  if (state.libraryState !== 'ready' || !state.library || !isObj(state.library.vod)) return null;
  return arr(state.library.vod.sites);
}

function formatWhen(value) {
  if (!value) return '—';
  const ts = Date.parse(value);
  if (!Number.isFinite(ts)) return String(value);
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
    + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}

/** 文本输入只改模型、不重绘面板（重绘会打断输入焦点），只点亮「未保存」角标。 */
function markLibraryDirty() {
  if (!state.library) return;
  state.libraryDirty = true;
  const badge = $('libDirtyBadge');
  if (badge) badge.hidden = false;
}

function libraryUnsupportedHtml() {
  return '<div class="lib-notice">' + esc(LIBRARY_UNSUPPORTED_HINT) + '</div>'
    + '<div class="toolbar"><button class="ghost" data-lib="reload-library">重新加载资源库</button></div>';
}

function libraryLoadFailedHtml() {
  if (state.libraryState !== 'error' || !state.libraryError) return '';
  return '<div class="lib-notice">加载资源库失败：' + esc(state.libraryError) + '</div>';
}

/** 套餐 sources 存的是源 id（服务端统一）；兼容旧数据里的 URL。 */
function findLibrarySource(ref) {
  const value = String(ref == null ? '' : ref);
  if (!value) return null;
  return arr(state.library && state.library.iptv && state.library.iptv.sources)
    .find((item) => item.id === value || String(item.url || '') === value) || null;
}

function sourceLabel(ref) {
  const value = String(ref == null ? '' : ref);
  if (!value) return '';
  const src = findLibrarySource(ref);
  if (src) return src.name || src.url || '';
  // 源被删掉后残留的 id：显式标注，不要露出一串 s_xxxxxxxx。
  return /^s_[0-9a-f]{8}$/i.test(value) ? '未知来源(' + value + ')' : value;
}

function sourceUrlOf(ref) {
  const src = findLibrarySource(ref);
  return src ? (src.url || '') : String(ref == null ? '' : ref);
}

function channelPreviewHtml(channels, limit) {
  const size = limit || 20;
  const list = arr(channels);
  if (!list.length) return '<p class="muted">这个套餐还没有频道。</p>';
  return '<div class="preview-list">' + list.slice(0, size).map((c) =>
    '<div>' + esc(c.group || '未分组') + ' · <strong>' + esc(c.name) + '</strong>'
    + ' <code>' + esc(c.url) + '</code></div>').join('') + '</div>'
    + (list.length > size ? '<p class="meta">仅显示前 ' + size + ' 条，共 ' + list.length + ' 条。</p>' : '');
}

/**
 * 本地（旧）套餐 = 既不在资源库里、也不在 packageIds 引用里的内联套餐。
 * GET ?withPackages=1 会把「被引用的库套餐」也塞进 iptv.packages，不能用它判断。
 */
function legacyInlinePackages(iptv) {
  const libIds = new Set(arr(libraryPackages()).map((pkg) => pkg.id));
  const refIds = new Set(arr(iptv.packageIds));
  return arr(iptv.packages).filter((pkg) => pkg && !libIds.has(pkg.id) && !refIds.has(pkg.id));
}

function packageChannelCount(pkg) {
  const list = arr(pkg && pkg.channels).length;
  if (list) return list;
  return Number(pkg && pkg.channelCount) || 0;
}

/** 旧模型残留：设备里内联的 packages / selectedPackageIds，展示 + 一键迁移。 */
function legacyIptvHtml(iptv) {
  const inline = legacyInlinePackages(iptv);
  if (!inline.length) return '';
  const selected = new Set(arr(iptv.selectedPackageIds));
  return '<h3>本地（旧）套餐</h3>'
    + '<p class="hint">这些套餐还保存在本配置的 <code>iptv.packages</code> 里（旧模型）。'
    + '可以继续用；迁移到资源库后即可按套餐统一维护、多终端复用。</p>'
    + '<div class="lib-list">' + inline.map((pkg) =>
      '<div class="lib-row"><strong>' + esc(pkg.name || pkg.id) + '</strong>'
      + '<span class="meta">' + packageChannelCount(pkg) + ' 个频道</span>'
      + (selected.has(pkg.id) ? '<span class="badge">当前勾选</span>' : '')
      + '</div>').join('') + '</div>'
    + '<div class="toolbar"><button class="ghost" data-lib="migrate-inline">迁移到资源库</button></div>';
}

/** 「IPTV 下发」页签：只给当前选中的终端勾选资源库套餐 + 锁定开关。 */
function renderIptvDispatch() {
  if (!state.doc) return '<p class="muted">请先点击右上角「连接并加载」。</p>';
  const head = '<h2>IPTV 套餐下发</h2>';
  if (!state.deviceId) {
    return head
      + '<p class="hint">请先在终端管理里选择一台终端（或在顶部「配置对象」里选中它），再勾选套餐。</p>'
      + '<div class="lib-notice">未选择终端：这里只负责勾选，不会改动资源库本身。</div>'
      + '<div class="toolbar"><button class="ghost" data-action="goto-devices">去终端管理</button></div>';
  }
  const iptv = iptvSection();
  const pkgs = libraryPackages();
  const picked = new Set(arr(iptv.packageIds));
  const picker = pkgs === null
    ? libraryUnsupportedHtml()
    : (pkgs.length
      ? '<div class="df-multi">' + pkgs.map((pkg) => {
        const count = arr(pkg.channels).length;
        return '<label><input type="checkbox" data-pkg="' + esc(pkg.id) + '"'
          + (picked.has(pkg.id) ? ' checked' : '') + '> ' + esc(pkg.name)
          + '（' + count + ' 个频道）</label>';
      }).join('') + '</div>'
      : '<p class="meta">资源库里还没有套餐，请先到「IPTV 源」页导入源并创建套餐。</p>');

  return head
    + '<p class="hint">当前对象：<strong>' + esc(deviceLabel()) + '</strong>。'
    + '这里只勾选这台终端要下发的资源库套餐，套餐内容统一在「IPTV 源」页维护。</p>'
    + managedHtml('iptv', ' IPTV 频道')
    + '<h3>资源库套餐</h3>' + picker
    + (pkgs === null ? '' :
      '<div class="checkline"><input class="switch" type="checkbox" data-path="iptv.lockLibrary"'
      + (iptv.lockLibrary ? ' checked' : '') + '><span>锁定资源库</span>'
      + '<small>锁定后该终端不再跟随资源库变化，保持当前频道表</small></div>')
    + legacyIptvHtml(iptv)
    + '<p class="hint">勾选变化会记下当时的资源库 revision；保存仍走顶部「保存到云端」，只影响这台终端。</p>';
}

/* ---------------- IPTV 源页（库层） ---------------- */

const LIBRARY_HEAD = '<h2>IPTV 源 · 频道套餐库</h2>'
  + '<p class="hint">资源库与终端无关：先导入 M3U / TXT 源、组成套餐，'
  + '再到「IPTV 下发」或「终端管理」里给终端勾选套餐。终端没连也能编辑资源库。</p>';

function libraryToolbar(doc) {
  return '<div class="toolbar">'
    + '<button class="primary" data-lib="save-library">保存资源库</button>'
    + '<button class="ghost" data-lib="reload-library">重新加载</button>'
    + '<span class="badge">资源库 revision ' + esc(doc.revision) + '</span>'
    + (doc.updatedAt ? '<span class="meta">更新于 ' + esc(formatWhen(doc.updatedAt)) + '</span>' : '')
    + '<span class="badge warn" id="libDirtyBadge"' + (state.libraryDirty ? '' : ' hidden')
    + '>有未保存改动</span>'
    + '</div>';
}

function renderIptvLibrary() {
  if (state.libraryState === 'unsupported') return LIBRARY_HEAD + libraryUnsupportedHtml();
  if (!state.library) {
    return LIBRARY_HEAD + libraryLoadFailedHtml()
      + '<p class="muted">资源库尚未加载。请先点击右上角「连接并加载」，或单独加载资源库。</p>'
      + '<div class="toolbar"><button class="ghost" data-lib="reload-library">加载资源库</button></div>';
  }
  const doc = state.library;
  const iptv = doc.iptv;
  const sources = arr(iptv.sources);
  const packages = arr(iptv.packages);

  const sourceRows = sources.map((src) =>
    '<tr>'
    + '<td><input class="lib-input" data-lib-input="source-name" data-id="' + esc(src.id)
    + '" value="' + esc(src.name || '') + '"></td>'
    + '<td><code title="' + esc(src.url || '') + '">' + esc(src.url || '—') + '</code></td>'
    + '<td>' + esc(src.channelCount || 0) + '</td>'
    + '<td><span class="meta">' + esc(formatWhen(src.addedAt)) + '</span></td>'
    + '<td><input class="lib-input" data-lib-input="source-note" data-id="' + esc(src.id)
    + '" value="' + esc(src.note || '') + '" placeholder="备注"></td>'
    + '<td><button class="tiny danger" data-lib="delete-source" data-id="' + esc(src.id)
    + '">删除</button></td></tr>').join('');

  const parsedBlock = state.libSummary
    ? '<p class="hint">' + esc(state.libSummary) + '</p>'
      + (state.libParsed.length ? channelPreviewHtml(state.libParsed, 20) : '')
    : '';

  const pkgRows = packages.map((pkg) => {
    const count = arr(pkg.channels).length;
    const open = state.libPreviewId === pkg.id;
    const srcs = arr(pkg.sources).map(sourceLabel).filter(Boolean);
    return '<div class="lib-row">'
      + '<input class="lib-input lib-name" data-lib-input="pkg-name" data-id="' + esc(pkg.id)
      + '" value="' + esc(pkg.name || '') + '">'
      + '<span class="meta">' + count + ' 个频道</span>'
      + '<span class="meta lib-src" title="' + esc(arr(pkg.sources).map(sourceUrlOf).join('、')) + '">'
      + esc(srcs.length ? srcs.join('、') : '本地/粘贴导入') + '</span>'
      + '<span class="lib-row-ops">'
      + '<button class="tiny" data-lib="preview-package" data-id="' + esc(pkg.id) + '">'
      + (open ? '收起' : '预览') + '</button>'
      + '<button class="tiny danger" data-lib="delete-package" data-id="' + esc(pkg.id)
      + '">删除</button></span></div>'
      + (open ? channelPreviewHtml(pkg.channels, 20) : '');
  }).join('');

  return LIBRARY_HEAD
    + libraryToolbar(doc)

    + '<h3>订阅源（' + sources.length + '）</h3>'
    + '<p class="hint">每导入一个 URL 就会登记一条源（最多 30 条），频道数是最近一次解析的数量，'
    + '可在备注里写来源说明。</p>'
    + (sources.length
      ? '<table class="device-table lib-table"><thead><tr><th>名称</th><th>URL</th><th>频道数</th>'
        + '<th>添加时间</th><th>备注</th><th></th></tr></thead><tbody>' + sourceRows + '</tbody></table>'
      : '<p class="muted">还没有源，先在下面导入。</p>')

    + '<h3>导入源</h3>'
    + '<div class="iptv-tools">'
    + '<div class="grow"><span>订阅地址（一行一个，云端代抓不受 CORS 限制）</span>'
    + '<textarea data-lib-input="import-urls" placeholder="https://example.com/list.m3u">'
    + esc(state.libUrlText) + '</textarea></div>'
    + '<div class="grow"><span>或粘贴 M3U / M3U8 / TXT 内容</span>'
    + '<textarea data-lib-input="import-text" placeholder="#EXTM3U&#10;#EXTINF:-1 group-title=&quot;央视&quot;,CCTV1&#10;http://...">'
    + esc(state.libPasteText) + '</textarea></div>'
    + '<div><span>本地文件（txt / m3u，自动识别 GBK）</span><br>'
    + '<input type="file" data-lib-input="import-file" accept=".m3u,.m3u8,.txt"></div>'
    + '</div>'
    + '<div class="toolbar">'
    + '<button class="primary" data-lib="fetch-urls">云端抓取并解析</button>'
    + '<button class="ghost" data-lib="parse-text">解析粘贴内容</button>'
    + '<button class="ghost" data-lib="clear-parse">清空解析结果</button>'
    + '</div>'
    + '<p class="hint">支持标准 M3U / M3U Plus（group-title、tvg-logo）与 TXT genre'
    + '（分组,#genre# + 名称,url，多线路用 # 分隔）。按地址去重，仅保留'
    + ' http/https/rtmp/rtsp/udp/mms/p2p，单个套餐最多 3000 条。云端只搬运文本，不转流。</p>'
    + parsedBlock

    + '<h3>组成套餐</h3>'
    + '<div class="toolbar">'
    + '<input class="pkg-name" data-lib-input="new-package-name" placeholder="套餐名称，例如：央视+卫视">'
    + '<button class="primary" data-lib="create-package">存为新套餐</button>'
    + '</div>'
    + (packages.length
      ? '<div class="toolbar">'
        + '<select class="pkg-name" data-lib-input="append-target">'
        + packages.map((pkg) => '<option value="' + esc(pkg.id) + '"'
          + (state.libAppendTo === pkg.id ? ' selected' : '') + '>' + esc(pkg.name || pkg.id)
          + '（' + arr(pkg.channels).length + ' 个频道）</option>').join('')
        + '</select>'
        + '<button class="ghost" data-lib="append-package">追加到已有套餐（合并去重）</button>'
        + '</div>'
      : '')
    + '<p class="hint">「存为新套餐」把本次解析出的频道写成新套餐，并把本次用到的 URL 记入上面的订阅源列表。'
    + '套餐名和订阅源名称都可以直接在上面/下面的输入框里改（改完记得保存资源库）。</p>'

    + '<h3>频道套餐（' + packages.length + '）</h3>'
    + (packages.length
      ? '<div class="lib-list">' + pkgRows + '</div>'
      : '<p class="muted">还没有套餐，先导入源再「存为新套餐」。</p>')

    + '<div class="field" style="margin-top:18px"><span>EPG 地址（可选，http/https）</span>'
    + '<input type="text" data-lib-input="epg-url" value="' + esc(iptv.epgUrl || '') + '"></div>';
}

/* ---------------- TVBox 源页（库层） ---------------- */

const VOD_HEAD = '<h2>TVBox 源 · 站点库</h2>'
  + '<p class="hint">资源库与终端无关：先添加 TVBox 配置源，站点会按源分组入库，'
  + '再到「终端管理」里给终端勾选整源或单个站点。</p>';

function renderVodLibrary() {
  if (state.libraryState === 'unsupported') return VOD_HEAD + libraryUnsupportedHtml();
  if (!state.library) {
    return VOD_HEAD + libraryLoadFailedHtml()
      + '<p class="muted">资源库尚未加载。请先点击右上角「连接并加载」，或单独加载资源库。</p>'
      + '<div class="toolbar"><button class="ghost" data-lib="reload-library">加载资源库</button></div>';
  }
  const doc = state.library;
  const sources = arr(doc.vod.sources);
  const sites = arr(doc.vod.sites);
  const countOf = (sourceId) => sites.filter((site) => site.sourceId === sourceId).length;

  const sourceRows = sources.map((src) =>
    '<tr>'
    + '<td><strong>' + esc(src.name || src.id) + '</strong></td>'
    + '<td><code title="' + esc(src.url || '') + '">' + esc(src.url || '—') + '</code></td>'
    + '<td>' + countOf(src.id) + '</td>'
    + '<td><span class="meta">' + esc(formatWhen(src.addedAt)) + '</span></td>'
    + '<td><button class="tiny danger" data-lib="delete-vod-source" data-id="' + esc(src.id)
    + '">删除</button></td></tr>').join('');

  const groups = sources.map((src) => {
    const own = sites.filter((site) => site.sourceId === src.id);
    if (!own.length) return '';
    const rows = own.map((site) =>
      '<div class="lib-site-row"><code>' + esc(site.key) + '</code>'
      + '<span class="lib-site-name">' + esc(site.name || site.key) + '</span>'
      + '<code class="lib-site-api" title="' + esc(site.api || '') + '">' + esc(site.api || '') + '</code>'
      + '<input class="lib-input" data-lib-input="site-note" data-id="' + esc(site.id)
      + '" value="' + esc(site.note || '') + '" placeholder="备注"></div>').join('');
    return '<div class="lib-source-block">'
      + '<div class="lib-source-head"><strong>' + esc(src.name || src.id) + '</strong>'
      + '<span class="meta">' + own.length + ' 个站点</span>'
      + '<code class="lib-site-api">' + esc(src.url || '') + '</code></div>'
      + '<div class="lib-scroll">' + rows + '</div></div>';
  }).join('');

  return VOD_HEAD
    + libraryToolbar(doc)

    + '<h3>添加源</h3>'
    + '<div class="toolbar">'
    + '<input class="pkg-name" data-lib-input="tvbox-url" placeholder="https://example.com/tvbox.json"'
    + ' value="' + esc(state.tvboxUrl) + '">'
    + '<button class="primary" data-lib="add-vod-source">云端抓取并解析</button>'
    + '</div>'
    + '<p class="hint">从配置里取 <code>sites</code>，映射成库站点；'
    + '<code>api</code> 不是 http(s):// 或 csp_ 开头、<code>key</code> 缺失或重复的站点会被跳过并统计。'
    + '同时兼容顶层数组，以及 <code>urls</code> 里指向多份子配置的写法（最多取 5 个子配置）。</p>'
    + (state.tvboxSummary ? '<p class="hint">' + esc(state.tvboxSummary) + '</p>' : '')

    + '<h3>源列表（' + sources.length + '）</h3>'
    + (sources.length
      ? '<table class="device-table lib-table"><thead><tr><th>名称</th><th>URL</th><th>站点数</th>'
        + '<th>添加时间</th><th></th></tr></thead><tbody>' + sourceRows + '</tbody></table>'
      : '<p class="muted">还没有 TVBox 源，先在上面添加。</p>')

    + '<h3>站点（' + sites.length + '）</h3>'
    + (groups || '<p class="muted">还没有站点。</p>');
}

function agoText(seconds) {
  if (seconds == null || !Number.isFinite(seconds)) return '—';
  if (seconds < 60) return Math.max(0, Math.floor(seconds)) + ' 秒前';
  if (seconds < 3600) return Math.floor(seconds / 60) + ' 分钟前';
  if (seconds < 86400) return Math.floor(seconds / 3600) + ' 小时前';
  return Math.floor(seconds / 86400) + ' 天前';
}

function agoFromIso(value) {
  if (!value) return '—';
  const ts = Date.parse(value);
  return Number.isFinite(ts) ? agoText((Date.now() - ts) / 1000) : '—';
}

function deviceById(id) {
  return state.devices.find((item) => item.id === id);
}

function renderDevices() {
  const visible = state.devices.filter((d) => state.showHiddenDevices || !d.hidden);
  const online = state.devices.filter((d) => d.online && !d.hidden).length;
  const rows = visible.map((d) => {
    const checked = state.checkedDevices.has(d.id);
    const ops = [
      '<button class="tiny" data-device="rename" data-id="' + esc(d.id) + '">改名</button>',
      '<button class="tiny primary" data-device="settings" data-id="' + esc(d.id) + '">编辑设置</button>',
      '<button class="tiny primary" data-device="push" data-id="' + esc(d.id) + '">配置下发</button>',
      '<button class="tiny" data-device="reset" data-id="' + esc(d.id) + '">重置为模板</button>',
      d.hidden
        ? '<button class="tiny" data-device="restore" data-id="' + esc(d.id) + '">恢复</button>'
        : '<button class="tiny" data-device="delete" data-id="' + esc(d.id) + '">移除</button>',
      '<button class="tiny danger" data-device="purge" data-id="' + esc(d.id) + '">彻底删除</button>',
    ].join(' ');
    return '<tr' + (d.hidden ? ' class="row-hidden"' : '') + '>'
      + '<td><input type="checkbox" data-device-check="' + esc(d.id) + '"'
      + (checked ? ' checked' : '') + '></td>'
      + '<td>' + (d.online
        ? '<span class="badge ok">在线</span>'
        : '<span class="badge off">离线</span>') + '</td>'
      + '<td><input data-device-alias="' + esc(d.id) + '" value="' + esc(d.alias || '')
      + '" placeholder="未命名"></td>'
      + '<td><code>' + esc(d.id) + '</code>' + (d.hidden ? ' <span class="badge off">已移除</span>' : '')
      + (d.comment ? '<br><span class="meta">' + esc(d.comment) + '</span>' : '') + '</td>'
      + '<td>' + esc(d.appVersion || '—') + '</td>'
      + '<td>' + agoText(d.lastSeenAgo) + '<br><span class="meta">' + esc(d.lastSeen || '—') + '</span></td>'
      + '<td>r' + esc(d.revision) + '</td>'
      + '<td>' + (d.pushedAt ? agoFromIso(d.pushedAt) + '<br><span class="meta">r'
        + esc(d.pushedRevision || 0) + '</span>' : '—') + '</td>'
      + '<td class="ops">' + ops + '</td></tr>';
  }).join('');
  const blockedRows = (state.blocked || []).map((id) =>
    '<div class="history-row"><code>' + esc(id) + '</code>'
    + '<span class="meta">已拉黑，终端再上线会被 403 拒绝</span>'
    + '<button class="tiny" data-device="unblock" data-id="' + esc(id) + '">解除拉黑</button></div>').join('');

  return '<h2>上线终端 · ' + online + ' 台在线 / ' + state.devices.length + ' 台已连接</h2>'
    + '<p class="hint">所有连接过的设备都会登记在这里。客户端前台每 15 分钟同步一次配置，'
    + '云端以「最后上线距今 ≤ ' + esc(state.onlineWindow) + ' 分钟」判定在线。'
    + '每台终端保存一份<b>完整独立</b>的配置：新设备首次上线复制全局模板，'
    + '之后改全局模板<b>不会</b>影响已登记设备。点「编辑设置」可单独改一台的全部设置，'
    + '再点「配置下发」立即生成新 revision；终端下次同步（≤15 分钟）即生效。</p>'
    + '<div class="toolbar device-batch">'
    + '<label><input type="checkbox" data-batch="all"> 全选可见设备</label>'
    + '<button class="tiny" data-batch="push">批量下发</button>'
    + '<button class="tiny" data-batch="delete">批量移除</button>'
    + '<button class="tiny" data-batch="restore">批量恢复</button>'
    + '<label><input type="checkbox" data-batch="show-hidden"'
    + (state.showHiddenDevices ? ' checked' : '') + '> 显示已移除</label>'
    + '<button class="tiny" data-batch="refresh">刷新状态</button>'
    + '</div>'
    + '<table class="device-table"><thead><tr><th></th><th>状态</th><th>别名</th><th>设备 ID</th>'
    + '<th>App 版本</th><th>最后上线</th><th>版本</th><th>最近下发</th><th>操作</th>'
    + '</tr></thead><tbody>'
    + (rows || '<tr><td colspan="9">还没有终端上线。安装并打开一次 App 即会出现在这里。</td></tr>')
    + '</tbody></table>'
    + (blockedRows ? '<h3>已拉黑的设备</h3>' + blockedRows : '');
}

async function refreshDevices() {
  try {
    const data = await request('/api/devices');
    state.devices = data.devices || [];
    state.blocked = data.blocked || [];
    state.onlineWindow = data.onlineWindowMinutes || 30;
    renderDeviceSelect();
    if (state.activeTab === 'devices') renderPanel();
  } catch (error) {
    message('读取终端列表失败：' + error.message, 'err');
  }
}

async function deviceAction(action, ids, extra = {}) {
  const list = (Array.isArray(ids) ? ids : [ids]).filter(Boolean);
  if (!list.length) { message('请先勾选至少一台设备。', 'err'); return; }
  const body = Object.assign({ action }, extra);
  if (list.length === 1) body.deviceId = list[0];
  else body.deviceIds = list;
  if (action === 'rename') {
    const input = document.querySelector('[data-device-alias="' + list[0] + '"]');
    body.alias = input ? input.value.trim() : '';
  }
  if (action === 'purge' && !window.confirm(
    '彻底删除 ' + list.length + ' 台设备？会移除注册项并拉黑，终端再上线将被拒绝。可在下方「已拉黑」里解除。')) return;
  if (action === 'reset' && !window.confirm(
    '把 ' + list.length + ' 台设备的配置重置为当前全局模板？会各生成一个新 revision。')) return;
  try {
    const result = await request('/api/devices', {
      write: true, method: 'POST', body: JSON.stringify(body),
    });
    const failed = (result.results || []).filter((item) => !item.ok);
    if (failed.length) {
      message('部分操作失败：' + failed.map((item) => item.deviceId + ' → ' + item.error).join('；'), 'err');
    } else if (action === 'push') {
      const first = (result.results || [])[0] || {};
      toast('已下发：' + list.length + ' 台，终端下次同步（≤15 分钟）生效');
      message('配置下发成功，revision ' + (first.revision || '—') + '。'
        + (first.note || ''), 'ok');
    } else {
      toast('操作成功：' + list.length + ' 台设备');
    }
    await refreshDevices();
    if ((action === 'reset' || action === 'push') && list.includes(state.deviceId)) await load();
  } catch (error) {
    message('操作失败：' + error.message + hintOf(error), 'err');
  }
}

/** 显式下发：先把当前编辑保存到该设备，再生成新 revision。 */
async function pushToDevice(id, saveFirst) {
  if (saveFirst && state.dirty) {
    await save();
    if (state.dirty) { message('配置尚未保存成功，已取消下发。', 'err'); return; }
  }
  await deviceAction('push', id);
}

function onBatchAction(kind) {
  if (kind === 'refresh') { refreshDevices(); return; }
  const ids = [...state.checkedDevices];
  if (!ids.length) { message('请先勾选至少一台设备。', 'err'); return; }
  if (kind === 'push') deviceAction('push', ids);
  else if (kind === 'delete') deviceAction('delete', ids);
  else if (kind === 'restore') deviceAction('restore', ids);
}

/* ---------------- 资源库读写 ---------------- */

/** 加载资源库。force=false 时若本地有未保存改动，跳过重载以免丢失编辑。 */
async function loadLibrary(force) {
  if (!force && state.libraryDirty && state.library) { state.libraryState = 'ready'; return; }
  syncConnection();
  state.libraryState = 'loading';
  try {
    const raw = await request('/api/library');
    // 老服务端的 catch-all 可能把 index.html 当 200 返回，这里一并视为「未升级」。
    if (!isObj(raw) || !isObj(raw.iptv)) {
      state.library = null;
      state.libraryError = '';
      state.libraryState = 'unsupported';
      return;
    }
    state.library = ensureLibrary(clone(raw));
    state.libraryDirty = false;
    state.libraryState = 'ready';
    state.libraryError = '';
    state.libParsed = [];
    state.libSourcesUsed = [];
    state.libSummary = '';
    state.libPreviewId = '';
  } catch (error) {
    state.library = null;
    if (error.status === 404 || error.status === 405) {
      state.libraryError = '';
      state.libraryState = 'unsupported';
    } else {
      state.libraryError = error.message
        + (error.status === 401 ? '（请检查「访问令牌（读）」）' : '');
      state.libraryState = 'error';
    }
  }
}

async function saveLibrary() {
  if (!state.library) { message('资源库尚未加载。', 'err'); return; }
  if (!state.libraryDirty) { toast('资源库没有改动'); return; }
  clearMessage();
  try {
    const result = await request('/api/library', {
      write: true,
      method: 'PUT',
      headers: { 'If-Match': '"' + state.library.revision + '"' },
      body: JSON.stringify({
        iptv: state.library.iptv,
        vod: state.library.vod,
        expectedRevision: state.library.revision,
      }),
    });
    state.library.revision = Number(result && result.revision) || state.library.revision;
    if (result && result.updatedAt) state.library.updatedAt = result.updatedAt;
    state.libraryDirty = false;
    state.libraryState = 'ready';
    const affected = Number(result && result.affectedDevices) || 0;
    const warnings = arr(result && result.warnings);
    message('资源库已保存，revision ' + state.library.revision + '。'
      + '预计影响 ' + affected + ' 台终端，它们会在下次同步时自动更新。'
      + (warnings.length ? '\n服务端提示：\n' + warnings.join('\n') : ''), 'ok');
    render();
  } catch (error) {
    if (error.status === 409) {
      const current = error.data && error.data.currentRevision;
      message('保存失败：资源库已被其他人修改'
        + (current != null ? '（当前 revision ' + current + '）' : '')
        + '。请点「重新加载」拿到最新版本后再改。', 'err');
    } else {
      const guide = error.status === 401
        ? '\n\n「保存令牌（写）」请填 CONFIG_WRITE_TOKEN。读令牌只能用于加载，保存会 401。'
        : '';
      message('保存资源库失败：' + error.message + hintOf(error) + guide, 'err');
    }
    render();
  }
}

/** 统一规范化订阅地址：去空白 + percent-encode。
 *  中文路径若不编码，部分源站（如 live.hacks.tools）会直接返回 400，
 *  所以两端都统一用 new URL().href 处理后再请求。 */
function normalizeHttpUrl(raw) {
  // 从网页复制地址时常混入零宽字符/行分隔符，URL 解析不会报错但源站会 400，先清掉。
  const text = String(raw == null ? '' : raw)
    .replace(/[\u200b-\u200f\u2028\u2029\ufeff]/g, '')
    .trim();
  if (!text) throw new Error('地址为空');
  let parsed;
  try { parsed = new URL(text); } catch (_) {
    throw new Error('不是合法的 URL（含空格、中文未编码或不可见字符时容易失败）');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('仅支持 http(s) 地址');
  }
  return parsed.href;
}

/** 云端代抓单个地址；失败时退回浏览器直连（仍受 CORS 限制），并把两端原因都带出来。 */
async function fetchRemoteText(rawUrl) {
  const url = normalizeHttpUrl(rawUrl);
  let cloudError = '';
  try {
    const data = await request('/api/iptv/fetch', {
      write: true, method: 'POST', body: JSON.stringify({ urls: [url] }),
    });
    if (data && typeof data.text === 'string' && data.text.trim()) return data.text;
    const results = arr(data && data.results);
    const failed = results.filter((item) => !item.ok);
    cloudError = (failed[0] && failed[0].error) || (results.length ? '云端抓取成功但内容为空' : '云端无响应');
  } catch (error) {
    cloudError = '云端接口' + (error.status ? ' HTTP ' + error.status : '') + '：' + error.message;
  }
  let directError = '';
  try {
    const response = await fetch(url, { headers: { Accept: '*/*' } });
    if (response.ok) return await response.text();
    directError = 'HTTP ' + response.status;
  } catch (_) {
    directError = '被浏览器拦截（多为 CORS 或证书问题）';
  }
  throw new Error('云端：' + cloudError + '；浏览器直连：' + directError);
}

function sourceNameFromUrl(url) {
  try {
    const parsed = new URL(url);
    const raw = parsed.pathname.split('/').filter(Boolean).pop() || '';
    let name = raw;
    try { name = decodeURIComponent(raw); } catch (_) { /* 保留原样 */ }
    return (name || parsed.hostname).slice(0, 64);
  } catch (_) {
    return String(url || '').slice(0, 64);
  }
}

function readLibInput(kind) {
  const node = document.querySelector('[data-lib-input="' + kind + '"]');
  if (!node) return '';
  return String(node.value == null ? '' : node.value);
}

/** 统一收口解析结果：写入待入库频道 + 摘要，并刷新页面。 */
function setLibraryParseResult(text, sourcesUsed, note) {
  const result = parsePlaylist(text);
  state.libParsed = result.channels;
  state.libSourcesUsed = arr(sourcesUsed);
  state.libSummary = '解析完成：' + result.channels.length + ' 个频道'
    + (state.libSourcesUsed.length ? '，来自 ' + state.libSourcesUsed.length + ' 个源' : '')
    + (result.groups.length ? '，' + result.groups.length + ' 个分组' : '')
    + (result.truncated ? '（已达 3000 条上限，多余的被丢弃）' : '')
    + (note ? '。' + note : '');
  render();
  message(state.libSummary, result.channels.length ? 'ok' : 'err');
}

function parseLibraryText() {
  const box = document.querySelector('[data-lib-input="import-text"]');
  const text = box ? box.value : state.libPasteText;
  state.libPasteText = text;
  if (!text.trim()) { message('请先粘贴 M3U / TXT 内容，或选择本地文件。', 'err'); return; }
  setLibraryParseResult(text, [], '');
}

async function fetchLibraryUrls() {
  const box = document.querySelector('[data-lib-input="import-urls"]');
  const text = box ? box.value : state.libUrlText;
  state.libUrlText = text;
  const urls = text.split('\n').map((line) => line.trim())
    .filter((line) => /^https?:\/\//i.test(line)).slice(0, 10);
  if (!urls.length) { message('请先在「订阅地址」里填至少一个 http(s) 地址。', 'err'); return; }
  statusText('正在云端抓取订阅…');
  const texts = [];
  const used = [];
  const failed = [];
  for (const url of urls) {
    try {
      const body = await fetchRemoteText(url);
      const parsed = parsePlaylist(body);
      used.push({ name: sourceNameFromUrl(url), url, channelCount: parsed.channels.length, type: 'url' });
      texts.push(body);
    } catch (error) {
      failed.push(url + ' → ' + error.message);
    }
  }
  statusText(state.deviceId ? '已连接（' + deviceLabel() + '）' : '已连接');
  if (!texts.length) {
    message('抓取失败：' + failed.join('；')
      + '\n提示：地址含中文时已自动 percent-encode；若两边都失败，一般是源站限制了服务器访问，'
      + '可下载文件后用「本地文件」导入，或直接粘贴内容。', 'err');
    return;
  }
  state.libPasteText = texts.join('\n');
  setLibraryParseResult(texts.join('\n'), used,
    failed.length ? '部分源失败：' + failed.join('；') : '');
}

/** 把本次解析用到的 URL 记进订阅源列表（同 URL 只更新频道数），返回 url → 源 id 映射。 */
function registerLibrarySources() {
  const list = arr(state.library && state.library.iptv && state.library.iptv.sources);
  const byUrl = new Map();
  for (const item of state.libSourcesUsed) {
    if (!item.url) continue;
    const hit = list.find((src) => String(src.url || '').toLowerCase() === item.url.toLowerCase());
    if (hit) {
      hit.channelCount = item.channelCount;
      if (!hit.name) hit.name = item.name;
      byUrl.set(item.url, hit.id);
      continue;
    }
    if (list.length >= 30) continue; // 与 contract.js 的 MAX_LIBRARY_SOURCES 对齐
    const id = newLibraryId('src');
    list.push({
      id,
      name: item.name,
      url: item.url,
      type: item.type || 'url',
      channelCount: item.channelCount,
      addedAt: nowIso(),
      note: '',
    });
    byUrl.set(item.url, id);
  }
  if (state.library && state.library.iptv) state.library.iptv.sources = list;
  return byUrl;
}

function createPackageFromParse(nameInput) {
  if (!state.library) { message('资源库尚未加载。', 'err'); return; }
  if (!state.libParsed.length) { message('请先抓取或解析出频道，再存为套餐。', 'err'); return; }
  const packages = arr(state.library.iptv.packages);
  if (packages.length >= MAX_IPTV_PACKAGES) {
    message('资源库最多 ' + MAX_IPTV_PACKAGES + ' 个套餐，请先删除不用的套餐。', 'err');
    return;
  }
  const name = String(nameInput || '').trim().slice(0, 64) || ('套餐 ' + (packages.length + 1));
  const pkg = {
    id: newLibraryId('pkg'),
    name,
    sources: [],
    channels: clone(state.libParsed),
  };
  packages.push(pkg);
  // 服务端 packages[].sources 统一存源 id，这里先换算好，避免本地/云端两种形态来回跳。
  const byUrl = registerLibrarySources();
  pkg.sources = [...new Set(state.libSourcesUsed.map((item) => byUrl.get(item.url)).filter(Boolean))];
  state.library.iptv.packages = packages;
  const summary = '已创建套餐「' + name + '」（' + state.libParsed.length
    + ' 个频道）。记得点「保存资源库」。';
  state.libParsed = [];
  state.libSourcesUsed = [];
  state.libSummary = summary;
  markLibraryDirty();
  render();
  message(summary, 'ok');
}

function appendToPackage() {
  if (!state.library) { message('资源库尚未加载。', 'err'); return; }
  if (!state.libParsed.length) { message('请先抓取或解析出频道，再追加到套餐。', 'err'); return; }
  const id = state.libAppendTo || readLibInput('append-target');
  const pkg = arr(state.library.iptv.packages).find((item) => item.id === id);
  if (!pkg) { message('请选择要追加的套餐。', 'err'); return; }
  const before = arr(pkg.channels).length;
  pkg.channels = mergeChannels(pkg.channels, state.libParsed);
  const byUrl = registerLibrarySources();
  const newIds = state.libSourcesUsed.map((item) => byUrl.get(item.url)).filter(Boolean);
  pkg.sources = [...new Set(arr(pkg.sources).concat(newIds))].slice(0, 20);
  const summary = '已向「' + pkg.name + '」追加 ' + (pkg.channels.length - before)
    + ' 个频道（现有 ' + pkg.channels.length + ' 个）。记得点「保存资源库」。';
  state.libSummary = summary;
  markLibraryDirty();
  render();
  message(summary, 'ok');
}

function clearParseResult() {
  state.libParsed = [];
  state.libSourcesUsed = [];
  state.libSummary = '';
  render();
  toast('已清空解析结果');
}

function readLibraryFile(input) {
  const file = input.files && input.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    const bytes = new Uint8Array(reader.result || new ArrayBuffer(0));
    let text = new TextDecoder('utf-8').decode(bytes);
    const badUtf8 = (text.match(/\uFFFD/g) || []).length;
    if (badUtf8 > 0) {
      try {
        const gbk = new TextDecoder('gbk').decode(bytes);
        if ((gbk.match(/\uFFFD/g) || []).length < badUtf8) text = gbk;
      } catch (_) { /* 浏览器不支持 GBK 时保留 UTF-8 结果 */ }
    }
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    state.libPasteText = text;
    const box = document.querySelector('[data-lib-input="import-text"]');
    if (box) box.value = text;
    setLibraryParseResult(text, [], '本地文件：' + file.name);
  };
  reader.onerror = () => message('文件读取失败', 'err');
  reader.readAsArrayBuffer(file);
}

async function reloadLibrary() {
  if (state.libraryDirty && !window.confirm('资源库有未保存的改动，重新加载会丢弃，继续？')) return;
  state.libraryDirty = false;
  statusText('正在加载资源库…');
  await loadLibrary(true);
  render();
  if (state.libraryState === 'unsupported') message(LIBRARY_UNSUPPORTED_HINT, 'err');
  else if (state.libraryState === 'error') message('加载资源库失败：' + state.libraryError, 'err');
  else {
    statusText(state.doc ? '已连接（' + deviceLabel() + '）' : '资源库已加载');
    toast('资源库已加载');
  }
}

/* ---------------- 资源库交互 ---------------- */

function deleteLibraryPackage(id) {
  const packages = arr(state.library && state.library.iptv && state.library.iptv.packages);
  const pkg = packages.find((item) => item.id === id);
  if (!pkg) return;
  if (!window.confirm('从资源库删除套餐「' + (pkg.name || id) + '」？'
    + '引用它的终端会在下次同步时由云端自动剔除。')) return;
  state.library.iptv.packages = packages.filter((item) => item.id !== id);
  if (state.libPreviewId === id) state.libPreviewId = '';
  if (state.libAppendTo === id) state.libAppendTo = '';
  markLibraryDirty();
  render();
  message('已删除套餐「' + (pkg.name || id) + '」。记得点「保存资源库」。', 'ok');
}

function deleteLibrarySource(id) {
  const sources = arr(state.library && state.library.iptv && state.library.iptv.sources);
  const src = sources.find((item) => item.id === id);
  if (!src) return;
  const refs = arr(state.library.iptv.packages).filter((pkg) => arr(pkg.sources).includes(id));
  const tail = refs.length
    ? '仍有 ' + refs.length + ' 个套餐引用该来源，删除后会同时从这些套餐的「来源」里移除（频道不受影响）。'
    : '';
  if (!window.confirm('删除源「' + (src.name || src.url) + '」？套餐里的频道不会被删除。'
    + (tail ? '\n' + tail : ''))) return;
  state.library.iptv.sources = sources.filter((item) => item.id !== id);
  // 顺手清掉引用，避免留下悬空 id。
  for (const pkg of arr(state.library.iptv.packages)) {
    if (arr(pkg.sources).includes(id)) pkg.sources = arr(pkg.sources).filter((ref) => ref !== id);
  }
  markLibraryDirty();
  render();
  message('已删除源「' + (src.name || src.url) + '」'
    + (refs.length ? '，并从 ' + refs.length + ' 个套餐的「来源」里移除（频道未变）' : '')
    + '。记得点「保存资源库」。', 'ok');
}

function deleteVodSource(id) {
  const sources = arr(state.library && state.library.vod && state.library.vod.sources);
  const src = sources.find((item) => item.id === id);
  if (!src) return;
  if (!window.confirm('删除源「' + (src.name || src.url) + '」？它下面的站点会一并删除。')) return;
  state.library.vod.sources = sources.filter((item) => item.id !== id);
  state.library.vod.sites = arr(state.library.vod.sites).filter((site) => site.sourceId !== id);
  markLibraryDirty();
  render();
  message('已删除源「' + (src.name || src.url) + '」及其站点。记得点「保存资源库」。', 'ok');
}

/* ---- TVBox 配置解析 ---- */

const TVBOX_API_RE = /^(https?:\/\/|csp_)/i;

/** 把任意形态的 TVBox 配置拍平成 [{name, sites, urls}]：对象 / 顶层数组 / 配置数组。 */
function collectTvboxConfigs(json) {
  const configs = [];
  const walk = (node) => {
    if (!node) return;
    if (Array.isArray(node)) {
      if (node.some((item) => isObj(item) && typeof item.api === 'string')) {
        configs.push({ name: '', sites: node, urls: [] });
        return;
      }
      for (const item of node) walk(item);
      return;
    }
    if (!isObj(node)) return;
    configs.push({
      name: typeof node.name === 'string' ? node.name : '',
      sites: arr(node.sites),
      urls: arr(node.urls).filter((item) => typeof item === 'string' && /^https?:\/\//i.test(item)),
    });
  };
  walk(json);
  return configs;
}

/** sites → 库站点；api 非 http(s)/csp_、key 缺失或重复都跳过并计数。 */
const VOD_SITE_ID_RE = /^[A-Za-z0-9_:-]{1,96}$/;
const MAX_VOD_SITES_PER_SOURCE = 200;
const MAX_VOD_SITES = 500;
const MAX_VOD_SOURCES = 20;
const MAX_IPTV_PACKAGES = 12;

/** 站点 id 必须满足 [A-Za-z0-9_:-]，key 里的点号/斜杠等统一换成下划线。 */
function tvboxSiteId(sourceId, key) {
  const raw = sourceId + ':' + key;
  if (VOD_SITE_ID_RE.test(raw)) return raw;
  return sourceId + ':' + key.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64);
}

function tvboxSitesFrom(list, sourceId, seen, seenIds) {
  const sites = [];
  const ids = seenIds || new Set();
  let skipped = 0;
  for (const raw of arr(list)) {
    if (sites.length >= MAX_VOD_SITES_PER_SOURCE) { skipped += 1; continue; }
    if (!isObj(raw)) { skipped += 1; continue; }
    const key = String(raw.key == null ? '' : raw.key).trim();
    const api = String(raw.api == null ? '' : raw.api).trim();
    if (!key || seen.has(key) || !TVBOX_API_RE.test(api)) { skipped += 1; continue; }
    const id = tvboxSiteId(sourceId, key);
    if (ids.has(id)) { skipped += 1; continue; }
    seen.add(key);
    ids.add(id);
    sites.push({
      id,
      sourceId,
      key: key.slice(0, 64),
      name: (String(raw.name == null ? key : raw.name).trim() || key).slice(0, 64),
      api: api.slice(0, 1000),
      type: String(raw.type == null ? '' : raw.type).trim().slice(0, 16),
      searchable: raw.searchable == null ? true : !!raw.searchable,
      quickSearch: !!raw.quickSearch,
      note: '',
    });
  }
  return { sites, skipped };
}

async function addVodSource() {
  if (!state.library) { message('资源库尚未加载。', 'err'); return; }
  const box = document.querySelector('[data-lib-input="tvbox-url"]');
  const url = (box ? box.value : state.tvboxUrl).trim();
  state.tvboxUrl = url;
  if (!/^https?:\/\//i.test(url)) { message('请填写 http(s) 开头的 TVBox 配置地址。', 'err'); return; }
  statusText('正在抓取 TVBox 配置…');
  try {
    const text = await fetchRemoteText(url);
    let json = null;
    try { json = JSON.parse(text); } catch (_) {
      throw new Error('返回内容不是合法 JSON，可能不是 TVBox 配置');
    }
    const sourceId = newLibraryId('vod');
    const seen = new Set();
    const seenIds = new Set();
    const names = [];
    let sites = [];
    let skipped = 0;
    const configs = collectTvboxConfigs(json);
    for (const cfg of configs) {
      if (cfg.name) names.push(cfg.name);
      const part = tvboxSitesFrom(cfg.sites, sourceId, seen, seenIds);
      sites = sites.concat(part.sites);
      skipped += part.skipped;
    }
    const subSet = new Set();
    for (const cfg of configs) for (const sub of cfg.urls) subSet.add(sub);
    const subUrls = [...subSet].slice(0, 5);
    let subFailed = 0;
    for (const sub of subUrls) {
      try {
        const subJson = JSON.parse(await fetchRemoteText(sub));
        for (const cfg of collectTvboxConfigs(subJson)) {
          if (cfg.name) names.push(cfg.name);
          const part = tvboxSitesFrom(cfg.sites, sourceId, seen, seenIds);
          sites = sites.concat(part.sites);
          skipped += part.skipped;
        }
      } catch (_) { subFailed += 1; }
    }
    statusText(state.deviceId ? '已连接（' + deviceLabel() + '）' : '已连接');
    if (!sites.length) {
      message('没有解析出可用站点（跳过 ' + skipped + ' 条）。'
        + '请确认这是 TVBox 配置，且 sites 里 api 以 http(s):// 或 csp_ 开头。', 'err');
      return;
    }
    const existing = arr(state.library.vod.sources).find((src) => String(src.url || '') === url);
    if (existing) {
      if (!window.confirm('该地址已在资源库中，重新导入会替换它下面的所有站点，继续？')) return;
      state.library.vod.sources = arr(state.library.vod.sources)
        .filter((src) => src.id !== existing.id);
      state.library.vod.sites = arr(state.library.vod.sites)
        .filter((site) => site.sourceId !== existing.id);
    } else if (arr(state.library.vod.sources).length >= MAX_VOD_SOURCES) {
      message('资源库最多 ' + MAX_VOD_SOURCES + ' 个 TVBox 源，请先删除不用的源。', 'err');
      return;
    }
    const room = MAX_VOD_SITES - arr(state.library.vod.sites).length;
    if (room <= 0) { message('资源库站点已达 ' + MAX_VOD_SITES + ' 条上限，请先删除不用的源。', 'err'); return; }
    let dropped = 0;
    if (sites.length > room) { dropped = sites.length - room; sites = sites.slice(0, room); }
    const name = (names[0] || sourceNameFromUrl(url)).slice(0, 64);
    state.library.vod.sources.push({
      id: sourceId, name, url, siteCount: sites.length, addedAt: nowIso(), note: '',
    });
    state.library.vod.sites.push(...sites);
    state.tvboxSummary = '已导入「' + name + '」：' + sites.length + ' 个站点'
      + (skipped ? '，跳过 ' + skipped + ' 条（api 非法 / key 缺失或重复 / 超出单源 '
        + MAX_VOD_SITES_PER_SOURCE + ' 条上限）' : '')
      + (dropped ? '，超出资源库 ' + MAX_VOD_SITES + ' 条上限丢弃 ' + dropped + ' 条' : '')
      + (subFailed ? '，子配置抓取失败 ' + subFailed + ' 个' : '')
      + '。记得点「保存资源库」。';
    markLibraryDirty();
    render();
    message(state.tvboxSummary, 'ok');
  } catch (error) {
    statusText(state.deviceId ? '已连接（' + deviceLabel() + '）' : '已连接');
    message('添加 TVBox 源失败：' + error.message + hintOf(error), 'err');
  }
}

/** 把当前终端里的旧内联套餐搬进资源库（同名去重），再把 packageIds 指向库套餐。 */
function migrateInlinePackages() {
  if (!state.doc) { message('请先连接云端。', 'err'); return; }
  if (state.libraryState !== 'ready' || !state.library) {
    message('资源库不可用，暂时不能迁移。请先升级云端并「重新加载资源库」。', 'err');
    return;
  }
  const iptv = iptvSection();
  const inline = legacyInlinePackages(iptv);
  if (!inline.length) { message('当前配置里没有本地（旧）套餐。', 'err'); return; }
  const totalChannels = inline.reduce((sum, pkg) => sum + arr(pkg.channels).length, 0);
  if (!totalChannels) {
    message('读不到本地套餐的频道内容（服务端只返回了摘要）。请确认已「连接并加载」，或先升级云端再迁移。', 'err');
    return;
  }
  const map = new Map();
  let created = 0;
  let merged = 0;
  for (const pkg of inline) {
    const name = (String(pkg.name == null ? '' : pkg.name).trim() || '未命名套餐').slice(0, 64);
    const hit = arr(state.library.iptv.packages)
      .find((item) => String(item.name || '').trim() === name);
    if (hit) {
      const before = arr(hit.channels).length;
      hit.channels = mergeChannels(hit.channels, pkg.channels);
      if (hit.channels.length !== before) merged += 1;
      map.set(pkg.id, hit.id);
    } else {
      const id = newLibraryId('pkg');
      state.library.iptv.packages.push({
        id,
        name,
        sources: arr(pkg.sources).filter(Boolean),
        channels: clone(arr(pkg.channels)),
      });
      map.set(pkg.id, id);
      created += 1;
    }
  }
  const picked = arr(iptv.selectedPackageIds).map((id) => map.get(id)).filter(Boolean);
  if (!picked.length) for (const id of map.values()) picked.push(id);
  iptv.packageIds = [...new Set(picked)];
  const migratedIds = new Set(inline.map((pkg) => pkg.id));
  iptv.packages = arr(iptv.packages).filter((pkg) => !migratedIds.has(pkg.id));
  iptv.selectedPackageIds = [];
  markLibraryDirty();
  markDirty();
  render();
  message('已迁移 ' + inline.length + ' 个本地套餐到资源库（新建 ' + created
    + ' 个、合并 ' + merged + ' 个）。请先点「保存资源库」，再保存本终端配置。', 'ok');
}

function onLibraryAction(button) {
  const kind = button.dataset.lib;
  if (kind === 'save-library') { saveLibrary(); return; }
  if (kind === 'reload-library') { reloadLibrary(); return; }
  if (kind === 'fetch-urls') { fetchLibraryUrls(); return; }
  if (kind === 'parse-text') { parseLibraryText(); return; }
  if (kind === 'clear-parse') { clearParseResult(); return; }
  if (kind === 'create-package') { createPackageFromParse(readLibInput('new-package-name')); return; }
  if (kind === 'append-package') { appendToPackage(); return; }
  if (kind === 'preview-package') {
    state.libPreviewId = state.libPreviewId === button.dataset.id ? '' : button.dataset.id;
    renderPanel();
    return;
  }
  if (kind === 'delete-package') { deleteLibraryPackage(button.dataset.id); return; }
  if (kind === 'delete-source') { deleteLibrarySource(button.dataset.id); return; }
  if (kind === 'add-vod-source') { addVodSource(); return; }
  if (kind === 'delete-vod-source') { deleteVodSource(button.dataset.id); return; }
  if (kind === 'migrate-inline') { migrateInlinePackages(); return; }
}

/** 资源库输入：只写模型 + 点亮「未保存」，不重绘（重绘会抢走输入焦点）。 */
function onLibraryInput(target) {
  const kind = target.dataset.libInput;
  if (!kind) return;
  if (kind === 'import-urls') { state.libUrlText = target.value; return; }
  if (kind === 'import-text') { state.libPasteText = target.value; return; }
  if (kind === 'import-file') { readLibraryFile(target); return; }
  if (kind === 'tvbox-url') { state.tvboxUrl = target.value; return; }
  if (kind === 'new-package-name') return;
  if (!state.library) return;
  if (kind === 'append-target') { state.libAppendTo = target.value; return; }
  if (kind === 'epg-url') { state.library.iptv.epgUrl = target.value.trim().slice(0, 500); markLibraryDirty(); return; }
  const id = target.dataset.id;
  if (kind === 'pkg-name') {
    const pkg = arr(state.library.iptv.packages).find((item) => item.id === id);
    if (pkg) { pkg.name = target.value.slice(0, 64); markLibraryDirty(); }
    return;
  }
  if (kind === 'source-name') {
    const src = arr(state.library.iptv.sources).find((item) => item.id === id);
    if (src) { src.name = target.value.slice(0, 64); markLibraryDirty(); }
    return;
  }
  if (kind === 'source-note') {
    const src = arr(state.library.iptv.sources).find((item) => item.id === id);
    if (src) { src.note = target.value.slice(0, 200); markLibraryDirty(); }
    return;
  }
  if (kind === 'site-note') {
    const site = arr(state.library.vod.sites).find((item) => item.id === id);
    if (site) { site.note = target.value.slice(0, 200); markLibraryDirty(); }
  }
}

function renderPanel() {
  // 资源库页签与设备无关，未连接配置服务时也能打开（只提示先加载资源库）。
  const libraryTab = state.activeTab === 'iptv-lib' || state.activeTab === 'vod-lib';
  if (!state.doc && !libraryTab) {
    $('panel').innerHTML = '<p class="muted">请先点击右上角「连接并加载」。</p>';
    return;
  }
  const renderers = { sites: renderSites, navigation: renderNavigation,
    startup: renderStartup, update: renderUpdate,
    iptv: renderIptvDispatch, 'iptv-lib': renderIptvLibrary,
    'vod-lib': renderVodLibrary, devices: renderDevices };
  const renderer = renderers[state.activeTab] || renderSites;
  $('panel').innerHTML = renderer();
}

function diffLines() {
  const before = state.original.sections;
  const after = state.doc.sections;
  const lines = [];
  Object.keys(after).forEach((section) => {
    const keys = new Set(Object.keys(before[section] || {}).concat(Object.keys(after[section] || {})));
    keys.forEach((key) => {
      const a = JSON.stringify(before[section] ? before[section][key] : undefined);
      const b = JSON.stringify(after[section][key]);
      if (a !== b) {
        lines.push('【' + section + '.' + key + '】');
        lines.push('  - ' + (a === undefined ? '(无)' : a));
        lines.push('  + ' + b);
      }
    });
  });
  return lines.length ? lines.join('\n') : '当前没有改动。';
}

/* ---------------- 单终端全设置面板 ---------------- */

function dfCheck(path, label) {
  const value = getPath(state.doc.sections, path) === true;
  return '<label class="df-check"><input type="checkbox" data-df="' + esc(path) + '"'
    + (value ? ' checked' : '') + '> ' + esc(label) + '</label>';
}

function dfText(path, label, type) {
  const value = getPath(state.doc.sections, path);
  return '<label class="df-field"><span>' + esc(label) + '</span>'
    + '<input type="' + (type || 'text') + '" data-df="' + esc(path) + '" value="'
    + esc(value == null ? '' : value) + '"></label>';
}

function dfSelect(path, label, options) {
  const current = String(getPath(state.doc.sections, path) == null
    ? '' : getPath(state.doc.sections, path));
  const items = options.map((item) => {
    const value = typeof item === 'string' ? item : item.value;
    const name = typeof item === 'string' ? item : item.label;
    return '<option value="' + esc(value) + '"' + (value === current ? ' selected' : '')
      + '>' + esc(name) + '</option>';
  }).join('');
  return '<label class="df-field"><span>' + esc(label) + '</span>'
    + '<select data-df="' + esc(path) + '">' + items + '</select></label>';
}

function dfMulti(path, items, labelFn) {
  const current = new Set(getPath(state.doc.sections, path) || []);
  return '<div class="df-multi">' + items.map((item) =>
    '<label><input type="checkbox" data-df-multi="' + esc(path) + '" data-value="'
    + esc(item.id) + '"' + (current.has(item.id) ? ' checked' : '') + '> '
    + esc(labelFn(item)) + '</label>').join('') + '</div>';
}

/** 单终端 IPTV 区：勾选资源库套餐 + 锁定开关；旧内联套餐仍展示并支持迁移。 */
function deviceIptvBlock() {
  const libPackages = libraryPackages();
  const iptv = (state.doc.sections.iptv && isObj(state.doc.sections.iptv))
    ? state.doc.sections.iptv : { packages: [], selectedPackageIds: [], packageIds: [] };
  let html = dfCheck('iptv.managed', '云端接管本节');
  if (libPackages === null) {
    html += '<p class="meta">当前服务端不支持资源库，请先升级云端；下方本地旧套餐仍可用。</p>';
  } else {
    html += libPackages.length
      ? '<div class="df-multi">' + libPackages.map((pkg) =>
        '<label><input type="checkbox" data-df-multi="iptv.packageIds" data-value="' + esc(pkg.id) + '"'
        + (arr(iptv.packageIds).includes(pkg.id) ? ' checked' : '') + '> '
        + esc(pkg.name) + '（' + arr(pkg.channels).length + ' 个频道）</label>').join('')
        + '</div>'
      : '<p class="meta">资源库里还没有套餐，请先到「IPTV 源」页导入并创建套餐。</p>';
    html += '<label class="df-check"><input type="checkbox" data-df="iptv.lockLibrary"'
      + (iptv.lockLibrary ? ' checked' : '') + '> 锁定资源库</label>'
      + '<p class="meta">锁定后该终端不再跟随资源库变化，保持当前频道表。</p>';
  }
  return html + legacyIptvHtml(iptv);
}

/** 单终端 TVBox 区：勾选库源（整源）与具体站点 + 锁定开关。 */
function deviceVodBlock() {
  const sources = libraryVodSources();
  const sites = libraryVodSites();
  const vod = isObj(state.doc.sections.vod) ? state.doc.sections.vod : {};
  let html = dfCheck('vod.managed', '云端接管本节');
  if (sources === null) {
    return html + '<p class="meta">当前服务端不支持资源库，请先升级云端。</p>';
  }
  if (!sources.length) {
    return html + '<p class="meta">资源库里还没有 TVBox 源，请先到「TVBox 源」页添加。</p>';
  }
  const pickedSources = arr(vod.sourceIds);
  const pickedSites = arr(vod.siteIds);
  const allSites = arr(sites);
  html += '<p class="meta">整源下发：勾选后该源下所有站点都会下发。</p>'
    + '<div class="df-multi">' + sources.map((src) =>
      '<label><input type="checkbox" data-df-multi="vod.sourceIds" data-value="' + esc(src.id) + '"'
      + (pickedSources.includes(src.id) ? ' checked' : '') + '> '
      + esc(src.name || src.url) + '（'
      + allSites.filter((site) => site.sourceId === src.id).length + ' 个站点）</label>').join('')
    + '</div>'
    + '<p class="meta">再单独勾选具体站点（可选，最多列出 300 条）：</p>'
    + '<div class="lib-scroll lib-site-checks">'
    + (allSites.slice(0, 300).map((site) =>
      '<label><input type="checkbox" data-df-multi="vod.siteIds" data-value="' + esc(site.id) + '"'
      + (pickedSites.includes(site.id) ? ' checked' : '') + '> '
      + '<code>' + esc(site.key) + '</code> ' + esc(site.name || '')
      + (site.note ? ' <span class="meta">' + esc(site.note) + '</span>' : '')
      + '</label>').join('') || '<p class="muted">还没有站点。</p>')
    + '</div>'
    + '<label class="df-check"><input type="checkbox" data-df="vod.lockLibrary"'
    + (vod.lockLibrary ? ' checked' : '') + '> 锁定资源库</label>'
    + '<p class="meta">锁定后该终端不再跟随资源库变化，保持当前站点表。</p>';
  return html;
}

function renderDeviceEditor() {
  if (!state.doc) return '<p class="muted">请先连接云端。</p>';
  const id = state.drawerDeviceId;
  const device = deviceById(id) || {};
  const sections = state.doc.sections;
  const catalog = state.catalog || { sites: [], menus: [] };
  const sites = (catalog.sites || []).filter((item) => !item.retired);
  const menus = catalog.menus || [];
  const groups = (sections.navigation && sections.navigation.groups) || [];
  const noticeModes = [
    { value: 'once_per_revision', label: '每个新版本弹一次' },
    { value: 'always', label: '每次都弹' },
    { value: 'never', label: '不弹' },
  ];
  const prompts = [
    { value: 'silent', label: '静默' },
    { value: 'dialog', label: '弹窗提示' },
    { value: 'force', label: '强制更新' },
  ];

  return '<h2>单终端配置 · ' + esc(device.alias || id) + '</h2>'
    + '<p class="hint">以下设置<b>只对 <code>' + esc(id) + '</code> 生效</b>，'
    + '不会影响其它终端或全局模板。改完点「下发配置」：先保存本页改动，再生成新 revision，'
    + '终端前台约 15 分钟内的下一次同步即生效。</p>'
    + '<div class="df-grid">'

    + '<div class="df-block"><h3>直播平台显隐</h3>'
    + dfCheck('sites.managed', '云端接管本节')
    + dfMulti('sites.enabledSiteIds', sites, (item) => item.name || item.id)
    + '</div>'

    + '<div class="df-block"><h3>导航（左侧四大类）</h3>'
    + dfCheck('navigation.managed', '云端接管本节')
    + '<p class="meta">一级栏固定为 ' + esc(groups.map((g) => g.label).join(' / ') || 'IPTV / 影音 / 直播 / 设置')
    + '；下面勾选各块里显示的二级菜单。</p>'
    + dfSelect('navigation.defaultGroupId', '启动默认一级块',
      groups.map((g) => ({ value: g.id, label: g.label })))
    + dfMulti('navigation.railMenuIds', menus, (item) => item.name || item.id)
    + '</div>'

    + '<div class="df-block"><h3>开机公告</h3>'
    + dfCheck('startup.notice.enabled', '启用公告')
    + dfCheck('startup.notice.dismissible', '允许关闭')
    + dfSelect('startup.notice.mode', '显示频率', noticeModes)
    + '</div>'

    + '<div class="df-block"><h3>退出 App 弹窗</h3>'
    + dfCheck('startup.exitDialog.enabled', '云端接管退出弹窗（关闭则沿用本地默认）')
    + dfCheck('startup.exitDialog.dismissible', '可取消（关掉则只能退出）')
    + dfCheck('startup.exitDialog.showDonate', '显示捐赠二维码')
    + dfSelect('startup.exitDialog.mode', '显示频率', noticeModes)
    + dfText('startup.exitDialog.titleI18n.zh', '标题（中文）', 'text')
    + dfText('startup.exitDialog.bodyI18n.zh', '正文（中文）', 'text')
    + '</div>'

    + '<div class="df-block"><h3>在线更新</h3>'
    + dfCheck('update.managed', '云端接管本节')
    + dfCheck('update.autoCheck', '自动检查更新')
    + dfText('update.checkIntervalHours', '检查间隔（小时）', 'number')
    + dfSelect('update.prompt', '提示方式', prompts)
    + '</div>'

    + '<div class="df-block"><h3>IPTV 套餐下发</h3>' + deviceIptvBlock() + '</div>'

    + '<div class="df-block"><h3>TVBox 站点下发</h3>' + deviceVodBlock() + '</div>'

    + '</div>'
    + '<div class="toolbar" style="margin-top:16px">'
    + '<button class="primary" data-extra="device-push">下发配置到这台终端</button>'
    + '<button class="ghost" data-extra="device-save">仅保存（不生成额外 revision）</button>'
    + '<button class="ghost" data-extra="close">关闭</button>'
    + '</div>';
}

async function openDeviceEditor(id) {
  if (state.dirty && !window.confirm('当前有未保存的改动，切换配置对象会丢弃，继续？')) return;
  if (state.deviceId !== id) {
    state.deviceId = id;
    renderDeviceSelect();
    await load();
  }
  state.drawerDeviceId = id;
  state.extraMode = 'device';
  renderExtra();
  $('extra').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function renderExtra() {
  const node = $('extra');
  if (!state.extraMode) { node.hidden = true; node.innerHTML = ''; return; }
  node.hidden = false;
  if (state.extraMode === 'raw') {
    node.innerHTML = '<h2>原始配置 JSON</h2><p class="hint">可直接编辑整份文档，保存时只提交 sections。schemaVersion 必须为 1。</p>' +
      '<textarea class="raw" id="rawText">' + esc(JSON.stringify(state.doc, null, 2)) + '</textarea>' +
      '<div class="toolbar" style="margin-top:12px">' +
        '<button class="ghost" data-extra="raw-apply">应用到表单</button>' +
        '<button class="ghost" data-extra="close">关闭</button></div>';
  } else if (state.extraMode === 'diff') {
    node.innerHTML = '<h2>本次改动</h2><pre class="diff">' + esc(diffLines()) + '</pre>' +
      '<div class="toolbar" style="margin-top:12px"><button class="ghost" data-extra="close">关闭</button></div>';
  } else if (state.extraMode === 'history') {
    const rows = (state.extraData || []).map((item) =>
      '<div class="history-row"><strong>revision ' + esc(item.revision) + '</strong>' +
      '<span class="meta">' + esc(item.updatedAt || '') + ' · ' + esc(item.size || 0) + ' B</span>' +
      '<button class="tiny" data-extra="rollback" data-rev="' + esc(item.revision) + '">回滚到此版本</button></div>').join('');
    node.innerHTML = '<h2>历史快照</h2><p class="hint">回滚会生成一个新 revision，不会覆盖历史记录。</p>' +
      (rows || '<p class="muted">暂无历史</p>') +
      '<div class="toolbar" style="margin-top:12px"><button class="ghost" data-extra="close">关闭</button></div>';
  } else if (state.extraMode === 'device') {
    node.innerHTML = renderDeviceEditor();
  }
}

function render() {
  $('revBadge').textContent = 'revision ' + (state.doc ? state.revision : '—');
  $('devBadge').hidden = !state.devMode;
  $('btnSave').disabled = !state.doc || !state.dirty;
  const pushButton = $('btnPush');
  pushButton.disabled = !state.doc || !state.deviceId;
  pushButton.textContent = state.deviceId ? '下发到该终端' : '配置下发';
  Array.prototype.forEach.call(document.querySelectorAll('#tabs button'), (button) => {
    button.classList.toggle('active', button.dataset.tab === state.activeTab);
  });
  renderPanel();
  renderExtra();
}

/* ---------------- 操作 ---------------- */

async function load() {
  clearMessage();
  syncConnection();
  localStorage.setItem('purelive_config_base', state.base);
  localStorage.setItem('purelive_config_token', state.token);
  localStorage.setItem('purelive_config_write_token', state.writeToken);
  statusText('正在连接…');
  try {
    const health = await request('/health');
    state.devMode = !!health.devMode;
    const [doc, catalog, deviceData] = await Promise.all([
      request('/api/config'),
      request('/api/config/catalog'),
      request('/api/devices').catch(() => ({ devices: [] })),
    ]);
    state.devices = deviceData.devices || [];
    state.blocked = deviceData.blocked || [];
    state.onlineWindow = deviceData.onlineWindowMinutes || 30;
    renderDeviceSelect();
    state.doc = doc;
    state.original = clone(doc);
    state.catalog = catalog;
    state.revision = doc.revision;
    state.dirty = false;
    state.extraMode = null;
    statusText('已连接（' + deviceLabel() + '，schemaVersion ' + doc.schemaVersion + '）');
    render();
    // 资源库与设备无关，单独加载；加载失败不影响配置编辑。
    await loadLibrary(false);
    render();
    toast('配置加载成功');
  } catch (error) {
    statusText('连接失败');
    const guide = error.status === 401
      ? '\n\n「访问令牌（读）」请填 CONFIG_READ_TOKEN。写令牌只能用于保存，填到这里会 401。'
      : '';
    message('加载失败：' + error.message + hintOf(error) + guide, 'err');
  }
}

/**
 * 保存前清掉「由资源库派生」的数据。
 * GET ?withPackages=1 会把被引用的库套餐和展开后的频道塞进文档，
 * 原样 PUT 等于把它们再存一份，会把设备文档撑大；服务端下次 GET 会重新展开。
 */
function sectionsForSave() {
  const sections = clone(state.doc.sections);
  const iptv = sections.iptv;
  if (isObj(iptv) && iptv.lockLibrary !== true && arr(iptv.packageIds).length) {
    const refIds = new Set(arr(iptv.packageIds));
    iptv.packages = arr(iptv.packages).filter((pkg) => !refIds.has(pkg.id));
    iptv.channels = [];
    iptv.groups = [];
  }
  return sections;
}

async function save() {
  if (!state.doc || !state.dirty) return;
  clearMessage();
  $('btnSave').disabled = true;
  try {
    const result = await request('/api/config', {
      write: true,
      method: 'PUT',
      headers: { 'If-Match': String(state.revision) },
      body: JSON.stringify({ sections: sectionsForSave(), expectedRevision: state.revision }),
    });
    state.revision = result.revision;
    state.original = clone(state.doc);
    state.dirty = false;
    state.extraMode = null;
    statusText('已保存，revision ' + result.revision);
    message('保存成功，revision ' + result.revision +
      ((result.warnings && result.warnings.length) ? '\n服务端兜底提示：\n' + result.warnings.join('\n') : '') +
      (result.devMode ? '\n注意：当前为开发模式，接口未鉴权。' : ''), 'ok');
    render();
  } catch (error) {
    if (error.status === 409 && error.data && error.data.document) {
      statusText('版本冲突');
      message('云端配置已被其他设备修改（当前 revision ' + error.data.currentRevision +
        '）。请载入云端最新版后再重新编辑，避免覆盖他人改动。', 'err');
      $('message').innerHTML += '<div class="toolbar" style="margin-top:10px">' +
        '<button class="ghost" data-conflict="reload">载入云端最新版</button></div>';
    } else {
      const guide = error.status === 401
        ? '\n\n「保存令牌（写）」请填 CONFIG_WRITE_TOKEN。读令牌只能用于加载，保存会 401；留空时会用访问令牌。'
        : '';
      message('保存失败：' + error.message + hintOf(error) + guide, 'err');
    }
    render();
  }
}

async function showHistory() {
  try {
    const result = await request('/api/config/revisions?limit=30');
    state.extraData = result.revisions || [];
    state.extraMode = 'history';
    renderExtra();
  } catch (error) {
    message('读取历史失败：' + error.message, 'err');
  }
}

async function rollback(revision) {
  if (!window.confirm('确认回滚到 revision ' + revision + '？将生成一个新 revision。')) return;
  try {
    const result = await request('/api/config/rollback', {
      write: true,
      method: 'POST',
      body: JSON.stringify({ revision: Number(revision) }),
    });
    toast('已回滚，新 revision ' + result.revision);
    state.extraMode = null;
    await load();
  } catch (error) {
    message('回滚失败：' + error.message, 'err');
  }
}

function applyRaw() {
  try {
    const parsed = JSON.parse($('rawText').value);
    if (!parsed || parsed.schemaVersion !== 1 || !parsed.sections) {
      throw new Error('schemaVersion 必须为 1 且包含 sections');
    }
    state.doc = parsed;
    state.revision = parsed.revision;
    state.extraMode = null;
    markDirty();
    render();
    toast('已应用到表单');
  } catch (error) {
    message('原始 JSON 无效：' + error.message, 'err');
  }
}

function onFieldChange(target) {
  if (!state.doc) return;
  const path = target.dataset.path;
  if (path) {
    let value;
    if (target.type === 'checkbox') value = target.checked;
    else if (target.type === 'number') value = Number(target.value);
    else value = target.value;
    setPath(state.doc.sections, path, value);
    markDirty();
    return;
  }
  if (target.dataset.special === 'mirror-urls') {
    state.doc.sections.update.mirrorUrls = target.value.split('\n')
      .map((line) => line.trim()).filter(Boolean);
    markDirty();
    return;
  }
  if (target.dataset.special === 'settings-paths') {
    state.doc.sections.navigation.settings.enabledEntryPaths = target.value.split('\n')
      .map((line) => line.trim()).filter(Boolean);
    markDirty();
  }
}

function onAction(button) {
  const action = button.dataset.action;
  if (action === 'goto-devices') { state.activeTab = 'devices'; render(); return; }
  const sites = state.doc.sections.sites;
  const allIds = state.catalog.sites.filter((item) => !item.retired).map((item) => item.id);
  if (action === 'sites-all') sites.enabledSiteIds = allIds.slice();
  else if (action === 'sites-none') sites.enabledSiteIds = [];
  else if (action === 'sites-seed') sites.enabledSiteIds = allIds.slice();
  else if (action === 'sites-off-douyu') sites.enabledSiteIds = allIds.filter((id) => id !== 'douyu');
  else if (action === 'menu-up' || action === 'menu-down') {
    const list = state.doc.sections.navigation.railMenuIds;
    const index = list.indexOf(button.dataset.id);
    const target = index + (action === 'menu-up' ? -1 : 1);
    if (index >= 0 && target >= 0 && target < list.length) {
      const tmp = list[index]; list[index] = list[target]; list[target] = tmp;
    }
  }
  markDirty();
  renderPanel();
}

function onMenuToggle(target) {
  const id = target.dataset.menu;
  const list = state.doc.sections.navigation.railMenuIds;
  const index = list.indexOf(id);
  if (target.checked && index < 0) list.push(id);
  if (!target.checked && index >= 0) list.splice(index, 1);
  markDirty();
  renderPanel();
}

function onSiteToggle(target) {
  const id = target.dataset.site;
  const list = state.doc.sections.sites.enabledSiteIds;
  const index = list.indexOf(id);
  if (target.checked && index < 0) list.push(id);
  if (!target.checked && index >= 0) list.splice(index, 1);
  markDirty();
}

/* ---------------- 事件绑定 ---------------- */

document.addEventListener('DOMContentLoaded', () => {
  // 连接信息优先级：本机改过（localStorage）> 服务端注入的默认值 > 空白。
  // 默认值由 EdgeOne 环境变量在响应页面时注入，不写进公开仓库。
  const injected = window.__PURETV_DEFAULTS__ || null;
  const saved = {
    base: localStorage.getItem('purelive_config_base'),
    token: localStorage.getItem('purelive_config_token'),
    writeToken: localStorage.getItem('purelive_config_write_token'),
  };
  const hasSaved = saved.base !== null || saved.token !== null || saved.writeToken !== null;
  let autoConnect = false;
  if (injected && !hasSaved) {
    $('apiBase').value = injected.base || '';
    $('apiToken').value = injected.readToken || '';
    $('apiWriteToken').value = injected.writeToken || '';
    autoConnect = !!injected.autoConnect && !!injected.readToken;
  } else {
    $('apiBase').value = saved.base || '';
    $('apiToken').value = saved.token || '';
    $('apiWriteToken').value = saved.writeToken || '';
  }

  $('btnConnect').addEventListener('click', load);
  $('btnSave').addEventListener('click', save);
  $('btnRaw').addEventListener('click', () => {
    if (!state.doc) return;
    state.extraMode = state.extraMode === 'raw' ? null : 'raw';
    renderExtra();
  });
  $('btnDiff').addEventListener('click', () => {
    if (!state.doc) return;
    state.extraMode = state.extraMode === 'diff' ? null : 'diff';
    renderExtra();
  });
  $('btnHistory').addEventListener('click', showHistory);
  $('btnPush').addEventListener('click', () => {
    if (!state.deviceId) { message('请先在「配置对象」里选中一台终端。', 'err'); return; }
    pushToDevice(state.deviceId, true);
  });

  $('tabs').addEventListener('click', (event) => {
    const button = event.target.closest('button[data-tab]');
    if (!button) return;
    state.activeTab = button.dataset.tab;
    render();
  });

  $('panel').addEventListener('change', (event) => {
    const target = event.target;
    if (target.dataset.libInput) { onLibraryInput(target); return; }
    if (target.dataset.site) onSiteToggle(target);
    else if (target.dataset.menu) onMenuToggle(target);
    else onFieldChange(target);
  });
  $('panel').addEventListener('input', (event) => {
    const target = event.target;
    if (target.dataset.libInput) {
      // 文件选择走 change，避免 input + change 重复读取同一份文件。
      if (target.type !== 'file') onLibraryInput(target);
      return;
    }
    if (target.tagName === 'TEXTAREA' || target.type === 'text' || target.type === 'number') onFieldChange(target);
  });
  $('panel').addEventListener('click', (event) => {
    const button = event.target.closest('button[data-action]');
    if (button) onAction(button);
  });

  $('extra').addEventListener('click', (event) => {
    const libButton = event.target.closest('button[data-lib]');
    if (libButton) { onLibraryAction(libButton); return; }
    const button = event.target.closest('button[data-extra]');
    if (!button) return;
    const kind = button.dataset.extra;
    if (kind === 'close') { state.extraMode = null; renderExtra(); }
    else if (kind === 'raw-apply') applyRaw();
    else if (kind === 'rollback') rollback(button.dataset.rev);
    else if (kind === 'device-save') save();
    else if (kind === 'device-push') pushToDevice(state.drawerDeviceId, true);
  });

  // 单终端全设置面板：所有字段用 data-df 路径直接写进当前设备文档。
  $('extra').addEventListener('change', (event) => {
    const target = event.target;
    if (!state.doc) return;
    if (target.dataset.df) {
      let value;
      if (target.type === 'checkbox') value = target.checked;
      else if (target.type === 'number') value = Number(target.value) || 0;
      else value = target.value;
      setPath(state.doc.sections, target.dataset.df, value);
      markDirty();
      return;
    }
    if (target.dataset.dfMulti) {
      const path = target.dataset.dfMulti;
      const current = new Set(getPath(state.doc.sections, path) || []);
      if (target.checked) current.add(target.dataset.value);
      else current.delete(target.dataset.value);
      setPath(state.doc.sections, path, [...current]);
      markDirty();
    }
  });


  $('deviceSelect').addEventListener('change', async (event) => {
    const next = event.target.value.trim();
    if (next === state.deviceId) return;
    if (state.dirty && !window.confirm('当前有未保存的改动，切换配置对象会丢弃，继续？')) {
      renderDeviceSelect();
      return;
    }
    state.deviceId = next;
    if (state.doc) await load();
    else renderDeviceSelect();
  });

  $('panel').addEventListener('click', (event) => {
    const libButton = event.target.closest('button[data-lib]');
    if (libButton) { onLibraryAction(libButton); return; }
    const batchButton = event.target.closest('button[data-batch]');
    if (batchButton) { onBatchAction(batchButton.dataset.batch); return; }
    const deviceButton = event.target.closest('button[data-device]');
    if (!deviceButton) return;
    const id = deviceButton.dataset.id;
    const action = deviceButton.dataset.device;
    if (action === 'edit' || action === 'settings') { openDeviceEditor(id); return; }
    if (action === 'push') { pushToDevice(id, false); return; }
    if (action === 'unblock') { deviceAction('unblock', id); return; }
    deviceAction(action, id);
  });

  $('panel').addEventListener('change', (event) => {
    const target = event.target;
    if (!state.doc) return;
    if (target.dataset.pkg) {
      // 勾选的是资源库套餐 id，写入 iptv.packageIds 并记录当时的资源库 revision。
      const iptv = iptvSection();
      const picked = new Set(arr(iptv.packageIds));
      if (target.checked) picked.add(target.dataset.pkg);
      else picked.delete(target.dataset.pkg);
      iptv.packageIds = [...picked];
      iptv.managed = true;
      markDirty();
      return;
    }
    if (target.dataset.deviceCheck) {
      if (target.checked) state.checkedDevices.add(target.dataset.deviceCheck);
      else state.checkedDevices.delete(target.dataset.deviceCheck);
      return;
    }
    if (target.dataset.batch === 'all') {
      const visible = state.devices.filter((d) => state.showHiddenDevices || !d.hidden);
      for (const d of visible) {
        if (target.checked) state.checkedDevices.add(d.id);
        else state.checkedDevices.delete(d.id);
      }
      renderPanel();
      return;
    }
    if (target.dataset.batch === 'show-hidden') {
      state.showHiddenDevices = target.checked;
      renderPanel();
    }
  });

  $('message').addEventListener('click', (event) => {
    const button = event.target.closest('button[data-conflict]');
    if (button && button.dataset.conflict === 'reload') load();
  });

  render();
  // 首次访问且服务端已注入连接信息时直接连上，省掉手动点一次按钮。
  if (autoConnect) load();
});
