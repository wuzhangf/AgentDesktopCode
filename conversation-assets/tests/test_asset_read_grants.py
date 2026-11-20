from __future__ import annotations

import json

import pytest
from cryptography.hazmat.primitives.asymmetric import ed25519
from fastapi import FastAPI
from fastapi.testclient import TestClient

from xagt_assets import Actor, AssetStore, build_router
from xagt_assets.collector import CollectedRevision, make_user_held_payload
from xagt_assets.crypto import generate_device_keypair
from xagt_assets.read_grants import apply_grant_schema, build_grant_router, check_grant_schema


KEY = b"0123456789abcdef0123456789abcdef"
OWNER = Actor("tenant", "workspace", "member", "owner", can_ingest=True, can_manage=True, can_read=True)


def _app(store, actor=OWNER):
    app = FastAPI()
    app.include_router(build_router(store, lambda: actor), prefix="/assets/v1")
    app.include_router(build_grant_router(store, lambda: actor), prefix="/assets/v1")
    return TestClient(app)


def _revision(client, revision_id="rev-1", *, mode="cloudProcessable", payload=None):
    return client.put(
        f"/assets/v1/conversations/asset-1/revisions/{revision_id}",
        headers={"Idempotency-Key": "op-" + revision_id},
        json={"mode": mode, "payload": payload or {"messages": [{"text": "private"}]}},
    )


def test_cloud_grant_is_exact_revision_short_lived_and_revocable():
    store = AssetStore("sqlite:///:memory:", cloud_key=KEY)
    store.apply_schema()
    apply_grant_schema(store)
    check_grant_schema(store)
    client = _app(store)
    assert _revision(client).status_code == 201
    issued = client.post("/assets/v1/grants", json={
        "assetId": "asset-1", "revisionId": "rev-1", "mode": "cloudProcessable", "expiresInSec": 60,
    })
    assert issued.status_code == 201
    body = issued.json()
    assert body["token"] and body["grantId"]
    # The token is only returned at issuance; the database stores its digest.
    row = store._query(store._memory_connection, "SELECT token_digest FROM xagt_asset_read_grants", ())
    assert body["token"] not in row[0]["token_digest"]
    granted = client.get(
        f"/assets/v1/grants/{body['grantId']}/conversations/asset-1/revisions/rev-1",
        headers={"Authorization": "Bearer " + body["token"]},
    )
    assert granted.status_code == 200
    assert granted.json()["payload"] == {"messages": [{"text": "private"}]}
    assert "subjectId" not in granted.json()
    wrong_path = client.get(
        f"/assets/v1/grants/{body['grantId']}/conversations/asset-1/revisions/other",
        headers={"Authorization": "Bearer " + body["token"]},
    )
    assert wrong_path.status_code == 401
    assert client.delete(f"/assets/v1/grants/{body['grantId']}").status_code == 200
    assert client.get(
        f"/assets/v1/grants/{body['grantId']}/conversations/asset-1/revisions/rev-1",
        headers={"Authorization": "Bearer " + body["token"]},
    ).status_code == 401


def test_expiry_and_tombstone_are_rechecked_on_every_read():
    store = AssetStore("sqlite:///:memory:", cloud_key=KEY)
    store.apply_schema()
    apply_grant_schema(store)
    client = _app(store)
    assert _revision(client).status_code == 201
    issued = client.post("/assets/v1/grants", json={
        "assetId": "asset-1", "revisionId": "rev-1", "mode": "cloudProcessable", "expiresInSec": 60,
    }).json()
    with store.connection() as conn:
        store._exec(conn, "UPDATE xagt_asset_read_grants SET expires_at=?", ("2000-01-01T00:00:00Z",))
    route = f"/assets/v1/grants/{issued['grantId']}/conversations/asset-1/revisions/rev-1"
    assert client.get(route, headers={"Authorization": "Bearer " + issued["token"]}).status_code == 401

    # A fresh grant is invalidated by the asset tombstone, even though the
    # bearer token and revision row still exist.
    fresh = client.post("/assets/v1/grants", json={
        "assetId": "asset-1", "revisionId": "rev-1", "mode": "cloudProcessable", "expiresInSec": 60,
    }).json()
    assert client.delete("/assets/v1/conversations/asset-1").status_code == 200
    assert client.get(
        f"/assets/v1/grants/{fresh['grantId']}/conversations/asset-1/revisions/rev-1",
        headers={"Authorization": "Bearer " + fresh["token"]},
    ).status_code == 410


def test_user_held_returns_opaque_ciphertext_and_requires_trusted_recipient():
    store = AssetStore("sqlite:///:memory:", cloud_key=KEY)
    store.apply_schema()
    apply_grant_schema(store)
    client = _app(store)
    recipient_private, recipient_public = generate_device_keypair()
    signer = ed25519.Ed25519PrivateKey.generate()
    payload = make_user_held_payload(
        CollectedRevision("asset-1", "rev-u", {"secret": "not for service"}, ()),
        recipient_public_key=recipient_public, signer_private_key=signer.private_bytes_raw(),
        recipient_device_id="trusted-phone", signer_device_id="owner-device", grant_id="grant-source")
    assert _revision(client, "rev-u", mode="userHeld", payload=payload).status_code == 201
    issued = client.post("/assets/v1/grants", json={
        "assetId": "asset-1", "revisionId": "rev-u", "mode": "userHeld", "expiresInSec": 60,
        "recipientDeviceId": "trusted-phone",
    })
    assert issued.status_code == 201
    result = client.get(
        f"/assets/v1/grants/{issued.json()['grantId']}/conversations/asset-1/revisions/rev-u",
        headers={"Authorization": "Bearer " + issued.json()["token"]},
    )
    assert result.status_code == 200
    returned = result.json()
    assert returned["requiresTrustedDeviceKey"] is True
    assert "not for service" not in result.text
    assert returned["payload"]["envelope"]["recipientDeviceId"] == "trusted-phone"
    assert returned["payload"]["object"]["ciphertext"]
    denied = client.post("/assets/v1/grants", json={
        "assetId": "asset-1", "revisionId": "rev-u", "mode": "userHeld", "expiresInSec": 60,
        "recipientDeviceId": "untrusted-phone",
    })
    assert denied.status_code == 403


def test_grant_owner_permission_and_invalid_bearer_do_not_leak_identity():
    store = AssetStore("sqlite:///:memory:", cloud_key=KEY)
    store.apply_schema()
    apply_grant_schema(store)
    client = _app(store, Actor("tenant", "workspace", "member", "reader", can_read=True))
    assert _revision(client).status_code == 403
    assert client.get(
        "/assets/v1/grants/grant-nope/conversations/asset-1/revisions/rev-1",
        headers={"Authorization": "Bearer invalid-token"},
    ).status_code == 401
