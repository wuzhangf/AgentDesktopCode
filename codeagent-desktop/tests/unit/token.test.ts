import { describe, expect, it } from 'vitest';
import { generateServiceToken, generateStartNonce } from '../../electron/main/service/token';

describe('service token generation (design 6.4)', () => {
  it('generates 256-bit url-safe tokens', () => {
    const token = generateServiceToken();
    // 32 bytes -> 43 base64url chars
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('generates unique tokens and nonces', () => {
    const tokens = new Set(Array.from({ length: 50 }, () => generateServiceToken()));
    const nonces = new Set(Array.from({ length: 50 }, () => generateStartNonce()));
    expect(tokens.size).toBe(50);
    expect(nonces.size).toBe(50);
  });

  it('nonce is 128-bit url-safe', () => {
    expect(generateStartNonce()).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });
});
