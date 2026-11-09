// Duration & quantile semantics (§4.6): exact durations and derived wall-clock
// spans stay separate; nearest-rank percentiles; small samples flagged.

/** Nearest-rank quantile: sorted[ceil(p*n)-1]. n=0 → null. */
export function quantile(sortedAsc, p) {
  const n = sortedAsc.length;
  if (n === 0) return null;
  const idx = Math.min(n, Math.max(1, Math.ceil(p * n))) - 1;
  return sortedAsc[idx];
}

/**
 * Duration stats for entity rows. Exact = non-null duration_ms; wall-clock =
 * ended_at-started_at when both known. The two samples never mix.
 */
export function durationStats(rows) {
  const exact = [];
  const wall = [];
  let durationMissing = 0;
  let wallMissing = 0;
  for (const r of rows) {
    if (r.duration_ms != null && r.duration_ms >= 0) exact.push(r.duration_ms);
    else durationMissing += 1;
    if (r.started_at != null && r.ended_at != null && r.ended_at >= r.started_at) {
      wall.push(r.ended_at - r.started_at);
    } else wallMissing += 1;
  }
  exact.sort((a, b) => a - b);
  wall.sort((a, b) => a - b);
  const summarize = (arr, missing) => ({
    sampleCount: arr.length,
    missingCount: missing,
    p50: quantile(arr, 0.5),
    p95: quantile(arr, 0.95),
    p99: quantile(arr, 0.99),
    max: arr.length ? arr[arr.length - 1] : null,
    smallSample: arr.length < 20,
  });
  return { exact: summarize(exact, durationMissing), wallClock: summarize(wall, wallMissing) };
}

export const DURATION_HISTOGRAM_BOUNDS = [
  { key: 'lt1s', label: '<1s', min: 0, max: 1_000 },
  { key: 's1_5', label: '1–5s', min: 1_000, max: 5_000 },
  { key: 's5_15', label: '5–15s', min: 5_000, max: 15_000 },
  { key: 's15_60', label: '15–60s', min: 15_000, max: 60_000 },
  { key: 'm1_5', label: '1–5min', min: 60_000, max: 300_000 },
  { key: 'gt5m', label: '>5min', min: 300_000, max: Infinity },
];

export function durationHistogram(rows, basis = 'auto') {
  const buckets = DURATION_HISTOGRAM_BOUNDS.map((b) => ({ ...b, count: 0 }));
  let used = 0;
  let missing = 0;
  for (const r of rows) {
    let v = null;
    if (basis === 'duration') v = r.duration_ms;
    else if (basis === 'wall') v = r.started_at != null && r.ended_at != null ? r.ended_at - r.started_at : null;
    else v = r.duration_ms ?? (r.started_at != null && r.ended_at != null ? r.ended_at - r.started_at : null);
    if (v == null || v < 0) { missing += 1; continue; }
    used += 1;
    const b = buckets.find((x) => v >= x.min && v < x.max);
    if (b) b.count += 1;
  }
  return { buckets, used, missing };
}

/** Interval union length + average overlap parallelism (§4.6). */
export function intervalUnionStats(intervals) {
  const valid = intervals
    .filter((i) => i.start != null && i.end != null && i.end > i.start)
    .sort((a, b) => a.start - b.start || a.end - b.end);
  if (!valid.length) return { unionMs: 0, totalMs: 0, avgParallelism: null, peakParallelism: 0, usedIntervals: 0 };
  let unionMs = 0;
  let totalMs = 0;
  let curS = valid[0].start;
  let curE = valid[0].end;
  const events = [];
  for (const i of valid) {
    totalMs += i.end - i.start;
    events.push([i.start, 1], [i.end, -1]);
    if (i.start > curE) { unionMs += curE - curS; curS = i.start; curE = i.end; }
    else if (i.end > curE) curE = i.end;
  }
  unionMs += curE - curS;
  events.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  let cur = 0;
  let peak = 0;
  for (const [, d] of events) { cur += d; if (cur > peak) peak = cur; }
  return {
    unionMs,
    totalMs,
    avgParallelism: unionMs > 0 ? totalMs / unionMs : null,
    peakParallelism: peak,
    usedIntervals: valid.length,
  };
}
