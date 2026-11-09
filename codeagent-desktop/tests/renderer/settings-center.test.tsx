// @vitest-environment jsdom
/**
 * Settings Center shell acceptance (settings design SET-1/SET-2/SET-3).
 * Covers: route navigation + search, no-session usability, offline
 * degradation of Service-owned pages while Desktop-owned pages stay
 * editable, appearance draft preview/reset, and the session model editor
 * with safe-boundary feedback and authoritative response adoption.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Workbench } from '../../src/renderer/app/App';

let preferences: Record<string, unknown>;
let durableListener: ((frames: Array<{ cursor: number; type: string; payload: unknown }>) => void) | null = null;
let catalogItems: Array<Record<string, unknown>>;
let sessionRecord: Record<string, unknown>;
const preferenceUpdateCalls: Array<Record<string, unknown>> = [];
const patchSessionCalls: Array<Record<string, unknown>> = [];

function resetFixtures(): void {
  preferences = {
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
  };
  catalogItems = [
    {
      modelAlias: 'alpha-pro',
      providerDisplayName: 'Test Provider',
      configured: true,
      availability: 'AVAILABLE',
      routePolicyName: 'default',
      maxContextLevel: 'L2',
      contextTokenOptions: [32768, 64000],
      capabilities: ['chat', 'IMAGE_INPUT'],
      reasoningEffortOptions: ['low', 'high']
    },
    {
      modelAlias: 'alpha-mini',
      configured: false,
      availability: 'UNCONFIGURED',
      routePolicyName: 'default'
    }
  ];
  sessionRecord = {
    sessionId: 'session-aaa',
    sessionVersion: 3,
    title: 'Session A',
    workspaceAlias: 'sample',
    status: 'ACTIVE',
    modelAlias: null,
    writeAllow: [],
    writeForbid: [],
    messages: []
  };
  preferenceUpdateCalls.length = 0;
  durableListener = null;
  patchSessionCalls.length = 0;
}

function installFakeApi(overrides: {
  serviceConnected?: boolean;
  activeRun?: boolean;
} = {}): void {
  const serviceError = { error: 'service is not connected', code: 'SERVICE_NOT_CONNECTED' };
  const ok = <T,>(value: T): T | typeof serviceError => (overrides.serviceConnected === false ? serviceError : value);
  Object.defineProperty(window, 'codeAgentDesktop', {
    configurable: true,
    value: {
      bootstrap: vi.fn(async () => ({ status: 'OWNED_READY' })),
      openExternalHttps: vi.fn(),
      restartService: vi.fn(),
      serviceStatus: vi.fn(async () => ok({ state: 'OWNED_READY', serviceInstanceId: 'instance-abc123', ownedPid: 4321, ownedPort: 8765, encryptionAvailable: true, tokenPersisted: true, scheduler: {
        schemaVersion: 'business-scheduler-overview/1', schedulerMode: 'DEGRADED', recoveryBarrier: 'OPEN',
        activeRuns: 1, maxActiveRuns: 2, queuedRuns: 3,
        resourcePools: [{ type: 'RUN_EXECUTION_SLOT', used: 1, limit: 2 }]
      } })),
      chooseAndRegisterProject: vi.fn(),
      diagnostics: vi.fn(async () => ok({ serviceState: 'OWNED_READY', ownedProcess: { pid: 4321, port: 8765, nonce: 'n' }, logLocation: 'C:\\userData', encryptionAvailable: true })),
      listProjects: vi.fn(async () => ok([
        { projectId: 'sample', workspaceAlias: 'sample', displayName: 'Petclinic', authorityStatus: 'AVAILABLE' }
      ])),
      listSessions: vi.fn(async () => ok([sessionRecord])),
      getSession: vi.fn(async () => ok({ ...sessionRecord })),
      createSession: vi.fn(),
      patchSession: vi.fn(async (_sessionId: string, body: Record<string, unknown>) => {
        patchSessionCalls.push(body);
        if (body.expectedSessionVersion !== sessionRecord.sessionVersion) {
          throw new Error('STATE_VERSION_CONFLICT: session moved');
        }
        sessionRecord = { ...sessionRecord, ...body, sessionVersion: (sessionRecord.sessionVersion as number) + 1 };
        return { ...sessionRecord };
      }),
      sendSessionMessage: vi.fn(),
      forkSession: vi.fn(),
      archiveSession: vi.fn(),
      listRuns: vi.fn(async () => ok({
        items: overrides.activeRun
          ? [{ runId: 'run-1', taskId: 'task-1', state: 'RUNNING', stateVersion: 1, sessionId: 'session-aaa', workspaceAlias: 'sample', reasonCode: 'CAPACITY', scheduling: { primaryReason: 'CAPACITY' } }]
          : []
      })),
      listAttention: vi.fn(async () => ok({ items: [] })),
      createSpec: vi.fn(),
      getSpec: vi.fn(),
      reviseSpec: vi.fn(),
      decideSpecApproval: vi.fn(),
      convertSpecToAct: vi.fn(),
      decideCommandApproval: vi.fn(),
      decideBudgetApproval: vi.fn(),
      cancelRun: vi.fn(),
      interruptRun: vi.fn(),
      getRunDiff: vi.fn(),
      getRunReview: vi.fn(),
      getRunEvidence: vi.fn(),
      createFixTask: vi.fn(),
      revealProjectFile: vi.fn(),
      listWorkspaceExecutions: vi.fn(async () => ok({ projectId: 'sample', items: [] })),
      createWorkspaceExecution: vi.fn(),
      handoffWorkspaceExecution: vi.fn(),
      reclaimWorkspaceExecution: vi.fn(),
      listMissions: vi.fn(async () => ok([])),
      getMission: vi.fn(),
      createMission: vi.fn(),
      decideMissionApproval: vi.fn(),
      startMission: vi.fn(),
      pauseMission: vi.fn(),
      resumeMission: vi.fn(),
      cancelMission: vi.fn(),
      listPolicyLayers: vi.fn(async () => ok({
        layers: [
          { layer: 'MANAGED', maximumAutonomy: 'MEDIUM', revision: 0 },
          { layer: 'PROJECT', maximumAutonomy: 'LOW', revision: 2 },
          { layer: 'USER', maximumAutonomy: null, revision: 1 }
        ],
        effectiveMaximumAutonomy: 'LOW'
      })),
      updatePolicyLayer: vi.fn(),
      getProductSettings: vi.fn(async () => ok({
        revision: 1, traceExportEnabled: false, localOnly: true, eventJournalRetentionDays: 30, telemetryMinimal: true
      })),
      updateProductSettings: vi.fn(),
      listKnowledge: vi.fn(async () => ok({ items: [], facts: [] })),
      suggestKnowledge: vi.fn(),
      confirmKnowledge: vi.fn(),
      getDesktopPreferences: vi.fn(async () => JSON.parse(JSON.stringify(preferences))),
      updateDesktopPreferences: vi.fn(async (body: Record<string, unknown>) => {
        if (body.expectedRevision !== preferences.revision) {
          throw new Error('STATE_VERSION_CONFLICT: preferences moved');
        }
        preferenceUpdateCalls.push(body);
        preferences = { ...preferences, ...body, revision: (preferences.revision as number) + 1 };
        return JSON.parse(JSON.stringify(preferences));
      }),
      getModelCatalog: vi.fn(async () => ok({ defaultModel: 'alpha-pro', items: JSON.parse(JSON.stringify(catalogItems)) })),
      revealDiagnosticsFolder: vi.fn(async () => ({ revealed: true })),
      copyDiagnostics: vi.fn(async () => ({ copied: true, bytes: 128 })),
      getAboutInfo: vi.fn(async () => ({ desktopVersion: '0.0.1', electronVersion: '44.0.0', chromeVersion: '130', nodeVersion: '24' })),
      onDurableEvents: vi.fn((listener: (frames: Array<{ cursor: number; type: string; payload: unknown }>) => void) => { durableListener = listener; return () => undefined; }),
      onEventStatus: vi.fn(() => () => undefined)
    }
  });
}

const SIDEBAR_NAV_STORAGE_KEY = 'business-agent-desktop.sidebar-navigation.v1';

function renderWorkbench(capabilities?: Record<string, unknown>): void {
  // Same seed as workbench.test.tsx: the fixture session's project group
  // must be expanded for the rows to be reachable (design §5.1 defaults
  // unselected groups to collapsed).
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
      <Workbench
        {...(capabilities ? { capabilities: capabilities as never } : {})}
        protocolVersion="v2"
      />
    </QueryClientProvider>
  );
}

const capabilities = {
  serviceInstanceId: 'instance-abc123',
  compatible: true,
  features: {
    sessionV2: true, durableEvents: true, visibleOutputStream: true, worktreeExecution: true,
    mission: true, mcpHost: true, servicePty: true, readOnlySources: true,
    mcpReadOnlySource: true, skillsCatalog: true, hooks: true, readOnlySubagent: false
  },
  limits: { maxDiffBytes: 1024, maxEventPage: 100, maxVisibleDeltaChars: 8192 },
  operations: [
    { id: 'settings.manage', availability: 'AVAILABLE', contractVersion: 'v2' },
    { id: 'knowledge.manage', availability: 'AVAILABLE', contractVersion: 'v2' },
    { id: 'terminal.session.create', availability: 'AVAILABLE', contractVersion: 'v2' }
  ]
};

function openSettings(): void {
  fireEvent.click(screen.getByRole('button', { name: '设置' }));
}

beforeEach(() => {
  resetFixtures();
  installFakeApi();
});

afterEach(() => {
  cleanup();
  window.localStorage.removeItem(SIDEBAR_NAV_STORAGE_KEY);
});

describe('settings center shell (SET-1)', () => {
  it('opens without a selected session and renders the overview scope bar', async () => {
    renderWorkbench(capabilities);
    openSettings();
    expect(await screen.findByTestId('settings-center')).toBeDefined();
    expect(screen.getByTestId('settings-scope-bar').textContent).toContain('未选择会话');
    await screen.findByTestId('overview-card-service');
    expect(screen.getByTestId('overview-card-model').textContent).toContain('1 个模型可用');
  });

  it('renders the scheduler authority section and keeps missing fields unknown', async () => {
    renderWorkbench(capabilities);
    openSettings();
    expect(await screen.findByTestId('overview-scheduler')).toBeDefined();
    expect(screen.getByTestId('scheduler-mode')).toBeDefined();
    expect(screen.getByTestId('scheduler-active')).toBeDefined();
    expect(screen.getByTestId('scheduler-queued')).toBeDefined();
    expect(screen.getByTestId('scheduler-recovery')).toBeDefined();
  });

  it('hides the session rail on the settings surface and groups the nav into four sections', async () => {
    renderWorkbench(capabilities);
    openSettings();
    await screen.findByTestId('settings-center');
    // §10.1 (S3): the surface class drives `display:none` on .session-rail
    // via styles.css (jsdom does not apply stylesheets).
    expect(document.querySelector('.workbench.surface-settings')).not.toBeNull();
    // §10.4 (S8): four group headings over unchanged route ids.
    const nav = screen.getByTestId('settings-nav');
    for (const label of ['常用', '权限与数据', '能力', '高级']) {
      expect(nav.textContent).toContain(label);
    }
    // §10.1: ← 返回 shares the 完成 dirty guard (clean state exits immediately).
    fireEvent.click(screen.getByTestId('settings-back'));
    expect(screen.queryByTestId('settings-center')).toBeNull();
  });

  it('links the Extensions page back to Features & Environment for MCP/Skills enablement', async () => {
    renderWorkbench(capabilities);
    openSettings();
    await screen.findByTestId('settings-center');
    fireEvent.click(screen.getByRole('button', { name: '扩展' }));
    await screen.findByTestId('extensions-section');
    fireEvent.click(screen.getByTestId('extensions-open-features'));
    await screen.findByTestId('features-section');
  });

  it('navigates between categories via the nav and via local search', async () => {
    renderWorkbench(capabilities);
    openSettings();
    await screen.findByTestId('settings-center');
    fireEvent.click(screen.getByRole('button', { name: '隐私与证据' }));
    await screen.findByTestId('privacy-section');
    // Search matches public metadata only.
    const search = screen.getByTestId('settings-search');
    fireEvent.change(search, { target: { value: 'trace' } });
    const results = await screen.findByTestId('settings-search-results');
    expect(results.textContent).toContain('隐私与证据');
    fireEvent.click(results.querySelector('button') as HTMLButtonElement);
    await screen.findByTestId('privacy-section');
  });

  it('keeps Desktop-owned pages editable while Service-owned pages degrade offline', async () => {
    cleanup();
    installFakeApi({ serviceConnected: false });
    renderWorkbench(capabilities);
    openSettings();
    // Service-owned privacy page: typed unavailable state, no fake values.
    fireEvent.click(screen.getByRole('button', { name: '隐私与证据' }));
    const unavailable = await screen.findByTestId('settings-unavailable');
    expect(unavailable.textContent).toContain('Service 未连接');
    // Desktop-owned appearance page still renders and saves.
    fireEvent.click(screen.getByRole('button', { name: '外观' }));
    const themeSelect = await screen.findByTestId('appearance-theme-select');
    fireEvent.change(themeSelect, { target: { value: 'DARK' } });
    fireEvent.click(screen.getByTestId('appearance-density-select'));
    fireEvent.change(screen.getByTestId('appearance-density-select'), { target: { value: 'DETAILED' } });
    fireEvent.click(screen.getByTestId('settings-save'));
    await waitFor(() => expect(preferenceUpdateCalls.length).toBe(1));
    expect(preferenceUpdateCalls[0]?.density).toBe('DETAILED');
  });
});

describe('appearance page (SET-2)', () => {
  it('previews the draft instantly and resets to defaults before saving', async () => {
    renderWorkbench(capabilities);
    openSettings();
    fireEvent.click(screen.getByRole('button', { name: '外观' }));
    await screen.findByTestId('appearance-section');
    await screen.findByTestId('appearance-section');
    fireEvent.change(screen.getByTestId('appearance-density-select'), { target: { value: 'DETAILED' } });
    // Preview is applied on the workbench root without a save.
    await waitFor(() => expect(document.querySelector('.workbench')?.classList.contains('density-detailed')).toBe(true));
    expect(preferenceUpdateCalls.length).toBe(0);
    fireEvent.click(screen.getByTestId('appearance-reset'));
    await waitFor(() => expect(document.querySelector('.workbench')?.classList.contains('density-standard')).toBe(true));
    // Reset restored defaults that equal the base: nothing dirty, so the
    // review bar hides itself and no save is issued.
    await waitFor(() => expect(screen.queryByTestId('settings-save')).toBeNull());
    expect(preferenceUpdateCalls.length).toBe(0);
  });

  it('persists density through the Main preferences mutation with the expected revision', async () => {
    renderWorkbench(capabilities);
    openSettings();
    fireEvent.click(screen.getByRole('button', { name: '外观' }));
    await screen.findByTestId('appearance-section');
    fireEvent.change(screen.getByTestId('appearance-density-select'), { target: { value: 'SUMMARY' } });
    fireEvent.click(screen.getByTestId('settings-save'));
    await waitFor(() => expect(preferenceUpdateCalls.length).toBe(1));
    expect(preferenceUpdateCalls[0]?.expectedRevision).toBe(1);
    expect(preferenceUpdateCalls[0]?.density).toBe('SUMMARY');
  });
});

describe('models page (SET-3)', () => {
  it('shows catalog availability without secrets and offers unconfigured guidance', async () => {
    renderWorkbench(capabilities);
    openSettings();
    fireEvent.click(screen.getByRole('button', { name: 'Agent 与模型' }));
    await screen.findByTestId('model-entry-alpha-pro');
    const page = screen.getByTestId('models-section');
    expect(page.textContent).toContain('alpha-pro');
    expect(page.textContent).toContain('尚未配置');
    expect(page.textContent).toContain('Desktop 不会读取或保存模型密钥');
    // No API key / base URL / env names anywhere in the projection.
    expect(page.textContent.toLowerCase()).not.toContain('apikey');
    expect(page.textContent.toLowerCase()).not.toContain('baseurl');
  });

  it('edits the current session model with expectedSessionVersion and adopts the response', async () => {
    renderWorkbench(capabilities);
    await screen.findByRole('button', { name: /Session A/ });
    fireEvent.click(screen.getByRole('button', { name: /Session A/ }));
    openSettings();
    fireEvent.click(screen.getByRole('button', { name: 'Agent 与模型' }));
    const select = await screen.findByTestId('session-model-select');
    await waitFor(() => expect((select as HTMLSelectElement).disabled).toBe(false));
    fireEvent.change(select, { target: { value: 'alpha-pro' } });
    fireEvent.click(screen.getByTestId('settings-save'));
    await waitFor(() => expect(patchSessionCalls.length).toBe(1));
    expect(patchSessionCalls[0]?.expectedSessionVersion).toBe(3);
    expect(patchSessionCalls[0]?.modelAlias).toBe('alpha-pro');
    expect(patchSessionCalls[0]?.modelSettings).toMatchObject({
      contextMode: 'AUTO',
      contextPresetId: null,
      reasoningMode: 'DEFAULT',
      outputMode: 'AUTO'
    });
    // Success feedback comes from the authoritative response adoption.
    expect(await screen.findByText('已保存 · 下一个安全请求生效')).toBeDefined();
  });

  it('offers only catalog presets for reasoning and context', async () => {
    renderWorkbench(capabilities);
    await screen.findByRole('button', { name: /Session A/ });
    fireEvent.click(screen.getByRole('button', { name: /Session A/ }));
    openSettings();
    fireEvent.click(screen.getByRole('button', { name: 'Agent 与模型' }));
    await screen.findByTestId('session-context-mode');
    expect(screen.queryByTestId('session-reasoning-budget')).toBeNull();
    expect(screen.queryByTestId('session-context-budget')).toBeNull();
    expect(screen.queryByTestId('session-output-edit')).toBeNull();
    expect(screen.getByTestId('model-entry-alpha-pro').textContent).toContain('上下文选项：32.8K、64K');
    expect(screen.getByTestId('model-entry-alpha-pro').textContent).toContain('图片理解');
  });

  it('sends the selected context preset and never a hand-entered cap', async () => {
    renderWorkbench(capabilities);
    await screen.findByRole('button', { name: /Session A/ });
    fireEvent.click(screen.getByRole('button', { name: /Session A/ }));
    openSettings();
    fireEvent.click(screen.getByRole('button', { name: 'Agent 与模型' }));
    const context = await screen.findByTestId('session-context-mode');
    fireEvent.change(context, { target: { value: 'PRESET:64000' } });
    fireEvent.click(screen.getByTestId('settings-save'));
    await waitFor(() => expect(patchSessionCalls.length).toBe(1));
    expect(patchSessionCalls[0]?.modelSettings).toMatchObject({
      contextMode: 'PRESET',
      contextPresetId: '64000',
      contextMaxTokens: null,
      reasoningBudgetTokens: null,
      outputMaxTokens: null
    });
  });

  it('keeps the session model editable while a run is active', async () => {
    cleanup();
    installFakeApi({ activeRun: true });
    renderWorkbench(capabilities);
    await screen.findByRole('button', { name: /Session A/ });
    fireEvent.click(screen.getByRole('button', { name: /Session A/ }));
    openSettings();
    fireEvent.click(screen.getByRole('button', { name: 'Agent 与模型' }));
    await screen.findByTestId('session-model-locked');
    expect((screen.getByTestId('session-model-select') as HTMLSelectElement).disabled).toBe(false);
  });
});

describe('durable event invalidation (SET-5)', () => {
  it('refetches only the product settings query on settings.updated', async () => {
    renderWorkbench(capabilities);
    openSettings();
    fireEvent.click(screen.getByRole('button', { name: '隐私与证据' }));
    await screen.findByTestId('privacy-section');
    const productCalls = vi.mocked(window.codeAgentDesktop.getProductSettings).mock.calls.length;
    const knowledgeCalls = vi.mocked(window.codeAgentDesktop.listKnowledge).mock.calls.length;
    durableListener?.([{ cursor: 1, type: 'settings.updated', payload: { revision: 2, changedFields: ['localOnly'] } }]);
    await waitFor(() => expect(vi.mocked(window.codeAgentDesktop.getProductSettings).mock.calls.length).toBeGreaterThan(productCalls));
    // Unrelated queries must not fan out (§8.2: no invalidation storm).
    expect(vi.mocked(window.codeAgentDesktop.listKnowledge).mock.calls.length).toBe(knowledgeCalls);
  });
});

describe('advanced pages (SET-4 projection)', () => {
  it('shows service state and token persistence without exposing the token', async () => {
    renderWorkbench(capabilities);
    openSettings();
    fireEvent.click(screen.getByRole('button', { name: 'Service' }));
    await screen.findByTestId('service-state');
    const page = screen.getByTestId('service-section');
    expect(page.textContent).toContain('owned（桌面托管）');
    expect(page.textContent).toContain('OS 加密存储');
    expect(screen.getByTestId('service-restart')).toBeDefined();
  });

  it('projects runtime capabilities from declared operations and marks undeclared groups unknown', async () => {
    renderWorkbench(capabilities);
    openSettings();
    fireEvent.click(screen.getByRole('button', { name: '运行时' }));
    await screen.findByTestId('runtime-section');
    const page = screen.getByTestId('runtime-section');
    expect(page.textContent).toContain('terminal.session.create');
    // Java semantic operations were not declared → fail closed to unknown.
    expect(page.textContent).toContain('未知（未声明）');
  });
});
