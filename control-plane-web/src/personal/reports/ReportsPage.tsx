// PAE P7 — 报告页：一次性报告任务 + 结果查看（任务单 §10，E37–E39）。
// 本页只消费冻结的 /api/personal/v1/reports* 表面 + 同源 /projects（可降级）。
// 诚实性约束：本机确定性汇总明确标注"非模型语义审查"；订阅/调度显示未启用，
// 不伪造后台任务；provider 列表来自 meta.supportedActions 的真实广告。
import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
import { Badge, Banner, Card, EmptyState, ErrorBanner, KV, Skeleton } from '../../components/ui/primitives';
import { DataTable } from '../../components/ui/DataTable';
import { Drawer } from '../../components/ui/Drawer';
import { ApiClientError } from '../../api/client';
import { fmtBytes, fmtTimeShort, shortId } from '../../lib/format';
import { createReport, listProjects, listReportFiles, listReports } from './api';
import {
  DATA_SCOPE_OPTIONS, OUTPUT_FORMATS, PROVIDER_ACTION_PREFIX, PROVIDER_NOT_CONFIGURED_CODE,
  REPORT_PROFILES, REPORT_STATE_LABEL, REPORT_STATE_TONE, SOURCE_SCHEMES, type SourceScheme,
} from './vocab';
import type { ReportDescriptor } from '../../../../codeagent-desktop/packages/protocol/src/personal';

function newRequestKey() { return `req_${crypto.randomUUID()}`; }

function StateBadge({ state }: { state: string }) {
  return <Badge tone={REPORT_STATE_TONE[state] ?? 'unknown'}>{REPORT_STATE_LABEL[state] ?? state}</Badge>;
}

export default function ReportsPage() {
  const qc = useQueryClient();
  const [scheme, setScheme] = useState<SourceScheme>('data');
  const [ref, setRef] = useState('');
  const [sourceVersion, setSourceVersion] = useState('');
  const [sourceDigest, setSourceDigest] = useState('');
  const [profile, setProfile] = useState('local/summary');
  const [provider, setProvider] = useState('local');
  const [outputFormat, setOutputFormat] = useState('markdown+json');
  const [dataScope, setDataScope] = useState<string[]>([]);
  const [requestKey, setRequestKey] = useState(newRequestKey);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const list = useQuery({
    queryKey: ['personal', 'reports'],
    queryFn: () => listReports(),
    // Poll while any report is in-flight — real state transitions only.
    refetchInterval: (q) => {
      const rows = q.state.data?.data ?? [];
      return rows.some((r) => r.state === 'QUEUED' || r.state === 'RUNNING') ? 1500 : false;
    },
  });
  const meta = list.data?.meta;
  const rows = useMemo(() => [...(list.data?.data ?? [])].sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? '')), [list.data]);
  // Detail view derives from the polled list so QUEUED→RUNNING→READY
  // transitions reach the open drawer without a stale snapshot.
  const selected: ReportDescriptor | null = rows.find((r) => r.reportId === selectedId) ?? null;
  const providers = useMemo(() => {
    const fromMeta = (meta?.supportedActions ?? [])
      .filter((a) => a.startsWith(PROVIDER_ACTION_PREFIX))
      .map((a) => a.slice(PROVIDER_ACTION_PREFIX.length));
    return fromMeta.length ? fromMeta : ['local'];
  }, [meta]);
  const providerUnconfigured = (meta?.reasonCodes ?? []).includes(PROVIDER_NOT_CONFIGURED_CODE);

  const projects = useQuery({ queryKey: ['personal', 'projects'], queryFn: () => listProjects(), retry: false });

  const files = useQuery({
    queryKey: ['personal', 'reports', selected?.reportId, 'files'],
    queryFn: () => listReportFiles(selected!.reportId),
    enabled: !!selected,
  });

  const create = useMutation({
    mutationFn: () => createReport({
      requestKey,
      sourceRef: `${scheme}:${ref.trim()}`,
      sourceVersion: sourceVersion.trim() || undefined,
      sourceDigest: sourceDigest.trim() || undefined,
      reportProfileRef: profile,
      providerRef: provider,
      outputFormat,
      dataScope: dataScope.length ? dataScope : undefined,
    }),
    onSuccess: (env) => {
      setNotice(null);
      setRequestKey(newRequestKey()); // next report gets a fresh key; retry keeps the old one
      setSelectedId(env.data.reportId);
      qc.invalidateQueries({ queryKey: ['personal', 'reports'] });
    },
    onError: (err) => {
      const e = err as ApiClientError;
      setNotice(e.code === 'IDEMPOTENCY_CONFLICT'
        ? `幂等冲突：requestKey ${requestKey} 已用于不同请求体 — 请更换 key 或用原 body 重试`
        : null);
    },
  });

  const canSubmit = ref.trim().length > 0 && !create.isPending;

  return (
    <div className="col" style={{ gap: 16 }}>
      <div className="row">
        <h1 className="page-title">报告</h1>
        <span className="muted" style={{ fontSize: 12 }}>源码候选分析 / 登记数据 → 一次性报告任务</span>
      </div>

      {providerUnconfigured && (
        <Banner kind="info">存在已声明但未配置的外部报告服务 — 未配置不会生成假报告，本机生成器 <span className="mono">local</span> 不受影响。</Banner>
      )}
      {notice && <Banner kind="error">{notice}</Banner>}
      {create.isError && !notice && <ErrorBanner error={create.error} />}

      <div className="grid cols-12">
        <Card span={5} title="新建报告任务" sub="本机确定性生成：记录原 requestKey、来源 digest/水位、输出 digest 与真实文件">
          <div className="col" style={{ gap: 10 }}>
            <label className="col" style={{ gap: 4 }}>
              <span className="muted" style={{ fontSize: 12 }}>来源类型</span>
              <select value={scheme} onChange={(e) => setScheme(e.target.value as SourceScheme)}>
                {SOURCE_SCHEMES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
              </select>
            </label>
            <label className="col" style={{ gap: 4 }}>
              <span className="muted" style={{ fontSize: 12 }}>
                来源标识 <span style={{ opacity: 0.7 }}>({SOURCE_SCHEMES.find((s) => s.value === scheme)?.hint})</span>
              </span>
              <input value={ref} onChange={(e) => setRef(e.target.value)}
                placeholder={scheme === 'data' ? '如 sales-2026-09（对应 sales-2026-09.csv/.json）' : '已登记对象 ID'}
                list={scheme === 'project' ? 'personal-project-options' : undefined} />
              {scheme === 'project' && (
                <datalist id="personal-project-options">
                  {(projects.data?.data ?? []).map((p) => <option key={p.projectId} value={p.projectId}>{p.displayName ?? p.projectRef}</option>)}
                </datalist>
              )}
            </label>
            <div className="row" style={{ gap: 10 }}>
              <label className="col grow" style={{ gap: 4 }}>
                <span className="muted" style={{ fontSize: 12 }}>来源版本（可选）</span>
                <input value={sourceVersion} onChange={(e) => setSourceVersion(e.target.value)} placeholder="如 v3 / commit" />
              </label>
              <label className="col grow" style={{ gap: 4 }}>
                <span className="muted" style={{ fontSize: 12 }}>声明 digest（可选 sha256:…）</span>
                <input value={sourceDigest} onChange={(e) => setSourceDigest(e.target.value)} placeholder="固定来源内容" />
              </label>
            </div>
            <div className="row" style={{ gap: 10 }}>
              <label className="col grow" style={{ gap: 4 }}>
                <span className="muted" style={{ fontSize: 12 }}>报告 profile</span>
                <select value={profile} onChange={(e) => setProfile(e.target.value)}>
                  {REPORT_PROFILES.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
                </select>
              </label>
              <label className="col grow" style={{ gap: 4 }}>
                <span className="muted" style={{ fontSize: 12 }}>输出格式</span>
                <select value={outputFormat} onChange={(e) => setOutputFormat(e.target.value)}>
                  {OUTPUT_FORMATS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
                </select>
              </label>
              <label className="col grow" style={{ gap: 4 }}>
                <span className="muted" style={{ fontSize: 12 }}>Provider</span>
                <select value={provider} onChange={(e) => setProvider(e.target.value)}>
                  {providers.map((p) => <option key={p} value={p}>{p}{p === 'local' ? '（本机）' : ''}</option>)}
                </select>
              </label>
            </div>
            <div className="col" style={{ gap: 4 }}>
              <span className="muted" style={{ fontSize: 12 }}>数据范围（用户显式选择，逐项记录进报告）</span>
              <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
                {DATA_SCOPE_OPTIONS.map((o) => (
                  <label key={o.value} className="row" style={{ gap: 4, fontSize: 12 }}>
                    <input type="checkbox" checked={dataScope.includes(o.value)}
                      onChange={(e) => setDataScope((s) => e.target.checked ? [...s, o.value] : s.filter((x) => x !== o.value))} />
                    {o.label} <span className="mono muted">{o.value}</span>
                  </label>
                ))}
              </div>
            </div>
            <div className="row" style={{ gap: 8 }}>
              <span className="muted nowrap" style={{ fontSize: 12 }}>requestKey</span>
              <span className="mono grow" style={{ fontSize: 11.5, overflowWrap: 'anywhere' }}>{requestKey}</span>
              <button className="ghost" title="重新生成" onClick={() => setRequestKey(newRequestKey())}><RefreshCw size={13} /></button>
            </div>
            <div className="muted" style={{ fontSize: 11.5 }}>
              同一 requestKey + 相同请求体 → 返回原报告（幂等）；相同 key 不同 body → 冲突。
              汇总为确定性结果，不含模型语义审查；安装不会上传源码或凭据。
            </div>
            <div>
              <button disabled={!canSubmit} onClick={() => create.mutate()}>
                {create.isPending ? '提交中…' : '创建报告任务'}
              </button>
            </div>
          </div>
        </Card>

        <Card span={7} title="报告任务" sub="QUEUED/RUNNING 时自动轮询；重启后可按原 requestKey 恢复"
          right={<button className="ghost" onClick={() => list.refetch()} aria-label="刷新"><RefreshCw size={14} /></button>}>
          {list.isPending ? <Skeleton h={160} /> : list.isError ? <ErrorBanner error={list.error} onRetry={() => list.refetch()} /> : (
            <DataTable
              columns={[
                { key: 'state', header: '状态', render: (r) => <StateBadge state={String(r.state)} /> },
                { key: 'sourceRef', header: '来源', render: (r) => <span className="mono">{String(r.sourceRef ?? '—')}</span> },
                { key: 'providerRef', header: 'Provider', render: (r) => String(r.providerRef ?? '—') },
                { key: 'outputFormat', header: '格式', render: (r) => String(r.outputFormat ?? '—') },
                { key: 'resultDigest', header: '结果 digest', render: (r) => <span className="mono">{shortId(String(r.resultDigest ?? '').replace('sha256:', '') || '')}</span> },
                { key: 'createdAt', header: '创建', render: (r) => fmtTimeShort(r.createdAt ? Date.parse(String(r.createdAt)) : null) },
              ]}
              rows={rows as unknown as Record<string, unknown>[]}
              rowKey={(r) => String(r.reportId)}
              onRowClick={(r) => setSelectedId(String(r.reportId))}
              empty={<EmptyState title="暂无报告" hint="创建一个一次性报告任务；本机生成器确定性汇总登记来源。" />}
            />
          )}
        </Card>
      </div>

      <Card title="订阅与周期调度" sub="订阅草稿仅记录意图 — 不创建任何后台/系统任务">
        <div className="row" style={{ gap: 8 }}>
          <Badge tone="unknown">未启用</Badge>
          <span className="muted" style={{ fontSize: 12 }}>
            自动周期报告、账户与结算为后续接缝；当前版本不会偷偷创建本工具或操作系统的自动任务。
            本页仅支持显式提交的一次性报告任务。
          </span>
        </div>
      </Card>

      <Drawer open={!!selected} onClose={() => setSelectedId(null)} title={selected ? `报告 ${selected.reportId}` : ''}>
        {selected && (
          <div className="col" style={{ gap: 12 }}>
            <KV items={[
              ['状态', <StateBadge state={selected.state} />],
              ['requestKey', <span className="mono">{selected.requestKey ?? '—'}</span>],
              ['sourceRef', <span className="mono">{selected.sourceRef ?? '—'}</span>],
              ['sourceVersion', selected.sourceVersion ?? '—'],
              ['来源 digest', <span className="mono">{selected.sourceDigest ?? '—'}</span>],
              ['profile', selected.reportProfileRef ?? '—'],
              ['provider', selected.providerRef ?? '—'],
              ['格式', selected.outputFormat ?? '—'],
              ['数据范围', selected.dataScope?.length ? selected.dataScope.join(', ') : '未声明（仅本机聚合）'],
              ['结果 digest', <span className="mono">{selected.resultDigest ?? '—'}</span>],
              ['创建', fmtTimeShort(selected.createdAt ? Date.parse(selected.createdAt) : null)],
              ['更新', fmtTimeShort(selected.updatedAt ? Date.parse(selected.updatedAt) : null)],
            ]} />
            {selected.error && (
              <Banner kind="error">{selected.error.message ?? '报告失败'}{selected.error.code ? `（${selected.error.code}）` : ''}</Banner>
            )}
            <div>
              <div className="card-title" style={{ marginBottom: 6 }}>输出文件</div>
              {files.isPending ? <Skeleton h={60} /> : files.isError ? <ErrorBanner error={files.error} /> : (
                <DataTable
                  columns={[
                    { key: 'name', header: '文件', render: (r) => <span className="mono">{String(r.name)}</span> },
                    { key: 'mediaType', header: '类型', render: (r) => String(r.mediaType ?? '—') },
                    { key: 'sizeBytes', header: '大小', numeric: true, render: (r) => r.sizeBytes == null ? '—' : fmtBytes(Number(r.sizeBytes)) },
                    { key: 'digest', header: 'digest', render: (r) => <span className="mono">{shortId(String(r.digest ?? '').replace('sha256:', ''))}</span> },
                  ]}
                  rows={(files.data?.data ?? []) as unknown as Record<string, unknown>[]}
                  rowKey={(r) => String(r.fileId ?? r.name)}
                  empty={<EmptyState title="尚无输出文件" hint="任务仍在执行或已失败。" />}
                />
              )}
            </div>
            <div className="muted" style={{ fontSize: 11.5 }}>
              确定性汇总标注其实际范围；文件内容下载路由为 P0 后续候选（当前返回文件元数据+digest）。
            </div>
          </div>
        )}
      </Drawer>
    </div>
  );
}
