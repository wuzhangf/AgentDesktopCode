/**
 * Secure desktop configuration (desktop design §6.4/§6.5).
 *
 * - Non-sensitive config lives in the main's userData directory as JSON.
 * - The bearer token lives only in main memory and, when safeStorage is
 *   available, in an encrypted file. When encryption is unavailable the
 *   token stays session-only (saveToken returns persisted:false) and the
 *   caller must inform the user; plaintext degradation is forbidden.
 */

import fs from 'node:fs';
import path from 'node:path';

export interface SecretStore {
  isEncryptionAvailable(): boolean;
  encrypt(plain: string): Buffer | null;
  decrypt(encrypted: Buffer): string | null;
}

export interface BundledServiceLaunch {
  command: string;
  args: string[];
  cwd?: string;
}

export interface DesktopConfig {
  /** loopback endpoint of an externally managed service, if any */
  attachEndpoint?: string;
  bundledService?: BundledServiceLaunch;
  /** serviceInstanceId seen at the last successful attach (design §6.4 rule 6) */
  lastServiceInstanceId?: string;
  preferences: {
    notificationsEnabled: boolean;
  };
}

export const DEFAULT_CONFIG: DesktopConfig = {
  preferences: { notificationsEnabled: true }
};

const CONFIG_FILE = 'config.json';
const TOKEN_FILE = 'token.enc';
const MAX_CONFIG_BYTES = 64 * 1024;
const MAX_TOKEN_BYTES = 16 * 1024;
const MAX_ENDPOINT_CHARS = 2048;
const MAX_BUNDLED_ARGS = 64;
const MAX_BUNDLED_ARG_CHARS = 4096;

export interface AttachIdentityCheck {
  /** true when the attached service matches the identity from a previous run */
  identityMatch: boolean;
  /** populated when identityMatch is false and a previous identity existed */
  previousServiceInstanceId?: string;
}

export class SecureConfigStore {
  private readonly configDir: string;
  private readonly secretStore: SecretStore;

  constructor(configDir: string, secretStore: SecretStore) {
    if (!configDir || !secretStore) {
      throw new Error('configDir and secretStore are required');
    }
    this.configDir = configDir;
    this.secretStore = secretStore;
  }

  private configPath(): string {
    return path.join(this.configDir, CONFIG_FILE);
  }

  private tokenPath(): string {
    return path.join(this.configDir, TOKEN_FILE);
  }

  /** Corrupt or oversized config fails closed to defaults, never to guesses. */
  loadConfig(): DesktopConfig {
    try {
      if (!fs.existsSync(this.configPath())) return structuredCloneConfig(DEFAULT_CONFIG);
      const raw = fs.readFileSync(this.configPath(), 'utf8');
      if (Buffer.byteLength(raw, 'utf8') > MAX_CONFIG_BYTES) return structuredCloneConfig(DEFAULT_CONFIG);
      const parsed = JSON.parse(raw) as Partial<DesktopConfig>;
      if (typeof parsed !== 'object' || parsed === null) {
        return structuredCloneConfig(DEFAULT_CONFIG);
      }
      return {
        ...(boundedString(parsed.attachEndpoint, MAX_ENDPOINT_CHARS) ? { attachEndpoint: parsed.attachEndpoint as string } : {}),
        ...(validBundledService(parsed.bundledService) ? { bundledService: parsed.bundledService } : {}),
        ...(boundedString(parsed.lastServiceInstanceId, 256) ? { lastServiceInstanceId: parsed.lastServiceInstanceId as string } : {}),
        preferences: {
          notificationsEnabled: parsed.preferences?.notificationsEnabled !== false
        }
      };
    } catch {
      return structuredCloneConfig(DEFAULT_CONFIG);
    }
  }

  saveConfig(config: DesktopConfig): void {
    fs.mkdirSync(this.configDir, { recursive: true });
    const serialized = JSON.stringify(config, null, 2);
    if (Buffer.byteLength(serialized, 'utf8') > MAX_CONFIG_BYTES) {
      throw new Error('desktop config exceeds size limit');
    }
    atomicWrite(this.configPath(), serialized);
  }

  /**
   * Persists the token only when OS-level encryption is available.
   * Returns persisted:false otherwise; the caller keeps the token in memory
   * for the session and must surface the reduced persistence to the user.
   */
  saveToken(token: string): { persisted: boolean } {
    if (!token || token.length > MAX_TOKEN_BYTES) throw new Error('token is required and bounded');
    if (!this.secretStore.isEncryptionAvailable()) {
      return { persisted: false };
    }
    const encrypted = this.secretStore.encrypt(token);
    if (encrypted === null) return { persisted: false };
    fs.mkdirSync(this.configDir, { recursive: true });
    atomicWrite(this.tokenPath(), encrypted);
    return { persisted: true };
  }

  /** Returns null when no persisted token exists or decryption fails. */
  loadToken(): string | null {
    try {
      if (!fs.existsSync(this.tokenPath())) return null;
      const encrypted = fs.readFileSync(this.tokenPath());
      if (encrypted.length > MAX_TOKEN_BYTES) return null;
      return this.secretStore.decrypt(encrypted);
    } catch {
      return null;
    }
  }

  clearToken(): void {
    try {
      if (fs.existsSync(this.tokenPath())) fs.unlinkSync(this.tokenPath());
    } catch {
      // best effort; the token file is worthless without the OS key
    }
  }

  /** Compares a freshly attached service with the remembered identity (§6.4 rule 6). */
  checkAttachIdentity(currentServiceInstanceId: string): AttachIdentityCheck {
    const config = this.loadConfig();
    if (!config.lastServiceInstanceId) return { identityMatch: true };
    return {
      identityMatch: config.lastServiceInstanceId === currentServiceInstanceId,
      previousServiceInstanceId: config.lastServiceInstanceId
    };
  }

  rememberServiceInstanceId(serviceInstanceId: string): void {
    const config = this.loadConfig();
    config.lastServiceInstanceId = serviceInstanceId;
    this.saveConfig(config);
  }
}

function boundedString(value: unknown, maxChars: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxChars;
}

function validBundledService(value: unknown): value is BundledServiceLaunch {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const candidate = value as Partial<BundledServiceLaunch>;
  if (!boundedString(candidate.command, MAX_BUNDLED_ARG_CHARS)
      || !Array.isArray(candidate.args) || candidate.args.length > MAX_BUNDLED_ARGS
      || candidate.args.some((arg) => !boundedString(arg, MAX_BUNDLED_ARG_CHARS))) {
    return false;
  }
  if (candidate.cwd !== undefined && !boundedString(candidate.cwd, MAX_BUNDLED_ARG_CHARS)) return false;
  return true;
}

function atomicWrite(target: string, content: string | Buffer): void {
  const directory = path.dirname(target);
  fs.mkdirSync(directory, { recursive: true });
  const temp = `${target}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  let handle: number | undefined;
  try {
    handle = fs.openSync(temp, 'wx', 0o600);
    fs.writeFileSync(handle, content);
    fs.fsyncSync(handle);
    fs.closeSync(handle);
    handle = undefined;
    fs.renameSync(temp, target);
  } finally {
    if (handle !== undefined) fs.closeSync(handle);
    if (fs.existsSync(temp)) fs.rmSync(temp, { force: true });
  }
}

function structuredCloneConfig(config: DesktopConfig): DesktopConfig {
  return {
    ...config,
    preferences: { ...config.preferences }
  };
}
