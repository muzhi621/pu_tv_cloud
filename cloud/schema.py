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
SECTION_KEYS = ("sites", "navigation", "startup", "update", "iptv")
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

# 一级导航块（IPTV / 影音 / 直播 / 设置）；二级项沿用菜单 id 或字面量 'settings'。
# children 用「原始大小写」精确比对（与 contract.js 的 VALID_CHILD_IDS 一致）。
VALID_GROUP_IDS: frozenset[str] = frozenset({"iptv", "vod", "live", "settings"})
VALID_CHILD_IDS: frozenset[str] = frozenset(VALID_MENU_IDS) | {"settings"}
MAX_NAV_GROUPS = 8
MAX_NAV_CHILDREN = 30
MAX_NAV_LABEL_LEN = 32
MAX_NAV_ICON_LEN = 64

_VERSION_RE = re.compile(r"^\d+(?:\.\d+){0,3}$")
_URL_RE = re.compile(r"^https?://[^\s]+$", re.IGNORECASE)
_IPTV_URL_RE = re.compile(r"^(https?|rtmp|rtsp|udp|mms|p2p)://[^\s]+$", re.IGNORECASE)
MAX_IPTV_CHANNELS = 3000
MAX_DOCUMENT_BYTES = 900 * 1024
# 套餐库上限：套餐里的频道是「频道库」，只在 GET 时展开到 channels，不重复存两份。
# MAX_IPTV_PACKAGES 同时是 selectedPackageIds 上限；MAX_PACKAGE_CHANNELS_TOTAL 是
# 所有套餐频道数之和的硬上限，用于稳在 MAX_DOCUMENT_BYTES=900KB 内。
MAX_IPTV_PACKAGES = 12
MAX_PACKAGE_CHANNELS_TOTAL = 5000
MAX_PACKAGE_SOURCES = 20
MAX_PACKAGE_ID_LEN = 64
MAX_PACKAGE_NAME_LEN = 64
_PACKAGE_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,%d}$" % MAX_PACKAGE_ID_LEN)


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

    # 一级导航块 + 二级菜单：选中某个块后右侧展开它的 children。
    # 结构与客户端内置默认分组一致；未提供时沿用 seed，保证旧配置平滑升级。
    groups = part.get("groups")
    if groups is not None:
        if not isinstance(groups, list):
            raise ConfigError("navigation.groups 必须是数组")
        if len(groups) > MAX_NAV_GROUPS:
            warnings.append("navigation.groups: 超过 %d 个上限，已截断" % MAX_NAV_GROUPS)
        seen_groups: set[str] = set()
        normalized: list[dict] = []
        for item in groups[:MAX_NAV_GROUPS]:
            if not isinstance(item, dict):
                continue
            gid = str(item.get("id") or "").strip().lower()
            if gid not in VALID_GROUP_IDS or gid in seen_groups:
                warnings.append("navigation.groups: 忽略非法或重复的一级块 %s" % gid)
                continue
            children = _str_list(item.get("children"),
                                 "navigation.groups[%s].children" % gid) or []
            valid_children: list[str] = []
            seen_children: set[str] = set()
            for child in children:
                if child not in VALID_CHILD_IDS:
                    warnings.append("navigation.groups[%s]: 忽略未知二级项 %s"
                                    % (gid, child))
                    continue
                if child in seen_children:
                    continue
                seen_children.add(child)
                valid_children.append(child)
                if len(valid_children) >= MAX_NAV_CHILDREN:
                    break
            seen_groups.add(gid)
            normalized.append({
                "id": gid,
                "label": _str(item.get("label"), gid,
                              "navigation.groups[%s].label" % gid, MAX_NAV_LABEL_LEN),
                "icon": _str(item.get("icon"), "",
                             "navigation.groups[%s].icon" % gid, MAX_NAV_ICON_LEN),
                "children": valid_children[:MAX_NAV_CHILDREN],
            })
        if not normalized:
            warnings.append("navigation.groups: 全部非法，已回退内置默认分组")
            normalized = copy.deepcopy(SEED["sections"]["navigation"]["groups"])
        base["groups"] = normalized

    default_group = part.get("defaultGroupId")
    if default_group is not None:
        wanted = _str(default_group, "", "navigation.defaultGroupId", 32).lower()
        if any(group["id"] == wanted for group in base["groups"]):
            base["defaultGroupId"] = wanted
        else:
            warnings.append("navigation.defaultGroupId: %s 不在分组里，已回退 %s"
                            % (wanted, base["defaultGroupId"]))

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

    # 退出 App 时的告别/确认弹窗，与开机公告对称，由云端下发。
    # enabled=false 表示不接管，终端沿用本地写死的原弹窗，保证升级平滑。
    # 统一用 .get() 取值，未知字段忽略，不假设任何键一定存在。
    exit_dialog = part.get("exitDialog")
    if isinstance(exit_dialog, dict):
        target = copy.deepcopy(base.get("exitDialog") or {})
        target["enabled"] = _bool(exit_dialog.get("enabled"),
                                  target.get("enabled", False),
                                  "startup.exitDialog.enabled")
        target["mode"] = _enum(exit_dialog.get("mode"), target.get("mode", "always"),
                               VALID_NOTICE_MODES, "startup.exitDialog.mode")
        target["dismissible"] = _bool(exit_dialog.get("dismissible"),
                                      target.get("dismissible", True),
                                      "startup.exitDialog.dismissible")
        target["showDonate"] = _bool(exit_dialog.get("showDonate"),
                                     target.get("showDonate", True),
                                     "startup.exitDialog.showDonate")
        if "titleI18n" in exit_dialog:
            target["titleI18n"] = _i18n(exit_dialog["titleI18n"],
                                        "startup.exitDialog.titleI18n")
        else:
            target.setdefault("titleI18n", {})
        if "bodyI18n" in exit_dialog:
            target["bodyI18n"] = _i18n(exit_dialog["bodyI18n"],
                                       "startup.exitDialog.bodyI18n")
        else:
            target.setdefault("bodyI18n", {})
        base["exitDialog"] = target
    elif exit_dialog is not None:
        raise ConfigError("startup.exitDialog 必须是对象")

    base["showSplashPage"] = _bool(part.get("showSplashPage"), base["showSplashPage"],
                                   "startup.showSplashPage")
    if base["notice"]["enabled"] and not base["notice"]["dismissible"]:
        warnings.append("startup.notice: 不可关闭公告有阻断主界面风险，请复核")
    exit_cfg = base.get("exitDialog") or {}
    if exit_cfg.get("enabled") and not exit_cfg.get("dismissible", True):
        warnings.append("startup.exitDialog: 不可取消的退出弹窗会让用户无法留在 App，请复核")
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



def _normalize_channels(raw: Any, field: str, warnings: list[str]) -> list[dict] | None:
    """规范化频道列表；raw 为 None 表示未提供，调用方保留 seed 值。

    顶层 iptv.channels、packages[].channels 与 GET 展开共用同一套规则：
    URL 协议白名单、按 URL 小写去重、字段长度截断、MAX_IPTV_CHANNELS 上限。
    """
    if raw is None:
        return None
    if not isinstance(raw, list):
        raise ConfigError("%s 必须是数组" % field)
    seen: set[str] = set()
    channels: list[dict] = []
    truncated = False
    for item in raw:
        if not isinstance(item, dict):
            continue
        name = str(item.get("name") or "").strip()[:120]
        url = str(item.get("url") or "").strip()[:1000]
        if not name or not _IPTV_URL_RE.match(url):
            continue
        key = url.lower()
        if key in seen:
            continue
        seen.add(key)
        channels.append({
            "name": name,
            "url": url,
            "group": str(item.get("group") or "").strip()[:64],
            "logo": str(item.get("logo") or "").strip()[:300],
        })
        if len(channels) >= MAX_IPTV_CHANNELS:
            truncated = True
            break
    if truncated:
        warnings.append("%s: 超过 %d 条上限，已截断" % (field, MAX_IPTV_CHANNELS))
    return channels


def _normalize_packages(raw: Any, warnings: list[str]) -> list[dict] | None:
    """规范化套餐库；raw 为 None 表示未提供，调用方保留 seed 值。"""
    if raw is None:
        return None
    if not isinstance(raw, list):
        raise ConfigError("iptv.packages 必须是数组")
    if len(raw) > MAX_IPTV_PACKAGES:
        warnings.append("iptv.packages: 超过 %d 个上限，已截断" % MAX_IPTV_PACKAGES)
    packages: list[dict] = []
    seen_ids: set[str] = set()
    total_channels = 0
    for index, item in enumerate(raw[:MAX_IPTV_PACKAGES]):
        if not isinstance(item, dict):
            continue
        field = "iptv.packages[%d]" % index
        pkg_id = str(item.get("id") or "").strip()
        if not _PACKAGE_ID_RE.match(pkg_id):
            warnings.append("%s: 非法 id %r，已忽略套餐" % (field, pkg_id))
            continue
        if pkg_id in seen_ids:
            warnings.append("%s: 重复 id %r，已忽略套餐" % (field, pkg_id))
            continue
        # 所有套餐频道数之和的硬上限：按剩余额度截断，避免整份文档撑爆 900KB。
        room = MAX_PACKAGE_CHANNELS_TOTAL - total_channels
        if room <= 0:
            warnings.append("iptv.packages: 频道总数达到 %d 上限，已截断"
                            % MAX_PACKAGE_CHANNELS_TOTAL)
            break
        channels = _normalize_channels(item.get("channels") or [],
                                       field + ".channels", warnings)[:room]
        sources = _str_list(item.get("sources"), field + ".sources")
        if sources is None:
            pkg_sources: list[str] = []
        else:
            pkg_sources = [src for src in sources if _URL_RE.match(src)][:MAX_PACKAGE_SOURCES]
            if len(pkg_sources) < len(sources):
                warnings.append("%s.sources: 已忽略非 http(s) 地址" % field)
        total_channels += len(channels)
        seen_ids.add(pkg_id)
        packages.append({
            "id": pkg_id,
            "name": _str(item.get("name"), pkg_id, field + ".name", MAX_PACKAGE_NAME_LEN),
            "sources": pkg_sources,
            "channels": channels,
        })
    return packages


def normalize_iptv(part: dict, warnings: list[str]) -> dict:
    """IPTV 源节：编辑器解析 M3U/TXT 后写入精简频道列表，云端只校验与下发。"""
    base = copy.deepcopy(SEED["sections"]["iptv"])
    base["managed"] = _bool(part.get("managed"), False, "iptv.managed")

    epg = _str(part.get("epgUrl"), "", "iptv.epgUrl", 500)
    base["epgUrl"] = epg if epg and _URL_RE.match(epg) else ""
    if epg and not base["epgUrl"]:
        warnings.append("iptv.epgUrl: 仅支持 http(s)，已忽略")

    sources = _str_list(part.get("sources"), "iptv.sources")
    if sources is not None:
        base["sources"] = [item for item in sources if _URL_RE.match(item)][:20]
        if len(base["sources"]) < len(sources):
            warnings.append("iptv.sources: 已忽略非 http(s) 地址")

    groups = _str_list(part.get("groups"), "iptv.groups")
    if groups is not None:
        base["groups"] = groups[:MAX_LIST_ITEMS]

    # 顶层 channels 与 packages[].channels 共用同一套校验规则。
    channels = _normalize_channels(part.get("channels"), "iptv.channels", warnings)
    if channels is not None:
        base["channels"] = channels

    packages = _normalize_packages(part.get("packages"), warnings)
    if packages is not None:
        base["packages"] = packages

    selected = _str_list(part.get("selectedPackageIds"), "iptv.selectedPackageIds")
    if selected is not None:
        valid_ids = {pkg["id"] for pkg in base["packages"]}
        kept: list[str] = []
        seen: set[str] = set()
        for pid in selected:
            if pid not in valid_ids:
                warnings.append("iptv.selectedPackageIds: 忽略未知套餐 id %s" % pid)
                continue
            if pid in seen:
                continue
            seen.add(pid)
            kept.append(pid)
            if len(kept) >= MAX_IPTV_PACKAGES:
                break
        base["selectedPackageIds"] = kept

    # 约定：选中套餐时，频道只在 packages 里存一份；服务端 GET /api/config 会
    # 调用 expand_iptv_channels() 按套餐动态展开到 channels，避免存储两份重复频道。
    # selectedPackageIds 为空时顶层 channels 保持原有行为，兼容旧配置。
    if base["selectedPackageIds"]:
        base["channels"] = []
    return base


def expand_iptv_channels(sections: dict) -> dict:
    """按选中套餐展开 iptv.channels（供 API 层 GET /api/config 调用）。

    深拷贝入参后返回，不污染调用方。selectedPackageIds 为空时原样返回；非空时
    按 selectedPackageIds 的顺序把对应套餐的 channels 合并，复用同一套频道校验
    规则（协议白名单、按 URL 小写去重、字段截断、MAX_IPTV_CHANNELS 上限）后写入
    iptv.channels，并把 iptv.groups 重算成合并结果里出现的分组（保序去重）。

    注意：packages 在存储态保留完整 channels；GET 视图是否把套餐剥成摘要是
    API/视图层的优化，不属于本契约字段。
    """
    result = copy.deepcopy(sections)
    iptv = result.get("iptv")
    if not isinstance(iptv, dict):
        return result
    selected = iptv.get("selectedPackageIds")
    if not isinstance(selected, list) or not selected:
        return result
    packages = iptv.get("packages")
    if not isinstance(packages, list):
        packages = []
    by_id: dict[str, dict] = {}
    for pkg in packages:
        if isinstance(pkg, dict) and isinstance(pkg.get("id"), str):
            by_id.setdefault(pkg["id"], pkg)
    merged: list[Any] = []
    for pid in selected:
        pkg = by_id.get(pid) if isinstance(pid, str) else None
        if not isinstance(pkg, dict):
            continue
        chans = pkg.get("channels")
        if isinstance(chans, list):
            merged.extend(chans)
    iptv["channels"] = _normalize_channels(merged, "iptv.channels(expand)", [])
    groups: list[str] = []
    seen_groups: set[str] = set()
    for channel in iptv["channels"]:
        group = channel.get("group") or ""
        if not group or group in seen_groups:
            continue
        seen_groups.add(group)
        groups.append(group)
        if len(groups) >= MAX_LIST_ITEMS:
            break
    iptv["groups"] = groups
    return result


_NORMALIZERS = {
    "sites": normalize_sites,
    "navigation": normalize_navigation,
    "startup": normalize_startup,
    "update": normalize_update,
    "iptv": normalize_iptv,
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
