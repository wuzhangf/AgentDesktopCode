import {describe, expect, it} from 'vitest';
import {nativeLegacyText, nativeReceiptSettled, projectNativeMessages} from '../../src/renderer/personal/nativeConversationModel';
import {emptyNativeActivity, mergeNativeActivity} from '../../src/renderer/personal/nativeActivityModel';
import type {NativeInput, NativeRequestView} from '../../packages/protocol/src/native-task';

const request: NativeInput = {kind: 'NATIVE_STEER', requestKey: 'key', content: '重复内容', generation: 'g', nativeSessionId: 's', targetCommandId: 'c'};

describe('source facts projected for the common conversation', () => {
  it('keeps cumulative output independent from local pending rows', () => {
    const view = {text: '原来的回答'};
    expect(projectNativeMessages(view, {request})).toHaveLength(1);
    expect(nativeLegacyText(view)).toBe('原来的回答');
    expect(nativeLegacyText({text: 'old + new', messageSchemaVersion: 'native-messages/1', legacy: {text: 'old'}, items: [{messageId: 'm', role: 'assistant', text: 'new'}]})).toBe('old');
  });
  it('keeps identical source messages distinct and source IDs stable across page changes', () => {
    const a = {messageId: 'a', role: 'assistant', text: '相同内容'}, b = {...a, messageId: 'b'};
    const rows = projectNativeMessages({items: [a, b]}, undefined);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.id).not.toBe(rows[1]!.id);
    expect(projectNativeMessages({items: [b]}, undefined)[0]!.id).toBe(rows[1]!.id);
  });
  it('does not merge pending input by matching text or turn', () => {
    expect(projectNativeMessages({items: [{role: 'user', text: request.content}]}, {request})).toHaveLength(2);
    expect(projectNativeMessages(undefined, {request: {...request, kind: 'INPUT_RESPONSE', inputRequestId: 'q', response: {confirmed: true}}})).toEqual([]);
  });
  it('does not treat OBSERVED/REQUESTED as a settled write', () => {
    const receipt: NativeRequestView = {kind: 'WORKER_LOCAL', requestKey: 'key', request, state: 'OBSERVED', source: {state: 'REQUESTED'}};
    expect(nativeReceiptSettled(receipt)).toBe(false);
    expect(nativeReceiptSettled({...receipt, source: {state: 'APPLIED'}})).toBe(true);
  });
  it.each(['pi', 'codex'])('merges %s tool completion across pages by original identity', engine => {
    const base = {segmentId: 'seg', nativeTurnId: 'turn'};
    const first = engine === 'pi' ? {...base, kind: 'TOOL_START', toolCallId: 'tool1', toolName: 'bash'} : {...base, kind: 'tool.started', payload: {nativeItemId: 'tool1', type: 'commandExecution'}};
    const last = engine === 'pi' ? {...base, kind: 'TOOL_END', toolCallId: 'tool1', toolName: 'bash', isError: true} : {...base, kind: 'tool.completed', payload: {nativeItemId: 'tool1', type: 'commandExecution', status: 'failed'}};
    const started = mergeNativeActivity(emptyNativeActivity(), {cursor: '1', items: [first]}, 1);
    expect(started.catchingUp).toBe(true);
    const ended = mergeNativeActivity(started, {cursor: '2', items: [last]});
    expect(ended.items).toHaveLength(1);
    expect(ended.items[0]).toMatchObject({label: '执行命令', state: 'failed'});
    expect(ended.catchingUp).toBe(false);
  });
  it('keeps tool identities isolated by source segment and never infers completion', () => {
    const item = {kind: 'TOOL_START', toolName: 'read', toolCallId: 'same', segmentId: 'one'};
    const result = mergeNativeActivity(emptyNativeActivity(), {cursor: '9007199254740993', items: [item, {...item, segmentId: 'two'}, {kind: 'ASSISTANT_MESSAGE', text: '测试成功'}]});
    expect(result.items).toHaveLength(2);
    expect(result.items.every(row => row.state === 'running')).toBe(true);
    expect(() => mergeNativeActivity(result, {cursor: '2', items: []})).toThrow('活动游标无效');
  });
  it('bounds tool history without losing cursor progress or fabricating full coverage', () => {
    let state = emptyNativeActivity();
    for (let page = 0; page < 3; page++) state = mergeNativeActivity(state, {cursor: String((page + 1) * 100), items: Array.from({length: 100}, (_, index) => ({kind: 'TOOL_START', toolCallId: `${page}-${index}`, toolName: 'read'}))});
    expect(state.items).toHaveLength(200);
    expect(state.trimmed).toBe(true);
    expect(state.cursor).toBe('300');
  });
});
