/** POST /api/config/rollback —— 回滚到指定快照（生成新 revision）。 */
import { ConfigError } from '../../_lib/contract.js';
import { handle, optionsHandler, readJsonBody, requireAuth, send } from '../../_lib/http.js';
import { rollback } from '../../_lib/storage.js';

export const onRequestOptions = optionsHandler;

export async function onRequestPost(context) {
  return handle(context, async ({ env, request }) => {
    requireAuth(request, env, 'write');
    const body = await readJsonBody(request);
    const { revision } = body;
    if (typeof revision !== 'number' || !Number.isInteger(revision) || revision < 0) {
      throw new ConfigError('revision 必须是非负整数');
    }
    const document = await rollback(env, revision);
    return send({
      env, request, status: 200, document,
      body: {
        revision: document.revision,
        updatedAt: document.updatedAt,
        rolledBackFrom: revision,
      },
    });
  });
}
