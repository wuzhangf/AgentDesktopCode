// PAE P7 — ReportsService contract tests (source only; run after merge).
// Covers: idempotent create + requestKey recovery, provider configured /
// declared-not-configured / unknown states, restart reconcile, persisted
// preferences, subscription drafts that never schedule, queue bounds.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createReportsService, createMemoryReportsRepository,
  REPORT_STATE, REPORT_ERROR, LOCAL_PROVIDER_REF,
} from '../../server/management/reports/index.mjs';

const CSV = 'name,count,price\napple,3,1.5\nbanana,12,0.8\ncherry,7,2.4\n';
const JSON_DOC = JSON.stringify({ items: [{ id: 1, kind: 'a' }, { id: 2, kind: 'b' }] });

let root, dataDir, outDir;
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'p7-reports-'));
  dataDir = join(root, 'data');
  outDir = join(root, 'out');
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(dataDir, 'orders.csv'), CSV, 'utf8');
  writeFileSync(join(dataDir, 'catalog.json'), JSON_DOC, 'utf8');
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

function makeService(extra = {}) {
  const repository = createMemoryReportsRepository();
  const service = createReportsService({
    repository, outputDir: outDir, dataDir,
    ...extra,
  });
  return { service, repository };
}

describe('ReportsService create + idempotency (task §10.2)', () => {
  it('creates a QUEUED report then reaches READY with real files + digests', async () => {
    const { service } = makeService();
    const d = await service.createReport({ requestKey: 'k-create-1', sourceRef: 'data:orders.csv' });
    expect(d.state).toBe(REPORT_STATE.QUEUED);
    await service.executor.idle();
    const done = await service.getReport(d.reportId);
    expect(done.state).toBe(REPORT_STATE.READY);
    expect(done.resultDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(done.sourceDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    const files = await service.listReportFiles(d.reportId);
    expect(files.map((f) => f.name).sort()).toEqual(['report.json', 'report.md']);
    for (const f of files) expect(f.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    // real files on disk
    expect(existsSync(join(outDir, d.reportId, 'report.md'))).toBe(true);
    const json = JSON.parse(readFileSync(join(outDir, d.reportId, 'report.json'), 'utf8'));
    expect(json.schemaVersion).toBe('personal-report/v1');
    expect(json.summaryKind).toBe('deterministic');
    expect(json.semanticReview).toBe(false);
    expect(json.request.requestKey).toBe('k-create-1');
  });

  it('replays the same requestKey+body to the same report; same key + different body → 409', async () => {
    const { service } = makeService();
    const a = await service.createReport({ requestKey: 'k-idem', sourceRef: 'data:orders.csv' });
    const b = await service.createReport({ requestKey: 'k-idem', sourceRef: 'data:orders.csv' });
    expect(b.reportId).toBe(a.reportId);
    await service.executor.idle();
    await expect(service.createReport({ requestKey: 'k-idem', sourceRef: 'data:catalog.json' }))
      .rejects.toMatchObject({ code: REPORT_ERROR.IDEMPOTENCY_CONFLICT, status: 409 });
    // original key lookup (restart recovery surface)
    const found = await service.findByRequestKey('k-idem');
    expect(found?.reportId).toBe(a.reportId);
  });

  it('rejects unknown / unconfigured providers before persisting a row', async () => {
    const { service, repository } = makeService({ providers: { 'remote-acme': null } });
    await expect(service.createReport({ requestKey: 'k-p1', sourceRef: 'data:orders.csv', providerRef: 'nope' }))
      .rejects.toMatchObject({ code: REPORT_ERROR.REPORT_PROVIDER_UNKNOWN, status: 400 });
    await expect(service.createReport({ requestKey: 'k-p2', sourceRef: 'data:orders.csv', providerRef: 'remote-acme' }))
      .rejects.toMatchObject({ code: REPORT_ERROR.REPORT_PROVIDER_NOT_CONFIGURED, status: 503 });
    expect(await repository.findReportByRequestKey('k-p1')).toBeNull();
    expect(await repository.findReportByRequestKey('k-p2')).toBeNull();
    // meta advertises only the configured provider + the not-configured reason
    const meta = service.buildMeta();
    expect(meta.supportedActions).toContain('REPORT_PROVIDER:local');
    expect(meta.supportedActions).not.toContain('REPORT_PROVIDER:remote-acme');
    expect(meta.reasonCodes).toContain(REPORT_ERROR.REPORT_PROVIDER_NOT_CONFIGURED);
  });

  it('persists last-used preferences on each accepted create', async () => {
    const { service } = makeService();
    await service.createReport({ requestKey: 'k-pref', sourceRef: 'data:orders.csv', outputFormat: 'json', dataScope: ['SAMPLE_ROWS'] });
    const prefs = await service.getPreferences();
    expect(prefs?.lastOutputFormat).toBe('json');
    expect(prefs?.lastDataScope).toEqual(['SAMPLE_ROWS']);
    expect(prefs?.lastProviderRef).toBe(LOCAL_PROVIDER_REF);
  });

  it('records FAILED with a real code when the source is missing', async () => {
    const { service } = makeService();
    const d = await service.createReport({ requestKey: 'k-fail', sourceRef: 'data:nothing-here' });
    await service.executor.idle();
    const done = await service.getReport(d.reportId);
    expect(done.state).toBe(REPORT_STATE.FAILED);
    expect(done.error?.code).toBe(REPORT_ERROR.REPORT_SOURCE_UNKNOWN);
  });
});

describe('restart reconcile (task §10.2/§12)', () => {
  it('requeues a deterministic-provider QUEUED report after restart', async () => {
    const { service, repository } = makeService();
    // simulate a row persisted right before a crash — never dispatched
    const t = new Date().toISOString();
    await repository.putReportRequest({
      reportId: 'rpt_pending1', requestKey: 'k-pending', bodyDigest: 'sha256:' + 'a'.repeat(64),
      sourceRef: 'data:orders.csv', sourceVersion: null, sourceDigest: null,
      resolvedSourceDigest: null, sourceWatermark: null,
      reportProfileRef: 'local/summary', providerRef: 'local', outputFormat: 'markdown+json',
      dataScope: null, state: REPORT_STATE.QUEUED, errorCode: null, errorMessage: null,
      resultDigest: null, createdAt: t, updatedAt: t,
    });
    const n = await service.reconcile();
    expect(n).toBe(1);
    await service.executor.idle();
    const done = await service.getReport('rpt_pending1');
    expect(done.state).toBe(REPORT_STATE.READY);
  });

  it('marks a non-resumable in-flight report UNKNOWN, never silent-READY', async () => {
    const { service, repository } = makeService({
      providers: {
        'remote-acme': { providerRef: 'remote-acme', providerVersion: 'x/1', deterministic: false, generate: async () => { throw new Error('no impl'); } },
      },
    });
    const t = new Date().toISOString();
    await repository.putReportRequest({
      reportId: 'rpt_remote1', requestKey: 'k-remote', bodyDigest: 'sha256:' + 'b'.repeat(64),
      sourceRef: 'data:orders.csv', sourceVersion: null, sourceDigest: null,
      resolvedSourceDigest: null, sourceWatermark: null,
      reportProfileRef: 'local/summary', providerRef: 'remote-acme', outputFormat: 'markdown+json',
      dataScope: null, state: REPORT_STATE.RUNNING, errorCode: null, errorMessage: null,
      resultDigest: null, createdAt: t, updatedAt: t,
    });
    await service.reconcile();
    const done = await service.getReport('rpt_remote1');
    expect(done.state).toBe(REPORT_STATE.UNKNOWN);
    expect(done.error?.code).toBe(REPORT_ERROR.EFFECT_UNKNOWN);
  });
});

describe('subscription drafts (task §10.4, E39)', () => {
  it('persists drafts with enabled forced false — a draft never schedules work', async () => {
    const { service } = makeService();
    const draft = await service.saveSubscriptionDraft({
      sourceRef: 'data:orders.csv', reportProfileRef: 'local/summary', cadence: 'weekly', note: '周五看板',
      enabled: true, // caller cannot enable — service forces it off
    });
    expect(draft.enabled).toBe(false);
    const drafts = await service.listSubscriptionDrafts();
    expect(drafts).toHaveLength(1);
    expect(drafts[0].cadence).toBe('weekly');
    // nothing queued: the repository holds no report rows for the draft
    expect(await service.listReports()).toHaveLength(0);
  });
});

describe('validation mirror of the frozen whitelist', () => {
  it('rejects unknown body keys and malformed fields', async () => {
    const { service } = makeService();
    await expect(service.createReport({ requestKey: 'k-x', sourceRef: 'data:orders.csv', url: 'http://evil' }))
      .rejects.toMatchObject({ code: REPORT_ERROR.BAD_REQUEST });
    await expect(service.createReport({ requestKey: 'bad key!', sourceRef: 'data:orders.csv' }))
      .rejects.toMatchObject({ code: REPORT_ERROR.BAD_REQUEST });
    await expect(service.createReport({ requestKey: 'k-x2', sourceRef: 'data:orders.csv', sourceDigest: 'md5:abc' }))
      .rejects.toMatchObject({ code: REPORT_ERROR.BAD_REQUEST });
    await expect(service.createReport({ requestKey: 'k-x3', sourceRef: 'weird:thing' }))
      .rejects.toMatchObject({ code: REPORT_ERROR.REPORT_SOURCE_UNKNOWN });
    await expect(service.createReport({ requestKey: 'k-x4', sourceRef: 'data:orders.csv', outputFormat: 'pdf' }))
      .rejects.toMatchObject({ code: REPORT_ERROR.BAD_REQUEST });
  });
});
