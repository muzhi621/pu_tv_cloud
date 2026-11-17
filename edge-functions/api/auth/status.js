/**
 * GET /api/auth/status —— 登录页探测：服务端到底配没配账号。
 *
 * 不鉴权（登录前就要能问），也不返回用户名——只回答「能不能登录」。这样
 * 部署漏配环境变量时，页面能直接给出可执行的提示，而不是让人对着
 * 「账号或密码不正确」反复试。
 */
import { handle, optionsHandler, send } from '../../_lib/http.js';
import { authStatus } from '../../_lib/auth.js';

export const onRequestOptions = optionsHandler;

export async function onRequestGet(context) {
  return handle(context, async ({ env, request }) => {
    const status = await authStatus(env);
    return send({ env, request, status: 200, body: status });
  });
}
