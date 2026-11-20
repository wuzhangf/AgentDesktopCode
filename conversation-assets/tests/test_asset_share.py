from __future__ import annotations

import json
import zipfile

import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from xagt_assets.bundle import export_bundle
from xagt_assets.collector import make_user_held_payload
from xagt_assets.crypto import generate_device_keypair
from xagt_assets.share import ShareError, create_share_bundle
from xagt_assets.unlock import UnlockError, read_revision_bytes


def _source_payload(*, conflicting: bool = False) -> dict:
    rows = [
        {"messageId": "m-user", "role": "user", "text": "private user text", "sourcePage": 1},
        {"messageId": "m-tool", "role": "tool", "text": "private tool output", "sourcePage": 1},
        {"messageId": "m-assistant", "role": "assistant", "text": "selected assistant text", "sourcePage": 1},
    ]
    if conflicting:
        rows.append({"messageId": "m-user", "role": "user", "text": "different duplicate", "sourcePage": 2})
    return {"schemaVersion": "xagt-conversation-assets/1", "assetId": "asset-source",
            "revisionId": "rev-source", "rows": rows, "recordCount": len(rows)}


def _write_cloud_source(path, payload):
    export_bundle(path, files={"revisions/rev-source.json": json.dumps({
        "assetId": "asset-source", "revisionId": "rev-source",
        "mode": "cloudProcessable", "payload": payload,
    }, sort_keys=True, separators=(",", ":")).encode()})


def _write_user_held_source(path, tmp_path, payload):
    source_private, source_public = generate_device_keypair()
    signing = Ed25519PrivateKey.generate()
    (tmp_path / "source-recipient.key").write_bytes(source_private)
    (tmp_path / "source-signer.pub").write_bytes(signing.public_key().public_bytes_raw())
    (tmp_path / "source-signer.key").write_bytes(signing.private_bytes_raw())
    opaque = make_user_held_payload(
        type("Revision", (), {"assetId": "asset-source", "revisionId": "rev-source", "payload": payload})(),
        recipient_public_key=source_public, signer_private_key=signing.private_bytes_raw(),
        recipient_device_id="source-reader", signer_device_id="source-owner",
    )
    export_bundle(path, files={"revisions/rev-source.json": json.dumps({
        "assetId": "asset-source", "revisionId": "rev-source",
        "mode": "userHeld", "payload": opaque,
    }, sort_keys=True, separators=(",", ":")).encode()})
    return source_private, signing.public_key().public_bytes_raw()


def test_share_contains_only_selected_visible_messages_and_receiver_opens(tmp_path):
    source = tmp_path / "source.zip"
    share = tmp_path / "share.zip"
    _write_cloud_source(source, _source_payload())
    recipient_private, recipient_public = generate_device_keypair()
    signer = Ed25519PrivateKey.generate()
    result = create_share_bundle(
        source, asset_id="asset-source", revision_id="rev-source",
        selected_message_ids=["m-user", "m-assistant"], destination=share,
        recipient_public_key=recipient_public, signer_private_key=signer.private_bytes_raw(),
        recipient_device_id="target-device", signer_device_id="owner-device",
    )
    assert result["messageCount"] == 2
    (tmp_path / "recipient.key").write_bytes(recipient_private)
    (tmp_path / "signer.pub").write_bytes(signer.public_key().public_bytes_raw())
    plaintext, summary = read_revision_bytes(
        share, asset_id=result["assetId"], revision_id=result["revisionId"],
        recipient_private_key_path=tmp_path / "recipient.key",
        signer_public_key_path=tmp_path / "signer.pub",
    )
    value = json.loads(plaintext)
    assert summary["mode"] == "userHeld"
    assert [row["messageId"] for row in value["messages"]] == ["m-user", "m-assistant"]
    assert [row["text"] for row in value["messages"]] == ["private user text", "selected assistant text"]
    assert all("raw" not in row for row in value["messages"])
    assert "m-tool" not in value["source"]["messageIds"]
    assert "private tool output" not in plaintext.decode()
    assert value["source"]["assetId"] == "asset-source"
    with zipfile.ZipFile(share) as archive:
        blob = b"".join(archive.read(name) for name in archive.namelist())
    assert b"private tool output" not in blob
    assert b"asset-source" not in blob and b"rev-source" not in blob
    assert b"m-user" not in blob and b"m-assistant" not in blob


def test_share_decrypts_user_held_source_in_memory_and_rejects_wrong_receiver(tmp_path):
    source = tmp_path / "source-held.zip"
    share = tmp_path / "share-held.zip"
    _write_user_held_source(source, tmp_path, _source_payload())
    with zipfile.ZipFile(source) as archive:
        source_record = json.loads(archive.read("revisions/rev-source.json"))
    original_envelope = source_record["payload"]["envelope"]
    recipient_private, recipient_public = generate_device_keypair()
    signer = Ed25519PrivateKey.generate()
    result = create_share_bundle(
        source, asset_id="asset-source", revision_id="rev-source", selected_message_ids=["m-assistant"],
        destination=share, recipient_public_key=recipient_public, signer_private_key=signer.private_bytes_raw(),
        recipient_device_id="target-device", signer_device_id="owner-device",
        source_recipient_private_key_path=tmp_path / "source-recipient.key",
        source_signer_public_key_path=tmp_path / "source-signer.pub",
    )
    (tmp_path / "target.key").write_bytes(recipient_private)
    (tmp_path / "owner.pub").write_bytes(signer.public_key().public_bytes_raw())
    plaintext, _ = read_revision_bytes(share, asset_id=result["assetId"], revision_id=result["revisionId"],
                                       recipient_private_key_path=tmp_path / "target.key",
                                       signer_public_key_path=tmp_path / "owner.pub")
    assert json.loads(plaintext)["messages"][0]["messageId"] == "m-assistant"
    wrong_private, _ = generate_device_keypair()
    (tmp_path / "wrong.key").write_bytes(wrong_private)
    with pytest.raises(UnlockError):
        read_revision_bytes(share, asset_id=result["assetId"], revision_id=result["revisionId"],
                            recipient_private_key_path=tmp_path / "wrong.key",
                            signer_public_key_path=tmp_path / "owner.pub")
    with zipfile.ZipFile(share) as archive:
        share_blob = b"".join(archive.read(name) for name in archive.namelist())
    assert original_envelope["grantId"].encode() not in share_blob
    assert original_envelope["sealedKey"].encode() not in share_blob
    assert recipient_private not in share_blob


def test_share_fails_closed_for_unknown_tool_and_conflicting_ids(tmp_path):
    source = tmp_path / "source.zip"
    _write_cloud_source(source, _source_payload())
    _, public = generate_device_keypair()
    signer = Ed25519PrivateKey.generate()
    kwargs = dict(asset_id="asset-source", revision_id="rev-source", destination=tmp_path / "share.zip",
                  recipient_public_key=public, signer_private_key=signer.private_bytes_raw(),
                  recipient_device_id="target", signer_device_id="owner")
    with pytest.raises(ShareError, match="unknown|hidden|tool"):
        create_share_bundle(source, selected_message_ids=["m-tool"], **kwargs)
    with pytest.raises(ShareError, match="unknown|hidden|tool"):
        create_share_bundle(source, selected_message_ids=["not-present"], **kwargs)
    conflicting = tmp_path / "conflicting.zip"
    _write_cloud_source(conflicting, _source_payload(conflicting=True))
    with pytest.raises(ShareError, match="conflicting"):
        create_share_bundle(conflicting, selected_message_ids=["m-user"], **kwargs)
