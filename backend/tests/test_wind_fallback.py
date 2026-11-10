import unittest
from datetime import datetime, timezone
from backend.app.wind_timeline import combined_wind_page

class WindFallbackTests(unittest.TestCase):
    def row(self, hour, id=1, **extra):
        return dict(id=id, device_id="A", recorded_at=f"2026-11-01T{hour:02d}:00:00+05:30", wind_direction="N", wind_angle=0, **extra)
    def page(self, primary, operation, **kw):
        def load(table, offset, limit, *args):
            rows = primary if table == "wind_data" else operation
            if isinstance(rows, Exception): raise rows
            return rows[offset:offset+limit]
        return combined_wind_page(load, kw.get("device", ""), kw.get("start"), kw.get("end"), kw.get("offset",0), kw.get("limit",50), "*")
    def test_primary_wins_and_partial_gaps(self):
        p=self.page([self.row(12),self.row(10)], [self.row(h) for h in [13,12,11,10,9]])
        self.assertEqual([(r["recorded_at"][11:13],r["source"]) for r in p["rows"]],[("13","wind_operation_logs"),("12","wind_data"),("11","wind_operation_logs"),("10","wind_data"),("09","wind_operation_logs")])
    def test_preserve_distinct_primary_and_deduplicate(self):
        row=self.row(10); later={**row,"id":2,"recorded_at":"2026-11-01T10:30:00+05:30"}
        p=self.page([later,row,row],[self.row(10),self.row(9),self.row(9)])
        self.assertEqual(len(p["rows"]),3)
        self.assertEqual([r["source"] for r in p["rows"]],["wind_data","wind_data","wind_operation_logs"])
    def test_empty_and_operation_only(self):
        self.assertEqual(self.page([],[])["rows"],[])
        self.assertEqual(self.page([],[self.row(9)])["rows"][0]["source"],"wind_operation_logs")
    def test_invalid_primary_and_failure_operation(self):
        bad={**self.row(10),"wind_angle":None,"wind_direction":"-"}
        operation={**bad,"status":"SENSOR_NO_DATA"}
        p=self.page([None,bad],[operation])
        self.assertEqual(p["rows"][0]["record_kind"],"operation")
        self.assertIsNone(p["rows"][0]["wind_angle"])
    def test_filters_devices_and_paging(self):
        rows=[self.row(h,id=h) for h in [13,12,11,10,9]]
        p=self.page(rows,[],start=datetime.fromisoformat("2026-11-01T10:00:00+05:30"),end=datetime.fromisoformat("2026-11-01T13:00:00+05:30"),offset=1,limit=1)
        self.assertEqual(p["rows"][0]["id"],11); self.assertTrue(p["has_more"])
        self.assertEqual(self.page(rows,[],device="B")["rows"],[])
    def test_query_failures(self):
        p=self.page(RuntimeError("secret"),[self.row(9)])
        self.assertTrue(p["partial"]); self.assertTrue(p["rows"][0]["priority_unverified"])
        self.assertNotIn("secret",p["warning"])
        p=self.page([self.row(10)],RuntimeError("secret"))
        self.assertEqual(p["rows"][0]["source"],"wind_data"); self.assertTrue(p["partial"])
        self.assertTrue(self.page(RuntimeError(),RuntimeError())["partial"])
    def test_primary_beyond_first_database_page(self):
        rows=[{**self.row(10,id=i),"recorded_at":f"2026-11-01T10:30:{i%60:02d}+05:30"} for i in range(120)] + [self.row(9)]
        p=self.page(rows,[self.row(10),self.row(9)],offset=59,limit=2)
        self.assertTrue(all(r["source"]=="wind_data" for r in p["rows"]))
