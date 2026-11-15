/**
 * /api/assets —— 编辑器上传的小图片（退出弹窗二维码等）。
 *
 * POST  上传（写令牌）：body `{ data: 'data:image/png;base64,...' | '<base64>', name? }`
 *       返回 `{ id, url, size, contentType }`；`url` 是相对路径，编辑器补上 API 地址。
 * GET   公开读取（**不鉴权**）：`?id=as_xxxxxxxx` 直接回图片字节。
 *       终端要用 CachedNetworkImage 拉这张图，带不了 Bearer；id 是随机 8 位 hex，
 *       不可枚举，等于「知道链接才能看」。
 *
 * 只允许图片 MIME 且 ≤ 512 KB。不做图片处理（不缩放、不转码），原样存原样发。
 */
import { ConfigError } from '../../_lib/contract.js';
import {
  handle, optionsHandler, readJsonBody, requireAuth, send,
} from '../../_lib/http.js';
import {
  MAX_ASSET_BYTES, readAsset, writeAsset,
} from '../../_lib/storage.js';

export const onRequestOptions = optionsHandler;

const ALLOWED = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const EXT_BY_TYPE = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif',
};

function randomAssetId() {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  return 'as_' + Array.prototype.map.call(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** base64 → 字节数（不真解码，省一次内存拷贝）。 */
function base64Bytes(base64) {
  const clean = base64.replace(/=+$/, '');
  return Math.floor((clean.length * 3) / 4);
}

export async function onRequestGet(context) {
  return handle(context, async ({ env, request }) => {
    const id = new URL(request.url).searchParams.get('id') || '';
    const asset = await readAsset(env, id);
    if (!asset) {
      return send({ env, request, status: 404, body: { error: 'not_found', message: '图片不存在' } });
    }
    const binary = Uint8Array.from(atob(asset.data), (char) => char.charCodeAt(0));
    // 图片不会变（id 就是内容），可以长期缓存，终端不必每次心跳重拉。
    return new Response(binary, {
      status: 200,
      headers: {
        'Content-Type': asset.contentType || 'image/png',
        'Content-Length': String(binary.length),
        'Cache-Control': 'public, max-age=31536000, immutable',
      },
    });
  });
}

export async function onRequestPost(context) {
  return handle(context, async ({ env, request }) => {
    requireAuth(request, env, 'write');
    const body = await readJsonBody(request);
    const raw = String(body.data || '').trim();
    if (!raw) throw new ConfigError('缺少图片数据（data 字段）');

    // 兼容两种写法：完整 data URL 或裸 base64。
    let contentType = '';
    let base64 = raw;
    const match = /^data:([^;,]+);base64,(.*)$/s.exec(raw);
    if (match) {
      contentType = match[1].toLowerCase();
      base64 = match[2];
    } else if (typeof body.contentType === 'string') {
      contentType = body.contentType.toLowerCase();
    }
    if (!contentType) {
      // 没声明类型时按文件名兜底，再不行当作 PNG。
      const name = String(body.name || '').toLowerCase();
      contentType = Object.keys(EXT_BY_TYPE).find((type) => name.endsWith('.' + EXT_BY_TYPE[type]))
        || 'image/png';
    }
    if (!ALLOWED.has(contentType)) {
      throw new ConfigError(`只支持 PNG / JPG / WEBP / GIF，收到 ${contentType || '未知类型'}`);
    }
    const size = base64Bytes(base64);
    if (size <= 0) throw new ConfigError('图片内容为空');
    if (size > MAX_ASSET_BYTES) {
      throw new ConfigError(
        `图片 ${Math.round(size / 1024)} KB，超过 ${MAX_ASSET_BYTES / 1024} KB 上限；`
        + '二维码不需要大图，压缩后再传',
      );
    }
    if (!/^[A-Za-z0-9+/=\s]+$/.test(base64)) throw new ConfigError('图片数据不是合法 base64');

    const asset = await writeAsset(env, {
      id: randomAssetId(),
      contentType,
      data: base64.replace(/\s+/g, ''),
      name: String(body.name || '').slice(0, 120),
      size,
      createdAt: new Date().toISOString(),
    });

    return send({
      env,
      request,
      status: 200,
      body: {
        id: asset.id,
        url: '/api/assets?id=' + asset.id,
        size: asset.size,
        contentType: asset.contentType,
      },
    });
  });
}
