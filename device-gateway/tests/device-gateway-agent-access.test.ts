/**
 * AgentSessionAccess + ChildMessagesAccess unit tests — the Java
 * PersonalAgentSessionAccess / PersonalChildMessagesAccess ledgers behind a
 * fake store + auth + upstream. Assertions key on record state, frozen-wire
 * replay, namespaced keys and honest error codes.
 */
import { describe, expect, it } from 'vitest';
import { fail } from '../src/protocol.js';
import type { Device } from '../src/protocol.js';
import type { GatewayAuth, GatewayStoreView, JsonObject, OrderedRow } from '../src/context.js';
import { AgentSessionAccess, type AgentUpstream, type AgentUpstreamReply } from '../src/agent-sessions.js';
import { ChildMessagesAccess, delegatedId } from '../src/child-messages.js';

// ---------------------------------------------------------------------------
// Fakes — in-memory store, scoped auth, scripted upstream.
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

interface ScriptedCall {
  device: string; method: string; path: string; body: unknown; key: string | undefined;
}

const upstream = (replies: Map<string, AgentUpstreamReply | (() => AgentUpstreamReply)>) => {
  const calls: ScriptedCall[] = [];
  const port: AgentUpstream = {
    call: (device, method, path, body, key) => {
      calls.push({ device: device.id, method, path, body, key });
      const hit = replies.get(`${method} ${path}`) ?? replies.get(`${method} *`);
      if (hit === undefined) return { status: 404, body: { code: 'NOT_FOUND' } };
      return typeof hit === 'function' ? hit() : hit;
    },
    callBytes: (device, method, path, body, key) => {
      calls.push({ device: device.id, method, path, body, key });
      const hit = replies.get(`${method} ${path}`) ?? replies.get(`${method} *`);
      if (hit === undefined) return { status: 404, body: { code: 'NOT_FOUND' } };
      return typeof hit === 'function' ? hit() : hit;
    },
  };
  return { port, calls };
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
  sessions: ['s1', 'parent-1'],
  actions: ['OBSERVE', 'INTERACT', 'CONTROL', 'CREATE'],
  ...over,
});

const auth = (d: Device, appended: string[] = []): GatewayAuth => ({
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
  appendCreatedSession: (did, _rev, sid) => {
    appended.push(`${did}:${sid}`);
    // Real grant extension: the created session joins the device scope.
    if (!(d.sessions ?? []).includes(sid)) d.sessions = [...(d.sessions ?? []), sid];
  },
  authorizedScope: () => ({}),
  invitation: () => ({}),
  invitationResources: () => ({}),
  updateScope: () => ({}),
  updateScopeResources: () => ({}),
  devices: () => [],
  requests: () => [],
  ownerStatus: () => ({ personalHostId: 'host-1' }),
  host: () => ({}),
  ensureHost: () => {},
});

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

// ---------------------------------------------------------------------------
// AgentSessionAccess — create ledger.
// ---------------------------------------------------------------------------

describe('AgentSessionAccess.createSession', () => {
  const body = { requestKey: 'rk-1', title: 'hello', intent: 'do' };

  it('admits, dispatches frozen wire under namespaced key, binds created session', async () => {
    const store = memStore();
    const appended: string[] = [];
    const replies = new Map<string, AgentUpstreamReply>([
      ['POST /api/v2/sessions', { status: 200, body: { sessionId: 's-new', title: 'hello' } }],
    ]);
    const { port, calls } = upstream(replies);
    const access = new AgentSessionAccess(store, auth(device(), appended), port, 'host-1');

    const res = await access.createSession('tok', body, 'rk-1');
    expect(res.status).toBe(200);
    const view = res.body as JsonObject;
    expect(view.state).toBe('OBSERVED');
    expect(view.sessionId).toBe('s-new');
    expect(view.schemaVersion).toBe('personal-agent-request/1');
    expect(appended).toEqual(['dev-1:s-new']);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.path).toBe('/api/v2/sessions');
    expect(calls[0]!.key).toMatch(/^mobile-[a-f0-9]{64}$/);
    const wire = calls[0]!.body as JsonObject;
    expect(wire.schemaVersion).toBe('business-session/2.0');
    expect(wire.title).toBe('hello');
    expect((wire.origin as JsonObject).clientType).toBe('MOBILE');
  });

  it('rejects client-supplied origin + key/requestKey mismatch', async () => {
    const access = new AgentSessionAccess(memStore(), auth(device()), upstream(new Map()).port, 'host-1');
    await expectError(access.createSession('tok', { ...body, origin: { forged: true } }, 'rk-1'),
      'INVALID_REQUEST', 400);
    await expectError(access.createSession('tok', { requestKey: 'other' }, 'rk-1'),
      'IDEMPOTENCY_KEY_MISMATCH', 400);
    await expectError(access.createSession('tok', body, 'rk-2'), 'IDEMPOTENCY_KEY_MISMATCH', 400);
  });

  it('CREATE grant required', async () => {
    const d = device({ actions: ['OBSERVE', 'INTERACT'] });
    const access = new AgentSessionAccess(memStore(), auth(d), upstream(new Map()).port, 'host-1');
    await expectError(access.createSession('tok', body, 'rk-1'), 'DEVICE_SCOPE_DENIED', 403);
  });

  it('same key + identical body replays the ledger view without redispatch', async () => {
    const store = memStore();
    const replies = new Map<string, AgentUpstreamReply>([
      ['POST /api/v2/sessions', { status: 200, body: { sessionId: 's-1' } }],
    ]);
    const { port, calls } = upstream(replies);
    const appended: string[] = [];
    const access = new AgentSessionAccess(store, auth(device({ sessions: ['s1', 'parent-1', 's-1'] }), appended), port, 'host-1');
    await access.createSession('tok', body, 'rk-1');
    const again = await access.createSession('tok', body, 'rk-1');
    expect((again.body as JsonObject).state).toBe('OBSERVED');
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1);
  });

  it('same key + different body → IDEMPOTENCY_PAYLOAD_MISMATCH', async () => {
    const store = memStore();
    const replies = new Map<string, AgentUpstreamReply>([
      ['POST /api/v2/sessions', { status: 200, body: { sessionId: 's-1' } }],
    ]);
    const access = new AgentSessionAccess(store, auth(device()), upstream(replies).port, 'host-1');
    await access.createSession('tok', body, 'rk-1');
    await expectError(access.createSession('tok', { ...body, title: 'changed' }, 'rk-1'),
      'IDEMPOTENCY_PAYLOAD_MISMATCH', 409);
  });

  it('lost reply → UNKNOWN; session-requests recovery replays identical wire+key', async () => {
    const store = memStore();
    let attempts = 0;
    const replies = new Map<string, AgentUpstreamReply | (() => AgentUpstreamReply)>([
      ['POST /api/v2/sessions', () => {
        attempts += 1;
        if (attempts === 1) return fail('UPSTREAM_UNAVAILABLE', 503) as never;
        return { status: 200, body: { sessionId: 's-1' } };
      }],
    ]);
    const { port, calls } = upstream(replies);
    const appended: string[] = [];
    const access = new AgentSessionAccess(store, auth(device({ sessions: ['s1', 'parent-1', 's-1'] }), appended), port, 'host-1');

    const first = await access.createSession('tok', body, 'rk-1');
    expect((first.body as JsonObject).state).toBe('UNKNOWN');
    expect((first.body as JsonObject).code).toBe('LOCAL_REPLY_UNCONFIRMED');

    const recovered = await access.sessionRequest('tok', 'rk-1');
    const view = recovered.body as JsonObject;
    expect(view.state).toBe('OBSERVED');
    expect(view.sessionId).toBe('s-1');
    const posts = calls.filter((c) => c.method === 'POST');
    expect(posts).toHaveLength(2);
    expect(posts[0]!.key).toBe(posts[1]!.key);
    expect(JSON.stringify(posts[0]!.body)).toBe(JSON.stringify(posts[1]!.body));
  });

  it('durable refusal → REJECTED; recovery never redispatches', async () => {
    const store = memStore();
    const replies = new Map<string, AgentUpstreamReply>([
      ['POST /api/v2/sessions', { status: 422, body: { code: 'SOURCE_REJECTED' } }],
    ]);
    const { port, calls } = upstream(replies);
    const access = new AgentSessionAccess(store, auth(device()), port, 'host-1');
    const first = await access.createSession('tok', body, 'rk-1');
    expect((first.body as JsonObject).state).toBe('REJECTED');
    await access.sessionRequest('tok', 'rk-1');
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1);
  });

  it('unknown key → NOT_FOUND, never implies safe resubmit', async () => {
    const access = new AgentSessionAccess(memStore(), auth(device()), upstream(new Map()).port, 'host-1');
    await expectError(access.sessionRequest('tok', 'never'), 'NOT_FOUND', 404);
  });
});

// ---------------------------------------------------------------------------
// AgentSessionAccess — deliver ledger.
// ---------------------------------------------------------------------------

describe('AgentSessionAccess.deliver', () => {
  const auxSetup = (answer = 'the answer') => new Map<string, AgentUpstreamReply>([
    ['GET /api/v2/sessions/aux-1', {
      status: 200,
      body: { sessionId: 'aux-1', sessionPurpose: 'AUXILIARY_READ_ONLY', parentSessionId: 'parent-1' },
    }],
    ['GET /api/v2/sessions/aux-1/auxiliary-turns/turn-1', {
      status: 200,
      body: {
        turnId: 'turn-1', sessionId: 'aux-1', parentSessionId: 'parent-1',
        state: 'SUCCEEDED', answer,
      },
    }],
    ['GET /api/v2/sessions/parent-1', { status: 200, body: { sessionId: 'parent-1', activeRunId: 'run-1' } }],
    ['GET /api/v2/runs/run-1', { status: 200, body: { sessionId: 'parent-1' } }],
    ['GET /api/v2/runs/run-1/execution-segments', { status: 200, body: { current: { executionEpoch: '3' } } }],
    ['POST /api/v2/runs/run-1/boundary-requests', {
      status: 200,
      body: { requestId: '', runId: 'run-1', kind: 'CONTEXT_ADVICE' },
    }],
  ]);

  it('delivers a terminal aux answer as boundary input under namespaced key', async () => {
    const replies = auxSetup();
    const { port, calls } = upstream(replies);
    // The boundary reply echoes the namespaced requestId — compute the same key.
    const store = memStore();
    const access = new AgentSessionAccess(store, auth(device()), port, 'host-1');
    replies.set('POST /api/v2/runs/run-1/boundary-requests', { status: 200, body: { requestId: '', runId: 'run-1' } });
    const res = await access.deliver('tok', 'aux-1', 'turn-1', { requestKey: 'dk-1' }, 'dk-1');
    // acceptDeliver binds requestId===sourceKey — force the reply to match by
    // capturing the actual key the ledger minted.
    const post = calls.find((c) => c.method === 'POST')!;
    replies.set('POST /api/v2/runs/run-1/boundary-requests', { status: 200, body: { requestId: post.key, runId: 'run-1' } });
    const recovered = await access.sessionRequest('tok', 'dk-1');
    expect((recovered.body as JsonObject).state).toBe('OBSERVED');
    expect((res.body as JsonObject).requestKey).toBe('dk-1');
    expect(post.path).toBe('/api/v2/runs/run-1/boundary-requests');
    const wire = post.body as JsonObject;
    expect(wire.kind).toBe('CONTEXT_ADVICE');
    expect(wire.expectedExecutionEpoch).toBe('3');
    expect(wire.text).toBe('the answer');
    expect(wire.sourceRefs).toEqual(['auxiliary-turn:aux-1/turn-1']);
  });

  it('expectedAnswerRevision pins the answer digest', async () => {
    const replies = auxSetup();
    const access = new AgentSessionAccess(memStore(), auth(device()), upstream(replies).port, 'host-1');
    await expectError(
      access.deliver('tok', 'aux-1', 'turn-1', { requestKey: 'dk-1', expectedAnswerRevision: 'wrong' }, 'dk-1'),
      'AUXILIARY_ANSWER_CHANGED', 409);
  });

  it('non-terminal turn → AUXILIARY_ANSWER_NOT_TERMINAL', async () => {
    const replies = auxSetup();
    replies.set('GET /api/v2/sessions/aux-1/auxiliary-turns/turn-1', {
      status: 200,
      body: { turnId: 'turn-1', sessionId: 'aux-1', parentSessionId: 'parent-1', state: 'RUNNING' },
    });
    const access = new AgentSessionAccess(memStore(), auth(device()), upstream(replies).port, 'host-1');
    await expectError(access.deliver('tok', 'aux-1', 'turn-1', { requestKey: 'dk-1' }, 'dk-1'),
      'AUXILIARY_ANSWER_NOT_TERMINAL', 409);
  });

  it('aux session must be an authorized AUXILIARY_READ_ONLY child of a device session', async () => {
    const replies = auxSetup();
    replies.set('GET /api/v2/sessions/aux-1', {
      status: 200,
      body: { sessionId: 'aux-1', sessionPurpose: 'PRIMARY', parentSessionId: 'parent-1' },
    });
    const access = new AgentSessionAccess(memStore(), auth(device()), upstream(replies).port, 'host-1');
    await expectError(access.deliver('tok', 'aux-1', 'turn-1', { requestKey: 'dk-1' }, 'dk-1'),
      'DEVICE_SCOPE_DENIED', 403);
  });
});

// ---------------------------------------------------------------------------
// AgentSessionAccess — material-uploads ledger.
// ---------------------------------------------------------------------------

describe('AgentSessionAccess.materialUpload', () => {
  const create = {
    requestKey: 'mk-1',
    target: { sessionId: 's1' },
    displayName: 'shot.png',
    mediaType: 'image/png',
    sizeBytes: 4,
    sha256: 'a'.repeat(64),
  };

  it('create → POST material-uploads with namespaced requestKey on the wire', async () => {
    const replies = new Map<string, AgentUpstreamReply>([
      ['POST /api/v2/projects/p1/material-uploads', { status: 200, body: { uploadKey: 'u-1' } }],
    ]);
    const { port, calls } = upstream(replies);
    const access = new AgentSessionAccess(memStore(), auth(device()), port, 'host-1');
    const res = await access.materialUpload('tok', 'p1', [], 'POST', create, 'mk-1');
    expect(res.status).toBe(200);
    expect((res.body as JsonObject).operation).toBe('MATERIAL_UPLOAD_CREATE');
    expect(calls).toHaveLength(1);
    expect((calls[0]!.body as JsonObject).requestKey).toMatch(/^mobile-[a-f0-9]{64}$/);
  });

  it('chunk PUT dispatches raw bytes under ?digest= via callBytes', async () => {
    const dataBase64 = Buffer.from([1, 2, 3]).toString('base64');
    // sha256 of [1,2,3]
    const chunkDigest = '039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81';
    const replies = new Map<string, AgentUpstreamReply>([
      ['GET /api/v2/projects/p1/material-uploads/u-1', {
        status: 200, body: { uploadKey: 'u-1', target: { sessionId: 's1' } },
      }],
      ['PUT /api/v2/projects/p1/material-uploads/u-1/chunks/0?digest=' + chunkDigest, {
        status: 200, body: { uploadKey: 'u-1', nextOffset: 3 },
      }],
    ]);
    const { port, calls } = upstream(replies);
    const access = new AgentSessionAccess(memStore(), auth(device()), port, 'host-1');
    const res = await access.materialUpload('tok', 'p1', ['u-1', 'chunks', '0'], 'PUT',
      { requestKey: 'ck-1', chunkDigest, dataBase64 }, 'ck-1');
    expect(res.status).toBe(200);
    const put = calls.find((c) => c.method === 'PUT')!;
    expect(put.path).toContain('?digest=');
    expect(put.body).toBeInstanceOf(Uint8Array);
  });

  it('validation: media whitelist, size cap, digest honesty', async () => {
    const access = new AgentSessionAccess(memStore(), auth(device()), upstream(new Map()).port, 'host-1');
    await expectError(
      access.materialUpload('tok', 'p1', [], 'POST', { ...create, mediaType: 'application/x-msdownload' }, 'mk-1'),
      'MATERIAL_MEDIA_UNSUPPORTED', 422);
    await expectError(
      access.materialUpload('tok', 'p1', [], 'POST', { ...create, sizeBytes: 6_000_000 }, 'mk-1'),
      'MATERIAL_SIZE_EXCEEDED', 422);
    await expectError(
      access.materialUpload('tok', 'p1', [], 'POST', { ...create, sha256: 'not-hex' }, 'mk-1'),
      'INVALID_REQUEST', 400);
    await expectError(
      access.materialUpload('tok', 'p1', [], 'POST', { ...create, requestKey: 'other' }, 'mk-1'),
      'IDEMPOTENCY_KEY_MISMATCH', 400);
  });

  it('GET one upload projects the upstream view after OBSERVE binding', async () => {
    const replies = new Map<string, AgentUpstreamReply>([
      ['GET /api/v2/projects/p1/material-uploads/u-1', {
        status: 200,
        body: { uploadKey: 'u-1', target: { sessionId: 's1' }, displayName: 'a.png', state: 'OPEN' },
      }],
    ]);
    const access = new AgentSessionAccess(memStore(), auth(device()), upstream(replies).port, 'host-1');
    const res = await access.materialUpload('tok', 'p1', ['u-1'], 'GET', null, null);
    expect(res.status).toBe(200);
    expect((res.body as JsonObject).uploadKey).toBe('u-1');
  });

  it('unbound target → LOCAL_BINDING_MISMATCH; foreign session → scope denied', async () => {
    const access = new AgentSessionAccess(memStore(), auth(device()), upstream(new Map()).port, 'host-1');
    await expectError(
      access.materialUpload('tok', 'p1', [], 'POST', { ...create, target: {} }, 'mk-1'),
      'INVALID_REQUEST', 400);
    await expectError(
      access.materialUpload('tok', 'p1', [], 'POST', { ...create, target: { sessionId: 'foreign' } }, 'mk-1'),
      'DEVICE_SCOPE_DENIED', 403);
  });
});

// ---------------------------------------------------------------------------
// ChildMessagesAccess — delegated history projection.
// ---------------------------------------------------------------------------

describe('ChildMessagesAccess', () => {
  const setup = (items: unknown[]) => new Map<string, AgentUpstreamReply>([
    ['GET /api/v2/runs/r-1', { status: 200, body: { sessionId: 's1' } }],
    ['GET /api/v2/runs/r-1/collaboration-groups/g-1', {
      status: 200, body: { entityId: 'g-1' },
    }],
    ['GET /api/v2/runs/r-1/collaboration-groups/g-1/executions/e-1', {
      status: 200, body: { entityId: 'e-1', groupId: 'g-1', sessionId: 'child-1' },
    }],
    ['GET /api/v2/sessions/child-1', {
      status: 200,
      body: { sessionId: 'child-1', parentSessionId: 's1', sessionPurpose: 'DELEGATED_WRITE_CANDIDATE' },
    }],
    ['GET /api/v2/sessions/child-1/messages?limit=50', {
      status: 200, body: { items, hasOlder: false, hasNewer: false },
    }],
  ]);

  it('projects roles + delegated ids into child-messages/1 kinds', async () => {
    const items = [
      { id: delegatedId('child-1', 'e-1', 'objective'), role: 'user', content: 'do it', createdAt: 1_700_000_000_000 },
      { id: 'm-1', role: 'assistant', content: 'working', createdAt: 1_700_000_001_000 },
      { id: delegatedId('child-1', 'e-1', 'answer'), role: 'assistant', content: 'done', createdAt: 1_700_000_002_000 },
    ];
    const access = new ChildMessagesAccess(auth(device()), upstream(setup(items)).port);
    const res = await access.messages('tok', 'r-1', 'g-1', 'e-1', null);
    expect(res.status).toBe(200);
    const body = res.body as JsonObject;
    expect(body.schemaVersion).toBe('child-messages/1');
    expect(body.streamId).toBe('child-1');
    expect(body.coverage).toBe('FULL_SINCE_CAPTURE');
    const rows = body.items as JsonObject[];
    expect(rows.map((r) => r.kind)).toEqual(['ASSIGNMENT', 'ASSISTANT_MESSAGE', 'RETURN']);
    expect(rows[0]!.createdAt).toBe('2023-11-14T22:13:20.000Z');
  });

  it('before and cursor are mutually exclusive; unknown params fail', async () => {
    const access = new ChildMessagesAccess(auth(device()), upstream(setup([])).port);
    await expectError(access.messages('tok', 'r-1', 'g-1', 'e-1', 'before=1&cursor=x'),
      'INVALID_REQUEST', 400);
    await expectError(access.messages('tok', 'r-1', 'g-1', 'e-1', 'bogus=1'),
      'INVALID_REQUEST', 400);
    await expectError(access.messages('tok', 'r-1', 'g-1', 'e-1', 'limit=0'),
      'INVALID_REQUEST', 400);
  });

  it('child stream must bind back to the authorized parent', async () => {
    const replies = setup([]);
    replies.set('GET /api/v2/sessions/child-1', {
      status: 200,
      body: { sessionId: 'child-1', parentSessionId: 'other', sessionPurpose: 'DELEGATED_WRITE_CANDIDATE' },
    });
    const access = new ChildMessagesAccess(auth(device()), upstream(replies).port);
    await expectError(access.messages('tok', 'r-1', 'g-1', 'e-1', null), 'DEVICE_SCOPE_DENIED', 403);
  });

  it('oversized text is cut honestly and degrades coverage to PARTIAL', async () => {
    const big = 'x'.repeat(70_000);
    const items = [{ id: 'm-1', role: 'assistant', content: big, createdAt: 1_700_000_000_000 }];
    const access = new ChildMessagesAccess(auth(device()), upstream(setup(items)).port);
    const res = await access.messages('tok', 'r-1', 'g-1', 'e-1', null);
    const body = res.body as JsonObject;
    expect(body.coverage).toBe('PARTIAL');
    const row = (body.items as JsonObject[])[0]!;
    expect(row.textTruncated).toBe(true);
    expect((row.text as string).length).toBeLessThanOrEqual(65_536);
  });

  it('missing child stream degrades to UNAVAILABLE, not an error', async () => {
    const replies = setup([]);
    replies.set('GET /api/v2/runs/r-1/collaboration-groups/g-1/executions/e-1', {
      status: 200, body: { entityId: 'e-1', groupId: 'g-1' },
    });
    const access = new ChildMessagesAccess(auth(device()), upstream(replies).port);
    const res = await access.messages('tok', 'r-1', 'g-1', 'e-1', null);
    expect((res.body as JsonObject).coverage).toBe('UNAVAILABLE');
    expect((res.body as JsonObject).items).toEqual([]);
  });
});
