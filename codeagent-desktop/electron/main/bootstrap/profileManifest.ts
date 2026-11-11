import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const PROFILE_MANIFEST_SCHEMA_VERSION = 'desktop-profile/1' as const;
const MANIFEST_FILE = 'profile-manifest.json';
const MAX_MANIFEST_BYTES = 4096;
const PROFILE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,47}$/;
const WINDOWS_DEVICE_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ISO_INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export interface ProfileManifest {
  schemaVersion: typeof PROFILE_MANIFEST_SCHEMA_VERSION;
  profileId: string;
  channel: string;
  createdByVersion: string;
  clientId: string;
  processInstanceId: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProfileManifestOptions {
  now?: () => string | Date;
  randomUUID?: () => string;
  channel?: string;
  createdByVersion?: string;
}

export class ProfileManifestError extends Error {
  readonly code = 'PROFILE_MANIFEST_INVALID';

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ProfileManifestError';
  }
}

function timestamp(now: () => string | Date): string {
  const value = now();
  const result = value instanceof Date ? value.toISOString() : value;
  if (!ISO_INSTANT_PATTERN.test(result)) throw new ProfileManifestError('clock returned an invalid timestamp');
  return result;
}

function uuid(randomUUID: () => string): string {
  const value = randomUUID();
  if (!UUID_PATTERN.test(value)) throw new ProfileManifestError('random source returned an invalid UUID');
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseManifest(raw: string, profileId: string, channel: string, createdByVersion: string): ProfileManifest {
  if (Buffer.byteLength(raw, 'utf8') > MAX_MANIFEST_BYTES) throw new ProfileManifestError('manifest is too large');
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new ProfileManifestError('manifest is not valid JSON', { cause: error });
  }
  if (!isRecord(value) || value.schemaVersion !== PROFILE_MANIFEST_SCHEMA_VERSION || value.profileId !== profileId) {
    throw new ProfileManifestError('manifest schema or profile does not match');
  }
  const legacyKeys = ['schemaVersion', 'profileId', 'clientId', 'createdAt', 'lastProcessInstanceId', 'updatedAt'];
  const currentKeys = [...legacyKeys, 'channel', 'createdByVersion'];
  const keys = Object.keys(value);
  if ((keys.length !== legacyKeys.length && keys.length !== currentKeys.length)
      || keys.some((key) => !currentKeys.includes(key))
      || legacyKeys.some((key) => !(key in value))) {
    throw new ProfileManifestError('manifest contains an invalid field set');
  }
  if (typeof value.clientId !== 'string' || !UUID_PATTERN.test(value.clientId) ||
      typeof value.lastProcessInstanceId !== 'string' || !UUID_PATTERN.test(value.lastProcessInstanceId) ||
      typeof value.createdAt !== 'string' || !ISO_INSTANT_PATTERN.test(value.createdAt) ||
      typeof value.updatedAt !== 'string' || !ISO_INSTANT_PATTERN.test(value.updatedAt) ||
      ('channel' in value && (typeof value.channel !== 'string' || !PROFILE_ID_PATTERN.test(value.channel)
        || WINDOWS_DEVICE_NAME.test(value.channel) || value.channel !== channel)) ||
      ('createdByVersion' in value && (typeof value.createdByVersion !== 'string'
        || value.createdByVersion.length === 0 || value.createdByVersion.length > 128
        || !/^[\x20-\x7e]+$/.test(value.createdByVersion)))) {
    throw new ProfileManifestError('manifest contains an invalid field value');
  }
  return {
      schemaVersion: PROFILE_MANIFEST_SCHEMA_VERSION,
      profileId,
      channel,
      createdByVersion: typeof value.createdByVersion === 'string' ? value.createdByVersion : createdByVersion,
      clientId: value.clientId,
    processInstanceId: value.lastProcessInstanceId,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt
  };
}

function persist(profileDir: string, manifest: ProfileManifest, randomUUID: () => string): void {
  const target = path.join(profileDir, MANIFEST_FILE);
  const temp = path.join(profileDir, `.${MANIFEST_FILE}.${uuid(randomUUID)}.tmp`);
  const stored = {
    schemaVersion: manifest.schemaVersion,
    profileId: manifest.profileId,
    channel: manifest.channel,
    createdByVersion: manifest.createdByVersion,
    clientId: manifest.clientId,
    createdAt: manifest.createdAt,
    lastProcessInstanceId: manifest.processInstanceId,
    updatedAt: manifest.updatedAt
  };
  const content = `${JSON.stringify(stored)}\n`;
  if (Buffer.byteLength(content, 'utf8') > MAX_MANIFEST_BYTES) throw new ProfileManifestError('manifest is too large');
  let handle: number | undefined;
  try {
    handle = fs.openSync(temp, 'wx', 0o600);
    fs.writeFileSync(handle, content, { encoding: 'utf8' });
    fs.fsyncSync(handle);
    fs.closeSync(handle);
    handle = undefined;
    fs.renameSync(temp, target);
  } catch (error) {
    if (handle !== undefined) fs.closeSync(handle);
    throw new ProfileManifestError('manifest could not be persisted', { cause: error });
  } finally {
    if (fs.existsSync(temp)) fs.rmSync(temp, { force: true });
  }
}

function preserveInvalidManifest(profileDir: string, randomUUID: () => string): void {
  const source = path.join(profileDir, MANIFEST_FILE);
  const backup = path.join(profileDir, `.${MANIFEST_FILE}.invalid.${uuid(randomUUID)}.json`);
  try {
    fs.renameSync(source, backup);
  } catch (error) {
    throw new ProfileManifestError('invalid manifest could not be preserved', { cause: error });
  }
}

export function loadOrCreateProfileManifest(
  profileDir: string,
  profileId: string,
  options: ProfileManifestOptions = {}
): ProfileManifest {
  if (!PROFILE_ID_PATTERN.test(profileId) || WINDOWS_DEVICE_NAME.test(profileId)) {
    throw new ProfileManifestError('profileId has an invalid format');
  }
  const now = options.now ?? (() => new Date());
  const randomUUID = options.randomUUID ?? crypto.randomUUID;
  const channel = options.channel ?? 'default';
  const createdByVersion = options.createdByVersion ?? 'unknown';
  if (!/^[a-z0-9][a-z0-9-]{0,47}$/.test(channel) || channel.includes('.')) {
    throw new ProfileManifestError('channel has an invalid format');
  }
  if (createdByVersion.length === 0 || createdByVersion.length > 128 || !/^[\x20-\x7e]+$/.test(createdByVersion)) {
    throw new ProfileManifestError('createdByVersion has an invalid format');
  }
  fs.mkdirSync(profileDir, { recursive: true });
  const target = path.join(profileDir, MANIFEST_FILE);
  let previous: ProfileManifest | undefined;
  if (fs.existsSync(target)) {
    try {
      previous = parseManifest(fs.readFileSync(target, 'utf8'), profileId, channel, createdByVersion);
    } catch {
      preserveInvalidManifest(profileDir, randomUUID);
    }
  }
  const current: ProfileManifest = {
    schemaVersion: PROFILE_MANIFEST_SCHEMA_VERSION,
    profileId,
    channel,
    createdByVersion: previous?.createdByVersion ?? createdByVersion,
    clientId: previous?.clientId ?? uuid(randomUUID),
    processInstanceId: uuid(randomUUID),
    createdAt: previous?.createdAt ?? timestamp(now),
    updatedAt: timestamp(now)
  };
  persist(profileDir, current, randomUUID);
  return current;
}
