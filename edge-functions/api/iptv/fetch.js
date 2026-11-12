/**
 * POST /api/iptv/fetch —— 云端代抓 IPTV 订阅（M3U / M3U Plus / TXT）。
 *
 * 浏览器直接 fetch 第三方订阅会被 CORS 拦住，所以由 Edge Function 出公网取文本，
 * 解析仍在编辑器里做（parsePlaylist），云端只搬运内容、不抓定时订阅、不转流。
 *
 * 安全：这是「带鉴权的受限代理」，必须防 SSRF。只允许公网 http(s)，拒绝环回、
 * 私网、链路本地、保留段与 IPv6 本地地址；重定向手动跟随并逐跳复核；
 * 2 MiB 大小上限 + 10s 超时。DNS rebinding 无法在边缘运行时先验解析，
 * 因此只应填写可信订阅地址（见 docs/API.md）。
 */
import { ConfigError } from '../../_lib/contract.js';
import {
  handle, optionsHandler, readJsonBody, requireAuth, send,
} from '../../_lib/http.js';

export const onRequestOptions = optionsHandler;

const MAX_URLS = 10;
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const TIMEOUT_MS = 10000;
const REDIRECT_CODES = new Set([301, 302, 303, 307, 308]);
const PRIVATE_HOST_RE = /(^|\.)(localhost|local|internal|localhost\.localdomain)$/i;
const DANGEROUS_PORTS = new Set([
  21, 22, 23, 25, 110, 143, 445, 3306, 3389, 5432, 6379, 9200, 11211, 2375, 27017,
]);

function blockedIpv4(host) {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!match) return false;
  const parts = match.slice(1).map(Number);
  if (parts.some((part) => part > 255)) return true;
  const [a, b] = parts;
  if (a === 0 || a === 10 || a === 127 || a >= 224) return true;
  if (a === 169 && b === 254) return true;                 // link-local
  if (a === 172 && b >= 16 && b <= 31) return true;        // 172.16/12
  if (a === 192 && b === 168) return true;                 // 192.168/16
  if (a === 100 && b >= 64 && b <= 127) return true;       // CGNAT
  if (a === 198 && (b === 18 || b === 19)) return true;    // benchmark
  return false;
}

function blockedIpv6(host) {
  const value = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (!/^[0-9a-f:.]+$/.test(value)) return false;
  if (!value.includes(':')) return false;
  if (value === '::1' || value === '::') return true;
  if (/^f[cd]/.test(value)) return true;                   // fc00::/7
  if (/^fe[89ab]/.test(value)) return true;                // fe80::/10
  if (value.startsWith('::ffff:')) {
    const tail = value.slice(7);
    return blockedIpv4(tail) || tail.startsWith('127.') || tail.startsWith('10.');
  }
  return false;
}

/** 返回 {ok, reason}；只接受公网 http(s) 地址。导出便于离线测试。 */
export function checkFetchUrl(raw) {
  let parsed;
  try {
    parsed = new URL(String(raw || '').trim());
  } catch (_) {
    return { ok: false, reason: '不是合法 URL' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, reason: '仅支持 http(s)' };
  }
  if (parsed.username || parsed.password) {
    return { ok: false, reason: '不允许带账号密码的 URL' };
  }
  const host = parsed.hostname.toLowerCase();
  if (PRIVATE_HOST_RE.test(host) || blockedIpv4(host) || blockedIpv6(host)) {
    return { ok: false, reason: '禁止访问内网 / 环回地址' };
  }
  if (parsed.port && DANGEROUS_PORTS.has(Number(parsed.port))) {
    return { ok: false, reason: `禁止访问端口 ${parsed.port}` };
  }
  if (!host.includes('.') && !host.includes(':')) {
    return { ok: false, reason: '不接受无点号的短主机名' };
  }
  return { ok: true, url: parsed.href };
}

/** UTF-8 优先，出现替换字符时尝试 GBK（国内 M3U/TXT 源常见 GBK 编码）。 */
export function decodeSubscription(bytes) {
  let text = new TextDecoder('utf-8').decode(bytes);
  let encoding = 'utf-8';
  const utf8Bad = (text.match(/\uFFFD/g) || []).length;
  if (utf8Bad > 0) {
    try {
      const gbk = new TextDecoder('gbk').decode(bytes);
      if ((gbk.match(/\uFFFD/g) || []).length < utf8Bad) {
        text = gbk;
        encoding = 'gbk';
      }
    } catch (_) { /* 运行时不支持 GBK 时保留 UTF-8 结果 */ }
  }
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  return { text, encoding };
}

async function readLimited(response) {
  const declared = Number(response.headers.get('content-length') || 0);
  if (declared > MAX_BYTES) throw new Error(`内容超过 ${MAX_BYTES / 1024 / 1024} MiB`);
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const room = MAX_BYTES - total;
    if (value.length > room) {
      if (room > 0) chunks.push(value.slice(0, room));
      total = MAX_BYTES;
      truncated = true;
      break;
    }
    chunks.push(value);
    total += value.length;
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return { bytes, truncated };
}

async function fetchOne(raw) {
  const checked = checkFetchUrl(raw);
  if (!checked.ok) return { url: String(raw), ok: false, error: checked.reason };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let current = checked.url;
  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      const guard = checkFetchUrl(current);
      if (!guard.ok) return { url: String(raw), ok: false, error: `重定向被拒绝：${guard.reason}` };
      const response = await fetch(current, {
        redirect: 'manual',
        signal: controller.signal,
        headers: { Accept: '*/*', 'User-Agent': 'pu-tv-cloud/1.0' },
      });
      if (REDIRECT_CODES.has(response.status)) {
        const location = response.headers.get('location');
        if (!location) return { url: String(raw), ok: false, error: '重定向缺少 Location' };
        current = new URL(location, current).href;
        continue;
      }
      if (!response.ok) {
        return { url: String(raw), ok: false, error: `源站 HTTP ${response.status}` };
      }
      const { bytes, truncated } = await readLimited(response);
      const decoded = decodeSubscription(bytes);
      return {
        url: String(raw),
        finalUrl: current,
        ok: true,
        bytes: bytes.length,
        encoding: decoded.encoding,
        truncated,
        text: decoded.text,
      };
    }
    return { url: String(raw), ok: false, error: `重定向超过 ${MAX_REDIRECTS} 跳` };
  } catch (error) {
    const reason = error && error.name === 'AbortError' ? '抓取超时' : (error && error.message) || '网络错误';
    return { url: String(raw), ok: false, error: reason };
  } finally {
    clearTimeout(timer);
  }
}

export async function onRequestPost(context) {
  return handle(context, async ({ env, request }) => {
    // 导入源属于编辑动作，必须持有写令牌，避免被当成开放代理滥用。
    requireAuth(request, env, 'write');
    const body = await readJsonBody(request);
    const urls = Array.isArray(body.urls) ? body.urls : (body.url ? [body.url] : []);
    if (!urls.length) throw new ConfigError('请提供 urls 数组或 url 字符串');
    if (urls.some((item) => typeof item !== 'string')) {
      throw new ConfigError('urls 必须是字符串数组');
    }
    if (urls.length > MAX_URLS) throw new ConfigError(`一次最多抓取 ${MAX_URLS} 个订阅地址`);
    const results = [];
    for (const url of urls) results.push(await fetchOne(url));
    const text = results.filter((item) => item.ok).map((item) => item.text).join('\n');
    return send({
      env, request, status: 200,
      body: {
        results: results.map(({ text: _text, ...rest }) => rest),
        text,
        total: results.length,
        succeeded: results.filter((item) => item.ok).length,
      },
    });
  });
}
