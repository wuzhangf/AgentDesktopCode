// @vitest-environment jsdom
/**
 * WU-05 (design §6.5): the "继续任务" entry appears only once workspace
 * attention is cleared (clearedAt != null), keeps prior runs clickable via
 * continuedBy linkage, and surfaces a server refusal honestly.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RunContinueEntry } from '../../src/renderer/app/conversation/RunContinueEntry';
import type { RunLike } from '../../src/renderer/app/queries';

let continueCalls: Array<{ runId: string; expectedStateVersion?: number; message?: string }> = [];
let continueError: string | null = null;

function run(overrides: Partial<RunLike> = {}): RunLike {
  return {
    runId: 'run-prior-1',
    taskId: 'task-1',
    state: 'NEEDS_ATTENTION',
    sourceStatus: 'NEEDS_ATTENTION',
    stateVersion: 7,
    ...overrides
  };
}

function installApi(): void {
  continueCalls = [];
  continueError = null;
  Object.defineProperty(window, 'codeAgentDesktop', {
    configurable: true,
    value: {
      continueRun: vi.fn(async (runId: string, options: { expectedStateVersion?: number; message?: string }) => {
        if (continueError) throw Object.assign(new Error(continueError), { code: continueError });
        continueCalls.push({ runId, ...options });
        return { runId: 'run-next-999', stateVersion: 1 };
      })
    }
  });
}

function renderEntry(item: RunLike | null | undefined): HTMLElement {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } }
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <RunContinueEntry run={item} />
    </QueryClientProvider>
  );
  return view.container;
}

describe('RunContinueEntry (WU-05)', () => {
  beforeEach(() => installApi());
  afterEach(() => cleanup());

  it('stays hidden while attention is still open', () => {
    const container = renderEntry(run({ attention: { clearedAt: null, openCount: 1 } }));
    expect(container.querySelector('[data-testid="conversation-continue-entry"]')).toBeNull();
  });

  it('stays hidden for non-attention runs', () => {
    const container = renderEntry(run({ sourceStatus: 'SUCCEEDED', attention: { clearedAt: 't' } }));
    expect(container.querySelector('[data-testid="conversation-continue-entry"]')).toBeNull();
  });

  it('stays hidden once a continuation already exists', () => {
    const container = renderEntry(run({
      attention: { clearedAt: 't' },
      continuedBy: 'run-next-1'
    }));
    expect(container.querySelector('[data-testid="conversation-continue-entry"]')).toBeNull();
  });

  it('posts the continue command with optimistic concurrency', async () => {
    const container = renderEntry(run({ attention: { clearedAt: '2026-09-25T10:00:00Z' } }));
    const button = container.querySelector('[data-testid="conversation-continue-entry"] button')!;
    fireEvent.click(button);
    await waitFor(() => expect(continueCalls).toHaveLength(1));
    expect(continueCalls[0]?.runId).toBe('run-prior-1');
    expect(continueCalls[0]?.expectedStateVersion).toBe(7);
    await waitFor(() => expect(
      container.querySelector('[data-testid="conversation-continue-done"]')
    ).not.toBeNull());
    expect(screen.getByText(/已创建续跑/)).toBeTruthy();
  });

  it('shows the server refusal when attention was not actually cleared', async () => {
    continueError = 'RUN_ATTENTION_NOT_CLEARED';
    const container = renderEntry(run({ attention: { clearedAt: 't' } }));
    const button = container.querySelector('[data-testid="conversation-continue-entry"] button')!;
    fireEvent.click(button);
    await waitFor(() => expect(screen.getByText('RUN_ATTENTION_NOT_CLEARED')).toBeTruthy());
    // The button stays for retry after the operator resolves the stragglers.
    expect(container.querySelector('[data-testid="conversation-continue-entry"]')).not.toBeNull();
  });
});
