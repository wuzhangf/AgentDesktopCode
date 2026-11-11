import { describe, expect, it } from 'vitest';
import { runStateLabel, runStateTone, sessionStatusView } from '../../src/renderer/app/sessionStatus';
import type { AttentionLike, RunLike, SessionLike } from '../../src/renderer/app/queries';

/**
 * Design 2026-09-02 §11.4 / WP7: the outcome severity axis must
 * surface "completed with warnings" for a succeeded run carrying
 * proven pre-existing failures — never as failure, never as plain
 * success. Absent V2 fields keep the legacy projection untouched.
 */
function run(overrides: Partial<RunLike>): RunLike {
  return {
    runId: 'run-1',
    taskId: 'task-1',
    state: 'SUCCEEDED',
    stateVersion: 1,
    sessionId: 'session-1',
    ...overrides,
  };
}

function session(): SessionLike {
  return { sessionId: 'session-1', sessionVersion: 1 };
}

describe('session status severity projection (design 2026-09-02 §11.4)', () => {
  it('shows completed-with-warnings for a succeeded run with WARNING severity', () => {
    const view = sessionStatusView(session(), [run({ outcomeSeverity: 'WARNING' })], []);
    expect(view.label).toBe('已完成 · 有警告');
    expect(view.tone).toBe('warning');
    expect(view.active).toBe(false);
    expect(view.attention).toBe(false);
  });

  it('keeps plain success untouched when V2 fields are absent (legacy API)', () => {
    const view = sessionStatusView(session(), [run({})], []);
    expect(view.label).toBe('就绪');
    expect(view.tone).toBe('neutral');
  });

  it('keeps OK severity as plain success', () => {
    const view = sessionStatusView(session(), [run({ outcomeSeverity: 'OK' })], []);
    expect(view.label).toBe('就绪');
  });

  it('surfaces a terminal run whose artifact barrier is still pending', () => {
    const view = sessionStatusView(session(), [run({
      delivery: { status: 'PENDING', artifactsReady: false, stateVersion: 1 }
    })], []);
    expect(view.label).toBe('已完成 · 证据待回传');
    expect(view.tone).toBe('warning');
    expect(view.active).toBe(false);
  });

  it('failure still dominates warnings', () => {
    const view = sessionStatusView(session(), [
      run({ state: 'FAILED', outcomeSeverity: 'WARNING' }),
    ], []);
    expect(view.label).toBe('已失败');
    expect(view.tone).toBe('danger');
  });

  it('does not let an older failed run override a newer success', () => {
    const view = sessionStatusView(session(), [
      run({ runId: 'old', state: 'FAILED', updatedAt: '2026-09-21T10:00:00.000Z' }),
      run({ runId: 'new', state: 'SUCCEEDED', updatedAt: '2026-09-21T10:01:00.000Z' }),
    ], []);
    expect(view.label).toBe('就绪');
    expect(view.tone).toBe('neutral');
    expect(view.active).toBe(false);
  });

  it('uses the later snapshot entry when legacy runs have no timing facts', () => {
    const view = sessionStatusView(session(), [
      run({ runId: 'old', state: 'FAILED' }),
      run({ runId: 'new', state: 'SUCCEEDED' }),
    ], []);
    expect(view.label).toBe('就绪');
  });

  it('running still dominates warnings', () => {
    const view = sessionStatusView(session(), [
      run({ state: 'RUNNING', outcomeSeverity: 'WARNING' }),
    ], []);
    expect(view.label).toBe('执行中…');
  });

  it('attention dominates warnings', () => {
    const attention: AttentionLike[] = [{
      attentionId: 'a-1',
      sessionId: 'session-1',
    }];
    const view = sessionStatusView(session(), [run({ outcomeSeverity: 'WARNING' })], attention);
    expect(view.label).toBe('需要注意');
  });

  it('ignores warnings from runs of other sessions (selected-run separation)', () => {
    const view = sessionStatusView(session(), [
      run({ runId: 'other', sessionId: 'session-2', outcomeSeverity: 'WARNING' }),
    ], []);
    expect(view.label).toBe('就绪');
  });

  it('run state labels cover terminal states without inventing new ones', () => {
    expect(runStateLabel('FAILED')).toBe('已失败');
    // SUCCEEDED reads as Completed for users; the raw enum never leaks.
    expect(runStateLabel('SUCCEEDED')).toBe('已完成');
    // NEEDS_ATTENTION (Business WU-6) is terminal-with-attention and
    // must get a human label, not the raw snake_case enum.
    expect(runStateLabel('NEEDS_ATTENTION')).toBe('需要注意');
    expect(runStateTone('FAILED')).toBe('danger');
    expect(runStateTone('NEEDS_ATTENTION')).toBe('warning');
    expect(runStateTone('SUCCEEDED')).toBe('success');
  });
});
