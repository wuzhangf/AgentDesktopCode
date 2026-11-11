// worker-events/1 SSE passthrough tests (design §8.4):
// - ConnectionHub.localStream returns the open upstream body — fixed route,
//   bearer, X-Worker-Local-Store, accept: text/event-stream — with the
//   bounded error path intact for non-2xx replies.
// - The personal gateway activities leaf negotiates Accept: text/event-
//   stream and pipes frames through without the JSON envelope; the ordinary
//   JSON leaf is unchanged.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import { ManagementStore } from '../server/management/registry-store';
import { ConnectionHub } from '../server/management/upstream';
import { createPersonalGateway, type PersonalGateway } from '../server/management/personal-control';

const enc = new TextEncoder();
const sseBody = (frames: string): Response => new Response(
  new ReadableStream<Uint8Array>({
    start(c) { c.enqueue(enc.encode(frames)); c.close(); }
  }),
  { status: 200, headers: { 'content-type': 'text/event-stream' } }
);

interface SeenCall { path: string; search: string; headers: Headers }

describe('ConnectionHub.localStream — worker-events/1 upstream', () => {
  it('returns the open SSE body with fixed headers and store guard', async () => {
    const store = new ManagementStore({ path: ':memory:' });
    const seen: SeenCall[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      seen.push({ path: url.pathname, search: url.search, headers: new Headers(init?.headers) });
      if (url.pathname === '/local/v1/identity') return new Response(JSON.stringify({ storeId: 'native-store' }), { status: 200 });
      if (url.pathname === '/local/v1/tasks/native-1/events') {
        return sseBody('id: 8\nevent: OUTPUT_DELTA\ndata: {"delta":"hi","nativeTurnId":"t1"}\n\n');
      }
      return new Response(JSON.stringify({ code: 'NOT_FOUND' }), { status: 404 });
    };
    const hub = new ConnectionHub(store, () => 'token-x', fetchImpl);
    try {
      hub.provision([{ connectionId: 'native', kind: 'WORKER_LOCAL', baseUrl: 'http://127.0.0.1:7777', tokenRef: 'memory' }]);
      const res = await hub.localStream('native', '/tasks/native-1/events?cursor=7', { storeId: 'native-store' });
      expect(res.status).toBe(200);
      const reader = res.body.getReader();
      const { value } = await reader.read();
      reader.releaseLock();
      expect(new TextDecoder().decode(value)).toContain('OUTPUT_DELTA');
      const upstream = seen.find(s => s.path === '/local/v1/tasks/native-1/events');
      expect(upstream?.search).toBe('?cursor=7');
      expect(upstream?.headers.get('accept')).toBe('text/event-stream');
      expect(upstream?.headers.get('x-worker-local-store')).toBe('native-store');
      expect(upstream?.headers.get('authorization')).toBe('Bearer token-x');
      // The store guard ran the ordinary bounded identity read first.
      expect(seen.some(s => s.path === '/local/v1/identity')).toBe(true);
    } finally {
      store.close();
    }
  });

  it('fails non-2xx replies through the bounded error path (cursor conflict)', async () => {
    const store = new ManagementStore({ path: ':memory:' });
    const fetchImpl: typeof fetch = async (input) => {
      const url = new URL(String(input));
      if (url.pathname === '/local/v1/identity') return new Response(JSON.stringify({ storeId: 'native-store' }), { status: 200 });
      return new Response(JSON.stringify({ code: 'CURSOR_CONFLICT' }), { status: 400 });
    };
    const hub = new ConnectionHub(store, () => 'token-x', fetchImpl);
    try {
      hub.provision([{ connectionId: 'native', kind: 'WORKER_LOCAL', baseUrl: 'http://127.0.0.1:7777', tokenRef: 'memory' }]);
      await expect(hub.localStream('native', '/tasks/native-1/events?cursor=42', { storeId: 'native-store' }))
        .rejects.toMatchObject({ status: 400, code: 'CURSOR_CONFLICT' });
    } finally {
      store.close();
    }
  });
});

describe('personal gateway — activities SSE passthrough', () => {
  async function boot(options: { eventsResponder?: () => Response } = {}): Promise<{ gateway: PersonalGateway; port: number; seen: SeenCall[]; taskId: string; dataDir: string }> {
    const dataDir = mkdtempSync(join(tmpdir(), 'native-sse-'));
    const seen: SeenCall[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      const headers = new Headers(init?.headers);
      seen.push({ path: url.pathname, search: url.search, headers });
      if (url.pathname === '/local/v1/identity') return new Response(JSON.stringify({ storeId: 'native-store' }), { status: 200 });
      if (url.pathname === '/local/v1/tasks/native-1/events') {
        if ((headers.get('accept') ?? '').includes('text/event-stream')) {
          return options.eventsResponder?.() ?? sseBody(
            'id: 6\nevent: OUTPUT_DELTA\ndata: {"delta":"hel","nativeTurnId":"t1"}\n\n' +
            'id: 7\nevent: OUTPUT_DELTA\ndata: {"delta":"lo","nativeTurnId":"t1"}\n\n' +
            ': keep-alive\n\n' +
            'id: 8\nevent: ASSISTANT_MESSAGE\ndata: {"nativeTurnId":"t1"}\n\n'
          );
        }
        return new Response(JSON.stringify({ items: [], nextCursor: null }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({ code: 'NOT_FOUND' }), { status: 404 });
    };
    const gateway = createPersonalGateway({
      dataDir,
      connections: [{ connectionId: 'native', kind: 'WORKER_LOCAL', baseUrl: 'http://127.0.0.1:7777', tokenRef: 'memory' }],
      secretResolver: () => 'token-x',
      fetchImpl,
    });
    gateway.store.insertProject({ projectId: 'p1', projectRef: 'owned-project', connectionId: 'native' });
    const taskId = gateway.store.upsertTask({ taskId: 'task-native-1', projectId: 'p1', displayName: 'Native' }).taskId;
    gateway.store.saveLaunch(taskId, 'rk-1', {
      request: { requestKey: 'rk-1', projectId: 'p1', instruction: 'do it', engineId: 'pi' },
      executionBinding: { kind: 'WORKER_LOCAL', connectionId: 'native', storeId: 'native-store', localTaskId: 'native-1', engineId: 'pi', engineVersion: '0.73.1' },
      sourceRequest: { requestKey: 'rk-1', projectId: 'owned-project', engineId: 'pi' },
    });
    await new Promise<void>((r) => gateway.server.listen(0, '127.0.0.1', r));
    return { gateway, port: (gateway.server.address() as { port: number }).port, seen, taskId, dataDir };
  }

  it('negotiates Accept: text/event-stream and pipes frames unbuffered', async () => {
    const { gateway, port, seen, taskId, dataDir } = await boot();
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/personal/v1/tasks/${taskId}/activities?afterCursor=5`, {
        headers: {
          'x-personal-control': '1', 'x-personal-tab': 'tab-1',
          origin: `http://127.0.0.1:${port}`, accept: 'text/event-stream',
        },
      });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/event-stream');
      const text = await res.text();
      // Frames pass through byte-identical — no JSON envelope, no buffering.
      expect(text).toContain('id: 6\nevent: OUTPUT_DELTA\ndata: {"delta":"hel","nativeTurnId":"t1"}');
      expect(text).toContain('id: 8\nevent: ASSISTANT_MESSAGE');
      expect(text).not.toContain('"meta"');
      const upstream = seen.find(s => s.path === '/local/v1/tasks/native-1/events');
      // afterCursor maps to the worker-events/1 cursor, store guard forwarded.
      expect(upstream?.search).toBe('?cursor=5');
      expect(upstream?.headers.get('accept')).toBe('text/event-stream');
      expect(upstream?.headers.get('x-worker-local-store')).toBe('native-store');
    } finally {
      await gateway.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('survives a client disconnect while the upstream read is pending', async () => {
    // Regression: the pipe loop used to let post-flush failures (client close
    // aborts the upstream read) reach the outer JSON catch → send() →
    // ERR_HTTP_HEADERS_SENT → the whole listener process died.
    const { gateway, port, taskId, dataDir } = await boot({
      eventsResponder: () => new Response(
        new ReadableStream<Uint8Array>({
          start(c) { c.enqueue(enc.encode('id: 6\nevent: OUTPUT_DELTA\ndata: {"delta":"hel"}\n\n')); }
          // Never closes: the downstream disconnect must abort a pending read.
        }),
        { status: 200, headers: { 'content-type': 'text/event-stream' } }
      ),
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const req = httpRequest({
          host: '127.0.0.1', port, method: 'GET',
          path: `/api/personal/v1/tasks/${taskId}/activities`,
          headers: {
            'x-personal-control': '1', 'x-personal-tab': 'tab-1',
            origin: `http://127.0.0.1:${port}`, accept: 'text/event-stream',
          },
        }, (res) => {
          res.once('data', () => { res.destroy(); resolve(); });
          res.on('error', () => resolve());
        });
        req.on('error', reject);
        req.end();
      });
      // Give the server a beat to run its close→abort→read-reject path.
      await new Promise(r => setTimeout(r, 150));
      // The listener must still answer ordinary requests — the crash path
      // would have killed the process instead.
      const res = await fetch(`http://127.0.0.1:${port}/api/personal/v1/tasks/${taskId}/activities`, {
        headers: {
          'x-personal-control': '1', 'x-personal-tab': 'tab-1',
          origin: `http://127.0.0.1:${port}`, accept: 'application/json',
        },
      });
      expect(res.status).toBe(200);
    } finally {
      await gateway.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('keeps the JSON envelope leaf unchanged for ordinary accepts', async () => {
    const { gateway, port, seen, taskId, dataDir } = await boot();
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/personal/v1/tasks/${taskId}/activities`, {
        headers: {
          'x-personal-control': '1', 'x-personal-tab': 'tab-1',
          origin: `http://127.0.0.1:${port}`, accept: 'application/json',
        },
      });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('application/json');
      const body = await res.json();
      expect(body.meta).toBeTruthy();
      expect(body.data).toEqual({ items: [], nextCursor: null });
      // The JSON leaf still used the buffered local read — accept stays
      // content-type JSON upstream, never negotiated as a stream.
      const upstream = seen.find(s => s.path === '/local/v1/tasks/native-1/events');
      expect(upstream?.headers.get('accept')).toBeNull();
    } finally {
      await gateway.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
