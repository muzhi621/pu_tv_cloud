/**
 * POST /api/auth/login —— 编辑器管理员登录，返回会话令牌。
 *
 * 返回体里的 `base` 是本次请求的同源地址：编辑器登录成功后用它填「API 地址」
 * 并立刻连接，操作者不需要知道自己部署在哪个域名。部署了独立 API 域名时
 * 仍可在页面上手改，不在这里猜。
 */
import { handle, HttpError, optionsHandler, readJsonBody, send } from '../../_lib/http.js';
import {
  AUTH_LIMITS, clearLoginFailures, createSession, guardState, loadAccount,
  noteLoginFailure, safeEqual, verifyPassword,
} from '../../_lib/auth.js';

export const onRequestOptions = optionsHandler;

export async function onRequestPost(context) {
  return handle(context, async ({ env, request }) => {
    const body = await readJsonBody(request);
    const username = String(body.username || '').trim();
    const password = String(body.password || '');
    if (!username || !password) {
      throw new HttpError(400, 'invalid_credentials', '请填写账号与密码');
    }

    // 锁定期间连密码都不校验：否则「锁定」只是让人多等几次而已。
    const guard = await guardState(env);
    if (guard.locked) {
      throw new HttpError(
        429, 'too_many_attempts',
        `尝试次数过多，请 ${guard.retryAfterSeconds} 秒后再试`,
        { retryAfterSeconds: guard.retryAfterSeconds },
      );
    }

    const account = await loadAccount(env);
    if (!account) {
      throw new HttpError(
        503, 'auth_not_initialized',
        '服务端还没有配置管理员账号：设置环境变量 CONFIG_ADMIN_PASSWORD（至少 8 位，'
        + '可另设 CONFIG_ADMIN_USER）后重新部署',
      );
    }

    // 两个条件都要算完再判断：账号错时也走完整的 PBKDF2，否则「账号是否存在」
    // 能通过响应时间看出来。
    const userOk = safeEqual(username, account.user);
    const passOk = await verifyPassword(account, password);
    if (!userOk || !passOk) {
      const result = await noteLoginFailure(env);
      throw new HttpError(401, 'unauthorized', '账号或密码不正确', {
        remainingAttempts: result.locked ? 0 : Math.max(0, AUTH_LIMITS.maxGuardFails - result.fails),
      });
    }

    await clearLoginFailures(env);
    const session = await createSession(env, account);
    return send({
      env, request, status: 200,
      body: {
        token: session.token,
        user: session.user,
        expiresAt: session.expiresAt,
        base: new URL(request.url).origin,
      },
    });
  });
}
