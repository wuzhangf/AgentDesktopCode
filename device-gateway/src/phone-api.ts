/**
 * Phone API — the device-facing `/personal/v1` route table, ported branch by
 * branch from PersonalAccessServer.remote(). Route order, validation order,
 * error codes, statuses and response shapes match Java exactly:
 *
 *   POST /personal/v1/pairing-requests                    rate() → auth.request → 202
 *   GET  /personal/v1/pairing-requests/{id}               rate() → observePairing → 200
 *   POST /personal/v1/pairing-requests/{id}/redemptions   rate() → redeem → 200
 *   POST /personal/v1/access-sessions/refresh             rate() → refresh → 200
 *   (bearer + authenticate below)
 *   /personal/v1/client/**                                clientAccess.handle → 202/200
 *   GET|PUT /personal/v1/agent/sessions/{sid}/execution-policy(-defaults)
 *   GET  /personal/v1/host                                auth.host + capabilities merge
 *   GET  /personal/v1/inbox[/{id}]                        requestRefresh + list/detail
 *   /personal/v1/local-tasks[/**]                         localTasks.remote passthrough
 *   /personal/v1/local-schedules[/**]                     scoped native schedules
 *   GET  /personal/v1/input-capabilities                  /api/v2/capabilities projection
 *   POST /personal/v1/transcriptions                      multipart → transcription.submit → 202
 *   GET|POST /personal/v1/transcriptions/{id}[/cancel]    get/cancel
 *   DELETE /personal/v1/device                            revoke + release → 204
 *   GET  /personal/v1/sessions                            foundation+summary+messages merge
 *   GET  /personal/v1/agent/sessions/{sid}/assignment-options
 *   POST /personal/v1/agent/sessions                      agentSessions.createSession
 *   GET  /personal/v1/agent/session-requests/{key}        agentSessions.sessionRequest
 *   POST /personal/v1/agent/sessions/{sid}/auxiliary-turns/{tid}/deliver
 *   GET  /personal/v1/agent/authorized-scope              stored-grant picker
 *   GET  /personal/v1/agent/model-options                 model-catalog projection
 *   /personal/v1/agent/**                                 whitelist proxy → acs.call
 *   anything else                                         OPERATION_NOT_ALLOWED 403
 *
 * Documented deviations from the Java source (all flagged inline):
 *  - ctx.acs undefined → UPSTREAM_UNAVAILABLE 503 (Java's IOException path);
 *  - ctx.clientAccess undefined → SOURCE_NOT_CONFIGURED 503;
 *  - per-device client-session bindings are registered upstream by
 *    bindings.ts (register once, heartbeat on reuse, revoke on release);
 *  - fetch timeout ≈ Java connect+read deadlines collapsed to 15s.
 */
import { randomUUID } from 'node:crypto';
import {
  exact,
  fail,
  GatewayError,
  id,
  isRecord,
  text,
} from './protocol.js';
import type { Device } from './protocol.js';
import type {
  AcsReply,
  GatewayContext,
  HttpRequest,
  HttpResponse,
  JsonObject,
} from './context.js';
import { bindingFor, releaseBinding } from './bindings.js';
import { validateModelSettings } from './agent-sessions.js';
import { requestMeta } from './request-meta.js';
import {
  ACTION_SET,
  SCOPE_RESOURCE_LIMIT,
  checkedLaunchScopes,
  validLaunchScope,
  validateResourceActions,
} from './scope.js';
import { launchScopeKey, type LaunchScope, type ScopeRecord } from './protocol.js';
import { truncateItems } from './child-messages.js';

// ---------------------------------------------------------------------------
// Request helpers — Java bearer()/header()/body()/query() equivalents.
// ---------------------------------------------------------------------------

/** Java bearer(): exactly one Authorization, `Bearer ` + ≥1 char. */
const bearer = (req: HttpRequest): string => {
  if (req.accessToken === undefined) fail('ACCESS_UNAUTHORIZED', 401);
  return req.accessToken;
};

/** Java header(x,"Idempotency-Key"): exactly one header value required. */
const idempotencyHeader = (req: HttpRequest): string => {
  if (req.idempotencyKeyCount !== 1 || req.idempotencyKey === undefined) fail('INVALID_REQUEST', 400);
  return req.idempotencyKey;
};

/**
 * Java body(): read at most 65536 bytes, parse JSON, require an object.
 * rawBody is the listener-read payload; bodyError is applied lazily so
 * routes that never read a body are unaffected. req.body is accepted when
 * the caller (tests) already parsed JSON.
 */
const jsonBody = (req: HttpRequest, budget = 65_536): JsonObject => {
  if (req.bodyError === 'BODY_TOO_LARGE') fail('BODY_TOO_LARGE', 413);
  if (req.rawBody !== undefined) {
    if (req.rawBody.length > budget) fail('BODY_TOO_LARGE', 413);
    let parsed: unknown;
    try {
      parsed = req.rawBody.length === 0 ? null : JSON.parse(Buffer.from(req.rawBody).toString('utf8'));
    } catch {
      fail('INVALID_REQUEST', 400);
    }
    if (!isRecord(parsed)) fail('INVALID_REQUEST', 400);
    return parsed;
  }
  if (req.body === undefined || !isRecord(req.body)) fail('INVALID_REQUEST', 400);
  return req.body;
};

/** Java path.split("/") drops trailing empty segments; JS keeps them. */
const javaSplit = (path: string): string[] => {
  const parts = path.split('/');
  while (parts.length > 0 && parts[parts.length - 1] === '') parts.pop();
  return parts;
};

/** split('=',2) keeping the remainder in the value, like Java. */
const firstPair = (item: string): [string, string | undefined] => {
  const idx = item.indexOf('=');
  return idx < 0 ? [item, undefined] : [item.slice(0, idx), item.slice(idx + 1)];
};

/** URLDecoder form semantics: '+' → space, then percent decoding. */
const decodeForm = (value: string): string => {
  try {
    return decodeURIComponent(value.replace(/\+/g, ' '));
  } catch {
    fail('INVALID_REQUEST', 400);
  }
};

/** Java query(): only allowed keys, `k=v` pairs, no duplicates, ≤4096 chars. */
const boundedQuery = (req: HttpRequest, allowed: string[]): Map<string, string> => {
  const out = new Map<string, string>();
  const raw = req.rawQuery;
  if (raw === null || raw === '') return out;
  for (const part of raw.split('&')) {
    const [key, value] = firstPair(part);
    if (value === undefined || !allowed.includes(key) || out.has(key)) fail('INVALID_REQUEST', 400);
    const decoded = decodeForm(value);
    if (decoded.length > 4096) fail('INVALID_REQUEST', 400);
    out.set(key, decoded);
  }
  return out;
};

/** Java parseLimit(): [1-9][0-9]{0,2}, ≤100. */
const parseLimit = (value: string | undefined): number => {
  if (value === undefined || !/^[1-9][0-9]{0,2}$/.test(value)) fail('INVALID_REQUEST', 400);
  const n = Number.parseInt(value, 10);
  if (n > 100) fail('INVALID_REQUEST', 400);
  return n;
};

const asObj = (v: unknown): JsonObject => (isRecord(v) ? v : {});
const asArr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const asText = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback);
const asLong = (v: unknown): number => (typeof v === 'number' ? v : 0);

// ---------------------------------------------------------------------------
// Rate limiter — Java rate(): per remote IP, 20 attempts per 10s window,
// eldest entry evicted past 256 tracked peers. Pairing/refresh routes only.
// ---------------------------------------------------------------------------

interface RateWindow {
  start: number;
  count: number;
}

const RATE_WINDOWS = new WeakMap<GatewayContext, Map<string, RateWindow>>();

const rate = (ctx: GatewayContext, req: HttpRequest): void => {
  let attempts = RATE_WINDOWS.get(ctx);
  if (!attempts) {
    attempts = new Map();
    RATE_WINDOWS.set(ctx, attempts);
  }
  const now = Date.now();
  const peer = req.clientIp;
  let window = attempts.get(peer);
  if (!window || now - window.start >= 10_000) {
    window = { start: now, count: 0 };
    attempts.set(peer, window);
  }
  if (++window.count > 20) fail('RATE_LIMITED', 429);
  if (attempts.size > 256) {
    const eldest = attempts.keys().next();
    if (!eldest.done) attempts.delete(eldest.value);
  }
};

/**
 * Member pairing — relay-ingress-only grant. The member's device gets the
 * full local catalog as its launch scope (member = owner of the bound host):
 * every project × every registered engine on every reachable backend, plus
 * the complete action set. Launched taskIds self-grant WORKER_LOCAL via
 * appendLaunchedTask; no pre-pinned resources are needed.
 */
const localCatalogScope = async (ctx: GatewayContext): Promise<ScopeRecord> => {
  if (ctx.localTasks === undefined) fail('LOCAL_SOURCE_NOT_CONFIGURED', 409);
  const catalog = await ctx.localTasks.ownerCatalog();
  const launches: LaunchScope[] = [];
  const seen = new Set<string>();
  const catalogs = [catalog,
    ...(Array.isArray(catalog.backends) ? catalog.backends.filter(isRecord) : [])];
  // The wire scope is bounded: engines outside the protocol set cannot be
  // expressed, and a catalog may hold more project × engine combinations than
  // SCOPE_RESOURCE_LIMIT — dedupe and take the first that fit.
  outer: for (const c of catalogs) {
    const backend = asText(c.backendStoreId);
    if (backend === '') continue;
    const engines = asArr(c.engines).map(asObj)
      .map((e) => asText(e.engineId)).filter((e) => e !== '');
    for (const p of asArr(c.projects).map(asObj)) {
      const project = asText(p.projectId);
      if (project === '') continue;
      for (const engineId of engines) {
        const launch = { backendStoreId: backend, projectId: project, engineId };
        if (!validLaunchScope(launch)) continue;
        const key = launchScopeKey(launch);
        if (seen.has(key)) continue;
        seen.add(key);
        launches.push(launch);
        if (launches.length >= SCOPE_RESOURCE_LIMIT) break outer;
      }
    }
  }
  // An empty catalog still yields a connection-only grant: pairing must not
  // depend on a live agent source. LAUNCH joins when the scope widens later.
  // Creating ACS sessions requires a separate, explicit owner invitation.
  const actions = [...ACTION_SET].filter((a) => a !== 'CREATE' && (launches.length > 0 || a !== 'LAUNCH'));
  const scope = {
    resources: [],
    launchScopes: checkedLaunchScopes(launches),
    actions,
  };
  validateResourceActions(scope.resources, scope.launchScopes, actions);
  return scope;
};

const memberPairing = async (ctx: GatewayContext, b: JsonObject): Promise<JsonObject> => {
  if (b.member !== true) fail('INVALID_REQUEST', 400);
  if (ctx.auth.memberRequest === undefined) fail('OPERATION_NOT_ALLOWED', 403);
  return ctx.auth.memberRequest(b, await localCatalogScope(ctx));
};

/**
 * LAN discovery pairing — the Bonjour-discovered phone has no sealed invite.
 * Whether the tap on 配对 is itself the owner's intent (auto-approve, the
 * product default) or must wait for an explicit owner decision (PENDING)
 * is governed by the pairing-approval setting, not this route; the approved
 * scope is the same local catalog either way. Only the public listener
 * honors `discovery` — the relay ingress always carries member attestation
 * and rejects it.
 */
const discoveryPairing = async (ctx: GatewayContext, b: JsonObject): Promise<JsonObject> => {
  if (b.discovery !== true) fail('INVALID_REQUEST', 400);
  if (ctx.auth.discoveryRequest === undefined) fail('OPERATION_NOT_ALLOWED', 403);
  return ctx.auth.discoveryRequest(b, await localCatalogScope(ctx));
};

// ---------------------------------------------------------------------------
// ACS seam helpers — Java call() sites. A missing seam maps to the Java
// IOException path: UPSTREAM_UNAVAILABLE 503.
// ---------------------------------------------------------------------------

const acsCall = async (
  ctx: GatewayContext, method: string, path: string,
  body: Uint8Array | undefined, key: string | undefined,
  binding: string | undefined, maxReply?: number,
): Promise<AcsReply> => {
  if (ctx.acs === undefined) fail('UPSTREAM_UNAVAILABLE', 503);
  return ctx.acs.call(method, path, body, key, binding, maxReply);
};

/** Java mapper.readTree(reply.body) — parse failure → UPSTREAM_UNAVAILABLE. */
const acsJson = (reply: AcsReply): unknown => {
  try {
    return JSON.parse(Buffer.from(reply.body).toString('utf8'));
  } catch {
    fail('UPSTREAM_UNAVAILABLE', 503);
  }
};

/** Java messageBudget(): min(16MB, InputLimits.CURRENT.maxRequestBodyBytes). */
const messageBudget = (): number => 16 * 1024 * 1024;

const handoffUpstream = '/api/v2/personal-access/gateway-work-handoffs';

async function acsHandoffCapabilities(ctx: GatewayContext, device: Device, relay: boolean): Promise<JsonObject | undefined> {
  // The shared Java relay manifest does not currently advertise this route.
  if (relay || !ctx.acs || !ctx.auth.appendCreatedSession || !device.actions?.includes('HANDOFF')) return undefined;
  try {
    const reply = await acsCall(ctx, 'GET', handoffUpstream, undefined, undefined, await bindingFor(ctx, device));
    const value = asObj(acsJson(reply));
    return reply.status === 200 && value.schemaVersion === 'gateway-work-handoffs/1' ? value : undefined;
  } catch {
    return undefined;
  }
}

async function acsHandoff(ctx: GatewayContext, req: HttpRequest, token: string, device: Device): Promise<HttpResponse> {
  if (req.relayIngress === true || !ctx.acs || !ctx.auth.appendCreatedSession ||
      !device.actions?.includes('HANDOFF') || !device.actions.includes('OBSERVE')) {
    fail('WORK_HANDOFFS_NOT_CONFIGURED', 409);
  }
  const root = '/personal/v1/work-handoffs';
  const path = req.path;
  const method = req.method;
  const tail = path.slice(root.length);
  const ref = '/wh-[a-f0-9]{16,64}';
  const read = method === 'GET' && (tail === '' || tail === '/recovery-grants' || /^\/requests\/[A-Za-z0-9._-]{1,128}$/.test(tail)
    || new RegExp('^' + ref + '(?:/materials(?:/[A-Za-z0-9._-]{1,128}/chunks)?|/target-retries/[A-Za-z0-9._-]{1,128})?$').test(tail));
  const write = method === 'POST' && (tail === '' || new RegExp('^' + ref + '/(?:confirm|continue|retry-target|cancel|material-continuations)$').test(tail));
  if (!read && !write) fail('OPERATION_NOT_ALLOWED', 403);
  if (req.rawQuery !== null) {
    if (!read || !tail.endsWith('/chunks') || req.rawQuery.length > 4096) fail('INVALID_REQUEST', 400);
    boundedQuery(req, ['offset', 'limit', 'digest']);
  }
  const payload = write ? jsonBody(req) : {};
  const key = write ? idempotencyHeader(req) : undefined;
  const bound = await bindingFor(ctx, device);
  const grant = await ctx.auth.authenticate(token);
  if (grant.revision !== device.revision) fail('GRANT_REVISION_CHANGED', 409);
  const peerKey = write ? ctx.workHandoffs?.gatewayPeerKey?.(payload) : undefined;
  const retirementPeerKey = write ? ctx.workHandoffs?.gatewayRetirementPeerKey?.(payload) : undefined;
  const wire = {
    gatewayHostId: ctx.config.personalHostId, grantRevision: grant.revision, sessions: grant.sessions ?? [],
    mayCreate: grant.actions?.includes('CREATE') === true, method, path, payload,
    ...(key === undefined ? {} : { key }),
    ...(req.rawQuery === null ? {} : { query: req.rawQuery }),
    ...(peerKey === undefined ? {} : { peerKey }),
    ...(retirementPeerKey === undefined ? {} : { retirementPeerKey }),
  };
  const upstream = await acsCall(ctx, 'POST', handoffUpstream,
    new TextEncoder().encode(JSON.stringify(wire)), undefined, bound);
  const observed = await ctx.auth.authenticate(token);
  if (observed.revision !== grant.revision) fail('GRANT_REVISION_CHANGED', 409);
  const data = asObj(acsJson(upstream));
  if (upstream.status < 200 || upstream.status >= 300) return { status: upstream.status, body: data };
  if (!isRecord(data.result)) fail('UPSTREAM_UNAVAILABLE', 503);
  if (data.createdSessionId !== undefined) {
    const sid = asText(data.createdSessionId);
    id(sid);
    await ctx.auth.appendCreatedSession(grant.id, grant.revision, sid);
  }
  if (data.result.gatewayFrozenExport === true) {
    if (!read || !tail.endsWith('/materials') || !ctx.workHandoffs?.signGatewayExport) fail('SEAL_PROOF_INVALID', 409);
    return { status: upstream.status, body: ctx.workHandoffs.signGatewayExport(data.result) };
  }
  return { status: upstream.status, body: data.result };
}

// ---------------------------------------------------------------------------
// Error mapping — Java problem(): {code, detail}; /client/ gets the envelope.
// ---------------------------------------------------------------------------

const clientErrorCode = (e: GatewayError): string => {
  const code = e.code;
  if (e.httpStatus === 401) return 'AUTH_REQUIRED';
  if (e.httpStatus === 403) return 'SCOPE_DENIED';
  if (['IDEMPOTENCY_KEY_REUSED', 'IDEMPOTENCY_PAYLOAD_MISMATCH', 'IDEMPOTENCY_KEY_MISMATCH'].includes(code)) {
    return 'IDEMPOTENCY_CONFLICT';
  }
  if (['STATE_VERSION_CONFLICT', 'SESSION_VERSION_CONFLICT', 'NATIVE_TARGET_CHANGED', 'NATIVE_INPUT_EXPIRED'].includes(code)) {
    return 'TARGET_CHANGED';
  }
  if (code === 'HISTORY_REVISION_CHANGED') return 'CONTENT_REVISION_CHANGED';
  if (code === 'BODY_TOO_LARGE') return 'REQUEST_TOO_LARGE';
  if (['UPSTREAM_OUTCOME_UNKNOWN', 'LOCAL_REPLY_UNCONFIRMED'].includes(code)) return 'SOURCE_OUTCOME_UNCONFIRMED';
  return code;
};

const phoneProblem = (path: string, error: unknown): HttpResponse => {
  if (error instanceof GatewayError) {
    if (path.startsWith('/personal/v1/client/')) {
      return {
        status: error.httpStatus,
        body: {
          error: {
            code: clientErrorCode(error),
            sourceCode: error.code,
            message: clientErrorCode(error),
            retryable: false,
            requestId: randomUUID(),
          },
        },
      };
    }
    return { status: error.httpStatus, body: { code: error.code, detail: error.code } };
  }
  // Java: unexpected Exception → UPSTREAM_UNAVAILABLE 503 (internals logged).
  console.error('device-gateway: unexpected phone-api error:', error);
  return { status: 503, body: { code: 'UPSTREAM_UNAVAILABLE', detail: 'UPSTREAM_UNAVAILABLE' } };
};

// ---------------------------------------------------------------------------
// Route dispatch — Java remote().
// ---------------------------------------------------------------------------

import { requiresCommercialAccess, requiresMembershipIngress } from './commercial.js';

export async function handlePhoneRoute(ctx: GatewayContext, req: HttpRequest): Promise<HttpResponse> {
  let finish: (() => void) | undefined;
  try {
    if (ctx.startupUpdate) fail('UPDATE_IN_PROGRESS', 503);
    if (req.method !== 'GET') finish = ctx.updatePreparation?.admit();
    const out = await route(ctx, req);
    logRequest(req, out);
    return out;
  } catch (error) {
    const out = phoneProblem(req.path, error);
    logRequest(req, out);
    return out;
  } finally {
    finish?.();
  }
}

/** DEVICE_GATEWAY_LOG_REQUESTS=1 — method/path/status/code per request; never bodies or tokens. */
const logRequest = (req: HttpRequest, out: HttpResponse): void => {
  if (process.env.DEVICE_GATEWAY_LOG_REQUESTS !== '1') return;
  const code = isRecord(out.body) && typeof out.body.code === 'string' ? out.body.code : '';
  console.log(JSON.stringify({ listener: 'phone-api', method: req.method, path: req.path, status: out.status, code }));
};

const route = async (ctx: GatewayContext, req: HttpRequest): Promise<HttpResponse> => {
  const { path, method } = req;
  if (path.includes('%') || path.includes('..') || path.includes('//')) fail('INVALID_REQUEST', 400);

  if (path === '/personal/v1/pairing-requests' && method === 'POST') {
    rate(ctx, req);
    const b = exact(jsonBody(req),
      'pairingRequestId', 'inviteId', 'inviteSecret', 'installationId', 'label', 'pollingSecretHash', 'member', 'discovery');
    // Member-attested pairing: reaching the relay listener at all means the
    // member service authenticated the caller and routed it to this bound
    // host, so the channel itself is the grant — no sealed invitation. The
    // member marker is meaningless on the public listener and rejected there.
    if (b.member !== undefined && req.relayIngress !== true) fail('INVALID_REQUEST', 400);
    // Discovery pairing is the LAN inverse: no attestation, approval mode
    // decided by Devices.pairingApprovalRequired (default auto-approve).
    // It is meaningless via relay (member attestation already applies).
    if (b.discovery !== undefined && req.relayIngress === true) fail('INVALID_REQUEST', 400);
    if (req.relayIngress === true && b.inviteId === undefined) {
      return { status: 202, body: await memberPairing(ctx, b) };
    }
    if (b.discovery === true) {
      return { status: 202, body: await discoveryPairing(ctx, b) };
    }
    return { status: 202, body: await ctx.auth.request(b) };
  }

  if (path.startsWith('/personal/v1/pairing-requests/')) {
    rate(ctx, req);
    const p = javaSplit(path);
    if (p.length === 5 && method === 'GET') {
      return { status: 200, body: await ctx.auth.observePairing(p[4], bearer(req)) };
    }
    if (p.length === 6 && p[5] === 'redemptions' && method === 'POST') {
      const b = exact(jsonBody(req), 'redemptionId');
      return { status: 200, body: await ctx.auth.redeem(p[4], bearer(req), text(b, 'redemptionId')) };
    }
    fail('NOT_FOUND', 404);
  }

  if (path === '/personal/v1/access-sessions/refresh' && method === 'POST') {
    rate(ctx, req);
    const b = exact(jsonBody(req), 'refreshToken', 'refreshRequestId');
    return {
      status: 200,
      body: await ctx.auth.refresh(text(b, 'refreshToken'), text(b, 'refreshRequestId')),
    };
  }

  // Worker self-registration — unauthenticated because the one-shot secret
  // the owner minted IS the consent (same trust shape as pairing requests).
  if (path === '/personal/v1/worker-registrations' && method === 'POST') {
    rate(ctx, req);
    if (ctx.workers === undefined) fail('OPERATION_NOT_ALLOWED', 403);
    const b = exact(jsonBody(req), 'workerSecret', 'connectionId', 'url', 'token', 'displayName');
    return { status: 202, body: await ctx.workers.register(b) };
  }

  // Fixed xagt read RPC — peer Links reach it here with a reader credential
  // (its own grant domain; a device token never matches). The same path on
  // the loopback owner listener serves the local MCP stdio adapter.
  if (path === '/api/xagt/v1/read' && method === 'POST') {
    if (ctx.xagt === undefined) fail('OPERATION_NOT_ALLOWED', 403);
    return ctx.xagt.read(req);
  }
  if (path === '/api/xagt/v1/interact' && method === 'POST') {
    if (ctx.xagt === undefined) fail('OPERATION_NOT_ALLOWED', 403);
    return ctx.xagt.interact(req);
  }

  const token = bearer(req);
  const device = await ctx.auth.authenticate(token);
  const actions = new Set(device.actions ?? []);
  if (path === '/personal/v1/commercial/challenge' && method === 'GET') {
    if (!ctx.commercial) fail('DAILY_SERVICE_NOT_CONFIGURED',503);
    return {status:200,body:ctx.commercial.challenge(device)};
  }
  if (path === '/personal/v1/commercial/authorizations' && method === 'POST') {
    if (!ctx.commercial) fail('DAILY_SERVICE_NOT_CONFIGURED',503);
    return {status:200,body:await ctx.commercial.attach(device,exact(jsonBody(req),'controlToken'))};
  }
  // Lane split: LAN writes ride the device bearer alone (pairing = consent,
  // the app-store purchase is the license); only relay/public-network writes
  // and the voice capability itself require membership.
  if (requiresCommercialAccess(req, ctx.config.localCliOnly)
      && (req.relayIngress === true || requiresMembershipIngress(req))) {
    if (ctx.commercial) await ctx.commercial.authorize(device,req);
    else if (ctx.config.allowUnlicensedDevelopment !== true) fail('ENTITLEMENT_CHECK_REQUIRED',503);
  }

  if (path.startsWith('/personal/v1/client/')) {
    const version = req.clientAccessVersion;
    if (version !== undefined && version !== 'client-access/1') fail('PROTOCOL_VERSION_UNSUPPORTED', 409);
    if (ctx.clientAccess === undefined) fail('SOURCE_NOT_CONFIGURED', 503);
    let request: unknown = null;
    if (method === 'POST') {
      if (req.bodyError === 'BODY_TOO_LARGE') fail('BODY_TOO_LARGE', 413);
      const bytes = req.rawBody ?? new Uint8Array();
      if (bytes.length > 65_536) fail('BODY_TOO_LARGE', 413);
      // Java ClientAccessWire.JSON.readTree — parse failure → INVALID_REQUEST 422.
      try {
        request = bytes.length === 0 ? null : JSON.parse(Buffer.from(bytes).toString('utf8'));
      } catch {
        fail('INVALID_REQUEST', 422);
      }
    }
    const result = await ctx.clientAccess.handle(
      token, method, path.substring('/personal/v1/client'.length), request,
      req.idempotencyKey ?? null, req.rawQuery);
    return { status: method === 'POST' && !path.endsWith('/receipts/lookup') ? 202 : 200, body: result };
  }

  if (/^\/personal\/v1\/agent\/sessions\/[^/]+\/execution-policy(-defaults)?$/.test(path)) {
    return executionPolicy(ctx, req, token, device, path, method);
  }

  if (path === '/personal/v1/host' && method === 'GET') {
    const view = await ctx.auth.host(device, ctx.config.bootId);
    view.platform = process.platform;
    if (ctx.updatePreparation?.preparing) view.maintenance = 'INSTALLING_UPDATE';
    view.commercial = {required:ctx.config.allowUnlicensedDevelopment !== true && ctx.config.localCliOnly !== true,
      lanes:{lan:'free',relay:'member',voice:'member'},
      dailyOrigin:ctx.commercial?.dailyOrigin ?? null};
    const capabilities = asObj(view.capabilities);
    capabilities.executionPolicy = true;
    capabilities.manageExecutionPolicy = actions.has('POLICY');
    capabilities.localTasks = ctx.localTasks !== undefined;
    capabilities.launch = ctx.localTasks !== undefined && actions.has('LAUNCH');
    if (ctx.localSchedules) capabilities.localSchedules = ctx.localSchedules.hasPhoneGrant(device.id);
    capabilities.create = ctx.agentSessions !== undefined && actions.has('CREATE');
    capabilities.sessionModelSelection = ctx.agentSessions !== undefined
      && (actions.has('CREATE') || (device.sessions ?? []).length > 0);
    capabilities.inbox = true;
    capabilities.notifications = false;
    const acsHandoff = ctx.acsHandoffBridge ? await acsHandoffCapabilities(ctx, device, req.relayIngress === true) : undefined;
    capabilities.handoff = ctx.acsHandoffBridge
      ? acsHandoff != null
      : ctx.workHandoffs !== undefined && actions.has('HANDOFF');
    if (capabilities.handoff && ctx.acsHandoffBridge) capabilities.handoffTargetKinds =
      acsHandoff?.remoteSource === true && ctx.workHandoffs?.signGatewayExport
        ? ['ACS_LOCAL', 'NATIVE_REMOTE', 'ACS_REMOTE'] : ['ACS_LOCAL'];
    if (capabilities.handoff && ctx.acsHandoffBridge && ctx.workHandoffs && actions.has('CREATE')) capabilities.handoffAcsImport = true;
    if (capabilities.handoff && ctx.nativeLocalHandoffs) capabilities.handoffTargetKinds = ['NATIVE_LOCAL', 'NATIVE_REMOTE', 'ACS_REMOTE'];
    if (capabilities.handoff && ctx.nativeLocalHandoffs) capabilities.handoffBackgroundProgress = true;
    if (capabilities.handoff && (ctx.nativeLocalHandoffs || acsHandoff?.remoteRecovery === true))
      capabilities.handoffRecovery = true;
    if (capabilities.handoff && (ctx.nativeLocalHandoffs || capabilities.handoffAcsImport))
      capabilities.handoffTargetSealing = true;
    return { status: 200, body: view };
  }

  if (path === '/personal/v1/inbox' && method === 'GET') {
    const query = boundedQuery(req, ['cursor', 'limit']);
    const limit = query.has('limit') ? parseLimit(query.get('limit')) : 30;
    ctx.inbox.requestRefresh(device);
    const page = await ctx.inbox.list(device, query.get('cursor'), limit);
    if ((await ctx.auth.authenticate(token)).revision !== device.revision) fail('GRANT_REVISION_CHANGED', 409);
    return { status: 200, body: page };
  }

  if (/^\/personal\/v1\/inbox\/[A-Za-z0-9._-]+$/.test(path) && method === 'GET') {
    const item = await ctx.inbox.detail(device, path.substring('/personal/v1/inbox/'.length));
    if ((await ctx.auth.authenticate(token)).revision !== device.revision) fail('GRANT_REVISION_CHANGED', 409);
    return { status: 200, body: item };
  }

  if (path === '/personal/v1/approvals' && method === 'GET') {
    if (ctx.approvals === undefined) fail('NOT_FOUND', 404);
    if (ctx.config.localCliOnly && !actions.has('APPROVE')) fail('DEVICE_SCOPE_DENIED', 403);
    const query = boundedQuery(req, ['waitMillis']);
    const waitRaw = query.get('waitMillis');
    if (waitRaw !== undefined && !/^[0-9]{1,5}$/.test(waitRaw)) fail('INVALID_REQUEST', 400);
    const page = await ctx.approvals.list(device, waitRaw === undefined ? 0 : Number.parseInt(waitRaw, 10));
    if ((await ctx.auth.authenticate(token)).revision !== device.revision) fail('GRANT_REVISION_CHANGED', 409);
    return { status: 200, body: page };
  }

  if (/^\/personal\/v1\/approvals\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(path) && method === 'GET') {
    if (ctx.approvals === undefined) fail('NOT_FOUND', 404);
    if (ctx.config.localCliOnly && !actions.has('APPROVE')) fail('DEVICE_SCOPE_DENIED', 403);
    const out = await ctx.approvals.lookup(device, path.split('/')[4]!);
    if ((await ctx.auth.authenticate(token)).revision !== device.revision) fail('GRANT_REVISION_CHANGED', 409);
    return { status: 200, body: out };
  }

  if (/^\/personal\/v1\/approvals\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}\/decision$/.test(path) && method === 'POST') {
    if (ctx.approvals === undefined) fail('NOT_FOUND', 404);
    if (ctx.config.localCliOnly && !actions.has('APPROVE')) fail('DEVICE_SCOPE_DENIED', 403);
    const approvalId = path.split('/')[4];
    const out = await ctx.approvals.decide(device, approvalId, jsonBody(req));
    return { status: 200, body: out };
  }

  const scheduleRoot = '/personal/v1/local-schedules';
  if (path === scheduleRoot || path.startsWith(scheduleRoot + '/')) {
    const scheduler = ctx.localSchedules;
    if (!scheduler) fail('NOT_FOUND', 404);
    if (path === scheduleRoot) {
      if (method === 'GET') return { status: 200, body: scheduler.list(device.id) };
      if (method === 'POST') return { status: 201, body: await scheduler.create(jsonBody(req), device.id) };
    } else {
      const [ruleId, action, extra] = path.slice(scheduleRoot.length + 1).split('/');
      if (ruleId && extra === undefined) {
        if (method === 'GET' && action === undefined) return { status: 200, body: scheduler.get(ruleId, device.id) };
        if (method === 'GET' && action === 'occurrences') {
          return { status: 200, body: scheduler.occurrences(ruleId, device.id) };
        }
        if (method === 'PUT' && action === undefined) {
          return { status: 200, body: await scheduler.update(ruleId, jsonBody(req), false, device.id) };
        }
        if (method === 'POST' && action === 'remove') {
          return { status: 200, body: await scheduler.update(ruleId, jsonBody(req), true, device.id) };
        }
      }
    }
    fail('NOT_FOUND', 404);
  }

  if (path === '/personal/v1/local-tasks' || path.startsWith('/personal/v1/local-tasks/')) {
    if (ctx.localTasks === undefined) fail('LOCAL_SOURCE_NOT_CONFIGURED', 409);
    const input = ['POST', 'PUT'].includes(method) ? jsonBody(req) : null;
    const key = input !== null && 'requestKey' in input ? idempotencyHeader(req) : null;
    const result = await ctx.localTasks.remote(token, method, path, input, key, req.rawQuery);
    await ctx.auth.authenticate(token);
    return { status: result.status, body: result.body };
  }

  if (path === '/personal/v1/input-capabilities' && method === 'GET') {
    return inputCapabilities(ctx, req, token, device);
  }

  if (path === '/personal/v1/transcriptions' && method === 'POST') {
    if (ctx.transcription === undefined) fail(ctx.config.transcriptionReason ?? 'TRANSCRIPTION_NOT_CONFIGURED', 503);
    const upload = readAudioMultipart(req);
    const b = exact(upload.metadata, 'requestKey', 'sessionId', 'audioSha256', 'language');
    const key = text(b, 'requestKey');
    if (key !== idempotencyHeader(req)) fail('INVALID_REQUEST', 400);
    try {
      return {
        status: 202,
        body: await ctx.transcription.submit(token, key, text(b, 'sessionId'),
          text(b, 'audioSha256'), upload.audio, b.language !== undefined ? text(b, 'language') : 'auto'),
      };
    } finally {
      upload.audio.fill(0);
    }
  }

  if (path.startsWith('/personal/v1/transcriptions/')) {
    if (ctx.transcription === undefined) fail(ctx.config.transcriptionReason ?? 'TRANSCRIPTION_NOT_CONFIGURED', 503);
    const p = javaSplit(path);
    if (p.length === 5 && method === 'GET') {
      return { status: 200, body: await ctx.transcription.get(token, p[4]) };
    }
    if (p.length === 6 && p[5] === 'cancel' && method === 'POST') {
      exact(jsonBody(req));
      return { status: 200, body: await ctx.transcription.cancel(token, p[4]) };
    }
    fail('OPERATION_NOT_ALLOWED', 403);
  }

  if (path === '/personal/v1/device' && method === 'DELETE') {
    await ctx.auth.revoke(device.id);
    await releaseBinding(ctx, device.id);
    return { status: 204, body: null };
  }

  if (path === '/personal/v1/sessions' && method === 'GET') {
    return sessionList(ctx, token, device);
  }

  if (method === 'GET' && /^\/personal\/v1\/agent\/sessions\/[A-Za-z0-9._-]+\/assignment-options$/.test(path)) {
    return assignmentOptions(ctx, token, device, javaSplit(path)[5]);
  }

  // Java: POST /personal/v1/agent/sessions → agentSessions.createSession.
  if (path === '/personal/v1/agent/sessions' && method === 'POST') {
    if (ctx.agentSessions === undefined) fail('UPSTREAM_UNAVAILABLE', 503);
    const result = await ctx.agentSessions.createSession(token, jsonBody(req), idempotencyHeader(req));
    return { status: result.status, body: result.body };
  }

  // Java: GET /personal/v1/agent/session-requests/{key} → sessionRequest.
  if (method === 'GET'
      && /^\/personal\/v1\/agent\/session-requests\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(path)) {
    if (ctx.agentSessions === undefined) fail('UPSTREAM_UNAVAILABLE', 503);
    const result = await ctx.agentSessions.sessionRequest(
      token, path.substring('/personal/v1/agent/session-requests/'.length));
    return { status: result.status, body: result.body };
  }

  // Java: POST .../sessions/{sid}/auxiliary-turns/{tid}/deliver → deliver.
  if (method === 'POST'
      && /^\/personal\/v1\/agent\/sessions\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}\/auxiliary-turns\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}\/deliver$/.test(path)) {
    if (ctx.agentSessions === undefined) fail('UPSTREAM_UNAVAILABLE', 503);
    const seg = javaSplit(path);
    const result = await ctx.agentSessions.deliver(
      token, seg[5]!, seg[7]!, jsonBody(req), idempotencyHeader(req));
    return { status: result.status, body: result.body };
  }

  // Java: /personal/v1/work-handoffs/** → workHandoffs.remote — the durable
  // handoff coordinator (M04). Absent coordinator → UPSTREAM_UNAVAILABLE.
  if (path === '/personal/v1/work-handoffs' || path.startsWith('/personal/v1/work-handoffs/')) {
    const tail = path === '/personal/v1/work-handoffs' ? [] : javaSplit(path).slice(4);
    if (ctx.acsHandoffBridge) {
      const importRoute = ['imports', 'import-recoveries', 'target-preflights', 'trusted-peer-keys'].includes(tail[0]);
      const lookup = tail[0] === 'requests' && method === 'GET';
      if (!req.relayIngress && ctx.workHandoffs && (importRoute || lookup)) {
        try {
          return await ctx.workHandoffs.remote(token, method, tail, method === 'POST' ? jsonBody(req) : null,
            method === 'POST' ? idempotencyHeader(req) : null, req.rawQuery);
        } catch (error) {
          if (!lookup || !(error instanceof GatewayError) || error.httpStatus !== 404) throw error;
        }
      }
      return acsHandoff(ctx, req, token, device);
    }
    if (ctx.workHandoffs === undefined) fail('UPSTREAM_UNAVAILABLE', 503);
    const input = method === 'POST' ? jsonBody(req) : null;
    const result = await ctx.workHandoffs.remote(
      token, method, tail, input, method === 'POST' ? idempotencyHeader(req) : null, req.rawQuery);
    return { status: result.status, body: result.body };
  }

  // Java: GET /personal/v1/agent/authorized-scope → stored-grant picker.
  if (path === '/personal/v1/agent/authorized-scope' && method === 'GET') {
    boundedQuery(req, []);
    const scope = await ctx.auth.authorizedScope(device);
    if ((await ctx.auth.authenticate(token)).revision !== device.revision) {
      fail('GRANT_REVISION_CHANGED', 409);
    }
    return { status: 200, body: scope };
  }

  // Java: GET /personal/v1/agent/model-options → model-catalog projection.
  if (path === '/personal/v1/agent/model-options' && method === 'GET') {
    return modelOptions(ctx, req, token, device);
  }

  if (!path.startsWith('/personal/v1/agent/')) fail('OPERATION_NOT_ALLOWED', 403);
  return agentProxy(ctx, req, token, device, path, method);
};

// ---------------------------------------------------------------------------
// GET /personal/v1/input-capabilities — Java's capabilities projection.
// ---------------------------------------------------------------------------

const inputCapabilities = async (
  ctx: GatewayContext, req: HttpRequest, token: string, device: Device,
): Promise<HttpResponse> => {
  const source = await acsCall(ctx, 'GET', '/api/v2/capabilities', undefined, undefined, await bindingFor(ctx, device));
  if (source.status !== 200) fail('SOURCE_NOT_READY', 503);
  const actions = new Set(device.actions ?? []);
  const image: JsonObject = { available: false, reason: 'SOURCE_IMAGE_INPUT_UNAVAILABLE' };
  for (const operation of asArr(asObj(acsJson(source)).operations).map(asObj)) {
    if (asText(operation.operation) === 'session.message.send.image'
      || asText(operation.id) === 'session.message.send.image') {
      const available = asText(operation.availability) === 'AVAILABLE' && actions.has('INTERACT');
      image.available = available;
      image.reason = available ? 'MODEL_SUPPORT_MUST_BE_CHECKED'
        : actions.has('INTERACT') ? asText(operation.reasonCode, 'SOURCE_IMAGE_INPUT_UNAVAILABLE')
          : 'INTERACT_REQUIRED';
      image.limits = operation.limits;
    }
  }
  const result: JsonObject = {
    grantRevision: String(device.revision),
    images: image,
    messageRequestMaxBytes: messageBudget(),
    transcription: {
      available: ctx.transcription !== undefined && actions.has('INTERACT'),
      reason: ctx.transcription === undefined
        ? (ctx.config.transcriptionReason ?? 'TRANSCRIPTION_NOT_CONFIGURED')
        : actions.has('INTERACT') ? 'FUNASR_OFFLINE' : 'INTERACT_REQUIRED',
      mediaType: 'audio/wav',
      sampleRate: 16000,
      channels: 1,
      bitsPerSample: 16,
      maxDurationMillis: 60000,
      maxAudioBytes: 1920044,
    },
  };
  if ((await ctx.auth.authenticate(token)).revision !== device.revision) fail('GRANT_REVISION_CHANGED', 409);
  return { status: 200, body: result };
};

// ---------------------------------------------------------------------------
// POST /personal/v1/transcriptions — PersonalAudioMultipart.read() port.
// Exactly metadata JSON + one bounded WAV. No filenames or multipart paths.
// ---------------------------------------------------------------------------

const MULTIPART_CAP = 2_162_688;
const BOUNDARY = /^multipart\/form-data;\s*boundary="?([A-Za-z0-9._-]{1,70})"?$/i;
const PART_NAME = /^form-data;\s*name="(metadata|audio)"(?:;\s*filename="[A-Za-z0-9._-]{1,80}")?$/;

const matchAt = (bytes: Uint8Array, position: number, expected: number[]): boolean => {
  if (position + expected.length > bytes.length) return false;
  for (let i = 0; i < expected.length; i++) if (bytes[position + i] !== expected[i]) return false;
  return true;
};

const findAt = (bytes: Uint8Array, start: number, target: number[]): number => {
  for (let i = start; i <= bytes.length - target.length; i++) if (matchAt(bytes, i, target)) return i;
  return -1;
};

const ascii = (s: string): number[] => [...s].map((c) => c.charCodeAt(0));

const readAudioMultipart = (req: HttpRequest): { metadata: JsonObject; audio: Uint8Array } => {
  const type = requestMeta(req).contentType ?? '';
  const boundary = BOUNDARY.exec(type);
  if (boundary === null) fail('AUDIO_MULTIPART_REQUIRED', 415);
  if (req.bodyError === 'BODY_TOO_LARGE') fail('BODY_TOO_LARGE', 413);
  const bytes = req.rawBody ?? new Uint8Array();
  if (bytes.length > MULTIPART_CAP) fail('BODY_TOO_LARGE', 413);
  const delimiter = ascii(`--${boundary[1]}`);
  const crlf = [13, 10];
  const close: number[] = [45, 45];

  let position = 0;
  let metadata: JsonObject | null = null;
  let audio: Uint8Array | null = null;
  for (;;) {
    if (!matchAt(bytes, position, delimiter)) fail('AUDIO_MULTIPART_INVALID', 400);
    position += delimiter.length;
    if (matchAt(bytes, position, close)) {
      position += 2;
      if (matchAt(bytes, position, crlf)) position += 2;
      if (position !== bytes.length) fail('AUDIO_MULTIPART_INVALID', 400);
      break;
    }
    if (!matchAt(bytes, position, crlf)) fail('AUDIO_MULTIPART_INVALID', 400);
    position += 2;
    const headerEnd = findAt(bytes, position, [13, 10, 13, 10]);
    if (headerEnd < 0 || headerEnd - position > 4096) fail('AUDIO_MULTIPART_INVALID', 400);
    const headers = new Map<string, string>();
    for (const header of Buffer.from(bytes.slice(position, headerEnd)).toString('ascii').split('\r\n')) {
      const colon = header.indexOf(':');
      if (colon < 1) fail('AUDIO_MULTIPART_INVALID', 400);
      const name = header.slice(0, colon).trim().toLowerCase();
      if (!['content-disposition', 'content-type'].includes(name) || headers.has(name)) {
        fail('AUDIO_MULTIPART_INVALID', 400);
      }
      headers.set(name, header.slice(colon + 1).trim());
    }
    const part = PART_NAME.exec(headers.get('content-disposition') ?? '');
    if (part === null) fail('AUDIO_MULTIPART_INVALID', 400);
    position = headerEnd + 4;
    const next = [...crlf, ...delimiter];
    const end = findAt(bytes, position, next);
    if (end < 0) fail('AUDIO_MULTIPART_INVALID', 400);
    const length = end - position;
    if (part[1] === 'metadata') {
      if (metadata !== null || length > 65_536) fail('AUDIO_MULTIPART_INVALID', 400);
      let parsed: unknown;
      try {
        parsed = JSON.parse(Buffer.from(bytes.slice(position, end)).toString('utf8'));
      } catch {
        // Java: mapper.readTree inside read() → IOException → remote()'s
        // generic Exception catch → UPSTREAM_UNAVAILABLE (Java quirk kept).
        fail('UPSTREAM_UNAVAILABLE', 503);
      }
      if (!isRecord(parsed)) fail('INVALID_REQUEST', 400);
      metadata = parsed;
    } else {
      if (audio !== null || length > 1_920_044
        || (headers.get('content-type') ?? '').toLowerCase() !== 'audio/wav') {
        fail('AUDIO_FORMAT_INVALID', 422);
      }
      audio = bytes.slice(position, end);
    }
    position = end + 2;
  }
  if (metadata === null || audio === null) fail('AUDIO_MULTIPART_INVALID', 400);
  return { metadata, audio };
};

// ---------------------------------------------------------------------------
// GET /personal/v1/sessions — foundation + summary + bounded activity merge.
// ---------------------------------------------------------------------------

const scopedFoundation = (ctx: GatewayContext, source: unknown, sid: string): JsonObject => {
  const row = asObj(source);
  if (row.sessionId !== sid) fail('DEVICE_SCOPE_DENIED', 403);
  if (row.schemaVersion !== 'session-foundation/1') return row;
  const sourceStoreId = asText(row.storeId);
  if (!sourceStoreId) fail('UPSTREAM_UNAVAILABLE', 503);
  // PAC clients bind this view to the paired gateway's persistent authority.
  // Retain the ACS identity for source-specific workflows and signed evidence.
  return { ...row, storeId: ctx.config.storeId, sourceStoreId };
};

const sessionList = async (ctx: GatewayContext, token: string, device: Device): Promise<HttpResponse> => {
  const rows: unknown[] = [];
  const sessions = device.sessions ?? [];
  for (const sid of sessions) {
    await ctx.auth.authorize(token, sid, 'OBSERVE');
    const binding = await bindingFor(ctx, device);
    const r = await acsCall(ctx, 'GET', `/api/v2/sessions/${sid}/foundation`, undefined, undefined, binding);
    if (r.status === 404) continue;
    if (r.status !== 200) fail('UPSTREAM_UNAVAILABLE', 503);
    const row = scopedFoundation(ctx, acsJson(r), sid);
    const summary = await acsCall(ctx, 'GET', `/api/v2/sessions/${sid}/summary`, undefined, undefined, binding);
    if (summary.status === 200) {
      const metadata = asObj(acsJson(summary));
      for (const field of ['title', 'sessionVersion', 'updatedAt']) {
        if (field in metadata) row[field] = metadata[field];
      }
    }
    const messages = await acsCall(ctx, 'GET', `/api/v2/sessions/${sid}/messages?limit=30`, undefined, undefined, binding);
    if (messages.status === 200) {
      const page = asObj(acsJson(messages));
      if (asText(page.sessionId) !== sid) fail('DEVICE_SCOPE_DENIED', 403);
      const publicMessages: JsonObject[] = [];
      for (const item of asArr(page.items).map(asObj)) {
        if (!['user', 'assistant'].includes(asText(item.role).toLowerCase())
          || asLong(item.contentBytes) <= 0) continue;
        const fact: JsonObject = {};
        for (const field of ['id', 'role', 'createdAt', 'updatedAt', 'contentRevision']) {
          if (field in item) fact[field] = item[field];
        }
        const preview = asText(item.content, asText(item.contentPreview));
        fact.preview = preview.substring(0, Math.min(preview.length, 120));
        publicMessages.push(fact);
      }
      row.conversationActivity = publicMessages;
      row.activityWindowLimited = page.hasOlder === true;
    }
    await ctx.auth.authorize(token, sid, 'OBSERVE');
    rows.push(row);
  }
  for (const sid of sessions) await ctx.auth.authorize(token, sid, 'OBSERVE');
  return { status: 200, body: rows };
};

// ---------------------------------------------------------------------------
// GET .../assignment-options — profiles + model-catalog projection (≤100 each).
// ---------------------------------------------------------------------------

const assignmentOptions = async (
  ctx: GatewayContext, token: string, device: Device, sid: string,
): Promise<HttpResponse> => {
  id(sid);
  await ctx.auth.authorize(token, sid, 'OBSERVE');
  const binding = await bindingFor(ctx, device);
  const profiles = await acsCall(ctx, 'GET', '/api/v2/agent-profiles', undefined, undefined, binding);
  const models = await acsCall(ctx, 'GET', '/api/v2/model-catalog', undefined, undefined, binding);
  if (profiles.status !== 200 || models.status !== 200) fail('SOURCE_NOT_READY', 503);
  const visibleProfiles: JsonObject[] = [];
  for (const profile of asArr(asObj(acsJson(profiles)).profiles).map(asObj)) {
    if (visibleProfiles.length >= 100) break;
    const visible: JsonObject = {};
    for (const field of ['id', 'name', 'description', 'revision']) {
      if (typeof profile[field] === 'string') visible[field] = profile[field];
    }
    visibleProfiles.push(visible);
  }
  const visibleModels: JsonObject[] = [];
  for (const model of asArr(asObj(acsJson(models)).items).map(asObj)) {
    if (visibleModels.length >= 100) break;
    if (model.configured !== true || asText(model.availability) !== 'AVAILABLE') continue;
    const visible: JsonObject = {};
    for (const field of ['modelAlias', 'providerDisplayName']) {
      if (typeof model[field] === 'string') visible[field] = model[field];
    }
    visibleModels.push(visible);
  }
  await ctx.auth.authorize(token, sid, 'OBSERVE');
  return {
    status: 200,
    body: {
      schemaVersion: 'personal-assignment-options/1',
      sessionId: sid,
      profiles: visibleProfiles,
      models: visibleModels,
    },
  };
};

// ---------------------------------------------------------------------------
// GET /personal/v1/agent/model-options — Java model-catalog projection.
// ---------------------------------------------------------------------------

const modelOptions = async (
  ctx: GatewayContext, req: HttpRequest, token: string, device: Device,
): Promise<HttpResponse> => {
  let scopeSession: string | undefined;
  if (req.rawQuery !== null) {
    if (req.rawQuery.length > 4096) fail('INVALID_REQUEST', 400);
    for (const item of req.rawQuery.split('&')) {
      const [name, raw] = firstPair(item);
      if (name !== 'sessionId') fail('INVALID_REQUEST', 400);
      scopeSession = decodeForm(raw ?? '');
    }
  }
  if (scopeSession !== undefined) {
    id(scopeSession);
    await ctx.auth.authorize(token, scopeSession, 'OBSERVE');
  } else if (!(device.actions ?? []).includes('CREATE')) {
    fail('DEVICE_SCOPE_DENIED', 403);
  }
  const catalog = await acsCall(ctx, 'GET', '/api/v2/model-catalog', undefined, undefined,
    await bindingFor(ctx, device));
  if (catalog.status !== 200) fail('SOURCE_NOT_READY', 503);
  const source = asObj(acsJson(catalog));
  const items: JsonObject[] = [];
  for (const model of asArr(source.items).map(asObj)) {
    if (model.configured !== true || asText(model.availability) !== 'AVAILABLE') continue;
    if (typeof model.providerId !== 'string' || typeof model.modelAlias !== 'string') continue;
    items.push({
      providerId: model.providerId,
      modelAlias: model.modelAlias,
      displayName: typeof model.providerDisplayName === 'string'
        ? `${model.providerDisplayName}/${model.modelAlias}`
        : model.modelAlias,
      availability: model.availability,
    });
  }
  if ((await ctx.auth.authenticate(token)).revision !== device.revision) fail('GRANT_REVISION_CHANGED', 409);
  // defaultSelection resolves against projected rows only; an ambiguous
  // or missing default stays null rather than guessing.
  const defaultModel = typeof source.defaultModel === 'string' ? source.defaultModel : null;
  let defaultRow: JsonObject | null = null;
  if (defaultModel !== null) {
    for (const row of items) {
      if (row.modelAlias === defaultModel) {
        if (defaultRow !== null) { defaultRow = null; break; }
        defaultRow = row;
      }
    }
  }
  return {
    status: 200,
    body: {
      schemaVersion: 'acs-model-options/1',
      catalogRevision: typeof source.catalogRevision === 'string' ? source.catalogRevision : null,
      items,
      defaultSelection: defaultRow === null ? null
        : { providerId: defaultRow.providerId, modelAlias: defaultRow.modelAlias },
    },
  };
};

// ---------------------------------------------------------------------------
// GET|PUT .../execution-policy(-defaults) — Java executionPolicy().
// ---------------------------------------------------------------------------

const executionPolicy = async (
  ctx: GatewayContext, req: HttpRequest, token: string, device: Device,
  path: string, method: string,
): Promise<HttpResponse> => {
  if (!['GET', 'PUT'].includes(method) || req.rawQuery !== null) fail('OPERATION_NOT_ALLOWED', 403);
  const parts = javaSplit(path);
  const sid = parts[5];
  id(sid);
  const action = method === 'PUT' ? 'POLICY' : 'OBSERVE';
  await ctx.auth.authorize(token, sid, action);
  let routePath = `/api/v2/sessions/${sid}/execution-policy`;
  let resolvedProject: string | null = null;
  if (parts[6] === 'execution-policy-defaults') {
    const current = await acsCall(ctx, 'GET', routePath, undefined, undefined, await bindingFor(ctx, device));
    if (current.status !== 200) {
      return { status: current.status, body: acsJson(current) };
    }
    const project = asText(asObj(acsJson(current)).projectId);
    if (project === '' || project.startsWith('SESSION:')) fail('PROJECT_POLICY_UNAVAILABLE', 409);
    id(project);
    routePath = `/api/v2/projects/${project}/execution-policy-defaults`;
    resolvedProject = project;
  }
  let payload: Uint8Array | undefined;
  let key: string | undefined;
  if (method === 'PUT') {
    const update = exact(jsonBody(req),
      'expectedRevision', 'requestedMode', 'permissionSemanticsVersion', 'pendingApprovalAction', 'projectId');
    if (resolvedProject !== null && resolvedProject !== update.projectId) fail('POLICY_TARGET_CHANGED', 409);
    if (resolvedProject === null && 'projectId' in update && update.projectId !== undefined) fail('INVALID_REQUEST', 400);
    const expected = update.expectedRevision;
    if (typeof expected !== 'number' || !Number.isInteger(expected) || expected < 1
      || !['STANDARD', 'AUTO_APPROVE', 'FULL_ACCESS'].includes(update.requestedMode as string)
      || update.permissionSemanticsVersion !== 2) fail('INVALID_REQUEST', 400);
    const pendingAction = update.pendingApprovalAction;
    if (pendingAction !== 'RETAIN' && !(resolvedProject === null && pendingAction === 'RECONCILE_SESSION'
      && update.requestedMode !== 'STANDARD')) fail('INVALID_REQUEST', 400);
    key = idempotencyHeader(req);
    id(key);
    const forwarded = { ...update };
    delete forwarded.projectId;
    payload = new Uint8Array(Buffer.from(JSON.stringify(forwarded), 'utf8'));
  }
  await ctx.auth.authorize(token, sid, action);
  const result = await acsCall(ctx, method, routePath, payload, key, await bindingFor(ctx, device));
  await ctx.auth.authorize(token, sid, action);
  return { status: result.status, body: acsJson(result) };
};

// ---------------------------------------------------------------------------
// /personal/v1/agent/** — Java's whitelist proxy, verbatim route shapes.
// ---------------------------------------------------------------------------

const agentProxy = async (
  ctx: GatewayContext, req: HttpRequest, token: string, device: Device,
  path: string, method: string,
): Promise<HttpResponse> => {
  const upstreamRoute = '/api/v2/' + path.substring('/personal/v1/agent/'.length);
  const p = javaSplit(upstreamRoute);
  if (p.length < 5) fail('OPERATION_NOT_ALLOWED', 403);

  let sid = '';
  let attachment = false;
  let approvalList = false;
  let assignmentRoute = false;
  let foundationRoute = false;
  let collaborationRoute = false;
  let collaborationFiles = false;
  let action = 'OBSERVE';
  let prepared: Uint8Array | undefined;
  let bodySpec: string | undefined;
  let queryFields: Set<string> | undefined;
  let auxiliaryList = false;

  if (p[3] === 'sessions') {
    sid = p[4];
    id(sid);
    // Upstream-verified surfaces (V2ApiHandler + ExecutionPermissionApiHandler):
    // detail GET/PATCH, archive POST, model-settings GET/PATCH,
    // automation-controls GET/POST. Write bodies get a strict
    // field whitelist below; permission/directory/model authority
    // keeps its own routes and is not reachable through the patch.
    const detail = p.length === 5 && method === 'GET';
    const sessionPatch = p.length === 5 && method === 'PATCH';
    const modelSettings = p.length === 6 && p[5] === 'model-settings' && ['GET', 'PATCH'].includes(method);
    const automationControls = p.length === 6 && p[5] === 'automation-controls' && ['GET', 'POST'].includes(method);
    const archive = p.length === 6 && p[5] === 'archive' && method === 'POST';
    foundationRoute = p.length === 6 && p[5] === 'foundation' && method === 'GET';
    attachment = p.length === 10 && p[5] === 'messages' && p[7] === 'attachments'
      && ['bytes', 'content'].includes(p[9]) && method === 'GET';
    const message = p.length === 6 && p[5] === 'messages' && method === 'POST';
    if (message) { action = 'INTERACT'; }
    if (sessionPatch) { action = 'INTERACT'; bodySpec = 'session-patch'; }
    if (modelSettings && method === 'PATCH') { action = 'INTERACT'; bodySpec = 'model-settings'; }
    if (automationControls && method === 'POST') { action = 'CONTROL'; bodySpec = 'automation-controls'; }
    if (archive) { action = 'CONTROL'; bodySpec = 'session-archive'; }
    if (detail || modelSettings || automationControls) queryFields = new Set<string>();
    approvalList = p.length === 6 && p[5] === 'approvals' && method === 'GET';
    const history = method === 'GET' && ((p.length === 6 && ['messages', 'summary'].includes(p[5]))
      || (p.length === 8 && p[5] === 'messages' && p[7] === 'content'));
    const packages = p[5] === 'context-packages' && ((method === 'POST' && p.length === 6)
      || (method === 'GET' && (p.length === 7 || (p.length === 8 && p[7] === 'items'))));
    const auxiliaries = p.length === 6 && p[5] === 'auxiliary-sessions' && (method === 'GET' || method === 'POST');
    const turns = p.length === 6 && p[5] === 'auxiliary-turns' && ((method === 'GET' && (p.length === 6 || p.length === 7))
      || (method === 'POST' && (p.length === 6 || (p.length === 8 && p[7] === 'cancel'))));
    if ((packages || auxiliaries || turns) && method === 'POST') { action = 'INTERACT'; }
    if ((detail || foundationRoute || history || turns) && !(device.sessions ?? []).includes(sid)) {
      sid = await auxiliaryRoot(ctx, sid, device, method === 'GET' && (detail || foundationRoute || history));
    }
    const snapshots = p.length >= 6 && p[5] === 'observation-snapshots'
      && ((p.length === 6 && method === 'POST')
        || ((p.length === 7 || (p.length === 8 && p[7] === 'items')) && method === 'GET'));
    auxiliaryList = p.length === 6 && ['auxiliary-sessions', 'auxiliary-turns'].includes(p[5]) && method === 'GET';
    if (!detail && !sessionPatch && !modelSettings && !automationControls && !archive
      && !foundationRoute && !snapshots && !history && !message && !attachment && !approvalList
      && !packages && !auxiliaries && !turns) fail('OPERATION_NOT_ALLOWED', 403);
    for (let i = 6; i < p.length; i++) id(p[i]);
  } else if (p[3] === 'runs') {
    const rid = p[4];
    id(rid);
    // Exact child-messages projection precedes the generic collaboration forward.
    if (p.length === 10 && p[5] === 'collaboration-groups' && p[7] === 'executions'
        && p[9] === 'messages' && method === 'GET') {
      for (let i = 6; i < p.length; i++) id(p[i]);
      if (ctx.childMessages === undefined) fail('UPSTREAM_UNAVAILABLE', 503);
      const projected = await ctx.childMessages.messages(token, rid, p[6]!, p[8]!, req.rawQuery);
      return { status: projected.status, body: projected.body };
    }
    const command = p.length >= 6 && p.length <= 7 && p[5] === 'commands';
    const boundary = p.length >= 6 && p.length <= 8 && p[5] === 'boundary-requests';
    assignmentRoute = p.length >= 6 && p.length <= 8 && p[5] === 'assignment-transitions';
    const segments = p.length === 6 && p[5] === 'execution-segments';
    // RunApiHandler: POST /runs/{rid}/continue resumes a waiting run;
    // the six GET evidence surfaces each take only the query names
    // upstream actually reads (activities:afterCursor/limit,
    // diff:page/pageSize, the rest none).
    const continueRun = p.length === 6 && p[5] === 'continue' && method === 'POST';
    const evidenceRead = p.length === 6 && method === 'GET'
      && ['activities', 'reasoning', 'output', 'diff', 'review', 'workspace-conflicts'].includes(p[5]!);
    if (continueRun) bodySpec = 'run-continue';
    if (evidenceRead) {
      queryFields = p[5] === 'activities' ? new Set(['afterCursor', 'limit'])
        : p[5] === 'diff' ? new Set(['page', 'pageSize']) : new Set<string>();
    }
    collaborationRoute = p.length >= 6 && p.length <= 10
      && ['collaboration-groups', 'collaboration-activity'].includes(p[5]);
    const collaborationAction = collaborationRoute ? collabAction(method, p) : null;
    collaborationFiles = collaborationRoute && p.length === 10 && p[9] === 'files';
    let read = method === 'GET' && (p.length === 5 || command || segments
      || ((boundary || assignmentRoute) && p.length <= 7) || evidenceRead);
    let write = method === 'POST' && ((command && p.length === 6)
      || (boundary && (p.length === 6 || (p.length === 8 && p[7] === 'cancel')))
      || (assignmentRoute && (p.length === 6 || (p.length === 7 && p[6] === 'preflight')
        || (p.length === 8 && p[7] === 'cancel')))
      || continueRun);
    if (write) action = assignmentRoute ? 'ASSIGN' : boundary ? 'INTERACT' : 'CONTROL';
    if (collaborationRoute) {
      read = method === 'GET';
      write = method === 'POST';
      action = collaborationAction!;
    }
    if (!read && !write) fail('OPERATION_NOT_ALLOWED', 403);
    for (let i = 6; i < p.length; i++) id(p[i]);
    const lookup = await acsCall(ctx, 'GET', `/api/v2/runs/${rid}`, undefined, undefined, await bindingFor(ctx, device));
    if (lookup.status !== 200) fail('NOT_FOUND', 404);
    sid = asText(asObj(acsJson(lookup)).sessionId);
    await ctx.auth.authorize(token, sid, action);
    if (collaborationRoute && p.length >= 7) {
      const group = await acsCall(ctx, 'GET', `/api/v2/runs/${rid}/collaboration-groups/${p[6]}`,
        undefined, undefined, await bindingFor(ctx, device));
      if (group.status !== 200) fail('NOT_FOUND', 404);
      const value = asObj(acsJson(group));
      if (asText(value.entityId) !== p[6]) fail('DEVICE_SCOPE_DENIED', 403);
      if (p.length >= 9) {
        const collection = p[7] === 'executions' ? 'children' : p[7];
        let member = false;
        for (const item of asArr(value[collection]).map(asObj)) {
          if (asText(item.entityId) === p[8] && asText(item.groupId) === p[6]) member = true;
        }
        if (!member) fail('DEVICE_SCOPE_DENIED', 403);
      }
    }
  } else if (p[3] === 'approvals') {
    id(p[4]);
    const read = p.length === 5 && method === 'GET';
    let write = p.length === 6 && p[5] === 'decisions' && method === 'POST';
    if (write) bodySpec = 'approval-decision';
    // ExecutionPermissionApiHandler: advance/controls share the
    // ApprovalAdvanceRequest guard body and the APPROVE grant.
    if (p.length === 6 && ['advance', 'controls'].includes(p[5]!) && method === 'POST') {
      write = true;
      bodySpec = 'approval-advance';
    }
    if (!read && !write) fail('OPERATION_NOT_ALLOWED', 403);
    if (write) {
      action = 'APPROVE';
      if (!(device.actions ?? []).includes(action)) fail('DEVICE_SCOPE_DENIED', 403);
    }
    const lookup = await acsCall(ctx, 'GET', `/api/v2/approvals/${p[4]}`, undefined, undefined, await bindingFor(ctx, device));
    if (lookup.status !== 200) fail('NOT_FOUND', 404);
    sid = await approvalSession(ctx, asObj(acsJson(lookup)), device);
  } else if (p[3] === 'projects' && p.length >= 6 && p[5] === 'material-uploads') {
    // ACS project material profile -> /api/v2/projects/{project}/material-uploads.
    // Upstream absence is expected; the ledger still keeps route+auth+idempotency honest.
    if (req.rawQuery !== null) fail('INVALID_REQUEST', 400);
    id(p[4]);
    for (let i = 6; i < p.length; i++) id(p[i]);
    const tail = p.slice(6);
    let materialBody: unknown = null;
    if (method === 'POST' || method === 'PUT') {
      materialBody = tail.length === 3 && tail[1] === 'chunks' ? jsonBody(req, 400_000) : jsonBody(req);
    }
    if (ctx.agentSessions === undefined) fail('UPSTREAM_UNAVAILABLE', 503);
    const result = await ctx.agentSessions.materialUpload(
      token, p[4]!, tail, method, materialBody, method === 'GET' ? null : idempotencyHeader(req));
    return { status: result.status, body: result.body };
  } else if (p[3] === 'operations' && p.length === 5) {
    if (method === 'POST' && p[4] === 'lookup') {
      if (req.bodyError === 'BODY_TOO_LARGE') fail('BODY_TOO_LARGE', 413);
      const bytes = req.rawBody ?? new Uint8Array();
      if (bytes.length > 65_536) fail('BODY_TOO_LARGE', 413);
      let lookup: unknown;
      try {
        lookup = JSON.parse(Buffer.from(bytes).toString('utf8'));
      } catch {
        // Java: mapper.readTree inside remote()'s try → generic Exception →
        // UPSTREAM_UNAVAILABLE 503 (Java quirk kept verbatim).
        fail('UPSTREAM_UNAVAILABLE', 503);
      }
      const b = exact(lookup, 'operation', 'resourceId', 'idempotencyKey');
      if (text(b, 'operation') !== 'session.message') fail('OPERATION_NOT_ALLOWED', 403);
      sid = text(b, 'resourceId');
      id(sid);
      prepared = bytes;
    } else if (method === 'GET') {
      id(p[4]);
      const lookup = await acsCall(ctx, 'GET', upstreamRoute, undefined, undefined, await bindingFor(ctx, device));
      if (lookup.status !== 200) fail('NOT_FOUND', 404);
      const receipt = asObj(acsJson(lookup));
      if (asText(receipt.operation) !== 'session.message') fail('OPERATION_NOT_ALLOWED', 403);
      sid = asText(receipt.resourceId);
      id(sid);
    } else {
      fail('OPERATION_NOT_ALLOWED', 403);
    }
  } else {
    fail('OPERATION_NOT_ALLOWED', 403);
  }

  await ctx.auth.authorize(token, sid, action);
  let payload: Uint8Array | undefined;
  let key: string | undefined;
  if (method === 'POST' || method === 'PATCH') {
    if (req.bodyError === 'BODY_TOO_LARGE') fail('BODY_TOO_LARGE', 413);
    const budget = messageBudgetRoute(p, action) ? messageBudget() : 65_536;
    const bytes = req.rawBody ?? new Uint8Array();
    if (bytes.length > budget) fail('BODY_TOO_LARGE', 413);
    payload = prepared ?? bytes;
    key = idempotencyHeader(req);
    id(key);
  }
  // Strict per-route whitelist: only fields the real upstream request DTO
  // declares are forwarded; unknown fields fail before any upstream call.
  if (bodySpec !== undefined) {
    let mutationBody: unknown = null;
    if (payload !== undefined && payload.length > 0) {
      try {
        mutationBody = JSON.parse(Buffer.from(payload).toString('utf8'));
      } catch {
        fail('INVALID_REQUEST', 400);
      }
    }
    validateMutationBody(mutationBody, bodySpec);
  }
  const query = req.rawQuery;
  if (query !== null) {
    if (method !== 'GET' || query.length > 4096) fail('INVALID_REQUEST', 400);
    if (collaborationFiles) {
      validateCollaborationQuery(query);
    } else {
      for (const item of query.split('&')) {
        const [name] = firstPair(item);
        if (queryFields !== undefined ? !queryFields.has(name) : !['limit', 'cursor', 'before'].includes(name)) {
          fail('INVALID_REQUEST', 400);
        }
        if (auxiliaryList && name !== 'limit') fail('INVALID_REQUEST', 400);
      }
    }
  }
  // Recheck after source resolution and immediately before dispatch. No retry of a write.
  const binding = await bindingFor(ctx, device);
  // Admission is short: revoke does not wait on a slow source HTTP request.
  // An already admitted operation may execute; recheck below withholds its result.
  await ctx.auth.authorize(token, sid, action);
  const reply = await acsCall(ctx, method, upstreamRoute + (query === null ? '' : `?${query}`),
    payload, key, binding, attachment ? messageBudget() : undefined);

  let replyBody: Uint8Array = reply.body;
  if (foundationRoute && reply.status === 200) {
    const visible = scopedFoundation(ctx, acsJson(reply), p[4]);
    replyBody = new TextEncoder().encode(JSON.stringify(visible));
  }
  // Upstream aux lists have no cursor; a forwarded limit is honored by
  // honest truncation + marker, never a fabricated page token.
  if (auxiliaryList && query !== null && reply.status >= 200 && reply.status < 300) {
    // Java query(): repeated names collapse to the last value.
    let limitParam: string | undefined;
    for (const item of query.split('&')) {
      const [name, raw] = firstPair(item);
      if (name === 'limit') limitParam = decodeForm(raw ?? '');
    }
    if (limitParam !== undefined) {
      const visible = acsJson({ ...reply, body: replyBody });
      if (isRecord(visible) && truncateItems(visible, 'items', parseLimit(limitParam))) {
        replyBody = new Uint8Array(Buffer.from(JSON.stringify(visible), 'utf8'));
      }
    }
  }
  if (collaborationRoute && reply.status >= 200 && reply.status < 300) {
    const visible = acsJson({ ...reply, body: replyBody });
    bindCollaborationRun(visible, p[4]);
    if (isRecord(visible)) visible.runId = p[4];
    replyBody = new Uint8Array(Buffer.from(JSON.stringify(visible), 'utf8'));
  }
  // Preflight/transition snapshots may contain private profile instructions;
  // mobile gets only decision metadata.
  if (assignmentRoute && reply.status >= 200 && reply.status < 300) {
    const visible = acsJson({ ...reply, body: replyBody });
    sanitizeAssignment(visible);
    if (Array.isArray(asObj(visible).items)) {
      for (const item of asArr(asObj(visible).items)) sanitizeAssignment(item);
    }
    replyBody = new Uint8Array(Buffer.from(JSON.stringify(visible), 'utf8'));
  }
  // No source content is released to a revoked or expired device.
  if (approvalList && reply.status >= 200 && reply.status < 300) {
    for (const approval of asArr(asObj(acsJson({ ...reply, body: replyBody })).items).map(asObj)) {
      if ((await approvalSession(ctx, approval, device)) !== sid) fail('APPROVAL_BINDING_MISMATCH', 403);
    }
  }
  await ctx.auth.authorize(token, sid, action);
  if (attachment && reply.status >= 200 && reply.status < 300
    && !['image/png', 'image/jpeg', 'text/plain'].includes(
      reply.contentType.split(';', 2)[0].trim().toLowerCase())) {
    fail('UNSUPPORTED_MEDIA_TYPE', 415);
  }
  return {
    status: reply.status,
    body: null,
    bodyBytes: replyBody,
    contentType: attachment ? reply.contentType : 'application/json; charset=utf-8',
  };
};

/** Java auxiliaryRoot(): resolve an auxiliary session to its in-scope parent. */
const auxiliaryRoot = async (
  ctx: GatewayContext, child: string, device: Device, allowDelegatedRead: boolean,
): Promise<string> => {
  const lookup = await acsCall(ctx, 'GET', `/api/v2/sessions/${child}`, undefined, undefined, await bindingFor(ctx, device));
  if (lookup.status === 404) fail('DEVICE_SCOPE_DENIED', 403);
  if (lookup.status !== 200) fail('UPSTREAM_UNAVAILABLE', 503);
  const value = asObj(acsJson(lookup));
  const purpose = asText(value.sessionPurpose);
  if (asText(value.sessionId) !== child
    || !(purpose === 'AUXILIARY_READ_ONLY'
      || (allowDelegatedRead && purpose === 'DELEGATED_WRITE_CANDIDATE'))) {
    fail('DEVICE_SCOPE_DENIED', 403);
  }
  const parent = asText(value.parentSessionId);
  id(parent);
  if (!(device.sessions ?? []).includes(parent)) fail('DEVICE_SCOPE_DENIED', 403);
  return parent;
};

/** Java approvalSession(): bind an approval to its owning session. */
const approvalSession = async (
  ctx: GatewayContext, approval: JsonObject, device: Device,
): Promise<string> => {
  let sid = asText(approval.sessionId);
  const rid = asText(approval.runId);
  if (sid === '' && asText(approval.kind) !== 'BUDGET') fail('APPROVAL_BINDING_MISMATCH', 403);
  if (rid !== '') {
    id(rid);
    const run = await acsCall(ctx, 'GET', `/api/v2/runs/${rid}`, undefined, undefined, await bindingFor(ctx, device));
    if (run.status !== 200) fail('NOT_FOUND', 404);
    const owner = asText(asObj(acsJson(run)).sessionId);
    id(owner);
    if (sid !== '' && sid !== owner) fail('APPROVAL_BINDING_MISMATCH', 403);
    sid = owner;
  }
  id(sid);
  return sid;
};

/** Java messageBudgetRoute(). */
const messageBudgetRoute = (p: string[], action: string): boolean =>
  action === 'INTERACT' && p.length === 6 && p[3] === 'sessions' && p[5] === 'messages';

/** Java collaborationAction() — pure route-shape validator.
 *  Extended past the Java PAC whitelist for routes the ACS source
 *  actually implements (business-codeagent-v2.yaml): execution rework,
 *  preview revisions/reviews, review reads, adoption repairs, repair
 *  recovery. The collaboration-evidence family stays closed — upstream
 *  marks it Registered-WORKER-only for the evidence upload pipeline. */
const collabAction = (method: string, p: string[]): string => {
  if (p[5] === 'collaboration-activity') {
    if (method === 'GET' && p.length === 6) return 'OBSERVE';
    fail('OPERATION_NOT_ALLOWED', 403);
  }
  if (method === 'GET' && (p.length === 6 || p.length === 7
    || (p.length === 8 && ['executions', 'adoptions'].includes(p[7]))
    || (p.length === 9 && ['executions', 'candidates', 'adoptions', 'reviews'].includes(p[7]))
    || (p.length === 10 && ['candidates', 'previews'].includes(p[7]) && p[9] === 'files'))) {
    return 'OBSERVE';
  }
  if (method === 'POST') {
    if (p.length === 6
      || (p.length === 8 && ['authorizations', 'start', 'cancel'].includes(p[7]))
      || (p.length === 10 && p[7] === 'executions' && ['cancel', 'rework'].includes(p[9]))) {
      return 'COLLABORATE';
    }
    if ((p.length === 8 && ['selections', 'adoptions'].includes(p[7]))
      || (p.length === 10 && p[7] === 'selections' && p[9] === 'previews')
      || (p.length === 10 && p[7] === 'previews' && ['revisions', 'reviews'].includes(p[9]))
      || (p.length === 10 && p[7] === 'adoptions' && ['cancel', 'recover', 'repairs'].includes(p[9]))
      || (p.length === 10 && p[7] === 'repairs' && p[9] === 'recover')) return 'ADOPT';
  }
  fail('OPERATION_NOT_ALLOWED', 403);
};

/** Java bindCollaborationRun(): inject runId into writable-collaboration records. */
const bindCollaborationRun = (node: unknown, rid: string): void => {
  if (isRecord(node) && node.schemaVersion === 'writable-collaboration-record/1') node.runId = rid;
  if (isRecord(node)) {
    for (const child of Object.values(node)) bindCollaborationRun(child, rid);
  } else if (Array.isArray(node)) {
    for (const child of node) bindCollaborationRun(child, rid);
  }
};

/** Java sanitizeAssignment(): strip private profile instructions. */
const sanitizeAssignment = (value: unknown): void => {
  if (isRecord(value) && isRecord(value.target)) {
    delete value.target.instructions;
    delete value.target.modelSnapshot;
  }
};

/** Java validateCollaborationQuery() — strict path/side/unitId/offset/limit rules. */
const validateCollaborationQuery = (query: string): void => {
  const seen = new Set<string>();
  for (const item of query.split('&')) {
    const [name, raw] = firstPair(item);
    const value = decodeForm(raw ?? '');
    if (seen.has(name)) fail('INVALID_REQUEST', 400);
    seen.add(name);
    if (name === 'path') {
      if (value.length > 1024 || /[\\:\x00-\x1f\x7f]/.test(value) || value === '') fail('INVALID_REQUEST', 400);
      for (const part of value.split('/')) {
        if (part === '' || part === '.' || part === '..' || part.endsWith('.') || part.endsWith(' ')) {
          fail('INVALID_REQUEST', 400);
        }
      }
    } else if (name === 'side') {
      if (!['BASE', 'CURRENT', 'PROPOSED', 'INTEGRATION'].includes(value)) fail('INVALID_REQUEST', 400);
    } else if (name === 'unitId') {
      id(value);
    } else if (name === 'offset' || name === 'limit') {
      if (!/^(0|[1-9][0-9]{0,18})$/.test(value)) fail('INVALID_REQUEST', 400);
      const n = Number(value);
      if (!Number.isSafeInteger(n)) fail('INVALID_REQUEST', 400);
      if (name === 'limit' && (n < 1 || n > 65536)) fail('INVALID_REQUEST', 400);
    } else {
      fail('INVALID_REQUEST', 400);
    }
  }
};

/** Java strings() — require an array of strings. */
const stringArray = (value: unknown): void => {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    fail('INVALID_REQUEST', 400);
  }
};

/** Java approvalGuard() — shared expectedVersion + fingerprint rule. */
const approvalGuard = (b: JsonObject, fingerprintRequired: boolean): void => {
  if (!Number.isInteger(b.expectedVersion) || (b.expectedVersion as number) < 1) {
    fail('INVALID_REQUEST', 400);
  }
  const fingerprint = b.fingerprint != null ? text(b, 'fingerprint')
    : b.requestFingerprint != null ? text(b, 'requestFingerprint') : '';
  if (fingerprintRequired && fingerprint === '') fail('INVALID_REQUEST', 400);
  if (fingerprint.length > 256) fail('INVALID_REQUEST', 400);
};

/** Java validateMutationBody() — per-route write DTO whitelists.
 *  Unknown fields fail before any upstream call; a null body is only
 *  legal for run-continue (the request is body-optional upstream). */
const validateMutationBody = (body: unknown, spec: string): void => {
  if (spec === 'run-continue') {
    if (body == null) return;
    const b = exact(body, 'expectedStateVersion', 'message');
    if (b.expectedStateVersion != null && !Number.isInteger(b.expectedStateVersion)) {
      fail('INVALID_REQUEST', 400);
    }
    if (b.message != null
        && (typeof b.message !== 'string' || Buffer.from(b.message, 'utf8').length > 16_384)) {
      fail('INVALID_REQUEST', 400);
    }
    return;
  }
  if (body == null) fail('INVALID_REQUEST', 400);
  if (spec === 'session-patch') {
    // permissionMode is deliberately excluded: authority changes keep
    // their own routes and are never reachable through the patch.
    const b = exact(body, 'expectedSessionVersion', 'title', 'workspaceAlias',
      'interactionMode', 'intent', 'executionMode', 'autonomyLevel', 'policyFingerprint',
      'writeAllow', 'writeForbid', 'contextDirectories', 'directories',
      'directoryPolicyVersion', 'replaceLegacyDirectoryPolicy', 'verificationLevel',
      'extensions', 'maxModelTurns', 'maxEditAttempts', 'modelAlias', 'modelSettings');
    if (!Number.isInteger(b.expectedSessionVersion)) fail('INVALID_REQUEST', 400);
    for (const field of ['title', 'workspaceAlias', 'interactionMode', 'intent',
      'executionMode', 'autonomyLevel', 'policyFingerprint', 'verificationLevel', 'modelAlias']) {
      if (b[field] != null) text(b, field);
    }
    for (const field of ['directoryPolicyVersion', 'maxModelTurns', 'maxEditAttempts']) {
      if (b[field] != null && !Number.isInteger(b[field])) fail('INVALID_REQUEST', 400);
    }
    if (b.replaceLegacyDirectoryPolicy != null && typeof b.replaceLegacyDirectoryPolicy !== 'boolean') {
      fail('INVALID_REQUEST', 400);
    }
    for (const field of ['writeAllow', 'writeForbid', 'contextDirectories']) {
      if (b[field] != null) stringArray(b[field]);
    }
    if (b.directories != null && !Array.isArray(b.directories)) fail('INVALID_REQUEST', 400);
    if (b.extensions != null && !isRecord(b.extensions)) fail('INVALID_REQUEST', 400);
    if (b.modelSettings != null) validateModelSettings(b.modelSettings);
    return;
  }
  if (spec === 'model-settings') {
    const b = exact(body, 'expectedSettingsRevision', 'applyPolicy', 'settings');
    if (!Number.isInteger(b.expectedSettingsRevision)) fail('INVALID_REQUEST', 400);
    if (!isRecord(b.settings)) fail('INVALID_REQUEST', 400);
    validateModelSettings(b.settings);
    if (b.applyPolicy != null && text(b, 'applyPolicy') !== 'NEXT_SAFE_REQUEST') {
      fail('INVALID_REQUEST', 400);
    }
    return;
  }
  if (spec === 'automation-controls') {
    const b = exact(body, 'expectedVersion', 'control');
    if (!Number.isInteger(b.expectedVersion) || (b.expectedVersion as number) < 1) {
      fail('INVALID_REQUEST', 400);
    }
    if (!['PAUSE_AUTOMATION', 'RESUME_AUTOMATION'].includes(asText(b.control))) {
      fail('INVALID_REQUEST', 400);
    }
    return;
  }
  if (spec === 'session-archive') {
    const b = exact(body, 'expectedSessionVersion', 'reason');
    if (!Number.isInteger(b.expectedSessionVersion)) fail('INVALID_REQUEST', 400);
    if (b.reason != null) text(b, 'reason');
    return;
  }
  if (spec === 'approval-decision') {
    const b = exact(body, 'expectedVersion', 'fingerprint', 'requestFingerprint', 'decision');
    approvalGuard(b, true);
    text(b, 'decision');
    return;
  }
  if (spec === 'approval-advance') {
    // CANCEL is the one control that may omit a fingerprint; every other
    // transition must pin the observed request revision.
    const b = exact(body, 'expectedVersion', 'fingerprint', 'requestFingerprint', 'control');
    const cancel = asText(b.control).trim().toUpperCase() === 'CANCEL';
    approvalGuard(b, !cancel);
    if (b.control != null && typeof b.control !== 'string') fail('INVALID_REQUEST', 400);
    return;
  }
  fail('INVALID_REQUEST', 400);
};
