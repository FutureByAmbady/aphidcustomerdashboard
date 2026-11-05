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
    return 'thumbnails/v2/' + re.sub(r'\.[^/.]+$', '.jpg', path)


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
    parser.add_argument('--start-date')
    parser.add_argument('--end-date')
    parser.add_argument('--latest-only', action='store_true', help='Only the newest capture and its result (or original) preview; no date/archive scan.')
    parser.add_argument('--limit', type=int, default=20, choices=range(1, 51), metavar='1..50')
    parser.add_argument('--offset', type=int, default=0)
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    if not args.latest_only:
        if not args.start_date or not args.end_date:
            parser.error('Use --latest-only or supply both dates.')
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
    params = [('select', 'original_image_url,result_image_url'), ('device_id', 'eq.' + os.environ.get('DASHBOARD_DEVICE_ID', 'PI5-001')),
              ('order', 'captured_at.desc,id.desc'), ('offset', str(0 if args.latest_only else args.offset)),
              ('limit', str(1 if args.latest_only else args.limit))]
    if not args.latest_only:
        params += [('captured_at', 'gte.' + first.isoformat() + 'T00:00:00+05:30'),
                   ('captured_at', 'lt.' + (last + timedelta(days=1)).isoformat() + 'T00:00:00+05:30')]
    opener = build_opener(NoRedirect)
    def send(url, method='GET', data=None, extra=None):
        return opener.open(Request(url, data=data, method=method, headers={**headers, **(extra or {})}), timeout=30)
    with send(base + '/rest/v1/detections?' + urlencode(params)) as response:
        rows = json.loads(response.read(MAX_BYTES))
    seen = set()
    for row in rows:
        fields = (('result_image_url',) if row.get('result_image_url') else ('original_image_url',)) if args.latest_only else ('original_image_url', 'result_image_url')
        for field in fields:
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
                with send(base + '/storage/v1/object/info/authenticated/' + encoded):
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
            with send(target_url, 'POST', data, {'Content-Type': 'image/jpeg', 'x-upsert': 'false', 'cache-control': 'max-age=31536000'}):
                pass
            print('Created preview:', len(data), 'bytes; source downloaded once:', len(raw), 'bytes')

if __name__ == '__main__':
    main()
