# 阿里云函数计算 FC 3.0 部署教程 · pu_tv_cloud 配置下发服务

日期：2026-11-11 | 配套构建包：`pu_tv_cloud_fc_v1.0.0.zip`（25.6 KB / 14 个文件，零第三方依赖）
适用仓库：`github.com/muzhi621/pu_tv_cloud`

> 这个服务**只下发配置 JSON，不转发任何直播流、不抓取 M3U 订阅、不代理弹幕**。
> 单次请求 gzip 后 1–3 KB，命中 304 只有几十字节，因此流量成本接近 0。
> 构建包已从 zip 解压实测：**23 个单元测试通过，10 项接口冒烟全部符合预期**。

---

## 一、先选存储方案（决定后面所有步骤）

FC 是**无状态**的：函数实例随时可能被回收，写在本地磁盘的配置会丢。所以「能不能持久化」是第一个要定的事。

| 方案 | 第三方依赖 | 配置持久化 | 成本 | 适用 |
|---|---|---|---|---|
| **① file 裸跑** | 零 | ❌ 重启回 seed | 0 | 只用来验证接口和编辑器 |
| **② OSS + oss2（推荐）** | 需在 FC 上装 `oss2` | ✅ | 极低（几毛钱/月量级） | 生产使用 |
| **③ NAS 挂载 + file** | 零 | ✅ | 中等（NAS 按量计费） | 不想在 FC 上装依赖 |

本教程先走 ① 快速验证，再讲 ② 切生产；③ 作为备选放在第五节。

---

## 二、方案 ①：控制台 5 分钟验证部署

### 2.1 创建函数

进入阿里云控制台 → **函数计算 FC 3.0** → 选一个地域（后面 OSS 要用同一地域）→ 创建函数。
不同版本控制台措辞略有差异，按下面这些值填：

| 配置项 | 值 |
|---|---|
| 创建方式 | 使用内置运行时 / 从零创建 |
| 函数类型 | 事件函数 + **HTTP 触发器**（或选「HTTP 函数」） |
| 运行时 | **Python 3.10**（3.12 也可），架构 **x86_64** |
| 代码上传方式 | **上传 ZIP 包** → `pu_tv_cloud_fc_v1.0.0.zip` |
| 请求处理程序 | **`index.handler`** |
| 实例规格 | 0.25 vCPU / 512 MB 或个人用最小规格即可 |
| 执行超时 | 10 秒 |
| **最小实例数** | **0**（设为 ≥1 会常驻计费） |
| **单实例并发上限** | **1**（revision 乐观锁在单写入者下最稳） |

> ⚠️ 上传的 zip **根目录必须直接是** `index.py`、`cloud/`、`config/`、`editor/`。
> 如果解压后多套了一层目录（例如 `pu_tv_cloud_fc/index.py`），FC 会找不到 `index.handler`。

### 2.2 配置环境变量

| 变量 | 验证阶段的值 | 说明 |
|---|---|---|
| `CONFIG_READ_TOKEN` | 自定义一个随机串，如 `pl-read-xxxx` | TV 端只读令牌 |
| `CONFIG_WRITE_TOKEN` | 另一个随机串，如 `pl-write-xxxx` | 编辑器写入令牌 |
| `CONFIG_STORAGE_BACKEND` | `file` | 默认值，可不填 |
| `CONFIG_DATA_DIR` | `/tmp/pure_live_tv` | 临时目录，重启即丢 |
| `CONFIG_CORS_ORIGINS` | 留空 | 编辑器同源部署时不需要 |

**两个 Token 都留空 = 开发模式，接口完全不鉴权**，只允许本机/内网调试，公网部署务必设置。

### 2.3 创建 HTTP 触发器

- 认证方式：**无需认证**（鉴权由应用自己的 Bearer 完成）。若开启平台自带 Bearer/JWT，则请求要同时满足两层鉴权。
- 请求方法：勾上 `GET / POST / PUT / OPTIONS`（回滚是 POST，PUT 用于保存配置）。
- 记下生成的公网访问域名，下文用 `https://<fc-domain>` 代替。

### 2.4 验证（把变量换成你自己的值）

```bash
BASE=https://<fc-domain>
READ=pl-read-xxxx
WRITE=pl-write-xxxx

# 存活探测（无需鉴权），devMode 必须是 false
curl -s $BASE/health
# {"status":"ok","revision":0,"backend":"file","devMode":false}

# 不带令牌应被拒绝
curl -s -o /dev/null -w "%{http_code}\n" $BASE/api/config          # 401

# 读配置（seed，revision 0）
curl -s -H "Authorization: Bearer $READ" $BASE/api/config

# 站点与导航目录（编辑器用）
curl -s -H "Authorization: Bearer $READ" $BASE/api/config/catalog

# ETag / 304
curl -s -i -H "Authorization: Bearer $READ" -H 'If-None-Match: "0"' $BASE/api/config | head -8

# 写入一次（revision 0 → 1），关闭斗鱼只留 B 站 / 虎牙 / IPTV
curl -s -X PUT -H "Authorization: Bearer $WRITE" -H "If-Match: 0" \
  -H 'Content-Type: application/json' \
  -d '{"sections":{"sites":{"managed":true,"enabledSiteIds":["bilibili","huya","iptv"]}}}' \
  $BASE/api/config

# 用旧 revision 再写一次应返回 409 且带 currentRevision
curl -s -o /dev/null -w "%{http_code}\n" -X PUT \
  -H "Authorization: Bearer $WRITE" -H "If-Match: 0" \
  -d '{"sections":{}}' $BASE/api/config                          # 409
```

### 2.5 打开在线编辑器

浏览器访问 `https://<fc-domain>/`（`GET /` 直接返回 `editor/index.html`），在页面顶部填：

- **API 地址**：`https://<fc-domain>`（**只填域名，不要带 `/api/config`**，编辑器会自己拼路径）
- **访问令牌**：填 `CONFIG_WRITE_TOKEN`（要保存配置就必须写令牌；只读查看可用 read token）

四个视图分别控制：平台勾选（关掉斗鱼就不显示其菜单）、导航排序、启动弹窗文案、更新策略。保存时自动带 `If-Match`，遇到 409 会提示载入云端最新版。

> 浏览器把地址与令牌存在 localStorage，共用电脑记得清理。

---

## 三、方案 ②：切到 OSS 持久化（生产使用）

### 3.1 创建 Bucket

- 与函数**同地域**建一个**私有** Bucket，例如 `purelive-config`。
- 配置统一放在前缀 `pure_live_tv/` 下：`current.json` 存当前版本，`history/000000NN.json` 存不可变快照。
- 建议开启 Bucket 版本控制，或定期把 `current.json` 另存一份。
- 首次读取发现 `current.json` 不存在时，服务会自动写入内置 seed（revision 0）。

### 3.2 RAM 授权（**重要：当前代码只支持 AK/SK**）

`cloud/storage.py` 的 `OSSStorage` 用 `oss2.Auth(OSS_ACCESS_KEY_ID, OSS_ACCESS_KEY_SECRET)`，
**不支持函数角色 / 临时凭证**。所以请用 RAM **子账号** 的 AK，配最小权限策略，不要用主账号 AK：

```json
{
  "Version": "1",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["oss:GetObject", "oss:PutObject", "oss:ListObjects"],
      "Resource": [
        "acs:oss:*:*:purelive-config",
        "acs:oss:*:*:purelive-config/pure_live_tv/*"
      ]
    }
  ]
}
```

把 `purelive-config` 换成你自己的 Bucket 名。`ListObjects` 需要 Bucket 级 Resource，否则历史列表会 403。
AK/SK 只放在 FC 环境变量里（可配合 KMS 加密配置），定期轮换，不要写进代码或 zip。

> 如果一定要免 AK，请走第五节的 NAS 方案（零凭据），或自行扩展 `OSSStorage` 读取 FC 注入的
> `ALIBABA_CLOUD_CREDENTIALS_URI` 临时凭证 —— 当前构建包尚未实现这条路径。

### 3.3 在 FC 上安装 `oss2` 依赖

构建包本身零依赖，OSS 后端需要 `oss2`。**推荐在 FC 的 Linux 环境里安装**（避免 Windows/macOS 轮子不兼容）：

1. 函数详情 → 「代码」页 → 打开 **WebIDE** → 打开终端。
2. 执行：
   ```bash
   pip3 install -r requirements.txt -t .
   ```
   这会把 `oss2` 及其依赖装进代码目录，与 Python 版本、Linux 架构完全匹配。
3. 保存并 **发布新版本 / 重新部署代码**，让依赖生效。

替代做法（层 / Layer）：在有 Linux 或 Docker 的机器上执行
`pip install -r requirements.txt -t python`，把 `python/` 目录打成 zip 上传为**自定义层**，
再把 `PYTHONPATH=/opt/python` 加到函数环境变量。适合多函数复用依赖。

> 验证：`/health` 返回 `backend:"oss"` 且不再报「OSS 后端需要 oss2」。
> 若接口 500 且日志出现 `ImportError: oss2`，说明这一步没做或没发布新版本。

### 3.4 切换环境变量

| 变量 | 值 |
|---|---|
| `CONFIG_STORAGE_BACKEND` | `oss` |
| `OSS_ENDPOINT` | 例如 `oss-cn-hangzhou.aliyuncs.com`（同地域可用内网 endpoint） |
| `OSS_BUCKET` | `purelive-config` |
| `OSS_PREFIX` | `pure_live_tv/` |
| `OSS_ACCESS_KEY_ID` | RAM 子账号 AK |
| `OSS_ACCESS_KEY_SECRET` | RAM 子账号 SK |
| `CONFIG_READ_TOKEN` / `CONFIG_WRITE_TOKEN` | 沿用验证阶段的值 |

### 3.5 验证持久化

```bash
curl -s $BASE/health     # backend 应为 "oss"
```

1. 在编辑器里关掉斗鱼并保存 → 返回新 revision，OSS 上出现 `pure_live_tv/history/00000001.json`。
2. 等函数实例冷启动（或手动「发布版本」触发新实例）后再 `GET /api/config`，
   **revision 与配置仍然是最新的**，说明持久化成功。
3. `GET /api/config/revisions` 应列出历史快照；编辑器的「历史 / 回滚」可回到任意快照
   （`revision 0` 是内置 seed，没有快照文件，回滚到 0 会返回 400，属预期行为）。

---

## 四、终端（TV 端）接入

终端库 `muzhi621/pu_tv_client` 的 `RemoteConfigService` 在**启动迁移之后、`runApp` 之前**拉取一次配置，
请求 `GET <基地址>/api/config?since=<本地revision>`，带 `Authorization: Bearer <read token>`；
304 / 超时 / 解析失败一律静默降级到本地缓存，**云端不可用不会导致看不了电视**。

**方式 A：编译期注入（推荐，适合自己发版）**

```bash
flutter build apk --release --flavor impeller --split-per-abi \
  --target-platform android-arm,android-arm64,android-x86_64 \
  --dart-define=PURE_LIVE_CONFIG_URL=https://<fc-domain> \
  --dart-define=PURE_LIVE_CONFIG_TOKEN=pl-read-xxxx
```

**方式 B：运行时写入 Hive 键**（键名 `remoteConfigEndpoint` / `remoteConfigToken`，会覆盖编译期值）。
当前 P0 **没有提供设置 UI**，需要通过已有的 8888 遥控 API 或调试手段写入；这是 P1 待办。

注意 TV 端只需要**只读令牌**；写令牌只给编辑器，不要打包进 APK。

配置四节（`sites` / `navigation` / `startup` / `update`）每节都带 `managed`：
未接管时完全不动用户本地设置。云端关掉 `douyu` 后，冷启动即不再显示斗鱼页签，但收藏/历史里的斗鱼房间仍保留。

---

## 五、方案 ③：NAS 挂载（零第三方依赖，备选）

如果不想在 FC 上装 `oss2`，可以用 NAS 让 file 后端持久化：

1. 开通 **文件存储 NAS**，创建文件系统与挂载点（与函数同 VPC / 同地域）。
2. 函数配置 → 「存储」→ 挂载 NAS 到本地目录，例如 `/mnt/nas`。
3. 环境变量：`CONFIG_STORAGE_BACKEND=file`、`CONFIG_DATA_DIR=/mnt/nas/pure_live_tv`。
4. 其余步骤同方案 ①。

代价：NAS 按容量/吞吐计费，成本高于 OSS；个人低频场景不如方案 ② 划算。

---

## 六、方案 B 型运行时（Web 函数 / 自定义运行时）

如果控制台提供的是「Web 函数」而不是内置 HTTP 函数，把启动命令设为：

```bash
python3 -m cloud.server
```

服务监听 `FC_SERVER_PORT`（默认 9000，也可用 `PORT` 覆盖），绑定 `0.0.0.0`。
这种方式用 `cloud/server.py` 起一个 ThreadingWSGIServer，功能与 `index.handler` 完全一致，
适合自定义容器镜像、想把编辑器一起塞进镜像的场景。环境变量与前面相同。

---

## 七、成本与坑（务必确认）

| 项 | 说明 |
|---|---|
| 最小实例数 | **必须 0**。设为 ≥1 会常驻计费（浅休眠仍收内存费） |
| 公网出流量 | 走 CDT 单独计费。**不要让 FC 定时抓 M3U 订阅或转发直播流**，否则「流量≈0」的前提不成立；订阅刷新留在客户端 |
| 并发写 | OSS 无跨实例 CAS，本实现是「读-比较-写」乐观锁。请把**单实例并发上限设为 1**，或改用 Tablestore 原子计数分配 revision |
| WebSocket | FC 按连接时长计费且实例无粘性，**弹幕长连接绝不放 FC** |
| 免费额度 | 各版本/活动口径不同（有「每月 100 万次调用 + 40 万 CU-秒」与新用户试用额度等说法），以官网当期说明为准 |
| 计费取整 | 部分规则按小时最低 0.01 元取整；实际账单以控制台为准 |

---

## 八、排错表

| 现象 | 最可能原因 |
|---|---|
| 找不到 `index.handler` | zip 多套了一层目录；或请求处理程序填错 |
| 所有接口 401 | `CONFIG_READ_TOKEN` 与请求里的 Bearer 不一致；写接口要用 `CONFIG_WRITE_TOKEN` |
| `/health` 显示 `devMode: true` | 两个 Token 都没设，公网裸奔，立刻补上 |
| 保存配置 409 | 云端 revision 已变，点编辑器「载入云端版」后重试 |
| 接口 500 + `ImportError: oss2` | 没执行 `pip3 install -r requirements.txt -t .`，或装完没发布新版本 |
| OSS 403 | RAM 策略 Resource 写错、`ListObjects` 缺 Bucket 级授权、endpoint 与 Bucket 地域不符 |
| 冷启动后配置回到 seed | 仍在用 `CONFIG_STORAGE_BACKEND=file`；FC 本地磁盘不持久 |
| 编辑器打不开 / 跨域报错 | 编辑器与 API 不同源时设置 `CONFIG_CORS_ORIGINS=https://editor.example.com`（精确域名，**不要用 `*`**） |
| TV 端没生效 | 检查 `PURE_LIVE_CONFIG_URL` 是否只填基地址、Token 是否只读令牌、对应节的 `managed` 是否为 `true` |

---

## 九、回滚与合规

- 配置回滚：编辑器「历史 / 回滚」或 `POST /api/config/rollback`（生成新 revision，终端下次同步自然拉到旧配置）。
- 服务整体异常：把 OSS `history/` 里某个快照复制回 `current.json`，注意保持 `revision` 单调递增。
- 上游 `LICENSE` 首行是 **AGPL-3.0**（README 徽章写 GPL-3.0，以 LICENSE 为准）。
  提供托管配置服务涉及 §13 网络交互条款，二次开发/分发前请自行确认源码义务。
- 本服务只下发配置、不转发直播流、不集中分发 IPTV 频道表；Cookie 与代理凭据 v1 不上云。
