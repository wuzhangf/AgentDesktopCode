/**
 * GatewayContext — the structural contract between the HTTP layer
 * (phone-api/owner-api/http) and the implementations in
 * store.ts / devices.ts / local-tasks.ts / inbox.ts / client-access.ts.
 *
 * Method names and response shapes follow the Java reference exactly
 * (PersonalAccessService / PersonalLocalTaskAccess / PersonalInboxService /
 * ClientAccessService): service methods return the Java view objects verbatim
 * as plain JSON, so handlers forward them without field-level adaptation.
 */
import type { Device, LaunchScope, Resource, ScopeRecord, SourceRead } from './protocol';

export type MaybePromise<T> = T | Promise<T>;
export type JsonObject = Record<string, unknown>;

// ---------------------------------------------------------------------------
// HTTP request/response — the listener-normalized shape handlers consume.
// ---------------------------------------------------------------------------

export interface HttpRequest {
  /** Upper-case method as sent (`GET`, `POST`, `PUT`, `DELETE`, ...). */
  method: string;
  /** Raw, undecoded request path (Java getRawPath equivalent). */
  path: string;
  /** Decoded query parameters (convenience view of rawQuery). */
  query: URLSearchParams;
  /** Undecoded query string without `?`, or null when absent. */
  rawQuery: string | null;
  /** Raw request body bytes for byte-accurate handlers (multipart/proxy). */
  rawBody?: Uint8Array;
  /** Parsed JSON body when bodyError is unset; undefined for empty bodies. */
  body?: unknown;
  /**
   * Body read failure captured by the listener, applied lazily so routes that
   * never read a body are unaffected:
   *  - 'BODY_TOO_LARGE' → fail 413
   *  - 'INVALID_REQUEST' → malformed JSON → fail 400
   */
  bodyError?: 'INVALID_REQUEST' | 'BODY_TOO_LARGE';
  /** Bearer token extracted under Java bearer() rules (single header). */
  accessToken?: string;
  /** First raw `Authorization` header value (owner-key comparison). */
  authorization?: string;
  /** Authorization header value count (Java header() requires exactly one). */
  authorizationCount?: number;
  /** First `Idempotency-Key` header value. */
  idempotencyKey?: string;
  /** Exact count of `Idempotency-Key` headers. */
  idempotencyKeyCount?: number;
  /** First `X-Client-Access-Version` header value. */
  clientAccessVersion?: string;
  /** First `X-Client-Session` header value (owner client-token check). */
  clientSessionHeader?: string;
  /** Socket peer address — never trusts X-Forwarded-For. */
  clientIp: string;
  /**
   * True only when the request arrived on the loopback relay listener —
   * i.e. it transited the member-authenticated relay fabric bound to this
   * host. Member-attested pairing is honored on this channel alone; the
   * public phone listener still requires a sealed invitation.
   */
  relayIngress?: boolean;
}

export interface HttpResponse {
  status: number;
  body: unknown;
  /** Forwarded when replying with opaque upstream bytes (e.g. attachments). */
  bodyBytes?: Uint8Array;
  contentType?: string;
}

// ---------------------------------------------------------------------------
// Auth — PersonalAccessService port (src/devices.ts `Devices`).
// Returned JSON objects are the Java view shapes (pairingView/deviceView/
// issued/host/ownerStatus/invitation) — handlers send them unmodified.
// grantRevision is a STRING in the Java wire views.
// ---------------------------------------------------------------------------

export interface GatewayAuth {
  /** POST /personal/v1/pairing-requests → 202 pairingView. */
  request(body: JsonObject): MaybePromise<JsonObject>;
  /**
   * Member-attested pairing (relay ingress only): same pairing state machine
   * without an invitation — the member-authenticated channel is the grant.
   * Pairing is created APPROVED with the caller-supplied scope snapshot;
   * absent implementations fail closed.
   */
  memberRequest?(body: JsonObject, scope: ScopeRecord): MaybePromise<JsonObject>;
  /** LAN Bonjour-discovered pairing — always PENDING until owner approval. */
  discoveryRequest?(body: JsonObject, scope: ScopeRecord): MaybePromise<JsonObject>;
  /** GET /personal/v1/pairing-requests/{id} (bearer = polling secret). */
  observePairing(rid: string, poll: string): MaybePromise<JsonObject>;
  /** POST /pairing-requests/{id}/redemptions → issued credentials object. */
  redeem(rid: string, poll: string, redemptionId: string): MaybePromise<JsonObject>;
  /** POST /personal/v1/access-sessions/refresh → issued credentials object. */
  refresh(token: string, requestId: string): MaybePromise<JsonObject>;
  /** Bearer auth → Device record (throws ACCESS_UNAUTHORIZED/DEVICE_REVOKED/ACCESS_EXPIRED/DEVICE_EXPIRED). */
  authenticate(token: string): MaybePromise<Device>;
  /** ACS_SESSION scope check (throws DEVICE_SCOPE_DENIED 403). */
  authorize(token: string, sessionId: string, action: string): MaybePromise<Device>;
  /** Same check by device id for background projections. */
  authorizeDevice(deviceId: string, sessionId: string, action: string): MaybePromise<Device>;
  /** WORKER_LOCAL scope check. */
  authorizeLocal(token: string, backendStoreId: string, taskId: string, action: string): MaybePromise<Device>;
  authorizeLocalDevice(deviceId: string, backendStoreId: string, taskId: string, action: string): MaybePromise<Device>;
  /** LAUNCH action + launchScope check. */
  authorizeLaunch(token: string, backendStoreId: string, projectId: string, engineId: string): MaybePromise<Device>;
  activeDevices(): MaybePromise<Device[]>;
  activeDevice(deviceId: string): MaybePromise<Device>;
  /** Owner+self revoke — idempotent; missing → NOT_FOUND 404. */
  revoke(deviceId: string): MaybePromise<void>;
  /** Grant extension after accepted launch (Java appendLaunchedTask). */
  appendLaunchedTask(deviceId: string, expectedRevision: number, backendStoreId: string, projectId: string, engineId: string, taskId: string): MaybePromise<void>;
  /** Owner invite: legacy sessions form → invitation object (+sealed envelope). */
  invitation(requestId: string, sessions: string[], actions: string[], fingerprint: string): MaybePromise<JsonObject>;
  /** Owner invite: resource/launch-scope form. */
  invitationResources(requestId: string, resources: Resource[], launchScopes: LaunchScope[], actions: string[], fingerprint: string): MaybePromise<JsonObject>;
  /** Optional owner read-only recovery; older implementations fail closed. */
  invitationById?(requestId: string): MaybePromise<JsonObject>;
  /** Owner CAS scope replace → deviceView. */
  updateScope(deviceId: string, requestId: string, expectedRevision: string, sessions: string[], actions: string[]): MaybePromise<JsonObject>;
  updateScopeResources(deviceId: string, requestId: string, expectedRevision: string, resources: Resource[], launchScopes: LaunchScope[], actions: string[]): MaybePromise<JsonObject>;
  /** Owner device list → deviceView[]. */
  devices(): MaybePromise<JsonObject[]>;
  /** Owner pairing-request list → pairingView[]. */
  requests(): MaybePromise<JsonObject[]>;
  /** {enabled, personalHostId, storeId, origin}. */
  ownerStatus(): MaybePromise<JsonObject>;
  /** GET /personal/v1/host base view (deviceView + schema/capabilities block). */
  host(device: Device, bootId: string): MaybePromise<JsonObject>;
  /** Host bootstrap + key check (startup path only). */
  ensureHost(): MaybePromise<void>;
}

// ---------------------------------------------------------------------------
// LocalTaskAccess — PersonalLocalTaskAccess port (src/local-tasks.ts).
// ---------------------------------------------------------------------------

export interface LocalTaskResult {
  status: number;
  body: unknown;
}

export interface GatewayLocalTasks {
  /** The single path dispatcher — owns every /personal/v1/local-tasks/** route. */
  remote(
    token: string,
    method: string,
    path: string,
    body: unknown,
    key: string | null,
    rawQuery: string | null,
  ): MaybePromise<LocalTaskResult>;
  /** Inbox source read (WORKER_LOCAL only — Java signal()). */
  signal(device: Device, resource: Resource, deadlineMillis: number): MaybePromise<SourceRead>;
  /** Owner capabilities → localSource catalog (Java ownerCatalog()). */
  ownerCatalog(): MaybePromise<JsonObject>;
  /** Owner invite/scope validation for WORKER_LOCAL resources + launch scopes. */
  validateOwnerResources(resources: Resource[], launchScopes: LaunchScope[]): MaybePromise<void>;
  /** Immutable engine binding check for client-access native projections. */
  verifyTaskEngine(token: string, backendStoreId: string, taskId: string, engineId: string): MaybePromise<void>;
  /** local-input ledger presence check for client-access input.respond. */
  recordedInput(token: string, backendStoreId: string, taskId: string, key: string): MaybePromise<boolean>;
}

// ---------------------------------------------------------------------------
// PersonalInbox — PersonalInboxService port (src/inbox.ts).
// ---------------------------------------------------------------------------

export interface GatewayInbox {
  /** Non-blocking wake for this device (inflight-dedup'd scanDevice). */
  requestRefresh(device: Device): void;
  /** Periodic fair scan over all devices' source cursors (server schedules it). */
  scanAll(): MaybePromise<void>;
  /** Bounded page — Java list() shape {schemaVersion,grantRevision,listRevision,coverage,items,nextCursor?,truncated,sourcesTruncated,sources[]}. */
  list(device: Device, cursor: string | undefined, limit: number): MaybePromise<JsonObject>;
  /** Single item + live source re-check — Java detail() shape. */
  detail(device: Device, itemId: string): MaybePromise<JsonObject>;
}

// ---------------------------------------------------------------------------
// ClientAccess — ClientAccessService port (src/client-access.ts).
// /personal/v1/client/* structured conversation contract (ref/unref codec
// lives in client-wire.ts, conformance vectors in tests/client-wire.test.ts).
// ---------------------------------------------------------------------------

export interface GatewayClientAccess {
  /** Java handle() — tail is the path under /personal/v1/client (e.g. '/manifest'). */
  handle(
    token: string,
    method: string,
    tail: string,
    body: unknown,
    idempotencyKey: string | null,
    rawQuery: string | null,
  ): MaybePromise<unknown>;
}

// ---------------------------------------------------------------------------
// ACS upstream seam — PersonalAccessServer's fixed loopback `call()`.
// Everything under /personal/v1/agent|sessions|client(ACS)|input-capabilities|
// execution-policy uses it; undefined → the routes fail per their Java branch.
// ---------------------------------------------------------------------------

export interface AcsReply {
  status: number;
  body: Uint8Array;
  contentType: string;
}

export interface GatewayAcs {
  /**
   * Java call(): fixed loopback upstream, Bearer ownerToken, per-device
   * client-session binding token, Idempotency-Key, bounded reply bytes.
   * `binding` = per-device client-session token (Java binding(device)) or
   * undefined for owner-level calls.
   */
  call(
    method: string,
    path: string,
    body: Uint8Array | undefined,
    idempotencyKey: string | undefined,
    binding: string | undefined,
    maxReplyBytes?: number,
  ): MaybePromise<AcsReply>;
  /** client-access SourcePort — JSON body variant (Java ClientAccessService.SourcePort.call). */
  callJson(device: Device, method: string, path: string, body: unknown, key: string | undefined): MaybePromise<unknown>;
}

// ---------------------------------------------------------------------------
// Terminal-session approvals seam — src/approvals.ts.
// Loopback hook processes ask; device-authorized phones decide.
// ---------------------------------------------------------------------------

export interface GatewayApprovals {
  enabled(): MaybePromise<boolean>;
  submit(body: unknown): MaybePromise<JsonObject>;
  poll(approvalId: string): MaybePromise<JsonObject>;
  cancel(approvalId: string): MaybePromise<JsonObject>;
  pending(): MaybePromise<JsonObject>;
  list(device: Device, waitMillis?: number): MaybePromise<JsonObject>;
  decide(device: Device, approvalId: string, body: unknown): MaybePromise<JsonObject>;
}

// ---------------------------------------------------------------------------
// Transcription seam — PersonalTranscriptionService port (optional).
// ---------------------------------------------------------------------------

export interface GatewayTranscription {
  submit(token: string, requestId: string, sessionId: string, audioSha256: string, audio: Uint8Array, language: string): MaybePromise<JsonObject>;
  get(token: string, requestId: string): MaybePromise<JsonObject>;
  cancel(token: string, requestId: string): MaybePromise<JsonObject>;
}

// ---------------------------------------------------------------------------
// Store — the generic kind→payload records surface that devices/local-tasks/
// inbox consume (Java PersonalAccessStore: record + record_order +
// record_sequence). Components construct it directly; the HTTP layer does not.
// ---------------------------------------------------------------------------

export interface OrderedRow<T = unknown> {
  sequence: number;
  value: T;
}

export interface GatewayStoreView {
  get<T>(kind: string, id: string): T | undefined;
  list<T>(kind: string): T[];
  put(kind: string, id: string, value: unknown): void;
  delete(kind: string, id: string): void;
  /** Ordered put: assigns a stable per-kind sequence once (re-puts keep it). */
  putOrdered(kind: string, id: string, value: unknown): void;
  deleteOrdered(kind: string, id: string): void;
  sequence(kind: string, id: string): number;
  /** DESC by sequence; beforeSequence>0 → rows with sequence<beforeSequence. */
  listOrdered<T>(kind: string, beforeSequence: number, limit: number): OrderedRow<T>[];
  listOrderedForDevice<T>(kind: string, deviceId: string, limit: number): OrderedRow<T>[];
  listOrderedForDeviceSources<T>(kind: string, deviceId: string, grantRevision: number, beforeSequence: number, limit: number, sourceKeys: string[]): OrderedRow<T>[];
  listOrderedForSources<T>(kind: string, sourceKeys: string[], beforeSequence: number, limit: number): OrderedRow<T>[];
  /** Synchronous atomic section — Java store.transaction equivalent. */
  transaction<T>(fn: () => T): T;
}

// ---------------------------------------------------------------------------
// Listener config / context root.
// ---------------------------------------------------------------------------

export interface GatewayConfig {
  personalHostId?: string;
  /** Only explicitly opted-in development/fixture contexts may omit rights. */
  allowUnlicensedDevelopment?: boolean;
  /** Dedicated Agent Link gateway with only owner-registered stock CLI sources. */
  localCliOnly?: boolean;
  /** This gateway's own store id (PersonalAccessService `storeId`). */
  storeId: string;
  /** ACS store id ACS_SESSION resources bind to. */
  acsStoreId: string;
  /** Process boot id (registry.getBootId() analogue). */
  bootId: string;
  /** Public HTTPS origin advertised in invitations (exact, no trailing path). */
  origin: string;
  /** Listener certificate identity surfaced via owner capabilities/host. */
  certificateSha256?: string;
  certificatePem?: string;
  certificateNotBefore?: number;
  certificateNotAfter?: number;
  /** Java X509Certificate.getSubjectAlternativeNames shape: [[type, value], ...]. */
  certificateNames?: [number, string][];
  bindAddress?: string;
  port?: number;
  /** Reason code when transcription is not configured. */
  transcriptionReason?: string;
}

/**
 * Worker self-registration — the inbound half of worker-local sources.
 * The owner mints a single-use worker invite (pairing-invite semantics:
 * the secret IS the consent), and a reachable worker host (pi, an
 * Electron-packaged agent app) registers its own {url, token} against it
 * through the public listener. Registered rows go live immediately — the
 * catalog's per-request identity probes do the health filtering.
 */
export interface GatewayWorkers {
  /** Owner-minted one-shot registration secret → {workerSecret, expiresAt}. */
  mint(requestId: string): MaybePromise<JsonObject>;
  /** Public consume: {workerSecret, connectionId, url, token, displayName?}. */
  register(body: JsonObject): MaybePromise<JsonObject>;
  /**
   * Loopback-direct registration — the owner token already authenticates, so
   * the supervisor can add/remove worker rows without restarting the service
   * (registering one agent must not kill the others' bridges).
   */
  registerDirect(body: JsonObject): MaybePromise<JsonObject>;
  remove(connectionId: string): MaybePromise<void>;
}

export interface GatewayLink {
  /** Master connect switch — false → phone listener stops accepting. */
  setPhoneEnabled(on: boolean): MaybePromise<void>;
  phoneEnabled(): boolean;
}

export interface GatewayContext {
  commercial?: import('./commercial.js').CommercialAccess;
  auth: GatewayAuth;
  /** Undefined → worker registration routes fail OPERATION_NOT_ALLOWED. */
  workers?: GatewayWorkers;
  /** Undefined → owner link-state routes fail OPERATION_NOT_ALLOWED. */
  link?: GatewayLink;
  /** Undefined when no worker-local source is registered (Java localTasks==null). */
  localTasks?: GatewayLocalTasks;
  inbox: GatewayInbox;
  /** Undefined when the ACS loopback upstream is not configured. */
  acs?: GatewayAcs;
  /** Undefined when the client-access adapter is not wired. */
  clientAccess?: GatewayClientAccess;
  /** Undefined → POST /personal/v1/transcriptions fails TRANSCRIPTION_NOT_CONFIGURED. */
  transcription?: GatewayTranscription;
  /** Undefined → /hooks/v1 fails APPROVALS_NOT_CONFIGURED; phone routes 404. */
  approvals?: GatewayApprovals;
  config: GatewayConfig;
}
