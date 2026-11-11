"""WSGI 测试辅助：不启网络服务，直接构造 environ 调用应用。"""
from __future__ import annotations

import gzip
import io
import json
from typing import Any


def call(app, method: str, path: str, body: bytes | None = None,
         headers: dict[str, str] | None = None, query: str = ""):
    environ: dict[str, Any] = {
        "REQUEST_METHOD": method,
        "PATH_INFO": path,
        "QUERY_STRING": query,
        "CONTENT_LENGTH": str(len(body)) if body else "0",
        "wsgi.input": io.BytesIO(body or b""),
        "wsgi.errors": io.StringIO(),
        "wsgi.version": (1, 0),
        "wsgi.url_scheme": "http",
        "SERVER_NAME": "localhost",
        "SERVER_PORT": "8080",
    }
    for key, value in (headers or {}).items():
        environ["HTTP_" + key.upper().replace("-", "_")] = value
    captured: dict[str, Any] = {}

    def start_response(status, response_headers):
        captured["status"] = status
        captured["headers"] = dict(response_headers)

    payload = b"".join(app(environ, start_response))
    if captured["headers"].get("Content-Encoding") == "gzip":
        payload = gzip.decompress(payload)
    return captured["status"], captured["headers"], payload


def json_body(app, method: str, path: str, value, **kwargs):
    body = json.dumps(value, ensure_ascii=False).encode("utf-8") if value is not None else None
    return call(app, method, path, body=body, **kwargs)
