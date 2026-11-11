/**
 * Canonical JSON + sha256 digests (PAE P0 freeze 2026-10-18 §0).
 *
 * Canonical form: UTF-8 JSON, object keys ordered by Unicode code point, no
 * insignificant whitespace, `undefined` object members dropped, non-JSON values
 * rejected. Digests are `sha256:<64 lowercase hex>` over this form after the
 * object's own digest field has been removed.
 */
import { createHash } from 'node:crypto';

function codePointCompare(a: string, b: string): number {
  const ai = a[Symbol.iterator]();
  const bi = b[Symbol.iterator]();
  for (;;) {
    const x = ai.next();
    const y = bi.next();
    if (x.done && y.done) return 0;
    if (x.done) return -1;
    if (y.done) return 1;
    if (x.value !== y.value) return x.value.codePointAt(0)! - y.value.codePointAt(0)!;
  }
}

function write(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('canonicalJson: non-finite number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return '[' + value.map(write).join(',') + ']';
  if (typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>)
      .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
      .sort(codePointCompare);
    return '{' + keys
      .map((k) => JSON.stringify(k) + ':' + write((value as Record<string, unknown>)[k]))
      .join(',') + '}';
  }
  throw new Error(`canonicalJson: unsupported value kind ${typeof value}`);
}

/** Deterministic JSON encoding used for every management-side digest. */
export function canonicalJson(value: unknown): string {
  return write(value);
}

/** sha256:<hex> of the canonical encoding of `value` with `drop` keys removed. */
export function canonicalDigest(value: unknown, ...drop: string[]): string {
  let input = value;
  if (drop.length && input && typeof input === 'object' && !Array.isArray(input)) {
    const copy = { ...(input as Record<string, unknown>) };
    for (const key of drop) delete copy[key];
    input = copy;
  }
  return 'sha256:' + createHash('sha256').update(write(input), 'utf8').digest('hex');
}
