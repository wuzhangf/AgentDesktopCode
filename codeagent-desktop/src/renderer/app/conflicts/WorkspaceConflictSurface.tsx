import React, { useMemo, useState } from 'react';
import type { WorkspaceConflictLike } from '../queries';
import { WorkspaceConflictEditor } from './WorkspaceConflictEditor';
import { WorkspaceConflictList } from './WorkspaceConflictList';

const OPEN_STATES = new Set(['OPEN', 'RESOLVING', 'STALE']);

/**
 * Unified conflict surface (design §6.7): one-line session entry expands
 * into the grouped list + tabbed editor.  All writes go through the
 * service; the renderer owns only selection and draft state.
 */
export function WorkspaceConflictSurface(props: {
  runId: string;
  items: WorkspaceConflictLike[];
  onResolved?: () => void;
}): React.JSX.Element | null {
  const open = useMemo(
    () => props.items.filter((item) => OPEN_STATES.has(item.state)),
    [props.items]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [refreshTick, setRefreshTick] = useState(0);

  if (open.length === 0) return null;

  const selected = open.find((item) => item.conflictId === selectedId) ?? open[0];
  const summaryVisible = !expanded || selectedId === null;

  return (
    <section className="workspace-conflicts" data-testid="workspace-conflicts"
      aria-label="文件冲突">
      {summaryVisible ? (
        <button type="button" className="workspace-conflict-summary"
          data-testid="conflict-summary"
          onClick={() => { setExpanded(true); setSelectedId(selected?.conflictId ?? null); }}>
          <span className="workspace-conflict-summary-count">
            {open.length} 个文件存在冲突
          </span>
          <span className="workspace-conflict-summary-action">解决冲突</span>
        </button>
      ) : null}
      {expanded ? (
        <div className="workspace-conflict-surface">
          <WorkspaceConflictList
            items={props.items}
            selectedId={selected?.conflictId ?? null}
            onSelect={setSelectedId}
            onBatchResolved={() => setRefreshTick((tick) => tick + 1)}
          />
          {selected ? (
            <WorkspaceConflictEditor
              key={`${selected.conflictId}-${refreshTick}-${selected.stateVersion}`}
              conflict={selected}
              onResolved={() => setRefreshTick((tick) => tick + 1)}
            />
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
