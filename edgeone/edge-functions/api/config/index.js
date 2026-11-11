/** GET/PUT /api/config —— 与终端 RemoteConfigService 的主接口。 */
import { ConfigError, normalizeSections } from '../../_lib/contract.js';
import { handle, optionsHandler, readJsonBody, requireAuth, send } from '../../_lib/http.js';
import { read, write } from '../../_lib/storage.js';

export const onRequestOptions = optionsHandler;

export async function onRequestGet(context) {
  return handle(context, async ({ env, request }) => {
    requireAuth(request, env, 'read');
    const document = await read(env);
    const url = new URL(request.url);
    const since = (url.searchParams.get('since') || '').trim();
    const inm = (request.headers.get('If-None-Match') || '').trim().replace(/^"|"$/g, '');
    if ((since && since === String(document.revision))
        || (inm && inm === String(document.revision))) {
      return send({ env, request, status: 304, document });
    }
    return send({ env, request, status: 200, body: document, document });
  });
}

export async function onRequestPut(context) {
  return handle(context, async ({ env, request }) => {
    requireAuth(request, env, 'write');
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
    const document = await write(env, sections, Number(ifMatch));
    const response = {
      revision: document.revision,
      updatedAt: document.updatedAt,
      warnings,
    };
    if (!(env.CONFIG_READ_TOKEN || '').trim()) response.devMode = true;
    return send({ env, request, status: 200, body: response, document });
  });
}
