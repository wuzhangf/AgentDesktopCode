/**
 * L0 — management BFF API matrix (no browser). Complements management.test.ts:
 * registration/validation matrix, control-request gating, idempotency, busy
 * workers, proxy behaviour, settings, install check, journal capability.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createServer, request, type Server } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createManagementServer, type ManagementHandle } from '../server/management/server';
import type { ManagedConfig, Store, WorkerRow } from '../server/management/store';

const tmp = () => mkdtempSync(join(tmpdir(), 'mgmt-api-'));
const dirs: string[] = [];
const servers: Server[] = [];
const stores: Store[] = [];

afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise<void>(r => s.close(() => r()));
  for (const st of stores.splice(0)) { try { st.close(); } catch { /* closed */ } }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function boot(opts: Partial<Parameters<typeof createManagementServer>[0]> = {}) {
  const root = opts.root ?? tmp();
  if (!opts.root) dirs.push(root);
  const h = createManagementServer({ root, dist: join(root, 'no-dist'), ...opts });
  stores.push(h.store);
  await h.ready;
  await new Promise<void>(r => h.server.listen(0, '127.0.0.1', r));
  servers.push(h.server);
  return { h, port: (h.server.address() as any).port as number };
}

async function call(port: number, method: string, path: string,
  opts: { body?: unknown; headers?: Record<string, string>; raw?: string } = {}) {
  return new Promise<{ status: number; json: any; text: string }>((resolve, reject) => {
    const payload = opts.raw ?? (opts.body === undefined ? undefined : JSON.stringify(opts.body));
    const req = request({ host: '127.0.0.1', port, method, path,
      headers: { 'content-type': 'application/json', 'x-manage-control': '1', ...opts.headers } }, res => {
      const chunks: Buffer[] = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json: any = null;
        try { json = JSON.parse(text); } catch { /* non-JSON */ }
        resolve({ status: res.statusCode!, json, text });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function managedWorker(store: Store, name = 'demo'): WorkerRow {
  const root = join(store.root, 'workers', name);
  const w: WorkerRow = {
    workerKey: name, kind: 'MANAGED', name, machine: 'local',
    config: {
      releaseRoot: null, provider: 'fixture', workerId: `w-${name}`,
      dirs: { root, control: join(root, 'control'), state: join(root, 'worker-state'),
        work: join(root, 'worker-work'), logs: join(root, 'logs') },
      ports: { control: null, health: null }, configFile: join(root, 'worker.properties'),
      controlToken: null, controlPlane: 'NONE', pid: { daemon: null, control: null },
      startedAt: null, drainTimeoutMillis: 1500,
    } satisfies ManagedConfig,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    lastSeenAt: null, lastHealth: null,
  };
  store.insertWorker(w);
  return w;
}

const register = (port: number, body: unknown) => call(port, 'POST', '/api/manage/workers/register', { body });

// ------------------------------------------------------------ E2E-API-01
describe('E2E-API-01 注册校验矩阵', () => {
  it('逐字段拒绝非法注册', async () => {
    const { port } = await boot();
    const cases: { body: unknown; code: string; label: string }[] = [
      { body: { kind: 'MANAGED', workerId: 'w1' }, code: 'INVALID_REQUEST', label: '缺 name' },
      { body: { kind: 'BOGUS', name: 'x' }, code: 'INVALID_REQUEST', label: '非法 kind' },
      { body: { kind: 'EXTERNAL', name: 'x' }, code: 'INVALID_REQUEST', label: '外部缺 healthUrl' },
      { body: { kind: 'MANAGED', name: 'x' }, code: 'INVALID_REQUEST', label: '受管缺 workerId' },
      { body: { kind: 'MANAGED', name: 'x', workerId: 'w1', provider: 'nope' }, code: 'INVALID_REQUEST', label: '非法 provider' },
      { body: { kind: 'EXTERNAL', name: 'x', healthUrl: 'http://127.0.0.1:9', extra: 1 }, code: 'INVALID_REQUEST', label: '多余字段' },
      { body: { kind: 'MANAGED', name: '', workerId: 'w1' }, code: 'INVALID_REQUEST', label: '空 name' },
    ];
    for (const c of cases) {
      const res = await register(port, c.body);
      expect(res.status, c.label).toBe(400);
      expect(res.json.code, c.label).toBe(c.code);
    }
  });
});

// ------------------------------------------------------------ E2E-API-02
describe('E2E-API-02 healthUrl 必须是 loopback http', () => {
  it('拒绝远程主机、凭据与 query/fragment', async () => {
    const { port } = await boot();
    for (const url of ['http://192.168.1.10:8080', 'https://127.0.0.1:8080',
      'http://user:pw@127.0.0.1:8080', 'http://127.0.0.1:8080/?x=1', 'http://127.0.0.1:8080/#f']) {
      const res = await register(port, { kind: 'EXTERNAL', name: 'x', healthUrl: url });
      expect(res.status, url).toBe(400);
      expect(res.json.code, url).toBe('INVALID_REQUEST');
    }
  });

  it('接受 loopback（含 ::1 / localhost）', async () => {
    const { port } = await boot();
    for (const url of ['http://127.0.0.1:8081', 'http://localhost:8081', 'http://[::1]:8081']) {
      const res = await register(port, { kind: 'EXTERNAL', name: `w-${url.replace(/\W/g, '')}`, healthUrl: url });
      expect(res.status, url).toBe(201);
    }
  });
});

// ------------------------------------------------------------ E2E-API-03
describe('E2E-API-03 变更请求防护', () => {
  it('缺控制头 / 跨域 Origin / cross-site 均 403', async () => {
    const { port } = await boot();
    const body = { kind: 'EXTERNAL', name: 'x', healthUrl: 'http://127.0.0.1:9' };

    const noHeader = await call(port, 'POST', '/api/manage/workers/register', {
      body, headers: { 'x-manage-control': '' },
    });
    expect(noHeader.status).toBe(403);
    expect(noHeader.json.code).toBe('ORIGIN_REJECTED');

    const crossOrigin = await call(port, 'POST', '/api/manage/workers/register', {
      body, headers: { origin: 'http://evil.example' },
    });
    expect(crossOrigin.status).toBe(403);

    const crossSite = await call(port, 'POST', '/api/manage/workers/register', {
      body, headers: { 'sec-fetch-site': 'cross-site' },
    });
    expect(crossSite.status).toBe(403);

    const sameOrigin = await call(port, 'POST', '/api/manage/workers/register', {
      body, headers: { origin: `http://127.0.0.1:${port}` },
    });
    expect(sameOrigin.status).toBe(201);
  });
});

// ------------------------------------------------------------ E2E-API-04/05
describe('E2E-API-04/05 请求体约束', () => {
  it('超过 1 MiB → 413', async () => {
    const { port } = await boot();
    const big = JSON.stringify({ kind: 'EXTERNAL', name: 'x', healthUrl: 'http://127.0.0.1:9', pad: 'a'.repeat(1024 * 1024 + 10) });
    const res = await call(port, 'POST', '/api/manage/workers/register', { raw: big });
    expect(res.status).toBe(413);
    expect(res.json.code).toBe('REQUEST_TOO_LARGE');
  });

  it('application/json; charset=utf-8 → 200；text/plain → 415', async () => {
    const { port } = await boot();
    const ok = await call(port, 'POST', '/api/manage/settings/check-install', {
      raw: '{"releaseRoot":null}', headers: { 'content-type': 'application/json; charset=utf-8' },
    });
    expect(ok.status).toBe(200);

    const bad = await call(port, 'POST', '/api/manage/settings/check-install', {
      raw: '{"releaseRoot":null}', headers: { 'content-type': 'text/plain' },
    });
    expect(bad.status).toBe(415);
    expect(bad.json.code).toBe('JSON_REQUIRED');
  });
});

// ------------------------------------------------------------ E2E-API-06
describe('E2E-API-06 幂等', () => {
  it('同 operationId 同 kind 复用；不同 kind 冲突', async () => {
    const { h, port } = await boot();
    managedWorker(h.store);
    const first = await call(port, 'POST', '/api/manage/workers/demo/operations', {
      body: { operationId: 'op-same', kind: 'GATE_ARM' },
    });
    expect(first.status).toBe(201);
    await h.lifecycle.waitOperation('op-same');

    const again = await call(port, 'POST', '/api/manage/workers/demo/operations', {
      body: { operationId: 'op-same', kind: 'GATE_ARM' },
    });
    expect(again.status).toBe(200);
    expect(again.json.operationId).toBe('op-same');

    const mismatch = await call(port, 'POST', '/api/manage/workers/demo/operations', {
      body: { operationId: 'op-same', kind: 'STOP' },
    });
    expect(mismatch.status).toBe(409);
    expect(mismatch.json.code).toBe('IDEMPOTENCY_MISMATCH');
  });
});

// ------------------------------------------------------------ E2E-API-07/08
describe('E2E-API-07/08 忙碌与外部 worker', () => {
  it('RUNNING 中再发操作 → 409 WORKER_BUSY', async () => {
    const { h, port } = await boot();
    managedWorker(h.store);
    const now = new Date().toISOString();
    h.store.createOperation({ operationId: 'op-live', workerKey: 'demo', kind: 'START', state: 'RUNNING',
      steps: [], error: null, createdAt: now, updatedAt: now });

    const res = await call(port, 'POST', '/api/manage/workers/demo/operations', {
      body: { operationId: 'op-second', kind: 'STOP' },
    });
    expect(res.status).toBe(409);
    expect(res.json.code).toBe('WORKER_BUSY');
  });

  it('外部 worker 的生命周期/gate 操作 → 409 NOT_MANAGED', async () => {
    const { port } = await boot();
    await register(port, { kind: 'EXTERNAL', name: 'ext', healthUrl: 'http://127.0.0.1:9' });
    for (const kind of ['START', 'STOP', 'RESTART', 'GATE_ARM', 'GATE_DISARM']) {
      const res = await call(port, 'POST', '/api/manage/workers/ext/operations', {
        body: { operationId: `op-${kind}`, kind },
      });
      expect(res.status, kind).toBe(409);
      expect(res.json.code, kind).toBe('NOT_MANAGED');
    }
  });
});

// ------------------------------------------------------------ E2E-API-09
describe('E2E-API-09 操作列表过滤', () => {
  it('?workerKey 只返回该 worker', async () => {
    const { h, port } = await boot();
    const now = new Date().toISOString();
    for (const [id, key] of [['op-a1', 'a'], ['op-a2', 'a'], ['op-b1', 'b']] as const) {
      h.store.createOperation({ operationId: id, workerKey: key, kind: 'STOP', state: 'SUCCEEDED',
        steps: [], error: null, createdAt: now, updatedAt: now });
    }
    const filtered = await call(port, 'GET', '/api/manage/operations?workerKey=a');
    expect(filtered.json.map((o: any) => o.operationId).sort()).toEqual(['op-a1', 'op-a2']);
    expect((await call(port, 'GET', '/api/manage/operations')).json).toHaveLength(3);
  });
});

// ------------------------------------------------------------ E2E-API-10
describe('E2E-API-10 /api/v2 代理', () => {
  it('GET 透传 query 与上游状态；非 GET → 405；上游不可达 → 502', async () => {
    const upstream = createServer((req, res) => {
      if (req.url?.startsWith('/api/v2/missing')) { res.writeHead(404); res.end('{"error":"nope"}'); return; }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ url: req.url }));
    });
    await new Promise<void>(r => upstream.listen(0, '127.0.0.1', r));
    servers.push(upstream);
    const obsPort = (upstream.address() as any).port;

    const { port } = await boot({ obsApiUrl: `http://127.0.0.1:${obsPort}` });
    const ok = await call(port, 'GET', '/api/v2/sessions?limit=2');
    expect(ok.status).toBe(200);
    expect(ok.json.url).toBe('/api/v2/sessions?limit=2');

    const passthrough = await call(port, 'GET', '/api/v2/missing');
    expect(passthrough.status).toBe(404);

    const post = await call(port, 'POST', '/api/v2/sessions', { body: {} });
    expect(post.status).toBe(405);
  });

  it('上游不可达 → 502 UPSTREAM_UNAVAILABLE', async () => {
    const { port } = await boot({ obsApiUrl: 'http://127.0.0.1:1' });
    const res = await call(port, 'GET', '/api/v2/meta/sources');
    expect(res.status).toBe(502);
    expect(res.json.code).toBe('UPSTREAM_UNAVAILABLE');
  });
});

// ------------------------------------------------------------ E2E-API-11
describe('E2E-API-11 settings', () => {
  it('整对象写入并回显；非法字段 400', async () => {
    const { port } = await boot();
    const good = await call(port, 'PUT', '/api/manage/settings', { body: {
      releaseRoot: 'D:/rel', defaultProvider: 'codex',
      acsConnections: [{ name: 'acs', baseUrl: 'http://127.0.0.1:8787', tokenEnv: 'ACS_TOKEN' }],
      obsApiUrl: null,
    } });
    expect(good.status).toBe(200);
    expect(good.json.defaultProvider).toBe('codex');

    // Whole-object semantics: omitting acsConnections clears it, it is required.
    const missing = await call(port, 'PUT', '/api/manage/settings', { body: { releaseRoot: null, defaultProvider: 'fixture', obsApiUrl: null } });
    expect(missing.status).toBe(400);

    const badEnv = await call(port, 'PUT', '/api/manage/settings', { body: {
      releaseRoot: null, defaultProvider: 'fixture',
      acsConnections: [{ name: 'a', baseUrl: 'http://127.0.0.1:1', tokenEnv: 'not a var' }], obsApiUrl: null,
    } });
    expect(badEnv.status).toBe(400);

    const extra = await call(port, 'PUT', '/api/manage/settings', { body: {
      releaseRoot: null, defaultProvider: 'fixture', acsConnections: [], obsApiUrl: null, unknown: true,
    } });
    expect(extra.status).toBe(400);
  });
});

// ------------------------------------------------------------ E2E-API-12
describe('E2E-API-12 check-install', () => {
  it('假 release 树文件项转绿；缺 jar 变红；未配置给出明确 findings', async () => {
    const root = tmp(); dirs.push(root);
    const rel = join(root, 'rel');
    const lib = join(rel, 'distribution', 'worker', 'agent-worker-local-9.9.9', 'lib');
    mkdirSync(lib, { recursive: true });
    writeFileSync(join(lib, 'agent-worker-local-9.9.9.jar'), '');
    writeFileSync(join(rel, 'distribution', 'worker', 'agent-worker-local-9.9.9', 'manifest.json'), '{"version":"9.9.9"}');
    const tk = join(rel, 'worker', 'worker-testkit', 'target');
    mkdirSync(tk, { recursive: true });
    writeFileSync(join(tk, 'worker-testkit-9.9.9.jar'), '');

    const { port } = await boot();
    const ok = await call(port, 'POST', '/api/manage/settings/check-install', { body: { releaseRoot: rel } });
    expect(ok.status).toBe(200);
    const byItem = (r: any, item: string) => r.json.findings.find((f: any) => f.item === item);
    for (const item of ['releaseRoot', 'worker dist lib', 'worker manifest', 'worker-testkit jar']) {
      expect(byItem(ok, item)?.ok, item).toBe(true);
    }

    rmSync(join(tk, 'worker-testkit-9.9.9.jar'));
    const broken = await call(port, 'POST', '/api/manage/settings/check-install', { body: { releaseRoot: rel } });
    expect(byItem(broken, 'worker-testkit jar').ok).toBe(false);

    const none = await call(port, 'POST', '/api/manage/settings/check-install', { body: { releaseRoot: null } });
    expect(byItem(none, 'releaseRoot').detail).toContain('未配置');
    expect(none.json.ok).toBe(false);
  });
});

// ------------------------------------------------------------ E2E-API-13/14
describe('E2E-API-13/14 journal 能力与重名登记', () => {
  it('无 stateDir 的外部 worker 无 JOURNAL_READ，journal 接口报 NO_JOURNAL', async () => {
    const { port } = await boot();
    const reg = await register(port, { kind: 'EXTERNAL', name: 'ext', healthUrl: 'http://127.0.0.1:9' });
    expect(reg.json.capabilities).not.toContain('JOURNAL_READ');

    const jr = await call(port, 'GET', '/api/manage/workers/ext/journal');
    expect(jr.status).toBe(404);
    expect(jr.json.code).toBe('NO_JOURNAL');

    const withDir = await register(port, { kind: 'EXTERNAL', name: 'ext2', healthUrl: 'http://127.0.0.1:9', stateDir: join(tmp(), 'state') });
    expect(withDir.json.capabilities).toContain('JOURNAL_READ');
  });

  it('重名登记派生 workerKey，不覆盖已有记录', async () => {
    const { port } = await boot();
    const body = { kind: 'EXTERNAL', name: 'dup', healthUrl: 'http://127.0.0.1:9' };
    const a = await register(port, body);
    const b = await register(port, body);
    expect(a.json.workerKey).toBe('dup');
    expect(b.json.workerKey).toBe('dup-2');
    expect((await call(port, 'GET', '/api/manage/workers')).json).toHaveLength(2);
  });
});

// ------------------------------------------------------------ E2E-API-15
describe('E2E-API-15 spawn 失败不崩服务', () => {
  it('不可执行命令 → FAILED START_FAILED，服务仍响应', async () => {
    const { h, port } = await boot({
      lifecycleDeps: { planSpawn: () => [{ role: 'daemon', command: 'definitely-not-a-real-binary-xyz-9', args: [] }], liveBudgetMs: 500 },
    });
    managedWorker(h.store);
    const res = await call(port, 'POST', '/api/manage/workers/demo/operations', {
      body: { operationId: 'op-nospawn', kind: 'START' },
    });
    expect(res.status).toBe(201);
    await h.lifecycle.waitOperation('op-nospawn');

    const op = h.store.getOperation('op-nospawn')!;
    expect(op.state).toBe('FAILED');
    expect(op.error?.code).toBe('START_FAILED');
    expect((await call(port, 'GET', '/api/manage/meta')).status).toBe(200);
  });
});

// ------------------------------------------------------------ E2E-API-16 (BUG-04)
describe('E2E-API-16 GET detail 探测节流', () => {
  it('新鲜窗口内复用已存探测；显式 check 才真正探测', async () => {
    let lives = 0;
    const stub = createServer((req, res) => {
      if (req.url === '/health/live') { lives++; res.writeHead(200); res.end('{"status":"live"}'); return; }
      if (req.url === '/readyz') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ready: true, workerId: 'w-e', instanceId: 'i-1',
          draining: false, installGate: 'disarmed', attemptId: '', providerBundle: 'provider-bundle=fixture' }));
        return;
      }
      res.writeHead(404); res.end();
    });
    await new Promise<void>(r => stub.listen(0, '127.0.0.1', r));
    servers.push(stub);
    const stubPort = (stub.address() as any).port as number;

    const { port } = await boot();
    const reg = await register(port, { kind: 'EXTERNAL', name: 'ext', healthUrl: `http://127.0.0.1:${stubPort}` });
    expect(reg.status).toBe(201);

    // First GET detail performs one real probe (nothing stored yet).
    const d1 = await call(port, 'GET', '/api/manage/workers/ext');
    expect(d1.status).toBe(200);
    expect(lives).toBe(1);
    // Within the freshness window, repeated GETs serve the stored snapshot.
    for (let i = 0; i < 3; i++) {
      const d = await call(port, 'GET', '/api/manage/workers/ext');
      expect(d.status).toBe(200);
      expect(d.json.health.checkedAt).toBe(d1.json.health.checkedAt);
    }
    expect(lives).toBe(1);
    // An explicit check always probes.
    const c = await call(port, 'POST', '/api/manage/workers/ext/check');
    expect(c.status).toBe(200);
    expect(lives).toBe(2);
  });
});
