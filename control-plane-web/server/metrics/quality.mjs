// Deterministic attention rules (§14.1). Rules surface verifiable facts only —
// they never write back, never invent anomalies, and report their evidence.

/**
 * inputs: precomputed aggregates gathered by the repository layer.
 * Each rule returns an AttentionItem or null.
 */
export function deriveAttention({
  usageAgg, runCreated, runCompleted, stateConflicts, relationAnomalies,
  retryStats, sourceLiveness, durationMissingEnded, issueCounts, ctxPressure,
}) {
  const items = [];
  if (usageAgg && usageAgg.sampleCount > 0 && usageAgg.usageRowCount === 0) {
    items.push({
      ruleId: 'USAGE_MISSING', severity: 'WARN', metricId: 'model.usage.tokens',
      sampleCount: usageAgg.sampleCount,
      message: `${usageAgg.sampleCount}个已观测传输尝试未提供Token用量`,
      drilldown: { path: '/models', filters: { hasUsage: 'false' } },
    });
  } else if (usageAgg && usageAgg.sampleCount > 0 && usageAgg.total.knownCount === 0) {
    items.push({
      ruleId: 'USAGE_MISSING', severity: 'WARN', metricId: 'model.usage.tokens',
      sampleCount: usageAgg.sampleCount,
      message: `${usageAgg.sampleCount}个尝试的Token用量均为未知`,
      drilldown: { path: '/models', filters: { hasUsage: 'false' } },
    });
  }
  if (durationMissingEnded > 0) {
    items.push({
      ruleId: 'DURATION_MISSING', severity: 'INFO', metricId: 'run.duration.p95',
      sampleCount: durationMissingEnded,
      message: `${durationMissingEnded}个已结束Run缺少精确耗时，可查看墙钟跨度`,
      drilldown: { path: '/runs', filters: {} },
    });
  }
  if (stateConflicts > 0) {
    items.push({
      ruleId: 'STATE_CONFLICT', severity: 'WARN', metricId: 'run.outcome',
      sampleCount: stateConflicts,
      message: `${stateConflicts}个实体生命周期与结果字段矛盾，状态待核对`,
      drilldown: { path: '/quality', filters: { kind: 'stateConflict' } },
    });
  }
  if (relationAnomalies > 0) {
    items.push({
      ruleId: 'HIERARCHY_GAP', severity: 'WARN', metricId: 'run.hierarchy',
      sampleCount: relationAnomalies,
      message: `${relationAnomalies}个Run父子关系不完整，协作汇总已按验证关系处理`,
      drilldown: { path: '/quality', filters: { kind: 'relation' } },
    });
  }
  if (retryStats && retryStats.dispatchedCalls >= 20 && retryStats.retryCallRate != null && retryStats.retryCallRate > 0.15) {
    items.push({
      ruleId: 'RETRY_ELEVATED', severity: 'WARN', metricId: 'model.retry',
      sampleCount: retryStats.dispatchedCalls,
      message: `本期重试调用率 ${(retryStats.retryCallRate * 100).toFixed(1)}%，查看涉及模型`,
      drilldown: { path: '/models', filters: { retried: 'true' } },
    });
  }
  if (ctxPressure > 0) {
    items.push({
      ruleId: 'CONTEXT_PRESSURE', severity: 'WARN', metricId: 'context.pressure',
      sampleCount: ctxPressure,
      message: `${ctxPressure}个请求输入预算占用≥85%（估算值）`,
      drilldown: { path: '/context', filters: {} },
    });
  }
  if (sourceLiveness?.unknown > 0) {
    items.push({
      ruleId: 'SOURCE_ACTIVITY_UNKNOWN', severity: 'INFO', metricId: 'source.liveness',
      sampleCount: sourceLiveness.unknown,
      message: `${sourceLiveness.unknown}个数据源生产者活性未知（无心跳证据）`,
      drilldown: { path: '/quality', filters: { kind: 'freshness' } },
    });
  }
  if (issueCounts?.records > 0) {
    items.push({
      ruleId: 'REGISTRATION_ISSUES', severity: 'INFO', metricId: 'quality.issues',
      sampleCount: issueCounts.records,
      message: `${issueCounts.records}条登记问题记录（累计${issueCounts.occurrences}次）`,
      drilldown: { path: '/quality', filters: { kind: 'issues' } },
    });
  }
  return items;
}
