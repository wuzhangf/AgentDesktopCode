// 运营总览 (§6.1): 8 KPI cards, execution trend, outcome distribution,
// resource trend, attention items, top model/tool, recent runs.
import { useMemo, useState } from 'react';
import { useApi } from '../api/hooks';
import type { OverviewData } from '../../shared/contracts/types';
import { useAppNavigate, useFilters, WINDOW_FILTER_KEYS } from '../state/filters';
import { MetricCard } from '../features/metrics/MetricCard';
import { ChartCard } from '../components/charts/ChartCard';
import { rankedBarOption, stateStackOption, timeSeriesOption } from '../components/charts/options';
import { chartColors } from '../lib/chartTheme';
import { NoDataInRangeHint } from '../features/filters/FilterBar';
import { Badge, Card, EmptyState, ErrorBanner, Skeleton, StatusBadge } from '../components/ui/primitives';
import { DataTable } from '../components/ui/DataTable';
import { fmtCompact, fmtInt, fmtMs, fmtTimeShort, fmtTokens, shortId } from '../lib/format';
import { AlertCircle } from 'lucide-react';

export default function OverviewPage() {
  const { filters, isLive } = useFilters();
  const nav = useAppNavigate();
  const [trendMetric, setTrendMetric] = useState<'registered' | 'completed'>('registered');
  const q = useApi<OverviewData>('/analytics/overview', undefined, { liveIntervalMs: 5000, globalFilters: WINDOW_FILTER_KEYS });
  const d = q.data?.data;
  const meta = q.data?.meta;
  const c = chartColors();

  const trendOption = useMemo(() => {
    if (!d) return null;
    const points = trendMetric === 'registered' ? d.registeredTrend : d.completedTrend;
    return timeSeriesOption(points, [{
      id: trendMetric, name: trendMetric === 'registered' ? '已登记' : '已完成',
      type: 'bar', color: c.accent, key: 'count',
    }], filters.timezone);
  }, [d, trendMetric, filters.timezone]);

  const tokenOption = useMemo(() => {
    if (!d) return null;
    return timeSeriesOption(d.tokenTrend, [
      { id: 'total', name: 'total（供应商口径）', color: c.total, key: 'total' },
      { id: 'input', name: 'input', color: c.input, key: 'input' },
      { id: 'output', name: 'output', color: c.output, key: 'output' },
      { id: 'reasoning', name: 'reasoning', color: c.reasoning, key: 'reasoning', dashed: true },
    ], filters.timezone);
  }, [d, filters.timezone]);

  const outcomeOption = useMemo(() => (d ? stateStackOption(d.outcomeDistribution, { title: '期间创建' }) : null), [d]);

  const modelBarOption = useMemo(() => {
    if (!d) return null;
    return rankedBarOption(d.topModels.map((m) => ({
      name: m.resolvedModel ?? '(未知模型)',
      value: m.attemptCount,
      extra: `${m.callCount} 个逻辑调用 · Token ${m.knownTotalTokens == null ? '未知' : fmtCompact(m.knownTotalTokens)}`,
    })));
  }, [d]);

  const toolBarOption = useMemo(() => {
    if (!d) return null;
    return rankedBarOption(d.topTools.map((t) => ({
      name: t.canonicalToolName ?? '(未命名)',
      value: t.callCount,
      extra: `成功 ${t.succeededCount} · 失败 ${t.failedCount}`,
      color: c.output,
    })));
  }, [d]);

  if (q.isPending) return <div className="col"><Skeleton h={120} /><Skeleton h={280} /><Skeleton h={280} /></div>;
  if (q.isError) return <ErrorBanner error={q.error} onRetry={() => q.refetch()} />;
  if (!d) return null;

  const noDataInWindow = meta?.dataAsOf != null &&
    filters.from != null && meta.dataAsOf < filters.from;

  return (
    <div className="col" style={{ gap: 16 }}>
      <div className="row">
        <h1 className="page-title">Agent 运营总览</h1>
        <span className="muted" style={{ fontSize: 12 }}>
          {meta?.dataAsOf != null ? `最新事件 ${fmtTimeShort(meta.dataAsOf, filters.timezone)}` : '无事件'}
        </span>
      </div>

      {noDataInWindow && <NoDataInRangeHint />}

      <div className="kpi-grid">
        {d.kpis.map((m, i) => <MetricCard key={m.metricId} metric={m} delay={Math.min(i, 5) * 0.03} />)}
      </div>

      <div className="grid cols-12">
        <ChartCard span={8} title="执行趋势"
          caliber={trendMetric === 'registered' ? '按 registered_at：本期创建的 Run' : '按 ended_at：本期结束的 Run（与新增不同 cohort，不相减）'}
          option={trendOption} height={230}
          badges={<Badge tone="info">{meta?.grain ?? ''}/桶</Badge>}
          actions={
            <select value={trendMetric} onChange={(e) => setTrendMetric(e.target.value as 'registered' | 'completed')} aria-label="趋势口径">
              <option value="registered">新增</option>
              <option value="completed">完成</option>
            </select>
          }
          table={{
            columns: [
              { key: 'bucketStart', header: '时间', render: (r) => fmtTimeShort(r.bucketStart as number, filters.timezone) },
              { key: 'count', header: '数量', numeric: true, render: (r) => fmtInt(r.count as number) },
            ],
            rows: (trendMetric === 'registered' ? d.registeredTrend : d.completedTrend) as unknown as Record<string, unknown>[],
          }} />
        <ChartCard span={4} title="结果分布" caliber="期间创建 cohort，截至查询时的当前结果"
          option={outcomeOption} height={230}
          badges={d.outcomeKnownCoverage != null ? <Badge tone="info">结果已知 {Math.round(d.outcomeKnownCoverage * 100)}%</Badge> : undefined}
          table={{
            columns: [
              { key: 'outcome', header: '结果', render: (r) => String(r.outcome) },
              { key: 'count', header: '数', numeric: true, render: (r) => fmtInt(r.count as number) },
            ],
            rows: d.outcomeDistribution as unknown as Record<string, unknown>[],
          }} />
      </div>

      <div className="grid cols-12">
        <ChartCard span={8} title="资源趋势" caliber="attempt 粒度的已知 Token 小计；NULL 桶断线不补零"
          option={tokenOption} height={220}
          empty={<EmptyState title="未提供用量" hint="所有已观测尝试的 Token 字段均为 NULL——采集端未上报，不是消耗为 0。" />}
          badges={<Badge tone="unknown">NULL 不断线补零</Badge>}
          table={{
            columns: [
              { key: 'bucketStart', header: '时间', render: (r) => fmtTimeShort(r.bucketStart as number, filters.timezone) },
              { key: 'input', header: 'input', numeric: true, render: (r) => fmtTokens(r.input as number | null) },
              { key: 'output', header: 'output', numeric: true, render: (r) => fmtTokens(r.output as number | null) },
              { key: 'reasoning', header: 'reasoning', numeric: true, render: (r) => fmtTokens(r.reasoning as number | null) },
              { key: 'total', header: 'total', numeric: true, render: (r) => fmtTokens(r.total as number | null) },
            ],
            rows: d.tokenTrend as unknown as Record<string, unknown>[],
          }} />
        <Card span={4} title="值得关注" sub="后端确定性规则产出 · 最多3条">
          {d.attention.length === 0 ? (
            <EmptyState title="暂无关注事项" hint="没有发现影响口径的质量问题或可行动异常。" />
          ) : (
            <div className="col">
              {d.attention.map((a) => (
                <button key={a.ruleId + a.message} className="card raised row" style={{ textAlign: 'left', gap: 10 }}
                  onClick={() => nav(a.drilldown.path, a.drilldown.filters)}>
                  <AlertCircle size={15} color={a.severity === 'ERROR' ? 'var(--failure)' : a.severity === 'WARN' ? 'var(--warning)' : 'var(--accent)'} />
                  <div className="grow">
                    <div style={{ fontSize: 12.5 }}>{a.message}</div>
                    <div className="muted" style={{ fontSize: 11 }}>{a.ruleId} · 样本 {a.sampleCount}</div>
                  </div>
                </button>
              ))}
            </div>
          )}
        </Card>
      </div>

      <div className="grid cols-12">
        <ChartCard span={6} title="模型使用排名" caliber="按已观测传输尝试数；Token 列仅已知小计"
          option={modelBarOption} height={220}
          empty={<EmptyState title="无模型尝试" />}
          table={{
            columns: [
              { key: 'resolvedModel', header: '模型', render: (r) => String(r.resolvedModel ?? '—') },
              { key: 'attemptCount', header: '尝试', numeric: true, render: (r) => fmtInt(r.attemptCount as number) },
              { key: 'callCount', header: '调用', numeric: true, render: (r) => fmtInt(r.callCount as number) },
              { key: 'knownTotalTokens', header: 'Token', numeric: true, render: (r) => fmtTokens(r.knownTotalTokens as number | null) },
            ],
            rows: d.topModels as unknown as Record<string, unknown>[],
          }}
          onClickPoint={() => nav('/models')} />
        <ChartCard span={6} title="工具使用排名" caliber="按 canonical_tool_name 聚合的调用次数"
          option={toolBarOption} height={220}
          empty={<EmptyState title="无工具调用" />}
          table={{
            columns: [
              { key: 'canonicalToolName', header: '工具', render: (r) => String(r.canonicalToolName ?? '—') },
              { key: 'callCount', header: '次数', numeric: true, render: (r) => fmtInt(r.callCount as number) },
              { key: 'succeededCount', header: '成功', numeric: true, render: (r) => fmtInt(r.succeededCount as number) },
              { key: 'failedCount', header: '失败', numeric: true, render: (r) => fmtInt(r.failedCount as number) },
            ],
            rows: d.topTools as unknown as Record<string, unknown>[],
          }}
          onClickPoint={() => nav('/tools')} />
      </div>

      <Card title="最近执行" sub="按登记时间；状态为读取时投影"
        right={<button className="ghost" onClick={() => nav('/runs')}>全部 →</button>}>
        <DataTable
          columns={[
            { key: 'runId', header: 'Run', render: (r) => <span className="mono">{shortId(r.runId)}</span> },
            { key: 'state', header: '状态', render: (r) => <StatusBadge outcome={r.outcome} lifecycle={r.lifecycle} activityState={r.activityState} reasons={r.qualityReasons} /> },
            { key: 'productName', header: '产品/类型', render: (r) => `${r.productName ?? '—'} · ${r.runKind}` },
            { key: 'startedAt', header: '开始', render: (r) => fmtTimeShort(r.startedAt, filters.timezone) },
            { key: 'durationMs', header: '耗时', numeric: true, render: (r) => fmtMs(r.durationMs ?? r.wallClockMs) },
            { key: 'stepCount', header: '步数', numeric: true, render: (r) => fmtInt(r.stepCount) },
            { key: 'callCount', header: '调用/传输', numeric: true, render: (r) => `${r.callCount}/${r.transportAttemptCount}` },
            { key: 'toolCallCount', header: '工具', numeric: true, render: (r) => fmtInt(r.toolCallCount) },
            { key: 'knownTotalTokens', header: 'Token', numeric: true, render: (r) => fmtTokens(r.knownTotalTokens) },
          ]}
          rows={d.recentRuns}
          rowKey={(r) => r.runId}
          onRowClick={(r) => nav(`/runs/${r.runId}`)}
          empty={<EmptyState title="此范围无执行记录" />}
        />
      </Card>
    </div>
  );
}
