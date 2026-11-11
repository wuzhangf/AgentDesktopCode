import { describe, expect, it } from 'vitest';
import { ServiceClient, ServiceProblem } from '../../packages/service-client/src/index';
import { PERSONAL_ID_PATTERN } from '../../packages/protocol/src/personal';

const META = {
  source: 'management', instance: 'local', controlPlaneId: 'cp-1',
  observedAt: '2026-10-18T00:00:00Z', revision: '1',
  supportedActions: ['PREPARE'], reasonCodes: []
};
const envelope = (data: unknown) => JSON.stringify({ meta: META, data });

interface RecordedRequest { method: string; path: string; key?: string; body?: Record<string, unknown> }

function recordingClient(respond: (request: RecordedRequest) => { status?: number; body: string }) {
  const requests: RecordedRequest[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const recorded: RecordedRequest = {
      method: init?.method ?? 'GET',
      path: new URL(url).pathname + new URL(url).search,
      key: new Headers(init?.headers).get('idempotency-key') ?? undefined,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : undefined
    };
    requests.push(recorded);
    const reply = respond(recorded);
    return new Response(reply.body, { status: reply.status ?? 200, headers: { 'content-type': 'application/json' } });
  };
  return { requests, client: new ServiceClient({ baseUrl: 'http://gateway.test', token: 'token', fetchImpl }) };
}

describe('personal gateway service client (/api/personal/v1, PAE P0 freeze §4)', () => {
  it('calls the frozen read paths', async () => {
    const { requests, client } = recordingClient(() => ({ body: envelope({}) }));
    await client.personalOverview();
    await client.personalListProjects();
    await client.personalGetProject('project-1');
    await client.personalGetProjectEnvironment('project-1');
    await client.personalGetEnvironmentOperation('op-1');
    await client.personalGetEnvironmentOperationEvents('op-1', { cursor: 'c1', limit: 50 });
    await client.personalListWorkers();
    await client.personalGetWorker('worker-1');
    await client.personalListTaskActions('task-1');
    await client.personalListReports();
    await client.personalGetReport('report-1');
    await client.personalListReportFiles('report-1');
    expect(requests.map((r) => `${r.method} ${r.path}`)).toEqual([
      'GET /api/personal/v1/overview',
      'GET /api/personal/v1/projects',
      'GET /api/personal/v1/projects/project-1',
      'GET /api/personal/v1/projects/project-1/environment',
      'GET /api/personal/v1/environment-operations/op-1',
      'GET /api/personal/v1/environment-operations/op-1/events?cursor=c1&limit=50',
      'GET /api/personal/v1/workers',
      'GET /api/personal/v1/workers/worker-1',
      'GET /api/personal/v1/tasks/task-1/actions',
      'GET /api/personal/v1/reports',
      'GET /api/personal/v1/reports/report-1',
      'GET /api/personal/v1/reports/report-1/files'
    ]);
    // Read paths never send a body or an idempotency key.
    expect(requests.every((r) => r.body === undefined && r.key === undefined)).toBe(true);
  });

  it('generates requestKey into the body and mirrors it as Idempotency-Key', async () => {
    const { requests, client } = recordingClient(() => ({ body: envelope({ operationId: 'op-1', state: 'QUEUED' }) }));
    await client.personalRegisterProject({ projectRef: 'project-1' });
    await client.personalPreviewEnvironmentPlan('project-1', { preferredBackend: 'OCI_DOCKER' });
    await client.personalStartEnvironmentOperation('project-1', { kind: 'PREPARE' });
    await client.personalCancelEnvironmentOperation('op-1', {});
    await client.personalRunTaskAction('task-1', 'action-1', {});
    await client.personalSaveTaskAction('task-1', 'action-1', { name: 'Nightly', scope: 'PROJECT' });
    await client.personalCreateReport({ sourceRef: 'delivery-1' });
    expect(requests.map((r) => `${r.method} ${r.path}`)).toEqual([
      'POST /api/personal/v1/projects',
      'POST /api/personal/v1/projects/project-1/environment/plans',
      'POST /api/personal/v1/projects/project-1/environment/operations',
      'POST /api/personal/v1/environment-operations/op-1/cancel',
      'POST /api/personal/v1/tasks/task-1/actions/action-1:run',
      'POST /api/personal/v1/tasks/task-1/actions/action-1:save',
      'POST /api/personal/v1/reports'
    ]);
    for (const request of requests) {
      expect(typeof request.body?.requestKey).toBe('string');
      expect(PERSONAL_ID_PATTERN.test(request.body?.requestKey as string)).toBe(true);
      expect(request.key).toBe(request.body?.requestKey);
    }
  });

  it('passes a supplied requestKey through to body and header unchanged', async () => {
    const { requests, client } = recordingClient(() => ({ body: envelope({}) }));
    await client.personalStartEnvironmentOperation('project-1', { kind: 'CLEANUP', requestKey: 'retry-key-1', expectedRevision: '4' });
    expect(requests[0]?.body?.requestKey).toBe('retry-key-1');
    expect(requests[0]?.key).toBe('retry-key-1');
    expect(requests[0]?.body?.expectedRevision).toBe('4');
    // Reusing the same key on retry keeps the idempotent identity.
    await client.personalStartEnvironmentOperation('project-1', { kind: 'CLEANUP', requestKey: 'retry-key-1', expectedRevision: '4' });
    expect(requests[1]?.key).toBe('retry-key-1');
  });

  it('routes bounded operations through the whitelist validator', async () => {
    const { requests, client } = recordingClient(() => ({ body: envelope({}) }));
    await client.personalOperation({ action: 'PROJECT_ENVIRONMENT', projectId: 'project-1' });
    await client.personalOperation({
      action: 'ENVIRONMENT_OPERATION', projectId: 'project-1', key: 'op-key-1',
      body: { requestKey: 'op-key-1', kind: 'PREPARE' }
    });
    expect(requests.map((r) => `${r.method} ${r.path}`)).toEqual([
      'GET /api/personal/v1/projects/project-1/environment',
      'POST /api/personal/v1/projects/project-1/environment/operations'
    ]);
    expect(requests[1]?.key).toBe('op-key-1');
    expect(requests[1]?.body?.requestKey).toBe('op-key-1');
    await expect(client.personalOperation({ action: 'PROJECT' } as never)).rejects.toThrow('Invalid bounded personal gateway operation');
    await expect(client.personalOperation({
      action: 'ENVIRONMENT_OPERATION', projectId: 'project-1', key: 'k',
      body: { requestKey: 'different', kind: 'PREPARE' }
    } as never)).rejects.toThrow('Invalid bounded personal gateway operation');
    expect(requests).toHaveLength(2); // rejected operations never reach fetch
  });

  it('rejects malformed ids before any request is sent', async () => {
    const { requests, client } = recordingClient(() => ({ body: envelope({}) }));
    await expect(client.personalGetProject('../escape')).rejects.toThrow();
    await expect(client.personalGetWorker('bad id')).rejects.toThrow();
    await expect(client.personalGetEnvironmentOperationEvents('op-1', { limit: 0 })).rejects.toThrow();
    await expect(client.personalGetEnvironmentOperationEvents('op-1', { limit: 999 })).rejects.toThrow();
    expect(requests).toHaveLength(0);
  });

  it('fails closed on a malformed envelope', async () => {
    const { client } = recordingClient(() => ({ body: JSON.stringify({ data: { ok: true } }) }));
    await expect(client.personalOverview()).rejects.toMatchObject({ name: 'ServiceProblem', code: 'PROTOCOL_ERROR' });
  });

  it('maps the frozen {error:{code,message,retryable,requestId}} shape into ServiceProblem', async () => {
    const { client } = recordingClient(() => ({
      status: 409,
      body: JSON.stringify({ error: { code: 'IDEMPOTENCY_CONFLICT', message: 'same key different body', retryable: false, requestId: 'req-7' } })
    }));
    const problem = await client.personalStartEnvironmentOperation('project-1', { kind: 'PREPARE' }).catch((error: unknown) => error);
    expect(problem).toBeInstanceOf(ServiceProblem);
    const serviceProblem = problem as ServiceProblem;
    expect(serviceProblem.code).toBe('IDEMPOTENCY_CONFLICT');
    expect(serviceProblem.status).toBe(409);
    expect(serviceProblem.message).toBe('same key different body');
    expect(serviceProblem.retryable).toBe(false);
    expect(serviceProblem.correlationId).toBe('req-7');
  });
});

it('routes PC-I source-scoped reads and approval decisions with the frozen key and guards',async()=>{
  const {client,requests}=recordingClient(()=>({body:envelope({})}));
  await client.personalOperation({action:'TASK_COMMANDS',taskId:'task-one',runId:'run-two',limit:'7',before:'other:command'});
  await client.personalOperation({action:'TASK_MESSAGES',taskId:'task-one',cursor:'cursor-one',limit:'30'});
  const body={kind:'APPROVAL_DECISION' as const,requestKey:'decision-key',targetRunId:'run-two',approvalId:'approval-one',source:{decision:'APPROVE' as const,expectedVersion:7,requestFingerprint:'original-fingerprint'}};
  await client.personalOperation({action:'TASK_APPROVAL_DECISION',taskId:'task-one',entityId:'approval-one',key:body.requestKey,body});
  expect(requests.map(r=>r.path)).toEqual(['/api/personal/v1/tasks/task-one/commands?limit=7&before=other%3Acommand&runId=run-two','/api/personal/v1/tasks/task-one/messages?cursor=cursor-one&limit=30','/api/personal/v1/tasks/task-one/approvals/approval-one/decisions']);
  expect(requests[2]).toMatchObject({key:'decision-key',body});
  await expect(client.personalOperation({action:'TASK_APPROVAL_DECISION',taskId:'task-one',entityId:'another-approval',key:body.requestKey,body})).rejects.toThrow('Invalid bounded');
});

// 新增：native-messages/1 paging — the fixed TASK_MESSAGES operation is the
// only operation that serializes `before` into the whitelisted query.
it('serializes native-messages/1 before only on the fixed TASK_MESSAGES operation',async()=>{
  const {client,requests}=recordingClient(()=>({body:envelope({})}));
  await client.personalOperation({action:'TASK_MESSAGES',taskId:'task-one',before:'9',limit:'20'});
  await client.personalOperation({action:'TASK_MESSAGES',taskId:'task-one',cursor:'42'});
  expect(requests.map(r=>r.path)).toEqual(['/api/personal/v1/tasks/task-one/messages?limit=20&before=9','/api/personal/v1/tasks/task-one/messages?cursor=42']);
  await expect(client.personalOperation({action:'TASK_MESSAGES',taskId:'task-one',before:'abc'})).rejects.toThrow('Invalid bounded');
  await expect(client.personalOperation({action:'TASK_MESSAGES',taskId:'task-one',cursor:'12',before:'9'})).rejects.toThrow('Invalid bounded');
  await expect(client.personalOperation({action:'TASK_MESSAGES',taskId:'task-one',before:'0'})).rejects.toThrow('Invalid bounded');
  await expect(client.personalOperation({action:'TASK_MESSAGES',taskId:'task-one',limit:'101'})).rejects.toThrow('Invalid bounded');
  expect(requests).toHaveLength(2);
});

it('adopts Mac native create through the existing personal whitelist without inventing a source route', async () => {
  const { requests, client } = recordingClient(() => ({ body: envelope({ taskId: 'task-mac', accepted: true }) }));
  const body = { requestKey: 'mac-native-create', projectId: 'project-mac', instruction: 'Run the registered Apple validation profile', engineId: 'macos' as const, optionsRevision: 'a'.repeat(64) };
  await client.personalOperation({ action: 'TASK_CREATE', key: body.requestKey, body });
  expect(requests[0]).toMatchObject({ method: 'POST', path: '/api/personal/v1/tasks', key: body.requestKey, body });
  expect(requests[0]?.body).not.toHaveProperty('macVerificationSpec');
  await expect(client.personalOperation({ action: 'TASK_CREATE', key: body.requestKey, body: { ...body, engineId: 'future' } } as never)).rejects.toThrow('Invalid bounded personal gateway operation');
  await expect(client.personalOperation({ action: 'TASK_CREATE', key: body.requestKey, body: { ...body, executable: '/bin/sh' } } as never)).rejects.toThrow('Invalid bounded personal gateway operation');
  expect(requests).toHaveLength(1);
});
