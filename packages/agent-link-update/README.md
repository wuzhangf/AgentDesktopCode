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

## Include a release in the public download catalog

Add a `download` object alongside `release` and `archive` after platform
signing and qualification of the final bytes. The approval records the
following fields.

- `qualifiedUpdateSha256` is the SHA-256 recorded by the archive qualification.
- `qualifiedInstallerSha256` is the SHA-256 recorded by the installer
  qualification. On Linux this matches the update archive.
- `installer` is the path to the qualified DMG on Mac or MSI on Windows.
  The desktop updater continues to use the ZIP archive. Existing Mac ZIP
  downloads remain compatible with the catalog.
- `publishedAt` is a UTC date and time in `YYYY-MM-DDTHH:mm:ssZ` format.
- `releaseNotes` and `installation` are public plain text.

The publisher compares both approved digests to the staged bytes, signs the
catalog as the `publication/catalog.json` target, and writes the same bytes
at `/catalog.json` for EnterprisePortal. Releases with no download approval
stay out of the public catalog. Existing rows retain their publication date.
For a new Linux or Windows download approval, the manifest inside the
qualified update archive must agree with the release record's display
version and build number. Linux also checks the manifest's platform and
architecture. Windows checks the packaged PE file version recorded in the
manifest. Platform signing and installation qualification still apply to
the final installer.
The catalog retains superseded and withdrawn entries for version history.
A zero-percent rollout pauses links for its current build. Portal offers
links only for rows with `availability: published`.

Use the staged catalog and targets together. The installer URL is
`/targets/<directory>/<sha256>.<filename>` using the directory and filename
from the catalog's installer path. Publish and verify the immutable objects
before promoting the short-cache catalog. On withdrawal, publish the updated
catalog when stopping new download recommendations. Use conditional or atomic
writes when changing the catalog and timestamp and supply validators that
change with the bytes.

The reference [nginx origin configuration](publisher/download-origin.nginx.conf)
serves the staged tree behind an HTTPS front end. It enables anonymous CORS for
the catalog, short caching for the mutable JSON files, and native file ranges
for archives. Use content-based ETags on the final CDN or distinct modification
times for atomic replacements of mutable files on the reference origin.
Verify GET, HEAD, Range, size, SHA-256, conditional GET and missing-object 404s
on the public host before activation. [nginx static file and ETag documentation](https://nginx.org/en/docs/http/ngx_http_core_module.html)

## Promote and recover a publication

Use a release bucket served at the download origin and a separate private
publication state bucket. Install the publisher and S3 client with
`pip install -r publisher/requirements-promotion.txt`. Supply the S3 identity
through the SDK credential chain. Set the S3-compatible endpoint and region
through `AWS_ENDPOINT_URL` and `AWS_DEFAULT_REGION` when applicable. The
promotion process needs no TUF signing keys.

Qualify the chosen provider's conditional create and ETag-based writes before
connecting the CDN. Give the publisher read and conditional write access to
these two buckets. The credentials must be able to distinguish a missing
object from a denied read. Serve only release keys through the public origin.
The catalog needs anonymous CORS for the Portal origin. Keep the expected
content types, cache headers, ETags and byte ranges available through the
CDN. [S3 conditional write behavior](https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-writes.html)

```sh
python publisher/promote.py promote --candidate /path/to/staged-generation \
  --root-dir /path/to/public-roots --public-origin https://downloads.steercrew.com \
  --release-bucket agent-link-releases --state-bucket agent-link-publication-private \
  --operation-id link-release-100 --expected-revision 0

python publisher/promote.py status \
  --release-bucket agent-link-releases --state-bucket agent-link-publication-private \
  --operation-id link-release-100
```

Start an empty release origin at revision 0. Use the revision in a completed
receipt as the next operation's expected revision. Keep the signed staging
directory for the operation. The private state object reserves one active
operation and stores completion receipts. The publisher verifies the locally
staged signatures, uses create-only writes for immutable objects, and verifies
their bytes and ranges from the public origin before changing pointers.
Ordinary releases promote the update timestamp before the download catalog.
Withdrawals and pauses remove the public download recommendation first.

If an upload or a CDN verification fails, query the status and rerun the
original command with the same operation ID, revision and staged bytes.
Already-written objects and pointers are reconciled before proceeding. A new
operation waits for the active one to finish. An expired unfinished operation
can continue under the same ID and revision with `--recover-expired` and a
new signed generation staged from that unfinished generation. Use
`refresh-timestamp` while its snapshot and targets remain valid. When they
have expired, stage new metadata from the unfinished generation with the
same approved release content and current signing roles. Recovery verifies
that release records, installer bytes and public catalog content agree with
the active operation before advancing the metadata versions.

Run the integration test against a disposable loopback S3 endpoint after
`npm ci`. Supply test credentials and a region through the SDK environment.

```sh
AGENT_LINK_TEST_S3=1 AWS_ENDPOINT_URL=http://127.0.0.1:9000 \
  python publisher/test_promotion_s3.py -v
```
