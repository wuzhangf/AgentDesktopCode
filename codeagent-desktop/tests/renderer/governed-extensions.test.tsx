// @vitest-environment jsdom
/**
 * WU08 renderer acceptance (design §10): governed MCP panel — template
 * selection, per-line argv, paged tool catalog, DIAGNOSE findings, OAuth
 * consent via openExternalHttps — plus invocation-level operator actions
 * (CANCEL / RESUME_INPUT / RECONCILE) and per-tool message selection.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ExtensionEvidencePanel,
  McpGovernancePanel
} from '../../src/renderer/app/GovernedExtensionsPanel';
import {
  ExtensionSelectionPicker,
  useExtensionSelection,
  type ExtensionSelectionValue
} from '../../src/renderer/app/ExtensionSelectionBar';
import type { McpOperationResponse } from '../../packages/protocol/src/index.js';

const serverRow = {
  serverId: 'srv-1', displayName: 'Everything', scope: 'USER', enabled: true,
  transportKind: 'STDIO', connectionState: 'READY', toolCount: 2, revision: 3
};

let servers: Array<Record<string, unknown>> = [];
let toolItems: Array<Record<string, unknown>> = [];
let invocations: Record<string, unknown> = { items: [], nextCursor: null };
let operations: Record<string, McpOperationResponse> = {};
let operationSeq = 0;
const createCalls: Array<Record<string, unknown>> = [];
const updateCalls: Array<{ serverId: string; body: Record<string, unknown> }> = [];
const actionCalls: Array<{ serverId: string; action: string }> = [];
const authCalls: Array<{ serverId: string; action: string }> = [];
const invocationActionCalls: Array<{ executionId: string; invocationId: string; body: Record<string, unknown> }> = [];
const testExecCalls: Array<Record<string, unknown>> = [];
const openedUrls: string[] = [];

function resetFixtures(): void {
  servers = [{ ...serverRow }];
  toolItems = [
    { toolId: 'tool-alpha', title: 'Alpha', rawName: 'alpha', effectiveRisk: 'NORMAL', availability: 'AVAILABLE' },
    { toolId: 'tool-beta', title: 'Beta', rawName: 'beta', effectiveRisk: 'HIGH_RISK', availability: 'AVAILABLE' }
  ];
  invocations = { items: [], nextCursor: null };
  operations = {};
  operationSeq = 0;
  createCalls.length = 0;
  updateCalls.length = 0;
  actionCalls.length = 0;
  authCalls.length = 0;
  invocationActionCalls.length = 0;
  testExecCalls.length = 0;
  openedUrls.length = 0;
}

function installFakeApi(): void {
  Object.defineProperty(window, 'codeAgentDesktop', {
    configurable: true,
    value: {
      openExternalHttps: vi.fn(async (url: string) => { openedUrls.push(url); }),
      listMcpServersGoverned: vi.fn(async () => servers),
      createMcpServer: vi.fn(async (body: Record<string, unknown>) => {
        createCalls.push(body);
        return { ...serverRow, serverId: 'srv-new', revision: 1 };
      }),
      updateMcpServer: vi.fn(async (serverId: string, body: Record<string, unknown>) => {
        updateCalls.push({ serverId, body });
        return { ...serverRow, serverId, revision: 4 };
      }),
      setMcpServerStatus: vi.fn(async () => serverRow),
      requestMcpConnectionAction: vi.fn(async (serverId: string, action: string) => {
        actionCalls.push({ serverId, action });
        const op: McpOperationResponse = {
          operationId: `op-${++operationSeq}`,
          kind: action as McpOperationResponse['kind'], status: 'RUNNING'
        };
        if (action === 'DIAGNOSE') {
          op.detail = JSON.stringify([
            { item: 'executable', status: 'OK', detail: 'npx resolved on PATH' },
            { item: 'cwd', status: 'WARN', detail: 'no cwd pinned' }
          ]);
        }
        operations[op.operationId as string] = op;
        return op;
      }),
      getMcpOperation: vi.fn(async (operationId: string) => {
        const op = operations[operationId];
        if (!op) return { error: 'unknown operation', code: 'MCP_OPERATION_NOT_FOUND' };
        return { ...op, status: 'SUCCEEDED' };
      }),
      listMcpServerTools: vi.fn(async () => ({ items: toolItems, nextCursor: null })),
      refreshMcpServerCatalog: vi.fn(async () => ({ operationId: 'op-refresh', kind: 'CATALOG_REFRESH', status: 'RUNNING' })),
      requestMcpAuthAction: vi.fn(async (serverId: string, action: string) => {
        authCalls.push({ serverId, action });
        return action === 'START'
          ? { status: 'PENDING', loginUrl: 'https://auth.example/consent?x=1', operationId: 'op-auth' }
          : { status: action === 'REVOKE' ? 'REVOKED' : 'CANCELLED' };
      }),
      listMcpPrompts: vi.fn(async () => ({ items: [{ name: 'summarize', title: 'Summarize', description: 'sum it' }] })),
      resolveMcpPrompt: vi.fn(async () => ({ promptName: 'summarize', blocks: [] })),
      listMcpResourceTemplates: vi.fn(async () => ({ items: [{ uriTemplate: 'file:///{path}', name: 'files' }] })),
      getExecutionExtensions: vi.fn(async () => ({ binding: null })),
      listExtensionInvocations: vi.fn(async () => invocations),
      requestExtensionInvocationAction: vi.fn(async (executionId: string, invocationId: string, body: Record<string, unknown>) => {
        invocationActionCalls.push({ executionId, invocationId, body });
        return { invocationId, executionId, state: body.action === 'CANCEL' ? 'CANCELLED' : 'DISPATCHING' };
      }),
      createExtensionTestExecution: vi.fn(async (body: Record<string, unknown>) => {
        testExecCalls.push(body);
        return { executionId: 'exec-test-1', status: 'RUNNING', bindingId: 'bind-1' };
      }),
      listSkillsGoverned: vi.fn(async () => [])
    }
  });
}

function renderPanel(element: React.JSX.Element): void {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } }
  });
  render(<QueryClientProvider client={queryClient}>{element}</QueryClientProvider>);
}

beforeEach(() => { resetFixtures(); installFakeApi(); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('McpGovernancePanel (WU08)', () => {
  it('prefills argv from a template and posts templateRef/templateVersion with per-line args', async () => {
    renderPanel(<McpGovernancePanel />);
    await screen.findByTestId('mcp-governed-record');
    fireEvent.change(screen.getByTestId('mcp-template'), { target: { value: 'mcp.template.filesystem' } });
    const args = screen.getByTestId('mcp-args') as HTMLTextAreaElement;
    expect(args.value).toContain('@modelcontextprotocol/server-filesystem');
    fireEvent.change(args, { target: { value: '-y\n@modelcontextprotocol/server-filesystem\nD:\\data dir' } });
    fireEvent.click(screen.getByTestId('mcp-create-submit'));
    await waitFor(() => expect(createCalls.length).toBe(1));
    const request = createCalls[0]!;
    expect(request.templateRef).toBe('mcp.template.filesystem');
    expect(request.templateVersion).toBe('2025-11-25');
    const transport = request.transport as { args?: string[] };
    // 每行一个参数——含空格的路径不会被拆开
    expect(transport.args).toEqual(['-y', '@modelcontextprotocol/server-filesystem', 'D:\\data dir']);
  });

  it('renders paged tool items and posts a test execution', async () => {
    renderPanel(<McpGovernancePanel />);
    const record = await screen.findByTestId('mcp-governed-record');
    fireEvent.click(record);
    await screen.findAllByTestId('mcp-tool');
    const tools = screen.getAllByTestId('mcp-tool');
    expect(tools[0]?.textContent).toContain('tool-alpha');
    fireEvent.click(screen.getAllByTestId('mcp-tool-test')[0]!);
    await waitFor(() => expect(testExecCalls.length).toBe(1));
    expect(testExecCalls[0]).toMatchObject({ serverId: 'srv-1', toolId: 'tool-alpha' });
  });

  it('posts DIAGNOSE and renders typed findings from the operation detail', async () => {
    renderPanel(<McpGovernancePanel />);
    await screen.findByTestId('mcp-governed-record');
    fireEvent.click(screen.getByTestId('mcp-diagnose'));
    await waitFor(() => expect(actionCalls.length).toBe(1));
    expect(actionCalls[0]).toEqual({ serverId: 'srv-1', action: 'DIAGNOSE' });
    const finding = await screen.findByTestId('mcp-diagnose-findings');
    expect(finding.textContent).toContain('npx resolved on PATH');
    expect(finding.textContent).toContain('no cwd pinned');
  });

  it('switches to prompts and resource-template tabs', async () => {
    renderPanel(<McpGovernancePanel />);
    fireEvent.click(await screen.findByTestId('mcp-governed-record'));
    fireEvent.click(screen.getByTestId('mcp-tab-prompts'));
    const prompt = await screen.findByTestId('mcp-prompt');
    expect(prompt.textContent).toContain('summarize');
    fireEvent.click(screen.getByTestId('mcp-tab-templates'));
    const template = await screen.findByTestId('mcp-resource-template');
    expect(template.textContent).toContain('file:///{path}');
  });

  it('PATCHes the server through the edit flow with expectedRevision', async () => {
    renderPanel(<McpGovernancePanel />);
    await screen.findByTestId('mcp-governed-record');
    fireEvent.click(screen.getByTestId('mcp-edit'));
    const name = screen.getByTestId('mcp-name') as HTMLInputElement;
    expect(name.value).toBe('Everything');
    fireEvent.change(name, { target: { value: 'Everything v2' } });
    // Governed view never exposes launch config — PATCH requires re-entering it.
    fireEvent.change(screen.getByTestId('mcp-executable'), { target: { value: 'npx' } });
    fireEvent.click(screen.getByTestId('mcp-create-submit'));
    await waitFor(() => expect(updateCalls.length).toBe(1));
    expect(updateCalls[0]!.serverId).toBe('srv-1');
    expect(updateCalls[0]!.body.expectedRevision).toBe(3);
    expect(updateCalls[0]!.body.displayName).toBe('Everything v2');
    expect(createCalls.length).toBe(0);
  });
});

describe('Hub source marking + tool availability (P0.3)', () => {
  it('marks hub-managed servers and renders the association id', async () => {
    servers = [{ ...serverRow, connectionMode: 'HUB', hubConnectionId: 'hub-conn-9' }];
    renderPanel(<McpGovernancePanel />);
    const badge = await screen.findByTestId('mcp-hub-source');
    expect(badge.textContent).toContain('Hub');
    expect(screen.getByTestId('mcp-governed-record').textContent).toContain('hub-conn-9');
  });

  it('omits the hub badge for direct/absent source marking', async () => {
    servers = [{ ...serverRow, connectionMode: 'DIRECT' }];
    renderPanel(<McpGovernancePanel />);
    await screen.findByTestId('mcp-governed-record');
    expect(screen.queryByTestId('mcp-hub-source')).toBeNull();
  });

  it('renders non-callable tool availability with its reason and no test button', async () => {
    toolItems = [
      { toolId: 'tool-alpha', title: 'Alpha', rawName: 'alpha', effectiveRisk: 'NORMAL', availability: 'AVAILABLE' },
      { toolId: 'tool-bad', title: 'Bad', rawName: 'bad', effectiveRisk: 'NORMAL',
        availability: 'INVALID_SCHEMA', availabilityReason: 'remote $ref forbidden' }
    ];
    renderPanel(<McpGovernancePanel />);
    fireEvent.click(await screen.findByTestId('mcp-governed-record'));
    await screen.findAllByTestId('mcp-tool');
    expect(screen.getAllByTestId('mcp-tool-test')).toHaveLength(1);
    const uncallable = screen.getByTestId('mcp-tool-unavailable');
    expect(uncallable.textContent).toContain('协议不合规');
    expect(uncallable.textContent).toContain('remote $ref');
  });
});

describe('OAuth consent (WU08/WU09)', () => {
  it('opens the consent URL through the safe external HTTPS path only', async () => {
    servers = [{ ...serverRow, transportKind: 'STREAMABLE_HTTP', connectionState: 'AUTH_REQUIRED' }];
    renderPanel(<McpGovernancePanel />);
    await screen.findByTestId('mcp-governed-record');
    fireEvent.click(screen.getByTestId('mcp-auth-start'));
    await waitFor(() => expect(authCalls.length).toBe(1));
    expect(authCalls[0]).toEqual({ serverId: 'srv-1', action: 'START' });
    await waitFor(() => expect(openedUrls).toEqual(['https://auth.example/consent?x=1']));
  });
});

describe('ExtensionEvidencePanel (WU08)', () => {
  it('posts CANCEL on a non-terminal invocation', async () => {
    invocations = {
      items: [{ invocationId: 'inv-1', executionId: 'exec-1', kind: 'MCP_TOOL', state: 'DISPATCHING', target: { toolId: 'tool-alpha' } }],
      nextCursor: null
    };
    renderPanel(<ExtensionEvidencePanel />);
    fireEvent.change(screen.getByTestId('evidence-execution-id'), { target: { value: 'exec-1' } });
    const row = await screen.findByTestId('evidence-invocation');
    expect(row.textContent).toContain('inv-1');
    fireEvent.click(screen.getByTestId('invocation-cancel'));
    await waitFor(() => expect(invocationActionCalls.length).toBe(1));
    expect(invocationActionCalls[0]).toMatchObject({
      executionId: 'exec-1', invocationId: 'inv-1', body: { action: 'CANCEL' }
    });
  });

  it('resumes a WAITING_INPUT invocation with the typed input object', async () => {
    invocations = {
      items: [{ invocationId: 'inv-2', executionId: 'exec-1', kind: 'MCP_TOOL', state: 'WAITING_INPUT', target: { toolId: 'tool-alpha' } }],
      nextCursor: null
    };
    renderPanel(<ExtensionEvidencePanel />);
    fireEvent.change(screen.getByTestId('evidence-execution-id'), { target: { value: 'exec-1' } });
    await screen.findByTestId('evidence-invocation');
    fireEvent.click(screen.getByTestId('invocation-resume'));
    fireEvent.change(screen.getByTestId('invocation-resume-input'), { target: { value: '{"answer":"yes"}' } });
    fireEvent.click(screen.getByTestId('invocation-resume-submit'));
    await waitFor(() => expect(invocationActionCalls.length).toBe(1));
    expect(invocationActionCalls[0]!.body).toEqual({ action: 'RESUME_INPUT', input: { answer: 'yes' } });
  });

  it('offers RECONCILE for crash-uncertain invocations', async () => {
    invocations = {
      items: [{ invocationId: 'inv-3', executionId: 'exec-1', kind: 'MCP_TOOL', state: 'UNKNOWN', effectOutcome: 'POSSIBLE' }],
      nextCursor: null
    };
    renderPanel(<ExtensionEvidencePanel />);
    fireEvent.change(screen.getByTestId('evidence-execution-id'), { target: { value: 'exec-1' } });
    const row = await screen.findByTestId('evidence-invocation');
    expect(row.textContent).toContain('POSSIBLE');
    fireEvent.click(screen.getByTestId('invocation-reconcile'));
    await waitFor(() => expect(invocationActionCalls.length).toBe(1));
    expect(invocationActionCalls[0]!.body).toEqual({ action: 'RECONCILE' });
  });
});

describe('ExtensionSelection (WU08 per-tool)', () => {
  function Harness(props: { onValue: (value: ExtensionSelectionValue) => void }): React.JSX.Element {
    const state = useExtensionSelection(true, props.onValue);
    return <ExtensionSelectionPicker state={state} />;
  }

  it('narrows a server binding to the explicitly checked tools', async () => {
    const seen: ExtensionSelectionValue[] = [];
    renderPanel(<Harness onValue={(value) => { seen.push(value); }} />);
    fireEvent.click(screen.getByTestId('extension-selection-toggle'));
    const server = await screen.findByTestId('extsel-server');
    fireEvent.click(server.querySelector('input[type="checkbox"]') as HTMLInputElement);
    // Wait for the tool catalog to resolve, then narrow to one tool.
    fireEvent.click(await screen.findByTestId('extsel-tools-toggle'));
    const checkboxes = await screen.findAllByTestId('extsel-tool');
    fireEvent.click(checkboxes[1]!.querySelector('input[type="checkbox"]') as HTMLInputElement);
    await waitFor(() => {
      const last = seen[seen.length - 1];
      const entry = last?.selection?.mcpServers?.[0];
      expect(entry?.toolIds).toEqual(['tool-alpha']);
    });
  });

  it('excludes non-callable tools from a hub-marked server binding', async () => {
    servers = [{ ...serverRow, connectionMode: 'HUB', hubConnectionId: 'hub-conn-9' }];
    toolItems = [
      { toolId: 'tool-alpha', title: 'Alpha', rawName: 'alpha', availability: 'AVAILABLE' },
      { toolId: 'tool-bad', title: 'Bad', rawName: 'bad',
        availability: 'UNSUPPORTED_SCHEMA', availabilityReason: 'remote $ref' }
    ];
    const seen: ExtensionSelectionValue[] = [];
    renderPanel(<Harness onValue={(value) => { seen.push(value); }} />);
    fireEvent.click(screen.getByTestId('extension-selection-toggle'));
    const server = await screen.findByTestId('extsel-server');
    expect(server.textContent).toContain('Hub');
    fireEvent.click(server.querySelector('input[type="checkbox"]') as HTMLInputElement);
    fireEvent.click(await screen.findByTestId('extsel-tools-toggle'));
    const toolRows = await screen.findAllByTestId('extsel-tool');
    const badInput = toolRows[1]!.querySelector('input[type="checkbox"]') as HTMLInputElement;
    expect(badInput.disabled).toBe(true);
    expect(toolRows[1]!.textContent).toContain('协议不支持');
    await waitFor(() => {
      const last = seen[seen.length - 1];
      expect(last?.selection?.mcpServers?.[0]?.toolIds).toEqual(['tool-alpha']);
    });
  });
});
