# 阿里云函数计算 FC 3.0 + OSS 部署说明

本服务是无状态 WSGI 应用，配置外置到 OSS（或单机用本地文件）。任选下面一种运行时：

## 方案 A：Python 运行时 + HTTP 函数（最省事）

1. 创建 FC 3.0 函数，运行时选 **Python 3.10 / 3.12**，请求处理程序填 `index.handler`。
2. 上传代码包，包含：`index.py`、`cloud/`、`config/`、`editor/`。
   `data/` 不要打包；`requirements.txt` 仅在用 OSS 后端时需要（`oss2`）。
3. 创建 **HTTP 触发器**，按需启用平台自带的 Bearer/JWT 认证（可与本服务的
   `CONFIG_*_TOKEN` 双层使用）。
4. 环境变量按 `.env.example` 填写，至少设置：
   - `CONFIG_READ_TOKEN`、`CONFIG_WRITE_TOKEN`
   - `CONFIG_STORAGE_BACKEND=oss`
   - `OSS_ENDPOINT`、`OSS_BUCKET`、`OSS_PREFIX`
   - 凭据优先用 **函数角色 RAM 授权**访问 OSS，避免明文 AK；若用 AK 则填
     `OSS_ACCESS_KEY_ID` / `OSS_ACCESS_KEY_SECRET`。
5. `index.handler` 是标准 WSGI 签名 `(environ, start_response)`，FC HTTP 触发器直接调用。

## 方案 B：Web 函数 / 自定义运行时（自定义端口与进程）

把启动命令设为：

```bash
python3 -m cloud.server
```

服务监听 `FC_SERVER_PORT`（默认 9000，也可用 `PORT` 覆盖），绑定 `0.0.0.0`。
适合需要自定义容器镜像、把编辑器一起塞进镜像的场景。其余环境变量同方案 A。

## OSS 准备

- 建一个私有 Bucket，前缀例如 `pure_live_tv/`。
- 函数首次读取 `current.json` 不存在时会自动写入内置 seed（revision 0）。
- 每次写入会先存 `history/000000NN.json` 不可变快照，再原子切换 `current.json`。
- 给函数角色最小权限：该前缀下的 `GetObject` / `PutObject` / `ListObjects`。
- 建议开启 Bucket 版本控制或定期把 `current.json` 备份到另一路径。

## 配置同源托管编辑器

`GET /` 已经返回 `editor/index.html`，直接把 HTTP 触发器域名给编辑器使用者即可。
若编辑器单独部署在其他域名，设置 `CONFIG_CORS_ORIGINS=https://editor.example.com`
（精确域名，**不要用 `*`**）。编辑器里的「API 地址」填触发器域名、「访问令牌」
填 read/write Token（浏览器 localStorage 保存，注意共用电脑时清理）。

## 验证清单

```bash
BASE=https://<your-fc-domain>
curl -s $BASE/health
curl -s -H "Authorization: Bearer $READ_TOKEN" $BASE/api/config
curl -s -H "Authorization: Bearer $READ_TOKEN" -H 'If-None-Match: "0"' -i $BASE/api/config | head -8
```

- `/health` 返回 `devMode:false` 才说明鉴权已生效。
- 带正确 ETag 的请求应返回 304。
- 编辑器保存一次，确认 revision +1、`history/` 下出现新快照。
- 用旧 revision 再 PUT 一次，应返回 409 且带 `currentRevision`。

## 成本与限制（务必确认）

- **无状态**：不要把配置写进函数本地磁盘，重启即丢；必须用 OSS / Tablestore。
- **计费**：按 CU 使用量计费，配置读取属于极低频小请求，成本接近地板价；
  部分计费规则按小时最低 0.01 元取整，实际以官网当期规则为准。
- **最小实例数设为 ≥1 会常驻计费**（浅休眠仍收内存费），个人规模建议保持 0。
- **公网出流量走 CDT 单独计费**：不要让 FC 定时抓取 M3U 订阅或转发直播流，
  否则「流量≈0」的前提不成立。订阅刷新留在客户端。
- **WebSocket 按连接时长计费且实例无粘性**：弹幕等长连接绝不放 FC。
- **并发写**：OSS 无跨实例 CAS，本实现是读-比较-写乐观锁。多写入者场景请把
  函数实例并发上限设为 1，或改用 Tablestore 原子计数做 revision 分配。
- **免费额度**口径各版本/活动不同，以官网当期说明为准。

## 回滚

优先用编辑器「历史 / 回滚」或 `POST /api/config/rollback`。回滚生成新 revision，
终端下次同步自然拉到旧配置。若服务整体异常，可把 OSS 上 `history/` 里某个快照
复制回 `current.json`（记得保持 `revision` 字段单调递增）。

## 合规提示

上游 `LICENSE` 首行为 **AGPL-3.0**（README 写 GPL-3.0）。提供托管配置服务涉及
网络交互条款，二次开发/分发前请自行确认 §13 源码义务。本服务只下发配置、
不转发任何直播流，也不集中分发 IPTV 频道表，Cookie 与代理凭据 v1 不上云。
