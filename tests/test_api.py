"""配置服务 API 测试，对应需求文档 FR-01 与验收 AC-14~AC-16。"""
from __future__ import annotations

import json
import tempfile
import unittest

from cloud.app import create_app
from cloud.schema import VALID_SITE_IDS
from cloud.storage import FileStorage
from tests.helpers import call, json_body


class ApiTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.storage = FileStorage(self.tmp.name)
        self.app = create_app(
            env={"CONFIG_STORAGE_BACKEND": "file", "CONFIG_DATA_DIR": self.tmp.name},
            storage=self.storage,
        )

    def tearDown(self):
        self.tmp.cleanup()

    def _payload(self):
        return {"sections": {"sites": {"managed": True, "enabledSiteIds": ["bilibili", "huya", "iptv"]}}}

    def test_health_and_seed(self):
        status, _, body = call(self.app, "GET", "/health")
        self.assertTrue(status.startswith("200"))
        self.assertTrue(json.loads(body)["devMode"])

        status, headers, body = call(self.app, "GET", "/api/config")
        doc = json.loads(body)
        self.assertTrue(status.startswith("200"))
        self.assertEqual(doc["revision"], 0)
        self.assertEqual(headers["X-Revision"], "0")
        self.assertEqual(headers["ETag"], '"0"')
        self.assertEqual(headers["X-Schema-Version"], "1")
        for section in doc["sections"].values():
            self.assertFalse(section["managed"])

    def test_304_via_since_and_if_none_match(self):
        status, headers, body = call(self.app, "GET", "/api/config", query="since=0")
        self.assertTrue(status.startswith("304"))
        self.assertEqual(body, b"")
        self.assertEqual(headers["ETag"], '"0"')
        status, _, _ = call(self.app, "GET", "/api/config", headers={"If-None-Match": '"0"'})
        self.assertTrue(status.startswith("304"))

    def test_gzip_when_accepted(self):
        status, headers, body = call(self.app, "GET", "/api/config/catalog",
                                     headers={"Accept-Encoding": "gzip"})
        self.assertEqual(headers["Content-Encoding"], "gzip")
        self.assertEqual(len(json.loads(body)["sites"]), 35)

    def test_put_requires_explicit_revision(self):
        status, _, body = json_body(self.app, "PUT", "/api/config", self._payload())
        self.assertTrue(status.startswith("400"))
        self.assertIn("If-Match", json.loads(body)["message"])

    def test_put_then_conflict_then_current_revision(self):
        status, headers, body = json_body(
            self.app, "PUT", "/api/config", self._payload(), headers={"If-Match": "0"})
        self.assertTrue(status.startswith("200"))
        result = json.loads(body)
        self.assertEqual(result["revision"], 1)
        self.assertEqual(headers["X-Revision"], "1")

        status, _, body = json_body(
            self.app, "PUT", "/api/config", self._payload(), headers={"If-Match": "0"})
        self.assertTrue(status.startswith("409"))
        conflict = json.loads(body)
        self.assertEqual(conflict["currentRevision"], 1)
        self.assertEqual(conflict["document"]["sections"]["sites"]["enabledSiteIds"],
                         ["bilibili", "huya", "iptv"])

        status, _, body = call(self.app, "GET", "/api/config", query="since=0")
        self.assertTrue(status.startswith("200"))
        self.assertEqual(json.loads(body)["revision"], 1)

    def test_put_invalid_config_returns_400_and_does_not_change_revision(self):
        status, _, _ = json_body(
            self.app, "PUT", "/api/config",
            {"sections": {"update": {"prompt": "unknown"}}},
            headers={"If-Match": "0"})
        self.assertTrue(status.startswith("400"))
        self.assertEqual(self.storage.read()["revision"], 0)

    def test_unknown_site_ids_filtered_and_empty_fallback(self):
        status, _, body = json_body(
            self.app, "PUT", "/api/config",
            {"sections": {"sites": {"managed": True, "enabledSiteIds": ["douyu", "alien"]}}},
            headers={"If-Match": "0"})
        self.assertIn("alien", str(json.loads(body)["warnings"]))
        doc = self.storage.read()
        self.assertEqual(doc["sections"]["sites"]["enabledSiteIds"], ["douyu"])

        status, _, body = json_body(
            self.app, "PUT", "/api/config",
            {"sections": {"sites": {"managed": True, "enabledSiteIds": []}}},
            headers={"If-Match": "1"})
        self.assertTrue(status.startswith("200"))
        self.assertEqual(self.storage.read()["sections"]["sites"]["enabledSiteIds"],
                         list(VALID_SITE_IDS))

    def test_revisions_and_rollback(self):
        for revision in range(2):
            status, _, _ = json_body(
                self.app, "PUT", "/api/config",
                {"sections": {"update": {"managed": True, "checkIntervalHours": 12 + revision}}},
                headers={"If-Match": str(revision)})
            self.assertTrue(status.startswith("200"))

        status, _, body = call(self.app, "GET", "/api/config/revisions")
        revisions = json.loads(body)["revisions"]
        self.assertEqual([item["revision"] for item in revisions], [2, 1])

        status, _, body = json_body(self.app, "POST", "/api/config/rollback", {"revision": 1})
        self.assertTrue(status.startswith("200"))
        self.assertEqual(json.loads(body)["revision"], 3)
        doc = self.storage.read()
        self.assertEqual(doc["sections"]["update"]["checkIntervalHours"], 12)

    def test_static_editor_is_served(self):
        for path, marker in [("/", "云端配置编辑器"), ("/app.js", "use strict"), ("/style.css", ":root")]:
            status, _, body = call(self.app, "GET", path)
            self.assertTrue(status.startswith("200"), path)
            self.assertIn(marker, body.decode("utf-8"))

    def test_auth_and_method_errors(self):
        guarded = create_app(
            env={"CONFIG_READ_TOKEN": "read-token", "CONFIG_WRITE_TOKEN": "write-token",
                 "CONFIG_STORAGE_BACKEND": "file", "CONFIG_DATA_DIR": self.tmp.name},
            storage=self.storage,
        )
        status, _, _ = call(guarded, "GET", "/api/config")
        self.assertTrue(status.startswith("401"))
        status, _, _ = call(guarded, "GET", "/api/config",
                            headers={"Authorization": "Bearer read-token"})
        self.assertTrue(status.startswith("200"))
        status, _, _ = json_body(
            guarded, "PUT", "/api/config", self._payload(),
            headers={"Authorization": "Bearer read-token", "If-Match": "0"})
        self.assertTrue(status.startswith("401"))
        status, _, _ = call(guarded, "POST", "/api/config")
        self.assertTrue(status.startswith("405"))
        status, _, _ = call(guarded, "GET", "/api/unknown")
        self.assertTrue(status.startswith("404"))


if __name__ == "__main__":
    unittest.main()
