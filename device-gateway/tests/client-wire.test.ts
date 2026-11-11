import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { sourceKey, ref, unref, excerpt, exact, text, id } from '../src/client-wire';
import { GatewayError } from '../src/protocol';

// Java reference conformance fixtures shipped with the client-access contract.
const VECTORS = process.env.CLIENT_ACCESS_CONTRACT_DIRECTORY ?? fileURLToPath(new URL('../../../AgentCodeService/agent-code-runtime/src/main/resources/contracts/client-access/v1', import.meta.url));
const sourceKeys = JSON.parse(readFileSync(`${VECTORS}/source-key-vectors.json`, 'utf8')) as { values: string[]; sourceKey: string }[];
const refs = JSON.parse(readFileSync(`${VECTORS}/reference-vectors.json`, 'utf8')) as { reference: string; prefix: string; value: Record<string, unknown> }[];

describe('client-access wire codec (Java contract vectors)', () => {
  it('sourceKey matches all vectors', () => {
    for (const v of sourceKeys) {
      const [version, ...rest] = v.values;
      expect(version).toBe('client-access/1');
      expect(sourceKey(...(rest as [string, string, string, string, string, string, string, string]))).toBe(v.sourceKey);
    }
  });
  it('ref produces identical references', () => {
    for (const v of refs) expect(ref(v.prefix, v.value)).toBe(v.reference);
  });
  it('unref decodes all references', () => {
    for (const v of refs) {
      const node = unref(v.reference, v.prefix);
      expect(Object.keys(node).sort()).toEqual(Object.keys(v.value).sort());
      for (const k of Object.keys(v.value)) expect(node[k]).toEqual(v.value[k]);
    }
  });
  it('unref rejects wrong prefix / bad charset / oversized', () => {
    expect(() => unref('x1.abc', 'c1')).toThrowError(GatewayError);
    expect(() => unref('c1.%%%', 'c1')).toThrowError(GatewayError);
    expect(() => unref('c1.' + 'a'.repeat(2800), 'c1')).toThrowError(GatewayError);
  });
  it('exact requires all keys and no extras', () => {
    expect(() => exact({ a: 1 }, 'a', 'b')).toThrowError(GatewayError);
    expect(() => exact({ a: 1, b: 2, c: 3 }, 'a', 'b')).toThrowError(GatewayError);
    expect(exact({ a: 1, b: 2 }, 'a', 'b')).toEqual({ a: 1, b: 2 });
  });
  it('id bound is 120 chars', () => {
    expect(id('a'.repeat(120))).toBe('a'.repeat(120));
    expect(() => id('a'.repeat(121))).toThrowError(GatewayError);
    expect(() => id('-bad')).toThrowError(GatewayError);
  });
  it('excerpt never splits a code point', () => {
    const s = 'ab中\u{1f600}cd';
    for (const n of [0, 1, 2, 3, 4, 5, 6, 7, 8, 100]) {
      const out = excerpt(s, n);
      expect(Buffer.byteLength(out, 'utf8')).toBeLessThanOrEqual(n);
      expect(s.startsWith(out)).toBe(true);
    }
  });
  it('text rejects blank', () => {
    expect(() => text({ k: '  ' }, 'k')).toThrowError(GatewayError);
    expect(text({ k: ' x ' }, 'k')).toBe(' x ');
  });
});
