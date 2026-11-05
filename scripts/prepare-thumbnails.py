"""Prepare a bounded page of thumbnails, never scan Storage or overwrite objects.
Default is a dry run. Credentials come from the process environment only.
Requires Pillow. Use --apply only after reviewing the dry-run output.
"""
import argparse
import io
import json
import os
import re
from datetime import date, timedelta
from urllib.error import HTTPError
from urllib.parse import quote, urlencode, urlsplit, unquote
from urllib.request import Request, urlopen, HTTPRedirectHandler, build_opener

MAX_BYTES = 25 * 1024 * 1024

class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def thumbnail_path(path):
    if path.startswith('thumbnails/') or any(p in ('', '.', '..') for p in path.split('/')):
        raise ValueError('Not an original image path')
    return 'thumbnails/v1/' + re.sub(r'\.[^/.]+$', '.jpg', path)


def make_thumbnail(raw):
    from PIL import Image, ImageOps
    with Image.open(io.BytesIO(raw)) as image:
        image = ImageOps.exif_transpose(image)
        image.thumbnail((480, 360))
        output = io.BytesIO()
        image.convert('RGB').save(output, 'JPEG', quality=65, optimize=True)
        return output.getvalue()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--start-date', required=True)
    parser.add_argument('--end-date', required=True)
    parser.add_argument('--limit', type=int, default=20, choices=range(1, 51), metavar='1..50')
    parser.add_argument('--offset', type=int, default=0)
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    first, last = date.fromisoformat(args.start_date), date.fromisoformat(args.end_date)
    if first > last or (last - first).days > 30 or not 0 <= args.offset <= 1000000:
        parser.error('Use an ordered range of at most 31 days and a non-negative bounded offset.')
    base = os.environ.get('IMAGE_SUPABASE_URL', '').rstrip('/')
    key = os.environ.get('IMAGE_SUPABASE_SECRET_KEY', '')
    bucket = os.environ.get('SUPABASE_BUCKET', 'monitoring-images')
    if not base.startswith('https://') or not key:
        parser.error('Set IMAGE_SUPABASE_URL and IMAGE_SUPABASE_SECRET_KEY in the server environment.')
    headers = {'apikey': key}
    if not key.startswith('sb_'):
        headers['Authorization'] = 'Bearer ' + key
    # IST date bounds, inclusive dates, no full-archive traversal.
    params = [('select', 'original_image_url,result_image_url'), ('device_id', 'eq.' + os.environ.get('DASHBOARD_DEVICE_ID', 'PI5-001')),
              ('captured_at', 'gte.' + first.isoformat() + 'T00:00:00+05:30'),
              ('captured_at', 'lt.' + (last + timedelta(days=1)).isoformat() + 'T00:00:00+05:30'),
              ('order', 'captured_at.desc,id.desc'), ('offset', str(args.offset)), ('limit', str(args.limit))]
    opener = build_opener(NoRedirect)
    def send(url, method='GET', data=None, extra=None):
        return opener.open(Request(url, data=data, method=method, headers={**headers, **(extra or {})}), timeout=30)
    with send(base + '/rest/v1/detections?' + urlencode(params)) as response:
        rows = json.loads(response.read(MAX_BYTES))
    seen = set()
    for row in rows:
        for field in ('original_image_url', 'result_image_url'):
            value = row.get(field)
            if not value:
                continue
            marker = base + '/storage/v1/object/public/' + bucket + '/'
            if value.startswith(('http://', 'https://')):
                if not value.startswith(marker):
                    print('Skipped external-project image'); continue
                path = unquote(urlsplit(value).path.split('/object/public/' + bucket + '/', 1)[1])
            else:
                path = value
            try:
                target = thumbnail_path(path)
            except ValueError:
                continue
            if target in seen:
                continue
            seen.add(target)
            encoded = quote(bucket + '/' + target, safe='/')
            target_url = base + '/storage/v1/object/' + encoded
            try:
                with send(target_url, 'HEAD'):
                    print('Already exists:', target)
                continue
            except HTTPError as error:
                missing = error.code == 404
                if error.code == 400:
                    try:
                        missing = str(json.loads(error.read()).get('statusCode')) == '404'
                    except (ValueError, AttributeError):
                        pass
                if not missing:
                    raise
            print('Create' if args.apply else 'Would create', target)
            if not args.apply:
                continue
            source = base + '/storage/v1/object/' + quote(bucket + '/' + path, safe='/')
            with send(source) as response:
                raw = response.read(MAX_BYTES + 1)
            if len(raw) > MAX_BYTES:
                raise ValueError('Image exceeds 25 MiB safety limit')
            data = make_thumbnail(raw)
            # POST with upsert disabled can create only the separate thumbnail.
            with send(target_url, 'POST', data, {'Content-Type': 'image/jpeg', 'x-upsert': 'false', 'cache-control': '31536000'}):
                pass

if __name__ == '__main__':
    main()
