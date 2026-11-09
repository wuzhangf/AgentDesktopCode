/**
 * Management console persistence — the ONLY write DB this server owns.
 * <root>/management.db (WAL). Worker registry, durable operations, settings.
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { ConsoleSettings, Operation, OperationKind, OperationState, OperationStep, WorkerDetail, WorkerKind, WorkerOwnership } from '../../shared/management/api';

export const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export interface ManagedDirs { root: string; control: string; state: string; work: string; logs: string }
export interface ManagedConfig {
  releaseRoot: string | null;
  provider: string;
  workerId: string;
  dirs: ManagedDirs;
  ports: { control: number | null; health: number | null };
  configFile: string | null;
  /** Per-boot demo-plane credential. Never serialized to API/diagnostics. */
  controlToken: string | null;
  /** LOCAL_DEMO_PLANE only when a control spec actually spawned. */
  controlPlane: 'LOCAL_DEMO_PLANE' | 'NONE';
  pid: { daemon: number | null; control: number | null };
  startedAt: string | null;
  drainTimeoutMillis: number;
}
export interface ExternalConfig { healthUrl: string; stateDir: string | null }
export type WorkerConfig = ManagedConfig | ExternalConfig;

export interface WorkerRow {
  workerKey: string; kind: WorkerKind; name: string; machine: string;
  config: WorkerConfig; createdAt: string; updatedAt: string;
  lastSeenAt: string | null; lastHealth: StoredHealth | null;
}
export interface OperationRow {
  operationId: string; workerKey: string; kind: OperationKind; state: OperationState;
  steps: OperationStep[]; error: { code: string; message: string } | null;
  createdAt: string; updatedAt: string;
}
export interface StoredHealth {
  checkedAt: string;
  layers: { layer: string; state: string; summary: string; detail?: string; observedAt: string }[];
  derived: {
    connection: string; daemonReady: boolean | null; draining: boolean | null;
    installGate: string; acceptingTasks: string; activeAttemptId: string | null;
    workerId: string | null; instanceId: string | null;
    provider: string | null; providerBundle: string | null;
    embeddedRuntime: string | null; version: string | null;
  };
  /** Last probe's ownership/control facts — lets GET detail serve fresh
   *  cached snapshots without re-probing. Absent in rows written before. */
  ownership?: WorkerOwnership;
  control?: WorkerDetail['control'];
}

const DDL = [
  `CREATE TABLE IF NOT EXISTS workers(
    worker_key TEXT PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL,
    machine TEXT NOT NULL, config_json TEXT NOT NULL,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    last_seen_at TEXT, last_health_json TEXT)`,
  `CREATE TABLE IF NOT EXISTS operations(
    operation_id TEXT PRIMARY KEY, worker_key TEXT NOT NULL, kind TEXT NOT NULL,
    state TEXT NOT NULL, steps_json TEXT NOT NULL, error_json TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
];

export const DEFAULT_SETTINGS: ConsoleSettings = {
  releaseRoot: null, defaultProvider: 'fixture', acsConnections: [], obsApiUrl: null,
};

export class Store {
  readonly db: DatabaseSync;
  constructor(readonly root: string) {
    mkdirSync(root, { recursive: true });
    this.db = new DatabaseSync(join(root, 'management.db'), { timeout: 2000 });
    this.db.exec('PRAGMA journal_mode = WAL');
    for (const stmt of DDL) this.db.exec(stmt);
  }
  close() { this.db.close(); }

  // ---------------------------------------------------------------- workers
  listWorkers(): WorkerRow[] {
    return (this.db.prepare('SELECT * FROM workers ORDER BY created_at, worker_key').all() as any[])
      .map(row => this.toWorker(row));
  }
  getWorker(key: string): WorkerRow | null {
    const row = this.db.prepare('SELECT * FROM workers WHERE worker_key = ?').get(key) as any;
    return row ? this.toWorker(row) : null;
  }
  insertWorker(w: WorkerRow) {
    this.db.prepare(`INSERT INTO workers(worker_key,kind,name,machine,config_json,created_at,updated_at,last_seen_at,last_health_json)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(w.workerKey, w.kind, w.name, w.machine,
      JSON.stringify(w.config), w.createdAt, w.updatedAt, w.lastSeenAt,
      w.lastHealth == null ? null : JSON.stringify(w.lastHealth));
  }
  updateWorker(key: string, patch: { name?: string; config?: WorkerConfig; lastSeenAt?: string | null; lastHealth?: StoredHealth | null }) {
    const w = this.getWorker(key);
    if (!w) return;
    const next = { ...w, ...patch, updatedAt: new Date().toISOString() };
    this.db.prepare(`UPDATE workers SET name=?, config_json=?, updated_at=?, last_seen_at=?, last_health_json=? WHERE worker_key=?`)
      .run(next.name, JSON.stringify(next.config), next.updatedAt, next.lastSeenAt,
        next.lastHealth == null ? null : JSON.stringify(next.lastHealth), key);
  }
  private toWorker(r: any): WorkerRow {
    return { workerKey: r.worker_key, kind: r.kind, name: r.name, machine: r.machine,
      config: JSON.parse(r.config_json), createdAt: r.created_at, updatedAt: r.updated_at,
      lastSeenAt: r.last_seen_at, lastHealth: r.last_health_json ? JSON.parse(r.last_health_json) : null };
  }

  // ------------------------------------------------------------- operations
  createOperation(op: OperationRow) {
    this.db.prepare(`INSERT INTO operations(operation_id,worker_key,kind,state,steps_json,error_json,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?)`).run(op.operationId, op.workerKey, op.kind, op.state,
      JSON.stringify(op.steps), op.error == null ? null : JSON.stringify(op.error), op.createdAt, op.updatedAt);
  }
  getOperation(id: string): OperationRow | null {
    const r = this.db.prepare('SELECT * FROM operations WHERE operation_id = ?').get(id) as any;
    return r ? this.toOperation(r) : null;
  }
  listOperations(limit = 50, workerKey?: string): OperationRow[] {
    const sql = workerKey
      ? 'SELECT * FROM operations WHERE worker_key = ? ORDER BY created_at DESC, operation_id DESC LIMIT ?'
      : 'SELECT * FROM operations ORDER BY created_at DESC, operation_id DESC LIMIT ?';
    const rows = (workerKey
      ? this.db.prepare(sql).all(workerKey, limit)
      : this.db.prepare(sql).all(limit)) as any[];
    return rows.map(r => this.toOperation(r));
  }
  /** unfinished ops — reconcile targets at boot */
  liveOperations(): OperationRow[] {
    return (this.db.prepare("SELECT * FROM operations WHERE state IN ('PENDING','RUNNING')").all() as any[])
      .map(r => this.toOperation(r));
  }
  appendStep(id: string, message: string) {
    const op = this.getOperation(id);
    if (!op) return;
    op.steps.push({ at: new Date().toISOString(), message });
    if (op.steps.length > 200) op.steps.splice(0, op.steps.length - 200);
    this.db.prepare('UPDATE operations SET steps_json=?, updated_at=? WHERE operation_id=?')
      .run(JSON.stringify(op.steps), new Date().toISOString(), id);
  }
  finishOperation(id: string, state: OperationState, error: { code: string; message: string } | null = null) {
    this.db.prepare('UPDATE operations SET state=?, error_json=?, updated_at=? WHERE operation_id=?')
      .run(state, error == null ? null : JSON.stringify(error), new Date().toISOString(), id);
  }
  setOperationState(id: string, state: OperationState) {
    this.db.prepare('UPDATE operations SET state=?, updated_at=? WHERE operation_id=?')
      .run(state, new Date().toISOString(), id);
  }
  private toOperation(r: any): OperationRow {
    return { operationId: r.operation_id, workerKey: r.worker_key, kind: r.kind, state: r.state,
      steps: JSON.parse(r.steps_json), error: r.error_json ? JSON.parse(r.error_json) : null,
      createdAt: r.created_at, updatedAt: r.updated_at };
  }
  /** Join name for the API shape; falls back to the key if the row vanished. */
  operationName(key: string): string {
    const w = this.getWorker(key);
    return w ? w.name : key;
  }
  toApiOperation(op: OperationRow): Operation {
    return { operationId: op.operationId, workerKey: op.workerKey, workerName: this.operationName(op.workerKey),
      kind: op.kind, state: op.state, createdAt: op.createdAt, updatedAt: op.updatedAt,
      steps: op.steps, error: op.error };
  }

  // --------------------------------------------------------------- settings
  getSettings(): ConsoleSettings {
    const r = this.db.prepare("SELECT value FROM settings WHERE key='console'").get() as any;
    if (!r) return { ...DEFAULT_SETTINGS };
    try { return { ...DEFAULT_SETTINGS, ...JSON.parse(r.value) }; }
    catch { return { ...DEFAULT_SETTINGS }; }
  }
  putSettings(s: ConsoleSettings) {
    this.db.prepare(`INSERT INTO settings(key,value) VALUES('console',?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(JSON.stringify(s));
  }
}
