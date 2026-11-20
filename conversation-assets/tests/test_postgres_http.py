"""Exercise the wire contract against an isolated PostgreSQL database."""

import os
from concurrent.futures import ThreadPoolExecutor
from uuid import uuid4

import psycopg
import pytest
from cryptography.hazmat.primitives.asymmetric import ed25519
from fastapi import FastAPI, Header
from fastapi.testclient import TestClient
from psycopg import sql
from psycopg.conninfo import make_conninfo

from xagt_assets.api import Actor, build_router
from xagt_assets.catalog import build_catalog_router
from xagt_assets.collector import CollectedRevision, make_user_held_payload
from xagt_assets.crypto import generate_device_keypair
from xagt_assets.portability import export_conversation, restore_conversation
from xagt_assets.read_grants import apply_grant_schema
from xagt_assets.standalone import build_app
from xagt_assets.store import AssetStore


def test_standalone_search_and_grants_are_opt_in_and_mode_scoped(postgres_dsn):
    store = AssetStore(postgres_dsn, cloud_key=bytes(range(32)))
    store.apply_schema()
    owner_token = b"owner-token-for-integration-test-only"
    collector_token = b"collector-token-for-integration-test-only"
    owner = {"Authorization": f"Bearer {owner_token.decode()}"}
    collector = {"Authorization": f"Bearer {collector_token.decode()}"}
    root = "/assets/v1"
    with TestClient(build_app(store, owner_token=owner_token)) as http:
        assert http.post(f"{root}/search", headers=owner, json={"query": "phrase"}).status_code == 404
        assert http.post(f"{root}/grants", headers=owner, json={}).status_code == 404
    with pytest.raises(RuntimeError, match="grant schema is not ready"):
        build_app(store, owner_token=owner_token, enable_read_grants=True)
    apply_grant_schema(store)

    _, device_public = generate_device_keypair()
    plaintext = {"files": [{"path": "private-project/session.jsonl", "records": [
        {"messageId": "message-a", "role": "assistant", "text": "核对交接 Straße"},
        {"messageId": "tool-a", "role": "tool", "text": "private invocation"},
    ]}]}
    ciphertext = make_user_held_payload(
        CollectedRevision("held", "rev-a", plaintext, ()),
        recipient_public_key=device_public, recipient_device_id="trusted-device",
        signer_private_key=ed25519.Ed25519PrivateKey.generate().private_bytes_raw(),
        signer_device_id="collector", grant_id="local-box",
    )
    with TestClient(build_app(store, owner_token=owner_token, collector_token=collector_token,
                              enable_search=True, enable_read_grants=True)) as http:
        for asset_id, mode, payload in (("private", "cloudProcessable", plaintext),
                                        ("held", "userHeld", ciphertext)):
            path = f"{root}/conversations/{asset_id}/revisions/rev-a"
            assert http.put(path, headers={**collector, "Idempotency-Key": f"capture-{asset_id}"},
                            json={"mode": mode, "payload": payload}).status_code == 201
            grant_body = {"assetId": asset_id, "revisionId": "rev-a", "mode": mode, "expiresInSec": 60}
            assert http.post(f"{root}/grants", headers=collector, json=grant_body).status_code == 403
            issued = http.post(f"{root}/grants", headers=owner, json=grant_body)
            assert issued.status_code == 201, issued.text
            grant = issued.json()
            assert issued.headers["cache-control"] == "no-store"
            grant_headers = {"Authorization": f"Bearer {grant['token']}"}
            grant_route = f"{root}/grants/{grant['grantId']}"
            granted = http.get(f"{grant_route}/conversations/{asset_id}/revisions/rev-a",
                               headers=grant_headers)
            assert granted.status_code == 200
            assert granted.json()["payload"] == payload
            assert granted.headers["cache-control"] == "no-store"
            assert http.get(f"{root}/catalog", headers=grant_headers).status_code == 401
            assert http.get(f"{grant_route}/conversations/{asset_id}/revisions/rev-b",
                            headers=grant_headers).status_code == 401
            first_revoke = http.delete(grant_route, headers=owner)
            assert first_revoke.status_code == 200
            assert first_revoke.json() == http.delete(grant_route, headers=owner).json()
            assert http.get(f"{grant_route}/conversations/{asset_id}/revisions/rev-a",
                            headers=grant_headers).status_code == 401
        search_route = f"{root}/search"
        assert http.post(search_route, headers=collector, json={"query": "核对"}).status_code == 403
        found = http.post(search_route, headers=owner, json={"query": "STRASSE"})
        assert found.status_code == 200, found.text
        assert [item["assetId"] for item in found.json()["items"]] == ["private"]
        assert found.json()["items"][0]["sourceRef"] == "files[0].records[0]"
        assert "private-project" not in found.text
        assert http.post(search_route, headers=owner, json={"query": "private invocation"}).json()["items"] == []
        bad_request = http.post(search_route, headers=owner, json={"query": "sensitive-value", "candidateLimit": 0})
        assert bad_request.status_code == 400 and "sensitive-value" not in bad_request.text
        assert http.post(search_route, headers=owner, json={"query": "x" * 5000}).status_code == 413


@pytest.fixture
def postgres_dsn():
    admin_dsn = os.environ.get("XAGT_ASSETS_TEST_POSTGRES")
    if not admin_dsn:
        pytest.skip("set XAGT_ASSETS_TEST_POSTGRES to an isolated PostgreSQL server")
    database = "assets_test_" + uuid4().hex
    with psycopg.connect(admin_dsn, autocommit=True) as connection:
        connection.execute(sql.SQL("CREATE DATABASE {}").format(sql.Identifier(database)))
    try:
        yield make_conninfo(admin_dsn, dbname=database)
    finally:
        with psycopg.connect(admin_dsn, autocommit=True) as connection:
            connection.execute(sql.SQL("DROP DATABASE {} WITH (FORCE)").format(sql.Identifier(database)))


def client(dsn, cloud_key):
    store = AssetStore(dsn, cloud_key=cloud_key)
    store.apply_schema()
    app = FastAPI()

    def identity(x_test_actor: str = Header("owner")) -> Actor:
        return Actor(
            tenant_id="tenant",
            workspace_id="workspace",
            member_id="other-member" if x_test_actor == "other-member" else "member",
            subject_id=x_test_actor,
            can_ingest=x_test_actor in {"owner", "other-installation"},
            can_manage=x_test_actor == "owner",
            can_read=x_test_actor != "no-scope",
        )

    app.include_router(build_router(store, identity))
    app.include_router(build_catalog_router(store, identity))
    return TestClient(app)


def test_database_receipts_scope_conflict_and_delete(postgres_dsn):
    cloud_key = bytes(range(32))
    asset_id = "asset-01"
    revision_id = "rev-01"
    path = f"/conversations/{asset_id}/revisions/{revision_id}"
    body = {
        "mode": "cloudProcessable",
        "expectedRevision": None,
        "payload": {"messages": [{"id": "one", "content": "离线后仍可读取"}]},
    }
    headers = {"Idempotency-Key": "capture-01"}
    with client(postgres_dsn, cloud_key) as first_client:
        saved = first_client.put(path, json=body, headers=headers)
        assert saved.status_code in (200, 201), saved.text

    with client(postgres_dsn, cloud_key) as second_client:
        operation = second_client.get("/operations/capture-01")
        assert operation.status_code == 200, operation.text
        assert operation.json()["revisionId"] == revision_id
        fetched = second_client.get(path)
        assert fetched.status_code == 200, fetched.text
        assert fetched.json()["payload"] == body["payload"]

        replay = second_client.put(path, json=body, headers=headers)
        assert replay.status_code in (200, 201), replay.text
        changed = {**body, "payload": {"messages": []}}
        assert second_client.put(path, json=changed, headers=headers).status_code == 409

        assert second_client.get(path, headers={"X-Test-Actor": "other-member"}).status_code == 404
        assert second_client.get(path, headers={"X-Test-Actor": "no-scope"}).status_code == 403
        other_member_conversations = second_client.get("/conversations", headers={"X-Test-Actor": "other-member"})
        assert other_member_conversations.status_code == 200
        assert other_member_conversations.json()["items"] == []
        assert second_client.get("/operations/capture-01", headers={"X-Test-Actor": "other-installation"}).status_code == 404

        assert second_client.delete(f"/conversations/{asset_id}").status_code == 200
        assert second_client.get(path).status_code == 404
        assert second_client.get("/conversations").json()["items"] == []
        new_revision = f"/conversations/{asset_id}/revisions/rev-02"
        assert second_client.put(new_revision, json=body, headers={"Idempotency-Key": "capture-02"}).status_code == 409


def test_catalog_pages_stable_metadata_and_filters_by_member(postgres_dsn):
    body = {"mode": "cloudProcessable", "payload": {"messages": ["private text"]}}
    with client(postgres_dsn, bytes(range(32))) as http:
        for asset_id in ("two", "one"):
            saved = http.put(f"/conversations/{asset_id}/revisions/rev", json=body,
                             headers={"Idempotency-Key": f"catalog-{asset_id}"})
            assert saved.status_code == 201
        first = http.get("/catalog", params={"limit": 1}).json()
        entry, = first["items"]
        assert entry["assetId"] == first["nextAfter"] == "one"
        assert set(entry) == {"updatedAt", "mode", "assetId", "revisionId"}
        next_page = http.get("/catalog", params={"after": first["nextAfter"]}).json()
        assert [item["assetId"] for item in next_page["items"]] == ["two"]
        assert next_page["nextAfter"] is None
        assert http.get("/catalog", params={"mode": "userHeld"}).json()["items"] == []
        assert http.get("/catalog", headers={"X-Test-Actor": "other-member"}).json()["items"] == []
        assert http.get("/catalog", headers={"X-Test-Actor": "no-scope"}).status_code == 403


def test_concurrent_revision_writers_cannot_both_advance_the_head(postgres_dsn):
    cloud_key = bytes(range(32))
    with client(postgres_dsn, cloud_key) as http:
        base = "/conversations/concurrent-asset/revisions/"
        first_body = {"mode": "cloudProcessable", "expectedRevision": None, "payload": {"messages": []}}
        assert http.put(base + "start", json=first_body, headers={"Idempotency-Key": "start"}).status_code in (200, 201)

        def write_next(revision_id):
            body = {**first_body, "expectedRevision": "start", "payload": {"messages": [{"id": revision_id}]}}
            return http.put(base + revision_id, json=body, headers={"Idempotency-Key": revision_id}).status_code

        with ThreadPoolExecutor(max_workers=2) as executor:
            responses = list(executor.map(write_next, ("left", "right")))
        assert sum(status in (200, 201) for status in responses) == 1
        assert responses.count(409) == 1


def test_revision_chain_can_be_recovered_without_the_original_service(postgres_dsn, tmp_path):
    class Adapter:
        def __init__(self, http, actor="owner"):
            self.http = http
            self.actor = actor

        def request(self, method, path, *, body=None, operation_id=None):
            headers = {"X-Test-Actor": self.actor}
            if operation_id:
                headers["Idempotency-Key"] = operation_id
            response = self.http.request(method, "/" + path, json=body, headers=headers)
            response.raise_for_status()
            return response.json()

    chain = tmp_path / "assets.zip"
    first = "conversations/example/revisions/rev-a"
    second = "conversations/example/revisions/rev-b"
    cloud_key = bytes(range(32))
    with client(postgres_dsn, cloud_key) as source:
        source_api = Adapter(source)
        source_api.request("PUT", first, body={"mode": "cloudProcessable", "payload": {"messages": ["第一轮"]}}, operation_id="collect-a")
        source_api.request("PUT", second, body={"mode": "cloudProcessable", "expectedRevision": "rev-a", "payload": {"messages": ["第一轮", "第二轮"]}}, operation_id="collect-b")
        export_conversation(source_api, "example", "rev-b", chain)

    next_database = "assets_import_" + uuid4().hex
    admin_dsn = os.environ["XAGT_ASSETS_TEST_POSTGRES"]
    with psycopg.connect(admin_dsn, autocommit=True) as connection:
        connection.execute(sql.SQL("CREATE DATABASE {}").format(sql.Identifier(next_database)))
    try:
        with client(make_conninfo(admin_dsn, dbname=next_database), bytes(reversed(cloud_key))) as destination:
            destination_api = Adapter(destination)
            restored = restore_conversation(destination_api, chain)
            assert restored["revisionCount"] == 2
            assert restore_conversation(destination_api, chain) == restored
            assert destination_api.request("GET", first)["payload"]["messages"] == ["第一轮"]
            assert destination_api.request("GET", second)["payload"]["messages"] == ["第一轮", "第二轮"]
    finally:
        with psycopg.connect(admin_dsn, autocommit=True) as connection:
            connection.execute(sql.SQL("DROP DATABASE {} WITH (FORCE)").format(sql.Identifier(next_database)))
