/**
 * Round-block transcript (design 2026-09-19 §3/§4.2).
 *
 * Replaces the purpose-group timeline for round-capable data: activities,
 * per-round output text and per-round reasoning fold into RoundBlocks by
 * explicit roundId. Items without a roundId keep their actual event
 * position as flat ungrouped sections; ungrouped text stays in the
 * run-level fallback rows (§5.2) — nothing is ever assigned to a
 * fabricated round.
 */
import { memo, useMemo, useState } from 'react';
import type { RunActivity } from '../activity/activityTypes';
import type { DisplayPhase } from '../activity/runDisplayModel';
import { activityHistoryReasonLabel, isAttentionWorthy, isFailedStatus } from '../activity/activityPresentation';
import {
  answerYieldRoundId,
  deriveRoundTranscript,
  type RoundTextBucketLike
} from '../activity/roundDisplayModel';
import { CliActivityRow, formatCliElapsed } from './CliActivityRow';
import { RoundBlock, roundPinsOpen } from './RoundBlock';
import { ContentRenderer } from '../ContentRenderer';
import { Icon } from '../Icon';

/** Run-level fallback for output frames that carried no roundId (§5.2).
 * It mirrors the old transient bubble: hidden once the run is terminal
 * and the authoritative answer/snapshot owns the text. */
function UngroupedOutputRow(props: { bucket: RoundTextBucketLike; live: boolean }): React.JSX.Element {
  const { bucket } = props;
  const hasStats = typeof bucket.receivedBytes === 'number';
  return (
    <div className={`round-ungrouped-output${props.live ? ' is-live' : ''}`} data-testid="ungrouped-output">
      <ContentRenderer text={bucket.text} className="round-prompt-text" />
      {props.live ? <span className="streaming-caret" aria-hidden="true" /> : null}
      {bucket.interrupted ? <span className="round-note">输出中断，正在同步最终响应…</span> : null}
      {hasStats ? (
        <span className="sr-only">已接收 {bucket.receivedBytes} / {bucket.totalBytes ?? 0} 字节；序号 {bucket.lastSequence ?? 0}；丢弃 {bucket.droppedChunks ?? 0} 段</span>
      ) : null}
    </div>
  );
}

/** Run-level fallback for reasoning frames that carried no roundId (§5.2).
 * Like the old run-level ReasoningBlock it survives run.terminal. */
function UngroupedReasoningRow(props: { bucket: RoundTextBucketLike; live: boolean }): React.JSX.Element {
  return (
    <details className="round-thinking is-standalone" data-testid="ungrouped-reasoning" open={props.live}>
      <summary className="round-thinking-summary">
        <span className="round-thinking-glyph" aria-hidden="true"><Icon name="thinking" size={14} /></span>
        <span className="round-thinking-label">{props.live ? '正在思考…' : '思考过程'}</span>
        <span className="round-caret" aria-hidden="true">▾</span>
      </summary>
      <div className="round-thinking-text"><ContentRenderer text={props.bucket.text} /></div>
    </details>
  );
}

/** Design 2026-09-30 §5.4.1: compact kind bucket label for the fold summary. */
function summaryKindBucket(kind: string): string | null {
  if (kind === 'FILE_READ') return '读取';
  if (kind === 'FILE_LIST' || kind === 'FILE_LOOKUP' || kind === 'CODE_SEARCH' || kind === 'JAVA_SEMANTIC') return '查找';
  if (kind === 'COMMAND' || kind === 'BUILD' || kind === 'GIT') return '命令';
  if (kind === 'FILE_WRITE') return '修改';
  if (kind.startsWith('WEB_')) return '网络';
  if (kind === 'DELEGATION') return '子任务';
  return null;
}

// §5.4.1: fold choice is remembered per runId like the per-round memory in
// RoundBlock — live→history remounts must not reset the user's choice.
const foldMemory = new Map<string, boolean>();
const FOLD_MEMORY_LIMIT = 4_096;

function rememberFold(runId: string, open: boolean): void {
  if (foldMemory.size >= FOLD_MEMORY_LIMIT) foldMemory.clear();
  foldMemory.set(runId, open);
}

export const RoundTranscript = memo(function RoundTranscript(props: {
  runId: string;
  activities: ReadonlyArray<RunActivity>;
  /** Per-round visible-output buckets (live fold or snapshot segments). */
  outputRounds?: ReadonlyArray<RoundTextBucketLike> | null;
  /** Per-round reasoning buckets. */
  reasoningRounds?: ReadonlyArray<RoundTextBucketLike> | null;
  /** Run-level fallback buckets from frames without roundId (§5.2). */
  ungroupedOutput?: RoundTextBucketLike | null;
  ungroupedReasoning?: RoundTextBucketLike | null;
  /** True while the owning run is non-terminal. */
  live: boolean;
  /** Owning run reached a terminal state. */
  runTerminal: boolean;
  /** §4.4: the run's answer message exists (enables answer-round dedup). */
  answerMessagePresent?: boolean;
  /** §4.4 explicit dedup key when the message contract carries it. */
  messageRoundId?: string | null;
  nowMs: number;
  phase?: DisplayPhase;
  activitiesAvailable: boolean;
  unavailableReason?: string | null;
  loadedActivityCount?: number;
  activityHistoryComplete?: boolean;
  /** Service-provided incompleteness reason (e.g. ACTIVITY_QUERY_LIMIT_REACHED). */
  activityHistoryReason?: string | null;
  /** Design 2026-09-30 §5.4.1: run-level fold. HISTORY folds >2 quiet rounds
   * into a one-line summary; absent keeps the always-expanded legacy render. */
  fold?: 'LIVE' | 'HISTORY';
  /** Absolute workspace root for file-path tooltips (display only). */
  workspaceRoot?: string | null;
  /** Owning session id for session-scoped evidence-artifact reads. */
  sessionId?: string | null;
  onOpenFile?: (fileRef: string, startLine?: number | null, runId?: string) => void;
}): React.JSX.Element {
  const phase = props.phase ?? (props.live ? 'RUNNING' : 'SUCCEEDED');
  const paused = phase === 'WAITING_APPROVAL' || phase === 'STOP_REQUESTED' || phase === 'UNKNOWN';
  const { sections, blocks } = useMemo(() => deriveRoundTranscript({
    runId: props.runId,
    runTerminal: props.runTerminal,
    activities: props.activities,
    outputRounds: props.outputRounds,
    reasoningRounds: props.reasoningRounds,
    nowMs: props.nowMs
  }), [props.runId, props.runTerminal, props.activities, props.outputRounds, props.reasoningRounds, props.nowMs]);
  const yieldRoundId = useMemo(() => (props.answerMessagePresent
    ? answerYieldRoundId(blocks, props.runTerminal, props.messageRoundId)
    : null), [props.answerMessagePresent, blocks, props.runTerminal, props.messageRoundId]);

  // Design 2026-09-30 §5.4.1: run-level fold state + summary derivation.
  const foldActive = props.fold === 'HISTORY' && blocks.length > 2;
  const [foldChoice, setFoldChoice] = useState<boolean | undefined>(() => foldMemory.get(props.runId));
  const foldAttention = useMemo(
    () => blocks.some(roundPinsOpen)
      || props.activities.some((activity) => isAttentionWorthy(activity) && activity.status !== 'RUNNING'),
    [blocks, props.activities]
  );
  const foldOpen = !foldActive || (foldChoice ?? foldAttention);
  const summary = useMemo(() => {
    if (!foldActive) return null;
    const ungroupedCount = sections.reduce((count, section) => section.type === 'round' ? count : count + section.activities.length, 0);
    const ops = blocks.reduce((count, block) => count + block.activities.length + block.finalizeActivities.length, 0) + ungroupedCount;
    const fails = props.activities.filter((activity) => isFailedStatus(activity.status)).length;
    let startMs: number | null = null;
    let endMs: number | null = null;
    for (const block of blocks) {
      if (block.startedAtMs !== null && (startMs === null || block.startedAtMs < startMs)) startMs = block.startedAtMs;
      if (block.finishedAtMs !== null && (endMs === null || block.finishedAtMs > endMs)) endMs = block.finishedAtMs;
    }
    const durationEnd = props.live ? props.nowMs : endMs;
    const duration = startMs !== null && durationEnd !== null && durationEnd >= startMs
      ? formatCliElapsed(durationEnd - startMs)
      : null;
    const kindCounts = new Map<string, number>();
    for (const activity of props.activities) {
      const bucket = summaryKindBucket(activity.kind);
      if (bucket === null) continue;
      kindCounts.set(bucket, (kindCounts.get(bucket) ?? 0) + 1);
    }
    const kindStats = [...kindCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 4)
      .map(([label, count]) => `${label} ${count}`)
      .join(' · ');
    return { rounds: blocks.length, ops, fails, duration, kindStats };
  }, [foldActive, sections, blocks, props.activities, props.live, props.nowMs]);

  if (!props.activitiesAvailable) {
    return <div className="cli-execution-transcript cli-execution-unavailable" data-testid="activity-unavailable">{phase === 'WAITING_APPROVAL' ? '等待批准 · 当前服务未提供执行明细' : 'Agent 运行中 · 当前服务未提供执行明细'}{props.unavailableReason ? `（${props.unavailableReason}）` : ''}</div>;
  }
  const showUngroupedOutput = !props.runTerminal && Boolean(props.ungroupedOutput?.text.trim());
  const showUngroupedReasoning = Boolean(props.ungroupedReasoning?.text.trim());
  const hasContent = sections.length > 0 || showUngroupedOutput || showUngroupedReasoning;
  if (!hasContent) {
    return props.live
      ? <div className="cli-execution-transcript cli-execution-empty" data-testid="cli-execution-empty"><span className={`cli-purpose-glyph${paused ? '' : ' is-running'}`} aria-hidden="true">{phase === 'WAITING_APPROVAL' ? 'Ⅱ' : phase === 'STOP_REQUESTED' ? '…' : '⠋'}</span> {phase === 'WAITING_APPROVAL' ? '等待你的批准 · 执行明细待同步' : phase === 'STOP_REQUESTED' ? '正在请求停止… · 执行明细待同步' : 'Agent 运行中 · 等待执行明细'}</div>
      : <div className="cli-execution-transcript cli-execution-empty">没有已加载的执行活动</div>;
  }
  const reasonLabel = activityHistoryReasonLabel(props.activityHistoryReason);
  const completenessMuted = props.live && props.activityHistoryReason === 'ACTIVITY_ORPHANED';
  const completenessRow = props.activityHistoryComplete === false ? (
    <div className={`cli-activity-completeness${completenessMuted ? ' is-muted' : ''}`}>
      已加载 {props.loadedActivityCount ?? props.activities.length} 项活动
      {reasonLabel ? <> · {reasonLabel}（<code title={props.activityHistoryReason ?? undefined}>{props.activityHistoryReason}</code>）</> : null}
    </div>
  ) : null;

  if (foldActive && summary) {
    return (
      <div className="cli-execution-transcript round-transcript run-process-fold" data-run-id={props.runId} data-testid="run-process-fold">
        <button
          type="button"
          className="run-process-summary"
          data-testid="run-process-summary"
          aria-expanded={foldOpen}
          onClick={() => { const next = !foldOpen; setFoldChoice(next); rememberFold(props.runId, next); }}
        >
          <Icon name="chevron" size={12} className="run-process-caret" />
          <span className="run-process-label">执行过程</span>
          <span className="run-process-fact">· {summary.rounds} 轮</span>
          <span className="run-process-fact">· {summary.ops} 项操作</span>
          {summary.fails > 0 ? <span className="run-process-fact is-failed">· {summary.fails} 项失败</span> : null}
          {summary.duration ? <span className="run-process-fact">· {props.live ? '已运行 ' : ''}{summary.duration}</span> : null}
          <span className="run-process-spacer" aria-hidden="true" />
          {summary.kindStats ? <span className="run-process-kinds">{summary.kindStats}</span> : null}
          {props.activityHistoryComplete === false ? <span className="run-process-badge">快照不完整</span> : null}
        </button>
        {foldOpen ? (
          <>
            {sections.map((section) => section.type === 'round' ? (
              <RoundBlock
                key={section.block.key}
                block={section.block}
                live={props.live && section.block.live}
                runTerminal={props.runTerminal}
                nowMs={props.nowMs}
                yieldPrompt={yieldRoundId === section.block.roundId}
                workspaceRoot={props.workspaceRoot}
                sessionId={props.sessionId}
                onOpenFile={props.onOpenFile}
              />
            ) : (
              <div key={section.key} className="round-ungrouped" data-testid="round-ungrouped">
                {section.activities.map((activity) => (
                  <CliActivityRow
                    key={`${activity.runId}:${activity.activityId}`}
                    activity={activity}
                    nowMs={props.nowMs}
                    defaultOpen={props.live && activity.status === 'RUNNING'}
                    workspaceRoot={props.workspaceRoot}
                    sessionId={props.sessionId}
                    runId={props.runId}
                    runTerminal={props.runTerminal}
                    onOpenFile={props.onOpenFile}
                  />
                ))}
              </div>
            ))}
            {showUngroupedReasoning ? (
              <UngroupedReasoningRow bucket={props.ungroupedReasoning as RoundTextBucketLike} live={props.live && !props.runTerminal} />
            ) : null}
            {showUngroupedOutput ? (
              <UngroupedOutputRow bucket={props.ungroupedOutput as RoundTextBucketLike} live={props.live} />
            ) : null}
          </>
        ) : null}
        {completenessRow}
      </div>
    );
  }

  return (
    <div className="cli-execution-transcript round-transcript" data-run-id={props.runId}>
      {sections.map((section) => section.type === 'round' ? (
        <RoundBlock
          key={section.block.key}
          block={section.block}
          live={props.live && section.block.live}
          runTerminal={props.runTerminal}
          nowMs={props.nowMs}
          yieldPrompt={yieldRoundId === section.block.roundId}
          workspaceRoot={props.workspaceRoot}
          sessionId={props.sessionId}
          onOpenFile={props.onOpenFile}
        />
      ) : (
        <div key={section.key} className="round-ungrouped" data-testid="round-ungrouped">
          {section.activities.map((activity) => (
            <CliActivityRow
              key={`${activity.runId}:${activity.activityId}`}
              activity={activity}
              nowMs={props.nowMs}
              defaultOpen={props.live && activity.status === 'RUNNING'}
              workspaceRoot={props.workspaceRoot}
              sessionId={props.sessionId}
              runId={props.runId}
              runTerminal={props.runTerminal}
              onOpenFile={props.onOpenFile}
            />
          ))}
        </div>
      ))}
      {showUngroupedReasoning ? (
        <UngroupedReasoningRow bucket={props.ungroupedReasoning as RoundTextBucketLike} live={props.live && !props.runTerminal} />
      ) : null}
      {showUngroupedOutput ? (
        <UngroupedOutputRow bucket={props.ungroupedOutput as RoundTextBucketLike} live={props.live} />
      ) : null}
      {completenessRow}
    </div>
  );
});
