from __future__ import annotations

import copy
import hashlib
import json
from pathlib import Path

import pytest

from xagt_assets.crypto import (
    CryptoError,
    canonical_json,
    decrypt_object,
    object_aad,
    unseal_content_key,
)


FIXTURE = Path(__file__).parent / "fixtures" / "asset_crypto_v1" / "vector.json"


def _vector() -> dict:
    return json.loads(FIXTURE.read_text(encoding="utf-8"))


def test_public_vector_round_trip_and_expected_encodings() -> None:
    vector = _vector()
    assert vector["testLabel"].startswith("PUBLIC SYNTHETIC ONLY")
    binding = canonical_json(vector["binding"])
    assert binding.decode() == vector["bindingCanonicalJsonUtf8"]
    assert binding.hex() == vector["bindingCanonicalJsonHex"]
    assert hashlib.sha256(binding).hexdigest() == vector["bindingSha256"]
    assert object_aad(
        asset_id=vector["assetId"],
        revision_id=vector["revisionId"],
        object_kind=vector["objectKind"],
        mode=vector["mode"],
        key_epoch=vector["keyEpoch"],
    ).decode() == vector["objectAadUtf8"]
    assert object_aad(
        asset_id=vector["assetId"],
        revision_id=vector["revisionId"],
        object_kind=vector["objectKind"],
        mode=vector["mode"],
        key_epoch=vector["keyEpoch"],
    ).hex() == vector["objectAadHex"]
    assert decrypt_object(
        vector["object"], asset_id=vector["assetId"],
        revision_id=vector["revisionId"], object_kind=vector["objectKind"],
        mode=vector["mode"], key=bytes.fromhex(vector["contentKeyHex"]),
    ).decode() == vector["plaintextUtf8"]


def test_public_vector_unseals_content_key_and_checks_fingerprint() -> None:
    vector = _vector()
    assert vector["envelope"]["revision"] == vector["revisionId"]
    recipient_public = bytes.fromhex(vector["recipientPublicKeyHex"])
    assert hashlib.sha256(recipient_public).hexdigest() == vector["recipientKeyFingerprint"]
    assert vector["envelope"]["recipientKeyFingerprint"] == vector["recipientKeyFingerprint"]
    assert unseal_content_key(
        vector["envelope"],
        recipient_private_key=bytes.fromhex(vector["recipientPrivateKeyHex"]),
        binding=vector["binding"],
        signer_public_key=bytes.fromhex(vector["signerPublicKeyHex"]),
    ) == bytes.fromhex(vector["contentKeyHex"])


def test_public_vector_rejects_wrong_recipient_and_object_tampering() -> None:
    vector = _vector()
    with pytest.raises(CryptoError):
        unseal_content_key(
            vector["envelope"],
            recipient_private_key=bytes.fromhex(vector["wrongRecipientPrivateKeyHex"]),
            binding=vector["binding"],
            signer_public_key=bytes.fromhex(vector["signerPublicKeyHex"]),
        )
    tampered = copy.deepcopy(vector["object"])
    tampered["ciphertext"] = ("A" if tampered["ciphertext"][0] != "A" else "B") + tampered["ciphertext"][1:]
    with pytest.raises(CryptoError):
        decrypt_object(
            tampered, asset_id=vector["assetId"],
            revision_id=vector["revisionId"], object_kind=vector["objectKind"],
            mode=vector["mode"], key=bytes.fromhex(vector["contentKeyHex"]),
        )


def test_public_vector_rejects_envelope_tampering() -> None:
    vector = _vector()
    tampered = copy.deepcopy(vector["envelope"])
    signature = tampered["signature"]
    tampered["signature"] = ("A" if signature[0] != "A" else "B") + signature[1:]
    with pytest.raises(CryptoError):
        unseal_content_key(
            tampered,
            recipient_private_key=bytes.fromhex(vector["recipientPrivateKeyHex"]),
            binding=vector["binding"],
            signer_public_key=bytes.fromhex(vector["signerPublicKeyHex"]),
        )
