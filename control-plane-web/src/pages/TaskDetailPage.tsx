// Task 详情 (§6.2.1): task fact + related runs.
import { useParams } from 'react-router-dom';
import { useApi } from '../api/hooks';
import { useAppNavigate, useFilters } from '../state/filters';
import { Card, EmptyState, ErrorBanner, KV, Skeleton, StatusBadge } from '../components/ui/primitives';
import { DataTable } from '../components/ui/DataTable';
import { fmtTime, fmtTimeShort, shortId } from '../lib/format';

interface TaskData {
  task: Record<string, unknown> | null;
  runs: { runId: string; runKind: string; lifecycle: string; outcome: string | null; activityState: string; startedAt: number | null; endedAt: number | null; durationMs: number | null; stepCount: number }[];
}

export default function TaskDetailPage() {
  const { taskId = '' } = useParams();
  const nav = useAppNavigate();
  const { filters } = useFilters();
  const q = useApi<TaskData>(`/tasks/${taskId}`, undefined, { enabled: !!taskId });
  const d = q.data?.data;

  if (q.isPending) return <div className="col"><Skeleton h={100} /><Skeleton h={220} /></div>;
  if (q.isError) return <ErrorBanner error={q.error} onRetry={() => q.refetch()} />;
  if (!d?.task) return <EmptyState title="Task 不存在" />;

  const t = d.task;
  return (
    <div className="col" style={{ gap: 16 }}>
      <h1 className="page-title mono" style={{ fontSize: 15 }}>Task {shortId(taskId)}</h1>
      <Card title="Task 事实">
        <KV items={[
          ['lifecycle', String(t.lifecycle)],
          ['outcome', String(t.outcome ?? '—')],
          ['task_kind', String(t.task_kind ?? '—')],
          ['started', fmtTime(t.started_at as number | null, filters.timezone)],
          ['ended', fmtTime(t.ended_at as number | null, filters.timezone)],
          ['registered', fmtTime(t.registered_at as number | null, filters.timezone)],
        ]} />
      </Card>
      <Card title="相关 Run" sub={`${d.runs.length} 条`}>
        <DataTable
          columns={[
            { key: 'runId', header: 'Run', render: (r) => <span className="mono">{shortId(r.runId)}</span> },
            { key: 'runKind', header: '类型', render: (r) => String(r.runKind) },
            { key: 'state', header: '状态', render: (r) => <StatusBadge outcome={r.outcome} lifecycle={r.lifecycle} activityState={r.activityState} /> },
            { key: 'startedAt', header: '开始', render: (r) => fmtTimeShort(r.startedAt, filters.timezone) },
            { key: 'steps', header: '步数', numeric: true, render: (r) => String(r.stepCount) },
          ]}
          rows={d.runs}
          rowKey={(r) => r.runId}
          onRowClick={(r) => nav(`/runs/${r.runId}`)}
          empty={<EmptyState title="无关联 Run" />} />
      </Card>
    </div>
  );
}
