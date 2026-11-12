"""配置契约校验测试，对应需求文档 4.3 / 4.4。"""
from __future__ import annotations

import unittest

from cloud.schema import (
    ConfigError,
    MAX_IPTV_CHANNELS,
    VALID_MENU_IDS,
    VALID_SITE_IDS,
    expand_iptv_channels,
    normalize_document,
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
        self.assertEqual(set(sections), {"sites", "navigation", "startup", "update", "iptv"})
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


if __name__ == "__main__":
    unittest.main()
