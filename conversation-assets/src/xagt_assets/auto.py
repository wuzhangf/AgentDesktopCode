"""Opt-in, bounded automatic conversation archiving.

The automatic collector is deliberately a small supervisor around the normal
read-only collector and :class:`~xagt_assets.collector.AssetUploader`.  A
configuration names each source and its containing root explicitly; no home
directory discovery or agent-specific scraping is performed.  The supervisor
keeps only source identity, digests, coverage and operation state in its
durable state file.  The exact request body remains in the normal upload
journal until the operation is committed, so a restart can retry the same
idempotent request without re-reading a changed source.

It is disabled unless ``--enable`` is supplied.  A normal executable process
can therefore be run as::

    python -m xagt_assets.auto --enable --config auto.json \
        --base-url https://assets.example --journal .local/asset-journal \
        --state .local/asset-auto-state.json

Use ``--once`` for a bounded poll.  The long-running mode performs one poll
immediately, then waits for the configured interval (at most one day), and
stops cleanly on Ctrl-C or ``AutoArchive.stop()``.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
import tempfile
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from threading import Event
from typing import Any, Mapping, Sequence

from .collector import (
    AssetUploader,
    CollectorError,
    Journal,
    UploadError,
    UploadUncertain,
    _json_bytes,
    _read_key_file,
    collect_source,
    make_user_held_payload,
)


AUTO_SCHEMA_VERSION = "xagt-conversation-assets-auto/2"
DEFAULT_POLL_SECONDS = 300
MAX_POLL_SECONDS = 24 * 60 * 60
# Hosted validates the JSON payload at 8 MiB.  The normal collector repeats
# source bytes as base64 and normalized records, so automatic collection uses
# a conservative 2 MiB raw bound by default.  Explicit larger bounds still
# receive a deterministic client-side TOO_LARGE error before any request.
DEFAULT_AUTO_MAX_BYTES = 2 * 1024 * 1024
DEFAULT_AUTO_MAX_TOTAL_BYTES = 2 * 1024 * 1024
MAX_UPLOAD_PAYLOAD_BYTES = 8 * 1024 * 1024


class AutoArchiveError(ValueError):
    """Invalid automatic archive configuration or durable state."""


class AutoArchiveBusy(RuntimeError):
    """Another automatic archive process owns the state lock."""


_ENV_NAME_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")


def _validate_env_name(value: str, *, name: str) -> str:
    if not isinstance(value, str) or not _ENV_NAME_RE.fullmatch(value):
        raise AutoArchiveError(f"{name} must be a valid environment variable name")
    return value


def _now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _digest(value: Any) -> str:
    return hashlib.sha256(
        json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()


def _safe_operation_id(asset_id: str, revision_id: str) -> str:
    return "auto-" + _digest({"assetId": asset_id, "revisionId": revision_id})[:56]


def _resolve_config_path(value: str | Path, *, base: Path) -> Path:
    path = Path(value).expanduser()
    if not path.is_absolute():
        path = base / path
    return path.resolve(strict=False)


def _inside(path: Path, root: Path) -> bool:
    try:
        path.resolve(strict=False).relative_to(root.resolve(strict=False))
    except ValueError:
        return False
    return True


@dataclass(frozen=True)
class AutoSource:
    """One explicitly allowlisted source and its upload policy."""

    path: Path | None
    root: Path | None
    installation_id: str
    store_id: str
    session_id: str | None = None
    mode: str = "cloudProcessable"
    kind: str = "local"
    acs_base_url: str | None = None
    acs_bearer_env: str | None = None
    acs_client_session_token_env: str | None = None
    acs_scope: tuple[str, ...] = ("OBSERVE",)
    acs_page_size: int = 100
    acs_max_pages: int = 100
    acs_max_messages: int = 10_000
    recipient_public_key_file: Path | None = None
    signer_private_key_file: Path | None = None
    recipient_device_id: str | None = None
    signer_device_id: str | None = None
    grant_id: str | None = None
    max_bytes: int = DEFAULT_AUTO_MAX_BYTES
    max_total_bytes: int = DEFAULT_AUTO_MAX_TOTAL_BYTES
    max_files: int = 256
    max_records: int = 100_000

    def __post_init__(self) -> None:
        if self.mode not in {"cloudProcessable", "userHeld"}:
            raise AutoArchiveError("source mode must be cloudProcessable or userHeld")
        if self.kind not in {"local", "acs"}:
            raise AutoArchiveError("source kind must be local or acs")
        if not self.installation_id or not self.store_id:
            raise AutoArchiveError("each source requires installationId and storeId")
        if self.kind == "local":
            if self.path is None or self.root is None:
                raise AutoArchiveError("local sources require path and root")
            if not _inside(self.path, self.root):
                raise AutoArchiveError("source path must be inside its explicit source root")
            if not self.root.exists() or not self.root.is_dir():
                raise AutoArchiveError("source root must be an existing directory")
        else:
            if not self.acs_base_url or not self.session_id or not self.acs_client_session_token_env:
                raise AutoArchiveError(
                    "ACS sources require baseUrl, sessionId and clientSessionTokenEnv")
            _validate_env_name(self.acs_client_session_token_env, name="clientSessionTokenEnv")
            if self.acs_bearer_env:
                _validate_env_name(self.acs_bearer_env, name="bearerEnv")
            if "OBSERVE" not in {item.upper() for item in self.acs_scope}:
                raise AutoArchiveError("ACS sources require the explicit OBSERVE scope")
            if not 1 <= self.acs_page_size <= 100:
                raise AutoArchiveError("ACS pageSize must be between 1 and 100")
            if not 1 <= self.acs_max_pages <= 100:
                raise AutoArchiveError("ACS maxPages must be between 1 and 100")
            if not 1 <= self.acs_max_messages <= 10_000:
                raise AutoArchiveError("ACS maxMessages must be between 1 and 10000")
        for name, value in (("maxBytes", self.max_bytes), ("maxTotalBytes", self.max_total_bytes),
                            ("maxFiles", self.max_files), ("maxRecords", self.max_records)):
            if not isinstance(value, int) or value <= 0:
                raise AutoArchiveError(f"{name} must be positive")
        if self.mode == "userHeld":
            if not self.recipient_public_key_file or not self.signer_private_key_file:
                raise AutoArchiveError("userHeld sources require trusted key files")
            if not self.recipient_device_id or not self.signer_device_id:
                raise AutoArchiveError("userHeld sources require recipient and signer device ids")
            for key_path in (self.recipient_public_key_file, self.signer_private_key_file):
                if self.root is not None and _inside(key_path, self.root):
                    raise AutoArchiveError("trusted key files must be outside the source root")

    @classmethod
    def from_mapping(cls, value: Mapping[str, Any], *, base: Path) -> "AutoSource":
        if not isinstance(value, Mapping):
            raise AutoArchiveError("each source must be an object")
        kind = str(value.get("kind", value.get("sourceKind", "local"))).lower()
        source = value.get("path")
        root = value.get("root", value.get("sourceRoot"))
        if kind == "local" and (not isinstance(source, str) or not source
                                 or not isinstance(root, str) or not root):
            raise AutoArchiveError("local sources require path and root")
        if kind == "acs":
            if not isinstance(value.get("baseUrl"), str) or not value.get("baseUrl"):
                raise AutoArchiveError("ACS source requires an explicit baseUrl")
            if not isinstance(value.get("sessionId"), str) or not value.get("sessionId"):
                raise AutoArchiveError("ACS source requires an explicit sessionId")
            if not isinstance(value.get("clientSessionTokenEnv"), str) or not value.get("clientSessionTokenEnv"):
                raise AutoArchiveError(
                    "ACS source requires clientSessionTokenEnv; raw tokens are not accepted")
        def optional_path(name: str) -> Path | None:
            item = value.get(name)
            return _resolve_config_path(item, base=base) if isinstance(item, str) and item else None
        scope = value.get("scope", ["OBSERVE"])
        if isinstance(scope, str):
            scope_values = tuple(item.strip().upper() for item in scope.replace(",", " ").split() if item.strip())
        elif isinstance(scope, list):
            scope_values = tuple(str(item).strip().upper() for item in scope if str(item).strip())
        else:
            raise AutoArchiveError("ACS scope must be a string or array")
        return cls(
            path=_resolve_config_path(source, base=base) if isinstance(source, str) and source else None,
            root=_resolve_config_path(root, base=base) if isinstance(root, str) and root else None,
            installation_id=str(value.get("installationId") or ""),
            store_id=str(value.get("storeId") or ""),
            session_id=value.get("sessionId") if isinstance(value.get("sessionId"), str) else None,
            mode=str(value.get("mode") or "cloudProcessable"),
            kind=kind,
            acs_base_url=value.get("baseUrl") if isinstance(value.get("baseUrl"), str) else None,
            acs_bearer_env=value.get("bearerEnv") if isinstance(value.get("bearerEnv"), str) else None,
            acs_client_session_token_env=(
                value.get("clientSessionTokenEnv")
                if isinstance(value.get("clientSessionTokenEnv"), str) else None),
            acs_scope=scope_values,
            acs_page_size=int(value.get("pageSize", 100)),
            acs_max_pages=int(value.get("maxPages", 100)),
            acs_max_messages=int(value.get("maxMessages", 10_000)),
            recipient_public_key_file=optional_path("recipientPublicKeyFile"),
            signer_private_key_file=optional_path("signerPrivateKeyFile"),
            recipient_device_id=value.get("recipientDeviceId") if isinstance(value.get("recipientDeviceId"), str) else None,
            signer_device_id=value.get("signerDeviceId") if isinstance(value.get("signerDeviceId"), str) else None,
            grant_id=value.get("grantId") if isinstance(value.get("grantId"), str) else None,
            max_bytes=int(value.get("maxBytes", DEFAULT_AUTO_MAX_BYTES)),
            max_total_bytes=int(value.get("maxTotalBytes", DEFAULT_AUTO_MAX_TOTAL_BYTES)),
            max_files=int(value.get("maxFiles", 256)),
            max_records=int(value.get("maxRecords", 100_000)),
        )

    def identity(self) -> dict[str, Any]:
        return {
            "kind": self.kind, "path": str(self.path) if self.path else None,
            "root": str(self.root) if self.root else None,
            "installationId": self.installation_id, "storeId": self.store_id,
            "sessionId": self.session_id, "mode": self.mode,
            "baseUrl": self.acs_base_url if self.kind == "acs" else None,
            "bearerEnv": self.acs_bearer_env if self.kind == "acs" else None,
            "clientSessionTokenEnv": (self.acs_client_session_token_env
                                       if self.kind == "acs" else None),
            "scope": list(self.acs_scope) if self.kind == "acs" else None,
            "pageSize": self.acs_page_size if self.kind == "acs" else None,
            "maxPages": self.acs_max_pages if self.kind == "acs" else None,
            "maxMessages": self.acs_max_messages if self.kind == "acs" else None,
        }

    def key(self) -> str:
        return _digest(self.identity())[:48]


class _StateLock:
    """Crash-aware exclusive lock for one state file.

    ``O_EXCL`` prevents two supervisors from polling the same source.  A dead
    owner is removed on the next start; a live owner is never displaced.
    """

    def __init__(self, path: Path):
        self.path = path
        self.fd: int | None = None

    def __enter__(self) -> "_StateLock":
        self.path.parent.mkdir(parents=True, exist_ok=True)
        payload = json.dumps({"pid": os.getpid(), "startedAt": _now()}).encode("ascii")
        try:
            self.fd = os.open(str(self.path), os.O_CREAT | os.O_EXCL | os.O_WRONLY)
            os.write(self.fd, payload)
            return self
        except FileExistsError as exc:
            self._remove_dead_owner()
            if self.fd is not None:
                os.close(self.fd)
                self.fd = None
            try:
                self.fd = os.open(str(self.path), os.O_CREAT | os.O_EXCL | os.O_WRONLY)
                os.write(self.fd, payload)
                return self
            except FileExistsError:
                raise AutoArchiveBusy("another automatic archive process owns the state lock") from exc

    def _remove_dead_owner(self) -> None:
        try:
            owner = json.loads(self.path.read_text(encoding="ascii"))
            pid = int(owner.get("pid"))
            if pid == os.getpid():
                return
            os.kill(pid, 0)
        except ProcessLookupError:
            try:
                self.path.unlink()
            except FileNotFoundError:
                pass
        except (FileNotFoundError, PermissionError, OSError, ValueError, TypeError, json.JSONDecodeError):
            # A malformed lock is not evidence that its owner is dead.  Leave
            # it in place so concurrent processes fail safe and report busy.
            return

    def __exit__(self, *_: object) -> None:
        if self.fd is not None:
            os.close(self.fd)
            self.fd = None
        try:
            self.path.unlink()
        except FileNotFoundError:
            pass


class AutoArchive:
    """Bounded automatic polling over explicit sources."""

    def __init__(self, sources: Sequence[AutoSource], *, base_url: str,
                 journal_dir: str | Path, state_path: str | Path,
                 bearer: str | None = None, poll_seconds: int = DEFAULT_POLL_SECONDS,
                 upload_partial: bool = False, uploader: AssetUploader | None = None,
                 auth_subject: str | None = None, config_path: str | Path | None = None):
        if not sources:
            raise AutoArchiveError("at least one explicit source is required")
        if not 1 <= poll_seconds <= MAX_POLL_SECONDS:
            raise AutoArchiveError(f"pollSeconds must be between 1 and {MAX_POLL_SECONDS}")
        self.sources = tuple(sources)
        journal_path = Path(journal_dir).resolve()
        self.state_path = Path(state_path).resolve()
        self.lock_path = self.state_path.with_name(self.state_path.name + ".lock")
        for source in self.sources:
            if source.root is not None and (_inside(self.state_path, source.root)
                                            or _inside(journal_path, source.root)):
                raise AutoArchiveError("state and journal must be outside every source root")
            if config_path is not None and source.root is not None and _inside(Path(config_path), source.root):
                raise AutoArchiveError("automatic archive config must be outside every source root")
        # Constructing Journal creates its directory, so do it only after the
        # containment checks above have passed.
        self.journal = Journal(journal_path)
        self.uploader = uploader or AssetUploader(base_url, bearer=bearer)
        self.poll_seconds = poll_seconds
        self.upload_partial = upload_partial
        self._stop = Event()
        self.auth_subject = auth_subject or self._bearer_binding(bearer)
        self.binding = {
            "destination": self.uploader.base_url,
            "authSubject": self.auth_subject,
            "policyDigest": _digest({
                "sources": [source.identity() for source in self.sources],
                "limits": [{"maxBytes": source.max_bytes, "maxTotalBytes": source.max_total_bytes,
                             "maxFiles": source.max_files, "maxRecords": source.max_records}
                            for source in self.sources],
                "uploadPartial": self.upload_partial,
            }),
        }

    def _bearer_binding(self, bearer: str | None) -> str:
        # Never put a bearer in durable state.  A fingerprint still prevents
        # one login's durable head from silently being reused by another.
        effective = bearer if bearer is not None else getattr(self.uploader, "bearer", None)
        if not effective:
            return "anonymous"
        return "bearer-sha256:" + hashlib.sha256(effective.encode("utf-8")).hexdigest()

    @classmethod
    def from_config(cls, config: Mapping[str, Any], *, base: str | Path,
                    base_url: str, journal_dir: str | Path, state_path: str | Path,
                    bearer: str | None = None, poll_seconds: int | None = None,
                    upload_partial: bool | None = None,
                    uploader: AssetUploader | None = None,
                    auth_subject: str | None = None,
                    config_path: str | Path | None = None) -> "AutoArchive":
        if not isinstance(config, Mapping) or not isinstance(config.get("sources"), list):
            raise AutoArchiveError("config requires a sources array")
        base_path = Path(base).resolve()
        sources = [AutoSource.from_mapping(item, base=base_path) for item in config["sources"]]
        return cls(sources, base_url=base_url, journal_dir=journal_dir, state_path=state_path,
                   bearer=bearer, poll_seconds=int(poll_seconds if poll_seconds is not None
                                                   else config.get("pollSeconds", DEFAULT_POLL_SECONDS)),
                   upload_partial=bool(upload_partial if upload_partial is not None
                                       else config.get("uploadPartial", False)), uploader=uploader,
                   auth_subject=auth_subject or (config.get("authSubject") if isinstance(config.get("authSubject"), str) else None),
                   config_path=config_path)

    def stop(self) -> None:
        self._stop.set()

    def _load_state(self) -> dict[str, Any]:
        if not self.state_path.exists():
            return {"schemaVersion": AUTO_SCHEMA_VERSION, "binding": self.binding, "sources": {}}
        try:
            state = json.loads(self.state_path.read_text(encoding="utf-8"))
        except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise AutoArchiveError("automatic archive state is unreadable") from exc
        if (not isinstance(state, dict) or state.get("schemaVersion") != AUTO_SCHEMA_VERSION
                or state.get("binding") != self.binding or not isinstance(state.get("sources"), dict)):
            raise AutoArchiveError("automatic archive state has an unsupported schema")
        return state

    def _save_state(self, state: Mapping[str, Any]) -> None:
        self.state_path.parent.mkdir(parents=True, exist_ok=True)
        fd, temporary = tempfile.mkstemp(prefix=f".{self.state_path.name}.", suffix=".tmp",
                                         dir=self.state_path.parent)
        try:
            with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as handle:
                json.dump(dict(state), handle, ensure_ascii=False, sort_keys=True, indent=2)
                handle.write("\n")
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary, self.state_path)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)

    @staticmethod
    def _committed(result: Any) -> bool:
        return isinstance(result, Mapping) and str(result.get("state", "")).lower() in {"committed", "sealed"}

    def _record_committed(self, entry: dict[str, Any], revision_id: str, digest: str,
                          asset_id: str, coverage: Mapping[str, Any], result: Mapping[str, Any]) -> None:
        entry.update({"status": "committed", "assetId": asset_id, "lastRevisionId": revision_id,
                      "lastDigest": digest, "coverage": dict(coverage),
                      "pendingOperationId": None, "pendingRevisionId": None,
                      "pendingDigest": None, "lastResult": dict(result), "updatedAt": _now(),
                      "lastError": None})

    def _resume_operation(self, operation_id: str) -> dict[str, Any] | None:
        journal_entry = self.journal.load(operation_id)
        if not journal_entry:
            return None
        if journal_entry.get("destination") != self.uploader.base_url:
            raise AutoArchiveError("journal operation is bound to another asset service")
        if journal_entry.get("state") == "committed" and isinstance(journal_entry.get("result"), dict):
            return journal_entry["result"]
        try:
            if journal_entry.get("state") == "reconciling":
                result = self.uploader.reconcile(operation_id, journal=self.journal)
                if self._committed(result):
                    return result
            return self.uploader.retry(operation_id, journal=self.journal)
        except UploadUncertain:
            return None

    def _user_held_payload(self, source: AutoSource, revision: Any) -> dict[str, Any]:
        assert source.recipient_public_key_file and source.signer_private_key_file
        public_key = _read_key_file(str(source.recipient_public_key_file), name="recipient public key")
        private_key = _read_key_file(str(source.signer_private_key_file), name="signer private key")
        grant_id = source.grant_id or "auto-" + _digest({"assetId": revision.assetId,
                                                            "revisionId": revision.revisionId,
                                                            "recipient": source.recipient_device_id})[:40]
        return make_user_held_payload(
            revision, recipient_public_key=public_key, signer_private_key=private_key,
            recipient_device_id=source.recipient_device_id or "",
            signer_device_id=source.signer_device_id or "", grant_id=grant_id)

    def _poll_locked(self) -> dict[str, Any]:
        state = self._load_state()
        outcomes: list[dict[str, Any]] = []
        for source in self.sources:
            key = source.key()
            entry = state["sources"].setdefault(key, {"identity": source.identity(), "status": "new"})
            pending_id = entry.get("pendingOperationId")
            if isinstance(pending_id, str):
                # The state record is written before the uploader writes its
                # journal.  If the process died in that tiny window, there
                # is no request to retry; clear the marker and build the
                # request afresh.  Once a journal exists, however, every
                # restart must use that exact body.
                pending_journal = self.journal.load(pending_id)
                if pending_journal is None:
                    entry.update({"pendingOperationId": None, "pendingRevisionId": None,
                                  "pendingDigest": None, "pendingCoverage": None})
                    pending_id = None
            if isinstance(pending_id, str):
                try:
                    resumed = self._resume_operation(pending_id)
                except UploadError as exc:
                    entry.update({"status": "error", "lastError": str(exc), "updatedAt": _now()})
                    outcomes.append({"source": key, "status": "error", "error": str(exc)})
                    continue
                if resumed is None:
                    entry.update({"status": "pending", "updatedAt": _now()})
                    outcomes.append({"source": key, "status": "pending", "operationId": pending_id})
                    continue
                if self._committed(resumed):
                    revision_id = str(entry.get("pendingRevisionId") or "")
                    digest = str(entry.get("pendingDigest") or "")
                    coverage = entry.get("pendingCoverage") if isinstance(entry.get("pendingCoverage"), dict) else {}
                    self._record_committed(entry, revision_id, digest, str(entry.get("assetId") or ""), coverage, resumed)

            try:
                if source.kind == "acs":
                    # ACS is a separate, explicitly authorized read source.
                    # Its URL/session/scope are fixed in the allowlist and
                    # the bearer is resolved only from the named environment
                    # variables, never from configuration JSON.
                    from .acs_reader import AcsReader
                    client_session_token = os.environ.get(source.acs_client_session_token_env or "")
                    if not client_session_token:
                        raise CollectorError(
                            "ACS client-session token environment variable is not set: "
                            f"{source.acs_client_session_token_env}")
                    bearer = os.environ.get(source.acs_bearer_env or "") if source.acs_bearer_env else None
                    revision = AcsReader(
                        source.acs_base_url or "", source.session_id or "", scope=source.acs_scope,
                        bearer=bearer, client_session_token=client_session_token,
                        installation_id=source.installation_id,
                        store_id=source.store_id, page_size=source.acs_page_size,
                        max_pages=source.acs_max_pages, max_messages=source.acs_max_messages,
                    ).read()
                else:
                    revision = collect_source(
                        source.path, source_root=source.root, max_bytes=source.max_bytes,
                        max_total_bytes=source.max_total_bytes, max_files=source.max_files,
                        max_records=source.max_records, installation_id=source.installation_id,
                        store_id=source.store_id, session_id=source.session_id)
            except CollectorError as exc:
                message = str(exc)
                status = "missing" if "does not exist" in message else "error"
                entry.update({"status": status, "lastError": message, "updatedAt": _now()})
                outcomes.append({"source": key, "status": status, "error": message})
                continue
            coverage = revision.payload.get("coverage", {})
            if coverage.get("status") == "partial" and not self.upload_partial:
                entry.update({"status": "partial", "coverage": dict(coverage), "updatedAt": _now(),
                              "lastError": "source has damaged or incomplete records; uploadPartial is false"})
                outcomes.append({"source": key, "status": "partial", "revisionId": revision.revisionId})
                continue
            if entry.get("status") == "committed" and entry.get("lastRevisionId") == revision.revisionId:
                entry.update({"coverage": dict(coverage), "updatedAt": _now(), "lastError": None})
                outcomes.append({"source": key, "status": "unchanged", "revisionId": revision.revisionId})
                continue

            operation_id = _safe_operation_id(revision.assetId, revision.revisionId)
            try:
                resumed = self._resume_operation(operation_id)
                if resumed is not None:
                    self._record_committed(entry, revision.revisionId, revision.payload["digest"],
                                           revision.assetId, coverage, resumed)
                    outcomes.append({"source": key, "status": "committed", "revisionId": revision.revisionId,
                                     "operationId": operation_id, "resumed": True})
                    continue
            except UploadError as exc:
                entry.update({"status": "error", "lastError": str(exc), "updatedAt": _now()})
                outcomes.append({"source": key, "status": "error", "error": str(exc)})
                continue

            entry.update({"identity": source.identity(), "assetId": revision.assetId,
                          "pendingOperationId": operation_id, "pendingRevisionId": revision.revisionId,
                          "pendingDigest": revision.payload["digest"], "pendingCoverage": dict(coverage),
                          "status": "pending", "updatedAt": _now(), "lastError": None})
            self._save_state(state)
            try:
                encrypted = self._user_held_payload(source, revision) if source.mode == "userHeld" else None
                request_payload = {"mode": source.mode, "expectedRevision": entry.get("lastRevisionId"),
                                   "payload": encrypted if encrypted is not None else revision.payload}
                if len(_json_bytes(request_payload)) > MAX_UPLOAD_PAYLOAD_BYTES:
                    raise CollectorError("TOO_LARGE: automatic archive payload exceeds the 8 MiB request limit")
                result = self.uploader.upload(
                    revision, mode=source.mode, journal=self.journal, operation_id=operation_id,
                    expected_revision=entry.get("lastRevisionId"), user_held_payload=encrypted)
            except UploadUncertain:
                entry.update({"status": "pending", "updatedAt": _now()})
                outcomes.append({"source": key, "status": "pending", "operationId": operation_id})
                continue
            except (CollectorError, UploadError) as exc:
                entry.update({"status": "error", "lastError": str(exc), "updatedAt": _now()})
                outcomes.append({"source": key, "status": "error", "error": str(exc)})
                continue
            self._record_committed(entry, revision.revisionId, revision.payload["digest"],
                                   revision.assetId, coverage, result)
            outcomes.append({"source": key, "status": "committed", "revisionId": revision.revisionId,
                             "operationId": operation_id})
        state["updatedAt"] = _now()
        self._save_state(state)
        return {"schemaVersion": AUTO_SCHEMA_VERSION, "checkedAt": state["updatedAt"], "sources": outcomes}

    def run_once(self) -> dict[str, Any]:
        """Perform one bounded poll, returning per-source outcomes."""
        try:
            with _StateLock(self.lock_path):
                return self._poll_locked()
        except AutoArchiveBusy:
            return {"schemaVersion": AUTO_SCHEMA_VERSION, "status": "busy", "sources": []}

    def run_forever(self) -> None:
        """Poll until :meth:`stop` is called or the process receives Ctrl-C."""
        while not self._stop.is_set():
            self.run_once()
            self._stop.wait(self.poll_seconds)


def _load_config(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise AutoArchiveError("automatic archive config is unreadable") from exc
    if not isinstance(value, dict):
        raise AutoArchiveError("automatic archive config must be an object")
    return value


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Opt-in bounded xagt.link conversation archiver")
    parser.add_argument("--enable", action="store_true", help="explicitly enable automatic collection")
    parser.add_argument("--config", required=True, help="JSON allowlist of selected sources")
    parser.add_argument("--base-url", required=True)
    parser.add_argument("--journal", required=True)
    parser.add_argument("--state", required=True)
    parser.add_argument("--bearer", default=os.environ.get("XAGT_ASSET_BEARER"))
    parser.add_argument("--auth-subject", help="stable subject binding for this login")
    parser.add_argument("--once", action="store_true", help="poll once instead of staying resident")
    parser.add_argument("--poll-seconds", type=int)
    parser.add_argument("--upload-partial", action="store_true")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    if not args.enable:
        print(json.dumps({"status": "disabled", "reason": "automatic archiving is opt-in"}))
        return 0
    try:
        config_path = Path(args.config).resolve()
        archive = AutoArchive.from_config(
            _load_config(config_path), base=config_path.parent, base_url=args.base_url,
            journal_dir=args.journal, state_path=args.state, bearer=args.bearer,
            poll_seconds=args.poll_seconds, upload_partial=True if args.upload_partial else None,
            config_path=config_path, auth_subject=args.auth_subject)
        if args.once:
            print(json.dumps(archive.run_once(), ensure_ascii=False))
        else:
            archive.run_forever()
        return 0
    except (AutoArchiveError, CollectorError, UploadError) as exc:
        print(str(exc), file=sys.stderr)
        return 2
    except KeyboardInterrupt:
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
