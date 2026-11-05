# Sticky sheet replacement: staged implementation

Implemented on 31 October 2026 in `C:\SmartInsectDetector\AphidCustomerDashboard`. Registration is disabled by default. No live migration, deployment, device command, or replacement request was performed.

## What was inspected

The existing frontend is a single-page React app in `frontend/src/App.jsx`; it uses fetch, local component state, and shared panel/button styles. Device identity comes from `/api/dashboard`, scoped by the backend's configured device ID. System health reads wind telemetry. Cloudflare Pages Functions and FastAPI both query Supabase. `cf-deploy` is an older generated deployment snapshot, not the source used by `wrangler.toml`.

Read-only Supabase OpenAPI metadata confirmed existing `devices`, `detections`, `wind_data`, `wind_operation_logs`, `device_manual_commands`, and other tables. It showed no sticky-sheet baseline, replacement queue, or acknowledgement fields. This implementation therefore stages new isolated tables rather than misusing the hardware-command queue. No existing device fields, commands, or replacement endpoint were assumed.

## Customer flow

A compact card sits below the latest detection/system health row. It reuses the existing panels, buttons, colors, and typography. Usage is elapsed whole days since a confirmed sheet registration, not project age. Remaining estimated usage is `max(0, 90 - elapsed days)`. Missing baselines and counts display `Not available`. The text explicitly warns that replacement may be needed earlier and elapsed time does not establish physical exhaustion.

The native modal has three steps: physical roller replacement, installation/alignment verification, and final registration confirmation. Each requires a fresh checkbox. Cancel or Escape before submission closes the modal without a write. The final step also requires the administrator-provided replacement key, because the original dashboard has no customer sign-in. The key is used only for that POST, cleared afterward, and never stored in browser storage or a frontend environment variable.

Only the last confirmation sends a POST. A successful submission means pending, not completed. Status polls every 30 seconds independently of dashboard/history pagination. Offline devices remain pending indefinitely. Success is displayed only for a completed request with a valid backend acknowledgement timestamp. A failed request remains unresolved and offers a retry using its original UUID. A lost submission response also retains its UUID in session storage, so a retry cannot create another request. Storage contains request metadata only, never the key. If session storage is unavailable, the in-memory UUID remains available until the page is closed; the database still enforces one unresolved request per device.

While a POST is in flight its buttons are disabled; after submission, closing a modal cannot undo a registered request.

## API and schema

New, isolated endpoints in BOTH backend variants:

- `GET /api/sticky-sheet`: `{device_id, enabled, state, request}`. Disabled mode returns null state/request without contacting Supabase. Enabled reads are device-scoped and latest request ordering uses server `created_at`, not a customer's clock.
- `POST /api/sticky-sheet`: requires `Authorization: Bearer <replacement key>` and `{device_id, request_id, requested_at, action: "register_new_sticky_sheet", retry?: boolean}`. Returns `{request}` with HTTP 202 for pending/failed or 200 for an already completed request. Device, action, UUID, timestamp, and field validation run before the database call. Invalid authorization is 401; unavailable service is a generic 503. A 503 does not establish whether submission reached the database: reuse the ID.

`migrations/20261031_sticky_sheet.sql` creates only:

- `sticky_sheet_state`: device ID, confirmed registration timestamp, completed advances.
- `sticky_sheet_replacement_requests`: UUID, device ID, action, client request timestamp, server creation timestamp, status, acknowledgement timestamp, and generic error code.
- `register_sticky_sheet_replacement`: atomic, device-serialized registration/retry. A partial unique index enforces one unresolved pending/failed request per device. Existing unresolved requests are returned as the canonical request. A completed UUID is never requeued.
- `acknowledge_sticky_sheet_replacement`: trusted backend-only acknowledgement. Success resets only the new sheet state; failure leaves it unchanged. A replay of a completed acknowledgement is a no-op, including after subsequent advances.

Both new tables have RLS enabled. Anonymous/authenticated Supabase clients have no direct access or RPC privileges. RPC execution is service-role-only. Only trusted telemetry can update the completed-advance column. No service-role key belongs in the browser. There is no dashboard acknowledgement endpoint, and a customer key cannot complete a request.

## Activation prerequisites

1. Review and apply the staged migration separately. Back up as appropriate. Existing `devices` rows are checked by the registration RPC; no uniqueness constraint on an existing device column is assumed or added.
2. Configure the deployed backend with its server-only Supabase service-role key. An anon key is deliberately insufficient for this feature, even if it works for existing reads.
3. Implement and verify a trusted Pi/backend consumer separately. During a normal scheduled wake-up, it must retrieve only its pending `register_new_sticky_sheet` request, validate its target/action, and durably remember processed UUIDs. The Pi's actual sheet-counter reset and UUID journal must be crash-safe/idempotent, so a reboot or lost acknowledgement cannot reset twice. A request is not a motor, wake, alignment, capture, or upload instruction.
4. After a successful local reset, the trusted backend calls `acknowledge_sticky_sheet_replacement(device_id, request_id, true)`. On a genuine failed processing attempt, use false. Never report failure merely because an acknowledgement response was lost; reconcile the same UUID. These functions take named arguments `p_device_id`, `p_request_id`, `p_success`.
5. Trusted telemetry must keep `sticky_sheet_state.completed_advances` current for the registered roller. Do not infer advances from wind movement or image counts. If reliable reporting is unavailable, do not present a fabricated running count. A count of zero immediately after acknowledgement reflects that acknowledgement only.
6. Set `STICKY_SHEET_REPLACEMENT_TOKEN` to a strong per-device replacement key and distribute it privately. Use HTTPS, rotate the key when access changes, and add deployment-level rate limiting. This is a narrow shared-key gate for the existing single-device dashboard, not a multi-customer identity system. If multi-user/device access is needed, replace it with authenticated device ownership checks before release.
7. Only after validating the full device path set `STICKY_SHEET_REPLACEMENT_ENABLED=true`. Both this flag and a nonempty key are required. The example environment files keep it false. Do not put either Supabase credentials or the replacement key in `VITE_*` variables.

Do not enable this against a Pi that lacks the consumer. Otherwise requests would remain pending, and the new state would not track real sheet use. No Pi code was changed in this task, as requested.

## Scope protection

The only existing application changes are a card import/render and footer label, scoped CSS, and FastAPI router/CORS wiring. Detection fetching, charts, history pagination, wind logic, images, power management, camera behavior, ESP32 scheduling, project dates, project-day counters, and historical records were not changed. The manual hardware-command tables are never written. Existing backup files and `cf-deploy` were left untouched.

## Verification

Run from the project root:

```powershell
npm --prefix frontend test
.\backend\.venv\Scripts\python.exe -m unittest discover -s backend/tests -v
npm --prefix frontend run build
git diff --check
```

The first run passed 19 Vitest tests and 16 FastAPI unit tests. Coverage includes cancellation at all three steps, checkbox gating, duplicate clicks, offline pending status, lost-response same-ID retry, failed processing, acknowledged success/reset, unavailable baselines, disabled configuration, API authorization/validation, local PostgreSQL registration and acknowledgement replay, and anonymous RPC denial. PostgreSQL tests use PGlite, never the live Supabase database. FastAPI/Cloudflare tests use mocks. The production frontend build passed.

A local browser preview with mock data confirmed the desktop card and native modal fit the existing layout and show an unchecked physical confirmation. Responsive CSS stacks metrics and sizes the modal to the viewport. Mobile device testing, deployed API testing, Pi crash/recovery testing, and live end-to-end acknowledgement were not performed.

## Files

Modified:
- `frontend/src/App.jsx`
- `frontend/src/styles.css`
- `frontend/package.json`
- `frontend/package-lock.json`
- `backend/app/main.py`
- `.env.example`
- `.dev.vars.example`

Created:
- `frontend/src/StickySheet.jsx`
- `frontend/src/stickySheet.js`
- `frontend/src/StickySheet.test.jsx`
- `frontend/src/stickySheetBackend.test.js`
- `functions/api/sticky-sheet.js`
- `backend/app/sticky_sheet.py`
- `backend/tests/test_sticky_sheet.py`
- `migrations/20261031_sticky_sheet.sql`
- `STICKY_SHEET_REPLACEMENT.md`

`frontend/dist` was regenerated locally by the build; it is ignored by Git. No deployment snapshot was rewritten.
