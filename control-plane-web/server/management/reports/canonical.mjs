// Canonical JSON + digest helpers (PAE P0 contract freeze 2026-10-18 §0).
// Digest input = the object MINUS its own digest field, serialized as
// canonical JSON: UTF-8, object keys sorted by code point, no whitespace.
// Every digest this module produces is `sha256:<64 lowercase hex>`.
import { createHash } from 'node:crypto';

/** Deep canonical stringify. Rejects values that cannot appear in a JSON
 * contract document (functions, symbols, bigint, undefined members). */
export function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('non-finite number cannot enter a contract digest');
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      throw new TypeError('only plain objects can enter a contract digest');
    }
    const out = {};
    for (const key of Object.keys(value).sort()) {
      const v = value[key];
      if (v === undefined) continue; // JSON.stringify drops undefined members
      out[key] = canonicalize(v);
    }
    return out;
  }
  throw new TypeError(`value of type ${typeof value} cannot enter a contract digest`);
}

/** sha256:<64 lowercase hex> over the canonical JSON of `value`. */
export function digestOf(value) {
  return `sha256:${createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex')}`;
}

/** sha256:<64 lowercase hex> over raw bytes (output files, source payloads). */
export function digestBytes(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

/** UTC RFC-3339 timestamp for contract fields (freeze §0). */
export function utcNow(clock) {
  const d = clock ? new Date(clock()) : new Date();
  return d.toISOString();
}
