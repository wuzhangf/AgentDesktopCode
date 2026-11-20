"""Persistent conversation asset store.

The store deliberately has no in-memory ownership or lock state.  PostgreSQL
transactions and unique constraints are the source of truth.  SQLite is
supported for self-hosted development and contract tests.
"""

from __future__ import annotations

import hashlib
import json
import re
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone
from importlib.resources import files
from typing import Any, Callable, Iterator

from .crypto import (EncryptedObject, cloud_decrypt, cloud_encrypt,
                     validate_user_held_envelope)

try:
    import psycopg
except ImportError:  # pragma: no cover - optional in a minimal client install
    psycopg = None


MODES = {"cloudProcessable", "userHeld"}
PORTABLE_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _digest(value: Any) -> str:
    return hashlib.sha256(_json(value).encode("utf-8")).hexdigest()


def _aad(actor: Any, asset_id: str, revision_id: str, mode: str,
         *, subject_id: str | None = None) -> bytes:
    """Bind ciphertext to the complete owner and revision identity."""
    return _json({
        "tenantId": actor.tenant_id,
        "workspaceId": actor.workspace_id,
        "memberId": actor.member_id,
        "subjectId": subject_id if subject_id is not None else actor.subject_id,
        "assetId": asset_id,
        "revisionId": revision_id,
        "mode": mode,
    }).encode("utf-8")


def _cloud_seal(payload: Any, key: bytes, aad: bytes) -> dict[str, Any]:
    """Encrypt cloud-processable JSON with the package's single crypto API."""
    return cloud_encrypt(_json(payload).encode("utf-8"), master_key=key, aad=aad)


def _cloud_open(envelope: dict[str, Any], key: bytes, aad: bytes) -> Any:
    return json.loads(cloud_decrypt(envelope, master_key=key, aad=aad).decode("utf-8"))


def _validate_user_held(payload: Any) -> dict[str, Any]:
    if not isinstance(payload, dict) or set(payload) != {"object", "envelope"}:
        raise ValueError("userHeld payload must contain encrypted object and envelope")
    encrypted = EncryptedObject.from_mapping(payload["object"])
    envelope = validate_user_held_envelope(payload["envelope"])
    return {"object": encrypted.as_dict(), "envelope": envelope}


class AssetStore:
    def __init__(self, dsn: str, cloud_key: bytes | None,
                 write_guard: Callable[[Any, Any], None] | None = None,
                 *, allowed_modes: set[str] | frozenset[str] | None = None):
        self.dsn = dsn
        self.cloud_key = cloud_key
        self.write_guard = write_guard
        self.allowed_modes = frozenset(MODES if allowed_modes is None else allowed_modes)
        if not self.allowed_modes or not self.allowed_modes.issubset(MODES):
            raise ValueError("allowed_modes must be a non-empty subset of supported modes")
        if self.cloud_key is not None and (not isinstance(self.cloud_key, bytes) or len(self.cloud_key) != 32):
            raise ValueError("cloud_key must be exactly 32 bytes")
        if "cloudProcessable" in self.allowed_modes and self.cloud_key is None:
            raise ValueError("cloud_key is required when cloudProcessable is enabled")
        self._sqlite = dsn.startswith("sqlite:")
        if self._sqlite:
            raw = dsn.removeprefix("sqlite:///")
            self.sqlite_path = ":memory:" if raw in {"", ":memory:"} else raw
            self._memory_connection = (
                sqlite3.connect(":memory:", check_same_thread=False)
                if self.sqlite_path == ":memory:" else None
            )
            if self._memory_connection is not None:
                self._memory_connection.row_factory = sqlite3.Row
        else:
            self.sqlite_path = ""
            self._memory_connection = None

    @contextmanager
    def connection(self) -> Iterator[Any]:
        if self._sqlite:
            conn = self._memory_connection or sqlite3.connect(self.sqlite_path, check_same_thread=False)
            if conn.row_factory is None:
                conn.row_factory = sqlite3.Row
            try:
                yield conn
                conn.commit()
            except Exception:
                conn.rollback()
                raise
            finally:
                if self._memory_connection is None:
                    conn.close()
            return
        if psycopg is None:
            raise RuntimeError("psycopg is required for PostgreSQL DSNs")
        with psycopg.connect(self.dsn) as conn:
            yield conn

    def apply_schema(self) -> None:
        schema = files("xagt_assets").joinpath("schema.sql").read_text(encoding="utf-8")
        with self.connection() as conn:
            if self._sqlite:
                conn.executescript(schema)
            else:
                with conn.cursor() as cur:
                    cur.execute(schema)

    def check_schema(self) -> None:
        """Fail closed when the configured database lacks the asset schema."""
        required = {
            "xagt_asset_conversations": {"tenant_id", "workspace_id", "member_id", "asset_id", "deleted_at", "head_revision"},
            "xagt_asset_revisions": {"tenant_id", "workspace_id", "member_id", "subject_id", "asset_id", "revision_id", "payload_json"},
            "xagt_asset_operations": {"tenant_id", "workspace_id", "member_id", "subject_id", "operation_id", "idempotency_key", "result_json"},
            "xagt_asset_tombstones": {"tenant_id", "workspace_id", "member_id", "asset_id", "deleted_at"},
        }
        with self.connection() as conn:
            missing_tables: list[str] = []
            missing_columns: list[str] = []
            for table, columns in required.items():
                if self._sqlite:
                    table_rows = self._query(conn, f"PRAGMA table_info({table})")
                    found = {str(row["name"]) for row in table_rows}
                else:
                    table_rows = self._query(
                        conn,
                        "SELECT column_name AS name FROM information_schema.columns "
                        "WHERE table_schema='public' AND table_name=?",
                        (table,),
                    )
                    found = {str(row["name"]) for row in table_rows}
                if not found:
                    missing_tables.append(table)
                else:
                    missing_columns.extend(f"{table}.{column}" for column in sorted(columns - found))
        if missing_tables or missing_columns:
            details = []
            if missing_tables:
                details.append("missing tables: " + ", ".join(sorted(missing_tables)))
            if missing_columns:
                details.append("missing columns: " + ", ".join(missing_columns))
            raise RuntimeError("asset schema is not ready; " + "; ".join(details))

    def check_attachment_schema(self) -> None:
        """Fail closed only when an attachment service is configured.

        Existing 0.1 deployments may continue serving revision-only assets;
        enabling AttachmentService explicitly opts into this migration check.
        """
        with self.connection() as conn:
            if self._sqlite:
                found = {str(row["name"]) for row in self._query(conn, "PRAGMA table_info(xagt_asset_attachments)")}
            else:
                found = {str(row["name"]) for row in self._query(
                    conn,
                    "SELECT column_name AS name FROM information_schema.columns "
                    "WHERE table_schema='public' AND table_name=?",
                    ("xagt_asset_attachments",))}
        required = {"tenant_id", "workspace_id", "member_id", "subject_id", "asset_id",
                    "revision_id", "attachment_id", "mode", "object_key", "state",
                    "expected_bytes", "sha256", "stored_sha256"}
        missing = sorted(required - found)
        if missing:
            raise RuntimeError("attachment schema is not ready; missing columns: " + ", ".join(missing))

    def _query(self, conn: Any, sql: str, params: tuple[Any, ...] = ()) -> list[dict[str, Any]]:
        if self._sqlite:
            return [dict(row) for row in conn.execute(sql, params).fetchall()]
        with conn.cursor() as cur:
            cur.execute(sql.replace("?", "%s"), params)
            columns = [item.name for item in cur.description] if cur.description else []
            return [dict(zip(columns, row)) for row in cur.fetchall()] if columns else []

    def _exec(self, conn: Any, sql: str, params: tuple[Any, ...] = ()) -> None:
        if self._sqlite:
            conn.execute(sql, params)
        else:
            with conn.cursor() as cur:
                cur.execute(sql.replace("?", "%s"), params)

    def _lock_asset(self, conn: Any, actor: Any, asset_id: str) -> None:
        """Serialize first revision creation even when the asset row is absent."""
        if not self._sqlite:
            lock_name = ":".join(("asset", actor.tenant_id, actor.workspace_id,
                                   actor.member_id, asset_id))
            self._exec(conn, "SELECT pg_advisory_xact_lock(hashtextextended(?, 0))",
                       (lock_name,))

    def _lock_operation(self, conn: Any, actor: Any, idempotency_key: str) -> None:
        """Serialize one subject's idempotency key before selecting its receipt."""
        if not self._sqlite:
            lock_name = ":".join(("operation", actor.tenant_id, actor.workspace_id,
                                   actor.member_id, actor.subject_id, idempotency_key))
            self._exec(conn, "SELECT pg_advisory_xact_lock(hashtextextended(?, 0))",
                       (lock_name,))

    def put_revision(self, actor: Any, asset_id: str, revision_id: str, mode: str,
                     expected_revision: str | None, payload: Any,
                     idempotency_key: str) -> dict[str, Any]:
        if not actor.can_ingest:
            raise PermissionError("assets:ingest is required")
        if mode not in self.allowed_modes:
            raise PermissionError("asset mode is disabled")
        if not idempotency_key or not PORTABLE_ID.fullmatch(idempotency_key):
            raise ValueError("invalid Idempotency-Key")
        if not PORTABLE_ID.fullmatch(asset_id) or not PORTABLE_ID.fullmatch(revision_id):
            raise ValueError("asset and revision IDs must use portable syntax")
        if expected_revision is not None and not PORTABLE_ID.fullmatch(expected_revision):
            raise ValueError("expectedRevision must use portable syntax")
        if mode == "userHeld":
            payload = _validate_user_held(payload)
        elif not isinstance(payload, (dict, list, str, int, float, bool)) and payload is not None:
            raise ValueError("payload is not JSON serializable")
        operation_id = idempotency_key
        created = _now()
        payload_digest = _digest(payload)
        request_digest = _digest({"mode": mode, "expectedRevision": expected_revision,
                                  "payload": payload})
        aad = _aad(actor, asset_id, revision_id, mode)
        stored = payload if mode == "userHeld" else _cloud_seal(payload, self.cloud_key, aad)
        stored_json = _json(stored)
        with self.connection() as conn:
            if self.write_guard is not None:
                self.write_guard(conn, actor)
            # Stable lock order: operation key, then asset key.
            self._lock_operation(conn, actor, idempotency_key)
            self._lock_asset(conn, actor, asset_id)
            existing = self._query(conn, "SELECT operation_id,payload_digest,result_json FROM xagt_asset_operations WHERE tenant_id=? AND workspace_id=? AND member_id=? AND subject_id=? AND idempotency_key=?", (actor.tenant_id, actor.workspace_id, actor.member_id, actor.subject_id, idempotency_key))
            if existing:
                row = existing[0]
                if row["payload_digest"] != request_digest:
                    raise ValueError("IDEMPOTENCY_CONFLICT")
                result = json.loads(row["result_json"] or "{}")
                if result.get("assetId") != asset_id or result.get("revisionId") != revision_id:
                    raise ValueError("IDEMPOTENCY_CONFLICT")
                result["replayed"] = True
                return result
            asset_query = "SELECT head_revision,deleted_at FROM xagt_asset_conversations WHERE tenant_id=? AND workspace_id=? AND member_id=? AND asset_id=?"
            if not self._sqlite:
                asset_query += " FOR UPDATE"
            asset = self._query(conn, asset_query, (actor.tenant_id, actor.workspace_id, actor.member_id, asset_id))
            if asset and asset[0]["deleted_at"] is not None:
                raise ValueError("REVISION_CONFLICT")
            current = asset[0]["head_revision"] if asset else None
            head_subject = None
            if asset and current is not None:
                head_rows = self._query(conn, "SELECT subject_id FROM xagt_asset_revisions WHERE tenant_id=? AND workspace_id=? AND member_id=? AND asset_id=? AND revision_id=?", (actor.tenant_id, actor.workspace_id, actor.member_id, asset_id, current))
                head_subject = head_rows[0]["subject_id"] if head_rows else None
            if (asset and current is not None and head_subject != actor.subject_id
                    and not actor.can_manage):
                raise PermissionError("assets:manage is required to advance another subject's conversation")
            if expected_revision != current:
                raise ValueError("REVISION_CONFLICT")
            if not asset:
                self._exec(conn, "INSERT INTO xagt_asset_conversations (tenant_id,workspace_id,member_id,asset_id,title,created_at,updated_at,head_revision) VALUES (?,?,?,?,?,?,?,?)", (actor.tenant_id, actor.workspace_id, actor.member_id, asset_id, "", created, created, revision_id))
            else:
                self._exec(conn, "UPDATE xagt_asset_conversations SET updated_at=?,head_revision=? WHERE tenant_id=? AND workspace_id=? AND member_id=? AND asset_id=?", (created, revision_id, actor.tenant_id, actor.workspace_id, actor.member_id, asset_id))
            self._exec(conn, "INSERT INTO xagt_asset_revisions (tenant_id,workspace_id,member_id,subject_id,asset_id,revision_id,parent_revision,mode,payload_json,payload_digest,operation_id,idempotency_key,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)", (actor.tenant_id, actor.workspace_id, actor.member_id, actor.subject_id, asset_id, revision_id, expected_revision, mode, stored_json, payload_digest, operation_id, idempotency_key, created))
            result = {"operationId": operation_id, "assetId": asset_id, "revisionId": revision_id, "mode": mode, "state": "sealed", "payloadDigest": payload_digest, "replayed": False}
            self._exec(conn, "INSERT INTO xagt_asset_operations (tenant_id,workspace_id,member_id,subject_id,operation_id,idempotency_key,asset_id,revision_id,payload_digest,state,result_json,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)", (actor.tenant_id, actor.workspace_id, actor.member_id, actor.subject_id, operation_id, idempotency_key, asset_id, revision_id, request_digest, "sealed", _json(result), created))
            return result

    def read_revision(self, actor: Any, asset_id: str, revision_id: str) -> dict[str, Any]:
        if not actor.can_read:
            raise PermissionError("assets:read is required")
        with self.connection() as conn:
            rows = self._query(conn, "SELECT r.* FROM xagt_asset_revisions r JOIN xagt_asset_conversations c ON c.tenant_id=r.tenant_id AND c.workspace_id=r.workspace_id AND c.member_id=r.member_id AND c.asset_id=r.asset_id WHERE r.tenant_id=? AND r.workspace_id=? AND r.member_id=? AND r.asset_id=? AND r.revision_id=? AND c.deleted_at IS NULL", (actor.tenant_id, actor.workspace_id, actor.member_id, asset_id, revision_id))
            if not rows:
                raise FileNotFoundError("conversation revision not found")
            row = rows[0]
            stored = json.loads(row["payload_json"])
            if row["mode"] == "cloudProcessable":
                if "cloudProcessable" not in self.allowed_modes or self.cloud_key is None:
                    raise PermissionError("asset mode is disabled")
                aad = _aad(actor, asset_id, revision_id, row["mode"], subject_id=row["subject_id"])
                stored = _cloud_open(stored, self.cloud_key, aad)
            return {"assetId": asset_id, "revisionId": revision_id, "parentRevision": row["parent_revision"], "mode": row["mode"], "payload": stored, "payloadDigest": row["payload_digest"], "createdAt": row["created_at"]}

    def list_conversations(self, actor: Any, limit: int = 50) -> list[dict[str, Any]]:
        if not actor.can_read:
            raise PermissionError("assets:read is required")
        limit = max(1, min(int(limit), 100))
        with self.connection() as conn:
            if self.allowed_modes == MODES:
                return self._query(conn, "SELECT asset_id,title,created_at,updated_at,head_revision FROM xagt_asset_conversations WHERE tenant_id=? AND workspace_id=? AND member_id=? AND deleted_at IS NULL ORDER BY updated_at DESC,asset_id DESC LIMIT ?", (actor.tenant_id, actor.workspace_id, actor.member_id, limit))
            mode = next(iter(self.allowed_modes))
            return self._query(conn, "SELECT c.asset_id,c.title,c.created_at,c.updated_at,c.head_revision FROM xagt_asset_conversations c WHERE c.tenant_id=? AND c.workspace_id=? AND c.member_id=? AND c.deleted_at IS NULL AND (c.head_revision IS NULL OR EXISTS (SELECT 1 FROM xagt_asset_revisions r WHERE r.tenant_id=c.tenant_id AND r.workspace_id=c.workspace_id AND r.member_id=c.member_id AND r.asset_id=c.asset_id AND r.revision_id=c.head_revision AND r.mode=?)) ORDER BY c.updated_at DESC,c.asset_id DESC LIMIT ?", (actor.tenant_id, actor.workspace_id, actor.member_id, mode, limit))

    def operation(self, actor: Any, operation_id: str) -> dict[str, Any]:
        if not actor.can_read and not actor.can_ingest:
            raise PermissionError("assets:read or assets:ingest is required")
        if not PORTABLE_ID.fullmatch(operation_id):
            raise FileNotFoundError("operation not found")
        with self.connection() as conn:
            rows = self._query(conn, "SELECT result_json FROM xagt_asset_operations WHERE tenant_id=? AND workspace_id=? AND member_id=? AND subject_id=? AND operation_id=?", (actor.tenant_id, actor.workspace_id, actor.member_id, actor.subject_id, operation_id))
            if not rows:
                raise FileNotFoundError("operation not found")
            return json.loads(rows[0]["result_json"] or "{}")

    def delete_conversation(self, actor: Any, asset_id: str) -> dict[str, Any]:
        if not actor.can_manage:
            raise PermissionError("assets:manage is required")
        if not PORTABLE_ID.fullmatch(asset_id):
            raise FileNotFoundError("conversation not found")
        deleted = _now()
        with self.connection() as conn:
            if self.write_guard is not None:
                self.write_guard(conn, actor)
            self._lock_asset(conn, actor, asset_id)
            rows = self._query(conn, "SELECT deleted_at FROM xagt_asset_conversations WHERE tenant_id=? AND workspace_id=? AND member_id=? AND asset_id=?", (actor.tenant_id, actor.workspace_id, actor.member_id, asset_id))
            if not rows:
                raise FileNotFoundError("conversation not found")
            if rows[0]["deleted_at"] is not None:
                deleted = rows[0]["deleted_at"]
            else:
                self._exec(conn, "UPDATE xagt_asset_revisions SET payload_json=? WHERE tenant_id=? AND workspace_id=? AND member_id=? AND asset_id=?", ("null", actor.tenant_id, actor.workspace_id, actor.member_id, asset_id))
                self._exec(conn, "UPDATE xagt_asset_conversations SET deleted_at=?,updated_at=? WHERE tenant_id=? AND workspace_id=? AND member_id=? AND asset_id=?", (deleted, deleted, actor.tenant_id, actor.workspace_id, actor.member_id, asset_id))
                self._exec(conn, "INSERT INTO xagt_asset_tombstones (tenant_id,workspace_id,member_id,asset_id,deleted_at,deletion_epoch) VALUES (?,?,?,?,?,?) ON CONFLICT (tenant_id,workspace_id,member_id,asset_id) DO UPDATE SET deleted_at=excluded.deleted_at,deletion_epoch=excluded.deletion_epoch", (actor.tenant_id, actor.workspace_id, actor.member_id, asset_id, deleted, int(datetime.now(timezone.utc).timestamp())))
        attachment_service = getattr(self, "_attachment_service", None)
        if attachment_service is not None:
            # Object deletion is idempotent and can be retried by the same
            # service if an object backend is temporarily unavailable.
            attachment_service.delete_conversation(actor, asset_id)
        return {"assetId": asset_id, "state": "deleted", "deletedAt": deleted}


Store = AssetStore
