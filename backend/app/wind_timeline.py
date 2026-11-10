"""Read-only, per-device IST recorded-hour fallback; no synthetic records."""
from datetime import datetime, timezone
import math
import re

PAGE = 100
MAX_PAGES = 50
IST_SECONDS = 19800
DIRECTIONS = {"N", "NE", "E", "SE", "S", "SW", "W", "NW", "H"}


def receipt_time(value):
    try:
        stamp = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        return stamp.astimezone(timezone.utc) if stamp.tzinfo is not None else None
    except (ValueError, TypeError, OverflowError):
        return None


def normalize_wind_row(raw, source):
    if not isinstance(raw, dict):
        return None
    stamp = receipt_time(raw.get("recorded_at"))
    if not raw.get("device_id") or stamp is None:
        return None
    angle = raw.get("wind_angle")
    try:
        valid_angle = angle not in (None, "") and not isinstance(angle, bool) and math.isfinite(float(angle)) and 0 <= float(angle) <= 360
    except (ValueError, TypeError, OverflowError):
        valid_angle = False
    valid_direction = str(raw.get("wind_direction") or "").strip().upper() in DIRECTIONS
    meaningful_operation = source == "wind_operation_logs" and str(raw.get("status") or "").strip().upper() not in {"", "-", "UNKNOWN"}
    if not valid_angle and not valid_direction and not meaningful_operation:
        return None
    period = math.floor((stamp.timestamp() + IST_SECONDS) / 3600) * 3600 - IST_SECONDS
    return {**raw, "wind_angle": angle if valid_angle else None, "source": source,
            "source_label": "Wind Data" if source == "wind_data" else "Operation Log",
            "record_kind": "measurement" if source == "wind_data" else "operation",
            "period_start": datetime.fromtimestamp(period, timezone.utc).isoformat()}


def wind_time_bounds(start, end, start_at, end_at):
    def parse(value):
        stamp = receipt_time(value)
        if stamp is None or not re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})", value, re.I):
            raise ValueError("Receipt time filters require valid ISO timestamps with timezone offsets.")
        return stamp
    first = parse(start_at) if start_at else start
    last = parse(end_at) if end_at else end
    if ((start and first and first < start) or (end and last and last > end) or
            (first and last and (first >= last or (last - first).total_seconds() > 366 * 86400))):
        raise ValueError("Receipt time range must be ordered, inside the date range, and at most 366 days.")
    return first, last


def combined_wind_page(load, device_id, start, end, offset, limit, columns):
    warnings = []
    context = {"quota": False, "truncated": False}

    class Stream:
        def __init__(self, source):
            self.source, self.buffer, self.index = source, [], 0
            self.raw_offset, self.pages, self.done, self.failed = 0, 0, False, False

        def next(self):
            while True:
                if self.index < len(self.buffer):
                    raw = self.buffer[self.index]
                    self.index += 1
                    row = normalize_wind_row(raw, self.source)
                    if row is None:
                        continue
                    stamp = receipt_time(row["recorded_at"])
                    if ((device_id and row["device_id"] != device_id) or
                            (start and stamp < start) or (end and stamp >= end)):
                        continue
                    return row
                if self.done or context["quota"]:
                    return None
                if self.pages >= MAX_PAGES:
                    context["truncated"] = True
                    warnings.append(f"{self.source}: scan limit reached; narrow the receipt-time range.")
                    self.done = True
                    return None
                try:
                    rows = load(self.source, self.raw_offset, PAGE, columns, device_id, start, end)
                    if not isinstance(rows, list):
                        raise ValueError("Invalid wind response")
                    self.pages += 1
                    self.raw_offset += len(rows)
                    self.buffer, self.index, self.done = rows, 0, len(rows) < PAGE
                except Exception as exc:
                    self.failed, self.done = True, True
                    status = getattr(exc, "status", getattr(exc, "code", None))
                    context["quota"] = str(status) == "402" or "exceed_egress_quota" in str(exc).lower()
                    suffix = " (quota restricted; no further source requests)" if context["quota"] else ""
                    warnings.append(f"{self.source} unavailable{suffix}.")
                    return None

    streams = [Stream("wind_data"), Stream("wind_operation_logs")]
    heads = [streams[0].next(), None]
    heads[1] = streams[1].next()
    merged = []
    while any(heads) and len(merged) < offset + limit + 1:
        period = max(row["period_start"] for row in heads if row)
        primary, fallback, seen = [], {}, set()
        for index, stream in enumerate(streams):
            while heads[index] and heads[index]["period_start"] == period:
                row = heads[index]
                if index == 0:
                    key = (row["device_id"], receipt_time(row["recorded_at"]))
                    if key not in seen:
                        primary.append(row)
                        seen.add(key)
                else:
                    fallback.setdefault(row["device_id"], row)
                heads[index] = stream.next()
        primary_devices = {row["device_id"] for row in primary}
        selected = primary + [row for device, row in fallback.items() if device not in primary_devices]
        merged.extend(sorted(selected, key=lambda row: (-receipt_time(row["recorded_at"]).timestamp(), str(row["device_id"]))))
    unverified = streams[0].failed or context["truncated"]
    if streams[0].failed and any(row["source"] == "wind_operation_logs" for row in merged):
        warnings.append("Primary source could not be fully verified; operation records are provisional fallback.")
    rows = [{**row, **({"priority_unverified": True} if row["source"] == "wind_operation_logs" and unverified else {})}
            for row in merged[offset:offset + limit]]
    return {"rows": rows, "has_more": len(merged) > offset + limit, "offset": offset, "limit": limit,
            "source": "wind_data", "sources": ["wind_data", "wind_operation_logs"],
            "period_minutes": 60, "timestamp_field": "recorded_at", "timezone": "Asia/Kolkata",
            "truncated": context["truncated"], "partial": any(stream.failed for stream in streams),
            "warning": " ".join(dict.fromkeys(warnings)) or None}
