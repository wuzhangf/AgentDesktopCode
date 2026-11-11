/**
 * Managed lifecycle: install check, java spawn plan, START/STOP/RESTART and
 * the install gate (ARM/DISARM), plus boot-time reconcile of interrupted ops.
 *
 * DRAINING is a one-way latch in the daemon — there is deliberately no
 * 'resume' op; GATE_ARM/GATE_DISARM is the reversible admission path.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ConsoleSettings, InstallCheck } from '../../shared/management/api';
import type { ManagedConfig, OperationRow, Store, WorkerRow } from './store';
import { gateFileOf } from './probe';
import { freePort, httpGet, httpJson, pidAlive, run, sleep, terminatePid, verifyOwnership, waitFor } from './sys';

export class OpError extends Error {
  constructor(public code: string, message: string) { super(message); }
}
/** Sentinel: op already finished with a terminal state inside the phase. */
class OpDone extends Error {}

export interface SpawnSpec {
  role: 'control' | 'daemon';
  command: string; args: string[];
  env?: Record<string, string>; cwd?: string;
}
export interface LifecycleDeps {
  /** Test/injection seam: replaces the java release spawn plan. */
  planSpawn?: (w: WorkerRow, settings: ConsoleSettings) => SpawnSpec[];
  readyBudgetMs?: number;    // readyz wait after daemon spawn (default 20s)
  controlBudgetMs?: number;  // demo plane /health/live wait (default 15s)
  liveBudgetMs?: number;     // daemon /health/live wait (default 10s)
  stopWaitMs?: number;       // graceful-kill wait before taskkill /F (default drain+10s)
}

const fwd = (p: string) => p.replace(/\\/g, '/');   // java Properties: '\' is an escape
const now = () => new Date().toISOString();

// ----------------------------------------------------------- install check

export async function checkInstall(releaseRoot: string | null): Promise<InstallCheck> {
  const findings: InstallCheck['findings'] = [];
  const push = (item: string, ok: boolean, detail: string) => findings.push({ item, ok, detail });
  const rootOk = !!releaseRoot && existsSync(releaseRoot);
  push('releaseRoot', rootOk, releaseRoot ? (rootOk ? releaseRoot : '目录不存在') : '未配置 releaseRoot');
  let release: ResolvedRelease | null = null;
  if (rootOk) {
    try { release = resolveRelease(releaseRoot!); } catch { release = null; }
  }
  const libs = rootOk ? findLibs(releaseRoot!) : [];
  push('worker dist lib', libs.length > 0,
    libs.length ? `${libs[0].dir}（${libs[0].jars.length} 个 jar）` : '缺少 distribution/worker/agent-worker-local-*/lib/*.jar');
  push('worker manifest', libs.some(l => l.manifest),
    libs.length ? (libs.some(l => l.manifest) ? 'manifest.json 存在' : 'manifest.json 缺失') : '无 agent-worker-local-* 目录');
  const testkit = rootOk ? findTestkit(releaseRoot!) : null;
  push('worker-testkit jar', testkit != null, testkit ?? '缺少 worker/worker-testkit/target/worker-testkit-*.jar');
  const java = await run('java', ['-version'], 5000);
  push('java', java.code === 0, java.code === 0
    ? (java.stderr.split('\n')[0] || java.stdout.split('\n')[0] || 'java -version OK').trim()
    : 'java 不在 PATH');
  return { ok: findings.every(f => f.ok), checkedAt: now(), releaseRoot, findings };
}

interface ResolvedRelease { libDir: string; jars: string[]; manifest: boolean; testkitJar: string }
function findLibs(root: string): { dir: string; jars: string[]; manifest: boolean }[] {
  const parent = join(root, 'distribution', 'worker');
  if (!existsSync(parent)) return [];
  const out = [];
  for (const d of readdirSync(parent).filter(n => n.startsWith('agent-worker-local-')).sort()) {
    const lib = join(parent, d, 'lib');
    const jars = existsSync(lib) ? readdirSync(lib).filter(f => f.endsWith('.jar')).map(f => join(lib, f)) : [];
    if (jars.length) out.push({ dir: lib, jars, manifest: existsSync(join(parent, d, 'manifest.json')) });
  }
  return out;
}
function findTestkit(root: string): string | null {
  const target = join(root, 'worker', 'worker-testkit', 'target');
  if (!existsSync(target)) return null;
  const jar = readdirSync(target).filter(f => /^worker-testkit-.*\.jar$/.test(f)).sort().pop();
  return jar ? join(target, jar) : null;
}
function resolveRelease(root: string): ResolvedRelease {
  const lib = findLibs(root)[0];
  if (!lib) throw new OpError('RELEASE_MISSING', 'releaseRoot 内未找到 distribution/worker/agent-worker-local-*/lib/*.jar');
  const testkitJar = findTestkit(root);
  if (!testkitJar) throw new OpError('RELEASE_MISSING', 'releaseRoot 内未找到 worker-testkit jar');
  return { libDir: lib.dir, jars: lib.jars, manifest: lib.manifest, testkitJar };
}

/** One classpath serves both mains — DemoControlMain lives in the testkit jar. */
function javaPlan(w: WorkerRow, settings: ConsoleSettings): SpawnSpec[] {
  const cfg = w.config as ManagedConfig;
  const root = cfg.releaseRoot ?? settings.releaseRoot;
  if (!root) throw new OpError('NO_RELEASE_ROOT', '未配置 releaseRoot（settings 或 worker 注册信息）');
  const release = resolveRelease(root);
  const cp = [...release.jars, release.testkitJar].join(';');
  return [
    { role: 'control', command: 'java',
      args: ['-cp', cp, 'com.sage.agentworker.testkit.control.DemoControlMain', String(cfg.ports.control), cfg.dirs.control],
      env: { CONTROL_WORKER_TOKEN: cfg.controlToken!, CONTROL_HOST: '127.0.0.1',
        CONTROL_RUNTIME_URL: `http://127.0.0.1:${cfg.ports.health}`, CONTROL_EXPORT_DIR: join(cfg.dirs.control, 'export') } },
    { role: 'daemon', command: 'java',
      args: ['-cp', cp, 'com.sage.agentworker.daemon.WorkerDaemonMain', '--config', cfg.configFile!],
      env: { WORKER_TOKEN: cfg.controlToken! } },
  ];
}

// ---------------------------------------------------------------- lifecycle

export class Lifecycle {
  /** live children spawned by THIS console process (bookkeeping — they outlive us). */
  readonly children = new Map<number, { child: ChildProcess; workerKey: string; role: string }>();
  private inflight = new Map<string, Promise<void>>();
  constructor(private store: Store, private deps: LifecycleDeps = {}) {}

  waitOperation(operationId: string): Promise<void> {
    return this.inflight.get(operationId) ?? Promise.resolve();
  }

  /** Dispatch an already-persisted PENDING op; returns immediately. */
  startOperation(op: OperationRow) {
    const done = this.execute(op).catch(() => {});
    this.inflight.set(op.operationId, done);
    void done.finally(() => this.inflight.delete(op.operationId));
  }

  private async execute(op: OperationRow) {
    const step = (m: string) => this.store.appendStep(op.operationId, m);
    this.store.setOperationState(op.operationId, 'RUNNING');
    step(`开始执行 ${op.kind}`);
    try {
      const worker = this.store.getWorker(op.workerKey);
      if (!worker) throw new OpError('NOT_FOUND', 'worker 记录不存在');
      if (worker.kind !== 'MANAGED') throw new OpError('NOT_MANAGED', '外部 worker 不受本机生命周期管理');
      switch (op.kind) {
        case 'START': await this.startPhase(worker, op.operationId); break;
        case 'STOP': await this.stopPhase(worker, op.operationId); break;
        case 'RESTART': await this.stopPhase(worker, op.operationId); await this.startPhase(worker, op.operationId); break;
        case 'GATE_ARM': await this.gatePhase(worker, op.operationId, 'ARMED'); break;
        case 'GATE_DISARM': await this.gatePhase(worker, op.operationId, 'DISARMED'); break;
      }
      this.store.finishOperation(op.operationId, 'SUCCEEDED');
      step(`${op.kind} 完成`);
    } catch (e: any) {
      if (e instanceof OpDone) return;
      const code = e instanceof OpError ? e.code : 'OP_FAILED';
      step(`失败：${e?.message ?? e}`);
      this.store.finishOperation(op.operationId, 'FAILED', { code, message: String(e?.message ?? e) });
    } finally {
      this.invalidateHealth(op.workerKey);   // any outcome may have changed real state
    }
  }

  /** Expire the stored snapshot so the next GET detail re-probes. */
  private invalidateHealth(workerKey: string) {
    const w = this.store.getWorker(workerKey);
    if (w?.lastHealth) {
      this.store.updateWorker(workerKey, { lastHealth: { ...w.lastHealth, checkedAt: new Date(0).toISOString() } });
    }
  }

  // ---- phases ------------------------------------------------------------

  private async startPhase(worker: WorkerRow, opId: string) {
    const cfg = worker.config as ManagedConfig;
    const step = (m: string) => this.store.appendStep(opId, m);
    const markers = { daemon: [cfg.configFile, cfg.dirs.state], control: [cfg.dirs.control] };
    // Every recorded pid must be either dead or ours before we touch anything.
    const owned = { daemon: false, control: false };
    for (const role of ['daemon', 'control'] as const) {
      const pid = cfg.pid[role];
      if (pid == null) continue;
      const v = await verifyOwnership(pid, markers[role]);
      if (v.alive && !v.verified) {
        throw new OpError('WORKER_BUSY', `记录的 ${role} pid=${pid} 存活但命令行不匹配——拒绝触碰外部进程`);
      }
      if (v.alive) owned[role] = true; else cfg.pid[role] = null;
    }

    if (owned.daemon) {
      step(`daemon 已在运行 pid=${cfg.pid.daemon}，跳过拉起`);
      // Companion control plane died while daemon lived? Respawn it on the
      // recorded port — the daemon's control.url already points there.
      const specs = (this.deps.planSpawn ?? javaPlan)(worker, this.store.getSettings());
      const controlSpec = specs.find(s => s.role === 'control');
      if (controlSpec && cfg.pid.control == null && cfg.ports.control != null) {
        const pid = this.spawnChild(worker.workerKey, controlSpec, cfg);
        cfg.pid.control = pid;
        this.store.updateWorker(worker.workerKey, { config: cfg });
        const live = await waitFor(
          () => httpGet(`http://127.0.0.1:${cfg.ports.control}/health/live`).then(r => r.status === 200).catch(() => false),
          this.deps.controlBudgetMs ?? 15_000, 300);
        if (!live) throw new OpError('START_FAILED', `control 进程已拉起但未在预算内应答 health/live`);
        step(`control 进程补齐 pid=${pid} :${cfg.ports.control}`);
      }
      await this.requireReady(cfg, opId, step);
      return;
    }

    // Daemon dead but our control plane survived (e.g. crash mid-STOP) — it is
    // stale (daemon will get a fresh port): force it down before the restart.
    if (cfg.pid.control != null) {
      step(`清理残留的 control 进程 pid=${cfg.pid.control}`);
      await this.killChild(cfg.pid.control);
      cfg.pid.control = null;
    }

    for (const d of Object.values(cfg.dirs)) mkdirSync(d, { recursive: true });
    cfg.ports.control = await freePort();
    do { cfg.ports.health = await freePort(); } while (cfg.ports.health === cfg.ports.control);
    cfg.controlToken = randomUUID();          // per-boot demo-plane credential
    cfg.configFile = cfg.configFile ?? join(cfg.dirs.root, 'worker.properties');
    const settings = this.store.getSettings();
    const specs = (this.deps.planSpawn ?? javaPlan)(worker, settings);
    if (specs.some(s => s.role === 'daemon')) writeProperties(cfg);
    cfg.controlPlane = specs.some(s => s.role === 'control') ? 'LOCAL_DEMO_PLANE' : 'NONE';
    cfg.startedAt = now();
    this.store.updateWorker(worker.workerKey, { config: cfg });

    const spawned: number[] = [];
    try {
      for (const spec of specs) {
        const port = spec.role === 'control' ? cfg.ports.control : cfg.ports.health;
        const pid = this.spawnChild(worker.workerKey, spec, cfg);
        spawned.push(pid);
        if (spec.role === 'control') cfg.pid.control = pid; else cfg.pid.daemon = pid;
        this.store.updateWorker(worker.workerKey, { config: cfg });
        const base = `http://127.0.0.1:${port}`;
        const liveBudget = spec.role === 'control' ? (this.deps.controlBudgetMs ?? 15_000) : (this.deps.liveBudgetMs ?? 10_000);
        const live = await waitFor(() => httpGet(`${base}/health/live`).then(r => r.status === 200).catch(() => false), liveBudget, 300);
        if (!live) throw new OpError('START_FAILED', `${spec.role} 进程已拉起但未在 ${liveBudget}ms 内应答 health/live`);
        step(`${spec.role} 进程存活 pid=${pid} :${port}`);
        if (spec.role === 'daemon') await this.requireReady(cfg, opId, step);
      }
    } catch (e) {
      // Partial start — do not leave half a plane running under our watch.
      if (!(e instanceof OpDone)) for (const pid of spawned) {
        await this.killChild(pid);
        if (cfg.pid.control === pid) cfg.pid.control = null;
        if (cfg.pid.daemon === pid) cfg.pid.daemon = null;
      }
      if (spawned.length) this.store.updateWorker(worker.workerKey, { config: cfg });
      throw e;
    }
  }

  /** Prove the daemon is actually ready — live-only is not enough. */
  private async requireReady(cfg: ManagedConfig, opId: string, step: (m: string) => void) {
    const port = cfg.ports.health;
    const ready = port != null && await waitFor(
      () => httpJson(`http://127.0.0.1:${port}/readyz`, { timeoutMs: 1500 }).then(r => r.json?.ready === true).catch(() => false),
      this.deps.readyBudgetMs ?? 20_000, 500);
    if (!ready) {
      step('进程存活但 readyz 未就绪——验证失败');
      this.store.finishOperation(opId, 'VERIFY_FAILED', { code: 'NOT_READY', message: 'daemon live 但 readyz 未在预算内就绪' });
      throw new OpDone();
    }
    step('readyz 就绪');
  }

  private async stopPhase(worker: WorkerRow, opId: string) {
    const cfg = worker.config as ManagedConfig;
    const step = (m: string) => this.store.appendStep(opId, m);
    const waitMs = this.deps.stopWaitMs ?? cfg.drainTimeoutMillis + 10_000;
    const markers = { daemon: [cfg.configFile, cfg.dirs.state], control: [cfg.dirs.control] };
    for (const role of ['daemon', 'control'] as const) {
      const pid = cfg.pid[role];
      if (pid == null) continue;
      const v = await verifyOwnership(pid, markers[role]);
      if (!v.alive) { step(`${role} pid=${pid} 已退出`); continue; }
      if (!v.verified) throw new OpError('NOT_OWNED', `${role} pid=${pid} 存活但命令行不匹配——拒绝结束外部进程`);
      await terminatePid(pid);
      const gone = await waitFor(() => !pidAlive(pid), waitMs, 300);
      if (gone) { step(`${role} pid=${pid} 已退出（优雅停止 GRACEFUL）`); continue; }
      await terminatePid(pid, { tree: true, force: true });
      await waitFor(() => !pidAlive(pid), 3000, 200);
      step(`${role} pid=${pid} 强制结束（FORCED）`);
    }
    cfg.pid.daemon = null; cfg.pid.control = null; cfg.startedAt = null;
    this.store.updateWorker(worker.workerKey, { config: cfg });
  }

  /** R14 gate file — daemon re-reads it on every startTask; absent = open. */
  private async gatePhase(worker: WorkerRow, opId: string, state: 'ARMED' | 'DISARMED') {
    const cfg = worker.config as ManagedConfig;
    const step = (m: string) => this.store.appendStep(opId, m);
    const file = gateFileOf(cfg);
    mkdirSync(dirname(file), { recursive: true });
    const doc: Record<string, unknown> = { schemaVersion: 'install-gate/1.0', gateId: `gate-${randomUUID()}`,
      state, operationId: opId, reason: state === 'ARMED' ? 'console gate arm' : 'console gate disarm', armedAt: now() };
    if (state === 'DISARMED') { doc.disarmedAt = now(); }
    writeFileSync(file, JSON.stringify(doc, null, 2));
    const parsed = JSON.parse(readFileSync(file, 'utf8'));   // re-read what the daemon would see
    if (parsed.state !== state) throw new OpError('GATE_WRITE_FAILED', 'install-gate.json 回读不一致');
    step(`install-gate.json 已写入 state=${state}`);
    const port = cfg.ports.health;
    if (port != null && pidAlive(cfg.pid.daemon ?? -1)) {
      const rz = await httpJson(`http://127.0.0.1:${port}/readyz`, { timeoutMs: 1500 }).catch(() => null);
      if (rz?.json?.installGate != null) step(`readyz installGate=${rz.json.installGate}`);
    }
  }

  // ---- spawn / kill -------------------------------------------------------

  private spawnChild(workerKey: string, spec: SpawnSpec, cfg: ManagedConfig): number {
    // detached + fd-owned logs: managed workers must survive console restart/crash;
    // next boot re-adopts them via persisted pid + command-line ownership check.
    const fd = openSync(join(cfg.dirs.logs, `${spec.role}.log`), 'a');
    let child: ChildProcess;
    try {
      child = spawn(spec.command, spec.args, {
        env: { ...process.env, ...spec.env }, cwd: spec.cwd ?? cfg.dirs.root,
        windowsHide: true, detached: true, stdio: ['ignore', fd, fd],
      });
    } catch (e) { closeSync(fd); throw e; }
    child.unref();
    // A failed spawn (command not on PATH) emits 'error' async — swallow it here;
    // the liveness wait below reports START_FAILED honestly either way.
    child.on('error', () => {});
    const pid = child.pid;
    if (pid == null) {
      closeSync(fd);
      throw new OpError('START_FAILED', `无法启动 ${spec.command}（命令不存在或不可执行）`);
    }
    closeSync(fd);   // the child inherited its own handle — keeping ours leaks an fd per start
    this.children.set(pid, { child, workerKey, role: spec.role });
    child.on('exit', () => this.children.delete(pid));
    return pid;
  }

  private async killChild(pid: number | null) {
    if (pid == null || !pidAlive(pid)) return;
    await terminatePid(pid, { tree: true, force: true });
  }

  /** Explicit teardown helper (tests) — console shutdown deliberately leaves workers running. */
  async stopChildren() {
    for (const pid of [...this.children.keys()]) await terminatePid(pid, { tree: true });
    const deadline = Date.now() + 5000;
    while (this.children.size && Date.now() < deadline) await sleep(200);
    for (const pid of [...this.children.keys()]) await terminatePid(pid, { tree: true, force: true });
  }

  // ---- boot reconcile ------------------------------------------------------

  /** 原操作恢复: ops left PENDING/RUNNING at boot get their real outcome verified. */
  async reconcile() {
    for (const w of this.store.listWorkers().filter(w => w.kind === 'MANAGED')) {
      const cfg = w.config as ManagedConfig;
      let dirty = false;
      for (const role of ['daemon', 'control'] as const) {
        if (cfg.pid[role] != null && !pidAlive(cfg.pid[role]!)) { cfg.pid[role] = null; dirty = true; }
      }
      if (dirty) { this.store.updateWorker(w.workerKey, { config: cfg }); this.invalidateHealth(w.workerKey); }
    }
    for (const op of this.store.liveOperations()) {
      const step = (m: string) => this.store.appendStep(op.operationId, m);
      step('服务重启后核实：原操作恢复校验');
      const w = this.store.getWorker(op.workerKey);
      const cfg = w?.config as ManagedConfig | undefined;
      let ok = false;
      try {
        if (!w || !cfg) ok = false;
        else if (op.kind === 'STOP') {
          const dead = (p: number | null) => p == null || !pidAlive(p);
          ok = dead(cfg.pid.daemon) && dead(cfg.pid.control);
          step(ok ? '服务重启后核实：进程已退出' : '服务重启后核实：进程仍在运行');
        } else if (op.kind === 'GATE_ARM' || op.kind === 'GATE_DISARM') {
          const want = op.kind === 'GATE_ARM' ? 'ARMED' : 'DISARMED';
          const file = gateFileOf(cfg);
          const actual = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')).state : null;
          ok = actual === want || (want === 'DISARMED' && actual === null);
          step(`服务重启后核实：gate=${actual ?? 'absent'}`);
        } else {  // START / RESTART — prove health
          const port = cfg.ports.health;
          if (port != null && cfg.pid.daemon != null && pidAlive(cfg.pid.daemon)) {
            const rz = await httpJson(`http://127.0.0.1:${port}/readyz`, { timeoutMs: 2000 }).catch(() => null);
            ok = rz?.json?.ready === true;
          }
          step(ok ? '服务重启后核实：健康就绪' : '服务重启后核实：未就绪或进程不在');
        }
      } catch { ok = false; }
      this.store.finishOperation(op.operationId, ok ? 'SUCCEEDED' : 'VERIFY_FAILED',
        ok ? null : { code: 'VERIFY_FAILED', message: '控制台重启后无法确认操作结果' });
      this.invalidateHealth(op.workerKey);
    }
  }
}

/** worker.properties — secrets stay in env (WORKER_TOKEN), never in the file. */
function writeProperties(cfg: ManagedConfig) {
  const lines = [
    `worker.id=${cfg.workerId}`,
    'deployment.id=personal-local',
    `control.url=http://127.0.0.1:${cfg.ports.control}`,
    `provider=${cfg.provider}`,
    `state.dir=${fwd(cfg.dirs.state)}`,
    `work.dir=${fwd(cfg.dirs.work)}`,
    `health.port=${cfg.ports.health}`,
    `install.gate=${fwd(gateFileOf(cfg))}`,
    `drain.timeout.millis=${cfg.drainTimeoutMillis}`,
    'heartbeat.millis=5000',
    'poll.wait.seconds=5',
    '',
  ];
  writeFileSync(cfg.configFile!, lines.join('\n'));
}
