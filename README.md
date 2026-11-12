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
> 本库 CI 在 push / PR 时运行 58 个 Python 单元测试、51 项 EdgeOne 接口冒烟、
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
  index.js              GET / 内联编辑器单页 + 从环境变量注入连接信息
  health.js             GET /health（含存储后端与 degraded 状态）
  api/config/           GET/PUT config、catalog、revisions、rollback（均支持 deviceId 隔离）
  api/devices/          GET 注册表（在线/离线）；POST 改名 / 重置 / 软删 / 恢复 /
                        彻底删除并拉黑 / 解绑 / 显式下发，支持 deviceIds 批量
  api/iptv/fetch.js     POST 云端代抓订阅（SSRF 防护、UTF-8/GBK 自动识别）
  _lib/                 contract.js（五节契约 + 套餐展开 + GET 轻量视图）/ storage.js
                        （KV/Blob 双后端 + 全局模板 + 每设备独立文档 + 注册表 +
                         在线状态 / 拉黑 / 乐观锁）/ http.js
                        + data.js、editor.js（由构建脚本生成，勿手改）
edgeone.json            ★ 项目配置：无构建、npm install 装 Blob SDK、输出目录 public
public/robots.txt       让静态输出目录非空（不放 index.html，避免覆盖函数首页）
package.json            声明 ESM 与 @edgeone/pages-blob 依赖（Blob 兜底用）
config/
  seed.json             内置兜底配置（五节全部 managed:false）—— 两个实现共用
  site_catalog.json     35 个站点 id（含中文名、退役标记）+ 8 个导航 id（含 iptv）
editor/                 在线配置编辑器源文件（零依赖静态页）
  index.html / app.js / style.css —— 6 个页签 + 套餐管理 + 在线状态 + 单终端全设置
                        面板 + 显式「配置下发」按钮
tests/                  58 个 Python 单元测试 + test_edgeone.mjs（Node 51 项冒烟，含
                        Blob 回退、驼峰 id、每设备隔离、套餐展开、SSRF、在线状态）
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
python3 -m unittest discover -s tests -v     # 58 个 Python 测试（FC/自建服务器实现）
node --test tests/test_edgeone.mjs            # 51 项 EdgeOne 冒烟（内存 KV/Blob，无需部署）
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
   可选：`CONFIG_EDITOR_PRELOAD=1`（默认，自动预填编辑器三个连接框）、
   `CONFIG_ONLINE_WINDOW_MINUTES=30`（在线判定窗口）、`CONFIG_CORS_ORIGINS`（跨域时）。
3. 「从 Git 导入」选 `muzhi621/pu_tv_cloud`、生产分支 `main` → 开始部署。
   安装命令由 `edgeone.json` 设为 `npm install`，用于装 Blob SDK（部署因此多花十几秒）。
4. 用教程里的 5 条 curl 验证，浏览器打开项目域名根路径即在线编辑器。

> ⚠️ **不要选「直接上传 zip」**：该方式要求压缩包根目录含 `index.html`（本项目首页由
> 函数提供，放 index.html 会覆盖编辑器路由），且 `edgeone.json` 在该方式下只支持
> redirects/rewrites/headers，还**永久无法切换回 Git 自动部署**。
> `python scripts/build_edgeone_assets.py --zip` 生成的包仅用于离线归档 / CLI 部署。

完整步骤、验证 curl、终端接入与排错见 [docs/DEPLOY_EDGEONE.md](docs/DEPLOY_EDGEONE.md)，
目录约定见 [docs/EDGEONE_LAYOUT.md](docs/EDGEONE_LAYOUT.md)。

浏览器打开项目域名根路径即编辑器，**三个连接框会自动填好并直接连上**：API 地址取当前
域名，两个令牌由 Edge Function 从 `CONFIG_READ_TOKEN` / `CONFIG_WRITE_TOKEN` 注入，
**不写进公开仓库**。设 `CONFIG_EDITOR_PRELOAD=0` 可恢复手动填写；注意能访问该页面的人
可在源码里看到写令牌，请勿公开传播编辑器域名。右上「配置对象」下拉可选**全局模板**或
**任意已上线终端**；首次访问自动写入 `seed.json` 的副本（revision 0，五节全部
`managed:false`）。**生产环境务必配置两个 Token**；都为空时服务处于开发模式，接口不鉴权。

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

单文档 `{schemaVersion, revision, updatedAt, sections}`，五个节各自带 `managed`：

| 节 | 接管内容 | 对应需求 |
|---|---|---|
| `sites` | `enabledSiteIds` 平台白名单（关闭斗鱼 → 终端不显示斗鱼页签） | FR-04 |
| `navigation` | `railMenuIds` 二级菜单白名单与顺序、`groups`（IPTV / 影音 / 直播 / 设置四个一级块及其 children）、`defaultGroupId`（默认 `iptv`）、`sidebarExpanded`、`homeKeepAlive` | FR-05 / FR-08 |
| `startup` | 协议 `requiredVersion`、开机公告、`exitDialog`（退出 App 弹窗：开关 / 频率 / 可取消 / 捐赠码 / 文案）、`showSplashPage` | FR-06 |
| `update` | 自动检查、间隔、提示策略、最低版本、镜像列表、更新日志 | FR-07 |
| `iptv` | `managed` + `sources` / `groups` / `epgUrl` / **套餐库 `packages`** / **每台设备勾选的 `selectedPackageIds`** / `channels`（选中套餐时由服务端展开，最多 3000 条） | 新增 |

服务端兜底规则：未知 / 退役 id 静默过滤；白名单过滤后为空则回退内置全量（防止终端
`global_room_push.dart:79` 的 `.first` 崩溃）；未知节忽略并记 warning；类型错误返回 400；
`iptv` 频道按 URL 去重、协议白名单 `http(s)/rtmp(s)/rtsp/udp/mms/p2p`、单包 3000 条、
套餐库合计 5000 条、最多 12 个套餐、总文档上限 900 KB；`update.prompt=force`
与不可关闭公告/不可取消退出弹窗会输出风险 warning。字段字典见需求文档 4.3。

## 每设备独立配置与设备注册表

终端首次启动自动生成 UUID v4 并持久化，之后每次 `GET /api/config` 都带
`deviceId`（也支持 `X-Device-Id` 头）以及可选的 `appVersion` / `model`。

| 概念 | 说明 |
|---|---|
| **全局模板** | 不带 `deviceId` 的请求读写的文档；也是新设备的初始副本 |
| **设备文档** | `device_<id>_current`，首次拉取时从全局模板深拷贝，之后**完全独立**、互不影响；revision 从 `max(1, 模板 revision+1)` 起，保证首包不会被 `since=0` 挡成 304 |
| **设备注册表** | `devices_index`，记录别名、`firstSeen` / `lastSeen`、`appVersion`、`model`、当前 revision；每次成功拉取即刷新「上线」，无额外心跳流量 |
| **重置** | 把某台设备重新覆盖为当前全局模板，生成该设备的新 revision |
| **移除** | 只删注册项；设备文档与快照保留，设备再次上线会自动恢复显示 |

编辑器「终端管理」页可逐台改名、编辑配置、重置为模板、移除；「配置对象」下拉切换后，
所有 GET / PUT / revisions / rollback 都会自动带上 `?deviceId=...`。
**注意：改全局模板不会影响已上线的设备**，要批量生效需逐台重置。

## IPTV 源下发

编辑器「IPTV 源」页支持三种输入：**网络 URL**、**本地文件（m3u/m3u8/txt）**、**直接粘贴文本**；
在浏览器内解析 M3U / M3U Plus / TXT `分组,#genre#` 格式（含 `group-title`、`tvg-logo`、
多线路同名合并），解析结果连同站点/导航等五节一起保存。

云端**只存解析后的频道列表，不抓取订阅、不转发直播流**：网络 URL 也是浏览器直接 fetch，
流量不经过 Edge Functions。终端拉取配置后把 `iptv.channels` 按分组还原成 TXT，
复用 `IptvImportManager` 写入本地 Drift（固定 provider `cloud_iptv`），
用 `deviceId:revision:频道数` 做导入幂等；`managed:false` 或频道为空时不动本地列表。
接口细节见 [docs/API.md](docs/API.md)。

## 与需求文档的实现偏差（需知悉）

| 项 | 文档计划 | 实际实现 | 原因 |
|---|---|---|---|
| 在线编辑器 FR-02 | 复用 `web_remote/` 的 Vue3 + Vite 工程，改 `BASE_URL` 并新增 4 视图 | 独立的零依赖静态单页（原生 JS），由配置服务同源托管 | `web_remote` 的 16 个视图全部依赖 TV 本机 8888 接口，云端库独立后这些接口失效；直接复制会带入一堆不可用功能，并额外引入 npm 构建链。现实现功能等价（4 视图、diff、409 冲突、历史回滚），可直接打开使用。如需 Vue3 版本可整体替换 `editor/` 而不影响 API |

其余 FR 均按文档实现。P1（设置菜单目录、HMAC 响应签名、APK SHA-256 校验、
`auto_sync_scheduler` 接线、热门源 URL 配置化）尚未开始，见需求文档第 10 节。

## 流量与成本

一次 `GET /api/config` 约 1–3 KB，命中 304 仅几十字节；开启 IPTV 下发后首包会带上
频道列表（最多 3000 条，整文档硬上限 900 KB），之后仍走 304。单台电视每天开机
5 次约 150 次/月 ≈ 0.5 MB/月，落在 EdgeOne 免费版额度内（Edge Functions
300 万次/月、KV 1 GB）。**云端不抓取 M3U 订阅、不做定时刷新**：URL 导入由编辑器
（浏览器）直接 fetch，服务端只存解析结果，因此不会产生额外出公网流量。

## 安全

- `PUT` / `rollback` / `POST /api/devices` 需要写 Token，其余 `GET /api/*` 需要读 Token；
  Token 比较用常数时间算法；编辑器分别填「访问令牌（读）」「保存令牌（写）」。
- `PUT` 必须携带 `If-Match`（或 `expectedRevision`），缺版本拒绝覆盖，冲突返回 409；
  每个设备的 revision 独立，改 A 设备不会让 B 设备的编辑失效。
- `deviceId` 只允许 `[A-Za-z0-9_-]{1,64}`，非法值直接 400；注册表上限 200 台。
- CORS 默认关闭；跨域部署时 `CONFIG_CORS_ORIGINS` 填精确域名，**不要用 `*`**。
- Cookie、代理凭据等敏感设置 v1 不上云；弹窗默认可关闭、强更默认关闭。
- EdgeOne KV 为最终一致，写操作是「读-比较-写」乐观锁，适合单写入者 / 个人规模；
  FC 多实例 + OSS 同理，多写入者场景需原子计数或把并发上限设为 1。

## 终端侧前提

终端库原本依赖 `F:/media_core/packages/...` 绝对路径（10 处），已改为指向公开仓库
`liuchuancong/media_core` 固定提交的 git 依赖。2026-11-11 已在 GitHub Actions 上完成
**完整 release 编译验证并发布 v3.0.8 Release**：`flutter pub get`、`flutter analyze`、
双 flavor × 3 ABI 的 R8 打包、Release 上传与 `releases.json` 回写全部通过。
（A 档瘦身后默认改为 **只发 impeller × armeabi-v7a/arm64-v8a 两个 ABI**；
v3.0.12 起收敛到单 MPV 内核 + WebP 表情；v3.0.13 起 native 库压缩打包，
两个 APK 降至 38.25 MB / 40.18 MB。）
终端侧接入云端配置使用编译期 `--dart-define=PURE_LIVE_CONFIG_URL/TOKEN`，
或运行时 Hive 键 `remoteConfigEndpoint` / `remoteConfigToken`（P0 暂无设置 UI）。
v3.0.12 起终端上报 `deviceId` / `appVersion`、并把 `iptv` 节落地本地 Drift。
