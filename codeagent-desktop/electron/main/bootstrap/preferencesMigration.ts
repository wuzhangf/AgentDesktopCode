/**
 * One-time migration of legacy desktop preferences (settings design SET-2).
 *
 * Before the versioned preferences store existed, the only desktop
 * preference was `preferences.notificationsEnabled` inside config.json.
 * If preferences.json is absent but config.json carries that flag, seed the
 * new store from it once. config.json stays untouched as the source of the
 * attach endpoint / bundled service config; this migration never moves
 * secrets (the token has always lived in token.enc).
 */

import fs from 'node:fs';
import path from 'node:path';
import { DesktopPreferencesStore } from './preferencesStore';

const LEGACY_CONFIG_FILE = 'config.json';

export function migrateLegacyPreferences(configDir: string, store: DesktopPreferencesStore): void {
  const preferencesPath = path.join(configDir, 'preferences.json');
  if (fs.existsSync(preferencesPath)) return;
  try {
    const configPath = path.join(configDir, LEGACY_CONFIG_FILE);
    if (!fs.existsSync(configPath)) return;
    const raw = fs.readFileSync(configPath, 'utf8');
    if (raw.length > 64 * 1024) return;
    const parsed = JSON.parse(raw) as {
      preferences?: { notificationsEnabled?: unknown };
    } | null;
    const notificationsEnabled = parsed?.preferences?.notificationsEnabled;
    if (typeof notificationsEnabled !== 'boolean') return;
    const current = store.load();
    if (current.revision !== 1) return;
    store.applyUpdate({
      expectedRevision: current.revision,
      notificationsEnabled
    });
  } catch {
    // migration is best-effort: defaults remain authoritative on failure
  }
}
