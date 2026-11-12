"""配置契约校验测试，对应需求文档 4.3 / 4.4。"""
from __future__ import annotations

import unittest

from cloud.schema import (
    ConfigError,
    MAX_IPTV_CHANNELS,
    MAX_VOD_SITES,
    MAX_VOD_SITES_PER_SOURCE,
    VALID_MENU_IDS,
    VALID_SITE_IDS,
    empty_library,
    expand_iptv_channels,
    normalize_document,
    normalize_library,
    normalize_sections,
    seed_document,
)


class SchemaTests(unittest.TestCase):
    def test_seed_is_all_unmanaged(self):
        doc = seed_document()
        self.assertEqual(doc["schemaVersion"], 1)
        self.assertEqual(doc["revision"], 0)
        for section in doc["sections"].values():
            self.assertFalse(section["managed"])

    def test_schema_version_mismatch_is_rejected(self):
        with self.assertRaises(ConfigError):
            normalize_document({"schemaVersion": 2, "sections": {}})

    def test_unknown_section_is_ignored_with_warning(self):
        sections, warnings = normalize_sections({"typo": {"managed": True}})
        self.assertEqual(set(sections), {"sites", "navigation", "startup", "update",
                                         "iptv", "vod"})
        self.assertTrue(any("typo" in item for item in warnings))

    def test_unknown_and_retired_site_ids_are_filtered(self):
        sections, warnings = normalize_sections({
            "sites": {"managed": True, "enabledSiteIds": ["bilibili", "douyu", "not_a_site", "huajiao", "BILIBILI"]}
        })
        self.assertEqual(sections["sites"]["enabledSiteIds"], ["bilibili", "douyu"])
        self.assertTrue(len(warnings) >= 2)

    def test_empty_site_list_falls_back_to_full_seed(self):
        sections, warnings = normalize_sections({"sites": {"managed": True, "enabledSiteIds": []}})
        self.assertEqual(sections["sites"]["enabledSiteIds"], list(VALID_SITE_IDS))
        self.assertTrue(any("回退内置全量" in item for item in warnings))

    def test_empty_menu_list_falls_back_to_default_order(self):
        sections, warnings = normalize_sections({"navigation": {"managed": True, "railMenuIds": []}})
        self.assertEqual(sections["navigation"]["railMenuIds"], list(VALID_MENU_IDS))
        self.assertTrue(any("回退内置全量" in item for item in warnings))

    def test_camel_case_menu_ids_are_kept(self):
        """回归：客户端用驼峰 id，服务端曾统一转小写比对导致这两项被丢弃。"""
        sections, warnings = normalize_sections({"navigation": {
            "managed": True,
            "railMenuIds": ["favorite", "favoriteAreas", "moviePlayback", "search"],
        }})
        self.assertEqual(sections["navigation"]["railMenuIds"],
                         ["favorite", "favoriteAreas", "moviePlayback", "search"])
        self.assertEqual(warnings, [])

    def test_menu_ids_match_case_insensitively_but_keep_canonical(self):
        sections, _ = normalize_sections({"navigation": {
            "railMenuIds": ["favoriteareas", "MOVIEPLAYBACK"],
        }})
        self.assertEqual(sections["navigation"]["railMenuIds"],
                         ["favoriteAreas", "moviePlayback"])

    def test_enum_errors_are_strict(self):
        with self.assertRaises(ConfigError):
            normalize_sections({"update": {"prompt": "unknown"}})
        with self.assertRaises(ConfigError):
            normalize_sections({"startup": {"notice": {"mode": "bad"}}})
        with self.assertRaises(ConfigError):
            normalize_sections({"navigation": {"railMenuIds": "favorite"}})

    def test_invalid_version_string_rejected(self):
        with self.assertRaises(ConfigError):
            normalize_sections({"update": {"minSupportedVersion": "v3.0.7"}})
        sections, _ = normalize_sections({"update": {"minSupportedVersion": "3.0.7"}})
        self.assertEqual(sections["update"]["minSupportedVersion"], "3.0.7")

    def test_mirror_urls_only_keep_http(self):
        sections, _ = normalize_sections({
            "update": {"mirrorUrls": ["https://a.example.com/x.json", "ftp://bad", "javascript:alert(1)"]}
        })
        self.assertEqual(sections["update"]["mirrorUrls"], ["https://a.example.com/x.json"])

    def test_notice_defaults_to_dismissible_and_safe(self):
        sections, _ = normalize_sections({"startup": {"notice": {"enabled": True}}})
        notice = sections["startup"]["notice"]
        self.assertTrue(notice["dismissible"])
        self.assertEqual(notice["mode"], "once_per_revision")

    def test_force_prompt_emits_warning(self):
        _, warnings = normalize_sections({"update": {"prompt": "force"}})
        self.assertTrue(any("force" in item for item in warnings))

    def test_i18n_non_object_rejected(self):
        with self.assertRaises(ConfigError):
            normalize_sections({"startup": {"agreement": {"bodyI18n": "纯文本"}}})

    def test_settings_subsection_is_preserved_for_p1(self):
        sections, _ = normalize_sections({
            "navigation": {"settings": {"managed": True, "enabledEntryPaths": ["/settings/theme"]}}
        })
        self.assertTrue(sections["navigation"]["settings"]["managed"])
        self.assertEqual(sections["navigation"]["settings"]["enabledEntryPaths"], ["/settings/theme"])


class NavigationGroupsTests(unittest.TestCase):
    """navigation.groups / defaultGroupId 与 contract.js normalizeNavigation 对齐。"""

    def test_default_navigation_groups_from_seed(self):
        sections, _ = normalize_sections({"navigation": {}})
        nav = sections["navigation"]
        self.assertEqual(len(nav["groups"]), 4)
        self.assertEqual([g["id"] for g in nav["groups"]],
                         ["iptv", "vod", "live", "settings"])
        self.assertEqual(nav["defaultGroupId"], "iptv")
        self.assertEqual(seed_document()["sections"]["navigation"]["defaultGroupId"],
                         "iptv")

    def test_invalid_group_and_unknown_child_are_filtered(self):
        sections, warnings = normalize_sections({"navigation": {"groups": [
            {"id": "IPTV", "label": "电视",
             "children": ["iptv", "unknown", "iptv", "FAVORITEAREAS"]},
            {"id": "nope", "label": "非法", "children": []},
            {"id": "vod", "children": ["favoriteAreas"]},
        ]}})
        groups = sections["navigation"]["groups"]
        self.assertEqual([g["id"] for g in groups], ["iptv", "vod"])
        # 未知 child 与重复 child 被过滤；children 按原始大小写精确匹配，故
        # FAVORITEAREAS 不算有效（catalog 里是 favoriteAreas）。
        self.assertEqual(groups[0]["children"], ["iptv"])
        self.assertEqual(groups[0]["label"], "电视")
        self.assertEqual(groups[0]["icon"], "")
        self.assertEqual(groups[1]["label"], "vod")  # label 缺省回退 id
        self.assertEqual(groups[1]["children"], ["favoriteAreas"])
        self.assertTrue(any("非法或重复的一级块" in w for w in warnings))
        self.assertTrue(any("未知二级项" in w for w in warnings))

    def test_all_invalid_groups_fall_back_to_seed(self):
        sections, warnings = normalize_sections({"navigation": {"groups": [
            {"id": "nope", "children": []},
            "not-a-dict",
        ]}})
        self.assertEqual([g["id"] for g in sections["navigation"]["groups"]],
                         ["iptv", "vod", "live", "settings"])
        self.assertTrue(any("回退内置默认分组" in w for w in warnings))

    def test_default_group_id_falls_back_when_not_in_groups(self):
        sections, warnings = normalize_sections({"navigation": {
            "groups": [{"id": "vod", "children": ["moviePlayback"]}],
            "defaultGroupId": "nope",
        }})
        self.assertEqual(sections["navigation"]["defaultGroupId"], "iptv")
        self.assertTrue(any("defaultGroupId" in w for w in warnings))

    def test_default_group_id_accepts_existing_group_case_insensitively(self):
        sections, _ = normalize_sections({"navigation": {"defaultGroupId": "VOD"}})
        self.assertEqual(sections["navigation"]["defaultGroupId"], "vod")

    def test_navigation_groups_non_array_rejected(self):
        with self.assertRaises(ConfigError):
            normalize_sections({"navigation": {"groups": "nope"}})


class ExitDialogTests(unittest.TestCase):
    """startup.exitDialog：默认值 / 显式赋值 / 非法 mode / 非法类型。"""

    def test_exit_dialog_defaults_from_seed(self):
        self.assertIn("exitDialog", seed_document()["sections"]["startup"])
        sections, warnings = normalize_sections({"startup": {}})
        dlg = sections["startup"]["exitDialog"]
        self.assertFalse(dlg["enabled"])
        self.assertEqual(dlg["mode"], "always")
        self.assertTrue(dlg["dismissible"])
        self.assertTrue(dlg["showDonate"])
        self.assertEqual(dlg["titleI18n"], {})
        self.assertEqual(dlg["bodyI18n"], {})
        self.assertEqual(warnings, [])

    def test_exit_dialog_explicit_values_and_unknown_field_ignored(self):
        sections, _ = normalize_sections({"startup": {"exitDialog": {
            "enabled": True,
            "mode": "never",
            "dismissible": False,
            "showDonate": False,
            "titleI18n": {"zh": "慢走"},
            "bodyI18n": {"en": "bye"},
            "unknownField": 123,
        }}})
        dlg = sections["startup"]["exitDialog"]
        self.assertTrue(dlg["enabled"])
        self.assertEqual(dlg["mode"], "never")
        self.assertFalse(dlg["dismissible"])
        self.assertFalse(dlg["showDonate"])
        self.assertEqual(dlg["titleI18n"], {"zh": "慢走"})
        self.assertEqual(dlg["bodyI18n"], {"en": "bye"})
        self.assertNotIn("unknownField", dlg)

    def test_exit_dialog_mode_accepts_all_notice_modes(self):
        for mode in ("always", "once_per_revision", "never"):
            sections, _ = normalize_sections({"startup": {"exitDialog": {"mode": mode}}})
            self.assertEqual(sections["startup"]["exitDialog"]["mode"], mode)

    def test_exit_dialog_invalid_mode_rejected(self):
        with self.assertRaises(ConfigError):
            normalize_sections({"startup": {"exitDialog": {"mode": "bad"}}})

    def test_exit_dialog_invalid_types_rejected(self):
        for bad in ("text", 42, [], True):
            with self.assertRaises(ConfigError):
                normalize_sections({"startup": {"exitDialog": bad}})
        with self.assertRaises(ConfigError):
            normalize_sections({"startup": {"exitDialog": {"enabled": "yes"}}})
        with self.assertRaises(ConfigError):
            normalize_sections({"startup": {"exitDialog": {"showDonate": 1}}})
        with self.assertRaises(ConfigError):
            normalize_sections({"startup": {"exitDialog": {"titleI18n": "纯文本"}}})


class IptvPackagesTests(unittest.TestCase):
    """iptv.packages / selectedPackageIds 校验与套餐选中约定。"""

    def test_package_invalid_id_ignored_with_warning(self):
        sections, warnings = normalize_sections({"iptv": {"packages": [
            {"id": "ok_1", "name": "套餐一", "sources": [], "channels": []},
            {"id": "bad id!", "name": "非法", "sources": [], "channels": []},
        ]}})
        self.assertEqual([p["id"] for p in sections["iptv"]["packages"]], ["ok_1"])
        self.assertTrue(any("非法 id" in w for w in warnings))

    def test_duplicate_package_ids_ignored_with_warning(self):
        sections, warnings = normalize_sections({"iptv": {"packages": [
            {"id": "dup", "name": "一", "sources": [], "channels": []},
            {"id": "dup", "name": "二", "sources": [], "channels": []},
            {"id": "ok", "name": "三", "sources": [], "channels": []},
        ]}})
        self.assertEqual([p["id"] for p in sections["iptv"]["packages"]],
                         ["dup", "ok"])
        self.assertTrue(any("重复 id" in w for w in warnings))

    def test_package_channels_total_budget_capped_at_5000(self):
        def chans(prefix):
            return [{"name": "c%d" % i, "url": "http://%s/%d" % (prefix, i)}
                    for i in range(MAX_IPTV_CHANNELS)]
        sections, warnings = normalize_sections({"iptv": {"packages": [
            {"id": "p1", "channels": chans("a")},
            {"id": "p2", "channels": chans("b")},
            {"id": "p3", "channels": chans("c")},
        ]}})
        pkgs = sections["iptv"]["packages"]
        # 第 3 个套餐因总预算耗尽被整包跳过，前两个合计恰好 5000 条。
        self.assertEqual([p["id"] for p in pkgs], ["p1", "p2"])
        self.assertEqual(sum(len(p["channels"]) for p in pkgs), 5000)
        self.assertTrue(any("5000" in w for w in warnings))

    def test_package_sources_only_http_kept(self):
        sections, _ = normalize_sections({"iptv": {"packages": [{
            "id": "p1", "name": "n",
            "sources": ["https://a.example/x.m3u", "ftp://bad", "javascript:alert(1)"],
            "channels": [],
        }]}})
        self.assertEqual(sections["iptv"]["packages"][0]["sources"],
                         ["https://a.example/x.m3u"])

    def test_package_channels_protocol_whitelist_and_url_dedup(self):
        sections, _ = normalize_sections({"iptv": {"packages": [{
            "id": "p1", "name": "n", "sources": [], "channels": [
                {"name": "CCTV1", "url": "http://a/1.m3u8", "group": "央视", "logo": ""},
                {"name": "dup", "url": "HTTP://A/1.m3u8"},
                {"name": "bad", "url": "ftp://x"},
                {"name": "rtmp", "url": "rtmp://live/a", "group": "g", "logo": "l"},
                "not-a-dict",
            ],
        }]}})
        chans = sections["iptv"]["packages"][0]["channels"]
        self.assertEqual([c["url"] for c in chans],
                         ["http://a/1.m3u8", "rtmp://live/a"])

    def test_packages_count_capped_at_12(self):
        raw = [{"id": "p%d" % i, "name": "n", "sources": [], "channels": []}
               for i in range(15)]
        sections, warnings = normalize_sections({"iptv": {"packages": raw}})
        self.assertEqual(len(sections["iptv"]["packages"]), 12)
        self.assertTrue(any("iptv.packages" in w for w in warnings))

    def test_package_channels_capped_at_3000(self):
        chans = [{"name": "c%d" % i, "url": "http://a/%d" % i}
                 for i in range(MAX_IPTV_CHANNELS + 5)]
        sections, warnings = normalize_sections({"iptv": {"packages": [
            {"id": "p1", "channels": chans},
        ]}})
        self.assertEqual(len(sections["iptv"]["packages"][0]["channels"]),
                         MAX_IPTV_CHANNELS)
        self.assertTrue(any("iptv.packages[0].channels" in w for w in warnings))

    def test_top_level_channels_still_normalized(self):
        """回归：抽取共用 helper 后顶层 channels 行为不变。"""
        sections, _ = normalize_sections({"iptv": {"channels": [
            {"name": "A", "url": "http://a/1"},
            {"name": "dup", "url": "HTTP://A/1"},
            {"name": "bad", "url": "ftp://x"},
        ]}})
        self.assertEqual([c["url"] for c in sections["iptv"]["channels"]],
                         ["http://a/1"])

    def test_packages_non_array_rejected(self):
        with self.assertRaises(ConfigError):
            normalize_sections({"iptv": {"packages": "nope"}})

    def test_selected_package_ids_non_array_rejected(self):
        with self.assertRaises(ConfigError):
            normalize_sections({"iptv": {"selectedPackageIds": "p1"}})

    def test_selected_package_ids_filter_unknown_and_dedup(self):
        sections, warnings = normalize_sections({"iptv": {
            "packages": [{"id": "p1", "channels": []}, {"id": "p2", "channels": []}],
            "selectedPackageIds": ["p1", "ghost", "p2", "p1"],
        }})
        self.assertEqual(sections["iptv"]["selectedPackageIds"], ["p1", "p2"])
        self.assertTrue(any("ghost" in w for w in warnings))

    def test_selected_package_ids_capped_at_12(self):
        pkgs = [{"id": "p%d" % i, "channels": []} for i in range(15)]
        sections, _ = normalize_sections({"iptv": {
            "packages": pkgs,
            "selectedPackageIds": ["p%d" % i for i in range(15)],
        }})
        self.assertEqual(len(sections["iptv"]["selectedPackageIds"]), 12)

    def test_selected_packages_clear_top_level_channels(self):
        """选中套餐时顶层 channels 置空，频道只在 packages 里存一份。"""
        sections, _ = normalize_sections({"iptv": {
            "packages": [{"id": "p1", "channels": [
                {"name": "c", "url": "http://a/1"}]}],
            "selectedPackageIds": ["p1"],
            "channels": [{"name": "top", "url": "http://a/top"}],
        }})
        self.assertEqual(sections["iptv"]["channels"], [])
        self.assertEqual(len(sections["iptv"]["packages"]), 1)

    def test_empty_selected_keeps_top_level_channels(self):
        """兼容旧配置：未选套餐时顶层 channels 保持原有行为。"""
        sections, _ = normalize_sections({"iptv": {
            "selectedPackageIds": [],
            "channels": [{"name": "top", "url": "http://a/top"}],
        }})
        self.assertEqual([c["url"] for c in sections["iptv"]["channels"]],
                         ["http://a/top"])


class ExpandIptvChannelsTests(unittest.TestCase):
    """GET 时按选中套餐展开频道：顺序合并 / 去重 / 上限 / 深拷贝。"""

    def test_merge_follows_selected_id_order(self):
        sections = {"iptv": {
            "packages": [
                {"id": "p2", "channels": [{"name": "B", "url": "http://a/b"}]},
                {"id": "p1", "channels": [{"name": "A", "url": "http://a/a"}]},
            ],
            "selectedPackageIds": ["p1", "p2"],
            "channels": [],
        }}
        out = expand_iptv_channels(sections)
        self.assertEqual([c["url"] for c in out["iptv"]["channels"]],
                         ["http://a/a", "http://a/b"])

    def test_merge_dedups_across_packages_by_lowercase_url(self):
        sections = {"iptv": {
            "packages": [
                {"id": "p1", "channels": [{"name": "A", "url": "http://a/x"}]},
                {"id": "p2", "channels": [
                    {"name": "A2", "url": "HTTP://A/X"},
                    {"name": "C", "url": "http://a/c"},
                ]},
            ],
            "selectedPackageIds": ["p1", "p2"],
            "channels": [],
        }}
        out = expand_iptv_channels(sections)
        self.assertEqual([c["url"] for c in out["iptv"]["channels"]],
                         ["http://a/x", "http://a/c"])

    def test_expand_recomputes_groups_from_merged_channels(self):
        sections = {"iptv": {
            "packages": [
                {"id": "p1", "channels": [
                    {"name": "A", "url": "http://a/a", "group": "央视"},
                    {"name": "B", "url": "http://a/b", "group": "卫视"},
                ]},
                {"id": "p2", "channels": [
                    {"name": "C", "url": "http://a/c", "group": "央视"},
                    {"name": "D", "url": "http://a/d", "group": ""},
                ]},
            ],
            "selectedPackageIds": ["p1", "p2"],
            "channels": [],
            "groups": ["手工分组"],
        }}
        out = expand_iptv_channels(sections)
        # 按合并顺序保序去重，空分组被过滤；入参不被污染。
        self.assertEqual(out["iptv"]["groups"], ["央视", "卫视"])
        self.assertEqual(sections["iptv"]["groups"], ["手工分组"])

    def test_merge_capped_at_3000(self):
        chans1 = [{"name": "a%d" % i, "url": "http://a/%d" % i}
                  for i in range(2000)]
        chans2 = [{"name": "b%d" % i, "url": "http://b/%d" % i}
                  for i in range(2000)]
        sections = {"iptv": {
            "packages": [
                {"id": "p1", "channels": chans1},
                {"id": "p2", "channels": chans2},
            ],
            "selectedPackageIds": ["p1", "p2"],
            "channels": [],
        }}
        out = expand_iptv_channels(sections)
        self.assertEqual(len(out["iptv"]["channels"]), MAX_IPTV_CHANNELS)

    def test_no_selection_returns_unchanged(self):
        sections = {"iptv": {
            "packages": [{"id": "p1", "channels": [
                {"name": "A", "url": "http://a/a"}]}],
            "selectedPackageIds": [],
            "channels": [{"name": "top", "url": "http://a/top"}],
        }}
        out = expand_iptv_channels(sections)
        self.assertEqual(out, sections)
        self.assertEqual([c["url"] for c in out["iptv"]["channels"]],
                         ["http://a/top"])

    def test_deep_copy_does_not_mutate_input(self):
        sections = {"iptv": {
            "packages": [{"id": "p1", "channels": [
                {"name": "A", "url": "http://a/a"}]}],
            "selectedPackageIds": ["p1"],
            "channels": [],
        }}
        out = expand_iptv_channels(sections)
        self.assertEqual(sections["iptv"]["channels"], [])
        out["iptv"]["channels"].append({"name": "Z", "url": "http://a/z"})
        out["iptv"]["packages"][0]["channels"][0]["name"] = "CHANGED"
        self.assertEqual(sections["iptv"]["channels"], [])
        self.assertEqual(sections["iptv"]["packages"][0]["channels"][0]["name"], "A")

    def test_missing_iptv_section_returns_copy(self):
        sections = {"sites": {}}
        self.assertEqual(expand_iptv_channels(sections), sections)

    def test_integrates_with_normalized_sections(self):
        sections, _ = normalize_sections({"iptv": {
            "packages": [
                {"id": "p1", "channels": [{"name": "A", "url": "http://a/a"}]},
                {"id": "p2", "channels": [{"name": "B", "url": "http://a/b"}]},
            ],
            "selectedPackageIds": ["p2", "p1"],
        }})
        # PUT 时顶层 channels 被清空，GET 展开时按选中顺序恢复。
        self.assertEqual(sections["iptv"]["channels"], [])
        out = expand_iptv_channels(sections)
        self.assertEqual([c["url"] for c in out["iptv"]["channels"]],
                         ["http://a/b", "http://a/a"])


class VodSectionTests(unittest.TestCase):
    """vod 节（TVBox 源/站点引用）：默认值、格式校验、上限与老文档兼容。"""

    def test_vod_inline_sources_and_sites(self):
        """内联源/站点：jar 仅存 http(s)，ext 原样保留，非法条目被丢弃。"""
        sections, warnings = normalize_sections({
            "vod": {
                "sources": [
                    {"id": "vs_aaaaaaaa", "name": "源A", "jar": "https://a.example.com/spider.jar"},
                    {"id": "vs_bbbbbbbb", "jar": "ftp://bad.example.com/spider.jar"},
                    {"name": "没有 id"},
                ],
                "sites": [
                    {"id": "vs_aaaaaaaa:a1", "sourceId": "vs_aaaaaaaa", "api": "csp_A1", "ext": "token-a1"},
                    {"id": "vs_aaaaaaaa:a2", "sourceId": "vs_aaaaaaaa", "ext": "缺少 api"},
                ],
            },
        })
        vod = sections["vod"]
        self.assertEqual(len(vod["sources"]), 2)
        self.assertEqual(vod["sources"][0]["jar"], "https://a.example.com/spider.jar")
        self.assertEqual(vod["sources"][1]["jar"], "")
        # 缺 id / 缺 api 的条目直接丢弃，不产生 warning（属于结构性冗余）
        self.assertEqual([site["id"] for site in vod["sites"]], ["vs_aaaaaaaa:a1"])
        self.assertEqual(vod["sites"][0]["ext"], "token-a1")

    def test_vod_defaults_and_old_document_compat(self):
        sections, warnings = normalize_sections({})
        vod = sections["vod"]
        self.assertFalse(vod["managed"])
        self.assertEqual(vod["sourceIds"], [])
        self.assertEqual(vod["siteIds"], [])
        self.assertFalse(vod["lockLibrary"])
        self.assertEqual(vod["libraryRevision"], 0)
        self.assertEqual(warnings, [])
        # 老文档（没有 vod 节）读出来也要结构完整。
        self.assertIn("vod", seed_document()["sections"])
        self.assertIn("vod", normalize_sections({"iptv": {}})[0])

    def test_vod_source_ids_filter_invalid_and_dedup(self):
        sections, warnings = normalize_sections({"vod": {
            "sourceIds": ["vs_1a2b3c4d", "bad_id", "vs_1a2b3c4d", "vs_ffffffff"],
        }})
        self.assertEqual(sections["vod"]["sourceIds"], ["vs_1a2b3c4d", "vs_ffffffff"])
        self.assertTrue(any("格式非法" in item for item in warnings))

    def test_vod_source_ids_capped_at_20(self):
        ids = ["vs_%08x" % index for index in range(25)]
        sections, warnings = normalize_sections({"vod": {"sourceIds": ids}})
        self.assertEqual(len(sections["vod"]["sourceIds"]), 20)
        self.assertTrue(any("vod.sourceIds" in item for item in warnings))

    def test_vod_site_ids_validate_dedup_and_cap(self):
        sections, warnings = normalize_sections({"vod": {
            "siteIds": ["vs_1a2b3c4d:k1", "vs_1a2b3c4d:k1", "非法 id!", "vs_1a2b3c4d:k2"],
        }})
        self.assertEqual(sections["vod"]["siteIds"],
                         ["vs_1a2b3c4d:k1", "vs_1a2b3c4d:k2"])
        self.assertTrue(any("站点 id" in item for item in warnings))

        many = ["vs_1a2b3c4d:s%d" % index for index in range(MAX_VOD_SITES + 5)]
        sections, warnings = normalize_sections({"vod": {"siteIds": many}})
        self.assertEqual(len(sections["vod"]["siteIds"]), MAX_VOD_SITES)
        self.assertTrue(any("vod.siteIds" in item for item in warnings))

    def test_vod_type_errors_are_strict(self):
        for bad in ("nope", 42, [], True):
            with self.assertRaises(ConfigError):
                normalize_sections({"vod": bad})
        with self.assertRaises(ConfigError):
            normalize_sections({"vod": {"sourceIds": "vs_1a2b3c4d"}})
        with self.assertRaises(ConfigError):
            normalize_sections({"vod": {"siteIds": [1, 2]}})
        with self.assertRaises(ConfigError):
            normalize_sections({"vod": {"managed": "yes"}})
        with self.assertRaises(ConfigError):
            normalize_sections({"vod": {"lockLibrary": "yes"}})
        with self.assertRaises(ConfigError):
            normalize_sections({"vod": {"libraryRevision": -1}})


class IptvLibraryFieldsTests(unittest.TestCase):
    """iptv 新增 packageIds / lockLibrary / libraryRevision 的校验与兼容。"""

    def test_new_fields_default_when_absent(self):
        sections, _ = normalize_sections({"iptv": {}})
        iptv = sections["iptv"]
        self.assertEqual(iptv["packageIds"], [])
        self.assertFalse(iptv["lockLibrary"])
        self.assertEqual(iptv["libraryRevision"], 0)

    def test_package_ids_filter_format_dedup_and_cap(self):
        sections, warnings = normalize_sections({"iptv": {
            "packageIds": ["pkg_1", "bad id!", "pkg_1", "pkg_2"],
        }})
        self.assertEqual(sections["iptv"]["packageIds"], ["pkg_1", "pkg_2"])
        self.assertTrue(any("packageIds" in item for item in warnings))

        ids = ["pkg_%d" % index for index in range(15)]
        sections, warnings = normalize_sections({"iptv": {"packageIds": ids}})
        self.assertEqual(len(sections["iptv"]["packageIds"]), 12)
        self.assertTrue(any("12" in item for item in warnings))

    def test_package_ids_do_not_clear_inline_channels(self):
        """引用库时设备仍可在 channels 里挂自己的频道，与 selectedPackageIds 不同。"""
        sections, _ = normalize_sections({"iptv": {
            "packageIds": ["pkg_1"],
            "channels": [{"name": "own", "url": "http://a/own"}],
        }})
        self.assertEqual([c["url"] for c in sections["iptv"]["channels"]],
                         ["http://a/own"])

    def test_lock_library_and_revision_validation(self):
        sections, _ = normalize_sections({"iptv": {
            "lockLibrary": True, "libraryRevision": 7,
        }})
        self.assertTrue(sections["iptv"]["lockLibrary"])
        self.assertEqual(sections["iptv"]["libraryRevision"], 7)
        with self.assertRaises(ConfigError):
            normalize_sections({"iptv": {"packageIds": "pkg_1"}})
        with self.assertRaises(ConfigError):
            normalize_sections({"iptv": {"lockLibrary": 1}})
        with self.assertRaises(ConfigError):
            normalize_sections({"iptv": {"libraryRevision": "3"}})
        with self.assertRaises(ConfigError):
            normalize_sections({"iptv": {"libraryRevision": -1}})


class LibraryModelTests(unittest.TestCase):
    """全局资源库：空库、id 规则、站点派生、上限与宽松导入。"""

    def test_empty_library_shape(self):
        library = empty_library()
        self.assertEqual(library["schemaVersion"], 1)
        self.assertEqual(library["revision"], 0)
        self.assertEqual(library["updatedAt"], "")
        self.assertEqual(library["iptv"], {"sources": [], "packages": [], "epgUrl": ""})
        self.assertEqual(library["vod"], {"sources": [], "sites": []})

    def test_library_non_object_rejected(self):
        for bad in ("x", 1, [], None):
            with self.assertRaises(ConfigError):
                normalize_library(bad)
        with self.assertRaises(ConfigError):
            normalize_library({"iptv": []})
        with self.assertRaises(ConfigError):
            normalize_library({"vod": []})

    def test_valid_library_keeps_ids_and_derives_site_id(self):
        library, warnings = normalize_library({
            "iptv": {
                "epgUrl": "https://epg.example/e.xml",
                "sources": [{
                    "id": "s_1a2b3c4d", "name": "央视源",
                    "url": "https://a.example/list.m3u", "type": "M3U",
                    "channelCount": 12, "note": "备注",
                }],
                "packages": [{
                    "id": "pkg_1a2b3c4d", "name": "基础包",
                    "sources": ["https://a.example/list.m3u"],
                    "channels": [{"name": "CCTV1", "url": "http://a/1.m3u8",
                                  "group": "央视"}],
                }],
            },
            "vod": {
                "sources": [{"id": "vs_1a2b3c4d", "url": "https://b.example/api.php"}],
                "sites": [{
                    "sourceId": "vs_1a2b3c4d", "key": "csp_X", "name": "测试站点",
                    "api": "csp_X", "type": "1", "searchable": "1", "quickSearch": True,
                }],
            },
        })
        self.assertEqual(warnings, [])
        source = library["iptv"]["sources"][0]
        self.assertEqual(source["id"], "s_1a2b3c4d")
        self.assertEqual(source["type"], "m3u")
        self.assertEqual(source["channelCount"], 12)
        self.assertTrue(source["addedAt"])
        # 套餐里存的订阅 URL 会兼容成 sourceId，避免来源信息丢失。
        self.assertEqual(library["iptv"]["packages"][0]["sources"], ["s_1a2b3c4d"])
        self.assertEqual(library["iptv"]["epgUrl"], "https://epg.example/e.xml")
        site = library["vod"]["sites"][0]
        self.assertEqual(site["id"], "vs_1a2b3c4d:csp_X")
        self.assertEqual(site["type"], 1)
        self.assertEqual(site["searchable"], 1)
        self.assertEqual(site["quickSearch"], 1)

    def test_invalid_library_ids_raise_400(self):
        with self.assertRaises(ConfigError):
            normalize_library({"iptv": {"sources": [{"id": "x_1a2b3c4d",
                                                      "url": "https://a/x.m3u"}]}})
        with self.assertRaises(ConfigError):
            normalize_library({"iptv": {"packages": [{"id": "p1", "channels": []}]}})
        with self.assertRaises(ConfigError):
            normalize_library({"vod": {"sources": [{"id": "vs_XYZ",
                                                     "url": "https://a/api"}]}})

    def test_missing_ids_are_generated_with_prefix(self):
        library, _ = normalize_library({
            "iptv": {"sources": [{"url": "https://a/x.m3u"}],
                     "packages": [{"channels": []}, {"channels": []}]},
            "vod": {"sources": [{"url": "https://b/api"}]},
        })
        self.assertRegex(library["iptv"]["sources"][0]["id"], r"^s_[0-9a-f]{8}$")
        pkg_ids = [pkg["id"] for pkg in library["iptv"]["packages"]]
        self.assertEqual(len(set(pkg_ids)), 2)
        for pkg_id in pkg_ids:
            self.assertRegex(pkg_id, r"^pkg_[0-9a-f]{8}$")
        self.assertRegex(library["vod"]["sources"][0]["id"], r"^vs_[0-9a-f]{8}$")

    def test_invalid_source_url_and_epg_are_dropped_with_warning(self):
        library, warnings = normalize_library({
            "iptv": {
                "epgUrl": "ftp://bad",
                "sources": [{"id": "s_1a2b3c4d", "url": "ftp://bad"}],
            },
        })
        self.assertEqual(library["iptv"]["sources"], [])
        self.assertEqual(library["iptv"]["epgUrl"], "")
        self.assertTrue(any("订阅地址" in item for item in warnings))
        self.assertTrue(any("epgUrl" in item for item in warnings))

    def test_site_with_unknown_source_or_missing_api_ignored(self):
        library, warnings = normalize_library({
            "vod": {
                "sources": [{"id": "vs_1a2b3c4d", "url": "https://b/api"}],
                "sites": [
                    {"sourceId": "vs_ffffffff", "key": "k", "api": "x"},
                    {"sourceId": "vs_1a2b3c4d", "key": "no_api"},
                ],
            },
        })
        self.assertEqual(library["vod"]["sites"], [])
        self.assertTrue(any("未知源" in item for item in warnings))
        self.assertTrue(any("缺少 api" in item for item in warnings))

    def test_site_id_from_other_source_is_rebuilt(self):
        library, _ = normalize_library({
            "vod": {
                "sources": [{"id": "vs_1a2b3c4d", "url": "https://b/api"}],
                "sites": [{
                    "id": "vs_ffffffff:hacked", "sourceId": "vs_1a2b3c4d",
                    "key": "real", "api": "csp_real",
                }],
            },
        })
        self.assertEqual(library["vod"]["sites"][0]["id"], "vs_1a2b3c4d:real")

    def test_library_source_and_package_caps(self):
        sources = [{"id": "s_%08x" % index, "url": "https://a/%d.m3u" % index}
                   for index in range(35)]
        library, warnings = normalize_library({"iptv": {"sources": sources}})
        self.assertEqual(len(library["iptv"]["sources"]), 30)
        self.assertTrue(any("30" in item for item in warnings))

        packages = [{"id": "pkg_%08x" % index, "channels": []} for index in range(15)]
        library, warnings = normalize_library({"iptv": {"packages": packages}})
        self.assertEqual(len(library["iptv"]["packages"]), 12)
        self.assertTrue(any("12" in item for item in warnings))

        vod_sources = [{"id": "vs_%08x" % index, "url": "https://b/%d" % index}
                       for index in range(25)]
        library, warnings = normalize_library({"vod": {"sources": vod_sources}})
        self.assertEqual(len(library["vod"]["sources"]), 20)
        self.assertTrue(any("20" in item for item in warnings))

    def test_library_package_channel_budget_is_5000(self):
        def chans(prefix):
            return [{"name": "c%d" % index, "url": "http://%s/%d" % (prefix, index)}
                    for index in range(MAX_IPTV_CHANNELS)]
        library, warnings = normalize_library({"iptv": {"packages": [
            {"id": "pkg_%08x" % 1, "channels": chans("a")},
            {"id": "pkg_%08x" % 2, "channels": chans("b")},
            {"id": "pkg_%08x" % 3, "channels": chans("c")},
        ]}})
        self.assertEqual([pkg["id"] for pkg in library["iptv"]["packages"]],
                         ["pkg_00000001", "pkg_00000002"])
        self.assertEqual(sum(len(pkg["channels"]) for pkg in library["iptv"]["packages"]),
                         5000)
        self.assertTrue(any("5000" in item for item in warnings))

    def test_library_site_caps_total_and_per_source(self):
        sites = [{"sourceId": "vs_1a2b3c4d", "key": "s%d" % index, "api": "csp"}
                 for index in range(MAX_VOD_SITES_PER_SOURCE + 5)]
        library, warnings = normalize_library({"vod": {
            "sources": [{"id": "vs_1a2b3c4d", "url": "https://b/api"}],
            "sites": sites,
        }})
        self.assertEqual(len(library["vod"]["sites"]), MAX_VOD_SITES_PER_SOURCE)
        self.assertTrue(any("%d 个站点上限" % MAX_VOD_SITES_PER_SOURCE in item
                            for item in warnings))

        many = [{"sourceId": "vs_1a2b3c4d", "key": "k%d" % index, "api": "csp"}
                for index in range(MAX_VOD_SITES + 5)]
        library, warnings = normalize_library({"vod": {
            "sources": [{"id": "vs_1a2b3c4d", "url": "https://b/api"}],
            "sites": many,
        }})
        self.assertLessEqual(len(library["vod"]["sites"]), MAX_VOD_SITES)
        self.assertTrue(any("library.vod.sites" in item for item in warnings))


class ExpandLibraryPriorityTests(unittest.TestCase):
    """expand_iptv_channels 四档优先级：锁定 / 引用库 / 旧逻辑 / 内联频道。"""

    def _library(self):
        return {"iptv": {"packages": [
            {"id": "pkg_00000001", "channels": [
                {"name": "L1", "url": "http://lib/1", "group": "央视"}]},
            {"id": "pkg_00000002", "channels": [
                {"name": "L2", "url": "http://lib/2", "group": "卫视"}]},
        ]}}

    def test_without_library_keeps_old_behaviour(self):
        """回归：不传 library 时 packageIds 被忽略，只走 selectedPackageIds。"""
        sections = {"iptv": {
            "packageIds": ["pkg_00000001"],
            "packages": [{"id": "p1", "channels": [
                {"name": "A", "url": "http://a/a"}]}],
            "selectedPackageIds": ["p1"],
            "channels": [],
        }}
        out = expand_iptv_channels(sections)
        self.assertEqual([c["url"] for c in out["iptv"]["channels"]], ["http://a/a"])

    def test_package_ids_use_library_in_order(self):
        sections = {"iptv": {
            "packageIds": ["pkg_00000002", "pkg_00000001"], "channels": [],
        }}
        out = expand_iptv_channels(sections, self._library())
        self.assertEqual([c["url"] for c in out["iptv"]["channels"]],
                         ["http://lib/2", "http://lib/1"])
        self.assertEqual(out["iptv"]["groups"], ["卫视", "央视"])

    def test_locked_device_ignores_library(self):
        sections = {"iptv": {
            "lockLibrary": True,
            "packageIds": ["pkg_00000001", "pkg_00000002"],
            "channels": [{"name": "frozen", "url": "http://frozen/1"}],
        }}
        out = expand_iptv_channels(sections, self._library())
        self.assertEqual([c["url"] for c in out["iptv"]["channels"]],
                         ["http://frozen/1"])

    def test_locked_device_expands_inline_packages(self):
        sections = {"iptv": {
            "lockLibrary": True,
            "packageIds": ["pkg_00000001"],
            "packages": [{"id": "p1", "channels": [
                {"name": "A", "url": "http://a/a"}]}],
            "selectedPackageIds": ["p1"],
            "channels": [],
        }}
        out = expand_iptv_channels(sections, self._library())
        self.assertEqual([c["url"] for c in out["iptv"]["channels"]], ["http://a/a"])

    def test_unknown_package_ids_fall_back_to_old_logic(self):
        sections = {"iptv": {
            "packageIds": ["pkg_deadbeef"],
            "packages": [{"id": "p1", "channels": [
                {"name": "A", "url": "http://a/a"}]}],
            "selectedPackageIds": ["p1"],
            "channels": [],
        }}
        out = expand_iptv_channels(sections, self._library())
        self.assertEqual([c["url"] for c in out["iptv"]["channels"]], ["http://a/a"])

    def test_inline_channels_appended_and_deduped(self):
        sections = {"iptv": {
            "packageIds": ["pkg_00000001"],
            "channels": [
                {"name": "dup", "url": "HTTP://LIB/1"},
                {"name": "own", "url": "http://own/1"},
            ],
        }}
        out = expand_iptv_channels(sections, self._library())
        self.assertEqual([c["url"] for c in out["iptv"]["channels"]],
                         ["http://lib/1", "http://own/1"])

    def test_library_merge_capped_at_3000(self):
        chans1 = [{"name": "a%d" % index, "url": "http://a/%d" % index}
                  for index in range(2000)]
        chans2 = [{"name": "b%d" % index, "url": "http://b/%d" % index}
                  for index in range(2000)]
        library = {"iptv": {"packages": [
            {"id": "pkg_00000001", "channels": chans1},
            {"id": "pkg_00000002", "channels": chans2},
        ]}}
        out = expand_iptv_channels(
            {"iptv": {"packageIds": ["pkg_00000001", "pkg_00000002"]}}, library)
        self.assertEqual(len(out["iptv"]["channels"]), MAX_IPTV_CHANNELS)

    def test_library_expand_does_not_mutate_inputs(self):
        library = self._library()
        sections = {"iptv": {"packageIds": ["pkg_00000001"], "channels": []}}
        out = expand_iptv_channels(sections, library)
        self.assertEqual(sections["iptv"]["channels"], [])
        out["iptv"]["channels"].append({"name": "z", "url": "http://z/1"})
        self.assertEqual(len(library["iptv"]["packages"][0]["channels"]), 1)


if __name__ == "__main__":
    unittest.main()
