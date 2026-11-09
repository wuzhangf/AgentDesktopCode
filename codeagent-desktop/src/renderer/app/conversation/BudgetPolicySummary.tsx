import type { ExecutionPolicyLike } from '../queries';

/**
 * Compact, read-only budget projection for the approval floating panel. The service is
 * authoritative; this component never computes a new allowance or turns a
 * delay into an approval.
 */
export function BudgetPolicySummary(props: {
  policy?: ExecutionPolicyLike | null;
  unavailableReason?: string | null;
}): React.JSX.Element {
  const policy = props.policy;
  if (!policy) {
    return (
      <div className="budget-policy-summary" data-testid="budget-policy-summary">
        <span className="budget-policy-title">预算策略</span>
        <span className="run-meta">状态待同步{props.unavailableReason ? `（${props.unavailableReason}）` : ''}</span>
      </div>
    );
  }
  const delays = (policy.budgetDelayMillis ?? []).filter((value) => Number.isFinite(value));
  const delayLabel = delays.length === 0
    ? '需人工确认'
    : delays.map((value) => `${Math.max(0, Math.round(value / 1000))}s`).join(' → ');
  return (
    <div className="budget-policy-summary" data-testid="budget-policy-summary">
      <span className="budget-policy-title">预算策略</span>
      <span className="run-meta">追加延时 {delayLabel}</span>
      <span className="run-meta">自动追加 {policy.maxAutomaticBudgetApprovals} 次 · TTL {Math.round(policy.approvalTtlMillis / 1000)}s</span>
    </div>
  );
}
