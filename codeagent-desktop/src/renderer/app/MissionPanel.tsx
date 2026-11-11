import { useState } from 'react';
import { useMissions, type MissionLike } from './queries';

function missionStatusLabel(status: string | null | undefined): string {
  switch (status) {
    case 'READY': return '就绪';
    case 'RUNNING': return '执行中…';
    case 'PAUSED': return '已暂停';
    case 'NEEDS_ATTENTION': return '需要注意';
    case 'COMPLETED': return '已完成';
    case 'FAILED': return '已失败';
    case 'CANCELLED': return '已取消';
    default: return status ? status.replaceAll('_', ' ').toLowerCase() : '未知';
  }
}

/**
 * EW8 Mission Control panel (desktop design §13 EW8): mission list/detail
 * with DAG worker summary, budget consumption and typed commands
 * (start/pause/resume/cancel). Plan/replan approval is rendered in the
 * session approval floating panel. Fail-closed: FEATURE_DISABLED
 * renders an explicit off state; stale-version command errors surface via
 * the shared governance banner in App.
 */
export function MissionPanel(props: {
  /** null = 跨会话总览（服务端支持全局列表）；新建入口仅在会话内出现。 */
  sessionId: string | null;
  workspaceAlias: string | null;
  /** Kept for source compatibility; plan/replan decisions render in Dock. */
  onDecide?: (mission: MissionLike, decision: 'APPROVE' | 'REJECT') => void;
  onCommand: (mission: MissionLike, command: 'start' | 'pause' | 'resume' | 'cancel') => void;
  onCreate: (input: { title: string; goal: string }) => void;
  pending: boolean;
  /** 总览模式下跳到该 Mission 所属会话。 */
  onOpenSession?: (sessionId: string) => void;
}): React.JSX.Element {
  const missions = useMissions(props.sessionId);
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState('');
  const [goal, setGoal] = useState('');

  if (missions.isError) {
    const message = missions.error instanceof Error ? missions.error.message : String(missions.error);
    return (
      <section className="ew6-panel" data-testid="mission-panel">
        <h3>任务</h3>
        {(message.includes('FEATURE_DISABLED')
          || (missions.error as Error & { code?: string }).code === 'FEATURE_DISABLED') ? (
          <p className="empty" data-testid="mission-disabled">
            服务未启用 Mission（FEATURE_DISABLED），fail-closed。
          </p>
        ) : (
          <p className="error-text" data-testid="mission-error">Mission 加载失败：{message}</p>
        )}
      </section>
    );
  }

  const items = missions.data ?? [];
  return (
    <section className="ew6-panel" data-testid="mission-panel">
      <h3>
        任务编排
        <span className="run-meta"> {items.length}</span>
      </h3>
      {creating && props.sessionId ? (
        <div className="mission-create" data-testid="mission-create">
          <input
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="任务标题"
          />
          <input
            value={goal}
            onChange={(event) => setGoal(event.target.value)}
            placeholder="任务目标"
          />
          <button
            type="button"
            data-testid="mission-create-submit"
            disabled={props.pending || title.trim().length === 0 || goal.trim().length === 0}
            onClick={() => {
              props.onCreate({ title: title.trim(), goal: goal.trim() });
              setCreating(false);
              setTitle('');
              setGoal('');
            }}
          >
            创建 Mission
          </button>
          <button type="button" onClick={() => setCreating(false)}>取消</button>
        </div>
      ) : props.sessionId ? (
        <button type="button" data-testid="mission-create-open" onClick={() => setCreating(true)}>
          新建 Mission…
        </button>
      ) : null}
      <ul className="mission-list">
        {items.map((mission) => (
          <li key={mission.missionId} className="mission-item" data-testid="mission-item">
            <span className={`badge mission-state-${mission.status ?? 'UNKNOWN'}`} data-testid="mission-status">
              {missionStatusLabel(mission.status)}
            </span>
            <span className="mission-title">{mission.title ?? mission.missionId}</span>
            <span className="run-meta">
              {mission.goal ?? ''}
              {mission.consumedBudget && mission.budget
                ? ` · work items ${mission.consumedBudget.maxWorkItems ?? 0}/${mission.budget.maxWorkItems ?? 0}`
                : ''}
            </span>
            {mission.workItemStatuses && Object.keys(mission.workItemStatuses).length > 0 && (
              <div className="mission-dag" data-testid="mission-dag">
                {Object.entries(mission.workItemStatuses).map(([workItemId, status]) => (
                  <span key={workItemId} className={`badge workitem-${status}`}>
                    {workItemId}: {status}
                  </span>
                ))}
              </div>
            )}
            {mission.pendingRevisionFingerprint && (
              <span className="run-meta">待审批修订 {mission.pendingRevisionFingerprint.slice(0, 8)} · 批准/拒绝请在输入区上方处理</span>
            )}
            <span className="mission-controls">
              {!props.sessionId && props.onOpenSession ? (
                <button
                  type="button"
                  className="link-button"
                  data-testid="mission-open-session"
                  onClick={() => props.onOpenSession?.(mission.sessionId)}
                >打开会话</button>
              ) : null}
              {mission.status === 'READY' && (
                <button
                  type="button" data-testid="mission-start"
                  disabled={props.pending}
                  onClick={() => props.onCommand(mission, 'start')}
                >开始</button>
              )}
              {mission.status === 'RUNNING' && (
                <button
                  type="button" data-testid="mission-pause"
                  disabled={props.pending}
                  onClick={() => props.onCommand(mission, 'pause')}
                >暂停</button>
              )}
              {mission.status === 'PAUSED' && (
                <button
                  type="button" data-testid="mission-resume"
                  disabled={props.pending}
                  onClick={() => props.onCommand(mission, 'resume')}
                >继续</button>
              )}
              {(mission.status === 'RUNNING' || mission.status === 'PAUSED'
                  || mission.status === 'NEEDS_ATTENTION') && (
                <button
                  type="button" data-testid="mission-cancel"
                  disabled={props.pending}
                  onClick={() => props.onCommand(mission, 'cancel')}
                >取消</button>
              )}
            </span>
          </li>
        ))}
        {missions.data && items.length === 0 && (
          <li className="empty" data-testid="mission-empty">{props.sessionId ? '当前会话暂无 Mission。' : '暂无 Mission。'}</li>
        )}
      </ul>
    </section>
  );
}
