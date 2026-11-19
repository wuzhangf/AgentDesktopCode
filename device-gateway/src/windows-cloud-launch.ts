import { readFileSync } from 'node:fs';
import { LocalTaskAccess, type LocalAuthLike, type LocalStoreLike, type LocalTransportLike } from './local-tasks.js';
import { fail, GatewayError, hash, isRecord, permitsLaunch, scopeContains, type Device, type LaunchScope } from './protocol.js';

type Json = Record<string, unknown>;
const root = '/api/daily/v1/member/link/v2';
const kind = 'link.task.launch.v2';
const actionKind = 'link.task.action.v2';
const journal = 'windows-cloud-launch';
const actions = 'windows-cloud-action';
const identifier = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(value);
const time = (value: unknown): number => typeof value === 'string' ? Date.parse(value) : NaN;

interface Session {
  bearer: string;
  memberId: string;
  workspaceId: string;
  instanceId: string;
  scope: string;
}

interface Grant {
  revision: number;
  scopes: LaunchScope[];
  controls: boolean;
  approvals: boolean;
}

type CloudAction = 'message' | 'stop' | 'approval_response';
type PendingApproval = {
  kind: 'CONFIRM';
  questionId: string;
  fingerprint: string;
  round: number;
  summary: string;
};

interface Action {
  id: string;
  commandId: string;
  scope: string;
  workId: string;
  generation: number;
  kind: CloudAction;
  requestKey: string;
  fingerprint: string;
  outcome?: 'executed' | 'expired' | 'conflict';
  detail?: string;
  closed?: boolean;
}

interface Delivery {
  id: string;
  workId: string;
  generation: number;
  digest: string;
  nativeKey: string;
  scope: string;
  grantRevision: number;
  target: Json;
  phase: 'claimed' | 'submitting' | 'receipt' | 'tracking' | 'result' | 'closed';
  taskId?: string;
  outcome?: 'accepted' | 'not_accepted';
  observedState?: string;
  resultObservedAt?: string;
  activeRunId?: string;
  executionEpoch?: number;
  supportedActions?: string[];
  pendingInputs?: PendingApproval[];
  eventNumber?: number;
  pendingObservation?: Json;
}

export class WindowsCloudLaunch {
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = true;
  private backoff = 3000;
  private readonly abort = new AbortController();

  constructor(
    private readonly store: LocalStoreLike,
    private readonly localCatalog: LocalTaskAccess,
    private readonly transport: LocalTransportLike,
    private readonly hostId: string,
    private readonly origin: string,
    private readonly sessionFile: string,
    private readonly grantFile: string,
    private readonly fetcher: typeof fetch = fetch,
    private readonly recoveryOnly = false,
  ) {}

  start(): void {
    this.stopped = false;
    void this.schedule();
  }

  stop(): void {
    this.stopped = true;
    this.abort.abort();
    clearTimeout(this.timer);
  }

  private async schedule(): Promise<void> {
    try {
      await this.tick();
      this.backoff = 3000;
    } catch {
      this.backoff = Math.min(60_000, this.backoff * 2);
    } finally {
      if (!this.stopped) this.timer = setTimeout(() => void this.schedule(), this.backoff);
    }
  }

  private session(): Session | undefined {
    try {
      const values = new Map(readFileSync(this.sessionFile, 'utf8').split(/\r?\n/).flatMap(line => {
        const match = /^PAC_RELAY_([A-Z_]+)=(.*)$/.exec(line);
        return match ? [[match[1]!, match[2]!.trim()] as const] : [];
      }));
      const bearer = values.get('AGENT_ACCESS_TOKEN');
      const memberId = values.get('MEMBER_ID');
      const workspaceId = values.get('WORKSPACE_ID');
      const instanceId = values.get('AGENT_INSTANCE_ID');
      if (!bearer || !identifier(memberId) || !identifier(workspaceId) || !identifier(instanceId)
          || values.get('MEMBER_ORIGIN') !== this.origin || values.get('CLIENT_ID') !== 'agent-link') return;
      return { bearer, memberId, workspaceId, instanceId,
        scope: hash(JSON.stringify([this.origin, memberId, workspaceId, instanceId])) };
    } catch { return; }
  }

  private grant(session: Session): Grant | undefined {
    try {
      const value: unknown = JSON.parse(readFileSync(this.grantFile, 'utf8').replace(/^\uFEFF/, ''));
      if (!isRecord(value) || value.schemaVersion !== 'windows-cloud-launch-grant/1'
          || value.memberId !== session.memberId || value.workspaceId !== session.workspaceId
          || value.instanceId !== session.instanceId || typeof value.revision !== 'number'
          || !Number.isSafeInteger(value.revision) || value.revision < 1
          || !Array.isArray(value.launchScopes) || value.launchScopes.length > 100) return;
      const scopes: LaunchScope[] = [];
      for (const scope of value.launchScopes) {
        if (!isRecord(scope) || !identifier(scope.backendStoreId) || !identifier(scope.projectId)
            || !identifier(scope.engineId) || scope.engineId === 'macos') return;
        scopes.push({ backendStoreId: scope.backendStoreId, projectId: scope.projectId, engineId: scope.engineId });
      }
      return { revision: value.revision, scopes, controls: value.controls === true,
        approvals: value.approvals === true };
    } catch { return; }
  }

  private async hosted(session: Session, method: 'GET' | 'POST' | 'PUT', path: string, body?: Json): Promise<Json> {
    if (this.session()?.scope !== session.scope) fail('CLOUD_SESSION_CHANGED', 409);
    const response = await this.fetcher(`${this.origin}${root}${path}`, {
      method, redirect: 'error',
      signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(8000)]),
      headers: { Authorization: `Bearer ${session.bearer}`, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const reply: unknown = await response.json();
    if (!response.ok) {
      fail(isRecord(reply) && typeof reply.code === 'string' ? reply.code : 'CLOUD_REQUEST_FAILED', response.status);
    }
    if (!isRecord(reply)) fail('CLOUD_RESPONSE_INVALID', 502);
    return reply;
  }

  private save(row: Delivery): void { this.store.put(journal, row.id, row); }

  async tick(): Promise<void> {
    const session = this.session();
    if (!session) return;
    const grant = this.grant(session);
    const prior = this.store.get<{ checkedAt: number; grant: string }>('windows-cloud-directory', session.scope);
    if (!this.recoveryOnly && !grant && !prior) return;
    // Existing receipts and observations keep moving when publication or
    // claiming hits a temporary endpoint error.
    for (const row of this.store.list<Delivery>(journal)) {
      if (row.scope !== session.scope || row.phase === 'closed' || row.phase === 'claimed') continue;
      try { await this.resume(session, row); } catch { /* the original journal entry remains */ }
    }
    for (const action of this.store.list<Action>(actions)) {
      if (action.scope !== session.scope || action.closed) continue;
      try { await this.resumeAction(session, action); } catch { /* keep the original action outbox */ }
    }
    if (this.recoveryOnly) return;
    const grantDigest = hash(JSON.stringify(grant ?? null));
    if (!prior || prior.grant !== grantDigest || Date.now() - prior.checkedAt > 30_000) {
      await this.publish(session, grant);
      this.store.put('windows-cloud-directory', session.scope, { checkedAt: Date.now(), grant: grantDigest });
    }
    if (!grant || grant.scopes.length === 0 || this.abort.signal.aborted) return;
    const kinds = grant.controls || grant.approvals ? `${kind},${actionKind}` : kind;
    const batch = await this.hosted(session, 'GET', `/task-claims?limit=4&kinds=${kinds}`);
    for (const command of Array.isArray(batch.commands) ? batch.commands : []) {
      try {
        if (isRecord(command) && command.kind === actionKind) await this.consumeAction(session, command);
        else await this.consume(session, grant, command);
      } catch { /* leave this delivery for recovery */ }
    }
  }

  private async publish(session: Session, grant: Grant | undefined): Promise<void> {
    const targets = grant?.scopes.length ? await this.targets(grant) : [];
    if (JSON.stringify(this.grant(session) ?? null) !== JSON.stringify(grant ?? null)) return;
    const path = `/instances/${session.instanceId}/targets`;
    const previous = await this.hosted(session, 'GET', path);
    await this.hosted(session, 'PUT', path, { expectedRevision: previous.revision, targets });
  }

  private async targets(grant: Grant): Promise<Json[]> {
    let catalog: Json;
    try { catalog = await this.localCatalog.ownerCatalog(); }
    catch (error) {
      if (error instanceof GatewayError && error.code === 'LOCAL_SOURCE_UNAVAILABLE') return [];
      throw error;
    }
    const entries = this.localCatalog.linkTargets(catalog).targets;
    return Array.isArray(entries) ? entries.filter(target => isRecord(target) && target.sourceKind === 'NATIVE'
      && grant.scopes.some(scope => this.matches(scope, target))) : [];
  }

  private matches(scope: LaunchScope, target: Json): boolean {
    return scope.backendStoreId === target.backendId && scope.projectId === target.projectId
      && scope.engineId === target.engineId;
  }

  private async consume(session: Session, grant: Grant, command: unknown): Promise<void> {
    if (!isRecord(command) || command.kind !== kind || !identifier(command.commandId)
        || !identifier(command.workId) || typeof command.deliveryGeneration !== 'number'
        || !isRecord(command.payload)) return;
    const payload = command.payload;
    if (!isRecord(payload.target) || payload.target.instanceId !== session.instanceId
        || !identifier(payload.nativeRequestKey) || typeof payload.payloadDigest !== 'string') return;
    const id = hash(`${session.scope}:${command.commandId}`);
    const old = this.store.get<Delivery>(journal, id);
    if (old && (old.workId !== command.workId || old.digest !== payload.payloadDigest
        || old.nativeKey !== payload.nativeRequestKey)) {
      fail('CLOUD_REQUEST_CONFLICT', 409);
    }
    const row: Delivery = { ...(old ?? {
      id, scope: session.scope, workId: command.workId, digest: payload.payloadDigest,
      nativeKey: payload.nativeRequestKey, target: payload.target,
      grantRevision: grant.revision, phase: 'claimed',
    }), generation: command.deliveryGeneration };
    this.save(row);
    if (row.phase !== 'claimed') return this.resume(session, row);
    const target = row.target;
    const instruction = isRecord(payload.instruction) ? payload.instruction.text : undefined;
    const scope = grant.scopes.find(entry => this.matches(entry, target));
    const revision = typeof target.capabilityRevision === 'string' ? target.capabilityRevision : undefined;
    const supported = row.grantRevision === grant.revision && target.sourceKind === 'NATIVE'
      && scope && typeof instruction === 'string'
      && instruction.trim() && instruction.length <= 16_000
      && Array.isArray(payload.attachments) && payload.attachments.length === 0
      && isRecord(payload.parameters) && Object.keys(payload.parameters).length === 0;
    const path = `/task-claims/${command.commandId}`;
    const preflight = supported ? await this.local(session, row, async access => {
      const live = await this.targets(grant);
      if (!live.some(entry => this.matches(scope, entry as Json) &&
          (revision === undefined || revision === (entry as Json).capabilityRevision))) return;
      return access.remote(row.id, 'POST', `/personal/v1/local-tasks/${scope.backendStoreId}/task-preflights`,
        { projectId: scope.projectId, engineId: scope.engineId }, null, null);
    }) : undefined;
    const authorization = await this.hosted(session, 'POST', `${path}/authorize`, { deliveryGeneration: row.generation });
    if (authorization.requestKey !== row.nativeKey) fail('CLOUD_REQUEST_CONFLICT', 409);
    if (authorization.action === 'lookup') {
      if (old?.phase === 'claimed') {
        // Dispatches always cross the persisted submitting boundary first.
        // A surviving claimed row proves the source call did not start.
        row.phase = 'receipt';
        row.outcome = 'not_accepted';
      } else {
        // The prior gateway's journal may be unavailable. Never replay.
        row.phase = 'submitting';
      }
      this.save(row);
      return this.resume(session, row);
    }
    if (authorization.action !== 'dispatch' || authorization.payloadDigest !== row.digest) {
      fail('CLOUD_REQUEST_CONFLICT', 409);
    }
    const deadline = time(authorization.dispatchBefore);
    if (!supported || row.grantRevision !== grant.revision || !preflight || !isRecord(preflight.body)
        || typeof preflight.body.optionsRevision !== 'string' || !(Date.now() < deadline)) {
      row.phase = 'receipt';
      row.outcome = 'not_accepted';
    } else {
      const launch = { requestKey: row.nativeKey, projectId: scope.projectId,
        engineId: scope.engineId, optionsRevision: preflight.body.optionsRevision, instruction };
      row.phase = 'submitting';
      this.save(row);
      const result = await this.local(session, row, access => access.remote(row.id, 'POST',
        `/personal/v1/local-tasks/${scope.backendStoreId}/tasks`, launch, row.nativeKey, null), deadline);
      this.adopt(row, result.body);
    }
    this.save(row);
    await this.resume(session, row);
  }

  private adopt(row: Delivery, view: unknown): void {
    if (!isRecord(view)) return;
    if (identifier(view.taskId) && view.state === 'OBSERVED') {
      row.taskId = view.taskId;
      row.outcome = 'accepted';
      row.phase = 'receipt';
    } else if (view.state === 'REJECTED') {
      row.outcome = 'not_accepted';
      row.phase = 'receipt';
    }
  }

  private async resume(session: Session, row: Delivery): Promise<void> {
    const backend = row.target.backendId;
    if (!identifier(backend)) return;
    const rootPath = `/personal/v1/local-tasks/${backend}`;
    if (row.phase === 'submitting') {
      const reply = await this.local(session, row, access => access.remote(row.id, 'GET',
        `${rootPath}/task-requests/${row.nativeKey}`, null, null, null));
      this.adopt(row, reply.body);
      this.save(row);
    }
    if (row.phase === 'receipt') {
      const view = await this.hosted(session, 'GET', `/tasks/${row.workId}/agent`);
      const dispatch = view.dispatch;
      if (!isRecord(dispatch) || view.nativeRequestKey !== row.nativeKey || view.payloadDigest !== row.digest) return;
      const command = dispatch.commandId;
      if (!identifier(command) || !row.outcome || dispatch.deliveryGeneration !== row.generation) return;
      const body = { deliveryGeneration: row.generation, outcome: row.outcome,
        ...(row.taskId ? { nativeTaskId: row.taskId } : {}) };
      try { await this.hosted(session, 'POST', `/task-claims/${command}/receipt`, body); }
      catch (error) {
        if (!(error instanceof GatewayError) || error.code !== 'STALE_COMMAND_CLAIM') throw error;
        await this.hosted(session, 'POST', `/task-claims/${command}/reconcile`, body);
      }
      row.phase = row.taskId ? 'tracking' : 'closed';
      this.save(row);
    }
    if (row.phase === 'tracking' && row.taskId) await this.observe(session, row, rootPath, row.taskId);
    if (row.phase === 'result' && row.taskId) {
      await this.hosted(session, 'PUT', `/tasks/${row.workId}/results/primary`, {
        operationId: `win-result-${row.id}`, expectedVersion: 1,
        refs: [{ ref: `native://${backend}/tasks/${row.taskId}`, mediaType: 'application/json' }],
        availability: 'available',
        observedAt: row.resultObservedAt,
      });
      row.phase = 'closed';
      this.save(row);
    }
  }

  private async observe(session: Session, row: Delivery, rootPath: string, taskId: string): Promise<void> {
    if (!row.pendingObservation) {
      const reply = await this.local(session, row, access => access.remote(row.id, 'GET',
        `${rootPath}/tasks/${taskId}`, null, null, null));
      if (!isRecord(reply.body) || reply.body.taskId !== taskId) return;
      const sourceState = reply.body.state;
      const state = typeof sourceState === 'string' ? ({
        QUEUED: 'queued', DISPATCHED: 'queued', RUNNING: 'running', SUCCEEDED: 'succeeded',
        FAILED: 'failed', TIMED_OUT: 'failed', CANCELLED: 'cancelled',
        WAITING_INPUT: 'waiting_input', WAITING_APPROVAL: 'waiting_approval',
      } as Record<string, string>)[sourceState] : undefined;
      if (!state) return;
      const pins = this.pins(reply.body);
      const run = pins ? `win-run-${hash(JSON.stringify(pins))}` : undefined;
      const epoch = (row.executionEpoch ?? 1) + (row.activeRunId && row.activeRunId !== run ? 1 : 0);
      const pendingInputs = await this.pendingApprovals(session, row, `${rootPath}/tasks/${taskId}`, reply.body, pins, epoch);
      const supported = this.supportedActions(session, reply.body, pins, pendingInputs);
      const projectedState = pendingInputs.length > 0 && ['running', 'waiting_input'].includes(state)
        ? 'waiting_approval' : state;
      if (projectedState === row.observedState && run === row.activeRunId &&
          JSON.stringify(supported) === JSON.stringify(row.supportedActions) &&
          JSON.stringify(pendingInputs) === JSON.stringify(row.pendingInputs ?? [])) return;
      row.eventNumber = (row.eventNumber ?? 0) + 1;
      row.pendingObservation = { state: projectedState, sourceState, nativeTaskId: taskId,
        eventId: `win-${row.id}-${row.eventNumber}`, observedAt: new Date().toISOString(),
        executionEpoch: epoch, activeRunId: run, supportedActions: supported, pendingInputs };
      this.save(row);
    }
    await this.hosted(session, 'POST', `/tasks/${row.workId}/observations`, row.pendingObservation);
    row.observedState = row.pendingObservation.state as string;
    row.activeRunId = row.pendingObservation.activeRunId as string | undefined;
    row.executionEpoch = row.pendingObservation.executionEpoch as number;
    row.supportedActions = row.pendingObservation.supportedActions as string[];
    row.pendingInputs = row.pendingObservation.pendingInputs as PendingApproval[] | undefined;
    if (['succeeded', 'failed', 'cancelled'].includes(row.observedState)) {
      row.phase = 'result';
      row.resultObservedAt = row.pendingObservation.observedAt as string;
    }
    delete row.pendingObservation;
    this.save(row);
  }

  private pins(facts: Json): Json | undefined {
    const { generation, nativeSessionId, nativeTurnId, currentCommandId } = facts;
    if (!identifier(generation) || typeof nativeSessionId !== 'string' || !nativeSessionId
        || !identifier(currentCommandId)) return;
    return { generation, nativeSessionId, targetCommandId: currentCommandId,
      ...(typeof nativeTurnId === 'string' && nativeTurnId ? { nativeTurnId } : {}) };
  }

  private supportedActions(session: Session, facts: Json, pins: Json | undefined,
    pending: PendingApproval[]): CloudAction[] {
    if (this.recoveryOnly || !pins) return [];
    const capabilities = isRecord(facts.capabilities) ? facts.capabilities : {};
    const grant = this.grant(session);
    return [...(grant?.controls && capabilities.followUp === true ? ['message' as const] : []),
      ...(grant?.controls && capabilities.stop === true ? ['stop' as const] : []),
      ...(grant?.approvals && pending.length > 0 ? ['approval_response' as const] : [])];
  }

  private async pendingApprovals(session: Session, row: Delivery, route: string,
    facts: Json, pins: Json | undefined, epoch: number): Promise<PendingApproval[]> {
    if (this.recoveryOnly || !this.grant(session)?.approvals || !pins?.nativeTurnId || !['pi', 'sage-pi'].includes(String(facts.engineId)) ||
        !['RUNNING', 'WAITING_INPUT', 'WAITING_APPROVAL'].includes(String(facts.state))) return [];
    const reply = await this.local(session, row, access => access.remote(row.id, 'GET',
      `${route}/input-requests`, null, null, null));
    const questions = isRecord(reply.body) && Array.isArray(reply.body.items) ? reply.body.items : [];
    const pending: PendingApproval[] = [];
    const seen = new Set<string>();
    for (const q of questions.filter(isRecord)) {
      if (q.state !== 'PENDING' || q.method !== 'confirm' || !identifier(q.inputRequestId) ||
          q.generation !== pins.generation || q.nativeSessionId !== pins.nativeSessionId ||
          q.nativeTurnId !== pins.nativeTurnId || q.targetCommandId !== pins.targetCommandId ||
          typeof q.title !== 'string' || !q.title.trim()) continue;
      const summary = [q.title, typeof q.message === 'string' ? q.message : '']
        .map(field => field.trim()).filter(Boolean).join('\n');
      if (Buffer.byteLength(summary) > 1024) continue;
      if (seen.has(q.inputRequestId) || pending.length === 32) return [];
      seen.add(q.inputRequestId);
      pending.push({ kind: 'CONFIRM', questionId: q.inputRequestId, round: epoch,
        summary,
        fingerprint: hash(JSON.stringify([pins, q.inputRequestId, q.title, q.message ?? null])) });
    }
    return pending.sort((a, b) => a.questionId.localeCompare(b.questionId));
  }

  private launchFor(action: Action): Delivery | undefined {
    return this.store.list<Delivery>(journal).find(row => row.scope === action.scope && row.workId === action.workId);
  }

  private async consumeAction(session: Session, command: Json): Promise<void> {
    if (!identifier(command.commandId) || !identifier(command.workId) ||
        !Number.isSafeInteger(command.deliveryGeneration) || !isRecord(command.payload)) return;
    const payload = command.payload;
    if (!identifier(payload.operationId) || payload.workId !== command.workId ||
        !isRecord(payload.payload) ||
        (payload.kind !== 'message' && payload.kind !== 'stop' && payload.kind !== 'approval_response')) return;
    const id = hash(`${session.scope}:${command.commandId}`);
    const fingerprint = hash(JSON.stringify(payload));
    const existing = this.store.get<Action>(actions, id);
    if (existing && existing.fingerprint !== fingerprint) fail('CLOUD_ACTION_CONFLICT', 409);
    const action: Action = { ...(existing ?? { id, scope: session.scope, commandId: command.commandId,
      workId: command.workId, fingerprint, kind: payload.kind, requestKey: `win-action-${id}` }),
      generation: command.deliveryGeneration as number };
    if (existing) {
      this.store.put(actions, id, action);
      // The local input ledger is written before any Worker dispatch. Only
      // a missing local row under a freshly claimed delivery permits another
      // admission attempt, with the original key and current guards.
      if (await this.resumeAction(session, action) !== 'unstarted') return;
    }
    const launch = this.launchFor(action);
    const deadline = Math.min(time(payload.expiresAt), time(command.claimUntil));
    const decide = (outcome: Action['outcome'], detail: string) => {
      action.outcome = outcome;
      action.detail = detail;
      this.store.put(actions, id, action);
    };
    if (!(Date.now() < deadline)) decide('expired', 'action_deadline');
    else if (!launch?.taskId || !identifier(launch.target.backendId)) decide('conflict', 'work_binding_missing');
    else {
      const taskPath = `/personal/v1/local-tasks/${launch.target.backendId}/tasks/${launch.taskId}`;
      const work = await this.hosted(session, 'GET', `/tasks/${action.workId}/agent`);
      const execution = isRecord(work.execution) ? work.execution : {};
      const input = payload.payload;
      const current = await this.local(session, launch, access => access.remote(launch.id, 'GET', taskPath,
        null, null, null));
      const facts = isRecord(current.body) ? current.body : {};
      const pins = this.pins(facts);
      const run = pins ? `win-run-${hash(JSON.stringify(pins))}` : undefined;
      const pending = action.kind === 'approval_response'
        ? await this.pendingApprovals(session, launch, taskPath, facts, pins, launch.executionEpoch ?? 1) : [];
      if (!pins || !run || run !== launch.activeRunId || run !== input.activeRunId || run !== execution.activeRunId
          || input.executionEpoch !== launch.executionEpoch || input.executionEpoch !== execution.executionEpoch
          || execution.nativeTaskId !== launch.taskId || !this.supportedActions(session, facts, pins, pending).includes(action.kind)) {
        decide('conflict', 'stale_execution');
      } else if (action.kind === 'approval_response' &&
          (!pending.some(q => q.questionId === input.questionId && q.round === input.round && q.fingerprint === input.fingerprint)
            || (input.decision !== 'approve' && input.decision !== 'reject'))) {
        decide('conflict', 'stale_approval');
      } else if (action.kind === 'message' && (typeof input.text !== 'string' || !input.text.trim()
          || Buffer.byteLength(input.text, 'utf8') > 16384)) {
        decide('conflict', 'message_invalid');
      } else {
        const body = { ...pins, requestKey: action.requestKey,
          ...(action.kind === 'stop' ? { intent: 'STOP' }
            : action.kind === 'approval_response' ? { response: { confirmed: input.decision === 'approve' } }
              : { kind: 'NATIVE_FOLLOW_UP', content: input.text }) };
        const tail = action.kind === 'stop' ? 'commands'
          : action.kind === 'approval_response' ? `input-requests/${String(input.questionId)}/responses` : 'messages';
        this.store.put(actions, id, action);
        try {
          const reply = await this.local(session, launch, access => access.remote(launch.id, 'POST',
            `${taskPath}/${tail}`, body, action.requestKey, null), deadline, action.kind);
          if (isRecord(reply.body) && reply.body.state === 'REJECTED') decide('conflict', 'source_rejected');
        } catch (error) {
          if (!(error instanceof GatewayError) || ![400, 403, 409, 422].includes(error.httpStatus)) throw error;
          decide('conflict', 'source_guard_rejected');
        }
      }
    }
    await this.resumeAction(session, action);
  }

  private async resumeAction(session: Session, action: Action): Promise<void | 'unstarted'> {
    if (action.closed) return;
    if (!action.outcome) {
      const launch = this.launchFor(action);
      if (!launch?.taskId || !identifier(launch.target.backendId)) return;
      const route = `/personal/v1/local-tasks/${launch.target.backendId}/tasks/${launch.taskId}`;
      let reply;
      try {
        reply = await this.local(session, launch, access => access.remote(launch.id, 'GET',
          `${route}/requests/${action.requestKey}`, null, null, null));
      } catch (error) {
        if (error instanceof GatewayError && error.httpStatus === 404 && error.code === 'NOT_FOUND') {
          return 'unstarted';
        }
        throw error;
      }
      if (!isRecord(reply.body)) return;
      if (reply.body.state === 'REJECTED') {
        action.outcome = 'conflict';
        action.detail = 'source_rejected';
      } else if (reply.body.state === 'OBSERVED') {
        const source = isRecord(reply.body.source) ? reply.body.source : {};
        const end = isRecord(source.result) ? source.result.state : undefined;
        if (action.kind === 'stop' && source.state !== 'STOPPED' &&
            !(source.state === 'SUCCEEDED' && ['CANCELLED', 'STOPPED'].includes(String(end)))) return;
        if (action.kind === 'message' && !['ACCEPTED', 'SUCCEEDED'].includes(String(source.state))) return;
        if (action.kind === 'approval_response' &&
            (source.kind !== 'INPUT_RESPONSE' || source.taskId !== launch.taskId || source.state !== 'CONSUMED')) return;
        action.outcome = 'executed';
      } else return;
      this.store.put(actions, action.id, action);
    }
    await this.hosted(session, 'POST', `/task-claims/${action.commandId}/receipt`, {
      deliveryGeneration: action.generation, outcome: action.outcome, detail: action.detail,
    });
    action.closed = true;
    this.store.put(actions, action.id, action);
  }

  private async local<T>(session: Session, row: Delivery,
    operation: (access: LocalTaskAccess) => Promise<T>, deadline?: number, control?: CloudAction): Promise<T> {
    const principal = `win-cloud-${hash(JSON.stringify([row.scope, row.grantRevision]))}`;
    const assertCurrent = (): Grant => {
      const grant = this.grant(session);
      if (this.abort.signal.aborted || this.session()?.scope !== session.scope || grant?.revision !== row.grantRevision
          || !grant.scopes.some(scope => this.matches(scope, row.target))
          || control && !(control === 'approval_response' ? grant.approvals : grant.controls)) {
        fail('CLOUD_SCOPE_CHANGED', 403);
      }
      return grant;
    };
    const device = (): Device => {
      // Old receipts need the original local principal. For read/lookup
      // operations, derive only its already-journaled scope even after
      // withdrawal. Any new execution still requires the current grant.
      if (this.abort.signal.aborted || this.session()?.scope !== session.scope) fail('CLOUD_SCOPE_CHANGED', 403);
      const target = row.target;
      if (!identifier(target.backendId) || !identifier(target.projectId) || !identifier(target.engineId)) {
        fail('CLOUD_SCOPE_CHANGED', 403);
      }
      const scopes = deadline !== undefined ? assertCurrent().scopes
        : [{ backendStoreId: target.backendId, projectId: target.projectId, engineId: target.engineId }];
      return { id: principal, revision: row.grantRevision, state: 'ACTIVE', scopeVersion: 2,
        actions: ['OBSERVE', 'LAUNCH',
          ...(control === 'approval_response' ? ['APPROVE'] : control ? ['INTERACT', 'CONTROL'] : [])],
        launchScopes: scopes,
        resources: this.store.get('windows-cloud-resources', principal) ?? [],
        absoluteExpiry: 0, idleExpiry: 0, accessExpiry: 0, recoverUntil: 0, spentRefresh: [] };
    };
    const authenticate = (token: string): Device => {
      if (token !== row.id) fail('CLOUD_SCOPE_CHANGED', 403);
      return device();
    };
    const authorize = (backend: string, task: string, action: string): Device => {
      const current = device();
      if (!current.actions?.includes(action) || !scopeContains(current, 'WORKER_LOCAL', backend, task)) {
        fail('CLOUD_SCOPE_CHANGED', 403);
      }
      return current;
    };
    const auth: LocalAuthLike = {
      ownerStatus: () => ({ personalHostId: this.hostId }), authenticate,
      activeDevice: value => value === principal ? device() : fail('CLOUD_SCOPE_CHANGED', 403),
      authorizeLaunch: (token, backend, project, engine) => {
        const current = authenticate(token);
        if (!this.matches({ backendStoreId: backend, projectId: project, engineId: engine }, row.target)
            || !permitsLaunch(current, backend, project, engine)) fail('CLOUD_SCOPE_CHANGED', 403);
        return current;
      },
      authorizeLocal: (token, backend, task, action) => { authenticate(token); return authorize(backend, task, action); },
      authorizeLocalDevice: (value, backend, task, action) => value === principal
        ? authorize(backend, task, action) : fail('CLOUD_SCOPE_CHANGED', 403),
      appendLaunchedTask: (value, revision, backend, project, engine, taskId) => {
        const current = device();
        if (value !== principal || revision !== current.revision ||
            !this.matches({ backendStoreId: backend, projectId: project, engineId: engine }, row.target)) {
          fail('CLOUD_SCOPE_CHANGED', 403);
        }
        if (!scopeContains(current, 'WORKER_LOCAL', backend, taskId)) {
          this.store.put('windows-cloud-resources', principal,
            [...(current.resources ?? []), { kind: 'WORKER_LOCAL', backendStoreId: backend, taskId }]);
        }
      },
    };
    return operation(new LocalTaskAccess(auth, this.transport, this.store, undefined,
      deadline === undefined ? undefined : () => { assertCurrent(); return deadline; }));
  }
}
