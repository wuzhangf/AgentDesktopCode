// Token usage aggregation (§4.4): totals keep their total_source; stacking is
// only mutually-exclusive when reasoning_relation allows; NULL stays unknown.
import { INPUT_COVERAGE, REASONING_RELATION, TOTAL_SOURCE } from '../../shared/contracts/enums.mjs';

/**
 * Aggregate obs_model_usage rows (one row per attempt).
 * Returns known subtotals + sample coverage; never invents zero.
 */
export function aggregateUsage(rows) {
  const a = {
    sampleCount: rows.length,
    usageRowCount: 0,
    input: { knownCount: 0, completeCount: 0, knownSubtotal: 0, completeSubtotal: 0 },
    output: { knownCount: 0, knownSubtotal: 0 },
    reasoning: { knownCount: 0, knownSubtotal: 0 },
    total: { knownCount: 0, knownSubtotal: 0 },
    cacheRead: { knownCount: 0, knownSubtotal: 0 },
    cacheWrite: { knownCount: 0, knownSubtotal: 0 },
    uncachedInput: { knownCount: 0, knownSubtotal: 0 },
    byRelation: {},
    stackableGroups: [],
  };
  for (const u of rows) {
    if (!u) continue;
    a.usageRowCount += 1;
    const rel = u.reasoning_relation ?? REASONING_RELATION.UNKNOWN;
    a.byRelation[rel] = (a.byRelation[rel] ?? 0) + 1;
    if (u.input_tokens != null) { a.input.knownCount += 1; a.input.knownSubtotal += u.input_tokens; }
    if (u.input_coverage === INPUT_COVERAGE.COMPLETE && u.input_tokens != null) {
      a.input.completeCount += 1; a.input.completeSubtotal += u.input_tokens;
    }
    if (u.output_tokens != null) { a.output.knownCount += 1; a.output.knownSubtotal += u.output_tokens; }
    if (u.reasoning_tokens != null) { a.reasoning.knownCount += 1; a.reasoning.knownSubtotal += u.reasoning_tokens; }
    if (u.total_tokens != null && (u.total_source === TOTAL_SOURCE.PROVIDER || u.total_source === TOTAL_SOURCE.DERIVED)) {
      a.total.knownCount += 1; a.total.knownSubtotal += u.total_tokens;
    }
    if (u.cache_read_input_tokens != null) { a.cacheRead.knownCount += 1; a.cacheRead.knownSubtotal += u.cache_read_input_tokens; }
    if (u.cache_write_input_tokens != null) { a.cacheWrite.knownCount += 1; a.cacheWrite.knownSubtotal += u.cache_write_input_tokens; }
    if (u.uncached_input_tokens != null) { a.uncachedInput.knownCount += 1; a.uncachedInput.knownSubtotal += u.uncached_input_tokens; }
  }
  return a;
}

/**
 * Mutually-exclusive stack for one usage row (§4.4). Returns null when the
 * relation doesn't permit a safe stack; parts sum to the bar's total height.
 */
export function stackParts(u) {
  if (!u || u.input_tokens == null || u.output_tokens == null) return null;
  const reasoning = u.reasoning_tokens ?? null;
  if (u.reasoning_relation === REASONING_RELATION.INCLUDED_IN_OUTPUT) {
    if (reasoning == null || u.output_tokens < reasoning) return null;
    return { input: u.input_tokens, outputExReasoning: u.output_tokens - reasoning, reasoning, height: u.input_tokens + u.output_tokens };
  }
  if (u.reasoning_relation === REASONING_RELATION.SEPARATE) {
    if (reasoning == null) return null;
    return { input: u.input_tokens, output: u.output_tokens, reasoning, height: u.input_tokens + u.output_tokens + reasoning };
  }
  return null; // UNKNOWN / mixed: chart as independent series, never stacked.
}

/**
 * cache_read_share (§4.4): Σcache_read / Σinput over the same complete+known
 * input sample set. Also returns the share of requests with any cache hit —
 * a different denominator, reported separately.
 */
export function cacheReadShare(rows) {
  let inputSum = 0;
  let cacheSum = 0;
  let completeKnown = 0;
  let withCacheHit = 0;
  let cacheKnown = 0;
  for (const u of rows) {
    if (!u) continue;
    if (u.cache_read_input_tokens != null) {
      cacheKnown += 1;
      if (u.cache_read_input_tokens > 0) withCacheHit += 1;
    }
    if (u.input_coverage === INPUT_COVERAGE.COMPLETE && u.input_tokens != null) {
      completeKnown += 1;
      inputSum += u.input_tokens;
      if (u.cache_read_input_tokens != null) cacheSum += u.cache_read_input_tokens;
    }
  }
  return {
    cacheReadShare: inputSum > 0 ? cacheSum / inputSum : null,
    completeInputSamples: completeKnown,
    cacheKnownSamples: cacheKnown,
    hitRequestShare: cacheKnown > 0 ? withCacheHit / cacheKnown : null,
  };
}

/** Per-bucket token trend: known subtotals only; a bucket with no usage rows → nulls. */
export function usageBucket(rows) {
  const a = aggregateUsage(rows);
  return {
    sampleCount: a.sampleCount,
    input: a.input.knownCount ? a.input.knownSubtotal : null,
    output: a.output.knownCount ? a.output.knownSubtotal : null,
    reasoning: a.reasoning.knownCount ? a.reasoning.knownSubtotal : null,
    total: a.total.knownCount ? a.total.knownSubtotal : null,
    knownCounts: {
      input: a.input.knownCount, output: a.output.knownCount,
      reasoning: a.reasoning.knownCount, total: a.total.knownCount,
    },
  };
}
