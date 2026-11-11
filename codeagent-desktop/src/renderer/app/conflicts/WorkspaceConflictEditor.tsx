import React, { useEffect, useMemo, useState } from 'react';
import {
  readWorkspaceContentText,
  useDismissWorkspaceConflict,
  useRequestWorkspaceConflictProposal,
  useResolveWorkspaceConflict,
  useWorkspaceConflictAutoMerge,
  useWorkspaceConflictProposal,
  type WorkspaceConflictLike
} from '../queries';

type Pane = 'BASE' | 'CURRENT' | 'PROPOSED' | 'MERGED';

const PANES: Array<{ id: Pane; label: string }> = [
  { id: 'BASE', label: '读取时版本 B' },
  { id: 'CURRENT', label: '当前文件 C' },
  { id: 'PROPOSED', label: '本次拟写入 A' },
  { id: 'MERGED', label: '合并结果' }
];

const MERGEABLE_ACTIONS = new Set(['MERGED_CONTENT', 'AUTO_MERGED', 'REQUEST_PROPOSAL']);

/**
 * Unified conflict editor (design §6.7): four panes over B/C/A/merged,
 * server-owned actions only.  The merged pane seeds from the auto-merge
 * preview (CLEAN) or the current file (OVERLAPPING); nothing is written
 * until the user applies a resolution, and every apply is CAS-guarded by
 * the current file version.
 */
export function WorkspaceConflictEditor(props: {
  conflict: WorkspaceConflictLike;
  onResolved?: () => void;
}): React.JSX.Element {
  const conflict = props.conflict;
  const [pane, setPane] = useState<Pane>('CURRENT');
  const [draft, setDraft] = useState<string | null>(null);
  const [baseText, setBaseText] = useState<string | null>(null);
  const [previewText, setPreviewText] = useState<string | null>(null);
  const [proposalId, setProposalId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [staleNotice, setStaleNotice] = useState(false);

  const resolve = useResolveWorkspaceConflict();
  const dismiss = useDismissWorkspaceConflict();
  const autoMerge = useWorkspaceConflictAutoMerge();
  const requestProposal = useRequestWorkspaceConflictProposal();
  const proposalQ = useWorkspaceConflictProposal(conflict.conflictId, proposalId);

  const allowed = new Set(conflict.allowedActions ?? [
    'KEEP_CURRENT', 'USE_PROPOSED', 'MERGED_CONTENT', 'AUTO_MERGED', 'DISMISS']);
  const mergeable = [...MERGEABLE_ACTIONS].some((action) => allowed.has(action));
  const autoMergeClean = conflict.autoMerge?.status === 'CLEAN';
  const autoMergeStatus = conflict.autoMerge?.status ?? 'NOT_ATTEMPTED';
  const busy = resolve.isPending || dismiss.isPending || autoMerge.isPending
    || requestProposal.isPending;

  // Lazy base content through the workspace-contents endpoint; a missing
  // base is honest ("无基线") rather than fabricated.
  useEffect(() => {
    setBaseText(null);
    setPreviewText(null);
    setDraft(null);
    setProposalId(null);
    setStaleNotice(conflict.state === 'STALE');
    setPane('CURRENT');
  }, [conflict.conflictId]);

  useEffect(() => {
    const ref = conflict.baseContentRef ?? conflict.base?.ref;
    if (pane !== 'BASE' || baseText !== null || !ref) return;
    let cancelled = false;
    void readWorkspaceContentText(ref)
      .then((out) => { if (!cancelled) setBaseText(out.text); })
      .catch(() => { if (!cancelled) setBaseText(null); });
    return () => { cancelled = true; };
  }, [pane, baseText, conflict.baseContentRef, conflict.base]);

  useEffect(() => {
    const ref = conflict.autoMerge?.previewRef;
    if (ref && previewText === null) {
      let cancelled = false;
      void readWorkspaceContentText(ref)
        .then((out) => { if (!cancelled) setPreviewText(out.text); })
        .catch(() => { if (!cancelled) setPreviewText(null); });
      return () => { cancelled = true; };
    }
    return;
  }, [conflict.autoMerge?.previewRef, previewText]);

  // AI proposal lands in the merged draft without touching the file.
  useEffect(() => {
    const proposal = proposalQ.data;
    if (!proposal || proposal.status !== 'READY' || !proposal.proposalRef) return;
    void readWorkspaceContentText(proposal.proposalRef)
      .then((out) => setDraft(out.text))
      .catch(() => setActionError('AI 提案内容暂不可读'));
  }, [proposalQ.data]);

  const mergedInitial = useMemo(() => {
    if (previewText !== null) return previewText;
    return conflict.currentContent ?? '';
  }, [previewText, conflict.currentContent]);

  const effectiveDraft = draft ?? mergedInitial;

  const expectHash = conflict.actualVersion ?? conflict.current?.version ?? null;

  const applyChoice = (choice: 'KEEP_CURRENT' | 'USE_PROPOSED' | 'AUTO_MERGED') => {
    setActionError(null);
    resolve.mutate({
      conflictId: conflict.conflictId,
      body: {
        expectedStateVersion: conflict.stateVersion,
        expectedCurrentHash: expectHash,
        choice
      }
    }, {
      onError: (error) => setActionError(staleAwareMessage(error)),
      onSuccess: () => props.onResolved?.()
    });
  };

  const applyMerged = () => {
    if (effectiveDraft.length === 0) {
      setActionError('合并结果为空；请编辑后再应用。');
      return;
    }
    setActionError(null);
    resolve.mutate({
      conflictId: conflict.conflictId,
      body: {
        expectedStateVersion: conflict.stateVersion,
        expectedCurrentHash: expectHash,
        choice: 'MERGED_CONTENT',
        resolutionContent: effectiveDraft
      }
    }, {
      onError: (error) => setActionError(staleAwareMessage(error)),
      onSuccess: () => props.onResolved?.()
    });
  };

  const paneContent = (): { text: string | null; note: string | null } => {
    if (pane === 'BASE') {
      if (!conflict.baseContentRef && !conflict.base?.ref) {
        return { text: null, note: '无基线：该冲突未记录读取时版本。' };
      }
      return { text: baseText, note: baseText === null ? '基线内容读取中…' : null };
    }
    if (pane === 'CURRENT') {
      return {
        text: conflict.currentContent ?? null,
        note: conflict.limits?.previewTruncated ? '预览已截断；完整内容经 blob 引用读取。' : null
      };
    }
    if (pane === 'PROPOSED') {
      return {
        text: conflict.proposedContent ?? null,
        note: conflict.proposedContent == null
          ? '无拟写入内容：该冲突未保留提案正文。'
          : (conflict.limits?.previewTruncated ? '预览已截断；完整内容经 blob 引用读取。' : null)
      };
    }
    return { text: effectiveDraft, note: null };
  };

  const { text: paneText, note: paneNote } = paneContent();

  return (
    <section className="workspace-conflict-editor" data-testid="conflict-editor"
      data-conflict-id={conflict.conflictId} data-conflict-state={conflict.state}>
      <header className="workspace-conflict-editor-head">
        <code className="workspace-conflict-path">{conflict.path}</code>
        <span className="run-meta">{conflict.kind ?? 'CAS_CONFLICT'} · {conflict.state}</span>
        {conflict.origin ? <span className="run-meta">origin {conflict.origin}</span> : null}
      </header>
      {staleNotice || conflict.state === 'STALE' ? (
        <div className="workspace-conflict-stale" role="status">
          文件再次更新，请重新合并；你的编辑草稿已保留。
        </div>
      ) : null}
      <div className="workspace-conflict-panes" role="tablist" aria-label="冲突版本">
        {PANES.map((item) => (
          <button key={item.id} type="button" role="tab"
            aria-selected={pane === item.id}
            className={`workspace-conflict-tab${pane === item.id ? ' selected' : ''}`}
            onClick={() => setPane(item.id)}>
            {item.label}
          </button>
        ))}
      </div>
      {paneNote ? <span className="run-meta">{paneNote}</span> : null}
      {pane === 'MERGED' ? (
        <textarea
          className="workspace-conflict-merged"
          aria-label={`合并结果 ${conflict.path}`}
          value={effectiveDraft}
          onChange={(event) => setDraft(event.target.value)}
          rows={14}
        />
      ) : (
        <pre className="workspace-conflict-view">{paneText ?? ''}</pre>
      )}
      {conflict.autoMerge ? (
        <div className="workspace-conflict-automerge">
          <span className="run-meta">
            自动合并：{autoMergeStatus}
            {conflict.autoMerge.reason ? ` · ${conflict.autoMerge.reason}` : ''}
          </span>
          {autoMergeStatus === 'OVERLAPPING' ? (
            <span className="run-meta">存在重叠改动，请人工合并。</span>
          ) : null}
        </div>
      ) : null}
      <div className="workspace-conflict-actions" role="group" aria-label="解决动作">
        <button type="button" className="secondary-button"
          data-testid="conflict-keep-current"
          disabled={busy || !allowed.has('KEEP_CURRENT')}
          onClick={() => applyChoice('KEEP_CURRENT')}>使用当前文件</button>
        <button type="button" className="secondary-button"
          data-testid="conflict-use-proposed"
          disabled={busy || !allowed.has('USE_PROPOSED')}
          onClick={() => applyChoice('USE_PROPOSED')}>使用本次内容</button>
        <button type="button" className="secondary-button"
          data-testid="conflict-auto-merge"
          disabled={busy || !autoMergeClean || !allowed.has('AUTO_MERGED')}
          title={autoMergeClean ? '应用服务端自动合并预览' : '自动合并不可用于该冲突'}
          onClick={() => applyChoice('AUTO_MERGED')}>自动合并</button>
        <button type="button" className="secondary-button"
          data-testid="conflict-ai-proposal"
          disabled={busy || !allowed.has('REQUEST_PROPOSAL')
            || (proposalId !== null && proposalQ.data?.status === 'PENDING')}
          onClick={() => {
            setActionError(null);
            requestProposal.mutate(conflict.conflictId, {
              onSuccess: (job) => setProposalId(job.proposalId),
              onError: (error) => setActionError(
                error instanceof Error ? error.message : 'AI 提案不可用')
            });
          }}>
          {proposalId !== null && proposalQ.data?.status === 'PENDING'
            ? 'AI 合并中…' : '让 AI 尝试合并'}
        </button>
        <button type="button" className="secondary-button"
          data-testid="conflict-apply-merged"
          disabled={busy || !mergeable}
          onClick={applyMerged}>应用解决结果</button>
        <button type="button" className="secondary-button"
          data-testid="conflict-dismiss"
          disabled={busy || !allowed.has('DISMISS')}
          onClick={() => {
            setActionError(null);
            dismiss.mutate(conflict.conflictId, {
              onError: (error) => setActionError(staleAwareMessage(error)),
              onSuccess: () => props.onResolved?.()
            });
          }}>放弃该修改</button>
      </div>
      {proposalQ.data?.status === 'FAILED' ? (
        <span className="workspace-conflict-error" role="alert">
          AI 合并失败{proposalQ.data.error ? `：${proposalQ.data.error}` : ''}
        </span>
      ) : null}
      {actionError ? (
        <span className="workspace-conflict-error" role="alert">{actionError}</span>
      ) : null}
    </section>
  );
}

/** 409 冲突提交 → 按 §6.7 提示重新合并；其他错误原样透出。 */
function staleAwareMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('WORKSPACE_VERSION_CHANGED')) {
    return '文件再次更新，请重新合并。';
  }
  return message;
}
