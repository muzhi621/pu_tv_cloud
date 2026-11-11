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
import { onRequestGet as editorGet } from '../edge-functions/index.js';
import { normalizeDocument, normalizeSections } from '../edge-functions/_lib/contract.js';
import { optionsHandler } from '../edge-functions/_lib/http.js';

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
    assert.deepEqual(Object.keys(doc.sections).sort(), ['navigation', 'sites', 'startup', 'update']);
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
    assert.equal(data.menus.length, 7);
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
