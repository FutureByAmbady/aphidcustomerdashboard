from __future__ import annotations

import logging
import os
from collections import defaultdict
from datetime import date, datetime, time, timedelta, timezone
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from supabase import Client, create_client


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

app = FastAPI(title="Aphid Customer Dashboard API", version="1.0.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS,
    allow_credentials=False,
    allow_methods=["GET"],
    allow_headers=["Content-Type"],
)


DETECTION_COLUMNS = (
    "device_id,captured_at,insect_count,result_image_url,original_image_url"
)
TELEMETRY_COLUMNS = (
    "device_id,recorded_at,battery_percent,battery_voltage,wind_direction,wind_angle"
)


def require_supabase() -> Client:
    if supabase is None:
        raise HTTPException(
            status_code=503,
            detail="Monitoring data is not configured on this server.",
        )
    return supabase


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


def read_detections(start: datetime, end: datetime) -> list[dict[str, Any]]:
    client = require_supabase()
    try:
        response = (
            client.table("detections")
            .select(DETECTION_COLUMNS)
            .eq("device_id", DEVICE_ID)
            .gte("captured_at", start.isoformat())
            .lt("captured_at", end.isoformat())
            .order("captured_at", desc=True)
            .limit(MAX_DETECTIONS)
            .execute()
        )
        return response.data or []
    except Exception as exc:
        logger.exception("Detection query failed")
        raise HTTPException(
            status_code=502,
            detail="Unable to load monitoring data right now.",
        ) from exc


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


def read_health() -> dict[str, Any]:
    client = require_supabase()
    try:
        response = (
            client.table("wind_data")
            .select(TELEMETRY_COLUMNS)
            .eq("device_id", DEVICE_ID)
            .order("recorded_at", desc=True)
            .limit(1)
            .execute()
        )
        row = (response.data or [None])[0]
    except Exception:
        logger.warning("Telemetry query failed", exc_info=True)
        return {
            "available": False,
            "status": "unknown",
            "last_communication": None,
            "fields": {},
        }

    if not row:
        return {
            "available": False,
            "status": "unknown",
            "last_communication": None,
            "fields": {},
        }

    recorded_at = parse_timestamp(row.get("recorded_at"))
    age_minutes = None
    if recorded_at:
        age_minutes = (datetime.now(timezone.utc) - recorded_at).total_seconds() / 60
    status = "online" if age_minutes is not None and age_minutes <= OFFLINE_THRESHOLD_MINUTES else "offline"
    fields: dict[str, Any] = {}
    for key in ("battery_percent", "battery_voltage", "wind_direction", "wind_angle"):
        if row.get(key) is not None:
            fields[key] = row[key]
    return {
        "available": True,
        "status": status,
        "last_communication": iso(recorded_at),
        "fields": fields,
    }


@app.get("/health")
def health() -> dict[str, Any]:
    return {"ok": True, "supabase_configured": supabase is not None}


@app.get("/api/dashboard")
def dashboard(
    period: int = Query(default=7, ge=1, le=30),
    history_offset: int = Query(default=0, ge=0),
    history_limit: int = Query(default=5, ge=1, le=50),
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
    client = require_supabase()

    def public_row(row: dict[str, Any]) -> dict[str, Any]:
        result_url = image_url(row.get("result_image_url"), client)
        original_url = image_url(row.get("original_image_url"), client)
        return {
            "captured_at": iso(parse_timestamp(row.get("captured_at"))),
            "insect_count": integer_count(row.get("insect_count")),
            "result_image_url": result_url,
            "original_image_url": original_url,
            "image_url": result_url or original_url,
            "image_available": bool(result_url or original_url),
        }

    history_source = [
        row for row in rows
        if (timestamp := parse_timestamp(row.get("captured_at"))) and timestamp >= current_start_utc
    ]
    history_rows = history_source[history_offset:history_offset + history_limit]
    recent = [public_row(row) for row in history_rows]
    history_has_more = history_offset + history_limit < len(history_source)
    latest = public_row(rows[0]) if rows else None
    today_rows = [
        row for row in rows
        if (timestamp := parse_timestamp(row.get("captured_at")))
        and timestamp.astimezone(DISPLAY_TZ).date() == today
    ]
    health_data = read_health()
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
        "latest_detection": latest,
        "recent_detections": recent,
        "history_offset": history_offset,
        "history_limit": history_limit,
        "history_has_more": history_has_more,
        "health": health_data,
    }

