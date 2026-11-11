/** GET /api/config/revisions —— 某设备（或全局模板）的历史快照列表。 */
import { deviceScope, handle, optionsHandler, requireAuth, send } from '../../_lib/http.js';
import { revisions } from '../../_lib/storage.js';

export const onRequestOptions = optionsHandler;

export async function onRequestGet(context) {
  return handle(context, async ({ env, request }) => {
    requireAuth(request, env, 'read');
    const { id } = deviceScope(request);
    const url = new URL(request.url);
    const parsed = Number.parseInt(url.searchParams.get('limit') || '20', 10);
    const limit = Number.isNaN(parsed) ? 20 : parsed;
    const list = await revisions(env, limit, id);
    return send({ env, request, status: 200, body: { revisions: list, deviceId: id } });
  });
}
