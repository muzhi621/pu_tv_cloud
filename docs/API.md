# 配置服务接口说明（v1）

Base URL：部署后为 FC HTTP 触发器域名；本地为 `http://127.0.0.1:8080`。
除 `/health` 与静态编辑器外，所有 `/api/*` 请求需要 `Authorization: Bearer <read-token>`。
写入类接口（PUT、rollback）需要 `<write-token>`。

## 接口总览

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| GET | `/health` | 无 | 存活探测，返回当前 revision、后端类型、是否开发模式 |
| GET | `/api/config` | read | 全量配置；`since=<rev>` 或 `If-None-Match` 命中返回 304 |
| PUT | `/api/config` | write | 写入配置；需 `If-Match`，冲突返回 409 |
| GET | `/api/config/catalog` | read | 站点/导航 id 目录（编辑器选项来源） |
| GET | `/api/config/revisions?limit=20` | read | 历史快照列表（倒序） |
| POST | `/api/config/rollback` | write | 回滚到指定快照，生成新 revision |
| GET | `/`、`/app.js`、`/style.css` | 无 | 在线编辑器静态资源 |

## GET /api/config

响应头：`ETag: "<revision>"`、`X-Revision`、`X-Schema-Version: 1`、
`Cache-Control: no-store`；请求带 `Accept-Encoding: gzip` 时响应体 gzip 压缩。

```json
{
  "schemaVersion": 1,
  "revision": 42,
  "updatedAt": "2026-11-11T08:00:00+08:00",
  "sections": {
    "sites": {"managed": true, "policy": "whitelist", "enabledSiteIds": ["bilibili", "huya", "iptv"]},
    "navigation": {"managed": true, "railMenuIds": ["favorite", "hot", "areas"], "sidebarExpanded": false,
                   "homeKeepAlive": true, "settings": {"managed": false, "enabledEntryPaths": []}},
    "startup": {"managed": true, "agreement": {"enabled": true, "requiredVersion": 2,
                 "titleI18n": {"zh": "用户协议"}, "bodyI18n": {}},
                 "notice": {"enabled": true, "mode": "once_per_revision", "dismissible": true,
                 "titleI18n": {}, "bodyI18n": {}}, "showSplashPage": true},
    "update": {"managed": true, "autoCheck": true, "checkIntervalHours": 24, "prompt": "dialog",
               "minSupportedVersion": "", "allowPrerelease": false, "allowUserOverride": true,
               "mirrorUrls": [], "changelogI18n": {}}
  }
}
```

`GET /api/config?since=42` 或 `If-None-Match: "42"` → `304 Not Modified`（空响应体，
仍带 ETag / X-Revision）。revision 由服务端维护，客户端只能读取。

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

字段校验规则见 `cloud/schema.py` 与需求文档 4.3 / 4.4。未知节被忽略，
未提供字段沿用内置 seed 值。

**字段语义补充**：`update.mirrorUrls` 是**完整的 `version.json` URL 列表**（不是镜像域名前缀），
终端 `VersionUtil._versionUrls` 会直接把它当作下载地址；留空则沿用内置
GitHub 镜像。`navigation.settings` 是 P1 预留节，P0 终端不读取。

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

## 错误码

| 状态 | code | 含义 |
|---|---|---|
| 400 | `invalid_config` | 请求体/字段不合法、缺少 If-Match、快照不存在 |
| 401 | `unauthorized` | Token 缺失或无效 |
| 404 | `not_found` | 未知接口或静态资源 |
| 405 | `method_not_allowed` | 方法不支持 |
| 409 | `revision_conflict` | 乐观锁冲突 |
| 413 | `payload_too_large` | 请求体超过 1 MiB |
| 500 | `internal_error` | 服务端异常（不向客户端泄露栈） |
