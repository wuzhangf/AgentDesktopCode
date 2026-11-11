// Display names + caliber descriptions for metric ids (mirrors server registry).
const REGISTRY: Record<string, { label: string; caliber: string }> = {
  'run.registered': { label: '已登记 Run', caliber: '按 entity.registered_at 归属本期创建的 Run 数' },
  'run.completed': { label: '本期完成 Run', caliber: 'entity.ended_at 落在窗口内且结果已知的 Run' },
  'run.execution_success_rate': { label: '执行成功率', caliber: 'SUCCEEDED / (SUCCEEDED+FAILED+TIMED_OUT)，仅可信终态样本' },
  'run.unclosed': { label: '未闭合 / 活性未知', caliber: '查询时点仍为 REGISTERED/STARTED/OUTCOME_UNKNOWN 的 Run' },
  'model.logical_calls': { label: '模型逻辑调用', caliber: 'obs_model_call 实体数（不含传输重试）' },
  'model.observed_transports': { label: '已观测传输尝试', caliber: 'visibility=TRANSPORT_ATTEMPT 且已 dispatch 的 attempt' },
  'model.extra_attempts': { label: '额外传输尝试', caliber: '每逻辑调用 Σmax(k−1,0)' },
  'model.retry_call_rate': { label: '重试调用率', caliber: 'k≥2 的调用 / k≥1 的调用' },
  'model.usage.total_tokens': { label: '已知 total Token', caliber: 'total_source∈PROVIDER/DERIVED 的已知小计，NULL 不补零' },
  'model.usage.coverage': { label: '用量覆盖率', caliber: '有已知 total 的 usage 行 / usage 行' },
  'tool.calls': { label: '工具调用', caliber: 'obs_tool_call 实体数' },
  'run.duration.p95': { label: '执行耗时 P95', caliber: 'duration_ms 最近秩分位；墙钟跨度单列' },
  'run.steps': { label: '决策步数', caliber: 'obs_step 实体数' },
  'run.duration': { label: '执行耗时', caliber: 'entity.duration_ms（MONOTONIC 精确值）' },
  'context.pressure': { label: '输入预算占用', caliber: 'input_tokens_estimated / usable_input_tokens（估算）' },
  'quality.registration_issues': { label: '登记问题', caliber: 'issue 记录数与累计 occurrence 分列' },
  'cost.reported': { label: '来源报告费用', caliber: '按 authority/currency 分面的最新修订金额' },
};

export function metricRegistry(id: string) {
  return REGISTRY[id] ?? { label: id, caliber: '' };
}
