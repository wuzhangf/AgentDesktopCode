/**
 * UCA-001 C4: `client-access/1` transport port.
 *
 * These assertions are the desktop copy of the reference consumer's
 * deterministic suite (`apps/client-access/client-access.test.mjs`): fixed
 * path allowlist, bounded responses, durable-intent lookup instead of re-post,
 * and no source-kind dispatch.
 */
import { describe, expect, it } from 'vitest';
import {
  AccessError,
  ClientAccess,
  applyReplies,
  isAllowedRequestPath,
  memoryPending,
  type ConversationView,
  type ReplyPage
} from '../../packages/client-access/src/index';

interface Recorded {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

function harness(replies: Array<{ status?: number; json: unknown }>) {
  const requests: Recorded[] = [];
  const queue = [...replies];
  const fetchImpl: typeof fetch = async (input, init) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => { headers[key] = value; });
    requests.push({
      method: init?.method ?? 'GET',
      url: String(input),
      headers,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) as unknown : undefined
    });
    const next = queue.shift();
    if (!next) throw new Error('unexpected request');
    return new Response(JSON.stringify(next.json), {
      status: next.status ?? 200,
      headers: { 'content-type': 'application/json' }
    });
  };
  const client = new ClientAccess({
    origin: 'http://127.0.0.1:9443',
    basePath: '/personal/v1/client',
    authorization: 'Bearer test-token',
    connectionId: 'desktop-profile-a',
    pending: memoryPending(),
    fetch: fetchImpl
  });
  return { client, requests };
}

const manifest = {
  protocolVersion: 'client-access/1',
  storeId: 'store-A',
  authBinding: 'device-a',
  replyDelivery: 'POLL',
  limits: { requestBytes: 65536, textBytes: 8192, replyPageBytes: 262144 },
  features: { conversationCreate: true, replyContent: true },
  authorizationRevision: '7'
};

const view: ConversationView = {
  agentRef: 'a1.agent',
  conversationRef: 'c1.conv',
  title: '会话',
  observedAt: '2026-10-24T00:00:00Z',
  sourceState: 'RUNNING',
  executions: [],
  message: { availability: 'AVAILABLE', reasonCode: null, meaning: 'append', binding: 'b1.send' },
  actions: [
    { actionId: 'execution.stop', label: '停止', availability: 'AVAILABLE', reasonCode: null, inputKind: 'NONE', binding: 'b1.stop' },
    { actionId: 'execution.pause', label: '暂停', availability: 'UNSUPPORTED', reasonCode: 'NO_CHECKPOINT_API', inputKind: 'NONE', binding: 'b1.pause' }
  ],
  actionsTruncated: false
};

describe('client-access/1 port', () => {
  it('only reaches the frozen protocol paths', () => {
    expect(isAllowedRequestPath('GET', '/manifest')).toBe(true);
    expect(isAllowedRequestPath('GET', '/agents')).toBe(true);
    expect(isAllowedRequestPath('GET', '/agents/a1.agent/conversations')).toBe(true);
    expect(isAllowedRequestPath('GET', '/conversations/c1.conv/replies')).toBe(true);
    expect(isAllowedRequestPath('GET', '/conversations/c1.conv/replies/r1.msg/content')).toBe(true);
    expect(isAllowedRequestPath('POST', '/conversations/c1.conv/messages')).toBe(true);
    expect(isAllowedRequestPath('POST', '/receipts/lookup')).toBe(true);
    for (const rejected of [
      ['GET', '/admin'], ['GET', '/agents/a1.agent'], ['GET', '/conversations/c1.conv/messages'],
      ['POST', '/manifest'], ['GET', '/conversations/../../etc'], ['GET', '/agents//conversations']
    ] as const) {
      expect(isAllowedRequestPath(rejected[0], rejected[1]), rejected.join(' ')).toBe(false);
    }
  });

  it('refuses untrusted origins and invalid bindings', () => {
    const pending = memoryPending();
    expect(() => new ClientAccess({ origin: 'http://example.com', connectionId: 'a', pending })).toThrow('UNTRUSTED_ORIGIN');
    expect(() => new ClientAccess({ origin: 'https://user:pass@127.0.0.1', connectionId: 'a', pending })).toThrow('UNTRUSTED_ORIGIN');
    expect(() => new ClientAccess({ origin: 'https://127.0.0.1', basePath: '/a//b', connectionId: 'a', pending })).toThrow('INVALID_CONNECTION_BINDING');
    expect(() => new ClientAccess({ origin: 'https://127.0.0.1', connectionId: '', pending })).toThrow('INVALID_CONNECTION_BINDING');
  });

  it('connects with the version header and pins the connection scope', async () => {
    const { client, requests } = harness([{ json: manifest }]);
    const result = await client.connect();
    expect(result.storeId).toBe('store-A');
    expect(requests[0]).toMatchObject({
      method: 'GET',
      url: 'http://127.0.0.1:9443/personal/v1/client/manifest'
    });
    expect(requests[0]?.headers['x-client-access-version']).toBe('client-access/1');
    expect(requests[0]?.headers.authorization).toBe('Bearer test-token');
    expect(client.scope).toContain('store-A');
    expect(client.scope).toContain('desktop-profile-a');
  });

  it('rejects a manifest that is not POLL delivery', async () => {
    const { client } = harness([{ json: { ...manifest, replyDelivery: 'PUSH' } }]);
    await expect(client.connect()).rejects.toThrow('PROTOCOL_VERSION_UNSUPPORTED');
  });

  it('looks the original intention up instead of posting twice', async () => {
    const { client, requests } = harness([
      { json: manifest },
      { json: { requestId: 'req-1', accepted: true, sourceStatus: 'ACCEPTED', consumed: true, observedAt: 'now' } },
      { json: { requestId: 'req-1', accepted: true, sourceStatus: 'APPLIED', consumed: true, observedAt: 'now' } }
    ]);
    await client.connect();
    const prepared = await client.prepare('req-1', '/conversations/c1.conv/messages',
      { requestId: 'req-1', text: 'hi', binding: 'b1.send' },
      { kind: 'MESSAGE', requestId: 'req-1', conversationRef: 'c1.conv', binding: 'b1.send' });
    const first = await client.dispatch(prepared);
    expect(first.sourceStatus).toBe('ACCEPTED');
    const second = await client.dispatch(prepared);
    expect(second.sourceStatus).toBe('APPLIED');
    expect(requests.map((request) => request.method)).toEqual(['GET', 'POST', 'POST']);
    expect(requests[2]?.url).toContain('/receipts/lookup');
    expect(requests[2]?.body).toEqual({ kind: 'MESSAGE', requestId: 'req-1', conversationRef: 'c1.conv', binding: 'b1.send' });
    expect(requests[1]?.headers['idempotency-key']).toBe('req-1');
  });

  it('rejects a re-used request id with a different payload', async () => {
    const { client } = harness([{ json: manifest }]);
    await client.connect();
    await client.prepare('req-2', '/conversations/c1.conv/messages',
      { requestId: 'req-2', text: 'one', binding: 'b1.send' },
      { kind: 'MESSAGE', requestId: 'req-2', conversationRef: 'c1.conv', binding: 'b1.send' });
    await expect(client.prepare('req-2', '/conversations/c1.conv/messages',
      { requestId: 'req-2', text: 'two', binding: 'b1.send' },
      { kind: 'MESSAGE', requestId: 'req-2', conversationRef: 'c1.conv', binding: 'b1.send' }))
      .rejects.toThrow('IDEMPOTENCY_CONFLICT');
  });

  it('sends through the source-provided binding and bounds the text', async () => {
    const { client, requests } = harness([
      { json: manifest },
      { json: { requestId: 'req-3', accepted: true, sourceStatus: 'ACCEPTED', consumed: true, observedAt: 'now' } }
    ]);
    await client.connect();
    await client.send(view, 'hello', 'req-3');
    expect(requests[1]?.body).toEqual({ requestId: 'req-3', text: 'hello', binding: 'b1.send' });
    await expect(client.send({ ...view, message: { ...view.message, availability: 'UNAVAILABLE' } }, 'x', 'req-4'))
      .rejects.toThrow('CAPABILITY_UNAVAILABLE');
    await expect(client.send(view, '   ', 'req-5')).rejects.toThrow('CAPABILITY_UNAVAILABLE');
    await expect(client.send(view, 'x'.repeat(8193), 'req-6')).rejects.toThrow('CAPABILITY_UNAVAILABLE');
  });

  it('only dispatches declared, available actions with the exact input shape', async () => {
    const { client, requests } = harness([
      { json: manifest },
      { json: { requestId: 'req-7', accepted: true, sourceStatus: 'ACCEPTED', consumed: true, observedAt: 'now' } }
    ]);
    await client.connect();
    const stop = view.actions[0]!;
    await client.action(view, stop, {}, 'req-7');
    expect(requests[1]?.body).toEqual({ requestId: 'req-7', actionId: 'execution.stop', binding: 'b1.stop', input: {} });

    await expect(client.action(view, view.actions[1]!, {}, 'req-8')).rejects.toThrow('CAPABILITY_UNAVAILABLE');
    await expect(client.action(view, { ...stop, actionId: 'shell.exec' }, {}, 'req-9')).rejects.toThrow('CAPABILITY_UNAVAILABLE');
    await expect(client.action(view, stop, { text: 'x' }, 'req-10')).rejects.toThrow('CAPABILITY_UNAVAILABLE');
    await expect(client.action(view, { ...stop, binding: 'b1.forged' }, {}, 'req-11')).rejects.toThrow('CAPABILITY_UNAVAILABLE');
  });

  it('bounds response bytes and rejects non-JSON bodies', async () => {
    const { client } = harness([{ json: { pad: 'x'.repeat(300000) } }]);
    await expect(client.connect()).rejects.toThrow('SOURCE_RESPONSE_TOO_LARGE');

    const broken = new ClientAccess({
      origin: 'http://127.0.0.1:9443',
      connectionId: 'a',
      pending: memoryPending(),
      fetch: async () => new Response('<html>', { status: 200 })
    });
    await expect(broken.connect()).rejects.toThrow('INVALID_SOURCE_RESPONSE');
  });

  it('surfaces the source error code and status', async () => {
    const { client } = harness([{ status: 409, json: { error: { code: 'LOCAL_TASK_BUSY' } } }]);
    await expect(client.connect()).rejects.toMatchObject({ code: 'LOCAL_TASK_BUSY', status: 409 });
  });

  it('invalidates in-flight results after disconnect', async () => {
    let release: (() => void) | undefined;
    const client = new ClientAccess({
      origin: 'http://127.0.0.1:9443',
      connectionId: 'a',
      pending: memoryPending(),
      fetch: async () => await new Promise<Response>((resolve) => {
        release = () => resolve(new Response(JSON.stringify(manifest), { status: 200 }));
      })
    });
    const pending = client.connect();
    client.disconnect();
    release?.();
    await expect(pending).rejects.toThrow('STALE_CONNECTION');
  });

  it('treats an unchanged poll as no-op and a snapshot as replacement', () => {
    const messages: ReplyPage = {
      representation: 'MESSAGES', revision: '1', items: [{ replyRef: 'r1.a', text: 'hi', contentRevision: '1', textComplete: true }],
      nextCursor: null, coverage: 'BOUNDED_HISTORY'
    };
    expect(applyReplies(undefined, messages)).toBe(messages);
    const unchanged: ReplyPage = { ...messages, unchanged: true, items: [] };
    expect(applyReplies(messages, unchanged)).toBe(messages);

    const snapshot: ReplyPage = {
      representation: 'TEXT_SNAPSHOT', revision: '2', items: [],
      snapshot: { replyRef: 'r1.out', text: 'native output', contentRevision: '2', textComplete: true },
      nextCursor: null, coverage: 'BOUNDED_PUBLIC_OUTPUT'
    };
    const applied = applyReplies(messages, snapshot);
    expect(applied.items).toEqual([]);
    expect(applied.snapshot?.text).toBe('native output');
    expect(() => applyReplies(undefined, { ...messages, representation: 'STREAM' as never })).toThrow(AccessError);
  });
});
