import { expect, it } from 'vitest';
import type { GatewayWorkHandoffs, LocalTaskResult } from '../src/context.js';
import { GatewayError } from '../src/protocol.js';
import { HandoffActionService } from '../src/xagt/handoff-action.js';

class Store {
  private readonly rows = new Map<string, unknown>();
  get<T>(kind: string, id: string): T | undefined { return this.rows.get(`${kind}:${id}`) as T | undefined; }
  put(kind: string, id: string, value: unknown): void { this.rows.set(`${kind}:${id}`, value); }
  list<T>(kind: string): T[] { return [...this.rows].filter(([key]) => key.startsWith(`${kind}:`)).map(([, value]) => value as T); }
}

const sourceRef = { kind: 'WORKER_LOCAL', storeId: 'store-a', taskId: 'task-a', engineId: 'pi' };
const targetAgentRef = { hostKey: 'local', kind: 'WORKER_LOCAL', storeId: 'store-b', engineId: 'pi', projectRef: 'project-b', policyPresetId: 'default' };

function fixture() {
  const store = new Store();
  const calls: Array<{ method: string; tail: string[]; body: unknown; key: string | null }> = [];
  let round: Record<string, unknown> = { taskId: 'task-a', storeId: 'store-a', engineId: 'pi', generation: 'g1', nativeSessionId: 's1', nativeTurnId: 'turn-1', currentCommandId: 'cmd-1', state: 'SUCCEEDED' };
  let view: Record<string, unknown> = { schemaVersion: 'work-handoff/1', handoffId: 'wh-a', phase: 'PREPARING', requestKey: 'orig-1' };
  let failPrepare = false;
  let continueCount = 0;
  let holdConfirm = false;
  let releaseConfirm: (() => void) | undefined;
  const handoffs: Pick<GatewayWorkHandoffs, 'remote'> = {
    async remote(_token, method, tail, body, key): Promise<LocalTaskResult> {
      calls.push({ method, tail, body, key });
      if (method === 'POST' && tail.length === 0 && failPrepare) { failPrepare = false; throw new Error('lost'); }
      if (method === 'POST' && tail[1] === 'confirm' && holdConfirm) {
        await new Promise<void>(resolve => { releaseConfirm = resolve; });
      }
      if (method === 'GET' && tail[0] === 'requests') return { status: 200, body: view };
      if (method === 'GET') return { status: 200, body: view };
      if (tail[1] === 'confirm') { view = { ...view, phase: 'SOURCE_SEALING' }; return { status: 200, body: view }; }
      if (tail[1] === 'continue') {
        if (continueCount++ === 0) return { status: 200, body: view };
        view = { ...view, phase: view.phase === 'SOURCE_SEALING' ? 'FINALIZING_MATERIALS' : 'TAKEN_OVER' };
        return { status: 200, body: view };
      }
      return { status: 201, body: view };
    },
  };
  const service = new HandoffActionService({
    store, remote: async (_source, ...request) => handoffs.remote(...request),
    ownerRevision: () => 'rev-1',
    resolveCredential: (ref) => ref === 'cred-1' ? 'coordinator-token' : (() => { throw new GatewayError('ACCESS_UNAUTHORIZED', 401); })(),
    sourceRound: () => round,
  });
  return { store, calls, service, setRound: (next: Record<string, unknown>) => { round = next; },
    failPrepare: () => { failPrepare = true; }, pauseConfirm: () => { holdConfirm = true; },
    releaseConfirm: () => { releaseConfirm?.(); } };
}

async function issue(f: ReturnType<typeof fixture>) {
  return f.service.issue({ credentialRef: 'cred-1', authRevision: 'rev-1', sourceRef, targetAgentRef,
    options: {}, requestKey: 'orig-1', expiresAt: new Date(Date.now() + 60_000).toISOString() });
}

it('persists the original create intent and recovers a lost prepare by requests/original', async () => {
  const f = fixture(); const action = await issue(f); f.failPrepare();
  const result = await f.service.prepare(String(action.actionId));
  expect(result.handoffId).toBe('wh-a');
  expect(f.calls.filter(call => call.method === 'POST' && call.tail.length === 0)).toHaveLength(1);
  expect(f.calls.some(call => call.method === 'GET' && call.tail.join('/') === 'requests/orig-1')).toBe(true);
  const replay = await f.service.prepare(String(action.actionId));
  expect(replay.handoffId).toBe('wh-a');
  expect(f.calls.filter(call => call.method === 'POST' && call.tail.length === 0)).toHaveLength(1);
});

it('checks the ACS source revision before the first coordinator seal attempt', async () => {
  const f = fixture();
  const session = { sessionId: 'acs-source', sessionVersion: 12, activeRunId: null };
  f.setRound(session);
  const action = await f.service.issue({ credentialRef: 'cred-1', authRevision: 'rev-1',
    sourceRef: { kind: 'ACS', sessionId: session.sessionId }, targetAgentRef,
    requestKey: 'orig-1', expiresAt: new Date(Date.now() + 60_000).toISOString() });
  const actionId = String(action.actionId);
  await f.service.prepare(actionId);
  await f.service.confirm(actionId, { expectedMaterialRevision: 1 });
  f.setRound({ ...session, sessionVersion: 13, activeRunId: 'another-run' });
  await expect(f.service.advance(actionId, {})).rejects.toMatchObject({ code: 'NATIVE_TARGET_CHANGED' });
  expect(f.calls.filter(call => call.tail[1] === 'continue')).toHaveLength(0);
});

it('refuses confirmation when the bound source round or owner revision changed', async () => {
  const f = fixture(); const action = await issue(f); await f.service.prepare(String(action.actionId));
  f.setRound({ taskId: 'task-a', storeId: 'store-a', engineId: 'pi', generation: 'g1', nativeSessionId: 's1', nativeTurnId: 'turn-1', currentCommandId: 'changed', state: 'SUCCEEDED' });
  await expect(f.service.confirm(String(action.actionId), { expectedMaterialRevision: 1, allowBackgroundProgress: false }))
    .rejects.toMatchObject({ code: 'NATIVE_TARGET_CHANGED' });
  expect(f.calls.filter(call => call.method === 'POST' && call.tail[1] === 'confirm')).toHaveLength(0);
});

it('delegates confirm and advance, exposing TAKEN_OVER only from coordinator evidence', async () => {
  const f = fixture(); const action = await issue(f); await f.service.prepare(String(action.actionId));
  const confirmed = await f.service.confirm(String(action.actionId), { expectedMaterialRevision: 1, allowBackgroundProgress: false });
  expect(confirmed.phase).toBe('SOURCE_SEALING');
  // After confirmation, source-round changes do not block coordinator-owned
  // sealing/start progress.
  f.setRound({ unavailable: true });
  const pending = await f.service.advance(String(action.actionId), { importBinding: null });
  expect(pending.phase).toBe('SOURCE_SEALING');
  const staged = await f.service.advance(String(action.actionId), { importBinding: { importId: 'import-1', targetTaskRef: 'task-b' } });
  expect(staged.phase).toBe('FINALIZING_MATERIALS');
  const advanced = await f.service.advance(String(action.actionId), { importBinding: { importId: 'import-1', targetTaskRef: 'task-b' } });
  expect(advanced.phase).toBe('TAKEN_OVER');
  expect(f.store.get<{ state: string }>('xagt-handoff-action', String(action.actionId))?.state).toBe('TAKEN_OVER');
});

it('rejects an altered operation body under the same durable action call', async () => {
  const f = fixture(); const action = await issue(f); await f.service.prepare(String(action.actionId));
  await expect(f.service.confirm(String(action.actionId), { expectedMaterialRevision: 1, allowBackgroundProgress: false })).resolves.toBeTruthy();
  // A second confirm has a different coordinator phase key and must be a new
  // phase operation; the coordinator, not this adapter, owns that decision.
  await expect(f.service.confirm(String(action.actionId), { expectedMaterialRevision: 2, allowBackgroundProgress: false }))
    .rejects.toMatchObject({ code: 'IDEMPOTENCY_PAYLOAD_MISMATCH' });
});

it('does not publish a late coordinator result after action permission is revoked', async () => {
  const f = fixture(); const action = await issue(f); await f.service.prepare(String(action.actionId));
  f.pauseConfirm();
  const pending = f.service.confirm(String(action.actionId), { expectedMaterialRevision: 1, allowBackgroundProgress: false });
  await new Promise(resolve => setTimeout(resolve, 0));
  await f.service.revoke(String(action.actionId));
  f.releaseConfirm();
  await expect(pending).rejects.toMatchObject({ code: 'SCOPE_DENIED' });
});
