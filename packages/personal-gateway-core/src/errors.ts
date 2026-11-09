/**
 * Personal gateway error surface (PAE P0 freeze §4).
 *
 * Every failure crossing `/api/personal/v1` is the frozen shape
 * `{error:{code,message,retryable,requestId}}`. `ManagementError` is thrown
 * inside the gateway; `UpstreamProblem` wraps a ServiceClient/EnvClient
 * problem so the route layer can preserve the stable upstream code.
 */
export class ManagementError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly retryable = false,
  ) {
    super(message);
  }
}

export const invalid = (message = 'Invalid bounded personal gateway request'): never => {
  throw new ManagementError(400, 'INVALID_REQUEST', message, false);
};

export const conflict = (code: string, message: string): never => {
  throw new ManagementError(409, code, message, false);
};

export interface PersonalErrorShape {
  error: {
    code: string;
    message: string;
    retryable: boolean;
    requestId: string;
  };
}

export function toPersonalError(status: number, code: string, message: string,
    retryable: boolean, requestId: string): PersonalErrorShape {
  return { error: { code, message: message.slice(0, 1024), retryable, requestId } };
}

/** Bounded free text: control characters rejected by the contract stay out. */
export function boundedText(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}
