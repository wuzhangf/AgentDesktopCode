/**
 * Seed + assertion helpers for the E2E suite.
 *
 * Registry rows are inserted straight into the console store (same shape as
 * tests/management.test.ts `fixtureWorker`) — registration *through* HTTP is a
 * test subject of its own (register.e2e.spec.ts), so seeding bypasses it.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { APIRequestContext } from '@playwright/test';
import type { ExternalConfig, ManagedConfig, Store, WorkerRow } from '../../../server/management/store';

const nowIso = () => new Date().toISOString();

export interface SeedManagedOptions {
  provider?: string;
  releaseRoot?: string | null;
  workerId?: string;
  /** Pre-arm the gate file (probe reads it when readyz is unavailable). */
  gate?: 'ARMED' | 'DISARMED';
}

/** Managed worker whose dirs live under the console state root. */
export function seedManaged(store: Store, name: string, opts: SeedManagedOptions = {}): WorkerRow {
  const root = join(store.root, 'workers', name);
  const cfg: ManagedConfig = {
    releaseRoot: opts.releaseRoot ?? null,
    provider: opts.provider ?? 'fixture',
    workerId: opts.workerId ?? `w-${name}`,
    dirs: {
      root, control: join(root, 'control'), state: join(root, 'worker-state'),
      work: join(root, 'worker-work'), logs: join(root, 'logs'),
    },
    ports: { control: null, health: null },
    configFile: join(root, 'worker.properties'),
    controlToken: null, controlPlane: 'NONE', pid: { daemon: null, control: null },
    startedAt: null, drainTimeoutMillis: 1500,
  };
  const w: WorkerRow = {
    workerKey: name, kind: 'MANAGED', name, machine: 'local', config: cfg,
    createdAt: nowIso(), updatedAt: nowIso(), lastSeenAt: null, lastHealth: null,
  };
  store.insertWorker(w);
  if (opts.gate) writeGate(cfg.dirs.state, opts.gate);
  return w;
}

/** External worker: health observation + optional read-only journal. */
export function seedExternal(
  store: Store, name: string, opts: { healthUrl: string; stateDir?: string | null },
): WorkerRow {
  const cfg: ExternalConfig = { healthUrl: opts.healthUrl, stateDir: opts.stateDir ?? null };
  const w: WorkerRow = {
    workerKey: name, kind: 'EXTERNAL', name, machine: 'local', config: cfg,
    createdAt: nowIso(), updatedAt: nowIso(), lastSeenAt: null, lastHealth: null,
  };
  store.insertWorker(w);
  return w;
}

/**
 * Write a stored probe snapshot directly — lets a test start from a state the
 * console would otherwise only reach after a real observation (e.g. "was
 * running, now DOWN", gate ARMED, draining latched).
 */
export function setLastHealth(store: Store, workerKey: string, derived: Record<string, any>,
  opts: { lastSeenAt?: string | null; layers?: { layer: string; state: string; summary: string }[] } = {}) {
  const checkedAt = nowIso();
  store.updateWorker(workerKey, {
    lastSeenAt: opts.lastSeenAt === undefined ? checkedAt : opts.lastSeenAt,
    lastHealth: {
      checkedAt,
      layers: (opts.layers ?? [
        { layer: 'HOST', state: derived.connection ?? 'UNKNOWN', summary: 'seeded' },
        { layer: 'DAEMON', state: 'UNKNOWN', summary: 'seeded' },
        { layer: 'ENGINE', state: 'UNKNOWN', summary: 'seeded' },
        { layer: 'TOOLCHAIN', state: 'UNKNOWN', summary: '未采集' },
      ]).map(l => ({ ...l, observedAt: checkedAt })),
      derived: {
        connection: 'UNKNOWN', daemonReady: null, draining: null, installGate: 'UNKNOWN',
        acceptingTasks: 'UNKNOWN', activeAttemptId: null, workerId: null, instanceId: null,
        provider: null, providerBundle: null, embeddedRuntime: null, version: null, ...derived,
      },
    },
  });
}

/** install-gate.json in the daemon's own shape. */export function writeGate(stateDir: string, state: 'ARMED' | 'DISARMED') {
  mkdirSync(join(stateDir, 'maintenance'), { recursive: true });
  writeFileSync(join(stateDir, 'maintenance', 'install-gate.json'), JSON.stringify({
    schemaVersion: 'install-gate/1.0', gateId: `gate-seed-${state}`, state,
    reason: 'e2e seed', armedAt: nowIso(), ...(state === 'DISARMED' ? { disarmedAt: nowIso() } : {}),
  }, null, 2));
}

/** Corrupt gate file — daemon semantics: unreadable ⇒ fail closed. */
export function writeBrokenGate(stateDir: string) {
  mkdirSync(join(stateDir, 'maintenance'), { recursive: true });
  writeFileSync(join(stateDir, 'maintenance', 'install-gate.json'), '{ this is not json');
}

/**
 * journal.db with the tables journal.ts projects. Deterministic values so the
 * UI assertions can match literals.
 */
export function seedJournalDb(stateDir: string) {
  mkdirSync(stateDir, { recursive: true });
  const file = join(stateDir, 'journal.db');
  const db = new DatabaseSync(file);
  try {
    db.exec(`
      CREATE TABLE worker_identity(singleton INTEGER PRIMARY KEY, worker_id TEXT, deployment_id TEXT,
        boot_id TEXT, instance_id TEXT, stream_id TEXT, worker_lease_epoch TEXT, updated_at TEXT);
      CREATE TABLE command_inbox(command_id TEXT PRIMARY KEY, state TEXT, command_type TEXT,
        intake_status TEXT, last_error TEXT, received_at TEXT, acked_at TEXT);
      CREATE TABLE execution_journal(attempt_id TEXT, run_command_id TEXT, state TEXT, outcome TEXT,
        engine_run_id TEXT, detail TEXT, updated_at TEXT, PRIMARY KEY(attempt_id, run_command_id));
      CREATE TABLE finish_journal(attempt_id TEXT PRIMARY KEY, finish_id TEXT, local_state TEXT,
        last_error TEXT, submitted_at TEXT, finalized_at TEXT);
    `);
    db.prepare(`INSERT INTO worker_identity VALUES(1,'w-seed','dep-seed','boot-seed-0001','inst-seed',
      'stream-seed','1','2026-10-01T00:00:00Z')`).run();
    db.prepare(`INSERT INTO command_inbox(command_id,state,command_type,intake_status,received_at)
      VALUES('cmd-seed-1','DURABLY_ACCEPTED','startTask','ACCEPTED','2026-10-01T23:59:00Z')`).run();
    db.prepare(`INSERT INTO execution_journal VALUES('att-seed-1','rc-seed-1','FINISHED','SUCCESS',
      'run-seed-1','seeded execution row','2026-10-02T00:00:00Z')`).run();
    db.prepare(`INSERT INTO finish_journal VALUES('att-seed-1','fin-seed-1','FINALIZED',NULL,
      '2026-10-02T00:00:03Z','2026-10-02T00:00:05Z')`).run();
    db.exec('PRAGMA user_version = 7');
  } finally {
    db.close();
  }
  return file;
}

/**
 * Minimal release tree that satisfies the file-level install checks:
 * distribution/worker/agent-worker-local-9.9.9/lib/*.jar + manifest.json +
 * worker/worker-testkit/target/worker-testkit-9.9.9.jar.
 * The `java` finding still depends on PATH — tests assert it as-is.
 */
export function makeFakeRelease(root: string): string {
  const dist = join(root, 'distribution', 'worker', 'agent-worker-local-9.9.9');
  mkdirSync(join(dist, 'lib'), { recursive: true });
  writeFileSync(join(dist, 'lib', 'agent-worker-local-9.9.9.jar'), '');
  writeFileSync(join(dist, 'manifest.json'), JSON.stringify({ version: '9.9.9' }));
  const tk = join(root, 'worker', 'worker-testkit', 'target');
  mkdirSync(tk, { recursive: true });
  writeFileSync(join(tk, 'worker-testkit-9.9.9.jar'), '');
  return root;
}

/** POST /api/manage/workers/register through the real HTTP path. */
export async function registerViaApi(
  request: APIRequestContext, url: string, body: Record<string, unknown>,
): Promise<{ status: number; json: any }> {
  const res = await request.post(`${url}/api/manage/workers/register`, {
    headers: { 'x-manage-control': '1', 'content-type': 'application/json' },
    data: body,
  });
  let json: any = null;
  try { json = await res.json(); } catch { /* non-JSON error page */ }
  return { status: res.status(), json };
}

/** POST an operation through the real HTTP path. */
export async function submitOpViaApi(
  request: APIRequestContext, url: string, workerKey: string, kind: string, operationId: string,
): Promise<{ status: number; json: any }> {
  const res = await request.post(`${url}/api/manage/workers/${encodeURIComponent(workerKey)}/operations`, {
    headers: { 'x-manage-control': '1', 'content-type': 'application/json' },
    data: { operationId, kind },
  });
  let json: any = null;
  try { json = await res.json(); } catch { /* ignore */ }
  return { status: res.status(), json };
}

/** Poll GET /operations/:id until it reaches one of `want` (default: terminal). */
export async function waitOp(
  request: APIRequestContext, url: string, opId: string,
  want: string[] = ['SUCCEEDED', 'FAILED', 'VERIFY_FAILED'],
): Promise<any> {
  const deadline = Date.now() + 45_000;
  let last: any = null;
  while (Date.now() < deadline) {
    const res = await request.get(`${url}/api/manage/operations/${encodeURIComponent(opId)}`);
    if (res.ok()) {
      last = await res.json();
      if (want.includes(last?.state)) return last;
    }
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error(`operation ${opId} 未在预算内到达 ${want.join('|')}：${JSON.stringify(last)}`);
}

/** Unique operation id per submission (the console's idempotency key). */
export const opId = (tag = 'op') => `${tag}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

/** Drive a managed worker to "running" through the real API (UI tests start here). */
export async function startManagedViaApi(
  request: APIRequestContext, url: string, workerKey: string, kind = 'START',
): Promise<any> {
  const id = opId(kind.toLowerCase());
  const res = await submitOpViaApi(request, url, workerKey, kind, id);
  if (res.status !== 201) throw new Error(`提交 ${kind} 失败：HTTP ${res.status} ${JSON.stringify(res.json)}`);
  return waitOp(request, url, id);
}

/** Runtime knobs on the fake daemon. */export async function setStub(
  request: APIRequestContext, baseUrl: string, patch: Record<string, unknown>,
): Promise<any> {
  const res = await request.post(`${baseUrl}/__ctl`, { data: patch });
  if (!res.ok()) throw new Error(`__ctl ${baseUrl} → HTTP ${res.status()}`);
  return res.json();
}

/** Health base of a managed worker after START (port assigned by the console). */
export function healthBaseOf(store: Store, workerKey: string): string {
  const w = store.getWorker(workerKey);
  const cfg = w?.config as ManagedConfig | undefined;
  const port = cfg?.ports.health;
  if (port == null) throw new Error(`worker ${workerKey} 尚未分配健康端口（未启动？）`);
  return `http://127.0.0.1:${port}`;
}

// --------------------------------------------------------------- health stub

export interface HealthStubState {
  ready: boolean;
  draining: boolean;
  attemptId: string;
  workerId: string;
  instanceId: string;
  installGate: string;
  providerBundle: string;
}

export interface HealthStub {
  readonly url: string;
  readonly port: number;
  readonly state: HealthStubState;
  /** In-place state change — the console's next probe must observe it. */
  set(patch: Partial<HealthStubState>): void;
  close(): Promise<void>;
}

/**
 * In-process daemon health surface for EXTERNAL workers: /health/live +
 * /readyz, mutable between probes (E2E-UI-032/036/052).
 */
export async function startHealthStub(init: Partial<HealthStubState> = {}): Promise<HealthStub> {
  const state: HealthStubState = {
    ready: true, draining: false, attemptId: '', workerId: 'w-ext',
    instanceId: 'inst-ext-1', installGate: 'disarmed',
    providerBundle: 'provider-bundle=fixture', ...init,
  };
  const server: Server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (path === '/health/live') { json(200, { status: 'live' }); return; }
    if (path === '/readyz') { json(state.ready ? 200 : 503, { ...state }); return; }
    json(404, { error: 'not found' });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as any).port as number;
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    state,
    set(patch) { Object.assign(state, patch); },
    close: () => new Promise<void>(r => { server.close(() => r()); server.closeAllConnections(); }),
  };
}
