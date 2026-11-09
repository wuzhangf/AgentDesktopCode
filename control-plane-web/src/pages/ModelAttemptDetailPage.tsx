// 传输尝试详情: raw attempt + usage (camel) + context/reasoning/costs + siblings.
import { useParams } from 'react-router-dom';
import { useApi } from '../api/hooks';
import { useAppNavigate, useFilters } from '../state/filters';
import { Badge, Card, EmptyState, ErrorBanner, KV, Skeleton, StatusBadge } from '../components/ui/primitives';
import { DataTable } from '../components/ui/DataTable';
import { fmtBytes, fmtMs, fmtTime, fmtTokens, shortId } from '../lib/format';

interface AttemptDetail {
  attempt: Record<string, unknown> | null;
  state: { activityState: string; qualityReasons: string[]; conflict: boolean };
  usage: {
    inputTokens: number | null; outputTokens: number | null; reasoningTokens: number | null;
    totalTokens: number | null; uncachedInputTokens: number | null;
    cacheReadInputTokens: number | null; cacheWriteInputTokens: number | null;
    inputCoverage: string | null; reasoningRelation: string | null;
    totalSource: string | null; measurementSource: string | null;
    usageRevision: number | null; reportedAt: number | null;
  };
  context: Record<string, unknown> | null;
  reasoning: { integrationState: string; outputMode: string; status: string; blockCount: number; observedTextBytes: number | null; captureState: string; label: string } | null;
  costs: Record<string, unknown>[];
  siblingAttempts: { attempt_id: string; transport_attempt_no: number; dispatch_state: string; transport_outcome: string | null; http_status: number | null }[];
}

export default function ModelAttemptDetailPage() {
  const { attemptId = '' } = useParams();
  const nav = useAppNavigate();
  const { filters } = useFilters();
  const q = useApi<AttemptDetail>(`/model-attempts/${attemptId}`, undefined, { enabled: !!attemptId });
  const d = q.data?.data;

  if (q.isPending) return <div className="col"><Skeleton h={100} /><Skeleton h={200} /></div>;
  if (q.isError) return <ErrorBanner error={q.error} onRetry={() => q.refetch()} />;
  if (!d?.attempt) return <EmptyState title="Attempt 不存在" />;

  const a = d.attempt;
  const u = d.usage;
  return (
    <div className="col" style={{ gap: 16 }}>
      <div className="row wrap">
        <h1 className="page-title mono" style={{ fontSize: 15 }}>Attempt {shortId(attemptId)}</h1>
        <StatusBadge outcome={a.outcome as string} lifecycle={a.lifecycle as string}
          activityState={d.state?.activityState} reasons={d.state?.qualityReasons} />
        {a.run_id != null && (
          <button className="ghost" onClick={() => nav(`/runs/${a.run_id}`)}>所属 Run →</button>
        )}
      </div>

      <div className="grid cols-12">
        <Card span={6} title="传输事实" sub="原始字段；状态为读取时投影">
          <KV items={[
            ['请求模型', String(a.requested_model ?? '—')],
            ['解析模型', String(a.resolved_model ?? '—')],
            ['响应模型', String(a.response_model ?? '—')],
            ['provider', String(a.provider_id ?? '—')],
            ['visibility', String(a.visibility ?? '—')],
            ['dispatch', String(a.dispatch_state ?? '—')],
            ['transport_outcome', String(a.transport_outcome ?? '—')],
            ['http_status', String(a.http_status ?? '—')],
            ['failure_class', String(a.failure_class ?? '—')],
            ['传输序号', `product ${a.product_attempt_no ?? '—'} / route ${a.route_attempt_no ?? '—'} / transport ${a.transport_attempt_no ?? '—'}`],
            ['开始', fmtTime(a.started_at as number | null, filters.timezone)],
            ['结束', fmtTime(a.ended_at as number | null, filters.timezone)],
            ['duration_ms', fmtMs(a.duration_ms as number | null)],
            ['首响应', fmtMs(a.first_response_ms as number | null)],
            ['首答案Δ', fmtMs(a.first_answer_delta_ms as number | null)],
            ['首思考Δ', fmtMs(a.first_reasoning_delta_ms as number | null)],
            ['退避前', fmtMs(a.backoff_before_ms as number | null)],
          ]} />
        </Card>
        <Card span={6} title="用量记录" sub="NULL 不渲染为 0；total 需 PROVIDER/DERIVED 口径">
          <KV items={[
            ['input', fmtTokens(u.inputTokens)],
            ['output', fmtTokens(u.outputTokens)],
            ['reasoning', fmtTokens(u.reasoningTokens)],
            ['total', fmtTokens(u.totalTokens)],
            ['uncached_input', fmtTokens(u.uncachedInputTokens)],
            ['cache_read', fmtTokens(u.cacheReadInputTokens)],
            ['cache_write', fmtTokens(u.cacheWriteInputTokens)],
            ['input_coverage', String(u.inputCoverage ?? '—')],
            ['reasoning_relation', String(u.reasoningRelation ?? '—')],
            ['total_source', String(u.totalSource ?? '—')],
            ['measurement', String(u.measurementSource ?? '—')],
            ['usage_revision', String(u.usageRevision ?? '—')],
            ['reported_at', fmtTime(u.reportedAt, filters.timezone)],
          ]} />
        </Card>
      </div>

      <div className="grid cols-12">
        <Card span={4} title="上下文快照">
          {d.context ? (
            <KV items={[
              ['context_id', <span className="mono">{shortId(String(d.context.context_id))}</span>],
              ['估算 input', fmtTokens(d.context.input_tokens_estimated as number | null)],
              ['窗口', fmtTokens(d.context.window_tokens as number | null)],
              ['可用 input', fmtTokens(d.context.usable_input_tokens as number | null)],
              ['estimate_quality', String(d.context.estimate_quality ?? '—')],
            ]} />
          ) : <EmptyState title="无上下文快照" />}
        </Card>
        <Card span={4} title="推理输出" sub={d.reasoning?.label}>
          {d.reasoning ? (
            <KV items={[
              ['integration', String(d.reasoning.integrationState)],
              ['output_mode', String(d.reasoning.outputMode)],
              ['status', String(d.reasoning.status)],
              ['block 数', String(d.reasoning.blockCount)],
              ['观测字节', fmtBytes(d.reasoning.observedTextBytes)],
              ['capture', String(d.reasoning.captureState)],
            ]} />
          ) : <EmptyState title="无可见推理输出" hint="不代表没有推理——可能是 capture_state 未记录。" />}
        </Card>
        <Card span={4} title="费用观测" sub="十进制字符串；按 authority_key 最新 revision">
          {d.costs.length ? (
            <DataTable dense
              columns={[
                { key: 'cat', header: '类别', render: (r) => String(r.category ?? '—') },
                { key: 'amt', header: '金额', numeric: true, render: (r) => `${r.amount_decimal ?? '—'} ${r.currency ?? ''}` },
                { key: 'src', header: '来源', render: (r) => String(r.source ?? '—') },
              ]}
              rows={d.costs}
              rowKey={(r) => String(r.cost_id ?? r.authority_key)} />
          ) : <EmptyState title="无费用观测" />}
        </Card>
      </div>

      <Card title="同调用的兄弟尝试" sub="同一逻辑 Call 下的所有传输尝试（重试链）">
        <DataTable dense
          columns={[
            { key: 'id', header: 'Attempt', render: (r) => <span className="mono">{shortId(String(r.attempt_id))}</span> },
            { key: 'no', header: '序号', numeric: true, render: (r) => String(r.transport_attempt_no) },
            { key: 'disp', header: '派发', render: (r) => <Badge tone="plain">{String(r.dispatch_state ?? '—')}</Badge> },
            { key: 'out', header: '传输结果', render: (r) => String(r.transport_outcome ?? '—') },
            { key: 'http', header: 'HTTP', numeric: true, render: (r) => String(r.http_status ?? '—') },
          ]}
          rows={d.siblingAttempts}
          rowKey={(r) => String(r.attempt_id)}
          onRowClick={(r) => r.attempt_id !== attemptId && nav(`/models/attempts/${r.attempt_id}`)}
          empty={<EmptyState title="无兄弟尝试" />} />
      </Card>
    </div>
  );
}
