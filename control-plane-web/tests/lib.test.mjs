// Fixture tests for request validation, cursors, buckets, CSV (§11).
import { describe, it, expect } from 'vitest';
import { encodeCursor, decodeCursor, filterHash } from '../server/lib/cursor.mjs';
import { bucketBoundaries, bucketIndex, wallParts } from '../server/lib/buckets.mjs';
import {
  parseEpochMs, parseTimezone, parseGrain, effectiveGrain, parseLimit,
  parseBool, parseWindowParams, parseId, parseSort, MAX_ANALYTICS_RANGE_MS,
} from '../server/lib/validate.mjs';
import { csvCell, toCsv } from '../server/lib/csv.mjs';

const DAY = 86_400_000;

describe('validation', () => {
  it('accepts valid epoch ms and rejects garbage', () => {
    expect(parseEpochMs('1789813406979', 'from')).toBe(1789813406979);
    expect(parseEpochMs(null, 'from')).toBeNull();
    expect(() => parseEpochMs('abc', 'from')).toThrow();
    expect(() => parseEpochMs('-5', 'from')).toThrow();
    expect(() => parseEpochMs('1.5', 'from')).toThrow();
  });

  it('rejects invalid IANA timezones', () => {
    expect(parseTimezone('UTC')).toBe('UTC');
    expect(parseTimezone(undefined)).toBe('Asia/Shanghai');
    expect(() => parseTimezone('Mars/Olympus')).toThrow();
  });

  it('rejects invalid ids, grains, limits, booleans', () => {
    expect(parseId('run:abc-123')).toBe('run:abc-123');
    expect(() => parseId('bad id!')).toThrow();
    expect(() => parseGrain('fortnight')).toThrow();
    expect(parseGrain('1h')).toBe('1h');
    expect(parseLimit('20')).toBe(20);
    expect(() => parseLimit('0')).toThrow();
    expect(() => parseLimit('9999')).toThrow();
    expect(parseBool('true')).toBe(true);
    expect(parseBool('0')).toBe(false);
    expect(() => parseBool('maybe')).toThrow();
  });

  it('effectiveGrain elevates so buckets stay under the cap', () => {
    const from = 0;
    expect(effectiveGrain(from, from + 3_600_000, '1m')).toBe('1m');
    expect(effectiveGrain(from, from + 30 * DAY, '1m')).toBe('1d');
    expect(effectiveGrain(from, from + DAY, null)).toBe('1h');
  });

  it('parseWindowParams caps windows at 90 days and rejects unknown filters', () => {
    const now = Date.now();
    const ok = parseWindowParams(new URLSearchParams(`from=${now - DAY}&to=${now}`));
    expect(ok.from).toBe(now - DAY);
    expect(ok.timezone).toBe('Asia/Shanghai');
    expect(() => parseWindowParams(new URLSearchParams(`from=0&to=${now}`))).toThrow(/90 days/);
    expect(() => parseWindowParams(new URLSearchParams(`from=${now}&to=${now - DAY}`))).toThrow();
    expect(() => parseWindowParams(new URLSearchParams('bogus=1'))).toThrow(/unsupported filter/);
    const w = parseWindowParams(
      new URLSearchParams(`from=${now - DAY}&to=${now}&runKind=CHAT`),
      { supported: ['runKind'] },
    );
    expect(w.filters.runKind).toBe('CHAT');
  });

  it('parseSort whitelists fields and validates direction', () => {
    const s = parseSort('startedAt', 'asc', ['startedAt', 'endedAt'], { field: 'startedAt' });
    expect(s).toEqual({ field: 'startedAt', direction: 'ASC' });
    expect(() => parseSort('password', 'asc', ['startedAt'], { field: 'startedAt' })).toThrow();
    expect(() => parseSort('startedAt', 'sideways', ['startedAt'], { field: 'startedAt' })).toThrow();
  });
});

describe('pagination cursors', () => {
  const base = { sourceEpoch: 'ep1', scopeId: 'local', filterHash: filterHash({ a: 1 }) };

  it('round-trips sort values and entity id', () => {
    const cur = encodeCursor({ ...base, sortValues: [123, 'x'], entityId: 'run-1' });
    expect(decodeCursor(cur, base)).toEqual({ sortValues: [123, 'x'], entityId: 'run-1' });
  });

  it('rejects cursors from a different source epoch (409)', () => {
    const cur = encodeCursor({ ...base, sortValues: [1], entityId: 'r' });
    try {
      decodeCursor(cur, { ...base, sourceEpoch: 'ep2' });
      expect.unreachable();
    } catch (e) {
      expect(e.status ?? e.statusCode).toBe(409);
    }
  });

  it('rejects cursors whose filters changed (400)', () => {
    const cur = encodeCursor({ ...base, sortValues: [1], entityId: 'r' });
    expect(() => decodeCursor(cur, { ...base, filterHash: 'other' })).toThrow();
    expect(() => decodeCursor('!!!not-base64!!!', base)).toThrow();
  });
});

describe('bucket boundaries', () => {
  it('produces UTC-aligned hour buckets', () => {
    const from = Date.UTC(2026, 0, 10, 3, 30);
    const to = Date.UTC(2026, 0, 10, 6, 30);
    const b = bucketBoundaries(from, to, '1h', 'UTC');
    expect(b[0]).toBe(Date.UTC(2026, 0, 10, 3));
    expect(b.length).toBe(5); // 4 buckets (03,04,05,06) + closing edge 07
    expect(b[b.length - 1]).toBe(Date.UTC(2026, 0, 10, 7));
    expect(b.every((t) => t % 3_600_000 === 0)).toBe(true);
  });

  it('aligns day buckets to the local timezone, not UTC', () => {
    // In Asia/Shanghai (UTC+8) a UTC midnight is 08:00 local — not a day start.
    const from = Date.UTC(2026, 0, 9, 12); // 20:00 local Jan 9
    const to = Date.UTC(2026, 0, 12, 12);
    const b = bucketBoundaries(from, to, '1d', 'Asia/Shanghai');
    expect(b[0]).toBe(Date.UTC(2026, 0, 8, 16)); // Shanghai midnight Jan 9 = Jan 8 16:00 UTC
    expect(b[b.length - 1]).toBeGreaterThan(to);
    // Consecutive Shanghai midnights are exactly 24h apart (no DST).
    for (let i = 1; i < b.length; i++) expect(b[i] - b[i - 1]).toBe(DAY);
    expect(b[b.length - 1]).toBeGreaterThan(to - DAY);
  });

  it('bucketIndex assigns instants and rejects out-of-range', () => {
    const from = Date.UTC(2026, 0, 10, 0, 30);
    const to = Date.UTC(2026, 0, 10, 3, 30);
    const b = bucketBoundaries(from, to, '1h', 'UTC');
    expect(bucketIndex(Date.UTC(2026, 0, 10, 0, 45), b)).toBe(0);
    expect(bucketIndex(Date.UTC(2026, 0, 10, 2, 59), b)).toBe(2);
    expect(bucketIndex(Date.UTC(2026, 0, 10, 3, 0), b)).toBe(3); // final partial bucket
    expect(bucketIndex(Date.UTC(2026, 0, 9, 0), b)).toBe(-1);
  });

  it('wallParts reports local wall-clock fields', () => {
    const w = wallParts(Date.UTC(2026, 0, 10, 16), 'Asia/Shanghai');
    expect(w.hour).toBe(0);
    expect(w.day).toBe(11);
  });
});

describe('csv export', () => {
  it('escapes quotes, commas, newlines and nulls', () => {
    expect(csvCell('plain')).toBe('plain');
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('l1\nl2')).toBe('"l1\nl2"');
    expect(csvCell(null)).toBe('');
    expect(csvCell(0)).toBe('0');
  });

  it('toCsv emits header + rows with meta comment lines', () => {
    const csv = toCsv({
      meta: { sourceId: 'demo', scopeId: 'local', timezone: 'UTC', from: 1, to: 2, metricVersion: '1.0', snapshotId: 's', mode: 'DEMO' },
      columns: ['id', 'ms'],
      rows: [{ id: 'r1', ms: 5 }, { id: 'r,2', ms: null }],
    });
    const lines = csv.split('\r\n').filter((l) => l && !l.startsWith('#'));
    expect(csv).toContain('DEMO DATA');
    expect(lines[0]).toBe('id,ms');
    expect(lines[1]).toBe('r1,5');
    expect(lines[2]).toBe('"r,2",');
  });
});
