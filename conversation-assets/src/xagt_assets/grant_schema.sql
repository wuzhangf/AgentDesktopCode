-- Optional read-grant schema.  It is intentionally separate from the asset
-- schema: a self-host can enable revocable grants only after testing the
-- token boundary, without changing revision writes.
CREATE TABLE IF NOT EXISTS xagt_asset_read_grants (
    tenant_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    member_id TEXT NOT NULL,
    grant_id TEXT NOT NULL,
    asset_id TEXT NOT NULL,
    revision_id TEXT NOT NULL,
    mode TEXT NOT NULL CHECK (mode IN ('cloudProcessable', 'userHeld')),
    token_digest TEXT NOT NULL,
    recipient_device_id TEXT,
    expires_at TEXT NOT NULL,
    revoked_at TEXT,
    created_at TEXT NOT NULL,
    created_by_subject TEXT NOT NULL,
    PRIMARY KEY (tenant_id, workspace_id, member_id, grant_id),
    UNIQUE (tenant_id, workspace_id, member_id, token_digest)
);

CREATE UNIQUE INDEX IF NOT EXISTS xagt_asset_read_grants_id_idx
    ON xagt_asset_read_grants (grant_id);
