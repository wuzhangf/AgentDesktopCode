/**
 * Versioned desktop preferences store (settings design §9.3, SET-2).
 *
 * Main-owned, non-sensitive preferences only. Rules enforced here:
 * - schemaVersion + optimistic revision on every mutation;
 * - atomic replace (temp file + flush + rename) so a crash never leaves a
 *   half-written JSON behind;
 * - corrupt / oversized / unknown-version files fail closed to defaults,
 *   never to guesses or looser settings;
 * - unknown fields and out-of-range values are rejected, not passed through;
 * - the bearer token lives in the separate token.enc store and can never
 *   enter this file.
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  CODE_FONT_SIZE_MAX_PX,
  CODE_FONT_SIZE_MIN_PX,
  DEFAULT_DESKTOP_PREFERENCES,
  DESKTOP_PREFERENCES_SCHEMA_VERSION,
  UI_SCALE_PERCENTS,
  type DesktopPreferencesResponse,
  type DesktopPreferencesUpdateRequest
} from '../../shared/settings-types';

const PREFERENCES_FILE = 'preferences.json';
const MAX_PREFERENCES_BYTES = 32 * 1024;

export type PreferencesAdmission =
  | { ok: true; value: DesktopPreferencesUpdateRequest }
  | { ok: false; reason: string };

export interface PreferencesUpdateResult {
  applied: DesktopPreferencesResponse;
  /** public-safe conflict projection; never carries the rejected payload */
  conflict?: { expectedRevision: number; currentRevision: number };
}

export class DesktopPreferencesStore {
  private readonly configDir: string;
  private cached: DesktopPreferencesResponse | null = null;

  constructor(configDir: string) {
    if (!configDir) throw new Error('configDir is required');
    this.configDir = configDir;
  }

  private preferencesPath(): string {
    return path.join(this.configDir, PREFERENCES_FILE);
  }

  /** Current authoritative preferences; damaged files fall back to defaults. */
  load(): DesktopPreferencesResponse {
    if (this.cached) return { ...this.cached };
    try {
      if (!fs.existsSync(this.preferencesPath())) {
        this.cached = { ...DEFAULT_DESKTOP_PREFERENCES };
        return { ...this.cached };
      }
      const raw = fs.readFileSync(this.preferencesPath(), 'utf8');
      if (raw.length > MAX_PREFERENCES_BYTES) {
        this.cached = { ...DEFAULT_DESKTOP_PREFERENCES };
        return { ...this.cached };
      }
      const parsed = JSON.parse(raw) as Partial<DesktopPreferencesResponse> | null;
      this.cached = this.coerce(parsed);
    } catch {
      // corrupt JSON: fail closed to defaults, never guess partial values
      this.cached = { ...DEFAULT_DESKTOP_PREFERENCES };
    }
    return { ...this.cached };
  }

  /** Structural validation; anything unknown or out-of-domain falls back. */
  private coerce(parsed: Partial<DesktopPreferencesResponse> | null | undefined): DesktopPreferencesResponse {
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ...DEFAULT_DESKTOP_PREFERENCES };
    }
    if (parsed.schemaVersion !== DESKTOP_PREFERENCES_SCHEMA_VERSION) {
      return { ...DEFAULT_DESKTOP_PREFERENCES };
    }
    const revision = typeof parsed.revision === 'number' && Number.isInteger(parsed.revision) && parsed.revision >= 1
      ? parsed.revision
      : DEFAULT_DESKTOP_PREFERENCES.revision;
    const uiScale = UI_SCALE_PERCENTS.includes(parsed.uiScalePercent as (typeof UI_SCALE_PERCENTS)[number])
      ? parsed.uiScalePercent as DesktopPreferencesResponse['uiScalePercent']
      : DEFAULT_DESKTOP_PREFERENCES.uiScalePercent;
    const codeFontSizePx = typeof parsed.codeFontSizePx === 'number'
      && Number.isFinite(parsed.codeFontSizePx)
        ? Math.min(CODE_FONT_SIZE_MAX_PX, Math.max(CODE_FONT_SIZE_MIN_PX, Math.round(parsed.codeFontSizePx)))
        : DEFAULT_DESKTOP_PREFERENCES.codeFontSizePx;
    return {
      schemaVersion: DESKTOP_PREFERENCES_SCHEMA_VERSION,
      revision,
      notificationsEnabled: parsed.notificationsEnabled !== false,
      language: isOneOf(parsed.language, ['SYSTEM', 'zh-CN', 'en-US'] as const)
        ? parsed.language : DEFAULT_DESKTOP_PREFERENCES.language,
      theme: isOneOf(parsed.theme, ['SYSTEM', 'DARK', 'LIGHT'] as const)
        ? parsed.theme : DEFAULT_DESKTOP_PREFERENCES.theme,
      density: isOneOf(parsed.density, ['SUMMARY', 'STANDARD', 'DETAILED'] as const)
        ? parsed.density : DEFAULT_DESKTOP_PREFERENCES.density,
      uiScalePercent: uiScale,
      codeFontSizePx,
      reduceMotion: isOneOf(parsed.reduceMotion, ['SYSTEM', 'ON', 'OFF'] as const)
        ? parsed.reduceMotion : DEFAULT_DESKTOP_PREFERENCES.reduceMotion,
      sendShortcut: isOneOf(parsed.sendShortcut, ['ENTER', 'MOD_ENTER'] as const)
        ? parsed.sendShortcut : DEFAULT_DESKTOP_PREFERENCES.sendShortcut,
      restoreLastSurface: parsed.restoreLastSurface === true,
      initialWorkspaceListing: parsed.initialWorkspaceListing !== false
    };
  }

  /**
   * Strict admission for a renderer mutation. Unknown fields are rejected
   * (fail closed) instead of silently dropped, so a renderer/contract drift
   * becomes visible instead of corrupting the persisted shape.
   */
  admitUpdate(payload: unknown): PreferencesAdmission {
    return admitPreferencesUpdate(payload);
  }

  /**
   * Applies an admitted update with optimistic revision checking.
   * Returns the new authoritative projection, or a conflict projection that
   * must be surfaced to the renderer without overwriting the newer state.
   */
  applyUpdate(request: DesktopPreferencesUpdateRequest): PreferencesUpdateResult {
    const current = this.load();
    if (current.revision !== request.expectedRevision) {
      return {
        applied: current,
        conflict: { expectedRevision: request.expectedRevision, currentRevision: current.revision }
      };
    }
    const next: DesktopPreferencesResponse = {
      ...current,
      notificationsEnabled: request.notificationsEnabled ?? current.notificationsEnabled,
      language: request.language ?? current.language,
      theme: request.theme ?? current.theme,
      density: request.density ?? current.density,
      uiScalePercent: request.uiScalePercent ?? current.uiScalePercent,
      codeFontSizePx: request.codeFontSizePx ?? current.codeFontSizePx,
      reduceMotion: request.reduceMotion ?? current.reduceMotion,
      sendShortcut: request.sendShortcut ?? current.sendShortcut,
      restoreLastSurface: request.restoreLastSurface ?? current.restoreLastSurface,
      initialWorkspaceListing: request.initialWorkspaceListing ?? current.initialWorkspaceListing ?? true,
      revision: current.revision + 1
    };
    this.persist(next);
    return { applied: next };
  }

  /** Temp file + flush + rename so an interrupted write cannot truncate. */
  private persist(preferences: DesktopPreferencesResponse): void {
    fs.mkdirSync(this.configDir, { recursive: true });
    const serialized = JSON.stringify(preferences, null, 2);
    if (serialized.length > MAX_PREFERENCES_BYTES) {
      throw new Error('desktop preferences exceed size limit');
    }
    const target = this.preferencesPath();
    const temp = `${target}.tmp`;
    const handle = fs.openSync(temp, 'w');
    try {
      fs.writeFileSync(handle, serialized, 'utf8');
      fs.fsyncSync(handle);
    } finally {
      fs.closeSync(handle);
    }
    fs.renameSync(temp, target);
    this.cached = { ...preferences };
  }

  /** Test/diagnostic hook: forget the in-memory projection. */
  invalidateCache(): void {
    this.cached = null;
  }
}

/**
 * Strict admission for a renderer preferences mutation. Unknown fields are
 * rejected (fail closed) instead of silently dropped, so a renderer/contract
 * drift becomes visible instead of corrupting the persisted shape.
 * Shared by the IPC registry definition and the store itself.
 */
export function admitPreferencesUpdate(payload: unknown): PreferencesAdmission {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return { ok: false, reason: 'payload must be an object' };
  }
  const record = payload as Record<string, unknown>;
  const allowed = new Set([
    'expectedRevision', 'notificationsEnabled', 'language', 'theme', 'density',
    'uiScalePercent', 'codeFontSizePx', 'reduceMotion', 'sendShortcut', 'restoreLastSurface',
    'initialWorkspaceListing'
  ]);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) return { ok: false, reason: `unknown field: ${key}` };
  }
  if (typeof record.expectedRevision !== 'number' || !Number.isInteger(record.expectedRevision)
      || record.expectedRevision < 1) {
    return { ok: false, reason: 'expectedRevision must be a positive integer' };
  }
  const out: DesktopPreferencesUpdateRequest = { expectedRevision: record.expectedRevision };
  if (record.notificationsEnabled !== undefined) {
    if (typeof record.notificationsEnabled !== 'boolean') return { ok: false, reason: 'notificationsEnabled must be a boolean' };
    out.notificationsEnabled = record.notificationsEnabled;
  }
  if (record.language !== undefined) {
    if (!isOneOf(record.language, ['SYSTEM', 'zh-CN', 'en-US'] as const)) return { ok: false, reason: 'language is invalid' };
    out.language = record.language;
  }
  if (record.theme !== undefined) {
    if (!isOneOf(record.theme, ['SYSTEM', 'DARK', 'LIGHT'] as const)) return { ok: false, reason: 'theme is invalid' };
    out.theme = record.theme;
  }
  if (record.density !== undefined) {
    if (!isOneOf(record.density, ['SUMMARY', 'STANDARD', 'DETAILED'] as const)) return { ok: false, reason: 'density is invalid' };
    out.density = record.density;
  }
  if (record.uiScalePercent !== undefined) {
    if (!UI_SCALE_PERCENTS.includes(record.uiScalePercent as (typeof UI_SCALE_PERCENTS)[number])) {
      return { ok: false, reason: 'uiScalePercent must be 90, 100, 110 or 125' };
    }
    out.uiScalePercent = record.uiScalePercent as DesktopPreferencesResponse['uiScalePercent'];
  }
  if (record.codeFontSizePx !== undefined) {
    if (typeof record.codeFontSizePx !== 'number' || !Number.isInteger(record.codeFontSizePx)
        || record.codeFontSizePx < CODE_FONT_SIZE_MIN_PX || record.codeFontSizePx > CODE_FONT_SIZE_MAX_PX) {
      return { ok: false, reason: `codeFontSizePx must be an integer between ${CODE_FONT_SIZE_MIN_PX} and ${CODE_FONT_SIZE_MAX_PX}` };
    }
    out.codeFontSizePx = record.codeFontSizePx;
  }
  if (record.reduceMotion !== undefined) {
    if (!isOneOf(record.reduceMotion, ['SYSTEM', 'ON', 'OFF'] as const)) return { ok: false, reason: 'reduceMotion is invalid' };
    out.reduceMotion = record.reduceMotion;
  }
  if (record.sendShortcut !== undefined) {
    if (!isOneOf(record.sendShortcut, ['ENTER', 'MOD_ENTER'] as const)) return { ok: false, reason: 'sendShortcut is invalid' };
    out.sendShortcut = record.sendShortcut;
  }
  if (record.restoreLastSurface !== undefined) {
    if (typeof record.restoreLastSurface !== 'boolean') return { ok: false, reason: 'restoreLastSurface must be a boolean' };
    out.restoreLastSurface = record.restoreLastSurface;
  }
  if (record.initialWorkspaceListing !== undefined) {
    if (typeof record.initialWorkspaceListing !== 'boolean') return { ok: false, reason: 'initialWorkspaceListing must be a boolean' };
    out.initialWorkspaceListing = record.initialWorkspaceListing;
  }
  return { ok: true, value: out };
}

function isOneOf<T extends readonly string[]>(
  value: unknown,
  allowed: T
): value is T[number] {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value);
}
