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
  onRequestGet as libraryGet, onRequestPut as libraryPut,
} from '../edge-functions/api/library/index.js';
import {
  onRequestGet as editorGet, preloadDefaults, injectDefaults,
} from '../edge-functions/index.js';
import {
  normalizeDocument, normalizeSections, expandIptvChannels, viewDocument, normalizeLibrary,
  emptyLibrary,
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
      ['iptv', 'navigation', 'sites', 'startup', 'update', 'vod']);
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

/* ================= 全局资源库（设备只存引用） ================= */

test('资源库文档模型：id 规则、上限与协议校验', async (t) => {
  await t.test('空库结构完整', () => {
    const library = emptyLibrary();
    assert.equal(library.revision, 0);
    assert.deepEqual(library.iptv.sources, []);
    assert.deepEqual(library.iptv.packages, []);
    assert.deepEqual(library.vod.sources, []);
    assert.deepEqual(library.vod.sites, []);
  });

  await t.test('非法套餐 id 直接 400（id 是设备的引用目标，不能静默丢弃）', () => {
    assert.throws(() => normalizeLibrary({ iptv: { packages: [{ id: 'pkg_zzz', channels: [] }] } }),
      /非法 id/);
    assert.throws(() => normalizeLibrary({ vod: { sources: [{ id: 's_12345678', url: 'http://a.b/c' }] } }),
      /非法 id/);
    assert.throws(() => normalizeLibrary({ iptv: { sources: 'oops' } }), /必须是数组/);
    assert.throws(() => normalizeLibrary('oops'), /必须是对象/);
  });

  await t.test('缺 id 自动补发，非 http(s) 源被忽略并记 warning', () => {
    const [library, warnings] = normalizeLibrary({
      iptv: {
        sources: [
          { name: '自动 id', url: 'https://example.com/a.m3u' },
          { name: '坏协议', url: 'ftp://example.com/a.m3u' },
        ],
        packages: [{ name: '自动 id 套餐', channels: [{ name: 'A', url: 'http://a.example.com/1.ts' }] }],
      },
    });
    assert.equal(library.iptv.sources.length, 1);
    assert.match(library.iptv.sources[0].id, /^s_[0-9a-f]{8}$/);
    assert.match(library.iptv.packages[0].id, /^pkg_[0-9a-f]{8}$/);
    assert.ok(warnings.some((line) => line.includes('非法订阅地址')));
  });

  await t.test('超上限截断：源 30 / 套餐 12 / 频道总量 5000 / vod 源 20 / 站点 500', () => {
    const sources = Array.from({ length: 31 }, (_, i) => ({
      id: `s_${String(i).padStart(8, '0')}`, url: `https://example.com/${i}.m3u`,
    }));
    const [truncated, warnings] = normalizeLibrary({ iptv: { sources } });
    assert.equal(truncated.iptv.sources.length, 30);
    assert.ok(warnings.some((line) => line.includes('超过 30 个上限')));

    const packages = Array.from({ length: 13 }, (_, i) => ({
      id: `pkg_${String(i).padStart(8, '0')}`,
      channels: [{ name: `C${i}`, url: `http://a.example.com/${i}.ts` }],
    }));
    const [pkgs, pkgWarnings] = normalizeLibrary({ iptv: { packages } });
    assert.equal(pkgs.iptv.packages.length, 12);
    assert.ok(pkgWarnings.some((line) => line.includes('超过 12 个上限')));

    const vodSources = Array.from({ length: 21 }, (_, i) => ({
      id: `vs_${String(i).padStart(8, '0')}`, url: `http://api.example.com/${i}.xml`,
    }));
    const [vod, vodWarnings] = normalizeLibrary({ vod: { sources: vodSources } });
    assert.equal(vod.vod.sources.length, 20);
    assert.ok(vodWarnings.some((line) => line.includes('超过 20 个上限')));

    const siteSources = ['vs_00000000', 'vs_00000001', 'vs_00000002'];
    const sites = Array.from({ length: 501 }, (_, i) => ({
      sourceId: siteSources[i % siteSources.length], key: `k${i}`, name: `站点${i}`, api: 'csp_TEST',
    }));
    const [siteLib, siteWarnings] = normalizeLibrary({
      vod: { sources: siteSources.map((id) => ({ id, url: `http://api.example.com/${id}.xml` })), sites },
    });
    assert.equal(siteLib.vod.sites.length, 500);
    assert.ok(siteWarnings.some((line) => line.includes('超过 500 个上限')));

    // 单源 200 个站点上限
    const perSource = Array.from({ length: 205 }, (_, i) => ({
      sourceId: 'vs_00000001', key: `k${i}`, name: `站点${i}`, api: 'csp_TEST',
    }));
    const [capped, capWarnings] = normalizeLibrary({
      vod: {
        sources: [{ id: 'vs_00000001', url: 'http://api.example.com/a.xml' }],
        sites: perSource,
      },
    });
    assert.equal(capped.vod.sites.length, 200);
    assert.ok(capWarnings.some((line) => line.includes('个站点上限')));
  });

  await t.test('非法站点 key / 未知源 / 缺 api 被忽略，站点 id 由 sourceId:key 派生', () => {
    const [library, warnings] = normalizeLibrary({
      vod: {
        sources: [{ id: 'vs_abcdef01', url: 'http://api.example.com/a.xml' }],
        sites: [
          { sourceId: 'vs_abcdef01', key: 'ok', name: '正常', api: 'csp_OK' },
          { sourceId: 'vs_abcdef01', key: 'bad key', name: '空格', api: 'csp_X' },
          { sourceId: 'vs_ffffffff', key: 'ghost', name: '未知源', api: 'csp_X' },
          { sourceId: 'vs_abcdef01', key: 'noapi', name: '缺 api' },
        ],
      },
    });
    assert.equal(library.vod.sites.length, 1);
    assert.equal(library.vod.sites[0].id, 'vs_abcdef01:ok');
    assert.ok(warnings.some((line) => line.includes('非法站点 key')));
    assert.ok(warnings.some((line) => line.includes('未知源')));
    assert.ok(warnings.some((line) => line.includes('缺少 api')));
  });

  await t.test('设备 vod 节：默认值、上限与类型校验', () => {
    const [sections] = normalizeSections({});
    assert.deepEqual(sections.vod, {
      managed: false, sourceIds: [], siteIds: [], lockLibrary: false, libraryRevision: 0,
    });

    const sourceIds = Array.from({ length: 21 }, (_, i) => `vs_${String(i).padStart(8, '0')}`);
    const [capped, warnings] = normalizeSections({ vod: { sourceIds } });
    assert.equal(capped.vod.sourceIds.length, 20);
    assert.ok(warnings.some((line) => line.includes('vod.sourceIds: 超过 20 个上限')));

    const siteIds = Array.from({ length: 501 }, (_, i) => `vs_00000000:k${i}`);
    const [sites] = normalizeSections({ vod: { siteIds } });
    assert.equal(sites.vod.siteIds.length, 500);

    const [filtered, filterWarnings] = normalizeSections({
      vod: { siteIds: ['vs_00000000:ok', 'not a site id', 'vs_00000000:ok'] },
    });
    assert.deepEqual(filtered.vod.siteIds, ['vs_00000000:ok']);
    assert.ok(filterWarnings.some((line) => line.includes('格式非法的站点 id')));

    assert.throws(() => normalizeSections({ vod: { sourceIds: 'x' } }), /必须是字符串数组/);
    assert.throws(() => normalizeSections({ vod: { lockLibrary: 'yes' } }), /必须是布尔值/);
    assert.throws(() => normalizeSections({ vod: { libraryRevision: -1 } }), /必须在/);
  });

  await t.test('兼容编辑器导入的 TVBox 原始字段（布尔开关 / 字符串 type / 套餐按 URL 记来源）', () => {
    const [library, warnings] = normalizeLibrary({
      iptv: {
        sources: [{ id: 's_0000beef', url: 'https://example.com/a.m3u', type: 'url', channelCount: '3' }],
        packages: [{
          id: 'pkg_0000beef',
          name: '导入套餐',
          sources: ['https://example.com/a.m3u'],
          channels: [{ name: 'A', url: 'http://a.example.com/1.ts' }],
        }],
      },
      vod: {
        sources: [{ id: 'vs_0000beef', url: 'http://api.example.com/a.json', siteCount: '2' }],
        sites: [{
          id: 'vs_0000beef:cf', sourceId: 'vs_0000beef', key: 'cf', name: 'CF',
          api: 'csp_CF', type: '', searchable: true, quickSearch: false,
        }],
      },
    });
    assert.deepEqual(library.iptv.packages[0].sources, ['s_0000beef']);
    assert.equal(library.iptv.sources[0].channelCount, 3);
    assert.equal(library.vod.sources[0].siteCount, 2);
    assert.equal(library.vod.sites[0].type, 0);
    assert.equal(library.vod.sites[0].searchable, 1);
    assert.equal(library.vod.sites[0].quickSearch, 0);
    assert.equal(warnings.length, 0);
  });

  await t.test('设备 iptv 新增字段：packageIds 去重截断、lockLibrary、libraryRevision', () => {
    const ids = Array.from({ length: 14 }, (_, i) => `pkg_${String(i).padStart(8, '0')}`);
    const [sections, warnings] = normalizeSections({
      iptv: {
        packageIds: ['bad id!', ...ids, 'pkg_00000000'],
        lockLibrary: true,
        libraryRevision: 3,
      },
    });
    assert.equal(sections.iptv.packageIds.length, 12);
    assert.equal(sections.iptv.lockLibrary, true);
    assert.equal(sections.iptv.libraryRevision, 3);
    assert.ok(warnings.some((line) => line.includes('超过 12 个上限')));
    assert.ok(warnings.some((line) => line.includes('格式非法的套餐 id')));
    assert.throws(() => normalizeSections({ iptv: { packageIds: [1] } }), /必须是字符串数组/);
  });
});

test('资源库 API 与设备引用：写入、409、懒触发生效与锁定隔离', async (t) => {
  const savedKv = globalThis.PURETV_KV;
  const fresh = new MemoryKV();
  globalThis.PURETV_KV = fresh;
  t.after(() => { globalThis.PURETV_KV = savedKv; });

  const env = {};
  const libGet = () => libraryGet(ctx('GET', '/api/library', { env }));
  const libPut = (body, revision, headers) => libraryPut(ctx('PUT', '/api/library', {
    env,
    headers: { 'Content-Type': 'application/json', ...(revision === undefined ? {} : { 'If-Match': String(revision) }), ...headers },
    body,
  }));
  const deviceGet = (id, since) => configGet(ctx('GET',
    `/api/config?deviceId=${id}${since === undefined ? '' : `&since=${since}`}`, { env }));
  const devicePut = (id, sections, revision) => configPut(ctx('PUT', `/api/config?deviceId=${id}`, {
    env, headers: { 'If-Match': String(revision), 'Content-Type': 'application/json' },
    body: { sections },
  }));

  const PACKAGE_ID = 'pkg_0000abcd';
  const SOURCE_ID = 's_0000abcd';
  const VOD_SOURCE_ID = 'vs_0000abcd';
  const VOD_SITE_ID = 'vs_0000abcd:cf';
  const baseLibrary = () => ({
    iptv: {
      epgUrl: 'https://epg.example.com/e.xml',
      sources: [{
        id: SOURCE_ID, name: '央视源', url: 'https://example.com/cctv.m3u', type: 'm3u', channelCount: 2,
      }],
      packages: [{
        id: PACKAGE_ID,
        name: '央视',
        sources: [SOURCE_ID, 's_ffffffff'],
        channels: [
          { name: 'CCTV1', url: 'http://lib.example.com/1.ts', group: '央视' },
          { name: 'CCTV2', url: 'http://lib.example.com/2.ts', group: '央视' },
        ],
      }],
    },
    vod: {
      sources: [{ id: VOD_SOURCE_ID, name: '饭太硬', url: 'http://api.example.com/fan.json', siteCount: 1 }],
      sites: [{
        id: VOD_SITE_ID, sourceId: VOD_SOURCE_ID, key: 'cf', name: 'CF', api: 'csp_CF',
        type: 0, searchable: 1, quickSearch: 1,
      }],
    },
  });

  await t.test('空库 GET 返回完整空结构与 ETag，且鉴权生效', async () => {
    const res = await libGet();
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('ETag'), '"0"');
    const data = await json(res);
    assert.equal(data.revision, 0);
    assert.deepEqual(data.iptv, { sources: [], packages: [], epgUrl: '' });
    assert.deepEqual(data.vod, { sources: [], sites: [] });

    const denied = await libraryGet(ctx('GET', '/api/library', {
      env: { CONFIG_READ_TOKEN: 'read-secret' },
    }));
    assert.equal(denied.status, 401);
  });

  await t.test('PUT 缺 If-Match 400、非法 id 400，且不落库', async () => {
    const noMatch = await libPut(baseLibrary());
    assert.equal(noMatch.status, 400);
    assert.equal((await json(noMatch)).error, 'invalid_config');

    const badId = await libPut({
      iptv: { packages: [{ id: 'pkg_bad', channels: [] }] },
    }, 0);
    assert.equal(badId.status, 400);
    assert.match((await json(badId)).message, /非法 id/);
    assert.equal((await json(await libGet())).revision, 0);
  });

  await t.test('建库：revision 递增、非法源引用被清理、affectedDevices=0', async () => {
    const res = await libPut(baseLibrary(), 0);
    assert.equal(res.status, 200);
    const data = await json(res);
    assert.equal(data.revision, 1);
    assert.equal(data.affectedDevices, 0);
    assert.ok(data.warnings.some((line) => line.includes('不存在的源 s_ffffffff')));
    assert.ok(data.updatedAt);

    const stored = await json(await libGet());
    assert.equal(stored.revision, 1);
    assert.equal(stored.iptv.sources[0].id, SOURCE_ID);
    assert.deepEqual(stored.iptv.packages[0].sources, [SOURCE_ID]);
    assert.equal(stored.iptv.packages[0].channels.length, 2);
    assert.equal(stored.vod.sites[0].id, VOD_SITE_ID);
  });

  await t.test('If-Match 不匹配返回 409 并带回当前库', async () => {
    const res = await libPut(baseLibrary(), 0);
    assert.equal(res.status, 409);
    const data = await json(res);
    assert.equal(data.error, 'revision_conflict');
    assert.equal(data.currentRevision, 1);
  });

  await t.test('设备引用库套餐：GET 展开 channels、套餐摘要来自库、libraryRevision 追平', async () => {
    const put = await devicePut('tv-lib', {
      iptv: { managed: true, packageIds: [PACKAGE_ID] },
      vod: { managed: true, sourceIds: [VOD_SOURCE_ID], siteIds: [VOD_SITE_ID] },
    }, 1);
    assert.equal(put.status, 200);
    assert.equal((await json(put)).revision, 2);

    const res = await deviceGet('tv-lib');
    assert.equal(res.status, 200);
    const doc = await json(res);
    // 懒触发 bump：2 → 3
    assert.equal(doc.revision, 3);
    assert.equal(doc.sections.iptv.libraryRevision, 1);
    assert.equal(doc.sections.vod.libraryRevision, 1);
    assert.equal(doc.sections.iptv.channels.length, 2);
    assert.equal(doc.sections.iptv.channels[0].url, 'http://lib.example.com/1.ts');
    assert.deepEqual(doc.sections.iptv.packages.map((pkg) => pkg.id), [PACKAGE_ID]);
    assert.equal(doc.sections.iptv.packages[0].channelCount, 2);
    assert.ok(!('channels' in doc.sections.iptv.packages[0]));
    assert.deepEqual(doc.sections.vod.siteIds, [VOD_SITE_ID]);

    // bump 之后 304 判定用新 revision
    assert.equal((await deviceGet('tv-lib', 3)).status, 304);
    assert.equal((await deviceGet('tv-lib', 2)).status, 200);
  });

  await t.test('编辑器 withPackages=1 拿到库套餐完整频道', async () => {
    const doc = await json(await configGet(ctx('GET',
      '/api/config?deviceId=tv-lib&withPackages=1', { env })));
    assert.equal(doc.sections.iptv.packages[0].channels.length, 2);
    assert.equal(doc.sections.iptv.packages[0].name, '央视');
  });

  await t.test('库变更后设备 GET 自动 bump，频道以库为准（不留旧频道）', async () => {
    const next = baseLibrary();
    next.iptv.packages[0].channels = [
      { name: 'CCTV1', url: 'http://lib.example.com/1.ts', group: '央视' },
      { name: 'CCTV2', url: 'http://lib.example.com/2.ts', group: '央视' },
      { name: 'CCTV3', url: 'http://lib.example.com/3.ts', group: '央视' },
    ];
    const put = await libPut(next, 1);
    assert.equal(put.status, 200);
    const putData = await json(put);
    assert.equal(putData.revision, 2);
    assert.equal(putData.affectedDevices, 1);

    const doc = await json(await deviceGet('tv-lib'));
    assert.equal(doc.revision, 4);
    assert.equal(doc.sections.iptv.libraryRevision, 2);
    assert.equal(doc.sections.iptv.channels.length, 3);

    // 频道被移除时不残留：这一次库只保留一条全新频道
    const trimmed = baseLibrary();
    trimmed.iptv.packages[0].channels = [
      { name: 'CCTV9', url: 'http://lib.example.com/9.ts', group: '纪录' },
    ];
    assert.equal((await libPut(trimmed, 2)).status, 200);
    const after = await json(await deviceGet('tv-lib'));
    assert.equal(after.revision, 5);
    assert.equal(after.sections.iptv.libraryRevision, 3);
    assert.deepEqual(after.sections.iptv.channels.map((c) => c.url), ['http://lib.example.com/9.ts']);
    assert.deepEqual(after.sections.iptv.groups, ['纪录']);
  });

  await t.test('未引用库的设备不会被无谓 bump', async () => {
    const first = await json(await deviceGet('tv-plain'));
    assert.equal(first.revision, 1);
    assert.equal(first.sections.iptv.libraryRevision, 0);
    const second = await json(await deviceGet('tv-plain'));
    assert.equal(second.revision, 1);
    assert.equal(second.sections.iptv.channels.length, 0);
  });

  await t.test('lockLibrary=true：PUT 时快照展开，之后库再变也不影响该设备', async () => {
    await deviceGet('tv-lock');
    const put = await devicePut('tv-lock', {
      iptv: { managed: true, lockLibrary: true, packageIds: [PACKAGE_ID] },
    }, 1);
    assert.equal(put.status, 200);
    assert.equal((await json(put)).revision, 2);

    const locked = await json(await deviceGet('tv-lock'));
    assert.equal(locked.revision, 2);
    assert.equal(locked.sections.iptv.lockLibrary, true);
    assert.deepEqual(locked.sections.iptv.channels.map((c) => c.url), ['http://lib.example.com/9.ts']);
    assert.equal(locked.sections.iptv.libraryRevision, 3);

    const next = baseLibrary();
    next.iptv.packages[0].channels = [
      { name: 'CCTV9', url: 'http://lib.example.com/9.ts', group: '纪录' },
      { name: 'CCTV10', url: 'http://lib.example.com/10.ts', group: '纪录' },
    ];
    const putLib = await libPut(next, 3);
    const putLibData = await json(putLib);
    assert.equal(putLibData.revision, 4);
    // 锁定设备不计入 affectedDevices
    assert.equal(putLibData.affectedDevices, 1);

    const stillLocked = await json(await deviceGet('tv-lock'));
    assert.equal(stillLocked.revision, 2);
    assert.deepEqual(stillLocked.sections.iptv.channels.map((c) => c.url),
      ['http://lib.example.com/9.ts']);
    assert.equal(stillLocked.sections.iptv.libraryRevision, 3);
  });

  await t.test('编辑器保存形态（剔除库套餐、清空派生 channels）后 GET 仍能展开', async () => {
    await deviceGet('tv-editor');
    const put = await devicePut('tv-editor', {
      iptv: {
        managed: true,
        packageIds: [PACKAGE_ID],
        lockLibrary: false,
        // 编辑器勾选套餐时会把当时的库 revision 写进来，因此这次 GET 不该再 bump
        libraryRevision: 4,
        selectedPackageIds: [],
        packages: [{
          id: 'p1',
          name: '本地旧套餐',
          channels: [{ name: 'L', url: 'http://inline.example.com/1.ts' }],
        }],
        channels: [],
        groups: [],
      },
    }, 1);
    assert.equal(put.status, 200);
    assert.equal((await json(put)).revision, 2);

    const doc = await json(await deviceGet('tv-editor'));
    assert.equal(doc.revision, 2);
    assert.equal(doc.sections.iptv.libraryRevision, 4);
    assert.equal(doc.sections.iptv.channels.length, 2);
    assert.deepEqual(doc.sections.iptv.channels.map((c) => c.url).sort(),
      ['http://lib.example.com/10.ts', 'http://lib.example.com/9.ts']);
    // 轻量视图的套餐摘要同时覆盖库套餐与本地内联套餐
    assert.deepEqual(doc.sections.iptv.packages.map((pkg) => pkg.id).sort(),
      ['p1', PACKAGE_ID]);
  });

  await t.test('旧 selectedPackageIds + 内联 packages 路径不回归', async () => {
    const [normalized] = normalizeSections({ iptv: {
      packages: [
        { id: 'p1', name: '央视', channels: [{ name: 'A', url: 'http://old.example.com/a.ts', group: '央视' }] },
        { id: 'p2', name: '卫视', channels: [{ name: 'B', url: 'http://old.example.com/b.ts', group: '卫视' }] },
      ],
      selectedPackageIds: ['p2', 'p1'],
    } });
    assert.deepEqual(normalized.iptv.packageIds, []);
    // 即使传了库，只要没有 packageIds 就仍走设备内联套餐
    const expanded = expandIptvChannels(normalized, baseLibrary());
    assert.deepEqual(expanded.iptv.channels.map((c) => c.url),
      ['http://old.example.com/b.ts', 'http://old.example.com/a.ts']);
    assert.deepEqual(expanded.iptv.groups, ['卫视', '央视']);

    // 端到端：老客户端只传 selectedPackageIds 依然拿到展开后的 channels
    await deviceGet('tv-legacy');
    const put = await devicePut('tv-legacy', { iptv: {
      managed: true,
      packages: [{ id: 'p1', name: '央视', channels: [{ name: 'A', url: 'http://old.example.com/a.ts' }] }],
      selectedPackageIds: ['p1'],
    } }, 1);
    assert.equal(put.status, 200);
    const doc = await json(await deviceGet('tv-legacy'));
    assert.equal(doc.revision, 2);
    assert.equal(doc.sections.iptv.channels.length, 1);
  });

  await t.test('老设备文档（无 vod / 无 packageIds）读取兼容且不被 bump', async () => {
    const [legacySections] = normalizeSections({});
    delete legacySections.vod;
    delete legacySections.iptv.packageIds;
    delete legacySections.iptv.lockLibrary;
    delete legacySections.iptv.libraryRevision;
    fresh.map.set('device_tv-old_current', JSON.stringify({
      schemaVersion: 1, revision: 5, updatedAt: '2026-01-01T00:00:00+08:00', sections: legacySections,
    }));

    const res = await deviceGet('tv-old');
    assert.equal(res.status, 200);
    const doc = await json(res);
    // 没有库引用 → 不 bump，revision 原样
    assert.equal(doc.revision, 5);
    assert.deepEqual(doc.sections.vod, {
      managed: false, sourceIds: [], siteIds: [], lockLibrary: false, libraryRevision: 0,
    });
    assert.deepEqual(doc.sections.iptv.packageIds, []);
  });

  await t.test('库变更触发 bump 不写快照：历史条目不增不减，current revision 仍递增', async () => {
    await deviceGet('tv-hist');
    // 两次真实编辑 → 留下 revision 2、3 两条快照
    assert.equal((await devicePut('tv-hist', {
      sites: { managed: true, enabledSiteIds: ['bilibili'] },
    }, 1)).status, 200);
    assert.equal((await devicePut('tv-hist', {
      iptv: { managed: true, packageIds: [PACKAGE_ID], libraryRevision: 4 },
      sites: { managed: true, enabledSiteIds: ['bilibili'] },
    }, 2)).status, 200);

    const before = await json(await revisionsGet(ctx('GET',
      '/api/config/revisions?deviceId=tv-hist', { env })));
    assert.deepEqual(before.revisions.map((item) => item.revision), [3, 2]);
    assert.ok(fresh.map.has('device_tv-hist_snapshot_00000003'));

    // 库再改一次 → 设备下次 GET 追平（revision 4），但不应留下快照/历史
    const next = baseLibrary();
    next.iptv.packages[0].channels = [
      { name: 'CCTV9', url: 'http://lib.example.com/9.ts', group: '纪录' },
      { name: 'CCTV10', url: 'http://lib.example.com/10.ts', group: '纪录' },
      { name: 'CCTV11', url: 'http://lib.example.com/11.ts', group: '纪录' },
    ];
    assert.equal((await libPut(next, 4)).status, 200); // 库 → revision 5

    const doc = await json(await deviceGet('tv-hist'));
    assert.equal(doc.revision, 4);
    assert.equal(doc.sections.iptv.libraryRevision, 5);
    assert.equal(doc.sections.iptv.channels.length, 3);

    const after = await json(await revisionsGet(ctx('GET',
      '/api/config/revisions?deviceId=tv-hist', { env })));
    assert.deepEqual(after.revisions.map((item) => item.revision), [3, 2]);
    assert.equal(fresh.map.has('device_tv-hist_snapshot_00000004'), false);

    // 终端管理页仍要看到最新 revision
    const listed = await storageListDevices(env);
    assert.equal(listed.find((item) => item.id === 'tv-hist').revision, 4);

    // 回滚到「无快照」的 revision 给出可读 400，而不是 500
    const rollbackRes = await rollbackPost(ctx('POST', '/api/config/rollback?deviceId=tv-hist', {
      env, headers: { 'Content-Type': 'application/json' }, body: { revision: 4 },
    }));
    assert.equal(rollbackRes.status, 400);
    assert.match((await json(rollbackRes)).message, /找不到 revision 4 的快照/);
  });

  await t.test('库写入的 KV 键名合法，且不影响配置文档键', () => {
    assert.ok(fresh.map.has('library_current'));
    for (const key of fresh.map.keys()) {
      // 设备 id 允许连字符，键名只需落在 KV 支持的字符集内
      assert.match(key, /^[A-Za-z0-9_-]+$/, `非法 KV key: ${key}`);
    }
  });
});
