/**
 * Model-interaction round display model (design 2026-09-19 §4).
 *
 * Grouping is contract-only: items join a round exclusively through the
 * explicit `roundId` on activities, output frames and reasoning frames.
 * The renderer never infers round ownership from event position, adjacent
 * prose or command names. Items without a `roundId` keep their actual
 * position in interleaved ungrouped sections (§3.4).
 */

import type { RunActivity } from './activityTypes';

/** Minimal text bucket shared by the live reducer fold and the snapshot
 * segment shape; callers normalize either source into this form. */
export interface RoundTextBucketLike {
  roundId: string;
  roundOrdinal?: number | null;
  text: string;
  truncated: boolean;
  /** Snapshot segments only; null while the live fold cannot prove it. */
  complete?: boolean | null;
  /** Live fold only: relay gap/drop evidence. */
  interrupted?: boolean;
  /** Journal-cursor ordering anchors when the live fold knows them. */
  firstCursor?: number;
  lastCursor?: number;
  /** Live fold only: renderer clock of the round's first frame. The
   * thinking anchor uses this — `lastUpdatedAt` tracks the stream tail
   * and would pin a live timer at ~0. */
  firstUpdatedAt?: number;
  lastUpdatedAt?: number;
  /** Live-fold stream stats for the sr-only diagnostic line (§3.4). */
  receivedBytes?: number;
  totalBytes?: number;
  droppedChunks?: number;
  lastSequence?: number;
}

export type RoundStatus = 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'INCOMPLETE';

/**
 * One model interaction as a transcript block (design §4).
 * `activities` excludes MODEL/TEXT/FINALIZE routing items; a block with
 * `activities.length === 0` is answer-level (§3.4).
 */
export interface RoundBlockModel {
  /** Stable React/ARIA key: `${runId}:${roundId}`. */
  key: string;
  runId: string;
  roundId: string;
  /** Authoritative `roundOrdinal` when any member carried it. */
  ordinal: number | null;
  /** Mechanical display number: ordinal ?? first-seen index (§3.4). */
  displayNumber: number;
  /** True for the newest block while the run is non-terminal. */
  live: boolean;
  /** True once a newer round appeared or the run went terminal. */
  closed: boolean;
  status: RoundStatus;
  thinking: {
    modelActivity: RunActivity | null;
    reasoning: {
      text: string;
      complete: boolean | null;
      truncated: boolean;
      interrupted: boolean;
    } | null;
    /** Thinking-anchor epoch ms; `approximate` marks arrival-time fallback. */
    anchorStartMs: number | null;
    anchorApproximate: boolean;
    elapsedMs: number | null;
  };
  /** Explanatory/streaming text of this round; answer-level when no ops. */
  promptText: string | null;
  promptInterrupted: boolean;
  promptTruncated: boolean;
  /** Live-fold stream stats for the prompt row's sr-only line (§3.4). */
  promptStats: { receivedBytes: number; totalBytes: number; droppedChunks: number; lastSequence: number } | null;
  /** FINALIZE routing items render as in-block phase rows (§4.1). */
  finalizeActivities: RunActivity[];
  activities: RunActivity[];
  /** Block wall-clock: the round's earliest observed fact — the MODEL
   * call start, the first streamed frame or the first member start — to
   * the latest end/now. A closed block freezes at its best-known end,
   * never at the live clock. */
  startedAtMs: number | null;
  finishedAtMs: number | null;
  elapsedMs: number | null;
  /** The block closed (terminal or a newer round) while members still
   * claim RUNNING — their end facts never landed (§3.4). */
  hasStaleRunning: boolean;
  /** Any member text hit a display bound or a stream gap was seen. */
  interrupted: boolean;
  truncated: boolean;
  /** Ordering anchor: earliest member event position. */
  position: number;
}

/** Position-faithful section list: round blocks interleaved with runs of
 * ungrouped activities at their actual event position (§3.4/§4.2). */
export type RoundTranscriptSection =
  | { type: 'round'; block: RoundBlockModel }
  | { type: 'ungrouped'; key: string; activities: RunActivity[] };

export interface RoundDisplayInput {
  runId: string;
  /** Run reached a terminal state; freezes open rounds. */
  runTerminal: boolean;
  /** Activity items in journal order (snapshot + live fold merged). */
  activities: ReadonlyArray<RunActivity>;
  /** Per-round visible-output buckets in first-seen/journal order. */
  outputRounds?: ReadonlyArray<RoundTextBucketLike> | null;
  /** Per-round reasoning buckets in first-seen/journal order. */
  reasoningRounds?: ReadonlyArray<RoundTextBucketLike> | null;
  /** Renderer clock for live elapsed values. */
  nowMs?: number;
}

function validMillis(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function epochMillis(value: unknown): number | null {
  if (typeof value !== 'string' || value.trim().length === 0) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function nonEmptyRoundId(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function positiveOrdinal(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;
}

/** Within-block activity order: startCursor → startedAt → insertion (§4.2). */
function activityPosition(activity: RunActivity, insertion: number): number {
  if (typeof activity.startCursor === 'number' && Number.isFinite(activity.startCursor)) {
    return activity.startCursor;
  }
  const started = epochMillis(activity.startedAt);
  if (started !== null) return started;
  return Number.MAX_SAFE_INTEGER - 1_000_000 + insertion;
}

interface MutableRound {
  roundId: string;
  ordinal: number | null;
  position: number;
  modelActivity: RunActivity | null;
  finalizeActivities: RunActivity[];
  activities: RunActivity[];
  reasoning: RoundTextBucketLike | null;
  output: RoundTextBucketLike | null;
}

/** Position an unkeyed text bucket never reaches — keeps round order stable
 * when a block is created by text before its first activity lands. */
const TEXT_POSITION_BIAS = 0.5;

function bumpPosition(round: MutableRound, position: number | null): void {
  if (position === null || !Number.isFinite(position)) return;
  if (position < round.position) round.position = position;
}

/**
 * Pure projection: activities + per-round text/reasoning buckets → ordered
 * transcript sections. Called on every render; O(n log n) in member count.
 */
export function deriveRoundTranscript(input: RoundDisplayInput): {
  sections: RoundTranscriptSection[];
  blocks: RoundBlockModel[];
  ungroupedCount: number;
} {
  const nowMs = input.nowMs ?? Date.now();
  const rounds = new Map<string, MutableRound>();
  const roundOrder: string[] = [];

  const roundFor = (roundId: string): MutableRound => {
    let round = rounds.get(roundId);
    if (!round) {
      round = {
        roundId,
        ordinal: null,
        position: Number.MAX_SAFE_INTEGER,
        modelActivity: null,
        finalizeActivities: [],
        activities: [],
        reasoning: null,
        output: null
      };
      rounds.set(roundId, round);
      roundOrder.push(roundId);
    }
    return round;
  };

  // Text/reasoning buckets create blocks too — a block exists from the
  // first item of a new round (§3.4 块先于内容成立).
  for (const bucket of input.reasoningRounds ?? []) {
    const roundId = nonEmptyRoundId(bucket.roundId);
    if (!roundId) continue;
    const round = roundFor(roundId);
    round.reasoning = bucket;
    round.ordinal = round.ordinal ?? positiveOrdinal(bucket.roundOrdinal);
    const cursor = typeof bucket.firstCursor === 'number' ? bucket.firstCursor : null;
    bumpPosition(round, cursor !== null ? cursor + TEXT_POSITION_BIAS : null);
  }
  for (const bucket of input.outputRounds ?? []) {
    const roundId = nonEmptyRoundId(bucket.roundId);
    if (!roundId) continue;
    const round = roundFor(roundId);
    round.output = bucket;
    round.ordinal = round.ordinal ?? positiveOrdinal(bucket.roundOrdinal);
    const cursor = typeof bucket.firstCursor === 'number' ? bucket.firstCursor : null;
    bumpPosition(round, cursor !== null ? cursor + TEXT_POSITION_BIAS : null);
  }

  // A delegate's subagent children carry no roundId of their own, but their
  // journal cursors always land inside the synchronous delegation call's
  // cursor span (the call cannot complete before its children). Containment
  // inside a DELEGATION span is the only parent link the wire exposes, so a
  // DELEGATION child joins its delegate's round instead of a flat section;
  // everything else (e.g. FINALIZE) keeps its ungrouped position.
  const delegationSpans: { start: number; end: number; roundId: string }[] = [];
  for (const activity of input.activities) {
    if (activity.kind !== 'DELEGATION') continue;
    const roundId = nonEmptyRoundId(activity.roundId);
    if (roundId === null
      || typeof activity.startCursor !== 'number' || !Number.isFinite(activity.startCursor)) continue;
    delegationSpans.push({
      start: activity.startCursor,
      end: typeof activity.endCursor === 'number' && Number.isFinite(activity.endCursor)
        ? activity.endCursor : Number.MAX_SAFE_INTEGER,
      roundId
    });
  }
  // Innermost span first when delegate calls ever nest.
  delegationSpans.sort((a, b) => b.start - a.start);
  const containingRoundId = (activity: RunActivity): string | null => {
    if (activity.kind !== 'DELEGATION') return null;
    const cursor = typeof activity.startCursor === 'number' && Number.isFinite(activity.startCursor)
      ? activity.startCursor
      : (typeof activity.endCursor === 'number' && Number.isFinite(activity.endCursor)
          ? activity.endCursor : null);
    if (cursor === null) return null;
    const span = delegationSpans.find((candidate) => cursor >= candidate.start && cursor <= candidate.end);
    return span?.roundId ?? null;
  };

  // Route activities: MODEL → thinking, FINALIZE → phase row, TEXT →
  // output text (§5.5-A compatibility), rest → ops. Ungrouped items are
  // collected with their event positions and re-interleaved later (§4.2.4).
  const ungroupedItems: { position: number; activity: RunActivity }[] = [];
  let ungroupedCount = 0;
  input.activities.forEach((activity, index) => {
    const roundId = nonEmptyRoundId(activity.roundId) ?? containingRoundId(activity);
    if (roundId === null) {
      ungroupedItems.push({ position: activityPosition(activity, index), activity });
      ungroupedCount += 1;
      return;
    }
    const round = roundFor(roundId);
    round.ordinal = round.ordinal ?? positiveOrdinal(activity.roundOrdinal);
    const position = activityPosition(activity, index);
    bumpPosition(round, position);
    if (activity.kind === 'MODEL') {
      // First MODEL item wins; later revisions merge status facts.
      if (!round.modelActivity) round.modelActivity = activity;
      else if (activity.status !== 'RUNNING') round.modelActivity = activity;
      return;
    }
    if (activity.kind === 'FINALIZE') {
      round.finalizeActivities.push(activity);
      return;
    }
    if (activity.kind === 'TEXT') {
      // §5.5-A compatibility: a TEXT item joins the round's prompt text.
      const itemText = typeof (activity as { detail?: string | null }).detail === 'string'
        ? (activity as { detail?: string | null }).detail as string
        : '';
      if (itemText.length > 0) {
        round.output = round.output
          ? { ...round.output, text: round.output.text + itemText }
          : {
              roundId,
              roundOrdinal: activity.roundOrdinal ?? null,
              text: itemText,
              truncated: Boolean(activity.truncated)
            };
      }
      return;
    }
    round.activities.push(activity);
  });

  // Order blocks: earliest member position is authoritative; roundOrdinal
  // is a stable ordering reference, then first-seen order (§4.2.2/§3.4).
  const firstSeenIndex = new Map<string, number>();
  roundOrder.forEach((roundId, index) => firstSeenIndex.set(roundId, index));
  const orderedRounds = [...rounds.values()].sort((a, b) => {
    if (a.position !== b.position) return a.position - b.position;
    const aOrd = a.ordinal ?? Number.MAX_SAFE_INTEGER;
    const bOrd = b.ordinal ?? Number.MAX_SAFE_INTEGER;
    if (aOrd !== bOrd) return aOrd - bOrd;
    return (firstSeenIndex.get(a.roundId) ?? 0) - (firstSeenIndex.get(b.roundId) ?? 0);
  });

  // Ungrouped activities keep their actual event position between blocks
  // (§3.4): consecutive ungrouped items form one flat section anchored at
  // the run's earliest position; a later round item splits the run.
  const ungroupedSections: { position: number; activities: RunActivity[] }[] = [];
  {
    ungroupedItems.sort((a, b) => a.position - b.position);
    let run: RunActivity[] = [];
    let runStart: number | null = null;
    const flush = (): void => {
      if (run.length > 0) {
        ungroupedSections.push({ position: runStart ?? 0, activities: run });
        run = [];
        runStart = null;
      }
    };
    for (const item of ungroupedItems) {
      // Split the flat run when a round member claims an earlier position —
      // the ungrouped item then sits between the two blocks, not inside
      // either one.
      if (run.length > 0 && runStart !== null) {
        const splitBefore = orderedRounds.some((round) =>
          runStart !== null && round.position > runStart && round.position < item.position);
        if (splitBefore) flush();
      }
      if (runStart === null) runStart = item.position;
      run.push(item.activity);
    }
    flush();
  }

  // Merge blocks and ungrouped runs into one position-ordered stream.
  const merged: { position: number; section: RoundTranscriptSection }[] = [];
  const lastBlockIndex = orderedRounds.length - 1;

  // Per-round wall-clock facts, computed once: the close bound of one
  // block borrows the NEXT block's earliest observed timestamp.
  const roundTimings = orderedRounds.map((round) => {
    const members = [...round.activities, ...round.finalizeActivities];
    const ends = [
      ...members.map((activity) => epochMillis(activity.finishedAt)),
      epochMillis(round.modelActivity?.finishedAt)
    ].filter((value): value is number => value !== null);
    // A round IS one model call (§5.1): its wall clock opens at the first
    // observed fact — the MODEL activity start or the round's first
    // streamed frame — not at the first routed op, which lands only after
    // the model finishes thinking.
    const earliest = [
      ...members.map((activity) => epochMillis(activity.startedAt)),
      epochMillis(round.modelActivity?.startedAt),
      validMillis(round.reasoning?.firstUpdatedAt),
      validMillis(round.output?.firstUpdatedAt)
    ].filter((value): value is number => value !== null && value > 0);
    return {
      earliestMs: earliest.length > 0 ? Math.min(...earliest) : null,
      lastEnd: ends.length > 0 ? Math.max(...ends) : null
    };
  });

  const blocks: RoundBlockModel[] = orderedRounds.map((round, blockIndex) => {
    const closed = input.runTerminal || blockIndex < lastBlockIndex;
    const live = !input.runTerminal && blockIndex === lastBlockIndex;
    const members = [...round.activities, ...round.finalizeActivities];
    const timing = roundTimings[blockIndex] ?? { earliestMs: null, lastEnd: null };
    const startedAtMs = timing.earliestMs;
    const lastEnd = timing.lastEnd;
    const claimsRunning = members.some((activity) => activity.status === 'RUNNING')
      || round.modelActivity?.status === 'RUNNING';
    // A closed block cannot still be running: a newer roundId or the run
    // terminal already superseded it — leftover RUNNING claims are stale
    // facts whose end events never landed (§3.4 残留 RUNNING).
    const hasStaleRunning = closed && claimsRunning;
    const hasRunning = !closed && claimsRunning;
    const hasFailed = members.some((activity) => activity.status === 'FAILED')
      || round.modelActivity?.status === 'FAILED';
    const status: RoundStatus = hasFailed ? 'FAILED'
      : hasStaleRunning ? 'INCOMPLETE'
      : hasRunning ? 'RUNNING'
      : 'SUCCEEDED';
    // Frozen end of a closed block (§3.2 关闭即冻结): latest member end →
    // last observed content of this round → the next round's first fact →
    // the block's own start. The live clock is only for live blocks.
    const contentLastMs = [
      validMillis(round.reasoning?.lastUpdatedAt),
      validMillis(round.output?.lastUpdatedAt)
    ].reduce<number | null>((acc, value) => (value !== null && value > 0
      ? (acc === null ? value : Math.max(acc, value))
      : acc), null);
    const closedEndMs = closed
      ? (lastEnd ?? contentLastMs ?? roundTimings[blockIndex + 1]?.earliestMs ?? startedAtMs)
      : null;
    const finishedAtMs = closed ? closedEndMs : null;

    const reasoningBucket = round.reasoning;
    const reasoning = reasoningBucket && reasoningBucket.text.length > 0
      ? {
          text: reasoningBucket.text,
          complete: reasoningBucket.complete ?? null,
          truncated: Boolean(reasoningBucket.truncated),
          interrupted: Boolean(reasoningBucket.interrupted)
        }
      : null;
    const model = round.modelActivity;
    const modelStart = epochMillis(model?.startedAt);
    const modelFinished = epochMillis(model?.finishedAt);
    const reasoningFirstMs = validMillis(round.reasoning?.firstUpdatedAt);
    const reasoningLastMs = validMillis(round.reasoning?.lastUpdatedAt);
    const anchorStartMs = modelStart
      ?? (reasoningFirstMs !== null && reasoningFirstMs > 0 ? reasoningFirstMs : null)
      ?? startedAtMs;
    const anchorApproximate = modelStart === null
      && reasoningBucket?.firstUpdatedAt === undefined
      && startedAtMs === null;
    // A RUNNING MODEL item carries durationMillis=0 from the start event —
    // the live clock is authoritative only while the block is live (design
    // 2026-09-19 §3.2: RUNNING 中跳秒，关闭即冻结). A stale RUNNING item in
    // a closed block freezes at its best-known end: its own finish → the
    // last observed reasoning chunk → the close bound → its start (0s).
    const thinkingElapsed = model !== null
      ? (model.status === 'RUNNING'
          ? (!closed
              ? (anchorStartMs !== null
                  ? Math.max(0, nowMs - anchorStartMs)
                  : validMillis(model.durationMillis))
              : (modelStart !== null
                  ? Math.max(0, (modelFinished ?? reasoningLastMs ?? closedEndMs ?? modelStart) - modelStart)
                  : validMillis(model.durationMillis)))
          : (validMillis(model.durationMillis)
              ?? (modelStart !== null
                  ? Math.max(0, (modelFinished
                      ?? (closed ? (reasoningLastMs ?? closedEndMs ?? modelStart) : nowMs)) - modelStart)
                  : null)))
      : (anchorStartMs !== null
          ? Math.max(0, (closed
              ? (reasoningLastMs ?? closedEndMs ?? anchorStartMs)
              : nowMs) - anchorStartMs)
          : null);

    // No timestamp facts at all: a closed round still owns its model-call
    // duration (or a reasoning-window estimate) as the honest floor, so the
    // head's 耗时 never contradicts the 思考 Ns label it sits next to.
    const elapsedMs = startedAtMs !== null
      ? Math.max(0, (closed ? (closedEndMs ?? startedAtMs) : nowMs) - startedAtMs)
      : (closed ? thinkingElapsed : null);

    const promptBucket = round.output;
    const promptText = promptBucket && promptBucket.text.length > 0
      ? promptBucket.text
      : null;
    const promptStats = promptBucket && typeof promptBucket.receivedBytes === 'number'
      ? {
          receivedBytes: promptBucket.receivedBytes,
          totalBytes: promptBucket.totalBytes ?? 0,
          droppedChunks: promptBucket.droppedChunks ?? 0,
          lastSequence: promptBucket.lastSequence ?? 0
        }
      : null;
    const block: RoundBlockModel = {
      key: `${input.runId}:${round.roundId}`,
      runId: input.runId,
      roundId: round.roundId,
      ordinal: round.ordinal,
      displayNumber: round.ordinal ?? blockIndex + 1,
      live,
      closed,
      status,
      thinking: {
        modelActivity: model,
        reasoning,
        anchorStartMs,
        anchorApproximate,
        elapsedMs: thinkingElapsed
      },
      promptText,
      promptInterrupted: Boolean(promptBucket?.interrupted),
      promptTruncated: Boolean(promptBucket?.truncated),
      promptStats,
      finalizeActivities: round.finalizeActivities,
      activities: round.activities,
      startedAtMs,
      finishedAtMs,
      elapsedMs,
      hasStaleRunning,
      interrupted: Boolean(reasoning?.interrupted || promptBucket?.interrupted),
      truncated: Boolean(reasoning?.truncated || promptBucket?.truncated),
      position: round.position
    };
    merged.push({ position: round.position, section: { type: 'round', block } });
    return block;
  });
  for (const ungrouped of ungroupedSections) {
    merged.push({
      position: ungrouped.position,
      section: {
        type: 'ungrouped',
        key: `${input.runId}:ungrouped:${Math.round(ungrouped.position)}`,
        activities: ungrouped.activities
      }
    });
  }
  merged.sort((a, b) => a.position - b.position);
  return {
    sections: merged.map((entry) => entry.section),
    blocks,
    ungroupedCount
  };
}

/**
 * Merge the live per-round fold with the authoritative snapshot segments
 * for the same text stream. Live buckets lead while frames arrive; once
 * the run is terminal the snapshot's per-round text is the honest end
 * state (covers SSE replay gaps), with live-only rounds still appended.
 */
export function mergeRoundBuckets(
  live: ReadonlyArray<RoundTextBucketLike> | null | undefined,
  snapshot: ReadonlyArray<RoundTextBucketLike> | null | undefined,
  terminal: boolean
): RoundTextBucketLike[] {
  const byId = new Map<string, RoundTextBucketLike>();
  for (const segment of snapshot ?? []) {
    if (segment.roundId) byId.set(segment.roundId, segment);
  }
  for (const bucket of live ?? []) {
    if (!bucket.roundId) continue;
    const snap = byId.get(bucket.roundId);
    byId.set(bucket.roundId, terminal && snap
      ? { ...bucket, text: snap.text, truncated: snap.truncated, complete: snap.complete ?? bucket.complete }
      : bucket);
  }
  return [...byId.values()];
}

/** Ungrouped text: the live fold knows it exactly; a snapshot exposes it
 * only when it has no per-round segments at all (legacy runs). */
export function ungroupedTextOf(
  live: { ungroupedText?: string; interrupted?: boolean; receivedBytes?: number; totalBytes?: number; droppedChunks?: number; lastSequence?: number } | null | undefined,
  snapshot: { text?: string | null; truncated?: boolean; complete?: boolean; segments?: ReadonlyArray<{ roundId: string }> | null } | null | undefined
): RoundTextBucketLike | null {
  if (live?.ungroupedText && live.ungroupedText.trim().length > 0) {
    return {
      roundId: '',
      text: live.ungroupedText,
      truncated: false,
      interrupted: live.interrupted,
      receivedBytes: live.receivedBytes,
      totalBytes: live.totalBytes,
      droppedChunks: live.droppedChunks,
      lastSequence: live.lastSequence
    };
  }
  if (snapshot && !(snapshot.segments && snapshot.segments.length > 0)
      && snapshot.text && snapshot.text.trim().length > 0) {
    return { roundId: '', text: snapshot.text, truncated: snapshot.truncated ?? false, complete: snapshot.complete ?? null };
  }
  return null;
}

/**
 * §4.4 handover key: the run-level answer message replaces the last
 * answer-level round's prompt row under terminal. A round qualifies only
 * when it carries text and zero routed ops — a mechanical fact, never a
 * guess. Returns the roundId whose prompt should yield, or null.
 */
export function answerYieldRoundId(
  blocks: ReadonlyArray<RoundBlockModel>,
  runTerminal: boolean,
  messageRoundId?: string | null
): string | null {
  if (!runTerminal) return null;
  const explicit = nonEmptyRoundId(messageRoundId);
  if (explicit !== null) {
    const match = blocks.find((block) => block.roundId === explicit
      && block.activities.length === 0);
    return match ? explicit : null;
  }
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const block = blocks[index];
    if (!block) continue;
    if (block.activities.length === 0 && block.promptText !== null) {
      return block.roundId;
    }
    // A later round carrying real ops means the message is not a
    // continuation of an earlier text round — no dedup (§4.4).
    if (block.activities.length > 0) return null;
  }
  return null;
}
