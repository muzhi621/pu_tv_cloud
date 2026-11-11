/** GET /health —— 存活探测（无需鉴权）。存储不可用时返回 200 + degraded，方便一眼看出是配置问题。 */
import { handle, send } from './_lib/http.js';
import { describeStorage, read } from './_lib/storage.js';

export async function onRequestGet(context) {
  return handle(context, async ({ env, request }) => {
    const devMode = !(env.CONFIG_READ_TOKEN || '').trim();
    const storage = await describeStorage(env);

    if (!storage.ok) {
      return send({
        env, request, status: 200,
        body: {
          status: 'degraded',
          revision: null,
          backend: 'none',
          devMode,
          storageError: storage.error,
        },
      });
    }

    const document = await read(env);
    return send({
      env, request, status: 200,
      body: {
        status: 'ok',
        revision: document.revision,
        backend: storage.backend,
        devMode,
      },
    });
  });
}
