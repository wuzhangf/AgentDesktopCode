"""Exercise the wire contract against an isolated PostgreSQL database."""

import os
from concurrent.futures import ThreadPoolExecutor
from uuid import uuid4

import psycopg
import pytest
from fastapi import FastAPI, Header
from fastapi.testclient import TestClient
from psycopg import sql
from psycopg.conninfo import make_conninfo

from xagt_assets.api import Actor, build_router
from xagt_assets.portability import export_conversation, restore_conversation
from xagt_assets.store import AssetStore


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
