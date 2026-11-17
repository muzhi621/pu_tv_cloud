/**
 * /api/update/manifest —— 编辑器「上传清单」的存取端点。
 *
 * POST 上传（写令牌）：body 是清单本身，或 `{ manifest: {...}, name? }`。
 *      清单形状与 assets/version.json 一致（version / version_num / version_desc /
 *      prerelease / android_abis / download_url，可带 assets 与 releases）。
 * GET  公开读取（**不鉴权**）：直接回那份清单，终端把它当 version.json 解析。
 *
 * 为什么给「上传」留一条路：GitHub 在国内容易不可达，反代也不稳定。把 APK 放到
 * 自己的 CDN/网盘、清单传到云端之后，整条更新链路就完全不依赖 GitHub 了。
 *
 * 不需要 CORS：终端是原生 HTTP 客户端，编辑器与端点同域。
 */
import { handle, optionsHandler, readJsonBody, requireAuth, send } from '../../_lib/http.js';
import { normalizeUploadedManifest } from '../../_lib/update.js';
import { MAX_UPDATE_MANIFEST_BYTES, readUpdateManifest, writeUpdateManifest } from '../../_lib/storage.js';
import { ConfigError } from '../../_lib/contract.js';

export const onRequestOptions = optionsHandler;

/** 没上传过 manifest 时用 404 + 可执行提示，别让终端以为是网络问题。 */
export async function onRequestGet(context) {
  return handle(context, async ({ env, request }) => {
    const record = await readUpdateManifest(env);
    if (!record) {
      return send({
        env,
        request,
        status: 404,
        body: {
          error: 'no_manifest',
          message: '云端还没有上传更新清单',
          hint: '在编辑器「在线更新策略」里上传 version.json，或把更新源改为云端',
        },
      });
    }
    return send({
      env,
      request,
      body: record.manifest,
      cacheControl: 'public, max-age=300, s-maxage=300',
      headers: {
        // 内容是 JSON，不是 HTML：nosniff 让浏览器绝不把它当页面解析。
        'X-Content-Type-Options': 'nosniff',
        'X-Manifest-Uploaded-At': record.uploadedAt || '',
      },
    });
  });
}

export async function onRequestPost(context) {
  return handle(context, async ({ env, request }) => {
    await requireAuth(request, env, 'write');
    const body = await readJsonBody(request);
    // 兼容两种写法：包一层 `manifest`，或直接把清单当 body 发上来。
    const raw = body.manifest && typeof body.manifest === 'object' ? body.manifest : body;
    const manifest = normalizeUploadedManifest(raw);

    const bytes = new TextEncoder().encode(JSON.stringify(manifest)).length;
    if (bytes > MAX_UPDATE_MANIFEST_BYTES) {
      throw new ConfigError(
        `清单 ${Math.round(bytes / 1024)} KB，超过 ${MAX_UPDATE_MANIFEST_BYTES / 1024} KB 上限`,
      );
    }

    const record = await writeUpdateManifest(env, manifest, String(body.name || ''));
    // 路径与 manifestUrl 的默认写法一致，编辑器可直接回填到配置里。
    return send({
      env,
      request,
      body: {
        url: '/api/update/manifest',
        version: manifest.version,
        version_num: manifest.version_num,
        bytes,
        uploadedAt: record.uploadedAt,
      },
    });
  });
}
