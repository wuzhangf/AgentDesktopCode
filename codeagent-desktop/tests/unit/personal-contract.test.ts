import { describe, expect, it } from 'vitest';
import {
  ADAPTIVE_ACTION_SCOPES,
  ENVIRONMENT_BACKEND_PREFERENCES,
  ENVIRONMENT_OPERATION_KINDS,
  ENVIRONMENT_OPERATION_STATES,
  ENVIRONMENT_REASON_CODES,
  ENVIRONMENT_READINESS_FACT_KINDS,
  PERSONAL_API_PREFIX,
  PERSONAL_CAPABILITY,
  PERSONAL_CONNECTION_KINDS,
  PERSONAL_ROUTES,
  PROJECTED_CHECK_STATUSES,
  decodePersonalError,
  validPersonalEnvelope,
  validPersonalOperation,
  type PersonalOperation
} from '../../packages/protocol/src/personal';

const SHA = `sha256:${'a'.repeat(64)}`;

describe('personal gateway contract (PAE P0 freeze §4)', () => {
  it('freezes the vocabulary of §2/§4', () => {
    expect(PERSONAL_API_PREFIX).toBe('/api/personal/v1');
    expect(ENVIRONMENT_OPERATION_STATES).toEqual(['QUEUED', 'RUNNING', 'NEEDS_INPUT', 'READY', 'FAILED', 'CANCELED', 'UNKNOWN']);
    expect(ENVIRONMENT_REASON_CODES).toEqual([
      'TOOLCHAIN_MISSING', 'VERSION_CONFLICT', 'DEPENDENCY_UNAVAILABLE', 'NETWORK_DENIED',
      'CREDENTIAL_REQUIRED', 'SERVICE_UNREADY', 'PLATFORM_UNSUPPORTED', 'BACKEND_UNAVAILABLE',
      'PLAN_INVALID', 'RESOURCE_EXHAUSTED', 'EFFECT_UNKNOWN'
    ]);
    expect(PERSONAL_CONNECTION_KINDS).toEqual(['CORE_LOCAL', 'DAEMON', 'ACS_DIRECT', 'WORKER_LOCAL']);
    expect(ENVIRONMENT_OPERATION_KINDS).toEqual(['PREPARE', 'CLEANUP', 'RETIRE']);
    expect(ENVIRONMENT_BACKEND_PREFERENCES).toEqual(['HOST', 'OCI_DOCKER', 'OCI_PODMAN', 'ANY']);
    expect(PROJECTED_CHECK_STATUSES).toEqual(['PASS', 'FAIL', 'BLOCKED', 'INCONCLUSIVE', 'NOT_APPLICABLE', 'DISABLED']);
    expect(ENVIRONMENT_READINESS_FACT_KINDS).toEqual(['TOOL_VERSION', 'WRITABLE_PATH', 'SERVICE_HEALTH', 'DEPENDENCY_ENTRY']);
    expect(ADAPTIVE_ACTION_SCOPES).toEqual(['TASK', 'PROJECT']);
    expect(Object.values(PERSONAL_CAPABILITY)).toEqual(['projectEnvironmentPrepareV1', 'environmentBoundExecutionV1', 'adaptiveActionV1']);
  });

  it('maps every bounded action to a frozen §4 route', () => {
    const tails = Object.values(PERSONAL_ROUTES).map((route) => `${route.method} ${route.tail}`);
    expect(tails).toEqual([
      'GET /projects/available',
      'GET /projects/{project}/task-options',
      'GET /projects/{project}/native-tasks',
      'POST /projects/{project}/native-task-adoptions',
      'POST /tasks',
      'GET /tasks',
      'GET /tasks/requests/{requestKey}',
      'GET /tasks/{task}',
      'GET /tasks/{task}/activities',
      'GET /tasks/{task}/activities',
      'GET /tasks/{task}/activities',
      'GET /tasks/{task}/output',
      'GET /tasks/{task}/metrics',
      'GET /tasks/{task}/commands',
      'POST /tasks/{task}/messages',
      'POST /tasks/{task}/input-requests/{entity}/responses',
      'GET /tasks/{task}/input-requests',
      'GET /tasks/{task}/artifacts',
      'GET /tasks/{task}/artifacts/{entity}',
      'POST /tasks/{task}/commands',
      'GET /tasks/{task}/interactions',
      'GET /tasks/{task}/interaction-catalog',
      'POST /tasks/{task}/boundary-requests',
      'POST /tasks/{task}/side-questions',
      'POST /tasks/{task}/handoffs/preflight',
      'POST /tasks/{task}/handoffs',
      'POST /tasks/{task}/approvals/{entity}/decisions',
      'POST /tasks/{task}/boundary-requests/{entity}/cancel',
      'POST /tasks/{task}/handoffs/{entity}/cancel',
      'GET /tasks/{task}/boundary-requests/{entity}',
      'GET /tasks/{task}/handoffs/{entity}',
      'GET /tasks/{task}/interaction-requests/{requestKey}',
      'GET /tasks/{task}/approvals',
      'GET /tasks/{task}/approvals/{requestKey}',
      'GET /tasks/{task}/messages',
      'POST /tasks/{task}/messages',
      'GET /tasks/{task}/interaction-requests/{requestKey}',
      'GET /tasks/{task}/commands/{requestKey}',

      'GET /overview',
      'GET /projects',
      'POST /projects',
      'GET /projects/{project}',
      'GET /projects/{project}/environment',
      'POST /projects/{project}/environment/plans',
      'POST /projects/{project}/environment/operations',
      'GET /environment-operations/{operation}',
      'GET /environment-operations/{operation}/events',
      'POST /environment-operations/{operation}/cancel',
      'GET /workers',
      'GET /workers/{worker}',
      'GET /tasks/{task}/actions',
      'POST /tasks/{task}/actions/{action}:run',
      'POST /tasks/{task}/actions/{action}:save',
      'GET /reports',
      'POST /reports',
      'GET /reports/{report}',
      'GET /reports/{report}/files'
    ]);
    // Every union member action has exactly one route.
    const actions: PersonalOperation['action'][] = [
      'PROJECTS_AVAILABLE',
      'TASK_OPTIONS',
      'NATIVE_SOURCE_TASKS', 'NATIVE_TASK_ADOPT',
      'TASK_CREATE',
      'TASKS',
      'TASK_REQUEST',
      'TASK',
      'TASK_ACTIVITY',
      'TASK_EVENTS_SUBSCRIBE',
      'TASK_EVENTS_UNSUBSCRIBE',
      'TASK_OUTPUT',
      'TASK_METRICS',
      'TASK_COMMANDS',
      'NATIVE_MESSAGE_CREATE', 'NATIVE_INPUT_RESPONSE',
      'NATIVE_INPUTS', 'NATIVE_ARTIFACTS', 'NATIVE_ARTIFACT',
      'TASK_COMMAND_CREATE',
      'TASK_COMMAND',
      'TASK_INTERACTIONS',
      'TASK_INTERACTION_CATALOG',
      'TASK_BOUNDARY_CREATE',
      'TASK_SIDE_QUESTION_CREATE',
      'TASK_HANDOFF_PREFLIGHT',
      'TASK_HANDOFF_CREATE',
      'TASK_APPROVAL_DECISION',
      'TASK_BOUNDARY_CANCEL',
      'TASK_HANDOFF_CANCEL',
      'TASK_BOUNDARY_RESULT',
      'TASK_HANDOFF_RESULT',
      'TASK_ENGAGEMENT',
      'TASK_APPROVALS',
      'TASK_APPROVAL',
      'TASK_MESSAGES',
      'TASK_MESSAGE_CREATE',
      'TASK_INTERACTION_REQUEST',

      'OVERVIEW', 'PROJECTS', 'REGISTER_PROJECT', 'PROJECT', 'PROJECT_ENVIRONMENT',
      'ENVIRONMENT_PLAN', 'ENVIRONMENT_OPERATION', 'OPERATION', 'OPERATION_EVENTS',
      'OPERATION_CANCEL', 'WORKERS', 'WORKER', 'TASK_ACTIONS', 'ACTION_RUN',
      'ACTION_SAVE', 'REPORTS', 'REPORT_CREATE', 'REPORT', 'REPORT_FILES'
    ];
    for (const action of actions) expect(PERSONAL_ROUTES[action]).toBeDefined();
    expect(Object.keys(PERSONAL_ROUTES).sort()).toEqual([...actions].sort());
  });

  it('accepts bounded read operations with registered ids', () => {
    expect(validPersonalOperation({ action: 'OVERVIEW' })).toBe(true);
    expect(validPersonalOperation({ action: 'PROJECTS' })).toBe(true);
    expect(validPersonalOperation({ action: 'PROJECT', projectId: 'project-1' })).toBe(true);
    expect(validPersonalOperation({ action: 'PROJECT_ENVIRONMENT', projectId: 'project-1' })).toBe(true);
    expect(validPersonalOperation({ action: 'OPERATION', operationId: 'op.1' })).toBe(true);
    expect(validPersonalOperation({ action: 'OPERATION_EVENTS', operationId: 'op.1' })).toBe(true);
    expect(validPersonalOperation({ action: 'OPERATION_EVENTS', operationId: 'op.1', cursor: 'opaque-cursor', limit: '50' })).toBe(true);
    expect(validPersonalOperation({ action: 'WORKER', workerId: 'worker_1' })).toBe(true);
    expect(validPersonalOperation({ action: 'TASK_ACTIONS', taskId: 'task-1' })).toBe(true);
    // Stream-control ops: bounded taskId + decimal resume cursor only —
    // never a URL/method/header.
    expect(validPersonalOperation({ action: 'TASK_EVENTS_SUBSCRIBE', taskId: 'task-1' })).toBe(true);
    expect(validPersonalOperation({ action: 'TASK_EVENTS_SUBSCRIBE', taskId: 'task-1', afterCursor: '41' })).toBe(true);
    expect(validPersonalOperation({ action: 'TASK_EVENTS_UNSUBSCRIBE', taskId: 'task-1' })).toBe(true);
    expect(validPersonalOperation({ action: 'TASK_EVENTS_SUBSCRIBE', taskId: 'task-1', afterCursor: 'opaque' })).toBe(false);
    expect(validPersonalOperation({ action: 'TASK_EVENTS_UNSUBSCRIBE', taskId: 'task-1', afterCursor: '1' })).toBe(false);
    expect(validPersonalOperation({ action: 'REPORTS' })).toBe(true);
    expect(validPersonalOperation({ action: 'REPORT', reportId: 'report-1' })).toBe(true);
    expect(validPersonalOperation({ action: 'REPORT_FILES', reportId: 'report-1' })).toBe(true);
  });

  it('accepts bounded writes whose body.requestKey equals the operation key', () => {
    expect(validPersonalOperation({
      action: 'REGISTER_PROJECT', key: 'key-1',
      body: { requestKey: 'key-1', projectRef: 'project-1', displayName: 'Demo' }
    })).toBe(true);
    expect(validPersonalOperation({
      action: 'ENVIRONMENT_PLAN', projectId: 'project-1', key: 'key-2',
      body: { requestKey: 'key-2', preferredBackend: 'OCI_DOCKER', toolchainSelections: [{ tool: 'jdk', version: '21' }] }
    })).toBe(true);
    expect(validPersonalOperation({
      action: 'ENVIRONMENT_OPERATION', projectId: 'project-1', key: 'key-3',
      body: { requestKey: 'key-3', kind: 'PREPARE', planDigest: SHA, expectedRevision: '7' }
    })).toBe(true);
    expect(validPersonalOperation({
      action: 'OPERATION_CANCEL', operationId: 'op.1', key: 'key-4',
      body: { requestKey: 'key-4', expectedRevision: '3' }
    })).toBe(true);
    expect(validPersonalOperation({
      action: 'ACTION_RUN', taskId: 'task-1', actionId: 'action-1', key: 'key-5',
      body: { requestKey: 'key-5', inputs: { profile: 'fast' } }
    })).toBe(true);
    expect(validPersonalOperation({
      action: 'ACTION_SAVE', taskId: 'task-1', actionId: 'action-1', key: 'key-6',
      body: { requestKey: 'key-6', name: 'Nightly build', scope: 'PROJECT' }
    })).toBe(true);
    expect(validPersonalOperation({
      action: 'REPORT_CREATE', key: 'key-7',
      body: { requestKey: 'key-7', sourceRef: 'delivery-1', dataScope: ['summary'], outputFormat: 'markdown' }
    })).toBe(true);
  });

  it('rejects unknown actions, unknown keys and malformed ids', () => {
    expect(validPersonalOperation(null)).toBe(false);
    expect(validPersonalOperation({ action: 'DELETE_EVERYTHING' })).toBe(false);
    expect(validPersonalOperation({ action: 'PROJECT', projectId: 'project-1', admin: true })).toBe(false);
    expect(validPersonalOperation({ action: 'PROJECT', projectId: '../escape' })).toBe(false);
    expect(validPersonalOperation({ action: 'PROJECT', projectId: 'has space' })).toBe(false);
    expect(validPersonalOperation({ action: 'PROJECT', projectId: 'x'.repeat(129) })).toBe(false);
    expect(validPersonalOperation({ action: 'PROJECT' })).toBe(false);
    // Reads must not smuggle bodies or keys.
    expect(validPersonalOperation({ action: 'PROJECT', projectId: 'p1', body: {} })).toBe(false);
    expect(validPersonalOperation({ action: 'OVERVIEW', key: 'k' })).toBe(false);
  });

  it('rejects writes without key/body and requestKey mismatches', () => {
    expect(validPersonalOperation({ action: 'REGISTER_PROJECT' })).toBe(false);
    expect(validPersonalOperation({ action: 'REGISTER_PROJECT', key: 'k1' })).toBe(false);
    expect(validPersonalOperation({
      action: 'REGISTER_PROJECT', key: 'k1', body: { requestKey: 'other', projectRef: 'p1' }
    })).toBe(false);
    expect(validPersonalOperation({
      action: 'REGISTER_PROJECT', key: 'k1', body: { requestKey: 'k1' }
    })).toBe(false); // projectRef is required
    expect(validPersonalOperation({
      action: 'REGISTER_PROJECT', key: 'k1', body: { requestKey: 'k1', projectRef: 'p1', secret: 'x' }
    })).toBe(false); // unknown body keys are rejected
    expect(validPersonalOperation({
      action: 'REGISTER_PROJECT', key: 'bad key', body: { requestKey: 'bad key', projectRef: 'p1' }
    })).toBe(false);
  });

  it('enforces operation kind, digest shape and revision formats', () => {
    const write = (body: Record<string, unknown>) => validPersonalOperation({
      action: 'ENVIRONMENT_OPERATION', projectId: 'p1', key: 'k1', body: { requestKey: 'k1', ...body }
    });
    expect(write({ kind: 'PREPARE' })).toBe(true);
    expect(write({ kind: 'NUKE' })).toBe(false);
    expect(write({})).toBe(false); // kind is required
    expect(write({ kind: 'RETIRE', environmentId: 'env-1', environmentRevision: '4' })).toBe(true);
    expect(write({ kind: 'PREPARE', planDigest: 'not-a-digest' })).toBe(false);
    expect(write({ kind: 'PREPARE', planDigest: SHA })).toBe(true);
    expect(write({ kind: 'CLEANUP', expectedRevision: 'abc' })).toBe(false);
    expect(write({ kind: 'CLEANUP', environmentRevision: '1.5' })).toBe(false);
    // A browser never supplies arbitrary script, URL or host paths.
    expect(write({ kind: 'PREPARE', shell: 'rm -rf /' })).toBe(false);
    expect(write({ kind: 'PREPARE', script: 'do()' })).toBe(false);
  });

  it('bounds the events cursor and limit', () => {
    const page = (extra: Record<string, unknown>) => validPersonalOperation({ action: 'OPERATION_EVENTS', operationId: 'op1', ...extra });
    expect(page({ limit: '1' })).toBe(true);
    expect(page({ limit: '256' })).toBe(true);
    expect(page({ limit: '0' })).toBe(false);
    expect(page({ limit: '257' })).toBe(false);
    expect(page({ limit: 'abc' })).toBe(false);
    expect(page({ cursor: `x${'\n'}y` })).toBe(false);
    expect(page({ cursor: 'c'.repeat(1025) })).toBe(false);
    expect(page({ extra: true })).toBe(false);
  });

  // 新增：native-messages/1 paging contract on the fixed TASK_MESSAGES
  // operation (design §5.3/§8.1, C12/C15). `before` is decimal-only,
  // mutually exclusive with `cursor`, and limit stays at the Host's 1..100.
  it('bounds the task messages page contract', () => {
    const page = (extra: Record<string, unknown>) => validPersonalOperation({ action: 'TASK_MESSAGES', taskId: 'task-1', ...extra });
    expect(page({})).toBe(true);
    expect(page({ before: '9', limit: '20' })).toBe(true);
    expect(page({ before: '1' })).toBe(true);
    expect(page({ before: '9223372036854775807' })).toBe(true);
    expect(page({ cursor: '12', limit: '50' })).toBe(true);
    // `cursor` stays bounded-opaque here because ACS session page tokens
    // (h1.*) share this fixed operation; decimal sequence enforcement lives
    // in the native read path (NativeTasks.read).
    expect(page({ cursor: 'h1.opaque-token' })).toBe(true);
    expect(page({ before: '0' })).toBe(false);
    expect(page({ before: 'abc' })).toBe(false);
    expect(page({ before: ' 5' })).toBe(false);
    expect(page({ before: '05' })).toBe(false);
    expect(page({ before: '1.5' })).toBe(false);
    expect(page({ before: '9223372036854775808' })).toBe(false);
    expect(page({ before: 'x'.repeat(20) })).toBe(false);
    // cursor/before are mutually exclusive.
    expect(page({ cursor: 'h1.token', before: '9' })).toBe(false);
    expect(page({ cursor: '12', before: '9' })).toBe(false);
    // Host range for the message page is 1..100, not the generic 1..256.
    expect(page({ limit: '100' })).toBe(true);
    expect(page({ limit: '101' })).toBe(false);
    expect(page({ limit: '0' })).toBe(false);
    expect(page({ limit: 'abc' })).toBe(false);
    expect(page({ foo: '1' })).toBe(false);
    // TASK_COMMANDS keeps its own opaque `before` command-id paging.
    expect(validPersonalOperation({ action: 'TASK_COMMANDS', taskId: 'task-1', before: 'other:command' })).toBe(true);
    expect(validPersonalOperation({ action: 'TASK_COMMANDS', taskId: 'task-1', before: 'cmd-x', limit: '7' })).toBe(true);
  });

  it('rejects oversized operations and non-plain bodies', () => {
    expect(validPersonalOperation({
      action: 'ACTION_RUN', taskId: 't1', actionId: 'a1', key: 'k1',
      body: { requestKey: 'k1', inputs: ['not', 'an', 'object'] }
    })).toBe(false);
    expect(validPersonalOperation({
      action: 'ACTION_RUN', taskId: 't1', actionId: 'a1', key: 'k1',
      body: { requestKey: 'k1', inputs: { blob: 'x'.repeat(17000) } }
    })).toBe(false);
    expect(validPersonalOperation({
      action: 'ACTION_RUN', taskId: 't1', actionId: 'a1', key: 'k1',
      body: { requestKey: 'k1', inputs: { ok: 'v'.repeat(1000) } }
    })).toBe(true);
    // Prototype pollution attempts are not plain objects.
    expect(validPersonalOperation({
      action: 'ACTION_RUN', taskId: 't1', actionId: 'a1', key: 'k1',
      body: new Date() as unknown as Record<string, string>
    })).toBe(false);
  });

  it('guards the {meta,data} envelope and decodes the {error} shape', () => {
    const meta = {
      source: 'management', instance: 'local', controlPlaneId: 'cp-1',
      observedAt: '2026-10-18T00:00:00Z', revision: '1', supportedActions: [], reasonCodes: []
    };
    expect(validPersonalEnvelope({ meta, data: { ok: true } })).toBe(true);
    expect(validPersonalEnvelope({ meta, data: null })).toBe(true);
    expect(validPersonalEnvelope({ meta })).toBe(false);
    expect(validPersonalEnvelope({ data: {} })).toBe(false);
    expect(validPersonalEnvelope({ meta: 'x', data: {} })).toBe(false);
    expect(validPersonalEnvelope([])).toBe(false);
    expect(decodePersonalError({ error: { code: 'IDEMPOTENCY_CONFLICT', message: 'same key different body', retryable: false, requestId: 'req-1' } }))
      .toEqual({ code: 'IDEMPOTENCY_CONFLICT', message: 'same key different body', retryable: false, requestId: 'req-1' });
    expect(decodePersonalError({ error: { code: 'NOT_READY' } })).toEqual({ code: 'NOT_READY', message: undefined, retryable: undefined, requestId: undefined });
    expect(decodePersonalError({ error: { message: 'no code' } })).toBeUndefined();
    expect(decodePersonalError({ code: 'TOP_LEVEL' })).toBeUndefined();
    expect(decodePersonalError('nope')).toBeUndefined();
  });
});

it('validates PC-I intent DTOs and rejects unknown source/target fields',()=>{
  const body={kind:'BOUNDARY' as const,requestKey:'boundary-one',targetRunId:'run-one',source:{schemaVersion:'run-boundary-request/1' as const,requestId:'boundary-one',kind:'CONTEXT_ADVICE' as const,expectedExecutionEpoch:'9007199254740993',text:'advice',sourceRefs:[]}};
  expect(validPersonalOperation({action:'TASK_BOUNDARY_CREATE',taskId:'task-one',key:body.requestKey,body})).toBe(true);
  expect(validPersonalOperation({action:'TASK_BOUNDARY_CREATE',taskId:'task-one',key:body.requestKey,body:{...body,connectionId:'foreign'}})).toBe(false);
  expect(validPersonalOperation({action:'TASK_BOUNDARY_CREATE',taskId:'task-one',key:body.requestKey,body:{...body,source:{...body.source,requestId:'different'}}})).toBe(false);
  expect(validPersonalOperation({action:'TASK_BOUNDARY_CREATE',taskId:'task-one',key:body.requestKey,body:{...body,source:{...body.source,text:'中'.repeat(2800)}}})).toBe(false);
  expect(validPersonalOperation({action:'TASK_HANDOFF_CREATE',taskId:'task-one',key:body.requestKey,body})).toBe(false);
});
