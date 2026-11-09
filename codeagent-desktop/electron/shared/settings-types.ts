/**
 * Desktop-owned preferences contract (settings design §9.3).
 *
 * These types describe ONLY non-sensitive desktop preferences persisted by
 * Electron main in userData. They must never carry tokens, model keys,
 * paths, endpoints or any service-owned configuration: the bearer token
 * stays in the separate token.enc store and never enters a preferences DTO.
 */

export const DESKTOP_PREFERENCES_SCHEMA_VERSION = 'desktop-preferences/1' as const;

export type DesktopLanguage = 'SYSTEM' | 'zh-CN' | 'en-US';
export type DesktopTheme = 'SYSTEM' | 'DARK' | 'LIGHT';
export type DesktopDensity = 'SUMMARY' | 'STANDARD' | 'DETAILED';
export type DesktopReduceMotion = 'SYSTEM' | 'ON' | 'OFF';
export type DesktopSendShortcut = 'ENTER' | 'MOD_ENTER';

/** UI scale is a closed set; arbitrary percentages are rejected. */
export const UI_SCALE_PERCENTS = [90, 100, 110, 125] as const;
export type DesktopUiScalePercent = (typeof UI_SCALE_PERCENTS)[number];

export const CODE_FONT_SIZE_MIN_PX = 12;
export const CODE_FONT_SIZE_MAX_PX = 18;

export interface DesktopPreferencesResponse {
  schemaVersion: typeof DESKTOP_PREFERENCES_SCHEMA_VERSION;
  revision: number;
  notificationsEnabled: boolean;
  language: DesktopLanguage;
  theme: DesktopTheme;
  density: DesktopDensity;
  uiScalePercent: DesktopUiScalePercent;
  /** 12..18 px; affects code/terminal token only */
  codeFontSizePx: number;
  reduceMotion: DesktopReduceMotion;
  sendShortcut: DesktopSendShortcut;
  restoreLastSurface: boolean;
  /** Whether newly created workspace sessions list the root before the first model turn. */
  initialWorkspaceListing?: boolean;
}

export interface DesktopPreferencesUpdateRequest {
  expectedRevision: number;
  notificationsEnabled?: boolean;
  language?: DesktopLanguage;
  theme?: DesktopTheme;
  density?: DesktopDensity;
  uiScalePercent?: DesktopUiScalePercent;
  codeFontSizePx?: number;
  reduceMotion?: DesktopReduceMotion;
  sendShortcut?: DesktopSendShortcut;
  restoreLastSurface?: boolean;
  initialWorkspaceListing?: boolean;
}

export const DEFAULT_DESKTOP_PREFERENCES: DesktopPreferencesResponse = {
  schemaVersion: DESKTOP_PREFERENCES_SCHEMA_VERSION,
  revision: 1,
  notificationsEnabled: true,
  language: 'SYSTEM',
  theme: 'DARK',
  density: 'STANDARD',
  uiScalePercent: 100,
  codeFontSizePx: 13,
  reduceMotion: 'SYSTEM',
  sendShortcut: 'ENTER',
  restoreLastSurface: false,
  initialWorkspaceListing: true
};
