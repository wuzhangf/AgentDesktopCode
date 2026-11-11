// @vitest-environment jsdom
/**
 * EW7 acceptance (desktop projection): Task Center workspace panel shows a
 * live project-relative file projection while a Run is active, keeps
 * kind/owner/baseline/handoff state available as secondary metadata,
 * provisioning goes through the service, handoff conflicts and reclaim blocks
 * fail closed, and 501 stays explicit.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Workbench } from '../../src/renderer/app/App';

const runs = [
  { runId: 'run-1', taskId: 'task-1', state: 'COMPLETED', stateVersion: 9, sessionId: 'session-aaa', workspaceAlias: 'sample' }
];

let workspaceItems: Array<Record<string, unknown>> = [];
let activitySnapshot: Record<string, unknown> = {};
let listError: { error: string; code: string } | null = null;
let handoffError: Error | null = null;
let reclaimError: Error | null = null;
const createCalls: Array<Record<string, unknown>> = [];
const handoffCalls: Array<{ id: string; expectedStateVersion?: number }> = [];
const reclaimCalls: Array<{ id: string; expectedStateVersion?: number }> = [];

function resetFixtures(): void {
  runs[0]!.state = 'COMPLETED';
  workspaceItems = [
    {
      workspaceExecutionId: 'we-aaa', projectId: 'sample', kind: 'WORKTREE',
      baselineRevision: 'abc1234', workspaceRef: 'business/worktree-we-aaa@abc1234',
      ownerType: 'RUN', ownerId: 'run-1', state: 'IN_USE', dirtySummary: '',
      stateVersion: 2, leaseExpired: false
    },
    {
      workspaceExecutionId: 'we-bbb', projectId: 'sample', kind: 'CHECKOUT',
      baselineRevision: 'abc1234', workspaceRef: 'sample@checkout',
      ownerType: 'RUN', ownerId: 'run-other', state: 'NEEDS_ATTENTION',
      dirtySummary: 'lease expired; writer may have crashed', stateVersion: 5, leaseExpired: true
    }
  ];
  activitySnapshot = {
    runId: 'run-1',
    runStateVersion: 4,
    snapshotCursor: 3,
    complete: false,
    items: [],
    summary: { completeness: 'LIVE_LOWER_BOUND', activityCount: 0 }
  };
  listError = null;
  handoffError = null;
  reclaimError = null;
  createCalls.length = 0;
  handoffCalls.length = 0;
  reclaimCalls.length = 0;
}

function installFakeApi(): void {
  Object.defineProperty(window, 'codeAgentDesktop', {
    configurable: true,
    value: {
      bootstrap: vi.fn(async () => ({ status: 'OWNED_READY' })),
      openExternalHttps: vi.fn(),
      restartService: vi.fn(),
      serviceStatus: vi.fn(),
      chooseAndRegisterProject: vi.fn(),
      diagnostics: vi.fn(async () => ({ serviceState: 'OWNED_READY', ownedProcess: null, logLocation: '', encryptionAvailable: true })),
      listProjects: vi.fn(async () => [
        { projectId: 'sample', workspaceAlias: 'sample', authorityStatus: 'AVAILABLE', runningCount: 0, attentionCount: 0 }
      ]),
      listSessions: vi.fn(async () => [
        { sessionId: 'session-aaa', sessionVersion: 1, title: 'Session A', workspaceAlias: 'sample', status: 'ACTIVE', messages: [] }
      ]),
      getSession: vi.fn(async (sessionId: string) => ({
        sessionId, sessionVersion: 1, title: 'Session A', workspaceAlias: 'sample', status: 'ACTIVE', messages: []
      })),
      createSession: vi.fn(),
      patchSession: vi.fn(),
      sendSessionMessage: vi.fn(),
      forkSession: vi.fn(),
      archiveSession: vi.fn(),
      listRuns: vi.fn(async () => ({ items: runs.map((r) => ({ ...r })) })),
      listAttention: vi.fn(async () => ({ items: [] })),
      createSpec: vi.fn(),
      getSpec: vi.fn(),
      reviseSpec: vi.fn(),
      decideSpecApproval: vi.fn(),
      convertSpecToAct: vi.fn(),
      decideCommandApproval: vi.fn(),
      decideBudgetApproval: vi.fn(),
      cancelRun: vi.fn(),
      interruptRun: vi.fn(),
      getRunDiff: vi.fn(async () => ({ runId: 'run-1', stateVersion: 9, page: 0, pageSize: 20, hasMore: false, files: [] })),
      getRunActivities: vi.fn(async () => ({ ...activitySnapshot })),
      getRunReview: vi.fn(async () => ({ reviewId: 'rev-1', runId: 'run-1', findings: [] })),
      getRunEvidence: vi.fn(async () => ({ runId: 'run-1', items: [] })),
      createFixTask: vi.fn(),
      revealProjectFile: vi.fn(),
      listWorkspaceExecutions: vi.fn(async () => {
        if (listError) return listError;
        return { projectId: 'sample', items: workspaceItems.map((i) => ({ ...i })) };
      }),
      createWorkspaceExecution: vi.fn(async (body: Record<string, unknown>) => {
        createCalls.push(body);
        return { workspaceExecutionId: 'we-new', state: 'IN_USE', stateVersion: 1 };
      }),
      handoffWorkspaceExecution: vi.fn(async (id: string, expectedStateVersion?: number) => {
        handoffCalls.push({ id, expectedStateVersion });
        if (handoffError) throw handoffError;
        return { workspaceExecutionId: id, state: 'READY_FOR_HANDOFF' };
      }),
      reclaimWorkspaceExecution: vi.fn(async (id: string, expectedStateVersion?: number) => {
        reclaimCalls.push({ id, expectedStateVersion });
        if (reclaimError) throw reclaimError;
        return { workspaceExecutionId: id, state: 'RECLAIMED' };
      }),
      getDesktopPreferences: vi.fn(async () => ({
        schemaVersion: 'desktop-preferences/1',
        revision: 1,
        notificationsEnabled: true,
        language: 'SYSTEM',
        theme: 'DARK',
        density: 'STANDARD',
        uiScalePercent: 100,
        codeFontSizePx: 13,
        reduceMotion: 'SYSTEM',
        sendShortcut: 'ENTER',
        restoreLastSurface: false
      })),
      updateDesktopPreferences: vi.fn(async (body: Record<string, unknown>) => ({
        schemaVersion: 'desktop-preferences/1',
        revision: 2,
        notificationsEnabled: true,
        language: 'SYSTEM',
        theme: 'DARK',
        density: 'STANDARD',
        uiScalePercent: 100,
        codeFontSizePx: 13,
        reduceMotion: 'SYSTEM',
        sendShortcut: 'ENTER',
        restoreLastSurface: false,
        ...body
      })),
      getModelCatalog: vi.fn(async () => ({ items: [] })),
      revealDiagnosticsFolder: vi.fn(async () => ({ revealed: true })),
      copyDiagnostics: vi.fn(async () => ({ copied: true, bytes: 64 })),
      getAboutInfo: vi.fn(async () => ({ desktopVersion: '0.0.1', electronVersion: '44.0.0', chromeVersion: '130', nodeVersion: '24' })),
      onDurableEvents: vi.fn(() => () => undefined),
      onEventStatus: vi.fn(() => () => undefined)
    }
  });
}

function renderWorkbench(): void {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } }
  });
  render(
    <QueryClientProvider client={queryClient}>
      <Workbench />
    </QueryClientProvider>
  );
}

async function selectRun(): Promise<void> {
  await screen.findByRole('button', { name: /run-1/ });
  fireEvent.click(screen.getByText(/活动/));
  screen.getByRole('button', { name: /run-1/ }).click();
  await screen.findByTestId('git-overview-panel');
  // Worktree executions live behind the large Git page's Worktree tab.
  fireEvent.click(screen.getByRole('button', { name: '查看变更' }));
  await screen.findByTestId('git-surface');
  fireEvent.click(screen.getByRole('tab', { name: 'Worktree' }));
  await screen.findByTestId('workspace-panel');
  await screen.findAllByTestId('workspace-item');
}

beforeEach(() => {
  resetFixtures();
  installFakeApi();
});

afterEach(() => {
  cleanup();
});

describe('workspace executions panel (EW7)', () => {
  it('keeps lifecycle metadata available below the file projection', async () => {
    renderWorkbench();
    await selectRun();
    const panel = screen.getByTestId('workspace-panel');
    expect(panel.textContent).toContain('WORKTREE');
    expect(panel.textContent).toContain('CHECKOUT');
    expect(panel.textContent).toContain('business/worktree-we-aaa');
    expect(panel.textContent).toContain('基于 abc1234');
    // NEEDS_ATTENTION is surfaced, never hidden or prettified away
    expect(panel.textContent).toContain('⚠ 需要处理');
    expect(panel.textContent).toContain('租约已过期');
  });

  it('provisions worktrees through the service with run ownership', async () => {
    renderWorkbench();
    await selectRun();
    screen.getByTestId('create-worktree').click();
    await waitFor(() => expect(createCalls.length).toBe(1));
    expect(createCalls[0]?.workspaceAlias).toBe('sample');
    expect(createCalls[0]?.kind).toBe('WORKTREE');
    expect(createCalls[0]?.ownerType).toBe('RUN');
    expect(createCalls[0]?.ownerId).toBe('run-1');
  });

  it('hands off with the optimistic stateVersion and fails closed on conflict', async () => {
    renderWorkbench();
    await selectRun();
    screen.getAllByTestId('workspace-handoff')[0]?.click();
    await waitFor(() => expect(handoffCalls.length).toBe(1));
    expect(handoffCalls[0]?.id).toBe('we-aaa');
    expect(handoffCalls[0]?.expectedStateVersion).toBe(2);

    handoffError = new Error('HANDOFF_CONFLICT');
    screen.getAllByTestId('workspace-handoff')[0]?.click();
    await screen.findByText(/状态已变化/);
  });

  it('surfaces reclaim blocks instead of deleting user WIP silently', async () => {
    renderWorkbench();
    await selectRun();
    // no reclaim button in IN_USE state
    expect(screen.queryByTestId('workspace-reclaim')).toBeNull();

    // make the first item handoff-ready, then block the reclaim
    workspaceItems[0] = { ...workspaceItems[0], state: 'READY_FOR_HANDOFF' };
    reclaimError = new Error('WORKSPACE_WIP_PRESENT');
    screen.getByTestId('create-worktree').click(); // any action re-renders via mutation? no — trigger refetch below
    await waitFor(() => expect(createCalls.length).toBe(1));

    // after refetch the reclaim button appears for READY_FOR_HANDOFF
    const reclaim = await screen.findByTestId('workspace-reclaim');
    reclaim.click();
    await screen.findByText(/操作失败：WORKSPACE_WIP_PRESENT/);
    expect(reclaimCalls[0]?.id).toBe('we-aaa');
  });

  it('fails closed on 501 instead of pretending workspaces exist', async () => {
    listError = { error: 'not implemented', code: 'NOT_IMPLEMENTED' };
    renderWorkbench();
    await screen.findByRole('button', { name: /run-1/ });
    fireEvent.click(screen.getByText(/活动/));
    screen.getByRole('button', { name: /run-1/ }).click();
    await screen.findByTestId('git-overview-panel');
    fireEvent.click(screen.getByRole('button', { name: '查看变更' }));
    await screen.findByTestId('git-surface');
    fireEvent.click(screen.getByRole('tab', { name: 'Worktree' }));
    const note = await screen.findByTestId('workspace-not-implemented');
    expect(note.textContent).toContain('无法管理副本');
    expect(screen.queryByTestId('create-worktree')).toBeNull();
  });

  it('shows the live project-relative file tree while the run is active', async () => {
    runs[0]!.state = 'RUNNING';
    activitySnapshot = {
      ...activitySnapshot,
      items: [
        {
          activityId: 'activity-read', runId: 'run-1', kind: 'FILE_READ', status: 'SUCCEEDED',
          fileRef: 'src/main/App.tsx', relativeDirectory: 'src/main', fileName: 'App.tsx'
        },
        {
          activityId: 'activity-edit', runId: 'run-1', kind: 'FILE_EDIT', status: 'RUNNING',
          fileRef: 'src/main/App.tsx'
        },
        {
          activityId: 'activity-test', runId: 'run-1', kind: 'FILE_READ', status: 'SUCCEEDED',
          targets: [{ ref: 'src/test/App.test.tsx', status: 'SUCCEEDED' }]
        },
        {
          activityId: 'activity-secret', runId: 'run-1', kind: 'FILE_READ', status: 'SUCCEEDED',
          fileRef: 'C:/outside-secret.txt'
        }
      ],
      summary: { completeness: 'LIVE_LOWER_BOUND', activityCount: 4, uniqueReadFileCount: 2, uniqueWrittenFileCount: 1 }
    };
    renderWorkbench();
    await selectRun();
    const tree = await screen.findByTestId('workspace-tree');
    expect(tree.textContent).toContain('实时工作现场');
    expect(tree.textContent).toContain('实时同步');
    expect(tree.textContent).toContain('App.tsx');
    expect(tree.textContent).toContain('App.test.tsx');
    expect(tree.textContent).not.toContain('outside-secret.txt');
    await waitFor(() => expect(window.codeAgentDesktop.getRunActivities).toHaveBeenCalled());
  });
});
