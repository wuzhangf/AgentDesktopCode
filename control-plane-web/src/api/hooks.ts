// Query hooks: key includes sourceId + scope + normalized params (§10.4).
// Polling: LIVE visible → caller-provided interval; background tab → paused
// (Query's refetchOnWindowFocus revalidates on return).
import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { apiGet, apiGetPage } from './client';
import { apiParams, useFilters } from '../state/filters';
import type { Envelope, Page } from '../../shared/contracts/types';
import { useEffect, useState } from 'react';

export function usePageVisible(): boolean {
  const [visible, setVisible] = useState(!document.hidden);
  useEffect(() => {
    const fn = () => setVisible(!document.hidden);
    document.addEventListener('visibilitychange', fn);
    return () => document.removeEventListener('visibilitychange', fn);
  }, []);
  return visible;
}

interface Opts {
  liveIntervalMs?: number | false;
  extraParams?: Record<string, unknown>;
  enabled?: boolean;
  keepPreviousData?: boolean;
  /** Global filter keys this endpoint accepts (e.g. WINDOW_FILTER_KEYS). */
  globalFilters?: readonly string[];
}

export function useApi<T>(path: string, params?: Record<string, unknown>, opts?: Opts): UseQueryResult<Envelope<T>> {
  const { filters, sourceEpoch, isLive } = useFilters();
  const visible = usePageVisible();
  const merged = { ...apiParams(filters, opts?.globalFilters), ...params, ...opts?.extraParams };
  const interval = isLive && visible && opts?.liveIntervalMs ? opts.liveIntervalMs : false;
  return useQuery({
    queryKey: ['v2', path, filters.sourceId, filters.scopeId, sourceEpoch, merged],
    queryFn: ({ signal }) => apiGet<T>(path, merged, signal),
    staleTime: isLive ? 4_000 : 60_000,
    refetchInterval: interval,
    retry: (count, err) => count < 1 && (err as { retryable?: boolean })?.retryable === true,
    enabled: opts?.enabled !== false && !!filters.sourceId,
    placeholderData: opts?.keepPreviousData ? (prev) => prev : undefined,
  });
}

export function useApiPage<T>(path: string, params?: Record<string, unknown>, opts?: Opts): UseQueryResult<Envelope<Page<T>>> {
  const { filters, sourceEpoch, isLive } = useFilters();
  const visible = usePageVisible();
  const merged = { ...apiParams(filters, opts?.globalFilters), ...params, ...opts?.extraParams };
  const interval = isLive && visible && opts?.liveIntervalMs ? opts.liveIntervalMs : false;
  return useQuery({
    queryKey: ['v2', path, filters.sourceId, filters.scopeId, sourceEpoch, merged],
    queryFn: ({ signal }) => apiGetPage<T>(path, merged, signal),
    staleTime: isLive ? 4_000 : 60_000,
    refetchInterval: interval,
    retry: (count, err) => count < 1 && (err as { retryable?: boolean })?.retryable === true,
    enabled: opts?.enabled !== false && !!filters.sourceId,
    placeholderData: (prev) => prev,
  });
}
