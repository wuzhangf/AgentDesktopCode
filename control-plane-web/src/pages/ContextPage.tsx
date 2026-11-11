// 上下文分析 (§6.5): capability-aware — pressure bullets, component groups,
// transforms, risk list. capability=SCHEMA_MISSING/NO_DATA → honest empty.
import { useMemo } from 'react';

import { useApi } from '../api/hooks';
import { useAppNavigate, useFilters } from '../state/filters';
import { ChartCard } from '../components/charts/ChartCard';
import { bulletOption, rankedBarOption } from '../components/charts/options';
import { Badge, Banner, Card, EmptyState, ErrorBanner, Skeleton } from '../components/ui/primitives';
import { DataTable } from '../components/ui/DataTable';
import { fmtInt, fmtRatio, fmtTimeShort, fmtTokens, shortId } from '../lib/format';

interface ContextData {
  capability: 'AVAILABLE' | 'NO_DATA' | 'SCHEMA_MISSING';
  snapshotCount?: number;
  pressure?: {
    contextId: string; runId: string | null; windowRatio: number | null;
    budgetRatio: number | null; estimated: number | null; window: number | null;
    usable: number | null; estimateQuality: string | null;
  }[];
  components?: {
    context_id: string; component_key: string; component_kind: string;
    measurement_basis: string | null; unit: string | null; measured_value: number | null;
    partition_id: string | null; quality: string | null; source_ref: string | null;
  }[];
  transforms?: {
    transformId: string; transformKind: string | null; reasonCode: string | null;
    beforeEstimate: number | null; afterEstimate: number | null;
    removedMessages: number | null; runId: string | null;
    registeredAt: number | null; delta: number | null;
  }[];
  riskList?: {
    contextId: string; runId: string | null; budgetRemaining: number | null;
    largestMessageUnits: number | null; toolSchemaCount: number | null; budgetRatio: number | null;
  }[];
  note?: string;
}

export default function ContextPage() {
  const { filters } = useFilters();
  const nav = useAppNavigate();
  const q = useApi<ContextData>('/analytics/context');
  const d = q.data?.data;

  const pressureOption = useMemo(() => {
    if (!d?.pressure?.length) return null;
    return bulletOption(d.pressure.slice(0, 12).map((p) => ({
      name: `${shortId(p.contextId)}${p.runId ? ` · ${shortId(p.runId)}` : ''}`,
      value: p.budgetRatio, max: 1,
    })));
  }, [d]);

  const compOption = useMemo(() => {
    if (!d?.components?.length) return null;
    const byKind = new Map<string, number>();
    for (const comp of d.components) {
      const key = `${comp.component_kind}${comp.unit ? ` (${comp.unit})` : ''}`;
      byKind.set(key, (byKind.get(key) ?? 0) + 1);
    }
    return rankedBarOption([...byKind.entries()].map(([name, value]) => ({ name, value })));
  }, [d]);

  if (q.isPending) return <div className="col"><Skeleton h={240} /><Skeleton h={240} /></div>;
  if (q.isError) return <ErrorBanner error={q.error} onRetry={() => q.refetch()} />;
  if (!d) return null;

  if (d.capability === 'SCHEMA_MISSING') {
    return (
      <div className="col" style={{ gap: 16 }}>
        <h1 className="page-title">上下文分析</h1>
        <Banner kind="info">当前 schema 无 obs_context_snapshot 表——这是 P1 能力面，不是数据为零。</Banner>
      </div>
    );
  }

  return (
    <div className="col" style={{ gap: 16 }}>
      <div className="row">
        <h1 className="page-title">上下文分析</h1>
        <Badge tone="info">快照 {d.snapshotCount ?? 0}</Badge>
      </div>
      {d.note && <Banner kind="info">{d.note}</Banner>}

      <div className="grid cols-12">
        <ChartCard span={7} title="窗口压力" caliber="estimated/usable_input_tokens；≥85% 警告、≥95% 临界"
          option={pressureOption} height={240}
          empty={<EmptyState title="无压力样本" hint="快照缺少 input_tokens_estimated 或 usable_input_tokens。" />}
          table={{
            columns: [
              { key: 'ctx', header: 'Context', render: (r) => <span className="mono">{shortId(String(r.contextId))}</span> },
              { key: 'ratio', header: '占用', numeric: true, render: (r) => fmtRatio(r.budgetRatio as number | null) },
              { key: 'est', header: '估算', numeric: true, render: (r) => fmtTokens(r.estimated as number | null) },
              { key: 'usable', header: '可用', numeric: true, render: (r) => fmtTokens(r.usable as number | null) },
            ],
            rows: (d.pressure ?? []) as unknown as Record<string, unknown>[],
          }}
          onClickPoint={(p) => {
            const row = d.pressure?.[p.dataIndex ?? -1];
            if (row?.runId) nav(`/runs/${row.runId}`);
          }} />
        <ChartCard span={5} title="组件构成" caliber="component_kind 计数；字节与 token 不混加"
          option={compOption} height={240}
          empty={<EmptyState title="无组件记录" />}
          table={{
            columns: [
              { key: 'kind', header: '组件', render: (r) => String(r.component_kind) },
              { key: 'unit', header: '单位', render: (r) => String(r.unit ?? '—') },
              { key: 'val', header: '测量值', numeric: true, render: (r) => r.measured_value == null ? '—' : fmtInt(r.measured_value as number) },
              { key: 'quality', header: '质量', render: (r) => String(r.quality ?? '—') },
            ],
            rows: (d.components ?? []) as unknown as Record<string, unknown>[],
          }} />
      </div>

      <div className="grid cols-12">
        <Card span={7} title="上下文变换" sub="obs_context_transform：before→after 估算增量">
          <DataTable dense
            columns={[
              { key: 'kind', header: '类型', render: (r) => String(r.transformKind ?? '—') },
              { key: 'reason', header: '原因', render: (r) => String(r.reasonCode ?? '—') },
              { key: 'delta', header: '估算Δ', numeric: true, render: (r) => r.delta == null ? '—' : fmtTokens(r.delta as number) },
              { key: 'removed', header: '移除消息', numeric: true, render: (r) => fmtInt(r.removedMessages as number | null) },
              { key: 'at', header: '登记', render: (r) => fmtTimeShort(r.registeredAt as number | null, filters.timezone) },
            ]}
            rows={(d.transforms ?? []) as unknown as Record<string, unknown>[]}
            rowKey={(r) => String(r.transformId)}
            onRowClick={(r) => r.runId && nav(`/runs/${r.runId}`)}
            empty={<EmptyState title="无变换记录" hint="上下文变换属于 P1 深度分析。" />} />
        </Card>
        <Card span={5} title="风险清单" sub="预算剩余最小的快照">
          <DataTable dense
            columns={[
              { key: 'ctx', header: 'Context', render: (r) => <span className="mono">{shortId(String(r.contextId))}</span> },
              { key: 'remain', header: '剩余预算', numeric: true, render: (r) => fmtTokens(r.budgetRemaining as number | null) },
              { key: 'ratio', header: '占用', numeric: true, render: (r) => fmtRatio(r.budgetRatio as number | null) },
              { key: 'msg', header: '最大消息', numeric: true, render: (r) => fmtInt(r.largestMessageUnits as number | null) },
              { key: 'tools', header: '工具schema', numeric: true, render: (r) => fmtInt(r.toolSchemaCount as number | null) },
            ]}
            rows={(d.riskList ?? []) as unknown as Record<string, unknown>[]}
            rowKey={(r) => String(r.contextId)}
            onRowClick={(r) => r.runId && nav(`/runs/${r.runId}`)}
            empty={<EmptyState title="无快照" />} />
        </Card>
      </div>
    </div>
  );
}
