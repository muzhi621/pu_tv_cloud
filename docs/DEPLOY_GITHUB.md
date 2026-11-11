# EdgeOne Pages · GitHub 直连部署方案（pu_tv_cloud）

日期：2026-11-11 | 适用仓库：`github.com/muzhi621/pu_tv_cloud`（`main`）
详细教程：[DEPLOY_EDGEONE.md](DEPLOY_EDGEONE.md) | 目录约定：[EDGEONE_LAYOUT.md](EDGEONE_LAYOUT.md)

## 0. 一句话

控制台「从 Git 仓库导入」→ 选中本仓库 → **构建设置保持默认** → 填两个 Token → 开始部署。
之后每次 push `main` 自动重建；日常改配置走在线编辑器，**不产生构建次数**。

## 1. 为什么可以零配置

EdgeOne 的硬约定是：`edge-functions/` 与 `edgeone.json` 必须位于**项目根目录**。
本仓库已把 EdgeOne 布局提升到根，因此根目录保持默认 `./` 即可：

| 根路径 | 作用 |
|---|---|
| `edge-functions/` | Edge Functions 路由（`/`、`/health`、`/api/config*`） |
| `edgeone.json` | 覆盖控制台构建配置 |
| `public/robots.txt` | 让静态输出目录非空（刻意不放 `index.html`，避免覆盖函数首页） |
| `package.json` | 仅声明 ESM 与本地测试脚本，零依赖 |
| `cloud/`、`editor/`、`config/`、`tests/` | Python/FC 备选实现与构建工具，不进入静态产物 |

`edgeone.json` 已写好，平台会自动读取，无需手填：

```json
{
  "buildCommand": "echo no-build",
  "installCommand": "echo no-install",
  "outputDirectory": "public",
  "nodeVersion": "22.11.0"
}
```

## 2. 部署前准备（3 件事）

1. **开通 Pages / Makers**：控制台首页开通，免费版无需信用卡。
2. **生成两个 Token**（读 / 写各一个，不要相同）：

   ```bash
   openssl rand -hex 24
   ```

3. **存储：KV 或 Blob，二选一**
   - **KV（要审核，可以先不管）**：`存储 → KV → 立即申请`（免费 1 GB）。弹窗要填存储量 /
     查询率 / 场景，照抄 [DEPLOY_EDGEONE.md 第 1.1 节](DEPLOY_EDGEONE.md#11-立即申请弹窗的申请理由怎么填)。
   - **Blob（免申请，推荐先用这个）**：不需要任何操作，部署后第一次请求时平台自动创建
     命名空间 `pu_tv_cloud`。**KV 审批期间服务会自动走 Blob**，代码不用改。
   - 两种后端数据不互通，切换后需在编辑器里重新保存一次配置。

## 3. 控制台逐项填写（对应「配置项目」页）

| 字段 | 填什么 |
|---|---|
| 项目名称 | `pu_tv_cloud`（随意，会成为默认域名前缀） |
| 加速区域 | 全球可用区（含中国大陆）；默认 `*.edgeone.run` 域名可直接用，绑自定义域名才涉及备案 |
| 仓库 / 生产分支 | `muzhi621/pu_tv_cloud` / `main` |
| 框架预设 | 其它 / 无（None） |
| **根目录** | **`./`（必须是仓库根）** |
| 构建命令 | `echo no-build` |
| 安装命令 | `npm install --omit=dev --no-audit --no-fund`（由 `edgeone.json` 提供，用来装 Blob SDK） |
| 输出目录 | `public` |
| Node 版本 | `22.11.0` |

> ⚠️ 若你此前按「旧结构」把根目录填成 `edgeone`，**必须改回 `./` 并重新部署一次**，
> 否则部署出来只有静态站点、所有 API 404。

**环境变量（展开后先填，再点「开始部署」）**：

| 变量 | 说明 |
|---|---|
| `CONFIG_READ_TOKEN` | 读 Token，APK 与编辑器读取配置用 |
| `CONFIG_WRITE_TOKEN` | 写 Token，`PUT` / `rollback` 用 |
| `CONFIG_KV_BINDING` | 可选，默认 `PURETV_KV` |
| `CONFIG_CORS_ORIGINS` | 可选，编辑器同源部署留空 |

> 环境变量改动**只对之后的部署生效**；先填后部署，可省一次重部署。

**创建后绑定 KV**：项目详情 → `KV 存储` → 绑定命名空间 → **变量名填 `PURETV_KV`**。
KV 在运行时是全局变量，不在 `context.env`，这一步不能省。

## 4. 首次验证（5 条，把 `YOUR_DOMAIN` 换掉）

```bash
# 1) 存活（无需鉴权）
curl -i https://YOUR_DOMAIN/health
# 200 {"status":"ok","revision":0,"backend":"edgeone-kv","devMode":false}

# 2) 读配置
curl -i -H "Authorization: Bearer $READ_TOKEN" https://YOUR_DOMAIN/api/config
# 200 + ETag: "0" / X-Revision: 0 / X-Schema-Version: 1

# 3) ETag 命中 304（几乎零流量，客户端日常路径）
curl -i -H "Authorization: Bearer $READ_TOKEN" \
     -H 'If-None-Match: "0"' https://YOUR_DOMAIN/api/config

# 4) 写入：关闭斗鱼，只留 B 站 / 虎牙 / IPTV
curl -i -X PUT https://YOUR_DOMAIN/api/config \
  -H "Authorization: Bearer $WRITE_TOKEN" \
  -H 'If-Match: 0' -H 'Content-Type: application/json' \
  -d '{"sections":{"sites":{"managed":true,"enabledSiteIds":["bilibili","huya","iptv"]}}}'
# 200 revision=1；被并发改过则 409 并带回当前文档

# 5) 历史与回滚
curl -H "Authorization: Bearer $READ_TOKEN" https://YOUR_DOMAIN/api/config/revisions
curl -X POST https://YOUR_DOMAIN/api/config/rollback \
  -H "Authorization: Bearer $WRITE_TOKEN" -H 'Content-Type: application/json' \
  -d '{"revision":1}'
```

浏览器打开 `https://YOUR_DOMAIN/` 即在线编辑器：API 地址留空（同源），只填 Token 即可编辑、保存、看差异、回滚。

## 5. 日常维护

| 场景 | 操作 | 是否触发构建 |
|---|---|---|
| 改站点显隐 / 导航 / 启动弹窗 / 更新策略 | 打开编辑器保存 | 否，直接写 KV |
| 改函数代码、契约、编辑器页面 | `git push origin main` | 是，自动部署 |
| 改环境变量 | 控制台改完**重新部署** | 是（需手动一次） |
| 配置改错想撤回 | `revisions` 查历史 → `rollback` | 否 |
| 只想验证新分支 | 推到非 `main` 分支 | 是，走预览环境 |

发布前本地自检（CI 也会跑同一套）：

```bash
python -m unittest discover -s tests        # 25 个 Python 单测
node --test tests/test_edgeone.mjs          # 22 项 EdgeOne 冒烟
python scripts/build_edgeone_assets.py --check
```

## 6. 终端 APK 接入（不改客户端代码）

```bash
flutter build apk --release \
  --dart-define=PURE_LIVE_CONFIG_URL=https://YOUR_DOMAIN \
  --dart-define=PURE_LIVE_CONFIG_TOKEN=$READ_TOKEN
```

或运行时写 Hive 键 `remoteConfigEndpoint` / `remoteConfigToken`（P0 暂无设置 UI）。
客户端请求 `$base/api/config?since=<rev>` + `Authorization: Bearer <read token>`。

## 7. 故障对照

| 现象 | 原因 | 处理 |
|---|---|---|
| `/` 或 `/api/*` 全 404 | 根目录不是 `./`，函数没被识别 | 改回 `./` 并重新部署 |
| 500「KV 命名空间未绑定」 | KV 未绑定或变量名不对 | 绑定并确认变量名 `PURETV_KV` |
| `/api/*` 全 401 | Token 不对，或部署后才补环境变量 | 核对 Token；补完**重新部署** |
| 构建报 `npm run build` 失败 | 平台覆盖了 `edgeone.json` | 构建命令改 `echo no-build`、输出目录 `public` |
| 保存成功但 APK 未变 | KV 边缘缓存最长 60s；或客户端命中 304 | 等 60s 或换节点；确认客户端按 `X-Revision` 刷新 |
| `revisions` 为空 | 还没写入过（seed revision 0 不生成快照） | 先 PUT 一次，属预期 |

## 8. 方案边界

- 云端**只下发配置**，不承载直播流、弹幕、转码，出网流量接近于零（一次 1–3 KB，命中 ETag 仅几十字节）。
- KV 为最终一致性：写入节点立即生效，其他边缘节点最长 60 秒；单人编辑 + `If-Match` 乐观锁足够。
- 免费额度：Edge Functions 300 万次/月、KV 1 GB、构建 500 次/月，本服务远低于上限。
- **不要用控制台「直接上传 zip」**：该方式要求根目录含 `index.html`、`edgeone.json` 只支持
  redirects/rewrites/headers，且永久无法切回 Git 自动部署。
