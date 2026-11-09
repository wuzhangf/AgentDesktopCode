/**
 * Inline conversation timeline of tool activities (design 2026-09-02 §11.3/§11.4).
 * Every row comes from a real service activity fact; nothing is inferred
 * from final answers, and raw reasoning has no node here by construction.
 */
import { useState } from 'react';
import type { RunActivity } from '../activity/activityTypes';
import {
  activityKindLabel,
  activityStatusGlyph,
  formatDuration,
  groupActivities,
  isAttentionWorthy,
  isFailedStatus,
  redactionBadge
} from '../activity/activityPresentation';

/**
 * Shortens a long target ref for row display: keep the file name plus at
 * most one parent segment so full package paths never dominate the row.
 * The full ref stays in the title attribute.
 */
export function shortenTargetRef(ref: string): string {
  if (!ref || ref.length <= 60) return ref;
  const parts = ref.split('/');
  if (parts.length <= 2) return ref;
  return `…/${parts.slice(-2).join('/')}`;
}

function ActivityRow(props: { activity: RunActivity; kindLabel: string; defaultOpen: boolean }): React.JSX.Element {
  const { activity } = props;
  const [open, setOpen] = useState(props.defaultOpen);
  const running = activity.status === 'RUNNING';
  const failed = isFailedStatus(activity.status);
  const duration = formatDuration(activity.durationMillis);
  const badge = redactionBadge(activity.redactionState);
  const targets = activity.targets ?? [];
  const hasBody = targets.length > 0
    || Boolean(activity.detail)
    || (Boolean(activity.commandPreview) && activity.redactionState !== 'WITHHELD')
    || activity.failure != null
    || activity.effectState === 'UNKNOWN';
  return (
    <div className={`activity-row status-${activity.status.toLowerCase()} ${failed ? 'activity-row-failed' : ''}`}>
      <button
        type="button"
        className="activity-row-head"
        aria-expanded={hasBody ? open : undefined}
        onClick={() => { if (hasBody) setOpen((current) => !current); }}
        disabled={!hasBody}
      >
        <span className={`activity-status-glyph ${running ? 'activity-status-running' : ''}`} aria-hidden="true">
          {activityStatusGlyph(activity.status)}
        </span>
        <span className="activity-row-title">
          {props.kindLabel}
          {activity.toolName ? <code className="activity-detail" title={activity.toolName}>{activity.toolName}</code> : null}
          {activity.detail ? <code className="activity-detail" title={activity.detail}>{activity.detail}</code> : null}
          {activity.failure ? <span className="activity-failure-summary">{activity.failure.safeMessage}</span> : null}
        </span>
        <span className="activity-row-meta">
          {badge === '命令内容因安全策略隐藏' ? <span className="badge stale">{badge}</span> : null}
          {activity.resultSummary && activity.resultSummary !== activity.detail
            ? <span className="activity-summary" title={activity.resultSummary}>{activity.resultSummary}</span> : null}
          {duration ? <span className="activity-duration">{duration}</span> : null}
          {activity.truncated ? <span className="badge stale">已截断</span> : null}
        </span>
      </button>
      {open && hasBody ? (
        <div className="activity-row-body">
          {activity.commandPreview && activity.redactionState !== 'WITHHELD'
            ? <code className="activity-command">{activity.commandPreview}</code> : null}
          {badge && badge !== '命令内容因安全策略隐藏' ? <span className="badge stale">{badge}</span> : null}
          {targets.length > 0 ? (
            <ul className="activity-targets">
              {targets.slice(0, 10).map((target) => (
                <li key={`${target.ref}-${target.status}`} className={`activity-target status-${target.status.toLowerCase()}`}>
                  <span className="activity-status-glyph" aria-hidden="true">{activityStatusGlyph(target.status)}</span>
                  <code title={target.ref}>{shortenTargetRef(target.ref)}</code>
                </li>
              ))}
              {targets.length > 10 ? <li className="activity-target"><span className="run-meta">…还有 {targets.length - 10} 个目标已收起</span></li> : null}
            </ul>
          ) : null}
          {activity.reasonCode ? <span className="run-meta">原因：{activity.reasonCode}</span> : null}
          {activity.failure ? (
            <div className="activity-failure-details">
              <span className="run-meta">失败：{activity.failure.safeMessage}</span>
              <span className="run-meta">错误码：{activity.failure.code} · 阶段：{activity.failure.phase}</span>
              {activity.failure.context?.pathRef ? <span className="run-meta">路径：{activity.failure.context.pathRef}</span> : null}
              <span className="run-meta">调用标识：{activity.failure.context?.toolCallId ?? activity.activityId}</span>
              {activity.resultSummary ? <span className="run-meta">输出摘要：{activity.resultSummary}</span> : null}
              {activity.truncated ? <span className="run-meta">输出已截断</span> : null}
              <span className="run-meta">效果：{activity.failure.effectState}</span>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function ToolActivityGroup(props: {
  activities: RunActivity[];
  /** True while the owning run is still executing. */
  live?: boolean;
  unavailableReason?: string | null;
}): React.JSX.Element | null {
  const activities = props.activities;
  const noteworthyCount = activities.filter((item) => isAttentionWorthy(item)).length;
  // Keep hooks unconditional: a live run can legitimately transition from
  // zero activity facts to its first event after this component mounts.
  const [collapsed, setCollapsed] = useState(
    () => !props.live && noteworthyCount === 0 && activities.length > 4);
  if (props.unavailableReason) {
    return <div className="activity-group activity-unavailable" data-testid="activity-unavailable">当前服务未提供执行明细（{props.unavailableReason}）</div>;
  }
  if (activities.length === 0) return null;
  const runningCount = activities.filter((item) => item.status === 'RUNNING').length;
  // A finished, all-successful trace folds to one summary line: conclusions
  // and the composer stay visible, details open on demand. Anything
  // noteworthy (failure, running, approval-wait) keeps the block open.
  // Long sessions collapse to the interesting rows: failures, running and
  // approval-waiting stay visible, plain successes fold into one summary row.
  const COLLAPSE_AFTER = 8;
  const folded = !props.live && activities.length > COLLAPSE_AFTER;
  const visible = folded
    ? activities.filter(isAttentionWorthy)
    : activities;
  const hiddenSuccesses = folded ? activities.length - visible.length : 0;
  const groups = groupActivities(visible.length > 0 || !folded ? visible : activities.slice(0, COLLAPSE_AFTER));
  const successCount = activities.length - noteworthyCount;
  return (
    <div className={`activity-group${props.live ? ' activity-group-live' : ''}${collapsed ? ' activity-group-collapsed' : ''}`} data-testid="activity-group">
      <button
        type="button"
        className="activity-group-head"
        aria-expanded={!collapsed}
        onClick={() => setCollapsed((current) => !current)}
        title={collapsed ? '展开执行过程' : '收起执行过程'}
      >
        <span className="fold-caret" aria-hidden="true">{collapsed ? '▸' : '▾'}</span>
        <span className="eyebrow">执行</span>
        <span className="activity-group-title">
          执行过程 · {activities.length} 步
          {runningCount > 0 ? ` · 进行中 ${runningCount}` : ''}
          {collapsed && successCount > 0 ? ` · 已成功 ${successCount}` : ''}
        </span>
        <span className="activity-batch-hint">{collapsed ? '展开查看' : '收起'}</span>
      </button>
      {!collapsed ? (
      <div className="activity-group-body">
        {hiddenSuccesses > 0 ? <p className="run-meta activity-fold-note">已成功 {hiddenSuccesses} 步已收起，只保留需要注意的行。</p> : null}
        {groups.map((group) => group.kind === 'SINGLE'
          ? group.items.map((item) => (
             <ActivityRow key={item.activityId} activity={item} kindLabel={group.kindLabel} defaultOpen={isAttentionWorthy(item)} />
          ))
          : (
            <details key={group.key} className="activity-batch" open={!group.collapsedByDefault}>
              <summary className="activity-row-head">
                <span className="activity-status-glyph" aria-hidden="true">✓</span>
                <span className="activity-row-title">{group.kindLabel} · {group.items.length}</span>
                <span className="activity-row-meta activity-batch-hint">展开查看</span>
              </summary>
              <div className="activity-row-body">
                <ul className="activity-targets">
                  {group.items.map((item) => {
                    const label = item.detail ?? item.resultSummary ?? item.toolName ?? item.activityId;
                    return (
                      <li key={item.activityId} className="activity-target status-succeeded">
                        <span className="activity-status-glyph" aria-hidden="true">✓</span>
                        <code title={label ?? undefined}>{shortenTargetRef(label ?? '')}</code>
                      </li>
                    );
                  })}
                </ul>
              </div>
            </details>
          ))}
      </div>
      ) : null}
    </div>
  );
}
