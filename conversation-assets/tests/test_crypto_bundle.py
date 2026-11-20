from __future__ import annotations

import json
import zipfile

import pytest
from cryptography.hazmat.primitives.asymmetric import ed25519

from xagt_assets.bundle import BundleError, export_bundle, import_bundle
from xagt_assets.crypto import (
    CryptoError,
    cloud_decrypt,
    cloud_encrypt,
    decrypt_object,
    encrypt_object,
    generate_device_keypair,
    seal_content_key,
    unseal_content_key,
)


def test_object_and_cloud_encryption_bind_context():
    record, key = encrypt_object(b"hello", asset_id="a", revision_id="r",
                                 object_kind="messages")
    assert decrypt_object(record, asset_id="a", revision_id="r", object_kind="messages", key=key) == b"hello"
    with pytest.raises(CryptoError):
        decrypt_object(record, asset_id="other", revision_id="r", object_kind="messages", key=key)
    cloud = cloud_encrypt(b"server", master_key=b"m" * 32, aad=b"tenant/a")
    assert cloud_decrypt(cloud, master_key=b"m" * 32, aad=b"tenant/a") == b"server"
    with pytest.raises(CryptoError):
        cloud_decrypt(cloud, master_key=b"m" * 32, aad=b"tenant/b")


def test_user_held_envelope_round_trip_and_binding():
    recipient_private, recipient_public = generate_device_keypair()
    signer = ed25519.Ed25519PrivateKey.generate()
    signer_private = signer.private_bytes_raw()
    signer_public = signer.public_key().public_bytes_raw()
    envelope = seal_content_key(b"k" * 32, recipient_public_key=recipient_public,
                                binding={"assetId": "a", "revisionId": "r"},
                                grant_id="g", revision="1", recipient_device_id="d",
                                signer_device_id="s", signer_private_key=signer_private)
    assert unseal_content_key(envelope, recipient_private_key=recipient_private,
                              binding={"assetId": "a", "revisionId": "r"},
                              signer_public_key=signer_public) == b"k" * 32
    with pytest.raises(CryptoError):
        unseal_content_key(envelope, recipient_private_key=recipient_private,
                           binding={"assetId": "other", "revisionId": "r"},
                           signer_public_key=signer_public)


def test_bundle_round_trip_signature_and_traversal(tmp_path):
    signing = ed25519.Ed25519PrivateKey.generate()
    private = signing.private_bytes_raw()
    public = signing.public_key().public_bytes_raw()
    target = tmp_path / "assets.zip"
    export_bundle(target, files={"assets/a/messages.jsonl": b"{}\n"},
                  metadata={"assetCount": 1}, signing_private_key=private,
                  signer_device_id="device")
    imported = import_bundle(target, verify_public_key=public, require_signature=True)
    assert imported["files"]["assets/a/messages.jsonl"] == b"{}\n"
    with zipfile.ZipFile(target, "a") as archive:
        archive.writestr("../escape", b"bad")
    with pytest.raises(BundleError):
        import_bundle(target)


def test_bundle_detects_manifest_digest_change(tmp_path):
    target = tmp_path / "assets.zip"
    export_bundle(target, files={"messages.jsonl": b"one"})
    with zipfile.ZipFile(target, "a") as archive:
        manifest = json.loads(archive.read("manifest.json"))
        manifest["files"][0]["sha256"] = "0" * 64
        archive.writestr("manifest.json", json.dumps(manifest).encode())
    with pytest.raises(BundleError):
        import_bundle(target)


def test_bundle_trust_anchor_requires_signed_bundle_and_keeps_partial(tmp_path):
    signing = ed25519.Ed25519PrivateKey.generate()
    public = signing.public_key().public_bytes_raw()
    target = tmp_path / "assets.zip"
    unrelated_partial = target.with_name(target.name + ".partial")
    unrelated_partial.write_bytes(b"keep")
    export_bundle(target, files={"messages.jsonl": b"one"})
    assert unrelated_partial.read_bytes() == b"keep"
    with pytest.raises(BundleError, match="signature is required"):
        import_bundle(target, verify_public_key=public)


def test_malformed_archive_is_normalized(tmp_path):
    target = tmp_path / "broken.zip"
    target.write_bytes(b"not a zip")
    with pytest.raises(BundleError, match="readable ZIP"):
        import_bundle(target)
