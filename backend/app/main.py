from __future__ import annotations

import logging
import math
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
    "id,device_id,recorded_at,wind_direction,wind_angle,previous_position,target_position,"
    "motor_direction,movement,required_pulses,actual_pulses,final_position,status,"
    "battery_percent,battery_voltage"
)
WIND_PAGE_SIZE = 1000
COMPASS_DIRECTIONS = {"N", "NE", "E", "SE", "S", "SW", "W", "NW"}
WIND_HISTORY_COLUMNS = (
    "wind_direction", "wind_angle", "previous_position", "target_position",
    "motor_direction", "movement", "required_pulses", "actual_pulses",
    "final_position", "status", "battery_percent", "battery_voltage",
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


def normalize_telemetry_code(value: Any) -> str:
    return "_".join(str(value or "").strip().upper().replace("-", " ").split())


def is_valid_wind_reading(row: dict[str, Any]) -> bool:
    direction = normalize_telemetry_code(row.get("wind_direction"))
    status = normalize_telemetry_code(row.get("status"))
    angle = row.get("wind_angle")
    try:
        numeric_angle = float(angle)
    except (TypeError, ValueError):
        return False
    return (
        direction in COMPASS_DIRECTIONS
        and status not in {"DAILY_HOME", "POWER_FAIL_HOME", "POWER_FAILURE_HOME"}
        and 0 <= numeric_angle <= 360
        and math.isfinite(numeric_angle)
    )


def hourly_slot_key(value: Any) -> str | None:
    timestamp = parse_timestamp(value)
    if not timestamp:
        return None
    return timestamp.astimezone(DISPLAY_TZ).strftime("%Y-%m-%dT%H")


def wind_event_key(row: dict[str, Any]) -> tuple[str, ...]:
    timestamp = parse_timestamp(row.get("recorded_at"))
    angle = row.get("wind_angle")
    try:
        angle_key = str(float(angle)) if angle is not None and angle != "" else ""
    except (TypeError, ValueError):
        angle_key = str(angle)
    return (
        str(row.get("device_id") or ""), iso(timestamp) or "",
        normalize_telemetry_code(row.get("wind_direction")), angle_key,
        normalize_telemetry_code(row.get("status")), str(row.get("previous_position") if row.get("previous_position") is not None else ""),
        str(row.get("target_position") if row.get("target_position") is not None else ""), normalize_telemetry_code(row.get("motor_direction")),
        str(row.get("movement") if row.get("movement") is not None else ""), str(row.get("required_pulses") if row.get("required_pulses") is not None else ""),
        str(row.get("actual_pulses") if row.get("actual_pulses") is not None else ""), str(row.get("final_position") if row.get("final_position") is not None else ""),
        str(row.get("battery_percent") if row.get("battery_percent") is not None else ""), str(row.get("battery_voltage") if row.get("battery_voltage") is not None else ""),
    )


def merge_wind_rows(
    primary_rows: list[dict[str, Any]],
    backup_rows: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    primary_by_slot: dict[str, list[dict[str, Any]]] = defaultdict(list)
    primary_valid_slots: set[str] = set()
    for row in primary_rows:
        slot = hourly_slot_key(row.get("recorded_at"))
        if slot:
            primary_by_slot[slot].append(row)
            if is_valid_wind_reading(row):
                primary_valid_slots.add(slot)

    selected = [row for rows in primary_by_slot.values() for row in rows]
    for row in backup_rows:
        slot = hourly_slot_key(row.get("recorded_at"))
        if not slot:
            continue
        if is_valid_wind_reading(row) and slot in primary_valid_slots:
            continue
        selected.append(row)

    unique: dict[tuple[str, ...], dict[str, Any]] = {}
    for row in selected:
        unique.setdefault(wind_event_key(row), row)
    selected = list(unique.values())
    selected.sort(
        key=lambda row: (
            parse_timestamp(row.get("recorded_at")) or datetime.min.replace(tzinfo=timezone.utc),
            int(row.get("id") or 0),
        ),
        reverse=True,
    )
    return [
        {
            "recorded_at": iso(parse_timestamp(row.get("recorded_at"))),
            **{key: row.get(key) for key in WIND_HISTORY_COLUMNS},
        }
        for row in selected
    ]


def read_wind_source(
    client: Client,
    table: str,
    start: datetime,
    end: datetime,
) -> tuple[list[dict[str, Any]], bool]:
    rows: list[dict[str, Any]] = []
    offset = 0
    try:
        while True:
            response = (
                client.table(table)
                .select(TELEMETRY_COLUMNS)
                .eq("device_id", DEVICE_ID)
                .gte("recorded_at", start.isoformat())
                .lt("recorded_at", end.isoformat())
                .order("recorded_at", desc=True)
                .order("id", desc=True)
                .range(offset, offset + WIND_PAGE_SIZE - 1)
                .execute()
            )
            page = response.data or []
            rows.extend(page)
            if len(page) < WIND_PAGE_SIZE:
                return rows, False
            offset += len(page)
    except Exception:
        logger.warning("Wind source query failed for %s; keeping any rows fetched before failure", table, exc_info=True)
        return rows, True


def read_wind_sources(
    start: datetime,
    end: datetime,
) -> tuple[list[dict[str, Any]], list[str]]:
    client = require_supabase()
    primary, primary_failed = read_wind_source(client, "wind_data", start, end)
    backup, backup_failed = read_wind_source(client, "wind_operation_logs", start, end)
    warnings = []
    if primary_failed:
        warnings.append("Primary wind_data could not be loaded completely.")
    if backup_failed:
        warnings.append("Fallback wind_operation_logs could not be loaded completely.")
    return merge_wind_rows(primary, backup), warnings


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


def read_latest_wind_sources() -> tuple[dict[str, Any] | None, dict[str, Any] | None, list[str]]:
    client = require_supabase()
    source_rows: dict[str, list[dict[str, Any]]] = {}
    warnings: list[str] = []
    for table in ("wind_data", "wind_operation_logs"):
        try:
            response = (
                client.table(table)
                .select(TELEMETRY_COLUMNS)
                .eq("device_id", DEVICE_ID)
                .order("recorded_at", desc=True)
                .order("id", desc=True)
                .limit(WIND_PAGE_SIZE)
                .execute()
            )
            source_rows[table] = response.data or []
        except Exception:
            logger.warning("Latest wind query failed for %s", table, exc_info=True)
            source_rows[table] = []
            warnings.append(f"{table} could not be loaded for latest telemetry.")
    merged = merge_wind_rows(source_rows["wind_data"], source_rows["wind_operation_logs"])
    latest_wind = next((row for row in merged if is_valid_wind_reading(row)), None)
    return (merged[0] if merged else None), latest_wind, warnings


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
    wind_rows, wind_warnings = read_wind_sources(current_start_utc, tomorrow_start_utc)
    wind_history = wind_rows[wind_offset:wind_offset + wind_limit]
    latest_event = wind_rows[0] if wind_rows else None
    latest_wind = next((row for row in wind_rows if is_valid_wind_reading(row)), None)
    health_data = read_health(latest_event, latest_wind)
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
        "wind_history_has_more": wind_offset + wind_limit < len(wind_rows),
        "latest_detection": latest,
        "recent_detections": recent,
        "history_offset": history_offset,
        "history_limit": history_limit,
        "history_has_more": history_has_more,
        "health": health_data,
    }

