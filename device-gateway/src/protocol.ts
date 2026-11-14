/**
 * Shared domain types and bounded-validation helpers for the device gateway.
 * These mirror the Java personal-access reference contract — device grants,
 * pairing/token records, request ledger rows and inbox projections — without
 * pulling in any Electron, React, Vite or Java dependency.
 */
import { createHash, randomBytes, createCipheriv, createDecipheriv, timingSafeEqual } from 'node:crypto';

// ---------------------------------------------------------------------------
// Errors — Java `BusinessException(code, status)` equivalent.
// ---------------------------------------------------------------------------

export class GatewayError extends Error {
  constructor(
    public readonly code: string,
    public readonly httpStatus: number,
  ) {
    super(code);
  }
}

export function fail(code: string, httpStatus: number): never {
  throw new GatewayError(code, httpStatus);
}

// ---------------------------------------------------------------------------
// Bounded validation helpers (same shapes the Java adapter enforces).
// ---------------------------------------------------------------------------

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

/** `[A-Za-z0-9][A-Za-z0-9._-]{0,127}` — the shared id shape. */
export const id = (value: unknown): void => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) {
    fail('INVALID_REQUEST', 400);
  }
};

/** Required non-empty text field, ≤4096 chars (Java `text()`). */
export const text = (body: Record<string, unknown> | null | undefined, name: string): string => {
  const value = body?.[name];
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096) {
    fail('INVALID_REQUEST', 400);
  }
  return value;
};

/** Reject objects carrying undeclared keys (Java `exact()`). */
export const exact = (body: unknown, ...fields: string[]): Record<string, unknown> => {
  if (!isRecord(body)) fail('INVALID_REQUEST', 400);
  for (const key of Object.keys(body)) if (!fields.includes(key)) fail('INVALID_REQUEST', 400);
  return body;
};

// ---------------------------------------------------------------------------
// Crypto primitives (SHA-256 ids, opaque secrets, AES-256-GCM envelopes).
// ---------------------------------------------------------------------------

export const hash = (value: string): string =>
  createHash('sha256').update(value, 'utf8').digest('hex');

/** sha256 of raw bytes (artifact verification). */
export const hashBytes = (value: Uint8Array): string =>
  createHash('sha256').update(value).digest('hex');

/** 32-byte url-safe opaque secret (access/refresh/polling/invite secrets). */
export const secret = (): string => randomBytes(32).toString('base64url');

export const constantEqual = (a: string | undefined | null, b: string | undefined | null): boolean => {
  if (a == null || b == null) return false;
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  // MessageDigest.isEqual also answers quickly on length mismatch.
  return ab.length === bb.length && timingSafeEqual(ab, bb);
};

/** AES-256-GCM envelope: base64(nonce | ciphertext | tag), AAD = storeId. */
export const seal = (value: string, key: Uint8Array, aad: string): string => {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const body = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return Buffer.concat([nonce, body, cipher.getAuthTag()]).toString('base64');
};

export const unseal = (value: string, key: Uint8Array, aad: string): string => {
  const raw = Buffer.from(value, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
  decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(raw.subarray(raw.length - 16));
  return Buffer.concat([decipher.update(raw.subarray(12, raw.length - 16)), decipher.final()]).toString('utf8');
};

// ---------------------------------------------------------------------------
// Resource / launch scopes (PersonalResourceScope port).
// ---------------------------------------------------------------------------

export interface Resource {
  kind: string;                 // 'ACS_SESSION' | 'WORKER_LOCAL'
  backendStoreId: string;
  sessionId?: string;           // ACS_SESSION only
  taskId?: string;              // WORKER_LOCAL only
}

export interface LaunchScope {
  backendStoreId: string;
  projectId: string;
  engineId: string;             // 'pi' | 'codex' | 'macos'
}

export const resourceKey = (r: Resource): string =>
  `${r.kind}:${r.backendStoreId}:${r.kind === 'ACS_SESSION' ? r.sessionId : r.taskId}`;

export const launchScopeKey = (s: LaunchScope): string =>
  `${s.backendStoreId}:${s.projectId}:${s.engineId}`;

/** Fields every scoped record (invite/pairing/device) carries. */
export interface ScopeRecord {
  resources?: Resource[];
  launchScopes?: LaunchScope[];
  /** Derived from resources on normalize; legacy write-only input. */
  sessions?: string[];
  actions?: string[];
}

const acsResources = (storeId: string, sessions: string[] | undefined): Resource[] =>
  (sessions ?? []).map((sid) => ({ kind: 'ACS_SESSION', backendStoreId: storeId, sessionId: sid }));

/**
 * Java `PersonalResourceScope.normalize`: resources become authoritative;
 * `sessions` is derived from ACS_SESSION resources bound to this host store.
 */
export function normalizeScope<T extends ScopeRecord>(scope: T, acsStoreId: string): T {
  if (!scope.resources) scope.resources = acsResources(acsStoreId, scope.sessions);
  if (!scope.launchScopes) scope.launchScopes = [];
  scope.sessions = scope.resources
    .filter((r) => r.kind === 'ACS_SESSION' && r.backendStoreId === acsStoreId)
    .map((r) => r.sessionId!);
  return scope;
}

export const scopeContains = (scope: ScopeRecord, kind: string, store: string, targetId: string): boolean =>
  (scope.resources ?? []).some((r) =>
    r.kind === kind && r.backendStoreId === store &&
    (kind === 'ACS_SESSION' ? r.sessionId : r.taskId) === targetId);

export const permitsLaunch = (scope: ScopeRecord, store: string, project: string, engine: string): boolean =>
  (scope.launchScopes ?? []).some((s) =>
    s.backendStoreId === store && s.projectId === project && s.engineId === engine);

// ---------------------------------------------------------------------------
// Persisted record kinds (generic kind→payload store).
// ---------------------------------------------------------------------------

export interface Host {
  id: string;
  storeId: string;
  keyCheck?: string;
}

export interface Invite extends ScopeRecord {
  id: string;
  secretHash?: string;
  fingerprint?: string;
  requestId?: string;
  envelope?: string;
  expiresAt: number;
}

export interface Pairing extends ScopeRecord {
  id: string;
  inviteId?: string;
  installationId?: string;
  label?: string;
  pollHash?: string;
  fingerprint?: string;
  state?: string;               // PENDING | APPROVED | REJECTED | REDEEMED
  checkWords?: string;
  deviceId?: string;
  redemptionId?: string;
  envelope?: string;
  expiresAt: number;
  recoverUntil: number;
}

export interface Device extends ScopeRecord {
  id: string;
  label?: string;
  installationId?: string;
  state?: string;               // ACTIVE | REVOKED
  accessHash?: string;
  /** Recently rotated access hashes still honored briefly — a refresh racing
   *  an in-flight call (8s approval long-poll, mid-write) must not 401 the
   *  sibling request that left the phone with the previous token. */
  accessGrace?: { hash: string; until: number }[];
  refreshHash?: string;
  previousRefreshHash?: string;
  refreshRequestId?: string;
  envelope?: string;
  scopeVersion: number;
  revision: number;
  accessExpiry: number;
  absoluteExpiry: number;
  idleExpiry: number;
  recoverUntil: number;
  spentRefresh: string[];
}

export interface ScopeChange {
  fingerprint: string;
  result: string;
  /** Epoch ms — idempotency cache eviction ages records; absent on legacy rows. */
  at?: number;
}

/** Device-namespaced request ledger row (kinds local-launch/local-input/local-graphics). */
export interface DeviceRequest {
  deviceId: string;
  clientKey: string;
  sourceKey?: string;
  backendStoreId?: string;
  taskId?: string;
  projectId?: string;
  engineId?: string;
  operation?: string;           // LAUNCH | <intent/kind> | INPUT_RESPONSE | GRAPHICS_*
  hash?: string;
  state?: string;               // SAVED | DISPATCHED | OBSERVED | REJECTED | UNKNOWN | ACCEPTED_OWNER_ONLY
  code?: string;
  grantRevision: number;
  wire?: Record<string, unknown>;
  result?: unknown;
  targetScope?: unknown;
}

// ---------------------------------------------------------------------------
// Inbox projection types (PersonalInboxService port).
// ---------------------------------------------------------------------------

export interface Signal {
  kind: string;                 // NEEDS_INPUT | RESULT_READY | ATTENTION_REQUIRED
  eventKey: string;
  sourceRevision?: string;
  coverage?: string;
  title?: string;
  subject?: unknown;
}

export interface SourceRead {
  signals: Signal[];
  verifiedKinds: Set<string>;
  coverage: string;
  truncated: boolean;
}

export interface InboxItem {
  itemId: string;
  deviceId: string;
  grantRevision: number;
  sourceKey: string;
  eventKey: string;
  kind: string;
  resource: Resource;
  subject?: unknown;
  title?: string;
  sourceRevision: string;
  observedAt: number;
  expiresAt: number;
  sourceAvailable: boolean;
  coverage: string;
}

export interface SourceCursor {
  cursorKey: string;
  deviceId: string;
  sourceKey: string;
  lastError?: string;
  coverage: string;
  grantRevision: number;
  lastAttemptAt: number;
  lastSuccessfulAt: number;
  nextAttemptAt: number;
  failureCount: number;
  available: boolean;
  truncated: boolean;
  resource: Resource;
  unverifiedKinds: string[];
}

export interface ListRevision {
  deviceId: string;
  revision: number;
}
