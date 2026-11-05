"""Focused offline image pagination/cache tests."""
from test_images import ImagesTests, main
from unittest.mock import patch

class EgressTests(ImagesTests):
    def setUp(self):
        super().setUp()
        main._metadata_cache.clear()
    def tearDown(self):
        main._metadata_cache.clear()
    def test_server_page_lookahead_and_thumbnails(self):
        self.images.rows = [{"id": 1, "original_image_url": "a.png"}, {"id": 2}, {"id": 3}]
        response = self.client.get('/api/images?start_date=2026-11-01&end_date=2026-11-02&offset=4&limit=2')
        self.assertEqual(response.status_code, 200)
        result = response.json()
        self.assertEqual(len(result['rows']), 2); self.assertTrue(result['has_more'])
        self.assertIn('/thumbnails/v2/a.jpg', result['rows'][0]['thumbnail_url'])
        self.assertIn(('range', (4, 6), {}), self.images.calls)
        self.assertIn(('select', (main.DETECTION_COLUMNS,), {}), self.images.calls)
        count = len(self.images.calls)
        self.client.get('/api/images?start_date=2026-11-01&end_date=2026-11-02&offset=4&limit=2')
        self.assertEqual(len(self.images.calls), count)
    def test_invalid_page_never_queries(self):
        for query in ['limit=51','offset=-1','start_date=2026-02-30']:
            self.assertIn(self.client.get('/api/images?'+query).status_code, (400,422))
        self.assertEqual(self.images.calls, [])
    def test_summary_selects_only_scalars(self):
        from datetime import datetime, timezone
        main.read_detections(datetime.now(timezone.utc), datetime.now(timezone.utc))
        self.assertIn(('select', ('captured_at,insect_count',), {}), self.images.calls)
    def test_cache_expiry_and_copy_isolation(self):
        from unittest.mock import Mock
        loader=Mock(return_value=[{'id':1}])
        with patch.object(main, 'monotonic', return_value=0):
            value=main.cached_metadata(('test',),loader); value[0]['id']=9
            self.assertEqual(main.cached_metadata(('test',),loader)[0]['id'],1)
        with patch.object(main, 'monotonic', return_value=301):
            main.cached_metadata(('test',),loader)
        self.assertEqual(loader.call_count,2)
