/**
 * Model-interaction round block (design 2026-09-19 §3).
 *
 * One block = one model call: optional thinking row (MODEL activity +
 * reasoning text), optional prompt row (the round's visible-output text
 * segment) and its tool/command activity rows. Grouping keys are the
 * explicit roundId facts — this component renders a model it was given,
 * it never invents one.
 */
import { memo, useEffect, useRef, useState } from 'react';
import type { RoundBlockModel } from '../activity/roundDisplayModel';
import {
  activityKindGlyph,
  activityStatusGlyph,
  isAttentionWorthy,
  isFailedStatus
} from '../activity/activityPresentation';
import { CliActivityRow, formatCliElapsed } from './CliActivityRow';
import { ContentRenderer } from '../ContentRenderer';
import { Icon } from '../Icon';

/** Integer-second thinking label: `思考 4s`, approximate anchors mark `≈`. */
function thinkingLabel(block: RoundBlockModel): string {
  const elapsed = block.thinking.elapsedMs;
  if (elapsed === null) return '思考中';
  const seconds = Math.floor(elapsed / 1000);
  return `思考 ${block.thinking.anchorApproximate ? '≈' : ''}${seconds}s`;
}

/**
 * Thinking row. Inside a block it is the block head; for answer-level
 * rounds it stands alone above the answer area (§3.2/§3.4). Reasoning
 * text expands in place; a MODEL-only row stays a single line.
 */
function ThinkingRow(props: {
  block: RoundBlockModel;
  standalone?: boolean;
}): React.JSX.Element {
  const { block } = props;
  const reasoning = block.thinking.reasoning;
  // A RUNNING model item in a closed block is stale (terminal arrived or a
  // newer round started without its terminal fact) — it must not hold the
  // details open (§3.4 stale-RUNNING semantics).
  const running = !block.closed
    && (block.live || block.thinking.modelActivity?.status === 'RUNNING');
  const label = thinkingLabel(block);
  const stateText = block.thinking.modelActivity?.status === 'FAILED'
    ? '模型调用失败'
    : reasoning?.interrupted
      ? `${label} · 推理中断`
      : reasoning?.truncated
        ? `${label} · 较早部分已截断`
        : running
          ? `${label}…`
          : label;
  const content = (
    <>
      <span className={`round-thinking-glyph${running ? ' is-running' : ''}`} aria-hidden="true">
        {running ? '⠋' : <Icon name="thinking" size={14} />}
      </span>
      <span className="round-thinking-label">{stateText}</span>
      {reasoning ? <span className="round-caret" aria-hidden="true">▾</span> : null}
    </>
  );
  if (!reasoning) {
    return (
      <div className={`round-thinking${props.standalone ? ' is-standalone' : ''}`} role="note">
        {content}
      </div>
    );
  }
  return (
    <details className={`round-thinking${props.standalone ? ' is-standalone' : ''}`} open={running}>
      <summary className="round-thinking-summary"
        aria-label={reasoning.complete === false ? `${stateText}（不完整）` : stateText}>
        {content}
      </summary>
      <div className="round-thinking-text">
        <ContentRenderer text={reasoning.text} />
        {reasoning.complete === false ? <span className="round-note">推理过程不完整</span> : null}
      </div>
    </details>
  );
}

/** Streaming/explanatory text of one round — the prompt row (§3.3). */
function PromptRow(props: {
  block: RoundBlockModel;
}): React.JSX.Element | null {
  const { block } = props;
  if (!block.promptText) return null;
  const stats = block.promptStats;
  return (
    <div className={`round-prompt${block.live ? ' is-live' : ''}`} data-testid="round-prompt">
      <ContentRenderer text={block.promptText} className="round-prompt-text" />
      {block.live ? <span className="streaming-caret" aria-hidden="true" /> : null}
      {block.promptInterrupted ? <span className="round-note">输出中断，正在同步最终响应…</span> : null}
      {block.promptTruncated ? <span className="round-note">较早部分已截断</span> : null}
      {stats ? (
        <span className="sr-only">已接收 {stats.receivedBytes} / {stats.totalBytes} 字节；序号 {stats.lastSequence}；丢弃 {stats.droppedChunks} 段</span>
      ) : null}
    </div>
  );
}

/** FINALIZE routing item → quiet in-block phase row (§4.1). */
function FinalizeRow(props: { activity: RoundBlockModel['finalizeActivities'][number]; nowMs: number }): React.JSX.Element {
  const { activity } = props;
  const running = activity.status === 'RUNNING';
  return (
    <div className={`round-phase status-${activity.status.toLowerCase()}`} data-activity-id={activity.activityId}>
      <span className="round-phase-glyph" aria-hidden="true">{running ? '⠋' : activityStatusGlyph(activity.status)}</span>
      <span className="round-phase-label">{running ? '正在整理结果' : '整理结果'}</span>
      {activity.durationMillis !== null && activity.durationMillis !== undefined
        ? <span className="round-phase-meta">{formatCliElapsed(activity.durationMillis)}</span>
        : null}
      {activity.resultSummary ? <span className="round-phase-meta">{activity.resultSummary}</span> : null}
    </div>
  );
}

// Design 2026-09-30 §5.4.1: exported so the run-level fold reuses the same
// attention rule for its default-open decision.
export function roundHasAttention(block: RoundBlockModel): boolean {
  return block.activities.some(isAttentionWorthy)
    || block.finalizeActivities.some(isAttentionWorthy)
    || block.status === 'FAILED'
    || block.hasStaleRunning
    || block.interrupted;
}

/**
 * Pin-worthy anomalies hold a closed round open: real failures, approval
 * waits and unknown effects. Stale RUNNING residue (orphaned end facts)
 * and interrupted text are head-badge facts — they stay honest on the
 * folded row without pinning the body open forever.
 */
export function roundPinsOpen(block: RoundBlockModel): boolean {
  const pins = (activity: RoundBlockModel['activities'][number]): boolean =>
    isAttentionWorthy(activity) && activity.status !== 'RUNNING';
  return block.activities.some(pins)
    || block.finalizeActivities.some(pins)
    || block.status === 'FAILED';
}

/**
 * §8: block collapse state is remembered per (runId, roundId) so the
 * live→history handover — a different parent tree that remounts every
 * block — does not reset a user's expand choice. Bounded by the number
 * of rounds observed this session; soft-capped defensively.
 */
const collapseMemory = new Map<string, boolean>();
const COLLAPSE_MEMORY_LIMIT = 4_096;

function rememberedCollapse(key: string): boolean | undefined {
  return collapseMemory.get(key);
}

function rememberCollapse(key: string, open: boolean): void {
  if (collapseMemory.size >= COLLAPSE_MEMORY_LIMIT) collapseMemory.clear();
  collapseMemory.set(key, open);
}

/**
 * One model interaction. Rounds with zero routed ops are answer-level:
 * no shell, the thinking row stands alone and the text renders as an
 * answer-level row while live; under terminal the run's answer message
 * carries the text (§3.4/§4.4).
 */
export const RoundBlock = memo(function RoundBlock(props: {
  block: RoundBlockModel;
  /** The owning run is still live (drives streaming states). */
  live: boolean;
  runTerminal: boolean;
  nowMs: number;
  /** §4.4 handover: hide this round's prompt; the answer message carries it. */
  yieldPrompt?: boolean;
  /** Absolute workspace root for file-path tooltips (display only). */
  workspaceRoot?: string | null;
  /** Owning session id for session-scoped evidence-artifact reads. */
  sessionId?: string | null;
  onOpenFile?: (fileRef: string, startLine?: number | null, runId?: string) => void;
}): React.JSX.Element | null {
  const { block } = props;
  const answerLevel = block.activities.length === 0;
  const hasAttention = roundHasAttention(block);
  const pinsOpen = roundPinsOpen(block);
  const memoryKey = `${block.runId}:${block.roundId}`;
  const [open, setOpen] = useState(() =>
    rememberedCollapse(memoryKey) ?? (block.live || !block.closed || pinsOpen));
  const interactedRef = useRef(false);
  useEffect(() => {
    // A closed quiet block folds — whenever its blockers clear, not only at
    // the exact live→close edge. A blocker at that instant (stale RUNNING,
    // a dropped-chunk interruption, an active text selection) used to pin
    // the round open for good; now the fold re-evaluates on each change and
    // when the selection changes. User-pinned blocks (clicked open on this
    // mount, or a remembered expand) keep their state.
    const foldQuietBlock = (): void => {
      if (!open || !block.closed || pinsOpen) return;
      if (interactedRef.current || rememberedCollapse(memoryKey) === true) return;
      const hasSelectedText = typeof window !== 'undefined' && Boolean(window.getSelection?.()?.toString());
      if (hasSelectedText) return;
      setOpen(false);
      rememberCollapse(memoryKey, false);
    };
    foldQuietBlock();
    document.addEventListener('selectionchange', foldQuietBlock);
    return () => document.removeEventListener('selectionchange', foldQuietBlock);
  }, [open, block.closed, pinsOpen, memoryKey]);

  if (answerLevel) {
    // 答复级轮：无块壳；思考行独立成行，流式文本为答复级行（§3.4）。
    // The prompt row only yields to the answer message that actually
    // carries it (§4.4) — with no handover the text stays visible.
    return (
      <div className="round-answer-level" data-round-id={block.roundId}>
        {block.thinking.modelActivity || block.thinking.reasoning
          ? <ThinkingRow block={block} standalone />
          : null}
        {!props.yieldPrompt ? <PromptRow block={block} /> : null}
        {block.finalizeActivities.map((activity) => (
          <FinalizeRow key={`${activity.runId}:${activity.activityId}`} activity={activity} nowMs={props.nowMs} />
        ))}
      </div>
    );
  }

  // Design 2026-09-30 §5.4.2: a closed round under one second does not
  // advertise elapsed time; a live round keeps the ticking mm:ss.
  const elapsed = block.closed && block.elapsedMs !== null && block.elapsedMs < 1000
    ? null
    : formatCliElapsed(block.elapsedMs);
  // Rows inside a closed block share the block's frozen end: a stale
  // RUNNING member must not keep ticking off the live clock (§3.4).
  const rowNowMs = block.closed && block.finishedAtMs !== null ? block.finishedAtMs : props.nowMs;
  const opsCount = block.activities.length;
  const failCount = block.activities.filter((activity) => isFailedStatus(activity.status)).length
    + block.finalizeActivities.filter((activity) => isFailedStatus(activity.status)).length;
  const headLabel = `第 ${block.displayNumber} 轮交互`;
  const statusText = block.status === 'FAILED'
    ? '本轮执行失败'
    : block.status === 'INCOMPLETE'
      ? '结束状态未同步'
      : block.live
        ? `${thinkingLabel(block)}…`
        : thinkingLabel(block);
  const headStatusIcon = block.live ? 'loader'
    : block.status === 'FAILED' ? 'x'
      : block.status === 'INCOMPLETE' ? 'alert' : 'check';
  const headStatusTone = block.live ? 'info'
    : block.status === 'FAILED' ? 'danger'
      : block.status === 'INCOMPLETE' ? 'warning' : 'muted';
  // §5.4.2: the head already carries thinking time — a MODEL-only row with no
  // reasoning text repeats it, so only a failed call or real reasoning shows.
  const showThinkingRow = Boolean(block.thinking.reasoning)
    || block.thinking.modelActivity?.status === 'FAILED';
  return (
    <section
      className={`round-block status-${block.status.toLowerCase()}${block.live ? ' is-live' : ''}${hasAttention ? ' has-attention' : ''}`}
      data-round-id={block.roundId}
      data-testid="round-block"
    >
      <button
        type="button"
        className="round-head"
        aria-expanded={open}
        aria-controls={`round-body-${block.runId}-${block.roundId}`}
        aria-label={`${headLabel}，${statusText}，${opsCount} 项操作${elapsed ? `，耗时 ${elapsed}` : ''}`}
        onClick={() => { interactedRef.current = true; setOpen((value) => { const next = !value; rememberCollapse(memoryKey, next); return next; }); }}
      >
        <Icon name="chevron" size={12} className="round-head-caret" />
        <Icon name={headStatusIcon} size={14} className={`round-head-status tone-${headStatusTone}${block.live ? ' icon-loader' : ''}`} />
        <span className="round-title">{headLabel}</span>
        <span className="round-meta">
          <span className="round-thinking-time">· {statusText}</span>
          {opsCount > 0 ? <span className="round-count">· {opsCount} 项操作</span> : null}
          {failCount > 0 ? <span className="round-count is-failed">· {failCount} 项失败</span> : null}
          {block.truncated ? <span className="round-badge">已截断</span> : null}
          {block.interrupted ? <span className="round-badge">已中断</span> : null}
          {block.hasStaleRunning ? <span className="round-badge">结束状态未同步</span> : null}
        </span>
        <span className="round-head-spacer" aria-hidden="true" />
        {elapsed ? <span className="round-elapsed">{block.live ? '已运行 ' : ''}{elapsed}</span> : null}
      </button>
      {open ? (
        <div id={`round-body-${block.runId}-${block.roundId}`} className="round-body">
          {showThinkingRow ? <ThinkingRow block={block} /> : null}
          <PromptRow block={props.yieldPrompt ? { ...block, promptText: null } : block} />
          {block.activities.map((activity) => (
            <CliActivityRow
              key={`${activity.runId}:${activity.activityId}`}
              activity={activity}
              nowMs={rowNowMs}
              defaultOpen={block.live && activity.status === 'RUNNING'}
              kindGlyph={activityKindGlyph(activity.kind)}
              workspaceRoot={props.workspaceRoot}
              sessionId={props.sessionId}
              runId={block.runId}
              runTerminal={props.runTerminal}
              onOpenFile={props.onOpenFile}
            />
          ))}
          {block.finalizeActivities.map((activity) => (
            <FinalizeRow key={`${activity.runId}:${activity.activityId}`} activity={activity} nowMs={rowNowMs} />
          ))}
        </div>
      ) : null}
    </section>
  );
});
