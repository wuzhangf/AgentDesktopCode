// PAE P8 — sqlite ReportsRepository adapter tests (source only; run after merge).
// Covers the two seams closed by reports-sqlite.ts:
//   1. REPORTS_MIGRATIONS applies ddl.sql in the p7-reports namespace at v100
//      through the shared runMigrations ledger (idempotent, drift-visible).
//   2. createSqliteReportsRepository satisfies the P7 ReportsRepository
//      contract (ports.mjs) over the same DatabaseSync — same ordering and
//      idempotency semantics as the memory repository.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { REPORTS_MIGRATIONS, createSqliteReportsRepository } from '../../server/management/reports-sqlite';
import { runMigrations } from '../../server/management/migrations';

let db: DatabaseSync;
let repo: ReturnType<typeof createSqliteReportsRepository>;

const T0 = '2026-10-18T00:00:00.000Z';
const T1 = '2026-10-18T00:00:01.000Z';
const T2 = '2026-10-18T00:00:02.000Z';

function rec(over: Record<string, unknown> = {}) {
  return {
    reportId: 'rpt_a', requestKey: 'rk-a', bodyDigest: 'sha256:' + 'a'.repeat(64),
    sourceRef: 'data:orders.csv', sourceVersion: null, sourceDigest: null,
    resolvedSourceDigest: null, sourceWatermark: null,
    reportProfileRef: 'local/summary', providerRef: 'local',
    outputFormat: 'markdown+json', dataScope: ['SAMPLE_ROWS'],
    state: 'QUEUED', errorCode: null, errorMessage: null, resultDigest: null,
    createdAt: T0, updatedAt: T0, ...over,
  };
}

beforeEach(() => {
  db = new DatabaseSync(':memory:');
  runMigrations(db, [], REPORTS_MIGRATIONS);
  repo = createSqliteReportsRepository(db);
});
afterEach(() => db.close());

describe('REPORTS_MIGRATIONS (p7-reports @ v100, task §8/§10.1)', () => {
  it('applies ddl.sql once in the p7-reports namespace and records the ledger row', () => {
    const applied = db.prepare('SELECT version, namespace, name FROM management_schema_migrations').all() as any[];
    expect(applied).toEqual([{ version: 100, namespace: 'p7-reports', name: 'reports_tables' }]);
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as any[]).map((r) => r.name);
    for (const t of ['report_request', 'report_file', 'report_preferences', 'report_subscription_draft']) {
      expect(tables).toContain(t);
    }
    // Re-run is a no-op (applied rows never re-run), no drift on unchanged source.
    expect(runMigrations(db, [], REPORTS_MIGRATIONS).applied).toEqual([]);
  });
});

describe('createSqliteReportsRepository — ReportsRepository contract', () => {
  it('persists a request then finds it by id and requestKey (idempotency handle)', () => {
    repo.putReportRequest(rec());
    expect(repo.getReport('rpt_a')?.requestKey).toBe('rk-a');
    expect(repo.findReportByRequestKey('rk-a')?.reportId).toBe('rpt_a');
    expect(repo.getReport('rpt_missing')).toBeNull();
    expect(repo.findReportByRequestKey('rk-missing')).toBeNull();
  });

  it('request_key UNIQUE is the last-line idempotency guard', () => {
    repo.putReportRequest(rec());
    expect(() => repo.putReportRequest(rec({ reportId: 'rpt_b' }))).toThrow();
  });

  it('dataScope round-trips as a JSON array column', () => {
    repo.putReportRequest(rec());
    expect(repo.getReport('rpt_a')?.dataScope).toEqual(['SAMPLE_ROWS']);
    repo.putReportRequest(rec({ reportId: 'rpt_b', requestKey: 'rk-b', dataScope: null }));
    expect(repo.getReport('rpt_b')?.dataScope).toBeNull();
  });

  it('updateReport writes only patched columns and can clear error fields to NULL', () => {
    repo.putReportRequest(rec({ state: 'RUNNING', errorCode: 'X', errorMessage: 'm' }));
    repo.updateReport('rpt_a', {
      state: 'READY', resultDigest: 'sha256:' + 'b'.repeat(64),
      errorCode: null, errorMessage: null, updatedAt: T1,
    });
    const r = repo.getReport('rpt_a')!;
    expect(r.state).toBe('READY');
    expect(r.resultDigest).toBe('sha256:' + 'b'.repeat(64));
    expect(r.errorCode).toBeNull();
    expect(r.updatedAt).toBe(T1);
    expect(r.sourceRef).toBe('data:orders.csv'); // untouched columns survive
  });

  it('listReports orders createdAt DESC, reportId ASC and honours filters/limit', () => {
    repo.putReportRequest(rec({ reportId: 'rpt_a', requestKey: 'rk-a', createdAt: T0 }));
    repo.putReportRequest(rec({ reportId: 'rpt_b', requestKey: 'rk-b', createdAt: T1, state: 'READY' }));
    repo.putReportRequest(rec({ reportId: 'rpt_c', requestKey: 'rk-c', createdAt: T1, state: 'READY' }));
    expect(repo.listReports().map((r) => r.reportId)).toEqual(['rpt_b', 'rpt_c', 'rpt_a']);
    expect(repo.listReports({ state: 'QUEUED' }).map((r) => r.reportId)).toEqual(['rpt_a']);
    expect(repo.listReports({ requestKey: 'rk-c' }).map((r) => r.reportId)).toEqual(['rpt_c']);
    expect(repo.listReports({ limit: 2 })).toHaveLength(2);
  });

  it('report_file rows are insert-or-replace by fileId and list per report', () => {
    repo.putReportRequest(rec());
    const file = { fileId: 'f_1', reportId: 'rpt_a', name: 'report.md', mediaType: 'text/markdown', sizeBytes: 4, digest: 'sha256:' + 'c'.repeat(64), relPath: 'rpt_a/report.md', createdAt: T0 };
    repo.putReportFile(file);
    repo.putReportFile({ ...file, sizeBytes: 9 });
    const files = repo.listReportFiles('rpt_a');
    expect(files).toHaveLength(1);
    expect(files[0].sizeBytes).toBe(9);
    expect(repo.listReportFiles('rpt_none')).toEqual([]);
  });

  it('preferences upsert per owner_key; drafts persist enabled=0 (CHECK-guarded)', () => {
    repo.putReportPreferences('default', { ownerKey: 'default', lastProviderRef: 'local', lastProfileRef: null, lastOutputFormat: 'markdown', lastDataScope: null, updatedAt: T0 });
    repo.putReportPreferences('default', { ownerKey: 'default', lastProviderRef: 'ext', lastProfileRef: 'p', lastOutputFormat: 'json', lastDataScope: ['INCLUDE_SCHEMA'], updatedAt: T1 });
    const prefs = repo.getReportPreferences('default')!;
    expect(prefs.lastProviderRef).toBe('ext');
    expect(prefs.lastDataScope).toEqual(['INCLUDE_SCHEMA']);
    repo.putSubscriptionDraft({ draftId: 'rsub_1', ownerKey: 'default', sourceRef: 'data:orders.csv', reportProfileRef: null, cadence: 'daily', note: null, enabled: false, createdAt: T0, updatedAt: T0 });
    expect(repo.listSubscriptionDrafts('default')).toHaveLength(1);
    // CHECK (enabled = 0): the schema refuses an enabled draft outright.
    expect(() => repo.putSubscriptionDraft({ draftId: 'rsub_2', ownerKey: 'default', sourceRef: 'data:x.csv', reportProfileRef: null, cadence: 'once', note: null, enabled: true, createdAt: T2, updatedAt: T2 })).toThrow();
  });
});
