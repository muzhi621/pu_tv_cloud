/**
 * GET /api/update —— 应用更新清单（云端代取 GitHub Releases）。
 *
 * 终端只访问本域名，不直连 api.github.com：国内网络直连 GitHub 基本不可用，
 * 这是「检查更新失败」的主因。取数、多源重试、缓存都在云端完成，细节见
 * _lib/update.js。
 *
 * 公开读：终端不带令牌，端点也不接受任何来自 query 的地址参数（无法被当作代理用）。
 * 响应走 CDN 缓存，终端每次检查更新都只是命中边缘节点，不会压到 GitHub。
 */
import { HttpError, handle, send } from '../../_lib/http.js';
import { loadAppUpdate } from '../../_lib/update.js';

/** 源站缓存多久：命中进程内缓存时短一些，刚回源的可以长一些。 */
const MAX_AGE_FRESH = 300;
const MAX_AGE_CACHED = 60;

export async function onRequestGet(context) {
  return handle(context, async ({ env, request }) => {
    let result;
    try {
      result = await loadAppUpdate(env);
    } catch (error) {
      // 全部数据源都失败：给出可执行的排查提示，而不是 500「服务端内部错误」。
      throw new HttpError(
        503, 'update_unavailable',
        `无法获取更新清单（${String(error && error.message || error).slice(0, 200)}）`,
        {
          hint: 'GitHub 及其反代均不可达。可配置 GITHUB_TOKEN 提升限额，'
            + '或用 UPDATE_PROXY_PREFIXES 指定可用的反代前缀',
        },
      );
    }

    const maxAge = result.cached ? MAX_AGE_CACHED : MAX_AGE_FRESH;
    return send({
      env,
      request,
      status: 200,
      body: result.payload,
      headers: {
        'X-Update-Source': String(result.payload.source || ''),
        'X-Update-Cached': result.cached ? '1' : '0',
      },
      cacheControl: `public, max-age=${maxAge}, s-maxage=${maxAge}, stale-while-revalidate=1800`,
    });
  });
}
