// @vitest-environment jsdom
/**
 * Hub association panel (roadmap P0.2 / W1): the guided connect flow —
 * CONNECT probe → register managed MCP → MCP CONNECT op → catalog refresh
 * → tool list. Every step is idempotent server-side, so a re-run after a
 * failure is the resume path (续办), and a reused managedServerId must
 * not create a second registry row.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HubConnectionsPanel } from '../../src/renderer/app/HubConnectionsPanel';
import type {
  HubConnectionResponse,
  McpOperationResponse,
  McpToolListResponse
} from '../../packages/protocol/src/index.js';

const connRow: HubConnectionResponse = {
  hubConnectionId: 'hub-abc123',
  displayName: 'Local Hub',
  baseUrl: 'http://127.0.0.1:19897',
  scope: 'USER',
  enabled: true,
  revision: 1,
  connectionState: 'READY'
};

let connections: HubConnectionResponse[] = [];
let registered = false;
let failNextMcpConnect = false;
let toolItems: NonNullable<McpToolListResponse['items']> = [];
let operationSeq = 0;
let operations: Record<string, McpOperationResponse> = {};
const hubActionCalls: Array<{ id: string; action: string }> = [];
const registerCalls: string[] = [];
const mcpActionCalls: Array<{ serverId: string; action: string }> = [];
const catalogRefreshCalls: string[] = [];
const toolsCalls: string[] = [];
// W3 session fixtures
let sessionRows: Array<{ sessionId: string; resourceKey: string; mode: string;
  controller: string; state: string; controlEpoch: number; generation: number }> = [];
let resourceRows: Array<{ resourceKey: string; holder: string; sessionId?: string;
  state?: string; controller?: string }> = [];
let sessionSeq = 0;
let controlShouldFail = false;
const acquireCalls: string[] = [];
const controlCalls: Array<{ sid: string; action: string }> = [];

function resetFixtures(): void {
  connections = [{ ...connRow }];
  registered = false;
  failNextMcpConnect = false;
  toolItems = [
    { toolId: 't-1', rawName: 'h_echo', title: 'Echo', effectiveRisk: 'READ_ONLY', availability: 'AVAILABLE' },
    { toolId: 't-2', rawName: 'h_shot', title: 'Snapshot', effectiveRisk: 'WRITE', availability: 'AVAILABLE' }
  ];
  operations = {};
  operationSeq = 0;
  hubActionCalls.length = 0;
  registerCalls.length = 0;
  mcpActionCalls.length = 0;
  catalogRefreshCalls.length = 0;
  toolsCalls.length = 0;
  sessionRows = [];
  resourceRows = [{ resourceKey: 'desktop:interactive', holder: 'free' }];
  sessionSeq = 0;
  controlShouldFail = false;
  acquireCalls.length = 0;
  controlCalls.length = 0;
}

function installFakeApi(): void {
  Object.defineProperty(window, 'codeAgentDesktop', {
    configurable: true,
    value: {
      listHubConnections: vi.fn(async () =>
        connections.map((c) => ({
          ...c,
          managedServerId: registered ? 'srv-hub-1' : c.managedServerId
        }))),
      registerHubConnection: vi.fn(async (body: Record<string, unknown>) => {
        const created = { ...connRow, ...body, hubConnectionId: 'hub-new01', connectionState: 'STOPPED' as const };
        connections.push(created);
        return created;
      }),
      updateHubConnection: vi.fn(async (_id: string, body: Record<string, unknown>) => ({
        ...connRow, ...body, revision: 2
      })),
      requestHubConnectionAction: vi.fn(async (id: string, action: string) => {
        hubActionCalls.push({ id, action });
        return { ...connRow, connectionState: 'READY', managedServerId: registered ? 'srv-hub-1' : null };
      }),
      registerHubManagedServer: vi.fn(async (id: string) => {
        registerCalls.push(id);
        registered = true;
        return { ...connRow, managedServerId: 'srv-hub-1', connectionState: 'READY' };
      }),
      getHubCapabilities: vi.fn(async () => ({ revision: 3, capabilities: [] })),
      // W3 resource sessions: fake lease state the panel must reflect.
      listHubSessions: vi.fn(async () => ({ sessions: sessionRows })),
      listHubResources: vi.fn(async () => ({ resources: resourceRows })),
      acquireHubSession: vi.fn(async (_id: string, body: { resourceKey?: string }) => {
        acquireCalls.push(body.resourceKey ?? '');
        const created = {
          sessionId: `rs-1-${++sessionSeq}`, resourceKey: body.resourceKey ?? '',
          mode: 'attached', controller: 'desktop-user', state: 'active',
          controlEpoch: 1, generation: 1
        };
        sessionRows.push(created);
        return created;
      }),
      controlHubSession: vi.fn(async (_id: string, sid: string, body: { action: string; expectedEpoch?: number }) => {
        controlCalls.push({ sid, action: body.action });
        const sess = sessionRows.find((s) => s.sessionId === sid);
        if (!sess) throw new Error('SESSION_NOT_FOUND');
        if (body.expectedEpoch != null && body.expectedEpoch !== sess.controlEpoch) {
          throw new Error('CONTROL_EPOCH_MISMATCH');
        }
        if (controlShouldFail) {
          controlShouldFail = false;
          throw new Error('CONTROL_EPOCH_MISMATCH');
        }
        sess.controlEpoch += 1;
        if (body.action === 'handover') { sess.state = 'paused'; sess.controller = 'human'; }
        if (body.action === 'pause') sess.state = 'paused';
        if (body.action === 'resume') { sess.state = 'active'; sess.controller = 'desktop-user'; }
        if (body.action === 'release') sess.state = 'released';
        if (body.action === 'estop') sess.state = 'paused';
        return { session: { ...sess }, cancelledRunning: body.action === 'estop' ? 1 : 0 };
      }),
      requestMcpConnectionAction: vi.fn(async (serverId: string, action: string) => {
        mcpActionCalls.push({ serverId, action });
        const op: McpOperationResponse = {
          operationId: `op-${++operationSeq}`,
          kind: action as McpOperationResponse['kind'],
          status: 'RUNNING'
        };
        operations[op.operationId as string] = op;
        return op;
      }),
      getMcpOperation: vi.fn(async (operationId: string) => {
        const op = operations[operationId];
        if (!op) return { error: 'unknown operation', code: 'MCP_OPERATION_NOT_FOUND' };
        if (op.kind === 'CONNECT' && failNextMcpConnect) {
          failNextMcpConnect = false;
          return { ...op, status: 'FAILED', detail: 'initialize refused: unreachable' };
        }
        return { ...op, status: 'SUCCEEDED' };
      }),
      refreshMcpServerCatalog: vi.fn(async (serverId: string) => {
        catalogRefreshCalls.push(serverId);
        const op: McpOperationResponse = { operationId: 'op-refresh', kind: 'CATALOG_REFRESH', status: 'RUNNING' };
        operations['op-refresh'] = op;
        return op;
      }),
      listMcpServerTools: vi.fn(async (serverId: string) => {
        toolsCalls.push(serverId);
        return { items: toolItems, nextCursor: null } satisfies McpToolListResponse;
      })
    }
  });
}

function renderPanel(): void {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } }
  });
  render(<QueryClientProvider client={queryClient}><HubConnectionsPanel /></QueryClientProvider>);
}

beforeEach(() => { resetFixtures(); installFakeApi(); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('HubConnectionsPanel guided connect (roadmap P0.2)', () => {
  it('drives probe → register → mcp connect → catalog → tools in order', async () => {
    renderPanel();
    const card = await screen.findByTestId('hub-connection-record');
    expect(card.textContent).toContain('Local Hub');
    fireEvent.click(screen.getByTestId('hub-guide-connect'));

    await waitFor(() => expect(toolsCalls.length).toBe(1), { timeout: 10000 });
    expect(hubActionCalls).toEqual([{ id: 'hub-abc123', action: 'CONNECT' }]);
    expect(registerCalls).toEqual(['hub-abc123']);
    expect(mcpActionCalls).toEqual([{ serverId: 'srv-hub-1', action: 'CONNECT' }]);
    expect(catalogRefreshCalls).toEqual(['srv-hub-1']);
    expect(toolsCalls).toEqual(['srv-hub-1']);

    for (const key of ['probe', 'register', 'mcpConnect', 'catalog', 'tools']) {
      const step = await screen.findByTestId(`hub-guide-step-${key}`);
      expect(step.textContent).toContain('完成');
    }
    const tools = await screen.findByTestId('hub-guide-tools');
    expect(tools.textContent).toContain('Echo');
  }, 15000);

  it('marks the failed step honestly and resumes on re-run without re-registering', async () => {
    failNextMcpConnect = true;
    renderPanel();
    await screen.findByTestId('hub-connection-record');
    fireEvent.click(screen.getByTestId('hub-guide-connect'));

    // First run: mcpConnect op lands FAILED → step failed, catalog never runs.
    const failed = await screen.findByTestId('hub-guide-step-mcpConnect', {}, { timeout: 10000 });
    await waitFor(() => expect(failed.textContent).toContain('失败'), { timeout: 10000 });
    expect(failed.textContent).toContain('FAILED');
    expect(screen.getByTestId('hub-guide-step-catalog').textContent).toContain('待执行');
    expect(catalogRefreshCalls.length).toBe(0);
    expect(registerCalls.length).toBe(1);

    // Resume: steps are idempotent — register reuses the existing row.
    fireEvent.click(screen.getByTestId('hub-guide-connect'));
    await waitFor(() => expect(toolsCalls.length).toBe(1), { timeout: 10000 });
    expect(registerCalls.length).toBe(1); // managedServerId reused, no second row
    expect(mcpActionCalls.filter((c) => c.action === 'CONNECT').length).toBe(2);
    for (const key of ['probe', 'register', 'mcpConnect', 'catalog', 'tools']) {
      expect(screen.getByTestId(`hub-guide-step-${key}`).textContent).toContain('完成');
    }
  }, 20000);
});

describe('HubConnectionsPanel resource sessions (W3/P1)', () => {
  it('acquires a lease on a free resource and reflects its state', async () => {
    renderPanel();
    await screen.findByTestId('hub-connection-record');
    const acquireBtn = await screen.findByTestId('hub-session-acquire-desktop:interactive');
    fireEvent.click(acquireBtn);

    await waitFor(() => expect(acquireCalls).toEqual(['desktop:interactive']));
    const sess = sessionRows[0]!;
    const row = await screen.findByTestId(`hub-session-${sess.sessionId}`);
    expect(row.textContent).toContain('desktop:interactive');
    await waitFor(() =>
      expect(screen.getByTestId(`hub-session-state-${sess.sessionId}`).textContent).toBe('控制中'));
  });

  it('handover marks the session 人工控制 via the authoritative receipt', async () => {
    sessionRows.push({
      sessionId: 'rs-1-1', resourceKey: 'desktop:interactive', mode: 'attached',
      controller: 'agent', state: 'active', controlEpoch: 1, generation: 1
    });
    resourceRows = [{ resourceKey: 'desktop:interactive', holder: 'session',
      sessionId: 'rs-1-1', state: 'active', controller: 'agent' }];
    renderPanel();
    const row = await screen.findByTestId('hub-session-rs-1-1');
    expect(row.textContent).toContain('控制中');

    fireEvent.click(screen.getByTestId('hub-session-handover-rs-1-1'));
    await waitFor(() => expect(controlCalls).toEqual([{ sid: 'rs-1-1', action: 'handover' }]));
    await waitFor(() =>
      expect(screen.getByTestId('hub-session-state-rs-1-1').textContent).toBe('人工控制'));
    expect(sessionRows[0]!.controller).toBe('human');
    expect(sessionRows[0]!.controlEpoch).toBe(2);
  });

  it('shows 控制未知 when the control call is rejected (stale epoch)', async () => {
    sessionRows.push({
      sessionId: 'rs-1-2', resourceKey: 'desktop:interactive', mode: 'attached',
      controller: 'agent', state: 'active', controlEpoch: 1, generation: 1
    });
    controlShouldFail = true;
    renderPanel();
    await screen.findByTestId('hub-session-rs-1-2');
    fireEvent.click(screen.getByTestId('hub-session-handover-rs-1-2'));

    await waitFor(() =>
      expect(screen.getByTestId('hub-session-state-rs-1-2').textContent).toBe('控制未知'));
    // The epoch was NOT bumped optimistically — the failed control left
    // the session at its last authoritative state.
    expect(sessionRows[0]!.controlEpoch).toBe(1);
  });
});
