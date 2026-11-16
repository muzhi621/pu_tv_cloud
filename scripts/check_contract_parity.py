#!/usr/bin/env python3
"""校验 schema.py 与 contract.js 的共享契约常量一致。

FC 版（Python）与 EdgeOne 版（JS）是两份逐条对齐的手工实现。此前只有各自
的语法检查和单测，没有机制防止单侧改动导致两端下发分叉。本脚本提取两端
都定义的 `NAME = <简单字面量>` 常量，逐项比对数值；只要任一侧改了上限而
忘了同步另一侧，CI 就会失败。

只比对可从源码可靠提取的简单常量（整数、字符串元组/数组、布尔），跳过依赖
表达式的派生常量（如 MAX_LIBRARY_BYTES = MAX_DOCUMENT_BYTES、由 CATALOG
计算出的 VALID_*），避免误报。
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PY = ROOT / "cloud" / "schema.py"
JS = ROOT / "edge-functions" / "_lib" / "contract.js"

# 只关心两端都出现、且语义必须一致的常量。显式列出，避免误把本地专用常量纳入。
SHARED = [
    "SECTION_KEYS",
    "MAX_TEXT_LEN",
    "MAX_LIST_ITEMS",
    "MAX_NAV_GROUPS",
    "MAX_NAV_CHILDREN",
    "MAX_NAV_LABEL_LEN",
    "MAX_NAV_ICON_LEN",
    "MAX_IPTV_CHANNELS",
    "MAX_DOCUMENT_BYTES",
    "MAX_IPTV_PACKAGES",
    "MAX_PACKAGE_CHANNELS_TOTAL",
    "MAX_PACKAGE_SOURCES",
    "MAX_PACKAGE_ID_LEN",
    "MAX_PACKAGE_NAME_LEN",
    "MAX_LIBRARY_SOURCES",
    "MAX_VOD_SOURCES",
    "MAX_VOD_SITES",
    "MAX_VOD_SITES_PER_SOURCE",
]


def parse_python(source: str) -> dict[str, str]:
    out: dict[str, str] = {}
    for name in SHARED:
        m = re.search(r"^%s\s*=\s*(.+?)\s*$" % re.escape(name), source, re.M)
        if not m:
            continue
        out[name] = _normalize(m.group(1), "py")
    return out


def parse_js(source: str) -> dict[str, str]:
    out: dict[str, str] = {}
    for name in SHARED:
        m = re.search(r"^(?:export\s+)?const %s\s*=\s*(.+?);\s*$" % re.escape(name), source, re.M)
        if not m:
            continue
        out[name] = _normalize(m.group(1), "js")
    return out


def _normalize(expr: str, lang: str) -> str:
    """把两端写法归一成可比较的字符串：数字去下划线/空格，字符串数组取内容。"""
    expr = expr.strip()
    # 注释尾巴（Python 的 # ...）
    if lang == "py":
        expr = re.split(r"\s+#", expr)[0].strip()
    # 数字字面量（1_000_000_000 等）
    if re.fullmatch(r"[\d_]+", expr):
        return str(int(expr.replace("_", "")))
    # 字符串元组/数组 → 提取引号内字符串序列（两端写法统一为有序 JSON 数组）
    stripped = expr.strip()[0]  # '(' 或 '['
    if stripped in "([" and expr.strip()[-1] in ")]":
        strings = re.findall(r"['\"]([^'\"]+)['\"]", expr)
        if strings:
            return json.dumps(strings)
    return expr  # 其余（含 * 表达式）原样返回


def main() -> int:
    py = parse_python(PY.read_text(encoding="utf-8"))
    js = parse_js(JS.read_text(encoding="utf-8"))
    # 只比对两端都定义的常量：某些上限是 Python 实现细节（JS 内联了字面量），
    # 单侧存在不代表分叉；真正危险的是"两边都有但值不同"。
    shared = [name for name in SHARED if name in py and name in js]
    skipped = [name for name in SHARED if name not in py or name not in js]
    mismatches = [(name, py[name], js[name]) for name in shared if py[name] != js[name]]
    if mismatches:
        print("契约常量不一致（两端下发将分叉）：")
        for name, a, b in mismatches:
            print(f"  - {name}: schema.py={a} != contract.js={b}")
        print(f"（另有 {len(skipped)} 项仅单侧定义，已跳过：{', '.join(skipped)}）")
        return 1
    print(f"OK   {len(shared)} 项共享契约常量两端一致"
          f"（{len(skipped)} 项仅单侧定义，跳过）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
