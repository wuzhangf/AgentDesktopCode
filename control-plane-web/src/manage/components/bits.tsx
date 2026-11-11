// Small shared display pieces for the manage console.
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Download, FileTerminal, Power, ShieldCheck, Stethoscope } from 'lucide-react';
import { Badge, Banner, Card } from '../../components/ui/primitives';
import { DataTable } from '../../components/ui/DataTable';
import { shortId } from '../../lib/format';
import type {
  AcceptingState, LayerState, Operation, OperationStep, WorkerCapability, WorkerSummary,
} from '../../../shared/management/api';
import {
  ACCEPTING, GATE_STATE, KIND_LABEL, LAYER_STATE, OP_KIND_LABEL, OP_STATE, fmtIso, relTime,
} from '../labels';

export function ConnDot({ state }: { state: LayerState }) {
  const s = LAYER_STATE[state] ?? LAYER_STATE.UNKNOWN;
  return (
    <span className="row" style={{ gap: 6 }} title={`主机连接：${s.label}`}>
      <span style={{ width: 8, height: 8, borderRadius: '50%', background: s.color, display: 'inline-block' }} />
      <span style={{ fontSize: 12 }}>{s.label}</span>
    </span>
  );
}

export function KindBadge({ kind }: { kind: WorkerSummary['kind'] }) {
  return <Badge tone={kind === 'MANAGED' ? 'info' : 'plain'}>{KIND_LABEL[kind] ?? kind}</Badge>;
}

export function AcceptingBadge({ state }: { state: AcceptingState }) {
  const s = ACCEPTING[state] ?? ACCEPTING.UNKNOWN;
  return (
    <span data-testid="worker-gate-badge" data-accepting={state}>
      <Badge tone={s.tone} title={s.hint}>{s.label}</Badge>
    </span>
  );
}

export function GateBadge({ gate }: { gate: WorkerSummary['installGate'] }) {
  const g = GATE_STATE[gate] ?? GATE_STATE.UNKNOWN;
  return <Badge tone={g.tone}>{g.label}</Badge>;
}

export function DaemonBadge({ ready, draining }: { ready: boolean | null; draining: boolean | null }) {
  const label = ready == null ? 'daemon 未采集' : ready ? 'daemon 就绪' : 'daemon 未就绪';
  const tone = ready == null ? 'unknown' : ready ? 'success' : 'warning';
  return (
    <>
      <Badge tone={tone}>{label}</Badge>
      {draining === true && <Badge tone="failure" title="daemon 锁存排水，需重启进程恢复">DRAINING</Badge>}
    </>
  );
}

const CAP_ICON: Record<WorkerCapability, { icon: typeof Power; label: string }> = {
  LIFECYCLE: { icon: Power, label: '进程生命周期控制' },
  GATE: { icon: ShieldCheck, label: 'install-gate 接单控制' },
  JOURNAL_READ: { icon: FileTerminal, label: 'journal 只读' },
  HEALTH_PROBE: { icon: Stethoscope, label: '健康探测' },
  DIAGNOSTICS: { icon: Download, label: '诊断导出' },
};

export function CapIcons({ caps }: { caps: WorkerCapability[] }) {
  if (!caps.length) return <span className="muted">无</span>;
  return (
    <span className="row" style={{ gap: 6 }}>
      {caps.map((c) => {
        const it = CAP_ICON[c];
        if (!it) return null;
        return <it.icon key={c} size={13} className="muted" aria-label={it.label} style={{ display: 'block' }} />;
      })}
    </span>
  );
}

export function OpStateBadge({ state }: { state: Operation['state'] }) {
  const s = OP_STATE[state] ?? { label: state, tone: 'plain' };
  return <Badge tone={s.tone}>{s.label}</Badge>;
}

export function OpSteps({ steps }: { steps: OperationStep[] }) {
  if (!steps.length) return <span className="muted">—</span>;
  return (
    // stopPropagation: this sits inside clickable rows — expanding steps must
    // not be mistaken for picking the operation.
    <details onClick={(e) => e.stopPropagation()}>
      <summary className="clickable-text" style={{ fontSize: 11.5 }}>{steps.length} 步</summary>
      <ol style={{ margin: '6px 0 2px', paddingLeft: 18, fontSize: 11.5 }}>
        {steps.map((s, i) => (
          <li key={i} style={{ marginBottom: 3 }}>
            <span className="muted nowrap">{fmtIso(s.at)}</span> {s.message}
          </li>
        ))}
      </ol>
    </details>
  );
}

export function OperationsTable({ ops, onPick }: { ops: Operation[]; onPick?: (op: Operation) => void }) {
  return (
    <DataTable
      dense
      columns={[
        { key: 'kind', header: '操作', render: (o) => OP_KIND_LABEL[o.kind] ?? o.kind },
        {
          key: 'worker', header: 'Worker',
          render: (o) => <Link to={`/manage/workers/${encodeURIComponent(o.workerKey)}`} onClick={(e) => e.stopPropagation()}>{o.workerName}</Link>,
        },
        { key: 'state', header: '状态', render: (o) => <OpStateBadge state={o.state} /> },
        { key: 'err', header: '说明', render: (o) => o.error ? `${o.error.message}（${o.error.code}）` : <span className="muted">—</span> },
        { key: 'steps', header: '步骤', render: (o) => <OpSteps steps={o.steps} /> },
        { key: 'updatedAt', header: '更新', render: (o) => <span className="muted" title={fmtIso(o.updatedAt)}>{relTime(o.updatedAt)}</span> },
      ]}
      rows={ops}
      rowKey={(o) => o.operationId}
      onRowClick={onPick}
      empty={<span className="muted">暂无操作记录</span>}
    />
  );
}

export function WorkerCard({ w, onClick }: { w: WorkerSummary; onClick?: () => void }) {
  return (
    <button className="card raised" style={{ textAlign: 'left', display: 'block', width: '100%' }} onClick={onClick}
      data-testid="worker-card" data-worker-key={w.workerKey}>
      <div className="row" style={{ marginBottom: 6 }}>
        <b style={{ fontSize: 13 }}>{w.name}</b>
        <KindBadge kind={w.kind} />
        <span className="right"><ConnDot state={w.connection} /></span>
      </div>
      <div className="row wrap" style={{ gap: 6, marginBottom: 6 }}>
        <DaemonBadge ready={w.daemonReady} draining={w.draining} />
        <GateBadge gate={w.installGate} />
        <AcceptingBadge state={w.acceptingTasks} />
      </div>
      <div className="muted" style={{ fontSize: 11.5 }}>
        {w.provider ?? '未知提供者'} · 版本 {w.version ?? '未采集'} · 最近在线 {relTime(w.lastSeenAt)}
        {w.activeAttemptId && <div>活动任务 <span className="mono">{shortId(w.activeAttemptId)}</span></div>}
      </div>
    </button>
  );
}

/** Increment-B placeholder page shell. */
export function PlannedPage({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="col" style={{ gap: 14 }}>
      <h1 className="page-title">{title}</h1>
      <Banner kind="info">本页在增量 B 交付 — 当前不展示任何数据，以下为规划范围说明。</Banner>
      <Card><div style={{ fontSize: 12.5, color: 'var(--text-secondary)' }}>{children}</div></Card>
    </div>
  );
}
