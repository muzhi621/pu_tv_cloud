/**
 * GET /api/auth/diag —— 临时诊断端点：逐步探测登录链路依赖的运行时能力。
 *
 * 线上表现为「Param Invalid」这种平台文案时，无法从堆栈判断是 WebCrypto 还是
 * KV 写入的问题。这里把每一步单独跑一遍并回传结果，定位完即删除。
 * 不返回任何密钥内容，只返回成功与否和错误消息。
 */
import { handle, send } from '../../_lib/http.js';
import { readMeta, writeMeta } from '../../_lib/storage.js';

async function probe(out, name, run) {
  try {
    out[name] = await run();
  } catch (error) {
    out[name] = `ERR ${(error && error.name) || 'Error'}: ${(error && error.message) || error}`;
  }
}

export async function onRequestGet(context) {
  return handle(context, async ({ env, request }) => {
    const url = new URL(request.url);
    const iterations = Math.max(1, Math.min(Number(url.searchParams.get('iter')) || 1000, 500000));
    const out = {};
    out.iterations = iterations;
    out.cryptoType = typeof globalThis.crypto;
    out.hasSubtle = !!(globalThis.crypto && globalThis.crypto.subtle);

    await probe(out, 'random', () => {
      const buffer = new Uint8Array(16);
      globalThis.crypto.getRandomValues(buffer);
      return Array.from(buffer, (b) => b.toString(16).padStart(2, '0')).join('');
    });

    await probe(out, 'digest', async () => {
      const digest = await globalThis.crypto.subtle.digest(
        'SHA-256', new TextEncoder().encode('probe'),
      );
      return new Uint8Array(digest).length;
    });

    await probe(out, 'pbkdf2', async () => {
      const key = await globalThis.crypto.subtle.importKey(
        'raw', new TextEncoder().encode('probe'), 'PBKDF2', false, ['deriveBits'],
      );
      const bits = await globalThis.crypto.subtle.deriveBits(
        { name: 'PBKDF2', salt: new Uint8Array(16), iterations, hash: 'SHA-256' },
        key,
        256,
      );
      return new Uint8Array(bits).length;
    });

    await probe(out, 'envUser', () => String((env && env.CONFIG_ADMIN_USER) || ''));
    await probe(out, 'envPasswordLength',
      () => String((env && env.CONFIG_ADMIN_PASSWORD) || '').length);

    await probe(out, 'metaRead', async () => (await readMeta(env, 'auth_probe')) === null);
    await probe(out, 'metaWrite', async () => {
      await writeMeta(env, 'auth_probe', { at: Date.now() });
      return true;
    });
    await probe(out, 'metaReadBack', async () => {
      const value = await readMeta(env, 'auth_probe');
      return !!(value && value.at);
    });

    // 真正跑一遍 loadAccount（会顺带把环境变量里的账号初始化进 KV）：
    // 成功即说明登录链路可用，失败则把真实错误带出来。
    await probe(out, 'loadAccount', async () => {
      const { loadAccount } = await import('../../_lib/auth.js');
      const account = await loadAccount(env);
      return account ? 'ok' : 'none';
    });

    return send({ env, request: context.request, status: 200, body: out });
  });
}
