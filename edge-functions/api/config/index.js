/** GET/PUT /api/config —— 与终端 RemoteConfigService 的主接口。 */
import {
  ConfigError, MAX_DOCUMENT_BYTES, normalizeSections, viewDocument,
} from '../../_lib/contract.js';
import {
  deviceScope, handle, HttpError, optionsHandler, readJsonBody, requireAuth, send,
} from '../../_lib/http.js';
import { isBlocked, markPushed, read, touchDevice, write } from '../../_lib/storage.js';

export const onRequestOptions = optionsHandler;

/** 被管理员彻底删除（拉黑）的设备不再接受任何配置请求。 */
async function rejectBlocked(env, id) {
  if (!id) return;
  if (await isBlocked(env, id)) {
    throw new HttpError(403, 'device_blocked', '该设备已被云端移除，请联系管理员解除拉黑');
  }
}

export async function onRequestGet(context) {
  return handle(context, async ({ env, request }) => {
    requireAuth(request, env, 'read');
    const { id, meta } = deviceScope(request);
    await rejectBlocked(env, id);
    const document = await read(env, id);
    // 每次成功拉取即视为「上线」，不额外做心跳请求。
    if (id) await touchDevice(env, id, meta);

    const url = new URL(request.url);
    const since = (url.searchParams.get('since') || '').trim();
    const inm = (request.headers.get('If-None-Match') || '').trim().replace(/^"|"$/g, '');
    if ((since && since === String(document.revision))
        || (inm && inm === String(document.revision))) {
      return send({ env, request, status: 304, document });
    }
    // 编辑器要编辑套餐库，带 ?withPackages=1 才返回完整频道；终端只拿展开后的
    // channels + 套餐元数据，避免 15 分钟一次的心跳重复传几百 KB。
    const view = viewDocument(document, url.searchParams.get('withPackages') === '1');
    return send({
      env, request, status: 200, body: view, document,
      headers: id ? { 'X-Device-Id': id } : {},
    });
  });
}

export async function onRequestPut(context) {
  return handle(context, async ({ env, request }) => {
    requireAuth(request, env, 'write');
    const { id } = deviceScope(request);
    await rejectBlocked(env, id);
    const body = await readJsonBody(request);
    if (typeof body.sections !== 'object' || body.sections === null || Array.isArray(body.sections)) {
      throw new ConfigError('请求体必须包含 sections 对象');
    }
    let ifMatch = (request.headers.get('If-Match') || '').trim().replace(/^"|"$/g, '');
    if (!ifMatch && Number.isInteger(body.expectedRevision)) {
      ifMatch = String(body.expectedRevision);
    }
    if (!ifMatch || !/^\d+$/.test(ifMatch)) {
      throw new ConfigError('缺少 If-Match（或 expectedRevision），拒绝覆盖未知版本');
    }
    const [sections, warnings] = normalizeSections(body.sections);
    const bytes = new TextEncoder().encode(JSON.stringify(sections)).length;
    if (bytes > MAX_DOCUMENT_BYTES) {
      throw new ConfigError(
        `配置文档 ${Math.round(bytes / 1024)} KB 超过 ${Math.round(MAX_DOCUMENT_BYTES / 1024)} KB 上限；`
        + '请精简 IPTV 频道数量或减少分组',
      );
    }
    const document = await write(env, sections, Number(ifMatch), id);
    if (id) {
      // 记录「最近下发」；这是展示用的元数据，失败不能影响已经成功的配置写入。
      try { await markPushed(env, id, document.revision); } catch (_) { /* 忽略 */ }
    }
    const response = {
      revision: document.revision,
      updatedAt: document.updatedAt,
      warnings,
      deviceId: id,
    };
    if (!(env.CONFIG_READ_TOKEN || '').trim()) response.devMode = true;
    return send({ env, request, status: 200, body: response, document });
  });
}
