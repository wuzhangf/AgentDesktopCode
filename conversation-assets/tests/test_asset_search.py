import os
from uuid import uuid4

import psycopg
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from psycopg import sql
from psycopg.conninfo import make_conninfo

from xagt_assets import Actor, AssetStore
from xagt_assets.collector import CollectedRevision, make_user_held_payload
from xagt_assets.crypto import generate_device_keypair
from xagt_assets.search import SearchService, build_search_router


KEY = b"0123456789abcdef0123456789abcdef"


def _actor(**kwargs):
    return Actor("tenant", "workspace", "member", "subject", **kwargs)


def _store(mode="cloudProcessable"):
    store = AssetStore("sqlite:///:memory:", cloud_key=KEY if mode == "cloudProcessable" else None,
                       allowed_modes={mode})
    store.apply_schema()
    return store


def test_bounded_cjk_casefold_code_search_and_provenance():
    store = _store()
    actor = _actor(can_ingest=True, can_read=True, can_manage=True)
    store.put_revision(actor, "asset", "rev", "cloudProcessable", None, {
        "messages": [
            {"messageId": "m-cjk", "role": "user", "text": "请查找订单号 ABC-123 世界"},
            {"messageId": "m-code", "content": [{"type": "text", "text": "FooBar() is stable"}]},
        ]
    }, "rev-1")
    service = SearchService(store, max_scan_bytes=1024, max_text_bytes=1024)
    result = service.search(actor, "foobar()", candidate_limit=10, result_limit=10)
    assert result["searchKind"] == "bounded_recent_head_keyword_scan"
    assert result["truncated"] is False
    assert result["items"][0]["messageId"] == "m-code"
    assert result["items"][0]["assetId"] == "asset"
    assert "FooBar()" in result["items"][0]["snippet"]
    cjk = service.search(actor, "世界", candidate_limit=10, result_limit=10)
    assert cjk["items"][0]["messageId"] == "m-cjk"
    assert cjk["items"][0]["sourceRef"].startswith("messages[")


def test_candidate_and_result_bounds_are_explicit():
    store = _store()
    actor = _actor(can_ingest=True, can_read=True, can_manage=True)
    for index in range(3):
        store.put_revision(actor, f"asset-{index}", "rev", "cloudProcessable", None,
                           {"messages": [{"messageId": f"m-{index}", "text": "needle needle"}]}, f"rev-{index}")
    result = SearchService(store, max_scan_bytes=1024).search(actor, "needle",
                                                               candidate_limit=2, result_limit=1)
    assert result["truncated"] is True
    assert "candidate_limit" in result["truncationReasons"]
    assert "result_limit" in result["truncationReasons"]
    assert len(result["items"]) == 1


def test_user_held_only_never_opens_ciphertext_and_router_enforces_scope():
    store = _store("userHeld")
    actor = _actor(can_ingest=True, can_read=True, can_manage=True)
    private, public = generate_device_keypair()
    from cryptography.hazmat.primitives.asymmetric import ed25519
    signer = ed25519.Ed25519PrivateKey.generate().private_bytes_raw()
    revision = CollectedRevision("asset", "rev", {"text": "secret phrase"}, ())
    payload = make_user_held_payload(revision, recipient_public_key=public,
                                     signer_private_key=signer, recipient_device_id="device",
                                     signer_device_id="signer", grant_id="grant")
    store.put_revision(actor, "asset", "rev", "userHeld", None, payload, "rev-1")
    result = SearchService(store).search(actor, "secret")
    assert result["items"] == []
    assert result["truncationReasons"] == ["cloud_mode_disabled"]

    app = FastAPI()
    app.include_router(build_search_router(store, lambda: actor), prefix="/assets/v1")
    client = TestClient(app)
    response = client.post("/assets/v1/search", json={"query": "secret"})
    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    denied = _actor(can_read=False)
    denied_app = FastAPI()
    denied_app.include_router(build_search_router(store, lambda: denied), prefix="/assets/v1")
    assert TestClient(denied_app).post("/assets/v1/search", json={"query": "secret"}).status_code == 403


@pytest.fixture
def postgres_dsn():
    admin_dsn = os.environ.get("XAGT_ASSETS_TEST_POSTGRES")
    if not admin_dsn:
        pytest.skip("set XAGT_ASSETS_TEST_POSTGRES to an isolated PostgreSQL server")
    database = "assets_search_" + uuid4().hex
    with psycopg.connect(admin_dsn, autocommit=True) as connection:
        connection.execute(sql.SQL("CREATE DATABASE {} ").format(sql.Identifier(database)))
    try:
        yield make_conninfo(admin_dsn, dbname=database)
    finally:
        with psycopg.connect(admin_dsn, autocommit=True) as connection:
            connection.execute(sql.SQL("DROP DATABASE {} WITH (FORCE)").format(sql.Identifier(database)))


def test_search_real_postgres(postgres_dsn):
    store = AssetStore(postgres_dsn, cloud_key=KEY)
    store.apply_schema()
    actor = _actor(can_ingest=True, can_read=True, can_manage=True)
    store.put_revision(actor, "pg-asset", "rev", "cloudProcessable", None,
                       {"messages": [{"messageId": "pg-m", "text": "PostgreSQL phrase 世界"}]}, "pg-rev")
    result = SearchService(store).search(actor, "postgresql")
    assert result["items"][0]["messageId"] == "pg-m"
