import type { ApprovalRequestLike } from '../queries';

// EXTENSION (WU08) is emitted by the current service; the pinned contract
// snapshot enum predates it, so the label map accepts the wider string.
function kindLabel(kind: ApprovalRequestLike['kind'] | string): string {
  switch (kind) {
    case 'COMMAND': return '命令';
    case 'WRITE': return '写入';
    case 'BUDGET': return '预算';
    case 'SANDBOX': return '沙箱';
    case 'SPEC': return 'Spec';
    case 'PLAN': return '计划';
    case 'REPLAN': return '重新规划';
    case 'EXTENSION': return '扩展';
    default: return '执行';
  }
}

function stateLabel(approval: ApprovalRequestLike): string {
  if (approval.executionStatus === 'UNKNOWN') return '执行结果待核对';
  if (approval.decisionStatus === 'PENDING' || approval.decisionStatus === 'WAITING_DELAY') {
    if (approval.autoApproveAt && approval.serverTime && Date.parse(approval.autoApproveAt) > Date.parse(approval.serverTime)) return '延时自动批准中';
    return '等待你的决定';
  }
  if (approval.decisionStatus === 'EXPIRED') return '已过期';
  if (approval.decisionStatus === 'STALE') return '状态已变化';
  return approval.decisionStatus;
}

export function UnifiedApprovalCard(props: {
  approval: ApprovalRequestLike;
  pending?: boolean;
  available?: { decide?: boolean; advance?: boolean; control?: boolean };
  onDecide: (approval: ApprovalRequestLike, decision: 'APPROVE' | 'REJECT' | 'EXECUTE') => void;
  onAdvance: (approval: ApprovalRequestLike) => void;
  onControl: (approval: ApprovalRequestLike, control: 'PAUSE_DELAY' | 'RESUME_DELAY' | 'CANCEL') => void;
}): React.JSX.Element {
  const { approval } = props;
  const can = (action: string) => approval.executionStatus !== 'UNKNOWN'
    && (approval.decisionStatus === 'PENDING' || approval.decisionStatus === 'WAITING_DELAY')
    && (action === 'ADVANCE' ? (props.available?.advance ?? true)
      : ['PAUSE_DELAY', 'RESUME_DELAY', 'CANCEL'].includes(action) ? (props.available?.control ?? true)
        : (props.available?.decide ?? true))
    && Array.isArray(approval.allowedActions)
    && (approval.allowedActions as string[]).includes(action);
  const target = approval.domainRef || null;
  return (
    <section className="approval-card unified-approval-card" data-testid="unified-approval-card" data-approval-id={approval.approvalId} data-approval-kind={approval.kind}>
      <div className="approval-heading">
        <span className="approval-icon" aria-hidden="true">✓</span>
        <div><strong>{kindLabel(approval.kind)}审批</strong><span>{approval.agentId || 'Agent'} 发起</span></div>
        <span className="badge stale">{stateLabel(approval)}</span>
      </div>
      <p className="approval-subject">{approval.publicSummary}</p>
      {target ? <p className="run-meta approval-target">目标：<code>{target}</code></p> : null}
      {approval.decisionStatus === 'STALE' || approval.decisionStatus === 'EXPIRED' ? <p className="danger-warning" role="status">当前许可不可操作，需由服务重新准备；不会复活旧请求。</p> : null}
      {approval.executionStatus === 'UNKNOWN' ? <p className="danger-warning" role="status">执行结果未知。请先核对真实影响，不能用重新批准代替核对。</p> : null}
      <div className="approval-actions">
        {can('DENY') ? <button type="button" aria-label="拒绝" className="danger-button" onClick={() => props.onDecide(approval, 'REJECT')} disabled={props.pending}>拒绝 <kbd>Ctrl 2</kbd></button> : null}
        {can('ADVANCE') ? <button type="button" className="secondary-button small" onClick={() => props.onAdvance(approval)} disabled={props.pending}>立即推进</button> : null}
        {can('PAUSE_DELAY') ? <button type="button" className="secondary-button small" onClick={() => props.onControl(approval, 'PAUSE_DELAY')} disabled={props.pending}>暂停倒计时</button> : null}
        {can('RESUME_DELAY') ? <button type="button" className="secondary-button small" onClick={() => props.onControl(approval, 'RESUME_DELAY')} disabled={props.pending}>恢复倒计时</button> : null}
        {can('CANCEL') ? <button type="button" className="secondary-button small" onClick={() => props.onControl(approval, 'CANCEL')} disabled={props.pending}>取消请求</button> : null}
        <span className="approval-primary-cluster">
          {can('EXECUTE') ? <button type="button" className="primary-button small" onClick={() => props.onDecide(approval, 'EXECUTE')} disabled={props.pending}>立即执行</button> : null}
          {can('APPROVE') ? <button type="button" aria-label="批准" className="primary-button small" onClick={() => props.onDecide(approval, 'APPROVE')} disabled={props.pending}>批准 <kbd>Ctrl 1</kbd></button> : null}
        </span>
      </div>
      <span className="run-meta">approval {approval.approvalId.slice(0, 12)} · 版本 {approval.version} · 请求指纹 {approval.requestFingerprint.slice(0, 12)}…</span>
    </section>
  );
}
