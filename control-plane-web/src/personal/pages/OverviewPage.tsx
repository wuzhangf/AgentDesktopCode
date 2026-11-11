// PAE P6 — 总览/待处理（任务单 §9.5）。
// 合并同一根因重复提醒；环境阻断 / 提问 / UNKNOWN 操作直达原对象；
// 待办项显示真实来源与观测时间，不用模型总结替代事实。
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AlertCircle, ArrowUpRight, RefreshCw } from 'lucide-react';
import { Badge, Card, EmptyState, ErrorBanner, Skeleton } from '../../components/ui/primitives';
import { Drawer } from '../../components/ui/Drawer';
import { usePersonal } from '../hooks';
import { attentionTarget, fmtIso, listPendingOperations, mergeAttention } from '../viewmodel';
import { connectionKindLabel, reasonLabel, reasonAdvice } from '../labels';
import { OperationView } from '../components/OperationView';

export default function OverviewPage() {
  const nav = useNavigate();
  const overview = usePersonal(['overview'], g => g.overview(), { refetchInterval: 15_000 });
  const [opInDrawer, setOpInDrawer] = useState<string | null>(null);
  const pendingOps = listPendingOperations();

  if (overview.isPending) return <div className="col"><Skeleton h={110} /><Skeleton h={260} /></div>;
  if (overview.isError) return <ErrorBanner error={overview.error} onRetry={() => overview.refetch()} />;
  const data = overview.data?.data;
  const meta = overview.data?.meta;
  const merged = mergeAttention(data?.attention);

  const openTarget = (item: ReturnType<typeof mergeAttention>[number]) => {
    const target = attentionTarget(item);
    if (target.type === 'operation') setOpInDrawer(target.operationId);
    else if (target.type === 'task') nav(`/tasks/${target.taskId}`);
    else if (target.type === 'project') nav(`/projects/${target.projectId}`);
  };

  return (
    <div className="col" style={{ gap: 16 }}>
      <div className="row">
        <h1 className="page-title">总览</h1>
        <span className="muted" style={{ fontSize: 12 }}>
          {meta ? `来源 ${meta.source} · 实例 ${meta.instance} · 观测于 ${fmtIso(meta.observedAt)}` : ''}
        </span>
        <button className="ghost right" onClick={() => void overview.refetch()} aria-label="刷新"><RefreshCw size={14} /></button>
      </div>

      <div className="row wrap" style={{ gap: 10 }}>
        <button className="card raised" style={{ textAlign: 'left', minWidth: 160 }} onClick={() => nav('/projects')}>
          <div className="muted" style={{ fontSize: 11.5 }}>已登记项目</div>
          <div style={{ fontSize: 22, fontWeight: 650 }}>{data?.projects?.length ?? '—'}</div>
        </button>
        <button className="card raised" style={{ textAlign: 'left', minWidth: 160 }} onClick={() => nav('/workers')}>
          <div className="muted" style={{ fontSize: 11.5 }}>Workers</div>
          <div style={{ fontSize: 22, fontWeight: 650 }}>{data?.workers?.length ?? '—'}</div>
        </button>
        <div className="card raised" style={{ textAlign: 'left', minWidth: 160 }}>
          <div className="muted" style={{ fontSize: 11.5 }}>待处理</div>
          <div style={{ fontSize: 22, fontWeight: 650 }}>{merged.length}</div>
        </div>
      </div>

      <Card title="待处理" sub="同根因重复提醒已合并；点击直达原对象">
        {merged.length === 0 ? (
          <EmptyState title="暂无待处理事项" hint="环境阻断、待回答问题与待核对操作会出现在这里" />
        ) : (
          <div className="col" style={{ gap: 8 }}>
            {merged.map(item => {
              const target = attentionTarget(item);
              return (
                <button key={`${item.kind}|${item.reasonCode ?? ''}|${item.operationId ?? item.refId ?? item.projectId ?? ''}`}
                  className="card raised row" style={{ textAlign: 'left', gap: 10 }}
                  onClick={() => openTarget(item)} disabled={target.type === 'none'}>
                  <AlertCircle size={15} color={item.reasonCode ? 'var(--warning)' : 'var(--accent)'} />
                  <div className="grow">
                    <div style={{ fontSize: 12.5 }}>
                      {item.message}
                      {item.count > 1 && <span className="muted">（{item.count} 条同根因）</span>}
                    </div>
                    <div className="muted" style={{ fontSize: 11 }}>
                      {item.reasonCode ? `${reasonLabel(item.reasonCode)} · ${reasonAdvice(item.reasonCode)} ` : ''}
                      {item.observedAt ? `观测于 ${fmtIso(item.observedAt)}` : ''}
                    </div>
                  </div>
                  {target.type !== 'none' && <ArrowUpRight size={14} className="muted" />}
                </button>
              );
            })}
          </div>
        )}
      </Card>

      {pendingOps.length > 0 && (
        <Card title="本机登记的原操作" sub="刷新/重启后按原 requestKey 恢复查询；清除登记不影响服务端操作">
          <div className="col" style={{ gap: 8 }}>
            {pendingOps.map(p => (
              <div key={p.operationId} className="row card raised" style={{ padding: '8px 10px' }}>
                <span className="mono" style={{ fontSize: 11.5 }}>{p.operationId}</span>
                <span className="muted" style={{ fontSize: 11.5 }}>项目 {p.projectId} · 提交于 {fmtIso(p.submittedAt)}</span>
                <button className="ghost right" onClick={() => nav(`/projects/${p.projectId}`)}>到项目页恢复 <ArrowUpRight size={13} /></button>
                <button className="ghost" onClick={() => setOpInDrawer(p.operationId)}>就地核对</button>
              </div>
            ))}
          </div>
        </Card>
      )}

      <Card title="Workers 摘要" sub="连接方式与联合能力（缺件报 OFF）">
        {(data?.workers?.length ?? 0) === 0 ? <EmptyState title="未连接 Worker" /> : (
          <div className="row wrap" style={{ gap: 8 }}>
            {(data?.workers ?? []).map(w => (
              <button key={w.workerId} className="card raised" style={{ textAlign: 'left' }} onClick={() => nav('/workers')}>
                <div className="row" style={{ gap: 6 }}>
                  <b style={{ fontSize: 12.5 }}>{w.displayName ?? w.workerId}</b>
                  <Badge tone={w.connectionKind === 'ACS_DIRECT' ? 'plain' : 'info'}>
                    {w.connectionKind === 'ACS_DIRECT' ? '外部连接' : '本人受管'} · {connectionKindLabel(w.connectionKind)}
                  </Badge>
                </div>
                <div className="row" style={{ gap: 4, marginTop: 6 }}>
                  {(['projectEnvironmentPrepareV1', 'environmentBoundExecutionV1', 'adaptiveActionV1'] as const).map(cap => (
                    <Badge key={cap} tone={w.capabilities?.[cap] === true ? 'success' : 'unknown'} title={cap}>
                      {cap.replace('V1', '')}{w.capabilities?.[cap] === true ? '' : ' OFF'}
                    </Badge>
                  ))}
                </div>
              </button>
            ))}
          </div>
        )}
      </Card>

      <Drawer open={!!opInDrawer} onClose={() => setOpInDrawer(null)} title="原操作核对">
        {opInDrawer && <OperationView operationId={opInDrawer} />}
      </Drawer>
    </div>
  );
}
