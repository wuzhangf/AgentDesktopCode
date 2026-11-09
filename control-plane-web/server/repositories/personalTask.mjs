import { aggregateUsage } from '../metrics/usage.mjs';
import { latestCostRevisions, sumCosts } from '../metrics/cost.mjs';
import { metricValue } from '../lib/dto.mjs';

export function unknownTaskMetrics(reason) {
  return { metrics: ['model.logical_calls', 'model.transports', 'model.usage.input', 'model.usage.output', 'model.usage.total', 'model.cost'].map(metricId => metricValue({ metricId, value: null,
    unit: metricId.includes('usage') ? 'tokens' : metricId.includes('cost') ? 'money' : 'count',
    state: 'NO_DATA', completeness: 'UNKNOWN', measurement: 'UNKNOWN', reasonCodes: [reason] })), models: [], reasonCodes: [reason] };
}

/** Fixed exact business-run join. No time/model heuristics, descendants or artifacts. */
export function personalTaskMetrics({db, source}, p) {
  const runs = db.prepare(`SELECT r.run_id FROM obs_run r LEFT JOIN obs_task t ON t.scope_id=r.scope_id AND t.task_id=r.task_id
    WHERE r.scope_id=? AND r.business_run_id=? AND r.session_id=? AND (r.task_id=? OR t.external_task_id=?) LIMIT 2`)
    .all(p.scopeId, p.runId, p.sessionId, p.taskId, p.taskId);
  if (runs.length !== 1) return unknownTaskMetrics(runs.length ? 'AMBIGUOUS_RUN_BINDING' : 'RUN_NOT_COLLECTED');
  const runId = runs[0].run_id;
  const calls = db.prepare('SELECT call_id FROM obs_model_call WHERE scope_id=? AND run_id=? LIMIT 5001').all(p.scopeId, runId);
  if (!calls.length) return unknownTaskMetrics('MODEL_CALLS_NOT_COLLECTED');
  const attempts = db.prepare(`SELECT a.attempt_id,a.visibility,a.dispatch_state,a.provider_id,a.requested_model,a.resolved_model,a.response_model,
      u.input_tokens,u.output_tokens,u.reasoning_tokens,u.total_tokens,u.total_source,u.input_coverage,u.reasoning_relation,u.measurement_source
    FROM obs_model_call c JOIN obs_model_attempt a ON a.scope_id=c.scope_id AND a.call_id=c.call_id
    LEFT JOIN obs_model_usage u ON u.scope_id=a.scope_id AND u.attempt_id=a.attempt_id
    WHERE c.scope_id=? AND c.run_id=? LIMIT 5001`).all(p.scopeId, runId);
  if (calls.length > 5000 || attempts.length > 5000) return unknownTaskMetrics('QUERY_SAMPLE_LIMIT');
  const eligible = attempts.filter(a => a.visibility === 'TRANSPORT_ATTEMPT' && ['ATTEMPTED', 'RESPONSE_RECEIVED'].includes(a.dispatch_state));
  const metric = (metricId, value, unit, measurement, knownCount, sampleCount, extra = {}) => metricValue({
    metricId, value, knownSubtotal: value, unit, measurement, state: value == null ? 'NO_DATA' : 'PARTIAL',
    completeness: value == null ? 'UNKNOWN' : 'PARTIAL', knownCount, sampleCount,
    unknownCount: sampleCount - knownCount, coverageRatio: sampleCount ? knownCount / sampleCount : null,
    reasonCodes: ['OBSERVED_SUBTOTAL'], cohortBasis: 'exact-business-run', ...extra,
  });
  const metrics = [metric('model.logical_calls', calls.length, 'count', 'MEASURED', calls.length, calls.length),
    metric('model.transports', eligible.length || null, 'count', 'MEASURED', eligible.length, attempts.length),
    metric('model.dispatch_unconfirmed', attempts.filter(a => !eligible.includes(a)).length, 'count', 'MEASURED', attempts.length, attempts.length)];
  for (const measurement of ['REPORTED', 'ESTIMATED', 'UNKNOWN']) {
    const selected = eligible.filter(a => measurement === 'REPORTED' ? ['PROVIDER_REPORTED', 'STREAM_ACCUMULATED'].includes(a.measurement_source)
      : measurement === 'ESTIMATED' ? a.measurement_source === 'ESTIMATED' : !['PROVIDER_REPORTED', 'STREAM_ACCUMULATED', 'ESTIMATED'].includes(a.measurement_source));
    if (!selected.length && measurement !== 'REPORTED') continue;
    const agg = aggregateUsage(selected);
    for (const field of ['input', 'output', 'total']) {
      const a = agg[field];
      const derived = field === 'total' && selected.some(r => r.total_source === 'DERIVED');
      metrics.push(metric(`model.usage.${field}.${measurement.toLowerCase()}`, a.knownCount ? a.knownSubtotal : null, 'tokens', measurement === 'REPORTED' && derived ? 'DERIVED' : measurement,
        a.knownCount, eligible.length, { excludedCount: 0,
          reasonCodes: ['OBSERVED_SUBTOTAL', ...(field === 'input' && selected.some(r => r.input_coverage !== 'COMPLETE') ? ['INPUT_COVERAGE_INCOMPLETE'] : [])] }));
    }
  }
  const costs = db.prepare(`SELECT co.* FROM obs_cost_observation co WHERE co.scope_id=? AND (
    co.attempt_id IN (SELECT a.attempt_id FROM obs_model_attempt a JOIN obs_model_call c ON c.scope_id=a.scope_id AND c.call_id=a.call_id WHERE c.scope_id=? AND c.run_id=?)
    OR co.command_id IN (SELECT command_id FROM obs_command WHERE scope_id=? AND run_id=?)) LIMIT 5001`).all(p.scopeId,p.scopeId,runId,p.scopeId,runId);
  if (costs.length > 5000) metrics.push(...unknownTaskMetrics('COST_SAMPLE_LIMIT').metrics.filter(m => m.unit === 'money'));
  else {
    const latest = latestCostRevisions(costs);
    const facets = sumCosts(latest).facets;
    if (!facets.length) metrics.push(...unknownTaskMetrics('COST_NOT_COLLECTED').metrics.filter(m => m.unit === 'money'));
    for (const f of facets) metrics.push(metric(`model.cost.${f.source}`, f.count > f.unknownCount ? f.sum : null, 'money', f.source === 'LOCAL_ESTIMATE' ? 'ESTIMATED' : 'REPORTED', f.count-f.unknownCount, f.count,
      { currency: f.currency ?? undefined, reasonCodes: ['COST_SOURCE_FACET', 'NOT_A_COMBINED_BILL'] }));
  }
  return { metrics, models: [...new Map(attempts.slice(-10).map(a => { const model = { providerId: a.provider_id, requestedModel: a.requested_model, resolvedModel: a.resolved_model, responseModel: a.response_model }; return [JSON.stringify(model), model]; })).values()], reasonCodes: ['OBSERVED_SUBTOTAL'] };
}
