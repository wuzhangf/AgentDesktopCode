import { describe, expect, it, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  SecureConfigStore,
  type SecretStore
} from '../../electron/main/bootstrap/secureConfig';

class FakeSecretStore implements SecretStore {
  available: boolean;
  constructor(available = true) {
    this.available = available;
  }
  isEncryptionAvailable(): boolean {
    return this.available;
  }
  /** Toy cipher: reversible but free of plaintext substrings. */
  encrypt(plain: string): Buffer | null {
    if (!this.available) return null;
    return Buffer.from(Buffer.from(plain, 'utf8').toString('base64').split('').reverse().join(''), 'utf8');
  }
  decrypt(encrypted: Buffer): string | null {
    try {
      return Buffer.from(encrypted.toString('utf8').split('').reverse().join(''), 'base64').toString('utf8');
    } catch {
      return null;
    }
  }
}

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-config-'));
}

describe('SecureConfigStore (design §6.5)', () => {
  let dir: string;
  beforeEach(() => {
    dir = tempDir();
  });

  it('round-trips the token only through the encrypted store', () => {
    const store = new SecureConfigStore(dir, new FakeSecretStore(true));
    expect(store.saveToken('super-secret-token-value-123456').persisted).toBe(true);
    expect(fs.existsSync(path.join(dir, 'token.enc'))).toBe(true);
    // the persisted file must not contain the plaintext
    const raw = fs.readFileSync(path.join(dir, 'token.enc'), 'utf8');
    expect(raw).not.toContain('super-secret-token-value-123456');
    expect(store.loadToken()).toBe('super-secret-token-value-123456');
  });

  it('never persists plaintext when encryption is unavailable', () => {
    const store = new SecureConfigStore(dir, new FakeSecretStore(false));
    expect(store.saveToken('super-secret-token-value-123456').persisted).toBe(false);
    expect(fs.existsSync(path.join(dir, 'token.enc'))).toBe(false);
    expect(store.loadToken()).toBeNull();
  });

  it('round-trips config and remembers the service identity', () => {
    const store = new SecureConfigStore(dir, new FakeSecretStore(true));
    expect(store.checkAttachIdentity('svc-1').identityMatch).toBe(true); // nothing remembered yet
    store.rememberServiceInstanceId('svc-1');
    expect(store.loadConfig().lastServiceInstanceId).toBe('svc-1');
    const check = store.checkAttachIdentity('svc-2');
    expect(check.identityMatch).toBe(false);
    expect(check.previousServiceInstanceId).toBe('svc-1');
    expect(store.checkAttachIdentity('svc-2').previousServiceInstanceId).toBe('svc-1');
  });

  it('fails closed to defaults on a corrupted config file', () => {
    const store = new SecureConfigStore(dir, new FakeSecretStore(true));
    store.rememberServiceInstanceId('svc-1');
    fs.writeFileSync(path.join(dir, 'config.json'), '{not json at all');
    const config = store.loadConfig();
    expect(config.lastServiceInstanceId).toBeUndefined();
    expect(config.preferences.notificationsEnabled).toBe(true);
  });

  it('drops malformed optional config values instead of passing them to the launcher', () => {
    const store = new SecureConfigStore(dir, new FakeSecretStore(true));
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
      attachEndpoint: { malicious: true },
      bundledService: { command: '', args: ['x'] },
      lastServiceInstanceId: 42,
      preferences: { notificationsEnabled: false }
    }));
    const config = store.loadConfig();
    expect(config.attachEndpoint).toBeUndefined();
    expect(config.bundledService).toBeUndefined();
    expect(config.lastServiceInstanceId).toBeUndefined();
    expect(config.preferences.notificationsEnabled).toBe(false);
  });

  it('clears the token file', () => {
    const store = new SecureConfigStore(dir, new FakeSecretStore(true));
    store.saveToken('abc-def-ghijkl-123456');
    store.clearToken();
    expect(store.loadToken()).toBeNull();
  });
});
