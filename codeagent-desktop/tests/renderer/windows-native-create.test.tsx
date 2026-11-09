// @vitest-environment jsdom
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {afterEach,it,expect,vi} from 'vitest';
import {PersonalNativeTasks} from '../../src/renderer/personal/PersonalNativeTasks';
import type {DesktopApi} from '../../electron/shared/api-types';
import type {PersonalOperation} from '../../packages/protocol/src/personal';
afterEach(()=>{cleanup();localStorage.clear();});
it.each(['pi','codex'] as const)('creates %s with its original preflight rather than a Mac binding',async engine=>{
 const operation=vi.fn(async(op:PersonalOperation)=>{
  const data=op.action==='PROJECTS_AVAILABLE'?[{projectId:'source',displayName:'真实项目'}]:op.action==='REGISTER_PROJECT'?{projectId:'registered'}:op.action==='TASK_OPTIONS'?{native:{engines:[{engineId:engine,engineVersion:'1',profileId:'MANAGED',optionsRevision:'a'.repeat(64)}]},issues:[]}:op.action==='TASK_CREATE'?{taskId:'created'}:op.action==='TASK'?{taskId:'created',accepted:true,core:engine.toUpperCase(),native:{engineId:engine,state:'RUNNING'}}:op.action==='TASKS'||op.action==='NATIVE_ARTIFACTS'||op.action==='NATIVE_INPUTS'?{items:[]}:{};
  return {meta:{supportedActions:['TASK_CREATE']},data};
 });
 window.codeAgentDesktop={personalOperation:operation} as unknown as DesktopApi;
 render(<PersonalNativeTasks/>);
 await screen.findByText('真实项目');fireEvent.change(screen.getByLabelText('原生项目'),{target:{value:'source'}});
 await waitFor(()=>expect(screen.getByTestId('mac-preflight').textContent).toContain(engine));
 fireEvent.change(screen.getByLabelText('原生任务要求'),{target:{value:'修改真实检查器并补测试'}});
 fireEvent.click(screen.getByRole('button',{name:'开始原生任务'}));
 await waitFor(()=>expect(operation.mock.calls.some(([op])=>op.action==='TASK_CREATE')).toBe(true));
 const created=operation.mock.calls.map(([op])=>op).find(op=>op.action==='TASK_CREATE');
 expect(created).toMatchObject({body:{engineId:engine,projectId:'registered',optionsRevision:'a'.repeat(64)}});
 expect(JSON.parse(localStorage.getItem('desktop.personal.create')!)).toMatchObject({engineId:engine});
});
