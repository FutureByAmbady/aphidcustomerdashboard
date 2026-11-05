import io
import unittest
from PIL import Image
import importlib.util
from pathlib import Path
spec = importlib.util.spec_from_file_location('thumbnails', Path(__file__).with_name('prepare-thumbnails.py'))
module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
class ThumbnailTests(unittest.TestCase):
    def test_small_jpeg_and_original_unchanged(self):
        stream = io.BytesIO(); Image.new('RGBA', (2400,1800), 'red').save(stream, 'PNG')
        original = stream.getvalue(); thumbnail = module.make_thumbnail(original)
        with Image.open(io.BytesIO(thumbnail)) as image:
            self.assertEqual(image.size, (480,360)); self.assertEqual(image.format, 'JPEG')
        self.assertEqual(original, stream.getvalue())
        self.assertLess(len(thumbnail), len(original))
    def test_separate_namespace_and_traversal_rejected(self):
        self.assertEqual(module.thumbnail_path('device/a.png'), 'thumbnails/v2/device/a.jpg')
        for path in ['thumbnails/v2/a.jpg','../a.jpg','device/../a.jpg','/a.jpg']:
            with self.assertRaises(ValueError): module.thumbnail_path(path)
if __name__ == '__main__': unittest.main()
