# 腾讯 EdgeOne Pages 部署教程 · pu_tv_cloud 配置下发服务

日期：2026-11-11 | 配套构建包：`dist/pu_tv_cloud_edgeone_v1.0.0.zip`（约 24 KB / 15 个文件，**零第三方依赖、零构建**）
适用仓库：`github.com/muzhi621/pu_tv_cloud`

> **为什么从阿里云 FC 换到 EdgeOne**：FC 是按量计费的（函数调用、资源规格、公网出流量），
> 且函数无状态，配置必须外挂 OSS 或 NAS，两者都会持续产生费用。而本服务只在客户端
> 开机/定时拉取一份几 KB 的 JSON（命中 ETag 时只回 304），EdgeOne Pages 免费版
> 的额度对这种用量等于零成本。
>
> **接口与 FC 版完全一致**，终端 APK 不需要改代码，只要把配置服务地址换成新的域名。
> 原 FC 方案保留在 [DEPLOY_FC.md](DEPLOY_FC.md)，可随时切回。

---

## 一、平台能力与费用（2026-11-11 核实）

EdgeOne Pages / Makers 目前提供**免费版，无需信用卡**，官方说明该免费套餐长期保留；
配额在商业化后可能调整，以控制台公告为准。

| 项目 | 免费版配额 | 本项目用量 |
|---|---|---|
| Edge Functions 执行次数 | **300 万次/月** | 单台电视每天开机 5 次 ≈ 150 次/月 |
| Edge Functions CPU Time | 300 万 ms/月（单次上限 200 ms CPU） | 一次配置读写 < 10 ms |
| 函数代码包 / 请求体 | 5 MB / 1 MB | 本包 24 KB；配置文档几 KB |
| KV 存储 | **1 GB**，单值 1 MB，最多 10 个命名空间 | 当前配置 + 100 份快照 < 1 MB |
| Blob 存储 | 1 GB | 未使用 |
| 构建次数 | 500 次/月 | 直接上传 zip 时为 0 |
| 自定义域名 + SSL | 200 个域名，免费证书 | 用 1 个 |
| Cloud Functions | 100 万次/月 | 未使用 |

> 结论：这个「配置下发 + 在线编辑」服务落在免费额度内，长期成本为 0。
> 相比之下 FC 侧需要为函数、出公网流量以及 OSS 存储/请求分别计费。

## 二、架构与限制

```
电视 APK ──GET /api/config?since=<rev>──▶ EdgeOne 边缘节点
                                          └─ Edge Function（JavaScript，ES2023+）
                                               ├─ KV：config_current / config_snapshot_* / config_revisions
                                               └─ GET / 返回内联的在线编辑器单页
浏览器 ──PUT /api/config（Bearer 写 token + If-Match）──▶ 同一 Edge Function
```

三个必须知道的平台约束：

1. **Edge Functions 只支持 JavaScript**（ES2023+），不支持 Python，所以把
   `cloud/schema.py`、`cloud/storage.py`、`cloud/app.py` 的逻辑移植成了
   `edgeone/edge-functions/_lib/{contract,storage,http}.js`，行为逐条对齐。
2. **KV 只能在 Edge Functions 中使用**，且是「中心存储 + 边缘缓存」的**最终一致性**：
   写入节点立即生效，其他边缘节点最长 60 秒后读到新值。单人编辑 + `If-Match`
   乐观锁完全够用；若要求全局强一致，需要改用 Blob 强一致模式并重写存储层。
3. **无状态、无文件系统**：配置和快照全部放 KV；编辑器 HTML/CSS/JS 由构建脚本
   内联成一个字符串常量，因此部署不需要静态资源目录，也不需要 npm 构建。

## 三、部署步骤

### 1. 先开通 KV（必须先于部署，否则函数启动即报错）

1. 登录 [EdgeOne 控制台](https://console.tencentcloud.com/edgeone/pages)，开通 Pages / Makers。
2. 进入 **存储 → KV**，点「立即申请」开通 KV 账户（免费版 1 GB）。
3. 「创建命名空间」，名称建议 `pu_tv_cloud_config`。
4. 创建项目后，在命名空间详情「关联项目」或项目详情「KV 存储」里绑定，
   **变量名必须填 `PURETV_KV`**（代码默认值；如填别的名字，把同名值写进环境变量
   `CONFIG_KV_BINDING`）。
   KV 在运行时是**全局变量**，不是 `context.env` 上的属性，所以绑定这一步不能省。

### 2. 创建项目并部署函数（三选一）

**方式 A · 控制台直接上传 zip（推荐，最简单）**

```bash
python scripts/build_edgeone_assets.py --zip
# -> dist/pu_tv_cloud_edgeone_v1.0.0.zip
```

控制台创建项目时选择「**直接上传**」，上传该 zip。构建命令留空 / 选「无构建」。
`edgeone.json` 已写好 `buildCommand: echo no-build`、`installCommand: echo no-install`、
`outputDirectory: public`，用于阻止平台误跑 npm 构建。

**方式 B · CLI 部署**

```bash
npm install -g edgeone
edgeone login                      # 选择 China / Global，浏览器完成登录
edgeone whoami
python scripts/build_edgeone_assets.py --zip
edgeone pages deploy ./dist/pu_tv_cloud_edgeone_v1.0.0.zip -n pu-tv-cloud
#                                              -n 项目名，不存在自动创建；-e preview 可发预览环境
```

> 若你的 CLI 版本提供 `edgeone makers ...` 子命令，先跑 `edgeone -h` 看实际命令；
> 新版 Makers 用 `edge-functions/` 目录，旧版 Pages Functions 用 `functions/` 目录，
> handler 写法一致——若控制台是旧版项目，把 `edge-functions/` 改名为 `functions/` 即可。
> 本地调试：`edgeone pages link`（同步 KV 绑定与环境变量）→ `edgeone pages dev`。

**方式 C · Git 导入**

把 `edgeone/` 目录的内容作为项目根（可单独建一个仓库，或把本仓库的 `edgeone/`
设为根目录）。控制台选择「Git 导入」，构建命令与输出目录按 `edgeone.json` 填写。

### 3. 设置环境变量（项目设置 → 环境变量）

| 变量 | 说明 |
|---|---|
| `CONFIG_READ_TOKEN` | 读 Token，APK 与编辑器读取配置用；**留空 = 不鉴权，仅限本地调试** |
| `CONFIG_WRITE_TOKEN` | 写 Token，`PUT` / `rollback` 用；留空则回退到读 Token |
| `CONFIG_KV_BINDING` | KV 绑定变量名，默认 `PURETV_KV`，与第 1 步控制台填的一致 |
| `CONFIG_CORS_ORIGINS` | 可选；编辑器同源部署留空，跨域时填精确域名（逗号分隔），**不要用 `*`** |

样例见 `edgeone/.env.example`。生成随机 Token 示例：`openssl rand -hex 24`。

### 4. 验证（把 `YOUR_DOMAIN` 换成项目域名）

```bash
# 1) 存活探测（无需鉴权）
curl -i https://YOUR_DOMAIN/health
# -> 200 {"status":"ok","revision":0,"backend":"edgeone-kv","devMode":false}

# 2) 读取配置
curl -i -H "Authorization: Bearer $READ_TOKEN" https://YOUR_DOMAIN/api/config
# -> 200 + ETag: "0" / X-Revision: 0 / X-Schema-Version: 1

# 3) 命中 ETag 返回 304（几乎零流量）
curl -i -H "Authorization: Bearer $READ_TOKEN" \
     -H 'If-None-Match: "0"' https://YOUR_DOMAIN/api/config

# 4) 写入：关闭斗鱼、只留 B 站 / 虎牙 / IPTV
curl -i -X PUT https://YOUR_DOMAIN/api/config \
  -H "Authorization: Bearer $WRITE_TOKEN" \
  -H 'If-Match: 0' -H 'Content-Type: application/json' \
  -d '{"sections":{"sites":{"managed":true,"enabledSiteIds":["bilibili","huya","iptv"]}}}'
# -> 200 revision=1；若被别人改过则 409 并带回当前文档

# 5) 历史与回滚
curl -H "Authorization: Bearer $READ_TOKEN" https://YOUR_DOMAIN/api/config/revisions
curl -X POST https://YOUR_DOMAIN/api/config/rollback \
  -H "Authorization: Bearer $WRITE_TOKEN" -H 'Content-Type: application/json' \
  -d '{"revision":1}'
```

浏览器打开 `https://YOUR_DOMAIN/` 即在线编辑器；**API 地址输入框留空 = 同源部署**，
只填 Token 即可编辑、保存、查看差异、回滚。

### 5. 终端 APK 接入（不用改客户端代码）

编译期注入（推荐）：

```bash
flutter build apk --release \
  --dart-define=PURE_LIVE_CONFIG_URL=https://YOUR_DOMAIN \
  --dart-define=PURE_LIVE_CONFIG_TOKEN=$READ_TOKEN
```

或运行时写入 Hive 键 `remoteConfigEndpoint` / `remoteConfigToken`（P0 暂无设置 UI）。
客户端请求路径为 `$base/api/config?since=<rev>`，带 `Authorization: Bearer <read token>`。

## 四、与 FC 版的差异

| 项 | 阿里云 FC 3.0（备选） | EdgeOne Pages（当前默认） |
|---|---|---|
| 运行时 | Python 3.10 WSGI `index.handler` | JavaScript Edge Functions `onRequest*` |
| 持久化 | OSS（需 `oss2`）或 NAS 挂载 | 内置 KV，零依赖、免费 1 GB |
| 静态编辑器 | 3 个静态文件由 WSGI 提供 | 构建期内联成单页，由 `/` 函数返回 |
| 压缩 | 应用内 gzip | 由平台 CDN 自动压缩，配置文档很小，无影响 |
| 一致性 | OSS 强一致 + 进程内锁 | KV 最终一致（其他节点最长 60s） |
| 费用 | 函数 + 流量 + OSS/NAS 按量计费 | 免费版额度内 0 元 |
| 接口契约 | **完全相同**（路径、头、状态码、JSON 结构） | 同左 |

切换到 EdgeOne **不需要改终端 APK**；`cloud/` Python 版继续保留，本地自建服务器、
阿里云 FC、任何 WSGI 环境仍可用，CI 也仍在跑它的 23 个单测。

## 五、排错

| 现象 | 原因 | 处理 |
|---|---|---|
| 500 且日志含「KV 命名空间未绑定」 | KV 未开通/未绑定，或变量名不是 `PURETV_KV` | 按第 1 步绑定，或设置 `CONFIG_KV_BINDING` |
| 所有 `/api/*` 返回 401 | Token 配错或请求头不是 `Bearer <token>` | 核对环境变量与 `edgeone/.env.example` |
| `PUT` 返回 409 | `If-Match` 落后（编辑器/其他设备已改过） | 编辑器会带回当前文档，刷新后重试 |
| 保存成功但 APK 没变化 | KV 边缘缓存最长 60s；或客户端命中 304 后未按新 revision 刷新 | 等 60s 或换节点重试；确认客户端读的是 `X-Revision` |
| `/` 打不开或 404 | 项目被当成静态站点、函数目录名不对 | 确认项目是 Makers 新版且目录为 `edge-functions/`；旧版改名为 `functions/` |
| 部署时报 npm 构建失败 | 控制台覆盖了 `edgeone.json` 的构建命令 | 构建命令填 `echo no-build`、输出目录填 `public` |
| `revisions` 为空 | 还没发生过写入；seed（revision 0）不生成快照 | 先 PUT 一次（这是预期行为，FC 版也一样） |

## 六、回退到 FC

```bash
python scripts/build_fc_package.py
# -> dist/pu_tv_cloud_fc_v1.0.0.zip
```

完整步骤见 [DEPLOY_FC.md](DEPLOY_FC.md)。注意 FC 侧的 `OSSStorage` **只支持 AK/SK 明文凭证**，
不支持函数 RAM 角色；且会产生按量费用。
