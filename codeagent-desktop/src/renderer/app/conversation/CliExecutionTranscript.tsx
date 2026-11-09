import type { RunActivity } from '../activity/activityTypes';
import { activityHistoryReasonLabel } from '../activity/activityPresentation';
import { groupActivitiesByPurpose, type DisplayPhase } from '../activity/runDisplayModel';
import { PurposeExecutionGroup } from './PurposeExecutionGroup';

export function CliExecutionTranscript(props: {
  runId: string;
  activities: ReadonlyArray<RunActivity>;
  live: boolean;
  /** Owning run reached a terminal state; forwarded to write rows so the
   * 变更内容 section knows the run diff artifact can exist. */
  runTerminal?: boolean | null;
  nowMs: number;
  activitiesAvailable: boolean;
  unavailableReason?: string | null;
  observedStartedAt?: number | null;
  phase?: DisplayPhase;
  loadedActivityCount?: number;
  activityHistoryComplete?: boolean;
  activityHistoryReason?: string | null;
  /** Absolute workspace root for file-path tooltips (display only). */
  workspaceRoot?: string | null;
  /** Owning session id for session-scoped evidence-artifact reads. */
  sessionId?: string | null;
  onOpenFile?: (fileRef: string, startLine?: number | null, runId?: string) => void;
}): React.JSX.Element {
  const phase = props.phase ?? (props.live ? 'RUNNING' : 'SUCCEEDED');
  const paused = phase === 'WAITING_APPROVAL' || phase === 'STOP_REQUESTED' || phase === 'UNKNOWN';
  if (!props.activitiesAvailable) {
    return <div className="cli-execution-transcript cli-execution-unavailable" data-testid="activity-unavailable">{phase === 'WAITING_APPROVAL' ? '等待批准 · 当前服务未提供执行明细' : 'Agent 运行中 · 当前服务未提供执行明细'}{props.unavailableReason ? `（${props.unavailableReason}）` : ''}</div>;
  }
  const groups = groupActivitiesByPurpose(props.activities);
  if (groups.length === 0) {
    return props.live
      ? <div className="cli-execution-transcript cli-execution-empty" data-testid="cli-execution-empty"><span className={`cli-purpose-glyph${paused ? '' : ' is-running'}`} aria-hidden="true">{phase === 'WAITING_APPROVAL' ? 'Ⅱ' : phase === 'STOP_REQUESTED' ? '…' : '⠋'}</span> {phase === 'WAITING_APPROVAL' ? '等待你的批准 · 执行明细待同步' : phase === 'STOP_REQUESTED' ? '正在请求停止… · 执行明细待同步' : 'Agent 运行中 · 等待执行明细'}</div>
      : <div className="cli-execution-transcript cli-execution-empty">没有已加载的执行活动</div>;
  }
  return (
    <div className="cli-execution-transcript" data-run-id={props.runId}>
      {groups.map((group, index) => <PurposeExecutionGroup key={group.key} group={group} live={props.live && index === groups.length - 1} phase={phase} nowMs={props.nowMs} observedStartedAt={props.observedStartedAt} workspaceRoot={props.workspaceRoot} sessionId={props.sessionId} runId={props.runId} runTerminal={props.runTerminal ?? !props.live} onOpenFile={props.onOpenFile} />)}
      {props.activityHistoryComplete === false ? <div className="cli-activity-completeness">已加载 {props.loadedActivityCount ?? props.activities.length} 项活动 · 快照不完整{props.activityHistoryReason ? `（${activityHistoryReasonLabel(props.activityHistoryReason)}）` : ''}，更多记录按需加载</div> : null}
    </div>
  );
}
