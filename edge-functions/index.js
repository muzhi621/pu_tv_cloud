/**
 * GET / —— 在线配置编辑器。
 *
 * 编辑器由 scripts/build_edgeone_assets.py 把 editor/{index.html,style.css,app.js}
 * 内联成单个 HTML 字符串，因此本部署不需要任何静态资源目录或构建命令。
 *
 * 连接信息由本函数在「响应时」从环境变量注入，而不是写进仓库：
 * pu_tv_cloud 是公开仓库，任何硬编码的令牌都会立刻被扫描机器人抓走。
 * CONFIG_READ_TOKEN / CONFIG_WRITE_TOKEN 本来就是部署时必填的环境变量，
 * 这里复用来预填编辑器的三个输入框，打开页面即可直接「连接并加载」。
 *
 * 安全边界（2026-11-16 收紧）：能访问本页的人会在源码里看到令牌，因此预填
 * **默认关闭**——打开页面是空白输入框，需手动填写。仅当运营确认编辑器域名
 * 不对外传播时，才显式设置 CONFIG_EDITOR_PRELOAD=1 开启预填（兼容旧部署）。
 * 前端另把写令牌存进 sessionStorage（关闭标签页即失效），不落 localStorage。
 * 响应带 Cache-Control: no-store，避免 CDN 把带令牌的页面缓存给其他访客。
 */
import { EDITOR_HTML } from './_lib/editor.js';
import { handle, send } from './_lib/http.js';

const OFF_VALUES = ['0', 'false', 'off', 'no', 'disabled'];

/** 返回要预填的连接信息；关闭开关或未配置令牌时返回 null。 */
export function preloadDefaults(env, request) {
  // 默认关闭：安全优先，避免编辑器域名被打开即泄露写令牌。
  // 旧部署若依赖预填，需显式配置 CONFIG_EDITOR_PRELOAD=1。
  const flag = String(env.CONFIG_EDITOR_PRELOAD ?? '0').trim().toLowerCase();
  if (OFF_VALUES.includes(flag)) return null;
  const readToken = String(env.CONFIG_READ_TOKEN || '').trim();
  const writeToken = String(env.CONFIG_WRITE_TOKEN || '').trim();
  if (!readToken && !writeToken) return null; // devMode：没有令牌，无需预填
  return {
    base: new URL(request.url).origin,
    readToken,
    writeToken,
    autoConnect: true,
  };
}

/** 把默认值作为一小段脚本插到 </head> 前，JSON 里转义 < 防止闭合 script 标签。 */
export function injectDefaults(html, defaults) {
  if (!defaults) return html;
  const json = JSON.stringify(defaults)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026');
  const tag = `<script>window.__PURETV_DEFAULTS__=${json};</script>`;
  return html.replace('</head>', `${tag}\n</head>`);
}

export async function onRequestGet(context) {
  return handle(context, ({ env, request }) => send({
    env, request, status: 200,
    body: injectDefaults(EDITOR_HTML, preloadDefaults(env, request)),
    contentType: 'text/html; charset=utf-8',
  }));
}
