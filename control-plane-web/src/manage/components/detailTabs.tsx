// Tab bodies for WorkerDetailPage: identity/health/journal renderers.
import { Badge, Card, EmptyState, KV } from '../../components/ui/primitives';
import { DataTable } from '../../components/ui/DataTable';
import type { JournalRow, WorkerDetail, WorkerHealth, WorkerJournalView } from '../../../shared/management/api';
import { KIND_LABEL, LAYER_LABEL, LAYER_STATE, fmtIso, relTime } from '../labels';

const yn = (v: boolean | null | undefined) => (v == null ? '未采集' : v ? '是' : '否');

export function OverviewTab({ d }: { d: WorkerDetail }) {
  return (
    <div className="grid cols-12">
      <Card span={6} title="身份">
        <KV items={[
          ['workerKey', <span className="mono">{d.workerKey}</span>],
          ['名称', d.name],
          ['类型', KIND_LABEL[d.kind] ?? d.kind],
          ['机器', d.machine],
          ['workerId', d.workerId ? <span className="mono">{d.workerId}</span> : '未采集'],
          ['instanceId', d.instanceId ? <span className="mono">{d.instanceId}</span> : '未采集'],
          ['provider', d.provider ?? '未采集'],
          ['版本', d.version ?? '未采集'],
          ['登记时间', fmtIso(d.registeredAt)],
          ['最近在线', `${relTime(d.lastSeenAt)}（${fmtIso(d.lastSeenAt)}）`],
        ]} />
      </Card>
      <Card span={6} title="进程归属">
        <KV items={[
          ['受管', yn(d.ownership.managed)],
          ['pid', d.ownership.pid ?? '未采集'],
          ['命令行已验证', yn(d.ownership.verified)],
          ['说明', d.ownership.detail || '—'],
          ['启动时间', fmtIso(d.ownership.startedAt)],
        ]} />
      </Card>
      <Card span={6} title="控制通道">
        <KV items={[
          ['类型', d.control.kind],
          ['地址', d.control.url ? <span className="mono">{d.control.url}</span> : '无'],
          ['可达', yn(d.control.reachable)],
        ]} />
      </Card>
      <Card span={6} title="引擎">
        <KV items={[
          ['provider', d.engine.provider ?? '未采集'],
          ['providerBundle', d.engine.providerBundle ?? '未采集'],
          ['内嵌运行时', d.engine.embeddedRuntime ?? '未采集'],
          ['ACS 连接', d.engine.acsConnection ?? '未配置'],
        ]} />
      </Card>
      <Card span={12} title="路径">
        <KV items={[
          ['stateDir', <span className="mono">{d.paths.stateDir ?? '未采集'}</span>],
          ['workDir', <span className="mono">{d.paths.workDir ?? '未采集'}</span>],
          ['journalFile', <span className="mono">{d.paths.journalFile ?? '未采集'}</span>],
          ['configFile', <span className="mono">{d.paths.configFile ?? '未采集'}</span>],
          ['gateFile', <span className="mono">{d.paths.gateFile ?? '未采集'}</span>],
        ]} />
      </Card>
    </div>
  );
}

export function HealthTab({ d, health }: { d: WorkerDetail; health?: WorkerHealth | null }) {
  const h = health ?? d.health;
  return (
    <Card title="分层健康" sub={`观测时间 ${relTime(h.checkedAt)}（${fmtIso(h.checkedAt)}）`}>
      <div className="col">
        {h.layers.map((l) => {
          const s = LAYER_STATE[l.state] ?? LAYER_STATE.UNKNOWN;
          return (
            <div key={l.layer} className="row" data-testid={`health-layer-${l.layer}`} data-layer-state={l.state}
              style={{ alignItems: 'flex-start', gap: 10 }}>
              <span style={{ width: 9, height: 9, borderRadius: '50%', background: s.color, marginTop: 4, flexShrink: 0 }} />
              <div className="grow">
                <div className="row" style={{ gap: 8 }}>
                  <b style={{ fontSize: 12.5 }}>{LAYER_LABEL[l.layer] ?? l.layer}</b>
                  <Badge tone={s.tone}>{s.label}</Badge>
                  <span className="muted" style={{ fontSize: 11 }}>{l.summary}</span>
                </div>
                {l.detail && <div className="muted" style={{ fontSize: 11.5, marginTop: 2 }}>{l.detail}</div>}
              </div>
              <span className="muted nowrap" style={{ fontSize: 11 }}>{relTime(l.observedAt)}</span>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

export function JournalTable({ rows, journal, emptyTitle }: {
  rows: JournalRow[]; journal?: WorkerJournalView | null; emptyTitle: string;
}) {
  return (
    <>
      {journal && (
        <div className="muted" style={{ fontSize: 11.5, marginBottom: 8 }}>
          {journal.journalFile} · schema {journal.schemaVersion ?? '未知'}
          {journal.truncated ? ' · 列表有界，仅显示最近部分' : ''}
          {journal.note ? ` · ${journal.note}` : ''}
        </div>
      )}
      <DataTable
        dense
        columns={[
          { key: 'table', header: '表', render: (r) => <span className="mono">{r.table}</span> },
          { key: 'key', header: '键', render: (r) => <span className="mono">{r.key}</span> },
          { key: 'state', header: '状态', render: (r) => r.state ?? '未采集' },
          { key: 'detail', header: '摘要', render: (r) => r.detail ?? '—', width: '40%' },
          { key: 'updatedAt', header: '更新', render: (r) => <span title={fmtIso(r.updatedAt)}>{relTime(r.updatedAt)}</span> },
        ]}
        rows={rows}
        rowKey={(r, i) => `${r.table}:${r.key}:${i}`}
        empty={<EmptyState title={emptyTitle} hint="journal 中没有匹配记录，或该 Worker 无 journal 读取能力。" />}
      />
    </>
  );
}
