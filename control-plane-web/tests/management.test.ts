/**
 * management console tests — no java required: managed lifecycle runs against
 * a node stub daemon serving /health/live + /readyz via an injected spawn plan.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { createServer, request, type Server } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store, type ManagedConfig, type WorkerRow } from '../server/management/store';
import { createManagementServer, type ManagementHandle } from '../server/management/server';
import { checkInstall, Lifecycle, type SpawnSpec } from '../server/management/lifecycle';
import { gateFileOf, probeWorker } from '../server/management/probe';
import { readJournal } from '../server/management/journal';
import { pidAlive, verifyOwnership } from '../server/management/sys';

const tmp = () => mkdtempSync(join(tmpdir(), 'mgmt-test-'));
const dirs: string[] = [];
const servers: Server[] = [];
const children: number[] = [];
const stores: Store[] = [];

function fixtureWorker(store: Store, name = 'demo'): WorkerRow {
  const root = join(store.root, 'workers', name);
  const w: WorkerRow = {
    workerKey: name, kind: 'MANAGED', name, machine: 'local',
    config: {
      releaseRoot: null, provider: 'fixture', workerId: 'w-' + name,
      dirs: { root, control: join(root, 'control'), state: join(root, 'worker-state'),
        work: join(root, 'worker-work'), logs: join(root, 'logs') },
      ports: { control: null, health: null },
      configFile: join(root, 'worker.properties'),
      controlToken: null, controlPlane: 'NONE', pid: { daemon: null, control: null },
      startedAt: null, drainTimeoutMillis: 1500,
    } satisfies ManagedConfig,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    lastSeenAt: null, lastHealth: null,
  };
  store.insertWorker(w);
  return w;
}

const STUB = String.raw`
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
const stateDir = process.argv[2], port = Number(process.argv[3]);
createServer((req, res) => {
  if (req.url === '/health/live') { res.writeHead(200); res.end('{"status":"live"}'); return; }
  if (req.url === '/readyz') {
    let gate = 'disarmed';
    try {
      const g = JSON.parse(readFileSync(join(stateDir, 'maintenance', 'install-gate.json'), 'utf8'));
      gate = g.state === 'DISARMED' ? 'disarmed' : 'ARMED';
    } catch {}
    const ready = process.env.STUB_READY !== '0';
    res.writeHead(ready ? 200 : 503, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ready, workerId: 'w-stub', instanceId: 'inst-stub',
      draining: false, installGate: gate, attemptId: '', providerBundle: 'provider-bundle=fixture' }));
    return;
  }
  res.writeHead(404); res.end();
}).listen(port, '127.0.0.1');
`;

function stubPlan(stubFile: string) {
  return (w: WorkerRow): SpawnSpec[] => {
    const cfg = w.config as ManagedConfig;
    return [{ role: 'daemon', command: process.execPath,
      args: [stubFile, cfg.dirs.state, String(cfg.ports.health)] }];
  };
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  servers.push(server);
  return (server.address() as any).port;
}

// raw http.request — fetch strips Host, which we must control for gating tests
async function call(port: number, method: string, path: string, opts: { body?: unknown; headers?: Record<string, string> } = {}) {
  return new Promise<{ status: number; json: any; text: string; headers: any }>((resolvePromise, rejectPromise) => {
    const payload = opts.body === undefined ? undefined : JSON.stringify(opts.body);
    const req = request({ host: '127.0.0.1', port, method, path,
      headers: { 'content-type': 'application/json', 'x-manage-control': '1', ...opts.headers } }, res => {
      const chunks: Buffer[] = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json: any = null;
        try { json = JSON.parse(text); } catch {}
        resolvePromise({ status: res.statusCode!, json, text, headers: res.headers });
      });
    });
    req.on('error', rejectPromise);
    if (payload) req.write(payload);
    req.end();
  });
}

const waitOp = async (h: ManagementHandle, id: string) => {
  await h.lifecycle.waitOperation(id);
  return h.store.getOperation(id)!;
};

afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise<void>(r => s.close(() => r()));
  for (const pid of children.splice(0)) { try { process.kill(pid); } catch {} }
  for (const st of stores.splice(0)) { try { st.close(); } catch {} }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const track = <T extends Store>(s: T): T => { stores.push(s); return s; };
const manage = (o: Parameters<typeof createManagementServer>[0]): ManagementHandle => {
  const h = createManagementServer(o); stores.push(h.store); return h;
};

// ---------------------------------------------------------------- store

describe('store', () => {
  it('worker + settings + operation roundtrip, persisted across reopen', () => {
    const root = tmp(); dirs.push(root);
    const s1 = track(new Store(root));
    fixtureWorker(s1);
    s1.putSettings({ releaseRoot: 'D:/rel', defaultProvider: 'agentcode',
      acsConnections: [{ name: 'acs', baseUrl: 'http://127.0.0.1:8080', tokenEnv: 'ACS_TOKEN' }], obsApiUrl: null });
    s1.createOperation({ operationId: 'op-1', workerKey: 'demo', kind: 'START', state: 'PENDING',
      steps: [{ at: new Date().toISOString(), message: '已受理' }], error: null,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    s1.close();

    const s2 = track(new Store(root));
    const w = s2.getWorker('demo');
    expect(w?.kind).toBe('MANAGED');
    expect((w?.config as ManagedConfig).workerId).toBe('w-demo');
    expect(s2.getSettings().defaultProvider).toBe('agentcode');
    expect(s2.getSettings().acsConnections[0].tokenEnv).toBe('ACS_TOKEN');
    const op = s2.getOperation('op-1');
    expect(op?.state).toBe('PENDING');
    expect(s2.toApiOperation(op!).workerName).toBe('demo');
    s2.close();
  });
});

// --------------------------------------------------------------- journal

describe('journal', () => {
  it('reads a real journal.db read-only, tolerates missing tables', () => {
    const root = tmp(); dirs.push(root);
    const jf = join(root, 'journal.db');
    const db = new DatabaseSync(jf);
    db.exec(`CREATE TABLE worker_identity(singleton INTEGER PRIMARY KEY, worker_id TEXT, deployment_id TEXT,
      boot_id TEXT, instance_id TEXT, stream_id TEXT, worker_lease_epoch TEXT, updated_at TEXT);
      CREATE TABLE command_inbox(command_id TEXT PRIMARY KEY, state TEXT, command_type TEXT,
        last_error TEXT, received_at TEXT, acked_at TEXT);
      CREATE TABLE execution_journal(attempt_id TEXT, run_command_id TEXT, state TEXT,
        outcome TEXT, updated_at TEXT, PRIMARY KEY(attempt_id, run_command_id));`);
    db.prepare(`INSERT INTO worker_identity VALUES(1,'w1','dep','b1','inst-1','s1','1','2026-01-01T00:00:00Z')`).run();
    db.prepare(`INSERT INTO command_inbox(command_id,state,command_type,received_at) VALUES('cmd-1','DURABLY_ACCEPTED','startTask','2026-01-02T00:00:00Z')`).run();
    db.prepare(`INSERT INTO execution_journal VALUES('att-1','rc-1','FINISHED','SUCCESS','2026-01-03T00:00:00Z')`).run();
    db.close();
    const view = readJournal(jf, 50);
    expect(view.rows.length).toBe(3);
    expect(view.rows[0].table).toBe('execution_journal');   // newest first
    expect(view.journalFile).toBe(jf);
  });

  it('missing journal file → empty view with note', () => {
    const view = readJournal(join(tmp(), 'nope', 'journal.db'), 10);
    expect(view.rows).toEqual([]);
    expect(view.note).toContain('不存在');
  });
});

// ----------------------------------------------------------------- probe

describe('probe', () => {
  it('layered probe against a fake health server', async () => {
    const fake = createServer((req, res) => {
      if (req.url === '/health/live') { res.writeHead(200); res.end('{"status":"live"}'); return; }
      if (req.url === '/readyz') {
        res.writeHead(503, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ready: false, workerId: 'w-ext', instanceId: 'inst-1',
          draining: true, installGate: 'disarmed', attemptId: '', providerBundle: 'provider-bundle=fixture' }));
        return;
      }
      res.writeHead(404); res.end();
    });
    const port = await listen(fake);
    const root = tmp(); dirs.push(root);
    const store = track(new Store(root));
    store.insertWorker({ workerKey: 'ext', kind: 'EXTERNAL', name: 'ext', machine: 'local',
      config: { healthUrl: `http://127.0.0.1:${port}`, stateDir: null },
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), lastSeenAt: null, lastHealth: null });
    const w = store.getWorker('ext')!;
    const p = await probeWorker(w, store.getSettings());
    expect(p.health.layers).toHaveLength(4);
    expect(p.health.layers[0]).toMatchObject({ layer: 'HOST', state: 'OK' });
    expect(p.health.layers[1]).toMatchObject({ layer: 'DAEMON', state: 'DEGRADED' });
    expect(p.health.layers[2]).toMatchObject({ layer: 'ENGINE', state: 'DEGRADED' });  // fixture provider
    expect(p.health.layers[3]).toMatchObject({ layer: 'TOOLCHAIN', state: 'UNKNOWN' });
    expect(p.derived.draining).toBe(true);
    expect(p.derived.acceptingTasks).toBe('NO_DRAINING');
    expect(p.derived.workerId).toBe('w-ext');
    store.close();
  });

  it('unreachable daemon → DAEMON DOWN, acceptingTasks UNKNOWN', async () => {
    const root = tmp(); dirs.push(root);
    const store = track(new Store(root));
    store.insertWorker({ workerKey: 'dead', kind: 'EXTERNAL', name: 'dead', machine: 'local',
      config: { healthUrl: 'http://127.0.0.1:1', stateDir: null },
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), lastSeenAt: null, lastHealth: null });
    const p = await probeWorker(store.getWorker('dead')!, store.getSettings());
    expect(p.health.layers[1].state).toBe('DOWN');
    expect(p.derived.acceptingTasks).toBe('UNKNOWN');
    store.close();
  });

  it('installGate normalization — daemon tokens map to contract values; UNREADABLE is closed', async () => {
    const seen: { ready: boolean; gate: string; wantGate: string; wantAccept: string }[] = [
      { ready: true, gate: 'ARMED', wantGate: 'ARMED', wantAccept: 'NO_GATE' },
      { ready: true, gate: 'unmounted', wantGate: 'UNMOUNTED', wantAccept: 'YES' },
      { ready: true, gate: 'UNREADABLE', wantGate: 'UNREADABLE', wantAccept: 'NO_GATE' },
      { ready: true, gate: 'disarmed', wantGate: 'DISARMED', wantAccept: 'YES' },
    ];
    for (const c of seen) {
      const fake = createServer((req, res) => {
        if (req.url === '/health/live') { res.writeHead(200); res.end('{}'); return; }
        if (req.url === '/readyz') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ready: c.ready, installGate: c.gate, draining: false }));
          return;
        }
        res.writeHead(404); res.end();
      });
      const port = await listen(fake);
      const root = tmp(); dirs.push(root);
      const store = track(new Store(root));
      store.insertWorker({ workerKey: `w-${port}`, kind: 'EXTERNAL', name: 'x', machine: 'local',
        config: { healthUrl: `http://127.0.0.1:${port}`, stateDir: null },
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), lastSeenAt: null, lastHealth: null });
      const p = await probeWorker(store.getWorker(`w-${port}`)!, store.getSettings());
      expect(p.derived.installGate, `gate=${c.gate}`).toBe(c.wantGate);
      expect(p.derived.acceptingTasks, `gate=${c.gate}`).toBe(c.wantAccept);
      store.close();
    }
  });

  it('managed worker: observed providerBundle wins over config; mismatch is surfaced', async () => {
    const fake = createServer((req, res) => {
      if (req.url === '/health/live') { res.writeHead(200); res.end('{}'); return; }
      if (req.url === '/readyz') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ready: true, workerId: 'w-m', instanceId: 'i-1',
          draining: false, installGate: 'disarmed', attemptId: '', providerBundle: 'provider-bundle=fixture' }));
        return;
      }
      res.writeHead(404); res.end();
    });
    const port = await listen(fake);
    const root = tmp(); dirs.push(root);
    const store = track(new Store(root));
    const w = fixtureWorker(store, 'mismatched');
    const cfg = w.config as ManagedConfig;
    cfg.ports.health = port;
    cfg.provider = 'agentcode';           // config claims agentcode…
    store.updateWorker(w.workerKey, { config: cfg });

    const p = await probeWorker(store.getWorker('mismatched')!, store.getSettings());
    const engine = p.health.layers.find(l => l.layer === 'ENGINE')!;
    expect(engine.state).toBe('DEGRADED');
    expect(engine.summary).toContain('不一致');
    expect(p.derived.provider).toBe('fixture');   // …but the daemon reports fixture — observed wins
    store.close();
  });
});

// ------------------------------------------------------------- ownership

describe('ownership', () => {
  it('foreign pid → verified=false, never killed', async () => {
    const child = spawn(process.execPath, ['-e', 'setTimeout(()=>{},30000)'], { windowsHide: true });
    children.push(child.pid!);
    const v = await verifyOwnership(child.pid!, [join(tmp(), 'nowhere')]);
    expect(v.alive).toBe(true);
    expect(v.verified).toBe(false);
    expect(pidAlive(child.pid!)).toBe(true);   // still alive — nothing was killed
  });
});

// -------------------------------------------------------------- lifecycle

describe('lifecycle on stub daemon', () => {
  it('START → probe → GATE arm/disarm → STOP → RESTART roundtrip', async () => {
    const root = tmp(); dirs.push(root);
    const stub = join(root, 'fake-daemon.mjs');
    writeFileSync(stub, STUB);
    const h = manage({ root, dist: join(root, 'no-dist'),
      lifecycleDeps: { planSpawn: stubPlan(stub), liveBudgetMs: 6000, readyBudgetMs: 6000, stopWaitMs: 4000 } });
    await h.ready;
    const port = await listen(h.server);
    try {
      const reg = await call(port, 'POST', '/api/manage/workers/register',
        { body: { kind: 'MANAGED', name: 'demo', workerId: 'w-demo', provider: 'fixture' } });
      expect(reg.status).toBe(201);
      const key = reg.json.workerKey;

      // START
      const s = await call(port, 'POST', `/api/manage/workers/${key}/operations`, { body: { operationId: 'op-start', kind: 'START' } });
      expect(s.status).toBe(201);
      const sop = await waitOp(h, 'op-start');
      expect(sop?.state).toBe('SUCCEEDED');
      const w = h.store.getWorker(key)!;
      const cfg = w.config as ManagedConfig;
      children.push(cfg.pid.daemon!);
      expect(pidAlive(cfg.pid.daemon!)).toBe(true);
      expect(existsSync(cfg.configFile!)).toBe(true);
      const props = readFileSync(cfg.configFile!, 'utf8');
      expect(props).toContain('worker.id=w-demo');
      expect(props).toContain('install.gate=');
      expect(props).not.toContain('TOKEN');   // secrets never in the file

      // fresh check → daemon OK, accepting YES
      const chk = await call(port, 'POST', `/api/manage/workers/${key}/check`, { body: {} });
      expect(chk.status).toBe(200);
      expect(chk.json.layers.find((l: any) => l.layer === 'DAEMON').state).toBe('OK');
      const det = await call(port, 'GET', `/api/manage/workers/${key}`);
      expect(det.json.acceptingTasks).toBe('YES');
      expect(det.json.daemonReady).toBe(true);
      expect(det.json.ownership.verified).toBe(true);
      expect(det.json.control.kind).toBe('NONE');   // stub plan has no demo plane
      expect(JSON.stringify(det.json.config)).not.toContain(cfg.controlToken ?? 'none');

      // GATE_ARM → file + readyz reflects
      const ga = await call(port, 'POST', `/api/manage/workers/${key}/operations`, { body: { operationId: 'op-arm', kind: 'GATE_ARM' } });
      expect(ga.status).toBe(201);
      expect((await waitOp(h, 'op-arm'))?.state).toBe('SUCCEEDED');
      const gate = JSON.parse(readFileSync(gateFileOf(h.store.getWorker(key)!.config as ManagedConfig), 'utf8'));
      expect(gate).toMatchObject({ schemaVersion: 'install-gate/1.0', state: 'ARMED', operationId: 'op-arm' });
      expect(typeof gate.gateId).toBe('string');
      // daemon-side parse shape: anything but DISARMED → armed
      expect(String(gate.state).toUpperCase() === 'DISARMED').toBe(false);
      const det2 = await call(port, 'GET', `/api/manage/workers/${key}`);
      expect(det2.json.installGate).toBe('ARMED');
      expect(det2.json.acceptingTasks).toBe('NO_GATE');

      // GATE_DISARM → file stays for audit, state flips
      await call(port, 'POST', `/api/manage/workers/${key}/operations`, { body: { operationId: 'op-disarm', kind: 'GATE_DISARM' } });
      expect((await waitOp(h, 'op-disarm'))?.state).toBe('SUCCEEDED');
      const gate2 = JSON.parse(readFileSync(gateFileOf(h.store.getWorker(key)!.config as ManagedConfig), 'utf8'));
      expect(gate2.state).toBe('DISARMED');
      expect(existsSync(gateFileOf(h.store.getWorker(key)!.config as ManagedConfig))).toBe(true);

      // idempotent replay — same operationId returns the existing record
      const again = await call(port, 'POST', `/api/manage/workers/${key}/operations`, { body: { operationId: 'op-disarm', kind: 'GATE_DISARM' } });
      expect(again.status).toBe(200);
      expect(again.json.operationId).toBe('op-disarm');
      const ops = await call(port, 'GET', '/api/manage/operations?limit=50');
      expect(ops.json.filter((o: any) => o.operationId === 'op-disarm')).toHaveLength(1);

      // RESTART → new pid
      const oldPid = (h.store.getWorker(key)!.config as ManagedConfig).pid.daemon!;
      const rs = await call(port, 'POST', `/api/manage/workers/${key}/operations`, { body: { operationId: 'op-restart', kind: 'RESTART' } });
      expect(rs.status).toBe(201);
      expect((await waitOp(h, 'op-restart'))?.state).toBe('SUCCEEDED');
      const newPid = (h.store.getWorker(key)!.config as ManagedConfig).pid.daemon!;
      children.push(newPid);
      expect(newPid).not.toBe(oldPid);
      expect(pidAlive(newPid)).toBe(true);
      expect(pidAlive(oldPid)).toBe(false);

      // STOP → pid dead, gate file persists
      await call(port, 'POST', `/api/manage/workers/${key}/operations`, { body: { operationId: 'op-stop', kind: 'STOP' } });
      expect((await waitOp(h, 'op-stop'))?.state).toBe('SUCCEEDED');
      expect(pidAlive(newPid)).toBe(false);
    } finally {
      await h.lifecycle.stopChildren();
      h.store.close();
    }
  }, 60_000);

  it('START with an unspawnable command → FAILED START_FAILED, server stays up', async () => {
    const root = tmp(); dirs.push(root);
    const h = manage({ root, dist: root, lifecycleDeps: {
      planSpawn: () => [{ role: 'daemon', command: 'definitely-not-a-real-binary-xyz-9', args: [] }],
      liveBudgetMs: 500,
    } });
    await h.ready;
    const port = await listen(h.server);
    try {
      const w = fixtureWorker(h.store);
      const op = { operationId: 'op-nospawn', workerKey: w.workerKey, kind: 'START' as const, state: 'PENDING' as const,
        steps: [], error: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
      h.store.createOperation(op);
      h.lifecycle.startOperation(op);
      const done = await waitOp(h, 'op-nospawn');
      expect(done?.state).toBe('FAILED');
      expect(done?.error?.code).toBe('START_FAILED');
      // the console process itself survived — it still serves requests
      expect((await call(port, 'GET', '/api/manage/meta')).status).toBe(200);
    } finally {
      h.store.close();
    }
  }, 30_000);

  it('START when daemon already alive → skips spawn but still proves readyz', async () => {
    const root = tmp(); dirs.push(root);
    const stub = join(root, 'fake-daemon.mjs');
    writeFileSync(stub, STUB);
    const h = manage({ root, dist: join(root, 'no-dist'),
      lifecycleDeps: { planSpawn: stubPlan(stub), liveBudgetMs: 6000, readyBudgetMs: 6000, stopWaitMs: 4000 } });
    await h.ready;
    const port = await listen(h.server);
    try {
      await call(port, 'POST', '/api/manage/workers/register', { body: { kind: 'MANAGED', name: 'demo', workerId: 'w-demo' } });
      await call(port, 'POST', '/api/manage/workers/demo/operations', { body: { operationId: 'op-s1', kind: 'START' } });
      expect((await waitOp(h, 'op-s1'))?.state).toBe('SUCCEEDED');
      const pid1 = (h.store.getWorker('demo')!.config as ManagedConfig).pid.daemon!;
      children.push(pid1);
      // second START — daemon already ours and alive: no new spawn, but readyz must pass
      await call(port, 'POST', '/api/manage/workers/demo/operations', { body: { operationId: 'op-s2', kind: 'START' } });
      const op2 = await waitOp(h, 'op-s2');
      expect(op2?.state).toBe('SUCCEEDED');
      expect(op2?.steps.map(s => s.message).join()).toContain('跳过拉起');
      expect((h.store.getWorker('demo')!.config as ManagedConfig).pid.daemon).toBe(pid1);
    } finally {
      await h.lifecycle.stopChildren();
      h.store.close();
    }
  }, 30_000);

  it('STOP on foreign pid → FAILED NOT_OWNED, process untouched', async () => {
    const root = tmp(); dirs.push(root);
    const stub = join(root, 'fake-daemon.mjs');
    writeFileSync(stub, STUB);
    const h = manage({ root, dist: root,
      lifecycleDeps: { planSpawn: stubPlan(stub), stopWaitMs: 2000 } });
    await h.ready;
    const foreign = spawn(process.execPath, ['-e', 'setTimeout(()=>{},30000)'], { windowsHide: true });
    children.push(foreign.pid!);
    try {
      const w = fixtureWorker(h.store);
      const cfg = w.config as ManagedConfig;
      cfg.pid.daemon = foreign.pid!; cfg.startedAt = new Date().toISOString();
      h.store.updateWorker(w.workerKey, { config: cfg });
      const op = { operationId: 'op-stop-foreign', workerKey: 'demo', kind: 'STOP' as const, state: 'PENDING' as const,
        steps: [], error: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
      h.store.createOperation(op);
      h.lifecycle.startOperation(op);
      const done = await waitOp(h, 'op-stop-foreign');
      expect(done?.state).toBe('FAILED');
      expect(done?.error?.code).toBe('NOT_OWNED');
      expect(pidAlive(foreign.pid!)).toBe(true);   // foreign process survived
    } finally {
      await h.lifecycle.stopChildren();
      h.store.close();
    }
  }, 30_000);
});

// ------------------------------------------------------------- reconcile

describe('reconcile', () => {
  it('PENDING STOP with dead pid → SUCCEEDED on boot', async () => {
    const root = tmp(); dirs.push(root);
    const store = track(new Store(root));
    const w = fixtureWorker(store);
    const dead = spawn(process.execPath, ['-e', 'process.exit(0)']);
    await new Promise(r => dead.on('exit', r));
    const cfg = w.config as ManagedConfig;
    cfg.pid.daemon = dead.pid!; cfg.startedAt = new Date().toISOString();
    store.updateWorker('demo', { config: cfg });
    store.createOperation({ operationId: 'op-orphan', workerKey: 'demo', kind: 'STOP', state: 'PENDING',
      steps: [], error: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    const lc = new Lifecycle(store);
    await lc.reconcile();
    const op = store.getOperation('op-orphan')!;
    expect(op.state).toBe('SUCCEEDED');
    expect(op.steps.map(s => s.message).join()).toContain('进程已退出');
    store.close();
  });
});

// ------------------------------------------------------------- http api

describe('api', () => {
  it('POST without x-manage-control → 403; bad host → 403; non-loopback healthUrl → 400', async () => {
    const root = tmp(); dirs.push(root);
    const h = manage({ root, dist: root });
    await h.ready;
    const port = await listen(h.server);
    try {
      const noHeader = await fetch(`http://127.0.0.1:${port}/api/manage/workers/register`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      expect(noHeader.status).toBe(403);
      expect((await noHeader.json()).code).toBe('ORIGIN_REJECTED');

      const badHost = await call(port, 'POST', '/api/manage/workers/register', {
        headers: { host: 'evil.example:1' }, body: { kind: 'EXTERNAL', name: 'x', healthUrl: 'http://127.0.0.1:9' } });
      expect(badHost.status).toBe(403);
      expect(badHost.json.code).toBe('HOST_REJECTED');

      const badUrl = await call(port, 'POST', '/api/manage/workers/register',
        { body: { kind: 'EXTERNAL', name: 'x', healthUrl: 'http://192.168.1.10:8080' } });
      expect(badUrl.status).toBe(400);

      const ok = await call(port, 'POST', '/api/manage/workers/register',
        { body: { kind: 'EXTERNAL', name: 'ext', healthUrl: 'http://127.0.0.1:9' } });
      expect(ok.status).toBe(201);
      expect(ok.json.capabilities).not.toContain('LIFECYCLE');

      // EXTERNAL + lifecycle op → 409 NOT_MANAGED
      const op = await call(port, 'POST', '/api/manage/workers/ext/operations', { body: { operationId: 'op-x', kind: 'STOP' } });
      expect(op.status).toBe(409);
      expect(op.json.code).toBe('NOT_MANAGED');

      // meta + overview + workers + settings endpoints answer
      expect((await call(port, 'GET', '/api/manage/meta')).json.apiVersion).toBe('manage/1');
      expect((await call(port, 'GET', '/api/manage/overview')).json.workers).toHaveLength(1);
      expect((await call(port, 'GET', '/api/manage/workers')).json).toHaveLength(1);
      expect((await call(port, 'GET', '/api/manage/workers/nope')).status).toBe(404);

      const put = await call(port, 'PUT', '/api/manage/settings', { body: {
        releaseRoot: 'D:/rel', defaultProvider: 'fixture',
        acsConnections: [{ name: 'acs', baseUrl: 'http://127.0.0.1:8787', tokenEnv: 'ACS_TOKEN' }],
        obsApiUrl: 'http://127.0.0.1:8788' } });
      expect(put.status).toBe(200);
      expect(put.json.acsConnections[0].tokenEnv).toBe('ACS_TOKEN');
      const badPut = await call(port, 'PUT', '/api/manage/settings', { body: {
        releaseRoot: null, defaultProvider: 'fixture',
        acsConnections: [{ name: 'acs', baseUrl: 'https://remote.example', tokenEnv: 'X' }], obsApiUrl: null } });
      expect(badPut.status).toBe(400);

      // check-install honest findings on a bogus root
      const ci = await call(port, 'POST', '/api/manage/settings/check-install', { body: { releaseRoot: 'D:/no-such-dir-xyz' } });
      expect(ci.status).toBe(200);
      expect(ci.json.ok).toBe(false);
      expect(ci.json.findings.some((f: any) => f.item === 'java')).toBe(true);

      // diagnostics export never carries the control token
      const diag = await call(port, 'GET', '/api/manage/diagnostics/export');
      expect(diag.status).toBe(200);
      expect(diag.json.meta.stateRoot).toBe(root);
      expect(diag.json.settings.acsConnections[0]).toEqual({ name: 'acs', baseUrl: 'http://127.0.0.1:8787', tokenEnv: 'ACS_TOKEN' });
    } finally {
      h.store.close();
    }
  }, 30_000);

  it('JSON with charset accepted; ?workerKey filters operations', async () => {
    const root = tmp(); dirs.push(root);
    const h = manage({ root, dist: root });
    await h.ready;
    const port = await listen(h.server);
    try {
      // content-type with parameters is legal JSON
      const res = await new Promise<{ status: number }>((resolvePromise, reject) => {
        const req = request({ host: '127.0.0.1', port, method: 'POST', path: '/api/manage/settings/check-install',
          headers: { 'content-type': 'application/json; charset=utf-8', 'x-manage-control': '1' } }, r => {
          r.resume(); r.on('end', () => resolvePromise({ status: r.statusCode! }));
        });
        req.on('error', reject);
        req.end('{"releaseRoot":null}');
      });
      expect(res.status).toBe(200);

      await call(port, 'POST', '/api/manage/workers/register', { body: { kind: 'EXTERNAL', name: 'a', healthUrl: 'http://127.0.0.1:9' } });
      await call(port, 'POST', '/api/manage/workers/register', { body: { kind: 'EXTERNAL', name: 'b', healthUrl: 'http://127.0.0.1:9' } });
      h.store.createOperation({ operationId: 'op-a', workerKey: 'a', kind: 'STOP', state: 'SUCCEEDED',
        steps: [], error: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
      h.store.createOperation({ operationId: 'op-b', workerKey: 'b', kind: 'STOP', state: 'FAILED',
        steps: [], error: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
      const filtered = await call(port, 'GET', '/api/manage/operations?workerKey=a');
      expect(filtered.json.map((o: any) => o.operationId)).toEqual(['op-a']);
      const bad = await call(port, 'GET', '/api/manage/operations?workerKey=../x');
      expect(bad.status).toBe(400);
      const all = await call(port, 'GET', '/api/manage/operations');
      expect(all.json).toHaveLength(2);
    } finally { h.store.close(); }
  });

  it('GET /api/v2/* proxies to the observation API', async () => {
    const obs = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ proxied: req.url }));
    });
    const obsPort = await listen(obs);
    const root = tmp(); dirs.push(root);
    const h = manage({ root, dist: root, obsApiUrl: `http://127.0.0.1:${obsPort}` });
    await h.ready;
    const port = await listen(h.server);
    try {
      const r = await call(port, 'GET', '/api/v2/sessions?limit=1');
      expect(r.status).toBe(200);
      expect(r.json.proxied).toBe('/api/v2/sessions?limit=1');
    } finally { h.store.close(); }
  });

  it('static: serves existing files, index.html fallback for SPA routes, 404 for missing assets', async () => {
    const root = tmp(); const dist = join(root, 'dist');
    dirs.push(root); mkdirSync(dist, { recursive: true });
    writeFileSync(join(dist, 'index.html'), '<html>spa</html>');
    writeFileSync(join(dist, 'app.js'), 'console.log(1)');
    const h = manage({ root, dist });
    await h.ready;
    const port = await listen(h.server);
    try {
      const js = await call(port, 'GET', '/app.js');
      expect(js.status).toBe(200);
      expect(js.headers['content-type']).toContain('javascript');
      const spa = await call(port, 'GET', '/manage/workers/abc');
      expect(spa.status).toBe(200);
      expect(spa.text).toContain('spa');
      const missing = await call(port, 'GET', '/missing.js');
      expect(missing.status).toBe(404);
      const traversal = await call(port, 'GET', '/%2e%2e/management.db');
      expect(traversal.status).toBe(404);
    } finally { h.store.close(); }
  });
});

// ---------------------------------------------------------- install check

describe('check-install', () => {
  it('validates release root layout', async () => {
    const root = tmp(); dirs.push(root);
    const rel = join(root, 'rel');
    const lib = join(rel, 'distribution', 'worker', 'agent-worker-local-1.0', 'lib');
    mkdirSync(lib, { recursive: true });
    writeFileSync(join(lib, 'a.jar'), 'x');
    writeFileSync(join(rel, 'distribution', 'worker', 'agent-worker-local-1.0', 'manifest.json'), '{"version":"1.0"}');
    const tk = join(rel, 'worker', 'worker-testkit', 'target');
    mkdirSync(tk, { recursive: true });
    writeFileSync(join(tk, 'worker-testkit-1.0.jar'), 'x');
    const r = await checkInstall(rel);
    expect(r.findings.find(f => f.item === 'worker dist lib')?.ok).toBe(true);
    expect(r.findings.find(f => f.item === 'worker manifest')?.ok).toBe(true);
    expect(r.findings.find(f => f.item === 'worker-testkit jar')?.ok).toBe(true);
    const bad = await checkInstall(join(root, 'empty'));
    expect(bad.ok).toBe(false);
  });
});
