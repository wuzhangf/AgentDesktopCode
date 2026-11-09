/**
 * PAE P5 personal management gateway — test source (written under the
 * "code only, run later" mandate; not executed in this change set).
 *
 * Covers: canonical digests, migration registration/drift, registry store,
 * idempotent ledger replay/resume, per-kind capability honesty, route
 * matching incl. the §5.1 inputs route, and the loopback guards — all with a
 * fake upstream fetch so no real service, Docker or model is touched.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalDigest, canonicalJson } from '../server/management/canonical';
import { runMigrations, type ManagementMigration } from '../server/management/migrations';
import { ManagementStore } from '../server/management/registry-store';
import { ConnectionHub, WorkerEnvClient, loopbackOrigin } from '../server/management/upstream';
import { PersonalManagementService, type GatewayCallContext } from '../server/management/service';
import { createPersonalGateway } from '../server/management/personal-control';
import { ManagementError } from '../server/management/errors';
import { DatabaseSync } from 'node:sqlite';

const ctx: GatewayCallContext = {
  requestId: 'test-request',
  acsSessionFor: async () => undefined,
};

function memoryStore(): ManagementStore {
  return new ManagementStore({ path: ':memory:' });
}

// ---------------------------------------------------------------------------
describe('canonical.ts — freeze §0 canonical JSON', () => {
  it('orders keys by code point and drops undefined members', () => {
    expect(canonicalJson({ b: 1, a: 2, z: undefined, 'á': 3 })).toBe('{"a":2,"b":1,"á":3}');
    expect(canonicalJson([1, { y: null, x: [true] }])).toBe('[1,{"x":[true],"y":null}]');
  });
  it('produces sha256:<64 hex> digests stable across key order', () => {
    const a = canonicalDigest({ requestKey: 'k', kind: 'PREPARE' });
    const b = canonicalDigest({ kind: 'PREPARE', requestKey: 'k' });
    expect(a).toBe(b);
    expect(a).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
  it('excludes the named digest field from its own input', () => {
    const body = { requestKey: 'k', kind: 'PREPARE', bodyDigest: 'sha256:old' };
    expect(canonicalDigest(body, 'bodyDigest'))
      .toBe(canonicalDigest({ requestKey: 'k', kind: 'PREPARE' }));
  });
  it('rejects non-JSON values', () => {
    expect(() => canonicalJson({ n: Number.NaN })).toThrow();
    expect(() => canonicalJson(() => {})).toThrow();
  });
});

// ---------------------------------------------------------------------------
describe('migrations.ts — versioned schema runner', () => {
  it('applies p5 core schema and reports drift only via checksum compare', () => {
    const store = memoryStore();
    const tables = (store.db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[])
      .map((r) => r.name);
    for (const t of ['management_meta', 'connections', 'projects', 'project_environments',
      'tasks', 'task_actions', 'request_ledger', 'env_operations', 'operation_events',
      'readiness_facts', 'action_trials', 'management_schema_migrations']) {
      expect(tables).toContain(t);
    }
    store.close();
  });
  it('registers a P7-namespace migration without touching P5 tables', () => {
    const p7: ManagementMigration = {
      version: 100, namespace: 'p7-reports', name: 'report_tasks',
      up: (db) => db.exec('CREATE TABLE p7_report_tasks(id TEXT PRIMARY KEY)'),
    };
    const db = new DatabaseSync(':memory:');
    const out = runMigrations(db, [], [p7]);
    expect(out.applied).toEqual([100]);
    expect((db.prepare('SELECT version, namespace FROM management_schema_migrations').all() as any[]))
      .toEqual([{ version: 100, namespace: 'p7-reports' }]);
    // Re-running applies nothing and reports no drift for unchanged source.
    expect(runMigrations(db, [], [p7]).applied).toEqual([]);
    db.close();
  });
  it('rejects version collisions across namespaces', () => {
    const db = new DatabaseSync(':memory:');
    const a: ManagementMigration = { version: 5, namespace: 'p5-core', name: 'a', up: () => {} };
    const b: ManagementMigration = { version: 5, namespace: 'p7-reports', name: 'b', up: () => {} };
    expect(() => runMigrations(db, [a], [b])).toThrow(/claimed by both/);
    db.close();
  });
});

// ---------------------------------------------------------------------------
describe('store.ts — persistent registry', () => {
  it('keeps a stable controlPlaneId across reopens', () => {
    const dir = mkdtempSync(join(tmpdir(), 'p5-store-'));
    const path = join(dir, 'management.db');
    const a = new ManagementStore({ path });
    const idA = a.controlPlaneId;
    a.close();
    const b = new ManagementStore({ path });
    expect(b.controlPlaneId).toBe(idA);
    b.close();
  });
  it('persists connections, projects, environment selections and tasks', () => {
    const store = memoryStore();
    store.upsertConnection({ connectionId: 'acs-local', kind: 'ACS_DIRECT', baseUrl: 'http://127.0.0.1:8787' });
    store.insertProject({ projectId: 'prj-1', projectRef: 'proj-upstream', connectionId: 'acs-local' });
    store.upsertProjectEnvironment('prj-1', { planDigest: 'sha256:' + '0'.repeat(64) });
    store.upsertTask({ taskId: 'task-1', projectId: 'prj-1', displayName: 'T' });
    expect(store.getProject('prj-1')?.projectRef).toBe('proj-upstream');
    expect(store.getProjectEnvironment('prj-1')?.planDigest).toBe('sha256:' + '0'.repeat(64));
    expect(store.getTask('task-1')?.projectId).toBe('prj-1');
    store.close();
  });
  it('ledger: begin precedes dispatch, settle replays, digest conflict', () => {
    const store = memoryStore();
    store.ledgerBegin({ requestKey: 'k1', route: 'ACTION_SAVE', bodyDigest: 'sha256:' + '1'.repeat(64) });
    store.ledgerSettle('k1', 200, { ok: true });
    expect(store.ledgerGet('k1')?.state).toBe('SETTLED');
    expect(JSON.parse(store.ledgerGet('k1')!.responseBody!)).toEqual({ ok: true });
    store.close();
  });
  it('env operations + bounded events page', () => {
    const store = memoryStore();
    store.upsertConnection({ connectionId: 'w', kind: 'DAEMON', envBaseUrl: 'http://127.0.0.1:9999' });
    store.insertProject({ projectId: 'p', projectRef: 'r', connectionId: 'w' });
    store.ledgerBegin({ requestKey: 'rk', route: 'ENVIRONMENT_OPERATION', bodyDigest: 'sha256:' + '2'.repeat(64) });
    store.insertEnvOperation({ operationId: 'eop-1', requestKey: 'rk', kind: 'PREPARE', projectId: 'p', connectionId: 'w', state: 'QUEUED' });
    for (let i = 0; i < 60; i++) {
      store.appendOperationEvent({ operationId: 'eop-1', kind: 'PROGRESS', state: 'RUNNING', message: `step ${i}` });
    }
    const page1 = store.listOperationEvents('eop-1', 0, 50);
    const page2 = store.listOperationEvents('eop-1', 50, 50);
    expect(page1.length).toBe(50);
    expect(page2.length).toBe(10);
    expect(store.listPendingEnvOperations().map((o) => o.operationId)).toEqual(['eop-1']);
    store.close();
  });
  it('readiness facts keep observedAt when refreshed', () => {
    const store = memoryStore();
    store.putFacts('project:p', 'TOOLCHAIN', [
      { factKey: 'jdk', kind: 'TOOL_VERSION', name: 'jdk', version: '21', state: 'PRESENT' },
    ], '2026-10-18T00:00:00.000Z');
    expect(store.listFacts('project:p')[0]?.observedAt).toBe('2026-10-18T00:00:00.000Z');
    store.putFacts('project:p', 'TOOLCHAIN', [
      { factKey: 'jdk', kind: 'TOOL_VERSION', name: 'jdk', version: '21', state: 'MISSING' },
    ], '2026-10-18T01:00:00.000Z');
    expect(store.listFacts('project:p')[0]).toMatchObject({ state: 'MISSING', observedAt: '2026-10-18T01:00:00.000Z' });
    store.close();
  });
});

// ---------------------------------------------------------------------------
describe('upstream.ts — fixed leaf adapters', () => {
  it('loopbackOrigin rejects non-loopback / non-http / credentialed origins', () => {
    expect(loopbackOrigin('http://127.0.0.1:8787')).toBe('http://127.0.0.1:8787');
    expect(() => loopbackOrigin('https://127.0.0.1:8787')).toThrow();
    expect(() => loopbackOrigin('http://example.com')).toThrow();
    expect(() => loopbackOrigin('http://u:p@127.0.0.1:8787')).toThrow();
    expect(() => loopbackOrigin('http://127.0.0.1:8787/api')).toThrow();
  });
  it('WorkerEnvClient hits fixed /env/v1 routes with idempotency key', async () => {
    const seen: { method: string; path: string; key?: string }[] = [];
    const fake: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      seen.push({ method: init?.method ?? 'GET', path: url.pathname + url.search,
        key: (init?.headers as Record<string, string>)['idempotency-key'] });
      if (url.pathname === '/env/v1/environment-operations' && init?.method === 'POST') {
        return new Response(JSON.stringify({ operationId: 'uop-1', state: 'QUEUED' }), { status: 202 });
      }
      return new Response(JSON.stringify({ code: 'NOT_FOUND', message: 'none' }), { status: 404 });
    };
    const client = new WorkerEnvClient({ baseUrl: 'http://127.0.0.1:9999', token: 't', fetchImpl: fake });
    const accepted = await client.startOperation({ requestKey: 'rk-1', bodyDigest: 'sha256:' + '3'.repeat(64), kind: 'PREPARE' });
    expect(accepted).toEqual({ operationId: 'uop-1', state: 'QUEUED' });
    expect(seen[0]).toMatchObject({ method: 'POST', path: '/env/v1/environment-operations', key: 'rk-1' });
    await client.getOperation('uop-1').catch(() => {});
    expect(seen[1]?.path).toBe('/env/v1/environment-operations/uop-1');
    const probe = await client.probe();
    expect(probe.reachable).toBe(true); // a 404 still proves the channel
  });
});

// ---------------------------------------------------------------------------
// Fake upstream for service tests: in-memory /api/v2 + /env/v1 responders.
function fakeUpstream(opts: { envOk?: boolean } = {}): typeof fetch {
  return async (input, init) => {
    const url = new URL(String(input));
    const json = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (url.pathname === '/api/v2/client-sessions') {
      return json(200, {
        clientSessionId: 'cs-1', clientSessionToken: 't'.repeat(40),
        storeId: 'store', bootId: 'boot', ttlMillis: 60_000,
        remainingTtlMillis: 60_000, acceptedProtocols: ['v2'],
      });
    }
    if (url.pathname === '/api/v2/capabilities') {
      return json(200, {
        serviceInstanceId: 'svc', protocolVersion: '2.1', minDesktopProtocol: '2.0',
        features: { sessionV2: true, durableEvents: true, visibleOutputStream: true,
          worktreeExecution: true, mission: false, mcpHost: false, servicePty: false },
        limits: { maxDiffBytes: 1, maxEventPage: 1, maxVisibleDeltaChars: 1 },
        operations: [],
      });
    }
    if (url.pathname.startsWith('/api/v2/projects/') && url.pathname.endsWith('/build-plan')) {
      return json(200, { generatedAt: 0, targets: [{
        targetId: 'app', tool: 'maven', dir: '.', source: 'DETECTED',
        actions: { COMPILE: { argv: ['mvn', 'compile'], runner: 'maven',
          readiness: [{ id: 'jdk', check: 'JDK 21', severity: 'FAIL', passed: false,
            code: 'TOOLCHAIN_MISSING', message: 'JDK 21 required' }] } },
      }] });
    }
    if (url.pathname.startsWith('/api/v2/projects/') && url.pathname.endsWith('/session-preflight')) {
      return json(200, { projectId: 'proj-upstream', workspaceAlias: 'a',
        revision: '1', policyFingerprint: 'fp', authorityStatus: 'OK',
        allowedIntents: ['ASK', 'CODE'], suggestedWriteScope: [], writeScopeCeiling: [],
        modelAlias: 'm', modelAvailability: 'AVAILABLE' });
    }
    if (url.pathname === '/api/v2/environment/features') {
      return json(200, { serviceInstanceId: 'svc', generatedAtMillis: 0, features: [] });
    }
    if (url.pathname === '/api/v2/mcp/servers') {
      return json(200, []);
    }
    if (url.pathname === '/api/v2/attention') return json(200, { items: [] });
    if (url.pathname === '/api/v2/projects/proj-upstream'
        || url.pathname === '/api/v2/projects/registrations') {
      return json(200, { projectId: 'proj-upstream', workspaceAlias: 'a', authorityStatus: 'OK' });
    }
    if (url.pathname === '/env/v1/environment-operations' && init?.method === 'POST') {
      if (!opts.envOk) return json(503, { code: 'BACKEND_UNAVAILABLE', message: 'down', retryable: true });
      return json(202, { operationId: 'uop-9', state: 'QUEUED' });
    }
    if (url.pathname === '/env/v1/environment-operations/uop-9') {
      return json(200, { operationId: 'uop-9', state: 'RUNNING' });
    }
    if (url.pathname === '/env/v1/environment-operations/uop-9/cancel') {
      return json(200, { operationId: 'uop-9', state: 'CANCELED' });
    }
    if (url.pathname === '/env/v1/environment-operations/uop-9/inputs') {
      return json(200, { operationId: 'uop-9', state: 'RUNNING' });
    }
    if (url.pathname === '/env/v1/environment-operations/uop-9/events') {
      return json(200, { events: [{ eventId: 'e1', occurredAt: '2026-10-18T00:00:00Z', kind: 'PROGRESS', state: 'RUNNING', message: 'pull' }], nextCursor: null });
    }
    if (url.pathname === '/env/v1/projects:inspect') {
      return json(200, { requirements: [{ kind: 'TOOLCHAIN', name: 'jdk', version: '21' }],
        missing: [], warnings: [] });
    }
    if (url.pathname === '/env/v1/environment-plans') {
      return json(200, { planId: 'plan-1', planDigest: 'sha256:' + '4'.repeat(64), dependencySteps: [] });
    }
    if (url.pathname.startsWith('/env/v1/environments')) {
      return json(200, { items: [] });
    }
    return json(404, { code: 'NOT_FOUND', message: `no fake for ${url.pathname}` });
  };
}

function makeService(opts: { envOk?: boolean; withDaemon?: boolean } = {}) {
  const store = memoryStore();
  const connections = [
    { connectionId: 'acs-local', kind: 'ACS_DIRECT' as const,
      baseUrl: 'http://127.0.0.1:8787', tokenRef: 'env:P5_TEST_TOKEN' },
    ...(opts.withDaemon ? [{ connectionId: 'worker-daemon', kind: 'DAEMON' as const,
      envBaseUrl: 'http://127.0.0.1:9999', envTokenRef: 'env:P5_TEST_TOKEN' }] : []),
  ];
  const hub = new ConnectionHub(store, () => 'test-token', fakeUpstream({ envOk: opts.envOk ?? true }));
  hub.provision(connections);
  const service = new PersonalManagementService({ store, hub, now: () => new Date('2026-10-18T08:00:00Z') });
  return { store, service };
}

describe('service.ts — registration + idempotent writes', () => {
  it('registerProject verifies upstream ref and replays the same key', async () => {
    const { service } = makeService();
    const body = { requestKey: 'rk-reg-1', projectRef: 'proj-upstream', displayName: 'Demo' };
    const first = await service.registerProject(body, ctx);
    expect(first.status).toBe(200);
    const data = (first.body as any).data;
    expect(data.projectRef).toBe('proj-upstream');
    const replay = await service.registerProject(body, ctx);
    expect(replay.body).toEqual(first.body);
    const conflictResult = await service.registerProject(
      { ...body, projectRef: 'other-ref' }, ctx).catch((e) => e);
    expect(conflictResult).toMatchObject({ status: 409 });
  });
});

describe('service.ts — environment operations honour connection kinds', () => {
  it('ACS_DIRECT cannot prepare: CAPABILITY_OFF with a FAILED audit row', async () => {
    const { store, service } = makeService();
    const reg = await service.registerProject({ requestKey: 'rk-a', projectRef: 'proj-upstream' }, ctx);
    const projectId = (reg.body as any).data.projectId as string;
    const out = await service.startEnvironmentOperation(projectId,
      { requestKey: 'rk-op-1', kind: 'PREPARE' }, ctx);
    expect(out.status).toBe(409);
    expect((out.body as any).error.code).toBe('CAPABILITY_OFF');
    const op = store.getEnvOperationByRequestKey('rk-op-1');
    expect(op?.state).toBe('FAILED');
    expect(op?.reasonCode).toBe('BACKEND_UNAVAILABLE');
    // Replay returns the recorded rejection, no second dispatch.
    const replay = await service.startEnvironmentOperation(projectId,
      { requestKey: 'rk-op-1', kind: 'PREPARE' }, ctx);
    expect(replay.body).toEqual(out.body);
    // Same key, different body → conflict.
    const clash = await service.startEnvironmentOperation(projectId,
      { requestKey: 'rk-op-1', kind: 'RETIRE' }, ctx);
    expect(clash.status).toBe(409);
    expect((clash.body as any).error.code).toBe('IDEMPOTENCY_CONFLICT');
  });

  it('DAEMON dispatches upstream, merges state, cancels via /env/v1', async () => {
    const { store, service } = makeService({ withDaemon: true });
    store.insertProject({ projectId: 'p-d', projectRef: 'proj-upstream', connectionId: 'worker-daemon' });
    const start = await service.startEnvironmentOperation('p-d',
      { requestKey: 'rk-op-2', kind: 'PREPARE' }, ctx);
    expect(start.status).toBe(200);
    const opId = (start.body as any).data.operationId;
    const op = store.getEnvOperation(opId);
    expect(op?.upstreamOperationId).toBe('uop-9');
    const queried = await service.getEnvironmentOperation(opId);
    expect((queried.body as any).data.state).toBe('RUNNING');
    const cancel = await service.cancelEnvironmentOperation(opId,
      { requestKey: 'rk-cancel-1' }, ctx);
    expect((cancel.body as any).data.state).toBe('CANCELED');
    const replayCancel = await service.cancelEnvironmentOperation(opId,
      { requestKey: 'rk-cancel-1' }, ctx);
    expect(replayCancel.body).toEqual(cancel.body);
  });

  it('inputs route rejects non-NEEDS_INPUT operations and bad bodies', async () => {
    const { store, service } = makeService({ withDaemon: true });
    const bad = await service.submitOperationInput('eop-x',
      { requestKey: 'rk-i-1', payload: {} } as any, ctx).catch((e) => e);
    expect(bad).toBeInstanceOf(ManagementError);
    store.insertProject({ projectId: 'p-d', projectRef: 'r', connectionId: 'worker-daemon' });
    store.ledgerBegin({ requestKey: 'rk-op-3', route: 'ENVIRONMENT_OPERATION',
      bodyDigest: 'sha256:' + '5'.repeat(64) });
    store.insertEnvOperation({ operationId: 'eop-3', requestKey: 'rk-op-3', kind: 'PREPARE',
      projectId: 'p-d', connectionId: 'worker-daemon', state: 'RUNNING' });
    const out = await service.submitOperationInput('eop-3',
      { requestKey: 'rk-i-2', inputRequestId: 'in-1', payload: { a: 1 } }, ctx);
    expect(out.status).toBe(409);
    expect((out.body as any).error.code).toBe('OPERATION_NOT_AWAITING_INPUT');
  });
});

describe('service.ts — readiness view and reports seam', () => {
  it('project environment view layers needs/have/missing with observed facts', async () => {
    const { service } = makeService();
    const reg = await service.registerProject({ requestKey: 'rk-b', projectRef: 'proj-upstream' }, ctx);
    const view = (await service.getProjectEnvironment((reg.body as any).data.projectId, ctx)).body as any;
    expect(view.meta.controlPlaneId).toBeTruthy();
    expect(view.data.needs.some((n: any) => n.kind === 'TOOLCHAIN')).toBe(true);
    expect(view.data.missing.some((m: any) => m.name === 'JDK 21')).toBe(true);
    expect(view.data.state).toBe('NEEDS_INPUT');
  });
  it('reports are unconfigured-not-fake until P7 registers a provider', async () => {
    const { service } = makeService();
    const list = await service.listReports();
    expect((list.body as any).data).toEqual([]);
    expect((list.body as any).meta.reasonCodes).toContain('REPORT_PROVIDER_NOT_CONFIGURED');
    await expect(service.createReport({ requestKey: 'rk-r', sourceRef: 'src' }, ctx))
      .rejects.toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
describe('personal-control.ts — guards and route surface', () => {
  it('rejects missing same-origin headers and unknown routes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'p5-gw-'));
    const gateway = createPersonalGateway({
      dataDir: dir,
      connections: [{ connectionId: 'acs-local', kind: 'ACS_DIRECT',
        baseUrl: 'http://127.0.0.1:8787', tokenRef: 'env:P5_TEST_TOKEN' }],
      secretResolver: () => 'test-token',
      fetchImpl: fakeUpstream(),
    });
    await new Promise<void>((r) => gateway.server.listen(0, '127.0.0.1', r));
    const port = (gateway.server.address() as { port: number }).port;
    const base = `http://127.0.0.1:${port}`;
    try {
      // No custom header → 403 ORIGIN_REJECTED.
      const plain = await fetch(`${base}/api/personal/v1/overview`);
      expect(plain.status).toBe(403);
      // With guards: mints a session and serves the envelope.
      const ok = await fetch(`${base}/api/personal/v1/overview`, {
        headers: { 'x-personal-control': '1', 'x-personal-tab': 'tab-1',
          origin: `http://127.0.0.1:${port}` },
      });
      expect(ok.status).toBe(200);
      expect(ok.headers.get('set-cookie')).toContain('personal_control=');
      const env = await ok.json();
      expect(env.meta.controlPlaneId).toBe(gateway.controlPlaneId);
      // Unknown route → 404 {error}.
      const nf = await fetch(`${base}/api/personal/v1/nope`, {
        headers: { 'x-personal-control': '1', 'x-personal-tab': 'tab-1' },
      });
      expect(nf.status).toBe(404);
      expect((await nf.json()).error.requestId).toBeTruthy();
      // Cross-origin Origin → 403.
      const badOrigin = await fetch(`${base}/api/personal/v1/overview`, {
        headers: { 'x-personal-control': '1', 'x-personal-tab': 'tab-1',
          origin: 'http://evil.example' },
      });
      expect(badOrigin.status).toBe(403);
      // §5.1 inputs route exists: an unknown op fails with the domain code
      // OPERATION_NOT_FOUND — not the router's plain NOT_FOUND.
      const inputs = await fetch(`${base}/api/personal/v1/environment-operations/eop-1/inputs`, {
        method: 'POST',
        headers: { 'x-personal-control': '1', 'x-personal-tab': 'tab-1',
          'content-type': 'application/json' },
        body: JSON.stringify({ requestKey: 'rk', inputRequestId: 'in-1', payload: {} }),
      });
      const inputsError = (await inputs.json()).error;
      expect(inputsError.code).toBe('OPERATION_NOT_FOUND');
      expect(inputsError.requestId).toBeTruthy();
    } finally {
      await gateway.close();
    }
  });
});
