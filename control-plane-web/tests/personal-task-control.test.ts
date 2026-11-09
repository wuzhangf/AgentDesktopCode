import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ManagementStore } from '../server/management/registry-store';
import { ConnectionHub } from '../server/management/upstream';
import { PersonalTasks } from '../server/management/tasks';
import { TaskMetricsReader } from '../server/management/task-metrics';
import type { GatewayCallContext } from '../server/management/service';

/**
 * Reliable task control (PAUSE/RESUME/STOP) — the BFF freezes each request
 * locally before any source dispatch; requestKey == commandId == the source
 * Idempotency-Key. GET surfaces only reconcile, never re-dispatch.
 */
function upstream() {
  const creates = new Map<string, unknown>(), messages = new Map<string, unknown>();
  const commands = new Map<string, Record<string, unknown>>(); // commandId → source receipt
  const posts: { key: string | null; body: Record<string, unknown> }[] = [];
  let revision = 0;
  let run = {
    state: 'RUNNING', sourceStatus: undefined as string | undefined, stateVersion: 5,
    controlState: undefined as string | undefined, controlCommandId: undefined as string | undefined,
    checkpointAvailable: true, availableActions: ['PAUSE', 'RESUME', 'STOP'] as string[],
  };
  let admission = 'READY';
  // One-shot failure for the next POST /commands: 'THROW' = transport loss
  // before the source committed (nothing recorded); {status,code} = problem.
  let postError: 'THROW' | { status: number; code: string; message?: string } | null = null;
  let postTerminal = false;
  let getError: 'THROW' | { status: number; code: string; message?: string } | null = null;
  let listError: 'THROW' | { status: number; code: string; message?: string } | null = null;
  const seen: { path: string; method: string; body: unknown; key: string | null }[] = [];

  const json = (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
  const problem = (status: number, code: string, message: string) =>
    json({ code, status, message }, status);
  const receipt = (body: Record<string, unknown>, rev: number, over: Record<string, unknown> = {}) => ({
    schemaVersion: 'run-command-receipt/1',
    commandId: body.commandId,
    receiptId: `rcpt-${body.commandId}-${rev}`,
    sessionId: 'session-one',
    runId: 'run-one',
    intent: body.intent,
    phase: 'ACCEPTED',
    receiptRevision: String(rev),
    acceptedAt: '2026-10-20T00:00:00Z',
    actor: { principalId: 'principal-one', clientSessionId: 'client-one' },
    expectedStateVersion: body.expectedStateVersion ?? null,
    acceptedStateVersion: 5,
    observedStateVersion: 6,
    observedRunState: 'RUNNING',
    terminal: false,
    ...over,
  });

  const fetchImpl: typeof fetch = async (input, init) => {
    const path = new URL(String(input)).pathname;
    const key = new Headers(init?.headers).get('idempotency-key');
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    seen.push({ path, method: init?.method ?? 'GET', body, key });
    let data: unknown;
    if (path === '/api/v2/client-sessions') data = { clientSessionId: 'client-one', clientSessionToken: crypto.randomUUID(), storeId: 'store-one', bootId: 'boot-one', ttlMillis: 60000, remainingTtlMillis: 60000, acceptedProtocols: ['v2'] };
    else if (path.endsWith('/session-preflight')) data = { projectId: 'source-one', workspaceAlias: 'sample', headRevision: 'head-one', revision: 'rev-one', policyFingerprint: 'policy-one', workspaceFingerprint: 'workspace-one', authorityStatus: 'AUTHORITATIVE', allowedIntents: ['CODE'], suggestedWriteScope: [], writeScopeCeiling: ['.'], modelAlias: 'fixture-model', modelAvailability: 'AVAILABLE' };
    else if (path === '/api/v2/capabilities') data = { serviceInstanceId: 'service-one', protocolVersion: '2', features: { sessionV2: true, durableEvents: true, visibleOutputStream: true, worktreeExecution: true, mission: false, mcpHost: false, servicePty: false }, limits: { maxDiffBytes: 1000, maxEventPage: 100, maxVisibleDeltaChars: 1000 }, operations: [] };
    else if (path === '/api/v2/agent-profiles') data = { profiles: [], loadErrors: [] };
    else if (path === '/api/v2/model-catalog') data = { defaultModel: 'fixture-model', items: [{ providerId: 'fixture', modelAlias: 'fixture-model', availability: 'AVAILABLE', configured: true }] };
    else if (path === '/api/v2/projects') data = [{ projectId: 'source-one', workspaceAlias: 'sample', displayName: '示例项目', authorityStatus: 'AUTHORITATIVE' }];
    else if (path === '/api/v2/sessions' && init?.method === 'POST') {
      if (!creates.has(key!)) creates.set(key!, { sessionId: 'session-one', sessionVersion: 1 });
      data = creates.get(key!);
    } else if (path === '/api/v2/sessions/session-one/messages' && init?.method === 'POST') {
      if (!messages.has(key!)) messages.set(key!, { messageId: 'message-one', clientMessageId: body.clientMessageId, taskId: 'source-task', runId: 'run-one', sessionVersion: 2, status: 'ACCEPTED' });
      data = messages.get(key!);
    } else if (path === '/api/v2/sessions/session-one/foundation') {
      data = { schemaVersion: 'session-foundation/1', storeId: 'store-one', sessionId: 'session-one', executionOwnership: 'HOST_SESSION', capabilities: { commandReceiptV1: admission } };
    } else if (path === '/api/v2/sessions/session-one') data = { sessionId: 'session-one', sessionVersion: 2, activeRunId: 'run-one', agentProfileName: 'Code Agent', messages: [] };
    else if (path === '/api/v2/runs/run-one/commands' && init?.method === 'POST') {
      posts.push({ key, body });
      if (postError === 'THROW') { postError = null; throw new Error('connection lost before source committed'); }
      if (postError) { const e = postError; postError = null; return problem(e.status, e.code, e.message ?? e.code); }
      if (!commands.has(key!)) commands.set(key!, receipt(body, ++revision, postTerminal ? { terminal: true, phase: 'APPLIED' } : {}));
      postTerminal = false;
      return json(commands.get(key!), 202);
    } else if (path.startsWith('/api/v2/runs/run-one/commands/')) {
      if (getError === 'THROW') throw new Error('connection lost');
      if (getError) return problem(getError.status, getError.code, getError.message ?? getError.code);
      const commandId = decodeURIComponent(path.slice('/api/v2/runs/run-one/commands/'.length));
      const found = commands.get(commandId);
      if (!found) return problem(404, 'CONTROL_NOT_FOUND', 'command not found');
      data = found;
    } else if (path === '/api/v2/runs/run-one/commands') {
      if (listError === 'THROW') throw new Error('connection lost');
      if (listError) return problem(listError.status, listError.code, listError.message ?? listError.code);
      data = { items: [...commands.values()].sort((a, b) => Number(BigInt(String(b.receiptRevision)) - BigInt(String(a.receiptRevision)))), nextBefore: null };
    } else if (path === '/api/v2/runs/run-one') {
      data = { runId: 'run-one', taskId: 'source-task', sessionId: 'session-one', state: run.state, stateVersion: run.stateVersion, changedFileCount: 0, startedAt: '2026-10-20T00:00:00Z', ...(run.sourceStatus ? { sourceStatus: run.sourceStatus } : {}), ...(run.controlState ? { controlState: run.controlState } : {}), ...(run.controlCommandId ? { controlCommandId: run.controlCommandId } : {}), checkpointAvailable: run.checkpointAvailable, availableActions: run.availableActions };
    } else data = {};
    return json(data);
  };
  return {
    fetchImpl, seen, posts, commands,
    setRun: (patch: Partial<typeof run>) => { run = { ...run, ...patch }; },
    setAdmission: (value: string) => { admission = value; },
    failNextPost: (e: 'THROW' | { status: number; code: string; message?: string }) => { postError = e; },
    terminalNextPost: () => { postTerminal = true; },
    failGets: (e: 'THROW' | { status: number; code: string; message?: string } | null) => { getError = e; },
    failList: (e: 'THROW' | { status: number; code: string; message?: string } | null) => { listError = e; },
    dropCommand: (key: string) => { commands.delete(key); },
  };
}

function fixture(path = ':memory:') {
  const store = new ManagementStore({ path }), source = upstream();
  const hub = new ConnectionHub(store, () => crypto.randomUUID(), source.fetchImpl);
  hub.provision([{ connectionId: 'acs', kind: 'ACS_DIRECT', baseUrl: 'http://127.0.0.1:7777', tokenRef: 'test-memory' }]);
  if (!store.getProject('p-one')) store.insertProject({ projectId: 'p-one', projectRef: 'source-one', connectionId: 'acs' });
  const tasks = new PersonalTasks(store, hub, 'test', new TaskMetricsReader());
  const ctx: GatewayCallContext = { requestId: 'test', acsSessionFor: async () => ({ clientSessionId: 'client-one', token: crypto.randomUUID(), storeId: 'store-one' }) };
  return { store, source, tasks, ctx };
}

async function launched(f: ReturnType<typeof fixture>, key = 'launch-one'): Promise<string> {
  const created = await f.tasks.create({ requestKey: key, projectId: 'p-one', instruction: '修改 README' }, f.ctx);
  expect(created.status).toBe(201);
  return (created.body as { data: { taskId: string } }).data.taskId;
}

const pause = (requestKey: string, expectedStateVersion = 5) => ({ requestKey, targetRunId: 'run-one', intent: 'PAUSE' as const, expectedStateVersion });
const stop = (requestKey: string) => ({ requestKey, targetRunId: 'run-one', intent: 'STOP' as const });
const data = (outcome: { status: number; body: unknown }) => (outcome.body as { data: Record<string, unknown> }).data;

describe('personal task reliable control (PAUSE/RESUME/STOP)', () => {
  it('freezes before dispatch: ledger + frozen request + dispatch_started_at, wire body uses requestKey identity', async () => {
    const f = fixture();
    try {
      const id = await launched(f);
      const before = f.source.posts.length;
      const out = await f.tasks.commandCreate(id, pause('web-control-a'), f.ctx);
      expect(out.status).toBe(202);
      const view = data(out) as Record<string, unknown>;
      expect(view.commandId).toBe('web-control-a');
      expect((view.receipt as Record<string, unknown>).terminal).toBe(false);
      const row = f.store.controlRequest('web-control-a')!;
      expect(row.taskId).toBe(id);
      expect(row.dispatchStartedAt).toBeTruthy();
      expect(JSON.parse(row.sourceBindingJson)).toMatchObject({ connectionId: 'acs', storeId: 'store-one', sessionId: 'session-one', runId: 'run-one', taskId: 'source-task' });
      expect(JSON.parse(row.sourceRequestJson)).toMatchObject({ schemaVersion: 'run-command/1', commandId: 'web-control-a', intent: 'PAUSE', expectedStateVersion: 5 });
      expect(f.store.ledgerGet('web-control-a')).toMatchObject({ route: 'TASK_COMMAND_CREATE', subjectId: id, state: 'SETTLED' });
      const wire = f.source.posts.at(-1)!;
      expect(f.source.posts.length).toBe(before + 1);
      expect(wire.key).toBe('web-control-a'); // Idempotency-Key == requestKey
      expect(wire.body).toMatchObject({ schemaVersion: 'run-command/1', commandId: 'web-control-a', intent: 'PAUSE', expectedStateVersion: 5 });
    } finally { f.store.close(); }
  });

  it('same-key replay returns the found receipt without a second POST; source 404 replays the frozen body', async () => {
    const f = fixture();
    try {
      const id = await launched(f);
      const body = pause('web-control-b');
      await f.tasks.commandCreate(id, body, f.ctx);
      expect(f.source.posts).toHaveLength(1);
      // Source still holds the durable receipt → reconcile, no re-dispatch.
      const again = await f.tasks.commandCreate(id, body, f.ctx);
      expect(again.status).toBe(202);
      expect(f.source.posts).toHaveLength(1);
      // Simulate the source losing its record: a 404 is not proof of
      // non-execution — identity re-check, then the frozen body replays under
      // the SAME key.
      f.source.dropCommand('web-control-b');
      const replayed = await f.tasks.commandCreate(id, body, f.ctx);
      expect(replayed.status).toBe(202);
      expect(f.source.posts).toHaveLength(2);
      expect(f.source.posts[1]!.key).toBe('web-control-b');
      expect(f.source.posts[1]!.body).toEqual(f.source.posts[0]!.body);
    } finally { f.store.close(); }
  });

  it('same key with changed intent / version / task is a 409 IDEMPOTENCY_CONFLICT', async () => {
    const f = fixture();
    try {
      const id = await launched(f);
      const other = await launched(f, 'launch-two');
      await f.tasks.commandCreate(id, pause('web-control-c'), f.ctx);
      await expect(f.tasks.commandCreate(id, { requestKey: 'web-control-c', intent: 'RESUME', expectedStateVersion: 5 }, f.ctx))
        .rejects.toMatchObject({ status: 409, code: 'IDEMPOTENCY_CONFLICT' });
      await expect(f.tasks.commandCreate(id, pause('web-control-c', 6), f.ctx))
        .rejects.toMatchObject({ status: 409, code: 'IDEMPOTENCY_CONFLICT' });
      await expect(f.tasks.commandCreate(other, pause('web-control-c'), f.ctx))
        .rejects.toMatchObject({ status: 409, code: 'IDEMPOTENCY_CONFLICT' });
      expect(f.source.posts).toHaveLength(1);
    } finally { f.store.close(); }
  });

  it('pending suppression: pending PAUSE blocks new PAUSE but not STOP; pending STOP blocks new STOP', async () => {
    const f = fixture();
    try {
      const id = await launched(f);
      await f.tasks.commandCreate(id, pause('web-control-d1'), f.ctx); // non-terminal → pending
      await expect(f.tasks.commandCreate(id, pause('web-control-d2', 6), f.ctx))
        .rejects.toMatchObject({ status: 409, code: 'TASK_CONTROL_PENDING' });
      const stopped = await f.tasks.commandCreate(id, stop('web-control-d3'), f.ctx);
      expect(stopped.status).toBe(202); // explicit STOP still admitted with its own key
      await expect(f.tasks.commandCreate(id, stop('web-control-d4'), f.ctx))
        .rejects.toMatchObject({ status: 409, code: 'TASK_STOP_PENDING' });
      // The read view suppresses new PAUSE/RESUME while anything is pending,
      // and STOP while a STOP is pending.
      const view = data(await f.tasks.commands(id, new URLSearchParams(), f.ctx)) as { allowedIntents: string[]; pendingRequests: unknown[] };
      expect(view.pendingRequests).toHaveLength(2);
      expect(view.allowedIntents).toEqual([]);
    } finally { f.store.close(); }
  });

  it('GET list/single never issue a source POST, including after a BFF restart', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'web-task-control-'));
    const path = join(dir, 'management.db');
    const f = fixture(path);
    const id = await launched(f);
    await f.tasks.commandCreate(id, pause('web-control-e'), f.ctx);
    expect(f.source.posts).toHaveLength(1);
    f.store.close();

    const store = new ManagementStore({ path });
    const hub = new ConnectionHub(store, () => crypto.randomUUID(), f.source.fetchImpl);
    const tasks = new PersonalTasks(store, hub, 'restart', new TaskMetricsReader());
    try {
      const list = data(await tasks.commands(id, new URLSearchParams(), f.ctx)) as { pendingRequests: { commandId: string }[] };
      expect(list.pendingRequests.map((r) => r.commandId)).toContain('web-control-e');
      const single = data(await tasks.command(id, 'web-control-e', f.ctx)) as Record<string, unknown>;
      expect(single.commandId).toBe('web-control-e');
      expect(f.source.posts).toHaveLength(1); // read-only reconcile, still no POST
      // Explicit same-key POST resumes along the frozen identity; the source
      // still has the receipt → reconcile, still no second POST.
      const resumed = await tasks.commandCreate(id, pause('web-control-e'), f.ctx);
      expect(resumed.status).toBe(202);
      expect(f.source.posts).toHaveLength(1);
    } finally { store.close(); }
  });

  it('commandReceiptV1 DISABLED hides PAUSE/RESUME but never STOP; POST PAUSE is refused, POST STOP proceeds', async () => {
    const f = fixture();
    try {
      const id = await launched(f);
      f.source.setAdmission('DISABLED');
      const view = data(await f.tasks.commands(id, new URLSearchParams(), f.ctx)) as { allowedIntents: string[]; reasonCodes: string[] };
      expect(view.allowedIntents).toEqual(['STOP']);
      expect(view.reasonCodes).toContain('FOUNDATION_ADMISSION_DISABLED');
      await expect(f.tasks.commandCreate(id, pause('web-control-f'), f.ctx))
        .rejects.toMatchObject({ status: 409, code: 'FOUNDATION_ADMISSION_DISABLED' });
      const stopped = await f.tasks.commandCreate(id, stop('web-control-g'), f.ctx);
      expect(stopped.status).toBe(202);
    } finally { f.store.close(); }
  });

  it('maps allowedIntents from the run projection: QUEUED → STOP only; PAUSED_RETRYABLE → no RESUME; PAUSED_FOR_HUMAN → RESUME+STOP', async () => {
    const f = fixture();
    try {
      const id = await launched(f);
      f.source.setRun({ state: 'QUEUED', sourceStatus: undefined, availableActions: ['PAUSE', 'RESUME', 'STOP'] });
      expect((data(await f.tasks.commands(id, new URLSearchParams(), f.ctx)) as { allowedIntents: string[] }).allowedIntents).toEqual(['STOP']);
      f.source.setRun({ state: 'PAUSED', sourceStatus: 'PAUSED_RETRYABLE' });
      expect((data(await f.tasks.commands(id, new URLSearchParams(), f.ctx)) as { allowedIntents: string[] }).allowedIntents).toEqual(['STOP']);
      f.source.setRun({ state: 'PAUSED', sourceStatus: 'PAUSED_FOR_HUMAN', checkpointAvailable: true, availableActions: ['RESUME', 'STOP'] });
      expect((data(await f.tasks.commands(id, new URLSearchParams(), f.ctx)) as { allowedIntents: string[] }).allowedIntents).toEqual(['RESUME', 'STOP']);
      f.source.setRun({ state: 'COMPLETED', sourceStatus: undefined });
      expect((data(await f.tasks.commands(id, new URLSearchParams(), f.ctx)) as { allowedIntents: string[] }).allowedIntents).toEqual([]);
    } finally { f.store.close(); }
  });

  it('receipt revisions never regress: a lower revision cannot overwrite the stored one', async () => {
    const f = fixture();
    try {
      const id = await launched(f);
      await f.tasks.commandCreate(id, pause('web-control-h'), f.ctx); // stores rev '1'
      const stored = () => f.store.controlRequest('web-control-h')!.lastReceiptJson!;
      expect(stored()).toContain('"receiptRevision":"1"');
      // Source advances to rev 2 → reconcile stores it.
      const current = f.source.commands.get('web-control-h')!;
      current.receiptRevision = '2'; current.observedStateVersion = 7;
      await f.tasks.commands(id, new URLSearchParams(), f.ctx);
      expect(stored()).toContain('"receiptRevision":"2"');
      // Source regresses to rev 1 (stale replica) → stored rev 2 wins.
      current.receiptRevision = '1'; current.receiptId = 'stale';
      await f.tasks.command(id, 'web-control-h', f.ctx);
      expect(stored()).toContain('"receiptRevision":"2"');
    } finally { f.store.close(); }
  });

  it('5xx/transport failures return 202 + sourceError, keep pending and never overwrite a stored receipt', async () => {
    const f = fixture();
    try {
      const id = await launched(f);
      f.source.failNextPost({ status: 503, code: 'SERVICE_UNAVAILABLE' });
      const failed = await f.tasks.commandCreate(id, pause('web-control-i'), f.ctx);
      expect(failed.status).toBe(202);
      expect((data(failed).sourceError as { code: string }).code).toBe('SERVICE_UNAVAILABLE');
      expect(f.store.controlRequest('web-control-i')!.lastReceiptJson).toBeUndefined();

      // The source actually committed before its reply was lost: the next
      // read-only reconcile finds the durable receipt and settles locally.
      f.source.commands.set('web-control-i', {
        schemaVersion: 'run-command-receipt/1', commandId: 'web-control-i',
        receiptId: 'rcpt-i', sessionId: 'session-one', runId: 'run-one',
        intent: 'PAUSE', phase: 'APPLIED', receiptRevision: '1',
        acceptedAt: '2026-10-20T00:00:01Z',
        actor: { principalId: 'principal-one', clientSessionId: 'client-one' },
        acceptedStateVersion: 5, observedStateVersion: 6,
        observedRunState: 'PAUSED', terminal: true,
      });
      const reconciled = data(await f.tasks.command(id, 'web-control-i', f.ctx)) as { receipt?: { terminal: boolean } };
      expect(reconciled.receipt?.terminal).toBe(true);

      // A stored receipt is never overwritten by a later observation error.
      await f.tasks.commandCreate(id, pause('web-control-j'), f.ctx);
      expect(f.store.controlRequest('web-control-j')!.lastReceiptJson).toContain('"receiptRevision":"1"');
      f.source.failGets({ status: 500, code: 'INTERNAL' });
      const view = data(await f.tasks.command(id, 'web-control-j', f.ctx)) as { receipt?: { receiptRevision: string }; sourceError?: { code: string } };
      expect(view.receipt?.receiptRevision).toBe('1');
      expect(view.sourceError?.code).toBe('INTERNAL');
      f.source.failGets(null);

      // Transport exception (non-ServiceProblem) → SOURCE_REPLY_UNCONFIRMED.
      // (STOP is admitted even while the PAUSE above is still pending.)
      f.source.failNextPost('THROW');
      const lost = await f.tasks.commandCreate(id, stop('web-control-k'), f.ctx);
      expect(lost.status).toBe(202);
      expect((data(lost).sourceError as { code: string }).code).toBe('SOURCE_REPLY_UNCONFIRMED');
      const row = f.store.controlRequest('web-control-k')!;
      expect(row.dispatchStartedAt).toBeTruthy();
      expect(row.lastReceiptJson).toBeUndefined(); // still pending, replayable
    } finally { f.store.close(); }
  });

  it('a definitive source rejection settles the request as a 200 view with sourceRejection', async () => {
    const f = fixture();
    try {
      const id = await launched(f);
      f.source.failNextPost({ status: 409, code: 'STATE_VERSION_CONFLICT' });
      const out = await f.tasks.commandCreate(id, pause('web-control-l'), f.ctx);
      expect(out.status).toBe(200);
      expect((data(out).sourceRejection as { code: string }).code).toBe('STATE_VERSION_CONFLICT');
      expect(f.store.ledgerGet('web-control-l')?.state).toBe('SETTLED');
      const observed = data(await f.tasks.commands(id,new URLSearchParams('runId=run-one'),f.ctx)) as any;
      expect(observed.recentRequests[0].sourceRejection.code).toBe('STATE_VERSION_CONFLICT');
      expect(observed.pendingRequests).toEqual([]);
    } finally { f.store.close(); }
  });

  it('rejects out-of-contract bodies (runId/sessionId/actor/version-on-STOP/missing version) with 400', async () => {
    const f = fixture();
    try {
      const id = await launched(f);
      for (const body of [
        { requestKey: 'web-control-m1', intent: 'STOP', runId: 'run-one' },
        { requestKey: 'web-control-m2', intent: 'STOP', expectedStateVersion: 5 },
        { requestKey: 'web-control-m3', intent: 'PAUSE' },
        { requestKey: 'web-control-m4', intent: 'PAUSE', expectedStateVersion: 5, actor: { principalId: 'x' } },
        { requestKey: 'web-control-m5', intent: 'RESUME', expectedStateVersion: 5, sessionId: 'session-one' },
      ]) {
        await expect(f.tasks.commandCreate(id, body, f.ctx)).rejects.toMatchObject({ status: 400, code: 'INVALID_REQUEST' });
      }
      expect(f.source.posts).toHaveLength(0);
    } finally { f.store.close(); }
  });

  it('unbound task: POST is 409 TASK_RUN_UNBOUND and the GET view reports RUN_NOT_ASSIGNED', async () => {
    const f = fixture();
    try {
      f.store.upsertTask({ taskId: 'bare-task' });
      await expect(f.tasks.commandCreate('bare-task', stop('web-control-n'), f.ctx))
        .rejects.toMatchObject({ status: 409, code: 'TASK_RUN_UNBOUND' });
      const view = data(await f.tasks.commands('bare-task', new URLSearchParams(), f.ctx)) as { allowedIntents: string[]; reasonCodes: string[] };
      expect(view.allowedIntents).toEqual([]);
      expect(view.reasonCodes).toContain('RUN_NOT_ASSIGNED');
      await expect(f.tasks.command('bare-task', 'web-control-n', f.ctx))
        .rejects.toMatchObject({ status: 404, code: 'REQUEST_NOT_FOUND' });
    } finally { f.store.close(); }
  });

  it('TASK_COMMANDS accepts only limit/before and rejects unknown keys or out-of-range limit with 400', async () => {
    const f = fixture();
    try {
      const id = await launched(f);
      for (const q of ['bogus=1', 'limit=0', 'limit=101', 'limit=abc', 'limit=1&before=%07']) {
        await expect(f.tasks.commands(id, new URLSearchParams(q), f.ctx)).rejects.toMatchObject({ status: 400, code: 'INVALID_REQUEST' });
      }
      const ok = await f.tasks.commands(id, new URLSearchParams('limit=5&before=web-control-e'), f.ctx);
      expect(ok.status).toBe(200);
      const def = await f.tasks.commands(id, new URLSearchParams(), f.ctx);
      expect(def.status).toBe(200);
    } finally { f.store.close(); }
  });

  it('terminal receipt settles the request and returns 200', async () => {
    const f = fixture();
    try {
      const id = await launched(f);
      f.source.terminalNextPost();
      const out = await f.tasks.commandCreate(id, stop('web-control-o'), f.ctx);
      expect(out.status).toBe(200);
      expect((data(out).receipt as { terminal: boolean }).terminal).toBe(true);
      // Settled requests are no longer pending and serve the stored view.
      const view = data(await f.tasks.commands(id, new URLSearchParams(), f.ctx)) as { pendingRequests: unknown[] };
      expect(view.pendingRequests).toHaveLength(0);
    } finally { f.store.close(); }
  });

  it('single-request GET validates taskId/requestKey like its sibling routes', async () => {
    const f = fixture();
    try {
      const id = await launched(f);
      for (const [taskId, key] of [
        [id, 'bad key!'], [id, ''], ['bad task!', 'web-control-ok'], ['', 'web-control-ok'],
      ] as const) {
        await expect(f.tasks.command(taskId, key, f.ctx)).rejects.toMatchObject({ status: 400, code: 'INVALID_REQUEST' });
      }
      // A well-formed unknown key is still a 404 (no disclosure of other tasks' keys).
      await expect(f.tasks.command(id, 'web-control-none', f.ctx)).rejects.toMatchObject({ status: 404, code: 'REQUEST_NOT_FOUND' });
    } finally { f.store.close(); }
  });

  it('a fresher receipt or a definitive rejection clears the recorded ambiguous error', async () => {
    const f = fixture();
    try {
      const id = await launched(f);
      // Lost reply → pending with lastSourceError.
      f.source.failNextPost('THROW');
      const lost = await f.tasks.commandCreate(id, pause('web-control-p'), f.ctx);
      expect(lost.status).toBe(202);
      expect(f.store.controlRequest('web-control-p')!.lastSourceErrorJson).toBeTruthy();
      // The source actually committed: a read-only reconcile folds the
      // receipt AND clears the stale ambiguous error.
      f.source.commands.set('web-control-p', {
        schemaVersion: 'run-command-receipt/1', commandId: 'web-control-p',
        receiptId: 'rcpt-p', sessionId: 'session-one', runId: 'run-one',
        intent: 'PAUSE', phase: 'APPLIED', receiptRevision: '1',
        acceptedAt: '2026-10-20T00:00:01Z',
        actor: { principalId: 'principal-one', clientSessionId: 'client-one' },
        acceptedStateVersion: 5, observedStateVersion: 6,
        observedRunState: 'PAUSED', terminal: true,
      });
      await f.tasks.command(id, 'web-control-p', f.ctx);
      expect(f.store.controlRequest('web-control-p')!.lastSourceErrorJson).toBeUndefined();

      // Same for a definitive rejection discovered on replay.
      f.source.failNextPost('THROW');
      const lost2 = await f.tasks.commandCreate(id, stop('web-control-q'), f.ctx);
      expect(lost2.status).toBe(202);
      expect(f.store.controlRequest('web-control-q')!.lastSourceErrorJson).toBeTruthy();
      f.source.dropCommand('web-control-q'); // source lost it before committing
      f.source.failNextPost({ status: 409, code: 'RUN_NOT_FOUND' });
      const rejected = await f.tasks.commandCreate(id, stop('web-control-q'), f.ctx);
      expect(rejected.status).toBe(200);
      expect(f.store.controlRequest('web-control-q')!.sourceRejectionJson).toContain('RUN_NOT_FOUND');
      expect(f.store.controlRequest('web-control-q')!.lastSourceErrorJson).toBeUndefined();
    } finally { f.store.close(); }
  });
});
