// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, configure, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { writeFileSync } from 'node:fs';
import { ServiceClient } from '../../packages/service-client/src/index';
import { CollaborationPanel } from '../../src/renderer/app/CollaborationPanel';
import { collaborationDefinition, createCollaborationHandler } from '../../electron/main/ipc/collaboration';
import { IpcRegistry } from '../../electron/main/ipc/registry';
const bridge = vi.hoisted(() => ({ invoke: async (_channel: string, _payload: unknown): Promise<unknown> => { throw new Error('Transport not attached'); } }));
vi.mock('electron', () => ({ contextBridge: { exposeInMainWorld: (name: string, api: unknown) => Object.defineProperty(window, name, { configurable: true, value: api }) },
  ipcRenderer: { on: vi.fn(), removeListener: vi.fn(), invoke: (channel: string, payload: unknown) => bridge.invoke(channel, payload) } }));
const enabled = !!process.env.COLLABORATION_CANDIDATE_URL;
const suite = enabled ? describe : describe.skip;
afterEach(cleanup);
suite('immutable candidate through production main handler, preload and renderer', () => {
  let client: ServiceClient;
  const sid = process.env.COLLABORATION_SESSION_ID ?? '';
  const rid = process.env.COLLABORATION_RUN_ID ?? '';
  const headers = { Authorization: `Bearer ${process.env.COLLABORATION_BEARER}`, 'X-CodeAgent-Client-Token': process.env.COLLABORATION_CLIENT_TOKEN ?? '' };
  const read = async (path: string): Promise<Record<string, any>> => { const response = await fetch(process.env.COLLABORATION_CANDIDATE_URL + path, { headers }); expect(response.status).toBe(200); return response.json() as Promise<Record<string, any>>; };
  const release = async (): Promise<void> => { const response = await fetch(process.env.COLLABORATION_CONTROL_URL + '/release', { method: 'POST' }); expect(response.status).toBe(200); };
  beforeAll(async () => {
    configure({ asyncUtilTimeout: 15000 });
    client = new ServiceClient({ baseUrl: process.env.COLLABORATION_CANDIDATE_URL!, token: process.env.COLLABORATION_BEARER!, clientSessionToken: process.env.COLLABORATION_CLIENT_TOKEN! });
    await client.getCapabilities();
    const registry = new IpcRegistry(); registry.register(collaborationDefinition);
    const handler = createCollaborationHandler(registry, (operation) => client.collaboration(operation));
    bridge.invoke = async (channel, payload) => {
      if (channel === 'app/collaboration') return handler('app://codeagent/index.html', payload);
      if (channel === 'app/agent-profiles/list') return client.listAgentProfiles();
      if (channel === 'app/models/catalog') return client.getModelCatalog();
      throw new Error(`Unexpected preload channel ${channel}`);
    };
    await import('../../electron/preload/preload');
  });
  it('keeps suggestions explicit, reports at a safe point and hands off the same Run', async () => {
    const query = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    render(<QueryClientProvider client={query}><CollaborationPanel sessionId={sid} runId={rid} /></QueryClientProvider>);
    const details = screen.getByText('旁路讨论与主 Agent 协作').closest('details')!; details.open = true; fireEvent(details, new Event('toggle', { bubbles: true }));
    const freeze = screen.getByRole('button', { name: '冻结当前可见材料' }); await waitFor(() => expect(freeze.hasAttribute('disabled')).toBe(false)); fireEvent.click(freeze);
    await screen.findByRole('button', { name: '显式刷新材料' }); fireEvent.change(screen.getByLabelText('旁路问题'), { target: { value: 'Explain the frozen task facts' } });
    fireEvent.click(screen.getByRole('button', { name: '向旁路提问' })); await screen.findByText(/AUXILIARY_AGENT/, {}, { timeout: 15000 });
    fireEvent.click(screen.getByRole('button', { name: '选作建议草稿' })); expect((await read(`/api/v2/runs/${rid}/boundary-requests`)).items).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: '明确发送给主 Agent' })); await screen.findByText('已提交，等待主 Agent 安全点');
    const cancelInput = screen.getByRole('button', { name: '取消主请求' }); await waitFor(() => expect(cancelInput.hasAttribute('disabled')).toBe(false)); fireEvent.click(cancelInput);
    await waitFor(async () => expect((await read(`/api/v2/runs/${rid}/boundary-requests`)).items[0].state).toBe('CANCELLED'));
    await waitFor(() => expect(screen.getByRole('button', { name: '明确发送给主 Agent' }).hasAttribute('disabled')).toBe(false)); fireEvent.click(screen.getByRole('button', { name: '明确发送给主 Agent' }));
    await waitFor(async () => expect((await read(`/api/v2/runs/${rid}/boundary-requests`)).items).toHaveLength(2));
    await waitFor(() => expect(screen.getByRole('button', { name: '请主 Agent 汇报后继续' }).hasAttribute('disabled')).toBe(false)); fireEvent.click(screen.getByRole('button', { name: '请主 Agent 汇报后继续' }));
    await waitFor(async () => expect((await read(`/api/v2/runs/${rid}/boundary-requests`)).items).toHaveLength(3)); await release(); await release();
    await screen.findByText('主 Agent 已回答', {}, { timeout: 15000 });
    const handoff = screen.getByText('受控画像接管').closest('details')!; handoff.open = true; fireEvent(handoff, new Event('toggle', { bubbles: true }));
    fireEvent.change(screen.getByLabelText('目标智能体'), { target: { value: 'reviewer' } }); fireEvent.change(screen.getByLabelText('目标模型'), { target: { value: 'fixture/fixture-model-target' } });
    fireEvent.click(screen.getByRole('button', { name: '检查兼容性' })); const confirm = screen.getByRole('button', { name: '确认接管' }); await waitFor(() => expect(confirm.hasAttribute('disabled')).toBe(false)); fireEvent.click(confirm); await waitFor(async () => expect((await read(`/api/v2/runs/${rid}`)).controlState).toBe('PAUSE_REQUESTED')); await release();
    await screen.findByText(/目标启动已证明/, {}, { timeout: 15000 }); const segments = await read(`/api/v2/runs/${rid}/execution-segments`); expect(segments.current.executionEpoch).toBe('2'); expect(segments.current.runId).toBe(rid);
    await release(); await waitFor(async () => expect((await read(`/api/v2/runs/${rid}`)).sourceStatus).toBe('SUCCEEDED'), { timeout: 15000 });
    const proof = { schemaVersion: 'desktop-collaboration-consumer/1', sessionId: sid, runId: rid, segments, inputs: await read(`/api/v2/runs/${rid}/boundary-requests`) };
    if (process.env.COLLABORATION_EVIDENCE_FILE) writeFileSync(process.env.COLLABORATION_EVIDENCE_FILE, JSON.stringify(proof, null, 2)); query.clear();
  }, 60000);
});
