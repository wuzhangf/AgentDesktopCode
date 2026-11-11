import type { RunActivity } from './activityTypes';
import { activityKindLabel, headerCommandText } from './activityPresentation';

/** Small structural input keeps this pure model independent of renderer APIs. */
export interface DisplayRunLike {
  runId: string;
  state: string;
  sourceStatus?: string | null;
  startedAt?: string | null;
  finishedAt?: string | null;
  durationMillis?: number | null;
}

export type DisplayPhase =
  | 'IDLE'
  | 'SUBMITTING'
  | 'QUEUED'
  | 'RUNNING'
  | 'GENERATING'
  | 'WAITING_APPROVAL'
  | 'PAUSED'
  | 'STOP_REQUESTED'
  | 'SUCCEEDED'
  | 'FAILED'
  | 'CANCELLED'
  | 'UNKNOWN';

export type DisplayConnection = 'connected' | 'reconnecting' | 'syncing' | 'unknown';

export interface VisibleOutputLike {
  text?: string | null;
  lastUpdatedAt?: number | null;
}

export interface RunDisplayInput {
  sessionId: string;
  run: DisplayRunLike | null | undefined;
  activities: ReadonlyArray<RunActivity>;
  visibleOutput?: VisibleOutputLike | null;
  approvalPending?: boolean;
  budgetApprovalPending?: boolean;
  connection?: string | null;
  resyncing?: boolean;
  stopRequested?: boolean;
  submitting?: boolean;
  nowMs?: number;
  observedStartedAt?: number | null;
  activitiesAvailable?: boolean;
  loadedActivityCount?: number;
  activityHistoryComplete?: boolean;
  activityHistoryReason?: string | null;
  lastContentObservedAt?: number | null;
}

export interface RunDisplayModel {
  sessionId: string;
  runId: string | null;
  phase: DisplayPhase;
  connection: DisplayConnection;
  currentActivityIds: string[];
  headline: string;
  /** The service-supplied stage suffix (detail or compact command) inside
   * `headline` — rendered in a muted mono span by the status bar. */
  headlineDetail: string | null;
  elapsedMs: number | null;
  elapsedEstimated: boolean;
  lastContentObservedAt: number | null;
  noNewOutputSeconds: number | null;
  activitiesAvailable: boolean;
  loadedActivityCount: number;
  activityHistoryComplete: boolean;
  activityHistoryReason: string | null;
  canRequestStop: boolean;
  canLocateApproval: boolean;
  hasVisibleOutput: boolean;
}

const TERMINAL_STATES = new Set([
  'COMPLETED', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'INTERRUPTED',
  'TIMED_OUT', 'ABORTED', 'REJECTED', 'TERMINAL', 'NEEDS_ATTENTION'
]);

function validMillis(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function epochMillis(value: unknown): number | null {
  if (typeof value !== 'string' || value.trim().length === 0) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function connectionOf(value: string | null | undefined, resyncing: boolean): DisplayConnection {
  if (resyncing || value === 'SYNCING') return 'syncing';
  if (value === 'CONNECTED') return 'connected';
  if (value === 'RECONNECTING' || value === 'DISCONNECTED' || value === 'CONNECTING') return 'reconnecting';
  return 'unknown';
}

function currentActionDetail(activity: RunActivity | undefined): string | null {
  if (!activity) return null;
  if (activity.kind === 'COMMAND' || activity.kind === 'BUILD' || activity.kind === 'GIT') {
    // Design 2026-09-30 §5.4.3: the headline strips git instrumentation flags
    // just like the row header; the full command stays in the row body.
    const compact = headerCommandText(activity);
    if (compact) return compact;
  }
  return activity.detail ?? null;
}

function headlineFor(phase: DisplayPhase, input: RunDisplayInput, current: RunActivity | undefined): string {
  switch (phase) {
    case 'SUBMITTING': return '正在提交…';
    case 'QUEUED': return '已进入队列';
    case 'WAITING_APPROVAL': return input.budgetApprovalPending ? '等待预算批准' : '等待你的批准';
    case 'PAUSED': return '已暂停，可继续';
    case 'STOP_REQUESTED': return '正在请求停止…';
    case 'SUCCEEDED': return '已完成';
    case 'FAILED': return '执行失败';
    case 'CANCELLED': return '已停止';
    case 'GENERATING': return '正在生成回答';
    case 'RUNNING': {
      const detail = currentActionDetail(current);
      if (current) {
        return detail ? `${activityKindLabel(current.kind)} · ${detail}` : activityKindLabel(current.kind);
      }
      return input.activitiesAvailable === false
        ? 'Agent 运行中 · 当前服务未提供执行明细'
        : 'Agent 运行中 · 等待执行明细';
    }
    case 'UNKNOWN': return '状态待同步';
    default: return '就绪';
  }
}

function phaseFor(input: RunDisplayInput, currentActivity: RunActivity | undefined): DisplayPhase {
  const run = input.run;
  if (!run) {
    if (input.submitting) return 'SUBMITTING';
    if (input.approvalPending) return 'WAITING_APPROVAL';
    return 'IDLE';
  }
  if (run.state === 'FAILED' || run.state === 'TIMED_OUT' || run.state === 'ABORTED' || run.state === 'REJECTED') return 'FAILED';
  if (run.state === 'CANCELLED' || run.state === 'INTERRUPTED') return 'CANCELLED';
  if (run.state === 'COMPLETED' || run.state === 'SUCCEEDED') return 'SUCCEEDED';
  if (run.state === 'PAUSED' || run.sourceStatus === 'PAUSED_RETRYABLE') return 'PAUSED';
  if (run.state === 'NEEDS_ATTENTION') return 'UNKNOWN';
  if (TERMINAL_STATES.has(run.state)) return 'UNKNOWN';
  if (input.stopRequested) return 'STOP_REQUESTED';
  if (run.sourceStatus === 'WAITING_BUDGET_APPROVAL' || run.state === 'WAITING_BUDGET_APPROVAL'
      || run.state === 'WAITING_APPROVAL' || input.approvalPending) return 'WAITING_APPROVAL';
  if (run.state === 'QUEUED') return 'QUEUED';
  if (run.state !== 'RUNNING') return 'UNKNOWN';
  if (currentActivity) return 'RUNNING';
  if (input.visibleOutput?.text) return 'GENERATING';
  return 'RUNNING';
}

/** Pure, priority-ordered projection for the run status bar and transcript. */
export function deriveRunDisplayModel(input: RunDisplayInput): RunDisplayModel {
  const nowMs = input.nowMs ?? Date.now();
  const currentActivities = input.activities.filter((activity) => activity.status === 'RUNNING');
  const currentActivity = currentActivities[currentActivities.length - 1];
  const phase = phaseFor(input, currentActivity);
  const connection = connectionOf(input.connection, Boolean(input.resyncing));
  const run = input.run;
  const authoritativeDuration = validMillis(run?.durationMillis);
  const startedAt = epochMillis(run?.startedAt);
  const finishedAt = epochMillis(run?.finishedAt);
  const observedStartedAt = validMillis(input.observedStartedAt);
  let elapsedMs: number | null = authoritativeDuration;
  let elapsedEstimated = false;
  if (phase === 'PAUSED' && elapsedMs === null) {
    // A retryable pause has no terminal timestamp in the public DTO. Do not
    // keep advancing the observation clock while the run is waiting for an
    // explicit recovery command.
    elapsedMs = null;
  } else if (elapsedMs === null && startedAt !== null) {
    const end = finishedAt ?? nowMs;
    elapsedMs = Math.max(0, end - startedAt);
  } else if (elapsedMs === null && observedStartedAt !== null) {
    elapsedMs = Math.max(0, nowMs - observedStartedAt);
    elapsedEstimated = true;
  }
  const lastContentObservedAt = validMillis(input.lastContentObservedAt)
    ?? validMillis(input.visibleOutput?.lastUpdatedAt);
  const noNewOutputSeconds = lastContentObservedAt !== null && (phase === 'RUNNING' || phase === 'GENERATING')
    ? Math.max(0, Math.floor((nowMs - lastContentObservedAt) / 1000))
    : null;
  const canRequestStop = Boolean(run) && !TERMINAL_STATES.has(run?.state ?? '')
    && (phase === 'QUEUED' || phase === 'RUNNING' || phase === 'GENERATING');
  return {
    sessionId: input.sessionId,
    runId: run?.runId ?? null,
    phase,
    connection,
    currentActivityIds: currentActivities.map((activity) => activity.activityId),
    headline: headlineFor(phase, input, currentActivity),
    headlineDetail: phase === 'RUNNING' ? currentActionDetail(currentActivity) : null,
    elapsedMs,
    elapsedEstimated,
    lastContentObservedAt,
    noNewOutputSeconds,
    activitiesAvailable: input.activitiesAvailable !== false,
    loadedActivityCount: input.loadedActivityCount ?? input.activities.length,
    activityHistoryComplete: input.activityHistoryComplete !== false,
    activityHistoryReason: input.activityHistoryReason ?? null,
    canRequestStop,
    canLocateApproval: phase === 'WAITING_APPROVAL' || Boolean(input.approvalPending),
    hasVisibleOutput: Boolean(input.visibleOutput?.text)
  };
}

export interface PurposeExecutionGroup {
  key: string;
  runId: string;
  groupId: string | null;
  purpose: string | null;
  startNote: string | null;
  summary: string | null;
  status: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  activities: RunActivity[];
}

/**
 * Grouping is deliberately contract-only. If the service does not provide a
 * stable groupId, all activities remain in one factual compatibility group;
 * the renderer never guesses intent from adjacent prose or command names.
 */
export function groupActivitiesByPurpose(activities: ReadonlyArray<RunActivity>): PurposeExecutionGroup[] {
  if (activities.length === 0) return [];
  const hasStructuredGroups = activities.some((activity) => Boolean(activity.groupId?.trim()));
  if (!hasStructuredGroups) {
    const first = activities[0];
    if (!first) return [];
    return [{
      key: `${first.runId}:compatibility`, runId: first.runId, groupId: null,
      purpose: null, startNote: null, summary: null, status: null,
      startedAt: null, finishedAt: null, activities: [...activities]
    }];
  }
  const groups: PurposeExecutionGroup[] = [];
  const instances = new Map<string, number>();
  for (const activity of activities) {
    const groupId = activity.groupId?.trim() || null;
    const lookup = groupId ?? '__ungrouped__';
    const previous = groups[groups.length - 1];
    if (previous && previous.groupId === groupId && previous.key.startsWith(`${activity.runId}:${lookup}:`)) {
      previous.activities.push(activity);
      continue;
    }
    const instance = (instances.get(lookup) ?? 0) + 1;
    instances.set(lookup, instance);
    groups.push({
      key: `${activity.runId}:${lookup}:${instance}`,
      runId: activity.runId,
      groupId,
      purpose: activity.groupPurpose ?? null,
      startNote: activity.groupStartNote ?? null,
      summary: activity.groupSummary ?? null,
      status: activity.groupStatus ?? null,
      startedAt: activity.groupStartedAt ?? null,
      finishedAt: activity.groupFinishedAt ?? null,
      activities: [activity]
    });
  }
  return groups;
}
