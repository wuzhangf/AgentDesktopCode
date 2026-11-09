// 计划与协作 (P1 surface, §6.5): plan revisions, delegations, relation anomalies.
// Honest empty states — absence of plan/delegation tables is a capability gap,
// not zero collaboration.

import { useApi } from '../api/hooks';
import { useAppNavigate, useFilters } from '../state/filters';
import { Badge, Banner, Card, EmptyState, ErrorBanner, Skeleton, StatusBadge } from '../components/ui/primitives';
import { DataTable } from '../components/ui/DataTable';
import { fmtMs, fmtTimeShort, shortId } from '../lib/format';

interface CollaborationData {
  plans: {
    planId: string; revisionCount: number; hasInitial: boolean;
    revisions: {
      planRevisionId: string; revisionNo: number; changeReason: string | null;
      approvalState: string | null; runId: string | null;
      registeredAt: number | null; lifecycle: string; outcome: string | null;
    }[];
  }[];
  delegations: {
    delegationId: string; parentRunId: string | null; childRunId: string | null;
    role: string | null; requestedAt: number | null; acceptedAt: number | null;
    startedAt: number | null; completedAt: number | null;
    lifecycle: string; outcome: string | null;
    queueMs: number | null; startWaitMs: number | null;
  }[];
  relationAnomalies: { runId: string; reasons: string[] }[];
  capabilityNote: string;
}

export default function CollaborationPage() {
  const { filters } = useFilters();
  const nav = useAppNavigate();
  const q = useApi<CollaborationData>('/analytics/collaboration');
  const d = q.data?.data;

  if (q.isPending) return <div className="col"><Skeleton h={200} /><Skeleton h={260} /></div>;
  if (q.isError) return <ErrorBanner error={q.error} onRetry={() => q.refetch()} />;
  if (!d) return null;

  return (
    <div className="col" style={{ gap: 16 }}>
      <div className="row">
        <h1 className="page-title">计划与协作</h1>
        <Badge tone="info">P1 能力面</Badge>
      </div>
      <Banner kind="info">{d.capabilityNote}</Banner>

      <div className="grid cols-12">
        <Card span={6} title="Plan 修订" sub={`${d.plans.length} 个 plan`}>
          {d.plans.length === 0 ? (
            <EmptyState title="无 Plan 记录" hint="obs_plan_revision 在窗口内没有行——计划能力可能未启用或未被观测。" />
          ) : (
            <div className="col">
              {d.plans.map((p) => (
                <Card key={p.planId} raised>
                  <div className="row" style={{ fontSize: 12.5 }}>
                    <span className="mono">{shortId(p.planId)}</span>
                    <span className="muted right">{p.revisionCount} 个修订{!p.hasInitial && ' · 缺 rev0'}</span>
                  </div>
                  <DataTable dense
                    columns={[
                      { key: 'rev', header: 'rev', numeric: true, width: 40, render: (r) => String(r.revisionNo) },
                      { key: 'reason', header: '变更原因', render: (r) => String(r.changeReason ?? '—') },
                      { key: 'appr', header: '审批', render: (r) => <Badge tone="plain">{String(r.approvalState ?? '—')}</Badge> },
                      { key: 'at', header: '登记', render: (r) => fmtTimeShort(r.registeredAt as number | null, filters.timezone) },
                    ]}
                    rows={p.revisions as unknown as Record<string, unknown>[]}
                    rowKey={(r) => String(r.planRevisionId)}
                    onRowClick={(r) => r.runId && nav(`/runs/${r.runId}`)} />
                </Card>
              ))}
            </div>
          )}
        </Card>
        <Card span={6} title="委派链" sub="obs_delegation：queueMs=接受-请求；startWaitMs=开始-接受">
          <DataTable dense
            columns={[
              { key: 'role', header: '角色', render: (r) => String(r.role ?? '—') },
              { key: 'child', header: '子 Run', render: (r) => <span className="mono">{r.childRunId ? shortId(String(r.childRunId)) : '未绑定'}</span> },
              { key: 'queue', header: '排队', numeric: true, render: (r) => fmtMs(r.queueMs as number | null) },
              { key: 'wait', header: '待启动', numeric: true, render: (r) => fmtMs(r.startWaitMs as number | null) },
              { key: 'state', header: '状态', render: (r) => <StatusBadge outcome={r.outcome as string} lifecycle={r.lifecycle as string} /> },
            ]}
            rows={d.delegations as unknown as Record<string, unknown>[]}
            rowKey={(r) => String(r.delegationId)}
            onRowClick={(r) => r.childRunId && nav(`/runs/${r.childRunId}`)}
            empty={<EmptyState title="无委派记录" hint="没有父子 Run 协作被观测到。" />} />
        </Card>
      </div>

      <Card title="关系异常" sub="parent/root 链校验失败的 Run——展示但不剔除原始记录">
        <DataTable dense
          columns={[
            { key: 'run', header: 'Run', render: (r) => <span className="mono">{shortId(String(r.runId))}</span> },
            { key: 'why', header: '异常', render: (r) => (r.reasons as string[]).join(', ') },
          ]}
          rows={d.relationAnomalies as unknown as Record<string, unknown>[]}
          rowKey={(r) => String(r.runId)}
          onRowClick={(r) => nav(`/runs/${r.runId}`)}
          empty={<EmptyState title="无关系异常" />} />
      </Card>
    </div>
  );
}
