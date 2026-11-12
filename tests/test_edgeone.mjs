/**
 * EdgeOne Edge Functions 版配置服务的离线冒烟测试。
 *
 * 不依赖 EdgeOne 账号或部署：用内存 KV 模拟平台注入的全局变量 PURETV_KV，
 * 直接调用各路由的 onRequest* handler（Node 18+ 自带 Request/Response）。
 * 覆盖与 cloud/app.py 相同的契约：ETag/304、If-Match/409、鉴权、规范化、
 * 快照/回滚、编辑器页面。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { onRequestGet as configGet, onRequestPut as configPut } from '../edge-functions/api/config/index.js';
import { onRequestGet as catalogGet } from '../edge-functions/api/config/catalog.js';
import { onRequestGet as revisionsGet } from '../edge-functions/api/config/revisions.js';
import { onRequestPost as rollbackPost } from '../edge-functions/api/config/rollback.js';
import { onRequestGet as healthGet } from '../edge-functions/health.js';
import { onRequestGet as devicesGet, onRequestPost as devicesPost } from '../edge-functions/api/devices/index.js';
import {
  onRequestGet as editorGet, preloadDefaults, injectDefaults,
} from '../edge-functions/index.js';
import {
  normalizeDocument, normalizeSections, expandIptvChannels, viewDocument,
} from '../edge-functions/_lib/contract.js';
import { optionsHandler } from '../edge-functions/_lib/http.js';
import { listDevices as storageListDevices } from '../edge-functions/_lib/storage.js';
import {
  onRequestPost as iptvFetchPost, checkFetchUrl, decodeSubscription,
} from '../edge-functions/api/iptv/fetch.js';

class MemoryKV {
  constructor() { this.map = new Map(); }
  async get(key, type) {
    const value = this.map.get(key);
    if (value === undefined) return null;
    return type === 'json' ? JSON.parse(value) : value;
  }
  async put(key, value) { this.map.set(key, String(value)); }
  async delete(key) { this.map.delete(key); }
  async list() { return { complete: true, cursor: null, keys: [] }; }
}

const kv = new MemoryKV();
globalThis.PURETV_KV = kv;

const BASE = 'https://config.example.com';
function ctx(method, path, { headers, body, env } = {}) {
  return {
    request: new Request(BASE + path, {
      method,
      headers: headers || {},
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    env: env || {},
  };
}
const json = async (response) => JSON.parse(await response.text());

test('EdgeOne 配置服务完整流程', async (t) => {
  await t.test('health 无需鉴权，返回 KV 后端与 devMode', async () => {
    const res = await healthGet(ctx('GET', '/health'));
    assert.equal(res.status, 200);
    const data = await json(res);
    assert.equal(data.status, 'ok');
    assert.equal(data.backend, 'edgeone-kv');
    assert.equal(data.revision, 0);
    assert.equal(data.devMode, true);
  });

  await t.test('GET /api/config 返回 seed 文档与版本头', async () => {
    const res = await configGet(ctx('GET', '/api/config'));
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('ETag'), '"0"');
    assert.equal(res.headers.get('X-Revision'), '0');
    assert.equal(res.headers.get('X-Schema-Version'), '1');
    const doc = await json(res);
    assert.equal(doc.schemaVersion, 1);
    assert.equal(doc.revision, 0);
    assert.deepEqual(Object.keys(doc.sections).sort(),
      ['iptv', 'navigation', 'sites', 'startup', 'update']);
  });

  await t.test('since / If-None-Match 命中返回 304', async () => {
    const a = await configGet(ctx('GET', '/api/config?since=0'));
    assert.equal(a.status, 304);
    assert.equal(a.headers.get('ETag'), '"0"');
    const b = await configGet(ctx('GET', '/api/config', { headers: { 'If-None-Match': '"0"' } }));
    assert.equal(b.status, 304);
  });

  await t.test('PUT 缺少 If-Match 返回 400', async () => {
    const res = await configPut(ctx('PUT', '/api/config', { body: { sections: { sites: { managed: true } } } }));
    assert.equal(res.status, 400);
    assert.equal((await json(res)).error, 'invalid_config');
  });

  await t.test('PUT 写入、过滤未知 id、返回 warnings', async () => {
    const res = await configPut(ctx('PUT', '/api/config', {
      headers: { 'If-Match': '0' },
      body: {
        sections: {
          sites: { managed: true, enabledSiteIds: ['bilibili', 'not_a_site', 'douyu'] },
          navigation: { managed: true, railMenuIds: ['favorite', 'hot'] },
        },
      },
    }));
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('X-Revision'), '1');
    const data = await json(res);
    assert.equal(data.revision, 1);
    assert.equal(data.devMode, true);
    assert.ok(data.warnings.some((line) => line.includes('not_a_site')));
    const doc = await json(await configGet(ctx('GET', '/api/config')));
    assert.equal(doc.sections.sites.enabledSiteIds.join(','), 'bilibili,douyu');
    assert.equal(doc.sections.sites.managed, true);
    assert.deepEqual(doc.sections.navigation.railMenuIds, ['favorite', 'hot']);
  });

  await t.test('驼峰菜单 id（favoriteAreas/moviePlayback）不被小写化误杀', async () => {
    // 回归：客户端 AppMenuItem 用的是驼峰 id，服务端曾统一转小写比对，
    // 导致这两项被判为未知 id 而丢弃，开启导航管控后电视上直接少两个菜单。
    const [sections, warnings] = normalizeSections({
      navigation: {
        managed: true,
        railMenuIds: ['favorite', 'favoriteAreas', 'moviePlayback', 'search'],
      },
    });
    assert.deepEqual(sections.navigation.railMenuIds,
      ['favorite', 'favoriteAreas', 'moviePlayback', 'search']);
    assert.equal(warnings.length, 0);
  });

  await t.test('大小写不敏感匹配，但写回 catalog 里的原始 id', async () => {
    const [sections] = normalizeSections({
      navigation: { railMenuIds: ['favoriteareas', 'MOVIEPLAYBACK'] },
    });
    assert.deepEqual(sections.navigation.railMenuIds, ['favoriteAreas', 'moviePlayback']);
  });

  await t.test('revision 冲突返回 409 并带回当前文档', async () => {
    const res = await configPut(ctx('PUT', '/api/config', {
      headers: { 'If-Match': '0' },
      body: { sections: { sites: { managed: false } } },
    }));
    assert.equal(res.status, 409);
    const data = await json(res);
    assert.equal(data.error, 'revision_conflict');
    assert.equal(data.currentRevision, 1);
    assert.equal(data.document.revision, 1);
  });

  await t.test('revisions 列出快照，rollback 生成新 revision', async () => {
    const list = await json(await revisionsGet(ctx('GET', '/api/config/revisions?limit=5')));
    assert.ok(list.revisions.length >= 1);
    assert.equal(list.revisions[0].revision, 1);
    assert.ok(list.revisions[0].size > 0);

    const res = await rollbackPost(ctx('POST', '/api/config/rollback', { body: { revision: 1 } }));
    assert.equal(res.status, 200);
    const data = await json(res);
    assert.equal(data.revision, 2);
    assert.equal(data.rolledBackFrom, 1);
    const doc = await json(await configGet(ctx('GET', '/api/config')));
    assert.equal(doc.revision, 2);
    assert.equal(doc.sections.sites.enabledSiteIds.join(','), 'bilibili,douyu');
  });

  await t.test('回滚不存在的快照返回 400', async () => {
    const res = await rollbackPost(ctx('POST', '/api/config/rollback', { body: { revision: 999 } }));
    assert.equal(res.status, 400);
    assert.equal((await json(res)).error, 'invalid_config');
  });

  await t.test('catalog 返回站点与菜单目录', async () => {
    const res = await catalogGet(ctx('GET', '/api/config/catalog'));
    assert.equal(res.status, 200);
    const data = await json(res);
    assert.equal(data.sites.length, 35);
    assert.equal(data.menus.length, 8);
    assert.ok(data.menus.some((item) => item.id === 'iptv'));
    assert.deepEqual(data.updatePrompts, ['silent', 'dialog', 'force']);
  });

  await t.test('编辑器首页内联 CSS/JS，无外部静态引用', async () => {
    const res = await editorGet(ctx('GET', '/'));
    assert.equal(res.status, 200);
    assert.match(res.headers.get('Content-Type'), /text\/html/);
    const html = await res.text();
    assert.match(html, /<style>/);
    assert.match(html, /apiBase/);
    assert.ok(!html.includes('href="/style.css"'));
    assert.ok(!html.includes('src="/app.js"'));
  });

  await t.test('读/写 token 分离，缺失或错误 token 返回 401', async () => {
    const env = { CONFIG_READ_TOKEN: 'read-secret', CONFIG_WRITE_TOKEN: 'write-secret' };
    const anonymous = await configGet(ctx('GET', '/api/config', { env }));
    assert.equal(anonymous.status, 401);
    const readOnly = await configPut(ctx('PUT', '/api/config', {
      env,
      headers: { Authorization: 'Bearer read-secret', 'If-Match': '2' },
      body: { sections: { sites: { managed: true } } },
    }));
    assert.equal(readOnly.status, 401);
    const ok = await configGet(ctx('GET', '/api/config', {
      env, headers: { Authorization: 'Bearer read-secret' },
    }));
    assert.equal(ok.status, 200);
    const write = await configPut(ctx('PUT', '/api/config', {
      env,
      headers: { Authorization: 'Bearer write-secret', 'If-Match': '2' },
      body: { sections: { sites: { managed: true } } },
    }));
    assert.equal(write.status, 200);
  });

  await t.test('CORS 预检仅在配置来源时返回 204', async () => {
    const disabled = await optionsHandler(ctx('OPTIONS', '/api/config', { env: {} }));
    assert.equal(disabled.status, 405);
    const enabled = await optionsHandler(ctx('OPTIONS', '/api/config', {
      env: { CONFIG_CORS_ORIGINS: 'https://admin.example.com' },
      headers: { Origin: 'https://admin.example.com' },
    }));
    assert.equal(enabled.status, 204);
    assert.equal(enabled.headers.get('Access-Control-Allow-Origin'), 'https://admin.example.com');
  });

  await t.test('规范化：空列表兜底、类型错误、未知节', async () => {
    const [empty, emptyWarnings] = normalizeSections({ sites: { enabledSiteIds: [] } });
    assert.equal(empty.sites.enabledSiteIds.length, 35);
    assert.ok(emptyWarnings.some((line) => line.includes('回退内置全量')));

    assert.throws(() => normalizeSections({ sites: { managed: 'yes' } }), /必须是布尔值/);
    const [, unknownWarnings] = normalizeSections({ futureSection: { foo: 1 } });
    assert.ok(unknownWarnings.some((line) => line.includes('忽略未知节')));

    const [doc] = normalizeDocument({ schemaVersion: 1, revision: 7, sections: {} });
    assert.equal(doc.revision, 7);
    assert.equal(doc.schemaVersion, 1);
    assert.throws(() => normalizeDocument({ schemaVersion: 2, sections: {} }), /不支持的 schemaVersion/);
  });

  await t.test('KV 键名符合平台限制（字母数字下划线）', () => {
    for (const key of kv.map.keys()) {
      assert.match(key, /^[A-Za-z0-9_]+$/, `非法 KV key: ${key}`);
    }
    assert.ok(kv.map.has('config_current'));
    assert.ok(kv.map.has('config_revisions'));
    assert.ok(kv.map.has('config_snapshot_00000001'));
  });
});

/** 模拟 @edgeone/pages-blob 的 Store：get(key,{type}) / set(key,value)。 */
class MemoryBlob {
  constructor() { this.map = new Map(); }
  async get(key, options = {}) {
    const value = this.map.get(key);
    if (value === undefined) return null;
    return options.type === 'json' ? JSON.parse(value) : value;
  }
  async set(key, value) { this.map.set(key, String(value)); }
  async delete(key) { this.map.delete(key); }
}

test('KV 缺失时自动回退 Blob 后端', async (t) => {
  const blob = new MemoryBlob();
  const savedKv = globalThis.PURETV_KV;
  delete globalThis.PURETV_KV;
  globalThis.__PURETV_BLOB_STORE__ = blob;
  t.after(() => {
    globalThis.PURETV_KV = savedKv;
    delete globalThis.__PURETV_BLOB_STORE__;
  });

  await t.test('health 报告 edgeone-blob 并写入 seed', async () => {
    const res = await healthGet(ctx('GET', '/health'));
    assert.equal(res.status, 200);
    const data = await json(res);
    assert.equal(data.status, 'ok');
    assert.equal(data.backend, 'edgeone-blob');
    assert.equal(data.revision, 0);
    assert.ok(blob.map.has('config_current'), '首个请求应把 seed 落盘到 Blob');
  });

  await t.test('读写往返：ETag、304、If-Match 冲突、快照与回滚', async () => {
    const first = await json(await configGet(ctx('GET', '/api/config')));
    assert.equal(first.revision, 0);

    const put = await configPut(ctx('PUT', '/api/config', {
      headers: { 'If-Match': '0' },
      body: { sections: { sites: { managed: true, policy: 'whitelist', enabledSiteIds: ['bilibili', 'huya'] } } },
    }));
    assert.equal(put.status, 200);
    assert.equal(put.headers.get('X-Revision'), '1');

    // 强一致读：Blob 后端必须立刻看到新 revision
    const fresh = await configGet(ctx('GET', '/api/config'));
    const doc = await json(fresh);
    assert.equal(doc.revision, 1);
    assert.deepEqual(doc.sections.sites.enabledSiteIds, ['bilibili', 'huya']);

    const notModified = await configGet(ctx('GET', '/api/config?since=1'));
    assert.equal(notModified.status, 304);

    const conflict = await configPut(ctx('PUT', '/api/config', {
      headers: { 'If-Match': '0' },
      body: { sections: {} },
    }));
    assert.equal(conflict.status, 409);

    assert.ok(blob.map.has('config_snapshot_00000001'), '应写入不可变快照');
    assert.ok(blob.map.has('config_revisions'));

    const list = await json(await revisionsGet(ctx('GET', '/api/config/revisions')));
    assert.equal(list.revisions[0].revision, 1);

    const rollback = await rollbackPost(ctx('POST', '/api/config/rollback', {
      headers: { 'If-Match': '1' },
      body: { revision: 1 },
    }));
    assert.equal(rollback.status, 200);
    assert.equal((await json(rollback)).revision, 2);
  });

  await t.test('Blob 键名同样符合平台限制', () => {
    for (const key of blob.map.keys()) {
      assert.match(key, /^[A-Za-z0-9_]+$/);
    }
  });
});

test('无任何存储时给出 503 + 可执行提示', async (t) => {
  const savedKv = globalThis.PURETV_KV;
  delete globalThis.PURETV_KV;
  t.after(() => { globalThis.PURETV_KV = savedKv; });

  const res = await configGet(ctx('GET', '/api/config', { env: { CONFIG_STORAGE: 'kv' } }));
  assert.equal(res.status, 503);
  const data = await json(res);
  assert.equal(data.error, 'storage_unavailable');
  assert.match(data.hint, /PURETV_KV/);
  assert.match(data.hint, /pages-blob/);

  const health = await json(await healthGet(ctx('GET', '/health', { env: { CONFIG_STORAGE: 'kv' } })));
  assert.equal(health.status, 'degraded');
  assert.equal(health.backend, 'none');
  assert.ok(health.storageError);
});

test('每设备完整独立配置与设备注册表', async (t) => {
  const savedKv = globalThis.PURETV_KV;
  const fresh = new MemoryKV();
  globalThis.PURETV_KV = fresh;
  t.after(() => { globalThis.PURETV_KV = savedKv; });

  const env = {};
  const put = (deviceId, sections, revision) => configPut(ctx('PUT',
    `/api/config?deviceId=${deviceId}`, {
      env, headers: { 'If-Match': String(revision), 'Content-Type': 'application/json' },
      body: { sections },
    }));
  const get = (deviceId) => configGet(ctx('GET',
    deviceId ? `/api/config?deviceId=${deviceId}` : '/api/config', { env }));

  await t.test('新设备首次拉取自动复制全局模板，revision 从 1 起（避免 since=0 命中 304）', async () => {
    const global = await json(await get(null));
    assert.equal(global.revision, 0);
    const device = await json(await get('tv-living-room'));
    assert.equal(device.revision, 1);
    assert.deepEqual(device.sections, global.sections);
  });

  await t.test('设备 A 的修改不影响全局模板与设备 B', async () => {
    const res = await put('tv-living-room', { sites: { managed: true, enabledSiteIds: ['bilibili'] } }, 1);
    assert.equal(res.status, 200);
    const global = await json(await get(null));
    assert.equal(global.revision, 0);
    assert.equal(global.sections.sites.managed, false);
    const a = await json(await get('tv-living-room'));
    assert.equal(a.revision, 2);
    assert.deepEqual(a.sections.sites.enabledSiteIds, ['bilibili']);
    const b = await json(await get('tv-bedroom'));
    assert.equal(b.revision, 1);
    assert.equal(b.sections.sites.managed, false);
  });

  await t.test('非法 deviceId 返回 400，不写入任何键', async () => {
    const res = await configGet(ctx('GET', '/api/config?deviceId=bad/id', { env }));
    assert.equal(res.status, 400);
    assert.equal([...fresh.map.keys()].some((k) => k.includes('bad')), false);
  });

  await t.test('设备列表记录上线信息，可改别名与重置', async () => {
    const list = await json(await devicesGet(ctx('GET', '/api/devices', { env })));
    assert.equal(list.total, 2);
    assert.ok(list.devices.some((d) => d.id === 'tv-living-room' && d.revision === 2));
    assert.ok(list.devices.every((d) => d.firstSeen && d.lastSeen));

    const renamed = await json(await devicesPost(ctx('POST', '/api/devices', {
      env, headers: { 'Content-Type': 'application/json' },
      body: { action: 'rename', deviceId: 'tv-living-room', alias: '客厅电视' },
    })));
    assert.equal(renamed.results[0].device.alias, '客厅电视');

    const reset = await json(await devicesPost(ctx('POST', '/api/devices', {
      env, headers: { 'Content-Type': 'application/json' },
      body: { action: 'reset', deviceId: 'tv-living-room' },
    })));
    assert.equal(reset.results[0].revision, 3);
    const after = await json(await get('tv-living-room'));
    assert.equal(after.sections.sites.managed, false);
  });

  await t.test('历史与回滚按设备隔离', async () => {
    const a = await json(await revisionsGet(ctx('GET',
      '/api/config/revisions?deviceId=tv-living-room', { env })));
    assert.ok(a.revisions.length >= 2);
    const b = await json(await revisionsGet(ctx('GET',
      '/api/config/revisions?deviceId=tv-bedroom', { env })));
    assert.equal(b.revisions.length, 0);
  });
});

test('IPTV 节：解析结果校验、去重与协议白名单', async (t) => {
  const [sections, warnings] = normalizeSections({ iptv: {
    managed: true,
    sources: ['https://example.com/list.m3u', 'ftp://bad'],
    groups: ['央视', '卫视'],
    channels: [
      { name: 'CCTV1', url: 'http://a.example.com/1.ts', group: '央视' },
      { name: '重复', url: 'HTTP://A.EXAMPLE.COM/1.TS', group: '央视' },
      { name: '坏协议', url: 'javascript:alert(1)' },
      { name: 'RTMP', url: 'rtmp://live.example.com/x', group: '卫视' },
    ],
  } });
  assert.equal(sections.iptv.managed, true);
  assert.equal(sections.iptv.channels.length, 2);
  assert.equal(sections.iptv.channels[1].url, 'rtmp://live.example.com/x');
  assert.deepEqual(sections.iptv.groups, ['央视', '卫视']);
  assert.deepEqual(sections.iptv.sources, ['https://example.com/list.m3u']);
  assert.ok(warnings.some((w) => w.includes('非 http(s)')));

  await t.test('channels 非数组直接 400', () => {
    assert.throws(() => normalizeSections({ iptv: { channels: 'oops' } }), /必须是数组/);
  });
});

test('编辑器连接信息由环境变量注入，且不写进仓库文件', async (t) => {
  const env = { CONFIG_READ_TOKEN: 'READ-TOKEN', CONFIG_WRITE_TOKEN: 'WRITE-TOKEN' };
  const req = new Request('https://tv.example.com/');

  await t.test('预填值与自动连接开关', () => {
    const defaults = preloadDefaults(env, req);
    assert.equal(defaults.base, 'https://tv.example.com');
    assert.equal(defaults.readToken, 'READ-TOKEN');
    assert.equal(defaults.writeToken, 'WRITE-TOKEN');
    assert.equal(defaults.autoConnect, true);
    assert.equal(preloadDefaults({ ...env, CONFIG_EDITOR_PRELOAD: '0' }, req), null);
    assert.equal(preloadDefaults({}, req), null);
  });

  await t.test('注入脚本转义 < ，不会闭合 script 标签', () => {
    const html = injectDefaults('<html><head></head><body></body></html>',
      { base: 'https://x', readToken: '</script><script>alert(1)', writeToken: 'W' });
    assert.match(html, /window\.__PURETV_DEFAULTS__/);
    assert.ok(!html.includes('</script><script>alert(1)'));
    assert.match(html, /\\u003c\/script/);
  });

  await t.test('带令牌环境变量的页面含默认值，未配置时不含', async () => {
    const withDefaults = await (await editorGet(ctx('GET', '/', { env }))).text();
    assert.match(withDefaults, /window\.__PURETV_DEFAULTS__/);
    assert.match(withDefaults, /READ-TOKEN/);
    assert.match(withDefaults, /WRITE-TOKEN/);
    const plain = await (await editorGet(ctx('GET', '/'))).text();
    // app.js 源码里本来就有读取 window.__PURETV_DEFAULTS__ 的代码，
    // 所以只能断言「没有注入赋值语句、也没有令牌值」。
    assert.ok(!plain.includes('window.__PURETV_DEFAULTS__={'));
    assert.ok(!plain.includes('READ-TOKEN'));
  });
});

test('IPTV 云端代理：SSRF 防护、编码识别与失败隔离', async (t) => {
  await t.test('拒绝内网 / 环回 / 危险端口 / 非 http(s) 地址', () => {
    const blocked = [
      'http://127.0.0.1/x', 'http://192.168.1.1/list.m3u', 'http://10.0.0.5/x',
      'http://172.20.1.1/x', 'http://169.254.169.254/latest/meta-data',
      'http://localhost/x', 'http://nas.local/list.m3u', 'http://[::1]/x',
      'http://[fc00::1]/x', 'ftp://example.com/x', 'javascript:alert(1)',
      'http://user:pw@example.com/x', 'http://example.com:6379/x', 'http://intranet/x',
    ];
    for (const url of blocked) {
      assert.equal(checkFetchUrl(url).ok, false, `${url} 应被拒绝`);
    }
    assert.equal(checkFetchUrl('https://example.com/list.m3u').ok, true);
    assert.equal(checkFetchUrl('http://example.com:8080/a.txt').ok, true);
  });

  await t.test('UTF-8 与 GBK 自动识别', () => {
    assert.deepEqual(decodeSubscription(new TextEncoder().encode('#EXTM3U\n央视')),
      { text: '#EXTM3U\n央视', encoding: 'utf-8' });
    const gbk = decodeSubscription(new Uint8Array([0xD1, 0xEB, 0xCA, 0xD3]));
    assert.equal(gbk.encoding, 'gbk');
    assert.equal(gbk.text, '央视');
  });

  await t.test('单个地址失败不影响整批响应', async () => {
    const res = await iptvFetchPost(ctx('POST', '/api/iptv/fetch', {
      headers: { 'Content-Type': 'application/json' },
      body: { urls: ['http://127.0.0.1/x', 'ftp://bad/x'] },
    }));
    assert.equal(res.status, 200);
    const data = await json(res);
    assert.equal(data.total, 2);
    assert.equal(data.succeeded, 0);
    assert.ok(data.results.every((item) => item.ok === false));
    assert.ok(!('text' in data.results[0]));
  });
});

test('IPTV 套餐：组成套餐、按设备选择下发、GET 轻量视图', async (t) => {
  const savedKv = globalThis.PURETV_KV;
  const fresh = new MemoryKV();
  globalThis.PURETV_KV = fresh;
  t.after(() => { globalThis.PURETV_KV = savedKv; });
  const env = {};
  const channelsA = [
    { name: 'CCTV1', url: 'http://a.example.com/1.ts', group: '央视' },
    { name: 'CCTV2', url: 'http://a.example.com/2.ts', group: '央视' },
  ];
  const channelsB = [
    { name: 'CCTV1-replay', url: 'http://a.example.com/1.ts', group: '央视' },
    { name: 'Hunan', url: 'rtmp://b.example.com/live', group: '卫视' },
  ];
  const sections = {
    iptv: {
      managed: true,
      packages: [
        { id: 'p1', name: '央视', sources: ['https://example.com/a.m3u'], channels: channelsA },
        { id: 'p2', name: '卫视', channels: channelsB },
        { id: 'BAD ID', name: '非法', channels: [] },
      ],
      selectedPackageIds: ['p1', 'p2', 'missing'],
      channels: [{ name: '旧', url: 'http://old.example.com/x.ts' }],
    },
  };

  await t.test('非法套餐被忽略，选中套餐时顶层 channels 不重复存储', () => {
    const [normalized, warnings] = normalizeSections(sections);
    assert.equal(normalized.iptv.packages.length, 2);
    assert.deepEqual(normalized.iptv.selectedPackageIds, ['p1', 'p2']);
    assert.deepEqual(normalized.iptv.channels, []);
    assert.ok(warnings.some((w) => w.includes('不存在的套餐')));
  });

  await t.test('按选中套餐顺序合并、URL 去重、重算分组', () => {
    const [normalized] = normalizeSections(sections);
    const expanded = expandIptvChannels(normalized);
    assert.equal(expanded.iptv.channels.length, 3);
    assert.equal(expanded.iptv.channels[0].name, 'CCTV1');
    assert.deepEqual(expanded.iptv.groups, ['央视', '卫视']);
    assert.equal(normalized.iptv.channels.length, 0); // 深拷贝，不污染入参
  });

  await t.test('端到端：终端只拿轻量文档，编辑器带 withPackages 拿完整套餐库', async () => {
    const putRes = await configPut(ctx('PUT', '/api/config', {
      env, headers: { 'If-Match': '0', 'Content-Type': 'application/json' },
      body: { sections },
    }));
    assert.equal(putRes.status, 200);

    const terminal = await json(await configGet(ctx('GET', '/api/config', { env })));
    assert.equal(terminal.sections.iptv.channels.length, 3);
    assert.equal(terminal.sections.iptv.packages.length, 2);
    assert.equal(terminal.sections.iptv.packages[0].channelCount, 2);
    assert.ok(!('channels' in terminal.sections.iptv.packages[0]));
    assert.ok(terminal.sections.iptv.channels.some((c) => c.url === 'http://a.example.com/2.ts'));

    const editor = await json(await configGet(ctx('GET', '/api/config?withPackages=1', { env })));
    assert.equal(editor.sections.iptv.packages[0].channels.length, 2);
    assert.equal(editor.sections.iptv.channels.length, 3);
  });
});

test('终端在线状态、软删除 / 拉黑 / 解绑与显式下发', async (t) => {
  const savedKv = globalThis.PURETV_KV;
  const fresh = new MemoryKV();
  globalThis.PURETV_KV = fresh;
  t.after(() => { globalThis.PURETV_KV = savedKv; });
  const env = { CONFIG_ONLINE_WINDOW_MINUTES: 30 };
  const post = (body) => devicesPost(ctx('POST', '/api/devices', {
    env, headers: { 'Content-Type': 'application/json' }, body,
  }));
  const list = () => devicesGet(ctx('GET', '/api/devices', { env })).then(json);

  await t.test('上线登记、在线状态与超时兜底', async () => {
    await configGet(ctx('GET', '/api/config?deviceId=tv-a', { env }));
    const data = await list();
    assert.equal(data.total, 1);
    assert.equal(data.online, 1);
    assert.equal(data.onlineWindowMinutes, 30);
    assert.equal(data.devices[0].status, 'online');
    assert.ok(data.devices[0].lastSeenAgo <= 2);
    const later = await storageListDevices(env, Date.now() + 31 * 60 * 1000);
    assert.equal(later[0].status, 'offline');
  });

  await t.test('显式下发即使无改动也生成新 revision', async () => {
    const before = (await list()).devices[0].revision;
    const pushed = await json(await post({ action: 'push', deviceId: 'tv-a' }));
    assert.equal(pushed.results[0].ok, true);
    assert.equal(pushed.results[0].revision, before + 1);
    assert.ok(pushed.results[0].pushedAt);
    assert.equal((await list()).devices[0].pushedRevision, before + 1);
  });

  await t.test('软删除仍保留设备，可恢复', async () => {
    const removed = await json(await post({ action: 'delete', deviceId: 'tv-a' }));
    assert.equal(removed.results[0].hidden, true);
    assert.equal((await list()).total, 1);
    const restored = await json(await post({ action: 'restore', deviceId: 'tv-a' }));
    assert.equal(restored.results[0].hidden, false);
  });

  await t.test('彻底删除并拉黑：终端 403，解绑后恢复', async () => {
    const purged = await json(await post({ action: 'purge', deviceId: 'tv-a' }));
    assert.equal(purged.results[0].purged, true);
    const data = await list();
    assert.equal(data.total, 0);
    assert.deepEqual(data.blocked, ['tv-a']);
    const denied = await configGet(ctx('GET', '/api/config?deviceId=tv-a', { env }));
    assert.equal(denied.status, 403);
    assert.equal((await json(denied)).error, 'device_blocked');
    await post({ action: 'unblock', deviceId: 'tv-a' });
    assert.equal((await configGet(ctx('GET', '/api/config?deviceId=tv-a', { env }))).status, 200);
    assert.equal((await list()).total, 1);
  });

  await t.test('批量操作多台设备', async () => {
    await configGet(ctx('GET', '/api/config?deviceId=tv-b', { env }));
    const bulk = await json(await post({ action: 'delete', deviceIds: ['tv-a', 'tv-b'] }));
    assert.equal(bulk.total, 2);
    assert.equal(bulk.failed, 0);
    assert.ok((await list()).devices.every((item) => item.hidden));
  });
});

test('退出弹窗与一级导航分组契约', async (t) => {
  await t.test('startup.exitDialog 校验、warning 与非法枚举', () => {
    const [sections, warnings] = normalizeSections({ startup: { exitDialog: {
      enabled: true, mode: 'never', dismissible: false, showDonate: false,
      titleI18n: { zh: '再见' }, bodyI18n: { zh: '欢迎再来' },
    } } });
    assert.equal(sections.startup.exitDialog.enabled, true);
    assert.equal(sections.startup.exitDialog.mode, 'never');
    assert.equal(sections.startup.exitDialog.dismissible, false);
    assert.equal(sections.startup.exitDialog.showDonate, false);
    assert.equal(sections.startup.exitDialog.titleI18n.zh, '再见');
    assert.ok(warnings.some((w) => w.includes('无法留在 App')));
    assert.throws(() => normalizeSections({ startup: { exitDialog: { mode: 'sometimes' } } }),
      /必须是 .* 之一/);
  });

  await t.test('navigation.groups 四大类与 defaultGroupId 兜底', () => {
    const [defaults] = normalizeSections({});
    assert.equal(defaults.navigation.groups.length, 4);
    assert.deepEqual(defaults.navigation.groups.map((g) => g.id),
      ['iptv', 'vod', 'live', 'settings']);
    assert.equal(defaults.navigation.defaultGroupId, 'iptv');
    const [custom, warnings] = normalizeSections({ navigation: {
      groups: [
        { id: 'iptv', label: '电视', children: ['iptv', 'unknown'] },
        { id: 'nope', label: '非法', children: [] },
      ],
      defaultGroupId: 'nope',
    } });
    assert.equal(custom.navigation.groups.length, 1);
    assert.deepEqual(custom.navigation.groups[0].children, ['iptv']);
    assert.equal(custom.navigation.defaultGroupId, 'iptv');
    assert.ok(warnings.some((w) => w.includes('非法或重复的一级块')));
  });
});
