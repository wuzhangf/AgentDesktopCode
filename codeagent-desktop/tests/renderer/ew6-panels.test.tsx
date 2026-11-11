// @vitest-environment jsdom
/**
 * EW6 acceptance (design §10): Git panel diff edge cases (binary, truncated,
 * stale, pagination, 501 fail-closed), independent evidence panel with
 * NOT_RUN never hidden, deferred review surface, and file reveal.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Workbench } from '../../src/renderer/app/App';
import { FileReferenceDialog } from '../../src/renderer/app/panes/FileReferenceDialog';
import { DesktopProxyError } from '../../src/renderer/app/queries';

const runs = [
  { runId: 'run-1', taskId: 'task-1', state: 'COMPLETED', stateVersion: 9, sessionId: 'session-aaa', workspaceAlias: 'sample' }
];
let runState = 'COMPLETED';
let projectList: Array<Record<string, unknown>> = [];

let diffPages: Record<number, unknown> = {};
let diffError: Error | null = null;
const diffCalls: Array<{ runId: string; page: number; pageSize: number }> = [];
let reviewBody: unknown;
const fixTaskCalls: Array<{ findingId: string; body: Record<string, unknown> }> = [];
const revealCalls: Array<{ projectId: string; fileRef: string }> = [];
let revealError: Error | null = null;

function resetFixtures(): void {
  runState = 'COMPLETED';
  runs[0]!.workspaceAlias = 'sample';
  projectList = [
    {
      projectId: 'sample', workspaceAlias: 'sample', authorityStatus: 'AVAILABLE',
      runningCount: 0, attentionCount: 0, vcsKind: 'GIT', branchDisplay: 'main',
      headShortRevision: 'abc1234', dirtySummary: 'MODIFIED'
    }
  ];
  diffPages = {
    0: {
      runId: 'run-1', stateVersion: 9, baseRevision: 'abc123', stale: false, truncated: false,
      page: 0, pageSize: 20, hasMore: true,
      files: [
        { path: 'src/app/main.ts', changeType: 'MODIFIED', binary: false, patch: '@@ -1 +1 @@\n-old\n+new', truncated: false },
        { path: 'assets/logo.png', changeType: 'ADDED', binary: true, patch: null, truncated: false },
        { path: 'src/generated/huge.ts', changeType: 'MODIFIED', binary: false, patch: '@@ -1 +1 @@', truncated: true }
      ]
    },
    1: {
      runId: 'run-1', stateVersion: 9, baseRevision: 'abc123', stale: false, truncated: false,
      page: 1, pageSize: 20, hasMore: false,
      files: [{ path: 'docs/readme.md', changeType: 'DELETED', binary: false, patch: null, truncated: false }]
    }
  };
  diffError = null;
  diffCalls.length = 0;
  reviewBody = {
    reviewId: 'rev-1', runId: 'run-1', stateVersion: 9, status: 'DONE', complete: true,
    findings: [
      { findingId: 'f-1', severity: 'HIGH', file: 'src/app/main.ts', line: 42, message: 'possible NPE', fixTaskId: null },
      { findingId: 'f-2', severity: 'LOW', file: null, line: null, message: 'style nit', fixTaskId: 'task-fix-9' }
    ]
  };
  fixTaskCalls.length = 0;
  revealCalls.length = 0;
  revealError = null;
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
      listProjects: vi.fn(async () => projectList),
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
      listRuns: vi.fn(async () => ({ items: runs.map((r) => ({ ...r, state: runState })) })),
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
      getRunDiff: vi.fn(async (runId: string, query: { page?: number; pageSize?: number }) => {
        const page = query.page ?? 0;
        diffCalls.push({ runId, page, pageSize: query.pageSize ?? 20 });
        if (diffError) throw diffError;
        return diffPages[page] ?? { runId, stateVersion: 9, page, pageSize: 20, hasMore: false, files: [] };
      }),
      getRunReview: vi.fn(async () => reviewBody),
      getRunEvidence: vi.fn(async () => ({
        runId: 'run-1',
        generatedAt: '2026-08-29T00:00:00Z',
        complete: false,
        stateVersion: 9,
        artifactsReady: true,
        deliveryStatus: 'AVAILABLE',
        changeArtifactRef: 'change-run-1',
        manifestRef: { manifestId: 'evidence-run-1-9', sha256: 'a'.repeat(64), stateVersion: 9 },
        outcomeSeverity: 'WARNING',
        verificationV2: {
          overall: 'WARNING',
          requiredLanesPassed: false,
          warnings: ['pre-existing failure'],
          lanes: [{ lane: 'DETERMINISTIC_TEST', disposition: 'PRE_EXISTING', passed: false, attributionKinds: 'PRE_EXISTING', attributionConfidence: 'HIGH' }]
        },
        items: [
          { evidenceId: 'e1', layer: 'SOURCE', status: 'PRESENT' },
          { evidenceId: 'e2', layer: 'DETERMINISTIC_TEST', status: 'NOT_RUN' },
          { evidenceId: 'e3', layer: 'RUNTIME', status: 'FAILED' },
          { evidenceId: 'e4', layer: 'SCENARIO_ORACLE', status: 'NOT_APPLICABLE' }
        ]
      })),
      createFixTask: vi.fn(async (findingId: string, body: Record<string, unknown>) => {
        fixTaskCalls.push({ findingId, body });
        return { taskId: 'task-new', findingId, taskFingerprint: 'fp' };
      }),
      revealProjectFile: vi.fn(async (projectId: string, fileRef: string) => {
        revealCalls.push({ projectId, fileRef });
        if (revealError) throw revealError;
        return { action: 'REVEAL_FILE', root: 'D:/ws/sample', fileRef };
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
}

async function openChangesPage(): Promise<void> {
  fireEvent.click(screen.getByRole('button', { name: '查看变更' }));
  await screen.findByTestId('git-surface');
}

async function openTab(name: '变更' | 'Worktree'): Promise<void> {
  // Design 2026-09-30 §6.1: the 变更 tab appends a cached file count
  // (`变更 (N)`), so locate by testid instead of the accessible name.
  const testId = `git-surface-tab-${name === '变更' ? 'diff' : 'workspace'}`;
  fireEvent.click(screen.getByTestId(testId));
  // the tab body swaps content; wait for the swap to settle
  await waitFor(() => {
    const selected = screen.getByRole('tab', { selected: true });
    expect(selected.textContent).toContain(name);
  });
}

async function openEvidencePane(): Promise<void> {
  fireEvent.keyDown(window, { key: 'e', ctrlKey: true, shiftKey: true });
  await screen.findByTestId('evidence-pane');
}

beforeEach(() => {
  resetFixtures();
  installFakeApi();
});

afterEach(() => {
  cleanup();
});

describe('diff inspector (EW6)', () => {
  it('does not request terminal projections while a run is still working', async () => {
    runState = 'RUNNING';
    renderWorkbench();
    await selectRun();

    // Git first opens the floating directory overview; the large Changes page
    // is explicit, while review is not mounted and evidence stays separate.
    await openChangesPage();
    await screen.findByTestId('diff-pending');
    expect(vi.mocked(window.codeAgentDesktop.getRunDiff)).not.toHaveBeenCalled();
    expect(vi.mocked(window.codeAgentDesktop.getRunReview)).not.toHaveBeenCalled();
    await openEvidencePane();
    await screen.findByTestId('evidence-pending');
    expect(vi.mocked(window.codeAgentDesktop.getRunEvidence)).not.toHaveBeenCalled();
  });

  it('renders patches and labels binary/truncated files instead of hiding them', async () => {
    renderWorkbench();
    await selectRun();
    await openChangesPage();
    // wait until page-0 diff data has actually rendered (the header splits
    // dir/basename visually, so query by its accessible name)
    const fileButton = await screen.findByRole('button', { name: /src\/app\/main\.ts/ });
    // text patch is expandable and shown
    fireEvent.click(fileButton);
    const body = await screen.findByTestId('diff-file-body');
    expect(body.textContent).toContain('+new');
    expect(screen.getByText('二进制')).toBeDefined();
    expect(screen.getByText('patch 截断')).toBeDefined();
  });

  it('pages through the diff with server pagination', async () => {
    renderWorkbench();
    await selectRun();
    await openChangesPage();
    await screen.findByRole('button', { name: /src\/app\/main\.ts/ });
    expect(diffCalls.at(-1)?.page).toBe(0);
    fireEvent.click(screen.getByRole('button', { name: '下一页' }));
    await screen.findByRole('button', { name: /docs\/readme\.md/ });
    expect(diffCalls.at(-1)?.page).toBe(1);
    // last page: next is disabled, going back works (page-0 served from cache)
    expect((screen.getByRole('button', { name: '下一页' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: '上一页' }));
    await screen.findByRole('button', { name: /src\/app\/main\.ts/ });
    expect(diffCalls.filter((c) => c.page === 0).length).toBeGreaterThan(0);
    expect(screen.getByTestId('git-page-indicator').textContent).toContain('第 1 页');
  });

  it('hides the pager and page stat when the diff fits on one page', async () => {
    diffPages = {
      0: {
        runId: 'run-1', stateVersion: 9, baseRevision: 'abc123', stale: false, truncated: false,
        page: 0, pageSize: 20, hasMore: false,
        files: [{ path: 'src/app/main.ts', changeType: 'MODIFIED', binary: false, patch: '@@ -1 +1 @@\n-old\n+new', truncated: false }]
      }
    };
    renderWorkbench();
    await selectRun();
    await openChangesPage();
    await screen.findByRole('button', { name: /src\/app\/main\.ts/ });
    expect(screen.queryByTestId('git-page-indicator')).toBeNull();
    expect(screen.queryByRole('button', { name: '下一页' })).toBeNull();
    expect(screen.queryByText(/第 \d+ 页/)).toBeNull();
  });

  it('renders the file name and directory as separate elements (U4 §8.2)', async () => {
    renderWorkbench();
    await selectRun();
    await openChangesPage();
    const fileButton = await screen.findByRole('button', { name: 'src/app/main.ts' });
    const name = fileButton.querySelector('.git-file-name');
    const dir = fileButton.querySelector('.git-file-dir');
    expect(name?.textContent).toBe('main.ts');
    expect(dir?.textContent).toBe('src/app');
    // per-row patch stats + sticky-header actions (§8.2/§8.3)
    expect(fileButton.textContent).toContain('+1');
    expect(fileButton.textContent).toContain('−1');
    expect(screen.getByRole('button', { name: '定位文件' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '复制路径' })).toBeTruthy();
  });

  it('shows the stale warning when the workspace moved under the diff', async () => {
    diffPages[0] = { ...(diffPages[0] as Record<string, unknown>), stale: true };
    renderWorkbench();
    await selectRun();
    await openChangesPage();
    await screen.findByTestId('diff-stale');
  });

  it('fails closed on 501 NOT_IMPLEMENTED without fabricating an empty diff', async () => {
    diffError = new Error('NOT_IMPLEMENTED');
    renderWorkbench();
    await selectRun();
    await openChangesPage();
    const note = await screen.findByTestId('diff-not-implemented');
    expect(note.textContent).toContain('fail-closed');
    expect(screen.queryByText('本页无变更文件。')).toBeNull();
  });
});

describe('review surface deferred', () => {
  it('does not show a review tab or request review from the Git panel', async () => {
    renderWorkbench();
    await selectRun();
    expect(screen.queryByRole('tab', { name: '评审' })).toBeNull();
    expect(vi.mocked(window.codeAgentDesktop.getRunReview)).not.toHaveBeenCalled();
  });
});

describe('layered evidence (EW6)', () => {
  it('renders every canonical layer and never hides NOT_RUN', async () => {
    renderWorkbench();
    await selectRun();
    await openEvidencePane();
    await screen.findByTestId('evidence-panel');
    expect(screen.queryByRole('tab', { name: '变更' })).toBeNull();
    // every canonical layer has a row
    for (const layer of ['SOURCE', 'DETERMINISTIC_TEST', 'PACKAGE', 'RUNTIME', 'LIVE_MODEL', 'TRACE', 'GUI', 'SCENARIO_ORACLE']) {
      expect(screen.getByTestId(`evidence-layer-${layer}`)).toBeDefined();
    }
    const testLayer = screen.getByTestId('evidence-layer-DETERMINISTIC_TEST');
    expect(testLayer.textContent).toContain('NOT_RUN');
    // layers absent from the bundle are surfaced as 无数据, not silently dropped
    expect(screen.getByTestId('evidence-layer-PACKAGE').textContent).toContain('无数据');
    expect(screen.getByText('不完整').textContent).toContain('不完整');
    for (const block of ['evidence-implementation', 'evidence-verification', 'evidence-attribution', 'evidence-delivery']) {
      expect(screen.getByTestId(block)).toBeDefined();
    }
    expect(screen.getByTestId('evidence-delivery-status').textContent).toBe('AVAILABLE');
    expect(screen.getByTestId('verification-summary').textContent).toContain('pre-existing failure');
    expect(screen.getByTestId('verification-lane').textContent).toContain('PRE_EXISTING');
  });
});

describe('Git panel tabs', () => {
  it('shows the Git context with only Changes and Worktree tabs', async () => {
    renderWorkbench();
    await selectRun();
    expect(screen.getByTestId('git-overview-panel').textContent).toContain('main');
    await openChangesPage();
    const context = await screen.findByTestId('run-context');
    expect(context.textContent).toContain('run run-1');
    expect(context.textContent).toContain('已完成');
    // Design 2026-09-30 §6.1: the workspace alias is the page title, the
    // run-context row only carries the status pill and short run id.
    expect(screen.getByTestId('git-surface').querySelector('h1')?.textContent).toContain('sample');
    // The large page is intentionally limited to Changes and Worktree;
    // review remains a deferred feature.
    await screen.findByRole('button', { name: /src\/app\/main\.ts/ });
    expect(screen.getByTestId('git-surface-tab-diff')).toBeDefined();
    expect(screen.getByTestId('git-surface-tab-workspace')).toBeDefined();
    expect(screen.queryByRole('tab', { name: '评审' })).toBeNull();
    // Switching back to Changes keeps the Git panel scoped to its two tabs.
    await openTab('变更');
    await screen.findByRole('button', { name: /src\/app\/main\.ts/ });
  });
});

describe('file reveal (EW6)', () => {
  it('reveals a diff file through a server-validated intent', async () => {
    renderWorkbench();
    await selectRun();
    await openChangesPage();
    fireEvent.click(await screen.findByRole('button', { name: /src\/app\/main\.ts/ }));
    await screen.findByTestId('diff-file-body');
    screen.getByRole('button', { name: '定位文件' }).click();
    await waitFor(() => expect(revealCalls.length).toBe(1));
    expect(revealCalls[0]?.projectId).toBe('sample');
    expect(revealCalls[0]?.fileRef).toBe('src/app/main.ts');
  });

  it('never falls back to the first registered project when resolving the reveal workspace', async () => {
    // Regression: a file ref must resolve through the diff's owning run —
    // an unrelated first project would locate a same-named file (or 404) in
    // the wrong workspace.
    projectList = [
      {
        projectId: 'unrelated-first', workspaceAlias: 'unrelated', authorityStatus: 'AVAILABLE',
        runningCount: 0, attentionCount: 0, vcsKind: 'GIT', branchDisplay: 'main',
        headShortRevision: '0000000', dirtySummary: null
      },
      {
        projectId: 'sample', workspaceAlias: 'sample', authorityStatus: 'AVAILABLE',
        runningCount: 0, attentionCount: 0, vcsKind: 'GIT', branchDisplay: 'main',
        headShortRevision: 'abc1234', dirtySummary: 'MODIFIED'
      }
    ];
    renderWorkbench();
    await selectRun();
    // Two project cards render a 查看变更 button each; the unrelated card has
    // no run so its button stays disabled — the sample card's is the only
    // actionable one.
    const changesButtons = screen.getAllByRole('button', { name: '查看变更' }) as HTMLButtonElement[];
    const enabled = changesButtons.find((button) => !button.disabled);
    expect(enabled).toBeDefined();
    fireEvent.click(enabled as HTMLButtonElement);
    await screen.findByTestId('git-surface');
    fireEvent.click(await screen.findByRole('button', { name: /src\/app\/main\.ts/ }));
    await screen.findByTestId('diff-file-body');
    screen.getByRole('button', { name: '定位文件' }).click();
    await waitFor(() => expect(revealCalls.length).toBe(1));
    expect(revealCalls[0]?.projectId).toBe('sample');
    expect(revealCalls[0]?.fileRef).toBe('src/app/main.ts');
  });

  it('resolves the reveal workspace through the session when the run sits in a worktree alias', async () => {
    // A run inside an isolated worktree reports the worktree's alias, which is
    // not a registered project. Resolution must fall back to the owning
    // session's workspace alias instead of showing 无法确定项目.
    runs[0]!.workspaceAlias = 'sample-wt-9f3c';
    renderWorkbench();
    await selectRun();
    await openChangesPage();
    fireEvent.click(await screen.findByRole('button', { name: /src\/app\/main\.ts/ }));
    await screen.findByTestId('diff-file-body');
    screen.getByRole('button', { name: '定位文件' }).click();
    await waitFor(() => expect(revealCalls.length).toBe(1));
    expect(revealCalls[0]?.projectId).toBe('sample');
    expect(revealCalls[0]?.fileRef).toBe('src/app/main.ts');
  });

  it('surfaces reveal failures instead of failing silently', async () => {
    revealError = new Error('FILE_OUTSIDE_WORKSPACE');
    renderWorkbench();
    await selectRun();
    await openChangesPage();
    fireEvent.click(await screen.findByRole('button', { name: /src\/app\/main\.ts/ }));
    await screen.findByTestId('diff-file-body');
    screen.getByRole('button', { name: '定位文件' }).click();
    await screen.findByText(/定位文件失败/);
  });
});

describe('FileReferenceDialog', () => {
  it('disables 定位文件 when the referenced file is missing from the workspace', () => {
    const onReveal = vi.fn();
    render(
      <FileReferenceDialog
        fileRef="internal/pkg/postgrespgx/postgres.go"
        query={{ isPending: false, isError: true, error: new DesktopProxyError('FILE_NOT_FOUND', 'Requested file is not present') }}
        revealPending={false}
        canReveal={true}
        onReveal={onReveal}
        onClose={() => undefined}
      />
    );
    expect(screen.getByText(/不存在/)).toBeDefined();
    const button = screen.getByRole('button', { name: '定位文件' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(onReveal).not.toHaveBeenCalled();
  });

  it('keeps 定位文件 usable for transient read failures', () => {
    const onReveal = vi.fn();
    render(
      <FileReferenceDialog
        fileRef="internal/pkg/postgrespgx/postgres.go"
        query={{ isPending: false, isError: true, error: new DesktopProxyError('UPSTREAM_FAILED', 'connection reset') }}
        revealPending={false}
        canReveal={true}
        onReveal={onReveal}
        onClose={() => undefined}
      />
    );
    const button = screen.getByRole('button', { name: '定位文件' }) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    fireEvent.click(button);
    expect(onReveal).toHaveBeenCalledWith('internal/pkg/postgrespgx/postgres.go');
  });
});
