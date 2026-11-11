#!/usr/bin/env python3
"""生成可直接上传到阿里云函数计算 FC 3.0 的代码包。

用法（在仓库根目录）：
    python scripts/build_fc_package.py
    python scripts/build_fc_package.py --output /path/to/custom.zip

产物的根目录必须直接包含 index.py / cloud/ / config/ / editor/，
否则 FC 找不到请求处理程序 index.handler。

默认零第三方依赖：可直接上传并用 file 后端验证接口与编辑器。
生产持久化请在 FC WebIDE 里执行 `pip3 install -r requirements.txt -t .`
后切到 OSS 后端，详见 docs/DEPLOY_FC.md。
"""
from __future__ import annotations

import argparse
import shutil
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_OUTPUT = ROOT / "dist" / "pu_tv_cloud_fc_v1.0.0.zip"

PACKAGE_FILES = (
    "index.py",
    "cloud/__init__.py",
    "cloud/app.py",
    "cloud/schema.py",
    "cloud/storage.py",
    "cloud/server.py",
    "config/seed.json",
    "config/site_catalog.json",
    "editor/index.html",
    "editor/app.js",
    "editor/style.css",
    "requirements.txt",
    ".env.example",
)

QUICK_GUIDE = """# pu_tv_cloud · 阿里云函数计算构建包

请求处理程序：index.handler（WSGI）
运行时：Python 3.10 / 3.12，架构 x86_64
代码包根目录必须直接包含 index.py、cloud/、config/、editor/（不要多套一层目录）。

## 最快验证
1. FC 控制台创建函数 → 运行时 Python 3.10 → 上传本 zip → 处理程序 index.handler。
2. 创建 HTTP 触发器（GET/POST/PUT/OPTIONS），最小实例数设 0。
3. 设置 CONFIG_READ_TOKEN / CONFIG_WRITE_TOKEN；验证阶段保持
   CONFIG_STORAGE_BACKEND=file、CONFIG_DATA_DIR=/tmp/pure_live_tv。
4. 访问 /health 与 /，用 GET/PUT /api/config 验证接口与编辑器。
   注意：FC 无状态，file 后端重启即丢配置，仅供验证。

## 生产使用（持久化）
- 方案 A（最低成本）：FC WebIDE 执行 `pip3 install -r requirements.txt -t .`，
  设置 CONFIG_STORAGE_BACKEND=oss 与 OSS_* 环境变量，再发布新版本。
  当前 OSSStorage 只支持 AK/SK，不支持函数角色。
- 方案 B（零第三方依赖）：挂载 NAS，CONFIG_STORAGE_BACKEND=file，
  CONFIG_DATA_DIR=/mnt/nas/pure_live_tv。

完整教程见仓库 docs/DEPLOY_FC.md。
"""


def build(output: Path) -> Path:
    missing = [rel for rel in PACKAGE_FILES if not (ROOT / rel).is_file()]
    if missing:
        raise SystemExit("缺少待打包文件: " + ", ".join(missing))

    output.parent.mkdir(parents=True, exist_ok=True)
    if output.exists():
        output.unlink()

    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
        for rel in PACKAGE_FILES:
            zf.write(ROOT / rel, rel)
        zf.writestr("DEPLOY.md", QUICK_GUIDE)

    with zipfile.ZipFile(output) as zf:
        names = zf.namelist()
        assert "index.py" in names and "cloud/app.py" in names
        assert not any("__pycache__" in n or n.startswith("data/") for n in names)

    return output


def main() -> None:
    parser = argparse.ArgumentParser(description="生成阿里云 FC 代码包")
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    args = parser.parse_args()
    out = build(args.output.resolve())
    print("已生成:", out)
    print("大小: %.1f KB" % (out.stat().st_size / 1024))
    with zipfile.ZipFile(out) as zf:
        print("条目数:", len(zf.namelist()))


if __name__ == "__main__":
    main()
