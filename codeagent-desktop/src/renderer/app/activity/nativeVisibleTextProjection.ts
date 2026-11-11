/**
 * Live native-output tail fold for worker-events/1 frames (same projection
 * style as visibleTextProjection.ts — pure reducer, no DOM or IPC so it
 * stays testable outside the renderer bundle).
 *
 * The tail is an ephemeral accelerator: OUTPUT_DELTA rows append text into a
 * per-nativeTurnId bucket until the authoritative TASK_MESSAGES page proves
 * the terminal assistant message, at which point the bucket clears and the
 * structured transcript owns the row. Cursor gaps or stream resyncs set
 * `interrupted` honestly — a lossy tail is never presented as seamless.
 */

/** One in-flight native turn's visible delta tail. */
export interface NativeLiveTurnState {
  /** Bucket key: payload nativeTurnId, or 'turn' when frames omit it. */
  nativeTurnId: string;
  text: string;
  /** Highest frame cursor contributing to this turn. */
  lastCursor: number;
  /** True once the bucket hit the display bound. */
  truncated: boolean;
  /** Renderer observation clock of the first/last frame. */
  firstUpdatedAt: number;
  lastUpdatedAt: number;
}

/** Live reasoning/thinking text for one native turn. Unlike the output tail
 * the transcript never owns thinking rows, so settled-turn thinking stays as
 * honest history until the whole stream remounts. */
export interface NativeThinkingState {
  nativeTurnId: string;
  text: string;
  truncated: boolean;
  lastUpdatedAt: number;
}

/** Live event-tail projection for one native task. */
export interface NativeLiveStreamState {
  /** Turn buckets in first-seen order. */
  turns: Map<string, NativeLiveTurnState>;
  /** Reasoning buckets keyed the same way; never cleared by ASSISTANT_MESSAGE. */
  thinking: Map<string, NativeThinkingState>;
  /** Highest frame cursor accepted on this stream. */
  lastCursor: number;
  /** True when a cursor gap or a stream resync made the tail lossy. */
  interrupted: boolean;
  lastUpdatedAt: number;
}

export const NATIVE_LIVE_TAIL_MAX_CHARS = 8192;
export const NATIVE_THINKING_MAX_CHARS = 16384;

export function emptyNativeLiveStream(): NativeLiveStreamState {
  return { turns: new Map(), thinking: new Map(), lastCursor: 0, interrupted: false, lastUpdatedAt: 0 };
}

interface OutputDeltaPayload {
  delta?: unknown;
  nativeTurnId?: unknown;
  nativeItemId?: unknown;
  contentIndex?: unknown;
}

interface AssistantMessagePayload {
  nativeTurnId?: unknown;
}

function turnKeyOf(payload: OutputDeltaPayload): string {
  if (typeof payload.nativeTurnId === 'string' && payload.nativeTurnId.length > 0) return payload.nativeTurnId;
  if (typeof payload.nativeItemId === 'string' && payload.nativeItemId.length > 0) return payload.nativeItemId;
  return 'turn';
}

/**
 * Fold one batch of worker-events/1 frames ({cursor,type,payload}) into the
 * live tail. Frames arrive already filtered to one task by the main bridge.
 */
export function reduceNativeTaskEventBatch(
  previous: NativeLiveStreamState,
  frames: ReadonlyArray<{ cursor?: unknown; type?: unknown; payload?: unknown }>
): NativeLiveStreamState {
  let state = previous;
  for (const frame of frames) {
    const next = reduceNativeTaskEventFrame(state, frame);
    if (next !== state) state = next;
  }
  return state;
}

export function reduceNativeTaskEventFrame(
  previous: NativeLiveStreamState,
  frame: { cursor?: unknown; type?: unknown; payload?: unknown }
): NativeLiveStreamState {
  if (typeof frame.type !== 'string') return previous;
  const cursor = typeof frame.cursor === 'number' && Number.isSafeInteger(frame.cursor)
    ? frame.cursor : null;
  // Durable-style dedupe: replayed cursors are dropped entirely.
  if (cursor !== null && cursor <= previous.lastCursor) return previous;
  const gap = cursor !== null && previous.lastCursor > 0 && cursor !== previous.lastCursor + 1;
  const observedAt = Date.now();

  if (frame.type === 'OUTPUT_DELTA') {
    const payload = (typeof frame.payload === 'object' && frame.payload !== null
      ? frame.payload : {}) as OutputDeltaPayload;
    if (typeof payload.delta !== 'string' || payload.delta.length === 0) {
      // Still advance the cursor — a malformed delta must not wedge dedupe.
      if (cursor === null) return previous;
      return { ...previous, lastCursor: cursor, interrupted: previous.interrupted || gap, lastUpdatedAt: observedAt };
    }
    const key = turnKeyOf(payload);
    const bucket = previous.turns.get(key);
    let text = (bucket?.text ?? '') + payload.delta;
    let truncated = bucket?.truncated ?? false;
    if (text.length > NATIVE_LIVE_TAIL_MAX_CHARS) {
      text = text.slice(text.length - NATIVE_LIVE_TAIL_MAX_CHARS);
      truncated = true;
    }
    const turns = new Map(previous.turns);
    turns.set(key, {
      nativeTurnId: key,
      text,
      lastCursor: cursor ?? bucket?.lastCursor ?? 0,
      truncated,
      firstUpdatedAt: bucket?.firstUpdatedAt ?? observedAt,
      lastUpdatedAt: observedAt
    });
    return {
      ...previous, turns,
      lastCursor: cursor ?? previous.lastCursor,
      interrupted: previous.interrupted || gap,
      lastUpdatedAt: observedAt
    };
  }

  if (frame.type === 'THINKING_DELTA' || frame.type === 'REASONING_DELTA') {
    const payload = (typeof frame.payload === 'object' && frame.payload !== null
      ? frame.payload : {}) as OutputDeltaPayload;
    if (typeof payload.delta !== 'string' || payload.delta.length === 0) {
      if (cursor === null) return previous;
      return { ...previous, lastCursor: cursor, interrupted: previous.interrupted || gap, lastUpdatedAt: observedAt };
    }
    const key = turnKeyOf(payload);
    const bucket = previous.thinking.get(key);
    let text = (bucket?.text ?? '') + payload.delta;
    let truncated = bucket?.truncated ?? false;
    if (text.length > NATIVE_THINKING_MAX_CHARS) {
      text = text.slice(text.length - NATIVE_THINKING_MAX_CHARS);
      truncated = true;
    }
    const thinking = new Map(previous.thinking);
    thinking.set(key, { nativeTurnId: key, text, truncated, lastUpdatedAt: observedAt });
    return {
      ...previous, thinking,
      lastCursor: cursor ?? previous.lastCursor,
      interrupted: previous.interrupted || gap,
      lastUpdatedAt: observedAt
    };
  }

  if (frame.type === 'ASSISTANT_MESSAGE') {
    // Terminal assistant row landed upstream: its turn's delta tail is
    // superseded by the authoritative message and must clear now — the
    // structured transcript owns the row from this point.
    const payload = (typeof frame.payload === 'object' && frame.payload !== null
      ? frame.payload : {}) as AssistantMessagePayload;
    const key = typeof payload.nativeTurnId === 'string' && payload.nativeTurnId.length > 0
      ? payload.nativeTurnId : null;
    const turns = new Map(previous.turns);
    if (key !== null) {
      if (!turns.has(key) && cursor === null) return previous;
      turns.delete(key);
    } else {
      // worker-events/1 producers that never assigned a task-level turn id
      // (pi keeps nativeTurnId null and reports the per-response
      // responseId only on OUTPUT_DELTA rows) emit the terminal without a
      // correlating key. The event spine is serial per task: every bucket
      // still open precedes this terminal and belongs to the turn it just
      // settled, so the whole tail is superseded — keyed or not. A bucket
      // the terminal does not cover stays honest via `interrupted`, never
      // via a fabricated turn match.
      if (turns.size === 0 && cursor === null) return previous;
      turns.clear();
    }
    return {
      ...previous, turns,
      lastCursor: cursor ?? previous.lastCursor,
      interrupted: previous.interrupted || gap,
      lastUpdatedAt: observedAt
    };
  }

  // Unknown event kinds still advance the cursor so heartbeats/id-bearing
  // control rows do not wedge deduplication.
  if (cursor === null) return previous;
  return { ...previous, lastCursor: cursor, interrupted: previous.interrupted || gap, lastUpdatedAt: observedAt };
}

/** Mark the tail lossy when the stream reported a resync/interruption. */
export function interruptNativeLiveStream(previous: NativeLiveStreamState): NativeLiveStreamState {
  if (previous.interrupted) return previous;
  return { ...previous, interrupted: true, lastUpdatedAt: Date.now() };
}

/**
 * Authoritative reconciliation (§8.1): once a TASK_MESSAGES page proves the
 * terminal assistant message for a turn, its ephemeral tail clears — the
 * structured transcript row owns the text from then on. `terminalTurnIds`
 * is the set of nativeTurnIds whose assistant message reached a terminal
 * status in the latest authoritative page.
 */
export function clearSettledNativeTurns(
  previous: NativeLiveStreamState,
  terminalTurnIds: ReadonlySet<string>
): NativeLiveStreamState {
  if (terminalTurnIds.size === 0 || previous.turns.size === 0) return previous;
  let changed = false;
  const turns = new Map(previous.turns);
  for (const turnId of terminalTurnIds) {
    if (turns.delete(turnId)) changed = true;
  }
  if (!changed) return previous;
  return { ...previous, turns };
}

/** Combined visible tail text for the transcript-end generating row. */
export function nativeLiveTailText(state: NativeLiveStreamState): string {
  let text = '';
  for (const turn of state.turns.values()) {
    if (turn.text.length === 0) continue;
    if (text.length > 0) text += '\n';
    text += turn.text;
  }
  return text;
}

/** Reasoning buckets in first-seen order, for the transcript 思考 blocks. */
export function nativeThinkingBlocks(state: NativeLiveStreamState): NativeThinkingState[] {
  return [...state.thinking.values()].filter(bucket => bucket.text.trim().length > 0);
}
