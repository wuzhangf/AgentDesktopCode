// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { RoundBlock } from '../../src/renderer/app/conversation/RoundBlock';
import type { RoundBlockModel } from '../../src/renderer/app/activity/roundDisplayModel';
import type { RunActivity } from '../../src/renderer/app/activity/activityTypes';

const now = Date.parse('2026-09-19T00:01:00.000Z');

function activity(overrides: Partial<RunActivity> = {}): RunActivity {
  return {
    activityId: 'activity-1', runId: 'run-1', kind: 'COMMAND', status: 'SUCCEEDED',
    startedAt: '2026-09-19T00:00:00.000Z', durationMillis: 500,
    ...overrides
  };
}

function block(overrides: Partial<RoundBlockModel> = {}): RoundBlockModel {
  return {
    key: 'run-1:round-1', runId: 'run-1', roundId: 'round-1',
    ordinal: 1, displayNumber: 1, live: false, closed: false,
    status: 'SUCCEEDED',
    thinking: {
      modelActivity: null, reasoning: null,
      anchorStartMs: null, anchorApproximate: false, elapsedMs: null
    },
    promptText: 'done.', promptInterrupted: false, promptTruncated: false, promptStats: null,
    finalizeActivities: [],
    activities: [activity()],
    startedAtMs: Date.parse('2026-09-19T00:00:00.000Z'),
    finishedAtMs: Date.parse('2026-09-19T00:00:02.000Z'), elapsedMs: 2000,
    hasStaleRunning: false, interrupted: false, truncated: false, position: 0,
    ...overrides
  };
}

function headButton(): HTMLElement {
  return screen.getByRole('button', { name: /第 1 轮交互/ });
}

describe('RoundBlock', () => {
  afterEach(() => cleanup());

  it('remembers collapse state by (runId, roundId) across a remount (§8)', () => {
    // Collapse memory deliberately survives unmount; each test owns its identity.
    const remembered = block({ key: 'run-1:round-memory', roundId: 'round-memory' });
    const first = render(<RoundBlock block={remembered} live={false} runTerminal nowMs={now} />);
    expect(headButton().getAttribute('aria-expanded')).toBe('true');

    fireEvent.click(headButton());
    expect(headButton().getAttribute('aria-expanded')).toBe('false');
    first.unmount();

    // Live→history handover remounts every block under a new parent; the
    // user's collapse choice must survive even though this fresh block
    // would otherwise default to open.
    render(<RoundBlock block={remembered} live={false} runTerminal nowMs={now} />);
    expect(headButton().getAttribute('aria-expanded')).toBe('false');
  });

  it('does not leak collapse state across different round keys', () => {
    const isolated = block({ key: 'run-1:round-isolated', roundId: 'round-isolated' });
    const first = render(<RoundBlock block={isolated} live={false} runTerminal nowMs={now} />);
    fireEvent.click(headButton());
    first.unmount();

    render(<RoundBlock block={block({ key: 'run-1:round-9', roundId: 'round-9' })} live={false} runTerminal nowMs={now} />);
    expect(screen.getByRole('button', { name: /第 1 轮交互/ }).getAttribute('aria-expanded')).toBe('true');
  });

  it('keeps stale-RUNNING thinking collapsed once the block is closed', () => {
    // The last round's MODEL terminal can be missing from the live fold
    // while the run already went terminal (§3.4 stale RUNNING): the
    // thinking details must fold instead of pinning the reasoning text
    // open like answer prose.
    const stale = block({
      activities: [],
      closed: true,
      thinking: {
        modelActivity: activity({ kind: 'MODEL', status: 'RUNNING', activityId: 'model-1' }),
        reasoning: { text: 'Now I have enough data to compile the final report.', complete: true, truncated: false, interrupted: false },
        anchorStartMs: null, anchorApproximate: false, elapsedMs: 42_000
      }
    });
    const { container } = render(<RoundBlock block={stale} live={false} runTerminal nowMs={now} />);
    const details = container.querySelector('details.round-thinking');
    expect(details).not.toBeNull();
    expect(details?.hasAttribute('open')).toBe(false);
    expect(details?.textContent).toContain('思考 42s');
  });

  it('folds reasoning inside the round block when collapsed', () => {
    const closed = block({
      key: 'run-1:round-closed',
      roundId: 'round-closed',
      closed: true,
      thinking: {
        modelActivity: null,
        reasoning: { text: 'I grouped the reads by package.', complete: true, truncated: false, interrupted: false },
        anchorStartMs: null, anchorApproximate: false, elapsedMs: 4_000
      }
    });
    const { container } = render(<RoundBlock block={closed} live={false} runTerminal nowMs={now} />);
    expect(headButton().getAttribute('aria-expanded')).toBe('false');
    // Collapsed: no thinking row leaks outside the folded body.
    expect(container.querySelector('.round-thinking')).toBeNull();
    // The head still carries the thinking duration.
    expect(headButton().textContent).toContain('思考 4s');

    fireEvent.click(headButton());
    const thinking = container.querySelector('details.round-thinking');
    expect(thinking).not.toBeNull();
    expect(thinking?.closest('.round-body')).not.toBeNull();
    expect(thinking?.textContent).toContain('思考 4s');
    expect(thinking?.textContent).toContain('I grouped the reads by package.');
  });

  it('keeps standalone thinking for answer-level rounds', () => {
    const answerOnly = block({
      key: 'run-1:round-answer',
      roundId: 'round-answer',
      activities: [],
      closed: true,
      thinking: {
        modelActivity: null,
        reasoning: { text: 'Drafting the final answer.', complete: true, truncated: false, interrupted: false },
        anchorStartMs: null, anchorApproximate: false, elapsedMs: 3_000
      }
    });
    const { container } = render(<RoundBlock block={answerOnly} live={false} runTerminal nowMs={now} />);
    const thinking = container.querySelector('details.round-thinking.is-standalone');
    expect(thinking).not.toBeNull();
    expect(thinking?.textContent).toContain('思考 3s');
  });

  it('keeps live thinking expanded while the round is open', () => {
    const live = block({
      activities: [],
      live: true,
      closed: false,
      thinking: {
        modelActivity: activity({ kind: 'MODEL', status: 'RUNNING', activityId: 'model-1' }),
        reasoning: { text: 'thinking out loud', complete: null, truncated: false, interrupted: false },
        anchorStartMs: null, anchorApproximate: false, elapsedMs: 2_000
      }
    });
    const { container } = render(<RoundBlock block={live} live runTerminal={false} nowMs={now} />);
    expect(container.querySelector('details.round-thinking')?.hasAttribute('open')).toBe(true);
  });
});

describe('RoundBlock quiet-close folding', () => {
  afterEach(() => cleanup());

  it('auto-collapses a quiet round when the next round starts', () => {
    const live = block({ key: 'run-1:round-quiet', roundId: 'round-quiet', live: true, closed: false });
    const { rerender } = render(<RoundBlock block={live} live runTerminal={false} nowMs={now} />);
    expect(headButton().getAttribute('aria-expanded')).toBe('true');

    rerender(<RoundBlock
      block={block({ key: 'run-1:round-quiet', roundId: 'round-quiet', live: false, closed: true })}
      live={false} runTerminal={false} nowMs={now} />);
    expect(headButton().getAttribute('aria-expanded')).toBe('false');
  });

  it('folds a round closed with a stale RUNNING member — stale residue is a head badge, not a pin', () => {
    const staleMember = activity({ status: 'RUNNING' });
    const { rerender } = render(<RoundBlock
      block={block({ key: 'run-1:round-stale', roundId: 'round-stale', live: true, closed: false, activities: [staleMember] })}
      live runTerminal={false} nowMs={now} />);
    expect(headButton().getAttribute('aria-expanded')).toBe('true');

    rerender(<RoundBlock
      block={block({
        key: 'run-1:round-stale', roundId: 'round-stale', live: false, closed: true,
        activities: [staleMember], hasStaleRunning: true, status: 'INCOMPLETE'
      })}
      live={false} runTerminal={false} nowMs={now} />);
    expect(headButton().getAttribute('aria-expanded')).toBe('false');
    expect(headButton().textContent).toContain('结束状态未同步');
  });

  it('folds a round whose close-edge attention later resolves', () => {
    const waiting = activity({ status: 'WAITING_APPROVAL' });
    const { rerender } = render(<RoundBlock
      block={block({ key: 'run-1:round-wait', roundId: 'round-wait', live: true, closed: false, activities: [waiting] })}
      live runTerminal={false} nowMs={now} />);
    expect(headButton().getAttribute('aria-expanded')).toBe('true');

    rerender(<RoundBlock
      block={block({ key: 'run-1:round-wait', roundId: 'round-wait', live: false, closed: true, activities: [waiting] })}
      live={false} runTerminal={false} nowMs={now} />);
    expect(headButton().getAttribute('aria-expanded')).toBe('true');

    rerender(<RoundBlock
      block={block({
        key: 'run-1:round-wait', roundId: 'round-wait', live: false, closed: true,
        activities: [activity({ status: 'SUCCEEDED' })]
      })}
      live={false} runTerminal={false} nowMs={now} />);
    expect(headButton().getAttribute('aria-expanded')).toBe('false');
  });

  it('keeps a failed round open once closed (pin-worthy)', () => {
    const { rerender } = render(<RoundBlock
      block={block({ key: 'run-1:round-fail', roundId: 'round-fail', live: true, closed: false, activities: [activity({ status: 'RUNNING' })] })}
      live runTerminal={false} nowMs={now} />);
    rerender(<RoundBlock
      block={block({
        key: 'run-1:round-fail', roundId: 'round-fail', live: false, closed: true,
        status: 'FAILED', activities: [activity({ status: 'FAILED' })]
      })}
      live={false} runTerminal={false} nowMs={now} />);
    expect(headButton().getAttribute('aria-expanded')).toBe('true');
  });

  it('never folds a round the user expanded (pinned by interaction and memory)', () => {
    const closed = block({ key: 'run-1:round-pin', roundId: 'round-pin', live: false, closed: true });
    const { rerender, unmount } = render(<RoundBlock block={closed} live={false} runTerminal nowMs={now} />);
    expect(headButton().getAttribute('aria-expanded')).toBe('false');

    fireEvent.click(headButton());
    expect(headButton().getAttribute('aria-expanded')).toBe('true');
    rerender(<RoundBlock block={closed} live={false} runTerminal nowMs={now} />);
    expect(headButton().getAttribute('aria-expanded')).toBe('true');

    // Remount: the remembered expand survives the quiet-close check.
    unmount();
    render(<RoundBlock block={closed} live={false} runTerminal nowMs={now} />);
    expect(headButton().getAttribute('aria-expanded')).toBe('true');
  });

  it('waits out an active text selection, then folds once it clears', () => {
    const { rerender } = render(<RoundBlock
      block={block({ key: 'run-1:round-sel', roundId: 'round-sel', live: true, closed: false })}
      live runTerminal={false} nowMs={now} />);
    expect(headButton().getAttribute('aria-expanded')).toBe('true');

    const selection = window.getSelection();
    const anchor = document.createElement('div');
    anchor.textContent = 'user selected this earlier';
    document.body.appendChild(anchor);
    const range = document.createRange();
    range.selectNodeContents(anchor);
    selection?.removeAllRanges();
    selection?.addRange(range);

    rerender(<RoundBlock
      block={block({ key: 'run-1:round-sel', roundId: 'round-sel', live: false, closed: true })}
      live={false} runTerminal={false} nowMs={now} />);
    // A live selection at the close edge holds the block open — folding now
    // would yank the text mid-selection.
    expect(headButton().getAttribute('aria-expanded')).toBe('true');

    // Cleared → the quiet closed block folds (jsdom does not dispatch
    // selectionchange itself; emit what Chromium would).
    selection?.removeAllRanges();
    act(() => { document.dispatchEvent(new Event('selectionchange')); });
    expect(headButton().getAttribute('aria-expanded')).toBe('false');
    anchor.remove();
  });
});
