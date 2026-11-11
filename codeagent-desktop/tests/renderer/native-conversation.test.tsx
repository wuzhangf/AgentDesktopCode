// @vitest-environment jsdom
import {act, cleanup, fireEvent, render, renderHook, screen, waitFor} from '@testing-library/react';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {NativeConversation} from '../../src/renderer/personal/NativeConversation';
import {useNativeConversation} from '../../src/renderer/personal/useNativeConversation';
import type {PersonalOperation} from '../../packages/protocol/src/personal';
import type {DesktopApi} from '../../electron/shared/api-types';

const detail = {taskId: 'task1', displayName: '代码任务', accepted: true, core: 'CODEX', sourceStoreId: 'store', native: {engineId: 'codex', state: 'RUNNING', generation: 'gen', nativeSessionId: 'thread', nativeTurnId: 'turn', currentCommandId: 'command', quiescent: false, capabilities: {stop: true, steer: true, followUp: false, pause: false, resume: false}}};
const input = {requestKey: 'original-key', kind: 'NATIVE_STEER', content: '补充原任务', generation: 'gen', nativeSessionId: 'thread', targetCommandId: 'command'};
function api(override?: (op: PersonalOperation) => unknown | Promise<unknown>) {
  const operation = vi.fn(async (op: PersonalOperation) => {
    const custom = await override?.(op);
    const data = custom ?? (op.action === 'TASK' ? detail
      : op.action === 'TASK_MESSAGES' ? {text: '## 公开回答\n\n```ts\nconst answer = 42;\n```'}
      : op.action === 'TASK_ACTIVITY' ? {items: [], cursor: op.afterCursor ?? '0'}
      : op.action === 'NATIVE_ARTIFACTS' || op.action === 'NATIVE_INPUTS' ? {items: []} : {});
    return {meta: {supportedActions: []}, data};
  });
  window.codeAgentDesktop = {personalOperation: operation} as unknown as DesktopApi;
  return operation;
}
afterEach(() => {cleanup(); localStorage.clear(); vi.useRealTimers(); vi.restoreAllMocks();});

describe('native conversation in the shared workbench', () => {
  it('uses the target Codex message contract as the primary view without repeating compatibility text', async () => {
    api(op => op.action === 'TASK_MESSAGES' ? {
      messageSchemaVersion: 'native-messages/1', historyMode: 'STRUCTURED_FROM_START', legacy: null,
      text: '不得重复绘制的兼容累计文本', items: [
        {messageId: 'user-one', sequence: '1', revision: '2', role: 'user', text: '检查目标合同', status: 'CONSUMED'},
        {messageId: 'assistant-one', sequence: '2', revision: '1', role: 'assistant', text: '**逐条回复**', status: 'COMPLETED'},
      ],
    } : undefined);
    render(<NativeConversation taskId="task1" />);
    await screen.findByText('逐条回复');
    expect(screen.getByTestId('native-message-source-user-one').textContent).toContain('来源已消费');
    expect(screen.getByTestId('native-message-source-assistant-one').textContent).toContain('本条回复已完成');
    expect(screen.queryByTestId('native-accumulated-output')).toBeNull();
    expect(screen.queryByText('不得重复绘制的兼容累计文本')).toBeNull();
    expect(screen.getByTestId('native-task-state').textContent).toBe('执行中');
  });
  it('renders safe Markdown and keeps Codex output with a pending local message', async () => {
    localStorage.setItem('desktop.personal.input.task1', JSON.stringify(input));
    const operation = api();
    const view = render(<NativeConversation taskId="task1" />);
    await screen.findByText('公开回答');
    expect(view.container.querySelector('.content-code-block')).not.toBeNull();
    expect(screen.getByTestId('native-accumulated-output').textContent).toContain('const answer = 42');
    expect(screen.getByText('补充原任务')).toBeTruthy();
    expect(screen.queryByRole('button', {name: '请求边界暂停'})).toBeNull();
    expect(operation.mock.calls.some(([op]) => op.action === 'TASK_CREATE')).toBe(false);
  });
  it('reuses message styling for Pi, with original approval options and guards', async () => {
    const question = {inputRequestId: 'q', method: 'item/commandExecution/requestApproval', title: '允许读取源码？', options: ['accept', 'decline'], state: 'PENDING', generation: 'qgen', nativeSessionId: 'qs', nativeTurnId: 'qt', targetCommandId: 'qc'};
    const operation = api(op => op.action === 'TASK' ? {...detail, core: 'PI', native: {...detail.native, engineId: 'pi'}}
      : op.action === 'TASK_MESSAGES' ? {items: [{role: 'user', text: '检查项目'}, {role: 'assistant', text: '**收到**'}]}
      : op.action === 'NATIVE_INPUTS' ? {items: [question]} : undefined);
    const view = render(<NativeConversation taskId="task1" />);
    await screen.findByText('检查项目');
    expect(view.container.querySelector('.message.message-flat.user .content')?.textContent).toBe('检查项目');
    expect(view.container.querySelector('.message.assistant strong')?.textContent).toBe('收到');
    fireEvent.click(await screen.findByRole('button', {name: '拒绝'}));
    await waitFor(() => expect(operation.mock.calls.some(([op]) => op.action === 'NATIVE_INPUT_RESPONSE')).toBe(true));
    expect(operation.mock.calls.map(([op]) => op).find(op => op.action === 'NATIVE_INPUT_RESPONSE')).toMatchObject({body: {inputRequestId: 'q', generation: 'qgen', nativeSessionId: 'qs', nativeTurnId: 'qt', targetCommandId: 'qc', response: {decision: 'decline'}}});
  });
  it('keeps drafts per task across remounts and does not send when unavailable', async () => {
    const operation = api(op => op.action === 'TASK' ? {...detail, native: {...detail.native, capabilities: {}}} : undefined);
    const first = render(<NativeConversation taskId="task1" />);
    await screen.findByText('公开回答');
    fireEvent.change(screen.getByLabelText('输入消息'), {target: {value: '保留草稿'}});
    fireEvent.keyDown(screen.getByLabelText('输入消息'), {key: 'Enter', ctrlKey: true});
    expect(operation.mock.calls.some(([op]) => op.action === 'NATIVE_MESSAGE_CREATE')).toBe(false);
    first.rerender(<NativeConversation taskId="task2" />);
    expect((screen.getByLabelText('输入消息') as HTMLTextAreaElement).value).toBe('');
    first.rerender(<NativeConversation taskId="task1" />);
    expect((screen.getByLabelText('输入消息') as HTMLTextAreaElement).value).toBe('保留草稿');
  });
  it('persists the original request through transport failure and permits read-only reconciliation', async () => {
    const operation = api(op => {
      if (op.action === 'NATIVE_MESSAGE_CREATE') throw new Error('response lost');
      if (op.action === 'TASK_INTERACTION_REQUEST') return {state: 'OBSERVED', source: {state: 'REQUESTED'}};
      return undefined;
    });
    render(<NativeConversation taskId="task1" />);
    await screen.findByText('公开回答');
    fireEvent.change(screen.getByLabelText('输入消息'), {target: {value: '不要重复发送'}});
    fireEvent.click(screen.getByRole('button', {name: '补充当前任务'}));
    await screen.findByText('response lost');
    const original = JSON.parse(localStorage.getItem('desktop.personal.input.task1')!);
    fireEvent.click(screen.getByRole('button', {name: '状态'}));
    fireEvent.click(await screen.findByRole('button', {name: '核对发送结果'}));
    await waitFor(() => expect(operation).toHaveBeenCalledWith({action: 'TASK_INTERACTION_REQUEST', taskId: 'task1', requestKey: original.requestKey}));
    expect(screen.queryByRole('button', {name: '保留回执并继续'})).toBeNull();
    expect(operation.mock.calls.filter(([op]) => op.action === 'NATIVE_MESSAGE_CREATE')).toHaveLength(1);
  });
});

describe('native observation scheduling', () => {
  it('updates approvals independently of slow messages, never overlaps polls, and discards unmounted results', async () => {
    vi.useFakeTimers();
    let finish!: (value: unknown) => void;
    const operation = api(op => op.action === 'TASK_MESSAGES' ? new Promise(resolve => {finish = resolve;})
      : op.action === 'NATIVE_INPUTS' ? {items: [{inputRequestId: 'pending', state: 'PENDING'}]} : undefined);
    const hook = renderHook(() => useNativeConversation('task1'));
    await act(async () => {});
    expect(hook.result.current.inputRequests).toHaveLength(1);
    await act(async () => {await vi.advanceTimersByTimeAsync(10000);});
    expect(operation.mock.calls.filter(([op]) => op.action === 'TASK_MESSAGES')).toHaveLength(1);
    hook.unmount();
    await act(async () => {finish({text: '迟到消息'});});
    await act(async () => {await vi.advanceTimersByTimeAsync(5000);});
    expect(operation.mock.calls.filter(([op]) => op.action === 'TASK_MESSAGES')).toHaveLength(1);
  });
  it('continues the event cursor, keeps last good messages on error, and clears recovered read errors', async () => {
    let fail = false;
    const operation = api(op => {
      if (op.action === 'TASK_MESSAGES' && fail) throw new Error('temporarily offline');
      if (op.action === 'TASK_ACTIVITY') return op.afterCursor === '0' ? {items: [{kind: 'TOOL_START', toolName: 'bash', toolCallId: 'x'}], cursor: '4'}
        : op.afterCursor === '4' ? {items: [{kind: 'TOOL_END', toolName: 'bash', toolCallId: 'x', isError: false}], cursor: '5'} : {items: [], cursor: '5'};
      return undefined;
    });
    const hook = renderHook(() => useNativeConversation('task1'));
    await waitFor(() => expect(hook.result.current.messagesView?.text).toContain('公开回答'));
    fail = true;
    await act(async () => {await hook.result.current.refresh();});
    expect(hook.result.current.messagesView?.text).toContain('公开回答');
    expect(hook.result.current.readErrors['对话']).toBe('temporarily offline');
    expect(hook.result.current.activity.items[0]?.state).toBe('completed');
    expect(operation).toHaveBeenCalledWith({action: 'TASK_ACTIVITY', taskId: 'task1', afterCursor: '4', limit: '100'});
    fail = false;
    await act(async () => {await hook.result.current.refresh();});
    expect(hook.result.current.readErrors).toEqual({});
  });
});
