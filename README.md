# 纯粹直播 TV · 云端配置服务（cloud 库）

两个独立仓库中的**云端库**。只下发配置，不承载任何直播流、弹幕或转码流量。

| 仓库 | 路径 | 内容 |
|---|---|---|
| **cloud（本库）** | `G:/workbuddy/puretv/pure_live_tv_cloud` | FC 配置服务、配置契约、在线编辑器、测试、部署脚本 |
| **client（终端库）** | `G:/workbuddy/puretv/pure_live_tv_client` | 完整 Flutter 客户端源码 + `RemoteConfigService` 改造 |
| 需求文档 | `G:/workbuddy/puretv/纯粹直播TV_云端配置下发_需求文档_v1.0.md` | 契约、FR、改动清单、验收、风险、分期 |

> **仓库状态**：已按用户审核同意后提交到 GitHub，默认分支 `main`。
> 云端库 → `https://github.com/muzhi621/pu_tv_cloud`，
> 终端库 → `https://github.com/muzhi621/pu_tv_client`。
> 本库 CI 在 push / PR 时运行 23 个单元测试与语法检查（`.github/workflows/ci.yml`）。

## 目录

```
cloud/                  服务代码（零第三方依赖，OSS 后端除外）
  schema.py             配置契约：校验、规范化、兜底（需求文档 4.2~4.4）
  storage.py            FileStorage / OSSStorage、revision 乐观锁、历史快照
  app.py                WSGI 应用：API + 鉴权 + ETag/304/409 + 静态编辑器
  server.py             本地 / 自建服务器 / FC Web 函数启动入口
config/
  seed.json             内置兜底配置（四节全部 managed:false）
  site_catalog.json     35 个站点 id（含中文名、退役标记）+ 7 个导航 id
editor/                 在线配置编辑器（零依赖静态页，同源托管）
  index.html / app.js / style.css
tests/                  23 个单元测试（unittest）
docs/
  API.md                接口说明
  DEPLOY_FC.md          阿里云 FC 3.0 完整部署教程（构建包 / 三种存储方案 / 排错表）
scripts/
  run_local.sh          本地一键启动
  build_fc_package.py   生成阿里云 FC 代码包（输出到 dist/，已 gitignore）
index.py                FC Python HTTP 函数入口（index.handler）
.env.example            环境变量样例
requirements.txt        仅 OSS 后端需要 oss2
```

## 快速开始

```bash
cd G:/workbuddy/puretv/pure_live_tv_cloud
python3 -m unittest discover -s tests -v     # 23 个测试
sh scripts/run_local.sh                       # 默认 http://127.0.0.1:8080/
```

## 打包部署到阿里云 FC

```bash
python scripts/build_fc_package.py
# -> dist/pu_tv_cloud_fc_v1.0.0.zip（约 26 KB，零第三方依赖）
```

在 FC 控制台创建 Python 3.10 HTTP 函数、上传该 zip、请求处理程序填 `index.handler`，
设置 `CONFIG_READ_TOKEN` / `CONFIG_WRITE_TOKEN` 即可验证接口与在线编辑器。
包内自带 `DEPLOY.md` 速查，完整步骤见 [docs/DEPLOY_FC.md](docs/DEPLOY_FC.md)。

注意三种存储方案的区别：**file 裸跑仅供验证**（FC 无状态，重启回 seed）、
**OSS + oss2 用于生产**（需在 FC WebIDE 执行 `pip3 install -r requirements.txt -t .`）、
**NAS 挂载 + file 可零依赖持久化**。当前 `OSSStorage` 只支持 AK/SK，不支持函数 RAM 角色。

浏览器打开 `http://127.0.0.1:8080/` 即编辑器。首次启动会自动在 `data/` 生成
`seed.json` 的副本（revision 0，四节全部 `managed:false`），该目录不入库。

生产环境务必设置 `CONFIG_READ_TOKEN` / `CONFIG_WRITE_TOKEN`（见 `.env.example`）。
两个 Token 都为空时服务处于**开发模式**，接口不鉴权，仅限本机/内网使用。

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

一次 `GET /api/config` 经 gzip 约 1–3 KB，命中 304 仅几十字节。单台电视每天开机
5 次约 150 次/月 ≈ 0.5 MB/月。**不要把 M3U 订阅抓取放到 FC 定时触发**，出公网流量
走 CDT 单独计费；订阅刷新仍留在客户端。

## 安全

- `PUT` / `rollback` 需要写 Token，`GET` 需要读 Token；Token 比较用常数时间算法。
- `PUT` 必须携带 `If-Match`（或 `expectedRevision`），缺版本拒绝覆盖，冲突返回 409。
- CORS 默认关闭；跨域部署时 `CONFIG_CORS_ORIGINS` 填精确域名，**不要用 `*`**。
- Cookie、代理凭据等敏感设置 v1 不上云；弹窗默认可关闭、强更默认关闭。
- FC 多实例并发写时 OSS 无跨实例 CAS 原语，本实现为「读-比较-写」乐观锁，适合
  单写入者 / 个人规模；多写入者建议 Tablestore 原子计数或把实例并发上限设为 1。

## 终端侧前提

终端库原本依赖 `F:/media_core/packages/...` 绝对路径（10 处），已改为指向公开仓库
`liuchuancong/media_core` 固定提交的 git 依赖。2026-11-11 已在 GitHub Actions 上完成
**完整 release 编译验证并发布 v3.0.8 Release（6 个 APK）**：`flutter pub get`、
`flutter analyze`、双 flavor × 3 ABI 的 R8 打包、Release 上传与 `releases.json` 回写全部通过。
终端侧接入云端配置使用编译期 `--dart-define=PURE_LIVE_CONFIG_URL/TOKEN`，
或运行时 Hive 键 `remoteConfigEndpoint` / `remoteConfigToken`（P0 暂无设置 UI）。
