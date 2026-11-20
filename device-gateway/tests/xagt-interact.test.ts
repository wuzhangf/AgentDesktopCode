import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import type { LocalTransportLike } from '../src/local-tasks.js';
import { GatewayStore } from '../src/store.js';
import { XagtInteractService } from '../src/xagt/interact.js';
import { ReaderAccess } from '../src/xagt/reader-access.js';
import { issueRef } from '../src/xagt/refs.js';

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'xagt-interact-'));
  const store = new GatewayStore(root);
  const readers = new ReaderAccess(store);
  const reader = readers.create({
    backends: ['b'], projects: ['p'], tasks: ['task'], actions: ['INTERACT'],
  });
  const binding = { v: 1, o: 'l', c: 'upstream', b: 'b', k: 't', t: 'task' };
  const sessionRef = issueRef(store, 'session', binding);
  const now = vi.fn(() => Date.now());
  const expiresAt = Date.now() + 100_000;
  const expectedStateRef = issueRef(store, 'state', {
    ...binding, p: 'p', g: 'generation', s: 'native-session', turn: 'turn',
    cmd: 'old-command', readerId: reader.grant.readerId, revision: reader.grant.grantRevision,
    expiresAt,
  });
  const facts = {
    taskId: 'task', projectId: 'p', generation: 'generation', nativeSessionId: 'native-session',
    nativeTurnId: 'turn', currentCommandId: 'old-command', engineId: 'sage-pi', capabilities: { followUp: true },
  };
  let receipt: Record<string, unknown> | undefined;
  const raw = vi.fn<LocalTransportLike['raw']>(async (_conn, method, path, body, key) => {
    if (path.includes('interaction-requests')) {
      return receipt ? { status: 200, data: receipt } : { status: 404, data: { code: 'REQUEST_NOT_FOUND' } };
    }
    if (method === 'POST') {
      receipt = { kind: 'NATIVE_FOLLOW_UP', taskId: 'task', requestKey: key, state: 'DISPATCHING' };
      expect(body).toMatchObject({ requestKey: key, targetCommandId: 'old-command' });
      facts.currentCommandId = String(key);
      throw new Error('deliberately lost reply');
    }
    return { status: 200, data: { ...facts } };
  });
  const identity = vi.fn<LocalTransportLike['identity']>().mockResolvedValue('b');
  const transport = {
    workerLocalRows: () => [{ connectionId: 'upstream' }],
    identity,
    raw,
  } as unknown as LocalTransportLike;
  const memberCluster = { authorizeInteraction: vi.fn().mockResolvedValue('member-binding') };
  const deps = { store, readers, transport, now, memberCluster };
  const service = new XagtInteractService(deps);
  const writer = await service.create({ requestId: 'grant', readerId: reader.grant.readerId,
    callerInstanceId: 'caller', sessionRef, expectedStateRef });
  const args = { sessionRef, expectedStateRef, requestKey: 'same-key', mode: 'followUp',
    instruction: 'Read the original answer.' };
  const close = () => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  };
  return { service, deps, reader, writer, raw, identity, args, facts, expiresAt, close };
}

it('recovers the original native receipt after a lost response without a second submission', async () => {
  const w = await fixture();
  try {
    const token = String(w.writer.token);
    await expect(w.service.send(w.reader.token, w.args)).rejects.toMatchObject({ code: 'ACCESS_UNAUTHORIZED' });
    await expect(w.service.send(token, { ...w.args, sessionRef: 'another-session' }))
      .rejects.toMatchObject({ code: 'TARGET_CHANGED' });
    await expect(w.service.send(token, w.args)).resolves.toMatchObject({ state: 'UNKNOWN' });
    const restarted = new XagtInteractService(w.deps);
    await expect(restarted.send(token, { ...w.args, instruction: 'Changed' }))
      .rejects.toMatchObject({ code: 'IDEMPOTENCY_PAYLOAD_MISMATCH' });
    await expect(restarted.lookup(token, { sessionRef: w.args.sessionRef,
      expectedStateRef: w.args.expectedStateRef, requestKey: w.args.requestKey }))
      .resolves.toMatchObject({ state: 'OBSERVED', result: { state: 'DISPATCHING' } });
    const writes = w.raw.mock.calls.filter(call => call[1] === 'POST');
    expect(writes).toHaveLength(1);
    expect(writes[0]?.[4]).toMatch(/^xagt-send-/);
  } finally {
    w.close();
  }
});

it('fences a revoked writer while the transport resolves the worker identity', async () => {
  const w = await fixture();
  try {
    w.identity.mockResolvedValueOnce('b').mockResolvedValueOnce('b').mockImplementationOnce(async () => {
      w.service.revoke(String(w.writer.interactId));
      return 'b';
    });
    await expect(w.service.send(String(w.writer.token), w.args)).rejects.toMatchObject({ code: 'GRANT_EXPIRED' });
    expect(w.raw.mock.calls.filter(call => call[1] === 'POST')).toHaveLength(0);
  } finally {
    w.close();
  }
});

it('prevents a new submission from an expired state and a changed turn', async () => {
  const w = await fixture();
  try {
    const token = String(w.writer.token);
    w.facts.nativeTurnId = 'new-turn';
    await expect(w.service.send(token, w.args)).rejects.toMatchObject({ code: 'NATIVE_TARGET_CHANGED' });
    w.deps.now.mockReturnValue(w.expiresAt + 1);
    await expect(w.service.send(token, w.args)).rejects.toMatchObject({ code: 'TARGET_CHANGED' });
    expect(w.raw.mock.calls.filter(call => call[1] === 'POST')).toHaveLength(0);
  } finally {
    w.close();
  }
});
