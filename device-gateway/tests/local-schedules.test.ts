import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { LocalSchedules, nextLocalFire } from '../src/local-schedules';
import type { LocalResult, LocalTaskAccess } from '../src/local-tasks';
import { GatewayStore } from '../src/store';

const target = { backendStoreId: 'native-bridge', projectId: 'project', engineId: 'codex' };
const native = 'native-schedule-remembered';
const initial = Date.parse('2026-11-21T00:00:00Z');
const request = { requestKey: 'local-test', target, instruction: 'Run only this scheduled instruction',
  timezone: 'UTC', schedule: { kind: 'interval', everySeconds: 300 }, catchUpSeconds: 600 };

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'link-local-schedules-'));
  let store = new GatewayStore(root);
  let now = initial;
  let submissions = 0;
  let receiptKey: string | undefined;
  let revealReceipt = false;
  let afterPreflight: (() => Promise<void>) | undefined;
  const tasks: Pick<LocalTaskAccess, 'nativeCall' | 'linkTargets' | 'ownerCatalog'> = {
    ownerCatalog: async () => ({}),
    linkTargets: () => ({ targets: [{ sourceKind: 'NATIVE', backendId: target.backendStoreId,
      projectId: target.projectId, engineId: target.engineId }] }),
    nativeCall: async (backend, method, tail, body, key, _deadline, recheck): Promise<LocalResult> => {
      expect(backend).toBe(target.backendStoreId);
      if (tail === '/task-preflights') {
        expect(body).toEqual({ projectId: target.projectId, engineId: target.engineId });
        await afterPreflight?.();
        return { status: 200, body: { optionsRevision: 'checked-options' } };
      }
      if (tail === '/tasks' && method === 'POST') {
        recheck?.();
        submissions++;
        receiptKey = key;
        expect(body).toEqual({ requestKey: key, projectId: target.projectId, engineId: target.engineId,
          optionsRevision: 'checked-options', instruction: request.instruction });
        throw Error('the source accepted the original request before the response was interrupted');
      }
      if (tail === `/task-requests/${receiptKey}`) {
        if (!revealReceipt) return { status: 404, body: { code: 'REQUEST_NOT_FOUND' } };
        return { status: 200, body: { requestKey: receiptKey, taskId: native, operation: 'LAUNCH',
          state: 'ACCEPTED', result: { taskId: native, engineId: target.engineId } } };
      }
      expect(tail).toBe(`/tasks/${native}`);
      return { status: 200, body: { taskId: native, state: 'SUCCEEDED' } };
    },
  };
  const build = () => new LocalSchedules(store, 'linux-link', tasks, undefined, () => now);
  return { build, advance: (ms: number) => { now += ms; }, count: () => submissions,
    reveal: () => { revealReceipt = true; }, onPreflight: (hook: () => Promise<void>) => { afterPreflight = hook; },
    stored: (kind: string, ruleId: string) => store.get<Record<string, unknown>>(kind, ruleId),
    restart: () => { store.close(); store = new GatewayStore(root); return build(); },
    close: () => { store.close(); rmSync(root, { recursive: true, force: true }); } };
}

it('fences the old store kind, recovers an ownership transfer and never reuses a trigger sequence', async () => {
  const f = fixture();
  try {
    let scheduler = f.build();
    const ruleId = (await scheduler.create(request)).ruleId as string;
    f.advance(300_000);
    await scheduler.tick();
    expect(() => scheduler.releaseOwnership(ruleId, 'member-a', 'outbound', 1))
      .toThrowError(expect.objectContaining({ code: 'SCHEDULE_WORK_IN_PROGRESS' }));
    f.reveal();
    await scheduler.tick();
    await scheduler.tick();
    expect(f.count()).toBe(1);

    const release = scheduler.releaseOwnership(ruleId, 'member-a', 'outbound', 1);
    expect(release).toMatchObject({ sourceEpoch: 1, configuration: { sequence: 1, paused: false } });
    expect(f.stored('local-schedule-rules', ruleId)).toMatchObject({ removed: true, paused: true });
    expect(scheduler.get(ruleId)).toMatchObject({ removed: true, transferred: true });
    scheduler = f.restart();
    expect(scheduler.pendingOwnershipRelease(ruleId, 'member-a', 'outbound', 1)).toEqual(release);
    expect(() => scheduler.releaseOwnership(ruleId, 'member-b', 'outbound', 1))
      .toThrowError(expect.objectContaining({ code: 'CLOUD_SESSION_CHANGED' }));

    const returned = { ...(release.configuration as Record<string, unknown>), sequence: 2 };
    await expect(scheduler.acquireOwnership(ruleId, 'member-a', 'inbound', 2, returned))
      .rejects.toMatchObject({ code: 'SCHEDULE_OWNERSHIP_CONFLICT' });
    const adopted = await scheduler.acquireOwnership(ruleId, 'member-a', 'inbound', 3, returned);
    expect(adopted).toMatchObject({ ruleId, sequence: 2, epoch: 3, removed: false });
    expect(f.stored('local-schedule-rules', ruleId)).toMatchObject({ removed: true, paused: true });
    expect((scheduler.list().items as unknown[])).toHaveLength(1);
    expect(await scheduler.acquireOwnership(ruleId, 'member-a', 'inbound', 3, returned)).toEqual(adopted);
    f.advance(300_000);
    await scheduler.tick();
    expect(f.count()).toBe(2);
    expect((scheduler.occurrences(ruleId).items as Array<{ sequence: number }>).map(o => o.sequence)).toEqual([3, 1]);
  } finally {
    f.close();
  }
});

it('uses the Hosted DST gap and first-fold semantics for local wall-clock schedules', () => {
  const timezone = 'America/New_York';
  const spring = { schedule: { kind: 'daily', timeOfDay: '02:30' } as const, timezone, dstPolicy: 'fire' as const };
  const beforeGap = Date.parse('2026-03-08T05:00:00Z');
  expect(nextLocalFire(spring, beforeGap)).toBe(Date.parse('2026-03-08T07:30:00Z'));
  expect(nextLocalFire({ ...spring, dstPolicy: 'skip' }, beforeGap)).toBe(Date.parse('2026-03-09T06:30:00Z'));
  const fold = { ...spring, schedule: { kind: 'weekly', dayOfWeek: 6, timeOfDay: '01:30' } as const };
  const first = Date.parse('2026-11-01T05:30:00Z');
  expect(nextLocalFire(fold, first - 1)).toBe(first);
  expect(nextLocalFire(fold, first)).toBe(Date.parse('2026-11-08T06:30:00Z'));
});

it('recovers the original Worker receipt while stopped rules never start a second task', async () => {
  const f = fixture();
  try {
    let scheduler = f.build();
    const original = await scheduler.create(request);
    const ruleId = original.ruleId as string;
    await expect(scheduler.create(request)).resolves.toEqual(original);
    await expect(scheduler.create({ ...request, instruction: 'changed' })).rejects.toMatchObject({
      code: 'IDEMPOTENCY_PAYLOAD_MISMATCH',
    });
    await expect(scheduler.update(ruleId, { expectedRevision: 2, paused: true })).rejects.toMatchObject({
      code: 'REVISION_CONFLICT',
    });
    f.advance(300_000);
    await scheduler.tick();
    expect(f.count()).toBe(1);
    expect(scheduler.occurrences(ruleId)).toMatchObject({ items: [{ state: 'submitting', sequence: 1 }] });
    scheduler = f.restart();
    await scheduler.tick();
    expect(f.count()).toBe(1);
    await scheduler.update(ruleId, { expectedRevision: 1 }, true);
    f.reveal();
    await scheduler.tick();
    await scheduler.tick();
    expect(scheduler.occurrences(ruleId)).toMatchObject({
      items: [{ state: 'succeeded', taskId: native, sequence: 1 }],
    });
    expect(scheduler.list()).toMatchObject({ items: [] });
    f.advance(800_000);
    await scheduler.tick();
    expect(f.count()).toBe(1);
  } finally { f.close(); }
});

it('cancels a pending occurrence when the owner pauses during preflight', async () => {
  const f = fixture();
  try {
    const scheduler = f.build();
    const { ruleId } = await scheduler.create(request);
    f.onPreflight(async () => {
      await scheduler.update(ruleId as string, { expectedRevision: 1, paused: true });
    });
    f.advance(300_000);
    await scheduler.tick();
    expect(f.count()).toBe(0);
    expect(scheduler.occurrences(ruleId as string)).toMatchObject({ items: [{ state: 'cancelled' }] });
  } finally { f.close(); }
});

it('skips offline occurrences and does not enqueue an expired backlog', async () => {
  const f = fixture();
  try {
    let scheduler = f.build();
    const skip = await scheduler.create({ ...request, offlinePolicy: 'skip', catchUpSeconds: 3600 });
    const missed = await scheduler.create({ ...request, requestKey: 'missed', catchUpSeconds: 0 });
    f.advance(310_000);
    scheduler = f.restart();
    await scheduler.tick();
    expect(scheduler.occurrences(skip.ruleId as string)).toMatchObject({ items: [{ state: 'skipped' }] });
    expect(scheduler.occurrences(missed.ruleId as string)).toMatchObject({ items: [{ state: 'missed' }] });
    expect(f.count()).toBe(0);
  } finally { f.close(); }
});
