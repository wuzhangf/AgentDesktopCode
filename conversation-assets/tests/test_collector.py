from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from urllib.parse import urlparse

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ed25519

import sys

sys.path.insert(0, str(Path(__file__).parents[1] / "src"))

from xagt_assets.collector import (  # noqa: E402
    AssetUploader,
    CollectorError,
    Journal,
    UploadUncertain,
    collect_source,
    make_user_held_payload,
)
from xagt_assets.crypto import generate_device_keypair


class _Response:
    status = 200

    def __init__(self, value):
        self.value = value

    def read(self):
        return json.dumps(self.value).encode("utf-8")


class CollectorTests(unittest.TestCase):
    def test_jsonl_is_read_only_and_reports_bad_line(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "session.jsonl"
            source.write_bytes(
                b'{"id":"u1","role":"user","content":"hello"}\n'
                b'broken-json\n'
                b'{"id":"a1","message":{"role":"assistant","content":[{"type":"text","text":"done"}]}}\n'
            )
            before = source.read_bytes()
            revision = collect_source(source, source_root=root)
            self.assertEqual(before, source.read_bytes())
            self.assertEqual(revision.payload["recordCount"], 2)
            self.assertEqual(revision.payload["coverage"]["status"], "partial")
            self.assertEqual(revision.payload["coverage"]["damage"][0]["line"], 2)
            self.assertEqual(revision.payload["files"][0]["records"][1]["role"], "assistant")
            self.assertTrue(revision.revisionId.startswith("rev-"))

    def test_directory_is_stable_and_ignores_unsupported_files(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "b.jsonl").write_text('{"id":"b"}\n', encoding="utf-8")
            (root / "a.jsonl").write_text('{"id":"a"}\n', encoding="utf-8")
            (root / "README.txt").write_text("do not read", encoding="utf-8")
            one = collect_source(root, source_root=root)
            two = collect_source(root, source_root=root)
            self.assertEqual(one.assetId, two.assetId)
            self.assertEqual(one.revisionId, two.revisionId)
            self.assertEqual([f["path"] for f in one.payload["files"]], ["a.jsonl", "b.jsonl"])

    def test_source_outside_root_is_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "root"
            root.mkdir()
            outside = Path(temporary) / "outside.jsonl"
            outside.write_text('{"id":"outside"}\n', encoding="utf-8")
            with self.assertRaises(CollectorError):
                collect_source(outside, source_root=root)

    def test_lost_upload_response_reconciles_with_same_key(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "session.jsonl"
            source.write_text('{"id":"u1","role":"user","text":"hello"}\n', encoding="utf-8")
            revision = collect_source(source, source_root=root)
            journal = Journal(root / "journal")
            calls = []

            def opener(request, timeout):
                calls.append((request.get_method(), urlparse(request.full_url).path,
                              request.headers.get("Idempotency-key")))
                if len(calls) == 1:
                    raise TimeoutError("response lost")
                return _Response({"operationId": calls[0][2], "state": "committed"})

            uploader = AssetUploader("https://assets.example", opener=opener)
            with self.assertRaises(UploadUncertain):
                uploader.upload(revision, mode="cloudProcessable", journal=journal,
                                operation_id="op-fixed")
            self.assertEqual(journal.load("op-fixed")["state"], "reconciling")
            result = uploader.reconcile("op-fixed", journal=journal)
            self.assertEqual(result["state"], "committed")
            self.assertEqual(calls[0][2], "op-fixed")
            self.assertEqual(calls[1][2], "op-fixed")

    def test_same_operation_cannot_change_payload(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "session.jsonl"
            source.write_text('{"id":"u1"}\n', encoding="utf-8")
            revision = collect_source(source, source_root=root)
            journal = Journal(root / "journal")
            seen = []

            def opener(request, timeout):
                seen.append(request)
                return _Response({"state": "committed"})

            uploader = AssetUploader("https://assets.example", opener=opener)
            _, recipient_public = generate_device_keypair()
            signer = ed25519.Ed25519PrivateKey.generate().private_bytes(
                serialization.Encoding.Raw, serialization.PrivateFormat.Raw,
                serialization.NoEncryption())
            payload = make_user_held_payload(
                revision, recipient_public_key=recipient_public,
                signer_private_key=signer, recipient_device_id="device-1",
                signer_device_id="device-source", grant_id="grant-1")
            uploader.upload(revision, mode="userHeld", journal=journal, operation_id="op-fixed",
                            user_held_payload=payload)
            with self.assertRaises(CollectorError):
                uploader.upload(revision, mode="cloudProcessable", journal=journal,
                                operation_id="op-fixed")
            self.assertEqual(len(seen), 1)

    def test_retry_replays_the_exact_journaled_body(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "session.jsonl"
            source.write_text('{"id":"s1","type":"session","timestamp":"2026-01-01T00:00:00Z"}\n',
                              encoding="utf-8")
            revision = collect_source(source, source_root=root)
            journal = Journal(root / "journal")
            calls = []

            def opener(request, timeout):
                calls.append((request.get_method(), request.full_url,
                              request.data, request.headers.get("Idempotency-key")))
                return _Response({"operationId": "op-retry", "state": "committed"})

            uploader = AssetUploader("https://assets.example", opener=opener)
            # Seed an uncertain operation; the journal body is the only source
            # used by retry, so the source may disappear before resumption.
            original = uploader.request
            def uncertain(*args, **kwargs):
                raise UploadUncertain("lost")
            uploader.request = uncertain
            with self.assertRaises(UploadUncertain):
                uploader.upload(revision, mode="cloudProcessable", journal=journal,
                                operation_id="op-retry")
            request_body = journal.load("op-retry")["requestBody"]
            uploader.request = original
            result = uploader.retry("op-retry", journal=journal)
            self.assertEqual(result["state"], "committed")
            self.assertEqual(len(calls), 1)
            self.assertEqual(json.loads(calls[0][2]), request_body)
            self.assertNotIn("requestBody", journal.load("op-retry"))
            self.assertEqual(calls[0][3], "op-retry")

    def test_session_identity_is_stable_and_not_filename_only(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "rollout.jsonl"
            source.write_text('{"type":"session","id":"session-a"}\n', encoding="utf-8")
            one = collect_source(source, source_root=root, installation_id="install-a")
            source.rename(root / "renamed.jsonl")
            two = collect_source(root / "renamed.jsonl", source_root=root, installation_id="install-a")
            self.assertEqual(one.assetId, two.assetId)
            self.assertEqual(one.payload["source"]["sessionId"], "session-a")


if __name__ == "__main__":
    unittest.main()
