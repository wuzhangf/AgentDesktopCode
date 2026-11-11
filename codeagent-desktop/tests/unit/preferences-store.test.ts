/**
 * Desktop preferences store unit tests (settings design §9.3, §13.2).
 * Covers defaults, roundtrip, optimistic revision, corruption fail-closed,
 * oversize, unknown-field rejection, migration and atomic replace failure.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DesktopPreferencesStore,
  admitPreferencesUpdate
} from '../../electron/main/bootstrap/preferencesStore';
import { migrateLegacyPreferences } from '../../electron/main/bootstrap/preferencesMigration';
import { DEFAULT_DESKTOP_PREFERENCES } from '../../electron/shared/settings-types';

let configDir: string;

beforeEach(() => {
  configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codeagent-prefs-'));
});

afterEach(() => {
  fs.rmSync(configDir, { recursive: true, force: true });
});

describe('desktop preferences store', () => {
  it('returns defaults when no file exists', () => {
    const store = new DesktopPreferencesStore(configDir);
    expect(store.load()).toEqual(DEFAULT_DESKTOP_PREFERENCES);
  });

  it('persists an update with a bumped revision and reads it back', () => {
    const store = new DesktopPreferencesStore(configDir);
    const result = store.applyUpdate({
      expectedRevision: 1,
      density: 'DETAILED',
      uiScalePercent: 110,
      sendShortcut: 'MOD_ENTER'
    });
    expect(result.conflict).toBeUndefined();
    expect(result.applied.revision).toBe(2);
    expect(result.applied.density).toBe('DETAILED');
    expect(result.applied.uiScalePercent).toBe(110);
    expect(result.applied.sendShortcut).toBe('MOD_ENTER');
    // New instance reads the same authoritative state from disk.
    const second = new DesktopPreferencesStore(configDir);
    expect(second.load().density).toBe('DETAILED');
  });

  it('persists the first-turn workspace listing preference', () => {
    const store = new DesktopPreferencesStore(configDir);
    const result = store.applyUpdate({ expectedRevision: 1, initialWorkspaceListing: false });
    expect(result.applied.initialWorkspaceListing).toBe(false);
    expect(new DesktopPreferencesStore(configDir).load().initialWorkspaceListing).toBe(false);
    expect(admitPreferencesUpdate({ expectedRevision: 2, initialWorkspaceListing: 'yes' }).ok).toBe(false);
  });

  it('rejects a stale expectedRevision and reports a conflict without writing', () => {
    const store = new DesktopPreferencesStore(configDir);
    store.applyUpdate({ expectedRevision: 1, theme: 'DARK' });
    const stale = store.applyUpdate({ expectedRevision: 1, theme: 'LIGHT' });
    expect(stale.conflict).toEqual({ expectedRevision: 1, currentRevision: 2 });
    expect(store.load().theme).toBe('DARK');
  });

  it('fails closed to defaults on corrupt JSON instead of guessing', () => {
    fs.writeFileSync(path.join(configDir, 'preferences.json'), '{not json', 'utf8');
    const store = new DesktopPreferencesStore(configDir);
    expect(store.load()).toEqual(DEFAULT_DESKTOP_PREFERENCES);
  });

  it('fails closed on an unknown schemaVersion and on oversized files', () => {
    fs.writeFileSync(path.join(configDir, 'preferences.json'), JSON.stringify({
      schemaVersion: 'desktop-preferences/99', revision: 7
    }), 'utf8');
    expect(new DesktopPreferencesStore(configDir).load()).toEqual(DEFAULT_DESKTOP_PREFERENCES);

    fs.writeFileSync(path.join(configDir, 'preferences.json'), 'x'.repeat(64 * 1024), 'utf8');
    expect(new DesktopPreferencesStore(configDir).load()).toEqual(DEFAULT_DESKTOP_PREFERENCES);
  });

  it('coerces out-of-domain persisted values back into the closed sets', () => {
    fs.writeFileSync(path.join(configDir, 'preferences.json'), JSON.stringify({
      schemaVersion: 'desktop-preferences/1',
      revision: 4,
      uiScalePercent: 133,
      codeFontSizePx: 99,
      theme: 'NEON',
      density: 'COMPACT',
      notificationsEnabled: 'yes'
    }), 'utf8');
    const loaded = new DesktopPreferencesStore(configDir).load();
    expect(loaded.uiScalePercent).toBe(100);
    expect(loaded.codeFontSizePx).toBe(18);
    expect(loaded.theme).toBe(DEFAULT_DESKTOP_PREFERENCES.theme);
    expect(loaded.density).toBe(DEFAULT_DESKTOP_PREFERENCES.density);
    expect(loaded.notificationsEnabled).toBe(true);
  });

  it('leaves no temp file behind after an atomic persist', () => {
    const store = new DesktopPreferencesStore(configDir);
    store.applyUpdate({ expectedRevision: 1, notificationsEnabled: false });
    expect(fs.existsSync(path.join(configDir, 'preferences.json'))).toBe(true);
    expect(fs.existsSync(path.join(configDir, 'preferences.json.tmp'))).toBe(false);
    expect(store.load().notificationsEnabled).toBe(false);
  });
});

describe('preferences admission', () => {
  it('rejects unknown fields instead of passing them through', () => {
    const result = admitPreferencesUpdate({ expectedRevision: 1, bearerToken: 'secret' });
    expect(result.ok).toBe(false);
  });

  it('rejects invalid enums, out-of-range scale and a missing revision', () => {
    expect(admitPreferencesUpdate({ expectedRevision: 1, theme: 'NEON' }).ok).toBe(false);
    expect(admitPreferencesUpdate({ expectedRevision: 1, uiScalePercent: 150 }).ok).toBe(false);
    expect(admitPreferencesUpdate({ expectedRevision: 1, codeFontSizePx: 40 }).ok).toBe(false);
    expect(admitPreferencesUpdate({ density: 'STANDARD' }).ok).toBe(false);
    expect(admitPreferencesUpdate(null).ok).toBe(false);
  });

  it('accepts a valid partial update', () => {
    const result = admitPreferencesUpdate({ expectedRevision: 3, reduceMotion: 'ON' });
    expect(result.ok).toBe(true);
  });
});

describe('legacy preferences migration', () => {
  it('seeds notificationsEnabled from config.json once', () => {
    fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify({
      preferences: { notificationsEnabled: false }
    }), 'utf8');
    const store = new DesktopPreferencesStore(configDir);
    migrateLegacyPreferences(configDir, store);
    expect(store.load().notificationsEnabled).toBe(false);
    // A second run is a no-op (preferences.json now exists).
    migrateLegacyPreferences(configDir, store);
    expect(store.load().notificationsEnabled).toBe(false);
  });

  it('does nothing when config.json has no legacy preference', () => {
    const store = new DesktopPreferencesStore(configDir);
    migrateLegacyPreferences(configDir, store);
    expect(store.load()).toEqual(DEFAULT_DESKTOP_PREFERENCES);
  });

  it('never writes a token into the preferences file', () => {
    const store = new DesktopPreferencesStore(configDir);
    store.applyUpdate({ expectedRevision: 1, language: 'zh-CN' });
    const raw = fs.readFileSync(path.join(configDir, 'preferences.json'), 'utf8');
    expect(raw).not.toContain('token');
    expect(JSON.parse(raw)).toEqual(store.load());
  });
});
