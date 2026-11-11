// 模型与用量 (§6.4): KPI cards, token trend, model table, latency percentiles,
// request/response identity, error pareto, cache share, visibility, retry list.
import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useApi, useApiPage } from '../api/hooks';
import { useAppNavigate, useFilters } from '../state/filters';
import type { ModelRankRow, TrendPoint } from '../../shared/contracts/types';
import { MetricCard } from '../features/metrics/MetricCard';
import { ChartCard } from '../components/charts/ChartCard';
import { donutOption, rankedBarOption, timeSeriesOption } from '../components/charts/options';
import { chartColors } from '../lib/chartTheme';
import { Badge, Card, EmptyState, ErrorBanner, Skeleton, StatusBadge } from '../components/ui/primitives';
import { DataTable, Pager } from '../components/ui/DataTable';
import { fmtCompact, fmtInt, fmtMs, fmtRatio, fmtTime, fmtTokens, shortId } from '../lib/format';
import type { MetricValue } from '../../shared/contracts/types';

interface LatStat { sampleCount: number; p50: number | null; p95: number | null; max: number | null; smallSample: boolean }

interface ModelsData {
  kpis: MetricValue[];
  tokenTrend: TrendPoint[];
  topModels: ModelRankRow[];
  modelTable: {
    providerId: string | null; resolvedModel: string | null;
    attemptCount: number; callCount: number;
    transportSuccessRate: { rate: number | null; known: number };
    durationP95: number | null; durationSamples: number;
    knownTotalTokens: number | null; usageKnownCount: number; usageRows: number;
    cacheReadShare: number | null; retriedShare: number | null;
    outcomeStats: { succeeded: number; failed: number; timedOut: number; excluded: number };
  }[];
  latency: { firstResponse: LatStat; firstAnswerDelta: LatStat; firstReasoningDelta: LatStat; fullDuration: LatStat };
  identity: { same: number; different: number; unknown: number };
  errors: { key: string; count: number }[];
  cache: { cacheReadShare: number | null; completeInputSamples: number; cacheKnownSamples: number; hitRequestShare: number | null };
  visibilityBreakdown: { transportAttempt: number; portCallOnly: number; intentOrUnknown: number };
}

const LAT_LABEL: Record<string, string> = {
  firstResponse: '首响应', firstAnswerDelta: '首答案片段', firstReasoningDelta: '首思考片段', fullDuration: '完整耗时',
};

export default function ModelsPage() {
  const { filters, isLive, sourceEpoch } = useFilters();
  const nav = useAppNavigate();
  const [sp] = useSearchParams();
  const [retriedOnly, setRetriedOnly] = useState(sp.get('retried') === 'true');
  const [stack, setStack] = useState<(string | null)[]>([null]);

  // URL-carried filters/source changes invalidate the keyset cursor stack.
  const spKey = sp.toString();
  useEffect(() => {
    setStack((s) => (s.length > 1 || s[0] != null ? [null] : s));
  }, [spKey, sourceEpoch]);

  const q = useApi<ModelsData>('/analytics/models', undefined, { liveIntervalMs: 15000 });
  const attemptsQ = useApiPage<Record<string, unknown>>('/model-attempts', {
    limit: 20, cursor: stack[stack.length - 1] ?? undefined,
    retried: retriedOnly ? 'true' : undefined,
  }, { liveIntervalMs: isLive ? 15000 : false, keepPreviousData: true });

  const d = q.data?.data;
  const c = chartColors();

  const trendOption = useMemo(() => {
    if (!d) return null;
    return timeSeriesOption(d.tokenTrend, [
      { id: 'input', name: 'input', color: c.input, key: 'input' },
      { id: 'output', name: 'output', color: c.output, key: 'output' },
      { id: 'reasoning', name: 'reasoning', color: c.reasoning, key: 'reasoning' },
      { id: 'total', name: 'total（供应商口径）', color: c.total, key: 'total' },
    ], filters.timezone);
  }, [d, filters.timezone, c]);

  const latencyOption = useMemo(() => {
    if (!d) return null;
    const rows = (Object.keys(LAT_LABEL) as (keyof ModelsData['latency'])[]).map((k) => ({
      name: LAT_LABEL[k], value: d.latency[k]?.p50 ?? null,
      extra: `p95 ${fmtMs(d.latency[k]?.p95)} · n=${d.latency[k]?.sampleCount ?? 0}${d.latency[k]?.smallSample ? ' · 小样本' : ''}`,
    }));
    return rankedBarOption(rows, { unit: 'ms' });
  }, [d]);

  const identityOption = useMemo(() => {
    if (!d) return null;
    return donutOption([
      { name: '请求=响应模型', value: d.identity.same, color: c.success },
      { name: '请求≠响应模型', value: d.identity.different, color: c.warning },
      { name: '无法判定', value: d.identity.unknown, color: c.unknown },
    ]);
  }, [d]);

  const errOption = useMemo(() => {
    if (!d) return null;
    return rankedBarOption(d.errors.map((e) => ({ name: e.key, value: e.count })), {});
  }, [d]);

  const visOption = useMemo(() => {
    if (!d) return null;
    return donutOption([
      { name: '传输尝试', value: d.visibilityBreakdown.transportAttempt, color: c.accent },
      { name: '仅端口调用', value: d.visibilityBreakdown.portCallOnly, color: c.warning },
      { name: '意图/未知派发', value: d.visibilityBreakdown.intentOrUnknown, color: c.unknown },
    ]);
  }, [d]);

  if (q.isPending) return <div className="col"><Skeleton h={120} /><Skeleton h={260} /><Skeleton h={260} /></div>;
  if (q.isError) return <ErrorBanner error={q.error} onRetry={() => q.refetch()} />;
  if (!d) return null;

  const rows = attemptsQ.data?.data.rows ?? [];

  return (
    <div className="col" style={{ gap: 16 }}>
      <div className="row"><h1 className="page-title">模型与用量</h1></div>

      <div className="kpi-grid">
        {d.kpis.map((m, i) => <MetricCard key={m.metricId} metric={m} delay={Math.min(i, 5) * 0.03} />)}
      </div>

      <div className="grid cols-12">
        <ChartCard span={8} title="Token 趋势" caliber="attempt 粒度已知小计；NULL 桶断线不补零"
          option={trendOption} height={230}
          empty={<EmptyState title="未提供用量" hint="所有已观测尝试的 Token 字段均为 NULL——采集端未上报，不是消耗为 0。" />}
          table={{
            columns: [
              { key: 'bucketStart', header: '时间', render: (r) => fmtTimeShortLocal(r.bucketStart as number, filters.timezone) },
              { key: 'input', header: 'input', numeric: true, render: (r) => fmtTokens(r.input as number | null) },
              { key: 'output', header: 'output', numeric: true, render: (r) => fmtTokens(r.output as number | null) },
              { key: 'reasoning', header: 'reasoning', numeric: true, render: (r) => fmtTokens(r.reasoning as number | null) },
              { key: 'total', header: 'total', numeric: true, render: (r) => fmtTokens(r.total as number | null) },
            ],
            rows: d.tokenTrend as unknown as Record<string, unknown>[],
          }} />
        <ChartCard span={4} title="观测可见性" caliber="TRANSPORT_ATTEMPT 才可计入传输指标"
          option={visOption} height={230}
          table={{
            columns: [
              { key: 'k', header: '类别', render: (r) => String(r.k) },
              { key: 'n', header: '数', numeric: true, render: (r) => fmtInt(r.n as number) },
            ],
            rows: [
              { k: 'TRANSPORT_ATTEMPT', n: d.visibilityBreakdown.transportAttempt },
              { k: 'PORT_CALL_ONLY', n: d.visibilityBreakdown.portCallOnly },
              { k: 'INTENT/UNKNOWN', n: d.visibilityBreakdown.intentOrUnknown },
            ],
          }} />
      </div>

      <Card title="模型明细表" sub="attempt 粒度聚合；成功率=已知传输终态占比（非业务正确率）">
        <DataTable
          columns={[
            { key: 'model', header: '模型', render: (r) => `${r.resolvedModel ?? '(未知)'}${r.providerId ? ` · ${r.providerId}` : ''}` },
            { key: 'att', header: '尝试', numeric: true, render: (r) => fmtInt(r.attemptCount) },
            { key: 'call', header: '逻辑调用', numeric: true, render: (r) => fmtInt(r.callCount) },
            { key: 'rate', header: '传输成功率', numeric: true, render: (r) => r.transportSuccessRate.rate == null ? '—' : `${fmtRatio(r.transportSuccessRate.rate)} (${r.transportSuccessRate.known})` },
            { key: 'p95', header: 'p95', numeric: true, render: (r) => fmtMs(r.durationP95) },
            { key: 'tok', header: '已知 Token', numeric: true, render: (r) => `${fmtTokens(r.knownTotalTokens)}（${r.usageKnownCount}/${r.usageRows}）` },
            { key: 'cache', header: '缓存读占比', numeric: true, render: (r) => fmtRatio(r.cacheReadShare) },
            { key: 'fail', header: '失败/超时', numeric: true, render: (r) => `${r.outcomeStats.failed}/${r.outcomeStats.timedOut}` },
          ]}
          rows={d.modelTable}
          rowKey={(r) => `${r.providerId}|${r.resolvedModel}`}
          empty={<EmptyState title="无模型尝试" />} />
      </Card>

      <div className="grid cols-12">
        <ChartCard span={4} title="时延分位" caliber="各阶段 p50；tooltip 含 p95 与样本数"
          option={latencyOption} height={210}
          empty={<EmptyState title="无时延样本" />}
          table={{
            columns: [
              { key: 'stage', header: '阶段', render: (r) => String(r.stage) },
              { key: 'p50', header: 'p50', numeric: true, render: (r) => fmtMs(r.p50 as number | null) },
              { key: 'p95', header: 'p95', numeric: true, render: (r) => fmtMs(r.p95 as number | null) },
              { key: 'n', header: 'n', numeric: true, render: (r) => fmtInt(r.n as number) },
            ],
            rows: (Object.keys(LAT_LABEL) as (keyof ModelsData['latency'])[]).map((k) => ({
              stage: LAT_LABEL[k], p50: d.latency[k].p50, p95: d.latency[k].p95, n: d.latency[k].sampleCount,
            })),
          }} />
        <ChartCard span={4} title="请求/响应模型一致性" caliber="requested vs resolved/response；不同不等于错误"
          option={identityOption} height={210}
          table={{
            columns: [
              { key: 'k', header: '类别', render: (r) => String(r.k) },
              { key: 'n', header: '数', numeric: true, render: (r) => fmtInt(r.n as number) },
            ],
            rows: [
              { k: '相同', n: d.identity.same }, { k: '不同', n: d.identity.different }, { k: '未知', n: d.identity.unknown },
            ],
          }} />
        <ChartCard span={4} title="错误 Pareto" caliber="http_status/failure_class/transport_outcome 首个非空"
          option={errOption} height={210}
          empty={<EmptyState title="无错误记录" />}
          table={{
            columns: [
              { key: 'key', header: '错误', render: (r) => String(r.key) },
              { key: 'count', header: '数', numeric: true, render: (r) => fmtInt(r.count as number) },
            ],
            rows: d.errors as unknown as Record<string, unknown>[],
          }} />
      </div>

      <Card title="缓存命中" sub="cache_read/input（仅完整输入样本）与有命中请求占比是不同分母">
        <div className="row wrap" style={{ gap: 20, fontSize: 12.5 }}>
          <span>缓存读占比 <b>{fmtRatio(d.cache.cacheReadShare)}</b> <span className="muted">（完整输入样本 {d.cache.completeInputSamples}）</span></span>
          <span>有命中请求占比 <b>{fmtRatio(d.cache.hitRequestShare)}</b> <span className="muted">（已知缓存字段 {d.cache.cacheKnownSamples}）</span></span>
        </div>
      </Card>

      <Card title="传输尝试" sub="按 started_at 倒序；点击行查看单次尝试证据"
        right={
          <label className="row" style={{ gap: 4, fontSize: 12 }}>
            <input type="checkbox" checked={retriedOnly} onChange={(e) => { setRetriedOnly(e.target.checked); setStack([null]); }} />
            仅看重试（transport_attempt_no &gt; 1）
          </label>
        }>
        {attemptsQ.isError && <ErrorBanner error={attemptsQ.error} onRetry={() => attemptsQ.refetch()} />}
        {attemptsQ.isPending ? <Skeleton h={220} /> : (
          <>
            <DataTable dense
              columns={[
                { key: 'id', header: 'Attempt', render: (r) => <span className="mono">{shortId(r.attempt_id as string)}</span> },
                { key: 'model', header: '模型', render: (r) => String(r.resolved_model ?? r.requested_model ?? '—') },
                { key: 'no', header: '传输序号', numeric: true, render: (r) => String(r.transport_attempt_no ?? '—') },
                { key: 'state', header: '状态', render: (r) => <StatusBadge outcome={r.outcome as string} lifecycle={r.lifecycle as string} activityState={r.activityState as string} /> },
                { key: 'http', header: 'HTTP', numeric: true, render: (r) => String(r.http_status ?? '—') },
                { key: 'started', header: '开始', render: (r) => fmtTime(r.started_at as number | null, filters.timezone) },
                { key: 'dur', header: '耗时', numeric: true, render: (r) => fmtMs(r.duration_ms as number | null) },
                { key: 'tok', header: 'Token', numeric: true, render: (r) => fmtTokens(r.total_tokens as number | null) },
                { key: 'vis', header: '可见性', render: (r) => String(r.visibility ?? '—') },
              ]}
              rows={rows}
              rowKey={(r) => String(r.attempt_id)}
              onRowClick={(r) => nav(`/models/attempts/${r.attempt_id}`)}
              empty={<EmptyState title="无匹配尝试" />} />
            <Pager hasMore={attemptsQ.data?.data.hasMore} canPrev={stack.length > 1}
              onNext={() => attemptsQ.data?.data.nextCursor && setStack((s) => [...s, attemptsQ.data.data.nextCursor!])}
              onPrev={() => setStack((s) => (s.length > 1 ? s.slice(0, -1) : s))}
              note={attemptsQ.isFetching ? '更新中…' : `本页 ${rows.length} 条`} />
          </>
        )}
      </Card>
    </div>
  );
}

function fmtTimeShortLocal(ms: number, tz: string) {
  return new Date(ms).toLocaleString('zh-CN', { hour12: false, timeZone: tz, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}
