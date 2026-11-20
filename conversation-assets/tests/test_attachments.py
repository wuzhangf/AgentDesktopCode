import hashlib
import json

import pytest
from cryptography.hazmat.primitives.asymmetric import ed25519
from fastapi import FastAPI
from fastapi.testclient import TestClient

from xagt_assets import Actor, AssetStore, AttachmentService, InMemoryObjectStore, build_router
from xagt_assets.collector import CollectedRevision, make_user_held_payload
from xagt_assets.crypto import generate_device_keypair
from xagt_assets.object_store import ObjectNotFound, ObjectStoreError


KEY = b"0123456789abcdef0123456789abcdef"


def _app(store, actor, service):
    app = FastAPI()
    app.include_router(build_router(store, lambda: actor, service), prefix="/assets/v1")
    return TestClient(app)


def test_cloud_attachment_stages_encrypts_and_commits():
    store = AssetStore("sqlite:///:memory:", cloud_key=KEY)
    store.apply_schema()
    objects = InMemoryObjectStore()
    attachments = AttachmentService(store, objects, max_bytes=1024)
    actor = Actor("t", "w", "m", "s", can_ingest=True, can_manage=True, can_read=True)
    client = _app(store, actor, attachments)
    assert client.put("/assets/v1/conversations/a/revisions/r1",
                      headers={"Idempotency-Key": "rev-1"},
                      json={"mode": "cloudProcessable", "payload": {"message": "root"}}).status_code == 201
    content = b"member-only attachment"
    create = client.post("/assets/v1/conversations/a/revisions/r1/attachments", json={
        "attachmentId": "att-1", "mode": "cloudProcessable", "contentType": "text/plain",
        "expectedBytes": len(content), "sha256": hashlib.sha256(content).hexdigest(),
    })
    assert create.status_code == 201 and create.json()["state"] == "staged"
    assert client.get("/assets/v1/conversations/a/revisions/r1/attachments").json()["items"] == []
    upload = client.put("/assets/v1/conversations/a/revisions/r1/attachments/att-1", content=content)
    assert upload.status_code == 200
    assert client.post("/assets/v1/conversations/a/revisions/r1/attachments/att-1/commit").json()["state"] == "committed"
    read = client.get("/assets/v1/conversations/a/revisions/r1/attachments/att-1")
    assert read.status_code == 200 and read.content == content
    raw, _ = objects.get(next(iter(objects._items)))
    assert b"member-only attachment" not in raw
    assert client.post("/assets/v1/conversations/a/revisions/r1/attachments/att-1/commit").json()["replayed"] is True


def test_user_held_attachment_never_accepts_plaintext_and_round_trips_ciphertext():
    store = AssetStore("sqlite:///:memory:", cloud_key=None, allowed_modes={"userHeld"})
    store.apply_schema()
    objects = InMemoryObjectStore()
    attachments = AttachmentService(store, objects)
    actor = Actor("t", "w", "m", "s", can_ingest=True, can_manage=True, can_read=True)
    client = _app(store, actor, attachments)
    assert client.put("/assets/v1/conversations/a/revisions/r1",
                      headers={"Idempotency-Key": "rev-1"},
                      json={"mode": "userHeld", "payload": {"object": {}}}).status_code == 400
    # The revision itself is supplied as a valid opaque user-held payload.
    private, public = generate_device_keypair()
    signer = ed25519.Ed25519PrivateKey.generate().private_bytes_raw()
    revision = CollectedRevision("a", "r1", {"message": "ciphertext only"}, ())
    payload = make_user_held_payload(revision, recipient_public_key=public,
                                     signer_private_key=signer, recipient_device_id="d",
                                     signer_device_id="s", grant_id="g")
    body = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()
    assert client.put("/assets/v1/conversations/a/revisions/r1",
                      headers={"Idempotency-Key": "rev-2"}, json={"mode": "userHeld", "payload": payload}).status_code == 201
    digest = hashlib.sha256(body).hexdigest()
    create = client.post("/assets/v1/conversations/a/revisions/r1/attachments", json={
        "attachmentId": "att-1", "mode": "userHeld", "contentType": "application/json",
        "expectedBytes": len(body), "sha256": digest, "envelope": payload["envelope"],
    })
    assert create.status_code == 201
    assert client.put("/assets/v1/conversations/a/revisions/r1/attachments/att-1", content=body).status_code == 200
    assert client.post("/assets/v1/conversations/a/revisions/r1/attachments/att-1/commit").status_code == 200
    response = client.get("/assets/v1/conversations/a/revisions/r1/attachments/att-1")
    assert response.status_code == 200 and response.content == body
    assert client.get("/assets/v1/capabilities").json()["modes"] == ["userHeld"]


def test_cloud_upload_reconciles_object_written_before_lost_response():
    class LostResponseStore(InMemoryObjectStore):
        def __init__(self):
            super().__init__()
            self.lost = True

        def put(self, key, data, *, content_type):
            metadata = super().put(key, data, content_type=content_type)
            if self.lost:
                self.lost = False
                raise RuntimeError("response lost after object write")
            return metadata

    store = AssetStore("sqlite:///:memory:", cloud_key=KEY)
    store.apply_schema()
    objects = LostResponseStore()
    attachments = AttachmentService(store, objects, max_bytes=1024)
    actor = Actor("t", "w", "m", "s", can_ingest=True, can_manage=True, can_read=True)
    store.put_revision(actor, "a", "r", "cloudProcessable", None, {"ok": True}, "rev")
    data = b"retry me"
    attachments.create(actor, "a", "r", "att", mode="cloudProcessable",
                       content_type="application/octet-stream", expected_bytes=len(data),
                       sha256=hashlib.sha256(data).hexdigest())
    try:
        attachments.upload(actor, "a", "r", "att", data)
    except RuntimeError:
        pass
    else:
        raise AssertionError("test store must lose the first response")
    assert attachments.upload(actor, "a", "r", "att", data)["replayed"] is True
    assert attachments.commit(actor, "a", "r", "att")["state"] == "committed"


def test_tombstoned_attachment_cleanup_retries_failed_object_delete():
    class BusyObjectStore(InMemoryObjectStore):
        def __init__(self):
            super().__init__()
            self.fail_delete = True

        def delete(self, key):
            if self.fail_delete:
                raise ObjectStoreError("cleanup offline")
            super().delete(key)

    store = AssetStore("sqlite:///:memory:", cloud_key=KEY)
    store.apply_schema()
    objects = BusyObjectStore()
    attachments = AttachmentService(store, objects, max_bytes=1024)
    actor = Actor("t", "w", "m", "s", can_ingest=True, can_manage=True, can_read=True)
    store.put_revision(actor, "a", "r", "cloudProcessable", None, {"ok": True}, "rev")
    data = b"cleanup after object service recovery"
    attachments.create(actor, "a", "r", "att", mode="cloudProcessable",
                       content_type="application/octet-stream", expected_bytes=len(data),
                       sha256=hashlib.sha256(data).hexdigest())
    attachments.upload(actor, "a", "r", "att", data)
    attachments.commit(actor, "a", "r", "att")
    object_key = next(iter(objects._items))

    with pytest.raises(ObjectStoreError, match="cleanup offline"):
        store.delete_conversation(actor, "a")
    with pytest.raises(FileNotFoundError):
        attachments.read(actor, "a", "r", "att")
    assert objects.head(object_key).key == object_key

    objects.fail_delete = False
    assert attachments.cleanup_staged() == 1
    assert attachments.cleanup_staged() == 0
    assert store.delete_conversation(actor, "a")["state"] == "deleted"
    with pytest.raises(ObjectNotFound):
        objects.head(object_key)
