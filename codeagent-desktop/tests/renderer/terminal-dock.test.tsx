// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TerminalDock } from '../../src/renderer/app/TerminalDock';

let onTerminalOpen: (() => void) | undefined;

class MockTerminal {
  written: Array<string | Uint8Array> = [];
  cols = 80;
  rows = 24;
  buffer = { active: { length: 0, get: () => undefined } };
  private dataCb: ((data: string) => void) | undefined;
  private resizeCb: ((size: { cols: number; rows: number }) => void) | undefined;
  open(): void { onTerminalOpen?.(); }
  dispose(): void {}
  focus(): void {}
  reset(): void { this.written.length = 0; }
  loadAddon(): void {}
  write(data: string | Uint8Array): void { this.written.push(data); }
  onData(cb: (data: string) => void): void { this.dataCb = cb; }
  onResize(cb: (size: { cols: number; rows: number }) => void): void { this.resizeCb = cb; }
  attachCustomKeyEventHandler(): void {}
  hasSelection(): boolean { return false; }
  getSelection(): string { return ''; }
  emitData(data: string): void { this.dataCb?.(data); }
  emitResize(cols: number, rows: number): void {
    this.cols = cols;
    this.rows = rows;
    this.resizeCb?.({ cols, rows });
  }
}

const terminalInstances: MockTerminal[] = [];
const queryClients: QueryClient[] = [];

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    constructor() {
      const term = new MockTerminal();
      terminalInstances.push(term);
      return term as unknown as MockTerminal;
    }
  }
}));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit(): void {} } }));
vi.mock('@xterm/xterm/css/xterm.css', () => ({}));

vi.stubGlobal('ResizeObserver', class {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
});

function latestTerm(): MockTerminal {
  const term = terminalInstances[terminalInstances.length - 1];
  if (!term) throw new Error('TerminalView has not mounted an emulator');
  return term;
}

function writtenText(term: MockTerminal): string {
  return term.written.map((chunk) => typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk)).join('');
}

interface RemoteSession {
  terminalSessionId: string;
  businessSessionId: string;
  workspaceExecutionId: string | null;
  createdByRunId: string | null;
  serviceInstanceId: string;
  state: string;
  stateVersion: number;
  lifetimeScope: string;
  profile: string;
  terminalMode: string;
  inputPolicy: string;
  controller: string;
  columns: number;
  rows: number;
  outputCursor: string | null;
  outputBytes: number;
  inputVersion: number;
  startedAt: string | null;
  lastActivityAt: string | null;
  expiresAt: string | null;
  exitCode: number | null;
  terminalCause: string | null;
  controlState: string;
  controlVersion: number;
  controlEpoch: number;
  canAcquire: boolean;
  canInput: boolean;
  safeHolderLabel: string | null;
  remainingControlTtlMillis: number;
  allowedActions: Record<string, boolean>;
}

function baseSession(overrides: Partial<RemoteSession> = {}): RemoteSession {
  return {
    terminalSessionId: 'term-1',
    businessSessionId: 'session-1',
    workspaceExecutionId: 'exec-1',
    createdByRunId: null,
    serviceInstanceId: 'svc-1',
    state: 'RUNNING',
    stateVersion: 4,
    lifetimeScope: 'BUSINESS_SESSION',
    profile: 'USER_SHELL',
    terminalMode: 'LINE_STREAM',
    inputPolicy: 'USER_ONLY',
    controller: 'NONE',
    columns: 120,
    rows: 32,
    outputCursor: 'c0',
    outputBytes: 0,
    inputVersion: 0,
    startedAt: null,
    lastActivityAt: null,
    expiresAt: null,
    exitCode: null,
    terminalCause: null,
    controlState: 'FREE',
    controlVersion: 2,
    controlEpoch: 0,
    canAcquire: true,
    canInput: false,
    safeHolderLabel: null,
    remainingControlTtlMillis: 0,
    allowedActions: {
      canReadOutput: true, canWriteInput: true, canResize: true,
      canInterrupt: true, canTerminate: true, canClose: true,
      canAgentWrite: false, canUserWrite: true
    },
    ...overrides
  };
}

function renderDock(
  sessionOverrides: Partial<RemoteSession> = {},
  apiOverrides: Record<string, unknown> = {},
  outputOverrides: Record<string, unknown> = {}
) {
  const remote = baseSession(sessionOverrides);
  const remoteList = [remote];
  const workspaceItems: Array<Record<string, unknown>> = [{
    workspaceExecutionId: 'exec-1', projectId: 'project-1', workspaceRef: 'repo', state: 'IN_USE', leaseExpired: false
  }];
  const api = {
    remoteList,
    listTerminalSessions: vi.fn(async () => remoteList),
    getTerminalSession: vi.fn(async () => remote),
    getTerminalOutput: vi.fn(async () => ({
      terminalSessionId: 'term-1', startCursor: 'c0', nextCursor: 'c1',
      startOffset: 0, endOffset: 7, plainText: 'hello\r\n', mode: 'PLAIN_TEXT',
      state: 'RUNNING', eof: true, historyIncomplete: false, gap: false,
      serviceInstanceId: remote.serviceInstanceId,
      ...outputOverrides
    })),
    listWorkspaceExecutions: vi.fn(async () => ({ items: workspaceItems })),
    createWorkspaceExecution: vi.fn(async (body: Record<string, unknown>) => {
      const created = {
        workspaceExecutionId: 'exec-session-1', projectId: String(body.workspaceAlias ?? 'project-1'),
        workspaceRef: `${body.workspaceAlias}@worktree`, kind: 'WORKTREE',
        ownerType: 'SESSION', ownerId: String(body.ownerId ?? 'session-1'),
        state: 'IN_USE', stateVersion: 1, leaseExpired: false
      };
      workspaceItems.push(created);
      return created;
    }),
    createTerminalSession: vi.fn(async (_bsid: string, body: Record<string, unknown>) => {
      const created = baseSession({
        terminalSessionId: `term-${remoteList.length + 1}`,
        profile: String(body.profile ?? 'USER_SHELL'),
        terminalMode: String(body.terminalMode ?? 'FULL_VT')
      });
      remoteList.push(created);
      return created;
    }),
    acquireTerminalControl: vi.fn(async () => {
      remote.controlEpoch += 1;
      remote.controlVersion += 1;
      remote.controlState = 'HELD';
      remote.controller = 'USER';
      remote.canInput = true;
      return {
        terminalSessionId: remote.terminalSessionId, state: 'HELD',
        controlVersion: remote.controlVersion, controlEpoch: remote.controlEpoch,
        leaseId: 'lease-1', remainingTtlMillis: 30_000, canInput: true,
        leaseCurrentlyValid: true, terminalStateVersion: remote.stateVersion,
        delivery: 'APPLIED'
      };
    }),
    renewTerminalControl: vi.fn(async () => ({ delivery: 'APPLIED', leaseId: 'lease-1', controlEpoch: remote.controlEpoch })),
    releaseTerminalControl: vi.fn(async () => {
      remote.controlState = 'FREE';
      remote.controller = 'NONE';
      return { delivery: 'APPLIED' };
    }),
    writeTerminalInput: vi.fn(async (_id: string, body: { operationId: string }) => {
      remote.inputVersion += 1;
      return { operationId: body.operationId, inputVersion: remote.inputVersion, delivery: 'APPLIED' };
    }),
    resizeTerminalSession: vi.fn(async (_id: string, body: { columns: number; rows: number; resizeSequence: number }) => {
      remote.columns = body.columns;
      remote.rows = body.rows;
      return { columns: body.columns, rows: body.rows, resizeSequence: body.resizeSequence };
    }),
    signalTerminalSession: vi.fn(async () => ({ signal: 'INTERRUPT', delivery: 'APPLIED', stateVersion: remote.stateVersion, accepted: true })),
    closeTerminalSession: vi.fn(async (id: string) => {
      const closed = remoteList.find(session => session.terminalSessionId === id);
      if (closed) closed.state = 'CLOSED';
      return { accepted: true, finalState: 'CLOSED' };
    }),
    openExternalHttps: vi.fn(async () => ({})),
    ...apiOverrides
  };
  Object.defineProperty(window, 'codeAgentDesktop', { configurable: true, value: api });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  queryClients.push(queryClient);
  render(<QueryClientProvider client={queryClient}><TerminalDock businessSessionId="session-1" projectId="project-1" enabled /></QueryClientProvider>);
  return api;
}

afterEach(async () => {
  cleanup();
  for (const client of queryClients.splice(0)) {
    await client.cancelQueries();
    client.clear();
  }
  onTerminalOpen = undefined;
  terminalInstances.length = 0;
  window.localStorage.removeItem('codeagent.terminal.autoStart');
});

describe('TerminalDock', () => {
  it('reads bounded Service output through a cursor into the emulator', async () => {
    const api = renderDock();
    await waitFor(() => expect(writtenText(latestTerm())).toContain('hello'));
    await waitFor(() => expect(api.getTerminalOutput).toHaveBeenCalledWith('term-1', expect.objectContaining({
      cursor: undefined, maxBytes: 64 * 1024, mode: 'PLAIN_TEXT'
    })));
  });

  it('requests RAW_VT bytes for FULL_VT sessions', async () => {
    const api = renderDock({ terminalMode: 'FULL_VT' }, {}, {
      plainText: null,
      dataBase64: btoa('vt-bytes'),
      mode: 'RAW_VT'
    });
    await waitFor(() => expect(api.getTerminalOutput).toHaveBeenCalledWith('term-1', expect.objectContaining({ mode: 'RAW_VT' })));
    await waitFor(() => expect(writtenText(latestTerm())).toContain('vt-bytes'));
  });

  it('starts a FULL_VT shell from a preset and auto-takes a FREE lease', async () => {
    const api = renderDock();
    await waitFor(() => expect(writtenText(latestTerm())).toContain('hello'));
    await waitFor(() => expect(api.acquireTerminalControl).toHaveBeenCalledWith('term-1', expect.objectContaining({ expectedControlVersion: 2 })));
    fireEvent.click(screen.getByRole('button', { name: /PowerShell/ }));
    await waitFor(() => expect(api.createTerminalSession).toHaveBeenCalledWith('session-1', expect.objectContaining({
      workspaceExecutionId: 'exec-session-1', profile: 'USER_SHELL', inputPolicy: 'USER_ONLY',
      terminalMode: 'FULL_VT', lifetimeScope: 'BUSINESS_SESSION', executable: 'powershell'
    })));
  });

  it('provisions a session-owned worktree when no live writer lease exists', async () => {
    const api = renderDock({}, {
      listWorkspaceExecutions: vi.fn(async () => ({ items: [{
        workspaceExecutionId: 'exec-dead', projectId: 'project-1', workspaceRef: 'repo', state: 'RECLAIMED', leaseExpired: true
      }] }))
    });
    await waitFor(() => expect((screen.getByRole('button', { name: /PowerShell/ }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: /PowerShell/ }));
    await waitFor(() => expect(api.createWorkspaceExecution).toHaveBeenCalledWith(expect.objectContaining({
      workspaceAlias: 'project-1', kind: 'WORKTREE', ownerType: 'SESSION',
      ownerId: 'session-1', startPolicy: 'USER_WIP_SNAPSHOT'
    })));
    await waitFor(() => expect(api.createTerminalSession).toHaveBeenCalledWith('session-1', expect.objectContaining({
      workspaceExecutionId: 'exec-session-1'
    })));
  });

  it('retries with a fresh session workspace when the lease dies mid-create', async () => {
    const api = renderDock();
    api.createTerminalSession
      .mockRejectedValueOnce(Object.assign(new Error('Workspace execution does not have a live writer lease'), { code: 'WORKSPACE_LEASE_LOST' }))
      .mockImplementation(async (_bsid: string, body: Record<string, unknown>) => {
        const created = baseSession({
          terminalSessionId: 'term-recovered',
          profile: String(body.profile ?? 'USER_SHELL'),
          terminalMode: String(body.terminalMode ?? 'FULL_VT')
        });
        api.remoteList.push(created);
        return created;
      });
    await waitFor(() => expect((screen.getByRole('button', { name: /PowerShell/ }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: /PowerShell/ }));
    await waitFor(() => expect(api.createWorkspaceExecution).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(api.createTerminalSession).toHaveBeenCalledTimes(2));
    expect(api.createTerminalSession).toHaveBeenLastCalledWith('session-1', expect.objectContaining({
      workspaceExecutionId: 'exec-session-1'
    }));
  });

  it('sends emulator keystrokes as versioned input after the implicit lease', async () => {
    const api = renderDock();
    await waitFor(() => expect(api.acquireTerminalControl).toHaveBeenCalled());
    latestTerm().emitData('dir\r');
    await waitFor(() => expect(api.writeTerminalInput).toHaveBeenCalledWith('term-1', expect.objectContaining({
      text: 'dir\r', expectedStateVersion: 4, expectedInputVersion: 0,
      leaseId: 'lease-1', controlEpoch: 1
    })));
  });

  it('pushes emulator-driven resize through the leased control channel', async () => {
    const api = renderDock();
    await waitFor(() => expect(api.acquireTerminalControl).toHaveBeenCalled());
    latestTerm().emitResize(100, 30);
    await waitFor(() => expect(api.resizeTerminalSession).toHaveBeenCalledWith('term-1', expect.objectContaining({
      columns: 100, rows: 30, resizeSequence: 1, leaseId: 'lease-1', controlEpoch: 1
    })), { timeout: 2000 });
  });

  it('gates input behind an explicit takeover when another controller holds the lease', async () => {
    const api = renderDock({ controlState: 'HELD', controller: 'AGENT', safeHolderLabel: 'Agent' });
    await waitFor(() => expect(writtenText(latestTerm())).toContain('hello'));
    expect(api.acquireTerminalControl).not.toHaveBeenCalled();
    latestTerm().emitData('x');
    await waitFor(() => expect(screen.getByText(/先点“接管控制”再输入/)).toBeTruthy());
    expect(api.writeTerminalInput).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '接管控制' }));
    await waitFor(() => expect(api.acquireTerminalControl).toHaveBeenCalled());
    latestTerm().emitData('dir\r');
    await waitFor(() => expect(api.writeTerminalInput).toHaveBeenCalledWith('term-1', expect.objectContaining({ text: 'dir\r' })));
  });

  it('does not replay UNKNOWN input and releases the control lease on cleanup', async () => {
    const api = renderDock();
    api.writeTerminalInput.mockResolvedValue({ operationId: 'op', inputVersion: 1, delivery: 'UNKNOWN' });
    await waitFor(() => expect(api.acquireTerminalControl).toHaveBeenCalled());
    latestTerm().emitData('secret');
    await waitFor(() => expect(screen.getByText(/输入未确认（UNKNOWN）/)).toBeTruthy());
    expect(api.writeTerminalInput).toHaveBeenCalledTimes(1);
    cleanup();
    await waitFor(() => expect(api.releaseTerminalControl).toHaveBeenCalledWith('term-1', expect.objectContaining({ leaseId: 'lease-1', controlEpoch: 1 })));
  });

  it('surfaces a detected loopback dev-server URL and opens it through main', async () => {
    const api = renderDock({}, {}, { plainText: 'Local: http://localhost:5173/\r\n' });
    await waitFor(() => expect(screen.getByRole('button', { name: /打开 http:\/\/localhost:5173/ })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /打开 http:\/\/localhost:5173/ }));
    await waitFor(() => expect(api.openExternalHttps).toHaveBeenCalledWith('http://localhost:5173/'));
  });

  it('shows exit code and restarts a session created from this dock', async () => {
    const api = renderDock({ state: 'EXITED', exitCode: 0, canAcquire: false });
    api.createTerminalSession.mockImplementation(async (_bsid: string, body: Record<string, unknown>) => {
      const created = baseSession({
        terminalSessionId: `term-${api.remoteList.length + 1}`,
        state: 'EXITED',
        exitCode: 0,
        canAcquire: false,
        profile: String(body.profile ?? 'USER_SHELL'),
        terminalMode: String(body.terminalMode ?? 'FULL_VT')
      });
      api.remoteList.push(created);
      return created;
    });
    await waitFor(() => expect((screen.getByRole('button', { name: /PowerShell/ }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: /PowerShell/ }));
    await waitFor(() => expect(api.createTerminalSession).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getAllByText('退出码 0').length).toBeGreaterThan(0));
    fireEvent.click(screen.getByRole('button', { name: '重启' }));
    await waitFor(() => expect(api.createTerminalSession).toHaveBeenCalledTimes(2));
    expect(api.createTerminalSession).toHaveBeenLastCalledWith('session-1', expect.objectContaining({ executable: 'powershell' }));
  });

  it('marks Agent-owned sessions and shows the current controller', async () => {
    renderDock({ profile: 'DIRECT_PROCESS', createdByRunId: 'run-abcdef123456', controlState: 'HELD', controller: 'AGENT', safeHolderLabel: 'Agent' });
    await waitFor(() => expect(screen.getAllByText(/Agent/).length).toBeGreaterThan(0));
    await waitFor(() => expect(screen.getByText('Agent控制中')).toBeTruthy());
  });

  it('closes an orphaned terminal without needing a control lease', async () => {
    const api = renderDock({
      terminalCause: 'WORKSPACE_LEASE_LOST', canAcquire: false, canInput: false,
      allowedActions: {
        canReadOutput: false, canWriteInput: false, canResize: false,
        canInterrupt: false, canTerminate: false, canClose: true,
        canAgentWrite: false, canUserWrite: false
      }
    });
    await waitFor(() => expect(screen.getByText('工作区租约失效')).toBeTruthy());
    const closeButton = screen.getByRole('button', { name: '关闭' }) as HTMLButtonElement;
    expect(closeButton.disabled).toBe(false);
    fireEvent.click(closeButton);
    await waitFor(() => expect(api.closeTerminalSession).toHaveBeenCalledWith('term-1', expect.objectContaining({
      leaseId: 'orphan'
    })));
    expect(api.acquireTerminalControl).not.toHaveBeenCalled();
  });

  it('closes the visible orphan even when clicked as its emulator first attaches', async () => {
    // Child view attachment precedes the dock's passive snapshot-ref effect.
    // This reproduces a click arriving after the button renders but before
    // that effect has run. Native click stays inside render's outer act; a
    // nested fireEvent/act during React's passive-effect flush is invalid.
    onTerminalOpen = () => {
      onTerminalOpen = undefined;
      (screen.getByRole('button', { name: '关闭' }) as HTMLButtonElement).click();
    };
    const api = renderDock({
      terminalCause: 'WORKSPACE_LEASE_LOST', canAcquire: false, canInput: false,
      allowedActions: {
        canReadOutput: false, canWriteInput: false, canResize: false,
        canInterrupt: false, canTerminate: false, canClose: true,
        canAgentWrite: false, canUserWrite: false
      }
    });
    await waitFor(() => expect(api.closeTerminalSession).toHaveBeenCalledWith('term-1', expect.objectContaining({
      leaseId: 'orphan', expectedStateVersion: 4
    })));
    expect(api.closeTerminalSession).toHaveBeenCalledTimes(1);
    expect(api.acquireTerminalControl).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByText('终端已关闭（CLOSED）。')).toBeTruthy());
  });

  it('does not close a regular terminal before its control snapshot attaches', async () => {
    let earlyCloseCalls: number | undefined;
    let earlyAcquireCalls: number | undefined;
    onTerminalOpen = () => {
      onTerminalOpen = undefined;
      (screen.getByRole('button', { name: '关闭' }) as HTMLButtonElement).click();
      earlyCloseCalls = vi.mocked(window.codeAgentDesktop.closeTerminalSession).mock.calls.length;
      earlyAcquireCalls = vi.mocked(window.codeAgentDesktop.acquireTerminalControl).mock.calls.length;
    };
    const api = renderDock();
    await waitFor(() => expect(writtenText(latestTerm())).toContain('hello'));
    expect(earlyCloseCalls).toBe(0);
    expect(earlyAcquireCalls).toBe(0);
    expect(api.closeTerminalSession).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '关闭' }));
    await waitFor(() => expect(api.closeTerminalSession).toHaveBeenCalledWith('term-1', expect.objectContaining({
      leaseId: 'lease-1'
    })));
    expect(api.acquireTerminalControl).toHaveBeenCalledTimes(1);
  });

  it('keeps the 终端 title to the panel chrome — the dock renders at most one', async () => {
    renderDock();
    await waitFor(() => expect(writtenText(latestTerm())).toContain('hello'));
    // T1/T2: no inner header/context duplicates; WorkPane owns the title.
    expect(screen.queryAllByText('终端').length).toBeLessThanOrEqual(1);
    expect(screen.queryByText(/当前工作区 · /)).toBeNull();
  });

  it('auto-starts a PowerShell when the panel opens on a session with no terminal', async () => {
    const api = renderDock({}, { listTerminalSessions: vi.fn(async () => []) });
    await waitFor(() => expect(api.createTerminalSession).toHaveBeenCalledWith('session-1', expect.objectContaining({
      executable: 'powershell', profile: 'USER_SHELL', lifetimeScope: 'BUSINESS_SESSION'
    })));
  });

  it('does not auto-start when the preference is off', async () => {
    window.localStorage.setItem('codeagent.terminal.autoStart', '0');
    const api = renderDock({}, { listTerminalSessions: vi.fn(async () => []) });
    await waitFor(() => expect(api.listTerminalSessions).toHaveBeenCalled());
    await new Promise((resolve) => { setTimeout(resolve, 50); });
    expect(api.createTerminalSession).not.toHaveBeenCalled();
    // The empty state keeps a single primary action.
    expect(screen.getByRole('button', { name: '启动 PowerShell' })).toBeTruthy();
  });

  it('opens the command input as its own row from the ▾ menu', async () => {
    renderDock();
    await waitFor(() => expect(writtenText(latestTerm())).toContain('hello'));
    fireEvent.click(screen.getByRole('button', { name: '更多终端选项' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: /运行命令/ }));
    const commandForm = document.querySelector('.terminal-run-command');
    expect(commandForm).toBeTruthy();
    // Own full-width row — not squeezed inside the tab bar next to + ▾.
    expect((commandForm as HTMLElement).parentElement?.classList.contains('terminal-dock')).toBe(true);
    expect(screen.getByLabelText('在终端中运行命令')).toBeTruthy();
  });

  it('fail-closes when the service reports PTY unavailable', () => {
    cleanup();
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    render(<QueryClientProvider client={queryClient}><TerminalDock businessSessionId="session-1" projectId="project-1" enabled={false} unavailableReason="TERMINAL_CONFIG_DISABLED" /></QueryClientProvider>);
    expect(screen.getByText(/fail-closed/)).toBeTruthy();
    expect(screen.getByText(/TERMINAL_CONFIG_DISABLED/)).toBeTruthy();
  });
});
