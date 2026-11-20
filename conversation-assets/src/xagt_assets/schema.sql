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

-- Attachment metadata is deliberately separate from revision payloads.  A
-- row is staged before bytes are uploaded and becomes reader-visible only at
-- commit.  ``object_key`` is random and contains no user-controlled path.
CREATE TABLE IF NOT EXISTS xagt_asset_attachments (
    tenant_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    member_id TEXT NOT NULL,
    subject_id TEXT NOT NULL,
    asset_id TEXT NOT NULL,
    revision_id TEXT NOT NULL,
    attachment_id TEXT NOT NULL,
    mode TEXT NOT NULL CHECK (mode IN ('cloudProcessable', 'userHeld')),
    content_type TEXT NOT NULL,
    expected_bytes INTEGER NOT NULL CHECK (expected_bytes >= 0),
    sha256 TEXT NOT NULL,
    object_key TEXT NOT NULL UNIQUE,
    state TEXT NOT NULL CHECK (state IN ('staged', 'committed', 'deleted')),
    envelope_json TEXT,
    stored_sha256 TEXT,
    created_at TEXT NOT NULL,
    uploaded_at TEXT,
    committed_at TEXT,
    deleted_at TEXT,
    PRIMARY KEY (tenant_id, workspace_id, member_id, asset_id, revision_id, attachment_id),
    FOREIGN KEY (tenant_id, workspace_id, member_id, asset_id)
        REFERENCES xagt_asset_conversations(tenant_id, workspace_id, member_id, asset_id)
);

CREATE INDEX IF NOT EXISTS xagt_asset_attachments_revision_idx
    ON xagt_asset_attachments (tenant_id, workspace_id, member_id, asset_id, revision_id, state);
