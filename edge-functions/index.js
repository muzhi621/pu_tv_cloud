/**
 * GET / —— 在线配置编辑器。
 *
 * 编辑器由 scripts/build_edgeone_assets.py 把 editor/{index.html,style.css,app.js}
 * 内联成单个 HTML 字符串，因此本部署不需要任何静态资源目录或构建命令。
 *
 * 连接信息：改成账号登录后，页面**只注入同源 API 地址，不注入任何令牌**。
 * 注入令牌（历史上 CONFIG_EDITOR_PRELOAD=1 的做法）等于绕开登录——任何打开
 * 该域名的人都能在源码里拿到写令牌，这正是本次改造要消除的问题。
 * 登录成功后前端拿的是会话令牌，真实读写令牌永不下发到浏览器。
 *
 * CONFIG_EDITOR_PRELOAD=0 仍可关闭地址预填（留空即手填），但开关与安全性无关。
 * 响应带 Cache-Control: no-store，避免 CDN 把页面缓存给其他访客。
 */
import { EDITOR_HTML } from './_lib/editor.js';
import { handle, send } from './_lib/http.js';

const OFF_VALUES = ['0', 'false', 'off', 'no', 'disabled'];

/** 返回要预填的连接信息：只有地址，没有令牌；关掉开关时返回 null。 */
export function preloadDefaults(env, request) {
  const flag = String(env.CONFIG_EDITOR_PRELOAD ?? '1').trim().toLowerCase();
  if (OFF_VALUES.includes(flag)) return null;
  return {
    base: new URL(request.url).origin,
    // 不自动连接：未登录前前端不主动请求，登录流程自己会带出地址并加载。
    autoConnect: false,
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
