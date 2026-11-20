"""Portable ``xagt-conversation-assets/1`` export and import helpers."""

from __future__ import annotations

import base64
import hashlib
import json
import os
import stat
import zipfile
from pathlib import Path
from typing import Any, Mapping

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ed25519

from .crypto import CRYPTO_VERSION, CryptoError, canonical_json

BUNDLE_VERSION = "xagt-conversation-assets/1"
MAX_MANIFEST_BYTES = 16 * 1024 * 1024
MAX_MEMBER_BYTES = 512 * 1024 * 1024
MAX_TOTAL_BYTES = 512 * 1024 * 1024
MAX_PROVENANCE_BYTES = 64 * 1024


class BundleError(ValueError):
    """The portable package is malformed, unsafe or incomplete."""


def _b64(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).decode("ascii").rstrip("=")


def _unb64(value: Any, *, length: int) -> bytes:
    if not isinstance(value, str) or len(value) > 8192:
        raise BundleError("invalid base64 signature field")
    try:
        result = base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))
    except (ValueError, base64.binascii.Error) as exc:
        raise BundleError("invalid base64 signature field") from exc
    if len(result) != length:
        raise BundleError("invalid signature field length")
    return result


def _json(value: Any) -> bytes:
    try:
        return canonical_json(value)
    except CryptoError as exc:
        raise BundleError(str(exc)) from exc


def _safe_name(name: Any) -> str:
    if not isinstance(name, str) or not name or len(name) > 512:
        raise BundleError("invalid bundle member name")
    path = Path(name)
    if path.is_absolute() or name.startswith(("/", "\\")) or "\\" in name:
        raise BundleError("absolute or platform-specific bundle path")
    parts = name.split("/")
    if any(part in ("", ".", "..") for part in parts):
        raise BundleError("path traversal in bundle")
    return name


def _entries(manifest: Mapping[str, Any]) -> list[dict[str, Any]]:
    entries = manifest.get("files")
    if not isinstance(entries, list) or len(entries) > 100_000:
        raise BundleError("manifest files must be a bounded list")
    result: list[dict[str, Any]] = []
    seen: set[str] = set()
    for item in entries:
        if not isinstance(item, Mapping) or set(item) != {"path", "size", "sha256"}:
            raise BundleError("invalid manifest file entry")
        name = _safe_name(item["path"])
        if name in seen or name in {"manifest.json", "provenance/signature.json"}:
            raise BundleError("duplicate or reserved bundle path")
        seen.add(name)
        digest = item["sha256"]
        if (not isinstance(item["size"], int) or not 0 <= item["size"] <= MAX_MEMBER_BYTES
                or not isinstance(digest, str) or len(digest) != 64
                or any(char not in "0123456789abcdef" for char in digest)):
            raise BundleError("invalid manifest file metadata")
        result.append({"path": name, "size": item["size"], "sha256": digest})
    return result


def build_manifest(*, files: Mapping[str, bytes], metadata: Mapping[str, Any] | None = None) -> dict[str, Any]:
    if not isinstance(files, Mapping) or not files:
        raise BundleError("bundle requires at least one file")
    entries: list[dict[str, Any]] = []
    total = 0
    for raw_name, data in files.items():
        name = _safe_name(raw_name)
        if name in {"manifest.json", "provenance/signature.json"}:
            raise BundleError("reserved bundle path")
        if not isinstance(data, bytes) or len(data) > MAX_MEMBER_BYTES:
            raise BundleError("invalid bundle member")
        total += len(data)
        if total > MAX_TOTAL_BYTES:
            raise BundleError("bundle exceeds maximum size")
        entries.append({"path": name, "size": len(data), "sha256": hashlib.sha256(data).hexdigest()})
    entries.sort(key=lambda item: item["path"])
    manifest = {"schemaVersion": BUNDLE_VERSION, "cryptoVersion": CRYPTO_VERSION,
                "files": entries, "metadata": dict(metadata or {})}
    if len(_json(manifest)) > MAX_MANIFEST_BYTES:
        raise BundleError("manifest exceeds maximum size")
    return manifest


def _signature_payload(manifest: Mapping[str, Any]) -> bytes:
    return _json(manifest)


def export_bundle(destination: str | os.PathLike[str], *, files: Mapping[str, bytes],
                  metadata: Mapping[str, Any] | None = None,
                  signing_private_key: bytes | None = None,
                  signer_device_id: str | None = None) -> dict[str, Any]:
    manifest = build_manifest(files=files, metadata=metadata)
    signature: dict[str, Any] | None = None
    if signing_private_key is not None:
        if not isinstance(signing_private_key, bytes) or len(signing_private_key) != 32:
            raise BundleError("Ed25519 signing key must be 32 bytes")
        if not isinstance(signer_device_id, str) or not signer_device_id:
            raise BundleError("signer device id is required")
        private = ed25519.Ed25519PrivateKey.from_private_bytes(signing_private_key)
        public = private.public_key().public_bytes(serialization.Encoding.Raw,
                                                   serialization.PublicFormat.Raw)
        signature = {"version": "xagt-provenance/1", "signerDeviceId": signer_device_id,
                     "publicKey": _b64(public),
                     "signature": _b64(private.sign(_signature_payload(manifest)))}
    target = Path(destination)
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_name(f".{target.name}.{os.urandom(8).hex()}.partial")
    try:
        with zipfile.ZipFile(temporary, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
            archive.writestr("manifest.json", _json(manifest))
            for entry in manifest["files"]:
                archive.writestr(entry["path"], files[entry["path"]])
            if signature is not None:
                archive.writestr("provenance/signature.json", _json(signature))
        os.replace(temporary, target)
    except Exception:
        if temporary.exists():
            temporary.unlink()
        raise
    return {"manifest": manifest, "provenance": signature}


def _verify_signature(manifest: Mapping[str, Any], signature: Mapping[str, Any],
                     verify_public_key: bytes | None) -> None:
    if set(signature) != {"version", "signerDeviceId", "publicKey", "signature"}:
        raise BundleError("invalid provenance signature")
    if signature["version"] != "xagt-provenance/1" or not isinstance(signature["signerDeviceId"], str):
        raise BundleError("unsupported provenance signature")
    public = _unb64(signature["publicKey"], length=32)
    signed = _unb64(signature["signature"], length=64)
    if verify_public_key is not None:
        if not isinstance(verify_public_key, bytes) or len(verify_public_key) != 32 or public != verify_public_key:
            raise BundleError("bundle is signed by another key")
    try:
        ed25519.Ed25519PublicKey.from_public_bytes(public).verify(signed, _signature_payload(manifest))
    except InvalidSignature as exc:
        raise BundleError("provenance signature verification failed") from exc


def import_bundle(source: str | os.PathLike[str], *, verify_public_key: bytes | None = None,
                  require_signature: bool = False) -> dict[str, Any]:
    path = Path(source)
    if not path.is_file():
        raise BundleError("bundle does not exist")
    try:
        archive = zipfile.ZipFile(path, "r")
    except (OSError, zipfile.BadZipFile) as exc:
        raise BundleError("bundle is not a readable ZIP archive") from exc
    try:
        names = archive.namelist()
        if len(names) > 100_002 or len(set(names)) != len(names):
            raise BundleError("duplicate or excessive bundle entries")
        if "manifest.json" not in names:
            raise BundleError("manifest.json is missing")
        manifest_info = archive.getinfo("manifest.json")
        if manifest_info.is_dir() or manifest_info.file_size > MAX_MANIFEST_BYTES:
            raise BundleError("manifest exceeds maximum size")
        try:
            raw_manifest = archive.read(manifest_info)
        except (OSError, RuntimeError, KeyError, zipfile.BadZipFile) as exc:
            raise BundleError("manifest cannot be read") from exc
        try:
            manifest = json.loads(raw_manifest)
        except (ValueError, UnicodeDecodeError) as exc:
            raise BundleError("manifest is not valid JSON") from exc
        if not isinstance(manifest, Mapping) or manifest.get("schemaVersion") != BUNDLE_VERSION:
            raise BundleError("unsupported bundle schema")
        entries = _entries(manifest)
        expected = {"manifest.json", *(entry["path"] for entry in entries)}
        extras = set(names) - expected - {"provenance/signature.json"}
        if extras:
            raise BundleError("bundle contains unlisted members")
        total = 0
        files: dict[str, bytes] = {}
        for entry in entries:
            info = archive.getinfo(entry["path"])
            mode = (info.external_attr >> 16) & 0o170000
            if info.is_dir() or mode not in (0, stat.S_IFREG):
                raise BundleError("bundle member is not a regular file")
            if info.file_size != entry["size"] or info.file_size > MAX_MEMBER_BYTES:
                raise BundleError("bundle member size differs from manifest")
            total += info.file_size
            if total > MAX_TOTAL_BYTES:
                raise BundleError("bundle exceeds maximum size")
            try:
                data = archive.read(info)
            except (OSError, RuntimeError, KeyError, zipfile.BadZipFile) as exc:
                raise BundleError(f"bundle member cannot be read: {entry['path']}") from exc
            if hashlib.sha256(data).hexdigest() != entry["sha256"]:
                raise BundleError(f"bundle digest mismatch: {entry['path']}")
            files[entry["path"]] = data
        has_signature = "provenance/signature.json" in names
        if (require_signature or verify_public_key is not None) and not has_signature:
            raise BundleError("bundle signature is required")
        provenance = None
        if has_signature:
            try:
                provenance_info = archive.getinfo("provenance/signature.json")
                if provenance_info.is_dir() or provenance_info.file_size > MAX_PROVENANCE_BYTES:
                    raise BundleError("provenance signature is too large")
                provenance = json.loads(archive.read(provenance_info))
            except (OSError, RuntimeError, KeyError, zipfile.BadZipFile, ValueError, UnicodeDecodeError) as exc:
                if isinstance(exc, BundleError):
                    raise
                raise BundleError("invalid provenance signature JSON") from exc
            if not isinstance(provenance, Mapping):
                raise BundleError("invalid provenance signature")
            _verify_signature(manifest, provenance, verify_public_key)
        return {"manifest": dict(manifest), "files": files, "provenance": provenance}
    finally:
        archive.close()
