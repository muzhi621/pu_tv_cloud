"""本地开发 / 自建服务器 / FC Web 函数启动入口。

    python3 -m cloud.server                 # 默认 0.0.0.0:8080
    python3 -m cloud.server --port 9000    # FC 自定义运行时
    PORT=9000 python3 -m cloud.server      # 也可通过环境变量指定
"""
from __future__ import annotations

import argparse
import os
from socketserver import ThreadingMixIn
from wsgiref.simple_server import WSGIServer, make_server

from .app import create_app
from .schema import SCHEMA_VERSION


class ThreadingWSGIServer(ThreadingMixIn, WSGIServer):
    daemon_threads = True


class QuietHandler:
    """占位，保留给需要自定义日志格式的部署方式。"""


def main() -> None:
    parser = argparse.ArgumentParser(description="纯粹直播 TV 云端配置服务")
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int,
                        default=int(os.environ.get("FC_SERVER_PORT")
                                    or os.environ.get("PORT") or "8080"))
    args = parser.parse_args()

    app = create_app()
    httpd = make_server(args.host, args.port, app, server_class=ThreadingWSGIServer)
    print("配置服务已启动: http://%s:%d  (schemaVersion=%d)" %
          (args.host, args.port, SCHEMA_VERSION), flush=True)
    print("编辑器: http://127.0.0.1:%d/" % args.port, flush=True)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()


if __name__ == "__main__":
    main()
