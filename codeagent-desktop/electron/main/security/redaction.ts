/**
 * Log redaction helpers (design 6.5).
 * Authorization, cookies and API keys must never reach desktop logs.
 * Secret values (bearer tokens, nonces) must be scrubbed from free text.
 */

const REDACTED_HEADER_NAMES = new Set([
  'authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'proxy-authorization'
]);

export function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (REDACTED_HEADER_NAMES.has(name.toLowerCase())) {
      out[name] = '[REDACTED]';
    } else {
      out[name] = value;
    }
  }
  return out;
}

export function redactSecrets(text: string, secrets: ReadonlyArray<string>): string {
  let out = text;
  for (const secret of secrets) {
    if (secret && secret.length >= 8) {
      out = out.split(secret).join('***');
    }
  }
  return out;
}
