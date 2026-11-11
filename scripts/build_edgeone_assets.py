#!/usr/bin/env python3
"""生成 EdgeOne 部署所需的内联资源，并可选打包上传用的 zip。

用法：
    python scripts/build_edgeone_assets.py            # 重新生成 _lib/data.js 与 _lib/editor.js
    python scripts/build_edgeone_assets.py --check   # CI：校验生成物是否与源文件一致
    python scripts/build_edgeone_assets.py --zip     # 额外生成 dist/pu_tv_cloud_edgeone_v1.0.0.zip

单一数据源：config/seed.json、config/site_catalog.json、editor/*。
Edge Functions 只支持 JavaScript、代码包上限 5 MB，且不能依赖运行时文件路径，
所以把契约数据和编辑器页面在构建前内联成 JS 常量，部署时零依赖、零构建。
"""
from __future__ import annotations

import argparse
import json
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
EDGEONE = ROOT / "edgeone"
LIB = EDGEONE / "edge-functions" / "_lib"
DIST = ROOT / "dist"
ZIP_NAME = "pu_tv_cloud_edgeone_v1.0.0.zip"

GENERATED_HEADER = "// 本文件由 scripts/build_edgeone_assets.py 生成，请勿手改。\n"


def _read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def build_data_js() -> str:
    seed = json.loads(_read(ROOT / "config" / "seed.json"))
    catalog = json.loads(_read(ROOT / "config" / "site_catalog.json"))
    if seed.get("schemaVersion") != catalog.get("schemaVersion"):
        raise SystemExit("seed.json 与 site_catalog.json 的 schemaVersion 不一致")
    return (
        GENERATED_HEADER
        + "// 数据源：config/seed.json、config/site_catalog.json\n\n"
        + "export const SCHEMA_VERSION = %d;\n\n" % int(seed["schemaVersion"])
        + "export const SEED = " + json.dumps(seed, ensure_ascii=False, indent=2) + ";\n\n"
        + "export const CATALOG = " + json.dumps(catalog, ensure_ascii=False, indent=2) + ";\n"
    )


def build_editor_js() -> str:
    html = _read(ROOT / "editor" / "index.html")
    css = _read(ROOT / "editor" / "style.css")
    app = _read(ROOT / "editor" / "app.js")

    if "</script" in app.lower():
        raise SystemExit("editor/app.js 含有 </script，内联会截断 HTML，请先转义")
    if "</style" in css.lower():
        raise SystemExit("editor/style.css 含有 </style，内联会截断 HTML，请先转义")

    link_tag = '<link rel="stylesheet" href="/style.css">'
    script_tag = '<script src="/app.js"></script>'
    if link_tag not in html or script_tag not in html:
        raise SystemExit("editor/index.html 的 CSS/JS 引用标签与预期不符，请同步修改本脚本")
    html = html.replace(link_tag, "<style>\n" + css + "\n</style>")
    html = html.replace(script_tag, "<script>\n" + app + "\n</script>")

    return (
        GENERATED_HEADER
        + "// 数据源：editor/index.html + style.css + app.js（内联为单页，无需静态目录）\n"
        + "export const EDITOR_HTML = " + json.dumps(html, ensure_ascii=False) + ";\n"
    )


def generated() -> dict[Path, str]:
    return {
        LIB / "data.js": build_data_js(),
        LIB / "editor.js": build_editor_js(),
    }


def write_all(check_only: bool = False) -> bool:
    ok = True
    for path, content in generated().items():
        current = path.read_text(encoding="utf-8") if path.is_file() else None
        if current == content:
            print("OK   %s（已是最新）" % path.relative_to(ROOT))
            continue
        if check_only:
            print("STALE %s —— 请运行 python scripts/build_edgeone_assets.py" % path.relative_to(ROOT))
            ok = False
            continue
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")
        print("GEN  %s (%d bytes)" % (path.relative_to(ROOT), len(content.encode("utf-8"))))
    return ok


def build_zip() -> Path:
    DIST.mkdir(parents=True, exist_ok=True)
    target = DIST / ZIP_NAME
    excluded = {"__pycache__", "node_modules", ".DS_Store"}
    files = sorted(
        p for p in EDGEONE.rglob("*")
        if p.is_file() and not any(part in excluded for part in p.parts)
    )
    with zipfile.ZipFile(target, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
        for path in files:
            zf.write(path, path.relative_to(EDGEONE).as_posix())
    print("ZIP  %s (%d 个文件, %d bytes)" % (target, len(files), target.stat().st_size))
    return target


def main() -> int:
    parser = argparse.ArgumentParser(description="生成 EdgeOne 部署资源")
    parser.add_argument("--check", action="store_true", help="只校验生成物是否与源文件一致")
    parser.add_argument("--zip", action="store_true", help="额外生成部署 zip")
    args = parser.parse_args()

    ok = write_all(check_only=args.check)
    if not ok:
        return 1
    if args.zip and not args.check:
        build_zip()
    return 0


if __name__ == "__main__":
    sys.exit(main())
