// PAE P6 — 我的 Workers（任务单 §9.7）。
// 连接方式与联合能力视图；外部 Worker（ACS_DIRECT）与本人受管实例
// （DAEMON/CORE_LOCAL）的维护动作明确区分：外部连接仅观察与已授权动作，
// 不提供停止宿主/改镜像/重启按钮——这些动作也不在本通道冻结路由中，
// 不伪造入口（§11.3）。环境失败不把 Worker 整体标死。
import { useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { Badge, Card, EmptyState, ErrorBanner, KV, Skeleton } from '../../components/ui/primitives';
import { Drawer } from '../../components/ui/Drawer';
import { usePersonal } from '../hooks';
import { fmtIso } from '../viewmodel';
import { CAPABILITY_LABEL, connectionKindLabel, reasonAdvice, reasonLabel } from '../labels';
import type { PersonalWorkerView } from '../../../../codeagent-desktop/packages/protocol/src/personal';

const JOINT_CAPS = ['projectEnvironmentPrepareV1', 'environmentBoundExecutionV1', 'adaptiveActionV1'] as const;

function managedBadge(w: PersonalWorkerView) {
  return w.connectionKind === 'ACS_DIRECT'
    ? <Badge tone="plain">外部连接 · 仅观察与已授权动作</Badge>
    : <Badge tone="info">本人受管实例</Badge>;
}

export default function WorkersPage() {
  const workers = usePersonal(['workers'], g => g.listWorkers(), { refetchInterval: 15_000 });
  const [detailId, setDetailId] = useState<string | null>(null);
  const detail = usePersonal(['worker', detailId ?? ''], g => g.getWorker(detailId!), { enabled: !!detailId });

  if (workers.isPending) return <Skeleton h={200} />;
  if (workers.isError) return <ErrorBanner error={workers.error} onRetry={() => workers.refetch()} />;
  const rows = workers.data?.data ?? [];

  return (
    <div className="col" style={{ gap: 16 }}>
      <div className="row">
        <h1 className="page-title">我的 Workers</h1>
        <span className="muted" style={{ fontSize: 12 }}>连接、核心可用性、可提供的环境能力、Operator 状态</span>
        <button className="ghost right" onClick={() => void workers.refetch()} aria-label="刷新"><RefreshCw size={14} /></button>
      </div>

      <Card title="已连接" sub="点击行查看详情；环境失败只影响对应项目，不会把整个 Worker 标死">
        {rows.length === 0 ? (
          <EmptyState title="未连接 Worker" hint="在 Worker 端启动 daemon 或直连服务后经管理服务登记" />
        ) : (
          <div className="col" style={{ gap: 8 }}>
            {rows.map(w => (
              <button key={w.workerId} className="card raised" style={{ textAlign: 'left' }}
                onClick={() => setDetailId(w.workerId)}>
                <div className="row wrap" style={{ gap: 8 }}>
                  <b style={{ fontSize: 13 }}>{w.displayName ?? w.workerId}</b>
                  {managedBadge(w)}
                  <Badge tone="plain">{connectionKindLabel(w.connectionKind)}</Badge>
                  {w.connectionState && <Badge tone={w.connectionState === 'CONNECTED' ? 'success' : 'unknown'}>{w.connectionState}</Badge>}
                  <span className="muted right" style={{ fontSize: 11 }}>观测于 {fmtIso(w.observedAt)}</span>
                </div>
                <div className="row wrap" style={{ gap: 4, marginTop: 6 }}>
                  {JOINT_CAPS.map(cap => (
                    <Badge key={cap} tone={w.capabilities?.[cap] === true ? 'success' : 'unknown'}
                      title={cap}>{CAPABILITY_LABEL[cap]}{w.capabilities?.[cap] === true ? '' : ' OFF'}</Badge>
                  ))}
                  {w.supportedCores?.map(c => <Badge key={c} tone="info">{c}</Badge>)}
                  {w.operatorState && <Badge tone={w.operatorState === 'READY' ? 'success' : 'unknown'}>Operator {w.operatorState}</Badge>}
                </div>
              </button>
            ))}
          </div>
        )}
      </Card>

      <Drawer open={!!detailId} onClose={() => setDetailId(null)} title="Worker 详情">
        {detail.isPending && <Skeleton h={160} />}
        {detail.isError && <ErrorBanner error={detail.error} onRetry={() => detail.refetch()} />}
        {detail.data && (
          <div className="col" style={{ gap: 14 }}>
            <div className="row wrap" style={{ gap: 6 }}>
              {managedBadge(detail.data.data)}
              {detail.data.data.connectionState && <Badge tone="plain">{detail.data.data.connectionState}</Badge>}
            </div>
            <KV items={[
              ['workerId', <span className="mono" key="w">{detail.data.data.workerId}</span>],
              ['连接方式', connectionKindLabel(detail.data.data.connectionKind)],
              ['版本', detail.data.data.version ?? '—'],
              ['平台', detail.data.data.platform ?? '—'],
              ['Operator', detail.data.data.operatorState ?? '—'],
              ['支持核心', detail.data.data.supportedCores?.join('、') || '—'],
              ['修订', detail.data.data.revision ?? '—'],
              ['观测于', fmtIso(detail.data.data.observedAt)],
            ]} />
            <div className="col" style={{ gap: 4 }}>
              <div className="card-sub">联合能力（安装侧通道 + 真实绑定消费 + 实测就绪齐备才广告）</div>
              <div className="row wrap" style={{ gap: 4 }}>
                {JOINT_CAPS.map(cap => (
                  <Badge key={cap} tone={detail.data.data.capabilities?.[cap] === true ? 'success' : 'unknown'} title={cap}>
                    {CAPABILITY_LABEL[cap]}{detail.data.data.capabilities?.[cap] === true ? '' : ' OFF'}
                  </Badge>
                ))}
              </div>
            </div>
            {detail.data.data.reasonCodes?.length ? (
              <div className="col" style={{ gap: 4 }}>
                <div className="card-sub">当前阻断原因</div>
                {detail.data.data.reasonCodes.map(code => (
                  <div key={code} style={{ fontSize: 12 }}><b>{reasonLabel(code)}</b>：{reasonAdvice(code)}</div>
                ))}
              </div>
            ) : null}
            <p className="muted" style={{ fontSize: 11.5, margin: 0 }}>
              {detail.data.data.connectionKind === 'ACS_DIRECT'
                ? '外部连接：可观察与执行被授予的动作；加入列表不获得停止宿主、改镜像或重启权限。'
                : '本人受管实例：停止接单、取消任务、停止 Worker、清理环境是不同动作，经 Worker 自身受管通道执行，本页不伪造入口。'}
            </p>
          </div>
        )}
      </Drawer>
    </div>
  );
}
