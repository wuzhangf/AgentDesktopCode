import { randomBytes } from 'node:crypto';
import { expect, it } from 'vitest';
import type { JsonObject } from '../src/context.js';
import type { Device } from '../src/protocol.js';
import { ControlMcp } from '../src/xagt/control.js';

function fixture() {
  const records = new Map<string, unknown>();
  const device = { id: 'device', revision: 4 } as Device;
  const facts = { taskId: 'task', engineId: 'sage-pi', generation: 'original', nativeSessionId: 'session',
    currentCommandId: 'command-1', state: 'RUNNING', quiescent: false, capabilities: { stop: true } };
  const question = { inputRequestId: 'question-1', state: 'PENDING', method: 'select', options: ['yes', 'no'] };
  const writes: JsonObject[] = [];
  const storeKey = randomBytes(32);
  const access = new ControlMcp({
    store: {
      get: <T>(kind: string, id: string) => records.get(`${kind}:${id}`) as T | undefined,
      put: (kind, id, value) => { records.set(`${kind}:${id}`, value); },
      list: <T>(kind: string) => [...records].filter(([key]) => key.startsWith(`${kind}:`)).map(([, value]) => value as T),
    },
    local: { remote: (_token, method, path, body) => {
      if (method === 'POST') writes.push(body as JsonObject);
      return { status: 200, body: path.endsWith('/input-requests') ? { items: [question] } : facts };
    } },
    auth: { authenticate: () => device, authorizeLocal: () => device, authorizeLaunch: () => device },
    storeKey: () => storeKey, membership: () => 'owner-member',
  });
  const issue = (operation: string, extra: JsonObject = {}) => access.issue({ operation, backendStoreId: 'backend',
    deviceToken: 'fixture-device-token', taskId: 'task', requestKey: 'owner-approved',
    expiresAt: new Date(Date.now() + 30_000).toISOString(), ...extra });
  const call = (grant: JsonObject, operation: string) => access.rpc(grant.token as string,
    { version: 1, operation, arguments: {} });
  return { issue, call, facts, question, writes };
}

it('rejects a stop for an earlier command even if the worker has not assigned a turn id', async () => {
  const f = fixture();
  const grant = await f.issue('stop');
  f.facts.currentCommandId = 'new-command';
  expect(await f.call(grant, 'stop')).toMatchObject({ ok: false, error: { code: 'NATIVE_TARGET_CHANGED' } });
  expect(f.writes).toHaveLength(0);
});

it('requires owner approval again if the same question id now describes different options', async () => {
  const f = fixture();
  const grant = await f.issue('approve', { inputRequestId: 'question-1', response: { value: 'yes' } });
  f.question.options = ['yes', 'later'];
  expect(await f.call(grant, 'approve')).toMatchObject({ ok: false, error: { code: 'NATIVE_INPUT_EXPIRED' } });
  expect(f.writes).toHaveLength(0);
});

it('preserves natural completion when the original command ends before stop is sent', async () => {
  const f = fixture();
  const grant = await f.issue('stop');
  f.facts.quiescent = true;
  f.facts.state = 'SUCCEEDED';
  const result = await f.call(grant, 'stop');
  expect(result).toMatchObject({ ok: true, result: { state: 'ORIGINAL_RUN_ENDED', originalTaskState: 'SUCCEEDED' } });
  expect(await f.call(grant, 'status')).toEqual(result);
  expect(f.writes).toHaveLength(0);
});
