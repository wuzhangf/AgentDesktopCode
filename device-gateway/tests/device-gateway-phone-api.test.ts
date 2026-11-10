/**
 * Phone + owner API tests — Java PersonalAccessServer route table against a
 * fake GatewayContext. Every assertion keys on the Java contract: status,
 * code, call order and argument shapes.
 */
import { describe, expect, it } from 'vitest';
import { fail, GatewayError } from '../src/protocol.js';
import type { Device } from '../src/protocol.js';
import type {
  AcsReply,
  GatewayAuth,
  GatewayContext,
  HttpRequest,
  JsonObject,
} from '../src/context.js';
import { handlePhoneRoute } from '../src/phone-api.js';
import { handleOwnerRoute, type OwnerCredentials } from '../src/owner-api.js';
import { attachRequestMeta } from '../src/request-meta.js';

// ---------------------------------------------------------------------------
// Fixtures.
// ---------------------------------------------------------------------------

const NOW = Date.now();

const makeDevice = (): Device => ({
  id: 'dev-1',
  label: 'Pixel 8',
  state: 'ACTIVE',
  scopeVersion: 2,
  revision: 7,
  accessExpiry: NOW + 300_000,
  absoluteExpiry: NOW + 30 * 86_400_000,
  idleExpiry: NOW + 7 * 86_400_000,
  recoverUntil: 0,
  spentRefresh: [],
  sessions: ['s1'],
  actions: ['OBSERVE', 'INTERACT', 'CONTROL', 'APPROVE', 'POLICY', 'ASSIGN', 'LAUNCH'],
  resources: [
    { kind: 'ACS_SESSION', backendStoreId: 'acs-1', sessionId: 's1' },
    { kind: 'WORKER_LOCAL', backendStoreId: 'local-1', taskId: 't1' },
  ],
  launchScopes: [{ backendStoreId: 'local-1', projectId: 'p1', engineId: 'macos' }],
});

const ISSUED = {
  deviceGrantId: 'dev-1',
  grantRevision: '7',
  accessToken: 'at',
  refreshToken: 'rt',
  accessExpiresAt: NOW + 300_000,
};

interface AcsCall {
  method: string; path: string; body: Uint8Array | undefined;
  key: string | undefined; binding: string | undefined; maxReply?: number;
}

const jsonReply = (status: number, body: unknown, contentType = 'application/json'): AcsReply => ({
  status,
  body: new Uint8Array(Buffer.from(JSON.stringify(body), 'utf8')),
  contentType,
});

interface Calls {
  auth: [string, ...unknown[]][];
  acs: AcsCall[];
  acsJson: unknown[][];
  remote: { token: string; method: string; path: string; body: unknown; key: string | null; query: string | null }[];
  client: { token: string; method: string; tail: string; body: unknown; key: string | null; query: string | null }[];
  refresh: number;
  validateOwner: [unknown, unknown][];
  transcription: [string, ...unknown[]][];
}

interface FakeCtx extends GatewayContext {
  calls: Calls;
  device: Device;
  /** Mutable: acs replies keyed by "METHOD path-prefix". */
  acsReplies: Map<string, AcsReply>;
  /** When set, authenticate() returns a device whose revision differs on the Nth call. */
  revisionAfter?: number;
}

const fakeCtx = (opts: {
  withLocalTasks?: boolean;
  withAcs?: boolean;
  withClient?: boolean;
  withTranscription?: boolean;
} = {}): FakeCtx => {
  const device = makeDevice();
  const calls: Calls = { auth: [], acs: [], acsJson: [], remote: [], client: [], refresh: 0, validateOwner: [], transcription: [] };
  let authCalls = 0;

  const auth: GatewayAuth = {
    request: (b) => { calls.auth.push(['request', b]); return { pairingRequestId: 'pr-1', state: 'PENDING', expiresAt: NOW + 300_000 }; },
    observePairing: (rid, poll) => { calls.auth.push(['observePairing', rid, poll]); return { pairingRequestId: rid, state: 'PENDING' }; },
    redeem: (rid, poll, redemptionId) => { calls.auth.push(['redeem', rid, poll, redemptionId]); return ISSUED; },
    refresh: (t, rid) => { calls.auth.push(['refresh', t, rid]); return ISSUED; },
    authenticate: (t) => {
      calls.auth.push(['authenticate', t]);
      authCalls += 1;
      if (t !== 'tok') fail('ACCESS_UNAUTHORIZED', 401);
      const current = fake.revisionAfter !== undefined && authCalls >= fake.revisionAfter
        ? { ...device, revision: device.revision + 1 }
        : device;
      return current;
    },
    authorize: (t, sid, action) => {
      calls.auth.push(['authorize', t, sid, action]);
      if (t !== 'tok' || !device.sessions!.includes(sid) || !device.actions!.includes(action)) {
        fail('DEVICE_SCOPE_DENIED', 403);
      }
      return device;
    },
    authorizeDevice: (did, sid, action) => {
      calls.auth.push(['authorizeDevice', did, sid, action]);
      if (did !== device.id || !device.sessions!.includes(sid) || !device.actions!.includes(action)) {
        fail('DEVICE_SCOPE_DENIED', 403);
      }
      return device;
    },
    authorizeLocal: (t, backend, taskId, action) => {
      calls.auth.push(['authorizeLocal', t, backend, taskId, action]);
      return device;
    },
    authorizeLocalDevice: () => device,
    authorizeLaunch: () => device,
    activeDevices: () => [device],
    activeDevice: () => device,
    revoke: (did) => { calls.auth.push(['revoke', did]); },
    appendLaunchedTask: () => {},
    invitation: (rid, sessions, actions, fp) => {
      calls.auth.push(['invitation', rid, sessions, actions, fp]);
      return { id: 'inv-1', requestId: rid, sessions, actions, fingerprint: fp, expiresAt: NOW + 600_000 };
    },
    invitationResources: (rid, resources, launches, actions, fp) => {
      calls.auth.push(['invitationResources', rid, resources, launches, actions, fp]);
      return { id: 'inv-2', requestId: rid, resources, launchScopes: launches, actions, fingerprint: fp, expiresAt: NOW + 600_000 };
    },
    updateScope: (did, rid, rev, sessions, actions) => {
      calls.auth.push(['updateScope', did, rid, rev, sessions, actions]);
      return { deviceGrantId: did, grantRevision: '8' };
    },
    updateScopeResources: (did, rid, rev, resources, launches, actions) => {
      calls.auth.push(['updateScopeResources', did, rid, rev, resources, launches, actions]);
      return { deviceGrantId: did, grantRevision: '8' };
    },
    devices: () => [{ deviceGrantId: device.id }],
    requests: () => [{ pairingRequestId: 'pr-1', state: 'PENDING' }],
    ownerStatus: () => ({ enabled: true, personalHostId: 'host-1', storeId: 'acs-1', origin: 'https://gw:9443' }),
    host: (d, boot) => ({
      deviceGrantId: d.id,
      label: d.label,
      schemaVersion: 'personal-agent-access/1',
      personalHostId: 'host-1',
      storeId: 'acs-1',
      bootId: boot,
      capabilities: { observe: true, control: true },
    }),
    ensureHost: () => {},
  };
  // Java auth.decide is outside the fixed GatewayAuth — attach it like Devices does.
  (auth as GatewayAuth & { decide?: unknown }).decide = (rid: string, approve: boolean) => {
    calls.auth.push(['decide', rid, approve]);
    return { pairingRequestId: rid, state: approve ? 'APPROVED' : 'REJECTED' };
  };

  const fake: FakeCtx = {
    calls,
    device,
    acsReplies: new Map(),
    config: {
      // These route-contract fixtures deliberately omit the online rights service.
      allowUnlicensedDevelopment: true,
      storeId: 'store-1',
      acsStoreId: 'acs-1',
      bootId: 'boot-1',
      origin: 'https://gw:9443',
      certificateSha256: 'aa'.repeat(32),
      certificatePem: '-----BEGIN CERTIFICATE-----\nAA==\n-----END CERTIFICATE-----\n',
      certificateNotBefore: NOW - 1000,
      certificateNotAfter: NOW + 1000,
      certificateNames: [[2, 'gw.test']],
      bindAddress: '127.0.0.1',
      port: 9443,
      transcriptionReason: 'TRANSCRIPTION_NOT_CONFIGURED',
    },
    auth,
    inbox: {
      requestRefresh: () => { calls.refresh += 1; },
      scanAll: () => {},
      list: (d, cursor, limit) => {
        calls.auth.push(['inbox.list', d.id, cursor, limit]);
        return { schemaVersion: 'personal-inbox/1', items: [], nextCursor: null };
      },
      detail: (d, itemId) => {
        calls.auth.push(['inbox.detail', d.id, itemId]);
        return { itemId, kind: 'RESULT_READY' };
      },
    },
  };

  if (opts.withAcs !== false) {
    fake.acs = {
      call: (method, path, body, key, binding, maxReply) => {
        calls.acs.push({ method, path, body, key, binding, maxReply });
        const hit = fake.acsReplies.get(`${method} ${path}`) ?? fake.acsReplies.get(`${method} *`);
        if (hit !== undefined) return hit;
        return jsonReply(404, { code: 'NOT_FOUND' });
      },
      callJson: (device, method, path, body, key) => {
        calls.acsJson.push([device.id, method, path, body, key]);
        const hit = fake.acsReplies.get(`JSON ${method} ${path}`);
        if (hit !== undefined) return JSON.parse(Buffer.from(hit.body).toString('utf8'));
        fail('NOT_FOUND', 404);
      },
    };
  }
  if (opts.withLocalTasks) {
    fake.localTasks = {
      remote: (token, method, path, body, key, rawQuery) => {
        calls.remote.push({ token, method, path, body, key, query: rawQuery });
        return { status: 200, body: { ok: true, path } };
      },
      signal: () => fail('SOURCE_NOT_READY', 503),
      ownerCatalog: () => ({ available: true, backendStoreId: 'local-1' }),
      validateOwnerResources: (resources, launches) => { calls.validateOwner.push([resources, launches]); },
      verifyTaskEngine: () => {},
      recordedInput: () => false,
    };
  }
  if (opts.withClient) {
    fake.clientAccess = {
      handle: (token, method, tail, body, key, rawQuery) => {
        calls.client.push({ token, method, tail, body, key, query: rawQuery });
        return { ok: true };
      },
    };
  }
  if (opts.withTranscription) {
    fake.transcription = {
      submit: (token, requestId, sessionId, audioSha256, audio, language) => {
        calls.transcription.push(['submit', token, requestId, sessionId, audioSha256, audio.length, language]);
        return { requestKey: requestId, state: 'ACCEPTED' };
      },
      get: (token, requestId) => {
        calls.transcription.push(['get', token, requestId]);
        return { requestKey: requestId, state: 'DISPATCHED' };
      },
      cancel: (token, requestId) => {
        calls.transcription.push(['cancel', token, requestId]);
        return { requestKey: requestId, state: 'CANCELLED' };
      },
    };
  }
  return fake;
};

const req = (
  method: string, path: string, over: Partial<HttpRequest> = {},
): HttpRequest => ({
  method,
  path,
  query: new URLSearchParams(over.rawQuery ?? ''),
  rawQuery: over.rawQuery ?? null,
  clientIp: '203.0.113.9',
  ...over,
});

const jsonReq = (
  method: string, path: string, body: unknown, over: Partial<HttpRequest> = {},
): HttpRequest => req(method, path, {
  rawBody: new Uint8Array(Buffer.from(JSON.stringify(body), 'utf8')),
  ...over,
});

const authed = (over: Partial<HttpRequest> = {}): Partial<HttpRequest> => ({
  accessToken: 'tok',
  authorizationCount: 1,
  authorization: 'Bearer tok',
  ...over,
});

// ---------------------------------------------------------------------------
// Pairing + refresh (public surface, rate-limited).
// ---------------------------------------------------------------------------

describe('pairing routes', () => {
  const PAIR_BODY = {
    pairingRequestId: 'pr-1',
    inviteId: 'inv-1',
    inviteSecret: 'sec',
    installationId: 'inst-1',
    label: 'Pixel',
    pollingSecretHash: 'h'.repeat(64),
  };

  it('POST /personal/v1/pairing-requests → 202 + auth.request(raw body)', async () => {
    const ctx = fakeCtx();
    const res = await handlePhoneRoute(ctx, jsonReq('POST', '/personal/v1/pairing-requests', PAIR_BODY));
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ pairingRequestId: 'pr-1', state: 'PENDING' });
    expect(ctx.calls.auth[0]).toEqual(['request', PAIR_BODY]);
  });

  it('pairing body with extra key → 400 INVALID_REQUEST', async () => {
    const ctx = fakeCtx();
    const res = await handlePhoneRoute(ctx, jsonReq('POST', '/personal/v1/pairing-requests', { ...PAIR_BODY, extra: 1 }));
    expect(res.status).toBe(400);
    expect((res.body as JsonObject).code).toBe('INVALID_REQUEST');
  });

  it('GET /personal/v1/pairing-requests/{id} → auth.observePairing(id, bearer)', async () => {
    const ctx = fakeCtx();
    const res = await handlePhoneRoute(ctx, req('GET', '/personal/v1/pairing-requests/pr-9', {
      accessToken: 'poll-9', authorization: 'Bearer poll-9', authorizationCount: 1,
    }));
    expect(res.status).toBe(200);
    expect(ctx.calls.auth[0]).toEqual(['observePairing', 'pr-9', 'poll-9']);
  });

  it('POST /pairing-requests/{id}/redemptions → auth.redeem(id, bearer, redemptionId)', async () => {
    const ctx = fakeCtx();
    const res = await handlePhoneRoute(ctx, jsonReq('POST', '/personal/v1/pairing-requests/pr-9/redemptions',
      { redemptionId: 'rd-1' }, {
        accessToken: 'poll-9', authorization: 'Bearer poll-9', authorizationCount: 1,
      }));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ deviceGrantId: 'dev-1', grantRevision: '7', accessToken: 'at' });
    expect(ctx.calls.auth[0]).toEqual(['redeem', 'pr-9', 'poll-9', 'rd-1']);
  });

  it('relay ingress + member body → auth.memberRequest with catalog scope', async () => {
    const ctx = fakeCtx({ withLocalTasks: true });
    ctx.localTasks!.ownerCatalog = () => ({
      available: true, backendStoreId: 'local-1',
      projects: [{ projectId: 'p1' }, { projectId: 'p2' }],
      engines: [{ engineId: 'macos' }],
    });
    let seen: { body: unknown; scope: unknown } | undefined;
    ctx.auth.memberRequest = (body, scope) => {
      seen = { body, scope };
      return { pairingRequestId: 'pr-m', state: 'APPROVED' };
    };
    const res = await handlePhoneRoute(ctx, jsonReq('POST', '/personal/v1/pairing-requests', {
      pairingRequestId: 'pr-m', member: true, installationId: 'inst-1',
      label: 'iPhone', pollingSecretHash: 'h'.repeat(64),
    }, { relayIngress: true }));
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ pairingRequestId: 'pr-m', state: 'APPROVED' });
    const scope = seen?.scope as { launchScopes: unknown[]; actions: string[] };
    expect(scope.launchScopes).toEqual([
      { backendStoreId: 'local-1', projectId: 'p1', engineId: 'macos' },
      { backendStoreId: 'local-1', projectId: 'p2', engineId: 'macos' },
    ]);
    expect(scope.actions).toContain('LAUNCH');
    expect(ctx.calls.auth.filter((c) => c[0] === 'request')).toEqual([]);
  });

  it('member marker on the public listener → 400 INVALID_REQUEST', async () => {
    const ctx = fakeCtx({ withLocalTasks: true });
    const res = await handlePhoneRoute(ctx, jsonReq('POST', '/personal/v1/pairing-requests', {
      pairingRequestId: 'pr-m', member: true, installationId: 'inst-1',
      label: 'iPhone', pollingSecretHash: 'h'.repeat(64),
    }));
    expect(res.status).toBe(400);
    expect((res.body as JsonObject).code).toBe('INVALID_REQUEST');
    expect(ctx.calls.auth).toEqual([]);
  });

  it('relay ingress without the member marker falls back to invite validation', async () => {
    const ctx = fakeCtx({ withLocalTasks: true });
    const res = await handlePhoneRoute(ctx, jsonReq('POST', '/personal/v1/pairing-requests', {
      pairingRequestId: 'pr-m', installationId: 'inst-1',
      label: 'iPhone', pollingSecretHash: 'h'.repeat(64),
    }, { relayIngress: true }));
    expect(res.status).toBe(400);
    expect((res.body as JsonObject).code).toBe('INVALID_REQUEST');
  });

  it('invite-bearing body still takes the sealed path on relay ingress', async () => {
    const ctx = fakeCtx({ withLocalTasks: true });
    const res = await handlePhoneRoute(ctx, jsonReq('POST', '/personal/v1/pairing-requests',
      PAIR_BODY, { relayIngress: true }));
    expect(res.status).toBe(202);
    expect(ctx.calls.auth[0]).toEqual(['request', PAIR_BODY]);
  });

  it('member pairing without local tasks → 409 LOCAL_SOURCE_NOT_CONFIGURED', async () => {
    const ctx = fakeCtx();
    ctx.auth.memberRequest = () => ({});
    const res = await handlePhoneRoute(ctx, jsonReq('POST', '/personal/v1/pairing-requests', {
      pairingRequestId: 'pr-m', member: true, installationId: 'inst-1',
      label: 'iPhone', pollingSecretHash: 'h'.repeat(64),
    }, { relayIngress: true }));
    expect(res.status).toBe(409);
    expect((res.body as JsonObject).code).toBe('LOCAL_SOURCE_NOT_CONFIGURED');
  });

  it('other methods under /pairing-requests/{id} → 404 NOT_FOUND', async () => {
    const ctx = fakeCtx();
    const res = await handlePhoneRoute(ctx, req('DELETE', '/personal/v1/pairing-requests/pr-9', {
      accessToken: 'poll-9', authorization: 'Bearer poll-9', authorizationCount: 1,
    }));
    expect(res.status).toBe(404);
  });

  it('POST /personal/v1/access-sessions/refresh → auth.refresh(token, requestId)', async () => {
    const ctx = fakeCtx();
    const res = await handlePhoneRoute(ctx, jsonReq('POST', '/personal/v1/access-sessions/refresh',
      { refreshToken: 'rt-1', refreshRequestId: 'rq-1' }));
    expect(res.status).toBe(200);
    expect(ctx.calls.auth[0]).toEqual(['refresh', 'rt-1', 'rq-1']);
  });

  it('rate limit: 21st attempt in window → 429 RATE_LIMITED', async () => {
    const ctx = fakeCtx();
    for (let i = 0; i < 20; i++) {
      await handlePhoneRoute(ctx, jsonReq('POST', '/personal/v1/pairing-requests', PAIR_BODY));
    }
    const res = await handlePhoneRoute(ctx, jsonReq('POST', '/personal/v1/pairing-requests', PAIR_BODY));
    expect(res.status).toBe(429);
    expect((res.body as JsonObject).code).toBe('RATE_LIMITED');
  });

  it('path guard: %/../ // → 400 INVALID_REQUEST', async () => {
    const ctx = fakeCtx();
    for (const p of ['/personal/v1/pairing%20', '/personal/v1/../v1', '/personal//v1/host']) {
      const res = await handlePhoneRoute(ctx, req('GET', p));
      expect(res.status).toBe(400);
    }
  });
});

// ---------------------------------------------------------------------------
// Authenticated routes.
// ---------------------------------------------------------------------------

describe('host + inbox + local-tasks', () => {
  it('GET /personal/v1/host merges capabilities per Java', async () => {
    const ctx = fakeCtx({ withLocalTasks: true });
    const res = await handlePhoneRoute(ctx, req('GET', '/personal/v1/host', authed()));
    expect(res.status).toBe(200);
    const body = res.body as JsonObject;
    expect(body.bootId).toBe('boot-1');
    expect(body.capabilities).toMatchObject({
      executionPolicy: true,
      manageExecutionPolicy: true,
      localTasks: true,
      launch: true,
      inbox: true,
      notifications: false,
    });
  });

  it('GET /personal/v1/host without POLICY/LAUNCH → merged flags false', async () => {
    const ctx = fakeCtx();
    ctx.device.actions = ['OBSERVE'];
    const res = await handlePhoneRoute(ctx, req('GET', '/personal/v1/host', authed()));
    expect(res.status).toBe(200);
    const caps = (res.body as JsonObject).capabilities as JsonObject;
    expect(caps.manageExecutionPolicy).toBe(false);
    expect(caps.localTasks).toBe(false);
    expect(caps.launch).toBe(false);
  });

  it('GET /personal/v1/inbox refreshes then lists with cursor+limit', async () => {
    const ctx = fakeCtx();
    const res = await handlePhoneRoute(ctx, req('GET', '/personal/v1/inbox', authed({ rawQuery: 'cursor=c9&limit=15' })));
    expect(res.status).toBe(200);
    expect(ctx.calls.refresh).toBe(1);
    expect(ctx.calls.auth).toContainEqual(['inbox.list', 'dev-1', 'c9', 15]);
  });

  it('GET /personal/v1/inbox rejects unknown/large limit', async () => {
    const ctx = fakeCtx();
    const bad = await handlePhoneRoute(ctx, req('GET', '/personal/v1/inbox', authed({ rawQuery: 'limit=101' })));
    expect(bad.status).toBe(400);
    const unknown = await handlePhoneRoute(ctx, req('GET', '/personal/v1/inbox', authed({ rawQuery: 'bogus=1' })));
    expect(unknown.status).toBe(400);
  });

  it('GET /personal/v1/inbox revision change → 409 GRANT_REVISION_CHANGED', async () => {
    const ctx = fakeCtx();
    ctx.revisionAfter = 2; // authenticate at dispatch + recheck differs
    const res = await handlePhoneRoute(ctx, req('GET', '/personal/v1/inbox', authed()));
    expect(res.status).toBe(409);
    expect((res.body as JsonObject).code).toBe('GRANT_REVISION_CHANGED');
  });

  it('GET /personal/v1/inbox/{id} → inbox.detail', async () => {
    const ctx = fakeCtx();
    const res = await handlePhoneRoute(ctx, req('GET', '/personal/v1/inbox/item-9', authed()));
    expect(res.status).toBe(200);
    expect(ctx.calls.auth).toContainEqual(['inbox.detail', 'dev-1', 'item-9']);
  });

  it('local-tasks absent → 409 LOCAL_SOURCE_NOT_CONFIGURED', async () => {
    const ctx = fakeCtx();
    const res = await handlePhoneRoute(ctx, req('GET', '/personal/v1/local-tasks', authed()));
    expect(res.status).toBe(409);
    expect((res.body as JsonObject).code).toBe('LOCAL_SOURCE_NOT_CONFIGURED');
  });

  it('local-tasks present → remote() passthrough + re-authenticate', async () => {
    const ctx = fakeCtx({ withLocalTasks: true });
    const res = await handlePhoneRoute(ctx, jsonReq('POST', '/personal/v1/local-tasks/local-1/tasks/t1/messages',
      { text: 'hi' }, authed()));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, path: '/personal/v1/local-tasks/local-1/tasks/t1/messages' });
    const call = ctx.calls.remote[0];
    expect(call.token).toBe('tok');
    expect(call.key).toBeNull();
    const authCalls = ctx.calls.auth.filter(([n]) => n === 'authenticate');
    expect(authCalls.length).toBeGreaterThanOrEqual(2);
  });

  it('local-tasks requestKey body requires exactly one Idempotency-Key', async () => {
    const ctx = fakeCtx({ withLocalTasks: true });
    const missing = await handlePhoneRoute(ctx, jsonReq('POST', '/personal/v1/local-tasks/local-1/tasks/t1/messages',
      { requestKey: 'k1' }, authed()));
    expect(missing.status).toBe(400);
    const res = await handlePhoneRoute(ctx, jsonReq('POST', '/personal/v1/local-tasks/local-1/tasks/t1/messages',
      { requestKey: 'k1' }, authed({ idempotencyKey: 'k1', idempotencyKeyCount: 1 })));
    expect(res.status).toBe(200);
    expect(ctx.calls.remote[0].key).toBe('k1');
  });
});

// ---------------------------------------------------------------------------
// Input capabilities + transcriptions.
// ---------------------------------------------------------------------------

describe('input capabilities + transcriptions', () => {
  it('GET /personal/v1/input-capabilities projects /api/v2/capabilities', async () => {
    const ctx = fakeCtx();
    ctx.acsReplies.set('GET /api/v2/capabilities', jsonReply(200, {
      operations: [{
        operation: 'session.message.send.image',
        availability: 'AVAILABLE',
        reasonCode: 'X',
        limits: { maxBytes: 1024 },
      }],
    }));
    const res = await handlePhoneRoute(ctx, req('GET', '/personal/v1/input-capabilities', authed()));
    expect(res.status).toBe(200);
    const body = res.body as JsonObject;
    expect(body.grantRevision).toBe('7');
    expect(body.images).toMatchObject({ available: true, reason: 'MODEL_SUPPORT_MUST_BE_CHECKED', limits: { maxBytes: 1024 } });
    expect(body.messageRequestMaxBytes).toBe(16 * 1024 * 1024);
    expect(body.transcription).toMatchObject({ available: false, reason: 'TRANSCRIPTION_NOT_CONFIGURED', mediaType: 'audio/wav', maxAudioBytes: 1920044 });
    expect(ctx.calls.acs[0].path).toBe('/api/v2/capabilities');
    expect(ctx.calls.acs[0].binding).toBeTypeOf('string');
  });

  it('capabilities non-200 → 503 SOURCE_NOT_READY', async () => {
    const ctx = fakeCtx();
    ctx.acsReplies.set('GET /api/v2/capabilities', jsonReply(500, {}));
    const res = await handlePhoneRoute(ctx, req('GET', '/personal/v1/input-capabilities', authed()));
    expect(res.status).toBe(503);
    expect((res.body as JsonObject).code).toBe('SOURCE_NOT_READY');
  });

  it('POST /transcriptions without seam → 503 TRANSCRIPTION_NOT_CONFIGURED', async () => {
    const ctx = fakeCtx();
    const res = await handlePhoneRoute(ctx, req('POST', '/personal/v1/transcriptions', authed()));
    expect(res.status).toBe(503);
    expect((res.body as JsonObject).code).toBe('TRANSCRIPTION_NOT_CONFIGURED');
  });

  const wav = (): Uint8Array => {
    const b = Buffer.alloc(6500);
    b.write('RIFF', 0); b.writeUInt32LE(6492, 4); b.write('WAVE', 8); b.write('fmt ', 12);
    b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
    b.writeUInt32LE(16000, 24); b.writeUInt32LE(32000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
    b.write('data', 36); b.writeUInt32LE(6456, 40);
    return new Uint8Array(b);
  };

  const multipart = (metadata: unknown, audio: Uint8Array, boundary = 'BbAa09'): Uint8Array => {
    const head = `--${boundary}\r\ncontent-disposition: form-data; name="metadata"\r\n\r\n${JSON.stringify(metadata)}\r\n`
      + `--${boundary}\r\ncontent-disposition: form-data; name="audio"; filename="a.wav"\r\ncontent-type: audio/wav\r\n\r\n`;
    const tail = `\r\n--${boundary}--\r\n`;
    return new Uint8Array(Buffer.concat([Buffer.from(head, 'ascii'), Buffer.from(audio), Buffer.from(tail, 'ascii')]));
  };

  it('POST /transcriptions multipart → transcription.submit → 202', async () => {
    const ctx = fakeCtx({ withTranscription: true });
    const request = req('POST', '/personal/v1/transcriptions', authed({
      rawBody: multipart({ requestKey: 'rk-1', sessionId: 's1', audioSha256: 'h'.repeat(64), language: 'auto' }, wav()),
      idempotencyKey: 'rk-1',
      idempotencyKeyCount: 1,
    }));
    attachRequestMeta(request, { contentType: 'multipart/form-data; boundary=BbAa09' });
    const res = await handlePhoneRoute(ctx, request);
    expect(res.status).toBe(202);
    const call = ctx.calls.transcription[0];
    expect(call[0]).toBe('submit');
    expect(call.slice(1, 4)).toEqual(['tok', 'rk-1', 's1']);
    expect(call[5]).toBe(6500);
    expect(call[6]).toBe('auto');
  });

  it('multipart requestKey != Idempotency-Key → 400', async () => {
    const ctx = fakeCtx({ withTranscription: true });
    const request = req('POST', '/personal/v1/transcriptions', authed({
      rawBody: multipart({ requestKey: 'rk-1', sessionId: 's1', audioSha256: 'x' }, wav()),
      idempotencyKey: 'other',
      idempotencyKeyCount: 1,
    }));
    attachRequestMeta(request, { contentType: 'multipart/form-data; boundary=BbAa09' });
    const res = await handlePhoneRoute(ctx, request);
    expect(res.status).toBe(400);
  });

  it('non-multipart content type → 415 AUDIO_MULTIPART_REQUIRED', async () => {
    const ctx = fakeCtx({ withTranscription: true });
    const request = req('POST', '/personal/v1/transcriptions', authed({ rawBody: new Uint8Array(4) }));
    attachRequestMeta(request, { contentType: 'application/json' });
    const res = await handlePhoneRoute(ctx, request);
    expect(res.status).toBe(415);
    expect((res.body as JsonObject).code).toBe('AUDIO_MULTIPART_REQUIRED');
  });

  it('GET/POST cancel on /transcriptions/{id} → get/cancel; DELETE → 403', async () => {
    const ctx = fakeCtx({ withTranscription: true });
    const get = await handlePhoneRoute(ctx, req('GET', '/personal/v1/transcriptions/rk-1', authed()));
    expect(get.status).toBe(200);
    expect(ctx.calls.transcription[0]).toEqual(['get', 'tok', 'rk-1']);
    const cancel = await handlePhoneRoute(ctx, jsonReq('POST', '/personal/v1/transcriptions/rk-1/cancel', {}, authed()));
    expect(cancel.status).toBe(200);
    expect(ctx.calls.transcription[1]).toEqual(['cancel', 'tok', 'rk-1']);
    const del = await handlePhoneRoute(ctx, req('DELETE', '/personal/v1/transcriptions/rk-1', authed()));
    expect(del.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// Device + sessions + execution policy + agent proxy.
// ---------------------------------------------------------------------------

describe('device + sessions + execution-policy', () => {
  it('DELETE /personal/v1/device → revoke + 204', async () => {
    const ctx = fakeCtx();
    const res = await handlePhoneRoute(ctx, req('DELETE', '/personal/v1/device', authed()));
    expect(res.status).toBe(204);
    expect(ctx.calls.auth).toContainEqual(['revoke', 'dev-1']);
  });

  it('GET /personal/v1/sessions merges foundation+summary+messages', async () => {
    const ctx = fakeCtx();
    ctx.acsReplies.set('GET /api/v2/sessions/s1/foundation', jsonReply(200, { sessionId: 's1', state: 'RUNNING' }));
    ctx.acsReplies.set('GET /api/v2/sessions/s1/summary', jsonReply(200, { title: 'T', sessionVersion: 'v3', updatedAt: 11 }));
    ctx.acsReplies.set('GET /api/v2/sessions/s1/messages?limit=30', jsonReply(200, {
      sessionId: 's1',
      hasOlder: true,
      items: [
        { id: 'm1', role: 'user', contentBytes: 5, content: 'hello', createdAt: 1 },
        { id: 'm2', role: 'tool', contentBytes: 9, content: 'x' },
        { id: 'm3', role: 'assistant', contentBytes: 3, contentPreview: 'done' },
      ],
    }));
    const res = await handlePhoneRoute(ctx, req('GET', '/personal/v1/sessions', authed()));
    expect(res.status).toBe(200);
    const rows = res.body as JsonObject[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ sessionId: 's1', title: 'T', sessionVersion: 'v3', activityWindowLimited: true });
    const activity = rows[0].conversationActivity as JsonObject[];
    expect(activity).toHaveLength(2);
    expect(activity[0]).toMatchObject({ id: 'm1', role: 'user', preview: 'hello' });
    expect(activity[1]).toMatchObject({ id: 'm3', preview: 'done' });
  });

  it('sessions row skipped on foundation 404; other non-200 → 503', async () => {
    const ctx = fakeCtx();
    ctx.acsReplies.set('GET /api/v2/sessions/s1/foundation', jsonReply(404, {}));
    const res = await handlePhoneRoute(ctx, req('GET', '/personal/v1/sessions', authed()));
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);

    ctx.acsReplies.set('GET /api/v2/sessions/s1/foundation', jsonReply(500, {}));
    const bad = await handlePhoneRoute(ctx, req('GET', '/personal/v1/sessions', authed()));
    expect(bad.status).toBe(503);
    expect((bad.body as JsonObject).code).toBe('UPSTREAM_UNAVAILABLE');
  });

  it('execution-policy GET forwards and returns upstream body', async () => {
    const ctx = fakeCtx();
    ctx.acsReplies.set('GET /api/v2/sessions/s1/execution-policy', jsonReply(200, { revision: 3 }));
    const res = await handlePhoneRoute(ctx, req('GET', '/personal/v1/agent/sessions/s1/execution-policy', authed()));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ revision: 3 });
    expect(ctx.calls.auth).toContainEqual(['authorize', 'tok', 's1', 'OBSERVE']);
  });

  it('execution-policy defaults resolves the project route', async () => {
    const ctx = fakeCtx();
    ctx.acsReplies.set('GET /api/v2/sessions/s1/execution-policy', jsonReply(200, { projectId: 'proj-9' }));
    ctx.acsReplies.set('GET /api/v2/projects/proj-9/execution-policy-defaults', jsonReply(200, { mode: 'STANDARD' }));
    const res = await handlePhoneRoute(ctx, req('GET', '/personal/v1/agent/sessions/s1/execution-policy-defaults', authed()));
    expect(res.status).toBe(200);
    expect(ctx.calls.acs.map((c) => `${c.method} ${c.path}`)).toEqual([
      'GET /api/v2/sessions/s1/execution-policy',
      'GET /api/v2/projects/proj-9/execution-policy-defaults',
    ]);
  });

  it('execution-policy PUT validates and forwards stripped body', async () => {
    const ctx = fakeCtx();
    ctx.acsReplies.set('PUT /api/v2/sessions/s1/execution-policy', jsonReply(200, { applied: true }));
    const bad = await handlePhoneRoute(ctx, jsonReq('PUT', '/personal/v1/agent/sessions/s1/execution-policy',
      { expectedRevision: 0, requestedMode: 'NOPE', permissionSemanticsVersion: 1, pendingApprovalAction: 'X' },
      authed({ idempotencyKey: 'k', idempotencyKeyCount: 1 })));
    expect(bad.status).toBe(400);

    const res = await handlePhoneRoute(ctx, jsonReq('PUT', '/personal/v1/agent/sessions/s1/execution-policy',
      { expectedRevision: 2, requestedMode: 'AUTO_APPROVE', permissionSemanticsVersion: 2, pendingApprovalAction: 'RETAIN' },
      authed({ idempotencyKey: 'k-1', idempotencyKeyCount: 1 })));
    expect(res.status).toBe(200);
    const call = ctx.calls.acs.find((c) => c.method === 'PUT')!;
    expect(call.key).toBe('k-1');
    expect(JSON.parse(Buffer.from(call.body!).toString('utf8'))).toEqual({
      expectedRevision: 2, requestedMode: 'AUTO_APPROVE', permissionSemanticsVersion: 2, pendingApprovalAction: 'RETAIN',
    });
    expect(ctx.calls.auth).toContainEqual(['authorize', 'tok', 's1', 'POLICY']);
  });

  it('execution-policy PUT on session route forbids projectId', async () => {
    const ctx = fakeCtx();
    const res = await handlePhoneRoute(ctx, jsonReq('PUT', '/personal/v1/agent/sessions/s1/execution-policy',
      { expectedRevision: 2, requestedMode: 'STANDARD', permissionSemanticsVersion: 2, pendingApprovalAction: 'RETAIN', projectId: 'p1' },
      authed({ idempotencyKey: 'k', idempotencyKeyCount: 1 })));
    expect(res.status).toBe(400);
  });
});

describe('assignment-options + agent proxy', () => {
  it('GET assignment-options projects profiles+models (≤100)', async () => {
    const ctx = fakeCtx();
    ctx.acsReplies.set('GET /api/v2/agent-profiles', jsonReply(200, {
      profiles: [{ id: 'p1', name: 'n', description: 'd', revision: '1', extra: 'drop' }],
    }));
    ctx.acsReplies.set('GET /api/v2/model-catalog', jsonReply(200, {
      items: [
        { configured: true, availability: 'AVAILABLE', modelAlias: 'm1', providerDisplayName: 'P', drop: 1 },
        { configured: false, availability: 'AVAILABLE', modelAlias: 'm2' },
      ],
    }));
    const res = await handlePhoneRoute(ctx, req('GET', '/personal/v1/agent/sessions/s1/assignment-options', authed()));
    expect(res.status).toBe(200);
    const body = res.body as JsonObject;
    expect(body.schemaVersion).toBe('personal-assignment-options/1');
    expect(body.profiles).toEqual([{ id: 'p1', name: 'n', description: 'd', revision: '1' }]);
    expect(body.models).toEqual([{ modelAlias: 'm1', providerDisplayName: 'P' }]);
  });

  it('POST /agent/sessions/{sid}/messages forwards raw body + idempotency + binding', async () => {
    const ctx = fakeCtx();
    ctx.acsReplies.set('POST /api/v2/sessions/s1/messages', jsonReply(200, { receipt: 'ok' }));
    const res = await handlePhoneRoute(ctx, jsonReq('POST', '/personal/v1/agent/sessions/s1/messages',
      { content: 'hi' }, authed({ idempotencyKey: 'k-9', idempotencyKeyCount: 1 })));
    expect(res.status).toBe(200);
    const call = ctx.calls.acs.find((c) => c.method === 'POST')!;
    expect(call.path).toBe('/api/v2/sessions/s1/messages');
    expect(call.key).toBe('k-9');
    expect(call.binding).toBeTypeOf('string');
    expect(JSON.parse(Buffer.from(call.body!).toString('utf8'))).toEqual({ content: 'hi' });
    expect(ctx.calls.auth).toContainEqual(['authorize', 'tok', 's1', 'INTERACT']);
  });

  it('POST message without Idempotency-Key → 400', async () => {
    const ctx = fakeCtx();
    const res = await handlePhoneRoute(ctx, jsonReq('POST', '/personal/v1/agent/sessions/s1/messages',
      { content: 'hi' }, authed()));
    expect(res.status).toBe(400);
  });

  it('approvals decision: lookup binds session then forwards', async () => {
    const ctx = fakeCtx();
    ctx.acsReplies.set('GET /api/v2/approvals/a-1', jsonReply(200, { approvalId: 'a-1', sessionId: 's1' }));
    ctx.acsReplies.set('POST /api/v2/approvals/a-1/decisions', jsonReply(200, { decided: true }));
    const res = await handlePhoneRoute(ctx, jsonReq('POST', '/personal/v1/agent/approvals/a-1/decisions',
      { approve: true }, authed({ idempotencyKey: 'k', idempotencyKeyCount: 1 })));
    expect(res.status).toBe(200);
    expect(ctx.calls.acs.map((c) => `${c.method} ${c.path}`)).toEqual([
      'GET /api/v2/approvals/a-1',
      'POST /api/v2/approvals/a-1/decisions',
    ]);
    expect(ctx.calls.auth).toContainEqual(['authorize', 'tok', 's1', 'APPROVE']);
  });

  it('operations lookup POST forwards prepared body after session binding', async () => {
    const ctx = fakeCtx();
    ctx.acsReplies.set('POST /api/v2/operations/lookup', jsonReply(200, { found: true }));
    const res = await handlePhoneRoute(ctx, jsonReq('POST', '/personal/v1/agent/operations/lookup',
      { operation: 'session.message', resourceId: 's1', idempotencyKey: 'key-1' },
      authed({ idempotencyKey: 'key-1', idempotencyKeyCount: 1 })));
    expect(res.status).toBe(200);
    const call = ctx.calls.acs.find((c) => c.method === 'POST')!;
    expect(JSON.parse(Buffer.from(call.body!).toString('utf8')))
      .toEqual({ operation: 'session.message', resourceId: 's1', idempotencyKey: 'key-1' });
  });

  it('approval list enforces per-item session binding', async () => {
    const ctx = fakeCtx();
    ctx.acsReplies.set('GET /api/v2/sessions/s1/approvals', jsonReply(200, {
      items: [{ approvalId: 'a-1', sessionId: 's1' }, { approvalId: 'a-2', sessionId: 'other' }],
    }));
    const res = await handlePhoneRoute(ctx, req('GET', '/personal/v1/agent/sessions/s1/approvals', authed()));
    expect(res.status).toBe(403);
    expect((res.body as JsonObject).code).toBe('APPROVAL_BINDING_MISMATCH');
  });

  it('attachment passes through upstream bytes + content type', async () => {
    const ctx = fakeCtx();
    ctx.acsReplies.set('GET /api/v2/sessions/s1/messages/m1/attachments/at1/bytes', {
      status: 200,
      body: new Uint8Array([1, 2, 3]),
      contentType: 'image/png',
    });
    const res = await handlePhoneRoute(ctx,
      req('GET', '/personal/v1/agent/sessions/s1/messages/m1/attachments/at1/bytes', authed()));
    expect(res.status).toBe(200);
    expect(res.contentType).toBe('image/png');
    expect(Buffer.from(res.bodyBytes!).equals(Buffer.from([1, 2, 3]))).toBe(true);
  });

  it('attachment with non-image content type → 415', async () => {
    const ctx = fakeCtx();
    ctx.acsReplies.set('GET /api/v2/sessions/s1/messages/m1/attachments/at1/bytes', {
      status: 200, body: new Uint8Array([1]), contentType: 'application/pdf',
    });
    const res = await handlePhoneRoute(ctx,
      req('GET', '/personal/v1/agent/sessions/s1/messages/m1/attachments/at1/bytes', authed()));
    expect(res.status).toBe(415);
    expect((res.body as JsonObject).code).toBe('UNSUPPORTED_MEDIA_TYPE');
  });

  it('unknown /agent route → 403 OPERATION_NOT_ALLOWED; non-agent → 403', async () => {
    const ctx = fakeCtx();
    const a = await handlePhoneRoute(ctx, req('GET', '/personal/v1/agent/secrets', authed()));
    expect(a.status).toBe(403);
    const b = await handlePhoneRoute(ctx, req('GET', '/personal/v1/whatever', authed()));
    expect(b.status).toBe(403);
    expect((b.body as JsonObject).code).toBe('OPERATION_NOT_ALLOWED');
  });

  it('GET proxy allows limit/cursor/before only', async () => {
    const ctx = fakeCtx();
    ctx.acsReplies.set('GET /api/v2/sessions/s1/messages?limit=5', jsonReply(200, { items: [] }));
    const ok = await handlePhoneRoute(ctx, req('GET', '/personal/v1/agent/sessions/s1/messages', authed({ rawQuery: 'limit=5' })));
    expect(ok.status).toBe(200);
    const bad = await handlePhoneRoute(ctx, req('GET', '/personal/v1/agent/sessions/s1/messages', authed({ rawQuery: 'bogus=1' })));
    expect(bad.status).toBe(400);
  });

  it('runs POST resolves session via GET run before dispatch', async () => {
    const ctx = fakeCtx();
    ctx.acsReplies.set('GET /api/v2/runs/r-1', jsonReply(200, { sessionId: 's1' }));
    ctx.acsReplies.set('POST /api/v2/runs/r-1/commands', jsonReply(200, { accepted: true }));
    const res = await handlePhoneRoute(ctx, jsonReq('POST', '/personal/v1/agent/runs/r-1/commands',
      { intent: 'STOP' }, authed({ idempotencyKey: 'k', idempotencyKeyCount: 1 })));
    expect(res.status).toBe(200);
    expect(ctx.calls.acs.map((c) => `${c.method} ${c.path}`)).toEqual([
      'GET /api/v2/runs/r-1',
      'POST /api/v2/runs/r-1/commands',
    ]);
    expect(ctx.calls.auth).toContainEqual(['authorize', 'tok', 's1', 'CONTROL']);
  });
});

// ---------------------------------------------------------------------------
// /personal/v1/client — delegation, statuses, error remap.
// ---------------------------------------------------------------------------

describe('client access', () => {
  it('production refuses mutations before forwarding when rights are unconfigured', async () => {
    const ctx = fakeCtx({ withClient: true });
    delete ctx.config.allowUnlicensedDevelopment;
    const res = await handlePhoneRoute(ctx, jsonReq('POST', '/personal/v1/client/conversations/c1.x/messages',
      { requestId: 'r1' }, authed({ idempotencyKey: 'k', idempotencyKeyCount: 1 })));
    expect(res.status).toBe(503);
    expect(ctx.calls.client).toHaveLength(0);
    expect(ctx.calls.acs).toHaveLength(0);
  });
  it('POST delegates to clientAccess.handle → 202', async () => {
    const ctx = fakeCtx({ withClient: true });
    const res = await handlePhoneRoute(ctx, jsonReq('POST', '/personal/v1/client/conversations/c1.x/messages',
      { requestId: 'r1' }, authed({ idempotencyKey: 'k', idempotencyKeyCount: 1 })));
    expect(res.status).toBe(202);
    const call = ctx.calls.client[0];
    expect(call.token).toBe('tok');
    expect(call.tail).toBe('/conversations/c1.x/messages');
    expect(call.body).toEqual({ requestId: 'r1' });
    expect(call.key).toBe('k');
  });

  it('POST /receipts/lookup → 200 (Java exception)', async () => {
    const ctx = fakeCtx({ withClient: true });
    const res = await handlePhoneRoute(ctx, jsonReq('POST', '/personal/v1/client/receipts/lookup', {}, authed()));
    expect(res.status).toBe(200);
  });

  it('wrong X-Client-Access-Version → 409 PROTOCOL_VERSION_UNSUPPORTED (envelope)', async () => {
    const ctx = fakeCtx({ withClient: true });
    const res = await handlePhoneRoute(ctx, req('GET', '/personal/v1/client/manifest', authed({ clientAccessVersion: 'x' })));
    expect(res.status).toBe(409);
    expect(((res.body as JsonObject).error as JsonObject).code).toBe('PROTOCOL_VERSION_UNSUPPORTED');
  });

  it('malformed POST JSON → 422 INVALID_REQUEST (wire codec, not body())', async () => {
    const ctx = fakeCtx({ withClient: true });
    const res = await handlePhoneRoute(ctx, req('POST', '/personal/v1/client/receipts/lookup', authed({
      rawBody: new Uint8Array(Buffer.from('{bad', 'utf8')),
    })));
    expect(res.status).toBe(422);
    const err = (res.body as JsonObject).error as JsonObject;
    expect(err.code).toBe('INVALID_REQUEST');
  });

  it('client errors remap to the envelope shape', async () => {
    const ctx = fakeCtx({ withClient: true });
    ctx.clientAccess = { handle: () => fail('IDEMPOTENCY_KEY_REUSED', 409) };
    const res = await handlePhoneRoute(ctx, jsonReq('POST', '/personal/v1/client/receipts/lookup', {}, authed()));
    expect(res.status).toBe(409);
    const err = (res.body as JsonObject).error as JsonObject;
    expect(err.code).toBe('IDEMPOTENCY_CONFLICT');
    expect(err.sourceCode).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(err.retryable).toBe(false);
    expect(err.requestId).toBeTypeOf('string');
  });

  it('absent seam → 503 SOURCE_NOT_CONFIGURED (envelope)', async () => {
    const ctx = fakeCtx();
    const res = await handlePhoneRoute(ctx, req('GET', '/personal/v1/client/manifest', authed()));
    expect(res.status).toBe(503);
    expect(((res.body as JsonObject).error as JsonObject).code).toBe('SOURCE_NOT_CONFIGURED');
  });
});

// ---------------------------------------------------------------------------
// Owner API — Java ownerHandler under /api/v2/personal-access.
// ---------------------------------------------------------------------------

const creds: OwnerCredentials = { ownerToken: 'owner-tok', ownerClientToken: 'client-tok' };

const ownerReq = (
  method: string, path: string, over: Partial<HttpRequest> = {},
): HttpRequest => req(method, path, {
  clientIp: '127.0.0.1',
  authorization: 'Bearer owner-tok',
  authorizationCount: 1,
  clientSessionHeader: 'client-tok',
  ...over,
});

describe('owner gate', () => {
  it('non-loopback peer → 403 LOCAL_OWNER_REQUIRED', async () => {
    const res = await handleOwnerRoute(fakeCtx(), ownerReq('GET', '/api/v2/personal-access/devices', { clientIp: '10.0.0.5' }), creds);
    expect(res.status).toBe(403);
    expect((res.body as JsonObject).code).toBe('LOCAL_OWNER_REQUIRED');
  });

  it('wrong bearer → 401 UNAUTHORIZED', async () => {
    const res = await handleOwnerRoute(fakeCtx(), ownerReq('GET', '/api/v2/personal-access/devices', { authorization: 'Bearer nope' }), creds);
    expect(res.status).toBe(401);
  });

  it('missing client session → 401 UNAUTHORIZED', async () => {
    const res = await handleOwnerRoute(fakeCtx(), ownerReq('GET', '/api/v2/personal-access/devices', { clientSessionHeader: undefined }), creds);
    expect(res.status).toBe(401);
  });
});

describe('owner routes', () => {
  it('GET capabilities → ownerStatus + certificate + actions view', async () => {
    const ctx = fakeCtx({ withLocalTasks: true });
    const res = await handleOwnerRoute(ctx, ownerReq('GET', '/api/v2/personal-access/capabilities'), creds);
    expect(res.status).toBe(200);
    const body = res.body as JsonObject;
    expect(body.personalHostId).toBe('host-1');
    expect(body.certificateSha256).toBe('aa'.repeat(32));
    expect(body.certificateNames).toEqual([[2, 'gw.test']]);
    expect(body.bindAddress).toBe('127.0.0.1');
    expect(body.supportedActions).toContain('LAUNCH');
    expect(body.resourceScopeVersion).toBe(2);
    expect(body.localSource).toMatchObject({ available: true });
  });

  it('POST pairing-invitations sessions form → probes + invitation + pem', async () => {
    const ctx = fakeCtx();
    ctx.acsReplies.set('GET /api/v2/sessions/s1', jsonReply(200, {}));
    const res = await handleOwnerRoute(ctx, ownerReq('POST', '/api/v2/personal-access/pairing-invitations', {
      rawBody: new Uint8Array(Buffer.from(JSON.stringify({
        requestId: 'rq-1', sessions: ['s1'], actions: ['OBSERVE', 'CONTROL'],
      }), 'utf8')),
    }), creds);
    expect(res.status).toBe(201);
    const body = res.body as JsonObject;
    expect(body.certificatePem).toContain('BEGIN CERTIFICATE');
    expect(ctx.calls.auth[0]).toEqual(['invitation', 'rq-1', ['s1'], ['CONTROL', 'OBSERVE'], 'aa'.repeat(32)]);
  });

  it('sessions probe non-200 → 409 SOURCE_NOT_READY', async () => {
    const ctx = fakeCtx();
    ctx.acsReplies.set('GET /api/v2/sessions/s1', jsonReply(500, {}));
    const res = await handleOwnerRoute(ctx, ownerReq('POST', '/api/v2/personal-access/pairing-invitations', {
      rawBody: new Uint8Array(Buffer.from(JSON.stringify({ requestId: 'rq', sessions: ['s1'], actions: ['OBSERVE'] }), 'utf8')),
    }), creds);
    expect(res.status).toBe(409);
    expect((res.body as JsonObject).code).toBe('SOURCE_NOT_READY');
  });

  it('resources + sessions together → 400 INVALID_SCOPE', async () => {
    const ctx = fakeCtx();
    const res = await handleOwnerRoute(ctx, ownerReq('POST', '/api/v2/personal-access/pairing-invitations', {
      rawBody: new Uint8Array(Buffer.from(JSON.stringify({
        requestId: 'rq', sessions: ['s1'],
        resources: [{ kind: 'ACS_SESSION', backendStoreId: 'acs-1', sessionId: 's1' }],
        actions: ['OBSERVE'],
      }), 'utf8')),
    }), creds);
    expect(res.status).toBe(400);
    expect((res.body as JsonObject).code).toBe('INVALID_SCOPE');
  });

  it('resources form validates owner scopes then invitationResources', async () => {
    const ctx = fakeCtx({ withLocalTasks: true });
    ctx.acsReplies.set('GET /api/v2/sessions/s1', jsonReply(200, {}));
    const res = await handleOwnerRoute(ctx, ownerReq('POST', '/api/v2/personal-access/pairing-invitations', {
      rawBody: new Uint8Array(Buffer.from(JSON.stringify({
        requestId: 'rq-2',
        resources: [
          { kind: 'ACS_SESSION', backendStoreId: 'acs-1', sessionId: 's1' },
          { kind: 'WORKER_LOCAL', backendStoreId: 'local-1', taskId: 't1' },
        ],
        launchScopes: [{ backendStoreId: 'local-1', projectId: 'p1', engineId: 'macos' }],
        actions: ['OBSERVE', 'LAUNCH'],
      }), 'utf8')),
    }), creds);
    expect(res.status).toBe(201);
    expect(ctx.calls.validateOwner).toHaveLength(1);
    const call = ctx.calls.auth.find(([n]) => n === 'invitationResources')!;
    expect(call[1]).toBe('rq-2');
  });

  it('GET pairing-requests + devices → auth lists', async () => {
    const ctx = fakeCtx();
    const a = await handleOwnerRoute(ctx, ownerReq('GET', '/api/v2/personal-access/pairing-requests'), creds);
    expect(a.status).toBe(200);
    expect(a.body).toEqual([{ pairingRequestId: 'pr-1', state: 'PENDING' }]);
    const b = await handleOwnerRoute(ctx, ownerReq('GET', '/api/v2/personal-access/devices'), creds);
    expect(b.body).toEqual([{ deviceGrantId: 'dev-1' }]);
  });

  it('POST decisions → auth.decide(rid, approve)', async () => {
    const ctx = fakeCtx();
    const res = await handleOwnerRoute(ctx, ownerReq('POST', '/api/v2/personal-access/pairing-requests/pr-1/decisions', {
      rawBody: new Uint8Array(Buffer.from(JSON.stringify({ approve: true }), 'utf8')),
    }), creds);
    expect(res.status).toBe(200);
    expect(ctx.calls.auth).toContainEqual(['decide', 'pr-1', true]);
    const bad = await handleOwnerRoute(ctx, ownerReq('POST', '/api/v2/personal-access/pairing-requests/pr-1/decisions', {
      rawBody: new Uint8Array(Buffer.from(JSON.stringify({ approve: 'yes' }), 'utf8')),
    }), creds);
    expect(bad.status).toBe(400);
  });

  it('PUT devices/{id}/scope sessions form → probes + updateScope', async () => {
    const ctx = fakeCtx();
    ctx.acsReplies.set('GET /api/v2/sessions/s1', jsonReply(200, {}));
    const res = await handleOwnerRoute(ctx, ownerReq('PUT', '/api/v2/personal-access/devices/dev-1/scope', {
      rawBody: new Uint8Array(Buffer.from(JSON.stringify({
        requestId: 'rq', expectedGrantRevision: '7', sessions: ['s1'], actions: ['OBSERVE'],
      }), 'utf8')),
    }), creds);
    expect(res.status).toBe(200);
    expect(ctx.calls.auth).toContainEqual(['updateScope', 'dev-1', 'rq', '7', ['s1'], ['OBSERVE']]);
  });

  it('PUT devices/{id}/scope resources form → updateScopeResources', async () => {
    const ctx = fakeCtx();
    ctx.acsReplies.set('GET /api/v2/sessions/s1', jsonReply(200, {}));
    const res = await handleOwnerRoute(ctx, ownerReq('PUT', '/api/v2/personal-access/devices/dev-1/scope', {
      rawBody: new Uint8Array(Buffer.from(JSON.stringify({
        requestId: 'rq', expectedGrantRevision: '7',
        resources: [{ kind: 'ACS_SESSION', backendStoreId: 'acs-1', sessionId: 's1' }],
        actions: ['OBSERVE'],
      }), 'utf8')),
    }), creds);
    expect(res.status).toBe(200);
    const call = ctx.calls.auth.find(([n]) => n === 'updateScopeResources')!;
    expect(call[1]).toBe('dev-1');
    expect(call[2]).toBe('rq');
  });

  it('DELETE devices/{id} → revoke + 204', async () => {
    const ctx = fakeCtx();
    const res = await handleOwnerRoute(ctx, ownerReq('DELETE', '/api/v2/personal-access/devices/dev-1'), creds);
    expect(res.status).toBe(204);
    expect(ctx.calls.auth).toContainEqual(['revoke', 'dev-1']);
  });

  it('unknown owner path → 404 NOT_FOUND', async () => {
    const res = await handleOwnerRoute(fakeCtx(), ownerReq('GET', '/api/v2/personal-access/nope'), creds);
    expect(res.status).toBe(404);
    expect((res.body as JsonObject).code).toBe('NOT_FOUND');
  });
});
