import { useEffect, useMemo, useState } from 'react';
import {
  useRunActivities,
  useRunDiff,
  useRunEvidence,
  useRunReview,
  useWorkspaceExecutions,
  type DiffFileLike,
  type EvidenceItemLike,
  type FindingLike,
  type RunDeliveryLike,
  type RunVerificationV2Like,
  type RunActivityListItem,
  type WorkspaceExecutionLike
} from './queries';
import { StatusBadge } from './ui/StatusBadge';
import { changeTypeLabel } from './ui/labels';
import { parseUnifiedPatch } from './diff/diffParse';

/**
 * Git and Evidence panels (desktop design §10): Diff Inspector, Worktree
 * execution details and the layered Evidence bundle. Review findings remain
 * available as a future capability but are intentionally not mounted here.
 * Fail-closed rules:
 * - 501 NOT_IMPLEMENTED renders an explicit "not available" state, never a
 *   fabricated empty diff/review.
 * - binary files and truncated patches are labelled, never silently dropped.
 * - stale diffs carry a warning badge.
 * - NOT_RUN evidence layers are always rendered.
 */

export const DIFF_PAGE_SIZE = 20;

const TERMINAL_RUN_STATES = new Set([
  // COMPLETED is retained for older desktop fixtures/compatibility;
  // the current service uses SUCCEEDED.
  'COMPLETED',
  'SUCCEEDED',
  'FAILED',
  'TIMED_OUT',
  'MAX_STEPS_REACHED',
  'BUDGET_EXHAUSTED',
  'BUDGET_APPROVAL_DENIED',
  'CANCELLED',
  'INTERRUPTED',
  // Business WU-6: approved but not safely resumable — final state
  // whose artifacts/diff must stay inspectable.
  'NEEDS_ATTENTION'
]);

function isTerminalRunState(state?: string | null): boolean {
  return state != null && TERMINAL_RUN_STATES.has(state);
}

function isNotImplemented(err: unknown): boolean {
  return err instanceof Error && (err.message.includes('NOT_IMPLEMENTED')
    || (err as Error & { code?: string }).code === 'NOT_IMPLEMENTED');
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isLiveRunState(state?: string | null): boolean {
  return state != null && !isTerminalRunState(state);
}

function workspaceStateLabel(state?: string | null): string {
  switch (state) {
    case 'PROVISIONING': return '准备中';
    case 'READY': return '可用';
    case 'IN_USE': return '执行中';
    case 'NEEDS_ATTENTION': return '需要处理';
    case 'READY_FOR_HANDOFF': return '待交接';
    case 'RETAINED': return '已保留';
    case 'RECLAIMED': return '已释放';
    default: return state ?? '未关联副本';
  }
}

function runStateLabel(state?: string | null): string {
  if (!state) return '状态待同步';
  if (isTerminalRunState(state)) {
    return state === 'FAILED' ? '任务失败' : state === 'SUCCEEDED' || state === 'COMPLETED' ? '任务完成' : '任务已结束';
  }
  if (state === 'WAITING_APPROVAL' || state === 'WAITING_BUDGET_APPROVAL') return '等待决定';
  if (state === 'QUEUED') return '排队中';
  return '执行中';
}

interface WorkspaceTreeFile {
  path: string;
  changeType?: string | null;
}

interface WorkspaceTreeNode {
  name: string;
  path: string;
  isDirectory: boolean;
  changeType?: string | null;
  children: WorkspaceTreeNode[];
}

/** Keep the renderer's tree strictly project-relative; never render a path
 * supplied by an activity if it could escape the project root. */
function safeWorkspaceRelativePath(value: string | null | undefined): string | null {
  if (!value) return null;
  const normalized = value.trim().replaceAll('\\', '/').replace(/^\.\//, '');
  if (!normalized || normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized)) return null;
  const parts = normalized.split('/').filter(Boolean);
  if (parts.length === 0 || parts.some((part) => part === '..' || part === '.')) return null;
  return parts.join('/');
}

function activityFilePaths(activity: RunActivityListItem): string[] {
  const paths: Array<string | null | undefined> = [];
  if (activity.fileRef) paths.push(activity.fileRef);
  if (activity.fileName) {
    paths.push(activity.relativeDirectory
      ? `${activity.relativeDirectory}/${activity.fileName}`
      : activity.fileName);
  }
  const kind = activity.kind.toUpperCase();
  if (paths.length === 0 && /(FILE|SEARCH|EDIT|WRITE|PATCH|GIT)/.test(kind)) {
    for (const target of activity.targets ?? []) paths.push(target.ref);
  }
  return [...new Set(paths.map(safeWorkspaceRelativePath).filter((path): path is string => path !== null))];
}

function activityChangeType(activity: RunActivityListItem): string | null {
  const kind = activity.kind.toUpperCase();
  return /(WRITE|EDIT|PATCH|APPLY|CREATE)/.test(kind) ? 'MODIFIED' : null;
}

function buildWorkspaceTree(files: WorkspaceTreeFile[]): WorkspaceTreeNode {
  const root: WorkspaceTreeNode = { name: '项目', path: '', isDirectory: true, children: [] };
  const byPath = new Map<string, WorkspaceTreeNode>();
  for (const file of files) {
    const path = safeWorkspaceRelativePath(file.path);
    if (!path) continue;
    const parts = path.split('/');
    let parent = root;
    let currentPath = '';
    parts.forEach((part, index) => {
      currentPath = currentPath ? `${currentPath}/${part}` : part;
      const isDirectory = index < parts.length - 1;
      let node = byPath.get(currentPath);
      if (!node) {
        node = { name: part, path: currentPath, isDirectory, children: [] };
        byPath.set(currentPath, node);
        parent.children.push(node);
      } else if (isDirectory) {
        node.isDirectory = true;
      }
      if (!isDirectory && file.changeType) node.changeType = file.changeType;
      parent = node;
    });
  }
  const sort = (nodes: WorkspaceTreeNode[]): void => {
    nodes.sort((left, right) => {
      if (left.isDirectory !== right.isDirectory) return left.isDirectory ? -1 : 1;
      return left.name.localeCompare(right.name);
    });
    nodes.forEach((node) => sort(node.children));
  };
  sort(root.children);
  return root;
}

function workspaceTreeDepthClass(depth: number): string {
  return `workspace-tree-depth-${Math.min(depth, 8)}`;
}

function WorkspaceTreeNodeView(props: { node: WorkspaceTreeNode; depth: number }): React.JSX.Element {
  const { node } = props;
  return (
    <li className={`workspace-tree-node ${workspaceTreeDepthClass(props.depth)} ${node.isDirectory ? 'is-directory' : 'is-file'}`}>
      <div className="workspace-tree-row" title={node.path}>
        <span className="workspace-tree-chevron" aria-hidden="true">{node.isDirectory ? '▾' : ''}</span>
        <span className="workspace-tree-icon" aria-hidden="true">{node.isDirectory ? '▰' : '·'}</span>
        <span className="workspace-tree-name">{node.name}</span>
        {node.changeType ? <span className={`workspace-tree-change change-${node.changeType}`} aria-label={node.changeType}>{changeGlyph(node.changeType)}</span> : null}
      </div>
      {node.isDirectory && node.children.length > 0 ? (
        <ul className="workspace-tree-children">
          {node.children.map((child) => <WorkspaceTreeNodeView key={child.path} node={child} depth={props.depth + 1} />)}
        </ul>
      ) : null}
    </li>
  );
}

function WorkspaceTree(props: {
  files: WorkspaceTreeFile[];
  live: boolean;
  loading: boolean;
  error: unknown;
  hasMoreDiff: boolean;
}): React.JSX.Element {
  const tree = useMemo(() => buildWorkspaceTree(props.files), [props.files]);
  return (
    <section className="workspace-tree-card" data-testid="workspace-tree" aria-label="工作现场文件树">
      <div className="workspace-tree-heading">
        <div>
          <strong>文件树</strong>
          <span>{props.live ? '实时工作现场 · 已观测文件' : '任务文件投影 · 变更文件'}</span>
        </div>
        <span className={`workspace-live-indicator${props.live ? ' is-live' : ''}`} role="status">
          {props.live ? '● 实时同步' : '○ 已记录'}
        </span>
      </div>
      {props.loading && props.files.length === 0 ? <p className="workspace-tree-note" role="status">正在读取文件活动…</p> : null}
      {props.error && props.files.length === 0 ? <p className="workspace-tree-note" role="status">文件投影读取失败，等待下次同步。</p> : null}
      {!props.loading && tree.children.length === 0 ? (
        <p className="workspace-tree-note">{props.live ? '等待 AI 读取或修改第一个文件…' : '当前任务没有可展示的文件投影。'}</p>
      ) : (
        <ul className="workspace-tree-root">
          {tree.children.map((node) => <WorkspaceTreeNodeView key={node.path} node={node} depth={0} />)}
        </ul>
      )}
      <div className="workspace-tree-footer">
        <span>{props.files.length} 个已观测文件</span>
        {props.hasMoreDiff ? <span>变更列表还有更多文件</span> : null}
        {props.error && props.files.length > 0 ? <span>部分活动暂不可用</span> : null}
      </div>
    </section>
  );
}

/**
 * EW7 panel: service-owned workspace executions for the inspected run.
 * The primary view is the service-returned project-relative file projection;
 * lifecycle facts stay visible as labels and the physical worktree path never
 * leaves the service. Handoff conflicts and reclaim blocks surface as
 * fail-closed states, never silent retries.
 */
export function WorkspaceExecutions(props: {
  runId: string;
  projectId: string;
  runState?: string | null;
  onCreateWorktree: () => void;
  onHandoff: (execution: WorkspaceExecutionLike) => void;
  onReclaim: (execution: WorkspaceExecutionLike) => void;
  pending: boolean;
}): React.JSX.Element {
  const live = isLiveRunState(props.runState);
  const workspaces = useWorkspaceExecutions(props.projectId, { live });
  const activityApiAvailable = typeof window !== 'undefined'
    && typeof window.codeAgentDesktop?.getRunActivities === 'function';
  const activity = useRunActivities(props.runId, { enabled: activityApiAvailable, live });
  const terminal = isTerminalRunState(props.runState);
  const diffApiAvailable = typeof window !== 'undefined'
    && typeof window.codeAgentDesktop?.getRunDiff === 'function';
  const diff = useRunDiff(terminal && diffApiAvailable ? props.runId : null, 0, DIFF_PAGE_SIZE);
  const activityItems = activity.data?.items ?? [];
  const diffFiles = diff.data?.files ?? [];
  const treeFiles = useMemo<WorkspaceTreeFile[]>(() => {
    const byPath = new Map<string, WorkspaceTreeFile>();
    for (const item of activityItems) {
      const changeType = activityChangeType(item);
      for (const path of activityFilePaths(item)) {
        byPath.set(path, { path, changeType: changeType ?? byPath.get(path)?.changeType ?? null });
      }
    }
    for (const file of diffFiles) {
      const path = safeWorkspaceRelativePath(file.path);
      if (!path) continue;
      byPath.set(path, { path, changeType: file.changeType ?? byPath.get(path)?.changeType ?? null });
    }
    return [...byPath.values()].sort((left, right) => left.path.localeCompare(right.path));
  }, [activityItems, diffFiles]);
  const items = workspaces.data ?? [];
  const owned = items.filter((item) => item.ownerId === props.runId);
  const others = items.filter((item) => item.ownerId !== props.runId);
  const current = owned.find((item) => item.state !== 'RECLAIMED') ?? owned[0] ?? null;
  const activityError = activity.isError ? activity.error : diff.isError ? diff.error : null;
  const activityLoading = activity.isPending || diff.isPending;
  const stateLabel = current ? workspaceStateLabel(current.state) : live ? '等待隔离副本' : '未关联副本';
  const historyItems = items;
  // Design 2026-09-30 §6.2.4: one row = kind tag + ref + state badges; line two
  // carries ownership/baseline; the Service note is a warning-tinted block,
  // never red "error" text.
  const renderWorkspaceItem = (item: WorkspaceExecutionLike): React.JSX.Element => {
    const ownedByRun = item.ownerId === props.runId;
    const hasActions = item.state === 'IN_USE' || item.state === 'READY_FOR_HANDOFF' || item.state === 'RETAINED';
    return (
      <li key={item.workspaceExecutionId} className="workspace-item" data-testid="workspace-item">
        <div className="workspace-item-head">
          <code className={`workspace-kind-tag workspace-kind-${item.kind ?? 'UNKNOWN'}`}>{item.kind ?? '?'}</code>
          <code className="workspace-ref" title={item.workspaceRef ?? item.workspaceExecutionId}>{item.workspaceRef ?? item.workspaceExecutionId}</code>
          <span className="workspace-item-badges">
            <span className={`badge workspace-state-${item.state ?? 'UNKNOWN'}`} data-testid="workspace-state">
              {item.state === 'NEEDS_ATTENTION' ? '⚠ 需要处理' : workspaceStateLabel(item.state)}
            </span>
            {item.leaseExpired ? <StatusBadge tone="warn" label="租约已过期" /> : null}
          </span>
        </div>
        <span className="run-meta">
          所属 {ownedByRun ? '本次运行' : item.ownerId?.slice(0, 8) ?? '?'} · 基于 {item.baselineRevision?.slice(0, 7) ?? '?'}
        </span>
        {item.dirtySummary ? (
          <p className="workspace-item-note" data-testid="workspace-item-note">
            Service 说明：<code>{item.dirtySummary}</code>
          </p>
        ) : null}
        {hasActions ? (
          <div className="workspace-item-actions">
            {item.state === 'IN_USE' && (
              <button
                type="button"
                data-testid="workspace-handoff"
                onClick={() => props.onHandoff(item)}
                disabled={props.pending}
              >
                交接
              </button>
            )}
            {(item.state === 'READY_FOR_HANDOFF' || item.state === 'RETAINED') && (
              <button
                type="button"
                data-testid="workspace-reclaim"
                onClick={() => props.onReclaim(item)}
                disabled={props.pending}
              >
                释放
              </button>
            )}
          </div>
        ) : item.state === 'NEEDS_ATTENTION' ? (
          <p className="workspace-item-note muted">桌面端暂无可执行操作，请按 Service 说明排查。</p>
        ) : null}
      </li>
    );
  };
  return (
    <section className="ew6-panel" data-testid="workspace-panel">
      <div className="workspace-columns">
        <div className="workspace-column-main">
          <div className="workspace-summary-card">
            <div className="workspace-panel-heading">
              <div>
                <h3>工作副本</h3>
                <span className="run-meta">本次任务的代码工作现场</span>
              </div>
              {!workspaces.isError ? (
                <button
                  type="button"
                  className="secondary-button"
                  data-testid="create-worktree"
                  onClick={props.onCreateWorktree}
                  disabled={props.pending}
                >
                  创建隔离代码副本
                </button>
              ) : null}
            </div>
            <div className="workspace-facts" aria-label="工作副本概况">
              <div className="workspace-fact">
                <span className="workspace-fact-label">当前副本</span>
                <span className={`badge workspace-state-${current?.state ?? 'UNKNOWN'}`} data-testid="workspace-current-state">
                  {stateLabel}
                </span>
              </div>
              <div className="workspace-fact">
                <span className="workspace-fact-label">任务</span>
                <strong className="workspace-fact-value">{runStateLabel(props.runState)}</strong>
              </div>
              <div className="workspace-fact">
                <span className="workspace-fact-label">类型</span>
                <strong className="workspace-fact-value">{current?.kind === 'WORKTREE' ? '隔离副本' : current?.kind ?? '—'}</strong>
              </div>
              <div className="workspace-fact">
                <span className="workspace-fact-label">基线</span>
                <strong className="workspace-fact-value">{current?.baselineRevision ? current.baselineRevision.slice(0, 7) : '—'}</strong>
              </div>
            </div>
            {current?.workspaceRef ? <div className="workspace-current-ref" title={current.workspaceRef}>{current.workspaceRef}</div> : null}
            {current?.leaseExpired ? <StatusBadge tone="warn" label="租约已过期" /> : null}
            {workspaces.isError ? (
              isNotImplemented(workspaces.error) ? (
                <p className="empty" data-testid="workspace-not-implemented">
                  服务未启用工作区执行能力（501），无法管理副本；仍会尝试显示实时文件投影。
                </p>
              ) : (
                <p className="error-text" data-testid="workspace-error">
                  工作区状态加载失败：{errorMessage(workspaces.error)}；仍会尝试显示实时文件投影。
                </p>
              )
            ) : null}
          </div>
          <WorkspaceTree
            files={treeFiles}
            live={live}
            loading={activityLoading}
            error={activityError}
            hasMoreDiff={Boolean(diff.data?.hasMore)}
          />
        </div>
        <details className="workspace-history" open={items.length > 1}>
          <summary>副本记录 · {historyItems.length}</summary>
          <div className="workspace-history-group" data-testid="git-worktree-owned">
            <h4>本次运行（{owned.length}）</h4>
            {owned.length === 0 ? (
              <p className="empty">当前运行没有关联的副本。</p>
            ) : (
              <ul className="workspace-list">{owned.map(renderWorkspaceItem)}</ul>
            )}
          </div>
          {others.length > 0 ? (
            <div className="workspace-history-group" data-testid="git-worktree-others">
              <h4>本项目其他运行（{others.length}）</h4>
              <ul className="workspace-list">{others.map(renderWorkspaceItem)}</ul>
            </div>
          ) : null}
          {workspaces.data && items.length === 0 ? (
            <p className="empty">本项目暂无代码副本记录。</p>
          ) : null}
        </details>
      </div>
    </section>
  );
}

/**
 * Renders one unified-diff patch with real old/new line numbers
 * (ui-polish-plan-2026-10 §8.1). The patch text is always inserted as React
 * text (never HTML): hunk headers become muted dividers, +/- lines get their
 * tones, and `wrap` toggles pre-wrap when the user asks for soft-wrapped code.
 */
export function DiffPatchView(props: { patch: string; wrap?: boolean }): React.JSX.Element {
  const rows = useMemo(() => parseUnifiedPatch(props.patch), [props.patch]);
  const LONG_PATCH_LINES = 400;
  const PREVIEW_LINES = 120;
  const [expanded, setExpanded] = useState(false);
  const folded = rows.length > LONG_PATCH_LINES && !expanded;
  const visible = folded ? rows.slice(0, PREVIEW_LINES) : rows;
  return (
    <div className={`diff-lines${props.wrap ? ' wrap' : ''}`} role="group" aria-label={`变更 ${rows.length} 行`}>
      {visible.map((line, index) => line.kind === 'hunk' ? (
        <div key={index} className="diff-line-hunk">{line.text}</div>
      ) : (
        <div key={index} className={`diff-line tone-${line.kind}`}>
          <span className="diff-line-gutter" aria-hidden="true">{line.oldNo ?? ''}</span>
          <span className="diff-line-gutter" aria-hidden="true">{line.newNo ?? ''}</span>
          <span className="diff-line-sign" aria-hidden="true">{line.sign}</span>
          <code className="diff-line-code">{line.text === '' ? ' ' : line.text}</code>
        </div>
      ))}
      {folded ? (
        <button
          type="button"
          className="diff-expand"
          onClick={() => setExpanded(true)}
        >
          展开剩余 {rows.length - PREVIEW_LINES} 行
        </button>
      ) : null}
    </div>
  );
}

function fileBadge(file: DiffFileLike): string | null {
  // The change glyph (A/M/D) already carries the change type: badges are
  // reserved for states that need a warning, not for repeating the type.
  if (file.binary) return '二进制';
  if (file.truncated) return 'patch 截断';
  return null;
}

function changeGlyph(changeType?: string | null): string {
  switch (changeType) {
    case 'ADDED': return 'A';
    case 'DELETED': return 'D';
    case 'RENAMED': return 'R';
    case 'MODIFIED': return 'M';
    default: return '•';
  }
}

/** Split dir / basename so the directory reads quiet and the name pops. */
function splitPath(path: string): { dir: string | null; base: string } {
  const index = path.lastIndexOf('/');
  if (index < 0) return { dir: null, base: path };
  return { dir: path.slice(0, index), base: path.slice(index + 1) };
}

function DiffFileBody(props: { file: DiffFileLike; wrap: boolean }): React.JSX.Element {
  const { file } = props;
  if (file.binary) return <p className="empty">二进制文件：不显示 patch 内容。</p>;
  if (!file.patch) return <p className="empty">无 patch 内容。</p>;
  return (
    <>
      <DiffPatchView patch={file.patch} wrap={props.wrap} />
      {file.truncated ? (
        <p className="error-text">patch 超出长度上限已截断，完整内容以工作区为准。</p>
      ) : null}
    </>
  );
}

export function patchStats(patch?: string | null): { additions: number; deletions: number } {
  if (!patch) return { additions: 0, deletions: 0 };
  let additions = 0;
  let deletions = 0;
  for (const line of patch.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) additions += 1;
    if (line.startsWith('-')) deletions += 1;
  }
  return { additions, deletions };
}

/**
 * Full-size Git GUI changes surface. This deliberately does not reuse the
 * compact inspector layout: the file navigator stays visible while the
 * selected patch gets the main reading area.
 */
export function GitChangesPage(props: {
  runId: string;
  runState?: string | null;
  onReveal: (fileRef: string, runId?: string | null) => void;
  revealPending: boolean;
  enabled?: boolean;
  unavailableReason?: string | null;
}): React.JSX.Element {
  const [page, setPage] = useState(0);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [wrap, setWrap] = useState(false);
  const [copiedPath, setCopiedPath] = useState(false);
  const enabled = props.enabled !== false;
  const terminal = isTerminalRunState(props.runState);
  const diff = useRunDiff(enabled && terminal ? props.runId : null, page, DIFF_PAGE_SIZE);
  const files = diff.data?.files ?? [];
  const selectedFile = files.find((file) => file.path === selectedPath) ?? files[0] ?? null;

  useEffect(() => {
    if (selectedFile && selectedFile.path !== selectedPath) setSelectedPath(selectedFile.path);
    if (files.length === 0 && selectedPath !== null) setSelectedPath(null);
  }, [files, selectedFile, selectedPath]);

  // j/k or ↑/↓ move the file selection while focus sits inside the list (§8.2).
  const stepSelection = (delta: number): void => {
    if (files.length === 0) return;
    const index = Math.max(0, files.findIndex((file) => file.path === selectedFile?.path));
    const next = files[Math.min(files.length - 1, index + delta)];
    if (next) setSelectedPath(next.path);
  };
  const onListKeyDown = (event: React.KeyboardEvent): void => {
    if (event.key === 'j' || event.key === 'ArrowDown') { event.preventDefault(); stepSelection(1); }
    else if (event.key === 'k' || event.key === 'ArrowUp') { event.preventDefault(); stepSelection(-1); }
  };

  const copySelectedPath = (): void => {
    if (!selectedFile || !navigator.clipboard) return;
    void navigator.clipboard.writeText(selectedFile.path).then(() => {
      setCopiedPath(true);
      window.setTimeout(() => setCopiedPath(false), 1_600);
    }).catch(() => undefined);
  };

  if (!enabled) {
    return (
      <section className="git-changes-page" data-testid="git-changes-page">
        <div className="git-page-empty"><h2>变更</h2><p>当前服务未提供 Diff（{props.unavailableReason ?? 'UNAVAILABLE'}）。</p></div>
      </section>
    );
  }
  if (!terminal) {
    return (
      <section className="git-changes-page" data-testid="git-changes-page">
        <div className="git-page-empty"><h2>变更</h2><p data-testid="diff-pending">Run 尚未结束，变更产物将在终态后记录。</p></div>
      </section>
    );
  }
  if (diff.isError) {
    return (
      <section className="git-changes-page" data-testid="git-changes-page">
        <div className="git-page-empty"><h2>变更</h2><p className="error-text" data-testid={isNotImplemented(diff.error) ? 'diff-not-implemented' : 'diff-error'}>{isNotImplemented(diff.error) ? '服务尚未实现 Diff API（501）：无法展示变更，fail-closed。' : `Diff 加载失败：${errorMessage(diff.error)}`}</p></div>
      </section>
    );
  }

  const stats = files.reduce((total, file) => {
    const next = patchStats(file.patch);
    return { additions: total.additions + next.additions, deletions: total.deletions + next.deletions };
  }, { additions: 0, deletions: 0 });
  const summary = [
    files.filter((file) => file.changeType === 'ADDED').length > 0 ? `新增 ${files.filter((file) => file.changeType === 'ADDED').length}` : null,
    files.filter((file) => file.changeType === 'MODIFIED').length > 0 ? `修改 ${files.filter((file) => file.changeType === 'MODIFIED').length}` : null,
    files.filter((file) => file.changeType === 'DELETED').length > 0 ? `删除 ${files.filter((file) => file.changeType === 'DELETED').length}` : null
  ].filter(Boolean).join(' · ');
  const selectedSplit = selectedFile ? splitPath(selectedFile.path) : null;
  const selectedStats = selectedFile ? patchStats(selectedFile.patch) : null;
  // Pagers only exist when a second page is reachable (G1).
  const multiPage = Boolean(diff.data?.hasMore) || page > 0;

  return (
    <section className="git-changes-page" data-testid="git-changes-page">
      <div className="git-changes-toolbar">
        <div className="git-changes-summary">
          <strong>{files.length} 个文件</strong>
          <span>{summary || '工作区与基线相比没有可展示的文件变更。'}{diff.data?.stale ? ' · 变更快照可能已过期' : ''}</span>
        </div>
        <div className="git-change-stats" aria-label="变更统计">
          <span className="git-stat-add">+{stats.additions}</span>
          <span className="git-stat-delete">−{stats.deletions}</span>
          {multiPage ? <span className="git-stat-files">（本页）</span> : null}
          {diff.data?.truncated ? <span className="git-stat-files" data-testid="diff-truncated">已截断</span> : null}
          <button
            type="button"
            className={`git-diff-option${wrap ? ' selected' : ''}`}
            aria-pressed={wrap}
            title="切换代码自动换行"
            onClick={() => setWrap((current) => !current)}
          >换行</button>
        </div>
      </div>
      {diff.data?.stale ? <p className="git-page-warning" data-testid="diff-stale">⚠ 变更快照已过期，工作区可能已经移动。</p> : null}
      {diff.data?.complete === false && diff.data.incompleteReason ? <p className="git-page-warning">归因不明：{diff.data.incompleteReason}</p> : null}
      <div className="git-changes-layout">
        <aside className="git-file-tree" aria-label="变更文件" onKeyDown={onListKeyDown}>
          <div className="git-file-tree-heading"><strong>变更文件</strong><span>{files.length}</span></div>
          <ul>
            {files.map((file) => {
              const split = splitPath(file.path);
              const glyph = changeGlyph(file.changeType);
              const glyphLabel = changeTypeLabel(file.changeType);
              const fileStats = patchStats(file.patch);
              return (
                <li key={file.path} className={`git-file-row change-${file.changeType ?? 'UNKNOWN'}${selectedFile?.path === file.path ? ' selected' : ''}`}>
                  <button type="button" onClick={() => setSelectedPath(file.path)} aria-label={file.path} aria-current={selectedFile?.path === file.path ? 'true' : undefined} title={`${file.path}（${glyphLabel}）`}>
                    <span className="git-file-row-main">
                      <span className="change-glyph" aria-label={glyphLabel}>{glyph}</span>
                      <span className="git-file-name">{split.base}</span>
                      {fileStats.additions + fileStats.deletions > 0 ? (
                        <span className="git-file-stats"><em className="git-stat-add">+{fileStats.additions}</em><em className="git-stat-delete">−{fileStats.deletions}</em></span>
                      ) : null}
                      {fileBadge(file) ? <span className="badge">{fileBadge(file)}</span> : null}
                    </span>
                    {split.dir ? <span className="git-file-dir" title={split.dir}>{split.dir}</span> : null}
                  </button>
                </li>
              );
            })}
            {files.length === 0 ? <li className="git-file-empty">本页无变更文件</li> : null}
          </ul>
          {multiPage ? (
            <div className="git-file-pager">
              <button type="button" onClick={() => { setPage((current) => Math.max(0, current - 1)); setSelectedPath(null); }} disabled={page === 0 || diff.isFetching}>上一页</button>
              <span data-testid="git-page-indicator">第 {(diff.data?.page ?? page) + 1} 页</span>
              <button type="button" onClick={() => { setPage((current) => current + 1); setSelectedPath(null); }} disabled={!diff.data?.hasMore || diff.isFetching}>下一页</button>
            </div>
          ) : null}
        </aside>
        <section className="git-diff-view" aria-label="文件差异">
          {selectedFile && selectedSplit ? (
            <>
              <header className="git-diff-header">
                <div className="git-diff-title">
                  <span className={`change-glyph change-${selectedFile.changeType ?? 'UNKNOWN'}`}>{changeGlyph(selectedFile.changeType)}</span>
                  <code title={selectedFile.path}>{selectedFile.path}</code>
                </div>
                <span className="git-diff-kind">{changeTypeLabel(selectedFile.changeType)}</span>
                {selectedStats && selectedStats.additions + selectedStats.deletions > 0 ? (
                  <span className="git-diff-stats"><em className="git-stat-add">+{selectedStats.additions}</em><em className="git-stat-delete">−{selectedStats.deletions}</em></span>
                ) : null}
                <span className="git-diff-actions">
                  <button
                    type="button"
                    className="diff-reveal"
                    onClick={() => props.onReveal(selectedFile.path, props.runId)}
                    disabled={props.revealPending}
                  >定位文件</button>
                  <button type="button" onClick={copySelectedPath}>{copiedPath ? '已复制' : '复制路径'}</button>
                </span>
              </header>
              <div className="git-diff-body" data-testid="diff-file-body"><DiffFileBody file={selectedFile} wrap={wrap} /></div>
            </>
          ) : (
            <div className="git-diff-empty"><span className="git-diff-empty-icon">⌁</span><h3>选择一个文件查看变更</h3><p>左侧文件树显示当前 Run 的 Git 变更。</p></div>
          )}
        </section>
      </div>
    </section>
  );
}

export function ReviewFindings(props: {
  runId: string;
  runState?: string | null;
  onCreateFixTask: (finding: FindingLike) => void;
  fixPending: boolean;
  enabled?: boolean;
  unavailableReason?: string | null;
}): React.JSX.Element {
  const enabled = props.enabled !== false;
  const terminal = isTerminalRunState(props.runState);
  const review = useRunReview(enabled && terminal ? props.runId : null);
  if (!enabled) {
    return (
      <section className="ew6-panel" data-testid="review-findings">
        <h3>评审</h3>
        <p className="empty" data-testid="review-unavailable">当前服务未提供 Review（{props.unavailableReason ?? 'UNAVAILABLE'}）。</p>
      </section>
    );
  }
  if (!terminal) {
    return (
      <section className="ew6-panel" data-testid="review-findings">
        <h3>评审</h3>
        <p className="empty" data-testid="review-pending">Run 运行中，评审结果将在终态后生成。</p>
      </section>
    );
  }
  if (review.isError) {
    return (
      <section className="ew6-panel" data-testid="review-findings">
        <h3>评审</h3>
        <p className="error-text" data-testid="review-error">Review 加载失败：{errorMessage(review.error)}</p>
      </section>
    );
  }
  const findings = review.data?.findings ?? [];
  const reviewStatus = review.data?.status?.toUpperCase();
  const reviewBadge = reviewStatus === 'NOT_REQUESTED'
    ? '未请求'
    : reviewStatus === 'RUNNING'
      ? '评审进行中'
      : reviewStatus === 'FAILED'
        ? '评审失败'
        : review.data?.complete
          ? '评审完成'
          : '评审未完成';
  return (
    <section className="ew6-panel" data-testid="review-findings">
      <h3>
        Review
        {review.data ? <span className="badge">{reviewBadge}</span> : null}
        <span className="run-meta">{review.data?.reviewId ? ` ${review.data.reviewId}` : ''}</span>
      </h3>
      <ul className="finding-list">
        {findings.map((finding) => (
          <li key={finding.findingId} className="finding">
            <span className={`badge severity-${finding.severity ?? 'UNKNOWN'}`}>{finding.severity ?? 'UNKNOWN'}</span>
            <span className="finding-where">
              {finding.file ?? '?'}{finding.line !== null && finding.line !== undefined ? `:${finding.line}` : ''}
            </span>
            <span className="finding-message">{finding.message ?? ''}</span>
            {finding.fixTaskId ? (
              <span className="run-meta" data-testid="fix-task-linked">修复任务 {finding.fixTaskId}</span>
            ) : (
              <button
                type="button"
                data-testid="create-fix-task"
                onClick={() => props.onCreateFixTask(finding)}
                disabled={props.fixPending}
              >
                转为修复任务
              </button>
            )}
          </li>
        ))}
        {review.data && findings.length === 0 && (
          <li className="empty" data-testid="review-empty">无评审发现。</li>
        )}
      </ul>
    </section>
  );
}

const LAYER_LABEL: Record<string, string> = {
  SOURCE: '源码',
  DETERMINISTIC_TEST: '确定性测试',
  PACKAGE: '打包',
  RUNTIME: '运行时',
  LIVE_MODEL: '实模型',
  TRACE: '追踪',
  GUI: 'GUI',
  SCENARIO_ORACLE: '场景 Oracle'
};

export function EvidenceLayers(props: {
  runId: string;
  runState?: string | null;
  outcomeSeverity?: string | null;
  verificationV2?: RunVerificationV2Like | null;
  delivery?: RunDeliveryLike | null;
  enabled?: boolean;
  unavailableReason?: string | null;
}): React.JSX.Element {
  const enabled = props.enabled !== false;
  const terminal = isTerminalRunState(props.runState);
  const evidence = useRunEvidence(enabled && terminal ? props.runId : null);
  if (!enabled) {
    return (
      <section className="ew6-panel" data-testid="evidence-panel">
        <h3>验证证据</h3>
        <p className="empty" data-testid="evidence-unavailable">当前服务未提供证据查询（{props.unavailableReason ?? 'UNAVAILABLE'}）。</p>
      </section>
    );
  }
  if (!terminal) {
    return (
      <section className="ew6-panel" data-testid="evidence-panel">
        <h3>验证证据</h3>
        <p className="empty" data-testid="evidence-pending">Run 运行中，最终验证证据将在终态后同步。</p>
      </section>
    );
  }
  if (evidence.isError) {
    return (
      <section className="ew6-panel" data-testid="evidence-panel">
        <h3>验证证据</h3>
        <p className="error-text" data-testid="evidence-error">证据加载失败：{errorMessage(evidence.error)}</p>
      </section>
    );
  }
  const items = evidence.data?.items ?? [];
  const delivery: RunDeliveryLike | null = props.delivery ?? (evidence.data ? {
    status: evidence.data.deliveryStatus,
    artifactsReady: evidence.data.artifactsReady,
    stateVersion: evidence.data.stateVersion,
    changeArtifactRef: evidence.data.changeArtifactRef,
    evidenceManifestRef: evidence.data.manifestRef
  } : null);
  const verification = evidence.data?.verificationV2 ?? props.verificationV2;
  const outcomeSeverity = evidence.data?.outcomeSeverity ?? props.outcomeSeverity;
  const byLayer = new Map<string, typeof items>();
  for (const item of items) {
    const list = byLayer.get(item.layer) ?? [];
    list.push(item);
    byLayer.set(item.layer, list);
  }
  return (
    <section className="ew6-panel" data-testid="evidence-panel">
      <h3>
        验证证据
        <span className={`badge ${evidence.data?.complete ? 'evidence-complete' : 'evidence-incomplete'}`}>
          {evidence.data?.complete ? '完整' : '不完整'}
        </span>
      </h3>
      <div className="evidence-blocks">
        <EvidenceBlock testId="evidence-implementation" title="实现" layers={['SOURCE', 'PACKAGE']} byLayer={byLayer} />
        <EvidenceBlock testId="evidence-verification" title="验证" layers={['DETERMINISTIC_TEST', 'LIVE_MODEL', 'SCENARIO_ORACLE']} byLayer={byLayer} />
        <section className="evidence-block" data-testid="evidence-attribution">
          <h4>归因</h4>
          {verification ? (
            <div className="evidence-verification" data-testid="verification-summary">
              <span>Verification：</span>
              <span>{verification.overall ?? 'UNKNOWN'}</span>
              {outcomeSeverity ? <span className="badge">{outcomeSeverity}</span> : null}
              <span>{verification.requiredLanesPassed === true ? 'required lanes passed' : 'required lanes incomplete'}</span>
              {verification.warnings?.map((warning) => (
                <StatusBadge key={warning} tone="warn" label={warning} testId="verification-warning" />
              ))}
              {verification.lanes?.map((lane, index) => (
                <span key={`${lane.planId ?? 'lane'}-${lane.lane ?? index}`} className="run-meta" data-testid="verification-lane">
                  {lane.lane ?? 'lane'} · {lane.disposition ?? 'UNKNOWN'} · attribution {lane.attributionKinds ?? 'UNKNOWN'} ({lane.attributionConfidence ?? 'UNKNOWN'})
                </span>
              ))}
            </div>
          ) : <p className="empty">暂无因果归因结果。</p>}
        </section>
        <section className="evidence-block" data-testid="evidence-delivery">
          <h4>交付</h4>
          {delivery ? (
            <div className="evidence-delivery">
              <span>产物屏障：</span>
              <span data-testid="evidence-delivery-status">{delivery.status ?? 'UNKNOWN'}</span>
              <span>{delivery.artifactsReady === true ? '可读取' : '待同步'}</span>
              {delivery.evidenceManifestRef?.manifestId ? <span className="run-meta">manifest {delivery.evidenceManifestRef.manifestId}</span> : null}
            </div>
          ) : <p className="empty">暂无交付清单。</p>}
          <EvidenceBlockList layers={['RUNTIME', 'TRACE', 'GUI']} byLayer={byLayer} />
        </section>
      </div>
    </section>
  );
}

function EvidenceBlock(props: { testId: string; title: string; layers: readonly string[]; byLayer: Map<string, EvidenceItemLike[]> }): React.JSX.Element {
  return <section className="evidence-block" data-testid={props.testId}><h4>{props.title}</h4><EvidenceBlockList layers={props.layers} byLayer={props.byLayer} /></section>;
}

function EvidenceBlockList(props: { layers: readonly string[]; byLayer: Map<string, EvidenceItemLike[]> }): React.JSX.Element {
  return <ul className="evidence-layers">{props.layers.map((layer) => { const layerItems = props.byLayer.get(layer) ?? []; return <li key={layer} className="evidence-layer" data-layer={layer} data-testid={`evidence-layer-${layer}`}><span className="evidence-layer-name">{LAYER_LABEL[layer] ?? layer}</span>{layerItems.length === 0 ? <span className="badge status-NO_DATA">无数据</span> : layerItems.map((item) => <span key={item.evidenceId} className={`badge status-${item.status}`}>{item.status === 'NOT_RUN' ? 'NOT_RUN（未运行）' : item.status}</span>)}</li>; })}</ul>;
}
