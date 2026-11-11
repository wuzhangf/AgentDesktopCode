/**
 * nativeVisibleTextProjection reducer tests (worker-events/1 §8.4):
 * OUTPUT_DELTA append + per-turn bucketing, cursor dedupe, gap/interrupted
 * honesty, 8192-char tail bound, ASSISTANT_MESSAGE clearing, and the
 * authoritative TASK_MESSAGES settle sweep.
 */
import { describe, expect, it } from 'vitest';
import {
  NATIVE_LIVE_TAIL_MAX_CHARS,
  clearSettledNativeTurns,
  emptyNativeLiveStream,
  interruptNativeLiveStream,
  nativeLiveTailText,
  reduceNativeTaskEventBatch,
  reduceNativeTaskEventFrame,
  type NativeLiveStreamState
} from '../../src/renderer/app/activity/nativeVisibleTextProjection';

const delta = (cursor: number, text: string, nativeTurnId = 'turn-1') => ({
  cursor, type: 'OUTPUT_DELTA',
  payload: { delta: text, nativeTurnId }
});

describe('native live-tail projection', () => {
  it('appends OUTPUT_DELTA payloads into a per-turn tail', () => {
    let state = emptyNativeLiveStream();
    state = reduceNativeTaskEventBatch(state, [delta(1, 'Hello '), delta(2, 'world')]);
    expect(nativeLiveTailText(state)).toBe('Hello world');
    expect(state.turns.get('turn-1')?.text).toBe('Hello world');
    expect(state.lastCursor).toBe(2);
    expect(state.interrupted).toBe(false);
  });

  it('keeps separate buckets for different nativeTurnIds', () => {
    const state = reduceNativeTaskEventBatch(emptyNativeLiveStream(), [
      delta(1, 'first ', 'turn-a'),
      delta(2, 'second ', 'turn-b'),
      delta(3, 'half', 'turn-a'),
      delta(4, 'reply', 'turn-b')
    ]);
    expect(state.turns.get('turn-a')?.text).toBe('first half');
    expect(state.turns.get('turn-b')?.text).toBe('second reply');
    expect(nativeLiveTailText(state)).toContain('first half');
    expect(nativeLiveTailText(state)).toContain('second reply');
  });

  it('drops replayed cursors (dedupe by sequence)', () => {
    let state = emptyNativeLiveStream();
    state = reduceNativeTaskEventBatch(state, [delta(1, 'a'), delta(2, 'b'), delta(3, 'c')]);
    const before = state;
    state = reduceNativeTaskEventBatch(state, [delta(2, 'b'), delta(1, 'a')]);
    expect(state).toBe(before);
    expect(nativeLiveTailText(state)).toBe('abc');
  });

  it('marks the tail interrupted on a cursor gap', () => {
    let state = emptyNativeLiveStream();
    state = reduceNativeTaskEventBatch(state, [delta(1, 'a'), delta(4, 'd')]);
    expect(state.interrupted).toBe(true);
    // The tail still carries what arrived — it is honestly lossy, not hidden.
    expect(nativeLiveTailText(state)).toBe('ad');
    expect(state.lastCursor).toBe(4);
  });

  it('caps the visible tail at 8192 chars and marks truncation', () => {
    const big = 'x'.repeat(NATIVE_LIVE_TAIL_MAX_CHARS + 100);
    const state = reduceNativeTaskEventFrame(emptyNativeLiveStream(), delta(1, big));
    const turn = state.turns.get('turn-1');
    expect(turn?.text.length).toBe(NATIVE_LIVE_TAIL_MAX_CHARS);
    expect(turn?.truncated).toBe(true);
    expect(turn?.text.startsWith('x'.repeat(100))).toBe(true);
  });

  it('clears the matching turn tail on terminal ASSISTANT_MESSAGE', () => {
    let state = emptyNativeLiveStream();
    state = reduceNativeTaskEventBatch(state, [
      delta(1, 'partial ', 'turn-a'),
      delta(2, 'other ', 'turn-b')
    ]);
    state = reduceNativeTaskEventFrame(state, {
      cursor: 3, type: 'ASSISTANT_MESSAGE', payload: { nativeTurnId: 'turn-a' }
    });
    expect(state.turns.has('turn-a')).toBe(false);
    expect(state.turns.get('turn-b')?.text).toBe('other ');
    expect(state.lastCursor).toBe(3);
  });

  it('retires the serial tail when the terminal omits nativeTurnId (pi shape)', () => {
    // pi never assigns a task-level nativeTurnId: terminal rows carry
    // nativeTurnId:null while OUTPUT_DELTA rows may key on the engine's
    // per-response responseId — keyed clearing alone can never retire those
    // buckets, so the unkeyed terminal supersedes the whole in-flight tail.
    let state = emptyNativeLiveStream();
    state = reduceNativeTaskEventBatch(state, [
      delta(1, 'Hello ', 'resp_aaa'),
      delta(2, 'world', 'resp_aaa')
    ]);
    state = reduceNativeTaskEventFrame(state, {
      cursor: 3, type: 'ASSISTANT_MESSAGE',
      payload: { nativeTurnId: null, text: 'Hello world' }
    });
    expect(state.turns.size).toBe(0);
    expect(nativeLiveTailText(state)).toBe('');
    expect(state.lastCursor).toBe(3);
    // A marker-only terminal (no text, no turn id) retires the same way.
    state = reduceNativeTaskEventBatch(state, [delta(4, 'again', 'resp_bbb')]);
    state = reduceNativeTaskEventFrame(state, {
      cursor: 5, type: 'ASSISTANT_MESSAGE', payload: {}
    });
    expect(state.turns.size).toBe(0);
  });

  it('clears a turn tail once the authoritative page settles that turn', () => {
    let state = emptyNativeLiveStream();
    state = reduceNativeTaskEventBatch(state, [delta(1, 'tail'), delta(2, 'rest', 'turn-b')]);
    const next = clearSettledNativeTurns(state, new Set(['turn-1']));
    expect(next.turns.has('turn-1')).toBe(false);
    expect(next.turns.get('turn-b')?.text).toBe('rest');
    // Unknown settles never mutate the projection.
    expect(clearSettledNativeTurns(next, new Set(['turn-x']))).toBe(next);
  });

  it('marks interruption from stream resync signals', () => {
    const state = reduceNativeTaskEventFrame(emptyNativeLiveStream(), delta(1, 'a'));
    const interrupted = interruptNativeLiveStream(state);
    expect(interrupted.interrupted).toBe(true);
    expect(interruptNativeLiveStream(interrupted)).toBe(interrupted);
  });

  it('ignores malformed frames without wedging the cursor', () => {
    let state = emptyNativeLiveStream();
    state = reduceNativeTaskEventFrame(state, { cursor: 1, type: 'OUTPUT_DELTA', payload: { nativeTurnId: 'turn-1' } });
    expect(state.lastCursor).toBe(1); // cursor advanced, nothing appended
    state = reduceNativeTaskEventFrame(state, delta(2, 'ok'));
    expect(nativeLiveTailText(state)).toBe('ok');
    const unknown = reduceNativeTaskEventFrame(state, { cursor: 3, type: 'HEARTBEAT', payload: null });
    expect(unknown.lastCursor).toBe(3);
  });
});
