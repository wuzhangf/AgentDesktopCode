/**
 * Lively approval card: per-type accent, arrival animation, live waiting
 * timer. Pure view state — every decision still goes through the service
 * fingerprint guard in App. Keyboard shortcuts (Ctrl+1/Ctrl+2) are handled once in
 * App so multiple pendings never double-fire. The card is rendered in the
 * automatic approval reminder, so it must not create a permanent approval
 * surface in the composer.
 */
import type { RunLike } from '../queries';

export type ApprovalKind = 'WRITE' | 'COMMAND' | 'BUDGET' | 'TERMINAL' | 'SANDBOX';

export interface WritePendingLike {
  path?: string;
  operation?: string;
  reason?: string;
  toolName?: string;
  taskScopeEntries?: string[];
}

export function formatWaiting(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  if (seconds < 60) return `已等待 ${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `已等待 ${minutes} 分钟`;
  return `已等待 ${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`;
}

export function ApprovalCard(props: {
  run: RunLike;
  kind: ApprovalKind;
  summary: string | null;
  fingerprintReady: boolean;
  writePending: WritePendingLike | null;
  pending: boolean;
  /** seconds since the renderer first saw this run waiting */
  waitingSeconds: number;
  /** true only for the newest arrival: plays the enter animation */
  fresh: boolean;
  onDecide: (decision: 'APPROVE' | 'REJECT') => void;
}): React.JSX.Element {
  const { run, kind } = props;
  const title = kind === 'WRITE' ? '写入审批' : kind === 'BUDGET' ? '预算审批' : kind === 'TERMINAL' ? 'Agent 终端审批' : kind === 'SANDBOX' ? 'Sandbox 命令审批' : '命令审批';
  const wp = props.writePending;
  const reasonLabel = wp?.reason === 'POLICY_ALL_WRITES' ? '当前策略要求所有写入都经过审批' : '目标路径超出批准的写入范围';
  const urgent = props.waitingSeconds >= 120;

  return (
    <div
      className={`approval-card approval-${kind.toLowerCase()}${props.fresh ? ' approval-enter' : ''}${urgent ? ' approval-urgent' : ''}`}
      id={`approval-card-${run.runId}`}
      data-testid="approval-card"
      role="alert"
      aria-label={`${title}，${formatWaiting(props.waitingSeconds)}`}
    >
      <div className="approval-heading">
        <span className="approval-icon" aria-hidden="true">!</span>
        <div>
          <strong>{title}</strong>
          <span>需要你的决定 · run {run.runId.slice(0, 8)} · {formatWaiting(props.waitingSeconds)}</span>
        </div>
        <span className={`badge${urgent && !props.pending ? ' badge-urgent' : ' stale'}`}>{props.pending ? '已提交 · 待确认' : urgent ? '等待较久' : '待处理'}</span>
      </div>
      {kind === 'WRITE' && wp ? (
        <p>{reasonLabel}：<code>{wp.path ?? '未知路径'}</code>（{wp.toolName ?? 'write'} · {wp.operation ?? 'WRITE'}）</p>
      ) : (
        <p className="approval-subject">{props.summary ?? '服务请求继续执行该步骤'}</p>
      )}
      {kind === 'WRITE' && Array.isArray(wp?.taskScopeEntries) && (wp?.taskScopeEntries?.length ?? 0) > 0 ? (
        <p className="run-meta">批准范围：{(wp?.taskScopeEntries ?? []).join('、')}</p>
      ) : null}
      {props.pending ? (
        <div className="approval-actions" aria-live="polite">
          <span className="run-meta approval-submitted" role="status">决定已提交 · 等待服务确认…</span>
        </div>
      ) : (
        <div className="approval-actions">
          <button type="button" className="danger-button" onClick={() => props.onDecide('REJECT')}>
            拒绝 <kbd>Ctrl 2</kbd>
          </button>
          <span className="approval-primary-cluster">
            <button
              type="button"
              aria-label={kind === 'WRITE' ? '批准写入' : kind === 'TERMINAL' ? '批准终端会话' : kind === 'SANDBOX' ? '批准沙箱命令' : '批准'}
              className="primary-button small"
              onClick={() => props.onDecide('APPROVE')}
            >
              {kind === 'WRITE' ? '批准本次写入' : kind === 'TERMINAL' ? '批准本次终端会话' : kind === 'SANDBOX' ? '批准本次沙箱命令' : '批准一次'} <kbd>Ctrl 1</kbd>
            </button>
          </span>
        </div>
      )}
      <span className="run-meta">
        {kind === 'WRITE'
          ? '批准只对本次 Run 内的同一路径生效；.git 等受保护目录仍然被拒绝。'
          : kind === 'TERMINAL'
            ? '批准只授予当前 Agent Run 的终端会话；后续新的终端请求仍需单独审批。'
          : kind === 'SANDBOX'
            ? '批准只对本次 sandbox_shell 调用生效；脚本仍在网络关闭的 OCI staging 容器中执行。'
          : props.fingerprintReady
            ? '请求指纹已就绪 · 决定受服务端版本保护'
            : '请求指纹缺失 · 服务端将拒绝不完整决定'}
      </span>
    </div>
  );
}

/** Terminal presentation for a request whose service-owned authorization
 * window has elapsed.  It deliberately has no decision controls: an expired
 * fingerprint must never be revived by the renderer. */
export function AuthorizationExpiredCard(props: {
  run: RunLike;
  kind: ApprovalKind;
  reasonCode: string;
  message: string;
}): React.JSX.Element {
  const title = props.kind === 'SANDBOX' ? 'Sandbox 授权已失效' : '授权已失效';
  return (
    <div
      className="approval-card approval-expired"
      id={`approval-card-${props.run.runId}`}
      data-testid="approval-expired-card"
      role="status"
      aria-label={`${title}，run ${props.run.runId.slice(0, 8)}`}
    >
      <div className="approval-heading">
        <span className="approval-icon" aria-hidden="true">×</span>
        <div>
          <strong>{title}</strong>
          <span>run {props.run.runId.slice(0, 8)} · Service 已确认不可继续</span>
        </div>
        <span className="badge stale">不可操作</span>
      </div>
      <p>{props.message}</p>
      <span className="run-meta">原因：{props.reasonCode} · 请重新发起一次新的运行；不会复活旧授权。</span>
    </div>
  );
}
