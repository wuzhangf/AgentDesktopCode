"""Stage an Agent Link TUF repository using externally provisioned signing roles."""
import argparse
import base64
import binascii
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
import json
import os
from pathlib import Path
import re
import shutil
import sys

from cryptography.hazmat.primitives.serialization import load_pem_private_key
from securesystemslib.signer import CryptoSigner
from tuf.api.exceptions import RepositoryError
from tuf.api.metadata import MetaFile, Metadata, Root, Snapshot, TargetFile, Targets, Timestamp

ROLES = ("root", "targets", "snapshot", "timestamp")
SHA = ["sha256"]
PLATFORMS = {"macos": ("arm64", ".zip"), "windows": ("x86_64", ".zip"),
             "linux": ("x86_64", ".tar.gz")}
SAFE_NAME = re.compile(r"[a-zA-Z0-9_-][a-zA-Z0-9._+-]*")
RECORD_PATH = re.compile(r"channels/(stable|preview)/(macos-arm64|windows-x86_64|linux-x86_64)\.json")
ROOT_NAME = re.compile(r"([1-9][0-9]*)\.root\.json")
BUILD_INDEX = "publication/builds.json"
PUBLIC_CATALOG = "publication/catalog.json"
RELEASE_FIELDS = {
    "releaseId", "displayVersion", "platform", "arch", "channel", "buildNumber",
    "availability", "minOS", "compatibility", "rollout", "withdrawnBuilds",
}


@dataclass(frozen=True)
class Target:
    info: TargetFile
    content: bytes | Path


@dataclass(frozen=True)
class Repository:
    root_version: int
    targets: Metadata[Targets]
    targets_data: bytes
    snapshot: Metadata[Snapshot]
    snapshot_data: bytes
    timestamp: Metadata[Timestamp]
    files: dict[str, Target]


def positive(value):
    return type(value) is int and 0 < value <= 2**53 - 1


def verify(root, metadata):
    root.verify_delegate(metadata.signed.type, metadata.signed_bytes, metadata.signatures)


def load_roots(directory: Path, now):
    paths = sorted((int(match[1]), path) for path in directory.iterdir()
                   if (match := ROOT_NAME.fullmatch(path.name)))
    roots = []
    for version, path in paths:
        raw = path.read_bytes()
        metadata = Metadata.from_bytes(raw)
        root = metadata.signed
        if not isinstance(root, Root) or root.version != version or version != len(roots) + 1:
            raise ValueError("Root chain must start at 1 and include every version")
        if not root.consistent_snapshot or root.roles["root"].threshold < 2:
            raise ValueError("Agent Link requires consistent snapshots and threshold root keys")
        role_keys = set()
        for role in ROLES:
            keys = {(root.keys[k].keytype, root.keys[k].keyval["public"])
                    for k in root.roles[role].keyids}
            if role_keys & keys or len(keys) < root.roles[role].threshold:
                raise ValueError("Root assigns a shared key or unsatisfied threshold to a role")
            role_keys.update(keys)
        if roots:
            verify(roots[-1][0], metadata)
        verify(root, metadata)
        roots.append((root, raw))
    if not roots or roots[-1][0].is_expired(now):
        raise ValueError("A current, offline-signed root chain is required")
    return roots


def sign(root, metadata):
    role = metadata.signed.type
    try:
        keys = json.loads(os.environ[f"AGENT_LINK_TUF_{role.upper()}_KEYS"])
        if not isinstance(keys, list) or not keys:
            raise ValueError
        for pem in keys:
            private_key = load_pem_private_key(pem.encode(), password=None)
            public = CryptoSigner(private_key).public_key
            declared = next(root.keys[keyid] for keyid in root.roles[role].keyids
                            if root.keys[keyid].keytype == public.keytype
                            and root.keys[keyid].scheme == public.scheme
                            and root.keys[keyid].keyval == public.keyval)
            metadata.sign(CryptoSigner(private_key, declared), append=True)
    except (AttributeError, KeyError, StopIteration, TypeError, ValueError) as error:
        raise ValueError(f"Supply valid keys assigned to the {role} role") from error
    verify(root, metadata)
    return metadata


def check_file(info, data):
    if not (info.hashes and set(info.hashes) == {"sha256"}
            and re.fullmatch(r"[0-9a-f]{64}", info.hashes["sha256"]) and positive(info.length)):
        raise ValueError("Repository metadata must bind file length and SHA-256")
    if isinstance(data, Path):
        with data.open("rb") as stream:
            info.verify_length_and_hashes(stream)
    else:
        info.verify_length_and_hashes(data)


def previous_repository(previous, roots):
    metadata_dir = previous / "metadata"
    versions = sorted(int(match[1]) for path in metadata_dir.iterdir()
                      if (match := ROOT_NAME.fullmatch(path.name)))
    if not versions or versions != list(range(1, len(versions) + 1)) or len(versions) > len(roots):
        raise ValueError("Previous repository has a different root chain")
    for version in versions:
        if (metadata_dir / f"{version}.root.json").read_bytes() != roots[version - 1][1]:
            raise ValueError("Previous repository has a different root chain")
    root = roots[versions[-1] - 1][0]

    def read(name, kind, info=None):
        data = (metadata_dir / name).read_bytes()
        if info is not None:
            check_file(info, data)
        metadata = Metadata.from_bytes(data)
        if not isinstance(metadata.signed, kind) or not positive(metadata.signed.version):
            raise ValueError(f"Unexpected previous metadata type or version: {name}")
        if info is not None and metadata.signed.version != info.version:
            raise ValueError(f"Previous metadata version mismatch: {name}")
        verify(root, metadata)
        return metadata, data

    timestamp, _ = read("timestamp.json", Timestamp)
    snapshot_info = timestamp.signed.snapshot_meta
    snapshot, snapshot_data = read(f"{snapshot_info.version}.snapshot.json", Snapshot, snapshot_info)
    targets_info = snapshot.signed.meta["targets.json"]
    targets, targets_data = read(f"{targets_info.version}.targets.json", Targets, targets_info)
    if targets.signed.delegations or set(snapshot.signed.meta) != {"targets.json"}:
        raise ValueError("Expected a repository from the Agent Link publisher")
    files = {}
    for target_path, info in targets.signed.targets.items():
        if not all(SAFE_NAME.fullmatch(part) for part in target_path.split("/")):
            raise ValueError("Invalid previous target path")
        if info.hashes.keys() != {"sha256"} or not re.fullmatch(r"[0-9a-f]{64}", info.hashes["sha256"]):
            raise ValueError("Expected a SHA-256 target")
        file = previous / "targets" / info.get_prefixed_paths()[0]
        check_file(info, file)
        files[target_path] = Target(info, file)
    return Repository(root.version, targets, targets_data, snapshot, snapshot_data, timestamp, files)


def record_path(release):
    platform, arch, channel = (release[k] for k in ("platform", "arch", "channel"))
    if channel not in ("stable", "preview") or PLATFORMS.get(platform, (None,))[0] != arch:
        raise ValueError("Unsupported platform, architecture or channel")
    return f"channels/{channel}/{platform}-{arch}.json"


def validate_release(release):
    if not isinstance(release, dict) or set(release) != RELEASE_FIELDS:
        raise ValueError("Release fields do not match the publication contract")
    record_path(release)
    if not re.fullmatch(r"[a-zA-Z0-9_-]+", release["releaseId"]):
        raise ValueError("Invalid release identifier")
    if not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9.+_-]{0,63}", release["displayVersion"]):
        raise ValueError("Invalid display version")
    minimum = release["minOS"]
    if (release["platform"] == "macos" and not re.fullmatch(r"(?:macos-)?\d+(?:\.\d+){1,2}", minimum)
            or release["platform"] == "windows" and minimum != "windows-11"
            or release["platform"] == "linux" and minimum != "ubuntu-24.04"):
        raise ValueError("Invalid minimum OS for this platform")
    if not positive(release["buildNumber"]) or release["availability"] not in ("published", "withdrawn"):
        raise ValueError("Invalid build number or availability")
    compatibility = release["compatibility"]
    compatibility_fields = {"bootstrapMinVersion", "stateReadVersions", "stateWriteVersion"}
    if (set(compatibility) - {"contractsRevision"} != compatibility_fields
            or "contractsRevision" in compatibility
            and not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}", compatibility["contractsRevision"])
            or not positive(compatibility["bootstrapMinVersion"])
            or not positive(compatibility["stateWriteVersion"])
            or not isinstance(compatibility["stateReadVersions"], list)
            or not compatibility["stateReadVersions"]
            or not all(positive(version) for version in compatibility["stateReadVersions"])):
        raise ValueError("Invalid state compatibility")
    rollout = release["rollout"]
    if (set(rollout) != {"cohortSeed", "percentage"}
            or not isinstance(rollout["cohortSeed"], str) or not rollout["cohortSeed"].strip()
            or type(rollout["percentage"]) is not int
            or not 0 <= rollout["percentage"] <= 100):
        raise ValueError("Invalid rollout")
    if (not isinstance(release["withdrawnBuilds"], list)
            or not all(positive(build) for build in release["withdrawnBuilds"])):
        raise ValueError("Invalid withdrawn builds")


def load_records(previous):
    if not previous:
        return {}
    records = {}
    for path, target in previous.files.items():
        if RECORD_PATH.fullmatch(path):
            if target.info.length > 1024 * 1024:
                raise ValueError("Previous release record exceeds the verifier limit")
            records[path] = json.loads(target.content.read_bytes())
    if not records:
        raise ValueError("Previous repository has no release records")
    return records


def public_download(details, release, artifact, manifest, files):
    fields = {"qualifiedInstallerSha256", "qualifiedUpdateSha256", "publishedAt", "releaseNotes", "installation"}
    windows = release["platform"] == "windows"
    if (not isinstance(details, dict) or set(details) != (fields | {"installer"} if windows else fields)
            or release["availability"] != "published"
            or artifact["sha256"] != details["qualifiedUpdateSha256"]):
        raise ValueError("Public download must identify the qualified update archive")
    published_at = details["publishedAt"]
    if not re.fullmatch(r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z", published_at):
        raise ValueError("Public download requires a UTC publication date")
    datetime.fromisoformat(published_at)
    for field in ("releaseNotes", "installation"):
        if not isinstance(details[field], str) or not details[field].strip() or len(details[field]) > 2048:
            raise ValueError(f"Public download requires {field}")
    installer = {key: artifact[key] for key in ("path", "length", "sha256")}
    if windows:
        source = manifest.parent / details["installer"]
        if not SAFE_NAME.fullmatch(source.name) or source.suffix.lower() != ".msi":
            raise ValueError("Public Windows download requires the qualified MSI")
        parent = artifact["path"].rsplit("/", 1)[0]
        path = f"{parent}/{source.name}"
        info = TargetFile.from_file(path, str(source), SHA)
        if not positive(info.length):
            raise ValueError("Public Windows installer is empty or oversized")
        installer = {"path": path, "length": info.length, "sha256": info.hashes["sha256"]}
        files[path] = Target(info, source)
    if installer["sha256"] != details["qualifiedInstallerSha256"]:
        raise ValueError("Public installer bytes differ from the qualified digest")
    return {**{key: release[key] for key in ("releaseId", "displayVersion", "platform", "arch", "channel",
                                            "buildNumber", "minOS")},
            "artifact": installer, "publishedAt": published_at,
            "releaseNotes": details["releaseNotes"], "installation": details["installation"]}


def apply_releases(manifest, previous):
    records = load_records(previous)
    files = dict(previous.files) if previous else {}
    builds = json.loads(files[BUILD_INDEX].content.read_bytes()) if previous else {}
    published_paths = {artifact["path"]: key for key, artifact in builds.items()}
    public = {}
    if PUBLIC_CATALOG in files:
        catalog = json.loads(files[PUBLIC_CATALOG].content.read_bytes())
        public = {(record_path(row), row["buildNumber"]): row for row in catalog["releases"]}
    installers = {(row["platform"], row["arch"], row["buildNumber"]): row["artifact"] for row in public.values()}
    installer_paths = {artifact["path"]: key for key, artifact in installers.items()}
    entries = json.loads(manifest.read_bytes())
    if not isinstance(entries, list) or not entries:
        raise ValueError("Publication input must contain at least one release")
    edited = set()
    for entry in entries:
        if not isinstance(entry, dict) or set(entry) - {"release", "archive", "sparkleEdSignature", "download"}:
            raise ValueError("Unknown publication input field")
        release = entry["release"]
        validate_release(release)
        path = record_path(release)
        if path in edited:
            raise ValueError(f"Duplicate release slot: {path}")
        edited.add(path)
        older = records.get(path)
        build = release["buildNumber"]
        if older and build < older["buildNumber"]:
            raise ValueError(f"Build number went backwards for {path}")

        if "archive" in entry:
            archive = manifest.parent / entry["archive"]
            if (not SAFE_NAME.fullmatch(archive.name)
                    or not archive.name.endswith(PLATFORMS[release["platform"]][1])):
                raise ValueError("Invalid archive name for the platform")
            archive_path = f"agent-link/releases/{release['releaseId']}/{release['platform']}-{release['arch']}/{archive.name}"
            info = TargetFile.from_file(archive_path, str(archive), SHA)
            if not info.length:
                raise ValueError("Archive is empty")
            artifact = {"path": archive_path, "length": info.length, "sha256": info.hashes["sha256"]}
            if release["platform"] == "macos":
                signature = entry.get("sparkleEdSignature", "")
                if not isinstance(signature, str) or len(base64.b64decode(signature, validate=True)) != 64:
                    raise ValueError("Mac archive needs a Sparkle EdDSA signature")
                artifact["sparkleEdSignature"] = signature
            elif "sparkleEdSignature" in entry:
                raise ValueError("Sparkle signature belongs to macOS")
            existing = files.get(archive_path)
            if existing and existing.info.hashes != info.hashes:
                raise ValueError("A published archive path belongs to different bytes")
            files[archive_path] = Target(info, archive)
        elif older and older["buildNumber"] == build and "sparkleEdSignature" not in entry:
            artifact = older["artifact"]
        else:
            raise ValueError("A new build requires its release archive")

        withdrawn = set(release["withdrawnBuilds"])
        if older:
            withdrawn.update(older["withdrawnBuilds"])
            if build == older["buildNumber"]:
                immutable = RELEASE_FIELDS - {"availability", "rollout", "withdrawnBuilds"}
                if any(older[key] != release[key] for key in immutable) or older["artifact"] != artifact:
                    raise ValueError(f"A build number already identifies another release for {path}")
                if older["rollout"]["cohortSeed"] != release["rollout"]["cohortSeed"]:
                    raise ValueError(f"An existing build must keep its rollout seed for {path}")
            elif older["releaseId"] == release["releaseId"]:
                raise ValueError(f"A new build needs a new release identifier for {path}")
        if release["availability"] == "withdrawn":
            withdrawn.add(build)
        elif build in withdrawn:
            raise ValueError(f"A withdrawn build needs a higher repair build for {path}")
        records[path] = {**release, "withdrawnBuilds": sorted(withdrawn),
                         "schemaVersion": "link-release/1", "product": "agent-link",
                         "artifact": artifact}
        build_key = f"{release['platform']}-{release['arch']}/{build}"
        if builds.get(build_key, artifact) != artifact or published_paths.get(artifact["path"], build_key) != build_key:
            raise ValueError(f"A published build number or archive path already identifies another release for {path}")
        builds[build_key] = artifact
        published_paths[artifact["path"]] = build_key
        if "download" in entry:
            row = public_download(entry["download"], release, artifact, manifest, files)
            installer_key = (row["platform"], row["arch"], build)
            installer = row["artifact"]
            if (installers.get(installer_key, installer) != installer
                    or installer_paths.get(installer["path"], installer_key) != installer_key):
                raise ValueError("A qualified platform build already has a different installer")
            prior = public.get((path, build))
            if prior:
                row["publishedAt"] = prior["publishedAt"]
            public[path, build] = row
            installers[installer_key] = installer
            installer_paths[installer["path"]] = installer_key

    active = {}
    for path, release in records.items():
        data = json.dumps(release, ensure_ascii=False, allow_nan=False, sort_keys=True).encode()
        if len(data) > 1024 * 1024:
            raise ValueError("Release record exceeds the verifier limit")
        active[path] = Target(TargetFile.from_data(path, data, SHA), data)
        payload = release["artifact"]
        archive = files[payload["path"]]
        if archive.info.length != payload["length"] or archive.info.hashes["sha256"] != payload["sha256"]:
            raise ValueError("Release record differs from its archive")
        active[archive.info.path] = archive
    build_data = json.dumps(builds, sort_keys=True).encode()
    active[BUILD_INDEX] = Target(TargetFile.from_data(BUILD_INDEX, build_data, SHA), build_data)
    for (path, build), row in public.items():
        current = records[path]
        if build in current["withdrawnBuilds"]:
            row["availability"] = "withdrawn"
        elif build < current["buildNumber"]:
            row["availability"] = "superseded"
        elif current["rollout"]["percentage"] == 0:
            row["availability"] = "paused"
        else:
            row["availability"] = "published"
        if row["availability"] in ("published", "paused"):
            installer = row["artifact"]
            target = files[installer["path"]]
            if target.info.length != installer["length"] or target.info.hashes["sha256"] != installer["sha256"]:
                raise ValueError("Public download differs from its qualified installer")
            active[target.info.path] = target
    public_data = json.dumps({"schemaVersion": "link-download-catalog/1", "releases": list(public.values())},
                             ensure_ascii=False, sort_keys=True).encode()
    active[PUBLIC_CATALOG] = Target(TargetFile.from_data(PUBLIC_CATALOG, public_data, SHA), public_data)
    return active


def write_repository(output, roots, metadata_files, timestamp, files):
    output.mkdir(parents=True, exist_ok=False)
    try:
        metadata = output / "metadata"
        metadata.mkdir()
        for root, raw in roots:
            (metadata / f"{root.version}.root.json").write_bytes(raw)
        for name, data in metadata_files.items():
            (metadata / name).write_bytes(data)
        for target in files.values():
            destination = output / "targets" / target.info.get_prefixed_paths()[0]
            destination.parent.mkdir(parents=True, exist_ok=True)
            if isinstance(target.content, Path):
                shutil.copyfile(target.content, destination)
            else:
                destination.write_bytes(target.content)
            check_file(target.info, destination)
        if PUBLIC_CATALOG in files:
            catalog = files[PUBLIC_CATALOG].content
            if isinstance(catalog, Path):
                shutil.copyfile(catalog, output / "catalog.json")
            else:
                (output / "catalog.json").write_bytes(catalog)
            check_file(files[PUBLIC_CATALOG].info, output / "catalog.json")
        (metadata / "timestamp.json").write_bytes(timestamp.to_bytes())
    except BaseException:
        shutil.rmtree(output)
        raise


def run(args):
    now = datetime.now(UTC).replace(microsecond=0)
    roots = load_roots(args.root_dir, now)
    root = roots[-1][0]
    previous = previous_repository(args.previous, roots) if args.previous else None
    if args.command == "stage":
        files = apply_releases(args.manifest, previous)
        meta_version = previous.targets.signed.version + 1 if previous else 1
        targets = sign(root, Metadata(Targets(
            version=meta_version, expires=min(root.expires, now + timedelta(days=30)),
            targets={path: target.info for path, target in files.items()})))
        targets_data = targets.to_bytes()
        snapshot_version = previous.snapshot.signed.version + 1 if previous else 1
        snapshot = sign(root, Metadata(Snapshot(
            version=snapshot_version, expires=min(targets.signed.expires, now + timedelta(days=7)),
            meta={"targets.json": MetaFile.from_data(meta_version, targets_data, SHA)})))
        snapshot_data = snapshot.to_bytes()
    else:
        if previous.root_version != root.version:
            raise ValueError("Stage new targets after root rotation before refreshing a timestamp")
        targets, snapshot, files = previous.targets, previous.snapshot, previous.files
        targets_data, snapshot_data = previous.targets_data, previous.snapshot_data
        if targets.signed.is_expired(now) or snapshot.signed.is_expired(now):
            raise ValueError("Stage new targets or snapshot before refreshing a timestamp")
    version = previous.timestamp.signed.version + 1 if previous else 1
    timestamp = sign(root, Metadata(Timestamp(
        version=version, expires=min(root.expires, snapshot.signed.expires, now + timedelta(days=1)),
        snapshot_meta=MetaFile.from_data(snapshot.signed.version, snapshot_data, SHA))))
    metadata_files = {f"{targets.signed.version}.targets.json": targets_data,
                      f"{snapshot.signed.version}.snapshot.json": snapshot_data}
    write_repository(args.output, roots, metadata_files, timestamp, files)
    print(f"Staged timestamp {version}, snapshot {snapshot.signed.version} and targets {targets.signed.version}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    stage = commands.add_parser("stage")
    stage.add_argument("--manifest", type=Path, required=True)
    base = stage.add_mutually_exclusive_group(required=True)
    base.add_argument("--initial", action="store_true")
    base.add_argument("--previous", type=Path)
    refresh = commands.add_parser("refresh-timestamp")
    refresh.add_argument("--previous", type=Path, required=True)
    for command in (stage, refresh):
        command.add_argument("--root-dir", type=Path, required=True)
        command.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    try:
        run(args)
    except (binascii.Error, KeyError, OSError, RepositoryError, TypeError, ValueError) as error:
        print(f"Publication failed: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
