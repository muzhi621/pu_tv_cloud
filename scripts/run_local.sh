#!/usr/bin/env sh
# 本地启动配置服务（文件后端 + 内置编辑器）。
set -eu
cd "$(dirname "$0")/.."

if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
fi

PORT="${PORT:-8080}"
echo "启动配置服务，端口 ${PORT}"
echo "编辑器地址: http://127.0.0.1:${PORT}/"
exec python3 -m cloud.server --port "${PORT}"
