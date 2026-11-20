"""Read-only conversation collector and resumable asset upload client.

The collector intentionally has no source-side write path.  It reads a user
selected file or directory, writes progress only below the caller supplied
journal directory, and sends a versioned JSON payload to the asset service.
The journal stores the exact operation key and payload digest so a lost HTTP
response can be reconciled without creating another revision.
"""

from __future__ import annotations

import argparse
import base64
import binascii
import hashlib
import json
import os
import sys
import tempfile
import urllib.error
import urllib.request
import uuid
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Iterable, Mapping, Sequence


SCHEMA_VERSION = "xagt-conversation-assets/1"
DEFAULT_MAX_BYTES = 32 * 1024 * 1024
DEFAULT_MAX_FILES = 256
DEFAULT_MAX_RECORDS = 100_000
MAX_RESPONSE_BYTES = 4 * 1024 * 1024
_JSON_SUFFIXES = frozenset({".jsonl", ".ndjson", ".json"})


class CollectorError(ValueError):
    """A source or upload input is invalid."""


class UploadError(RuntimeError):
    """The service rejected an upload or reconciliation request."""


class UploadUncertain(UploadError):
    """The server may have committed the operation and must be queried."""


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, msg, headers, new):
        return None


def _validate_base_url(value: str) -> str:
    from urllib.parse import urlsplit
    parsed = urlsplit(value)
    if parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise CollectorError("asset service URL must not contain credentials, query, or fragment")
    if parsed.scheme == "https" and parsed.hostname:
        return value.rstrip("/")
    if parsed.scheme == "http" and parsed.hostname in {"localhost", "127.0.0.1", "::1"}:
        return value.rstrip("/")
    raise CollectorError("asset service URL must use HTTPS, or HTTP on localhost")


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _json_bytes(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")


def _safe_id(prefix: str, value: str) -> str:
    return f"{prefix}-{_sha256(value.encode('utf-8'))[:40]}"


def _as_text(value: Any) -> str | None:
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        parts: list[str] = []
        for part in value:
            if isinstance(part, str):
                parts.append(part)
            elif isinstance(part, Mapping) and isinstance(part.get("text"), str):
                parts.append(part["text"])
        return "\n".join(parts) if parts else None
    if isinstance(value, Mapping) and isinstance(value.get("text"), str):
        return value["text"]
    return None


def _normalize_record(value: Any, *, line: int, file_name: str, index: int) -> dict[str, Any]:
    """Map common vendor JSONL shapes to the stable message projection."""
    if not isinstance(value, Mapping):
        return {
            "recordIndex": index,
            "sourceLine": line,
            "sourceFile": file_name,
            "kind": "unknown",
            "raw": value,
        }
    role: str | None = None
    kind = value.get("type") or value.get("kind") or "record"
    vendor_payload = value.get("payload")
    message = value.get("message")
    if kind == "response_item" and isinstance(vendor_payload, Mapping) and vendor_payload.get("type") == "message":
        message = vendor_payload
    if isinstance(message, Mapping):
        role = message.get("role") if isinstance(message.get("role"), str) else None
        text = _as_text(message.get("content"))
    else:
        text = _as_text(value.get("content"))
    if text is None:
        text = _as_text(value.get("text"))
    if role is None and isinstance(value.get("role"), str):
        role = value["role"]
    record_id = next((value.get(key) for key in ("id", "uuid", "message_id", "messageId")
                      if isinstance(value.get(key), str) and value.get(key)), None)
    item: dict[str, Any] = {
        "recordIndex": index,
        "sourceLine": line,
        "sourceFile": file_name,
        "kind": str(value.get("type") or value.get("kind") or "record"),
        "raw": value,
    }
    # Pi and Codex publish the stable session ID in different metadata records.
    if kind == "session" and isinstance(value.get("id"), str):
        item["sessionId"] = value["id"]
    if kind == "session_meta" and isinstance(vendor_payload, Mapping) and isinstance(vendor_payload.get("id"), str):
        item["sessionId"] = vendor_payload["id"]
    if record_id is not None:
        item["messageId"] = record_id
    if role is not None:
        item["role"] = role
    if text is not None:
        item["text"] = text
    timestamp = value.get("timestamp", value.get("createdAt"))
    if isinstance(timestamp, (str, int, float)):
        item["timestamp"] = timestamp
    parent_id = value.get("parentId", value.get("parent_id"))
    if isinstance(parent_id, str) or "parentId" in value or "parent_id" in value:
        item["parentId"] = parent_id
    return item


@dataclass(frozen=True)
class SourceFile:
    path: str
    bytes: int
    sha256: str
    rawBase64: str
    records: tuple[dict[str, Any], ...]


@dataclass(frozen=True)
class CollectedRevision:
    assetId: str
    revisionId: str
    payload: dict[str, Any]
    sourceFiles: tuple[SourceFile, ...]


def make_user_held_payload(
    revision: CollectedRevision,
    *,
    recipient_public_key: bytes,
    signer_private_key: bytes,
    recipient_device_id: str,
    signer_device_id: str,
    grant_id: str | None = None,
) -> dict[str, Any]:
    """Encrypt a collected revision and seal its content key for a device.

    The private key is supplied by the caller and is never placed in the
    returned payload or journal. The caller can load it from a system key
    store or an explicitly selected file outside the source tree.
    """
    try:
        from .crypto import encrypt_object, seal_content_key, validate_user_held_envelope
        object_kind = "conversation"
        binding = {"assetId": revision.assetId, "revisionId": revision.revisionId,
                   "objectKind": object_kind}
        encrypted, content_key = encrypt_object(
            _json_bytes(revision.payload), asset_id=revision.assetId,
            revision_id=revision.revisionId, object_kind=object_kind,
            mode="userHeld")
        envelope = seal_content_key(
            content_key, recipient_public_key=recipient_public_key,
            binding=binding, grant_id=grant_id or str(uuid.uuid4()),
            revision=revision.revisionId, recipient_device_id=recipient_device_id,
            signer_device_id=signer_device_id, signer_private_key=signer_private_key)
        validate_user_held_envelope(envelope)
        return {"object": encrypted, "envelope": envelope}
    except (ImportError, ValueError, TypeError) as exc:
        raise CollectorError("unable to prepare userHeld payload") from exc


def _iter_source_files(source: Path, root: Path, *, max_files: int) -> list[Path]:
    if source.is_symlink():
        raise CollectorError("symlink sources are not accepted")
    resolved_source = source.resolve(strict=True)
    resolved_root = root.resolve(strict=True)
    try:
        resolved_source.relative_to(resolved_root)
    except ValueError as exc:
        raise CollectorError("source must be inside the selected source root") from exc
    if resolved_source.is_file() and resolved_source.suffix.lower() not in _JSON_SUFFIXES:
        raise CollectorError("source file must be JSON, JSONL, or NDJSON")
    candidates = [resolved_source] if resolved_source.is_file() else sorted(
        path for path in resolved_source.rglob("*") if path.is_file() and path.suffix.lower() in _JSON_SUFFIXES
    )
    if not candidates:
        raise CollectorError("source contains no supported JSONL/JSON files")
    if len(candidates) > max_files:
        raise CollectorError(f"source contains more than {max_files} supported files")
    for candidate in candidates:
        if candidate.is_symlink():
            raise CollectorError("symlink source files are not accepted")
        try:
            candidate.relative_to(resolved_root)
        except ValueError as exc:
            raise CollectorError("source contains a path outside the selected source root") from exc
    return candidates


def collect_source(
    source: str | Path,
    *,
    source_root: str | Path | None = None,
    max_bytes: int = DEFAULT_MAX_BYTES,
    max_total_bytes: int = 128 * 1024 * 1024,
    max_files: int = DEFAULT_MAX_FILES,
    max_records: int = DEFAULT_MAX_RECORDS,
    installation_id: str | None = None,
    store_id: str | None = None,
    session_id: str | None = None,
) -> CollectedRevision:
    """Read a selected source and build an immutable upload payload.

    ``source_root`` is required for a directory and defaults to the selected
    file's parent. Paths are resolved only for containment checks. No source
    file is opened in write mode and no sibling files are touched.
    """
    source_path = Path(source)
    if not source_path.exists():
        raise CollectorError("source does not exist")
    root_path = Path(source_root) if source_root is not None else (
        source_path if source_path.is_dir() else source_path.parent
    )
    root_resolved = root_path.resolve(strict=True)
    files = _iter_source_files(source_path, root_resolved, max_files=max_files)
    source_files: list[SourceFile] = []
    records_total = 0
    total_bytes = 0
    damage: list[dict[str, Any]] = []
    for file_path in files:
        relative = file_path.relative_to(root_resolved).as_posix()
        size = file_path.stat().st_size
        if size > max_bytes:
            raise CollectorError(f"source file exceeds {max_bytes} bytes: {relative}")
        total_bytes += size
        if total_bytes > max_total_bytes:
            raise CollectorError(f"source exceeds {max_total_bytes} bytes")
        raw = file_path.read_bytes()
        file_records: list[dict[str, Any]] = []
        if file_path.suffix.lower() == ".json":
            try:
                parsed = json.loads(raw.decode("utf-8"))
                values = parsed if isinstance(parsed, list) else [parsed]
                for index, value in enumerate(values):
                    if records_total + len(file_records) >= max_records:
                        raise CollectorError(f"source contains more than {max_records} records")
                    file_records.append(_normalize_record(value, line=index + 1,
                                                           file_name=relative,
                                                           index=records_total + len(file_records)))
            except (UnicodeDecodeError, json.JSONDecodeError) as exc:
                damage.append({"file": relative, "line": 1, "reason": str(exc)})
        else:
            for line_number, raw_line in enumerate(raw.splitlines(), start=1):
                if not raw_line.strip():
                    continue
                try:
                    value = json.loads(raw_line.decode("utf-8"))
                except (UnicodeDecodeError, json.JSONDecodeError) as exc:
                    damage.append({"file": relative, "line": line_number, "reason": str(exc)})
                    continue
                file_records.append(_normalize_record(value, line=line_number,
                                                       file_name=relative,
                                                       index=records_total + len(file_records)))
                if records_total + len(file_records) > max_records:
                    raise CollectorError(f"source contains more than {max_records} records")
        records_total += len(file_records)
        source_files.append(SourceFile(path=relative, bytes=len(raw), sha256=_sha256(raw),
                                       rawBase64=base64.b64encode(raw).decode("ascii"),
                                       records=tuple(file_records)))
    file_payloads = [asdict(item) for item in source_files]
    session_meta = next((record for item in source_files for record in item.records
                         if record.get("kind") in {"session", "session_meta"} and record.get("sessionId")), {})
    discovered_session = session_meta.get("sessionId") if len(source_files) == 1 else None
    effective_session = session_id or discovered_session or (source_files[0].path if source_files else "source")
    effective_installation = installation_id or _safe_id("install", str(root_resolved))
    effective_store = store_id or "local-filesystem"
    adapter_name = {"session": "pi-session", "session_meta": "codex-rollout"}.get(session_meta.get("kind"))
    if len(source_files) != 1:
        adapter_name = None
    source_identity = {"installationId": effective_installation, "storeId": effective_store,
                       "sessionId": effective_session}
    source_key = _sha256(_json_bytes(source_identity))
    digest = _sha256(_json_bytes(file_payloads))
    asset_id = _safe_id("asset", source_key)
    revision_id = _safe_id("rev", digest)
    coverage = {
        "status": "partial" if damage else "complete",
        "records": records_total,
        "files": len(source_files),
        "damage": damage,
        "capturedThrough": next((record.get("timestamp") for item in reversed(source_files) for record in reversed(item.records)
                                  if record.get("timestamp") is not None), None),
        "sourceRootRelative": ".",
    }
    payload = {
        "schemaVersion": SCHEMA_VERSION,
        "assetId": asset_id,
        "revisionId": revision_id,
        "source": {
            "kind": f"{adapter_name}-jsonl" if adapter_name else "local-json",
            "sourceKey": source_key,
            "installationId": effective_installation,
            "storeId": effective_store,
            "sessionId": effective_session,
            "rootName": root_resolved.name,
            "adapterId": f"xagt-{adapter_name}/1" if adapter_name else "xagt-local-json/1",
            "readOnly": True,
        },
        "coverage": coverage,
        "capturedAt": next((record.get("timestamp") for item in source_files for record in item.records
                             if record.get("timestamp") is not None), None),
        "files": file_payloads,
        "recordCount": records_total,
        "digest": digest,
    }
    return CollectedRevision(assetId=asset_id, revisionId=revision_id,
                             payload=payload, sourceFiles=tuple(source_files))


class Journal:
    """Atomic JSON journal stored outside the source tree."""

    def __init__(self, directory: str | Path):
        self.directory = Path(directory).resolve()
        self.directory.mkdir(parents=True, exist_ok=True)

    def _path(self, operation_id: str) -> Path:
        if not operation_id or any(char not in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_" for char in operation_id):
            raise CollectorError("invalid operation id")
        return self.directory / f"{operation_id}.json"

    def load(self, operation_id: str) -> dict[str, Any] | None:
        path = self._path(operation_id)
        if not path.exists():
            return None
        value = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(value, dict):
            raise CollectorError("journal entry is not an object")
        return value

    def save(self, operation_id: str, value: Mapping[str, Any]) -> None:
        destination = self._path(operation_id)
        fd, temporary = tempfile.mkstemp(prefix=f".{operation_id}.", suffix=".tmp", dir=self.directory)
        try:
            with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as handle:
                json.dump(dict(value), handle, ensure_ascii=False, sort_keys=True, indent=2)
                handle.write("\n")
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary, destination)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)


class AssetUploader:
    """HTTP client with operation journaling and loss-safe reconciliation."""

    def __init__(self, base_url: str, *, bearer: str | None = None,
                 opener: Callable[..., Any] | None = None, timeout: float = 30.0):
        self.base_url = _validate_base_url(base_url)
        self.bearer = bearer
        self.opener = opener or urllib.request.build_opener(_NoRedirect())
        self.timeout = timeout

    def request(self, method: str, path: str, *, body: Mapping[str, Any] | None = None,
                operation_id: str | None = None) -> dict[str, Any]:
        headers = {"Accept": "application/json"}
        if self.bearer:
            headers["Authorization"] = f"Bearer {self.bearer}"
        if operation_id:
            headers["Idempotency-Key"] = operation_id
        data = None
        if body is not None:
            data = _json_bytes(body)
            headers["Content-Type"] = "application/json"
        request = urllib.request.Request(f"{self.base_url}/{path.lstrip('/')}", data=data,
                                         method=method, headers=headers)
        try:
            if hasattr(self.opener, "open"):
                response = self.opener.open(request, timeout=self.timeout)
            else:
                response = self.opener(request, timeout=self.timeout)
            try:
                raw_response = response.read(MAX_RESPONSE_BYTES + 1)
            except TypeError:
                raw_response = response.read()
            if len(raw_response) > MAX_RESPONSE_BYTES:
                raise UploadError("asset service response exceeds limit")
            status = getattr(response, "status", 200)
        except urllib.error.HTTPError as exc:
            try:
                raw_response = exc.read(MAX_RESPONSE_BYTES + 1)
            except TypeError:
                raw_response = exc.read()
            if len(raw_response) > MAX_RESPONSE_BYTES:
                raise UploadError("asset service response exceeds limit") from exc
            status = exc.code
        except (OSError, TimeoutError) as exc:
            raise UploadUncertain("network result is unknown") from exc
        try:
            parsed = json.loads(raw_response.decode("utf-8")) if raw_response else {}
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise UploadError("asset service returned invalid JSON") from exc
        if not isinstance(parsed, dict):
            raise UploadError("asset service returned a non-object")
        if status >= 500:
            raise UploadUncertain(f"asset service returned {status}")
        if status >= 400:
            detail = parsed.get("detail")
            code = parsed.get("code") or (detail.get("code") if isinstance(detail, dict) else None) or f"HTTP_{status}"
            raise UploadError(str(code))
        return parsed

    def upload(self, revision: CollectedRevision, *, mode: str, journal: Journal,
               operation_id: str | None = None, expected_revision: str | None = None,
               user_held_payload: Mapping[str, Any] | None = None,
               user_held_envelope: Mapping[str, Any] | None = None) -> dict[str, Any]:
        if mode not in {"cloudProcessable", "userHeld"}:
            raise CollectorError("mode must be cloudProcessable or userHeld")
        if mode == "userHeld":
            if user_held_payload is None and user_held_envelope is not None:
                # Keep the old keyword as a migration aid, but never send the
                # old bare envelope shape to the service.
                user_held_payload = user_held_envelope
            if user_held_payload is None:
                raise CollectorError("userHeld upload requires an encrypted object and key envelope")
            try:
                from .crypto import EncryptedObject, validate_user_held_envelope
                if set(user_held_payload) != {"object", "envelope"}:
                    raise CollectorError("userHeld payload must contain object and envelope")
                encrypted_object = EncryptedObject.from_mapping(user_held_payload["object"])
                envelope = validate_user_held_envelope(user_held_payload["envelope"])
                user_held_payload = {"object": encrypted_object.as_dict(), "envelope": envelope}
            except (ImportError, ValueError, TypeError, KeyError) as exc:
                if isinstance(exc, CollectorError):
                    raise
                raise CollectorError("userHeld payload is invalid") from exc
        op_id = operation_id or str(uuid.uuid4())
        payload_value: Any = revision.payload if mode == "cloudProcessable" else user_held_payload
        payload = {"mode": mode, "expectedRevision": expected_revision, "payload": payload_value}
        digest = _sha256(_json_bytes(payload))
        prior = journal.load(op_id)
        if prior is not None and prior.get("destination") != self.base_url:
            raise CollectorError("operation is bound to another asset service")
        if prior is not None and prior.get("payloadDigest") != digest:
            raise CollectorError("operation id is already bound to another payload")
        path = f"conversations/{revision.assetId}/revisions/{revision.revisionId}"
        journal.save(op_id, {"operationId": op_id, "payloadDigest": digest,
                             "assetId": revision.assetId, "revisionId": revision.revisionId,
                             "path": path, "requestBody": payload, "destination": self.base_url,
                             "state": "pending", "createdAt": prior.get("createdAt", _utc_now()) if prior else _utc_now()})
        try:
            result = self.request("PUT", path, body=payload, operation_id=op_id)
        except UploadUncertain:
            current = journal.load(op_id) or {}
            journal.save(op_id, {**current, "state": "reconciling"})
            raise
        current = journal.load(op_id) or {}
        current.pop("requestBody", None)
        journal.save(op_id, {**current, "state": "committed", "result": result})
        return result

    def reconcile(self, operation_id: str, *, journal: Journal) -> dict[str, Any]:
        entry = journal.load(operation_id)
        if entry is not None and entry.get("destination") != self.base_url:
            raise CollectorError("operation is bound to another asset service")
        result = self.request("GET", f"operations/{operation_id}", operation_id=operation_id)
        state = str(result.get("state") or "unknown").lower()
        if state in {"sealed", "committed"}:
            state = "committed"
            if entry:
                entry.pop("requestBody", None)
        journal.save(operation_id, {**(entry or {"operationId": operation_id, "destination": self.base_url}), "state": state, "result": result,
                                    "reconciledAt": _utc_now()})
        return result

    def retry(self, operation_id: str, *, journal: Journal) -> dict[str, Any]:
        entry = journal.load(operation_id)
        if entry is None or entry.get("destination") != self.base_url:
            raise CollectorError("operation is missing from this asset service's journal")
        if entry.get("state") == "committed" and isinstance(entry.get("result"), dict):
            return entry["result"]
        if not isinstance(entry.get("requestBody"), dict):
            raise CollectorError("operation body is missing from the local journal")
        try:
            result = self.request("PUT", str(entry["path"]), body=entry["requestBody"],
                                  operation_id=operation_id)
        except UploadUncertain:
            journal.save(operation_id, {**entry, "state": "reconciling"})
            raise
        entry.pop("requestBody", None)
        journal.save(operation_id, {**entry, "state": "committed", "result": result,
                                    "retriedAt": _utc_now()})
        return result


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Read-only xagt.link conversation collector")
    sub = parser.add_subparsers(dest="command", required=True)
    scan = sub.add_parser("scan", help="read a selected source and emit a payload")
    scan.add_argument("source")
    scan.add_argument("--source-root")
    scan.add_argument("--output", required=True)
    scan.add_argument("--max-bytes", type=int, default=DEFAULT_MAX_BYTES)
    scan.add_argument("--max-total-bytes", type=int, default=128 * 1024 * 1024)
    scan.add_argument("--max-files", type=int, default=DEFAULT_MAX_FILES)
    scan.add_argument("--installation-id")
    scan.add_argument("--store-id")
    scan.add_argument("--session-id")
    upload = sub.add_parser("upload", help="scan and upload with a durable journal")
    upload.add_argument("source")
    upload.add_argument("--source-root")
    upload.add_argument("--base-url", required=True)
    upload.add_argument("--journal", required=True)
    upload.add_argument("--mode", choices=("cloudProcessable", "userHeld"), required=True)
    upload.add_argument("--max-bytes", type=int, default=DEFAULT_MAX_BYTES)
    upload.add_argument("--max-total-bytes", type=int, default=128 * 1024 * 1024)
    upload.add_argument("--max-files", type=int, default=DEFAULT_MAX_FILES)
    upload.add_argument("--installation-id")
    upload.add_argument("--store-id")
    upload.add_argument("--session-id")
    upload.add_argument("--user-held-payload", "--envelope", dest="user_held_payload_file",
                        help="JSON file containing {object,envelope}; never a bare envelope")
    upload.add_argument("--recipient-public-key-file")
    upload.add_argument("--signer-private-key-file")
    upload.add_argument("--recipient-device-id", default=os.environ.get("XAGT_RECIPIENT_DEVICE_ID"))
    upload.add_argument("--signer-device-id", default=os.environ.get("XAGT_SIGNER_DEVICE_ID"))
    upload.add_argument("--grant-id")
    upload.add_argument("--operation-id")
    upload.add_argument("--expected-revision")
    upload.add_argument("--bearer", default=os.environ.get("XAGT_ASSET_BEARER"))
    reconcile = sub.add_parser("reconcile", help="query a possibly committed operation")
    reconcile.add_argument("operation_id")
    reconcile.add_argument("--base-url", required=True)
    reconcile.add_argument("--journal", required=True)
    reconcile.add_argument("--bearer", default=os.environ.get("XAGT_ASSET_BEARER"))
    retry = sub.add_parser("retry", help="retry a journaled upload with its exact request body")
    retry.add_argument("operation_id")
    retry.add_argument("--base-url", required=True)
    retry.add_argument("--journal", required=True)
    retry.add_argument("--bearer", default=os.environ.get("XAGT_ASSET_BEARER"))
    return parser


def _read_key_file(value: str, *, name: str) -> bytes:
    """Read a raw 32-byte key, accepting a URL-safe base64 text file too."""
    try:
        raw = Path(value).read_bytes()
    except OSError as exc:
        raise CollectorError(f"unable to read {name}") from exc
    if len(raw) == 32:
        return raw
    try:
        decoded = base64.urlsafe_b64decode(b"".join(raw.split()) + b"=" * (-len(b"".join(raw.split())) % 4))
    except (ValueError, binascii.Error) as exc:
        raise CollectorError(f"{name} must contain 32 raw bytes or base64") from exc
    if len(decoded) != 32:
        raise CollectorError(f"{name} must contain 32 raw bytes or base64")
    return decoded


def _write_atomic_text(destination: str | Path, content: str, *, source_root: str | Path) -> None:
    """Write a CLI result atomically, never inside the selected source tree."""
    target = Path(destination)
    if target.exists() and target.is_symlink():
        raise CollectorError("output path must not be a symlink")
    for parent in (target.parent, *target.parent.parents):
        if parent.exists() and parent.is_symlink():
            raise CollectorError("output parent must not be a symlink")
    try:
        target.resolve().relative_to(Path(source_root).resolve(strict=True))
    except ValueError:
        pass
    else:
        raise CollectorError("output path must be outside the selected source root")
    target.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=f".{target.name}.", suffix=".tmp", dir=target.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as handle:
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, target)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def main(argv: Sequence[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    try:
        if args.command == "scan":
            revision = collect_source(args.source, source_root=args.source_root,
                                      max_bytes=args.max_bytes, max_total_bytes=args.max_total_bytes,
                                      max_files=args.max_files, installation_id=args.installation_id,
                                      store_id=args.store_id, session_id=args.session_id)
            _write_atomic_text(args.output,
                               json.dumps(revision.payload, ensure_ascii=False, indent=2) + "\n",
                               source_root=args.source_root or (
                                   args.source if Path(args.source).is_dir() else Path(args.source).parent))
            print(json.dumps({"assetId": revision.assetId, "revisionId": revision.revisionId,
                              "recordCount": revision.payload["recordCount"],
                              "coverage": revision.payload["coverage"]["status"]}, ensure_ascii=False))
            return 0
        journal = Journal(args.journal)
        uploader = AssetUploader(args.base_url, bearer=args.bearer)
        if args.command == "upload":
            revision = collect_source(args.source, source_root=args.source_root,
                                      max_bytes=args.max_bytes, max_total_bytes=args.max_total_bytes,
                                      max_files=args.max_files, installation_id=args.installation_id,
                                      store_id=args.store_id, session_id=args.session_id)
            user_held_payload = None
            if args.mode == "userHeld":
                if args.user_held_payload_file:
                    try:
                        user_held_payload = json.loads(
                            Path(args.user_held_payload_file).read_text(encoding="utf-8"))
                    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
                        raise CollectorError("unable to read userHeld payload file") from exc
                    if not isinstance(user_held_payload, dict):
                        raise CollectorError("userHeld payload file must contain a JSON object")
                else:
                    public_path = args.recipient_public_key_file or os.environ.get(
                        "XAGT_RECIPIENT_PUBLIC_KEY_FILE")
                    private_path = args.signer_private_key_file or os.environ.get(
                        "XAGT_SIGNER_PRIVATE_KEY_FILE")
                    recipient_device_id = args.recipient_device_id
                    signer_device_id = args.signer_device_id
                    if not public_path or not private_path or not recipient_device_id or not signer_device_id:
                        raise CollectorError(
                            "userHeld requires --user-held-payload or explicit key files and device ids")
                    user_held_payload = make_user_held_payload(
                        revision,
                        recipient_public_key=_read_key_file(public_path, name="recipient public key"),
                        signer_private_key=_read_key_file(private_path, name="signer private key"),
                        recipient_device_id=recipient_device_id,
                        signer_device_id=signer_device_id,
                        grant_id=args.grant_id,
                    )
            result = uploader.upload(revision, mode=args.mode, journal=journal,
                                     operation_id=args.operation_id,
                                     expected_revision=args.expected_revision,
                                     user_held_payload=user_held_payload)
        elif args.command == "reconcile":
            result = uploader.reconcile(args.operation_id, journal=journal)
        else:
            result = uploader.retry(args.operation_id, journal=journal)
        print(json.dumps(result, ensure_ascii=False))
        return 0
    except (CollectorError, UploadError) as exc:
        print(str(exc), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
