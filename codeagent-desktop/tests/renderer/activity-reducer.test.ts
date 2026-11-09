// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import {
  activitiesOf,
  mergeActivitySnapshot,
  reduceRunActivities,
  type LiveActivityProjection
} from '../../src/renderer/app/activity/activityReducer';
import type { RunActivity } from '../../src/renderer/app/activity/activityTypes';

function frame(cursor: number, type: string, payload: Record<string, unknown>) {
  return {
    cursor,
    type,
    payload: {
      runId: 'run-1',
      occurredAt: '2026-09-19T10:00:00.000Z',
      payload
    }
  };
}

function firstActivity(projection: LiveActivityProjection, runId: string): RunActivity {
  const item = activitiesOf(projection, runId)[0];
  if (!item) {
    throw new Error(`Expected an activity for run ${runId}`);
  }
  return item;
}

describe('activityReducer richer-side merge', () => {
  it('keeps start-side detail/toolName when the completion event omits them', () => {
    let projection: LiveActivityProjection = new Map();
    projection = reduceRunActivities(projection, frame(1, 'tool.started', {
      activityId: 'op-1',
      activityKind: 'CODE_SEARCH',
      toolName: 'workspace_search',
      detail: 'calc',
      roundId: 'step-1-call-2',
      roundOrdinal: 2
    }));
    projection = reduceRunActivities(projection, frame(2, 'tool.completed', {
      activityId: 'op-1',
      activityKind: 'CODE_SEARCH',
      toolName: 'workspace_search',
      status: 'SUCCEEDED',
      durationMillis: 320,
      resultSummary: 'matches 0 scanned 0'
    }));

    const item = firstActivity(projection, 'run-1');
    // The completion projection never repeats start-side action facts; the
    // merge must keep the started frame's detail or the row falls back to
    // the bare tool name ("搜索代码 workspace_search" instead of "calc").
    expect(item.detail).toBe('calc');
    expect(item.status).toBe('SUCCEEDED');
    expect(item.resultSummary).toBe('matches 0 scanned 0');
  });

  it('keeps started commandPreview and requested targets on completion', () => {
    let projection: LiveActivityProjection = new Map();
    projection = reduceRunActivities(projection, frame(1, 'tool.started', {
      activityId: 'op-2',
      activityKind: 'COMMAND',
      toolName: 'process_exec',
      capabilityId: 'com.agent.process.exec',
      detail: 'workingDirectory . executable calc',
      commandPreview: 'calc',
      requestedTargetRefs: ['src/a.ts', 'src/b.ts']
    }));
    projection = reduceRunActivities(projection, frame(2, 'tool.completed', {
      activityId: 'op-2',
      activityKind: 'COMMAND',
      toolName: 'process_exec',
      capabilityId: 'com.agent.process.exec',
      status: 'SUCCEEDED',
      durationMillis: 320,
      resultSummary: 'exitCode 0'
    }));

    const item = firstActivity(projection, 'run-1');
    expect(item.commandPreview).toBe('calc');
    expect(item.detail).toBe('workingDirectory . executable calc');
    expect(item.targets?.map((target) => target.ref)).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('backfills snapshot facts the live completion never saw', () => {
    let projection: LiveActivityProjection = new Map();
    // Live fold only observed the completion frame (join/resync mid-activity):
    // no start-side facts at all.
    projection = reduceRunActivities(projection, frame(2, 'tool.completed', {
      activityId: 'op-1',
      activityKind: 'CODE_SEARCH',
      status: 'SUCCEEDED',
      durationMillis: 320,
      resultSummary: 'matches 0 scanned 0'
    }));

    const snapshotItem: RunActivity = {
      activityId: 'op-1',
      runId: 'run-1',
      kind: 'CODE_SEARCH',
      status: 'SUCCEEDED',
      toolName: 'workspace_search',
      detail: 'calc',
      resultSummary: 'matches 0 scanned 0',
      durationMillis: 320,
      startedAt: '2026-09-19T10:00:00.000Z',
      finishedAt: '2026-09-19T10:00:01.000Z',
      startCursor: 1,
      endCursor: 2
    };
    projection = mergeActivitySnapshot(projection, {
      runId: 'run-1',
      snapshotCursor: 2,
      items: [snapshotItem]
    });

    const item = firstActivity(projection, 'run-1');
    expect(item.detail).toBe('calc');
    expect(item.toolName).toBe('workspace_search');
    expect(item.startedAt).toBe('2026-09-19T10:00:00.000Z');
    expect(item.status).toBe('SUCCEEDED');
  });

  it('unions snapshot targets with live resolved statuses', () => {
    let projection: LiveActivityProjection = new Map();
    projection = reduceRunActivities(projection, frame(2, 'tool.completed', {
      activityId: 'op-1',
      activityKind: 'FILE_READ',
      status: 'SUCCEEDED',
      succeededTargetRefs: ['src/a.ts']
    }));

    const snapshotItem: RunActivity = {
      activityId: 'op-1',
      runId: 'run-1',
      kind: 'FILE_READ',
      status: 'SUCCEEDED',
      targets: [
        { ref: 'src/a.ts', status: 'REQUESTED' },
        { ref: 'src/b.ts', status: 'REQUESTED' }
      ]
    };
    projection = mergeActivitySnapshot(projection, {
      runId: 'run-1',
      snapshotCursor: 2,
      items: [snapshotItem]
    });

    const item = firstActivity(projection, 'run-1');
    expect(item.targets).toEqual([
      { ref: 'src/a.ts', status: 'SUCCEEDED' },
      { ref: 'src/b.ts', status: 'REQUESTED' }
    ]);
  });
});
