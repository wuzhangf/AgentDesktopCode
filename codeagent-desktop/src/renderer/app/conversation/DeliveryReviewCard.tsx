import React, { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { unwrap, type DeliveryChangesLike, type DeliveryReviewLike } from '../queries';

/**
 * Delivery review card (review P0-02/P0-04, design §9).
 * The renderer only submits intent (approve / reject / apply / reconcile);
 * every state transition is owned by the Service.  UNKNOWN outcomes are
 * never retryable — the only legal continuation is reconcile, and the final
 * outcome always comes from server-side journal evidence.
 */

const ACTIVE_STATES = new Set(['QUEUED', 'APPLYING', 'RECONCILING', 'REBASING', 'VERIFYING']);

export function DeliveryReviewCard(props: { deliveryId: string }): React.JSX.Element {
  const deliveryId = props.deliveryId;
  const queryClient = useQueryClient();
  const [actionError, setActionError] = useState<string | null>(null);

  const deliveryQ = useQuery({
    queryKey: ['delivery-review', deliveryId],
    enabled: Boolean(deliveryId),
    refetchInterval: (query) => {
      const state = query.state.data ? String((query.state.data as DeliveryReviewLike).state ?? '') : '';
      return ACTIVE_STATES.has(state) || state === '' ? 3000 : false;
    },
    queryFn: async () =>
      unwrap(await window.codeAgentDesktop.getDelivery(deliveryId)) as DeliveryReviewLike
  });
  const changesQ = useQuery({
    queryKey: ['delivery-changes', deliveryId],
    enabled: Boolean(deliveryId),
    refetchInterval: () => deliveryQ.data && ACTIVE_STATES.has(String(deliveryQ.data.state ?? '')) ? 3000 : false,
    queryFn: async () =>
      unwrap(await window.codeAgentDesktop.getDeliveryChanges(deliveryId)) as DeliveryChangesLike
  });

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['delivery-review', deliveryId] });
    void queryClient.invalidateQueries({ queryKey: ['delivery-changes', deliveryId] });
    void queryClient.invalidateQueries({ queryKey: ['sessions'] });
    void queryClient.invalidateQueries({ queryKey: ['runs'] });
  };

  const decideM = useMutation({
    mutationFn: async (input: { decision: 'APPROVE' | 'REJECT'; stateVersion: number }) =>
      unwrap(await window.codeAgentDesktop.decideDelivery(
        deliveryId,
        // The contract requires approvalFingerprint, but it is computed by the
        // Service during decide; a blank value binds nothing (server skips it).
        { decision: input.decision, expectedStateVersion: input.stateVersion, approvalFingerprint: '' }
      )),
    onSuccess: () => { setActionError(null); refresh(); },
    onError: (error) => {
      setActionError(error instanceof Error ? error.message : String(error));
      refresh();
    }
  });
  const applyM = useMutation({
    mutationFn: async (input: { stateVersion: number; approvalFingerprint: string }) =>
      unwrap(await window.codeAgentDesktop.applyDelivery(
        deliveryId,
        { expectedStateVersion: input.stateVersion, approvalFingerprint: input.approvalFingerprint }
      )),
    onSuccess: () => { setActionError(null); refresh(); },
    onError: (error) => {
      setActionError(error instanceof Error ? error.message : String(error));
      refresh();
    }
  });
  const reconcileM = useMutation({
    mutationFn: async (input: { stateVersion: number }) =>
      unwrap(await window.codeAgentDesktop.reconcileDelivery(
        deliveryId,
        { expectedStateVersion: input.stateVersion }
      )),
    onSuccess: () => { setActionError(null); refresh(); },
    onError: (error) => setActionError(error instanceof Error ? error.message : String(error))
  });
  const rebaseM = useMutation({
    mutationFn: async (input: { stateVersion: number }) =>
      unwrap(await window.codeAgentDesktop.rebaseDelivery(
        deliveryId,
        { expectedStateVersion: input.stateVersion }
      )),
    onSuccess: () => { setActionError(null); refresh(); },
    onError: (error) => setActionError(error instanceof Error ? error.message : String(error))
  });

  if (deliveryQ.isLoading) {
    return (
      <div className="delivery-review-card" data-testid="delivery-review">
        <span className="delivery-review-state">Delivery 加载中…</span>
      </div>
    );
  }
  if (deliveryQ.isError || !deliveryQ.data) {
    const message = deliveryQ.error instanceof Error ? deliveryQ.error.message : 'Delivery 不可读';
    return (
      <div className="delivery-review-card is-uncertain" data-testid="delivery-review">
        <span className="delivery-review-state">Delivery {deliveryId}</span>
        <span className="delivery-review-error">{message}</span>
      </div>
    );
  }

  const delivery = deliveryQ.data;
  const state = String(delivery.state ?? 'UNKNOWN');
  const stateVersion = Number(delivery.stateVersion ?? 0);
  const applied = state === 'APPLIED' || state === 'VERIFIED';
  const busy = state === 'QUEUED' || state === 'APPLYING' || state === 'VERIFYING'
    || state === 'RECONCILING' || state === 'REBASING';
  const uncertain = state === 'UNKNOWN' || state === 'NEEDS_ATTENTION' || state === 'FAILED';
  const canDecide = state === 'READY_FOR_REVIEW' && !decideM.isPending;
  const canApply = state === 'APPROVED' && changesQ.data?.canApply !== false && !applyM.isPending;
  const canReconcile = (state === 'UNKNOWN' || state === 'FAILED' || state === 'NEEDS_ATTENTION'
    || state === 'CONFLICT') && !reconcileM.isPending;
  // §6.6/§6.7: CONFLICT 是"待解决的挂起交付"，出口是 rebase 而非丢弃；
  // NEEDS_ATTENTION 允许在冲突全部处理后再次 rebase。
  const canRebase = (state === 'CONFLICT' || state === 'NEEDS_ATTENTION')
    && !rebaseM.isPending
    && typeof window.codeAgentDesktop.rebaseDelivery === 'function';

  const decide = (decision: 'APPROVE' | 'REJECT') => {
    if (!Number.isFinite(stateVersion) || stateVersion <= 0) {
      setActionError('Delivery 状态版本不可用；请刷新后再试。');
      return;
    }
    decideM.mutate({ decision, stateVersion });
  };
  const apply = () => {
    if (!Number.isFinite(stateVersion) || stateVersion <= 0) {
      setActionError('Delivery 状态版本不可用；请刷新后再试。');
      return;
    }
    if (!delivery.approvalFingerprint) {
      setActionError('缺少服务端批准指纹；请刷新后再试。');
      return;
    }
    applyM.mutate({ stateVersion, approvalFingerprint: delivery.approvalFingerprint });
  };
  const reconcile = () => {
    if (!Number.isFinite(stateVersion) || stateVersion <= 0) {
      setActionError('Delivery 状态版本不可用；请刷新后再试。');
      return;
    }
    reconcileM.mutate({ stateVersion });
  };
  const rebase = () => {
    if (!Number.isFinite(stateVersion) || stateVersion <= 0) {
      setActionError('Delivery 状态版本不可用；请刷新后再试。');
      return;
    }
    rebaseM.mutate({ stateVersion });
  };
  const openConflicts = () => {
    const summary = document.querySelector<HTMLButtonElement>(
      '[data-testid="conflict-summary"]');
    if (summary) summary.click();
    document.querySelector('[data-testid="workspace-conflicts"]')
      ?.scrollIntoView({ block: 'nearest' });
  };
  const changes = changesQ.data;

  return (
    <div
      className={`delivery-review-card ${applied ? 'is-applied' : ''} ${uncertain ? 'is-uncertain' : ''}`}
      data-testid="delivery-review"
      data-delivery-state={state}
    >
      <div className="delivery-review-row">
        <span className="session-binding-label">Delivery 集成审查</span>
        <span className="delivery-review-state">{state}</span>
      </div>
      <div className="delivery-review-row">
        {delivery.changeSetFingerprint ? (
          <span className="session-binding-meta" title="服务端生成的候选指纹">
            fingerprint {delivery.changeSetFingerprint.slice(0, 16)}…
          </span>
        ) : null}
        {delivery.baseRevision ? <span className="session-binding-meta">base {delivery.baseRevision}</span> : null}
        {delivery.targetPolicy ? <span className="session-binding-meta">policy {delivery.targetPolicy}</span> : null}
        {changes?.targetLabel ? <span className="session-binding-meta">目标 {changes.targetLabel}</span> : null}
        {changes?.targetFingerprint ? <span className="session-binding-meta" title="当前目标内容指纹">target {changes.targetFingerprint.slice(0, 16)}…</span> : null}
        {delivery.targetAfterOid ? (
          <span className="session-binding-meta" title="集成后的目标树指纹">
            target {delivery.targetAfterOid.slice(0, 16)}…
          </span>
        ) : null}
      </div>
      {delivery.conflictSummary ? (
        <div className="delivery-review-row">
          <span className="delivery-review-error" data-testid="delivery-conflict">{delivery.conflictSummary}</span>
        </div>
      ) : null}
      {changesQ.isError ? (
        <div className="delivery-review-row">
          <span className="delivery-review-error">实际文件差异暂不可读，请刷新重试。</span>
        </div>
      ) : changes ? (
        <div className="delivery-review-diff" data-testid="delivery-diff">
          {changes.files?.length ? changes.files.map((file) => (
            <details className="delivery-review-file" key={file.path}>
              <summary><span>{file.changeType}</span> {file.path}{changes.conflictPaths?.includes(file.path) ? ' · 目标已变更' : ''}</summary>
              <div className="delivery-review-file-panes">
                <pre className="delivery-review-pane before">{file.beforeText ?? (file.changeType === 'CREATE' ? '（新增文件）' : '（原内容不可读，仅显示指纹）')}</pre>
                <pre className="delivery-review-pane after">{file.afterText ?? (file.changeType === 'DELETE' ? '（删除文件）' : '（新内容不可读，仅显示指纹）')}</pre>
              </div>
            </details>
          )) : <span className="session-binding-meta">没有待采用修改。</span>}
          {/* §6.7: 成功态不渲染 conflictPaths —— 它们是"应用前基线冲突",
              与"应用后漂移"区分；后者由 conflictSummary 描述。 */}
          {!applied && changes.conflictPaths?.length ? <span className="delivery-review-error">请先刷新或处理这些目标路径：{changes.conflictPaths.join('、')}</span> : null}
        </div>
      ) : null}
      {uncertain ? (
        <div className="delivery-review-row">
          <span className="session-binding-warning">
            {state === 'UNKNOWN'
              ? '结果未知：可能已部分写入或尚未写入；UNKNOWN 不会自动重试，只能对账。'
              : '集成未完成：请对账后重试。'}
          </span>
        </div>
      ) : null}
      <div className="delivery-review-actions" role="group" aria-label="交付审查动作">
        {(state === 'READY_FOR_REVIEW' || state === 'APPROVED') ? (
          <button type="button" className="secondary-button" data-testid="delivery-refresh"
            onClick={refresh}>刷新预览</button>
        ) : null}
        {canDecide ? (
          <>
            <button type="button" className="secondary-button" data-testid="delivery-approve"
              disabled={changesQ.isLoading || changes?.canApply === false}
              onClick={() => decide('APPROVE')}>{changes?.canApply === false ? '目标有冲突' : '批准集成'}</button>
            <button type="button" className="secondary-button" data-testid="delivery-reject"
              onClick={() => decide('REJECT')}>拒绝</button>
          </>
        ) : null}
        {canApply ? (
          <button type="button" className="secondary-button" data-testid="delivery-apply"
            onClick={apply}>应用到集成目标</button>
        ) : null}
        {canRebase ? (
          <>
            <button type="button" className="secondary-button" data-testid="delivery-rebase"
              onClick={rebase}>重新基线</button>
            <button type="button" className="secondary-button" data-testid="delivery-resolve-conflicts"
              onClick={openConflicts}>解决冲突</button>
          </>
        ) : null}
        {canReconcile ? (
          <button type="button" className="secondary-button" data-testid="delivery-reconcile"
            onClick={reconcile}>对账</button>
        ) : null}
        {busy ? <span className="session-binding-meta">Service 正在处理；等待权威状态…</span> : null}
        {applied ? <span className="session-binding-meta">集成完成，以 Service 记录为准。</span> : null}
        {state === 'REJECTED' ? <span className="session-binding-meta">已拒绝；可在 lane 中继续迭代。</span> : null}
      </div>
      {actionError ? <span className="delivery-review-error" role="alert">{actionError}</span> : null}
    </div>
  );
}
