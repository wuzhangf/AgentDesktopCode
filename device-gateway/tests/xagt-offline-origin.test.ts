import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import type { LocalTransportLike } from '../src/local-tasks.js';
import { GatewayError } from '../src/protocol.js';
import { GatewayStore } from '../src/store.js';
import { OfflineOrigin } from '../src/xagt/offline-origin.js';

function fixture() {
  const path = mkdtempSync(join(tmpdir(), 'xagt-origin-'));
  const store = new GatewayStore(path);
  let receipt: { requestKey: string; taskId: string; kind: string } | undefined;
  const raw = vi.fn<LocalTransportLike['raw']>(async (_connection, method, endpoint, body, key) => {
    if (method === 'POST') {
      expect(body).toMatchObject({ generation: 'prior', nativeSessionId: 'original', targetCommandId: 'first' });
      receipt = { requestKey: key!, taskId: 'a-task', kind: 'NATIVE_FOLLOW_UP' };
      throw new Error('native receipt connection lost');
    }
    if (endpoint.includes('/interaction-requests')) return receipt
      ? { status: 200, data: receipt } : { status: 404, data: {} };
    return { status: 200, data: { taskId: 'a-task', state: 'SUCCEEDED', engineId: 'sage-pi', generation: 'prior',
      nativeSessionId: 'original', currentCommandId: 'first', capabilities: { followUp: true } } };
  });
  const transport = { workerLocalRows: () => [{ connectionId: 'route' }], identity: async () => 'store', raw } as unknown as LocalTransportLike;
  const delegationRequest = vi.fn<(method: string, path: string, body?: Record<string, unknown>) => Promise<Record<string, unknown>>>();
  const cluster = { delegationIdentity: () => 'member', delegationRequest };
  const make = () => new OfflineOrigin(store, transport, cluster);
  return { make, delegationRequest, raw, close: () => { store.close(); rmSync(path, { recursive: true, force: true }); } };
}

const packet = (operation: string, args: Record<string, unknown> = {}) => ({ version: 1, operation, arguments: args });

it('persists the exact intent and reconciles a lost Hosted admission reply by original key', async () => {
  const f = fixture();
  try {
    const origin = f.make();
    const source = await origin.create({ backendStoreId: 'store', taskId: 'a-task', wakeOnCompletion: false });
    const token = String(source.token);
    const args = { permitRef: 'target-grant', requestKey: 'submit-one', instruction: 'Run the permitted check.' };
    f.delegationRequest.mockRejectedValueOnce(new GatewayError('MEMBER_CLUSTER_UNAVAILABLE', 503))
      .mockResolvedValueOnce({ delegationRef: 'same-delegation', state: 'queued' });
    expect(await origin.rpc(token, packet('queue', args))).toMatchObject({ ok: true, result: { state: 'unknown' } });
    const restarted = f.make();
    expect(await restarted.rpc(token, packet('queue', args))).toMatchObject({ ok: true, result: { delegationRef: 'same-delegation' } });
    expect(await restarted.rpc(token, packet('queue', { ...args, permitRef: 'another-grant' })))
      .toMatchObject({ ok: false, error: { code: 'IDEMPOTENCY_PAYLOAD_MISMATCH' } });
    expect(f.delegationRequest).toHaveBeenNthCalledWith(1, 'POST', '/delegations', expect.objectContaining({
      sourceSubjectRef: source.sourceSubjectRef, returnSessionRef: source.returnSessionRef, ...args,
    }));
    expect(f.delegationRequest).toHaveBeenNthCalledWith(2, 'GET', '/delegations/by-key/target-grant/submit-one');
    expect(f.delegationRequest).toHaveBeenCalledTimes(2);
  } finally { f.close(); }
});

it('isolates the original inbox and recovers a lost wake receipt without initiating a second native turn', async () => {
  const f = fixture();
  try {
    const origin = f.make();
    const source = await origin.create({ backendStoreId: 'store', taskId: 'a-task', wakeOnCompletion: true });
    const other = await origin.create({ backendStoreId: 'store', taskId: 'a-task', wakeOnCompletion: false });
    const event = { eventId: 1, sourceEventId: 'source-terminal', delegationRef: 'job', executionRef: 'execution',
      returnSessionRef: source.returnSessionRef, state: 'succeeded' };
    f.delegationRequest.mockImplementation(async (_method, path) => ({ items: path.includes(String(source.sourceSubjectRef))
      && path.endsWith('after=0') ? [event] : [] }));
    await origin.tick();
    const restarted = f.make();
    await restarted.tick();
    expect(await restarted.rpc(String(source.token), packet('inbox'))).toMatchObject({ result: { items: [
      { eventId: 1, state: 'SUCCEEDED', resumeState: 'OBSERVED' },
    ] } });
    expect(await restarted.rpc(String(other.token), packet('inbox'))).toMatchObject({ result: { items: [] } });
    expect(f.raw.mock.calls.filter(args => args[1] === 'POST')).toHaveLength(1);
  } finally { f.close(); }
});
