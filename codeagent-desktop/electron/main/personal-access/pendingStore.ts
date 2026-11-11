/**
 * Durable pending-intention store for the personal-access connection.
 *
 * Records contain the frozen operation and its receipt locator only — never a
 * token, never a header. Filenames are a digest of the scope+requestId so a
 * request id cannot escape the directory. Corrupt or oversized files fail
 * closed (treated as absent) instead of resurfacing a half-written intention.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { PendingRecord, PendingStore } from '../../../packages/client-access/src/index';

const MAX_RECORD_BYTES = 64 * 1024;

export class FilePendingStore implements PendingStore {
  private readonly directory: string;

  constructor(directory: string) {
    this.directory = directory;
  }

  private fileFor(key: string): string {
    const digest = createHash('sha256').update(key, 'utf8').digest('hex');
    return path.join(this.directory, `${digest}.json`);
  }

  async set(key: string, value: PendingRecord): Promise<void> {
    const serialized = JSON.stringify(value);
    if (Buffer.byteLength(serialized, 'utf8') > MAX_RECORD_BYTES) {
      throw new Error('pending intention exceeds size limit');
    }
    fs.mkdirSync(this.directory, { recursive: true });
    const target = this.fileFor(key);
    const temp = `${target}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
    let handle: number | undefined;
    try {
      handle = fs.openSync(temp, 'wx', 0o600);
      fs.writeFileSync(handle, serialized, 'utf8');
      fs.fsyncSync(handle);
      fs.closeSync(handle);
      handle = undefined;
      fs.renameSync(temp, target);
    } finally {
      if (handle !== undefined) fs.closeSync(handle);
      if (fs.existsSync(temp)) fs.rmSync(temp, { force: true });
    }
  }

  async get(key: string): Promise<PendingRecord | null> {
    try {
      const target = this.fileFor(key);
      if (!fs.existsSync(target)) return null;
      if (fs.statSync(target).size > MAX_RECORD_BYTES) return null;
      const parsed = JSON.parse(fs.readFileSync(target, 'utf8')) as unknown;
      return validRecord(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
}

function validRecord(value: unknown): value is PendingRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const locator = record.locator;
  return typeof record.scope === 'string' && typeof record.path === 'string'
    && typeof record.dispatched === 'boolean' && record.body !== undefined
    && !!locator && typeof locator === 'object' && !Array.isArray(locator)
    && typeof (locator as Record<string, unknown>).kind === 'string';
}
