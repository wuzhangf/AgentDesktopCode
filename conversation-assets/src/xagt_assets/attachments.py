"""Staged immutable conversation attachments backed by an S3 object store."""

from __future__ import annotations

import hashlib
import json
import re
from datetime import datetime, timedelta, timezone
from typing import Any

from .api import Actor
from .crypto import EncryptedObject, cloud_decrypt, cloud_encrypt, validate_user_held_envelope
from .object_store import ObjectNotFound, ObjectStore, random_object_key
from .store import MODES, PORTABLE_ID, _json, _now

MAX_ATTACHMENT_BYTES = 64 * 1024 * 1024
SHA256 = re.compile(r"^[0-9a-f]{64}$")


def _attachment_aad(row: dict[str, Any]) -> bytes:
    value = {"v": "xagt-asset-crypto/1", "tenantId": row["tenant_id"],
             "workspaceId": row["workspace_id"], "memberId": row["member_id"],
             "subjectId": row["subject_id"], "assetId": row["asset_id"],
             "revisionId": row["revision_id"], "attachmentId": row["attachment_id"],
             "mode": row["mode"], "keyEpoch": "1"}
    return json.dumps(value, ensure_ascii=False, sort_keys=True,
                      separators=(",", ":")).encode("utf-8")


class AttachmentService:
    """Metadata transaction plus CAS object upload/commit operations."""

    def __init__(self, asset_store: Any, object_store: ObjectStore,
                 *, max_bytes: int = MAX_ATTACHMENT_BYTES) -> None:
        if max_bytes < 1 or max_bytes > MAX_ATTACHMENT_BYTES:
            raise ValueError("max_bytes is outside the supported attachment limit")
        self.asset_store = asset_store
        self.object_store = object_store
        self.max_bytes = max_bytes
        self.asset_store.check_attachment_schema()
        # AssetStore invokes this hook after a conversation tombstone is
        # written, so an ordinary conversation delete cannot orphan objects.
        self.asset_store._attachment_service = self

    @staticmethod
    def _id(value: str, name: str) -> str:
        if not isinstance(value, str) or not PORTABLE_ID.fullmatch(value):
            raise ValueError(f"invalid {name}")
        return value

    def _lock_write(self, conn: Any, actor: Any, asset_id: str) -> None:
        if self.asset_store.write_guard is not None:
            self.asset_store.write_guard(conn, actor)
        self.asset_store._lock_asset(conn, actor, asset_id)

    def _revision(self, conn: Any, actor: Any, asset_id: str,
                  revision_id: str, *, write: bool = False) -> dict[str, Any]:
        rows = self.asset_store._query(
            conn,
            "SELECT r.tenant_id,r.workspace_id,r.member_id,r.subject_id,r.asset_id,r.revision_id,r.mode "
            "FROM xagt_asset_revisions r JOIN xagt_asset_conversations c "
            "ON c.tenant_id=r.tenant_id AND c.workspace_id=r.workspace_id "
            "AND c.member_id=r.member_id AND c.asset_id=r.asset_id "
            "WHERE r.tenant_id=? AND r.workspace_id=? AND r.member_id=? "
            "AND r.asset_id=? AND r.revision_id=? AND c.deleted_at IS NULL",
            (actor.tenant_id, actor.workspace_id, actor.member_id, asset_id, revision_id),
        )
        if not rows:
            raise FileNotFoundError("conversation revision not found")
        row = rows[0]
        if row["mode"] not in self.asset_store.allowed_modes:
            raise FileNotFoundError("conversation revision not found")
        if not write and not actor.can_read:
            raise PermissionError("assets:read is required")
        if write and row["subject_id"] != actor.subject_id and not actor.can_manage:
            raise PermissionError("assets:manage is required for another subject's revision")
        return row

    @staticmethod
    def _metadata(row: dict[str, Any], *, replayed: bool = False) -> dict[str, Any]:
        result = {"attachmentId": row["attachment_id"], "assetId": row["asset_id"],
                  "revisionId": row["revision_id"], "mode": row["mode"],
                  # User-held metadata is opaque to the service.  A caller
                  # can inspect its own encrypted inner object after GET.
                  "contentType": row["content_type"] if row["mode"] == "cloudProcessable"
                  else "application/octet-stream",
                  "expectedBytes": int(row["expected_bytes"]), "sha256": row["sha256"],
                  "state": row["state"], "createdAt": row["created_at"]}
        if row.get("committed_at"):
            result["committedAt"] = row["committed_at"]
        if replayed:
            result["replayed"] = True
        return result

    def create(self, actor: Any, asset_id: str, revision_id: str,
               attachment_id: str, *, mode: str, content_type: str,
               expected_bytes: int, sha256: str,
               envelope: dict[str, Any] | None = None) -> dict[str, Any]:
        if not actor.can_ingest:
            raise PermissionError("assets:ingest is required")
        for value, name in ((asset_id, "asset ID"), (revision_id, "revision ID"),
                            (attachment_id, "attachment ID")):
            self._id(value, name)
        if mode not in MODES or mode not in getattr(self.asset_store, "allowed_modes", MODES):
            raise PermissionError("asset mode is disabled")
        if not isinstance(content_type, str) or not 1 <= len(content_type) <= 256:
            raise ValueError("invalid attachment content type")
        if not isinstance(expected_bytes, int) or expected_bytes < 0 or expected_bytes > self.max_bytes:
            raise ValueError("attachment exceeds the configured size limit")
        if not isinstance(sha256, str) or not SHA256.fullmatch(sha256.lower()):
            raise ValueError("sha256 must be a lowercase hex digest")
        normalized_envelope: dict[str, str] | None = None
        if mode == "userHeld":
            if envelope is None:
                raise ValueError("userHeld attachment requires an envelope")
            normalized_envelope = validate_user_held_envelope(envelope)
        elif envelope is not None:
            raise ValueError("cloudProcessable attachment cannot include an envelope")
        with self.asset_store.connection() as conn:
            self._lock_write(conn, actor, asset_id)
            revision = self._revision(conn, actor, asset_id, revision_id, write=True)
            if revision["mode"] != mode:
                raise ValueError("attachment mode must match revision mode")
            existing = self.asset_store._query(
                conn, "SELECT * FROM xagt_asset_attachments WHERE tenant_id=? AND workspace_id=? "
                "AND member_id=? AND asset_id=? AND revision_id=? AND attachment_id=?",
                (actor.tenant_id, actor.workspace_id, actor.member_id, asset_id, revision_id, attachment_id))
            if existing:
                row = existing[0]
                same = (row["asset_id"] == asset_id and row["revision_id"] == revision_id
                        and row["mode"] == mode and row["content_type"] == content_type
                        and int(row["expected_bytes"]) == expected_bytes
                        and row["sha256"] == sha256.lower())
                if same and row["state"] != "deleted":
                    return self._metadata(row, replayed=True)
                raise ValueError("ATTACHMENT_CONFLICT")
            created = _now()
            scope = ":".join((revision["tenant_id"], revision["workspace_id"],
                              revision["member_id"], asset_id, revision_id, attachment_id))
            object_key = random_object_key(scope)
            self.asset_store._exec(
                conn,
                "INSERT INTO xagt_asset_attachments "
                "(tenant_id,workspace_id,member_id,subject_id,asset_id,revision_id,"
                "attachment_id,mode,content_type,expected_bytes,sha256,object_key,state,"
                "envelope_json,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (revision["tenant_id"], revision["workspace_id"], revision["member_id"],
                 revision["subject_id"], asset_id, revision_id, attachment_id, mode,
                 content_type, expected_bytes, sha256.lower(), object_key, "staged",
                 _json(normalized_envelope) if normalized_envelope is not None else None, created))
            row = self.asset_store._query(
                conn, "SELECT * FROM xagt_asset_attachments WHERE tenant_id=? AND workspace_id=? "
                "AND member_id=? AND asset_id=? AND revision_id=? AND attachment_id=?",
                (actor.tenant_id, actor.workspace_id, actor.member_id, asset_id, revision_id, attachment_id))[0]
            return self._metadata(row)

    def _attachment(self, conn: Any, actor: Any, asset_id: str,
                    revision_id: str, attachment_id: str, *, read: bool = False,
                    manage: bool = False) -> dict[str, Any]:
        if read and not actor.can_read:
            raise PermissionError("assets:read is required")
        if manage and not actor.can_manage:
            raise PermissionError("assets:manage is required")
        for value, name in ((asset_id, "asset ID"), (revision_id, "revision ID"),
                            (attachment_id, "attachment ID")):
            self._id(value, name)
        self._revision(conn, actor, asset_id, revision_id, write=not read)
        rows = self.asset_store._query(
            conn,
            "SELECT * FROM xagt_asset_attachments WHERE tenant_id=? AND workspace_id=? "
            "AND member_id=? AND asset_id=? AND revision_id=? AND attachment_id=?",
            (actor.tenant_id, actor.workspace_id, actor.member_id,
             asset_id, revision_id, attachment_id))
        if not rows or rows[0]["state"] == "deleted":
            raise FileNotFoundError("attachment not found")
        if rows[0]["mode"] not in getattr(self.asset_store, "allowed_modes", MODES):
            raise PermissionError("asset mode is disabled")
        return rows[0]

    def upload(self, actor: Any, asset_id: str, revision_id: str,
               attachment_id: str, data: bytes) -> dict[str, Any]:
        if not actor.can_ingest:
            raise PermissionError("assets:ingest is required")
        if not isinstance(data, bytes) or len(data) > self.max_bytes:
            raise ValueError("attachment exceeds the configured size limit")
        digest = hashlib.sha256(data).hexdigest()
        with self.asset_store.connection() as conn:
            self._lock_write(conn, actor, asset_id)
            row = self._attachment(conn, actor, asset_id, revision_id, attachment_id)
            if int(row["expected_bytes"]) != len(data) or row["sha256"] != digest:
                raise ValueError("ATTACHMENT_DIGEST_MISMATCH")
            if row["state"] == "committed":
                return self._metadata(row, replayed=True)
            # A request may have reached S3 while the database response was
            # lost.  Reconcile the immutable object before generating a new
            # randomized cloud ciphertext; this makes retries deterministic
            # without reusing a nonce.
            try:
                existing, existing_meta = self.object_store.get(row["object_key"])
            except ObjectNotFound:
                existing = None
                existing_meta = None
            if existing is not None:
                try:
                    if row["mode"] == "cloudProcessable":
                        if self.asset_store.cloud_key is None:
                            raise PermissionError("cloudProcessable mode is disabled")
                        recovered = cloud_decrypt(json.loads(existing),
                                                  master_key=self.asset_store.cloud_key,
                                                  aad=_attachment_aad(row))
                    else:
                        recovered = existing
                except (ValueError, TypeError, json.JSONDecodeError) as exc:
                    raise ValueError("ATTACHMENT_CORRUPT") from exc
                if hashlib.sha256(recovered).hexdigest() != row["sha256"]:
                    raise ValueError("ATTACHMENT_CORRUPT")
                self.asset_store._exec(
                    conn,
                    "UPDATE xagt_asset_attachments SET stored_sha256=?,uploaded_at=? "
                    "WHERE tenant_id=? AND workspace_id=? AND member_id=? AND attachment_id=? "
                    "AND asset_id=? AND revision_id=? AND state='staged'",
                    (existing_meta.sha256, _now(), actor.tenant_id, actor.workspace_id,
                     actor.member_id, attachment_id, asset_id, revision_id))
                refreshed = self.asset_store._query(
                    conn,
                    "SELECT * FROM xagt_asset_attachments WHERE tenant_id=? AND workspace_id=? "
                    "AND member_id=? AND asset_id=? AND revision_id=? AND attachment_id=?",
                    (actor.tenant_id, actor.workspace_id, actor.member_id, asset_id,
                     revision_id, attachment_id))[0]
                return self._metadata(refreshed, replayed=True)
            if row["mode"] == "userHeld":
                try:
                    payload = json.loads(data)
                    if not isinstance(payload, dict) or set(payload) != {"object", "envelope"}:
                        raise ValueError
                    EncryptedObject.from_mapping(payload["object"])
                    envelope = validate_user_held_envelope(payload["envelope"])
                    if json.loads(row["envelope_json"]) != envelope:
                        raise ValueError
                except (TypeError, ValueError, json.JSONDecodeError) as exc:
                    raise ValueError("invalid userHeld encrypted attachment") from exc
                stored = data
            else:
                if self.asset_store.cloud_key is None:
                    raise PermissionError("cloudProcessable mode is disabled")
                encrypted = cloud_encrypt(data, master_key=self.asset_store.cloud_key,
                                          aad=_attachment_aad(row))
                stored = _json(encrypted).encode("utf-8")
            metadata = self.object_store.put(row["object_key"], stored,
                                             content_type="application/octet-stream")
            self.asset_store._exec(
                conn,
                "UPDATE xagt_asset_attachments SET stored_sha256=?,uploaded_at=? "
                "WHERE tenant_id=? AND workspace_id=? AND member_id=? AND attachment_id=? "
                "AND asset_id=? AND revision_id=? AND state='staged'",
                (metadata.sha256, _now(), actor.tenant_id, actor.workspace_id,
                 actor.member_id, attachment_id, asset_id, revision_id))
            refreshed = self.asset_store._query(
                conn,
                "SELECT * FROM xagt_asset_attachments WHERE tenant_id=? AND workspace_id=? "
                "AND member_id=? AND asset_id=? AND revision_id=? AND attachment_id=?",
                (actor.tenant_id, actor.workspace_id, actor.member_id, asset_id, revision_id, attachment_id))[0]
            return self._metadata(refreshed)

    def commit(self, actor: Any, asset_id: str, revision_id: str,
               attachment_id: str) -> dict[str, Any]:
        if not actor.can_ingest:
            raise PermissionError("assets:ingest is required")
        with self.asset_store.connection() as conn:
            self._lock_write(conn, actor, asset_id)
            row = self._attachment(conn, actor, asset_id, revision_id, attachment_id)
            if row["state"] == "committed":
                return self._metadata(row, replayed=True)
            if not row.get("uploaded_at") or not row.get("stored_sha256"):
                raise ValueError("ATTACHMENT_NOT_UPLOADED")
            try:
                self.object_store.head(row["object_key"])
            except ObjectNotFound as exc:
                raise ValueError("ATTACHMENT_NOT_UPLOADED") from exc
            self.asset_store._exec(
                conn,
                "UPDATE xagt_asset_attachments SET state='committed',committed_at=? "
                "WHERE tenant_id=? AND workspace_id=? AND member_id=? AND attachment_id=? "
                "AND asset_id=? AND revision_id=? AND state='staged'",
                (_now(), actor.tenant_id, actor.workspace_id, actor.member_id, attachment_id,
                 asset_id, revision_id))
            row = self.asset_store._query(
                conn,
                "SELECT * FROM xagt_asset_attachments WHERE tenant_id=? AND workspace_id=? "
                "AND member_id=? AND asset_id=? AND revision_id=? AND attachment_id=?",
                (actor.tenant_id, actor.workspace_id, actor.member_id, asset_id, revision_id, attachment_id))[0]
            return self._metadata(row)

    def list(self, actor: Any, asset_id: str, revision_id: str) -> list[dict[str, Any]]:
        if not actor.can_read:
            raise PermissionError("assets:read is required")
        with self.asset_store.connection() as conn:
            self._revision(conn, actor, asset_id, revision_id)
            rows = self.asset_store._query(
                conn,
                "SELECT * FROM xagt_asset_attachments WHERE tenant_id=? AND workspace_id=? "
                "AND member_id=? AND asset_id=? AND revision_id=? AND state='committed' "
                "ORDER BY created_at,attachment_id",
                (actor.tenant_id, actor.workspace_id, actor.member_id, asset_id, revision_id))
            return [self._metadata(row) for row in rows]

    def read(self, actor: Any, asset_id: str, revision_id: str,
             attachment_id: str) -> tuple[bytes, dict[str, Any]]:
        with self.asset_store.connection() as conn:
            row = self._attachment(conn, actor, asset_id, revision_id, attachment_id, read=True)
            if row["state"] != "committed":
                raise FileNotFoundError("attachment not found")
            stored, _ = self.object_store.get(row["object_key"])
        if row["mode"] == "cloudProcessable":
            if self.asset_store.cloud_key is None:
                raise PermissionError("cloudProcessable mode is disabled")
            content = cloud_decrypt(json.loads(stored), master_key=self.asset_store.cloud_key,
                                    aad=_attachment_aad(row))
        else:
            content = stored
        if hashlib.sha256(content).hexdigest() != row["sha256"]:
            raise ValueError("ATTACHMENT_CORRUPT")
        return content, self._metadata(row)

    def delete(self, actor: Any, asset_id: str, revision_id: str,
               attachment_id: str) -> dict[str, Any]:
        with self.asset_store.connection() as conn:
            self._lock_write(conn, actor, asset_id)
            row = self._attachment(conn, actor, asset_id, revision_id, attachment_id, manage=True)
            self.object_store.delete(row["object_key"])
            self.asset_store._exec(
                conn,
                "UPDATE xagt_asset_attachments SET state='deleted',deleted_at=? "
                "WHERE tenant_id=? AND workspace_id=? AND member_id=? AND asset_id=? "
                "AND revision_id=? AND attachment_id=?",
                (_now(), actor.tenant_id, actor.workspace_id, actor.member_id, asset_id,
                 revision_id, attachment_id))
        return {"attachmentId": attachment_id, "state": "deleted"}

    def delete_conversation(self, actor: Any, asset_id: str) -> int:
        """Release all object-store bytes for a tombstoned conversation."""
        if not actor.can_manage:
            raise PermissionError("assets:manage is required")
        self._id(asset_id, "asset ID")
        removed = 0
        with self.asset_store.connection() as conn:
            self.asset_store._lock_asset(conn, actor, asset_id)
            rows = self.asset_store._query(
                conn,
                "SELECT * FROM xagt_asset_attachments WHERE tenant_id=? AND workspace_id=? "
                "AND member_id=? AND asset_id=? AND state<>'deleted'",
                (actor.tenant_id, actor.workspace_id, actor.member_id, asset_id))
            for row in rows:
                self.object_store.delete(row["object_key"])
                self.asset_store._exec(
                    conn,
                    "UPDATE xagt_asset_attachments SET state='deleted',deleted_at=? "
                    "WHERE tenant_id=? AND workspace_id=? AND member_id=? AND asset_id=? "
                    "AND revision_id=? AND attachment_id=?",
                    (_now(), row["tenant_id"], row["workspace_id"], row["member_id"],
                     row["asset_id"], row["revision_id"], row["attachment_id"]))
                removed += 1
        return removed

    def cleanup_staged(self, *, older_than: timedelta = timedelta(hours=24)) -> int:
        cutoff = (datetime.now(timezone.utc) - older_than).isoformat()
        eligibility = (
            "SELECT a.* FROM xagt_asset_attachments a JOIN xagt_asset_conversations c "
            "ON c.tenant_id=a.tenant_id AND c.workspace_id=a.workspace_id "
            "AND c.member_id=a.member_id AND c.asset_id=a.asset_id "
            "WHERE a.state<>'deleted' AND (c.deleted_at IS NOT NULL OR (a.state='staged' AND a.created_at<?))"
        )
        removed = 0
        with self.asset_store.connection() as conn:
            rows = self.asset_store._query(conn, eligibility + " ORDER BY a.created_at LIMIT 1000", (cutoff,))
        for row in rows:
            actor = Actor(row["tenant_id"], row["workspace_id"], row["member_id"], row["subject_id"])
            with self.asset_store.connection() as conn:
                self.asset_store._lock_asset(conn, actor, row["asset_id"])
                current = self.asset_store._query(conn, eligibility + " AND a.object_key=?", (cutoff, row["object_key"]))
                if current:
                    self.object_store.delete(row["object_key"])
                    self.asset_store._exec(conn,
                        "UPDATE xagt_asset_attachments SET state='deleted',deleted_at=? WHERE object_key=?",
                        (_now(), row["object_key"]))
                    removed += 1
        return removed
