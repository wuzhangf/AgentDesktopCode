"""Export or restore a conversation's immutable revision chain over the asset API."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
from pathlib import Path
from typing import Any

from .bundle import BundleError, export_bundle, import_bundle
from .collector import AssetUploader, UploadError
from .crypto import canonical_json

_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,127}\Z")
_MAX_REVISIONS = 128
_MAX_CHAIN_BYTES = 64 * 1024 * 1024
_ARCHIVE_KIND = "xagt-conversation-revision-chain/1"


def _resource_id(value: Any) -> str:
    if not isinstance(value, str) or not _ID.fullmatch(value):
        raise BundleError("invalid resource identifier")
    return value


def _revision_path(asset_id: str, revision_id: str) -> str:
    return f"conversations/{asset_id}/revisions/{revision_id}"


def _restore_fields(record: Any, asset_id: str, revision_id: str) -> dict[str, Any]:
    if not isinstance(record, dict) or record.get("assetId") != asset_id or record.get("revisionId") != revision_id:
        raise BundleError("revision does not match its archive identity")
    if record.get("mode") not in ("cloudProcessable", "userHeld") or not isinstance(record.get("payload"), dict):
        raise BundleError("revision has invalid mode or payload")
    parent_id = record.get("parentRevision")
    return {
        "mode": record["mode"],
        "expectedRevision": _resource_id(parent_id) if parent_id is not None else None,
        "payload": record["payload"],
    }


def export_conversation(client: AssetUploader, asset_id: str, head_id: str, destination: Path, *,
                        signing_private_key: bytes | None = None,
                        signer_device_id: str | None = None) -> dict[str, Any]:
    asset_id = _resource_id(asset_id)
    cursor = _resource_id(head_id)
    filenames: dict[str, bytes] = {}
    newest_first: list[str] = []
    total_bytes = 0
    while cursor is not None:
        if cursor in newest_first or len(newest_first) >= _MAX_REVISIONS:
            raise BundleError("revision chain has a cycle or exceeds the export limit")
        record = client.request("GET", _revision_path(asset_id, cursor))
        fields = _restore_fields(record, asset_id, cursor)
        content = canonical_json(record)
        total_bytes += len(content)
        if total_bytes > _MAX_CHAIN_BYTES:
            raise BundleError("revision chain exceeds the export size limit")
        filenames[f"revisions/{cursor}.json"] = content
        newest_first.append(cursor)
        cursor = fields["expectedRevision"]
    metadata = {"kind": _ARCHIVE_KIND, "assetId": asset_id, "revisionIds": list(reversed(newest_first))}
    return export_bundle(destination, files=filenames, metadata=metadata,
                         signing_private_key=signing_private_key,
                         signer_device_id=signer_device_id)["manifest"]


def restore_conversation(client: AssetUploader, source: Path, *,
                         verify_public_key: bytes | None = None) -> dict[str, Any]:
    bundle = import_bundle(source, verify_public_key=verify_public_key)
    metadata = bundle["manifest"].get("metadata")
    if not isinstance(metadata, dict) or metadata.get("kind") != _ARCHIVE_KIND:
        raise BundleError("archive does not contain a conversation revision chain")
    asset_id = _resource_id(metadata.get("assetId"))
    revision_ids = metadata.get("revisionIds")
    if not isinstance(revision_ids, list) or not 1 <= len(revision_ids) <= _MAX_REVISIONS:
        raise BundleError("invalid revision chain length")
    revision_ids = [_resource_id(revision_id) for revision_id in revision_ids]
    filenames = bundle["files"]
    if len(set(revision_ids)) != len(revision_ids) or set(filenames) != {
        f"revisions/{revision_id}.json" for revision_id in revision_ids
    }:
        raise BundleError("archive revision list differs from its members")

    plan = []
    for index, revision_id in enumerate(revision_ids):
        content = filenames[f"revisions/{revision_id}.json"]
        fields = _restore_fields(json.loads(content), asset_id, revision_id)
        parent = revision_ids[index - 1] if index else None
        if fields["expectedRevision"] != parent:
            raise BundleError("archive parent revisions are out of order")
        operation = hashlib.sha256(canonical_json([asset_id, revision_id, fields])).hexdigest()
        plan.append((revision_id, fields, "import-" + operation))

    for revision_id, fields, operation_id in plan:
        # Original keys are local to their auth domain. Deterministic import keys let
        # a partially completed import be retried in this destination.
        client.request("PUT", _revision_path(asset_id, revision_id), body=fields, operation_id=operation_id)
    return {"assetId": asset_id, "headRevision": revision_ids[-1], "revisionCount": len(revision_ids)}


def _key_file(path: Path | None) -> bytes | None:
    if path is None:
        return None
    with path.open("rb") as file:
        key = file.read(33)
    if len(key) != 32:
        raise BundleError("archive key must be a raw 32-byte file")
    return key


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", required=True)
    subcommands = parser.add_subparsers(dest="command", required=True)
    export = subcommands.add_parser("export")
    export.add_argument("asset_id")
    export.add_argument("head_revision")
    export.add_argument("destination", type=Path)
    export.add_argument("--archive-signing-key", type=Path)
    export.add_argument("--archive-signer-device-id")
    restore = subcommands.add_parser("restore")
    restore.add_argument("archive", type=Path)
    restore.add_argument("--archive-signer-public-key", type=Path)
    args = parser.parse_args(argv)
    try:
        client = AssetUploader(args.base_url, bearer=os.environ.get("XAGT_ASSET_BEARER"))
        if args.command == "export":
            if bool(args.archive_signing_key) != bool(args.archive_signer_device_id):
                raise BundleError("archive signing requires both the key and signer device ID")
            manifest = export_conversation(
                client, args.asset_id, args.head_revision, args.destination,
                signing_private_key=_key_file(args.archive_signing_key),
                signer_device_id=args.archive_signer_device_id,
            )
            result = {"assetId": args.asset_id, "headRevision": args.head_revision, "fileCount": len(manifest["files"])}
        else:
            result = restore_conversation(client, args.archive, verify_public_key=_key_file(args.archive_signer_public_key))
    except (ValueError, UploadError, OSError) as error:
        print(str(error), file=sys.stderr)
        return 2
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
