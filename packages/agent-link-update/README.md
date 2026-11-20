# Agent Link update verification and publishing

This package verifies a signed `link-release/1` record and stages the archive it
names. Both files are TUF targets. The archive length and SHA-256 in the release
record must agree with the authenticated target metadata before download.

`stageVerifiedRelease` receives these inputs from the desktop coordinator:

- `metadataDir` contains the pinned `root.json` and persists trusted metadata
  between checks. The coordinator gives each cache one writer at a time.
- `metadataBaseUrl` and `targetBaseUrl` locate the TUF repository. HTTP is
  available on loopback for test repositories.
- `releaseRecordPath` selects the release record target. The signed record
  binds the archive to the release identifier, channel, platform and build.
- `installed` supplies `platform`, `arch`, `channel`, `buildNumber`,
  `bootstrapVersion` and `stateVersion` from the installed application.
- `stagingParent` optionally identifies the parent for a unique staging
  directory. The coordinator owns cleanup after a successful check.

The result contains the verified record, the staged archive path and its
staging directory. Platform signatures, OS compatibility, rollout eligibility
and the installation safety point are coordinator responsibilities.

The Mac adapter in `src/sparkle-cli.mjs` takes the path to a JSON options
file. In addition to the shared inputs, it receives the packaged
`sparkleEdPublicKey`. The signed release record includes `minOS` and the
archive's `artifact.sparkleEdSignature`. The process returns its candidate as
one JSON line and serves that archive and a generated appcast on loopback.
Closing its stdin shuts down the feed and removes the staged data.

Run `npm ci` and `npm test` for a loopback repository with ephemeral signing
keys and synthetic archives.

## Stage a signed update repository

The publisher stages a static TUF repository from final platform-signed archives.
Set up its pinned Python dependencies in a local virtual environment.

```sh
python3 -m venv /path/to/publisher-venv
/path/to/publisher-venv/bin/python -m pip install -r publisher/requirements.txt
```

Supply the trusted offline-signed root chain as `1.root.json`, `2.root.json`
and subsequent contiguous versions. Match the initial root to the one packaged
with the clients. Roots enable consistent snapshots and use a quorum of at
least two distinct root keys. Each rotation is signed by the previous and
current root quorums. The publishing process receives the authorized targets,
snapshot and timestamp keys from the signing environment as JSON arrays of PEM
private keys in `AGENT_LINK_TUF_TARGETS_KEYS`, `AGENT_LINK_TUF_SNAPSHOT_KEYS`
and `AGENT_LINK_TUF_TIMESTAMP_KEYS`. Store keys in the signing environment's
secret store and keep the offline root keys outside that environment.

The manifest is a JSON array. A new entry can look like this.

```json
[{
  "archive": "agent-link-linux-x86_64.tar.gz",
  "release": {
    "releaseId": "link-100",
    "displayVersion": "1.0.0",
    "platform": "linux",
    "arch": "x86_64",
    "channel": "stable",
    "buildNumber": 100,
    "availability": "published",
    "minOS": "ubuntu-24.04",
    "compatibility": {
      "bootstrapMinVersion": 1,
      "stateReadVersions": [1],
      "stateWriteVersion": 1
    },
    "rollout": { "cohortSeed": "link-100", "percentage": 5 },
    "withdrawnBuilds": []
  }
}]
```

Archive paths are relative to the manifest and may also be absolute.
Mac arm64 and Windows x86_64 use ZIP archives. Windows uses `windows-11` as its
minimum OS value. Mac uses a value such as `15.0` and takes the platform signer's
base64 EdDSA string in the entry's `sparkleEdSignature` field alongside
`archive`. Supply the final signed bytes. The publisher binds their length and
SHA-256 to both the release record and TUF targets, and the platform update
flow performs its native signature verification.

```sh
/path/to/publisher-venv/bin/python publisher/publish.py stage \
  --root-dir /path/to/public-roots --initial --manifest /path/to/releases.json \
  --output /path/to/first-generation

/path/to/publisher-venv/bin/python publisher/publish.py stage \
  --root-dir /path/to/public-roots --previous /path/to/first-generation \
  --manifest /path/to/changed-releases.json --output /path/to/second-generation
```

Use the latest completed generation as `--previous` for each successive
operation. Serialize publication jobs for a repository so only one operation
assigns new versions at a time. Unchanged slots carry forward automatically.
Update gray rollout by editing `percentage` and retaining the build's seed.
Change `availability` to `withdrawn` to withdraw the slot's current build.
For these operations provide the original release fields with the edited policy
and omit `archive` and `sparkleEdSignature`. Withdrawn builds persist in that
slot. A repair uses a higher build number and a fresh release ID. The build
index binds platform builds and archive paths to their original artifacts
across both channels.

Timestamp renewal uses only `AGENT_LINK_TUF_TIMESTAMP_KEYS`. The existing
targets and snapshot bytes remain signed by their original roles. A renewal
expires within one day and by the snapshot expiry. After a root rotation or
near snapshot expiry, stage new targets and snapshot first.

```sh
/path/to/publisher-venv/bin/python publisher/publish.py refresh-timestamp \
  --root-dir /path/to/public-roots --previous /path/to/second-generation \
  --output /path/to/renewed-generation
```

Configure each installer with the matching record path, for example
`channels/stable/macos-arm64.json`, `channels/stable/windows-x86_64.json` or
`channels/preview/linux-x86_64.json`. Serve the staged `metadata/` and
`targets/` trees over HTTPS. On promotion, publish the immutable roots,
versioned metadata, and hash-prefixed targets first. Keep previously published
immutable objects available while clients or caches may still reference them.
Promote `metadata/timestamp.json` last as a single object with short cache
lifetime. The publisher writes a fresh local directory for inspection and tests.

Set `AGENT_LINK_PUBLISH_PYTHON` to the virtual environment's Python executable
when running `npm test` to include a publisher-to-client test covering both
channels, all desktop platforms, withdrawals, repair, root rotation and
timestamp renewal. [The Update Framework repository specification](https://theupdateframework.github.io/specification/latest/)
