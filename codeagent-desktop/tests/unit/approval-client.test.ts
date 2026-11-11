import { describe, expect, it } from 'vitest';
import { ServiceClient } from '../../packages/service-client/src/index';

describe('unified permission service client', () => {
  it('uses typed v2 routes and preserves idempotency headers', async () => {
    const requests: Array<{ path: string; method: string; body?: string; key?: string }> = [];
    const bodies = [
      { principalId: 'p1', projectId: 'project-1', revision: 1, mode: 'STANDARD', managedModeCeiling: 'FULL_ACCESS', supportedModes: ['STANDARD', 'AUTO_APPROVE', 'FULL_ACCESS'], routineDelayMillis: 5_000, planDelayMillis: 10_000, budgetDelayMillis: [30_000], maxAutomaticBudgetApprovals: 3, approvalTtlMillis: 600_000, fullAccessConfirmed: false, policyFingerprint: 'pf-1', serverTime: '2026-09-04T12:00:00Z' },
      { principalId: 'p1', projectId: 'project-1', revision: 2, mode: 'FULL_ACCESS', managedModeCeiling: 'FULL_ACCESS', supportedModes: ['STANDARD', 'AUTO_APPROVE', 'FULL_ACCESS'], routineDelayMillis: 5_000, planDelayMillis: 10_000, budgetDelayMillis: [30_000], maxAutomaticBudgetApprovals: 3, approvalTtlMillis: 600_000, fullAccessConfirmed: true, policyFingerprint: 'pf-2', serverTime: '2026-09-04T12:00:01Z' },
      { items: [], serverTime: '2026-09-04T12:00:02Z', projectionVersion: 1 },
      { approvalId: 'a1', sessionId: 's1', runId: 'r1', agentId: 'agent', kind: 'WRITE', domainRef: 'src/a.ts', domainVersion: 1, requestVersion: 1, decisionStatus: 'PENDING', executionStatus: 'NOT_STARTED', requestFingerprint: 'rf-1', policyFingerprint: 'pf-2', grantRevision: 1, riskCategory: 'NONE', publicSummary: 'write', expiresAt: '2026-09-04T12:10:00Z', serverTime: '2026-09-04T12:00:02Z', allowedActions: ['APPROVE', 'DENY'], version: 1 },
      { approvalId: 'a1', decisionStatus: 'APPROVED' },
      { approvalId: 'a1', decisionStatus: 'APPROVED' },
      { approvalId: 'a1', decisionStatus: 'CANCELLED' },
      { schemaVersion: 'execution-automation-control/1', principalId: 'p1', sessionId: 's1', paused: false, version: 1, updatedAtMillis: 1, serverTime: '2026-09-04T12:00:03Z' },
      { schemaVersion: 'execution-automation-control/1', principalId: 'p1', sessionId: 's1', paused: true, version: 2, updatedAtMillis: 2, serverTime: '2026-09-04T12:00:04Z' }
    ];
    let index = 0;
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      requests.push({ path: new URL(url).pathname, method: init?.method ?? 'GET', body: typeof init?.body === 'string' ? init.body : undefined, key: new Headers(init?.headers).get('idempotency-key') ?? undefined });
      return new Response(JSON.stringify(bodies[index++]), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const client = new ServiceClient({ baseUrl: 'http://service.test', token: 'token', fetchImpl });
    await client.getExecutionPolicy('s1');
    await client.updateExecutionPolicy('s1', { expectedRevision: 1, requestedMode: 'FULL_ACCESS', fullAccessConfirmation: true }, 'mode-key');
    await client.listApprovals('s1', { cursor: 'c', limit: 20 });
    await client.getApproval('a1');
    await client.decideApproval('a1', { expectedVersion: 1, fingerprint: 'rf-1', decision: 'APPROVE' }, 'decision-key');
    await client.advanceApproval('a1', { expectedVersion: 1, fingerprint: 'rf-1' }, 'advance-key');
    await client.controlApproval('a1', { expectedVersion: 1, requestFingerprint: 'rf-1', control: 'CANCEL' }, 'control-key');
    await client.getAutomationControl('s1');
    await client.controlAutomation('s1', { expectedVersion: 1, control: 'PAUSE_AUTOMATION' }, 'automation-key');

    expect(requests.map((request) => `${request.method} ${request.path}`)).toEqual([
      'GET /api/v2/sessions/s1/execution-policy',
      'PUT /api/v2/sessions/s1/execution-policy',
      'GET /api/v2/sessions/s1/approvals',
      'GET /api/v2/approvals/a1',
      'POST /api/v2/approvals/a1/decisions',
      'POST /api/v2/approvals/a1/advance',
      'POST /api/v2/approvals/a1/controls',
      'GET /api/v2/sessions/s1/automation-controls',
      'POST /api/v2/sessions/s1/automation-controls'
    ]);
    expect(requests[1]?.key).toBe('mode-key');
    expect(requests[4]?.key).toBe('decision-key');
    expect(requests[5]?.key).toBe('advance-key');
    expect(requests[6]?.key).toBe('control-key');
    expect(requests[8]?.key).toBe('automation-key');
    expect(JSON.parse(requests[1]?.body ?? '{}').fullAccessConfirmation).toBe(true);
  });
});
