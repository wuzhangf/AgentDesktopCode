import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Card, ErrorBanner, Skeleton } from '../../components/ui/primitives';
import { usePersonal } from '../hooks';
import { TaskLaunchCard } from '../components/TaskLaunchCard';
export default function TasksPage() {
  const [cursor, setCursor] = useState<string>();
  const tasks = usePersonal(['tasks', cursor], g => g.tasks(cursor), {refetchInterval: 10_000});
  return <div className="col" style={{gap: 16}}><h1 className="page-title">任务</h1><TaskLaunchCard />
    <Card title="任务列表" sub="保存在管理服务，刷新或更换浏览器后仍可查找">
      {tasks.isPending && <Skeleton h={80} />}
      {tasks.isError && <ErrorBanner error={tasks.error} onRetry={() => tasks.refetch()} />}
      {tasks.data?.data.items.map(t => <div key={t.taskId} className="row" style={{padding: 10}}><Link to={`/tasks/${t.taskId}`}>{t.displayName ?? '历史任务'}</Link><span className="muted">{t.accepted ? '已提交' : t.requestKey ? '提交待核对' : '历史索引'} · {new Date(t.createdAt).toLocaleString()}</span></div>)}
      {tasks.data?.data.items.length === 0 && <p>暂无任务</p>}
      {cursor && <button onClick={() => setCursor(undefined)}>回到首页</button>}
      {tasks.data?.data.nextCursor && <button onClick={() => setCursor(tasks.data!.data.nextCursor!)}>下一页</button>}
    </Card></div>;
}
