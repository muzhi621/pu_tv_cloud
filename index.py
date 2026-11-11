"""阿里云函数计算 FC 3.0 · Python HTTP 函数入口。

在函数配置里把「请求处理程序」设为 index.handler，
并开启 HTTP 触发器（建议启用 Bearer/JWT 认证或由本模块自行校验 Token）。

如果改用「Web 函数 / 自定义运行时」，请改用 cloud/server.py 作为启动命令：
    python3 -m cloud.server
该命令监听 FC_SERVER_PORT（默认 9000）。
"""
from cloud.app import create_app

_app = create_app()


def handler(environ, start_response):
    """FC HTTP 函数标准 WSGI 签名。"""
    return _app(environ, start_response)
