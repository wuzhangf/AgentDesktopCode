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
 *   GET  /personal/v1/input-capabilities                  /api/v2/capabilities projection
 *   POST /personal/v1/transcriptions                      multipart → transcription.submit → 202
 *   GET|POST /personal/v1/transcriptions/{id}[/cancel]    get/cancel
 *   DELETE /personal/v1/device                            revoke + release → 204
 *   GET  /personal/v1/sessions                            foundation+summary+messages merge
 *   GET  /personal/v1/agent/sessions/{sid}/assignment-options
 *   /personal/v1/agent/**                                 whitelist proxy → acs.call
 *   anything else                                         OPERATION_NOT_ALLOWED 403
 *
 * Documented deviations from the Java source (all flagged inline):
 *  - ctx.acs undefined → UPSTREAM_UNAVAILABLE 503 (Java's IOException path);
 *  - ctx.clientAccess undefined → SOURCE_NOT_CONFIGURED 503;
 *  - per-device client-session bindings are opaque tokens from bindings.ts
 *    (no registry heartbeat/expiry — release() drops and re-mints);
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
import { requestMeta } from './request-meta.js';
import {
  ACTION_SET,
  checkedLaunchScopes,
  validateResourceActions,
} from './scope.js';
import type { LaunchScope } from './protocol.js';

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
const memberPairing = async (ctx: GatewayContext, b: JsonObject): Promise<JsonObject> => {
  if (b.member !== true) fail('INVALID_REQUEST', 400);
  if (ctx.auth.memberRequest === undefined) fail('OPERATION_NOT_ALLOWED', 403);
  if (ctx.localTasks === undefined) fail('LOCAL_SOURCE_NOT_CONFIGURED', 409);
  const catalog = await ctx.localTasks.ownerCatalog();
  const launches: LaunchScope[] = [];
  const catalogs = [catalog,
    ...(Array.isArray(catalog.backends) ? catalog.backends.filter(isRecord) : [])];
  for (const c of catalogs) {
    const backend = asText(c.backendStoreId);
    if (backend === '') continue;
    const engines = asArr(c.engines).map(asObj)
      .map((e) => asText(e.engineId)).filter((e) => e !== '');
    for (const p of asArr(c.projects).map(asObj)) {
      const project = asText(p.projectId);
      if (project === '') continue;
      for (const engineId of engines) {
        launches.push({ backendStoreId: backend, projectId: project, engineId });
      }
    }
  }
  const actions = [...ACTION_SET];
  const scope = {
    resources: [],
    launchScopes: checkedLaunchScopes(launches),
    actions,
  };
  validateResourceActions(scope.resources, scope.launchScopes, actions);
  return ctx.auth.memberRequest(b, scope);
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

import { requiresCommercialAccess } from './commercial.js';

export async function handlePhoneRoute(ctx: GatewayContext, req: HttpRequest): Promise<HttpResponse> {
  try {
    return await route(ctx, req);
  } catch (error) {
    return phoneProblem(req.path, error);
  }
}

const route = async (ctx: GatewayContext, req: HttpRequest): Promise<HttpResponse> => {
  const { path, method } = req;
  if (path.includes('%') || path.includes('..') || path.includes('//')) fail('INVALID_REQUEST', 400);

  if (path === '/personal/v1/pairing-requests' && method === 'POST') {
    rate(ctx, req);
    const b = exact(jsonBody(req),
      'pairingRequestId', 'inviteId', 'inviteSecret', 'installationId', 'label', 'pollingSecretHash', 'member');
    // Member-attested pairing: reaching the relay listener at all means the
    // member service authenticated the caller and routed it to this bound
    // host, so the channel itself is the grant — no sealed invitation. The
    // member marker is meaningless on the public listener and rejected there.
    if (b.member !== undefined && req.relayIngress !== true) fail('INVALID_REQUEST', 400);
    if (req.relayIngress === true && b.inviteId === undefined) {
      return { status: 202, body: await memberPairing(ctx, b) };
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
  if (requiresCommercialAccess(req)) {
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
    view.commercial = {required:ctx.config.allowUnlicensedDevelopment !== true,dailyOrigin:ctx.commercial?.dailyOrigin ?? null};
    const capabilities = asObj(view.capabilities);
    capabilities.executionPolicy = true;
    capabilities.manageExecutionPolicy = actions.has('POLICY');
    capabilities.localTasks = ctx.localTasks !== undefined;
    capabilities.launch = ctx.localTasks !== undefined && actions.has('LAUNCH');
    capabilities.inbox = true;
    capabilities.notifications = false;
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
    const page = await ctx.approvals.list(device);
    if ((await ctx.auth.authenticate(token)).revision !== device.revision) fail('GRANT_REVISION_CHANGED', 409);
    return { status: 200, body: page };
  }

  if (/^\/personal\/v1\/approvals\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}\/decision$/.test(path) && method === 'POST') {
    if (ctx.approvals === undefined) fail('NOT_FOUND', 404);
    const approvalId = path.split('/')[4];
    const out = await ctx.approvals.decide(device, approvalId, jsonBody(req));
    return { status: 200, body: out };
  }

  if (path === '/personal/v1/local-tasks' || path.startsWith('/personal/v1/local-tasks/')) {
    if (ctx.localTasks === undefined) fail('LOCAL_SOURCE_NOT_CONFIGURED', 409);
    const input = method === 'POST' ? jsonBody(req) : null;
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
    releaseBinding(ctx, device.id);
    return { status: 204, body: null };
  }

  if (path === '/personal/v1/sessions' && method === 'GET') {
    return sessionList(ctx, token, device);
  }

  if (method === 'GET' && /^\/personal\/v1\/agent\/sessions\/[A-Za-z0-9._-]+\/assignment-options$/.test(path)) {
    return assignmentOptions(ctx, token, device, javaSplit(path)[5]);
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
  const source = await acsCall(ctx, 'GET', '/api/v2/capabilities', undefined, undefined, bindingFor(ctx, device));
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

const sessionList = async (ctx: GatewayContext, token: string, device: Device): Promise<HttpResponse> => {
  const rows: unknown[] = [];
  const sessions = device.sessions ?? [];
  for (const sid of sessions) {
    await ctx.auth.authorize(token, sid, 'OBSERVE');
    const binding = bindingFor(ctx, device);
    const r = await acsCall(ctx, 'GET', `/api/v2/sessions/${sid}/foundation`, undefined, undefined, binding);
    if (r.status === 404) continue;
    if (r.status !== 200) fail('UPSTREAM_UNAVAILABLE', 503);
    const row = asObj(acsJson(r));
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
  const binding = bindingFor(ctx, device);
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
    const current = await acsCall(ctx, 'GET', routePath, undefined, undefined, bindingFor(ctx, device));
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
  const result = await acsCall(ctx, method, routePath, payload, key, bindingFor(ctx, device));
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
  let collaborationRoute = false;
  let collaborationFiles = false;
  let action = 'OBSERVE';
  let prepared: Uint8Array | undefined;

  if (p[3] === 'sessions') {
    if (p.length < 6) fail('OPERATION_NOT_ALLOWED', 403);
    sid = p[4];
    id(sid);
    const foundation = p.length === 6 && p[5] === 'foundation' && method === 'GET';
    attachment = p.length === 10 && p[5] === 'messages' && p[7] === 'attachments'
      && ['bytes', 'content'].includes(p[9]) && method === 'GET';
    const message = p.length === 6 && p[5] === 'messages' && method === 'POST';
    if (message) { action = 'INTERACT'; }
    approvalList = p.length === 6 && p[5] === 'approvals' && method === 'GET';
    const history = method === 'GET' && ((p.length === 6 && ['messages', 'summary'].includes(p[5]))
      || (p.length === 8 && p[5] === 'messages' && p[7] === 'content'));
    const packages = p[5] === 'context-packages' && ((method === 'POST' && p.length === 6)
      || (method === 'GET' && (p.length === 7 || (p.length === 8 && p[7] === 'items'))));
    const auxiliaries = p.length === 6 && p[5] === 'auxiliary-sessions' && (method === 'GET' || method === 'POST');
    const turns = p[5] === 'auxiliary-turns' && ((method === 'GET' && (p.length === 6 || p.length === 7))
      || (method === 'POST' && (p.length === 6 || (p.length === 8 && p[7] === 'cancel'))));
    if ((packages || auxiliaries || turns) && method === 'POST') { action = 'INTERACT'; }
    if ((foundation || history || turns) && !(device.sessions ?? []).includes(sid)) {
      sid = await auxiliaryRoot(ctx, sid, device, method === 'GET' && (foundation || history));
    }
    const snapshots = p.length >= 6 && p[5] === 'observation-snapshots'
      && ((p.length === 6 && method === 'POST')
        || ((p.length === 7 || (p.length === 8 && p[7] === 'items')) && method === 'GET'));
    if (!foundation && !snapshots && !history && !message && !attachment && !approvalList
      && !packages && !auxiliaries && !turns) fail('OPERATION_NOT_ALLOWED', 403);
    for (let i = 6; i < p.length; i++) id(p[i]);
  } else if (p[3] === 'runs') {
    const rid = p[4];
    id(rid);
    const command = p.length >= 6 && p.length <= 7 && p[5] === 'commands';
    const boundary = p.length >= 6 && p.length <= 8 && p[5] === 'boundary-requests';
    assignmentRoute = p.length >= 6 && p.length <= 8 && p[5] === 'assignment-transitions';
    const segments = p.length === 6 && p[5] === 'execution-segments';
    collaborationRoute = p.length >= 6 && p.length <= 10
      && ['collaboration-groups', 'collaboration-activity'].includes(p[5]);
    const collaborationAction = collaborationRoute ? collabAction(method, p) : null;
    collaborationFiles = collaborationRoute && p.length === 10 && p[9] === 'files';
    let read = method === 'GET' && (p.length === 5 || command || segments
      || ((boundary || assignmentRoute) && p.length <= 7));
    let write = method === 'POST' && ((command && p.length === 6)
      || (boundary && (p.length === 6 || (p.length === 8 && p[7] === 'cancel')))
      || (assignmentRoute && (p.length === 6 || (p.length === 7 && p[6] === 'preflight')
        || (p.length === 8 && p[7] === 'cancel'))));
    if (write) action = assignmentRoute ? 'ASSIGN' : boundary ? 'INTERACT' : 'CONTROL';
    if (collaborationRoute) {
      read = method === 'GET';
      write = method === 'POST';
      action = collaborationAction!;
    }
    if (!read && !write) fail('OPERATION_NOT_ALLOWED', 403);
    for (let i = 6; i < p.length; i++) id(p[i]);
    const lookup = await acsCall(ctx, 'GET', `/api/v2/runs/${rid}`, undefined, undefined, bindingFor(ctx, device));
    if (lookup.status !== 200) fail('NOT_FOUND', 404);
    sid = asText(asObj(acsJson(lookup)).sessionId);
    await ctx.auth.authorize(token, sid, action);
    if (collaborationRoute && p.length >= 7) {
      const group = await acsCall(ctx, 'GET', `/api/v2/runs/${rid}/collaboration-groups/${p[6]}`,
        undefined, undefined, bindingFor(ctx, device));
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
    const write = p.length === 6 && p[5] === 'decisions' && method === 'POST';
    if (!read && !write) fail('OPERATION_NOT_ALLOWED', 403);
    if (write) {
      action = 'APPROVE';
      if (!(device.actions ?? []).includes(action)) fail('DEVICE_SCOPE_DENIED', 403);
    }
    const lookup = await acsCall(ctx, 'GET', `/api/v2/approvals/${p[4]}`, undefined, undefined, bindingFor(ctx, device));
    if (lookup.status !== 200) fail('NOT_FOUND', 404);
    sid = await approvalSession(ctx, asObj(acsJson(lookup)), device);
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
      const lookup = await acsCall(ctx, 'GET', upstreamRoute, undefined, undefined, bindingFor(ctx, device));
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
  if (method === 'POST') {
    if (req.bodyError === 'BODY_TOO_LARGE') fail('BODY_TOO_LARGE', 413);
    const budget = messageBudgetRoute(p, action) ? messageBudget() : 65_536;
    const bytes = req.rawBody ?? new Uint8Array();
    if (bytes.length > budget) fail('BODY_TOO_LARGE', 413);
    payload = prepared ?? bytes;
    key = idempotencyHeader(req);
    id(key);
  }
  const query = req.rawQuery;
  if (query !== null) {
    if (method !== 'GET' || query.length > 4096) fail('INVALID_REQUEST', 400);
    if (collaborationFiles) {
      validateCollaborationQuery(query);
    } else {
      for (const item of query.split('&')) {
        const [name] = firstPair(item);
        if (!['limit', 'cursor', 'before'].includes(name)) fail('INVALID_REQUEST', 400);
      }
    }
  }
  // Recheck after source resolution and immediately before dispatch. No retry of a write.
  await ctx.auth.authorize(token, sid, action);
  // Admission is short: revoke does not wait on a slow source HTTP request.
  // An already admitted operation may execute; recheck below withholds its result.
  await ctx.auth.authorize(token, sid, action);
  const reply = await acsCall(ctx, method, upstreamRoute + (query === null ? '' : `?${query}`),
    payload, key, bindingFor(ctx, device), attachment ? messageBudget() : undefined);

  let replyBody: Uint8Array = reply.body;
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
  const lookup = await acsCall(ctx, 'GET', `/api/v2/sessions/${child}`, undefined, undefined, bindingFor(ctx, device));
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
    const run = await acsCall(ctx, 'GET', `/api/v2/runs/${rid}`, undefined, undefined, bindingFor(ctx, device));
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

/** Java collaborationAction() — pure route-shape validator. */
const collabAction = (method: string, p: string[]): string => {
  if (p[5] === 'collaboration-activity') {
    if (method === 'GET' && p.length === 6) return 'OBSERVE';
    fail('OPERATION_NOT_ALLOWED', 403);
  }
  if (method === 'GET' && (p.length === 6 || p.length === 7
    || (p.length === 8 && ['executions', 'adoptions'].includes(p[7]))
    || (p.length === 9 && ['executions', 'candidates', 'adoptions'].includes(p[7]))
    || (p.length === 10 && ['candidates', 'previews'].includes(p[7]) && p[9] === 'files'))) {
    return 'OBSERVE';
  }
  if (method === 'POST') {
    if (p.length === 6
      || (p.length === 8 && ['authorizations', 'start', 'cancel'].includes(p[7]))
      || (p.length === 10 && p[7] === 'executions' && p[9] === 'cancel')) return 'COLLABORATE';
    if ((p.length === 8 && ['selections', 'adoptions'].includes(p[7]))
      || (p.length === 10 && p[7] === 'selections' && p[9] === 'previews')
      || (p.length === 10 && p[7] === 'adoptions' && ['cancel', 'recover'].includes(p[9]))) return 'ADOPT';
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
    if (!seen.add(name)) fail('INVALID_REQUEST', 400);
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
