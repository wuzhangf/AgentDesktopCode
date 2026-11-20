/**
 * WorkHandoffAccess unit tests — the Java PersonalWorkHandoffService port.
 * Drives remote() directly against a fake store + scoped auth + scripted
 * native/ACS seams. Assertions key on phase derivation, idempotent replay,
 * honest pending states, sealing order and takeover evidence.
 */
import { createPrivateKey, generateKeyPairSync, sign as cryptoSign } from 'crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { fail, hash } from '../src/protocol.js';
import type { Device } from '../src/protocol.js';
import type {
  GatewayAuth, GatewayLocalTasks, GatewayStoreView, JsonObject, LocalTaskResult, OrderedRow,
} from '../src/context.js';
import { WorkHandoffAccess, type HandoffAcs, type HandoffAcsReply } from '../src/work-handoffs.js';

// ---------------------------------------------------------------------------
// Fakes — in-memory store, scoped auth, scripted native + ACS seams.
// ---------------------------------------------------------------------------

const memStore = (): GatewayStoreView & { dump: Map<string, Map<string, unknown>> } => {
  const dump = new Map<string, Map<string, unknown>>();
  const kind = (k: string) => {
    if (!dump.has(k)) dump.set(k, new Map());
    return dump.get(k)!;
  };
  const seqs = new Map<string, number>();
  let counter = 0;
  return {
    dump,
    get: <T>(k: string, i: string) => kind(k).get(i) as T | undefined,
    list: <T>(k: string) => [...kind(k).values()] as T[],
    put: (k, i, v) => { kind(k).set(i, v); },
    delete: (k, i) => { kind(k).delete(i); },
    putOrdered: (k, i, v) => {
      if (!kind(k).has(i)) seqs.set(`${k}:${i}`, ++counter);
      kind(k).set(i, v);
    },
    deleteOrdered: (k, i) => { kind(k).delete(i); seqs.delete(`${k}:${i}`); },
    sequence: (k, i) => seqs.get(`${k}:${i}`) ?? 0,
    listOrdered: <T>() => [] as OrderedRow<T>[],
    listOrderedForDevice: <T>() => [] as OrderedRow<T>[],
    listOrderedForDeviceSources: <T>() => [] as OrderedRow<T>[],
    listOrderedForSources: <T>() => [] as OrderedRow<T>[],
    transaction: <T>(fn: () => T) => fn(),
  };
};

const device = (over: Partial<Device> = {}): Device => ({
  id: 'dev-1',
  label: 'Pixel 8',
  state: 'ACTIVE',
  scopeVersion: 1,
  revision: 7,
  accessExpiry: Date.now() + 300_000,
  absoluteExpiry: Date.now() + 86_400_000,
  idleExpiry: Date.now() + 86_400_000,
  recoverUntil: 0,
  spentRefresh: [],
  sessions: ['s1'],
  actions: ['OBSERVE', 'INTERACT', 'CONTROL', 'CREATE', 'HANDOFF'],
  ...over,
});

const auth = (d: Device): GatewayAuth => ({
  request: () => fail('INVALID_REQUEST', 400),
  observePairing: () => fail('PAIRING_UNAUTHORIZED', 401),
  redeem: () => fail('PAIRING_UNAUTHORIZED', 401),
  refresh: () => fail('INVALID_REQUEST', 400),
  authenticate: (t) => (t === 'tok' ? d : fail('ACCESS_UNAUTHORIZED', 401)),
  authorize: (t, sid, action) => {
    if (t !== 'tok' || !(d.sessions ?? []).includes(sid) || !(d.actions ?? []).includes(action)) {
      fail('DEVICE_SCOPE_DENIED', 403);
    }
    return d;
  },
  authorizeDevice: () => d,
  authorizeLocal: () => d,
  authorizeLocalDevice: () => d,
  authorizeLaunch: () => d,
  activeDevices: () => [d],
  activeDevice: () => d,
  revoke: () => {},
  appendLaunchedTask: () => {},
  appendCreatedSession: () => {},
  authorizedScope: () => ({}),
  invitation: () => ({}),
  invitationResources: () => ({}),
  updateScope: () => ({}),
  updateScopeResources: () => ({}),
  devices: () => [],
  requests: () => [],
  ownerStatus: () => ({ personalHostId: 'host-1', storeId: 'acs-store' }),
  host: () => ({}),
  ensureHost: () => {},
});

type NativeReply = LocalTaskResult | (() => LocalTaskResult);

/** Scripted pinned worker: key `${backend} ${method} ${tail}` or
 *  `${backend} *`. Dynamic functions may mutate state across re-drives. */
const localFake = (replies: Map<string, NativeReply>) => {
  const calls: { backend: string; method: string; tail: string; body: unknown; key: string | undefined }[] = [];
  const hit = (backend: string, method: string, tail: string): LocalTaskResult => {
    const fn = replies.get(`${backend} ${method} ${tail}`) ?? replies.get(`${backend} *`);
    if (fn === undefined) return { status: 404, body: { code: 'REQUEST_NOT_FOUND' } };
    return typeof fn === 'function' ? fn() : fn;
  };
  const port: GatewayLocalTasks = {
    remote: () => fail('INVALID_REQUEST', 400),
    signal: () => fail('INVALID_REQUEST', 400),
    ownerCatalog: () => ({}),
    linkTargets: () => ({}),
    validateOwnerResources: () => {},
    verifyTaskEngine: () => {},
    recordedInput: () => false,
    nativeCall: (backend, method, tail, body, key) => {
      calls.push({ backend, method, tail, body, key });
      return hit(backend, method, tail);
    },
    nativeCallBytes: (backend, method, tail, body, _headers, key) => {
      calls.push({ backend, method, tail, body, key });
      return hit(backend, method, tail);
    },
    okNative: (r) => {
      if (r.status >= 200 && r.status < 300) return (r.body ?? {}) as JsonObject;
      const code = typeof (r.body as JsonObject | null)?.code === 'string'
        ? (r.body as JsonObject).code as string : 'LOCAL_SOURCE_UNAVAILABLE';
      fail(code, r.status >= 400 ? r.status : 502);
    },
  };
  return { port, calls };
};

const acsFake = (replies: Map<string, HandoffAcsReply | (() => HandoffAcsReply)>) => {
  const calls: { method: string; path: string; body: unknown; key: string | undefined }[] = [];
  const hit = (method: string, path: string): HandoffAcsReply => {
    const fn = replies.get(`${method} ${path}`) ?? replies.get(`${method} *`);
    if (fn === undefined) return { status: 404, body: { code: 'NOT_FOUND' } };
    return typeof fn === 'function' ? fn() : fn;
  };
  const port: HandoffAcs = {
    call: (_d, method, path, body, key) => {
      calls.push({ method, path, body, key });
      return hit(method, path);
    },
    callBytes: (_d, method, path, body, key) => {
      calls.push({ method, path, body, key });
      return hit(method, path);
    },
  };
  return { port, calls };
};

const rig = (nativeReplies: Map<string, NativeReply>, acsReplies = new Map<string, HandoffAcsReply | (() => HandoffAcsReply)>()) => {
  const dir = mkdtempSync(join(tmpdir(), 'wh-test-'));
  const store = memStore();
  const d = device();
  store.put('device', d.id, d);
  const local = localFake(nativeReplies);
  const acs = acsFake(acsReplies);
  const access = new WorkHandoffAccess(
    store, auth(d), acs.port, local.port, join(dir, 'materials'), join(dir, 'signing'), 'host-1');
  return { access, store, local, acs, device: d, dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
};

const CREATE_BODY: JsonObject = {
  requestKey: 'rk-1',
  sourceRef: { kind: 'WORKER_LOCAL', storeId: 'store-src', taskId: 't-src' },
  targetAgentRef: { kind: 'WORKER_LOCAL', hostKey: 'local', storeId: 'store-tgt', engineId: 'pi', projectRef: 'p2' },
  options: { title: 'move it' },
};

const expectError = async (p: Promise<unknown>, code: string, status: number) => {
  try {
    await p;
    expect.unreachable('expected failure');
  } catch (e) {
    const err = e as { code?: string; httpStatus?: number };
    expect(err.code).toBe(code);
    expect(err.httpStatus).toBe(status);
  }
};

const canonicalForProof = (value: unknown): unknown => Array.isArray(value)
  ? value.map(canonicalForProof)
  : value && typeof value === 'object'
    ? Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([key, entry]) => [key, canonicalForProof(entry)]))
    : value;

/** A frozen worker import fixture with a real peer signature and local target
 * preflight. The resolver tests intentionally bypass create/start so they can
 * exercise re-verification against durable state directly. */
const importedOriginFixture = async () => {
  const native = new Map<string, NativeReply>([
    ['store-tgt POST /task-preflights', { status: 200, body: { projectId: 'proj', engineId: 'pi', optionsRevision: 'opts-1' } }],
  ]);
  const fixture = rig(native);
  const sourcePair = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const sourcePublicKey = sourcePair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
  await fixture.access.registerPeer({ peerHostRef: 'source-host', kid: 'src-kid', publicKey: sourcePublicKey });
  const sourceRef = { kind: 'WORKER_LOCAL', storeId: 'store-src', taskId: 'task-src', engineId: 'pi' };
  const targetRef = { hostKey: 'host-1', kind: 'WORKER_LOCAL', storeId: 'store-tgt', engineId: 'pi', projectRef: 'proj' };
  const targetProofReply = await fixture.access.remote('tok', 'POST', ['target-preflights'], {
    requestKey: 'source-rk', sourceHostRef: 'source-host', sourceRef, targetAgentRef: targetRef,
  }, 'source-rk', null);
  const targetPreflight = targetProofReply.body as JsonObject;
  const bytes = Buffer.from('x', 'utf8');
  const item = { relName: 'handoff.md', type: 'DOC', sizeBytes: bytes.length, sha256: hash('handoff.md|' + hash('x') + ';'), role: 'REFERENCE_TEXT' };
  // itemsDigest() binds `relName|sha256;`, not file contents.
  item.sha256 = hash(bytes.toString('utf8'));
  const manifest: JsonObject = {
    schemaVersion: 'work-handoff/1', handoffId: 'wh-source', requestKey: 'source-rk', sourceRef,
    targetAgentRef: targetRef, targetPreflight, materialRevision: 3,
    materialDigest: hash(`${item.relName}|${item.sha256};`), items: [item],
    snapshotRange: { cursor: 'cursor-3', observedAt: Date.now() },
    phases: [{ phase: 'TARGET_STAGING', actionId: 'phase-1', at: Date.now() }],
    sourceSeal: { sealId: 'seal-source', state: 'SEALED', sealedAt: Date.now() },
  };
  const frozenBinding = `work-handoff-frozen/1|${hash(JSON.stringify(canonicalForProof(manifest)))}`;
  const sourcePrivateKey = createPrivateKey({ key: sourcePair.privateKey.export({ format: 'der', type: 'pkcs8' }), format: 'der', type: 'pkcs8' });
  const sealSignature = cryptoSign('sha256', Buffer.from(frozenBinding, 'utf8'), sourcePrivateKey).toString('base64');
  const imp = {
    importId: 'import-1', deviceId: 'dev-1', requestKey: 'import-rk', fingerprint: 'fp-1',
    manifestJson: JSON.stringify(manifest), manifestDigest: manifest.materialDigest as string,
    sourceHandoffId: 'wh-source', sourceSealRef: 'seal-source', sealBinding: frozenBinding,
    sourceHostRef: 'source-host', sourceKeyId: 'src-kid', sealScheme: 'RSA-SHA256-FROZEN-1', sealSignature,
    targetKind: 'WORKER_LOCAL', targetStoreId: 'store-tgt', targetEngineId: 'pi', targetProjectRef: 'proj',
    phase: 'STARTED', received: { 'handoff.md': 1 }, chunks: ['complete:handoff.md'], stagedRefs: {},
    targetTaskRef: 'task-target', targetOptionsRevision: 'opts-1', targetPolicyPresetId: undefined,
    evidenceAt: 0, receipts: [], spentKeys: [], grantRevision: fixture.device.revision,
    createdAt: Date.now(), updatedAt: Date.now(),
  };
  fixture.store.put('handoff-import', 'dev-1:import-1', imp);
  mkdirSync(join(fixture.dir, 'materials', 'imports', 'import-1'), { recursive: true });
  writeFileSync(join(fixture.dir, 'materials', 'imports', 'import-1', 'handoff.md'), bytes);
  return { ...fixture, imp, manifest, targetPreflight, sourcePrivateKey };
};

/** Full native script for a worker-local → worker-local takeover. */
const happyNative = (handoffId: string, did: string) => {
  const followKey = `mobile-${hash(`host-1:${did}:attach:${handoffId}`)}`;
  const launchKey = `mobile-${hash(`host-1:${did}:launch:${handoffId}`)}`;
  const sourceFacts = { taskId: 't-src', engineId: 'pi', projectId: 'p1', quiescent: true };
  const targetFacts = { taskId: 't-tgt', engineId: 'pi', state: 'SUCCEEDED', generation: 'g1' };
  let uploads = 0;
  const attached = new Set<string>();
  const replies = new Map<string, NativeReply>([
    ['store-src GET /tasks/t-src', { status: 200, body: sourceFacts }],
    ['store-src GET /tasks/t-src/messages?limit=100', {
      status: 200,
      body: { items: [{ sequence: '1', role: 'user', messageId: 'm1', text: 'hello' }], hasMore: false },
    }],
    ['store-src GET /tasks/t-src/auxiliary-sessions', { status: 200, body: { items: [] } }],
    ['store-src GET /tasks/t-src/collaborations', { status: 200, body: { items: [] } }],
    ['store-src GET /tasks/t-src/artifacts', { status: 200, body: { items: [] } }],
    ['store-src POST /tasks/t-src/source-seals', { status: 200, body: { sealId: 'seal-1', state: 'SEALED' } }],
    ['store-src GET /tasks/t-src/handoff-export', { status: 200, body: { schemaVersion: 'work-handoff/1', parts: [] } }],
    ['store-tgt POST /task-preflights', { status: 200, body: { projectId: 'p2', engineId: 'pi', optionsRevision: 'r1' } }],
    ['store-tgt POST /projects/p2/material-uploads', () => ({ status: 200, body: { uploadKey: `u-${++uploads}` } })],
    ['store-tgt POST /tasks', { status: 200, body: { taskId: 't-tgt' } }],
    ['store-tgt GET /tasks/t-tgt', { status: 200, body: targetFacts }],
  ]);
  const bytesHit = (backend: string, method: string, tail: string): LocalTaskResult | undefined => {
    if (method === 'PUT' && backend === 'store-tgt' && /\/material-uploads\/u-\d+\/chunks\/0/.test(tail)) {
      return { status: 200, body: {} };
    }
    if (method === 'POST' && backend === 'store-tgt' && /\/material-uploads\/u-\d+\/seal/.test(tail)) {
      return { status: 200, body: { materialRef: `mref-${tail.match(/u-\d+/)![0]}` } };
    }
    return undefined;
  };
  const taskReq = (backend: string, tail: string): LocalTaskResult | undefined => {
    if (backend === 'store-tgt' && tail.startsWith('/task-requests/')) {
      const key = tail.slice('/task-requests/'.length);
      return attached.has(key) ? { status: 200, body: { requestKey: key } } : { status: 404, body: { code: 'REQUEST_NOT_FOUND' } };
    }
    return undefined;
  };
  return { replies, followKey, launchKey, attached, bytesHit, taskReq, uploadsCount: () => uploads };
};

// ---------------------------------------------------------------------------
// Admission + idempotency.
// ---------------------------------------------------------------------------

describe('WorkHandoffAccess.create', () => {
  it('admits, replays the same requestKey, rejects a payload shift', async () => {
    const native = new Map<string, NativeReply>([
      ['store-src GET /tasks/t-src', { status: 200, body: { taskId: 't-src', engineId: 'pi' } }],
      ['store-tgt POST /task-preflights', { status: 200, body: { projectId: 'p2', engineId: 'pi' } }],
    ]);
    const { access, cleanup } = rig(native);
    try {
      const first = await access.remote('tok', 'POST', [], CREATE_BODY, 'rk-1', null);
      expect(first.status).toBe(201);
      const hid = (first.body as JsonObject).handoffId;
      expect(hid).toBe(`wh-${hash('dev-1:rk-1').slice(0, 32)}`);
      expect((first.body as JsonObject).phase).toBe('PREPARING');

      const replay = await access.remote('tok', 'POST', [], CREATE_BODY, 'rk-1', null);
      expect(replay.status).toBe(200);
      expect((replay.body as JsonObject).handoffId).toBe(hid);

      const shifted = { ...CREATE_BODY, options: { title: 'different' } };
      await expectError(access.remote('tok', 'POST', [], shifted, 'rk-1', null), 'IDEMPOTENCY_PAYLOAD_MISMATCH', 409);
      await expectError(
        access.remote('tok', 'POST', [], CREATE_BODY, 'rk-OTHER', null), 'IDEMPOTENCY_KEY_MISMATCH', 400);
    } finally { cleanup(); }
  });

  it('denies a device without HANDOFF scope', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wh-test-'));
    const store = memStore();
    const d = device({ actions: ['OBSERVE', 'INTERACT'] });
    store.put('device', d.id, d);
    const local = localFake(new Map());
    const acs = acsFake(new Map());
    const access = new WorkHandoffAccess(
      store, auth(d), acs.port, local.port, join(dir, 'materials'), join(dir, 'signing'), 'host-1');
    try {
      await expectError(access.remote('tok', 'POST', [], CREATE_BODY, 'rk-1', null), 'DEVICE_SCOPE_DENIED', 403);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('resolves a lost write by original requestKey', async () => {
    const { access, cleanup } = rig(new Map([
      ['store-src GET /tasks/t-src', { status: 200, body: { taskId: 't-src', engineId: 'pi' } }],
      ['store-tgt POST /task-preflights', { status: 200, body: { projectId: 'p2', engineId: 'pi' } }],
    ]));
    try {
      const first = await access.remote('tok', 'POST', [], CREATE_BODY, 'rk-1', null);
      const hid = (first.body as JsonObject).handoffId as string;
      const found = await access.remote('tok', 'GET', ['requests', 'rk-1'], null, null, null);
      expect(found.status).toBe(200);
      expect((found.body as JsonObject).handoffId).toBe(hid);
      expect((found.body as JsonObject).operation).toBe('WORK_HANDOFF');
      await expectError(access.remote('tok', 'GET', ['requests', 'rk-none'], null, null, null), 'NOT_FOUND', 404);
    } finally { cleanup(); }
  });
});

// ---------------------------------------------------------------------------
// Phase keys + cancel.
// ---------------------------------------------------------------------------

describe('WorkHandoffAccess phases', () => {
  const createIn = async (access: WorkHandoffAccess) => {
    const res = await access.remote('tok', 'POST', [], CREATE_BODY, 'rk-1', null);
    return (res.body as JsonObject).handoffId as string;
  };

  it('rejects a phase key that does not name the current phase', async () => {
    const { access, cleanup } = rig(new Map([
      ['store-src GET /tasks/t-src', { status: 200, body: { taskId: 't-src', engineId: 'pi' } }],
      ['store-tgt POST /task-preflights', { status: 200, body: { projectId: 'p2', engineId: 'pi' } }],
    ]));
    try {
      const hid = await createIn(access);
      await expectError(
        access.remote('tok', 'POST', [hid, 'continue'],
          { requestKey: 'handoff:rk-1:TARGET_STARTING' }, 'handoff:rk-1:TARGET_STARTING', null),
        'HANDOFF_KEY_PHASE_MISMATCH', 409);
      await expectError(
        access.remote('tok', 'POST', [hid, 'confirm'],
          { requestKey: 'handoff:rk-1:CONFIRM', expectedMaterialRevision: 1 },
          'handoff:rk-1:CONFIRM', null),
        'HANDOFF_PHASE_MISMATCH', 409);
    } finally { cleanup(); }
  });

  it('cancels cleanly before the source seals and replays the cancel', async () => {
    const { access, cleanup } = rig(new Map([
      ['store-src GET /tasks/t-src', { status: 200, body: { taskId: 't-src', engineId: 'pi' } }],
      ['store-tgt POST /task-preflights', { status: 200, body: { projectId: 'p2', engineId: 'pi' } }],
    ]));
    try {
      const hid = await createIn(access);
      const res = await access.remote('tok', 'POST', [hid, 'cancel'],
        { requestKey: 'handoff:rk-1:CANCEL' }, 'handoff:rk-1:CANCEL', null);
      expect(res.status).toBe(200);
      expect((res.body as JsonObject).phase).toBe('CANCELLED');
      const replay = await access.remote('tok', 'POST', [hid, 'cancel'],
        { requestKey: 'handoff:rk-1:CANCEL' }, 'handoff:rk-1:CANCEL', null);
      expect(replay.status).toBe(200);
      expect((replay.body as JsonObject).phase).toBe('CANCELLED');
    } finally { cleanup(); }
  });
});

// ---------------------------------------------------------------------------
// Full worker-local → worker-local takeover.
// ---------------------------------------------------------------------------

describe('WorkHandoffAccess takeover', () => {
  it('drives collect→confirm→seal→finalize→stage→start→TAKEN_OVER with evidence', async () => {
    // handoffId is deterministic — compute before scripting replies.
    const hid = `wh-${hash('dev-1:rk-1').slice(0, 32)}`;
    const happy = happyNative(hid, 'dev-1');
    const { access, local, cleanup } = rig(happy.replies);
    // Route byte/regex hits through a composite native fake.
    const base = local.port;
    const composite: GatewayLocalTasks = {
      ...base,
      nativeCall: (backend, method, tail, body, key) => {
        const viaTaskReq = method === 'GET' ? happy.taskReq(backend, tail) : undefined;
        if (viaTaskReq !== undefined) {
          local.calls.push({ backend, method, tail, body, key });
          return viaTaskReq;
        }
        const viaBytes = happy.bytesHit(backend, method, tail);
        if (viaBytes !== undefined) {
          local.calls.push({ backend, method, tail, body, key });
          return viaBytes;
        }
        return base.nativeCall(backend, method, tail, body, key);
      },
      nativeCallBytes: (backend, method, tail, body, headers, key) => {
        const viaBytes = happy.bytesHit(backend, method, tail);
        if (viaBytes !== undefined) {
          local.calls.push({ backend, method, tail, body, key });
          return viaBytes;
        }
        return base.nativeCallBytes(backend, method, tail, body, headers, key);
      },
    };
    const dir = mkdtempSync(join(tmpdir(), 'wh-test-'));
    const store = memStore();
    const d = device();
    store.put('device', d.id, d);
    const acs = acsFake(new Map());
    const svc = new WorkHandoffAccess(
      store, auth(d), acs.port, composite, join(dir, 'materials'), join(dir, 'signing'), 'host-1');
    try {
      const cont = (phase: string, key: string, body?: JsonObject) =>
        svc.remote('tok', 'POST', [hid, 'continue'], { requestKey: key, ...(body ?? {}) }, key, null);
      void cont;

      const created = await svc.remote('tok', 'POST', [], CREATE_BODY, 'rk-1', null);
      expect(created.status).toBe(201);
      expect(hid).toBe((created.body as JsonObject).handoffId);

      // PREPARING is a two-step pendingStep machine: COLLECT then DOC.
      const afterCollect = await svc.remote('tok', 'POST', [hid, 'continue'],
        { requestKey: 'handoff:rk-1:PREPARING' }, 'handoff:rk-1:PREPARING', null);
      expect((afterCollect.body as JsonObject).phase).toBe('PREPARING');
      const awaiting = await svc.remote('tok', 'POST', [hid, 'continue'],
        { requestKey: 'handoff:rk-1:PREPARING' }, 'handoff:rk-1:PREPARING', null);
      expect((awaiting.body as JsonObject).phase).toBe('AWAITING_CONFIRM');
      const candidateRev = (awaiting.body as JsonObject).candidateMaterialRevision
        ?? (awaiting.body as JsonObject).materialRevision;
      void candidateRev;

      // Spent PREPARING key replays without re-collecting.
      const replayed = await svc.remote('tok', 'POST', [hid, 'continue'],
        { requestKey: 'handoff:rk-1:PREPARING' }, 'handoff:rk-1:PREPARING', null);
      expect((replayed.body as JsonObject).phase).toBe('AWAITING_CONFIRM');

      const confirmed = await svc.remote('tok', 'POST', [hid, 'confirm'],
        { requestKey: 'handoff:rk-1:CONFIRM', expectedMaterialRevision: 1 },
        'handoff:rk-1:CONFIRM', null);
      expect((confirmed.body as JsonObject).phase).toBe('SOURCE_SEALING');

      // Seal: preflight target (already scripted), pi quiescent → source-seals.
      const sealed = await svc.remote('tok', 'POST', [hid, 'continue'],
        { requestKey: 'handoff:rk-1:SOURCE_SEALING' }, 'handoff:rk-1:SOURCE_SEALING', null);
      expect((sealed.body as JsonObject).phase).toBe('FINALIZING_MATERIALS');

      const finalized = await svc.remote('tok', 'POST', [hid, 'continue'],
        { requestKey: 'handoff:rk-1:FINALIZING_MATERIALS' }, 'handoff:rk-1:FINALIZING_MATERIALS', null);
      expect((finalized.body as JsonObject).phase).toBe('TARGET_STAGING');

      const staged = await svc.remote('tok', 'POST', [hid, 'continue'],
        { requestKey: 'handoff:rk-1:TARGET_STAGING' }, 'handoff:rk-1:TARGET_STAGING', null);
      expect((staged.body as JsonObject).phase).toBe('TARGET_STARTING');
      expect(happy.uploadsCount()).toBeGreaterThan(0);

      // First start continues: launch + follow-up + evidence probe.
      // Evidence needs the assistant turn under the follow-up key — extend
      // the messages reply before driving.
      happy.replies.set('store-tgt GET /tasks/t-tgt/messages', {
        status: 200,
        body: {
          turns: {
            [happy.followKey]: { state: 'SUCCEEDED', nativeTurnId: 'nt-9' },
            [happy.launchKey]: { state: 'SUCCEEDED', nativeTurnId: 'nt-1' },
          },
          items: [{ role: 'assistant', commandId: happy.followKey, messageId: 'a1', text: 'done' }],
        },
      });
      const started = await svc.remote('tok', 'POST', [hid, 'continue'],
        { requestKey: 'handoff:rk-1:TARGET_STARTING' }, 'handoff:rk-1:TARGET_STARTING', null);
      expect((started.body as JsonObject).phase).toBe('TAKEN_OVER');
      expect((started.body as JsonObject).targetTaskRef).toBe('t-tgt');

      // A spent phase key on a terminal record still replays the view.
      const replay = await svc.remote('tok', 'POST', [hid, 'continue'],
        { requestKey: 'handoff:rk-1:TARGET_STARTING' }, 'handoff:rk-1:TARGET_STARTING', null);
      expect((replay.body as JsonObject).phase).toBe('TAKEN_OVER');

      // Cancel on TAKEN_OVER never rolls the target back: the record marks
      // requiresReverseHandoff and retains the running target (R34).
      const declined = await svc.remote('tok', 'POST', [hid, 'cancel'],
        { requestKey: 'handoff:rk-1:CANCEL' }, 'handoff:rk-1:CANCEL', null);
      expect(declined.status).toBe(200);
      expect((declined.body as JsonObject).phase).toBe('TAKEN_OVER');
      expect((declined.body as JsonObject).requiresReverseHandoff).toBe(true);
    } finally { cleanup(); rmSync(dir, { recursive: true, force: true }); }
  });

  it('stays honestly pending while target consumption is unproven', async () => {
    const hid = `wh-${hash('dev-1:rk-1').slice(0, 32)}`;
    const happy = happyNative(hid, 'dev-1');
    // Evidence read returns no matching turn → TARGET_VERIFY_PENDING.
    happy.replies.set('store-tgt GET /tasks/t-tgt/messages', { status: 200, body: { turns: {}, items: [] } });
    const dir = mkdtempSync(join(tmpdir(), 'wh-test-'));
    const store = memStore();
    const d = device();
    store.put('device', d.id, d);
    const base = localFake(happy.replies).port;
    const calls: { backend: string; method: string; tail: string }[] = [];
    const composite: GatewayLocalTasks = {
      ...base,
      nativeCall: (backend, method, tail, body, key) => {
        calls.push({ backend, method, tail });
        const viaTaskReq = method === 'GET' ? happy.taskReq(backend, tail) : undefined;
        if (viaTaskReq !== undefined) return viaTaskReq;
        const viaBytes = happy.bytesHit(backend, method, tail);
        if (viaBytes !== undefined) return viaBytes;
        return base.nativeCall(backend, method, tail, body, key);
      },
      nativeCallBytes: (backend, method, tail, body, headers, key) => {
        const viaBytes = happy.bytesHit(backend, method, tail);
        if (viaBytes !== undefined) return viaBytes;
        return base.nativeCallBytes(backend, method, tail, body, headers, key);
      },
    };
    const acs = acsFake(new Map());
    const svc = new WorkHandoffAccess(
      store, auth(d), acs.port, composite, join(dir, 'materials'), join(dir, 'signing'), 'host-1');
    try {
      await svc.remote('tok', 'POST', [], CREATE_BODY, 'rk-1', null);
      const drive = async (key: string) =>
        svc.remote('tok', 'POST', [hid, 'continue'], { requestKey: key }, key, null);
      await drive('handoff:rk-1:PREPARING');
      await drive('handoff:rk-1:PREPARING');
      await svc.remote('tok', 'POST', [hid, 'confirm'],
        { requestKey: 'handoff:rk-1:CONFIRM', expectedMaterialRevision: 1 },
        'handoff:rk-1:CONFIRM', null);
      await drive('handoff:rk-1:SOURCE_SEALING');
      await drive('handoff:rk-1:FINALIZING_MATERIALS');
      await drive('handoff:rk-1:TARGET_STAGING');
      const started = await drive('handoff:rk-1:TARGET_STARTING');
      const body = started.body as JsonObject;
      expect(body.phase).toBe('TARGET_STARTING');
      expect(body.pendingReason).toBe('TARGET_VERIFY_PENDING');
      expect(body.targetTaskRef).toBe('t-tgt');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('WorkHandoffAccess.resolveImportedOrigin', () => {
  it('returns a sanitized exact source round and bounded local-copy evidence', async () => {
    const f = await importedOriginFixture();
    try {
      const resolved = await f.access.resolveImportedOrigin('import-1', 'store-tgt', 'task-target');
      expect(resolved.sourceHostRef).toBe('source-host');
      expect(resolved.sourceKeyId).toBe('src-kid');
      expect(resolved.sourceHandoffId).toBe('wh-source');
      expect(resolved.sourceStoreId).toBe('store-src');
      expect(resolved.sourceTaskId).toBe('task-src');
      expect(resolved.manifestDigest).toBe(f.imp.manifestDigest);
      expect(resolved.publicFacts.schemaVersion).toBe('xagt-origin/1');
      expect((resolved.publicFacts.target as JsonObject).taskId).toBe('task-target');
      expect(resolved.publicFacts.availableLocalCopies).toBe(1);
      const materials = resolved.publicFacts.materials as JsonObject[];
      expect(materials[0].availableLocally).toBe(true);
      expect(materials[0].boundedDigestVerified).toBe(true);
      expect(materials[0].path).toBeUndefined();
      expect(resolved.publicFacts.targetLaunchWire).toBeUndefined();
    } finally { f.cleanup(); }
  });

  it('keeps the original signed audience after the launch appends the target scope', async () => {
    const f = await importedOriginFixture();
    try {
      const live = { ...f.imp, grantRevision: f.imp.grantRevision + 1, targetLaunchTaskRef: 'task-target' };
      f.store.put('handoff-import', 'dev-1:import-1', { ...live, admittedGrantRevision: f.imp.grantRevision });
      await expect(f.access.resolveImportedOrigin('import-1', 'store-tgt', 'task-target')).resolves.toBeDefined();
      f.store.put('handoff-import', 'dev-1:import-1', live);
      await expect(f.access.resolveImportedOrigin('import-1', 'store-tgt', 'task-target')).resolves.toBeDefined();
      f.store.put('handoff-import', 'dev-1:import-1', { ...live, grantRevision: live.grantRevision + 1 });
      await expectError(f.access.resolveImportedOrigin('import-1', 'store-tgt', 'task-target'), 'HANDOFF_TARGET_PREFLIGHT_INVALID', 403);
    } finally { f.cleanup(); }
  });

  it('rejects forged issuer, audience, round/digest, and retired imports', async () => {
    const issuer = await importedOriginFixture();
    try {
      (issuer.imp as { sourceKeyId: string }).sourceKeyId = 'untrusted-kid';
      issuer.store.put('handoff-import', 'dev-1:import-1', issuer.imp);
      await expectError(issuer.access.resolveImportedOrigin('import-1', 'store-tgt', 'task-target'), 'PEER_NOT_TRUSTED', 403);
    } finally { issuer.cleanup(); }

    const audience = await importedOriginFixture();
    try {
      const changed = structuredClone(audience.manifest) as JsonObject;
      (changed.targetPreflight as JsonObject).targetDeviceId = 'other-device';
      audience.imp.manifestJson = JSON.stringify(changed);
      audience.imp.sealBinding = `work-handoff-frozen/1|${hash(JSON.stringify(canonicalForProof(changed)))}`;
      audience.imp.sealSignature = cryptoSign('sha256', Buffer.from(audience.imp.sealBinding, 'utf8'), audience.sourcePrivateKey).toString('base64');
      audience.store.put('handoff-import', 'dev-1:import-1', audience.imp);
      await expectError(audience.access.resolveImportedOrigin('import-1', 'store-tgt', 'task-target'), 'HANDOFF_TARGET_PREFLIGHT_INVALID', 403);
    } finally { audience.cleanup(); }

    const round = await importedOriginFixture();
    try {
      const changed = structuredClone(round.manifest) as JsonObject;
      changed.requestKey = 'different-round';
      round.imp.manifestJson = JSON.stringify(changed);
      round.imp.sealBinding = `work-handoff-frozen/1|${hash(JSON.stringify(canonicalForProof(changed)))}`;
      round.imp.sealSignature = cryptoSign('sha256', Buffer.from(round.imp.sealBinding, 'utf8'), round.sourcePrivateKey).toString('base64');
      round.store.put('handoff-import', 'dev-1:import-1', round.imp);
      await expectError(round.access.resolveImportedOrigin('import-1', 'store-tgt', 'task-target'), 'HANDOFF_TARGET_PREFLIGHT_INVALID', 403);
    } finally { round.cleanup(); }

    const digest = await importedOriginFixture();
    try {
      const changed = structuredClone(digest.manifest) as JsonObject;
      changed.materialDigest = hash('forged-material-round');
      digest.imp.manifestJson = JSON.stringify(changed);
      digest.imp.sealBinding = `work-handoff-frozen/1|${hash(JSON.stringify(canonicalForProof(changed)))}`;
      digest.imp.sealSignature = cryptoSign('sha256', Buffer.from(digest.imp.sealBinding, 'utf8'), digest.sourcePrivateKey).toString('base64');
      digest.store.put('handoff-import', 'dev-1:import-1', digest.imp);
      await expectError(digest.access.resolveImportedOrigin('import-1', 'store-tgt', 'task-target'), 'MANIFEST_INVALID', 422);
    } finally { digest.cleanup(); }

    const retired = await importedOriginFixture();
    try {
      (retired.imp as { retirementProof?: JsonObject }).retirementProof = { state: 'RETIRED', retiredAt: Date.now() };
      retired.store.put('handoff-import', 'dev-1:import-1', retired.imp);
      await expectError(retired.access.resolveImportedOrigin('import-1', 'store-tgt', 'task-target'), 'HANDOFF_IMPORT_CANCELLED', 409);
    } finally { retired.cleanup(); }
  });
});
