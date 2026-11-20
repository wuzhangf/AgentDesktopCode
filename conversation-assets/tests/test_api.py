import tempfile
from pathlib import Path

from fastapi import FastAPI
from fastapi.testclient import TestClient
from cryptography.hazmat.primitives.asymmetric import ed25519

from xagt_assets import Actor, AssetStore, build_router
from xagt_assets.collector import collect_source, make_user_held_payload
from xagt_assets.crypto import generate_device_keypair


def test_cloud_revision_is_idempotent_and_encrypted():
    store = AssetStore("sqlite:///:memory:", cloud_key=b"0123456789abcdef0123456789abcdef")
    store.apply_schema()
    actor = Actor("t", "w", "m", "s", can_ingest=True, can_manage=True, can_read=True)
    app = FastAPI()
    app.include_router(build_router(store, lambda: actor), prefix="/assets/v1")
    client = TestClient(app)
    body = {"mode": "cloudProcessable", "expectedRevision": None, "payload": {"messages": [{"role": "user", "text": "hello"}]}}
    first = client.put("/assets/v1/conversations/a/revisions/r1", headers={"Idempotency-Key": "k1"}, json=body)
    assert first.status_code == 201
    replay = client.put("/assets/v1/conversations/a/revisions/r1", headers={"Idempotency-Key": "k1"}, json=body)
    assert replay.status_code == 201 and replay.json()["replayed"] is True
    read = client.get("/assets/v1/conversations/a/revisions/r1")
    assert read.status_code == 200 and read.json()["payload"] == body["payload"]
    with store.connection() as conn:
        raw = conn.execute("SELECT payload_json FROM xagt_asset_revisions").fetchone()[0]
    assert "hello" not in raw


def test_user_held_rejects_plaintext_and_supports_tombstone():
    store = AssetStore("sqlite:///:memory:", cloud_key=b"0123456789abcdef0123456789abcdef")
    store.apply_schema()
    actor = Actor("t", "w", "m", "s", can_ingest=True, can_manage=True, can_read=True)
    app = FastAPI()
    app.include_router(build_router(store, lambda: actor), prefix="/assets/v1")
    client = TestClient(app)
    bad = {"mode": "userHeld", "payload": {"messages": [{"text": "plain"}]}}
    assert client.put("/assets/v1/conversations/a/revisions/r1", headers={"Idempotency-Key": "bad"}, json=bad).status_code == 400
    recipient_private, recipient_public = generate_device_keypair()
    signer_private = ed25519.Ed25519PrivateKey.generate().private_bytes_raw()
    with tempfile.TemporaryDirectory() as temporary:
        source = Path(temporary) / "session.jsonl"
        source.write_text('{"id":"u1","role":"user","text":"cipher me"}\n', encoding="utf-8")
        revision = collect_source(source, source_root=temporary)
        payload = make_user_held_payload(
            revision, recipient_public_key=recipient_public,
            signer_private_key=signer_private, recipient_device_id="device",
            signer_device_id="signer", grant_id="grant",
        )
        good = {"mode": "userHeld", "payload": payload}
        path = f"/assets/v1/conversations/{revision.assetId}/revisions/{revision.revisionId}"
        assert client.put(path, headers={"Idempotency-Key": "ok"}, json=good).status_code == 201
        assert client.delete(f"/assets/v1/conversations/{revision.assetId}").status_code == 200
        with store.connection() as conn:
            assert conn.execute("SELECT payload_json FROM xagt_asset_revisions").fetchone()[0] == "null"
        receipt = client.get("/assets/v1/operations/ok")
        assert receipt.status_code == 200 and "payload" not in receipt.json()
    assert client.get("/assets/v1/conversations").json()["items"] == []


def test_schema_check_and_transaction_write_guard():
    calls = []

    def guard(connection, actor):
        calls.append((connection, actor.member_id))

    store = AssetStore(
        "sqlite:///:memory:",
        cloud_key=b"0123456789abcdef0123456789abcdef",
        write_guard=guard,
    )
    try:
        store.check_schema()
    except RuntimeError as exc:
        assert "missing tables" in str(exc)
    else:
        raise AssertionError("uninitialized store must fail closed")
    store.apply_schema()
    store.check_schema()
    actor = Actor("t", "w", "m", "s", can_ingest=True, can_manage=True)
    store.put_revision(actor, "a", "r1", "cloudProcessable", None, {"x": 1}, "guard-1")
    store.delete_conversation(actor, "a")
    assert [item[1] for item in calls] == ["m", "m"]
