"""Small, deterministic object-store adapters used by conversation assets.

The Hosted service only needs four operations.  Keeping that surface narrow
lets self-hosted installations use RustFS/MinIO/AWS S3 while contract tests
use the in-memory implementation.  Writes are compare-and-set: a retry is
successful only when the existing object has the same digest.
"""

from __future__ import annotations

import hashlib
import secrets
from dataclasses import dataclass
from typing import Protocol


class ObjectStoreError(RuntimeError):
    """The configured object store could not complete an operation."""


class ObjectNotFound(ObjectStoreError, FileNotFoundError):
    """An object key does not exist."""


class ObjectConflict(ObjectStoreError):
    """A compare-and-set write found a different immutable object."""


@dataclass(frozen=True)
class ObjectMetadata:
    key: str
    size: int
    sha256: str
    content_type: str


class ObjectStore(Protocol):
    def put(self, key: str, data: bytes, *, content_type: str) -> ObjectMetadata: ...
    def head(self, key: str) -> ObjectMetadata: ...
    def get(self, key: str) -> tuple[bytes, ObjectMetadata]: ...
    def delete(self, key: str) -> None: ...


class InMemoryObjectStore:
    """A CAS object store for tests and offline development."""

    def __init__(self) -> None:
        self._items: dict[str, tuple[bytes, ObjectMetadata]] = {}

    def put(self, key: str, data: bytes, *, content_type: str) -> ObjectMetadata:
        if not isinstance(data, bytes):
            raise TypeError("object data must be bytes")
        digest = hashlib.sha256(data).hexdigest()
        existing = self._items.get(key)
        if existing is not None:
            if existing[1].sha256 == digest and existing[1].size == len(data):
                return existing[1]
            raise ObjectConflict("immutable object key already contains different bytes")
        metadata = ObjectMetadata(key, len(data), digest, content_type)
        self._items[key] = (bytes(data), metadata)
        return metadata

    def head(self, key: str) -> ObjectMetadata:
        try:
            return self._items[key][1]
        except KeyError as exc:
            raise ObjectNotFound("object not found") from exc

    def get(self, key: str) -> tuple[bytes, ObjectMetadata]:
        try:
            data, metadata = self._items[key]
        except KeyError as exc:
            raise ObjectNotFound("object not found") from exc
        return bytes(data), metadata

    def delete(self, key: str) -> None:
        self._items.pop(key, None)


class S3ObjectStore:
    """S3-compatible HTTP adapter with AWS Signature Version 4.

    The S3 signing implementation is delegated to botocore, including its
    canonicalization and endpoint handling.  Install the package's ``s3``
    extra to enable this adapter.  Path-style addressing works with AWS S3,
    MinIO and RustFS; credentials are never serialized into asset rows.
    """

    def __init__(self, endpoint: str, bucket: str, access_key: str,
                 secret_key: str, *, region: str = "us-east-1",
                 session_token: str | None = None, timeout: float = 30.0,
                 retries: int = 3) -> None:
        try:
            import botocore.session
            from botocore.client import Config
        except ImportError as exc:  # pragma: no cover - optional extra
            raise RuntimeError("install xagt-conversation-assets[s3] for S3 support") from exc
        if not bucket or "/" in bucket or any(not isinstance(value, str) or not value
                                               for value in (access_key, secret_key, region)):
            raise ValueError("S3 bucket and credentials are required")
        self.endpoint = endpoint.rstrip("/")
        self.bucket = bucket
        self.access_key = access_key
        self.secret_key = secret_key
        self.region = region
        self.session_token = session_token
        self.timeout = timeout
        self.retries = max(1, min(int(retries), 5))
        self.max_read_bytes = 64 * 1024 * 1024
        config = Config(signature_version="s3v4", s3={"addressing_style": "path"},
                        retries={"max_attempts": self.retries, "mode": "standard"})
        session = botocore.session.get_session()
        self._client = session.create_client(
            "s3", region_name=region, endpoint_url=self.endpoint,
            aws_access_key_id=access_key, aws_secret_access_key=secret_key,
            aws_session_token=session_token, config=config,
        )

    def put(self, key: str, data: bytes, *, content_type: str) -> ObjectMetadata:
        digest = hashlib.sha256(data).hexdigest()
        try:
            self._client.put_object(Bucket=self.bucket, Key=key, Body=data,
                                    ContentType=content_type, IfNoneMatch="*",
                                    Metadata={"sha256": digest})
        except Exception as exc:
            if not self._is_conflict(exc):
                self._raise(exc)
            # A normal S3 HEAD does not expose a portable content digest
            # (ETag is not reliable for multipart objects), so reconcile a
            # lost response by fetching the immutable object once.
            existing_data, existing = self.get(key)
            if existing.sha256 == digest and len(existing_data) == len(data):
                return existing
            raise
        return ObjectMetadata(key, len(data), digest, content_type)

    def head(self, key: str) -> ObjectMetadata:
        try:
            response = self._client.head_object(Bucket=self.bucket, Key=key)
        except Exception as exc:
            self._raise(exc)
        return ObjectMetadata(key, int(response.get("ContentLength", 0)),
                              str(response.get("Metadata", {}).get("sha256", "")),
                              str(response.get("ContentType", "application/octet-stream")))

    def get(self, key: str) -> tuple[bytes, ObjectMetadata]:
        try:
            response = self._client.get_object(Bucket=self.bucket, Key=key)
            stream = response["Body"]
            chunks: list[bytes] = []
            total = 0
            for chunk in stream.iter_chunks(chunk_size=1024 * 1024):
                total += len(chunk)
                if total > self.max_read_bytes:
                    raise ObjectStoreError("object exceeds the configured read limit")
                chunks.append(chunk)
            data = b"".join(chunks)
        except Exception as exc:
            self._raise(exc)
        metadata = ObjectMetadata(key, len(data), hashlib.sha256(data).hexdigest(),
                                  str(response.get("ContentType", "application/octet-stream")))
        return data, metadata

    def delete(self, key: str) -> None:
        try:
            self._client.delete_object(Bucket=self.bucket, Key=key)
        except Exception as exc:
            if not self._is_not_found(exc):
                self._raise(exc)

    @staticmethod
    def _code(exc: Exception) -> str:
        return str(getattr(exc, "response", {}).get("Error", {}).get("Code", ""))

    @classmethod
    def _is_not_found(cls, exc: Exception) -> bool:
        return cls._code(exc) in {"404", "NoSuchKey", "NotFound"}

    @classmethod
    def _is_conflict(cls, exc: Exception) -> bool:
        return cls._code(exc) in {"409", "412", "PreconditionFailed"}

    @classmethod
    def _raise(cls, exc: Exception) -> None:
        if cls._is_not_found(exc):
            raise ObjectNotFound("object not found") from exc
        if cls._is_conflict(exc):
            raise ObjectConflict("immutable object key already exists") from exc
        raise ObjectStoreError("S3 request failed") from exc


def random_object_key(scope: str) -> str:
    """Return a non-guessable, scoped object key."""
    scope_digest = hashlib.sha256(scope.encode("utf-8")).hexdigest()[:32]
    return f"xagt/attachments/{scope_digest}/{secrets.token_urlsafe(24)}.obj"
