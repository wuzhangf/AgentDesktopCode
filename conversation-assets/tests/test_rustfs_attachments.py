import hashlib
import json
import os

import pytest

from xagt_assets import Actor, AssetStore, AttachmentService
from xagt_assets.collector import CollectedRevision, make_user_held_payload
from xagt_assets.crypto import generate_device_keypair
from xagt_assets.object_store import S3ObjectStore


pytestmark = pytest.mark.skipif(
    not os.getenv("XAGT_ASSETS_TEST_S3_ENDPOINT"), reason="isolated S3 endpoint is not configured"
)


def _object_store():
    return S3ObjectStore(
        os.environ["XAGT_ASSETS_TEST_S3_ENDPOINT"],
        os.environ["XAGT_ASSETS_TEST_S3_SOURCE_BUCKET"],
        os.environ["XAGT_ASSETS_TEST_S3_ACCESS_KEY"],
        os.environ["XAGT_ASSETS_TEST_S3_SECRET_KEY"],
        region=os.getenv("XAGT_ASSETS_TEST_S3_REGION", "us-east-1"),
    )


def test_real_rustfs_attachment_modes_are_private_and_retryable():
    actor = Actor("t", "w", "m", "s", can_ingest=True, can_manage=True, can_read=True)
    store = AssetStore("sqlite:///:memory:", cloud_key=b"0123456789abcdef0123456789abcdef")
    store.apply_schema()
    attachments = AttachmentService(store, _object_store(), max_bytes=1024)
    store.put_revision(actor, "cloud", "r1", "cloudProcessable", None, {"ok": True}, "rev-cloud")
    content = b"private rustfs cloud object"
    digest = hashlib.sha256(content).hexdigest()
    created = attachments.create(actor, "cloud", "r1", "att", mode="cloudProcessable",
                                 content_type="text/plain", expected_bytes=len(content), sha256=digest)
    attachments.upload(actor, "cloud", "r1", "att", content)
    assert attachments.commit(actor, "cloud", "r1", "att")["state"] == "committed"
    assert attachments.upload(actor, "cloud", "r1", "att", content)["replayed"] is True
    assert attachments.read(actor, "cloud", "r1", "att")[0] == content
    # One object was written under an opaque, scoped random key.
    assert created["attachmentId"] == "att"

    private, public = generate_device_keypair()
    from cryptography.hazmat.primitives.asymmetric import ed25519
    signer = ed25519.Ed25519PrivateKey.generate().private_bytes_raw()
    revision = CollectedRevision("held", "r1", {"secret": "not server plaintext"}, ())
    payload = make_user_held_payload(revision, recipient_public_key=public,
                                     signer_private_key=signer, recipient_device_id="d",
                                     signer_device_id="s", grant_id="g")
    held_bytes = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()
    store.put_revision(actor, "held", "r1", "userHeld", None, payload, "rev-held")
    held = AttachmentService(store, _object_store(), max_bytes=1024)
    held.create(actor, "held", "r1", "att", mode="userHeld", content_type="application/json",
                expected_bytes=len(held_bytes), sha256=hashlib.sha256(held_bytes).hexdigest(),
                envelope=payload["envelope"])
    held.upload(actor, "held", "r1", "att", held_bytes)
    held.commit(actor, "held", "r1", "att")
    assert held.read(actor, "held", "r1", "att")[0] == held_bytes
