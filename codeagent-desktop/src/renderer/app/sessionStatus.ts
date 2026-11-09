import type { AttentionLike, RunLike, SessionLike } from './queries';
import { runStateLabel } from './ui/labels';

export { runStateLabel };

export interface SessionStatusView {
  label: string;
  tone: 'neutral' | 'info' | 'warning' | 'success' | 'danger';
  active: boolean;
  attention: boolean;
}

function runRecency(run: RunLike): number {
  for (const value of [run.updatedAt, run.finishedAt, run.startedAt, run.queuedAt]) {
    if (!value) continue;
    const timestamp = Date.parse(value);
    if (Number.isFinite(timestamp)) return timestamp;
  }
  return 0;
}

/** The session badge describes the newest run; older failures remain visible in history. */
function newestRelatedRuns(runs: RunLike[]): RunLike[] {
  return runs
    .map((run, index) => ({ run, index }))
    .sort((a, b) => runRecency(b.run) - runRecency(a.run) || b.index - a.index)
    .slice(0, 1)
    .map(({ run }) => run);
}

/** Project the server snapshot into human language without inventing state. */
export function sessionStatusView(
  session: SessionLike,
  runs: RunLike[],
  attention: AttentionLike[]
): SessionStatusView {
  const relatedRuns = runs.filter((run) => run.sessionId === session.sessionId);
  const currentRuns = newestRelatedRuns(relatedRuns);
  const running = currentRuns.find((run) => ['RUNNING', 'QUEUED'].includes(run.state));
  const waiting = currentRuns.find((run) => ['WAITING_APPROVAL', 'WAITING_BUDGET_APPROVAL'].includes(run.state));
  const failed = currentRuns.find((run) => run.state === 'FAILED');
  const paused = currentRuns.find((run) => run.state === 'PAUSED');
  const needsAttention = currentRuns.find((run) => run.state === 'NEEDS_ATTENTION');
  // V2 severity axis (design 2026-09-02 §11.4): a succeeded run with
  // attributable warnings must not read as plain success, and never as
  // failure. Absent on older services — optional fields keep the
  // legacy projection unchanged.
  const warned = currentRuns.find((run) => run.outcomeSeverity === 'WARNING');
  const deliveryPending = currentRuns.find((run) => {
    const terminal = !['RUNNING', 'QUEUED', 'WAITING_APPROVAL', 'WAITING_BUDGET_APPROVAL'].includes(run.state);
    return terminal && run.delivery != null && run.delivery.artifactsReady !== true;
  });
  const attentionFound = attention.some((item) => item.sessionId === session.sessionId
    || relatedRuns.some((run) => run.runId === item.sourceId));

  if (waiting || attentionFound || needsAttention) return { label: '需要注意', tone: 'warning', active: true, attention: true };
  if (running) return { label: '执行中…', tone: 'info', active: true, attention: false };
  if (paused) return { label: '已暂停 · 可继续', tone: 'warning', active: false, attention: true };
  if (failed) return { label: '已失败', tone: 'danger', active: false, attention: false };
  if (deliveryPending) return { label: '已完成 · 证据待回传', tone: 'warning', active: false, attention: false };
  if (warned) return { label: '已完成 · 有警告', tone: 'warning', active: false, attention: false };
  if (session.status === 'PAUSED') return { label: '已暂停', tone: 'neutral', active: false, attention: false };
  if (session.status === 'COMPLETED') return { label: '已完成 · 未验证', tone: 'success', active: false, attention: false };
  return { label: '就绪', tone: 'neutral', active: false, attention: false };
}

// Design 2026-09-30 §5.1.7: status glyph used by the activity tray rows.
export function runStateIconName(state: string): 'loader' | 'pause' | 'x' | 'check' | 'alert' {
  if (state === 'RUNNING') return 'loader';
  if (['QUEUED', 'PAUSED', 'WAITING_APPROVAL', 'WAITING_BUDGET_APPROVAL'].includes(state)) return 'pause';
  if (state === 'FAILED') return 'x';
  if (state === 'SUCCEEDED' || state === 'COMPLETED') return 'check';
  return 'alert';
}

export function runStateTone(state: string): SessionStatusView['tone'] {
  if (['WAITING_APPROVAL', 'WAITING_BUDGET_APPROVAL', 'PAUSED', 'NEEDS_ATTENTION'].includes(state)) return 'warning';
  if (['RUNNING', 'QUEUED'].includes(state)) return 'info';
  if (state === 'FAILED') return 'danger';
  if (state === 'COMPLETED' || state === 'SUCCEEDED') return 'success';
  return 'neutral';
}
