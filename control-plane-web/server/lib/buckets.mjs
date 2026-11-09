// Timezone-aware bucket boundaries (§4.1, §12.8). Day buckets follow the IANA
// timezone including DST; sub-day grains are floored on the local wall clock.
import { GRAIN_MS } from '../../shared/contracts/enums.mjs';

const dtfCache = new Map();
function dtf(tz) {
  let f = dtfCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    });
    dtfCache.set(tz, f);
  }
  return f;
}

/** Wall-clock parts of `utcMs` in `tz`. */
export function wallParts(utcMs, tz) {
  const parts = dtf(tz).formatToParts(new Date(utcMs));
  const o = {};
  for (const p of parts) if (p.type !== 'literal') o[p.type] = Number(p.value);
  return { year: o.year, month: o.month, day: o.day, hour: o.hour, minute: o.minute, second: o.second };
}

/** Offset of `tz` at instant `utcMs` (ms, local - UTC). */
export function tzOffsetMs(utcMs, tz) {
  const w = wallParts(utcMs, tz);
  const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  return asUtc - Math.floor(utcMs / 1000) * 1000;
}

/** Convert local wall parts in `tz` to a UTC instant (ms). */
export function wallToUtc({ year, month, day, hour = 0, minute = 0, second = 0 }, tz) {
  const guess = Date.UTC(year, month - 1, day, hour, minute, second);
  const off1 = tzOffsetMs(guess, tz);
  const t1 = guess - off1;
  // Re-check: offsets can differ across a DST transition boundary.
  const off2 = tzOffsetMs(t1, tz);
  return off2 === off1 ? t1 : guess - off2;
}

/**
 * Bucket boundaries covering [from, to) for `grain` in `tz`.
 * Returns ascending UTC ms array; first <= from, last > to.
 */
export function bucketBoundaries(from, to, grain, tz) {
  const out = [];
  if (grain === '1d') {
    const w = wallParts(from, tz);
    let t = wallToUtc({ year: w.year, month: w.month, day: w.day }, tz);
    while (t > from) {
      const prev = wallParts(t - 86_400_000, tz);
      t = wallToUtc({ year: prev.year, month: prev.month, day: prev.day }, tz);
    }
    while (t <= to) { out.push(t); t = nextDay(t, tz); }
    out.push(t); // closing edge: last boundary must exceed `to`
    return out;
  }
  const stepMs = GRAIN_MS[grain];
  // Sub-day grains: floor in local wall time; offsets are stable within a bucket
  // for our supported zones (DST transitions only matter for day alignment).
  let t = floorLocal(from, stepMs, tz);
  while (t <= to) {
    out.push(t);
    t = floorLocal(t + stepMs + 1, stepMs, tz);
    if (t <= out[out.length - 1]) t = out[out.length - 1] + stepMs; // DST overlap guard
  }
  out.push(t); // closing edge
  return out;
}

function nextDay(midnightUtc, tz) {
  const w = wallParts(midnightUtc + 43_200_000, tz); // local noon same/next day
  let t = wallToUtc({ year: w.year, month: w.month, day: w.day }, tz);
  if (t <= midnightUtc) {
    const w2 = wallParts(midnightUtc + 90_000_000, tz);
    t = wallToUtc({ year: w2.year, month: w2.month, day: w2.day }, tz);
  }
  return t;
}

function floorLocal(utcMs, stepMs, tz) {
  const off = tzOffsetMs(utcMs, tz);
  const local = utcMs + off;
  const flooredLocal = local - (local % stepMs);
  const guess = flooredLocal - off;
  const off2 = tzOffsetMs(guess, tz);
  return off2 === off ? guess : flooredLocal - off2;
}

/** Assign `ts` to a bucket index given `boundaries`; -1 if outside. */
export function bucketIndex(ts, boundaries) {
  if (ts < boundaries[0] || ts >= boundaries[boundaries.length - 1]) return -1;
  let lo = 0, hi = boundaries.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (boundaries[mid] <= ts) lo = mid; else hi = mid;
  }
  return lo;
}
