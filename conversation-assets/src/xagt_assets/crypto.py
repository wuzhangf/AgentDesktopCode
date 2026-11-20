"""Versioned conversation-asset encryption primitives.

The service stores immutable ciphertext and never invents a cryptographic
primitive.  AES-256-GCM provides authenticated encryption, X25519 plus
HKDF-SHA256 provides device key wrapping, and Ed25519 is used for provenance
signatures.  All context is included in AAD so an object cannot be moved to a
different asset, revision, or recipient without failing authentication.
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import json
import os
from dataclasses import dataclass
from typing import Any, Mapping

from cryptography.exceptions import InvalidTag, InvalidSignature
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ed25519, x25519
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

CRYPTO_VERSION = "xagt-asset-crypto/1"
AES_GCM_ALGORITHM = "AES-256-GCM"
USER_HELD_ALGORITHM = "X25519-HKDF-SHA256-AES-256-GCM"
MAX_ENVELOPE_B64 = 8192


class CryptoError(ValueError):
    """A malformed or unauthenticated asset ciphertext."""


class UserHeldEnvelopeError(CryptoError):
    """A user-held key envelope is not a valid version-one envelope."""


def _b64(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).decode("ascii").rstrip("=")


def _unb64(value: Any, *, name: str, exact: int | None = None,
           maximum: int = MAX_ENVELOPE_B64) -> bytes:
    if not isinstance(value, str) or len(value) > maximum:
        raise CryptoError(f"invalid base64 field: {name}")
    try:
        raw = base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))
    except (ValueError, binascii.Error) as exc:
        raise CryptoError(f"invalid base64 field: {name}") from exc
    if exact is not None and len(raw) != exact:
        raise CryptoError(f"invalid length for field: {name}")
    return raw


def canonical_json(value: Any) -> bytes:
    """Return the stable UTF-8 representation used for AAD and signatures."""
    try:
        return json.dumps(value, ensure_ascii=False, sort_keys=True,
                          separators=(",", ":"), allow_nan=False).encode("utf-8")
    except (TypeError, ValueError) as exc:
        raise CryptoError("value is not canonical JSON") from exc


def object_aad(*, asset_id: str, revision_id: str, object_kind: str,
               mode: str = "cloudProcessable", key_epoch: str = "1") -> bytes:
    if not all(isinstance(part, str) and 1 <= len(part) <= 256
               for part in (asset_id, revision_id, object_kind, mode, key_epoch)):
        raise CryptoError("invalid object binding")
    return canonical_json({"v": CRYPTO_VERSION, "assetId": asset_id,
                           "revisionId": revision_id, "objectKind": object_kind,
                           "mode": mode, "keyEpoch": key_epoch})


@dataclass(frozen=True)
class EncryptedObject:
    version: str
    algorithm: str
    nonce: str
    ciphertext: str
    key_epoch: str = "1"

    def as_dict(self) -> dict[str, str]:
        return {"version": self.version, "algorithm": self.algorithm,
                "nonce": self.nonce, "ciphertext": self.ciphertext,
                "keyEpoch": self.key_epoch}

    @classmethod
    def from_mapping(cls, value: Mapping[str, Any]) -> "EncryptedObject":
        if not isinstance(value, Mapping):
            raise CryptoError("encrypted object must be an object")
        allowed = {"version", "algorithm", "nonce", "ciphertext", "keyEpoch"}
        if set(value) != allowed:
            raise CryptoError("encrypted object fields differ from version one")
        if value["version"] != CRYPTO_VERSION or value["algorithm"] != AES_GCM_ALGORITHM:
            raise CryptoError("unsupported encrypted object version")
        _unb64(value["nonce"], name="nonce", exact=12)
        _unb64(value["ciphertext"], name="ciphertext", maximum=128 * 1024 * 1024)
        if not isinstance(value["keyEpoch"], str) or not value["keyEpoch"]:
            raise CryptoError("invalid key epoch")
        return cls(value["version"], value["algorithm"], value["nonce"],
                   value["ciphertext"], value["keyEpoch"])


def _content_key(key: bytes | None) -> bytes:
    if key is None:
        return os.urandom(32)
    if not isinstance(key, bytes) or len(key) != 32:
        raise CryptoError("content key must be 32 bytes")
    return key


def encrypt_object(plaintext: bytes, *, asset_id: str, revision_id: str,
                   object_kind: str, key: bytes | None = None,
                   mode: str = "cloudProcessable", key_epoch: str = "1") -> tuple[dict[str, str], bytes]:
    """Encrypt one immutable object and return ``(record, content_key)``.

    The returned key is intentionally separate from the record.  A caller may
    wrap it for a user device or put it in a deployment key manager.  It is
    never serialized into the object record.
    """
    if not isinstance(plaintext, bytes):
        raise CryptoError("plaintext must be bytes")
    content_key = _content_key(key)
    nonce = os.urandom(12)
    ciphertext = AESGCM(content_key).encrypt(
        nonce, plaintext, object_aad(asset_id=asset_id, revision_id=revision_id,
                                     object_kind=object_kind, mode=mode,
                                     key_epoch=key_epoch))
    record = EncryptedObject(CRYPTO_VERSION, AES_GCM_ALGORITHM, _b64(nonce),
                             _b64(ciphertext), key_epoch).as_dict()
    return record, content_key


def decrypt_object(record: Mapping[str, Any], *, asset_id: str, revision_id: str,
                   object_kind: str, key: bytes, mode: str = "cloudProcessable",
                   key_epoch: str | None = None) -> bytes:
    encrypted = EncryptedObject.from_mapping(record)
    if key_epoch is not None and encrypted.key_epoch != key_epoch:
        raise CryptoError("key epoch mismatch")
    if not isinstance(key, bytes) or len(key) != 32:
        raise CryptoError("content key must be 32 bytes")
    try:
        return AESGCM(key).decrypt(
            _unb64(encrypted.nonce, name="nonce", exact=12),
            _unb64(encrypted.ciphertext, name="ciphertext", maximum=128 * 1024 * 1024),
            object_aad(asset_id=asset_id, revision_id=revision_id,
                       object_kind=object_kind, mode=mode,
                       key_epoch=encrypted.key_epoch))
    except InvalidTag as exc:
        raise CryptoError("ciphertext authentication failed") from exc


def cloud_encrypt(plaintext: bytes, *, master_key: bytes, aad: bytes) -> dict[str, str]:
    """Encrypt a server-side payload under a deployment key manager key."""
    if not isinstance(master_key, bytes) or len(master_key) != 32:
        raise CryptoError("cloud master key must be 32 bytes")
    if not isinstance(aad, bytes) or len(aad) > 4096:
        raise CryptoError("invalid cloud AAD")
    nonce = os.urandom(12)
    return {"version": CRYPTO_VERSION, "algorithm": AES_GCM_ALGORITHM,
            "nonce": _b64(nonce), "ciphertext": _b64(AESGCM(master_key).encrypt(nonce, plaintext, aad))}


def cloud_decrypt(record: Mapping[str, Any], *, master_key: bytes, aad: bytes) -> bytes:
    allowed = {"version", "algorithm", "nonce", "ciphertext"}
    if not isinstance(record, Mapping) or set(record) != allowed:
        raise CryptoError("invalid cloud ciphertext record")
    if record["version"] != CRYPTO_VERSION or record["algorithm"] != AES_GCM_ALGORITHM:
        raise CryptoError("unsupported cloud ciphertext")
    if not isinstance(master_key, bytes) or len(master_key) != 32:
        raise CryptoError("cloud master key must be 32 bytes")
    try:
        return AESGCM(master_key).decrypt(
            _unb64(record["nonce"], name="nonce", exact=12),
            _unb64(record["ciphertext"], name="ciphertext", maximum=128 * 1024 * 1024),
            aad)
    except InvalidTag as exc:
        raise CryptoError("cloud ciphertext authentication failed") from exc


_USER_HELD_FIELDS = frozenset({
    "version", "mode", "algorithm", "grantId", "revision", "recipientDeviceId",
    "recipientKeyFingerprint", "ephemeralPublicKey", "sealedKey", "signature",
    "signerDeviceId",
})


def validate_user_held_envelope(envelope: Mapping[str, Any]) -> dict[str, str]:
    """Validate the opaque user-held envelope without attempting to decrypt it.

    The Hosted service calls this structural check before persistence.  It
    cannot authorize a device or verify a signature without the deployment's
    device registry, so those checks remain in the caller.
    """
    if not isinstance(envelope, Mapping) or set(envelope) != _USER_HELD_FIELDS:
        raise UserHeldEnvelopeError("user-held envelope fields differ from version one")
    if envelope["version"] != CRYPTO_VERSION or envelope["mode"] != "userHeld":
        raise UserHeldEnvelopeError("unsupported user-held envelope")
    if envelope["algorithm"] != USER_HELD_ALGORITHM:
        raise UserHeldEnvelopeError("unsupported user-held algorithm")
    for field, maximum in (("grantId", 128), ("revision", 128),
                           ("recipientDeviceId", 256), ("recipientKeyFingerprint", 256),
                           ("signerDeviceId", 256)):
        if not isinstance(envelope[field], str) or not 1 <= len(envelope[field]) <= maximum:
            raise UserHeldEnvelopeError(f"invalid user-held field: {field}")
    _unb64(envelope["ephemeralPublicKey"], name="ephemeralPublicKey", exact=32)
    _unb64(envelope["sealedKey"], name="sealedKey", exact=60)
    _unb64(envelope["signature"], name="signature", exact=64)
    return {str(k): str(v) for k, v in envelope.items()}


def generate_device_keypair() -> tuple[bytes, bytes]:
    private = x25519.X25519PrivateKey.generate()
    return (
        private.private_bytes(serialization.Encoding.Raw, serialization.PrivateFormat.Raw,
                              serialization.NoEncryption()),
        private.public_key().public_bytes(serialization.Encoding.Raw,
                                          serialization.PublicFormat.Raw),
    )


def _wrap_key(shared: bytes, *, binding: bytes) -> bytes:
    return HKDF(algorithm=hashes.SHA256(), length=32, salt=None,
                info=b"xagt.link/user-held/1/" + hashlib.sha256(binding).digest()).derive(shared)


def seal_content_key(content_key: bytes, *, recipient_public_key: bytes,
                     binding: Mapping[str, Any], grant_id: str,
                     revision: str, recipient_device_id: str,
                     signer_device_id: str, signer_private_key: bytes) -> dict[str, str]:
    if not isinstance(content_key, bytes) or len(content_key) != 32:
        raise CryptoError("content key must be 32 bytes")
    if not isinstance(signer_private_key, bytes) or len(signer_private_key) != 32:
        raise CryptoError("Ed25519 private key must be 32 bytes")
    recipient = x25519.X25519PublicKey.from_public_bytes(recipient_public_key)
    ephemeral = x25519.X25519PrivateKey.generate()
    ephemeral_public = ephemeral.public_key().public_bytes(serialization.Encoding.Raw,
                                                            serialization.PublicFormat.Raw)
    binding_bytes = canonical_json(binding)
    aad = canonical_json({"v": CRYPTO_VERSION, "mode": "userHeld", "grantId": grant_id,
                          "revision": revision, "recipientDeviceId": recipient_device_id,
                          "signerDeviceId": signer_device_id})
    nonce = hashlib.sha256(binding_bytes + grant_id.encode()).digest()[:12]
    sealed = nonce + AESGCM(_wrap_key(ephemeral.exchange(recipient), binding=binding_bytes)).encrypt(
        nonce, content_key, aad)
    signer = ed25519.Ed25519PrivateKey.from_private_bytes(signer_private_key)
    signature = signer.sign(aad + ephemeral_public + sealed)
    return validate_user_held_envelope({
        "version": CRYPTO_VERSION, "mode": "userHeld", "algorithm": USER_HELD_ALGORITHM,
        "grantId": grant_id, "revision": revision, "recipientDeviceId": recipient_device_id,
        "recipientKeyFingerprint": hashlib.sha256(recipient_public_key).hexdigest(),
        "ephemeralPublicKey": _b64(ephemeral_public), "sealedKey": _b64(sealed),
        "signature": _b64(signature), "signerDeviceId": signer_device_id,
    })


def unseal_content_key(envelope: Mapping[str, Any], *, recipient_private_key: bytes,
                       binding: Mapping[str, Any], signer_public_key: bytes) -> bytes:
    item = validate_user_held_envelope(envelope)
    if not isinstance(recipient_private_key, bytes) or len(recipient_private_key) != 32:
        raise CryptoError("X25519 private key must be 32 bytes")
    if not isinstance(signer_public_key, bytes) or len(signer_public_key) != 32:
        raise CryptoError("Ed25519 public key must be 32 bytes")
    eph = _unb64(item["ephemeralPublicKey"], name="ephemeralPublicKey", exact=32)
    sealed = _unb64(item["sealedKey"], name="sealedKey", exact=60)
    aad = canonical_json({"v": CRYPTO_VERSION, "mode": "userHeld", "grantId": item["grantId"],
                          "revision": item["revision"], "recipientDeviceId": item["recipientDeviceId"],
                          "signerDeviceId": item["signerDeviceId"]})
    try:
        ed25519.Ed25519PublicKey.from_public_bytes(signer_public_key).verify(
            _unb64(item["signature"], name="signature", exact=64), aad + eph + sealed)
        private = x25519.X25519PrivateKey.from_private_bytes(recipient_private_key)
        binding_bytes = canonical_json(binding)
        nonce, ciphertext = sealed[:12], sealed[12:]
        return AESGCM(_wrap_key(private.exchange(x25519.X25519PublicKey.from_public_bytes(eph)),
                                binding=binding_bytes)).decrypt(nonce, ciphertext, aad)
    except (InvalidSignature, InvalidTag) as exc:
        raise CryptoError("user-held envelope authentication failed") from exc
