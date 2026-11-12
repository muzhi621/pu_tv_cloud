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
  iptvText: '',       // IPTV 导入框里粘贴的文本
  iptvSummary: '',    // 最近一次解析结果摘要
  parsedChannels: [], // 最近一次解析出的频道（用于「存为套餐」）
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
      packages: [], selectedPackageIds: [],
    };
  }
  const iptv = sections.iptv;
  if (!Array.isArray(iptv.packages)) iptv.packages = [];
  if (!Array.isArray(iptv.selectedPackageIds)) iptv.selectedPackageIds = [];
  if (!Array.isArray(iptv.channels)) iptv.channels = [];
  if (!Array.isArray(iptv.groups)) iptv.groups = [];
  if (!Array.isArray(iptv.sources)) iptv.sources = [];
  return iptv;
}

function newPackageId() {
  return 'pkg_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7);
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

/** 解析结果先放在内存里，由用户决定「存为套餐」还是「直接写入当前配置」。 */
function applyPlaylist(text, source) {
  const result = parsePlaylist(text);
  const iptv = iptvSection();
  state.parsedChannels = result.channels;
  if (source) {
    const sources = iptv.sources || [];
    const list = Array.isArray(source) ? source : [source];
    for (const url of list) if (url && !sources.includes(url)) sources.push(url);
    iptv.sources = sources.slice(0, 20);
  }
  state.iptvSummary = '解析完成：' + result.channels.length + ' 个频道、'
    + result.groups.length + ' 个分组'
    + (result.truncated ? '（已达 3000 条上限，多余的被丢弃）' : '')
    + '。可存为套餐、追加到已有套餐，或直接写入当前配置。';
  render();
  message(state.iptvSummary, 'ok');
}

function renderIptv() {
  const iptv = iptvSection();
  const packages = iptv.packages || [];
  const selected = iptv.selectedPackageIds || [];
  const list = iptv.channels || [];
  const preview = list.slice(0, 25).map((c) =>
    '<div>' + esc(c.group || '未分组') + ' · <strong>' + esc(c.name) + '</strong> '
    + '<code>' + esc(c.url) + '</code></div>').join('');
  const packageRows = packages.map((pkg) => {
    const count = (pkg.channels || []).length;
    const groups = [...new Set((pkg.channels || []).map((c) => c.group).filter(Boolean))];
    return '<div class="pkg-row">'
      + '<label class="pkg-check"><input type="checkbox" data-pkg="' + esc(pkg.id) + '"'
      + (selected.includes(pkg.id) ? ' checked' : '') + '> <strong>' + esc(pkg.name) + '</strong></label>'
      + '<span class="meta">' + count + ' 个频道 · ' + groups.length + ' 个分组'
      + (groups.length ? '（' + esc(groups.slice(0, 3).join('、')) + '…）' : '') + '</span>'
      + '<span class="meta">' + esc((pkg.sources || []).join('、') || '本地/粘贴导入') + '</span>'
      + '<span class="pkg-actions">'
      + '<button class="tiny" data-iptv="append-package" data-id="' + esc(pkg.id)
      + '">追加解析结果</button> '
      + '<button class="tiny" data-iptv="delete-package" data-id="' + esc(pkg.id)
      + '">删除</button></span></div>';
  }).join('');

  return managedHtml('iptv', 'IPTV 频道与套餐')
    + '<div class="iptv-tools">'
    + '<div class="grow"><span>订阅地址（http/https，一行一个，云端代抓不受 CORS 限制）</span>'
    + '<textarea data-iptv="urls" placeholder="https://example.com/list.m3u">'
    + esc((iptv.sources || []).join('\n')) + '</textarea></div>'
    + '<div class="grow"><span>或粘贴 M3U / M3U8 / TXT 内容</span>'
    + '<textarea data-iptv="text" placeholder="#EXTM3U&#10;#EXTINF:-1 group-title=&quot;央视&quot;,CCTV1&#10;http://...">'
    + esc(state.iptvText) + '</textarea></div>'
    + '<div><span>本地文件（txt / m3u，自动识别 GBK）</span><br>'
    + '<input type="file" data-iptv="file" accept=".m3u,.m3u8,.txt"></div>'
    + '</div>'
    + '<div class="toolbar">'
    + '<button class="primary" data-iptv="fetch">云端抓取 URL 并解析</button>'
    + '<button class="ghost" data-iptv="parse">解析粘贴内容</button>'
    + '<button class="ghost" data-iptv="direct">直接写入当前配置（不走套餐）</button>'
    + '<button class="ghost" data-iptv="clear">清空频道</button>'
    + '</div>'
    + '<p class="hint">支持标准 M3U / M3U Plus（group-title、tvg-logo）与 TXT genre'
    + '（分组,#genre# + 名称,url，多线路用 # 分隔）。按地址去重，仅保留'
    + ' http/https/rtmp/rtsp/udp/mms/p2p，单个套餐最多 3000 条、套餐库合计 5000 条。'
    + '网络链接由云端代理抓取并自动识别 UTF-8 / GBK；云端只搬运文本，不抓定时订阅、不转流。</p>'
    + (state.iptvSummary ? '<p class="hint">' + esc(state.iptvSummary) + '</p>' : '')

    + '<h3>组成套餐</h3>'
    + '<div class="toolbar">'
    + '<input class="pkg-name" data-iptv="pkg-name" placeholder="套餐名称，例如：央视+卫视">'
    + '<button class="primary" data-iptv="save-package">存为新套餐</button>'
    + '</div>'
    + '<p class="hint">套餐是频道库。勾中套餐后，当前配置对象（'
    + esc(state.deviceId ? deviceLabel() : '全局模板') + '）只会把勾中套餐的频道下发给终端；'
    + '不同终端可以选不同套餐。最多 12 个套餐。</p>'
    + '<div class="pkg-list">' + (packageRows || '<p class="muted">还没有套餐，先导入源再「存为新套餐」。</p>') + '</div>'

    + textField('iptv.epgUrl', 'EPG 地址（可选，http/https）', 'text')
    + '<p><strong>当前下发 ' + list.length + ' 个频道 / ' + (iptv.groups || []).length
    + ' 个分组</strong>（选中套餐时由云端展开，保存后生效）</p>'
    + '<div class="preview-list">' + (preview || '<p class="muted">暂无频道</p>') + '</div>';
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

/** 云端代抓订阅：绕过浏览器 CORS，一次可抓多个地址并自动识别 UTF-8 / GBK。 */
async function fetchIptvUrl() {
  const box = document.querySelector('[data-iptv="urls"]');
  const urls = (box ? box.value : '').split('\n').map((x) => x.trim())
    .filter((x) => /^https?:\/\//i.test(x)).slice(0, 10);
  if (!urls.length) { message('请先在「订阅地址」里填至少一个 http(s) 地址', 'err'); return; }
  statusText('正在云端抓取订阅…');
  try {
    const data = await request('/api/iptv/fetch', {
      write: true, method: 'POST', body: JSON.stringify({ urls }),
    });
    const failed = (data.results || []).filter((item) => !item.ok);
    if (!data.text) {
      statusText('抓取失败');
      message('抓取失败：' + failed.map((item) => item.url + ' → ' + item.error).join('；'), 'err');
      return;
    }
    state.iptvText = data.text;
    const textBox = document.querySelector('[data-iptv="text"]');
    if (textBox) textBox.value = data.text;
    applyPlaylist(data.text, urls);
    statusText('已连接（' + deviceLabel() + '）');
    message('云端抓取完成：' + data.succeeded + '/' + data.total + ' 个源'
      + (failed.length ? '；失败：' + failed.map((item) => item.url + ' → ' + item.error).join('；') : ''),
    failed.length ? 'err' : 'ok');
  } catch (error) {
    // 兼容尚未部署 /api/iptv/fetch 的自建服务：退回浏览器直连（仍受 CORS 限制）。
    try {
      const response = await fetch(urls[0], { headers: { Accept: '*/*' } });
      if (!response.ok) throw new Error('HTTP ' + response.status);
      const text = await response.text();
      state.iptvText = text;
      applyPlaylist(text, urls.slice(0, 1));
      message('已用浏览器直连抓取（云端代理不可用）。源站未开放 CORS 时请改用本地文件。', 'ok');
    } catch (fallback) {
      statusText('抓取失败');
      message('抓取失败：' + error.message + '；浏览器直连也失败：' + fallback.message
        + '。请下载后用「本地文件」导入，或直接粘贴内容。', 'err');
    }
  }
}

function parsedChannelsOrWarn() {
  if (!state.parsedChannels.length) {
    message('请先「云端抓取 URL」「解析粘贴内容」或选择本地文件，再执行这一步。', 'err');
    return false;
  }
  return true;
}

function onIptvAction(button) {
  const kind = button.dataset.iptv;
  const iptv = iptvSection();
  if (kind === 'parse') {
    const box = document.querySelector('[data-iptv="text"]');
    const text = box ? box.value : '';
    state.iptvText = text;
    if (!text.trim()) { message('请先粘贴内容或选择本地文件', 'err'); return; }
    applyPlaylist(text, '');
  } else if (kind === 'fetch') {
    fetchIptvUrl();
  } else if (kind === 'direct') {
    if (!parsedChannelsOrWarn()) return;
    iptv.channels = state.parsedChannels.slice(0, 3000);
    iptv.groups = [...new Set(iptv.channels.map((c) => c.group).filter(Boolean))];
    iptv.selectedPackageIds = [];
    iptv.managed = true;
    markDirty();
    render();
    message('已把 ' + iptv.channels.length + ' 个频道直接写入当前配置（不使用套餐）。保存后下发。', 'ok');
  } else if (kind === 'save-package') {
    if (!parsedChannelsOrWarn()) return;
    const nameBox = document.querySelector('[data-iptv="pkg-name"]');
    const name = (nameBox ? nameBox.value : '').trim().slice(0, 64) || ('套餐 ' + (iptv.packages.length + 1));
    if (iptv.packages.length >= 12) { message('最多 12 个套餐，请先删除不用的套餐。', 'err'); return; }
    const sources = (iptv.sources || []).slice(-5);
    iptv.packages.push({
      id: newPackageId(), name, sources,
      channels: state.parsedChannels.slice(0, 3000),
    });
    iptv.managed = true;
    markDirty();
    render();
    message('套餐「' + name + '」已创建（' + state.parsedChannels.length + ' 个频道）。'
      + '勾选它并保存，即可下发给当前配置对象。', 'ok');
  } else if (kind === 'append-package') {
    if (!parsedChannelsOrWarn()) return;
    const pkg = iptv.packages.find((item) => item.id === button.dataset.id);
    if (!pkg) return;
    const before = (pkg.channels || []).length;
    pkg.channels = mergeChannels(pkg.channels, state.parsedChannels);
    markDirty();
    render();
    message('已向「' + pkg.name + '」追加 ' + (pkg.channels.length - before) + ' 个频道。', 'ok');
  } else if (kind === 'delete-package') {
    const id = button.dataset.id;
    const pkg = iptv.packages.find((item) => item.id === id);
    if (pkg && !window.confirm('删除套餐「' + pkg.name + '」？')) return;
    iptv.packages = iptv.packages.filter((item) => item.id !== id);
    iptv.selectedPackageIds = (iptv.selectedPackageIds || []).filter((x) => x !== id);
    markDirty();
    render();
  } else if (kind === 'clear') {
    iptv.channels = [];
    iptv.groups = [];
    iptv.sources = [];
    iptv.selectedPackageIds = [];
    state.parsedChannels = [];
    state.iptvSummary = '已清空频道与套餐选择（套餐库保留），保存后终端将不再收到云端 IPTV 配置。';
    markDirty();
    render();
  }
}

function renderPanel() {
  if (!state.doc) {
    $('panel').innerHTML = '<p class="muted">请先点击右上角「连接并加载」。</p>';
    return;
  }
  const renderers = { sites: renderSites, navigation: renderNavigation,
    startup: renderStartup, update: renderUpdate,
    iptv: renderIptv, devices: renderDevices };
  $('panel').innerHTML = renderers[state.activeTab]();
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

function renderDeviceEditor() {
  if (!state.doc) return '<p class="muted">请先连接云端。</p>';
  const id = state.drawerDeviceId;
  const device = deviceById(id) || {};
  const sections = state.doc.sections;
  const catalog = state.catalog || { sites: [], menus: [] };
  const sites = (catalog.sites || []).filter((item) => !item.retired);
  const menus = catalog.menus || [];
  const groups = (sections.navigation && sections.navigation.groups) || [];
  const packages = (sections.iptv && sections.iptv.packages) || [];
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

    + '<div class="df-block"><h3>IPTV 套餐下发</h3>'
    + dfCheck('iptv.managed', '云端接管本节')
    + (packages.length
      ? dfMulti('iptv.selectedPackageIds', packages.map((p) => ({ id: p.id, name: p.name })),
        (item) => item.name + '（' + ((packages.find((p) => p.id === item.id) || {}).channels || []).length + ' 个频道）')
      : '<p class="meta">还没有套餐，请先到「IPTV 源」页导入并创建套餐。</p>')
    + '</div>'

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
  state.base = $('apiBase').value.trim();
  state.token = $('apiToken').value.trim();
  state.writeToken = $('apiWriteToken').value.trim();
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
    toast('配置加载成功');
  } catch (error) {
    statusText('连接失败');
    const guide = error.status === 401
      ? '\n\n「访问令牌（读）」请填 CONFIG_READ_TOKEN。写令牌只能用于保存，填到这里会 401。'
      : '';
    message('加载失败：' + error.message + hintOf(error) + guide, 'err');
  }
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
      body: JSON.stringify({ sections: state.doc.sections, expectedRevision: state.revision }),
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
    if (target.dataset.site) onSiteToggle(target);
    else if (target.dataset.menu) onMenuToggle(target);
    else onFieldChange(target);
  });
  $('panel').addEventListener('input', (event) => {
    const target = event.target;
    if (target.tagName === 'TEXTAREA' || target.type === 'text' || target.type === 'number') onFieldChange(target);
  });
  $('panel').addEventListener('click', (event) => {
    const button = event.target.closest('button[data-action]');
    if (button) onAction(button);
  });

  $('extra').addEventListener('click', (event) => {
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
    state.iptvSummary = '';
    if (state.doc) await load();
    else renderDeviceSelect();
  });

  $('panel').addEventListener('click', (event) => {
    const iptvButton = event.target.closest('button[data-iptv]');
    if (iptvButton) { if (!state.doc) return; onIptvAction(iptvButton); return; }
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
    if (target.dataset.iptv === 'file') {
      const file = target.files && target.files[0];
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
        state.iptvText = text;
        const box = document.querySelector('[data-iptv="text"]');
        if (box) box.value = text;
        applyPlaylist(text, '');
      };
      reader.onerror = () => message('文件读取失败', 'err');
      reader.readAsArrayBuffer(file);
      return;
    }
    if (target.dataset.iptv === 'urls') {
      const urls = target.value.split('\n').map((x) => x.trim())
        .filter((x) => /^https?:\/\//i.test(x)).slice(0, 20);
      iptvSection().sources = urls;
      markDirty();
      return;
    }
    if (target.dataset.pkg) {
      const iptv = iptvSection();
      const picked = new Set(iptv.selectedPackageIds || []);
      if (target.checked) picked.add(target.dataset.pkg);
      else picked.delete(target.dataset.pkg);
      iptv.selectedPackageIds = [...picked];
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
