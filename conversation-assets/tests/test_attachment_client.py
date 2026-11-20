from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from urllib.parse import urlsplit

from cryptography.hazmat.primitives.asymmetric import ed25519

from xagt_assets.attachment_client import AttachmentClient, AttachmentError, AttachmentUncertain
from xagt_assets.collector import Journal
from xagt_assets.crypto import generate_device_keypair


class _Response:
    status = 200

    def __init__(self, body=b"", headers=None):
        self.body = body if isinstance(body, bytes) else json.dumps(body).encode()
        self.headers = headers or {}

    def read(self, limit=None):
        return self.body


class _Service:
    def __init__(self):
        self.items = {}
        self.fail_put_once = False
        self.seen_bodies = []

    def __call__(self, request, timeout):
        path = urlsplit(request.full_url).path
        parts = [part for part in path.split("/") if part]
        body = request.data or b""
        self.seen_bodies.append(body)
        if request.get_method() == "POST" and parts[-1] == "attachments":
            meta = json.loads(body)
            key = (meta["assetId"] if "assetId" in meta else "a", meta["attachmentId"])
            # The actual service gets the asset/revision from the URL.  The
            # fake accepts the explicit fields used by the client contract.
            item = {"attachmentId": meta["attachmentId"], "assetId": "a", "revisionId": "r1",
                    "mode": meta["mode"], "contentType": meta["contentType"],
                    "expectedBytes": meta["expectedBytes"], "sha256": meta["sha256"],
                    "state": "staged"}
            if "envelope" in meta:
                item["envelope"] = meta["envelope"]
            self.items[key] = {"meta": item, "data": b""}
            return _Response(item)
        if request.get_method() == "PUT" and parts[-2] == "attachments":
            key = ("a", parts[-1])
            if self.fail_put_once:
                self.fail_put_once = False
                raise TimeoutError("response lost")
            self.items[key]["data"] = body
            return _Response({"state": "uploaded"})
        if request.get_method() == "POST" and parts[-1] == "commit":
            key = ("a", parts[-2])
            self.items[key]["meta"]["state"] = "committed"
            return _Response(self.items[key]["meta"])
        if request.get_method() == "GET" and parts[-1] == "attachments":
            return _Response({"items": [entry["meta"] for entry in self.items.values()
                                         if entry["meta"]["state"] == "committed"]})
        if request.get_method() == "GET" and parts[-2] == "attachments":
            return _Response(self.items[("a", parts[-1])]["data"])
        raise AssertionError((request.get_method(), path))


class AttachmentClientTests(unittest.TestCase):
    def test_cloud_attach_check_restore_keeps_source_unchanged(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            source = root / "report.txt"
            source.write_bytes(b"cloud attachment")
            before = source.read_bytes()
            service = _Service()
            client = AttachmentClient("https://assets.example", opener=service, max_bytes=1024)
            journal = Journal(root / "journal")
            result = client.attach(source, asset_id="a", revision_id="r1",
                                   mode="cloudProcessable", journal=journal)
            self.assertEqual(result["state"], "committed")
            self.assertEqual(source.read_bytes(), before)
            attachment_id = result["attachmentId"]
            checked = client.check(asset_id="a", revision_id="r1", attachment_id=attachment_id)
            self.assertTrue(checked["verified"])
            destination = root / "restored.txt"
            client.restore(asset_id="a", revision_id="r1", attachment_id=attachment_id,
                           destination=destination)
            self.assertEqual(destination.read_bytes(), before)

    def test_user_held_never_sends_plaintext_and_round_trips_with_trusted_signer(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            source = root / "secret.bin"
            source.write_bytes(b"private attachment")
            recipient_private, recipient_public = generate_device_keypair()
            signer_private = ed25519.Ed25519PrivateKey.generate().private_bytes_raw()
            signer_public = ed25519.Ed25519PrivateKey.from_private_bytes(signer_private).public_key().public_bytes_raw()
            service = _Service()
            client = AttachmentClient("https://assets.example", opener=service, max_bytes=1024)
            journal = Journal(root / "journal")
            result = client.attach(source, asset_id="a", revision_id="r1", mode="userHeld",
                                   journal=journal, recipient_public_key=recipient_public,
                                   signer_private_key=signer_private, recipient_device_id="phone-1",
                                   signer_device_id="desktop-1", grant_id="grant-1")
            self.assertEqual(result["state"], "committed")
            self.assertFalse(any(b"private attachment" in body for body in service.seen_bodies))
            attachment_id = result["attachmentId"]
            checked = client.check(asset_id="a", revision_id="r1", attachment_id=attachment_id,
                                   recipient_private_key=recipient_private, signer_public_key=signer_public)
            self.assertTrue(checked["verified"])
            destination = root / "restored.bin"
            client.restore(asset_id="a", revision_id="r1", attachment_id=attachment_id,
                           destination=destination, recipient_private_key=recipient_private,
                           signer_public_key=signer_public)
            self.assertEqual(destination.read_bytes(), source.read_bytes())

    def test_uncertain_put_is_resumable_from_journal_without_source(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            source = root / "resume.txt"
            source.write_bytes(b"resume me")
            service = _Service()
            service.fail_put_once = True
            client = AttachmentClient("https://assets.example", opener=service, max_bytes=1024)
            journal = Journal(root / "journal")
            with self.assertRaises(AttachmentUncertain):
                client.attach(source, asset_id="a", revision_id="r1",
                              mode="cloudProcessable", journal=journal,
                              operation_id="operation-resume")
            source.unlink()
            result = client.retry("operation-resume", journal=journal)
            self.assertEqual(result["state"], "committed")

    def test_size_and_mode_fail_before_network_mutation(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            source = root / "too-large.bin"
            source.write_bytes(b"12345")
            service = _Service()
            client = AttachmentClient("https://assets.example", opener=service, max_bytes=4)
            with self.assertRaises(AttachmentError):
                client.attach(source, asset_id="a", revision_id="r1",
                              mode="cloudProcessable", journal=Journal(root / "journal"))
            self.assertEqual(service.seen_bodies, [])
