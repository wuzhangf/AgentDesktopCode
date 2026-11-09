import React, { useState } from 'react';
import type { RunLike } from '../queries';
import { useContinueRun } from '../queries';

/**
 * WU-05（设计 §6.5）会话入口：注意力清除后的续跑一行入口。 仅当相关 Run
 * 停在 NEEDS_ATTENTION 且 attention.clearedAt 已到、尚未继续过才渲染；
 * 服务端对未清除的关注项仍然 fail-closed（RUN_ATTENTION_NOT_CLEARED）。
 */
export function RunContinueEntry(props: {
  run: RunLike | null | undefined;
}): React.JSX.Element | null {
  const continueRun = useContinueRun();
  const [error, setError] = useState<string | null>(null);
  const run = props.run;
  if (!run || run.sourceStatus !== 'NEEDS_ATTENTION') return null;
  if (!run.attention?.clearedAt || run.continuedBy) return null;
  const continued = continueRun.data as { runId?: string } | undefined;
  if (continued?.runId) {
    return (
      <div className="run-continue-entry" data-testid="conversation-continue-done">
        已创建续跑 Run {continued.runId.slice(0, 8)}…，冲突处理结果会通过系统帧注入。
      </div>
    );
  }
  return (
    <div className="run-continue-entry" data-testid="conversation-continue-entry">
      <button
        type="button"
        className="primary-button"
        disabled={continueRun.isPending}
        onClick={() => {
          setError(null);
          continueRun.mutate(
            { runId: run.runId, expectedStateVersion: run.stateVersion },
            {
              onError: (failure) => setError(
                failure instanceof Error ? failure.message : '续跑创建失败'),
            });
        }}
      >
        {continueRun.isPending ? '正在创建续跑…' : '继续任务'}
      </button>
      <span className="run-meta">已处理全部冲突，可继续</span>
      {error ? <span className="run-meta error-text">{error}</span> : null}
    </div>
  );
}
