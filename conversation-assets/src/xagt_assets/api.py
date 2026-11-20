"""FastAPI adapter for the portable conversation asset contract."""

from __future__ import annotations

from dataclasses import dataclass
import json
from typing import Any, Callable

from fastapi import APIRouter, Depends, Header, HTTPException, Path, Query, Request
from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator
from starlette.concurrency import run_in_threadpool


MAX_REQUEST_BYTES = 9 * 1024 * 1024
PORTABLE_ID_PATTERN = r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$"


@dataclass(frozen=True)
class Actor:
    tenant_id: str
    workspace_id: str
    member_id: str
    subject_id: str
    can_ingest: bool = False
    can_manage: bool = False
    can_read: bool = False


class RevisionBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    mode: str = Field(pattern=r"^(cloudProcessable|userHeld)$")
    expectedRevision: str | None = None
    payload: Any

    @field_validator("payload")
    @classmethod
    def _payload_limit(cls, value: Any) -> Any:
        if len(json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")) > 8 * 1024 * 1024:
            raise ValueError("payload exceeds the 8 MiB request limit")
        return value



def _error(exc: Exception) -> HTTPException:
    if isinstance(exc, PermissionError):
        return HTTPException(403, detail={"code": "SCOPE_DENIED", "message": str(exc)})
    if isinstance(exc, FileNotFoundError):
        return HTTPException(404, detail={"code": "NOT_FOUND", "message": str(exc)})
    if isinstance(exc, ValueError):
        message = str(exc)
        if message == "REVISION_CONFLICT":
            return HTTPException(409, detail={"code": message, "message": "asset revision changed"})
        if message == "IDEMPOTENCY_CONFLICT":
            return HTTPException(409, detail={"code": message, "message": "idempotency key has different content"})
        if "userHeld" in message or "encrypted object" in message:
            return HTTPException(400, detail={"code": "INVALID_ENVELOPE", "message": "invalid user-held envelope"})
        return HTTPException(400, detail={"code": "VALIDATION", "message": "invalid revision request"})
    # Database, crypto-library, and programming failures never echo their
    # diagnostics to an untrusted client.
    return HTTPException(500, detail={"code": "ASSET_SERVICE_ERROR", "message": "asset service unavailable"})


def build_router(store: Any, identity: Callable[..., Actor]) -> APIRouter:
    router = APIRouter()

    @router.get("/capabilities")
    def capabilities(actor: Actor = Depends(identity)) -> dict[str, Any]:
        actions: list[str] = []
        if actor.can_read:
            actions.append("read")
        if actor.can_ingest:
            actions.append("ingest")
            actions.append("operation")
        elif actor.can_read:
            actions.append("operation")
        if actor.can_manage:
            actions.append("delete")
        return {"schemaVersion": "xagt-conversation-assets/1", "modes": ["cloudProcessable", "userHeld"], "authenticated": bool(actor.subject_id), "actions": actions}

    @router.put("/conversations/{asset_id}/revisions/{revision_id}", status_code=201)
    async def put_revision(request: Request, asset_id: str = Path(..., pattern=PORTABLE_ID_PATTERN), revision_id: str = Path(..., pattern=PORTABLE_ID_PATTERN), idempotency_key: str = Header(..., alias="Idempotency-Key"), actor: Actor = Depends(identity)) -> dict[str, Any]:
        try:
            content_length = request.headers.get("content-length")
            if content_length is not None and int(content_length) > MAX_REQUEST_BYTES:
                raise ValueError("request body exceeds the 9 MiB limit")
            chunks: list[bytes] = []
            size = 0
            async for chunk in request.stream():
                size += len(chunk)
                if size > MAX_REQUEST_BYTES:
                    raise ValueError("request body exceeds the 9 MiB limit")
                chunks.append(chunk)
            try:
                raw = json.loads(b"".join(chunks))
                body = RevisionBody.model_validate(raw)
            except (json.JSONDecodeError, ValidationError):
                # Do not let FastAPI's default 422 payload echo submitted values.
                raise ValueError("invalid revision request")
            return await run_in_threadpool(
                store.put_revision, actor, asset_id, revision_id, body.mode,
                body.expectedRevision, body.payload, idempotency_key,
            )
        except Exception as exc:
            raise _error(exc) from exc

    @router.get("/conversations")
    def list_conversations(limit: int = Query(50, ge=1, le=100), actor: Actor = Depends(identity)) -> dict[str, Any]:
        try:
            return {"schemaVersion": "xagt-conversation-list/1", "items": store.list_conversations(actor, limit)}
        except Exception as exc:
            raise _error(exc) from exc

    @router.get("/conversations/{asset_id}/revisions/{revision_id}")
    def read_revision(asset_id: str = Path(..., pattern=PORTABLE_ID_PATTERN), revision_id: str = Path(..., pattern=PORTABLE_ID_PATTERN), actor: Actor = Depends(identity)) -> dict[str, Any]:
        try:
            return store.read_revision(actor, asset_id, revision_id)
        except Exception as exc:
            raise _error(exc) from exc

    @router.get("/operations/{operation_id}")
    def operation(operation_id: str = Path(..., pattern=PORTABLE_ID_PATTERN), actor: Actor = Depends(identity)) -> dict[str, Any]:
        try:
            return store.operation(actor, operation_id)
        except Exception as exc:
            raise _error(exc) from exc

    @router.delete("/conversations/{asset_id}")
    def delete_conversation(asset_id: str = Path(..., pattern=PORTABLE_ID_PATTERN), actor: Actor = Depends(identity)) -> dict[str, Any]:
        try:
            return store.delete_conversation(actor, asset_id)
        except Exception as exc:
            raise _error(exc) from exc

    return router
