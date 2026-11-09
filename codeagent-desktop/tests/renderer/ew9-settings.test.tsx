// @vitest-environment jsdom
/**
 * EW9 acceptance, Settings Center edition (settings design SET-1/SET-5).
 * The old EW9 panel is gone: policy precedence lives on the Permissions
 * page, product settings use a section draft with one explicit Save per
 * revision, and pending knowledge is never presented as a fact.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Workbench } from '../../src/renderer/app/App';

let policyLayers: { layers: Array<{ layer: string; maximumAutonomy?: string; revision?: number }>; effectiveMaximumAutonomy: string };
let settings: Record<string, unknown>;
let knowledge: { items: Array<{ knowledgeId: string; status: string; content: string }>; facts: Array<{ knowledgeId: string }> };
const settingsUpdateCalls: Array<Record<string, unknown>> = [];
const confirmCalls: string[] = [];

function resetFixtures(): void {
  policyLayers = {
    layers: [
      { layer: 'MANAGED', maximumAutonomy: 'MEDIUM', revision: 0 },
      { layer: 'PROJECT', revision: 0 },
      { layer: 'USER', revision: 0 }
    ],
    effectiveMaximumAutonomy: 'MEDIUM'
  };
  settings = { revision: 1, traceExportEnabled: false, localOnly: true, eventJournalRetentionDays: 30, telemetryMinimal: true };
  knowledge = {
    items: [{ knowledgeId: 'kn-1', status: 'PENDING', content: 'prefer constructor injection' }],
    facts: []
  };
  settingsUpdateCalls.length = 0;
  confirmCalls.length = 0;
}

function desktopPreferencesFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
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
    restoreLastSurface: false,
    ...overrides
  };
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
      getSession: vi.fn(async () => sessions[0]),
      createSession: vi.fn(),
      patchSession: vi.fn(),
      sendSessionMessage: vi.fn(),
      forkSession: vi.fn(),
      archiveSession: vi.fn(),
      listRuns: vi.fn(async () => ({ items: [] })),
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
      getRunDiff: vi.fn(),
      getRunReview: vi.fn(),
      getRunEvidence: vi.fn(),
      createFixTask: vi.fn(),
      revealProjectFile: vi.fn(),
      listWorkspaceExecutions: vi.fn(async () => ({ projectId: 'sample', items: [] })),
      createWorkspaceExecution: vi.fn(),
      handoffWorkspaceExecution: vi.fn(),
      reclaimWorkspaceExecution: vi.fn(),
      listMissions: vi.fn(async () => []),
      getMission: vi.fn(),
      createMission: vi.fn(),
      decideMissionApproval: vi.fn(),
      startMission: vi.fn(),
      pauseMission: vi.fn(),
      resumeMission: vi.fn(),
      cancelMission: vi.fn(),
      listPolicyLayers: vi.fn(async () => policyLayers),
      updatePolicyLayer: vi.fn(),
      getProductSettings: vi.fn(async () => ({ ...settings })),
      updateProductSettings: vi.fn(async (body: Record<string, unknown>) => {
        // Emulate the Service: a stale expectedRevision is rejected before
        // anything is written, so the draft survives untouched.
        if (body.expectedRevision !== settings.revision) {
          throw new Error('STATE_VERSION_CONFLICT: settings were updated elsewhere');
        }
        settingsUpdateCalls.push(body);
        settings = { ...settings, ...body, revision: (settings.revision as number) + 1 };
        return { ...settings };
      }),
      listKnowledge: vi.fn(async () => JSON.parse(JSON.stringify(knowledge))),
      suggestKnowledge: vi.fn(),
      confirmKnowledge: vi.fn(async (knowledgeId: string) => {
        confirmCalls.push(knowledgeId);
        knowledge = {
          items: knowledge.items.map((i) => i.knowledgeId === knowledgeId ? { ...i, status: 'CONFIRMED' } : i),
          facts: [{ knowledgeId }]
        };
        return { knowledgeId, status: 'CONFIRMED' };
      }),
      getDesktopPreferences: vi.fn(async () => desktopPreferencesFixture()),
      updateDesktopPreferences: vi.fn(async (body: Record<string, unknown>) => desktopPreferencesFixture({ revision: 2, ...body })),
      getModelCatalog: vi.fn(async () => ({ items: [] })),
      revealDiagnosticsFolder: vi.fn(async () => ({ revealed: true })),
      copyDiagnostics: vi.fn(async () => ({ copied: true, bytes: 64 })),
      getAboutInfo: vi.fn(async () => ({ desktopVersion: '0.0.1', electronVersion: '44.0.0', chromeVersion: '130', nodeVersion: '24' })),
      onDurableEvents: vi.fn(() => () => undefined),
      onEventStatus: vi.fn(() => () => undefined)
    }
  });
}

const sessions = [
  { sessionId: 'session-aaa', sessionVersion: 1, title: 'Session A', workspaceAlias: 'sample', status: 'ACTIVE', messages: [] }
];

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

function openSettingsCategory(label: string): void {
  fireEvent.click(screen.getByRole('button', { name: '设置' }));
  fireEvent.click(screen.getByRole('button', { name: label }));
}

beforeEach(() => {
  resetFixtures();
  installFakeApi();
});

afterEach(() => {
  cleanup();
});

describe('product governance in the Settings Center (EW9)', () => {
  it('shows the policy precedence with the managed ceiling and effective value on the Permissions page', async () => {
    renderWorkbench();
    openSettingsCategory('权限');
    await screen.findByTestId('policy-layer-MANAGED');
    const page = screen.getByTestId('permissions-section');
    expect(page.textContent).toContain('PROJECT');
    expect(page.textContent).toContain('USER');
    expect(screen.getByTestId('policy-effective').textContent).toContain('范围内推进');
    // Managed is locked: no select control on the managed row.
    expect(screen.queryByTestId('policy-select-MANAGED')).toBeNull();
    // The current Service capability is not wired for automation controls;
    // settings must state that explicitly instead of rendering fake buttons.
    expect(screen.getByTestId('automation-controls-section').textContent).toContain('调度控制暂不可用');
  });

  it('drafts privacy changes and saves them once with the optimistic revision', async () => {
    renderWorkbench();
    openSettingsCategory('隐私与证据');
    const toggle = await screen.findByTestId('settings-local-only-toggle');
    await waitFor(() => expect((toggle as HTMLInputElement).disabled).toBe(false));
    // Draft first: flipping the toggle must not submit anything.
    fireEvent.click(toggle);
    expect(settingsUpdateCalls.length).toBe(0);
    expect((screen.getByTestId('settings-save') as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByTestId('settings-save'));
    await waitFor(() => expect(settingsUpdateCalls.length).toBe(1));
    expect(settingsUpdateCalls[0]?.localOnly).toBe(false);
    expect(settingsUpdateCalls[0]?.expectedRevision).toBe(1);
    expect(await screen.findByText('已保存 · 立即生效')).toBeDefined();
  });

  it('keeps the draft and shows the conflict panel when the revision moved', async () => {
    renderWorkbench();
    openSettingsCategory('隐私与证据');
    const toggle = await screen.findByTestId('settings-local-only-toggle');
    await waitFor(() => expect((toggle as HTMLInputElement).disabled).toBe(false));
    fireEvent.click(toggle);
    // Simulate an external save between the draft and our Save click.
    settings = { ...settings, revision: 5, localOnly: false };
    fireEvent.click(screen.getByTestId('settings-save'));
    await screen.findByTestId('settings-conflict');
    // The Service rejected the stale revision; nothing was written and the
    // draft is kept, not silently overwritten.
    expect(settingsUpdateCalls.length).toBe(0);
    expect((screen.getByTestId('settings-local-only-toggle') as HTMLInputElement).checked).toBe(false);
    // Reloading adopts the server state and clears the conflict.
    fireEvent.click(screen.getByTestId('settings-conflict-reload'));
    await waitFor(() => expect(screen.queryByTestId('settings-conflict')).toBeNull());
    await waitFor(() => expect((screen.getByTestId('settings-local-only-toggle') as HTMLInputElement).checked).toBe(false));
  });

  it('renders pending knowledge as a non-fact and confirms it explicitly', async () => {
    renderWorkbench();
    openSettingsCategory('知识');
    await screen.findByTestId('knowledge-item-PENDING');
    const list = screen.getByTestId('knowledge-list');
    expect(list.textContent).toContain('待确认 · 不是事实');
    expect(list.textContent).toContain('prefer constructor injection');
    expect(screen.getByTestId('knowledge-facts-count').textContent).toContain('0 条');

    fireEvent.click(screen.getByTestId('knowledge-confirm-kn-1'));
    await waitFor(() => expect(confirmCalls).toEqual(['kn-1']));
    await screen.findByText(/1 条/);
  });
});
