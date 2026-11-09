// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { WritableCollaborationPanel } from '../../src/renderer/app/WritableCollaborationPanel';
afterEach(cleanup);
it.each([false, true])('opens fixed child messages and their model/budget through the selected client (injected=%s) after feature shutdown', async (injected) => {
  const child = { schemaVersion: 'writable-collaboration-record/1', kind: 'CHILD', entityId: 'child', groupId: 'group', revision: '5', state: 'CANDIDATE_READY', sessionId: 'child-session', unitId: 'unit', attempt: '2', quiescent: true, agentProfileId: 'reviewer', profileRevision: 'profile-1', modelPin: 'fixture/model', objectiveMessageId: 'objective', resultMessageId: 'answer', childBudget: { LOGICAL_CALL: { revision: '8', attemptSpent: '3', attemptLimit: '6', unitSpent: '6', unitLimit: '12' } } };
  const group = { schemaVersion: 'writable-collaboration-record/1', kind: 'GROUP', entityId: 'group', groupId: 'index', revision: '4', state: 'READY', executionEpoch: '1', children: [child] };
  const writable = vi.fn(async (operation: { action: string }) => { if (operation.action === 'LIST') return { items: [group] }; if (operation.action === 'GROUP') return group; if (operation.action === 'ACTIVITY') return { activeWriters: '0', activeModels: '0' }; throw new Error('Unexpected mutation'); });
  const getSession = vi.fn(async () => ({ sessionId: 'child-session', sessionPurpose: 'DELEGATED_WRITE_CANDIDATE', messages: [{ id: 'objective', role: 'user', content: 'Scoped child goal' }, { id: 'answer', role: 'assistant', contentState: 'DEFERRED', contentPreview: 'preview', contentRevision: '1' }, { id: 'other-attempt', role: 'assistant', content: 'Earlier attempt must remain separate' }] }));
  const body = vi.fn(async () => ({ schemaVersion: 'message-content-page/1', text: 'Scoped child result', hasMore: false, complete: true }));
  const client = { writableCollaboration: writable, collaboration: vi.fn(async () => ({ capabilities: { 'run.writableCollaborationV1': 'DISABLED' } })), getSession, getMessageContentPage: body };
  Object.defineProperty(window, 'codeAgentDesktop', { configurable: true, value: injected ? undefined : client });
  const query = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(<QueryClientProvider client={query}><WritableCollaborationPanel sessionId="parent" runId="run" client={injected ? client : undefined} /></QueryClientProvider>);
  const details = screen.getByText('写候选、协作计划与显式采纳').closest('details')!; details.open = true; fireEvent(details, new Event('toggle', { bubbles: true }));
  fireEvent.click(await screen.findByRole('button', { name: '查看只读子会话' }));
  const view = await screen.findByRole('region', { name: '只读子任务会话' });
  expect(await within(view).findByText('Scoped child result')).toBeTruthy();expect(within(view).getByText('Scoped child goal')).toBeTruthy();
  expect(view.textContent).toContain('fixture/model');expect(view.textContent).toContain('profile-1');expect(view.textContent).toContain('3 / 6；6 / 12');
  expect(within(view).queryByRole('textbox')).toBeNull();expect(within(view).queryByText('Earlier attempt must remain separate')).toBeNull();
  expect(getSession).toHaveBeenCalledWith('child-session');expect(body).toHaveBeenCalledWith('child-session', 'answer', { maxBytes: 65536 });
  expect(writable.mock.calls.every(([operation]) => ['LIST', 'GROUP', 'ACTIVITY'].includes(operation.action))).toBe(true);query.clear();
});
