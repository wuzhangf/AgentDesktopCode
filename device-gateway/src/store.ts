/**
 * GatewayStore — node:sqlite port of the Java PersonalAccessStore.
 *
 * Generic persistence model (Java-exact table names):
 *   personal_access_record(kind, id, payload, PK(kind,id))
 *   personal_access_record_order(kind, id, sequence, PK(kind,id), UNIQUE(kind,sequence))
 *   personal_access_sequence(kind PRIMARY KEY, next_sequence)
 *
 * Ordered records allocate a stable per-(kind,id) sequence once, on first
 * putOrdered; re-putting a payload keeps its sequence so listOrdered() cursors
 * are stable across projection replacement.
 *
 * The `personal_scope_v2_*` triggers mirror the Java service-constructor guard:
 * writes to device/pairing/invite payloads must carry a `resources` array and
 * must not persist `sessions` (a write-only migration input derived on read).
 *
 * registry_connections is the local ConnectionRegistry (worker-local / acs /
 * env upstreams) — unrelated to the personal-access model but kept here
 * because the transport resolves it from the same DB.
 *
 * Migrations mirror the management migrations style: a `migrations` table
 * records version/name/applied_at; steps run sequentially inside transactions.
 */
import { DatabaseSync } from 'node:sqlite';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fail } from './protocol.js';

export interface OrderedRow<T = unknown> {
  sequence: number;
  value: T;
}

// ---------------------------------------------------------------------------
// ConnectionRegistry surface (worker-local / acs / env upstream registrations).
// ---------------------------------------------------------------------------

export interface ConnectionRow {
  connectionId: string; kind: string; displayName?: string; baseUrl?: string;
  tokenRef?: string; envBaseUrl?: string; envTokenRef?: string;
  registeredAt: string; updatedAt: string; revision: number;
}
export interface ProjectRow {
  projectId: string; projectRef: string; connectionId: string; displayName?: string;
  notes?: string; registeredAt: string; updatedAt: string; revision: number;
}
export interface ConnectionRegistry {
  upsertConnection(input: { connectionId: string; kind: string; displayName?: string; baseUrl?: string; tokenRef?: string; envBaseUrl?: string; envTokenRef?: string }): ConnectionRow;
  getConnection(connectionId: string): ConnectionRow | undefined;
  listConnections(): ConnectionRow[];
  getProject(projectId: string): ProjectRow | undefined;
}

const CONNECTION_KINDS = new Set(['worker-local', 'acs', 'env']);

const MAX_BOUNDED_LIMIT = 5001;

interface ConnectionDbRow {
  connection_id: string; kind: string | null; base_url: string | null;
  token_ref: string | null; display_name: string | null;
  registered_at: string | null; updated_at: string | null; revision: number | null;
}

// ---------------------------------------------------------------------------
// Migrations — sequential versioned steps, each applied inside a transaction.
// ---------------------------------------------------------------------------

interface Migration {
  version: number;
  name: string;
  up(db: DatabaseSync): void;
}

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'device-gateway-core',
    up(db) {
      // Original dev schema — superseded by v2 but kept so existing databases
      // migrate forward cleanly.
      db.exec(`
        CREATE TABLE records(
          kind TEXT NOT NULL,
          record_id TEXT NOT NULL,
          payload TEXT NOT NULL,
          PRIMARY KEY(kind, record_id)
        );
        CREATE INDEX records_kind ON records(kind);

        CREATE TABLE device_requests(
          device_id TEXT NOT NULL,
          client_key TEXT NOT NULL,
          payload TEXT NOT NULL,
          PRIMARY KEY(device_id, client_key)
        );

        CREATE TABLE device_inbox_items(
          item_id TEXT PRIMARY KEY,
          device_id TEXT NOT NULL,
          event_key TEXT,
          coverage TEXT,
          grant_revision INTEGER,
          resource_kind TEXT,
          backend_store TEXT,
          session_id TEXT,
          task_id TEXT,
          expires_at INTEGER,
          observed_at INTEGER,
          payload TEXT NOT NULL
        );
        CREATE INDEX device_inbox_items_device_grant ON device_inbox_items(device_id, grant_revision);
        CREATE INDEX device_inbox_items_expires ON device_inbox_items(expires_at);

        CREATE TABLE device_source_cursors(
          cursor_key TEXT PRIMARY KEY,
          device_id TEXT NOT NULL,
          source_key TEXT,
          payload TEXT NOT NULL
        );
        CREATE INDEX device_source_cursors_device ON device_source_cursors(device_id);

        CREATE TABLE device_list_revisions(
          device_id TEXT PRIMARY KEY,
          device_revision INTEGER,
          updated_at INTEGER
        );

        CREATE TABLE registry_connections(
          connection_id TEXT PRIMARY KEY,
          kind TEXT,
          base_url TEXT,
          token_ref TEXT,
          display_name TEXT,
          registered_at TEXT,
          updated_at TEXT,
          revision INTEGER
        );
      `);
    },
  },
  {
    version: 2,
    name: 'personal-access-model',
    up(db) {
      // Java PersonalAccessStore schema — the generic kind→payload record
      // model plus the ordered projection tables. The invented specialized
      // tables from v1 are dropped (new dev package; data is disposable).
      db.exec(`
        CREATE TABLE IF NOT EXISTS personal_access_record(
          kind TEXT NOT NULL,
          id TEXT NOT NULL,
          payload TEXT NOT NULL,
          PRIMARY KEY(kind, id)
        );
        CREATE TABLE IF NOT EXISTS personal_access_record_order(
          kind TEXT NOT NULL,
          id TEXT NOT NULL,
          sequence INTEGER NOT NULL,
          PRIMARY KEY(kind, id),
          UNIQUE(kind, sequence)
        );
        CREATE TABLE IF NOT EXISTS personal_access_sequence(
          kind TEXT NOT NULL PRIMARY KEY,
          next_sequence INTEGER NOT NULL
        );

        DROP TABLE IF EXISTS records;
        DROP TABLE IF EXISTS device_requests;
        DROP TABLE IF EXISTS device_inbox_items;
        DROP TABLE IF EXISTS device_source_cursors;
        DROP TABLE IF EXISTS device_list_revisions;
      `);
      // Java service-constructor guard: scope-bearing payloads must be
      // resources-v2 (resources array present, legacy sessions absent).
      const guard =
        " WHEN NEW.kind IN ('device','pairing','invite') AND" +
        " (json_type(NEW.payload,'$.resources') IS NOT 'array'" +
        " OR json_type(NEW.payload,'$.sessions') IS NOT NULL)" +
        " BEGIN SELECT RAISE(ABORT,'RESOURCE_SCOPE_V2_REQUIRED'); END";
      db.exec(`CREATE TRIGGER IF NOT EXISTS personal_scope_v2_insert BEFORE INSERT ON personal_access_record${guard}`);
      db.exec(`CREATE TRIGGER IF NOT EXISTS personal_scope_v2_update BEFORE UPDATE ON personal_access_record${guard}`);
    },
  },
];

// ---------------------------------------------------------------------------

export class GatewayStore implements ConnectionRegistry {
  readonly db: DatabaseSync;
  private readonly writerLock: DatabaseSync;
  private txDepth = 0;
  private closed = false;

  constructor(readonly dir: string) {
    fs.mkdirSync(dir, { recursive: true });
    // An independent SQLite lock keeps one ledger writer alive across async
    // upstream calls. OS file locks release on crash, without stale PID files.
    // Keep this transaction separate from the short business transactions.
    this.writerLock = new DatabaseSync(path.join(dir, 'device-gateway-writer.db'));
    try {
      this.writerLock.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE; CREATE TABLE IF NOT EXISTS owner_lock(id INTEGER)');
    } catch {
      this.writerLock.close();
      fail('GATEWAY_STORE_IN_USE', 409);
    }
    let db: DatabaseSync | undefined;
    try {
      this.db = db = new DatabaseSync(path.join(dir, 'device-gateway.db'));
      this.db.exec('PRAGMA journal_mode=WAL');
      this.db.exec('PRAGMA synchronous=NORMAL');
      this.db.exec('PRAGMA busy_timeout=5000');
      this.db.exec('PRAGMA foreign_keys=ON');
      this.migrate();
    } catch (error) {
      db?.close();
      this.writerLock.close();
      throw error;
    }
  }

  // ---- migrations ---------------------------------------------------------

  private migrate(): void {
    this.db.exec(`CREATE TABLE IF NOT EXISTS migrations(
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    )`);
    const applied = new Set<number>();
    for (const row of this.db.prepare('SELECT version FROM migrations').all() as { version: number }[]) {
      applied.add(row.version);
    }
    const known = new Set(MIGRATIONS.map(migration => migration.version));
    if ([...applied].some(version => !known.has(version))) fail('GATEWAY_SCHEMA_UNSUPPORTED', 409);
    for (const migration of [...MIGRATIONS].sort((a, b) => a.version - b.version)) {
      if (applied.has(migration.version)) continue;
      this.db.exec('BEGIN IMMEDIATE');
      try {
        migration.up(this.db);
        this.db.prepare('INSERT INTO migrations(version, name, applied_at) VALUES(?,?,?)')
          .run(migration.version, migration.name, new Date().toISOString());
        this.db.exec('COMMIT');
      } catch (error) {
        try { this.db.exec('ROLLBACK'); } catch { /* already rolled back */ }
        throw error;
      }
    }
  }

  schemaVersion(): number {
    const row = this.db.prepare('SELECT MAX(version) AS v FROM migrations').get() as { v: number | null };
    return row.v ?? 0;
  }

  // ---- transactions ---------------------------------------------------------

  /** BEGIN IMMEDIATE / COMMIT / ROLLBACK; nested calls join the open transaction. */
  transaction<T>(fn: () => T): T {
    if (this.txDepth > 0) return fn();
    this.db.exec('BEGIN IMMEDIATE');
    this.txDepth++;
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* already rolled back */ }
      throw error;
    } finally {
      this.txDepth--;
    }
  }

  /** @deprecated — alias kept for callers written against the first cut. */
  inTransaction<T>(fn: () => T): T {
    return this.transaction(fn);
  }

  // ---- generic record access (Java get/list/put/delete) ----------------------

  get<T>(kind: string, id: string): T | undefined {
    const row = this.db.prepare('SELECT payload FROM personal_access_record WHERE kind=? AND id=?')
      .get(kind, id) as { payload: string } | undefined;
    return row ? (JSON.parse(row.payload) as T) : undefined;
  }

  list<T>(kind: string): T[] {
    return (this.db.prepare('SELECT payload FROM personal_access_record WHERE kind=? ORDER BY id')
      .all(kind) as { payload: string }[]).map((r) => JSON.parse(r.payload) as T);
  }

  put(kind: string, id: string, value: unknown): void {
    this.db.prepare(`INSERT INTO personal_access_record(kind, id, payload) VALUES(?,?,?)
      ON CONFLICT(kind, id) DO UPDATE SET payload=excluded.payload`)
      .run(kind, id, JSON.stringify(value));
  }

  delete(kind: string, id: string): void {
    this.db.prepare('DELETE FROM personal_access_record WHERE kind=? AND id=?').run(kind, id);
  }

  // ---- ordered records --------------------------------------------------------

  sequence(kind: string, id: string): number {
    const row = this.db.prepare('SELECT sequence FROM personal_access_record_order WHERE kind=? AND id=?')
      .get(kind, id) as { sequence: number } | undefined;
    return row?.sequence ?? 0;
  }

  /** Put plus a once-allocated stable sequence (re-put keeps the cursor slot). */
  putOrdered(kind: string, id: string, value: unknown): void {
    this.put(kind, id, value);
    if (this.sequence(kind, id) !== 0) return;
    this.db.prepare('INSERT OR IGNORE INTO personal_access_sequence(kind, next_sequence) VALUES(?,1)').run(kind);
    const row = this.db.prepare('SELECT next_sequence AS next FROM personal_access_sequence WHERE kind=?')
      .get(kind) as { next: number };
    this.db.prepare('UPDATE personal_access_sequence SET next_sequence=? WHERE kind=?').run(row.next + 1, kind);
    this.db.prepare('INSERT INTO personal_access_record_order(kind, id, sequence) VALUES(?,?,?)')
      .run(kind, id, row.next);
  }

  deleteOrdered(kind: string, id: string): void {
    this.delete(kind, id);
    this.db.prepare('DELETE FROM personal_access_record_order WHERE kind=? AND id=?').run(kind, id);
  }

  private static bound(limit: number): void {
    if (limit < 1 || limit > MAX_BOUNDED_LIMIT) throw new Error('invalid bounded limit');
  }

  private orderedRows<T>(sql: string, params: (string | number)[]): OrderedRow<T>[] {
    const rows = this.db.prepare(sql).all(...params) as { sequence: number; payload: string }[];
    return rows.map((row) => ({ sequence: row.sequence, value: JSON.parse(row.payload) as T }));
  }

  /** DESC by sequence; beforeSequence>0 restricts to sequence<beforeSequence. */
  listOrdered<T>(kind: string, beforeSequence: number, limit: number): OrderedRow<T>[] {
    GatewayStore.bound(limit);
    const sql = `SELECT o.sequence, r.payload
      FROM personal_access_record_order o
      JOIN personal_access_record r ON r.kind=o.kind AND r.id=o.id
      WHERE o.kind=?${beforeSequence > 0 ? ' AND o.sequence<?' : ''}
      ORDER BY o.sequence DESC LIMIT ?`;
    const params: (string | number)[] = [kind];
    if (beforeSequence > 0) params.push(beforeSequence);
    params.push(limit);
    return this.orderedRows<T>(sql, params);
  }

  /** Bounded DESC page filtered by payload.deviceId; any grant revision. */
  listOrderedForDevice<T>(kind: string, deviceId: string, limit: number): OrderedRow<T>[] {
    if (deviceId == null) return [];
    GatewayStore.bound(limit);
    return this.orderedRows<T>(
      `SELECT o.sequence, r.payload
       FROM personal_access_record_order o
       JOIN personal_access_record r ON r.kind=o.kind AND r.id=o.id
       WHERE o.kind=? AND json_extract(r.payload,'$.deviceId')=?
       ORDER BY o.sequence DESC LIMIT ?`,
      [kind, deviceId, limit],
    );
  }

  /** Bounded DESC page with device, grant and source-key filters before LIMIT. */
  listOrderedForDeviceSources<T>(
    kind: string,
    deviceId: string,
    grantRevision: number,
    beforeSequence: number,
    limit: number,
    sourceKeys: string[],
  ): OrderedRow<T>[] {
    if (deviceId == null || sourceKeys == null || sourceKeys.length === 0) return [];
    GatewayStore.bound(limit);
    const marks = sourceKeys.map(() => '?').join(',');
    const sql = `SELECT o.sequence, r.payload
      FROM personal_access_record_order o
      JOIN personal_access_record r ON r.kind=o.kind AND r.id=o.id
      WHERE o.kind=? AND json_extract(r.payload,'$.deviceId')=?
        AND json_extract(r.payload,'$.grantRevision')=?
        AND json_extract(r.payload,'$.sourceKey') IN (${marks})${beforeSequence > 0 ? ' AND o.sequence<?' : ''}
      ORDER BY o.sequence DESC LIMIT ?`;
    const params: (string | number)[] = [kind, deviceId, grantRevision, ...sourceKeys];
    if (beforeSequence > 0) params.push(beforeSequence);
    params.push(limit);
    return this.orderedRows<T>(sql, params);
  }

  /** Bounded DESC page filtered to payload.sourceKey ∈ sourceKeys. */
  listOrderedForSources<T>(
    kind: string,
    sourceKeys: string[],
    beforeSequence: number,
    limit: number,
  ): OrderedRow<T>[] {
    if (sourceKeys == null || sourceKeys.length === 0) return [];
    GatewayStore.bound(limit);
    const marks = sourceKeys.map(() => '?').join(',');
    const sql = `SELECT o.sequence, r.payload
      FROM personal_access_record_order o
      JOIN personal_access_record r ON r.kind=o.kind AND r.id=o.id
      WHERE o.kind=? AND json_extract(r.payload,'$.sourceKey') IN (${marks})${beforeSequence > 0 ? ' AND o.sequence<?' : ''}
      ORDER BY o.sequence DESC LIMIT ?`;
    const params: (string | number)[] = [kind, ...sourceKeys];
    if (beforeSequence > 0) params.push(beforeSequence);
    params.push(limit);
    return this.orderedRows<T>(sql, params);
  }

  // ---- ConnectionRegistry ---------------------------------------------------------------

  private static toConnectionRow(r: ConnectionDbRow): ConnectionRow {
    const row: ConnectionRow = {
      connectionId: r.connection_id,
      kind: r.kind ?? '',
      registeredAt: r.registered_at ?? '',
      updatedAt: r.updated_at ?? '',
      revision: r.revision ?? 0,
    };
    if (r.base_url != null) row.baseUrl = r.base_url;
    if (r.token_ref != null) row.tokenRef = r.token_ref;
    if (r.display_name != null) row.displayName = r.display_name;
    return row;
  }

  /** Register-once: inserts only; returns the existing row when connection_id is taken. */
  upsertConnection(input: {
    connectionId: string; kind: string; displayName?: string; baseUrl?: string;
    tokenRef?: string; envBaseUrl?: string; envTokenRef?: string;
  }): ConnectionRow {
    const existing = this.getConnection(input.connectionId);
    if (existing) return existing;
    if (!CONNECTION_KINDS.has(input.kind)) fail('INVALID_REQUEST', 400);
    const now = new Date().toISOString();
    this.db.prepare(`INSERT INTO registry_connections(
        connection_id, kind, base_url, token_ref, display_name, registered_at, updated_at, revision
      ) VALUES(?,?,?,?,?,?,?,1)`)
      .run(input.connectionId, input.kind, input.baseUrl ?? null, input.tokenRef ?? null,
        input.displayName ?? null, now, now);
    return this.getConnection(input.connectionId)!;
  }

  /**
   * Managed rows (cli-supervisor) rebind to a fresh loopback port every spawn —
   * unlike fixed env connections they must be re-pointable after a restart.
   */
  updateConnectionBaseUrl(connectionId: string, baseUrl: string): void {
    this.db.prepare(`UPDATE registry_connections
        SET base_url=?, updated_at=?, revision=revision+1
      WHERE connection_id=?`)
      .run(baseUrl, new Date().toISOString(), connectionId);
  }

  getConnection(connectionId: string): ConnectionRow | undefined {
    const row = this.db.prepare('SELECT * FROM registry_connections WHERE connection_id=?')
      .get(connectionId) as ConnectionDbRow | undefined;
    return row ? GatewayStore.toConnectionRow(row) : undefined;
  }

  listConnections(): ConnectionRow[] {
    return (this.db.prepare('SELECT * FROM registry_connections ORDER BY connection_id')
      .all() as unknown as ConnectionDbRow[])
      .map(GatewayStore.toConnectionRow);
  }

  getProject(_projectId: string): ProjectRow | undefined {
    return undefined;
  }

  // ---- lifecycle ---------------------------------------------------------------------------

  checkpoint(): void {
    try { this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch { /* best effort */ }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.checkpoint();
      this.db.close();
    } finally {
      this.writerLock.close();
    }
  }
}
