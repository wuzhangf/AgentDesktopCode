// PAE P6 — 环境操作视图：状态、进度、有界事件页、取消、原操作恢复。
// 任一 operationId 直达（总览待处理 / 项目环境页未决登记共用）。
// UNKNOWN 与 NEEDS_INPUT 保持可见：UNKNOWN 慢轮询核对；NEEDS_INPUT 的续接
// 命令路由尚未冻结（P0 §5.5 交接缺口），本视图只显示状态不伪造输入表单。
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { AlertCircle, ChevronLeft, ChevronRight, RefreshCw } from 'lucide-react';
import { Badge, Card, EmptyState, ErrorBanner, KV, Skeleton } from '../../components/ui/primitives';
import { usePersonal, usePersonalGateway, usePersonalSurface } from '../hooks';
import { decimalRevision, fmtIso, operationPollInterval, supports } from '../viewmodel';
import { operationStateLabel, operationStateTone, reasonAdvice, reasonLabel } from '../labels';
import { PersonalClientError } from '../client';

export function OperationView({ operationId, onChanged }: { operationId: string; onChanged?: () => void }) {
  const surface = usePersonalSurface();
  const gateway = usePersonalGateway();
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState('');
  // 事件游标栈：nextCursor 不透明，只能前进/后退已翻过的页。
  const [cursorStack, setCursorStack] = useState<(string | undefined)[]>([undefined]);
  const cursor = cursorStack[cursorStack.length - 1];

  const op = usePersonal(['environmentOperation', operationId],
    g => g.getEnvironmentOperation(operationId),
    { refetchInterval: q => operationPollInterval(q.state.data?.data.state) });
  const events = usePersonal(['environmentOperationEvents', operationId, cursor ?? ''],
    g => g.getEnvironmentOperationEvents(operationId, { cursor, limit: 50 }));

  const data = op.data?.data;
  const meta = op.data?.meta;
  const canCancel = !surface.readonly && supports(meta, 'OPERATION_CANCEL')
    && (data?.state === 'QUEUED' || data?.state === 'RUNNING' || data?.state === 'UNKNOWN');

  const cancel = async () => {
    if (busy || !data) return;
    setBusy(true); setActionError('');
    try {
      await gateway.cancelEnvironmentOperation(operationId, { expectedRevision: decimalRevision(data.revision) });
      await qc.invalidateQueries({ queryKey: ['personal'] });
      onChanged?.();
    } catch (e) {
      const err = e as PersonalClientError;
      // 409/版本冲突类：不重复提交，提示刷新重读（§11.3 过期修改返回版本冲突并刷新）。
      setActionError(err.code?.includes('CONFLICT')
        ? '数据已被更新，正在刷新视图——请按最新状态再决定。'
        : err.message || '取消未确认，请稍后按原操作核对');
      await op.refetch();
    } finally { setBusy(false); }
  };

  if (op.isPending) return <Skeleton h={140} />;
  if (op.isError) return <ErrorBanner error={op.error} onRetry={() => op.refetch()} />;
  if (!data) return null;

  return (
    <Card title={<>原操作 · <span className="mono">{operationId}</span></>}
      sub={`按原 requestKey/operationId 核对；重复提交不会重放`}
      right={<button className="ghost" onClick={() => { void op.refetch(); void events.refetch(); }} aria-label="刷新"><RefreshCw size={14} /></button>}>
      <div className="row wrap" style={{ marginBottom: 8 }}>
        <Badge tone={operationStateTone(data.state)}>{operationStateLabel(data.state)}</Badge>
        <span className="muted" style={{ fontSize: 12 }}>{data.kind}</span>
        {data.projectId && <span className="muted" style={{ fontSize: 12 }}>项目 {data.projectId}</span>}
        <span className="muted right" style={{ fontSize: 11.5 }}>更新于 {fmtIso(data.updatedAt)}</span>
      </div>
      {typeof data.progress === 'number' && (
        <div className="p6-progress" role="progressbar" aria-valuenow={Math.round(data.progress * 100)} aria-valuemin={0} aria-valuemax={100}>
          <i style={{ width: `${Math.max(0, Math.min(1, data.progress)) * 100}%` }} />
        </div>
      )}
      {data.progress == null && (data.state === 'QUEUED' || data.state === 'RUNNING') && (
        <div className="muted" style={{ fontSize: 12 }}>进度未知——以事件流为准。</div>
      )}
      {data.state === 'UNKNOWN' && (
        <div className="banner info" role="status">
          <AlertCircle size={15} aria-hidden />
          <div className="grow">上次操作效果未能确认。本视图按原 key 周期性核对，不要重复提交新操作。</div>
        </div>
      )}
      {data.state === 'NEEDS_INPUT' && (
        <div className="banner" role="status">
          <AlertCircle size={15} aria-hidden />
          <div className="grow">操作等待你补充信息。个人通道的续接命令路由尚未冻结（见交接缺口），当前仅显示状态，不代为提交。</div>
        </div>
      )}
      {data.reasonCode && (
        <div className="banner error" role="status">
          <AlertCircle size={15} aria-hidden />
          <div className="grow"><b>{reasonLabel(data.reasonCode)}</b>：{reasonAdvice(data.reasonCode)}</div>
        </div>
      )}
      <div className="col" style={{ gap: 6, marginTop: 8 }}>
        <div className="card-sub">事件</div>
        {events.isPending && <Skeleton h={60} />}
        {events.isError && <ErrorBanner error={events.error} onRetry={() => events.refetch()} />}
        {events.data && events.data.data.events.length === 0 && <EmptyState title="暂无事件" />}
        {events.data && events.data.data.events.length > 0 && (
          <div className="p6-events">
            {events.data.data.events.map(e => (
              <article key={e.eventId ?? `${e.occurredAt}-${e.message}`}>
                <span className="muted nowrap" style={{ fontSize: 11 }}>{fmtIso(e.occurredAt)}</span>
                <Badge tone={operationStateTone(e.state)}>{operationStateLabel(e.state)}</Badge>
                <span style={{ fontSize: 12, overflowWrap: 'anywhere' }}>{e.message}</span>
              </article>
            ))}
          </div>
        )}
        <div className="row" style={{ justifyContent: 'flex-end', gap: 4 }}>
          <button className="ghost" disabled={cursorStack.length <= 1}
            onClick={() => setCursorStack(s => s.slice(0, -1))} aria-label="上一页"><ChevronLeft size={15} /></button>
          <button className="ghost" disabled={!events.data?.data.nextCursor}
            onClick={() => { const next = events.data?.data.nextCursor; if (next) setCursorStack(s => [...s, next]); }}
            aria-label="下一页"><ChevronRight size={15} /></button>
        </div>
      </div>
      <KV items={[
        ['requestKey', <span className="mono" key="k">{data.requestKey ?? '—'}</span>],
        ['environmentId', <span className="mono" key="e">{data.environmentId ?? '—'}</span>],
        ['revision', data.revision ?? '—'],
        ['resultRef', <span className="mono" key="r">{data.resultRef ?? '—'}</span>],
      ]} />
      <div className="row" style={{ marginTop: 10 }}>
        {canCancel && <button disabled={busy} onClick={() => void cancel()}>取消操作（仅停止本操作登记的资源）</button>}
        {surface.readonly && <span className="muted" style={{ fontSize: 11.5 }}>只读视图——不提供可执行按钮</span>}
      </div>
      {actionError && <p role="alert" style={{ color: 'var(--failure)', fontSize: 12 }}>{actionError}</p>}
    </Card>
  );
}
