// @vitest-environment jsdom
/**
 * Environment feature cards + managed model catalog acceptance.
 * Covers: the four-state readiness badge, installation projection,
 * desired/effective toggle with expectedRevision, typed actions
 * (RECHECK/COPY_TEXT/RESTART_SERVICE/SHOW_GUIDE), the two-level
 * provider→model management panel, and the write-only API key contract.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FeaturesPage } from '../../src/renderer/app/settings/pages/FeaturesPage';
import { ManagedModelPanel } from '../../src/renderer/app/settings/pages/ManagedModelPanel';
import type { ManagedModelProvider } from '@codeagent/protocol';
import type { SettingsPageContext } from '../../src/renderer/app/settings/settingsContext';

const serviceError = { error: 'service is not connected', code: 'SERVICE_NOT_CONNECTED' };

let featureCards: Array<Record<string, unknown>>;
let providers: ManagedModelProvider[];
let updateCalls: Array<Record<string, unknown>>;
let preflightCalls: string[];
let probeCalls: Array<Record<string, unknown>>;
let probeResponse: { models: Array<{ id: string; displayName?: string; contextWindowTokens?: number }> };
let providerUpserts: Array<{ providerId: string; body: Record<string, unknown> }>;
let modelUpserts: Array<{ providerId: string; modelId: string; body: Record<string, unknown> }>;
let providerDeletes: string[];
let modelDeletes: Array<{ providerId: string; modelId: string }>;
let clipboardText: string | null;

function resetFixtures(): void {
  featureCards = [
    {
      featureId: 'SANDBOX',
      title: 'Sandbox',
      desiredEnabled: true,
      effectiveEnabled: true,
      state: 'READY',
      installation: 'INSTALLED',
      pendingRestart: false,
      source: 'DATABASE',
      checks: [
        { code: 'SANDBOX_BACKEND', label: '后端', status: 'PASS', detail: 'docker ready' }
      ],
      actions: [
        { id: 'recheck', label: '重新检测', kind: 'RECHECK', style: 'SECONDARY' }
      ],
      revision: 2
    },
    {
      featureId: 'TERMINAL',
      title: '终端',
      desiredEnabled: true,
      effectiveEnabled: false,
      state: 'ENABLED_NOT_READY',
      installation: 'MISSING',
      pendingRestart: true,
      source: 'DATABASE',
      checks: [
        { code: 'TERMINAL_NATIVE', label: '原生组件', status: 'FAIL', detail: 'self-test failed', fixHint: '重新安装终端组件' }
      ],
      actions: [
        { id: 'recheck', label: '重新检测', kind: 'RECHECK', style: 'SECONDARY' },
        { id: 'copy-fix', label: '复制修复命令', kind: 'COPY_TEXT', style: 'SECONDARY', copyText: 'winget install terminal' },
        { id: 'guide', label: '修复指引', kind: 'SHOW_GUIDE', style: 'SECONDARY', guideSteps: ['第一步', '第二步'] },
        { id: 'restart', label: '重启服务生效', kind: 'RESTART_SERVICE', style: 'PRIMARY' }
      ],
      revision: 1
    },
    {
      featureId: 'MODEL',
      title: '模型提供商与模型',
      desiredEnabled: null,
      supportsToggle: false,
      effectiveEnabled: true,
      state: 'READY',
      installation: 'NOT_REQUIRED',
      pendingRestart: false,
      source: 'DATABASE',
      checks: [],
      actions: [
        { id: 'recheck', label: '重新检测', kind: 'RECHECK', style: 'SECONDARY' }
      ],
      revision: 0
    },
    {
      featureId: 'WEBSEARCH',
      title: '网络检索',
      desiredEnabled: true,
      effectiveEnabled: true,
      state: 'READY',
      installation: 'NOT_REQUIRED',
      pendingRestart: false,
      source: 'DATABASE',
      checks: [],
      actions: [
        // The service may ship an OPEN_SURFACE action pointing at the same
        // panel FeatureManagement owns — the card must not render it twice.
        { id: 'open-websearch', label: '管理搜索配置', kind: 'OPEN_SURFACE', style: 'SECONDARY', url: 'settings:websearch' }
      ],
      revision: 4,
      fields: [
        { key: 'web.network.mode', label: '网络模式', type: 'ENUM', options: ['DENY', 'PUBLIC'], sensitive: false, readOnly: false, required: false, value: 'PUBLIC' },
        { key: 'web.budget.maxConcurrent', label: '最大并发', type: 'INTEGER', options: [], sensitive: false, readOnly: false, required: false, value: '4', min: 1, max: 16 },
        { key: 'web.search.credentialRef', label: '搜索凭据', type: 'ENV_REF', options: [], sensitive: true, readOnly: false, required: false, value: '(set)' },
        { key: 'web.fetch.allowedDomains', label: '允许域名', type: 'CSV', options: [], sensitive: false, readOnly: false, required: false, value: 'example.com' }
      ],
      entries: { 'web.network.mode': 'PUBLIC', 'web.budget.maxConcurrent': '4', 'web.search.credentialRef': 'env:TAVILY_KEY', 'web.fetch.allowedDomains': 'example.com' }
    },
    {
      featureId: 'HOST_RUNTIME',
      title: '环境检查 (Python / PowerShell)',
      desiredEnabled: null,
      supportsToggle: false,
      effectiveEnabled: true,
      state: 'NOT_INSTALLED',
      installation: 'MISSING',
      pendingRestart: false,
      source: 'DEFAULT',
      checks: [
        { code: 'RUNTIME_PYTHON', label: 'Python 环境', status: 'FAIL', detail: 'PYTHON_NOT_FOUND', fixHint: '安装 Python 3 并勾选 Add python.exe to PATH' },
        { code: 'RUNTIME_POWERSHELL', label: 'PowerShell 环境', status: 'PASS', detail: 'powershell 5.1.26100.9444' }
      ],
      actions: [
        { id: 'recheck', label: '重新检测', kind: 'RECHECK', style: 'SECONDARY' },
        { id: 'install-python', label: 'Python 安装指引', kind: 'SHOW_GUIDE', style: 'SECONDARY', guideSteps: ['winget install Python.Python.3.13', '勾选 Add python.exe to PATH', '点击重新检测'] },
        { id: 'copy-python-install', label: '复制 Python 安装命令', kind: 'COPY_TEXT', style: 'SECONDARY', copyText: 'winget install Python.Python.3.13' }
      ],
      revision: 0
    },
    {
      featureId: 'AGENT_TOOLS',
      title: 'Agent 工具能力 (Agent Tools)',
      desiredEnabled: null,
      supportsToggle: false,
      effectiveEnabled: true,
      state: 'READY',
      installation: 'NOT_REQUIRED',
      pendingRestart: false,
      source: 'DEFAULT',
      detail: { catalogRevision: 'code-tools-v5', tools: '3', available: '2', conditional: '0', gated: '1' },
      checks: [
        { code: 'TOOLS_CATALOG', label: '工具目录', status: 'PASS', detail: 'code-tools-v5 · 3 项' },
        { code: 'TOOLS_GATED', label: '门控工具', status: 'WARN', detail: '1 项受门控: websearch', fixHint: '启用对应功能并使其就绪后，这些工具自动恢复' }
      ],
      actions: [
        { id: 'recheck', label: '重新检测', kind: 'RECHECK', style: 'SECONDARY' }
      ],
      tools: [
        { name: 'workspace_read', capabilityId: 'com.agent.workspace.read', effect: 'READ', summary: 'Read a file; use startLine/maxLines for large files', availability: 'AVAILABLE' },
        { name: 'workspace_edit', capabilityId: 'com.agent.workspace.edit', effect: 'WRITE', summary: 'Apply targeted find-and-replace edits to a file', availability: 'AVAILABLE', availabilityDetail: '只读运行中不暴露' },
        { name: 'websearch', capabilityId: 'com.agent.web.search', effect: 'NETWORK', summary: 'Search the web through the configured provider', availability: 'GATED', availabilityDetail: 'gate=WEBSEARCH reason=WEB_SEARCH_NOT_READY' }
      ],
      revision: 0
    }
  ];
  providers = [
    {
      providerId: 'provider-main',
      displayName: 'Provider 主账号',
      dialect: 'OPENAI_CHAT_COMPLETIONS',
      baseUrl: 'https://api.example.com/v1',
      credentialKind: 'SECRET',
      credentialEnvName: null,
      credentialConfigured: true,
      enabled: true,
      source: 'DATABASE',
      pendingRestart: false,
      revision: 3,
      models: [
        { modelId: 'alpha-pro', displayName: 'Alpha Pro', capabilities: ['NATIVE_TOOL_CALLING'], enabled: true, source: 'DATABASE', defaultModel: true, pendingRestart: false, revision: 1 }
      ]
    }
  ];
  updateCalls = [];
  preflightCalls = [];
  providerUpserts = [];
  modelUpserts = [];
  providerDeletes = [];
  modelDeletes = [];
  clipboardText = null;
  probeCalls = [];
  probeResponse = {
    models: [
      { id: 'deepseek-chat', displayName: 'deepseek-chat', contextWindowTokens: 128000 },
      { id: 'deepseek-reasoner', displayName: 'deepseek-reasoner', contextWindowTokens: 128000 },
      { id: 'deepseek-extra', displayName: 'deepseek-extra', contextWindowTokens: 64000 }
    ]
  };
}

function installFakeApi(overrides: { serviceConnected?: boolean } = {}): void {
  const ok = <T,>(value: T): T | typeof serviceError => (overrides.serviceConnected === false ? serviceError : value);
  Object.defineProperty(window, 'codeAgentDesktop', {
    configurable: true,
    value: {
      restartService: vi.fn(async () => ({ status: 'OWNED_READY' })),
      openExternalHttps: vi.fn(async () => undefined),
      getEnvironmentFeatures: vi.fn(async () => ok({
        serviceInstanceId: 'instance-abc123',
        generatedAtMillis: 1,
        features: JSON.parse(JSON.stringify(featureCards))
      })),
      updateEnvironmentFeature: vi.fn(async (featureId: string, body: Record<string, unknown>) => {
        updateCalls.push({ featureId, ...body });
        return ok({ ...featureCards.find((card) => card.featureId === featureId), ...body });
      }),
      preflightEnvironmentFeature: vi.fn(async (featureId: string) => {
        preflightCalls.push(featureId);
        return ok(featureCards.find((card) => card.featureId === featureId));
      }),
      listManagedModelProviders: vi.fn(async () => ok({
        defaultModel: 'alpha-pro',
        overlayError: null,
        revision: 7,
        providers: JSON.parse(JSON.stringify(providers))
      })),
      upsertModelProvider: vi.fn(async (providerId: string, body: Record<string, unknown>) => {
        providerUpserts.push({ providerId, body });
        return ok({ providerId, ...body, models: [] });
      }),
      deleteModelProvider: vi.fn(async (providerId: string) => {
        providerDeletes.push(providerId);
        return ok({ deleted: true });
      }),
      upsertProviderModel: vi.fn(async (providerId: string, modelId: string, body: Record<string, unknown>) => {
        modelUpserts.push({ providerId, modelId, body });
        return ok({ modelId, ...body });
      }),
      deleteProviderModel: vi.fn(async (providerId: string, modelId: string) => {
        modelDeletes.push({ providerId, modelId });
        return ok({ deleted: true });
      }),
      probeRemoteProviderModels: vi.fn(async (body: Record<string, unknown>) => {
        probeCalls.push(body);
        return ok(probeResponse);
      })
    }
  });
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: vi.fn(async (text: string) => { clipboardText = text; }) }
  });
}

const context: SettingsPageContext = {
  capabilities: {} as never,
  connection: 'CONNECTED',
  projects: [],
  onOpenExtensions: vi.fn(),
  onOpenSettingsRoute: vi.fn()
};

function renderPage(element: React.JSX.Element): void {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } }
  });
  render(<QueryClientProvider client={queryClient}>{element}</QueryClientProvider>);
}

beforeEach(() => {
  resetFixtures();
  installFakeApi();
});

afterEach(() => {
  cleanup();
});

describe('features page', () => {
  it('renders capability cards with state, installation and pending-restart badges', async () => {
    renderPage(<FeaturesPage context={context} />);
    await screen.findByTestId('feature-card-SANDBOX');
    // §10.3 (S4): one synthesized badge per card — READY→可用, warn→需处理.
    expect(screen.getByTestId('feature-state-SANDBOX').textContent).toBe('可用');
    expect(screen.getByTestId('feature-installation-TERMINAL').textContent).toBe('缺失');
    expect(screen.getByTestId('feature-state-TERMINAL').textContent).toBe('需处理');
    expect(screen.getByTestId('feature-pending-TERMINAL').textContent).toBe('重启后生效');
    expect(screen.getByTestId('feature-check-TERMINAL-TERMINAL_NATIVE').textContent).toContain('重新安装终端组件');
  });

  it('sends desired enabled with expectedRevision on toggle', async () => {
    renderPage(<FeaturesPage context={context} />);
    await screen.findByTestId('feature-card-SANDBOX');
    fireEvent.click(screen.getByTestId('feature-toggle-SANDBOX'));
    await waitFor(() => expect(updateCalls.length).toBe(1));
    expect(updateCalls[0]).toMatchObject({ featureId: 'SANDBOX', enabled: false, expectedRevision: 2 });
  });

  it('still allows saving the enable intent while installation is missing', async () => {
    renderPage(<FeaturesPage context={context} />);
    await screen.findByTestId('feature-card-TERMINAL');
    expect((screen.getByTestId('feature-toggle-TERMINAL') as HTMLInputElement).disabled).toBe(false);
  });

  it('renders no toggle for features without an enable gate', async () => {
    renderPage(<FeaturesPage context={context} />);
    await screen.findByTestId('feature-card-MODEL');
    expect(screen.queryByTestId('feature-toggle-MODEL')).toBeNull();
    expect(screen.getByTestId('feature-managed-MODEL').textContent).toContain('管理入口');
  });

  it('dispatches typed actions: recheck, copy, guide, restart', async () => {
    renderPage(<FeaturesPage context={context} />);
    await screen.findByTestId('feature-card-TERMINAL');
    fireEvent.click(screen.getByTestId('feature-action-TERMINAL-recheck'));
    await waitFor(() => expect(preflightCalls).toContain('TERMINAL'));

    fireEvent.click(screen.getByTestId('feature-action-TERMINAL-copy-fix'));
    await waitFor(() => expect(clipboardText).toBe('winget install terminal'));

    expect(screen.queryByTestId('feature-guide-TERMINAL-guide')).toBeNull();
    fireEvent.click(screen.getByTestId('feature-action-TERMINAL-guide'));
    expect(await screen.findByTestId('feature-guide-TERMINAL-guide').then((el) => el.textContent)).toContain('第一步');

    fireEvent.click(screen.getByTestId('feature-action-TERMINAL-restart'));
    await waitFor(() => expect(vi.mocked(window.codeAgentDesktop.restartService).mock.calls.length).toBe(1));
  });

  it('renders the detection-only runtime card with install guidance for a missing interpreter', async () => {
    renderPage(<FeaturesPage context={context} />);
    await screen.findByTestId('feature-card-HOST_RUNTIME');
    expect(screen.getByTestId('feature-state-HOST_RUNTIME').textContent).toBe('需处理');
    expect(screen.getByTestId('feature-installation-HOST_RUNTIME').textContent).toBe('缺失');
    // Detection cards carry no enable gate and no editable fields.
    expect(screen.queryByTestId('feature-toggle-HOST_RUNTIME')).toBeNull();
    expect(screen.queryByTestId('feature-fields-open-HOST_RUNTIME')).toBeNull();
    expect(screen.getByTestId('feature-check-HOST_RUNTIME-RUNTIME_PYTHON').textContent).toContain('PYTHON_NOT_FOUND');
    expect(screen.getByTestId('feature-check-HOST_RUNTIME-RUNTIME_POWERSHELL').textContent).toContain('5.1.26100.9444');

    fireEvent.click(screen.getByTestId('feature-action-HOST_RUNTIME-copy-python-install'));
    await waitFor(() => expect(clipboardText).toBe('winget install Python.Python.3.13'));
    fireEvent.click(screen.getByTestId('feature-action-HOST_RUNTIME-install-python'));
    expect(await screen.findByTestId('feature-guide-HOST_RUNTIME-install-python').then((el) => el.textContent)).toContain('Add python.exe to PATH');
  });

  it('renders the agent tool catalog with effect, availability and summaries', async () => {
    renderPage(<FeaturesPage context={context} />);
    await screen.findByTestId('feature-card-AGENT_TOOLS');
    // Informational card: no toggle, no editable fields.
    expect(screen.queryByTestId('feature-toggle-AGENT_TOOLS')).toBeNull();
    expect(screen.queryByTestId('feature-fields-open-AGENT_TOOLS')).toBeNull();
    expect(screen.getByTestId('feature-check-AGENT_TOOLS-TOOLS_CATALOG').textContent).toContain('code-tools-v5');
    expect(screen.getByTestId('feature-check-AGENT_TOOLS-TOOLS_GATED').textContent).toContain('websearch');

    const read = screen.getByTestId('feature-tool-AGENT_TOOLS-workspace_read');
    expect(read.textContent).toContain('读取');
    expect(read.textContent).toContain('可用');
    expect(read.textContent).toContain('Read a file');

    const edit = screen.getByTestId('feature-tool-AGENT_TOOLS-workspace_edit');
    expect(edit.textContent).toContain('写入');
    expect(edit.textContent).toContain('只读运行中不暴露');

    const web = screen.getByTestId('feature-tool-AGENT_TOOLS-websearch');
    expect(web.textContent).toContain('网络');
    expect(web.textContent).toContain('受门控');
    expect(web.textContent).toContain('gate=WEBSEARCH');
  });

  it('orders attention cards first and filters via the summary counts', async () => {
    renderPage(<FeaturesPage context={context} />);
    await screen.findByTestId('feature-card-SANDBOX');
    // TERMINAL + HOST_RUNTIME need attention → they lead the list.
    const cardIds = within(screen.getByTestId('feature-card-list'))
      .getAllByRole('listitem')
      .map((el) => el.getAttribute('data-testid'));
    const attentionIdx = [cardIds.indexOf('feature-card-TERMINAL'), cardIds.indexOf('feature-card-HOST_RUNTIME')];
    const otherIdx = [cardIds.indexOf('feature-card-SANDBOX'), cardIds.indexOf('feature-card-WEBSEARCH'), cardIds.indexOf('feature-card-MODEL')];
    expect(Math.max(...attentionIdx)).toBeLessThan(Math.min(...otherIdx));

    // The 需处理 count filters the list and scrolls to the first card.
    fireEvent.click(screen.getByTestId('feature-toc'));
    expect(within(screen.getByTestId('feature-card-list')).queryByTestId('feature-card-SANDBOX')).toBeNull();
    expect(within(screen.getByTestId('feature-card-list')).getByTestId('feature-card-TERMINAL')).toBeTruthy();
    fireEvent.click(screen.getByText('显示全部'));
    expect(within(screen.getByTestId('feature-card-list')).getByTestId('feature-card-SANDBOX')).toBeTruthy();
  });

  it('shows the desired/effective mismatch warning only when the values differ', async () => {
    renderPage(<FeaturesPage context={context} />);
    await screen.findByTestId('feature-card-SANDBOX');
    // TERMINAL: desired=enabled, effective=disabled → mismatch warning.
    expect(screen.getByTestId('feature-mismatch-TERMINAL').textContent).toContain('已设为启用');
    // SANDBOX desired === effective → no 期望/当前生效 meta at all (§10.3 S4).
    expect(screen.queryByTestId('feature-mismatch-SANDBOX')).toBeNull();
    expect(within(screen.getByTestId('feature-card-SANDBOX')).queryByText(/期望/)).toBeNull();
  });

  it('collapses check codes into a details node and drops the 处理建议 prefix', async () => {
    renderPage(<FeaturesPage context={context} />);
    await screen.findByTestId('feature-card-TERMINAL');
    const failRow = screen.getByTestId('feature-check-TERMINAL-TERMINAL_NATIVE');
    // Code + detail live inside <details>; the fix hint no longer carries the label.
    expect(failRow.querySelector('details code')?.textContent).toContain('TERMINAL_NATIVE');
    expect(failRow.textContent).not.toContain('处理建议');
    expect(failRow.textContent).toContain('重新安装终端组件');
  });

  it('keeps a single 管理搜索配置 entry and does not repeat the page heading', async () => {
    renderPage(<FeaturesPage context={context} />);
    await screen.findByTestId('feature-card-WEBSEARCH');
    // S2: the service OPEN_SURFACE action is deduped against FeatureManagement.
    const manageButtons = screen.getAllByRole('button', { name: '管理搜索配置' });
    expect(manageButtons.length).toBe(1);
    expect(manageButtons[0]).toBe(screen.getByTestId('feature-manage-toggle-WEBSEARCH'));
    // S1: the section no longer repeats the page-level heading.
    const section = screen.getByTestId('features-section');
    expect(within(section).queryByRole('heading', { name: '功能与环境' })).toBeNull();
  });

  it('shows the typed unavailable state when the service is offline', async () => {
    cleanup();
    installFakeApi({ serviceConnected: false });
    renderPage(<FeaturesPage context={context} />);
    const unavailable = await screen.findByTestId('settings-unavailable');
    expect(unavailable.textContent).toContain('Service 未连接');
  });

  it('edits typed feature fields and writes entries with the card revision', async () => {
    renderPage(<FeaturesPage context={context} />);
    await screen.findByTestId('feature-card-WEBSEARCH');
    fireEvent.click(screen.getByTestId('feature-fields-open-WEBSEARCH'));
    await screen.findByTestId('feature-fields-dialog-WEBSEARCH');
    const modeSelect = await screen.findByTestId('feature-field-WEBSEARCH-web.network.mode') as HTMLSelectElement;
    expect(modeSelect.value).toBe('PUBLIC');
    // The sensitive field never echoes the stored env name — it renders
    // a write-only placeholder instead.
    const credential = screen.getByTestId('feature-field-WEBSEARCH-web.search.credentialRef') as HTMLInputElement;
    expect(credential.value).toBe('');
    expect(credential.placeholder).toContain('已设置');

    fireEvent.change(screen.getByTestId('feature-field-WEBSEARCH-web.fetch.allowedDomains'),
      { target: { value: 'example.com, docs.example.com' } });
    fireEvent.click(screen.getByTestId('feature-fields-save-WEBSEARCH'));
    await waitFor(() => expect(updateCalls.length).toBe(1));
    expect(updateCalls[0]).toMatchObject({
      featureId: 'WEBSEARCH',
      expectedRevision: 4,
      entries: { 'web.fetch.allowedDomains': 'example.com, docs.example.com' }
    });
    // Unchanged fields are not rewritten.
    expect(Object.keys(updateCalls[0]?.entries as Record<string, unknown>)).not.toContain('web.network.mode');
  });

  it('sends a null tombstone when a stored field is cleared', async () => {
    renderPage(<FeaturesPage context={context} />);
    await screen.findByTestId('feature-card-WEBSEARCH');
    fireEvent.click(screen.getByTestId('feature-fields-open-WEBSEARCH'));
    await screen.findByTestId('feature-fields-dialog-WEBSEARCH');
    const input = await screen.findByTestId('feature-field-WEBSEARCH-web.budget.maxConcurrent');
    fireEvent.change(input, { target: { value: '' } });
    fireEvent.click(screen.getByTestId('feature-fields-save-WEBSEARCH'));
    await waitFor(() => expect(updateCalls.length).toBe(1));
    expect(updateCalls[0]?.entries).toMatchObject({ 'web.budget.maxConcurrent': null });
  });

  it('filters parameter rows and marks unsaved edits as dirty', async () => {
    renderPage(<FeaturesPage context={context} />);
    await screen.findByTestId('feature-card-WEBSEARCH');
    fireEvent.click(screen.getByTestId('feature-fields-open-WEBSEARCH'));
    await screen.findByTestId('feature-fields-dialog-WEBSEARCH');
    // All four fields are visible inside the floating window.
    expect(screen.getByTestId('feature-field-row-WEBSEARCH-web.network.mode')).toBeTruthy();

    fireEvent.change(screen.getByTestId('feature-fields-filter-WEBSEARCH'), { target: { value: '并发' } });
    expect(screen.queryByTestId('feature-field-row-WEBSEARCH-web.network.mode')).toBeNull();
    expect(screen.getByTestId('feature-field-row-WEBSEARCH-web.budget.maxConcurrent')).toBeTruthy();

    fireEvent.change(screen.getByTestId('feature-field-WEBSEARCH-web.budget.maxConcurrent'), { target: { value: '8' } });
    expect(screen.getByTestId('feature-field-row-WEBSEARCH-web.budget.maxConcurrent').className).toContain('is-dirty');

    // Clearing the query restores every row; "仅看已设置" keeps all four
    // fixture fields visible since every one has a stored value.
    fireEvent.change(screen.getByTestId('feature-fields-filter-WEBSEARCH'), { target: { value: '' } });
    fireEvent.click(screen.getByTestId('feature-fields-configured-WEBSEARCH'));
    expect(screen.getByTestId('feature-field-row-WEBSEARCH-web.network.mode')).toBeTruthy();
    expect(screen.getByTestId('feature-field-row-WEBSEARCH-web.fetch.allowedDomains')).toBeTruthy();

    // A nonsense query hits the empty state.
    fireEvent.change(screen.getByTestId('feature-fields-filter-WEBSEARCH'), { target: { value: 'zzz-nope' } });
    expect(await screen.findByTestId('feature-fields-empty-WEBSEARCH')).toBeTruthy();
  });
});

describe('managed model catalog panel', () => {
  it('renders providers with credential state but never secret material', async () => {
    renderPage(<ManagedModelPanel />);
    await screen.findByTestId('provider-provider-main');
    const card = screen.getByTestId('provider-provider-main');
    expect(card.textContent).toContain('系统加密存储 · 已配置');
    expect(card.textContent).not.toContain('apiKey');
    expect(screen.getByTestId('provider-model-provider-main-alpha-pro').textContent).toContain('默认');
    expect(screen.getByTestId('managed-default-model').textContent).toContain('alpha-pro');
  });

  it('creates a provider with a write-only apiKey and env-ref credential', async () => {
    renderPage(<ManagedModelPanel />);
    await screen.findByTestId('provider-provider-main');
    fireEvent.click(screen.getByTestId('provider-add-open'));
    await screen.findByTestId('provider-form');
    fireEvent.change(screen.getByTestId('provider-id-input'), { target: { value: 'anthropic-a' } });
    fireEvent.change(screen.getByTestId('provider-baseurl-input'), { target: { value: 'https://api.anthropic.example' } });
    fireEvent.change(screen.getByTestId('provider-dialect-select'), { target: { value: 'ANTHROPIC_MESSAGES' } });
    fireEvent.change(screen.getByTestId('provider-credential-kind'), { target: { value: 'SECRET' } });
    fireEvent.change(screen.getByTestId('provider-api-key'), { target: { value: 'sk-secret-value' } });
    fireEvent.click(screen.getByTestId('provider-form-save'));
    await waitFor(() => expect(providerUpserts.length).toBe(1));
    expect(providerUpserts[0]?.providerId).toBe('anthropic-a');
    expect(providerUpserts[0]?.body).toMatchObject({
      dialect: 'ANTHROPIC_MESSAGES',
      baseUrl: 'https://api.anthropic.example',
      credentialKind: 'SECRET',
      apiKey: 'sk-secret-value',
      // New providers default to disabled: the service rejects an enabled
      // provider that has no model entries yet.
      enabled: false
    });
    // The rendered form never echoes the secret back into the DOM value of
    // other fields; it was only sent once on submit.
  });

  it('edits a model under a provider with expectedRevision', async () => {
    renderPage(<ManagedModelPanel />);
    await screen.findByTestId('provider-model-provider-main-alpha-pro');
    fireEvent.click(screen.getByTestId('model-edit-provider-main-alpha-pro'));
    await screen.findByTestId('model-form');
    fireEvent.change(screen.getByTestId('model-capabilities-input'), { target: { value: 'NATIVE_TOOL_CALLING, IMAGE_INPUT' } });
    fireEvent.click(screen.getByTestId('model-form-save'));
    await waitFor(() => expect(modelUpserts.length).toBe(1));
    expect(modelUpserts[0]).toMatchObject({
      providerId: 'provider-main',
      modelId: 'alpha-pro',
      body: {
        capabilities: ['NATIVE_TOOL_CALLING', 'IMAGE_INPUT'],
        enabled: true,
        expectedRevision: 1
      }
    });
  });

  it('requires a second click before deleting a database provider', async () => {
    renderPage(<ManagedModelPanel />);
    await screen.findByTestId('provider-provider-main');
    const deleteButton = screen.getByTestId('provider-delete-provider-main');
    fireEvent.click(deleteButton);
    expect(providerDeletes.length).toBe(0);
    expect(deleteButton.textContent).toContain('确认');
    fireEvent.click(deleteButton);
    await waitFor(() => expect(providerDeletes).toContain('provider-main'));
  });

  it('edits extended model fields including remoteModelId and unset semantics', async () => {
    providers[0]!.models[0]!.remoteModelId = 'alpha-pro-wire-2025';
    providers[0]!.models[0]!.thinkingMode = 'TOGGLE';
    renderPage(<ManagedModelPanel />);
    await screen.findByTestId('provider-model-provider-main-alpha-pro');
    fireEvent.click(screen.getByTestId('model-edit-provider-main-alpha-pro'));
    await screen.findByTestId('model-form');
    const remoteInput = screen.getByTestId('model-remote-id-input') as HTMLInputElement;
    expect(remoteInput.value).toBe('alpha-pro-wire-2025');
    // Blanking a previously-set field lists it in unsetFields.
    fireEvent.change(remoteInput, { target: { value: '' } });
    fireEvent.change(screen.getByTestId('model-thinking-mode'), { target: { value: 'ADAPTIVE' } });
    fireEvent.click(screen.getByTestId('model-form-save'));
    await waitFor(() => expect(modelUpserts.length).toBe(1));
    expect(modelUpserts[0]?.body).toMatchObject({
      thinkingMode: 'ADAPTIVE',
      unsetFields: ['remoteModelId']
    });
  });

  it('writes the composite default ref via the MODEL feature entries', async () => {
    providers[0]!.models.push({
      modelId: 'alpha-mini', displayName: 'Alpha Mini', capabilities: [],
      enabled: true, source: 'DATABASE', defaultModel: false, pendingRestart: false, revision: 2
    });
    renderPage(<ManagedModelPanel />);
    await screen.findByTestId('provider-model-provider-main-alpha-mini');
    fireEvent.click(screen.getByTestId('model-set-default-provider-main-alpha-mini'));
    await waitFor(() => expect(updateCalls.length).toBe(1));
    expect(updateCalls[0]).toMatchObject({
      featureId: 'MODEL',
      entries: { defaultModel: 'provider-main:alpha-mini' }
    });
  });

  it('offers a replacement default when delete hits MODEL_IN_USE', async () => {
    providers[0]!.models.push({
      modelId: 'alpha-mini', displayName: 'Alpha Mini', capabilities: [],
      enabled: true, source: 'DATABASE', defaultModel: false, pendingRestart: false, revision: 2
    });
    Object.defineProperty(window.codeAgentDesktop, 'deleteProviderModel', {
      configurable: true,
      value: vi.fn(async (providerId: string, modelId: string, _rev?: number, replaceDefault?: string) => {
        if (!replaceDefault) throw new Error('MODEL_IN_USE: model backs the default reference');
        modelDeletes.push({ providerId, modelId });
        return { deleted: true };
      })
    });
    renderPage(<ManagedModelPanel />);
    await screen.findByTestId('provider-model-provider-main-alpha-pro');
    const deleteButton = screen.getByTestId('model-delete-provider-main-alpha-pro');
    fireEvent.click(deleteButton);
    fireEvent.click(deleteButton);
    const replaceForm = await screen.findByTestId('replace-default-form');
    expect(replaceForm.textContent).toContain('接管默认值');
    fireEvent.change(screen.getByTestId('replace-default-select'), { target: { value: 'provider-main:alpha-mini' } });
    fireEvent.click(screen.getByTestId('replace-default-confirm'));
    await waitFor(() => expect(modelDeletes).toContainEqual({ providerId: 'provider-main', modelId: 'alpha-pro' }));
  });

  it('quick-adds a preset provider: pick channel + key only, suggested model applies', async () => {
    renderPage(<ManagedModelPanel />);
    await screen.findByTestId('quick-add-card');
    fireEvent.change(screen.getByTestId('quick-target'), { target: { value: 'preset:deepseek' } });
    fireEvent.change(screen.getByTestId('quick-api-key'), { target: { value: 'sk-deepseek' } });
    // The first suggested model is preselected — the API key is the only
    // required typed input (review 2026-11-06: key-only onboarding).
    fireEvent.click(screen.getByTestId('quick-save'));
    await waitFor(() => expect(providerUpserts.length).toBe(2));
    // Preset bundles dialect/baseUrl/credential kind; the provider is
    // created disabled because catalog validation requires a model first.
    expect(providerUpserts[0]).toMatchObject({
      providerId: 'deepseek',
      body: {
        dialect: 'OPENAI_CHAT_COMPLETIONS',
        baseUrl: 'https://api.deepseek.com/v1',
        credentialKind: 'SECRET',
        apiKey: 'sk-deepseek',
        displayName: 'DeepSeek',
        enabled: false
      }
    });
    expect(modelUpserts[0]).toMatchObject({
      providerId: 'deepseek',
      modelId: 'deepseek-chat',
      body: { remoteModelId: 'deepseek-chat', enabled: true }
    });
    expect(providerUpserts[1]?.body).toMatchObject({ enabled: true });
  });

  it('quick-adds a model to an existing provider and can rotate its key', async () => {
    renderPage(<ManagedModelPanel />);
    await screen.findByTestId('quick-add-card');
    fireEvent.change(screen.getByTestId('quick-target'), { target: { value: 'provider:provider-main' } });
    fireEvent.change(screen.getByTestId('quick-api-key'), { target: { value: 'sk-rotated' } });
    fireEvent.change(screen.getByTestId('quick-model-choices'), { target: { value: '__custom__' } });
    fireEvent.change(screen.getByTestId('quick-model-id'), { target: { value: 'alpha-mini' } });
    fireEvent.click(screen.getByTestId('quick-save'));
    await waitFor(() => expect(modelUpserts.length).toBe(1));
    expect(providerUpserts[0]).toMatchObject({
      providerId: 'provider-main',
      body: { apiKey: 'sk-rotated', expectedRevision: 3 }
    });
    expect(modelUpserts[0]).toMatchObject({
      providerId: 'provider-main',
      modelId: 'alpha-mini',
      body: { remoteModelId: 'alpha-mini', enabled: true }
    });
  });

  it('rotates a provider key with 不改动模型 selected', async () => {
    renderPage(<ManagedModelPanel />);
    await screen.findByTestId('quick-add-card');
    fireEvent.change(screen.getByTestId('quick-target'), { target: { value: 'provider:provider-main' } });
    fireEvent.change(screen.getByTestId('quick-api-key'), { target: { value: 'sk-rotated' } });
    fireEvent.click(screen.getByTestId('quick-save'));
    await waitFor(() => expect(providerUpserts.length).toBe(1));
    expect(providerUpserts[0]).toMatchObject({
      providerId: 'provider-main',
      body: { apiKey: 'sk-rotated', expectedRevision: 3 }
    });
    expect(modelUpserts.length).toBe(0);
  });

  it('validates the quick-add form instead of posting partial records', async () => {
    renderPage(<ManagedModelPanel />);
    await screen.findByTestId('quick-add-card');
    // Custom endpoint still requires Base URL + model name.
    fireEvent.change(screen.getByTestId('quick-target'), { target: { value: 'custom' } });
    fireEvent.change(screen.getByTestId('quick-api-key'), { target: { value: 'sk-x' } });
    fireEvent.click(screen.getByTestId('quick-save'));
    expect(providerUpserts.length).toBe(0);
    expect(modelUpserts.length).toBe(0);
    fireEvent.change(screen.getByTestId('quick-baseurl'), { target: { value: 'https://api.example.com/v1' } });
    fireEvent.change(screen.getByTestId('quick-model-id'), { target: { value: 'bad model!' } });
    fireEvent.click(screen.getByTestId('quick-save'));
    expect(providerUpserts.length).toBe(0);
    // Back to a preset: suggestion preselected, key alone is enough.
    fireEvent.change(screen.getByTestId('quick-target'), { target: { value: 'preset:commandcode' } });
    fireEvent.click(screen.getByTestId('quick-save'));
    await waitFor(() => expect(providerUpserts.length).toBe(2));
    expect(providerUpserts[0]?.providerId).toBe('commandcode-chat');
  });

  it('probes the channel catalog, then imports a checked subset under editable aliases', async () => {
    renderPage(<ManagedModelPanel />);
    await screen.findByTestId('quick-add-card');
    fireEvent.change(screen.getByTestId('quick-target'), { target: { value: 'preset:deepseek' } });
    fireEvent.change(screen.getByTestId('quick-api-key'), { target: { value: 'sk-deepseek' } });
    fireEvent.click(screen.getByTestId('quick-probe'));
    // The pool carries the upstream supply list; preset suggestions start
    // checked, extra upstream ids do not (deliberate-subset import).
    await screen.findByTestId('pool-model-deepseek-extra');
    expect(probeCalls[0]).toMatchObject({
      dialect: 'OPENAI_CHAT_COMPLETIONS',
      baseUrl: 'https://api.deepseek.com/v1',
      apiKey: 'sk-deepseek'
    });
    expect(screen.getByTestId('quick-save').textContent).toContain('接入勾选的 2 个');
    // Renaming the local alias keeps the upstream id as remoteModelId.
    fireEvent.change(screen.getByTestId('pool-alias-deepseek-chat'), { target: { value: 'ds-chat-fast' } });
    fireEvent.click(screen.getByTestId('quick-save'));
    await waitFor(() => expect(modelUpserts.length).toBe(2));
    expect(providerUpserts[0]).toMatchObject({
      providerId: 'deepseek',
      body: { apiKey: 'sk-deepseek', enabled: false }
    });
    expect(modelUpserts.map((call) => call.modelId).sort()).toEqual(['deepseek-reasoner', 'ds-chat-fast']);
    expect(modelUpserts.find((call) => call.modelId === 'ds-chat-fast')?.body)
      .toMatchObject({ remoteModelId: 'deepseek-chat', contextWindowTokens: 128000, enabled: true });
    expect(providerUpserts[1]?.body).toMatchObject({ enabled: true });
  });

  it('probes an existing provider with its stored key and reports probe failures honestly', async () => {
    renderPage(<ManagedModelPanel />);
    await screen.findByTestId('quick-add-card');
    fireEvent.change(screen.getByTestId('quick-target'), { target: { value: 'provider:provider-main' } });
    fireEvent.click(screen.getByTestId('quick-probe'));
    // Blank key → the probe runs against the stored credential.
    await waitFor(() => expect(probeCalls.length).toBe(1));
    expect(probeCalls[0]).toMatchObject({ providerId: 'provider-main' });
    expect(probeCalls[0]?.apiKey).toBeUndefined();
    await screen.findByTestId('quick-pool');
    // Second probe fails: error surfaces, no writes go out.
    const failProbe = { error: 'remote model probe failed: provider rejected the credential (HTTP 401)', code: 'REMOTE_AUTH_FAILED' };
    vi.mocked(window.codeAgentDesktop.probeRemoteProviderModels)
      .mockResolvedValueOnce(failProbe as never);
    fireEvent.click(screen.getByTestId('quick-probe'));
    await waitFor(() => expect(screen.getByText(/rejected the credential/)).toBeTruthy());
    expect(providerUpserts.length).toBe(0);
    expect(modelUpserts.length).toBe(0);
  });
});
