import { describe, expect, it } from 'vitest';
import { deriveRunDisplayModel, groupActivitiesByPurpose, type RunDisplayInput } from '../../src/renderer/app/activity/runDisplayModel';
import type { RunActivity } from '../../src/renderer/app/activity/activityTypes';

type TestRun = NonNullable<RunDisplayInput['run']>;

function run(overrides: Partial<TestRun> = {}): TestRun {
  return { runId: 'run-1', state: 'RUNNING', ...overrides };
}

function activity(id: string, overrides: Partial<RunActivity> = {}): RunActivity {
  return { activityId: id, runId: 'run-1', kind: 'COMMAND', status: 'RUNNING', ...overrides };
}

describe('run display model', () => {
  it('keeps a local submission visible before a Run exists', () => {
    const model = deriveRunDisplayModel({ sessionId: 'session-1', run: null, activities: [], submitting: true, nowMs: 10 });
    expect(model.phase).toBe('SUBMITTING');
    expect(model.headline).toBe('正在提交…');
    expect(model.canRequestStop).toBe(false);
  });

  it('keeps an ordinary command approval visible even without a Run DTO', () => {
    const model = deriveRunDisplayModel({ sessionId: 'session-1', run: null, activities: [], approvalPending: true, nowMs: 10 });
    expect(model.phase).toBe('WAITING_APPROVAL');
    expect(model.canLocateApproval).toBe(true);
  });

  it('applies terminal state before stale activities or a stop request', () => {
    const model = deriveRunDisplayModel({
      sessionId: 'session-1',
      run: run({ state: 'SUCCEEDED', durationMillis: 4200 }),
      activities: [activity('a1')], stopRequested: true, nowMs: 10000
    });
    expect(model.phase).toBe('SUCCEEDED');
    expect(model.elapsedMs).toBe(4200);
    expect(model.canRequestStop).toBe(false);
  });

  it('does not confuse approval waiting with execution', () => {
    const model = deriveRunDisplayModel({
      sessionId: 'session-1', run: run({ state: 'WAITING_APPROVAL' }),
      activities: [activity('a1')], approvalPending: true, nowMs: 10000
    });
    expect(model.phase).toBe('WAITING_APPROVAL');
    expect(model.headline).toBe('等待你的批准');
    expect(model.canRequestStop).toBe(false);
    expect(model.canLocateApproval).toBe(true);
  });

  it('shows a retryable pause as resumable instead of an unknown running state', () => {
    const model = deriveRunDisplayModel({
      sessionId: 'session-1',
      run: run({ state: 'PAUSED', sourceStatus: 'PAUSED_RETRYABLE', startedAt: '2026-09-20T13:27:55.519Z' }),
      activities: [], observedStartedAt: 4000, nowMs: 999999
    });
    expect(model.phase).toBe('PAUSED');
    expect(model.headline).toBe('已暂停，可继续');
    expect(model.noNewOutputSeconds).toBeNull();
    expect(model.canRequestStop).toBe(false);
    expect(model.elapsedMs).toBeNull();
  });

  it('uses an observed clock only when service timing is absent', () => {
    const model = deriveRunDisplayModel({
      sessionId: 'session-1', run: run(), activities: [], observedStartedAt: 4000, nowMs: 19000
    });
    expect(model.elapsedMs).toBe(15000);
    expect(model.elapsedEstimated).toBe(true);
    expect(model.headline).toContain('等待执行明细');
  });

  it('reports silence from activity/output changes, not service heartbeats', () => {
    const model = deriveRunDisplayModel({
      sessionId: 'session-1', run: run(), activities: [], lastContentObservedAt: 0, nowMs: 61000
    });
    expect(model.noNewOutputSeconds).toBe(61);
  });
});

describe('purpose grouping', () => {
  it('does not infer purposes when the service omits a stable group id', () => {
    const groups = groupActivitiesByPurpose([activity('a1'), activity('a2', { kind: 'FILE_READ' })]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.groupId).toBeNull();
    expect(groups[0]?.activities.map((item) => item.activityId)).toEqual(['a1', 'a2']);
  });

  it('keeps structured purposes separate and preserves repeated group instances', () => {
    const groups = groupActivitiesByPurpose([
      activity('a1', { groupId: 'locate', groupPurpose: '定位问题', groupStartNote: '先检查原因。' }),
      activity('a2', { groupId: 'locate' }),
      activity('a3', { groupId: 'verify', groupPurpose: '验证修复' }),
      activity('a4', { groupId: 'locate' })
    ]);
    expect(groups.map((group) => group.groupId)).toEqual(['locate', 'verify', 'locate']);
    expect(groups.map((group) => group.key)).toEqual([
      'run-1:locate:1', 'run-1:verify:1', 'run-1:locate:2'
    ]);
    expect(groups[0]?.startNote).toBe('先检查原因。');
  });
});
