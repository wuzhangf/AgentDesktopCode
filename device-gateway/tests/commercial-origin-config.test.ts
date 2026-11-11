import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkedDailyOrigin, readEnvConfig } from '../src/gateway-main.js';

afterEach(() => vi.unstubAllEnvs());

describe('explicit commercial issuer configuration', () => {
  it('normalizes only secure public or loopback development origins', () => {
    expect(checkedDailyOrigin(undefined)).toBeUndefined();
    expect(checkedDailyOrigin('https://Member.Example:443/')).toBe('https://member.example');
    expect(checkedDailyOrigin('https://member.example:8443')).toBe('https://member.example:8443');
    expect(checkedDailyOrigin('http://127.0.0.1:55123')).toBe('http://127.0.0.1:55123');
    expect(checkedDailyOrigin('http://[::1]:55123')).toBe('http://[::1]:55123');
    for (const invalid of ['http://member.example', 'https://name:pass@member.example', 'https://member.example/path',
      'https://member.example?token=x', 'https://member.example#x', 'file:///tmp/member', 'not-an-origin']) {
      expect(() => checkedDailyOrigin(invalid)).toThrowError(expect.objectContaining({ code: 'DAILY_ORIGIN_INVALID' }));
    }
  });

  it('readEnvConfig passes only the explicit issuer and keeps missing configuration closed', () => {
    const root = mkdtempSync(join(tmpdir(), 'commercial-origin-config-'));
    try {
      for (const [key, value] of Object.entries({
        DEVICE_GATEWAY_DATA_DIR: root, DEVICE_GATEWAY_BIND: '127.0.0.1', DEVICE_GATEWAY_PORT: '55123',
        DEVICE_GATEWAY_OWNER_PORT: '55124', DEVICE_GATEWAY_TLS_CN: '127.0.0.1',
        DEVICE_GATEWAY_OWNER_TOKEN: 'synthetic-owner', DEVICE_GATEWAY_OWNER_CLIENT_TOKEN: 'synthetic-owner-client',
        DEVICE_GATEWAY_STORE_KEY: '11'.repeat(32), MODEL_BASE_URL: 'https://provider.example/v1',
      })) vi.stubEnv(key, value);
      vi.stubEnv('DEVICE_GATEWAY_DAILY_ORIGIN', '');
      vi.stubEnv('DEVICE_GATEWAY_ALLOW_UNLICENSED_DEVELOPMENT', '');
      expect(readEnvConfig().dailyOrigin).toBeUndefined();
      expect(readEnvConfig().allowUnlicensedDevelopment).not.toBe(true);
      vi.stubEnv('DEVICE_GATEWAY_DAILY_ORIGIN', 'https://Member.Example:443/');
      expect(readEnvConfig().dailyOrigin).toBe('https://member.example');
      vi.stubEnv('DEVICE_GATEWAY_DAILY_ORIGIN', 'https://member.example/path');
      expect(() => readEnvConfig()).toThrowError(expect.objectContaining({ code: 'DAILY_ORIGIN_INVALID' }));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
