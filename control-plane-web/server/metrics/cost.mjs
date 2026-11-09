// Cost semantics (§4.7): latest revision per (scope, authority_key) wins;
// Decimal arithmetic only; currencies never mix; sources stay faceted unless
// an authorityPolicy names a preferred source.
import Decimal from 'decimal.js';

/** Pick latest-revision rows from obs_cost_observation (already all revisions). */
export function latestCostRevisions(rows) {
  const latest = new Map();
  for (const r of rows) {
    const key = r.authority_key;
    const cur = latest.get(key);
    if (!cur || r.revision > cur.revision) latest.set(key, r);
  }
  return [...latest.values()];
}

/**
 * Sum amounts grouped by currency × source. amount_decimal stays a string;
 * NULL/UNKNOWN amounts never fall back to older revisions.
 */
export function sumCosts(rows, { preferredSource = null } = {}) {
  const facets = new Map(); // `${source}|${currency}` → {sum, count, unknownCount}
  for (const r of rows) {
    const key = `${r.source}|${r.currency ?? 'UNKNOWN'}`;
    if (!facets.has(key)) facets.set(key, { source: r.source, currency: r.currency ?? null, sum: '0', count: 0, unknownCount: 0 });
    const f = facets.get(key);
    f.count += 1;
    if (r.amount_decimal == null || r.amount_decimal === 'UNKNOWN') { f.unknownCount += 1; continue; }
    try {
      f.sum = new Decimal(f.sum).plus(new Decimal(r.amount_decimal)).toString();
    } catch {
      f.unknownCount += 1;
    }
  }
  const list = [...facets.values()];
  let preferred = null;
  if (preferredSource) {
    const sel = list.filter((f) => f.source === preferredSource);
    preferred = sel.length ? sel : null;
  }
  return { facets: list, preferred };
}
