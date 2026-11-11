/**
 * client-access/1 wire codec — port of ClientAccessWire.
 * Refs are opaque locators, never authorization. Conformance is checked
 * against AgentCodeService's reference-vectors/source-key-vectors fixtures.
 */
import { fail, hash, hashBytes } from './protocol';

export const VERSION = 'client-access/1';

const FIELDS = new Set([
  'sourceKind', 'storeId', 'backendStoreId', 'engineId', 'agentId', 'conversationId',
  'sessionId', 'taskId', 'runId', 'messageId', 'operation', 'sessionVersion',
  'stateVersion', 'generation', 'nativeSessionId', 'nativeTurnId', 'targetCommandId',
  'inputRequestId', 'method', 'position', 'contentRevision', 'offset', 'direction',
]);

export type JsonObject = Record<string, unknown>;

const isObject = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);

/** Canonical JSON: keys sorted recursively; used for ref() and digests. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify((value as JsonObject)[k])}`).join(',')}}`;
}

/** UTF-8 well-formedness check mirroring the Java REPORT-on-malformed guard. */
const unicode = (s: string): void => {
  if (!isWellFormed(s)) fail('INVALID_REQUEST', 422);
};
const isWellFormed = (s: string): boolean => {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const n = s.charCodeAt(++i);
      if (!(n >= 0xdc00 && n <= 0xdfff)) return false;
    } else if (c >= 0xdc00 && c <= 0xdfff) return false;
  }
  return true;
};

export const text = (v: JsonObject, k: string): string => {
  const n = v[k];
  if (typeof n !== 'string' || n.trim().length === 0) fail('INVALID_REQUEST', 422);
  unicode(n);
  return n;
};

/** exact() requires all listed keys present and no extras (ClientAccessWire semantics). */
export const exact = (v: unknown, ...keys: string[]): JsonObject => {
  if (!isObject(v)) fail('INVALID_REQUEST', 422);
  for (const name of Object.keys(v)) if (!keys.includes(name)) fail('INVALID_REQUEST', 422);
  for (const k of keys) if (!(k in v)) fail('INVALID_REQUEST', 422);
  return v;
};

export const id = (v: unknown): string => {
  if (typeof v !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(v)) fail('INVALID_REQUEST', 422);
  return v;
};

export const bodyText = (v: JsonObject, k: string): string => {
  const s = text(v, k);
  if (Buffer.byteLength(s, 'utf8') > 8192) fail('REQUEST_TOO_LARGE', 413);
  return s;
};

export const digest = (node: unknown): string => hash(stableStringify(node));
export const digestBytes = (bytes: Uint8Array): string => hashBytes(bytes);

/**
 * Structured source key: sha256 of big-endian length-prefixed UTF-8 fields.
 * Field order is fixed by callers: (actor,kind,store,backend,type,target,operation,request).
 */
export function sourceKey(
  actor: string, kind: string, store: string, backend: string,
  type: string, target: string, operation: string, request: string,
): string {
  const parts = [VERSION, actor, kind, store, backend, type, target, operation, request];
  const chunks: Buffer[] = [];
  for (const s of parts) {
    const b = Buffer.from(s, 'utf8');
    const len = Buffer.alloc(4);
    len.writeInt32BE(b.length);
    chunks.push(len, b);
  }
  return hashBytes(Buffer.concat(chunks));
}

export const ref = (prefix: string, node: JsonObject): string =>
  `${prefix}.${Buffer.from(stableStringify(node), 'utf8').toString('base64url')}`;

export function unref(value: unknown, prefix: string): JsonObject {
  if (typeof value !== 'string' || value.length > 2800
      || !value.startsWith(`${prefix}.`)
      || !/^[A-Za-z0-9_-]+$/.test(value.substring(prefix.length + 1))) fail('INVALID_REQUEST', 422);
  let raw: Buffer;
  try {
    raw = Buffer.from(value.substring(prefix.length + 1), 'base64url');
  } catch {
    fail('INVALID_REQUEST', 422);
  }
  if (raw!.length > 2048) fail('INVALID_REQUEST', 422);
  let node: unknown;
  try {
    node = JSON.parse(raw!.toString('utf8'));
  } catch {
    fail('INVALID_REQUEST', 422);
  }
  if (!isObject(node)) fail('INVALID_REQUEST', 422);
  for (const [k, n] of Object.entries(node)) {
    if (!FIELDS.has(k) || !(typeof n === 'string' || typeof n === 'number' || n === null)) fail('INVALID_REQUEST', 422);
    if (typeof n === 'number' && !Number.isInteger(n)) fail('INVALID_REQUEST', 422);
    if (typeof n === 'string') unicode(n);
  }
  return node;
}

/** UTF-8 byte-bounded prefix that never splits a code point. */
export function excerpt(value: string, bytes: number): string {
  let end = 0, size = 0;
  while (end < value.length) {
    const cp = value.codePointAt(end)!;
    const n = cp > 0xffff ? 4 : cp > 0x7ff ? 3 : cp > 0x7f ? 2 : 1;
    if (size + n > bytes) break;
    size += n;
    end += cp > 0xffff ? 2 : 1;
  }
  return value.substring(0, end);
}
