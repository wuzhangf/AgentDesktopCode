import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import type { GatewayAuth, GatewayLocalTasks } from '../src/context';
import { fail, type Device } from '../src/protocol';
import { GatewayStore } from '../src/store';
import { WorkHandoffAccess } from '../src/work-handoffs';

it('a restarted native coordinator advances only confirmed work with the original live grant', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'native-handoff-background-'));
  const future = Date.now() + 60_000;
  const handoff = {
    deviceId: 'device', requestKey: 'original', phase: 'SOURCE_SEALING',
    sourceKind: 'WORKER_LOCAL', sourceStoreId: 'source', sourceTaskId: 'task',
    sourceEngineId: 'sage-pi', targetHostKey: 'local', targetKind: 'WORKER_LOCAL',
    targetStoreId: 'target', targetProjectRef: 'project', targetEngineId: 'sage-pi',
    grantRevision: 5, backgroundGrantRevision: 5, backgroundUntil: future,
    updatedAt: 1,
  };
  const current: Device = {
    id: 'device', state: 'ACTIVE', scopeVersion: 1, revision: 5,
    accessExpiry: 0, absoluteExpiry: future, idleExpiry: future,
    recoverUntil: 0, spentRefresh: [],
    actions: ['OBSERVE', 'HANDOFF', 'LAUNCH'],
    resources: [{ kind: 'WORKER_LOCAL', backendStoreId: 'source', taskId: 'task' }],
    launchScopes: [{ backendStoreId: 'target', projectId: 'project', engineId: 'sage-pi' }],
  };
  const nativeCall = vi.fn(async () => fail('TARGET_PREFLIGHT_REJECTED', 409));
  const local = { nativeCall } as unknown as GatewayLocalTasks;
  const auth = {
    activeDevice: vi.fn((id: string) => {
      if (id === 'revoked') fail('DEVICE_REVOKED', 401);
      if (id === 'changed') return { ...current, id, revision: 6 };
      if (id === 'missing-scope') return { ...current, id, launchScopes: [] };
      return current;
    }),
  } as unknown as GatewayAuth;
  let store = new GatewayStore(dir);
  try {
    const cases = [
      { handoffId: 'unconfirmed', phase: 'AWAITING_CONFIRM' },
      { handoffId: 'expired', backgroundUntil: 1 },
      { handoffId: 'revoked', deviceId: 'revoked' },
      { handoffId: 'changed', deviceId: 'changed' },
      { handoffId: 'missing-scope', deviceId: 'missing-scope' },
      { handoffId: 'confirmed' },
    ];
    for (const fields of cases) {
      const row = { ...handoff, ...fields };
      store.put('local-handoff', `${row.deviceId}:${row.handoffId}`, row);
    }
    store.close();
    store = new GatewayStore(dir);
    const coordinator = new WorkHandoffAccess(store, auth, undefined, local, dir, dir, 'fixture');
    await coordinator.advanceConfirmedLocalHandoffs();
    expect(nativeCall).toHaveBeenCalledTimes(1);
    expect(nativeCall).toHaveBeenCalledWith(
      'target', 'POST', '/task-preflights', { projectId: 'project', engineId: 'sage-pi' }, undefined,
    );
    expect(store.get('local-handoff', 'device:confirmed')).toMatchObject({
      failureCode: 'TARGET_PREFLIGHT_REJECTED', phase: 'SOURCE_SEALING',
    });
    for (const id of ['revoked', 'changed', 'missing-scope']) {
      const row = store.get<Record<string, unknown>>('local-handoff', `${id}:${id}`);
      expect(row?.backgroundUntil).toBeUndefined();
      expect(row?.phase).toBe('SOURCE_SEALING');
    }
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
