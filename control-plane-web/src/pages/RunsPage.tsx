// 任务与执行 (§6.2): Run/Task toggle, server-side filter/sort/pagination,
// three light charts on top (outcome bar, duration histogram, step histogram).
import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useApi, useApiPage } from '../api/hooks';
import { useAppNavigate, useFilters, WINDOW_FILTER_KEYS } from '../state/filters';
import type { RunRow } from '../../shared/contracts/types';
import { ChartCard } from '../components/charts/ChartCard';
import { histogramOption, stateStackOption } from '../components/charts/options';
import { Card, EmptyState, ErrorBanner, Skeleton, StatusBadge, Badge, RelationBadge } from '../components/ui/primitives';
import { DataTable, Pager, type Column } from '../components/ui/DataTable';
import { fmtInt, fmtMs, fmtTimeShort, fmtTokens, shortId, OUTCOME_LABEL } from '../lib/format';
import { NoDataInRangeHint } from '../features/filters/FilterBar';

interface RunsAnalytics {
  createdCohort: Record<string, number>;
  completedCohort: { succeeded: number; failed: number; timedOut: number; cancelled: number; rejected: number; skipped: number; denominator: number; successRate: number | null; excluded: number };
  duration: { exact: { p50: number | null; p95: number | null; sampleCount: number; missingCount: number }; wallClock: { p50: number | null; p95: number | null; sampleCount: number } };
  durationHistogram: { buckets: { label: string; count: number; min: number; max: number }[]; used: number; missing: number };
  stepHistogram: { buckets: { label: string; count: number }[]; used: number; missing: number };
  outcomeKnownCoverage: number | null;
}

export default function RunsPage() {
  const { filters, isLive, sourceEpoch } = useFilters();
  const [sp] = useSearchParams();
  const nav = useAppNavigate();
  const [cursorStack, setCursorStack] = useState<(string | null)[]>([null]);
  const cursor = cursorStack[cursorStack.length - 1];
  const [durBasis, setDurBasis] = useState<'auto' | 'duration' | 'wall'>('auto');

  // All filters live in the URL — any change invalidates the keyset cursor.
  const spKey = sp.toString();
  useEffect(() => {
    setCursorStack((s) => (s.length > 1 || s[0] != null ? [null] : s));
  }, [spKey, sourceEpoch]);

  // durationBasis is an analytics-only param — /runs would 400 on it (§3.2).
  const listParams = {
    sort: sp.get('sort') ?? 'registered_at',
    dir: sp.get('dir') ?? 'desc',
    lifecycle: sp.get('lifecycle') ?? undefined,
    outcome: sp.get('outcome') ?? undefined,
    involvesModel: sp.get('involvesModel') ?? undefined,
    state: sp.get('state') ?? undefined,
  };

  const analyticsQ = useApi<RunsAnalytics>('/analytics/runs', { durationBasis: durBasis }, { liveIntervalMs: 15000, globalFilters: WINDOW_FILTER_KEYS });
  const listQ = useApiPage<RunRow>('/runs', { limit: 50, cursor: cursor ?? undefined, ...listParams }, { liveIntervalMs: 15000, globalFilters: WINDOW_FILTER_KEYS });

  const a = analyticsQ.data?.data;
  const page = listQ.data?.data;

  const outcomeOption = useMemo(() => {
    if (!a) return null;
    const dist = [
      { outcome: 'SUCCEEDED', count: a.createdCohort.succeeded ?? 0 },
      { outcome: 'FAILED', count: a.createdCohort.failed ?? 0 },
      { outcome: 'TIMED_OUT', count: a.createdCohort.timedOut ?? 0 },
      { outcome: 'CANCELLED', count: a.createdCohort.cancelled ?? 0 },
      { outcome: 'REJECTED', count: a.createdCohort.rejected ?? 0 },
      { outcome: 'SKIPPED', count: a.createdCohort.skipped ?? 0 },
      { outcome: 'OUTCOME_UNKNOWN', count: a.createdCohort.outcomeUnknown ?? 0 },
      { outcome: 'UNCLOSED', count: a.createdCohort.unclosed ?? 0 },
      { outcome: 'STATE_CONFLICT', count: a.createdCohort.conflict ?? 0 },
    ];
    return stateStackOption(dist, { title: '期间创建' });
  }, [a]);

  const durOption = useMemo(() => (a ? histogramOption(a.durationHistogram.buckets) : null), [a]);
  const stepOption = useMemo(() => (a ? histogramOption(a.stepHistogram.buckets, { color: 'var(--input)' }) : null), [a]);

  const columns: Column<RunRow>[] = [
    { key: 'runId', header: 'Run', render: (r) => <span className="mono">{shortId(r.runId)}</span> },
    {
      key: 'state', header: '状态', render: (r) => (
        <span className="row" style={{ gap: 4 }}>
          <StatusBadge outcome={r.outcome} lifecycle={r.lifecycle} activityState={r.activityState} reasons={r.qualityReasons} />
          <RelationBadge state={r.relationState} />
        </span>
      ),
    },
    { key: 'product', header: '产品/类型', render: (r) => `${r.productName ?? '—'} · ${r.runKind}` },
    { key: 'startedAt', header: '开始', render: (r) => fmtTimeShort(r.startedAt, filters.timezone) },
    {
      key: 'dur', header: '耗时', numeric: true, render: (r) => (
        r.durationMs != null ? fmtMs(r.durationMs)
          : r.wallClockMs != null ? <span title="墙钟跨度（推导）">{fmtMs(r.wallClockMs)} ⏱</span> : '—'
      ),
    },
    { key: 'steps', header: '决策步', numeric: true, render: (r) => fmtInt(r.stepCount) },
    { key: 'calls', header: '调用/传输', numeric: true, render: (r) => `${r.callCount}/${r.transportAttemptCount}` },
    { key: 'tools', header: '工具', numeric: true, render: (r) => fmtInt(r.toolCallCount) },
    { key: 'tokens', header: 'Token', numeric: true, render: (r) => fmtTokens(r.knownTotalTokens) },
    { key: 'coverage', header: '覆盖', render: (r) => <Badge tone="plain">{r.coverage}</Badge> },
  ];

  return (
    <div className="col" style={{ gap: 16 }}>
      <div className="row">
        <h1 className="page-title">任务与执行</h1>
      </div>
      <NoDataInRangeHint />

      {analyticsQ.isError && <ErrorBanner error={analyticsQ.error} onRetry={() => analyticsQ.refetch()} />}
      <div className="grid cols-12">
        <ChartCard span={4} title="结果分布" caliber="期间创建 cohort 的当前结果"
          option={outcomeOption} height={170}
          badges={a?.outcomeKnownCoverage != null ? <Badge tone="info">已知 {Math.round(a.outcomeKnownCoverage * 100)}%</Badge> : undefined}
          empty={analyticsQ.isPending ? <Skeleton h={150} /> : <EmptyState title="无样本" />}
          table={{
            columns: [{ key: 'outcome', header: '结果', render: (r) => OUTCOME_LABEL[String(r.outcome)] ?? String(r.outcome) }, { key: 'count', header: '数', numeric: true, render: (r) => fmtInt(r.count as number) }],
            rows: a ? [
              { outcome: 'SUCCEEDED', count: a.createdCohort.succeeded }, { outcome: 'FAILED', count: a.createdCohort.failed },
              { outcome: 'TIMED_OUT', count: a.createdCohort.timedOut }, { outcome: 'UNCLOSED', count: a.createdCohort.unclosed },
              { outcome: 'STATE_CONFLICT', count: a.createdCohort.conflict },
            ] : [],
          }} />
        <ChartCard span={4} title="耗时分布"
          caliber={durBasis === 'duration' ? 'duration_ms 精确耗时' : durBasis === 'wall' ? '墙钟跨度（推导）' : '精确耗时优先，缺失退墙钟'}
          option={durOption} height={170}
          badges={a ? <Badge tone={a.duration.exact.sampleCount ? 'info' : 'unknown'}>精确样本 {a.duration.exact.sampleCount} · 缺 {a.duration.exact.missingCount}</Badge> : undefined}
          actions={
            <select value={durBasis} onChange={(e) => setDurBasis(e.target.value as typeof durBasis)} aria-label="耗时口径">
              <option value="auto">精确+墙钟</option><option value="duration">仅精确</option><option value="wall">仅墙钟</option>
            </select>
          }
          empty={analyticsQ.isPending ? <Skeleton h={150} /> : <EmptyState title="无终结样本" />}
          table={{
            columns: [{ key: 'label', header: '区间', render: (r) => String(r.label) }, { key: 'count', header: '数', numeric: true, render: (r) => fmtInt(r.count as number) }],
            rows: (a?.durationHistogram.buckets ?? []) as unknown as Record<string, unknown>[],
          }} />
        <ChartCard span={4} title="决策步数分布" caliber="每个 Run 的已登记 Step 数"
          option={stepOption} height={170}
          empty={analyticsQ.isPending ? <Skeleton h={150} /> : <EmptyState title="无样本" />}
          table={{
            columns: [{ key: 'label', header: '步数区间', render: (r) => String(r.label) }, { key: 'count', header: '数', numeric: true, render: (r) => fmtInt(r.count as number) }],
            rows: (a?.stepHistogram.buckets ?? []) as unknown as Record<string, unknown>[],
          }} />
      </div>

      <Card title="Run 列表" sub="服务端分页 · 未知数字排序在最后"
        right={<span className="muted" style={{ fontSize: 11.5 }}>{isLive ? 'LIVE · 15s' : '快照'}</span>}>
        {listQ.isError && <ErrorBanner error={listQ.error} onRetry={() => listQ.refetch()} />}
        {listQ.isPending ? <Skeleton h={300} /> : (
          <>
            <DataTable columns={columns} rows={page?.rows ?? []} rowKey={(r) => r.runId}
              onRowClick={(r) => nav(`/runs/${r.runId}`)}
              empty={<EmptyState title="此范围无 Run" hint="调整时间范围或筛选条件。" />} />
            <Pager
              hasMore={page?.hasMore}
              canPrev={cursorStack.length > 1}
              onNext={() => page?.nextCursor && setCursorStack((s) => [...s, page.nextCursor])}
              onPrev={() => setCursorStack((s) => (s.length > 1 ? s.slice(0, -1) : s))}
              note={listQ.isFetching ? '更新中…' : `本页 ${page?.rows.length ?? 0} 条`}
            />
          </>
        )}
      </Card>
    </div>
  );
}
