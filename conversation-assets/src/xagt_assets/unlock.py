"""Offline, read-only unlocking of portable conversation asset archives.

The command consumes a bundle and key files from local disk.  It never sends
plaintext to a service. Successful output is written to the
explicit destination and the CLI prints only a bounded JSON summary.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Any, Mapping

from .bundle import BundleError, import_bundle
from .crypto import (
    CryptoError,
    canonical_json,
    decrypt_object,
    unseal_content_key,
)


class UnlockError(ValueError):
    """The archive or the supplied offline key material cannot be used."""


def _key_file(path: str | os.PathLike[str], *, label: str) -> bytes:
    candidate = Path(path)
    try:
        if not candidate.is_file() or candidate.stat().st_size != 32:
            raise UnlockError(f"{label} must be an existing 32-byte file")
        value = candidate.read_bytes()
    except OSError as exc:
        raise UnlockError(f"unable to read {label}") from exc
    if len(value) != 32:
        raise UnlockError(f"{label} must be exactly 32 bytes")
    return value


def _json_file(path: str, data: bytes) -> Any:
    try:
        return json.loads(data.decode("utf-8"))
    except (UnicodeDecodeError, ValueError) as exc:
        raise UnlockError(f"revision file is not valid JSON: {path}") from exc


def _find_revision(files: Mapping[str, bytes], asset_id: str, revision_id: str) -> tuple[str, Mapping[str, Any]]:
    # portability.export_conversation deliberately emits this one canonical
    # name.  Do not search by suffix: accepting a second archive member would
    # make the selected identity ambiguous.
    name = f"revisions/{revision_id}.json"
    if name not in files:
        raise UnlockError("portable archive does not contain one selected revision")
    data = files[name]
    value = _json_file(name, data)
    if not isinstance(value, Mapping):
        raise UnlockError("revision JSON must be an object")
    if value.get("assetId") != asset_id or value.get("revisionId") != revision_id:
        raise UnlockError("revision identity does not match the selected asset")
    return name, value


def _payload(value: Mapping[str, Any]) -> tuple[str, Any, Mapping[str, Any] | None]:
    mode = value.get("mode")
    payload = value.get("payload")
    if mode not in {"cloudProcessable", "userHeld"}:
        raise UnlockError("revision does not declare a supported encryption mode")
    if mode == "cloudProcessable":
        # portability exports the server's already-opened cloud payload.  It
        # can be any JSON value, so keep it opaque until canonical serialization.
        return mode, payload, None
    if not isinstance(payload, Mapping):
        raise UnlockError("user-held revision payload must be an object")
    if set(payload) != {"object", "envelope"}:
        raise UnlockError("user-held revision payload fields are invalid")
    encrypted = payload["object"]
    envelope = payload["envelope"]
    if not isinstance(encrypted, Mapping):
        raise UnlockError("revision does not contain an encrypted object")
    if not isinstance(envelope, Mapping):
        raise UnlockError("revision envelope is malformed")
    return mode, encrypted, envelope


def _write_new(destination: str | os.PathLike[str], data: bytes) -> None:
    target = Path(destination)
    if target.exists() and target.is_dir():
        raise UnlockError("destination is a directory")
    parent = target.parent
    try:
        parent.mkdir(parents=True, exist_ok=True)
        if target.exists():
            raise UnlockError("destination already exists")
        # O_EXCL makes an explicit destination a one-shot write.  A partial
        # output is removed on failure and an existing file is never replaced.
        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
        descriptor = os.open(target, flags, 0o600)
        try:
            with os.fdopen(descriptor, "wb") as stream:
                descriptor = -1
                stream.write(data)
                stream.flush()
                os.fsync(stream.fileno())
        except Exception:
            if descriptor != -1:
                os.close(descriptor)
            try:
                target.unlink()
            except OSError:
                pass
            raise
    except UnlockError:
        raise
    except OSError as exc:
        raise UnlockError("unable to write destination") from exc


def read_revision_bytes(bundle_path: str | os.PathLike[str], *, asset_id: str,
                        revision_id: str, recipient_private_key_path: str | os.PathLike[str] | None,
                        signer_public_key_path: str | os.PathLike[str] | None,
                        archive_signer_public_key_path: str | os.PathLike[str] | None = None
                        ) -> tuple[bytes, dict[str, Any]]:
    """Verify and open one revision without writing a plaintext file."""
    archive_signer_public = (
        _key_file(archive_signer_public_key_path, label="archive signer public key")
        if archive_signer_public_key_path is not None else None
    )
    try:
        archive = import_bundle(bundle_path, verify_public_key=archive_signer_public,
                                require_signature=archive_signer_public is not None)
    except BundleError as exc:
        raise UnlockError(f"archive verification failed: {exc}") from exc
    revision_path, revision = _find_revision(archive["files"], asset_id, revision_id)
    mode, encrypted, envelope = _payload(revision)
    object_kind = "conversation"
    binding = {"assetId": asset_id, "revisionId": revision_id, "objectKind": object_kind}
    try:
        if mode == "userHeld":
            if recipient_private_key_path is None or envelope is None or signer_public_key_path is None:
                raise UnlockError("user-held revision requires recipient key and envelope")
            recipient_private = _key_file(recipient_private_key_path, label="recipient private key")
            signer_public = _key_file(signer_public_key_path, label="envelope signer public key")
            signer_device_id = envelope.get("signerDeviceId")
            if not isinstance(signer_device_id, str) or not signer_device_id:
                raise UnlockError("user-held envelope has no signer device")
            if envelope.get("revision") != revision_id:
                raise UnlockError("user-held envelope revision does not match the selected revision")
            content_key = unseal_content_key(
                envelope, recipient_private_key=recipient_private, binding=binding,
                signer_public_key=signer_public)
            plaintext = decrypt_object(encrypted, asset_id=asset_id,
                                       revision_id=revision_id, object_kind=object_kind,
                                       mode="userHeld", key=content_key)
        else:
            plaintext = canonical_json(encrypted)
    except (CryptoError, KeyError, TypeError) as exc:
        raise UnlockError("offline decryption failed") from exc
    return plaintext, {"assetId": asset_id, "revisionId": revision_id, "mode": mode,
                       "revisionPath": revision_path, "bytes": len(plaintext)}


def unlock_revision(bundle_path: str | os.PathLike[str], *, asset_id: str,
                    revision_id: str, recipient_private_key_path: str | os.PathLike[str] | None,
                    signer_public_key_path: str | os.PathLike[str] | None,
                    destination: str | os.PathLike[str],
                    archive_signer_public_key_path: str | os.PathLike[str] | None = None) -> dict[str, Any]:
    """Verify and decrypt one revision to a new file."""
    plaintext, summary = read_revision_bytes(
        bundle_path, asset_id=asset_id, revision_id=revision_id,
        recipient_private_key_path=recipient_private_key_path,
        signer_public_key_path=signer_public_key_path,
        archive_signer_public_key_path=archive_signer_public_key_path)
    _write_new(destination, plaintext)
    return {**summary, "destination": str(Path(destination).resolve())}


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Read one verified xagt asset revision offline")
    parser.add_argument("bundle")
    parser.add_argument("--asset-id", required=True)
    parser.add_argument("--revision-id", required=True)
    parser.add_argument("--signer-public-key", help="trusted envelope signer key for userHeld")
    parser.add_argument("--archive-signer-public-key", help="optional archive provenance trust anchor")
    parser.add_argument("--recipient-private-key")
    parser.add_argument("--destination", required=True)
    return parser


def main(argv: list[str] | None = None) -> int:
    try:
        args = _parser().parse_args(argv)
        summary = unlock_revision(
            args.bundle, asset_id=args.asset_id, revision_id=args.revision_id,
            recipient_private_key_path=args.recipient_private_key,
            signer_public_key_path=args.signer_public_key,
            destination=args.destination,
            archive_signer_public_key_path=args.archive_signer_public_key,
        )
    except UnlockError as exc:
        print(json.dumps({"code": "UNLOCK_FAILED", "message": str(exc)}, ensure_ascii=False))
        return 2
    print(json.dumps({"code": "UNLOCKED", **summary}, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
