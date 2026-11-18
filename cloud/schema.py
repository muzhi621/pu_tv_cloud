"""云端配置契约：校验、规范化与兜底。

对应《SUTV · 云端配置下发需求文档 v1.0》第 4 章。
只依赖标准库，便于直接部署在阿里云 FC Python 运行时。

设计原则：
- 每个节带 managed，未接管时客户端完全忽略该节。
- 白名单是显式数组，不复用客户端「空列表 = 全部默认」的语义。
- 未知 / 退役 id 静默过滤；过滤后为空则回退内置全量，避免客户端 .first 崩溃。
- 类型错误严格报 400，内容问题记 warning 后自动兜底。
- 设备文档只存「全局资源库」的 id 引用（iptv.packageIds / vod.sourceIds /
  vod.siteIds），频道与站点在库里只存一份，GET 时由 expand_iptv_channels 展开。
"""
from __future__ import annotations

import copy
import json
import random
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from urllib.parse import quote, urljoin, urlsplit, urlunsplit

SCHEMA_VERSION = 1
SECTION_KEYS = ("navigation", "startup", "update", "iptv", "vod")
MAX_TEXT_LEN = 20000
MAX_LIST_ITEMS = 200

_ROOT = Path(__file__).resolve().parent.parent
_CONFIG_DIR = _ROOT / "config"


def _read_json(name: str) -> dict:
    with (_CONFIG_DIR / name).open("r", encoding="utf-8") as fh:
        return json.load(fh)


CATALOG: dict = _read_json("site_catalog.json")
SEED: dict = _read_json("seed.json")

VALID_MENU_IDS: tuple[str, ...] = tuple(item["id"] for item in CATALOG["menus"])
VALID_PROMPTS: frozenset[str] = frozenset(CATALOG["updatePrompts"])
VALID_NOTICE_MODES: frozenset[str] = frozenset(CATALOG["noticeModes"])
# 更新清单的来源：云端自建 / GitHub 直连 / GitHub 反代 / 自填地址 / 上传到云端。
# 老 catalog 没有这两个键时用内置默认值（升级期间不必强行刷 catalog）。
VALID_UPDATE_SOURCES: frozenset[str] = frozenset(
    CATALOG.get("updateSources") or ("cloud", "github", "mirror", "custom", "upload")
)
UPDATE_ABIS: tuple[str, ...] = tuple(
    CATALOG.get("updateAbis") or ("arm64-v8a", "armeabi-v7a")
)


def _id_index(ids: tuple[str, ...] | frozenset[str]) -> dict[str, str]:
    """小写 → catalog 中的原始 id。

    客户端使用驼峰 id（vodBrowse / moviePlayback），若直接转小写比对会全部
    判为未知并被丢弃；这里只把「比对」降级为大小写无关，写回时仍用原始 id。
    """
    return {str(item).strip().lower(): item for item in ids}


VALID_MENU_BY_LOWER = _id_index(VALID_MENU_IDS)

# 一级导航块（IPTV / 影音 / 设置）；二级项沿用菜单 id 或字面量 'settings'。
# children 用「原始大小写」精确比对（与 contract.js 的 VALID_CHILD_IDS 一致）。
VALID_GROUP_IDS: frozenset[str] = frozenset({"iptv", "vod", "settings"})
VALID_CHILD_IDS: frozenset[str] = frozenset(VALID_MENU_IDS) | {"settings"}
# Flutter BoxFit 常用枚举：壁纸填充方式，与客户端 BackgroundConfigModel.boxFit 对齐。
VALID_BOX_FITS: frozenset[str] = frozenset(
    {"cover", "contain", "fill", "fitWidth", "fitHeight", "none", "scaleDown"})
MAX_NAV_GROUPS = 8
MAX_NAV_CHILDREN = 30
MAX_NAV_LABEL_LEN = 32
MAX_NAV_ICON_LEN = 64

_VERSION_RE = re.compile(r"^\d+(?:\.\d+){0,3}$")
_URL_RE = re.compile(r"^https?://[^\s]+$", re.IGNORECASE)
_IPTV_URL_RE = re.compile(r"^(https?|rtmp|rtsp|udp|mms|p2p)://[^\s]+$", re.IGNORECASE)
# 请求头里出现换行就是注入：CR/LF 与其余控制字符在入库前一律剔除。
_CONTROL_CHARS_RE = re.compile(r"[\x00-\x1f\x7f]")
MAX_IPTV_CHANNELS = 3000
MAX_DOCUMENT_BYTES = 900 * 1024
# 套餐库上限：套餐里的频道是「频道库」，只在 GET 时展开到 channels，不重复存两份。
# MAX_IPTV_PACKAGES 同时是 selectedPackageIds 上限；MAX_PACKAGE_CHANNELS_TOTAL 是
# 所有套餐频道数之和的硬上限，用于稳在 MAX_DOCUMENT_BYTES=900KB 内。
MAX_IPTV_PACKAGES = 12
MAX_PACKAGE_CHANNELS_TOTAL = 5000
# 套餐两级结构「分组 → 频道」：分组是终端频道列表的一级，每组可引用一条 IPTV 源。
MAX_IPTV_GROUPS = 24
MAX_GROUP_CHANNELS = 800

MAX_IPTV_HEADER_LIMITS: tuple[tuple[str, int], ...] = (
    ("userAgent", 500),
    ("referer", 500),
    ("cookie", 2000),
)



# spider 契约流派：FongMi :catvod 与 TVBoxOS 的 Spider 基类互不兼容，
# 两套 jar 不能混用宿主。缺省按 fongmi（现有 catvod-api.jar 的契约）。
_VOD_FLAVORS = ("fongmi", "tvboxos")
_MD5_RE = re.compile(r"^[0-9a-f]{16,64}$", re.IGNORECASE)


def _percent_encode_url(url: str) -> str:
    """对 path/query 里未编码的非 ASCII 字符做 percent-encode（中文路径 400 的同类问题）。"""
    try:
        parts = urlsplit(url)
        path = quote(parts.path, safe="/%:@&=+$,;~!*'()#")
        query = quote(parts.query, safe="/%:@&=+$,;?~!*'()")
        return urlunsplit((parts.scheme, parts.netloc, path, query, parts.fragment))
    except Exception:
        return url


def resolve_vod_asset(ref: Any, base_url: str = "") -> str:
    """把 TVBox 配置里的 ./xxx、/xxx 按配置地址解析成绝对 URL。

    csp_Xxx、普通 ext 文本、已是 http(s) 的地址原样返回，避免被 urljoin
    改写成 "https://host/box/csp_Xxx"。
    """
    value = ref.strip() if isinstance(ref, str) else ""
    if not value or _URL_RE.match(value):
        return value
    if not (value.startswith("./") or value.startswith("/")):
        return value
    if not _URL_RE.match(base_url or ""):
        return value
    try:
        resolved = urljoin(base_url, value[2:] if value.startswith("./") else value)
        return _percent_encode_url(resolved)
    except Exception:
        return value


def parse_spider_field(raw: Any, base_url: str = "") -> tuple[str, str]:
    """拆 TVBox 的 spider 字段 "url;md5;hash"，返回 (jar, md5)。

    FongMi 的 BaseLoader.parseJar(spider, true) 就是这个格式。编辑器已经拆过，
    这里做防御性兼容：老数据 / 手工填写的带后缀字符串不该被整条丢掉。
    """
    text = raw.strip() if isinstance(raw, str) else ""
    if not text:
        return "", ""
    parts = [item.strip() for item in text.split(";") if item.strip()]
    jar = resolve_vod_asset(parts[0] if parts else "", base_url)
    md5 = ""
    for item in parts[1:]:
        if item.lower() == "md5":
            continue
        if _MD5_RE.match(item):
            md5 = item
            break
    return (jar if jar and _URL_RE.match(jar) else "", md5)


def _vod_flavor(value: Any) -> str:
    return value if isinstance(value, str) and value in _VOD_FLAVORS else "fongmi"


def _vod_source_mode(value: Any) -> str:
    """TVBox 源下发模式：parsed（云端展开站点，默认）| url（终端自己拉配置）。"""
    return "url" if value == "url" else "parsed"
MAX_PACKAGE_SOURCES = 20
MAX_PACKAGE_ID_LEN = 64
MAX_PACKAGE_NAME_LEN = 64
_PACKAGE_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,%d}$" % MAX_PACKAGE_ID_LEN)

# ---------------- 全局资源库（与设备文档解耦） ----------------
# 库独立存在 library_current，设备只保存 id 引用：
#   iptv.packageIds → library.iptv.packages[].id
#   vod.sourceIds / vod.siteIds → library.vod.sources[].id / sites[].id
# 改库即可对「未锁定」的设备批量生效，设备文档也不必重复存几百 KB 频道。
LIBRARY_SCHEMA_VERSION = 1
MAX_LIBRARY_SOURCES = 30
MAX_VOD_SOURCES = 20
MAX_VOD_SITES = 500
MAX_VOD_SITES_PER_SOURCE = 200
MAX_LIBRARY_BYTES = MAX_DOCUMENT_BYTES
MAX_LIBRARY_REVISION = 1_000_000_000
# 在线更新版本：每条最多两个 APK，30 条也远低于 Blob 1 GB 额度。
MAX_LIBRARY_UPDATES = 30
# 单个 APK 上限 200 MB：再大就不是手机安装包了，也是防误传的兜底。
MAX_APK_BYTES = 200 * 1024 * 1024
# 库内 id 由编辑器生成，格式固定，便于设备侧引用时做正则校验。
_LIB_SOURCE_ID_RE = re.compile(r"^s_[0-9a-f]{8}$")
_LIB_PACKAGE_ID_RE = re.compile(r"^pkg_[0-9a-f]{8}$")
# 分组来源可指向同一资源库里的频道套餐：pkgref:pkg_xxxxxxxx。
_LIB_PKG_REF_PREFIX = "pkgref:"
_LIB_PKG_REF_RE = re.compile(r"^pkgref:pkg_[0-9a-f]{8}$")
# 套餐分组 id，与 contract.js 的 GROUP_ID_RE 对齐。
_GROUP_ID_RE = re.compile(r"^g_[0-9a-f]{8}$")
_LIB_VOD_SOURCE_ID_RE = re.compile(r"^vs_[0-9a-f]{8}$")
# 「在线更新版本」id，设备侧 sections.update.updateId 引用它。
_LIB_UPDATE_ID_RE = re.compile(r"^up_[0-9a-f]{8}$")
# 上传 APK 的 Blob key 由服务端生成，不接受客户端自定义：它会拼进对象存储的
# 键路径，放开格式等于把键空间交给不可信输入（`../` 之类）。
_APK_KEY_RE = re.compile(r"^apk/[0-9a-f]{16}/(arm64-v8a|armeabi-v7a)\.apk$")
# TVBox 站点 id = `${sourceId}:${key}`，会作为设备 vod.siteIds 的引用值。
_VOD_SITE_ID_RE = re.compile(r"^[A-Za-z0-9_:-]{1,96}$")

# vod（TVBox 源/站点）节默认值：seed.json 里没有这一节，老文档读出时按此补齐。
# 与 Edge Functions 版 contract.js 的 DEFAULT_VOD 保持一致。
DEFAULT_VOD: dict = {
    "managed": False,
    "sourceIds": [],
    "siteIds": [],
    # 打开影音时默认选中的站点 id；只是首屏选谁，不是白名单（白名单是 siteIds）。
    "defaultSiteId": "",
    # 展开产物 / 锁定快照载体，与 contract.js 的 DEFAULT_VOD 对齐。
    "sources": [],
    "sites": [],
    "lockLibrary": False,
    "libraryRevision": 0,
}


class ConfigError(ValueError):
    """配置不合法，服务端返回 400。"""


def now_iso() -> str:
    return datetime.now(timezone(timedelta(hours=8))).isoformat(timespec="seconds")


def seed_document() -> dict:
    """全部 managed:false 的内置兜底文档（含 seed.json 里没有的 vod 节）。"""
    document = copy.deepcopy(SEED)
    ensure_section_defaults(document["sections"])
    return document


def ensure_section_defaults(sections: dict) -> dict:
    """补齐老文档缺少的节与字段（vod 节、iptv.packageIds / lockLibrary 等）。

    与 Edge Functions 版 ensureSectionDefaults 对齐：读出来的文档结构永远完整，
    客户端与编辑器不必判空。**就地修改**，调用方需自行保证传入的是副本。
    """
    if not isinstance(sections, dict):
        return sections
    vod = sections.get("vod")
    if not isinstance(vod, dict):
        sections["vod"] = copy.deepcopy(DEFAULT_VOD)
    iptv = sections.get("iptv")
    if isinstance(iptv, dict):
        if not isinstance(iptv.get("packageIds"), list):
            iptv["packageIds"] = []
        if not isinstance(iptv.get("selectedPackageIds"), list):
            iptv["selectedPackageIds"] = []
        if not isinstance(iptv.get("lockLibrary"), bool):
            iptv["lockLibrary"] = False
        revision = iptv.get("libraryRevision")
        if isinstance(revision, bool) or not isinstance(revision, int) or revision < 0:
            iptv["libraryRevision"] = 0
        # v1.2：请求头改由云端下发。老文档没有这一段，补空对象让编辑器有落点；
        # 空字符串表示「不下发自定义头」，终端此时保留自己的值。
        headers = iptv.get("requestHeaders")
        if not isinstance(headers, dict):
            iptv["requestHeaders"] = {"userAgent": "", "referer": "", "cookie": ""}
        else:
            for key, limit in MAX_IPTV_HEADER_LIMITS:
                if not isinstance(headers.get(key), str):
                    headers[key] = ""
                else:
                    headers[key] = _CONTROL_CHARS_RE.sub("", headers[key]).strip()[:limit]
    return sections


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


def _string_array(value: Any, field: str, limit: int) -> list[str] | None:
    """定长上限的字符串数组（vod.siteIds 需要 500 项，超出 _str_list 的 200）。

    None 表示「未提供」，调用方保留默认值；超限静默截断，由调用方决定是否告警。
    """
    if value is None:
        return None
    if not isinstance(value, list):
        raise ConfigError("%s 必须是字符串数组" % field)
    if any(not isinstance(item, str) for item in value):
        raise ConfigError("%s 必须是字符串数组" % field)
    return [item.strip() for item in value if item.strip()][:limit]


def _lenient_int(value: Any, default: int, low: int, high: int) -> int:
    """TVBox 配置里的开关五花八门（0/1、true/false、"1"），库导入时做宽松归一。

    一个布尔值不应该让整库保存失败，因此这里不抛 ConfigError，只夹到区间。
    """
    if value is None or value == "":
        return default
    if isinstance(value, bool):
        return 1 if value else 0
    if isinstance(value, int):
        return max(low, min(high, value))
    try:
        number = float(str(value).strip())
    except (TypeError, ValueError):
        return default
    if not number.is_integer():
        return default
    return max(low, min(high, int(number)))


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

    # 首页壁纸（全局背景）：云端上传图片后下发绝对 http(s) 地址。
    # enabled=false 时终端零影响；地址必须是 http(s)，防止 javascript:/data: 注入。
    wallpaper_part = part.get("wallpaper")
    if isinstance(wallpaper_part, dict):
        wallpaper = copy.deepcopy(base["wallpaper"])
        wallpaper["enabled"] = _bool(
            wallpaper_part.get("enabled"), False, "navigation.wallpaper.enabled")
        image_url = _str(wallpaper_part.get("imageUrl"), "",
                         "navigation.wallpaper.imageUrl", 512)
        if image_url and not image_url.lower().startswith(("http://", "https://")):
            raise ConfigError("navigation.wallpaper.imageUrl 必须是 http(s) 图片地址")
        wallpaper["imageUrl"] = image_url
        wallpaper["boxFit"] = _enum(
            wallpaper_part.get("boxFit"), "cover", VALID_BOX_FITS,
            "navigation.wallpaper.boxFit")
        wallpaper["blurSigma"] = _int(
            wallpaper_part.get("blurSigma"), 0, 0, 60,
            "navigation.wallpaper.blurSigma")
        wallpaper["maskOpacityPercent"] = _int(
            wallpaper_part.get("maskOpacityPercent"), 35, 0, 100,
            "navigation.wallpaper.maskOpacityPercent")
        base["wallpaper"] = wallpaper
    elif wallpaper_part is not None:
        raise ConfigError("navigation.wallpaper 必须是对象")
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
        # 二维码与捐赠文案同样云端化：换图 / 换文案不必重新发版。
        qr_url = str(exit_dialog.get("qrImageUrl") or target.get("qrImageUrl") or "").strip()
        if len(qr_url) > 512:
            raise ConfigError("startup.exitDialog.qrImageUrl 超过 512 字符")
        if qr_url and not re.match(r"^https?://", qr_url, re.I):
            raise ConfigError("startup.exitDialog.qrImageUrl 必须是 http(s) 图片地址")
        target["qrImageUrl"] = qr_url
        for key in ("qrCaptionI18n", "donateBodyI18n", "confirmTextI18n", "cancelTextI18n"):
            if key in exit_dialog:
                target[key] = _i18n(exit_dialog[key], "startup.exitDialog.%s" % key)
            else:
                target.setdefault(key, {})
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
    # 套餐指定的「目标版本」：资源库里挑一条在线更新版本，保存套餐时展开写在这里。
    # 填了它终端就不必再问云端清单——配置本身就说明了该升到哪一版、从哪下载，
    # 这也是「按套餐分配不同固件」的实现方式。留空则维持原来的「查云端清单」。
    pinned = _str(part.get("version"), "", "update.version", 32)
    if pinned and not _VERSION_RE.match(pinned):
        raise ConfigError("update.version 格式应为 3.0.43 这样的数字点分版本")
    base["version"] = pinned
    base["versionNum"] = (_lenient_int(part.get("versionNum"), _flatten_version(pinned),
                                       0, 99999999) if pinned else 0)
    base["versionDesc"] = _str(part.get("versionDesc"), "", "update.versionDesc", 2000)
    # 引用来源，仅供编辑器回显「当前选的是哪条版本」；终端不读它。
    update_id = _str(part.get("updateId"), "", "update.updateId", 40)
    base["updateId"] = update_id if _LIB_UPDATE_ID_RE.match(update_id) else ""
    base["allowPrerelease"] = _bool(part.get("allowPrerelease"), base["allowPrerelease"],
                                    "update.allowPrerelease")
    base["allowUserOverride"] = _bool(part.get("allowUserOverride"),
                                      base["allowUserOverride"], "update.allowUserOverride")
    # 更新清单的来源。终端据此决定「清单从哪取」：
    #   cloud  → 云端 /api/update（默认，代取 GitHub，国内可达）
    #   github → 直连 api.github.com（海外网络或自备出口时用）
    #   mirror → 自填 GitHub 反代前缀 + API
    #   custom → 完全自填的清单地址（自建服务、对象存储都行）
    #   upload → 编辑器把清单上传到云端，终端读 /api/update/manifest
    base["source"] = _enum(part.get("source"), base["source"], VALID_UPDATE_SOURCES,
                           "update.source")
    # 清单端点。留空 = 终端用「配置域名 + /api/update」。显式填了就用它：
    # 换域名、或把清单挪到另一台机器时，老终端还能靠这一条配置迁移过去，
    # 不用等他们先装上新包。
    manifest = _str(part.get("manifestUrl"), "", "update.manifestUrl", 300)
    if manifest and not _URL_RE.match(manifest):
        raise ConfigError("update.manifestUrl 必须是 http(s) 完整地址")
    base["manifestUrl"] = manifest
    prefix = _str(part.get("mirrorPrefix"), "", "update.mirrorPrefix", 200)
    if prefix:
        if not _URL_RE.match(prefix):
            raise ConfigError("update.mirrorPrefix 必须是 http(s) 前缀")
        # 终端是 `前缀 + github 地址` 直接拼，少了斜杠会拼出坏地址。
        if not prefix.endswith("/"):
            prefix += "/"
    base["mirrorPrefix"] = prefix
    # 按 ABI 的直链。留空 = 用清单里的 release 资产；填了就以它为准
    # （自建 CDN / 网盘镜像装这两个包时用，不再依赖 GitHub 域名）。
    downloads = part.get("downloads")
    clean_downloads = dict.fromkeys(UPDATE_ABIS, "")
    if downloads is not None:
        if not isinstance(downloads, dict):
            raise ConfigError("update.downloads 必须是对象")
        for abi in UPDATE_ABIS:
            value = _str(downloads.get(abi), "", "update.downloads.%s" % abi, 500)
            if value and not _URL_RE.match(value):
                raise ConfigError("update.downloads.%s 必须是 http(s) 完整地址" % abi)
            clean_downloads[abi] = value
    base["downloads"] = clean_downloads
    mirrors = _urls(part.get("mirrorUrls"), "update.mirrorUrls")
    base["mirrorUrls"] = mirrors
    if "changelogI18n" in part:
        base["changelogI18n"] = _i18n(part["changelogI18n"], "update.changelogI18n")
    if base["prompt"] == "force":
        warnings.append("update.prompt=force 会阻断旧版本使用，请确认已配置可用下载地址")
    # 套餐指定了目标版本却没给下载地址：终端会显示「有新版本」却下不动。
    # 必须放在 downloads 赋值之后判断，否则读到的是 seed 的默认值。
    if base["version"] and not any(base["downloads"].values()):
        warnings.append("update.version=%s 但没有任何架构的下载地址，终端会提示有新版却下不动"
                        % base["version"])
    # 配置互相矛盾时给个提示，别让终端默默回落到默认通道。
    if base["source"] == "mirror" and not prefix:
        warnings.append("update.source=mirror 但未填反代前缀，终端会回落到云端清单")
    if base["source"] == "custom" and not manifest:
        warnings.append("update.source=custom 但未填清单地址，终端会回落到云端清单")
    if base["source"] == "upload" and not manifest:
        warnings.append("update.source=upload 需先上传清单文件（编辑器更新页）")
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


def package_channels(pkg: dict) -> list[dict]:
    """套餐真正会被下发的频道：有分组按分组顺序展开，否则用扁平列表（老套餐）。"""
    groups = pkg.get("groups") if isinstance(pkg.get("groups"), list) else []
    if not groups:
        raw = pkg.get("channels")
        return raw if isinstance(raw, list) else []
    out: list[dict] = []
    for group in groups:
        if not isinstance(group, dict):
            continue
        name = str(group.get("name") or "").strip()
        for channel in group.get("channels") or []:
            if not isinstance(channel, dict):
                continue
            item = dict(channel)
            item["group"] = name or str(channel.get("group") or "")
            out.append(item)
    return out


def _normalize_package_groups(raw: Any, field: str, warnings: list[str],
                              budget: int, source_ids: set[str] | None,
                              package_ids: set[str] | None = None) -> list[dict]:
    """校验并规整套餐分组（两级结构的一级）。

    - 分组 id 缺失/非法/重复就地补发，避免同一份 JSON 出现两个同 id 分组；
    - sourceId 只允许指向资源库里的源；源被删掉时保留频道、只把来源置空——
      用户要下发的是频道，删源不该顺手把套餐掏空；
    - 组内按 url 去重，并把频道的 group 强制写成分组名。
    """
    if raw is None:
        return []
    if not isinstance(raw, list):
        raise ConfigError("%s 必须是数组" % field)
    if len(raw) > MAX_IPTV_GROUPS:
        warnings.append("%s: 超过 %d 个分组上限，已截断" % (field, MAX_IPTV_GROUPS))
    groups: list[dict] = []
    taken: set[str] = set()
    total = 0
    for entry in raw[:MAX_IPTV_GROUPS]:
        if not isinstance(entry, dict):
            warnings.append("%s: 忽略非对象分组" % field)
            continue
        group_id = str(entry.get("id") or "").strip()
        if not _GROUP_ID_RE.match(group_id) or group_id in taken:
            group_id = _new_library_id("g_", taken)
        name = str(entry.get("name") or "").strip()[:32] or ("分组 %d" % (len(groups) + 1))
        source_id = str(entry.get("sourceId") or "").strip()
        pkg_ref = bool(_LIB_PKG_REF_RE.match(source_id))
        if source_id and not pkg_ref and not _LIB_SOURCE_ID_RE.match(source_id):
            warnings.append("%s[%s]: 忽略非法来源 id %s" % (field, name, source_id))
            source_id = ""
        # 套餐引用只在库级校验存在性（设备内联套餐不认识库 id，沿用旧规则）。
        if pkg_ref and package_ids is not None and source_id[len(_LIB_PKG_REF_PREFIX):] not in package_ids:
            warnings.append("%s[%s]: 来源套餐 %s 不在资源库里，已置空（频道保留）"
                            % (field, name, source_id))
            source_id = ""
        if source_id and not pkg_ref and source_ids is not None and source_id not in source_ids:
            warnings.append("%s[%s]: 来源 %s 不在资源库里，已置空（频道保留）"
                            % (field, name, source_id))
            source_id = ""
        room = min(budget - total, MAX_GROUP_CHANNELS)
        if room <= 0:
            warnings.append("%s: 频道数达到上限，已截断" % field)
            break
        raw_channels = entry.get("channels") or []
        if not isinstance(raw_channels, list):
            # 与 contract.js 一致：脏数据当空分组，不整份 400。
            warnings.append("%s[%s].channels 不是数组，按空分组处理" % (field, name))
            raw_channels = []
        decorated = []
        for channel in raw_channels:
            if isinstance(channel, dict):
                item = dict(channel)
                item["group"] = name
                decorated.append(item)
            else:
                decorated.append(channel)
        channels = (_normalize_channels(decorated, "%s[%s].channels" % (field, name), warnings)
                    or [])[:room]
        total += len(channels)
        taken.add(group_id)
        groups.append({
            "id": group_id,
            "name": name,
            "sourceId": source_id,
            "channels": channels,
        })
    return groups


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
        groups = _normalize_package_groups(item.get("groups"),
                                          field + ".groups", warnings, room, None)
        # 有分组时频道只留在分组里：再存一份扁平 channels 会让同一批频道在
        # 文档里出现两次（设备文档有 900 KB 上限）。
        channels = [] if groups else _normalize_channels(
            item.get("channels") or [], field + ".channels", warnings)[:room]
        sources = _str_list(item.get("sources"), field + ".sources")
        if sources is None:
            pkg_sources: list[str] = []
        else:
            pkg_sources = [src for src in sources if _URL_RE.match(src)][:MAX_PACKAGE_SOURCES]
            if len(pkg_sources) < len(sources):
                warnings.append("%s.sources: 已忽略非 http(s) 地址" % field)
        if groups:
            for group in groups:
                if group["sourceId"] and group["sourceId"] not in pkg_sources:
                    pkg_sources.append(group["sourceId"])
        total_channels += len(package_channels({"groups": groups})) if groups else len(channels)
        seen_ids.add(pkg_id)
        packages.append({
            "id": pkg_id,
            "name": _str(item.get("name"), pkg_id, field + ".name", MAX_PACKAGE_NAME_LEN),
            "sources": pkg_sources,
            "groups": groups,
            "channels": channels,
        })
    return packages


def _normalize_request_headers(value: Any, warnings: list[str], field: str) -> dict[str, str] | None:
    """IPTV 拉流/播放请求头（User-Agent / Referer / Cookie）。

    这三项由电视端直接拼进 HTTP 请求，所以必须在这里拦住 CR/LF 与控制字符：
    云端配置一旦能带换行，等于把请求头注入的口子开在配置里。字符被清理时
    记 warning，让编辑者知道自己的值没原样生效。
    """
    if value is None:
        return None
    if not isinstance(value, dict):
        raise ConfigError("%s 必须是对象" % field)
    out: dict[str, str] = {}
    for key, limit in MAX_IPTV_HEADER_LIMITS:
        raw = value.get(key)
        if raw is None:
            out[key] = ""
            continue
        if not isinstance(raw, str):
            raise ConfigError("%s.%s 必须是字符串" % (field, key))
        cleaned = _CONTROL_CHARS_RE.sub("", raw).strip()[:limit]
        if cleaned != raw.strip():
            warnings.append("%s.%s: 已移除换行/控制字符或超出 %d 字符上限" % (field, key, limit))
        out[key] = cleaned
    return out


def normalize_iptv(part: dict, warnings: list[str]) -> dict:
    """IPTV 源节：编辑器解析 M3U/TXT 后写入精简频道列表，云端只校验与下发。"""
    base = copy.deepcopy(SEED["sections"]["iptv"])
    if not isinstance(base.get("packageIds"), list):
        base["packageIds"] = []
    base["managed"] = _bool(part.get("managed"), False, "iptv.managed")

    epg = _str(part.get("epgUrl"), "", "iptv.epgUrl", 500)
    base["epgUrl"] = epg if epg and _URL_RE.match(epg) else ""
    if epg and not base["epgUrl"]:
        warnings.append("iptv.epgUrl: 仅支持 http(s)，已忽略")

    headers = _normalize_request_headers(part.get("requestHeaders"), warnings, "iptv.requestHeaders")
    if headers is not None:
        base["requestHeaders"] = headers

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

    # v1.1：设备只存「全局资源库」里的套餐 id 引用，库改了所有未锁定设备自动跟着变。
    # 与 selectedPackageIds 的区别：packageIds 指向库（不要求本机 packages 里有），
    # selectedPackageIds 指向设备内联 packages，保留用于旧编辑器与离线快照。
    raw_package_ids = part.get("packageIds")
    if raw_package_ids is not None:
        if not isinstance(raw_package_ids, list) or any(
                not isinstance(item, str) for item in raw_package_ids):
            raise ConfigError("iptv.packageIds 必须是字符串数组")
        picked: list[str] = []
        for raw_id in raw_package_ids:
            pid = raw_id.strip()
            if not pid:
                continue
            if not _PACKAGE_ID_RE.match(pid):
                warnings.append("iptv.packageIds: 忽略格式非法的套餐 id %s" % pid)
                continue
            if pid in picked:
                continue
            if len(picked) >= MAX_IPTV_PACKAGES:
                warnings.append("iptv.packageIds: 超过 %d 个上限，已截断" % MAX_IPTV_PACKAGES)
                break
            picked.append(pid)
        base["packageIds"] = picked

    # lockLibrary=true：这台设备冻结在当前内容，忽略资源库后续变化（内容来自
    # 内联 packages / selectedPackageIds / channels，即 PUT 时落下的快照）。
    base["lockLibrary"] = _bool(part.get("lockLibrary"), False, "iptv.lockLibrary")
    # 由服务端维护：记录设备文档已追平到库的哪个 revision，客户端不应自行改写。
    base["libraryRevision"] = _int(part.get("libraryRevision"), 0, 0,
                                   MAX_LIBRARY_REVISION, "iptv.libraryRevision")

    # 约定：选中套餐时，频道只在 packages 里存一份；服务端 GET /api/config 会
    # 调用 expand_iptv_channels() 按套餐动态展开到 channels，避免存储两份重复频道。
    # selectedPackageIds 为空时顶层 channels 保持原有行为，兼容旧配置。
    if base["selectedPackageIds"]:
        base["channels"] = []
    return base


def normalize_vod(part: dict, warnings: list[str]) -> dict:
    """vod（TVBox 源 / 站点）节：设备只保存库里的 id 引用，不存站点清单。

    与 iptv 对称：sourceIds 引用 library.vod.sources，siteIds 引用
    library.vod.sites（id 形如 `vs_1a2b3c4d:站点key`）。引用是否存在由库侧保证，
    这里只做格式校验与去重，避免一台设备把整库站点复制一遍。
    """
    base = copy.deepcopy(DEFAULT_VOD)
    base["managed"] = _bool(part.get("managed"), False, "vod.managed")

    raw_source_ids = _string_array(part.get("sourceIds"), "vod.sourceIds", MAX_VOD_SOURCES)
    if raw_source_ids is not None:
        if len(part["sourceIds"]) > MAX_VOD_SOURCES:
            warnings.append("vod.sourceIds: 超过 %d 个上限，已截断" % MAX_VOD_SOURCES)
        picked: list[str] = []
        for source_id in raw_source_ids:
            if not _LIB_VOD_SOURCE_ID_RE.match(source_id):
                warnings.append("vod.sourceIds: 忽略格式非法的源 id %s" % source_id)
                continue
            if source_id in picked:
                continue
            picked.append(source_id)
        base["sourceIds"] = picked[:MAX_VOD_SOURCES]

    raw_site_ids = _string_array(part.get("siteIds"), "vod.siteIds", MAX_VOD_SITES)
    if raw_site_ids is not None:
        if len(part["siteIds"]) > MAX_VOD_SITES:
            warnings.append("vod.siteIds: 超过 %d 个上限，已截断" % MAX_VOD_SITES)
        picked = []
        seen: set[str] = set()
        for site_id in raw_site_ids:
            if not _VOD_SITE_ID_RE.match(site_id):
                warnings.append("vod.siteIds: 忽略格式非法的站点 id %s" % site_id)
                continue
            if site_id in seen:
                continue
            seen.add(site_id)
            picked.append(site_id)
            if len(picked) >= MAX_VOD_SITES:
                break
        base["siteIds"] = picked

    base["lockLibrary"] = _bool(part.get("lockLibrary"), False, "vod.lockLibrary")
    base["libraryRevision"] = _int(part.get("libraryRevision"), 0, 0,
                                   MAX_LIBRARY_REVISION, "vod.libraryRevision")

    # 默认站点：只决定「打开影音先选谁」，不参与白名单语义。FC 版没有全局资源库，
    # 展开由客户端自己做，所以这里只挡格式非法的值。
    raw_default_site = _str(part.get("defaultSiteId"), "", "vod.defaultSiteId", 96)
    if raw_default_site and not _VOD_SITE_ID_RE.match(raw_default_site):
        warnings.append("vod.defaultSiteId: 忽略格式非法的站点 id %s" % raw_default_site)
    else:
        base["defaultSiteId"] = raw_default_site

    # 内联源 / 站点：既可能是服务端展开的产物，也可能是人工写死的快照。
    # FC 版没有全局资源库，这两个字段是 TVBox 配置唯一的落地处。
    base["sources"] = _inline_vod_sources(part.get("sources"), warnings)
    base["sites"] = _inline_vod_sites(part.get("sites"), warnings)
    return base


def _inline_vod_sources(raw: Any, warnings: list[str]) -> list[dict]:
    """校验设备内联的 TVBox 源（id / name / jar）。"""
    if raw is None:
        return []
    if not isinstance(raw, list):
        warnings.append("vod.sources: 必须是数组，已忽略")
        return []
    out: list[dict] = []
    for entry in raw[:MAX_VOD_SOURCES]:
        if not isinstance(entry, dict):
            continue
        source_id = _str(entry.get("id"), "", "vod.sources.id", 32)
        if not source_id:
            continue
        jar, parsed_md5 = parse_spider_field(entry.get("jar"), "")
        name = _str(entry.get("name"), "", "vod.sources.name", 64)
        out.append({
            "id": source_id,
            "name": name or source_id,
            # 直连模式下终端要用这个地址自己拉配置；两种模式都随文档下发，
            # 便于随时切换而不必等云端重新展开（与 EdgeOne contract.js 对齐）。
            "url": _str(entry.get("url"), "", "vod.sources.url", 1000),
            "jar": jar,
            "spiderMd5": _str(entry.get("spiderMd5"), parsed_md5, "vod.sources.spiderMd5", 64),
            "spiderFlavor": _vod_flavor(entry.get("spiderFlavor")),
            "mode": _vod_source_mode(entry.get("mode")),
        })
    if len(raw) > MAX_VOD_SOURCES:
        warnings.append("vod.sources: 超过 %d 个上限，已截断" % MAX_VOD_SOURCES)
    return out


def _inline_vod_sites(raw: Any, warnings: list[str]) -> list[dict]:
    """校验设备内联的 TVBox 站点；不再校验「必须属于某个源」。

    锁定快照里的源和站点是同一时刻拍下来的，可能已经和库对不上，
    这里强制引用关系合法反而会把快照清空。
    """
    if raw is None:
        return []
    if not isinstance(raw, list):
        warnings.append("vod.sites: 必须是数组，已忽略")
        return []
    out: list[dict] = []
    seen: set[str] = set()
    for entry in raw[:MAX_VOD_SITES]:
        if not isinstance(entry, dict):
            continue
        site_id = _str(entry.get("id"), "", "vod.sites.id", 96)
        api = _str(entry.get("api"), "", "vod.sites.api", 500)
        if not site_id or not api or site_id in seen:
            continue
        seen.add(site_id)
        out.append({
            "id": site_id,
            "sourceId": _str(entry.get("sourceId"), "", "vod.sites.sourceId", 32),
            "name": _str(entry.get("name"), "", "vod.sites.name", 64) or site_id,
            "api": api,
            "ext": _str(entry.get("ext"), "", "vod.sites.ext", 1000),
            "type": _lenient_int(entry.get("type"), 0, 0, 4),
            "searchable": _lenient_int(entry.get("searchable"), 0, 0, 2),
            "quickSearch": _lenient_int(entry.get("quickSearch"), 0, 0, 2),
        })
    if len(raw) > MAX_VOD_SITES:
        warnings.append("vod.sites: 超过 %d 个上限，已截断" % MAX_VOD_SITES)
    return out


def expand_iptv_channels(sections: dict, library: dict | None = None) -> dict:
    """按设备引用展开 iptv.channels（供 API 层 GET /api/config 调用）。

    深拷贝入参后返回，不污染调用方。四档优先级（与 contract.js 逐条对齐）：

    1. ``iptv.lockLibrary is True``：设备已锁定，完全忽略 library，只用设备内联的
       packages / selectedPackageIds / channels（PUT 时落下的自包含快照）；
    2. 否则 ``iptv.packageIds`` 非空且库里有对应套餐：按 packageIds 顺序合并库套餐
       的 channels，URL 去重，上限 MAX_IPTV_CHANNELS；
    3. 否则回退旧逻辑（selectedPackageIds + 内联 packages），行为与历史版本一致；
    4. 引用库时最后并入设备内联 channels（库频道优先，URL 去重），让设备能在库之外
       再挂自己的几个频道。

    不传 library 或库不可用时行为与旧版本完全一致，旧文档不会被新字段卡住。
    """
    result = copy.deepcopy(sections)
    iptv = result.get("iptv")
    if not isinstance(iptv, dict):
        return result

    locked = iptv.get("lockLibrary") is True
    inline_packages = iptv.get("packages")
    if not isinstance(inline_packages, list):
        inline_packages = []
    inline_channels = iptv.get("channels")
    if not isinstance(inline_channels, list):
        inline_channels = []

    lib_packages: list[dict] = []
    if isinstance(library, dict):
        lib_iptv = library.get("iptv")
        if isinstance(lib_iptv, dict) and isinstance(lib_iptv.get("packages"), list):
            lib_packages = [pkg for pkg in lib_iptv["packages"] if isinstance(pkg, dict)]
    lib_by_id = {pkg["id"]: pkg for pkg in lib_packages if isinstance(pkg.get("id"), str)}

    ref_ids = [] if locked else [
        pid for pid in (iptv.get("packageIds") or []) if isinstance(pid, str)
    ]
    use_library = bool(ref_ids) and any(pid in lib_by_id for pid in ref_ids)
    if use_library:
        ids = ref_ids
    else:
        selected = iptv.get("selectedPackageIds")
        ids = [pid for pid in selected if isinstance(pid, str)] if isinstance(selected, list) else []
    if not ids:
        return result

    if use_library:
        by_id = lib_by_id
    else:
        by_id = {pkg["id"]: pkg for pkg in inline_packages if isinstance(pkg.get("id"), str)}
    merged: list[Any] = []
    for pid in ids:
        pkg = by_id.get(pid)
        if not isinstance(pkg, dict):
            continue
        merged.extend(package_channels(pkg))
    # 第 4 档：引用库时把设备自有的内联频道接在后面（库频道优先）。
    if use_library:
        merged.extend(inline_channels)

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


# ---------------- 全局资源库：校验与规范化 ----------------


def _new_library_id(prefix: str, taken: set[str]) -> str:
    """缺省 id 时补发：前缀 + 8 位十六进制，与编辑器生成的格式一致。"""
    for _ in range(100):
        candidate = prefix + ("%08x" % random.getrandbits(32))
        if candidate not in taken:
            return candidate
    return prefix + ("%08x" % (int(datetime.now().timestamp() * 1000) & 0xFFFFFFFF))


def _library_object(part: Any, field: str) -> dict:
    if part is None:
        return {}
    if not isinstance(part, dict):
        raise ConfigError("%s 必须是对象" % field)
    return part


def _library_item(item: Any, field: str, warnings: list[str]) -> dict | None:
    if not isinstance(item, dict):
        warnings.append("%s: 忽略非对象条目" % field)
        return None
    return item


def _library_id(item: dict, pattern: re.Pattern[str], prefix: str, field: str) -> str:
    """库内 id 是引用目标，格式错了会静默失效，因此直接 400 而不是 warning。"""
    raw = str(item.get("id") or "").strip()
    if not raw:
        return ""
    if not pattern.match(raw):
        raise ConfigError("%s: 非法 id %s（应为 %s 加 8 位十六进制）"
                          % (field, raw, prefix))
    return raw


def _normalize_library_iptv(part: Any, warnings: list[str]) -> dict:
    raw = _library_object(part, "library.iptv")
    out: dict = {"sources": [], "packages": [], "epgUrl": ""}

    epg = _str(raw.get("epgUrl"), "", "library.iptv.epgUrl", 500)
    out["epgUrl"] = epg if epg and _URL_RE.match(epg) else ""
    if epg and not out["epgUrl"]:
        warnings.append("library.iptv.epgUrl: 仅支持 http(s)，已忽略")

    raw_sources = raw.get("sources")
    if raw_sources is not None:
        if not isinstance(raw_sources, list):
            raise ConfigError("library.iptv.sources 必须是数组")
        if len(raw_sources) > MAX_LIBRARY_SOURCES:
            warnings.append("library.iptv.sources: 超过 %d 个上限，已截断"
                            % MAX_LIBRARY_SOURCES)
        taken: set[str] = set()
        for entry in raw_sources[:MAX_LIBRARY_SOURCES]:
            item = _library_item(entry, "library.iptv.sources", warnings)
            if item is None:
                continue
            source_id = _library_id(item, _LIB_SOURCE_ID_RE, "s_", "library.iptv.sources")
            if not source_id:
                source_id = _new_library_id("s_", taken)
            if source_id in taken:
                warnings.append("library.iptv.sources: 忽略重复的源 id %s" % source_id)
                continue
            url = _str(item.get("url"), "", "library.iptv.sources.url", 1000)
            if not url or not _URL_RE.match(url):
                warnings.append("library.iptv.sources: 忽略非法订阅地址 %s（仅支持 http(s)）"
                                % (url or "(空)"))
                continue
            taken.add(source_id)
            out["sources"].append({
                "id": source_id,
                "name": _str(item.get("name"), "", "library.iptv.sources.name", 64) or url,
                "url": url,
                "type": (_str(item.get("type"), "m3u", "library.iptv.sources.type", 16)
                         or "m3u").lower(),
                "channelCount": _lenient_int(item.get("channelCount"), 0, 0,
                                             MAX_IPTV_CHANNELS),
                "addedAt": _str(item.get("addedAt"), now_iso(),
                                "library.iptv.sources.addedAt", 40),
                "note": _str(item.get("note"), "", "library.iptv.sources.note", 200),
            })

    raw_packages = raw.get("packages")
    if raw_packages is not None:
        if not isinstance(raw_packages, list):
            raise ConfigError("library.iptv.packages 必须是数组")
        if len(raw_packages) > MAX_IPTV_PACKAGES:
            warnings.append("library.iptv.packages: 超过 %d 个上限，已截断"
                            % MAX_IPTV_PACKAGES)
        source_ids = {item["id"] for item in out["sources"]}
        by_url = {item["url"].lower(): item["id"] for item in out["sources"]}
        # 分组来源可指向同库套餐，先收集套餐 id 供存在性校验。
        package_ids: set[str] = set()
        for entry in raw_packages[:MAX_IPTV_PACKAGES]:
            ref_item = _library_item(entry, "library.iptv.packages", warnings)
            if ref_item is None:
                continue
            ref_id = _library_id(ref_item, _LIB_PACKAGE_ID_RE, "pkg_", "library.iptv.packages")
            if ref_id:
                package_ids.add(ref_id)
        taken = set()
        total_channels = 0
        for entry in raw_packages[:MAX_IPTV_PACKAGES]:
            item = _library_item(entry, "library.iptv.packages", warnings)
            if item is None:
                continue
            pkg_id = _library_id(item, _LIB_PACKAGE_ID_RE, "pkg_", "library.iptv.packages")
            if not pkg_id:
                pkg_id = _new_library_id("pkg_", taken)
            if pkg_id in taken:
                warnings.append("library.iptv.packages: 忽略重复的套餐 id %s" % pkg_id)
                continue
            room = MAX_PACKAGE_CHANNELS_TOTAL - total_channels
            if room <= 0:
                warnings.append("library.iptv.packages: 频道总数达到 %d 上限，已截断"
                                % MAX_PACKAGE_CHANNELS_TOTAL)
                break
            groups = _normalize_package_groups(item.get("groups"),
                                               "library.iptv.packages[%s].groups" % pkg_id,
                                               warnings, room, source_ids, package_ids)
            # 有分组时频道只留在分组里，扁平 channels 清空：同一批频道存两份
            # 会把 900 KB 的库上限吃掉一大半，而且两份数据迟早对不上。
            channel_field = "library.iptv.packages[%s].channels" % pkg_id
            channels = [] if groups else _normalize_channels(
                item.get("channels") or [], channel_field, warnings)[:room]
            refs = _string_array(item.get("sources"),
                                 "library.iptv.packages[%s].sources" % pkg_id,
                                 MAX_LIBRARY_SOURCES) or []
            sources: list[str] = []
            # 分组引用的源本身就是套餐的来源，不必让用户再勾一遍。
            # pkgref 指向库内套餐：校验引用存在后原样保留（编辑器靠它显示套餐名）。
            for group in groups:
                sid = group["sourceId"]
                if not sid or sid in sources:
                    continue
                if _LIB_PKG_REF_RE.match(sid) or sid in source_ids:
                    sources.append(sid)
            for ref in refs:
                # pkgref 指向库内套餐，校验存在后原样保留。
                if _LIB_PKG_REF_RE.match(ref):
                    if ref[len(_LIB_PKG_REF_PREFIX):] in package_ids and ref not in sources:
                        sources.append(ref)
                    continue
                # 编辑器历史版本存的是订阅 URL，这里兼容成 sourceId，避免来源信息丢失。
                source_id = ref
                if source_id not in source_ids and _URL_RE.match(ref):
                    source_id = by_url.get(ref.lower(), ref)
                if source_id not in source_ids:
                    warnings.append("library.iptv.packages[%s]: 忽略不存在的源 %s"
                                    % (pkg_id, ref))
                    continue
                if source_id not in sources:
                    sources.append(source_id)
            total_channels += (len(package_channels({"groups": groups}))
                               if groups else len(channels))
            taken.add(pkg_id)
            out["packages"].append({
                "id": pkg_id,
                "name": _str(item.get("name"), "", "library.iptv.packages.name", 64)
                        or pkg_id,
                "sources": sources,
                "groups": groups,
                "channels": channels,
            })
    return out


def _normalize_library_vod(part: Any, warnings: list[str]) -> dict:
    raw = _library_object(part, "library.vod")
    out: dict = {"sources": [], "sites": [], "defaultSiteId": ""}

    raw_sources = raw.get("sources")
    if raw_sources is not None:
        if not isinstance(raw_sources, list):
            raise ConfigError("library.vod.sources 必须是数组")
        if len(raw_sources) > MAX_VOD_SOURCES:
            warnings.append("library.vod.sources: 超过 %d 个上限，已截断" % MAX_VOD_SOURCES)
        taken: set[str] = set()
        for entry in raw_sources[:MAX_VOD_SOURCES]:
            item = _library_item(entry, "library.vod.sources", warnings)
            if item is None:
                continue
            source_id = _library_id(item, _LIB_VOD_SOURCE_ID_RE, "vs_", "library.vod.sources")
            if not source_id:
                source_id = _new_library_id("vs_", taken)
            if source_id in taken:
                warnings.append("library.vod.sources: 忽略重复的源 id %s" % source_id)
                continue
            url = _str(item.get("url"), "", "library.vod.sources.url", 1000)
            if not url or not _URL_RE.match(url):
                warnings.append("library.vod.sources: 忽略非法接口地址 %s（仅支持 http(s)）"
                                % (url or "(空)"))
                continue
            taken.add(source_id)
            out["sources"].append({
                "id": source_id,
                "name": _str(item.get("name"), "", "library.vod.sources.name", 64) or url,
                "url": url,
                "mode": _vod_source_mode(item.get("mode")),
                "siteCount": _lenient_int(item.get("siteCount"), 0, 0, MAX_VOD_SITES),
                "addedAt": _str(item.get("addedAt"), now_iso(),
                                "library.vod.sources.addedAt", 40),
                "note": _str(item.get("note"), "", "library.vod.sources.note", 200),
            })

    raw_sites = raw.get("sites")
    if raw_sites is not None:
        if not isinstance(raw_sites, list):
            raise ConfigError("library.vod.sites 必须是数组")
        if len(raw_sites) > MAX_VOD_SITES:
            warnings.append("library.vod.sites: 超过 %d 个上限，已截断" % MAX_VOD_SITES)
        source_ids = {item["id"] for item in out["sources"]}
        per_source: dict[str, int] = {}
        seen: set[str] = set()
        for entry in raw_sites[:MAX_VOD_SITES]:
            item = _library_item(entry, "library.vod.sites", warnings)
            if item is None:
                continue
            source_id = _str(item.get("sourceId"), "", "library.vod.sites.sourceId", 32)
            if not _LIB_VOD_SOURCE_ID_RE.match(source_id) or source_id not in source_ids:
                warnings.append("library.vod.sites: 忽略未知源 %s 下的站点"
                                % (source_id or "(空)"))
                continue
            key = _str(item.get("key"), "", "library.vod.sites.key", 96)
            # 客户端传来的 id 可能是对 key 做过字符替换的版本，合法且属于同一源就沿用。
            provided_id = _str(item.get("id"), "", "library.vod.sites.id", 96)
            if _VOD_SITE_ID_RE.match(provided_id) and provided_id.startswith(source_id + ":"):
                site_id = provided_id
            else:
                site_id = "%s:%s" % (source_id, key)
            if not key or not _VOD_SITE_ID_RE.match(site_id):
                warnings.append("library.vod.sites: 忽略非法站点 key %s" % (key or "(空)"))
                continue
            if site_id in seen:
                warnings.append("library.vod.sites: 忽略重复站点 %s" % site_id)
                continue
            used = per_source.get(source_id, 0)
            if used >= MAX_VOD_SITES_PER_SOURCE:
                warnings.append("library.vod.sites: 源 %s 超过 %d 个站点上限，已截断"
                                % (source_id, MAX_VOD_SITES_PER_SOURCE))
                continue
            api = _str(item.get("api"), "", "library.vod.sites.api", 500)
            if not api:
                warnings.append("library.vod.sites[%s]: 缺少 api，已忽略" % site_id)
                continue
            per_source[source_id] = used + 1
            seen.add(site_id)
            out["sites"].append({
                "id": site_id,
                "sourceId": source_id,
                "key": key,
                "name": _str(item.get("name"), "", "library.vod.sites.name", 64) or key,
                "api": api,
                "type": _lenient_int(item.get("type"), 0, 0, 4),
                "searchable": _lenient_int(item.get("searchable"), 0, 0, 2),
                "quickSearch": _lenient_int(item.get("quickSearch"), 0, 0, 2),
                "note": _str(item.get("note"), "", "library.vod.sites.note", 200),
            })
    # 库级默认站点：设备/套餐没单独指定时用它。只接受落在最终站点列表里的 id，
    # 否则留一个悬空引用，终端打开影音会去开一个不存在的站点。
    wanted_default = _str(raw.get("defaultSiteId"), "", "library.vod.defaultSiteId", 96)
    if wanted_default:
        if any(site["id"] == wanted_default for site in out["sites"]):
            out["defaultSiteId"] = wanted_default
        else:
            warnings.append("library.vod.defaultSiteId: 站点 %s 不在站点列表里，已忽略"
                            % wanted_default)
    return out


def _flatten_version(version: str) -> int:
    """`3.0.43` → `130043`：100000 的产品位 + major*10000 + minor*100 + patch。

    与 Edge Functions 版 contract.js / update.js 的 flattenVersion 一致，
    少了产品位就会和仓库现有 releases 里的 version_num 对不上。
    """
    parts: list[int] = []
    for chunk in str(version or "").split("."):
        if not re.fullmatch(r"\d+", chunk.strip()):
            break
        parts.append(int(chunk))
    if not parts:
        return 0
    major = parts[0]
    minor = parts[1] if len(parts) > 1 else 0
    patch = parts[2] if len(parts) > 2 else 0
    return 100000 + major * 10000 + minor * 100 + patch


def _sha256_hex(value: Any) -> str:
    """sha256 只收 64 位小写十六进制；不合法就当没填（终端会退化为大小校验）。"""
    text = str(value or "").strip().lower()
    return text if re.fullmatch(r"[0-9a-f]{64}", text) else ""


def _normalize_library_updates(part: Any, warnings: list[str]) -> list[dict]:
    """规范化「在线更新版本」列表。

    每条版本的安装包有两种来源，可以按架构混用：
      - urls[abi]：用户自己填的直链（CDN / 网盘），云端零存储；
      - files[abi]：编辑器上传到 Blob 的安装包，key 由服务端生成（_APK_KEY_RE 白名单）。
    两者都没有的条目直接丢弃——留着只会让套餐选到它之后终端毫无反应。
    """
    raw = [] if part is None else part
    if not isinstance(raw, list):
        raise ConfigError("library.updates 必须是数组")
    if len(raw) > MAX_LIBRARY_UPDATES:
        warnings.append("library.updates: 超过 %d 个上限，已截断" % MAX_LIBRARY_UPDATES)
    taken: set[str] = set()
    out: list[dict] = []
    for entry in raw[:MAX_LIBRARY_UPDATES]:
        item = _library_item(entry, "library.updates", warnings)
        if item is None:
            continue
        item_id = _library_id(item, _LIB_UPDATE_ID_RE, "up_", "library.updates")
        if not item_id:
            item_id = _new_library_id("up_", taken)
        if item_id in taken:
            warnings.append("library.updates: 忽略重复的版本 id %s" % item_id)
            continue
        version = _str(item.get("version"), "", "library.updates.version", 32)
        if not version or not _VERSION_RE.match(version):
            warnings.append("library.updates: 忽略版本号不合法的条目（%s），应为 3.0.43 这样的格式"
                            % (version or "空"))
            continue
        taken.add(item_id)

        raw_urls = item.get("urls") if isinstance(item.get("urls"), dict) else {}
        raw_files = item.get("files") if isinstance(item.get("files"), dict) else {}
        urls: dict[str, str] = {}
        files: dict[str, dict] = {}
        for abi in UPDATE_ABIS:
            url = _str(raw_urls.get(abi), "", "library.updates.urls.%s" % abi, 500)
            if url and not _URL_RE.match(url):
                warnings.append("library.updates %s: %s 的地址不是 http(s)，已忽略"
                                % (item_id, abi))
                urls[abi] = ""
            else:
                urls[abi] = url
            file = raw_files.get(abi)
            if not isinstance(file, dict):
                continue
            key = _str(file.get("key"), "", "library.updates.files.%s.key" % abi, 200)
            if not _APK_KEY_RE.match(key):
                warnings.append("library.updates %s: %s 的上传文件 key 非法，已忽略"
                                % (item_id, abi))
                continue
            files[abi] = {
                "key": key,
                "name": _str(file.get("name"), "", "library.updates.files.%s.name" % abi, 120),
                "size": _lenient_int(file.get("size"), 0, 0, MAX_APK_BYTES),
                "sha256": _sha256_hex(file.get("sha256")),
            }
        if not any(urls.get(abi) or files.get(abi) for abi in UPDATE_ABIS):
            warnings.append("library.updates: 忽略既没有安装包也没有下载链接的版本 v%s" % version)
            continue
        out.append({
            "id": item_id,
            "name": _str(item.get("name"), "", "library.updates.name", 64) or ("v" + version),
            "version": version,
            "versionNum": _lenient_int(item.get("versionNum"), _flatten_version(version),
                                       0, 99999999),
            "desc": _str(item.get("desc"), "", "library.updates.desc", 2000),
            "prerelease": _bool(item.get("prerelease"), False, "library.updates.prerelease"),
            "urls": urls,
            "files": files,
            "enabled": _bool(item.get("enabled"), True, "library.updates.enabled"),
            "addedAt": _str(item.get("addedAt"), now_iso(), "library.updates.addedAt", 40),
        })
    return out


def empty_library() -> dict:
    """空库：GET /api/library 在没有写过库时也返回结构完整的文档（revision 0）。"""
    return {
        "schemaVersion": LIBRARY_SCHEMA_VERSION,
        "revision": 0,
        "updatedAt": "",
        "iptv": {"sources": [], "packages": [], "epgUrl": ""},
        "vod": {"sources": [], "sites": [], "defaultSiteId": ""},
        # 在线更新版本：与 IPTV 源、TVBox 源并列的第三类资源。
        # 套餐里选定一条后展开写入设备文档的 sections.update（版本号 + 按架构直链），
        # 终端据此判定「有新版本」并直接从该地址下载。
        "updates": [],
    }


def normalize_library(raw: Any) -> tuple[dict, list[str]]:
    """校验并规范化整库（PUT /api/library 用），返回 (library, warnings)。

    revision / updatedAt 由存储层填写，这里固定 0 / 空串。
    """
    if not isinstance(raw, dict):
        raise ConfigError("资源库文档必须是对象")
    warnings: list[str] = []
    library = {
        "schemaVersion": LIBRARY_SCHEMA_VERSION,
        "revision": 0,
        "updatedAt": "",
        "iptv": _normalize_library_iptv(raw.get("iptv"), warnings),
        "vod": _normalize_library_vod(raw.get("vod"), warnings),
        "updates": _normalize_library_updates(raw.get("updates"), warnings),
    }
    return library, warnings


_NORMALIZERS = {
    "navigation": normalize_navigation,
    "startup": normalize_startup,
    "update": normalize_update,
    "iptv": normalize_iptv,
    "vod": normalize_vod,
}


def normalize_sections(raw: Any) -> tuple[dict, list[str]]:
    """把请求里的 sections 规范化为完整文档节，返回 (sections, warnings)。"""
    if not isinstance(raw, dict):
        raise ConfigError("sections 必须是对象")
    warnings: list[str] = []
    sections = copy.deepcopy(SEED["sections"])
    # seed.json 里没有 vod 节：老文档/老种子的读出结果也要结构完整。
    ensure_section_defaults(sections)
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
