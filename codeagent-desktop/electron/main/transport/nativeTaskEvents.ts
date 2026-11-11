/**
 * Per-task worker-events/1 stream client for the Electron main (desktop
 * design §12.2 precedent — transport/durableEvents.ts). One instance owns
 * one task subscription: it opens the bounded personal-gateway event stream
 * through the injected `open` callback, applies cursor monotonicity, drops
 * duplicates, batches delivery, reconnects with backoff and hands
 * CURSOR_EXPIRED / GAP to the caller for snapshot resync.
 *
 * The `open` callback is fixed by the caller (ServiceClient personalTaskEvent
 * Stream through the personal operation whitelist) — this module never
 * builds a URL, holds a credential or talks to the renderer itself.
 */

export interface NativeTaskEventFrame {
  cursor: number;
  type: string;
  payload: unknown;
}

export type NativeTaskStreamStatus = 'CONNECTED' | 'DISCONNECTED' | 'RECONNECTING';

export interface NativeTaskStreamResponse {
  status: number;
  body: ReadableStream<Uint8Array> | null;
}

export interface NativeTaskEventClientOptions {
  /** Opens the negotiated event stream at `cursor`; `signal` ends the open. */
  open(cursor: number, signal: AbortSignal): Promise<NativeTaskStreamResponse>;
  initialCursor?: number;
  onEvents(frames: NativeTaskEventFrame[]): void;
  /** CURSOR_EXPIRED: caller must re-snapshot then restart(cursor). */
  onResync(reason: 'CURSOR_EXPIRED' | 'GAP'): void;
  onStatus(status: NativeTaskStreamStatus): void;
  /** Unfiltered per-task streams are gapless; strict is the default here. */
  strictCursor?: boolean;
  batchIntervalMs?: number;
  minBackoffMs?: number;
  maxBackoffMs?: number;
}

const DEFAULT_BATCH_MS = 80;
const DEFAULT_MIN_BACKOFF_MS = 1000;
const DEFAULT_MAX_BACKOFF_MS = 5000;

export class NativeTaskEventClient {
  private readonly open: NativeTaskEventClientOptions['open'];
  private readonly onEvents: NativeTaskEventClientOptions['onEvents'];
  private readonly onResync: NativeTaskEventClientOptions['onResync'];
  private readonly onStatus: NativeTaskEventClientOptions['onStatus'];
  private readonly strictCursor: boolean;
  private readonly batchIntervalMs: number;
  private readonly minBackoffMs: number;
  private readonly maxBackoffMs: number;

  private cursor: number;
  private abort: AbortController | null = null;
  private stopped = true;
  private pending: NativeTaskEventFrame[] = [];
  private batchTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private lastSeenCursorInStream: number | null = null;

  constructor(options: NativeTaskEventClientOptions) {
    this.open = options.open;
    this.onEvents = options.onEvents;
    this.onResync = options.onResync;
    this.onStatus = options.onStatus;
    this.strictCursor = options.strictCursor ?? true;
    this.batchIntervalMs = options.batchIntervalMs ?? DEFAULT_BATCH_MS;
    this.minBackoffMs = options.minBackoffMs ?? DEFAULT_MIN_BACKOFF_MS;
    this.maxBackoffMs = options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
    this.cursor = validateCursor(options.initialCursor ?? 0);
  }

  getCursor(): number {
    return this.cursor;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    void this.connectLoop();
  }

  /** Resumes from an explicit cursor after a snapshot resync. */
  restart(cursor: number): void {
    this.cursor = validateCursor(cursor);
    this.lastSeenCursorInStream = null;
    this.stop();
    this.stopped = false;
    void this.connectLoop();
  }

  stop(): void {
    this.stopped = true;
    this.abort?.abort();
    this.abort = null;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.flushBatch();
  }

  private async connectLoop(): Promise<void> {
    let backoff = this.minBackoffMs;
    while (!this.stopped) {
      this.abort = new AbortController();
      try {
        const response = await this.open(this.cursor, this.abort.signal);
        // worker-events/1 answers a stale/conflicting cursor with HTTP 400;
        // durable treats 409 the same way. Both are cursor-resync signals —
        // never silent reconnects that would fabricate or drop positions.
        if (response.status === 400 || response.status === 409) {
          this.onStatus('DISCONNECTED');
          this.stopped = true;
          this.onResync('CURSOR_EXPIRED');
          return;
        }
        if (response.status < 200 || response.status >= 300 || !response.body) {
          throw new Error(`event stream returned HTTP ${response.status}`);
        }
        this.onStatus('CONNECTED');
        backoff = this.minBackoffMs;
        this.lastSeenCursorInStream = null;
        await this.consumeStream(response.body);
        // server closed the stream cleanly -> reconnect unless stopped
        if (this.stopped) return;
        this.onStatus('RECONNECTING');
        await this.delay(backoff);
        backoff = Math.min(backoff * 2, this.maxBackoffMs);
      } catch (aborted) {
        if (this.stopped) return;
        this.onStatus('RECONNECTING');
        await this.delay(backoff);
        backoff = Math.min(backoff * 2, this.maxBackoffMs);
      }
    }
  }

  private async consumeStream(body: ReadableStream<Uint8Array>): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        buffer += decoder.decode(value, { stream: true });
        let separator: number;
        while ((separator = findFrameEnd(buffer)) >= 0) {
          const rawFrame = buffer.slice(0, separator);
          buffer = buffer.slice(separator + frameSeparatorLength(buffer, separator));
          this.handleRawFrame(rawFrame);
        }
      }
    } finally {
      try { reader.releaseLock(); } catch { /* body already closed */ }
    }
  }

  private handleRawFrame(rawFrame: string): void {
    let id: string | null = null;
    let event: string | null = null;
    const dataLines: string[] = [];
    for (const line of rawFrame.split('\n')) {
      const trimmed = line.endsWith('\r') ? line.slice(0, -1) : line;
      if (trimmed.startsWith(':')) continue; // comment/heartbeat
      if (trimmed.startsWith('id:')) id = trimmed.slice(3).trim();
      else if (trimmed.startsWith('event:')) event = trimmed.slice(6).trim();
      else if (trimmed.startsWith('data:')) dataLines.push(trimmed.slice(5).trim());
    }
    if (id === null) return; // comment-only frame
    if (!/^\d{1,19}$/.test(id)) {
      this.onStatus('DISCONNECTED');
      this.stopped = true;
      this.onResync('GAP');
      this.abort?.abort();
      return;
    }
    const cursor = Number.parseInt(id, 10);
    if (!Number.isSafeInteger(cursor) || cursor < 0) {
      this.onStatus('DISCONNECTED');
      this.stopped = true;
      this.onResync('GAP');
      this.abort?.abort();
      return;
    }
    // strict cursor monotonicity (design §12.2); duplicates are dropped
    if (cursor <= this.cursor) return;
    if (this.strictCursor && this.lastSeenCursorInStream !== null
        && cursor !== this.lastSeenCursorInStream + 1) {
      // a per-task event feed must be gapless; a gap means lost deltas
      this.onStatus('DISCONNECTED');
      this.stopped = true;
      this.onResync('GAP');
      this.abort?.abort();
      return;
    }
    this.lastSeenCursorInStream = cursor;
    this.cursor = cursor;
    let payload: unknown = null;
    const data = dataLines.join('\n');
    if (data.length > 0) {
      try { payload = JSON.parse(data); } catch { payload = data; }
    }
    this.pending.push({ cursor, type: event ?? 'message', payload });
    if (this.batchTimer === null) {
      this.batchTimer = setTimeout(() => this.flushBatch(), this.batchIntervalMs);
    }
  }

  private flushBatch(): void {
    if (this.batchTimer !== null) {
      clearTimeout(this.batchTimer);
      this.batchTimer = null;
    }
    if (this.pending.length === 0) return;
    const batch = this.pending;
    this.pending = [];
    this.onEvents(batch);
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.reconnectTimer = setTimeout(resolve, ms);
    });
  }
}

function validateCursor(cursor: number): number {
  if (!Number.isSafeInteger(cursor) || cursor < 0) {
    throw new Error('cursor must be a non-negative safe integer');
  }
  return cursor;
}

function findFrameEnd(buffer: string): number {
  const lf = buffer.indexOf('\n\n');
  const crlf = buffer.indexOf('\r\n\r\n');
  if (lf < 0) return crlf;
  if (crlf < 0) return lf;
  return Math.min(lf, crlf);
}

function frameSeparatorLength(buffer: string, separator: number): number {
  return buffer.startsWith('\r\n\r\n', separator) ? 4 : 2;
}
