/**
 * Durable SSE client tests (design §9.4/§12.2): frame parsing, cursor
 * monotonicity, gap detection (strict mode), CURSOR_EXPIRED handoff,
 * disconnect/backoff reconnect and delivery batching. Deterministic: a
 * local stub SSE server, loopback only.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DurableEventClient,
  type DurableEventFrame
} from '../../electron/main/transport/durableEvents';

const TOKEN = 'durable-sse-test-bearer-token';

let server: http.Server;
let port = 0;
let connections: Array<(chunk: string) => void> = [];
/** Returns true when it fully answered the request (e.g. 409), false to fall through to the default SSE stream. */
let respondsWith: (req: http.IncomingMessage, res: http.ServerResponse, write: (chunk: string) => void, after: number) => boolean;

function sseFrame(cursor: number, type: string, payload: unknown): string {
  return `id: ${cursor}\nevent: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
}

beforeEach(async () => {
  connections = [];
  respondsWith = () => false;
  server = http.createServer((req, res) => {
    const auth = req.headers.authorization;
    if (auth !== `Bearer ${TOKEN}`) {
      res.writeHead(401).end();
      return;
    }
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
    const after = Number.parseInt(url.searchParams.get('afterCursor') ?? '0', 10);
    const write = (chunk: string) => {
      if (chunk === '__disconnect__') {
        res.end();
        return;
      }
      res.write(chunk);
    };
    const handled = respondsWith(req, res, write, after);
    if (handled) return;
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache'
    });
    connections.push(write);
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      port = (server.address() as AddressInfo).port;
      resolve();
    });
  });
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  connections = [];
});

interface TestClientOptions {
  initialCursor?: number;
  strictCursor?: boolean;
  batchIntervalMs?: number;
}

function startClient(
  options: TestClientOptions,
  collected: { events: DurableEventFrame[][]; resyncs: string[]; statuses: string[] }
): DurableEventClient {
  const client = new DurableEventClient({
    endpoint: `http://127.0.0.1:${port}`,
    token: TOKEN,
    initialCursor: options.initialCursor ?? 0,
    strictCursor: options.strictCursor ?? false,
    batchIntervalMs: options.batchIntervalMs ?? 20,
    onEvents: (frames) => collected.events.push(frames),
    onResync: (reason) => collected.resyncs.push(reason),
    onStatus: (status) => collected.statuses.push(status)
  });
  client.start();
  return client;
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('condition not met in time');
}

describe('durable SSE client', () => {
  it('parses frames, advances the cursor monotonically and batches delivery', async () => {
    respondsWith = (_req, _res, write, after) => {
      void after;
      setTimeout(() => {
        write(sseFrame(1, 'run.status.changed', { status: 'RUNNING' }));
        write(sseFrame(2, 'run.terminal', { status: 'COMPLETED' }));
        write(sseFrame(2, 'run.terminal', { status: 'COMPLETED' })); // duplicate dropped
        write(sseFrame(3, 'run.status.changed', { status: 'RUNNING' }));
      }, 30);
      return false;
    };
    const collected = { events: [] as DurableEventFrame[][], resyncs: [], statuses: [] };
    const client = startClient({}, collected);
    try {
      await waitFor(() => client.getCursor() >= 3);
      await waitFor(() => collected.events.length >= 1);
      expect(client.getCursor()).toBe(3);
      const flat = collected.events.flat();
      expect(flat.map((f) => f.cursor)).toEqual([1, 2, 3]);
      expect(flat[0]?.type).toBe('run.status.changed');
      expect((flat[0]?.payload as { status: string }).status).toBe('RUNNING');
      expect(collected.resyncs).toEqual([]);
    } finally {
      client.stop();
    }
  });

  it('hands CURSOR_EXPIRED to the caller for snapshot resync', async () => {
    respondsWith = (req, res, _write, _after) => {
      if ((req.url ?? '').includes('/api/v2/events')) {
        res.writeHead(409, { 'content-type': 'application/problem+json' });
        res.end(JSON.stringify({ code: 'EVENT_CURSOR_EXPIRED', status: 409, message: 'below floor' }));
        return true;
      }
      return false;
    };
    const collected = {
      events: [] as DurableEventFrame[][],
      resyncs: [] as string[],
      statuses: [] as string[]
    };
    const client = startClient({ initialCursor: 5 }, collected);
    await waitFor(() => collected.resyncs.length >= 1);
    expect(collected.resyncs).toEqual(['CURSOR_EXPIRED']);
    client.stop();
  });

  it('restart resumes from an explicit cursor after resync', async () => {
    let stage: 'expired' | 'live' = 'expired';
    respondsWith = (_req, _res, write, _after) => {
      if (stage === 'expired') return true; // caller must resync first
      setTimeout(() => write(sseFrame(9, 'run.status.changed', { n: 9 })), 20);
      return false;
    };
    const collected = {
      events: [] as DurableEventFrame[][],
      resyncs: [] as string[],
      statuses: [] as string[]
    };
    const client = startClient({ initialCursor: 100 }, collected);
    // point the client at the expired path by flipping the stage manually:
    // simpler: the stub above never 409s, so emulate the resync flow directly
    stage = 'live';
    client.restart(8);
    // The cursor updates before the batched delivery flushes, so wait for
    // the delivered frame, then assert the authoritative cursor.
    await waitFor(() => collected.events.flat().length >= 1);
    expect(collected.events.flat().map((f) => f.cursor)).toEqual([9]);
    expect(client.getCursor()).toBe(9);
    client.stop();
  });

  it('detects gaps in strict mode and reports a full resync', async () => {
    respondsWith = (_req, _res, write, _after) => {
      setTimeout(() => {
        write(sseFrame(1, 'a', {}));
        write(sseFrame(2, 'b', {}));
        write(sseFrame(5, 'c', {})); // gap 3-4
      }, 20);
      return false;
    };
    const collected = {
      events: [] as DurableEventFrame[][],
      resyncs: [] as string[],
      statuses: [] as string[]
    };
    const client = startClient({ strictCursor: true }, collected);
    await waitFor(() => collected.resyncs.length >= 1);
    expect(collected.resyncs).toEqual(['GAP']);
    client.stop();
  });

  it('reports unsafe cursor frames instead of silently dropping them', async () => {
    respondsWith = (_req, _res, write, _after) => {
      setTimeout(() => write('id: 9007199254740992\nevent: unsafe\ndata: {}\n\n'), 20);
      return false;
    };
    const collected = {
      events: [] as DurableEventFrame[][],
      resyncs: [] as string[],
      statuses: [] as string[]
    };
    const client = startClient({}, collected);
    await waitFor(() => collected.resyncs.length >= 1);
    expect(collected.resyncs).toEqual(['GAP']);
    expect(collected.events).toEqual([]);
    client.stop();
  });

  it('reconnects with backoff after the server drops the connection', async () => {
    let round = 0;
    respondsWith = (_req, _res, write, after) => {
      round += 1;
      const current = round;
      setTimeout(() => {
        write(sseFrame(after + 1, 'tick', { round: current }));
        if (current <= 2) {
          setTimeout(() => write('__disconnect__'), 30);
        }
      }, 20);
      return false;
    };
    const collected = {
      events: [] as DurableEventFrame[][],
      resyncs: [] as string[],
      statuses: [] as string[]
    };
    const client = new DurableEventClient({
      endpoint: `http://127.0.0.1:${port}`,
      token: TOKEN,
      batchIntervalMs: 20,
      minBackoffMs: 50,
      maxBackoffMs: 200,
      onEvents: (frames) => collected.events.push(frames),
      onResync: (reason) => collected.resyncs.push(reason),
      onStatus: (status) => collected.statuses.push(status)
    });
    client.start();
    try {
      await waitFor(() => client.getCursor() >= 3, 5000);
      expect(client.getCursor()).toBe(3);
      expect(collected.statuses).toContain('RECONNECTING');
      expect(collected.statuses).toContain('CONNECTED');
      expect(collected.resyncs).toEqual([]);
    } finally {
      client.stop();
    }
  });
});
