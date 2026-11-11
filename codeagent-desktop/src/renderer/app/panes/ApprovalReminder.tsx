/**
 * Toast reminder for approvals pending in a different session. Pure
 * navigation: it never decides the approval itself.
 */
export function ApprovalReminder(props: {
  runId: string;
  budgetApproval: boolean;
  expired: boolean;
  sessionTitle: string | null;
  canOpenSession: boolean;
  onOpenSession: () => void;
  onDismiss: () => void;
}): React.JSX.Element {
  return (
    <div className="approval-reminder" data-testid="approval-reminder" role="status" aria-live="polite" aria-labelledby="approval-reminder-title">
      <div className="approval-reminder-header">
        <span className="approval-reminder-eyebrow">{props.expired ? 'AUTHORIZATION INVALID' : 'NEEDS APPROVAL'}</span>
        <button type="button" className="icon-button" aria-label="稍后处理审批" title="稍后处理" onClick={props.onDismiss}>×</button>
      </div>
      <h2 id="approval-reminder-title">{props.expired ? '授权已失效' : '运行需要审批'}</h2>
      <p className="approval-reminder-copy">{props.expired
        ? 'Service 已确认旧授权不可继续；打开对应会话查看状态。'
        : 'Service 已暂停这次运行；审批详情和决定按钮位于对应会话中。'}</p>
      <div className="approval-reminder-context">
        <strong>{props.sessionTitle ?? '当前会话'}</strong>
        <span>run {props.runId.slice(0, 8)} · {props.budgetApproval ? '预算审批' : '操作审批'}</span>
      </div>
      <div className="approval-reminder-actions">
        {props.canOpenSession ? <button type="button" className="primary-button" onClick={props.onOpenSession}>打开会话审批</button> : null}
        <button type="button" className="secondary-button" onClick={props.onDismiss}>稍后处理</button>
      </div>
    </div>
  );
}
