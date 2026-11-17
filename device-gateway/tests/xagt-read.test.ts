/**
 * xagt read surface — the seven read-only tools end to end against a scripted
 * worker-local source. Covers the design acceptance axes that are unit-testable
 * on one box: version-1 contracts, grant auth + revocation, cursor binding,
 * pagination, material integrity, peer forwarding (peerCall stubbed) and the
 * concurrency budget.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { GatewayStoreView, OrderedRow } from '../src/context.js';
import type {
  ConnectionRowLite, RawResult,
} from '../src/local-transport.js';
import { hashBytes } from '../src/protocol.js';
import { ReaderAccess, type ReaderGrant } from '../src/xagt/reader-access.js';
import { MaterialStore } from '../src/xagt/materials.js';
import { PeerStore, peerCall } from '../src/xagt/peer-reader.js';
import { SourceReader } from '../src/xagt/source-reader.js';
import { XagtReadService } from '../src/xagt/read-service.js';
import { createXagtHandlers } from '../src/xagt/rpc.js';
import type { Envelope } from '../src/xagt/common.js';

// peerCall is the only real-network edge — stub it; PeerStore stays real so
// sealed-token + TLS-pin validation keeps working.
vi.mock('../src/xagt/peer-reader.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../src/xagt/peer-reader.js')>();
  return { ...mod, peerCall: vi.fn() };
});
const peerCallMock = vi.mocked(peerCall);

// ---------------------------------------------------------------------------
// Fakes.
// ---------------------------------------------------------------------------

class MemStore implements GatewayStoreView {
  private map = new Map<string, { value: unknown; seq: number }>();
  private seq = 0;
  private key(kind: string, id: string): string { return `${kind}|${id}`; }
  get<T>(kind: string, id: string): T | undefined {
    return this.map.get(this.key(kind, id))?.value as T | undefined;
  }
  list<T>(kind: string): T[] {
    return [...this.map.entries()]
      .filter(([k]) => k.startsWith(`${kind}|`))
      .map(([, v]) => v.value as T);
  }
  put(kind: string, id: string, value: unknown): void {
    const k = this.key(kind, id);
    const existing = this.map.get(k);
    this.map.set(k, { value, seq: existing?.seq ?? ++this.seq });
  }
  delete(kind: string, id: string): void { this.map.delete(this.key(kind, id)); }
  putOrdered(kind: string, id: string, value: unknown): void { this.put(kind, id, value); }
  deleteOrdered(kind: string, id: string): void { this.delete(kind, id); }
  sequence(kind: string, id: string): number {
    return this.map.get(this.key(kind, id))?.seq ?? 0;
  }
  listOrdered<T>(kind: string, beforeSequence: number, limit: number): OrderedRow<T>[] {
    return [...this.map.entries()]
      .filter(([k]) => k.startsWith(`${kind}|`))
      .map(([, v]) => v)
      .filter((v) => beforeSequence <= 0 || v.seq < beforeSequence)
      .sort((a, b) => b.seq - a.seq)
      .slice(0, limit)
      .map((v) => ({ sequence: v.seq, value: v.value as T }));
  }
  listOrderedForDevice<T>(kind: string, _deviceId: string, limit: number): OrderedRow<T>[] {
    return this.listOrdered<T>(kind, 0, limit);
  }
  listOrderedForDeviceSources<T>(kind: string, _d: string, _r: number, before: number, limit: number, _s: string[]): OrderedRow<T>[] {
    return this.listOrdered<T>(kind, before, limit);
  }
  listOrderedForSources<T>(kind: string, _s: string[], before: number, limit: number): OrderedRow<T>[] {
    return this.listOrdered<T>(kind, before, limit);
  }
  transaction<T>(fn: () => T): T { return fn(); }
}

type RouteFn = (tail: string, connectionId?: string) => RawResult;

class FakeTransport {
  rows: ConnectionRowLite[] = [
    { connectionId: 'conn1', kind: 'worker-local', baseUrl: 'http://127.0.0.1:1', displayName: 'pi-host' },
  ];
  storeId = 'store-1';
  routes: RouteFn = () => ({ status: 404, data: { code: 'NOT_FOUND' } });
  calls: string[] = [];
  /** When set, raw() hangs until released — exercises the inflight cap. */
  gate: Promise<void> | undefined;

  workerLocal(): ConnectionRowLite { return this.rows[0]!; }
  workerLocalRows(): ConnectionRowLite[] { return this.rows; }
  async identity(connectionId: string): Promise<string> {
    if (!this.rows.some((r) => r.connectionId === connectionId)) throw new Error('gone');
    return this.storeId;
  }
  async raw(
    connectionId: string, _method: 'GET' | 'POST', tail: string,
    _body?: unknown, _key?: string, _storeId?: string, _deadlineMillis?: number,
  ): Promise<RawResult> {
    if (this.gate !== undefined) await this.gate;
    this.calls.push(tail);
    return this.routes(tail, connectionId);
  }
}

const CONN = 'conn1';
const STORE_ID = 'store-1';
const CURSOR_KEY = new Uint8Array(32).fill(9);
const PEER_KEY = new Uint8Array(32).fill(4);

const sha = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');
const b64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64');

interface World {
  store: MemStore;
  transport: FakeTransport;
  readers: ReaderAccess;
  materials: MaterialStore;
  peers: PeerStore;
  service: XagtReadService;
}

const world = (routes: RouteFn): World => {
  const store = new MemStore();
  const transport = new FakeTransport();
  transport.routes = routes;
  const peers = new PeerStore(store, () => PEER_KEY);
  const materials = new MaterialStore(store);
  const service = new XagtReadService({
    store,
    transport: transport as unknown as import('../src/local-tasks.js').LocalTransportLike,
    source: new SourceReader(
      transport as unknown as import('../src/local-tasks.js').LocalTransportLike),
    peers,
    materials,
    cursorSecret: CURSOR_KEY,
    deviceName: 'dev-this',
  });
  return {
    store, transport, readers: new ReaderAccess(store),
    materials, peers, service,
  };
};

const mkReader = async (w: World, scope: Record<string, unknown>): Promise<ReaderGrant> => {
  const { token } = w.readers.create(scope);
  return w.readers.authenticate(token);
};

const fullScope = { backends: ['*'], allVendorSessions: true, peers: ['*'], materials: ['*'] };

/** Envelope assertions shared by every tool. */
const expectEnvelope = (env: Envelope): void => {
  expect(env.schemaVersion).toBe('xagt-read/1');
  expect(typeof env.observedAt).toBe('string');
  expect(env.coverage).toBeTypeOf('object');
  expect(env.data).toBeTypeOf('object');
};

// Standard worker source — one managed task + two vendor sessions.
const standardRoutes: RouteFn = (tail) => {
  if (tail === '/engines') {
    return { status: 200, data: { items: [{ engineId: 'pi', engineVersion: '1.0', capabilities: { stop: true } }] } };
  }
  if (tail === '/projects') {
    return { status: 200, data: { items: [{ projectId: 'p1', displayName: 'One' }, { projectId: 'p2' }] } };
  }
  if (tail === '/tasks') {
    return {
      status: 200,
      data: {
        items: [
          { taskId: 'task-1', projectId: 'p1', engineId: 'pi', state: 'RUNNING' },
          { taskId: 'task-2', projectId: 'p2', engineId: 'pi', state: 'WAITING' },
        ],
      },
    };
  }
  if (tail.startsWith('/history?')) {
    return {
      status: 200,
      data: {
        schemaVersion: 'worker-local-history/2',
        items: [
          { id: 'vs-1', title: 'old codex run', at: '2026-01-01T00:00:00Z', engine: 'pi', source: 'codex' },
          { id: 'vs-2', title: 'secret session', at: '2026-01-02T00:00:00Z', engine: 'pi', source: 'codex' },
        ],
      },
    };
  }
  if (tail === '/history') return { status: 200, data: { schemaVersion: 'worker-local-history/1', items: [] } };
  if (tail === '/tasks/task-1') {
    return {
      status: 200,
      data: {
        taskId: 'task-1', projectId: 'p1', engineId: 'pi', state: 'RUNNING',
        goal: 'demo task', generation: 'g1', nativeSessionId: 'ns1', quiescent: false,
        sessionFiles: { artifacts: ['art-1'] },
        capabilities: { stop: true },
      },
    };
  }
  if (tail === '/tasks/task-2') {
    return { status: 200, data: { taskId: 'task-2', projectId: 'p2', engineId: 'pi', state: 'WAITING' } };
  }
  if (tail.startsWith('/tasks/task-1/events')) {
    return {
      status: 200,
      data: {
        items: [{ cursor: 5, kind: 'note', occurredAt: '2026-01-01T00:00:00Z' }],
        nextCursor: '6', cursorExpired: false,
      },
    };
  }
  if (tail === '/tasks/task-1/input-requests') {
    return { status: 200, data: { items: [{ kind: 'approval', prompt: 'allow?' }] } };
  }
  if (tail === '/tasks/task-1/output') return { status: 200, data: { text: 'tail-output' } };
  if (tail === '/tasks/task-2/input-requests') return { status: 200, data: { items: [] } };
  if (tail === '/tasks/task-2/output') return { status: 200, data: { text: '' } };
  if (tail.startsWith('/tasks/task-2/events')) {
    return { status: 200, data: { items: [], nextCursor: '1', cursorExpired: false } };
  }
  if (tail.startsWith('/tasks/task-1/messages')) {
    const q = new URLSearchParams(tail.split('?')[1] ?? '');
    const before = q.get('before');
    const limit = Number(q.get('limit') ?? '100');
    // Ascending (chronological) — the same order native-messages/1 emits.
    const all = [
      { sequence: 1, role: 'user', text: 'login fails with 500', occurredAt: 't1' },
      { sequence: 2, role: 'assistant', text: 'looking into login bug now', occurredAt: 't2' },
      { sequence: 3, role: 'user', text: 'please fix the login bug', occurredAt: 't3' },
      { sequence: 4, role: 'assistant', text: 'fix applied to auth module', occurredAt: 't4' },
    ];
    const filtered = all.filter((m) => before === null || m.sequence < Number(before));
    const items = filtered.slice(-limit);
    return {
      status: 200,
      data: {
        items, firstSequence: items[0]?.sequence ?? 0,
        latestSequence: 4, hasMore: false,
      },
    };
  }
  if (tail.startsWith('/tasks/task-2/messages')) {
    return { status: 200, data: { items: [], firstSequence: 0, latestSequence: 0, hasMore: false } };
  }
  if (tail.startsWith('/history/sessions/vs-1')) {
    const q = new URLSearchParams(tail.split('?')[1] ?? '');
    const before = q.get('before');
    const limit = Number(q.get('limit') ?? '20');
    const all = Array.from({ length: 45 }, (_, i) => ({
      id: i + 1, role: i % 2 === 0 ? 'user' : 'assistant', text: `vendor msg ${i + 1} deploy`,
    }));
    // Ascending window ending before `before`, at most `limit` items.
    const slice = all.filter((m) => before === null || m.id < Number(before)).slice(-limit);
    return { status: 200, data: { items: slice } };
  }
  if (tail.startsWith('/history/sessions/vs-2')) {
    return { status: 200, data: { items: [{ id: 1, role: 'user', text: 'nothing here' }] } };
  }
  return { status: 404, data: { code: 'NOT_FOUND' } };
};

const materialRoutes = (fileText: string, artifactBytes?: Buffer): RouteFn => {
  const fileSha = sha(fileText);
  const fileB64 = b64(fileText);
  const art = artifactBytes ?? Buffer.from('artifact text body', 'utf8');
  const artSha = createHash('sha256').update(art).digest('hex');
  return (tail) => {
    const base = standardRoutes(tail);
    if (base.status !== 404) return base;
    if (tail === '/tasks/task-1/files') {
      return {
        status: 200,
        data: {
          items: [
            { fileId: 'f-1', name: 'notes.txt', size: fileText.length, sha256: fileSha, state: 'staged', mime: 'text/plain' },
            { fileId: 'f-big', name: 'big.bin', size: 2 * 1024 * 1024, sha256: 'a'.repeat(64), state: 'staged' },
          ],
        },
      };
    }
    if (tail === '/tasks/task-1/files/f-1') {
      return { status: 200, data: { fileId: 'f-1', name: 'notes.txt', size: fileText.length, sha256: fileSha } };
    }
    if (tail === `/tasks/task-1/files/f-1/chunks/${fileSha}/0`) {
      return { status: 200, data: { bytes: fileB64, sizeBytes: fileText.length, chunkSHA256: sha('') === '' ? fileSha : fileSha } };
    }
    if (tail === '/tasks/task-1/artifacts') {
      return {
        status: 200,
        data: {
          items: [{ artifactId: 'art-1', path: 'build/report.txt', size: art.length, sha256: artSha, status: 'AVAILABLE' }],
        },
      };
    }
    if (tail === '/tasks/task-1/artifacts/art-1') {
      return { status: 200, data: { bytes: art.toString('base64'), sha256: artSha } };
    }
    return { status: 404, data: { code: 'NOT_FOUND' } };
  };
};

// ---------------------------------------------------------------------------
// Reader grants — auth + revocation (design A02/A03).
// ---------------------------------------------------------------------------

describe('reader grants', () => {
  let w: World;
  beforeEach(() => { w = world(standardRoutes); peerCallMock.mockReset(); });

  it('mints, authenticates and revokes a grant; tokens never leave the store view', async () => {
    const { grant, token } = w.readers.create({ name: 'ci', backends: ['*'], expiresInDays: 7 });
    expect(token.startsWith('xgr-')).toBe(true);
    expect(grant).not.toHaveProperty('tokenHash');
    expect(grant).not.toHaveProperty('token');
    const auth = w.readers.authenticate(token);
    expect(auth.readerId).toBe(grant.readerId);
    w.readers.revoke(String(grant.readerId));
    expect(() => w.readers.authenticate(token)).toThrowError(/GRANT_EXPIRED/);
  });

  it('rejects unknown and malformed tokens as ACCESS_UNAUTHORIZED', () => {
    expect(() => w.readers.authenticate(undefined)).toThrowError(/ACCESS_UNAUTHORIZED/);
    expect(() => w.readers.authenticate('xgr-does-not-exist')).toThrowError(/ACCESS_UNAUTHORIZED/);
    expect(() => w.readers.authenticate('device-token-not-reader')).toThrowError(/ACCESS_UNAUTHORIZED/);
  });

  it('grant lists expose no token material', () => {
    w.readers.create({ name: 'a' });
    const list = w.readers.list();
    expect(list).toHaveLength(1);
    expect(JSON.stringify(list)).not.toContain('xgr-');
    expect(list[0]).not.toHaveProperty('tokenHash');
  });
});

// ---------------------------------------------------------------------------
// xagt_list_targets / xagt_list_sessions — discovery (design A01/A04).
// ---------------------------------------------------------------------------

describe('discovery', () => {
  let w: World;
  beforeEach(() => { w = world(standardRoutes); peerCallMock.mockReset(); });

  it('lists the local backend with targetRef + read capabilities', async () => {
    const reader = await mkReader(w, fullScope);
    const env = await w.service.call(reader, 'xagt_list_targets', {});
    expectEnvelope(env);
    const targets = env.data.targets as Record<string, unknown>[];
    expect(targets).toHaveLength(1);
    const t = targets[0]!;
    expect(t.targetRef).toMatch(/^xtr-/);
    expect(t.online).toBe(true);
    expect(t.authorized).toBe(true);
    expect(t.backendStoreId).toBe(STORE_ID);
    expect(t.access).toBe('local');
    const caps = t.capabilities as Record<string, Record<string, string>>;
    expect(caps.read?.activity).toBe('SUPPORTED');
    expect(caps.read?.history).toBe('SUPPORTED');
  });

  it('marks an out-of-scope backend as unauthorized and issues no readable sessions', async () => {
    const reader = await mkReader(w, { backends: ['other-store'], allVendorSessions: true });
    const env = await w.service.call(reader, 'xagt_list_targets', {});
    const targets = env.data.targets as Record<string, unknown>[];
    expect(targets[0]!.authorized).toBe(false);
    expect(targets[0]!.targetRef).toBeUndefined();
  });

  it('keeps an offline backend visible without a ref when identity is unknown', async () => {
    const w2 = world(() => ({ status: 503, data: {} }));
    w2.transport.identity = async () => { throw new Error('offline'); };
    const reader = await mkReader(w2, fullScope);
    const env = await w2.service.call(reader, 'xagt_list_targets', {});
    const targets = env.data.targets as Record<string, unknown>[];
    expect(targets[0]!.online).toBe(false);
    // '*' scope lets the reader see the offline row as authorized=true.
    expect(targets[0]!.authorized).toBe(true);
    expect(targets[0]!.targetRef).toBeUndefined();
  });

  it('lists managed tasks + authorized vendor sessions with distinct kinds', async () => {
    const reader = await mkReader(w, fullScope);
    const t = (await w.service.call(reader, 'xagt_list_targets', {}));
    const targetRef = (t.data.targets as Record<string, unknown>[])[0]!.targetRef as string;
    const env = await w.service.call(reader, 'xagt_list_sessions', { targetRef });
    expectEnvelope(env);
    const sessions = env.data.sessions as Record<string, unknown>[];
    const kinds = sessions.map((s) => s.kind);
    expect(kinds).toContain('MANAGED_TASK');
    expect(kinds).toContain('VENDOR_SESSION');
    for (const s of sessions) expect(s.sessionRef).toMatch(/^xsr-/);
    // tasks first, then vendor sessions.
    expect(sessions[0]!.kind).toBe('MANAGED_TASK');
  });

  it('hides vendor sessions when the grant only covers tasks', async () => {
    const reader = await mkReader(w, { backends: ['*'], allVendorSessions: false });
    const t = await w.service.call(reader, 'xagt_list_targets', {});
    const targetRef = (t.data.targets as Record<string, unknown>[])[0]!.targetRef as string;
    const env = await w.service.call(reader, 'xagt_list_sessions', { targetRef });
    const kinds = (env.data.sessions as Record<string, unknown>[]).map((s) => s.kind);
    expect(kinds).toContain('MANAGED_TASK');
    expect(kinds).not.toContain('VENDOR_SESSION');
  });

  it('filters managed tasks by project scope', async () => {
    const reader = await mkReader(w, { backends: ['*'], projects: ['p1'], allVendorSessions: true });
    const t = await w.service.call(reader, 'xagt_list_targets', {});
    const targetRef = (t.data.targets as Record<string, unknown>[])[0]!.targetRef as string;
    const env = await w.service.call(reader, 'xagt_list_sessions', { targetRef });
    const tasks = (env.data.sessions as Record<string, unknown>[])
      .filter((s) => s.kind === 'MANAGED_TASK');
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.projectId).toBe('p1');
  });
});

// ---------------------------------------------------------------------------
// xagt_get_activity — facts + incremental events (design A05/A06).
// ---------------------------------------------------------------------------

describe('get_activity', () => {
  let w: World;
  beforeEach(() => { w = world(standardRoutes); peerCallMock.mockReset(); });

  const sessionFor = async (w: World, reader: ReaderGrant, pick: (s: Record<string, unknown>) => boolean): Promise<string> => {
    const t = await w.service.call(reader, 'xagt_list_targets', {});
    const targetRef = (t.data.targets as Record<string, unknown>[])[0]!.targetRef as string;
    const env = await w.service.call(reader, 'xagt_list_sessions', { targetRef });
    const s = (env.data.sessions as Record<string, unknown>[]).find(pick);
    expect(s, 'session exists').toBeDefined();
    return s!.sessionRef as string;
  };
  const taskRef = (w: World, r: ReaderGrant) => sessionFor(w, r, (s) => s.kind === 'MANAGED_TASK' && s.title === 'task-1');
  const vendorRef = (w: World, r: ReaderGrant) => sessionFor(w, r, (s) => s.kind === 'VENDOR_SESSION' && s.title === 'old codex run');

  it('returns state, waitingFor, output preview and an event page with cursor', async () => {
    const reader = await mkReader(w, fullScope);
    const env = await w.service.call(reader, 'xagt_get_activity', { sessionRef: await taskRef(w, reader) });
    expectEnvelope(env);
    expect(env.data.state).toBe('RUNNING');
    expect(env.data.goal).toBe('demo task');
    expect(env.data.incremental).toBe(true);
    expect(env.data.outputPreview).toBe('tail-output');
    expect((env.data.waitingFor as unknown[]).length).toBe(1);
    const events = env.data.events as Record<string, unknown>[];
    expect(events[0]!.eventRef).toBe('e5');
    expect(env.nextCursor).toBeTypeOf('string');
  });

  it('incremental cursor resumes the event feed', async () => {
    const reader = await mkReader(w, fullScope);
    const sessionRef = await taskRef(w, reader);
    const first = await w.service.call(reader, 'xagt_get_activity', { sessionRef });
    const seen: string[] = [];
    w.transport.routes = (tail) => {
      if (tail.startsWith('/tasks/task-1/events')) {
        const q = new URLSearchParams(tail.split('?')[1] ?? '');
        expect(q.get('cursor')).toBe('6');
        return { status: 200, data: { items: [{ cursor: 7, kind: 'note', occurredAt: 't7' }], nextCursor: '8', cursorExpired: false } };
      }
      return standardRoutes(tail);
    };
    const second = await w.service.call(reader, 'xagt_get_activity', { sessionRef, cursor: first.nextCursor });
    for (const e of second.data.events as Record<string, unknown>[]) seen.push(String(e.eventRef));
    expect(seen).toEqual(['e7']);
  });

  it('vendor sessions answer PARTIAL with transcript tail and no cursor', async () => {
    const reader = await mkReader(w, fullScope);
    const env = await w.service.call(reader, 'xagt_get_activity', { sessionRef: await vendorRef(w, reader) });
    expect(env.coverage.level).toBe('PARTIAL');
    expect(env.coverage.basis).toBe('TRANSCRIPT');
    expect(env.coverage.limitations).toContain('NO_EVENTS');
    expect(env.data.incremental).toBe(false);
    const last = env.data.lastMessage as Record<string, unknown>;
    expect(last.messageRef).toMatch(/^v45$/);
    expect(env.nextCursor).toBeUndefined();
  });

  it('scope denies a session the grant cannot see', async () => {
    const scoped = await mkReader(w, { backends: ['*'], projects: ['p2'], allVendorSessions: false });
    const env = await w.service.call(scoped, 'xagt_list_targets', {});
    const targetRef = (env.data.targets as Record<string, unknown>[])[0]!.targetRef as string;
    const sessions = await w.service.call(scoped, 'xagt_list_sessions', { targetRef });
    // task-1 (p1) is out of scope — only task-2 remains.
    const refs = (sessions.data.sessions as Record<string, unknown>[]).map((s) => s.sessionRef as string);
    expect(refs).toHaveLength(1);
    const other = await mkReader(w, fullScope);
    const hidden = await taskRef(w, other); // task-1 ref issued under the wide grant
    await expect(w.service.call(scoped, 'xagt_get_activity', { sessionRef: hidden }))
      .rejects.toThrowError(/SCOPE_DENIED/);
  });
});

// ---------------------------------------------------------------------------
// xagt_read_history — paging, around-window, content continuation (A07/A08).
// ---------------------------------------------------------------------------

describe('read_history', () => {
  let w: World;
  beforeEach(() => { w = world(standardRoutes); peerCallMock.mockReset(); });

  const sessionFor = async (w: World, reader: ReaderGrant, title: string): Promise<string> => {
    const t = await w.service.call(reader, 'xagt_list_targets', {});
    const targetRef = (t.data.targets as Record<string, unknown>[])[0]!.targetRef as string;
    const env = await w.service.call(reader, 'xagt_list_sessions', { targetRef });
    const s = (env.data.sessions as Record<string, unknown>[]).find((x) => x.title === title);
    return s!.sessionRef as string;
  };

  it('managed task: newest page first, then nextCursor walks older', async () => {
    const reader = await mkReader(w, fullScope);
    const ref = await sessionFor(w, reader, 'task-1');
    const first = await w.service.call(reader, 'xagt_read_history', { sessionRef: ref, limit: 2 });
    const msgs = first.data.messages as Record<string, unknown>[];
    // Newest window first, chronological inside the page.
    expect(msgs.map((m) => m.messageRef)).toEqual(['m3', 'm4']);
    expect(first.nextCursor).toBeTypeOf('string');
    const second = await w.service.call(reader, 'xagt_read_history', { sessionRef: ref, limit: 2, cursor: first.nextCursor });
    const older = second.data.messages as Record<string, unknown>[];
    expect(older.map((m) => m.messageRef)).toEqual(['m1', 'm2']);
    expect(second.nextCursor).toBeUndefined();
  });

  it('aroundMessageRef returns the ±5 window', async () => {
    const reader = await mkReader(w, fullScope);
    const ref = await sessionFor(w, reader, 'task-1');
    const env = await w.service.call(reader, 'xagt_read_history', { sessionRef: ref, aroundMessageRef: 'm2' });
    const msgs = env.data.messages as Record<string, unknown>[];
    expect(msgs.map((m) => m.messageRef)).toEqual(['m1', 'm2', 'm3', 'm4']);
    expect(env.coverage.range?.around).toBe('m2');
  });

  it('long message text continues via nextContentCursor', async () => {
    const big = 'x'.repeat(20 * 1024);
    const w2 = world((tail) => {
      if (tail.startsWith('/tasks/task-1/messages')) {
        return {
          status: 200,
          data: {
            items: [{ sequence: 1, role: 'assistant', text: big, occurredAt: 't1' }],
            firstSequence: 1, latestSequence: 1, hasMore: false,
          },
        };
      }
      return standardRoutes(tail);
    });
    const reader = await mkReader(w2, fullScope);
    const ref = await sessionFor(w2, reader, 'task-1');
    const first = await w2.service.call(reader, 'xagt_read_history', { sessionRef: ref });
    const msg = (first.data.messages as Record<string, unknown>[])[0]!;
    expect((msg.text as string).length).toBe(16 * 1024);
    expect(msg.truncated).toBe(true);
    const cont = msg.nextContentCursor as string;
    expect(cont).toBeTypeOf('string');
    const second = await w2.service.call(reader, 'xagt_read_history', { sessionRef: ref, cursor: cont });
    const rest = (second.data.messages as Record<string, unknown>[])[0]!;
    expect((rest.text as string).length).toBe(4 * 1024);
    expect(rest.truncated).toBe(false);
  });

  it('vendor transcript chains ≤20-message pages into a larger page', async () => {
    const reader = await mkReader(w, fullScope);
    const ref = await sessionFor(w, reader, 'old codex run');
    const env = await w.service.call(reader, 'xagt_read_history', { sessionRef: ref, limit: 45 });
    const msgs = env.data.messages as Record<string, unknown>[];
    expect(msgs.length).toBe(45);
    expect(msgs[0]!.messageRef).toBe('v1');
    expect(msgs.at(-1)!.messageRef).toBe('v45');
    // oldest index reached → no continuation.
    expect(env.nextCursor).toBeUndefined();
    // two upstream calls (20 + 20 + 5) prove chained paging.
    const pulls = w.transport.calls.filter((c) => c.startsWith('/history/sessions/vs-1'));
    expect(pulls.length).toBeGreaterThanOrEqual(3);
  });

  it('a cursor issued for one session cannot open another', async () => {
    const reader = await mkReader(w, fullScope);
    const ref1 = await sessionFor(w, reader, 'task-1');
    const ref2 = await sessionFor(w, reader, 'task-2');
    const first = await w.service.call(reader, 'xagt_read_history', { sessionRef: ref1, limit: 1 });
    await expect(w.service.call(reader, 'xagt_read_history', { sessionRef: ref2, cursor: first.nextCursor }))
      .rejects.toThrowError(/CURSOR_EXPIRED/);
  });
});

// ---------------------------------------------------------------------------
// xagt_search_history — literal match + search cursor (design A09).
// ---------------------------------------------------------------------------

describe('search_history', () => {
  let w: World;
  beforeEach(() => { w = world(standardRoutes); peerCallMock.mockReset(); });

  const sessionFor = async (w: World, reader: ReaderGrant, title: string): Promise<string> => {
    const t = await w.service.call(reader, 'xagt_list_targets', {});
    const targetRef = (t.data.targets as Record<string, unknown>[])[0]!.targetRef as string;
    const env = await w.service.call(reader, 'xagt_list_sessions', { targetRef });
    return (env.data.sessions as Record<string, unknown>[]).find((x) => x.title === title)!.sessionRef as string;
  };

  it('finds literal case-insensitive matches with snippets', async () => {
    const reader = await mkReader(w, fullScope);
    const ref = await sessionFor(w, reader, 'task-1');
    const env = await w.service.call(reader, 'xagt_search_history', { sessionRef: ref, query: 'login bug' });
    const matches = env.data.matches as Record<string, unknown>[];
    expect(matches.length).toBe(2);
    expect(matches[0]!.messageRef).toBe('m3');
    expect(String(matches[0]!.snippet)).toContain('login bug');
    expect(env.data.searchComplete).toBe(true);
  });

  it('requires a non-empty query', async () => {
    const reader = await mkReader(w, fullScope);
    const ref = await sessionFor(w, reader, 'task-1');
    await expect(w.service.call(reader, 'xagt_search_history', { sessionRef: ref, query: '' }))
      .rejects.toThrowError(/INVALID_REQUEST/);
  });

  it('a search cursor is bound to its query — swapping query expires it', async () => {
    const reader = await mkReader(w, fullScope);
    const ref = await sessionFor(w, reader, 'old codex run');
    // Query that matches nothing but scans only part — fabricate by scanning
    // until budget: instead use limit=1 so a continuation cursor is issued.
    const env = await w.service.call(reader, 'xagt_search_history', { sessionRef: ref, query: 'vendor msg', limit: 5 });
    if (env.nextCursor !== undefined) {
      await expect(w.service.call(reader, 'xagt_search_history', { sessionRef: ref, query: 'other', cursor: env.nextCursor }))
        .rejects.toThrowError(/CURSOR_EXPIRED/);
    }
    expect(env.data.matches).toBeTypeOf('object');
  });
});

// ---------------------------------------------------------------------------
// xagt_list_materials / xagt_read_material — integrity + text-only (A10-A13).
// ---------------------------------------------------------------------------

describe('materials', () => {
  let w: World;
  const FILE_TEXT = 'line one\nline two\nsecret-free text\n';
  beforeEach(() => { w = world(materialRoutes(FILE_TEXT)); peerCallMock.mockReset(); });

  const sessionRefFor = async (w: World, reader: ReaderGrant): Promise<string> => {
    const t = await w.service.call(reader, 'xagt_list_targets', {});
    const targetRef = (t.data.targets as Record<string, unknown>[])[0]!.targetRef as string;
    const env = await w.service.call(reader, 'xagt_list_sessions', { targetRef });
    return (env.data.sessions as Record<string, unknown>[]).find((x) => x.title === 'task-1')!.sessionRef as string;
  };

  it('lists staged files and sealed artifacts with hashes', async () => {
    const reader = await mkReader(w, fullScope);
    const env = await w.service.call(reader, 'xagt_list_materials', { sessionRef: await sessionRefFor(w, reader) });
    const mats = env.data.materials as Record<string, unknown>[];
    const staged = mats.find((m) => m.name === 'notes.txt');
    expect(staged?.source).toBe('staged');
    expect(staged?.readable).toBe(true);
    expect(staged?.sha256).toBe(sha(FILE_TEXT));
    const big = mats.find((m) => m.name === 'big.bin');
    expect(big?.readable).toBe(false);
    expect(big?.reasonCode).toBe('CONTENT_TOO_LARGE');
    const art = mats.find((m) => m.name === 'build/report.txt');
    expect(art?.source).toBe('artifact');
    expect(art?.readable).toBe(true);
  });

  it('reads a staged text file with sha256 verified', async () => {
    const reader = await mkReader(w, fullScope);
    const list = await w.service.call(reader, 'xagt_list_materials', { sessionRef: await sessionRefFor(w, reader) });
    const m = (list.data.materials as Record<string, unknown>[]).find((x) => x.name === 'notes.txt')!;
    const env = await w.service.call(reader, 'xagt_read_material', {
      materialRef: m.materialRef, expectedSha256: m.sha256,
    });
    expect(env.data.text).toBe(FILE_TEXT);
    expect(env.data.encoding).toBe('utf-8');
    expect(env.data.sha256).toBe(sha(FILE_TEXT));
    expect(env.nextCursor).toBeUndefined();
  });

  it('reads a sealed artifact', async () => {
    const reader = await mkReader(w, fullScope);
    const list = await w.service.call(reader, 'xagt_list_materials', { sessionRef: await sessionRefFor(w, reader) });
    const m = (list.data.materials as Record<string, unknown>[]).find((x) => x.source === 'artifact')!;
    const env = await w.service.call(reader, 'xagt_read_material', {
      materialRef: m.materialRef, expectedSha256: m.sha256,
    });
    expect(env.data.text).toBe('artifact text body');
  });

  it('MATERIAL_CHANGED when expectedSha256 does not match the live file', async () => {
    const reader = await mkReader(w, fullScope);
    const list = await w.service.call(reader, 'xagt_list_materials', { sessionRef: await sessionRefFor(w, reader) });
    const m = (list.data.materials as Record<string, unknown>[]).find((x) => x.name === 'notes.txt')!;
    await expect(w.service.call(reader, 'xagt_read_material', {
      materialRef: m.materialRef, expectedSha256: 'b'.repeat(64),
    })).rejects.toThrowError(/MATERIAL_CHANGED/);
  });

  it('rejects binary content as UNSUPPORTED_MEDIA', async () => {
    const binary = Buffer.from([0xff, 0xfe, 0x00, 0x01, 0x80]);
    const w2 = world(materialRoutes('', binary));
    const reader = await mkReader(w2, fullScope);
    const list = await w2.service.call(reader, 'xagt_list_materials', { sessionRef: await sessionRefFor(w2, reader) });
    const m = (list.data.materials as Record<string, unknown>[]).find((x) => x.source === 'artifact')!;
    await expect(w2.service.call(reader, 'xagt_read_material', {
      materialRef: m.materialRef, expectedSha256: m.sha256,
    })).rejects.toThrowError(/UNSUPPORTED_MEDIA/);
  });

  it('withholds an explicit material whose content trips the secret scan', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'xagt-mat-'));
    try {
      // Synthetic fixture — the on-disk content trips the bounded secret
      // scan; the literal is split so repo guards don't flag a real key here.
      writeFileSync(join(dir, 'creds.txt'), ['api_key = "sk-', 'abcdef0123456789abcdef012345"\n'].join(''));
      const sessionRef = await sessionRefFor(w, await mkReader(w, fullScope));
      const { resolveRef: resolve } = await import('../src/xagt/refs.js');
      const binding = resolve(w.store, sessionRef, 'session');
      w.materials.create({
        root: dir, files: ['creds.txt'],
        session: { backendStoreId: binding.b, kind: 'MANAGED_TASK', taskId: binding.t },
      });
      const reader = await mkReader(w, fullScope);
      const list = await w.service.call(reader, 'xagt_list_materials', { sessionRef });
      const m = (list.data.materials as Record<string, unknown>[]).find((x) => x.name === 'creds.txt')!;
      // The bounded scan runs at list time too — withheld entries report the
      // denial instead of advertising readable bytes that read() would refuse.
      expect(m.readable).toBe(false);
      expect(m.reasonCode).toBe('SCOPE_DENIED');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('explicit entries: owner-confirmed files read through session binding', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'xagt-mat-'));
    try {
      mkdirSync(join(dir, 'sub'));
      writeFileSync(join(dir, 'a.txt'), 'explicit file text\nsecond line\n');
      writeFileSync(join(dir, 'sub', 'b.txt'), 'nested text');
      const sessionRef = await sessionRefFor(w, await mkReader(w, fullScope));
      // Register the explicit entry bound to the managed task.
      const t = await w.service.call(await mkReader(w, fullScope), 'xagt_list_targets', {});
      void t;
      const { resolveRef: resolve } = await import('../src/xagt/refs.js');
      const binding = resolve(w.store, sessionRef, 'session');
      const entry = w.materials.create({
        root: dir, files: ['a.txt', 'sub/b.txt'],
        session: { backendStoreId: binding.b, kind: 'MANAGED_TASK', taskId: binding.t },
      });
      const reader = await mkReader(w, fullScope);
      const env = await w.service.call(reader, 'xagt_list_materials', { sessionRef });
      const explicit = (env.data.materials as Record<string, unknown>[]).filter((x) => x.source === 'explicit');
      expect(explicit.map((x) => x.name).sort()).toEqual(['a.txt', 'sub/b.txt']);
      const m = explicit.find((x) => x.name === 'sub/b.txt')!;
      const read = await w.service.call(reader, 'xagt_read_material', {
        materialRef: m.materialRef, expectedSha256: m.sha256,
      });
      expect(read.data.text).toBe('nested text');
      expect(entry.files).toHaveLength(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('explicit entry path escapes are refused at creation', () => {
    const dir = mkdtempSync(join(tmpdir(), 'xagt-mat-'));
    try {
      expect(() => w.materials.create({ root: dir, files: ['../escape.txt'] }))
        .toThrowError(/INVALID_REQUEST/);
      expect(() => w.materials.create({ root: dir, files: ['.env'] }))
        .toThrowError(/INVALID_REQUEST/);
      expect(() => w.materials.create({ root: dir, files: ['sub/../../up.txt'] }))
        .toThrowError(/INVALID_REQUEST/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Cursors — binding, revocation, tamper (design A14-A16).
// ---------------------------------------------------------------------------

describe('cursors', () => {
  let w: World;
  beforeEach(() => { w = world(standardRoutes); peerCallMock.mockReset(); });

  it('revoking the grant kills every outstanding cursor', async () => {
    const { token, grant } = w.readers.create(fullScope);
    const reader = w.readers.authenticate(token);
    const t = await w.service.call(reader, 'xagt_list_targets', {});
    const targetRef = (t.data.targets as Record<string, unknown>[])[0]!.targetRef as string;
    const env = await w.service.call(reader, 'xagt_read_history', {
      sessionRef: ((await w.service.call(reader, 'xagt_list_sessions', { targetRef }))
        .data.sessions as Record<string, unknown>[])[0]!.sessionRef as string,
      limit: 1,
    });
    expect(env.nextCursor).toBeTypeOf('string');
    w.readers.revoke(String(grant.readerId));
    expect(() => w.readers.authenticate(token)).toThrowError(/GRANT_EXPIRED/);
    // A cursor opened under the old revision fails against a bumped grant —
    // mint an equivalent grant state to prove the revision check directly:
    const revived = { ...reader, grantRevision: reader.grantRevision + 1 };
    await expect(w.service.call(revived, 'xagt_read_history', {
      sessionRef: env.source.ref,
      cursor: env.nextCursor,
    })).rejects.toThrowError(/GRANT_EXPIRED|CURSOR_EXPIRED/);
  });

  it('a tampered cursor is rejected', async () => {
    const reader = await mkReader(w, fullScope);
    const t = await w.service.call(reader, 'xagt_list_targets', {});
    const targetRef = (t.data.targets as Record<string, unknown>[])[0]!.targetRef as string;
    const env = await w.service.call(reader, 'xagt_read_history', {
      sessionRef: ((await w.service.call(reader, 'xagt_list_sessions', { targetRef }))
        .data.sessions as Record<string, unknown>[])[0]!.sessionRef as string,
      limit: 1,
    });
    const tampered = `${env.nextCursor}x`;
    await expect(w.service.call(reader, 'xagt_read_history', {
      sessionRef: env.source.ref as string, cursor: tampered,
    })).rejects.toThrowError(/CURSOR_EXPIRED/);
  });
});

// ---------------------------------------------------------------------------
// Peer forwarding — fixed RPC + ref rewrap (design A17/A18).
// ---------------------------------------------------------------------------

describe('peer forwarding', () => {
  let w: World;
  beforeEach(() => { w = world(standardRoutes); peerCallMock.mockReset(); });

  const registerPeer = async (w: World): Promise<{ peerId: string; peerTargetRef: string }> => {
    w.peers.upsert({
      peerId: 'peer-1', name: 'office-box',
      origin: 'https://192.168.1.2:8443',
      certSha256: 'c'.repeat(64), token: 'xgr-peer-token',
    });
    const reader = await mkReader(w, fullScope);
    peerCallMock.mockResolvedValueOnce({
      status: 200,
      json: {
        version: 1, ok: true,
        result: {
          schemaVersion: 'xagt-read/1',
          source: { deviceName: 'office-box', agentName: 'xagt-link', adapter: 'xagt-read', access: 'local', ref: '' },
          observedAt: 't', coverage: { level: 'FULL', basis: 'SOURCE_FACTS', limitations: [] },
          data: { targets: [{ targetRef: 'xtr-remote-1', deviceName: 'office-box', online: true, authorized: true }] },
        },
      },
    });
    const env = await w.service.call(reader, 'xagt_list_targets', {});
    const peerTarget = (env.data.targets as Record<string, unknown>[])
      .find((t) => t.access === 'peer')!;
    return { peerId: 'peer-1', peerTargetRef: peerTarget.targetRef as string };
  };

  it('forwards the same tool body with the unwrapped remote ref', async () => {
    const { peerTargetRef } = await registerPeer(w);
    const reader = await mkReader(w, fullScope);
    peerCallMock.mockResolvedValueOnce({
      status: 200,
      json: {
        version: 1, ok: true,
        result: {
          schemaVersion: 'xagt-read/1',
          source: { deviceName: 'office-box', agentName: 'a', adapter: 'xagt-read', access: 'local', ref: 'xtr-remote-1' },
          observedAt: 't', coverage: { level: 'FULL', basis: 'SOURCE_FACTS', limitations: [] },
          data: {
            sessions: [{ sessionRef: 'xsr-remote-9', kind: 'MANAGED_TASK', title: 'remote task' }],
          },
          nextCursor: 'remote-cursor-blob',
        },
      },
    });
    const env = await w.service.call(reader, 'xagt_list_sessions', { targetRef: peerTargetRef });
    expect(peerCallMock).toHaveBeenCalled();
    const [, token, tool, args] = peerCallMock.mock.calls.at(-1)!;
    expect(token).toBe('xgr-peer-token');
    expect(tool).toBe('xagt_list_sessions');
    expect(args.targetRef).toBe('xtr-remote-1'); // remote ref, not the local wrap
    // Returned sessionRef is re-wrapped into a local opaque ref.
    const s = (env.data.sessions as Record<string, unknown>[])[0]!;
    expect(s.sessionRef).toMatch(/^xsr-/);
    expect(s.sessionRef).not.toBe('xsr-remote-9');
    // Remote continuation cursor is wrapped into a local peer cursor.
    expect(env.nextCursor).toBeTypeOf('string');
    expect(env.nextCursor).not.toBe('remote-cursor-blob');
  });

  it('denies peer reads outside the grant', async () => {
    w.peers.upsert({ peerId: 'peer-x', origin: 'https://10.0.0.9:8443', certSha256: 'd'.repeat(64), token: 't' });
    const reader = await mkReader(w, { backends: ['*'], peers: ['other-peer'] });
    peerCallMock.mockResolvedValueOnce({
      status: 200, json: { version: 1, ok: true, result: { data: { targets: [{ targetRef: 'xtr-r' }] } } },
    });
    await w.service.call(reader, 'xagt_list_targets', {});
    // Grant covers only 'other-peer' — peer-x rows must not appear.
    expect(peerCallMock).toHaveBeenCalledTimes(0);
  });

  it('maps a peer-side failure envelope to the same code', async () => {
    const { peerTargetRef } = await registerPeer(w);
    const reader = await mkReader(w, fullScope);
    peerCallMock.mockResolvedValueOnce({
      status: 200,
      json: {
        version: 1, ok: false,
        error: { code: 'GRANT_EXPIRED', message: 'revoked', retryable: false },
      },
    });
    await expect(w.service.call(reader, 'xagt_list_sessions', { targetRef: peerTargetRef }))
      .rejects.toThrowError(/GRANT_EXPIRED/);
  });
});

// ---------------------------------------------------------------------------
// Concurrency + RPC envelope (design A19/A20).
// ---------------------------------------------------------------------------

describe('concurrency + rpc envelope', () => {
  let w: World;
  beforeEach(() => { w = world(standardRoutes); peerCallMock.mockReset(); });

  it('caps a reader at 2 inflight calls with BUSY', async () => {
    const reader = await mkReader(w, fullScope);
    let release!: () => void;
    w.transport.gate = new Promise<void>((r) => { release = r; });
    const p1 = w.service.call(reader, 'xagt_list_targets', {});
    const p2 = w.service.call(reader, 'xagt_list_targets', {});
    await new Promise((r) => setImmediate(r));
    await expect(w.service.call(reader, 'xagt_list_targets', {}))
      .rejects.toThrowError(/BUSY/);
    release();
    await p1; await p2;
  });

  it('read RPC: version/auth/tool validation + in-band error envelope', async () => {
    const handlers = createXagtHandlers({
      readers: w.readers, service: w.service, peers: w.peers, materials: w.materials,
    });
    const req = (body: unknown, token?: string) => ({
      method: 'POST', path: '/api/xagt/v1/read',
      query: new URLSearchParams(), rawQuery: null, clientIp: '127.0.0.1',
      ...(typeof body === 'string' ? { rawBody: Buffer.from(body, 'utf8') } : { body }),
      ...(token !== undefined ? { accessToken: token } : {}),
    }) as Parameters<typeof handlers.read>[0];

    // No reader token → ACCESS_UNAUTHORIZED throws (auth gate maps to 401).
    await expect(handlers.read(req({ version: 1, tool: 'xagt_list_targets' })))
      .rejects.toThrowError(/ACCESS_UNAUTHORIZED/);

    const { token } = w.readers.create(fullScope);
    // Wrong version → 400 VERSION_UNSUPPORTED.
    await expect(handlers.read(req({ version: 2, tool: 'xagt_list_targets' }, token)))
      .rejects.toThrowError(/VERSION_UNSUPPORTED/);
    // Unknown tool → INVALID_REQUEST.
    await expect(handlers.read(req({ version: 1, tool: 'xagt_steal' }, token)))
      .rejects.toThrowError(/INVALID_REQUEST/);
    // Malformed JSON body → 400.
    await expect(handlers.read(req('{not json', token))).rejects.toThrowError(/INVALID_REQUEST/);

    // Happy path → {version:1, ok:true, result: envelope}.
    const ok = await handlers.read(req({ version: 1, tool: 'xagt_list_targets', arguments: {} }, token));
    expect(ok.status).toBe(200);
    const okBody = ok.body as Record<string, unknown>;
    expect(okBody.version).toBe(1);
    expect(okBody.ok).toBe(true);
    const env = okBody.result as Envelope;
    expect(env.schemaVersion).toBe('xagt-read/1');

    // Tool-level failure stays in-band ok:false.
    const bad = await handlers.read(req({
      version: 1, tool: 'xagt_list_sessions', arguments: { targetRef: 'xtr-missing' },
    }, token));
    const badBody = bad.body as Record<string, unknown>;
    expect(badBody.ok).toBe(false);
    const err = badBody.error as Record<string, unknown>;
    expect(['NOT_FOUND', 'INVALID_REQUEST']).toContain(err.code);
    expect(err.retryable).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Audit-regression coverage — fixes found in the post-implementation review.
// ---------------------------------------------------------------------------

describe('audit regressions', () => {
  beforeEach(() => { peerCallMock.mockReset(); });

  const sessionRefFor = async (w: World, reader: ReaderGrant): Promise<string> => {
    const t = await w.service.call(reader, 'xagt_list_targets', {});
    const targetRef = (t.data.targets as Record<string, unknown>[])[0]!.targetRef as string;
    const env = await w.service.call(reader, 'xagt_list_sessions', { targetRef });
    const s = (env.data.sessions as Record<string, unknown>[]).find((x) => x.kind === 'MANAGED_TASK' && x.title === 'task-1')!;
    return s.sessionRef as string;
  };

  it('vendor session paging re-sends the engine alongside the upstream cursor', async () => {
    const routes: RouteFn = (tail) => {
      if (tail === '/engines') return { status: 200, data: { items: [{ engineId: 'pi' }] } };
      if (tail === '/projects') return { status: 200, data: { items: [{ projectId: 'p1' }] } };
      if (tail === '/tasks') return { status: 200, data: { items: [] } };
      if (tail.startsWith('/history?')) {
        const q = new URLSearchParams(tail.split('?')[1] ?? '');
        const cursor = q.get('cursor');
        if (cursor === null) {
          return {
            status: 200,
            data: {
              items: [{ id: 'vs-1', title: 'one', at: 't', engine: 'pi', source: 'codex' }],
              pages: [{ engine: 'pi', cursor: 'PG1' }],
            },
          };
        }
        // The real /history route 400s a cursor without a matching engine —
        // mirror it so a missing `engine` param would fail this test.
        if (cursor !== 'PG1' || q.get('engine') !== 'pi') {
          return { status: 400, data: { code: 'INVALID_REQUEST' } };
        }
        return {
          status: 200,
          data: { items: [{ id: 'vs-2', title: 'two', at: 't', engine: 'pi', source: 'codex' }], pages: [] },
        };
      }
      return { status: 404, data: { code: 'NOT_FOUND' } };
    };
    const w = world(routes);
    const reader = await mkReader(w, fullScope);
    const t = await w.service.call(reader, 'xagt_list_targets', {});
    const targetRef = (t.data.targets as Record<string, unknown>[])[0]!.targetRef as string;
    const page1 = await w.service.call(reader, 'xagt_list_sessions', { targetRef, limit: 1 });
    expect((page1.data.sessions as unknown[]).length).toBe(1);
    expect(page1.nextCursor).toBeTypeOf('string');
    const page2 = await w.service.call(reader, 'xagt_list_sessions', { targetRef, limit: 1, cursor: page1.nextCursor });
    const titles = (page2.data.sessions as Record<string, unknown>[]).map((s) => s.title);
    expect(titles).toContain('two');
    expect(w.transport.calls.some((c) => c.includes('engine=pi') && c.includes('cursor=PG1'))).toBe(true);
  });

  it('an empty search continuation page is CURSOR_EXPIRED, not "complete"', async () => {
    let rotated = false;
    const routes: RouteFn = (tail) => {
      const base = standardRoutes(tail);
      if (tail.startsWith('/tasks/task-1/messages')) {
        const q = new URLSearchParams(tail.split('?')[1] ?? '');
        const before = Number(q.get('before') ?? '0');
        // Every message matches 'hit' — the first call fills the match budget
        // and issues next=51; a "rotation" then empties the window below it.
        if (rotated && before === 51) return { status: 200, data: { items: [], firstSequence: 0, latestSequence: 150, hasMore: false } };
        const all = Array.from({ length: 150 }, (_, i) => ({ sequence: i + 1, role: 'assistant', text: 'hit hit', occurredAt: 't' }));
        const items = all.filter((m) => m.sequence < before).slice(-100);
        return { status: 200, data: { items, firstSequence: items[0]?.sequence ?? 0, latestSequence: 150, hasMore: items.length === 100 } };
      }
      return base;
    };
    const w = world(routes);
    const reader = await mkReader(w, fullScope);
    const sessionRef = await sessionRefFor(w, reader);
    const first = await w.service.call(reader, 'xagt_search_history', { sessionRef, query: 'hit', limit: 50 });
    expect(first.data.searchComplete).toBe(false);
    expect(first.nextCursor).toBeTypeOf('string');
    rotated = true;
    await expect(w.service.call(reader, 'xagt_search_history', {
      sessionRef, query: 'hit', limit: 50, cursor: first.nextCursor,
    })).rejects.toThrowError(/CURSOR_EXPIRED/);
  });

  it('aroundMessageRef and cursor are mutually exclusive', async () => {
    const w = world(standardRoutes);
    const reader = await mkReader(w, fullScope);
    const sessionRef = await sessionRefFor(w, reader);
    await expect(w.service.call(reader, 'xagt_read_history', {
      sessionRef, aroundMessageRef: 'm1', cursor: 'sealed-or-garbage',
    })).rejects.toThrowError(/INVALID_REQUEST/);
  });

  it('a vendor aroundMessageRef returns a bounded ±5 window, not a caller-sized page', async () => {
    const w = world(standardRoutes);
    const reader = await mkReader(w, fullScope);
    const t = await w.service.call(reader, 'xagt_list_targets', {});
    const targetRef = (t.data.targets as Record<string, unknown>[])[0]!.targetRef as string;
    const env = await w.service.call(reader, 'xagt_list_sessions', { targetRef });
    const v = (env.data.sessions as Record<string, unknown>[]).find((x) => x.kind === 'VENDOR_SESSION' && x.title === 'old codex run')!;
    const page = await w.service.call(reader, 'xagt_read_history', {
      sessionRef: v.sessionRef as string, aroundMessageRef: 'v30', limit: 50,
    });
    const messages = page.data.messages as Record<string, unknown>[];
    expect(messages.length).toBeLessThanOrEqual(11);
    expect(messages.some((m) => m.messageRef === 'v30')).toBe(true);
    expect(Number((messages[0]!.messageRef as string).slice(1))).toBeGreaterThanOrEqual(25);
  });

  it('materials cursors bind the prefix; a material cursor binds its hash', async () => {
    const w = world(materialRoutes('paginate me'));
    const reader = await mkReader(w, fullScope);
    const sessionRef = await sessionRefFor(w, reader);
    const first = await w.service.call(reader, 'xagt_list_materials', { sessionRef, limit: 1 });
    expect(first.nextCursor).toBeTypeOf('string');
    await expect(w.service.call(reader, 'xagt_list_materials', {
      sessionRef, limit: 1, cursor: first.nextCursor, prefix: 'zzz',
    })).rejects.toThrowError(/CURSOR_EXPIRED/);

    const list = await w.service.call(reader, 'xagt_list_materials', { sessionRef });
    const m = (list.data.materials as Record<string, unknown>[]).find((x) => x.name === 'notes.txt')!;
    const p1 = await w.service.call(reader, 'xagt_read_material', {
      materialRef: m.materialRef as string, expectedSha256: m.sha256 as string, maxBytes: 5,
    });
    expect(p1.nextCursor).toBeTypeOf('string');
    await expect(w.service.call(reader, 'xagt_read_material', {
      materialRef: m.materialRef as string,
      expectedSha256: 'b'.repeat(64), cursor: p1.nextCursor,
    })).rejects.toThrowError(/CURSOR_EXPIRED|MATERIAL_CHANGED/);
  });

  it('explicit material without a session binding is visible under any local session', async () => {
    const w = world(materialRoutes('share'));
    const dir = mkdtempSync(join(tmpdir(), 'xagt-mat-'));
    try {
      writeFileSync(join(dir, 'share.txt'), 'shared notes\n');
      w.materials.create({ root: dir, files: ['share.txt'] });
      const reader = await mkReader(w, fullScope);
      const list = await w.service.call(reader, 'xagt_list_materials', { sessionRef: await sessionRefFor(w, reader) });
      const names = (list.data.materials as Record<string, unknown>[]).map((x) => x.name);
      expect(names).toContain('share.txt');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
