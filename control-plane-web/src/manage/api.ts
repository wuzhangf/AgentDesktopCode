// /api/manage typed client. Mutations carry `x-manage-control: 1` — the
// loopback BFF rejects control requests without it. Errors are ManageProblem
// {error, code, status}; surfaced as ManageApiError (code kept for display).
import { useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { usePageVisible } from '../api/hooks';
import type { ManageProblem } from '../../shared/management/api';

export class ManageApiError extends Error {
  code: string;
  status: number;
  constructor(httpStatus: number, body: unknown) {
    const p = body as ManageProblem | null;
    super(p?.error ?? `请求失败 (HTTP ${httpStatus})`);
    this.code = p?.code ?? `HTTP_${httpStatus}`;
    this.status = p?.status ?? httpStatus;
  }
}

async function manageRequest<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const res = await fetch(`/api/manage${path}`, {
    method,
    credentials: 'same-origin',
    headers: {
      'x-manage-control': '1',
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal,
  });
  const parsed = await res.json().catch(() => null);
  if (!res.ok) throw new ManageApiError(res.status, parsed);
  return parsed as T;
}

export const manageGet = <T,>(path: string, signal?: AbortSignal): Promise<T> =>
  manageRequest<T>('GET', path, undefined, signal);
export const managePost = <T,>(path: string, body?: unknown): Promise<T> =>
  manageRequest<T>('POST', path, body ?? {});
export const managePut = <T,>(path: string, body: unknown): Promise<T> =>
  manageRequest<T>('PUT', path, body);

/** Poll-capable manage query; pauses when the tab is hidden. */
export function useManage<T>(key: readonly unknown[], path: string | null, refetchMs?: number) {
  const visible = usePageVisible();
  return useQuery({
    queryKey: ['manage', ...key],
    queryFn: ({ signal }) => manageGet<T>(path!, signal),
    enabled: path != null,
    staleTime: 2_000,
    refetchInterval: visible && refetchMs ? refetchMs : false,
    retry: 1,
  });
}

export function useInvalidateManage() {
  const qc = useQueryClient();
  return useCallback(() => qc.invalidateQueries({ queryKey: ['manage'] }), [qc]);
}

/** List endpoints may return T[] or { <key>: T[] } — accept both honestly. */
export function asList<T>(d: unknown, key: string): T[] {
  if (Array.isArray(d)) return d as T[];
  const v = (d as Record<string, unknown> | null)?.[key];
  return Array.isArray(v) ? (v as T[]) : [];
}

/** Single-entity endpoints may wrap the record as { <key>: {...} }. */
export function unwrap<T>(d: unknown, key: string): T {
  const v = (d as Record<string, unknown> | null)?.[key];
  return (v ?? d) as T;
}

/** Extract a workerKey from a register/POST response of unknown wrapping. */
export function workerKeyOf(r: unknown): string | null {
  const d = r as { workerKey?: unknown; worker?: { workerKey?: unknown } } | null;
  const k = d?.workerKey ?? d?.worker?.workerKey;
  return typeof k === 'string' && k ? k : null;
}
