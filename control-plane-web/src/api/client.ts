import type { Envelope, Page } from '../../shared/contracts/types';

export class ApiClientError extends Error {
  code: string;
  retryable: boolean;
  status: number;
  requestId?: string;
  constructor(status: number, body: unknown) {
    const e = (body as { error?: { code?: string; message?: string; retryable?: boolean; requestId?: string } })?.error;
    super(e?.message ?? `HTTP ${status}`);
    this.code = e?.code ?? `HTTP_${status}`;
    this.retryable = e?.retryable ?? false;
    this.status = status;
    this.requestId = e?.requestId;
  }
}

export async function apiGet<T>(path: string, params?: Record<string, unknown>, signal?: AbortSignal): Promise<Envelope<T>> {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params ?? {})) {
    if (v == null || v === '') continue;
    sp.set(k, String(v));
  }
  const qs = sp.toString();
  const res = await fetch(`/api/v2${path}${qs ? `?${qs}` : ''}`, { signal });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new ApiClientError(res.status, body);
  return body as Envelope<T>;
}

export async function apiGetPage<T>(path: string, params?: Record<string, unknown>, signal?: AbortSignal): Promise<Envelope<Page<T>>> {
  return apiGet<Page<T>>(path, params, signal);
}
