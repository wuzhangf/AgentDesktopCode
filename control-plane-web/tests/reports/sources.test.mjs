// PAE P7 — source adapter tests (source only; run after merge).
// data: adapter containment/bounds; analysis adapter via ReportSourceGateway
// seam; ServiceClient gateway shape.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createDataFileSource, createAnalysisSource, createServiceClientGateway,
  REPORT_ERROR,
} from '../../server/management/reports/index.mjs';

let root, dataDir;
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'p7-sources-'));
  dataDir = join(root, 'data');
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, 't.csv'), 'a,b\n1,x\n2,y\n', 'utf8');
  writeFileSync(join(dataDir, 't.json'), '[{"k":1},{"k":2}]', 'utf8');
  writeFileSync(join(root, 'outside.csv'), 'secret,1\n', 'utf8'); // outside the registered dir
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('data: source (registered CSV/JSON, bounded)', () => {
  it('reads a registered csv and returns digest + mtime watermark', async () => {
    const src = createDataFileSource({ dataDir });
    const res = await src.fetchFacts({ ref: 't.csv' });
    expect(res.scheme).toBe('data');
    expect(res.sourceDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(res.watermark).toBeTruthy();
    expect(res.facts.kind).toBe('csv');
    expect(res.facts.rowCount).toBe(2);
  });

  it('accepts an explicitly configured directory alias using its physical containment root',async()=>{
    const alias=join(root,'data-alias');symlinkSync(dataDir,alias,process.platform==='win32'?'junction':'dir');
    const physical=await createDataFileSource({dataDir}).fetchFacts({ref:'t.csv'});
    const aliased=await createDataFileSource({dataDir:alias}).fetchFacts({ref:'t.csv'});
    expect(aliased.sourceDigest).toBe(physical.sourceDigest);
    await expect(createDataFileSource({dataDir:alias}).fetchFacts({ref:'../outside.csv'})).rejects.toMatchObject({code:REPORT_ERROR.REPORT_SOURCE_UNKNOWN});
  });

  it('resolves extensionless names by probing .csv then .json', async () => {
    const src = createDataFileSource({ dataDir });
    const res = await src.fetchFacts({ ref: 't' });
    expect(res.facts.fileName).toBe('t.csv');
  });

  it('rejects traversal / ids outside the registered dir and missing names', async () => {
    const src = createDataFileSource({ dataDir });
    await expect(src.fetchFacts({ ref: '../outside.csv' }))
      .rejects.toMatchObject({ code: REPORT_ERROR.REPORT_SOURCE_UNKNOWN });
    await expect(src.fetchFacts({ ref: 'missing' }))
      .rejects.toMatchObject({ code: REPORT_ERROR.REPORT_SOURCE_UNKNOWN });
    await expect(src.fetchFacts({ ref: 'not an id!' }))
      .rejects.toMatchObject({ code: REPORT_ERROR.REPORT_SOURCE_UNKNOWN });
  });

  it('fails honestly when no data directory is configured', async () => {
    const src = createDataFileSource({ dataDir: null });
    await expect(src.fetchFacts({ ref: 't.csv' }))
      .rejects.toMatchObject({ code: REPORT_ERROR.REPORT_SOURCE_UNAVAILABLE, retryable: true });
  });

  it('enforces the byte cap', async () => {
    const src = createDataFileSource({ dataDir, limits: { maxInputBytes: 8 } });
    await expect(src.fetchFacts({ ref: 't.csv' }))
      .rejects.toMatchObject({ code: REPORT_ERROR.SOURCE_TOO_LARGE });
  });

  it('enforces the row cap and flags truncation', async () => {
    const src = createDataFileSource({ dataDir, limits: { maxRows: 3 } });
    const res = await src.fetchFacts({ ref: 't.csv' });
    expect(res.bounds.truncated).toBe(true);
  });
});

describe('analysis source (ReportSourceGateway seam)', () => {
  it('fails REPORT_SOURCE_UNAVAILABLE when the gateway is not wired', async () => {
    const src = createAnalysisSource({ gateway: null });
    await expect(src.fetchFacts({ scheme: 'project', ref: 'p1' }))
      .rejects.toMatchObject({ code: REPORT_ERROR.REPORT_SOURCE_UNAVAILABLE, retryable: true });
  });

  it('passes scheme/ref/limits to the gateway and digests returned facts', async () => {
    const seen = [];
    const gateway = {
      async fetchSourceFacts(q) {
        seen.push(q);
        return { facts: { kind: 'project', project: { projectId: q.ref } }, watermark: '2026-10-18T00:00:00Z' };
      },
    };
    const src = createAnalysisSource({ gateway });
    const res = await src.fetchFacts({ scheme: 'project', ref: 'p1', version: 'v2' });
    expect(seen[0]).toMatchObject({ scheme: 'project', ref: 'p1', version: 'v2' });
    expect(res.sourceDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(res.watermark).toBe('2026-10-18T00:00:00Z');
  });
});

describe('ServiceClient gateway adapter', () => {
  it('maps project refs to real public read calls', async () => {
    const calls = [];
    const client = {
      getProject: async (id) => { calls.push(['getProject', id]); return { projectId: id, updatedAt: '2026-10-17T10:00:00Z' }; },
      listProjectDeliveries: async (id, q) => { calls.push(['listProjectDeliveries', id]); return { items: [{ deliveryId: 'd1', state: 'APPLIED', updatedAt: '2026-10-18T09:00:00Z' }] }; },
      listRuns: async (q) => { calls.push(['listRuns', q.projectId]); return { items: [{ runId: 'r1', state: 'READY', endedAt: '2026-10-18T08:00:00Z' }] }; },
    };
    const gw = createServiceClientGateway(client);
    const res = await gw.fetchSourceFacts({ scheme: 'project', ref: 'proj-1', limits: {} });
    expect(calls.map((c) => c[0])).toEqual(['getProject', 'listProjectDeliveries', 'listRuns']);
    expect(res.facts.project.projectId).toBe('proj-1');
    expect(res.facts.deliveries.states.APPLIED).toBe(1);
    expect(res.watermark).toBe('2026-10-18T09:00:00Z'); // latest observed
  });

  it('tolerates absent optional endpoints (runs/deliveries empty)', async () => {
    const client = {
      getProject: async (id) => ({ projectId: id }),
      listProjectDeliveries: async () => { throw new Error('not supported'); },
      listRuns: async () => { throw new Error('not supported'); },
    };
    const gw = createServiceClientGateway(client);
    const res = await gw.fetchSourceFacts({ scheme: 'project', ref: 'p' });
    expect(res.facts.deliveries.count).toBe(0);
    expect(res.facts.runs.count).toBe(0);
  });
});
