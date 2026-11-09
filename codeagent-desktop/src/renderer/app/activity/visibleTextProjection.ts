/**
 * Live visible-output / display-reasoning folds (design 2026-09-19 §5.2).
 * Pure reducers over durable SSE frames — no DOM or IPC access so the
 * projection stays testable outside the renderer bundle. `queries.ts`
 * re-exports these symbols for existing call sites.
 */

/**
 * Per-(run, round) text bucket (design 2026-09-19 §5.2): one model
 * interaction's output or reasoning chunks, keyed by the explicit roundId
 * on each durable frame — never by arrival position.
 */
export interface RoundTextState {
  roundId: string;
  roundOrdinal: number | null;
  text: string;
  receivedBytes: number;
  droppedChunks: number;
  /** Highest relay sequence contributing to this round. */
  lastSequence: number;
  /** Journal cursors of the round's first/last frame (ordering anchors). */
  firstCursor: number;
  lastCursor: number;
  interrupted: boolean;
  /** True once the round hit the per-round display bound. */
  truncated: boolean;
  /** Renderer observation clock of this round's FIRST frame — the stable
   * stream anchor; `lastUpdatedAt` chases the tail and cannot anchor. */
  firstUpdatedAt: number;
  lastUpdatedAt: number;
}

/** Visible output stream projection for one run (EW4, design §9.4). */
export interface VisibleOutputState {
  text: string;
  /** Text from frames that carried no roundId — the ungrouped fallback. */
  ungroupedText: string;
  /** Per-round buckets in first-seen order; empty on legacy streams. */
  rounds: Map<string, RoundTextState>;
  /** bytes reported received so far (from event payloads) */
  receivedBytes: number;
  /** authoritative running total from the service */
  totalBytes: number;
  droppedChunks: number;
  /** Last relay sequence accepted for this run. */
  lastSequence: number;
  /** True when an output sequence was missed or the relay reported drops. */
  interrupted: boolean;
  /** True once the owning run reached a terminal state. */
  terminal: boolean;
  /** Renderer observation timestamp; output events only, never heartbeats. */
  lastUpdatedAt: number;
}

export const MAX_VISIBLE_OUTPUT_CHARS = 8192;

function appendRoundText(
  rounds: Map<string, RoundTextState>,
  roundId: string,
  roundOrdinal: number | null,
  chunk: string,
  bytes: number,
  droppedChunks: number,
  sequence: number | null,
  cursor: number | null,
  gap: boolean,
  maxChars: number
): void {
  const bucket = rounds.get(roundId) ?? {
    roundId,
    roundOrdinal,
    text: '',
    receivedBytes: 0,
    droppedChunks: 0,
    lastSequence: 0,
    firstCursor: cursor ?? 0,
    lastCursor: cursor ?? 0,
    interrupted: false,
    truncated: false,
    firstUpdatedAt: 0,
    lastUpdatedAt: 0
  };
  if (bucket.roundOrdinal === null && roundOrdinal !== null) {
    bucket.roundOrdinal = roundOrdinal;
  }
  const observedAt = Date.now();
  let text = bucket.text + chunk;
  let truncated = bucket.truncated;
  if (text.length > maxChars) {
    text = text.slice(text.length - maxChars);
    truncated = true;
  }
  rounds.set(roundId, {
    ...bucket,
    text,
    receivedBytes: bucket.receivedBytes + bytes,
    droppedChunks: Math.max(bucket.droppedChunks, droppedChunks),
    lastSequence: sequence !== null ? Math.max(bucket.lastSequence, sequence) : bucket.lastSequence,
    firstCursor: bucket.firstCursor > 0 ? bucket.firstCursor : (cursor ?? 0),
    lastCursor: cursor !== null ? Math.max(bucket.lastCursor, cursor) : bucket.lastCursor,
    interrupted: bucket.interrupted || gap || droppedChunks > 0,
    truncated,
    firstUpdatedAt: bucket.firstUpdatedAt > 0 ? bucket.firstUpdatedAt : observedAt,
    lastUpdatedAt: observedAt
  });
}

/** Frame payload shape shared by output/reasoning append events. */
interface TextAppendPayload {
  text?: unknown;
  bytes?: unknown;
  totalBytes?: unknown;
  droppedChunks?: unknown;
  runId?: unknown;
  sequence?: unknown;
  roundId?: unknown;
  roundOrdinal?: unknown;
}

function unwrapAppendPayload(frame: { payload: unknown }): TextAppendPayload | null {
  if (typeof frame.payload !== 'object' || frame.payload === null) return null;
  const envelope = frame.payload as {
    runId?: unknown;
    payload?: unknown;
  };
  const nested = typeof envelope.payload === 'object' && envelope.payload !== null
    ? envelope.payload as Record<string, unknown>
    : null;
  // The real SSE frame carries a BusinessEventEnvelope. Keep the flat shape
  // as a compatibility path for older fixtures and local test doubles.
  return (nested ? { ...nested, runId: envelope.runId } : frame.payload) as TextAppendPayload;
}

export function reduceVisibleOutput(
  previous: Map<string, VisibleOutputState>,
  frame: { cursor?: number; type: string; payload: unknown }
): Map<string, VisibleOutputState> {
  if (frame.type === 'run.terminal') {
    const runId = (frame.payload as { runId?: string } | null)?.runId;
    const state = runId ? previous.get(runId) : undefined;
    if (!runId || !state || state.terminal) return previous;
    // Round blocks keep the live fold until the authoritative /output
    // snapshot lands; only the liveness flag changes (design 2026-09-19).
    const next = new Map(previous);
    next.set(runId, { ...state, terminal: true });
    return next;
  }
  if (frame.type !== 'run.output.append') return previous;
  const payload = unwrapAppendPayload(frame);
  if (!payload) return previous;
  if (typeof payload.runId !== 'string' || typeof payload.text !== 'string') return previous;
  const bytes = typeof payload.bytes === 'number' ? payload.bytes : 0;
  const totalBytes = typeof payload.totalBytes === 'number' ? payload.totalBytes : 0;
  const droppedChunks = typeof payload.droppedChunks === 'number' ? payload.droppedChunks : 0;
  const sequence = typeof payload.sequence === 'number' && Number.isInteger(payload.sequence)
    ? payload.sequence : null;
  const roundId = typeof payload.roundId === 'string' && payload.roundId.trim().length > 0
    ? payload.roundId : null;
  const roundOrdinal = typeof payload.roundOrdinal === 'number' && Number.isInteger(payload.roundOrdinal)
    ? payload.roundOrdinal : null;
  const cursor = typeof frame.cursor === 'number' && Number.isFinite(frame.cursor)
    ? frame.cursor : null;
  const state = previous.get(payload.runId) ?? {
    text: '', ungroupedText: '', rounds: new Map<string, RoundTextState>(),
    receivedBytes: 0, totalBytes: 0, droppedChunks: 0, lastSequence: 0,
    interrupted: false, terminal: false, lastUpdatedAt: Date.now()
  };
  // Durable replay can legitimately deliver duplicates after reconnect. A
  // forward gap is different: the UI must stop claiming that the tail is
  // live and wait for the authoritative final Session snapshot.
  if (sequence !== null && sequence <= state.lastSequence) return previous;
  const gap = sequence !== null && sequence !== state.lastSequence + 1;
  const interrupted = state.interrupted || droppedChunks > 0 || gap;
  let text = state.text + payload.text;
  if (text.length > MAX_VISIBLE_OUTPUT_CHARS) {
    text = text.slice(text.length - MAX_VISIBLE_OUTPUT_CHARS);
  }
  const rounds = new Map(state.rounds);
  let ungroupedText = state.ungroupedText;
  if (roundId !== null) {
    appendRoundText(rounds, roundId, roundOrdinal, payload.text, bytes,
      droppedChunks, sequence, cursor, gap, MAX_VISIBLE_OUTPUT_CHARS);
  } else {
    ungroupedText = (ungroupedText + payload.text).slice(-MAX_VISIBLE_OUTPUT_CHARS);
  }
  const next = new Map(previous);
  next.set(payload.runId, {
    text,
    ungroupedText,
    rounds,
    receivedBytes: state.receivedBytes + bytes,
    totalBytes: Math.max(state.totalBytes, totalBytes),
    droppedChunks: Math.max(state.droppedChunks, droppedChunks),
    lastSequence: sequence ?? state.lastSequence,
    interrupted,
    terminal: state.terminal,
    lastUpdatedAt: Date.now()
  });
  return next;
}

/**
 * Display-reasoning stream projection for one run (design 2026-09-18).
 * Provider-returned public thinking text only — never answer text, tool
 * output or continuation state. Unlike visible output, the fold survives
 * `run.terminal`: the block stays visible until the authoritative
 * `/runs/{id}/reasoning` snapshot replaces it.
 */
export interface VisibleReasoningState {
  text: string;
  /** Text from frames that carried no roundId — the ungrouped fallback. */
  ungroupedText: string;
  /** Per-round buckets in first-seen order; empty on legacy streams. */
  rounds: Map<string, RoundTextState>;
  receivedBytes: number;
  totalBytes: number;
  droppedChunks: number;
  lastSequence: number;
  /** True when a reasoning sequence was missed or the relay reported drops. */
  interrupted: boolean;
  /** True once the owning run reached a terminal state. */
  terminal: boolean;
  lastUpdatedAt: number;
}

export const MAX_VISIBLE_REASONING_CHARS = 8192;

export function reduceVisibleReasoning(
  previous: Map<string, VisibleReasoningState>,
  frame: { cursor?: number; type: string; payload: unknown }
): Map<string, VisibleReasoningState> {
  if (frame.type === 'run.terminal') {
    const runId = (frame.payload as { runId?: string } | null)?.runId;
    const state = runId ? previous.get(runId) : undefined;
    if (!runId || !state || state.terminal) return previous;
    const next = new Map(previous);
    next.set(runId, { ...state, terminal: true });
    return next;
  }
  if (frame.type !== 'run.reasoning.append') return previous;
  const payload = unwrapAppendPayload(frame);
  if (!payload) return previous;
  if (typeof payload.runId !== 'string' || typeof payload.text !== 'string') return previous;
  const bytes = typeof payload.bytes === 'number' ? payload.bytes : 0;
  const totalBytes = typeof payload.totalBytes === 'number' ? payload.totalBytes : 0;
  const droppedChunks = typeof payload.droppedChunks === 'number' ? payload.droppedChunks : 0;
  const sequence = typeof payload.sequence === 'number' && Number.isInteger(payload.sequence)
    ? payload.sequence : null;
  const roundId = typeof payload.roundId === 'string' && payload.roundId.trim().length > 0
    ? payload.roundId : null;
  const roundOrdinal = typeof payload.roundOrdinal === 'number' && Number.isInteger(payload.roundOrdinal)
    ? payload.roundOrdinal : null;
  const cursor = typeof frame.cursor === 'number' && Number.isFinite(frame.cursor)
    ? frame.cursor : null;
  const state = previous.get(payload.runId) ?? {
    text: '', ungroupedText: '', rounds: new Map<string, RoundTextState>(),
    receivedBytes: 0, totalBytes: 0, droppedChunks: 0, lastSequence: 0,
    interrupted: false, terminal: false, lastUpdatedAt: Date.now()
  };
  if (sequence !== null && sequence <= state.lastSequence) return previous;
  const gap = sequence !== null && sequence !== state.lastSequence + 1;
  const interrupted = state.interrupted || droppedChunks > 0 || gap;
  let text = state.text + payload.text;
  if (text.length > MAX_VISIBLE_REASONING_CHARS) {
    text = text.slice(text.length - MAX_VISIBLE_REASONING_CHARS);
  }
  const rounds = new Map(state.rounds);
  let ungroupedText = state.ungroupedText;
  if (roundId !== null) {
    appendRoundText(rounds, roundId, roundOrdinal, payload.text, bytes,
      droppedChunks, sequence, cursor, gap, MAX_VISIBLE_REASONING_CHARS);
  } else {
    ungroupedText = (ungroupedText + payload.text).slice(-MAX_VISIBLE_REASONING_CHARS);
  }
  const next = new Map(previous);
  next.set(payload.runId, {
    text,
    ungroupedText,
    rounds,
    receivedBytes: state.receivedBytes + bytes,
    totalBytes: Math.max(state.totalBytes, totalBytes),
    droppedChunks: Math.max(state.droppedChunks, droppedChunks),
    lastSequence: sequence ?? state.lastSequence,
    interrupted,
    terminal: state.terminal,
    lastUpdatedAt: Date.now()
  });
  return next;
}
