from __future__ import annotations

from copy import deepcopy
from threading import RLock
from time import monotonic
from urllib.parse import urlsplit, urlunsplit
import re
import logging
import os
from collections import defaultdict
from datetime import date, datetime, time, timedelta, timezone
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from supabase import Client, create_client

from .sticky_sheet import create_router


BASE_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
load_dotenv(os.path.join(BASE_DIR, ".env"), override=False)

logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"))
logger = logging.getLogger("aphid-customer-dashboard")

SUPABASE_URL = os.getenv("SUPABASE_URL", "").strip()
SUPABASE_KEY = (
    os.getenv("SUPABASE_SERVICE_ROLE_KEY", "").strip()
    or os.getenv("SUPABASE_ANON_KEY", "").strip()
    or os.getenv("SUPABASE_KEY", "").strip()
)
SUPABASE_BUCKET = (
    os.getenv("SUPABASE_BUCKET", "").strip()
    or os.getenv("SUPABASE_STORAGE_BUCKET", "").strip()
)
DEVICE_ID = (
    os.getenv("DASHBOARD_DEVICE_ID", "").strip()
    or os.getenv("DEVICE_ID", "").strip()
)
TRAP_NAME = os.getenv("DASHBOARD_TRAP_NAME", "Trap 001").strip()
OFFLINE_THRESHOLD_MINUTES = float(
    os.getenv("OFFLINE_THRESHOLD_MINUTES", "").strip()
    or os.getenv("DEVICE_OFFLINE_MINUTES", "15")
)
MAX_DETECTIONS = int(os.getenv("MAX_DETECTIONS", "5000"))
CORS_ORIGINS = [
    item.strip()
    for item in os.getenv("CORS_ORIGINS", "http://localhost:5173").split(",")
    if item.strip()
]

DISPLAY_TZ_NAME = os.getenv("DASHBOARD_TIMEZONE", "Asia/Kolkata").strip() or "Asia/Kolkata"
try:
    DISPLAY_TZ = ZoneInfo(DISPLAY_TZ_NAME)
except ZoneInfoNotFoundError:
    logger.warning("Timezone data unavailable or invalid; using fixed India offset")
    DISPLAY_TZ_NAME = "Asia/Kolkata"
    DISPLAY_TZ = timezone(timedelta(hours=5, minutes=30))

if not SUPABASE_URL or not SUPABASE_KEY:
    logger.warning("Supabase is not configured. Set SUPABASE_URL and a server-side key.")
    supabase: Client | None = None
else:
    supabase = create_client(SUPABASE_URL, SUPABASE_KEY)

# Images/detections may use a different project from legacy device/sticky-sheet data.
# Fall back only when IMAGE_* is entirely absent, never mix project credentials.
IMAGE_SUPABASE_URL = os.getenv("IMAGE_SUPABASE_URL", "").strip()
IMAGE_SUPABASE_KEY = os.getenv("IMAGE_SUPABASE_SECRET_KEY", "").strip()
image_supabase: Client | None = (
    create_client(IMAGE_SUPABASE_URL, IMAGE_SUPABASE_KEY)
    if IMAGE_SUPABASE_URL and IMAGE_SUPABASE_KEY else None
)

WIND_SUPABASE_URL = os.getenv("WIND_SUPABASE_URL", "").strip()
WIND_SUPABASE_KEY = os.getenv("WIND_SUPABASE_SECRET_KEY", "").strip()
wind_supabase: Client | None = (
    create_client(WIND_SUPABASE_URL, WIND_SUPABASE_KEY)
    if WIND_SUPABASE_URL and WIND_SUPABASE_KEY else None
)

app = FastAPI(title="Aphid Customer Dashboard API", version="1.0.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS,
    allow_credentials=False,
    allow_methods=["GET", "POST"],
    allow_headers=["Content-Type", "Authorization"],
)


DETECTION_COLUMNS = (
    "id,device_id,captured_at,insect_count,result_image_url,original_image_url,average_confidence,processing_status"
)
CUSTOMER_WIND_COLUMNS = "id,device_id,recorded_at,wind_direction,wind_angle,status,battery_percent,battery_voltage"
TELEMETRY_COLUMNS = (
    "id,device_id,recorded_at,wind_direction,wind_angle,previous_position,target_position,"
    "motor_direction,movement,required_pulses,actual_pulses,final_position,status,"
    "battery_percent,battery_voltage"
)


def require_supabase() -> Client:
    if supabase is None:
        raise HTTPException(
            status_code=503,
            detail="Monitoring data is not configured on this server.",
        )
    return supabase


app.include_router(create_router(require_supabase, DEVICE_ID))


def require_image_supabase() -> Client:
    if not IMAGE_SUPABASE_URL and not IMAGE_SUPABASE_KEY:
        return require_supabase()
    if image_supabase is None:
        raise HTTPException(status_code=503, detail="Image monitoring data is not configured on this server.")
    return image_supabase


def parse_timestamp(value: Any) -> datetime | None:
    if not value:
        return None
    if isinstance(value, datetime):
        parsed = value
    else:
        text = str(value).strip().replace("Z", "+00:00")
        try:
            parsed = datetime.fromisoformat(text)
        except ValueError:
            return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def require_wind_supabase() -> Client:
    if wind_supabase is None:
        raise HTTPException(status_code=503, detail="Wind operation logs are not configured on this server.")
    return wind_supabase


def wind_bounds(start_date: str | None, end_date: str | None) -> tuple[datetime, datetime]:
    today = datetime.now(DISPLAY_TZ).date()
    try:
        first = date.fromisoformat(start_date) if start_date else today - timedelta(days=6)
        last = date.fromisoformat(end_date) if end_date else today
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="Wind dates must use YYYY-MM-DD.") from exc
    if ((start_date and first.isoformat() != start_date) or (end_date and last.isoformat() != end_date)
            or first.year < 1900 or first > last or (last - first).days > 365 or last == date.max):
        raise HTTPException(status_code=400, detail="Wind date range must be ordered, start in 1900 or later and be no longer than 366 days.")
    return local_day_bounds(first)[0], local_day_bounds(last)[1]


def wind_page(device_id: str, start: datetime, end: datetime, offset: int, limit: int, customer_view: bool = False) -> dict[str, Any]:
    client = require_wind_supabase()
    columns = CUSTOMER_WIND_COLUMNS if customer_view else TELEMETRY_COLUMNS
    def load():
        query = client.table("wind_operation_logs").select(columns)
        if device_id:
            query = query.eq("device_id", device_id)
        return (query.gte("recorded_at", start.isoformat()).lt("recorded_at", end.isoformat())
                .order("recorded_at", desc=True).order("id", desc=True)
                .range(offset, offset + limit).execute()).data or []
    try:
        rows = cached_metadata((client, "wind", device_id, start, end, offset, limit, columns), load)
        return {"rows": rows[:limit], "has_more": len(rows) > limit, "offset": offset,
                "limit": limit, "source": "wind_operation_logs"}
    except Exception as exc:
        logger.warning("Wind operation log query failed", exc_info=True)
        raise HTTPException(status_code=502, detail="Unable to load wind operation logs right now.") from exc


@app.get("/api/wind")
def wind_history(
    device_id: str = Query(default="", max_length=128),
    start_date: str | None = None, end_date: str | None = None,
    offset: int = Query(default=0, ge=0, le=1000000),
    limit: int = Query(default=20, ge=1, le=50),
    include_devices: bool = False, customer_view: bool = False,
) -> dict[str, Any]:
    start, end = wind_bounds(start_date, end_date)
    result = wind_page(device_id.strip(), start, end, offset, limit, customer_view)
    if include_devices:
        devices: set[str] = set()
        try:
            index = 0
            while True:
                page = (require_wind_supabase().table("wind_operation_logs").select("device_id")
                        .order("device_id").order("id").range(index, index + 999).execute()).data or []
                devices.update(str(row["device_id"]) for row in page if row.get("device_id"))
                if len(page) < 1000:
                    break
                index += len(page)
            result["devices"] = sorted(devices)
        except Exception:
            result["devices"] = []
            result["warning"] = "Device options could not be loaded. Operation records are still shown."
    return result


def local_day_bounds(day: date) -> tuple[datetime, datetime]:
    start_local = datetime.combine(day, time.min, tzinfo=DISPLAY_TZ)
    end_local = start_local + timedelta(days=1)
    return start_local.astimezone(timezone.utc), end_local.astimezone(timezone.utc)


def iso(value: datetime | None) -> str | None:
    return value.isoformat() if value else None


def integer_count(value: Any) -> int:
    try:
        return max(0, int(value or 0))
    except (TypeError, ValueError):
        return 0


def image_url(value: Any, client: Client) -> str | None:
    if not value:
        return None
    text = str(value).strip()
    if text.startswith(("https://", "http://")):
        return text
    try:
        # Existing records may store a Storage object path instead of a URL.
        # This only resolves a read URL; it does not upload or mutate storage.
        return str(client.storage.from_(SUPABASE_BUCKET).get_public_url(text))
    except Exception:
        logger.warning("Could not resolve Storage path", exc_info=True)
        return None


_metadata_cache: dict[tuple, tuple[float, Any]] = {}
_metadata_lock = RLock()


def cached_metadata(key: tuple, loader, ttl: int = 300):
    # Lock coalesces concurrent reads; no writes or errors are cached.
    with _metadata_lock:
        hit = _metadata_cache.get(key)
        if hit and hit[0] > monotonic():
            return deepcopy(hit[1])
        value = loader()
        if len(_metadata_cache) >= 128:
            _metadata_cache.pop(next(iter(_metadata_cache)))
        _metadata_cache[key] = (monotonic() + ttl, deepcopy(value))
        return value


def read_detections(start: datetime, end: datetime) -> list[dict[str, Any]]:
    client = require_image_supabase()
    def load():
        rows = []
        for offset in range(0, MAX_DETECTIONS, 1000):
            size = min(1000, MAX_DETECTIONS - offset)
            page = (client.table("detections").select("captured_at,insect_count")
                    .eq("device_id", DEVICE_ID).gte("captured_at", start.isoformat())
                    .lt("captured_at", end.isoformat()).order("captured_at", desc=True)
                    .order("id", desc=True).range(offset, offset + size - 1).execute()).data or []
            rows.extend(page)
            if len(page) < size:
                break
        return rows
    try:
        return cached_metadata((client, "summary", DEVICE_ID, start, end), load)
    except Exception as exc:
        raise HTTPException(status_code=502, detail="Unable to load monitoring data right now.") from exc


def thumbnail_url(value: str | None) -> str | None:
    if not value:
        return None
    parts = urlsplit(value)
    marker = "/storage/v1/object/public/"
    if parts.scheme not in ("http", "https") or marker not in parts.path:
        return None
    prefix, tail = parts.path.split(marker, 1)
    if "/" not in tail:
        return None
    bucket, path = tail.split("/", 1)
    path = re.sub(r"\.[^/.]+$", ".jpg", path)
    return urlunsplit((parts.scheme, parts.netloc, prefix + marker + bucket + "/thumbnails/v2/" + path, "", ""))


def public_image_row(row: dict[str, Any]) -> dict[str, Any]:
    client = require_image_supabase()
    result = image_url(row.get("result_image_url"), client)
    original = image_url(row.get("original_image_url"), client)
    return {"id": row.get("id"), "device_id": row.get("device_id"),
            "captured_at": iso(parse_timestamp(row.get("captured_at"))),
            "insect_count": integer_count(row.get("insect_count")),
            "average_confidence": row.get("average_confidence"), "processing_status": row.get("processing_status"),
            "session_id": row.get("session_id", row.get("capture_session_id")),
            "result_image_url": result, "original_image_url": original, "image_url": result or original,
            "thumbnail_url": thumbnail_url(original), "result_thumbnail_url": thumbnail_url(result),
            "image_available": bool(result or original)}


def image_page(period: int, start_date: str | None, end_date: str | None, offset: int, limit: int):
    first = start_date or (datetime.now(DISPLAY_TZ).date() - timedelta(days=period - 1)).isoformat()
    start, end = wind_bounds(first, end_date)
    client = require_image_supabase()
    columns = DETECTION_COLUMNS
    session = os.getenv("IMAGE_SESSION_COLUMN", "")
    if session in ("session_id", "capture_session_id"):
        columns += "," + session
    def load():
        return (client.table("detections").select(columns).eq("device_id", DEVICE_ID)
                .gte("captured_at", start.isoformat()).lt("captured_at", end.isoformat())
                .order("captured_at", desc=True).order("id", desc=True)
                .range(offset, offset + limit).execute()).data or []
    try:
        rows = cached_metadata((client, "images", DEVICE_ID, start, end, offset, limit, columns), load)
    except Exception as exc:
        raise HTTPException(status_code=502, detail="Image history is temporarily unavailable.") from exc
    return {"rows": [public_image_row(row) for row in rows[:limit]], "has_more": len(rows) > limit,
            "offset": offset, "limit": limit, "timezone": DISPLAY_TZ_NAME, "source": "detections"}


@app.get("/api/images")
def image_history(period: int = Query(default=7, ge=1, le=30),
                  start_date: str | None = None, end_date: str | None = None,
                  offset: int = Query(default=0, ge=0, le=1000000),
                  limit: int = Query(default=20, ge=1, le=50)):
    return image_page(period, start_date, end_date, offset, limit)


def counts_by_local_day(rows: list[dict[str, Any]]) -> dict[str, int]:
    totals: dict[str, int] = defaultdict(int)
    for row in rows:
        timestamp = parse_timestamp(row.get("captured_at"))
        if timestamp:
            key = timestamp.astimezone(DISPLAY_TZ).date().isoformat()
            totals[key] += integer_count(row.get("insect_count"))
    return dict(totals)


def activity_summary(current_rows: list[dict[str, Any]], previous_rows: list[dict[str, Any]]) -> dict[str, Any]:
    current_total = sum(integer_count(row.get("insect_count")) for row in current_rows)
    previous_total = sum(integer_count(row.get("insect_count")) for row in previous_rows)
    if not current_rows or not previous_rows:
        return {
            "label": "Not enough data",
            "direction": "unknown",
            "percentage": None,
            "current_total": current_total,
            "previous_total": previous_total,
        }
    if previous_total == 0:
        if current_total == 0:
            return {
                "label": "Stable",
                "direction": "stable",
                "percentage": 0,
                "current_total": current_total,
                "previous_total": previous_total,
            }
        return {
            "label": "Not enough data",
            "direction": "unknown",
            "percentage": None,
            "current_total": current_total,
            "previous_total": previous_total,
        }
    percentage = round(((current_total - previous_total) / previous_total) * 100, 1)
    if percentage > 0:
        label, direction = "Increasing", "up"
    elif percentage < 0:
        label, direction = "Decreasing", "down"
    else:
        label, direction = "Stable", "stable"
    return {
        "label": label,
        "direction": direction,
        "percentage": percentage,
        "current_total": current_total,
        "previous_total": previous_total,
    }


def read_latest_wind_sources() -> tuple[dict[str, Any] | None, dict[str, Any] | None, list[str]]:
    try:
        client = require_wind_supabase()
        def load():
            return (client.table("wind_operation_logs").select(CUSTOMER_WIND_COLUMNS)
                    .eq("device_id", DEVICE_ID).order("recorded_at", desc=True).order("id", desc=True)
                    .limit(1).execute()).data or []
        latest = (cached_metadata((client, "latest-wind", DEVICE_ID), load) or [None])[0]
        return latest, latest, []
    except Exception:
        return None, None, ["Wind operation logs could not be loaded for latest telemetry."]


def read_health(
    event_row: dict[str, Any] | None = None,
    wind_row: dict[str, Any] | None = None,
) -> dict[str, Any]:
    warnings: list[str] = []
    if event_row is None and wind_row is None:
        event_row, wind_row, warnings = read_latest_wind_sources()
    if not event_row:
        return {
            "available": False,
            "status": "unknown",
            "last_communication": None,
            "fields": {},
            "source_warnings": warnings,
        }

    recorded_at = parse_timestamp(event_row.get("recorded_at"))
    age_minutes = None
    if recorded_at:
        age_minutes = (datetime.now(timezone.utc) - recorded_at).total_seconds() / 60
    status = "online" if age_minutes is not None and age_minutes <= OFFLINE_THRESHOLD_MINUTES else "offline"
    fields: dict[str, Any] = {}
    for key in ("battery_percent", "battery_voltage", "status"):
        if event_row.get(key) is not None:
            fields[key] = event_row[key]
    for key in ("wind_direction", "wind_angle"):
        if wind_row and wind_row.get(key) is not None:
            fields[key] = wind_row[key]
    return {
        "available": True,
        "status": status,
        "last_communication": iso(recorded_at),
        "fields": fields,
        "source_warnings": warnings,
    }


@app.get("/health")
def health() -> dict[str, Any]:
    return {"ok": True, "supabase_configured": supabase is not None}


@app.get("/api/dashboard")
def dashboard(
    period: int = Query(default=7, ge=1, le=30),
    history_offset: int = Query(default=0, ge=0),
    history_limit: int = Query(default=5, ge=1, le=50),
    wind_offset: int = Query(default=0, ge=0),
    wind_limit: int = Query(default=5, ge=1, le=50),
    include_wind_history: bool = True,
) -> dict[str, Any]:
    now_local = datetime.now(DISPLAY_TZ)
    today = now_local.date()
    today_start_utc, tomorrow_start_utc = local_day_bounds(today)
    current_start_local = datetime.combine(today - timedelta(days=period - 1), time.min, tzinfo=DISPLAY_TZ)
    previous_start_local = current_start_local - timedelta(days=period)
    current_start_utc = current_start_local.astimezone(timezone.utc)
    previous_start_utc = previous_start_local.astimezone(timezone.utc)

    rows = read_detections(previous_start_utc, tomorrow_start_utc)
    current_rows = []
    previous_rows = []
    for row in rows:
        timestamp = parse_timestamp(row.get("captured_at"))
        if not timestamp:
            continue
        if timestamp >= current_start_utc:
            current_rows.append(row)
        else:
            previous_rows.append(row)

    day_counts = counts_by_local_day(current_rows)
    trend = [
        {"date": day, "count": count}
        for day, count in sorted(day_counts.items())
    ]
    detail = image_page(period, None, None, history_offset, history_limit)
    recent = detail["rows"]
    history_has_more = detail["has_more"]
    latest = recent[0] if recent else None
    today_rows = [
        row for row in rows
        if (timestamp := parse_timestamp(row.get("captured_at")))
        and timestamp.astimezone(DISPLAY_TZ).date() == today
    ]
    wind_warnings = []
    try:
        wind_result = wind_page(DEVICE_ID, current_start_utc, tomorrow_start_utc, wind_offset, wind_limit) if include_wind_history else {"rows": [], "has_more": False}
    except HTTPException as exc:
        wind_result = {"rows": [], "has_more": False}
        wind_warnings.append(exc.detail)
    wind_history = wind_result["rows"]
    health_data = read_health()
    wind_warnings = list(dict.fromkeys(wind_warnings + health_data.get("source_warnings", [])))
    return {
        "trap_name": TRAP_NAME,
        "device_id": DEVICE_ID,
        "timezone": DISPLAY_TZ_NAME,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "period_days": period,
        "kpis": {
            "aphids_today": sum(integer_count(row.get("insect_count")) for row in today_rows),
            "images_today": len(today_rows),
            "activity": activity_summary(current_rows, previous_rows),
            "last_detection": latest,
        },
        "trend": trend,
        "wind_history": wind_history,
        "wind_history_warning": " ".join(wind_warnings) if wind_warnings else None,
        "wind_history_offset": wind_offset,
        "wind_history_limit": wind_limit,
        "wind_history_has_more": wind_result["has_more"],
        "latest_detection": latest,
        "recent_detections": recent,
        "image_records": recent,
        "image_records_truncated": history_has_more,
        "summary_truncated": len(rows) >= MAX_DETECTIONS,
        "history_offset": history_offset,
        "history_limit": history_limit,
        "history_has_more": history_has_more,
        "health": health_data,
    }



@app.middleware("http")
async def cache_read_metadata(request: Request, call_next):
    response = await call_next(request)
    if request.method == "GET" and request.url.path in ("/api/dashboard", "/api/images", "/api/wind"):
        response.headers["Cache-Control"] = "public, max-age=60, s-maxage=300" if response.status_code == 200 else "no-store"
    return response
