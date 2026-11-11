import { useEffect, useMemo, useState } from 'react';
import { collectExportMessages, buildExportDocument, exportExtension, serialize, type ExportActivities, type ExportFormat, type ExportMessage, type HistoryChannel } from './conversationExport';
import type { SessionLike, RunLike } from '../queries';
import { PanelHeader } from '../ui/PanelShell';

interface ExportDrawerProps {
  session: SessionLike;
  channel: HistoryChannel;
  runs: RunLike[];
  onClose: () => void;
}

const formats: Array<{ value: ExportFormat; label: string }> = [
  { value: 'markdown', label: 'Markdown（推荐）' },
  { value: 'txt', label: 'TXT 纯文本' },
  { value: 'json', label: 'JSON 数据' },
  { value: 'csv', label: 'CSV 表格' },
  { value: 'html', label: 'HTML 网页' },
  { value: 'pdf', label: 'PDF 文档' }
];

function shortPreview(value: string): string {
  const trimmed = value.trim().replace(/\s+/g, ' ');
  return trimmed.length > 90 ? `${trimmed.slice(0, 90)}…` : trimmed || '（空消息）';
}

function errorText(error: unknown): string {
  if (!(error instanceof Error)) return '导出失败，请重试。';
  if (error.message.includes('HISTORY_REVISION_CHANGED') || error.message.includes('EXPORT_SOURCE_CHANGED')) return '会话内容在读取期间发生变化，请重新导出。';
  if (error.message.includes('HISTORY_CONTENT_TOO_LARGE') || error.message.includes('EXPORT_LIMIT_EXCEEDED')) return '会话内容超过导出上限，请减少消息范围后重试。';
  return error.message || '导出失败，请重试。';
}

export function ExportDrawer({ session, channel, runs, onClose }: ExportDrawerProps): React.JSX.Element {
  const [messages, setMessages] = useState<ExportMessage[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [format, setFormat] = useState<ExportFormat>('markdown');
  const [activities, setActivities] = useState<ExportActivities>('NONE');
  const [includeSessionMetadata, setIncludeSessionMetadata] = useState(true);
  const [includeTimestamps, setIncludeTimestamps] = useState(true);
  const [redactRecognizedSecrets, setRedactRecognizedSecrets] = useState(true);
  const [loading, setLoading] = useState(true);
  const [progress, setProgress] = useState({ completed: 0, total: 0 });
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedPath, setSavedPath] = useState<string | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setSavedPath(null);
    void collectExportMessages(session.sessionId, channel, session, (next) => {
      if (!cancelled && next.phase === 'content') setProgress({ completed: next.completed, total: next.total });
    }).then((result) => {
      if (cancelled) return;
      setMessages(result.messages);
      setSelectedIds(new Set(result.messages.map((message) => message.id)));
      setLoading(false);
    }).catch((cause: unknown) => {
      if (cancelled) return;
      setLoading(false);
      setError(errorText(cause));
    });
    return () => { cancelled = true; };
  }, [channel, retryNonce, session.sessionId]);

  const selectedMessages = useMemo(() => messages.filter((message) => selectedIds.has(message.id)), [messages, selectedIds]);
  const selectedCount = selectedMessages.length;
  const runsForExport = useMemo(() => {
    if (activities === 'NONE') return [];
    const ids = new Set(selectedMessages.map((message) => message.runId).filter((id): id is string => Boolean(id)));
    return runs.filter((run) => ids.has(run.runId)).map((run) => ({
      runId: run.runId,
      taskId: run.taskId ?? null,
      state: run.state,
      messageIds: selectedMessages.filter((message) => message.runId === run.runId).map((message) => message.id)
    }));
  }, [activities, runs, selectedMessages]);

  function selectMode(mode: 'ALL' | 'USER' | 'ASSISTANT' | 'NONE' | 'INVERT'): void {
    setSelectedIds((current) => {
      if (mode === 'ALL') return new Set(messages.map((message) => message.id));
      if (mode === 'NONE') return new Set();
      if (mode === 'INVERT') return new Set(messages.filter((message) => !current.has(message.id)).map((message) => message.id));
      return new Set(messages.filter((message) => message.role === mode.toLowerCase()).map((message) => message.id));
    });
  }

  async function save(): Promise<void> {
    if (selectedCount === 0 || loading || saving) return;
    setSaving(true);
    setError(null);
    try {
      const result = await collectExportMessages(session.sessionId, channel, session);
      const selected = result.messages.filter((message) => selectedIds.has(message.id));
      const doc = buildExportDocument(session, selected, {
        format, activities, includeSessionMetadata, includeTimestamps, redactRecognizedSecrets
      }, {
        transcriptRevision: result.transcriptRevision,
        verified: result.verified,
        capturedAt: new Date().toISOString(),
        runs: runsForExport
      });
      const content = serialize(doc);
      const title = (session.title?.trim() || '未命名会话').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').slice(0, 70) || 'conversation';
      const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '');
      const suggestedName = `${title}_${stamp}_${session.sessionId.slice(0, 8)}`;
      const saved = await window.codeAgentDesktop.saveConversationExport({ suggestedName, format, content });
      if ('error' in saved) throw new Error(saved.error);
      if (!saved.canceled) setSavedPath(saved.filePath ?? null);
    } catch (cause: unknown) {
      setError(errorText(cause));
    } finally {
      setSaving(false);
    }
  }

  return <aside className="conversation-export-drawer" data-testid="conversation-export-drawer" role="dialog" aria-modal="false" aria-labelledby="conversation-export-title">
    <PanelHeader
      title="导出会话"
      titleId="conversation-export-title"
      subtitle={session.title ?? '未命名会话'}
      closeLabel="关闭导出面板"
      onClose={onClose}
    />
    <div className="export-drawer-body">
      {loading ? <div className="export-loading" role="status">正在整理完整会话…{progress.total > 0 ? ` ${progress.completed}/${progress.total}` : ''}</div> : null}
      {error ? <div className="export-error" role="alert">{error}<button type="button" className="secondary-button small" onClick={() => { setError(null); setLoading(true); setRetryNonce((value) => value + 1); }}>刷新重试</button></div> : null}
      {!loading && !error ? <>
        <div className="export-selection-toolbar" aria-label="消息选择">
          <button type="button" className="toolbar-button" onClick={() => selectMode('ALL')}>全部</button>
          <button type="button" className="toolbar-button" onClick={() => selectMode('USER')}>仅提问</button>
          <button type="button" className="toolbar-button" onClick={() => selectMode('ASSISTANT')}>仅回答</button>
          <button type="button" className="toolbar-button" onClick={() => selectMode('NONE')}>清空</button>
          <button type="button" className="toolbar-button" onClick={() => selectMode('INVERT')}>反选</button>
        </div>
        <div className="export-message-list">
          {messages.map((message) => <label className="export-message-row" key={message.id}>
            <input type="checkbox" checked={selectedIds.has(message.id)} onChange={() => setSelectedIds((current) => { const next = new Set(current); if (next.has(message.id)) next.delete(message.id); else next.add(message.id); return next; })} />
            <span className={`export-role ${message.role}`}>{message.role === 'user' ? '问' : '答'}</span>
            <span className="export-message-copy"><strong>{shortPreview(message.content)}</strong><small>{includeTimestamps ? (message.createdAt ? new Date(message.createdAt).toLocaleString() : '时间未知') : ''}{message.attachments.length ? ` · 附件 ${message.attachments.length}` : ''}</small></span>
          </label>)}
          {messages.length === 0 ? <p className="empty">暂无可导出的公开消息。</p> : null}
        </div>
        <div className="export-selected-count">已选 {selectedCount} / {messages.length} 条问答消息</div>
        <div className="export-options">
          <label><span>格式</span><select value={format} onChange={(event) => setFormat(event.target.value as ExportFormat)}>{formats.map((item) => <option value={item.value} key={item.value}>{item.label}</option>)}</select></label>
          <label><span>执行过程</span><select value={activities} onChange={(event) => setActivities(event.target.value as ExportActivities)}><option value="NONE">不包含</option><option value="SUMMARY">执行摘要</option></select></label>
          <label className="export-check"><input type="checkbox" checked={includeTimestamps} onChange={(event) => setIncludeTimestamps(event.target.checked)} />显示时间</label>
          <label className="export-check"><input type="checkbox" checked={includeSessionMetadata} onChange={(event) => setIncludeSessionMetadata(event.target.checked)} />包含会话信息</label>
          <label className="export-check"><input type="checkbox" checked={redactRecognizedSecrets} onChange={(event) => setRedactRecognizedSecrets(event.target.checked)} />隐藏已识别的凭证</label>
        </div>
        <div className="export-preview"><div className="export-preview-heading">预览 · {format.toUpperCase()}</div>{selectedMessages.slice(0, 3).map((message) => <div className="export-preview-item" key={message.id}><strong>{message.role === 'user' ? '用户' : '助手'}</strong><pre>{message.content || '（空消息）'}</pre></div>)}{selectedCount > 3 ? <span className="run-meta">预览显示前 3 条，最终文件包含 {selectedCount} 条。</span> : null}</div>
      </> : null}
    </div>
    <footer className="export-drawer-footer">
      {savedPath ? <span className="export-success" role="status">已保存：{savedPath}</span> : <span className="run-meta">附件仅导出清单，不包含原文件。{activities === 'SUMMARY' ? `已关联 ${runsForExport.length} 个运行。` : ''}</span>}
      <div><button type="button" className="secondary-button" onClick={onClose}>取消</button><button type="button" className="primary-button" disabled={loading || saving || selectedCount === 0} onClick={() => { void save(); }}>{saving ? '正在导出…' : `导出 ${format === 'pdf' ? 'PDF' : exportExtension(format).toUpperCase()}`}</button></div>
    </footer>
  </aside>;
}
