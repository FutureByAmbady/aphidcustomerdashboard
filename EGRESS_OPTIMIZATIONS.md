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

The initial run did not create thumbnails. See the latest-preview completion notes below for the subsequent single-capture upload and verification.

## Latest-preview completion (2026-11-05)

- Created exactly one result thumbnail for the latest capture (id 46): 2,558-byte JPEG from a 2,214,655-byte result image, downloaded once. Uploaded only the separate `thumbnails/v1/..._result.jpg` object with overwrite disabled and a one-year image cache TTL. No original or archive was uploaded or changed.
- `--latest-only` now queries a single newest record and generates its result preview (original only if no result exists). Repeated runs skip an existing object using the Storage object-info endpoint, without listing Storage or downloading the source again. Date arguments are unnecessary in this mode. Run with server-only IMAGE_* variables and Python with Pillow.
- Only Latest detection automatically requests a preview. Image History remains text plus View original/result links. Full-size files are never used as fallback previews.
- Metadata caching is now five minutes, with successful read response cache headers of browser 60 seconds/shared 300 seconds; errors and sticky-sheet writes are not cached. Metadata may be up to five minutes old. In-memory server caches remain process/isolate local; response headers do not guarantee cross-isolate caching on every host.
- The frontend requests narrow customer-visible wind columns and suppresses the duplicate wind-history payload in `/api/dashboard`; the separate wind endpoint remains paginated. FastAPI wind pages and latest-health reads now also use the bounded metadata cache.
- New captures still require thumbnail generation. No Raspberry Pi ingestion code or schema was changed. There is no unattended thumbnail scheduler configured; `--latest-only --apply` must run when a new capture needs a preview. These code changes were not pushed or deployed.
- Added a Cloudflare Pages read-only edge-cache middleware for public `/api/dashboard`, `/api/images`, and `/api/wind` GET responses. It reuses cached responses across requests at the same edge location; it excludes writes, sticky-sheet operations, authorization/cookie-bearing requests, errors, and Set-Cookie responses. Cache failures fall back to normal reads. Edge behavior is unit-tested locally and still needs deployment validation. The first v1 derivative retained stale cache metadata, so the same 2,558 preview bytes were uploaded to a new v2 thumbnail path with overwrite disabled. The v2 public response was verified as HTTP 200 with `public, max-age=31536000`. Only one capture was processed; the small v1 derivative remains unused by the new code. No original was overwritten.

- Current code and generator use `thumbnails/v2/` for the verified immutable-cache preview. Existing published code still using v1 can also display the earlier derivative; deploying the pending code activates v2 and all additional egress changes.
