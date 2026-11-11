import { useEffect, useRef, useState } from 'react';
import type { DisplayPhase, PurposeExecutionGroup as PurposeGroupModel } from '../activity/runDisplayModel';
import { activityKindLabel, isFailedStatus } from '../activity/activityPresentation';
import { CliActivityRow, formatCliElapsed } from './CliActivityRow';

function parseTime(value?: string | null): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function localDateTime(value?: string | null): string | null {
  const parsed = parseTime(value);
  return parsed === null ? null : new Intl.DateTimeFormat(undefined, {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  }).format(parsed);
}

const TERMINAL_ACTIVITY_STATES = new Set(['SUCCEEDED', 'FAILED', 'PARTIAL', 'TIMED_OUT', 'ABORTED', 'REJECTED', 'CANCELLED', 'UNKNOWN']);

function groupIsTerminal(group: PurposeGroupModel): boolean {
  if (group.status) return TERMINAL_ACTIVITY_STATES.has(group.status);
  return group.activities.length > 0 && group.activities.every((activity) => TERMINAL_ACTIVITY_STATES.has(activity.status));
}

function groupElapsed(group: PurposeGroupModel, nowMs: number): number | null {
  const explicitStart = parseTime(group.startedAt);
  const explicitEnd = parseTime(group.finishedAt);
  if (explicitStart !== null) return Math.max(0, (explicitEnd ?? nowMs) - explicitStart);
  const starts = group.activities.map((activity) => parseTime(activity.startedAt)).filter((value): value is number => value !== null);
  if (starts.length === 0) return null;
  const ends = group.activities.map((activity) => parseTime(activity.finishedAt)).filter((value): value is number => value !== null);
  return Math.max(0, (ends.length > 0 ? Math.max(...ends) : nowMs) - Math.min(...starts));
}

function summaryFor(group: PurposeGroupModel, terminalActivityMissing: boolean): string {
  if (terminalActivityMissing) return '结束状态未同步：仍有活动缺少终态';
  if (group.summary?.trim()) return group.summary.trim();
  if (group.status === 'CANCELLED' || group.activities.some((activity) => activity.status === 'CANCELLED')) return '本组已停止';
  if (group.status === 'UNKNOWN') return '组结束状态未知，需要同步确认';
  if (group.status === 'FAILED' || group.status === 'TIMED_OUT' || group.status === 'ABORTED' || group.status === 'REJECTED') return `本组执行${group.status === 'TIMED_OUT' ? '超时' : '失败'}`;
  if (group.status === 'PARTIAL') return '本组部分完成';
  const failed = group.activities.filter((activity) => isFailedStatus(activity.status) || activity.status === 'PARTIAL').length;
  const unknown = group.activities.filter((activity) => activity.effectState === 'UNKNOWN' || activity.status === 'UNKNOWN').length;
  if (unknown > 0) return `效果未知：${unknown} 项活动需要确认`;
  if (failed > 0) return `本组有 ${failed} 项活动未成功`;
  if (group.activities.length === 0) return '本组已结束 · 总结待同步';
  return `已完成 ${group.activities.length} 项活动`;
}

export function PurposeExecutionGroup(props: {
  group: PurposeGroupModel;
  live: boolean;
  phase?: DisplayPhase;
  nowMs: number;
  observedStartedAt?: number | null;
  /** Absolute workspace root for file-path tooltips (display only). */
  workspaceRoot?: string | null;
  /** Owning session id for session-scoped evidence-artifact reads. */
  sessionId?: string | null;
  /** Owning run id — activity payloads may omit runId; rows need it for
   * the write-diff lookup. */
  runId?: string | null;
  /** Owning run reached a terminal state. */
  runTerminal?: boolean | null;
  onOpenFile?: (fileRef: string, startLine?: number | null, runId?: string) => void;
}): React.JSX.Element {
  const terminalPhase = props.phase === 'SUCCEEDED' || props.phase === 'FAILED' || props.phase === 'CANCELLED' || props.phase === 'UNKNOWN';
  const hasUnfinishedActivity = props.group.activities.some((activity) => !TERMINAL_ACTIVITY_STATES.has(activity.status));
  const terminal = !props.live && (groupIsTerminal(props.group) || terminalPhase);
  const hasDelegation = props.group.activities.some((activity) => activity.kind === 'DELEGATION');
  const cancelled = props.group.status === 'CANCELLED' || props.group.activities.some((activity) => activity.status === 'CANCELLED');
  const hasAttention = props.group.activities.some((activity) => isFailedStatus(activity.status)
    || activity.status === 'PARTIAL' || activity.status === 'CANCELLED' || activity.status === 'WAITING_APPROVAL' || activity.effectState === 'UNKNOWN')
    || props.group.status === 'UNKNOWN' || props.group.status === 'FAILED' || props.group.status === 'PARTIAL'
    || props.group.status === 'TIMED_OUT' || props.group.status === 'ABORTED' || props.group.status === 'REJECTED'
    || (terminal && hasUnfinishedActivity);
  const [open, setOpen] = useState(props.live || !terminal || hasAttention || hasDelegation);
  const interactedRef = useRef(false);
  const wasLiveRef = useRef(props.live);
  useEffect(() => {
    const hasSelectedText = typeof window !== 'undefined' && Boolean(window.getSelection?.()?.toString());
    if (hasDelegation && !interactedRef.current) {
      setOpen(true);
    } else if (wasLiveRef.current && !props.live && !interactedRef.current && !hasAttention && !hasSelectedText) {
      setOpen(false);
    }
    wasLiveRef.current = props.live;
  }, [hasAttention, hasDelegation, props.live]);
  const running = props.group.activities.filter((activity) => activity.status === 'RUNNING');
  const paused = props.phase === 'WAITING_APPROVAL' || props.phase === 'STOP_REQUESTED' || props.phase === 'UNKNOWN';
  const elapsed = formatCliElapsed(groupElapsed(props.group, props.nowMs));
  const purpose = props.group.purpose?.trim() || '执行过程';
  const startNote = props.group.startNote?.trim() || (props.group.groupId ? purpose : '执行过程（服务未提供目的说明）');
  const stateText = props.phase === 'WAITING_APPROVAL'
    ? '等待你的批准'
    : props.phase === 'STOP_REQUESTED'
      ? '正在请求停止…'
      : props.live
        ? running.length > 0
          ? `正在${activityKindLabel(running[running.length - 1]?.kind ?? 'OTHER')} · 本组已运行 ${elapsed ?? '未知'}`
          : 'Agent 运行中 · 等待执行明细'
        : summaryFor(props.group, terminal && hasUnfinishedActivity);
  const activityCount = props.group.activities.length;
  return (
    <section className={`cli-purpose-group${props.live ? ' is-live' : ''}${terminal ? ' is-finished' : ''}${hasAttention ? ' has-attention' : ''}`} data-purpose-group={props.group.key}>
      <div className="cli-purpose-intro"><span className="cli-agent-mark" aria-hidden="true">✦</span><span>{startNote}</span></div>
      <button
        type="button"
        className="cli-purpose-summary"
        aria-expanded={open}
        aria-controls={`details-${props.group.key}`}
        onClick={() => { interactedRef.current = true; setOpen((value) => !value); }}
      >
        <span className={`cli-purpose-glyph${props.live && !paused ? ' is-running' : ''}`} aria-hidden="true">{props.phase === 'WAITING_APPROVAL' ? 'Ⅱ' : props.phase === 'STOP_REQUESTED' ? '…' : props.live ? '⠋' : cancelled ? '×' : hasAttention ? '!' : '▶'}</span>
        <span className="cli-purpose-state">{stateText}</span>
        {activityCount > 0 ? <span className="cli-purpose-count">· {activityCount} 项活动</span> : null}
        {elapsed ? <span className="cli-purpose-duration">· {props.live ? '已运行 ' : '耗时 '}{elapsed}</span> : null}
        <span className="cli-purpose-caret" aria-hidden="true">{open ? '▾' : '▸'}</span>
      </button>
      {open ? (
        <div id={`details-${props.group.key}`} className="cli-purpose-details">
          {props.group.groupId || props.group.startedAt || props.group.finishedAt ? <div className="cli-group-facts">
            {props.group.groupId ? <span>目的组 {props.group.groupId}</span> : null}
            {props.group.status ? <span>组状态 {props.group.status}</span> : null}
            {localDateTime(props.group.startedAt) ? <span>组开始 {localDateTime(props.group.startedAt)}</span> : null}
            {localDateTime(props.group.finishedAt) ? <span>组结束 {localDateTime(props.group.finishedAt)}</span> : null}
          </div> : null}
          {props.group.activities.map((activity) => <CliActivityRow key={`${activity.runId}:${activity.activityId}`} activity={activity} nowMs={props.nowMs} observedStartedAt={props.observedStartedAt} defaultOpen={props.live && activity.status === 'RUNNING'} workspaceRoot={props.workspaceRoot} sessionId={props.sessionId} runId={props.runId} runTerminal={props.runTerminal} onOpenFile={props.onOpenFile} />)}
          {props.group.activities.length === 0 ? <span className="cli-detail-line">本组活动尚未同步。</span> : null}
        </div>
      ) : null}
    </section>
  );
}
