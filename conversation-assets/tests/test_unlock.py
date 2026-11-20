from __future__ import annotations

import json

import pytest
from cryptography.hazmat.primitives.asymmetric import ed25519

from xagt_assets.bundle import BundleError, export_bundle
from xagt_assets.crypto import encrypt_object, generate_device_keypair, seal_content_key
from xagt_assets.unlock import UnlockError, unlock_revision


def _keys(tmp_path):
    recipient_private, recipient_public = generate_device_keypair()
    signer = ed25519.Ed25519PrivateKey.generate()
    recipient_path = tmp_path / "recipient.key"
    signer_public_path = tmp_path / "signer.pub"
    recipient_path.write_bytes(recipient_private)
    signer_public_path.write_bytes(signer.public_key().public_bytes_raw())
    return recipient_private, recipient_public, signer, recipient_path, signer_public_path


def test_unlock_user_held_revision_to_explicit_destination(tmp_path):
    recipient_private, recipient_public, signer, recipient_path, signer_public_path = _keys(tmp_path)
    archive_signer = ed25519.Ed25519PrivateKey.generate()
    archive_public_path = tmp_path / "archive.pub"
    archive_public_path.write_bytes(archive_signer.public_key().public_bytes_raw())
    encrypted, content_key = encrypt_object(
        b'{"messages":[{"role":"user","text":"hello"}]}',
        asset_id="asset-1", revision_id="rev-1", object_kind="conversation", mode="userHeld")
    envelope = seal_content_key(
        content_key, recipient_public_key=recipient_public,
        binding={"assetId": "asset-1", "revisionId": "rev-1", "objectKind": "conversation"},
        grant_id="grant-1", revision="rev-1", recipient_device_id="device-1",
        signer_device_id="source-1", signer_private_key=signer.private_bytes_raw())
    revision = {"assetId": "asset-1", "revisionId": "rev-1", "mode": "userHeld",
                "payload": {"object": encrypted, "envelope": envelope}}
    bundle = tmp_path / "asset.zip"
    export_bundle(bundle, files={"revisions/rev-1.json": json.dumps(revision).encode()},
                  signing_private_key=archive_signer.private_bytes_raw(), signer_device_id="archive-1")
    destination = tmp_path / "out.json"
    result = unlock_revision(
        bundle, asset_id="asset-1", revision_id="rev-1",
        recipient_private_key_path=recipient_path, signer_public_key_path=signer_public_path,
        archive_signer_public_key_path=archive_public_path, destination=destination)
    assert result["mode"] == "userHeld"
    assert destination.read_text() == '{"messages":[{"role":"user","text":"hello"}]}'
    with pytest.raises(UnlockError, match="already exists"):
        unlock_revision(bundle, asset_id="asset-1", revision_id="rev-1",
                        recipient_private_key_path=recipient_path,
                        signer_public_key_path=signer_public_path,
                        archive_signer_public_key_path=archive_public_path, destination=destination)


def test_unlock_rejects_untrusted_archive_and_plaintext(tmp_path):
    _, _, signer, _, signer_public_path = _keys(tmp_path)
    bundle = tmp_path / "asset.zip"
    revision = {"assetId": "asset-1", "revisionId": "rev-1", "mode": "cloudProcessable",
                "payload": {"messages": [{"text": "plaintext"}]}}
    export_bundle(bundle, files={"revisions/rev-1.json": json.dumps(revision).encode()})
    with pytest.raises(UnlockError, match="archive verification failed"):
        unlock_revision(bundle, asset_id="asset-1", revision_id="rev-1",
                        recipient_private_key_path=None, signer_public_key_path=None,
                        archive_signer_public_key_path=signer_public_path,
                        destination=tmp_path / "out")


def test_unlock_cloud_payload_is_local_json_only(tmp_path):
    _, _, _, _, signer_public_path = _keys(tmp_path)
    revision = {"assetId": "asset-1", "revisionId": "rev-2", "mode": "cloudProcessable",
                "payload": {"messages": [{"role": "assistant", "text": "done"}]}}
    bundle = tmp_path / "cloud.zip"
    export_bundle(bundle, files={"revisions/rev-2.json": json.dumps(revision).encode()})
    destination = tmp_path / "cloud.json"
    result = unlock_revision(bundle, asset_id="asset-1", revision_id="rev-2",
                             recipient_private_key_path=None, signer_public_key_path=None,
                             destination=destination)
    assert result["mode"] == "cloudProcessable"
    assert json.loads(destination.read_text()) == revision["payload"]
