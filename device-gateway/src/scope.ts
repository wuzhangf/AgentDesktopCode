/**
 * Scope helpers — port of PersonalResourceScope validation plus the
 * PersonalAccessService scope rules.
 *
 * Java-exact validators (throwing GatewayError INVALID_SCOPE / INVALID_REQUEST):
 *   checkedResources(acsStoreId, input)   — ≤100, kind-specific id() checks,
 *                                           ACS_SESSION bound to acsStoreId,
 *                                           canonical-key dedup, TreeMap-sorted
 *   checkedLaunchScopes(input)            — ≤100, engine set, dedup, sorted
 *   validateScope(sessions, actions)      — legacy sessions form
 *   validateResourceActions(r, l, a)      — resources form
 *
 * Non-throwing body-parse helpers (parseScope/validX) keep the HTTP-layer
 * contract codes (INVALID_REQUEST / INVALID_ACTION) used by owner routes.
 */
import {
  exact,
  fail,
  hash,
  id,
  isRecord,
  launchScopeKey,
  resourceKey,
  type LaunchScope,
  type Resource,
  type ScopeChange,
  type ScopeRecord,
} from './protocol.js';

// ---------------------------------------------------------------------------
// Action sets — Java validateScope / validateResourceActions allow-lists.
// ---------------------------------------------------------------------------

/** Legacy eight actions allowed by the sessions-form validateScope. */
export const LEGACY_ACTION_SET = new Set([
  'OBSERVE', 'CONTROL', 'INTERACT', 'APPROVE', 'POLICY', 'ASSIGN',
  'COLLABORATE', 'ADOPT',
]);

/** All twelve actions allowed on resource-form scopes. */
export const ACTION_SET = new Set([
  ...LEGACY_ACTION_SET, 'LAUNCH',
  'GRAPHICS_OBSERVE', 'GRAPHICS_CAPTURE', 'GRAPHICS_ACT',
]);

const ENGINE_SET = new Set(['pi', 'codex', 'claude', 'macos']);
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** Java checkedResources / checkedLaunchScopes bound. */
export const SCOPE_RESOURCE_LIMIT = 100;

const MAX_BODY_RESOURCES = 128;
const MAX_BODY_LAUNCH_SCOPES = 128;
const MAX_BODY_SESSIONS = 512;
const MAX_BODY_ACTIONS = 32;

// ---------------------------------------------------------------------------
// Java PersonalResourceScope ports (throwing, INVALID_SCOPE 400).
// ---------------------------------------------------------------------------

/** acs(storeId, sessions): legacy sessions → ACS_SESSION resources. */
export function acs(storeId: string, sessions: string[] | undefined): Resource[] {
  return (sessions ?? []).map((sid) => ({ kind: 'ACS_SESSION', backendStoreId: storeId, sessionId: sid }));
}

/**
 * Java checkedResources: bounded, shape-checked, canonical-key deduped,
 * returned sorted by canonical key. ACS_SESSION resources must bind the ACS
 * store; WORKER_LOCAL carries taskId only. id() failures surface as
 * INVALID_REQUEST; scope-shape violations as INVALID_SCOPE.
 */
export function checkedResources(acsStore: string, input: Resource[] | undefined): Resource[] {
  if (input == null || input.length > SCOPE_RESOURCE_LIMIT) fail('INVALID_SCOPE', 400);
  const out = new Map<string, Resource>();
  for (const r of input) {
    if (r == null || !isRecord(r)) fail('INVALID_SCOPE', 400);
    id(r.backendStoreId);
    let copy: Resource;
    if (r.kind === 'ACS_SESSION') {
      id(r.sessionId);
      if (r.taskId !== undefined || r.backendStoreId !== acsStore) fail('INVALID_SCOPE', 400);
      copy = { kind: 'ACS_SESSION', backendStoreId: r.backendStoreId, sessionId: r.sessionId };
    } else if (r.kind === 'WORKER_LOCAL') {
      id(r.taskId);
      if (r.sessionId !== undefined) fail('INVALID_SCOPE', 400);
      copy = { kind: 'WORKER_LOCAL', backendStoreId: r.backendStoreId, taskId: r.taskId };
    } else {
      fail('INVALID_SCOPE', 400);
    }
    const key = resourceKey(copy);
    if (out.has(key)) fail('INVALID_SCOPE', 400);
    out.set(key, copy);
  }
  return [...out.keys()].sort().map((key) => out.get(key)!);
}

/**
 * Java checkedLaunchScopes: bounded, engine allow-list, canonical-key dedup,
 * returned sorted by canonical key.
 */
export function checkedLaunchScopes(input: LaunchScope[] | undefined): LaunchScope[] {
  const list = input ?? [];
  if (list.length > SCOPE_RESOURCE_LIMIT) fail('INVALID_SCOPE', 400);
  const out = new Map<string, LaunchScope>();
  for (const s of list) {
    if (s == null || !isRecord(s)) fail('INVALID_SCOPE', 400);
    id(s.backendStoreId);
    id(s.projectId);
    if (!ENGINE_SET.has(s.engineId as string)) fail('INVALID_SCOPE', 400);
    const copy: LaunchScope = { backendStoreId: s.backendStoreId, projectId: s.projectId, engineId: s.engineId };
    const key = launchScopeKey(copy);
    if (out.has(key)) fail('INVALID_SCOPE', 400);
    out.set(key, copy);
  }
  return [...out.keys()].sort().map((key) => out.get(key)!);
}

/**
 * Java PersonalAccessService.validateScope (legacy sessions form):
 * sessions non-empty, ≤100, no duplicates; actions non-null, must contain
 * OBSERVE, and must be a subset of the legacy eight-action set.
 */
export function validateScope(sessions: string[] | undefined, actions: string[] | undefined): void {
  if (sessions == null || sessions.length === 0 || sessions.length > SCOPE_RESOURCE_LIMIT
    || new Set(sessions).size !== sessions.length
    || actions == null || !actions.includes('OBSERVE')
    || !actions.every((a) => LEGACY_ACTION_SET.has(a))) {
    fail('INVALID_SCOPE', 400);
  }
  for (const sid of sessions) id(sid);
}

/**
 * Java PersonalAccessService.validateResourceActions:
 * resources or launch scopes must be non-empty; actions must contain OBSERVE
 * and stay inside the twelve-action set; GRAPHICS_ACT requires CONTROL;
 * LAUNCH is present iff launch scopes are non-empty.
 */
export function validateResourceActions(
  resources: Resource[],
  launches: LaunchScope[],
  actions: string[] | undefined,
): void {
  if ((resources.length === 0 && launches.length === 0)
    || actions == null
    || !actions.includes('OBSERVE')
    || !actions.every((a) => ACTION_SET.has(a))
    || (actions.includes('GRAPHICS_ACT') && !actions.includes('CONTROL'))
    || (actions.includes('LAUNCH') !== launches.length > 0)) {
    fail('INVALID_SCOPE', 400);
  }
}

// ---------------------------------------------------------------------------
// allows — Java device-side authorization check: pure action membership.
// GRAPHICS_ACT⇒CONTROL is enforced at scope-write time by
// validateResourceActions, not here.
// ---------------------------------------------------------------------------

export function allows(scope: ScopeRecord, action: string): boolean {
  if (!ACTION_SET.has(action)) return false;
  return (scope.actions ?? []).includes(action);
}

// ---------------------------------------------------------------------------
// Non-throwing validators (boolean mirrors used by body parsing).
// ---------------------------------------------------------------------------

export function validResource(value: unknown): value is Resource {
  if (!isRecord(value)) return false;
  for (const key of Object.keys(value)) {
    if (!['kind', 'backendStoreId', 'sessionId', 'taskId'].includes(key)) return false;
  }
  if (typeof value.backendStoreId !== 'string' || !ID_PATTERN.test(value.backendStoreId)) return false;
  if (value.kind === 'ACS_SESSION') {
    return typeof value.sessionId === 'string' && ID_PATTERN.test(value.sessionId)
      && value.taskId === undefined;
  }
  if (value.kind === 'WORKER_LOCAL') {
    return typeof value.taskId === 'string' && ID_PATTERN.test(value.taskId)
      && value.sessionId === undefined;
  }
  return false;
}

export function validLaunchScope(value: unknown): value is LaunchScope {
  if (!isRecord(value)) return false;
  for (const key of Object.keys(value)) {
    if (!['backendStoreId', 'projectId', 'engineId'].includes(key)) return false;
  }
  return typeof value.backendStoreId === 'string' && ID_PATTERN.test(value.backendStoreId)
    && typeof value.projectId === 'string' && ID_PATTERN.test(value.projectId)
    && typeof value.engineId === 'string' && ENGINE_SET.has(value.engineId);
}

export function validSessionList(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= MAX_BODY_SESSIONS
    && value.every((v) => typeof v === 'string' && ID_PATTERN.test(v))
    && new Set(value).size === value.length;
}

export function validActions(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= MAX_BODY_ACTIONS
    && value.every((v) => typeof v === 'string' && ACTION_SET.has(v))
    && new Set(value).size === value.length;
}

// ---------------------------------------------------------------------------
// parseScope — exact-shape, bounded, deduped HTTP-body parse.
// ---------------------------------------------------------------------------

export function parseScope(body: Record<string, unknown>): ScopeRecord {
  const parsed = exact(body, 'resources', 'launchScopes', 'sessions', 'actions');
  const out: ScopeRecord = {};

  if (parsed.resources !== undefined) {
    if (!Array.isArray(parsed.resources) || parsed.resources.length > MAX_BODY_RESOURCES) {
      fail('INVALID_REQUEST', 400);
    }
    const seen = new Set<string>();
    const resources: Resource[] = [];
    for (const entry of parsed.resources) {
      if (!validResource(entry)) fail('INVALID_REQUEST', 400);
      const key = resourceKey(entry);
      if (seen.has(key)) fail('INVALID_REQUEST', 400);
      seen.add(key);
      const copy: Resource = { kind: entry.kind, backendStoreId: entry.backendStoreId };
      if (entry.kind === 'ACS_SESSION') copy.sessionId = entry.sessionId;
      else copy.taskId = entry.taskId;
      resources.push(copy);
    }
    out.resources = resources;
  }

  if (parsed.launchScopes !== undefined) {
    if (!Array.isArray(parsed.launchScopes) || parsed.launchScopes.length > MAX_BODY_LAUNCH_SCOPES) {
      fail('INVALID_REQUEST', 400);
    }
    const seen = new Set<string>();
    const launchScopes: LaunchScope[] = [];
    for (const entry of parsed.launchScopes) {
      if (!validLaunchScope(entry)) fail('INVALID_REQUEST', 400);
      const key = launchScopeKey(entry);
      if (seen.has(key)) fail('INVALID_REQUEST', 400);
      seen.add(key);
      launchScopes.push({
        backendStoreId: entry.backendStoreId,
        projectId: entry.projectId,
        engineId: entry.engineId,
      });
    }
    out.launchScopes = launchScopes;
  }

  if (parsed.sessions !== undefined) {
    if (!validSessionList(parsed.sessions)) fail('INVALID_REQUEST', 400);
    out.sessions = [...parsed.sessions];
  }

  if (parsed.actions !== undefined) {
    if (!Array.isArray(parsed.actions) || parsed.actions.length > MAX_BODY_ACTIONS) {
      fail('INVALID_REQUEST', 400);
    }
    const seen = new Set<string>();
    for (const action of parsed.actions) {
      if (typeof action !== 'string' || !ACTION_SET.has(action)) fail('INVALID_ACTION', 400);
      if (seen.has(action)) fail('INVALID_REQUEST', 400);
      seen.add(action);
    }
    out.actions = [...parsed.actions] as string[];
  }

  // Java parity: when both legacy `sessions` and `resources` are present they
  // must resolve to the same ACS_SESSION set for this host's store.
  if (out.sessions !== undefined && out.resources !== undefined) {
    const fromResources = new Set(
      out.resources.filter((r) => r.kind === 'ACS_SESSION').map((r) => r.sessionId!),
    );
    const fromSessions = new Set(out.sessions);
    if (fromResources.size !== fromSessions.size
      || [...fromSessions].some((sid) => !fromResources.has(sid))) {
      fail('INVALID_REQUEST', 400);
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// scopeFingerprint / mergeScopeChanges — deterministic scope hashing retained
// for callers that compare scope content.
// ---------------------------------------------------------------------------

/** Deterministic fingerprint over canonicalized scope content. */
export function scopeFingerprint(scope: ScopeRecord): string {
  const resources = [...(scope.resources ?? [])]
    .map((r) => {
      const copy: { kind: string; backendStoreId: string; sessionId?: string; taskId?: string } = {
        kind: r.kind, backendStoreId: r.backendStoreId,
      };
      if (r.kind === 'ACS_SESSION') copy.sessionId = r.sessionId;
      else copy.taskId = r.taskId;
      return copy;
    })
    .sort((a, b) => resourceKey(a as Resource).localeCompare(resourceKey(b as Resource)));
  const launchScopes = [...(scope.launchScopes ?? [])]
    .map((s) => ({ backendStoreId: s.backendStoreId, projectId: s.projectId, engineId: s.engineId }))
    .sort((a, b) => launchScopeKey(a).localeCompare(launchScopeKey(b)));
  const actions = [...(scope.actions ?? [])].sort();
  return hash(JSON.stringify({ resources, launchScopes, actions }));
}

/**
 * Scope-change merge: compare the stored fingerprint with the scope's
 * current fingerprint — UNCHANGED when equal, otherwise CHANGED and the
 * change record adopts the new fingerprint.
 */
export function mergeScopeChanges(scope: ScopeRecord, _deviceId: string, change?: ScopeChange): void {
  const next = scopeFingerprint(scope);
  if (!change) return;
  if (change.fingerprint === next) {
    change.result = 'UNCHANGED';
    return;
  }
  change.result = 'CHANGED';
  change.fingerprint = next;
}
