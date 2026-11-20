"""Bounded, read-only keyword search for the private asset service.

This is deliberately a scan, not an index or semantic search.  Only recent
conversation heads whose revision mode is ``cloudProcessable`` are eligible;
user-held ciphertext is never opened or inspected by this module.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from typing import Any, Callable

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field

from .api import Actor
from .local_search import DEFAULT_MAX_TEXT_CHARS, SearchError, extract_messages, search_messages
from .store import MODES, _cloud_open, _aad


DEFAULT_CANDIDATE_LIMIT = 50
MAX_CANDIDATE_LIMIT = 100
DEFAULT_RESULT_LIMIT = 50
MAX_RESULT_LIMIT = 100
MAX_QUERY_BYTES = 256
MAX_REQUEST_BYTES = 4096
MAX_SCAN_BYTES = 32 * 1024 * 1024
MAX_TEXT_BYTES = 256 * 1024
MAX_FIELDS_PER_REVISION = 20_000


class SearchValidationError(ValueError):
    """The bounded search request is not valid."""


@dataclass(frozen=True)
class _Candidate:
    asset_id: str
    revision_id: str
    subject_id: str
    payload_json: str
    created_at: str
    updated_at: str


def _result_id(asset_id: str, revision_id: str, path: str, offset: int) -> str:
    seed = "\0".join((asset_id, revision_id, path, str(offset))).encode("utf-8")
    return "match-" + hashlib.sha256(seed).hexdigest()[:32]


class SearchRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    query: str = Field(min_length=1, max_length=256)
    candidate_limit: int = Field(DEFAULT_CANDIDATE_LIMIT, alias="candidateLimit", ge=1, le=MAX_CANDIDATE_LIMIT)
    result_limit: int = Field(DEFAULT_RESULT_LIMIT, alias="maxResults", ge=1, le=MAX_RESULT_LIMIT)


class SearchService:
    def __init__(self, store: Any, *, max_scan_bytes: int = MAX_SCAN_BYTES,
                 max_text_bytes: int = MAX_TEXT_BYTES,
                 max_fields_per_revision: int = MAX_FIELDS_PER_REVISION) -> None:
        if not 1 <= max_scan_bytes <= 256 * 1024 * 1024:
            raise ValueError("max_scan_bytes is outside the supported bound")
        if not 1 <= max_text_bytes <= 4 * 1024 * 1024:
            raise ValueError("max_text_bytes is outside the supported bound")
        if not 1 <= max_fields_per_revision <= 100_000:
            raise ValueError("max_fields_per_revision is outside the supported bound")
        self.store = store
        self.max_scan_bytes = max_scan_bytes
        self.max_text_bytes = max_text_bytes
        self.max_fields_per_revision = max_fields_per_revision

    def search(self, actor: Actor, query: str, *, candidate_limit: int = DEFAULT_CANDIDATE_LIMIT,
               result_limit: int = DEFAULT_RESULT_LIMIT) -> dict[str, Any]:
        if not actor.can_read:
            raise PermissionError("assets:read is required")
        if not isinstance(query, str) or not query or not query.strip():
            raise SearchValidationError("search query must contain a non-whitespace phrase")
        if len(query.encode("utf-8")) > MAX_QUERY_BYTES:
            raise SearchValidationError("search query exceeds the 256-byte limit")
        if not 1 <= int(candidate_limit) <= MAX_CANDIDATE_LIMIT:
            raise SearchValidationError("candidateLimit is outside the supported bound")
        if not 1 <= int(result_limit) <= MAX_RESULT_LIMIT:
            raise SearchValidationError("maxResults is outside the supported bound")
        # A user-held-only instance has no decryption key by construction.
        if ("cloudProcessable" not in getattr(self.store, "allowed_modes", MODES)
                or getattr(self.store, "cloud_key", None) is None):
            return self._empty(query, int(candidate_limit), int(result_limit),
                               reason="cloud_mode_disabled")
        with self.store.connection() as conn:
            rows = self.store._query(
                conn,
                "WITH candidates AS ("
                "SELECT c.asset_id,c.updated_at,r.revision_id,r.subject_id,r.payload_json,r.created_at "
                "FROM xagt_asset_conversations c JOIN xagt_asset_revisions r "
                "ON r.tenant_id=c.tenant_id AND r.workspace_id=c.workspace_id "
                "AND r.member_id=c.member_id AND r.asset_id=c.asset_id "
                "AND r.revision_id=c.head_revision "
                "WHERE c.tenant_id=? AND c.workspace_id=? AND c.member_id=? "
                "AND c.deleted_at IS NULL AND r.mode='cloudProcessable' "
                "ORDER BY c.updated_at DESC,c.asset_id DESC LIMIT ?) "
                "SELECT asset_id,updated_at,revision_id,subject_id,created_at,"
                "CASE WHEN SUM(LENGTH(payload_json)) OVER (ORDER BY updated_at DESC,asset_id DESC) <= ? "
                "THEN payload_json END AS payload_json FROM candidates ORDER BY updated_at DESC,asset_id DESC",
                (actor.tenant_id, actor.workspace_id, actor.member_id, int(candidate_limit) + 1,
                 self.max_scan_bytes),
            )
        candidate_truncated = len(rows) > int(candidate_limit)
        candidates = rows[:int(candidate_limit)]
        items: list[dict[str, Any]] = []
        scanned_bytes = 0
        candidates_scanned = 0
        truncation_reasons: list[str] = []
        for raw in candidates:
            if raw["payload_json"] is None:
                truncation_reasons.append("scan_byte_limit")
                break
            scanned_bytes += len(raw["payload_json"].encode("utf-8"))
            candidates_scanned += 1
            candidate = _Candidate(str(raw["asset_id"]), str(raw["revision_id"]),
                                   str(raw["subject_id"]), str(raw["payload_json"]),
                                   str(raw["created_at"]), str(raw["updated_at"]))
            try:
                stored = json.loads(candidate.payload_json)
                payload = _cloud_open(stored, self.store.cloud_key,
                                      _aad(actor, candidate.asset_id, candidate.revision_id,
                                           "cloudProcessable", subject_id=candidate.subject_id))
            except (TypeError, ValueError, json.JSONDecodeError):
                # A corrupt row is isolated from search results.  The search
                # response carries no ciphertext or exception detail.
                truncation_reasons.append("unreadable_revision")
                continue
            try:
                messages = extract_messages(
                    payload,
                    include_tools=False,
                    include_source_paths=False,
                    max_messages=min(self.max_fields_per_revision, 10_000),
                    max_text_chars=min(self.max_text_bytes, DEFAULT_MAX_TEXT_CHARS),
                )
                hits = search_messages(messages, query, limit=int(result_limit), context_chars=72)
            except SearchError:
                # A malformed or oversized normalized projection is isolated
                # from the remaining candidates and is never echoed.
                truncation_reasons.append("invalid_message_projection")
                continue
            if len(messages) >= min(self.max_fields_per_revision, 10_000):
                truncation_reasons.append("field_limit")
            if any(message.truncated for message in messages):
                truncation_reasons.append("message_text_limit")
            for hit in hits:
                items.append({
                    "resultId": _result_id(candidate.asset_id, candidate.revision_id,
                                            hit.source_ref, hit.match_start),
                    "assetId": candidate.asset_id,
                    "revisionId": candidate.revision_id,
                    "messageId": hit.message_id,
                    "path": hit.source_ref,
                    "sourceRef": hit.source_ref,
                    "role": hit.role,
                    "snippet": hit.snippet,
                    "createdAt": candidate.created_at,
                    "updatedAt": candidate.updated_at,
                    "provenance": {"source": "normalized_visible_message",
                                    "mode": "cloudProcessable",
                                    "sourceRef": hit.source_ref},
                })
                if len(items) >= int(result_limit):
                    truncation_reasons.append("result_limit")
                    break
            if len(items) >= int(result_limit):
                break
        if candidate_truncated:
            truncation_reasons.append("candidate_limit")
        # Keep response reason order stable for clients and acceptance logs.
        reasons = list(dict.fromkeys(truncation_reasons))
        return {
            "schemaVersion": "xagt-conversation-search/1",
            "queryBytes": len(query.encode("utf-8")),
            "candidateLimit": int(candidate_limit),
            "candidatesScanned": candidates_scanned,
            "scannedBytes": scanned_bytes,
            "maxResults": int(result_limit),
            "truncated": bool(reasons),
            "truncationReasons": reasons,
            "searchKind": "bounded_recent_head_keyword_scan",
            "items": items,
        }

    @staticmethod
    def _empty(query: str, candidate_limit: int, result_limit: int, *, reason: str) -> dict[str, Any]:
        return {"schemaVersion": "xagt-conversation-search/1",
                "queryBytes": len(query.encode("utf-8")),
                "candidateLimit": candidate_limit, "candidatesScanned": 0,
                "scannedBytes": 0, "maxResults": result_limit, "truncated": False,
                "truncationReasons": [reason],
                "searchKind": "bounded_recent_head_keyword_scan", "items": []}


def build_search_router(store: Any, identity: Callable[..., Actor]) -> APIRouter:
    """Build the private-VPS search router; callers choose where to mount it."""
    service = SearchService(store)
    router = APIRouter()

    @router.post("/search")
    async def search(request: Request, actor: Actor = Depends(identity)) -> JSONResponse:
        if not actor.can_read:
            raise HTTPException(403, detail={"code": "SCOPE_DENIED", "message": "assets:read is required"})
        data = bytearray()
        async for chunk in request.stream():
            if len(data) + len(chunk) > MAX_REQUEST_BYTES:
                raise HTTPException(413, detail={"code": "SEARCH_REQUEST_TOO_LARGE"})
            data.extend(chunk)
        try:
            body = SearchRequest.model_validate_json(bytes(data))
            result = await run_in_threadpool(service.search, actor, body.query,
                                             candidate_limit=body.candidate_limit,
                                             result_limit=body.result_limit)
            return JSONResponse(content=result, headers={"Cache-Control": "no-store"})
        except PermissionError as exc:
            raise HTTPException(403, detail={"code": "SCOPE_DENIED", "message": str(exc)}) from exc
        except ValueError:
            raise HTTPException(400, detail={"code": "VALIDATION", "message": "invalid search request"}) from None
        except Exception:
            raise HTTPException(500, detail={"code": "ASSET_SEARCH_ERROR", "message": "asset search unavailable"}) from None

    return router
