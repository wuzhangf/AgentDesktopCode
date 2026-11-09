// PAE P6 — 项目列表与登记（任务单 §9.1）。
// 只提交已登记的 projectRef + 显示名/备注；不接受任意 URL、宿主路径或 shell。
// 服务端未声明 REGISTER_PROJECT 时表单不显示（未声明即不支持）。
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowUpRight, RefreshCw } from 'lucide-react';
import { PERSONAL_ID_PATTERN } from '../../../../codeagent-desktop/packages/protocol/src/personal';
import { Badge, Card, EmptyState, ErrorBanner, Skeleton } from '../../components/ui/primitives';
import { usePersonal, usePersonalGateway, usePersonalSurface } from '../hooks';
import { canWrite, fmtIso } from '../viewmodel';
import { PersonalClientError } from '../client';

export default function ProjectsPage() {
  const nav = useNavigate();
  const surface = usePersonalSurface();
  const gateway = usePersonalGateway();
  const qc = useQueryClient();
  const projects = usePersonal(['projects'], g => g.listProjects());
  const available = usePersonal(['availableProjects'], g => g.availableProjects());
  const meta = projects.data?.meta;
  const canRegister = canWrite(meta, 'REGISTER_PROJECT', surface.readonly);

  const [form, setForm] = useState({ projectRef: '', displayName: '', notes: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState('');

  const refValid = PERSONAL_ID_PATTERN.test(form.projectRef);
  const register = async () => {
    if (busy || !refValid) return;
    setBusy(true); setError(''); setDone('');
    try {
      const res = await gateway.registerProject({
        projectRef: form.projectRef,
        displayName: form.displayName || undefined,
        notes: form.notes || undefined,
      });
      setDone(`已登记 ${res.data.displayName ?? res.data.projectRef}（${res.data.projectId}）`);
      setForm({ projectRef: '', displayName: '', notes: '' });
      await qc.invalidateQueries({ queryKey: ['personal'] });
    } catch (e) {
      const err = e as PersonalClientError;
      setError(err.code?.includes('CONFLICT') ? '数据已被更新，正在刷新——请按最新列表决定。' : err.message || '登记未确认');
      await projects.refetch();
    } finally { setBusy(false); }
  };

  if (projects.isPending) return <Skeleton h={200} />;
  if (projects.isError) return <ErrorBanner error={projects.error} onRetry={() => projects.refetch()} />;

  return (
    <div className="col" style={{ gap: 16 }}>
      <div className="row">
        <h1 className="page-title">项目</h1>
        <span className="muted" style={{ fontSize: 12 }}>已登记的项目引用；登记不复制源码、不上传凭据</span>
        <button className="ghost right" onClick={() => void projects.refetch()} aria-label="刷新"><RefreshCw size={14} /></button>
      </div>

      {canRegister && (
        <Card title="登记项目" sub="从 ACS 项目目录按名称选择；本机源码位置由安装侧管理">
          <div className="row wrap" style={{ gap: 12, alignItems: 'end' }}>
            <label className="col" style={{ gap: 4, fontSize: 12 }}>
              <span className="muted">项目</span>
              <select aria-label="项目" value={form.projectRef} onChange={e => setForm(f => ({...f, projectRef:e.target.value}))}>
                <option value="">选择 ACS 已有项目</option>
                {available.data?.data.map(p => <option key={p.projectId} value={p.projectId}>{p.displayName ?? p.workspaceAlias}</option>)}
              </select>
            </label>
            <label className="col" style={{ gap: 4, fontSize: 12 }}>
              <span className="muted">显示名（可选）</span>
              <input value={form.displayName} style={{ width: 200 }} maxLength={256}
                onChange={e => setForm(f => ({ ...f, displayName: e.target.value }))} />
            </label>
            <label className="col" style={{ gap: 4, fontSize: 12 }}>
              <span className="muted">备注（可选）</span>
              <input value={form.notes} style={{ width: 260 }} maxLength={4096}
                onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} />
            </label>
            <button className="primary" disabled={busy || !refValid} onClick={() => void register()}>登记</button>
          </div>
          {form.projectRef && !refValid && (
            <p className="muted" style={{ fontSize: 11.5 }}>项目引用需满足登记 ID 格式（字母数字开头，可含 . _ -，≤128 字符）。</p>
          )}
          {error && <p role="alert" style={{ color: 'var(--failure)', fontSize: 12 }}>{error}</p>}
          {done && <p role="status" style={{ color: 'var(--success)', fontSize: 12 }}>{done}</p>}
          <p className="muted" style={{ fontSize: 11.5, margin: '6px 0 0' }}>
            选择 ACS 已有项目，系统自动保存引用。任务页也可直接选择并启动。
          </p>
        </Card>
      )}
      {!canRegister && !surface.readonly && (
        <Card title="登记项目"><p className="muted" style={{ fontSize: 12 }}>
          当前管理服务未声明项目登记操作——未声明即不支持，登记入口不显示。
        </p></Card>
      )}

      <Card title="已登记" sub="进入项目查看运行环境与识别结果">
        {(projects.data?.data ?? []).length === 0 ? (
          <EmptyState title="暂无项目" hint="登记项目后即可查看运行环境识别结果" />
        ) : (
          <div className="col" style={{ gap: 8 }}>
            {(projects.data?.data ?? []).map(p => (
              <button key={p.projectId} className="card raised row" style={{ textAlign: 'left', gap: 10 }}
                onClick={() => nav(`/projects/${p.projectId}`)}>
                <div className="grow">
                  <div style={{ fontSize: 13 }}>{p.displayName ?? p.projectRef}</div>
                  <div className="muted" style={{ fontSize: 11 }}>
                    {p.projectRef} · 修订 {p.revision ?? '—'} · 更新于 {fmtIso(p.updatedAt)}
                  </div>
                </div>
                <Badge tone="plain">{p.projectId}</Badge>
                <ArrowUpRight size={14} className="muted" />
              </button>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
