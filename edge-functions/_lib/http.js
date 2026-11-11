/**
 * HTTP 层：鉴权、CORS、ETag/304、错误映射。与 cloud/app.py 对齐。
 *
 * 差异（边缘运行时限制）：
 * - 不做 gzip：配置文档只有几 KB，压缩由 EdgeOne CDN 自动完成。
 * - 请求体上限由平台约束（Edge Functions 1 MB），这里再校验一次。
 */
import { ConfigError, etagFor, SCHEMA_VERSION } from './contract.js';
import { Conflict, StorageUnavailable } from './storage.js';

export class HttpError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

export function contextParts(context) {
  const env = (context && context.env)
    || (typeof process !== 'undefined' && process.env)
    || {};
  return { env, request: context.request };
}

function corsHeaders(env, request) {
  const origin = request.headers.get('Origin') || '';
  const configured = (env.CONFIG_CORS_ORIGINS || '').split(',').map((item) => item.trim()).filter(Boolean);
  if (!origin || (!configured.includes('*') && !configured.includes(origin))) return {};
  return {
    'Access-Control-Allow-Origin': configured.includes('*') ? '*' : origin,
    'Access-Control-Allow-Methods': 'GET, PUT, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, If-Match, If-None-Match',
    'Access-Control-Max-Age': '600',
    Vary: 'Origin',
  };
}

function constantTimeEqual(a, b) {
  // 长度不同时也走完整循环，避免通过响应时间推断 token。
  const left = String(a);
  const right = String(b);
  let diff = left.length ^ right.length;
  const n = Math.max(left.length, right.length);
  for (let i = 0; i < n; i += 1) {
    diff |= (left.charCodeAt(i) || 0) ^ (right.charCodeAt(i) || 0);
  }
  return diff === 0;
}

export function requireAuth(request, env, scope) {
  const readToken = (env.CONFIG_READ_TOKEN || '').trim();
  const writeToken = (env.CONFIG_WRITE_TOKEN || '').trim() || readToken;
  const token = scope === 'read' ? readToken : writeToken;
  if (!token) return; // devMode：未配置 token 时不鉴权，与 FC 版一致
  const header = request.headers.get('Authorization') || '';
  if (!header.startsWith('Bearer ') || !constantTimeEqual(header.slice(7).trim(), token)) {
    throw new HttpError(401, 'unauthorized', '缺少或无效的 Bearer Token');
  }
}

export async function readJsonBody(request) {
  const raw = await request.text();
  if (!raw) throw new ConfigError('请求体不能为空');
  if (new TextEncoder().encode(raw).length > 1024 * 1024) {
    throw new HttpError(413, 'payload_too_large', '请求体超过 1 MiB');
  }
  let value;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new ConfigError(`请求体不是合法 JSON: ${error.message}`);
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ConfigError('请求体必须是 JSON 对象');
  }
  return value;
}

export function send({ env, request, status, body, contentType, document, headers }) {
  const out = new Headers(headers || {});
  out.set('Content-Type', contentType || 'application/json; charset=utf-8');
  out.set('Cache-Control', 'no-store');
  if (document) {
    out.set('ETag', etagFor(document.revision));
    out.set('X-Revision', String(document.revision));
    out.set('X-Schema-Version', String(SCHEMA_VERSION));
  }
  for (const [key, value] of Object.entries(corsHeaders(env, request))) out.set(key, value);

  if (status === 204 || status === 304) {
    return new Response(null, { status, headers: out });
  }
  const payload = body == null ? '' : (typeof body === 'string' ? body : JSON.stringify(body));
  return new Response(payload, { status, headers: out });
}

/** 统一异常处理，保证错误响应形状与 FC 版一致。 */
export async function handle(context, fn) {
  const parts = contextParts(context);
  try {
    return await fn(parts);
  } catch (error) {
    const { env, request } = parts;
    if (error instanceof Conflict) {
      return send({
        env, request, status: 409, document: error.current,
        body: {
          error: 'revision_conflict',
          message: error.message,
          currentRevision: error.current.revision,
          document: error.current,
        },
      });
    }
    if (error instanceof ConfigError) {
      return send({
        env, request, status: 400,
        body: { error: 'invalid_config', message: error.message },
      });
    }
    if (error instanceof StorageUnavailable) {
      // 存储缺失是「部署配置问题」而不是代码 bug：给出可执行提示，别让用户只看 500。
      try { console.error('[pu_tv_cloud] storage unavailable:', error.message); } catch (_) { /* 忽略 */ }
      return send({
        env, request, status: 503,
        body: {
          error: 'storage_unavailable',
          message: error.message,
          hint: '在 EdgeOne 控制台把一个 KV 命名空间绑定到变量名 PURETV_KV；'
            + '或确保项目安装了 @edgeone/pages-blob 依赖（重新部署即可自动创建 Blob 命名空间）',
        },
      });
    }
    if (error instanceof HttpError) {
      return send({
        env, request, status: error.status,
        body: { error: error.code, message: error.message, ...error.extra },
      });
    }
    try { console.error('[pu_tv_cloud]', error); } catch (_) { /* 日志不可用则忽略 */ }
    return send({
      env, request, status: 500,
      body: { error: 'internal_error', message: `服务端内部错误: ${error && error.name}` },
    });
  }
}

/** 预检请求：仅在配置了 CORS 时返回 204。 */
export async function optionsHandler(context) {
  return handle(context, ({ env, request }) => {
    const configured = (env.CONFIG_CORS_ORIGINS || '').trim();
    if (!configured) throw new HttpError(405, 'method_not_allowed', '未启用 CORS');
    return send({ env, request, status: 204 });
  });
}
