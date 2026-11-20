# Recover a self-hosted conversation asset instance

A conversation export carries selected revisions for use on another deployment. A service recovery preserves all database state at a known cutoff, including operation receipts, revocations, and deletion tombstones. Use this procedure for a dedicated standalone instance.

## Take a final snapshot

1. Keep the source database and bucket accessible to the backup operator. Stop the asset HTTP service and its cleanup jobs. Block writes from any other process. Collectors can retain their pending uploads locally and resume with their original operation IDs after the switch.
2. Record the UTC cutoff and the installed package version. Dump the dedicated database in PostgreSQL custom format using a protected libpq service configuration. Record the SHA-256 of the dump.

   ```sh
   pg_dump --dbname=service=xagt_assets_source --format=custom --file=conversation-assets.dump
   ```

3. Keep each referenced S3 object at its original key. The snapshot must include committed attachments and staged attachments with an upload receipt. Query the frozen source database for the copy list. Copy the stored bytes without decrypting them, and protect the inventory alongside the dump.

   ```sql
   SELECT a.object_key, a.stored_sha256
   FROM xagt_asset_attachments a
   JOIN xagt_asset_conversations c
     ON c.tenant_id = a.tenant_id AND c.workspace_id = a.workspace_id
     AND c.member_id = a.member_id AND c.asset_id = a.asset_id
   WHERE c.deleted_at IS NULL
     AND (a.state = 'committed' OR (a.state = 'staged' AND a.uploaded_at IS NOT NULL))
   ORDER BY a.object_key;
   ```

4. Store the snapshot and the private VPS cloud key separately. Retain the independent recipients' trusted device keys and signer public keys needed for user-held data. Use deployment-managed credentials for the target database, bucket, and HTTP service.

## Verify and reopen

1. Provision a new empty database and private bucket. Keep the service and any public ingress stopped. Verify the dump checksum, then restore the database and copy the objects using the captured keys.

   ```sh
   pg_restore --dbname=service=xagt_assets_target --exit-on-error --single-transaction \
     --no-owner --no-privileges conversation-assets.dump
   ```

2. Configure the target's database and bucket. Run `python -m xagt_assets.standalone verify-storage`. Add `--enable-read-grants` if the source had installed the grant schema. The command checks actual stored bytes against the database digests and exits with an error if an object is missing, corrupt, or unavailable.
3. Confirm the restored cutoff is the latest one before opening the service. If the source accepted any later deletes or revocations, reconcile them on an isolated target first or take a new final snapshot. The dump preserves only its own cutoff and this procedure does not apply later changes automatically.
4. Start the target on loopback with the same data keys and policy. Check known revision IDs and operation receipts, read an attachment in each configured mode, decrypt a user-held sample on its trusted device, and verify a revoked grant and tombstoned asset remain inaccessible. Record the tested cutoff, restore duration, object counts, and results. Then admit clients on the new endpoint and retire the old write path.

Keep backups and recovery records subject to the deployment's access and retention policies. Use a separate snapshot policy for any database or bucket shared with other services.
