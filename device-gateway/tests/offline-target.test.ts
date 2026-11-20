import { expect, it, vi } from 'vitest';
import type { ConnectionRowLite, RawResult } from '../src/local-transport.js';
import { GatewayError } from '../src/protocol.js';
import { OfflineTargetService } from '../src/xagt/offline-target.js';

class Store {
  private readonly rows = new Map<string, unknown>();
  get<T>(kind: string, id: string): T | undefined { return this.rows.get(`${kind}:${id}`) as T | undefined; }
  put(kind: string, id: string, value: unknown): void { this.rows.set(`${kind}:${id}`, value); }
  list<T>(kind: string): T[] { return [...this.rows].filter(([key]) => key.startsWith(`${kind}:`)).map(([, value]) => value as T); }
}

class Transport {
  readonly row: ConnectionRowLite = { connectionId: 'worker', kind: 'worker-local', baseUrl: 'http://worker' };
  posts = 0;
  receipt: Record<string, unknown> | undefined;
  facts: Record<string, unknown> = {
    taskId: 'task-1', projectId: 'project-1', engineId: 'sage-pi', state: 'SUCCEEDED', nativeIdle: true,
    generation: 'g1', nativeSessionId: 's1', nativeTurnId: 'turn-1', currentCommandId: 'cmd-1',
    capabilities: { followUp: true },
  };
  workerLocal(): ConnectionRowLite { return this.row; }
  workerLocalRows(): ConnectionRowLite[] { return [this.row]; }
  async identity(): Promise<string> { return 'store-1'; }
  async raw(_connection: string, method: 'GET' | 'POST', tail: string, body?: unknown): Promise<RawResult> {
    if (tail === '/tasks/task-1') return { status: 200, data: this.facts };
    if (tail.includes('/interaction-requests/')) {
      return this.receipt === undefined ? { status: 404, data: { code: 'NOT_FOUND' } } : { status: 200, data: this.receipt };
    }
    if (method === 'POST' && tail === '/tasks/task-1/messages') {
      this.posts++;
      const requestKey = (body as Record<string, unknown>).requestKey;
      this.receipt = { kind: 'NATIVE_FOLLOW_UP', taskId: 'task-1', requestKey, state: 'ACCEPTED', executionRef: 'native-1' };
      return { status: 202, data: this.receipt };
    }
    return { status: 404, data: { code: 'NOT_FOUND' } };
  }
  async rawBytes(): Promise<RawResult> { return { status: 404, data: {} }; }
}

function fixture() {
  const store = new Store(); const transport = new Transport();
  let claims: unknown[] = [];
  const observed: Record<string, unknown>[] = [];
  const requests: Record<string, unknown>[] = [];
  const admitted = new Set<string>();
  let binding = 'member-a';
  const memberCluster = {
    delegationIdentity: () => binding,
    async delegationRequest(method: string, path: string, body?: Record<string, unknown>): Promise<Record<string, unknown>> {
      requests.push({ method, path, ...(body ? { body } : {}) });
      if (method === 'GET') return { items: claims };
      if (path === '/delegations/permits') return { permitRef: body?.permitRef };
      if (path.endsWith('/authorize')) {
        const mode = admitted.has(path) ? 'RECONCILE' : 'DISPATCH';
        admitted.add(path);
        return { mode, leaseGeneration: body?.leaseGeneration };
      }
      if (path.endsWith('/observe')) { observed.push({ method, path, ...(body ? { body } : {}) }); return {}; }
      if (method === 'DELETE') return {};
      return {};
    },
  };
  const service = new OfflineTargetService({ store, transport, memberCluster });
  return { store, transport, service, memberCluster, observed, requests, setClaims: (value: unknown[]) => { claims = value; },
    setBinding: (value: string) => { binding = value; } };
}

const expires = () => new Date(Date.now() + 60_000).toISOString();

it('derives an idle native round, registers Hosted permit, and dispatches with a namespaced key', async () => {
  const f = fixture();
  const grant = await f.service.create({ requestId: 'r1', sourceInstanceId: 'source-pc', sourceSubjectRef: 'source-1', returnSessionRef: 'return-1',
    backendStoreId: 'store-1', projectId: 'project-1', taskId: 'task-1', expiresAt: expires() });
  expect(grant.permitRef).toMatch(/^xpermit-/);
  expect(grant.generation).toBe('g1');
  expect(f.requests.some(request => request.path === '/delegations/permits')).toBe(true);
  f.setClaims([{ delegationRef: 'dlg-1', permitRef: grant.permitRef, requestKey: 'request-1', instruction: 'continue',
    leaseGeneration: 1, leaseUntil: expires() }]);
  await f.service.pollOnce();
  expect(f.transport.posts).toBe(1);
  expect(f.transport.receipt?.requestKey).not.toBe('request-1');
  expect(f.transport.receipt?.requestKey).toMatch(/^xagt-offline-/);
  expect(f.requests.filter(request => String(request.path).endsWith('/authorize'))).toHaveLength(1);
  expect(f.observed.some(row => (row.body as Record<string, unknown>)?.state === 'ACCEPTED')).toBe(true);
});

it('does not blindly repost after the durable receipt is unknown', async () => {
  const f = fixture();
  const grant = await f.service.create({ requestId: 'r2', sourceInstanceId: 'source-pc', sourceSubjectRef: 'source-2', returnSessionRef: 'return-2',
    backendStoreId: 'store-1', projectId: 'project-1', taskId: 'task-1', expiresAt: expires() });
  f.transport.raw = async (_connection, method, tail, body) => {
    if (tail === '/tasks/task-1') return { status: 200, data: f.transport.facts };
    if (tail.includes('/interaction-requests/')) return { status: 404, data: {} };
    if (method === 'POST' && tail.endsWith('/messages')) { f.transport.posts++; return { status: 202, data: {} }; }
    return { status: 404, data: {} };
  };
  f.setClaims([{ delegationRef: 'dlg-2', permitRef: grant.permitRef, requestKey: 'request-2', instruction: 'continue', leaseGeneration: 1, leaseUntil: expires() }]);
  await f.service.pollOnce(); await f.service.pollOnce();
  expect(f.transport.posts).toBe(1);
  expect(f.observed.some(row => (row.body as Record<string, unknown>)?.reasonCode === 'LOCAL_REPLY_UNCONFIRMED')).toBe(true);
});

it('recovers a consumed original receipt and follows its exact turn after the current turn changed', async () => {
  const f = fixture();
  const grant = await f.service.create({ requestId: 'reconcile', sourceInstanceId: 'source-pc',
    sourceSubjectRef: 'source-1', returnSessionRef: 'return-1', backendStoreId: 'store-1',
    projectId: 'project-1', taskId: 'task-1', expiresAt: expires() });
  const raw = f.transport.raw.bind(f.transport);
  f.transport.raw = async (connection, method, tail, body) => {
    if (method !== 'POST') return raw(connection, method, tail, body);
    await raw(connection, method, tail, body);
    const requestKey = String(f.transport.receipt?.requestKey);
    f.transport.receipt!.state = 'CONSUMED';
    Object.assign(f.transport.facts, { currentCommandId: 'another-command', generation: 'another-generation',
      state: 'RUNNING', nativeIdle: false, nativeTurnId: null, turns: { [requestKey]: { state: 'SUCCEEDED' } } });
    throw new Error('lost native response');
  };
  const claim = { delegationRef: 'dlg-reconcile', permitRef: grant.permitRef,
    requestKey: 'same-key', instruction: 'continue once', leaseGeneration: 1, leaseUntil: expires() };
  f.setClaims([claim]);
  await f.service.pollOnce();
  const restarted = new OfflineTargetService({ store: f.store, transport: f.transport, memberCluster: f.memberCluster });
  f.setClaims([{ ...claim, leaseGeneration: 2 }]);
  await restarted.pollOnce();
  await restarted.pollOnce();
  expect(f.transport.posts).toBe(1);
  const facts = f.observed.map(row => row.body as Record<string, unknown>);
  expect(facts.map(row => row.state)).toEqual(['UNKNOWN', 'ACCEPTED', 'SUCCEEDED']);
  expect(facts[1]?.executionRef).toBe(facts[2]?.executionRef);
});

it('rejects a busy target before creating a Hosted permit', async () => {
  const f = fixture(); f.transport.facts.state = 'RUNNING'; f.transport.facts.nativeIdle = false;
  await expect(f.service.create({ requestId: 'r3', sourceInstanceId: 'source-pc', sourceSubjectRef: 'source-3', returnSessionRef: 'return-3',
    backendStoreId: 'store-1', projectId: 'project-1', taskId: 'task-1', expiresAt: expires() }))
    .rejects.toMatchObject({ code: 'TARGET_BUSY' } satisfies Partial<GatewayError>);
  expect(f.requests.some(request => request.path === '/delegations/permits')).toBe(false);
});

it('quarantines malformed claims and releases a valid Hosted lease', async () => {
  const f = fixture();
  const grant = await f.service.create({ requestId: 'r4', sourceInstanceId: 'source-pc', sourceSubjectRef: 'source-4', returnSessionRef: 'return-4',
    backendStoreId: 'store-1', projectId: 'project-1', taskId: 'task-1', expiresAt: expires() });
  f.setClaims([{ delegationRef: 'dlg-4', permitRef: grant.permitRef, requestKey: 'bad', instruction: '', leaseGeneration: 4, leaseUntil: expires() }]);
  await f.service.pollOnce();
  expect(f.store.list('xagt-offline-quarantine')).toHaveLength(1);
  expect(f.observed.some(row => (row.body as Record<string, unknown>)?.state === 'QUARANTINED')).toBe(true);
});

it('revokes Hosted first and only then seals the local grant', async () => {
  const f = fixture();
  const grant = await f.service.create({ requestId: 'r5', sourceInstanceId: 'source-pc', sourceSubjectRef: 'source-5', returnSessionRef: 'return-5',
    backendStoreId: 'store-1', projectId: 'project-1', taskId: 'task-1', expiresAt: expires() });
  await f.service.revoke(String(grant.targetId));
  expect(f.requests.some(request => request.method === 'DELETE' && request.path === `/delegations/permits/${grant.permitRef}`)).toBe(true);
  expect(f.store.get<{ state: string }>('xagt-offline-target', String(grant.targetId))?.state).toBe('REVOKED');
});
