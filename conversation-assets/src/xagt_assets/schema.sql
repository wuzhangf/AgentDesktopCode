CREATE TABLE IF NOT EXISTS xagt_asset_conversations (
    tenant_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    member_id TEXT NOT NULL,
    asset_id TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT,
    head_revision TEXT,
    PRIMARY KEY (tenant_id, workspace_id, member_id, asset_id)
);

CREATE TABLE IF NOT EXISTS xagt_asset_revisions (
    tenant_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    member_id TEXT NOT NULL,
    subject_id TEXT NOT NULL,
    asset_id TEXT NOT NULL,
    revision_id TEXT NOT NULL,
    parent_revision TEXT,
    mode TEXT NOT NULL CHECK (mode IN ('cloudProcessable', 'userHeld')),
    payload_json TEXT NOT NULL,
    payload_digest TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    captured_through TEXT,
    coverage TEXT NOT NULL DEFAULT 'unknown',
    created_at TEXT NOT NULL,
    PRIMARY KEY (tenant_id, workspace_id, member_id, asset_id, revision_id),
    UNIQUE (tenant_id, workspace_id, member_id, subject_id, operation_id),
    UNIQUE (tenant_id, workspace_id, member_id, subject_id, idempotency_key),
    FOREIGN KEY (tenant_id, workspace_id, member_id, asset_id)
        REFERENCES xagt_asset_conversations(tenant_id, workspace_id, member_id, asset_id)
);

CREATE TABLE IF NOT EXISTS xagt_asset_operations (
    tenant_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    member_id TEXT NOT NULL,
    subject_id TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    asset_id TEXT NOT NULL,
    revision_id TEXT NOT NULL,
    payload_digest TEXT NOT NULL,
    state TEXT NOT NULL,
    result_json TEXT,
    created_at TEXT NOT NULL,
    PRIMARY KEY (tenant_id, workspace_id, member_id, subject_id, operation_id),
    UNIQUE (tenant_id, workspace_id, member_id, subject_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS xagt_asset_tombstones (
    tenant_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    member_id TEXT NOT NULL,
    asset_id TEXT NOT NULL,
    deleted_at TEXT NOT NULL,
    deletion_epoch INTEGER NOT NULL,
    PRIMARY KEY (tenant_id, workspace_id, member_id, asset_id)
);
