import {
  decodeFailure,
  type FailureDescriptor
} from '../../../packages/protocol/src/failureContract';

function boundedLegacyText(value: unknown, max = 2000): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.slice(0, max) : undefined;
}

function isLegacyFailureState(state: string): boolean {
  return ['FAILED', 'NEEDS_ATTENTION', 'CANCELLED', 'INTERRUPTED', 'TIMED_OUT', 'ABORTED'].includes(state);
}

const REGEX_META = /[.*+?^${}()|[\]\\]/g;

/**
 * Some services restate the failure code inside the message
 * ("CODE – CODE: detail"). The renderer already shows the code separately;
 * collapse the restated code so the line reads once.
 */
export function dedupeFailureMessage(code: string, message: string): string {
  if (!code) return message;
  const escaped = code.replace(REGEX_META, '\\$&');
  return message
    .replace(new RegExp(`${escaped}\\s*[-–—]\\s*${escaped}\\s*[:：]\\s*`, 'g'), '')
    .replace(new RegExp(`^${escaped}\\s*[:：]\\s*`), '')
    .trim() || message;
}

function normalizeDescriptor(failure: FailureDescriptor): FailureDescriptor {
  const safeMessage = dedupeFailureMessage(failure.code, failure.safeMessage);
  return safeMessage === failure.safeMessage ? failure : { ...failure, safeMessage };
}

/**
 * Decode the structured run failure first, then make a one-way compatibility
 * projection for older services. Legacy data is deliberately UNKNOWN-effect
 * and terminal-safe: it must remain visible without authorizing a retry.
 */
export function decodeRunFailure(value: unknown): FailureDescriptor | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const structured = decodeFailure(raw.failure);
  if (structured) return normalizeDescriptor(structured);

  const state = typeof raw.state === 'string' ? raw.state : '';
  const code = boundedLegacyText(raw.failureCode, 128)
    ?? (isLegacyFailureState(state) ? boundedLegacyText(raw.terminationCode, 128) : undefined);
  const message = boundedLegacyText(raw.failureMessage);
  if (!code && !message) return undefined;
  const legacyCode = code ?? 'LEGACY_FAILURE';
  return normalizeDescriptor({
    schemaVersion: 'legacy',
    code: legacyCode,
    domain: 'UNKNOWN',
    phase: 'UNKNOWN',
    disposition: 'TERMINAL',
    effectState: 'UNKNOWN',
    safeMessage: message ?? '未返回可展示的错误输出',
    recovery: {
      mode: 'NONE',
      actor: 'RUNTIME',
      automatic: false,
      sameInputAllowed: false,
      attemptsUsed: 0,
      maxAttempts: 0,
      actionIds: []
    },
    causes: [{ code: legacyCode }]
  });
}
