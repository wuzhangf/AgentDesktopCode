/**
 * Owner API — Java ownerHandler() ported under /api/v2/personal-access on a
 * dedicated loopback listener:
 *
 *   GET  /api/v2/personal-access/capabilities
 *   POST /api/v2/personal-access/pairing-invitations          → 201 invitation
 *   GET  /api/v2/personal-access/pairing-invitations/{id}     → original invitation (read-only)
 *   GET  /api/v2/personal-access/pairing-requests             → requests()
 *   GET  /api/v2/personal-access/devices                      → devices()
 *   POST /api/v2/personal-access/pairing-requests/{id}/decisions  exact{approve}
 *   PUT  /api/v2/personal-access/devices/{id}/scope           sessions|resources form
 *   DELETE /api/v2/personal-access/devices/{id}               revoke + release → 204
 *   else → NOT_FOUND 404
 *
 * Gate (Java order): loopback peer → Authorization == 'Bearer '+ownerToken
 * (constant-time) → client-session token required (Java
 * registry.validateTokenWithRemainingTtl). X-Client-Session carries the
 * configured owner client token; X-CodeAgent-Client-Token (Java's wire name)
 * is accepted as an alias by the listener.
 */
import { constantEqual, exact, fail, GatewayError, id, isRecord, resourceKey, text } from './protocol.js';
import type { LaunchScope, Resource } from './protocol.js';
import { checkedLaunchScopes, checkedResources } from './scope.js';
import type {
  GatewayAuth,
  GatewayContext,
  HttpRequest,
  HttpResponse,
  JsonObject,
  MaybePromise,
} from './context.js';
import { releaseBinding } from './bindings.js';

/**
 * Java auth.decide(rid, approve) — Devices implements it; the fixed
 * GatewayAuth contract in context.ts omits the member, so it is accessed
 * through a narrow structural seam (undefined → PERSONAL_ACCESS_FAILURE).
 */
type OwnerAuth = GatewayAuth & {
  decide?(rid: string, approve: boolean): MaybePromise<JsonObject>;
};

const ROOT = '/api/v2/personal-access';

const OWNER_ACTIONS = [
  'OBSERVE', 'CONTROL', 'INTERACT', 'APPROVE', 'POLICY', 'ASSIGN', 'COLLABORATE', 'ADOPT',
];

export interface OwnerCredentials {
  /** Authorization == 'Bearer '+ownerToken. */
  ownerToken: string;
  /** Required X-Client-Session value (registry-token analogue). */
  ownerClientToken: string;
}

const isLoopback = (ip: string): boolean => {
  const v = ip.startsWith('::ffff:') ? ip.slice(7) : ip;
  return v === '127.0.0.1' || v === '::1' || v === 'localhost'
    || (v.startsWith('127.') && v.split('.').every((p) => /^\d{1,3}$/.test(p)));
};

const secureEquals = (a: string, b: string | undefined): boolean =>
  b !== undefined && b.length === a.length && constantEqual(a, b);

const javaSplit = (path: string): string[] => {
  const parts = path.split('/');
  while (parts.length > 0 && parts[parts.length - 1] === '') parts.pop();
  return parts;
};

const jsonBody = (req: HttpRequest): JsonObject => {
  if (req.bodyError === 'BODY_TOO_LARGE') fail('BODY_TOO_LARGE', 413);
  if (req.rawBody !== undefined) {
    if (req.rawBody.length > 65_536) fail('BODY_TOO_LARGE', 413);
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

/** Java strings(): required array of text values. */
const strings = (value: unknown): string[] => {
  if (!Array.isArray(value)) fail('INVALID_REQUEST', 400);
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') fail('INVALID_REQUEST', 400);
    out.push(item);
  }
  return out;
};

/** TreeSet equivalent: dedupe + sorted. */
const sortedSet = (values: string[]): string[] => [...new Set(values)].sort();

/** Java resourceRefs(): array ≤100 of exact {kind,backendStoreId,sessionId,taskId}. */
const resourceRefs = async (ctx: GatewayContext, value: unknown): Promise<Resource[]> => {
  if (!Array.isArray(value) || value.length > 100) fail('INVALID_SCOPE', 400);
  const refs: Resource[] = [];
  for (const item of value) {
    if (item === null) fail('INVALID_SCOPE', 400);
    exact(item, 'kind', 'backendStoreId', 'sessionId', 'taskId');
    refs.push(item as Resource);
  }
  // Java binds ACS_SESSION resources to auth.ownerStatus().storeId — here the
  // configured ACS store id (same value when the gateway hosts its own ACS).
  const store = String((await ctx.auth.ownerStatus()).storeId ?? ctx.config.acsStoreId);
  return checkedResources(store, refs);
};

/** Java launchScopes(): optional array ≤100 of exact {backendStoreId,projectId,engineId}.
 * Node extension: the literal string "detected" expands to every
 * (project × engine) pair in the live localSource catalog — the
 * "grant all detected CLIs" owner-facing convenience for the OC-G free
 * path. Explicit arrays keep the Java contract unchanged. */
const launchScopes = async (ctx: GatewayContext, value: unknown): Promise<LaunchScope[]> => {
  if (value === 'detected') {
    if (ctx.localTasks === undefined) fail('LOCAL_SOURCE_NOT_CONFIGURED', 409);
    const catalog = await ctx.localTasks.ownerCatalog();
    // ownerCatalog() mirrors the top-level backend inside backends[] — dedupe
    // by backendStoreId or checkedLaunchScopes rejects the double entry.
    const seen = new Set<string>();
    const catalogs = [catalog,
      ...(Array.isArray(catalog.backends) ? catalog.backends.filter(isRecord) : [])]
      .filter((c) => {
        const b = typeof c.backendStoreId === 'string' ? c.backendStoreId : '';
        return b !== '' && !seen.has(b) && seen.add(b);
      });
    const refs: LaunchScope[] = [];
    for (const c of catalogs) {
      const backend = typeof c.backendStoreId === 'string' ? c.backendStoreId : undefined;
      if (backend === undefined) continue;
      for (const p of Array.isArray(c.projects) ? c.projects : []) {
        if (!isRecord(p) || typeof p.projectId !== 'string') continue;
        for (const e of Array.isArray(c.engines) ? c.engines : []) {
          if (!isRecord(e) || typeof e.engineId !== 'string') continue;
          refs.push({ backendStoreId: backend, projectId: p.projectId, engineId: e.engineId });
        }
      }
    }
    return checkedLaunchScopes(refs);
  }
  const refs: LaunchScope[] = [];
  if (value !== undefined && value !== null) {
    if (!Array.isArray(value) || value.length > 100) fail('INVALID_SCOPE', 400);
    for (const item of value) {
      if (item === null) fail('INVALID_SCOPE', 400);
      exact(item, 'backendStoreId', 'projectId', 'engineId');
      refs.push(item as LaunchScope);
    }
  }
  return checkedLaunchScopes(refs);
};

/** Java verifyOwnerScopes(): ACS sessions probe upstream; native scope validates locally. */
const verifyOwnerScopes = async (
  ctx: GatewayContext, refs: Resource[], launches: LaunchScope[],
): Promise<void> => {
  let nativeScope = launches.length > 0;
  for (const r of refs) {
    if (r.kind === 'ACS_SESSION') {
      await acsSessionProbe(ctx, r.sessionId!);
    } else {
      nativeScope = true;
    }
  }
  if (nativeScope) {
    if (ctx.localTasks === undefined) fail('LOCAL_SOURCE_NOT_CONFIGURED', 409);
    await ctx.localTasks.validateOwnerResources(refs, launches);
  }
};

/** Java: GET /api/v2/sessions/{sid} must return 200, else SOURCE_NOT_READY 409. */
const acsSessionProbe = async (ctx: GatewayContext, sessionId: string): Promise<void> => {
  if (ctx.acs === undefined) fail('SOURCE_NOT_READY', 409);
  const reply = await ctx.acs.call('GET', `/api/v2/sessions/${sessionId}`, undefined, undefined, undefined);
  if (reply.status !== 200) fail('SOURCE_NOT_READY', 409);
};

// ---------------------------------------------------------------------------
// Route dispatch — Java ownerHandler().
// ---------------------------------------------------------------------------

export async function handleOwnerRoute(
  ctx: GatewayContext,
  req: HttpRequest,
  creds: OwnerCredentials,
): Promise<HttpResponse> {
  try {
    if (!isLoopback(req.clientIp)) fail('LOCAL_OWNER_REQUIRED', 403);
    if (!secureEquals(`Bearer ${creds.ownerToken}`, req.authorization)) fail('UNAUTHORIZED', 401);
    // Java registry.validateTokenWithRemainingTtl(LOCAL_OWNER_PRINCIPAL, ...)
    if (!secureEquals(creds.ownerClientToken, req.clientSessionHeader)) fail('UNAUTHORIZED', 401);

    const { path, method } = req;
    const parts = javaSplit(path);

    if (method === 'GET' && path === `${ROOT}/capabilities`) {
      const out: JsonObject = { ...(await ctx.auth.ownerStatus()) };
      out.certificateSha256 = ctx.config.certificateSha256;
      out.certificateNotBefore = ctx.config.certificateNotBefore;
      out.certificateNotAfter = ctx.config.certificateNotAfter;
      out.bindAddress = ctx.config.bindAddress;
      out.port = ctx.config.port;
      out.certificateNames = ctx.config.certificateNames ?? [];
      const actions = [...OWNER_ACTIONS];
      if (ctx.localTasks !== undefined) actions.push('LAUNCH');
      out.supportedActions = actions;
      out.resourceScopeVersion = 2;
      if (ctx.localTasks !== undefined) {
        try {
          out.localSource = await ctx.localTasks.ownerCatalog();
        } catch (unavailable) {
          out.localSource = {
            available: false,
            reasonCode: unavailable instanceof GatewayError ? unavailable.code : 'LOCAL_SOURCE_UNAVAILABLE',
          };
        }
      }
      return { status: 200, body: out };
    }

    if (method === 'GET' && parts.length === 6 && parts[4] === 'pairing-invitations') {
      const lookup = ctx.auth.invitationById;
      if (lookup === undefined) fail('INVITATION_RECOVERY_UNSUPPORTED', 503);
      id(parts[5]);
      const invitation = await lookup.call(ctx.auth, parts[5]!);
      invitation.certificatePem = ctx.config.certificatePem;
      return { status: 200, body: invitation };
    }

    if (method === 'POST' && path === `${ROOT}/pairing-invitations`) {
      const b = exact(jsonBody(req), 'requestId', 'sessions', 'resources', 'launchScopes', 'actions');
      const rid = text(b, 'requestId');
      if (b.resources !== undefined) {
        if (b.sessions !== undefined) fail('INVALID_SCOPE', 400);
        const resources = await resourceRefs(ctx, b.resources);
        const launches = await launchScopes(ctx, b.launchScopes);
        await verifyOwnerScopes(ctx, resources, launches);
        const invitation = await ctx.auth.invitationResources(
          rid, resources, launches, sortedSet(strings(b.actions)), ctx.config.certificateSha256 ?? '');
        invitation.certificatePem = ctx.config.certificatePem;
        return { status: 201, body: invitation };
      }
      if (b.launchScopes !== undefined) fail('INVALID_SCOPE', 400);
      const sessions = strings(b.sessions);
      const actions = sortedSet(strings(b.actions));
      // Confirm source existence before producing an owner-visible invitation.
      for (const sid of sessions) {
        id(sid);
        await acsSessionProbe(ctx, sid);
      }
      const invitation = await ctx.auth.invitation(rid, sessions, actions, ctx.config.certificateSha256 ?? '');
      invitation.certificatePem = ctx.config.certificatePem;
      return { status: 201, body: invitation };
    }

    // Worker self-registration: the owner mints a one-shot secret here and a
    // reachable worker host redeems it through the public listener — the
    // same trust shape as device pairing invitations.
    if (method === 'POST' && path === `${ROOT}/worker-invitations`) {
      const b = exact(jsonBody(req), 'requestId');
      if (ctx.workers === undefined) fail('OPERATION_NOT_ALLOWED', 403);
      return { status: 201, body: await ctx.workers.mint(text(b, 'requestId')) };
    }

    // Loopback-direct worker rows — owner-token auth IS the consent, so the
    // supervisor reconciles agent registrations without a service restart.
    if (method === 'POST' && path === `${ROOT}/worker-registrations`) {
      const b = exact(jsonBody(req), 'connectionId', 'url', 'token', 'displayName');
      if (ctx.workers === undefined) fail('OPERATION_NOT_ALLOWED', 403);
      return { status: 202, body: await ctx.workers.registerDirect(b) };
    }
    if (method === 'DELETE' && parts.length === 6 && parts[4] === 'worker-registrations') {
      id(parts[5]);
      if (ctx.workers === undefined) fail('OPERATION_NOT_ALLOWED', 403);
      await ctx.workers.remove(parts[5]);
      return { status: 204, body: null };
    }

    // Master connect switch — closes/reopens the phone listener while the
    // owner loopback keeps serving so the UI can still read state.
    if (method === 'GET' && path === `${ROOT}/link-state`) {
      if (ctx.link === undefined) fail('OPERATION_NOT_ALLOWED', 403);
      return { status: 200, body: { enabled: ctx.link.phoneEnabled() } };
    }
    if (method === 'POST' && path === `${ROOT}/link-state`) {
      const b = exact(jsonBody(req), 'enabled');
      if (ctx.link === undefined) fail('OPERATION_NOT_ALLOWED', 403);
      if (typeof b.enabled !== 'boolean') fail('INVALID_REQUEST', 400);
      await ctx.link.setPhoneEnabled(b.enabled);
      return { status: 200, body: { enabled: ctx.link.phoneEnabled() } };
    }

    if (method === 'GET' && path === `${ROOT}/pairing-requests`) {
      return { status: 200, body: await ctx.auth.requests() };
    }
    if (method === 'GET' && path === `${ROOT}/devices`) {
      return { status: 200, body: await ctx.auth.devices() };
    }

    if (parts.length === 7 && parts[4] === 'pairing-requests' && parts[6] === 'decisions' && method === 'POST') {
      const b = exact(jsonBody(req), 'approve');
      if (typeof b.approve !== 'boolean') fail('INVALID_REQUEST', 400);
      const decide = (ctx.auth as OwnerAuth).decide;
      if (decide === undefined) fail('PERSONAL_ACCESS_FAILURE', 503);
      return { status: 200, body: await decide.call(ctx.auth, parts[5], b.approve) };
    }

    if (parts.length === 7 && parts[4] === 'devices' && parts[6] === 'scope' && method === 'PUT') {
      const b = exact(jsonBody(req),
        'requestId', 'expectedGrantRevision', 'sessions', 'resources', 'launchScopes', 'actions');
      if (b.resources !== undefined) {
        if (b.sessions !== undefined) fail('INVALID_SCOPE', 400);
        const resources = await resourceRefs(ctx, b.resources);
        const launches = await launchScopes(ctx, b.launchScopes);
        const revision = text(b, 'expectedGrantRevision');
        const actions = sortedSet(strings(b.actions));
        // A scope update can carry forward existing task grants even when their
        // Worker is offline. New resources still need a live binding check.
        const current = (await ctx.auth.devices()).find(row =>
          row.deviceGrantId === parts[5] && row.state === 'ACTIVE' && row.grantRevision === revision);
        const keepsResourceActions = actions.every(action =>
          action === 'LAUNCH' || (Array.isArray(current?.actions) && current.actions.includes(action)));
        const retained = new Set((keepsResourceActions && Array.isArray(current?.resources)
          ? current.resources as Resource[] : []).filter(resource => resource.kind === 'WORKER_LOCAL').map(resourceKey));
        await verifyOwnerScopes(ctx, resources.filter(resource => !retained.has(resourceKey(resource))), launches);
        return {
          status: 200,
          body: await ctx.auth.updateScopeResources(parts[5], text(b, 'requestId'),
            revision, resources, launches, actions),
        };
      }
      if (b.launchScopes !== undefined) fail('INVALID_SCOPE', 400);
      const sessions = strings(b.sessions);
      for (const sid of sessions) {
        id(sid);
        await acsSessionProbe(ctx, sid);
      }
      return {
        status: 200,
        body: await ctx.auth.updateScope(parts[5], text(b, 'requestId'),
          text(b, 'expectedGrantRevision'), sessions, sortedSet(strings(b.actions))),
      };
    }

    if (parts.length === 6 && parts[4] === 'devices' && method === 'DELETE') {
      await ctx.auth.revoke(parts[5]);
      await releaseBinding(ctx, parts[5]);
      return { status: 204, body: null };
    }

    fail('NOT_FOUND', 404);
  } catch (error) {
    if (error instanceof GatewayError) {
      return { status: error.httpStatus, body: { code: error.code, detail: error.code } };
    }
    // Java ownerHandler: unexpected Exception → PERSONAL_ACCESS_FAILURE 503.
    console.error('device-gateway: unexpected owner-api error:', error);
    return { status: 503, body: { code: 'PERSONAL_ACCESS_FAILURE', detail: 'PERSONAL_ACCESS_FAILURE' } };
  }
}
