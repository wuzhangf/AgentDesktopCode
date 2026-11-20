"""Verify the database-to-object references of a quiesced asset instance."""

import hashlib
from dataclasses import asdict, dataclass

from .object_store import ObjectNotFound, ObjectStore, ObjectStoreError
from .store import AssetStore


@dataclass
class StorageCheck:
    checked: int = 0
    missing: int = 0
    digest_mismatch: int = 0
    unavailable: int = 0

    @property
    def ok(self) -> bool:
        return self.missing == self.digest_mismatch == self.unavailable == 0

    def report(self) -> dict:
        return {"schemaVersion": "xagt-asset-storage-check/1", "ok": self.ok, **asdict(self)}


def verify_storage(store: AssetStore, objects: ObjectStore | None) -> StorageCheck:
    """Hash each live object, including bytes for any resumable staged uploads."""
    result = StorageCheck()
    after = ""
    while True:
        with store.connection() as connection:
            rows = store._query(
                connection,
                "SELECT a.object_key,a.stored_sha256 FROM xagt_asset_attachments a "
                "JOIN xagt_asset_conversations c ON c.tenant_id=a.tenant_id "
                "AND c.workspace_id=a.workspace_id AND c.member_id=a.member_id AND c.asset_id=a.asset_id "
                "WHERE c.deleted_at IS NULL AND a.object_key>? "
                "AND (a.state='committed' OR (a.state='staged' AND a.uploaded_at IS NOT NULL)) "
                "ORDER BY a.object_key LIMIT 256",
                (after,),
            )
        if not rows:
            return result
        if objects is None:
            raise ValueError("attachment storage is required to verify this database")
        after = rows[-1]["object_key"]
        for row in rows:
            result.checked += 1
            try:
                data, _ = objects.get(row["object_key"])
            except ObjectNotFound:
                result.missing += 1
            except ObjectStoreError:
                result.unavailable += 1
            else:
                if hashlib.sha256(data).hexdigest() != row["stored_sha256"]:
                    result.digest_mismatch += 1
