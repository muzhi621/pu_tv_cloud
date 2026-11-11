"""云端配置契约：校验、规范化与兜底。

对应《纯粹直播 TV · 云端配置下发需求文档 v1.0》第 4 章。
只依赖标准库，便于直接部署在阿里云 FC Python 运行时。

设计原则：
- 每个节带 managed，未接管时客户端完全忽略该节。
- 白名单是显式数组，不复用客户端「空列表 = 全部默认」的语义。
- 未知 / 退役 id 静默过滤；过滤后为空则回退内置全量，避免客户端 .first 崩溃。
- 类型错误严格报 400，内容问题记 warning 后自动兜底。
"""
from __future__ import annotations

import copy
import json
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

SCHEMA_VERSION = 1
SECTION_KEYS = ("sites", "navigation", "startup", "update")
MAX_TEXT_LEN = 20000
MAX_LIST_ITEMS = 200

_ROOT = Path(__file__).resolve().parent.parent
_CONFIG_DIR = _ROOT / "config"


def _read_json(name: str) -> dict:
    with (_CONFIG_DIR / name).open("r", encoding="utf-8") as fh:
        return json.load(fh)


CATALOG: dict = _read_json("site_catalog.json")
SEED: dict = _read_json("seed.json")

VALID_SITE_IDS: tuple[str, ...] = tuple(
    item["id"] for item in CATALOG["sites"] if not item.get("retired")
)
RETIRED_SITE_IDS: frozenset[str] = frozenset(
    item["id"] for item in CATALOG["sites"] if item.get("retired")
)
VALID_MENU_IDS: tuple[str, ...] = tuple(item["id"] for item in CATALOG["menus"])
VALID_PROMPTS: frozenset[str] = frozenset(CATALOG["updatePrompts"])
VALID_NOTICE_MODES: frozenset[str] = frozenset(CATALOG["noticeModes"])


def _id_index(ids: tuple[str, ...] | frozenset[str]) -> dict[str, str]:
    """小写 → catalog 中的原始 id。

    客户端使用驼峰 id（favoriteAreas / moviePlayback），若直接转小写比对会全部
    判为未知并被丢弃；这里只把「比对」降级为大小写无关，写回时仍用原始 id。
    """
    return {str(item).strip().lower(): item for item in ids}


VALID_SITE_BY_LOWER = _id_index(VALID_SITE_IDS)
RETIRED_SITE_BY_LOWER = _id_index(RETIRED_SITE_IDS)
VALID_MENU_BY_LOWER = _id_index(VALID_MENU_IDS)

_VERSION_RE = re.compile(r"^\d+(?:\.\d+){0,3}$")
_URL_RE = re.compile(r"^https?://[^\s]+$", re.IGNORECASE)


class ConfigError(ValueError):
    """配置不合法，服务端返回 400。"""


def now_iso() -> str:
    return datetime.now(timezone(timedelta(hours=8))).isoformat(timespec="seconds")


def seed_document() -> dict:
    """全部 managed:false 的内置兜底文档。"""
    return copy.deepcopy(SEED)


def etag_for(revision: int) -> str:
    return '"%d"' % revision


def _bool(value: Any, default: bool, field: str) -> bool:
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    raise ConfigError("%s 必须是布尔值" % field)


def _int(value: Any, default: int, low: int, high: int, field: str) -> int:
    if value is None:
        return default
    if isinstance(value, bool) or not isinstance(value, int):
        raise ConfigError("%s 必须是整数" % field)
    if not low <= value <= high:
        raise ConfigError("%s 必须在 %d~%d 之间" % (field, low, high))
    return value


def _str(value: Any, default: str, field: str, limit: int = 200) -> str:
    if value is None:
        return default
    if not isinstance(value, str):
        raise ConfigError("%s 必须是字符串" % field)
    return value.strip()[:limit]


def _str_list(value: Any, field: str) -> list[str] | None:
    """None 表示「未提供」，调用方保留 seed 值。"""
    if value is None:
        return None
    if not isinstance(value, list):
        raise ConfigError("%s 必须是字符串数组" % field)
    if len(value) > MAX_LIST_ITEMS:
        raise ConfigError("%s 最多 %d 项" % (field, MAX_LIST_ITEMS))
    if any(not isinstance(item, str) for item in value):
        raise ConfigError("%s 必须是字符串数组" % field)
    return [item.strip() for item in value if item.strip()]


def _i18n(value: Any, field: str) -> dict[str, str]:
    if value is None:
        return {}
    if not isinstance(value, dict):
        raise ConfigError("%s 必须是 {locale: text} 对象" % field)
    result: dict[str, str] = {}
    for key, text in value.items():
        if isinstance(key, str) and isinstance(text, str):
            result[key.strip()[:16]] = text[:MAX_TEXT_LEN]
    return result


def _enum(value: Any, default: str, allowed: frozenset[str], field: str) -> str:
    if value is None:
        return default
    if not isinstance(value, str) or value not in allowed:
        raise ConfigError("%s 必须是 %s 之一" % (field, "/".join(sorted(allowed))))
    return value


def _urls(value: Any, field: str) -> list[str]:
    items = _str_list(value, field)
    if items is None:
        return []
    return [item for item in items if _URL_RE.match(item)][:50]


def _filter_ids(raw: list[str] | None, valid: dict[str, str], seed: list[str],
                field: str, warnings: list[str]) -> list[str]:
    if raw is None:
        return list(seed)
    result: list[str] = []
    seen: set[str] = set()
    for item in raw:
        key = item.strip().lower()
        if key in RETIRED_SITE_BY_LOWER:
            warnings.append("%s: 忽略退役站点 %s" % (field, key))
            continue
        canonical = valid.get(key)
        if canonical is None:
            warnings.append("%s: 忽略未知 id %s" % (field, key))
            continue
        if key in seen:
            continue
        seen.add(key)
        result.append(canonical)
    if not result:
        warnings.append("%s: 白名单为空，回退内置全量（防止客户端 .first 崩溃）" % field)
        return list(seed)
    return result


def normalize_sites(part: dict, warnings: list[str]) -> dict:
    base = copy.deepcopy(SEED["sections"]["sites"])
    base["managed"] = _bool(part.get("managed"), False, "sites.managed")
    policy = _str(part.get("policy"), "whitelist", "sites.policy", 32)
    if policy != "whitelist":
        warnings.append("sites.policy: v1 仅支持 whitelist，已回退")
        policy = "whitelist"
    base["policy"] = policy
    base["enabledSiteIds"] = _filter_ids(
        _str_list(part.get("enabledSiteIds"), "sites.enabledSiteIds"),
        VALID_SITE_BY_LOWER, base["enabledSiteIds"],
        "sites.enabledSiteIds", warnings,
    )
    return base


def normalize_navigation(part: dict, warnings: list[str]) -> dict:
    base = copy.deepcopy(SEED["sections"]["navigation"])
    base["managed"] = _bool(part.get("managed"), False, "navigation.managed")
    base["railMenuIds"] = _filter_ids(
        _str_list(part.get("railMenuIds"), "navigation.railMenuIds"),
        VALID_MENU_BY_LOWER, base["railMenuIds"],
        "navigation.railMenuIds", warnings,
    )
    base["sidebarExpanded"] = _bool(
        part.get("sidebarExpanded"), base["sidebarExpanded"], "navigation.sidebarExpanded")
    base["homeKeepAlive"] = _bool(
        part.get("homeKeepAlive"), base["homeKeepAlive"], "navigation.homeKeepAlive")

    # P1 预留节：v1 只允许隐藏已有条目，不允许新增。
    settings_part = part.get("settings")
    if isinstance(settings_part, dict):
        settings = copy.deepcopy(base["settings"])
        settings["managed"] = _bool(
            settings_part.get("managed"), False, "navigation.settings.managed")
        paths = _str_list(settings_part.get("enabledEntryPaths"),
                          "navigation.settings.enabledEntryPaths")
        if paths is not None:
            settings["enabledEntryPaths"] = paths[:200]
        base["settings"] = settings
    elif settings_part is not None:
        raise ConfigError("navigation.settings 必须是对象")
    return base


def normalize_startup(part: dict, warnings: list[str]) -> dict:
    base = copy.deepcopy(SEED["sections"]["startup"])
    base["managed"] = _bool(part.get("managed"), False, "startup.managed")

    agreement = part.get("agreement")
    if isinstance(agreement, dict):
        target = copy.deepcopy(base["agreement"])
        target["enabled"] = _bool(agreement.get("enabled"), target["enabled"],
                                  "startup.agreement.enabled")
        target["requiredVersion"] = _int(agreement.get("requiredVersion"),
                                         target["requiredVersion"], 0, 100000,
                                         "startup.agreement.requiredVersion")
        if "titleI18n" in agreement:
            target["titleI18n"] = _i18n(agreement["titleI18n"], "startup.agreement.titleI18n")
        if "bodyI18n" in agreement:
            target["bodyI18n"] = _i18n(agreement["bodyI18n"], "startup.agreement.bodyI18n")
        base["agreement"] = target
    elif agreement is not None:
        raise ConfigError("startup.agreement 必须是对象")

    notice = part.get("notice")
    if isinstance(notice, dict):
        target = copy.deepcopy(base["notice"])
        target["enabled"] = _bool(notice.get("enabled"), target["enabled"],
                                  "startup.notice.enabled")
        target["mode"] = _enum(notice.get("mode"), target["mode"], VALID_NOTICE_MODES,
                               "startup.notice.mode")
        target["dismissible"] = _bool(notice.get("dismissible"), True,
                                      "startup.notice.dismissible")
        if "titleI18n" in notice:
            target["titleI18n"] = _i18n(notice["titleI18n"], "startup.notice.titleI18n")
        if "bodyI18n" in notice:
            target["bodyI18n"] = _i18n(notice["bodyI18n"], "startup.notice.bodyI18n")
        base["notice"] = target
    elif notice is not None:
        raise ConfigError("startup.notice 必须是对象")

    base["showSplashPage"] = _bool(part.get("showSplashPage"), base["showSplashPage"],
                                   "startup.showSplashPage")
    if base["notice"]["enabled"] and not base["notice"]["dismissible"]:
        warnings.append("startup.notice: 不可关闭公告有阻断主界面风险，请复核")
    return base


def normalize_update(part: dict, warnings: list[str]) -> dict:
    base = copy.deepcopy(SEED["sections"]["update"])
    base["managed"] = _bool(part.get("managed"), False, "update.managed")
    base["autoCheck"] = _bool(part.get("autoCheck"), base["autoCheck"], "update.autoCheck")
    base["checkIntervalHours"] = _int(part.get("checkIntervalHours"),
                                      base["checkIntervalHours"], 0, 8760,
                                      "update.checkIntervalHours")
    base["prompt"] = _enum(part.get("prompt"), base["prompt"], VALID_PROMPTS,
                           "update.prompt")
    version = _str(part.get("minSupportedVersion"), "", "update.minSupportedVersion", 32)
    if version and not _VERSION_RE.match(version):
        raise ConfigError("update.minSupportedVersion 格式应为 3.0.7 这样的数字点分版本")
    base["minSupportedVersion"] = version
    base["allowPrerelease"] = _bool(part.get("allowPrerelease"), base["allowPrerelease"],
                                    "update.allowPrerelease")
    base["allowUserOverride"] = _bool(part.get("allowUserOverride"),
                                      base["allowUserOverride"], "update.allowUserOverride")
    mirrors = _urls(part.get("mirrorUrls"), "update.mirrorUrls")
    base["mirrorUrls"] = mirrors
    if "changelogI18n" in part:
        base["changelogI18n"] = _i18n(part["changelogI18n"], "update.changelogI18n")
    if base["prompt"] == "force":
        warnings.append("update.prompt=force 会阻断旧版本使用，请确认已配置可用下载地址")
    return base


_NORMALIZERS = {
    "sites": normalize_sites,
    "navigation": normalize_navigation,
    "startup": normalize_startup,
    "update": normalize_update,
}


def normalize_sections(raw: Any) -> tuple[dict, list[str]]:
    """把请求里的 sections 规范化为完整文档节，返回 (sections, warnings)。"""
    if not isinstance(raw, dict):
        raise ConfigError("sections 必须是对象")
    warnings: list[str] = []
    sections = copy.deepcopy(SEED["sections"])
    unknown = [key for key in raw if key not in SECTION_KEYS]
    if unknown:
        warnings.append("忽略未知节: %s" % ", ".join(sorted(unknown)))
    for key in SECTION_KEYS:
        part = raw.get(key)
        if part is None:
            continue
        if not isinstance(part, dict):
            raise ConfigError("%s 必须是对象" % key)
        sections[key] = _NORMALIZERS[key](part, warnings)
    return sections, warnings


def build_document(sections: dict, revision: int, updated_at: str | None = None) -> dict:
    return {
        "schemaVersion": SCHEMA_VERSION,
        "revision": revision,
        "updatedAt": updated_at or now_iso(),
        "sections": sections,
    }


def normalize_document(raw: Any) -> tuple[dict, list[str]]:
    """校验整份配置文档（用于导入 / 快照自检）。"""
    if not isinstance(raw, dict):
        raise ConfigError("配置文档必须是对象")
    version = raw.get("schemaVersion")
    if version != SCHEMA_VERSION:
        raise ConfigError("不支持的 schemaVersion: %r（当前 %d）" % (version, SCHEMA_VERSION))
    sections, warnings = normalize_sections(raw.get("sections"))
    revision = raw.get("revision", 0)
    if isinstance(revision, bool) or not isinstance(revision, int) or revision < 0:
        raise ConfigError("revision 必须是非负整数")
    return build_document(sections, revision, raw.get("updatedAt")), warnings
