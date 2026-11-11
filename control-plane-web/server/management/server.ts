/**
 * Personal worker management console — local BFF.
 * Loopback host allow-list for everything; POST/PUT under /api/manage also
 * require the x-manage-control header + same-origin fetch metadata. No
 * browser-supplied URL or token ever crosses the trust boundary.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { existsSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import type {
  AcceptingState, AttentionItem, ConsoleSettings, DiagnosticsBundle,
  LayerState, ManageProblem, Operation, OperationKind, Overview,
  WorkerCapability, WorkerDetail, WorkerSummary,
} from '../../shared/management/api';
import { MANAGE_API_PREFIX } from '../../shared/management/api';
import { checkInstall, Lifecycle, type LifecycleDeps, OpError } from './lifecycle';
import { journalPathFor, readJournal } from './journal';
import { probeWorker, type ProbeResult } from './probe';
import { pidAlive } from './sys';
import { consoleVersion, isId, pathsOf, sanitizedConfig } from './diagnostics';
import { Store, type ExternalConfig, type ManagedConfig, type StoredHealth, type WorkerRow } from './store';

const now = () => new Date().toISOString();
const OP_KINDS: OperationKind[] = ['START', 'STOP', 'RESTART', 'GATE_ARM', 'GATE_DISARM'];
const PROVIDERS = ['fixture', 'agentcode', 'codex', 'pi'];
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

class Rejected extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}
const reject = (message = 'Invalid management request'): never => { throw new Rejected(400, 'INVALID_REQUEST', message); };
function object(value: unknown): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return reject();
  return value as Record<string, any>;
}
function exact(value: Record<string, any>, keys: string[]) {
  if (Object.keys(value).some(key => !keys.includes(key))) reject();
}
function id(value: unknown): string { if (!isId(value)) return reject(); return value; }
function str(value: unknown, max = 256): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) return reject();
  return value.trim();
}
/** http loopback URL — credentials/queries never allowed. */
function loopbackHttp(value: unknown, label: string): string {
  if (typeof value !== 'string') return reject(`${label} 必须是 http loopback URL`);
  let url: URL;
  try { url = new URL(value); } catch { return reject(`${label} 不是合法 URL`); }
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    || url.username || url.password) return reject(`${label} 必须是 http loopback URL`);
  if (url.search || url.hash) return reject(`${label} 不允许携带 query/fragment`);
  return url.toString().replace(/\/+$/, '');
}

async function body(req: IncomingMessage): Promise<Record<string, any>> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1024 * 1024) throw new Rejected(413, 'REQUEST_TOO_LARGE', 'Request exceeds 1 MiB');
    chunks.push(Buffer.from(chunk));
  }
  if (size === 0) return {};    // body-less POST is fine — payload validation decides
  const ct = (req.headers['content-type'] ?? '').split(';')[0].trim();
  if (ct !== 'application/json') throw new Rejected(415, 'JSON_REQUIRED', 'Use application/json');
  try { return object(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
  catch (error) { if (error instanceof Rejected) throw error; return reject('Invalid JSON'); }
}

export interface ManagementOptions {
  personalGateway?: { handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> };
  root: string;                 // state root — management.db + worker dirs live here
  dist: string;                 // built SPA directory
  obsApiUrl?: string | null;    // env default for /api/v2 proxy; settings.obsApiUrl wins
  lifecycleDeps?: LifecycleDeps;
  startedAt?: string;
}
export interface ManagementHandle { server: Server; store: Store; lifecycle: Lifecycle; ready: Promise<void> }

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.ico': 'image/x-icon', '.json': 'application/json', '.map': 'application/json',
  '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.webp': 'image/webp',
};
const CSP = "default-src 'self'; connect-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'";

export function createManagementServer(options: ManagementOptions): ManagementHandle {
  const store = new Store(options.root);
  const lifecycle = new Lifecycle(store, options.lifecycleDeps);
  const startedAt = options.startedAt ?? now();
  const dist = resolve(options.dist);

  const send = (res: ServerResponse, status: number, value: unknown, headers: Record<string, string> = {}) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store',
      'x-content-type-options': 'nosniff', ...headers });
    res.end(JSON.stringify(value));
  };

  // ------------------------------------------------------------- shaping

  const capabilities = (w: WorkerRow): WorkerCapability[] => w.kind === 'MANAGED'
    ? ['HEALTH_PROBE', 'JOURNAL_READ', 'LIFECYCLE', 'GATE', 'DIAGNOSTICS']
    : ['HEALTH_PROBE', 'DIAGNOSTICS', ...((w.config as ExternalConfig).stateDir ? ['JOURNAL_READ' as const] : [])];

  const D = (w: WorkerRow): StoredHealth['derived'] | null => w.lastHealth?.derived as any ?? null;

  function summary(w: WorkerRow): WorkerSummary {
    const d = D(w);
    // Cheap freshness: a recorded pid that no longer exists is a certain DOWN,
    // even when the last layered probe predates the exit.
    const staleDown = w.kind === 'MANAGED'
      && (w.config as ManagedConfig).pid.daemon != null
      && !pidAlive((w.config as ManagedConfig).pid.daemon!);
    return {
      workerKey: w.workerKey, name: w.name, kind: w.kind, machine: w.machine,
      registeredAt: w.createdAt, lastSeenAt: w.lastSeenAt,
      connection: (staleDown ? 'DOWN' : d?.connection ?? 'UNKNOWN') as LayerState,
      daemonReady: staleDown ? false : d?.daemonReady ?? null, draining: d?.draining ?? null,
      installGate: (d?.installGate ?? 'UNKNOWN') as WorkerSummary['installGate'],
      acceptingTasks: (staleDown ? 'UNKNOWN' : d?.acceptingTasks ?? 'UNKNOWN') as AcceptingState,
      activeAttemptId: d?.activeAttemptId ?? null,
      workerId: d?.workerId ?? (w.kind === 'MANAGED' ? (w.config as ManagedConfig).workerId : null),
      instanceId: d?.instanceId ?? null,
      provider: d?.provider ?? (w.kind === 'MANAGED' ? (w.config as ManagedConfig).provider : null),
      version: d?.version ?? null,
      capabilities: capabilities(w),
    };
  }

  /** GET detail is read-mostly: a fresh stored snapshot is served as-is, and
   *  live probes are deduplicated per worker so N tabs share one probe. */
  const PROBE_FRESH_MS = 15_000;
  const inflight = new Map<string, Promise<ProbeResult>>();
  function sharedProbe(w: WorkerRow): Promise<ProbeResult> {
    const pending = inflight.get(w.workerKey);
    if (pending) return pending;
    const p = probeWorker(w, store.getSettings())
      .then((res) => { persistProbe(w, res); return res; })
      .finally(() => { inflight.delete(w.workerKey); });
    inflight.set(w.workerKey, p);
    return p;
  }

  async function detail(w: WorkerRow, probe?: ProbeResult): Promise<WorkerDetail> {
    const settings = store.getSettings();
    const h = w.lastHealth;
    if (probe == null && h && h.ownership != null && h.control != null
        && Date.now() - Date.parse(h.checkedAt) < PROBE_FRESH_MS) {
      return {
        ...summary(w), health: { checkedAt: h.checkedAt, layers: h.layers as WorkerDetail['health']['layers'] },
        engine: {
          provider: h.derived.provider, providerBundle: h.derived.providerBundle,
          embeddedRuntime: h.derived.embeddedRuntime,
          acsConnection: settings.acsConnections[0]?.name ?? null,
        },
        control: h.control,
        paths: pathsOf(w),
        ownership: h.ownership,
        config: sanitizedConfig(w),
      };
    }
    const p = probe ?? await sharedProbe(w);
    if (probe) persistProbe(w, p);
    const fresh = store.getWorker(w.workerKey) ?? w;
    return {
      ...summary(fresh), health: p.health,
      engine: {
        provider: p.derived.provider, providerBundle: p.derived.providerBundle,
        embeddedRuntime: p.derived.embeddedRuntime,
        acsConnection: settings.acsConnections[0]?.name ?? null,
      },
      control: p.control,
      paths: pathsOf(fresh),
      ownership: p.ownership,
      config: sanitizedConfig(fresh),
    };
  }

  function persistProbe(w: WorkerRow, p: ProbeResult) {
    store.updateWorker(w.workerKey, {
      lastHealth: {
        checkedAt: p.health.checkedAt, layers: p.health.layers, derived: p.derived,
        ownership: p.ownership, control: p.control,
      },
      ...(p.daemonReachable ? { lastSeenAt: p.health.checkedAt } : {}),
    });
  }

  // ------------------------------------------------------------ handlers

  function register(payload: Record<string, any>): WorkerRow {
    const kind = payload.kind;
    if (kind !== 'MANAGED' && kind !== 'EXTERNAL') return reject('kind 必须是 MANAGED|EXTERNAL');
    const name = str(payload.name, 64);
    let base = name.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'worker';
    if (!/^[a-z0-9]/.test(base)) base = 'w' + base;
    let key = base; let i = 2;
    while (store.getWorker(key)) key = `${base}-${i++}`;

    let config: ManagedConfig | ExternalConfig;
    if (kind === 'MANAGED') {
      exact(payload, ['kind', 'name', 'workerId', 'provider', 'releaseRoot']);
      const workerId = id(payload.workerId);
      const provider = payload.provider == null ? store.getSettings().defaultProvider : String(payload.provider);
      if (!PROVIDERS.includes(provider)) return reject(`provider 必须是 ${PROVIDERS.join('|')}`);
      const releaseRoot = payload.releaseRoot == null ? store.getSettings().releaseRoot : str(payload.releaseRoot, 512);
      const root = join(options.root, 'workers', key);
      config = {
        releaseRoot, provider, workerId,
        dirs: { root, control: join(root, 'control'), state: join(root, 'worker-state'),
          work: join(root, 'worker-work'), logs: join(root, 'logs') },
        ports: { control: null, health: null },
        configFile: join(root, 'worker.properties'),
        controlToken: null, controlPlane: 'NONE', pid: { daemon: null, control: null },
        startedAt: null, drainTimeoutMillis: 15000,
      } satisfies ManagedConfig;
    } else {
      exact(payload, ['kind', 'name', 'healthUrl', 'stateDir']);
      const healthUrl = loopbackHttp(payload.healthUrl, 'healthUrl');
      const stateDir = payload.stateDir == null ? null : str(payload.stateDir, 512);
      config = { healthUrl, stateDir } satisfies ExternalConfig;
    }
    const w: WorkerRow = { workerKey: key, kind, name, machine: 'local', config,
      createdAt: now(), updatedAt: now(), lastSeenAt: null, lastHealth: null };
    store.insertWorker(w);
    return w;
  }

  async function submitOperation(w: WorkerRow, payload: Record<string, any>): Promise<{ op: Operation; fresh: boolean }> {
    exact(payload, ['operationId', 'kind']);
    const operationId = id(payload.operationId);
    const kind = payload.kind as OperationKind;
    if (!OP_KINDS.includes(kind)) return reject(`kind 必须是 ${OP_KINDS.join('|')}`);
    const existing = store.getOperation(operationId);
    if (existing) {
      if (existing.workerKey !== w.workerKey || existing.kind !== kind) {
        throw new Rejected(409, 'IDEMPOTENCY_MISMATCH', 'operationId 已被不同请求占用');
      }
      return { op: store.toApiOperation(existing), fresh: false };
    }
    if (w.kind !== 'MANAGED') throw new Rejected(409, 'NOT_MANAGED', '外部 worker 不接受生命周期/gate 操作');
    if (store.liveOperations().some(o => o.workerKey === w.workerKey)) {
      throw new Rejected(409, 'WORKER_BUSY', '该 worker 已有进行中的操作');
    }
    const row = { operationId, workerKey: w.workerKey, kind, state: 'PENDING' as const,
      steps: [{ at: now(), message: '已受理' }], error: null, createdAt: now(), updatedAt: now() };
    store.createOperation(row);
    lifecycle.startOperation(row);
    return { op: store.toApiOperation(row), fresh: true };
  }

  function buildOverview(): Overview {
    const workers = store.listWorkers();
    const sevRank = { ACTION: 0, WARN: 1, INFO: 2 } as const;
    const attention: AttentionItem[] = [];
    const recent = store.listOperations(20);
    for (const op of recent) {
      if (op.state === 'FAILED' || op.state === 'VERIFY_FAILED') {
        attention.push({ id: `op-${op.operationId}`, severity: 'ACTION',
          message: `${store.operationName(op.workerKey)} ${op.kind} ${op.state}${op.error ? '：' + op.error.message : ''}`,
          workerKey: op.workerKey, operationId: op.operationId });
      }
    }
    for (const w of workers) {
      const d = D(w);
      if (w.kind === 'MANAGED' && d?.connection === 'DOWN' && w.lastSeenAt) {
        attention.push({ id: `down-${w.workerKey}`, severity: 'ACTION', workerKey: w.workerKey,
          message: `${w.name} 曾运行（${w.lastSeenAt}）现已不可达` });
      }
      if (d?.installGate === 'ARMED') {
        attention.push({ id: `gate-${w.workerKey}`, severity: 'WARN', workerKey: w.workerKey,
          message: `${w.name} install gate ARMED——拒绝新任务（GATE_DISARM 恢复）` });
      }
      if (d?.draining === true) {
        attention.push({ id: `drain-${w.workerKey}`, severity: 'WARN', workerKey: w.workerKey,
          message: `${w.name} daemon draining（单向闩锁，需 RESTART 恢复接任务）` });
      }
      const engine = w.lastHealth?.layers?.find((l: any) => l.layer === 'ENGINE');
      if (engine?.state === 'DEGRADED') {
        attention.push({ id: `engine-${w.workerKey}`, severity: 'WARN', workerKey: w.workerKey,
          message: `${w.name} 引擎降级：${engine.summary}` });
      }
      if (!w.lastSeenAt) {
        attention.push({ id: `unseen-${w.workerKey}`, severity: 'INFO', workerKey: w.workerKey,
          message: w.kind === 'EXTERNAL' ? `${w.name} 外部 worker 尚未探测` : `${w.name} 尚未观测到 daemon` });
      }
    }
    attention.sort((a, b) => sevRank[a.severity] - sevRank[b.severity]);
    return {
      generatedAt: now(), attention,
      workers: workers.map(summary),
      runningAttempts: workers.filter(w => D(w)?.activeAttemptId)
        .map(w => ({ workerKey: w.workerKey, workerName: w.name, attemptId: D(w)!.activeAttemptId!, state: null })),
      recentOperations: recent.map(o => store.toApiOperation(o)),
    };
  }

  function validateSettings(payload: Record<string, any>): ConsoleSettings {
    exact(payload, ['releaseRoot', 'defaultProvider', 'acsConnections', 'obsApiUrl']);
    const releaseRoot = payload.releaseRoot == null ? null : str(payload.releaseRoot, 512);
    const defaultProvider = payload.defaultProvider == null ? 'fixture' : String(payload.defaultProvider);
    if (!PROVIDERS.includes(defaultProvider)) return reject(`defaultProvider 必须是 ${PROVIDERS.join('|')}`);
    const acs = Array.isArray(payload.acsConnections) ? payload.acsConnections : reject('acsConnections 必须是数组');
    const acsConnections = (acs as any[]).map((c, i) => {
      const o = object(c);
      exact(o, ['name', 'baseUrl', 'tokenEnv']);
      const name = str(o.name, 64);
      const baseUrl = loopbackHttp(o.baseUrl, `acsConnections[${i}].baseUrl`);
      if (!ENV_NAME.test(String(o.tokenEnv ?? ''))) return reject(`acsConnections[${i}].tokenEnv 必须是环境变量名`);
      return { name, baseUrl, tokenEnv: String(o.tokenEnv) };
    });
    const obsApiUrl = payload.obsApiUrl == null ? null : loopbackHttp(payload.obsApiUrl, 'obsApiUrl');
    return { releaseRoot, defaultProvider, acsConnections, obsApiUrl };
  }

  async function diagnostics(): Promise<DiagnosticsBundle> {
    const workers = store.listWorkers();
    const details: WorkerDetail[] = [];
    for (const w of workers) details.push(await detail(w));
    const settings = store.getSettings();
    return {
      generatedAt: now(),
      meta: { consoleVersion: consoleVersion(), node: process.version, platform: process.platform, stateRoot: options.root },
      workers: details,
      operations: store.listOperations(100).map(o => store.toApiOperation(o)),
      settings: { releaseRoot: settings.releaseRoot, defaultProvider: settings.defaultProvider,
        obsApiUrl: settings.obsApiUrl,
        acsConnections: settings.acsConnections.map(({ name, baseUrl, tokenEnv }) => ({ name, baseUrl, tokenEnv })) },
    };
  }

  // --------------------------------------------------------------- server

  const server = createServer(async (req, res) => {
    try {
      const host = req.headers.host ?? '';
      if (!/^(localhost|127\.0\.0\.1|\[::1\]):[0-9]+$/.test(host)) {
        throw new Rejected(403, 'HOST_REJECTED', 'Loopback host required');
      }
      const url = new URL(req.url ?? '/', 'http://' + host);
      const path = url.pathname;
      if (path.startsWith('/api/personal/v1/')) {
        if (!options.personalGateway) throw new Rejected(503, 'PERSONAL_UNAVAILABLE', 'Personal gateway is not mounted');
        await options.personalGateway.handleRequest(req, res); return;
      }

      // ---- observation API proxy (analytics SPA compatibility) ----
      if (path === '/api/v2' || path.startsWith('/api/v2/')) {
        if (req.method !== 'GET') throw new Rejected(405, 'METHOD_NOT_ALLOWED', 'GET required');
        const base = store.getSettings().obsApiUrl ?? options.obsApiUrl ?? 'http://127.0.0.1:8788';
        let upstream: Response;
        try {
          upstream = await fetch(new URL(path + url.search, base), { redirect: 'error', signal: AbortSignal.timeout(10_000) });
        } catch { throw new Rejected(502, 'UPSTREAM_UNAVAILABLE', 'Observation API 不可达'); }
        // Bounded read — a wedged/huge upstream must not balloon the console.
        const chunks: Buffer[] = []; let size = 0;
        if (upstream.body) try {
          for await (const chunk of upstream.body as any) {
            size += (chunk as Uint8Array).byteLength;
            if (size > 32 * 1024 * 1024) {
              await upstream.body.cancel().catch(() => {});
              throw new Rejected(502, 'UPSTREAM_TOO_LARGE', 'Observation API 响应超过 32 MiB');
            }
            chunks.push(Buffer.from(chunk as Uint8Array));
          }
        } catch (e) {
          if (e instanceof Rejected) throw e;
          throw new Rejected(502, 'UPSTREAM_READ_FAILED', 'Observation API 响应读取失败');
        }
        const bytes = Buffer.concat(chunks);
        res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'application/json',
          'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
        res.end(bytes); return;
      }

      if (!path.startsWith(MANAGE_API_PREFIX + '/') && path !== MANAGE_API_PREFIX) {
        if (path.startsWith('/api/')) throw new Rejected(404, 'NOT_FOUND', 'Not found');
        // ---- static SPA ----
        if (req.method !== 'GET') throw new Rejected(405, 'METHOD_NOT_ALLOWED', 'GET required');
        let rel: string;
        try { rel = decodeURIComponent(path === '/' ? '/index.html' : path).slice(1); }
        catch { throw new Rejected(404, 'NOT_FOUND', 'Not found'); }
        const file = resolve(dist, rel);
        if (file !== dist && !file.startsWith(dist + sep)) throw new Rejected(404, 'NOT_FOUND', 'Not found');
        const st = existsSync(file) ? statSync(file) : null;
        if (st?.isFile()) {
          res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream',
            'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
            'referrer-policy': 'no-referrer', 'content-security-policy': CSP });
          res.end(await readFile(file)); return;
        }
        if (extname(rel)) throw new Rejected(404, 'NOT_FOUND', 'Not found');   // missing asset — not an SPA route
        const index = join(dist, 'index.html');
        if (!existsSync(index)) throw new Rejected(404, 'NOT_FOUND', 'Build the Web app first');
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
          'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'content-security-policy': CSP });
        res.end(await readFile(index)); return;
      }

      // ---- /api/manage -----------------------------------------------------
      const method = req.method ?? 'GET';
      if (method === 'POST' || method === 'PUT') {
        if (req.headers['x-manage-control'] !== '1'
          || req.headers.origin && req.headers.origin !== 'http://' + host
          || req.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(String(req.headers['sec-fetch-site']))) {
          throw new Rejected(403, 'ORIGIN_REJECTED', 'Same-origin control request required');
        }
      }
      const rel = path.slice(MANAGE_API_PREFIX.length);   // '/workers/...'
      const seg = rel.split('/').filter(Boolean);
      const segId = (s: string): string => { try { return id(decodeURIComponent(s)); } catch { return reject(); } };
      const workerOf = (): WorkerRow => {
        if (seg.length < 2) throw new Rejected(404, 'NOT_FOUND', 'Not found');
        const w = store.getWorker(segId(seg[1]));
        if (!w) throw new Rejected(404, 'NOT_FOUND', `未知 worker: ${seg[1]}`);
        return w;
      };

      if (method === 'GET' && rel === '/meta') {
        send(res, 200, { apiVersion: 'manage/1', stateRoot: options.root, startedAt }); return;
      }
      if (method === 'GET' && rel === '/overview') { send(res, 200, buildOverview()); return; }
      if (method === 'GET' && rel === '/workers') { send(res, 200, store.listWorkers().map(summary)); return; }
      if (method === 'POST' && rel === '/workers/register') {
        const w = register(await body(req));
        send(res, 201, summary(w)); return;
      }
      if (seg[0] === 'workers' && seg.length >= 2) {
        const w = workerOf();
        if (method === 'GET' && seg.length === 2) { send(res, 200, await detail(w)); return; }
        if (method === 'POST' && seg[2] === 'check' && seg.length === 3) {
          const p = await sharedProbe(w);
          send(res, 200, p.health); return;
        }
        if (method === 'GET' && seg[2] === 'journal' && seg.length === 3) {
          const limit = Math.max(1, Math.min(500, Number(url.searchParams.get('limit') ?? 50) || 50));
          const file = journalPathFor(w.kind === 'MANAGED' ? (w.config as ManagedConfig).dirs.state : (w.config as ExternalConfig).stateDir);
          if (!file) throw new Rejected(404, 'NO_JOURNAL', '该 worker 无本地 journal（未配置 stateDir）');
          send(res, 200, readJournal(file, limit)); return;
        }
        if (method === 'POST' && seg[2] === 'operations' && seg.length === 3) {
          const { op, fresh } = await submitOperation(w, await body(req));
          send(res, fresh ? 201 : 200, op); return;
        }
        throw new Rejected(404, 'NOT_FOUND', 'Not found');
      }
      if (method === 'GET' && rel === '/operations') {
        const limit = Math.max(1, Math.min(200, Number(url.searchParams.get('limit') ?? 50) || 50));
        const workerKey = url.searchParams.get('workerKey');
        if (workerKey != null && !isId(workerKey)) return reject('workerKey 非法');
        send(res, 200, store.listOperations(limit, workerKey ?? undefined).map(o => store.toApiOperation(o))); return;
      }
      if (method === 'GET' && seg[0] === 'operations' && seg.length === 2) {
        const op = store.getOperation(segId(seg[1]));
        if (!op) throw new Rejected(404, 'NOT_FOUND', `未知 operation: ${seg[1]}`);
        send(res, 200, store.toApiOperation(op)); return;
      }
      if (rel === '/settings' && method === 'GET') { send(res, 200, store.getSettings()); return; }
      if (rel === '/settings' && method === 'PUT') {
        const s = validateSettings(await body(req));
        store.putSettings(s); send(res, 200, store.getSettings()); return;
      }
      if (method === 'POST' && rel === '/settings/check-install') {
        const payload = await body(req);
        exact(payload, ['releaseRoot']);
        const releaseRoot = payload.releaseRoot === undefined ? store.getSettings().releaseRoot
          : payload.releaseRoot === null ? null : str(payload.releaseRoot, 512);
        send(res, 200, await checkInstall(releaseRoot)); return;
      }
      if (method === 'GET' && rel === '/diagnostics/export') { send(res, 200, await diagnostics()); return; }
      throw new Rejected(404, 'NOT_FOUND', 'Not found');
    } catch (error: any) {
      if (error instanceof Rejected) {
        send(res, error.status, { error: error.message, code: error.code, status: error.status } satisfies ManageProblem);
      } else if (error instanceof OpError) {
        send(res, 500, { error: error.message, code: error.code, status: 500 } satisfies ManageProblem);
      } else {
        send(res, 500, { error: String(error?.message ?? error), code: 'INTERNAL', status: 500 } satisfies ManageProblem);
      }
    }
  });

  const ready = lifecycle.reconcile().catch(e => console.error('reconcile failed:', e));
  return { server, store, lifecycle, ready };
}
