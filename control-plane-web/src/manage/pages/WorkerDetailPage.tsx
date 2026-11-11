// Worker 详情: capability-driven action bar (LIFECYCLE / GATE / external
// read-only), live operation tracking, tabbed facts — overview, layered
// health, execution journal, sanitized config, journal + diagnostics.
import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Download, Play, Power, RefreshCw, RotateCw, ShieldCheck, Stethoscope } from 'lucide-react';
import { Badge, Banner, Card, EmptyState, ErrorBanner, KV, Skeleton, Tabs } from '../../components/ui/primitives';
import {
  asList, manageGet, managePost, unwrap, useInvalidateManage, useManage, ManageApiError,
} from '../api';
import type {
  DiagnosticsBundle, Operation, OperationKind, OperationState, WorkerDetail, WorkerHealth, WorkerJournalView,
} from '../../../shared/management/api';
import { OP_KIND_LABEL, relTime } from '../labels';
import { AcceptingBadge, ConnDot, KindBadge, OpStateBadge, OpSteps, OperationsTable } from '../components/bits';
import { HealthTab, JournalTable, OverviewTab } from '../components/detailTabs';

const TABS = [
  { id: 'overview', label: '概况' },
  { id: 'health', label: '健康' },
  { id: 'tasks', label: '任务' },
  { id: 'config', label: '配置' },
  { id: 'journal', label: '日志与维护' },
];

function opActive(s?: OperationState) { return s === 'PENDING' || s === 'RUNNING'; }

export default function WorkerDetailPage() {
  const { key = '' } = useParams();
  const nav = useNavigate();
  const [sp] = useSearchParams();
  const invalidate = useInvalidateManage();
  const [tab, setTab] = useState('overview');
  const [activeOpId, setActiveOpId] = useState<string | null>(sp.get('op'));
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<{ message: string; code?: string } | null>(null);
  const [check, setCheck] = useState<{ h: WorkerHealth | null; err: string | null; busy: boolean }>({ h: null, err: null, busy: false });
  const [exportErr, setExportErr] = useState<string | null>(null);

  // Same-route :key switches do not remount — drop worker-A facts and adopt
  // the ?op= tracking target of the new URL.
  useEffect(() => {
    setActiveOpId(sp.get('op'));
    setCheck({ h: null, err: null, busy: false });
    setErr(null);
    setExportErr(null);
    setSubmitting(false);
  }, [key, sp]);

  const q = useManage<WorkerDetail>(['worker', key], `/workers/${encodeURIComponent(key)}`, 4000);
  const opsQ = useManage<unknown>(['operations', key], `/operations?workerKey=${encodeURIComponent(key)}`, 8000);
  // Poll the tracked op only while it is PENDING/RUNNING (or not yet loaded);
  // a failed fetch stops polling — a dead id must not spin forever.
  const opQ = useQuery({
    queryKey: ['manage', 'op', activeOpId],
    enabled: activeOpId != null,
    retry: 1,
    queryFn: ({ signal }) => manageGet<unknown>(`/operations/${encodeURIComponent(activeOpId!)}`, signal),
    refetchInterval: (query) => {
      if (query.state.status === 'error') return false;
      const o = query.state.data ? unwrap<Operation>(query.state.data, 'operation') : null;
      return !o || opActive(o.state) ? 1500 : false;
    },
  });
  const d = q.data;
  const canJournal = d?.capabilities.includes('JOURNAL_READ') ?? false;
  const wantJournal = canJournal && (tab === 'tasks' || tab === 'journal');
  const journalQ = useManage<WorkerJournalView>(['journal', key],
    wantJournal ? `/workers/${encodeURIComponent(key)}/journal` : null, wantJournal ? 8000 : 0);
  const activeOp = opQ.data ? unwrap<Operation>(opQ.data, 'operation') : null;
  // Buttons stay disabled while the tracked op is in flight (or not yet
  // loaded). A failed op fetch releases them — the error is shown instead.
  const busy = submitting || (activeOpId != null && !opQ.isError
    && (activeOp == null || (activeOp.operationId === activeOpId && opActive(activeOp.state))));
  const ops = useMemo(
    () => asList<Operation>(opsQ.data, 'operations').filter((o) => o.workerKey === key)
      .sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '')),
    [opsQ.data, key]);

  // A finishing operation must refresh worker facts (gate, draining, health).
  const activeState = activeOp?.state;
  useEffect(() => {
    if (activeState && !opActive(activeState)) invalidate();
  }, [activeState, invalidate]);

  async function runOp(kind: OperationKind) {
    if (!d) return;
    if (kind === 'STOP' || kind === 'RESTART') {
      const impact = d.activeAttemptId
        ? `当前有活动任务 attempt ${d.activeAttemptId}，${OP_KIND_LABEL[kind]}将中断它。`
        : '当前没有活动任务。';
      if (!window.confirm(`${OP_KIND_LABEL[kind]} ${d.name}\n${impact}确认执行？`)) return;
    }
    if (busy) return;
    setErr(null);
    setSubmitting(true);
    const operationId = crypto.randomUUID();
    setActiveOpId(operationId);
    try {
      await managePost(`/workers/${encodeURIComponent(key)}/operations`, { operationId, kind });
      invalidate();
    } catch (e) {
      setErr(e instanceof ManageApiError ? { message: e.message, code: e.code } : { message: (e as Error).message });
      setActiveOpId(null);
    } finally {
      setSubmitting(false);
    }
  }

  async function checkNow() {
    setCheck({ h: null, err: null, busy: true });
    try {
      const r = await managePost<unknown>(`/workers/${encodeURIComponent(key)}/check`, {});
      setCheck({ h: unwrap<WorkerHealth>(r, 'health'), err: null, busy: false });
      invalidate();
    } catch (e) {
      setCheck({ h: null, err: (e as Error).message, busy: false });
    }
  }

  async function exportDiagnostics() {
    setExportErr(null);
    try {
      const data = await manageGet<DiagnosticsBundle>('/diagnostics/export');
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `manage-diagnostics-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (e) { setExportErr((e as Error).message); }
  }

  if (q.isPending) return <div className="col" style={{ gap: 14 }}><Skeleton h={80} /><Skeleton h={320} /></div>;
  if (q.isError) return <ErrorBanner error={q.error} onRetry={() => q.refetch()} />;
  if (!d) return <EmptyState title="Worker 不存在" hint="它可能已被移除。" />;

  const caps = new Set(d.capabilities);
  const taskRows = (journalQ.data?.rows ?? []).filter((r) => r.table === 'execution_journal' || r.table === 'finish_journal');

  return (
    <div className="col" style={{ gap: 14 }}>
      <div className="row wrap">
        <button className="ghost" onClick={() => nav('/manage/workers')} style={{ padding: '4px 8px' }}>← Workers</button>
        <h1 className="page-title" style={{ margin: 0 }}>{d.name}</h1>
        <KindBadge kind={d.kind} />
        <span className="muted" style={{ fontSize: 12 }}>{d.machine === 'local' ? '本机' : d.machine}</span>
        <ConnDot state={d.connection} />
        <AcceptingBadge state={d.acceptingTasks} />
        <span className="muted right" style={{ fontSize: 11.5 }}>最近在线 {relTime(d.lastSeenAt)}</span>
      </div>

      <Card>
        <div className="row wrap" style={{ gap: 8 }}>
          {caps.has('LIFECYCLE') && (
            <>
              <button className="row" style={{ gap: 6 }} disabled={busy} onClick={() => runOp('START')}><Play size={13} /> 启动</button>
              <button className="row" style={{ gap: 6 }} disabled={busy} onClick={() => runOp('STOP')}><Power size={13} /> 停止</button>
              <button className="row" style={{ gap: 6 }} disabled={busy} onClick={() => runOp('RESTART')}><RotateCw size={13} /> 重启</button>
            </>
          )}
          {caps.has('GATE') && (
            <button className="row" style={{ gap: 6 }} disabled={busy}
              title="通过 install-gate 文件控制，可逆；与 daemon DRAINING 锁存不同"
              onClick={() => runOp(d.installGate === 'ARMED' ? 'GATE_DISARM' : 'GATE_ARM')}>
              <ShieldCheck size={13} /> {d.installGate === 'ARMED' ? '恢复接单' : '停止接单'}
            </button>
          )}
          <button className="row" style={{ gap: 6 }} disabled={check.busy} onClick={checkNow}>
            <Stethoscope size={13} /> {check.busy ? '检查中…' : '检查连接'}
          </button>
        </div>
        {caps.has('GATE') && (
          <div className="muted" style={{ fontSize: 11.5, marginTop: 8 }}>
            接单开关通过 install-gate 文件控制，可逆；与 daemon 的 DRAINING 锁存不同。
            {d.draining === true && <span style={{ color: 'var(--failure)' }}> daemon 已锁存 DRAINING，恢复接单需要重启进程。</span>}
          </div>
        )}
        {d.kind === 'EXTERNAL' && !caps.has('LIFECYCLE') && !caps.has('GATE') && (
          <Banner kind="info">外部连接实例：仅健康观测与日志读取，进程与本机配置不在本台控制范围。</Banner>
        )}
        {err && <Banner kind="error">{err.message}{err.code ? `（${err.code}）` : ''}</Banner>}
        {check.err && <Banner kind="error">检查连接失败：{check.err}</Banner>}
        {activeOpId && opQ.isError && (
          <Banner kind="error">
            操作回执拉取失败：{(opQ.error as Error).message} — 按钮已解锁，状态以健康页观测为准。
            <button className="ghost" style={{ marginLeft: 8, padding: '2px 8px' }} onClick={() => { setActiveOpId(null); }}>知道了</button>
          </Banner>
        )}
        {activeOp && activeOp.operationId === activeOpId && (
          <div className="card raised" style={{ marginTop: 10, border: '1px solid var(--border)' }}
            data-testid="op-receipt" data-op-id={activeOp.operationId} data-op-state={activeOp.state}>
            <div className="row" style={{ gap: 8, marginBottom: 4 }}>
              <RefreshCw size={13} className="muted" />
              <b style={{ fontSize: 12.5 }}>操作 {OP_KIND_LABEL[activeOp.kind] ?? activeOp.kind}</b>
              <OpStateBadge state={activeOp.state} />
              <span className="muted" style={{ fontSize: 11 }}>{relTime(activeOp.updatedAt)}</span>
            </div>
            {activeOp.state === 'VERIFY_FAILED' && (
              <div className="muted" style={{ fontSize: 11.5, marginBottom: 4 }}>
                动作已下发但结果校验未通过（VERIFY_FAILED）——真实状态以健康页观测为准。
              </div>
            )}
            {activeOp.error && <div style={{ fontSize: 12, color: 'var(--failure)' }}>{activeOp.error.message}（{activeOp.error.code}）</div>}
            <OpSteps steps={activeOp.steps} />
          </div>
        )}
      </Card>

      <Tabs tabs={TABS} active={tab} onChange={setTab} />

      {tab === 'overview' && <OverviewTab d={d} />}
      {tab === 'health' && <HealthTab d={d} health={check.h} />}
      {tab === 'tasks' && (
        <Card title="任务执行记录" sub={caps.has('JOURNAL_READ') ? 'execution_journal + finish_journal' : undefined}>
          {!caps.has('JOURNAL_READ')
            ? <EmptyState title="无执行记录" hint="该 Worker 无 journal 读取能力（未配置 stateDir）。" />
            : journalQ.isPending ? <Skeleton h={200} />
            : journalQ.isError ? <ErrorBanner error={journalQ.error} onRetry={() => journalQ.refetch()} />
            : <JournalTable rows={taskRows} journal={journalQ.data} emptyTitle="无执行记录" />}
        </Card>
      )}
      {tab === 'config' && (
        <Card title="有效配置" sub="已脱敏 — 密钥不会出现在此处">
          {Object.keys(d.config).length === 0 ? <EmptyState title="未采集" hint="没有可读的有效配置。" /> : (
            <KV items={Object.entries(d.config).map(([k, v]) => [k, <span className="mono">{v}</span>])} />
          )}
        </Card>
      )}
      {tab === 'journal' && (
        <Card title="journal 只读视图" sub="state dir 内各表的有界快照"
          right={caps.has('DIAGNOSTICS') && (
            <button className="row" style={{ gap: 6 }} onClick={exportDiagnostics}><Download size={13} /> 导出诊断包</button>
          )}>
          {exportErr && <Banner kind="error">导出失败：{exportErr}</Banner>}
          {!caps.has('JOURNAL_READ')
            ? <EmptyState title="无 journal" hint="该 Worker 无 journal 读取能力（未配置 stateDir）。" />
            : journalQ.isPending ? <Skeleton h={200} />
            : journalQ.isError ? <ErrorBanner error={journalQ.error} onRetry={() => journalQ.refetch()} />
            : <JournalTable rows={journalQ.data?.rows ?? []} journal={journalQ.data} emptyTitle="journal 为空" />}
        </Card>
      )}

      <Card title="操作记录" sub={ops.some((o) => o.state === 'VERIFY_FAILED') ? 'VERIFY_FAILED：动作已下发但校验未通过，以健康观测为准' : undefined}>
        {opsQ.isError
          ? <Banner kind="error">操作记录不可用：{(opsQ.error as Error).message}</Banner>
          : <OperationsTable ops={ops} onPick={(o) => setActiveOpId(o.operationId)} />}
      </Card>
    </div>
  );
}
