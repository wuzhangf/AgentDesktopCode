// @vitest-environment jsdom
/**
 * WU-03 设计 §6.7: the unified conflict editor exposes the four panes,
 * only server-owned actions, and a typed STALE outcome that preserves the
 * user's merged draft.  Batch resolution goes through resolve-batch with
 * an all-item precheck.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceConflictEditor } from '../../src/renderer/app/conflicts/WorkspaceConflictEditor';
import { WorkspaceConflictSurface } from '../../src/renderer/app/conflicts/WorkspaceConflictSurface';
import type { WorkspaceConflictLike } from '../../src/renderer/app/queries';

let resolveCalls: Array<{ conflictId: string; body: Record<string, unknown> }> = [];
let dismissCalls: string[] = [];
let batchCalls: Array<Record<string, unknown>> = [];
let autoMergeCalls: string[] = [];

function conflict(overrides: Partial<WorkspaceConflictLike> = {}): WorkspaceConflictLike {
  return {
    conflictId: 'wc-aaaaaaaaaaaaaaaaaaaaaaaa',
    runId: 'run-1',
    path: 'src/Foo.java',
    kind: 'UPDATE_UPDATE',
    state: 'OPEN',
    stateVersion: 2,
    expectedVersion: 'sha256:base:1',
    actualVersion: 'sha256:current:1',
    origin: 'RUN_DIRECT_WRITE',
    currentContent: 'current\n',
    proposedContent: 'proposed\n',
    proposedContentRef: 'blob:sha256:abc',
    allowedActions: ['KEEP_CURRENT', 'USE_PROPOSED', 'MERGED_CONTENT', 'AUTO_MERGED', 'REQUEST_PROPOSAL', 'DISMISS'],
    autoMerge: { status: 'CLEAN', previewRef: null, reason: 'AUTO_MERGED' },
    ...overrides
  };
}

function installFakeApi(resolveError?: string): void {
  resolveCalls = [];
  dismissCalls = [];
  batchCalls = [];
  autoMergeCalls = [];
  Object.defineProperty(window, 'codeAgentDesktop', {
    configurable: true,
    value: {
      resolveWorkspaceConflict: vi.fn(async (conflictId: string, body: Record<string, unknown>) => {
        if (resolveError) throw Object.assign(new Error(resolveError), { code: resolveError });
        resolveCalls.push({ conflictId, body });
        return { runId: 'run-1' };
      }),
      dismissWorkspaceConflict: vi.fn(async (conflictId: string) => {
        dismissCalls.push(conflictId);
        return { runId: 'run-1' };
      }),
      autoMergeWorkspaceConflict: vi.fn(async (conflictId: string) => {
        autoMergeCalls.push(conflictId);
        return { status: 'CLEAN', previewRef: null, reason: 'AUTO_MERGED' };
      }),
      resolveWorkspaceConflictsBatch: vi.fn(async (body: Record<string, unknown>) => {
        batchCalls.push(body);
        return { appliedPaths: ['a.txt'], pendingPaths: [], failedPaths: [], items: [] };
      }),
      requestWorkspaceConflictProposal: vi.fn(async () => ({ proposalId: 'proposal-12345678-aaaa', status: 'PENDING' })),
      pollWorkspaceConflictProposal: vi.fn(async () => ({ proposalId: 'proposal-12345678-aaaa', status: 'PENDING' })),
      getWorkspaceContent: vi.fn(async () => ({ contentBase64: '', truncated: false, totalBytes: 0 }))
    }
  });
}

function renderEditor(item = conflict()): HTMLElement {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } }
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <WorkspaceConflictEditor conflict={item} />
    </QueryClientProvider>
  );
  return view.container;
}

describe('unified conflict editor', () => {
  beforeEach(() => installFakeApi());
  afterEach(() => cleanup());

  it('renders the four version panes with the current file as default', async () => {
    const container = renderEditor();
    expect(screen.getByText('读取时版本 B')).toBeTruthy();
    expect(screen.getByText('当前文件 C')).toBeTruthy();
    expect(screen.getByText('本次拟写入 A')).toBeTruthy();
    expect(screen.getByText('合并结果')).toBeTruthy();
    const pane = container.querySelector<HTMLElement>('.workspace-conflict-view');
    expect(pane?.textContent).toBe('current\n');
  });

  it('applies USE_PROPOSED without client content', async () => {
    renderEditor();
    fireEvent.click(screen.getByTestId('conflict-use-proposed'));
    await waitFor(() => expect(resolveCalls).toHaveLength(1));
    expect(resolveCalls[0]!.body.choice).toBe('USE_PROPOSED');
    expect(resolveCalls[0]!.body.expectedCurrentHash).toBe('sha256:current:1');
    expect(resolveCalls[0]!.body.resolutionContent).toBeUndefined();
  });

  it('applies AUTO_MERGED only when the preview is clean', async () => {
    renderEditor(conflict({ autoMerge: { status: 'CLEAN', previewRef: null, reason: null } }));
    const button = screen.getByTestId('conflict-auto-merge') as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    fireEvent.click(button);
    await waitFor(() => expect(resolveCalls).toHaveLength(1));
    expect(resolveCalls[0]!.body.choice).toBe('AUTO_MERGED');
  });

  it('disables auto-merge for overlapping previews', async () => {
    renderEditor(conflict({ autoMerge: { status: 'OVERLAPPING', previewRef: null, reason: 'OVERLAPPING_TEXT' } }));
    const button = screen.getByTestId('conflict-auto-merge') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });

  it('applies the edited merged content', async () => {
    renderEditor(conflict({ autoMerge: null }));
    fireEvent.click(screen.getByText('合并结果'));
    const merged = screen.getByLabelText('合并结果 src/Foo.java') as HTMLTextAreaElement;
    fireEvent.change(merged, { target: { value: 'merged final\n' } });
    fireEvent.click(screen.getByTestId('conflict-apply-merged'));
    await waitFor(() => expect(resolveCalls).toHaveLength(1));
    expect(resolveCalls[0]!.body.choice).toBe('MERGED_CONTENT');
    expect(resolveCalls[0]!.body.resolutionContent).toBe('merged final\n');
  });

  it('surfaces the stale notice and keeps the draft on 409', async () => {
    installFakeApi('WORKSPACE_VERSION_CHANGED');
    renderEditor();
    fireEvent.click(screen.getByText('合并结果'));
    fireEvent.change(screen.getByLabelText('合并结果 src/Foo.java'), { target: { value: 'my draft\n' } });
    fireEvent.click(screen.getByTestId('conflict-apply-merged'));
    await waitFor(() => expect(screen.getByText('文件再次更新，请重新合并。')).toBeTruthy());
    expect((screen.getByLabelText('合并结果 src/Foo.java') as HTMLTextAreaElement).value).toBe('my draft\n');
  });

  it('dismisses the path proposal', async () => {
    renderEditor();
    fireEvent.click(screen.getByTestId('conflict-dismiss'));
    await waitFor(() => expect(dismissCalls).toContain('wc-aaaaaaaaaaaaaaaaaaaaaaaa'));
  });
});

describe('conflict surface', () => {
  beforeEach(() => installFakeApi());
  afterEach(() => cleanup());

  it('shows a one-line entry that expands into list + editor', async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } }
    });
    render(
      <QueryClientProvider client={queryClient}>
        <WorkspaceConflictSurface runId="run-1" items={[conflict()]} />
      </QueryClientProvider>
    );
    expect(screen.getByTestId('conflict-summary')).toBeTruthy();
    fireEvent.click(screen.getByTestId('conflict-summary'));
    await waitFor(() => expect(screen.getByTestId('conflict-editor')).toBeTruthy());
  });

  it('renders nothing when every conflict is handled', () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } }
    });
    const { container } = render(
      <QueryClientProvider client={queryClient}>
        <WorkspaceConflictSurface runId="run-1" items={[conflict({ state: 'RESOLVED' })]} />
      </QueryClientProvider>
    );
    expect(container.querySelector('[data-testid="workspace-conflicts"]')).toBeNull();
  });
});
