-- PAE P7 reports schema DRAFT — P5 registers this in management.db's
-- migration ledger (task §3 owner table: P5 owns the management persistence
-- entry point; P7 supplies table definitions only). All timestamps are UTC
-- RFC-3339 TEXT; all digests are 'sha256:<64 lowercase hex>'; all ids match
-- ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$. No secret values ever — only refs.

-- Report request + result projection. requestKey is the frozen idempotency
-- handle: UNIQUE(request_key) + body_digest comparison gives "same key same
-- body → same report; same key different body → IDEMPOTENCY_CONFLICT".
CREATE TABLE IF NOT EXISTS report_request (
  report_id               TEXT PRIMARY KEY,
  request_key             TEXT NOT NULL UNIQUE,
  body_digest             TEXT NOT NULL,
  source_ref              TEXT NOT NULL,
  source_version          TEXT,
  source_digest           TEXT,          -- caller-declared pin (may be NULL)
  resolved_source_digest  TEXT,          -- digest of facts actually read
  source_watermark        TEXT,          -- source freshness: mtime/updatedAt/max endedAt
  report_profile_ref      TEXT,
  provider_ref            TEXT NOT NULL, -- 'local' or a declared provider ref
  output_format           TEXT NOT NULL, -- markdown+json | markdown | json
  data_scope_json         TEXT,          -- JSON array of user-declared scope tokens
  state                   TEXT NOT NULL, -- QUEUED|RUNNING|READY|FAILED|UNKNOWN
  error_code              TEXT,
  error_message           TEXT,
  result_digest           TEXT,          -- digest of canonical report.json
  created_at              TEXT NOT NULL,
  updated_at              TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_report_request_state ON report_request(state);
CREATE INDEX IF NOT EXISTS idx_report_request_created ON report_request(created_at);

-- Result file index. rel_path stays server-side; the wire surface exposes
-- only fileId/name/mediaType/sizeBytes/digest.
CREATE TABLE IF NOT EXISTS report_file (
  file_id      TEXT PRIMARY KEY,
  report_id    TEXT NOT NULL REFERENCES report_request(report_id),
  name         TEXT NOT NULL,            -- report.md | report.json
  media_type   TEXT NOT NULL,
  size_bytes   INTEGER NOT NULL,
  digest       TEXT NOT NULL,
  rel_path     TEXT NOT NULL,
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_report_file_report ON report_file(report_id);

-- Last-used report preferences (real persistence; upserted on each accepted
-- REPORT_CREATE). owner_key is 'default' for a single-user install.
CREATE TABLE IF NOT EXISTS report_preferences (
  owner_key           TEXT PRIMARY KEY,
  last_provider_ref   TEXT,
  last_profile_ref    TEXT,
  last_output_format  TEXT,
  last_data_scope_json TEXT,
  updated_at          TEXT NOT NULL
);

-- Subscription drafts: intent only. `enabled` is written 0 by the service
-- unconditionally — no scheduler/account/settlement exists in this build and
-- a draft NEVER creates a task (E39). Automatic cadence lands behind a
-- future contract addition, not this table.
CREATE TABLE IF NOT EXISTS report_subscription_draft (
  draft_id            TEXT PRIMARY KEY,
  owner_key           TEXT NOT NULL,
  source_ref          TEXT NOT NULL,
  report_profile_ref  TEXT,
  cadence             TEXT NOT NULL DEFAULT 'once', -- once|daily|weekly (intent)
  note                TEXT,
  enabled             INTEGER NOT NULL DEFAULT 0 CHECK (enabled = 0),
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_report_subscription_draft_owner ON report_subscription_draft(owner_key);
