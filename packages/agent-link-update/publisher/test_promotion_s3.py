"""Exercise publication recovery against a fresh loopback S3 test service."""
from datetime import UTC, datetime, timedelta
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
from threading import Thread
import time
import unittest
from urllib.parse import unquote, urlsplit
from uuid import uuid4

from botocore.exceptions import ClientError
from securesystemslib.signer import CryptoSigner
from tuf.api.metadata import Metadata, Role, Root

from promote import CATALOG, STATE_KEY, TIMESTAMP, Storage

HERE = Path(__file__).resolve().parent


@unittest.skipUnless(os.environ.get("AGENT_LINK_TEST_S3") == "1", "Requires an isolated loopback S3 service")
class PromotionTest(unittest.TestCase):
    def setUp(self):
        endpoint = urlsplit(os.environ["AWS_ENDPOINT_URL"])
        self.assertIn(endpoint.hostname, ("127.0.0.1", "::1"))
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.directory = Path(temporary.name)
        self.roots = self.directory / "roots"
        self.roots.mkdir()
        suffix = uuid4().hex[:12]
        self.storage = Storage("link-release-test-" + suffix, "link-state-test-" + suffix)
        self.storage.s3.create_bucket(Bucket=self.storage.releases)
        self.storage.s3.create_bucket(Bucket=self.storage.state)
        self.addCleanup(self.clean_buckets)
        keys = {role: [CryptoSigner.generate_ed25519() for _ in range(count)]
                for role, count in (("root", 2), ("targets", 1), ("snapshot", 1), ("timestamp", 1))}
        root = Metadata(Root(version=1, expires=datetime.now(UTC) + timedelta(days=7),
                             keys={signer.public_key.keyid: signer.public_key
                                   for signers in keys.values() for signer in signers},
                             roles={role: Role([signer.public_key.keyid for signer in signers], len(signers))
                                    for role, signers in keys.items()}))
        for signer in keys["root"]:
            root.sign(signer, append=True)
        (self.roots / "1.root.json").write_bytes(root.to_bytes())
        self.cache = self.directory / "client-cache"
        self.cache.mkdir()
        shutil.copyfile(self.roots / "1.root.json", self.cache / "root.json")
        self.timestamp_signer = keys["timestamp"][0]
        self.signing_env = {**os.environ, **{
            f"AGENT_LINK_TUF_{role.upper()}_KEYS": json.dumps([signer.private_bytes.decode() for signer in signers])
            for role, signers in keys.items() if role != "root"}}
        self.block = None
        test = self

        class PublicProxy(BaseHTTPRequestHandler):
            def do_GET(self):
                key = unquote(self.path.lstrip("/"))
                if test.block and test.block(key):
                    self.send_error(503)
                    return
                options = {attribute: self.headers[header] for attribute, header in
                           (("Range", "Range"), ("IfNoneMatch", "If-None-Match")) if header in self.headers}
                try:
                    result = test.storage.s3.get_object(Bucket=test.storage.releases, Key=key, **options)
                except ClientError as error:
                    self.send_response(error.response["ResponseMetadata"]["HTTPStatusCode"])
                    self.end_headers()
                    return
                self.send_response(result["ResponseMetadata"]["HTTPStatusCode"])
                for name, header in (("ContentLength", "Content-Length"), ("ContentRange", "Content-Range"),
                                     ("ContentType", "Content-Type"), ("CacheControl", "Cache-Control"),
                                     ("ETag", "ETag"), ("ContentDisposition", "Content-Disposition")):
                    if name in result:
                        self.send_header(header, str(result[name]))
                if key == CATALOG:
                    self.send_header("Access-Control-Allow-Origin", "*")
                self.end_headers()
                with result["Body"] as body:
                    self.wfile.write(body.read())

            def log_message(self, *_args):
                pass

        server = ThreadingHTTPServer(("127.0.0.1", 0), PublicProxy)
        Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        self.origin = f"http://127.0.0.1:{server.server_port}"

    def clean_buckets(self):
        for bucket in (self.storage.releases, self.storage.state):
            for entry in self.storage.s3.list_objects_v2(Bucket=bucket).get("Contents", []):
                self.storage.s3.delete_object(Bucket=bucket, Key=entry["Key"])
            self.storage.s3.delete_bucket(Bucket=bucket)

    def stage(self, name, build, previous=None, withdrawn=False):
        command = [sys.executable, HERE / "publish.py"]
        output = self.directory / name
        release = {"releaseId": f"test-release-{build}", "displayVersion": "0.2.1", "platform": "linux",
                   "arch": "x86_64", "channel": "stable", "buildNumber": build,
                   "availability": "withdrawn" if withdrawn else "published", "minOS": "ubuntu-24.04",
                   "compatibility": {"bootstrapMinVersion": 1, "stateReadVersions": [1], "stateWriteVersion": 1},
                   "rollout": {"cohortSeed": f"seed-{build}", "percentage": 100}, "withdrawnBuilds": []}
        entry = {"release": release}
        if not withdrawn:
            archive = self.directory / f"test-{build}.tar.gz"
            archive.write_bytes(f"synthetic HTTP archive {build}".encode())
            digest = hashlib.sha256(archive.read_bytes()).hexdigest()
            entry.update(archive=str(archive), download={
                "qualifiedInstallerSha256": digest, "qualifiedUpdateSha256": digest,
                "publishedAt": "2026-11-21T00:00:00Z", "releaseNotes": "Qualification test",
                "installation": "Synthetic payload for isolated HTTP verification",
            })
        manifest = self.directory / (name + ".json")
        manifest.write_text(json.dumps([entry]))
        result = subprocess.run([*command, "stage", "--manifest", manifest, "--root-dir", self.roots,
                                 "--output", output, *(["--previous", previous] if previous else ["--initial"])],
                                capture_output=True, text=True, timeout=30, env=self.signing_env)
        self.assertEqual(result.returncode, 0, result.stderr)
        return output

    def command(self, action, operation, *extra, failure=None):
        result = subprocess.run([sys.executable, HERE / "promote.py", action, "--operation-id", operation,
                                 "--release-bucket", self.storage.releases, "--state-bucket", self.storage.state,
                                 *extra], capture_output=True, text=True, timeout=30)
        if failure:
            self.assertEqual(result.returncode, 1, result.stderr)
            self.assertIn(failure, result.stderr)
            return None
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads(result.stdout)

    def promote(self, operation, revision, candidate, *extra, failure=None):
        return self.command("promote", operation, "--expected-revision", str(revision), "--candidate", candidate,
                            "--root-dir", self.roots, "--public-origin", self.origin, *extra, failure=failure)

    def assert_origin(self, key, generation):
        current, _ = self.storage.document(self.storage.releases, key)
        self.assertEqual(current, (generation / key).read_bytes() if generation else None)

    def assert_desktop_release(self, build):
        result = subprocess.run(["node", "--input-type=module", "-e", """
            import { stageVerifiedRelease } from './src/verify-release.mjs';
            const [origin, metadataDir] = process.argv.slice(1);
            try {
              const { release } = await stageVerifiedRelease({
                metadataBaseUrl: origin + '/metadata/', targetBaseUrl: origin + '/targets/',
                releaseRecordPath: 'channels/stable/linux-x86_64.json', metadataDir, metadataOnly: true,
                installed: { platform: 'linux', arch: 'x86_64', channel: 'stable', buildNumber: 41,
                  bootstrapVersion: 1, stateVersion: 1 },
              });
              console.log(release.buildNumber);
            } catch (error) {
              console.error(error.message);
              process.exitCode = 1;
            }
            """, self.origin, self.cache], cwd=HERE.parent, capture_output=True, text=True, timeout=30)
        if build is None:
            self.assertEqual(result.returncode, 1)
            self.assertIn("Release is unavailable", result.stderr)
        else:
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(result.stdout.strip(), str(build))

    def test_recovery_order_and_revision(self):
        first = self.stage("first", 42)
        self.block = lambda key: key.endswith(".tar.gz")
        self.promote("initial", 0, first, failure="Public object headers are not ready (503)")
        self.assert_origin(TIMESTAMP, None)
        self.assert_origin(CATALOG, None)
        self.assertEqual(self.command("status", "initial")["status"], "in-progress")
        self.promote("competing", 0, first, failure="initial is already in progress")
        self.block = None
        receipt = self.promote("initial", 0, first)
        self.assertEqual(receipt["revision"], 1)
        self.assertEqual(self.promote("initial", 0, first), receipt)
        self.assertEqual(self.command("status", "initial"), receipt)
        self.assert_desktop_release(42)

        second = self.stage("second", 43, first)
        self.promote("wrong-revision", 0, second, failure="Publication revision changed to 1")
        self.block = lambda key: key == TIMESTAMP
        self.promote("upgrade", 1, second, failure="Public object headers are not ready (503)")
        self.assert_origin(TIMESTAMP, second)
        self.assert_origin(CATALOG, first)
        self.block = None
        self.assert_desktop_release(43)
        self.assertEqual(self.promote("upgrade", 1, second)["revision"], 2)
        self.assert_origin(CATALOG, second)
        for key in ["metadata/1.targets.json", "metadata/1.snapshot.json"]:
            self.assert_origin(key, first)

        withdrawal = self.stage("withdrawal", 43, second, withdrawn=True)
        pointer = withdrawal / TIMESTAMP
        timestamp = Metadata.from_file(pointer)
        timestamp.signed.expires = datetime.now(UTC).replace(microsecond=0) + timedelta(seconds=4)
        timestamp.sign(self.timestamp_signer)
        pointer.write_bytes(timestamp.to_bytes())
        self.block = lambda key: key == CATALOG
        self.promote("withdraw", 2, withdrawal, failure="Public object headers are not ready (503)")
        self.assert_origin(CATALOG, withdrawal)
        self.assert_origin(TIMESTAMP, second)
        refreshed = self.directory / "refreshed"
        result = subprocess.run([sys.executable, HERE / "publish.py", "refresh-timestamp",
                                 "--previous", withdrawal, "--root-dir", self.roots, "--output", refreshed],
                                capture_output=True, text=True, timeout=30, env=self.signing_env)
        self.assertEqual(result.returncode, 0, result.stderr)
        time.sleep(max((timestamp.signed.expires - datetime.now(UTC)).total_seconds(), 0) + 0.05)
        self.block = None
        different = self.stage("changed", 44, withdrawal)
        self.promote("withdraw", 2, different, "--recover-expired", failure="must preserve the approved release content")
        self.promote("withdraw", 2, refreshed, failure="needs its original generation")
        receipt = self.promote("withdraw", 2, refreshed, "--recover-expired")
        self.assertEqual(receipt["pointerOrder"], [CATALOG, TIMESTAMP])
        self.assertEqual(receipt["revision"], 3)
        self.assertEqual(receipt["candidate"]["timestampVersion"], 4)
        self.assert_origin(CATALOG, withdrawal)
        self.assert_origin(TIMESTAMP, refreshed)
        self.assert_desktop_release(None)
        self.assertEqual(self.command("status", "initial")["revision"], 1)
        self.assertIsNone(self.storage.get(self.storage.releases, STATE_KEY))


if __name__ == "__main__":
    unittest.main()
