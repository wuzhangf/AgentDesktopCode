// Fixture tests for metric semantics (§4): state rules, durations, costs.
import { describe, it, expect } from 'vitest';
import { classifyEntity, countCreatedCohort, completedOutcomeStats, nativeContradicts } from '../server/metrics/cohorts.mjs';
import { quantile, durationStats, durationHistogram, intervalUnionStats } from '../server/metrics/duration.mjs';
import { latestCostRevisions, sumCosts } from '../server/metrics/cost.mjs';
import { transportSuccess } from '../server/repositories/sqliteV1.mjs';

describe('classifyEntity', () => {
  it('marks trusted terminal entities COMPLETED', () => {
    const c = classifyEntity({ lifecycle: 'TERMINAL', outcome: 'SUCCEEDED', native_status: null, ended_at: 100 });
    expect(c.activityState).toBe('COMPLETED');
    expect(c.isTrustedTerminal).toBe(true);
    expect(c.qualityReasons).toEqual([]);
  });

  it('flags TERMINAL without outcome as a conflict', () => {
    const c = classifyEntity({ lifecycle: 'TERMINAL', outcome: null, native_status: null, ended_at: 100 });
    expect(c.activityState).toBe('STATE_CONFLICT');
    expect(c.isTrustedTerminal).toBe(false);
    expect(c.qualityReasons).toContain('TERMINAL_WITHOUT_OUTCOME');
  });

  it('flags open lifecycle carrying a terminal outcome', () => {
    const c = classifyEntity({ lifecycle: 'STARTED', outcome: 'SUCCEEDED', native_status: null, ended_at: null });
    expect(c.activityState).toBe('STATE_CONFLICT');
    expect(c.qualityReasons).toContain('OPEN_LIFECYCLE_WITH_TERMINAL_OUTCOME');
  });

  it('treats open entities as UNCLOSED, never fabricates activity', () => {
    const c = classifyEntity({ lifecycle: 'REGISTERED', outcome: null, native_status: null, ended_at: null });
    expect(c.activityState).toBe('UNCLOSED');
    expect(c.isTrustedTerminal).toBe(false);
  });

  it('flags unrecognized outcome enums without hiding the raw value', () => {
    const c = classifyEntity({ lifecycle: 'TERMINAL', outcome: 'WEIRD_NEW_STATE', native_status: null, ended_at: 5 });
    expect(c.qualityReasons).toContain('UNRECOGNIZED_ENUM');
    expect(c.knownOutcome).toBe(false);
  });

  it('requires ended_at for a trusted terminal', () => {
    const c = classifyEntity({ lifecycle: 'TERMINAL', outcome: 'SUCCEEDED', native_status: null, ended_at: null });
    expect(c.isTrustedTerminal).toBe(false);
  });
});

describe('cohort counters', () => {
  const rows = [
    { lifecycle: 'TERMINAL', outcome: 'SUCCEEDED', ended_at: 10 },
    { lifecycle: 'TERMINAL', outcome: 'FAILED', ended_at: 20 },
    { lifecycle: 'TERMINAL', outcome: 'TIMED_OUT', ended_at: 30 },
    { lifecycle: 'TERMINAL', outcome: 'CANCELLED', ended_at: 40 },
    { lifecycle: 'REGISTERED', outcome: null, ended_at: null },
    { lifecycle: 'OUTCOME_UNKNOWN', outcome: null, ended_at: null },
    { lifecycle: 'TERMINAL', outcome: null, ended_at: 50 },
  ];

  it('countCreatedCohort separates unclosed / outcome_unknown / conflict', () => {
    const c = countCreatedCohort(rows);
    expect(c.registered).toBe(7);
    expect(c.succeeded).toBe(1);
    expect(c.unclosed).toBe(1);
    expect(c.outcomeUnknown).toBe(2); // OUTCOME_UNKNOWN row + TERMINAL-without-outcome conflict row
    expect(c.conflict).toBe(1);
    expect(c.knownTerminal).toBe(4);
  });

  it('completedOutcomeStats excludes conflicts and non-terminal rows', () => {
    const s = completedOutcomeStats(rows);
    expect(s.succeeded).toBe(1);
    expect(s.failed).toBe(1);
    expect(s.timedOut).toBe(1);
    expect(s.cancelled).toBe(1);
    expect(s.excluded).toBe(3);
    expect(s.denominator).toBe(3);
    expect(s.successRate).toBeCloseTo(1 / 3);
  });

  it('returns null rates on empty denominator instead of zero', () => {
    const s = completedOutcomeStats([{ lifecycle: 'REGISTERED', outcome: null, ended_at: null }]);
    expect(s.denominator).toBe(0);
    expect(s.successRate).toBeNull();
    expect(s.failureRate).toBeNull();
  });
});

describe('nativeContradicts', () => {
  it('detects contradictory native status', () => {
    expect(nativeContradicts('SUCCEEDED', 'FAILED')).toBe(true);
    expect(nativeContradicts('FAILED', 'SUCCESS')).toBe(true);
    expect(nativeContradicts('SUCCEEDED', 'COMPLETED')).toBe(false);
    expect(nativeContradicts(null, 'FAILED')).toBe(false);
  });
});

describe('transport success', () => {
  it('treats the framework COMPLETED enum as a known successful transport', () => {
    expect(transportSuccess([
      { transport_outcome: 'COMPLETED' },
      { transport_outcome: 'FAILED' },
      { transport_outcome: null },
    ])).toEqual({ rate: 0.5, known: 2 });
  });
});

describe('duration metrics', () => {
  it('quantile uses nearest-rank and null for empty', () => {
    expect(quantile([], 0.5)).toBeNull();
    expect(quantile([10], 0.95)).toBe(10);
    expect(quantile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.5)).toBe(5);
    expect(quantile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.95)).toBe(10);
  });

  it('keeps exact duration_ms and wall-clock samples separate', () => {
    const rows = [
      { duration_ms: 100, started_at: 0, ended_at: 250 }, // exact 100 vs wall 250
      { duration_ms: null, started_at: 0, ended_at: 500 },
      { duration_ms: 300, started_at: null, ended_at: null },
    ];
    const d = durationStats(rows);
    expect(d.exact.sampleCount).toBe(2);
    expect(d.exact.p50).toBe(100);
    expect(d.exact.missingCount).toBe(1);
    expect(d.wallClock.sampleCount).toBe(2);
    expect(d.wallClock.p50).toBe(250);
    expect(d.wallClock.missingCount).toBe(1);
  });

  it('drops negative durations and inverted wall-clock intervals', () => {
    const d = durationStats([
      { duration_ms: -5, started_at: 100, ended_at: 50 },
      { duration_ms: 10, started_at: 0, ended_at: 10 },
    ]);
    expect(d.exact.sampleCount).toBe(1);
    expect(d.wallClock.sampleCount).toBe(1);
  });

  it('histogram counts missing values instead of bucketing them', () => {
    const h = durationHistogram([
      { duration_ms: 500 }, { duration_ms: 2_000 }, { duration_ms: 400_000 },
      { duration_ms: null, started_at: null, ended_at: null },
    ]);
    expect(h.used).toBe(3);
    expect(h.missing).toBe(1);
    expect(h.buckets.find((b) => b.key === 'lt1s').count).toBe(1);
    expect(h.buckets.find((b) => b.key === 'gt5m').count).toBe(1);
  });

  it('intervalUnionStats reports union and parallelism', () => {
    const s = intervalUnionStats([
      { start: 0, end: 100 }, { start: 50, end: 150 }, { start: 300, end: 400 },
      { start: 10, end: 5 }, // invalid: end <= start, dropped
    ]);
    expect(s.usedIntervals).toBe(3);
    expect(s.unionMs).toBe(250);
    expect(s.totalMs).toBe(300);
    expect(s.peakParallelism).toBe(2);
    expect(s.avgParallelism).toBeCloseTo(1.2);
  });
});

describe('cost metrics', () => {
  it('latestCostRevisions keeps only the newest revision per authority_key', () => {
    const rows = [
      { authority_key: 'k1', revision: 1, amount_decimal: '1.00' },
      { authority_key: 'k1', revision: 3, amount_decimal: '1.50' },
      { authority_key: 'k1', revision: 2, amount_decimal: '1.20' },
      { authority_key: 'k2', revision: 1, amount_decimal: '2.00' },
    ];
    const latest = latestCostRevisions(rows);
    expect(latest).toHaveLength(2);
    expect(latest.find((r) => r.authority_key === 'k1').amount_decimal).toBe('1.50');
  });

  it('sumCosts facets by source × currency and never mixes currencies', () => {
    const { facets } = sumCosts([
      { source: 'PROVIDER', currency: 'USD', amount_decimal: '0.10' },
      { source: 'PROVIDER', currency: 'USD', amount_decimal: '0.25' },
      { source: 'PROVIDER', currency: 'CNY', amount_decimal: '1.00' },
      { source: 'ESTIMATE', currency: 'USD', amount_decimal: '0.40' },
    ]);
    const usd = facets.find((f) => f.source === 'PROVIDER' && f.currency === 'USD');
    expect(usd.sum).toBe('0.35');
    expect(usd.count).toBe(2);
    expect(facets.find((f) => f.currency === 'CNY').sum).toBe('1');
    expect(facets.find((f) => f.source === 'ESTIMATE').sum).toBe('0.4');
  });

  it('counts unknown amounts without falling back or zero-filling', () => {
    const { facets } = sumCosts([
      { source: 'PROVIDER', currency: 'USD', amount_decimal: null },
      { source: 'PROVIDER', currency: 'USD', amount_decimal: 'UNKNOWN' },
      { source: 'PROVIDER', currency: 'USD', amount_decimal: '0.50' },
    ]);
    expect(facets[0].unknownCount).toBe(2);
    expect(facets[0].sum).toBe('0.5');
    expect(facets[0].count).toBe(3);
  });

  it('selects a preferred authority source when configured', () => {
    const { preferred } = sumCosts(
      [
        { source: 'PROVIDER', currency: 'USD', amount_decimal: '1' },
        { source: 'ESTIMATE', currency: 'USD', amount_decimal: '2' },
      ],
      { preferredSource: 'PROVIDER' },
    );
    expect(preferred).toHaveLength(1);
    expect(preferred[0].source).toBe('PROVIDER');
  });
});
