from __future__ import annotations

import json
import sys
import tempfile
import unittest
from unittest.mock import patch
from pathlib import Path
from threading import Thread
from urllib.parse import urlparse

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ed25519

sys.path.insert(0, str(Path(__file__).parents[1] / "src"))

from xagt_assets.auto import AutoArchive, AutoArchiveBusy, AutoSource, _StateLock  # noqa: E402
from xagt_assets.collector import AssetUploader, UploadUncertain, collect_source  # noqa: E402
from xagt_assets.crypto import generate_device_keypair  # noqa: E402


class _Response:
    status = 200

    def __init__(self, value):
        self.value = value

    def read(self):
        return json.dumps(self.value).encode("utf-8")


class AutoArchiveTests(unittest.TestCase):
    def _source(self, root: Path, *, mode: str = "cloudProcessable", **kwargs):
        return AutoSource(path=root / "session.jsonl", root=root,
                          installation_id="desktop-a", store_id="codex",
                          mode=mode, **kwargs)

    def _archive(self, root: Path, source: AutoSource, opener, *, upload_partial=False,
                 suffix: str = ""):
        return AutoArchive([source], base_url="https://assets.example",
                           journal_dir=root.parent / (root.name + "-journal" + suffix),
                           state_path=root.parent / (root.name + "-state" + suffix + ".json"),
                           uploader=AssetUploader("https://assets.example", opener=opener),
                           upload_partial=upload_partial)

    def test_allowlisted_source_is_read_only_and_skips_unchanged_poll(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "session.jsonl"
            source.write_text('{"id":"m1","role":"user","text":"one"}\n', encoding="utf-8")
            before = source.read_bytes()
            calls = []

            def opener(request, timeout):
                calls.append((request.get_method(), request.data, request.headers.get("Idempotency-key")))
                return _Response({"state": "committed", "revisionId": "remote"})

            archive = self._archive(root, self._source(root), opener)
            first = archive.run_once()
            second = archive.run_once()
            self.assertEqual(first["sources"][0]["status"], "committed")
            self.assertEqual(second["sources"][0]["status"], "unchanged")
            self.assertEqual(len(calls), 1)
            self.assertEqual(before, source.read_bytes())
            state = json.loads((root.parent / (root.name + "-state.json")).read_text(encoding="utf-8"))
            self.assertEqual(state["sources"].popitem()[1]["status"], "committed")

    def test_missing_and_damaged_sources_are_explicitly_reported(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = self._source(root)
            calls = []
            archive = self._archive(root, source, lambda request, timeout: calls.append(request))
            missing = archive.run_once()
            self.assertEqual(missing["sources"][0]["status"], "missing")

            (root / "session.jsonl").write_bytes(b'{"id":"ok"}\nbroken-json\n')
            partial = archive.run_once()
            self.assertEqual(partial["sources"][0]["status"], "partial")
            self.assertEqual(calls, [])
            uploaded = self._archive(root, source,
                                     lambda request, timeout: _Response({"state": "committed"}),
                                     upload_partial=True, suffix="-partial").run_once()
            self.assertEqual(uploaded["sources"][0]["status"], "committed")

    def test_uncertain_operation_restarts_with_exact_journal_body(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "session.jsonl").write_text('{"id":"m1"}\n', encoding="utf-8")
            calls = []

            def opener(request, timeout):
                calls.append((request.get_method(), urlparse(request.full_url).path,
                              request.data, request.headers.get("Idempotency-key")))
                if len(calls) == 1:
                    raise TimeoutError("lost response")
                if request.get_method() == "GET":
                    return _Response({"state": "unknown"})
                return _Response({"state": "committed"})

            archive = self._archive(root, self._source(root), opener)
            pending = archive.run_once()
            self.assertEqual(pending["sources"][0]["status"], "pending")
            body = calls[0][2]
            operation_id = calls[0][3]
            committed = archive.run_once()
            self.assertEqual(committed["sources"][0]["status"], "unchanged")
            self.assertEqual(calls[1][1], f"/operations/{operation_id}")
            self.assertEqual(calls[2][2], body)
            self.assertEqual(calls[2][3], operation_id)

    def test_user_held_mode_loads_trusted_key_files_without_persisting_keys(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "session.jsonl").write_text('{"id":"m1","text":"secret"}\n', encoding="utf-8")
            key_root = root.parent / (root.name + "-keys")
            key_root.mkdir()
            recipient_private, recipient_public = generate_device_keypair()
            signer_private = ed25519.Ed25519PrivateKey.generate().private_bytes(
                serialization.Encoding.Raw, serialization.PrivateFormat.Raw,
                serialization.NoEncryption())
            public_path = key_root / "recipient.pub"
            private_path = key_root / "signer.key"
            public_path.write_bytes(recipient_public)
            private_path.write_bytes(signer_private)
            source = self._source(root, mode="userHeld",
                                  recipient_public_key_file=public_path,
                                  signer_private_key_file=private_path,
                                  recipient_device_id="phone-1", signer_device_id="desktop-1")
            seen = []

            def opener(request, timeout):
                seen.append(json.loads(request.data))
                return _Response({"state": "committed"})

            result = self._archive(root, source, opener).run_once()
            self.assertEqual(result["sources"][0]["status"], "committed")
            self.assertEqual(seen[0]["mode"], "userHeld")
            self.assertEqual(set(seen[0]["payload"]), {"object", "envelope"})
            state_text = (root.parent / (root.name + "-state.json")).read_text(encoding="utf-8")
            self.assertNotIn(signer_private.hex(), state_text)
            self.assertNotIn(recipient_public.hex(), state_text)

    def test_lock_refuses_live_concurrent_owner_and_releases_on_shutdown(self):
        with tempfile.TemporaryDirectory() as temporary:
            lock_path = Path(temporary) / "state.lock"
            first = _StateLock(lock_path)
            first.__enter__()
            try:
                with self.assertRaises(AutoArchiveBusy):
                    with _StateLock(lock_path):
                        pass
            finally:
                first.__exit__(None, None, None)
            with _StateLock(lock_path):
                pass
            self.assertFalse(lock_path.exists())

    def test_acs_source_uses_explicit_observe_and_bearer_environment(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            fixture = root / "fixture.jsonl"
            fixture.write_text('{"id":"acs-message"}\n', encoding="utf-8")
            revision = collect_source(fixture, source_root=root,
                                      installation_id="acs-install", store_id="acs",
                                      session_id="acs-session")
            source = AutoSource(
                path=None, root=None, installation_id="acs-install", store_id="acs",
                session_id="acs-session", kind="acs", acs_base_url="https://acs.example",
                acs_client_session_token_env="XAGT_TEST_ACS_CLIENT_TOKEN",
                acs_scope=("OBSERVE",),
            )
            seen = []

            def opener(request, timeout):
                seen.append(json.loads(request.data))
                return _Response({"state": "committed"})

            with patch.dict("os.environ", {"XAGT_TEST_ACS_CLIENT_TOKEN": "authorized"}), \
                    patch("xagt_assets.acs_reader.AcsReader.__init__", return_value=None) as init, \
                    patch("xagt_assets.acs_reader.AcsReader.read", return_value=revision) as read:
                archive = AutoArchive(
                    [source], base_url="https://assets.example",
                    journal_dir=root.parent / (root.name + "-acs-journal"),
                    state_path=root.parent / (root.name + "-acs-state.json"),
                    uploader=AssetUploader("https://assets.example", opener=opener),
                )
                result = archive.run_once()
            self.assertEqual(result["sources"][0]["status"], "committed")
            read.assert_called_once()
            self.assertEqual(init.call_args.kwargs["client_session_token"], "authorized")
            self.assertEqual(seen[0]["mode"], "cloudProcessable")


if __name__ == "__main__":
    unittest.main()
