// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ActivitySummaryPanel } from '../../src/renderer/app/ActivitySummaryPanel';
import type { RunLike } from '../../src/renderer/app/queries';

function installApi(overrides: Record<string, unknown> = {}) {
  Object.assign(window, {
    codeAgentDesktop: {
      getRunActivities: vi.fn(async () => ({
        runId: 'run-1', runStateVersion: 1, snapshotCursor: 1, complete: true,
        items: [],
        summary: { completeness: 'COMPLETE', activityCount: 105 }
      })),
      getRunDiff: vi.fn(async () => ({ files: [], hasMore: false, complete: true })),
      getSessionSummary: vi.fn(async () => ({ environment: null })),
      ...overrides
    }
  });
}

function renderPanel(props: Partial<React.ComponentProps<typeof ActivitySummaryPanel>> = {}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  const run: RunLike = props.run ?? ({
    runId: 'run-7f818030', taskId: 'task-1', state: 'RUNNING', stateVersion: 2,
    sessionId: 'session-1', workspaceAlias: 'kosmos-509dbc83',
    startedAt: new Date(Date.now() - 192_000).toISOString()
  } as RunLike);
  render(
    <QueryClientProvider client={queryClient}>
      <ActivitySummaryPanel
        run={run}
        sessionId="session-1"
        onClose={vi.fn()}
        onOpenGit={vi.fn()}
        {...props}
      />
    </QueryClientProvider>
  );
}

beforeEach(() => installApi());
afterEach(() => cleanup());

describe('activity summary panel (U3)', () => {
  it('does not render diff numbers while the run is still working', async () => {
    renderPanel();
    const changes = await screen.findByTestId('activity-summary-metrics');
    expect(changes.textContent).toContain('变更会在 Run 结束后统计');
    expect(changes.textContent).not.toMatch(/\+\d+/);
    expect(screen.queryByRole('button', { name: /查看变更/ })).toBeNull();
  });

  it('shows the diff summary with a 查看变更 link after the run is terminal', async () => {
    installApi({
      getRunDiff: vi.fn(async () => ({
        files: [
          { path: 'a.ts', patch: '+one\n+two\n-three' },
          { path: 'b.ts', patch: '+x' }
        ],
        hasMore: false, complete: true
      }))
    });
    renderPanel({
      run: {
        runId: 'run-7f818030', taskId: 'task-1', state: 'COMPLETED', stateVersion: 3,
        sessionId: 'session-1', workspaceAlias: 'kosmos-509dbc83',
        startedAt: '2026-10-01T10:00:00Z', finishedAt: '2026-10-01T10:03:12Z'
      } as RunLike
    });
    const changes = await screen.findByTestId('activity-summary-metrics');
    await within(changes).findByText(/2 个文件/);
    expect(changes.textContent).toContain('+3');
    expect(changes.textContent).toContain('−1');
    expect(within(changes).getByRole('button', { name: /查看变更/ })).toBeDefined();
  });

  it('sorts build targets with issues first and labels issues in Chinese', async () => {
    installApi({
      getSessionSummary: vi.fn(async () => ({
        environment: {
          targets: [
            { targetId: 't-ok', tool: 'PYTHON', dir: 'packages/shared' },
            { targetId: 't-bad', tool: 'PNPM', dir: 'apps/web', issue: 'TOOLCHAIN_NOT_FOUND' }
          ],
          toolchain: [
            { runner: 'python', executable: 'python', available: true },
            { runner: 'pnpm', executable: 'pnpm.cmd', available: null }
          ],
          verification: null
        }
      }))
    });
    renderPanel();
    const env = await screen.findByTestId('status-environment');
    const rows = await within(env).findAllByText(/apps\/web|packages\/shared/);
    expect(rows[0]?.textContent).toBe('apps/web');
    const issueRow = within(env).getByText('apps/web').closest('.env-target-row');
    expect(issueRow?.textContent).toContain('未找到工具链');
    // unknown availability → "?" chip, never a guess
    expect(within(env).getByText(/\? pnpm\.cmd/)).toBeDefined();
    expect(env.textContent).toContain('无记录');
  });

  it('falls back to the raw activity detail for unknown actions and skips a missing branch', async () => {
    installApi({
      getRunActivities: vi.fn(async () => ({
        runId: 'run-1', runStateVersion: 1, snapshotCursor: 1, complete: true,
        items: [{ kind: 'TOOL', status: 'RUNNING', detail: 'TOTALLY_NEW_ACTION_XYZ' }],
        summary: { completeness: 'COMPLETE', activityCount: 1 }
      }))
    });
    renderPanel();
    await screen.findByText('TOTALLY_NEW_ACTION_XYZ');
    expect(screen.queryByText('分支')).toBeNull();
    expect(screen.queryByText('工作区')).toBeNull();
  });
});
