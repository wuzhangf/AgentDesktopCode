from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ed25519

sys.path.insert(0, str(Path(__file__).parents[1] / "src"))

from xagt_assets.bundle import export_bundle  # noqa: E402
from xagt_assets.collector import collect_source, make_user_held_payload  # noqa: E402
from xagt_assets.crypto import generate_device_keypair  # noqa: E402
from xagt_assets.local_search import (  # noqa: E402
    SearchError,
    extract_messages,
    keyword_matches,
    search_bundle,
    search_messages,
)


class LocalSearchTests(unittest.TestCase):
    def test_pi_rows_are_deduplicated_and_tools_excluded(self):
        payload = {
            "files": [{"path": "session.jsonl", "records": [
                {"messageId": "m1", "role": "user", "text": "部署服务"},
                {"messageId": "m1", "role": "user", "text": "部署服务"},
                {"messageId": "tool-1", "role": "tool", "text": "secret command"},
                {"messageId": "m2", "role": "assistant", "text": "use grep -R foo"},
            ]}]
        }
        messages = extract_messages(payload)
        self.assertEqual([item.message_id for item in messages], ["m1", "m2"])
        self.assertTrue(keyword_matches(messages[0].text, "部署"))
        self.assertTrue(keyword_matches(messages[1].text, "GREP -R FOO"))
        self.assertEqual(search_messages(messages, "grep")[0].source_ref, "session.jsonl#record-3")

    def test_acs_rows_use_stable_refs_and_bound_text(self):
        payload = {"rows": [
            {"messageId": "a1", "role": "user", "text": "Hello world", "sourcePage": 1},
            {"messageId": "a1", "role": "user", "text": "Hello world", "sourcePage": 2},
            {"messageId": "a2", "role": "assistant", "text": "tool result", "kind": "tool_result"},
            {"messageId": "a3", "role": "assistant", "text": "x" * 30, "sourcePage": 3},
        ]}
        messages = extract_messages(payload, max_text_chars=10)
        self.assertEqual([item.message_id for item in messages], ["a1", "a3"])
        self.assertEqual(messages[0].source_ref, "sourcePage=1")
        self.assertTrue(messages[1].truncated)
        self.assertEqual(search_messages(payload, "WORLD")[0].role, "user")

    def test_invalid_bounds_and_empty_keyword_fail_closed(self):
        with self.assertRaises(SearchError):
            extract_messages({"rows": []}, max_text_chars=0)
        with self.assertRaises(SearchError):
            keyword_matches("abc", "")
        with self.assertRaises(SearchError):
            search_messages({"rows": []}, "x", limit=0)

    def _write_key(self, directory: Path, name: str, value: bytes) -> Path:
        path = directory / name
        path.write_bytes(value)
        return path

    def test_search_verified_cloud_and_user_held_bundles_without_network(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "session.jsonl"
            source.write_text(
                '{"id":"m1","role":"user","text":"find secret phrase"}\n'
                '{"id":"m2","role":"assistant","text":"普通话回答"}\n',
                encoding="utf-8")
            revision = collect_source(source, source_root=root,
                                      installation_id="install-a", store_id="pi",
                                      session_id="session-a")
            cloud_record = {"assetId": revision.assetId, "revisionId": revision.revisionId,
                            "mode": "cloudProcessable", "payload": revision.payload}
            cloud_bundle = root / "cloud.zip"
            export_bundle(cloud_bundle, files={
                f"revisions/{revision.revisionId}.json": json.dumps(cloud_record).encode("utf-8")})
            cloud_hits = search_bundle(cloud_bundle, asset_id=revision.assetId,
                                       revision_id=revision.revisionId, query="secret")
            self.assertEqual(len(cloud_hits), 1)
            self.assertEqual(cloud_hits[0].message_id, "m1")

            recipient_private, recipient_public = generate_device_keypair()
            signer_private = ed25519.Ed25519PrivateKey.generate().private_bytes(
                serialization.Encoding.Raw, serialization.PrivateFormat.Raw,
                serialization.NoEncryption())
            signer_public = ed25519.Ed25519PrivateKey.from_private_bytes(signer_private).public_key().public_bytes(
                serialization.Encoding.Raw, serialization.PublicFormat.Raw)
            opaque = make_user_held_payload(
                revision, recipient_public_key=recipient_public, signer_private_key=signer_private,
                recipient_device_id="phone-1", signer_device_id="desktop-1", grant_id="grant-1")
            held_record = {"assetId": revision.assetId, "revisionId": revision.revisionId,
                           "mode": "userHeld", "payload": opaque}
            held_bundle = root / "held.zip"
            export_bundle(held_bundle, files={
                f"revisions/{revision.revisionId}.json": json.dumps(held_record).encode("utf-8")})
            recipient_path = self._write_key(root, "recipient.key", recipient_private)
            signer_path = self._write_key(root, "signer.pub", signer_public)
            held_hits = search_bundle(
                held_bundle, asset_id=revision.assetId, revision_id=revision.revisionId,
                query="普通话", recipient_private_key_path=recipient_path,
                signer_public_key_path=signer_path)
            self.assertEqual(len(held_hits), 1)
            self.assertEqual(held_hits[0].role, "assistant")
            self.assertFalse(any(path.name == "unlocked.json" for path in root.iterdir()))


if __name__ == "__main__":
    unittest.main()
