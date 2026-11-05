"""Offline wind contract tests; no local environment secrets or network are loaded."""
import importlib
import unittest
from types import SimpleNamespace
from unittest.mock import patch
from fastapi.testclient import TestClient

with patch("dotenv.load_dotenv"), patch.dict("os.environ", {"SUPABASE_URL": "", "WIND_SUPABASE_URL": ""}), patch("supabase.create_client"):
    main = importlib.import_module("backend.app.main")

class Query:
    def __init__(self, db): self.db = db
    def __getattr__(self, method):
        def call(*args, **kwargs):
            self.db.calls.append((method, args, kwargs))
            return SimpleNamespace(data=self.db.rows) if method == "execute" else self
        return call
class DB:
    def __init__(self): self.calls = []; self.rows = []
    def table(self, name): self.calls.append(("table", (name,), {})); return Query(self)

class WindTests(unittest.TestCase):
    def setUp(self):
        self.db = DB()
        self.patcher = patch.object(main, "wind_supabase", self.db)
        self.patcher.start(); self.addCleanup(self.patcher.stop)
        self.client = TestClient(main.app); self.addCleanup(self.client.close)
    def test_filtered_bounded_page_preserves_failures(self):
        self.db.rows = [{"id": 1, "status": "FAILED", "actual_pulses": 0}, {"id": 2, "status": "SUCCESS"}]
        r = self.client.get("/api/wind", params={"device_id": "B", "start_date": "2026-11-01", "end_date": "2026-11-02", "offset": 10, "limit": 1})
        self.assertEqual(r.status_code, 200); self.assertEqual(r.json()["rows"][0]["status"], "FAILED"); self.assertTrue(r.json()["has_more"])
        self.assertIn(("range", (10, 11), {}), self.db.calls)
        self.assertIn(("eq", ("device_id", "B"), {}), self.db.calls)
        self.assertIn(("gte", ("recorded_at", "2026-10-31T18:30:00+00:00"), {}), self.db.calls)
        self.assertFalse(any(args and args[0] == "status" for _, args, _ in self.db.calls))
    def test_bad_ranges_are_client_errors(self):
        for params in [{"start_date": "bad"}, {"start_date": "0001-01-01", "end_date": "0001-01-02"}, {"start_date": "20261101"}, {"start_date": "2026-02-30"}, {"start_date": "2026-11-03", "end_date": "2026-11-02"}, {"start_date": "2020-01-01"}, {"offset": -1}, {"limit": 51}]:
            self.assertIn(self.client.get("/api/wind", params=params).status_code, (400, 422))
        self.assertEqual(self.db.calls, [])
    def test_options_come_from_logs(self):
        self.db.rows = [{"device_id": "B"}, {"device_id": "A"}, {"device_id": "B"}]
        r = self.client.get("/api/wind?include_devices=true")
        self.assertEqual(r.json()["devices"], ["A", "B"])
        self.assertTrue(all(args == ("wind_operation_logs",) for method, args, _ in self.db.calls if method == "table"))
    def test_dashboard_keeps_legacy_detections_and_returns_wind_failure(self):
        self.db.rows = [{"id": 1, "status": "FAILED", "device_id": "B"}]
        with patch.object(main, "read_detections", return_value=[]) as detections, patch.object(main, "require_supabase"), patch.object(main, "image_page", return_value={"rows": [], "has_more": False}):
            response = self.client.get("/api/dashboard")
        self.assertEqual(response.status_code, 200)
        detections.assert_called_once()
        self.assertEqual(response.json()["wind_history"][0]["status"], "FAILED")
        self.assertTrue(all(args == ("wind_operation_logs",) for method, args, _ in self.db.calls if method == "table"))

    def test_missing_wind_never_uses_legacy(self):
        with patch.object(main, "wind_supabase", None):
            self.assertEqual(self.client.get("/api/wind").status_code, 503)

if __name__ == "__main__": unittest.main()
