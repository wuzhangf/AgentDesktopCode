// API error type per §11.4: {error:{code,message,retryable,requestId}}.
import { randomUUID } from 'node:crypto';

export class ApiError extends Error {
  constructor(status, code, message, { retryable = false } = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.retryable = retryable;
  }
  toBody(requestId = randomUUID()) {
    return { error: { code: this.code, message: this.message, retryable: this.retryable, requestId } };
  }
}

// These factories THROW — call sites use bare `badRequest(msg)` for readability.
export const badRequest = (msg) => { throw new ApiError(400, 'BAD_REQUEST', msg); };
export const notFound = (msg = 'not found') => { throw new ApiError(404, 'NOT_FOUND', msg); };
export const conflict = (msg) => { throw new ApiError(409, 'SOURCE_EPOCH_CHANGED', msg, { retryable: true }); };
export const unprocessable = (msg) => { throw new ApiError(422, 'UNSUPPORTED_COMBINATION', msg); };
export const unavailable = (msg) => { throw new ApiError(503, 'SOURCE_UNAVAILABLE', msg, { retryable: true }); };
export const timeout = (msg = 'query timeout') => { throw new ApiError(504, 'QUERY_TIMEOUT', msg, { retryable: true }); };
export const timeoutError = (msg = 'query timeout') => new ApiError(504, 'QUERY_TIMEOUT', msg, { retryable: true });
export const unavailableError = (msg) => new ApiError(503, 'SOURCE_UNAVAILABLE', msg, { retryable: true });

export function toApiError(err) {
  if (err instanceof ApiError) return err;
  const msg = String(err?.message ?? err);
  if (/SQLITE_BUSY|locked/i.test(msg)) return unavailable('source database is busy');
  if (/no such file|ENOENT/i.test(msg)) return unavailable('source database file missing');
  if (/SQLITE_CANTOPEN|unable to open/i.test(msg)) return unavailable('source database cannot be opened');
  if (/no such table|no such column/i.test(msg)) return unprocessable('schema unsupported by this adapter');
  return new ApiError(500, 'INTERNAL', 'internal query error', { retryable: false });
}
