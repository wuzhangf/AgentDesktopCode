# xagt.link conversation assets

This package provides the first service for storing and restoring user-owned conversations. The standalone service uses PostgreSQL and a single owner. An optional collector token can submit captures and check its own receipts. Daily Hosted uses the same router behind its member and device authentication.

## Run a standalone instance

Install the package with Python 3.12 from this directory or from its built wheel.

```sh
python -m pip install .
```

Provide these variables through the deployment environment.

| Variable | Value |
| --- | --- |
| `XAGT_ASSETS_DSN` | PostgreSQL DSN for a database dedicated to the service |
| `XAGT_ASSETS_CLOUD_KEY` | Random 32-byte key encoded as hex. Keep a recoverable copy separately from the database |
| `XAGT_ASSETS_OWNER_TOKEN` | Random bearer credential of at least 32 ASCII characters |
| `XAGT_ASSETS_COLLECTOR_TOKEN` | Optional distinct collector credential of at least 32 ASCII characters |

Apply the schema once, then start the service. The HTTP listener uses loopback. A remote collector connects through an HTTPS reverse proxy.

```sh
python -m xagt_assets.standalone init
python -m xagt_assets.standalone serve --port 8765
```

## Archive and retrieve a capture

Select a session file in the local source tree. Pass the same installation and store identifiers on every capture, including after a change of path or device name. The collector records the original bytes, normalized records and its coverage. Place the journal in private storage outside the source tree. Provide the collector token in `XAGT_ASSET_BEARER`.

```sh
python -m xagt_assets.collector upload /path/to/session.jsonl \
  --source-root /path/to/sessions --installation-id example-install \
  --store-id example-store --journal /private/xagt-journal \
  --mode cloudProcessable --base-url http://127.0.0.1:8765/assets/v1 \
  --operation-id example-capture-1
```

`reconcile` looks up the original operation. If it has no receipt, `retry` sends the exact journaled content with the same key. Pass the current revision as `--expected-revision` when appending. The reply contains the asset and revision IDs. An owner uses these IDs to read the revision.

For `userHeld`, specify the recipient's X25519 public key, the collector's Ed25519 signing key and their device identifiers. The corresponding recipient private key and trusted signer public key are needed to open the archive. The key files are raw 32-byte values for the offline reader. An explicit local `scan` produces a readable copy and should use a private output location.

```sh
python -m xagt_assets.collector upload /path/to/session.jsonl \
  --source-root /path/to/sessions --installation-id example-install \
  --store-id example-store --journal /private/xagt-journal \
  --mode userHeld --base-url http://127.0.0.1:8765/assets/v1 \
  --recipient-device-id my-device --recipient-public-key-file /private/device.pub \
  --signer-device-id my-collector --signer-private-key-file /private/collector.key \
  --operation-id example-capture-2
```

## Export and restore a conversation

Use the owner token as `XAGT_ASSET_BEARER`. Export fixes the head revision and collects its parent chain. The portable bundle contains a manifest with file checksums. `cloudProcessable` bundles contain readable user data, so store the file privately. `userHeld` bundles retain ciphertext and the recipient envelope. Keep the recipient's decryption material separately.

```sh
python -m xagt_assets.portability --base-url http://127.0.0.1:8765/assets/v1 \
  export ASSET_ID HEAD_REVISION /private/conversation.zip
python -m xagt_assets.portability --base-url https://destination.example/assets/v1 \
  restore /private/conversation.zip
```

Set the destination owner credential for restoration. Import validates the archive and checks revision parent relationships before it writes. Retrying resumes through stable import keys. A cloud-processable archive contains readable JSON. A user-held archive can be opened offline using the recipient key and trusted collector public key. To sign an archive on export, supply `--archive-signing-key` and `--archive-signer-device-id`. Supply the trusted `--archive-signer-public-key` on restore to require that signature.

### Offline read-only unlock

`xagt_assets.unlock` runs locally. It verifies the selected revision and writes a new file at the destination you specify. Cloud-processable exports already contain readable JSON. For a user-held archive, supply the recipient X25519 private key and the envelope signer's Ed25519 public key as separate raw 32-byte files. A signed archive can additionally be verified against its archive signer.

```sh
# cloudProcessable: local JSON read, no service or key access
python -m xagt_assets.unlock /private/conversation.zip \
  --asset-id ASSET_ID --revision-id REVISION_ID \
  --destination /private/revision.json

# userHeld: decrypt locally; archive signer verification is optional
python -m xagt_assets.unlock /private/conversation.zip \
  --asset-id ASSET_ID --revision-id REVISION_ID \
  --recipient-private-key /private/device.key \
  --signer-public-key /private/collector.pub \
  --archive-signer-public-key /private/archive.pub \
  --destination /private/revision.json
```

## Verification and current scope

Install test dependencies with `python -m pip install '.[test]'`. Run `python -m pytest tests`. Supply `XAGT_ASSETS_TEST_POSTGRES` pointing to an isolated test server whose test role can create disposable databases to include database and HTTP verification.

This foundation handles bounded immutable revisions stored in PostgreSQL. Object-store streaming and attachments, continuous source discovery, full-text search, server-side organization, revocable Agent grants, multi-user self-host administration and Control app screens are subsequent implementation steps. Supported capture formats and exact numeric limits are enforced at the collector and service. The member capability remains opt-in in Daily Hosted.
