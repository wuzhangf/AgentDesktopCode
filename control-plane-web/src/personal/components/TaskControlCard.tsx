// PAE — 个人任务可靠控制（design §6.1/§6.2）：暂停/继续/停止。
// requestKey == commandId == Idempotency-Key：同一请求重发不产生第二条命令，
// 原 key/原正文的冻结语义由服务端保证，本卡只按原样回传。
// 控制请求状态与任务运行状态分开：本卡只展示服务端控制视图与源端回执，
// 不乐观改写 Run 状态（运行状态仍以「运行详情」卡的轮询为准）。
import { useEffect, useState } from 'react';
import { Card, ErrorBanner, Skeleton } from '../../components/ui/primitives';
import { usePersonal, usePersonalGateway, usePersonalInvalidate, usePersonalSurface } from '../hooks';
import { PersonalClientError } from '../client';
import { fmtIso } from '../viewmodel';
import type {
  PersonalTaskCommandRequest,
  PersonalTaskCommandView,
  PersonalTaskControlView,
} from '../../../../codeagent-desktop/packages/protocol/src/personal-task';
import type { RunCommandReceipt } from '../../../../codeagent-desktop/packages/protocol/src/index';

const INTENT_LABEL: Record<string, string> = { PAUSE: '暂停', RESUME: '继续', STOP: '停止' };
/** allowedIntents 为空时的原因说明；未识别的 code 原样展示。 */
const CONTROL_REASON_LABEL: Record<string, string> = {
  FOUNDATION_ADMISSION_DISABLED: '暂停/继续未开启',
  RUN_NOT_ASSIGNED: '等待源端分配运行',
};

// ---- 浏览器窄恢复标记（非秘密，仅本机核对线索；绝不自动重发） ----

interface ControlMarker {
  taskId: string;
  requestKey: string;
  intent: string;
  createdAt: string;
  controlPlaneId?: string;
}
const MARKER_PREFIX = 'pae.personal.taskControl.';

function markerStorage(): Storage | null {
  try { return globalThis.localStorage ?? null; } catch { return null; }
}
/** 受限环境（无痕/存储被禁）里写失败返回 false——不阻断提交，仅提示。 */
function writeMarker(m: ControlMarker): boolean {
  const store = markerStorage();
  if (!store) return false;
  try { store.setItem(MARKER_PREFIX + m.requestKey, JSON.stringify(m)); return true; } catch { return false; }
}
function removeMarker(requestKey: string): void {
  const store = markerStorage();
  if (!store) return;
  try { store.removeItem(MARKER_PREFIX + requestKey); } catch { /* ignore */ }
}
/** 本机登记的该任务未决控制标记（页面重载后仍能核对）。 */
function listMarkers(taskId: string): ControlMarker[] {
  const store = markerStorage();
  if (!store) return [];
  const out: ControlMarker[] = [];
  try {
    for (let i = 0; i < store.length; i++) {
      const key = store.key(i);
      if (!key?.startsWith(MARKER_PREFIX)) continue;
      try {
        const parsed = JSON.parse(store.getItem(key) ?? '') as ControlMarker;
        if (parsed?.taskId === taskId && typeof parsed.requestKey === 'string' && parsed.requestKey) out.push(parsed);
      } catch { /* 单条坏数据不影响其余标记 */ }
    }
  } catch { /* ignore */ }
  return out.sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));
}

/** 服务端已知的 commandId/requestKey 集合（pendingRequests + 源端命令历史）。 */
function knownCommandKeys(view: PersonalTaskControlView): Set<string> {
  const known = new Set<string>();
  for (const p of view.pendingRequests ?? []) { known.add(p.commandId); known.add(p.request.requestKey); }
  for (const r of view.recentRequests ?? []) known.add(r.commandId);
  for (const r of view.sourceCommands?.items ?? []) known.add(r.commandId);
  return known;
}

/** 回执阶段 → 人话（不引入第二状态机，只映射源端 receipt.phase）。 */
function receiptLabel(r: RunCommandReceipt): string {
  switch (r.phase) {
    case 'ACCEPTED':
    case 'DISPATCHING':
    case 'REQUESTED': return '已受理/处理中';
    case 'APPLIED': return '已生效';
    case 'NOOP': return '源端已处于目标状态，无需执行';
    case 'REJECTED': return `已拒绝${r.resultCode ? `：${r.resultCode}` : ''}`;
    case 'SUPERSEDED': return '已被后续控制取代';
    case 'UNKNOWN': return '结果尚未确认';
    default: return `回执阶段 ${r.phase}`;
  }
}

function errText(e: unknown): string {
  const err = e as PersonalClientError;
  return `${err?.message ?? '请求失败'}${err?.code ? `（${err.code}）` : ''}`;
}

function PendingRow({ item, busy, readonly, onReconcile, onResubmit }: {
  item: PersonalTaskCommandView;
  busy: boolean;
  readonly: boolean;
  onReconcile: (requestKey: string) => void;
  onResubmit: (request: PersonalTaskCommandRequest) => void;
}) {
  return (
    <article className="card" style={{ padding: 10 }}>
      <div className="row wrap" style={{ gap: 8 }}>
        <strong>{INTENT_LABEL[item.request.intent] ?? item.request.intent}</strong><span>运行：{item.targetRunId ?? '原首轮'}</span>
        <span className="muted" style={{ fontSize: 12 }}>登记于 {fmtIso(item.createdAt)}</span>
        <span className="muted" style={{ fontSize: 12 }}>{item.dispatchStartedAt ? '已派发' : '已登记，尚未派发'}</span>
      </div>
      <p style={{ margin: '4px 0' }}>{item.receipt ? receiptLabel(item.receipt) : '等待源端回执'}</p>
      {item.sourceRejection && <p role="alert">源端明确拒绝：{item.sourceRejection.code}</p>}
      {item.sourceError && <p role="alert">核对失败：{item.sourceError.code}（{fmtIso(item.sourceError.observedAt)}）</p>}
      {!readonly && (
        <div className="row" style={{ gap: 8 }}>
          <button className="ghost" disabled={busy} onClick={() => onReconcile(item.request.requestKey)}>核对结果</button>
          <button className="ghost" disabled={busy} onClick={() => onResubmit(item.request)}>核对并继续原控制请求</button>
        </div>
      )}
    </article>
  );
}

export function TaskControlCard({ taskId, runId }: { taskId: string; runId?: string }) {
  const gateway = usePersonalGateway();
  const surface = usePersonalSurface();
  const invalidate = usePersonalInvalidate();
  // 源端命令历史翻页游标（before 是源端 commandId 透传；undefined = 最新页）。
  const [before, setBefore] = useState<string | undefined>();
  const control = usePersonal(['taskCommands', taskId, runId, before ?? ''],
    g => g.taskCommands(taskId, {before, runId}),
    {
      // 示例面没有控制语义：transport 未覆盖三动作，不要发出 INVALID_OPERATION。
      enabled: surface.kind !== 'demo',
      refetchInterval: q => {
        // 查询出错慢速退避；有未决请求快轮询等回执；其余不轮询。
        if (q.state.status === 'error') return 15000;
        const pending = q.state.data?.data.pendingRequests;
        return pending && pending.length > 0 ? 3000 : false;
      },
    });
  const view = control.data?.data;
  const controlPlaneId = control.data?.meta.controlPlaneId;
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState('');
  const [notice, setNotice] = useState('');
  const [markers, setMarkers] = useState<ControlMarker[]>(() => listMarkers(taskId));
  // 切换任务时标记与源端翻页游标一起重置——before 只对同一 Run 的历史有意义。
  // 渲染期调整（React 约定）：effect 会先把带旧游标的查询发出去一次。
  const [prevTaskId, setPrevTaskId] = useState(taskId + ':' + (runId ?? ''));
  if (prevTaskId !== taskId + ':' + (runId ?? '')) {
    setPrevTaskId(taskId + ':' + (runId ?? ''));
    setBefore(undefined);
    setMarkers(listMarkers(taskId));
  }

  // 服务端响应 pendingRequests/record 含该 requestKey → 清除对应 marker。
  // 只在最新页核对：历史翻页不能证明「未登记」。
  useEffect(() => {
    if (before !== undefined || !view) return;
    const known = knownCommandKeys(view);
    const resolved = markers.filter(m => known.has(m.requestKey));
    if (!resolved.length) return;
    for (const m of resolved) removeMarker(m.requestKey);
    setMarkers(markers.filter(m => !known.has(m.requestKey)));
  }, [view, before, markers]);

  const stateVersion = view?.run?.stateVersion;
  const intents = view?.allowedIntents ?? [];

  const send = async (intent: 'PAUSE' | 'RESUME' | 'STOP') => {
    if (busy || surface.readonly || !view?.run?.runId) return;
    // PAUSE/RESUME 必须携带源端 expectedStateVersion；缺失则不提交。
    if (intent !== 'STOP' && typeof stateVersion !== 'number') return;
    if (intent === 'STOP' && !window.confirm('停止当前执行；已发生的修改不会回滚')) return;
    const requestKey = `web-control-${crypto.randomUUID()}`;
    const body: PersonalTaskCommandRequest = intent === 'STOP'
      ? { requestKey, targetRunId: view.run.runId, intent: 'STOP' }
      : { requestKey, targetRunId: view.run.runId, intent, expectedStateVersion: stateVersion as number };
    // 提交前写窄恢复标记：提交结果未确认时按 requestKey 核对，而不是重发。
    if (!writeMarker({ taskId, requestKey, intent, createdAt: new Date().toISOString(), controlPlaneId })) {
      setNotice('无法写入本地核对标记：当前页面关闭前请先核对结果');
    }
    setMarkers(listMarkers(taskId));
    setBusy(true); setActionError('');
    try {
      const result = await gateway.createTaskCommand(taskId, body);
      if(result.data.sourceRejection)setActionError(`源端拒绝：${result.data.sourceRejection.code}`);
      // 服务端返回登记回执即登记证明：清标记并刷新整面。
      removeMarker(requestKey);
      setMarkers(listMarkers(taskId));
      await invalidate();
    } catch (e) {
      // 提交是否登记未确认：保留标记交给服务端列表核对，不自动重发。
      setActionError(errText(e));
    } finally { setBusy(false); }
  };

  /** 只读核对：GET 单条记录刷新（不 POST）；服务端有记录则顺带清本地标记。 */
  const reconcile = async (requestKey: string) => {
    if (busy) return;
    setBusy(true); setActionError('');
    try {
      const record = await gateway.taskCommand(taskId, requestKey);
      if (record.data?.commandId === requestKey || record.data?.request?.requestKey === requestKey) {
        removeMarker(requestKey);
        setMarkers(listMarkers(taskId));
      }
      await control.refetch();
    } catch (e) {
      setActionError(errText(e));
    } finally { setBusy(false); }
  };

  /** 原 request 对象原样回传（原 key/原正文冻结语义由服务端保证）。 */
  const resubmit = async (request: PersonalTaskCommandRequest) => {
    if (busy || surface.readonly) return;
    setBusy(true); setActionError('');
    try {
      const result = await gateway.createTaskCommand(taskId, request);
      if(result.data.sourceRejection)setActionError(`源端拒绝：${result.data.sourceRejection.code}`);
      removeMarker(request.requestKey);
      setMarkers(listMarkers(taskId));
      await invalidate();
    } catch (e) {
      setActionError(errText(e));
    } finally { setBusy(false); }
  };

  if (surface.kind === 'demo') return <Card title="运行控制"><p className="muted">示例数据不提供任务控制；控制请求与运行状态以真实 BFF 为准</p></Card>;
  if (control.isPending) return <Card title="运行控制"><Skeleton h={90} /></Card>;
  // 控制区自身失败只影响本卡：ErrorBanner+重试，不拖垮页面其他卡。
  if (control.isError) return <Card title="运行控制"><ErrorBanner error={control.error} onRetry={() => control.refetch()} /></Card>;
  if (!view) return <Card title="运行控制"><p className="muted">服务端尚未返回控制视图</p></Card>;

  const pendings = view.pendingRequests ?? [];
  const known = knownCommandKeys(view);
  // 本地有标记而服务端列表无此 requestKey → 提示人工核对，绝不自动重发。
  const unregistered = before === undefined && !busy
    ? markers.filter(m => !known.has(m.requestKey))
    : [];
  // 源端命令历史与 pendingRequests 按 commandId 去重（pending 优先展示本地视图）。
  const pendingIds = new Set(pendings.map(p => p.commandId));
  const sourceItems = (view.sourceCommands?.items ?? []).filter(r => !pendingIds.has(r.commandId));
  const nextBefore = view.sourceCommands?.nextBefore ?? null;

  return (
    <Card title="运行控制" sub="控制请求与任务状态分开：已受理≠已生效，以源端回执为准"
      right={view.observedAt ? <span className="muted" style={{ fontSize: 11.5 }}>观察于 {fmtIso(view.observedAt)}</span> : undefined}>
      {view.sourceError && (
        <p role="alert">控制视图读取失败：{view.sourceError.message}（{view.sourceError.code}，观察于 {fmtIso(view.sourceError.observedAt)}）</p>
      )}
      {notice && <p role="status">{notice}</p>}
      {unregistered.map(m => (
        <p key={m.requestKey} role="alert">
          上次提交可能未登记（requestKey 尾号 …{m.requestKey.slice(-4)}），请核对服务端列表
          {!surface.readonly && <>
            {'　'}<button className="ghost" disabled={busy} onClick={() => void reconcile(m.requestKey)}>核对结果</button>
            <button className="ghost" onClick={() => { removeMarker(m.requestKey); setMarkers(listMarkers(taskId)); }}>清除标记</button>
          </>}
        </p>
      ))}
      {!surface.readonly && intents.length > 0 && (
        <div className="row wrap" style={{ gap: 8 }}>
          {intents.includes('PAUSE') && (
            <button disabled={busy || typeof stateVersion !== 'number'}
              title={typeof stateVersion !== 'number' ? '源端尚未报告运行版本（stateVersion），无法携带期望版本' : undefined}
              onClick={() => void send('PAUSE')}>暂停</button>
          )}
          {intents.includes('RESUME') && (
            <button disabled={busy || typeof stateVersion !== 'number'}
              title={typeof stateVersion !== 'number' ? '源端尚未报告运行版本（stateVersion），无法携带期望版本' : undefined}
              onClick={() => void send('RESUME')}>继续</button>
          )}
          {intents.includes('STOP') && (
            <button disabled={busy} onClick={() => void send('STOP')}>停止</button>
          )}
        </div>
      )}
      {intents.length === 0 && (view.reasonCodes?.length ?? 0) > 0 && (
        <p className="muted">当前不可控制：{view.reasonCodes.map(c => CONTROL_REASON_LABEL[c] ?? c).join(' · ')}</p>
      )}
      {pendings.length > 0 && (
        <div className="col" style={{ gap: 6, marginTop: 8 }}>
          <div className="card-sub">已登记控制请求</div>
          {pendings.map(p => (
            <PendingRow key={p.commandId} item={p} busy={busy} readonly={surface.readonly}
              onReconcile={key => void reconcile(key)} onResubmit={req => void resubmit(req)} />
          ))}
        </div>
      )}
      {(view.recentRequests??[]).filter(p=>p.sourceRejection).map(p=><PendingRow key={p.commandId} item={p} busy={busy} readonly={true} onReconcile={key=>void reconcile(key)} onResubmit={req=>void resubmit(req)} />)}
      {sourceItems.length > 0 && (
        <div className="col" style={{ gap: 4, marginTop: 8 }}>
          <div className="card-sub">源端命令历史（含其他端发起）</div>
          {sourceItems.map(r => (
            <div key={r.commandId} className="row wrap" style={{ gap: 8, fontSize: 12 }}>
              <span>{INTENT_LABEL[r.intent] ?? r.intent}</span>
              <span className="muted">{receiptLabel(r)}{r.resultCode && r.phase !== 'REJECTED' ? ` · ${r.resultCode}` : ''}</span>
              <span className="muted">受理于 {fmtIso(r.acceptedAt)}</span>
              <span className="muted">{r.terminal ? '终态' : '未终结'}</span>
            </div>
          ))}
        </div>
      )}
      {(nextBefore || before !== undefined) && (
        <div className="row" style={{ gap: 8, marginTop: 8 }}>
          {before !== undefined && <button className="ghost" onClick={() => setBefore(undefined)}>回到最新</button>}
          {nextBefore && <button className="ghost" disabled={busy} onClick={() => setBefore(nextBefore)}>更早</button>}
        </div>
      )}
      {surface.readonly && <p className="muted" style={{ fontSize: 11.5 }}>只读视图——不提供可执行按钮</p>}
      {actionError && <p role="alert">{actionError}</p>}
    </Card>
  );
}
