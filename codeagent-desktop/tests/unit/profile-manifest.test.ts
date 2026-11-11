import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadOrCreateProfileManifest, ProfileManifestError } from '../../electron/main/bootstrap/profileManifest';

const roots: string[] = [];
const ids = [
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222',
  '33333333-3333-4333-8333-333333333333',
  '44444444-4444-4444-8444-444444444444'
] as const;

function profileDir(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codeagent-manifest-'));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('loadOrCreateProfileManifest', () => {
  it('creates and persists the first identity', () => {
    const dir = profileDir();
    const result = loadOrCreateProfileManifest(dir, 'desktop-a', {
      now: () => '2026-09-04T00:00:00.000Z', randomUUID: () => ids[0]
    });
    expect(result).toMatchObject({ schemaVersion: 'desktop-profile/1', profileId: 'desktop-a', clientId: ids[0], processInstanceId: ids[0] });
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'profile-manifest.json'), 'utf8'))).toMatchObject({
      channel: 'default', createdByVersion: 'unknown', lastProcessInstanceId: ids[0]
    });
  });

  it('keeps clientId stable and changes processInstanceId', () => {
    const dir = profileDir();
    const first = loadOrCreateProfileManifest(dir, 'desktop-a', { now: () => '2026-09-04T00:00:00.000Z', randomUUID: () => ids[0] });
    const second = loadOrCreateProfileManifest(dir, 'desktop-a', { now: () => '2026-09-04T00:01:00.000Z', randomUUID: () => ids[1] });
    expect(second.clientId).toBe(first.clientId);
    expect(second.processInstanceId).toBe(ids[1]);
  });

  it('does not reuse clientId when the profileId changes', () => {
    const dir = profileDir();
    const first = loadOrCreateProfileManifest(dir, 'desktop-a', { randomUUID: () => ids[0] });
    const second = loadOrCreateProfileManifest(dir, 'desktop-b', { randomUUID: () => ids[1] });
    expect(second.clientId).not.toBe(first.clientId);
  });

  it('rejects corruption and unknown versions without overwriting the old file', () => {
    for (const content of ['{"broken":', '{"schemaVersion":"desktop-profile/99"}']) {
      const dir = profileDir();
      fs.writeFileSync(path.join(dir, 'profile-manifest.json'), content);
      const result = loadOrCreateProfileManifest(dir, 'desktop-a', { randomUUID: () => ids[2], now: () => '2026-09-04T00:00:00.000Z' });
      expect(result.clientId).toBe(ids[2]);
      expect(fs.readdirSync(dir).some((name) => name.startsWith('.profile-manifest.json.invalid.'))).toBe(true);
    }
  });

  it('leaves no temporary manifest after atomic persistence', () => {
    const dir = profileDir();
    loadOrCreateProfileManifest(dir, 'desktop-a', { randomUUID: () => ids[3] });
    expect(fs.readdirSync(dir).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('uses the same bounded profile id grammar as the resolver', () => {
    expect(() => loadOrCreateProfileManifest(profileDir(), 'desktop_profile')).toThrow(ProfileManifestError);
    expect(() => loadOrCreateProfileManifest(profileDir(), `d${'x'.repeat(48)}`)).toThrow(ProfileManifestError);
    expect(() => loadOrCreateProfileManifest(profileDir(), 'con')).toThrow(ProfileManifestError);
  });
});
