# 配置服务接口说明（v1）

Base URL：默认部署为腾讯 EdgeOne Pages 项目域名（见 [DEPLOY_EDGEONE.md](DEPLOY_EDGEONE.md)）；
备选阿里云 FC 为 HTTP 触发器域名；本地 Python 版为 `http://127.0.0.1:8080`。

> **两个实现路径的关系（务必区分）**：EdgeOne（JavaScript Edge Functions）与 FC
> （Python WSGI / 本地 Python 版）共享**同一套配置契约**——`schemaVersion`、`sections`
> 六节结构、字段校验规则、`ETag` / `X-Revision` 头、`304` / `409` 语义、核心错误码一致，
> 终端 APK 只需更换 Base URL。但**不是所有接口两端都有**：EdgeOne 版额外提供
> `POST /api/iptv/fetch`、完整的 `GET/POST /api/devices` 设备管理、按 `deviceId` 的
> 设备维度隔离与在线判定、**全局资源库 `GET/PUT /api/library`**、编辑器令牌预填；FC 版
> （`cloud/app.py`）只有 `/health`、`/api/config`、`/api/config/catalog`、
> `/api/config/revisions`、`/api/config/rollback` 与静态编辑器，**没有** `/api/devices`、
> **没有** `/api/iptv/fetch`、**没有** `/api/library`，不登记设备、不返回
> `403 device_blocked`。逐项对照见文末「与 FC 版的差异（API 视角）」。两端的
> `GET /api/config` 轻量视图（套餐展开 + `withPackages=1` 剥离）则**都实现**。

除 `/health` 与静态编辑器外，所有 `/api/*` 请求需要 `Authorization: Bearer <read-token>`。
写入类接口（PUT、rollback、`PUT /api/library`、`POST /api/devices`、`POST /api/iptv/fetch`）
需要 `<write-token>`。

> **设备维度（仅 EdgeOne 实现）**：`/api/config`、`/api/config/revisions`、
> `/api/config/rollback` 都接受 `?deviceId=<id>`（或 `X-Device-Id` 头）。带上表示读写
> **该设备自己的完整文档**；不带表示读写**全局模板**（也是新设备的初始副本）。
> `deviceId` 只允许 `[A-Za-z0-9_-]{1,64}`，非法值 400。终端还会带 `appVersion` /
> `model`（或 `X-App-Version` / `X-Device-Model` 头）用于注册展示。
> 不带 `deviceId` 的旧版终端仍可正常工作，只是所有设备共用一份配置。
> **FC 版不支持设备维度**：没有设备注册，请求里的 `deviceId` 会被忽略，始终读写全局唯一一份文档。

## 接口总览

| 方法 | 路径 | 鉴权 | 实现 | 说明 |
|---|---|---|---|---|
| GET | `/health` | 无 | 两端 | 存活探测；EdgeOne 返回实际生效的存储后端（`edgeone-kv` / `edgeone-blob` / `none`），FC 返回 `CONFIG_STORAGE_BACKEND`；均带 `devMode` |
| GET | `/api/config` | read | 两端 | 全量配置（轻量视图）；`since=<rev>` 或 `If-None-Match` 命中返回 304；EdgeOne 带 `deviceId` 时自动登记上线 |
| PUT | `/api/config` | write | 两端 | 写入配置；需 `If-Match`，冲突返回 409；EdgeOne 校验 900 KB 文档上限 |
| GET | `/api/config/catalog` | read | 两端 | 站点/导航 id 目录（编辑器选项来源） |
| GET | `/api/config/revisions?limit=20` | read | 两端 | 历史快照列表（倒序；EdgeOne 按设备隔离） |
| POST | `/api/config/rollback` | write | 两端 | 回滚到指定快照，生成新 revision（EdgeOne 按设备隔离） |
| GET | `/api/library` | read | **仅 EdgeOne** | 全局资源库（IPTV 源/套餐 + TVBox 源/站点）；无库时返回空库 revision 0 |
| PUT | `/api/library` | write | **仅 EdgeOne** | 覆盖整库；需 `If-Match`，返回 `{revision, updatedAt, warnings, affectedDevices}` |
| GET | `/api/devices` | read | **仅 EdgeOne** | 设备注册表（在线/离线、别名、最近下发、拉黑列表、在线判定窗口） |
| POST | `/api/devices` | write | **仅 EdgeOne** | 8 种管理动作，支持单台 / 批量 |
| POST | `/api/iptv/fetch` | write | **仅 EdgeOne** | 云端代抓 M3U/M3U8/TXT 订阅（受限代理，一次最多 10 个地址） |
| GET | `/` | 无 | 两端 | 在线编辑器；EdgeOne 版为内联单页并注入连接默认值，FC 版另提供 `/app.js`、`/style.css` 且需手动填令牌 |

## GET /api/config

响应头：`ETag: "<revision>"`、`X-Revision`、`X-Schema-Version: 1`、
`Cache-Control: no-store`；FC 版在请求带 `Accept-Encoding: gzip` 时压缩响应体，
EdgeOne 版由平台 CDN 自动压缩（配置文档仅几 KB，无功能差异）。

```json
{
  "schemaVersion": 1,
  "revision": 42,
  "updatedAt": "2026-11-11T08:00:00+08:00",
  "sections": {
    "sites": {"managed": true, "policy": "whitelist", "enabledSiteIds": ["bilibili", "huya", "iptv"]},
    "navigation": {"managed": true, "railMenuIds": ["favorite", "hot", "areas", "iptv"],
                   "groups": [
                     {"id": "iptv", "label": "IPTV", "icon": "live_tv", "children": ["iptv"]},
                     {"id": "vod", "label": "影音", "icon": "movie", "children": ["moviePlayback"]},
                     {"id": "live", "label": "直播", "icon": "tv", "children": ["favorite", "hot", "areas", "favoriteAreas", "search", "history"]},
                     {"id": "settings", "label": "设置", "icon": "settings", "children": ["settings"]}
                   ],
                   "defaultGroupId": "iptv",
                   "sidebarExpanded": false, "homeKeepAlive": true,
                   "settings": {"managed": false, "enabledEntryPaths": []}},
    "startup": {"managed": true, "agreement": {"enabled": true, "requiredVersion": 2,
                 "titleI18n": {"zh": "用户协议"}, "bodyI18n": {}},
                 "notice": {"enabled": true, "mode": "once_per_revision", "dismissible": true,
                 "titleI18n": {}, "bodyI18n": {}},
                 "exitDialog": {"enabled": true, "mode": "always", "dismissible": true,
                 "showDonate": true, "titleI18n": {"zh": "确定退出？"}, "bodyI18n": {}},
                 "showSplashPage": true},
    "update": {"managed": true, "autoCheck": true, "checkIntervalHours": 24, "prompt": "dialog",
               "minSupportedVersion": "", "allowPrerelease": false, "allowUserOverride": true,
               "mirrorUrls": [], "changelogI18n": {}},
    "iptv": {"managed": true, "sources": [], "groups": ["央视频道"],
             "channels": [{"name": "CCTV-1", "group": "央视频道", "url": "http://.../1.m3u8", "logo": ""}],
             "epgUrl": "",
             "packages": [{"id": "pkg_cctv", "name": "央视+卫视",
                          "sources": ["https://.../list.m3u"], "channelCount": 2}],
             "selectedPackageIds": ["pkg_cctv"],
             "packageIds": ["pkg_1a2b3c4d"],
             "lockLibrary": false,
             "libraryRevision": 7},
    "vod": {"managed": true, "sourceIds": ["vs_1a2b3c4d"],
            "siteIds": ["vs_1a2b3c4d:csp_X"],
            "lockLibrary": false, "libraryRevision": 7}
  }
}
```

> **GET 返回的是「轻量视图」（两端一致）**：`selectedPackageIds` 非空时，服务端按该数组
> 顺序把选中套餐的 `channels` 合并、按 URL 小写去重、上限 3000 条写入顶层
> `iptv.channels`，并把 `iptv.groups` 重算成合并结果里出现的分组；`packages` 只保留
> `{id, name, sources, channelCount}`，不含完整频道列表。带 `?withPackages=1` 才返回
> 完整套餐库（编辑器编辑套餐时使用）。PUT 时选中套餐会把顶层 `channels` 置空，频道
> 只在 `packages` 里存一份，避免同一份频道存两遍撑大文档。
>
> **EdgeOne 版另有「引用全局资源库」路径**：设备只存 `iptv.packageIds`，
> 频道在库里存一份，GET 时按下面的四档优先级展开，`packages` 摘要同时包含
> 「设备内联套餐」与「被引用的库套餐」。客户端拿到的仍是同一个 `channels` 字段，
> 无需感知区别。上面的示例同时列了 `selectedPackageIds` 与 `packageIds` 以便对照，
> 实际一台设备通常只用其中一种。

`GET /api/config` 展开 `iptv.channels` 的四档优先级（仅 EdgeOne 有库；FC 版没有库，
恒走第 3 档）：

1. `iptv.lockLibrary === true`：设备已锁定，**完全忽略资源库**，只用设备内联的
   `packages` / `selectedPackageIds` / `channels`（即 PUT 时落下的自包含快照）；
2. 否则 `iptv.packageIds` 非空且库里存在对应套餐：按 `packageIds` 顺序合并库套餐的
   `channels`，URL 小写去重，上限 3000 条；
3. 否则回退旧逻辑：`selectedPackageIds` + 内联 `packages`；
4. 引用库时最后并入设备内联 `channels`（库频道优先去重），让设备能在库之外再挂自己的
   几个频道。

**懒触发追平（仅 EdgeOne）**：`GET /api/config?deviceId=X` 时，若该设备未锁定
（`iptv.lockLibrary` 不为 `true`）且确实引用了库（`packageIds` / `vod.sourceIds` /
`vod.siteIds` 任一非空），而 `iptv.libraryRevision` 与库当前 `revision` 不一致，服务端
先把这台设备的 `libraryRevision` 追平到库 revision（**只改 revision 标记**，不落盘展开
后的频道），**然后再做 304 判定**——顺序很关键：先追平再判 304，终端才不会因为
`since` 命中旧 revision 而漏掉新频道；如果反过来先判 304，库改了设备却永远拿不到更新。
追平写入**不写快照、不动 revisions 索引**，避免把 100 条人工编辑历史挤掉；写失败
（并发 409 / 存储抖动）会被吞掉，GET 不会因此失败。

`GET /api/config?since=42` 或 `If-None-Match: "42"` → `304 Not Modified`（空响应体，
仍带 ETag / X-Revision）。revision 由服务端维护，客户端只能读取；`iptv.libraryRevision`
与 `vod.libraryRevision` 同样由**服务端维护**（客户端提交的值会被接受，但追平逻辑以
服务端为准）。

**新设备首次拉取（仅 EdgeOne）**：服务端以当前全局模板深拷贝一份独立文档，revision 从
`max(1, 模板 revision+1)` 起，避免终端带 `since=0` 时被判成 304 而拿不到首包。
此后改全局模板**不会**影响这台设备。响应头会带回 `X-Device-Id`。
FC 版没有设备维度，不存在此流程。

## PUT /api/config

请求体必须包含 `sections` 对象；`If-Match` 必填（也接受请求体里的 `expectedRevision`）。

```bash
curl -X PUT "$BASE/api/config" \
  -H "Authorization: Bearer $WRITE_TOKEN" \
  -H "Content-Type: application/json" \
  -H 'If-Match: "42"' \
  -d '{"sections":{"sites":{"managed":true,"enabledSiteIds":["bilibili","huya","iptv"]}}}'
```

成功 `200`：

```json
{"revision":43,"updatedAt":"...","warnings":[]}
```

`409`：版本冲突，响应带 `currentRevision` 与完整 `document`，编辑器可据此提示
「载入云端最新版」后再编辑，避免覆盖他人改动。

`400 invalid_config`：字段类型/枚举错误或缺少 If-Match；服务端不会写入任何数据。
`warnings` 用于提示被过滤的未知 id、空列表回退、force 策略风险等。

字段校验规则见 `cloud/schema.py` 与 `edge-functions/_lib/contract.js`（两端逐条对齐）、
需求文档 4.3 / 4.4 与附录 F。未知节被忽略，未提供字段沿用内置 seed 值。

**配置契约新增字段（两端一致）**：

- `navigation.groups`：最多 8 个一级块，块 id 白名单 `iptv` / `vod` / `live` /
  `settings`，每项 `{id, label, icon, children}`；`children` 必须是 `catalog.menus`
  的 id 或字面量 `settings`（**原始大小写精确匹配**），未知记 warning 并忽略、去重、
  最多 30 项；`label` ≤ 32、`icon` ≤ 64。非法或重复块记 warning 并忽略该项；
  全部非法则回退 seed 默认 4 组。
- `navigation.defaultGroupId`：默认 `iptv`，必须是 `groups` 里存在的 id，否则记
  warning 并保持原值（seed 值）。
- `startup.exitDialog`：`{enabled, mode, dismissible, showDonate, titleI18n, bodyI18n}`，
  `mode` 取 `always` / `once_per_revision` / `never`；`enabled=false` 表示不接管，
  终端沿用本地原弹窗，保证升级平滑。
- `iptv.packages` / `iptv.selectedPackageIds`：见下方「IPTV 节」。
- `iptv.packageIds`（string[]，≤ 12、去重）：设备引用的**全局资源库**套餐 id
  （见「全局资源库」）。格式非法记 warning 并丢弃（类型错误 400）。与
  `selectedPackageIds` 的区别：后者指向设备内联 `packages`，用于旧编辑器与锁定快照；
  两者可以并存，展开时 `packageIds` 优先。
- `iptv.lockLibrary`（bool，默认 `false`）：锁定开关。`true` 表示这台设备冻结在当前
  内容，忽略资源库后续变化。
- `iptv.libraryRevision`（int ≥ 0，默认 0）：设备文档已追平到库的哪个 revision，
  **由服务端维护**（懒触发时 bump），客户端不要自行加一或伪造。
- `vod`：TVBox 源/站点节，`{managed:false, sourceIds:[], siteIds:[], sources:[],
  sites:[], lockLibrary:false, libraryRevision:0}`。`sourceIds` ≤ 20，元素形如
  `vs_1a2b3c4d`；`siteIds` ≤ 500，元素形如 `vs_1a2b3c4d:csp_X`
  （`^[A-Za-z0-9_:-]{1,96}$`）。设备只存引用，站点清单在库里存一份。
  老文档没有这一节时读出来自动补默认值。
  - `sources` / `sites` 是**展开产物**：GET `/api/config` 时由服务端按当前库实时写入，
    编辑器保存时会清掉未锁定设备的这两个字段（写了也等于把库的快照固化成人工配置）。
  - `vod.lockLibrary === true` 时相反：服务端完全不读库，只用这两个字段充当
    **锁定快照**，PUT 时若为空会先按库展开一次再落地。

**IPTV 节（两端一致）**：`channels` 每项为 `{name, url, group?, logo?}`；服务端按
URL 小写去重，只接受 `http(s)/rtmp(s)/rtsp/udp/mms/p2p` 协议，最多 3000 条。
`packages` 最多 12 个，每项 `{id, name, sources, channels}`：`id` 只允许
`[A-Za-z0-9_-]{1,64}`，非法或重复 id 记 warning 并忽略；`sources` 仅保留 http(s)、
最多 20 个；`channels` 与顶层共用同一套校验（每包最多 3000 条）。**所有套餐频道数
之和**硬上限 5000，超出按剩余额度截断并记 warning。`selectedPackageIds` 最多 12 个，
只能指向已存在的套餐 id（未知静默忽略并记 warning）、去重；非空时顶层 `channels`
在 PUT 后被置空，由 GET 动态展开（见上文轻量视图）。
单份配置文档 `sections` 目标上限 900 KB：EdgeOne 的 PUT 会实际校验并在超限时返回
`400 invalid_config`，FC 版目前不校验。请求体上限：EdgeOne 2 MiB、FC 1 MiB。

**锁定快照（仅 EdgeOne）**：PUT 时若 `iptv.lockLibrary === true` 且 `iptv.channels`
为空、`iptv.packageIds` 非空，服务端会用当前资源库**展开一次**，把频道写入
`channels` / `groups` 并回填 `libraryRevision`（`vod.libraryRevision` 同步回填）。
`vod` 同样处理：`vod.lockLibrary === true` 且 `vod.sites` 为空、`vod.sourceIds` 非空时，
用 `expandVodSites` 展开一次写进 `sources` / `sites`。
这样锁定设备是**自包含**的：离线也能播，库以后怎么改都不影响它。已经带了非空
`channels`（或非空 `sites`）的请求不会被改写（尊重人工填写的内容）。

**订阅导入分工**：编辑器负责解析 M3U / M3U Plus / TXT genre，云端**只保存解析结果**、
不定时抓取、不转发直播流。但 EdgeOne 新增 `POST /api/iptv/fetch` 作为**受限云端代理**，
替编辑器绕过浏览器 CORS 取回订阅文本；FC 版没有该接口，编辑器在云端代抓失败时会
**回退浏览器直连**（仍受 CORS 限制，失败时提示改用本地文件或粘贴文本）。

**字段语义补充**：`update.mirrorUrls` 是**完整的 `version.json` URL 列表**（不是镜像域名前缀），
终端 `VersionUtil._versionUrls` 会直接把它当作下载地址；留空则沿用内置
GitHub 镜像。`navigation.settings` 是 P1 预留节，P0 终端不读取。

## 全局资源库（GET/PUT /api/library，仅 EdgeOne）

> FC 版（`cloud/app.py`）**没有**这两个接口，请求返回 `404 not_supported`。原因：FC 是
> 「单份全局文档」模型，既没有 per-device 文档，也没有独立的 `library_current` 键位，
> 懒触发追平无处落地。编辑器连 FC 时会按「服务端未升级」降级（资源库页签提示先升级
> 云端），配置下发不受影响。FC 的 `sections` 仍完整支持新字段（`vod` 节、
> `packageIds` / `lockLibrary` / `libraryRevision`），只是引用不会被展开。

资源库与设备文档**解耦**：源、套餐、TVBox 站点在库里存一份，设备只存 id 引用。
这样「一台设备都没连」时也能先把源和套餐建好，之后新建设备勾选即可。

存储键 `library_current`（KV 或 Blob，与配置文档同一后端），模型：

```json
{
  "schemaVersion": 1,
  "revision": 7,
  "updatedAt": "2026-11-12T21:00:00+08:00",
  "iptv": {
    "sources": [{"id": "s_1a2b3c4d", "name": "央视源",
                 "url": "https://.../list.m3u", "type": "m3u",
                 "channelCount": 128, "addedAt": "2026-11-10T09:00:00+08:00", "note": ""}],
    "packages": [{"id": "pkg_1a2b3c4d", "name": "央视+卫视",
                  "sources": ["s_1a2b3c4d"],
                  "channels": [{"name": "CCTV-1", "url": "http://.../1.m3u8",
                                "group": "央视", "logo": ""}]}],
    "epgUrl": ""
  },
  "vod": {
    "sources": [{"id": "vs_1a2b3c4d", "name": "某 TVBox 配置",
                 "url": "https://.../tvbox.json",
                 "jar": "https://.../spider.jar",
                 "spiderMd5": "3d161697458ecbcd2651a749db761ba1",
                 "spiderFlavor": "fongmi",
                 "siteCount": 2,
                 "addedAt": "2026-11-10T09:00:00+08:00", "note": ""}],
    "sites": [{"id": "vs_1a2b3c4d:csp_X", "sourceId": "vs_1a2b3c4d", "key": "csp_X",
               "name": "测试站点", "api": "csp_X", "ext": "token-abc", "type": 3,
               "searchable": 1, "quickSearch": 0, "note": ""}]
  }
}
```

### id 规则

| 对象 | 格式 | 说明 |
|---|---|---|
| IPTV 源 | `s_` + 8 位十六进制 | 编辑器缺省时由服务端补发 |
| IPTV 套餐 | `pkg_` + 8 位十六进制 | 同上 |
| TVBox 源 | `vs_` + 8 位十六进制 | 同上 |
| TVBox 站点 | `${sourceId}:${key}`，须匹配 `^[A-Za-z0-9_:-]{1,96}$` | 由 `sourceId` + 站点 key 派生；传入的 id 合法且属于同一源时沿用 |

id 是引用目标，格式错了会静默失效，因此**非法 id 直接 400**（内容问题才走 warnings）。

### TVBox spider 字段约定

TVBox 配置顶层的 `spider` 常见写法是 `"./fty.jar;md5;<hash>"`（FongMi 用
`BaseLoader.parseJar(spider, true)` 按 `url;md5;hash` 拆分并校验）。编辑器导入时负责：

- 剥离配置里整行 `//` 注释后再 `JSON.parse`；
- 把 `spider` 拆成 `jar`（绝对 http(s) 地址）与 `spiderMd5`；
- 把 `./xxx`、`/xxx` 形式的 `jar` / `ext` / `api` / 子仓 `urls` 按**该配置自己的地址**解析成绝对 URL（中文路径自动 percent-encode）；
- 多仓 `urls` 同时兼容字符串与 `{url, name}` 对象。

服务端 `parseSpiderField()` 会再做一次防御性兼容，老数据或手工填写带后缀的
`jar` 不会被判非法清空。

| 字段 | 说明 |
|---|---|
| `vod.sources[].jar` | 爬虫包绝对地址；`csp_` 站点缺它完全无法运行 |
| `vod.sources[].spiderMd5` | 配置附带的 md5 校验和，可为空；宿主下载 jar 后应比对 |
| `vod.sources[].spiderFlavor` | `fongmi`（默认）或 `tvboxos`。两套 Spider 基类互不兼容，**不能混用宿主**；未知值回退 `fongmi` |
| `vod.sites[].ext` | 透传给 spider 的扩展参数；绝对地址原样保留，`./` 开头按源配置地址解析 |

设备 `vod.sources` / `vod.sites` 的内联快照与 `expandVodSites()` 展开产物都带
`spiderMd5` / `spiderFlavor`，锁定快照也一样，终端不需要再访问资源库。

### 上限

| 项 | 上限 | 超限行为 |
|---|---|---|
| `iptv.sources` | 30 | warning + 截断 |
| `iptv.packages` | 12 | warning + 截断 |
| 所有套餐频道数之和 | 5000 | warning + 按剩余额度截断 |
| 单个套餐展开后的频道 | 3000 | 展开时截断 |
| `vod.sources` | 20 | warning + 截断 |
| `vod.sites` | 500 | warning + 截断 |
| 单个源下站点 | 200 | warning + 跳过 |
| 整库 JSON | 900 KB | **400**（提示精简频道或拆套餐） |

### GET /api/library

读令牌。库未写过时返回**空库**（`revision: 0`、`updatedAt: ""`、`iptv/vod` 均为空数组），
而不是 404，编辑器据此可直接进入编辑态。

```bash
curl "$BASE/api/library" -H "Authorization: Bearer $READ_TOKEN"
```

### PUT /api/library

写令牌 + `If-Match: "<revision>"`（或请求体 `expectedRevision`）。缺版本号返回 400，
版本不匹配返回 409（响应带 `currentRevision` 与当前库文档）。

请求体只传 `{iptv, vod}` 即可，`schemaVersion` / `revision` / `updatedAt` 由服务端维护：

```bash
curl -X PUT "$BASE/api/library" \
  -H "Authorization: Bearer $WRITE_TOKEN" \
  -H "Content-Type: application/json" \
  -H 'If-Match: "7"' \
  -d '{"iptv":{"sources":[...],"packages":[...],"epgUrl":""},
       "vod":{"sources":[...],"sites":[...]}}'
```

成功 `200`：

```json
{"revision": 8, "updatedAt": "2026-11-12T21:05:00+08:00",
 "warnings": [], "affectedDevices": 3}
```

`affectedDevices` 语义：**本次保存前后所有可能受影响的设备台数**——库里的旧 id 与新 id
都算（被删掉的套餐/站点同样会让引用它的设备下一跳内容变化），统计时**排除已锁定**
（`iptv.lockLibrary` / `vod.lockLibrary` 为 `true`）以及没有引用这些 id 的设备。它只读
不写：写库**不会**修改任何设备文档，真正生效发生在设备下次 `GET /api/config`
（见上文「懒触发追平」）。这个数字用于编辑器提示「预计影响 N 台终端」，不是立即生效
的保证——离线设备要等下次上线才会追平。

库**不保留快照历史**：它只是共享字典，设备文档里才是真正下发的配置；回滚请针对设备
文档操作。删除库里的套餐/站点不会级联清理设备上的 id 引用，设备下次展开时取不到内容，
表现为该部分频道/站点消失（这也是为什么改库前先看 `affectedDevices`）。

## GET /api/config/revisions 与 POST /api/config/rollback

```json
{"revisions":[{"revision":43,"updatedAt":"...","size":1273},{"revision":42,"...":0}]}
```

```bash
curl -X POST "$BASE/api/config/rollback" \
  -H "Authorization: Bearer $WRITE_TOKEN" -H "Content-Type: application/json" \
  -d '{"revision":42}'
```

回滚把旧快照的 `sections` 写为**新的 revision**（不会回退版本号），返回
`{"revision":44,"updatedAt":"...","rolledBackFrom":42}`。快照不存在返回 400。

## GET /api/devices 与 POST /api/devices（仅 EdgeOne）

> FC 版（`cloud/app.py`）**没有**这一对接口，请求返回 `404 not_found`。设备维度隔离、
> 在线判定、拉黑与 `403 device_blocked` 都是 EdgeOne 侧能力。

`GET`（读令牌）返回注册表（按最近上线倒序，上限 200 台）：

```json
{
  "devices": [
    {"id":"3f8c...","alias":"客厅电视","comment":"","firstSeen":"...","lastSeen":"...",
     "lastSeenAgo":120,"online":true,"status":"online","hidden":false,"blocked":false,
     "appVersion":"3.0.14","model":"","revision":5,"editedAt":"...",
     "pushedAt":"...","pushedRevision":5}
  ],
  "total":1, "online":1, "blocked":[], "onlineWindowMinutes":30
}
```

`blocked` 是**被拉黑的设备 id 数组**（不是数量）。在线判定：客户端 v3.0.14 起前台每
15 分钟同步一次配置，每次成功 `GET /api/config` 刷新 `lastSeen`；云端以 `lastSeen`
距今是否超过 `CONFIG_ONLINE_WINDOW_MINUTES`（默认 30 分钟）兜底，输出
`status: "online" | "offline"` 与秒数 `lastSeenAgo`。

`POST`（**写令牌**）用 `action` 区分 **8 种**动作，支持单台 `deviceId` 或批量
`deviceIds`（去重，一次最多 50 台）：

| action | 语义 |
|---|---|
| `rename` | 改别名（`alias`） |
| `comment` | 改备注（`comment`） |
| `delete` | **软删除**：仅隐藏注册项（`hidden=true`），配置与快照保留，可 `restore` |
| `restore` | 恢复显示 |
| `purge` | **彻底删除 + 拉黑**：该设备再请求 `/api/config` 返回 `403 device_blocked` |
| `unblock` | 解除拉黑，允许重新登记 |
| `reset` | 把该设备配置重置为当前全局模板，生成该设备新 revision |
| `push` | **配置下发**：即使内容没改也生成新 revision 并记录 `pushedAt` / `pushedRevision`，触发终端下次心跳取新配置 |

```bash
# 批量显式下发（编辑器「配置下发」按钮：先保存，再 push）
curl -X POST "$BASE/api/devices" -H "Authorization: Bearer $WRITE_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"action":"push","deviceIds":["3f8c...","a1b2..."]}'
```

响应统一为：

```json
{"action":"push","total":2,"failed":0,
 "results":[{"deviceId":"3f8c...","ok":true,"revision":6,"pushedAt":"...","note":"..."},
            {"deviceId":"a1b2...","ok":true,"revision":6,"pushedAt":"...","note":"..."}]}
```

**单台失败不影响其它台**：`results` 每台带 `ok`，失败时附 `error`；顶层 `failed`
为失败台数。缺少 `deviceId` / `deviceIds`、动作非法、一次超过 50 台返回
`400 invalid_config`。设备已被拉黑时 `push` 会失败并提示先 `unblock`。

## POST /api/iptv/fetch（仅 EdgeOne）

> FC 版没有该接口（`404 not_found`）；编辑器在该接口不可用时会回退浏览器直连，
> 仍受 CORS 限制。

绕过浏览器 CORS，由 Edge Function 出公网取回订阅文本。**写令牌**必填（导入属编辑动作，
避免被当成开放代理滥用）。这是「带鉴权的受限代理」：不做定时抓取、不解析播放列表、
不转发直播流；解析仍在编辑器 `parsePlaylist` 完成。

请求：`{"url":"https://.../list.m3u"}` 或
`{"urls":["https://.../a.m3u","https://.../b.txt"]}`，一次最多 10 个地址。

响应：

```json
{"results":[{"url":"https://.../a.m3u","finalUrl":"https://.../a.m3u","ok":true,
             "bytes":12345,"encoding":"utf-8","truncated":false},
            {"url":"http://127.0.0.1/x","ok":false,"error":"禁止访问内网 / 环回地址"}],
 "text":"#EXTM3U ...", "total":2, "succeeded":1}
```

`text` 是所有成功源按请求顺序以 `\n` 拼接后的文本；`results` 不含 `text`。
`encoding` 为 `utf-8`（默认）或 `gbk`（UTF-8 解码出现替换字符时自动尝试 GBK）；
`truncated` 表示单源触发 2 MiB 截断；失败项附 `error`。

安全约束（逐跳复核，防 SSRF）：

- 仅公网 `http(s)`；拒绝环回 / 私网 / 链路本地 / 保留段 / CGNAT / 基准测试段 /
  IPv6 本地地址、带账号密码的 URL、无点号的短主机名；
- 危险端口拒绝：21 / 22 / 23 / 25 / 110 / 143 / 445 / 3306 / 3389 / 5432 /
  6379 / 9200 / 11211 / 2375 / 27017；
- 重定向**手动**跟随最多 3 跳，且**每一跳**重新复核上述规则；
- 单源 2 MiB 上限、10s 超时。

> **DNS rebinding 无法在边缘运行时先验解析**，因此请只填写可信订阅地址；
> 不要把这个接口当作通用代理开放给不可信输入。

## /health 响应

```json
// 正常
{"status":"ok","revision":3,"backend":"edgeone-blob","devMode":false}

// 存储不可用：HTTP 仍是 200，便于监控区分「进程死了」和「配置没做完」
{"status":"degraded","revision":null,"backend":"none","devMode":false,
 "storageError":"..."}
```

`backend` 取值：`edgeone-kv`（已绑定 KV）、`edgeone-blob`（KV 未绑定时自动兜底）、
`none`（都没有，此时 `/api/*` 返回 503 `storage_unavailable`）。

> **FC 版 `/health`**：始终返回 `{"status":"ok","revision":N,"backend":"file","devMode":...}`，
> `backend` 取自 `CONFIG_STORAGE_BACKEND`（默认 `file`）；没有 `degraded` / `none` /
> `storage_unavailable` 这些 EdgeOne 存储层状态。

## 错误码

| 状态 | code | 含义 |
|---|---|---|
| 400 | `invalid_config` | 请求体/字段不合法、缺少 If-Match、快照不存在、设备动作非法 |
| 401 | `unauthorized` | Token 缺失或无效 |
| 403 | `device_blocked` | **仅 EdgeOne**：设备被 `purge` 拉黑后请求 `/api/config` 被拒 |
| 404 | `not_found` / `not_supported` | 未知接口或静态资源；FC 版请求 `/api/devices`、`/api/iptv/fetch`、`/api/library` 也返回此码（`/api/library` 带 `not_supported` 说明） |
| 405 | `method_not_allowed` | 方法不支持 |
| 409 | `revision_conflict` | 乐观锁冲突 |
| 413 | `payload_too_large` | 请求体超限：EdgeOne 2 MiB、FC 1 MiB |
| 500 | `internal_error` | 服务端异常（不向客户端泄露栈） |
| 503 | `storage_unavailable` | **仅 EdgeOne**：KV 未绑定且 Blob SDK 不可用 |

## 与 FC 版的差异（API 视角）

以下为读取 `cloud/app.py` 与 `edge-functions/` 源码核对后的实际支持情况：

| 能力 | EdgeOne | FC / 本地 Python |
|---|---|---|
| 配置契约（六节、`seed`、`normalize_sections`） | 一致 | 一致（`cloud/schema.py`） |
| `GET /api/config` 轻量视图（套餐展开 + `withPackages=1` 剥离） | 有 | 有（`app.py` 调 `expand_iptv_channels`） |
| `vod` 节、`iptv.packageIds` / `lockLibrary` / `libraryRevision` 字段校验 | 有 | 有（结构兼容，老文档自动补默认值） |
| `GET/PUT /api/library` 全局资源库 | 有 | **无此接口**（404 `not_supported`） |
| `packageIds` / `vod.sourceIds` 展开、懒触发追平、锁定快照 | 有 | **无**（没有库可展开；PUT 时给 warning 提示） |
| `GET/PUT /api/config`、`catalog`、`revisions`、`rollback`、`/health` | 有 | 有 |
| `ETag` / `X-Revision` / `X-Schema-Version` / 304 / 409 | 有 | 有 |
| 读写令牌、CORS、`invalid_config` / 401 / 404 / 405 / 409 / 413 / 500 | 有 | 有 |
| 请求体上限 | 2 MiB | **1 MiB** |
| PUT 校验 900 KB 文档上限 | 有 | **无** |
| 应用内 gzip | 由平台 CDN 自动 | 有 |
| 编辑器连接信息预填 / 自动连接 | 有 | **无**（需手动填） |
| `deviceId` 设备维度隔离、设备登记 | 有 | **无**（始终读写全局唯一文档） |
| `GET/POST /api/devices`（8 动作、批量、在线离线） | 有 | **无此接口**（404） |
| `POST /api/iptv/fetch` 云端代抓 | 有 | **无此接口**（404） |
| `403 device_blocked` / `503 storage_unavailable` | 有 | 无 |
| `/health` 存储后端探测 / `degraded` | 有 | 无（固定 `ok`、`backend=file`） |

结论：**核心配置契约一致，EdgeOne 版额外提供 `/api/iptv/fetch`、完整设备管理与
全局资源库**；依赖设备维度、在线状态、云端代抓或资源库的功能只在 EdgeOne 部署形态下
可用，切回 FC 时这些能力不可用，但 `sections` 结构与终端配置读取逻辑不变。FC 上
`packageIds` / `vod.sourceIds` 这类库引用不会被展开（终端拿到空内容），跨形态迁移时
请先把引用展开成内联频道，或改回 `selectedPackageIds`。
