# xagt.link conversation assets

This package provides a service for storing and restoring user-owned conversations. Run it on your own VPS with PostgreSQL and a single owner. An optional collector token submits captures and checks its own receipts. The official Hosted integration is a separate, ciphertext-only use of the storage API.

## Run a standalone instance

Install the package with Python 3.12 from this directory or from its built wheel.

```sh
python -m pip install .
```

Provide these variables through the deployment environment.

| Variable | Value |
| --- | --- |
| `XAGT_ASSETS_DSN` | PostgreSQL DSN for a database dedicated to the service |
| `XAGT_ASSETS_CLOUD_KEY` | Optional random 32-byte key encoded as hex. Enables private-instance processing. Omit it for a ciphertext-only instance and keep any recovery copy apart from the database |
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

With the Android Control catalog enabled for a test account, open **Conversation reading keys** and generate this phone's reading key. Verify the phone's displayed fingerprint before using its copied device ID as `--recipient-device-id`. Decode the copied public key from hexadecimal to a raw 32-byte file for `--recipient-public-key-file`. On the phone, add the collector's signing device ID and independently verified Ed25519 public key as a trusted signer. This permits reading captures addressed to this phone.

```sh
python -m xagt_assets.collector upload /path/to/session.jsonl \
  --source-root /path/to/sessions --installation-id example-install \
  --store-id example-store --journal /private/xagt-journal \
  --mode userHeld --base-url http://127.0.0.1:8765/assets/v1 \
  --recipient-device-id my-device --recipient-public-key-file /private/device.pub \
  --signer-device-id my-collector --signer-private-key-file /private/collector.key \
  --operation-id example-capture-2
```

## Automatic capture

Create a local JSON allowlist outside the source trees. Each local item sets `path`, `root`, `installationId`, `storeId`, and `mode`. A directory is an explicit collection of its bounded contents. For one stable asset per native session, list each session file separately. A `userHeld` item also supplies `recipientPublicKeyFile`, `signerPrivateKeyFile`, `recipientDeviceId` and `signerDeviceId`.

An ACS item sets `kind` to `acs` and specifies `baseUrl`, `sessionId`, `installationId`, `storeId`, `scope` with `OBSERVE`, `clientSessionTokenEnv`, and `mode`. Set `bearerEnv` when the ACS deployment also requires a bearer. Supply authorized source credentials through the named environment variables. The destination collector credential is `XAGT_ASSET_BEARER`. The archiver binds history pages to the selected session and transcript revision.

Set `archiveAttachments: true` on sources whose attachment content you want to archive. Pi reads inline PNG and JPEG image blocks from the selected native user-message history. ACS reads the listed text and image references through its per-session attachment endpoints and verifies each size and SHA-256. Capture is bounded to 32 references, 2 MiB per source item, and 8 MiB per revision poll. A sealed conversation can report an attachment as pending or unavailable. Restart with the same state and journal to reconcile pending objects, and an unchanged revision can fill an attachment gap.

```sh
python -m xagt_assets.auto --enable --config /private/asset-sources.json \
  --base-url http://127.0.0.1:8765/assets/v1 \
  --journal /private/xagt-journal --state /private/xagt-state.json --once
```

Omit `--once` for continuous polling. The persisted state records the confirmed head and pending operation for each source. Keep it with the journal across restarts. An unchanged source is skipped. Partial captures are reported and require `--upload-partial` or the matching config policy to be uploaded. If enrollment refresh changes the destination token, set `--auth-subject` to the same verified installation identity when starting the process.

## Attachment storage

Install with `python -m pip install '.[s3]'`. Configure a private S3-compatible bucket on the user's storage service. Set `XAGT_ASSETS_S3_ENDPOINT`, `XAGT_ASSETS_S3_BUCKET`, `XAGT_ASSETS_S3_ACCESS_KEY` and `XAGT_ASSETS_S3_SECRET_KEY` together. `XAGT_ASSETS_S3_REGION` defaults to `us-east-1`. Use HTTPS for network endpoints. Run `standalone init` when upgrading so the new attachment tables are installed before starting the server.

Attach a selected file to an already-saved revision with `python -m xagt_assets.attachment_client attach`. Pass the asset ID, revision ID, service URL, private journal and the revision's encryption mode. For `userHeld`, also supply the recipient and signing keys with the device IDs. `retry` resumes an interrupted upload. `check` verifies committed content, and `restore` writes a new file to the user-selected destination. Run `python -m xagt_assets.attachment_client --help` for options.

```sh
python -m xagt_assets.attachment_client attach /path/to/report.pdf \
  --base-url http://127.0.0.1:8765/assets/v1 --asset-id ASSET_ID \
  --revision-id REVISION_ID --mode cloudProcessable --journal /private/xagt-journal
```

The service stages metadata, validates size and digest, then commits the revision's attachment. An incomplete upload remains concealed from reads. Private VPS processing encrypts stored attachment bytes with the deployment key. Device-held uploads arrive as ciphertext. Review the returned byte limit in `/capabilities` and schedule `standalone cleanup-attachments` to expire staged uploads and clean up objects after deletion.

## Catalog, search and exact-revision grants

An owner can request `GET /assets/v1/catalog?limit=50`. Use `nextAfter` as the next request's `after` until it is null. Each item contains the asset ID, head revision ID, encryption mode and update time. The official Hosted adapter exposes the authorized `userHeld` catalog only when its member feature is enabled.

On a private standalone instance with a cloud key, start `standalone serve --enable-search` to enable `POST /assets/v1/search`. Send a JSON body such as `{"query":"release notes","candidateLimit":50,"maxResults":20}`. The owner gets bounded snippets from normalized messages in recent cloud-processable heads, plus revision and message references and any search limits that were reached. Keep request and response body capture disabled on the reverse proxy. For a portable archive, run the offline reader with `python -m xagt_assets.local_search` and the selected asset, revision and keyword. It verifies and reads the archive in memory. User-held bundles additionally require the recipient private key and trusted signer public key.

For private standalone exact-revision reads, initialize once with `standalone init --enable-read-grants` and serve with `standalone serve --enable-read-grants`. Both flags work together on `serve`. The owner issues a grant with `POST /assets/v1/grants` and a JSON body containing `assetId`, `revisionId`, `mode`, and `expiresInSec` (1–900). Provide the returned token in the recipient's Authorization header for `GET /assets/v1/grants/{grantId}/conversations/{assetId}/revisions/{revisionId}`. The owner can revoke it with `DELETE /assets/v1/grants/{grantId}`. Treat the response token as a secret. A grant covers one exact revision and expires, is revoked, or stops working when its asset is deleted. In user-held mode the grant returns the original ciphertext and envelope, which the existing trusted device key can open.

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

## Share selected messages with another device

Create a separate encrypted share bundle on a device that can already open the source revision. Verify the recipient public key with the recipient before issuing the share.

```sh
python -m xagt_assets.share /private/conversation.zip \
  --asset-id ASSET_ID --revision-id REVISION_ID --message-id MESSAGE_ID \
  --source-recipient-private-key /private/device.key \
  --source-signer-public-key /private/collector.pub \
  --recipient-device-id target-device --recipient-public-key /private/target.pub \
  --signer-device-id owner-device --signer-private-key /private/owner.key \
  --destination /private/shared-messages.zip
```

Use one `--message-id` per selected message. The two source key options apply to a user-held source. The recipient opens the new asset and revision with `xagt_assets.unlock`, their own private key, and the owner's verified signing public key. The original message IDs and provenance are inside the ciphertext. This offline handoff leaves no server record, and a copy already delivered to a recipient remains readable by that recipient.

## Verification and current scope

Install test dependencies with `python -m pip install '.[test]'`. Run `python -m pytest tests`. Supply `XAGT_ASSETS_TEST_POSTGRES` pointing to an isolated test server whose test role can create disposable databases to include database and HTTP verification.

See [service recovery](RECOVERY.md) for taking a PostgreSQL and object store snapshot at a final write cutoff and verifying it before reopening the instance.

Immutable revision payloads remain in PostgreSQL, with bounded attachments in S3-compatible storage. Automatic capture operates on the user's allowlist. Subsequent steps include source discovery, large streamed transfers, content indexing and organization, online message-level grants and device enrollment, multi-user self-host administration, and Control app screens. The member capability remains disabled by default in Daily Hosted.
