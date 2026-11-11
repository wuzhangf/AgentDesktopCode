import { useQuery } from '@tanstack/react-query';
import type {
  SessionEnvironmentSection,
  SessionEnvironmentToolchainRow,
  SessionSummaryDetail
} from '../../../electron/shared/api-types';
import type { ProjectLike, RunLike } from './queries';
import { unwrap, useRunActivities, useRunDiffSummary } from './queries';
import { formatDuration } from './activity/activityPresentation';
import { useRunDisplayClock } from './conversation/useRunDisplayClock';
import { PanelShell } from './ui/PanelShell';
import { StatusBadge, badgeTone } from './ui/StatusBadge';
import { activityActionLabel, envIssueLabel, runStateLabel } from './ui/labels';
import { runStateTone } from './sessionStatus';

const TERMINAL_RUN_STATES = new Set(['COMPLETED', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'INTERRUPTED', 'TIMED_OUT', 'ABORTED', 'REJECTED', 'TERMINAL', 'NEEDS_ATTENTION']);

function toolchainRow(row: SessionEnvironmentToolchainRow, index: number): React.JSX.Element {
  const name = row.executable ?? row.runner ?? '工具';
  if (row.available === null || row.available === undefined) {
    return <StatusBadge key={`${row.runner}-${index}`} tone="off" label={`? ${name}`} title="未解析到可执行文件" />;
  }
  return <StatusBadge key={`${row.runner}-${index}`} tone={row.available ? 'ok' : 'bad'} label={name} />;
}

function EnvironmentSection(props: {
  sessionId?: string | null;
  projectId?: string | null;
  onOpenBuildPlan?: () => void;
}): React.JSX.Element | null {
  const summary = useQuery({
    queryKey: ['session-summary', props.sessionId],
    enabled: props.sessionId != null,
    retry: false,
    queryFn: async () =>
      unwrap(await window.codeAgentDesktop.getSessionSummary(
        props.sessionId as string)) as SessionSummaryDetail
  });
  const refresh = useQuery({
    queryKey: ['session-summary-refresh', props.sessionId],
    enabled: false,
    retry: false,
    queryFn: async () =>
      unwrap(await window.codeAgentDesktop.getSessionSummary(
        props.sessionId as string, { refreshEnvironment: true })) as SessionSummaryDetail
  });
  const environment: SessionEnvironmentSection | null | undefined =
    (refresh.data ?? summary.data)?.environment;
  if (props.sessionId == null) return null;

  const toolchain = environment?.toolchain ?? [];
  const targets = environment?.targets ?? [];
  const verification = environment?.verification ?? null;
  const sortedTargets = [...targets].sort((a, b) => Number(Boolean(b.issue)) - Number(Boolean(a.issue)));
  const hasIssue = targets.some((target) => Boolean(target.issue));
  return (
    <section className="activity-summary-environment" data-testid="status-environment">
      <div className="activity-summary-section-head">
        <h3 className="activity-summary-section-title">环境</h3>
        <span className="activity-summary-environment-actions">
          {props.onOpenBuildPlan ? (
            <button type="button" className="link-button" onClick={props.onOpenBuildPlan}>验证计划</button>
          ) : null}
          <button type="button" className="link-button"
            disabled={refresh.isFetching}
            onClick={() => void refresh.refetch()}>重新探测</button>
        </span>
      </div>
      {environment == null ? (
        <p className="muted">未探测</p>
      ) : (
        <>
          <div className="env-toolchain">
            {toolchain.length === 0 ? <span className="muted">—</span> : toolchain.map(toolchainRow)}
          </div>
          <details className="env-targets" open={hasIssue || undefined}>
            <summary>构建目标（{targets.length}）</summary>
            {targets.length === 0 ? <p className="muted">未检测到</p> : (
              <div className="env-target-table">
                {sortedTargets.map((target) => (
                  <div key={target.targetId ?? `${target.tool}-${target.dir}`} className={`env-target-row${target.issue ? ' has-issue' : ''}`}>
                    <span className="env-target-icon" aria-hidden="true">{target.issue ? '⚠' : '✓'}</span>
                    <span className="env-target-dir" title={target.dir ?? '.'}>{target.dir ?? '.'}</span>
                    <span className="env-target-tool">{target.tool ?? '—'}</span>
                    <span className="env-target-issue" title={target.issue ?? undefined}>{target.issue ? envIssueLabel(target.issue) : ''}</span>
                  </div>
                ))}
              </div>
            )}
          </details>
          <div className="env-verification">
            <span className="env-verification-label">验证</span>
            <span>{verification == null ? '无记录'
              : `${verification.status ?? 'UNKNOWN'}${verification.failureCode ? ` · ${verification.failureCode}` : ''}`}</span>
          </div>
        </>
      )}
    </section>
  );
}

export function ActivitySummaryPanel(props: {
  run?: RunLike;
  project?: ProjectLike;
  sessionId?: string | null;
  canRead?: boolean;
  approvalSyncing?: boolean;
  onClose: () => void;
  onOpenGit: () => void;
  onOpenBuildPlan?: () => void;
}): React.JSX.Element {
  const runId = props.run?.runId ?? null;
  const activities = useRunActivities(runId, { enabled: props.canRead ?? true });
  const diff = useRunDiffSummary(runId, props.canRead ?? true);
  const runTerminal = props.run ? TERMINAL_RUN_STATES.has(props.run.state) : false;
  const clock = useRunDisplayClock(Boolean(props.run && !runTerminal));
  const items = activities.data?.items ?? [];
  const subagents = items.filter((item) => item.kind === 'DELEGATION'
    || `${item.kind} ${item.toolName ?? ''} ${item.detail ?? ''}`.toLowerCase().includes('subagent'));
  const runningSubagents = subagents.filter((item) => item.status.toUpperCase().includes('RUN')).length;
  const finishedSubagents = subagents.filter((item) => !item.status.toUpperCase().includes('RUN')).length;
  const branch = (props.project as (ProjectLike & { branch?: string | null; branchName?: string | null }) | undefined)?.branchName
    ?? (props.project as (ProjectLike & { branch?: string | null }) | undefined)?.branch
    ?? null;
  const action = activityActionLabel(
    [...items].reverse().find((item) => item.status.toUpperCase().includes('RUN'))?.detail
      ?? [...items].reverse()[0]?.detail
  ) || runStateLabel(props.run?.state);
  // Elapsed time only renders when the run carries real timestamps — the
  // clock ticks locally, it never invents a start time.
  const startMillis = props.run?.startedAt ? Date.parse(props.run.startedAt) : NaN;
  const endMillis = props.run?.finishedAt ? Date.parse(props.run.finishedAt)
    : Number.isFinite(startMillis) ? clock : NaN;
  const elapsed = Number.isFinite(startMillis) && Number.isFinite(endMillis)
    ? formatDuration(endMillis - startMillis)
    : null;
  const activityCount = activities.data?.summary.activityCount ?? null;
  const workspaceAlias = props.run?.workspaceAlias ?? null;

  return (
    <PanelShell
      title="状态"
      className="activity-summary-panel"
      testId="activity-summary-panel"
      ariaLabel="状态摘要"
      status={props.run ? (
        <StatusBadge
          tone={props.approvalSyncing ? 'busy' : badgeTone(runStateTone(props.run.state))}
          label={props.approvalSyncing ? '审批已接收 · 状态同步中' : runStateLabel(props.run.state)}
        />
      ) : null}
      subtitle={props.run ? `run ${runId?.slice(0, 8)}${workspaceAlias ? ` · ${workspaceAlias}` : ''}` : undefined}
      closeLabel="关闭状态面板"
      onClose={props.onClose}
    >
      {!props.run ? <div className="empty-state">当前没有可查看的运行。发送一条消息后，这里会显示真实运行、diff 和活动摘要。</div> : (
        <>
          <dl className="activity-summary-facts">
            <div><dt>正在做</dt><dd>{action}</dd></div>
            {elapsed != null ? (
              <div><dt>已运行</dt><dd>{elapsed}{activityCount != null ? ` · ${activityCount} 项活动` : ''}</dd></div>
            ) : activityCount != null ? (
              <div><dt>已运行</dt><dd>{activityCount} 项活动</dd></div>
            ) : null}
            <div><dt>子代理</dt><dd>{subagents.length === 0 ? '未启动' : `${runningSubagents} 运行中 · ${finishedSubagents} 已结束`}</dd></div>
            {branch ? <div><dt>分支</dt><dd><code>{branch}</code></dd></div> : null}
          </dl>
          <section className="activity-summary-changes" data-testid="activity-summary-metrics">
            <h3 className="activity-summary-section-title">变更</h3>
            {!runTerminal ? (
              <p className="muted">变更会在 Run 结束后统计</p>
            ) : diff.data ? (
              <p className="activity-summary-diff-line">
                {diff.data.files} 个文件
                <strong className="positive">+{diff.data.additions}</strong>
                <strong className="negative">−{diff.data.deletions}</strong>
                {diff.data.complete === false ? '（不完整）' : ''}
                <button type="button" className="link-button" onClick={props.onOpenGit}>查看变更 →</button>
              </p>
            ) : diff.isError ? (
              <p className="muted">当前运行尚未产生完整 diff，统计将在 Service 发布变更工件后更新。</p>
            ) : (
              <p className="muted">正在统计变更…</p>
            )}
          </section>
        </>
      )}
      {/* §7.4 环境段：只摆构建/验证事实，不渲染 recovery/建议。
          Session-scoped — renders even when no run exists yet, so the panel
          carries real content instead of one empty line. */}
      <EnvironmentSection
        sessionId={props.sessionId ?? props.run?.sessionId}
        projectId={props.project?.projectId}
        onOpenBuildPlan={props.onOpenBuildPlan} />
    </PanelShell>
  );
}
