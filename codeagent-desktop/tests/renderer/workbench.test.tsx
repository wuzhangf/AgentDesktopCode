// @vitest-environment jsdom
/**
 * Renderer workbench tests (EW3 acceptance): fast switching across
 * sessions never mixes data (selection generation §12.2), durable events
 * invalidate the server cache and the composer posts a typed message.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Workbench } from '../../src/renderer/app/App';
import type { DesktopCapabilities, SessionMessageRequest } from '../../electron/shared/api-types';

interface FakeSession {
  sessionId: string;
  sessionVersion: number;
  title: string;
  workspaceAlias: string;
  status: string;
  updatedAt?: number;
  messages: Array<{ id: string; role: string; content: string; status?: string }>;
}

const sessions: FakeSession[] = [
  {
    sessionId: 'session-aaa', sessionVersion: 1, title: 'Session A', workspaceAlias: 'sample',
    status: 'ACTIVE', updatedAt: Date.now(),
    messages: [{ id: 'm1', role: 'user', content: 'message for session A' }]
  },
  {
    sessionId: 'session-bbb', sessionVersion: 2, title: 'Session B', workspaceAlias: 'sample',
    status: 'ACTIVE', updatedAt: Date.now() - 2 * 86_400_000,
    messages: [{ id: 'm2', role: 'user', content: 'message for session B' }]
  }
];

const baselineMessages = new Map(sessions.map((s) => [s.sessionId, s.messages.map((m) => ({ ...m }))]));

const listeners = { durable: [] as Array<(frames: unknown) => void>, status: [] as Array<(s: unknown) => void> };
const sentMessages: Array<{ sessionId: string; body: Record<string, unknown> }> = [];
const fetchedSourceRequests: Array<Record<string, unknown>> = [];
const skillCatalog: Array<Record<string, unknown>> = [];
const governanceCalls: Array<{ kind: string; body: Record<string, unknown> }> = [];
let governanceDecision: 'ok' | 'conflict' = 'ok';
let approvalDecisionTransitionsRun = false;

/** installFakeApi's governance mocks consult these knobs per test. */
const fakeRuns: Array<{ runId: string; taskId: string; state: string; sourceStatus?: string; stateVersion: number; sessionId: string | null; failure?: Record<string, unknown> }> = [
  { runId: 'run-1', taskId: 'task-1', state: 'RUNNING', stateVersion: 4, sessionId: 'session-aaa' }
];
const fakeActivityItems: Array<Record<string, unknown>> = [];
const fakeAttention: Array<Record<string, unknown>> = [];

function installFakeApi(): void {
  listeners.durable.length = 0;
  listeners.status.length = 0;
  sentMessages.length = 0;
  fetchedSourceRequests.length = 0;
  skillCatalog.length = 0;
  governanceCalls.length = 0;
  governanceDecision = 'ok';
  approvalDecisionTransitionsRun = false;
  fakeRuns.length = 0;
  fakeRuns.push({ runId: 'run-1', taskId: 'task-1', state: 'RUNNING', stateVersion: 4, sessionId: 'session-aaa' });
  fakeActivityItems.length = 0;
  fakeAttention.length = 0;
  for (const session of sessions) {
    session.messages = (baselineMessages.get(session.sessionId) ?? []).map((m) => ({ ...m }));
  }
  Object.defineProperty(window, 'codeAgentDesktop', {
    configurable: true,
    value: {
      bootstrap: vi.fn(async () => ({ status: 'OWNED_READY' })),
      openExternalHttps: vi.fn(),
      restartService: vi.fn(),
      serviceStatus: vi.fn(),
      chooseAndRegisterProject: vi.fn(),
      diagnostics: vi.fn(async () => ({
        serviceState: 'OWNED_READY', ownedProcess: null, logLocation: '', encryptionAvailable: true
      })),
      listProjects: vi.fn(async () => [
        { projectId: 'sample', workspaceAlias: 'sample', authorityStatus: 'AVAILABLE', runningCount: 0, attentionCount: 0 }
      ]),
      getProjectSessionPreflight: vi.fn(async () => ({
        projectId: 'sample', workspaceAlias: 'sample', workspaceId: 'workspace-1',
        revision: 'preflight-1', policyFingerprint: 'policy-1', workspaceFingerprint: 'workspace-fp-1',
        authorityStatus: 'AVAILABLE', allowedIntents: ['ASK', 'CODE', 'PLAN'],
        suggestedWriteScope: ['src'], writeScopeCeiling: ['src'],
        modelAlias: 'fixture-model', modelAvailability: 'AVAILABLE'
      })),
      listSessions: vi.fn(async () => sessions),
      getSession: vi.fn(async (sessionId: string) => {
        // simulate a slow response for session A so a fast switch to B could
        // theoretically race the data in
        if (sessionId === 'session-aaa') {
          await new Promise((r) => setTimeout(r, 120));
        }
        return sessions.find((s) => s.sessionId === sessionId);
      }),
      createSession: vi.fn(async () => ({ sessionId: 'session-new', sessionVersion: 1 })),
      patchSession: vi.fn(),
      sendSessionMessage: vi.fn(async (sessionId: string, body: Record<string, unknown>) => {
        sentMessages.push({ sessionId, body });
        return { messageId: 'm-new', status: 'ACCEPTED', sessionVersion: 3, eventCursor: 9 };
      }),
      pageSessionMessages: vi.fn(async (sessionId: string) => ({
        schemaVersion: 'session-message-page/1',
        sessionId,
        transcriptRevision: '1',
        items: [],
        beforeCursor: null,
        afterCursor: null,
        hasOlder: false,
        hasNewer: false,
        rangeComplete: true
      })),
      forkSession: vi.fn(),
      archiveSession: vi.fn(),
      listMcpServers: vi.fn(async () => [
        { serverId: 'docs', status: 'READY', reason: null, resourceCount: null }
      ]),
      listMcpResources: vi.fn(async (serverId: string) => [
        { uri: 'file:///docs/a.md', name: 'a', mimeType: 'text/markdown' },
        { uri: 'file:///docs/b.txt', name: 'b', mimeType: null }
      ]),
      readMcpResource: vi.fn(async (serverId: string, uri: string) => ({
        serverId, uri, mimeType: 'text/markdown', contentBytes: 7, contentText: '# guide',
        truncated: false, untrustedContent: true, fetchedAt: '2026-08-29T00:00:00Z'
      })),
      listSkills: vi.fn(async () => skillCatalog.map((entry) => ({ ...entry }))),
      registerSkill: vi.fn(async (body: Record<string, unknown>) => {
        const record = { skillId: 'skill-1a2b3c4d5e6f7a8b9c0d', revision: 1, status: 'ACTIVE', ...body };
        skillCatalog.push(record);
        return record;
      }),
      changeSkillStatus: vi.fn(async (skillId: string, body: { status: string; expectedRevision: number }) => ({
        skillId, revision: body.expectedRevision + 1, status: body.status
      })),
      listHooks: vi.fn(async () => [
        { name: 'notify', event: 'RUN_TERMINAL', enabled: true, timeoutMillis: 5000,
          failurePolicy: 'LOG_ONLY', lastStatus: 'OK', lastFinishedAt: '2026-08-29T01:00:00Z' }
      ]),
      listHookExecutions: vi.fn(async () => ({ items: [{
        hookName: 'notify', event: 'RUN_TERMINAL', eventId: 'evt-1', status: 'OK',
        durationMillis: 12, finishedAt: '2026-08-29T01:00:00Z'
      }], truncated: false })),
      fetchSource: vi.fn(async (body: { sourceType: string; uri: string }) => {
        fetchedSourceRequests.push(body);
        return {
          sourceType: body.sourceType, sourceUri: body.uri, finalUri: body.uri,
          fetchedAt: '2026-08-29T00:00:00Z', contentType: 'text/markdown',
          contentBytes: 7, contentText: '# guide', truncated: false,
          untrustedContent: true, redirectCount: 0, statusCode: 200
        };
      }),
      listRuns: vi.fn(async () => ({ items: fakeRuns.map((r) => ({ ...r })) })),
      getRunActivities: vi.fn(async (runId: string) => ({
        runId, runStateVersion: 1, snapshotCursor: 1, complete: true,
        items: fakeActivityItems.filter((item) => item.runId === runId).map((item) => ({ ...item })),
        summary: { completeness: 'TERMINAL_EXACT', activityCount: fakeActivityItems.filter((item) => item.runId === runId).length }
      })),
      getRunReasoning: vi.fn(async (runId: string) => ({
        runId, runStateVersion: 1, snapshotCursor: 1, retentionFloor: 0,
        text: '', receivedBytes: 0, totalBytes: 0, droppedChunks: 0,
        lastSequence: 0, terminal: true, complete: true,
        reasonCode: 'TERMINAL_EXACT', truncated: false, segments: []
      })),
      getRunOutput: vi.fn(async (runId: string) => ({
        runId, runStateVersion: 1, snapshotCursor: 1, retentionFloor: 0,
        text: '', receivedBytes: 0, totalBytes: 0, droppedChunks: 0,
        lastSequence: 0, terminal: true, complete: true,
        reasonCode: 'TERMINAL_EXACT', truncated: false, segments: []
      })),
      listAttention: vi.fn(async () => ({ items: fakeAttention.map((a) => ({ ...a })) })),
      createSpec: vi.fn(async (_sessionId: string, body: unknown) => {
        governanceCalls.push({ kind: 'createSpec', body: body as Record<string, unknown> });
        return { specId: 'spec-1', revision: 1, status: 'DRAFT', approvalId: 'approval-1', contractMarkdown: '# contract', contractFingerprint: 'cfp', policyFingerprint: 'pfp', workspaceBaselineFingerprint: 'wfp' };
      }),
      getSpec: vi.fn(async (specId: string) => ({ specId, revision: 1, status: 'PENDING_APPROVAL', approvalId: 'approval-1', contractMarkdown: '# contract', contractFingerprint: 'cfp', policyFingerprint: 'pfp', workspaceBaselineFingerprint: 'wfp' })),
      reviseSpec: vi.fn(),
      decideSpecApproval: vi.fn(async (specId: string, approvalId: string, body: unknown) => {
        governanceCalls.push({ kind: 'decideSpec', body: body as Record<string, unknown> });
        if (governanceDecision === 'conflict') throw new Error('FINGERPRINT_MISMATCH');
        return { specId, approvalId, decision: 'APPROVED' };
      }),
      convertSpecToAct: vi.fn(async (specId: string, body: unknown) => {
        governanceCalls.push({ kind: 'convertSpec', body: body as Record<string, unknown> });
        return { specId, taskId: 'task-9', taskFingerprint: 'tfp', status: 'APPROVED' };
      }),
      decideCommandApproval: vi.fn(async (runId: string, body: unknown) => {
        governanceCalls.push({ kind: 'command', body: body as Record<string, unknown> });
        if (governanceDecision === 'conflict') throw new Error('APPROVAL_FINGERPRINT_MISMATCH');
        if (approvalDecisionTransitionsRun) {
          const run = fakeRuns.find((item) => item.runId === runId);
          if (run) {
            run.state = 'RUNNING';
            run.stateVersion += 1;
          }
        }
        return { ok: true };
      }),
      decideBudgetApproval: vi.fn(async (runId: string, body: unknown) => {
        governanceCalls.push({ kind: 'budget', body: body as Record<string, unknown> });
        if (governanceDecision === 'conflict') throw new Error('APPROVAL_FINGERPRINT_MISMATCH');
        return { ok: true };
      }),
      cancelRun: vi.fn(async (runId: string) => {
        governanceCalls.push({ kind: 'cancel', body: { runId } });
        return { ok: true };
      }),
      interruptRun: vi.fn(async (runId: string, options: { expectedStateVersion?: number }) => {
        governanceCalls.push({ kind: 'interrupt', body: { runId, ...options } });
        return { ok: true };
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
      approvalPing: vi.fn(async () => ({ pinged: true })),
      onDurableEvents: vi.fn((listener: (frames: unknown) => void) => {
        listeners.durable.push(listener);
        return () => undefined;
      }),
      onEventStatus: vi.fn((listener: (s: unknown) => void) => {
        listeners.status.push(listener);
        return () => undefined;
      })
    }
  });
}

const SIDEBAR_NAV_STORAGE_KEY = 'business-agent-desktop.sidebar-navigation.v1';

function renderWorkbench(capabilities?: DesktopCapabilities): void {
  // Design 2026-09-30 §5.1: project groups default to collapsed except the
  // selected session's group. Seeding the fixture's group as expanded keeps the
  // rows reachable without relaxing the production default; a stored state
  // (e.g. written by a view-toggle test) is never overwritten.
  if (!window.localStorage.getItem(SIDEBAR_NAV_STORAGE_KEY)) {
    window.localStorage.setItem(SIDEBAR_NAV_STORAGE_KEY, JSON.stringify({
      view: 'PROJECTS',
      pinnedSessionIds: [],
      collapsedSections: {},
      collapsedProjects: { sample: false }
    }));
  }
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } }
  });
  render(
    <QueryClientProvider client={queryClient}>
      <Workbench capabilities={capabilities} />
    </QueryClientProvider>
  );
}

async function openApprovalPanel(): Promise<HTMLElement> {
  return screen.findByTestId('approval-panel');
}

const serviceCapabilities: DesktopCapabilities = {
  compatible: true,
  operations: [
    { id: 'session.create.inspect', availability: 'AVAILABLE', contractVersion: '2.1' },
    { id: 'session.create.modify', availability: 'AVAILABLE', contractVersion: '2.1' },
    { id: 'session.create.plan', availability: 'AVAILABLE', contractVersion: '2.1' },
    { id: 'session.message.send.text', availability: 'AVAILABLE', contractVersion: '2.1' },
    { id: 'mission.manage', availability: 'AVAILABLE', contractVersion: '2.1' }
  ],
  features: {
    sessionV2: true, durableEvents: true, visibleOutputStream: true, worktreeExecution: true,
    mission: true, mcpHost: false, servicePty: false, readOnlySources: true,
    mcpReadOnlySource: true, skillsCatalog: true, hooks: true, readOnlySubagent: false
  },
  limits: { maxDiffBytes: 2_097_152, maxEventPage: 500, maxVisibleDeltaChars: 8_192 }
};

const serviceCapabilitiesWithApprovalList: DesktopCapabilities = {
  ...serviceCapabilities,
  operations: [
    ...(serviceCapabilities.operations ?? []),
    { id: 'approval.list', availability: 'AVAILABLE', contractVersion: '2.1' }
  ]
};

beforeEach(() => {
  installFakeApi();
  window.localStorage.removeItem(SIDEBAR_NAV_STORAGE_KEY);
});

afterEach(() => {
  cleanup();
});

describe('workbench selection isolation (design §12.2)', () => {
  it('never mixes conversation data across fast session switches', async () => {
    renderWorkbench();
    // both sessions appear in the list
    await screen.findByText('Session A');
    await screen.findByText('Session B');

    // open A, then switch to B quickly (before A's slow response arrives)
    const openA = screen.getByRole('button', { name: /Session A/ });
    const openB = screen.getByRole('button', { name: /Session B/ });
    openA.click();
    openB.click();

    // B's content shows; A's slow response must not leak into the view.
    // (The rail intentionally shows the last message as a preview, so the
    // isolation assertion is scoped to the open conversation.)
    await screen.findByText('message for session B');
    const conversation = (): HTMLElement =>
      document.querySelector('.conversation .messages') as HTMLElement;
    expect(within(conversation()).queryByText('message for session A')).toBeNull();

    // switching back to A eventually shows only A's content
    openA.click();
    await screen.findByText('message for session A');
    expect(within(conversation()).queryByText('message for session B')).toBeNull();
  });

  it('shows an unbound run failure directly in the main conversation', async () => {
    fakeRuns.length = 0;
    fakeRuns.push({
      runId: 'run-failure', taskId: 'task-failure', state: 'FAILED', stateVersion: 5,
      sessionId: 'session-aaa',
      failure: {
        schemaVersion: '1', code: 'PROCESS_FAILED', domain: 'TOOL_EXECUTION', phase: 'EXECUTE',
        disposition: 'TERMINAL', effectState: 'UNKNOWN', safeMessage: '命令退出码为 1。',
        recovery: { mode: 'NONE', actor: 'RUNTIME', automatic: false, actionIds: [] },
        context: { toolName: 'process_exec', toolCallId: 'call-failure' }, causes: []
      }
    });
    renderWorkbench();
    await screen.findByText('Session A');
    screen.getByRole('button', { name: /Session A/ }).click();
    const card = await screen.findByTestId('run-failure-card');
    expect(card.textContent).toContain('命令退出码为 1。');
    expect(card.textContent).toContain('process_exec');
    expect(card.textContent).toContain('效果未知');
  });

  it('invalidates runs and sessions when durable run events arrive', async () => {
    renderWorkbench();
    await screen.findByRole('button', { name: /run-1/ });
    const callsBefore = vi.mocked(window.codeAgentDesktop.listRuns).mock.calls.length;

    // a durable run event must trigger a fresh authoritative refetch
    for (const listener of listeners.durable) {
      listener([{ cursor: 1, type: 'run.terminal', payload: { runId: 'run-1', terminationCode: 'COMPLETED' } }]);
    }
    await waitFor(() => {
      expect(vi.mocked(window.codeAgentDesktop.listRuns).mock.calls.length).toBeGreaterThan(callsBefore);
    });
  });

  it('re-syncs the transcript again shortly after a run terminates', async () => {
    renderWorkbench();
    await screen.findByText('Session A');
    // the open conversation must be the one re-synced
    screen.getByRole('button', { name: /Session A/ }).click();
    await screen.findByText('message for session A');
    const getSession = vi.mocked(window.codeAgentDesktop.getSession);
    const before = getSession.mock.calls.length;
    for (const listener of listeners.durable) {
      listener([{ cursor: 9, type: 'run.terminal', payload: { runId: 'run-1', terminationCode: 'COMPLETED' } }]);
    }
    // immediate invalidation...
    await waitFor(() => expect(getSession.mock.calls.length).toBeGreaterThan(before), { timeout: 3000 });
    // ...plus the delayed re-sync that catches post-terminal persistence
    await waitFor(() => expect(getSession.mock.calls.length).toBeGreaterThan(before + 1), { timeout: 3000 });
  });

  it('composer posts a typed message with a client id', async () => {
    renderWorkbench();
    // Session B has no active run, so the composer shows its send action
    await screen.findByText('Session B');
    screen.getByRole('button', { name: /Session B/ }).click();
    await screen.findByText('message for session B');

    const input = screen.getByPlaceholderText(/输入消息/);
    fireEvent.change(input, { target: { value: 'hello from the workbench' } });
    await waitFor(() => {
      expect((input as HTMLInputElement).value).toBe('hello from the workbench');
    });
    screen.getByRole('button', { name: '发送' }).click();
    await waitFor(() => expect(sentMessages.length).toBe(1));
    expect(sentMessages[0]?.sessionId).toBe('session-bbb');
    expect(typeof sentMessages[0]?.body.clientMessageId).toBe('string');
    expect(sentMessages[0]?.body.content).toBe('hello from the workbench');
  });

  it('changes the selected session model through the concurrency-guarded patch API', async () => {
    vi.mocked(window.codeAgentDesktop.getModelCatalog).mockResolvedValueOnce({
      defaultModel: 'fixture-model',
      items: [
        { modelAlias: 'fixture-model', configured: true, availability: 'AVAILABLE' },
        { modelAlias: 'alpha-pro', configured: true, availability: 'AVAILABLE' },
        { modelAlias: 'unconfigured-model', configured: false, availability: 'UNCONFIGURED' }
      ]
    } as never);
    vi.mocked(window.codeAgentDesktop.patchSession).mockResolvedValueOnce({
      sessionId: 'session-bbb', sessionVersion: 3, modelAlias: 'alpha-pro'
    } as never);

    renderWorkbench(serviceCapabilities);
    await screen.findByText('Session B');
    screen.getByRole('button', { name: /Session B/ }).click();
    await screen.findByText('message for session B');

    screen.getByTestId('composer-model-selector-trigger').click();
    const model = await screen.findByTestId('composer-model-selector-select') as HTMLSelectElement;
    expect(model.value).toBe('');
    expect(within(model).queryByRole('option', { name: 'unconfigured-model' })).toBeNull();
    fireEvent.change(model, { target: { value: 'alpha-pro' } });

    await waitFor(() => expect(window.codeAgentDesktop.patchSession).toHaveBeenCalledWith(
      'session-bbb',
      expect.objectContaining({ expectedSessionVersion: 2, modelAlias: 'alpha-pro' })
    ));
    expect(model.value).toBe('alpha-pro');
  });

  it('exposes reasoning and context selectors in the active session composer', async () => {
    vi.mocked(window.codeAgentDesktop.getModelCatalog).mockResolvedValueOnce({
      defaultModel: 'fixture-model',
      items: [{
        modelAlias: 'fixture-model', configured: true, availability: 'AVAILABLE',
        capabilities: ['IMAGE_INPUT'], reasoningEffortOptions: ['low', 'high'], contextTokenOptions: [32768, 64000],
        contextWindowTokens: 1048576, contextUsedTokens: 30000, cacheHitRatePercent: 89.8, usageSampleCount: 3
      }]
    } as never);
    vi.mocked(window.codeAgentDesktop.patchSession).mockResolvedValue({
      sessionId: 'session-bbb', sessionVersion: 3, modelAlias: null,
      modelSettings: { reasoningMode: 'EFFORT', reasoningOptionId: 'low', contextMode: 'AUTO' }
    } as never);

    renderWorkbench(serviceCapabilities);
    await screen.findByText('Session B');
    screen.getByRole('button', { name: /Session B/ }).click();
    await screen.findByText('message for session B');

    screen.getByTestId('composer-model-selector-trigger').click();
    const reasoning = await screen.findByTestId('composer-model-selector-reasoning-mode') as HTMLSelectElement;
    const context = await screen.findByTestId('composer-model-selector-context') as HTMLSelectElement;
    const usage = await screen.findByTestId('composer-model-selector-usage');
    const controls = screen.getByTestId('composer-model-selector');
    expect(within(reasoning).getByRole('option', { name: '选择档位' })).toBeDefined();
    expect(within(context).getByRole('option', { name: '64K' })).toBeDefined();
    expect(controls.querySelector('.composer-model-context-row')?.nextElementSibling?.classList.contains('composer-model-reasoning-row')).toBe(true);
    expect(screen.queryByText('活动 Run：当前请求完成后生效')).toBeNull();
    expect(usage.textContent).toContain('上下文容量');
    expect(usage.textContent).toContain('3万 / 100万 (3%)');
    expect(usage.textContent).toContain('平均缓存命中率');
    expect(usage.textContent).toContain('89.8%');
    fireEvent.change(reasoning, { target: { value: 'EFFORT' } });
    await waitFor(() => expect(window.codeAgentDesktop.patchSession).toHaveBeenCalledWith(
      'session-bbb', expect.objectContaining({
        modelSettings: expect.objectContaining({ reasoningMode: 'EFFORT', reasoningOptionId: 'low' })
      })
    ));
  });

  it('refreshes the selected conversation after the service accepts a message', async () => {
    renderWorkbench();
    await screen.findByText('Session B');
    screen.getByRole('button', { name: /Session B/ }).click();
    await screen.findByText('message for session B');

    const getSession = vi.mocked(window.codeAgentDesktop.getSession);
    const callsBeforeSend = getSession.mock.calls.length;
    fireEvent.change(screen.getByPlaceholderText(/输入消息/), { target: { value: 'refresh me' } });
    screen.getByRole('button', { name: '发送' }).click();

    await waitFor(() => expect(sentMessages.length).toBe(1));
    await waitFor(() => expect(getSession.mock.calls.length).toBeGreaterThan(callsBeforeSend));
  });

  it('shows a reconnect banner when the durable stream drops', async () => {
    renderWorkbench();
    await screen.findByText('Session A');
    for (const listener of listeners.status) {
      listener({ status: 'RECONNECTING' });
    }
    await screen.findByText(/事件流：RECONNECTING/);
  });
});

describe('visible output stream (EW4, design §9.4)', () => {
  it('renders real model output as a temporary bubble and archives it on terminal', async () => {
    renderWorkbench();
    await screen.findByText('Session A');
    // session A has an active run (fake listRuns returns run-1 RUNNING for it)
    screen.getByRole('button', { name: /Session A/ }).click();
    await screen.findByText('message for session A');

    // no output events yet -> no bubble at all (no fake activity)
    expect(screen.queryByTestId('ungrouped-output')).toBeNull();

    // durable output deltas arrive (frames carry no roundId -> run-level
    // fallback row, the round-path equivalent of the old bubble)
    for (const listener of listeners.durable) {
      listener([
        { cursor: 1, type: 'run.output.append', payload: { runId: 'run-1', text: 'Hello ', bytes: 6, totalBytes: 6, droppedChunks: 0, sequence: 1 } },
        { cursor: 2, type: 'run.output.append', payload: { runId: 'run-1', text: 'model!', bytes: 6, totalBytes: 12, droppedChunks: 0, sequence: 2 } }
      ]);
    }
    const bubble = await screen.findByTestId('ungrouped-output');
    expect(bubble.textContent).toContain('Hello model!');
    expect(bubble.textContent).toContain('12 / 12 字节');

    // terminal event archives the row (the authoritative answer owns it)
    for (const listener of listeners.durable) {
      listener([{ cursor: 3, type: 'run.terminal', payload: { runId: 'run-1', terminationCode: 'COMPLETED' } }]);
    }
    await waitFor(() => expect(screen.queryByTestId('ungrouped-output')).toBeNull());
  });

  it('flags an incomplete stream honestly instead of faking completeness', async () => {
    renderWorkbench();
    await screen.findByText('Session A');
    screen.getByRole('button', { name: /Session A/ }).click();
    await screen.findByText('message for session A');

    // the service reports more total bytes than were ever delivered
    for (const listener of listeners.durable) {
      listener([
        { cursor: 1, type: 'run.output.append', payload: { runId: 'run-1', text: 'partial ', bytes: 8, totalBytes: 100, droppedChunks: 2, sequence: 1 } }
      ]);
    }
    const bubble = await screen.findByTestId('ungrouped-output');
    expect(bubble.textContent).toContain('输出中断，正在同步最终响应');
    expect(bubble.textContent).toContain('丢弃 2 段');
  });

  it('ignores malformed output payloads fail-closed', async () => {
    const { reduceVisibleOutput } = await import('../../src/renderer/app/queries');
    const empty = new Map();
    // no runId / no text -> unchanged
    expect(reduceVisibleOutput(empty, { type: 'run.output.append', payload: { text: 'x' } }).size).toBe(0);
    expect(reduceVisibleOutput(empty, { type: 'run.output.append', payload: null }).size).toBe(0);
    expect(reduceVisibleOutput(empty, { type: 'unrelated.event', payload: { runId: 'r', text: 'x' } })).toBe(empty);
    // text beyond the UI cap is truncated to the tail
    const long = 'x'.repeat(9000);
    const result = reduceVisibleOutput(empty, { type: 'run.output.append', payload: { runId: 'r', text: long, bytes: 9000, totalBytes: 9000, droppedChunks: 0, sequence: 1 } });
    expect(result.get('r')?.text.length).toBe(8192);
    // real SSE data is a complete BusinessEventEnvelope, not a flat payload
    const nested = reduceVisibleOutput(empty, {
      type: 'run.output.append',
      payload: { runId: 'nested-run', payload: { text: 'nested ', bytes: 7, totalBytes: 7, droppedChunks: 0, sequence: 1 } }
    });
    expect(nested.get('nested-run')?.text).toBe('nested ');
    // duplicate relay sequence is idempotent; a forward gap stops the live claim
    const duplicate = reduceVisibleOutput(nested, {
      type: 'run.output.append',
      payload: { runId: 'nested-run', payload: { text: 'duplicate', bytes: 9, totalBytes: 16, droppedChunks: 0, sequence: 1 } }
    });
    expect(duplicate.get('nested-run')?.text).toBe('nested ');
    expect(duplicate).toBe(nested);
    const gap = reduceVisibleOutput(duplicate, {
      type: 'run.output.append',
      payload: { runId: 'nested-run', payload: { text: 'after gap', bytes: 9, totalBytes: 16, droppedChunks: 0, sequence: 3 } }
    });
    expect(gap.get('nested-run')?.interrupted).toBe(true);
    // unknown terminal shapes are dropped safely
    expect(reduceVisibleOutput(empty, { type: 'run.terminal', payload: null }).size).toBe(0);
  });

  it('reduces reasoning chunks into a fold that survives run.terminal', async () => {
    const { reduceVisibleReasoning } = await import('../../src/renderer/app/queries');
    const empty = new Map();
    // fail-closed on malformed payloads
    expect(reduceVisibleReasoning(empty, { type: 'run.reasoning.append', payload: { text: 'x' } }).size).toBe(0);
    expect(reduceVisibleReasoning(empty, { type: 'run.reasoning.append', payload: null }).size).toBe(0);
    expect(reduceVisibleReasoning(empty, { type: 'run.output.append', payload: { runId: 'r', text: 'x' } })).toBe(empty);
    // nested BusinessEventEnvelope like the real SSE frame
    const first = reduceVisibleReasoning(empty, {
      type: 'run.reasoning.append',
      payload: { runId: 'run-1', payload: { text: '先检查', bytes: 9, totalBytes: 9, droppedChunks: 0, sequence: 1 } }
    });
    expect(first.get('run-1')?.text).toBe('先检查');
    expect(first.get('run-1')?.terminal).toBe(false);
    // duplicate sequence is idempotent
    const dup = reduceVisibleReasoning(first, {
      type: 'run.reasoning.append',
      payload: { runId: 'run-1', payload: { text: 'dup', bytes: 3, totalBytes: 12, droppedChunks: 0, sequence: 1 } }
    });
    expect(dup).toBe(first);
    // forward gap flags the fold as interrupted
    const gap = reduceVisibleReasoning(dup, {
      type: 'run.reasoning.append',
      payload: { runId: 'run-1', payload: { text: 'tail', bytes: 4, totalBytes: 16, droppedChunks: 0, sequence: 3 } }
    });
    expect(gap.get('run-1')?.interrupted).toBe(true);
    expect(gap.get('run-1')?.text).toBe('先检查tail');
    // terminal marks the fold but keeps it visible for the finished answer
    const done = reduceVisibleReasoning(gap, { type: 'run.terminal', payload: { runId: 'run-1' } });
    expect(done.get('run-1')?.terminal).toBe(true);
    expect(done.get('run-1')?.text).toBe('先检查tail');
    // text beyond the UI cap is truncated to the tail
    const long = reduceVisibleReasoning(empty, {
      type: 'run.reasoning.append',
      payload: { runId: 'r2', text: 'y'.repeat(9000), bytes: 9000, totalBytes: 9000, droppedChunks: 0, sequence: 1 }
    });
    expect(long.get('r2')?.text.length).toBe(8192);
  });

  it('keeps the finished run process panel collapsed in the assistant turn after terminal', async () => {
    renderWorkbench();
    await screen.findByText('Session A');
    screen.getByRole('button', { name: /Session A/ }).click();
    await screen.findByText('message for session A');

    // live round-1 activity folds in while the run is active
    for (const listener of listeners.durable) {
      listener([
        { cursor: 1, type: 'tool.started',
          payload: { runId: 'run-1', occurredAt: '2026-09-19T10:00:00.000Z',
            payload: { activityId: 'step-0-call-1', activityKind: 'MODEL', roundId: 'step-0-call-1', roundOrdinal: 1 } } },
        { cursor: 2, type: 'tool.completed',
          payload: { runId: 'run-1', occurredAt: '2026-09-19T10:00:14.000Z',
            payload: { activityId: 'step-0-call-1', activityKind: 'MODEL', roundId: 'step-0-call-1', roundOrdinal: 1, status: 'SUCCEEDED', durationMillis: 14000 } } },
        { cursor: 3, type: 'tool.started',
          payload: { runId: 'run-1', occurredAt: '2026-09-19T10:00:14.500Z',
            payload: { activityId: 'tool-1', activityKind: 'CODE_SEARCH', toolName: 'code_search', roundId: 'step-0-call-1', roundOrdinal: 1 } } },
        { cursor: 4, type: 'tool.completed',
          payload: { runId: 'run-1', occurredAt: '2026-09-19T10:00:15.000Z',
            payload: { activityId: 'tool-1', activityKind: 'CODE_SEARCH', toolName: 'code_search', roundId: 'step-0-call-1', roundOrdinal: 1, status: 'SUCCEEDED', durationMillis: 500, resultSummary: '21 results' } } }
      ]);
    }
    // the live transcript renders inside the active-run panel
    expect(await screen.findByText(/第 1 轮交互/)).toBeTruthy();

    // the run completes; the authoritative answer lands as a history message
    fakeRuns[0]!.state = 'SUCCEEDED';
    const sessionA = sessions.find((s) => s.sessionId === 'session-aaa')!;
    sessionA.messages.push(
      { id: 'm-answer', role: 'assistant', content: 'there are 21 REST endpoints', runId: 'run-1' } as never
    );
    for (const listener of listeners.durable) {
      listener([{ cursor: 5, type: 'run.terminal', payload: { runId: 'run-1', terminationCode: 'COMPLETED' } }]);
    }

    // the live status bar may go away once nothing is active...
    await waitFor(() => expect(screen.queryByTestId('run-status-bar')).toBeNull());
    // ...but the process panel must persist inside the finished turn
    expect(await screen.findByText(/第 1 轮交互/)).toBeTruthy();
  });

  it('keeps a failed run transcript with only ungrouped activities visible in history', async () => {
    renderWorkbench();
    await screen.findByText('Session A');
    screen.getByRole('button', { name: /Session A/ }).click();
    await screen.findByText('message for session A');

    // a failed run may carry only ungrouped items (roundId missing)
    for (const listener of listeners.durable) {
      listener([
        { cursor: 1, type: 'tool.failed',
          payload: { runId: 'run-1', occurredAt: '2026-09-19T10:00:05.000Z',
            payload: { activityId: 'op-1', activityKind: 'CODE_SEARCH', toolName: 'code_search', status: 'UNKNOWN', durationMillis: 92 } } }
      ]);
    }
    fakeRuns[0]!.state = 'FAILED';
    const sessionA = sessions.find((s) => s.sessionId === 'session-aaa')!;
    sessionA.messages.push(
      { id: 'm-failed', role: 'assistant', content: 'Run FAILED: PRODUCT_INVOCATION_ERROR', runId: 'run-1' } as never
    );
    for (const listener of listeners.durable) {
      listener([{ cursor: 2, type: 'run.terminal', payload: { runId: 'run-1', terminationCode: 'FAILED' } }]);
    }

    // the ungrouped activity row must stay visible inside the finished turn
    await waitFor(() => expect(screen.getAllByText(/Run FAILED/).length).toBeGreaterThan(0));
    const row = await screen.findByTestId('round-ungrouped');
    expect(row.textContent).toContain('code_search');
  });

  it('loads a finished turn process panel on view even without cached activities', async () => {
    // cold history: the run finished before this renderer ever saw a frame —
    // the turn must still show its collapsed panel, not a bare entry button
    fakeRuns[0]!.state = 'SUCCEEDED';
    fakeActivityItems.push(
      { activityId: 'step-0-call-1', runId: 'run-1', kind: 'MODEL', status: 'SUCCEEDED',
        roundId: 'step-0-call-1', roundOrdinal: 1, durationMillis: 14000,
        startedAt: '2026-09-19T10:00:00Z', finishedAt: '2026-09-19T10:00:14Z' },
      { activityId: 'op-1', runId: 'run-1', kind: 'CODE_SEARCH', status: 'SUCCEEDED',
        roundId: 'step-0-call-1', roundOrdinal: 1, toolName: 'code_search', durationMillis: 118,
        startedAt: '2026-09-19T10:00:14Z', finishedAt: '2026-09-19T10:00:14Z', resultSummary: '21 results' }
    );
    const sessionA = sessions.find((s) => s.sessionId === 'session-aaa')!;
    sessionA.messages.push(
      { id: 'm-cold', role: 'assistant', content: 'there are 21 REST endpoints', runId: 'run-1' } as never
    );

    renderWorkbench();
    await screen.findByText('Session A');
    screen.getByRole('button', { name: /Session A/ }).click();
    await screen.findByText('message for session A');

    // the panel mounts and fetches the snapshot by itself
    const block = await screen.findByText(/第 1 轮交互/);
    expect(block).toBeTruthy();
    expect(vi.mocked(window.codeAgentDesktop.getRunActivities)).toHaveBeenCalledWith('run-1');
  });

  it('keeps the process panel when the service returns enum-case message roles', async () => {
    // The wire contract serializes roles in enum case ('ASSISTANT'); the
    // renderer model is lowercase — the turn must still own its panel.
    fakeRuns[0]!.state = 'SUCCEEDED';
    fakeActivityItems.push(
      { activityId: 'step-0-call-1', runId: 'run-1', kind: 'MODEL', status: 'SUCCEEDED',
        roundId: 'step-0-call-1', roundOrdinal: 1, durationMillis: 14000,
        startedAt: '2026-09-19T10:00:00Z', finishedAt: '2026-09-19T10:00:14Z' },
      { activityId: 'op-1', runId: 'run-1', kind: 'CODE_SEARCH', status: 'SUCCEEDED',
        roundId: 'step-0-call-1', roundOrdinal: 1, toolName: 'code_search', durationMillis: 118,
        startedAt: '2026-09-19T10:00:14Z', finishedAt: '2026-09-19T10:00:14Z', resultSummary: '21 results' }
    );
    const sessionA = sessions.find((s) => s.sessionId === 'session-aaa')!;
    sessionA.messages.push(
      { id: 'm-enum', role: 'ASSISTANT', content: 'there are 21 REST endpoints', runId: 'run-1' } as never
    );

    renderWorkbench();
    await screen.findByText('Session A');
    screen.getByRole('button', { name: /Session A/ }).click();
    await screen.findByText('message for session A');

    expect(await screen.findByText(/第 1 轮交互/)).toBeTruthy();
  });

  it('shows streamed reasoning in a collapsible block above the answer', async () => {
    renderWorkbench();
    await screen.findByText('Session A');
    screen.getByRole('button', { name: /Session A/ }).click();
    await screen.findByText('message for session A');

    for (const listener of listeners.durable) {
      listener([
        { cursor: 1, type: 'run.reasoning.append', payload: { runId: 'run-1', payload: { text: '先分析问题。', bytes: 15, totalBytes: 15, droppedChunks: 0, sequence: 1 } } },
        { cursor: 2, type: 'run.output.append', payload: { runId: 'run-1', text: 'answer', bytes: 6, totalBytes: 6, droppedChunks: 0, sequence: 1 } }
      ]);
    }
    const reasoning = await screen.findByTestId('ungrouped-reasoning');
    expect(reasoning.textContent).toContain('正在思考');
    expect(reasoning.textContent).toContain('先分析问题');
    // reasoning and answer stay visually separate
    expect(reasoning.querySelector('.round-thinking-text')).toBeTruthy();
    expect(await screen.findByTestId('ungrouped-output')).toBeTruthy();
    // terminal keeps the reasoning fold (unlike the answer row)
    for (const listener of listeners.durable) {
      listener([{ cursor: 3, type: 'run.terminal', payload: { runId: 'run-1', terminationCode: 'COMPLETED' } }]);
    }
    await waitFor(() => expect(screen.queryByTestId('ungrouped-reasoning')).toBeTruthy());
  });
});

describe('governance workbench (EW5)', () => {
  it('routes a background approval into the session page and keeps approval settings separate', async () => {
    fakeRuns.length = 0;
    fakeRuns.push({ runId: 'run-reminder', taskId: 'task-reminder', state: 'WAITING_APPROVAL', stateVersion: 7, sessionId: 'session-aaa' });
    fakeAttention.push({ attentionId: 'a-reminder', sourceType: 'RUN', sourceId: 'run-reminder', attentionType: 'COMMAND_APPROVAL', fingerprint: 'fp-reminder', summary: '需要确认 ipconfig' });
    renderWorkbench();

    await screen.findByText('Session A');
    screen.getByRole('button', { name: /Session A/ }).click();
    expect(screen.queryByTestId('approval-reminder')).toBeNull();
    expect(await screen.findByTestId('approval-panel')).toBeTruthy();
    await screen.findByText('message for session A');
    expect(screen.queryByTestId('approval-settings-panel')).toBeNull();
    screen.getByTestId('permission-mode-chip').click();
    const settingsPanel = await screen.findByTestId('approval-settings-panel');
    expect(within(settingsPanel).getByTestId('permission-mode-row')).toBeTruthy();
    expect(within(settingsPanel).getByText(/保持标准权限/)).toBeTruthy();
  });

  it('renders a typed approval card and posts a fingerprint-guarded decision', async () => {
    fakeRuns.length = 0;
    fakeRuns.push({ runId: 'run-wait', taskId: 'task-w', state: 'WAITING_APPROVAL', stateVersion: 7, sessionId: 'session-aaa' });
    fakeAttention.push({ attentionId: 'a-1', sourceType: 'RUN', sourceId: 'run-wait', attentionType: 'COMMAND_APPROVAL', fingerprint: 'fp-123', summary: 'rm -rf target' });
    renderWorkbench();
    await screen.findByText('Session A');
    screen.getByRole('button', { name: /Session A/ }).click();
    const approvalPanel = await openApprovalPanel();
    await within(approvalPanel).findByText(/命令审批/);
    fireEvent.click(within(approvalPanel).getByRole('button', { name: '批准' }));
    await waitFor(() => expect(governanceCalls.some((c) => c.kind === 'command')).toBe(true));
    const decision = governanceCalls.find((c) => c.kind === 'command');
    expect(decision?.body.fingerprint).toBe('fp-123');
    expect(decision?.body.decision).toBe('APPROVE');
  });

  it('keeps the legacy command approval card when unified approval list is empty', async () => {
    fakeRuns.length = 0;
    fakeRuns.push({ runId: 'run-legacy-approval', taskId: 'task-legacy-approval', state: 'WAITING_APPROVAL', stateVersion: 7, sessionId: 'session-aaa' });
    fakeAttention.push({ attentionId: 'a-legacy-approval', sourceType: 'RUN', sourceId: 'run-legacy-approval', attentionType: 'COMMAND_APPROVAL', fingerprint: 'fp-legacy', summary: 'ipconfig' });
    Object.assign(window.codeAgentDesktop, {
      listApprovals: vi.fn(async () => ({ items: [] }))
    });
    renderWorkbench(serviceCapabilitiesWithApprovalList);
    await screen.findByText('Session A');
    screen.getByRole('button', { name: /Session A/ }).click();
    const approvalPanel = await openApprovalPanel();
    const dock = await screen.findByTestId('composer-dock');
    expect(within(approvalPanel).getByTestId('approval-card')).toBeTruthy();
    expect(within(approvalPanel).getByText(/命令审批/)).toBeTruthy();
    expect(screen.queryByTestId('approval-trigger')).toBeNull();
    expect(within(dock).queryByTestId('approval-card')).toBeNull();
  });

  it('routes budget approval by source status instead of the broad public state', async () => {
    fakeRuns.length = 0;
    fakeRuns.push({ runId: 'run-budget', taskId: 'task-budget', state: 'WAITING_APPROVAL', sourceStatus: 'WAITING_BUDGET_APPROVAL', stateVersion: 8, sessionId: 'session-aaa' });
    fakeAttention.push({ attentionId: 'a-budget', sourceType: 'RUN', sourceId: 'run-budget', attentionType: 'BUDGET_APPROVAL', fingerprint: 'budget-fp', summary: '需要追加预算' });
    renderWorkbench();
    await screen.findByText('Session A');
    screen.getByRole('button', { name: /Session A/ }).click();
    const approvalPanel = await openApprovalPanel();
    const budgetCard = await within(approvalPanel).findByTestId('approval-card');
    expect(budgetCard.textContent).toContain('预算审批');
    within(approvalPanel).getByRole('button', { name: '批准' }).click();
    await waitFor(() => expect(governanceCalls.some((c) => c.kind === 'budget')).toBe(true));
    expect(governanceCalls.find((c) => c.kind === 'budget')?.body.requestFingerprint).toBe('budget-fp');
  });

  it('surfaces stale fingerprint conflicts and refreshes instead of failing silently', async () => {
    fakeRuns.length = 0;
    fakeRuns.push({ runId: 'run-wait', taskId: 'task-w', state: 'WAITING_APPROVAL', stateVersion: 7, sessionId: 'session-aaa' });
    fakeAttention.push({ attentionId: 'a-1', sourceType: 'RUN', sourceId: 'run-wait', attentionType: 'COMMAND_APPROVAL', fingerprint: 'stale-fp', summary: '' });
    governanceDecision = 'conflict';
    renderWorkbench();
    await screen.findByText('Session A');
    screen.getByRole('button', { name: /Session A/ }).click();
    const approvalPanel = await openApprovalPanel();
    await within(approvalPanel).findByText(/命令审批/);
    within(approvalPanel).getByRole('button', { name: '批准' }).click();
    await screen.findByText(/状态已变化/);
  });

  it('pings main once per waiting run and shows a live waiting timer', async () => {
    fakeRuns.length = 0;
    fakeRuns.push({ runId: 'run-wait', taskId: 'task-w', state: 'WAITING_APPROVAL', stateVersion: 7, sessionId: 'session-aaa' });
    fakeAttention.push({ attentionId: 'a-1', sourceType: 'RUN', sourceId: 'run-wait', attentionType: 'COMMAND_APPROVAL', fingerprint: 'fp-123', summary: 'rm -rf target' });
    renderWorkbench();
    await screen.findByText('Session A');
    screen.getByRole('button', { name: /Session A/ }).click();
    const approvalPanel = await openApprovalPanel();
    const card = await within(approvalPanel).findByTestId('approval-card');
    // per-type accent + live waiting label
    expect(card.className).toContain('approval-command');
    expect(card.textContent).toContain('已等待');
    // one taskbar ping per waiting run (main no-ops when focused)
    await waitFor(() => expect(vi.mocked(window.codeAgentDesktop.approvalPing)).toHaveBeenCalledTimes(1));
  });

  it('converges the visible status after an approval is accepted by Service', async () => {
    fakeRuns.length = 0;
    fakeRuns.push({ runId: 'run-approved', taskId: 'task-approved', state: 'WAITING_APPROVAL', stateVersion: 7, sessionId: 'session-aaa' });
    fakeAttention.push({ attentionId: 'a-approved', sourceType: 'RUN', sourceId: 'run-approved', attentionType: 'COMMAND_APPROVAL', fingerprint: 'fp-approved', summary: '需要确认 ipconfig' });
    approvalDecisionTransitionsRun = true;
    renderWorkbench();
    await screen.findByText('Session A');
    screen.getByRole('button', { name: /Session A/ }).click();
    const approvalPanel = await openApprovalPanel();
    await within(approvalPanel).findByText(/命令审批/);
    within(approvalPanel).getByRole('button', { name: '批准' }).click();

    await waitFor(() => expect(screen.getByTestId('run-status-bar').textContent).toContain('Agent 运行中'));
    expect(screen.queryByText('审批已接收 · 状态同步中')).toBeNull();
  });

  it('approves the first pending approval with Cmd+1', async () => {
    fakeRuns.length = 0;
    fakeRuns.push({ runId: 'run-wait', taskId: 'task-w', state: 'WAITING_APPROVAL', stateVersion: 7, sessionId: 'session-aaa' });
    fakeAttention.push({ attentionId: 'a-1', sourceType: 'RUN', sourceId: 'run-wait', attentionType: 'COMMAND_APPROVAL', fingerprint: 'fp-123', summary: 'rm -rf target' });
    renderWorkbench();
    await screen.findByText('Session A');
    screen.getByRole('button', { name: /Session A/ }).click();
    const approvalPanel = await openApprovalPanel();
    await within(approvalPanel).findByText(/命令审批/);
    fireEvent.keyDown(document.body, { key: '1', metaKey: true });
    await waitFor(() => expect(governanceCalls.some((c) => c.kind === 'command')).toBe(true));
    expect(governanceCalls.find((c) => c.kind === 'command')?.body.decision).toBe('APPROVE');
  });

  it('posts run interrupt with the optimistic stateVersion guard', async () => {
    renderWorkbench();
    await screen.findByRole('button', { name: /run-1/ });
    screen.getByRole('button', { name: '中断' }).click();
    await waitFor(() => expect(governanceCalls.some((c) => c.kind === 'interrupt')).toBe(true));
    const interrupt = governanceCalls.find((c) => c.kind === 'interrupt');
    expect(interrupt?.body.runId).toBe('run-1');
    expect(interrupt?.body.expectedStateVersion).toBe(4);
  });

  it('cancels a queued run instead of calling the running-only interrupt endpoint', async () => {
    fakeRuns.length = 0;
    fakeRuns.push({ runId: 'run-queued', taskId: 'task-queued', state: 'QUEUED', stateVersion: 6, sessionId: 'session-aaa' });
    renderWorkbench();
    await screen.findByText('Session A');
    screen.getByRole('button', { name: /Session A/ }).click();

    screen.getByRole('button', { name: '取消排队' }).click();
    await waitFor(() => expect(governanceCalls.some((c) => c.kind === 'cancel')).toBe(true));
    expect(governanceCalls.some((c) => c.kind === 'interrupt')).toBe(false);
  });

  it('cancels a queued run from the composer stop button', async () => {
    fakeRuns.length = 0;
    fakeRuns.push({ runId: 'run-queued', taskId: 'task-queued', state: 'QUEUED', stateVersion: 6, sessionId: 'session-aaa' });
    renderWorkbench();
    await screen.findByText('Session A');
    screen.getByRole('button', { name: /Session A/ }).click();
    await screen.findByText('message for session A');

    screen.getByRole('button', { name: '停止生成' }).click();
    await waitFor(() => expect(governanceCalls.some((c) => c.kind === 'cancel')).toBe(true));
    expect(governanceCalls.some((c) => c.kind === 'interrupt')).toBe(false);
  });

  it('clears the optimistic stop marker when the interrupt request is rejected', async () => {
    vi.mocked(window.codeAgentDesktop.interruptRun).mockImplementationOnce(async (runId: string, options: { expectedStateVersion?: number }) => {
      governanceCalls.push({ kind: 'interrupt', body: { runId, ...options } });
      throw new Error('RUN_NOT_INTERRUPTABLE');
    });
    renderWorkbench();
    await screen.findByRole('button', { name: /run-1/ });
    const interruptButton = screen.getByRole('button', { name: '中断' });
    interruptButton.click();

    await waitFor(() => expect(screen.getByText(/操作失败：RUN_NOT_INTERRUPTABLE/)).toBeTruthy());
    await waitFor(() => expect((screen.getByRole('button', { name: '中断' }) as HTMLButtonElement).disabled).toBe(false));
  });

  it('binds a model selection before sending a new session first message', async () => {
    vi.mocked(window.codeAgentDesktop.getModelCatalog).mockResolvedValueOnce({
      defaultModel: 'fixture-model',
      items: [{ modelAlias: 'alpha-pro', configured: true, availability: 'AVAILABLE' }]
    } as never);
    vi.mocked(window.codeAgentDesktop.patchSession).mockResolvedValueOnce({
      sessionId: 'session-new', sessionVersion: 2, modelAlias: 'alpha-pro'
    } as never);

    renderWorkbench(serviceCapabilities);
    await screen.findByText('Session A');
    screen.getByRole('button', { name: '新建会话…' }).click();
    await screen.findByTestId('new-session');
    screen.getByTestId('new-session-model-selector-trigger').click();
    const model = await screen.findByTestId('new-session-model-selector-select') as HTMLSelectElement;
    fireEvent.change(model, { target: { value: 'alpha-pro' } });
    fireEvent.change(screen.getByPlaceholderText('说说想做什么…'), { target: { value: 'Use the selected model' } });
    screen.getByRole('button', { name: '开始会话' }).click();

    await waitFor(() => expect(window.codeAgentDesktop.patchSession).toHaveBeenCalledWith(
      'session-new',
      expect.objectContaining({ expectedSessionVersion: 1, modelAlias: 'alpha-pro' })
    ));
    await waitFor(() => expect(sentMessages).toHaveLength(1));
    expect(sentMessages[0]?.body.expectedSessionVersion).toBe(2);
  });

  it('keeps an admitted session and restores the first message when sending times out', async () => {
    const send = vi.mocked(window.codeAgentDesktop.sendSessionMessage);
    send.mockRejectedValueOnce(new Error('The operation was aborted due to timeout'));

    renderWorkbench();
    await screen.findByText('Session A');
    screen.getByRole('button', { name: '新建会话…' }).click();
    fireEvent.change(screen.getByPlaceholderText('说说想做什么…'), { target: { value: '查看 ipconfig' } });
    screen.getByRole('button', { name: '开始会话' }).click();

    await screen.findByText(/发送超时，服务未接收该消息/);
    expect(screen.queryByText(/创建会话失败/)).toBeNull();
    expect((screen.getByPlaceholderText('输入消息…') as HTMLTextAreaElement).value).toBe('查看 ipconfig');
    expect(vi.mocked(window.codeAgentDesktop.createSession)).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(window.codeAgentDesktop.pageSessionMessages).toHaveBeenCalledWith(
      'session-new', expect.objectContaining({ limit: 50 })
    ));
  });

  it('reports a timed-out send as accepted when the history tail carries it', async () => {
    let capturedClientMessageId: string | undefined;
    vi.mocked(window.codeAgentDesktop.sendSessionMessage).mockImplementationOnce(
      async (_sessionId: string, body: SessionMessageRequest) => {
        capturedClientMessageId = body.clientMessageId;
        throw new Error('The operation was aborted due to timeout');
      });
    vi.mocked(window.codeAgentDesktop.pageSessionMessages).mockImplementation(
      async (sessionId: string) => ({
        schemaVersion: 'session-message-page/1',
        sessionId,
        transcriptRevision: '2',
        items: [{
          id: 'm-accepted', clientMessageId: capturedClientMessageId!, role: 'USER',
          status: 'QUEUED', createdAt: 1, updatedAt: 1, contentRevision: 'r1',
          content: 'x', contentState: 'INLINE', contentBytes: 1
        }],
        beforeCursor: null,
        afterCursor: null,
        hasOlder: false,
        hasNewer: false,
        rangeComplete: true
      }));

    renderWorkbench();
    await screen.findByText('Session A');
    screen.getByRole('button', { name: '新建会话…' }).click();
    fireEvent.change(screen.getByPlaceholderText('说说想做什么…'), { target: { value: '查看 ipconfig' } });
    screen.getByRole('button', { name: '开始会话' }).click();

    await screen.findByText(/服务已接收该消息，仍在处理中/);
    expect(screen.queryByText(/请重试/)).toBeNull();
  });

  it('does not label an admission timeout as a backend create failure', async () => {
    vi.mocked(window.codeAgentDesktop.createSession)
      .mockRejectedValueOnce(new Error('The operation was aborted due to timeout'));

    renderWorkbench();
    await screen.findByText('Session A');
    screen.getByRole('button', { name: '新建会话…' }).click();
    fireEvent.change(screen.getByPlaceholderText('说说想做什么…'), { target: { value: '查看 ipconfig' } });
    screen.getByRole('button', { name: '开始会话' }).click();

    await screen.findByText(/请求超时，服务可能仍在处理/);
    expect(screen.queryByText(/创建会话失败/)).toBeNull();
  });

});

describe('composer action button (send/stop merged)', () => {
  it('shows one stop button instead of send while a run is active', async () => {
    renderWorkbench();
    await screen.findByText('Session A');
    screen.getByRole('button', { name: /Session A/ }).click();
    await screen.findByText('message for session A');

    expect(screen.queryByRole('button', { name: '发送' })).toBeNull();
    screen.getByRole('button', { name: '停止生成' }).click();
    await waitFor(() => expect(governanceCalls.some((c) => c.kind === 'interrupt')).toBe(true));
    const interrupt = governanceCalls.find((c) => c.kind === 'interrupt');
    expect(interrupt?.body.runId).toBe('run-1');
    expect(interrupt?.body.expectedStateVersion).toBe(4);
  });

  it('returns to the send button when no run is active', async () => {
    fakeRuns.length = 0;
    renderWorkbench();
    await screen.findByText('Session A');
    screen.getByRole('button', { name: /Session A/ }).click();
    await screen.findByText('message for session A');
    expect(screen.getByRole('button', { name: '发送' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '停止生成' })).toBeNull();
  });
});

describe('conversation auto-scroll', () => {
  it('jumps to the newest message when a conversation opens', async () => {
    // jsdom has no layout: pin scrollHeight/clientHeight so the pinned scroll
    // target is observable via scrollTop.
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', { configurable: true, value: 1500 });
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, value: 500 });
    try {
      renderWorkbench();
      await screen.findByText('Session B');
      screen.getByRole('button', { name: /Session B/ }).click();
      await screen.findByText('message for session B');
      const container = document.querySelector('.conversation-scroll') as HTMLElement | null;
      expect(container).toBeTruthy();
      expect(container?.scrollTop).toBe(1500);
    } finally {
      delete (HTMLElement.prototype as unknown as Record<string, unknown>).scrollHeight;
      delete (HTMLElement.prototype as unknown as Record<string, unknown>).clientHeight;
    }
  });
});

describe('design inspiration 2026-09-03 (hero entry + rich rows)', () => {
  it('shows the last message preview in the session row', async () => {
    renderWorkbench();
    await screen.findByText('Session A');
    // The rail row now surfaces the last list-view message as a preview
    // (combined with the status label when the session needs attention);
    // the open conversation still owns the full transcript.
    const rail = document.querySelector('#workspace-nav') as HTMLElement;
    expect(within(rail).getByText(/message for session A/)).toBeTruthy();
  });

});

describe('sidebar navigation sections', () => {
  it('pins sessions, lists each session once, and collapses each level', async () => {
    renderWorkbench();
    await screen.findByText('Session A');

    const rail = screen.getByRole('complementary', { name: '会话栏' });
    const pinnedSection = within(rail).getByTestId('sidebar-section-pinned');
    const projectsSection = within(rail).getByTestId('sidebar-section-projects');

    // Design 2026-09-30 §5.1: a session appears in exactly one rail list.
    expect(within(rail).getAllByRole('button', { name: /Session A/ })).toHaveLength(1);
    expect(within(rail).queryByTestId('sidebar-section-recent')).toBeNull();

    const sessionA = within(projectsSection).getByRole('button', { name: /Session A/ });
    const pinButton = within(sessionA.parentElement as HTMLElement).getByRole('button', { name: '置顶' });
    fireEvent.click(pinButton);
    expect(within(pinnedSection).getByText('Session A')).toBeTruthy();
    expect(within(projectsSection).queryByText('Session A')).toBeNull();

    const pinnedToggle = within(pinnedSection).getByRole('button', { name: /^置顶/ });
    fireEvent.click(pinnedToggle);
    expect(pinnedToggle.getAttribute('aria-expanded')).toBe('false');
    expect(within(pinnedSection).queryByText('Session A')).toBeNull();

    const projectToggle = projectsSection.querySelector('.rail-section-heading') as HTMLButtonElement;
    fireEvent.click(projectToggle);
    expect(projectToggle.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(projectToggle);
    expect(projectToggle.getAttribute('aria-expanded')).toBe('true');
    // The seeded state leaves the fixture group expanded; toggling collapses
    // it and toggling again re-expands it.
    const projectRow = projectsSection.querySelector('.project-row-toggle') as HTMLButtonElement;
    expect(projectRow.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(projectRow);
    expect(projectRow.getAttribute('aria-expanded')).toBe('false');
    expect(within(projectsSection).queryByText('Session B')).toBeNull();
    fireEvent.click(projectRow);
    expect(projectRow.getAttribute('aria-expanded')).toBe('true');
    expect(within(projectsSection).getByText('Session B')).toBeTruthy();
  });

  it('groups workspace-less sessions under 普通对话', async () => {
    sessions.push({
      sessionId: 'session-ccc', sessionVersion: 1, title: 'Chat C', workspaceAlias: '',
      status: 'ACTIVE', updatedAt: Date.now(),
      messages: [{ id: 'mc', role: 'user', content: 'plain chat message' }]
    });
    try {
      renderWorkbench();
      await screen.findByText('Session A');
      const rail = screen.getByRole('complementary', { name: '会话栏' });
      const chats = within(rail).getByTestId('sidebar-section-chats');
      const chatsToggle = chats.querySelector('.project-row-toggle') as HTMLButtonElement;
      if (chatsToggle.getAttribute('aria-expanded') !== 'true') fireEvent.click(chatsToggle);
      expect(within(chats).getByText('Chat C')).toBeTruthy();
    } finally {
      sessions.splice(sessions.findIndex((session) => session.sessionId === 'session-ccc'), 1);
    }
  });

  it('switches to the recency view, groups by day, and keeps the choice across renders', async () => {
    renderWorkbench();
    await screen.findByText('Session A');
    const rail = screen.getByRole('complementary', { name: '会话栏' });

    // U7.2: the 按项目/按时间 toggle lives inside the ⋯ rail menu now.
    fireEvent.click(within(rail).getByRole('button', { name: '更多会话栏操作' }));
    fireEvent.click(within(rail).getByRole('radio', { name: '按时间' }));
    const recentSection = within(rail).getByTestId('sidebar-section-recent');
    expect(within(rail).queryByTestId('sidebar-section-projects')).toBeNull();
    expect(within(recentSection).getByText('今天')).toBeTruthy();
    expect(within(recentSection).getByText('近 7 天')).toBeTruthy();
    // Each session still appears exactly once, now under a day group.
    expect(within(rail).getAllByRole('button', { name: /Session A/ })).toHaveLength(1);
    expect(within(rail).getAllByRole('button', { name: /Session B/ })).toHaveLength(1);

    await waitFor(() => expect(window.localStorage.getItem(SIDEBAR_NAV_STORAGE_KEY)).toContain('RECENT'));
    cleanup();
    renderWorkbench();
    const railAgain = screen.getByRole('complementary', { name: '会话栏' });
    expect(within(railAgain).getByTestId('sidebar-section-recent')).toBeTruthy();
    fireEvent.click(within(railAgain).getByRole('button', { name: '更多会话栏操作' }));
    expect(within(railAgain).getByRole('radio', { name: '按时间' }).getAttribute('aria-checked')).toBe('true');
  });

  it('pins the surface nav to an icon row at the rail bottom', async () => {
    renderWorkbench();
    await screen.findByText('Session A');
    const nav = document.querySelector('.rail-nav-bottom');
    expect(nav).not.toBeNull();
    for (const label of ['会话', 'Git', '设置']) {
      expect(within(nav as HTMLElement).getByRole('button', { name: label })).toBeTruthy();
    }
  });

  it('disambiguates duplicate titles with run status or relative time', async () => {
    sessions.push({
      sessionId: 'session-ccc', sessionVersion: 1, title: 'Session A', workspaceAlias: 'sample',
      status: 'ACTIVE', updatedAt: Date.now() - 86_400_000,
      messages: []
    });
    try {
      renderWorkbench();
      await screen.findByText('Session B');
      const rail = screen.getByRole('complementary', { name: '会话栏' });
      const rows = within(rail).getAllByRole('button', { name: /Session A/ });
      expect(rows.length).toBeGreaterThanOrEqual(2);
      // session-aaa owns a RUNNING run → status phrase; session-ccc has no
      // run → falls back to the relative time.
      const subtitles = rows.map((row) => row.querySelector('.session-row-subtitle')?.textContent ?? '');
      expect(subtitles.some((text) => text.includes('执行中'))).toBe(true);
      expect(subtitles.some((text) => text.includes('1 天'))).toBe(true);
    } finally {
      sessions.pop();
    }
  });
});
