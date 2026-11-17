/**
 * /api/assets —— 编辑器上传的小图片（退出弹窗二维码、首页壁纸等）。
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

/**
 * 按文件头识别真实图片类型。只校验「声明的 MIME」不够——攻击者可以把 HTML/JS
 * 以 image/png 名义上传，GET 是公开接口，一旦被浏览器当 HTML 解析即成存储型 XSS。
 * 这里解码后核对魔数，声明类型与真实类型不一致直接拒绝。导出供离线测试。
 */
export function sniffImageType(bytes) {
  const at = (i) => bytes[i];
  if (bytes.length >= 8 && at(0) === 0x89 && at(1) === 0x50 && at(2) === 0x4e && at(3) === 0x47
      && at(4) === 0x0d && at(5) === 0x0a && at(6) === 0x1a && at(7) === 0x0a) return 'image/png';
  if (bytes.length >= 3 && at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return 'image/jpeg';
  if (bytes.length >= 12 && at(0) === 0x52 && at(1) === 0x49 && at(2) === 0x46 && at(3) === 0x46
      && at(8) === 0x57 && at(9) === 0x45 && at(10) === 0x42 && at(11) === 0x50) return 'image/webp';
  if (bytes.length >= 6 && at(0) === 0x47 && at(1) === 0x49 && at(2) === 0x46
      && (at(3) === 0x38 || at(3) === 0x39) && at(4) === 0x61) return 'image/gif';
  return '';
}

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
        // 公开接口 + 不可枚举 id 不等于可以放松内容类型：即使有人绕过上传校验
        // 塞进 HTML，nosniff + CSP 也保证浏览器只当图片解析，不会执行脚本。
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; sandbox",
        'Cache-Control': 'public, max-age=31536000, immutable',
      },
    });
  });
}

export async function onRequestPost(context) {
  return handle(context, async ({ env, request }) => {
    await requireAuth(request, env, 'write');
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

    // 解码后核对真实类型，拒绝「声明 image/png 实为 HTML/JS」的伪装上传。
    let bytes;
    try {
      const binary = atob(base64.replace(/\s+/g, ''));
      bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    } catch (_) {
      throw new ConfigError('图片数据不是合法 base64');
    }
    const sniffed = sniffImageType(bytes);
    if (!sniffed || !ALLOWED.has(sniffed)) throw new ConfigError('文件内容不是有效的 PNG / JPG / WEBP / GIF 图片');
    if (sniffed !== contentType) {
      throw new ConfigError(`声明类型 ${contentType} 与实际图片 ${sniffed} 不符`);
    }

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
