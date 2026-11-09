/**
 * PersonalInbox conformance (Java PersonalInboxService): scan/backoff/verified-
 * kind reconciliation, per-kind caps, rescope + stale-grant removal, ordered
 * paging with the grantRevision.listRevision.sequence cursor, per-source
 * freshness views, live detail rechecks, inflight dedup and scan budgets.
 */
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { GatewayError, resourceKey } from '../src/protocol';
import type {
  Device, InboxItem, Resource, Signal, SourceCursor, SourceRead,
} from '../src/protocol';
import type { GatewayStoreView, OrderedRow } from '../src/context';
import {
  PersonalInbox,
  ITEM_KIND,
  type InboxAuthLike,
  type InboxSourceReader,
} from '../src/inbox';

const SOURCE_KIND = 'INBOX_SOURCE_CURSOR';

const R1: Resource = { kind: 'WORKER_LOCAL', backendStoreId: 'conn1', taskId: 'native-t1' };
const R2: Resource = { kind: 'WORKER_LOCAL', backendStoreId: 'conn2', taskId: 'native-t2' };
const K1 = resourceKey(R1);
const K2 = resourceKey(R2);

function makeDevice(resources: Resource[] = [R1, R2], revision = 5, id = 'dev2'): Device {
  return {
    id, state: 'ACTIVE', scopeVersion: 1, revision,
    accessExpiry: Date.now() + 3_600_000,
    absoluteExpiry: Date.now() + 3_600_000,
    idleExpiry: Date.now() + 3_600_000,
    recoverUntil: 0, spentRefresh: [],
    actions: ['OBSERVE'],
    resources,
  };
}

/** Ordered-record GatewayStoreView fake — per-kind sequences, DESC listings. */
class FakeStore implements GatewayStoreView {
  private records = new Map<string, unknown>();
  private order = new Map<string, number>();
  private next = new Map<string, number>();

  private k(kind: string, id: string): string { return `${kind}|${id}`; }

  get<T>(kind: string, id: string): T | undefined {
    return this.records.get(this.k(kind, id)) as T | undefined;
  }
  put(kind: string, id: string, value: unknown): void {
    this.records.set(this.k(kind, id), value);
  }
  delete(kind: string, id: string): void {
    this.records.delete(this.k(kind, id));
  }
  list<T>(kind: string): T[] {
    return [...this.records.entries()]
      .filter(([k]) => k.startsWith(`${kind}|`))
      .map(([, v]) => v as T);
  }
  sequence(kind: string, id: string): number {
    return this.order.get(this.k(kind, id)) ?? 0;
  }
  putOrdered(kind: string, id: string, value: unknown): void {
    this.put(kind, id, value);
    const key = this.k(kind, id);
    if (this.order.has(key)) return;
    const seq = (this.next.get(kind) ?? 0) + 1;
    this.next.set(kind, seq);
    this.order.set(key, seq);
  }
  deleteOrdered(kind: string, id: string): void {
    this.delete(kind, id);
    this.order.delete(this.k(kind, id));
  }
  private rows<T>(kind: string, before: number, limit: number, match: (v: T) => boolean): OrderedRow<T>[] {
    const out: OrderedRow<T>[] = [];
    for (const [key, sequence] of this.order) {
      if (!key.startsWith(`${kind}|`)) continue;
      if (before > 0 && sequence >= before) continue;
      const value = this.records.get(key) as T;
      if (value === undefined || !match(value)) continue;
      out.push({ sequence, value });
    }
    out.sort((a, b) => b.sequence - a.sequence);
    return out.slice(0, limit);
  }
  listOrdered<T>(kind: string, beforeSequence: number, limit: number): OrderedRow<T>[] {
    return this.rows<T>(kind, beforeSequence, limit, () => true);
  }
  listOrderedForDevice<T>(kind: string, deviceId: string, limit: number): OrderedRow<T>[] {
    if (deviceId == null) return [];
    return this.rows<T>(kind, 0, limit, (v) => (v as { deviceId?: string }).deviceId === deviceId);
  }
  listOrderedForDeviceSources<T>(
    kind: string, deviceId: string, grantRevision: number,
    beforeSequence: number, limit: number, sourceKeys: string[],
  ): OrderedRow<T>[] {
    if (deviceId == null || sourceKeys == null || sourceKeys.length === 0) return [];
    return this.rows<T>(kind, beforeSequence, limit, (v) => {
      const row = v as { deviceId?: string; grantRevision?: number; sourceKey?: string };
      return row.deviceId === deviceId && row.grantRevision === grantRevision
        && sourceKeys.includes(row.sourceKey ?? '');
    });
  }
  listOrderedForSources<T>(kind: string, sourceKeys: string[], beforeSequence: number, limit: number): OrderedRow<T>[] {
    if (sourceKeys == null || sourceKeys.length === 0) return [];
    return this.rows<T>(kind, beforeSequence, limit,
      (v) => sourceKeys.includes((v as { sourceKey?: string }).sourceKey ?? ''));
  }
  transaction<T>(fn: () => T): T {
    return fn();
  }

  // ---- test conveniences --------------------------------------------------
  items(deviceId: string, grant?: number): InboxItem[] {
    return this.list<InboxItem>(ITEM_KIND).filter(
      (i) => i.deviceId === deviceId && (grant === undefined || i.grantRevision === grant));
  }
  cursor(deviceId: string, grant: number, sourceKey: string): SourceCursor | undefined {
    return this.get<SourceCursor>(SOURCE_KIND, `${deviceId}|${grant}|${sourceKey}`);
  }
}

class FakeAuth implements InboxAuthLike {
  constructor(readonly devices: Map<string, Device>) {}
  activeDevice(deviceId: string): Device {
    const d = this.devices.get(deviceId);
    if (d == null) throw new GatewayError('DEVICE_NOT_FOUND', 404);
    if (d.state !== 'ACTIVE') throw new GatewayError('DEVICE_REVOKED', 401);
    return d;
  }
  activeDevices(): Device[] {
    return [...this.devices.values()].filter((d) => d.state === 'ACTIVE');
  }
}

class FakeReader {
  reads = new Map<string, () => SourceRead | Promise<SourceRead>>();
  calls: string[] = [];
  readonly read: InboxSourceReader = async (_device, resource) => {
    const key = resourceKey(resource);
    this.calls.push(key);
    const fn = this.reads.get(key);
    if (!fn) throw new GatewayError('SOURCE_UNAVAILABLE', 503);
    return fn();
  };
}

function signal(kind: string, eventKey: string, revision = 'v1', title?: string): Signal {
  return { kind, eventKey, sourceRevision: revision, coverage: 'CURRENT_STATE', title };
}

function read(
  signals: Signal[],
  verified: string[] = ['NEEDS_INPUT', 'RESULT_READY', 'ATTENTION_REQUIRED'],
): SourceRead {
  return { signals, verifiedKinds: new Set(verified), coverage: 'CURRENT_STATE', truncated: false };
}

const STORE_ID = 'store-1';
const itemId = (kind: string, eventKey: string, sourceKey = K1, deviceId = 'dev2'): string =>
  createHash('sha256').update(`${STORE_ID}|${deviceId}|${sourceKey}|${kind}|${eventKey}`).digest('hex');

function harness(resources: Resource[] = [R1, R2], revision = 5, extras: {
  refresher?: (task: () => void) => void;
} = {}) {
  const store = new FakeStore();
  const device = makeDevice(resources, revision);
  const devices = new Map([[device.id, device]]);
  const auth = new FakeAuth(devices);
  const reader = new FakeReader();
  const inbox = new PersonalInbox(store, auth, reader.read, { ...extras, storeId: STORE_ID });
  return { store, device, devices, auth, reader, inbox };
}

async function codeOf(promise: Promise<unknown> | unknown): Promise<{ code: string; status: number }> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(GatewayError);
    const e = error as GatewayError;
    return { code: e.code, status: e.httpStatus };
  }
  throw new Error('expected GatewayError');
}

describe('PersonalInbox scanOnce', () => {
  it('writes items from verified kinds, marks the cursor and bumps the list revision', async () => {
    const { store, device, reader, inbox } = harness();
    reader.reads.set(K1, () => read([
      signal('NEEDS_INPUT', 'input:q1', 'v1', 'Approve?'),
      signal('RESULT_READY', 'output:native-t1', 'v9'),
    ]));
    reader.reads.set(K2, () => read([]));
    await inbox.scanDevice(device);
    const items = store.items('dev2');
    expect(items).toHaveLength(2);
    expect(items.map((i) => i.itemId).sort()).toEqual(
      [itemId('NEEDS_INPUT', 'input:q1'), itemId('RESULT_READY', 'output:native-t1')].sort());
    const cursor = store.cursor('dev2', 5, K1)!;
    expect(cursor.available).toBe(true);
    expect(cursor.failureCount).toBe(0);
    expect(cursor.unverifiedKinds).toEqual([]);
    const page = inbox.list(device, undefined, 30);
    expect(page.schemaVersion).toBe('personal-inbox/1');
    expect(page.grantRevision).toBe('5');
    expect(page.listRevision).toBe('1');
    expect(page.coverage).toBe('CURRENT_STATE');
    expect(page.items).toHaveLength(2);
    const item = items.find((i) => i.eventKey === 'input:q1')!;
    expect(item.expiresAt - item.observedAt).toBe(30 * 24 * 60 * 60 * 1000);
    expect(item.resource).toEqual(R1);
    expect(item.title).toBe('Approve?');
  });

  it('keeps unverified kinds as KIND_UNVERIFIED locators', async () => {
    const { store, device, reader, inbox } = harness();
    reader.reads.set(K1, () => read([signal('NEEDS_INPUT', 'input:q1')], ['NEEDS_INPUT']));
    reader.reads.set(K2, () => read([]));
    await inbox.scanDevice(device);
    // Second scan: the source could not verify NEEDS_INPUT this round.
    reader.reads.set(K1, () => read([], []));
    await inbox.scanDevice(device);
    const item = store.items('dev2').find((i) => i.eventKey === 'input:q1')!;
    expect(item.coverage).toBe('KIND_UNVERIFIED');
    expect(item.sourceAvailable).toBe(true);
    const cursor = store.cursor('dev2', 5, K1)!;
    expect(cursor.unverifiedKinds).toEqual(['ATTENTION_REQUIRED', 'NEEDS_INPUT', 'RESULT_READY']);
  });

  it('enforces per-kind caps and marks the cursor truncated', async () => {
    const { store, device, reader, inbox } = harness();
    const many: Signal[] = [];
    for (let i = 0; i < 25; i++) many.push(signal('NEEDS_INPUT', `input:q${i}`));
    many.push(signal('RESULT_READY', 'output:a'), signal('RESULT_READY', 'output:b'));
    many.push(signal('ATTENTION_REQUIRED', 'task:x'), signal('ATTENTION_REQUIRED', 'task:y'));
    reader.reads.set(K1, () => read(many));
    reader.reads.set(K2, () => read([]));
    await inbox.scanDevice(device);
    const items = store.items('dev2');
    expect(items.filter((i) => i.kind === 'NEEDS_INPUT')).toHaveLength(20);
    expect(items.filter((i) => i.kind === 'RESULT_READY')).toHaveLength(1);
    expect(items.filter((i) => i.kind === 'ATTENTION_REQUIRED')).toHaveLength(1);
    expect(store.cursor('dev2', 5, K1)!.truncated).toBe(true);
    const page = inbox.list(device, undefined, 100);
    expect(page.truncated).toBe(true);
  });

  it('marks a failed source unavailable, hides stale availability and honors backoff', async () => {
    const { store, device, reader, inbox } = harness();
    reader.reads.set(K1, () => read([signal('NEEDS_INPUT', 'input:q1')]));
    reader.reads.set(K2, () => read([]));
    await inbox.scanDevice(device);
    reader.reads.delete(K1); // source now fails
    await inbox.scanDevice(device);
    const cursor = store.cursor('dev2', 5, K1)!;
    expect(cursor.available).toBe(false);
    expect(cursor.lastError).toBe('SOURCE_UNAVAILABLE');
    expect(cursor.failureCount).toBe(1);
    expect(cursor.nextAttemptAt).toBeGreaterThan(Date.now());
    const item = store.items('dev2').find((i) => i.eventKey === 'input:q1')!;
    expect(item.sourceAvailable).toBe(false);
    const page = inbox.list(device, undefined, 30);
    const source = (page.sources as { resource: Resource; available: boolean; reasonCode: string }[])
      .find((s) => resourceKey(s.resource) === K1)!;
    expect(source.available).toBe(false);
    expect(source.reasonCode).toBe('SOURCE_UNAVAILABLE');
    // Backoff: the failed source is skipped, the healthy one still scans.
    const k1Calls = reader.calls.filter((c) => c === K1).length;
    await inbox.scanDevice(device);
    expect(reader.calls.filter((c) => c === K1).length).toBe(k1Calls);
    expect(reader.calls.filter((c) => c === K2).length).toBe(3);
  });

  it('drops items whose resource leaves the granted set on the next scan', async () => {
    const { store, device, reader, inbox } = harness();
    reader.reads.set(K1, () => read([signal('NEEDS_INPUT', 'input:q1')]));
    reader.reads.set(K2, () => read([signal('NEEDS_INPUT', 'input:q2')]));
    await inbox.scanDevice(device);
    expect(store.items('dev2')).toHaveLength(2);
    device.resources = [R1]; // rescope: R2 gone
    await inbox.scanDevice(device);
    const items = store.items('dev2');
    expect(items).toHaveLength(1);
    expect(items[0].sourceKey).toBe(K1);
    const page = inbox.list(device, undefined, 30);
    expect(page.items).toHaveLength(1);
    expect(page.sources).toHaveLength(1);
  });

  it('hides stale-grant items in list and deletes them on the next scan', async () => {
    const { store, device, reader, inbox } = harness();
    reader.reads.set(K1, () => read([signal('NEEDS_INPUT', 'input:q1')]));
    reader.reads.set(K2, () => read([]));
    await inbox.scanDevice(device);
    device.revision = 6; // grant rotated: old items hidden but retained
    const page = inbox.list(device, undefined, 30);
    expect(page.items).toHaveLength(0);
    expect(store.items('dev2')).toHaveLength(1);
    await inbox.scanDevice(device); // scan deletes stale rows + writes fresh
    const items = store.items('dev2');
    expect(items).toHaveLength(1);
    expect(items[0].grantRevision).toBe(6);
    expect(store.cursor('dev2', 6, K1)).toBeDefined();
  });

  it('re-sequences an item to the top when its source revision changes', async () => {
    const { device, reader, inbox } = harness();
    reader.reads.set(K1, () => read([
      signal('NEEDS_INPUT', 'input:a', 'v1'),
      signal('NEEDS_INPUT', 'input:b', 'v1'),
    ]));
    reader.reads.set(K2, () => read([]));
    await inbox.scanDevice(device);
    const first = inbox.list(device, undefined, 30).items as { itemId: string }[];
    expect(first[0].itemId).toBe(itemId('NEEDS_INPUT', 'input:b'));
    reader.reads.set(K1, () => read([
      signal('NEEDS_INPUT', 'input:a', 'v2'),
      signal('NEEDS_INPUT', 'input:b', 'v1'),
    ]));
    await inbox.scanDevice(device);
    const second = inbox.list(device, undefined, 30).items as { itemId: string; sourceRevision: string }[];
    expect(second[0].itemId).toBe(itemId('NEEDS_INPUT', 'input:a'));
    expect(second[0].sourceRevision).toBe('v2');
  });
});

describe('PersonalInbox list', () => {
  it('pages DESC by sequence with the three-part cursor and expires it on revision moves', async () => {
    const { device, reader, inbox } = harness();
    reader.reads.set(K1, () => read([
      signal('NEEDS_INPUT', 'input:a'), signal('NEEDS_INPUT', 'input:b'),
      signal('NEEDS_INPUT', 'input:c'),
    ]));
    reader.reads.set(K2, () => read([]));
    await inbox.scanDevice(device);
    const p1 = inbox.list(device, undefined, 2);
    expect(p1.items).toHaveLength(2);
    expect(p1.nextCursor).toBe('5.1.2'); // grant.listRev.sequence of last seen row
    const p2 = inbox.list(device, p1.nextCursor as string, 2);
    expect(p2.items).toHaveLength(1);
    expect(p2.nextCursor).toBeUndefined();
    // A bump (another change) invalidates the saved cursor.
    reader.reads.set(K1, () => read([
      signal('NEEDS_INPUT', 'input:a'), signal('NEEDS_INPUT', 'input:d'),
    ]));
    await inbox.scanDevice(device);
    expect(await codeOf(Promise.resolve().then(() => inbox.list(device, p1.nextCursor as string, 2))))
      .toEqual({ code: 'INBOX_CURSOR_EXPIRED', status: 409 });
    expect(await codeOf(Promise.resolve().then(() => inbox.list(device, 'garbage', 2))))
      .toEqual({ code: 'CURSOR_INVALID', status: 400 });
    expect(await codeOf(Promise.resolve().then(() => inbox.list(device, '1.2', 2))))
      .toEqual({ code: 'CURSOR_INVALID', status: 400 });
    expect(await codeOf(Promise.resolve().then(() => inbox.list(device, undefined, 101))))
      .toEqual({ code: 'INVALID_REQUEST', status: 400 });
  });

  it('skips expired locators in list without a scan and purges them on scan', async () => {
    const { store, device, reader, inbox } = harness();
    reader.reads.set(K1, () => read([signal('NEEDS_INPUT', 'input:q1')]));
    reader.reads.set(K2, () => read([]));
    await inbox.scanDevice(device);
    const item = store.items('dev2')[0];
    item.expiresAt = Date.now() - 1; // force expiry (30d retention)
    store.put(ITEM_KIND, item.itemId, item);
    expect(inbox.list(device, undefined, 30).items).toHaveLength(0);
    // A scan of the OTHER resource runs cleanup() which deletes the expired row.
    await inbox.scan(device, R2);
    expect(store.items('dev2')).toHaveLength(0);
  });
});

describe('PersonalInbox detail', () => {
  it('re-reads the source live and reports resolved/current-state semantics', async () => {
    const { device, reader, inbox } = harness();
    reader.reads.set(K1, () => read([signal('NEEDS_INPUT', 'input:q1')]));
    reader.reads.set(K2, () => read([]));
    await inbox.scanDevice(device);
    const id = itemId('NEEDS_INPUT', 'input:q1');
    const detail = await inbox.detail(device, id);
    expect(detail.itemId).toBe(id);
    expect(detail.grantRevision).toBe('5');
    expect(detail.sourceAvailable).toBe(true);
    expect(detail.resolved).toBe(false);
    expect(detail.currentKind).toBe('NEEDS_INPUT');
    expect(detail.currentSourceRevision).toBe('v1');
    // Signal disappears → resolved
    reader.reads.set(K1, () => read([]));
    const resolved = await inbox.detail(device, id);
    expect(resolved.resolved).toBe(true);
    // Kind no longer verified → currentStateUnknown
    reader.reads.set(K1, () => read([], ['RESULT_READY']));
    const unknown = await inbox.detail(device, id);
    expect(unknown.resolved).toBe(false);
    expect(unknown.currentStateUnknown).toBe(true);
    // Source down → sourceAvailable false + currentStateUnknown
    reader.reads.delete(K1);
    const down = await inbox.detail(device, id);
    expect(down.sourceAvailable).toBe(false);
    expect(down.currentStateUnknown).toBe(true);
    // Well-formed but unknown item id → NOT_FOUND; malformed id → INVALID_REQUEST.
    expect(await codeOf(inbox.detail(device, 'f'.repeat(64))))
      .toEqual({ code: 'NOT_FOUND', status: 404 });
    expect(await codeOf(inbox.detail(device, 'dev2:nope')))
      .toEqual({ code: 'INVALID_REQUEST', status: 400 });
  });
});

describe('PersonalInbox scheduling', () => {
  it('requestRefresh dedups per device and runs through the injected refresher', async () => {
    const tasks: (() => void)[] = [];
    const { device, reader, inbox } = harness([R1], 5, { refresher: (t) => tasks.push(t) });
    reader.reads.set(K1, () => read([signal('NEEDS_INPUT', 'input:q1')]));
    inbox.requestRefresh(device);
    inbox.requestRefresh(device); // dedup: second call dropped
    expect(tasks).toHaveLength(1);
    tasks[0]();
    await new Promise((r) => setTimeout(r, 0));
    // inflight released → another request schedules again
    inbox.requestRefresh(device);
    expect(tasks).toHaveLength(2);
    // No refresher → no-op
    const bare = harness([R1]);
    bare.inbox.requestRefresh(bare.device);
    await new Promise((r) => setTimeout(r, 0));
    expect(bare.reader.calls).toHaveLength(0);
  });

  it('scanAll rotates fairly, honors backoff and the resource budget', async () => {
    const resources = Array.from({ length: 20 }, (_, i) =>
      ({ kind: 'WORKER_LOCAL', backendStoreId: `b${i}`, taskId: `t${i}` }));
    const { device, devices, reader, inbox } = harness(resources);
    const d2 = makeDevice([R1], 5, 'dev9');
    devices.set(d2.id, d2);
    for (const r of resources) reader.reads.set(resourceKey(r), () => read([]));
    reader.reads.set(K1, () => read([]));
    await inbox.scanAll();
    expect(reader.calls).toHaveLength(16); // SCAN_RESOURCE_BUDGET
    // Second pass scans the five never-attempted candidates first (least
    // recently attempted), then fills the rest of the 16-scan budget.
    reader.calls.length = 0;
    await inbox.scanAll();
    expect(reader.calls).toHaveLength(16);
    const freshFirst = reader.calls.slice(0, 5).sort();
    expect(freshFirst).toEqual(
      [...resources.slice(16).map(resourceKey), K1].sort());
    // Time budget: an already-past deadline scans nothing.
    reader.calls.length = 0;
    await inbox.scanDevice(device, Date.now() - 1);
    expect(reader.calls).toHaveLength(0);
    void d2;
  });

  it('dedups identical in-flight resource scans', async () => {
    const { device, reader, inbox } = harness([R1]);
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    reader.reads.set(K1, async () => { await gate; return read([]); });
    const a = inbox.scan(device, R1);
    const b = inbox.scan(device, R1); // dropped while a is in flight
    release();
    await Promise.all([a, b]);
    expect(reader.calls).toHaveLength(1);
  });

  it('defaults the reader to SOURCE_NOT_READY when unset', async () => {
    const { store, device, auth } = harness([R1]);
    const inbox = new PersonalInbox(store, auth, undefined, { storeId: STORE_ID });
    await inbox.scanDevice(device);
    const page = inbox.list(device, undefined, 30);
    const source = (page.sources as { available: boolean; reasonCode: string }[])[0];
    expect(source.available).toBe(false);
    expect(source.reasonCode).toBe('SOURCE_NOT_READY');
  });
});
