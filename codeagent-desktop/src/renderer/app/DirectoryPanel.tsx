import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { unwrap, type SessionDirectoryLike, type SessionLike } from './queries';
import { PanelShell } from './ui/PanelShell';

function normalize(value: string): string { return value.trim(); }

function pathKey(value: string): string {
  const normalized = normalize(value).replace(/\\/g, '/').replace(/\/+$/, '');
  return typeof navigator !== 'undefined' && /win/i.test(navigator.platform)
    ? normalized.toLowerCase() : normalized;
}

function pathWithin(child: string, parent: string): boolean {
  const c = pathKey(child);
  const p = pathKey(parent);
  return c === p || c.startsWith(`${p}/`);
}

function modeLabel(mode: string | null | undefined): string {
  if (mode === 'ALL') return '完全访问';
  if (mode === 'ROOTS') return '指定目录可写';
  return '只读';
}

function newId(): string {
  try { return `directory-${crypto.randomUUID()}`; }
  catch { return `directory-${Date.now()}-${Math.random().toString(36).slice(2)}`; }
}

export function DirectoryPanel(props: { session: SessionLike; onClose: () => void }): React.JSX.Element {
  const queryClient = useQueryClient();
  const session = props.session;
  const serverDirectories = useMemo<SessionDirectoryLike[]>(() => {
    if ((session.directoryPolicyVersion ?? 1) >= 2) return (session.directories ?? []).map((directory) => ({
      id: directory.id, path: directory.path, writeEnabled: Boolean(directory.writeEnabled)
    }));
    // Legacy sessions are upgraded only when the user explicitly saves.
    return (session.contextDirectories ?? []).map((path, index) => ({
      id: `legacy-${index + 1}`, path, writeEnabled: false
    }));
  }, [session.contextDirectories, session.directories, session.directoryPolicyVersion]);
  const [directories, setDirectories] = useState<SessionDirectoryLike[]>(serverDirectories);
  const [input, setInput] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingValue, setEditingValue] = useState('');
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { if (!dirty) setDirectories(serverDirectories); }, [dirty, serverDirectories]);

  const accessById = useMemo(() => new Map(
    (session.directoryAccess?.entries ?? []).map((entry) => [entry.id, entry])
  ), [session.directoryAccess?.entries]);

  const save = useMutation({
    mutationFn: async () => unwrap(await window.codeAgentDesktop.patchSession(session.sessionId, {
      expectedSessionVersion: session.sessionVersion, directoryPolicyVersion: 2,
      replaceLegacyDirectoryPolicy: (session.directoryPolicyVersion ?? 1) < 2,
      directories
    })) as SessionLike,
    onSuccess: (next) => {
      queryClient.setQueryData(['sessions', session.sessionId], next);
      void queryClient.invalidateQueries({ queryKey: ['sessions', session.sessionId] });
      void queryClient.invalidateQueries({ queryKey: ['sessions'] });
      void queryClient.invalidateQueries({ queryKey: ['sessionMetadata', session.sessionId] });
      setDirectories((next.directories ?? []).map((directory) => ({
        id: directory.id, path: directory.path, writeEnabled: Boolean(directory.writeEnabled)
      })));
      setDirty(false); setEditingId(null); setInput(''); setError(null);
    },
    onError: (reason) => {
      setError(reason instanceof Error ? reason.message : '目录保存失败，请刷新后重试。');
      if (/CONFLICT|VERSION|409|SESSION_CHANGED/i.test(String(reason))) {
        void queryClient.invalidateQueries({ queryKey: ['sessions', session.sessionId] });
      }
    }
  });

  const update = (next: SessionDirectoryLike[]): void => {
    setDirectories(next); setDirty(true); setError(null);
  };

  const add = (raw = input): void => {
    const path = normalize(raw);
    if (!path) return;
    if (directories.some((directory) => pathKey(directory.path) === pathKey(path))) {
      setError('目录路径已存在。'); return;
    }
    update([...directories, { id: newId(), path, writeEnabled: false }]); setInput('');
  };

  const choose = async (): Promise<void> => {
    try {
      if (typeof window.codeAgentDesktop.chooseDirectory !== 'function') return;
      const choice = unwrap(await window.codeAgentDesktop.chooseDirectory()) as { selected?: boolean; path?: string };
      if (choice.selected && choice.path) add(choice.path);
    } catch (reason) { setError(reason instanceof Error ? reason.message : '目录选择失败。'); }
  };

  const commitEdit = (id: string): void => {
    const path = normalize(editingValue);
    if (!path) { setError('目录路径不能为空。'); return; }
    if (directories.some((directory) => directory.id !== id && pathKey(directory.path) === pathKey(path))) {
      setError('目录路径已存在。'); return;
    }
    update(directories.map((directory) => directory.id === id ? { ...directory, path } : directory));
    setEditingId(null);
  };

  const cancel = (): void => {
    setDirectories(serverDirectories); setInput(''); setEditingId(null); setDirty(false); setError(null);
  };

  const savedMode = session.permissionMode === 'FULL_ACCESS'
    ? 'ALL' : session.directoryAccess?.savedWriteMode
      ?? (directories.some((directory) => directory.writeEnabled) ? 'ROOTS' : 'NONE');
  const legacyRules = (session.directoryPolicyVersion ?? 1) < 2
    && ((session.writeAllow?.length ?? 0) > 0 || (session.writeForbid?.length ?? 0) > 0);

  return <PanelShell
    title="目录"
    className="directory-panel"
    testId="directory-panel"
    ariaLabel="目录"
    closeLabel="关闭目录面板"
    onClose={props.onClose}
    footer={(
      <>
        <button type="button" className="secondary" onClick={cancel} disabled={!dirty || save.isPending}>取消</button>
        <button type="button" onClick={() => save.mutate()} disabled={!dirty || save.isPending}>{save.isPending ? '保存中…' : '保存'}</button>
      </>
    )}
  >
    <div className="directory-summary" data-testid="directory-summary">
      <div><span>工作区</span><strong>{session.workspaceAlias || '无（普通对话）'}</strong></div>
      <div><span>写入能力</span><strong>{modeLabel(savedMode)}</strong></div>
    </div>
    <p className="directory-help">每个目录单独决定是否可写。子目录不会覆盖已授权的父目录；只读目录仍会作为模型上下文保留。</p>
    {session.permissionMode === 'FULL_ACCESS' ? <p className="directory-help">完全访问已开启，目录编辑开关不限制写入。</p> : null}
    {!session.workspaceAlias && session.permissionMode !== 'FULL_ACCESS' ? <p className="directory-help">当前未加入工作区，目录仍可作为上下文保留；关闭完全访问时不会产生写入授权。</p> : null}
    {legacyRules ? <p className="directory-legacy-note" role="note">
      这是旧版会话。保存下方完整列表后，旧的写入规则将被替换；当前未转换规则：
      {[...(session.writeAllow ?? []), ...(session.writeForbid ?? [])].join('、')}
    </p> : null}
    <div className="directory-adder">
      <input value={input} onChange={(event) => setInput(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); add(); } }} placeholder="添加绝对路径" aria-label="添加目录路径" disabled={save.isPending} />
      <button type="button" className="directory-picker-button" onClick={() => void choose()} disabled={save.isPending}>选择</button>
      <button type="button" disabled={!input.trim() || save.isPending} onClick={() => add()}>添加</button>
    </div>
    {error ? <p className="directory-error" role="alert">{error}</p> : null}
    <ul className="directory-list">
      {directories.map((directory) => {
        const access = accessById.get(directory.id);
        const immutable = Boolean(access?.immutable || access?.reason === 'DEFAULT_WORKSPACE');
        const coveredBy = access?.coveredByDirectoryId
          ?? directories.find((candidate) => candidate.id !== directory.id
            && candidate.writeEnabled && pathWithin(directory.path, candidate.path))?.id;
        const effectiveWritable = session.permissionMode === 'FULL_ACCESS'
          || (Boolean(session.workspaceAlias) && (directory.writeEnabled || Boolean(coveredBy)));
        return <li key={directory.id} className="directory-list-item">
          <div className="directory-row-main">
            {editingId === directory.id
              ? <input className="directory-edit-input" value={editingValue} autoFocus aria-label={`修改目录 ${directory.path}`} onChange={(event) => setEditingValue(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); commitEdit(directory.id); } if (event.key === 'Escape') setEditingId(null); }} />
              : <code title={directory.path}>{directory.path}</code>}
            <span className={`directory-access-badge ${effectiveWritable ? 'is-writable' : 'is-read-only'}`}>
              {effectiveWritable ? (coveredBy ? '父目录覆盖' : '可写') : '只读'}
            </span>
            {immutable ? <span className="directory-access-badge is-writable" title="服务端固定记录，不可修改或移除">默认工作区</span> : null}
          </div>
          <div className="directory-row-actions">
            <label className="directory-write-toggle"><input type="checkbox" checked={directory.writeEnabled} onChange={(event) => update(directories.map((item) => item.id === directory.id ? { ...item, writeEnabled: event.target.checked } : item))} disabled={save.isPending || immutable || (!session.workspaceAlias && session.permissionMode !== 'FULL_ACCESS')} />可写</label>
            {editingId === directory.id
              ? <button type="button" className="directory-row-action" onClick={() => commitEdit(directory.id)} disabled={save.isPending || immutable}>完成</button>
              : <button type="button" className="directory-row-action" onClick={() => { setEditingId(directory.id); setEditingValue(directory.path); }} disabled={save.isPending || immutable}>修改</button>}
            <button type="button" className="directory-row-action remove" onClick={() => update(directories.filter((item) => item.id !== directory.id))} disabled={save.isPending || immutable}>移除</button>
          </div>
        </li>;
      })}
    </ul>
    {directories.length === 0 ? <p className="directory-empty">暂无目录。添加后可选择是否授予写入能力。</p> : null}
  </PanelShell>;
}
