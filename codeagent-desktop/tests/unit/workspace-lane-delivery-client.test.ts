import { describe, expect, it } from 'vitest';
import { ServiceClient } from '../../packages/service-client/src/index';

describe('workspace lane and delivery service client', () => {
  it('uses v2 lane/delivery routes and preserves mutation idempotency', async () => {
    const requests: Array<{ method: string; path: string; key?: string; body?: string }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      requests.push({
        method: init?.method ?? 'GET',
        path: new URL(url).pathname,
        key: new Headers(init?.headers).get('idempotency-key') ?? undefined,
        body: typeof init?.body === 'string' ? init.body : undefined
      });
      return new Response(JSON.stringify({
        workspaceLaneId: 'lane-1', projectId: 'project-1', state: 'READY', stateVersion: 1,
        deliveryId: 'delivery-1', receipt: { outcome: 'UNKNOWN' },
        delivery: { deliveryId: 'delivery-1', projectId: 'project-1', workspaceLaneId: 'lane-1', state: 'UNKNOWN', stateVersion: 2 }
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const client = new ServiceClient({ baseUrl: 'http://service.test', token: 'token', fetchImpl });

    await client.createWorkspaceLane({ sessionId: 'session-1', projectId: 'project-1' }, 'lane-create');
    await client.getWorkspaceLane('lane-1');
    await client.bindWorkspaceLane('lane-1', { sessionId: 'session-1', runId: 'run-1' }, 'lane-bind');
    await client.reopenWorkspaceLane('lane-1', { sessionId: 'session-1', runId: 'run-2' }, 'lane-reopen');
    await client.releaseWorkspaceLane('lane-1', { sessionId: 'session-1', runId: 'run-2', leaseId: 'lease-1', fencingToken: 2 }, 'lane-release');
    await client.createDelivery({ projectId: 'project-1', workspaceLaneId: 'lane-1' }, 'delivery-create');
    await client.getDelivery('delivery-1');
    await client.getDeliveryChanges('delivery-1');
    await client.prepareDelivery('delivery-1', { expectedStateVersion: 1 }, 'delivery-prepare');
    await client.decideDelivery('delivery-1', { decision: 'APPROVE', expectedStateVersion: 2, approvalFingerprint: 'approval-1' }, 'delivery-decide');
    await client.applyDelivery('delivery-1', { expectedStateVersion: 3, approvalFingerprint: 'approval-1' }, 'delivery-apply');
    await client.reconcileDelivery('delivery-1', { expectedStateVersion: 4, reconcileRef: 'journal-1' }, 'delivery-reconcile');
    await client.listProjectDeliveries('project-1', { cursor: 'next', limit: 10 });

    expect(requests.map((r) => `${r.method} ${r.path}`)).toEqual([
      'POST /api/v2/workspace-lanes',
      'GET /api/v2/workspace-lanes/lane-1',
      'POST /api/v2/workspace-lanes/lane-1/bind',
      'POST /api/v2/workspace-lanes/lane-1/reopen',
      'POST /api/v2/workspace-lanes/lane-1/release',
      'POST /api/v2/deliveries',
      'GET /api/v2/deliveries/delivery-1',
      'GET /api/v2/deliveries/delivery-1/changes',
      'POST /api/v2/deliveries/delivery-1/prepare',
      'POST /api/v2/deliveries/delivery-1/decisions',
      'POST /api/v2/deliveries/delivery-1/apply',
      'POST /api/v2/deliveries/delivery-1/reconcile',
      'GET /api/v2/projects/project-1/deliveries'
    ]);
    expect(requests[0]?.key).toBe('lane-create');
    expect(requests[4]?.key).toBe('lane-release');
    expect(requests[11]?.key).toBe('delivery-reconcile');
    expect(JSON.parse(requests[11]?.body ?? '{}').reconcileRef).toBe('journal-1');
  });
});
