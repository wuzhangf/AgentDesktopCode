// PAE P6 — 项目详情 → 运行环境（设计 §11.2「环境集中在项目详情→运行环境」）。
// 页头为登记信息；主体是 EnvironmentPanel（需要/已有/缺少、版本选择、
// 一键准备、进度、原操作恢复、错误建议、自定义镜像高级入口）。
import { useParams } from 'react-router-dom';
import { Badge, Card, ErrorBanner, KV, Skeleton } from '../../components/ui/primitives';
import { usePersonal } from '../hooks';
import { fmtIso } from '../viewmodel';
import { operationStateLabel, operationStateTone } from '../labels';
import { EnvironmentPanel } from '../components/EnvironmentPanel';

export default function ProjectEnvironmentPage() {
  const { projectId = '' } = useParams();
  const project = usePersonal(['project', projectId], g => g.getProject(projectId), { enabled: !!projectId });
  const env = usePersonal(['projectEnvironment', projectId], g => g.getProjectEnvironment(projectId), { enabled: !!projectId });

  const p = project.data?.data;
  const envView = env.data?.data;

  return (
    <div className="col" style={{ gap: 16 }}>
      <div className="row">
        <h1 className="page-title">{p?.displayName ?? p?.projectRef ?? projectId}</h1>
        {envView?.state && <Badge tone={operationStateTone(envView.state)}>{operationStateLabel(envView.state)}</Badge>}
      </div>
      {project.isError && <ErrorBanner error={project.error} onRetry={() => project.refetch()} />}
      {p && (
        <Card title="登记信息">
          <KV items={[
            ['projectRef', <span className="mono" key="r">{p.projectRef}</span>],
            ['projectId', <span className="mono" key="i">{p.projectId}</span>],
            ['修订', p.revision ?? '—'],
            ['登记于', fmtIso(p.registeredAt)],
            ['更新于', fmtIso(p.updatedAt)],
          ]} />
        </Card>
      )}
      {project.isPending && <Skeleton h={90} />}
      <EnvironmentPanel projectId={projectId} />
    </div>
  );
}
