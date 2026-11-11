/** GET /api/config/revisions —— 历史快照列表。 */
import { handle, optionsHandler, requireAuth, send } from '../../_lib/http.js';
import { revisions } from '../../_lib/storage.js';

export const onRequestOptions = optionsHandler;

export async function onRequestGet(context) {
  return handle(context, async ({ env, request }) => {
    requireAuth(request, env, 'read');
    const url = new URL(request.url);
    const parsed = Number.parseInt(url.searchParams.get('limit') || '20', 10);
    const limit = Number.isNaN(parsed) ? 20 : parsed;
    const list = await revisions(env, limit);
    return send({ env, request, status: 200, body: { revisions: list } });
  });
}
