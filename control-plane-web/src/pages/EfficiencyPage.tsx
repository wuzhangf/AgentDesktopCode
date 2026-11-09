// 费用与效率 (P1 surface, §6.8): cost facets by source×currency (no cross-source
// totals without an authorityPolicy), receipts table. Decimal strings only.

import { useApi } from '../api/hooks';
import { useAppNavigate, useFilters } from '../state/filters';
import { Badge, Banner, Card, EmptyState, ErrorBanner, Skeleton } from '../components/ui/primitives';
import { DataTable } from '../components/ui/DataTable';
import { fmtInt, fmtTime, shortId } from '../lib/format';

interface EfficiencyData {
  capability: 'AVAILABLE' | 'NO_DATA' | 'SCHEMA_MISSING';
  authorityPolicy: { preferredSource?: string } | null;
  facets?: { source: string; currency: string | null; sum: string; count: number; unknownCount: number }[];
  preferred?: { source: string; currency: string | null; sum: string; count: number; unknownCount: number }[] | null;
  receipts?: {
    costId: string; attemptId: string | null; commandId: string | null;
    category: string | null; source: string | null; authorityKey: string | null;
    revision: number; amount: string | null; currency: string | null;
    completeness: string | null; observedAt: number | null; pricingRevision: string | null;
  }[];
  note?: string;
}

export default function EfficiencyPage() {
  const { filters } = useFilters();
  const nav = useAppNavigate();
  const q = useApi<EfficiencyData>('/analytics/efficiency');
  const d = q.data?.data;

  if (q.isPending) return <div className="col"><Skeleton h={160} /><Skeleton h={240} /></div>;
  if (q.isError) return <ErrorBanner error={q.error} onRetry={() => q.refetch()} />;
  if (!d) return null;

  return (
    <div className="col" style={{ gap: 16 }}>
      <div className="row">
        <h1 className="page-title">费用与效率</h1>
        <Badge tone="info">P1 能力面</Badge>
      </div>
      {d.note && <Banner kind="info">{d.note}</Banner>}
      {d.capability === 'SCHEMA_MISSING' && (
        <Banner kind="info">当前 schema 无 obs_cost_observation 表。</Banner>
      )}

      <Card title="费用分面" sub="来源 × 币种；无 authorityPolicy 时不提供跨来源总计"
        right={d.authorityPolicy?.preferredSource ? <Badge tone="info">权威来源：{d.authorityPolicy.preferredSource}</Badge> : <Badge tone="unknown">无权威来源策略</Badge>}>
        {(d.facets?.length ?? 0) === 0 ? (
          <EmptyState title="无费用观测" hint="obs_cost_observation 在窗口内没有记录。" />
        ) : (
          <DataTable
            columns={[
              { key: 'src', header: '来源', render: (r) => <span className="row">{String(r.source)}{d.authorityPolicy?.preferredSource === r.source && <Badge tone="info">权威</Badge>}</span> },
              { key: 'cur', header: '币种', render: (r) => String(r.currency ?? '—') },
              { key: 'sum', header: '合计（十进制）', numeric: true, render: (r) => <span className="mono">{String(r.sum)}</span> },
              { key: 'n', header: '记录', numeric: true, render: (r) => fmtInt(r.count as number) },
              { key: 'unk', header: '金额未知', numeric: true, render: (r) => fmtInt(r.unknownCount as number) },
            ]}
            rows={d.facets as unknown as Record<string, unknown>[]}
            rowKey={(r) => `${r.source}|${r.currency}`} />
        )}
      </Card>

      <Card title="费用收据" sub="按 authority_key 取最新 revision；金额为十进制字符串">
        <DataTable dense
          columns={[
            { key: 'cat', header: '类别', render: (r) => String(r.category ?? '—') },
            { key: 'amt', header: '金额', numeric: true, render: (r) => <span className="mono">{r.amount != null ? `${r.amount} ${r.currency ?? ''}` : '—'}</span> },
            { key: 'src', header: '来源', render: (r) => String(r.source ?? '—') },
            { key: 'rev', header: 'rev', numeric: true, render: (r) => String(r.revision) },
            { key: 'att', header: 'Attempt', render: (r) => r.attemptId ? <span className="mono">{shortId(String(r.attemptId))}</span> : '—' },
            { key: 'comp', header: '完整性', render: (r) => <Badge tone="plain">{String(r.completeness ?? '—')}</Badge> },
            { key: 'at', header: '观测', render: (r) => fmtTime(r.observedAt as number | null, filters.timezone) },
          ]}
          rows={(d.receipts ?? []) as unknown as Record<string, unknown>[]}
          rowKey={(r) => String(r.costId)}
          onRowClick={(r) => r.attemptId && nav(`/models/attempts/${r.attemptId}`)}
          empty={<EmptyState title="无收据" />} />
      </Card>
    </div>
  );
}
