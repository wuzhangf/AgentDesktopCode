// @vitest-environment jsdom
import {act, cleanup, fireEvent, render, screen, waitFor} from '@testing-library/react';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {PersonalNativeTasks} from '../../src/renderer/personal/PersonalNativeTasks';
import type {PersonalOperation} from '../../packages/protocol/src/personal';
import type {DesktopApi} from '../../electron/shared/api-types';

afterEach(() => {cleanup(); localStorage.clear();});

describe('native observation ordering',()=>{
 it('keeps polling serial and never rolls back a newer STOP observation with a delayed old read',async()=>{
  vi.useFakeTimers();
  try{
   localStorage.setItem('desktop.personal.task',JSON.stringify('task-1'));
   let taskReads=0,resolveOld!:(value:unknown)=>void;
   const old=new Promise(resolve=>{resolveOld=resolve;});
   const detail=(quiescent:boolean)=>({taskId:'task-1',accepted:true,native:{engineId:'codex',state:'SUCCEEDED',generation:'generation',nativeSessionId:'session',nativeTurnId:'turn',currentCommandId:'command',quiescent,capabilities:{stop:!quiescent}}});
   const operation=vi.fn(async(op:PersonalOperation)=>{
    if(op.action==='TASK'){taskReads++;if(taskReads===2)return old;return {meta:{supportedActions:[]},data:detail(taskReads>=3)};}
    const data=op.action==='TASK_COMMAND_CREATE'?{kind:'WORKER_LOCAL',requestKey:op.key,request:op.body,state:'OBSERVED',source:{state:'APPLIED'}}:op.action==='PROJECTS_AVAILABLE'?[]:{items:[]};
    return {meta:{supportedActions:[]},data};
   });
   window.codeAgentDesktop={personalOperation:operation} as unknown as DesktopApi;
   await act(async()=>{render(<PersonalNativeTasks/>);});
   await act(async()=>{await vi.advanceTimersByTimeAsync(2500);});
   expect(taskReads).toBe(2);
   await act(async()=>{await vi.advanceTimersByTimeAsync(10000);});
   expect(taskReads).toBe(2);
   await act(async()=>{fireEvent.click(screen.getByRole('button',{name:'停止原生任务'}));});
   expect(taskReads).toBe(3);
   expect(JSON.parse(screen.getByTestId('task-facts').textContent!).native.quiescent).toBe(true);
   await act(async()=>{resolveOld({meta:{supportedActions:[]},data:{...detail(false),sourceError:'LOCAL_REPLY_UNCONFIRMED'}});});
   const facts=JSON.parse(screen.getByTestId('task-facts').textContent!);
   expect(facts.native.quiescent).toBe(true);expect(facts.sourceError).toBeUndefined();
   expect(operation.mock.calls.filter(([op])=>op.action==='TASK_COMMAND_CREATE')).toHaveLength(1);
   expect(operation.mock.calls.some(([op])=>op.action==='TASK_CREATE')).toBe(false);
  }finally{cleanup();vi.useRealTimers();}
 });
});

describe('Mac task STOP receipt recovery', () => {
  it.each([false, undefined])('restores the original STOP key and permits only a read when source stop capability is %s', async stopCapability => {
    const request = {requestKey: 'original-stop', kind: 'STOP', generation: 'generation-1', nativeSessionId: null, nativeTurnId: null, targetCommandId: 'command-1'};
    localStorage.setItem('desktop.personal.task', JSON.stringify('task-1'));
    localStorage.setItem('desktop.personal.stop.task-1', JSON.stringify(request));
    const operation = vi.fn(async (op: PersonalOperation) => {
      const data = op.action === 'TASK' ? {taskId: 'task-1', accepted: true, core: 'MACOS', native: {engineId: 'macos', state: 'RECOVERY_REQUIRED', capabilities: {stop: stopCapability}, localQuiescent: false, remoteStopConfirmed: true, quiescent: false}}
        : op.action === 'TASK_INTERACTION_REQUEST' ? {kind: 'WORKER_LOCAL', requestKey: request.requestKey, request, state: 'OBSERVED', source: {state: 'REQUESTED'}}
        : op.action === 'PROJECTS_AVAILABLE' ? [] : op.action === 'NATIVE_ARTIFACTS' ? {items: []} : {};
      return {meta: {supportedActions: []}, data};
    });
    window.codeAgentDesktop = {personalOperation: operation} as unknown as DesktopApi;
    render(<PersonalNativeTasks />);
    const button = await screen.findByRole('button', {name: '查看停止状态'});
    await waitFor(() => expect(screen.getByTestId('task-facts').textContent).toContain('RECOVERY_REQUIRED'));
    expect((button as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(button);
    await waitFor(() => expect(operation).toHaveBeenCalledWith({action: 'TASK_INTERACTION_REQUEST', taskId: 'task-1', requestKey: 'original-stop'}));
    expect(operation.mock.calls.some(([op]) => op.action === 'TASK_COMMAND_CREATE' || op.action === 'TASK_CREATE')).toBe(false);
    expect(screen.getByTestId('stop-facts').textContent).toContain('original-stop');
  });
});

describe('rejected STOP needs a new explicit intent',()=>{
 it.each(['REJECTED','UNKNOWN','OBSERVED'] as const)('only offers preparation after an authoritative %s receipt',async state=>{
  const old={requestKey:'old-stop',kind:'STOP',generation:'old-generation',nativeSessionId:'thread',nativeTurnId:'old-turn',targetCommandId:'old-command'};
  localStorage.setItem('desktop.personal.task',JSON.stringify('task-1'));localStorage.setItem('desktop.personal.stop.task-1',JSON.stringify(old));
  const operation=vi.fn(async(op:PersonalOperation)=>{const data=op.action==='TASK'?{taskId:'task-1',accepted:true,sourceStoreId:'store',native:{engineId:'codex',state:'FAILED',generation:'new-generation',nativeSessionId:'thread',nativeTurnId:'new-turn',currentCommandId:'new-command',capabilities:{stop:true}}}:op.action==='TASK_INTERACTION_REQUEST'?{kind:'WORKER_LOCAL',requestKey:old.requestKey,request:old,state,sourceError:'NATIVE_TARGET_CHANGED'}:op.action==='TASK_COMMAND_CREATE'?{kind:'WORKER_LOCAL',requestKey:op.key,request:op.body,state:'OBSERVED',source:{state:'APPLIED'}}:op.action==='PROJECTS_AVAILABLE'?[]:{items:[]};return {meta:{supportedActions:[]},data};});
  window.codeAgentDesktop={personalOperation:operation} as unknown as DesktopApi;render(<PersonalNativeTasks/>);
  fireEvent.click(await screen.findByRole('button',{name:'查看停止状态'}));await waitFor(()=>expect(screen.getByTestId('stop-facts').textContent).toContain(state));
  if(state!=='REJECTED'){expect(screen.queryByRole('button',{name:'保留拒绝回执并准备新停止'})).toBeNull();expect(operation.mock.calls.some(([op])=>op.action==='TASK_COMMAND_CREATE')).toBe(false);return;}
  fireEvent.click(await screen.findByRole('button',{name:'保留拒绝回执并准备新停止'}));
  await waitFor(()=>expect(localStorage.getItem('desktop.personal.stop.task-1')).toBeNull());
  expect(JSON.parse(localStorage.getItem('desktop.personal.stop-history.task-1')!)[0].request).toEqual(old);
  expect(operation.mock.calls.some(([op])=>op.action==='TASK_COMMAND_CREATE')).toBe(false);
  fireEvent.click(screen.getByRole('button',{name:'停止原生任务'}));
  await waitFor(()=>expect(operation.mock.calls.some(([op])=>op.action==='TASK_COMMAND_CREATE')).toBe(true));
  const sent=operation.mock.calls.map(([op])=>op).find(op=>op.action==='TASK_COMMAND_CREATE');
  expect(sent).toMatchObject({body:{kind:'STOP',generation:'new-generation',nativeSessionId:'thread',nativeTurnId:'new-turn',targetCommandId:'new-command'}});
  expect(sent&&'key'in sent?sent.key:'').not.toBe(old.requestKey);
 });
});
