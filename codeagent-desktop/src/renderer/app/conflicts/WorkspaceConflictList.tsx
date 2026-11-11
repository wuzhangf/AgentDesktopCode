import React, { useState } from 'react';
import {
  useResolveWorkspaceConflictsBatch,
  type WorkspaceConflictLike
} from '../queries';

const OPEN_STATES = new Set(['OPEN', 'RESOLVING', 'STALE']);

/**
 * Conflict list grouped by origin (design §6.7 Changes sidebar): each row
 * selects into the unified editor; the batch bar applies one choice to
 * every open conflict via the server's all-preflight resolve-batch.
 */
export function WorkspaceConflictList(props: {
  items: WorkspaceConflictLike[];
  selectedId: string | null;
  onSelect: (conflictId: string) => void;
  onBatchResolved?: () => void;
}): React.JSX.Element {
  const batch = useResolveWorkspaceConflictsBatch();
  const [batchError, setBatchError] = useState<string | null>(null);

  const open = props.items.filter((item) => OPEN_STATES.has(item.state));
  const handled = props.items.filter((item) => !OPEN_STATES.has(item.state));
  const groups = groupByOrigin(open);

  const batchApply = (choice: 'KEEP_CURRENT' | 'USE_PROPOSED' | 'AUTO_MERGED') => {
    setBatchError(null);
    const items = open
      .filter((item) => (item.allowedActions ?? []).includes(choice) || choice === 'KEEP_CURRENT')
      .map((item) => ({
        conflictId: item.conflictId,
        expectedStateVersion: item.stateVersion,
        expectedCurrentHash: item.actualVersion ?? item.current?.version ?? null,
        choice
      }));
    if (items.length === 0) {
      setBatchError('没有可应用该选择的冲突项。');
      return;
    }
    batch.mutate({ body: { items } }, {
      onSuccess: (result) => {
        const failed = (result as {
          failedPaths?: Array<Record<string, unknown>>;
        }).failedPaths ?? [];
        if (failed.length > 0) {
          setBatchError(`部分路径失败：${failed
            .map((f) => String(f.path ?? '')).join('、')}`);
        }
        props.onBatchResolved?.();
      },
      onError: (error) => setBatchError(
        error instanceof Error ? error.message : String(error))
    });
  };

  return (
    <section className="workspace-conflict-list" data-testid="conflict-list"
      aria-label="冲突文件列表">
      <div className="workspace-conflict-list-head">
        <strong>{open.length} 个文件存在冲突</strong>
        {handled.length > 0 ? (
          <span className="run-meta">已处理 {handled.length} 项</span>
        ) : null}
      </div>
      {open.length > 1 ? (
        <div className="workspace-conflict-batch" role="group" aria-label="批量解决">
          <button type="button" className="secondary-button"
            data-testid="batch-keep-current"
            disabled={batch.isPending}
            onClick={() => batchApply('KEEP_CURRENT')}>全部使用当前</button>
          <button type="button" className="secondary-button"
            data-testid="batch-use-proposed"
            disabled={batch.isPending}
            onClick={() => batchApply('USE_PROPOSED')}>全部使用本次</button>
          <button type="button" className="secondary-button"
            data-testid="batch-auto-merge"
            disabled={batch.isPending
              || !open.every((item) => item.autoMerge?.status === 'CLEAN')}
            title="仅当所有冲突的自动合并均干净时可用"
            onClick={() => batchApply('AUTO_MERGED')}>全部自动合并</button>
        </div>
      ) : null}
      {batchError ? (
        <span className="workspace-conflict-error" role="alert">{batchError}</span>
      ) : null}
      {groups.map((group) => (
        <div className="workspace-conflict-group" key={group.origin}>
          <div className="workspace-conflict-group-label">{originLabel(group.origin)}</div>
          <ul>
            {group.items.map((item) => (
              <li key={item.conflictId}>
                <button type="button"
                  className={`workspace-conflict-row${props.selectedId === item.conflictId ? ' selected' : ''}`}
                  data-testid={`conflict-row-${item.path}`}
                  onClick={() => props.onSelect(item.conflictId)}>
                  <code>{item.path}</code>
                  <span className="run-meta">{item.kind ?? 'CAS_CONFLICT'}</span>
                  <span className={`workspace-conflict-state is-${item.state.toLowerCase()}`}>
                    {item.state}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </section>
  );
}

function groupByOrigin(items: WorkspaceConflictLike[]): Array<{
  origin: string; items: WorkspaceConflictLike[];
}> {
  const order: string[] = [];
  const groups = new Map<string, WorkspaceConflictLike[]>();
  for (const item of items) {
    const origin = item.origin ?? 'RUN_DIRECT_WRITE';
    if (!groups.has(origin)) {
      groups.set(origin, []);
      order.push(origin);
    }
    groups.get(origin)!.push(item);
  }
  return order.map((origin) => ({ origin, items: groups.get(origin)! }));
}

function originLabel(origin: string): string {
  switch (origin) {
    case 'RUN_DIRECT_WRITE': return '本次 Run';
    case 'DELIVERY': return 'Delivery 集成';
    case 'LANE_SYNC': return 'Lane 同步';
    case 'BRIDGE_APPLY': return '设备回写';
    case 'WEB_EDIT': return 'Web 编辑';
    case 'BUNDLE_IMPORT': return 'Bundle 导入';
    default: return origin;
  }
}
