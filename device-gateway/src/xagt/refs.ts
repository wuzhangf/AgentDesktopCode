/**
 * References and cursors for the xagt read surface.
 *
 * targetRef / sessionRef / materialRef are opaque service-issued handles that
 * bind to internal source identities — a model never supplies URLs, absolute
 * paths or raw source ids; it can only replay a ref this service issued.
 * Records live in the gateway store under 'xagt-ref'; ids are deterministic
 * content hashes, so listing the same source twice re-issues the same ref
 * without growing the table.
 *
 * Cursors are stateless HMAC-sealed payloads bound to the reader id, the
 * grant revision, the source ref and the query. Revoking the reader bumps
 * grantRevision → every outstanding cursor fails GRANT_EXPIRED/CURSOR_EXPIRED
 * on the next call — "撤权后立即拒绝后续段" without waiting for TTL.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { hash, isRecord } from '../protocol.js';
import type { GatewayStoreView } from '../context.js';
import { xfail, type ReaderAuthContext } from './common.js';

// ---------------------------------------------------------------------------
// Refs — deterministic opaque handles over internal bindings.
// ---------------------------------------------------------------------------

export type RefKind = 'target' | 'session' | 'material' | 'state';

export interface RefRecord {
  refId: string;
  kind: RefKind;
  binding: Record<string, unknown>;
  createdAt: string;
}

const REF_PREFIX: Record<RefKind, string> = { target: 'xtr', session: 'xsr', material: 'xmr', state: 'xst' };

/** Recursive sorted-key stringify — bindings must hash deterministically. */
const canon = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canon).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canon(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
};

export const bindingKey = (binding: Record<string, unknown>): string => hash(canon(binding));

/** Issue (or re-issue) the ref for a binding. Same binding → same refId. */
export const issueRef = (
  store: Pick<GatewayStoreView, 'get' | 'put'>,
  kind: RefKind,
  binding: Record<string, unknown>,
): string => {
  const refId = `${REF_PREFIX[kind]}-${bindingKey(binding).slice(0, 40)}`;
  if (store.get<RefRecord>('xagt-ref', refId) === undefined) {
    store.put('xagt-ref', refId, {
      refId, kind, binding, createdAt: new Date().toISOString(),
    } satisfies RefRecord);
  }
  return refId;
};

export const resolveRef = (
  store: Pick<GatewayStoreView, 'get'>,
  ref: unknown,
  kind: RefKind,
): Record<string, unknown> => {
  if (typeof ref !== 'string' || !ref.startsWith(`${REF_PREFIX[kind]}-`)) {
    xfail('INVALID_REQUEST', '引用格式无效。');
  }
  const record = store.get<RefRecord>('xagt-ref', ref as string);
  if (record === undefined || record.kind !== kind || !isRecord(record.binding)) {
    xfail('NOT_FOUND');
  }
  return record.binding;
};

// ---------------------------------------------------------------------------
// Cursors — stateless HMAC-sealed payloads.
// ---------------------------------------------------------------------------

export type CursorKind =
  | 'targets' | 'sessions' | 'activity' | 'history' | 'search'
  | 'materials' | 'material' | 'content' | 'peer';

export interface CursorPayload extends Record<string, unknown> {
  v: 1;
  kind: CursorKind;
  /** Bound reader + grant revision. */
  rid: string;
  rev: number;
  /** bindingKey of the ref this cursor reads through ('' for unbound lists). */
  for?: string;
  /** hash of the normalized query it was issued for. */
  q?: string;
}

export const sealCursor = (secret: Uint8Array, payload: CursorPayload): string => {
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const mac = createHmac('sha256', secret).update(`xagt-cursor:${body}`).digest('base64url');
  return `${body}.${mac}`;
};

const openSealed = (secret: Uint8Array, raw: string): CursorPayload => {
  const dot = raw.lastIndexOf('.');
  if (dot <= 0) xfail('CURSOR_EXPIRED');
  const body = raw.slice(0, dot);
  const mac = createHmac('sha256', secret).update(`xagt-cursor:${body}`).digest();
  const given = Buffer.from(raw.slice(dot + 1), 'base64url');
  if (given.length !== mac.length || !timingSafeEqual(given, mac)) xfail('CURSOR_EXPIRED');
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    xfail('CURSOR_EXPIRED');
  }
  if (!isRecord(parsed) || parsed.v !== 1 || typeof parsed.kind !== 'string'
      || typeof parsed.rid !== 'string' || typeof parsed.rev !== 'number') {
    xfail('CURSOR_EXPIRED');
  }
  return parsed as unknown as CursorPayload;
};

/**
 * Open a cursor and bind it to the caller: kind, reader, grant revision and —
 * when given — the ref + query it was issued for. Anything else is
 * CURSOR_EXPIRED (the caller restarts the read from scratch).
 */
export const openCursor = (
  secret: Uint8Array,
  raw: string,
  reader: ReaderAuthContext,
  expectedKind: CursorKind | readonly CursorKind[],
  expectedFor?: string,
  expectedQ?: string,
): CursorPayload => {
  const payload = openSealed(secret, raw);
  const kinds = Array.isArray(expectedKind) ? expectedKind : [expectedKind];
  if (!kinds.includes(payload.kind)) xfail('CURSOR_EXPIRED');
  if (payload.rid !== reader.readerId || payload.rev !== reader.grantRevision) {
    xfail('GRANT_EXPIRED', '授权已变更，游标随之失效；请重新读取。');
  }
  if (expectedFor !== undefined && payload.for !== expectedFor) xfail('CURSOR_EXPIRED');
  if (expectedQ !== undefined && payload.q !== expectedQ) xfail('CURSOR_EXPIRED');
  return payload;
};

/** Hash used to bind cursors to the normalized query/ref they serve. */
export const cursorBind = (value: string): string => hash(value).slice(0, 24);
