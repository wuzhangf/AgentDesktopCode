/**
 * LocalTaskAccess.remote() + LocalTransport conformance against a fake
 * worker-local source (node:http). Exercises the Java route table end to end:
 * identity pinning, ledger idempotency, action scoping and error-code mapping.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  GatewayError,
  permitsLaunch,
  scopeContains,
  type Device,
  type DeviceRequest,
  type Resource,
  fail,
  hash,
} from '../src/protocol';
import { createHash } from 'node:crypto';
import { LocalTransport, type ConnectionRowLite } from '../src/local-transport';
import { LocalTaskAccess, type LocalAuthLike, type LocalStoreLike } from '../src/local-tasks';

const TOKEN = 'worker-bearer';
const DEVICE_TOKEN = 'device-access';
const STORE = 'conn1';
const ROOT = '/personal/v1/local-tasks';

interface Req { method: string; url: string; headers: IncomingMessage['headers']; body: unknown }

class Fixture {
  /** Per-call identity overrides: each /identity read shifts one entry. */
  identityQueue: string[] = [];
  storeId = STORE;
  manifest: Record<string, unknown> | '404' | undefined = {
    schemaVersion: 'worker-host/1',
    storeId: STORE,
    engines: [{ engineId: 'pi', engineVersion: '1.0' }],
    contracts: ['worker-local/1'],
  };
  tasks: Record<string, Record<string, unknown>> = Fixture.defaultTasks();

  private static defaultTasks(): Record<string, Record<string, unknown>> {
    return {
      'native-t1': {
        taskId: 'native-t1', engineId: 'pi', engineVersion: '1.0', projectId: 'p1',
        state: 'RUNNING', title: 'demo', quiescent: false,
        generation: 'g1', nativeSessionId: 's1', nativeTurnId: 't9', currentCommandId: 'c3',
        capabilities: { stop: true, pause: true, resume: true, steer: true, followUp: true },
        env: { SECRET: 'x' }, workspace: '/private', createdAt: 1, updatedAt: 2,
      },
    };
  }
  pendingInputs: Record<string, Record<string, unknown>[]> = {};
  outputs: Record<string, Record<string, unknown>> = {};
  launchReply: { status: number; body: unknown } = {
    status: 200, body: { taskId: 'native-new1', engineId: 'pi' },
  };
  /** Canned reply per upstream sourceKey tail (task-requests/interaction-requests). */
  recoveryReplies: Record<string, { status: number; body: unknown }> = {};
  /** Canned preflight reply per `${projectId}|${engineId}`. */
  preflightReplies: Record<string, { status: number; body: unknown }> = {};
  artifactLists: Record<string, { status: number; body: unknown }> = {};
  artifactItems: Record<string, { status: number; body: unknown }> = {};
  /** Generic non-2xx override per `${taskId}|${subpath}` (unreadable feeds). */
  taskErrors: Record<string, { status: number; body: unknown }> = {};
  /** Canned reply per workspace upload sourceKey (native/v1/workspaces/...). */
  workspaceUploads: Record<string, { status: number; body: unknown }> = {};
  /** When true the next request's socket is destroyed (IOException analogue). */
  destroyNext = false;
  /** Hook run inside the handler per recorded request (mid-flight mutation). */
  requestHook: ((req: Req) => void) | undefined;
  requests: Req[] = [];

  posts(path: string): Req[] {
    return this.requests.filter((r) => r.method === 'POST' && r.url === path);
  }
  gets(path: string): Req[] {
    return this.requests.filter((r) => r.method === 'GET' && r.url === path);
  }

  reset(): void {
    this.identityQueue = [];
    this.storeId = STORE;
    this.tasks = Fixture.defaultTasks();
    this.pendingInputs = {};
    this.outputs = {};
    this.launchReply = { status: 200, body: { taskId: 'native-new1', engineId: 'pi' } };
    this.recoveryReplies = {};
    this.preflightReplies = {};
    this.artifactLists = {};
    this.artifactItems = {};
    this.taskErrors = {};
    this.workspaceUploads = {};
    this.destroyNext = false;
    this.requestHook = undefined;
    this.requests = [];
  }

  handle(req: IncomingMessage, res: ServerResponse): void {
    const url = req.url ?? '/';
    if (this.destroyNext) {
      this.destroyNext = false;
      req.socket.destroy();
      return;
    }
    if (req.headers.authorization !== `Bearer ${TOKEN}`) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ code: 'UNAUTHORIZED' }));
      return;
    }
    const send = (status: number, body: unknown): void => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(body === undefined ? '' : JSON.stringify(body));
    };
    const readBody = (fn: (body: unknown) => void): void => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        fn(raw.length === 0 ? undefined : JSON.parse(raw));
      });
    };
    const record = (body: unknown): void => {
      const entry = { method: req.method ?? '', url, headers: req.headers, body };
      this.requests.push(entry);
      this.requestHook?.(entry);
    };

    if (req.method === 'GET' && url === '/local/v1/identity') {
      record(undefined);
      send(200, { storeGuard: 'HEADER_V1', storeId: this.identityQueue.shift() ?? this.storeId });
      return;
    }
    if (req.method === 'GET' && url === '/worker-host/v1/manifest') {
      record(undefined);
      if (this.manifest === '404' || this.manifest === undefined) { send(404, { code: 'NOT_FOUND' }); return; }
      send(200, { ...this.manifest, storeId: this.storeId });
      return;
    }
    if (req.method === 'GET' && url === '/local/v1/projects') {
      record(undefined);
      send(200, { items: [{ projectId: 'p1', displayName: 'One' }, { projectId: 'p2' }] });
      return;
    }
    if (req.method === 'GET' && url === '/local/v1/engines') {
      record(undefined);
      send(200, { items: [{ engineId: 'pi', engineVersion: '1.0' }, { engineId: 'codex' }] });
      return;
    }
    if (req.method === 'POST' && url === '/local/v1/task-preflights') {
      readBody((body) => {
        record(body);
        const input = body as Record<string, unknown>;
        const reply = this.preflightReplies[`${input.projectId}|${input.engineId}`];
        if (reply !== undefined) { send(reply.status, reply.body); return; }
        send(200, { projectId: 'p1', engineId: 'pi', optionsRevision: 'r1' });
      });
      return;
    }
    if (req.method === 'POST' && url === '/local/v1/tasks') {
      readBody((body) => { record(body); send(this.launchReply.status, this.launchReply.body); });
      return;
    }
    if (req.method === 'GET' && url.startsWith('/local/v1/task-requests/')) {
      record(undefined);
      const reply = this.recoveryReplies[url.substring('/local/v1/task-requests/'.length)];
      if (reply !== undefined) { send(reply.status, reply.body); return; }
      send(404, { code: 'NOT_FOUND' });
      return;
    }
    if (url.startsWith('/local/v1/tasks/native-fail')) {
      if (req.method === 'POST') readBody((body) => { record(body); send(422, { code: 'CUSTOM_CODE' }); });
      else { record(undefined); send(422, { code: 'CUSTOM_CODE' }); }
      return;
    }
    const taskMatch = /^\/local\/v1\/tasks\/([^/?]+)(.*)$/.exec(url);
    if (taskMatch) {
      const taskId = taskMatch[1]!;
      const rest = taskMatch[2]!;
      if (rest.startsWith('/uploads')) {
        const reply = (body: unknown) => {
          record(body);
          const b = body as Record<string,unknown> | undefined;
          const principal = b?.principal ?? new URL('http://fixture'+url).searchParams.get('principal');
          send(200,{schemaVersion:'mac-material-upload/1',taskId,storeId:STORE,principal,uploadId:'upload-'+ 'a'.repeat(64),state:'UPLOADING'});
        };
        if (req.method === 'POST') readBody(reply); else reply(undefined);
        return;
      }
      const task = this.tasks[taskId] ?? {
        taskId, engineId: 'pi', engineVersion: '1.0', projectId: 'p1', state: 'RUNNING',
        capabilities: { stop: true, pause: true, resume: true, steer: true, followUp: true },
      };
      const override = this.taskErrors[`${taskId}|${rest}`];
      if (override !== undefined) {
        record(undefined);
        send(override.status, override.body);
        return;
      }
      if (req.method === 'GET' && (rest === '' || rest.startsWith('?'))) {
        record(undefined);
        send(200, task);
        return;
      }
      if (req.method === 'GET' && rest === '/input-requests') {
        record(undefined);
        send(200, { items: this.pendingInputs[taskId] ?? [] });
        return;
      }
      if (req.method === 'GET' && rest === '/output') {
        record(undefined);
        send(200, this.outputs[taskId] ?? { text: '' });
        return;
      }
      if (req.method === 'GET' && rest === '/events') {
        record(undefined);
        send(200, { items: [{ kind: 'note', createdAt: 1 }] });
        return;
      }
      if (req.method === 'GET' && rest === '/artifacts') {
        record(undefined);
        const reply = this.artifactLists[taskId];
        if (reply !== undefined) { send(reply.status, reply.body); return; }
        send(200, { items: [] });
        return;
      }
      if (req.method === 'GET' && rest.startsWith('/artifacts/')) {
        record(undefined);
        const reply = this.artifactItems[`${taskId}|${rest.substring('/artifacts/'.length)}`];
        if (reply !== undefined) { send(reply.status, reply.body); return; }
        send(404, { code: 'NOT_FOUND' });
        return;
      }
      if (req.method === 'GET' && rest === '/graphics/observations') {
        record(undefined);
        send(200, {
          bounded: false, coverage: 'current',
          items: [{ taskId, actionId: 'g1', outcome: 'DONE', elements: [{ identifier: 'btn-1', role: 'button', secret: 'x' }] }],
        });
        return;
      }
      if (req.method === 'GET' && rest.startsWith('/interaction-requests/')) {
        record(undefined);
        const reply = this.recoveryReplies[rest.substring('/interaction-requests/'.length)];
        if (reply !== undefined) { send(reply.status, reply.body); return; }
        send(404, { code: 'NOT_FOUND' });
        return;
      }
      if (req.method === 'GET' && rest === '/messages') {
        record(undefined);
        send(200, { items: [{ seq: 1, role: 'assistant', text: 'hi' }] });
        return;
      }
      if (req.method === 'POST') {
        readBody((body) => {
          record(body);
          if (rest === '/commands') { send(200, { state: 'ACCEPTED' }); return; }
          if (rest === '/messages') { send(200, { state: 'SENT' }); return; }
          if (rest.startsWith('/input-requests/') && rest.endsWith('/responses')) {
            send(200, { accepted: true });
            return;
          }
          if (rest.startsWith('/graphics/')) {
            const input = body as Record<string, unknown>;
            send(200, {
              requestKey: input.requestKey, taskId, state: 'OBSERVED', actionId: 'act-1',
              operation: rest.substring('/graphics/'.length).toUpperCase(),
              outcome: 'DONE', reasonCode: '', targetGuard: input.guard,
            });
            return;
          }
          send(404, { code: 'NOT_FOUND' });
        });
        return;
      }
    }
    const uploadMatch = /^\/local\/v1\/native\/v1\/workspaces\/([^/]+)\/uploads\/([^/?]+)(.*)$/.exec(url);
    if (uploadMatch) {
      const project = uploadMatch[1]!;
      const sourceKey = uploadMatch[2]!;
      const rest = uploadMatch[3]!;
      const canned = this.workspaceUploads[sourceKey];
      const replyFor = (body: unknown): { status: number; body: unknown } => {
        if (canned !== undefined) return canned;
        const b = body as Record<string, unknown> | undefined;
        const name = (b?.name as string | undefined) ?? 'notes.md';
        const sizeBytes = (b?.sizeBytes as number | undefined) ?? 4;
        const sha256 = (b?.sha256 as string | undefined) ?? 'a'.repeat(64);
        const sealed = {
          schemaVersion: 'mac-material-upload/1', uploadKey: sourceKey, workspaceRef: project,
          name, sizeBytes, sha256, nextOffset: sizeBytes, state: 'SEALED',
        };
        if (req.method === 'GET' || rest === '/seal') return { status: 200, body: sealed };
        return { status: 200, body: { ...sealed, nextOffset: 0, state: 'OPEN' } };
      };
      if (req.method === 'POST') {
        readBody((body) => { record(body); const reply = replyFor(body); send(reply.status, reply.body); });
      } else {
        record(undefined); const reply = replyFor(undefined); send(reply.status, reply.body);
      }
      return;
    }
    send(404, { code: 'NOT_FOUND' });
  }
}

let server: Server;
let baseUrl: string;
const fx = new Fixture();
let server2: Server;
let baseUrl2: string;
const fx2 = new Fixture();
const PI = 'store-pi';

beforeAll(async () => {
  server = createServer((req, res) => fx.handle(req, res));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  server2 = createServer((req, res) => fx2.handle(req, res));
  await new Promise<void>((resolve) => server2.listen(0, '127.0.0.1', resolve));
  baseUrl2 = `http://127.0.0.1:${(server2.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await new Promise<void>((resolve) => server2.close(() => resolve()));
});

// ---- fakes ----------------------------------------------------------------

/** In-memory LocalStoreLike — generic kind→payload map. */
class Store implements LocalStoreLike {
  map = new Map<string, unknown>();
  get<T>(kind: string, key: string): T | undefined {
    return this.map.get(`${kind}|${key}`) as T | undefined;
  }
  put(kind: string, key: string, value: unknown): void {
    this.map.set(`${kind}|${key}`, value);
  }
  list<T>(kind: string): T[] {
    return [...this.map.entries()]
      .filter(([k]) => k.startsWith(`${kind}|`))
      .map(([, v]) => v as T);
  }
  /** Java synchronized(auth) critical section — synchronous pass-through. */
  transaction<T>(fn: () => T): T {
    return fn();
  }
  launches(): DeviceRequest[] {
    return this.list<DeviceRequest>('local-launch');
  }
}

/**
 * Mirrors the production LocalAuthLike adapter in gateway-main.ts — token auth
 * plus Java's scope/action checks and the grant-revision CAS on launch.
 */
class Auth implements LocalAuthLike {
  constructor(readonly devices: Map<string, Device>) {}
  private active(deviceId: string): Device {
    const device = this.devices.get(deviceId);
    if (!device) fail('DEVICE_NOT_FOUND', 404);
    if (device.state !== 'ACTIVE') fail('DEVICE_REVOKED', 401);
    const now = Date.now();
    if (device.absoluteExpiry <= now || device.idleExpiry <= now) fail('DEVICE_EXPIRED', 401);
    return device;
  }
  private allows(device: Device, action: string): boolean {
    const actions = device.actions ?? [];
    return actions.includes(action) && (action !== 'GRAPHICS_ACT' || actions.includes('CONTROL'));
  }
  private check(device: Device, backend: string, taskId: string, action: string): void {
    if (!this.allows(device, action)
        || !scopeContains(device, 'WORKER_LOCAL', backend, taskId)) {
      fail('DEVICE_SCOPE_DENIED', 403);
    }
  }
  /** Optional hook fired after each authenticate() (revision-drift tests). */
  onAuthenticate: (() => void) | undefined;
  authenticate(token: string): Device {
    if (token !== DEVICE_TOKEN) fail('ACCESS_UNAUTHORIZED', 401);
    const device = this.active('dev1');
    this.onAuthenticate?.();
    return device;
  }
  authorizeLaunch(token: string, backend: string, projectId: string, engineId: string): Device {
    const device = this.authenticate(token);
    if (!(device.actions ?? []).includes('LAUNCH')
        || !permitsLaunch(device, backend, projectId, engineId)) {
      fail('DEVICE_SCOPE_DENIED', 403);
    }
    return device;
  }
  authorizeLocal(token: string, backend: string, taskId: string, action: string): Device {
    const device = this.authenticate(token);
    this.check(device, backend, taskId, action);
    return device;
  }
  authorizeLocalDevice(deviceId: string, backend: string, taskId: string, action: string): Device {
    const device = this.active(deviceId);
    this.check(device, backend, taskId, action);
    return device;
  }
  appendLaunchedTask(
    deviceId: string, expectedRevision: number,
    backend: string, projectId: string, engineId: string, taskId: string,
  ): void {
    const device = this.active(deviceId);
    if (scopeContains(device, 'WORKER_LOCAL', backend, taskId)) return;
    if (device.revision !== expectedRevision
        || !(device.actions ?? []).includes('LAUNCH')
        || !permitsLaunch(device, backend, projectId, engineId)) {
      fail('GRANT_REVISION_CONFLICT', 409);
    }
    device.resources = [...(device.resources ?? []), { kind: 'WORKER_LOCAL', backendStoreId: backend, taskId }];
    device.revision += 1;
  }
  ownerStatus(): Record<string, unknown> {
    return { enabled: true, personalHostId: 'host1', storeId: 'host-store', origin: null };
  }
  activeDevice(deviceId: string): Device {
    return this.active(deviceId);
  }
}

function makeDevice(): Device {
  return {
    id: 'dev1',
    state: 'ACTIVE',
    scopeVersion: 1,
    revision: 7,
    accessExpiry: Date.now() + 3_600_000,
    absoluteExpiry: Date.now() + 3_600_000,
    idleExpiry: Date.now() + 3_600_000,
    recoverUntil: 0,
    spentRefresh: [],
    actions: ['OBSERVE', 'CONTROL', 'INTERACT', 'APPROVE', 'LAUNCH'],
    resources: [{ kind: 'WORKER_LOCAL', backendStoreId: STORE, taskId: 'native-t1' }],
    launchScopes: [{ backendStoreId: STORE, projectId: 'p1', engineId: 'pi' }],
  };
}

function harness() {
  fx.reset();
  const devices = new Map<string, Device>([['dev1', makeDevice()]]);
  const auth = new Auth(devices);
  const store = new Store();
  const registry = {
    getConnection(id: string): ConnectionRowLite | undefined {
      return id === STORE
        ? { connectionId: STORE, kind: 'worker-local', baseUrl, tokenRef: 'tok1' }
        : undefined;
    },
    listConnections(): ConnectionRowLite[] {
      return [{ connectionId: STORE, kind: 'worker-local', baseUrl, tokenRef: 'tok1' }];
    },
  };
  const transport = new LocalTransport(registry, (ref) => (ref === 'tok1' ? TOKEN : undefined));
  const access = new LocalTaskAccess(auth, transport, store);
  return { devices, store, transport, access };
}

const remote = (
  access: LocalTaskAccess, method: string, path: string,
  body: unknown = null, key: string | null = null, query: string | null = null,
) => access.remote(DEVICE_TOKEN, method, path, body, key, query);

async function codeOf(promise: Promise<unknown>): Promise<{ code: string; status: number }> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(GatewayError);
    const e = error as GatewayError;
    return { code: e.code, status: e.httpStatus };
  }
  throw new Error('expected GatewayError');
}

const inputBody = (extra: Record<string, unknown>): Record<string, unknown> => ({
  generation: 'g1', nativeSessionId: 's1', nativeTurnId: 't9', targetCommandId: 'c3',
  ...extra,
});

// ---- LocalTransport ---------------------------------------------------------

describe('LocalTransport', () => {
  it('sends bearer + store guard + idempotency headers', async () => {
    const { transport } = harness();
    const out = await transport.raw(STORE, 'POST', '/tasks/native-t1/commands', { intent: 'STOP' }, 'k-9', STORE);
    expect(out.status).toBe(200);
    const post = fx.posts('/local/v1/tasks/native-t1/commands').at(-1)!;
    expect(post.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(post.headers['x-worker-local-store']).toBe(STORE);
    expect(post.headers['idempotency-key']).toBe('k-9');
  });

  it('fails missing / wrong-kind / non-loopback / missing-token connections', async () => {
    const rows: ConnectionRowLite[] = [
      { connectionId: STORE, kind: 'worker-local', baseUrl, tokenRef: 'tok1' },
      { connectionId: 'cloud', kind: 'acs', baseUrl, tokenRef: 'tok1' },
      { connectionId: 'remote', kind: 'worker-local', baseUrl: 'http://192.168.1.5:9', tokenRef: 'tok1' },
      { connectionId: 'notoken', kind: 'worker-local', baseUrl, tokenRef: 'missing' },
    ];
    const transport = new LocalTransport(
      { getConnection: (id) => rows.find((r) => r.connectionId === id), listConnections: () => rows },
      (ref) => (ref === 'tok1' ? TOKEN : undefined));
    expect(await codeOf(transport.raw('gone', 'GET', '/identity'))).toEqual({ code: 'LOCAL_SOURCE_UNAVAILABLE', status: 503 });
    expect(await codeOf(transport.raw('cloud', 'GET', '/identity'))).toEqual({ code: 'LOCAL_SOURCE_UNAVAILABLE', status: 503 });
    expect(await codeOf(transport.raw('remote', 'GET', '/identity'))).toEqual({ code: 'LOCAL_SOURCE_UNAVAILABLE', status: 503 });
    expect(await codeOf(transport.raw('notoken', 'GET', '/identity'))).toEqual({ code: 'LOCAL_UPSTREAM_AUTH_MISSING', status: 503 });
  });
});

// ---- catalog / options ------------------------------------------------------

describe('LocalTaskAccess catalog', () => {
  it('GET root returns granted resources and launch scopes', async () => {
    const { access } = harness();
    const out = await remote(access, 'GET', ROOT);
    expect(out.status).toBe(200);
    const body = out.body as Record<string, unknown>;
    expect(body.schemaVersion).toBe('personal-local-access/1');
    expect(body.resources).toEqual([
      { kind: 'WORKER_LOCAL', backendStoreId: STORE, taskId: 'native-t1' },
    ]);
    expect(body.launchScopes).toEqual([
      { backendStoreId: STORE, projectId: 'p1', engineId: 'pi' },
    ]);
  });

  it('GET options trims the owner catalog to granted launch scopes', async () => {
    const { access } = harness();
    const out = await remote(access, 'GET', `${ROOT}/${STORE}/options`);
    expect(out.status).toBe(200);
    const body = out.body as Record<string, unknown>;
    expect(body.backendStoreId).toBe(STORE);
    expect(body.projects).toEqual([{ projectId: 'p1', displayName: 'One' }]);
    expect((body.engines as unknown[]).length).toBe(1);
  });

  it('GET options denies without LAUNCH', async () => {
    const { access, devices } = harness();
    devices.get('dev1')!.actions = ['OBSERVE'];
    expect(await codeOf(remote(access, 'GET', `${ROOT}/${STORE}/options`)))
      .toEqual({ code: 'DEVICE_SCOPE_DENIED', status: 403 });
  });
});

// ---- launches ----------------------------------------------------------------

describe('LocalTaskAccess launches', () => {
  const launchBody = { requestKey: 'key-1', projectId: 'p1', engineId: 'pi', optionsRevision: 'r1', instruction: 'do it' };

  it('POST tasks is ledgered, replays by key and rejects payload drift', async () => {
    const { access, devices, store } = harness();
    const first = await remote(access, 'POST', `${ROOT}/${STORE}/tasks`, launchBody, 'key-1');
    expect(first.status).toBe(200);
    const view = first.body as Record<string, unknown>;
    expect(view.state).toBe('OBSERVED');
    expect(view.taskId).toBe('native-new1');
    expect(view.requestKey).toBe('key-1');
    // The upstream sees the deterministic source key, not the client key.
    const posted = fx.posts('/local/v1/tasks').at(-1)!;
    expect((posted.body as Record<string, unknown>).requestKey).toMatch(/^mobile-[a-f0-9]{64}$/);
    // Java appendLaunchedTask: scope append + revision bump.
    const device = devices.get('dev1')!;
    expect(scopeContains(device, 'WORKER_LOCAL', STORE, 'native-new1')).toBe(true);
    expect(device.revision).toBe(8);

    const posts = fx.posts('/local/v1/tasks').length;
    const replay = await remote(access, 'POST', `${ROOT}/${STORE}/tasks`, launchBody, 'key-1');
    expect(replay.body).toEqual(view);
    expect(fx.posts('/local/v1/tasks').length).toBe(posts);

    expect(await codeOf(remote(access, 'POST', `${ROOT}/${STORE}/tasks`,
      { ...launchBody, instruction: 'different' }, 'key-1')))
      .toEqual({ code: 'IDEMPOTENCY_PAYLOAD_MISMATCH', status: 409 });
    expect(store.launches().length).toBe(1);
  });

  it('forwards model/effort selections to the worker and keys drift on them', async () => {
    const { access } = harness();
    const out = await remote(access, 'POST', `${ROOT}/${STORE}/tasks`,
      { ...launchBody, model: 'mimo-v2.6', effort: 'high' }, 'key-1');
    expect(out.status).toBe(200);
    const posted = fx.posts('/local/v1/tasks').at(-1)!.body as Record<string, unknown>;
    expect(posted.model).toBe('mimo-v2.6');
    expect(posted.effort).toBe('high');
    // Replaying the same key with a changed model must not reuse the receipt.
    expect(await codeOf(remote(access, 'POST', `${ROOT}/${STORE}/tasks`,
      { ...launchBody, model: 'mimo-v2.6-flash', effort: 'high' }, 'key-1')))
      .toEqual({ code: 'IDEMPOTENCY_PAYLOAD_MISMATCH', status: 409 });
    expect(await codeOf(remote(access, 'POST', `${ROOT}/${STORE}/tasks`,
      { ...launchBody, model: 42 }, 'key-9'))).toEqual({ code: 'INVALID_REQUEST', status: 400 });
  });

  it('requires Idempotency-Key == requestKey and a launch scope', async () => {
    const { access } = harness();
    expect(await codeOf(remote(access, 'POST', `${ROOT}/${STORE}/tasks`, launchBody, 'other-key')))
      .toEqual({ code: 'IDEMPOTENCY_KEY_MISMATCH', status: 400 });
    expect(await codeOf(remote(access, 'POST', `${ROOT}/${STORE}/tasks`,
      { ...launchBody, requestKey: 'k2', projectId: 'p2' }, 'k2')))
      .toEqual({ code: 'DEVICE_SCOPE_DENIED', status: 403 });
  });

  it('records a binding mismatch on the ledger instead of dispatching a task', async () => {
    const { access } = harness();
    fx.launchReply = { status: 200, body: { taskId: 'bogus', engineId: 'pi' } };
    // Java: a malformed accept is stored on the request row (UNKNOWN) — the
    // receipt view carries the code rather than throwing away the outcome.
    const out = await remote(access, 'POST', `${ROOT}/${STORE}/tasks`, launchBody, 'key-1');
    const view = out.body as Record<string, unknown>;
    expect(view.state).toBe('UNKNOWN');
    expect(view.code).toBe('LOCAL_BINDING_MISMATCH');
  });

  it('GET task-requests/{key} recovers the launch receipt', async () => {
    const { access } = harness();
    await remote(access, 'POST', `${ROOT}/${STORE}/tasks`, launchBody, 'key-1');
    const recovered = await remote(access, 'GET', `${ROOT}/${STORE}/task-requests/key-1`);
    expect((recovered.body as Record<string, unknown>).taskId).toBe('native-new1');
    expect(await codeOf(remote(access, 'GET', `${ROOT}/${STORE}/task-requests/nope`)))
      .toEqual({ code: 'NOT_FOUND', status: 404 });
  });
});

// ---- task reads ----------------------------------------------------------------

describe('LocalTaskAccess task reads', () => {
  it.each(['before=9223372036854775807&limit=100', 'cursor=0&limit=1'])('forwards bounded message paging: %s', async query => {
    const { access } = harness();
    fx.taskErrors[`native-t1|/messages?${query}`] = {status: 200, body: {
      taskId: 'native-t1', storeId: STORE, messageSchemaVersion: 'native-messages/1', items: [],
      messageTransportVersion: 'untrusted-upstream',
    }};
    const out = await remote(access, 'GET', `${ROOT}/${STORE}/tasks/native-t1/messages`, null, null, query);
    expect(out.body).toMatchObject({messageTransportVersion: 'native-messages-page/1', backendStoreId: STORE});
    expect(fx.gets(`/local/v1/tasks/native-t1/messages?${query}`)).toHaveLength(1);
  });

  it('marks first structured reads, strips forged legacy paging claims, and retains source/auth fences', async () => {
    const { access, devices } = harness();
    fx.taskErrors['native-t1|/messages'] = {status: 200, body: {
      messageSchemaVersion: 'native-messages/1', items: [],
    }};
    expect((await remote(access, 'GET', `${ROOT}/${STORE}/tasks/native-t1/messages`)).body)
      .toMatchObject({messageTransportVersion: 'native-messages-page/1'});
    fx.taskErrors['native-t1|/messages'].body = {text: 'legacy', messageTransportVersion: 'native-messages-page/1'};
    expect((await remote(access, 'GET', `${ROOT}/${STORE}/tasks/native-t1/messages`)).body)
      .not.toHaveProperty('messageTransportVersion');
    fx.identityQueue.push(STORE, 'changed-store');
    expect(await codeOf(remote(access, 'GET', `${ROOT}/${STORE}/tasks/native-t1/messages`, null, null, 'before=2')))
      .toEqual({code: 'LOCAL_SOURCE_IDENTITY_CHANGED', status: 409});
    fx.identityQueue = [];
    fx.taskErrors['native-t1|/messages?before=2'] = {status: 200, body: {items: []}};
    fx.requestHook = req => { if (req.url.endsWith('/messages?before=2')) devices.get('dev1')!.resources = []; };
    expect(await codeOf(remote(access, 'GET', `${ROOT}/${STORE}/tasks/native-t1/messages`, null, null, 'before=2')))
      .toEqual({code: 'DEVICE_SCOPE_DENIED', status: 403});
  });

  it.each(['before=0', 'cursor=9223372036854775808', 'before=01', 'before=2&cursor=0',
    'cursor=1&cursor=2', 'limit=101', 'limit=0', 'before=-1', 'before=1=2', 'before=%31',
    'other=1', 'before=1&', 'cursor=1.0'])('rejects invalid message query without forwarding: %s', async query => {
    const { access } = harness();
    expect(await codeOf(remote(access, 'GET', `${ROOT}/${STORE}/tasks/native-t1/messages`, null, null, query)))
      .toEqual({code: 'INVALID_REQUEST', status: 400});
    expect(fx.requests).toHaveLength(0);
  });

  it('keeps message-only before queries out of other fixed routes', async () => {
    const { access } = harness();
    for (const leaf of ['events', 'output', 'artifacts']) {
      expect(await codeOf(remote(access, 'GET', `${ROOT}/${STORE}/tasks/native-t1/${leaf}`, null, null, 'before=2')))
        .toEqual({code: 'INVALID_REQUEST', status: 400});
    }
  });

  it('GET task hides filesystem fields and adds clientAccess projection', async () => {
    const { access } = harness();
    const out = await remote(access, 'GET', `${ROOT}/${STORE}/tasks/native-t1`);
    expect(out.status).toBe(200);
    const view = out.body as Record<string, unknown>;
    expect(view.taskId).toBe('native-t1');
    expect(view.backendStoreId).toBe(STORE);
    expect(view.env).toBeUndefined();
    expect(view.workspace).toBeUndefined();
    const client = view.clientAccess as Record<string, unknown>;
    expect(client.storeId).toBe('host-store');
    expect(typeof client.agentRef).toBe('string');
  });

  it('GET task subfeeds pass through the visible view', async () => {
    const { access } = harness();
    const out = await remote(access, 'GET', `${ROOT}/${STORE}/tasks/native-t1/output`);
    expect(out.status).toBe(200);
    expect((out.body as Record<string, unknown>).backendStoreId).toBe(STORE);
  });

  it('propagates source 4xx code and status through ok()', async () => {
    const { access, devices } = harness();
    devices.get('dev1')!.resources!.push(
      { kind: 'WORKER_LOCAL', backendStoreId: STORE, taskId: 'native-fail' });
    expect(await codeOf(remote(access, 'GET', `${ROOT}/${STORE}/tasks/native-fail`)))
      .toEqual({ code: 'CUSTOM_CODE', status: 422 });
  });

  it('enforces the resource grant and the identity pin', async () => {
    const { access } = harness();
    expect(await codeOf(remote(access, 'GET', `${ROOT}/${STORE}/tasks/native-other`)))
      .toEqual({ code: 'DEVICE_SCOPE_DENIED', status: 403 });
    fx.identityQueue.push(STORE, 'evil-store');
    expect(await codeOf(remote(access, 'GET', `${ROOT}/${STORE}/tasks/native-t1`)))
      .toEqual({ code: 'LOCAL_SOURCE_IDENTITY_CHANGED', status: 409 });
  });

  it('rejects malformed read query params like Java validateQuery', async () => {
    const { access } = harness();
    expect(await codeOf(remote(access, 'GET', `${ROOT}/${STORE}/tasks/native-t1/events`, null, null, 'cursor=abc')))
      .toEqual({ code: 'INVALID_REQUEST', status: 400 });
    expect(await codeOf(remote(access, 'GET', `${ROOT}/${STORE}/tasks/native-t1/events`, null, null, 'limit=200')))
      .toEqual({ code: 'INVALID_REQUEST', status: 400 });
  });
});

// ---- commands / messages / input responses -------------------------------------

describe('LocalTaskAccess inputs', () => {
  it.each(['STOP', 'PAUSE', 'RESUME'] as const)('dispatches command %s with guard checks', async (intent) => {
    const { access } = harness();
    const out = await remote(access, 'POST', `${ROOT}/${STORE}/tasks/native-t1/commands`,
      inputBody({ requestKey: `c-${intent}`, intent }), `c-${intent}`);
    expect(out.status).toBe(200);
    const view = out.body as Record<string, unknown>;
    expect(view.operation).toBe(intent);
    expect(view.state).toBe('OBSERVED');
    const posted = fx.posts('/local/v1/tasks/native-t1/commands').at(-1)!;
    expect(view.sourceRequestKey).toBe((posted.body as Record<string, unknown>).requestKey);
    expect((posted.body as Record<string, unknown>).intent).toBe(intent);
    expect((posted.body as Record<string, unknown>).requestKey).toMatch(/^mobile-/);
  });

  it('rejects unknown intents, stale guards and unsupported capabilities', async () => {
    const { access, devices } = harness();
    expect(await codeOf(remote(access, 'POST', `${ROOT}/${STORE}/tasks/native-t1/commands`,
      inputBody({ requestKey: 'c-x', intent: 'EXPLODE' }), 'c-x')))
      .toEqual({ code: 'OPERATION_NOT_ALLOWED', status: 403 });
    expect(await codeOf(remote(access, 'POST', `${ROOT}/${STORE}/tasks/native-t1/commands`,
      inputBody({ requestKey: 'c-y', intent: 'STOP', generation: 'stale' }), 'c-y')))
      .toEqual({ code: 'NATIVE_TARGET_CHANGED', status: 409 });
    fx.tasks['native-t1']!.capabilities = { stop: false };
    expect(await codeOf(remote(access, 'POST', `${ROOT}/${STORE}/tasks/native-t1/commands`,
      inputBody({ requestKey: 'c-z', intent: 'STOP' }), 'c-z')))
      .toEqual({ code: 'NATIVE_ACTION_UNSUPPORTED', status: 409 });
    devices.get('dev1')!.actions = ['OBSERVE'];
    expect(await codeOf(remote(access, 'POST', `${ROOT}/${STORE}/tasks/native-t1/commands`,
      inputBody({ requestKey: 'c-w', intent: 'STOP' }), 'c-w')))
      .toEqual({ code: 'DEVICE_SCOPE_DENIED', status: 403 });
  });

  it('command requests replay by Idempotency-Key without re-posting', async () => {
    const { access } = harness();
    const first = await remote(access, 'POST', `${ROOT}/${STORE}/tasks/native-t1/commands`,
      inputBody({ requestKey: 'c-1', intent: 'STOP' }), 'c-1');
    const posts = fx.posts('/local/v1/tasks/native-t1/commands').length;
    const replay = await remote(access, 'POST', `${ROOT}/${STORE}/tasks/native-t1/commands`,
      inputBody({ requestKey: 'c-1', intent: 'STOP' }), 'c-1');
    expect(replay.body).toEqual(first.body);
    expect(fx.posts('/local/v1/tasks/native-t1/commands').length).toBe(posts);
  });

  it('forwards model/effort on follow-up messages and keys drift on them', async () => {
    const { access } = harness();
    const out = await remote(access, 'POST', `${ROOT}/${STORE}/tasks/native-t1/messages`,
      inputBody({ requestKey: 'm-sw', kind: 'NATIVE_STEER', content: 'switch up', model: 'mimo-v2.6-pro', effort: 'high' }), 'm-sw');
    expect(out.status).toBe(200);
    const posted = fx.posts('/local/v1/tasks/native-t1/messages').at(-1)!.body as Record<string, unknown>;
    expect(posted.model).toBe('mimo-v2.6-pro');
    expect(posted.effort).toBe('high');
    expect(await codeOf(remote(access, 'POST', `${ROOT}/${STORE}/tasks/native-t1/messages`,
      inputBody({ requestKey: 'm-sw', kind: 'NATIVE_STEER', content: 'switch up', model: 'other' }), 'm-sw')))
      .toEqual({ code: 'IDEMPOTENCY_PAYLOAD_MISMATCH', status: 409 });
    // Commands and input responses do not carry a model selection.
    expect(await codeOf(remote(access, 'POST', `${ROOT}/${STORE}/tasks/native-t1/commands`,
      inputBody({ requestKey: 'c-m', intent: 'STOP', model: 'x' }), 'c-m')))
      .toEqual({ code: 'INVALID_REQUEST', status: 400 });
  });

  it('sends NATIVE_STEER messages when the task advertises steer', async () => {
    const { access } = harness();
    const out = await remote(access, 'POST', `${ROOT}/${STORE}/tasks/native-t1/messages`,
      inputBody({ requestKey: 'm-1', kind: 'NATIVE_STEER', content: 'keep going' }), 'm-1');
    expect((out.body as Record<string, unknown>).operation).toBe('NATIVE_STEER');
    fx.tasks['native-t1']!.capabilities = { steer: false };
    expect(await codeOf(remote(access, 'POST', `${ROOT}/${STORE}/tasks/native-t1/messages`,
      inputBody({ requestKey: 'm-2', kind: 'NATIVE_STEER', content: 'x' }), 'm-2')))
      .toEqual({ code: 'NATIVE_ACTION_UNSUPPORTED', status: 409 });
  });

  it('gates native text answers by explicit source contract and pending method', async () => {
    const { access } = harness();
    fx.pendingInputs['native-t1'] = [{ inputRequestId:'text-q', method:'input', state:'PENDING' }];
    const path = `${ROOT}/${STORE}/tasks/native-t1/input-requests/text-q/responses`;
    expect(await codeOf(remote(access,'POST',path,inputBody({requestKey:'text-old',response:{text:'Internal review'}}),'text-old'))).toEqual({code:'LOCAL_SOURCE_UPGRADE_REQUIRED',status:409});
    (fx.manifest as Record<string,unknown>).contracts=['worker-local/1','mac-native-input/1'];
    const answer=await remote(access,'POST',path,inputBody({requestKey:'text-ok',response:{text:'Internal review'}}),'text-ok');
    expect((answer.body as Record<string,unknown>).operation).toBe('INPUT_RESPONSE');
    (fx.manifest as Record<string,unknown>).contracts=['worker-local/1'];
    const replay=await remote(access,'POST',path,inputBody({requestKey:'text-ok',response:{text:'Internal review'}}),'text-ok');
    expect((replay.body as Record<string,unknown>).operation).toBe('INPUT_RESPONSE');
    (fx.manifest as Record<string,unknown>).contracts=['worker-local/1','mac-native-input/1'];
    fx.pendingInputs['native-t1'] = [{ inputRequestId:'text-q', method:'confirm', state:'PENDING' }];
    expect(await codeOf(remote(access,'POST',path,inputBody({requestKey:'text-wrong',response:{text:'x'}}),'text-wrong'))).toEqual({code:'NATIVE_INPUT_EXPIRED',status:409});
  });

  it('answers pending input requests and expires stale ones', async () => {
    const { access } = harness();
    fx.pendingInputs['native-t1'] = [
      { inputRequestId: 'ir-1', kind: 'confirm', state: 'PENDING', title: 'ok?' },
    ];
    const ok = await remote(access, 'POST',
      `${ROOT}/${STORE}/tasks/native-t1/input-requests/ir-1/responses`,
      inputBody({ requestKey: 'r-1', response: { confirmed: true } }), 'r-1');
    expect((ok.body as Record<string, unknown>).operation).toBe('INPUT_RESPONSE');
    // ir-9 is not pending upstream → NATIVE_INPUT_EXPIRED.
    expect(await codeOf(remote(access, 'POST',
      `${ROOT}/${STORE}/tasks/native-t1/input-requests/ir-9/responses`,
      inputBody({ requestKey: 'r-9', response: { confirmed: true } }), 'r-9')))
      .toEqual({ code: 'NATIVE_INPUT_EXPIRED', status: 409 });
    // malformed response envelope → INVALID_REQUEST.
    expect(await codeOf(remote(access, 'POST',
      `${ROOT}/${STORE}/tasks/native-t1/input-requests/ir-1/responses`,
      inputBody({ requestKey: 'r-b', response: { confirmed: true, value: 'x' } }), 'r-b')))
      .toEqual({ code: 'INVALID_REQUEST', status: 400 });
  });
});

// ---- owner surface / signal -----------------------------------------------------

describe('LocalTaskAccess owner + signal', () => {
  it('ownerCatalog returns projects, engines and launched tasks', async () => {
    const { access } = harness();
    const out = await access.ownerCatalog();
    expect(out.backendStoreId).toBe(STORE);
    expect((out.projects as unknown[]).length).toBe(2);
    expect((out.engines as unknown[]).length).toBe(2);
  });

  it('signal() maps pending inputs and terminal states', async () => {
    const { access, devices } = harness();
    const device = devices.get('dev1')!;
    const resource: Resource = { kind: 'WORKER_LOCAL', backendStoreId: STORE, taskId: 'native-t1' };
    fx.pendingInputs['native-t1'] = [
      { inputRequestId: 'ir-1', state: 'PENDING', title: 'confirm?' },
    ];
    fx.tasks['native-t1']!.state = 'FAILED';
    const read = await access.signal(device, resource, Date.now() + 5_000);
    const kinds = read.signals.map((s) => s.kind);
    expect(kinds).toContain('NEEDS_INPUT');
    expect(kinds).toContain('ATTENTION_REQUIRED');
  });
});

// ---- task-preflights + request history ---------------------------------------------

describe('LocalTaskAccess preflights + history', () => {
  it('POST task-preflights validates exact fields and returns the view', async () => {
    const { access } = harness();
    const out = await remote(access, 'POST', `${ROOT}/${STORE}/task-preflights`,
      { projectId: 'p1', engineId: 'pi' });
    expect(out.status).toBe(200);
    expect((out.body as Record<string, unknown>).backendStoreId).toBe(STORE);
    const posted = fx.posts('/local/v1/task-preflights').at(-1)!;
    expect(posted.body).toEqual({ projectId: 'p1', engineId: 'pi' });
    // Exact-fields + id() + launch scope all apply.
    expect(await codeOf(remote(access, 'POST', `${ROOT}/${STORE}/task-preflights`,
      { projectId: 'p1' }))).toEqual({ code: 'INVALID_REQUEST', status: 400 });
    expect(await codeOf(remote(access, 'POST', `${ROOT}/${STORE}/task-preflights`,
      { projectId: 'p1', engineId: 'pi', extra: 1 }))).toEqual({ code: 'INVALID_REQUEST', status: 400 });
    expect(await codeOf(remote(access, 'POST', `${ROOT}/${STORE}/task-preflights`,
      { projectId: 'p2', engineId: 'pi' }))).toEqual({ code: 'DEVICE_SCOPE_DENIED', status: 403 });
  });

  it('enforces the 128-record per-device request history limit', async () => {
    const { access, store } = harness();
    for (let i = 0; i < 128; i++) {
      store.put('local-launch', `dev1:seed-${i}`, {
        deviceId: 'dev1', clientKey: `seed-${i}`, sourceKey: `sk-${i}`,
        backendStoreId: STORE, taskId: `t${i}`, operation: 'LAUNCH',
        hash: `h${i}`, grantRevision: 7, state: 'OBSERVED',
      });
    }
    expect(await codeOf(remote(access, 'POST', `${ROOT}/${STORE}/tasks`,
      { requestKey: 'k-new', projectId: 'p1', engineId: 'pi', optionsRevision: 'r1', instruction: 'x' }, 'k-new')))
      .toEqual({ code: 'LOCAL_REQUEST_HISTORY_LIMIT', status: 429 });
    // Records from a different device do not count.
    const { access: access2, store: store2 } = harness();
    for (let i = 0; i < 128; i++) {
      store2.put('local-launch', `dev9:seed-${i}`, {
        deviceId: 'dev9', clientKey: `seed-${i}`, sourceKey: `sk-${i}`,
        backendStoreId: STORE, taskId: `t${i}`, operation: 'LAUNCH',
        hash: `h${i}`, grantRevision: 7, state: 'OBSERVED',
      });
    }
    const out = await remote(access2, 'POST', `${ROOT}/${STORE}/tasks`,
      { requestKey: 'k-new', projectId: 'p1', engineId: 'pi', optionsRevision: 'r1', instruction: 'x' }, 'k-new');
    expect(out.status).toBe(200);
    void store2;
  });
});

// ---- graphics ------------------------------------------------------------------------

const GFX_TASK = 'gfx-t1';
const gfxGuard = { generation: 'g1', nativeSessionId: 's1', segmentId: 'seg1', ownerEpoch: 'e1' };

function graphicsHarness() {
  const h = harness();
  const device = h.devices.get('dev1')!;
  device.actions = [...(device.actions ?? []), 'GRAPHICS_OBSERVE', 'GRAPHICS_CAPTURE'];
  device.launchScopes = [...(device.launchScopes ?? []),
    { backendStoreId: STORE, projectId: 'gproj', engineId: 'macos' }];
  device.resources = [...(device.resources ?? []),
    { kind: 'WORKER_LOCAL', backendStoreId: STORE, taskId: GFX_TASK }];
  fx.tasks[GFX_TASK] = {
    taskId: GFX_TASK, engineId: 'macos', projectId: 'gproj', state: 'RUNNING',
    recipeID: 'mac.app-workflow/1',
    generation: 'g1', nativeSessionId: 's1', segmentId: 'seg1', ownerEpoch: 'e1',
    graphicsObservationValid: true, graphicsObservationRevision: 'rev-7',
    graphicsProfile: { id: 'gproj' },
    remoteGraphicsEnabled: true,
  };
  (fx.manifest as Record<string, unknown>).contracts = ['worker-local/1', 'mac-graphics/1'];
  fx.preflightReplies['gproj|macos'] = {
    status: 200,
    body: {
      projectId: 'gproj', engineId: 'macos', profileId: 'MAC_MANAGED',
      profileHome: null, loadsUserExtensions: false, hasUncommittedChanges: false,
      workingCopyPolicy: 'REGISTERED_TARGET_ONLY', headRevision: null, treeRevision: null,
      registryDigest: 'a'.repeat(64), optionsRevision: 'r9',
      macProfile: {
        recipeID: 'mac.app-workflow/1', remoteGraphicsEnabled: true,
        graphicsProfile: { id: 'gproj' },
      },
    },
  };
  return h;
}

describe('LocalTaskAccess graphics', () => {
  it('POST observe dispatches to the exact upstream tail and recovers by request key', async () => {
    const { access, store } = graphicsHarness();
    const out = await remote(access, 'POST', `${ROOT}/${STORE}/tasks/${GFX_TASK}/graphics/observe`,
      { requestKey: 'k-g1', guard: gfxGuard }, 'k-g1');
    expect(out.status).toBe(200);
    const posted = fx.posts(`/local/v1/tasks/${GFX_TASK}/graphics/observe`).at(-1)!;
    // The upstream sees the deterministic source key, not the client key.
    expect((posted.body as Record<string, unknown>).requestKey).toMatch(/^mobile-[a-f0-9]{64}$/);
    const view = out.body as Record<string, unknown>;
    expect(view.operation).toBe('GRAPHICS_OBSERVE');
    expect(view.state).toBe('OBSERVED');
    expect(view.sourceRequestKey).toMatch(/^mobile-[a-f0-9]{64}$/);
    const ledger = store.get<Record<string, unknown>>('local-graphics', 'dev1:k-g1')!;
    expect(ledger.operation).toBe('GRAPHICS_OBSERVE');
    // Replay the same key → recoverGraphics → upstream interaction-requests GET.
    const sourceKey = ledger.sourceKey as string;
    const replay = await remote(access, 'POST', `${ROOT}/${STORE}/tasks/${GFX_TASK}/graphics/observe`,
      { requestKey: 'k-g1', guard: gfxGuard }, 'k-g1');
    expect(replay.status).toBe(200);
    const recovery = fx.gets(`/local/v1/tasks/${GFX_TASK}/interaction-requests/${sourceKey}`).at(-1);
    expect(recovery).toBeDefined();
    // Explicit recovery route reaches the same tail.
    const recovered = await remote(access, 'GET', `${ROOT}/${STORE}/tasks/${GFX_TASK}/graphics/requests/k-g1`);
    expect(recovered.status).toBe(200);
    // Payload drift under the same key is rejected before any upstream call.
    expect(await codeOf(remote(access, 'POST', `${ROOT}/${STORE}/tasks/${GFX_TASK}/graphics/observe`,
      { requestKey: 'k-g1', guard: { ...gfxGuard, generation: 'g2' } }, 'k-g1')))
      .toEqual({ code: 'IDEMPOTENCY_PAYLOAD_MISMATCH', status: 409 });
  });

  it('rejects stale guards, stale observation revisions and missing actions', async () => {
    const { access } = graphicsHarness();
    const captureBody = {
      requestKey: 'k-c1', guard: gfxGuard, observationRevision: 'rev-7',
    };
    // Stale guard → NATIVE_TARGET_CHANGED.
    expect(await codeOf(remote(access, 'POST', `${ROOT}/${STORE}/tasks/${GFX_TASK}/graphics/capture`,
      { ...captureBody, guard: { ...gfxGuard, ownerEpoch: 'e2' } }, 'k-c1')))
      .toEqual({ code: 'NATIVE_TARGET_CHANGED', status: 409 });
    // Stale observationRevision → NATIVE_TARGET_CHANGED.
    expect(await codeOf(remote(access, 'POST', `${ROOT}/${STORE}/tasks/${GFX_TASK}/graphics/capture`,
      { ...captureBody, observationRevision: 'rev-6' }, 'k-c1')))
      .toEqual({ code: 'NATIVE_TARGET_CHANGED', status: 409 });
    // GRAPHICS_ACT requires CONTROL + action scope; device lacks GRAPHICS_ACT.
    expect(await codeOf(remote(access, 'POST', `${ROOT}/${STORE}/tasks/${GFX_TASK}/graphics/actions`,
      { requestKey: 'k-a1', guard: gfxGuard, observationRevision: 'rev-7',
        action: 'press', elementIdentifier: 'btn-1' }, 'k-a1')))
      .toEqual({ code: 'DEVICE_SCOPE_DENIED', status: 403 });
    // Query is never allowed on graphics routes.
    expect(await codeOf(remote(access, 'GET', `${ROOT}/${STORE}/tasks/${GFX_TASK}/graphics/observations`,
      null, null, 'limit=1'))).toEqual({ code: 'INVALID_REQUEST', status: 400 });
  });
});

// ---- artifacts -----------------------------------------------------------------------

describe('LocalTaskAccess artifacts', () => {
  const bytes = Buffer.from('hello artifact', 'utf8');
  const b64 = bytes.toString('base64');
  const sha = createHash('sha256').update(bytes).digest('hex');
  const artifactId = `file-${sha}`;

  it('verifies bytes, sha256 and the published listing before returning the view', async () => {
    const { access } = harness();
    fx.artifactItems[`native-t1|${artifactId}`] = {
      status: 200,
      body: { artifactId, encoding: 'base64', bytes: b64, sha256: sha, path: 'out/report.bin' },
    };
    fx.artifactLists['native-t1'] = {
      status: 200,
      body: { items: [{ artifactId, status: 'AVAILABLE', path: 'out/report.bin', sha256: sha, size: bytes.length }] },
    };
    const out = await remote(access, 'GET', `${ROOT}/${STORE}/tasks/native-t1/artifacts/${artifactId}`);
    expect(out.status).toBe(200);
    // The listing re-read hit the exact upstream tail.
    expect(fx.gets('/local/v1/tasks/native-t1/artifacts').length).toBeGreaterThan(0);
  });

  it('verifies bounded chunk offsets and source manifest before forwarding', async () => {
    const { access } = harness();
    const piece = Buffer.alloc(262144, 65), total = 700001;
    const digest = 'a'.repeat(64), chunkId = `file-${'b'.repeat(64)}`;
    const key = `native-t1|${chunkId}/chunks/${digest}/0`;
    const chunk = { schemaVersion: 'mac-artifact-chunk/1', taskId: 'native-t1', artifactId: chunkId, sha256: digest, offset: 0, sizeBytes: String(total), chunkSHA256: createHash('sha256').update(piece).digest('hex'), encoding: 'base64', bytes: piece.toString('base64') };
    fx.artifactItems[key] = { status: 200, body: chunk };
    fx.artifactLists['native-t1'] = { status: 200, body: { items: [{ artifactId: chunkId, status: 'AVAILABLE_CHUNKED', transferMode: 'CHUNKS_V1', sha256: digest, sizeBytes: String(total) }] } };
    const path = `${ROOT}/${STORE}/tasks/native-t1/artifacts/${chunkId}/chunks/${digest}/0`;
    expect(((await remote(access, 'GET', path)).body as Record<string, unknown>).chunkSHA256).toBe(chunk.chunkSHA256);
    fx.artifactItems[key] = { status: 200, body: { ...chunk, offset: 1 } };
    expect(await codeOf(remote(access, 'GET', path))).toEqual({ code: 'LOCAL_ARTIFACT_INVALID', status: 502 });
    fx.artifactItems[key] = { status: 200, body: chunk };
    fx.artifactLists['native-t1'] = { status: 200, body: { items: [] } };
    expect(await codeOf(remote(access, 'GET', path))).toEqual({ code: 'LOCAL_ARTIFACT_CHANGED', status: 409 });
  });

  it('fails LOCAL_ARTIFACT_CHANGED on tampered bytes or a drifted listing', async () => {
    const { access } = harness();
    const good = { artifactId, encoding: 'base64', bytes: b64, sha256: sha, path: 'out/report.bin' };
    fx.artifactLists['native-t1'] = {
      status: 200,
      body: { items: [{ artifactId, status: 'AVAILABLE', path: 'out/report.bin', sha256: sha, size: bytes.length }] },
    };
    // sha256 does not match the decoded bytes.
    fx.artifactItems[`native-t1|${artifactId}`] = {
      status: 200, body: { ...good, bytes: Buffer.from('tampered').toString('base64') },
    };
    expect(await codeOf(remote(access, 'GET', `${ROOT}/${STORE}/tasks/native-t1/artifacts/${artifactId}`)))
      .toEqual({ code: 'LOCAL_ARTIFACT_CHANGED', status: 409 });
    // Listing drift (different path) → changed, not missing.
    fx.artifactItems[`native-t1|${artifactId}`] = { status: 200, body: good };
    fx.artifactLists['native-t1'] = {
      status: 200,
      body: { items: [{ artifactId, status: 'AVAILABLE', path: 'other.bin', sha256: sha, size: bytes.length }] },
    };
    expect(await codeOf(remote(access, 'GET', `${ROOT}/${STORE}/tasks/native-t1/artifacts/${artifactId}`)))
      .toEqual({ code: 'LOCAL_ARTIFACT_CHANGED', status: 409 });
    // Unknown artifact id → the upstream 404 propagates its own code.
    expect(await codeOf(remote(access, 'GET', `${ROOT}/${STORE}/tasks/native-t1/artifacts/${'b'.repeat(64)}`)))
      .toEqual({ code: 'NOT_FOUND', status: 404 });
    // A 2xx reply that violates the artifact binding → LOCAL_ARTIFACT_INVALID.
    fx.artifactItems[`native-t1|${artifactId}`] = {
      status: 200, body: { artifactId, encoding: 'binary', bytes: b64, sha256: sha, path: 'out/report.bin' },
    };
    expect(await codeOf(remote(access, 'GET', `${ROOT}/${STORE}/tasks/native-t1/artifacts/${artifactId}`)))
      .toEqual({ code: 'LOCAL_ARTIFACT_INVALID', status: 502 });
  });
});

describe('native material upload routing', () => {
  it('binds upload forwarding to the authenticated device revision', async () => {
    const {access}=harness();
    if (fx.manifest && typeof fx.manifest !== 'string') fx.manifest.contracts=['mac-material-uploads/1'];
    const body={requestKey:'material-key',name:'source.txt',sizeBytes:'12'};
    const out=await remote(access,'POST',`${ROOT}/${STORE}/tasks/native-t1/uploads`,body,'material-key');
    const expected=createHash('sha256').update('material|dev1|7').digest('hex');
    expect((out.body as Record<string,unknown>).principal).toBe(expected);
    const calls=fx.requests.filter(r=>r.method==='POST'&&r.url.endsWith('/uploads'));
    expect(calls).toHaveLength(1);expect(calls[0]?.body).toMatchObject({...body,principal:expected});
    await expect(remote(access,'POST',`${ROOT}/${STORE}/tasks/native-t1/uploads`,{...body,principal:'forged'},'material-key')).rejects.toMatchObject({code:'INVALID_REQUEST'});
  });
  it('refuses material writes when the source has no upload contract', async () => {
    const {access}=harness();
    if (fx.manifest && typeof fx.manifest !== 'string') fx.manifest.contracts=[];
    await expect(remote(access,'POST',`${ROOT}/${STORE}/tasks/native-t1/uploads`,{requestKey:'old-host'},'old-host')).rejects.toMatchObject({code:'LOCAL_SOURCE_UPGRADE_REQUIRED'});
    expect(fx.requests.filter(r=>r.method==='POST' && r.url.includes('/uploads'))).toHaveLength(0);
  });
  it('lists and cancels only the authorized material principal', async () => {
    const {access}=harness();
    if (fx.manifest && typeof fx.manifest !== 'string') fx.manifest.contracts=['mac-material-uploads/1','mac-material-upload-lifecycle/1'];
    await remote(access,'GET',`${ROOT}/${STORE}/tasks/native-t1/uploads`,null,null);
    await remote(access,'POST',`${ROOT}/${STORE}/tasks/native-t1/uploads/upload-id/cancel`,{requestKey:'cancel-key'},'cancel-key');
    const sent=fx.requests.filter(r=>r.method==='POST' && r.url.includes('/cancel'));
    expect(sent).toHaveLength(1);expect(sent[0]?.body).toMatchObject({principal:createHash('sha256').update('material|dev1|7').digest('hex')});
  });
  it('requires task scope and INTERACT before forwarding material bytes', async () => {
    const {access,devices}=harness();
    devices.get('dev1')!.actions=['OBSERVE'];
    await expect(remote(access,'POST',`${ROOT}/${STORE}/tasks/native-t1/uploads`,{requestKey:'k'},'k')).rejects.toBeInstanceOf(GatewayError);
    expect(fx.requests.filter(r=>r.url.includes('/uploads'))).toHaveLength(0);
    await expect(remote(access,'GET',`${ROOT}/${STORE}/tasks/foreign/uploads/id`,null,null)).rejects.toBeInstanceOf(GatewayError);
  });
});

describe('native workspace uploads + CONTINUE', () => {
  const uploadSourceKey = (clientKey: string, revision = 7): string =>
    'upload-' + hash(`host1|dev1|${revision}|${STORE}|p1|${clientKey}`);
  const pausedTask = (): Record<string, unknown> => ({
    taskId: 'native-t1', projectId: 'p1', recipeID: 'mac.native-work/1',
    nativeWorkSpec: { engine: 'OWNED_FRAMEWORK' },
    state: 'PAUSED_MATERIALS', materialPauseReady: true, quiescent: true, runtimeActive: false,
    generation: 'g1', nativeSessionId: 's1', nativeTurnId: 't9', currentCommandId: 'c3',
    capabilities: { continue: true },
  });

  it('forwards begin under the derived source key and returns the client key view', async () => {
    const { access, devices } = harness();
    devices.get('dev1')!.launchScopes = [{ backendStoreId: STORE, projectId: 'p1', engineId: 'macos' }];
    const result = await remote(access, 'POST', `${ROOT}/${STORE}/workspaces/p1/uploads/k1`,
      { requestKey: 'k1-begin', name: 'notes.md', sizeBytes: 4, sha256: 'a'.repeat(64) }, 'k1-begin');
    expect(result.status).toBe(200);
    const sourceKey = uploadSourceKey('k1');
    const posts = fx.posts(`/local/v1/native/v1/workspaces/p1/uploads/${sourceKey}`);
    expect(posts).toHaveLength(1);
    expect((posts[0]!.body as Record<string, unknown>).requestKey).toBe(`${sourceKey}-begin`);
    const view = result.body as Record<string, unknown>;
    expect(view.uploadKey).toBe('k1');
    expect(view.backendStoreId).toBe(STORE);
    expect(view.workspaceRef).toBe('p1');
    expect(view.state).toBe('OPEN');
  });

  it('chunks and seal share the source key with suffixed request keys', async () => {
    const { access, devices } = harness();
    devices.get('dev1')!.launchScopes = [{ backendStoreId: STORE, projectId: 'p1', engineId: 'macos' }];
    const data = Buffer.from('data');
    const digest = createHash('sha256').update(data).digest('hex');
    await remote(access, 'POST', `${ROOT}/${STORE}/workspaces/p1/uploads/k2/chunks`,
      { requestKey: 'k2-chunk-0', offset: 0, sha256: digest, dataBase64: data.toString('base64') }, 'k2-chunk-0');
    const sealed = await remote(access, 'POST', `${ROOT}/${STORE}/workspaces/p1/uploads/k2/seal`,
      { requestKey: 'k2-seal' }, 'k2-seal');
    const sourceKey = uploadSourceKey('k2');
    const chunks = fx.posts(`/local/v1/native/v1/workspaces/p1/uploads/${sourceKey}/chunks`);
    const seals = fx.posts(`/local/v1/native/v1/workspaces/p1/uploads/${sourceKey}/seal`);
    expect(chunks).toHaveLength(1);
    expect((chunks[0]!.body as Record<string, unknown>).requestKey).toBe(`${sourceKey}-chunk-0`);
    expect(seals).toHaveLength(1);
    expect((sealed.body as Record<string, unknown>).uploadKey).toBe('k2');
    expect((sealed.body as Record<string, unknown>).state).toBe('SEALED');
  });

  it('reads the upload view without a request body', async () => {
    const { access, devices } = harness();
    devices.get('dev1')!.launchScopes = [{ backendStoreId: STORE, projectId: 'p1', engineId: 'macos' }];
    const result = await remote(access, 'GET', `${ROOT}/${STORE}/workspaces/p1/uploads/k4`);
    expect(result.status).toBe(200);
    const view = result.body as Record<string, unknown>;
    expect(view.uploadKey).toBe('k4');
    expect(view.state).toBe('SEALED');
    expect(fx.gets(`/local/v1/native/v1/workspaces/p1/uploads/${uploadSourceKey('k4')}`)).toHaveLength(1);
  });

  it('rejects invalid descriptors, mismatched keys and denied launch scope', async () => {
    const { access, devices } = harness();
    devices.get('dev1')!.launchScopes = [{ backendStoreId: STORE, projectId: 'p1', engineId: 'macos' }];
    expect(await codeOf(remote(access, 'POST', `${ROOT}/${STORE}/workspaces/p1/uploads/k3`,
      { requestKey: 'k3-begin', name: 'evil.sh', sizeBytes: 4, sha256: 'a'.repeat(64) }, 'k3-begin')))
      .toEqual({ code: 'INVALID_MATERIAL', status: 400 });
    expect(await codeOf(remote(access, 'POST', `${ROOT}/${STORE}/workspaces/p1/uploads/k3`,
      { requestKey: 'k3-begin', name: 'ok.md', sizeBytes: 4, sha256: 'a'.repeat(64) }, 'wrong')))
      .toEqual({ code: 'IDEMPOTENCY_KEY_MISMATCH', status: 400 });
    devices.get('dev1')!.actions = ['OBSERVE', 'CONTROL'];
    await expect(remote(access, 'POST', `${ROOT}/${STORE}/workspaces/p1/uploads/k3`,
      { requestKey: 'k3-begin', name: 'ok.md', sizeBytes: 4, sha256: 'a'.repeat(64) }, 'k3-begin'))
      .rejects.toMatchObject({ code: 'DEVICE_SCOPE_DENIED' });
  });

  it('CONTINUE verifies each sealed upload and rewrites them to source keys', async () => {
    const { access, devices } = harness();
    devices.get('dev1')!.launchScopes = [{ backendStoreId: STORE, projectId: 'p1', engineId: 'macos' }];
    fx.tasks['native-t1'] = pausedTask();
    const result = await remote(access, 'POST', `${ROOT}/${STORE}/tasks/native-t1/commands`,
      inputBody({ requestKey: 'cont-1', intent: 'CONTINUE', sealedUploadKeys: ['mat-1', 'mat-2'] }), 'cont-1');
    expect(result.status).toBe(200);
    const expected = ['mat-1', 'mat-2'].map((item) => uploadSourceKey(item));
    for (const upload of expected) {
      expect(fx.gets(`/local/v1/native/v1/workspaces/p1/uploads/${upload}`).length).toBeGreaterThanOrEqual(1);
    }
    const posts = fx.posts('/local/v1/tasks/native-t1/commands');
    expect(posts).toHaveLength(1);
    const wire = posts[0]!.body as Record<string, unknown>;
    expect(wire.sealedUploadKeys).toEqual(expected);
    const view = result.body as Record<string, unknown>;
    expect(view.operation).toBe('CONTINUE');
    expect(view.sourceRequestKey).toBe(wire.requestKey);
    expect(view.requestKey).toBe('cont-1');
  });

  it('requires the material pause, sealed evidence and a CONTINUE intent', async () => {
    const { access, devices } = harness();
    devices.get('dev1')!.launchScopes = [{ backendStoreId: STORE, projectId: 'p1', engineId: 'macos' }];
    expect(await codeOf(remote(access, 'POST', `${ROOT}/${STORE}/tasks/native-t1/commands`,
      inputBody({ requestKey: 'bad-1', intent: 'PAUSE', sealedUploadKeys: ['m1'] }), 'bad-1')))
      .toEqual({ code: 'INVALID_REQUEST', status: 400 });
    expect(await codeOf(remote(access, 'POST', `${ROOT}/${STORE}/tasks/native-t1/commands`,
      inputBody({ requestKey: 'bad-2', intent: 'CONTINUE', sealedUploadKeys: ['m1', 'm1'] }), 'bad-2')))
      .toEqual({ code: 'INVALID_REQUEST', status: 400 });
    fx.tasks['native-t1'] = { ...pausedTask(), state: 'RUNNING', quiescent: false, materialPauseReady: false };
    expect(await codeOf(remote(access, 'POST', `${ROOT}/${STORE}/tasks/native-t1/commands`,
      inputBody({ requestKey: 'bad-3', intent: 'CONTINUE', sealedUploadKeys: ['m1'] }), 'bad-3')))
      .toEqual({ code: 'MATERIAL_PAUSE_REQUIRED', status: 409 });
    fx.tasks['native-t1'] = pausedTask();
    const open = uploadSourceKey('m2');
    fx.workspaceUploads[open] = {
      status: 200,
      body: {
        schemaVersion: 'mac-material-upload/1', uploadKey: open, workspaceRef: 'p1',
        name: 'n.md', sizeBytes: 4, sha256: 'a'.repeat(64), nextOffset: 0, state: 'OPEN',
      },
    };
    expect(await codeOf(remote(access, 'POST', `${ROOT}/${STORE}/tasks/native-t1/commands`,
      inputBody({ requestKey: 'bad-4', intent: 'CONTINUE', sealedUploadKeys: ['m2'] }), 'bad-4')))
      .toEqual({ code: 'MATERIAL_UPLOAD_UNCONFIRMED', status: 409 });
    expect(fx.posts('/local/v1/tasks/native-t1/commands')).toHaveLength(0);
  });
});

// ---- multi-backend routing --------------------------------------------------

/**
 * Two registered worker-local rows (the primary host plus a per-engine
 * companion): the path's backend storeId selects the upstream.
 * `managed-pi` is listed first to prove the primary is kept by connectionId,
 * not by registry ordering.
 */
function multiHarness(piUrl: string = baseUrl2) {
  fx.reset();
  fx2.reset();
  fx2.storeId = PI;
  const devices = new Map<string, Device>([['dev1', makeDevice()]]);
  const device = devices.get('dev1')!;
  device.resources = [...(device.resources ?? []), { kind: 'WORKER_LOCAL', backendStoreId: PI, taskId: 'pi-t1' }];
  device.launchScopes = [...(device.launchScopes ?? []), { backendStoreId: PI, projectId: 'p1', engineId: 'pi' }];
  const auth = new Auth(devices);
  const store = new Store();
  const rows: ConnectionRowLite[] = [
    { connectionId: 'managed-pi', kind: 'worker-local', baseUrl: piUrl, tokenRef: 'tok1' },
    { connectionId: 'this-mac', kind: 'worker-local', baseUrl, tokenRef: 'tok1' },
  ];
  const registry = {
    getConnection: (id: string) => rows.find((r) => r.connectionId === id),
    listConnections: () => rows,
  };
  const transport = new LocalTransport(registry, (ref) => (ref === 'tok1' ? TOKEN : undefined), fetch, 'this-mac');
  const access = new LocalTaskAccess(auth, transport, store);
  return { devices, store, transport, access };
}

describe('LocalTaskAccess multi-backend routing', () => {
  it('workerLocal() resolves the configured primary, not the first row', () => {
    const { transport } = multiHarness();
    expect(transport.workerLocal().connectionId).toBe('this-mac');
  });

  it('routes task reads to the host whose storeId matches the path backend', async () => {
    const { access } = multiHarness();
    const out = await remote(access, 'GET', `${ROOT}/${PI}/tasks/pi-t1`);
    expect(out.status).toBe(200);
    expect((out.body as Record<string, unknown>).backendStoreId).toBe(PI);
    expect(fx2.gets('/local/v1/tasks/pi-t1').length).toBeGreaterThanOrEqual(1);
    expect(fx.gets('/local/v1/tasks/pi-t1')).toHaveLength(0);
  });

  it('launches on the engine backend and appends the grant for that store', async () => {
    const { access, devices } = multiHarness();
    const out = await remote(access, 'POST', `${ROOT}/${PI}/tasks`,
      { requestKey: 'k1', projectId: 'p1', engineId: 'pi', optionsRevision: 'r1', instruction: 'go' }, 'k1');
    expect(out.status).toBe(200);
    expect(fx2.posts('/local/v1/tasks')).toHaveLength(1);
    expect(fx.posts('/local/v1/tasks')).toHaveLength(0);
    expect(scopeContains(devices.get('dev1')!, 'WORKER_LOCAL', PI, 'native-new1')).toBe(true);
  });

  it('fails IDENTITY_CHANGED when no registered host claims the backend store', async () => {
    const { access, devices } = multiHarness();
    const device = devices.get('dev1')!;
    device.resources = [...(device.resources ?? []), { kind: 'WORKER_LOCAL', backendStoreId: 'ghost-store', taskId: 'gx' }];
    expect(await codeOf(remote(access, 'GET', `${ROOT}/ghost-store/tasks/gx`)))
      .toEqual({ code: 'LOCAL_SOURCE_IDENTITY_CHANGED', status: 409 });
  });

  it('fails IDENTITY_CHANGED when the matched host claims a different store', async () => {
    const { access } = multiHarness();
    fx2.identityQueue.push('renamed-store');
    expect(await codeOf(remote(access, 'GET', `${ROOT}/${PI}/tasks/pi-t1`)))
      .toEqual({ code: 'LOCAL_SOURCE_IDENTITY_CHANGED', status: 409 });
  });

  it('reports an unreachable engine backend while the primary keeps serving', async () => {
    const { access } = multiHarness('http://127.0.0.1:1');
    expect(await codeOf(remote(access, 'GET', `${ROOT}/${PI}/tasks/pi-t1`)))
      .toEqual({ code: 'LOCAL_SOURCE_UNAVAILABLE', status: 503 });
    const out = await remote(access, 'GET', `${ROOT}/${STORE}/tasks/native-t1`);
    expect(out.status).toBe(200);
  });

  it('ownerCatalog merges every reachable backend with the primary first', async () => {
    const { access } = multiHarness();
    const catalog = await access.ownerCatalog();
    expect(catalog.backendStoreId).toBe(STORE);
    const backends = catalog.backends as { backendStoreId: string }[];
    expect(backends.map((b) => b.backendStoreId)).toEqual([STORE, PI]);
  });

  it('options serve the catalog of the backend named in the path', async () => {
    const { access } = multiHarness();
    const out = await remote(access, 'GET', `${ROOT}/${PI}/options`);
    expect(out.status).toBe(200);
    const body = out.body as Record<string, unknown>;
    expect(body.backendStoreId).toBe(PI);
    expect((body.projects as Record<string, unknown>[]).map((p) => p.projectId)).toEqual(['p1']);
    expect((body.engines as Record<string, unknown>[]).map((e) => e.engineId)).toEqual(['pi']);
    expect((body.launchScopes as unknown[]).length).toBe(2);
  });

  it('owner scope validation accepts launch scopes for engine backends', async () => {
    const { access } = multiHarness();
    await expect(access.validateOwnerResources([], [{ backendStoreId: PI, projectId: 'p1', engineId: 'pi' }]))
      .resolves.toBeUndefined();
    expect(fx2.posts('/local/v1/task-preflights')).toHaveLength(1);
    expect(fx.posts('/local/v1/task-preflights')).toHaveLength(0);
  });

  it('signal reads from the backend named by the resource', async () => {
    const { access, devices } = multiHarness();
    const read = await access.signal(
      devices.get('dev1')!,
      { kind: 'WORKER_LOCAL', backendStoreId: PI, taskId: 'pi-t1' },
      Date.now() + 5_000);
    expect(read.verifiedKinds.has('RESULT_READY')).toBe(true);
    expect(fx2.gets('/local/v1/tasks/pi-t1').length).toBeGreaterThanOrEqual(1);
    expect(fx.gets('/local/v1/tasks/pi-t1')).toHaveLength(0);
  });
});
