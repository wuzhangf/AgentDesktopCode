import { memo, useLayoutEffect, useRef } from 'react';
import type { RunDisplayModel } from '../activity/runDisplayModel';
import type {
  RunLike,
  VisibleOutputState,
  VisibleReasoningState,
  RunReasoningSnapshot,
  RunOutputSnapshot
} from '../queries';
import { mergeRoundBuckets, ungroupedTextOf } from '../activity/roundDisplayModel';
import type { RunActivity } from '../activity/activityTypes';
import { CliExecutionTranscript } from './CliExecutionTranscript';
import { RoundTranscript } from './RoundTranscript';
import { ContentRenderer } from '../ContentRenderer';

const PinnedScrollViewport = memo(function PinnedScrollViewport(props: {
  text: string;
  className: string;
  textClassName?: string;
}): React.JSX.Element {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const pinnedToBottomRef = useRef(true);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (viewport && pinnedToBottomRef.current) viewport.scrollTop = viewport.scrollHeight;
  }, [props.text]);

  return (
    <div
      ref={viewportRef}
      className={props.className}
      onScroll={(event) => {
        const viewport = event.currentTarget;
        pinnedToBottomRef.current = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 24;
      }}
    >
      <ContentRenderer text={props.text} className={props.textClassName} />
    </div>
  );
});

/**
 * Collapsible display-reasoning block (design 2026-09-18). Renders either
 * the live SSE fold (VisibleReasoningState) or the authoritative journal
 * snapshot (RunReasoningSnapshot); both carry honest completeness flags.
 */
export const ReasoningBlock = memo(function ReasoningBlock(props: {
  reasoning: VisibleReasoningState | RunReasoningSnapshot | null;
}): React.JSX.Element | null {
  const reasoning = props.reasoning;
  const text = reasoning?.text?.trim();
  if (!reasoning || !text) return null;
  const terminal = reasoning.terminal === true;
  const interrupted = 'interrupted' in reasoning && reasoning.interrupted === true;
  const complete = 'complete' in reasoning ? reasoning.complete !== false : !interrupted;
  const truncated = 'truncated' in reasoning && reasoning.truncated === true;
  const status = !terminal && !('complete' in reasoning)
    ? '正在思考…'
    : !complete
      ? `思考过程不完整${'reasonCode' in reasoning && reasoning.reasonCode ? `（${reasoning.reasonCode}）` : ''}`
      : truncated
        ? '思考过程（较早部分已截断）'
        : '思考过程';
  return (
    <details className="reasoning-block" data-testid="run-reasoning" open={!terminal}>
      <summary className="reasoning-summary">
        <span className="reasoning-label">{status}</span>
      </summary>
      <PinnedScrollViewport text={text} className="reasoning-text" />
    </details>
  );
});

/**
 * Render-path rollback switch (design 2026-09-19 §3.4/RB-4): setting
 * `codeagent.desktop.transcript.round-blocks.v1 = '0'` in localStorage
 * restores the purpose-group timeline. Anything else (or absent) renders
 * model-interaction round blocks.
 */
export function roundTranscriptEnabled(): boolean {
  try {
    return window.localStorage.getItem('codeagent.desktop.transcript.round-blocks.v1') !== '0';
  } catch {
    return true;
  }
}

export const AgentRunBlock = memo(function AgentRunBlock(props: {
  run: RunLike | null;
  activities: ReadonlyArray<RunActivity>;
  visibleOutput?: VisibleOutputState | null;
  outputSnapshot?: RunOutputSnapshot | null;
  visibleReasoning?: VisibleReasoningState | null;
  reasoningSnapshot?: RunReasoningSnapshot | null;
  /** §4.4 dedup: the run's answer message is rendered beside the block. */
  answerMessagePresent?: boolean;
  /** §4.4 explicit dedup key when the message contract carries roundId. */
  messageRoundId?: string | null;
  nowMs: number;
  observedStartedAt?: number | null;
  phase?: RunDisplayModel['phase'];
  connection?: RunDisplayModel['connection'];
  loadedActivityCount?: number;
  activityHistoryComplete?: boolean;
  activityHistoryReason?: string | null;
  activitiesAvailable: boolean;
  unavailableReason?: string | null;
  /** Absolute workspace root for file-path tooltips (display only). */
  workspaceRoot?: string | null;
  /** Owning session id for session-scoped evidence-artifact reads. */
  sessionId?: string | null;
  onOpenFile?: (fileRef: string, startLine?: number | null, runId?: string) => void;
}): React.JSX.Element {
  const output = props.visibleOutput;
  const outputSnapshot = props.outputSnapshot ?? null;
  const reasoning = props.visibleReasoning;
  const reasoningSnapshot = props.reasoningSnapshot ?? null;
  const useRounds = roundTranscriptEnabled();
  // Run-terminal comes from the run's own state (phase/run.state) or the
  // live fold's run.terminal observation — a snapshot's terminal flag
  // describes the fold it fetched, not the current run phase.
  const RUN_TERMINAL_STATES = new Set(['COMPLETED', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'INTERRUPTED', 'TIMED_OUT', 'ABORTED', 'REJECTED', 'TERMINAL', 'PAUSED']);
  const runTerminal = props.phase === 'SUCCEEDED' || props.phase === 'FAILED' || props.phase === 'CANCELLED'
    || (props.run ? RUN_TERMINAL_STATES.has(props.run.state) : false)
    || output?.terminal === true;

  // Reasoning legacy path keeps the previous merge rule: live chunks win
  // while they arrive; the snapshot is authoritative once terminal.
  const mergedReasoning: VisibleReasoningState | RunReasoningSnapshot | null = (() => {
    if (reasoning && reasoning.text) {
      if (!reasoning.terminal || !reasoningSnapshot || !(reasoningSnapshot.text ?? '').trim()) {
        return reasoning;
      }
    }
    if (reasoningSnapshot && (reasoningSnapshot.text ?? '').trim()) return reasoningSnapshot;
    return reasoning ?? null;
  })();

  const outputRounds = useRounds ? mergeRoundBuckets(
    output ? [...output.rounds.values()] : null,
    outputSnapshot?.segments ?? null,
    runTerminal
  ) : [];
  const reasoningRounds = useRounds ? mergeRoundBuckets(
    reasoning ? [...reasoning.rounds.values()] : null,
    reasoningSnapshot?.segments ?? null,
    runTerminal
  ) : [];
  const ungroupedOutput = useRounds ? ungroupedTextOf(output, outputSnapshot) : null;
  const ungroupedReasoning = useRounds ? ungroupedTextOf(reasoning, reasoningSnapshot) : null;

  return (
    <section className={`cli-agent-run-block connection-${props.connection ?? 'connected'}`} data-testid="agent-run-block" data-run-id={props.run?.runId ?? undefined}>
      {props.run ? (useRounds ? (
        <RoundTranscript
          runId={props.run.runId}
          activities={props.activities}
          outputRounds={outputRounds}
          reasoningRounds={reasoningRounds}
          ungroupedOutput={ungroupedOutput}
          ungroupedReasoning={ungroupedReasoning}
          live={!runTerminal}
          runTerminal={runTerminal}
          answerMessagePresent={props.answerMessagePresent}
          messageRoundId={props.messageRoundId}
          nowMs={props.nowMs}
          phase={props.phase}
          activitiesAvailable={props.activitiesAvailable}
          unavailableReason={props.unavailableReason}
          loadedActivityCount={props.loadedActivityCount}
          activityHistoryComplete={props.activityHistoryComplete}
          activityHistoryReason={props.activityHistoryReason}
          fold="LIVE"
          workspaceRoot={props.workspaceRoot}
          sessionId={props.sessionId}
          onOpenFile={props.onOpenFile}
        />
      ) : (
        <>
          <CliExecutionTranscript runId={props.run.runId} activities={props.activities} live nowMs={props.nowMs} runTerminal={runTerminal} phase={props.phase} loadedActivityCount={props.loadedActivityCount} activityHistoryComplete={props.activityHistoryComplete} activityHistoryReason={props.activityHistoryReason} activitiesAvailable={props.activitiesAvailable} unavailableReason={props.unavailableReason} observedStartedAt={props.observedStartedAt} workspaceRoot={props.workspaceRoot} sessionId={props.sessionId} onOpenFile={props.onOpenFile} />
          <ReasoningBlock reasoning={mergedReasoning} />
          {output?.text ? (
            <article className="message message-flat assistant streaming-message" data-testid="visible-output">
              <span className="role role-glyph" aria-hidden="true">✦</span>
              <span className="sr-only">Agent</span>
              <div className="message-content"><PinnedScrollViewport text={output.text} className="visible-output-viewport" textClassName="visible-output-text" /><span className="streaming-caret" aria-hidden="true" /></div>
              <span className="message-status">{output.interrupted ? '输出中断，正在同步最终响应…' : '正在生成…'}</span>
              <span className="sr-only">已接收 {output.receivedBytes} / {output.totalBytes} 字节；序号 {output.lastSequence}；丢弃 {output.droppedChunks} 段</span>
            </article>
          ) : null}
        </>
      )) : null}
    </section>
  );
});
