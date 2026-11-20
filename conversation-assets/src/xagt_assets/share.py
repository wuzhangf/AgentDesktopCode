"""Offline message-level sharing from a verified portable revision.

This module deliberately has no service client.  It verifies and opens one
portable revision with :func:`unlock.read_revision_bytes`, normalizes visible
messages with ``local_search``, and encrypts a new, minimal user-held object.
The original revision's raw rows, ciphertext, envelope, and keys never enter
the new bundle.
"""

from __future__ import annotations

import argparse
import json
import os
import secrets
from pathlib import Path
from typing import Any, Mapping, Sequence

from .bundle import BundleError, export_bundle
from .collector import CollectedRevision, CollectorError, make_user_held_payload
from .crypto import canonical_json
from .local_search import (
    DEFAULT_MAX_MESSAGES,
    DEFAULT_MAX_TEXT_CHARS,
    MAX_SEARCH_PAYLOAD_BYTES,
    SearchError,
    extract_messages,
)
from .unlock import UnlockError, read_revision_bytes


SHARE_SCHEMA_VERSION = "xagt-conversation-share/1"


class ShareError(ValueError):
    """The source selection or share bundle cannot be safely produced."""


def _key(value: bytes, name: str) -> bytes:
    if not isinstance(value, bytes) or len(value) != 32:
        raise ShareError(f"{name} must be exactly 32 bytes")
    return value


def _key_file(path: str | os.PathLike[str], name: str) -> bytes:
    try:
        value = Path(path).read_bytes()
    except OSError as exc:
        raise ShareError(f"unable to read {name}") from exc
    return _key(value, name)


def _selected_ids(value: Sequence[str]) -> tuple[str, ...]:
    if isinstance(value, (str, bytes)) or not isinstance(value, Sequence):
        raise ShareError("selected_message_ids must be a non-empty sequence")
    result = tuple(item for item in value if isinstance(item, str) and item)
    if not result or len(result) != len(value):
        raise ShareError("selected message IDs must be non-empty strings")
    if len(set(result)) != len(result):
        raise ShareError("selected message IDs must not repeat")
    if len(result) > DEFAULT_MAX_MESSAGES:
        raise ShareError("too many selected messages")
    return result


def create_share_bundle(
    source_bundle: str | os.PathLike[str],
    *,
    asset_id: str,
    revision_id: str,
    selected_message_ids: Sequence[str],
    destination: str | os.PathLike[str],
    recipient_public_key: bytes,
    signer_private_key: bytes,
    recipient_device_id: str,
    signer_device_id: str,
    source_recipient_private_key_path: str | os.PathLike[str] | None = None,
    source_signer_public_key_path: str | os.PathLike[str] | None = None,
    archive_signer_public_key_path: str | os.PathLike[str] | None = None,
) -> dict[str, Any]:
    """Create a new encrypted share bundle from explicit visible message IDs."""
    if not isinstance(asset_id, str) or not asset_id or not isinstance(revision_id, str) or not revision_id:
        raise ShareError("asset_id and revision_id are required")
    selected = _selected_ids(selected_message_ids)
    recipient_public_key = _key(recipient_public_key, "recipient public key")
    signer_private_key = _key(signer_private_key, "signer private key")
    if not isinstance(recipient_device_id, str) or not recipient_device_id:
        raise ShareError("recipient_device_id is required")
    if not isinstance(signer_device_id, str) or not signer_device_id:
        raise ShareError("signer_device_id is required")
    if Path(destination).exists():
        raise ShareError("share destination already exists")
    try:
        plaintext, _ = read_revision_bytes(
            source_bundle, asset_id=asset_id, revision_id=revision_id,
            recipient_private_key_path=source_recipient_private_key_path,
            signer_public_key_path=source_signer_public_key_path,
            archive_signer_public_key_path=archive_signer_public_key_path,
        )
        if len(plaintext) > MAX_SEARCH_PAYLOAD_BYTES:
            raise ShareError("source revision exceeds offline share bound")
        payload = json.loads(plaintext.decode("utf-8"))
    except (UnlockError, OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ShareError("unable to verify and open source revision") from exc
    if not isinstance(payload, Mapping):
        raise ShareError("source revision payload must be an object")
    try:
        normalized = extract_messages(
            payload, include_source_paths=False, require_unambiguous_ids=frozenset(selected),
            max_messages=DEFAULT_MAX_MESSAGES, max_text_chars=DEFAULT_MAX_TEXT_CHARS)
    except SearchError as exc:
        raise ShareError(str(exc)) from exc
    by_id = {message.message_id: message for message in normalized if message.message_id is not None}
    missing = [message_id for message_id in selected if message_id not in by_id]
    if missing:
        raise ShareError("selected message ID is unknown, hidden, or a tool message")
    chosen = [by_id[message_id] for message_id in selected]
    if any(message.truncated for message in chosen):
        raise ShareError("selected message exceeds the exact offline text bound")
    share_messages = [
        {"messageId": message.message_id, "role": message.role,
         "text": message.text, "sourceRef": message.source_ref}
        for message in chosen
    ]
    share_asset_id = "share-" + secrets.token_hex(20)
    share_revision_id = "share-rev-" + secrets.token_hex(20)
    share_payload: dict[str, Any] = {
        "schemaVersion": SHARE_SCHEMA_VERSION,
        "assetId": share_asset_id,
        "revisionId": share_revision_id,
        "source": {
            "kind": "conversation-share",
            "assetId": asset_id,
            "revisionId": revision_id,
            "messageIds": list(selected),
            "readOnly": True,
        },
        "messages": share_messages,
        "recordCount": len(share_messages),
    }
    revision = CollectedRevision(
        assetId=share_asset_id, revisionId=share_revision_id,
        payload=share_payload, sourceFiles=(),
    )
    try:
        encrypted = make_user_held_payload(
            revision, recipient_public_key=recipient_public_key,
            signer_private_key=signer_private_key,
            recipient_device_id=recipient_device_id,
            signer_device_id=signer_device_id,
            grant_id="share-key-" + secrets.token_hex(20),
        )
    except CollectorError as exc:
        raise ShareError("unable to encrypt selected messages") from exc
    record = {"assetId": share_asset_id, "revisionId": share_revision_id,
              "mode": "userHeld", "payload": encrypted}
    try:
        result = export_bundle(
            destination,
            files={f"revisions/{share_revision_id}.json": canonical_json(record)},
            metadata={"kind": "conversation-share", "assetId": share_asset_id, "revisionId": share_revision_id},
            signing_private_key=signer_private_key, signer_device_id=signer_device_id,
            replace_existing=False,
        )
    except (BundleError, OSError) as exc:
        raise ShareError("unable to write share bundle") from exc
    return {"assetId": share_asset_id, "revisionId": share_revision_id,
            "messageCount": len(share_messages), "destination": str(Path(destination).resolve()),
            "provenance": result.get("provenance") is not None}


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Create an offline user-held message share bundle")
    parser.add_argument("bundle")
    parser.add_argument("--asset-id", required=True)
    parser.add_argument("--revision-id", required=True)
    parser.add_argument("--message-id", action="append", dest="message_ids", required=True)
    parser.add_argument("--recipient-public-key", required=True)
    parser.add_argument("--signer-private-key", required=True)
    parser.add_argument("--recipient-device-id", required=True)
    parser.add_argument("--signer-device-id", required=True)
    parser.add_argument("--destination", required=True)
    parser.add_argument("--source-recipient-private-key")
    parser.add_argument("--source-signer-public-key")
    parser.add_argument("--archive-signer-public-key")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    try:
        args = _parser().parse_args(argv)
        result = create_share_bundle(
            args.bundle, asset_id=args.asset_id, revision_id=args.revision_id,
            selected_message_ids=args.message_ids, destination=args.destination,
            recipient_public_key=_key_file(args.recipient_public_key, "recipient public key"),
            signer_private_key=_key_file(args.signer_private_key, "signer private key"),
            recipient_device_id=args.recipient_device_id, signer_device_id=args.signer_device_id,
            source_recipient_private_key_path=args.source_recipient_private_key,
            source_signer_public_key_path=args.source_signer_public_key,
            archive_signer_public_key_path=args.archive_signer_public_key,
        )
    except (ShareError, CollectorError) as exc:
        print(json.dumps({"code": "SHARE_FAILED", "message": str(exc)}, ensure_ascii=False))
        return 2
    print(json.dumps({"code": "SHARE_CREATED", **result}, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())


__all__ = ["SHARE_SCHEMA_VERSION", "ShareError", "create_share_bundle"]
