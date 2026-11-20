import hashlib
import os
from uuid import uuid4

import psycopg
import pytest
from psycopg import sql
from psycopg.conninfo import make_conninfo

from xagt_assets import Actor, AssetStore, AttachmentService
from xagt_assets.object_store import ObjectNotFound, S3ObjectStore


@pytest.fixture
def postgres_dsn():
    admin_dsn = os.environ.get("XAGT_ASSETS_TEST_POSTGRES")
    if not admin_dsn:
        pytest.skip("set XAGT_ASSETS_TEST_POSTGRES to an isolated PostgreSQL server")
    database = "assets_att_" + uuid4().hex
    with psycopg.connect(admin_dsn, autocommit=True) as connection:
        connection.execute(sql.SQL("CREATE DATABASE {} ").format(sql.Identifier(database)))
    try:
        yield make_conninfo(admin_dsn, dbname=database)
    finally:
        with psycopg.connect(admin_dsn, autocommit=True) as connection:
            connection.execute(sql.SQL("DROP DATABASE {} WITH (FORCE)").format(sql.Identifier(database)))


@pytest.mark.skipif(not os.getenv("XAGT_ASSETS_TEST_S3_ENDPOINT"), reason="isolated S3 endpoint is not configured")
def test_postgres_and_rustfs_attachment_lifecycle(postgres_dsn):
    actor = Actor("tenant", "workspace", "member", "subject",
                  can_ingest=True, can_manage=True, can_read=True)
    backend = S3ObjectStore(
        os.environ["XAGT_ASSETS_TEST_S3_ENDPOINT"],
        os.environ["XAGT_ASSETS_TEST_S3_SOURCE_BUCKET"],
        os.environ["XAGT_ASSETS_TEST_S3_ACCESS_KEY"],
        os.environ["XAGT_ASSETS_TEST_S3_SECRET_KEY"],
        region=os.getenv("XAGT_ASSETS_TEST_S3_REGION", "us-east-1"),
    )
    store = AssetStore(postgres_dsn, cloud_key=bytes(range(32)))
    store.apply_schema()
    attachments = AttachmentService(store, backend, max_bytes=1024)
    store.put_revision(actor, "asset", "rev", "cloudProcessable", None, {"ok": True}, "revision")
    data = b"PG + RustFS attachment"
    row = attachments.create(actor, "asset", "rev", "attachment", mode="cloudProcessable",
                             content_type="text/plain", expected_bytes=len(data),
                             sha256=hashlib.sha256(data).hexdigest())
    with store.connection() as connection:
        object_key = store._query(
            connection,
            "SELECT object_key FROM xagt_asset_attachments WHERE tenant_id=? AND workspace_id=? "
            "AND member_id=? AND asset_id=? AND revision_id=? AND attachment_id=?",
            ("tenant", "workspace", "member", "asset", "rev", "attachment"),
        )[0]["object_key"]
    attachments.upload(actor, "asset", "rev", "attachment", data)
    assert attachments.commit(actor, "asset", "rev", "attachment")["state"] == "committed"
    assert attachments.read(actor, "asset", "rev", "attachment")[0] == data
    assert attachments.upload(actor, "asset", "rev", "attachment", data)["replayed"] is True
    attachments.delete(actor, "asset", "rev", "attachment")
    with pytest.raises(ObjectNotFound):
        backend.get(object_key)
