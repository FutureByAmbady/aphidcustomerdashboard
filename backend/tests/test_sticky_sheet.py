"""Offline tests: no secrets, database connections, or hardware actions."""
import importlib
import os
import unittest
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import Mock, patch
from uuid import uuid4

from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend.app.sticky_sheet import REQUEST_COLUMNS, STATE_COLUMNS, create_router


class FakeQuery:
    def __init__(self, owner, table):
        self.owner = owner
        self.table = table

    def record(self, method, *args, **kwargs):
        self.owner.calls.append((self.table, method, args, kwargs))
        return self

    def select(self, *args, **kwargs):
        return self.record("select", *args, **kwargs)

    def eq(self, *args, **kwargs):
        return self.record("eq", *args, **kwargs)

    def limit(self, *args, **kwargs):
        return self.record("limit", *args, **kwargs)

    def order(self, *args, **kwargs):
        return self.record("order", *args, **kwargs)

    def execute(self):
        self.record("execute")
        if self.owner.error:
            raise RuntimeError("private database error")
        return SimpleNamespace(data=self.owner.rows.get(self.table, []))


class FakeClient:
    def __init__(self):
        self.calls = []
        self.rows = {}
        self.error = False
        self.rpc_calls = []
        self.rpc_row = {"status": "pending"}

    def table(self, table):
        self.calls.append((table, "table", (), {}))
        return FakeQuery(self, table)

    def rpc(self, name, params):
        self.rpc_calls.append((name, params))
        return self

    def execute(self):
        if self.error:
            raise RuntimeError("private database error")
        return SimpleNamespace(data=self.rpc_row)


class StickySheetTests(unittest.TestCase):
    def setUp(self):
        self.environment = patch.dict(os.environ, {
            "STICKY_SHEET_REPLACEMENT_ENABLED": "true",
            "STICKY_SHEET_REPLACEMENT_TOKEN": "test-only-token",
        })
        self.environment.start()
        self.addCleanup(self.environment.stop)
        self.db = FakeClient()
        self.provider = Mock(return_value=self.db)
        app = FastAPI()
        app.include_router(create_router(self.provider, "PI5-001"))
        self.client = TestClient(app)
        self.addCleanup(self.client.close)
        self.body = {
            "device_id": "PI5-001", "request_id": str(uuid4()),
            "requested_at": datetime.now(timezone.utc).isoformat(),
            "action": "register_new_sticky_sheet",
        }
        self.auth = {"Authorization": "Bearer test-only-token"}

    def post(self, **changes):
        return self.client.post("/api/sticky-sheet", json={**self.body, **changes}, headers=self.auth)

    def test_disabled_gate_does_not_touch_database(self):
        for flag, token in [("false", "test-only-token"), ("True", "test-only-token"),
                            ("true", ""), ("true", "   "), ("", "test-only-token")]:
            with self.subTest(flag=flag, token=token), patch.dict(os.environ, {
                "STICKY_SHEET_REPLACEMENT_ENABLED": flag,
                "STICKY_SHEET_REPLACEMENT_TOKEN": token,
            }):
                response = self.client.get("/api/sticky-sheet")
                self.assertEqual(response.status_code, 200)
                self.assertEqual(response.json(), {
                    "device_id": "PI5-001", "enabled": False, "state": None, "request": None,
                })
                self.assertEqual(self.post().status_code, 503)
        self.provider.assert_not_called()

    def test_missing_environment_disables(self):
        with patch.dict(os.environ, {}, clear=True):
            self.assertFalse(self.client.get("/api/sticky-sheet").json()["enabled"])
            self.assertEqual(self.post().status_code, 503)
        self.provider.assert_not_called()

    def test_get_empty_optional_rows(self):
        response = self.client.get("/api/sticky-sheet")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {
            "device_id": "PI5-001", "enabled": True, "state": None, "request": None,
        })

    def test_get_reads_only_scoped_latest_rows(self):
        state = {"device_id": "PI5-001", "registered_at": None, "completed_advances": 3}
        row = {**self.body, "status": "completed", "acknowledged_at": None, "error_code": None}
        self.db.rows = {"sticky_sheet_state": [state], "sticky_sheet_replacement_requests": [row]}
        response = self.client.get("/api/sticky-sheet")
        self.assertEqual(response.json()["state"], state)
        self.assertEqual(response.json()["request"], row)
        for table, columns in [("sticky_sheet_state", STATE_COLUMNS),
                               ("sticky_sheet_replacement_requests", REQUEST_COLUMNS)]:
            self.assertIn((table, "select", (columns,), {}), self.db.calls)
            self.assertIn((table, "eq", ("device_id", "PI5-001"), {}), self.db.calls)
            self.assertIn((table, "limit", (1,), {}), self.db.calls)
        self.assertIn(("sticky_sheet_replacement_requests", "order", ("created_at",), {"desc": True}), self.db.calls)
        self.assertFalse(self.db.rpc_calls)

    def test_get_database_failure_is_generic_503(self):
        self.db.error = True
        response = self.client.get("/api/sticky-sheet")
        self.assertEqual(response.status_code, 503)
        self.assertNotIn("private", response.text)

    def test_unconfigured_client_is_generic_503(self):
        self.provider.side_effect = RuntimeError("secret service settings")
        for response in [self.client.get("/api/sticky-sheet"), self.post()]:
            self.assertEqual(response.status_code, 503)
            self.assertNotIn("secret", response.text)

    def test_auth_required_before_body_or_database(self):
        for authorization in [None, "", "Basic test-only-token", "Bearer wrong", "Bearer", "Bearer test-only-token extra", "Bearer tøkén"]:
            with self.subTest(authorization=authorization):
                headers = {} if authorization is None else {"Authorization": authorization}
                # HTTP headers are ASCII, so use UTF-8 bytes for the non-ASCII case.
                if authorization and not authorization.isascii():
                    headers = {b"Authorization": authorization.encode("utf-8")}
                response = self.client.post("/api/sticky-sheet", content="not-json", headers=headers)
                self.assertEqual(response.status_code, 401)
                self.assertNotIn("test-only-token", response.text)
        self.provider.assert_not_called()

    def test_valid_request_uses_only_rpc_with_default_retry(self):
        self.db.rpc_row = {**self.body, "status": "pending"}
        response = self.post()
        self.assertEqual(response.status_code, 202)
        self.assertEqual(response.json(), {"request": self.db.rpc_row})
        self.assertEqual(self.db.rpc_calls, [("register_sticky_sheet_replacement", {
            "p_device_id": "PI5-001", "p_request_id": self.body["request_id"],
            "p_requested_at": self.body["requested_at"], "p_retry": False,
        })])
        self.assertFalse(self.db.calls)

    def test_completed_returns_200(self):
        self.db.rpc_row = {**self.body, "status": "completed"}
        self.assertEqual(self.post().status_code, 200)

    def test_retry_reuses_same_id_after_failure(self):
        self.db.error = True
        first = self.post()
        self.assertEqual(first.status_code, 503)
        self.assertNotIn("private", first.text)
        self.db.error = False
        self.assertEqual(self.post(retry=True).status_code, 202)
        self.assertEqual(self.db.rpc_calls[0][1]["p_request_id"], self.db.rpc_calls[1][1]["p_request_id"])
        self.assertTrue(self.db.rpc_calls[1][1]["p_retry"])

    def test_invalid_fields_are_400_without_database(self):
        invalid = [
            {"device_id": "PI5-002"}, {"device_id": None}, {"request_id": "not-uuid"},
            {"request_id": 12}, {"requested_at": "2026-10-31T10:00:00"},
            {"requested_at": "invalid"}, {"requested_at": 12},
            {"requested_at": (datetime.now(timezone.utc) + timedelta(minutes=6)).isoformat()},
            {"action": "advance"}, {"retry": "true"}, {"retry": 1},
            {"retry": None}, {"extra": "field"},
        ]
        for changes in invalid:
            with self.subTest(changes=changes):
                self.assertEqual(self.post(**changes).status_code, 400)
        self.provider.assert_not_called()

    def test_missing_fields_and_nonobject_json_are_400(self):
        for key in self.body:
            body = {k: v for k, v in self.body.items() if k != key}
            self.assertEqual(self.client.post("/api/sticky-sheet", json=body, headers=self.auth).status_code, 400)
        for body in [None, [], "text", 123, True]:
            self.assertEqual(self.client.post("/api/sticky-sheet", json=body, headers=self.auth).status_code, 400)
        self.assertEqual(self.client.post("/api/sticky-sheet", content="{", headers=self.auth).status_code, 400)
        self.provider.assert_not_called()

    def test_timezone_formats_and_near_future_are_allowed(self):
        for timestamp in ["2026-01-01T10:00:00Z", "2026-01-01T15:30:00+05:30",
                          (datetime.now(timezone.utc) + timedelta(minutes=4)).isoformat()]:
            self.assertEqual(self.post(requested_at=timestamp, retry=False).status_code, 202)

    def test_malformed_rpc_response_is_generic_503(self):
        for data in [None, [], [{"status": "pending"}], {}, {"status": None}]:
            self.db.rpc_row = data
            self.assertEqual(self.post().status_code, 503)

    def test_malformed_read_response_is_generic_503(self):
        self.db.rows["sticky_sheet_state"] = "unexpected"
        self.assertEqual(self.client.get("/api/sticky-sheet").status_code, 503)

    def test_main_router_and_cors_wiring_without_loading_dotenv(self):
        # Block .env loading before importing main, and remove ambient credentials.
        with patch.dict(os.environ, {}, clear=True), patch("dotenv.load_dotenv"):
            main = importlib.import_module("backend.app.main")
            with TestClient(main.app) as client:
                response = client.get("/api/sticky-sheet")
                self.assertEqual(response.status_code, 200)
                self.assertFalse(response.json()["enabled"])
                preflight = client.options("/api/sticky-sheet", headers={
                    "Origin": "http://localhost:5173",
                    "Access-Control-Request-Method": "POST",
                    "Access-Control-Request-Headers": "authorization,content-type",
                })
                self.assertEqual(preflight.status_code, 200)
                self.assertIn("POST", preflight.headers["access-control-allow-methods"])
                self.assertIn("Authorization", preflight.headers["access-control-allow-headers"])


if __name__ == "__main__":
    unittest.main()
