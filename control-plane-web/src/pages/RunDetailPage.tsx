// Run 详情 (§6.3): summary header + timeline Gantt + fact tabs + node inspector.
import { useEffect, useMemo, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { useApi, useApiPage } from '../api/hooks';
import { useAppNavigate, useFilters } from '../state/filters';
import type { RunSummaryData, RunTimelineData } from '../../shared/contracts/types';
import { TimelineGantt } from '../features/timeline/TimelineGantt';
import { NodeInspector } from '../features/timeline/NodeInspector';
import { Badge, Card, EmptyState, ErrorBanner, KV, RelationBadge, Skeleton, StatusBadge, Tabs } from '../components/ui/primitives';
import { DataTable, Pager } from '../components/ui/DataTable';
import { MetricCard } from '../features/metrics/MetricCard';
import { fmtInt, fmtMs, fmtTime, fmtTimeShort, shortId } from '../lib/format';
import { Copy } from 'lucide-react';

const FACT_KINDS = ['steps', 'stepAttempts', 'calls', 'attempts', 'tools', 'commands', 'segments', 'delegations', 'events', 'issues'] as const;

// Per-kind entity id column → timeline nodeId prefix.
const FACT_NODE: Record<string, [string, string]> = {
  steps: ['step_id', 'step:'], stepAttempts: ['step_attempt_id', 'satt:'],
  calls: ['call_id', 'call:'], attempts: ['attempt_id', 'att:'],
  tools: ['tool_call_id', 'tool:'], commands: ['command_id', 'cmd:'],
  segments: ['segment_id', 'seg:'], delegations: ['delegation_id', 'dlg:'],
};

export default function RunDetailPage() {
  const { runId = '' } = useParams();
  const { filters, isLive, sourceEpoch } = useFilters();
  const nav = useAppNavigate();
  const [sp] = useSearchParams();
  const [includeDesc, setIncludeDesc] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [tab, setTab] = useState('summary');
  const [factStack, setFactStack] = useState<(string | null)[]>([null]);

  // URL-carried filters/source changes invalidate the keyset cursor stack.
  const spKey = sp.toString();
  useEffect(() => {
    setFactStack((s) => (s.length > 1 || s[0] != null ? [null] : s));
  }, [spKey, sourceEpoch]);

  const summaryQ = useApi<RunSummaryData>(`/runs/${runId}/summary`,
    { includeDescendants: includeDesc ? 'true' : 'false', relationPolicy: 'verified' },
    { liveIntervalMs: isLive ? 2000 : false, enabled: !!runId });
  const timelineQ = useApi<RunTimelineData>(`/runs/${runId}/timeline`, undefined,
    { liveIntervalMs: isLive ? 2000 : false, enabled: !!runId });
  const factsQ = useApiPage<Record<string, unknown>>(
    `/runs/${runId}/facts`,
    { kind: tab, limit: 50, cursor: factStack[factStack.length - 1] ?? undefined },
    { enabled: !!runId && (FACT_KINDS as readonly string[]).includes(tab) });

  const s = summaryQ.data?.data;
  const tl = timelineQ.data?.data;
  const nodes = tl?.nodes ?? [];
  const selectedNode = useMemo(() => nodes.find((n) => n.nodeId === selected) ?? null, [nodes, selected]);

  if (summaryQ.isPending) return <div className="col"><Skeleton h={90} /><Skeleton h={400} /></div>;
  if (summaryQ.isError) return <ErrorBanner error={summaryQ.error} onRetry={() => summaryQ.refetch()} />;
  if (!s) return <EmptyState title="Run 不存在" />;

  const run = s.run;
  const title = `${run.runKind} 执行 · ${shortId(run.runId)}`;

  return (
    <div className="col" style={{ gap: 14 }}>
      <div className="row wrap">
        <h1 className="page-title mono" style={{ fontSize: 15 }}>{title}</h1>
        <select value={includeDesc ? 'with' : 'direct'} aria-label="汇总口径"
          onChange={(e) => setIncludeDesc(e.target.value === 'with')}>
          <option value="direct">直属事实</option>
          <option value="with">含已验证子级</option>
        </select>
        <button className="ghost" aria-label="复制链接" onClick={() => navigator.clipboard.writeText(location.href)}>
          <Copy size={13} /> 复制链接
        </button>
        {isLive && <Badge tone="success">LIVE · 2s</Badge>}
      </div>

      <Card>
        <div className="row wrap" style={{ gap: 14 }}>
          <StatusBadge outcome={run.outcome} lifecycle={run.lifecycle} activityState={run.activityState} reasons={run.qualityReasons} />
          <RelationBadge state={run.relationState} />
          <KV items={[
            ['Task', run.taskId ? <span className="mono clickable-text" onClick={() => nav(`/tasks/${run.taskId}`)}>{shortId(run.taskId)}</span> : '—'],
            ['Session', <span className="mono">{shortId(run.sessionId)}</span>],
            ['产品', `${run.productName ?? '—'} ${run.productVersion ?? ''}`],
            ['配置版本', run.configRevision ?? '—'],
            ['起止', `${fmtTime(run.startedAt, filters.timezone)} → ${fmtTime(run.endedAt, filters.timezone)}`],
            ['覆盖', run.coverage],
          ]} />
        </div>
        {run.qualityReasons.length > 0 && (
          <div className="banner" style={{ marginTop: 10, marginBottom: 0 }}>
            原始状态提示：{run.qualityReasons.join('、')} — lifecycle={run.lifecycle} outcome={run.outcome ?? 'NULL'} native={run.nativeStatus ?? 'NULL'}
          </div>
        )}
      </Card>

      <div className="kpi-grid">
        {s.stats.map((m) => <MetricCard key={m.metricId} metric={m} />)}
      </div>

      {s.relationAnomalies.length > 0 && (
        <div className="banner">
          关系诊断：{s.relationAnomalies.map((a) => `${shortId(a.runId)}（${a.reason}）`).join('；')}
          {includeDesc && s.excludedRelationCount > 0 && ` · 已排除异常关系 ${s.excludedRelationCount} 条`}
        </div>
      )}

      <div className="grid cols-12">
        <Card span={9} title="执行时间线" sub="横条=确知墙钟区间；菱形=仅登记；虚线尾=未闭合至最后观测；不重排父子">
          {timelineQ.isPending ? <Skeleton h={360} /> : timelineQ.isError ? <ErrorBanner error={timelineQ.error} onRetry={() => timelineQ.refetch()} /> : (
            <TimelineGantt nodes={nodes} originAt={tl?.originAt ?? null}
              selectedId={selected} onSelect={setSelected} truncated={tl?.truncated ?? false} />
          )}
        </Card>
        <Card span={3} title="选中节点">
          <NodeInspector node={selectedNode} timezone={filters.timezone} />
        </Card>
      </div>

      <Card>
        <Tabs
          tabs={[
            { id: 'summary', label: '摘要' },
            { id: 'steps', label: '步骤' },
            { id: 'stepAttempts', label: '步骤尝试' },
            { id: 'calls', label: '模型调用' },
            { id: 'attempts', label: '传输尝试' },
            { id: 'tools', label: '工具' },
            { id: 'commands', label: '命令' },
            { id: 'segments', label: `Segments ${s.segments.length}` },
            { id: 'delegations', label: `委派 ${s.delegations.length}` },
            { id: 'events', label: '事件' },
            { id: 'issues', label: '登记问题' },
          ]}
          active={tab} onChange={(t) => { setTab(t); setFactStack([null]); }} />
        {tab === 'summary' ? (
          <SummaryTab s={s} timezone={filters.timezone} />
        ) : (
          <FactTable kind={tab} loading={factsQ.isPending} error={factsQ.isError ? factsQ.error : null}
            rows={factsQ.data?.data.rows ?? []} total={factsQ.data?.data.total}
            hasMore={factsQ.data?.data.hasMore} canPrev={factStack.length > 1}
            onNext={() => factsQ.data?.data.nextCursor && setFactStack((st) => [...st, factsQ.data.data.nextCursor!])}
            onPrev={() => setFactStack((st) => (st.length > 1 ? st.slice(0, -1) : st))}
            timezone={filters.timezone}
            onRowClick={(row) => {
              const mapping = FACT_NODE[tab];
              const id = mapping ? (row[mapping[0]] as string | undefined) : (row.entity_id as string | undefined);
              if (mapping && id) {
                setSelected(`${mapping[1]}${id}`);
                window.scrollTo({ top: 0, behavior: 'smooth' });
              }
            }} />
        )}
      </Card>
    </div>
  );
}

function SummaryTab({ s, timezone }: { s: RunSummaryData; timezone: string }) {
  const nav = useAppNavigate();
  return (
    <div className="grid cols-12">
      <div className="span-6">
        <h4 style={{ margin: '0 0 8px', fontSize: 12.5 }}>Segments</h4>
        <DataTable dense
          columns={[
            { key: 'segment_no', header: '#', numeric: true, render: (r) => String(r.segment_no) },
            { key: 'state', header: '状态', render: (r) => <StatusBadge outcome={r.outcome as string} lifecycle={r.lifecycle as string} /> },
            { key: 'started_at', header: '开始', render: (r) => fmtTimeShort(r.started_at as number, timezone) },
            { key: 'ended_at', header: '结束', render: (r) => fmtTimeShort(r.ended_at as number, timezone) },
          ]}
          rows={s.segments as unknown as Record<string, unknown>[]}
          rowKey={(r) => String(r.segment_id)} />
      </div>
      <div className="span-6">
        <h4 style={{ margin: '0 0 8px', fontSize: 12.5 }}>子 Run（默认仅展示已验证关系）</h4>
        {s.childRuns.length === 0
          ? <EmptyState title="无子 Run" hint="没有发现 parent_run_id 指向本 Run 的记录。" />
          : (
            <DataTable dense
              columns={[
                { key: 'runId', header: '子 Run', render: (r) => <span className="mono">{shortId(String(r.runId))}</span> },
                { key: 'runKind', header: '类型', render: (r) => String(r.runKind) },
                { key: 'rel', header: '关系', render: (r) => <RelationBadge state={String(r.relationState)} /> },
                { key: 'via', header: '委派', render: (r) => (r.viaDelegation ? '是' : '仅parent字段') },
                { key: 'state', header: '状态', render: (r) => <StatusBadge outcome={r.outcome as string} lifecycle={r.lifecycle as string} /> },
              ]}
              rows={s.childRuns as unknown as Record<string, unknown>[]}
              rowKey={(r) => String(r.runId)}
              onRowClick={(r) => nav(`/runs/${r.runId}`)} />
          )}
        <h4 style={{ margin: '14px 0 8px', fontSize: 12.5 }}>委派记录</h4>
        {s.delegations.length === 0
          ? <EmptyState title="无委派" />
          : (
            <DataTable dense
              columns={[
                { key: 'role', header: '角色', render: (r) => String(r.role ?? '—') },
                { key: 'child', header: '子 Run', render: (r) => <span className="mono">{r.childRunId ? shortId(String(r.childRunId)) : '—'}</span> },
                { key: 'req', header: '请求', render: (r) => fmtTimeShort(r.requestedAt as number | null, timezone) },
                { key: 'acc', header: '接受', render: (r) => fmtTimeShort(r.acceptedAt as number | null, timezone) },
                { key: 'state', header: '状态', render: (r) => <StatusBadge outcome={r.outcome as string} lifecycle={r.lifecycle as string} /> },
              ]}
              rows={s.delegations as unknown as Record<string, unknown>[]}
              rowKey={(r) => String(r.delegationId)}
              onRowClick={(r) => r.childRunId && nav(`/runs/${r.childRunId}`)} />
          )}
      </div>
    </div>
  );
}

const TIME_COLS = new Set(['registered_at', 'started_at', 'ended_at', 'occurred_at', 'recorded_at', 'last_seen_at', 'first_seen_at', 'requested_at', 'accepted_at', 'completed_at', 'observed_at', 'boot_at', 'heartbeat_at', 'stopped_at', 'created_at']);
const BYTE_COLS = new Set(['result_bytes', 'arguments_bytes', 'stdout_bytes', 'stderr_bytes', 'request_wire_bytes', 'response_wire_bytes']);
const MS_COLS = new Set(['duration_ms', 'first_response_ms', 'first_answer_delta_ms', 'first_reasoning_delta_ms', 'backoff_before_ms']);

function FactTable({ kind, rows, loading, error, total, hasMore, canPrev, onNext, onPrev, timezone, onRowClick }: {
  kind: string; rows: Record<string, unknown>[]; loading: boolean; error: unknown; total?: number;
  hasMore?: boolean; canPrev: boolean; onNext: () => void; onPrev: () => void;
  timezone: string; onRowClick: (row: Record<string, unknown>) => void;
}) {
  if (loading) return <Skeleton h={200} />;
  if (error) return <ErrorBanner error={error} />;
  if (!rows.length) return <EmptyState title={`无 ${kind} 记录`} />;
  const cols = Object.keys(rows[0]).filter((k) => !['scope_id', 'schema_version'].includes(k));
  return (
    <>
      <DataTable dense
        columns={cols.slice(0, 14).map((k) => ({
          key: k, header: k,
          render: (r: Record<string, unknown>) => {
            const v = r[k];
            if (v == null) return '—';
            if (TIME_COLS.has(k) && typeof v === 'number') return fmtTime(v, timezone);
            if (MS_COLS.has(k) && typeof v === 'number') return fmtMs(v);
            if (BYTE_COLS.has(k) && typeof v === 'number') return `${v}B`;
            if (typeof v === 'string' && v.length > 40) return <span title={v}>{v.slice(0, 40)}…</span>;
            return String(v);
          },
        }))}
        rows={rows}
        rowKey={(_r, i) => String(i)}
        onRowClick={onRowClick} />
      <div className="row" style={{ marginTop: 6 }}>
        <span className="muted grow" style={{ fontSize: 11 }}>
          {total != null ? `共 ${total} 条` : `${rows.length} 条`} · 点击行定位时间线节点
        </span>
        <Pager hasMore={hasMore} canPrev={canPrev} onNext={onNext} onPrev={onPrev} />
      </div>
    </>
  );
}
