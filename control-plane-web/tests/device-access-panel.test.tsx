// @vitest-environment jsdom
// OC-G — owner-side launch scope picker: every reachable worker-local backend
// renders a checkbox row, and detected stock CLIs (sourceKind:'cli') group
// separately from managed workers. Scopes carry each backend's own store id.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, cleanup } from '@testing-library/react';
import { DeviceAccessPanel } from '../src/personal/components/DeviceAccessPanel';

afterEach(cleanup);
afterEach(() => vi.restoreAllMocks());

const caps = {
  origin: 'https://192.168.1.26:9443', storeId: 'gw-one', enabled: true,
  certificateNotAfter: Date.now() + 86400000, certificateSha256: 'abc',
  supportedActions: ['OBSERVE', 'CONTROL', 'INTERACT', 'APPROVE', 'LAUNCH'],
  sessions: [], resourceScopeVersion: 2,
  localSource: {
    available: true, backendStoreId: 'worker-main',
    projects: [{ projectId: 'demo', displayName: 'demo', headRevision: 'r1', hasUncommittedChanges: false }],
    engines: [{ engineId: 'codex', version: '9.9.9' }],
    backends: [{
      backendStoreId: 'cli-store',
      projects: [{ projectId: 'demo', displayName: 'demo', headRevision: 'r1', hasUncommittedChanges: false }],
      engines: [{ engineId: 'pi', version: '1.5.2', sourceKind: 'cli' }],
    }],
  },
};

function installFetch(capture: { body?: Record<string, unknown> }) {
  const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const path = String(input);
    if (path.endsWith('/device-access')) return json([{ connectionId: 'registered', displayName: 'Registered source' }]);
    if (path.endsWith('/capabilities')) return json(caps);
    if (path.endsWith('/devices')) return json([]);
    if (path.endsWith('/pairing-requests')) return json([]);
    if (path.endsWith('/notification-routes')) return json([]);
    if (path.endsWith('/notification-provider')) return json({ code: 'UNCONFIGURED' }, 404);
    if (path.endsWith('/invitations')) { capture.body = JSON.parse(String(init?.body)); return json({ inviteId: 'inv-1' }, 201); }
    throw new Error('unexpected ' + path);
  });
}

async function selectSource() {
  render(<DeviceAccessPanel />);
  await waitFor(() => screen.getByLabelText('手机配对来源'));
  fireEvent.change(screen.getByLabelText('手机配对来源'), { target: { value: 'registered' } });
  await waitFor(() => screen.getByRole('checkbox', { name: /pi 1\.5\.2/ }));
}

describe('DeviceAccessPanel launch scope picker', () => {
  it('renders detected CLI backends as a separate 已装 CLI group', async () => {
    installFetch({});
    await selectSource();
    expect(screen.getByText('已装 CLI')).toBeTruthy();
    expect(screen.getByText('托管 worker')).toBeTruthy();
    expect(screen.getByRole('checkbox', { name: /codex 9\.9\.9/ })).toBeTruthy();
    expect(screen.getByRole('checkbox', { name: /pi 1\.5\.2 · 已装 CLI/ })).toBeTruthy();
  });

  it('sends the cli backend own store id when its row is selected', async () => {
    const capture: { body?: Record<string, unknown> } = {};
    installFetch(capture);
    await selectSource();
    fireEvent.click(screen.getByRole('checkbox', { name: /pi 1\.5\.2/ }));
    fireEvent.click(screen.getByRole('checkbox', { name: /发起新原生任务/ }));
    await waitFor(() => expect((screen.getByRole('button', { name: '生成配对邀请' }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: '生成配对邀请' }));
    await waitFor(() => expect(capture.body).toBeDefined());
    expect(capture.body).toMatchObject({
      actions: expect.arrayContaining(['OBSERVE', 'LAUNCH']),
      launchScopes: [{ backendStoreId: 'cli-store', projectId: 'demo', engineId: 'pi' }],
    });
  });
});
