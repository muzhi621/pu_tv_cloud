/**
 * POST /api/auth/password —— 修改管理员密码。
 *
 * 必须带「当前密码」：会话被借用（共享电脑没登出）时，光有会话不能改密码。
 * 改完所有会话作废（见 _lib/auth.js 的 epoch），前端据此引导重新登录。
 */
import {
  handle, HttpError, optionsHandler, readJsonBody, requireAuth, send,
} from '../../_lib/http.js';
import { changePassword, loadAccount } from '../../_lib/auth.js';

export const onRequestOptions = optionsHandler;

export async function onRequestPost(context) {
  return handle(context, async ({ env, request }) => {
    // 会话与写令牌都允许进来：用令牌连接的部署同样需要能改密码。
    await requireAuth(request, env, 'write');
    const body = await readJsonBody(request);

    const account = await loadAccount(env);
    if (!account) {
      throw new HttpError(
        503, 'auth_not_initialized',
        '服务端还没有配置管理员账号：设置环境变量 CONFIG_ADMIN_PASSWORD 后重新部署',
      );
    }

    const result = await changePassword(env, account, body.oldPassword, body.newPassword);
    if (!result.ok) {
      if (result.reason === 'bad_password') {
        throw new HttpError(400, 'bad_password', '当前密码不正确');
      }
      if (result.reason === 'weak_password') {
        throw new HttpError(400, 'weak_password', `新密码至少 ${result.minLength} 位`);
      }
      throw new HttpError(400, 'same_password', '新密码不能与当前密码相同');
    }

    return send({
      env, request, status: 200,
      body: { ok: true, relogin: true, message: '密码已更新，本机会话已失效，请用新密码重新登录' },
    });
  });
}
