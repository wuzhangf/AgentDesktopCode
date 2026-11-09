// MetricValue / QueryMeta builders shared by all v2 endpoints (§11.3).
import { randomUUID } from 'node:crypto';
import { API_VERSION, METRIC_VERSION } from '../../shared/contracts/enums.mjs';
import { metricMeta } from '../metrics/registry.mjs';

export function metricValue({
  metricId, value = null, knownSubtotal = null, unit, currency,
  state = 'AVAILABLE', completeness = 'UNKNOWN', measurement = 'MEASURED',
  numerator, denominator, sampleCount = 0, knownCount = 0, unknownCount = 0,
  excludedCount = 0, coverageRatio = null, reasonCodes = [], cohortBasis = '',
  comparison, drilldownPath, drilldownFilters = {},
}) {
  const meta = metricMeta(metricId);
  return {
    metricId,
    value,
    knownSubtotal,
    unit: unit ?? meta?.unit ?? 'count',
    ...(currency ? { currency } : {}),
    state,
    completeness,
    measurement,
    ...(numerator != null ? { numerator } : {}),
    ...(denominator != null ? { denominator } : {}),
    sampleCount,
    knownCount,
    unknownCount,
    excludedCount,
    coverageRatio,
    reasonCodes,
    cohortBasis: cohortBasis || meta?.cohortBasis || '',
    ...(comparison ? { comparison } : {}),
    drilldown: { path: drilldownPath ?? meta?.drilldown ?? '/', filters: drilldownFilters },
  };
}

/** Previous-period comparison (§4.2): counts use relative change, ratios pp. */
export function comparisonOf(current, previous, kind) {
  if (previous == null || current == null) {
    return { value: previous, delta: null, deltaKind: kind, comparable: false, reason: 'NO_PREVIOUS' };
  }
  if (kind === 'PERCENTAGE_POINT') {
    return { value: previous, delta: current - previous, deltaKind: kind, comparable: true };
  }
  if (previous === 0) {
    if (current === 0) return { value: previous, delta: 0, deltaKind: 'PERCENT', comparable: true };
    return { value: previous, delta: null, deltaKind: 'PERCENT', comparable: false, reason: 'PREVIOUS_WAS_ZERO' };
  }
  return { value: previous, delta: (current - previous) / previous, deltaKind: 'PERCENT', comparable: true };
}

export function queryMeta(req, { dataAsOf, warnings = [], startedAt }) {
  return {
    apiVersion: API_VERSION,
    metricVersion: METRIC_VERSION,
    sourceId: req.source.id,
    sourceEpoch: req.source.sourceEpoch,
    mode: req.source.mode,
    scopeId: req.scopeId,
    schemaVersion: req.schemaVersion ?? 1,
    snapshotId: randomUUID(),
    queriedAt: Date.now(),
    dataAsOf: dataAsOf ?? null,
    ...(req.from != null ? { from: req.from } : {}),
    ...(req.to != null ? { to: req.to } : {}),
    timezone: req.timezone ?? 'Asia/Shanghai',
    ...(req.grain ? { grain: req.grain } : {}),
    filtersApplied: req.filtersApplied ?? {},
    ...(req.filtersIgnored && Object.keys(req.filtersIgnored).length
      ? { filtersIgnored: req.filtersIgnored } : {}),
    warnings,
    queryDurationMs: Math.max(0, Date.now() - startedAt),
  };
}

export function envelope(req, data, opts = {}) {
  return { meta: queryMeta(req, opts), data };
}

export function page(rows, nextCursor, { total, truncated = false } = {}) {
  return {
    rows,
    nextCursor,
    hasMore: nextCursor != null,
    ...(total != null ? { total } : {}),
    truncated,
  };
}
