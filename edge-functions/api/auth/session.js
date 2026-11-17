/**
 * GET /api/auth/session —— 校验已保存的会话是否还有效。
 *
 * 编辑器刷新页面时先问一次：有效就直接连接并加载，无效才弹登录框。否则
 * 「昨天登录过」和「会话早过期」在页面上没有任何区别。
 */
import { handle, HttpError, optionsHandler, send } from '../../_lib/http.js';
import { lookupSession } from '../../_lib/auth.js';

export const onRequestOptions = optionsHandler;

export async function onRequestGet(context) {
  return handle(context, async ({ env, request }) => {
    const header = request.headers.get('Authorization') || '';
    const bearer = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    const session = bearer ? await lookupSession(env, bearer) : null;
    if (!session) {
      throw new HttpError(401, 'unauthorized', '会话已过期，请重新登录');
    }
    return send({
      env, request, status: 200,
      body: { user: session.user, expiresAt: session.expiresAt },
    });
  });
}
