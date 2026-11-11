/**
 * Fixed upstream leaf adapters (PAE task §8 items 3/4).
 *
 * Two upstream families, both loopback-only:
 *
 * - ACS / CORE_LOCAL connections are consumed through the published
 *   `ServiceClient` surface (projects, session-preflight, build-plan,
 *   environment features, MCP, attention, deliveries, client-sessions).
 *   build-plan endpoints are resolver dry-runs upstream — plan previews never
 *   install or mark an environment READY.
 * - DAEMON connections are consumed through the worker managed-environment
 *   channel `/env/v1` (P0 freeze §3, RelxRunner-style loopback+bearer). Only
 *   this channel can drive PREPARE/CLEANUP/RETIRE, so the three joint
 *   capabilities stay OFF for CORE_LOCAL and ACS_DIRECT — a local launcher is
 *   not advertised as a daemon, and a direct ACS session never gains Docker
 *   install rights.
 *
 * Secrets never leave the server: connections carry `tokenRef`/`envTokenRef`
 * names resolved through `SecretResolver` (env-var indirection fed by the
 * central env helper at boot); only the ref strings persist in the registry.
 */
import { randomUUID } from 'node:crypto';
import {
  ServiceClient,
  ServiceProblem,
  type ClientSessionRegistrationResponse,
} from '../../../codeagent-desktop/packages/service-client/src/index';
import type { PersonalConnectionKind } from '../../../codeagent-desktop/packages/protocol/src/personal';
import { supportedNativeEngine, type NativeHostDiscovery } from '../../../codeagent-desktop/packages/protocol/src/native-task';
import { canonicalDigest, canonicalJson } from './canonical';
import { ManagementError, invalid } from './errors';
import type { ConnectionRow, ProjectRow, ConnectionRegistry } from './connection';

/** Loopback-origin guard identical in spirit to worker-control.ts. */
export function loopbackOrigin(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Personal management upstreams require an HTTP loopback origin');
  }
  return url.origin;
}

export type SecretResolver = (ref: string) => string | undefined;

/** Resolve `env:NAME` (or a bare env var name) without persisting the value. */
export function envSecretResolver(ref: string): string | undefined {
  const name = ref.startsWith('env:') ? ref.slice(4) : ref;
  const value = process.env[name];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export interface ConnectionProvision {
  connectionId: string;
  kind: PersonalConnectionKind;
  displayName?: string;
  /** ServiceClient origin for CORE_LOCAL / ACS_DIRECT (loopback http). */
  baseUrl?: string;
  tokenRef?: string;
  /** Worker `/env/v1` channel origin for DAEMON (loopback http). */
  envBaseUrl?: string;
  envTokenRef?: string;
}

// ---------------------------------------------------------------------------
// Worker managed-environment channel client (freeze §3). Fixed routes only;
// GETs are read-only and never trigger installs, pulls or probes upstream.
// ---------------------------------------------------------------------------

export interface EnvProblem extends Error {
  status: number;
  code: string;
  retryable?: boolean;
  reasonCode?: string;
}

function envProblem(status: number, payload: unknown, fallback: string): EnvProblem {
  const body = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? payload as Record<string, unknown> : {};
  const code = typeof body.code === 'string' && body.code ? body.code : 'UPSTREAM_ERROR';
  const message = typeof body.message === 'string' && body.message ? body.message : fallback;
  const err = new Error(message) as EnvProblem;
  err.status = status;
  err.code = code;
  err.retryable = typeof body.retryable === 'boolean' ? body.retryable : undefined;
  err.reasonCode = typeof body.reasonCode === 'string' ? body.reasonCode : undefined;
  return err;
}

export interface WorkerEnvClientOptions {
  baseUrl: string;
  token: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export class WorkerEnvClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: WorkerEnvClientOptions) {
    this.baseUrl = loopbackOrigin(options.baseUrl);
    this.token = options.token;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 20_000;
  }

  private async request<T>(method: 'GET' | 'POST', path: string,
      body?: object, requestKey?: string): Promise<{ status: number; data: T }> {
    const headers: Record<string, string> = { authorization: `Bearer ${this.token}` };
    let payload: string | undefined;
    if (method === 'POST') {
      headers['content-type'] = 'application/json';
      payload = JSON.stringify(body ?? {});
      headers['idempotency-key'] = requestKey
        ?? (body && typeof (body as Record<string, unknown>).requestKey === 'string'
          ? (body as Record<string, unknown>).requestKey as string
          : randomUUID());
    }
    const response = await this.fetchImpl(new URL(path, this.baseUrl), {
      method, headers, body: payload, signal: AbortSignal.timeout(this.timeoutMs),
    });
    const text = await response.text();
    let data: unknown = {};
    if (text.length) {
      try { data = JSON.parse(text); }
      catch { throw envProblem(response.status, {}, 'env channel returned a non-JSON body'); }
    }
    if (!response.ok) throw envProblem(response.status, data, `env channel HTTP ${response.status}`);
    return { status: response.status, data: data as T };
  }

  /** Read-only project metadata inspection (freeze §3; never installs). */
  async inspectProject(request: { projectRef: string; configRevision?: string }):
      Promise<Record<string, unknown>> {
    const { data } = await this.request<Record<string, unknown>>('POST', '/env/v1/projects:inspect', request);
    return data;
  }

  /** Plan production; always sent with dryRun so nothing is reserved. */
  async planEnvironment(intent: Record<string, unknown>, dryRun = true):
      Promise<Record<string, unknown>> {
    const { data } = await this.request<Record<string, unknown>>('POST', '/env/v1/environment-plans', { ...intent, dryRun });
    return data;
  }

  async startOperation(request: {
    requestKey: string; bodyDigest: string; kind: string;
    planDigest?: string; environmentId?: string; environmentRevision?: string;
    projectRef?: string;
  }): Promise<{ operationId: string; state: string }> {
    const { data } = await this.request<{ operationId?: string; state?: string }>(
      'POST', '/env/v1/environment-operations', request, request.requestKey);
    if (typeof data.operationId !== 'string' || typeof data.state !== 'string') {
      throw envProblem(502, {}, 'env channel returned a malformed operation acceptance');
    }
    return { operationId: data.operationId, state: data.state };
  }

  async getOperation(operationId: string): Promise<Record<string, unknown>> {
    const { data } = await this.request<Record<string, unknown>>('GET', `/env/v1/environment-operations/${encodeURIComponent(operationId)}`);
    return data;
  }

  async getOperationByRequestKey(requestKey: string): Promise<Record<string, unknown>> {
    const { data } = await this.request<Record<string, unknown>>('GET',
      `/env/v1/environment-operations?requestKey=${encodeURIComponent(requestKey)}`);
    return data;
  }

  async getOperationEvents(operationId: string, query: { cursor?: string; limit?: number } = {}):
      Promise<Record<string, unknown>> {
    const params = new URLSearchParams();
    if (query.cursor) params.set('cursor', query.cursor);
    if (query.limit !== undefined) params.set('limit', String(query.limit));
    const tail = params.size ? `?${params}` : '';
    const { data } = await this.request<Record<string, unknown>>('GET',
      `/env/v1/environment-operations/${encodeURIComponent(operationId)}/events${tail}`);
    return data;
  }

  async cancelOperation(operationId: string, request: { requestKey: string; expectedRevision?: string }):
      Promise<Record<string, unknown>> {
    const { data } = await this.request<Record<string, unknown>>('POST',
      `/env/v1/environment-operations/${encodeURIComponent(operationId)}/cancel`, request, request.requestKey);
    return data;
  }

  /** NEEDS_INPUT continuation (freeze §2 environment-operation-input/v1). */
  async submitOperationInput(operationId: string, command: {
    inputRequestId: string; operationId: string; expectedRevision?: string;
    commandKey: string; payload: unknown; payloadDigest: string;
  }): Promise<Record<string, unknown>> {
    const { data } = await this.request<Record<string, unknown>>('POST',
      `/env/v1/environment-operations/${encodeURIComponent(operationId)}/inputs`, command, command.commandKey);
    return data;
  }

  /** READY list for a projectRef (read-only; never rebuilds or probes). */
  async listEnvironments(projectRef: string): Promise<Record<string, unknown>> {
    const { data } = await this.request<Record<string, unknown>>('GET',
      `/env/v1/environments?projectRef=${encodeURIComponent(projectRef)}`);
    return data;
  }

  /** Reachability probe: a 404 on a bogus operation still proves the channel. */
  async probe(): Promise<{ reachable: boolean; detail?: string }> {
    try {
      await this.getOperation('p5-probe-nonexistent');
      return { reachable: true };
    } catch (error) {
      const e = error as EnvProblem;
      if (typeof e.status === 'number' && e.status > 0 && e.status !== 502) {
        return { reachable: true, detail: e.code };
      }
      return { reachable: false, detail: e.code };
    }
  }
}

// ---------------------------------------------------------------------------
// Connection hub: resolves registered rows into ready clients.
// ---------------------------------------------------------------------------

export interface AcsSessionHandle {
  storeId?: string;
  bootId?: string;
  checkedAt?: number;
  clientSessionId: string;
  /** Service-side client session token; stays server-side, never rendered. */
  token: string;
}

/** Fixed ACS owner routes used by the desktop management surface.
 *
 * Notification configuration remains authoritative in ACS.  The desktop
 * gateway only forwards the small owner controls and never accepts an
 * endpoint, topic, or credential from the browser.
 */
export type PersonalAccessOwnerOperation = 'capabilities' | 'devices' | 'pairing-requests' | 'invitations' | 'decide' | 'revoke' | 'scope'
  | 'notification-provider' | 'notification-provider-update' | 'notification-routes'
  | 'notification-route' | 'notification-route-update' | 'notification-subscription';

export interface ConnectionHandle {
  row: ConnectionRow;
  kind: PersonalConnectionKind;
  /** ServiceClient bound to a browser session's upstream client session. */
  acs(session?: AcsSessionHandle): ServiceClient;
  /** Register a Service-side client session for a browser tab (upstream). */
  openAcsSession(registrationKey: string, clientId: string, processInstanceId: string):
      Promise<ClientSessionRegistrationResponse>;
  revokeAcsSession(clientSessionId: string): Promise<void>;
  /** Worker env/v1 client (DAEMON only). */
  env(): WorkerEnvClient;
  personalAccess(session: AcsSessionHandle, operation: PersonalAccessOwnerOperation,
    body?: Record<string, unknown>, id?: string): Promise<unknown>;
  hasAcs(): boolean;
  hasEnv(): boolean;
}

const TIMEOUT = 20_000;

/** Open body handle returned by ConnectionHub.localStream — the caller owns
 * the stream (cancel/abort) and must not wrap it in the JSON envelope. */
export interface LocalStreamResponse {
  status: number;
  headers: Headers;
  body: ReadableStream<Uint8Array>;
}

export class ConnectionHub {
  private readonly store: ConnectionRegistry;
  private readonly resolver: SecretResolver;
  private readonly fetchImpl: typeof fetch;

  constructor(store: ConnectionRegistry, secretResolver: SecretResolver = envSecretResolver,
      fetchImpl?: typeof fetch) {
    this.store = store;
    this.resolver = secretResolver;
    // No redirect following: upstreams are fixed loopback origins.
    this.fetchImpl = fetchImpl ?? ((input, init) => fetch(input, { ...init, redirect: 'error' }));
  }

  /** Provision install-side connections into the registry (idempotent upsert). */
  provision(configs: readonly ConnectionProvision[]): ConnectionRow[] {
    const rows: ConnectionRow[] = [];
    for (const config of configs) {
      if (config.baseUrl) loopbackOrigin(config.baseUrl);
      if (config.envBaseUrl) loopbackOrigin(config.envBaseUrl);
      rows.push(this.store.upsertConnection({ ...config }));
    }
    return rows;
  }

  private token(ref: string | undefined): string {
    if (!ref) throw new ManagementError(409, 'CREDENTIAL_REF_MISSING',
      'Connection has no credential reference configured', false);
    const value = this.resolver(ref);
    if (!value) throw new ManagementError(503, 'CREDENTIAL_UNAVAILABLE',
      'Credential reference cannot be resolved on this install', true);
    return value;
  }

  /** Fixed ordinary task transport; never opens an ACS browser session. */
  async local<T>(connectionId: string, method: 'GET' | 'POST', tail: string, body?: unknown, storeId?: string): Promise<T> {
    // Query keys are opened for native-messages/1 paging (cursor/before/limit,
    // digit-only) but only after the same fixed route root and segments —
    // semantic validation (duplicates, mutual exclusion, ranges) lives in the
    // callers; a query can never widen this into an arbitrary path.
    if (!/^\/(identity|local-models|engines|projects|task-preflights|tasks|task-requests)(\/[A-Za-z0-9._-]+)*(\?(cursor|before|limit)=[0-9]+(&(cursor|before|limit)=[0-9]+)*)?$/.test(tail)) return invalid('Fixed local route required');
    if (storeId) {
      const identity = await this.local<{storeId:string}>(connectionId, 'GET', '/identity');
      if (identity.storeId !== storeId) throw new ManagementError(409, 'SOURCE_IDENTITY_CHANGED', '原本机存储身份已改变，请恢复原连接', false);
    }
    return this.localRequest<T>(connectionId, method, '/local/v1' + tail, body, storeId);
  }

  /** Optional discovery on the registered source. Only an absent manifest means legacy. */
  async nativeHost(connectionId: string): Promise<NativeHostDiscovery | undefined> {
    let manifest: NativeHostDiscovery['manifest'];
    try { manifest = await this.localRequest(connectionId, 'GET', '/worker-host/v1/manifest'); }
    catch (e) { if (e instanceof ManagementError && e.status === 404) return undefined; throw e; }
    const text = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 1024;
    if (!manifest || manifest.schemaVersion !== 'worker-host/1'
      || ![manifest.authorityId, manifest.storeId, manifest.workerId, manifest.bootId].every(text)
      || !supportedNativeEngine(manifest.engine?.id) || !text(manifest.engine?.version)
      || !Array.isArray(manifest.contracts) || !manifest.contracts.includes('worker-local/1')
      || !manifest.contracts.every(text) || !Array.isArray(manifest.supportedPaths)
      || !manifest.supportedPaths.every(text)) {
      throw new ManagementError(409, 'NATIVE_HOST_CONTRACT_MISMATCH', '原生宿主合同不兼容', false);
    }
    const identity = await this.local<{storeId:string}>(connectionId, 'GET', '/identity');
    if (manifest.storeId !== identity.storeId) throw new ManagementError(409, 'SOURCE_IDENTITY_CHANGED', '发现信息与任务存储身份不一致', false);
    const page = await this.localRequest<{items: NativeHostDiscovery['capabilities']}>(connectionId, 'GET', '/worker-host/v1/capabilities', undefined, manifest.storeId);
    if (!Array.isArray(page?.items) || page.items.length > 256 || page.items.some(c => !c || (c.schemaVersion !== undefined && c.schemaVersion !== 'worker-capability/1')
      || ![c.id, c.implementation, c.qualification, c.availability].every(text)
      || (c.qualification === 'VERIFIED' && !text(c.evidenceRef)))) {
      throw new ManagementError(502, 'NATIVE_HOST_CAPABILITIES_INVALID', '原生宿主能力信息不可解析', false);
    }
    return {manifest, capabilities: page.items};
  }

  /**
   * Non-throwing local transport for the device gateway's Result-style
   * channel: identical fetch/parse rules to `localRequest` (WORKER_LOCAL kind
   * check, loopback origin, bearer, X-Worker-Local-Store, idempotency-key,
   * redirect:'error', 20s timeout, 1MiB streamed cap, JSON parse guard) but
   * returns `{status, data}` for ANY HTTP status. Transport-level failures —
   * fetch/timeout, non-JSON body, oversize — still throw ManagementError.
   */
  async rawLocal<T>(connectionId: string, method: 'GET' | 'POST', tail: string, body?: unknown, storeId?: string): Promise<{ status: number; data: T }> {
    const row = this.store.getConnection(connectionId);
    if (row?.kind !== 'WORKER_LOCAL' || !row.baseUrl) throw new ManagementError(409, 'LOCAL_CONNECTION_REQUIRED', '本机任务连接未登记', false);
    const response = await this.fetchImpl(new URL(tail, loopbackOrigin(row.baseUrl)), {
      method, redirect:'error', signal:AbortSignal.timeout(TIMEOUT),
      headers:{authorization:`Bearer ${this.token(row.tokenRef)}`, 'content-type':'application/json', ...(storeId?{'X-Worker-Local-Store':storeId}:{}), ...(body ? {'idempotency-key':(body as {requestKey?:string}).requestKey ?? ''} : {})},
      body:body === undefined ? undefined : JSON.stringify(body),
    });
    const reader = response.body?.getReader(); const parts:Uint8Array[]=[]; let size=0;
    if (reader) try {while(true){const part=await reader.read();if(part.done)break;size+=part.value.byteLength;if(size>1024*1024){await reader.cancel();throw new ManagementError(502,'RESPONSE_TOO_LARGE','本机响应超过读取上限',false);}parts.push(part.value);}}finally{reader.releaseLock();}
    let value:Record<string,unknown>;try{value=JSON.parse(Buffer.concat(parts).toString('utf8'));}catch{throw new ManagementError(502,'LOCAL_REPLY_INVALID','本机响应不可解析',true);}
    return { status: response.status, data: value as T };
  }

  /**
   * Streaming variant of `local` for worker-events/1 SSE tails. Same fixed
   * route root, bearer, loopback origin, X-Worker-Local-Store store guard and
   * redirect:'error' policy — but the 2xx body is returned as an open
   * ReadableStream instead of the bounded 1 MiB JSON buffer. Non-2xx replies
   * still fail through the bounded error path so cursor conflicts surface as
   * ordinary ManagementError codes. The caller owns stream lifetime through
   * `options.signal`; without one the ordinary TIMEOUT bound still applies.
   */
  async localStream(connectionId: string, tail: string, options?: {storeId?: string; signal?: AbortSignal}): Promise<LocalStreamResponse> {
    if (!/^\/(identity|local-models|engines|projects|task-preflights|tasks|task-requests)(\/[A-Za-z0-9._-]+)*(\?(cursor|before|limit)=[0-9]+(&(cursor|before|limit)=[0-9]+)*)?$/.test(tail)) return invalid('Fixed local route required');
    if (options?.storeId) {
      const identity = await this.local<{storeId:string}>(connectionId, 'GET', '/identity');
      if (identity.storeId !== options.storeId) throw new ManagementError(409, 'SOURCE_IDENTITY_CHANGED', '原本机存储身份已改变，请恢复原连接', false);
    }
    const row = this.store.getConnection(connectionId);
    if (row?.kind !== 'WORKER_LOCAL' || !row.baseUrl) throw new ManagementError(409, 'LOCAL_CONNECTION_REQUIRED', '本机任务连接未登记', false);
    const response = await this.fetchImpl(new URL('/local/v1' + tail, loopbackOrigin(row.baseUrl)), {
      method:'GET', redirect:'error', signal: options?.signal ?? AbortSignal.timeout(TIMEOUT),
      headers:{authorization:`Bearer ${this.token(row.tokenRef)}`, accept:'text/event-stream', ...(options?.storeId?{'X-Worker-Local-Store':options.storeId}:{})},
    });
    if (response.status < 200 || response.status >= 300 || !response.body) {
      // Replies to an event-stream request are either a live SSE body or a
      // small JSON problem (worker-events/1 uses HTTP 400 for cursor
      // conflicts). The error path stays bounded — it is not a stream.
      const reader = response.body?.getReader(); const parts:Uint8Array[]=[]; let size=0;
      if (reader) try {while(true){const part=await reader.read();if(part.done)break;size+=part.value.byteLength;if(size>64*1024){await reader.cancel();throw new ManagementError(502,'RESPONSE_TOO_LARGE','本机响应超过读取上限',false);}parts.push(part.value);}}finally{reader.releaseLock();}
      let value:Record<string,unknown>={};try{value=JSON.parse(Buffer.concat(parts).toString('utf8'));}catch{/* non-JSON problem body */}
      throw new ManagementError(response.status>=200&&response.status<300?502:response.status,typeof value.code==='string'?value.code:'LOCAL_STREAM_UNAVAILABLE',typeof value.code==='string'?value.code:'本机事件流不可用',response.status>=500);
    }
    return { status: response.status, headers: response.headers, body: response.body };
  }

  /** Fixed callers only; shares bearer, redirect, timeout and bounded parsing rules. */
  private async localRequest<T>(connectionId: string, method: 'GET' | 'POST', path: string, body?: unknown, storeId?: string): Promise<T> {
    const response = await this.rawLocal<Record<string,unknown>>(connectionId, method, path, body, storeId);
    const value = response.data;
    if(response.status<200||response.status>=300)throw new ManagementError(response.status,typeof value.code==='string'?value.code:'LOCAL_SOURCE_UNAVAILABLE',typeof value.code==='string'?value.code:'本机任务来源暂不可读',response.status>=500);
    return value as T;
  }

  /** Resolve a registered connection row to a live handle. */
  handle(row: ConnectionRow): ConnectionHandle {
    const hub = this;
    const kind = row.kind as PersonalConnectionKind;
    const acsClient = (session?: AcsSessionHandle) => {if(kind==='WORKER_LOCAL')throw new ManagementError(409,'ACS_CHANNEL_UNAVAILABLE','本机原生连接没有 ACS 通道',false);return new ServiceClient({
      baseUrl: loopbackOrigin(row.baseUrl ?? ''),
      token: hub.token(row.tokenRef),
      clientSessionToken: session?.token,
      fetchImpl: hub.fetchImpl,
      timeoutMs: TIMEOUT,
    });};
    return {
      row,
      kind,
      acs: (session) => {
        if (!row.baseUrl) throw new ManagementError(409, 'CHANNEL_NOT_PROVISIONED',
          `Connection ${row.connectionId} has no ACS service channel`, false);
        return acsClient(session);
      },
      openAcsSession: (registrationKey, clientId, processInstanceId) =>
        acsClient().registerClientSession({
          registrationKey, clientId, processInstanceId,
          clientKind: 'WEB_TAB', protocols: ['v2'], displayLabel: 'Personal Management Web',
        }),
      revokeAcsSession: (clientSessionId) =>
        acsClient().revokeClientSession(clientSessionId),
      env: () => {
        if (!row.envBaseUrl) throw new ManagementError(409, 'CHANNEL_NOT_PROVISIONED',
          `Connection ${row.connectionId} has no managed-environment channel`, false);
        return new WorkerEnvClient({
          baseUrl: row.envBaseUrl,
          token: hub.token(row.envTokenRef),
          fetchImpl: hub.fetchImpl,
          timeoutMs: TIMEOUT,
        });
      },
      personalAccess: async (session, operation, body, id) => {
        if (!row.baseUrl) throw new ManagementError(409, 'CHANNEL_NOT_PROVISIONED', 'ACS channel required', false);
        if (id !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id)) invalid('Invalid device or pairing id');
        const root = '/api/v2/personal-access';
        const routes = {
          capabilities: ['GET', root + '/capabilities'], devices: ['GET', root + '/devices'],
          'pairing-requests': ['GET', root + '/pairing-requests'], invitations: ['POST', root + '/pairing-invitations'],
          decide: ['POST', `${root}/pairing-requests/${id}/decisions`],
          revoke: ['DELETE', `${root}/devices/${id}`], scope: ['PUT', `${root}/devices/${id}/scope`],
          // ACS owns provider configuration and route state. These are
          // intentionally fixed paths; no browser-supplied URL or secret is
          // interpolated into them.
          'notification-provider': ['GET', root + '/notification-provider'],
          'notification-provider-update': ['PUT', root + '/notification-provider'],
          'notification-routes': ['GET', root + '/notification-routes'],
          'notification-route': ['GET', `${root}/devices/${id}/notification-route`],
          'notification-route-update': ['PUT', `${root}/devices/${id}/notification-route`],
          'notification-subscription': ['GET', `${root}/devices/${id}/notification-subscription`],
        } as const;
        const [method, path] = routes[operation];
        const response = await hub.fetchImpl(new URL(path, loopbackOrigin(row.baseUrl)), {
          method, redirect: 'error', signal: AbortSignal.timeout(TIMEOUT),
          headers: { authorization: `Bearer ${hub.token(row.tokenRef)}`,
            'X-CodeAgent-Client-Token': session.token, 'content-type': 'application/json' },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        if (response.status === 204) return null;
        const chunks: Uint8Array[] = []; let size = 0;
        const reader = response.body?.getReader();
        if (reader) try {
          while (true) {
            const part = await reader.read(); if (part.done) break;
            size += part.value.byteLength;
            if (size > 1024 * 1024) {await reader.cancel(); throw new ManagementError(502, 'RESPONSE_TOO_LARGE', 'Bounded owner response required', false);}
            chunks.push(part.value);
          }
        } finally {reader.releaseLock();}
        const text = Buffer.concat(chunks).toString('utf8');
        const result = JSON.parse(text) as Record<string, unknown>;
        if (!response.ok) throw new ManagementError(response.status,
          typeof result.code === 'string' ? result.code : 'UPSTREAM_ERROR', 'Personal access owner request failed', response.status >= 500);
        return result;
      },
      hasAcs: () => row.kind !== 'WORKER_LOCAL' && !!row.baseUrl,
      hasEnv: () => !!row.envBaseUrl,
    };
  }

  /** The connection a registered project is bound to. */
  forProject(projectId: string): { project: ProjectRow; handle: ConnectionHandle } {
    const project = this.store.getProject(projectId);
    if (!project) throw new ManagementError(404, 'PROJECT_NOT_REGISTERED',
      'Project id is not registered in this management store', false);
    const connection = this.store.getConnection(project.connectionId);
    if (!connection) throw new ManagementError(409, 'CONNECTION_MISSING',
      'The connection this project was registered on no longer exists', false);
    return { project, handle: this.handle(connection) };
  }

  /** The default connection used for new project registration. */
  primary(): { connection: ConnectionRow; handle: ConnectionHandle } {
    const rows = this.store.listConnections();
    if (!rows.length) throw new ManagementError(503, 'NO_CONNECTIONS',
      'No worker/ACS connection is provisioned on this install', true);
    // Prefer an ACS-capable connection for project lookup; daemon-only
    // installs register against their first provisioned connection.
    const row = rows.find((r) => r.kind !== 'WORKER_LOCAL' && !!r.baseUrl) ?? rows[0];
    return { connection: row, handle: this.handle(row) };
  }
}

/**
 * Honest per-kind capability projection (freeze §2 joint rule): a capability
 * is advertised only when the install-side channel is actually configured.
 */
export function connectionCapabilities(row: ConnectionRow, runnerReady: boolean): {
  projectEnvironmentPrepareV1: boolean;
  environmentBoundExecutionV1: boolean;
  adaptiveActionV1: boolean;
} {
  const envChannel = row.kind === 'DAEMON' && !!row.envBaseUrl;
  return {
    projectEnvironmentPrepareV1: envChannel,
    environmentBoundExecutionV1: envChannel,
    adaptiveActionV1: envChannel && runnerReady,
  };
}

/** Digest of the personal write body used for the request ledger. */
export function bodyDigestOf(body: unknown): string {
  return canonicalDigest(body);
}

/** bodyDigest forwarded upstream (digest of the upstream wire body minus itself). */
export function upstreamBodyDigest(body: Record<string, unknown>): string {
  return canonicalDigest(body, 'bodyDigest');
}

export { ServiceProblem, canonicalJson };
