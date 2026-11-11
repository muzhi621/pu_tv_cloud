/* 纯粹直播 TV · 云端配置编辑器（零依赖，直接由配置服务同源托管） */
'use strict';

const state = {
  base: '',
  token: '',
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

function headers(extra) {
  const base = { 'Content-Type': 'application/json' };
  if (state.token) base.Authorization = 'Bearer ' + state.token;
  return Object.assign(base, extra || {});
}

async function request(path, options) {
  const opts = options || {};
  const url = state.base.replace(/\/$/, '') + path;
  const response = await fetch(url, {
    method: opts.method || 'GET',
    headers: headers(opts.headers),
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

function renderPanel() {
  if (!state.doc) {
    $('panel').innerHTML = '<p class="muted">请先点击右上角「连接并加载」。</p>';
    return;
  }
  const renderers = { sites: renderSites, navigation: renderNavigation, startup: renderStartup, update: renderUpdate };
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
  localStorage.setItem('purelive_config_base', state.base);
  localStorage.setItem('purelive_config_token', state.token);
  statusText('正在连接…');
  try {
    const health = await request('/health');
    state.devMode = !!health.devMode;
    const [doc, catalog] = await Promise.all([
      request('/api/config'),
      request('/api/config/catalog'),
    ]);
    state.doc = doc;
    state.original = clone(doc);
    state.catalog = catalog;
    state.revision = doc.revision;
    state.dirty = false;
    state.extraMode = null;
    statusText('已连接（schemaVersion ' + doc.schemaVersion + '）');
    render();
    toast('配置加载成功');
  } catch (error) {
    statusText('连接失败');
    message('加载失败：' + error.message, 'err');
  }
}

async function save() {
  if (!state.doc || !state.dirty) return;
  clearMessage();
  $('btnSave').disabled = true;
  try {
    const result = await request('/api/config', {
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
      message('保存失败：' + error.message, 'err');
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

  $('message').addEventListener('click', (event) => {
    const button = event.target.closest('button[data-conflict]');
    if (button && button.dataset.conflict === 'reload') load();
  });

  render();
});
