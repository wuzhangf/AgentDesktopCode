# Agent Link update verification prototype

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
