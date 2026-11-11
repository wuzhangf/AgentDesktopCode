// PAE P7 — LocalReportProvider tests (source only; run after merge).
// Covers: deterministic md+json output, atomic real files, digest pinning,
// bounded reads, dataScope enforcement (SUMMARY_ONLY vs SAMPLE_ROWS /
// INCLUDE_SCHEMA), declared-pin mismatch warning.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import {
  createLocalReportProvider, createDataFileSource, createReportOutputStore,
  REPORT_ERROR,
} from '../../server/management/reports/index.mjs';

const CSV = 'name,count,price\napple,3,1.5\nbanana,12,0.8\ncherry,7,2.4\n';

let root, dataDir, outDir;
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'p7-provider-'));
  dataDir = join(root, 'data');
  outDir = join(root, 'out');
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, 'orders.csv'), CSV, 'utf8');
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

function makeProvider(extra = {}) {
  const store = createReportOutputStore({ outputDir: outDir });
  return createLocalReportProvider({
    sources: { data: createDataFileSource({ dataDir }) },
    store,
    now: () => Date.parse('2026-10-18T12:00:00Z'),
    ...extra,
  });
}
function rec(over = {}) {
  return {
    reportId: 'rpt_t1', requestKey: 'k-t1', sourceRef: 'data:orders.csv',
    sourceVersion: null, sourceDigest: null, reportProfileRef: 'local/summary',
    providerRef: 'local', outputFormat: 'markdown+json', dataScope: null, ...over,
  };
}

describe('LocalReportProvider (real generation, task §10.2)', () => {
  it('writes report.md + report.json atomically with real digests', async () => {
    const provider = makeProvider();
    const result = await provider.generate({ report: rec() });
    expect(result.files.map((f) => f.name).sort()).toEqual(['report.json', 'report.md']);
    const mdPath = join(outDir, 'rpt_t1', 'report.md');
    const jsonPath = join(outDir, 'rpt_t1', 'report.json');
    expect(existsSync(mdPath)).toBe(true);
    expect(existsSync(jsonPath)).toBe(true);
    for (const f of result.files) {
      const bytes = readFileSync(join(outDir, 'rpt_t1', f.name));
      expect(`sha256:${createHash('sha256').update(bytes).digest('hex')}`).toBe(f.digest);
    }
    expect(result.resultDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(result.resolvedSourceDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(result.sourceWatermark).toBeTruthy(); // file mtime as watermark
  });

  it('markdown labels the summary deterministic and carries provenance', async () => {
    const provider = makeProvider();
    // Row-level content needs the declared scopes: SUMMARY_ONLY strips
    // topValues/sampleRows, and numeric columns never carry topValues.
    await provider.generate({ report: rec({ dataScope: ['INCLUDE_SCHEMA', 'SAMPLE_ROWS'] }) });
    const md = readFileSync(join(outDir, 'rpt_t1', 'report.md'), 'utf8');
    expect(md).toContain('确定性汇总（非模型语义审查）');
    expect(md).toContain('k-t1');           // original requestKey recorded
    expect(md).toContain('data:orders.csv');
    expect(md).toContain('apple');          // real source content summarized
    expect(md).toContain('1.5');
  });

  it('json output is schemaVersioned, marked non-semantic, and stats are real', async () => {
    const provider = makeProvider();
    await provider.generate({ report: rec({ dataScope: ['INCLUDE_SCHEMA', 'SAMPLE_ROWS'] }) });
    const json = JSON.parse(readFileSync(join(outDir, 'rpt_t1', 'report.json'), 'utf8'));
    expect(json.schemaVersion).toBe('personal-report/v1');
    expect(json.summaryKind).toBe('deterministic');
    expect(json.semanticReview).toBe(false);
    expect(json.summary.kind).toBe('csv');
    expect(json.summary.rowCount).toBe(3);
    const price = json.summary.columns.find((c) => c.name === 'price');
    expect(price.numeric.mean).toBeCloseTo(1.5667, 3);
    expect(json.summary.sampleRows.length).toBe(3);
  });

  it('SUMMARY_ONLY (no SAMPLE_ROWS token) strips record-level data from outputs', async () => {
    const provider = makeProvider();
    await provider.generate({ report: rec({ reportId: 'rpt_t2' }) });
    const json = JSON.parse(readFileSync(join(outDir, 'rpt_t2', 'report.json'), 'utf8'));
    expect(json.summary.sampleRows).toBeUndefined();
    const md = readFileSync(join(outDir, 'rpt_t2', 'report.md'), 'utf8');
    expect(md).not.toContain('样例行');
  });

  it('a declared sourceDigest mismatch produces a warning, not silent trust', async () => {
    const provider = makeProvider();
    const result = await provider.generate({
      report: rec({ reportId: 'rpt_t3', sourceDigest: 'sha256:' + '0'.repeat(64) }),
    });
    expect(result.summaryMeta.warnings.some((w) => w.includes('sourceDigest'))).toBe(true);
  });

  it('rejects unknown profile refs instead of substituting', async () => {
    const provider = makeProvider();
    await expect(provider.generate({ report: rec({ reportProfileRef: 'fancy/semantic' }) }))
      .rejects.toMatchObject({ code: REPORT_ERROR.BAD_REQUEST });
  });

  it('outputFormat json writes only report.json', async () => {
    const provider = makeProvider();
    const result = await provider.generate({ report: rec({ reportId: 'rpt_t4', outputFormat: 'json' }) });
    expect(result.files.map((f) => f.name)).toEqual(['report.json']);
    expect(existsSync(join(outDir, 'rpt_t4', 'report.md'))).toBe(false);
  });
});
