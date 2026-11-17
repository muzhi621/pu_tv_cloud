/**
 * HTTP 层：鉴权、CORS、ETag/304、错误映射。与 cloud/app.py 对齐。
 *
 * 差异（边缘运行时限制）：
 * - 不做 gzip：配置文档只有几 KB，压缩由 EdgeOne CDN 自动完成。
 * - 请求体上限放宽到 2 MiB 以容纳 IPTV 频道列表；单份配置另受
 *   MAX_DOCUMENT_BYTES 约束，避免出现平台无法承载的超大文档。
 */
import { ConfigError, etagFor, SCHEMA_VERSION } from './contract.js';
import { Conflict, StorageUnavailable, normalizeDeviceId } from './storage.js';

/**
 * 从 query / header 解析设备范围。
 * 终端可传 ?deviceId=xxx 或 X-Device-Id；编辑器用 query 切换设备。
 * 不带设备 id = 全局模板（兼容 v3.0.11 及更早的终端）。
 */
export function deviceScope(request) {
  const url = new URL(request.url);
  const raw = url.searchParams.get('deviceId')
    || request.headers.get('X-Device-Id')
    || '';
  return {
    id: normalizeDeviceId(raw),
    meta: {
      appVersion: url.searchParams.get('appVersion')
        || request.headers.get('X-App-Version') || '',
      model: url.searchParams.get('model')
        || request.headers.get('X-Device-Model') || '',
    },
  };
}

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
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, If-Match, If-None-Match, X-Device-Id, X-App-Version, X-Device-Model',
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
  const MAX = 2 * 1024 * 1024;
  // 先看声明长度，超限时在物化请求体之前就拒绝，避免超大 body 在边缘运行时
  // 内存里驻留（FC 版 cloud/app.py 也是先查 CONTENT_LENGTH，两端对齐）。
  const declared = Number(request.headers.get('content-length') || 0);
  if (declared > MAX) throw new HttpError(413, 'payload_too_large', '请求体超过 2 MiB');

  // 整体读取优先（2026-11-17 线上事故的根因）：
  // EdgeOne Pages Functions 里 request.body 虽然提供 getReader()，但读出来是「空流」
  // （第一次 read 就 done:true）。更致命的是——**一旦调用 getReader()，body 就被 lock**，
  // 之后 `request.text()` 必定抛普通 Error（"Body is unusable"），被 handle 兜底成
  // 500「服务端内部错误: Error」。云端所有带 body 的写接口（保存套餐 / 保存设备配置 /
  // 上传壁纸 / 拉黑删除 / 绑定下发）全部因此失败，而本地 Node 测试行为正常，测不出来。
  // 与 api/iptv/fetch.js 的 readLimited 是同一个坑，必须同样「整体读取优先」。
  let raw = '';
  let failure = null;
  try {
    if (typeof request.text === 'function') raw = await request.text();
  } catch (error) {
    failure = error; // 某些运行时只实现 body 流，走下面的兜底
  }

  // 兜底：整体读取不可用 / 返回空时才试流式。body 已被消费或锁定（locked/bodyUsed）
  // 就直接放弃，不制造「二次读取必失败」的假错误。
  if (!raw && request.body && typeof request.body.getReader === 'function') {
    const body = request.body;
    const alreadyUsed = body.locked === true
      || (typeof request.bodyUsed === 'boolean' && request.bodyUsed === true);
    if (!alreadyUsed) {
      try {
        const reader = body.getReader();
        const decoder = new TextDecoder();
        let bytes = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!value || !value.length) continue;
          bytes += value.length;
          if (bytes > MAX) throw new HttpError(413, 'payload_too_large', '请求体超过 2 MiB');
          raw += decoder.decode(value, { stream: true });
        }
        raw += decoder.decode();
      } catch (error) {
        if (error instanceof HttpError) throw error;
        if (!failure) failure = error;
      }
    }
  }

  if (!raw) {
    // 有异常却读不出内容：明确报「请求体读取失败」，别再伪装成 500 内部错误。
    if (failure) {
      throw new HttpError(
        400, 'body_unreadable',
        `无法读取请求体（${(failure && failure.message) || failure}）`,
      );
    }
    // 声明了长度却读到 0 字节：运行时的请求体流不可用，属于部署环境问题，
    // 报「为空」会误导成调用方没传 body。
    if (declared > 0) {
      throw new HttpError(
        400, 'body_unreadable',
        `请求体声明 ${declared} 字节但读不到内容，该运行时的请求体流可能不可用`,
      );
    }
    throw new ConfigError('请求体不能为空');
  }
  if (new TextEncoder().encode(raw).length > MAX) {
    throw new HttpError(413, 'payload_too_large', '请求体超过 2 MiB');
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

export function send({ env, request, status, body, contentType, document, headers, cacheControl }) {
  const out = new Headers(headers || {});
  out.set('Content-Type', contentType || 'application/json; charset=utf-8');
  // 默认 no-store：配置文档带设备身份，绝不能被 CDN 缓存给别的终端。
  // 只有明确声明 cacheControl 的公开只读端点（如 /api/update）才允许缓存。
  out.set('Cache-Control', cacheControl || 'no-store');
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
    // 只回 name 会得到「服务端内部错误: Error」这种哑错误（2026-11-17 踩过），
    // 带上级 message 才能在控制台一眼定位；截断避免把内部细节整段吐出去。
    const detail = error && error.message
      ? `${(error && error.name) || 'Error'}: ${String(error.message).slice(0, 300)}`
      : String((error && error.name) || error || 'unknown');
    return send({
      env, request, status: 500,
      body: {
        error: 'internal_error',
        message: `服务端内部错误: ${detail}`,
        hint: '详情见函数日志（EdgeOne 控制台 → Pages → 函数日志）',
      },
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
