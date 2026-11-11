/**
 * PAE P8 assembly glue — mounts the P7 reports submodule
 * (`server/management/reports/**`, P7-owned) onto the P5 personal management
 * gateway. Two real seams are closed here:
 *
 * 1. Persistence: `ReportsRepository` (ports.mjs typedef) implemented over the
 *    shared `management.db` `DatabaseSync`, so report rows live in the same
 *    writable registry and reopen after restart (the memory repository is
 *    DEV/TEST only and is never mounted here).
 * 2. Migration: P7's `ddl.sql` is registered in the management.db ledger as
 *    namespace `p7-reports` version 100 (≥100 reserved for P7; P5 core owns
 *    1..99 — migrations.ts convention). The SQL text is inlined at bundle
 *    time via Vite `?raw`, so the built `.local/management-server` artifact
 *    does not depend on source-tree file layout.
 *
 * Record mapping follows P7's contract: camelCase records ↔ snake_case
 * columns; `data_scope_json`/`last_data_scope_json` hold JSON.stringify'd
 * arrays (NULL = undeclared); `enabled` is INTEGER with CHECK (enabled = 0).
 */
import type { DatabaseSync } from 'node:sqlite';
import reportsDdl from './reports/ddl.sql?raw';
import type { ManagementMigration } from './migrations';

/** p7-reports namespace, versions ≥100 (migrations.ts convention). */
export const REPORTS_MIGRATIONS: readonly ManagementMigration[] = [{
  version: 100,
  namespace: 'p7-reports',
  name: 'reports_tables',
  up(db) {
    db.exec(reportsDdl);
  },
}];

interface ReportRecord {
  reportId: string;
  requestKey: string;
  bodyDigest: string;
  sourceRef: string;
  sourceVersion: string | null;
  sourceDigest: string | null;
  resolvedSourceDigest: string | null;
  sourceWatermark: string | null;
  reportProfileRef: string | null;
  providerRef: string;
  outputFormat: string;
  dataScope: string[] | null;
  state: string;
  errorCode: string | null;
  errorMessage: string | null;
  resultDigest: string | null;
  createdAt: string;
  updatedAt: string;
}

interface ReportFileRecord {
  fileId: string;
  reportId: string;
  name: string;
  mediaType: string;
  sizeBytes: number;
  digest: string;
  relPath: string;
  createdAt: string;
}

interface ReportPreferencesRecord {
  ownerKey: string;
  lastProviderRef: string | null;
  lastProfileRef: string | null;
  lastOutputFormat: string | null;
  lastDataScope: string[] | null;
  updatedAt: string;
}

interface SubscriptionDraftRecord {
  draftId: string;
  ownerKey: string;
  sourceRef: string;
  reportProfileRef: string | null;
  cadence: string;
  note: string | null;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

function parseScope(value: unknown): string[] | null {
  if (value === null || value === undefined) return null;
  try {
    const parsed = JSON.parse(String(value));
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function toReport(row: Record<string, unknown>): ReportRecord {
  return {
    reportId: String(row.report_id),
    requestKey: String(row.request_key),
    bodyDigest: String(row.body_digest),
    sourceRef: String(row.source_ref),
    sourceVersion: row.source_version === null ? null : String(row.source_version),
    sourceDigest: row.source_digest === null ? null : String(row.source_digest),
    resolvedSourceDigest: row.resolved_source_digest === null ? null : String(row.resolved_source_digest),
    sourceWatermark: row.source_watermark === null ? null : String(row.source_watermark),
    reportProfileRef: row.report_profile_ref === null ? null : String(row.report_profile_ref),
    providerRef: String(row.provider_ref),
    outputFormat: String(row.output_format),
    dataScope: parseScope(row.data_scope_json),
    state: String(row.state),
    errorCode: row.error_code === null ? null : String(row.error_code),
    errorMessage: row.error_message === null ? null : String(row.error_message),
    resultDigest: row.result_digest === null ? null : String(row.result_digest),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function toFile(row: Record<string, unknown>): ReportFileRecord {
  return {
    fileId: String(row.file_id),
    reportId: String(row.report_id),
    name: String(row.name),
    mediaType: String(row.media_type),
    sizeBytes: Number(row.size_bytes),
    digest: String(row.digest),
    relPath: String(row.rel_path),
    createdAt: String(row.created_at),
  };
}

function toPreferences(row: Record<string, unknown>): ReportPreferencesRecord {
  return {
    ownerKey: String(row.owner_key),
    lastProviderRef: row.last_provider_ref === null ? null : String(row.last_provider_ref),
    lastProfileRef: row.last_profile_ref === null ? null : String(row.last_profile_ref),
    lastOutputFormat: row.last_output_format === null ? null : String(row.last_output_format),
    lastDataScope: parseScope(row.last_data_scope_json),
    updatedAt: String(row.updated_at),
  };
}

function toDraft(row: Record<string, unknown>): SubscriptionDraftRecord {
  return {
    draftId: String(row.draft_id),
    ownerKey: String(row.owner_key),
    sourceRef: String(row.source_ref),
    reportProfileRef: row.report_profile_ref === null ? null : String(row.report_profile_ref),
    cadence: String(row.cadence),
    note: row.note === null ? null : String(row.note),
    enabled: Number(row.enabled) !== 0,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

/** camelCase patch field → snake_case column for updateReport. Values may be
 * written as NULL when the service clears them (errorCode/errorMessage). */
const PATCH_COLUMNS: Record<string, string> = {
  sourceVersion: 'source_version',
  sourceDigest: 'source_digest',
  resolvedSourceDigest: 'resolved_source_digest',
  sourceWatermark: 'source_watermark',
  reportProfileRef: 'report_profile_ref',
  providerRef: 'provider_ref',
  outputFormat: 'output_format',
  dataScope: 'data_scope_json',
  state: 'state',
  errorCode: 'error_code',
  errorMessage: 'error_message',
  resultDigest: 'result_digest',
  updatedAt: 'updated_at',
};

/**
 * ReportsRepository over the shared management.db (ddl.sql tables). All
 * methods are synchronous sqlite calls — the P7 service always awaits them,
 * so sync returns are valid per the ports contract.
 */
export function createSqliteReportsRepository(db: DatabaseSync) {
  return {
    /** Insert-or-fail: request_key is UNIQUE; the service checks it first
     * and relies on the constraint for the concurrent edge. */
    putReportRequest(rec: ReportRecord): void {
      db.prepare(`INSERT INTO report_request(
          report_id, request_key, body_digest, source_ref, source_version,
          source_digest, resolved_source_digest, source_watermark,
          report_profile_ref, provider_ref, output_format, data_scope_json,
          state, error_code, error_message, result_digest, created_at, updated_at
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        rec.reportId, rec.requestKey, rec.bodyDigest, rec.sourceRef,
        rec.sourceVersion ?? null, rec.sourceDigest ?? null,
        rec.resolvedSourceDigest ?? null, rec.sourceWatermark ?? null,
        rec.reportProfileRef ?? null, rec.providerRef, rec.outputFormat,
        rec.dataScope === null || rec.dataScope === undefined ? null : JSON.stringify(rec.dataScope),
        rec.state, rec.errorCode ?? null, rec.errorMessage ?? null,
        rec.resultDigest ?? null, rec.createdAt, rec.updatedAt);
    },
    findReportByRequestKey(requestKey: string): ReportRecord | null {
      const row = db.prepare('SELECT * FROM report_request WHERE request_key = ?').get(requestKey) as Record<string, unknown> | undefined;
      return row ? toReport(row) : null;
    },
    getReport(reportId: string): ReportRecord | null {
      const row = db.prepare('SELECT * FROM report_request WHERE report_id = ?').get(reportId) as Record<string, unknown> | undefined;
      return row ? toReport(row) : null;
    },
    updateReport(reportId: string, patch: Partial<ReportRecord>): void {
      const sets: string[] = [];
      const values: unknown[] = [];
      for (const [field, column] of Object.entries(PATCH_COLUMNS)) {
        if (!(field in patch)) continue;
        sets.push(`${column} = ?`);
        const value = patch[field as keyof ReportRecord];
        values.push(field === 'dataScope'
          ? (value === null || value === undefined ? null : JSON.stringify(value))
          : (value === undefined ? null : value));
      }
      if (!sets.length) return;
      values.push(reportId);
      db.prepare(`UPDATE report_request SET ${sets.join(', ')} WHERE report_id = ?`).run(...(values as (string | number | null)[]));
    },
    /** created_at DESC (newest first), report_id ASC as tiebreak — mirrors
     * the P7 memory repository's ordering contract. */
    listReports(query: { limit?: number; requestKey?: string; state?: string } = {}): ReportRecord[] {
      const where: string[] = [];
      const values: (string | number)[] = [];
      if (query.requestKey) { where.push('request_key = ?'); values.push(query.requestKey); }
      if (query.state) { where.push('state = ?'); values.push(query.state); }
      const limit = Number.isSafeInteger(query.limit) && (query.limit as number) > 0 ? Math.min(query.limit as number, 1000) : 100;
      const sql = `SELECT * FROM report_request${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC, report_id ASC LIMIT ?`;
      values.push(limit);
      return (db.prepare(sql).all(...values) as Record<string, unknown>[]).map(toReport);
    },
    putReportFile(rec: ReportFileRecord): void {
      db.prepare(`INSERT OR REPLACE INTO report_file(
          file_id, report_id, name, media_type, size_bytes, digest, rel_path, created_at
        ) VALUES(?,?,?,?,?,?,?,?)`).run(
        rec.fileId, rec.reportId, rec.name, rec.mediaType,
        rec.sizeBytes, rec.digest, rec.relPath, rec.createdAt);
    },
    listReportFiles(reportId: string): ReportFileRecord[] {
      return (db.prepare('SELECT * FROM report_file WHERE report_id = ? ORDER BY created_at, name').all(reportId) as Record<string, unknown>[]).map(toFile);
    },
    getReportPreferences(ownerKey: string): ReportPreferencesRecord | null {
      const row = db.prepare('SELECT * FROM report_preferences WHERE owner_key = ?').get(ownerKey) as Record<string, unknown> | undefined;
      return row ? toPreferences(row) : null;
    },
    putReportPreferences(ownerKey: string, rec: ReportPreferencesRecord): void {
      db.prepare(`INSERT INTO report_preferences(
          owner_key, last_provider_ref, last_profile_ref, last_output_format, last_data_scope_json, updated_at
        ) VALUES(?,?,?,?,?,?)
        ON CONFLICT(owner_key) DO UPDATE SET
          last_provider_ref = excluded.last_provider_ref,
          last_profile_ref = excluded.last_profile_ref,
          last_output_format = excluded.last_output_format,
          last_data_scope_json = excluded.last_data_scope_json,
          updated_at = excluded.updated_at`).run(
        ownerKey, rec.lastProviderRef ?? null, rec.lastProfileRef ?? null,
        rec.lastOutputFormat ?? null,
        rec.lastDataScope === null || rec.lastDataScope === undefined ? null : JSON.stringify(rec.lastDataScope),
        rec.updatedAt);
    },
    /** enabled is persisted INTEGER; CHECK (enabled = 0) backs the "drafts
     * never schedule" guarantee — the service always writes enabled:false. */
    putSubscriptionDraft(draft: SubscriptionDraftRecord): void {
      db.prepare(`INSERT OR REPLACE INTO report_subscription_draft(
          draft_id, owner_key, source_ref, report_profile_ref, cadence, note, enabled, created_at, updated_at
        ) VALUES(?,?,?,?,?,?,?,?,?)`).run(
        draft.draftId, draft.ownerKey, draft.sourceRef,
        draft.reportProfileRef ?? null, draft.cadence, draft.note ?? null,
        draft.enabled ? 1 : 0, draft.createdAt, draft.updatedAt);
    },
    listSubscriptionDrafts(ownerKey: string): SubscriptionDraftRecord[] {
      return (db.prepare('SELECT * FROM report_subscription_draft WHERE owner_key = ? ORDER BY created_at DESC').all(ownerKey) as Record<string, unknown>[]).map(toDraft);
    },
  };
}

export type SqliteReportsRepository = ReturnType<typeof createSqliteReportsRepository>;
