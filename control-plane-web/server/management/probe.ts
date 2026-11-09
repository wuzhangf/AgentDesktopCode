/**
 * Layered health probe — HOST / DAEMON / ENGINE / TOOLCHAIN, all four always
 * present. Fresh facts only; unknown stays UNKNOWN, never faked.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { AcceptingState, ConsoleSettings, HealthLayerResult, WorkerHealth, WorkerOwnership, WorkerSummary } from '../../shared/management/api';
import type { ExternalConfig, ManagedConfig, StoredHealth, WorkerRow } from './store';
import { httpGet, httpJson, verifyOwnership } from './sys';

const now = () => new Date().toISOString();
const layer = (l: HealthLayerResult['layer'], state: HealthLayerResult['state'],
  summary: string, detail?: string): HealthLayerResult =>
  ({ layer: l, state, summary, ...(detail ? { detail } : {}), observedAt: now() });

export function gateFileOf(cfg: ManagedConfig): string {
  return join(cfg.dirs.state, 'maintenance', 'install-gate.json');
}

/** health server base for a worker — managed uses its port, external its URL. */
export function healthBase(w: WorkerRow): string | null {
  if (w.kind === 'MANAGED') {
    const port = (w.config as ManagedConfig).ports.health;
    return port == null ? null : `http://127.0.0.1:${port}`;
  }
  const raw = (w.config as ExternalConfig).healthUrl;
  try {
    const url = new URL(raw);
    let p = url.pathname.replace(/\/+$/, '');
    for (const s of ['/health/live', '/health/ready', '/readyz', '/healthz'])
      if (p.endsWith(s)) { p = p.slice(0, -s.length); break; }
    return url.origin + p;
  } catch { return null; }
}

/** Gate state from the local file — mirrors daemon installGateArmed() semantics. */
function localGateState(file: string | null): 'ARMED' | 'DISARMED' | 'UNMOUNTED' | 'UNREADABLE' | 'UNKNOWN' {
  if (file == null) return 'UNKNOWN';
  if (!existsSync(file)) return 'DISARMED';   // daemon: absent → open
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    return String(parsed?.state ?? '').toUpperCase() === 'DISARMED' ? 'DISARMED' : 'ARMED';
  } catch { return 'UNREADABLE'; }            // daemon fails closed → armed
}

const parseBundleProvider = (bundle: string | null): string | null =>
  bundle?.match(/^provider-bundle=([^\s\[]+)/)?.[1] ?? null;

export interface ProbeResult {
  health: WorkerHealth;
  derived: StoredHealth['derived'];
  readyz: Record<string, any> | null;
  ownership: WorkerOwnership;
  control: { kind: 'LOCAL_DEMO_PLANE' | 'NONE'; url: string | null; reachable: boolean | null };
  daemonReachable: boolean;
}

export async function probeWorker(w: WorkerRow, settings: ConsoleSettings): Promise<ProbeResult> {
  const layers: HealthLayerResult[] = [];
  const cfg = w.config as ManagedConfig;
  const external = w.kind === 'EXTERNAL';
  const base = healthBase(w);
  const gateFile = external ? null : gateFileOf(cfg);

  // ---- HOST -------------------------------------------------------------
  const ownership: WorkerOwnership = { managed: !external, pid: null, startedAt: null, verified: false, detail: '' };
  if (external) {
    ownership.detail = '外部实例，无进程所有权';
    try {
      const r = await httpGet((w.config as ExternalConfig).healthUrl, { timeoutMs: 2500 });
      layers.push(layer('HOST', 'OK', `healthUrl 可达 (HTTP ${r.status})`));
    } catch (e: any) {
      layers.push(layer('HOST', 'DOWN', 'healthUrl 不可达', String(e?.cause?.code ?? e?.message ?? e)));
    }
  } else {
    ownership.pid = cfg.pid.daemon;
    ownership.startedAt = cfg.startedAt;
    if (cfg.pid.daemon == null) {
      const ranBefore = cfg.startedAt != null || w.lastSeenAt != null;
      ownership.detail = ranBefore ? '进程未在运行' : '尚未启动';
      layers.push(layer('HOST', ranBefore ? 'DOWN' : 'UNKNOWN',
        ranBefore ? '守护进程未在运行' : '尚未启动'));
    } else {
      const v = await verifyOwnership(cfg.pid.daemon, [cfg.configFile, cfg.dirs.state]);
      ownership.verified = v.verified;
      ownership.detail = v.detail;
      if (!v.alive) layers.push(layer('HOST', 'DOWN', `进程已退出 pid=${cfg.pid.daemon}`));
      else if (v.verified) layers.push(layer('HOST', 'OK', `进程存活 pid=${cfg.pid.daemon}`));
      else layers.push(layer('HOST', 'DEGRADED', `pid=${cfg.pid.daemon} 存活但所有权未确认`, v.detail));
    }
  }

  // ---- DAEMON -----------------------------------------------------------
  let readyz: Record<string, any> | null = null;
  let daemonReachable = false;
  if (base == null) {
    layers.push(layer('DAEMON', external ? 'DOWN' : 'UNKNOWN',
      external ? 'healthUrl 无效' : '尚未分配健康端口'));
  } else {
    try {
      const live = await httpGet(`${base}/health/live`, { timeoutMs: 2500 });
      if (live.status === 200) {
        daemonReachable = true;
        const rz = await httpJson(`${base}/readyz`, { timeoutMs: 2500 });
        readyz = rz.json;
        if (rz.json == null) layers.push(layer('DAEMON', 'DEGRADED', `readyz HTTP ${rz.status} 且响应非 JSON`));
        else if (rz.json.ready === true) layers.push(layer('DAEMON', 'OK', 'readyz 200 就绪'));
        else layers.push(layer('DAEMON', 'DEGRADED', `readyz ${rz.status} 未就绪${rz.json.draining ? '（draining）' : ''}`));
      } else {
        layers.push(layer('DAEMON', 'DOWN', `health/live HTTP ${live.status}`));
      }
    } catch (e: any) {
      layers.push(layer('DAEMON', 'DOWN', 'health/live 不可达', String(e?.cause?.code ?? e?.message ?? e)));
    }
  }

  // ---- ENGINE -----------------------------------------------------------
  const providerBundle = typeof readyz?.providerBundle === 'string' ? readyz.providerBundle : null;
  // Observed providerBundle wins over the configured provider; a mismatch is
  // surfaced explicitly rather than silently trusting config.
  const observed = parseBundleProvider(providerBundle);
  const configured = !external && cfg.provider ? cfg.provider : null;
  const provider = observed ?? configured;
  if (!daemonReachable) {
    layers.push(layer('ENGINE', 'UNKNOWN', '守护进程不可达'));
  } else if (observed != null && configured != null && observed !== configured) {
    layers.push(layer('ENGINE', 'DEGRADED',
      `provider 不一致：配置 ${configured} / 实测 ${observed}`, providerBundle ?? undefined));
  } else if (provider === 'fixture') {
    layers.push(layer('ENGINE', 'DEGRADED', 'fixture 提供者（无真实模型引擎）', providerBundle ?? undefined));
  } else if (provider === 'agentcode') {
    const acs = settings.acsConnections[0];
    if (!acs) layers.push(layer('ENGINE', 'UNKNOWN', '未配置 ACS 连接', providerBundle ?? undefined));
    else {
      const token = process.env[acs.tokenEnv];   // env NAME only — value read at call time, never stored
      if (!token) layers.push(layer('ENGINE', 'UNKNOWN', `ACS 连接 ${acs.name} 的环境变量 ${acs.tokenEnv} 未设置`));
      else try {
        const r = await httpGet(`${acs.baseUrl.replace(/\/+$/, '')}/api/v2/capabilities`,
          { timeoutMs: 3000, headers: { Authorization: `Bearer ${token}` } });
        layers.push(r.status >= 200 && r.status < 300
          ? layer('ENGINE', 'OK', `ACS ${acs.name} capabilities HTTP ${r.status}`)
          : layer('ENGINE', 'DEGRADED', `ACS ${acs.name} capabilities HTTP ${r.status}`));
      } catch (e: any) {
        layers.push(layer('ENGINE', 'DOWN', `ACS ${acs.name} 不可达`, String(e?.cause?.code ?? e?.message ?? e)));
      }
    }
  } else if (provider) {
    layers.push(layer('ENGINE', 'OK', `provider=${provider}`, providerBundle ?? undefined));
  } else {
    layers.push(layer('ENGINE', 'UNKNOWN', '提供者未知'));
  }

  // ---- TOOLCHAIN (increment B) ------------------------------------------
  layers.push(layer('TOOLCHAIN', 'UNKNOWN', '未采集'));

  // ---- derivation -------------------------------------------------------
  const ready = readyz?.ready === true ? true : readyz ? false : null;
  const draining = typeof readyz?.draining === 'boolean' ? readyz.draining : null;
  const rzGate = typeof readyz?.installGate === 'string' ? readyz.installGate.toUpperCase() : null;
  // External daemons keep their own install.gate path — without readyz the
  // gate state is honestly UNKNOWN, never guessed from a local convention.
  const installGate: WorkerSummary['installGate'] = rzGate == null
    ? (external ? 'UNKNOWN' : localGateState(gateFile))
    : rzGate === 'ARMED' ? 'ARMED'
    : rzGate === 'UNMOUNTED' ? 'UNMOUNTED'
    : rzGate === 'UNREADABLE' ? 'UNREADABLE'      // daemon fails closed on unreadable gate
    : rzGate === 'DISARMED' ? 'DISARMED' : 'UNKNOWN';
  // 'disarmed'.includes('armed') — compare exact tokens only, and an
  // UNREADABLE gate is closed by daemon semantics (fail-closed).
  const acceptingTasks: AcceptingState = !daemonReachable ? 'UNKNOWN'
    : installGate === 'ARMED' || installGate === 'UNREADABLE' ? 'NO_GATE'
    : draining === true ? 'NO_DRAINING'
    : ready !== true ? 'NO_NOT_READY' : 'YES';
  const attemptId = typeof readyz?.attemptId === 'string' && readyz.attemptId ? readyz.attemptId : null;
  const host = layers[0];
  const version = external ? null : readReleaseVersion(cfg.releaseRoot ?? settings.releaseRoot);

  const control: ProbeResult['control'] = !external && cfg.controlPlane === 'LOCAL_DEMO_PLANE' && cfg.ports.control != null
    ? { kind: 'LOCAL_DEMO_PLANE', url: `http://127.0.0.1:${cfg.ports.control}`, reachable: null }
    : { kind: 'NONE', url: null, reachable: null };
  if (control.url) {
    try { const r = await httpGet(`${control.url}/health/live`, { timeoutMs: 2000 }); control.reachable = r.status < 500; }
    catch { control.reachable = false; }
  }

  return {
    health: { checkedAt: now(), layers },
    derived: {
      connection: host.state, daemonReady: ready, draining, installGate, acceptingTasks,
      activeAttemptId: attemptId,
      workerId: typeof readyz?.workerId === 'string' ? readyz.workerId : null,
      instanceId: typeof readyz?.instanceId === 'string' && readyz.instanceId !== 'none' ? readyz.instanceId : null,
      provider, providerBundle,
      embeddedRuntime: typeof readyz?.embeddedRuntime === 'string' ? readyz.embeddedRuntime : null,
      version,
    },
    readyz, ownership, control, daemonReachable,
  };
}

function readReleaseVersion(releaseRoot: string | null): string | null {
  if (!releaseRoot) return null;
  try {
    const parent = join(releaseRoot, 'distribution', 'worker');
    const dir = readdirSync(parent).find(d => d.startsWith('agent-worker-local-'));
    if (!dir) return null;
    const manifest = JSON.parse(readFileSync(join(parent, dir, 'manifest.json'), 'utf8'));
    return manifest.version ?? manifest.release ?? null;
  } catch { return null; }
}
