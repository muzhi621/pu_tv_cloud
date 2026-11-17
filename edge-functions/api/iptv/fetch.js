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
  // IPv4-mapped（::ffff:a.b.c.d）经 new URL() 后会被规范化成十六进制压缩形式：
  // ::ffff:127.0.0.1 → ::ffff:7f00:1，::ffff:169.254.169.254 → ::ffff:a9fe:a9fe。
  // 原来的点分十进制判断对这两种形式完全失效，等于给云元数据地址开了后门。
  // 订阅业务没有访问映射地址的正当理由，直接整体拒绝（含未压缩的 0:0:0:0:0:ffff: 前缀）。
  if (/^(::ffff:|0+:0+:0+:0+:0+:ffff:)/.test(value)) return true;
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
  // FQDN 尾点会让 "$" 锚定的正则与「无点号短主机名」兜底双双失效：
  // new URL('http://localhost./').hostname === 'localhost.'。必须先去尾点再判。
  const host = parsed.hostname.toLowerCase().replace(/\.+$/, '');
  // 显式拒绝 localhost 与 *.localhost（RFC 6761 规定二者都解析到环回），
  // 不依赖正则的 /\./ 分支，避免后续调整正则时再漏。
  if (host === 'localhost' || host.endsWith('.localhost')
      || PRIVATE_HOST_RE.test(host) || blockedIpv4(host) || blockedIpv6(host)) {
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

/**
 * 读取响应体，最多 MAX_BYTES 字节。
 *
 * 坑（2026-11-15 线上实测）：EdgeOne Pages Functions 里 response.body 虽然
 * 提供了 getReader()，但读出来是「空流」（第一次 read 就 done:true），导致
 * 所有订阅都抓成 0 字节，编辑器只会含糊地报「抓取成功但内容为空」。
 * 而同一个 Response 的 arrayBuffer() 能拿到完整内容。因此改为**整体读取优先**，
 * 只有 arrayBuffer 不可用或确实为空时才退回流式读取。
 */
async function readLimited(response) {
  const declared = Number(response.headers.get('content-length') || 0);
  if (declared > MAX_BYTES) throw new Error(`内容超过 ${MAX_BYTES / 1024 / 1024} MiB`);

  let buffer = null;
  try {
    if (typeof response.arrayBuffer === 'function') {
      buffer = new Uint8Array(await response.arrayBuffer());
    }
  } catch (_) { /* 某些运行时只实现 body 流，走下面的兜底 */ }
  if (buffer && buffer.length > 0) {
    return clip(buffer);
  }

  // 兜底：整体读取不可用 / 返回空时再试流。body 可能已被消费，失败就忽略。
  if (response.body && typeof response.body.getReader === 'function') {
    try {
      const reader = response.body.getReader();
      const chunks = [];
      let total = 0;
      let truncated = false;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value || !value.length) continue;
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
      if (bytes.length > 0) return { bytes, truncated };
    } catch (_) { /* body 已被 arrayBuffer 消费，忽略 */ }
  }
  return { bytes: buffer && buffer.length ? clip(buffer).bytes : new Uint8Array(0), truncated: false };
}

function clip(buffer) {
  const truncated = buffer.length > MAX_BYTES;
  return { bytes: truncated ? buffer.slice(0, MAX_BYTES) : buffer, truncated };
}

/**
 * 判断响应体是不是配置文本。订阅/TVBox 配置都是纯文本，源站偶尔会返回
 * 头像、验证码图、jar / gzip 等二进制，把乱码当 GBK 文本解析只会得到「0 个频道」，
 * 用户完全看不出原因。这里提前给出人话提示。导出便于离线测试。
 */
export function detectBinaryPayload(bytes, contentType) {
  const type = String(contentType || '').split(';')[0].trim().toLowerCase();
  const b = bytes;
  // 先按实际字节判定：content-type 经常被标错（例如把 JPEG 标成 image/x-ms-bmp）。
  if (b.length >= 3 && b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF) return 'JPEG 图片';
  if (b.length >= 4 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47) return 'PNG 图片';
  if (b.length >= 3 && String.fromCharCode(b[0], b[1], b[2]) === 'GIF') return 'GIF 图片';
  if (b.length >= 2 && b[0] === 0x42 && b[1] === 0x4D) return 'BMP 图片';
  if (b.length >= 2 && b[0] === 0x1F && b[1] === 0x8B) return 'gzip 压缩数据';
  if (b.length >= 4 && b[0] === 0x50 && b[1] === 0x4B) return 'ZIP/JAR 压缩包';
  if (b.length >= 4 && String.fromCharCode(b[0], b[1], b[2], b[3]) === '%PDF') return 'PDF 文件';
  if (b.length >= 3 && String.fromCharCode(b[0], b[1], b[2]) === 'ID3') return 'MP3 音频';
  // 只拦明确的二进制 MIME。M3U 的正当类型恰恰是 audio/x-mpegurl、
  // application/vnd.apple.mpegurl 等，绝不能按 audio/video 大类一刀切。
  if (/^image\//.test(type) || [
    'application/octet-stream', 'application/zip', 'application/x-zip-compressed',
    'application/gzip', 'application/x-gzip', 'application/pdf',
    'application/java-archive',
  ].includes(type)) {
    return `${type} 内容`;
  }
  // HTML 网页（反爬页 / 首页跳转）也不是配置。注意不能用「UTF-8 替换字符比例」
  // 判二进制：国内 GBK 编码的 M3U 会被误伤，编码识别交给 decodeSubscription。
  if (type === 'text/html' || /^\s*<(?:!doctype\s+html|html)/i.test(
    new TextDecoder('utf-8').decode(b.subarray(0, 256)),
  )) return 'HTML 网页';
  return '';
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
      const contentType = response.headers.get('content-type') || '';
      const meta = {
        url: String(raw),
        finalUrl: current,
        httpStatus: response.status,
        contentType,
        // 诊断用：declaredLength > 0 但 bytes 为 0 说明是运行时读取问题，
        // 两者都为 0 才是源站真的没返回内容。
        declaredLength: Number(response.headers.get('content-length') || 0),
      };
      if (!response.ok) {
        return { ...meta, ok: false, error: `源站 HTTP ${response.status}` };
      }
      const { bytes, truncated } = await readLimited(response);
      // 空内容必须判失败：以前会 ok:true + bytes:0，编辑器只得到一句
      // 「抓取成功但内容为空」，用户无从判断是源站问题还是云端问题。
      if (!bytes.length) {
        return {
          ...meta, ok: false, bytes: 0,
          error: `源站返回空内容（HTTP ${response.status}${contentType ? '，' + contentType.split(';')[0] : ''}）`,
        };
      }
      const binary = detectBinaryPayload(bytes, contentType);
      if (binary) {
        return {
          ...meta, ok: false, bytes: bytes.length,
          error: `源站返回的是${binary}，不是订阅文本；请确认配置地址是否正确或已失效`,
        };
      }
      const decoded = decodeSubscription(bytes);
      if (!decoded.text.trim()) {
        return { ...meta, ok: false, bytes: bytes.length, error: '源站内容为空文本' };
      }
      return {
        ...meta,
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
    await requireAuth(request, env, 'write');
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
