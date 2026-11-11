/**
 * Service token and nonce generation (design 6.4).
 * Tokens are at least 256-bit, transferred only via child environment,
 * never via command line, logs or renderer.
 */

import crypto from 'node:crypto';

/** 256-bit URL-safe token (43 base64url chars). */
export function generateServiceToken(): string {
  return crypto.randomBytes(32).toString('base64url');
}

/** 128-bit startup nonce used to identify an owned child process. */
export function generateStartNonce(): string {
  return crypto.randomBytes(16).toString('base64url');
}
