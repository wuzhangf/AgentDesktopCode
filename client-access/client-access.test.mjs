import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { ClientAccess, memoryPending, applyReplies } from './client-access.mjs';

test('unknown engine needs no client branch; lost reply only looks up the original intention', async () => {
  const calls = []; let lost = true;
  const client = new ClientAccess({ origin: 'http://127.0.0.1', basePath: '/client', connectionId: 'test-device', pending: memoryPending(),
    fetch: async (url, request) => {
      calls.push([url, request.method, request.body && JSON.parse(request.body)]);
      if (url.endsWith('/manifest')) return Response.json({ protocolVersion: 'client-access/1', storeId: 's', replyDelivery: 'POLL' });
      if (url.endsWith('/messages') && lost) { lost = false; throw new Error('reply lost after acceptance'); }
      if (url.endsWith('/receipts/lookup')) return Response.json({ requestId: 'r', accepted: true });
      throw new Error('unexpected route');
    } });
  await client.connect();
  const view = { sourceKind: 'MY_FUTURE_ENGINE', conversationRef: 'c1.e30', message: { availability: 'AVAILABLE', binding: 'frozen' } };
  await assert.rejects(client.send(view, 'hello', 'r'), { code: 'SOURCE_OUTCOME_UNCONFIRMED' });
  assert.equal((await client.send(view, 'hello', 'r')).accepted, true);
  assert.equal(calls.filter(([u]) => u.endsWith('/messages')).length, 1);
  assert.equal(calls.at(-1)[2].binding, 'frozen');
  await assert.rejects(client.send(view, 'changed', 'r'), { code: 'IDEMPOTENCY_CONFLICT' });
});

test('snapshot updates replace text, unknown inputs cannot be submitted', async () => {
  const original = { representation: 'TEXT_SNAPSHOT', snapshot: { text: 'one' } };
  assert.equal(applyReplies(original, { unchanged: true }), original);
  assert.equal(applyReplies(original, { representation: 'TEXT_SNAPSHOT', snapshot: { text: 'two' } }).snapshot.text, 'two');
  const client = new ClientAccess({ origin: 'http://localhost', basePath: '/client', connectionId: 'test-device', pending: memoryPending() });
  await assert.rejects(client.action({ actions: [] }, { availability: 'AVAILABLE', inputKind: 'FUTURE_INPUT' }, {}, 'r'), { code: 'CAPABILITY_UNAVAILABLE' });
  assert.throws(() => new ClientAccess({ origin: 'http://example.com', basePath: '/client', pending: memoryPending() }), { code: 'UNTRUSTED_ORIGIN' });
});

test('late response after disconnect cannot overwrite the next connection', async () => {
  let release;
  const client = new ClientAccess({ origin: 'http://localhost', basePath: '/client', connectionId: 'test-device', pending: memoryPending(),
    fetch: () => new Promise(resolve => { release = () => resolve(Response.json({ items: ['old'] })); }) });
  const request = client.agents(); client.disconnect(); release();
  await assert.rejects(request, { code: 'STALE_CONNECTION' });
});

test('consumer locks the same contract digest and reference values', async () => {
  const lock = JSON.parse(await readFile(new URL('./contracts/contract.lock.json', import.meta.url), 'utf8'));
  const schema = await readFile(new URL('./contracts/client-access.schema.json', import.meta.url));
  assert.equal(createHash('sha256').update(schema).digest('hex'), lock.schemaSha256);
  const vectors = JSON.parse(await readFile(new URL('./contracts/reference-vectors.json', import.meta.url), 'utf8'));
  for (const v of vectors) assert.deepEqual(JSON.parse(Buffer.from(v.reference.split('.')[1], 'base64url').toString('utf8')), v.value);
});
