// 质量与健康 (§6.7): execution quality vs data quality; registration lag,
// source liveness, coverage matrix, conflicts, sequence gaps, issues browser.
import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useApi, useApiPage } from '../api/hooks';
import { useFilters } from '../state/filters';
import { ChartCard } from '../components/charts/ChartCard';
import { rankedBarOption } from '../components/charts/options';
import { chartColors } from '../lib/chartTheme';
import { Badge, Banner, Card, EmptyState, ErrorBanner, Skeleton } from '../components/ui/primitives';
import { DataTable, Pager } from '../components/ui/DataTable';
import { fmtInt, fmtMs, fmtTime, fmtTimeShort, shortId } from '../lib/format';

interface QualityData {
  executionQuality: {
    failedEntities: { entityId: string; kind: string }[];
    toolFailures: { tool_call_id: string; canonical_tool_name: string | null; failure_class: string | null; ended_at: number | null }[];
  };
  dataQuality: {
    stateConflicts: { entityId: string; kind: string; reasons: string[]; lifecycle: string; outcome: string | null; nativeStatus: string | null }[];
    relationAnomalies: { runId: string; reasons: string[] }[];
    unclosedEntities: { entityId: string; kind: string; lifecycle: string; registeredAt: number | null; startedAt: number | null }[];
    unclosedTotal: number;
    issueByCode: { code: string; severity: string; records: number; occurrences: number }[];
    issues: Record<string, unknown>[];
    registrationLag: { sampleCount: number; p50: number | null; p95: number | null; clockAnomalies: number };
    sourceLiveness: { sourceInstanceId: string; bootAt: number | null; heartbeatAt: number | null; stoppedAt: number | null; state: string; ageMs: number | null }[];
    coverageMatrix: { family: string; label: string; total: number; fields: { field: string; known: number }[] }[];
    dataAsOf: number | null;
    sequenceGaps: { visibleSequenceGaps: { entityId: string; afterRevision: number; beforeRevision: number }[]; total: number; note: string };
  };
}

export default function QualityPage() {
  const { filters, sourceEpoch } = useFilters();
  const [sp] = useSearchParams();
  const q = useApi<QualityData>('/analytics/quality');
  const [stack, setStack] = useState<(string | null)[]>([null]);

  // URL-carried filters/source changes invalidate the keyset cursor stack.
  const spKey = sp.toString();
  useEffect(() => {
    setStack((s) => (s.length > 1 || s[0] != null ? [null] : s));
  }, [spKey, sourceEpoch]);
  const issuesQ = useApiPage<Record<string, unknown>>('/issues',
    { limit: 50, cursor: stack[stack.length - 1] ?? undefined }, { keepPreviousData: true });
  const d = q.data?.data;
  const c = chartColors();

  const issueOption = useMemo(() => {
    if (!d) return null;
    return rankedBarOption(d.dataQuality.issueByCode.map((x) => ({
      name: x.code, value: x.occurrences,
      extra: `${x.records} 条记录 · ${x.severity}`,
      color: x.severity === 'ERROR' ? c.failure : c.warning,
    })));
  }, [d]);

  const conflictOption = useMemo(() => {
    if (!d) return null;
    const byKind = new Map<string, number>();
    for (const x of d.dataQuality.stateConflicts) byKind.set(x.kind, (byKind.get(x.kind) ?? 0) + 1);
    return rankedBarOption([...byKind.entries()].map(([name, value]) => ({ name, value, color: c.warning })));
  }, [d]);

  if (q.isPending) return <div className="col"><Skeleton h={240} /><Skeleton h={240} /></div>;
  if (q.isError) return <ErrorBanner error={q.error} onRetry={() => q.refetch()} />;
  if (!d) return null;

  const dq = d.dataQuality;
  const eq = d.executionQuality;
  const issues = issuesQ.data?.data.rows ?? [];

  return (
    <div className="col" style={{ gap: 16 }}>
      <h1 className="page-title">质量与健康</h1>
      <Banner kind="info">
        执行质量（工具失败、实体 FAILED）与采集质量（登记问题、状态冲突、序列缺口）分开展示；
        登记问题不解释为业务失败。数据截至 {fmtTime(dq.dataAsOf, filters.timezone)}。
      </Banner>

      <div className="kpi-grid" style={{ gridTemplateColumns: 'repeat(4,1fr)' }}>
        <Card raised><div className="kpi"><span className="label">失败实体</span><span className="value">{fmtInt(eq.failedEntities.length)}</span><span className="sub">执行质量 · TERMINAL+FAILED</span></div></Card>
        <Card raised><div className="kpi"><span className="label">状态冲突</span><span className="value">{fmtInt(dq.stateConflicts.length)}</span><span className="sub">数据质量 · 需人工核对</span></div></Card>
        <Card raised><div className="kpi"><span className="label">未闭合实体</span><span className="value">{fmtInt(dq.unclosedTotal)}</span><span className="sub">活性未知 ≠ 仍在运行</span></div></Card>
        <Card raised><div className="kpi"><span className="label">登记延迟 p95</span><span className="value">{fmtMs(dq.registrationLag.p95)}</span><span className="sub">n={dq.registrationLag.sampleCount} · 时钟回拨 {dq.registrationLag.clockAnomalies}</span></div></Card>
      </div>

      <div className="grid cols-12">
        <ChartCard span={6} title="登记问题类型" caliber="issue_code 按 occurrence_count 汇总"
          option={issueOption} height={210}
          empty={<EmptyState title="无登记问题" />}
          table={{
            columns: [
              { key: 'code', header: 'code', render: (r) => String(r.code) },
              { key: 'sev', header: '级别', render: (r) => String(r.severity) },
              { key: 'n', header: '次数', numeric: true, render: (r) => fmtInt(r.occurrences as number) },
            ],
            rows: dq.issueByCode as unknown as Record<string, unknown>[],
          }} />
        <ChartCard span={6} title="状态冲突（按类型）" caliber="冲突行不参与成功率/耗时统计"
          option={conflictOption} height={210}
          empty={<EmptyState title="无状态冲突" />}
          table={{
            columns: [
              { key: 'kind', header: '类型', render: (r) => String(r.kind) },
              { key: 'id', header: '实体', render: (r) => <span className="mono">{shortId(String(r.entityId))}</span> },
              { key: 'why', header: '原因', render: (r) => (r.reasons as string[]).join(', ') },
            ],
            rows: dq.stateConflicts as unknown as Record<string, unknown>[],
          }} />
      </div>

      <div className="grid cols-12">
        <Card span={6} title="字段覆盖矩阵" sub="各实体族关键字段的已知数/总数">
          {dq.coverageMatrix.map((fam) => (
            <div key={fam.family} style={{ marginBottom: 10 }}>
              <div className="row" style={{ fontSize: 12 }}>
                <b>{fam.label}</b>
                <span className="muted right">n={fam.total}</span>
              </div>
              <div className="row wrap" style={{ gap: 6, marginTop: 4 }}>
                {fam.fields.map((f) => {
                  const ratio = fam.total ? f.known / fam.total : null;
                  return (
                    <Badge key={f.field} tone={ratio == null ? 'plain' : ratio >= 0.95 ? 'success' : ratio >= 0.5 ? 'warning' : 'unknown'}
                      title={`${f.field}: ${f.known}/${fam.total}`}>
                      {f.field} {ratio == null ? '—' : `${Math.round(ratio * 100)}%`}
                    </Badge>
                  );
                })}
              </div>
            </div>
          ))}
        </Card>
        <Card span={6} title="采集源活性" sub="obs_source 心跳；无心跳≠离线">
          <DataTable dense
            columns={[
              { key: 'src', header: '实例', render: (r) => <span className="mono">{shortId(String(r.sourceInstanceId))}</span> },
              { key: 'state', header: '活性', render: (r) => <Badge tone={r.state === 'HAS_HEARTBEAT' ? 'success' : r.state === 'STOPPED' ? 'plain' : 'unknown'}>{String(r.state)}</Badge> },
              { key: 'hb', header: '心跳', render: (r) => fmtTimeShort(r.heartbeatAt as number | null, filters.timezone) },
              { key: 'age', header: '距今', numeric: true, render: (r) => fmtMs(r.ageMs as number | null) },
            ]}
            rows={dq.sourceLiveness as unknown as Record<string, unknown>[]}
            rowKey={(r) => String(r.sourceInstanceId)}
            empty={<EmptyState title="无源记录" />} />
          <div className="muted" style={{ fontSize: 11, marginTop: 8 }}>
            可见序列缺口 {dq.sequenceGaps.total} — {dq.sequenceGaps.note}
          </div>
        </Card>
      </div>

      <div className="grid cols-12">
        <Card span={6} title="工具失败（执行质量）" sub="TERMINAL + FAILED/TIMED_OUT">
          <DataTable dense
            columns={[
              { key: 't', header: '工具', render: (r) => String(r.canonical_tool_name ?? '—') },
              { key: 'fc', header: '失败类', render: (r) => String(r.failure_class ?? '—') },
              { key: 'end', header: '结束', render: (r) => fmtTimeShort(r.ended_at as number | null, filters.timezone) },
            ]}
            rows={eq.toolFailures as unknown as Record<string, unknown>[]}
            rowKey={(r) => String(r.tool_call_id)}
            empty={<EmptyState title="无工具失败" />} />
        </Card>
        <Card span={6} title="关系异常" sub="Run 父子关系验证（不删除数据）">
          <DataTable dense
            columns={[
              { key: 'run', header: 'Run', render: (r) => <span className="mono">{shortId(String(r.runId))}</span> },
              { key: 'why', header: '原因', render: (r) => (r.reasons as string[]).join(', ') },
            ]}
            rows={dq.relationAnomalies as unknown as Record<string, unknown>[]}
            rowKey={(r) => String(r.runId)}
            empty={<EmptyState title="无关系异常" />} />
        </Card>
      </div>

      <Card title="登记问题明细" sub="obs_registration_issue 服务端分页">
        {issuesQ.isError && <ErrorBanner error={issuesQ.error} onRetry={() => issuesQ.refetch()} />}
        {issuesQ.isPending ? <Skeleton h={200} /> : (
          <>
            <DataTable dense
              columns={[
                { key: 't', header: '最近出现', render: (r) => fmtTime(r.last_seen_at as number | null, filters.timezone) },
                { key: 'code', header: 'code', render: (r) => <span className="mono">{String(r.issue_code)}</span> },
                { key: 'sev', header: '级别', render: (r) => <Badge tone={String(r.severity) === 'ERROR' ? 'failure' : 'warning'}>{String(r.severity)}</Badge> },
                { key: 'entity', header: '实体', render: (r) => <span className="mono">{r.entity_id ? shortId(String(r.entity_id)) : '—'}</span> },
                { key: 'n', header: '次数', numeric: true, render: (r) => fmtInt(r.occurrence_count as number) },
                { key: 'res', header: '处置', render: (r) => String(r.resolution ?? '—') },
              ]}
              rows={issues}
              rowKey={(r, i) => String(r.issue_id ?? i)}
              empty={<EmptyState title="无登记问题" />} />
            <Pager hasMore={issuesQ.data?.data.hasMore} canPrev={stack.length > 1}
              onNext={() => issuesQ.data?.data.nextCursor && setStack((s) => [...s, issuesQ.data.data.nextCursor!])}
              onPrev={() => setStack((s) => (s.length > 1 ? s.slice(0, -1) : s))}
              note={issuesQ.isFetching ? '更新中…' : `本页 ${issues.length} 条`} />
          </>
        )}
      </Card>
    </div>
  );
}
