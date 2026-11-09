import type { FailureDescriptor, OperationOutcome, RunSchedulingProjection } from './failureContract';

export interface ProxyResult<T> {
  error?: string;
  code?: string;
  status?: number;
  failure?: FailureDescriptor;
  scheduling?: RunSchedulingProjection;
  reasonCode?: string;
  operationOutcome?: OperationOutcome;
  receiptId?: string;
  correlationId?: string;
}

export class DesktopProxyError extends Error {
  constructor(public readonly code: string, message: string,
    public readonly details: Omit<ProxyResult<unknown>, 'error' | 'code'> = {}) {
    super(message);
    this.name = 'DesktopProxyError';
  }
}

/** Shared transport envelope; unknown effects retain the original operation. */
export function unwrap<T>(result: unknown): T {
  if (result !== null && typeof result === 'object' && 'error' in result) {
    const proxy = result as ProxyResult<T>;
    const code = proxy.code ?? 'PROXY_FAILED';
    throw new DesktopProxyError(code, proxy.error ?? code, {
      status: proxy.status, failure: proxy.failure, scheduling: proxy.scheduling,
      reasonCode: proxy.reasonCode, operationOutcome: proxy.operationOutcome,
      receiptId: proxy.receiptId, correlationId: proxy.correlationId,
    });
  }
  return result as T;
}
