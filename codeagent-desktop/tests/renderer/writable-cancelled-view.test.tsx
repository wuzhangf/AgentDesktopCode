// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { WritableCollaborationPanel } from '../../src/renderer/app/WritableCollaborationPanel';
afterEach(cleanup);
it('keeps cancelled partial effects and child history readable while disabling new paid work', async () => {
 const record = { schemaVersion: 'writable-collaboration-record/1', revision: '4', groupId: 'group' };
 const child = { ...record, kind: 'CHILD', entityId: 'child', state: 'CANDIDATE_READY', unitId: 'unit', attempt: '1', quiescent: true, sessionId: 'child-session', objectiveMessageId: 'goal', resultMessageId: 'answer' };
 const adoption = { ...record, kind: 'ADOPTION', entityId: 'adoption', state: 'RECONCILIATION_REQUIRED', effectState: 'PARTIALLY_APPLIED', contentApplied: false, contextCommitted: false };
 const group = { ...record, kind: 'GROUP', entityId: 'group', state: 'RECONCILIATION_REQUIRED', cancelRequested: true, children: [child], adoptions: [adoption] };
 const api = vi.fn(async (operation: { action: string }) => { if (operation.action === 'LIST') return { items: [group] }; if (operation.action === 'GROUP') return group; if (operation.action === 'ACTIVITY') return { activeWriters: '0', activeModels: '0' }; throw new Error('Unexpected mutation'); });
 Object.defineProperty(window, 'codeAgentDesktop', { configurable: true, value: { writableCollaboration: api, collaboration: vi.fn(async () => ({ capabilities: { 'run.writableCollaborationV1': 'READY', 'collaboration.adoption.repair': 'READY' } })), getSession: vi.fn(async () => ({ sessionId: 'child-session', messages: [{ id: 'goal', role: 'user', content: 'Original scoped objective' }, { id: 'answer', role: 'assistant', content: 'Previously published result' }] })) } });
 const query = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
 render(<QueryClientProvider client={query}><WritableCollaborationPanel sessionId="parent" runId="run" /></QueryClientProvider>);const details = screen.getByText('写候选、协作计划与显式采纳').closest('details')!;details.open = true;fireEvent(details, new Event('toggle', { bubbles: true }));
 expect(await screen.findByText(/已应用的修改不会自动撤销/)).toBeTruthy();expect(screen.getByText(/文件：部分写入/).textContent).toContain('未证明提交');
 expect((screen.getByRole('button', { name: '明确重做：新尝试可能产生费用' }) as HTMLButtonElement).disabled).toBe(true);expect((screen.getByRole('button', { name: '只读核对原采纳（不继续应用）' }) as HTMLButtonElement).disabled).toBe(false);
 fireEvent.click(screen.getByRole('button', { name: '查看只读子会话' }));const history = await screen.findByRole('region', { name: '只读子任务会话' });expect(await within(history).findByText('Previously published result')).toBeTruthy();expect(within(history).queryByRole('textbox')).toBeNull();expect(api.mock.calls.every(([operation]) => ['LIST', 'GROUP', 'ACTIVITY'].includes(operation.action))).toBe(true);query.clear();
});

it('allows source browsing on an explicit read-only surface while preventing collaboration mutations',async()=>{
 const group={schemaVersion:'writable-collaboration-record/1',kind:'GROUP',entityId:'g',groupId:'index',revision:'1',state:'DRAFT',children:[],candidates:[],adoptions:[]};
 const api=vi.fn(async(op:{action:string})=>op.action==='LIST'?{items:[group]}:op.action==='GROUP'?group:{activeModels:'0',activeWriters:'0'});
 const client={writableCollaboration:api,collaboration:async()=>({capabilities:{'run.writableCollaborationV1':'READY'}})};
 const query=new QueryClient({defaultOptions:{queries:{retry:false},mutations:{retry:false}}});
 render(<QueryClientProvider client={query}><WritableCollaborationPanel sessionId="s" runId="r" client={client} defaultOpen readOnly personalFriendly/></QueryClientProvider>);
 const cancel=await screen.findByRole('button',{name:'取消本组未完成计算'});expect(cancel.matches(':disabled')).toBe(true);
 expect(screen.getByRole('button',{name:'确认授权 / 当前 epoch 重新授权'}).matches(':disabled')).toBe(true);
 expect(screen.getByRole('combobox',{name:'协作计划'}).matches(':disabled')).toBe(false);
 fireEvent.click(screen.getByRole('button',{name:'刷新权威回执'}));expect(api.mock.calls.every(([op])=>['LIST','GROUP','ACTIVITY'].includes(op.action))).toBe(true);query.clear();
});
