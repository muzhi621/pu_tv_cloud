# 腾讯 EdgeOne Pages 部署教程 · pu_tv_cloud 配置下发服务

日期：2026-11-11 | 部署方式：**控制台「Git 导入」直接拉 GitHub，零配置**（仓库根即项目根）
适用仓库：`github.com/muzhi621/pu_tv_cloud` | 离线归档包：`dist/pu_tv_cloud_edgeone_v1.0.0.zip`

> **为什么从阿里云 FC 换到 EdgeOne**：FC 是按量计费的（函数调用、资源规格、公网出流量），
> 且函数无状态，配置必须外挂 OSS 或 NAS，两者都会持续产生费用。而本服务只在客户端
> 开机/定时拉取一份几 KB 的 JSON（命中 ETag 时只回 304），EdgeOne Pages 免费版
> 的额度对这种用量等于零成本。
>
> **核心配置契约与 FC 版一致**（五节结构、字段校验、ETag / 304 / 409、核心错误码），
> 终端 APK 不需要改配置读取逻辑，只要把服务地址换成新的域名。但 EdgeOne 版**额外**
> 提供 `/api/iptv/fetch`、完整 `/api/devices` 设备管理、按 `deviceId` 的设备维度隔离
> 与在线判定、编辑器令牌预填；FC 版没有这些接口。逐项对照见 [API.md](API.md) 的
> 「与 FC 版的差异（API 视角）」。原 FC 方案保留在 [DEPLOY_FC.md](DEPLOY_FC.md)，可随时切回。

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
| 构建次数 | 500 次/月 | Git 导入每次 push `main` 触发 1 次，日常改配置走编辑器不产生构建 |
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
   `edge-functions/_lib/{contract,storage,http}.js`，行为逐条对齐。
2. **KV 只能在 Edge Functions 中使用**，且是「中心存储 + 边缘缓存」的**最终一致性**：
   写入节点立即生效，其他边缘节点最长 60 秒后读到新值。单人编辑 + `If-Match`
   乐观锁完全够用；若要求全局强一致，需要改用 Blob 强一致模式并重写存储层。
3. **无状态、无文件系统**：配置和快照全部放 KV；编辑器 HTML/CSS/JS 由构建脚本
   内联成一个字符串常量，因此部署不需要 npm 构建，也不需要把编辑器源码放进静态产物
   （`public/` 里只放 `robots.txt` 让输出目录非空）。

## 三、部署步骤（推荐：直接拉 GitHub / Git 导入）

> **仓库根目录就是 EdgeOne Pages 项目根目录。** `edge-functions/`、`edgeone.json`、
> `public/`、`package.json` 全部位于仓库根，因此选「Git 导入」后根目录保持默认 `./`、
> 构建设置保持默认即可——`edgeone.json` 会自动覆盖构建命令与输出目录。
> 这也是唯一支持「push `main` 自动部署」的方式。
> **若 GitHub 上拉到的仍是旧结构**（函数目录在 `edgeone/edge-functions/`），
> 无需等代码更新：在「构建设置」里把**根目录填 `edgeone`**，并手动填
> 构建命令 `echo no-build`、安装命令 `echo no-install`、输出目录 `public`、Node `22.11.0`，
> 效果完全相同（不要依赖 `edgeone.json`，因为它在子目录时未必被平台读取）。

### 1. 先开通 KV（必须先于首次请求，否则函数报「KV 命名空间未绑定」）

1. 登录 [EdgeOne 控制台](https://console.tencentcloud.com/edgeone/pages)，开通 Pages / Makers。
2. 进入 **存储 → KV**，点「立即申请」开通 KV 账户（免费版 1 GB）。
3. 「创建命名空间」，名称建议 `pu_tv_cloud_config`。
4. 创建项目后，在命名空间详情「关联项目」或项目详情「KV 存储」里绑定，
   **变量名必须填 `PURETV_KV`**（代码默认值；如填别的名字，把同名值写进环境变量
   `CONFIG_KV_BINDING`）。
   KV 在运行时是**全局变量**，不是 `context.env` 上的属性，所以绑定这一步不能省。

#### 1.1 「立即申请」弹窗的申请理由怎么填

控制台会要求填三项（存储量 / 查询率 / 使用场景），按本项目实测数据填写即可，
**不要夸大**——这个服务的真实用量极小，写大了反而容易被要求补充说明：

| 表单项 | 建议填写 |
|---|---|
| 预计存储数据量 | `100MB` |
| 预期查询率 | `10 QPS` |
| 使用场景描述 | 见下方文案 |

**使用场景描述（直接复制，约 200 字）**：

```text
用于自建 Android TV 播放器的「云端配置下发」：把站点显隐、导航栏菜单、启动弹窗
文案、版本更新策略四类配置以一个小 JSON 文档（约 1.2KB）形式存于 KV，客户端
App 启动时读取一次，用于灰度控制功能开关，避免每次调整都重新发版。

访问特征：
1) 客户端每次启动拉取一次配置，带 ETag 条件请求，未变更时返回 304、无响应体；
2) 仅管理员在网页编辑器保存时写入，写入频率约每天数次，带 revision 乐观锁；
3) 保留最近 20 个历史版本用于回滚，单键值 < 2KB。

预估用量：键数量约 25 个、总量 < 100KB（按 3 年增长估算上限 20MB）；
日均读请求约 500 次、写入 < 10 次，常态 < 1 QPS，峰值 < 10 QPS。
无图片、视频、日志等大对象存储，配置文档是纯文本 JSON。
```

> 为什么这么小：单份配置文档实测 **1217 字节**；`config:current` + 20 份
> `config:rev:*` 快照合计约 **25 KB**。编辑器前端是内联在函数代码里的字符串常量，
> **不占 KV**。若审核要求给"业务规模"，按「个人项目 + 数百台自有设备」描述即可。

#### 1.2 KV 还在审批？直接用 Blob，不用等

Blob 是 EdgeOne 的分布式对象存储，**免申请**：首次调用 `getStore("pu_tv_cloud")` 时
平台自动为项目创建命名空间，免费版同样 1 GB。本服务的存储层做了自动降级：

| 情况 | `/health` 的 `backend` | 行为 |
|---|---|---|
| KV 已绑定 | `edgeone-kv` | 走 KV |
| KV 未绑定，依赖正常 | `edgeone-blob` | 自动走 Blob（强一致读） |
| 都没有 | `none` + `status: degraded` | API 返回 503，并给出修复提示 |

注意事项：

1. **部署时必须让 `npm install` 跑起来**。`edgeone.json` 已把安装命令设为
   `npm install --omit=dev --no-audit --no-fund`，用来装 `@edgeone/pages-blob`。
   若你在控制台把它改回了 `echo no-install`，Blob 兜底会失效（返回 503）。
2. **Blob 与 KV 的数据不互通**。KV 审批通过并绑定后服务会切回 KV，看到的是 revision 0
   的种子配置 —— 需要在编辑器里重新保存一次（或先 `curl` 导出旧配置再 PUT 回去）。
   想避免搬数据，就等 KV 下来再切，或全程只用 Blob。
3. Blob 默认最终一致（其他节点最长 60s），本服务读取统一用强一致模式，写入后立即可读，
   `If-Match` 乐观锁正常工作；代价是每次读多几十毫秒，对每次开机拉一次配置的终端无感。
4. 想强制只用其中一种，设环境变量 `CONFIG_STORAGE=kv` 或 `CONFIG_STORAGE=blob`。

### 2. 创建项目（对应控制台「配置项目」页）

| 配置项 | 填法 |
|---|---|
| 项目名称 | `pu_tv_cloud`（随意） |
| 加速区域 | 全球可用区（含中国大陆）；默认分配的 `*.edgeone.run` 域名可直接使用，绑定自定义域名才涉及备案 |
| 导入方式 | **从 Git 仓库导入**，选 `muzhi621/pu_tv_cloud` |
| 生产分支 | `main` |
| 构建设置 | **展开后保持默认**：框架预设「其它 / 无」、根目录 `./`、构建命令 `echo no-build`、安装命令 `echo no-install`、输出目录 `public`、Node `22.11.0`。若平台自动填成 `npm run build`，手动改回 `echo no-build` |
| 环境变量 | **展开后填好再点开始部署**（见下表） |

| 变量 | 说明 |
|---|---|
| `CONFIG_READ_TOKEN` | 读 Token，APK 与编辑器读取配置用；**留空 = 不鉴权，仅限本地调试** |
| `CONFIG_WRITE_TOKEN` | 写 Token，`PUT` / `rollback` 用；留空则回退到读 Token |
| `CONFIG_KV_BINDING` | KV 绑定变量名，默认 `PURETV_KV`，与第 1 步控制台填的一致 |
| `CONFIG_STORAGE` | 可选，`auto`（默认，有 KV 用 KV，否则 Blob）/ `kv` / `blob`。KV 审批期间建议显式写 `blob`，避免日志里反复出现探测失败 |
| `CONFIG_BLOB_NAMESPACE` | 可选，Blob 命名空间名，默认 `pu_tv_cloud`；不存在时首次写入自动创建 |
| `CONFIG_CORS_ORIGINS` | 可选；编辑器同源部署留空，跨域时填精确域名（逗号分隔），**不要用 `*`** |
| `CONFIG_EDITOR_PRELOAD` | 可选，默认 `1`。打开编辑器时把读写令牌与当前域名注入页面，自动预填并自动连接；设 `0`（或 `false` / `off` / `no` / `disabled`）关闭，恢复手动填写 |
| `CONFIG_ONLINE_WINDOW_MINUTES` | 可选，默认 `30`。终端在线判定窗口（分钟）；客户端前台约每 15 分钟同步一次配置 |

> **令牌预填的安全边界（务必阅读）**：`CONFIG_EDITOR_PRELOAD=1` 时，Edge Function 在
> 响应编辑器 HTML 时把 `CONFIG_READ_TOKEN` / `CONFIG_WRITE_TOKEN` / 当前域名写成
> `window.__PURETV_DEFAULTS__` 注入页面（令牌**不写进公开仓库**，响应带
> `Cache-Control: no-store`）。代价是：**能打开编辑器页面的人可在页面源码里看到写令牌**。
> 因此不要把编辑器域名公开传播；公开站点请配合访问控制（或反向代理鉴权），
> 或直接设 `CONFIG_EDITOR_PRELOAD=0` 让使用者手动填写。连接信息的优先级为
> 「本机 localStorage 改过的值 > 注入默认值 > 空白」，用户改过之后不再被覆盖。

样例见 [edgeone.env.example](edgeone.env.example)。生成随机 Token：`openssl rand -hex 24`。

> **顺序很重要**：环境变量改动**只对之后的部署生效**。如果已经点过「开始部署」才补 Token，
> 需要到「构建部署」页点「新建部署 / 重新部署」，或 push 一次 `main` 触发自动部署。
> 同理，KV 绑定要在第一次访问 `/health` 之前完成。

### 3. 为什么不要选「直接上传 zip」

控制台的「直接上传」方式有三条硬限制，和本项目结构冲突：

1. **上传的 zip / 文件夹根目录必须包含 `index.html`**；本项目首页 `/` 由
   `edge-functions/index.js` 动态返回编辑器，放静态 `index.html` 反而会按
   「静态资源优先」规则覆盖编辑器首页。
2. 该方式下 `edgeone.json` **只支持 `redirects` / `rewrites` / `headers` / `caches`**，
   `buildCommand`、`outputDirectory` 等字段不生效。
3. 选了直接上传的项目**以后无法切换到 Git 集成**，必须新建项目才能用自动部署。

因此 `python scripts/build_edgeone_assets.py --zip` 生成的包只用于**离线归档**或
**CLI 部署**（`edgeone pages deploy <zip> -n pu-tv-cloud`，CLI 会自行构建），
不作为控制台上传方式推荐。

> 若你的 CLI 版本提供 `edgeone makers ...` 子命令，先跑 `edgeone -h` 看实际命令；
> 新版 Makers 用 `edge-functions/` 目录，旧版 Pages Functions 用 `functions/` 目录，
> handler 写法一致。本地调试：`edgeone pages link`（同步 KV 绑定与环境变量）→ `edgeone pages dev`。

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

浏览器打开 `https://YOUR_DOMAIN/` 即在线编辑器。默认 `CONFIG_EDITOR_PRELOAD=1` 时，
右上角三个框**已由服务端预填，且页面加载后自动连接**，通常无需手动操作
（关闭预填、或本机 localStorage 里改过连接信息时，按下表手动填写并点「连接并加载」）：

| 输入框 | 填什么 |
|---|---|
| API 地址 | **留空**（同源部署）；跨域调试才填完整域名 |
| 访问令牌（读） | `CONFIG_READ_TOKEN`，用于加载配置、目录、历史 |
| 保存令牌（写） | `CONFIG_WRITE_TOKEN`，用于「保存到云端」和「回滚」；留空则用访问令牌（仅当读写同一个 Token 或开发模式时可行） |

服务端**读写令牌分离**：读令牌 GET 有效、PUT 会 401；写令牌 PUT 有效、GET 会 401。
手动填写时两个框都要填，否则会出现「能加载但保存失败」或「加载就 401」。
令牌预填的安全边界见第 2 步环境变量说明——公开站点请配合访问控制或设 `0`。

编辑器共 6 个页签：站点 / 导航 / 启动 / 更新 / **IPTV 源** / **终端管理**。
右上角「配置对象」下拉可选「全局模板（新设备初始值）」或某台已上线终端。

- **每台终端独立配置**：终端（v3.0.12+）首次启动生成 UUID 并随请求上报
  `deviceId` / `appVersion`，服务端自动登记并深拷一份完整配置。改全局模板
  **不会**影响已上线设备，要批量生效请在「终端管理」逐台操作。
- **IPTV 云端导入与套餐**：在「IPTV 源」页可填订阅 URL（一行一个，最多 10 个）、
  选本地 `txt|m3u|m3u8` 文件、或直接粘贴文本。点「云端抓取 URL」时由
  `POST /api/iptv/fetch` 出公网代抓（绕过浏览器 CORS，需写令牌，详见 [API.md](API.md)）；
  解析仍在编辑器内完成。解析结果可「存为新套餐 / 追加到套餐 / 直接写入频道」，
  套餐可勾选组合。选中套餐后频道只在套餐库存一份，`GET /api/config` 按勾选顺序
  展开到 `channels`。若云端代抓接口不可用（例如自建服务未部署该函数），编辑器会
  **回退浏览器直连**，此时仍受 CORS 限制，失败时请改用本地文件或粘贴文本。
  约束：套餐最多 12 个、所有套餐频道合计 5000 条、展开后 `channels` 最多 3000 条、
  整文档 `sections` 900 KB、请求体 2 MiB；非法协议与重复 URL 会被过滤。
- **终端管理**：显示在线 / 离线（`CONFIG_ONLINE_WINDOW_MINUTES`，默认 30 分钟）、
  批量勾选操作、编辑单台终端的完整配置，以及「配置下发」按钮（先保存，再对目标设备
  执行 `push` 生成新 revision）。管理动作共 8 种：`rename` / `comment` / `delete`
  （软删除，可 `restore`）/ `restore` / `purge`（彻底删除 + 拉黑）/ `unblock` /
  `reset` / `push`。被 `purge` 拉黑的设备再请求 `/api/config` 返回 `403 device_blocked`。

### 5. 终端 APK 接入（不用改客户端代码）

编译期注入（推荐）：

```bash
flutter build apk --release \
  --dart-define=PURE_LIVE_CONFIG_URL=https://YOUR_DOMAIN \
  --dart-define=PURE_LIVE_CONFIG_TOKEN=$READ_TOKEN
```

或运行时写入 Hive 键 `remoteConfigEndpoint` / `remoteConfigToken`（P0 暂无设置 UI）。
客户端请求路径为 `$base/api/config?since=<rev>&deviceId=<uuid>&appVersion=<v>`，
带 `Authorization: Bearer <read token>`。**旧版终端不带 `deviceId` 也能用**，
只是所有设备共用全局模板这一份配置。

## 四、与 FC 版的差异

| 项 | 阿里云 FC 3.0（备选） | EdgeOne Pages（当前默认） |
|---|---|---|
| 运行时 | Python 3.10 WSGI `index.handler` | JavaScript Edge Functions `onRequest*` |
| 持久化 | OSS（需 `oss2`）或 NAS 挂载 | 内置 KV（需申请）或 Blob（免申请，自动兜底），各 1 GB |
| 静态编辑器 | 3 个静态文件由 WSGI 提供 | 构建期内联成单页，由 `/` 函数返回 |
| 压缩 | 应用内 gzip | 由平台 CDN 自动压缩，配置文档很小，无影响 |
| 一致性 | OSS 强一致 + 进程内锁 | KV 最终一致（其他节点最长 60s） |
| 费用 | 函数 + 流量 + OSS/NAS 按量计费 | 免费版额度内 0 元 |
| 接口契约 | **核心配置契约相同**；但 FC 无 `/api/devices` / `/api/iptv/fetch`、无设备维度与在线判定，请求体 1 MiB、PUT 不校验 900 KB 文档上限 | 额外提供上述能力；请求体 2 MiB、PUT 校验 900 KB 文档上限 |

切换到 EdgeOne **不需要改终端 APK 的配置读取逻辑**；`cloud/` Python 版继续保留，
本地自建服务器、阿里云 FC、任何 WSGI 环境仍可用，CI 也仍在跑它的全量单测
（`python -m unittest discover -s tests`，当前 58 项）。逐项差异见 [API.md](API.md)。

## 五、排错

| 现象 | 原因 | 处理 |
|---|---|---|
| `/api/*` 返回 503 `storage_unavailable` | KV 未绑定，且 Blob SDK 没装上（安装命令被改回 `echo no-install`） | 安装命令改回 `npm install --omit=dev`，重新部署；或按第 1 步绑定 KV |
| `/health` 返回 `status: degraded`、`backend: none` | 同上，存储层完全不可用 | 看 `storageError` 文案；绑定 KV 或修好依赖后重新部署 |
| `/health` 返回 `backend: edgeone-blob` | KV 还没绑定，服务已在用 Blob，属正常 | 无需处理；KV 审批通过后绑定即自动切回 KV（数据不迁移） |
| 所有 `/api/*` 返回 401 | Token 配错或请求头不是 `Bearer <token>`；或部署后才补的环境变量 | 核对环境变量与 [edgeone.env.example](edgeone.env.example)，补填后**重新部署**（环境变量不影响旧部署） |
| `PUT` 返回 409 | `If-Match` 落后（编辑器/其他设备已改过） | 编辑器会带回当前文档，刷新后重试 |
| 保存成功但 APK 没变化 | KV 边缘缓存最长 60s；或客户端命中 304 后未按新 revision 刷新 | 等 60s 或换节点重试；确认客户端读的是 `X-Revision` |
| `/` 打不开或 404、所有 `/api/*` 404 | 函数根本没被部署：根目录设错（指向了子目录）、函数目录名不对 | 控制台「项目设置 - 构建部署配置」把**根目录设为 `./`**；确认仓库根有 `edge-functions/`；旧版项目改名为 `functions/` |
| 部署时报 npm 构建失败 | 平台自动识别框架并填了 `npm run build`，覆盖了 `edgeone.json` | 构建命令填 `echo no-build`、安装命令 `echo no-install`、输出目录填 `public` |
| 直接上传 zip 被拒 | 该方式要求 zip 根目录含 `index.html` | 改用 Git 导入；本项目首页由函数提供，不要放静态 index.html |
| `revisions` 为空 | 还没发生过写入；seed（revision 0）不生成快照 | 先 PUT 一次（这是预期行为，FC 版也一样） |

## 六、回退到 FC

```bash
python scripts/build_fc_package.py
# -> dist/pu_tv_cloud_fc_v1.0.0.zip
```

完整步骤见 [DEPLOY_FC.md](DEPLOY_FC.md)。注意 FC 侧的 `OSSStorage` **只支持 AK/SK 明文凭证**，
不支持函数 RAM 角色；且会产生按量费用。

## 七、本轮新增能力速查（2026-11-12）

| 类别 | 新增 | 说明 |
|---|---|---|
| 环境变量 | `CONFIG_EDITOR_PRELOAD=1` | 编辑器连接信息自动预填 + 自动连接；设 `0` 关闭。安全边界见第 2 步 |
| 环境变量 | `CONFIG_ONLINE_WINDOW_MINUTES=30` | 终端在线判定窗口（分钟） |
| 接口 | `POST /api/iptv/fetch` | **写令牌**；一次最多 10 个公网 http(s) 订阅地址，单源 2 MiB / 10s，手动跟随最多 3 跳重定向且逐跳复核 SSRF，UTF-8 / GBK 自动识别。仅 EdgeOne，FC 版无此接口 |
| 接口 | `GET /api/devices` | 返回 `{devices,total,online,blocked,onlineWindowMinutes}`；每台带 `online` / `status` / `lastSeenAgo` / `hidden` / `blocked` / `comment` / `pushedAt` / `pushedRevision` |
| 接口 | `POST /api/devices` | 8 种动作 `rename` / `comment` / `delete` / `restore` / `purge` / `unblock` / `reset` / `push`；单台或批量（去重≤50）；响应 `{action,total,failed,results}`，单台失败不影响其它台 |
| 错误码 | `403 device_blocked` | 被 `purge` 拉黑的设备请求 `/api/config` 被拒 |
| 契约 | `navigation.groups` / `defaultGroupId` | 四大类一级栏（`iptv` / `vod` / `live` / `settings`）+ 右侧二级菜单；最多 8 组，默认 `iptv` |
| 契约 | `startup.exitDialog` | 退出 App 弹窗，云端下发；`enabled=false` 时终端沿用本地原弹窗 |
| 契约 | `iptv.packages` / `selectedPackageIds` | 最多 12 个套餐、频道总预算 5000、展开后 `channels` 上限 3000 |
| 视图 | `GET /api/config?withPackages=1` | 默认轻量视图把套餐剥离为 `{id,name,sources,channelCount}`；编辑器带此参数取完整套餐库（**FC 版同样实现该视图**） |

> 云端代抓是**带鉴权的受限代理**：不做定时抓取、不解析播放列表、不转发直播流；
> DNS rebinding 无法在边缘运行时先验解析，请只填可信订阅地址。编辑器在云端代抓失败时
> 回退浏览器直连（受 CORS 限制）。完整接口与安全约束见 [API.md](API.md)。
