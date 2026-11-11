// PAE P6 — 报告（任务单 §9.7：报告服务独立连接状态）。
// 列表 = ReportDescriptor 真实状态；详情展示真实结果文件（名称/大小/digest），
// 不用模型总结替代事实（§9.5）。新建报告只提交已登记 sourceRef 与用户
// 明确选择的数据范围；环境准备不会自动上传项目（设计 §12）。
// 订阅/周期调度未启用时显示未启用，不伪装后台已持续生成。
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowUpRight, FileText, RefreshCw } from 'lucide-react';
import { PERSONAL_DIGEST_PATTERN } from '../../../../codeagent-desktop/packages/protocol/src/personal';
import { Badge, Card, EmptyState, ErrorBanner, KV, Skeleton } from '../../components/ui/primitives';
import { Drawer } from '../../components/ui/Drawer';
import { usePersonal, usePersonalGateway, usePersonalSurface } from '../hooks';
import { canWrite, fmtBytesOrUnknown, fmtIso } from '../viewmodel';
import { PersonalClientError } from '../client';

const REPORT_STATE_LABEL: Record<string, string> = {
  QUEUED: '排队中', RUNNING: '生成中', DONE: '已完成', FAILED: '失败', CANCELED: '已取消',
};
function reportTone(state: string | undefined): string {
  return state === 'DONE' ? 'success' : state === 'FAILED' ? 'failure' : state === 'QUEUED' || state === 'RUNNING' ? 'info' : 'unknown';
}

export default function ReportsPage() {
  const surface = usePersonalSurface();
  const gateway = usePersonalGateway();
  const qc = useQueryClient();
  const reports = usePersonal(['reports'], g => g.listReports(), { refetchInterval: 15_000 });
  const meta = reports.data?.meta;
  const canCreate = canWrite(meta, 'REPORT_CREATE', surface.readonly);

  const [detailId, setDetailId] = useState<string | null>(null);
  const detail = usePersonal(['report', detailId ?? ''], g => g.getReport(detailId!), { enabled: !!detailId });
  const files = usePersonal(['reportFiles', detailId ?? ''], g => g.listReportFiles(detailId!), { enabled: !!detailId });

  const [form, setForm] = useState({ sourceRef: '', sourceVersion: '', sourceDigest: '', reportProfileRef: '', providerRef: '', outputFormat: 'markdown', dataScope: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState('');

  const digestInvalid = !!form.sourceDigest && !PERSONAL_DIGEST_PATTERN.test(form.sourceDigest);
  const create = async () => {
    if (busy || !form.sourceRef || digestInvalid) return;
    setBusy(true); setError(''); setDone('');
    try {
      const scope = form.dataScope.split(',').map(s => s.trim())
        .filter(s => s.length > 0 && s.length <= 256).slice(0, 64);
      const res = await gateway.createReport({
        sourceRef: form.sourceRef,
        sourceVersion: form.sourceVersion || undefined,
        sourceDigest: form.sourceDigest || undefined,
        reportProfileRef: form.reportProfileRef || undefined,
        providerRef: form.providerRef || undefined,
        outputFormat: form.outputFormat || undefined,
        dataScope: scope.length ? scope : undefined,
      });
      setDone(`已受理（${res.data.reportId}）`);
      setForm(f => ({ ...f, sourceRef: '', sourceVersion: '', sourceDigest: '', dataScope: '' }));
      await qc.invalidateQueries({ queryKey: ['personal', 'reports'] });
    } catch (e) {
      const err = e as PersonalClientError;
      setError(err.message || '报告请求未确认');
      await reports.refetch();
    } finally { setBusy(false); }
  };

  if (reports.isPending) return <Skeleton h={200} />;
  if (reports.isError) return <ErrorBanner error={reports.error} onRetry={() => reports.refetch()} />;
  const rows = reports.data?.data ?? [];

  return (
    <div className="col" style={{ gap: 16 }}>
      <div className="row">
        <h1 className="page-title">报告</h1>
        <span className="muted" style={{ fontSize: 12 }}>
          报告服务连接状态：{meta ? `${meta.source} · ${meta.instance}` : '未知'} · 订阅/周期调度未启用
        </span>
        <button className="ghost right" onClick={() => void reports.refetch()} aria-label="刷新"><RefreshCw size={14} /></button>
      </div>

      {canCreate && (
        <Card title="新建报告任务" sub="来源为已登记引用；外发数据范围由你明确选择">
          <div className="row wrap" style={{ gap: 12, alignItems: 'end' }}>
            <label className="col" style={{ gap: 4, fontSize: 12 }}>
              <span className="muted">来源引用（必填）</span>
              <input value={form.sourceRef} placeholder="例如 spring-petclinic@main" style={{ width: 240 }} maxLength={512}
                onChange={e => setForm(f => ({ ...f, sourceRef: e.target.value }))} />
            </label>
            <label className="col" style={{ gap: 4, fontSize: 12 }}>
              <span className="muted">来源版本</span>
              <input value={form.sourceVersion} style={{ width: 140 }} maxLength={128}
                onChange={e => setForm(f => ({ ...f, sourceVersion: e.target.value }))} />
            </label>
            <label className="col" style={{ gap: 4, fontSize: 12 }}>
              <span className="muted">来源摘要 sha256:…</span>
              <input value={form.sourceDigest} style={{ width: 240 }} maxLength={71}
                onChange={e => setForm(f => ({ ...f, sourceDigest: e.target.value }))} />
            </label>
            <label className="col" style={{ gap: 4, fontSize: 12 }}>
              <span className="muted">报告 profile 引用</span>
              <input value={form.reportProfileRef} style={{ width: 160 }} maxLength={512}
                onChange={e => setForm(f => ({ ...f, reportProfileRef: e.target.value }))} />
            </label>
            <label className="col" style={{ gap: 4, fontSize: 12 }}>
              <span className="muted">服务引用</span>
              <input value={form.providerRef} placeholder="留空 = 本地生成" style={{ width: 140 }} maxLength={512}
                onChange={e => setForm(f => ({ ...f, providerRef: e.target.value }))} />
            </label>
            <label className="col" style={{ gap: 4, fontSize: 12 }}>
              <span className="muted">输出格式</span>
              <select value={form.outputFormat} onChange={e => setForm(f => ({ ...f, outputFormat: e.target.value }))}>
                <option value="markdown">Markdown</option>
                <option value="json">JSON</option>
              </select>
            </label>
            <label className="col" style={{ gap: 4, fontSize: 12 }}>
              <span className="muted">数据范围（逗号分隔，可选）</span>
              <input value={form.dataScope} placeholder="如 deliveries, source-summary" style={{ width: 220 }}
                onChange={e => setForm(f => ({ ...f, dataScope: e.target.value }))} />
            </label>
            <button className="primary" disabled={busy || !form.sourceRef || digestInvalid} onClick={() => void create()}>生成报告</button>
          </div>
          {digestInvalid && <p className="muted" style={{ fontSize: 11.5 }}>摘要格式：sha256: + 64 位小写 hex。</p>}
          {error && <p role="alert" style={{ color: 'var(--failure)', fontSize: 12 }}>{error}</p>}
          {done && <p role="status" style={{ color: 'var(--success)', fontSize: 12 }}>{done}</p>}
        </Card>
      )}
      {!canCreate && !surface.readonly && (
        <Card title="新建报告任务"><p className="muted" style={{ fontSize: 12 }}>
          当前管理服务未声明报告创建操作；已连接服务的报告仍会列在下方。
        </p></Card>
      )}

      <Card title="报告任务与结果" sub="状态与文件均为真实回执；点击行查看结果文件">
        {rows.length === 0 ? (
          <EmptyState title="暂无报告" hint="连接报告服务或本地生成后可在这里查看" />
        ) : (
          <div className="col" style={{ gap: 8 }}>
            {rows.map(r => (
              <button key={r.reportId} className="card raised row" style={{ textAlign: 'left', gap: 10 }}
                onClick={() => setDetailId(r.reportId)}>
                <FileText size={15} color="var(--accent)" />
                <div className="grow">
                  <div style={{ fontSize: 12.5 }}>{r.sourceRef ?? r.reportId}{r.sourceVersion ? ` · ${r.sourceVersion}` : ''}</div>
                  <div className="muted" style={{ fontSize: 11 }}>
                    {r.providerRef ? `服务 ${r.providerRef}` : '服务未配置'} · {r.outputFormat ?? '—'} · {fmtIso(r.createdAt)}
                    {r.error?.message ? ` · ${r.error.message}` : ''}
                  </div>
                </div>
                <Badge tone={reportTone(r.state)}>{REPORT_STATE_LABEL[r.state] ?? r.state}</Badge>
                <ArrowUpRight size={14} className="muted" />
              </button>
            ))}
          </div>
        )}
      </Card>

      <Drawer open={!!detailId} onClose={() => setDetailId(null)} title="报告详情">
        {detail.isPending && <Skeleton h={140} />}
        {detail.isError && <ErrorBanner error={detail.error} onRetry={() => detail.refetch()} />}
        {detail.data && (
          <div className="col" style={{ gap: 14 }}>
            <KV items={[
              ['reportId', <span className="mono" key="r">{detail.data.data.reportId}</span>],
              ['状态', <Badge key="s" tone={reportTone(detail.data.data.state)}>{REPORT_STATE_LABEL[detail.data.data.state] ?? detail.data.data.state}</Badge>],
              ['来源', `${detail.data.data.sourceRef ?? '—'}${detail.data.data.sourceVersion ? ` · ${detail.data.data.sourceVersion}` : ''}`],
              ['来源摘要', <span className="mono" key="d">{detail.data.data.sourceDigest ?? '—'}</span>],
              ['profile / 服务', `${detail.data.data.reportProfileRef ?? '—'} / ${detail.data.data.providerRef ?? '未配置'}`],
              ['数据范围', detail.data.data.dataScope?.join('、') || '—'],
              ['结果摘要', <span className="mono" key="o">{detail.data.data.resultDigest ?? '—'}</span>],
              ['创建 / 更新', `${fmtIso(detail.data.data.createdAt)} / ${fmtIso(detail.data.data.updatedAt)}`],
            ]} />
            {detail.data.data.error?.message && (
              <p role="alert" style={{ color: 'var(--failure)', fontSize: 12 }}>{detail.data.data.error.message}</p>
            )}
            <div className="col" style={{ gap: 6 }}>
              <div className="card-sub">结果文件（真实文件与 digest）</div>
              {files.isPending && <Skeleton h={80} />}
              {files.isError && <ErrorBanner error={files.error} onRetry={() => files.refetch()} />}
              {files.data && files.data.data.length === 0 && <EmptyState title="暂无结果文件" />}
              {(files.data?.data ?? []).map(f => (
                <div key={f.fileId ?? f.name} className="card raised row" style={{ padding: '8px 10px' }}>
                  <FileText size={14} className="muted" />
                  <span style={{ fontSize: 12.5 }}>{f.name}</span>
                  <span className="muted" style={{ fontSize: 11 }}>{f.mediaType ?? '—'} · {fmtBytesOrUnknown(f.sizeBytes)}</span>
                  <span className="mono muted right" style={{ fontSize: 10.5 }}>{f.digest ?? '—'}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </Drawer>
    </div>
  );
}
