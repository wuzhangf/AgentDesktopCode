import type { ApprovalRequestLike } from '../queries';

const DANGER_LABELS: Record<string, string> = {
  D1: '可能丢失用户数据',
  D2: '可能破坏共享或生产状态',
  D3: '可能暴露敏感信息或削弱安全边界',
  D4: '可能产生不可轻易撤销的外部承诺'
};

function actionAvailable(approval: ApprovalRequestLike, action: string): boolean {
  return Array.isArray(approval.allowedActions) && (approval.allowedActions as string[]).includes(action);
}

function stateLabel(approval: ApprovalRequestLike): string {
  // An unknown execution result is never an approval affordance. It takes
  // precedence over the decision projection so a lagging PENDING value cannot
  // accidentally invite a second execution.
  if (approval.executionStatus === 'UNKNOWN') return '执行结果待核对';
  if (approval.decisionStatus === 'PENDING' || approval.decisionStatus === 'WAITING_DELAY') {
    if (approval.autoApproveAt && approval.serverTime && Date.parse(approval.autoApproveAt) > Date.parse(approval.serverTime)) return '等待延时确认';
    return '等待你的决定';
  }
  if (approval.decisionStatus === 'EXPIRED') return '已过期，需要重新准备';
  if (approval.decisionStatus === 'STALE') return '状态已变化，需要重新准备';
  if (approval.decisionStatus === 'CANCELLED') return '已取消';
  if (approval.decisionStatus === 'REJECTED') return '已拒绝';
  return approval.decisionStatus;
}

export interface DangerApprovalPanelProps {
  approval: ApprovalRequestLike;
  pending?: boolean;
  /** Endpoint capabilities are separate from server-projected allowedActions. */
  available?: { decide?: boolean; advance?: boolean; control?: boolean };
  onDecide: (approval: ApprovalRequestLike, decision: 'APPROVE' | 'REJECT' | 'EXECUTE') => void;
  onAdvance: (approval: ApprovalRequestLike) => void;
  onControl: (approval: ApprovalRequestLike, control: 'PAUSE_DELAY' | 'RESUME_DELAY' | 'CANCEL') => void;
}

/**
 * Dangerous approvals deliberately have their own template but remain in the
 * approval floating panel. One panel always represents one approvalId; callers must not
 * combine panels into a batch action.
 */
export function DangerApprovalPanel({ approval, pending = false, available, onDecide, onAdvance, onControl }: DangerApprovalPanelProps): React.JSX.Element {
  const category = approval.riskCategory;
  const shortCategory = category.match(/^D[1-4]/)?.[0] ?? category;
  const title = DANGER_LABELS[shortCategory] ? `${shortCategory} · ${DANGER_LABELS[shortCategory]}` : '风险操作 · 需要核对';
  const evidence = approval.riskEvidence ?? [];
  const target = approval.domainRef || '服务未提供具体目标';
  const effect = evidence.length > 0 ? evidence.join('；') : '服务未提供具体影响';
  const recovery = '执行层未提供已验证的恢复条件';
  const terminal = approval.decisionStatus !== 'PENDING' && approval.decisionStatus !== 'WAITING_DELAY';
  const unknown = approval.executionStatus === 'UNKNOWN';
  // UNKNOWN is a separate execution state: inspect/reconcile first; never
  // re-approve or re-execute an action whose side effect may already exist.
  const actionable = !terminal && !unknown;
  const canDecide = available?.decide ?? true;
  const canAdvanceEndpoint = available?.advance ?? true;
  const canControl = available?.control ?? true;
  const canApprove = actionable && canDecide && actionAvailable(approval, 'APPROVE');
  const canReject = actionable && canDecide && actionAvailable(approval, 'DENY');
  const canExecute = actionable && canDecide && actionAvailable(approval, 'EXECUTE');
  const canCancel = actionable && canControl && actionAvailable(approval, 'CANCEL');
  const canAdvance = actionable && canAdvanceEndpoint && actionAvailable(approval, 'ADVANCE');
  const canPause = actionable && canControl && actionAvailable(approval, 'PAUSE_DELAY');
  const canResume = actionable && canControl && actionAvailable(approval, 'RESUME_DELAY');

  return (
    <section className="approval-card danger-approval-panel" data-testid="danger-approval-panel" data-approval-id={approval.approvalId}>
      <div className="approval-heading">
        <span className="approval-icon" aria-hidden="true">!</span>
        <div>
          <strong>{title}</strong>
          <span>approval {approval.approvalId.slice(0, 12)} · 仅此一项操作</span>
        </div>
        <span className="badge badge-danger">{stateLabel(approval)}</span>
      </div>
      <p className="danger-summary">{approval.publicSummary}</p>
      <dl className="danger-evidence">
        <div><dt>具体目标</dt><dd>{target}</dd></div>
        <div><dt>可能后果</dt><dd>{effect}</dd></div>
        <div><dt>恢复条件</dt><dd>{recovery}</dd></div>
      </dl>
      <p className="run-meta">来源 Agent：{approval.agentId || '未提供'} · 域：{approval.domainRef}</p>
      {unknown ? <p className="danger-warning" role="status" aria-label="执行结果未知">执行结果未知。请先核对真实影响，不能用重新批准代替核对。</p> : null}
      {approval.decisionStatus === 'EXPIRED' || approval.decisionStatus === 'STALE' ? <p className="danger-warning" role="status">此许可不可恢复；请让服务重新准备新的请求。</p> : null}
      <div className="approval-actions danger-actions">
        {canReject ? <button type="button" aria-label="拒绝" className="danger-button" onClick={() => onDecide(approval, 'REJECT')} disabled={pending}>拒绝 <kbd>Ctrl 2</kbd></button> : null}
        {canAdvance ? <button type="button" className="secondary-button small" onClick={() => onAdvance(approval)} disabled={pending}>立即推进</button> : null}
        {canPause ? <button type="button" className="secondary-button small" onClick={() => onControl(approval, 'PAUSE_DELAY')} disabled={pending}>暂停倒计时</button> : null}
        {canResume ? <button type="button" className="secondary-button small" onClick={() => onControl(approval, 'RESUME_DELAY')} disabled={pending}>恢复倒计时</button> : null}
        {canCancel ? <button type="button" className="secondary-button small" onClick={() => onControl(approval, 'CANCEL')} disabled={pending}>取消请求</button> : null}
        <span className="approval-primary-cluster">
          {canExecute ? <button type="button" className="primary-button small" onClick={() => onDecide(approval, 'EXECUTE')} disabled={pending}>立即执行</button> : null}
          {canApprove ? <button type="button" aria-label="批准本次" className="primary-button small" onClick={() => onDecide(approval, 'APPROVE')} disabled={pending}>批准本次 <kbd>Ctrl 1</kbd></button> : null}
        </span>
      </div>
      <span className="run-meta">版本 {approval.version} · 指纹 {approval.requestFingerprint.slice(0, 12)}… · 风险许可不会批量合并</span>
    </section>
  );
}
