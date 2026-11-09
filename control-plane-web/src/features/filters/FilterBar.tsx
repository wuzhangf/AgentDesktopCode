// Persistent filter bar (§3.2): source / scope / time range / timezone /
// compare / refresh status. Filtered values persist in the URL.
import { useMemo } from 'react';
import { RefreshCw, LocateFixed } from 'lucide-react';
import { useFilters, useInvalidateSource, useSources } from '../../state/filters';
import { useQueryClient } from '@tanstack/react-query';
import { fmtTimeShort } from '../../lib/format';

const RANGES = [
  { id: '1h', label: '过去1小时', ms: 3_600_000 },
  { id: '24h', label: '过去24小时', ms: 86_400_000 },
  { id: '7d', label: '过去7天', ms: 7 * 86_400_000 },
  { id: '30d', label: '过去30天', ms: 30 * 86_400_000 },
  { id: 'custom', label: '自定义…' },
];

const TIMEZONES = ['Asia/Shanghai', 'UTC', 'America/New_York', 'Europe/London', 'Asia/Tokyo'];

export function FilterBar({ onRefresh }: { onRefresh?: () => void }) {
  const { filters, setFilters, setFilter, source, dataAsOf, locateDataWindow, isLive } = useFilters();
  const invalidate = useInvalidateSource();
  const qc = useQueryClient();
  const { data: sourcesResp } = useSources();

  const rangeValue = useMemo(() => {
    if (filters.from == null && filters.to == null) return '24h';
    if (filters.from != null && filters.to != null) {
      const span = filters.to - filters.from;
      const hit = RANGES.find((r) => r.ms === span);
      return hit?.id ?? 'custom';
    }
    return 'custom';
  }, [filters.from, filters.to]);

  const applyRange = (id: string) => {
    const r = RANGES.find((x) => x.id === id);
    if (!r) return;
    if (r.id === 'custom') {
      const from = window.prompt('from (epoch ms)', String(filters.from ?? Date.now() - 86_400_000));
      const to = window.prompt('to (epoch ms)', String(filters.to ?? Date.now()));
      const nf = Number(from);
      const nt = Number(to);
      if (from && to && Number.isFinite(nf) && Number.isFinite(nt) && nf < nt) {
        setFilters({ from: nf, to: nt });
      }
      return;
    }
    const anchor = filters.from == null ? Date.now() : (dataAsOf ?? Date.now());
    // Explicit from/to in URL so the label never lies about the window.
    setFilters({ from: anchor - (r.ms ?? 86_400_000), to: anchor });
  };

  return (
    <div className="topbar" role="region" aria-label="全局筛选">
      <select aria-label="数据源" value={filters.sourceId}
        onChange={(e) => { setFilters({ sourceId: e.target.value, scopeId: 'local' }); qc.removeQueries(); }}>
        {(sourcesResp?.data.sources ?? []).map((s) => (
          <option key={s.id} value={s.id} disabled={!s.available}>
            {s.label}{s.available ? `（${s.mode}）` : '（不可用）'}
          </option>
        ))}
      </select>

      <select aria-label="scope" value={filters.scopeId}
        onChange={(e) => setFilter('scopeId', e.target.value)}>
        {(source?.scopes?.length ? source.scopes : ['local']).map((s) => (
          <option key={s} value={s}>{s}</option>
        ))}
      </select>

      <select aria-label="时间范围" value={rangeValue} onChange={(e) => applyRange(e.target.value)}>
        {RANGES.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
      </select>

      <select aria-label="时区" value={filters.timezone} onChange={(e) => setFilter('timezone', e.target.value)}>
        {TIMEZONES.map((t) => <option key={t} value={t}>{t}</option>)}
      </select>

      <label className="row" style={{ gap: 4, fontSize: 12, color: 'var(--text-secondary)' }}>
        <input type="checkbox" checked={filters.compare} onChange={(e) => setFilter('compare', e.target.checked ? 'prev' : null)} />
        对比上一周期
      </label>

      <button className="ghost" title="刷新" aria-label="刷新" onClick={() => { invalidate(); onRefresh?.(); }}>
        <RefreshCw size={14} />
      </button>

      {dataAsOf != null && (
        <span className="muted" style={{ fontSize: 11.5 }}>
          最新事件 {fmtTimeShort(dataAsOf, filters.timezone)}
          {source?.mode === 'SNAPSHOT' && ' · 快照'}
          {source?.mode === 'DEMO' && ' · 演示'}
        </span>
      )}
      {isLive && <span className="badge success">LIVE</span>}
    </div>
  );
}

export function NoDataInRangeHint() {
  const { dataAsOf, locateDataWindow, filters } = useFilters();
  if (dataAsOf == null) return null;
  const inRange = filters.from != null && filters.to != null && dataAsOf >= filters.from && dataAsOf < filters.to;
  if (inRange) return null;
  return (
    <div className="banner info">
      此范围无记录；最新记录在 {fmtTimeShort(dataAsOf, filters.timezone)}。
      <button className="ghost" onClick={locateDataWindow}>
        <LocateFixed size={13} /> 定位最近有数据的 24 小时
      </button>
    </div>
  );
}
