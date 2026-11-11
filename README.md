# 纯粹直播 TV · 云端配置服务（cloud 库）

两个独立仓库中的**云端库**。只下发配置，不承载任何直播流、弹幕或转码流量。

| 仓库 | 路径 | 内容 |
|---|---|---|
| **cloud（本库）** | `G:/workbuddy/puretv/pure_live_tv_cloud` | **EdgeOne 配置服务（默认）**、FC 备选、配置契约、在线编辑器、测试、部署脚本 |
| **client（终端库）** | `G:/workbuddy/puretv/pure_live_tv_client` | 完整 Flutter 客户端源码 + `RemoteConfigService` 改造 |
| 需求文档 | `G:/workbuddy/puretv/纯粹直播TV_云端配置下发_需求文档_v1.0.md` | 契约、FR、改动清单、验收、风险、分期 |

> **部署目标（2026-11-11 起）**：默认改为**腾讯 EdgeOne Pages（Edge Functions + KV/Blob）**。
> 原因是阿里云 FC 的函数调用、公网流量与 OSS/NAS 存储会持续产生按量费用，
> 而 EdgeOne Pages 免费版的额度对本服务「开机拉一次几 KB JSON」的用量等于零成本。
> **接口契约完全不变**，终端 APK 只需换配置地址。原 FC/Python 实现保留为备选，
> 可用于本地自建服务器或已有 FC 环境。完整步骤见 [docs/DEPLOY_EDGEONE.md](docs/DEPLOY_EDGEONE.md)。

> **仓库状态**：已按用户审核同意后提交到 GitHub，默认分支 `main`。
> 云端库 → `https://github.com/muzhi621/pu_tv_cloud`，
> 终端库 → `https://github.com/muzhi621/pu_tv_client`。
> 本库 CI 在 push / PR 时运行 25 个 Python 单元测试、22 项 EdgeOne 接口冒烟、
> 内联资源一致性检查与语法检查（`.github/workflows/ci.yml`）。

## 目录

```
cloud/                  Python/WSGI 实现（FC、自建服务器；零第三方依赖，OSS 后端除外）
  schema.py             配置契约：校验、规范化、兜底（需求文档 4.2~4.4）
  storage.py            FileStorage / OSSStorage、revision 乐观锁、历史快照
  app.py                WSGI 应用：API + 鉴权 + ETag/304/409 + 静态编辑器
  server.py             本地 / 自建服务器 / FC Web 函数启动入口
★ 仓库根目录即 EdgeOne Pages 项目根（Git 导入零配置）
edge-functions/         ★ Edge Functions（ES2023+，唯一运行时依赖 @edgeone/pages-blob）
  index.js              GET / 内联编辑器单页
  health.js             GET /health（含存储后端与 degraded 状态）
  api/config/           GET/PUT config、catalog、revisions、rollback
  _lib/                 contract.js（契约）/ storage.js（KV/Blob 双后端 + 乐观锁）/ http.js
                        + data.js、editor.js（由构建脚本生成，勿手改）
edgeone.json            ★ 项目配置：无构建、npm install 装 Blob SDK、输出目录 public
public/robots.txt       让静态输出目录非空（不放 index.html，避免覆盖函数首页）
package.json            声明 ESM 与 @edgeone/pages-blob 依赖（Blob 兜底用）
config/
  seed.json             内置兜底配置（四节全部 managed:false）—— 两个实现共用
  site_catalog.json     35 个站点 id（含中文名、退役标记）+ 7 个导航 id
editor/                 在线配置编辑器源文件（零依赖静态页）
  index.html / app.js / style.css —— EdgeOne 版内联，FC 版同源托管
tests/                  25 个 Python 单元测试 + test_edgeone.mjs（Node 22 项冒烟，含 Blob 回退与驼峰 id 回归）
docs/
  API.md                接口说明（两种实现共用同一契约）
  DEPLOY_GITHUB.md      ★ GitHub 直连部署方案（控制台逐项、验证、维护、排错）
  DEPLOY_EDGEONE.md     腾讯 EdgeOne Pages 完整教程（平台能力、KV、终端接入）
  EDGEONE_LAYOUT.md     EdgeOne 项目根目录布局与部署前必做
  edgeone.env.example   EdgeOne 环境变量样例
  DEPLOY_FC.md          阿里云 FC 3.0 备选方案（会产生按量费用）
scripts/
  run_local.sh          本地一键启动 Python 版
  build_edgeone_assets.py  ★ 生成 EdgeOne 内联资源；--check 校验；--zip 打包
  build_fc_package.py   生成阿里云 FC 代码包（备选）
index.py                FC Python HTTP 函数入口（index.handler）
.env.example            Python/FC 版环境变量样例
requirements.txt        仅 OSS 后端需要 oss2
```

## 快速开始

```bash
cd G:/workbuddy/puretv/pure_live_tv_cloud
python3 -m unittest discover -s tests -v     # 25 个 Python 测试（FC/自建服务器实现）
node --test tests/test_edgeone.mjs            # 22 项 EdgeOne 接口冒烟（内存 KV/Blob，无需部署）
python scripts/build_edgeone_assets.py --check  # 校验内联资源与源文件一致
sh scripts/run_local.sh                       # Python 版，默认 http://127.0.0.1:8080/
```

## 部署到腾讯 EdgeOne Pages（默认，Git 导入）

**仓库根目录就是 EdgeOne 项目根目录**，所以控制台「Git 导入」后**构建设置保持默认即可**：
`edge-functions/`、`edgeone.json` 都在根上，平台会自动读取 `edgeone.json` 的
「无构建 + 输出目录 `public`」，以后每次 push `main` 自动重新部署。

1. **存储二选一**：
   - **KV（推荐，需申请）**：控制台 **存储 → KV → 立即申请**（可能要审核），创建命名空间、
     绑定项目，**变量名填 `PURETV_KV`**。
   - **Blob（免申请，即用即得）**：什么都不用做，首次请求时 `@edgeone/pages-blob` 会用
     默认命名空间 `pu_tv_cloud` 自动创建。KV 未绑定时服务**自动走 Blob**，不用改代码。
2. 创建项目页展开「**环境变量**」，填 `CONFIG_READ_TOKEN` / `CONFIG_WRITE_TOKEN`
   （**必须先填再点开始部署**，环境变量变更只对之后的部署生效）。
3. 「从 Git 导入」选 `muzhi621/pu_tv_cloud`、生产分支 `main` → 开始部署。
   安装命令由 `edgeone.json` 设为 `npm install`，用于装 Blob SDK（部署因此多花十几秒）。
4. 用教程里的 5 条 curl 验证，浏览器打开项目域名根路径即在线编辑器。

> ⚠️ **不要选「直接上传 zip」**：该方式要求压缩包根目录含 `index.html`（本项目首页由
> 函数提供，放 index.html 会覆盖编辑器路由），且 `edgeone.json` 在该方式下只支持
> redirects/rewrites/headers，还**永久无法切换回 Git 自动部署**。
> `python scripts/build_edgeone_assets.py --zip` 生成的包仅用于离线归档 / CLI 部署。

完整步骤、验证 curl、终端接入与排错见 [docs/DEPLOY_EDGEONE.md](docs/DEPLOY_EDGEONE.md)，
目录约定见 [docs/EDGEONE_LAYOUT.md](docs/EDGEONE_LAYOUT.md)。

浏览器打开项目域名根路径即编辑器。首次访问自动写入 `seed.json` 的副本
（revision 0，四节全部 `managed:false`）。**生产环境务必配置两个 Token**；
都为空时服务处于开发模式，接口不鉴权。

**存储后端自动选择**：检测到 KV 绑定就用 KV，否则用 Blob（强一致读）。可用
`CONFIG_STORAGE=kv|blob` 强制指定，`/health` 会返回实际生效的 `backend`
（`edgeone-kv` / `edgeone-blob`）以及 `degraded` 状态。两者都是最终一致模型，
写入节点立即生效；本服务是单人编辑 + `If-Match` 乐观锁，个人规模足够。

## 备选：阿里云 FC / 本地自建服务器

```bash
python scripts/build_fc_package.py
# -> dist/pu_tv_cloud_fc_v1.0.0.zip（约 26 KB，零第三方依赖）
```

FC 侧注意：**file 裸跑仅供验证**（无状态、重启回 seed）、
**OSS + oss2 用于生产**（WebIDE 执行 `pip3 install -r requirements.txt -t .`）、
**NAS 挂载 + file 可零依赖持久化**。当前 `OSSStorage` 只支持 AK/SK 明文凭证，
不支持函数 RAM 角色。FC 与 OSS/NAS 会持续产生按量费用，详见 [docs/DEPLOY_FC.md](docs/DEPLOY_FC.md)。

## 配置契约（v1）

单文档 `{schemaVersion, revision, updatedAt, sections}`，四个节各自带 `managed`：

| 节 | 接管内容 | 对应需求 |
|---|---|---|
| `sites` | `enabledSiteIds` 平台白名单（关闭斗鱼 → 终端不显示斗鱼页签） | FR-04 |
| `navigation` | `railMenuIds` 首页 rail 白名单与顺序、`sidebarExpanded`、`homeKeepAlive`；`settings` 为 P1 预留 | FR-05 / FR-08 |
| `startup` | 协议 `requiredVersion`、公告内容与频率、`showSplashPage` | FR-06 |
| `update` | 自动检查、间隔、提示策略、最低版本、镜像列表、更新日志 | FR-07 |

服务端兜底规则：未知 / 退役 id 静默过滤；白名单过滤后为空则回退内置全量（防止终端
`global_room_push.dart:79` 的 `.first` 崩溃）；未知节忽略并记 warning；类型错误返回 400；
`update.prompt=force` 与不可关闭公告会输出风险 warning。字段字典见需求文档 4.3。

## 与需求文档的实现偏差（需知悉）

| 项 | 文档计划 | 实际实现 | 原因 |
|---|---|---|---|
| 在线编辑器 FR-02 | 复用 `web_remote/` 的 Vue3 + Vite 工程，改 `BASE_URL` 并新增 4 视图 | 独立的零依赖静态单页（原生 JS），由配置服务同源托管 | `web_remote` 的 16 个视图全部依赖 TV 本机 8888 接口，云端库独立后这些接口失效；直接复制会带入一堆不可用功能，并额外引入 npm 构建链。现实现功能等价（4 视图、diff、409 冲突、历史回滚），可直接打开使用。如需 Vue3 版本可整体替换 `editor/` 而不影响 API |

其余 FR 均按文档实现。P1（设置菜单目录、HMAC 响应签名、APK SHA-256 校验、
`auto_sync_scheduler` 接线、热门源 URL 配置化）尚未开始，见需求文档第 10 节。

## 流量与成本

一次 `GET /api/config` 约 1–3 KB，命中 304 仅几十字节。单台电视每天开机
5 次约 150 次/月 ≈ 0.5 MB/月，落在 EdgeOne 免费版额度内（Edge Functions
300 万次/月、KV 1 GB）。**不要把 M3U 订阅抓取放到云端定时触发**：出公网流量与
抓取逻辑都不属于本服务，订阅刷新仍留在客户端。

## 安全

- `PUT` / `rollback` 需要写 Token，`GET` 需要读 Token；Token 比较用常数时间算法。
- `PUT` 必须携带 `If-Match`（或 `expectedRevision`），缺版本拒绝覆盖，冲突返回 409。
- CORS 默认关闭；跨域部署时 `CONFIG_CORS_ORIGINS` 填精确域名，**不要用 `*`**。
- Cookie、代理凭据等敏感设置 v1 不上云；弹窗默认可关闭、强更默认关闭。
- EdgeOne KV 为最终一致，写操作是「读-比较-写」乐观锁，适合单写入者 / 个人规模；
  FC 多实例 + OSS 同理，多写入者场景需原子计数或把并发上限设为 1。

## 终端侧前提

终端库原本依赖 `F:/media_core/packages/...` 绝对路径（10 处），已改为指向公开仓库
`liuchuancong/media_core` 固定提交的 git 依赖。2026-11-11 已在 GitHub Actions 上完成
**完整 release 编译验证并发布 v3.0.8 Release**：`flutter pub get`、`flutter analyze`、
双 flavor × 3 ABI 的 R8 打包、Release 上传与 `releases.json` 回写全部通过。
（A 档瘦身后默认改为 **只发 impeller × armeabi-v7a/arm64-v8a 两个 ABI**，下次发版生效。）
终端侧接入云端配置使用编译期 `--dart-define=PURE_LIVE_CONFIG_URL/TOKEN`，
或运行时 Hive 键 `remoteConfigEndpoint` / `remoteConfigToken`（P0 暂无设置 UI）。
