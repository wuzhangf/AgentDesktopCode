"""Bounded, resumable attachment transfer for conversation assets.

The client reserves an attachment, uploads raw object bytes to the returned
object-store target, and then seals the reference.  The journal is written
before network mutations and never contains plaintext for ``userHeld``.
"""

from __future__ import annotations

import argparse
import base64
import binascii
import hashlib
import json
import mimetypes
import os
import tempfile
import urllib.error
import urllib.request
import uuid
from pathlib import Path
from typing import Any, Callable, Mapping
from urllib.parse import urlsplit

from .collector import MAX_RESPONSE_BYTES, AssetUploader, CollectorError, Journal, UploadUncertain, _sha256, _utc_now

MAX_ATTACHMENT_BYTES = 64 * 1024 * 1024
DEFAULT_PART_BYTES = 8 * 1024 * 1024
MAX_NAME_BYTES = 255
MAX_PARTS = 4096
ATTACHMENT_OBJECT_KIND = "attachment"


class AttachmentError(ValueError):
    """The selected attachment or service contract is invalid."""


class AttachmentUncertain(AttachmentError):
    """A transfer may have committed and must be resumed or reconciled."""


def _b64(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).decode("ascii").rstrip("=")


def _unb64(value: Any, *, maximum: int) -> bytes:
    if not isinstance(value, str) or len(value) > maximum * 2:
        raise AttachmentError("invalid attachment base64")
    try:
        data = base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))
    except (ValueError, binascii.Error) as exc:
        raise AttachmentError("invalid attachment base64") from exc
    if len(data) > maximum:
        raise AttachmentError("attachment exceeds configured size")
    return data


def _id(value: str, *, label: str) -> str:
    if not isinstance(value, str) or not 1 <= len(value) <= 128 or any(
            char not in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_" for char in value):
        raise AttachmentError(f"invalid {label}")
    return value


def _operation_id(asset_id: str, revision_id: str, name: str, digest: str) -> str:
    seed = f"{asset_id}\0{revision_id}\0{name}\0{digest}".encode("utf-8")
    return "att-" + hashlib.sha256(seed).hexdigest()[:40]


def _crypto_revision(revision_id: str, attachment_id: str) -> str:
    return f"{revision_id}:{attachment_id}"


def _binding(asset_id: str, revision_id: str, attachment_id: str) -> dict[str, str]:
    return {"assetId": asset_id, "revisionId": revision_id,
            "attachmentId": attachment_id, "objectKind": ATTACHMENT_OBJECT_KIND}


def _source_bytes(source: str | os.PathLike[str], *, maximum: int) -> tuple[Path, bytes, str]:
    path = Path(source)
    try:
        resolved = path.resolve(strict=True)
    except OSError as exc:
        raise AttachmentError("attachment source cannot be opened") from exc
    if path.is_symlink() or not resolved.is_file():
        raise AttachmentError("attachment source must be a regular non-symlink file")
    try:
        size = resolved.stat().st_size
        data = resolved.read_bytes()
    except OSError as exc:
        raise AttachmentError("attachment source cannot be read") from exc
    if size > maximum or len(data) != size:
        raise AttachmentError("attachment exceeds configured size or changed while being read")
    return resolved, data, hashlib.sha256(data).hexdigest()


def _filename(path: Path) -> str:
    name = path.name
    if not name or any(char in name for char in "\r\n") or len(name.encode("utf-8")) > MAX_NAME_BYTES:
        raise AttachmentError("attachment name is invalid or too long")
    return name


def _validate_mode(mode: str) -> str:
    if mode not in {"cloudProcessable", "userHeld"}:
        raise AttachmentError("mode must be cloudProcessable or userHeld")
    return mode


def _atomic_stage(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".partial", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        try:
            os.chmod(temporary, 0o600)
        except OSError:
            pass
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


class AttachmentClient:
    """Attach, resume, verify and restore one explicitly selected file."""

    def __init__(self, base_url: str | AssetUploader, *, bearer: str | None = None,
                 opener: Callable[..., Any] | None = None, timeout: float = 30.0,
                 max_bytes: int = MAX_ATTACHMENT_BYTES):
        self.uploader = base_url if isinstance(base_url, AssetUploader) else AssetUploader(
            base_url, bearer=bearer, opener=opener, timeout=timeout)
        if not 1 <= max_bytes <= MAX_ATTACHMENT_BYTES:
            raise AttachmentError("invalid attachment size bound")
        self.max_bytes = max_bytes
        self.opener = opener or self.uploader.opener
        self.timeout = timeout

    @property
    def base_url(self) -> str:
        return self.uploader.base_url

    def _request_path(self, asset_id: str, revision_id: str) -> str:
        return f"conversations/{_id(asset_id, label='asset id')}/revisions/{_id(revision_id, label='revision id')}/attachments"

    def _raw(self, method: str, url_or_path: str, data: bytes | None = None, *,
             operation_id: str | None = None, extra_headers: Mapping[str, str] | None = None) -> tuple[int, bytes, Mapping[str, str]]:
        if url_or_path.startswith(("http://", "https://")):
            parsed = urlsplit(url_or_path)
            if parsed.username or parsed.password or parsed.fragment or parsed.scheme not in {"https", "http"}:
                raise AttachmentError("attachment upload URL is unsafe")
            if parsed.scheme == "http" and parsed.hostname not in {"localhost", "127.0.0.1", "::1"}:
                raise AttachmentError("attachment upload URL must use HTTPS")
            url = url_or_path
        else:
            url = f"{self.base_url}/{url_or_path.lstrip('/')}"
        headers = {"Accept": "*/*"}
        target, origin = urlsplit(url), urlsplit(self.base_url)
        if self.uploader.bearer and (target.scheme, target.netloc) == (origin.scheme, origin.netloc):
            headers["Authorization"] = f"Bearer {self.uploader.bearer}"
        if operation_id:
            headers["Idempotency-Key"] = operation_id
        if data is not None:
            headers["Content-Length"] = str(len(data))
            headers["Content-Type"] = "application/octet-stream"
        if extra_headers:
            for key, value in extra_headers.items():
                if not isinstance(key, str) or not isinstance(value, str):
                    raise AttachmentError("invalid upload header")
                headers[key] = value
        request = urllib.request.Request(url, data=data, method=method, headers=headers)
        try:
            response = self.opener.open(request, timeout=self.timeout) if hasattr(self.opener, "open") else self.opener(request, timeout=self.timeout)
            try:
                raw = response.read(MAX_RESPONSE_BYTES + 1)
            except TypeError:
                raw = response.read()
            status = int(getattr(response, "status", 200))
            response_headers = getattr(response, "headers", {})
        except urllib.error.HTTPError as exc:
            try:
                raw = exc.read(MAX_RESPONSE_BYTES + 1)
            except TypeError:
                raw = exc.read()
            status, response_headers = exc.code, exc.headers or {}
        except (OSError, TimeoutError) as exc:
            raise AttachmentUncertain("network result is unknown") from exc
        if not isinstance(raw, bytes):
            raw = bytes(raw)
        if len(raw) > MAX_RESPONSE_BYTES:
            raise AttachmentError("attachment service response exceeds limit")
        if status >= 500:
            raise AttachmentUncertain(f"attachment service returned {status}")
        if status >= 400:
            try:
                detail = json.loads(raw.decode("utf-8")) if raw else {}
            except (UnicodeDecodeError, json.JSONDecodeError):
                detail = {}
            code = detail.get("code") if isinstance(detail, Mapping) else None
            raise AttachmentError(str(code or f"HTTP_{status}"))
        return status, raw, response_headers

    def _metadata(self, asset_id: str, revision_id: str, attachment_id: str) -> dict[str, Any]:
        path = self._request_path(asset_id, revision_id)
        result = self.uploader.request("GET", path)
        if not isinstance(result, Mapping) or not isinstance(result.get("items"), list):
            raise AttachmentError("attachment list is not an object")
        for item in result["items"]:
            if isinstance(item, Mapping) and item.get("attachmentId") == attachment_id:
                return {**dict(item), "assetId": asset_id, "revisionId": revision_id}
        raise AttachmentError("attachment not found")

    def _stage_path(self, journal: Journal, operation_id: str) -> Path:
        return journal.directory / "attachments" / f"{operation_id}.bin"

    def _prepare(self, data: bytes, *, asset_id: str, revision_id: str, attachment_id: str,
                 mode: str, recipient_public_key: bytes | None, signer_private_key: bytes | None,
                 recipient_device_id: str | None, signer_device_id: str | None,
                 grant_id: str | None) -> tuple[bytes, dict[str, Any]]:
        if mode == "cloudProcessable":
            return data, {"objectKind": ATTACHMENT_OBJECT_KIND, "crypto": None}
        if not all(isinstance(item, bytes) and len(item) == 32 for item in (recipient_public_key, signer_private_key)):
            raise AttachmentError("userHeld requires raw 32-byte recipient and signer keys")
        if not isinstance(recipient_device_id, str) or not recipient_device_id:
            raise AttachmentError("userHeld requires recipient device id")
        if not isinstance(signer_device_id, str) or not signer_device_id:
            raise AttachmentError("userHeld requires signer device id")
        from .crypto import encrypt_object, seal_content_key, validate_user_held_envelope
        encrypted, content_key = encrypt_object(
            data, asset_id=asset_id, revision_id=_crypto_revision(revision_id, attachment_id),
            object_kind=ATTACHMENT_OBJECT_KIND, mode="userHeld")
        envelope = seal_content_key(
            content_key, recipient_public_key=recipient_public_key,
            binding=_binding(asset_id, revision_id, attachment_id), grant_id=grant_id or str(uuid.uuid4()),
            revision=revision_id, recipient_device_id=recipient_device_id,
            signer_device_id=signer_device_id, signer_private_key=signer_private_key)
        validate_user_held_envelope(envelope)
        # The standalone service validates and stores the complete opaque
        # object as the user-held attachment body.  It never receives the
        # plaintext; the envelope is repeated in metadata for authorization.
        payload = {"object": encrypted, "envelope": envelope}
        return json.dumps(payload, ensure_ascii=False, sort_keys=True,
                          separators=(",", ":")).encode("utf-8"), {
                              "objectKind": ATTACHMENT_OBJECT_KIND,
                              "crypto": {"object": encrypted, "envelope": envelope}}

    def _init(self, asset_id: str, revision_id: str, metadata: Mapping[str, Any], operation_id: str) -> dict[str, Any]:
        result = self.uploader.request("POST", self._request_path(asset_id, revision_id),
                                       body=metadata, operation_id=f"{operation_id}-init")
        if not isinstance(result, dict):
            raise AttachmentError("attachment reservation is not an object")
        returned = result.get("attachmentId")
        if returned is not None and returned != metadata.get("attachmentId"):
            raise AttachmentError("attachment service changed the stable attachment id")
        return result

    def _upload(self, init: Mapping[str, Any], stage: Path, *, operation_id: str,
                prior_parts: list[dict[str, Any]] | None = None) -> list[dict[str, Any]]:
        try:
            size = stage.stat().st_size
        except OSError as exc:
            raise AttachmentError("durable attachment staging file is missing") from exc
        if size > self.max_bytes + 32:
            raise AttachmentError("staged attachment exceeds configured size")
        targets = init.get("parts")
        parts: list[dict[str, Any]] = []
        if isinstance(targets, list):
            if not targets or len(targets) > MAX_PARTS:
                raise AttachmentError("invalid attachment part list")
            for target in targets:
                if not isinstance(target, Mapping) or not isinstance(target.get("partNumber"), int):
                    raise AttachmentError("invalid attachment part target")
                parts.append(dict(target))
        else:
            path = init.get("uploadUrl") or init.get("uploadPath")
            if not isinstance(path, str) or not path:
                path = str(init.get("attachmentPath") or "")
            if not path:
                # Current standalone contract uses the revision/attachment
                # endpoint itself as the object upload target.
                path = f"conversations/{init['assetId']}/revisions/{init['revisionId']}/attachments/{init['attachmentId']}"
            parts = [{"partNumber": 1, "uploadUrl": path}]
        completed: list[dict[str, Any]] = []
        prior = {int(item["partNumber"]): item for item in (prior_parts or [])
                 if isinstance(item, Mapping) and isinstance(item.get("partNumber"), int)}
        with stage.open("rb") as handle:
            offset = 0
            for target in parts:
                number = int(target["partNumber"])
                expected_bytes = target.get("bytes")
                if isinstance(expected_bytes, int):
                    length = expected_bytes
                elif len(parts) == 1:
                    length = size
                else:
                    part_size = int(init.get("partSize") or DEFAULT_PART_BYTES)
                    if not 1 <= part_size <= MAX_ATTACHMENT_BYTES:
                        raise AttachmentError("invalid attachment part size")
                    length = min(part_size, size - offset)
                if length < 0 or offset + length > size:
                    raise AttachmentError("attachment part sizes do not match object size")
                data = handle.read(length)
                if len(data) != length:
                    raise AttachmentError("staged attachment ended unexpectedly")
                digest = hashlib.sha256(data).hexdigest()
                old = prior.get(number)
                if old and old.get("sha256") == digest and old.get("bytes") == length:
                    completed.append(dict(old))
                    offset += length
                    continue
                target_url = target.get("uploadUrl") or target.get("uploadPath")
                if not isinstance(target_url, str) or not target_url:
                    raise AttachmentError("attachment part upload target is missing")
                if "{partNumber}" in target_url:
                    target_url = target_url.format(partNumber=number)
                _, response, headers = self._raw(
                    "PUT", target_url, data, operation_id=f"{operation_id}-part-{number}",
                    extra_headers=target.get("headers") if isinstance(target.get("headers"), Mapping)
                    else {"X-Content-SHA256": digest})
                etag = headers.get("ETag") if hasattr(headers, "get") else None
                if not etag and response:
                    try:
                        parsed = json.loads(response.decode("utf-8"))
                        etag = parsed.get("etag") if isinstance(parsed, Mapping) else None
                    except (UnicodeDecodeError, json.JSONDecodeError):
                        pass
                completed.append({"partNumber": number, "bytes": length, "sha256": digest,
                                  **({"etag": etag} if etag else {})})
                offset += length
        if offset != size:
            raise AttachmentError("attachment parts do not cover the staged object")
        return completed

    def _complete(self, asset_id: str, revision_id: str, attachment_id: str,
                  operation_id: str, metadata: Mapping[str, Any], parts: list[dict[str, Any]]) -> dict[str, Any]:
        path = self._request_path(asset_id, revision_id) + f"/{attachment_id}/commit"
        return self.uploader.request("POST", path, operation_id=f"{operation_id}-complete")

    def attach(self, source: str | os.PathLike[str], *, asset_id: str, revision_id: str,
               mode: str, journal: Journal, attachment_id: str | None = None,
               operation_id: str | None = None, recipient_public_key: bytes | None = None,
               signer_private_key: bytes | None = None, recipient_device_id: str | None = None,
               signer_device_id: str | None = None, grant_id: str | None = None) -> dict[str, Any]:
        """Attach a selected file to exactly ``revision_id``.

        The source is opened read-only and never replaced, renamed or deleted.
        The journal owns a mode-appropriate staging copy for safe retry.
        """
        resolved, plain, _ = _source_bytes(source, maximum=self.max_bytes)
        return self.attach_bytes(
            plain, name=_filename(resolved), asset_id=asset_id, revision_id=revision_id,
            mode=mode, journal=journal, attachment_id=attachment_id, operation_id=operation_id,
            recipient_public_key=recipient_public_key, signer_private_key=signer_private_key,
            recipient_device_id=recipient_device_id, signer_device_id=signer_device_id, grant_id=grant_id)

    def attach_bytes(self, plain: bytes, *, name: str, asset_id: str, revision_id: str,
                     mode: str, journal: Journal, attachment_id: str | None = None,
                     operation_id: str | None = None, content_type: str | None = None,
                     recipient_public_key: bytes | None = None, signer_private_key: bytes | None = None,
                     recipient_device_id: str | None = None, signer_device_id: str | None = None,
                     grant_id: str | None = None) -> dict[str, Any]:
        """Journal captured bytes; a repeat recovers the first sealed representation."""
        asset_id, revision_id = _id(asset_id, label="asset id"), _id(revision_id, label="revision id")
        mode = _validate_mode(mode)
        if not isinstance(journal, Journal):
            raise AttachmentError("a Journal is required")
        if not isinstance(plain, bytes) or len(plain) > self.max_bytes:
            raise AttachmentError("invalid attachment bytes or size")
        if not isinstance(name, str) or not name.strip() or len(name) > 240 or any(
                char in name for char in ("/", "\\", "\x00", "\r", "\n")):
            raise AttachmentError("attachment name is invalid")
        content_type = content_type or mimetypes.guess_type(name)[0] or "application/octet-stream"
        plain_sha = _sha256(plain)
        attachment_id = attachment_id or "att-" + hashlib.sha256(
            f"{asset_id}\0{revision_id}\0{name}\0{plain_sha}".encode("utf-8")).hexdigest()[:40]
        attachment_id = _id(attachment_id, label="attachment id")
        operation_id = operation_id or _operation_id(asset_id, revision_id, name, plain_sha)
        operation_id = _id(operation_id, label="operation id")
        prior = journal.load(operation_id)
        if prior is not None:
            expected = {"attachmentId": attachment_id, "assetId": asset_id, "revisionId": revision_id,
                        "mode": mode, "name": name, "plainSha256": plain_sha, "contentType": content_type}
            metadata = prior.get("metadata")
            if (prior.get("destination") != self.base_url or not isinstance(metadata, Mapping)
                    or any(metadata.get(key) != value for key, value in expected.items())):
                raise AttachmentError("operation id is already bound to another attachment")
            if mode == "userHeld":
                envelope = (metadata.get("crypto") or {}).get("envelope") or {}
                if (recipient_public_key is None
                        or envelope.get("recipientKeyFingerprint") != _sha256(recipient_public_key)
                        or envelope.get("recipientDeviceId") != recipient_device_id):
                    raise AttachmentError("attachment operation is bound to another recipient")
            return self.retry(operation_id, journal=journal)

        staged, crypto = self._prepare(
            plain, asset_id=asset_id, revision_id=revision_id, attachment_id=attachment_id,
            mode=mode, recipient_public_key=recipient_public_key, signer_private_key=signer_private_key,
            recipient_device_id=recipient_device_id, signer_device_id=signer_device_id, grant_id=grant_id)
        if len(staged) > self.max_bytes:
            raise AttachmentError("encrypted attachment exceeds configured size")
        stage = self._stage_path(journal, operation_id)
        _atomic_stage(stage, staged)
        metadata: dict[str, Any] = {
            "attachmentId": attachment_id, "mode": mode, "name": name,
            "contentType": content_type,
            "assetId": asset_id, "revisionId": revision_id, "objectKind": ATTACHMENT_OBJECT_KIND,
            "plainBytes": len(plain), "plainSha256": plain_sha,
            "cipherBytes": len(staged), "cipherSha256": _sha256(staged),
            "crypto": crypto.get("crypto"),
        }
        request_metadata = {
            "attachmentId": attachment_id, "mode": mode,
            "contentType": "application/octet-stream" if mode == "userHeld" else content_type,
            "expectedBytes": len(staged),
            "sha256": metadata["cipherSha256"],
            **({"envelope": metadata["crypto"]["envelope"]}
               if mode == "userHeld" and isinstance(metadata.get("crypto"), Mapping) else {}),
        }
        entry: dict[str, Any] = {
            "operationId": operation_id, "destination": self.base_url, "state": "reserving",
            "assetId": asset_id, "revisionId": revision_id, "attachmentId": attachment_id,
            "metadata": metadata, "requestMetadata": request_metadata, "stagePath": str(stage),
            "createdAt": _utc_now(),
        }
        journal.save(operation_id, entry)
        return self.retry(operation_id, journal=journal)

    def retry(self, operation_id: str, *, journal: Journal) -> dict[str, Any]:
        operation_id = _id(operation_id, label="operation id")
        entry = journal.load(operation_id)
        if not isinstance(entry, dict) or entry.get("destination") != self.base_url:
            raise AttachmentError("operation is missing from this asset service journal")
        if entry.get("state") == "committed" and isinstance(entry.get("result"), dict):
            return dict(entry["result"])
        metadata, request_metadata, reservation = entry.get("metadata"), entry.get("requestMetadata"), entry.get("reservation")
        stage = Path(str(entry.get("stagePath") or self._stage_path(journal, operation_id)))
        if not isinstance(metadata, Mapping) or not isinstance(request_metadata, Mapping) or not stage.is_file():
            raise AttachmentError("durable attachment staging record is missing")
        try:
            if not isinstance(reservation, Mapping):
                reservation = self._init(str(entry["assetId"]), str(entry["revisionId"]), request_metadata, operation_id)
                entry["reservation"], entry["state"] = dict(reservation), "uploading"
                journal.save(operation_id, entry)
            parts = self._upload(reservation, stage, operation_id=operation_id,
                                 prior_parts=entry.get("parts") if isinstance(entry.get("parts"), list) else None)
            entry["parts"], entry["state"] = parts, "sealing"
            journal.save(operation_id, entry)
            result = self._complete(str(entry["assetId"]), str(entry["revisionId"]), str(entry["attachmentId"]), operation_id, metadata, parts)
        except (AttachmentUncertain, UploadUncertain) as exc:
            journal.save(operation_id, {**entry, "state": "reconciling"})
            raise AttachmentUncertain(str(exc)) from exc
        entry.pop("stagePath", None)
        entry["state"], entry["result"], entry["completedAt"] = "committed", result, _utc_now()
        journal.save(operation_id, entry)
        try:
            stage.unlink()
        except OSError:
            pass
        return result

    def _download_bytes(self, metadata: Mapping[str, Any]) -> bytes:
        target = metadata.get("downloadUrl") or metadata.get("downloadPath") or metadata.get("contentPath")
        if not isinstance(target, str) or not target:
            attachment_id = _id(str(metadata.get("attachmentId")), label="attachment id")
            target = self._request_path(str(metadata["assetId"]), str(metadata["revisionId"])) + f"/{attachment_id}"
        _, raw, _ = self._raw("GET", target)
        if len(raw) > self.max_bytes + 32:
            raise AttachmentError("download exceeds configured size")
        if metadata.get("expectedBytes") != len(raw) or metadata.get("sha256") != hashlib.sha256(raw).hexdigest():
            raise AttachmentError("attachment digest or size differs from its metadata")
        return raw

    def _restore_bytes(self, metadata: Mapping[str, Any], *, recipient_private_key: bytes | None,
                       signer_public_key: bytes | None) -> bytes:
        mode = _validate_mode(str(metadata.get("mode")))
        raw = self._download_bytes(metadata)
        if mode == "cloudProcessable":
            return raw
        try:
            payload = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise AttachmentError("userHeld attachment is not an encrypted payload") from exc
        if not isinstance(payload, Mapping) or set(payload) != {"object", "envelope"}:
            raise AttachmentError("userHeld attachment payload is invalid")
        if metadata.get("envelope") is not None and metadata.get("envelope") != payload["envelope"]:
            raise AttachmentError("userHeld attachment envelope differs from its metadata")
        if not isinstance(recipient_private_key, bytes) or len(recipient_private_key) != 32:
            raise AttachmentError("userHeld restore requires recipient private key")
        if not isinstance(signer_public_key, bytes) or len(signer_public_key) != 32:
            raise AttachmentError("userHeld restore requires trusted signer public key")
        from .crypto import decrypt_object, unseal_content_key, validate_user_held_envelope
        envelope = validate_user_held_envelope(payload["envelope"])
        key = unseal_content_key(
            envelope, recipient_private_key=recipient_private_key,
            binding=_binding(str(metadata["assetId"]), str(metadata["revisionId"]), str(metadata["attachmentId"])),
            signer_public_key=signer_public_key)
        return decrypt_object(
            payload["object"], asset_id=str(metadata["assetId"]),
            revision_id=_crypto_revision(str(metadata["revisionId"]), str(metadata["attachmentId"])),
            object_kind=ATTACHMENT_OBJECT_KIND, mode="userHeld", key=key)

    def check(self, *, asset_id: str, revision_id: str, attachment_id: str,
              recipient_private_key: bytes | None = None,
              signer_public_key: bytes | None = None) -> dict[str, Any]:
        metadata = self._metadata(asset_id, revision_id, attachment_id)
        data = self._restore_bytes(metadata, recipient_private_key=recipient_private_key,
                                   signer_public_key=signer_public_key)
        digest = hashlib.sha256(data).hexdigest()
        expected_digest = metadata.get("plainSha256") or (metadata.get("sha256") if metadata.get("mode") == "cloudProcessable" else None)
        expected_bytes = metadata.get("plainBytes") or (metadata.get("expectedBytes") if metadata.get("mode") == "cloudProcessable" else None)
        if (expected_digest is not None and digest != expected_digest) or (expected_bytes is not None and len(data) != expected_bytes):
            raise AttachmentError("attachment plaintext verification failed")
        return {"attachmentId": attachment_id, "assetId": asset_id, "revisionId": revision_id,
                "mode": metadata.get("mode"), "bytes": len(data), "sha256": digest, "verified": True}

    def restore(self, *, asset_id: str, revision_id: str, attachment_id: str,
                destination: str | os.PathLike[str], recipient_private_key: bytes | None = None,
                signer_public_key: bytes | None = None) -> dict[str, Any]:
        metadata = self._metadata(asset_id, revision_id, attachment_id)
        data = self._restore_bytes(metadata, recipient_private_key=recipient_private_key,
                                   signer_public_key=signer_public_key)
        digest = hashlib.sha256(data).hexdigest()
        expected_digest = metadata.get("plainSha256") or (metadata.get("sha256") if metadata.get("mode") == "cloudProcessable" else None)
        expected_bytes = metadata.get("plainBytes") or (metadata.get("expectedBytes") if metadata.get("mode") == "cloudProcessable" else None)
        if (expected_digest is not None and digest != expected_digest) or (expected_bytes is not None and len(data) != expected_bytes):
            raise AttachmentError("attachment plaintext verification failed")
        target = Path(destination)
        target.parent.mkdir(parents=True, exist_ok=True)
        fd, temporary = tempfile.mkstemp(prefix=f".{target.name}.", suffix=".partial", dir=target.parent)
        try:
            with os.fdopen(fd, "wb") as handle:
                handle.write(data)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary, target)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)
        return {"attachmentId": attachment_id, "destination": str(target),
                "bytes": len(data), "sha256": digest, "verified": True}


def _read_key(path: str | None, *, label: str) -> bytes | None:
    if not path:
        return None
    try:
        value = Path(path).read_bytes()
    except OSError as exc:
        raise AttachmentError(f"unable to read {label}") from exc
    if len(value) != 32:
        raise AttachmentError(f"{label} must contain exactly 32 raw bytes")
    return value


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Read-only xagt.link conversation attachment client")
    sub = parser.add_subparsers(dest="command", required=True)
    attach = sub.add_parser("attach", help="attach one selected file to an exact revision")
    attach.add_argument("source")
    attach.add_argument("--asset-id", required=True)
    attach.add_argument("--revision-id", required=True)
    attach.add_argument("--base-url", required=True)
    attach.add_argument("--journal", required=True)
    attach.add_argument("--mode", choices=("cloudProcessable", "userHeld"), required=True)
    attach.add_argument("--recipient-public-key")
    attach.add_argument("--signer-private-key")
    attach.add_argument("--recipient-device-id")
    attach.add_argument("--signer-device-id")
    attach.add_argument("--grant-id")
    attach.add_argument("--attachment-id")
    attach.add_argument("--operation-id")
    attach.add_argument("--bearer", default=os.environ.get("XAGT_ASSET_BEARER"))
    retry = sub.add_parser("retry", help="resume a journaled attachment")
    retry.add_argument("operation_id")
    retry.add_argument("--base-url", required=True)
    retry.add_argument("--journal", required=True)
    retry.add_argument("--bearer", default=os.environ.get("XAGT_ASSET_BEARER"))
    for command in ("check", "restore"):
        item = sub.add_parser(command)
        item.add_argument("--asset-id", required=True)
        item.add_argument("--revision-id", required=True)
        item.add_argument("--attachment-id", required=True)
        item.add_argument("--base-url", required=True)
        item.add_argument("--recipient-private-key")
        item.add_argument("--signer-public-key")
        item.add_argument("--bearer", default=os.environ.get("XAGT_ASSET_BEARER"))
    sub.choices["restore"].add_argument("--destination", required=True)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    try:
        client = AttachmentClient(args.base_url, bearer=args.bearer)
        if args.command == "attach":
            result = client.attach(
                args.source, asset_id=args.asset_id, revision_id=args.revision_id,
                mode=args.mode, journal=Journal(args.journal), attachment_id=args.attachment_id,
                operation_id=args.operation_id,
                recipient_public_key=_read_key(args.recipient_public_key, label="recipient public key"),
                signer_private_key=_read_key(args.signer_private_key, label="signer private key"),
                recipient_device_id=args.recipient_device_id, signer_device_id=args.signer_device_id,
                grant_id=args.grant_id)
        elif args.command == "retry":
            result = client.retry(args.operation_id, journal=Journal(args.journal))
        elif args.command == "check":
            result = client.check(
                asset_id=args.asset_id, revision_id=args.revision_id, attachment_id=args.attachment_id,
                recipient_private_key=_read_key(args.recipient_private_key, label="recipient private key"),
                signer_public_key=_read_key(args.signer_public_key, label="trusted signer public key"))
        else:
            result = client.restore(
                asset_id=args.asset_id, revision_id=args.revision_id, attachment_id=args.attachment_id,
                destination=args.destination,
                recipient_private_key=_read_key(args.recipient_private_key, label="recipient private key"),
                signer_public_key=_read_key(args.signer_public_key, label="trusted signer public key"))
        print(json.dumps(result, ensure_ascii=False, sort_keys=True))
        return 0
    except (AttachmentError, CollectorError) as exc:
        print(json.dumps({"error": str(exc)}, ensure_ascii=False), file=os.sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
