"""Promote a staged Agent Link generation to a conditional-write S3 origin."""
import argparse
import base64
from dataclasses import dataclass
from datetime import UTC, datetime
import hashlib
import json
from pathlib import Path
import re
import sys
from urllib.parse import quote, urlsplit

from botocore.config import Config
from botocore.exceptions import BotoCoreError, ClientError
from botocore.session import Session
from tuf.api.exceptions import RepositoryError
import urllib3

from publish import PUBLIC_CATALOG, check_file, load_roots, previous_repository

TIMESTAMP = "metadata/timestamp.json"
CATALOG = "catalog.json"
STATE_KEY = "agent-link-publication.json"
STATE_SCHEMA = "link-publication/1"
SHORT_CACHE = "public, max-age=30, must-revalidate"
LONG_CACHE = "public, max-age=31536000, immutable"
JSON_LIMIT = 16 * 1024 * 1024
CHUNK_SIZE = 1024 * 1024
PORTAL_ORIGIN = "https://steercrew.com"


def encode(value):
    return json.dumps(value, separators=(",", ":"), sort_keys=True).encode()


def digest(data):
    return hashlib.sha256(data).hexdigest() if data is not None else None


@dataclass(frozen=True)
class Object:
    path: Path
    length: int
    sha256: str

    @classmethod
    def metadata(cls, path, data):
        return cls(path, len(data), digest(data))


@dataclass(frozen=True)
class Generation:
    identity: dict
    objects: dict[str, Object]
    pointers: dict[str, Object]
    catalog: bytes
    expires: datetime


def load_generation(directory, root_dir):
    now = datetime.now(UTC)
    roots = load_roots(root_dir, now)
    signed = previous_repository(directory, roots)
    if signed.root_version != roots[-1][0].version:
        raise ValueError("Stage the generation with the current trusted root chain")
    for metadata in (signed.timestamp, signed.snapshot, signed.targets):
        if metadata.signed.is_expired(now):
            raise ValueError("The staged repository contains expired metadata")
    if PUBLIC_CATALOG not in signed.files:
        raise ValueError("Stage a generation with the signed public catalog")
    catalog = (directory / CATALOG).read_bytes()
    check_file(signed.files[PUBLIC_CATALOG].info, catalog)
    targets_version = signed.targets.signed.version
    snapshot_version = signed.snapshot.signed.version
    catalog_record = json.loads(catalog)
    if catalog_record.pop("revision") != targets_version:
        raise ValueError("Public catalog revision differs from the signed targets")
    intent = digest(encode({"catalog": catalog_record,
                            "targets": {name: target.info.to_dict() for name, target in signed.files.items()
                                        if name != PUBLIC_CATALOG}}))
    objects = {"targets/" + target.info.get_prefixed_paths()[0]:
               Object(target.content, target.info.length, target.info.hashes["sha256"])
               for target in signed.files.values()}
    metadata = {f"metadata/{root.version}.root.json": data for root, data in roots}
    metadata[f"metadata/{targets_version}.targets.json"] = signed.targets_data
    metadata[f"metadata/{snapshot_version}.snapshot.json"] = signed.snapshot_data
    for name, data in metadata.items():
        objects[name] = Object.metadata(directory / name, data)
    pointers = {TIMESTAMP: Object.metadata(directory / TIMESTAMP, signed.timestamp_data),
                CATALOG: Object.metadata(directory / CATALOG, catalog)}
    expires = min(roots[-1][0].expires, signed.timestamp.signed.expires, signed.snapshot.signed.expires,
                  signed.targets.signed.expires)
    return Generation({"rootVersion": signed.root_version, "targetsVersion": targets_version,
                       "snapshotVersion": snapshot_version, "timestampVersion": signed.timestamp.signed.version,
                       "expiresAt": expires.isoformat(), "intentSha256": intent,
                       "pointers": {name: obj.sha256 for name, obj in pointers.items()}},
                      objects, pointers, catalog, expires)


class Storage:
    def __init__(self, releases, state):
        if releases == state:
            raise ValueError("Publication state requires a separate private bucket")
        self.releases = releases
        self.state = state
        self.s3 = Session().create_client("s3", config=Config(
            s3={"addressing_style": "path"}, retries={"total_max_attempts": 1},
            connect_timeout=10, read_timeout=60, request_checksum_calculation="when_required",
            response_checksum_validation="when_required"))

    def get(self, bucket, key, head=False):
        fetch = self.s3.head_object if head else self.s3.get_object
        try:
            return fetch(Bucket=bucket, Key=key)
        except ClientError as error:
            if error.response["ResponseMetadata"]["HTTPStatusCode"] == 404:
                return None
            raise

    def document(self, bucket, key):
        result = self.get(bucket, key)
        if result is None:
            return None, None
        with result["Body"] as body:
            raw = body.read(JSON_LIMIT + 1)
        if len(raw) > JSON_LIMIT or not result.get("ETag"):
            raise ValueError(f"Missing ETag or oversized document: {key}")
        return raw, result["ETag"]

    def put(self, bucket, key, body, etag=None, **headers):
        condition = {"IfMatch": etag} if etag else {"IfNoneMatch": "*"}
        try:
            self.s3.put_object(Bucket=bucket, Key=key, Body=body, **condition, **headers)
            return True
        except ClientError as error:
            if error.response["ResponseMetadata"]["HTTPStatusCode"] in (409, 412):
                return False
            raise

    def read_state(self):
        raw, etag = self.document(self.state, STATE_KEY)
        if raw is None:
            return {"schemaVersion": STATE_SCHEMA, "revision": 0, "published": None,
                    "inProgress": None, "receipts": {}}, None
        state = json.loads(raw)
        if state.get("schemaVersion") != STATE_SCHEMA:
            raise ValueError("Unexpected publication state schema")
        return state, etag

    def write_state(self, state, etag):
        document = encode(state)
        if len(document) > JSON_LIMIT:
            raise ValueError("Publication state size limit exceeded")
        return self.put(self.state, STATE_KEY, document, etag, ContentType="application/json", CacheControl="no-store")


def content_type(key):
    key = key.lower()
    if key.endswith(".json"):
        return "application/json"
    if key.endswith(".zip"):
        return "application/zip"
    if key.endswith(".tar.gz"):
        return "application/gzip"
    if key.endswith(".dmg"):
        return "application/x-apple-diskimage"
    return "application/octet-stream"


def install_object(storage, key, obj):
    existing = storage.get(storage.releases, key, head=True)
    mime = content_type(key)
    if existing is None:
        sha256, md5 = hashlib.sha256(), hashlib.md5(usedforsecurity=False)
        extra = {"ContentDisposition": "attachment"} if mime != "application/json" else {}
        with obj.path.open("rb") as stream:
            for chunk in iter(lambda: stream.read(CHUNK_SIZE), b""):
                sha256.update(chunk)
                md5.update(chunk)
            if stream.tell() != obj.length or sha256.hexdigest() != obj.sha256:
                raise ValueError(f"Staged bytes changed: {key}")
            stream.seek(0)
            if storage.put(storage.releases, key, stream, ContentLength=obj.length, ContentType=mime,
                           CacheControl=LONG_CACHE, Metadata={"sha256": obj.sha256},
                           ContentMD5=base64.b64encode(md5.digest()).decode(), **extra):
                return
        existing = storage.get(storage.releases, key, head=True)
    if (not existing or existing["ContentLength"] != obj.length or existing["ContentType"] != mime
            or existing.get("Metadata", {}).get("sha256") != obj.sha256
            or existing.get("CacheControl") != LONG_CACHE):
        raise ValueError(f"Immutable origin object conflicts with the candidate: {key}")


class PublicOrigin:
    def __init__(self, url):
        parsed = urlsplit(url)
        loopback = parsed.hostname in ("127.0.0.1", "::1")
        if (not parsed.hostname or parsed.username is not None or parsed.query or parsed.fragment
                or parsed.path not in ("", "/")
                or (parsed.scheme != "https" and not (loopback and parsed.scheme == "http"))):
            raise ValueError("The public origin must be an HTTPS host or loopback HTTP")
        self.url = url.rstrip("/")
        self.http = urllib3.PoolManager(timeout=urllib3.Timeout(connect=10, read=60), retries=False)

    def verify(self, key, obj, immutable):
        url = self.url + "/" + quote(key, safe="/")
        headers = {"Cache-Control": "no-cache", "Accept-Encoding": "identity"}
        if key == CATALOG:
            headers["Origin"] = PORTAL_ORIGIN
        response = self.http.request("GET", url, headers=headers, redirect=False, preload_content=False)
        try:
            cache = {token.strip().lower() for token in response.headers.get("Cache-Control", "").split(",")}
            mime = response.headers.get("Content-Type", "").split(";", 1)[0].strip()
            max_age = next((token[8:] for token in cache if token.startswith("max-age=")), "")
            cache_ok = ("immutable" in cache if immutable else
                        "must-revalidate" in cache and max_age.isdigit() and int(max_age) <= 30)
            if (response.status != 200 or response.headers.get("Content-Length") != str(obj.length)
                    or mime != content_type(key) or not cache_ok or not response.headers.get("ETag")
                    or (mime != "application/json" and not response.headers.get("Content-Disposition", "").startswith("attachment"))
                    or (key == CATALOG and response.headers.get("Access-Control-Allow-Origin") not in ("*", PORTAL_ORIGIN))):
                raise ValueError(f"Public object headers are not ready ({response.status}): {key}")
            etag = response.headers["ETag"]
            sha256 = hashlib.sha256()
            for chunk in response.stream(CHUNK_SIZE, decode_content=False):
                sha256.update(chunk)
            if sha256.hexdigest() != obj.sha256:
                raise ValueError(f"Public object bytes differ from the candidate: {key}")
        finally:
            response.close()
            response.release_conn()
        if content_type(key) != "application/json":
            response = self.http.request("GET", url, headers={**headers, "Range": "bytes=0-0"},
                                         redirect=False, preload_content=False)
            try:
                with obj.path.open("rb") as stream:
                    if (response.status != 206 or response.headers.get("Content-Range") != f"bytes 0-0/{obj.length}"
                            or response.read(2, decode_content=False) != stream.read(1)):
                        raise ValueError(f"Public object does not support the expected byte range: {key}")
            finally:
                response.close()
                response.release_conn()
        if not immutable:
            response = self.http.request("GET", url, headers={**headers, "If-None-Match": etag}, redirect=False)
            if response.status != 304:
                raise ValueError(f"Public object did not revalidate with its ETag: {key}")


def check_advance(base, candidate):
    if base is None:
        if any(candidate[key] != 1 for key in ("timestampVersion", "snapshotVersion", "targetsVersion")):
            raise ValueError("Initial publication must start from timestamp, snapshot and targets version 1")
        return
    snapshot_step = candidate["snapshotVersion"] - base["snapshotVersion"]
    targets_step = candidate["targetsVersion"] - base["targetsVersion"]
    if (candidate["timestampVersion"] != base["timestampVersion"] + 1
            or snapshot_step != targets_step or snapshot_step not in (0, 1)
            or candidate["rootVersion"] < base["rootVersion"]
            or (snapshot_step == 0 and (candidate["rootVersion"] != base["rootVersion"]
                                       or candidate["pointers"][CATALOG] != base["pointers"][CATALOG]))):
        raise ValueError("Candidate does not advance the published generation")


def stops_distribution(before, after):
    if before is None:
        return False

    def slot(row):
        return tuple(row[key] for key in ("channel", "platform", "arch", "buildNumber"))
    reduced = {slot(row) for row in json.loads(after)["releases"]
               if row["availability"] in ("withdrawn", "paused")}
    return any(slot(row) in reduced for row in json.loads(before)["releases"] if row["availability"] == "published")


def claim(storage, generation, operation, revision, recover_expired):
    state, etag = storage.read_state()
    previous = state["receipts"].get(operation)
    if previous:
        if previous["candidate"] != generation.identity or previous["expectedRevision"] != revision:
            raise ValueError("Operation ID already belongs to another publication")
        return state, previous, True
    if state["revision"] != revision:
        raise ValueError(f"Publication revision changed to {state['revision']}")
    pending = state["inProgress"]
    if pending:
        if pending["operationId"] != operation:
            raise ValueError(f"Publication {pending['operationId']} is already in progress")
        prior = pending["candidate"]
        if prior != generation.identity:
            if not recover_expired or datetime.fromisoformat(prior["expiresAt"]) > datetime.now(UTC):
                raise ValueError("The in-progress publication needs its original generation")
            if prior["intentSha256"] != generation.identity["intentSha256"]:
                raise ValueError("Recovery must preserve the approved release content")
            check_advance(prior, generation.identity)
            pending = {**pending, "candidate": generation.identity, "allowedPointers": {
                key: list(dict.fromkeys([*values, prior["pointers"][key]]))
                for key, values in pending["allowedPointers"].items()}}
            state["inProgress"] = pending
            if not storage.write_state(state, etag):
                raise ValueError("Publication recovery conflicted. Retry the same operation")
        return state, pending, False
    base = state["published"]
    check_advance(base, generation.identity)
    before = {}
    for key in generation.pointers:
        before[key], _ = storage.document(storage.releases, key)
        if digest(before[key]) != (base["pointers"][key] if base else None):
            raise ValueError(f"Origin pointer differs from the recorded generation: {key}")
    catalog_first = stops_distribution(before[CATALOG], generation.catalog)
    job = {"operationId": operation, "expectedRevision": revision, "candidate": generation.identity,
           "allowedPointers": {key: [digest(data)] for key, data in before.items()},
           "pointerOrder": [CATALOG, TIMESTAMP] if catalog_first else [TIMESTAMP, CATALOG]}
    state["inProgress"] = job
    if not storage.write_state(state, etag):
        raise ValueError("Publication claim changed. Retry with the same operation ID")
    return state, job, False


def advance_pointer(storage, key, obj, allowed):
    data = obj.path.read_bytes()
    if len(data) != obj.length or digest(data) != obj.sha256:
        raise ValueError(f"Staged pointer changed: {key}")
    current, etag = storage.document(storage.releases, key)
    if digest(current) == obj.sha256:
        return
    if digest(current) not in allowed:
        raise ValueError(f"Origin pointer changed outside this publication: {key}")
    if not storage.put(storage.releases, key, data, etag, ContentType="application/json", CacheControl=SHORT_CACHE):
        raise ValueError(f"Conditional pointer write conflicted: {key}. Retry the same operation")


def promote(storage, public, generation, operation, revision, recover_expired=False):
    _, job, complete = claim(storage, generation, operation, revision, recover_expired)
    if complete:
        return job
    for key, obj in generation.objects.items():
        install_object(storage, key, obj)
        public.verify(key, obj, immutable=True)
    for key in job["pointerOrder"]:
        if generation.expires <= datetime.now(UTC):
            raise ValueError("Publication metadata expired before pointer promotion")
        obj = generation.pointers[key]
        advance_pointer(storage, key, obj, job["allowedPointers"][key])
        public.verify(key, obj, immutable=False)
    state, etag = storage.read_state()
    if operation in state["receipts"]:
        return state["receipts"][operation]
    if state["inProgress"] != job or state["revision"] != revision:
        raise ValueError("Publication state changed before completing the receipt")
    receipt = {**job, "revision": revision + 1, "status": "published"}
    state["revision"] = receipt["revision"]
    state["published"] = generation.identity
    state["inProgress"] = None
    state["receipts"][operation] = receipt
    if not storage.write_state(state, etag):
        raise ValueError("Publication receipt conflicted. Retry the same operation")
    return receipt


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    apply = commands.add_parser("promote")
    apply.add_argument("--candidate", type=Path, required=True)
    apply.add_argument("--root-dir", type=Path, required=True)
    apply.add_argument("--public-origin", required=True)
    apply.add_argument("--expected-revision", type=int, required=True)
    apply.add_argument("--recover-expired", action="store_true")
    status = commands.add_parser("status")
    for command in (apply, status):
        command.add_argument("--release-bucket", required=True)
        command.add_argument("--state-bucket", required=True)
        command.add_argument("--operation-id", required=True)
    args = parser.parse_args()
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", args.operation_id):
        parser.error("Invalid publication operation ID")
    if args.command == "promote" and args.expected_revision < 0:
        parser.error("Publication revision must be nonnegative")
    try:
        storage = Storage(args.release_bucket, args.state_bucket)
        if args.command == "promote":
            public = PublicOrigin(args.public_origin)
            generation = load_generation(args.candidate, args.root_dir)
            result = promote(storage, public, generation, args.operation_id, args.expected_revision, args.recover_expired)
        else:
            state, _ = storage.read_state()
            active = state["inProgress"]
            result = state["receipts"].get(args.operation_id)
            if result is None and active and active["operationId"] == args.operation_id:
                result = {**active, "status": "in-progress"}
            if result is None:
                result = {"operationId": args.operation_id, "status": "unknown", "revision": state["revision"]}
        print(json.dumps(result, sort_keys=True))
        return 0
    except ClientError as error:
        print(f"Publication failed: {error.operation_name} returned {error.response['Error']['Code']}", file=sys.stderr)
    except (BotoCoreError, urllib3.exceptions.HTTPError) as error:
        print(f"Publication transport failed: {type(error).__name__}. Check status and retry the same operation.",
              file=sys.stderr)
    except (KeyError, OSError, RepositoryError, TypeError, ValueError) as error:
        print(f"Publication failed: {error}", file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
