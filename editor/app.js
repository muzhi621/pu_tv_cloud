/* 纯粹直播 TV · 云端配置编辑器（零依赖，直接由配置服务同源托管） */
'use strict';

const state = {
  base: '',
  token: '',          // 读令牌：GET /api/* 与 /health
  writeToken: '',     // 写令牌：PUT /api/config、POST rollback；留空时回退读令牌
  deviceId: '',       // 空 = 全局模板；非空 = 某台终端的独立配置
  devices: [],        // 上线终端注册表
  iptvText: '',       // IPTV 导入框里粘贴的文本
  iptvSummary: '',    // 最近一次解析结果摘要
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
  if (!state.doc.sections.iptv) {
    state.doc.sections.iptv = { managed: false, sources: [], groups: [], channels: [], epgUrl: '' };
  }
  return state.doc.sections.iptv;
}

function applyPlaylist(text, source) {
  const result = parsePlaylist(text);
  const iptv = iptvSection();
  iptv.channels = result.channels;
  iptv.groups = result.groups;
  iptv.managed = true;
  if (source) {
    const sources = iptv.sources || [];
    if (!sources.includes(source)) sources.push(source);
    iptv.sources = sources.slice(0, 20);
  }
  state.iptvSummary = '解析完成：' + result.channels.length + ' 个频道、'
    + result.groups.length + ' 个分组'
    + (result.truncated ? '（已达 3000 条上限，多余的被丢弃）' : '')
    + '。请点「保存到云端」下发。';
  markDirty();
  render();
  message(state.iptvSummary, 'ok');
}

function renderIptv() {
  const iptv = iptvSection();
  const list = iptv.channels || [];
  const preview = list.slice(0, 25).map((c) =>
    '<div>' + esc(c.group || '未分组') + ' · <strong>' + esc(c.name) + '</strong> '
    + '<code>' + esc(c.url) + '</code></div>').join('');
  return managedHtml('iptv', 'IPTV 频道列表')
    + '<div class="iptv-tools">'
    + '<div class="grow"><span>订阅地址（http/https，一行一个）</span>'
    + '<textarea data-iptv="urls" placeholder="https://example.com/list.m3u">'
    + esc((iptv.sources || []).join('\n')) + '</textarea></div>'
    + '<div class="grow"><span>或粘贴 M3U / M3U8 / TXT 内容</span>'
    + '<textarea data-iptv="text" placeholder="#EXTM3U&#10;#EXTINF:-1 group-title=&quot;央视&quot;,CCTV1&#10;http://...">'
    + esc(state.iptvText) + '</textarea></div>'
    + '<div><span>本地文件</span><br><input type="file" data-iptv="file" accept=".m3u,.m3u8,.txt"></div>'
    + '</div>'
    + '<div class="toolbar">'
    + '<button class="primary" data-iptv="parse">解析并写入配置</button>'
    + '<button class="ghost" data-iptv="fetch">从 URL 抓取并解析</button>'
    + '<button class="ghost" data-iptv="clear">清空频道</button>'
    + '</div>'
    + '<p class="hint">支持标准 M3U / M3U Plus（group-title、tvg-logo）与 TXT genre'
    + '（分组,#genre# + 名称,url，多线路用 # 分隔）。按地址去重，仅保留'
    + ' http/https/rtmp/rtsp/udp/mms/p2p，最多 3000 条。'
    + '跨域抓取受浏览器 CORS 限制，失败时请改用本地文件或粘贴内容。'
    + '解析结果只写进当前配置对象，点「保存到云端」才真正下发。</p>'
    + textField('iptv.epgUrl', 'EPG 地址（可选，http/https）', 'text')
    + '<p><strong>当前 ' + list.length + ' 个频道 / ' + (iptv.groups || []).length + ' 个分组</strong></p>'
    + (state.iptvSummary ? '<p class="hint">' + esc(state.iptvSummary) + '</p>' : '')
    + '<div class="preview-list">' + (preview || '<p class="muted">暂无频道</p>') + '</div>';
}

function renderDevices() {
  const rows = state.devices.map((d) =>
    '<tr><td><input data-device-alias="' + esc(d.id) + '" value="' + esc(d.alias || '')
    + '" placeholder="未命名"></td>'
    + '<td><code>' + esc(d.id) + '</code></td>'
    + '<td>' + esc(d.appVersion || '—') + '</td>'
    + '<td>' + esc(d.firstSeen || '—') + '</td>'
    + '<td>' + esc(d.lastSeen || '—') + '</td>'
    + '<td>r' + esc(d.revision) + '</td>'
    + '<td><button class="tiny" data-device="rename" data-id="' + esc(d.id) + '">改名</button> '
    + '<button class="tiny" data-device="edit" data-id="' + esc(d.id) + '">编辑配置</button> '
    + '<button class="tiny" data-device="reset" data-id="' + esc(d.id) + '">重置为模板</button> '
    + '<button class="tiny" data-device="delete" data-id="' + esc(d.id) + '">移除</button></td></tr>').join('');
  return '<h2>上线终端</h2>'
    + '<p class="hint">终端每次启动拉取配置时自动登记；「上线」= 最后一次成功拉取，'
    + '不额外发送心跳。每台终端保存一份<b>完整独立</b>的配置：新设备首次上线会复制当前'
    + '全局模板，之后改全局模板<b>不会</b>影响已登记的设备。要批量生效，请逐台编辑，'
    + '或对设备执行「重置为模板」（会生成一个新 revision）。</p>'
    + '<table class="device-table"><thead><tr><th>别名</th><th>设备 ID</th><th>App 版本</th>'
    + '<th>首次上线</th><th>最后上线</th><th>版本</th><th>操作</th></tr></thead><tbody>'
    + (rows || '<tr><td colspan="7">还没有终端上线。安装并打开一次 App 即会出现在这里。</td></tr>')
    + '</tbody></table>';
}

async function refreshDevices() {
  try {
    const data = await request('/api/devices');
    state.devices = data.devices || [];
    renderDeviceSelect();
    if (state.activeTab === 'devices') renderPanel();
  } catch (error) {
    message('读取终端列表失败：' + error.message, 'err');
  }
}

async function deviceAction(action, id) {
  const body = { action, deviceId: id };
  if (action === 'rename') {
    const input = document.querySelector('[data-device-alias="' + id + '"]');
    body.alias = input ? input.value.trim() : '';
  }
  if (action === 'delete' && !window.confirm('移除设备 ' + id + '？该设备的配置仍保留，重新上线会再次出现。')) return;
  if (action === 'reset' && !window.confirm('把设备 ' + id + ' 的配置重置为当前全局模板？此操作会生成新 revision。')) return;
  try {
    await request('/api/devices', {
      write: true, method: 'POST', body: JSON.stringify(body),
    });
    toast('操作成功');
    await refreshDevices();
    if (action === 'reset' && state.deviceId === id) await load();
  } catch (error) {
    message('操作失败：' + error.message, 'err');
  }
}

async function fetchIptvUrl() {
  const box = document.querySelector('[data-iptv="urls"]');
  const url = (box ? box.value : '').split('\n').map((x) => x.trim()).filter(Boolean)[0];
  if (!url) { message('请先在「订阅地址」里填一个 http(s) 地址', 'err'); return; }
  try {
    const response = await fetch(url, { headers: { Accept: '*/*' } });
    if (!response.ok) throw new Error('HTTP ' + response.status);
    const text = await response.text();
    state.iptvText = text;
    applyPlaylist(text, url);
  } catch (error) {
    message('抓取失败：' + error.message
      + '\n\n多半是源站未开放跨域（CORS）。请下载后用「本地文件」导入，或直接粘贴内容。', 'err');
  }
}

function onIptvAction(button) {
  const kind = button.dataset.iptv;
  if (kind === 'parse') {
    const box = document.querySelector('[data-iptv="text"]');
    const text = box ? box.value : '';
    state.iptvText = text;
    if (!text.trim()) { message('请先粘贴内容或选择本地文件', 'err'); return; }
    applyPlaylist(text, '');
  } else if (kind === 'fetch') {
    fetchIptvUrl();
  } else if (kind === 'clear') {
    const iptv = iptvSection();
    iptv.channels = [];
    iptv.groups = [];
    iptv.sources = [];
    state.iptvSummary = '已清空频道列表，保存后终端将不再收到云端 IPTV 配置。';
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
  }
}

function render() {
  $('revBadge').textContent = 'revision ' + (state.doc ? state.revision : '—');
  $('devBadge').hidden = !state.devMode;
  $('btnSave').disabled = !state.doc || !state.dirty;
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
  $('apiBase').value = localStorage.getItem('purelive_config_base') || '';
  $('apiToken').value = localStorage.getItem('purelive_config_token') || '';
  $('apiWriteToken').value = localStorage.getItem('purelive_config_write_token') || '';

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
    const deviceButton = event.target.closest('button[data-device]');
    if (!deviceButton) return;
    const id = deviceButton.dataset.id;
    const action = deviceButton.dataset.device;
    if (action === 'edit') {
      state.deviceId = id;
      renderDeviceSelect();
      load();
    } else {
      deviceAction(action, id);
    }
  });

  $('panel').addEventListener('change', (event) => {
    const target = event.target;
    if (!state.doc) return;
    if (target.dataset.iptv === 'file') {
      const file = target.files && target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        state.iptvText = String(reader.result || '');
        const box = document.querySelector('[data-iptv="text"]');
        if (box) box.value = state.iptvText;
        applyPlaylist(state.iptvText, '');
      };
      reader.onerror = () => message('文件读取失败', 'err');
      reader.readAsText(file, 'UTF-8');
      return;
    }
    if (target.dataset.iptv === 'urls') {
      const urls = target.value.split('\n').map((x) => x.trim())
        .filter((x) => /^https?:\/\//i.test(x)).slice(0, 20);
      iptvSection().sources = urls;
      markDirty();
    }
  });

  $('message').addEventListener('click', (event) => {
    const button = event.target.closest('button[data-conflict]');
    if (button && button.dataset.conflict === 'reload') load();
  });

  render();
});
