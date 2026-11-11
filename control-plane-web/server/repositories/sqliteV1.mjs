// Schema-v1 repository: all observation queries. Composed endpoints run inside
// one short read transaction on the worker's connection (§10.2). SQL follows
// §12 rules: aggregate each fact at its own grain, then join — never SUM across
// a steps×attempts×tools cartesian product.
import { hasTable } from '../db/readonly.mjs';
import {
  KNOWN_TERMINAL_OUTCOMES, SUCCESS_RATE_OUTCOMES, LIFECYCLE, ENTITY_KIND,
  VISIBILITY, DISPATCH_STATE,
} from '../../shared/contracts/enums.mjs';
import { classifyEntity, countCreatedCohort, completedOutcomeStats } from '../metrics/cohorts.mjs';
import { durationStats, durationHistogram, intervalUnionStats, quantile } from '../metrics/duration.mjs';
import { aggregateUsage, usageBucket, cacheReadShare } from '../metrics/usage.mjs';
import { latestCostRevisions, sumCosts } from '../metrics/cost.mjs';
import { validateRunRelations, verifiedDescendants } from '../metrics/hierarchy.mjs';
import { deriveAttention } from '../metrics/quality.mjs';
import { bucketBoundaries, bucketIndex } from '../lib/buckets.mjs';
import { metricValue, comparisonOf } from '../lib/dto.mjs';

const ENTITY_COLS = `e.lifecycle, e.outcome, e.native_status, e.effect_state, e.coverage,
  e.registered_at, e.started_at, e.ended_at, e.duration_ms, e.timing_quality, e.reason_code,
  e.root_run_id AS entity_root_run_id, e.run_id AS entity_run_id, e.parent_entity_id, e.current_revision`;

const rows = (db, sql, ...args) => db.prepare(sql).all(...args);
const one = (db, sql, ...args) => db.prepare(sql).get(...args);

function dataAsOf(db, scopeId) {
  return one(db, 'SELECT MAX(recorded_at) m FROM obs_event WHERE scope_id = ?', scopeId)?.m ?? null;
}

// ---------- capability discovery (§10.3) ----------

export function metaSourceInfo(ctx, p) {
  const { db, schema } = ctx;
  const scope = p.scopeId ?? null;
  const bounds = scope
    ? one(db, 'SELECT MIN(recorded_at) lo, MAX(recorded_at) hi FROM obs_event WHERE scope_id=?', scope)
    : one(db, 'SELECT MIN(recorded_at) lo, MAX(recorded_at) hi FROM obs_event');
  const scopes = rows(db, 'SELECT DISTINCT scope_id s FROM obs_entity ORDER BY s').map((r) => r.s);
  return {
    schemaVersion: schema.version,
    scopes,
    dataAsOf: bounds?.hi ?? null,
    dataSince: bounds?.lo ?? null,
  };
}


const DOMAIN_TABLES = {
  task: 'obs_task', run: 'obs_run', segment: 'obs_run_segment',
  plan: 'obs_plan_revision', step: 'obs_step', stepAttempt: 'obs_step_attempt',
  modelCall: 'obs_model_call', modelAttempt: 'obs_model_attempt',
  modelUsage: 'obs_model_usage', context: 'obs_context_snapshot',
  contextComponent: 'obs_context_component', contextTransform: 'obs_context_transform',
  tool: 'obs_tool_call', command: 'obs_command', delegation: 'obs_delegation',
  reasoning: 'obs_reasoning_output', cost: 'obs_cost_observation',
  artifact: 'obs_artifact', issue: 'obs_registration_issue',
};

const HOOK_BY_DOMAIN = {
  task: 'task', run: 'run', segment: 'segment', plan: 'plan', step: 'step',
  stepAttempt: 'step', modelCall: 'model-call', modelAttempt: 'model-route',
  modelUsage: 'model-route', context: 'model-call', contextComponent: 'model-call',
  contextTransform: 'model-call', tool: 'tool', command: 'command',
  delegation: 'delegation', reasoning: 'model-route', cost: 'model-route',
  artifact: null, issue: null,
};

export function metaCapabilities(ctx, p) {
  const { db, schema } = ctx;
  const scope = p.scopeId;
  const caps = [];
  const hooks = new Set();
  for (const s of rows(db, 'SELECT capabilities_json FROM obs_source WHERE scope_id = ?', scope)) {
    try {
      for (const h of JSON.parse(s.capabilities_json ?? '{}').hooks ?? []) hooks.add(h);
    } catch { /* malformed capabilities_json stays UNKNOWN */ }
  }
  const sourceCount = one(db, 'SELECT COUNT(*) n FROM obs_source WHERE scope_id = ?', scope)?.n ?? 0;
  for (const [key, table] of Object.entries(DOMAIN_TABLES)) {
    const schemaAvailable = hasTable(schema, table);
    let observed = 0;
    if (schemaAvailable) observed = one(db, `SELECT COUNT(*) n FROM ${table} WHERE scope_id = ?`, scope)?.n ?? 0;
    const hook = HOOK_BY_DOMAIN[key];
    const sourceDeclared = hook == null ? 'UNKNOWN' : (hooks.has(hook) ? 'YES' : (sourceCount ? 'NO' : 'UNKNOWN'));
    caps.push({
      key, schemaAvailable,
      sourceDeclared: sourceCount === 0 ? 'UNKNOWN' : sourceDeclared,
      observedRows: observed, usableSamples: null,
    });
  }
  // Field-level usable samples for the headline metrics.
  const usage = caps.find((c) => c.key === 'modelUsage');
  if (usage?.schemaAvailable) {
    usage.usableSamples = one(db,
      `SELECT COUNT(*) n FROM obs_model_usage u JOIN obs_model_attempt a
         ON a.scope_id=u.scope_id AND a.attempt_id=u.attempt_id
       WHERE u.scope_id=? AND u.total_tokens IS NOT NULL AND u.total_source IN ('PROVIDER','DERIVED')`, scope)?.n ?? 0;
    const inputKnown = one(db,
      `SELECT COUNT(*) n FROM obs_model_usage WHERE scope_id=? AND input_tokens IS NOT NULL`, scope)?.n ?? 0;
    if (inputKnown > 0) usage.note = `${inputKnown} rows with known input_tokens`;
  }
  const runCap = caps.find((c) => c.key === 'run');
  runCap.usableSamples = one(db,
    `SELECT COUNT(*) n FROM obs_run r JOIN obs_entity e ON e.scope_id=r.scope_id AND e.entity_id=r.run_id
     WHERE r.scope_id=? AND e.lifecycle='TERMINAL' AND e.outcome IN ('SUCCEEDED','FAILED','TIMED_OUT','CANCELLED','REJECTED','SKIPPED')`, scope)?.n ?? 0;
  const cost = caps.find((c) => c.key === 'cost');
  if (cost?.schemaAvailable && cost.observedRows > 0) {
    cost.usableSamples = one(db,
      `SELECT COUNT(*) n FROM obs_cost_observation WHERE scope_id=? AND amount_decimal IS NOT NULL`, scope)?.n ?? 0;
  }
  const ctxSnap = caps.find((c) => c.key === 'context');
  if (ctxSnap?.schemaAvailable && ctxSnap.observedRows > 0) {
    ctxSnap.usableSamples = one(db,
      `SELECT COUNT(*) n FROM obs_context_snapshot WHERE scope_id=? AND input_tokens_estimated IS NOT NULL`, scope)?.n ?? 0;
  }
  const bounds = one(db, 'SELECT MIN(recorded_at) lo, MAX(recorded_at) hi FROM obs_event WHERE scope_id=?', scope);
  return {
    capabilities: caps,
    eventBounds: { min: bounds?.lo ?? null, max: bounds?.hi ?? null },
    scopeId: scope,
  };
}

export function metaDimensions(ctx, p) {
  const { db } = ctx;
  const scope = p.scopeId;
  const search = p.search ? `%${p.search}%` : null;
  const limit = Math.min(p.limit ?? 50, 200);
  const domains = {
    product: [`SELECT DISTINCT product_name v FROM obs_run WHERE scope_id=? AND product_name IS NOT NULL`, 'product_name'],
    runKind: [`SELECT DISTINCT run_kind v FROM obs_run WHERE scope_id=?`, 'run_kind'],
    configRevision: [`SELECT DISTINCT config_revision v FROM obs_run WHERE scope_id=? AND config_revision IS NOT NULL`, 'config_revision'],
    provider: [`SELECT DISTINCT provider_id v FROM obs_model_attempt WHERE scope_id=? AND provider_id IS NOT NULL`, 'provider_id'],
    model: [`SELECT DISTINCT resolved_model v FROM obs_model_attempt WHERE scope_id=? AND resolved_model IS NOT NULL
             UNION SELECT DISTINCT requested_model FROM obs_model_attempt WHERE scope_id=? AND requested_model IS NOT NULL`, 'model'],
    tool: [`SELECT DISTINCT canonical_tool_name v FROM obs_tool_call WHERE scope_id=? AND canonical_tool_name IS NOT NULL`, 'canonical_tool_name'],
    purpose: [`SELECT DISTINCT purpose v FROM obs_model_call WHERE scope_id=?`, 'purpose'],
    issueCode: [`SELECT DISTINCT issue_code v FROM obs_registration_issue WHERE scope_id=?`, 'issue_code'],
  };
  const entry = domains[p.domain];
  if (!entry) return { domain: p.domain, values: [] };
  const [sql] = entry;
  const args = sql.includes('UNION') ? [scope, scope] : [scope];
  let vals = rows(db, sql, ...args).map((r) => r.v).filter((v) => v != null);
  if (search) vals = vals.filter((v) => v.toLowerCase().includes(p.search.toLowerCase()));
  vals.sort();
  return { domain: p.domain, values: vals.slice(0, limit), total: vals.length };
}

// ---------- run cohort helpers ----------

function fetchRunRows(db, scope, { product, runKind, configRevision, lifecycle, outcome } = {}) {
  const cond = ['r.scope_id = ?'];
  const args = [scope];
  if (product) { cond.push('r.product_name = ?'); args.push(product); }
  if (runKind) { cond.push('r.run_kind = ?'); args.push(runKind); }
  if (configRevision) { cond.push('r.config_revision = ?'); args.push(configRevision); }
  if (lifecycle) { cond.push('e.lifecycle = ?'); args.push(lifecycle); }
  if (outcome) { cond.push('e.outcome = ?'); args.push(outcome); }
  return rows(db, `
    SELECT r.run_id, r.task_id, r.session_id, r.parent_run_id, r.root_run_id,
           r.run_kind, r.product_name, r.product_version, r.config_revision, ${ENTITY_COLS}
    FROM obs_run r JOIN obs_entity e ON e.scope_id = r.scope_id AND e.entity_id = r.run_id
    WHERE ${cond.join(' AND ')}`, ...args);
}

function runToRow(r, relationMap) {
  const cls = classifyEntity(r);
  const rel = relationMap?.get(r.run_id);
  const wall = r.started_at != null && r.ended_at != null ? r.ended_at - r.started_at : null;
  return {
    runId: r.run_id, taskId: r.task_id, sessionId: r.session_id,
    parentRunId: r.parent_run_id, rootRunId: r.root_run_id,
    runKind: r.run_kind, productName: r.product_name, productVersion: r.product_version,
    configRevision: r.config_revision,
    lifecycle: r.lifecycle, outcome: r.outcome, nativeStatus: r.native_status,
    activityState: cls.activityState,
    relationState: rel?.relationState ?? 'VERIFIED',
    registeredAt: r.registered_at, startedAt: r.started_at, endedAt: r.ended_at,
    durationMs: r.duration_ms, timingQuality: r.timing_quality, wallClockMs: wall,
    coverage: r.coverage,
    stepCount: 0, callCount: 0, transportAttemptCount: 0, toolCallCount: 0,
    commandCount: 0, knownTotalTokens: null, usageKnownCount: 0,
    qualityReasons: cls.qualityReasons,
  };
}

/** Per-run direct-fact aggregates (own-grain subqueries, §12.1). */
function attachRunAggregates(db, scope, runRows) {
  if (!runRows.length) return;
  const ids = runRows.map((r) => r.runId);
  const ph = ids.map(() => '?').join(',');
  const byRun = new Map(runRows.map((r) => [r.runId, r]));
  const set = (id, patch) => { const r = byRun.get(id); if (r) Object.assign(r, patch); };
  for (const r of rows(db, `SELECT run_id, COUNT(*) n FROM obs_step WHERE scope_id=? AND run_id IN (${ph}) GROUP BY run_id`, scope, ...ids)) {
    set(r.run_id, { stepCount: r.n });
  }
  for (const r of rows(db, `SELECT run_id, COUNT(*) n FROM obs_model_call WHERE scope_id=? AND run_id IN (${ph}) GROUP BY run_id`, scope, ...ids)) {
    set(r.run_id, { callCount: r.n });
  }
  for (const r of rows(db, `
    SELECT c.run_id, COUNT(*) n FROM obs_model_attempt a
    JOIN obs_model_call c ON c.scope_id=a.scope_id AND c.call_id=a.call_id
    WHERE a.scope_id=? AND c.run_id IN (${ph})
      AND a.visibility='TRANSPORT_ATTEMPT' AND a.dispatch_state IN ('ATTEMPTED','RESPONSE_RECEIVED')
    GROUP BY c.run_id`, scope, ...ids)) {
    set(r.run_id, { transportAttemptCount: r.n });
  }
  for (const r of rows(db, `SELECT run_id, COUNT(*) n FROM obs_tool_call WHERE scope_id=? AND run_id IN (${ph}) GROUP BY run_id`, scope, ...ids)) {
    set(r.run_id, { toolCallCount: r.n });
  }
  if (hasTableCtx(db, 'obs_command')) {
    for (const r of rows(db, `SELECT run_id, COUNT(*) n FROM obs_command WHERE scope_id=? AND run_id IN (${ph}) GROUP BY run_id`, scope, ...ids)) {
      set(r.run_id, { commandCount: r.n });
    }
  }
  for (const r of rows(db, `
    SELECT c.run_id,
           COUNT(u.attempt_id) usage_rows,
           SUM(CASE WHEN u.total_tokens IS NOT NULL AND u.total_source IN ('PROVIDER','DERIVED')
                    THEN u.total_tokens END) known_total,
           COUNT(CASE WHEN u.total_tokens IS NOT NULL AND u.total_source IN ('PROVIDER','DERIVED')
                      THEN 1 END) known_total_count
    FROM obs_model_attempt a
    JOIN obs_model_call c ON c.scope_id=a.scope_id AND c.call_id=a.call_id
    LEFT JOIN obs_model_usage u ON u.scope_id=a.scope_id AND u.attempt_id=a.attempt_id
    WHERE a.scope_id=? AND c.run_id IN (${ph}) GROUP BY c.run_id`, scope, ...ids)) {
    set(r.run_id, { knownTotalTokens: r.known_total, usageKnownCount: r.known_total_count });
  }
}

function hasTableCtx(db, name) {
  return !!one(db, "SELECT name FROM sqlite_master WHERE type='table' AND name=?", name);
}

/**
 * Keyset continuation predicate for `ORDER BY <col> <dir> NULLS LAST, <pk> <dir>`.
 * A NULL anchor value means we are inside the trailing NULL run — continue by pk.
 */
function pushKeyset(cond, args, col, pk, dir, v, lastId) {
  const cmp = dir === 'DESC' ? '<' : '>';
  if (v == null) {
    cond.push(`(${col} IS NULL AND ${pk} ${cmp} ?)`);
    args.push(lastId);
  } else {
    cond.push(`(${col} ${cmp} ? OR (${col} = ? AND ${pk} ${cmp} ?) OR ${col} IS NULL)`);
    args.push(v, v, lastId);
  }
}

// ---------- analytics: overview (single combined response, §10.2) ----------

export function analyticsOverview(ctx, p) {
  const { db } = ctx;
  const scope = p.scopeId;
  const { from, to, timezone, grain } = p;
  const prevFrom = from - (to - from);
  const prevTo = from;

  const allRuns = fetchRunRows(db, scope, p.filters);
  const relationMap = validateRunRelations(allRuns);

  // Run-attribute filters must scope every downstream section (calls, tools,
  // attempts, context pressure) — not just the run cohort KPIs.
  const scopedRunIds = (p.filters?.product || p.filters?.runKind || p.filters?.configRevision)
    ? allRuns.map((r) => r.run_id) : null;
  const runSet = scopedRunIds ? new Set(scopedRunIds) : null;
  const runPh = scopedRunIds ? (scopedRunIds.length ? scopedRunIds.map(() => '?').join(',') : 'NULL') : null;

  const createdRows = allRuns.filter((r) => r.registered_at >= from && r.registered_at < to);
  const prevCreated = allRuns.filter((r) => r.registered_at >= prevFrom && r.registered_at < prevTo);
  const created = countCreatedCohort(createdRows);
  const prevCreatedStats = countCreatedCohort(prevCreated);

  const completedRows = allRuns.filter((r) => r.ended_at != null && r.ended_at >= from && r.ended_at < to);
  const completed = completedOutcomeStats(completedRows);
  const prevCompleted = completedOutcomeStats(allRuns.filter((r) => r.ended_at != null && r.ended_at >= prevFrom && r.ended_at < prevTo));

  const unclosedNow = allRuns.filter((r) => {
    const c = classifyEntity(r);
    return c.activityState === 'UNCLOSED' || c.activityState === 'ACTIVITY_UNKNOWN' || c.activityState === 'PAUSED';
  });
  const conflicts = allRuns.filter((r) => classifyEntity(r).conflict);
  const relAnomalyRuns = allRuns.filter((r) => (relationMap.get(r.run_id)?.anomalies ?? []).length > 0);

  // Calls registered in window + their observed transports (SQL-D).
  const callRows = rows(db, `
    SELECT c.call_id, e.registered_at FROM obs_model_call c
    JOIN obs_entity e ON e.scope_id=c.scope_id AND e.entity_id=c.call_id
    WHERE c.scope_id=? AND e.registered_at>=? AND e.registered_at<?
    ${runPh ? `AND c.run_id IN (${runPh})` : ''}`, scope, from, to, ...(scopedRunIds ?? []));
  const prevCallRows = rows(db, `
    SELECT c.call_id FROM obs_model_call c
    JOIN obs_entity e ON e.scope_id=c.scope_id AND e.entity_id=c.call_id
    WHERE c.scope_id=? AND e.registered_at>=? AND e.registered_at<?
    ${runPh ? `AND c.run_id IN (${runPh})` : ''}`, scope, prevFrom, prevTo, ...(scopedRunIds ?? []));
  const retry = retryStatsForCalls(db, scope, callRows.map((r) => r.call_id));
  const prevRetry = retryStatsForCalls(db, scope, prevCallRows.map((r) => r.call_id));

  // Tool calls registered in window.
  const toolCount = one(db, `
    SELECT COUNT(*) n FROM obs_tool_call t JOIN obs_entity e
      ON e.scope_id=t.scope_id AND e.entity_id=t.tool_call_id
    WHERE t.scope_id=? AND e.registered_at>=? AND e.registered_at<?
    ${runPh ? `AND t.run_id IN (${runPh})` : ''}`, scope, from, to, ...(scopedRunIds ?? []))?.n ?? 0;
  const prevToolCount = one(db, `
    SELECT COUNT(*) n FROM obs_tool_call t JOIN obs_entity e
      ON e.scope_id=t.scope_id AND e.entity_id=t.tool_call_id
    WHERE t.scope_id=? AND e.registered_at>=? AND e.registered_at<?
    ${runPh ? `AND t.run_id IN (${runPh})` : ''}`, scope, prevFrom, prevTo, ...(scopedRunIds ?? []))?.n ?? 0;

  // Attempt usage: attributed to attempt started_at, fallback registered_at.
  const usageRowsAll = rows(db, `
    SELECT a.attempt_id, a.provider_id, a.resolved_model, a.visibility, a.dispatch_state,
           u.input_tokens, u.output_tokens, u.reasoning_tokens, u.total_tokens,
           u.input_coverage, u.reasoning_relation, u.total_source,
           u.cache_read_input_tokens, u.cache_write_input_tokens, u.uncached_input_tokens,
           COALESCE(e.started_at, e.registered_at) AS bucket_at,
           (e.started_at IS NULL) AS used_fallback_time,
           c.run_id
    FROM obs_model_attempt a
    JOIN obs_entity e ON e.scope_id=a.scope_id AND e.entity_id=a.attempt_id
    LEFT JOIN obs_model_call c ON c.scope_id=a.scope_id AND c.call_id=a.call_id
    LEFT JOIN obs_model_usage u ON u.scope_id=a.scope_id AND u.attempt_id=a.attempt_id
    WHERE a.scope_id=?`, scope);
  const inWin = usageRowsAll.filter((r) => r.bucket_at >= from && r.bucket_at < to && (!runSet || runSet.has(r.run_id)));
  const usageAgg = aggregateUsage(inWin.map((r) => usageProjection(r)));
  const prevAgg = aggregateUsage(
    usageRowsAll.filter((r) => r.bucket_at >= prevFrom && r.bucket_at < prevTo && (!runSet || runSet.has(r.run_id)))
      .map((r) => usageProjection(r)));

  // Duration stats for completed cohort.
  const dur = durationStats(completedRows.filter((r) => {
    const c = classifyEntity(r);
    return c.isTrustedTerminal;
  }));
  const prevDur = durationStats(allRuns.filter((r) => {
    const c = classifyEntity(r);
    return c.isTrustedTerminal && r.ended_at >= prevFrom && r.ended_at < prevTo;
  }));

  // Time-bucketed trends.
  const bounds = bucketBoundaries(from, to, grain, timezone);
  const registeredTrend = bounds.slice(0, -1).map((b) => ({ bucketStart: b, count: 0 }));
  const completedTrend = bounds.slice(0, -1).map((b) => ({ bucketStart: b, count: 0 }));
  for (const r of createdRows) {
    const i = bucketIndex(r.registered_at, bounds);
    if (i >= 0) registeredTrend[i].count += 1;
  }
  for (const r of completedRows) {
    const i = bucketIndex(r.ended_at, bounds);
    if (i >= 0) completedTrend[i].count += 1;
  }
  const tokenTrend = bounds.slice(0, -1).map((b) => ({
    bucketStart: b, input: null, output: null, reasoning: null, total: null, usageRows: 0,
  }));
  const byBucket = new Map();
  for (const r of inWin) {
    const i = bucketIndex(r.bucket_at, bounds);
    if (i < 0) continue;
    if (!byBucket.has(i)) byBucket.set(i, []);
    byBucket.get(i).push(usageProjection(r));
  }
  for (const [i, list] of byBucket) {
    const b = usageBucket(list);
    tokenTrend[i].input = b.input;
    tokenTrend[i].output = b.output;
    tokenTrend[i].reasoning = b.reasoning;
    tokenTrend[i].total = b.total;
    tokenTrend[i].usageRows = b.sampleCount;
  }

  const topModels = topModelRows(db, scope, { from, to, runIds: scopedRunIds });
  const topTools = topToolRows(db, scope, { from, to, limit: 10, runIds: scopedRunIds });
  const issueCounts = one(db,
    'SELECT COUNT(*) records, COALESCE(SUM(occurrence_count),0) oc FROM obs_registration_issue WHERE scope_id=?', scope);
  const sources = rows(db,
    'SELECT source_instance_id, heartbeat_at, stopped_at, boot_at FROM obs_source WHERE scope_id=?', scope);
  const now = Date.now();
  const unknownLiveness = sources.filter((s) => s.heartbeat_at == null && s.stopped_at == null).length;

  const stateConflicts = conflicts.length;
  const attention = deriveAttention({
    usageAgg, runCreated: created, runCompleted: completed,
    stateConflicts, relationAnomalies: relAnomalyRuns.length,
    retryStats: retry,
    sourceLiveness: { unknown: unknownLiveness, total: sources.length },
    durationMissingEnded: dur.exact.missingCount,
    issueCounts: { records: issueCounts?.records ?? 0, occurrences: issueCounts?.oc ?? 0 },
    ctxPressure: contextPressureCount(db, scope, { from, to, runIds: scopedRunIds }),
  }).slice(0, 3);

  const recent = allRuns.slice().sort((a, b) => b.registered_at - a.registered_at).slice(0, 8);
  const recentRows = recent.map((r) => runToRow(r, relationMap));
  attachRunAggregates(db, scope, recentRows);

  const cmp = p.compare;
  const kpis = [
    metricValue({
      metricId: 'run.registered', value: created.registered, unit: 'count',
      state: 'AVAILABLE', completeness: 'UNKNOWN', measurement: 'DERIVED',
      sampleCount: created.registered, knownCount: created.registered,
      cohortBasis: 'registered_at',
      comparison: cmp ? comparisonOf(created.registered, prevCreatedStats.registered, 'PERCENT') : undefined,
    }),
    metricValue({
      metricId: 'run.completed', value: completed.denominator + completed.cancelled + completed.rejected + completed.skipped,
      unit: 'count', state: 'AVAILABLE', completeness: 'UNKNOWN', measurement: 'DERIVED',
      sampleCount: completedRows.length, knownCount: completed.denominator + completed.cancelled + completed.rejected + completed.skipped,
      excludedCount: completed.excluded, cohortBasis: 'ended_at',
      comparison: cmp ? comparisonOf(completed.denominator, prevCompleted.denominator, 'PERCENT') : undefined,
    }),
    metricValue({
      metricId: 'run.execution_success_rate', value: completed.successRate, unit: 'ratio',
      state: completed.denominator ? 'AVAILABLE' : 'NO_DATA',
      completeness: completedRows.length ? 'PARTIAL' : 'UNKNOWN', measurement: 'DERIVED',
      numerator: completed.succeeded, denominator: completed.denominator,
      sampleCount: completedRows.length, knownCount: completed.denominator,
      unknownCount: completedRows.length - completed.denominator - completed.excluded,
      excludedCount: completed.excluded, cohortBasis: 'ended_at',
      reasonCodes: completed.denominator === 0 ? ['NO_KNOWN_COMPLETED_SAMPLE'] : (completed.denominator < 20 ? ['SMALL_SAMPLE'] : []),
      comparison: cmp ? comparisonOf(completed.successRate, prevCompleted.successRate, 'PERCENTAGE_POINT') : undefined,
    }),
    metricValue({
      metricId: 'run.unclosed', value: unclosedNow.length, unit: 'count',
      state: 'AVAILABLE', completeness: 'UNKNOWN', measurement: 'DERIVED',
      sampleCount: allRuns.length, knownCount: unclosedNow.length,
      cohortBasis: 'asOf', reasonCodes: unclosedNow.length ? ['ACTIVITY_EVIDENCE_MISSING'] : [],
    }),
    metricValue({
      metricId: 'model.logical_calls', value: callRows.length, unit: 'count',
      state: 'AVAILABLE', completeness: 'UNKNOWN', measurement: 'DERIVED',
      sampleCount: callRows.length, knownCount: callRows.length, cohortBasis: 'registered_at',
      comparison: cmp ? comparisonOf(callRows.length, prevCallRows.length, 'PERCENT') : undefined,
    }),
    metricValue({
      metricId: 'tool.calls', value: toolCount, unit: 'count',
      state: 'AVAILABLE', completeness: 'UNKNOWN', measurement: 'DERIVED',
      sampleCount: toolCount, knownCount: toolCount, cohortBasis: 'registered_at',
      comparison: cmp ? comparisonOf(toolCount, prevToolCount, 'PERCENT') : undefined,
    }),
    metricValue({
      metricId: 'model.usage.total_tokens',
      value: usageAgg.total.knownCount ? usageAgg.total.knownSubtotal : null,
      knownSubtotal: usageAgg.total.knownSubtotal, unit: 'tokens',
      state: usageAgg.total.knownCount ? 'AVAILABLE' : (usageAgg.usageRowCount ? 'NO_DATA' : 'NO_DATA'),
      completeness: usageAgg.usageRowCount ? (usageAgg.total.knownCount < usageAgg.usageRowCount ? 'PARTIAL' : 'COMPLETE') : 'UNKNOWN',
      measurement: 'REPORTED',
      sampleCount: usageAgg.usageRowCount, knownCount: usageAgg.total.knownCount,
      unknownCount: usageAgg.usageRowCount - usageAgg.total.knownCount,
      coverageRatio: usageAgg.usageRowCount ? usageAgg.total.knownCount / usageAgg.usageRowCount : null,
      cohortBasis: 'attempt started_at',
      reasonCodes: usageAgg.total.knownCount === 0 ? ['USAGE_NOT_PROVIDED'] : [],
      comparison: cmp && usageAgg.total.knownCount && prevAgg.total.knownCount
        ? comparisonOf(usageAgg.total.knownSubtotal, prevAgg.total.knownSubtotal, 'PERCENT') : undefined,
    }),
    metricValue({
      metricId: 'run.duration.p95', value: dur.exact.p95, unit: 'ms',
      state: dur.exact.sampleCount ? 'AVAILABLE' : 'NO_DATA',
      completeness: 'PARTIAL', measurement: 'MEASURED',
      sampleCount: dur.exact.sampleCount + dur.exact.missingCount,
      knownCount: dur.exact.sampleCount, unknownCount: dur.exact.missingCount,
      cohortBasis: 'ended_at',
      reasonCodes: dur.exact.sampleCount === 0 ? ['NO_EXACT_DURATION'] : (dur.exact.smallSample ? ['SMALL_SAMPLE'] : []),
      comparison: cmp ? comparisonOf(dur.exact.p95, prevDur.exact.p95, 'PERCENT') : undefined,
    }),
  ];

  return {
    kpis,
    registeredTrend, completedTrend, tokenTrend,
    outcomeDistribution: [
      { outcome: 'SUCCEEDED', count: created.succeeded },
      { outcome: 'FAILED', count: created.failed },
      { outcome: 'TIMED_OUT', count: created.timedOut },
      { outcome: 'CANCELLED', count: created.cancelled },
      { outcome: 'REJECTED', count: created.rejected },
      { outcome: 'SKIPPED', count: created.skipped },
      { outcome: 'OUTCOME_UNKNOWN', count: created.outcomeUnknown },
      { outcome: 'UNCLOSED', count: created.unclosed },
      { outcome: 'STATE_CONFLICT', count: created.conflict },
    ],
    outcomeKnownCoverage: created.registered ? created.knownTerminal / created.registered : null,
    topModels, topTools, attention,
    recentRuns: recentRows,
    retry: {
      logicalCalls: retry.logicalCalls, observedTransports: retry.observedTransports,
      extraObservedAttempts: retry.extraObservedAttempts, retryCallRate: retry.retryCallRate,
      retriedCalls: retry.retriedCalls, dispatchedCalls: retry.dispatchedCalls,
      portOnly: retry.portOnly, dispatchUnconfirmed: retry.dispatchUnconfirmed,
    },
    dataBounds: { asOf: dataAsOf(db, scope) },
  };
}

function usageProjection(r) {
  return {
    input_tokens: r.input_tokens, output_tokens: r.output_tokens,
    reasoning_tokens: r.reasoning_tokens, total_tokens: r.total_tokens,
    input_coverage: r.input_coverage, reasoning_relation: r.reasoning_relation,
    total_source: r.total_source,
    cache_read_input_tokens: r.cache_read_input_tokens,
    cache_write_input_tokens: r.cache_write_input_tokens,
    uncached_input_tokens: r.uncached_input_tokens,
  };
}

function retryStatsForCalls(db, scope, callIds) {
  if (!callIds.length) {
    return { logicalCalls: 0, observedTransports: 0, dispatchedCalls: 0, retriedCalls: 0, extraObservedAttempts: 0, portOnly: 0, dispatchUnconfirmed: 0, retryCallRate: null, attemptAmplification: null };
  }
  const ph = callIds.map(() => '?').join(',');
  const per = rows(db, `
    SELECT a.call_id,
      COUNT(CASE WHEN a.visibility='TRANSPORT_ATTEMPT' AND a.dispatch_state IN ('ATTEMPTED','RESPONSE_RECEIVED') THEN 1 END) observed,
      COUNT(CASE WHEN a.visibility='PORT_CALL_ONLY' THEN 1 END) port_only,
      COUNT(CASE WHEN a.dispatch_state IN ('INTENT','UNKNOWN') THEN 1 END) unconfirmed
    FROM obs_model_attempt a WHERE a.scope_id=? AND a.call_id IN (${ph})
    GROUP BY a.call_id`, scope, ...callIds);
  const byCall = new Map(per.map((r) => [r.call_id, r]));
  let observed = 0, dispatched = 0, retried = 0, extra = 0, portOnly = 0, unconfirmed = 0;
  for (const id of callIds) {
    const r = byCall.get(id);
    const k = r?.observed ?? 0;
    observed += k;
    if (k >= 1) dispatched += 1;
    if (k >= 2) { retried += 1; extra += k - 1; }
    portOnly += r?.port_only ?? 0;
    unconfirmed += r?.unconfirmed ?? 0;
  }
  return {
    logicalCalls: callIds.length, observedTransports: observed, dispatchedCalls: dispatched,
    retriedCalls: retried, extraObservedAttempts: extra, portOnly, dispatchUnconfirmed: unconfirmed,
    retryCallRate: dispatched ? retried / dispatched : null,
    attemptAmplification: dispatched ? observed / dispatched : null,
  };
}

function topModelRows(db, scope, { from, to, runIds = null }) {
  const join = runIds ? 'JOIN obs_model_call c ON c.scope_id=a.scope_id AND c.call_id=a.call_id' : '';
  const cond = runIds ? ` AND c.run_id IN (${runIds.length ? runIds.map(() => '?').join(',') : 'NULL'})` : '';
  return rows(db, `
    SELECT a.provider_id, a.resolved_model,
           COUNT(*) attempt_count,
           COUNT(DISTINCT a.call_id) call_count,
           COUNT(CASE WHEN u.total_tokens IS NOT NULL AND u.total_source IN ('PROVIDER','DERIVED') THEN 1 END) usage_known,
           SUM(CASE WHEN u.total_tokens IS NOT NULL AND u.total_source IN ('PROVIDER','DERIVED') THEN u.total_tokens END) known_total,
           COUNT(u.attempt_id) usage_rows
    FROM obs_model_attempt a
    JOIN obs_entity e ON e.scope_id=a.scope_id AND e.entity_id=a.attempt_id
    ${join}
    LEFT JOIN obs_model_usage u ON u.scope_id=a.scope_id AND u.attempt_id=a.attempt_id
    WHERE a.scope_id=? AND COALESCE(e.started_at, e.registered_at)>=? AND COALESCE(e.started_at, e.registered_at)<?
    ${cond}
    GROUP BY a.provider_id, a.resolved_model
    ORDER BY attempt_count DESC, a.resolved_model LIMIT 10`, scope, from, to, ...(runIds ?? []))
    .map((r) => ({
      providerId: r.provider_id, resolvedModel: r.resolved_model,
      callCount: r.call_count, attemptCount: r.attempt_count,
      knownTotalTokens: r.known_total, usageSampleCount: r.usage_rows, usageKnownCount: r.usage_known,
    }));
}

function topToolRows(db, scope, { from, to, limit = 10, runIds = null }) {
  const cond = runIds ? ` AND t.run_id IN (${runIds.length ? runIds.map(() => '?').join(',') : 'NULL'})` : '';
  return rows(db, `
    SELECT t.canonical_tool_name, COUNT(*) calls,
      COUNT(CASE WHEN e.lifecycle='TERMINAL' AND e.outcome='SUCCEEDED' THEN 1 END) succeeded,
      COUNT(CASE WHEN e.lifecycle='TERMINAL' AND e.outcome='FAILED' THEN 1 END) failed,
      COUNT(CASE WHEN e.lifecycle='TERMINAL' AND e.outcome IS NOT NULL THEN 1 END) terminal_known,
      SUM(CASE WHEN e.duration_ms IS NOT NULL THEN e.duration_ms END) known_duration,
      SUM(t.result_bytes) result_bytes
    FROM obs_tool_call t JOIN obs_entity e ON e.scope_id=t.scope_id AND e.entity_id=t.tool_call_id
    WHERE t.scope_id=? AND e.registered_at>=? AND e.registered_at<?
    ${cond}
    GROUP BY t.canonical_tool_name ORDER BY calls DESC LIMIT ?`, scope, from, to, ...(runIds ?? []), limit)
    .map((r) => ({
      canonicalToolName: r.canonical_tool_name, callCount: r.calls,
      succeededCount: r.succeeded, failedCount: r.failed, terminalKnownCount: r.terminal_known,
      knownDurationMs: r.known_duration, resultBytes: r.result_bytes,
    }));
}

function contextPressureCount(db, scope, { from, to, runIds = null }) {
  if (!hasTableCtx(db, 'obs_context_snapshot')) return 0;
  const join = runIds ? 'LEFT JOIN obs_model_call c ON c.scope_id=s.scope_id AND c.context_id=s.context_id' : '';
  const cond = runIds ? ` AND c.run_id IN (${runIds.length ? runIds.map(() => '?').join(',') : 'NULL'})` : '';
  return one(db, `
    SELECT COUNT(DISTINCT s.context_id) n FROM obs_context_snapshot s
      JOIN obs_entity e ON e.scope_id=s.scope_id AND e.entity_id=s.context_id
      ${join}
    WHERE s.scope_id=? AND e.registered_at>=? AND e.registered_at<?
      AND s.input_tokens_estimated IS NOT NULL AND s.usable_input_tokens IS NOT NULL
      AND s.usable_input_tokens>0
      AND CAST(s.input_tokens_estimated AS REAL)/s.usable_input_tokens >= 0.85
      ${cond}`,
    scope, from, to, ...(runIds ?? []))?.n ?? 0;
}

// ---------- analytics: runs (distributions for the list page) ----------

export function analyticsRuns(ctx, p) {
  const { db } = ctx;
  const scope = p.scopeId;
  const allRuns = fetchRunRows(db, scope, p.filters);
  const created = allRuns.filter((r) => r.registered_at >= p.from && r.registered_at < p.to);
  const completed = allRuns.filter((r) => r.ended_at != null && r.ended_at >= p.from && r.ended_at < p.to);
  const createdStats = countCreatedCohort(created);
  const completedStats = completedOutcomeStats(completed);
  const trusted = completed.filter((r) => classifyEntity(r).isTrustedTerminal);
  const dur = durationStats(trusted);
  const durBasis = p.filters.durationBasis === 'wall' ? 'wall' : (p.filters.durationBasis === 'duration' ? 'duration' : 'auto');
  const hist = durationHistogram(trusted, durBasis);
  const stepCounts = rows(db, `
    SELECT s.run_id, COUNT(*) n FROM obs_step s JOIN obs_entity e
      ON e.scope_id=s.scope_id AND e.entity_id=s.step_id
    WHERE s.scope_id=? AND e.registered_at>=? AND e.registered_at<? GROUP BY s.run_id`,
    scope, p.from, p.to);
  const stepHist = histogramOf(stepCounts.map((r) => r.n), [1, 2, 3, 5, 8, 13, 21, 34, 55]);
  return {
    createdCohort: createdStats,
    completedCohort: completedStats,
    duration: dur,
    durationHistogram: hist,
    stepHistogram: stepHist,
    outcomeKnownCoverage: createdStats.registered ? createdStats.knownTerminal / createdStats.registered : null,
  };
}

function histogramOf(values, edges) {
  const buckets = [];
  let lo = 0;
  for (const e of edges) { buckets.push({ min: lo, max: e, count: 0, label: `${lo}–${e}` }); lo = e; }
  buckets.push({ min: lo, max: Infinity, count: 0, label: `>${lo}` });
  let missing = 0;
  for (const v of values) {
    if (v == null) { missing += 1; continue; }
    (buckets.find((b) => v >= b.min && v < b.max) ?? buckets[buckets.length - 1]).count += 1;
  }
  return { buckets, used: values.length - missing, missing };
}

// ---------- runs list (keyset pagination) ----------

const RUN_SORTS = {
  registered_at: 'e.registered_at', started_at: 'e.started_at', ended_at: 'e.ended_at',
  duration_ms: 'e.duration_ms',
};

export function listRuns(ctx, p) {
  const { db } = ctx;
  const scope = p.scopeId;
  const sortCol = RUN_SORTS[p.sort.field] ?? 'e.registered_at';
  const dir = p.sort.direction;
  const cond = ['r.scope_id = ?'];
  const args = [scope];
  const f = p.filters;
  if (f.product) { cond.push('r.product_name = ?'); args.push(f.product); }
  if (f.runKind) { cond.push('r.run_kind = ?'); args.push(f.runKind); }
  if (f.configRevision) { cond.push('r.config_revision = ?'); args.push(f.configRevision); }
  if (f.lifecycle) { cond.push('e.lifecycle = ?'); args.push(f.lifecycle); }
  if (f.outcome) { cond.push('e.outcome = ?'); args.push(f.outcome); }
  if (f.taskId) { cond.push('r.task_id = ?'); args.push(f.taskId); }
  if (f.sessionId) { cond.push('r.session_id = ?'); args.push(f.sessionId); }
  if (f.involvesModel) {
    cond.push(`EXISTS (SELECT 1 FROM obs_model_call c JOIN obs_model_attempt a
      ON a.scope_id=c.scope_id AND a.call_id=c.call_id
      WHERE c.scope_id=r.scope_id AND c.run_id=r.run_id
        AND (a.resolved_model=? OR a.requested_model=?))`);
    args.push(f.involvesModel, f.involvesModel);
  }
  if (f.state === 'unclosed') cond.push(`e.lifecycle IN ('REGISTERED','STARTED','OUTCOME_UNKNOWN')`);
  // created-cohort window filter (registered_at) — applies when from/to passed.
  if (p.from != null) { cond.push('e.registered_at >= ?'); args.push(p.from); }
  if (p.to != null) { cond.push('e.registered_at < ?'); args.push(p.to); }
  if (p.cursorData) {
    const [v] = p.cursorData.sortValues;
    pushKeyset(cond, args, sortCol, 'r.run_id', dir, v, p.cursorData.entityId);
  }
  const sql = `
    SELECT r.run_id, r.task_id, r.session_id, r.parent_run_id, r.root_run_id,
           r.run_kind, r.product_name, r.product_version, r.config_revision, ${ENTITY_COLS}
    FROM obs_run r JOIN obs_entity e ON e.scope_id=r.scope_id AND e.entity_id=r.run_id
    WHERE ${cond.join(' AND ')}
    ORDER BY ${sortCol} ${dir} NULLS LAST, r.run_id ${dir}
    LIMIT ?`;
  const fetched = rows(db, sql, ...args, p.limit + 1);
  const hasMore = fetched.length > p.limit;
  const pageRows = fetched.slice(0, p.limit);
  const allForRelations = fetchRunRows(db, scope, {});
  const relationMap = validateRunRelations(allForRelations);
  const out = pageRows.map((r) => runToRow(r, relationMap));
  attachRunAggregates(db, scope, out);
  const last = pageRows[pageRows.length - 1];
  const lastSortVal = last ? {
    registered_at: last.registered_at, started_at: last.started_at,
    ended_at: last.ended_at, duration_ms: last.duration_ms,
  }[p.sort.field] ?? last.registered_at : null;
  return {
    rows: out,
    hasMore,
    lastSortValue: lastSortVal,
    lastId: last?.run_id ?? null,
  };
}

// ---------- task detail ----------

export function taskDetail(ctx, p) {
  const { db } = ctx;
  const scope = p.scopeId;
  const t = one(db, `
    SELECT t.*, ${ENTITY_COLS} FROM obs_task t
    JOIN obs_entity e ON e.scope_id=t.scope_id AND e.entity_id=t.task_id
    WHERE t.scope_id=? AND t.task_id=?`, scope, p.taskId);
  if (!t) return null;
  const runRows = fetchRunRows(db, scope, {}).filter((r) => r.task_id === p.taskId);
  const relationMap = validateRunRelations(fetchRunRows(db, scope, {}));
  const runs = runRows.map((r) => runToRow(r, relationMap));
  attachRunAggregates(db, scope, runs);
  const cls = classifyEntity(t);
  return {
    task: {
      taskId: t.task_id, externalTaskId: t.external_task_id, sessionId: t.session_id,
      taskKind: t.task_kind, workspaceRef: t.workspace_ref,
      lifecycle: t.lifecycle, outcome: t.outcome, nativeStatus: t.native_status,
      activityState: cls.activityState, qualityReasons: cls.qualityReasons,
      registeredAt: t.registered_at, startedAt: t.started_at, endedAt: t.ended_at,
      durationMs: t.duration_ms,
    },
    runs,
    note: 'Task 成功率只来自 Task entity 终态；Run 结果不推导 Task 成功。',
  };
}

// ---------- run summary + timeline ----------

export function runSummary(ctx, p) {
  const { db } = ctx;
  const scope = p.scopeId;
  const r = one(db, `
    SELECT r.*, ${ENTITY_COLS} FROM obs_run r
    JOIN obs_entity e ON e.scope_id=r.scope_id AND e.entity_id=r.run_id
    WHERE r.scope_id=? AND r.run_id=?`, scope, p.runId);
  if (!r) return null;
  const allRuns = fetchRunRows(db, scope, {});
  const relationMap = validateRunRelations(allRuns);
  const row = runToRow(r, relationMap);
  attachRunAggregates(db, scope, [row]);

  const includeDescendants = p.includeDescendants === true && (p.relationPolicy ?? 'verified') === 'verified';
  const descendantIds = includeDescendants ? verifiedDescendants(p.runId, allRuns, relationMap) : [];
  const aggregationSet = [p.runId, ...descendantIds];
  if (descendantIds.length) {
    const aggRows = descendantIds.map((id) => ({ ...runToRow(allRuns.find((x) => x.run_id === id), relationMap), runId: id }));
    attachRunAggregates(db, scope, aggRows);
    for (const dr of aggRows) {
      row.stepCount += dr.stepCount; row.callCount += dr.callCount;
      row.transportAttemptCount += dr.transportAttemptCount; row.toolCallCount += dr.toolCallCount;
      row.commandCount += dr.commandCount; row.usageKnownCount += dr.usageKnownCount;
      row.knownTotalTokens = (row.knownTotalTokens ?? 0) + (dr.knownTotalTokens ?? 0);
      if (row.knownTotalTokens === 0 && row.usageKnownCount === 0) row.knownTotalTokens = null;
    }
  }

  const taskRow = r.task_id ? one(db, `
    SELECT t.task_id, e.lifecycle, e.outcome FROM obs_task t
    JOIN obs_entity e ON e.scope_id=t.scope_id AND e.entity_id=t.task_id
    WHERE t.scope_id=? AND t.task_id=?`, scope, r.task_id) : null;
  const task = taskRow ? { taskId: taskRow.task_id, lifecycle: taskRow.lifecycle, outcome: taskRow.outcome } : null;

  const segments = rows(db, `
    SELECT s.segment_id, s.segment_no, s.segment_end_reason, s.resume_of_segment_id,
           e.lifecycle, e.outcome, e.started_at, e.ended_at, e.registered_at
    FROM obs_run_segment s JOIN obs_entity e ON e.scope_id=s.scope_id AND e.entity_id=s.segment_id
    WHERE s.scope_id=? AND s.run_id=? ORDER BY s.segment_no`, scope, p.runId);

  const delegations = hasTableCtx(db, 'obs_delegation') ? rows(db, `
    SELECT d.delegation_id, d.child_run_id, d.role, d.requested_at, d.accepted_at, d.started_at, d.completed_at,
           e.lifecycle, e.outcome
    FROM obs_delegation d JOIN obs_entity e ON e.scope_id=d.scope_id AND e.entity_id=d.delegation_id
    WHERE d.scope_id=? AND d.parent_run_id=?`, scope, p.runId) : [];

  const childRuns = allRuns.filter((x) => x.parent_run_id === p.runId).map((x) => {
    const rel = relationMap.get(x.run_id);
    return {
      runId: x.run_id, runKind: x.run_kind, lifecycle: x.lifecycle, outcome: x.outcome,
      relationState: rel?.relationState ?? 'VERIFIED',
      viaDelegation: delegations.some((d) => d.child_run_id === x.run_id),
    };
  });

  const usageAgg = aggregateUsage(rows(db, `
    SELECT u.* FROM obs_model_attempt a
    JOIN obs_model_call c ON c.scope_id=a.scope_id AND c.call_id=a.call_id
    LEFT JOIN obs_model_usage u ON u.scope_id=a.scope_id AND u.attempt_id=a.attempt_id
    WHERE a.scope_id=? AND c.run_id IN (${aggregationSet.map(() => '?').join(',') || 'NULL'})`,
    scope, ...aggregationSet));

  const anomalies = [...relationMap.entries()]
    .filter(([, v]) => v.anomalies.length)
    .map(([runId, v]) => ({ runId, reason: v.anomalies.join(',') }));

  const stats = [
    metricValue({
      metricId: 'run.steps', value: row.stepCount, unit: 'count',
      state: 'AVAILABLE', completeness: 'UNKNOWN', measurement: 'DERIVED',
      sampleCount: row.stepCount, knownCount: row.stepCount, cohortBasis: 'entity',
    }),
    metricValue({
      metricId: 'model.logical_calls', value: row.callCount, unit: 'count',
      state: 'AVAILABLE', completeness: 'UNKNOWN', measurement: 'DERIVED',
      sampleCount: row.callCount, knownCount: row.callCount, cohortBasis: 'entity',
    }),
    metricValue({
      metricId: 'model.observed_transports', value: row.transportAttemptCount, unit: 'count',
      state: 'AVAILABLE', completeness: 'UNKNOWN', measurement: 'DERIVED',
      sampleCount: row.transportAttemptCount, knownCount: row.transportAttemptCount, cohortBasis: 'entity',
    }),
    metricValue({
      metricId: 'tool.calls', value: row.toolCallCount, unit: 'count',
      state: 'AVAILABLE', completeness: 'UNKNOWN', measurement: 'DERIVED',
      sampleCount: row.toolCallCount, knownCount: row.toolCallCount, cohortBasis: 'entity',
    }),
    metricValue({
      metricId: 'model.usage.total_tokens',
      value: usageAgg.total.knownCount ? usageAgg.total.knownSubtotal : null,
      knownSubtotal: usageAgg.total.knownSubtotal, unit: 'tokens',
      state: usageAgg.total.knownCount ? 'AVAILABLE' : 'NO_DATA',
      completeness: usageAgg.usageRowCount ? 'PARTIAL' : 'UNKNOWN', measurement: 'REPORTED',
      sampleCount: usageAgg.usageRowCount, knownCount: usageAgg.total.knownCount,
      unknownCount: usageAgg.usageRowCount - usageAgg.total.knownCount,
      coverageRatio: usageAgg.usageRowCount ? usageAgg.total.knownCount / usageAgg.usageRowCount : null,
      cohortBasis: 'entity', reasonCodes: usageAgg.total.knownCount === 0 ? ['USAGE_NOT_PROVIDED'] : [],
    }),
    metricValue({
      metricId: 'run.duration', value: r.duration_ms, unit: 'ms',
      state: r.duration_ms != null ? 'AVAILABLE' : 'NO_DATA',
      completeness: 'UNKNOWN', measurement: 'MEASURED',
      sampleCount: 1, knownCount: r.duration_ms != null ? 1 : 0,
      unknownCount: r.duration_ms == null ? 1 : 0, cohortBasis: 'entity',
      reasonCodes: r.duration_ms == null ? ['NO_EXACT_DURATION'] : [],
    }),
  ];

  return {
    run: row, task, segments, stats, childRuns,
    delegations: delegations.map((d) => ({
      delegationId: d.delegation_id, childRunId: d.child_run_id, role: d.role,
      requestedAt: d.requested_at, acceptedAt: d.accepted_at, startedAt: d.started_at,
      completedAt: d.completed_at, lifecycle: d.lifecycle, outcome: d.outcome,
    })),
    relationAnomalies: anomalies.filter((a) => a.runId === p.runId || childRuns.some((c) => c.runId === a.runId)),
    excludedRelationCount: includeDescendants
      ? childRuns.filter((c) => c.relationState !== 'VERIFIED').length
      : childRuns.length,
    includeDescendants,
    descendantIds,
  };
}

export function runTimeline(ctx, p) {
  const { db } = ctx;
  const scope = p.scopeId;
  const limit = Math.min(p.limit ?? 2000, 2000);
  const nodes = [];
  const push = (n) => { if (nodes.length < limit) nodes.push(n); };

  const run = one(db, `
    SELECT r.*, ${ENTITY_COLS} FROM obs_run r
    JOIN obs_entity e ON e.scope_id=r.scope_id AND e.entity_id=r.run_id
    WHERE r.scope_id=? AND r.run_id=?`, scope, p.runId);
  if (!run) return null;
  const runCls = classifyEntity(run);
  const allRuns = fetchRunRows(db, scope, {});
  const relationMap = validateRunRelations(allRuns);
  const rel = relationMap.get(p.runId);
  const origin = run.started_at ?? run.registered_at;

  push({
    nodeId: `run:${p.runId}`, kind: 'RUN', entityId: p.runId, parentNodeId: null,
    relationshipState: rel?.relationState ?? 'VERIFIED',
    label: `${run.run_kind} 执行`,
    registeredAt: run.registered_at, startedAt: run.started_at, endedAt: run.ended_at,
    durationMs: run.duration_ms, timingQuality: run.timing_quality,
    lastObservedAt: null, activityState: runCls.activityState,
    lifecycle: run.lifecycle, outcome: run.outcome, nativeStatus: run.native_status,
    resourceSummary: {}, qualityReasons: runCls.qualityReasons, childrenCount: 0,
    detailRef: null,
  });

  const segments = rows(db, `
    SELECT s.segment_id, s.segment_no, e.lifecycle, e.outcome, e.native_status,
           e.registered_at, e.started_at, e.ended_at, e.duration_ms, e.timing_quality
    FROM obs_run_segment s JOIN obs_entity e ON e.scope_id=s.scope_id AND e.entity_id=s.segment_id
    WHERE s.scope_id=? AND s.run_id=? ORDER BY s.segment_no`, scope, p.runId);
  const segNode = new Map();
  for (const s of segments) {
    const c = classifyEntity(s);
    const nodeId = `seg:${s.segment_id}`;
    segNode.set(s.segment_id, nodeId);
    push({
      nodeId, kind: 'RUN_SEGMENT', entityId: s.segment_id, parentNodeId: `run:${p.runId}`,
      relationshipState: 'VERIFIED', label: `Segment ${s.segment_no}`,
      registeredAt: s.registered_at, startedAt: s.started_at, endedAt: s.ended_at,
      durationMs: s.duration_ms, timingQuality: s.timing_quality, lastObservedAt: null,
      activityState: c.activityState, lifecycle: s.lifecycle, outcome: s.outcome,
      nativeStatus: s.native_status, resourceSummary: {}, qualityReasons: c.qualityReasons,
      childrenCount: 0, detailRef: null,
    });
  }
  const parentFor = (segmentId) => (segmentId && segNode.has(segmentId) ? segNode.get(segmentId) : `run:${p.runId}`);

  const steps = rows(db, `
    SELECT s.step_id, s.segment_id, s.step_kind, s.ordinal, s.logical_step_key, s.plan_revision_id,
           e.lifecycle, e.outcome, e.native_status, e.registered_at, e.started_at, e.ended_at, e.duration_ms, e.timing_quality
    FROM obs_step s JOIN obs_entity e ON e.scope_id=s.scope_id AND e.entity_id=s.step_id
    WHERE s.scope_id=? AND s.run_id=? ORDER BY s.ordinal`, scope, p.runId);
  const stepNode = new Map();
  for (const s of steps) {
    const c = classifyEntity(s);
    const nodeId = `step:${s.step_id}`;
    stepNode.set(s.step_id, nodeId);
    push({
      nodeId, kind: 'STEP', entityId: s.step_id, parentNodeId: parentFor(s.segment_id),
      relationshipState: 'VERIFIED', label: s.title_ref ?? `${s.step_kind} · 序${s.ordinal}`,
      registeredAt: s.registered_at, startedAt: s.started_at, endedAt: s.ended_at,
      durationMs: s.duration_ms, timingQuality: s.timing_quality, lastObservedAt: null,
      activityState: c.activityState, lifecycle: s.lifecycle, outcome: s.outcome,
      nativeStatus: s.native_status,
      resourceSummary: { stepKind: s.step_kind, logicalStepKey: s.logical_step_key },
      qualityReasons: c.qualityReasons, childrenCount: 0, detailRef: null,
    });
  }

  const stepAttempts = rows(db, `
    SELECT sa.step_attempt_id, sa.step_id, sa.segment_id, sa.attempt_no,
           e.lifecycle, e.outcome, e.native_status, e.registered_at, e.started_at, e.ended_at, e.duration_ms, e.timing_quality
    FROM obs_step_attempt sa JOIN obs_entity e ON e.scope_id=sa.scope_id AND e.entity_id=sa.step_attempt_id
    WHERE sa.scope_id=? AND sa.step_id IN (SELECT step_id FROM obs_step WHERE scope_id=? AND run_id=?)
    ORDER BY sa.step_id, sa.attempt_no`, scope, scope, p.runId);
  const stepAttemptNode = new Map();
  for (const s of stepAttempts) {
    const c = classifyEntity(s);
    const nodeId = `satt:${s.step_attempt_id}`;
    stepAttemptNode.set(s.step_attempt_id, nodeId);
    push({
      nodeId, kind: 'STEP_ATTEMPT', entityId: s.step_attempt_id,
      parentNodeId: stepNode.get(s.step_id) ?? `run:${p.runId}`,
      relationshipState: 'VERIFIED', label: `尝试 ${s.attempt_no}`,
      registeredAt: s.registered_at, startedAt: s.started_at, endedAt: s.ended_at,
      durationMs: s.duration_ms, timingQuality: s.timing_quality, lastObservedAt: null,
      activityState: c.activityState, lifecycle: s.lifecycle, outcome: s.outcome,
      nativeStatus: s.native_status, resourceSummary: { attemptNo: s.attempt_no },
      qualityReasons: c.qualityReasons, childrenCount: 0, detailRef: null,
    });
  }

  const calls = rows(db, `
    SELECT c.call_id, c.step_attempt_id, c.segment_id, c.purpose, c.requested_model, c.validation_outcome,
           e.lifecycle, e.outcome, e.native_status, e.registered_at, e.started_at, e.ended_at, e.duration_ms, e.timing_quality
    FROM obs_model_call c JOIN obs_entity e ON e.scope_id=c.scope_id AND e.entity_id=c.call_id
    WHERE c.scope_id=? AND c.run_id=? ORDER BY e.registered_at`, scope, p.runId);
  const callNode = new Map();
  for (const cRow of calls) {
    const c = classifyEntity(cRow);
    const nodeId = `call:${cRow.call_id}`;
    callNode.set(cRow.call_id, nodeId);
    push({
      nodeId, kind: 'MODEL_CALL', entityId: cRow.call_id,
      parentNodeId: (cRow.step_attempt_id && stepAttemptNode.get(cRow.step_attempt_id)) ?? parentFor(cRow.segment_id),
      relationshipState: 'VERIFIED', label: `${cRow.purpose} · ${cRow.requested_model ?? '模型未知'}`,
      registeredAt: cRow.registered_at, startedAt: cRow.started_at, endedAt: cRow.ended_at,
      durationMs: cRow.duration_ms, timingQuality: cRow.timing_quality, lastObservedAt: null,
      activityState: c.activityState, lifecycle: cRow.lifecycle, outcome: cRow.outcome,
      nativeStatus: cRow.native_status,
      resourceSummary: { purpose: cRow.purpose, requestedModel: cRow.requested_model, validationOutcome: cRow.validation_outcome },
      qualityReasons: c.qualityReasons, childrenCount: 0,
      detailRef: `/models?callId=${cRow.call_id}`,
    });
  }

  const attempts = rows(db, `
    SELECT a.*, e.lifecycle, e.outcome, e.native_status, e.registered_at, e.started_at, e.ended_at, e.duration_ms, e.timing_quality,
           u.input_tokens, u.output_tokens, u.reasoning_tokens, u.total_tokens
    FROM obs_model_attempt a
    JOIN obs_entity e ON e.scope_id=a.scope_id AND e.entity_id=a.attempt_id
    LEFT JOIN obs_model_usage u ON u.scope_id=a.scope_id AND u.attempt_id=a.attempt_id
    WHERE a.scope_id=? AND a.call_id IN (SELECT call_id FROM obs_model_call WHERE scope_id=? AND run_id=?)
    ORDER BY a.transport_attempt_no`, scope, scope, p.runId);
  for (const a of attempts) {
    const c = classifyEntity(a);
    const markers = [];
    const base = a.started_at ?? a.registered_at;
    for (const [field, kind, label] of [
      ['first_response_ms', 'FIRST_RESPONSE', '首响应'],
      ['first_answer_delta_ms', 'FIRST_ANSWER', '首答案片段'],
      ['first_reasoning_delta_ms', 'FIRST_REASONING', '首思考片段'],
    ]) {
      const v = a[field];
      if (v != null && v >= 0) {
        markers.push({ kind, atMs: base + v, label });
        if (a.ended_at != null && base + v > a.ended_at + 60_000) {
          c.qualityReasons.push('MARKER_OUT_OF_RANGE');
        }
      }
    }
    push({
      nodeId: `att:${a.attempt_id}`, kind: 'MODEL_ATTEMPT', entityId: a.attempt_id,
      parentNodeId: callNode.get(a.call_id) ?? `run:${p.runId}`,
      relationshipState: 'VERIFIED',
      label: `Attempt ${a.transport_attempt_no} · ${a.resolved_model ?? a.requested_model ?? '?'}`,
      registeredAt: a.registered_at, startedAt: a.started_at, endedAt: a.ended_at,
      durationMs: a.duration_ms, timingQuality: a.timing_quality, lastObservedAt: null,
      activityState: c.activityState, lifecycle: a.lifecycle, outcome: a.outcome,
      nativeStatus: a.native_status,
      resourceSummary: {
        providerId: a.provider_id, resolvedModel: a.resolved_model,
        httpStatus: a.http_status, transportOutcome: a.transport_outcome,
        failureClass: a.failure_class, visibility: a.visibility,
        dispatchState: a.dispatch_state, backoffBeforeMs: a.backoff_before_ms,
        inputTokens: a.input_tokens, outputTokens: a.output_tokens,
        reasoningTokens: a.reasoning_tokens, totalTokens: a.total_tokens,
      },
      qualityReasons: c.qualityReasons, childrenCount: 0,
      detailRef: `/models/attempts/${a.attempt_id}`, markers,
    });
  }

  const tools = rows(db, `
    SELECT t.*, e.lifecycle, e.outcome, e.native_status, e.registered_at, e.started_at, e.ended_at, e.duration_ms, e.timing_quality
    FROM obs_tool_call t JOIN obs_entity e ON e.scope_id=t.scope_id AND e.entity_id=t.tool_call_id
    WHERE t.scope_id=? AND t.run_id=? ORDER BY e.registered_at`, scope, p.runId);
  const toolNode = new Map();
  const unowned = [];
  for (const t of tools) {
    const c = classifyEntity(t);
    const nodeId = `tool:${t.tool_call_id}`;
    toolNode.set(t.tool_call_id, nodeId);
    const parent = (t.step_attempt_id && stepAttemptNode.get(t.step_attempt_id))
      ?? (t.origin_model_call_id && callNode.get(t.origin_model_call_id))
      ?? null;
    const n = {
      nodeId, kind: 'TOOL_CALL', entityId: t.tool_call_id,
      parentNodeId: parent ?? `run:${p.runId}`,
      relationshipState: 'VERIFIED',
      label: t.canonical_tool_name ?? t.requested_tool_name ?? '工具',
      registeredAt: t.registered_at, startedAt: t.started_at, endedAt: t.ended_at,
      durationMs: t.duration_ms, timingQuality: t.timing_quality, lastObservedAt: null,
      activityState: c.activityState, lifecycle: t.lifecycle, outcome: t.outcome,
      nativeStatus: t.native_status,
      resourceSummary: {
        canonicalToolName: t.canonical_tool_name, requestedToolName: t.requested_tool_name,
        resultBytes: t.result_bytes, argumentsBytes: t.arguments_bytes,
        failureClass: t.failure_class, unowned: parent == null,
      },
      qualityReasons: c.qualityReasons, childrenCount: 0, detailRef: null,
    };
    push(n);
    if (parent == null) unowned.push(nodeId);
  }

  if (hasTableCtx(db, 'obs_command')) {
    const commands = rows(db, `
      SELECT c.*, e.lifecycle, e.outcome, e.native_status, e.registered_at, e.started_at, e.ended_at, e.duration_ms, e.timing_quality
      FROM obs_command c JOIN obs_entity e ON e.scope_id=c.scope_id AND e.entity_id=c.command_id
      WHERE c.scope_id=? AND c.run_id=? ORDER BY e.registered_at`, scope, p.runId);
    const cmdNode = new Map();
    for (const cmd of commands) {
      const c = classifyEntity(cmd);
      const parent = (cmd.tool_call_id && toolNode.get(cmd.tool_call_id))
        ?? (cmd.parent_command_id && cmdNode.get(cmd.parent_command_id))
        ?? `run:${p.runId}`;
      const nodeId = `cmd:${cmd.command_id}`;
      cmdNode.set(cmd.command_id, nodeId);
      push({
        nodeId, kind: 'COMMAND', entityId: cmd.command_id, parentNodeId: parent,
        relationshipState: 'VERIFIED',
        label: `${cmd.executable_family ?? '命令'}${cmd.subcommand_key ? ' ' + cmd.subcommand_key : ''}`,
        registeredAt: cmd.registered_at, startedAt: cmd.started_at, endedAt: cmd.ended_at,
        durationMs: cmd.duration_ms, timingQuality: cmd.timing_quality, lastObservedAt: null,
        activityState: c.activityState, lifecycle: cmd.lifecycle, outcome: cmd.outcome,
        nativeStatus: cmd.native_status,
        resourceSummary: {
          originKind: cmd.origin_kind, executableFamily: cmd.executable_family,
          exitCode: cmd.exit_code, stdoutBytes: cmd.stdout_bytes, stderrBytes: cmd.stderr_bytes,
          failureClass: cmd.failure_class,
        },
        qualityReasons: c.qualityReasons, childrenCount: 0, detailRef: null,
      });
    }
  }

  if (hasTableCtx(db, 'obs_delegation')) {
    const dels = rows(db, `
      SELECT d.*, e.lifecycle, e.outcome, e.native_status, e.registered_at, e.started_at, e.ended_at
      FROM obs_delegation d JOIN obs_entity e ON e.scope_id=d.scope_id AND e.entity_id=d.delegation_id
      WHERE d.scope_id=? AND d.parent_run_id=?`, scope, p.runId);
    for (const d of dels) {
      const c = classifyEntity(d);
      push({
        nodeId: `dlg:${d.delegation_id}`, kind: 'DELEGATION', entityId: d.delegation_id,
        parentNodeId: `run:${p.runId}`, relationshipState: 'VERIFIED',
        label: `委派${d.role ? ' · ' + d.role : ''}`,
        registeredAt: d.registered_at, startedAt: d.started_at, endedAt: d.completed_at ?? d.ended_at,
        durationMs: null, timingQuality: null, lastObservedAt: null,
        activityState: c.activityState, lifecycle: d.lifecycle, outcome: d.outcome,
        nativeStatus: d.native_status,
        resourceSummary: { role: d.role, childRunId: d.child_run_id, requestedAt: d.requested_at, acceptedAt: d.accepted_at },
        qualityReasons: c.qualityReasons, childrenCount: 0, detailRef: null,
      });
    }
  }

  // childrenCount on parents.
  const childCount = new Map();
  for (const n of nodes) {
    if (n.parentNodeId) childCount.set(n.parentNodeId, (childCount.get(n.parentNodeId) ?? 0) + 1);
  }
  for (const n of nodes) n.childrenCount = childCount.get(n.nodeId) ?? 0;

  return {
    runId: p.runId, originAt: origin, nodes,
    truncated: nodes.length >= limit,
    relationAnomalies: rel?.anomalies?.length ? [{ runId: p.runId, reason: rel.anomalies.join(',') }] : [],
  };
}

// ---------- run facts (per-kind detail tables) ----------

const FACT_QUERIES = {
  steps: `SELECT s.*, e.lifecycle, e.outcome, e.native_status, e.registered_at, e.started_at, e.ended_at, e.duration_ms
          FROM obs_step s JOIN obs_entity e ON e.scope_id=s.scope_id AND e.entity_id=s.step_id
          WHERE s.scope_id=? AND s.run_id=? ORDER BY s.ordinal`,
  stepAttempts: `SELECT sa.*, e.lifecycle, e.outcome, e.registered_at, e.started_at, e.ended_at, e.duration_ms
          FROM obs_step_attempt sa JOIN obs_entity e ON e.scope_id=sa.scope_id AND e.entity_id=sa.step_attempt_id
          WHERE sa.scope_id=? AND sa.step_id IN (SELECT step_id FROM obs_step WHERE scope_id=? AND run_id=?) ORDER BY sa.step_id, sa.attempt_no`,
  calls: `SELECT c.*, e.lifecycle, e.outcome, e.native_status, e.registered_at, e.started_at, e.ended_at, e.duration_ms
          FROM obs_model_call c JOIN obs_entity e ON e.scope_id=c.scope_id AND e.entity_id=c.call_id
          WHERE c.scope_id=? AND c.run_id=? ORDER BY e.registered_at`,
  attempts: `SELECT a.*, e.lifecycle, e.outcome, e.registered_at, e.started_at, e.ended_at, e.duration_ms
          FROM obs_model_attempt a JOIN obs_entity e ON e.scope_id=a.scope_id AND e.entity_id=a.attempt_id
          WHERE a.scope_id=? AND a.call_id IN (SELECT call_id FROM obs_model_call WHERE scope_id=? AND run_id=?)
          ORDER BY a.call_id, a.transport_attempt_no`,
  tools: `SELECT t.*, e.lifecycle, e.outcome, e.registered_at, e.started_at, e.ended_at, e.duration_ms
          FROM obs_tool_call t JOIN obs_entity e ON e.scope_id=t.scope_id AND e.entity_id=t.tool_call_id
          WHERE t.scope_id=? AND t.run_id=? ORDER BY e.registered_at`,
  commands: `SELECT c.*, e.lifecycle, e.outcome, e.registered_at, e.started_at, e.ended_at, e.duration_ms
          FROM obs_command c JOIN obs_entity e ON e.scope_id=c.scope_id AND e.entity_id=c.command_id
          WHERE c.scope_id=? AND c.run_id=? ORDER BY e.registered_at`,
  segments: `SELECT s.*, e.lifecycle, e.outcome, e.registered_at, e.started_at, e.ended_at
          FROM obs_run_segment s JOIN obs_entity e ON e.scope_id=s.scope_id AND e.entity_id=s.segment_id
          WHERE s.scope_id=? AND s.run_id=? ORDER BY s.segment_no`,
  delegations: `SELECT d.*, e.lifecycle, e.outcome, e.registered_at
          FROM obs_delegation d JOIN obs_entity e ON e.scope_id=d.scope_id AND e.entity_id=d.delegation_id
          WHERE d.scope_id=? AND d.parent_run_id=?`,
  events: `SELECT event_id, entity_id, entity_kind, entity_revision, event_type, occurred_at, recorded_at
          FROM obs_event WHERE scope_id=? AND root_entity_id IN (SELECT ?) `,
};

export function runFacts(ctx, p) {
  const { db } = ctx;
  const scope = p.scopeId;
  const kind = p.kind;
  let sql;
  let args;
  if (kind === 'events') {
    sql = `SELECT ev.event_id, ev.entity_id, ev.entity_kind, ev.entity_revision, ev.event_type,
                  ev.occurred_at, ev.recorded_at
           FROM obs_event ev WHERE ev.scope_id=? AND ev.entity_id IN (
             SELECT entity_id FROM obs_entity WHERE scope_id=? AND (root_run_id=? OR entity_id=?))
           ORDER BY ev.recorded_at`;
    args = [scope, scope, p.runId, p.runId];
  } else if (kind === 'issues') {
    sql = `SELECT * FROM obs_registration_issue WHERE scope_id=? AND entity_id IN (
             SELECT entity_id FROM obs_entity WHERE scope_id=? AND (root_run_id=? OR entity_id=?))
           ORDER BY last_seen_at DESC`;
    args = [scope, scope, p.runId, p.runId];
  } else {
    sql = FACT_QUERIES[kind];
    if (!sql) return null;
    args = kind === 'stepAttempts' || kind === 'attempts' ? [scope, scope, p.runId] : [scope, p.runId];
  }
  const all = rows(db, sql, ...args);
  const offset = p.cursorData?.sortValues?.[0] ?? 0;
  const sliced = all.slice(offset, offset + p.limit);
  return {
    rows: sliced,
    hasMore: offset + p.limit < all.length,
    lastSortValue: offset + sliced.length,
    lastId: String(offset + sliced.length),
    total: all.length,
  };
}

// ---------- analytics: models ----------

export function analyticsModels(ctx, p) {
  const { db } = ctx;
  const scope = p.scopeId;
  const { from, to, timezone, grain } = p;
  const f = p.filters;
  const cond = ['a.scope_id = ?'];
  const args = [scope];
  if (f.provider) { cond.push('a.provider_id = ?'); args.push(f.provider); }
  if (f.model) { cond.push('(a.resolved_model = ? OR a.requested_model = ?)'); args.push(f.model, f.model); }
  const attemptRows = rows(db, `
    SELECT a.*, e.lifecycle, e.outcome, e.native_status, e.registered_at, e.started_at, e.ended_at, e.duration_ms,
           c.purpose, c.run_id,
           u.input_tokens, u.output_tokens, u.reasoning_tokens, u.total_tokens,
           u.input_coverage, u.reasoning_relation, u.total_source,
           u.cache_read_input_tokens, u.cache_write_input_tokens
    FROM obs_model_attempt a
    JOIN obs_entity e ON e.scope_id=a.scope_id AND e.entity_id=a.attempt_id
    JOIN obs_model_call c ON c.scope_id=a.scope_id AND c.call_id=a.call_id
    LEFT JOIN obs_model_usage u ON u.scope_id=a.scope_id AND u.attempt_id=a.attempt_id
    WHERE ${cond.join(' AND ')}`, ...args);
  if (f.purpose) {
    const keep = new Set(rows(db, `SELECT call_id FROM obs_model_call WHERE scope_id=? AND purpose=?`, scope, f.purpose).map((r) => r.call_id));
    for (let i = attemptRows.length - 1; i >= 0; i--) if (!keep.has(attemptRows[i].call_id)) attemptRows.splice(i, 1);
  }
  const inWin = attemptRows.filter((r) => {
    const t = r.started_at ?? r.registered_at;
    return t >= from && t < to;
  });
  const usageAgg = aggregateUsage(inWin);
  const callIdsInWin = new Set(inWin.map((r) => r.call_id));
  const callsCreated = rows(db, `
    SELECT c.call_id, e.registered_at, e.lifecycle, e.outcome, e.native_status
    FROM obs_model_call c JOIN obs_entity e ON e.scope_id=c.scope_id AND e.entity_id=c.call_id
    WHERE c.scope_id=? AND e.registered_at>=? AND e.registered_at<?`, scope, from, to);
  const retry = retryStatsForCalls(db, scope, callsCreated.map((r) => r.call_id));

  const cache = cacheReadShare(inWin);

  const lat = (field) => {
    const vals = inWin.map((r) => r[field]).filter((v) => v != null && v >= 0).sort((a, b) => a - b);
    return { sampleCount: vals.length, p50: quantile(vals, 0.5), p95: quantile(vals, 0.95), max: vals.length ? vals[vals.length - 1] : null, smallSample: vals.length < 20 };
  };

  const identity = { same: 0, different: 0, unknown: 0 };
  for (const r of inWin) {
    const req = r.requested_model, res = r.response_model ?? r.resolved_model;
    if (req == null || res == null) identity.unknown += 1;
    else if (req === res) identity.same += 1;
    else identity.different += 1;
  }

  const errMap = new Map();
  for (const r of inWin) {
    const key = r.http_status != null ? `HTTP ${r.http_status}` : (r.failure_class ?? (r.transport_outcome ?? null));
    if (key == null) continue;
    if (isTransportSuccessOutcome(r.transport_outcome)) continue;
    errMap.set(key, (errMap.get(key) ?? 0) + 1);
  }

  const bounds = bucketBoundaries(from, to, grain, timezone);
  const tokenTrend = bounds.slice(0, -1).map((b) => ({ bucketStart: b, input: null, output: null, reasoning: null, total: null, usageRows: 0 }));
  const byBucket = new Map();
  for (const r of inWin) {
    const i = bucketIndex(r.started_at ?? r.registered_at, bounds);
    if (i < 0) continue;
    if (!byBucket.has(i)) byBucket.set(i, []);
    byBucket.get(i).push(r);
  }
  for (const [i, list] of byBucket) {
    const b = usageBucket(list);
    Object.assign(tokenTrend[i], { input: b.input, output: b.output, reasoning: b.reasoning, total: b.total, usageRows: b.sampleCount });
  }

  const perModel = new Map();
  for (const r of inWin) {
    const key = `${r.provider_id ?? ''}|${r.resolved_model ?? r.requested_model ?? '(未知)'}`;
    if (!perModel.has(key)) perModel.set(key, { providerId: r.provider_id, model: r.resolved_model ?? r.requested_model, rows: [] });
    perModel.get(key).rows.push(r);
  }
  const modelTable = [...perModel.values()].map((m) => {
    const u = aggregateUsage(m.rows);
    const clsRows = m.rows.map((r) => classifyEntity(r));
    const term = m.rows.filter((r, i) => clsRows[i].isTrustedTerminal);
    const outcome = completedOutcomeStats(term);
    const durs = m.rows.map((r) => r.duration_ms).filter((v) => v != null && v >= 0).sort((a, b) => a - b);
    const callIds = new Set(m.rows.map((r) => r.call_id));
    return {
      providerId: m.providerId, resolvedModel: m.model,
      attemptCount: m.rows.length, callCount: callIds.size,
      transportSuccessRate: transportSuccess(m.rows),
      durationP95: quantile(durs, 0.95), durationSamples: durs.length,
      knownTotalTokens: u.total.knownCount ? u.total.knownSubtotal : null,
      usageKnownCount: u.total.knownCount, usageRows: u.usageRowCount,
      cacheReadShare: cacheReadShare(m.rows).cacheReadShare,
      retriedShare: m.rows.length
        ? m.rows.filter((r) => (r.transport_attempt_no ?? 1) > 1).length / m.rows.length
        : null,
      outcomeStats: { succeeded: outcome.succeeded, failed: outcome.failed, timedOut: outcome.timedOut, excluded: outcome.excluded },
    };
  }).sort((a, b) => b.attemptCount - a.attemptCount);

  return {
    kpis: [
      metricValue({
        metricId: 'model.logical_calls', value: callsCreated.length, unit: 'count',
        state: 'AVAILABLE', completeness: 'UNKNOWN', measurement: 'DERIVED',
        sampleCount: callsCreated.length, knownCount: callsCreated.length, cohortBasis: 'registered_at',
      }),
      metricValue({
        metricId: 'model.observed_transports', value: retry.observedTransports, unit: 'count',
        state: 'AVAILABLE', completeness: 'UNKNOWN', measurement: 'DERIVED',
        sampleCount: retry.observedTransports, knownCount: retry.observedTransports, cohortBasis: 'call registered_at',
        reasonCodes: ['OBSERVED_LOWER_BOUND'],
      }),
      metricValue({
        metricId: 'model.extra_attempts', value: retry.extraObservedAttempts, unit: 'count',
        state: 'AVAILABLE', completeness: 'UNKNOWN', measurement: 'DERIVED',
        sampleCount: retry.extraObservedAttempts, knownCount: retry.extraObservedAttempts, cohortBasis: 'call registered_at',
      }),
      metricValue({
        metricId: 'model.retry_call_rate', value: retry.retryCallRate, unit: 'ratio',
        state: retry.retryCallRate != null ? 'AVAILABLE' : 'NO_DATA',
        completeness: 'UNKNOWN', measurement: 'DERIVED',
        numerator: retry.retriedCalls, denominator: retry.dispatchedCalls,
        sampleCount: retry.logicalCalls, knownCount: retry.dispatchedCalls, cohortBasis: 'call registered_at',
      }),
      metricValue({
        metricId: 'model.usage.total_tokens',
        value: usageAgg.total.knownCount ? usageAgg.total.knownSubtotal : null,
        knownSubtotal: usageAgg.total.knownSubtotal, unit: 'tokens',
        state: usageAgg.total.knownCount ? 'AVAILABLE' : 'NO_DATA',
        completeness: usageAgg.usageRowCount ? 'PARTIAL' : 'UNKNOWN', measurement: 'REPORTED',
        sampleCount: usageAgg.usageRowCount, knownCount: usageAgg.total.knownCount,
        unknownCount: usageAgg.usageRowCount - usageAgg.total.knownCount,
        coverageRatio: usageAgg.usageRowCount ? usageAgg.total.knownCount / usageAgg.usageRowCount : null,
        cohortBasis: 'attempt started_at', reasonCodes: usageAgg.total.knownCount === 0 ? ['USAGE_NOT_PROVIDED'] : [],
      }),
      metricValue({
        metricId: 'model.usage.coverage', value: usageAgg.usageRowCount ? usageAgg.total.knownCount / usageAgg.usageRowCount : null,
        unit: 'ratio', state: usageAgg.usageRowCount ? 'AVAILABLE' : 'NO_DATA',
        completeness: 'UNKNOWN', measurement: 'DERIVED',
        numerator: usageAgg.total.knownCount, denominator: usageAgg.usageRowCount,
        sampleCount: inWin.length, knownCount: usageAgg.usageRowCount, cohortBasis: 'attempt started_at',
      }),
    ],
    tokenTrend, topModels: topModelRows(db, scope, { from, to }),
    modelTable,
    latency: {
      firstResponse: lat('first_response_ms'),
      firstAnswerDelta: lat('first_answer_delta_ms'),
      firstReasoningDelta: lat('first_reasoning_delta_ms'),
      fullDuration: lat('duration_ms'),
    },
    identity,
    errors: [...errMap.entries()].map(([key, count]) => ({ key, count })).sort((a, b) => b.count - a.count).slice(0, 12),
    cache,
    visibilityBreakdown: {
      transportAttempt: inWin.filter((r) => r.visibility === VISIBILITY.TRANSPORT_ATTEMPT).length,
      portCallOnly: inWin.filter((r) => r.visibility === VISIBILITY.PORT_CALL_ONLY).length,
      intentOrUnknown: inWin.filter((r) => [DISPATCH_STATE.INTENT, DISPATCH_STATE.UNKNOWN].includes(r.dispatch_state)).length,
    },
  };
}

const TRANSPORT_SUCCESS_OUTCOMES = new Set(['COMPLETED', 'SUCCEEDED', 'SUCCESS']);
const TRANSPORT_KNOWN_OUTCOMES = new Set([
  ...TRANSPORT_SUCCESS_OUTCOMES, 'FAILED', 'TIMED_OUT', 'CANCELLED', 'REJECTED',
]);

function isTransportSuccessOutcome(value) {
  return TRANSPORT_SUCCESS_OUTCOMES.has(value);
}

export function transportSuccess(attemptRows) {
  let known = 0, ok = 0;
  for (const r of attemptRows) {
    const t = r.transport_outcome;
    if (t == null) continue;
    if (!TRANSPORT_KNOWN_OUTCOMES.has(t)) continue;
    known += 1;
    if (isTransportSuccessOutcome(t)) ok += 1;
  }
  return known ? { rate: ok / known, known } : { rate: null, known: 0 };
}

export function listModelAttempts(ctx, p) {
  const { db } = ctx;
  const scope = p.scopeId;
  const f = p.filters;
  const cond = ['a.scope_id = ?'];
  const args = [scope];
  if (f.provider) { cond.push('a.provider_id = ?'); args.push(f.provider); }
  if (f.model) { cond.push('(a.resolved_model = ? OR a.requested_model = ?)'); args.push(f.model, f.model); }
  if (f.failureClass) { cond.push('a.failure_class = ?'); args.push(f.failureClass); }
  if (f.hasUsage === 'true') cond.push('u.total_tokens IS NOT NULL');
  if (f.hasUsage === 'false') cond.push('u.total_tokens IS NULL');
  if (f.runId) { cond.push('c.run_id = ?'); args.push(f.runId); }
  if (f.callId) { cond.push('a.call_id = ?'); args.push(f.callId); }
  if (f.retried === 'true') cond.push('a.transport_attempt_no > 1');
  if (f.retried === 'false') cond.push('a.transport_attempt_no <= 1');
  // Run-attribute filters (reachable via exportAnalytics; the list route does not declare them).
  const rcond = [];
  const rargs = [];
  if (f.product) { rcond.push('product_name = ?'); rargs.push(f.product); }
  if (f.runKind) { rcond.push('run_kind = ?'); rargs.push(f.runKind); }
  if (f.configRevision) { rcond.push('config_revision = ?'); rargs.push(f.configRevision); }
  if (rcond.length) {
    cond.push(`c.run_id IN (SELECT run_id FROM obs_run WHERE scope_id = a.scope_id AND ${rcond.join(' AND ')})`);
    args.push(...rargs);
  }
  if (p.from != null) { cond.push('COALESCE(e.started_at, e.registered_at) >= ?'); args.push(p.from); }
  if (p.to != null) { cond.push('COALESCE(e.started_at, e.registered_at) < ?'); args.push(p.to); }
  if (p.cursorData) {
    const [v] = p.cursorData.sortValues;
    pushKeyset(cond, args, 'COALESCE(e.started_at, e.registered_at)', 'a.attempt_id', 'DESC', v, p.cursorData.entityId);
  }
  const fetched = rows(db, `
    SELECT a.attempt_id, a.call_id, c.run_id, a.provider_id, a.requested_model, a.resolved_model, a.response_model,
           a.router_id, a.visibility, a.dispatch_state, a.transport_outcome, a.http_status, a.failure_class,
           a.product_attempt_no, a.route_attempt_no, a.transport_attempt_no,
           a.first_response_ms, a.first_answer_delta_ms, a.first_reasoning_delta_ms,
           e.lifecycle, e.outcome, e.native_status, e.registered_at, e.started_at, e.ended_at, e.duration_ms,
           u.input_tokens, u.output_tokens, u.reasoning_tokens, u.total_tokens, u.input_coverage
    FROM obs_model_attempt a
    JOIN obs_entity e ON e.scope_id=a.scope_id AND e.entity_id=a.attempt_id
    JOIN obs_model_call c ON c.scope_id=a.scope_id AND c.call_id=a.call_id
    LEFT JOIN obs_model_usage u ON u.scope_id=a.scope_id AND u.attempt_id=a.attempt_id
    WHERE ${cond.join(' AND ')}
    ORDER BY COALESCE(e.started_at, e.registered_at) DESC, a.attempt_id DESC
    LIMIT ?`, ...args, p.limit + 1);
  const hasMore = fetched.length > p.limit;
  const pageRows = fetched.slice(0, p.limit);
  const last = pageRows[pageRows.length - 1];
  return {
    rows: pageRows.map((r) => ({
      ...r,
      activityState: classifyEntity(r).activityState,
      qualityReasons: classifyEntity(r).qualityReasons,
    })),
    hasMore,
    lastSortValue: last ? (last.started_at ?? last.registered_at) : null,
    lastId: last?.attempt_id ?? null,
  };
}

export function modelAttemptDetail(ctx, p) {
  const { db } = ctx;
  const scope = p.scopeId;
  const a = one(db, `
    SELECT a.*, e.lifecycle, e.outcome, e.native_status, e.registered_at, e.started_at, e.ended_at, e.duration_ms, e.timing_quality,
           c.run_id, c.purpose, c.step_attempt_id, c.context_id, c.request_revision, c.validation_outcome AS call_validation,
           u.input_tokens, u.output_tokens, u.reasoning_tokens, u.total_tokens,
           u.uncached_input_tokens, u.cache_read_input_tokens, u.cache_write_input_tokens,
           u.input_coverage, u.reasoning_relation, u.total_source, u.measurement_source, u.usage_revision, u.reported_at
    FROM obs_model_attempt a
    JOIN obs_entity e ON e.scope_id=a.scope_id AND e.entity_id=a.attempt_id
    JOIN obs_model_call c ON c.scope_id=a.scope_id AND c.call_id=a.call_id
    LEFT JOIN obs_model_usage u ON u.scope_id=a.scope_id AND u.attempt_id=a.attempt_id
    WHERE a.scope_id=? AND a.attempt_id=?`, scope, p.attemptId);
  if (!a) return null;
  const ctxRow = a.context_id && hasTableCtx(db, 'obs_context_snapshot')
    ? one(db, 'SELECT * FROM obs_context_snapshot WHERE scope_id=? AND context_id=?', scope, a.context_id)
    : null;
  const reasoning = hasTableCtx(db, 'obs_reasoning_output')
    ? one(db, 'SELECT * FROM obs_reasoning_output WHERE scope_id=? AND attempt_id=?', scope, p.attemptId)
    : null;
  const costs = hasTableCtx(db, 'obs_cost_observation')
    ? latestCostRevisions(rows(db, 'SELECT * FROM obs_cost_observation WHERE scope_id=? AND attempt_id=?', scope, p.attemptId))
    : [];
  const siblings = rows(db, `
    SELECT attempt_id, transport_attempt_no, dispatch_state, transport_outcome, http_status
    FROM obs_model_attempt WHERE scope_id=? AND call_id=? ORDER BY transport_attempt_no`, scope, a.call_id);
  return {
    attempt: a,
    state: classifyEntity(a),
    usage: {
      inputTokens: a.input_tokens, outputTokens: a.output_tokens, reasoningTokens: a.reasoning_tokens,
      totalTokens: a.total_tokens, uncachedInputTokens: a.uncached_input_tokens,
      cacheReadInputTokens: a.cache_read_input_tokens, cacheWriteInputTokens: a.cache_write_input_tokens,
      inputCoverage: a.input_coverage, reasoningRelation: a.reasoning_relation,
      totalSource: a.total_source, measurementSource: a.measurement_source,
      usageRevision: a.usage_revision, reportedAt: a.reported_at,
    },
    context: ctxRow,
    reasoning: reasoning ? {
      integrationState: reasoning.integration_state, outputMode: reasoning.output_mode,
      status: reasoning.status, blockCount: reasoning.block_count,
      observedTextBytes: reasoning.observed_text_bytes, captureState: reasoning.capture_state,
      label: '可见推理输出',
    } : null,
    costs, siblingAttempts: siblings,
  };
}

// ---------- analytics: context ----------

export function analyticsContext(ctx, p) {
  const { db } = ctx;
  const scope = p.scopeId;
  const f = p.filters ?? {};
  if (!hasTableCtx(db, 'obs_context_snapshot')) {
    return { capability: 'SCHEMA_MISSING', snapshots: [], components: [], transforms: [], pressure: null };
  }
  const snaps = rows(db, `
    SELECT s.*, e.registered_at, e.started_at, c.run_id, c.requested_model
    FROM obs_context_snapshot s
    JOIN obs_entity e ON e.scope_id=s.scope_id AND e.entity_id=s.context_id
    LEFT JOIN obs_model_call c ON c.scope_id=s.scope_id AND c.context_id=s.context_id
    WHERE s.scope_id=? AND e.registered_at>=? AND e.registered_at<?
    ${f.requestRevision ? 'AND CAST(s.request_revision AS TEXT) = ?' : ''}`,
    scope, p.from, p.to, ...(f.requestRevision ? [f.requestRevision] : []));
  const withPressure = snaps.filter((s) => s.input_tokens_estimated != null && s.usable_input_tokens != null && s.usable_input_tokens > 0);
  const pressure = withPressure.map((s) => ({
    contextId: s.context_id, runId: s.run_id,
    windowRatio: s.window_tokens ? s.input_tokens_estimated / s.window_tokens : null,
    budgetRatio: s.input_tokens_estimated / s.usable_input_tokens,
    estimated: s.input_tokens_estimated, window: s.window_tokens, usable: s.usable_input_tokens,
    estimateQuality: s.estimate_quality,
  })).sort((a, b) => (b.budgetRatio ?? 0) - (a.budgetRatio ?? 0));

  const compCond = [];
  const compArgs = [];
  if (f.partition) { compCond.push('cc.partition_id = ?'); compArgs.push(f.partition); }
  if (f.basis) { compCond.push('cc.measurement_basis = ?'); compArgs.push(f.basis); }
  if (f.unit) { compCond.push('cc.unit = ?'); compArgs.push(f.unit); }
  const components = hasTableCtx(db, 'obs_context_component') ? rows(db, `
    SELECT cc.context_id, cc.component_key, cc.component_kind, cc.measurement_basis, cc.unit,
           cc.measured_value, cc.partition_id, cc.quality, cc.source_ref
    FROM obs_context_component cc
    WHERE cc.scope_id=? AND cc.context_id IN (${snaps.map(() => '?').join(',') || 'NULL'})
    ${compCond.length ? `AND ${compCond.join(' AND ')}` : ''}`,
    scope, ...snaps.map((s) => s.context_id), ...compArgs) : [];

  const transforms = hasTableCtx(db, 'obs_context_transform') ? rows(db, `
    SELECT t.*, e.registered_at FROM obs_context_transform t
    JOIN obs_entity e ON e.scope_id=t.scope_id AND e.entity_id=t.transform_id
    WHERE t.scope_id=? AND e.registered_at>=? AND e.registered_at<?`, scope, p.from, p.to) : [];

  const riskList = snaps.map((s) => ({
    contextId: s.context_id, runId: s.run_id,
    budgetRemaining: s.usable_input_tokens != null && s.input_tokens_estimated != null
      ? s.usable_input_tokens - s.input_tokens_estimated : null,
    largestMessageUnits: s.largest_message_utf16_units,
    toolSchemaCount: s.tool_schema_count,
    budgetRatio: s.usable_input_tokens ? (s.input_tokens_estimated ?? 0) / s.usable_input_tokens : null,
  })).sort((a, b) => (a.budgetRemaining ?? Infinity) - (b.budgetRemaining ?? Infinity)).slice(0, 10);

  return {
    capability: snaps.length ? 'AVAILABLE' : 'NO_DATA',
    snapshotCount: snaps.length,
    pressure,
    components,
    transforms: transforms.map((t) => ({
      transformId: t.transform_id, transformKind: t.transform_kind, reasonCode: t.reason_code,
      beforeEstimate: t.before_estimate, afterEstimate: t.after_estimate,
      removedMessages: t.removed_messages, runId: t.run_id, registeredAt: t.registered_at,
      delta: t.before_estimate != null && t.after_estimate != null ? t.after_estimate - t.before_estimate : null,
    })),
    riskList,
    note: 'Token 数与字节数不混合；组成图按 partition+unit 分组展示。',
  };
}

// ---------- analytics: tools ----------

export function analyticsTools(ctx, p) {
  const { db } = ctx;
  const scope = p.scopeId;
  const f = p.filters ?? {};
  const toolRows = rows(db, `
    SELECT t.*, e.lifecycle, e.outcome, e.native_status, e.registered_at, e.started_at, e.ended_at, e.duration_ms
    FROM obs_tool_call t JOIN obs_entity e ON e.scope_id=t.scope_id AND e.entity_id=t.tool_call_id
    WHERE t.scope_id=? AND e.registered_at>=? AND e.registered_at<?
    ${f.tool ? 'AND (t.canonical_tool_name = ? OR t.requested_tool_name = ?)' : ''}`,
    scope, p.from, p.to, ...(f.tool ? [f.tool, f.tool] : []));
  const byTool = new Map();
  for (const t of toolRows) {
    const key = t.canonical_tool_name ?? t.requested_tool_name ?? '(未命名)';
    if (!byTool.has(key)) byTool.set(key, []);
    byTool.get(key).push(t);
  }
  const toolTable = [...byTool.entries()].map(([name, list]) => {
    const outcome = completedOutcomeStats(list);
    const durs = list.map((r) => r.duration_ms).filter((v) => v != null && v >= 0).sort((a, b) => a - b);
    const resultBytes = list.map((r) => r.result_bytes).filter((v) => v != null && v >= 0).sort((a, b) => a - b);
    return {
      canonicalToolName: name,
      callCount: list.length,
      successRate: outcome.denominator ? outcome.succeeded / outcome.denominator : null,
      succeeded: outcome.succeeded, failed: outcome.failed, timedOut: outcome.timedOut,
      terminalKnown: outcome.allKnownTerminal, excluded: outcome.excluded,
      durationP50: quantile(durs, 0.5), durationP95: quantile(durs, 0.95), durationSamples: durs.length,
      resultBytesTotal: resultBytes.reduce((a, b) => a + b, 0) || (resultBytes.length ? 0 : null),
      resultBytesMedian: quantile(resultBytes, 0.5), resultBytesSamples: resultBytes.length,
      requestedNames: [...new Set(list.map((r) => r.requested_tool_name).filter(Boolean))],
    };
  }).sort((a, b) => b.callCount - a.callCount);

  const errorParetoMap = new Map();
  for (const t of toolRows) {
    if (t.outcome !== 'FAILED' && t.failure_class == null) continue;
    const key = t.failure_class ?? 'FAILED';
    errorParetoMap.set(key, (errorParetoMap.get(key) ?? 0) + 1);
  }

  let commands = null;
  if (hasTableCtx(db, 'obs_command')) {
    const cmdRows = rows(db, `
      SELECT c.*, e.lifecycle, e.outcome, e.registered_at FROM obs_command c
      JOIN obs_entity e ON e.scope_id=c.scope_id AND e.entity_id=c.command_id
      WHERE c.scope_id=? AND e.registered_at>=? AND e.registered_at<?`, scope, p.from, p.to);
    const byFamily = new Map();
    for (const c of cmdRows) {
      const key = c.executable_family ?? '(未知族)';
      if (!byFamily.has(key)) byFamily.set(key, { family: key, count: 0, failed: 0, exitCodes: new Map(), stdoutBytes: 0, stderrBytes: 0 });
      const g = byFamily.get(key);
      g.count += 1;
      if (c.outcome === 'FAILED') g.failed += 1;
      if (c.exit_code != null) g.exitCodes.set(c.exit_code, (g.exitCodes.get(c.exit_code) ?? 0) + 1);
      g.stdoutBytes += c.stdout_bytes ?? 0;
      g.stderrBytes += c.stderr_bytes ?? 0;
    }
    commands = {
      total: cmdRows.length,
      infra: cmdRows.filter((c) => c.origin_kind === 'INTERNAL_INFRA').length,
      families: [...byFamily.values()].map((g) => ({ ...g, exitCodes: Object.fromEntries(g.exitCodes) })),
    };
  }

  return {
    toolTable,
    totalCalls: toolRows.length,
    errorPareto: [...errorParetoMap.entries()].map(([key, count]) => ({ key, count })).sort((a, b) => b.count - a.count),
    outputVolume: toolTable.filter((t) => t.resultBytesSamples > 0).map((t) => ({
      tool: t.canonicalToolName, calls: t.callCount, medianBytes: t.resultBytesMedian, totalBytes: t.resultBytesTotal,
    })),
    commands,
    note: 'stderr>0 不等于执行失败；大输出仅提示体积异常候选。',
  };
}

// ---------- analytics: collaboration (P1 surface, honest empty states) ----------

export function analyticsCollaboration(ctx, p) {
  const { db } = ctx;
  const scope = p.scopeId;
  const f = p.filters ?? {};
  const plans = hasTableCtx(db, 'obs_plan_revision') ? rows(db, `
    SELECT pr.*, e.registered_at, e.lifecycle, e.outcome
    FROM obs_plan_revision pr JOIN obs_entity e ON e.scope_id=pr.scope_id AND e.entity_id=pr.plan_revision_id
    WHERE pr.scope_id=? AND e.registered_at>=? AND e.registered_at<?
    ${f.planId ? 'AND pr.plan_id = ?' : ''}
    ORDER BY pr.plan_id, pr.revision_no`, scope, p.from, p.to, ...(f.planId ? [f.planId] : [])) : [];
  const planGroups = new Map();
  for (const r of plans) {
    if (!planGroups.has(r.plan_id)) planGroups.set(r.plan_id, []);
    planGroups.get(r.plan_id).push({
      planRevisionId: r.plan_revision_id, revisionNo: r.revision_no,
      changeReason: r.change_reason, approvalState: r.approval_state,
      runId: r.run_id, registeredAt: r.registered_at, lifecycle: r.lifecycle, outcome: r.outcome,
    });
  }
  const delegations = hasTableCtx(db, 'obs_delegation') ? rows(db, `
    SELECT d.*, e.registered_at, e.lifecycle, e.outcome, e.native_status
    FROM obs_delegation d JOIN obs_entity e ON e.scope_id=d.scope_id AND e.entity_id=d.delegation_id
    WHERE d.scope_id=? AND e.registered_at>=? AND e.registered_at<?
    ${f.role ? 'AND d.role = ?' : ''}`, scope, p.from, p.to, ...(f.role ? [f.role] : [])) : [];
  const allRuns = fetchRunRows(db, scope, {});
  const relationMap = validateRunRelations(allRuns);
  const anomalies = [...relationMap.entries()].filter(([, v]) => v.anomalies.length)
    .map(([runId, v]) => ({ runId, reasons: v.anomalies }));
  return {
    plans: [...planGroups.entries()].map(([planId, revisions]) => ({
      planId, revisionCount: revisions.length,
      hasInitial: revisions.some((r) => r.revisionNo === 0),
      revisions,
    })),
    delegations: delegations.map((d) => ({
      delegationId: d.delegation_id, parentRunId: d.parent_run_id, childRunId: d.child_run_id,
      role: d.role, requestedAt: d.requested_at, acceptedAt: d.accepted_at,
      startedAt: d.started_at, completedAt: d.completed_at,
      lifecycle: d.lifecycle, outcome: d.outcome,
      queueMs: d.requested_at != null && d.accepted_at != null ? d.accepted_at - d.requested_at : null,
      startWaitMs: d.accepted_at != null && d.started_at != null ? d.started_at - d.accepted_at : null,
    })),
    relationAnomalies: anomalies,
    capabilityNote: 'Plan/Subagent 视图依赖 obs_plan_revision 与 obs_delegation；当前为空时显示能力说明而非 0 值。',
  };
}

// ---------- analytics: efficiency / cost (P1) ----------

export function analyticsEfficiency(ctx, p) {
  const { db, source } = ctx;
  const scope = p.scopeId;
  if (!hasTableCtx(db, 'obs_cost_observation')) {
    return { capability: 'SCHEMA_MISSING', facets: [], receipts: [], authorityPolicy: null };
  }
  const f = p.filters ?? {};
  const allCosts = latestCostRevisions(rows(db, 'SELECT * FROM obs_cost_observation WHERE scope_id=?', scope));
  const inWindow = allCosts.filter((c) =>
    c.observed_at >= p.from && c.observed_at < p.to && (!f.currency || c.currency === f.currency));
  const policy = source.costAuthorityPolicy ?? null;
  const summed = sumCosts(inWindow, { preferredSource: policy?.preferredSource ?? null });
  return {
    capability: inWindow.length ? 'AVAILABLE' : 'NO_DATA',
    authorityPolicy: policy,
    facets: summed.facets,
    preferred: summed.preferred,
    receipts: inWindow.map((c) => ({
      costId: c.cost_id, attemptId: c.attempt_id, commandId: c.command_id,
      category: c.category, source: c.source, authorityKey: c.authority_key,
      revision: c.revision, amount: c.amount_decimal, currency: c.currency,
      completeness: c.completeness, observedAt: c.observed_at, pricingRevision: c.pricing_revision,
    })),
    note: '未配置 authorityPolicy 时按来源分面展示，不提供跨来源总费用；金额为十进制字符串。',
  };
}

// ---------- analytics: quality ----------

export function analyticsQuality(ctx, p) {
  const { db } = ctx;
  const scope = p.scopeId;
  const { from, to } = p;
  const f = p.filters ?? {};
  const allRuns = fetchRunRows(db, scope, {});
  const relationMap = validateRunRelations(allRuns);
  const entityRows = rows(db, `
    SELECT entity_id, entity_kind, lifecycle, outcome, native_status, registered_at, started_at, ended_at, duration_ms, coverage
    FROM obs_entity WHERE scope_id=?`, scope);
  const conflicts = [];
  const unclosed = [];
  for (const e of entityRows) {
    const c = classifyEntity(e);
    if (c.conflict) conflicts.push({ entityId: e.entity_id, kind: e.entity_kind, reasons: c.qualityReasons, lifecycle: e.lifecycle, outcome: e.outcome, nativeStatus: e.native_status });
    else if (c.activityState === 'UNCLOSED' || c.activityState === 'ACTIVITY_UNKNOWN') {
      unclosed.push({ entityId: e.entity_id, kind: e.entity_kind, lifecycle: e.lifecycle, registeredAt: e.registered_at, startedAt: e.started_at });
    }
  }
  const relationAnomalies = [...relationMap.entries()].filter(([, v]) => v.anomalies.length)
    .map(([runId, v]) => ({ runId, reasons: v.anomalies }));

  const issues = rows(db, `
    SELECT issue_id, entity_id, event_id, issue_code, severity, first_seen_at, last_seen_at, occurrence_count, resolution, safe_detail
    FROM obs_registration_issue WHERE scope_id=?
    ${f.issueCode ? 'AND issue_code = ?' : ''}${f.severity ? ' AND severity = ?' : ''}
    ORDER BY last_seen_at DESC`, scope, ...(f.issueCode ? [f.issueCode] : []), ...(f.severity ? [f.severity] : []));
  const issueByCode = new Map();
  for (const i of issues) {
    const g = issueByCode.get(i.issue_code) ?? { code: i.issue_code, severity: i.severity, records: 0, occurrences: 0 };
    g.records += 1; g.occurrences += i.occurrence_count;
    issueByCode.set(i.issue_code, g);
  }

  const lagRows = rows(db, `
    SELECT event_id, occurred_at, recorded_at, recorded_at - occurred_at AS lag_ms
    FROM obs_event WHERE scope_id=? AND recorded_at>=? AND recorded_at<?`, scope, from, to);
  const positiveLag = lagRows.map((r) => r.lag_ms).filter((v) => v != null && v >= 0).sort((a, b) => a - b);
  const clockAnomalies = lagRows.filter((r) => r.lag_ms != null && r.lag_ms < 0).length;

  const sources = rows(db, `
    SELECT source_instance_id, boot_at, heartbeat_at, stopped_at, capabilities_json
    FROM obs_source WHERE scope_id=?`, scope);
  const now = Date.now();
  const liveness = sources.map((s) => ({
    sourceInstanceId: s.source_instance_id, bootAt: s.boot_at,
    heartbeatAt: s.heartbeat_at, stoppedAt: s.stopped_at,
    state: s.stopped_at != null ? 'STOPPED' : (s.heartbeat_at != null ? 'HAS_HEARTBEAT' : 'ACTIVITY_UNKNOWN'),
    ageMs: s.heartbeat_at != null ? now - s.heartbeat_at : null,
  }));

  const coverage = coverageMatrix(db, scope);

  return {
    executionQuality: {
      failedEntities: entityRows.filter((e) => e.lifecycle === 'TERMINAL' && e.outcome === 'FAILED')
        .map((e) => ({ entityId: e.entity_id, kind: e.entity_kind })),
      toolFailures: rows(db, `
        SELECT t.tool_call_id, t.canonical_tool_name, t.failure_class, e.ended_at
        FROM obs_tool_call t JOIN obs_entity e ON e.scope_id=t.scope_id AND e.entity_id=t.tool_call_id
        WHERE t.scope_id=? AND e.lifecycle='TERMINAL' AND e.outcome IN ('FAILED','TIMED_OUT')`, scope),
    },
    dataQuality: {
      stateConflicts: conflicts,
      relationAnomalies,
      unclosedEntities: unclosed.slice(0, 200),
      unclosedTotal: unclosed.length,
      issueByCode: [...issueByCode.values()],
      issues: issues.slice(0, p.limit ?? 200),
      registrationLag: { sampleCount: positiveLag.length, p50: quantile(positiveLag, 0.5), p95: quantile(positiveLag, 0.95), clockAnomalies },
      sourceLiveness: liveness,
      coverageMatrix: coverage,
      dataAsOf: dataAsOf(db, scope),
      sequenceGaps: sequenceGapCheck(db, scope),
    },
  };
}

function coverageMatrix(db, scope) {
  const fams = [
    { family: 'run', label: 'Run', need: ['lifecycle', 'outcome', 'ended_at', 'duration_ms'] },
    { family: 'step', label: 'Step', need: ['lifecycle', 'outcome', 'ended_at'] },
    { family: 'call', label: '模型调用', need: ['lifecycle', 'outcome'] },
    { family: 'attempt', label: '传输尝试', need: ['lifecycle', 'ended_at', 'duration_ms'] },
    { family: 'tool', label: '工具调用', need: ['lifecycle', 'outcome', 'duration_ms'] },
  ];
  const kindMap = { run: 'RUN', step: 'STEP', call: 'MODEL_CALL', attempt: 'MODEL_ATTEMPT', tool: 'TOOL_CALL' };
  const out = [];
  for (const fam of fams) {
    const total = one(db, 'SELECT COUNT(*) n FROM obs_entity WHERE scope_id=? AND entity_kind=?', scope, kindMap[fam.family])?.n ?? 0;
    const fields = fam.need.map((col) => ({
      field: col,
      known: total ? one(db, `SELECT COUNT(*) n FROM obs_entity WHERE scope_id=? AND entity_kind=? AND ${col} IS NOT NULL`, scope, kindMap[fam.family])?.n ?? 0 : 0,
    }));
    out.push({ ...fam, total, fields });
  }
  return out;
}

function sequenceGapCheck(db, scope) {
  const gaps = [];
  const rows_ = rows(db, `
    SELECT entity_id, entity_revision FROM obs_event WHERE scope_id=? ORDER BY entity_id, entity_revision`, scope);
  const byEntity = new Map();
  for (const r of rows_) {
    if (!byEntity.has(r.entity_id)) byEntity.set(r.entity_id, []);
    byEntity.get(r.entity_id).push(r.entity_revision);
  }
  for (const [entityId, revs] of byEntity) {
    for (let i = 1; i < revs.length; i++) {
      if (revs[i] !== revs[i - 1] + 1) {
        gaps.push({ entityId, afterRevision: revs[i - 1], beforeRevision: revs[i] });
      }
    }
  }
  return { visibleSequenceGaps: gaps.slice(0, 100), total: gaps.length, note: '仅可见序列缺口，不代表全系统丢失率' };
}

// ---------- explorer ----------

export function listEntities(ctx, p) {
  const { db } = ctx;
  const scope = p.scopeId;
  const cond = ['scope_id = ?'];
  const args = [scope];
  if (p.filters.entityKind) { cond.push('entity_kind = ?'); args.push(p.filters.entityKind); }
  if (p.filters.entityId) { cond.push('entity_id = ?'); args.push(p.filters.entityId); }
  if (p.filters.lifecycle) { cond.push('lifecycle = ?'); args.push(p.filters.lifecycle); }
  if (p.cursorData) {
    const [v] = p.cursorData.sortValues;
    pushKeyset(cond, args, 'registered_at', 'entity_id', 'DESC', v, p.cursorData.entityId);
  }
  const fetched = rows(db, `
    SELECT entity_id, entity_kind, lifecycle, outcome, native_status, effect_state,
           root_run_id, run_id, parent_entity_id, current_revision,
           registered_at, started_at, ended_at, duration_ms, timing_quality, coverage
    FROM obs_entity WHERE ${cond.join(' AND ')}
    ORDER BY registered_at DESC, entity_id DESC LIMIT ?`, ...args, p.limit + 1);
  const hasMore = fetched.length > p.limit;
  const pageRows = fetched.slice(0, p.limit);
  const last = pageRows[pageRows.length - 1];
  return { rows: pageRows, hasMore, lastSortValue: last?.registered_at ?? null, lastId: last?.entity_id ?? null };
}

export function listEvents(ctx, p) {
  const { db } = ctx;
  const scope = p.scopeId;
  const cond = ['scope_id = ?'];
  const args = [scope];
  if (p.filters.entityId) { cond.push('entity_id = ?'); args.push(p.filters.entityId); }
  if (p.filters.eventType) { cond.push('event_type = ?'); args.push(p.filters.eventType); }
  if (p.cursorData) {
    const [v] = p.cursorData.sortValues;
    pushKeyset(cond, args, 'recorded_at', 'event_id', 'DESC', v, p.cursorData.entityId);
  }
  const fetched = rows(db, `
    SELECT event_id, entity_id, entity_kind, entity_revision, event_type,
           occurred_at, recorded_at, payload_version
    FROM obs_event WHERE ${cond.join(' AND ')}
    ORDER BY recorded_at DESC, event_id DESC LIMIT ?`, ...args, p.limit + 1);
  const hasMore = fetched.length > p.limit;
  const pageRows = fetched.slice(0, p.limit);
  const last = pageRows[pageRows.length - 1];
  return { rows: pageRows, hasMore, lastSortValue: last?.recorded_at ?? null, lastId: last?.event_id ?? null };
}

export function eventDetail(ctx, p) {
  const { db } = ctx;
  return one(db, `
    SELECT event_id, entity_id, entity_kind, entity_revision, event_type, source_instance_id,
           occurred_at, recorded_at, payload_version, payload_hash, payload_json
    FROM obs_event WHERE scope_id=? AND event_id=?`, p.scopeId, p.eventId) ?? null;
}

export function listIssues(ctx, p) {
  const { db } = ctx;
  const scope = p.scopeId;
  const cond = ['scope_id = ?'];
  const args = [scope];
  if (p.filters.issueCode) { cond.push('issue_code = ?'); args.push(p.filters.issueCode); }
  if (p.filters.severity) { cond.push('severity = ?'); args.push(p.filters.severity); }
  if (p.cursorData) {
    const [v] = p.cursorData.sortValues;
    pushKeyset(cond, args, 'last_seen_at', 'issue_id', 'DESC', v, p.cursorData.entityId);
  }
  const fetched = rows(db, `
    SELECT * FROM obs_registration_issue WHERE ${cond.join(' AND ')}
    ORDER BY last_seen_at DESC, issue_id DESC LIMIT ?`, ...args, p.limit + 1);
  const hasMore = fetched.length > p.limit;
  const pageRows = fetched.slice(0, p.limit);
  const last = pageRows[pageRows.length - 1];
  return { rows: pageRows, hasMore, lastSortValue: last?.last_seen_at ?? null, lastId: last?.issue_id ?? null };
}

export function artifactDetail(ctx, p) {
  const { db } = ctx;
  if (!hasTableCtx(db, 'obs_artifact')) return null;
  const a = one(db, 'SELECT * FROM obs_artifact WHERE scope_id=? AND artifact_id=?', p.scopeId, p.artifactId);
  if (!a) return null;
  return {
    artifactId: a.artifact_id, ownerEntityId: a.owner_entity_id, artifactKind: a.artifact_kind,
    captureState: a.capture_state, mediaType: a.media_type, originalBytes: a.original_bytes,
    storedBytes: a.stored_bytes, truncated: a.truncated, createdAt: a.created_at,
    expiresAt: a.expires_at, availabilityCheckedAt: a.availability_checked_at,
    contentAvailable: a.capture_state === 'AVAILABLE',
    note: 'capture_state=AVAILABLE 是必要条件而非可访问保证；内容预览按许可媒体类型有界读取。',
  };
}

export function exportAnalytics(ctx, p) {
  const { db } = ctx;
  const scope = p.scopeId;
  if (p.metricId === 'runs.created') {
    const rs = fetchRunRows(db, scope, p.filters).filter((r) => r.registered_at >= p.from && r.registered_at < p.to);
    const relMap = validateRunRelations(fetchRunRows(db, scope, {}));
    const out = rs.map((r) => runToRow(r, relMap));
    attachRunAggregates(db, scope, out);
    return {
      columns: ['runId', 'runKind', 'productName', 'lifecycle', 'outcome', 'activityState', 'relationState', 'registeredAt', 'startedAt', 'endedAt', 'durationMs', 'wallClockMs', 'stepCount', 'callCount', 'transportAttemptCount', 'toolCallCount', 'knownTotalTokens'],
      rows: out,
    };
  }
  if (p.metricId === 'models.attempts') {
    const res = listModelAttempts(ctx, { ...p, limit: 200 });
    return {
      columns: ['attempt_id', 'call_id', 'run_id', 'provider_id', 'requested_model', 'resolved_model', 'visibility', 'dispatch_state', 'transport_outcome', 'http_status', 'started_at', 'ended_at', 'duration_ms', 'input_tokens', 'output_tokens', 'reasoning_tokens', 'total_tokens'],
      rows: res.rows,
    };
  }
  if (p.metricId === 'tools.table') {
    const res = analyticsTools(ctx, p);
    return {
      columns: ['canonicalToolName', 'callCount', 'successRate', 'succeeded', 'failed', 'timedOut', 'durationP50', 'durationP95', 'resultBytesTotal', 'resultBytesMedian'],
      rows: res.toolTable,
    };
  }
  return null;
}
