// 我的 Workers: grouped by machine (increment A: 本机). Row → detail.
// '接入 Worker' opens the register drawer (MANAGED install / EXTERNAL attach).
import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Plus } from 'lucide-react';
import { Card, EmptyState, ErrorBanner, Skeleton } from '../../components/ui/primitives';
import { DataTable } from '../../components/ui/DataTable';
import { asList, useInvalidateManage, useManage } from '../api';
import type { WorkerSummary } from '../../../shared/management/api';
import { relTime } from '../labels';
import { AcceptingBadge, CapIcons, ConnDot, KindBadge } from '../components/bits';
import { RegisterWorkerDrawer } from '../components/RegisterWorkerDrawer';
import { shortId } from '../../lib/format';

export default function WorkersPage() {
  const nav = useNavigate();
  const [sp, setSp] = useSearchParams();
  const [drawer, setDrawer] = useState(sp.get('register') === '1');
  // Consume ?register=1 once — leaving it in the URL would re-open the drawer
  // on every subsequent params change on this page.
  useEffect(() => {
    if (sp.get('register') !== '1') return;
    setDrawer(true);
    setSp((prev) => { const next = new URLSearchParams(prev); next.delete('register'); return next; }, { replace: true });
  }, [sp, setSp]);
  const invalidate = useInvalidateManage();
  const q = useManage<unknown>(['workers'], '/workers', 5000);
  const workers = useMemo(() => asList<WorkerSummary>(q.data, 'workers'), [q.data]);

  const groups = useMemo(() => {
    const m = new Map<string, WorkerSummary[]>();
    for (const w of workers) {
      const list = m.get(w.machine) ?? [];
      list.push(w);
      m.set(w.machine, list);
    }
    return [...m.entries()];
  }, [workers]);

  return (
    <div className="col" style={{ gap: 16 }}>
      <div className="row">
        <h1 className="page-title">我的 Workers</h1>
        <button className="right row" onClick={() => setDrawer(true)} style={{ gap: 6 }}>
          <Plus size={14} /> 接入 Worker
        </button>
      </div>

      {q.isPending && <div className="col"><Skeleton h={140} /><Skeleton h={140} /></div>}
      {q.isError && <ErrorBanner error={q.error} onRetry={() => q.refetch()} />}
      {q.data != null && workers.length === 0 && (
        <Card><EmptyState title="尚未接入 Worker" hint="安装一个由本机管理的 Worker，或连接一个已在运行的实例。" /></Card>
      )}

      {groups.map(([machine, list]) => (
        <Card key={machine} title={machine === 'local' ? '本机' : machine} sub={`${list.length} 个 Worker`}>
          <DataTable
            columns={[
              {
                key: 'name', header: '名称',
                render: (w) => (
                  <span className="row" style={{ gap: 8 }} data-testid="worker-card" data-worker-key={w.workerKey}>
                    <b>{w.name}</b><KindBadge kind={w.kind} />
                  </span>
                ),
              },
              { key: 'conn', header: '连接', render: (w) => <ConnDot state={w.connection} /> },
              { key: 'accepting', header: '接单', render: (w) => <AcceptingBadge state={w.acceptingTasks} /> },
              {
                key: 'ids', header: 'workerId / instanceId',
                render: (w) => (
                  <span className="mono muted">
                    {w.workerId ? shortId(w.workerId) : '未采集'} / {w.instanceId ? shortId(w.instanceId) : '未采集'}
                  </span>
                ),
              },
              { key: 'provider', header: '引擎', render: (w) => w.provider ?? '未知' },
              { key: 'version', header: '版本', render: (w) => <span className="mono">{w.version ?? '未采集'}</span> },
              { key: 'seen', header: '最近在线', render: (w) => <span title={w.lastSeenAt ?? ''}>{relTime(w.lastSeenAt)}</span> },
              { key: 'caps', header: '能力', render: (w) => <CapIcons caps={w.capabilities} /> },
            ]}
            rows={list}
            rowKey={(w) => w.workerKey}
            onRowClick={(w) => nav(`/manage/workers/${encodeURIComponent(w.workerKey)}`)}
          />
        </Card>
      ))}

      <RegisterWorkerDrawer
        open={drawer}
        onClose={() => setDrawer(false)}
        onRegistered={(key) => {
          setDrawer(false);
          invalidate();
          if (key) nav(`/manage/workers/${encodeURIComponent(key)}`);
        }}
      />
    </div>
  );
}
