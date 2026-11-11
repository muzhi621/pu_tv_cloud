/** GET /api/config/catalog —— 站点与导航 id 目录（编辑器用）。 */
import { CATALOG } from '../../_lib/contract.js';
import { handle, optionsHandler, requireAuth, send } from '../../_lib/http.js';

export const onRequestOptions = optionsHandler;

export async function onRequestGet(context) {
  return handle(context, ({ env, request }) => {
    requireAuth(request, env, 'read');
    return send({ env, request, status: 200, body: CATALOG });
  });
}
