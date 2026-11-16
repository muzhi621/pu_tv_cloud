/** GET /health —— 存活探测（无需鉴权）。存储不可用时返回 200 + degraded，方便一眼看出是配置问题。 */
import { handle, send } from './_lib/http.js';
import { describeStorage, read } from './_lib/storage.js';

export async function onRequestGet(context) {
  return handle(context, async ({ env, request }) => {
    // devMode 保留兼容字段（读令牌缺失即开发模式）；另分别暴露两侧是否已受保护，
    // 避免"只配了写令牌"时被误报成 devMode:true 误导运维判断。
    const readProtected = !!(env.CONFIG_READ_TOKEN || '').trim();
    const writeProtected = !!(env.CONFIG_WRITE_TOKEN || '').trim();
    const devMode = !readProtected;
    const auth = { devMode, readProtected, writeProtected };
    const storage = await describeStorage(env);

    if (!storage.ok) {
      return send({
        env, request, status: 200,
        body: {
          status: 'degraded',
          revision: null,
          backend: 'none',
          ...auth,
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
        ...auth,
      },
    });
  });
}
