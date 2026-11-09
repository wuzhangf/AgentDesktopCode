// @vitest-environment jsdom
// NEW (Codex structured conversation phase 1, design 2026-10-29 §5/§7/§9):
// jsdom coverage for paging gating (schema + transport marks), LEGACY_PREFIX
// display, pending merge, transcriptRevision-triggered history re-reads,
// slow/stale response guards and the serial poll.
import {act, cleanup, fireEvent, render, screen, waitFor} from '@testing-library/react';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {NativeConversation} from '../../src/renderer/personal/NativeConversation';
import type {DesktopApi} from '../../electron/shared/api-types';
import type {PersonalOperation} from '../../packages/protocol/src/personal';
import {NATIVE_MESSAGE_SCHEMA_VERSION, NATIVE_MESSAGE_TRANSPORT_VERSION} from '../../packages/protocol/src/native-task';

const DETAIL = {
  taskId: 't1', accepted: true, core: 'CODEX', sourceStoreId: 'store-1',
  executionBinding: {kind: 'WORKER_LOCAL', connectionId: 'c1', storeId: 'store-1', localTaskId: 'local-1', engineId: 'codex', engineVersion: '1'},
  native: {engineId: 'codex', state: 'RUNNING', generation: 'g1', nativeSessionId: 's1', currentCommandId: 'cmd1', capabilities: {stop: true, steer: true, followUp: true}, quiescent: false},
};
const env = (data: unknown) => ({meta: {supportedActions: []}, data});

function msgItem(sequence: number, revision: number, role: string, text: string, status: string, extra: Record<string, unknown> = {}) {
  return {messageId: `m-${sequence}`, sequence: String(sequence), revision: String(revision), role, text, status, ...extra};
}
function msgPage(items: ReturnType<typeof msgItem>[], over: Record<string, unknown> = {}) {
  return {
    messageSchemaVersion: NATIVE_MESSAGE_SCHEMA_VERSION,
    taskId: 'local-1', storeId: 'store-1', transcriptRevision: '1',
    items,
    firstSequence: items[0]?.sequence ?? null,
    cursor: items[0]?.sequence ?? null,
    latestSequence: items[items.length - 1]?.sequence ?? null,
    hasMore: false, cursorExpired: false,
    historyMode: 'STRUCTURED_FROM_START', legacy: null,
    text: '累计输出不应重复渲染', coverage: 'BOUNDED_PUBLIC_MESSAGES',
    messageTransportVersion: NATIVE_MESSAGE_TRANSPORT_VERSION,
    ...over,
  };
}

type Route = (op: PersonalOperation) => unknown;
/** Operation mock: TASK_MESSAGES and friends route through `route`; every
 * other fixed operation answers a harmless empty view. */
function gateway(route: Route) {
  const operation = vi.fn(async (op: PersonalOperation) => {
    if (op.action === 'TASK_MESSAGES' || op.action === 'TASK' || op.action === 'TASK_INTERACTION_REQUEST' || op.action === 'TASK_COMMAND_CREATE') {
      return env(route(op));
    }
    if (op.action === 'NATIVE_ARTIFACTS' || op.action === 'NATIVE_INPUTS') return env({items: []});
    return env({});
  });
  window.codeAgentDesktop = {personalOperation: operation} as unknown as DesktopApi;
  return operation;
}
const callsWhere = (operation: ReturnType<typeof vi.fn>, pred: (op: PersonalOperation) => boolean) =>
  operation.mock.calls.map(([op]) => op).filter(pred);
const focus = async () => { await act(async () => { window.dispatchEvent(new Event('focus')); }); };

afterEach(() => { cleanup(); localStorage.clear(); vi.useRealTimers(); });

describe('native-messages/1 conversation paging', () => {
  it('recovers messages skipped between recent snapshots from the gap cursor', async () => {
    let changed = false;
    const operation = gateway(op => {
      if (op.action === 'TASK') return DETAIL;
      if (op.action === 'TASK_MESSAGES' && op.cursor !== undefined) {
        expect(op.cursor).toBe('2');
        return msgPage([3, 4, 5, 6, 7, 8].map(seq => msgItem(seq, 1, 'assistant', `补读回复${seq}`, 'COMPLETED')));
      }
      return changed
        ? msgPage([msgItem(8, 1, 'assistant', '新快照回复', 'COMPLETED')], {hasMore: true})
        : msgPage([msgItem(1, 1, 'user', '第一条', 'ACCEPTED'), msgItem(2, 1, 'assistant', '第二条', 'COMPLETED')]);
    });
    render(<NativeConversation taskId="t1" />);
    await screen.findByText('第二条');
    changed = true;
    await focus();
    await screen.findByText('新快照回复');
    fireEvent.click(screen.getByTestId('native-newer-notice'));
    await screen.findByText('补读回复3');
    expect(callsWhere(operation, op => op.action === 'TASK_MESSAGES' && op.cursor === '2')).toHaveLength(1);
    expect(screen.queryByTestId('native-newer-notice')).toBeNull();
  });

  it('reads the recent page first and pages earlier only via before=firstSequence', async () => {
    const operation = gateway((op) => {
      if (op.action === 'TASK') return DETAIL;
      if (op.action === 'TASK_MESSAGES' && 'before' in op && op.before === '9') {
        return msgPage([msgItem(5, 1, 'assistant', '更早回复5', 'COMPLETED'), msgItem(6, 1, 'assistant', '更早回复6', 'COMPLETED')], {hasMore: false});
      }
      if (op.action === 'TASK_MESSAGES') {
        return msgPage([msgItem(9, 1, 'assistant', '最近回复9', 'COMPLETED'), msgItem(10, 1, 'assistant', '最近回复10', 'COMPLETED')], {hasMore: true, latestSequence: '10'});
      }
      return {};
    });
    render(<NativeConversation taskId="t1" />);
    const earlier = await screen.findByTestId('native-load-earlier');
    // First read is the un-paged recent page — no cursor/before is sent.
    expect(callsWhere(operation, (op) => op.action === 'TASK_MESSAGES').length).toBeGreaterThan(0);
    expect(callsWhere(operation, (op) => op.action === 'TASK_MESSAGES' && (op.before !== undefined || op.cursor !== undefined))).toHaveLength(0);
    fireEvent.click(earlier);
    await waitFor(() => expect(callsWhere(operation, (op) => op.action === 'TASK_MESSAGES' && op.before === '9').length).toBeGreaterThan(0));
    await screen.findByText('更早回复5');
    // The earlier window merged ahead of the tail rows, order intact.
    const rows = screen.getByTestId('native-message-list').querySelectorAll('[data-testid^="native-message-source-"]');
    expect(rows).toHaveLength(4);
    expect(rows[0]!.textContent).toContain('更早回复5');
    expect(rows[3]!.textContent).toContain('最近回复10');
    expect(callsWhere(operation, (op) => op.action === 'TASK_MESSAGES' && op.cursor !== undefined)).toHaveLength(0);
  });

  it('never sends paging params when the transport mark is absent, however much hasMore claims', async () => {
    const page = msgPage([msgItem(9, 1, 'assistant', '快照回复', 'COMPLETED')], {hasMore: true});
    delete (page as Record<string, unknown>).messageTransportVersion;
    const operation = gateway((op) => op.action === 'TASK' ? DETAIL : page);
    render(<NativeConversation taskId="t1" />);
    await screen.findByTestId('native-paging-note');
    expect(screen.queryByTestId('native-load-earlier')).toBeNull();
    await focus();
    expect(callsWhere(operation, (op) => op.action === 'TASK_MESSAGES' && (op.before !== undefined || op.cursor !== undefined))).toHaveLength(0);
  });

  it('shows the frozen legacy block beside new rows for LEGACY_PREFIX tasks', async () => {
    const page = msgPage([msgItem(9, 1, 'assistant', '边界之后的新回复', 'COMPLETED')], {
      historyMode: 'LEGACY_PREFIX',
      legacy: {text: '冻结的累计公开输出', textTruncated: false},
    });
    gateway((op) => op.action === 'TASK' ? DETAIL : page);
    render(<NativeConversation taskId="t1" />);
    const block = await screen.findByTestId('native-accumulated-output');
    expect(block.textContent).toContain('累计公开输出 · 来源未提供这部分逐条历史');
    expect(block.textContent).toContain('冻结的累计公开输出');
    await screen.findByText('边界之后的新回复');
    // The page's cumulative `text` is not drawn as a second body.
    expect(screen.queryByText('累计输出不应重复渲染')).toBeNull();
  });

  it('keeps cumulative text rendering for old hosts without the schema mark and never pages', async () => {
    const operation = gateway((op) => op.action === 'TASK' ? DETAIL : {text: '旧累计助手输出', turns: {}, coverage: 'BOUNDED'});
    render(<NativeConversation taskId="t1" />);
    const out = await screen.findByTestId('native-accumulated-output');
    expect(out.textContent).toContain('旧累计助手输出');
    await focus();
    expect(callsWhere(operation, (op) => op.action === 'TASK_MESSAGES' && (op.before !== undefined || op.cursor !== undefined))).toHaveLength(0);
  });

  it('merges a local pending write into the source user row by sourceRequestKey', async () => {
    const request = {kind: 'NATIVE_FOLLOW_UP', requestKey: 'desktop-input-k1', content: '本端要求', generation: 'g1', nativeSessionId: 's1', targetCommandId: 'cmd1'};
    localStorage.setItem('desktop.personal.input.t1', JSON.stringify(request));
    const page = msgPage([
      msgItem(1, 1, 'user', '本端要求', 'ACCEPTED', {messageId: 'u-local', sourceRequestKey: 'desktop-input-k1'}),
      msgItem(2, 1, 'user', '手机端要求', 'CONSUMED', {messageId: 'u-remote', sourceRequestKey: 'mobile-hash-9'}),
    ]);
    gateway((op) => op.action === 'TASK' ? DETAIL : page);
    render(<NativeConversation taskId="t1" />);
    await screen.findByTestId('native-message-source-u-local');
    // One visual row for the local write — the pending-* row never appears.
    expect(screen.queryByTestId('native-message-pending-desktop-input-k1')).toBeNull();
    await screen.findByTestId('native-message-source-u-remote'); // other-end row visible without local cache
    expect(screen.getByTestId('native-message-list').querySelectorAll('[data-testid^="native-message-source-"]')).toHaveLength(2);
    // The original request-receipt card keeps driving its own state machine.
    fireEvent.click(screen.getByRole('button', {name: '状态'}));
    await screen.findByTestId('native-input-pending');
  });

  it('shows 历史同步中 on a confirmed pending write whose source row is unread', async () => {
    const request = {kind: 'NATIVE_FOLLOW_UP', requestKey: 'desktop-input-k2', content: '还未回读的要求', generation: 'g1', nativeSessionId: 's1', targetCommandId: 'cmd1'};
    localStorage.setItem('desktop.personal.input.t1', JSON.stringify(request));
    const page = msgPage([msgItem(9, 1, 'assistant', '回复', 'COMPLETED')]);
    gateway((op) => {
      if (op.action === 'TASK') return DETAIL;
      if (op.action === 'TASK_INTERACTION_REQUEST') return {kind: 'WORKER_LOCAL', requestKey: 'desktop-input-k2', request, state: 'OBSERVED', source: {state: 'ACCEPTED'}};
      return page;
    });
    render(<NativeConversation taskId="t1" />);
    fireEvent.click(screen.getByRole('button', {name: '状态'}));
    await screen.findByTestId('native-input-pending');
    fireEvent.click(screen.getByRole('button', {name: '核对发送结果'}));
    await waitFor(() => expect(screen.getByTestId('native-message-pending-desktop-input-k2').textContent).toContain('来源已受理，历史同步中'));
  });

  it('re-reads at most two loaded history windows when transcriptRevision moves', async () => {
    const revision = {value: '1'};
    const operation = gateway((op) => {
      if (op.action === 'TASK') return DETAIL;
      if (op.action !== 'TASK_MESSAGES') return {};
      if (op.before === '9') return msgPage([msgItem(5, 1, 'assistant', '窗口5-8上', 'COMPLETED'), msgItem(6, 1, 'assistant', '窗口5-8下', 'COMPLETED')], {hasMore: true, transcriptRevision: revision.value});
      if (op.before === '5') return msgPage([msgItem(1, 1, 'assistant', '窗口1-4', 'COMPLETED')], {hasMore: false, transcriptRevision: revision.value});
      return msgPage([msgItem(9, 1, 'assistant', '尾部9', 'COMPLETED'), msgItem(10, 1, 'assistant', '尾部10', 'COMPLETED')], {hasMore: true, latestSequence: '10', transcriptRevision: revision.value});
    });
    render(<NativeConversation taskId="t1" />);
    fireEvent.click(await screen.findByTestId('native-load-earlier'));
    await screen.findByText('窗口5-8上');
    fireEvent.click(await screen.findByTestId('native-load-earlier'));
    await screen.findByText('窗口1-4');
    const beforeCalls = () => callsWhere(operation, (op) => op.action === 'TASK_MESSAGES' && op.before !== undefined);
    expect(beforeCalls()).toHaveLength(2);
    revision.value = '2'; // source status update bumps the transcript revision
    await focus();
    await waitFor(() => expect(beforeCalls().length).toBeGreaterThanOrEqual(4));
    // At most two windows re-read per revision move — the two most recent.
    const refreshed = beforeCalls().slice(2).map((op) => op.before);
    expect(new Set(refreshed)).toEqual(new Set(['9', '5']));
    expect(refreshed.length).toBe(2);
  });

  it('surfaces 有新消息 when the snapshot advances and catches up via cursor', async () => {
    const latest = {value: '12'};
    const operation = gateway((op) => {
      if (op.action === 'TASK') return DETAIL;
      if (op.action !== 'TASK_MESSAGES') return {};
      if (op.cursor === '12') return msgPage([msgItem(13, 1, 'assistant', '新回复13', 'COMPLETED'), msgItem(14, 1, 'assistant', '新回复14', 'COMPLETED')], {hasMore: false, latestSequence: '14'});
      return msgPage([msgItem(9, 1, 'assistant', '回复9', 'COMPLETED'), msgItem(12, 1, 'assistant', '回复12', 'COMPLETED')], {latestSequence: latest.value});
    });
    render(<NativeConversation taskId="t1" />);
    await screen.findByText('回复12');
    latest.value = '14';
    await focus();
    const notice = await screen.findByTestId('native-newer-notice');
    expect(callsWhere(operation, (op) => op.action === 'TASK_MESSAGES' && op.cursor !== undefined)).toHaveLength(0);
    fireEvent.click(notice);
    await waitFor(() => expect(callsWhere(operation, (op) => op.action === 'TASK_MESSAGES' && op.cursor === '12').length).toBeGreaterThan(0));
    await screen.findByText('新回复14');
    await waitFor(() => expect(screen.queryByTestId('native-newer-notice')).toBeNull());
  });

  it('keeps the last good rows and the working STOP across a message read failure', async () => {
    let round = 0;
    const operation = gateway((op) => {
      if (op.action === 'TASK') return DETAIL;
      if (op.action === 'TASK_COMMAND_CREATE') return {kind: 'WORKER_LOCAL', requestKey: 'desktop-stop-x', request: {}, state: 'OBSERVED', source: {state: 'REQUESTED'}};
      if (op.action !== 'TASK_MESSAGES') return {};
      round += 1;
      if (round === 1) return msgPage([msgItem(9, 1, 'assistant', '成功读取的回复', 'COMPLETED')]);
      throw new Error('来源消息读取超时');
    });
    render(<NativeConversation taskId="t1" />);
    await screen.findByText('成功读取的回复');
    await focus();
    // The per-channel read error surfaces on the observation banner while
    // the last good view stays mounted.
    await screen.findByText(/对话.*暂不可读|暂不可读.*对话/);
    expect(screen.getByText('成功读取的回复')).toBeTruthy(); // last good view kept
    fireEvent.click(screen.getByRole('button', {name: '状态'}));
    const stop = await screen.findByRole('button', {name: '停止原生任务'}) as HTMLButtonElement;
    expect(stop.disabled).toBe(false);
    // Two-step stop: the first click only arms, the second within the window fires.
    fireEvent.click(stop);
    expect(callsWhere(operation, (op) => op.action === 'TASK_COMMAND_CREATE')).toHaveLength(0);
    fireEvent.click(await screen.findByRole('button', {name: '再点一次确认停止'}));
    await waitFor(() => expect(callsWhere(operation, (op) => op.action === 'TASK_COMMAND_CREATE').length).toBeGreaterThan(0));
  });

  it('a refresh requested mid-read is coalesced and applies the in-flight result', async () => {
    const resolvers: {op: PersonalOperation; resolve: (value: unknown) => void}[] = [];
    const operation = vi.fn(async (op: PersonalOperation) => {
      if (op.action === 'TASK_MESSAGES') return new Promise((resolve) => resolvers.push({op, resolve}));
      if (op.action === 'TASK') return env(DETAIL);
      if (op.action === 'NATIVE_ARTIFACTS' || op.action === 'NATIVE_INPUTS') return env({items: []});
      return env({});
    });
    window.codeAgentDesktop = {personalOperation: operation} as unknown as DesktopApi;
    render(<NativeConversation taskId="t1" />);
    await waitFor(() => expect(resolvers).toHaveLength(1)); // round 1 hangs on /messages
    await focus(); // refresh is coalesced into the in-flight round — no second read
    await act(async () => {
      await Promise.resolve();
    });
    expect(resolvers).toHaveLength(1);
    await act(async () => {
      resolvers[0]!.resolve(env(msgPage([{...msgItem(20, 1, 'assistant', '较新快照', 'COMPLETED')}])));
    });
    await screen.findByText('较新快照');
  });

  it('never overlaps poll rounds while a messages read is still in flight', async () => {
    vi.useFakeTimers();
    const operation = vi.fn((op: PersonalOperation) => {
      if (op.action === 'TASK_MESSAGES') return new Promise(() => {}); // never resolves
      if (op.action === 'TASK') return Promise.resolve(env(DETAIL));
      return Promise.resolve(env({items: []}));
    });
    window.codeAgentDesktop = {personalOperation: operation} as unknown as DesktopApi;
    render(<NativeConversation taskId="t1" />);
    await vi.advanceTimersByTimeAsync(10); // let the first round reach /messages
    await vi.advanceTimersByTimeAsync(30000); // many intervals pass mid-read
    expect(callsWhere(operation, (op) => op.action === 'TASK')).toHaveLength(1);
  });

  it('shows a reachable 有新消息 notice when rows arrive while scrolled up', async () => {
    let extra = false;
    const page = () => msgPage(extra
      ? [msgItem(9, 1, 'assistant', '旧回复', 'COMPLETED'), msgItem(10, 1, 'assistant', '滚动外的新回复', 'COMPLETED')]
      : [msgItem(9, 1, 'assistant', '旧回复', 'COMPLETED')], {latestSequence: extra ? '10' : '9'});
    gateway((op) => op.action === 'TASK' ? DETAIL : page());
    render(<NativeConversation taskId="t1" />);
    await screen.findByText('旧回复');
    const body = screen.getByTestId('native-conversation-body');
    // jsdom has no layout — stub the geometry of a user scrolled far above.
    Object.defineProperty(body, 'scrollHeight', {value: 2000, configurable: true});
    Object.defineProperty(body, 'clientHeight', {value: 200, configurable: true});
    Object.defineProperty(body, 'scrollTop', {value: 0, configurable: true, writable: true});
    await act(async () => { fireEvent.scroll(body); });
    extra = true;
    await focus();
    await screen.findByText('滚动外的新回复');
    await screen.findByTestId('native-newer-notice');
  });

  it('labels assistant completion as 本条回复已完成, never 任务已完成', async () => {
    gateway((op) => op.action === 'TASK' ? DETAIL : msgPage([msgItem(9, 1, 'assistant', '完成正文', 'COMPLETED')]));
    render(<NativeConversation taskId="t1" />);
    await screen.findByText('本条回复已完成');
    expect(screen.queryByText('任务已完成')).toBeNull();
  });

  it('queued task shows position, slot occupancy and the start-of-run deadline', async () => {
    const queued = {
      ...DETAIL,
      native: {
        ...DETAIL.native, state: 'QUEUED', launchState: 'QUEUED', quiescent: true,
        deadlineMs: 3600000, deadlineEpochMillis: String(Date.now() + 600000),
        queue: {position: 2, activeTasks: 4, maxActiveTasks: 4},
        lastEventAt: new Date(Date.now() - 300000).toISOString(), lastEventKind: 'INTENT_QUEUED',
      },
    };
    gateway((op) => op.action === 'TASK' ? queued : msgPage([]));
    render(<NativeConversation taskId="t1" />);
    const progress = await screen.findByTestId('native-progress');
    await waitFor(() => expect(progress.textContent).toContain('排队中'));
    expect(progress.textContent).toContain('第 2 位');
    expect(progress.textContent).toContain('槽位 4/4');
    expect(progress.textContent).toContain('开跑起算');
    expect(progress.textContent).not.toContain('时限剩余');
    expect(progress.textContent).not.toContain('无响应');
  });
});
