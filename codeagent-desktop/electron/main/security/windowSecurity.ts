/**
 * BrowserWindow security baseline (ADR-E002 / design 6.2).
 * Pure data builders so the security contract is unit-testable without Electron.
 */

export interface SecureWebPreferences {
  readonly preload: string;
  readonly nodeIntegration: false;
  readonly contextIsolation: true;
  readonly sandbox: true;
  readonly webSecurity: true;
  readonly allowRunningInsecureContent: false;
  readonly webviewTag: false;
}

export function buildWebPreferences(preloadPath: string): SecureWebPreferences {
  if (!preloadPath) {
    throw new Error('preload path is required');
  }
  return {
    preload: preloadPath,
    nodeIntegration: false,
    contextIsolation: true,
    sandbox: true,
    webSecurity: true,
    allowRunningInsecureContent: false,
    webviewTag: false
  };
}

/** CSP baseline required by design section 6.2. Styles are bundled local
 * assets; the renderer does not need an inline-style policy exception. */
export const CSP_HEADER = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'self'";

/** Privileged app:// scheme registration (must run before app ready). */
export const APP_SCHEME = 'app';
export const APP_HOST = 'codeagent';

export function privilegedSchemes(): Array<{
  scheme: string;
  privileges: { standard: boolean; secure: boolean; supportFetchAPI: boolean; corsEnabled: boolean };
}> {
  return [
    {
      scheme: APP_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: false
      }
    }
  ];
}
