# pu_tv_cloud · EdgeOne Pages 部署包

本目录的内容可直接作为 EdgeOne Pages / Makers 项目根上传，**零第三方依赖、零构建**。

| 路径 | 作用 |
|---|---|
| `edge-functions/index.js` | `GET /` 在线配置编辑器（内联 HTML/CSS/JS） |
| `edge-functions/health.js` | `GET /health` |
| `edge-functions/api/config/index.js` | `GET/PUT /api/config`（ETag/304、If-Match/409） |
| `edge-functions/api/config/catalog.js` | `GET /api/config/catalog` |
| `edge-functions/api/config/revisions.js` | `GET /api/config/revisions` |
| `edge-functions/api/config/rollback.js` | `POST /api/config/rollback` |
| `edge-functions/_lib/` | 契约、KV 存储、HTTP 层 + 生成的内联资源 |
| `edgeone.json` | 无构建、输出目录 `public` |
| `.env.example` | 需要填的环境变量 |

## 部署前必做

1. 控制台 **存储 → KV**：开通 KV、创建命名空间、**绑定到本项目且变量名填 `PURETV_KV`**。
   KV 只在 Edge Functions 中可用，且是全局变量（不在 `context.env`）。
2. 项目 **环境变量**：`CONFIG_READ_TOKEN`、`CONFIG_WRITE_TOKEN`（必须），
   可选 `CONFIG_KV_BINDING`、`CONFIG_CORS_ORIGINS`。
3. 部署：上传 `dist/pu_tv_cloud_edgeone_v1.0.0.zip`，或
   `edgeone pages deploy ./dist/pu_tv_cloud_edgeone_v1.0.0.zip -n pu-tv-cloud`。

完整教程：`../docs/DEPLOY_EDGEONE.md`（仓库内）。接口契约：`../docs/API.md`。

> 若控制台是旧版 Pages Functions 项目（目录约定为 `functions/` 而非 `edge-functions/`），
> 把 `edge-functions/` 改名为 `functions/` 即可，handler 写法不变。
>
> 生成物 `_lib/data.js`、`_lib/editor.js` 由 `scripts/build_edgeone_assets.py` 从
> `config/*.json` 与 `editor/*` 生成，请勿手改；改动源文件后重新运行该脚本。
