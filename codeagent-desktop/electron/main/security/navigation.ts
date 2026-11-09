/**
 * Navigation and external URL policy (design 6.2 / ADR-E002).
 * Renderer navigation is denied by default; only app:// content is allowed.
 * External URLs must be https and are opened by main via shell, never by renderer.
 */

export type NavigationDecision = 'ALLOW' | 'DENY';

export function isInternalAppUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'app:';
  } catch {
    return false;
  }
}

/**
 * Only https: URLs with a hostname and without embedded credentials may be
 * opened externally. Any other scheme is rejected fail-closed.
 */
export function isHttpsExternalUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') return false;
    if (!parsed.hostname) return false;
    if (parsed.username || parsed.password) return false;
    return true;
  } catch {
    return false;
  }
}

/**
 * Loopback http URLs (dev servers detected in terminal output) are safe to
 * open in the system browser: no credentials, loopback hostname only.
 */
export function isLoopbackHttpUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:') return false;
    if (parsed.username || parsed.password) return false;
    const host = parsed.hostname.toLowerCase();
    return host === 'localhost' || host.endsWith('.localhost')
      || host === '127.0.0.1' || host === '[::1]';
  } catch {
    return false;
  }
}

/** External-open allowlist: https anywhere, or http on loopback only. */
export function isAllowedExternalUrl(url: string): boolean {
  return isHttpsExternalUrl(url) || isLoopbackHttpUrl(url);
}

export function navigationDecision(currentUrl: string, targetUrl: string): NavigationDecision {
  if (!isInternalAppUrl(currentUrl)) return 'DENY';
  if (!isInternalAppUrl(targetUrl)) return 'DENY';
  return 'ALLOW';
}
