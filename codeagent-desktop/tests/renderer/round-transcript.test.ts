import { describe, expect, it } from 'vitest';
import {
  answerYieldRoundId,
  deriveRoundTranscript,
  mergeRoundBuckets,
  ungroupedTextOf,
  type RoundTextBucketLike
} from '../../src/renderer/app/activity/roundDisplayModel';
import {
  reduceVisibleOutput,
  reduceVisibleReasoning
} from '../../src/renderer/app/activity/visibleTextProjection';
import type { RunActivity } from '../../src/renderer/app/activity/activityTypes';

function activity(id: string, overrides: Partial<RunActivity> = {}): RunActivity {
  return {
    activityId: id,
    runId: 'run-1',
    kind: 'COMMAND',
    status: 'SUCCEEDED',
    ...overrides
  };
}

function bucket(roundId: string, text: string, overrides: Partial<RoundTextBucketLike> = {}): RoundTextBucketLike {
  return { roundId, text, truncated: false, ...overrides };
}

describe('round transcript grouping (design 2026-09-19 §4.2)', () => {
  it('groups activities by explicit roundId, never by position', () => {
    const { sections, blocks } = deriveRoundTranscript({
      runId: 'run-1',
      runTerminal: false,
      activities: [
        activity('a1', { roundId: 'r1', roundOrdinal: 1, startCursor: 10 }),
        activity('a2', { roundId: 'r2', roundOrdinal: 2, startCursor: 11 }),
        activity('a3', { roundId: 'r1', roundOrdinal: 1, startCursor: 12 })
      ],
      nowMs: 1000
    });
    expect(blocks).toHaveLength(2);
    expect(blocks[0]?.roundId).toBe('r1');
    expect(blocks[0]?.activities.map((a) => a.activityId)).toEqual(['a1', 'a3']);
    expect(blocks[1]?.roundId).toBe('r2');
    // The r1 item at cursor 12 does NOT join r2 despite adjacency.
    expect(blocks[1]?.activities.map((a) => a.activityId)).toEqual(['a2']);
    expect(sections.filter((s) => s.type === 'round')).toHaveLength(2);
  });

  it('creates a block from the first text bucket before any activity arrives', () => {
    const { blocks } = deriveRoundTranscript({
      runId: 'run-1',
      runTerminal: false,
      activities: [],
      reasoningRounds: [bucket('r1', 'thinking…', { firstCursor: 5 })],
      nowMs: 1000
    });
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.thinking.reasoning?.text).toBe('thinking…');
    expect(blocks[0]?.live).toBe(true);
  });

  it('nests a subagent child inside its delegation span, not a flat section', () => {
    // The wire gives the child no roundId; its journal cursors always sit
    // inside the synchronous delegate call's span.
    const { sections, blocks, ungroupedCount } = deriveRoundTranscript({
      runId: 'run-1',
      runTerminal: true,
      activities: [
        activity('m1', { kind: 'MODEL', roundId: 'step-0-call-1', roundOrdinal: 1,
          startCursor: 563, endCursor: 577 }),
        activity('op-del', { kind: 'DELEGATION', roundId: 'step-0-call-1', roundOrdinal: 1,
          toolName: 'delegate_readonly_research', startCursor: 578, endCursor: 585 }),
        activity('subagent-run-sat-1-a1', { kind: 'DELEGATION',
          toolName: 'delegate_readonly_research', detail: 'repo-explorer · sat-1',
          startCursor: 581, endCursor: 582 }),
        activity('fin', { kind: 'FINALIZE', toolName: 'complete',
          startCursor: 962, endCursor: 965 })
      ],
      nowMs: 1000
    });
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.activities.map((a) => a.activityId))
      .toEqual(['op-del', 'subagent-run-sat-1-a1']);
    // FINALIZE sits outside every span: it stays ungrouped.
    expect(ungroupedCount).toBe(1);
    expect(sections.map((s) => s.type)).toEqual(['round', 'ungrouped']);
  });

  it('keeps ungrouped items in position-faithful flat sections', () => {
    const { sections, ungroupedCount } = deriveRoundTranscript({
      runId: 'run-1',
      runTerminal: false,
      activities: [
        activity('a1', { roundId: 'r1', roundOrdinal: 1, startCursor: 10 }),
        activity('u1', { startCursor: 11 }),
        activity('a2', { roundId: 'r2', roundOrdinal: 2, startCursor: 12 }),
        activity('u2', { startCursor: 13 }),
        activity('u3', { startCursor: 14 })
      ],
      nowMs: 1000
    });
    expect(ungroupedCount).toBe(3);
    const kinds = sections.map((s) => s.type);
    expect(kinds).toEqual(['round', 'ungrouped', 'round', 'ungrouped']);
    const firstUngrouped = sections[1];
    const secondUngrouped = sections[3];
    expect(firstUngrouped?.type === 'ungrouped'
      ? firstUngrouped.activities.map((a) => a.activityId) : null).toEqual(['u1']);
    expect(secondUngrouped?.type === 'ungrouped'
      ? secondUngrouped.activities.map((a) => a.activityId) : null).toEqual(['u2', 'u3']);
  });

  it('orders blocks by earliest member position with ordinal as reference', () => {
    const { blocks } = deriveRoundTranscript({
      runId: 'run-1',
      runTerminal: false,
      activities: [
        activity('a1', { roundId: 'r2', roundOrdinal: 2, startCursor: 20 }),
        activity('a2', { roundId: 'r1', roundOrdinal: 1, startCursor: 10 })
      ],
      nowMs: 1000
    });
    expect(blocks.map((b) => b.roundId)).toEqual(['r1', 'r2']);
    expect(blocks[0]?.displayNumber).toBe(1);
    expect(blocks[1]?.displayNumber).toBe(2);
  });

  it('routes MODEL to thinking and FINALIZE to phase rows, not ops', () => {
    const { blocks } = deriveRoundTranscript({
      runId: 'run-1',
      runTerminal: false,
      activities: [
        activity('m1', { roundId: 'r1', kind: 'MODEL', status: 'SUCCEEDED', durationMillis: 4000, startCursor: 1 }),
        activity('t1', { roundId: 'r1', kind: 'COMMAND', startCursor: 2 }),
        activity('f1', { roundId: 'r1', kind: 'FINALIZE', startCursor: 3 })
      ],
      nowMs: 1000
    });
    const block = blocks[0];
    expect(block?.thinking.modelActivity?.activityId).toBe('m1');
    expect(block?.activities.map((a) => a.activityId)).toEqual(['t1']);
    expect(block?.finalizeActivities.map((a) => a.activityId)).toEqual(['f1']);
    expect(block?.thinking.elapsedMs).toBe(4000);
  });

  it('ticks thinking elapsed from startedAt while the MODEL item is RUNNING', () => {
    // The start event carries a placeholder durationMillis=0; the live
    // clock must win until a completion lands (design §3.2).
    const { blocks } = deriveRoundTranscript({
      runId: 'run-1',
      runTerminal: false,
      activities: [
        activity('m1', {
          roundId: 'r1', kind: 'MODEL', status: 'RUNNING',
          durationMillis: 0,
          startedAt: '2026-09-19T03:55:31.783Z',
          startCursor: 1
        })
      ],
      nowMs: Date.parse('2026-09-19T03:55:36.783Z')
    });
    expect(blocks[0]?.thinking.elapsedMs).toBe(5000);
  });

  it('keeps the persisted placeholder for a stale RUNNING MODEL under a terminal run', () => {
    const { blocks } = deriveRoundTranscript({
      runId: 'run-1',
      runTerminal: true,
      activities: [
        activity('m1', {
          roundId: 'r1', kind: 'MODEL', status: 'RUNNING',
          durationMillis: 0,
          startedAt: '2026-09-19T03:55:31.783Z',
          startCursor: 1
        })
      ],
      nowMs: Date.parse('2026-09-19T04:00:00.000Z')
    });
    expect(blocks[0]?.thinking.elapsedMs).toBe(0);
    expect(blocks[0]?.hasStaleRunning).toBe(true);
  });

  it('marks only the newest block live while the run is non-terminal', () => {
    const { blocks } = deriveRoundTranscript({
      runId: 'run-1',
      runTerminal: false,
      activities: [
        activity('a1', { roundId: 'r1', startCursor: 1 }),
        activity('a2', { roundId: 'r2', status: 'RUNNING', startCursor: 2 })
      ],
      nowMs: 1000
    });
    expect(blocks[0]?.closed).toBe(true);
    expect(blocks[0]?.live).toBe(false);
    expect(blocks[1]?.closed).toBe(false);
    expect(blocks[1]?.live).toBe(true);
    expect(blocks[1]?.status).toBe('RUNNING');
  });

  it('freezes a superseded stale-RUNNING model at the next round’s first fact', () => {
    // §3.2 关闭即冻结: a newer round closes the block even when the old
    // MODEL item's terminal fact never landed — it must not tick.
    const build = (nowMs: number) => deriveRoundTranscript({
      runId: 'run-1',
      runTerminal: false,
      activities: [
        activity('m1', {
          roundId: 'r1', kind: 'MODEL', status: 'RUNNING',
          durationMillis: 0,
          startedAt: '2026-09-19T03:55:31.783Z',
          startCursor: 1
        }),
        activity('a2', {
          roundId: 'r2', status: 'RUNNING',
          startedAt: '2026-09-19T03:56:13.783Z',
          startCursor: 2
        })
      ],
      nowMs
    });
    const first = build(Date.parse('2026-09-19T04:00:00.000Z'));
    const later = build(Date.parse('2026-09-19T04:10:00.000Z'));
    expect(first.blocks[0]?.closed).toBe(true);
    expect(first.blocks[0]?.status).toBe('INCOMPLETE');
    expect(first.blocks[0]?.hasStaleRunning).toBe(true);
    // Frozen at the newer round's start — 42s, identical at any `now`.
    expect(first.blocks[0]?.thinking.elapsedMs).toBe(42_000);
    expect(later.blocks[0]?.thinking.elapsedMs).toBe(42_000);
    expect(later.blocks[0]?.elapsedMs).toBe(first.blocks[0]?.elapsedMs);
  });

  it('accumulates thinking elapsed from the round’s FIRST reasoning frame', () => {
    // The stream tail (lastUpdatedAt) must not anchor the timer — while
    // chunks arrive it would pin a live round at ~0s forever.
    const { blocks } = deriveRoundTranscript({
      runId: 'run-1',
      runTerminal: false,
      activities: [],
      reasoningRounds: [bucket('r1', 'thinking…', {
        firstUpdatedAt: 10_000,
        lastUpdatedAt: 14_000
      })],
      nowMs: 19_000
    });
    expect(blocks[0]?.live).toBe(true);
    expect(blocks[0]?.thinking.elapsedMs).toBe(9_000);
  });

  it('freezes a closed model-less round at its last observed reasoning chunk', () => {
    const { blocks } = deriveRoundTranscript({
      runId: 'run-1',
      runTerminal: false,
      activities: [
        activity('a2', { roundId: 'r2', status: 'RUNNING',
          startedAt: '2026-09-19T00:01:00.000Z', startCursor: 2 })
      ],
      reasoningRounds: [bucket('r1', 'thinking…', {
        firstCursor: 1,
        firstUpdatedAt: Date.parse('2026-09-19T00:00:10.000Z'),
        lastUpdatedAt: Date.parse('2026-09-19T00:00:25.000Z')
      })],
      nowMs: Date.parse('2026-09-19T00:05:00.000Z')
    });
    expect(blocks[0]?.closed).toBe(true);
    expect(blocks[0]?.thinking.elapsedMs).toBe(15_000);
  });

  it('bounds a closed block’s elapsed by the next round when member ends are missing', () => {
    const { blocks } = deriveRoundTranscript({
      runId: 'run-1',
      runTerminal: false,
      activities: [
        activity('a1', { roundId: 'r1', status: 'RUNNING',
          startedAt: '2026-09-19T00:00:00.000Z', startCursor: 1 }),
        activity('a2', { roundId: 'r2', status: 'RUNNING',
          startedAt: '2026-09-19T00:01:00.000Z', startCursor: 2 })
      ],
      nowMs: Date.parse('2026-09-19T00:10:00.000Z')
    });
    expect(blocks[0]?.elapsedMs).toBe(60_000);
    expect(blocks[0]?.finishedAtMs).toBe(Date.parse('2026-09-19T00:01:00.000Z'));
    expect(blocks[0]?.hasStaleRunning).toBe(true);
    expect(blocks[1]?.elapsedMs).toBe(540_000);
  });

  it('opens a round’s wall clock at the model-call start, not the first op', () => {
    // 思考 8s + a 300ms op: the head elapsed must cover the whole round —
    // an ops-only span would fall under 1s and render as nothing at all.
    const { blocks } = deriveRoundTranscript({
      runId: 'run-1',
      runTerminal: true,
      activities: [
        activity('m1', {
          roundId: 'r1', kind: 'MODEL', status: 'SUCCEEDED',
          startedAt: '2026-09-19T00:00:00.000Z',
          finishedAt: '2026-09-19T00:00:08.000Z',
          durationMillis: 8000,
          startCursor: 1, endCursor: 2
        }),
        activity('a1', {
          roundId: 'r1',
          startedAt: '2026-09-19T00:00:08.200Z',
          finishedAt: '2026-09-19T00:00:08.500Z',
          startCursor: 3, endCursor: 4
        })
      ],
      nowMs: Date.parse('2026-09-19T00:10:00.000Z')
    });
    expect(blocks[0]?.startedAtMs).toBe(Date.parse('2026-09-19T00:00:00.000Z'));
    expect(blocks[0]?.finishedAtMs).toBe(Date.parse('2026-09-19T00:00:08.500Z'));
    expect(blocks[0]?.elapsedMs).toBe(8500);
  });

  it('falls back to the model-call duration when a closed round has no timestamps', () => {
    const { blocks } = deriveRoundTranscript({
      runId: 'run-1',
      runTerminal: true,
      activities: [
        activity('m1', { roundId: 'r1', kind: 'MODEL', status: 'SUCCEEDED',
          durationMillis: 8000, startCursor: 1 }),
        activity('a1', { roundId: 'r1', startCursor: 2 })
      ],
      nowMs: 1000
    });
    expect(blocks[0]?.startedAtMs).toBeNull();
    expect(blocks[0]?.elapsedMs).toBe(8000);
  });

  it('flags stale RUNNING members under a terminal run as incomplete', () => {
    const { blocks } = deriveRoundTranscript({
      runId: 'run-1',
      runTerminal: true,
      activities: [activity('a1', { roundId: 'r1', status: 'RUNNING', startCursor: 1 })],
      nowMs: 1000
    });
    expect(blocks[0]?.status).toBe('INCOMPLETE');
    expect(blocks[0]?.hasStaleRunning).toBe(true);
    expect(blocks[0]?.closed).toBe(true);
  });
});

describe('answer-round dedup (design §4.4)', () => {
  it('yields the last zero-activity round text to the answer message', () => {
    const { blocks } = deriveRoundTranscript({
      runId: 'run-1',
      runTerminal: true,
      activities: [activity('a1', { roundId: 'r1', startCursor: 1 })],
      outputRounds: [
        bucket('r1', '我先看一下…'),
        bucket('r2', '最终答复正文')
      ],
      nowMs: 1000
    });
    expect(answerYieldRoundId(blocks, true)).toBe('r2');
  });

  it('does not dedup when the last round carried tool ops', () => {
    const { blocks } = deriveRoundTranscript({
      runId: 'run-1',
      runTerminal: true,
      activities: [
        activity('a1', { roundId: 'r1', startCursor: 1 }),
        activity('a2', { roundId: 'r2', startCursor: 2 })
      ],
      outputRounds: [bucket('r1', 'x'), bucket('r2', 'y')],
      nowMs: 1000
    });
    expect(answerYieldRoundId(blocks, true)).toBeNull();
  });

  it('honours an explicit message roundId when the contract carries it', () => {
    const { blocks } = deriveRoundTranscript({
      runId: 'run-1',
      runTerminal: true,
      activities: [],
      outputRounds: [bucket('r1', 'a'), bucket('r2', 'b')],
      nowMs: 1000
    });
    expect(answerYieldRoundId(blocks, true, 'r1')).toBe('r1');
    // A round with ops never yields even when named explicitly.
    expect(answerYieldRoundId(blocks, true, 'missing')).toBeNull();
  });

  it('never dedups while the run is still live', () => {
    const { blocks } = deriveRoundTranscript({
      runId: 'run-1',
      runTerminal: false,
      activities: [],
      outputRounds: [bucket('r1', 'a')],
      nowMs: 1000
    });
    expect(answerYieldRoundId(blocks, false)).toBeNull();
  });
});

describe('ungroupedTextOf run-level fallback (design §5.2)', () => {
  it('prefers the live fold and carries its stream stats', () => {
    const bucket = ungroupedTextOf(
      { ungroupedText: 'loose', interrupted: true, receivedBytes: 12, totalBytes: 20, droppedChunks: 1, lastSequence: 4 },
      { text: 'snap' }
    );
    expect(bucket?.text).toBe('loose');
    expect(bucket?.interrupted).toBe(true);
    expect(bucket?.receivedBytes).toBe(12);
  });

  it('falls back to snapshot text only when no segments exist', () => {
    expect(ungroupedTextOf(null, { text: 'legacy', truncated: true, complete: true })?.text).toBe('legacy');
    expect(ungroupedTextOf(null, { text: 'agg', segments: [{ roundId: 'r1' }] })).toBeNull();
    expect(ungroupedTextOf(null, null)).toBeNull();
  });
});

describe('mergeRoundBuckets live×snapshot merge (design §5.2/§5.4)', () => {
  it('keeps live text while the run is non-terminal', () => {
    const merged = mergeRoundBuckets(
      [bucket('r1', 'live-text'), bucket('r2', 'live-only')],
      [bucket('r1', 'snap-text'), bucket('r3', 'snap-only')],
      false
    );
    expect(merged.map((b) => [b.roundId, b.text])).toEqual([
      ['r1', 'live-text'], ['r3', 'snap-only'], ['r2', 'live-only']
    ]);
  });

  it('lets the authoritative snapshot text win under terminal', () => {
    const merged = mergeRoundBuckets(
      [bucket('r1', 'live-partial'), bucket('r2', 'live-only')],
      [bucket('r1', 'snap-final', { complete: true })],
      true
    );
    const r1 = merged.find((b) => b.roundId === 'r1');
    expect(r1?.text).toBe('snap-final');
    expect(r1?.complete).toBe(true);
    // Live-only rounds survive — the snapshot may lag the last frames.
    expect(merged.find((b) => b.roundId === 'r2')?.text).toBe('live-only');
  });

  it('skips keyless buckets and tolerates absent sources', () => {
    expect(mergeRoundBuckets(null, null, false)).toEqual([]);
    const merged = mergeRoundBuckets(
      [{ roundId: '', text: 'no-key', truncated: false }, bucket('r1', 'x')],
      null,
      false
    );
    expect(merged.map((b) => b.roundId)).toEqual(['r1']);
  });
});

describe('per-round text reducers (design §5.2)', () => {
  function outputFrame(runId: string, text: string, extra: Record<string, unknown> = {}, cursor = 1) {
    return { cursor, type: 'run.output.append', payload: { runId, text, ...extra } };
  }

  it('buckets output chunks by explicit roundId', () => {
    let state = reduceVisibleOutput(new Map(), outputFrame('run-1', 'A1', { roundId: 'r1', sequence: 1 }, 10));
    state = reduceVisibleOutput(state, outputFrame('run-1', 'B1', { roundId: 'r2', sequence: 2 }, 11));
    state = reduceVisibleOutput(state, outputFrame('run-1', 'A2', { roundId: 'r1', sequence: 3 }, 12));
    const run = state.get('run-1');
    expect(run?.text).toBe('A1B1A2');
    expect(run?.rounds.get('r1')?.text).toBe('A1A2');
    expect(run?.rounds.get('r2')?.text).toBe('B1');
    expect(run?.rounds.get('r1')?.firstCursor).toBe(10);
    expect(run?.ungroupedText).toBe('');
  });

  it('keeps frames without roundId in the run-level fallback bucket', () => {
    let state = reduceVisibleOutput(new Map(), outputFrame('run-1', 'keyed', { roundId: 'r1', sequence: 1 }));
    state = reduceVisibleOutput(state, outputFrame('run-1', 'loose', { sequence: 2 }));
    const run = state.get('run-1');
    expect(run?.rounds.get('r1')?.text).toBe('keyed');
    expect(run?.ungroupedText).toBe('loose');
    expect(run?.rounds.has('')).toBe(false);
  });

  it('drops replayed duplicates by sequence without touching round buckets', () => {
    let state = reduceVisibleOutput(new Map(), outputFrame('run-1', 'A', { roundId: 'r1', sequence: 5 }));
    state = reduceVisibleOutput(state, outputFrame('run-1', 'A', { roundId: 'r1', sequence: 5 }));
    state = reduceVisibleOutput(state, outputFrame('run-1', 'old', { roundId: 'r1', sequence: 3 }));
    const run = state.get('run-1');
    expect(run?.text).toBe('A');
    expect(run?.rounds.get('r1')?.text).toBe('A');
  });

  it('marks a sequence gap as interrupted on the run and the round', () => {
    let state = reduceVisibleOutput(new Map(), outputFrame('run-1', 'A', { roundId: 'r1', sequence: 1 }));
    state = reduceVisibleOutput(state, outputFrame('run-1', 'B', { roundId: 'r1', sequence: 4 }));
    const run = state.get('run-1');
    expect(run?.interrupted).toBe(true);
    expect(run?.rounds.get('r1')?.interrupted).toBe(true);
  });

  it('keeps round buckets on run.terminal instead of deleting state', () => {
    let state = reduceVisibleOutput(new Map(), outputFrame('run-1', 'A', { roundId: 'r1', sequence: 1 }));
    state = reduceVisibleOutput(state, { type: 'run.terminal', payload: { runId: 'run-1' } });
    const run = state.get('run-1');
    expect(run?.terminal).toBe(true);
    expect(run?.rounds.get('r1')?.text).toBe('A');
  });

  it('buckets reasoning chunks identically', () => {
    let state = reduceVisibleReasoning(new Map(), {
      cursor: 7,
      type: 'run.reasoning.append',
      payload: { runId: 'run-1', text: 'think', roundId: 'r9', roundOrdinal: 9, sequence: 1 }
    });
    const run = state.get('run-1');
    expect(run?.rounds.get('r9')?.text).toBe('think');
    expect(run?.rounds.get('r9')?.roundOrdinal).toBe(9);
    expect(run?.ungroupedText).toBe('');
    state = reduceVisibleReasoning(state, { type: 'run.terminal', payload: { runId: 'run-1' } });
    expect(state.get('run-1')?.terminal).toBe(true);
  });
});
