# Egress optimization notes

- Image History and Image Sessions share bounded server pages (`/api/images`, default 20, maximum 50), with date/device filters and a one-row lookahead. Summary queries fetch only timestamps and counts. Both Pages Functions and FastAPI expose the image endpoint.
- Metadata reads are cached for 60 seconds in each server process/isolate. Concurrent identical Pages requests are coalesced; errors are not cached. Wind device discovery is cached for five minutes on Pages. No gallery request lists Storage objects.
- Dashboard refresh is five minutes while visible, without resetting expanded or date-filtered history. Sticky-sheet checks are five minutes idle / one minute pending, paused in hidden tabs. Writes are never cached.
- Gallery/session/latest previews use lazy-loaded JPEG thumbnails only. View original/result links open the full image. Missing previews never silently download the full-resolution file.

## Preparing missing thumbnails (separate, explicitly invoked operation)

Existing originals remain untouched. Thumbnail keys are `thumbnails/v1/<original path with .jpg extension>`, in the same bucket. A preview will show unavailable until its thumbnail exists. No thumbnail generation or upload is performed automatically by the dashboard.

`scripts/prepare-thumbnails.py` reads only a selected page of detection records (up to 50), checks individual thumbnail existence, and skips existing thumbnails. It does not list Storage or traverse the archive. Dry-run is the default. Set server-only `IMAGE_SUPABASE_URL`, `IMAGE_SUPABASE_SECRET_KEY`, and optionally `SUPABASE_BUCKET`, `DASHBOARD_DEVICE_ID`; do not put these in frontend variables. Python with Pillow is required for `--apply`.

Example dry-run, from the project root:

    python scripts/prepare-thumbnails.py --start-date 2026-11-01 --end-date 2026-11-05 --limit 20

After review, the same command with `--apply` generates JPEGs at most 480x360, quality 65, and creates only separate thumbnail objects with overwrite disabled. It skips external-project URLs. Dates are IST. Explicit `--offset` selects another bounded page; there is no automatic archive loop. The dry-run itself reads metadata/HEAD only. Original image bytes are downloaded only with `--apply`.

No live thumbnail operations, uploads, deployment, or Git push were run during this implementation. Live quota restrictions and the actual presence of thumbnails need verification before release.
