"""Bounded, read-only reader for an authenticated ACS session.

The reader consumes the public ACS source contract (foundation, summary and
history pages).  It deliberately does not expose a write method and never
follows redirects.  The caller must opt in to the ``OBSERVE`` scope; a bearer
token is only sent when the caller explicitly supplies one.  The returned
``CollectedRevision`` can be passed unchanged to ``AssetUploader.upload`` for
either ``cloudProcessable`` or ``userHeld`` mode.
"""

from __future__ import annotations

import base64
import hashlib
import json
import re
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import asdict
from typing import Any, Callable, Iterable, Mapping

from .collector import (
    MAX_RESPONSE_BYTES,
    CollectedRevision,
    CollectorError,
    SourceFile,
    _json_bytes,
    _safe_id,
    _sha256,
    _validate_base_url,
)


ACS_ADAPTER_ID = "xagt-acs-http/1"
ACS_SCHEMA_VERSION = "xagt-conversation-assets/1"
DEFAULT_PAGE_SIZE = 100
DEFAULT_MAX_PAGES = 100
DEFAULT_MAX_MESSAGES = 10_000
_ID_RE = re.compile(r"^[^/\\\x00-\x1f\x7f]{1,256}$")


class AcsReaderError(CollectorError):
    """The ACS source is unavailable, invalid, or outside the read scope."""


class AcsSourceHTTPError(AcsReaderError):
    """ACS returned a non-success response."""

    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, msg, headers, new):
        return None


def _canonical_bytes(value: Any) -> bytes:
    return _json_bytes(value)


_VOLATILE_KEYS = frozenset({
    "createdAt", "updatedAt", "observedAt", "capturedAt", "recordedAt",
    "timestamp", "capturedThrough",
})


def _stable_for_digest(value: Any) -> Any:
    """Remove transport observation times while retaining transcript content."""
    if isinstance(value, Mapping):
        return {
            str(key): _stable_for_digest(item)
            for key, item in value.items()
            if str(key) not in _VOLATILE_KEYS
        }
    if isinstance(value, (list, tuple)):
        return [_stable_for_digest(item) for item in value]
    return value


def _string(value: Any) -> str | None:
    return value if isinstance(value, str) and value else None


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


def _attachment(value: Any) -> dict[str, Any] | None:
    """Keep attachment identity/size only; bytes require a separate consented read."""
    if not isinstance(value, Mapping):
        return None
    result: dict[str, Any] = {}
    for output, names in {
        "attachmentId": ("attachmentId", "id"),
        "name": ("name", "fileName", "filename"),
        "kind": ("kind", "type"),
        "mediaType": ("mediaType", "contentType", "mimeType"),
        "sizeBytes": ("sizeBytes", "bytes", "size"),
        "sha256": ("sha256", "digest"),
        "status": ("status",),
    }.items():
        for name in names:
            candidate = value.get(name)
            if isinstance(candidate, (str, int)) and candidate != "":
                result[output] = candidate
                break
    # URLs and inline byte fields are intentionally not copied into the
    # normalized projection. The original response remains in ``raw``.
    return result or None


def _normalize_message(value: Any, *, index: int, page: int) -> dict[str, Any]:
    if not isinstance(value, Mapping):
        return {"recordIndex": index, "sourcePage": page, "kind": "unknown", "raw": value}
    result: dict[str, Any] = {
        "recordIndex": index,
        "sourcePage": page,
        "kind": "message",
        "raw": dict(value),
    }
    for output, names in {
        "messageId": ("id", "messageId"),
        "role": ("role",),
        "status": ("status",),
        "timestamp": ("createdAt", "timestamp"),
        "updatedAt": ("updatedAt",),
        "contentRevision": ("contentRevision",),
        "contentState": ("contentState",),
    }.items():
        for name in names:
            candidate = value.get(name)
            if isinstance(candidate, (str, int, float)) and candidate != "":
                result[output] = candidate
                break
    text = _as_text(value.get("content"))
    if text is None:
        text = _as_text(value.get("text"))
    if text is not None:
        result["text"] = text
    attachments = value.get("attachments")
    if isinstance(attachments, list):
        result["attachments"] = [item for item in (_attachment(row) for row in attachments) if item]
    return result


class AcsReader:
    """Read one explicitly authorized ACS session without mutating ACS."""

    def __init__(
        self,
        base_url: str,
        session_id: str,
        *,
        scope: str | Iterable[str] | None = None,
        bearer: str | None = None,
        client_session_token: str | None = None,
        installation_id: str | None = None,
        store_id: str | None = None,
        page_size: int = DEFAULT_PAGE_SIZE,
        max_pages: int = DEFAULT_MAX_PAGES,
        max_messages: int = DEFAULT_MAX_MESSAGES,
        opener: Callable[..., Any] | Any | None = None,
        timeout: float = 30.0,
    ):
        validated_url = _validate_base_url(base_url)
        # ACS gateway configuration normally stores the origin (``acsUrl``),
        # while the source contract lives below ``/api/v2``. Accept both the
        # origin and an already-qualified API base for direct CLI use.
        parsed_base = urllib.parse.urlsplit(validated_url)
        self.base_url = validated_url if parsed_base.path.rstrip("/") else f"{validated_url}/api/v2"
        self.session_id = self._validate_id(session_id, "session_id")
        if isinstance(scope, str):
            scopes = {item.strip().upper() for item in scope.replace(",", " ").split() if item.strip()}
        else:
            scopes = {str(item).strip().upper() for item in (scope or ()) if str(item).strip()}
        if "OBSERVE" not in scopes:
            raise AcsReaderError("explicit OBSERVE scope is required")
        if bearer is not None and (not isinstance(bearer, str) or not bearer.strip()):
            raise AcsReaderError("bearer must be a non-empty string when supplied")
        if client_session_token is not None and (not isinstance(client_session_token, str) or not client_session_token.strip()):
            raise AcsReaderError("client_session_token must be a non-empty string when supplied")
        if not 1 <= page_size <= 100:
            raise AcsReaderError("page_size must be between 1 and 100")
        if not 1 <= max_pages <= DEFAULT_MAX_PAGES:
            raise AcsReaderError("max_pages is out of bounds")
        if not 1 <= max_messages <= DEFAULT_MAX_MESSAGES:
            raise AcsReaderError("max_messages is out of bounds")
        self.scope = frozenset(scopes)
        self.bearer = bearer
        self.client_session_token = client_session_token
        self.installation_id = installation_id or "acs-http"
        self.store_id = store_id or "acs"
        self.page_size = page_size
        self.max_pages = max_pages
        self.max_messages = max_messages
        self.timeout = timeout
        self.opener = opener or urllib.request.build_opener(_NoRedirect())

    @staticmethod
    def _validate_id(value: str, name: str) -> str:
        if not isinstance(value, str) or not _ID_RE.fullmatch(value):
            raise AcsReaderError(f"{name} is invalid")
        if value in {".", ".."} or any(part in {".", ".."} for part in value.replace("\\", "/").split("/")):
            raise AcsReaderError(f"{name} contains a path traversal segment")
        return value

    def _get(self, path: str, query: Mapping[str, Any] | None = None) -> dict[str, Any]:
        raw, _ = self._read_bytes(path, query, accept="application/json", maximum=MAX_RESPONSE_BYTES)
        try:
            value = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise AcsReaderError("ACS returned invalid JSON") from exc
        if not isinstance(value, dict):
            raise AcsReaderError("ACS response must be a JSON object")
        return value

    def _read_bytes(self, path: str, query: Mapping[str, Any] | None, *,
                    accept: str, maximum: int) -> tuple[bytes, str]:
        query_string = urllib.parse.urlencode({key: value for key, value in (query or {}).items() if value is not None})
        url = f"{self.base_url}/{path.lstrip('/')}" + (f"?{query_string}" if query_string else "")
        headers = {"Accept": accept}
        # No ambient credentials: the caller must pass the token for this read.
        if self.bearer:
            headers["Authorization"] = f"Bearer {self.bearer}"
        if self.client_session_token:
            headers["x-codeagent-client-token"] = self.client_session_token
        request = urllib.request.Request(url, method="GET", headers=headers)
        for attempt in range(2):
            content_type = ""
            try:
                if hasattr(self.opener, "open"):
                    response = self.opener.open(request, timeout=self.timeout)
                else:
                    response = self.opener(request, timeout=self.timeout)
                try:
                    status = int(getattr(response, "status", 200))
                    content_type = (getattr(response, "headers", {}) or {}).get("Content-Type", "")
                    raw = response.read(maximum + 1)
                finally:
                    close = getattr(response, "close", None)
                    if close is not None:
                        close()
            except urllib.error.HTTPError as exc:
                status, raw = exc.code, b""
                exc.close()
            except (OSError, TimeoutError) as exc:
                raise AcsReaderError("ACS read failed") from exc
            if status == 409 and attempt == 0:
                continue
            break
        if len(raw) > maximum:
            raise AcsReaderError("ACS response exceeds bound")
        if 300 <= status < 400:
            raise AcsSourceHTTPError(status, f"ACS redirect is not allowed (HTTP {status})")
        if status >= 400:
            raise AcsSourceHTTPError(status, f"ACS returned HTTP {status}")
        return raw, content_type.split(";", 1)[0].strip().lower()

    def read_attachment(self, message_id: str, attachment: Mapping[str, Any], *, maximum: int) -> bytes:
        """Read a transcript-listed attachment by its bound IDs and expected digest."""
        message = urllib.parse.quote(self._validate_id(message_id, "message_id"), safe="")
        identifier = urllib.parse.quote(self._validate_id(attachment.get("attachmentId"), "attachment_id"), safe="")
        media = attachment.get("mediaType")
        digest = attachment.get("sha256")
        size = attachment.get("sizeBytes")
        if (not isinstance(media, str) or not isinstance(digest, str)
                or not re.fullmatch(r"[0-9a-fA-F]{64}", digest)
                or type(size) is not int or not 0 <= size <= maximum):
            raise AcsReaderError("ACS attachment metadata is incomplete or exceeds bounds")
        if media in {"image/png", "image/jpeg"}:
            segment, expected_media = "bytes", media
        elif media.startswith("text/") or media in {"application/json", "application/xml"}:
            segment, expected_media = "content", "text/plain"
        else:
            raise AcsReaderError("ACS attachment media type is unsupported")
        session = urllib.parse.quote(self.session_id, safe="")
        path = f"sessions/{session}/messages/{message}/attachments/{identifier}/{segment}"
        raw, content_type = self._read_bytes(path, None, accept=expected_media, maximum=min(size, maximum))
        if content_type != expected_media or len(raw) != size or _sha256(raw) != digest.lower():
            raise AcsReaderError("ACS attachment bytes do not match the authorized transcript reference")
        return raw

    def _check_session(self, value: Mapping[str, Any], endpoint: str) -> None:
        actual = value.get("sessionId")
        if actual is not None and actual != self.session_id:
            raise AcsReaderError(f"ACS {endpoint} response is bound to another session")

    @staticmethod
    def _source_file(path: str, value: Mapping[str, Any], records: list[dict[str, Any]]) -> SourceFile:
        raw = _canonical_bytes(value)
        return SourceFile(path=path, bytes=len(raw), sha256=_sha256(raw),
                          rawBase64=base64.b64encode(raw).decode("ascii"),
                          records=tuple(records))

    def read(self) -> CollectedRevision:
        """Read foundation, summary and all bounded history pages."""
        foundation = self._get(f"sessions/{urllib.parse.quote(self.session_id, safe='')}/foundation")
        self._check_session(foundation, "foundation")
        summary = self._get(f"sessions/{urllib.parse.quote(self.session_id, safe='')}/summary")
        self._check_session(summary, "summary")

        files: list[SourceFile] = [
            self._source_file("acs/foundation.json", foundation, [{
                "recordIndex": 0, "kind": "foundation", "raw": foundation,
                "sessionId": self.session_id,
            }]),
            self._source_file("acs/summary.json", summary, [{
                "recordIndex": 0, "kind": "summary", "raw": summary,
                "sessionId": self.session_id,
            }]),
        ]
        rows: list[dict[str, Any]] = []
        seen: set[str] = set()
        cursor: str | None = None
        partial_reasons: list[str] = []
        transcript_revision: str | None = None
        pages = 0
        has_older = True
        while has_older and pages < self.max_pages and len(rows) < self.max_messages:
            page_query = {"limit": self.page_size, "cursor": cursor}
            page_value = self._get(
                f"sessions/{urllib.parse.quote(self.session_id, safe='')}/messages", page_query
            )
            self._check_session(page_value, "messages")
            pages += 1
            page_revision = _string(page_value.get("transcriptRevision"))
            if transcript_revision is None:
                transcript_revision = page_revision
            elif page_revision is not None and page_revision != transcript_revision:
                raise AcsReaderError("ACS transcriptRevision changed during bounded read")
            items = page_value.get("items")
            if not isinstance(items, list):
                raise AcsReaderError("ACS messages.items must be an array")
            page_rows: list[dict[str, Any]] = []
            for item in items:
                normalized = _normalize_message(item, index=len(rows) + len(page_rows), page=pages)
                message_id = normalized.get("messageId")
                if isinstance(message_id, str):
                    if message_id in seen:
                        continue
                    seen.add(message_id)
                page_rows.append(normalized)
                if len(rows) + len(page_rows) >= self.max_messages:
                    break
            rows[0:0] = page_rows
            page_file = f"acs/messages/page-{pages:04d}.json"
            files.append(self._source_file(page_file, page_value, page_rows))
            has_older = bool(page_value.get("hasOlder", False))
            next_cursor = _string(page_value.get("beforeCursor")) if has_older else None
            if not page_value.get("rangeComplete", True):
                partial_reasons.append(f"page_{pages}_range_incomplete")
            if has_older and not next_cursor:
                partial_reasons.append("older_cursor_missing")
                break
            if has_older and next_cursor == cursor:
                partial_reasons.append("older_cursor_stalled")
                break
            cursor = next_cursor
            if len(rows) >= self.max_messages:
                partial_reasons.append("message_bound_reached")
                break
        if has_older and pages >= self.max_pages:
            partial_reasons.append("page_bound_reached")
        coverage_status = "partial" if partial_reasons else "complete"
        source_identity = {
            "installationId": self.installation_id,
            "storeId": self.store_id,
            "sessionId": self.session_id,
            "adapterId": ACS_ADAPTER_ID,
        }
        source_key = _sha256(_canonical_bytes(source_identity))
        coverage = {
            "status": coverage_status,
            "pages": pages,
            "messages": len(rows),
            "pageSize": self.page_size,
            "maxPages": self.max_pages,
            "maxMessages": self.max_messages,
            "partialReasons": partial_reasons,
            "hasOlder": has_older,
            "sourceVersion": summary.get("sessionVersion", foundation.get("sessionVersion")),
            "transcriptRevision": transcript_revision,
            "attachments": "references-only",
            "capturedThrough": summary.get("updatedAt", foundation.get("createdAt")),
        }
        file_payloads = [asdict(item) for item in files]
        raw_digest = _sha256(_canonical_bytes({"files": file_payloads, "rows": rows, "coverage": coverage}))
        # Raw bytes, byte counts and response hashes remain in the audit
        # payload, but are excluded from revision identity: ACS may refresh
        # observation timestamps without changing the conversation content.
        stable_files = [{"path": item["path"], "records": item["records"]} for item in file_payloads]
        digest = _sha256(_canonical_bytes(_stable_for_digest({
            "files": stable_files, "rows": rows, "coverage": coverage,
        })))
        asset_id = _safe_id("asset", source_key)
        revision_id = _safe_id("rev", digest)
        payload = {
            "schemaVersion": ACS_SCHEMA_VERSION,
            "assetId": asset_id,
            "revisionId": revision_id,
            "source": {
                "kind": "acs-http",
                "sourceKey": source_key,
                "installationId": self.installation_id,
                "storeId": self.store_id,
                "sessionId": self.session_id,
                "adapterId": ACS_ADAPTER_ID,
                "readOnly": True,
                "scope": sorted(self.scope),
            },
            "coverage": coverage,
            "capturedAt": summary.get("updatedAt", foundation.get("createdAt")),
            "files": file_payloads,
            "rows": rows,
            "recordCount": len(rows),
            "digest": digest,
            "rawDigest": raw_digest,
        }
        return CollectedRevision(assetId=asset_id, revisionId=revision_id,
                                 payload=payload, sourceFiles=tuple(files))


__all__ = ["ACS_ADAPTER_ID", "AcsReader", "AcsReaderError", "AcsSourceHTTPError"]
