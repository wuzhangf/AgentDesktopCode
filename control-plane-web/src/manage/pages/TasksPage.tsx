// 任务执行记录（只读）: 增量 A 无任务实体 — 聚合各 Worker journal 的
// execution_journal 真实行。创建/草稿/组织在增量 B。
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { Banner, Card, EmptyState, ErrorBanner, Skeleton } from '../../components/ui/primitives';
import { DataTable } from '../../components/ui/DataTable';
import { usePageVisible } from '../../api/hooks';
import { asList, manageGet, useManage } from '../api';
import type { JournalRow, WorkerJournalView, WorkerSummary } from '../../../shared/management/api';
import { fmtIso, relTime } from '../labels';
import { shortId } from '../../lib/format';

interface TaskRow { workerKey: string; workerName: string; row: JournalRow }
interface WorkerJournal { worker: WorkerSummary; view: WorkerJournalView | null; error: string | null }

export default function TasksPage() {
  const nav = useNavigate();
  const visible = usePageVisible();
  const workersQ = useManage<unknown>(['workers'], '/workers', 10000);
  const workers = asList<WorkerSummary>(workersQ.data, 'workers');

  const journalsQ = useQuery({
    queryKey: ['manage', 'task-records', workers.map((w) => w.workerKey).join(',')],
    enabled: workers.length > 0,
    staleTime: 5_000,
    refetchInterval: visible ? 10000 : false,
    queryFn: async ({ signal }): Promise<WorkerJournal[]> => Promise.all(
      workers.map(async (worker): Promise<WorkerJournal> => {
        try {
          const view = await manageGet<WorkerJournalView>(`/workers/${encodeURIComponent(worker.workerKey)}/journal`, signal);
          return { worker, view, error: null };
        } catch (e) {
          return { worker, view: null, error: (e as Error).message };
        }
      }),
    ),
  });

  const rows: TaskRow[] = (journalsQ.data ?? [])
    .filter((j) => j.view)
    .flatMap((j) => j.view!.rows
      .filter((r) => r.table === 'execution_journal')
      .map((row) => ({ workerKey: j.worker.workerKey, workerName: j.worker.name, row })))
    .sort((a, b) => (b.row.updatedAt ?? '').localeCompare(a.row.updatedAt ?? ''));
  const unreadable = (journalsQ.data ?? []).filter((j) => j.error);

  return (
    <div className="col" style={{ gap: 14 }}>
      <h1 className="page-title">任务执行记录（只读）</h1>
      <Banner kind="info">任务创建、草稿与组织在增量 B 交付；此处为各 Worker journal 的真实执行记录。</Banner>

      {workersQ.isPending && <Skeleton h={240} />}
      {workersQ.isError && <ErrorBanner error={workersQ.error} onRetry={() => workersQ.refetch()} />}
      {workersQ.data != null && workers.length === 0 && (
        <Card><EmptyState title="尚未接入 Worker" hint="接入后此处展示各 Worker journal 的真实执行记录。" /></Card>
      )}

      {workers.length > 0 && (
        <Card title={`执行记录 · ${rows.length} 行`} sub="按 updatedAt 倒序">
          {journalsQ.isPending && <Skeleton h={200} />}
          {journalsQ.isError && <ErrorBanner error={journalsQ.error} onRetry={() => journalsQ.refetch()} />}
          {unreadable.map((j) => (
            <div key={j.worker.workerKey} className="muted" style={{ fontSize: 11.5, marginBottom: 4 }}>
              {j.worker.name}：journal 不可读（{j.error}）
            </div>
          ))}
          {journalsQ.data && (
            <DataTable
              dense
              columns={[
                { key: 'worker', header: 'Worker', render: (r) => r.workerName },
                { key: 'key', header: 'Attempt', render: (r) => <span className="mono">{shortId(r.row.key)}</span> },
                { key: 'state', header: '状态', render: (r) => r.row.state ?? '未采集' },
                { key: 'detail', header: '摘要', render: (r) => r.row.detail ?? '—', width: '40%' },
                { key: 'updatedAt', header: '更新', render: (r) => <span title={fmtIso(r.row.updatedAt)}>{relTime(r.row.updatedAt)}</span> },
              ]}
              rows={rows}
              rowKey={(r, i) => `${r.workerKey}:${r.row.key}:${i}`}
              onRowClick={(r) => nav(`/manage/workers/${encodeURIComponent(r.workerKey)}`)}
              empty={<EmptyState title="无执行记录" hint="所有可读 journal 中都没有 execution_journal 行。" />}
            />
          )}
        </Card>
      )}
    </div>
  );
}
