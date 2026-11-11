/**
 * GET / —— 在线配置编辑器。
 *
 * 编辑器由 scripts/build_edgeone_assets.py 把 editor/{index.html,style.css,app.js}
 * 内联成单个 HTML 字符串，因此本部署不需要任何静态资源目录或构建命令：
 * 只要 edge-functions/ 目录 + KV 绑定就能跑起来。
 */
import { EDITOR_HTML } from './_lib/editor.js';
import { handle, send } from './_lib/http.js';

export async function onRequestGet(context) {
  return handle(context, ({ env, request }) => send({
    env, request, status: 200, body: EDITOR_HTML,
    contentType: 'text/html; charset=utf-8',
  }));
}
