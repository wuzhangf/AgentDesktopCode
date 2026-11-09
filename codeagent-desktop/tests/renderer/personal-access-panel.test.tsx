// @vitest-environment jsdom
/**
 * UCA-001 C4: personal access surface.
 *
 * The panel must stay a consumer of the protocol: it submits bounded
 * operations (never a binding, never a URL), renders unavailable actions with
 * their reason instead of hiding them, shows the full question context before
 * an approval shape is usable, and keeps the original request id so a failed
 * send can be looked up rather than re-sent.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PersonalAccessPanel } from '../../src/renderer/app/PersonalAccessPanel';

type Operation = Record<string, unknown>;

const agent = {
  agentRef: 'a1.acs',
  displayName: '本机 ACS 会话',
  sourceKind: 'ACS_SESSION',
  availability: 'AVAILABLE' as const,
  reasonCode: null
};
const nativeAgent = {
  agentRef: 'a1.pi',
  displayName: 'Pi 原生任务',
  sourceKind: 'WORKER_NATIVE',
  availability: 'UNAVAILABLE' as const,
  reasonCode: 'TASK_BUSY',
  engineId: 'pi'
};
const conversation = { agentRef: 'a1.acs', conversationRef: 'c1.conv', title: '接入联调' };
const view = {
  agentRef: 'a1.acs',
  conversationRef: 'c1.conv',
  title: '接入联调',
  observedAt: '2026-10-24T00:00:00Z',
  sourceState: 'RUNNING',
  executions: [],
  message: { availability: 'AVAILABLE', reasonCode: null, meaning: 'append', binding: 'b1.send' },
  actions: [
    { actionId: 'execution.stop', label: '停止', availability: 'AVAILABLE', reasonCode: null, inputKind: 'NONE', binding: 'b1.stop', context: { runId: 'run-7', question: '是否停止当前执行？' } },
    { actionId: 'execution.pause', label: '暂停', availability: 'UNSUPPORTED', reasonCode: 'NO_CHECKPOINT_API', inputKind: 'NONE', binding: 'b1.pause' }
  ],
  actionsTruncated: false
};
const replyPage = {
  representation: 'MESSAGES' as const,
  revision: '1',
  items: [
    { replyRef: 'r1.me', role: 'user' as const, text: '你好', contentRevision: '1', textComplete: true },
    { replyRef: 'r1.out', role: 'assistant' as const, text: 'UCA-ACS-OK', contentRevision: '1', textComplete: true }
  ],
  nextCursor: null,
  coverage: 'BOUNDED_HISTORY'
};

let operations: Operation[] = [];
let connected = false;
let sendFails = false;

function statusPayload() {
  return {
    configured: true,
    connected,
    origin: 'https://127.0.0.1:9443',
    basePath: '/personal/v1/client',
    caPinned: true,
    encryptionAvailable: true,
    tokenPersisted: true,
    hasToken: true,
    ...(connected ? {
      manifest: {
        protocolVersion: 'client-access/1',
        storeId: 'store-desktop-0001',
        authorizationRevision: '4',
        features: { conversationCreate: true, replyContent: true }
      }
    } : {})
  };
}

function installApi(): void {
  Object.defineProperty(window, 'codeAgentDesktop', {
    configurable: true,
    value: {
      personalAccess: vi.fn(async (operation: Operation) => {
        operations.push(operation);
        switch (operation.action) {
          case 'STATUS':
            return statusPayload();
          case 'CONFIGURE':
            return statusPayload();
          case 'CONNECT':
            connected = true;
            return statusPayload();
          case 'DISCONNECT':
            connected = false;
            return statusPayload();
          case 'AGENTS':
            return { items: [agent, nativeAgent] };
          case 'CONVERSATIONS':
            return { items: [conversation], nextCursor: null, truncated: false };
          case 'CONVERSATION':
            return view;
          case 'REPLIES':
            return replyPage;
          case 'SEND':
            if (sendFails) return { error: 'outcome unconfirmed', code: 'SOURCE_OUTCOME_UNCONFIRMED' };
            return { requestId: operation.requestId, accepted: true, sourceStatus: 'ACCEPTED', consumed: false, observedAt: 'now' };
          case 'ACTION':
            return { requestId: operation.requestId, accepted: true, sourceStatus: 'ACCEPTED', consumed: true, observedAt: 'now' };
          case 'LOOKUP':
            return { requestId: operation.requestId, accepted: true, sourceStatus: 'APPLIED', consumed: true, observedAt: 'now' };
          default:
            return {};
        }
      })
    }
  });
}

describe('personal access surface', () => {
  beforeEach(() => {
    operations = [];
    connected = false;
    sendFails = false;
    installApi();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('shows the unconfigured state without pretending to be connected', async () => {
    render(<PersonalAccessPanel onBack={() => undefined} />);
    await waitFor(() => expect(screen.getByTestId('personal-access-status').textContent).toBe('未配置'));
    expect(screen.getByRole('button', { name: '保存并连接' })).toBeTruthy();
    expect(operations.filter((operation) => operation.action === 'CONNECT')).toHaveLength(0);
  });

  it('connects, lists sources, and opens a conversation with polled replies', async () => {
    render(<PersonalAccessPanel onBack={() => undefined} />);
    await waitFor(() => expect(screen.getByTestId('personal-access-status').textContent).toBe('已配置，未连接'));

    fireEvent.change(screen.getByPlaceholderText('https://127.0.0.1:9443'), { target: { value: 'https://127.0.0.1:9443' } });
    fireEvent.click(screen.getByRole('button', { name: '保存并连接' }));

    await waitFor(() => expect(screen.getByTestId('personal-access-status').textContent).toBe('已连接'));
    const configure = operations.find((operation) => operation.action === 'CONFIGURE');
    expect(configure).toMatchObject({ origin: 'https://127.0.0.1:9443', basePath: '/personal/v1/client' });

    await waitFor(() => expect(screen.getByText('本机 ACS 会话')).toBeTruthy());
    expect(screen.getByText(/TASK_BUSY/)).toBeTruthy();

    fireEvent.click(screen.getByText('本机 ACS 会话'));
    await waitFor(() => expect(screen.getByText('接入联调')).toBeTruthy());
    fireEvent.click(screen.getByText('接入联调'));

    await waitFor(() => expect(screen.getByText('UCA-ACS-OK')).toBeTruthy());
    expect(operations.some((operation) => operation.action === 'CONVERSATION')).toBe(true);
    expect(operations.some((operation) => operation.action === 'REPLIES')).toBe(true);
  });

  it('keeps unavailable actions visible with their reason code', async () => {
    render(<PersonalAccessPanel onBack={() => undefined} />);
    await waitFor(() => expect(screen.getByTestId('personal-access-status').textContent).toBe('已配置，未连接'));
    fireEvent.click(screen.getByRole('button', { name: '保存并连接' }));
    await waitFor(() => expect(screen.getByText('本机 ACS 会话')).toBeTruthy());
    fireEvent.click(screen.getByText('本机 ACS 会话'));
    await waitFor(() => expect(screen.getByText('接入联调')).toBeTruthy());
    fireEvent.click(screen.getByText('接入联调'));
    await waitFor(() => expect(screen.getByTestId('personal-access-actions')).toBeTruthy());

    const pause = screen.getByRole('button', { name: /暂停/ });
    expect((pause as HTMLButtonElement).disabled).toBe(true);
    expect(pause.textContent).toContain('NO_CHECKPOINT_API');
  });

  it('shows the question context before an approval shape can be used', async () => {
    render(<PersonalAccessPanel onBack={() => undefined} />);
    await waitFor(() => expect(screen.getByTestId('personal-access-status').textContent).toBe('已配置，未连接'));
    fireEvent.click(screen.getByRole('button', { name: '保存并连接' }));
    await waitFor(() => expect(screen.getByText('本机 ACS 会话')).toBeTruthy());
    fireEvent.click(screen.getByText('本机 ACS 会话'));
    await waitFor(() => expect(screen.getByText('接入联调')).toBeTruthy());
    fireEvent.click(screen.getByText('接入联调'));
    await waitFor(() => expect(screen.getByRole('button', { name: '停止' })).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: '停止' }));
    expect(screen.getByTestId('personal-access-draft').textContent).toContain('是否停止当前执行？');

    fireEvent.click(screen.getByRole('button', { name: '提交' }));
    await waitFor(() => expect(operations.some((operation) => operation.action === 'ACTION')).toBe(true));
    const action = operations.find((operation) => operation.action === 'ACTION');
    expect(action).toMatchObject({ actionId: 'execution.stop', input: {} });
    expect(action).not.toHaveProperty('binding');
  });

  it('submits only the conversation reference and text, then looks up a failed send', async () => {
    render(<PersonalAccessPanel onBack={() => undefined} />);
    await waitFor(() => expect(screen.getByTestId('personal-access-status').textContent).toBe('已配置，未连接'));
    fireEvent.click(screen.getByRole('button', { name: '保存并连接' }));
    await waitFor(() => expect(screen.getByText('本机 ACS 会话')).toBeTruthy());
    fireEvent.click(screen.getByText('本机 ACS 会话'));
    await waitFor(() => expect(screen.getByText('接入联调')).toBeTruthy());
    fireEvent.click(screen.getByText('接入联调'));
    await waitFor(() => expect(screen.getByPlaceholderText('输入消息…')).toBeTruthy());

    sendFails = true;
    fireEvent.change(screen.getByPlaceholderText('输入消息…'), { target: { value: '继续' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));

    await waitFor(() => expect(screen.getByTestId('personal-access-failure').textContent).toContain('SOURCE_OUTCOME_UNCONFIRMED'));
    const send = operations.find((operation) => operation.action === 'SEND');
    expect(send).toMatchObject({ conversationRef: 'c1.conv', text: '继续' });
    expect(send).not.toHaveProperty('binding');
    expect(typeof send?.requestId).toBe('string');

    fireEvent.click(screen.getByRole('button', { name: /查询回执/ }));
    await waitFor(() => expect(operations.some((operation) => operation.action === 'LOOKUP')).toBe(true));
    const lookup = operations.find((operation) => operation.action === 'LOOKUP');
    expect(lookup?.requestId).toBe(send?.requestId);
  });
});
