import { type ReactNode } from 'react';

export type GovernanceApprovalKind = 'SPEC' | 'MISSION_PLAN' | 'MISSION_REPLAN';

function kindLabel(kind: GovernanceApprovalKind): string {
  switch (kind) {
    case 'SPEC': return 'Spec 审批';
    case 'MISSION_REPLAN': return 'Mission Replan 审批';
    default: return 'Mission Plan 审批';
  }
}

/**
 * Approval card for revisioned governance objects (Spec and Mission plan).
 * These decisions deliberately share the approval floating panel with run approvals;
 * the pane remains a read-only inspection surface. A card is actionable only
 * when the service capability and the revision fingerprint are both present.
 */
export function GovernanceApprovalCard(props: {
  kind: GovernanceApprovalKind;
  approvalId: string;
  revision?: number | null;
  fingerprint?: string | null;
  summary?: ReactNode;
  pending?: boolean;
  available?: boolean;
  unavailableReason?: string | null;
  onDecide: (decision: 'APPROVE' | 'REJECT') => void;
}): React.JSX.Element {
  const fingerprint = props.fingerprint?.trim() ?? '';
  const approvalId = props.approvalId.trim();
  const snapshotComplete = approvalId.length > 0 && fingerprint.length > 0;
  const actionable = snapshotComplete && props.available !== false && !props.pending;

  return (
    <section
      className="approval-card governance-approval-card"
      data-testid="governance-approval-card"
      data-approval-id={approvalId}
      data-approval-kind={props.kind}
    >
      <div className="approval-heading">
        <span className="approval-icon" aria-hidden="true">⌁</span>
        <div>
          <strong>{kindLabel(props.kind)}</strong>
          <span>{props.revision === null || props.revision === undefined ? 'revision unknown' : `revision ${props.revision}`}</span>
        </div>
      </div>
      {props.summary ? <p>{props.summary}</p> : null}
      <span className="run-meta">审批 ID {approvalId || 'unknown'} · fingerprint {fingerprint || 'unknown'}</span>
      {props.available === false ? (
        <span className="run-meta governance-approval-unavailable" role="status">
          当前服务未声明审批能力{props.unavailableReason ? `（${props.unavailableReason}）` : ''}，暂不可操作。
        </span>
      ) : !snapshotComplete ? (
        <span className="run-meta governance-approval-unavailable" role="status">
          审批快照不完整或已失效，已隐藏批准/拒绝操作，请刷新后重试。
        </span>
      ) : (
        <div className="approval-actions">
          <button
            type="button"
            data-testid="governance-approval-approve"
            disabled={!actionable}
            onClick={() => props.onDecide('APPROVE')}
          >
            批准
          </button>
          <button
            type="button"
            data-testid="governance-approval-reject"
            disabled={!actionable}
            onClick={() => props.onDecide('REJECT')}
          >
            拒绝
          </button>
        </div>
      )}
    </section>
  );
}
