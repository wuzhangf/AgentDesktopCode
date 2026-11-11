/**
 * NativeTaskEventClient tests (worker-events/1, durable-events precedent):
 * SSE frame parsing (id/event/data + comment heartbeats), cursor monotonic
 * dedupe, strict gap detection, HTTP 400/409 -> CURSOR_EXPIRED, reconnect
 * with cursor resume, and batching. Deterministic: the `open` callback is
 * injected — no sockets, no timers beyond the batch flush.
 */
import { describe, expect, it } from 'vitest';
import {
  NativeTaskEventClient,
  type NativeTaskEventFrame,
  type NativeTaskStreamResponse
} from '../../electron/main/transport/nativeTaskEvents';

function sseFrame(cursor: number, type: string, payload: unknown): string {
  return `id: ${cursor}\nevent: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
}

function streamOf(chunks: string[], holdOpen = false): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      if (!holdOpen) controller.close();
    }
  });
}

interface Collected {
  events: NativeTaskEventFrame[][];
  resyncs: string[];
  statuses: string[];
  opens: number[];
}

function collect(): Collected {
  return { events: [], resyncs: [], statuses: [], opens: [] };
}

function startClient(
  open: (cursor: number, signal: AbortSignal) => Promise<NativeTaskStreamResponse>,
  collected: Collected,
  options: { initialCursor?: number; strictCursor?: boolean } = {}
): NativeTaskEventClient {
  const client = new NativeTaskEventClient({
    initialCursor: options.initialCursor ?? 0,
    strictCursor: options.strictCursor ?? true,
    batchIntervalMs: 10,
    minBackoffMs: 20,
    maxBackoffMs: 80,
    open: async (cursor, signal) => {
      collected.opens.push(cursor);
      return open(cursor, signal);
    },
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
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('condition not met in time');
}

describe('native task event stream client', () => {
  it('parses id/event/data frames, skips heartbeats and batches deduped delivery', async () => {
    const collected = collect();
    const client = startClient(async () => ({
      status: 200,
      body: streamOf([
        ': heartbeat\n\n',
        sseFrame(1, 'OUTPUT_DELTA', { delta: 'Hello ', nativeTurnId: 'turn-1' }),
        sseFrame(2, 'OUTPUT_DELTA', { delta: 'world', nativeTurnId: 'turn-1' }),
        sseFrame(2, 'OUTPUT_DELTA', { delta: 'world', nativeTurnId: 'turn-1' }), // replayed cursor dropped
        sseFrame(3, 'ASSISTANT_MESSAGE', { nativeTurnId: 'turn-1' })
      ])
    }), collected);
    try {
      await waitFor(() => client.getCursor() >= 3);
      await waitFor(() => collected.events.length >= 1);
      const flat = collected.events.flat();
      expect(flat.map((f) => f.cursor)).toEqual([1, 2, 3]);
      expect(flat[0]?.type).toBe('OUTPUT_DELTA');
      expect((flat[0]?.payload as { delta: string }).delta).toBe('Hello ');
      expect(flat[2]?.type).toBe('ASSISTANT_MESSAGE');
      expect(collected.resyncs).toEqual([]);
      expect(collected.opens[0]).toBe(0);
    } finally {
      client.stop();
    }
  });

  it('handles multi-line data and a frame split across chunks', async () => {
    const collected = collect();
    const client = startClient(async () => ({
      status: 200,
      body: streamOf([
        'id: 1\nevent: OUTPUT_DELTA\nda',
        'ta: {"delta":"line one"}\ndata: {"extra":true}\n\nid: 2\nevent: OUTPUT_DELTA\ndata: {}\n\n'
      ])
    }), collected);
    try {
      await waitFor(() => client.getCursor() >= 2);
      await waitFor(() => collected.events.flat().length >= 2);
      const flat = collected.events.flat();
      // Multi data: lines are joined with \n; the joined blob is not JSON so
      // it is carried through as raw text — never silently dropped.
      expect(flat[0]?.type).toBe('OUTPUT_DELTA');
      expect(flat.map((f) => f.cursor)).toEqual([1, 2]);
    } finally {
      client.stop();
    }
  });

  it('treats HTTP 400 and 409 as CURSOR_EXPIRED for caller resync', async () => {
    for (const status of [400, 409]) {
      const collected = collect();
      const client = startClient(async () => ({ status, body: null }), collected, { initialCursor: 7 });
      await waitFor(() => collected.resyncs.length >= 1);
      expect(collected.resyncs).toEqual(['CURSOR_EXPIRED']);
      expect(collected.opens).toEqual([7]);
      client.stop();
    }
  });

  it('strict cursor mode reports an in-stream gap as GAP resync', async () => {
    const collected = collect();
    const client = startClient(async () => ({
      status: 200,
      body: streamOf([sseFrame(1, 'OUTPUT_DELTA', { delta: 'a' }), sseFrame(4, 'OUTPUT_DELTA', { delta: 'd' })])
    }), collected);
    try {
      await waitFor(() => collected.resyncs.length >= 1);
      // Frames before the gap still delivered (batch flush follows shortly);
      // the gap frame itself never lands.
      await waitFor(() => collected.events.flat().length >= 1);
      expect(collected.resyncs).toEqual(['GAP']);
      expect(collected.events.flat().map((f) => f.cursor)).toEqual([1]);
      expect(collected.statuses).toContain('DISCONNECTED');
    } finally {
      client.stop();
    }
  });

  it('rejects unsafe cursor ids instead of dropping them silently', async () => {
    const collected = collect();
    const client = startClient(async () => ({
      status: 200,
      body: streamOf(['id: 9007199254740992\nevent: OUTPUT_DELTA\ndata: {}\n\n'])
    }), collected);
    try {
      await waitFor(() => collected.resyncs.length >= 1);
      expect(collected.resyncs).toEqual(['GAP']);
      expect(collected.events).toEqual([]);
    } finally {
      client.stop();
    }
  });

  it('reconnects with backoff and resumes from the last accepted cursor', async () => {
    const collected = collect();
    let round = 0;
    const client = startClient(async (cursor) => {
      round += 1;
      if (round === 1) {
        // First round: one frame then a clean server close -> reconnect.
        return { status: 200, body: streamOf([sseFrame(1, 'OUTPUT_DELTA', { delta: 'x' })]) };
      }
      return { status: 200, body: streamOf([sseFrame(cursor + 1, 'OUTPUT_DELTA', { delta: 'y' })], true) };
    }, collected);
    try {
      await waitFor(() => client.getCursor() >= 2, 5000);
      expect(collected.statuses).toContain('RECONNECTING');
      expect(collected.opens.length).toBeGreaterThanOrEqual(2);
      // Second open resumes at the last accepted cursor — not from zero.
      expect(collected.opens[1]).toBe(1);
      expect(collected.resyncs).toEqual([]);
    } finally {
      client.stop();
    }
  });

  it('retries after an open failure with RECONNECTING status', async () => {
    const collected = collect();
    let round = 0;
    const client = startClient(async () => {
      round += 1;
      if (round === 1) throw new Error('upstream unavailable');
      return { status: 200, body: streamOf([sseFrame(1, 'OUTPUT_DELTA', { delta: 'z' })], true) };
    }, collected);
    try {
      await waitFor(() => client.getCursor() >= 1, 5000);
      expect(collected.statuses[0]).toBe('RECONNECTING');
      expect(collected.statuses).toContain('CONNECTED');
      expect(collected.opens.length).toBeGreaterThanOrEqual(2);
    } finally {
      client.stop();
    }
  });

  it('restart(cursor) reopens at the explicit snapshot cursor', async () => {
    const collected = collect();
    // restart() before start(): the first open uses the resync cursor
    // exactly like a post-snapshot restart — no overlap with a live loop.
    const client = new NativeTaskEventClient({
      batchIntervalMs: 10,
      open: async (cursor) => {
        collected.opens.push(cursor);
        return { status: 200, body: streamOf([sseFrame(9, 'OUTPUT_DELTA', { delta: 'r' })], true) };
      },
      onEvents: (frames) => collected.events.push(frames),
      onResync: (reason) => collected.resyncs.push(reason),
      onStatus: (status) => collected.statuses.push(status)
    });
    try {
      client.restart(8);
      await waitFor(() => client.getCursor() >= 9);
      await waitFor(() => collected.events.flat().length >= 1);
      expect(collected.opens).toEqual([8]);
      expect(collected.events.flat().map((f) => f.cursor)).toEqual([9]);
    } finally {
      client.stop();
    }
  });
});
