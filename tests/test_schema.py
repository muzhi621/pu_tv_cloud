"""配置契约校验测试，对应需求文档 4.3 / 4.4。"""
from __future__ import annotations

import unittest

from cloud.schema import (
    ConfigError,
    VALID_MENU_IDS,
    VALID_SITE_IDS,
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


if __name__ == "__main__":
    unittest.main()
