/**
 * POST /api/auth/logout —— 注销当前会话。
 *
 * 始终返回 200：登出是幂等动作，会话早已过期时再报 401 只会让页面的
 * 「退出登录」看起来失败。
 */
import { handle, optionsHandler, send } from '../../_lib/http.js';
import { revokeSession } from '../../_lib/auth.js';

export const onRequestOptions = optionsHandler;

export async function onRequestPost(context) {
  return handle(context, async ({ env, request }) => {
    const header = request.headers.get('Authorization') || '';
    const bearer = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (bearer) await revokeSession(env, bearer);
    return send({ env, request, status: 200, body: { ok: true } });
  });
}
