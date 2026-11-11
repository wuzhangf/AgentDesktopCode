// 总览: attention items first, then worker cards, running attempts and
// recent durable operations — all polled from /api/manage/overview.
import { Link, useNavigate } from 'react-router-dom';
import { AlertCircle, Plus } from 'lucide-react';
import { Badge, Card, EmptyState, ErrorBanner, Skeleton } from '../../components/ui/primitives';
import { DataTable } from '../../components/ui/DataTable';
import { useManage } from '../api';
import type { Overview } from '../../../shared/management/api';
import { SEVERITY, relTime } from '../labels';
import { OperationsTable, WorkerCard } from '../components/bits';
import { shortId } from '../../lib/format';

export default function ManageOverviewPage() {
  const nav = useNavigate();
  const q = useManage<Overview>(['overview'], '/overview', 4000);
  const d = q.data;

  if (q.isPending) return <div className="col" style={{ gap: 14 }}><Skeleton h={90} /><Skeleton h={200} /><Skeleton h={200} /></div>;
  if (q.isError) return <ErrorBanner error={q.error} onRetry={() => q.refetch()} />;
  if (!d) return null;

  return (
    <div className="col" style={{ gap: 16 }}>
      <div className="row">
        <h1 className="page-title">总览</h1>
        <span className="muted" style={{ fontSize: 12 }}>数据更新 {relTime(d.generatedAt)}</span>
        <button className="right row" onClick={() => nav('/manage/workers?register=1')} style={{ gap: 6 }}>
          <Plus size={14} /> 接入 Worker
        </button>
      </div>

      <Card title="需要我处理" sub="来自管理面的确定性规则">
        {d.attention.length === 0 ? (
          <EmptyState title="暂无待处理事项" />
        ) : (
          <div className="col">
            {d.attention.map((a) => {
              const sev = SEVERITY[a.severity] ?? SEVERITY.INFO;
              const target = a.workerKey
                ? `/manage/workers/${encodeURIComponent(a.workerKey)}${a.operationId ? `?op=${a.operationId}` : ''}`
                : null;
              return (
                <button key={a.id} className="card raised row" style={{ textAlign: 'left', gap: 10 }}
                  data-testid="attention-item" data-severity={a.severity} data-attention-id={a.id}
                  disabled={!target} onClick={() => target && nav(target)}>
                  <AlertCircle size={15} color={`var(--${a.severity === 'ACTION' ? 'failure' : a.severity === 'WARN' ? 'warning' : 'accent'})`} />
                  <span className="grow" style={{ fontSize: 12.5 }}>{a.message}</span>
                  <Badge tone={sev.tone}>{sev.label}</Badge>
                </button>
              );
            })}
          </div>
        )}
      </Card>

      <Card title="我的 Workers" right={<button className="ghost" onClick={() => nav('/manage/workers')}>全部 →</button>}>
        {d.workers.length === 0 ? (
          <EmptyState title="尚未接入 Worker" hint="通过“接入 Worker”安装受管实例或连接一个已有实例。" />
        ) : (
          <div className="grid cols-12">
            {d.workers.map((w) => (
              <div key={w.workerKey} className="span-4">
                <WorkerCard w={w} onClick={() => nav(`/manage/workers/${encodeURIComponent(w.workerKey)}`)} />
              </div>
            ))}
          </div>
        )}
      </Card>

      <div className="grid cols-12">
        <Card span={6} title="进行中的工作" sub="各 Worker 当前活动 attempt">
          <DataTable
            dense
            columns={[
              {
                key: 'worker', header: 'Worker',
                render: (r) => (
                  <Link to={`/manage/workers/${encodeURIComponent(r.workerKey)}`} onClick={(e) => e.stopPropagation()}>{r.workerName}</Link>
                ),
              },
              { key: 'attempt', header: 'Attempt', render: (r) => <span className="mono">{shortId(r.attemptId)}</span> },
              { key: 'state', header: '状态', render: (r) => r.state ?? '未采集' },
            ]}
            rows={d.runningAttempts}
            rowKey={(r) => `${r.workerKey}:${r.attemptId}`}
            onRowClick={(r) => nav(`/manage/workers/${encodeURIComponent(r.workerKey)}`)}
            empty={<EmptyState title="当前没有进行中的任务" />}
          />
        </Card>
        <Card span={6} title="最近操作" sub="持久化操作记录（幂等）">
          <OperationsTable
            ops={d.recentOperations}
            onPick={(o) => nav(`/manage/workers/${encodeURIComponent(o.workerKey)}?op=${o.operationId}`)}
          />
        </Card>
      </div>
    </div>
  );
}
