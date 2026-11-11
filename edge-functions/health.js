/** GET /health —— 存活探测（无需鉴权）。 */
import { handle, send } from './_lib/http.js';
import { read } from './_lib/storage.js';

export async function onRequestGet(context) {
  return handle(context, async ({ env, request }) => {
    const document = await read(env);
    return send({
      env, request, status: 200,
      body: {
        status: 'ok',
        revision: document.revision,
        backend: 'edgeone-kv',
        devMode: !(env.CONFIG_READ_TOKEN || '').trim(),
      },
    });
  });
}
