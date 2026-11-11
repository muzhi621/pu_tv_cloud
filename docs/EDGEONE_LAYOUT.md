# EdgeOne Pages 项目布局速查

**本仓库根目录就是 EdgeOne Pages 项目根目录。** 这是为了让控制台「Git 导入」时
根目录保持默认 `./` 即可零配置部署——`edge-functions/` 与 `edgeone.json` 必须位于项目根，
否则 EdgeOne 找不到函数，部署出来只有静态站点。

| 路径 | 作用 |
|---|---|
| `edge-functions/index.js` | `GET /` 在线配置编辑器（内联 HTML/CSS/JS） |
| `edge-functions/health.js` | `GET /health` |
| `edge-functions/api/config/index.js` | `GET/PUT /api/config`（ETag/304、If-Match/409） |
| `edge-functions/api/config/catalog.js` | `GET /api/config/catalog` |
| `edge-functions/api/config/revisions.js` | `GET /api/config/revisions` |
| `edge-functions/api/config/rollback.js` | `POST /api/config/rollback` |
| `edge-functions/_lib/` | 契约、KV 存储、HTTP 层 + 生成的内联资源 |
| `edgeone.json` | 无构建、输出目录 `public`、Node 22.11.0 |
| `public/robots.txt` | 让静态输出目录非空；**刻意不放 index.html**，避免覆盖函数首页 |
| `package.json` | 仅声明 ESM 与本地测试脚本，零依赖 |
| `edgeone.env.example`（本目录） | 需要在控制台填写的环境变量样例 |

`cloud/`、`config/`、`editor/`、`tests/`、`scripts/`、`index.py` 等属于 Python/FC
备选实现与构建工具，EdgeOne 构建时不会把它们放进静态产物（输出目录是 `public`）。

## 部署前必做

1. 控制台 **存储 → KV**：开通 KV、创建命名空间、**绑定到本项目且变量名填 `PURETV_KV`**。
   KV 只在 Edge Functions 中可用，且是运行时全局变量（不在 `context.env`）。
2. 创建项目页的「**环境变量**」里填 `CONFIG_READ_TOKEN`、`CONFIG_WRITE_TOKEN`（必须），
   可选 `CONFIG_KV_BINDING`、`CONFIG_CORS_ORIGINS`。
   **环境变量改动只对之后的部署生效**，建议先填好再点「开始部署」。
3. 控制台「Git 导入」→ 选 `muzhi621/pu_tv_cloud` → 生产分支 `main` →
   构建设置保持默认（`edgeone.json` 会覆盖构建命令与输出目录）→ 开始部署。

完整教程：[DEPLOY_EDGEONE.md](DEPLOY_EDGEONE.md)。接口契约：[API.md](API.md)。

> 若控制台是旧版 Pages Functions 项目（目录约定为 `functions/` 而非 `edge-functions/`），
> 把 `edge-functions/` 改名为 `functions/` 即可，handler 写法不变。
>
> 生成物 `edge-functions/_lib/data.js`、`_lib/editor.js` 由
> `scripts/build_edgeone_assets.py` 从 `config/*.json` 与 `editor/*` 生成，请勿手改；
> 改动源文件后重新运行该脚本，CI 会用 `--check` 校验一致性。
