// Metric registry (§11.4): id → unit, cohort basis, denominator rule, supported
// filters and drilldown target. The UI's口径抽屉 is generated from this table.
export const METRIC_REGISTRY = [
  {
    id: 'run.registered', label: '已登记 Run', unit: 'count', cohortBasis: 'registered_at',
    denominator: 'obs_run joined entity in scope', nullRule: 'count-registered',
    filters: ['product', 'runKind', 'configRevision'], drilldown: '/runs',
  },
  {
    id: 'run.completed', label: '本期完成 Run', unit: 'count', cohortBasis: 'ended_at',
    denominator: 'trusted TERMINAL runs with ended_at in window', nullRule: 'count-known',
    filters: ['product', 'runKind'], drilldown: '/runs',
  },
  {
    id: 'run.execution_success_rate', label: '执行成功率', unit: 'ratio', cohortBasis: 'ended_at',
    denominator: 'SUCCEEDED/(SUCCEEDED+FAILED+TIMED_OUT) on trusted terminal runs',
    nullRule: 'denominator-0→null', filters: ['product', 'runKind'], drilldown: '/runs',
  },
  {
    id: 'run.unclosed', label: '未闭合/活性未知 Run', unit: 'count', cohortBasis: 'asOf',
    denominator: 'REGISTERED/STARTED/OUTCOME_UNKNOWN at query time', nullRule: 'count-registered',
    filters: ['product', 'runKind'], drilldown: '/runs?state=unclosed',
  },
  {
    id: 'model.logical_calls', label: '模型逻辑调用', unit: 'count', cohortBasis: 'registered_at',
    denominator: 'obs_model_call entities', nullRule: 'count-registered',
    filters: ['provider', 'model', 'purpose'], drilldown: '/models',
  },
  {
    id: 'model.observed_transports', label: '已观测传输尝试', unit: 'count', cohortBasis: 'call registered_at',
    denominator: 'attempts with visibility=TRANSPORT_ATTEMPT & dispatch ATTEMPTED/RESPONSE_RECEIVED',
    nullRule: 'count-registered', filters: ['provider', 'model'], drilldown: '/models',
  },
  {
    id: 'model.retry_call_rate', label: '重试调用率', unit: 'ratio', cohortBasis: 'call registered_at',
    denominator: 'calls with k>=2 observed transports / calls with k>=1', nullRule: 'denominator-0→null',
    filters: ['provider', 'model'], drilldown: '/models',
  },
  {
    id: 'model.usage.total_tokens', label: '已知 total Token', unit: 'tokens', cohortBasis: 'attempt started_at',
    denominator: 'usage rows with known total (PROVIDER/DERIVED)', nullRule: 'all-unknown→NO_DATA',
    filters: ['provider', 'model'], drilldown: '/models',
  },
  {
    id: 'tool.calls', label: '工具调用', unit: 'count', cohortBasis: 'registered_at',
    denominator: 'obs_tool_call entities', nullRule: 'count-registered',
    filters: ['tool'], drilldown: '/tools',
  },
  {
    id: 'run.duration.p95', label: '执行耗时 P95', unit: 'ms', cohortBasis: 'ended_at',
    denominator: 'trusted terminal runs with duration_ms', nullRule: 'n=0→null; n<20 flagged',
    filters: ['product', 'runKind'], drilldown: '/runs',
  },
  {
    id: 'context.pressure', label: '输入预算占用', unit: 'ratio', cohortBasis: 'snapshot registered_at',
    denominator: 'context snapshots with estimate+usable_input', nullRule: 'no rows→capability empty',
    filters: [], drilldown: '/context',
  },
  {
    id: 'quality.registration_issues', label: '登记问题记录', unit: 'count', cohortBasis: 'last_seen_at',
    denominator: 'obs_registration_issue rows; occurrence_count shown separately',
    nullRule: 'count-registered', filters: ['issueCode', 'severity'], drilldown: '/quality',
  },
  {
    id: 'cost.reported', label: '来源报告费用', unit: 'money', cohortBasis: 'owner started_at',
    denominator: 'latest revision per authority_key; per currency×source facets',
    nullRule: 'no policy→facets only', filters: ['currency'], drilldown: '/efficiency',
  },
];

export function metricMeta(id) {
  return METRIC_REGISTRY.find((m) => m.id === id) ?? null;
}
