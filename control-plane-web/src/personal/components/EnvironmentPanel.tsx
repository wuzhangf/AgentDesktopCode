// PAE P6 — 项目运行环境面板（任务单 §9.2）。
// 需要/已有/缺少三视图、版本选择、一键准备、进度、原操作恢复、错误建议、
// 自定义镜像高级入口；资源与下载未知显示「未知」，不虚构耗时或占用。
// 写按钮一律经过 canWrite(meta, action, readonly) 门禁——supportedActions
// 未声明即不支持；inspect/GET 均为只读，不触发安装/拉镜像/探活。
import { useEffect, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { AlertCircle, RefreshCw } from 'lucide-react';
import { Badge, Card, EmptyState, ErrorBanner, KV, Skeleton } from '../../components/ui/primitives';
import { usePersonal, usePersonalGateway, usePersonalSurface } from '../hooks';
import {
  boundedOrUndef, canWrite, decimalRevision, fmtBytesOrUnknown, fmtIso,
  readPendingOperation, writePendingOperation, clearPendingOperation,
} from '../viewmodel';
import { reasonAdvice, reasonLabel } from '../labels';
import { OperationView } from './OperationView';
import { PersonalClientError } from '../client';
import type {
  EnvironmentBackendPreference,
  PersonalEnvironmentPlanPreview,
  PersonalEnvelope,
  PersonalToolchainSelection,
} from '../../../../codeagent-desktop/packages/protocol/src/personal';

const BACKEND_LABEL: Record<EnvironmentBackendPreference, string> = {
  ANY: '自动（按项目与 Worker 能力）',
  HOST: '本机宿主',
  OCI_DOCKER: 'Docker 容器',
  OCI_PODMAN: 'Podman 容器',
};

function conflictAware(e: unknown, refetch: () => void): string {
  const err = e as PersonalClientError;
  if (err.code?.includes('CONFLICT')) {
    void refetch();
    return '数据已被更新，正在刷新视图——请按最新状态再决定。';
  }
  return err.message || '操作未确认，请读取原回执';
}

export function EnvironmentPanel({ projectId }: { projectId: string }) {
  const surface = usePersonalSurface();
  const gateway = usePersonalGateway();
  const qc = useQueryClient();
  const env = usePersonal(['projectEnvironment', projectId], g => g.getProjectEnvironment(projectId));
  const view = env.data?.data;
  const meta = env.data?.meta;

  const [pending, setPending] = useState(() => readPendingOperation(projectId));
  const [backend, setBackend] = useState<EnvironmentBackendPreference>('ANY');
  const [versions, setVersions] = useState<Record<string, string>>({});
  const [preview, setPreview] = useState<PersonalEnvelope<PersonalEnvironmentPlanPreview> | null>(null);
  const [previewFor, setPreviewFor] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => { setPending(readPendingOperation(projectId)); setPreview(null); }, [projectId]);

  const canPlan = canWrite(meta, 'ENVIRONMENT_PLAN', surface.readonly);
  const canOperate = canWrite(meta, 'ENVIRONMENT_OPERATION', surface.readonly);

  const selections: PersonalToolchainSelection[] = useMemo(() => {
    const out: PersonalToolchainSelection[] = [];
    for (const req of view?.needs ?? []) {
      const version = (versions[req.name] ?? req.version ?? '').trim();
      const tool = boundedOrUndef(req.name, 128);
      if (version && tool && version.length <= 128) {
        out.push({ tool, version, source: boundedOrUndef(req.source, 64) });
      }
    }
    return out;
  }, [view?.needs, versions]);

  const work = async (fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(true); setError('');
    try { await fn(); } catch (e) { setError(conflictAware(e, () => void env.refetch())); }
    finally { setBusy(false); }
  };

  const doPlan = () => work(async () => {
    const res = await gateway.previewEnvironmentPlan(projectId, {
      preferredBackend: backend,
      toolchainSelections: selections.length ? selections : undefined,
      expectedRevision: decimalRevision(view?.environmentRevision),
    });
    setPreview(res);
    setPreviewFor(projectId);
  });

  const doPrepare = () => work(async () => {
    const planDigest = previewFor === projectId ? preview?.data.planDigest ?? undefined : view?.planDigest ?? undefined;
    const requestKey = crypto.randomUUID();
    const res = await gateway.startEnvironmentOperation(projectId, {
      requestKey,
      kind: 'PREPARE',
      planDigest,
      environmentId: view?.environmentId ?? undefined,
      expectedRevision: decimalRevision(view?.environmentRevision),
      environmentRevision: decimalRevision(view?.environmentRevision),
    });
    const record = { operationId: res.data.operationId, requestKey, submittedAt: new Date().toISOString() };
    writePendingOperation(projectId, record);
    setPending(record);
    await qc.invalidateQueries({ queryKey: ['personal'] });
  });

  if (env.isPending) return <Skeleton h={220} />;
  if (env.isError) return <ErrorBanner error={env.error} onRetry={() => env.refetch()} />;
  if (!view) return null;

  const activeOperationId = view.activeOperationId ?? pending?.operationId ?? null;
  const missing = view.missing ?? [];

  return (
    <div className="col" style={{ gap: 16 }}>
      {meta?.reasonCodes?.length ? (
        <div className="banner" role="status">
          <AlertCircle size={15} aria-hidden />
          <div className="grow">
            {meta.reasonCodes.map(code => (
              <div key={code}><b>{reasonLabel(code)}</b>：{reasonAdvice(code)}</div>
            ))}
          </div>
        </div>
      ) : null}
      {view.warnings?.length ? (
        <div className="muted" style={{ fontSize: 12 }}>
          {view.warnings.map(w => <div key={w}>⚠ {w}</div>)}
        </div>
      ) : null}

      <div className="grid cols-12">
        <Card span={4} title="需要" sub="项目来源声明的要求（inspect 只读识别）">
          {view.needs.length === 0 ? <EmptyState title="暂无已识别要求" /> : (
            <div className="col" style={{ gap: 8 }}>
              {view.needs.map(r => (
                <div key={r.requirementId ?? `${r.kind}-${r.name}`} className="card raised" style={{ padding: '8px 10px' }}>
                  <div className="row"><b style={{ fontSize: 12.5 }}>{r.name}</b>
                    <Badge tone="plain">{r.kind}</Badge>
                    {r.version && <span className="muted" style={{ fontSize: 11.5 }}>{r.version}</span>}</div>
                  {r.detail && <div className="muted" style={{ fontSize: 11.5, marginTop: 2 }}>{r.detail}</div>}
                  {r.source && <div className="muted" style={{ fontSize: 11 }}>来源：{r.source}</div>}
                </div>
              ))}
            </div>
          )}
        </Card>
        <Card span={4} title="已有" sub="实测就绪事实（readinessFacts）">
          {view.have.length === 0 ? <EmptyState title="暂无可证实事实" hint="未实测的不显示为已有" /> : (
            <div className="col" style={{ gap: 8 }}>
              {view.have.map(f => (
                <div key={f.factId ?? `${f.kind}-${f.name}`} className="card raised" style={{ padding: '8px 10px' }}>
                  <div className="row"><b style={{ fontSize: 12.5 }}>{f.name ?? f.kind}</b>
                    <Badge tone="success">{f.kind}</Badge>
                    {f.version && <span className="muted" style={{ fontSize: 11.5 }}>{f.version}</span>}</div>
                  {f.observedAt && <div className="muted" style={{ fontSize: 11 }}>观测于 {fmtIso(f.observedAt)}</div>}
                </div>
              ))}
            </div>
          )}
        </Card>
        <Card span={4} title="缺少" sub="阻断项直达建议">
          {missing.length === 0 ? <EmptyState title="无缺少项" /> : (
            <div className="col" style={{ gap: 8 }}>
              {missing.map(r => (
                <div key={r.requirementId ?? `${r.kind}-${r.name}`} className="card raised" style={{ padding: '8px 10px' }}>
                  <div className="row"><b style={{ fontSize: 12.5 }}>{r.name}</b>
                    <Badge tone="failure">缺少</Badge>
                    {r.version && <span className="muted" style={{ fontSize: 11.5 }}>{r.version}</span>}</div>
                  {r.detail && <div className="muted" style={{ fontSize: 11.5, marginTop: 2 }}>{r.detail}</div>}
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>

      <Card title="准备环境" sub="选择后端与版本 → 生成计划预览（不安装）→ 一键准备（幂等 requestKey）"
        right={<button className="ghost" onClick={() => void env.refetch()} aria-label="重新查询"><RefreshCw size={14} /></button>}>
        <div className="row wrap" style={{ gap: 12, alignItems: 'end' }}>
          <label className="col" style={{ gap: 4, fontSize: 12 }}>
            <span className="muted">执行后端</span>
            <select value={backend} onChange={e => setBackend(e.target.value as EnvironmentBackendPreference)}>
              {Object.entries(BACKEND_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </label>
          {view.needs.filter(r => r.kind === 'TOOL' || r.kind === 'TOOLCHAIN' || r.version != null).map(r => (
            <label key={r.requirementId ?? r.name} className="col" style={{ gap: 4, fontSize: 12 }}>
              <span className="muted">{r.name} 版本</span>
              <input value={versions[r.name] ?? r.version ?? ''} placeholder={r.version ?? '未知'} maxLength={128}
                onChange={e => setVersions(v => ({ ...v, [r.name]: e.target.value }))}
                style={{ width: 140 }} aria-label={`${r.name} 版本`} />
            </label>
          ))}
        </div>
        {view.supportedCores?.length ? (
          <div className="row wrap" style={{ marginTop: 8, gap: 6 }}>
            <span className="muted" style={{ fontSize: 11.5 }}>支持核心：</span>
            {view.supportedCores.map(c => <Badge key={c} tone="info">{c}</Badge>)}
          </div>
        ) : null}
        <div className="row" style={{ marginTop: 12, gap: 8 }}>
          {canPlan && <button disabled={busy} onClick={() => void doPlan()}>生成计划预览</button>}
          {canOperate && (
            <button className="primary"
              disabled={busy || view.state === 'READY' || view.state === 'QUEUED' || view.state === 'RUNNING'}
              onClick={() => void doPrepare()}>
              {view.state === 'READY' ? '环境已就绪'
                : view.state === 'QUEUED' || view.state === 'RUNNING' ? '准备进行中'
                : '一键准备'}
            </button>
          )}
          {!canPlan && !canOperate && !surface.readonly && (
            <span className="muted" style={{ fontSize: 11.5 }}>管理服务未声明环境写操作——未声明即不支持，本页只读</span>
          )}
          {surface.readonly && <span className="muted" style={{ fontSize: 11.5 }}>只读视图——不提供可执行按钮</span>}
        </div>
        {error && <p role="alert" style={{ color: 'var(--failure)', fontSize: 12 }}>{error}</p>}
        {preview && previewFor === projectId && (
          <div className="card raised" style={{ marginTop: 12, padding: '10px 12px' }}>
            <div className="row" style={{ marginBottom: 6 }}>
              <b style={{ fontSize: 12.5 }}>计划预览</b>
              <span className="mono muted" style={{ fontSize: 11 }}>{preview.data.planId ?? ''}</span>
              <span className="muted right" style={{ fontSize: 11 }}>过期 {fmtIso(preview.data.expiresAt)}</span>
            </div>
            <div className="col" style={{ gap: 6 }}>
              {(preview.data.steps ?? []).map(s => (
                <div key={s.stepId} className="row" style={{ gap: 8 }}>
                  <Badge tone="plain">{s.kind ?? '步骤'}</Badge>
                  <span style={{ fontSize: 12 }}>{s.summary ?? s.ref}</span>
                </div>
              ))}
            </div>
            <KV items={[
              ['预计下载', fmtBytesOrUnknown(preview.data.estimatedDownloadBytes)],
              ['预计磁盘', fmtBytesOrUnknown(preview.data.estimatedDiskBytes)],
              ['planDigest', <span className="mono" key="d">{preview.data.planDigest ?? '—'}</span>],
            ]} />
            {(preview.data.missing?.length || preview.data.warnings?.length) ? (
              <div className="muted" style={{ fontSize: 11.5, marginTop: 6 }}>
                {preview.data.warnings?.map(w => <div key={w}>⚠ {w}</div>)}
                {preview.data.missing?.map(m => <div key={m.requirementId ?? m.name}>缺少：{m.name} {m.version ?? ''}</div>)}
              </div>
            ) : null}
            <div className="muted" style={{ fontSize: 11, marginTop: 6 }}>预览不产生安装、不预留资源。</div>
          </div>
        )}
        <details style={{ marginTop: 12 }}>
          <summary className="muted" style={{ fontSize: 12, cursor: 'pointer' }}>高级：自定义镜像与操作恢复</summary>
          <div className="col" style={{ gap: 6, marginTop: 8 }}>
            <KV items={[
              ['environmentId', <span className="mono" key="e">{view.environmentId ?? '—'}</span>],
              ['environmentRevision', view.environmentRevision ?? '—'],
              ['planDigest', <span className="mono" key="p">{view.planDigest ?? '—'}</span>],
              ['imageDigest', <span className="mono" key="i">{view.imageDigest ?? '—'}</span>],
              ['activeOperationId', <span className="mono" key="a">{view.activeOperationId ?? '—'}</span>],
              ['观测于', fmtIso(view.observedAt)],
            ]} />
            <p className="muted" style={{ fontSize: 11.5, margin: '4px 0 0' }}>
              自定义镜像由安装侧（Operator / agentctl）构建并验证摘要后经本通道登记；
              本界面不接收任意镜像地址、宿主路径或 shell。离线环境在 Worker 所在主机
              导入固定摘要镜像后，回到本页重新查询即可续接原任务。
            </p>
          </div>
        </details>
      </Card>

      {activeOperationId && <OperationView operationId={activeOperationId} />}
      {pending && pending.operationId !== view.activeOperationId && (
        <div className="row" style={{ gap: 8 }}>
          <span className="muted" style={{ fontSize: 11.5 }}>
            本机登记的原操作：<span className="mono">{pending.operationId}</span>（{fmtIso(pending.submittedAt)} 提交）
          </span>
          <button className="ghost" onClick={() => { clearPendingOperation(projectId); setPending(null); }}>清除本机登记</button>
        </div>
      )}
    </div>
  );
}
