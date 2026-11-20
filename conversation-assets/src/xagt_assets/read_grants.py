"""Optional, single-revision read grants for self-hosted asset services.

Grant tokens are short-lived bearer capabilities.  Only a SHA-256 digest is
stored.  The token endpoint has no identity context: every read rechecks the
grant, its expiry/revocation, the exact asset and revision, the current
tombstone, and the revision's mode before returning data.  Grants never write
assets and deliberately do not include attachments or a key-wrapping API.
"""

from __future__ import annotations

import hashlib
import json
import secrets
from datetime import datetime, timedelta, timezone
from importlib.resources import files
from typing import Any, Callable, Mapping

from fastapi import APIRouter, Depends, Header, HTTPException, Path as ApiPath
from pydantic import BaseModel, ConfigDict, Field

from .api import Actor, PORTABLE_ID_PATTERN
from .crypto import EncryptedObject, validate_user_held_envelope
from .store import MODES, _aad, _cloud_open


MAX_GRANT_TTL_SECONDS = 15 * 60


class GrantError(ValueError):
    """Grant schema or lifecycle validation failed."""


class ReadGrantCreate(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)
    asset_id: str = Field(alias="assetId", pattern=PORTABLE_ID_PATTERN)
    revision_id: str = Field(alias="revisionId", pattern=PORTABLE_ID_PATTERN)
    mode: str = Field(pattern=r"^(cloudProcessable|userHeld)$")
    expires_in_seconds: int = Field(alias="expiresInSec", ge=1, le=MAX_GRANT_TTL_SECONDS)
    recipient_device_id: str | None = Field(default=None, alias="recipientDeviceId", min_length=1, max_length=256)


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _timestamp(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def _parse_timestamp(value: Any) -> datetime:
    if not isinstance(value, str):
        raise GrantError("invalid grant expiry")
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise GrantError("invalid grant expiry") from exc
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _digest(token: str) -> str:
    return hashlib.sha256(token.encode("ascii")).hexdigest()


def _bearer(header: str | None) -> str:
    if not isinstance(header, str) or len(header) < 8:
        raise HTTPException(401, detail={"code": "INVALID_GRANT_TOKEN", "message": "grant token is invalid"})
    scheme, _, token = header.partition(" ")
    if scheme.lower() != "bearer" or not token or len(token) > 256 or not token.isascii() or any(char.isspace() for char in token):
        raise HTTPException(401, detail={"code": "INVALID_GRANT_TOKEN", "message": "grant token is invalid"})
    return token


def apply_grant_schema(store: Any) -> None:
    """Install only the optional grant tables in the supplied Store."""
    schema = files("xagt_assets").joinpath("grant_schema.sql").read_text(encoding="utf-8")
    with store.connection() as conn:
        if getattr(store, "_sqlite", False):
            conn.executescript(schema)
        else:
            with conn.cursor() as cursor:
                cursor.execute(schema)


def check_grant_schema(store: Any) -> None:
    """Fail closed when optional grant tables have not been installed."""
    required = {"tenant_id", "workspace_id", "member_id", "grant_id", "asset_id",
                "revision_id", "mode", "token_digest", "expires_at", "revoked_at"}
    with store.connection() as conn:
        if getattr(store, "_sqlite", False):
            rows = store._query(conn, "PRAGMA table_info(xagt_asset_read_grants)")
        else:
            rows = store._query(conn,
                "SELECT column_name AS name FROM information_schema.columns "
                "WHERE table_schema='public' AND table_name=?", ("xagt_asset_read_grants",))
    found = {str(row["name"]) for row in rows}
    if not found:
        raise RuntimeError("grant schema is not ready; missing table: xagt_asset_read_grants")
    missing = sorted(required - found)
    if missing:
        raise RuntimeError("grant schema is not ready; missing columns: " + ", ".join(missing))


def _owner_revision(store: Any, actor: Actor, asset_id: str, revision_id: str) -> dict[str, Any]:
    with store.connection() as conn:
        rows = store._query(conn,
            "SELECT r.tenant_id,r.workspace_id,r.member_id,r.subject_id,r.asset_id,r.revision_id,"
            "r.mode,r.payload_json,c.deleted_at FROM xagt_asset_revisions r "
            "JOIN xagt_asset_conversations c ON c.tenant_id=r.tenant_id "
            "AND c.workspace_id=r.workspace_id AND c.member_id=r.member_id AND c.asset_id=r.asset_id "
            "WHERE r.tenant_id=? AND r.workspace_id=? AND r.member_id=? "
            "AND r.asset_id=? AND r.revision_id=?",
            (actor.tenant_id, actor.workspace_id, actor.member_id, asset_id, revision_id))
    if not rows or rows[0]["deleted_at"] is not None or rows[0]["payload_json"] in (None, "null"):
        raise FileNotFoundError("conversation revision not found")
    return rows[0]


def _token_grant(store: Any, grant_id: str, token: str, asset_id: str, revision_id: str) -> dict[str, Any]:
    """Look up and fully revalidate a bearer grant without local identity."""
    digest = _digest(token)
    with store.connection() as conn:
        rows = store._query(conn,
            "SELECT g.*,r.subject_id AS revision_subject,r.mode AS revision_mode,r.payload_json,"
            "c.deleted_at FROM xagt_asset_read_grants g "
            "JOIN xagt_asset_revisions r ON r.tenant_id=g.tenant_id AND r.workspace_id=g.workspace_id "
            "AND r.member_id=g.member_id AND r.asset_id=g.asset_id AND r.revision_id=g.revision_id "
            "JOIN xagt_asset_conversations c ON c.tenant_id=g.tenant_id AND c.workspace_id=g.workspace_id "
            "AND c.member_id=g.member_id AND c.asset_id=g.asset_id "
            "WHERE g.grant_id=? AND g.token_digest=? AND g.asset_id=? AND g.revision_id=?",
            (grant_id, digest, asset_id, revision_id))
    if not rows:
        raise HTTPException(401, detail={"code": "INVALID_GRANT_TOKEN", "message": "grant token is invalid"})
    row = rows[0]
    if row["revoked_at"] is not None:
        raise HTTPException(401, detail={"code": "GRANT_REVOKED", "message": "grant token is no longer valid"})
    if _parse_timestamp(row["expires_at"]) <= _now():
        raise HTTPException(401, detail={"code": "GRANT_EXPIRED", "message": "grant token has expired"})
    if row["deleted_at"] is not None or row["payload_json"] in (None, "null"):
        raise HTTPException(410, detail={"code": "ASSET_DELETED", "message": "asset is no longer available"})
    if row["mode"] != row["revision_mode"] or row["mode"] not in MODES:
        raise HTTPException(403, detail={"code": "GRANT_MODE_DENIED", "message": "grant mode is unavailable"})
    return row


def _user_held_result(row: Mapping[str, Any], *, grant_id: str) -> dict[str, Any]:
    try:
        stored = json.loads(row["payload_json"])
        if not isinstance(stored, Mapping) or set(stored) != {"object", "envelope"}:
            raise ValueError
        encrypted = EncryptedObject.from_mapping(stored["object"]).as_dict()
        envelope = validate_user_held_envelope(stored["envelope"])
    except (TypeError, ValueError, json.JSONDecodeError) as exc:
        raise HTTPException(500, detail={"code": "ASSET_SERVICE_ERROR", "message": "asset service unavailable"}) from exc
    recipient = row.get("recipient_device_id")
    if recipient is not None and envelope.get("recipientDeviceId") != recipient:
        raise HTTPException(403, detail={"code": "GRANT_RECIPIENT_DENIED", "message": "trusted recipient does not match"})
    return {"schemaVersion": "xagt-read-grant/1", "grantId": grant_id,
            "assetId": row["asset_id"], "revisionId": row["revision_id"],
            "mode": "userHeld", "payload": {"object": encrypted, "envelope": envelope},
            "requiresTrustedDeviceKey": True}


def build_grant_router(store: Any, identity: Callable[..., Actor]) -> APIRouter:
    """Build the optional grant router; callers must install its schema first."""
    router = APIRouter()

    @router.post("/grants", status_code=201)
    def issue_grant(body: ReadGrantCreate, actor: Actor = Depends(identity)) -> dict[str, Any]:
        if not actor.can_manage:
            raise HTTPException(403, detail={"code": "OWNER_REQUIRED", "message": "asset owner permission is required"})
        try:
            revision = _owner_revision(store, actor, body.asset_id, body.revision_id)
        except FileNotFoundError as exc:
            raise HTTPException(404, detail={"code": "NOT_FOUND", "message": "conversation revision not found"}) from exc
        if body.mode != revision["mode"] or body.mode not in getattr(store, "allowed_modes", MODES):
            raise HTTPException(409, detail={"code": "GRANT_MODE_MISMATCH", "message": "grant mode does not match revision"})
        recipient = body.recipient_device_id
        if body.mode == "userHeld":
            try:
                payload = json.loads(revision["payload_json"])
                envelope = validate_user_held_envelope(payload["envelope"])
            except (TypeError, KeyError, ValueError, json.JSONDecodeError) as exc:
                raise HTTPException(409, detail={"code": "INVALID_ENVELOPE", "message": "user-held revision is unavailable"}) from exc
            if recipient is not None and recipient != envelope["recipientDeviceId"]:
                raise HTTPException(403, detail={"code": "GRANT_RECIPIENT_DENIED", "message": "recipient is not already trusted"})
            recipient = recipient or envelope["recipientDeviceId"]
        token = secrets.token_urlsafe(32)
        grant_id = "grant-" + secrets.token_hex(16)
        created = _now()
        expires = created + timedelta(seconds=body.expires_in_seconds)
        with store.connection() as conn:
            store._exec(conn,
                "INSERT INTO xagt_asset_read_grants (tenant_id,workspace_id,member_id,grant_id,asset_id,revision_id,mode,token_digest,recipient_device_id,expires_at,revoked_at,created_at,created_by_subject) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (actor.tenant_id, actor.workspace_id, actor.member_id, grant_id, body.asset_id,
                 body.revision_id, body.mode, _digest(token), recipient, _timestamp(expires),
                 None, _timestamp(created), actor.subject_id))
        return {"schemaVersion": "xagt-read-grant/1", "grantId": grant_id,
                "assetId": body.asset_id, "revisionId": body.revision_id, "mode": body.mode,
                "recipientDeviceId": recipient, "expiresAt": _timestamp(expires), "token": token}

    @router.delete("/grants/{grant_id}")
    def revoke_grant(grant_id: str = ApiPath(..., pattern=PORTABLE_ID_PATTERN), actor: Actor = Depends(identity)) -> dict[str, Any]:
        if not actor.can_manage:
            raise HTTPException(403, detail={"code": "OWNER_REQUIRED", "message": "asset owner permission is required"})
        with store.connection() as conn:
            rows = store._query(conn,
                "UPDATE xagt_asset_read_grants SET revoked_at=COALESCE(revoked_at,?) "
                "WHERE tenant_id=? AND workspace_id=? AND member_id=? AND grant_id=? RETURNING revoked_at",
                (_timestamp(_now()), actor.tenant_id, actor.workspace_id, actor.member_id, grant_id))
        if not rows:
            raise HTTPException(404, detail={"code": "NOT_FOUND", "message": "grant not found"})
        return {"schemaVersion": "xagt-read-grant/1", "grantId": grant_id,
                "state": "revoked", "revokedAt": rows[0]["revoked_at"]}

    @router.get("/grants/{grant_id}/conversations/{asset_id}/revisions/{revision_id}")
    def read_granted_revision(grant_id: str = ApiPath(..., pattern=PORTABLE_ID_PATTERN),
                              asset_id: str = ApiPath(..., pattern=PORTABLE_ID_PATTERN),
                              revision_id: str = ApiPath(..., pattern=PORTABLE_ID_PATTERN),
                              authorization: str | None = Header(default=None, alias="Authorization")) -> dict[str, Any]:
        token = _bearer(authorization)
        row = _token_grant(store, grant_id, token, asset_id, revision_id)
        if row["mode"] not in store.allowed_modes:
            raise HTTPException(403, detail={"code": "GRANT_MODE_DENIED", "message": "grant mode is unavailable"})
        if row["mode"] == "userHeld":
            return _user_held_result(row, grant_id=grant_id)
        if getattr(store, "cloud_key", None) is None:
            raise HTTPException(403, detail={"code": "GRANT_MODE_DENIED", "message": "private cloud processing is unavailable"})
        try:
            stored = json.loads(row["payload_json"])
            scoped_actor = Actor(row["tenant_id"], row["workspace_id"], row["member_id"], row["revision_subject"], can_read=True)
            payload = _cloud_open(stored, store.cloud_key, _aad(scoped_actor, asset_id, revision_id, row["mode"], subject_id=row["revision_subject"]))
        except (TypeError, ValueError, json.JSONDecodeError) as exc:
            raise HTTPException(500, detail={"code": "ASSET_SERVICE_ERROR", "message": "asset service unavailable"}) from exc
        return {"schemaVersion": "xagt-read-grant/1", "grantId": grant_id,
                "assetId": asset_id, "revisionId": revision_id,
                "mode": "cloudProcessable", "payload": payload}

    return router


__all__ = ["GrantError", "ReadGrantCreate", "MAX_GRANT_TTL_SECONDS",
           "apply_grant_schema", "check_grant_schema", "build_grant_router"]
