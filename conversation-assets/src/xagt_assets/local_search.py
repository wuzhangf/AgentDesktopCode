"""Offline keyword search over verified conversation revisions.

This module is intentionally pure after the revision has been unlocked.  It
normalizes the two staged-source shapes used by the collector (Pi/Codex files
and the ACS projection), removes tool/metadata rows by default, bounds all
text kept in memory, and returns stable source references rather than raw
records.  ``search_bundle`` verifies and opens revisions entirely in
memory, without contacting the Hosted service.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
from dataclasses import asdict, dataclass
from typing import Any, Iterable, Mapping, Sequence

from .unlock import UnlockError, read_revision_bytes


MAX_SEARCH_PAYLOAD_BYTES = 8 * 1024 * 1024
DEFAULT_MAX_MESSAGES = 10_000
DEFAULT_MAX_TEXT_CHARS = 16_384
DEFAULT_CONTEXT_CHARS = 240
DEFAULT_LIMIT = 50


class SearchError(ValueError):
    """The local revision or search request is invalid or too large."""


@dataclass(frozen=True)
class NormalizedMessage:
    """Bounded, searchable projection with a stable source reference."""

    message_id: str | None
    role: str
    text: str
    source_ref: str
    timestamp: str | int | float | None = None
    kind: str = "message"
    truncated: bool = False

    def as_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(frozen=True)
class SearchHit:
    message_id: str | None
    role: str
    snippet: str
    source_ref: str
    timestamp: str | int | float | None
    match_start: int
    match_end: int

    def as_dict(self) -> dict[str, Any]:
        return asdict(self)


def _text(value: Any) -> str | None:
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        pieces: list[str] = []
        for item in value:
            if isinstance(item, str):
                pieces.append(item)
            elif isinstance(item, Mapping) and isinstance(item.get("text"), str):
                pieces.append(item["text"])
        return "\n".join(pieces) if pieces else None
    if isinstance(value, Mapping) and isinstance(value.get("text"), str):
        return value["text"]
    return None


def _source_ref(row: Mapping[str, Any], *, fallback: str) -> str:
    """Build a stable compact reference without retaining a raw row."""
    fields: list[str] = []
    for name in ("sourceFile", "sourceLine", "sourcePage", "recordIndex"):
        value = row.get(name)
        if isinstance(value, (str, int)) and str(value):
            fields.append(f"{name}={value}")
    return "&".join(fields) if fields else fallback


def _row_identity(row: Mapping[str, Any], source_ref: str, text: str, role: str) -> str:
    for name in ("messageId", "message_id", "id", "uuid"):
        value = row.get(name)
        if isinstance(value, str) and value:
            return "id:" + value
    return "ref:" + source_ref if source_ref else "row:" + hashlib.sha256(
        json.dumps([role, text], ensure_ascii=False, sort_keys=True).encode("utf-8")
    ).hexdigest()


def _is_tool_or_metadata(row: Mapping[str, Any]) -> bool:
    role = str(row.get("role") or "").casefold()
    kind = str(row.get("kind") or row.get("type") or "").casefold()
    if role in {"tool", "function", "computer", "tool_call", "tool_result", "system", "developer"}:
        return True
    return any(token in kind for token in (
        "tool", "function_call", "metadata", "session_meta", "session", "foundation", "summary", "reasoning",
    ))


def _rows(payload: Mapping[str, Any], *, include_source_paths: bool
          ) -> Iterable[tuple[Mapping[str, Any], str]]:
    """Yield rows from ACS ``rows`` and local ``files[*].records`` shapes."""
    direct_rows = payload.get("messages")
    if isinstance(direct_rows, list):
        for index, row in enumerate(direct_rows):
            if isinstance(row, Mapping):
                yield row, f"messages[{index}]"
    acs_rows = payload.get("rows")
    if isinstance(acs_rows, list):
        for index, row in enumerate(acs_rows):
            if isinstance(row, Mapping):
                yield row, f"rows[{index}]"
    files = payload.get("files")
    if isinstance(files, list):
        for file_index, item in enumerate(files):
            if not isinstance(item, Mapping) or not isinstance(item.get("records"), list):
                continue
            file_name = item.get("path")
            for row_index, row in enumerate(item["records"]):
                if isinstance(row, Mapping):
                    if include_source_paths and isinstance(file_name, str):
                        yield row, f"{file_name}#record-{row_index}"
                    else:
                        yield row, f"files[{file_index}].records[{row_index}]"


def extract_messages(payload: Mapping[str, Any], *, include_tools: bool = False,
                     include_source_paths: bool = True,
                     max_messages: int = DEFAULT_MAX_MESSAGES,
                     max_text_chars: int = DEFAULT_MAX_TEXT_CHARS) -> tuple[NormalizedMessage, ...]:
    """Normalize Pi/Codex or ACS rows into a bounded deduplicated sequence."""
    if not isinstance(payload, Mapping):
        raise SearchError("revision payload must be an object")
    if not isinstance(max_messages, int) or not 1 <= max_messages <= DEFAULT_MAX_MESSAGES:
        raise SearchError("max_messages is out of bounds")
    if not isinstance(max_text_chars, int) or not 1 <= max_text_chars <= DEFAULT_MAX_TEXT_CHARS:
        raise SearchError("max_text_chars is out of bounds")
    result: list[NormalizedMessage] = []
    seen: set[str] = set()
    for row, fallback in _rows(payload, include_source_paths=include_source_paths):
        if not include_tools and _is_tool_or_metadata(row):
            continue
        value = _text(row.get("text"))
        if value is None:
            value = _text(row.get("content"))
        if value is None:
            value = _text(row.get("message"))
        if not value:
            continue
        role = row.get("role") if isinstance(row.get("role"), str) else "unknown"
        reference = _source_ref(row, fallback=fallback) if include_source_paths else fallback
        identity = _row_identity(row, fallback, value, role)
        if identity in seen:
            continue
        seen.add(identity)
        bounded = value[:max_text_chars]
        timestamp = row.get("timestamp", row.get("createdAt"))
        if not isinstance(timestamp, (str, int, float)):
            timestamp = None
        message_id = next((row[name] for name in ("messageId", "message_id", "id", "uuid")
                           if isinstance(row.get(name), str) and row.get(name)), None)
        result.append(NormalizedMessage(
            message_id=message_id, role=role, text=bounded, source_ref=reference,
            timestamp=timestamp, kind=str(row.get("kind") or row.get("type") or "message"),
            truncated=len(value) > len(bounded)))
        if len(result) >= max_messages:
            break
    return tuple(result)


# Names shared with the stage-3 object/search service.
normalize_messages = extract_messages


def _find(text: str, query: str, *, case_sensitive: bool) -> tuple[int, int] | None:
    if not query:
        raise SearchError("query must not be empty")
    haystack, needle = (text, query) if case_sensitive else (text.casefold(), query.casefold())
    start = haystack.find(needle)
    if start < 0:
        return None
    end = start + len(needle)
    if len(text) == len(haystack):
        return start, end
    offset = 0
    original_start = 0
    for index, character in enumerate(text):
        next_offset = offset + len(character.casefold())
        if offset <= start < next_offset:
            original_start = index
        if end <= next_offset:
            return original_start, index + 1
        offset = next_offset
    return None


def keyword_matches(text: str, query: str, *, case_sensitive: bool = False) -> bool:
    """Return whether a CJK, English or code substring occurs in ``text``."""
    if not isinstance(text, str) or not isinstance(query, str):
        raise SearchError("text and query must be strings")
    return _find(text, query, case_sensitive=case_sensitive) is not None


def search_messages(messages_or_payload: Mapping[str, Any] | Sequence[NormalizedMessage],
                    query: str, *, case_sensitive: bool = False,
                    include_tools: bool = False, limit: int = DEFAULT_LIMIT,
                    context_chars: int = DEFAULT_CONTEXT_CHARS) -> tuple[SearchHit, ...]:
    """Search bounded normalized messages and return snippets only."""
    if not isinstance(limit, int) or not 1 <= limit <= 1_000:
        raise SearchError("limit is out of bounds")
    if not isinstance(context_chars, int) or not 0 <= context_chars <= 4_096:
        raise SearchError("context_chars is out of bounds")
    if isinstance(messages_or_payload, Mapping):
        messages = extract_messages(messages_or_payload, include_tools=include_tools)
    else:
        messages = tuple(messages_or_payload)
    hits: list[SearchHit] = []
    for message in messages:
        if not isinstance(message, NormalizedMessage):
            raise SearchError("message sequence contains an invalid item")
        found = _find(message.text, query, case_sensitive=case_sensitive)
        if found is None:
            continue
        start, end = found
        snippet_start = max(0, start - context_chars)
        snippet_end = min(len(message.text), end + context_chars)
        hits.append(SearchHit(
            message_id=message.message_id, role=message.role,
            snippet=message.text[snippet_start:snippet_end], source_ref=message.source_ref,
            timestamp=message.timestamp, match_start=start - snippet_start,
            match_end=end - snippet_start))
        if len(hits) >= limit:
            break
    return tuple(hits)


def search_bundle(bundle_path: str | os.PathLike[str], *, asset_id: str, revision_id: str,
                  query: str, recipient_private_key_path: str | os.PathLike[str] | None = None,
                  signer_public_key_path: str | os.PathLike[str] | None = None,
                  archive_signer_public_key_path: str | os.PathLike[str] | None = None,
                  case_sensitive: bool = False, include_tools: bool = False,
                  limit: int = DEFAULT_LIMIT,
                  context_chars: int = DEFAULT_CONTEXT_CHARS) -> tuple[SearchHit, ...]:
    """Verify and search one bundle revision in memory."""
    try:
        plaintext, _ = read_revision_bytes(
            bundle_path, asset_id=asset_id, revision_id=revision_id,
            recipient_private_key_path=recipient_private_key_path,
            signer_public_key_path=signer_public_key_path,
            archive_signer_public_key_path=archive_signer_public_key_path,
        )
        if len(plaintext) > MAX_SEARCH_PAYLOAD_BYTES:
            raise SearchError("unlocked revision exceeds the local search size bound")
        value = json.loads(plaintext)
    except (UnlockError, OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise SearchError("unable to verify and unlock revision for local search") from exc
    if not isinstance(value, Mapping):
        raise SearchError("unlocked revision payload must be an object")
    return search_messages(value, query, case_sensitive=case_sensitive,
                           include_tools=include_tools, limit=limit,
                           context_chars=context_chars)


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Offline search of a verified xagt conversation bundle")
    parser.add_argument("bundle")
    parser.add_argument("--asset-id", required=True)
    parser.add_argument("--revision-id", required=True)
    parser.add_argument("--query", required=True)
    parser.add_argument("--recipient-private-key")
    parser.add_argument("--signer-public-key")
    parser.add_argument("--archive-signer-public-key")
    parser.add_argument("--case-sensitive", action="store_true")
    parser.add_argument("--include-tools", action="store_true")
    parser.add_argument("--limit", type=int, default=DEFAULT_LIMIT)
    parser.add_argument("--context-chars", type=int, default=DEFAULT_CONTEXT_CHARS)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    try:
        hits = search_bundle(
            args.bundle, asset_id=args.asset_id, revision_id=args.revision_id,
            query=args.query, recipient_private_key_path=args.recipient_private_key,
            signer_public_key_path=args.signer_public_key,
            archive_signer_public_key_path=args.archive_signer_public_key,
            case_sensitive=args.case_sensitive, include_tools=args.include_tools,
            limit=args.limit, context_chars=args.context_chars)
    except SearchError as exc:
        print(json.dumps({"code": "SEARCH_FAILED", "message": str(exc)}, ensure_ascii=False))
        return 2
    print(json.dumps({"code": "SEARCH_OK", "count": len(hits),
                      "hits": [hit.as_dict() for hit in hits]}, ensure_ascii=False))
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())


__all__ = [
    "DEFAULT_CONTEXT_CHARS", "DEFAULT_LIMIT", "NormalizedMessage", "SearchError", "SearchHit",
    "extract_messages", "keyword_matches", "normalize_messages", "search_bundle", "search_messages",
]
