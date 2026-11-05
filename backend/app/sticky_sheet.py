"""Feature-gated sticky sheet registration; all mutations go through one RPC."""
from __future__ import annotations

import hmac
import os
from datetime import datetime, timedelta, timezone
from typing import Any, Callable
from uuid import UUID

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse

STATE_COLUMNS = "device_id,registered_at,completed_advances"
REQUEST_COLUMNS = (
    "request_id,device_id,action,requested_at,status,acknowledged_at,error_code"
)
UNAVAILABLE = "Sticky sheet service is unavailable. Retry with the same request_id."


def configuration() -> tuple[bool, str]:
    token = os.getenv("STICKY_SHEET_REPLACEMENT_TOKEN", "")
    return os.getenv("STICKY_SHEET_REPLACEMENT_ENABLED", "") == "true" and bool(token.strip()), token


def validate_body(body: Any, device_id: str) -> dict[str, Any]:
    required = {"device_id", "request_id", "requested_at", "action"}
    if not isinstance(body, dict) or not required <= body.keys() or body.keys() - required - {"retry"}:
        raise ValueError("Invalid fields")
    if body["device_id"] != device_id or body["action"] != "register_new_sticky_sheet":
        raise ValueError("Invalid target or action")
    if not isinstance(body["request_id"], str) or not isinstance(body["requested_at"], str):
        raise ValueError("Invalid request metadata")
    request_id = str(UUID(body["request_id"]))
    timestamp = datetime.fromisoformat(body["requested_at"].replace("Z", "+00:00"))
    if timestamp.tzinfo is None or timestamp.utcoffset() is None:
        raise ValueError("Timezone required")
    if timestamp > datetime.now(timezone.utc) + timedelta(minutes=5):
        raise ValueError("Future timestamp")
    retry = body.get("retry", False)
    if type(retry) is not bool:
        raise ValueError("Invalid retry")
    return {
        "p_device_id": device_id,
        "p_request_id": request_id,
        "p_requested_at": timestamp.isoformat(),
        "p_retry": retry,
    }


def optional_row(data: Any) -> dict[str, Any] | None:
    if data is None or data == []:
        return None
    if isinstance(data, dict):
        return data
    if isinstance(data, list) and len(data) == 1 and isinstance(data[0], dict):
        return data[0]
    raise ValueError("Unexpected database response")


def create_router(get_client: Callable[[], Any], device_id: str) -> APIRouter:
    router = APIRouter()

    @router.get("/api/sticky-sheet")
    def get_sticky_sheet() -> dict[str, Any]:
        enabled, _ = configuration()
        result = {"device_id": device_id, "enabled": enabled, "state": None, "request": None}
        if not enabled:
            return result
        try:
            client = get_client()
            result["state"] = optional_row(
                client.table("sticky_sheet_state").select(STATE_COLUMNS)
                .eq("device_id", device_id).limit(1).execute().data
            )
            result["request"] = optional_row(
                client.table("sticky_sheet_replacement_requests").select(REQUEST_COLUMNS)
                .eq("device_id", device_id).order("created_at", desc=True)
                .limit(1).execute().data
            )
        except Exception:
            # Never log database exceptions, which may contain credentials or payloads.
            raise HTTPException(status_code=503, detail=UNAVAILABLE) from None
        return result

    @router.post("/api/sticky-sheet")
    async def register_sticky_sheet(request: Request) -> JSONResponse:
        enabled, token = configuration()
        if not enabled:
            raise HTTPException(status_code=503, detail=UNAVAILABLE)
        authorization = request.headers.get("Authorization", "")
        scheme, separator, supplied = authorization.partition(" ")
        if not separator or scheme.lower() != "bearer" or not hmac.compare_digest(
            supplied.encode("utf-8"), token.encode("utf-8")
        ):
            raise HTTPException(status_code=401, detail="Unauthorized")
        try:
            body = await request.json()
            parameters = validate_body(body, device_id)
        except (ValueError, TypeError, OverflowError):
            raise HTTPException(status_code=400, detail="Invalid sticky sheet request.") from None
        try:
            row = get_client().rpc("register_sticky_sheet_replacement", parameters).execute().data
            if not isinstance(row, dict) or row.get("status") not in {"pending", "completed", "failed"}:
                raise ValueError("Unexpected RPC response")
            return JSONResponse({"request": row}, status_code=200 if row["status"] == "completed" else 202)
        except Exception:
            raise HTTPException(status_code=503, detail=UNAVAILABLE) from None

    return router
