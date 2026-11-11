// PAE P7 — router tests (source only; run after merge).
// Frozen route matching, {meta,data} envelope, {error:{...}} shape,
// idempotent create over the HTTP-shaped surface, requestKey recovery.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createReportsRouter, createMemoryReportsRepository,
  REPORT_STATE, REPORT_ERROR,
} from '../../server/management/reports/index.mjs';

const PREFIX = '/api/personal/v1';
let root, dataDir, outDir;
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'p7-router-'));
  dataDir = join(root, 'data');
  outDir = join(root, 'out');
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, 'orders.csv'), 'a,b\n1,x\n2,y\n', 'utf8');
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

function makeRouter(extra = {}) {
  return createReportsRouter({
    repository: extra.repository ?? createMemoryReportsRepository(),
    outputDir: outDir, dataDir, controlPlaneId: 'cp-test',
    ...extra,
  });
}

describe('createReportsRouter (frozen /api/personal/v1/reports*)', () => {
  it('returns undefined for non-reports paths so the mount falls through', async () => {
    const router = makeRouter();
    expect(await router.handle({ method: 'GET', pathname: '/api/v2/runs', searchParams: new URLSearchParams() })).toBeUndefined();
    expect(await router.handle({ method: 'GET', pathname: `${PREFIX}/projects`, searchParams: new URLSearchParams() })).toBeUndefined();
  });

  it('POST /reports returns the frozen envelope and creates a real report', async () => {
    const router = makeRouter();
    const res = await router.handle({
      method: 'POST', pathname: `${PREFIX}/reports`, searchParams: new URLSearchParams(),
      body: { requestKey: 'rk-1', sourceRef: 'data:orders.csv' },
    });
    expect(res.status).toBe(200);
    expect(res.body.meta.source).toBe('management/reports');
    expect(res.body.meta.controlPlaneId).toBe('cp-test');
    expect(res.body.meta.supportedActions).toContain('REPORT_PROVIDER:local');
    expect(res.body.data.state).toBe(REPORT_STATE.QUEUED);
    expect(res.body.data.requestKey).toBe('rk-1');
    await router.service.executor.idle();
    const got = await router.handle({ method: 'GET', pathname: `${PREFIX}/reports/${res.body.data.reportId}`, searchParams: new URLSearchParams() });
    expect(got.body.data.state).toBe(REPORT_STATE.READY);
    const files = await router.handle({ method: 'GET', pathname: `${PREFIX}/reports/${res.body.data.reportId}/files`, searchParams: new URLSearchParams() });
    expect(files.body.data.map((f) => f.name).sort()).toEqual(['report.json', 'report.md']);
  });

  it('GET /reports?requestKey= recovers the original request after restart', async () => {
    const repository = createMemoryReportsRepository();
    const router = makeRouter({ repository });
    const created = await router.handle({
      method: 'POST', pathname: `${PREFIX}/reports`, searchParams: new URLSearchParams(),
      body: { requestKey: 'rk-recover', sourceRef: 'data:orders.csv', outputFormat: 'json' },
    });
    await router.service.executor.idle();
    const list = await router.handle({
      method: 'GET', pathname: `${PREFIX}/reports`, searchParams: new URLSearchParams('requestKey=rk-recover'),
    });
    expect(list.body.data).toHaveLength(1);
    expect(list.body.data[0].reportId).toBe(created.body.data.reportId);
    // a fresh router over the same repository sees the same row (restart view)
    const router2 = makeRouter({ repository });
    const again = await router2.handle({
      method: 'GET', pathname: `${PREFIX}/reports`, searchParams: new URLSearchParams('requestKey=rk-recover'),
    });
    expect(again.body.data).toHaveLength(1);
  });

  it('errors use the frozen {error:{code,message,retryable,requestId}} shape', async () => {
    const router = makeRouter();
    const bad = await router.handle({
      method: 'POST', pathname: `${PREFIX}/reports`, searchParams: new URLSearchParams(),
      body: { requestKey: 'rk-bad', sourceRef: 'data:orders.csv', evil: 'field' },
    });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe(REPORT_ERROR.BAD_REQUEST);
    expect(typeof bad.body.error.requestId).toBe('string');
    const missing = await router.handle({ method: 'GET', pathname: `${PREFIX}/reports/rpt_none`, searchParams: new URLSearchParams() });
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe(REPORT_ERROR.NOT_FOUND);
  });

  it('same requestKey + different body → 409 IDEMPOTENCY_CONFLICT', async () => {
    const router = makeRouter();
    await router.handle({
      method: 'POST', pathname: `${PREFIX}/reports`, searchParams: new URLSearchParams(),
      body: { requestKey: 'rk-conflict', sourceRef: 'data:orders.csv' },
    });
    const res = await router.handle({
      method: 'POST', pathname: `${PREFIX}/reports`, searchParams: new URLSearchParams(),
      body: { requestKey: 'rk-conflict', sourceRef: 'data:orders.csv', outputFormat: 'json' },
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe(REPORT_ERROR.IDEMPOTENCY_CONFLICT);
  });

  it('invalid report ids are rejected by route matching before lookup', async () => {
    const router = makeRouter();
    const res = await router.handle({ method: 'GET', pathname: `${PREFIX}/reports/bad%20id`, searchParams: new URLSearchParams() });
    expect(res).toBeUndefined(); // not a reports route — mount falls through to its 404
  });
});
