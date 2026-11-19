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
  onRequestGet as bundlesGet, onRequestPut as bundlesPut,
} from '../edge-functions/api/bundles/index.js';
import {
  onRequestGet as assetsGet, onRequestPost as assetsPost, sniffImageType,
} from '../edge-functions/api/assets/index.js';
import {
  onRequestGet as editorGet, preloadDefaults, injectDefaults,
} from '../edge-functions/index.js';
import {
  normalizeDocument, normalizeSections, expandIptvChannels, expandVodSites, viewDocument,
  normalizeLibrary, emptyLibrary, parseSpiderField, resolveVodAsset,
} from '../edge-functions/_lib/contract.js';
import { handle, optionsHandler, readJsonBody } from '../edge-functions/_lib/http.js';
import { listDevices as storageListDevices } from '../edge-functions/_lib/storage.js';
import {
  onRequestPost as iptvFetchPost, checkFetchUrl, decodeSubscription, detectBinaryPayload,
} from '../edge-functions/api/iptv/fetch.js';
import { onRequestGet as updateGet } from '../edge-functions/api/update/index.js';
import {
  flattenVersion, abiOf, repoOf, proxyPrefixes, buildFromReleases, buildFromStatic,
  loadAppUpdate, resetAppUpdateCache,
} from '../edge-functions/_lib/update.js';
import {
  onRequestGet as manifestGet, onRequestPost as manifestPost,
} from '../edge-functions/api/update/manifest.js';
import {
  onRequestGet as apkGet, onRequestPost as apkPost, looksLikeApk,
} from '../edge-functions/api/update/apk.js';
import { normalizeUploadedManifest } from '../edge-functions/_lib/update.js';
import { onRequestPost as authLogin } from '../edge-functions/api/auth/login.js';
import { onRequestGet as authStatusGet } from '../edge-functions/api/auth/status.js';
import { onRequestGet as authSessionGet } from '../edge-functions/api/auth/session.js';
import { onRequestPost as authPasswordPost } from '../edge-functions/api/auth/password.js';
import { onRequestPost as authLogoutPost } from '../edge-functions/api/auth/logout.js';

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
    assert.equal(data.readProtected, false);
    assert.equal(data.writeProtected, false);
  });

  // 回归（2026-11-16 审查 #3 细节）：只配写令牌时 devMode 曾误报 true。
  await t.test('health 分别暴露读写令牌保护状态', async () => {
    const res = await healthGet(ctx('GET', '/health', {
      env: { CONFIG_WRITE_TOKEN: 'w' },
    }));
    const data = await json(res);
    assert.equal(data.readProtected, false);
    assert.equal(data.writeProtected, true);
    // devMode 兼容字段仍表示"读接口未保护"，写令牌状态看 writeProtected。
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
      ['iptv', 'navigation', 'startup', 'update', 'vod']);
    assert.ok(!('sites' in doc.sections));
  });

  await t.test('since / If-None-Match 命中返回 304', async () => {
    const a = await configGet(ctx('GET', '/api/config?since=0'));
    assert.equal(a.status, 304);
    assert.equal(a.headers.get('ETag'), '"0"');
    const b = await configGet(ctx('GET', '/api/config', { headers: { 'If-None-Match': '"0"' } }));
    assert.equal(b.status, 304);
  });

  await t.test('PUT 缺少 If-Match 返回 400', async () => {
    const res = await configPut(ctx('PUT', '/api/config', { body: { sections: { navigation: { managed: true } } } }));
    assert.equal(res.status, 400);
    assert.equal((await json(res)).error, 'invalid_config');
  });

  await t.test('PUT 写入、过滤未知 id、老直播节被忽略', async () => {
    const res = await configPut(ctx('PUT', '/api/config', {
      headers: { 'If-Match': '0' },
      body: {
        sections: {
          sites: { managed: true, enabledSiteIds: ['bilibili', 'not_a_site', 'douyu'] },
          navigation: { managed: true, railMenuIds: ['iptv', 'vodBrowse', 'not_a_menu'] },
        },
      },
    }));
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('X-Revision'), '1');
    const data = await json(res);
    assert.equal(data.revision, 1);
    assert.equal(data.devMode, true);
    assert.ok(data.warnings.some((line) => line.includes('not_a_menu')));
    assert.ok(data.warnings.some((line) => line.includes('sites')));
    const doc = await json(await configGet(ctx('GET', '/api/config')));
    assert.ok(!('sites' in doc.sections));
    assert.equal(doc.sections.navigation.managed, true);
    assert.deepEqual(doc.sections.navigation.railMenuIds, ['iptv', 'vodBrowse']);
  });

  await t.test('驼峰菜单 id（vodBrowse/moviePlayback）不被小写化误杀', async () => {
    // 回归：客户端 AppMenuItem 用的是驼峰 id，服务端曾统一转小写比对，
    // 导致这两项被判为未知 id 而丢弃，开启导航管控后电视上直接少两个菜单。
    const [sections, warnings] = normalizeSections({
      navigation: {
        managed: true,
        railMenuIds: ['vodBrowse', 'moviePlayback', 'iptv'],
      },
    });
    assert.deepEqual(sections.navigation.railMenuIds,
      ['vodBrowse', 'moviePlayback', 'iptv']);
    assert.equal(warnings.length, 0);
  });

  await t.test('大小写不敏感匹配，但写回 catalog 里的原始 id', async () => {
    const [sections] = normalizeSections({
      navigation: { railMenuIds: ['vodbrowse', 'MOVIEPLAYBACK'] },
    });
    assert.deepEqual(sections.navigation.railMenuIds, ['vodBrowse', 'moviePlayback']);
  });

  await t.test('revision 冲突返回 409 并带回当前文档', async () => {
    const res = await configPut(ctx('PUT', '/api/config', {
      headers: { 'If-Match': '0' },
      body: { sections: { navigation: { managed: false } } },
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
    assert.deepEqual(doc.sections.navigation.railMenuIds, ['iptv', 'vodBrowse']);
  });

  await t.test('回滚不存在的快照返回 400', async () => {
    const res = await rollbackPost(ctx('POST', '/api/config/rollback', { body: { revision: 999 } }));
    assert.equal(res.status, 400);
    assert.equal((await json(res)).error, 'invalid_config');
  });

  await t.test('catalog 只返回 IPTV/TVBox 菜单，直播平台已下线', async () => {
    const res = await catalogGet(ctx('GET', '/api/config/catalog'));
    assert.equal(res.status, 200);
    const data = await json(res);
    assert.deepEqual(data.sites, []);
    assert.deepEqual(data.menus.map((item) => item.id),
      ['vodBrowse', 'moviePlayback', 'iptv']);
    assert.ok(data.menus.some((item) => item.id === 'iptv'));
    assert.ok(data.menus.some((item) => item.id === 'vodBrowse'));
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
      body: { sections: { navigation: { managed: true } } },
    }));
    assert.equal(readOnly.status, 401);
    const ok = await configGet(ctx('GET', '/api/config', {
      env, headers: { Authorization: 'Bearer read-secret' },
    }));
    assert.equal(ok.status, 200);
    const write = await configPut(ctx('PUT', '/api/config', {
      env,
      headers: { Authorization: 'Bearer write-secret', 'If-Match': '2' },
      body: { sections: { navigation: { managed: true } } },
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

  await t.test('规范化：空列表兜底、类型错误、老直播节与未知节', async () => {
    const [empty, emptyWarnings] = normalizeSections({ navigation: { railMenuIds: [] } });
    assert.equal(empty.navigation.railMenuIds.length, 3);
    assert.ok(emptyWarnings.some((line) => line.includes('回退内置全量')));

    const [legacy, legacyWarnings] = normalizeSections({
      sites: { managed: true, enabledSiteIds: ['bilibili'] },
      navigation: { managed: true, railMenuIds: ['iptv'] },
    });
    assert.ok(!('sites' in legacy));
    assert.deepEqual(legacy.navigation.railMenuIds, ['iptv']);
    assert.ok(legacyWarnings.some((line) => line.includes('sites')));

    assert.throws(() => normalizeSections({ navigation: { managed: 'yes' } }), /必须是布尔值/);
    const [, unknownWarnings] = normalizeSections({ futureSection: { foo: 1 } });
    assert.ok(unknownWarnings.some((line) => line.includes('忽略未知节')));

    const [doc] = normalizeDocument({ schemaVersion: 1, revision: 7, sections: {} });
    assert.equal(doc.revision, 7);
    assert.equal(doc.schemaVersion, 1);
    assert.throws(() => normalizeDocument({ schemaVersion: 2, sections: {} }), /不支持的 schemaVersion/);
  });

  await t.test('首页壁纸：默认值、合法下发与安全校验', async () => {
    // 缺省补齐：未提交 wallpaper 时用 seed 默认值，enabled=false 不影响终端。
    const [fresh] = normalizeSections({ navigation: {} });
    assert.deepEqual(fresh.navigation.wallpaper, {
      enabled: false, imageUrl: '', boxFit: 'cover',
      blurSigma: 0, maskOpacityPercent: 35,
    });

    // 合法下发：http(s) 地址 + 样式字段全部保留。
    const [ok] = normalizeSections({ navigation: { wallpaper: {
      enabled: true,
      imageUrl: 'https://tv.1008618.xyz/api/assets?id=as_abc123',
      boxFit: 'contain', blurSigma: 12, maskOpacityPercent: 55,
    } } });
    assert.equal(ok.navigation.wallpaper.enabled, true);
    assert.equal(ok.navigation.wallpaper.imageUrl,
      'https://tv.1008618.xyz/api/assets?id=as_abc123');
    assert.equal(ok.navigation.wallpaper.boxFit, 'contain');
    assert.equal(ok.navigation.wallpaper.blurSigma, 12);
    assert.equal(ok.navigation.wallpaper.maskOpacityPercent, 55);

    // 非法地址直接拒绝：javascript:/data:/相对路径都不允许，防存储型注入。
    for (const bad of ['javascript:alert(1)', 'data:image/png;base64,aaa', '/api/assets?id=x']) {
      assert.throws(
        () => normalizeSections({ navigation: { wallpaper: { enabled: true, imageUrl: bad } } }),
        /imageUrl 必须是 http\(s\)/,
      );
    }

    // 越界数值严格抛错（int 契约不夹取）；非法 boxFit 也是严格枚举抛错。
    assert.throws(
      () => normalizeSections({ navigation: { wallpaper: {
        imageUrl: 'https://example.com/w.jpg', blurSigma: 999,
      } } }),
      /blurSigma 必须在 0~60/,
    );
    assert.throws(
      () => normalizeSections({ navigation: { wallpaper: {
        imageUrl: 'https://example.com/w.jpg', maskOpacityPercent: -5,
      } } }),
      /maskOpacityPercent 必须在 0~100/,
    );
    assert.throws(
      () => normalizeSections({ navigation: { wallpaper: {
        imageUrl: 'https://example.com/w.jpg', boxFit: 'bogus',
      } } }),
      /boxFit 必须是/,
    );

    // 类型错误：wallpaper 非对象直接报错。
    assert.throws(
      () => normalizeSections({ navigation: { wallpaper: 'oops' } }),
      /wallpaper 必须是对象/,
    );

    // 走真实 PUT → GET 落库链路，确认下发后端到端保留 wallpaper。
    // If-Match 取当前 revision，避免依赖前面用例留下的固定版本号。
    const before = await json(await configGet(ctx('GET', '/api/config')));
    const put = await configPut(ctx('PUT', '/api/config', {
      headers: { 'If-Match': String(before.revision) },
      body: { sections: {
        navigation: { managed: true, wallpaper: {
          enabled: true, imageUrl: 'https://cdn.example.com/bg.jpg',
        } },
      } },
    }));
    assert.equal(put.status, 200);
    const got = await json(await configGet(ctx('GET', '/api/config')));
    assert.equal(got.sections.navigation.wallpaper.enabled, true);
    assert.equal(got.sections.navigation.wallpaper.imageUrl, 'https://cdn.example.com/bg.jpg');
  });

  await t.test('IPTV 请求头：默认值、下发与换行注入清洗', async () => {
    // 缺省补齐三项空串：编辑器有落点，终端把空值当「不改动」。
    const [fresh] = normalizeSections({ iptv: {} });
    assert.deepEqual(fresh.iptv.requestHeaders, {
      userAgent: '', referer: '', cookie: '',
    });

    // 合法下发：三项原样保留。
    const [ok] = normalizeSections({ iptv: { requestHeaders: {
      userAgent: 'Mozilla/5.0 (Linux; Android 12)',
      referer: 'http://example.com/',
      cookie: 'a=b; c=d',
    } } });
    assert.equal(ok.iptv.requestHeaders.userAgent, 'Mozilla/5.0 (Linux; Android 12)');
    assert.equal(ok.iptv.requestHeaders.referer, 'http://example.com/');
    assert.equal(ok.iptv.requestHeaders.cookie, 'a=b; c=d');

    // 换行注入：/[\u0000-\u001f\u007f]/ 剔除，不得留在下发文档里。
    const [scrubbed] = normalizeSections({ iptv: { requestHeaders: {
      referer: 'http://example.com/\r\nX-Injected: 1',
    } } });
    assert.doesNotMatch(scrubbed.iptv.requestHeaders.referer, /[\r\n]/);
    assert.equal(scrubbed.iptv.requestHeaders.referer, 'http://example.com/X-Injected: 1');

    // 类型错误严格抛错（与 schema.py 一致）。
    assert.throws(() => normalizeSections({ iptv: { requestHeaders: 'nope' } }),
      /iptv\.requestHeaders 必须是对象/);
    assert.throws(() => normalizeSections({ iptv: { requestHeaders: { cookie: 123 } } }),
      /iptv\.requestHeaders\.cookie 必须是字符串/);

    // 超长按上限截断（cookie 2000）。
    const [long] = normalizeSections({ iptv: { requestHeaders: { cookie: 'x'.repeat(3000) } } });
    assert.equal(long.iptv.requestHeaders.cookie.length, 2000);

    // 端到端：PUT 后 GET 能读回请求头，且不需要 iptv.managed=true。
    const before = await json(await configGet(ctx('GET', '/api/config')));
    const put = await configPut(ctx('PUT', '/api/config', {
      headers: { 'If-Match': String(before.revision) },
      body: { sections: { iptv: { requestHeaders: { referer: 'https://ref.example.com/' } } } },
    }));
    assert.equal(put.status, 200);
    const got = await json(await configGet(ctx('GET', '/api/config')));
    assert.equal(got.sections.iptv.requestHeaders.referer, 'https://ref.example.com/');
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

/** 模拟 @edgeone/pages-blob 的 Store：get(key,{type}) / set(key,value) / createUploadUrl。 */
class MemoryBlob {
  constructor() {
    this.map = new Map();
    this.presigned = [];
  }

  async get(key, options = {}) {
    const value = this.map.get(key);
    if (value === undefined) return null;
    const type = options.type || 'text';
    if (type === 'json') return JSON.parse(value);
    const bytes = value instanceof Uint8Array ? value : new TextEncoder().encode(String(value));
    if (type === 'arrayBuffer') {
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    }
    if (type === 'stream') {
      return new ReadableStream({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        },
      });
    }
    return value instanceof Uint8Array ? new TextDecoder().decode(value) : value;
  }

  async set(key, value) { this.map.set(key, value); }

  async delete(key) { this.map.delete(key); }

  /** 预签名上传：真实 SDK 会返回一个可直接 PUT 的 url，这里只记录并回一个假地址。 */
  async createUploadUrl(key, options = {}) {
    this.presigned.push({ key, options });
    return {
      url: `https://blob.example.invalid/put/${key}`,
      key,
      expiresAt: Math.floor(Date.now() / 1000) + (options.expireSeconds || 3600),
    };
  }
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
      body: { sections: { navigation: { managed: true, railMenuIds: ['iptv', 'moviePlayback'] } } },
    }));
    assert.equal(put.status, 200);
    assert.equal(put.headers.get('X-Revision'), '1');

    // 强一致读：Blob 后端必须立刻看到新 revision
    const fresh = await configGet(ctx('GET', '/api/config'));
    const doc = await json(fresh);
    assert.equal(doc.revision, 1);
    assert.deepEqual(doc.sections.navigation.railMenuIds, ['iptv', 'moviePlayback']);

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
    const res = await put('tv-living-room',
      { navigation: { managed: true, railMenuIds: ['iptv'] } }, 1);
    assert.equal(res.status, 200);
    const global = await json(await get(null));
    assert.equal(global.revision, 0);
    assert.equal(global.sections.navigation.managed, false);
    const a = await json(await get('tv-living-room'));
    assert.equal(a.revision, 2);
    assert.deepEqual(a.sections.navigation.railMenuIds, ['iptv']);
    const b = await json(await get('tv-bedroom'));
    assert.equal(b.revision, 1);
    assert.equal(b.sections.navigation.managed, false);
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
    assert.equal(after.sections.navigation.managed, false);
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

test('编辑器连接信息只注入同源地址，不注入任何令牌', async (t) => {
  // 改成账号登录后，页面源码里绝不能出现读写令牌：打开域名即拿到写权限是
  // 旧预填方案最大的问题。地址仍然预填（同源），登录流程也会自己带出来。
  const env = {
    CONFIG_READ_TOKEN: 'READ-TOKEN', CONFIG_WRITE_TOKEN: 'WRITE-TOKEN',
    CONFIG_EDITOR_PRELOAD: '1',
  };
  const req = new Request('https://tv.example.com/');

  await t.test('只给地址与固定 autoConnect=false', () => {
    const defaults = preloadDefaults(env, req);
    assert.deepEqual(defaults, { base: 'https://tv.example.com', autoConnect: false });
    assert.equal(preloadDefaults({ ...env, CONFIG_EDITOR_PRELOAD: '0' }, req), null);
    // 地址预填不涉及机密：默认就注入，省掉手填域名这一步
    assert.equal(preloadDefaults({}, req).base, 'https://tv.example.com');
  });

  await t.test('令牌永远不进页面', () => {
    const tokenOnly = { CONFIG_READ_TOKEN: 'READ-TOKEN', CONFIG_WRITE_TOKEN: 'WRITE-TOKEN' };
    const defaults = preloadDefaults(tokenOnly, req);
    assert.equal(defaults.readToken, undefined);
    assert.equal(defaults.writeToken, undefined);
  });


  await t.test('注入脚本转义 < ，不会闭合 script 标签', () => {
    const html = injectDefaults('<html><head></head><body></body></html>',
      { base: 'https://x', readToken: '</script><script>alert(1)', writeToken: 'W' });
    assert.match(html, /window\.__PURETV_DEFAULTS__/);
    assert.ok(!html.includes('</script><script>alert(1)'));
    assert.match(html, /\\u003c\/script/);
  });

  await t.test('页面注入地址但不含令牌（默认即注入地址）', async () => {
    const withDefaults = await (await editorGet(ctx('GET', '/', { env }))).text();
    assert.match(withDefaults, /window\.__PURETV_DEFAULTS__/);
    assert.ok(withDefaults.includes('https://config.example.com'), '地址应被注入');
    // 页面源码里出现令牌 = 打开域名即拿到写权限，这条断言守住改造成果。
    assert.ok(!withDefaults.includes('READ-TOKEN'));
    assert.ok(!withDefaults.includes('WRITE-TOKEN'));
    const plain = await (await editorGet(ctx('GET', '/'))).text();
    // 没有环境变量时同样只注入同源地址：地址不是机密，省掉手填一眼
    assert.match(plain, /window\.__PURETV_DEFAULTS__/);
    assert.ok(plain.includes('https://config.example.com'));
    assert.ok(!plain.includes('READ-TOKEN'));
  });
});

test('编辑器账号：环境变量初始化、会话鉴权、改密码与失败限流', async (t) => {
  const savedKv = globalThis.PURETV_KV;
  const fresh = new MemoryKV();
  globalThis.PURETV_KV = fresh;
  t.after(() => { globalThis.PURETV_KV = savedKv; });

  const env = {
    CONFIG_READ_TOKEN: 'READ-TOKEN',
    CONFIG_WRITE_TOKEN: 'WRITE-TOKEN',
    CONFIG_ADMIN_USER: 'admin',
    CONFIG_ADMIN_PASSWORD: 'secret-pass-1',
  };
  const login = (body, e = env) => authLogin(ctx('POST', '/api/auth/login', { body, env: e }));
  const bearer = (token) => ({ Authorization: 'Bearer ' + token });

  await t.test('未配置账号：登录与状态都给出可执行提示', async () => {
    const status = await json(await authStatusGet(ctx('GET', '/api/auth/status', { env: {} })));
    assert.equal(status.initialized, false);
    assert.match(status.hint, /CONFIG_ADMIN_PASSWORD/);

    const res = await login({ username: 'admin', password: 'secret-pass-1' }, {});
    assert.equal(res.status, 503);
    assert.equal((await json(res)).error, 'auth_not_initialized');
  });

  await t.test('环境变量首次初始化账号，状态转为已配置', async () => {
    const status = await json(await authStatusGet(ctx('GET', '/api/auth/status', { env })));
    assert.equal(status.initialized, true);
    // 只是探测，不应该把账号写进 KV——真正落库发生在第一次成功登录时。
    assert.equal(fresh.map.has('auth_account'), false);

    const res = await login({ username: 'admin', password: 'secret-pass-1' });
    assert.equal(res.status, 200);
    assert.equal(fresh.map.has('auth_account'), true);
    // 存储里只有 PBKDF2 哈希，没有明文密码
    const stored = JSON.parse(fresh.map.get('auth_account'));
    assert.equal(stored.hash.length, 64);
    assert.ok(!JSON.stringify(stored).includes('secret-pass-1'));
  });

  await t.test('密码错被拒；账号错与密码错返回同一提示', async () => {
    const badPass = await login({ username: 'admin', password: 'nope-nope' });
    const badUser = await login({ username: 'guest', password: 'secret-pass-1' });
    assert.equal(badPass.status, 401);
    assert.equal(badUser.status, 401);
    assert.equal((await json(badPass)).message, (await json(badUser)).message);
  });

  await t.test('会话可读写，且不依赖真实令牌', async () => {
    fresh.map.delete('auth_account'); // 换一轮干净状态，避免上一组失败计数干扰
    const res = await login({ username: 'admin', password: 'secret-pass-1' });
    const data = await json(res);
    assert.match(data.token, /^[0-9a-f]{64}$/);
    assert.equal(data.user, 'admin');
    assert.ok(data.expiresAt > Date.now());
    assert.equal(data.base, BASE);
    assert.ok(!JSON.stringify(data).includes('WRITE-TOKEN'));

    const read = await configGet(ctx('GET', '/api/config', { headers: bearer(data.token), env }));
    assert.equal(read.status, 200, '会话应能读配置');
    // 会话等价管理员：写接口同样放行（这里用改密码接口验证「写」这条路径）
    const pwd = await authPasswordPost(ctx('POST', '/api/auth/password', {
      headers: bearer(data.token),
      body: { oldPassword: 'secret-pass-1', newPassword: 'secret-pass-2' },
      env,
    }));
    assert.equal(pwd.status, 200, '会话应能进入写接口');
  });

  await t.test('改密码后旧会话立即失效，新密码可登录', async () => {
    fresh.map.clear();
    const first = await json(await login({ username: 'admin', password: 'secret-pass-1' }));
    const other = await json(await login({ username: 'admin', password: 'secret-pass-1' }));

    const changed = await authPasswordPost(ctx('POST', '/api/auth/password', {
      headers: bearer(first.token),
      body: { oldPassword: 'secret-pass-1', newPassword: 'secret-pass-2' },
      env,
    }));
    assert.equal(changed.status, 200);

    // 两个会话都必须失效：只作废「当前这一个」等于把旧设备留在登录态
    for (const token of [first.token, other.token]) {
      const check = await authSessionGet(ctx('GET', '/api/auth/session', { headers: bearer(token), env }));
      assert.equal(check.status, 401);
    }
    const stale = await login({ username: 'admin', password: 'secret-pass-1' });
    assert.equal(stale.status, 401, '旧密码不应再能登录');
    const ok = await login({ username: 'admin', password: 'secret-pass-2' });
    assert.equal(ok.status, 200);
  });

  await t.test('改密码：旧密码错 / 新密码过短 / 与原密码相同都被拒', async () => {
    fresh.map.clear();
    const session = await json(await login({ username: 'admin', password: 'secret-pass-1' }));
    const post = (body) => authPasswordPost(ctx('POST', '/api/auth/password', {
      headers: bearer(session.token), body, env,
    }));
    assert.equal((await post({ oldPassword: 'wrong-old', newPassword: 'another-pass' })).status, 400);
    assert.equal((await post({ oldPassword: 'secret-pass-1', newPassword: 'short' })).status, 400);
    assert.equal((await post({ oldPassword: 'secret-pass-1', newPassword: 'secret-pass-1' })).status, 400);
  });

  await t.test('登出后会话失效，且重复登出仍返回 200', async () => {
    fresh.map.clear();
    const session = await json(await login({ username: 'admin', password: 'secret-pass-1' }));
    const out1 = await authLogoutPost(ctx('POST', '/api/auth/logout', { headers: bearer(session.token), env }));
    assert.equal(out1.status, 200);
    const check = await authSessionGet(ctx('GET', '/api/auth/session', { headers: bearer(session.token), env }));
    assert.equal(check.status, 401);
    const out2 = await authLogoutPost(ctx('POST', '/api/auth/logout', { headers: bearer(session.token), env }));
    assert.equal(out2.status, 200);
  });

  await t.test('连续失败 5 次后锁定，锁定期间正确密码也不放行', async () => {
    fresh.map.clear();
    for (let i = 0; i < 5; i += 1) {
      const res = await login({ username: 'admin', password: 'bad-' + i });
      assert.equal(res.status, 401);
    }
    const locked = await login({ username: 'admin', password: 'secret-pass-1' });
    assert.equal(locked.status, 429);
    const data = await json(locked);
    assert.equal(data.error, 'too_many_attempts');
    assert.ok(data.retryAfterSeconds > 0);
  });

  await t.test('真实令牌仍然直连（终端不受改造影响）', async () => {
    // 终端只带 CONFIG_READ_TOKEN：没有会话也必须能拉配置
    const read = await configGet(ctx('GET', '/api/config', {
      headers: bearer('READ-TOKEN'), env,
    }));
    assert.equal(read.status, 200);
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

  // 回归（2026-11-16 审查 #1）：FQDN 尾点与 *.localhost 曾绕过 "$" 锚定的正则。
  // new URL() 会保留尾点（hostname === 'localhost.'），而兜底的「无点号即拒绝」
  // 对含点的 localhost. 不生效，导致 http://localhost./ 被判为公网地址。
  await t.test('拒绝 FQDN 尾点与 *.localhost 变体', () => {
    const blocked = [
      'http://localhost./x', 'http://LOCALHOST./x', 'http://localhost../x',
      'http://a.localhost./x', 'http://foo.localhost/x', 'http://nas.local./list.m3u',
      'http://internal./x',
    ];
    for (const url of blocked) {
      assert.equal(checkFetchUrl(url).ok, false, `${url} 应被拒绝`);
    }
    // 正常带尾点的公网域名不应被误伤。
    assert.equal(checkFetchUrl('http://example.com./list.m3u').ok, true);
  });

  // 回归（2026-11-16 审查 #2）：IPv4-mapped IPv6 的十六进制压缩形式。
  // new URL() 把 ::ffff:127.0.0.1 规范化成 ::ffff:7f00:1，把云元数据地址
  // ::ffff:169.254.169.254 规范化成 ::ffff:a9fe:a9fe，原点分十进制判断全部漏掉。
  await t.test('拒绝 IPv4-mapped IPv6 的十六进制形式', () => {
    const blocked = [
      'http://[::ffff:127.0.0.1]/x', 'http://[::ffff:10.0.0.1]/x',
      'http://[::ffff:192.168.1.1]/x', 'http://[::ffff:169.254.169.254]/x',
      'http://[0:0:0:0:0:ffff:7f00:1]/x', 'http://[::ffff:7f00:1]/x',
      'http://[::ffff:a9fe:a9fe]/x',
    ];
    for (const url of blocked) {
      assert.equal(checkFetchUrl(url).ok, false, `${url} 应被拒绝`);
    }
    // 字面量 IPv6 本地地址原本就在拦截列表，确认没被本次改动影响。
    assert.equal(checkFetchUrl('http://[::1]/x').ok, false);
    assert.equal(checkFetchUrl('http://[2606:4700:4700::1111]/x').ok, true);
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

/**
 * 线上回归（2026-11-15）：EdgeOne Pages Functions 的 response.body 是「空流」，
 * getReader().read() 第一次就 done:true，但 arrayBuffer() 有完整内容。
 * 旧实现流优先 → 所有订阅抓成 0 字节 → 编辑器全线「无法解析」。
 */
test('请求体读取：EdgeOne 空流场景不能把写接口打成 500', async (t) => {
  // 2026-11-17 线上事故回归：EdgeOne 的 request.body 能 getReader()，但读出来是空流；
  // 一旦先调 getReader()，body 就被 lock，随后回退 request.text() 必抛「Body is unusable」，
  // 被 handle 兜底成 500「服务端内部错误: Error」，导致保存套餐 / 开机公告 / 上传壁纸
  // 等全部写接口失败。修法：整体读取（text）优先，流式只作兜底，且已用过的 body 不再二次读。
  const jsonRequest = () => ({
    method: 'PUT',
    url: `${BASE}/api/bundles`,
    headers: new Headers({ 'content-type': 'application/json', 'content-length': '9' }),
    body: {
      getReader() {
        // 复刻线上：空流，且一被调用就等价于「body 已锁定」
        return { async read() { return { done: true, value: undefined }; } };
      },
    },
    async text() { return '{"ok":1}'; },
  });

  await t.test('整体读取优先，能正常解析 JSON', async () => {
    assert.deepEqual(await readJsonBody(jsonRequest()), { ok: 1 });
  });

  await t.test('text 不可用时退回流式读取', async () => {
    const enc = new TextEncoder();
    const chunks = [enc.encode('{"a":'), enc.encode('2}')];
    const request = {
      method: 'POST',
      url: `${BASE}/api/bundles`,
      headers: new Headers({}),
      body: {
        getReader() {
          let i = 0;
          return {
            async read() {
              return i < chunks.length
                ? { done: false, value: chunks[i++] }
                : { done: true, value: undefined };
            },
          };
        },
      },
      async text() { throw new TypeError('text 不可用'); },
    };
    assert.deepEqual(await readJsonBody(request), { a: 2 });
  });

  await t.test('body 已被消费时不再二次读取，也不抛二次异常', async () => {
    let locked = false;
    const request = {
      method: 'PUT',
      url: `${BASE}/api/bundles`,
      headers: new Headers({}),
      get bodyUsed() { return locked; },
      get body() {
        return {
          get locked() { return locked; },
          getReader() { locked = true; return { async read() { return { done: true, value: undefined }; } }; },
        };
      },
      async text() { locked = true; return '{"x":1}'; },
    };
    assert.deepEqual(await readJsonBody(request), { x: 1 });
  });

  await t.test('读取失败返回 400 body_unreadable，而不是 500', async () => {
    const request = {
      method: 'POST',
      url: `${BASE}/api/bundles`,
      headers: new Headers({}),
      body: null,
      async text() { throw new Error('stream locked'); },
    };
    const response = await handle({ env: {}, request }, async ({ request: req }) => {
      await readJsonBody(req);
      return new Response('unreachable');
    });
    assert.equal(response.status, 400);
    const payload = JSON.parse(await response.text());
    assert.equal(payload.error, 'body_unreadable');
    assert.match(payload.message, /stream locked/);
  });

  await t.test('未知异常仍然是 500，但带上真实 message 便于定位', async () => {
    const request = { method: 'GET', url: `${BASE}/api/bundles`, headers: new Headers({}) };
    const response = await handle({ env: {}, request }, async () => {
      throw new Error('storage exploded');
    });
    assert.equal(response.status, 500);
    const payload = JSON.parse(await response.text());
    assert.equal(payload.error, 'internal_error');
    assert.match(payload.message, /storage exploded/);
  });
});

test('IPTV 云端代理：边缘运行时响应体读取与内容判定', async (t) => {
  const savedFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = savedFetch; });
  const enc = new TextEncoder();

  /** 可分别控制 arrayBuffer() 与 body 流的假 Response，用来复刻各运行时差异。 */
  const fakeResponse = ({
    bytes = null, stream = [], status = 200,
    contentType = 'text/plain; charset=utf-8',
  } = {}) => ({
    status,
    ok: status >= 200 && status < 300,
    headers: new Headers({ 'content-type': contentType }),
    async arrayBuffer() {
      if (bytes === null) throw new TypeError('arrayBuffer 不支持');
      return Uint8Array.from(bytes).buffer;
    },
    body: {
      getReader() {
        let i = 0;
        return {
          async read() {
            if (i >= stream.length) return { done: true, value: undefined };
            return { done: false, value: Uint8Array.from(stream[i++]) };
          },
        };
      },
    },
  });

  const post = (urls) => iptvFetchPost(ctx('POST', '/api/iptv/fetch', {
    headers: { 'Content-Type': 'application/json' },
    body: { urls },
  }));

  await t.test('空流但 arrayBuffer 有内容时仍能抓到全文（EdgeOne 回归）', async () => {
    const body = [...enc.encode('#EXTM3U\n#EXTINF:-1 group-title="央视",CCTV1\nhttp://a.example.com/1.m3u8\n')];
    globalThis.fetch = async () => fakeResponse({ bytes: body, stream: [] });
    const data = await json(await post(['https://example.com/list.m3u']));
    assert.equal(data.succeeded, 1);
    assert.equal(data.results[0].bytes, body.length);
    assert.match(data.text, /CCTV1/);
  });

  await t.test('arrayBuffer 不可用时会退回流式读取', async () => {
    globalThis.fetch = async () => fakeResponse({
      bytes: null,
      stream: [enc.encode('#EXTM3U\n'), enc.encode('http://a.example.com/1.m3u8\n')],
    });
    const data = await json(await post(['https://example.com/list.m3u']));
    assert.equal(data.succeeded, 1);
    assert.match(data.text, /#EXTM3U/);
    assert.match(data.text, /1\.m3u8/);
  });

  await t.test('真正空的响应明确判失败，不再伪装成抓取成功', async () => {
    globalThis.fetch = async () => fakeResponse({ bytes: [], stream: [] });
    const data = await json(await post(['https://example.com/empty.m3u']));
    assert.equal(data.succeeded, 0);
    assert.equal(data.results[0].ok, false);
    assert.match(data.results[0].error, /空内容/);
    assert.equal(data.results[0].httpStatus, 200);
    assert.equal(data.text.trim(), '');
  });

  await t.test('图片 / 二进制响应给出人话提示，不当乱码文本解析', async () => {
    const jpeg = [0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0, 1, 0, 1];
    globalThis.fetch = async () => fakeResponse({ bytes: jpeg, contentType: 'text/plain' });
    let data = await json(await post(['https://example.com/tv']));
    assert.equal(data.succeeded, 0);
    assert.match(data.results[0].error, /JPEG 图片/);
    assert.match(data.results[0].error, /不是订阅文本/);

    globalThis.fetch = async () => fakeResponse({ bytes: [...enc.encode('<html>ok</html>')], contentType: 'image/jpeg' });
    data = await json(await post(['https://example.com/tv']));
    assert.match(data.results[0].error, /image\/jpeg/);
  });

  await t.test('HTML 反爬页 / 首页跳转被识别', async () => {
    globalThis.fetch = async () => fakeResponse({
      bytes: [...enc.encode('<!DOCTYPE html><html lang="en">...</html>')],
      contentType: 'text/html',
    });
    const data = await json(await post(['https://example.com/tv']));
    assert.equal(data.succeeded, 0);
    assert.match(data.results[0].error, /HTML 网页/);
  });

  await t.test('中文路径 percent-encode、中文域名 punycode 后发起请求', async () => {
    const seen = [];
    globalThis.fetch = async (url) => {
      seen.push(url);
      return fakeResponse({ bytes: [...enc.encode('#EXTM3U\n')] });
    };
    const data = await json(await post([
      'https://live.hacks.tools/tv/ipv4/categories/央视频道.m3u',
      'http://www.饭太硬.net/tv',
    ]));
    assert.equal(data.succeeded, 2);
    assert.match(seen[0], /%E5%A4%AE%E8%A7%86%E9%A2%91%E9%81%93\.m3u/);
    assert.match(seen[1], /xn--sss604efuw\.net/);
    assert.equal(data.results[1].finalUrl, 'http://www.xn--sss604efuw.net/tv');
  });

  await t.test('M3U 的 audio/x-mpegurl 是合法文本，不能被误判成二进制', async () => {
    const body = [...enc.encode('#EXTM3U\n#EXTINF:-1 group-title="央视",CCTV1\nhttp://a.example.com/1.m3u8\n')];
    globalThis.fetch = async () => fakeResponse({ bytes: body, contentType: 'audio/x-mpegurl' });
    const data = await json(await post(['https://example.com/list.m3u']));
    assert.equal(data.succeeded, 1, data.results[0].error);
    assert.equal(data.results[0].bytes, body.length);
    assert.match(data.text, /CCTV1/);
  });

  await t.test('GBK 中文订阅不会被误判成二进制', () => {
    const gbk = new Uint8Array([0xD1, 0xEB, 0xCA, 0xD3]); // 「央视」
    assert.equal(detectBinaryPayload(gbk, 'text/plain'), '');
    assert.equal(detectBinaryPayload(enc.encode('#EXTM3U\n'), 'audio/x-mpegurl'), '');
    assert.equal(detectBinaryPayload(enc.encode('{"sites":[]}'), 'application/vnd.apple.mpegurl'), '');
    assert.equal(detectBinaryPayload(new Uint8Array([0xFF, 0xD8, 0xFF]), 'text/plain'), 'JPEG 图片');
    assert.equal(detectBinaryPayload(new Uint8Array([0xFF, 0xD8, 0xFF]), 'image/x-ms-bmp'), 'JPEG 图片');
    assert.equal(detectBinaryPayload(new Uint8Array(), 'image/png'), 'image/png 内容');
  });
});

test('TVBox 配置解析：BOM / 注释 / 尾部逗号 / base64 封装', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('../editor/app.js', import.meta.url), 'utf8');
  const start = source.indexOf('function decodeTvboxBase64(');
  const end = source.indexOf('function resolveVodAsset(');
  assert.ok(start > 0 && end > start, 'app.js 里找不到 TVBox 解析函数');
  const parse = new Function(source.slice(start, end) + '; return parseTvboxJson;')();

  assert.deepEqual(parse('\uFEFF{"sites":[{"key":"a","api":"csp_X"}]}').sites,
    [{ key: 'a', api: 'csp_X' }], 'UTF-8 BOM 应被剥离');
  assert.deepEqual(parse('// 仓库注释\n{"sites":[],}').sites, [], '整行注释与尾部逗号应被容忍');
  const cfg = {
    sites: [{ key: 'a', api: 'https://a.example.com/api.php' }],
    spider: './a.jar;md5;abcdef0123456789',
  };
  const b64 = Buffer.from(JSON.stringify(cfg), 'utf8').toString('base64');
  assert.equal(parse(b64).sites[0].api, 'https://a.example.com/api.php', 'base64 封装应能解开');
  assert.throws(() => parse('<html>不是配置</html>'), /不是合法 JSON/, '非配置内容应报可读错误');
});

test('终端在线/离线常驻显示，且不依赖连接设备', async () => {
  const { readFile } = await import('node:fs/promises');
  const html = await readFile(new URL('../editor/index.html', import.meta.url), 'utf8');
  const css = await readFile(new URL('../editor/style.css', import.meta.url), 'utf8');
  const app = await readFile(new URL('../editor/app.js', import.meta.url), 'utf8');
  const page = await readFile(new URL('../edge-functions/_lib/editor.js', import.meta.url), 'utf8');

  assert.match(html, /id="deviceStatus"/, '状态条容器必须常驻在 statusbar');
  assert.match(css, /\.dev-chip\.on/, '在线/离线徽标样式缺失');
  for (const mark of ['renderDeviceStatus', 'loadDeviceStatus', 'deviceStatusError']) {
    assert.ok(app.includes(mark), `editor/app.js 缺少 ${mark}`);
    assert.ok(page.includes(mark), `内联生成物缺少 ${mark}`);
  }
  assert.match(app, /activeTab === 'devices'/, '终端管理页签未从「未连接」门槛放行');
  assert.match(app, /setInterval/, '缺少定时刷新，状态会过期');
  assert.match(app, /loadDeviceStatus\(\);/, '初始化时未立即拉取状态');
  assert.match(app, /在线 ' \+ online/, '状态条未显示在线台数');
});

test('TVBox 源双轨：mode 规范化、URL 下发与解析站点兜底', async () => {
  const { readFile } = await import('node:fs/promises');
  const [library] = normalizeLibrary({
    vod: {
      sources: [
        { id: 'vs_aaaaaaaa', name: '解析源', url: 'https://a.example.com/config.json' },
        { id: 'vs_bbbbbbbb', name: '直连源', url: 'https://b.example.com/tv', mode: 'url' },
        { id: 'vs_cccccccc', name: '脏值', url: 'https://c.example.com/tv', mode: 'bogus' },
      ],
      sites: [
        { sourceId: 'vs_aaaaaaaa', key: 'a1', name: 'A1', api: 'https://a.example.com/api.php' },
        { sourceId: 'vs_bbbbbbbb', key: 'b1', name: 'B1', api: 'csp_B1', type: 3 },
      ],
    },
  });
  assert.deepEqual(library.vod.sources.map((s) => s.mode), ['parsed', 'url', 'parsed'],
    '未指定 / 非法 mode 一律回退 parsed');

  const [sections] = normalizeSections({
    vod: { managed: true, sourceIds: ['vs_aaaaaaaa', 'vs_bbbbbbbb'] },
  });
  const out = expandVodSites(sections, library);
  assert.equal(out.vod.sources[0].url, 'https://a.example.com/config.json');
  assert.equal(out.vod.sources[0].mode, 'parsed');
  assert.equal(out.vod.sources[1].url, 'https://b.example.com/tv', 'URL 必须随文档下发');
  assert.equal(out.vod.sources[1].mode, 'url');
  assert.equal(out.vod.sites.length, 2, 'url 模式仍下发云端站点作为终端解析失败的兜底');

  const [inline] = normalizeSections({
    vod: { sources: [{ id: 'vs_dddddddd', url: 'https://d.example.com/tv', mode: 'url' }], sites: [] },
  });
  assert.equal(inline.vod.sources[0].url, 'https://d.example.com/tv');
  assert.equal(inline.vod.sources[0].mode, 'url', '锁定快照的内联源也要保留模式');

  const app = await readFile(new URL('../editor/app.js', import.meta.url), 'utf8');
  const page = await readFile(new URL('../edge-functions/_lib/editor.js', import.meta.url), 'utf8');
  assert.match(app, /vod-source-mode/, '编辑器缺少下发模式切换入口');
  assert.ok(page.includes('vod-source-mode'), '内联生成物缺少模式切换入口');
  assert.match(app, /mode: 'parsed'/, '新建源未默认走云端解析');
});

test('TVBox 站点级 jar 保留：库入库出、随文档下发，聚合族 jar 不丢', async () => {
  // 聚合配置里各族站点靠站点级 jar 指向自己的爬虫包；任何一层丢字段都会
  // 让终端报「在 jar 里找不到类 com.github.catvod.spider.XxxGuard」。
  const [library] = normalizeLibrary({
    vod: {
      sources: [
        { id: 'vs_aaaaaaaa', name: '聚合', url: 'https://a.example.com/output/单仓聚合.json', jar: 'https://jar.example.com/main.jar' },
      ],
      sites: [
        {
          sourceId: 'vs_aaaaaaaa', key: 'own', name: '带jar', api: 'csp_Own', type: 3,
          // `url;md5;hash` 写法 + 相对路径，按所属源的配置地址解析。
          jar: './libs/jar/Panda.jar;md5;00112233445566778899aabbccddeeff',
        },
        {
          sourceId: 'vs_aaaaaaaa', key: 'wex', name: '族jar', api: 'csp_WexmuouggGuard', type: 3,
          jar: 'https://family.example.com/wex.jar;md5;11223344556677889900aabbccddeeff',
        },
        { sourceId: 'vs_aaaaaaaa', key: 'http', name: '采集', api: 'https://a.example.com/api.php' },
      ],
    },
  });
  const [own, wex, httpSite] = library.vod.sites;
  assert.equal(own.jar, 'https://a.example.com/output/libs/jar/Panda.jar', '相对 jar 要按源地址解析');
  assert.equal(own.jarMd5, '00112233445566778899aabbccddeeff');
  assert.equal(wex.jar, 'https://family.example.com/wex.jar');
  assert.equal(wex.jarMd5, '11223344556677889900aabbccddeeff');
  assert.equal(httpSite.jar, '', 'http 站点不需要 jar');

  const [sections] = normalizeSections({
    vod: { managed: true, sourceIds: ['vs_aaaaaaaa'] },
  });
  const out = expandVodSites(sections, library);
  assert.equal(out.vod.sites.length, 3);
  assert.equal(out.vod.sites[0].jar, 'https://a.example.com/output/libs/jar/Panda.jar', '展开下发不能丢站点级 jar');
  assert.equal(out.vod.sites[1].jar, 'https://family.example.com/wex.jar');
  assert.equal(out.vod.sites[1].jarMd5, '11223344556677889900aabbccddeeff');

  const [inline] = normalizeSections({
    vod: {
      sources: [{ id: 'vs_dddddddd', url: 'https://d.example.com/tv', jar: 'https://jar.example.com/main.jar' }],
      sites: [
        { id: 'vs_dddddddd:x', sourceId: 'vs_dddddddd', name: 'X', api: 'csp_X', type: 3, jar: 'https://family.example.com/wex.jar', jarMd5: 'aabbccdd' },
      ],
    },
  });
  assert.equal(inline.vod.sites[0].jar, 'https://family.example.com/wex.jar', '锁定快照的内联站点也要带 jar');
  assert.equal(inline.vod.sites[0].jarMd5, 'aabbccdd');
});

test('TVBox 解析失败可降级：只下发配置 URL，零站点源仍能下发', async () => {
  const { readFile } = await import('node:fs/promises');
  const app = await readFile(new URL('../editor/app.js', import.meta.url), 'utf8');
  const page = await readFile(new URL('../edge-functions/_lib/editor.js', import.meta.url), 'utf8');

  // 编辑器必须有「跳过解析」按钮、失败降级分支，且内联生成物同步。
  for (const mark of [
    'add-vod-source-url',
    'function buildVodUrlOnlySource(',
    'function addVodSourceUrlOnly(',
    'function offerVodUrlOnlyFallback(',
    'if (offerVodUrlOnlyFallback(why)) return;',
  ]) {
    assert.ok(app.includes(mark), `editor/app.js 缺少 ${mark}`);
    assert.ok(page.includes(mark), `内联生成物缺少 ${mark}`);
  }
  assert.match(app, /不解析，只下发配置 URL/, '按钮文案缺失');

  // 抽取纯构造函数实跑：中文域名 punycode、中文路径 percent-encode，
  // 且必须是零站点的 url 模式（云端不解析）。
  const start = app.indexOf('function normalizeHttpUrl(');
  const end = app.indexOf('function readLibInput(');
  assert.ok(start > 0 && end > start, 'app.js 里找不到 URL 规范化/构造函数');
  const build = new Function(
    'nowIso',
    app.slice(start, end) + '; return buildVodUrlOnlySource;',
  )(() => '2026-11-15T00:00:00.000Z');

  const direct = build('http://www.饭太硬.net/tv', 'vs_deadbeef');
  assert.equal(direct.mode, 'url');
  assert.equal(direct.siteCount, 0, '云端没解析出站点就不能虚报');
  assert.equal(direct.url, 'http://www.xn--sss604efuw.net/tv');
  assert.equal(direct.jar, '');
  assert.equal(direct.addedAt, '2026-11-15T00:00:00.000Z');

  const cnPath = build('https://live.hacks.tools/tv/ipv4/categories/央视频道.m3u', 'vs_12345678');
  assert.match(cnPath.url, /%E5%A4%AE%E8%A7%86%E9%A2%91%E9%81%93\.m3u/);
  assert.equal(cnPath.mode, 'url');
  assert.throws(() => build('ftp://x.example.com/tv', 'x'), /仅支持 http/);

  // 端到端：零站点的 url 源经资源库规范化 + 设备展开后仍必须出现在下发文档里。
  const [library, warnings] = normalizeLibrary({
    vod: {
      sources: [{
        id: 'vs_deadbeef', name: '饭太硬', url: 'http://www.xn--sss604efuw.net/tv',
        mode: 'url', siteCount: 0, jar: '', spiderMd5: '', spiderFlavor: 'fongmi',
      }],
      sites: [],
    },
  });
  assert.equal(library.vod.sources.length, 1, '零站点 url 源不能被资源库规范化丢弃');
  assert.equal(library.vod.sources[0].mode, 'url');
  assert.equal(library.vod.sources[0].siteCount, 0);
  assert.ok(!warnings.some((w) => w.includes('忽略非法接口地址')));

  const [sections] = normalizeSections({
    vod: { managed: true, sourceIds: ['vs_deadbeef'] },
  });
  const out = expandVodSites(sections, library);
  assert.equal(out.vod.sources.length, 1, '按设备勾选后零站点 url 源必须下发');
  assert.equal(out.vod.sources[0].url, 'http://www.xn--sss604efuw.net/tv');
  assert.equal(out.vod.sources[0].mode, 'url');
  assert.equal(out.vod.sites.length, 0, '云端解析失败时无兜底站点，由终端自行拉取');
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

  await t.test('彻底删除只移除注册项，不拉黑；终端可重新登记', async () => {
    const purged = await json(await post({ action: 'purge', deviceId: 'tv-a' }));
    assert.equal(purged.results[0].purged, true);
    assert.notEqual(purged.results[0].blocked, true, '删除不应写黑名单');
    const data = await list();
    assert.equal(data.total, 0);
    assert.deepEqual(data.blocked, [], '删除不应把设备拉黑');
    // 没被拉黑 → 终端再拉配置会重新登记，且不再 403。
    const again = await configGet(ctx('GET', '/api/config?deviceId=tv-a', { env }));
    assert.equal(again.status, 200);
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

  await t.test('退出弹窗二维码、捐赠说明与按钮文案全部云端下发', () => {
    const [sections, warnings] = normalizeSections({ startup: { exitDialog: {
      enabled: true,
      titleI18n: { zh: '确定要退出吗' },
      bodyI18n: { zh: '感谢使用，期待下次再见' },
      qrImageUrl: 'https://cdn.example.com/qr.png',
      qrCaptionI18n: { zh: '扫码支持' },
      donateBodyI18n: { zh: '扫码请开发者喝瓶牛奶' },
      confirmTextI18n: { zh: '退出' },
      cancelTextI18n: { zh: '再想想' },
    } } });
    const dialog = sections.startup.exitDialog;
    assert.equal(dialog.qrImageUrl, 'https://cdn.example.com/qr.png');
    assert.equal(dialog.qrCaptionI18n.zh, '扫码支持');
    assert.equal(dialog.donateBodyI18n.zh, '扫码请开发者喝瓶牛奶');
    assert.equal(dialog.confirmTextI18n.zh, '退出');
    assert.equal(dialog.cancelTextI18n.zh, '再想想');
    assert.equal(warnings.length, 0);
    // 二维码只接受 http(s)，防止把本地路径或伪协议下发到终端
    assert.throws(() => normalizeSections({ startup: { exitDialog: { qrImageUrl: 'ftp://x/y.png' } } }),
      /http\(s\)/);
  });

  await t.test('navigation.groups 三大类与 defaultGroupId 兜底', () => {
    const [defaults] = normalizeSections({});
    assert.equal(defaults.navigation.groups.length, 3);
    assert.deepEqual(defaults.navigation.groups.map((g) => g.id),
      ['iptv', 'vod', 'settings']);
    assert.deepEqual(defaults.navigation.railMenuIds,
      ['iptv', 'vodBrowse', 'moviePlayback']);
    assert.equal(defaults.navigation.defaultGroupId, 'iptv');
    const [custom, warnings] = normalizeSections({ navigation: {
      groups: [
        { id: 'iptv', label: '电视', children: ['iptv', 'unknown'] },
        { id: 'live', label: '直播（已下线）', children: ['iptv'] },
        { id: 'nope', label: '非法', children: [] },
      ],
      defaultGroupId: 'nope',
    } });
    assert.equal(custom.navigation.groups.length, 1);
    assert.deepEqual(custom.navigation.groups[0].children, ['iptv']);
    assert.equal(custom.navigation.defaultGroupId, 'iptv');
    assert.ok(warnings.some((w) => w.includes('非法或重复的一级块')));
  });

  await t.test('默认影音块含影视点播，且 vodBrowse 是合法二级项', () => {
    const [defaults] = normalizeSections({});
    const vod = defaults.navigation.groups.find((g) => g.id === 'vod');
    assert.ok(vod.children.includes('vodBrowse'), '影音块必须默认展开影视点播');
    assert.ok(defaults.navigation.railMenuIds.includes('vodBrowse'), '白名单必须含影视点播');
    const [custom, warnings] = normalizeSections({ navigation: {
      groups: [{ id: 'vod', children: ['vodBrowse', 'moviePlayback'] }],
    } });
    assert.deepEqual(custom.navigation.groups[0].children, ['vodBrowse', 'moviePlayback']);
    assert.ok(!warnings.some((w) => w.includes('未知二级项')));
  });

  await t.test('编辑器可编辑每个一级块的 children', async () => {
    const { readFile } = await import('node:fs/promises');
    const source = await readFile(new URL('../editor/app.js', import.meta.url), 'utf8');
    assert.ok(source.includes("'navigation.groups.' + index + '.children'"),
      '缺少分组 children 的编辑入口（旧文档无法补上影视点播）');
    assert.ok(source.includes("id: 'settings'"), 'settings 是合法二级项，须在分组可选项里');
  });

  await t.test('编辑器与种子配置已彻底移除直播平台', async () => {
    const { readFile } = await import('node:fs/promises');
    const html = await readFile(new URL('../editor/index.html', import.meta.url), 'utf8');
    const source = await readFile(new URL('../editor/app.js', import.meta.url), 'utf8');
    const seed = JSON.parse(await readFile(new URL('../config/seed.json', import.meta.url), 'utf8'));
    const catalog = JSON.parse(await readFile(new URL('../config/site_catalog.json', import.meta.url), 'utf8'));

    assert.ok(!html.includes('data-tab="sites"'), '编辑器仍有直播平台页签');
    assert.ok(!source.includes('renderSites'), '编辑器仍有直播平台渲染逻辑');
    // 导航 / 启动 / 退出弹窗 / IPTV 下发 都已收进「套餐管理」，顶层只留四个页签。
    assert.match(html, /data-tab="bundles" class="active"/, '默认页签应为套餐管理');
    assert.match(source, /activeTab:\s*'bundles'/);
    assert.ok(!html.includes('data-tab="iptv"'), 'IPTV 下发页签应已并入套餐');
    assert.ok(!html.includes('data-tab="navigation"'), '导航栏页签应已并入套餐');
    assert.ok(!html.includes('data-tab="startup"'), '启动页签应已并入套餐');

    // 顶栏不再有「按文档编辑」的入口：云端只有套餐 / 源 / 终端三样东西。
    assert.ok(!html.includes('id="deviceSelect"'), '顶栏仍有「当前编辑」下拉');
    assert.ok(!html.includes('id="btnSave"'), '顶栏仍有保存按钮');
    assert.ok(!html.includes('id="btnPush"'), '顶栏仍有下发按钮');
    assert.ok(!html.includes('id="btnRaw"'), '顶栏仍有原始 JSON');
    assert.ok(!html.includes('id="btnHistory"'), '顶栏仍有历史回滚');
    // 终端行只有：改名 / 下发配置 / 拉黑 / 移除 / 删除，没有逐台编辑。
    assert.ok(!source.includes('data-device="settings"'), '终端行仍有「编辑设置」');
    assert.ok(!source.includes('data-device="reset"'), '终端行仍有「重置为模板」');
    assert.ok(source.includes('data-device="block"'), '终端行缺少「拉黑」');

    assert.ok(!('sites' in seed.sections), 'seed 仍带直播平台节');
    assert.deepEqual(catalog.sites, [], 'catalog 仍列出直播平台');
    assert.deepEqual(seed.sections.navigation.groups.map((g) => g.id),
      ['iptv', 'vod', 'settings']);
    assert.deepEqual(seed.sections.navigation.railMenuIds,
      ['iptv', 'vodBrowse', 'moviePlayback']);
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
      managed: false, sourceIds: [], siteIds: [], defaultSiteId: '',
      sources: [], sites: [], lockLibrary: false, libraryRevision: 0,
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
    assert.deepEqual(data.vod, { sources: [], sites: [], defaultSiteId: '' });

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
      managed: false, sourceIds: [], siteIds: [], defaultSiteId: '',
      sources: [], sites: [], lockLibrary: false, libraryRevision: 0,
    });
    assert.deepEqual(doc.sections.iptv.packageIds, []);
  });

  await t.test('库变更触发 bump 不写快照：历史条目不增不减，current revision 仍递增', async () => {
    await deviceGet('tv-hist');
    // 两次真实编辑 → 留下 revision 2、3 两条快照
    assert.equal((await devicePut('tv-hist', {
      navigation: { managed: true, railMenuIds: ['iptv'] },
    }, 1)).status, 200);
    assert.equal((await devicePut('tv-hist', {
      iptv: { managed: true, packageIds: [PACKAGE_ID], libraryRevision: 4 },
      navigation: { managed: true, railMenuIds: ['iptv', 'vodBrowse'] },
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

/* ================= 资源库 EPG 地址回填到终端视图 ================= */

test('资源库 EPG 地址回填到 sections.iptv.epgUrl', async (t) => {
  const LIB_EPG = 'https://gitee.com/taksssss/tv/raw/main/epg/51zmt.xml.gz';
  const OWN_EPG = 'https://own.example.com/device.xml.gz';
  const library = {
    iptv: {
      epgUrl: LIB_EPG,
      packages: [{
        id: 'pkg_00000001',
        channels: [{ name: 'CCTV1', url: 'http://lib.example.com/1.ts', group: '央视' }],
      }],
    },
  };

  await t.test('library EPG 回填：expandIptvChannels 与 viewDocument 都生效', () => {
    const [sections] = normalizeSections({ iptv: { managed: true, packageIds: ['pkg_00000001'] } });
    assert.equal(sections.iptv.epgUrl, '');
    const expanded = expandIptvChannels(sections, library);
    assert.equal(expanded.iptv.epgUrl, LIB_EPG);
    assert.equal(expanded.iptv.channels.length, 1);
    assert.equal(sections.iptv.epgUrl, '', '深拷贝：不能污染入参');

    const view = viewDocument(
      { sections: { iptv: { managed: true, packageIds: ['pkg_00000001'] } } }, false, library);
    assert.equal(view.sections.iptv.epgUrl, LIB_EPG);
  });

  await t.test('没引用套餐也回填（必须在无频道早退之前）', () => {
    const [sections] = normalizeSections({ iptv: { managed: true } });
    const expanded = expandIptvChannels(sections, library);
    assert.deepEqual(expanded.iptv.channels, []);
    assert.equal(expanded.iptv.epgUrl, LIB_EPG);
  });

  await t.test('sections 单独配置的 epgUrl 优先，不被 library 覆盖', () => {
    const [sections] = normalizeSections({ iptv: { managed: true, epgUrl: OWN_EPG } });
    assert.equal(expandIptvChannels(sections, library).iptv.epgUrl, OWN_EPG);
    const view = viewDocument({ sections }, false, library);
    assert.equal(view.sections.iptv.epgUrl, OWN_EPG);
  });

  await t.test('unmanaged / lockLibrary / 无 library 都不回填', () => {
    const [unmanaged] = normalizeSections({ iptv: { managed: false } });
    assert.equal(expandIptvChannels(unmanaged, library).iptv.epgUrl, '');
    const [locked] = normalizeSections({ iptv: { managed: true, lockLibrary: true } });
    assert.equal(expandIptvChannels(locked, library).iptv.epgUrl, '');
    assert.ok(!expandIptvChannels({ iptv: { managed: true } }).iptv.epgUrl, '不传 library 不回填');
  });

  await t.test('端到端 GET：资源库 EPG 下发，设备单独配置仍优先', async () => {
    const savedKv = globalThis.PURETV_KV;
    const fresh = new MemoryKV();
    globalThis.PURETV_KV = fresh;
    t.after(() => { globalThis.PURETV_KV = savedKv; });
    const env = {};
    const put = await libraryPut(ctx('PUT', '/api/library', {
      env,
      headers: { 'Content-Type': 'application/json', 'If-Match': '0' },
      body: { iptv: { epgUrl: LIB_EPG, sources: [], packages: [] }, vod: {} },
    }));
    assert.equal(put.status, 200);
    for (const [device, sections] of [
      ['epg-lib', { iptv: { managed: true } }],
      ['epg-own', { iptv: { managed: true, epgUrl: OWN_EPG } }],
    ]) {
      const res = await configPut(ctx('PUT', `/api/config?deviceId=${device}`, {
        env, headers: { 'Content-Type': 'application/json', 'If-Match': '1' }, body: { sections },
      }));
      assert.equal(res.status, 200);
    }
    const lib = await json(await configGet(ctx('GET', '/api/config?deviceId=epg-lib', { env })));
    assert.equal(lib.sections.iptv.epgUrl, LIB_EPG);
    const own = await json(await configGet(ctx('GET', '/api/config?deviceId=epg-own', { env })));
    assert.equal(own.sections.iptv.epgUrl, OWN_EPG);
  });
});

/* ================= TVBox 源：库字段与按源展开 ================= */

test('TVBox 源与站点：库字段、按源展开、白名单与锁定隔离', async (t) => {
  const SOURCE_A = 'vs_aaaaaaaa';
  const SOURCE_B = 'vs_bbbbbbbb';

  const buildLibrary = () => {
    const [library] = normalizeLibrary({
      vod: {
        sources: [
          {
            id: SOURCE_A,
            name: '源A',
            url: 'https://a.example.com/config.json',
            jar: 'https://a.example.com/spider.jar',
          },
          {
            id: SOURCE_B,
            name: '源B',
            url: 'https://b.example.com/config.json',
            // 非 http(s) 的 jar 必须被清空，否则终端会拿它去下载然后报 IO 错
            jar: 'ftp://bad.example.com/spider.jar',
          },
        ],
        sites: [
          { sourceId: SOURCE_A, key: 'a1', name: 'A1', api: 'csp_A1', ext: 'token-a1', type: 3 },
          { sourceId: SOURCE_A, key: 'a2', name: 'A2', api: 'https://a.example.com/api.php/provide/vod', type: 1 },
          { sourceId: SOURCE_B, key: 'b1', name: 'B1', api: 'csp_B1', type: 3 },
        ],
      },
    });
    return library;
  };

  await t.test('库内源保存 jar（仅 http(s)），站点保存 ext', () => {
    const library = buildLibrary();
    assert.equal(library.vod.sources[0].jar, 'https://a.example.com/spider.jar');
    assert.equal(library.vod.sources[1].jar, '');
    assert.equal(library.vod.sites[0].ext, 'token-a1');
    assert.equal(library.vod.sites[1].ext, '');
  });

  await t.test('只引用源时展开该源下全部站点，并下发源 jar', () => {
    const library = buildLibrary();
    const [sections] = normalizeSections({ vod: { managed: true, sourceIds: [SOURCE_A] } });
    const out = expandVodSites(sections, library);

    assert.deepEqual(out.vod.sources.map((item) => item.id), [SOURCE_A]);
    assert.equal(out.vod.sources[0].jar, 'https://a.example.com/spider.jar');
    assert.deepEqual(out.vod.sites.map((item) => item.id), [`${SOURCE_A}:a1`, `${SOURCE_A}:a2`]);
    assert.equal(out.vod.sites[0].api, 'csp_A1');
    assert.equal(out.vod.sites[0].ext, 'token-a1');
    assert.equal(out.vod.sites[0].type, 3);
    // 纯管理字段不下发：站点多的时候这些能占掉一半体积
    assert.equal(out.vod.sites[0].note, undefined);
    assert.equal(out.vod.sites[0].addedAt, undefined);
    assert.equal(out.vod.sites[0].key, undefined);
  });

  await t.test('siteIds 白名单把站点收窄到一个', () => {
    const library = buildLibrary();
    const [sections] = normalizeSections({
      vod: { managed: true, sourceIds: [SOURCE_A], siteIds: [`${SOURCE_A}:a2`] },
    });
    const out = expandVodSites(sections, library);
    assert.deepEqual(out.vod.sites.map((item) => item.id), [`${SOURCE_A}:a2`]);
  });

  await t.test('默认站点：在列表里就下发，被排除则清空', () => {
    const library = buildLibrary();
    const [sections] = normalizeSections({
      vod: { managed: true, sourceIds: [SOURCE_A], defaultSiteId: `${SOURCE_A}:a2` },
    });
    const out = expandVodSites(sections, library);
    assert.equal(out.vod.defaultSiteId, `${SOURCE_A}:a2`, '默认站点要随文档下发');

    // 白名单只留 a1：默认站点 a2 已经不下发了，必须清空——否则终端会拿一个
    // 不存在的站点去开首页，表现为「打开影音直接报错」。
    const [narrowed] = normalizeSections({
      vod: {
        managed: true,
        sourceIds: [SOURCE_A],
        siteIds: [`${SOURCE_A}:a1`],
        defaultSiteId: `${SOURCE_A}:a2`,
      },
    });
    assert.equal(expandVodSites(narrowed, library).vod.defaultSiteId, '');

    // 锁定快照：按内联站点校验，而不是库里的站点
    const [locked] = normalizeSections({
      vod: {
        managed: true,
        lockLibrary: true,
        defaultSiteId: `${SOURCE_A}:only`,
        sources: [{ id: SOURCE_A, name: '快照源' }],
        sites: [{ id: `${SOURCE_A}:only`, sourceId: SOURCE_A, api: 'csp_Old' }],
      },
    });
    assert.equal(expandVodSites(locked, library).vod.defaultSiteId, `${SOURCE_A}:only`);

    // 缺省：老文档没有这个字段 → 空串（终端回退第一个站点）
    const [legacy] = normalizeSections({ vod: { managed: true, sourceIds: [SOURCE_A] } });
    assert.equal(expandVodSites(legacy, library).vod.defaultSiteId, '');
  });

  await t.test('库级默认站点：随库保存，配置没指定时兜底，显式指定优先', () => {
    // 库里的默认站点只在它确实还在站点列表里时才保留
    const [library] = normalizeLibrary({
      vod: {
        sources: [{ id: SOURCE_A, name: '源A', url: 'https://a.example.com/config.json' }],
        sites: [
          { sourceId: SOURCE_A, key: 'a1', name: 'A1', api: 'csp_A1' },
          { sourceId: SOURCE_A, key: 'a2', name: 'A2', api: 'csp_A2' },
        ],
        defaultSiteId: `${SOURCE_A}:a2`,
      },
    });
    assert.equal(library.vod.defaultSiteId, `${SOURCE_A}:a2`, '库级默认站点要能存下来');

    // 源被引用但配置里没指定默认站点 → 用库级默认
    const [plain] = normalizeSections({ vod: { managed: true, sourceIds: [SOURCE_A] } });
    assert.equal(expandVodSites(plain, library).vod.defaultSiteId, `${SOURCE_A}:a2`);

    // 配置里显式指定 → 覆盖库级默认
    const [explicit] = normalizeSections({
      vod: { managed: true, sourceIds: [SOURCE_A], defaultSiteId: `${SOURCE_A}:a1` },
    });
    assert.equal(expandVodSites(explicit, library).vod.defaultSiteId, `${SOURCE_A}:a1`);

    // 库级默认的站点没被下发（白名单只留 a1）→ 不能硬塞，回退空串
    const [narrowed] = normalizeSections({
      vod: { managed: true, sourceIds: [SOURCE_A], siteIds: [`${SOURCE_A}:a1`] },
    });
    assert.equal(expandVodSites(narrowed, library).vod.defaultSiteId, '');

    // 悬空 id 入库时就丢掉，不让它一路传到终端
    const [dropped, warnings] = normalizeLibrary({
      vod: {
        sources: [{ id: SOURCE_A, name: '源A', url: 'https://a.example.com/config.json' }],
        sites: [{ sourceId: SOURCE_A, key: 'a1', name: 'A1', api: 'csp_A1' }],
        defaultSiteId: `${SOURCE_A}:nope`,
      },
    });
    assert.equal(dropped.vod.defaultSiteId, '');
    assert.ok(warnings.some((item) => item.includes('library.vod.defaultSiteId')));
  });

  await t.test('多源同时选中：站点合并、源按引用顺序', () => {    const library = buildLibrary();
    const [sections] = normalizeSections({
      vod: { managed: true, sourceIds: [SOURCE_B, SOURCE_A] },
    });
    const out = expandVodSites(sections, library);
    assert.deepEqual(out.vod.sources.map((item) => item.id), [SOURCE_B, SOURCE_A]);
    assert.deepEqual(
      out.vod.sites.map((item) => item.id).sort(),
      [`${SOURCE_A}:a1`, `${SOURCE_A}:a2`, `${SOURCE_B}:b1`].sort(),
    );
  });

  await t.test('锁定后完全不读库，只用设备内联快照', () => {
    const library = buildLibrary();
    const [sections] = normalizeSections({
      vod: {
        managed: true,
        sourceIds: [SOURCE_A],
        lockLibrary: true,
        sources: [{ id: SOURCE_A, name: '快照源', jar: 'https://old.example.com/spider.jar' }],
        sites: [{ id: `${SOURCE_A}:only`, sourceId: SOURCE_A, name: '快照站点', api: 'csp_Old' }],
      },
    });
    const out = expandVodSites(sections, library);
    // 库里有 a1/a2，但锁定后必须看不见
    assert.deepEqual(out.vod.sites.map((item) => item.id), [`${SOURCE_A}:only`]);
    assert.equal(out.vod.sources[0].jar, 'https://old.example.com/spider.jar');
  });

  await t.test('未选源的设备原样返回内联内容（老文档兼容）', () => {
    const library = buildLibrary();
    const [sections] = normalizeSections({ vod: { managed: false } });
    const out = expandVodSites(sections, library);
    assert.deepEqual(out.vod.sources, []);
    assert.deepEqual(out.vod.sites, []);
  });

  await t.test('库不可用时不炸，站点退化为空', () => {
    const [sections] = normalizeSections({ vod: { managed: true, sourceIds: [SOURCE_A] } });
    const out = expandVodSites(sections, null);
    assert.deepEqual(out.vod.sources, []);
    assert.deepEqual(out.vod.sites, []);
  });

  await t.test('viewDocument 同时展开 vod 与 iptv，互不干扰', () => {
    const library = buildLibrary();
    const [sections] = normalizeSections({
      vod: { managed: true, sourceIds: [SOURCE_A] },
    });
    const document = { schemaVersion: 1, revision: 7, updatedAt: '2026-01-01T00:00:00+08:00', sections };
    const view = viewDocument(document, false, library);
    assert.equal(view.revision, 7);
    assert.equal(view.sections.vod.sites.length, 2);
    // 原始文档不能被视图函数改写
    assert.deepEqual(document.sections.vod.sites, []);
  });
});

test('TVBox spider 字段：md5 拆分、相对资源解析、流派标记', async (t) => {
  const BASE = 'https://raw.liucn.cc/box/m.json';
  const SOURCE = 'vs_bbbbbbbb';

  await t.test('"./fty.jar;md5;<hash>" 拆成绝对地址 + md5', () => {
    const parsed = parseSpiderField('./fty.jar;md5;3d161697458ecbcd2651a749db761ba1', BASE);
    assert.equal(parsed.jar, 'https://raw.liucn.cc/box/fty.jar');
    assert.equal(parsed.md5, '3d161697458ecbcd2651a749db761ba1');
  });

  await t.test('绝对地址原样返回；只有 ";md5" 不带 hash 时 md5 为空', () => {
    assert.deepEqual(
      parseSpiderField('https://cdn.example.com/spider.jar', BASE),
      { jar: 'https://cdn.example.com/spider.jar', md5: '' },
    );
    assert.deepEqual(parseSpiderField('./fty.jar;md5', BASE).md5, '');
    assert.deepEqual(parseSpiderField('', BASE), { jar: '', md5: '' });
  });

  await t.test('csp_ / 普通文本不被 URL 构造器改写', () => {
    assert.equal(resolveVodAsset('csp_DouDou', BASE), 'csp_DouDou');
    assert.equal(resolveVodAsset('http://127.0.0.1:9978/file/token.txt', BASE),
      'http://127.0.0.1:9978/file/token.txt');
    assert.equal(resolveVodAsset('./libs/market.json', BASE),
      'https://raw.liucn.cc/box/libs/market.json');
    assert.equal(resolveVodAsset('/libs/tv/tvlive.txt', BASE),
      'https://raw.liucn.cc/libs/tv/tvlive.txt');
  });

  await t.test('中文相对路径自动 percent-encode', () => {
    const url = resolveVodAsset('./央视频道.m3u', 'https://live.hacks.tools/tv/ipv4/categories/base.json');
    assert.ok(url.startsWith('https://live.hacks.tools/tv/ipv4/categories/%'));
    assert.ok(!url.includes('央视频道'));
  });

  await t.test('资源库兼容带 md5 后缀的 jar，并透传 spiderMd5 / spiderFlavor', () => {
    const [library] = normalizeLibrary({
      vod: {
        sources: [{
          id: SOURCE, name: '饭太硬', url: BASE,
          jar: './fty.jar;md5;3d161697458ecbcd2651a749db761ba1',
        }],
        sites: [{
          sourceId: SOURCE, key: 'douban', name: '豆瓣', api: 'csp_DouDou',
          ext: './libs/market.json',
        }],
      },
    });
    assert.equal(library.vod.sources[0].jar, 'https://raw.liucn.cc/box/fty.jar');
    assert.equal(library.vod.sources[0].spiderMd5, '3d161697458ecbcd2651a749db761ba1');
    assert.equal(library.vod.sources[0].spiderFlavor, 'fongmi');
    assert.equal(library.vod.sites[0].api, 'csp_DouDou');
    assert.equal(library.vod.sites[0].ext, 'https://raw.liucn.cc/box/libs/market.json');
  });

  await t.test('展开产物带上 md5 与流派，终端可直接校验 jar', () => {
    const [library] = normalizeLibrary({
      vod: {
        sources: [{
          id: SOURCE, url: BASE,
          jar: 'https://cdn.example.com/fty.jar',
          spiderMd5: '0123456789abcdef0123456789abcdef',
          spiderFlavor: 'tvboxos',
        }],
        sites: [],
      },
    });
    const [sections] = normalizeSections({ vod: { managed: true, sourceIds: [SOURCE] } });
    const out = expandVodSites(sections, library);
    assert.equal(out.vod.sources[0].spiderMd5, '0123456789abcdef0123456789abcdef');
    assert.equal(out.vod.sources[0].spiderFlavor, 'tvboxos');
  });

  await t.test('设备内联源也兼容 "url;md5;hash"', () => {
    const [sections] = normalizeSections({
      vod: {
        sources: [{ id: SOURCE, name: '快照', jar: 'https://x/spider.jar;md5;aabbccdd11223344' }],
        sites: [],
      },
    });
    assert.equal(sections.vod.sources[0].jar, 'https://x/spider.jar');
    assert.equal(sections.vod.sources[0].spiderMd5, 'aabbccdd11223344');
    assert.equal(sections.vod.sources[0].spiderFlavor, 'fongmi');
  });

  await t.test('未知流派回退 fongmi，不把脏值下发给终端', () => {
    const [library] = normalizeLibrary({
      vod: { sources: [{ id: SOURCE, url: BASE, spiderFlavor: 'unknown' }], sites: [] },
    });
    assert.equal(library.vod.sources[0].spiderFlavor, 'fongmi');
  });

  await t.test('编辑器脚本已内置注释剥离与 md5 拆分', async () => {
    const { readFile } = await import('node:fs/promises');
    const source = await readFile(new URL('../editor/app.js', import.meta.url), 'utf8');
    for (const name of ['parseTvboxJson', 'parseSpiderField', 'resolveVodAsset', 'spiderMd5']) {
      assert.ok(source.includes(name), `editor/app.js 缺少 ${name}`);
    }
  });
});

/* ================= 下发套餐（导航 + 弹窗 + 源选择 → 一份配置） ================= */

test('下发套餐：终端只绑一个套餐，改套餐自动生效', async (t) => {
  const savedKv = globalThis.PURETV_KV;
  const fresh = new MemoryKV();
  globalThis.PURETV_KV = fresh;
  t.after(() => { globalThis.PURETV_KV = savedKv; });

  const env = {};
  const listBundles = () => bundlesGet(ctx('GET', '/api/bundles', { env }));
  const putBundles = (body, rev) => bundlesPut(ctx('PUT', '/api/bundles', {
    env, headers: { 'If-Match': String(rev) }, body,
  }));
  // /api/devices 支持批量：结果包在 results[0] 里，ok 由 runAction 的容错分支决定。
  const bind = async (deviceId, packageId) => {
    const data = await json(await devicesPost(ctx('POST', '/api/devices', {
      env, body: { action: 'bind', deviceId, packageId },
    })));
    return (data.results || [])[0] || {};
  };
  const getDevice = (id) => configGet(ctx('GET', `/api/config?deviceId=${id}`, { env }));

  await t.test('空套餐库结构完整，usage 为空', async () => {
    const data = await json(await listBundles());
    assert.equal(data.revision, 0);
    assert.deepEqual(data.items, []);
    assert.deepEqual(data.usage, {});
  });

  await t.test('PUT 自动补 id、补全五节 sections', async () => {
    const res = await putBundles({
      items: [{
        name: '客厅',
        remark: '主卧电视用',
        sections: { navigation: { managed: true, railMenuIds: ['iptv'] } },
      }],
    }, 0);
    assert.equal(res.status, 200);
    const data = await json(res);
    assert.equal(data.revision, 1);
    const list = await json(await listBundles());
    assert.equal(list.items.length, 1);
    assert.match(list.items[0].id, /^bd_[0-9a-f]{8}$/);
    assert.equal(list.items[0].name, '客厅');
    assert.deepEqual(Object.keys(list.items[0].sections).sort(),
      ['iptv', 'navigation', 'startup', 'update', 'vod']);
  });

  await t.test('未注册设备直接绑定会被逐台拒绝', async () => {
    const list = await json(await listBundles());
    const res = await bind('tv-unknown', list.items[0].id);
    assert.equal(res.ok, false);
    assert.match(res.error, /找不到设备/);
  });

  await t.test('绑定后设备文档整份替换为套餐内容，并记录 bundleStamp', async () => {
    await json(await getDevice('tv-a')); // 先上线，让注册表里有这台设备
    const list = await json(await listBundles());
    const bundleId = list.items[0].id;
    const res = await bind('tv-a', bundleId);
    assert.equal(res.ok, true);
    assert.equal(res.deviceId, 'tv-a');
    assert.equal(res.packageId, bundleId);

    const doc = await json(await getDevice('tv-a'));
    assert.deepEqual(doc.sections.navigation.railMenuIds, ['iptv']);
    assert.equal(doc.sections.bundleStamp.id, bundleId);
    assert.equal(doc.sections.bundleStamp.revision, 1);
  });

  await t.test('设备列表回报绑定的套餐', async () => {
    const data = await json(await devicesGet(ctx('GET', '/api/devices', { env })));
    const row = data.devices.find((item) => item.id === 'tv-a');
    const list = await json(await listBundles());
    assert.equal(row.packageId, list.items[0].id);
  });

  await t.test('改套餐后，终端下次 GET 自动追平并推进 revision', async () => {
    const before = await json(await getDevice('tv-a'));
    const list = await json(await listBundles());
    const bundle = list.items[0];
    const res = await putBundles({
      items: [{
        id: bundle.id,
        name: '客厅（改）',
        sections: {
          navigation: { managed: true, railMenuIds: ['iptv', 'vodBrowse'] },
          startup: { exitDialog: { enabled: true, titleI18n: { zh: '改过了' } } },
        },
      }],
    }, list.revision);
    assert.equal(res.status, 200);

    const after = await json(await getDevice('tv-a'));
    assert.ok(after.revision > before.revision, 'revision 必须推进，否则终端会命中 304');
    assert.deepEqual(after.sections.navigation.railMenuIds, ['iptv', 'vodBrowse']);
    assert.equal(after.sections.startup.exitDialog.titleI18n.zh, '改过了');
    assert.equal(after.sections.bundleStamp.revision, 2);
  });

  await t.test('再拉一次不再重复写（stamp 命中）', async () => {
    const first = await json(await getDevice('tv-a'));
    const second = await json(await getDevice('tv-a'));
    assert.equal(second.revision, first.revision);
  });

  await t.test('解绑后设备保留当前内容，不再跟随套餐', async () => {
    const before = await json(await getDevice('tv-a'));
    const res = await bind('tv-a', '');
    assert.equal(res.ok, true);
    assert.equal(res.packageId, '');
    const after = await json(await getDevice('tv-a'));
    assert.deepEqual(after.sections.navigation.railMenuIds, before.sections.navigation.railMenuIds);

    const list = await json(await listBundles());
    const bundle = list.items[0];
    await putBundles({
      items: [{ id: bundle.id, name: bundle.name, sections: { navigation: { managed: true, railMenuIds: [] } } }],
    }, list.revision);
    const still = await json(await getDevice('tv-a'));
    assert.deepEqual(still.sections.navigation.railMenuIds, before.sections.navigation.railMenuIds);
  });

  await t.test('删除套餐后，绑定它的终端保持现状而不报错', async () => {
    const list = await json(await listBundles());
    const res = await putBundles({ items: [] }, list.revision);
    assert.equal(res.status, 200);
    const doc = await getDevice('tv-a');
    assert.equal(doc.status, 200);
  });
});

/* ================= 默认套餐：新终端上线即有内容 ================= */

test('默认套餐：新设备首次上线自动绑定', async (t) => {
  const savedKv = globalThis.PURETV_KV;
  globalThis.PURETV_KV = new MemoryKV();
  t.after(() => { globalThis.PURETV_KV = savedKv; });

  const env = {};
  const listBundles = async () => json(await bundlesGet(ctx('GET', '/api/bundles', { env })));
  const putBundles = (body, rev) => bundlesPut(ctx('PUT', '/api/bundles', {
    env, headers: { 'If-Match': String(rev) }, body,
  }));
  const getDevice = (id) => configGet(ctx('GET', `/api/config?deviceId=${id}`, { env }));

  await t.test('空套餐库带 defaultBundleId=""', async () => {
    const data = await listBundles();
    assert.equal(data.defaultBundleId, '');
  });

  await t.test('默认套餐指向不存在的 id 时被清空并给出警告', async () => {
    const res = await putBundles({
      defaultBundleId: 'bd_deadbeef',
      items: [{ name: 'A', sections: { navigation: { managed: true, railMenuIds: ['iptv'] } } }],
    }, 0);
    assert.equal(res.status, 200);
    const data = await json(res);
    assert.ok(data.warnings.some((w) => w.includes('默认套餐')));
    const list = await listBundles();
    assert.equal(list.defaultBundleId, '');
  });

  await t.test('设为默认后 GET 能读回来', async () => {
    const list = await listBundles();
    const bundleId = list.items[0].id;
    const res = await putBundles({
      defaultBundleId: bundleId,
      items: list.items,
    }, list.revision);
    assert.equal(res.status, 200);
    const after = await listBundles();
    assert.equal(after.defaultBundleId, bundleId);
  });

  await t.test('新设备第一次 GET 就绑上默认套餐并拿到内容', async () => {
    const doc = await json(await getDevice('tv-new'));
    const list = await listBundles();
    assert.equal(doc.sections.bundleStamp.id, list.defaultBundleId);
    assert.deepEqual(doc.sections.navigation.railMenuIds, ['iptv']);

    const devices = await json(await devicesGet(ctx('GET', '/api/devices', { env })));
    const row = devices.devices.find((item) => item.id === 'tv-new');
    assert.equal(row.packageId, list.defaultBundleId);
  });

  await t.test('已有设备不会被默认套餐改写', async () => {
    // tv-old 先上线、此时没有默认套餐 → 保持未绑定
    const list = await listBundles();
    await putBundles({ defaultBundleId: '', items: list.items }, list.revision);
    const first = await json(await getDevice('tv-old'));
    assert.equal(first.sections.bundleStamp, undefined);

    // 再设默认套餐，tv-old 依然不绑
    const list2 = await listBundles();
    await putBundles({ defaultBundleId: list2.items[0].id, items: list2.items }, list2.revision);
    await json(await getDevice('tv-old'));
    const devices = await json(await devicesGet(ctx('GET', '/api/devices', { env })));
    const row = devices.devices.find((item) => item.id === 'tv-old');
    assert.equal(row.packageId, '');
  });
});

/* ================= 二维码图片上传 ================= */

test('二维码图片：上传后可公开读取，非法输入被拒', async (t) => {
  const savedKv = globalThis.PURETV_KV;
  globalThis.PURETV_KV = new MemoryKV();
  t.after(() => { globalThis.PURETV_KV = savedKv; });

  const env = {};
  // 1×1 透明 PNG
  const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk'
    + 'YPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

  await t.test('上传 data URL 返回 id 与可读 url', async () => {
    const res = await assetsPost(ctx('POST', '/api/assets', {
      env, body: { data: 'data:image/png;base64,' + PNG, name: 'qr.png' },
    }));
    assert.equal(res.status, 200);
    const data = await json(res);
    assert.match(data.id, /^as_[0-9a-f]{8}$/);
    assert.equal(data.url, '/api/assets?id=' + data.id);
    assert.equal(data.contentType, 'image/png');

    const img = await assetsGet(ctx('GET', '/api/assets?id=' + data.id, { env }));
    assert.equal(img.status, 200);
    assert.equal(img.headers.get('Content-Type'), 'image/png');
    const bytes = new Uint8Array(await img.arrayBuffer());
    assert.ok(bytes.length > 0);
    // PNG magic
    assert.deepEqual([...bytes.slice(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
    // 公开读取接口必须带 nosniff + CSP，防止伪装内容被当 HTML/JS 执行。
    assert.equal(img.headers.get('X-Content-Type-Options'), 'nosniff');
    assert.match(img.headers.get('Content-Security-Policy'), /default-src 'none'/);
  });

  // 回归（2026-11-16 审查 #5）：只校验声明 MIME 可被绕过——把 HTML 以
  // image/png 名义上传即成存储型 XSS。现在按解码后文件头核对真实类型。
  await t.test('魔数与声明类型不符的伪装图片被拒', () => {
    const html = new TextEncoder().encode('<script>alert(1)</script>');
    assert.equal(sniffImageType(html), '');
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    assert.equal(sniffImageType(png), 'image/png');
    const htmlB64 = Buffer.from(html).toString('base64');
    return assetsPost(ctx('POST', '/api/assets', {
      env, body: { data: 'data:image/png;base64,' + htmlB64 },
    })).then((res) => assert.equal(res.status, 400));
  });

  await t.test('裸 base64 + contentType 也能上传', async () => {
    const res = await assetsPost(ctx('POST', '/api/assets', {
      env, body: { data: PNG, contentType: 'image/png' },
    }));
    assert.equal(res.status, 200);
  });

  await t.test('非图片 MIME 被拒', async () => {
    const res = await assetsPost(ctx('POST', '/api/assets', {
      env, body: { data: 'data:text/html;base64,' + PNG },
    }));
    assert.equal(res.status, 400);
  });

  await t.test('空数据被拒', async () => {
    const res = await assetsPost(ctx('POST', '/api/assets', { env, body: {} }));
    assert.equal(res.status, 400);
  });

  await t.test('不存在的 id 返回 404，非法 id 也不报错', async () => {
    assert.equal((await assetsGet(ctx('GET', '/api/assets?id=as_00000000', { env }))).status, 404);
    assert.equal((await assetsGet(ctx('GET', '/api/assets?id=../../etc/passwd', { env }))).status, 404);
  });

  // 回归（2026-11-16 审查缺口 B）：此前上传用例全走 devMode，没有真正验证写鉴权。
  await t.test('配置令牌后缺写令牌的上传返回 401', async () => {
    const guardedEnv = { CONFIG_READ_TOKEN: 'read', CONFIG_WRITE_TOKEN: 'write-secret' };
    const noAuth = await assetsPost(ctx('POST', '/api/assets', {
      env: guardedEnv, body: { data: 'data:image/png;base64,' + PNG },
    }));
    assert.equal(noAuth.status, 401);
    const wrongAuth = await assetsPost(ctx('POST', '/api/assets', {
      env: guardedEnv,
      headers: { Authorization: 'Bearer wrong' },
      body: { data: 'data:image/png;base64,' + PNG },
    }));
    assert.equal(wrongAuth.status, 401);
    const okAuth = await assetsPost(ctx('POST', '/api/assets', {
      env: guardedEnv,
      headers: { Authorization: 'Bearer write-secret' },
      body: { data: 'data:image/png;base64,' + PNG },
    }));
    assert.equal(okAuth.status, 200);
  });
});

/* ================= 终端管理：拉黑 ================= */

test('终端管理：拉黑保留记录并拒绝配置请求', async (t) => {
  const savedKv = globalThis.PURETV_KV;
  globalThis.PURETV_KV = new MemoryKV();
  t.after(() => { globalThis.PURETV_KV = savedKv; });

  const env = {};
  await json(await configGet(ctx('GET', '/api/config?deviceId=tv-x', { env })));

  await t.test('block 后设备仍在注册表里，blocked 列表包含它', async () => {
    const res = await devicesPost(ctx('POST', '/api/devices', {
      env, body: { action: 'block', deviceId: 'tv-x' },
    }));
    const data = await json(res);
    assert.equal(data.results[0].ok, true);
    const list = await json(await devicesGet(ctx('GET', '/api/devices', { env })));
    assert.ok(list.devices.some((item) => item.id === 'tv-x'), '注册记录应保留');
    assert.ok(list.blocked.includes('tv-x'));
  });

  await t.test('拉黑后配置请求 403', async () => {
    const res = await configGet(ctx('GET', '/api/config?deviceId=tv-x', { env }));
    assert.equal(res.status, 403);
  });

  await t.test('解除拉黑后恢复', async () => {
    await devicesPost(ctx('POST', '/api/devices', { env, body: { action: 'unblock', deviceId: 'tv-x' } }));
    const res = await configGet(ctx('GET', '/api/config?deviceId=tv-x', { env }));
    assert.equal(res.status, 200);
  });

  await t.test('删除已拉黑设备：记录移除，黑名单仍在（两件事独立）', async () => {
    await devicesPost(ctx('POST', '/api/devices', { env, body: { action: 'block', deviceId: 'tv-x' } }));
    const res = await devicesPost(ctx('POST', '/api/devices', {
      env, body: { action: 'purge', deviceId: 'tv-x' },
    }));
    const data = await json(res);
    assert.equal(data.results[0].purged, true);
    const list = await json(await devicesGet(ctx('GET', '/api/devices', { env })));
    assert.ok(!list.devices.some((item) => item.id === 'tv-x'), '注册项应移除');
    assert.ok(list.blocked.includes('tv-x'), '黑名单应保留，删除不解除拉黑');
    assert.equal((await configGet(ctx('GET', '/api/config?deviceId=tv-x', { env }))).status, 403);
    await devicesPost(ctx('POST', '/api/devices', { env, body: { action: 'unblock', deviceId: 'tv-x' } }));
  });
});

test('应用更新清单：云端代取 GitHub，终端只认自己的域名', async (t) => {
  const env = { UPDATE_GITHUB_REPO: 'muzhi621/pu_tv_client' };

  /** 一条最小可用的 GitHub release。 */
  const release = (tag, { prerelease = false, draft = false, abis = ['arm64-v8a'] } = {}) => ({
    tag_name: tag,
    name: `SUTV ${tag}`,
    body: `## ${tag}\n- 修了个 bug`,
    html_url: `https://github.com/muzhi621/pu_tv_client/releases/tag/${tag}`,
    published_at: '2026-11-17T09:30:00Z',
    prerelease,
    draft,
    author: { login: 'github-actions[bot]', avatar_url: 'https://a/x.png', html_url: 'https://github.com/apps/x' },
    assets: [
      ...abis.map((abi, index) => ({
        name: `SUTV-${abi}-impeller.apk`,
        browser_download_url: `https://github.com/muzhi621/pu_tv_client/releases/download/${tag}/SUTV-${abi}-impeller.apk`,
        size: 37748736 + index,
        digest: 'sha256:' + 'a'.repeat(64),
        download_count: 3,
      })),
      {
        name: 'source.zip',
        browser_download_url: `https://github.com/muzhi621/pu_tv_client/archive/${tag}.zip`,
        size: 1024,
      },
    ],
  });

  await t.test('版本号扁平化与仓库配置校验', () => {
    assert.equal(flattenVersion('3.0.42'), 130042);
    assert.equal(flattenVersion('v3.0.9'), 130009);
    assert.equal(flattenVersion(''), 0);
    // 非法仓库配置不能拼进 URL，必须回落到默认仓库
    assert.equal(repoOf({ UPDATE_GITHUB_REPO: 'x' }).slug, 'muzhi621/pu_tv_client');
    assert.equal(repoOf({ UPDATE_GITHUB_REPO: 'a/../../etc' }).slug, 'muzhi621/pu_tv_client');
    assert.equal(repoOf({}).slug, 'muzhi621/pu_tv_client');
  });

  await t.test('反代前缀可被 env 覆盖，且只保留 https', () => {
    const list = proxyPrefixes({ UPDATE_PROXY_PREFIXES: 'https://a.example,http://bad.example' });
    assert.deepEqual(list, ['https://a.example/']);
    // 全部非法时回落内置列表，不能变成空数组（否则等于禁用反代）
    assert.ok(proxyPrefixes({ UPDATE_PROXY_PREFIXES: 'ftp://x' }).length > 0);
  });

  await t.test('清单挑选最新非预发布版本，且只带 APK 资产', () => {
    const payload = buildFromReleases(
      [release('v3.0.43', { prerelease: true }), release('v3.0.42', { abis: ['arm64-v8a', 'armeabi-v7a'] })],
      env,
    );
    assert.equal(payload.version, '3.0.42');
    assert.equal(payload.version_num, 130042);
    assert.equal(payload.prerelease, false);
    assert.deepEqual(payload.android_abis, ['arm64-v8a', 'armeabi-v7a']);
    assert.equal(payload.assets.length, 2, 'zip 等非 APK 资产不能下发给终端');
    assert.ok(payload.assets.every((asset) => asset.name.endsWith('.apk')));
    assert.ok(payload.assets[0].digest.startsWith('sha256:'));
    assert.ok(payload.downloadPrefixes.length > 0, '终端要拿到云端指定的下载镜像');
    assert.equal(payload.releases.length, 2);
    // releases.json 侧用 changelog，客户端模型用 changeLog，两个都得有
    assert.ok(payload.releases[0].changelog.length > 0);
    assert.equal(payload.releases[0].changeLog, payload.releases[0].changelog);
    // 历史条目的文件名不带扩展名，与仓库里 releases.json 的写法一致
    assert.ok(payload.releases[0].files.every((file) => !file.name.endsWith('.apk')));
    assert.equal(payload.releases[0].date, '2026-11-17');
  });

  await t.test('只有预发布时不能返回空清单', () => {
    const payload = buildFromReleases([release('v3.1.0', { prerelease: true })], env);
    assert.equal(payload.version, '3.1.0');
    assert.equal(payload.prerelease, true);
  });

  await t.test('静态清单兜底：没有 asset 也能报出版本', () => {
    const payload = buildFromStatic(
      { version: '3.0.41', version_num: 130041, version_desc: '旧说明', android_abis: ['armeabi-v7a'] },
      [{ version: '3.0.41', title: 'v3.0.41', date: '2026-11-16', files: [] }],
      env,
    );
    assert.equal(payload.version, '3.0.41');
    assert.deepEqual(payload.assets, []);
    assert.equal(payload.releases.length, 1);
    assert.throws(() => buildFromStatic({}, [], env), /version/);
  });

  await t.test('官方 API 不可达时自动换到反代', async () => {
    resetAppUpdateCache();
    const seen = [];
    const fetchImpl = async (url) => {
      seen.push(url);
      if (url.startsWith('https://api.github.com/')) throw new Error('ECONNRESET');
      return { ok: true, text: async () => JSON.stringify([release('v3.0.42')]) };
    };
    const { payload, cached } = await loadAppUpdate(env, { fetchImpl });
    assert.equal(payload.source, 'proxy');
    assert.equal(payload.version, '3.0.42');
    assert.equal(cached, false);
    assert.ok(seen.length >= 2, '官方地址失败后必须继续试反代');
  });

  await t.test('API 与反代全挂时，静态 version.json 也能报出版本', async () => {
    resetAppUpdateCache();
    const fetchImpl = async (url) => {
      if (String(url).endsWith('/assets/version.json')) {
        return { ok: true, text: async () => JSON.stringify({ version: '3.0.41', version_num: 130041, version_desc: '旧说明' }) };
      }
      if (String(url).endsWith('/assets/releases.json')) {
        return { ok: true, text: async () => JSON.stringify([{ version: '3.0.41', title: 'v3.0.41', date: '2026-11-16', files: [] }]) };
      }
      throw new Error('blocked');
    };
    const { payload } = await loadAppUpdate(env, { fetchImpl });
    assert.equal(payload.source, 'static');
    assert.equal(payload.version, '3.0.41');
    assert.deepEqual(payload.assets, [], '静态清单没有 asset 信息，客户端退化为文件列表');
    assert.equal(payload.releases.length, 1);
  });

  await t.test('进程内缓存命中后不再出网；全部失败时用旧结果续命', async () => {
    resetAppUpdateCache();
    const ok = async () => ({ ok: true, text: async () => JSON.stringify([release('v3.0.42')]) });
    await loadAppUpdate(env, { fetchImpl: ok });
    let called = 0;
    const bomb = async () => { called += 1; throw new Error('all down'); };

    const hit = await loadAppUpdate(env, { fetchImpl: bomb });
    assert.equal(hit.cached, true);
    assert.equal(called, 0, '缓存有效期内不能回源');

    // 超过 TTL：回源失败，但 24 小时内的旧清单仍然可用（附 stale 标记）
    const stale = await loadAppUpdate(env, { fetchImpl: bomb, now: Date.now() + 10 * 60 * 1000 });
    assert.equal(stale.payload.stale, true);
    assert.equal(stale.cached, true);
    assert.equal(stale.payload.version, '3.0.42');
    resetAppUpdateCache();
  });

  await t.test('GET /api/update 带 CDN 缓存头，且不泄露内部细节', async () => {
    const original = globalThis.fetch;
    resetAppUpdateCache();
    globalThis.fetch = async (url) => {
      if (String(url).startsWith('https://api.github.com/')) {
        return { ok: true, text: async () => JSON.stringify([release('v3.0.42')]) };
      }
      throw new Error('blocked');
    };
    try {
      const res = await updateGet(ctx('GET', '/api/update'));
      assert.equal(res.status, 200);
      const cache = res.headers.get('cache-control');
      assert.match(cache, /max-age=300/);
      assert.match(cache, /stale-while-revalidate/);
      assert.equal(res.headers.get('x-update-source'), 'github');
      const data = await json(res);
      assert.equal(data.version, '3.0.42');
      assert.ok(data.downloadPrefixes.length > 0);
    } finally {
      globalThis.fetch = original;
      resetAppUpdateCache();
    }

    // 所有源都挂：503 + 可执行提示，而不是 500「服务端内部错误」
    const env2 = { UPDATE_PROXY_PREFIXES: 'https://dead.example/' };
    const dead = async () => { throw new Error('boom'); };
    globalThis.fetch = dead;
    try {
      resetAppUpdateCache();
      const res = await updateGet(ctx('GET', '/api/update', { env: env2 }));
      assert.equal(res.status, 503);
      const data = await json(res);
      assert.equal(data.error, 'update_unavailable');
      assert.ok(data.hint.includes('GITHUB_TOKEN'));
    } finally {
      globalThis.fetch = original;
      resetAppUpdateCache();
    }
  });
});

test('更新源与上传清单：来源可配、按架构直链、清单可上传', async (t) => {
  await t.test('契约：source 枚举 / 反代前缀补斜杠 / downloads 分架构', () => {
    assert.throws(() => normalizeSections({ update: { source: 'ftp' } }), /update\.source/);
    const [mirror] = normalizeSections({ update: { source: 'mirror', mirrorPrefix: 'https://gh.example.com' } });
    assert.equal(mirror.update.source, 'mirror');
    assert.equal(mirror.update.mirrorPrefix, 'https://gh.example.com/', '漏写斜杠会拼出坏地址');
    const [defaults] = normalizeSections({ update: {} });
    assert.equal(defaults.update.source, 'cloud', '缺省必须等于原来的行为');
    assert.deepEqual(defaults.update.downloads, { 'arm64-v8a': '', 'armeabi-v7a': '' });

    const [filled] = normalizeSections({
      update: { downloads: { 'arm64-v8a': 'https://cdn.example.com/a.apk' } },
    });
    assert.equal(filled.update.downloads['arm64-v8a'], 'https://cdn.example.com/a.apk');
    assert.equal(filled.update.downloads['armeabi-v7a'], '', '没填的那条留空，终端按「用清单资产」处理');
    assert.throws(() => normalizeSections({ update: { downloads: [] } }), /downloads/);
    assert.throws(() => normalizeSections({ update: { downloads: { 'arm64-v8a': 'ftp://x' } } }), /downloads/);

    const [, warnings] = normalizeSections({ update: { source: 'custom' } });
    assert.ok(warnings.some((item) => item.includes('custom')), '自填地址却没填，要给提示');
  });

  await t.test('上传清单：清洗字段，版本号必须自洽', () => {
    const manifest = normalizeUploadedManifest({
      version: 'v3.0.42',
      version_desc: '自建 CDN 说明',
      android_abis: ['arm64-v8a', 'x86_64'],
      download_url: 'https://example.com/releases',
      assets: [
        { name: 'SUTV-arm64-v8a-impeller.apk', url: 'https://cdn.example.com/a.apk', size: 100, digest: 'sha256:' + 'A'.repeat(64) },
        { name: 'notes.txt', url: 'https://cdn.example.com/a.txt' },
      ],
    });
    assert.equal(manifest.version, '3.0.42');
    assert.equal(manifest.version_num, 130042, '缺 version_num 时按仓库规则带产品位');
    assert.deepEqual(manifest.android_abis, ['arm64-v8a'], '不认识的 ABI 必须丢掉');
    assert.equal(manifest.assets.length, 1, '非 APK 资产不能进清单');
    assert.equal(manifest.assets[0].digest, 'sha256:' + 'a'.repeat(64), 'digest 统一小写');

    assert.throws(() => normalizeUploadedManifest({ version: '3.0.42', version_num: 30042 }), /不一致/);
    assert.throws(() => normalizeUploadedManifest([]), /JSON 对象/);
    assert.throws(() => normalizeUploadedManifest({ version: 'latest' }), /version/);
  });

  await t.test('POST/GET /api/update/manifest：写要令牌，读公开', async () => {
    const missing = await manifestGet(ctx('GET', '/api/update/manifest'));
    assert.equal(missing.status, 404);
    assert.equal((await json(missing)).error, 'no_manifest');

    const env = { CONFIG_WRITE_TOKEN: 'w' };
    const denied = await manifestPost(ctx('POST', '/api/update/manifest', {
      env, body: { manifest: { version: '3.0.42' } },
    }));
    assert.equal(denied.status, 401, '写接口不能被匿名调用');

    const saved = await manifestPost(ctx('POST', '/api/update/manifest', {
      env,
      headers: { Authorization: 'Bearer w' },
      body: {
        manifest: { version: '3.0.42', version_desc: '自建 CDN', android_abis: ['arm64-v8a'] },
        name: 'version.json',
      },
    }));
    assert.equal(saved.status, 200);
    const info = await json(saved);
    assert.equal(info.url, '/api/update/manifest');
    assert.equal(info.version_num, 130042);

    const read = await manifestGet(ctx('GET', '/api/update/manifest'));
    assert.equal(read.status, 200);
    assert.match(read.headers.get('cache-control'), /max-age=300/);
    assert.equal(read.headers.get('x-content-type-options'), 'nosniff');
    const data = await json(read);
    assert.equal(data.version, '3.0.42');
    assert.equal(data.version_desc, '自建 CDN');

    // 脏版本号不能覆盖掉一份本来能用的清单
    const bad = await manifestPost(ctx('POST', '/api/update/manifest', {
      env, headers: { Authorization: 'Bearer w' }, body: { version: 'latest' },
    }));
    assert.equal(bad.status, 400);
    const still = await json(await manifestGet(ctx('GET', '/api/update/manifest')));
    assert.equal(still.version, '3.0.42');
  });
});

test('在线更新：APK 直传 Blob、完工校验、公开下载', async (t) => {
  const blob = new MemoryBlob();
  const saved = globalThis.__PURETV_BLOB_STORE__;
  globalThis.__PURETV_BLOB_STORE__ = blob;
  t.after(() => {
    if (saved === undefined) delete globalThis.__PURETV_BLOB_STORE__;
    else globalThis.__PURETV_BLOB_STORE__ = saved;
  });
  const env = { CONFIG_READ_TOKEN: 'r', CONFIG_WRITE_TOKEN: 'w' };
  const write = { Authorization: 'Bearer w' };
  // 只校验 zip 魔数，所以一个 10 字节的假包就够走完流程。
  const apkBytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4, 5, 6]);
  const key = 'apk/fedcba9876543210/arm64-v8a.apk';

  await t.test('契约：资源库版本条目与 update 节的目标版本', () => {
    const [lib, warnings] = normalizeLibrary({
      updates: [
        { version: '3.0.43', urls: { 'arm64-v8a': 'https://cdn.example.com/a.apk' } },
        { version: '3.0.44' },
        { version: 'latest' },
        { version: '3.0.45', files: { 'arm64-v8a': { key: 'apk/../../evil.apk' } } },
      ],
    });
    assert.equal(lib.updates.length, 1, '无包无链、版本号非法、key 非法的条目都要丢掉');
    assert.equal(lib.updates[0].versionNum, 130043, 'versionNum 缺省按 3.0.43→130043 推导');
    assert.equal(lib.updates[0].id.length, 11, '缺省 id 自动补 up_ + 8 位十六进制');
    assert.ok(warnings.some((w) => w.includes('既没有安装包也没有下载链接')));
    assert.ok(warnings.some((w) => w.includes('key 非法')));

    const [sec, pinWarnings] = normalizeSections({
      update: {
        version: '3.0.43',
        updateId: 'up_1a2b3c4d',
        downloads: { 'arm64-v8a': 'https://cdn.example.com/a.apk' },
      },
    });
    assert.equal(sec.update.version, '3.0.43');
    assert.equal(sec.update.versionNum, 130043);
    assert.equal(sec.update.updateId, 'up_1a2b3c4d');
    assert.equal(pinWarnings.some((w) => w.includes('下不动')), false, '配了直链就不该告警');

    assert.throws(() => normalizeSections({ update: { version: 'latest' } }), /update\.version/);
    const [, bare] = normalizeSections({ update: { version: '3.0.43' } });
    assert.ok(bare.some((w) => w.includes('下不动')), '指定版本却没有下载地址必须提示');
    const [cleared] = normalizeSections({ update: { updateId: 'evil' } });
    assert.equal(cleared.update.updateId, '', '非法引用直接清空，别让编辑器回显幽灵条目');
    assert.equal(cleared.update.version, '', '不指定版本时维持原来的「查云端清单」');
  });

  await t.test('APK 魔数识别', () => {
    assert.equal(looksLikeApk(apkBytes), true);
    assert.equal(looksLikeApk(new Uint8Array([0x50, 0x4b, 0x05, 0x06])), true, '空 zip 也算 APK');
    assert.equal(looksLikeApk(new TextEncoder().encode('<html>')), false);
    assert.equal(looksLikeApk(new Uint8Array([0x50, 0x4b])), false, '不足 4 字节不能当成本地文件头');
  });

  await t.test('签名上传地址：要写令牌、只认 arm64-v8a / armeabi-v7a', async () => {
    const denied = await apkPost(ctx('POST', '/api/update/apk', {
      env, body: { action: 'sign', abi: 'arm64-v8a' },
    }));
    assert.equal(denied.status, 401, '发预签名地址等于发写权限，必须鉴权');

    const badAbi = await apkPost(ctx('POST', '/api/update/apk', {
      env, headers: write, body: { action: 'sign', abi: 'x86_64' },
    }));
    assert.equal(badAbi.status, 400);

    const ok = await apkPost(ctx('POST', '/api/update/apk', {
      env, headers: write, body: { action: 'sign', abi: 'arm64-v8a' },
    }));
    assert.equal(ok.status, 200);
    const data = await json(ok);
    assert.match(data.key, /^apk\/[0-9a-f]{16}\/arm64-v8a\.apk$/, 'key 必须由服务端生成');
    assert.ok(data.uploadUrl.startsWith('https://'), '预签名地址必须是 https');
    assert.equal(blob.presigned.length, 1, '应真的向 Blob SDK 申请了一次上传地址');
    assert.equal(blob.presigned[0].key, data.key);
  });

  await t.test('完工校验：非 APK 拒收并删除，合法包回 size 与 sha256', async () => {
    const htmlKey = 'apk/0123456789abcdef/arm64-v8a.apk';
    blob.map.set(htmlKey, new TextEncoder().encode('<html>not an apk</html>'));
    const bad = await apkPost(ctx('POST', '/api/update/apk', {
      env, headers: write, body: { action: 'finish', key: htmlKey },
    }));
    assert.equal(bad.status, 400);
    assert.equal(blob.map.has(htmlKey), false, '非 APK 不能留在 Blob 里白占额度');

    blob.map.set(key, apkBytes);
    const ok = await apkPost(ctx('POST', '/api/update/apk', {
      env, headers: write, body: { action: 'finish', key },
    }));
    assert.equal(ok.status, 200);
    const data = await json(ok);
    assert.equal(data.size, apkBytes.byteLength);
    assert.match(data.sha256, /^[0-9a-f]{64}$/);
    // 与 Web Crypto 独立算一次，确认摘要不是随手拼的
    const digest = await crypto.subtle.digest('SHA-256', apkBytes);
    const expect = Array.prototype.map.call(
      new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0'),
    ).join('');
    assert.equal(data.sha256, expect);
  });

  await t.test('公开下载：路径穿越 400、不存在 404、正常回 APK 类型', async () => {
    const traversal = await apkGet(ctx('GET', '/api/update/apk?key='
      + encodeURIComponent('../secret.txt')));
    assert.equal(traversal.status, 400, 'key 会拼进对象存储键路径，必须白名单校验');

    const missing = await apkGet(ctx('GET', '/api/update/apk?key='
      + encodeURIComponent('apk/0123456789abcdef/arm64-v8a.apk')));
    assert.equal(missing.status, 404);

    const ok = await apkGet(ctx('GET', '/api/update/apk?key=' + encodeURIComponent(key)));
    assert.equal(ok.status, 200, '终端下载装包带不了 Bearer，必须公开可读');
    assert.equal(ok.headers.get('content-type'), 'application/vnd.android.package-archive');
    assert.equal(ok.headers.get('x-content-type-options'), 'nosniff');
    assert.match(ok.headers.get('cache-control'), /immutable/);
    const body = new Uint8Array(await ok.arrayBuffer());
    assert.deepEqual(Array.from(body.slice(0, 4)), [0x50, 0x4b, 0x03, 0x04]);
  });

  await t.test('删除上传：清理已换掉的旧包', async () => {
    const del = await apkPost(ctx('POST', '/api/update/apk', {
      env, headers: write, body: { action: 'delete', key },
    }));
    assert.equal(del.status, 200);
    assert.equal(blob.map.has(key), false);
    const gone = await apkGet(ctx('GET', '/api/update/apk?key=' + encodeURIComponent(key)));
    assert.equal(gone.status, 404);
  });
});

/**
 * IPTV 套餐两级结构：分组（引用源）→ 频道。
 *
 * 这是终端频道列表的唯一来源，几条不变量必须守住：
 *   - 库里的套餐只存分组，不再重复存一份扁平 channels（900 KB 上限）；
 *   - 分组引用的源被删掉时保留频道，只把来源置空（删源不该掏空套餐）；
 *   - 展开给终端的频道顺序 = 分组顺序 + 组内顺序，channel.group = 分组名。
 */
test('IPTV 套餐分组：两级结构的校验、展开与容错', async (t) => {
  const source = { id: 's_11112222', name: '央视源', url: 'https://a.example/cctv.m3u' };

  await t.test('库套餐：分组保留、扁平 channels 清空、来源由分组推导', () => {
    const [library, warnings] = normalizeLibrary({
      iptv: {
        sources: [source],
        packages: [{
          id: 'pkg_aaaabbbb',
          name: '家庭版',
          groups: [
            {
              id: 'g_00000001',
              name: '央视',
              sourceId: 's_11112222',
              channels: [
                { name: 'CCTV1', url: 'http://a.example/1.ts' },
                { name: 'CCTV1', url: 'http://a.example/1.ts' },
              ],
            },
            {
              id: 'g_00000002',
              name: '卫视',
              sourceId: '',
              channels: [{ name: '湖南卫视', url: 'http://a.example/hn.ts', group: '随便写的' }],
            },
          ],
        }],
      },
    });
    const pkg = library.iptv.packages[0];
    assert.equal(pkg.groups.length, 2);
    // 组内去重 + 强制把 group 写成分组名
    assert.deepEqual(pkg.groups[0].channels.map((c) => c.url), ['http://a.example/1.ts']);
    assert.equal(pkg.groups[0].channels[0].group, '央视');
    assert.equal(pkg.groups[1].channels[0].group, '卫视');
    // 扁平 channels 不再重复存一份
    assert.deepEqual(pkg.channels, []);
    // 来源由分组推导，不用用户再勾
    assert.deepEqual(pkg.sources, ['s_11112222']);
  });

  await t.test('分组引用的源不存在：保留频道、来源置空并记 warning', () => {
    const [library, warnings] = normalizeLibrary({
      iptv: {
        sources: [source],
        packages: [{
          id: 'pkg_aaaabbbb',
          name: '孤儿源',
          groups: [{
            id: 'g_00000001', name: '地方台', sourceId: 's_99999999',
            channels: [{ name: 'BTV', url: 'http://a.example/btv.ts' }],
          }],
        }],
      },
    });
    const group = library.iptv.packages[0].groups[0];
    assert.equal(group.sourceId, '');
    assert.equal(group.channels.length, 1, '删源不能把频道一起丢掉');
    assert.ok(warnings.some((line) => line.includes('不在资源库里')));
  });

  await t.test('非法/重复分组 id 就地补发，组名有默认值', () => {
    const [library] = normalizeLibrary({
      iptv: {
        sources: [source],
        packages: [{
          id: 'pkg_aaaabbbb',
          groups: [
            { id: 'bad-id', name: '', channels: [] },
            { id: 'bad-id', name: '卫视', channels: [] },
          ],
        }],
      },
    });
    const groups = library.iptv.packages[0].groups;
    assert.equal(groups.length, 2);
    for (const group of groups) assert.match(group.id, /^g_[0-9a-f]{8}$/);
    assert.notEqual(groups[0].id, groups[1].id);
    assert.equal(groups[0].name, '分组 1');
  });

  await t.test('设备引用套餐：展开顺序 = 分组顺序 + 组内顺序', () => {
    const library = {
      iptv: {
        sources: [source],
        packages: [{
          id: 'pkg_aaaabbbb',
          name: '家庭版',
          sources: ['s_11112222'],
          channels: [],
          groups: [
            {
              id: 'g_00000001', name: '央视', sourceId: 's_11112222',
              channels: [
                { name: 'CCTV1', url: 'http://a.example/1.ts', group: '央视', logo: '' },
                { name: 'CCTV2', url: 'http://a.example/2.ts', group: '央视', logo: '' },
              ],
            },
            {
              id: 'g_00000002', name: '卫视', sourceId: '',
              channels: [{ name: '湖南', url: 'http://a.example/hn.ts', group: '卫视', logo: '' }],
            },
          ],
        }],
      },
    };
    const [sections] = normalizeSections({
      iptv: { managed: true, packageIds: ['pkg_aaaabbbb'], channels: [] },
    });
    const expanded = expandIptvChannels(sections, library);
    assert.deepEqual(expanded.iptv.channels.map((c) => c.name), ['CCTV1', 'CCTV2', '湖南']);
    assert.deepEqual(expanded.iptv.groups, ['央视', '卫视']);
    // 轻量视图的套餐摘要要按分组算频道数
    const view = viewDocument(
      { schemaVersion: 1, revision: 1, sections: { iptv: { managed: true, packageIds: ['pkg_aaaabbbb'] } } },
      false, library,
    );
    assert.equal(view.sections.iptv.packages[0].channelCount, 3);
    assert.equal(view.sections.iptv.packages[0].groupCount, 2);
  });

  await t.test('库内分组来源可引用频道套餐（pkgref）且悬空引用被清空', () => {
    const raw = {
      version: 1,
      iptv: {
        sources: [{
          id: 's_11112222', name: 'iptv4.m3u',
          url: 'http://a.example/iptv4.m3u', channelCount: 2,
        }],
        packages: [
          {
            id: 'pkg_aaaabbbb', name: '湖北移动a', sources: [],
            channels: [{ name: '央视频道', url: 'http://a.example/cctv.ts' }],
          },
          {
            id: 'pkg_ccccdddd', name: '湖北移动b', sources: ['pkgref:pkg_aaaabbbb'],
            groups: [
              {
                id: 'g_00000011', name: '央视', sourceId: 'pkgref:pkg_aaaabbbb',
                channels: [{ name: 'CCTV1', url: 'http://a.example/1.ts' }],
              },
              {
                id: 'g_00000012', name: '卫视', sourceId: 'pkgref:pkg_deadbeef',
                channels: [{ name: '湖南', url: 'http://a.example/hn.ts' }],
              },
            ],
          },
        ],
      },
    };
    const [library] = normalizeLibrary(raw);
    const pkgB = library.iptv.packages.find((p) => p.id === 'pkg_ccccdddd');
    const groups = new Map(pkgB.groups.map((g) => [g.id, g]));
    assert.equal(groups.get('g_00000011').sourceId, 'pkgref:pkg_aaaabbbb');
    assert.equal(groups.get('g_00000012').sourceId, '');
    assert.ok(pkgB.sources.includes('pkgref:pkg_aaaabbbb'));
  });

  await t.test('设备内联套餐也支持分组（锁定快照场景）', () => {
    const [sections] = normalizeSections({
      iptv: {
        selectedPackageIds: ['p1'],
        packages: [{
          id: 'p1',
          name: '锁定快照',
          groups: [{
            id: 'g_00000003', name: '国际', sourceId: '',
            channels: [{ name: 'CNN', url: 'http://a.example/cnn.ts' }],
          }],
        }],
      },
    });
    const pkg = sections.iptv.packages[0];
    assert.deepEqual(pkg.channels, []);
    const expanded = expandIptvChannels(sections);
    assert.deepEqual(expanded.iptv.channels.map((c) => c.name), ['CNN']);
    assert.deepEqual(expanded.iptv.groups, ['国际']);
  });
});
