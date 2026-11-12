"""WSGI 应用：云端配置 API + 同源静态编辑器。

对应需求文档 FR-01。零第三方依赖（OSS 后端除外），
可直接作为阿里云 FC 3.0 Python HTTP 函数入口，也可本地起服务。

接口：
  GET  /health                    存活探测（无需鉴权）
  GET  /api/config               全量配置，支持 since / If-None-Match → 304
  PUT  /api/config               写入配置，需 Bearer 写 token + If-Match → 409
  GET  /api/config/catalog       站点与导航 id 目录（编辑器用）
  GET  /api/config/revisions     历史快照列表
  POST /api/config/rollback      回滚到指定快照（生成新 revision）
  GET  /  /app.js  /style.css    在线编辑器静态资源
"""
from __future__ import annotations

import gzip
import hmac
import json
import os
import sys
import traceback
from pathlib import Path
from typing import Any, Callable
from urllib.parse import parse_qs

from .schema import (
    CATALOG,
    SCHEMA_VERSION,
    ConfigError,
    etag_for,
    expand_iptv_channels,
    normalize_sections,
)
from .storage import Conflict, Storage, create_storage

_ROOT = Path(__file__).resolve().parent.parent

_STATIC_FILES = {
    "/": ("index.html", "text/html; charset=utf-8"),
    "/index.html": ("index.html", "text/html; charset=utf-8"),
    "/app.js": ("app.js", "application/javascript; charset=utf-8"),
    "/style.css": ("style.css", "text/css; charset=utf-8"),
}


class HttpError(Exception):
    def __init__(self, status: int, code: str, message: str, extra: dict | None = None):
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message
        self.extra = extra or {}


_STATUS_TEXT = {
    200: "OK", 204: "No Content", 304: "Not Modified",
    400: "Bad Request", 401: "Unauthorized", 404: "Not Found",
    405: "Method Not Allowed", 409: "Conflict", 413: "Payload Too Large",
    500: "Internal Server Error",
}


def _json_bytes(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


def create_app(env: dict[str, str] | None = None, storage: Storage | None = None) -> Callable:
    cfg: dict[str, str] = env if env is not None else dict(os.environ)
    store = storage or create_storage(cfg)
    read_token = cfg.get("CONFIG_READ_TOKEN", "").strip()
    write_token = cfg.get("CONFIG_WRITE_TOKEN", "").strip() or read_token
    dev_mode = not read_token
    cors_origins = [item.strip() for item in cfg.get("CONFIG_CORS_ORIGINS", "").split(",") if item.strip()]
    editor_dir = Path(cfg.get("CONFIG_EDITOR_DIR") or (_ROOT / "editor"))

    def _cors_headers(environ: dict) -> list[tuple[str, str]]:
        origin = environ.get("HTTP_ORIGIN", "")
        if not origin or not cors_origins:
            return []
        if "*" in cors_origins or origin in cors_origins:
            return [
                ("Access-Control-Allow-Origin", "*" if "*" in cors_origins else origin),
                ("Access-Control-Allow-Methods", "GET, PUT, POST, OPTIONS"),
                ("Access-Control-Allow-Headers", "Authorization, Content-Type, If-Match, If-None-Match"),
                ("Access-Control-Max-Age", "600"),
                ("Vary", "Origin"),
            ]
        return []

    def _send(start_response: Callable, status: int, body: bytes = b"",
              content_type: str = "application/json; charset=utf-8",
              environ: dict | None = None, headers: list[tuple[str, str]] | None = None,
              compress: bool = True) -> list[bytes]:
        out: list[tuple[str, str]] = list(headers or [])
        out.append(("Content-Type", content_type))
        out.append(("Cache-Control", "no-store"))
        if environ is not None:
            out.extend(_cors_headers(environ))
        payload = body
        if compress and payload and len(payload) > 200 and "gzip" in (environ or {}).get("HTTP_ACCEPT_ENCODING", ""):
            payload = gzip.compress(payload, compresslevel=6, mtime=0)
            out.append(("Content-Encoding", "gzip"))
            out.append(("Vary", "Accept-Encoding"))
        out.append(("Content-Length", str(len(payload))))
        start_response("%d %s" % (status, _STATUS_TEXT.get(status, "")), out)
        return [payload] if status not in (204, 304) else [b""]

    def _authorized(environ: dict, scope: str) -> bool:
        token = read_token if scope == "read" else write_token
        if not token:
            return True
        header = environ.get("HTTP_AUTHORIZATION", "")
        if not header.startswith("Bearer "):
            return False
        return hmac.compare_digest(header[7:].strip(), token)

    def _require(environ: dict, scope: str) -> None:
        if not _authorized(environ, scope):
            raise HttpError(401, "unauthorized", "缺少或无效的 Bearer Token")

    def _read_body(environ: dict) -> dict:
        try:
            length = int(environ.get("CONTENT_LENGTH") or "0")
        except ValueError:
            length = 0
        if length <= 0:
            raise ConfigError("请求体不能为空")
        if length > 1024 * 1024:
            raise HttpError(413, "payload_too_large", "请求体超过 1 MiB")
        raw = environ["wsgi.input"].read(length)
        try:
            value = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, ValueError) as exc:
            raise ConfigError("请求体不是合法 JSON: %s" % exc) from exc
        if not isinstance(value, dict):
            raise ConfigError("请求体必须是 JSON 对象")
        return value

    def _headers_for_document(document: dict) -> list[tuple[str, str]]:
        revision = document["revision"]
        return [
            ("ETag", etag_for(revision)),
            ("X-Revision", str(revision)),
            ("X-Schema-Version", str(SCHEMA_VERSION)),
        ]

    def _static(environ: dict, start_response: Callable, path: str) -> list[bytes]:
        entry = _STATIC_FILES.get(path)
        if entry is None:
            raise HttpError(404, "not_found", "资源不存在")
        filename, content_type = entry
        file_path = editor_dir / filename
        if not file_path.is_file():
            raise HttpError(404, "not_found", "编辑器资源未部署: %s" % filename)
        return _send(start_response, 200, file_path.read_bytes(), content_type,
                     environ, compress=True)

    def _dispatch(environ: dict, start_response: Callable) -> list[bytes]:
        method = environ.get("REQUEST_METHOD", "GET").upper()
        path = environ.get("PATH_INFO", "/") or "/"
        query = parse_qs(environ.get("QUERY_STRING", ""), keep_blank_values=True)

        if method == "OPTIONS" and cors_origins:
            return _send(start_response, 204, environ=environ, compress=False)

        # ---- 静态编辑器 ----
        if method == "GET" and (path in _STATIC_FILES or path == "/favicon.ico"):
            if path == "/favicon.ico":
                raise HttpError(404, "not_found", "无 favicon")
            return _static(environ, start_response, path)

        if path == "/health":
            if method != "GET":
                raise HttpError(405, "method_not_allowed", "仅支持 GET")
            document = store.read()
            return _send(start_response, 200, _json_bytes({
                "status": "ok",
                "revision": document["revision"],
                "backend": cfg.get("CONFIG_STORAGE_BACKEND", "file"),
                "devMode": dev_mode,
            }), environ=environ)

        if path == "/api/config/catalog":
            if method != "GET":
                raise HttpError(405, "method_not_allowed", "仅支持 GET")
            _require(environ, "read")
            return _send(start_response, 200, _json_bytes(CATALOG), environ=environ)

        if path == "/api/config/revisions":
            if method != "GET":
                raise HttpError(405, "method_not_allowed", "仅支持 GET")
            _require(environ, "read")
            try:
                limit = int(query.get("limit", ["20"])[0])
            except ValueError:
                limit = 20
            return _send(start_response, 200, _json_bytes({"revisions": store.revisions(limit)}),
                         environ=environ)

        if path == "/api/config/rollback":
            if method != "POST":
                raise HttpError(405, "method_not_allowed", "仅支持 POST")
            _require(environ, "write")
            body = _read_body(environ)
            revision = body.get("revision")
            if isinstance(revision, bool) or not isinstance(revision, int) or revision < 0:
                raise ConfigError("revision 必须是非负整数")
            document = store.rollback(revision)
            return _send(start_response, 200, _json_bytes({
                "revision": document["revision"],
                "updatedAt": document["updatedAt"],
                "rolledBackFrom": revision,
            }), environ=environ, headers=_headers_for_document(document))

        if path != "/api/config":
            raise HttpError(404, "not_found", "未知接口: %s" % path)

        # ---- GET /api/config ----
        if method == "GET":
            _require(environ, "read")
            document = store.read()
            revision = document["revision"]
            since = query.get("since", [""])[0].strip()
            inm = environ.get("HTTP_IF_NONE_MATCH", "").strip().strip('"')
            if (since and since == str(revision)) or (inm and inm == str(revision)):
                return _send(start_response, 304, environ=environ,
                             headers=_headers_for_document(document), compress=False)
            # 与 Edge Functions 版一致：选中套餐时把频道展开成终端认识的 channels；
            # 终端不带 withPackages=1 时只返回套餐元数据，避免心跳重复传几百 KB。
            view = dict(document)
            sections_view = expand_iptv_channels(document["sections"])
            iptv = sections_view.get("iptv") or {}
            packages = iptv.get("packages")
            if isinstance(packages, list) and query.get("withPackages", [""])[0] != "1":
                iptv["packages"] = [
                    {"id": pkg.get("id", ""), "name": pkg.get("name", ""),
                     "sources": pkg.get("sources", []),
                     "channelCount": len(pkg.get("channels") or [])}
                    for pkg in packages
                ]
            view["sections"] = sections_view
            return _send(start_response, 200, _json_bytes(view), environ=environ,
                         headers=_headers_for_document(document))

        # ---- PUT /api/config ----
        if method == "PUT":
            _require(environ, "write")
            body = _read_body(environ)
            sections_raw = body.get("sections")
            if not isinstance(sections_raw, dict):
                raise ConfigError("请求体必须包含 sections 对象")
            if_match = environ.get("HTTP_IF_MATCH", "").strip().strip('"')
            if not if_match:
                expected = body.get("expectedRevision")
                if isinstance(expected, int) and not isinstance(expected, bool):
                    if_match = str(expected)
            if not if_match or not if_match.isdigit():
                raise ConfigError("缺少 If-Match（或 expectedRevision），拒绝覆盖未知版本")
            sections, warnings = normalize_sections(sections_raw)
            document = store.write(sections, int(if_match))
            response: dict[str, Any] = {
                "revision": document["revision"],
                "updatedAt": document["updatedAt"],
                "warnings": warnings,
            }
            if dev_mode:
                response["devMode"] = True
            return _send(start_response, 200, _json_bytes(response), environ=environ,
                         headers=_headers_for_document(document))

        raise HttpError(405, "method_not_allowed", "仅支持 GET / PUT")

    def app(environ: dict, start_response: Callable) -> list[bytes]:
        try:
            return _dispatch(environ, start_response)
        except Conflict as exc:
            current = exc.current
            payload = _json_bytes({
                "error": "revision_conflict",
                "message": str(exc),
                "currentRevision": current["revision"],
                "document": current,
            })
            return _send(start_response, 409, payload, environ=environ,
                         headers=_headers_for_document(current))
        except ConfigError as exc:
            return _send(start_response, 400, _json_bytes({"error": "invalid_config", "message": str(exc)}),
                         environ=environ, compress=False)
        except HttpError as exc:
            payload = dict({"error": exc.code, "message": exc.message}, **exc.extra)
            return _send(start_response, exc.status, _json_bytes(payload), environ=environ,
                         compress=False)
        except Exception as exc:  # noqa: BLE001 - 不向客户端泄露栈
            traceback.print_exc(file=sys.stderr)
            return _send(start_response, 500,
                         _json_bytes({"error": "internal_error", "message": "服务端内部错误: %s" % type(exc).__name__}),
                         environ=environ, compress=False)

    return app
