"""Read attachment bytes from the selected conversation, never from arbitrary file paths."""

from __future__ import annotations

import base64
import binascii
from collections.abc import Callable, Iterable, Mapping
from dataclasses import dataclass
from typing import Any

from .acs_reader import AcsReader
from .collector import CollectedRevision, CollectorError


MAX_CAPTURE_BYTES = 2 * 1024 * 1024
MAX_CAPTURE_TOTAL = 8 * 1024 * 1024
MAX_CAPTURE_ITEMS = 32
_IMAGES = {"image/png": (".png", b"\x89PNG\r\n\x1a\n"), "image/jpeg": (".jpg", b"\xff\xd8\xff")}


@dataclass(frozen=True)
class SourceAttachment:
    reference: str
    name: str
    media: str
    read: Callable[[int], bytes]


def _pi_image(block: Mapping[str, Any], maximum: int) -> bytes:
    media, data = block.get("mimeType"), block.get("data")
    if (not isinstance(media, str) or media not in _IMAGES or not isinstance(data, str)
            or len(data) > ((maximum + 2) // 3) * 4):
        raise CollectorError("invalid or oversized Pi inline image")
    try:
        raw = base64.b64decode(data, validate=True)
    except (ValueError, binascii.Error) as exc:
        raise CollectorError("invalid Pi inline image encoding") from exc
    if len(raw) > maximum or not raw.startswith(_IMAGES[media][1]):
        raise CollectorError("Pi inline image does not match its declared format")
    return raw


def _pi_attachments(revision: CollectedRevision) -> Iterable[SourceAttachment]:
    for source in revision.sourceFiles:
        for record in source.records:
            raw = record.get("raw")
            if not isinstance(raw, Mapping) or raw.get("type") != "message":
                continue
            message = raw.get("message")
            if not isinstance(message, Mapping) or message.get("role") != "user":
                continue
            content = message.get("content")
            if not isinstance(content, list):
                continue
            for index, block in enumerate(content):
                if not isinstance(block, Mapping) or block.get("type") != "image":
                    continue
                media = block.get("mimeType")
                media = media if isinstance(media, str) else ""
                suffix = _IMAGES.get(media, (".bin", b""))[0]
                reference = f"{source.path}:{record.get('sourceLine')}:{index}"
                yield SourceAttachment(
                    reference, f"pi-image-{index + 1}{suffix}", media,
                    lambda limit, block=block: _pi_image(block, limit))


def _acs_attachments(revision: CollectedRevision, reader: AcsReader) -> Iterable[SourceAttachment]:
    for row in revision.payload.get("rows", []):
        for index, entry in enumerate(row.get("attachments", [])):
            message_id = row.get("messageId")
            attachment_id = entry.get("attachmentId")
            reference = f"{message_id}/{attachment_id or index}"
            # The original name normally is a basename, but never let a
            # vendor path be used as a filesystem path or object key.
            name = str(entry.get("name") or "").replace("\\", "/").rsplit("/", 1)[-1]
            name = "".join(character for character in name if ord(character) >= 32)[:240].strip()
            media = entry.get("mediaType")
            media = media if isinstance(media, str) else ""
            yield SourceAttachment(
                reference, name or f"acs-attachment-{index + 1}", media,
                lambda limit, message_id=message_id, entry=entry: reader.read_attachment(
                    message_id, entry, maximum=limit))


def source_attachments(revision: CollectedRevision, reader: AcsReader | None) -> Iterable[SourceAttachment]:
    return _pi_attachments(revision) if reader is None else _acs_attachments(revision, reader)
