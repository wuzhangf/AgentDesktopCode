// Global filter state lives in URL search params (§3.2) so links are shareable
// and Back restores filters/zoom/sort. HashRouter puts params inside the hash —
// useSearchParams still works.
import { createContext, useCallback, useContext, useMemo, type ReactNode } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet } from '../api/client';
import type { SourceInfo } from '../../shared/contracts/types';

export interface Filters {
  sourceId: string;
  scopeId: string;
  from: number | null;
  to: number | null;
  timezone: string;
  grain: string | null;
  compare: boolean;
  product: string | null;
  runKind: string | null;
  configRevision: string | null;
  [key: string]: string | number | boolean | null;
}

const FILTER_KEYS = [
  'sourceId', 'scopeId', 'from', 'to', 'timezone', 'grain', 'compare',
  'product', 'runKind', 'configRevision',
];

interface SourcesData { sources: SourceInfo[]; defaultSourceId: string; guiAvailable: boolean }

export function useSources(enabled = true) {
  return useQuery({
    queryKey: ['v2', 'meta', 'sources'],
    queryFn: ({ signal }) => apiGet<SourcesData>('/meta/sources', undefined, signal),
    staleTime: 30_000,
    retry: 1,
    enabled,
  });
}

interface FilterCtx {
  filters: Filters;
  setFilter: (key: string, value: string | number | boolean | null) => void;
  setFilters: (patch: Record<string, string | number | boolean | null>) => void;
  resetWindow: () => void;
  locateDataWindow: () => void;
  source: SourceInfo | null;
  sourceEpoch: string;
  isLive: boolean;
  isDemo: boolean;
  dataAsOf: number | null;
}

const Ctx = createContext<FilterCtx | null>(null);

export function FilterProvider({ children }: { children: ReactNode }) {
  const [sp, setSp] = useSearchParams();
  // Sources feed the analytics FilterBar only — the manage console must not
  // hit :8788 when it is not running.
  const sourcesQ = useSources(useLocation().pathname.startsWith('/analysis'));
  const sources = sourcesQ.data?.data.sources ?? [];
  const defaultId = sourcesQ.data?.data.defaultSourceId ?? '';

  const filters = useMemo<Filters>(() => {
    const num = (k: string) => {
      const v = sp.get(k);
      if (v == null) return null;
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    };
    const f: Filters = {
      sourceId: sp.get('sourceId') ?? defaultId,
      scopeId: sp.get('scopeId') ?? 'local',
      from: num('from'), to: num('to'),
      timezone: sp.get('timezone') ?? 'Asia/Shanghai',
      grain: sp.get('grain'),
      compare: sp.get('compare') === 'prev',
      product: sp.get('product'), runKind: sp.get('runKind'),
      configRevision: sp.get('configRevision'),
    };
    for (const [k, v] of sp.entries()) {
      if (!(k in f)) f[k] = v;
    }
    return f;
  }, [sp, defaultId]);

  const setFilters = useCallback((patch: Record<string, string | number | boolean | null>) => {
    setSp((prev) => {
      const next = new URLSearchParams(prev);
      for (const [k, v] of Object.entries(patch)) {
        if (v == null || v === '' || v === false) next.delete(k);
        else next.set(k, String(v));
      }
      return next;
    }, { replace: false });
  }, [setSp]);

  const setFilter = useCallback((key: string, value: string | number | boolean | null) => {
    setFilters({ [key]: value });
  }, [setFilters]);

  const source = sources.find((s) => s.id === filters.sourceId) ?? null;
  const dataAsOf = source?.dataAsOf ?? null;

  const resetWindow = useCallback(() => setFilters({ from: null, to: null }), [setFilters]);
  const locateDataWindow = useCallback(() => {
    if (dataAsOf == null) return;
    setFilters({ from: dataAsOf - 24 * 3_600_000, to: dataAsOf + 60_000 });
  }, [dataAsOf, setFilters]);

  const value: FilterCtx = {
    filters, setFilter, setFilters, resetWindow, locateDataWindow,
    source,
    sourceEpoch: source?.sourceEpoch ?? '',
    isLive: source?.mode === 'LIVE',
    isDemo: source?.mode === 'DEMO',
    dataAsOf,
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useFilters(): FilterCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error('FilterProvider missing');
  return v;
}

/** Global window filter keys — only forwarded to endpoints that declare them. */
export const WINDOW_FILTER_KEYS = ['product', 'runKind', 'configRevision'] as const;

/**
 * Params handed to every analytics/list API call. Global window filters are
 * opt-in per call: endpoints that don't declare them respond 400 (§3.2).
 */
export function apiParams(f: Filters, extraKeys: readonly string[] = []): Record<string, unknown> {
  const out: Record<string, unknown> = {
    sourceId: f.sourceId, scopeId: f.scopeId, timezone: f.timezone,
  };
  if (f.from != null) out.from = f.from;
  if (f.to != null) out.to = f.to;
  if (f.grain) out.grain = f.grain;
  if (f.compare) out.compare = 'prev';
  for (const k of extraKeys) {
    const v = f[k];
    if (v != null && v !== '' && v !== false) out[k] = v;
  }
  return out;
}

/** Search string carrying only the global filter keys ('?a=b&…' or ''). */
export function useGlobalSearch(): string {
  const [sp] = useSearchParams();
  return useMemo(() => {
    const keep = new URLSearchParams();
    for (const k of FILTER_KEYS) {
      const v = sp.get(k);
      if (v != null) keep.set(k, v);
    }
    const s = keep.toString();
    return s ? `?${s}` : '';
  }, [sp]);
}

/** Analytics pages now live under /analysis/* — bare legacy paths are re-rooted. */
export const ANALYSIS_ROOTS = new Set([
  'overview', 'runs', 'tasks', 'models', 'context',
  'collaboration', 'tools', 'efficiency', 'quality', 'explorer',
]);

/**
 * navigate() that preserves the global filter params — bare paths would
 * otherwise reset sourceId/window to defaults on every in-app navigation.
 * A target may carry its own query (e.g. drilldown '/runs?state=unclosed'):
 * explicit target params win over carried globals; extraParams win last.
 */
export function useAppNavigate() {
  const nav = useNavigate();
  const globalSearch = useGlobalSearch();
  return useCallback((to: string, extraParams?: Record<string, unknown>) => {
    let [pathname, query] = to.split('?');
    if (ANALYSIS_ROOTS.has(pathname.split('/')[1] ?? '') && !pathname.startsWith('/analysis')) {
      pathname = `/analysis${pathname}`;
    }
    const target = new URLSearchParams(query ?? '');
    for (const [k, v] of new URLSearchParams(globalSearch)) {
      if (!target.has(k)) target.set(k, v);
    }
    for (const [k, v] of Object.entries(extraParams ?? {})) {
      if (v != null && v !== '') target.set(k, String(v));
    }
    const s = target.toString();
    nav(s ? `${pathname}?${s}` : pathname);
  }, [nav, globalSearch]);
}

export function useInvalidateSource() {
  const qc = useQueryClient();
  const { filters } = useFilters();
  return useCallback(() => {
    qc.invalidateQueries({ predicate: (q) => (q.queryKey[2] as string) === filters.sourceId });
  }, [qc, filters.sourceId]);
}
