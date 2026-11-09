/**
 * Durable control-stream client for the Electron main (desktop design
 * §9.4/§12.2). Connects to GET /api/v2/events with Last-Event-ID/cursor,
 * applies strict cursor monotonicity, batches delivery, reconnects with
 * backoff and hands CURSOR_EXPIRED to the caller for snapshot resync.
 *
 * Batched frames are forwarded to the renderer through a fixed IPC channel
 * by the caller; this module never talks to the renderer itself.
 */

export interface DurableEventFrame {
  cursor: number;
  type: string;
  payload: unknown;
}

export type DurableStreamStatus = 'CONNECTED' | 'DISCONNECTED' | 'RECONNECTING';

export interface DurableEventClientOptions {
  endpoint: string;
  token: string;
  clientSessionToken?: string;
  initialCursor?: number;
  fetchImpl?: typeof fetch;
  onEvents(frames: DurableEventFrame[]): void;
  /** CURSOR_EXPIRED: caller must re-snapshot then restart(cursor). */
  onResync(reason: 'CURSOR_EXPIRED' | 'GAP'): void;
  onStatus(status: DurableStreamStatus): void;
  /** session-scoped streams filter events, so gap detection is opt-in */
  strictCursor?: boolean;
  batchIntervalMs?: number;
  minBackoffMs?: number;
  maxBackoffMs?: number;
}

const DEFAULT_BATCH_MS = 80;
const DEFAULT_MIN_BACKOFF_MS = 1000;
const DEFAULT_MAX_BACKOFF_MS = 5000;

export class DurableEventClient {
  private readonly endpoint: string;
  private readonly token: string;
  private readonly clientSessionToken?: string;
  private readonly fetchImpl: typeof fetch;
  private readonly onEvents: DurableEventClientOptions['onEvents'];
  private readonly onResync: DurableEventClientOptions['onResync'];
  private readonly onStatus: DurableEventClientOptions['onStatus'];
  private readonly strictCursor: boolean;
  private readonly batchIntervalMs: number;
  private readonly minBackoffMs: number;
  private readonly maxBackoffMs: number;

  private cursor: number;
  private abort: AbortController | null = null;
  private stopped = true;
  private pending: DurableEventFrame[] = [];
  private batchTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private lastSeenCursorInStream: number | null = null;

  constructor(options: DurableEventClientOptions) {
    if (!options.endpoint || !options.token) {
      throw new Error('endpoint and token are required');
    }
    this.endpoint = options.endpoint.replace(/\/+$/, '');
    this.token = options.token;
    this.clientSessionToken = options.clientSessionToken;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.onEvents = options.onEvents;
    this.onResync = options.onResync;
    this.onStatus = options.onStatus;
    this.strictCursor = options.strictCursor ?? false;
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
        const url = `${this.endpoint}/api/v2/events?afterCursor=${this.cursor}`;
        const headers: Record<string, string> = {
            authorization: `Bearer ${this.token}`,
            accept: 'text/event-stream',
            'last-event-id': String(this.cursor)
        };
        if (this.clientSessionToken) {
          headers['X-CodeAgent-Client-Token'] = this.clientSessionToken;
        }
        const response = await this.fetchImpl(url, {
          headers,
          signal: this.abort.signal
        });
        if (response.status === 409) {
          this.onStatus('DISCONNECTED');
          this.stopped = true;
          this.onResync('CURSOR_EXPIRED');
          return;
        }
        if (!response.ok || !response.body) {
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
      // an unfiltered stream must be gapless; a gap means lost frames
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
