import { createHash } from 'node:crypto';
/**
 * LocalTaskAccess — faithful port of Java `PersonalLocalTaskAccess`
 * (agent-code-runtime application/personalaccess/PersonalLocalTaskAccess.java).
 *
 * Owns every `/personal/v1/local-tasks/**` route through the single `remote()`
 * dispatcher, plus the inbox `signal()` reader and the owner-side catalog /
 * resource validation helpers. Upstreams are the registered worker-local
 * hosts (Java's fixed loopback origin; the gateway may front several — one
 * per engine — resolved by the path's `backend` storeId). Every `source()`
 * call pins the resolved host `/identity` storeId to the `backend` segment
 * before AND after the request — drift fails `LOCAL_SOURCE_IDENTITY_CHANGED` 409.
 *
 * Request ledger (Java `Request`, kinds local-launch/local-input/local-graphics):
 *   recordKey = `${deviceId}:${clientKey}`; sourceKey =
 *   `mobile-${sha256(namespace + ':' + deviceId + ':' + clientKey)}` where
 *   namespace = auth.ownerStatus().personalHostId. wire = deep copy of the
 *   request body with requestKey rewritten to sourceKey; the sourceKey also
 *   rides as the Idempotency-Key header upstream.
 *
 * Java wraps find+create+save+flights.add in `synchronized(auth)`. Node is
 * single-threaded: the ledger critical section below performs only
 * synchronous store calls between the last await and completion, so no other
 * task can interleave (same mutual-exclusion effect, documented deviation:
 * the re-authorize that Java performs inside the lock happens one microtask
 * earlier here — bounded drift, caught again by the revision checks).
 *
 * digest(body) = sha256(JSON.stringify(body)). Jackson's `body.toString()`
 * emits keys in parse order; JSON.parse→stringify preserves the same order,
 * so fingerprints match for wire-decoded bodies. Non-decoded synthetic bodies
 * could theoretically reorder keys — callers always pass the decoded body.
 */
import {
  exact,
  fail,
  GatewayError,
  hash,
  hashBytes,
  id,
  isRecord,
  permitsLaunch,
  text,
  type Device,
  type DeviceRequest,
  type LaunchScope,
  type Resource,
  type Signal,
  type SourceRead,
} from './protocol';
import { ref as clientRef, VERSION as CLIENT_ACCESS_VERSION } from './client-wire';
import type { ConnectionRowLite, RawResult } from './local-transport';
import { LocalTransportError } from './local-transport';
import type { GatewayAuth, GatewayStoreView } from './context';

type Json = Record<string, unknown>;
type MaybePromise<T> = T | Promise<T>;

// ---------------------------------------------------------------------------
// Narrow seams — the real Devices (auth), LocalTransport, GatewayStore satisfy
// these structurally; tests fake them. No import of store.ts/devices.ts.
// ---------------------------------------------------------------------------

/**
 * PersonalAccessService auth surface this class consumes — the narrow slice
 * of the fixed context.ts GatewayAuth contract (Devices satisfies both).
 */
export type LocalAuthLike = Pick<
  GatewayAuth,
  | 'authenticate' | 'authorizeLaunch' | 'authorizeLocal' | 'authorizeLocalDevice'
  | 'appendLaunchedTask' | 'ownerStatus' | 'activeDevice'
>;

/**
 * PersonalAccessStore seam: generic kind→payload store plus the synchronous
 * transaction() that emulates Java's synchronized(auth) ledger sections.
 */
export type LocalStoreLike = Pick<GatewayStoreView, 'get' | 'put' | 'list' | 'transaction'>;

/** LocalTransport seam (src/local-transport.ts satisfies it). */
export interface LocalTransportLike {
  workerLocal(): ConnectionRowLite;
  workerLocalRows(): ConnectionRowLite[];
  orderedWorkerLocalRows?(): ConnectionRowLite[];
  raw(
    connectionId: string, method: 'GET' | 'POST', tail: string,
    body?: unknown, key?: string, storeId?: string, deadlineMillis?: number,
  ): Promise<RawResult>;
  identity(connectionId: string, deadlineMillis?: number): Promise<string>;
}

export interface LocalResult {
  status: number;
  body: unknown;
}

const ROOT = '/personal/v1/local-tasks';
const LAUNCH = 'local-launch';
const INPUT = 'local-input';
const GRAPHICS = 'local-graphics';
const HISTORY_LIMIT = 128;
const REJECTED = new Set([400, 403, 409, 422, 428]);
const OFFICE_PROTOCOL = 'mac-native-capabilities/1';
const OFFICE_RECIPE = 'mac.native-work/1';
const WORKFLOW_RECIPE = 'mac.app-workflow/1';
const KINDS = ['NEEDS_INPUT', 'RESULT_READY', 'ATTENTION_REQUIRED'];
const RESULT_STATES = new Set(['SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT']);
const ATTENTION_REASONS = new Set(['RESTART_RECONCILIATION_REQUIRED', 'LOCAL_LAUNCH_INTERRUPTED']);

const asText = (v: unknown): string =>
  typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : '';
/** Jackson asBoolean(false): boolean, textual 'true', or non-zero number. */
const asBoolean = (v: unknown): boolean =>
  v === true || v === 'true' || (typeof v === 'number' && v !== 0);
/** Jackson for-each: array elements, object field VALUES, else empty. */
const iterate = (v: unknown): unknown[] =>
  Array.isArray(v) ? v : isRecord(v) ? Object.values(v) : [];
const isPresentNull = (v: Record<string, unknown>, field: string): boolean =>
  field in v && v[field] === null;
const deepCopy = <T>(v: T): T => structuredClone(v);
const deepEqual = (a: unknown, b: unknown): boolean => {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
  }
  const ka = Object.keys(a as Json), kb = Object.keys(b as Json);
  return ka.length === kb.length && ka.every((k) => k in (b as Json) && deepEqual((a as Json)[k], (b as Json)[k]));
};
/** IOException analogue: network-level failures only (see LocalTransportError). */
const isIo = (error: unknown): boolean =>
  error instanceof LocalTransportError || !(error instanceof GatewayError);

// Public NativeWorkSpec capability IDs, from ProductAgentMac.NativeWorkSpec.
const NATIVE_CAPABILITIES = new Set([
  'mac.files.list', 'mac.files.read', 'mac.files.write', 'mac.documents.extract',
  'mac.research.review', 'mac.research.engineering', 'mac.images.observe', 'mac.office.organize', 'mac.office.textedit',
  'mac.office.pages.report', 'mac.office.keynote.update', 'mac.finder.selection', 'mac.finder.reveal', 'mac.finder.tags',
  'mac.safari.context', 'mac.discovery.search', 'mac.discovery.watch', 'mac.shortcuts.run', 'mac.mcp.invoke',
]);
const METHOD_IDS = ['material-report', 'document-checklist', 'native-office'];
const METHOD_REVISIONS = ['1.0.0', '1.0.1', '1.0.2'];

/** Host create's exact wire keys plus NativeWorkSpec.validate's bounded semantics. */
function validateNativeWorkSpec(spec: unknown): void {
  function invalid(): never { throw new RangeError('office-spec'); }
  function bounded(v: unknown, bytes: number): string {
    if (typeof v !== 'string' || v.length < 1 || Buffer.byteLength(v, 'utf8') > bytes) invalid();
    return v;
  }
  function keys(v: unknown, allowed: string[]): asserts v is Json {
    if (!isRecord(v) || Object.keys(v).length !== allowed.length || allowed.some(key => !(key in v))) invalid();
  }
  if (!isRecord(spec)) invalid();
  const allowed = new Set(['schemaVersion', 'recipeID', 'workspaceRef', 'goal', 'engine', 'modelRef',
    'requiredCapabilities', 'acceptance', 'method', 'preferences', 'continuousIndex']);
  for (const key of Object.keys(spec)) if (!allowed.has(key)) invalid();
  if (spec.schemaVersion !== 'mac-native-work-spec/1' || spec.recipeID !== OFFICE_RECIPE) invalid();
  if (typeof spec.workspaceRef !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(spec.workspaceRef)) invalid();
  bounded(spec.goal, 16384);
  if (spec.engine !== 'EXTERNAL_TOOLS' && spec.engine !== 'OWNED_FRAMEWORK') invalid();
  if ('modelRef' in spec) bounded(spec.modelRef, 300);
  if (spec.engine === 'OWNED_FRAMEWORK' && typeof spec.modelRef !== 'string') invalid();
  const caps = spec.requiredCapabilities;
  if (!Array.isArray(caps) || caps.length < 1 || caps.length > NATIVE_CAPABILITIES.size) invalid();
  const seen = new Set<string>();
  for (const cap of caps) {
    if (typeof cap !== 'string' || !NATIVE_CAPABILITIES.has(cap) || seen.has(cap)) invalid();
    seen.add(cap);
  }
  if ((seen.has('mac.images.observe') || seen.has('mac.research.engineering')) && spec.engine !== 'OWNED_FRAMEWORK') invalid();
  if ('method' in spec) {
    const method = spec.method;
    keys(method, ['methodId', 'revision']);
    if (spec.engine !== 'OWNED_FRAMEWORK' || !METHOD_IDS.includes(asText(method.methodId))
        || !METHOD_REVISIONS.includes(asText(method.revision))) invalid();
  }
  if ('preferences' in spec) {
    if (spec.engine !== 'OWNED_FRAMEWORK' || !Array.isArray(spec.preferences) || spec.preferences.length > 8) invalid();
    const ids = new Set<string>();
    for (const preference of spec.preferences) {
      keys(preference, ['frameId', 'text', 'userConfirmed']);
      if (typeof preference.frameId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(preference.frameId)
          || ids.has(preference.frameId) || preference.userConfirmed !== true) invalid();
      if (bounded(preference.text, 2000).trim() === '') invalid();
      ids.add(preference.frameId);
    }
  }
  if ('continuousIndex' in spec) {
    const continuous = spec.continuousIndex;
    keys(continuous, ['maximumVersions', 'durationSeconds']);
    if (spec.engine !== 'EXTERNAL_TOOLS' || 'modelRef' in spec || 'method' in spec || 'preferences' in spec
        || !Number.isSafeInteger(continuous.maximumVersions) || (continuous.maximumVersions as number) < 1 || (continuous.maximumVersions as number) > 64
        || !Number.isSafeInteger(continuous.durationSeconds) || (continuous.durationSeconds as number) < 1 || (continuous.durationSeconds as number) > 1800
        || !['mac.files.list', 'mac.files.write', 'mac.office.organize'].every(cap => seen.has(cap))
        || caps.some(cap => !['mac.files.list', 'mac.files.read', 'mac.files.write', 'mac.office.organize'].includes(cap))) invalid();
  }
  const acceptance = spec.acceptance;
  if (!Array.isArray(acceptance) || acceptance.length < ('continuousIndex' in spec ? 0 : 1) || acceptance.length > 16) invalid();
  const names = new Set<string>();
  for (const item of acceptance) {
    keys(item, ['name', 'containsText']);
    if (typeof item.name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(item.name) || names.has(item.name)) invalid();
    bounded(item.containsText, 4096);
    names.add(item.name);
  }
}

// ---------------------------------------------------------------------------

export class LocalTaskAccess {
  private readonly flights = new Set<string>();
  private namespaceCache: string | undefined;
  /** Resolved storeId → connectionId routing table; rebuilt opportunistically. */
  private readonly connectionCache = new Map<string, string>();

  constructor(
    private readonly auth: LocalAuthLike,
    private readonly transport: LocalTransportLike,
    private readonly store: LocalStoreLike,
  ) {}

  // ---- store/ledger plumbing -------------------------------------------------

  private async namespace(): Promise<string> {
    if (this.namespaceCache === undefined) {
      const status = await this.auth.ownerStatus();
      this.namespaceCache = asText(status.personalHostId);
    }
    return this.namespaceCache;
  }

  private async sourceKey(did: string, clientKey: string): Promise<string> {
    return `mobile-${hash(`${await this.namespace()}:${did}:${clientKey}`)}`;
  }

  private static recordKey(did: string, key: string): string {
    return `${did}:${key}`;
  }

  private static digest(body: unknown): string {
    return hash(JSON.stringify(body));
  }

  private save(kind: string, request: DeviceRequest): void {
    this.store.put(kind, LocalTaskAccess.recordKey(request.deviceId, request.clientKey), request);
  }

  private find(kind: string, did: string, key: string): DeviceRequest | undefined {
    return this.store.get<DeviceRequest>(kind, LocalTaskAccess.recordKey(did, key));
  }

  private historyLimit(kind: string, did: string): void {
    const count = this.store.list<DeviceRequest>(kind).filter((r) => r.deviceId === did).length;
    if (count >= HISTORY_LIMIT) fail('LOCAL_REQUEST_HISTORY_LIMIT', 429);
  }

  // ---- transport ---------------------------------------------------------------

  /**
   * Resolve the registered worker-local row whose /identity storeId equals
   * expectedStore. Probes every candidate on a cache miss; an unreachable
   * candidate cannot mask a reachable match, and a matchless request reports
   * the first probe failure (or IDENTITY_CHANGED when every probe succeeded).
   */
  private async connectionForStore(expectedStore: string, deadlineMillis?: number): Promise<ConnectionRowLite> {
    const rows = this.transport.workerLocalRows();
    if (rows.length === 0) fail('LOCAL_SOURCE_UNAVAILABLE', 503);
    const cached = this.connectionCache.get(expectedStore);
    const ordered = cached === undefined ? rows
      : [...rows.filter((r) => r.connectionId === cached), ...rows.filter((r) => r.connectionId !== cached)];
    let firstFailure: unknown;
    for (const row of ordered) {
      let store: string;
      try {
        store = await this.transport.identity(row.connectionId, deadlineMillis);
      } catch (error) {
        firstFailure ??= error;
        continue;
      }
      if (row.connectionId === cached && store !== expectedStore) this.connectionCache.delete(expectedStore);
      this.connectionCache.set(store, row.connectionId);
      if (store === expectedStore) return row;
    }
    if (firstFailure !== undefined) throw firstFailure;
    fail('LOCAL_SOURCE_IDENTITY_CHANGED', 409);
  }

  /** Every reachable worker-local storeId (primary first); unreachable candidates are skipped. */
  private async identities(deadlineMillis?: number): Promise<{ connectionId: string; storeId: string }[]> {
    const rows = this.transport.orderedWorkerLocalRows?.() ?? this.transport.workerLocalRows();
    const out: { connectionId: string; storeId: string }[] = [];
    const seen = new Set<string>();
    for (const row of rows) {
      try {
        const storeId = await this.transport.identity(row.connectionId, deadlineMillis);
        // Two rows can point at one store (env config + self-registration) —
        // the catalog lists a backend once either way.
        if (seen.has(storeId)) continue;
        seen.add(storeId);
        this.connectionCache.set(storeId, row.connectionId);
        out.push({ connectionId: row.connectionId, storeId });
      } catch { /* an offline host stays out of catalogs; source() reports it on demand */ }
    }
    return out;
  }

  /** Java source(): identity pin to expectedStore before AND after raw(). */
  private async source(
    expectedStore: string,
    method: 'GET' | 'POST',
    tail: string,
    body?: unknown,
    key?: string,
    deadlineMillis?: number,
  ): Promise<RawResult> {
    const conn: ConnectionRowLite = await this.connectionForStore(expectedStore, deadlineMillis);
    const result = await this.transport.raw(conn.connectionId, method, tail, body, key, expectedStore, deadlineMillis);
    if (await this.transport.identity(conn.connectionId, deadlineMillis) !== expectedStore) {
      fail('LOCAL_SOURCE_IDENTITY_CHANGED', 409);
    }
    return result;
  }

  /** Java ok(): non-2xx propagates the source's own code, else LOCAL_SOURCE_UNAVAILABLE. */
  private ok(result: RawResult): Json {
    if (result.status < 200 || result.status >= 300) {
      const code = isRecord(result.data) && typeof result.data.code === 'string'
          && /^[A-Z][A-Z0-9_]{0,100}$/.test(result.data.code)
        ? result.data.code
        : 'LOCAL_SOURCE_UNAVAILABLE';
      fail(code, result.status);
    }
    return result.data as Json;
  }

  // ---- public view whitelists -----------------------------------------------------

  private static fields(value: unknown, names: string[]): Json {
    const out: Json = {};
    if (!isRecord(value)) return out;
    for (const name of names) if (name in value) out[name] = value[name];
    return out;
  }

  private visible(value: Json): Json {
    const out = deepCopy(value);
    for (const field of ['profileHome', 'workspace', 'command', 'executable', 'env', 'executablePath']) {
      delete out[field];
    }
    if ('macProfile' in out) out.macProfile = this.macProfile(out.macProfile);
    if ('graphicsProfile' in out) out.graphicsProfile = LocalTaskAccess.graphicsProfile(out.graphicsProfile);
    delete out.graphicsConfigurationDigest;
    if ('nativeWorkSpec' in out && out.nativeWorkSpec !== null) {
      try {
        validateNativeWorkSpec(out.nativeWorkSpec);
      } catch {
        fail('LOCAL_REPLY_INVALID', 502);
      }
    }
    return out;
  }

  /** Mac metadata is read-only; host filesystem locations are not a remote API. */
  private macProfile(value: unknown): Json {
    const out: Json = {};
    if (!isRecord(value)) return out;
    for (const field of ['productProfile', 'role', 'recipeID', 'environmentDigest', 'targetBindingDigest',
      'requiredPermissions', 'availability', 'reasonCode', 'remoteGraphicsEnabled', 'permissionQualification',
      'kind', 'protocolVersion', 'catalogDigest', 'engines']) {
      if (field in value) out[field] = value[field];
    }
    // NativeWork.preflight exposes these public values, never its model service
    // credentials, method instructions, workspace roots or runtime bindings.
    const publicText = (v: unknown, bytes: number): v is string => typeof v === 'string' && v.length > 0 && Buffer.byteLength(v, 'utf8') <= bytes;
    if (Array.isArray(value.models)) out.models = value.models.filter(row => isRecord(row)
      && publicText(row.modelRef, 300) && publicText(row.displayName, 512) && typeof row.imageInput === 'boolean')
      .map(row => LocalTaskAccess.fields(row, ['modelRef', 'displayName', 'imageInput']));
    const methodView = (method: unknown): Json | undefined => {
      if (!isRecord(method) || method.schemaVersion !== 'mac-method-binding/1'
          || !METHOD_IDS.includes(asText(method.methodId)) || !METHOD_REVISIONS.includes(asText(method.revision))
          || !publicText(method.displayName, 200) || typeof method.instructionsSHA256 !== 'string'
          || !/^[a-f0-9]{64}$/.test(method.instructionsSHA256)) return undefined;
      const expected = ['mac.files.list', 'mac.files.read', 'mac.files.write',
        ...(method.methodId === 'native-office' && method.revision !== '1.0.0' ? ['mac.office.textedit'] : [])];
      if (!deepEqual(method.requiredCapabilities, expected)) return undefined;
      return LocalTaskAccess.fields(method, ['schemaVersion', 'methodId', 'revision', 'displayName', 'requiredCapabilities', 'instructionsSHA256']);
    };
    if (Array.isArray(value.methods)) out.methods = value.methods.slice(0, 3).flatMap(method => { const view = methodView(method); return view ? [view] : []; });
    if (value.defaultMethod === null) out.defaultMethod = null;
    else { const view = methodView(value.defaultMethod); if (view) out.defaultMethod = view; }
    for (const field of ['nativeActionsAvailable', 'reviewAvailable', 'continuousIndexAvailable', 'memoryAvailable', 'engineeringAvailable']) {
      if (typeof value[field] === 'boolean') out[field] = value[field];
    }
    if (Array.isArray(value.optionalCapabilities)) out.optionalCapabilities = value.optionalCapabilities.filter(cap => typeof cap === 'string' && NATIVE_CAPABILITIES.has(cap));
    for (const field of ['runtimeDigest', 'reviewSourceDigest', 'extensionDigest', 'workspaceBinding']) {
      if (value[field] === null || typeof value[field] === 'string' && /^[a-f0-9]{64}$/.test(value[field] as string)) out[field] = value[field];
    }
    if ('graphicsProfile' in value) out.graphicsProfile = LocalTaskAccess.graphicsProfile(value.graphicsProfile);
    const groups: [string, string[]][] = [
      ['toolchain', ['toolchainVersion', 'xcodeVersion', 'sdk', 'platform']],
      ['device', ['deviceType', 'simulatorRuntime', 'allocationPolicy']],
      ['verificationTemplate', ['recipeID', 'scheme', 'configuration', 'simulatorRuntime', 'requiredTestIDs', 'requiredAssertionIDs', 'budget']],
    ];
    for (const [group, names] of groups) {
      const input = value[group];
      if (!isRecord(input)) continue;
      const child: Json = {};
      for (const field of names) if (field in input) child[field] = input[field];
      out[group] = child;
    }
    return out;
  }

  private static graphicsProfile(value: unknown): Json {
    return LocalTaskAccess.fields(value, ['id', 'displayName', 'bundleID', 'windowTitle', 'allowedActions', 'allowedElementIdentifiers']);
  }

  private preflightView(value: Json, project: string, engine: string): Json {
    const out = this.visible(value);
    if (engine !== 'macos') return out;
    if (value.engineId !== engine || value.projectId !== project || value.profileId !== 'MAC_MANAGED'
        || !isPresentNull(value, 'profileHome')
        || typeof value.loadsUserExtensions !== 'boolean' || value.loadsUserExtensions === true
        || typeof value.hasUncommittedChanges !== 'boolean') fail('LOCAL_PROFILE_NOT_SUPPORTED', 409);
    const meta = isRecord(value.macProfile) ? value.macProfile : {};
    const recipe = asText(meta.recipeID);
    if (recipe === OFFICE_RECIPE) {
      if (value.workingCopyPolicy !== 'TASK_OWNED_OUTPUT'
          || !isPresentNull(value, 'headRevision')
          || (('treeRevision' in value) && value.treeRevision !== null)
          || value.hasUncommittedChanges === true
          || meta.kind !== 'OFFICE_WORKSPACE'
          || meta.protocolVersion !== OFFICE_PROTOCOL
          || typeof meta.catalogDigest !== 'string' || !/^[a-f0-9]{64}$/.test(meta.catalogDigest)
          || !Array.isArray(meta.engines) || meta.engines.length === 0) {
        fail('LOCAL_PROFILE_NOT_SUPPORTED', 409);
      }
      for (const mode of meta.engines) {
        if (typeof mode !== 'string' || !['EXTERNAL_TOOLS', 'OWNED_FRAMEWORK'].includes(mode)) {
          fail('LOCAL_PROFILE_NOT_SUPPORTED', 409);
        }
      }
    } else if (recipe === WORKFLOW_RECIPE) {
      if (value.workingCopyPolicy !== 'REGISTERED_TARGET_ONLY'
          || !isPresentNull(value, 'headRevision')
          || !isPresentNull(value, 'treeRevision')
          || value.hasUncommittedChanges === true
          || typeof value.registryDigest !== 'string' || !/^[a-f0-9]{64}$/.test(value.registryDigest)
          || !isRecord(meta.graphicsProfile) || meta.graphicsProfile.id !== project) {
        fail('LOCAL_PROFILE_NOT_SUPPORTED', 409);
      }
    } else if (value.workingCopyPolicy !== 'COMMITTED_BASE_ONLY'
        || (recipe !== '' && recipe !== 'apple.verify-and-repair/1')) {
      fail('LOCAL_PROFILE_NOT_SUPPORTED', 409);
    }
    out.profileHome = null;
    return out;
  }

  private async remoteOffice(backend: string, preflight: Json): Promise<void> {
    const meta = isRecord(preflight.macProfile) ? preflight.macProfile : {};
    if (meta.recipeID !== OFFICE_RECIPE) return;
    const manifest = this.ok(await this.source(backend, 'GET', '/worker-host/v1/manifest'));
    const adopted = Array.isArray(manifest.contracts) && manifest.contracts.includes(OFFICE_PROTOCOL);
    if (!adopted) fail('LOCAL_SOURCE_UPGRADE_REQUIRED', 409);
  }

  private async remoteDocuments(backend: string, spec: Json): Promise<void> {
    const caps = spec.requiredCapabilities;
    const required = Array.isArray(caps) && caps.includes('mac.documents.extract');
    if (!required) return;
    const manifest = this.ok(await this.source(backend, 'GET', '/worker-host/v1/manifest'));
    const adopted = Array.isArray(manifest.contracts) && manifest.contracts.includes('mac-native-documents/1');
    if (!adopted) fail('LOCAL_SOURCE_UPGRADE_REQUIRED', 409);
  }

  private async remoteGraphics(backend: string, preflight: Json): Promise<void> {
    const meta = isRecord(preflight.macProfile) ? preflight.macProfile : {};
    if (!asBoolean(meta.remoteGraphicsEnabled)) fail('REMOTE_GRAPHICS_DISABLED', 403);
    const manifest = this.ok(await this.source(backend, 'GET', '/worker-host/v1/manifest'));
    const contract = Array.isArray(manifest.contracts) && manifest.contracts.includes('mac-graphics/1');
    if (!contract) fail('LOCAL_SOURCE_UPGRADE_REQUIRED', 409);
  }

  /** Reuse original launch intent for immutable engine ownership, incl. offline receipt reads. */
  async verifyTaskEngine(token: string, backend: string, task: string, engine: string): Promise<void> {
    const d = await this.auth.authorizeLocal(token, backend, task, 'OBSERVE');
    let known: string | undefined;
    for (const r of this.store.list<DeviceRequest>(LAUNCH)) {
      if (d.id === r.deviceId && backend === r.backendStoreId && task === r.taskId) {
        known = r.engineId;
        break;
      }
    }
    if (known === undefined) {
      const fact = this.ok(await this.source(backend, 'GET', `/tasks/${task}`));
      if (fact.taskId !== task) fail('LOCAL_BINDING_MISMATCH', 409);
      known = asText(fact.engineId);
    }
    if (engine !== known) fail('LOCAL_BINDING_MISMATCH', 409);
    await this.auth.authorizeLocal(token, backend, task, 'OBSERVE');
  }

  /** local-input ledger presence check for client-access input.respond. */
  async recordedInput(token: string, backend: string, task: string, key: string): Promise<boolean> {
    const d = await this.auth.authorizeLocal(token, backend, task, 'OBSERVE');
    const r = this.find(INPUT, d.id, key);
    if (r !== undefined && (r.taskId !== task || r.backendStoreId !== backend)) {
      fail('LOCAL_BINDING_MISMATCH', 409);
    }
    return r !== undefined;
  }

  private requestView(r: DeviceRequest): Json {
    const out: Json = {
      schemaVersion: 'personal-local-request/1',
      requestKey: r.clientKey,
      backendStoreId: r.backendStoreId,
      operation: r.operation,
      state: r.state,
    };
    if (r.operation?.startsWith('GRAPHICS_') || ['STOP','PAUSE','RESUME','CONTINUE'].includes(r.operation ?? '')) {
      out.sourceRequestKey = r.sourceKey;
    }
    if (r.taskId !== undefined) out.taskId = r.taskId;
    if (r.code !== undefined) out.code = r.code;
    if (r.result !== undefined && !r.operation?.startsWith('GRAPHICS_') && isRecord(r.result)) {
      out.source = this.visible(r.result);
    }
    return out;
  }

  /** One backend's registered public choices, never the native token or config paths. */
  private async backendCatalog(backend: string): Promise<Json> {
    const out: Json = { available: true, backendStoreId: backend, macAdoptionRevision: 'worker-host-mac-adoption/1.1.0' };
    const projectFeed = this.ok(await this.source(backend, 'GET', '/projects'));
    const projects: Json[] = [];
    for (const p of (Array.isArray(projectFeed.items) ? projectFeed.items : [])) {
      if (projects.length >= 100) break;
      const row = LocalTaskAccess.fields(p, ['projectId', 'displayName', 'headRevision', 'hasUncommittedChanges', 'profileId', 'availability', 'reasonCode', 'kind', 'recipeID']);
      if (isRecord(p) && 'graphicsProfile' in p) row.graphicsProfile = LocalTaskAccess.graphicsProfile(p.graphicsProfile);
      projects.push(row);
    }
    const engineFeed = this.ok(await this.source(backend, 'GET', '/engines'));
    const engines: Json[] = [];
    for (const e of (Array.isArray(engineFeed.items) ? engineFeed.items : [])) {
      if (engines.length >= 10) break;
      engines.push(LocalTaskAccess.fields(e, ['engineId', 'engineVersion', 'version', 'profileId', 'capabilities', 'available', 'availability', 'reasonCode', 'sourceKind']));
    }
    const tasks: Json[] = [];
    for (const request of this.store.list<DeviceRequest>(LAUNCH)) {
      if (tasks.length >= 100 || request.backendStoreId !== backend || request.taskId === undefined) continue;
      tasks.push({
        kind: 'WORKER_LOCAL', backendStoreId: backend, taskId: request.taskId,
        displayName: LocalTaskAccess.launchTitle(request),
      });
    }
    return { ...out, projects, engines, tasks };
  }

  /** Owner sees registered public choices — every reachable worker-local backend. */
  async ownerCatalog(): Promise<Json> {
    const backends = await this.identities();
    const catalogs: Json[] = [];
    for (const b of backends) {
      try { catalogs.push(await this.backendCatalog(b.storeId)); } catch { /* offline backend stays out */ }
    }
    if (catalogs.length === 0) fail('LOCAL_SOURCE_UNAVAILABLE', 503);
    // Keep the primary fields at the top level without mutating that same
    // entry inside backends; attaching the array to catalogs[0] creates a cycle.
    const out = { ...catalogs[0]! };
    if (catalogs.length > 1) out.backends = catalogs;
    return out;
  }

  async validateOwnerResources(resources: Resource[], launches: LaunchScope[]): Promise<void> {
    for (const r of resources) {
      if (r.kind !== 'WORKER_LOCAL') continue;
      const task = this.ok(await this.source(r.backendStoreId, 'GET', `/tasks/${r.taskId}`));
      if (task.taskId !== r.taskId) fail('LOCAL_BINDING_MISMATCH', 409);
    }
    for (const s of launches) {
      const preflight = this.ok(await this.source(
        s.backendStoreId, 'POST', '/task-preflights', { projectId: s.projectId, engineId: s.engineId }));
      this.preflightView(preflight, s.projectId, s.engineId);
    }
  }

  // ---- remote() — the single path dispatcher -----------------------------------------

  async remote(
    token: string,
    method: string,
    path: string,
    body: unknown,
    key: string | null,
    query: string | null,
  ): Promise<LocalResult> {
    const d = await this.auth.authenticate(token);
    if (path === ROOT && method === 'GET') {
      const requests = this.store.list<DeviceRequest>(LAUNCH);
      const resources: Json[] = [];
      for (const r of d.resources ?? []) {
        if (r.kind !== 'WORKER_LOCAL') continue;
        const ref: Json = { kind: r.kind, backendStoreId: r.backendStoreId };
        if (r.sessionId !== undefined) ref.sessionId = r.sessionId;
        if (r.taskId !== undefined) ref.taskId = r.taskId;
        for (const request of requests) {
          if (d.id === request.deviceId && r.backendStoreId === request.backendStoreId && r.taskId === request.taskId) {
            ref.displayName = LocalTaskAccess.launchTitle(request);
            break;
          }
        }
        resources.push(ref);
      }
      return { status: 200, body: { schemaVersion: 'personal-local-access/1', resources, launchScopes: d.launchScopes ?? [] } };
    }
    if (!path.startsWith(`${ROOT}/`)) fail('OPERATION_NOT_ALLOWED', 403);
    const p = path.substring(ROOT.length + 1).split('/');
    if (p.length < 2) fail('OPERATION_NOT_ALLOWED', 403);
    const backend = p[0]!;
    id(backend);
    for (let i = 2; i < p.length; i++) id(p[i]);
    const messagesPage = method === 'GET' && p.length === 4 && p[1] === 'tasks' && p[3] === 'messages';
    if (query !== null && query !== '') {
      if (messagesPage) LocalTaskAccess.validateMessagesQuery(query);
      else LocalTaskAccess.validateQuery(query);
    }

    if ((p.length === 5 || p.length === 6) && p[1] === 'workspaces' && p[3] === 'uploads') {
      return this.materialUpload(token, backend, p, method, body, key, query);
    }
    if (p[1] === 'tasks' && p[3] === 'uploads'
        && ((method === 'GET' && [4,5].includes(p.length)) || (method === 'POST' && (p.length === 4 || p.length === 6 && ['chunk','seal','cancel'].includes(p[5]!))))) {
      const task = p[2]!;
      const action = method === 'GET' ? 'OBSERVE' : 'INTERACT';
      await this.auth.authorizeLocal(token, backend, task, action);
      const manifest = this.ok(await this.source(backend,'GET','/worker-host/v1/manifest'));
      if (!Array.isArray(manifest.contracts) || !manifest.contracts.includes('mac-material-uploads/1')) fail('LOCAL_SOURCE_UPGRADE_REQUIRED',409);
      if ((p.length === 4 && method === 'GET' || p[5] === 'cancel') && !manifest.contracts.includes('mac-material-upload-lifecycle/1')) fail('LOCAL_SOURCE_UPGRADE_REQUIRED',409);
      const principal = createHash('sha256').update('material|' + d.id + '|' + String(d.revision)).digest('hex');
      let payload: unknown = undefined;
      if (method === 'POST') {
        if (!isRecord(body) || 'principal' in body || typeof body.requestKey !== 'string' || key !== body.requestKey) fail('INVALID_REQUEST',400);
        payload = { ...body, principal };
      }
      const tail = '/tasks/' + task + '/uploads' + (p.length > 4 ? '/' + p.slice(4).join('/') : '') + (method === 'GET' ? '?principal=' + principal : '');
      const result = this.ok(await this.source(backend, method as 'GET'|'POST', tail, payload, key ?? undefined));
      if (result.taskId !== task || result.storeId !== backend || result.principal !== principal || result.schemaVersion !== 'mac-material-upload/1') fail('LOCAL_BINDING_MISMATCH',409);
      const fresh = await this.auth.authorizeLocal(token,backend,task,action);
      if (fresh.revision !== d.revision) fail('GRANT_REVISION_CONFLICT',409);
      return { status:200, body: { ...result, backendStoreId:backend } };
    }
    if (p.length === 2 && p[1] === 'options' && method === 'GET') {
      if (!(d.actions ?? []).includes('LAUNCH')
          || !(d.launchScopes ?? []).some((s) => s.backendStoreId === backend)) {
        fail('DEVICE_SCOPE_DENIED', 403);
      }
      const catalog = await this.backendCatalog(backend);
      const allowedProjects = new Set<string>();
      const allowedEngines = new Set<string>();
      for (const scope of d.launchScopes ?? []) {
        if (scope.backendStoreId === backend) {
          allowedProjects.add(scope.projectId);
          allowedEngines.add(scope.engineId);
        }
      }
      catalog.projects = (catalog.projects as Json[]).filter(
        (item) => allowedProjects.has(asText(item.projectId)));
      catalog.engines = (catalog.engines as Json[]).filter(
        (item) => allowedEngines.has(asText(item.engineId)));
      catalog.launchScopes = (d.launchScopes ?? []).map((s) => ({ ...s }));
      const now = await this.auth.authenticate(token);
      if (d.revision !== now.revision) fail('GRANT_REVISION_CONFLICT', 409);
      return { status: 200, body: catalog };
    }

    if (p.length === 2 && p[1] === 'task-preflights' && method === 'POST') {
      const parsed = exact(body, 'projectId', 'engineId');
      const project = text(parsed, 'projectId');
      const engine = text(parsed, 'engineId');
      id(project);
      await this.auth.authorizeLaunch(token, backend, project, engine);
      const out = this.preflightView(
        this.ok(await this.source(backend, 'POST', '/task-preflights', parsed)), project, engine);
      out.backendStoreId = backend;
      await this.remoteOffice(backend, out);
      await this.auth.authorizeLaunch(token, backend, project, engine);
      return { status: 200, body: out };
    }

    if (p.length === 2 && p[1] === 'tasks' && method === 'POST') {
      return this.launch(token, backend, body, key);
    }
    if (p.length === 3 && p[1] === 'task-requests' && method === 'GET') {
      return this.recoverLaunch(token, backend, p[2]!);
    }

    if (p.length >= 3 && p[1] === 'tasks') {
      const task = p[2]!;
      await this.auth.authorizeLocal(token, backend, task, 'OBSERVE');
      if (p.length >= 4 && p[3] === 'graphics') {
        return this.graphics(token, backend, task, method, p, body, key, query);
      }
      if (method === 'GET') {
        if (p.length === 4 && p[3] === 'requests') fail('OPERATION_NOT_ALLOWED', 403);
        if (p.length === 5 && p[3] === 'requests') return this.recoverInput(token, backend, task, p[4]!);
        const chunkRead = p.length === 8 && p[3] === 'artifacts' && p[5] === 'chunks';
        const read = chunkRead || p.length === 3
          || (p.length === 4 && ['events', 'output', 'metrics', 'messages', 'input-requests', 'artifacts'].includes(p[3]!))
          || (p.length === 5 && p[3] === 'artifacts');
        if (!read) fail('OPERATION_NOT_ALLOWED', 403);
        let tail = `/tasks/${task}`;
        for (let i = 3; i < p.length; i++) tail += `/${p[i]}`;
        if (query !== null && query !== '') {
          if (p.length !== 4 || (p[3] !== 'events' && !messagesPage)) fail('INVALID_REQUEST', 400);
          tail += `?${query}`;
        }
        let graphicsArtifactRead = false;
        let graphicsPublicRead = false;
        if (p.length >= 4) {
          const fact = this.ok(await this.source(backend, 'GET', `/tasks/${task}`));
          if (fact.taskId !== task) fail('LOCAL_BINDING_MISMATCH', 409);
          graphicsPublicRead = fact.recipeID === WORKFLOW_RECIPE;
          if (graphicsPublicRead && p[3] === 'artifacts') {
            await this.authorizeGraphics(token, backend, task, 'GRAPHICS_CAPTURE');
            await this.graphicsBinding(token, backend, task, fact);
            graphicsArtifactRead = true;
          }
        }
        if (chunkRead && graphicsPublicRead) fail('OPERATION_NOT_ALLOWED', 403);
        const result = this.ok(await this.source(backend, 'GET', tail));
        if (chunkRead) await this.verifyArtifactChunk(backend, task, p[4]!, p[6]!, p[7]!, result);
        if (p.length === 3 && result.taskId !== task) fail('LOCAL_BINDING_MISMATCH', 409);
        let publicView: Json = (p.length === 3 && result.recipeID === WORKFLOW_RECIPE
          ? this.graphicsTaskView(result)
          : this.visible(result));
        publicView.backendStoreId = backend;
        if (graphicsPublicRead && !graphicsArtifactRead) {
          publicView = LocalTaskAccess.graphicsPublicRead(p[3]!, result);
          publicView.backendStoreId = backend;
        }
        if (messagesPage) {
          // Paging support belongs to this gateway, never to an upstream claim.
          delete publicView.messageTransportVersion;
          if (!graphicsPublicRead && result.messageSchemaVersion === 'native-messages/1') {
            publicView.messageTransportVersion = 'native-messages-page/1';
          }
        }
        if (p.length === 3 && result.recipeID === WORKFLOW_RECIPE) {
          publicView.graphicsAccess = await this.graphicsAccess(token, backend, task, result);
        }
        if (p.length === 3) {
          publicView.clientAccess = await this.nativeTaskProjection(
            token, backend, task, asText(result.engineId));
        }
        if (p.length === 5 && p[3] === 'artifacts') {
          await this.verifyArtifact(backend, task, p[4]!, result);
        }
        if (graphicsArtifactRead) {
          if (p.length === 5) {
            publicView = LocalTaskAccess.graphicsArtifact(result);
            publicView.backendStoreId = backend;
            for (const field of ['bytes', 'encoding']) {
              if (field in result) publicView[field] = result[field];
            }
          } else {
            const view = LocalTaskAccess.fields(result, ['bounded', 'coverage']);
            view.backendStoreId = backend;
            view.items = (Array.isArray(result.items) ? result.items : [])
              .map((item) => LocalTaskAccess.graphicsArtifact(item));
            publicView = view;
          }
          await this.authorizeGraphics(token, backend, task, 'GRAPHICS_CAPTURE');
        }
        await this.auth.authorizeLocal(token, backend, task, 'OBSERVE');
        return { status: 200, body: publicView };
      }
      if (method === 'POST'
          && ((p.length === 4 && (p[3] === 'commands' || p[3] === 'messages'))
            || (p.length === 6 && p[3] === 'input-requests' && p[5] === 'responses'))) {
        return this.input(token, backend, task, p, body, key);
      }
    }
    fail('OPERATION_NOT_ALLOWED', 403);
  }

  private async verifyArtifactChunk(backend: string, task: string, artifact: string, digest: string, rawOffset: string, result: Json): Promise<void> {
    const offset = Number(rawOffset);
    if (!/^file-[a-f0-9]{64}$/.test(artifact) || !/^[a-f0-9]{64}$/.test(digest)
        || !/^(0|[1-9][0-9]*)$/.test(rawOffset) || !Number.isSafeInteger(offset) || offset % 262144 !== 0
        || result.schemaVersion !== 'mac-artifact-chunk/1' || result.taskId !== task || result.artifactId !== artifact
        || result.sha256 !== digest || result.offset !== offset || result.encoding !== 'base64'
        || typeof result.bytes !== 'string' || result.bytes.length > 349528) fail('LOCAL_ARTIFACT_INVALID', 502);
    const encoded = result.bytes as string;
    if (encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) fail('LOCAL_ARTIFACT_INVALID', 502);
    const bytes = Buffer.from(encoded, 'base64');
    if (bytes.toString('base64') !== encoded || hashBytes(bytes) !== result.chunkSHA256) fail('LOCAL_ARTIFACT_CHANGED', 409);
    const listing = this.ok(await this.source(backend, 'GET', `/tasks/${task}/artifacts`));
    const item = (Array.isArray(listing.items) ? listing.items : []).filter(isRecord).find(row => row.artifactId === artifact);
    const size = Number(item?.sizeBytes ?? item?.size);
    if (!item || item.status !== 'AVAILABLE_CHUNKED' || item.transferMode !== 'CHUNKS_V1' || item.sha256 !== digest
        || !Number.isSafeInteger(size) || size < 524289 || size > 20971520 || offset >= size
        || result.sizeBytes !== String(size) || bytes.length !== Math.min(262144, size - offset)) fail('LOCAL_ARTIFACT_CHANGED', 409);
  }

  /** Verify bounded immutable native bytes against the task's published manifest. */
  private async verifyArtifact(backend: string, task: string, artifact: string, result: Json): Promise<void> {
    if (!/^file-[a-f0-9]{64}$/.test(artifact) || result.artifactId !== artifact
        || result.encoding !== 'base64' || typeof result.bytes !== 'string'
        || typeof result.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(result.sha256)) {
      fail('LOCAL_ARTIFACT_INVALID', 502);
    }
    const encoded = result.bytes;
    if (encoded.length > 699052) fail('LOCAL_RESPONSE_TOO_LARGE', 502);
    // Java Base64.getDecoder() is strict; Node's is lenient — pre-validate.
    if (encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)
        || encoded.indexOf('=') !== -1 && encoded.indexOf('=') < encoded.length - 2) {
      fail('LOCAL_ARTIFACT_INVALID', 502);
    }
    let bytes: Buffer;
    try {
      bytes = Buffer.from(encoded, 'base64');
    } catch {
      fail('LOCAL_ARTIFACT_INVALID', 502);
    }
    if (bytes!.length > 524288 || hashBytes(bytes!) !== result.sha256) fail('LOCAL_ARTIFACT_CHANGED', 409);
    const listing = this.ok(await this.source(backend, 'GET', `/tasks/${task}/artifacts`));
    const item = (Array.isArray(listing.items) ? listing.items : [])
      .filter(isRecord)
      .find((row) => row.artifactId === artifact);
    const asLong = (v: unknown): number =>
      typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v)
        : typeof v === 'string' && /^-?[0-9]+$/.test(v) ? Number(v) : -1;
    if (item === undefined || item.status !== 'AVAILABLE' || asText(item.path) !== asText(result.path)
        || asText(item.sha256) !== asText(result.sha256) || asLong(item.size) !== bytes!.length) {
      fail('LOCAL_ARTIFACT_CHANGED', 409);
    }
  }

  // ---- signal() — bounded current-state facts for the inbox scanner ---------------------

  /**
   * Java signal(): pending questions from /input-requests, attention from
   * state/reasonCode, results from the bounded public /output view — never
   * guessed from summary words. WORKER_LOCAL only.
   */
  async signal(device: Device, resource: Resource, deadlineMillis: number): Promise<SourceRead> {
    // Java checks only the kind; a missing taskId falls into DEVICE_SCOPE_DENIED.
    if (resource === null || resource.kind !== 'WORKER_LOCAL') {
      fail('INVALID_SCOPE', 400);
    }
    const backend = resource.backendStoreId;
    const taskId = resource.taskId as string;
    await this.auth.authorizeLocalDevice(device.id, backend, taskId, 'OBSERVE');
    const read: SourceRead = { signals: [], verifiedKinds: new Set(), coverage: 'CURRENT_STATE', truncated: false };
    const task = this.ok(await this.source(backend, 'GET', `/tasks/${taskId}`, undefined, undefined, deadlineMillis));
    if (task.taskId !== taskId) fail('LOCAL_BINDING_MISMATCH', 409);
    const state = asText(task.state).toUpperCase();
    const generation = asText(task.generation);
    const session = asText(task.nativeSessionId);
    const turn = asText(task.nativeTurnId);
    const command = asText(task.currentCommandId);
    const quiescent = asBoolean(task.quiescent);
    read.verifiedKinds.add('RESULT_READY');
    read.verifiedKinds.add('ATTENTION_REQUIRED');
    try {
      const requests = this.ok(await this.source(
        backend, 'GET', `/tasks/${taskId}/input-requests`, undefined, undefined, deadlineMillis));
      read.verifiedKinds.add('NEEDS_INPUT');
      const pending = (Array.isArray(requests.items) ? requests.items : [])
        .filter(isRecord)
        .filter((item) => item.state === 'PENDING' && typeof item.inputRequestId === 'string')
        .sort((a, b) => (a.inputRequestId as string).localeCompare(b.inputRequestId as string));
      for (const item of pending) {
        const question = item.inputRequestId as string;
        read.signals.push({
          kind: 'NEEDS_INPUT',
          eventKey: `input:${question}`,
          sourceRevision: [generation, turn, command, question].join('|'),
          coverage: 'CURRENT_STATE',
          subject: {
            type: 'INPUT_REQUEST',
            inputRequestId: question,
            generation,
            nativeSessionId: session,
            nativeTurnId: turn,
            targetCommandId: command,
          },
          title: LocalTaskAccess.title(asText(item.title), '待处理输入'),
        });
      }
    } catch { /* NEEDS_INPUT stays unverified this round */ }
    const reason = asText(task.reasonCode);
    if (state === 'FAILED' || ATTENTION_REASONS.has(reason)) {
      read.signals.push({
        kind: 'ATTENTION_REQUIRED',
        eventKey: `task:${taskId}`,
        sourceRevision: hash(`${state}|${reason}|${generation}|${turn}|${command}`),
        coverage: 'CURRENT_STATE',
        subject: {
          type: 'NATIVE_STATE',
          taskId,
          state,
          reasonCode: reason,
          generation,
          nativeSessionId: session,
          nativeTurnId: turn,
          currentCommandId: command,
          quiescent,
        },
        title: LocalTaskAccess.title(reason === '' ? state : reason, '需要注意'),
      });
    }
    if (RESULT_STATES.has(state) || quiescent) {
      try {
        const output = this.ok(await this.source(
          backend, 'GET', `/tasks/${taskId}/output`, undefined, undefined, deadlineMillis));
        const outputText = asText(output.text);
        if (outputText !== '') {
          read.signals.push({
            kind: 'RESULT_READY',
            eventKey: `output:${taskId}`,
            sourceRevision: hash(`${generation}|${turn}|${command}|${outputText}`),
            coverage: state === 'SUCCEEDED' && quiescent ? 'CURRENT_STATE' : 'PARTIAL_RESULT',
            subject: {
              type: 'NATIVE_TASK',
              taskId,
              state,
              generation,
              nativeSessionId: session,
              nativeTurnId: turn,
              currentCommandId: command,
            },
            title: LocalTaskAccess.title(outputText, '结果就绪'),
          });
        }
      } catch {
        read.verifiedKinds.delete('RESULT_READY');
      }
    }
    await this.auth.authorizeLocalDevice(device.id, backend, taskId, 'OBSERVE');
    return read;
  }

  private static title(value: string, fallback: string): string {
    const text = (value ?? '').trim().replace(/\s+/g, ' ');
    if (text === '') return fallback;
    return text.length > 120 ? text.substring(text.length - 120) : text;
  }

  private static launchTitle(r: DeviceRequest): string {
    const raw = r.wire === undefined || typeof r.wire.instruction !== 'string'
      ? '原生任务' : r.wire.instruction;
    const first = raw.split(/[\r\n]/, 2)[0]!;
    return first.substring(0, Math.min(first.length, 128));
  }

  private static validateQuery(query: string): void {
    const seen = new Set<string>();
    for (const item of query.split('&')) {
      const pair = item.split('=', 2);
      if (pair.length !== 2 || seen.has(pair[0]!)
          || !['cursor', 'limit'].includes(pair[0]!)
          || !/^(0|[1-9][0-9]{0,17})$/.test(pair[1]!)) fail('INVALID_REQUEST', 400);
      seen.add(pair[0]!);
      if (pair[0] === 'limit') {
        const limit = Number(pair[1]);
        if (limit < 1 || limit > 100) fail('INVALID_REQUEST', 400);
      }
    }
  }

  private static validateMessagesQuery(query: string): void {
    const seen = new Set<string>();
    for (const item of query.split('&')) {
      const pair = item.split('=');
      if (pair.length !== 2 || seen.has(pair[0]!)
          || !['cursor', 'before', 'limit'].includes(pair[0]!)
          || !/^(0|[1-9][0-9]{0,18})$/.test(pair[1]!)) fail('INVALID_REQUEST', 400);
      seen.add(pair[0]!);
      const value = BigInt(pair[1]!);
      if (value > 9223372036854775807n
          || pair[0] === 'before' && value === 0n
          || pair[0] === 'limit' && (value < 1n || value > 100n)) fail('INVALID_REQUEST', 400);
    }
    if (seen.has('cursor') && seen.has('before')) fail('INVALID_REQUEST', 400);
  }

  // ---- launch() / acceptLaunch() / recoverLaunch() ----------------------------------------

  private async launch(token: string, backend: string, body: unknown, key: string | null): Promise<LocalResult> {
    const office = isRecord(body) && 'nativeWorkSpec' in body;
    let parsed: Json;
    if (office) {
      parsed = exact(body, 'requestKey', 'projectId', 'engineId', 'optionsRevision', 'instruction', 'nativeWorkSpec');
      try {
        validateNativeWorkSpec(parsed.nativeWorkSpec);
      } catch {
        fail('INVALID_NATIVE_WORK_SPEC', 400);
      }
    } else {
      parsed = exact(body, 'requestKey', 'projectId', 'engineId', 'optionsRevision', 'instruction');
    }
    id(key);
    if (key !== text(parsed, 'requestKey')) fail('IDEMPOTENCY_KEY_MISMATCH', 400);
    if (office && Buffer.byteLength(JSON.stringify(parsed), 'utf8') > 65536) {
      fail('NATIVE_WORK_REQUEST_TOO_LARGE', 413);
    }
    const project = text(parsed, 'projectId');
    const engine = text(parsed, 'engineId');
    id(project);
    if (office && engine !== 'macos') fail('LOCAL_PROFILE_NOT_SUPPORTED', 409);
    const instruction = parsed.instruction;
    if (typeof instruction !== 'string' || instruction.trim() === ''
        || Buffer.byteLength(instruction, 'utf8') > 16384) fail('INVALID_INSTRUCTION', 400);
    text(parsed, 'optionsRevision');
    let device = await this.auth.authorizeLaunch(token, backend, project, engine);
    const fingerprint = LocalTaskAccess.digest(parsed);

    if (engine === 'macos' && this.find(LAUNCH, device.id, key!) === undefined) {
      const preflight = this.ok(await this.source(
        backend, 'POST', '/task-preflights', { projectId: project, engineId: engine }));
      const recipe = asText(isRecord(preflight.macProfile) ? preflight.macProfile.recipeID : '');
      if (recipe === OFFICE_RECIPE) {
        this.preflightView(preflight, project, engine);
        await this.remoteOffice(backend, preflight);
        const spec = parsed.nativeWorkSpec;
        if (!office || !isRecord(spec) || spec.workspaceRef !== project
            || spec.goal !== instruction || parsed.optionsRevision !== preflight.optionsRevision) {
          fail('INVALID_NATIVE_WORK_SPEC', 400);
        }
        const engines = isRecord(preflight.macProfile) && Array.isArray(preflight.macProfile.engines)
          ? preflight.macProfile.engines : [];
        if (!engines.some((supported) => supported === spec.engine)) fail('LOCAL_PROFILE_NOT_SUPPORTED', 409);
        await this.remoteDocuments(backend, spec);
      } else if (office) {
        fail('LOCAL_PROFILE_NOT_SUPPORTED', 409);
      } else if (recipe === WORKFLOW_RECIPE) {
        this.preflightView(preflight, project, engine);
        await this.remoteGraphics(backend, preflight);
      } else if (recipe !== '' && recipe !== 'apple.verify-and-repair/1') {
        fail('LOCAL_PROFILE_NOT_SUPPORTED', 409);
      }
    }

    // Java synchronized(auth): re-authorize + find-or-create + DISPATCHED + flight.
    // Awaits happen before the transaction; the section below is synchronous.
    device = await this.auth.authorizeLaunch(token, backend, project, engine);
    const sourceKey = await this.sourceKey(device.id, key!);
    const [request, recover] = this.store.transaction((): [DeviceRequest, boolean] => {
      let record = this.find(LAUNCH, device.id, key!);
      if (record !== undefined) {
        if (fingerprint !== record.hash || backend !== record.backendStoreId) {
          fail('IDEMPOTENCY_PAYLOAD_MISMATCH', 409);
        }
      } else {
        this.historyLimit(LAUNCH, device.id);
        const wire = deepCopy(parsed);
        wire.requestKey = sourceKey;
        if (office && Buffer.byteLength(JSON.stringify(wire), 'utf8') > 65536) {
          fail('NATIVE_WORK_REQUEST_TOO_LARGE', 413);
        }
        record = {
          deviceId: device.id, clientKey: key!, sourceKey, backendStoreId: backend,
          projectId: project, engineId: engine, operation: 'LAUNCH', hash: fingerprint,
          grantRevision: device.revision, wire, state: 'SAVED',
        };
        this.save(LAUNCH, record);
      }
      const recovering = record.state !== 'SAVED';
      if (!recovering) {
        if (device.revision !== record.grantRevision) fail('GRANT_REVISION_CONFLICT', 409);
        record.state = 'DISPATCHED';
        this.save(LAUNCH, record);
        this.flights.add(`launch:${LocalTaskAccess.recordKey(device.id, key!)}`);
      }
      return [record, recovering];
    });
    if (recover) return this.recoverLaunch(token, backend, key!);
    try {
      const reply = await this.source(backend, 'POST', '/tasks', request.wire, request.sourceKey);
      await this.acceptLaunch(request, reply);
    } catch (error) {
      if (isIo(error)) {
        request.state = 'UNKNOWN';
        request.code = 'LOCAL_REPLY_UNCONFIRMED';
        this.save(LAUNCH, request);
      } else if (error instanceof GatewayError) {
        request.code = error.code;
        request.state = request.taskId !== undefined ? 'ACCEPTED_OWNER_ONLY' : 'UNKNOWN';
        this.save(LAUNCH, request);
        if (request.taskId !== undefined || error.httpStatus === 401) throw error;
      } else {
        throw error;
      }
    } finally {
      this.flights.delete(`launch:${LocalTaskAccess.recordKey(request.deviceId, request.clientKey)}`);
    }
    return this.launchView(token, request);
  }

  private async acceptLaunch(r: DeviceRequest, reply: RawResult): Promise<void> {
    if (reply.status < 200 || reply.status >= 300) {
      r.code = isRecord(reply.data) && typeof reply.data.code === 'string'
        ? reply.data.code : 'LOCAL_SOURCE_UNAVAILABLE';
      r.state = REJECTED.has(reply.status) ? 'REJECTED' : 'UNKNOWN';
      this.save(LAUNCH, r);
      return;
    }
    const data = reply.data;
    if (!isRecord(data)) fail('LOCAL_REPLY_INVALID', 502);
    const task = asText(data.taskId);
    id(task);
    if (!task.startsWith('native-') || r.engineId !== asText(data.engineId)) {
      fail('LOCAL_BINDING_MISMATCH', 409);
    }
    if (r.engineId === 'macos' && data.profileId !== 'MAC_MANAGED') fail('LOCAL_PROFILE_NOT_SUPPORTED', 409);
    r.taskId = task;
    r.result = data;
    r.state = 'ACCEPTED_OWNER_ONLY';
    this.save(LAUNCH, r);
    await this.auth.appendLaunchedTask(r.deviceId, r.grantRevision, r.backendStoreId!, r.projectId!, r.engineId!, task);
    r.state = 'OBSERVED';
    r.code = undefined;
    this.save(LAUNCH, r);
  }

  private async launchView(token: string, r: DeviceRequest): Promise<LocalResult> {
    if (r.taskId !== undefined) {
      await this.auth.authorizeLocal(token, r.backendStoreId!, r.taskId, 'OBSERVE');
    } else {
      await this.auth.authorizeLaunch(token, r.backendStoreId!, r.projectId!, r.engineId!);
    }
    return { status: 200, body: this.requestView(r) };
  }

  private async recoverLaunch(token: string, backend: string, key: string): Promise<LocalResult> {
    // Java synchronized(auth): authenticate + find + flight dedup.
    const device = await this.auth.authenticate(token);
    const flight = `launch:${LocalTaskAccess.recordKey(device.id, key)}`;
    const r = this.store.transaction((): DeviceRequest | undefined => {
      const record = this.find(LAUNCH, device.id, key);
      if (record === undefined || record.backendStoreId !== backend) fail('NOT_FOUND', 404);
      if (!this.flights.add(flight)) return undefined;
      return record;
    });
    if (r === undefined) {
      return this.launchView(token, this.find(LAUNCH, device.id, key)!);
    }
    try {
      if (r.taskId !== undefined) {
        const view = await this.launchView(token, r);
        if (r.state === 'ACCEPTED_OWNER_ONLY') {
          r.state = 'OBSERVED';
          this.save(LAUNCH, r);
          return this.launchView(token, r);
        }
        return view;
      }
      await this.auth.authorizeLaunch(token, backend, r.projectId!, r.engineId!);
      if (r.state !== 'SAVED' && r.state !== 'REJECTED') {
        try {
          const result = await this.source(backend, 'GET', `/task-requests/${r.sourceKey}`);
          if (result.status === 200) {
            await this.acceptLaunch(r, result);
          } else if (result.status !== 404) {
            r.code = isRecord(result.data) && typeof result.data.code === 'string'
              ? result.data.code : 'LOCAL_REPLY_UNCONFIRMED';
          }
        } catch (error) {
          if (!isIo(error)) throw error;
          r.code = 'LOCAL_REPLY_UNCONFIRMED';
        }
      }
      this.save(LAUNCH, r);
      return this.launchView(token, r);
    } finally {
      this.flights.delete(flight);
    }
  }

  /** Java materialUpload(): workspace uploads remain source-owned. Every lookup
   * and chunk rechecks the same device launch scope and grant revision; a
   * public key never becomes a cross-device Host locator. Only sealed source
   * bytes enter future preflight. */
  private async materialUpload(
    token: string, backend: string, p: string[], method: string,
    body: unknown, key: string | null, query: string | null,
  ): Promise<LocalResult> {
    if (query !== null && query !== '') fail('INVALID_REQUEST', 400);
    const project = p[2]!;
    const clientKey = p[4]!;
    id(project);
    id(clientKey);
    const begin = p.length === 5 && method === 'POST';
    const read = p.length === 5 && method === 'GET';
    const chunk = p.length === 6 && p[5] === 'chunks' && method === 'POST';
    const seal = p.length === 6 && p[5] === 'seal' && method === 'POST';
    if (!begin && !read && !chunk && !seal) fail('OPERATION_NOT_ALLOWED', 403);
    const device = await this.auth.authorizeLaunch(token, backend, project, 'macos');
    const revision = device.revision;
    const sourceKey = 'upload-' + hash(
      `${await this.namespace()}|${device.id}|${revision}|${backend}|${project}|${clientKey}`);
    if (!read && !isRecord(body)) fail('INVALID_REQUEST', 400);
    const parsed = body as Json;
    const suffix = begin ? '-begin' : chunk ? `-chunk-${asText(parsed.offset)}` : '-seal';
    let wire: Json | undefined;
    if (!read) {
      if (begin) {
        exact(parsed, 'requestKey', 'name', 'sizeBytes', 'sha256');
        const name = text(parsed, 'name');
        const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : '';
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(name)
            || !['txt', 'md', 'pdf', 'docx', 'rtf', 'csv', 'json', 'png', 'jpg', 'jpeg'].includes(ext)) {
          fail('INVALID_MATERIAL', 400);
        }
        if (typeof parsed.sizeBytes !== 'number' || !Number.isInteger(parsed.sizeBytes)
            || parsed.sizeBytes <= 0 || parsed.sizeBytes > 20971520
            || !/^[a-f0-9]{64}$/.test(asText(parsed.sha256))) fail('INVALID_MATERIAL', 400);
      } else if (chunk) {
        exact(parsed, 'requestKey', 'offset', 'sha256', 'dataBase64');
        const encoded = parsed.dataBase64;
        if (typeof parsed.offset !== 'number' || !Number.isInteger(parsed.offset)
            || parsed.offset < 0 || parsed.offset >= 20971520
            || !/^[a-f0-9]{64}$/.test(asText(parsed.sha256))
            || typeof encoded !== 'string' || encoded.length > 349528
            || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) {
          fail('INVALID_MATERIAL_CHUNK', 400);
        }
        const bytes = Buffer.from(encoded, 'base64');
        if (bytes.length === 0 || bytes.length > 262144
            || hashBytes(bytes) !== asText(parsed.sha256)) fail('INVALID_MATERIAL_CHUNK', 400);
      } else {
        exact(parsed, 'requestKey');
      }
      if (key !== clientKey + suffix || parsed.requestKey !== key) {
        fail('IDEMPOTENCY_KEY_MISMATCH', 400);
      }
      wire = deepCopy(parsed);
      wire.requestKey = sourceKey + suffix;
    }
    const route = `/native/v1/workspaces/${project}/uploads/${sourceKey}`
      + (chunk ? '/chunks' : seal ? '/seal' : '');
    const reply = this.ok(await this.source(
      backend, method as 'GET' | 'POST', route, wire, read ? undefined : sourceKey + suffix));
    const replySize = reply.sizeBytes;
    const replyOffset = reply.nextOffset;
    if (reply.schemaVersion !== 'mac-material-upload/1' || reply.uploadKey !== sourceKey
        || reply.workspaceRef !== project
        || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(asText(reply.name))
        || !/^[a-f0-9]{64}$/.test(asText(reply.sha256))
        || typeof replySize !== 'number' || !Number.isInteger(replySize)
        || replySize <= 0 || replySize > 20971520
        || typeof replyOffset !== 'number' || !Number.isInteger(replyOffset)
        || replyOffset < 0 || replyOffset > replySize
        || !['OPEN', 'SEALED'].includes(asText(reply.state))
        || (reply.state === 'SEALED' && replyOffset !== replySize)) {
      fail('LOCAL_REPLY_INVALID', 502);
    }
    if (begin && (reply.name !== parsed.name || reply.sizeBytes !== parsed.sizeBytes
        || reply.sha256 !== parsed.sha256)) fail('LOCAL_BINDING_MISMATCH', 409);
    const after = await this.auth.authorizeLaunch(token, backend, project, 'macos');
    if (after.revision !== revision) fail('GRANT_REVISION_CONFLICT', 409);
    return {
      status: 200,
      body: {
        ...LocalTaskAccess.fields(
          reply, ['schemaVersion', 'workspaceRef', 'name', 'sizeBytes', 'sha256', 'nextOffset', 'state']),
        uploadKey: clientKey,
        backendStoreId: backend,
      },
    };
  }

  // ---- input() / recoverInput() -----------------------------------------------------------

  private async input(
    token: string, backend: string, task: string, p: string[], body: unknown, key: string | null,
  ): Promise<LocalResult> {
    const stop = p.length === 4 && p[3] === 'commands';
    const response = p.length === 6;
    const parsed = exact(body,
      ...(stop ? ['requestKey', 'intent', 'generation', 'nativeSessionId', 'nativeTurnId', 'targetCommandId', 'sealedUploadKeys']
        : response ? ['requestKey', 'response', 'generation', 'nativeSessionId', 'nativeTurnId', 'targetCommandId']
        : ['requestKey', 'kind', 'content', 'generation', 'nativeSessionId', 'nativeTurnId', 'targetCommandId']));
    id(key);
    if (key !== text(parsed, 'requestKey')) fail('IDEMPOTENCY_KEY_MISMATCH', 400);
    const operation = stop ? text(parsed, 'intent') : response ? 'INPUT_RESPONSE' : text(parsed, 'kind');
    const action = stop ? 'CONTROL' : response ? 'APPROVE' : 'INTERACT';
    if ((stop && !['STOP', 'PAUSE', 'RESUME', 'CONTINUE'].includes(operation))
        || (!stop && !response && !['NATIVE_STEER', 'NATIVE_FOLLOW_UP'].includes(operation))) {
      fail('OPERATION_NOT_ALLOWED', 403);
    }
    if ('sealedUploadKeys' in parsed
        && (!stop || operation !== 'CONTINUE' || !Array.isArray(parsed.sealedUploadKeys)
            || parsed.sealedUploadKeys.length === 0 || parsed.sealedUploadKeys.length > 8)) {
      fail('INVALID_REQUEST', 400);
    }
    if ('sealedUploadKeys' in parsed) {
      const seen = new Set<string>();
      for (const item of parsed.sealedUploadKeys as unknown[]) {
        if (typeof item !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,89}$/.test(item)
            || seen.has(item)) fail('INVALID_REQUEST', 400);
        seen.add(item);
      }
    }
    id(text(parsed, 'generation'));
    id(text(parsed, 'targetCommandId'));
    text(parsed, 'nativeSessionId');
    if ('nativeTurnId' in parsed) text(parsed, 'nativeTurnId');
    if (!stop && !response) {
      const content = parsed.content;
      if (typeof content !== 'string' || content.trim() === ''
          || Buffer.byteLength(content, 'utf8') > 16384) fail('INVALID_REQUEST', 400);
    }
    if (response) {
      const answer = exact(parsed.response, 'confirmed', 'value', 'decision', 'text');
      if (Object.keys(answer).length !== 1) fail('INVALID_REQUEST', 400);
      if ('confirmed' in answer && typeof answer.confirmed !== 'boolean') fail('INVALID_REQUEST', 400);
      if ('value' in answer) text(answer, 'value');
      if ('decision' in answer) text(answer, 'decision');
      if ('text' in answer) {
        const value = text(answer, 'text');
        if (!value.trim() || Buffer.byteLength(value,'utf8') > 8192) fail('INVALID_REQUEST',400);
      }
    }
    let device = await this.auth.authorizeLocal(token, backend, task, action);
    const fingerprint = `${LocalTaskAccess.digest(parsed)}:${operation}:${response ? p[4] : ''}`;
    const mappedBody = deepCopy(parsed);
    let materialProject: string | undefined;
    let materialRevision = device.revision;

    // Guard/capability checks run only for a never-seen client key.
    if (this.find(INPUT, device.id, key!) === undefined) {
      if (response && isRecord(parsed.response) && 'text' in parsed.response) {
        const manifest = this.ok(await this.source(backend,'GET','/worker-host/v1/manifest'));
        if (!Array.isArray(manifest.contracts) || !manifest.contracts.includes('mac-native-input/1')) fail('LOCAL_SOURCE_UPGRADE_REQUIRED',409);
      }
      const facts = this.ok(await this.source(backend, 'GET', `/tasks/${task}`));
      if (facts.taskId !== task) fail('LOCAL_BINDING_MISMATCH', 409);
      for (const field of ['generation', 'nativeSessionId', 'nativeTurnId', 'targetCommandId']) {
        const sourceField = field === 'targetCommandId' ? 'currentCommandId' : field;
        const bodyValue = field in parsed && parsed[field] !== null ? asText(parsed[field]) : null;
        const factValue = sourceField in facts && facts[sourceField] !== null ? asText(facts[sourceField]) : null;
        if (bodyValue !== factValue) fail('NATIVE_TARGET_CHANGED', 409);
      }
      if (!response) {
        const capability = stop ? operation.toLowerCase() : operation === 'NATIVE_STEER' ? 'steer' : 'followUp';
        const caps = isRecord(facts.capabilities) ? facts.capabilities : {};
        if (!asBoolean(caps[capability])) fail('NATIVE_ACTION_UNSUPPORTED', 409);
      }
      if ('sealedUploadKeys' in parsed) {
        if (facts.recipeID !== 'mac.native-work/1'
            || (isRecord(facts.nativeWorkSpec) ? asText(facts.nativeWorkSpec.engine) : '') !== 'OWNED_FRAMEWORK'
            || facts.state !== 'PAUSED_MATERIALS' || !asBoolean(facts.materialPauseReady)
            || !asBoolean(facts.quiescent) || asBoolean(facts.runtimeActive ?? true)) {
          fail('MATERIAL_PAUSE_REQUIRED', 409);
        }
        materialProject = text(facts, 'projectId');
        id(materialProject);
        const uploadDevice = await this.auth.authorizeLaunch(token, backend, materialProject, 'macos');
        materialRevision = uploadDevice.revision;
        if (uploadDevice.id !== device.id) fail('LOCAL_BINDING_MISMATCH', 409);
        const mapped: string[] = [];
        for (const item of parsed.sealedUploadKeys as string[]) {
          const upload = 'upload-' + hash(
            `${await this.namespace()}|${device.id}|${materialRevision}|${backend}|${materialProject}|${item}`);
          const sealed = this.ok(await this.source(
            backend, 'GET', `/native/v1/workspaces/${materialProject}/uploads/${upload}`));
          if (sealed.schemaVersion !== 'mac-material-upload/1' || sealed.state !== 'SEALED'
              || sealed.uploadKey !== upload || sealed.workspaceRef !== materialProject) {
            fail('MATERIAL_UPLOAD_UNCONFIRMED', 409);
          }
          mapped.push(upload);
        }
        const launchAgain = await this.auth.authorizeLaunch(token, backend, materialProject, 'macos');
        const controlAgain = await this.auth.authorizeLocal(token, backend, task, 'CONTROL');
        if (launchAgain.revision !== materialRevision || controlAgain.revision !== materialRevision) {
          fail('GRANT_REVISION_CONFLICT', 409);
        }
        mappedBody.sealedUploadKeys = mapped;
      }
      if (response) {
        const requests = this.ok(await this.source(backend, 'GET', `/tasks/${task}/input-requests`));
        const pending = (Array.isArray(requests.items) ? requests.items : [])
          .filter(isRecord)
          .some((q) => q.inputRequestId === p[4] && q.state === 'PENDING' && (!(isRecord(parsed.response) && 'text' in parsed.response) || ['input','editor'].includes(asText(q.method))));
        if (!pending) fail('NATIVE_INPUT_EXPIRED', 409);
      }
    }

    // Java synchronized(auth): re-authorize + find-or-create + DISPATCHED + flight.
    // Java re-authorizes launch inside the lock; here the re-check runs one
    // microtask earlier (documented deviation — see class header).
    device = await this.auth.authorizeLocal(token, backend, task, action);
    const launchCheck = 'sealedUploadKeys' in parsed && materialProject !== undefined
      ? await this.auth.authorizeLaunch(token, backend, materialProject, 'macos')
      : undefined;
    const sourceKey = await this.sourceKey(device.id, key!);
    const [r, recover] = this.store.transaction((): [DeviceRequest, boolean] => {
      const existing = this.find(INPUT, device.id, key!);
      if (existing !== undefined) {
        if (fingerprint !== existing.hash || existing.taskId !== task || existing.backendStoreId !== backend) {
          fail('IDEMPOTENCY_PAYLOAD_MISMATCH', 409);
        }
        return [existing, true];
      }
      if ('sealedUploadKeys' in parsed
          && (device.revision !== materialRevision || launchCheck!.revision !== materialRevision)) {
        fail('GRANT_REVISION_CONFLICT', 409);
      }
      this.historyLimit(INPUT, device.id);
      const wire = deepCopy(mappedBody);
      wire.requestKey = sourceKey;
      const created: DeviceRequest = {
        deviceId: device.id, clientKey: key!, sourceKey, backendStoreId: backend,
        taskId: task, projectId: materialProject, operation, hash: fingerprint,
        grantRevision: device.revision, wire, state: 'DISPATCHED',
      };
      this.save(INPUT, created);
      this.flights.add(`input:${LocalTaskAccess.recordKey(device.id, key!)}`);
      return [created, false];
    });
    if (recover) return this.recoverInput(token, backend, task, key!);

    const tail = `/tasks/${task}${stop ? '/commands' : response ? `/input-requests/${p[4]}/responses` : '/messages'}`;
    try {
      const reply = await this.source(backend, 'POST', tail, r.wire, r.sourceKey);
      r.result = reply.data;
      r.state = reply.status >= 200 && reply.status < 300 ? 'OBSERVED'
        : REJECTED.has(reply.status) ? 'REJECTED' : 'UNKNOWN';
      if (reply.status >= 400) {
        r.code = isRecord(reply.data) && typeof reply.data.code === 'string'
          ? reply.data.code : 'LOCAL_REPLY_UNCONFIRMED';
      }
    } catch (error) {
      if (isIo(error)) {
        r.state = 'UNKNOWN';
        r.code = 'LOCAL_REPLY_UNCONFIRMED';
      } else if (error instanceof GatewayError) {
        r.state = 'UNKNOWN';
        r.code = error.code;
      } else {
        throw error;
      }
    } finally {
      this.save(INPUT, r);
      this.flights.delete(`input:${LocalTaskAccess.recordKey(r.deviceId, r.clientKey)}`);
    }
    const finalDevice = await this.auth.authorizeLocal(token, backend, task, action);
    if ('sealedUploadKeys' in parsed
        && (finalDevice.revision !== materialRevision
            || (await this.auth.authorizeLaunch(token, backend, r.projectId!, 'macos')).revision
                !== materialRevision)) {
      fail('GRANT_REVISION_CONFLICT', 409);
    }
    return { status: 200, body: this.requestView(r) };
  }

  private async recoverInput(token: string, backend: string, task: string, key: string): Promise<LocalResult> {
    // Java synchronized(auth): authorize + find + flight dedup.
    const device = await this.auth.authorizeLocal(token, backend, task, 'OBSERVE');
    const flight = `input:${LocalTaskAccess.recordKey(device.id, key)}`;
    const r = this.store.transaction((): DeviceRequest | undefined => {
      const record = this.find(INPUT, device.id, key);
      if (record === undefined || record.taskId !== task || record.backendStoreId !== backend) fail('NOT_FOUND', 404);
      if (!this.flights.add(flight)) return undefined;
      return record;
    });
    if (r === undefined) {
      return { status: 200, body: this.requestView(this.find(INPUT, device.id, key)!) };
    }
    try {
      if (r.state !== 'REJECTED') {
        try {
          const result = await this.source(backend, 'GET', `/tasks/${task}/interaction-requests/${r.sourceKey}`);
          if (result.status === 200) {
            r.result = result.data;
            r.state = 'OBSERVED';
            r.code = undefined;
          } else if (result.status !== 404) {
            r.code = isRecord(result.data) && typeof result.data.code === 'string'
              ? result.data.code : 'LOCAL_REPLY_UNCONFIRMED';
          }
        } catch (error) {
          if (!isIo(error)) throw error;
          r.code = 'LOCAL_REPLY_UNCONFIRMED';
        }
      }
      this.save(INPUT, r);
      await this.auth.authorizeLocal(token, backend, task, 'OBSERVE');
      return { status: 200, body: this.requestView(r) };
    } finally {
      this.flights.delete(flight);
    }
  }

  // ---- graphics() route family -------------------------------------------------------------

  private async authorizeGraphics(token: string, backend: string, task: string, action: string): Promise<Device> {
    await this.auth.authorizeLocal(token, backend, task, 'OBSERVE');
    if (action === 'GRAPHICS_ACT') {
      await this.auth.authorizeLocal(token, backend, task, 'CONTROL');
    }
    return this.auth.authorizeLocal(token, backend, task, action);
  }

  /** Re-evaluate optional payload privileges even for recovered original receipts. */
  private async graphicsRequestView(token: string, r: DeviceRequest): Promise<Json> {
    const device = await this.authorizeGraphics(token, r.backendStoreId!, r.taskId!, r.operation!);
    const out = this.requestView(r);
    if (r.result !== undefined && isRecord(r.result)) {
      out.source = LocalTaskAccess.graphicsView(
        r.result,
        (device.actions ?? []).includes('GRAPHICS_OBSERVE'),
        (device.actions ?? []).includes('GRAPHICS_CAPTURE'));
    }
    return out;
  }

  private static graphicsView(value: unknown, observe: boolean, capture: boolean): Json {
    const out = LocalTaskAccess.fields(value, ['schemaVersion', 'requestKey', 'taskId', 'state', 'actionId',
      'operation', 'targetGuard', 'outcome', 'reasonCode', 'code', 'revision', 'generation',
      'nativeSessionId', 'segmentId', 'ownerEpoch', 'observedAt', 'bounded', 'coverage']);
    if (!isRecord(value)) return out;
    if ('targetGuard' in value) {
      out.targetGuard = LocalTaskAccess.fields(value.targetGuard, ['generation', 'nativeSessionId', 'segmentId', 'ownerEpoch']);
    }
    if ('target' in value) out.target = LocalTaskAccess.fields(value.target, ['bundleID', 'windowID']);
    if (observe && 'elements' in value) {
      out.elements = iterate(value.elements).map(
        (item) => LocalTaskAccess.fields(item, ['identifier', 'role', 'value', 'canSetValue', 'canPress']));
    }
    if ('items' in value) {
      out.items = iterate(value.items).map((item) => LocalTaskAccess.graphicsView(item, observe, capture));
    }
    if (isRecord(value.result)) {
      const result = LocalTaskAccess.fields(value.result, ['outcome', 'reasonCode']);
      if ('observation' in value.result) {
        result.observation = LocalTaskAccess.graphicsView(value.result.observation, observe, capture);
      }
      if (capture && 'artifact' in value.result) {
        result.artifact = LocalTaskAccess.graphicsArtifact(value.result.artifact);
      }
      out.result = result;
    }
    return out;
  }

  /** Graphics host public task feeds contain status only. */
  private static graphicsPublicRead(route: string, value: Json): Json {
    const out = LocalTaskAccess.fields(value,
      route === 'output' ? ['text', 'coverage']
        : route === 'metrics' ? ['cost', 'costCoverage', 'usageCoverage']
        : ['coverage', 'bounded', 'cursor', 'cursorExpired']);
    if ('items' in value) {
      out.items = iterate(value.items).map(
        (item) => LocalTaskAccess.fields(item, ['taskId', 'kind', 'state', 'inputRequestId', 'requestKey',
          'actionId', 'outcome', 'reasonCode', 'occurredAt', 'createdAt', 'sequence', 'cursor',
          'generation', 'nativeSessionId', 'segmentId', 'ownerEpoch']));
    }
    return out;
  }

  private static graphicsArtifact(value: unknown): Json {
    const out = LocalTaskAccess.fields(value, ['artifactId', 'status', 'size', 'sha256', 'mediaType',
      'mimeType', 'width', 'height', 'observationRevision', 'segmentId', 'ownerEpoch', 'capturedAt']);
    if (isRecord(value) && 'target' in value) {
      out.target = LocalTaskAccess.fields(value.target, ['bundleID', 'windowID']);
    }
    return out;
  }

  private graphicsTaskView(value: Json): Json {
    const out = LocalTaskAccess.fields(value, ['taskId', 'projectId', 'engineId', 'engineVersion', 'profileId',
      'recipeID', 'generation', 'nativeSessionId', 'nativeTurnId', 'currentCommandId', 'segmentId',
      'ownerEpoch', 'state', 'reasonCode', 'quiescent', 'localQuiescent', 'remoteStopConfirmed',
      'intakeClosed', 'createdAt', 'updatedAt', 'optionsRevision', 'graphicsObservationRevision',
      'graphicsObservationValid', 'storeId', 'bootId']);
    if ('graphicsProfile' in value) out.graphicsProfile = LocalTaskAccess.graphicsProfile(value.graphicsProfile);
    if ('capabilities' in value) {
      out.capabilities = LocalTaskAccess.fields(value.capabilities, ['stop', 'pause', 'resume', 'steer', 'followUp']);
    }
    return out;
  }

  private async graphicsAccess(token: string, backend: string, task: string, fact: Json): Promise<Json> {
    const d = await this.auth.authorizeLocal(token, backend, task, 'OBSERVE');
    const out: Json = { protocolVersion: 'mac-graphics/1' };
    let enabled = false;
    try {
      await this.graphicsBinding(token, backend, task, fact);
      enabled = true;
    } catch (denied) {
      if (denied instanceof GatewayError) out.reasonCode = denied.code;
      else throw denied;
    }
    const actions = d.actions ?? [];
    out.observe = enabled && actions.includes('GRAPHICS_OBSERVE');
    out.capture = enabled && actions.includes('GRAPHICS_CAPTURE');
    out.act = enabled && actions.includes('GRAPHICS_ACT') && actions.includes('CONTROL');
    return out;
  }

  private async graphicsBinding(token: string, backend: string, task: string, fact: Json): Promise<Json> {
    const d = await this.auth.authorizeLocal(token, backend, task, 'OBSERVE');
    const project = asText(fact.projectId);
    if (fact.taskId !== task || fact.engineId !== 'macos' || fact.recipeID !== WORKFLOW_RECIPE) {
      fail('LOCAL_PROFILE_NOT_SUPPORTED', 409);
    }
    if (!permitsLaunch(d, backend, project, 'macos')) fail('DEVICE_SCOPE_DENIED', 403);
    const preflight = this.preflightView(
      this.ok(await this.source(backend, 'POST', '/task-preflights', { projectId: project, engineId: 'macos' })),
      project, 'macos');
    const meta = isRecord(preflight.macProfile) ? preflight.macProfile : {};
    if (meta.recipeID !== WORKFLOW_RECIPE
        || !deepEqual(LocalTaskAccess.graphicsProfile(fact.graphicsProfile), meta.graphicsProfile)) {
      fail('LOCAL_BINDING_MISMATCH', 409);
    }
    await this.remoteGraphics(backend, preflight);
    return preflight;
  }

  private async graphics(
    token: string, backend: string, task: string, method: string,
    p: string[], body: unknown, key: string | null, query: string | null,
  ): Promise<LocalResult> {
    if (query !== null && query !== '') fail('INVALID_REQUEST', 400);
    if (method === 'GET' && p.length === 6 && p[4] === 'requests') {
      return this.recoverGraphics(token, backend, task, p[5]!);
    }
    if (method === 'GET' && p.length === 5 && p[4] === 'observations') {
      const before = await this.authorizeGraphics(token, backend, task, 'GRAPHICS_OBSERVE');
      const facts = this.ok(await this.source(backend, 'GET', `/tasks/${task}`));
      await this.graphicsBinding(token, backend, task, facts);
      const result = this.ok(await this.source(backend, 'GET', `/tasks/${task}/graphics/observations`));
      const after = await this.authorizeGraphics(token, backend, task, 'GRAPHICS_OBSERVE');
      if (before.revision !== after.revision) fail('GRANT_REVISION_CONFLICT', 409);
      return { status: 200, body: LocalTaskAccess.graphicsView(result, true, (after.actions ?? []).includes('GRAPHICS_CAPTURE')) };
    }
    if (method !== 'POST' || p.length !== 5 || !['observe', 'capture', 'actions'].includes(p[4]!)) {
      fail('OPERATION_NOT_ALLOWED', 403);
    }
    const route = p[4]!;
    const action = route === 'observe' ? 'GRAPHICS_OBSERVE' : route === 'capture' ? 'GRAPHICS_CAPTURE' : 'GRAPHICS_ACT';
    const parsed = exact(body,
      ...(route === 'observe' ? ['requestKey', 'guard']
        : route === 'capture' ? ['requestKey', 'guard', 'observationRevision']
        : ['requestKey', 'guard', 'observationRevision', 'action', 'elementIdentifier', 'value']));
    id(key);
    if (key !== text(parsed, 'requestKey')) fail('IDEMPOTENCY_KEY_MISMATCH', 400);
    const guard = exact(parsed.guard, 'generation', 'nativeSessionId', 'segmentId', 'ownerEpoch');
    if (Object.keys(guard).length !== 4) fail('INVALID_REQUEST', 400);
    for (const field of ['generation', 'nativeSessionId', 'segmentId', 'ownerEpoch']) {
      id(text(guard, field));
    }
    if (route !== 'observe') {
      const revision = text(parsed, 'observationRevision');
      if (revision.length > 128) fail('INVALID_REQUEST', 400);
    }
    if (route === 'actions') {
      const operation = text(parsed, 'action');
      if (!['setValue', 'press'].includes(operation)) fail('OPERATION_NOT_ALLOWED', 403);
      text(parsed, 'elementIdentifier');
      if (operation === 'setValue') {
        const value = parsed.value;
        if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > 4096) fail('INVALID_REQUEST', 400);
      } else if ('value' in parsed) {
        fail('INVALID_REQUEST', 400);
      }
    }
    const device = await this.authorizeGraphics(token, backend, task, action);
    const fingerprint = `${LocalTaskAccess.digest(parsed)}:${route}`;
    const previous = this.find(GRAPHICS, device.id, key!);
    if (previous !== undefined) {
      if (fingerprint !== previous.hash || previous.taskId !== task || previous.backendStoreId !== backend) {
        fail('IDEMPOTENCY_PAYLOAD_MISMATCH', 409);
      }
      return this.recoverGraphics(token, backend, task, key!);
    }
    const facts = this.ok(await this.source(backend, 'GET', `/tasks/${task}`));
    const preflight = await this.graphicsBinding(token, backend, task, facts);
    for (const field of ['generation', 'nativeSessionId', 'segmentId', 'ownerEpoch']) {
      if (!deepEqual(guard[field], facts[field])) fail('NATIVE_TARGET_CHANGED', 409);
    }
    if (route !== 'observe'
        && (!asBoolean(facts.graphicsObservationValid)
          || !deepEqual(parsed.observationRevision, facts.graphicsObservationRevision))) {
      fail('NATIVE_TARGET_CHANGED', 409);
    }
    if (route === 'actions') {
      const meta = isRecord(preflight.macProfile) ? preflight.macProfile : {};
      const profile = isRecord(meta.graphicsProfile) ? meta.graphicsProfile : {};
      const elements = Array.isArray(profile.allowedElementIdentifiers) ? profile.allowedElementIdentifiers : [];
      if (!elements.some((element) => deepEqual(element, parsed.elementIdentifier))) {
        fail('DEVICE_SCOPE_DENIED', 403);
      }
      const actions = Array.isArray(profile.allowedActions) ? profile.allowedActions : [];
      if (!actions.some((op) => deepEqual(op, parsed.action))) {
        fail('DEVICE_SCOPE_DENIED', 403);
      }
    }
    // Java synchronized(auth): re-authorize + revision + find-or-create + flight.
    const now = await this.authorizeGraphics(token, backend, task, action);
    if (now.revision !== device.revision) fail('GRANT_REVISION_CONFLICT', 409);
    const sourceKey = await this.sourceKey(device.id, key!);
    const r = this.store.transaction((): DeviceRequest | 'replay' => {
      const existing = this.find(GRAPHICS, device.id, key!);
      if (existing !== undefined) {
        if (fingerprint !== existing.hash || existing.taskId !== task || existing.backendStoreId !== backend) {
          fail('IDEMPOTENCY_PAYLOAD_MISMATCH', 409);
        }
        return 'replay';
      }
      this.historyLimit(GRAPHICS, device.id);
      const wire = deepCopy(parsed);
      wire.requestKey = sourceKey;
      const created: DeviceRequest = {
        deviceId: device.id, clientKey: key!, sourceKey, backendStoreId: backend,
        taskId: task, projectId: asText(facts.projectId), engineId: 'macos',
        operation: action, hash: fingerprint, grantRevision: device.revision,
        targetScope: preflight, wire, state: 'DISPATCHED',
      };
      this.save(GRAPHICS, created);
      this.flights.add(`graphics:${LocalTaskAccess.recordKey(device.id, key!)}`);
      return created;
    });
    if (r === 'replay') {
      const existing = this.find(GRAPHICS, device.id, key!)!;
      return { status: 200, body: await this.graphicsRequestView(token, existing) };
    }
    try {
      const reply = await this.source(backend, 'POST', `/tasks/${task}/graphics/${route}`, r.wire, r.sourceKey);
      this.acceptGraphics(r, reply);
    } catch (error) {
      if (isIo(error)) {
        r.state = 'UNKNOWN';
        r.code = 'LOCAL_REPLY_UNCONFIRMED';
      } else if (error instanceof GatewayError) {
        r.state = 'UNKNOWN';
        r.code = error.code;
      } else {
        throw error;
      }
    } finally {
      this.save(GRAPHICS, r);
      this.flights.delete(`graphics:${LocalTaskAccess.recordKey(device.id, key!)}`);
    }
    const after = await this.authorizeGraphics(token, backend, task, action);
    if (after.revision !== r.grantRevision) fail('GRANT_REVISION_CONFLICT', 409);
    return { status: 200, body: await this.graphicsRequestView(token, r) };
  }

  private acceptGraphics(r: DeviceRequest, reply: RawResult): void {
    if (reply.status >= 200 && reply.status < 300) {
      const data = isRecord(reply.data) ? reply.data : {};
      if (data.requestKey !== r.sourceKey || data.taskId !== r.taskId) fail('LOCAL_BINDING_MISMATCH', 409);
      r.result = reply.data;
      r.state = 'OBSERVED';
      r.code = undefined;
    } else {
      r.state = REJECTED.has(reply.status) ? 'REJECTED' : 'UNKNOWN';
      r.code = isRecord(reply.data) && typeof reply.data.code === 'string'
        ? reply.data.code : 'LOCAL_REPLY_UNCONFIRMED';
    }
  }

  private async recoverGraphics(token: string, backend: string, task: string, key: string): Promise<LocalResult> {
    const device = await this.auth.authorizeLocal(token, backend, task, 'OBSERVE');
    const r = this.find(GRAPHICS, device.id, key);
    if (r === undefined || r.taskId !== task || r.backendStoreId !== backend) fail('NOT_FOUND', 404);
    await this.authorizeGraphics(token, backend, task, r.operation!);
    if (!permitsLaunch(device, backend, asText(r.projectId), 'macos')) fail('DEVICE_SCOPE_DENIED', 403);
    await this.remoteGraphics(backend, isRecord(r.targetScope) ? r.targetScope : {});
    const flight = `graphics:${LocalTaskAccess.recordKey(device.id, key)}`;
    if (!this.store.transaction(() => this.flights.add(flight))) {
      return { status: 200, body: await this.graphicsRequestView(token, r) };
    }
    try {
      if (r.state !== 'REJECTED') {
        try {
          const reply = await this.source(backend, 'GET', `/tasks/${task}/interaction-requests/${r.sourceKey}`);
          if (reply.status === 200) this.acceptGraphics(r, reply);
          else if (reply.status !== 404) {
            r.code = isRecord(reply.data) && typeof reply.data.code === 'string'
              ? reply.data.code : 'LOCAL_REPLY_UNCONFIRMED';
          }
        } catch (error) {
          if (!isIo(error)) throw error;
          r.code = 'LOCAL_REPLY_UNCONFIRMED';
        }
      }
      this.save(GRAPHICS, r);
      const after = await this.authorizeGraphics(token, backend, task, r.operation!);
      if (device.revision !== after.revision) fail('GRANT_REVISION_CONFLICT', 409);
      return { status: 200, body: await this.graphicsRequestView(token, r) };
    } finally {
      this.flights.delete(flight);
    }
  }

  // ---- clientAccess projection (ClientAccessService.nativeTaskProjection) --------------------

  /**
   * Java nativeTaskProjection(): the phone's client-access binding for this
   * task — {protocolVersion, storeId, agentRef, conversationRef}. Native side
   * degrades per Java's own guards (authorizeLocal + verifyTaskEngine).
   */
  private async nativeTaskProjection(
    token: string, backend: string, task: string, engine: string,
  ): Promise<Json> {
    const status = await this.auth.ownerStatus();
    const store = asText(status.storeId);
    const location: Json = {
      sourceKind: 'WORKER_NATIVE', storeId: store,
      backendStoreId: backend, engineId: engine, taskId: task,
    };
    const before = await this.auth.authenticate(token);
    // ClientAccessService.authorize for a native location: scope + engine pin.
    await this.auth.authorizeLocal(token, backend, task, 'OBSERVE');
    await this.verifyTaskEngine(token, backend, task, engine);
    const agent: Json = {
      sourceKind: 'WORKER_NATIVE', storeId: store,
      backendStoreId: backend, engineId: engine,
    };
    const out: Json = {
      protocolVersion: CLIENT_ACCESS_VERSION,
      storeId: store,
      agentRef: clientRef('a1', agent),
      conversationRef: clientRef('c1', location),
    };
    const after = await this.auth.authenticate(token);
    if (after.revision !== before.revision) fail('GRANT_REVISION_CHANGED', 409);
    return out;
  }
}
