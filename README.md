# Smart Insect Monitoring — Customer Dashboard

This is a completely separate, read-only customer dashboard. It is contained in `AphidCustomerDashboard` and does not depend on the existing application source, virtual environments, local image files, Raspberry Pi paths, or model files.

## Architecture

- `backend/`: FastAPI read-only API that queries the existing Supabase project.
- `frontend/`: React/Vite customer dashboard.
- Supabase remains the source of truth for detection records, telemetry, and image URLs.

The implementation uses the existing project’s observed tables:

- `detections`: `device_id`, `captured_at`, `insect_count`, `result_image_url`, `original_image_url`
- `wind_data`: available telemetry and recent communication fields
- `devices`: used only to verify the configured device exists

The API performs only `select` queries and Storage URL resolution. It does not insert, update, delete, upload, or modify Supabase data.

## Configuration

Copy `.env.example` to `.env` in this project and provide the existing Supabase URL and a key. Prefer `SUPABASE_ANON_KEY` when Row Level Security permits the required read-only queries. If the existing project requires a service-role key for server-side reads, set `SUPABASE_SERVICE_ROLE_KEY` only in this project’s server environment. Never put that key in frontend variables.

The frontend only needs `VITE_API_BASE_URL`, normally `http://localhost:8000` during local development.

## Run the backend

```powershell
cd C:\SmartInsectDetector\AphidCustomerDashboard\backend
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
cd ..
python -m uvicorn backend.app.main:app --reload --port 8765
```

## Run the frontend

```powershell
cd C:\SmartInsectDetector\AphidCustomerDashboard\frontend
npm install
npm run dev -- --host 127.0.0.1 --port 5174
```

The included local `frontend/.env` points to `http://127.0.0.1:8765`. For another deployment, set `VITE_API_BASE_URL` to the deployed backend URL.

Open the Vite URL shown in the terminal. The dashboard is intentionally single-trap: it displays the configured trap name and does not expose device selection or comparison UI.

## Production deployment

This project is packaged for a split deployment: the FastAPI backend runs as a private/server-side service, and the Vite frontend is served as static files. The frontend receives only the public backend URL at build time. Supabase credentials must stay on the backend.

### Environment settings

For the backend, configure these variables in the hosting provider’s server environment:

- `SUPABASE_URL`
- `SUPABASE_ANON_KEY` when read-only RLS access is sufficient, otherwise `SUPABASE_SERVICE_ROLE_KEY` as a server-only secret
- `SUPABASE_BUCKET` (or the existing `SUPABASE_STORAGE_BUCKET` alias)
- `DASHBOARD_DEVICE_ID=PI5-001`
- `DASHBOARD_TRAP_NAME=Trap 001`
- `DASHBOARD_TIMEZONE=Asia/Kolkata`
- `OFFLINE_THRESHOLD_MINUTES=15`
- `CORS_ORIGINS=https://<your-frontend-domain>`
- optional: `LOG_LEVEL`, `MAX_DETECTIONS`

For the frontend build environment, configure only:

```text
VITE_API_BASE_URL=https://<your-backend-domain>
```

Never add `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_ANON_KEY`, or any other Supabase key to `frontend/.env`, a frontend hosting provider, or a `VITE_*` variable.

### Container deployment

The repository includes `backend/Dockerfile`, `frontend/Dockerfile`, `frontend/nginx.conf`, `.dockerignore`, and `docker-compose.yml`. To run the complete stack locally or on a single Docker host:

```powershell
Copy-Item .env.example .env
# Edit .env and set the real server values plus VITE_API_BASE_URL.
docker compose up --build -d
docker compose ps
docker compose logs --tail=100 backend frontend
```

The backend health endpoint is `GET /health`. The frontend is exposed on port `8080` by default and the backend on port `8000`; change `FRONTEND_PORT` or `BACKEND_PORT` in `.env` if needed. The Compose backend has a health check and the frontend waits for it before starting.

### Separate platform deployment

For a managed Python service, deploy the repository with the root as the build context and use the backend start command:

```text
uvicorn backend.app.main:app --host 0.0.0.0 --port $PORT
```

The included `backend/Procfile` supports Procfile-style hosts. For a static frontend host, set `VITE_API_BASE_URL` to the deployed backend HTTPS URL before running `npm ci` and `npm run build`, then publish `frontend/dist`. Configure the backend `CORS_ORIGINS` to the exact frontend origin, including scheme and port when applicable.

### Pre-deploy validation

Run these checks from the project root before releasing:

```powershell
.\\scripts\\verify-production.ps1
cd frontend
npm ci
npm run build
cd ..
```

If Docker is available, also validate and build without starting a deployment:

```powershell
docker compose config
docker compose build
```

These commands do not deploy externally. Review the generated image and hosting-provider settings before starting production services.

### Secret rotation

The original Supabase secret was supplied during setup and is present only in this isolated project’s ignored local environment file. Rotate that secret in Supabase before production use, replace it in the backend deployment secret store, and do not copy it into frontend files or logs.

## No-card Cloudflare Pages deployment

For a public no-card deployment, Cloudflare Pages can serve both the static frontend and the read-only API in `functions/`. The Pages Function uses Supabase REST read requests and never exposes the server key to the browser.

Cloudflare Pages settings:

```text
Root directory: repository root
Build command: npm --prefix frontend ci --no-audit --no-fund && npm --prefix frontend run build
Build output directory: frontend/dist
```

Add these encrypted Pages project variables/secrets:

```text
SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY
SUPABASE_BUCKET=monitoring-images
DASHBOARD_DEVICE_ID=PI5-001
DASHBOARD_TRAP_NAME=Trap 001
DASHBOARD_TIMEZONE=Asia/Kolkata
OFFLINE_THRESHOLD_MINUTES=15
MAX_DETECTIONS=5000
```

The public dashboard URL will call `/api/dashboard` on the same domain, so `VITE_API_BASE_URL` is not required for the Cloudflare deployment. Keep the service-role key only in the Pages server-side environment. Because this dashboard is intentionally public, anyone with the URL can view the monitoring data and public image URLs.

Local Cloudflare-style validation can be done with Wrangler after installing it:

```powershell
npm install --global wrangler
wrangler pages dev frontend/dist --compatibility-date=2026-09-24
```

Do not run `wrangler pages deploy` until the Cloudflare account, project name, and public domain have been reviewed.

## Data behavior

- Counts are summed from real `detections.insect_count` values.
- Trend points are grouped by calendar day in `DASHBOARD_TIMEZONE`.
- The latest record is ordered by `captured_at` descending.
- `result_image_url` is preferred, with `original_image_url` as fallback.
- Missing detection, image, telemetry, and historical data produce explicit empty states rather than fabricated values.
- Online/offline is based on the latest available `wind_data.recorded_at` timestamp and `OFFLINE_THRESHOLD_MINUTES`.

No existing project files or Supabase records are changed by this project.
