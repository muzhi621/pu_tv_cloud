/**
 * /api/update/apk —— 「在线更新」板块的安装包存取。
 *
 * POST  需要写令牌，按 body.action 分三种动作：
 *         sign    发一个预签名 PUT 地址。浏览器把 APK 直接传到 Blob，**不经过函数**：
 *                 25 MB 的包既塞不进函数请求体（还要再套 base64 膨胀 33%），
 *                 也没必要让边缘函数中转一遍二进制。
 *         finish  上传完成后的核对：读回字节校验 ZIP 魔数（APK 一定是 ZIP），
 *                 算 size 与 sha256 回给编辑器存进资源库。校验不过直接删掉垃圾对象。
 *         delete  删除某条上传（换包、删版本时清理）。
 * GET   公开读取，按 key 流式返回 APK。终端下载装包时带不了 Bearer，所以不鉴权；
 *       key 是 16 位随机十六进制（见 contract.js 的 APK_KEY_RE），不可枚举，
 *       等于「知道地址才能下」。key 每次上传都会变，因此可以放心 immutable 缓存。
 */
import {
  APK_KEY_RE, ConfigError, MAX_APK_BYTES,
} from '../../_lib/contract.js';
import {
  handle, optionsHandler, readJsonBody, requireAuth, send,
} from '../../_lib/http.js';
import {
  apkStore, deleteApk, openApkStream, readApkBytes,
} from '../../_lib/storage.js';

export const onRequestOptions = optionsHandler;

const SUPPORTED_ABIS = new Set(['arm64-v8a', 'armeabi-v7a']);

/** 生成一个不可猜的对象 key：`apk/<16 hex>/<abi>.apk`。 */
function newApkKey(abi) {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  const hex = Array.prototype.map.call(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `apk/${hex}/${abi}.apk`;
}

/** key 会拼进对象存储的键路径，只认服务端生成的那一种格式。 */
function requireApkKey(raw) {
  const key = String(raw == null ? '' : raw).trim();
  if (!APK_KEY_RE.test(key)) throw new ConfigError('安装包标识非法');
  return key;
}

/**
 * APK 一定是 ZIP：本地文件头 `PK\x03\x04`，空包 `PK\x05\x06`，分卷 `PK\x07\x08`。
 * 只认后缀名不够——上传接口拿到的可能是一张图、一个视频，装到电视上才发现是废包。
 */
export function looksLikeApk(bytes) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (view.length < 4 || view[0] !== 0x50 || view[1] !== 0x4b) return false;
  const header = (view[2] << 8) | view[3];
  return header === 0x0304 || header === 0x0506 || header === 0x0708;
}

async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.prototype.map.call(
    new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0'),
  ).join('');
}

export async function onRequestGet(context) {
  return handle(context, async ({ env, request }) => {
    const key = requireApkKey(new URL(request.url).searchParams.get('key'));
    const stream = await openApkStream(env, key);
    if (!stream) {
      return send({
        env,
        request,
        status: 404,
        body: { error: 'not_found', message: '安装包不存在或已被替换' },
      });
    }
    return new Response(stream, {
      status: 200,
      headers: {
        'Content-Type': 'application/vnd.android.package-archive',
        // 公开端点 + 不可枚举 key 不等于可以放松类型：nosniff 保证浏览器
        // 不会把塞进来的 HTML 当页面解析。
        'X-Content-Type-Options': 'nosniff',
        'Content-Disposition': 'attachment; filename="' + key.slice(key.lastIndexOf('/') + 1) + '"',
        // key 随每次上传变化，旧地址指向的是旧包，长期缓存不会串版本。
        'Cache-Control': 'public, max-age=31536000, immutable',
      },
    });
  });
}

export async function onRequestPost(context) {
  return handle(context, async ({ env, request }) => {
    requireAuth(request, env, 'write');
    const body = await readJsonBody(request);
    const action = String(body.action || '').trim();

    if (action === 'sign') {
      const abi = String(body.abi || '').trim();
      if (!SUPPORTED_ABIS.has(abi)) {
        throw new ConfigError('不支持的架构：' + (abi || '(空)') + '（只支持 arm64-v8a / armeabi-v7a）');
      }
      const key = newApkKey(abi);
      const store = await apkStore(env);
      if (typeof store.createUploadUrl !== 'function') {
        throw new ConfigError(
          '当前 Blob SDK 不支持直传（缺少 createUploadUrl）：请把 @edgeone/pages-blob 升级到 0.0.19 及以上',
        );
      }
      const signed = await store.createUploadUrl(key, { expireSeconds: 3600 });
      return send({
        env,
        request,
        status: 200,
        body: {
          action: 'sign',
          key,
          uploadUrl: signed.url,
          expiresAt: signed.expiresAt,
          maxBytes: MAX_APK_BYTES,
        },
      });
    }

    if (action === 'finish') {
      const key = requireApkKey(body.key);
      const bytes = await readApkBytes(env, key);
      if (!bytes) throw new ConfigError('上传还没完成：Blob 里没有这个文件，请重试上传');
      const size = bytes.byteLength;
      if (size > MAX_APK_BYTES) {
        await deleteApk(env, key).catch(() => {});
        throw new ConfigError(
          '安装包 ' + (size / 1048576).toFixed(1) + ' MB 超过 '
          + (MAX_APK_BYTES / 1048576) + ' MB 上限，已删除',
        );
      }
      if (!looksLikeApk(bytes)) {
        // 把非 APK 的对象留在 Blob 里白占额度，直接清掉。
        await deleteApk(env, key).catch(() => {});
        throw new ConfigError('文件不是有效的 APK（ZIP 文件头不匹配），已删除');
      }
      return send({
        env,
        request,
        status: 200,
        body: {
          action: 'finish', key, size, sha256: await sha256Hex(bytes),
        },
      });
    }

    if (action === 'delete') {
      const key = requireApkKey(body.key);
      await deleteApk(env, key);
      return send({ env, request, status: 200, body: { action: 'delete', key, deleted: true } });
    }

    throw new ConfigError('未知操作：' + (action || '(空)') + '（支持 sign / finish / delete）');
  });
}
