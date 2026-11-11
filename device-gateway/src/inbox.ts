/**
 * src/inbox.ts — TypeScript port of Java PersonalInboxService.
 * (AgentCodeService/.../personalaccess/PersonalInboxService.java)
 *
 * Bounded, current-state inbox projection isolated per device grant. The
 * source remains authoritative; the inbox stores only small locators plus the
 * last observed source revision. Source I/O is supplied through the reader
 * seam and is never performed while the control-plane transaction is open —
 * the Java class documents the same rule and holds its store.transaction()
 * sections strictly synchronous, which this port mirrors.
 *
 * List cursor format (Java): "grantRevision.listRevision.beforeSequence".
 * Item identity: sha256(storeId + "|" + deviceId + "|" + resourceKey + "|" +
 * kind + "|" + eventKey). Source cursors are keyed per grant:
 * deviceId + "|" + grantRevision + "|" + resourceKey.
 */

import {
  fail,
  hash,
  id,
  resourceKey,
  type Device,
  type InboxItem,
  type ListRevision,
  type Resource,
  type Signal,
  type SourceCursor,
  type SourceRead,
} from './protocol';
import type { GatewayInbox, GatewayStoreView, JsonObject, MaybePromise, OrderedRow } from './context';

export const ITEM_KIND = 'INBOX_ITEM';
const SOURCE_KIND = 'INBOX_SOURCE_CURSOR';
const LIST_KIND = 'INBOX_LIST_REVISION';
const RETENTION_MS = 30 * 86400000;
const MAX_ITEMS = 5000;
const SOURCE_LIMIT = 100;
const SCAN_RESOURCE_BUDGET = 16;
const SCAN_TIME_BUDGET_MS = 5000;
const MAX_INPUT_ITEMS = 20;
const MAX_RESULT_ITEMS = 1;
const MAX_ATTENTION_ITEMS = 1;
const KINDS = new Set(['NEEDS_INPUT', 'RESULT_READY', 'ATTENTION_REQUIRED']);
const LONG_MAX = 9223372036854775807n;

/** Java PersonalAccessService slice the inbox uses (Devices satisfies it). */
export interface InboxAuthLike {
  /** Current grant record; throws when the device is revoked or expired. */
  activeDevice(deviceId: string): Device;
  /** All currently active devices (periodic scanner only). */
  activeDevices(): Device[];
}

/**
 * Java SourceReader SAM — adapter-provided source read; I/O must honor the
 * round deadline. PersonalInbox.localTaskReader() adapts GatewayLocalTasks.
 */
export type InboxSourceReader = (
  device: Device,
  resource: Resource,
  deadlineMillis: number,
) => MaybePromise<SourceRead>;

const readerNotReady: InboxSourceReader = () => fail('SOURCE_NOT_READY', 503);

/** Java Executor seam for requestRefresh — keeps refresh serialized. */
export type InboxRefresher = (task: () => void) => void;

export interface PersonalInboxOptions {
  /** Java `refresher(Executor)` — without it requestRefresh is a no-op. */
  refresher?: InboxRefresher;
  /** Gateway store id bound into item ids (Java PersonalInboxService storeId). */
  storeId?: string;
}

export class PersonalInbox implements GatewayInbox {
  private reader: InboxSourceReader;
  private refresher: InboxRefresher | undefined;
  private readonly inflight = new Set<string>();

  private readonly storeId: string;

  constructor(
    private readonly store: GatewayStoreView,
    private readonly auth: InboxAuthLike,
    reader?: InboxSourceReader | { read: InboxSourceReader },
    options: PersonalInboxOptions = {},
  ) {
    this.storeId = options.storeId ?? '';
    const value = reader === undefined
      ? undefined
      : typeof reader === 'function' ? reader : reader.read;
    this.reader = value ?? readerNotReady;
    this.refresher = options.refresher;
  }

  /** Adapt a GatewayLocalTasks signal() into the SourceReader seam. */
  static localTaskReader(localTasks: {
    signal(device: Device, resource: Resource, deadlineMillis: number): MaybePromise<SourceRead>;
  }): InboxSourceReader {
    return (device, resource, deadlineMillis) => {
      if (resource.kind !== 'WORKER_LOCAL') return fail('SOURCE_NOT_READY', 503);
      return localTasks.signal(device, resource, deadlineMillis);
    };
  }

  /** Java `reader(SourceReader)` — null restores the SOURCE_NOT_READY default. */
  setReader(value: InboxSourceReader | undefined): this {
    this.reader = value ?? readerNotReady;
    return this;
  }

  /** Java `refresher(Executor)`. */
  setRefresher(value: InboxRefresher | undefined): this {
    this.refresher = value;
    return this;
  }

  /**
   * Wake a bounded refresh for one device without blocking the caller. A
   * device list request returns the current cache plus per-source freshness
   * instead of waiting on business sources.
   */
  requestRefresh(device: Device | null | undefined): void {
    const executor = this.refresher;
    if (device == null || executor === undefined) return;
    const guard = `device:${device.id}`;
    if (this.inflight.has(guard)) return;
    this.inflight.add(guard);
    try {
      executor(() => {
        void this.scanDevice(device)
          .catch(() => undefined)
          .finally(() => this.inflight.delete(guard));
      });
    } catch {
      this.inflight.delete(guard);
    }
  }

  /** Fair rotation across devices: least recently attempted source first. */
  async scanAll(): Promise<void> {
    const started = Date.now();
    const deadline = started + SCAN_TIME_BUDGET_MS;
    let cursors: Map<string, SourceCursor>;
    try {
      cursors = this.store.transaction(() => {
        const out = new Map<string, SourceCursor>();
        for (const row of this.store.listOrdered<SourceCursor>(SOURCE_KIND, 0, MAX_ITEMS + 1)) {
          out.set(row.value.cursorKey, row.value);
        }
        return out;
      });
    } catch {
      return;
    }
    const candidates: { device: Device; resource: Resource; lastAttemptAt: number; nextAttemptAt: number }[] = [];
    for (const device of this.auth.activeDevices()) {
      for (const resource of this.resources(device)) {
        const cursor = cursors.get(PersonalInbox.cursorKey(device.id, device.revision, resourceKey(resource)));
        candidates.push({
          device, resource,
          lastAttemptAt: cursor?.lastAttemptAt ?? 0,
          nextAttemptAt: cursor?.nextAttemptAt ?? 0,
        });
      }
    }
    candidates.sort((a, b) => a.lastAttemptAt - b.lastAttemptAt);
    let scanned = 0;
    for (const candidate of candidates) {
      if (scanned >= SCAN_RESOURCE_BUDGET || Date.now() >= deadline) break;
      if (candidate.nextAttemptAt > Date.now()) continue;
      scanned++;
      await this.scan(candidate.device, candidate.resource, deadline);
    }
  }

  /**
   * Refresh one device inside the same per-resource bounds as the periodic
   * path. Used by requestRefresh; tests may call it synchronously.
   */
  async scanDevice(device: Device, deadlineMillis?: number): Promise<void> {
    const deadline = deadlineMillis ?? Date.now() + SCAN_TIME_BUDGET_MS;
    const ordered = [...this.resources(device)];
    if (ordered.length > 1) {
      const attempted = this.store.transaction(() => {
        const out = new Map<string, number>();
        for (const row of this.store.listOrderedForDevice<SourceCursor>(SOURCE_KIND, device.id, MAX_ITEMS + 1)) {
          if (row.value.grantRevision === device.revision) out.set(row.value.sourceKey, row.value.lastAttemptAt);
        }
        return out;
      });
      ordered.sort((a, b) => (attempted.get(resourceKey(a)) ?? 0) - (attempted.get(resourceKey(b)) ?? 0));
    }
    let scanned = 0;
    for (const resource of ordered) {
      if (scanned >= SCAN_RESOURCE_BUDGET || Date.now() >= deadline) break;
      if (this.backoff(device, resource)) continue;
      scanned++;
      await this.scan(device, resource, deadline);
    }
  }

  /** Scan one device+resource; identical in-flight scans are dropped. */
  async scan(device: Device, resource: Resource, deadlineMillis?: number): Promise<void> {
    const deadline = deadlineMillis ?? Date.now() + SCAN_TIME_BUDGET_MS;
    const guard = `resource:${device.id}|${resourceKey(resource)}`;
    if (this.inflight.has(guard)) return;
    this.inflight.add(guard);
    try {
      await this.scanOnce(device, resource, deadline);
    } finally {
      this.inflight.delete(guard);
    }
  }

  private async scanOnce(device: Device, resource: Resource, deadlineMillis: number): Promise<void> {
    const observed = Date.now();
    const grant = device.revision;
    // Source I/O happens BEFORE the control-plane transaction opens — the
    // Java class documents this same rule for its reader seam.
    let signals: Signal[] = [];
    let verified: Set<string> = new Set();
    let error: string | undefined;
    let available = false;
    let coverage = 'CURRENT_STATE';
    let truncated = false;
    try {
      const read = await this.reader(device, resource, deadlineMillis);
      available = true;
      if (read != null) {
        if (read.signals != null) signals = read.signals;
        if (read.verifiedKinds != null) verified = read.verifiedKinds;
        if (read.coverage != null) coverage = read.coverage;
        truncated = read.truncated;
      }
    } catch (failure) {
      error = failure instanceof Error && 'code' in failure && typeof (failure as { code?: unknown }).code === 'string'
        ? (failure as { code: string }).code
        : 'SOURCE_UNAVAILABLE';
    }
    const sourceError = error;
    const sourceCoverage = coverage;
    const sourceAvailable = available;
    const sourceTruncated = truncated;
    const current = signals;
    const verifiedKinds = verified;
    const sourceKey = resourceKey(resource);
    this.store.transaction(() => {
      // Re-check the live grant: revoked or re-scoped devices drop the just-read result.
      let fresh: Device;
      try {
        fresh = this.auth.activeDevice(device.id);
      } catch {
        return;
      }
      let listChanged = false;
      const granted = new Set<string>();
      for (const r of this.resources(fresh)) granted.add(resourceKey(r));
      // Items whose grant or resource disappeared are removed first; they are never authority.
      for (const row of this.store.listOrderedForDevice<InboxItem>(ITEM_KIND, fresh.id, MAX_ITEMS + 1)) {
        const item = row.value;
        if (item.grantRevision !== fresh.revision || !granted.has(item.sourceKey)) {
          this.store.deleteOrdered(ITEM_KIND, item.itemId);
          listChanged = true;
        }
      }
      if (fresh.revision !== grant || !granted.has(sourceKey)) {
        if (listChanged) this.bumpList(fresh.id);
        return;
      }
      const cursorKey = PersonalInbox.cursorKey(fresh.id, grant, sourceKey);
      let cursor = this.store.get<SourceCursor>(SOURCE_KIND, cursorKey);
      if (cursor === undefined) {
        cursor = {
          cursorKey, deviceId: fresh.id, grantRevision: grant, sourceKey, resource,
          lastError: undefined, coverage: 'CURRENT_STATE', lastAttemptAt: 0,
          lastSuccessfulAt: 0, nextAttemptAt: 0, failureCount: 0,
          available: false, truncated: false, unverifiedKinds: [],
        };
      }
      cursor.lastAttemptAt = observed;
      cursor.available = sourceAvailable;
      cursor.lastError = sourceError;
      cursor.coverage = sourceCoverage;
      cursor.truncated = sourceTruncated;
      const unverified = [...KINDS].filter((k) => !verifiedKinds.has(k)).sort();
      cursor.unverifiedKinds = sourceAvailable ? unverified : [...KINDS].sort();
      cursor.failureCount = sourceAvailable ? 0 : Math.min(10, cursor.failureCount + 1);
      cursor.nextAttemptAt = sourceAvailable ? 0 : observed + Math.min(300000, 5000 * 2 ** Math.min(6, cursor.failureCount));
      if (sourceAvailable) cursor.lastSuccessfulAt = observed;
      this.store.putOrdered(SOURCE_KIND, cursorKey, cursor);
      if (!sourceAvailable) {
        for (const row of this.store.listOrderedForDeviceSources<InboxItem>(
          ITEM_KIND, fresh.id, grant, 0, MAX_ITEMS + 1, [sourceKey])) {
          if (row.value.sourceAvailable) {
            row.value.sourceAvailable = false;
            this.store.put(ITEM_KIND, row.value.itemId, row.value);
          }
        }
        if (listChanged) this.bumpList(fresh.id);
        return;
      }
      const byKind = new Map<string, Signal[]>();
      let inputs = 0;
      let results = 0;
      let attention = 0;
      let overflow = false;
      for (const signal of current) {
        if (signal == null || !KINDS.has(signal.kind) || signal.eventKey == null || !verifiedKinds.has(signal.kind)) continue;
        const cap = signal.kind === 'NEEDS_INPUT' ? MAX_INPUT_ITEMS
          : signal.kind === 'RESULT_READY' ? MAX_RESULT_ITEMS : MAX_ATTENTION_ITEMS;
        const used = signal.kind === 'NEEDS_INPUT' ? ++inputs
          : signal.kind === 'RESULT_READY' ? ++results : ++attention;
        if (used > cap) { overflow = true; continue; }
        const bucket = byKind.get(signal.kind);
        if (bucket === undefined) byKind.set(signal.kind, [signal]); else bucket.push(signal);
      }
      if (overflow) {
        cursor.truncated = true;
        this.store.put(SOURCE_KIND, cursorKey, cursor);
      }
      // Only successfully read categories may replace their current set.
      for (const kind of verifiedKinds) {
        const wanted = new Map<string, Signal>();
        for (const signal of byKind.get(kind) ?? []) wanted.set(signal.eventKey, signal);
        const existing = this.store.listOrderedForDeviceSources<InboxItem>(
          ITEM_KIND, fresh.id, grant, 0, MAX_ITEMS + 1, [sourceKey]);
        for (const row of existing) {
          const item = row.value;
          if (kind !== item.kind) continue;
          const signal = wanted.get(item.eventKey);
          if (signal === undefined) {
            this.store.deleteOrdered(ITEM_KIND, item.itemId);
            listChanged = true;
            continue;
          }
          wanted.delete(item.eventKey);
          item.observedAt = observed;
          item.expiresAt = observed + RETENTION_MS;
          item.sourceAvailable = true;
          item.coverage = signal.coverage ?? sourceCoverage;
          item.subject = signal.subject;
          item.title = signal.title;
          const revision = signal.sourceRevision ?? 'unknown';
          if (revision !== item.sourceRevision) {
            item.sourceRevision = revision;
            this.store.deleteOrdered(ITEM_KIND, item.itemId);
            this.store.putOrdered(ITEM_KIND, item.itemId, item);
            listChanged = true;
          } else {
            this.store.put(ITEM_KIND, item.itemId, item);
          }
        }
        for (const signal of wanted.values()) {
          const item: InboxItem = {
            itemId: hash(`${this.storeId}|${fresh.id}|${sourceKey}|${kind}|${signal.eventKey}`),
            deviceId: fresh.id,
            grantRevision: grant,
            sourceKey,
            eventKey: signal.eventKey,
            kind,
            resource,
            subject: signal.subject,
            title: signal.title,
            sourceRevision: signal.sourceRevision ?? 'unknown',
            observedAt: observed,
            expiresAt: observed + RETENTION_MS,
            sourceAvailable: true,
            coverage: signal.coverage ?? sourceCoverage,
          };
          this.store.putOrdered(ITEM_KIND, item.itemId, item);
          listChanged = true;
        }
      }
      // Kinds the source could not verify keep their last locators, marked unconfirmed.
      for (const kind of unverified) {
        for (const row of this.store.listOrderedForDeviceSources<InboxItem>(
          ITEM_KIND, fresh.id, grant, 0, MAX_ITEMS + 1, [sourceKey])) {
          const item = row.value;
          if (kind === item.kind && item.coverage !== 'KIND_UNVERIFIED') {
            item.coverage = 'KIND_UNVERIFIED';
            this.store.put(ITEM_KIND, item.itemId, item);
          }
        }
      }
      const changedRef = { value: listChanged };
      this.cleanup(fresh, observed, changedRef);
      if (changedRef.value) this.bumpList(fresh.id);
    });
  }

  private backoff(device: Device, resource: Resource): boolean {
    return this.store.transaction(() => {
      const cursor = this.store.get<SourceCursor>(
        SOURCE_KIND, PersonalInbox.cursorKey(device.id, device.revision, resourceKey(resource)));
      return cursor !== undefined && cursor.nextAttemptAt > Date.now();
    });
  }

  private bumpList(deviceId: string): void {
    let state = this.store.get<ListRevision>(LIST_KIND, deviceId);
    if (state === undefined) state = { deviceId, revision: 0 };
    state.revision++;
    this.store.put(LIST_KIND, deviceId, state);
  }

  private listRevision(deviceId: string): number {
    return this.store.get<ListRevision>(LIST_KIND, deviceId)?.revision ?? 0;
  }

  list(device: Device, cursor: string | null | undefined, requestedLimit: number): JsonObject {
    const limit = requestedLimit <= 0 ? 30 : requestedLimit;
    if (limit > 100) throw fail('INVALID_REQUEST', 400);
    const decoded = PersonalInbox.decodeCursor(cursor);
    return this.store.transaction(() => {
      const fresh = this.auth.activeDevice(device.id);
      const visible = this.visibleKeys(fresh);
      const revision = this.listRevision(fresh.id);
      if (decoded !== null && (decoded[0] !== fresh.revision || decoded[1] !== revision)) {
        throw fail('INBOX_CURSOR_EXPIRED', 409);
      }
      const before = decoded === null ? 0 : decoded[2];
      const rows: OrderedRow<InboxItem>[] = visible.size === 0
        ? []
        : this.store.listOrderedForDeviceSources<InboxItem>(
          ITEM_KIND, fresh.id, fresh.revision, before, limit + 1, [...visible]);
      const items: unknown[] = [];
      let last = 0;
      let inspected = 0;
      for (const row of rows) {
        inspected++;
        const item = row.value;
        if (item.expiresAt > 0 && item.expiresAt < Date.now()) continue;
        items.push(this.itemView(item));
        last = row.sequence;
        if (items.length >= limit) break;
      }
      const out: JsonObject = {
        schemaVersion: 'personal-inbox/1',
        grantRevision: String(fresh.revision),
        listRevision: String(revision),
        coverage: 'CURRENT_STATE',
        items,
      };
      if (inspected < rows.length && last > 0) {
        out.nextCursor = PersonalInbox.encodeCursor(fresh.revision, revision, last);
      }
      let truncated = false;
      const sources: unknown[] = [];
      let index = 0;
      const deviceResources = this.resources(fresh);
      for (const resource of deviceResources) {
        if (++index > SOURCE_LIMIT) break;
        const source = this.store.get<SourceCursor>(
          SOURCE_KIND, PersonalInbox.cursorKey(fresh.id, fresh.revision, resourceKey(resource)));
        if (source !== undefined && source.truncated) truncated = true;
        sources.push(this.sourceView(resource, source));
      }
      out.truncated = truncated;
      out.sourcesTruncated = deviceResources.length > SOURCE_LIMIT;
      out.sources = sources;
      return out;
    });
  }

  async detail(device: Device, itemId: string): Promise<JsonObject> {
    id(itemId);
    const [fresh, item] = this.store.transaction((): [Device, InboxItem] => {
      const current = this.auth.activeDevice(device.id);
      const record = this.store.get<InboxItem>(ITEM_KIND, itemId);
      if (record === undefined || current.id !== record.deviceId || record.grantRevision !== current.revision
        || !this.visibleKeys(current).has(record.sourceKey)) {
        throw fail('NOT_FOUND', 404);
      }
      return [current, record];
    });
    const out: JsonObject = this.itemView(item) as JsonObject;
    out.grantRevision = String(fresh.revision);
    try {
      const read = await this.reader(fresh, item.resource, Date.now() + SCAN_TIME_BUDGET_MS);
      const verified = read?.verifiedKinds ?? new Set<string>();
      if (!verified.has(item.kind)) {
        out.resolved = false;
        out.sourceAvailable = true;
        out.currentStateUnknown = true;
      } else {
        let latest: Signal | undefined;
        for (const signal of read?.signals ?? []) {
          if (signal != null && item.kind === signal.kind && item.eventKey === signal.eventKey) {
            latest = signal;
            break;
          }
        }
        if (latest === undefined) {
          out.resolved = true;
          out.sourceAvailable = true;
        } else {
          out.resolved = false;
          out.currentKind = latest.kind;
          out.sourceAvailable = true;
          if (latest.sourceRevision !== undefined) out.currentSourceRevision = latest.sourceRevision;
        }
      }
    } catch {
      out.sourceAvailable = false;
      out.currentStateUnknown = true;
    }
    return out;
  }

  private itemView(item: InboxItem): JsonObject {
    const out: JsonObject = {
      itemId: item.itemId,
      kind: item.kind,
      sourceRevision: item.sourceRevision,
      observedAt: item.observedAt,
      expiresAt: item.expiresAt,
      sourceAvailable: item.sourceAvailable,
      coverage: item.coverage,
      resource: item.resource,
    };
    if (item.subject !== undefined && item.subject !== null) out.subject = item.subject;
    if (item.title !== undefined && item.title !== null) out.title = item.title;
    return out;
  }

  private sourceView(resource: Resource, cursor: SourceCursor | undefined): JsonObject {
    if (cursor === undefined) {
      return { resource, coverage: 'NOT_SCANNED', available: false, reasonCode: 'NOT_SCANNED' };
    }
    const out: JsonObject = {
      resource,
      lastAttemptAt: cursor.lastAttemptAt,
      lastSuccessfulAt: cursor.lastSuccessfulAt,
      available: cursor.available,
      coverage: cursor.coverage,
      truncated: cursor.truncated,
      reasonCode: cursor.lastError ?? '',
    };
    if (cursor.unverifiedKinds.length > 0) out.unverifiedKinds = cursor.unverifiedKinds;
    return out;
  }

  private visibleKeys(device: Device): Set<string> {
    const out = new Set<string>();
    for (const r of this.resources(device)) out.add(resourceKey(r));
    return out;
  }

  private resources(device: Device): Resource[] {
    return device.resources ?? [];
  }

  private static cursorKey(deviceId: string, grantRevision: number, sourceKey: string): string {
    return `${deviceId}|${grantRevision}|${sourceKey}`;
  }

  private cleanup(device: Device, now: number, listChanged: { value: boolean }): void {
    let rows = this.store.listOrderedForDevice<InboxItem>(ITEM_KIND, device.id, MAX_ITEMS + 1);
    for (const row of rows) {
      if (row.value.expiresAt > 0 && row.value.expiresAt < now) {
        this.store.deleteOrdered(ITEM_KIND, row.value.itemId);
        listChanged.value = true;
      }
    }
    rows = this.store.listOrderedForDevice<InboxItem>(ITEM_KIND, device.id, MAX_ITEMS + 1);
    let currentGrant = 0;
    for (const row of rows) {
      const item = row.value;
      if (item.grantRevision !== device.revision || ++currentGrant > MAX_ITEMS) {
        this.store.deleteOrdered(ITEM_KIND, item.itemId);
        listChanged.value = true;
      }
    }
  }

  private static decodeCursor(cursor: string | null | undefined): [number, number, number] | null {
    if (cursor == null || cursor === '') return null;
    if (!/^[0-9]{1,19}(\.[0-9]{1,19}){2}$/.test(cursor)) throw fail('CURSOR_INVALID', 400);
    const parts = cursor.split('.');
    try {
      // Java Long.parseLong overflow → NumberFormatException → CURSOR_INVALID.
      const out = parts.map((p) => {
        if (BigInt(p) > LONG_MAX) throw new RangeError();
        return Number(p);
      });
      return [out[0], out[1], out[2]];
    } catch {
      throw fail('CURSOR_INVALID', 400);
    }
  }

  private static encodeCursor(grantRevision: number, listRevision: number, sequence: number): string {
    return `${grantRevision}.${listRevision}.${sequence}`;
  }
}

export type { InboxItem, SourceRead };