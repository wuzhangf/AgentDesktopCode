import { describe, expect, it } from 'vitest';
import { groupActivities } from '../../src/renderer/app/activity/activityPresentation';
import { shortenTargetRef } from '../../src/renderer/app/conversation/ToolActivityGroup';
import type { RunActivity } from '../../src/renderer/app/activity/activityTypes';

function item(id: string, kind: string, status = 'SUCCEEDED'): RunActivity {
  return { activityId: id, runId: 'run-1', kind, status };
}

describe('activity folding', () => {
  it('batches consecutive same-kind successes regardless of kind', () => {
    const groups = groupActivities([
      item('a1', 'WORKSPACE_ANALYSIS'),
      item('a2', 'WORKSPACE_ANALYSIS'),
      item('a3', 'WORKSPACE_ANALYSIS')
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.kind).toBe('BATCH');
    expect(groups[0]?.collapsedByDefault).toBe(true);
    expect(groups[0]?.items).toHaveLength(3);
  });

  it('keeps failures and running items as single rows', () => {
    const groups = groupActivities([
      item('a1', 'WORKSPACE_ANALYSIS'),
      item('a2', 'WORKSPACE_ANALYSIS', 'FAILED'),
      item('a3', 'COMMAND', 'RUNNING')
    ]);
    expect(groups.every((g) => g.kind === 'SINGLE')).toBe(true);
    expect(groups.every((g) => g.collapsedByDefault === false)).toBe(true);
  });

  it('keeps every delegation child visible with its own status', () => {
    const groups = groupActivities([
      item('child-1', 'DELEGATION', 'SUCCEEDED'),
      item('child-2', 'DELEGATION', 'FAILED'),
      item('child-3', 'DELEGATION', 'PARTIAL')
    ]);
    expect(groups).toHaveLength(3);
    expect(groups.every((group) => group.items.length === 1)).toBe(true);
  });

  it('shortens long target refs to the file name', () => {
    const long = 'spring-petclinic-customers-service/src/main/java/org/springframework/samples/petclinic/customers/web/mapper/Mapper.java';
    const short = shortenTargetRef(long);
    expect(short.length).toBeLessThan(long.length);
    expect(short).toContain('Mapper.java');
    expect(shortenTargetRef('short.txt')).toBe('short.txt');
  });
});
