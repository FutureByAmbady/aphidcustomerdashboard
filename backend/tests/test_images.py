"""Image-source routing regressions. All storage/database clients are fake."""
import importlib
import unittest
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import Mock, patch
from fastapi.testclient import TestClient

with patch("dotenv.load_dotenv"), patch.dict("os.environ", {"SUPABASE_URL": "", "IMAGE_SUPABASE_URL": "", "IMAGE_SUPABASE_SECRET_KEY": "", "WIND_SUPABASE_URL": ""}), patch("supabase.create_client"):
    main = importlib.import_module("backend.app.main")

class FakeQuery:
    def __init__(self, owner): self.owner = owner
    def __getattr__(self, name):
        def call(*args, **kwargs):
            self.owner.calls.append((name, args, kwargs))
            if name == "execute":
                if self.owner.error: raise RuntimeError("private upstream failure")
                return SimpleNamespace(data=self.owner.rows)
            return self
        return call
class FakeClient:
    def __init__(self):
        self.calls = []; self.rows = []; self.error = False
        self.storage = Mock()
        self.storage.from_.return_value.get_public_url.side_effect = lambda path: "https://images.invalid/storage/v1/object/public/monitoring-images/" + path
    def table(self, table):
        self.calls.append(("table", (table,), {})); return FakeQuery(self)

class ImagesTests(unittest.TestCase):
    def setUp(self):
        self.images = FakeClient()
        self.legacy = Mock()
        self.patches = [patch.object(main, "IMAGE_SUPABASE_URL", "https://images.invalid"), patch.object(main, "IMAGE_SUPABASE_KEY", "test-image-key"), patch.object(main, "image_supabase", self.images), patch.object(main, "supabase", self.legacy), patch.object(main, "SUPABASE_BUCKET", "monitoring-images")]
        for p in self.patches: p.start(); self.addCleanup(p.stop)
        self.client = TestClient(main.app); self.addCleanup(self.client.close)
    def test_reads_only_dedicated_detection_client(self):
        now = datetime.now(timezone.utc)
        main.read_detections(now - timedelta(days=1), now)
        self.assertIn(("table", ("detections",), {}), self.images.calls)
        self.legacy.table.assert_not_called()
        self.assertIn(("eq", ("device_id", main.DEVICE_ID), {}), self.images.calls)
    def test_dashboard_resolves_paths_using_image_storage_not_legacy(self):
        self.images.rows = [{"captured_at": datetime.now(timezone.utc).isoformat(), "insect_count": 2, "result_image_url": "device/result.jpg", "original_image_url": "https://existing.invalid/original.jpg"}]
        with patch.object(main, "wind_page", return_value={"rows": [], "has_more": False}), patch.object(main, "read_health", return_value={}):
            response = self.client.get("/api/dashboard")
        self.assertEqual(response.status_code, 200)
        latest = response.json()["latest_detection"]
        self.assertEqual(latest["result_image_url"], "https://images.invalid/storage/v1/object/public/monitoring-images/device/result.jpg")
        self.assertEqual(latest["original_image_url"], "https://existing.invalid/original.jpg")
        self.legacy.table.assert_not_called(); self.legacy.storage.from_.assert_not_called()
    def test_empty_new_project_returns_honest_empty_history(self):
        with patch.object(main, "wind_page", return_value={"rows": [], "has_more": False}), patch.object(main, "read_health", return_value={}):
            response = self.client.get("/api/dashboard")
        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload["recent_detections"], []); self.assertIsNone(payload["latest_detection"])
        self.assertEqual(payload["trend"], []); self.assertEqual(payload["kpis"]["activity"]["label"], "Not enough data")
    def test_legacy_fallback_when_image_config_absent(self):
        with patch.object(main, "IMAGE_SUPABASE_URL", ""), patch.object(main, "IMAGE_SUPABASE_KEY", ""):
            self.assertIs(main.require_image_supabase(), self.legacy)
        self.assertIs(main.require_supabase(), self.legacy)
    def test_partial_config_fails_without_mixing_credentials(self):
        with patch.object(main, "IMAGE_SUPABASE_KEY", ""), patch.object(main, "image_supabase", None):
            with self.assertRaises(main.HTTPException) as error: main.require_image_supabase()
            self.assertEqual(error.exception.status_code, 503)
        self.legacy.table.assert_not_called()
    def test_upstream_failure_does_not_fall_back(self):
        self.images.error = True
        with self.assertRaises(main.HTTPException) as error:
            main.read_detections(datetime.now(timezone.utc), datetime.now(timezone.utc))
        self.assertEqual(error.exception.status_code, 502); self.assertNotIn("private", error.exception.detail)
        self.legacy.table.assert_not_called()

if __name__ == "__main__": unittest.main()
