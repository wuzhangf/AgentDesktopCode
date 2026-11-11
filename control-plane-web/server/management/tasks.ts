import { createHash, randomUUID } from 'node:crypto';
import { validPersonalOperation, type PersonalEnvelope } from '../../../codeagent-desktop/packages/protocol/src/personal';
import type { PersonalTaskCreate, PersonalTaskIndex, PersonalTaskDetail, AcsTaskLaunchFacts } from '../../../codeagent-desktop/packages/protocol/src/personal-task';
import type { TaskMetricsReader } from './task-metrics';
import { PersonalTaskEngagements } from './task-engagements';
import { PersonalTaskInteractions } from './task-interactions';
import { PersonalTaskCollaboration } from './task-collaboration';
import { PersonalTaskControls } from './task-control';
import { NativeTasks } from './native-tasks';
import { canonicalDigest } from './canonical';
import { ManagementError, invalid } from './errors';
import type { ManagementStore, TaskRow } from './registry-store';
import type { ConnectionHub } from './upstream';
import type { GatewayCallContext } from './service';

const fail = (code: string, message: string): never => { throw new ManagementError(409, code, message, false); };
const child = (key: string, stage: string) => createHash('sha256').update(key + ':' + stage).digest('hex');

export class PersonalTasks {
  private flights = new Map<string, {digest: string; promise: Promise<{status: number; body: unknown}>}>();
  /** Reliable control (PAUSE/RESUME/STOP) submodule; reuses this facade's
   * client()/facts()/envelope()/row() so there is one task surface. */
  readonly controls: PersonalTaskControls;
  readonly interactions: PersonalTaskInteractions;
  readonly engagements: PersonalTaskEngagements;
  readonly collaboration: PersonalTaskCollaboration;
  readonly native: NativeTasks;
  constructor(private store: ManagementStore, private hub: ConnectionHub, private instance: string, private metrics: TaskMetricsReader) {
    this.controls = new PersonalTaskControls(store, hub, this);
    this.interactions = new PersonalTaskInteractions(store, this);
    this.engagements = new PersonalTaskEngagements(store, this);
    this.collaboration = new PersonalTaskCollaboration(store, this);
    this.native = new NativeTasks(store,hub,this);
  }
  envelope<T>(data: T, supportedActions: string[] = []): PersonalEnvelope<T> {
    return { data, meta: { source: 'personal-management', instance: this.instance,
      controlPlaneId: this.store.controlPlaneId, observedAt: new Date().toISOString(),
      revision: String(this.store.registryRevision()), supportedActions, reasonCodes: [] } };
  }
  facts(row: TaskRow): AcsTaskLaunchFacts | undefined { if(this.native.facts(row))return fail('ACS_BINDING_REQUIRED','该任务使用本机原生来源');return row.launchJson ? JSON.parse(row.launchJson) : undefined; }
  index(row: TaskRow): PersonalTaskIndex {
    if(this.native.facts(row))return this.native.index(row);
    const f = this.facts(row);
    return { taskId: row.taskId, projectId: row.projectId, displayName: row.displayName,
      createdAt: row.createdAt, updatedAt: row.updatedAt, requestKey: row.requestKey,
      sessionId: f?.session?.sessionId, runId: f?.runId, accepted: !!f?.acceptance,
      core: 'ACS' };
  }
  row(id: string) { const row = this.store.getTask(id); if (!row) throw new ManagementError(404, 'TASK_NOT_FOUND', 'Task not found', false); return row; }
  async client(connectionId: string, ctx: GatewayCallContext, storeId?: string) {
    const connection = this.store.getConnection(connectionId);
    if (!connection?.baseUrl) return fail('ACS_REQUIRED', 'ACS service is not configured');
    const session = await ctx.acsSessionFor(connectionId);
    if (!session?.storeId) return fail('SOURCE_IDENTITY_REQUIRED', 'ACS did not supply its store identity');
    if (storeId && storeId !== session.storeId) return fail('SOURCE_IDENTITY_CHANGED', 'ACS 数据库身份已改变；原任务保持不变，请恢复原连接');
    return { client: this.hub.handle(connection).acs(session), storeId: session.storeId };
  }
  async available(ctx: GatewayCallContext) {
    let locals:import('../../../codeagent-desktop/packages/protocol/src/personal-task').AvailableProject[]=[];
    try{locals=await this.native.available();}catch(error){if(!this.store.listConnections().some(c=>c.kind!=='WORKER_LOCAL'&&c.baseUrl))throw error;}
    if(!this.store.listConnections().some(c=>c.kind!=='WORKER_LOCAL'&&c.baseUrl))return {status:200,body:this.envelope(locals,['REGISTER_PROJECT'])};
    const { connection } = this.hub.primary();
    try{const { client } = await this.client(connection.connectionId, ctx);
    return { status: 200, body: this.envelope([...await client.listProjects(),...locals], ['REGISTER_PROJECT']) };}
    catch(error){if(locals.length)return {status:200,body:this.envelope(locals,['REGISTER_PROJECT'])};throw error;}
  }
  async options(projectId: string, ctx: GatewayCallContext):Promise<{status:number;body:PersonalEnvelope<import('../../../codeagent-desktop/packages/protocol/src/personal-task').PersonalTaskOptions>}> {
    if(this.hub.forProject(projectId).handle.kind==='WORKER_LOCAL')return this.native.options(projectId);
    const { project } = this.hub.forProject(projectId);
    const { client } = await this.client(project.connectionId, ctx);
    const [preflight, capabilities] = await Promise.all([client.getProjectSessionPreflight(project.projectRef), client.getCapabilities()]);
    const issues: {code: string; message: string; blocking: boolean}[] = [];
    if (!capabilities.features.sessionV2 || !capabilities.features.worktreeExecution) issues.push({ code: 'EXECUTION_UNAVAILABLE', message: 'ACS 未声明会话与隔离工作树执行能力', blocking: true });
    if (!preflight.allowedIntents.includes('CODE') || !preflight.headRevision) issues.push({ code: 'CODE_UNAVAILABLE', message: '项目当前不能执行代码任务或没有 Git 基线', blocking: true });
    if (preflight.modelAvailability !== 'AVAILABLE') issues.push({ code: 'MODEL_UNAVAILABLE', message: `默认模型：${preflight.modelAvailability ?? '未知'}`, blocking: true });
    const [profiles, models] = await Promise.allSettled([client.listAgentProfiles(), client.getModelCatalog()]);
    return { status: 200, body: this.envelope({ preflight,
      profiles: profiles.status === 'fulfilled' && Array.isArray(profiles.value?.profiles) ? profiles.value : null,
      models: models.status === 'fulfilled' && Array.isArray(models.value?.items) ? { ...models.value, revision: canonicalDigest(models.value.items.map(m => ({ providerId: m.providerId, modelAlias: m.modelAlias, availability: m.availability }))) } : null, issues }, issues.some(i => i.blocking) ? [] : ['TASK_CREATE']) };
  }
  list(query: URLSearchParams) {
    if ([...query.keys()].some(k => !['cursor', 'limit'].includes(k))) return invalid();
    const limit = Number(query.get('limit') ?? 30);
    let cursor: {createdAt: string; taskId: string} | undefined;
    if (query.has('cursor')) {
      try { cursor = JSON.parse(Buffer.from(query.get('cursor')!, 'base64url').toString('utf8')); } catch { return invalid(); }
      if (!cursor || Object.keys(cursor).sort().join(',') !== 'createdAt,taskId' || typeof cursor.createdAt !== 'string' || !Number.isFinite(Date.parse(cursor.createdAt)) || typeof cursor.taskId !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/.test(cursor.taskId)) return invalid();
    }
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) return invalid();
    const rows = this.store.listTasks(limit + 1, cursor);
    return { status: 200, body: this.envelope({ items: rows.slice(0, limit).map(r => this.index(r)), nextCursor: rows.length > limit ? Buffer.from(JSON.stringify({createdAt: rows[limit - 1]!.createdAt, taskId: rows[limit - 1]!.taskId})).toString('base64url') : null }) };
  }
  async request(key: string) {
    // Read-only reconciliation may wait for an already running submission.
    // A 404 must not race a still-running preflight that could later dispatch.
    await this.flights.get(key)?.promise.catch(() => undefined);
    const ledger = this.store.ledgerGet(key);
    if (ledger?.route !== 'TASK_CREATE' || !ledger.subjectId) throw new ManagementError(404, 'REQUEST_NOT_FOUND', 'Original request not found', false);
    return { status: 200, body: this.envelope(this.index(this.row(ledger.subjectId))) };
  }
  async create(body: unknown, ctx: GatewayCallContext) {
    const request = body as PersonalTaskCreate;
    if (!validPersonalOperation({ action: 'TASK_CREATE', key: request?.requestKey, body })) return invalid();
    const prior = this.store.ledgerGet(request.requestKey);
    if (prior && (prior.route !== 'TASK_CREATE' || prior.bodyDigest !== canonicalDigest(request))) return fail('IDEMPOTENCY_CONFLICT', '原提交已冻结，请勿修改正文或选项');
    const flight = this.flights.get(request.requestKey);
    if (flight) {
      if (flight.digest !== canonicalDigest(request)) return fail('IDEMPOTENCY_CONFLICT', '原提交已冻结，请勿修改正文或选项');
      return flight.promise;
    }
    const operation = this.dispatch(request, ctx);
    this.flights.set(request.requestKey, {digest: canonicalDigest(request), promise: operation});
    try { return await operation; } finally { this.flights.delete(request.requestKey); }
  }
  private async dispatch(request: PersonalTaskCreate, ctx: GatewayCallContext) {
    let ledger = this.store.ledgerGet(request.requestKey);
    if(ledger?.subjectId?this.native.is(ledger.subjectId):this.hub.forProject(request.projectId).handle.kind==='WORKER_LOCAL')return this.native.create(request);
    if(request.engineId)return fail('BACKEND_BINDING_CHANGED','原 ACS 项目不能改派为原生来源');
    if (ledger?.state === 'SETTLED') return { status: ledger.responseStatus!, body: JSON.parse(ledger.responseBody!) };
    if (!ledger) {
      const { project } = this.hub.forProject(request.projectId);
      const { client, storeId } = await this.client(project.connectionId, ctx);
      const options = await this.options(request.projectId, ctx);
      if (!options.body.meta.supportedActions.includes('TASK_CREATE')) return fail('PREFLIGHT_BLOCKED', options.body.data.issues.map(i => i.message).join('；'));
      const p = options.body.data.preflight!;
      // Explicit selections are resolved again at dispatch, never free-text model names.
      if (request.agentProfileId) {
        const profiles = await client.listAgentProfiles();
        if (!Array.isArray(profiles.profiles) || !profiles.profiles.some(v => v.id === request.agentProfileId && (!request.agentProfileRevision || v.revision === request.agentProfileRevision))) return fail('PROFILE_UNAVAILABLE', '所选 Agent 已不可用，请刷新');
      }
      if (request.modelSettings) {
        const catalog = await client.getModelCatalog();
        if (canonicalDigest(catalog.items.map(m => ({ providerId: m.providerId, modelAlias: m.modelAlias, availability: m.availability }))) !== request.modelSettings.catalogRevision || !catalog.items.some(m => m.providerId === request.modelSettings!.providerId && m.modelAlias === request.modelSettings!.modelAlias && m.availability === 'AVAILABLE')) return fail('MODEL_UNAVAILABLE', '所选模型目录已变化，请刷新');
      }
      // Another request may have persisted while preflight was in flight.
      ledger = this.store.ledgerGet(request.requestKey);
      if (!ledger) {
        const taskId = 'task-' + randomUUID();
        const facts: AcsTaskLaunchFacts = { request, connectionId: project.connectionId, storeId, observation: this.metrics.binding, defaultModel: p.modelAlias ?? undefined,
          create: { title: request.title || request.instruction.trim().split('\n')[0]!.slice(0, 256), workspaceAlias: p.workspaceAlias,
            interactionMode: 'ACT', intent: 'IMPLEMENT', executionMode: 'MODIFY', permissionMode: 'WORKSPACE',
            policyFingerprint: p.policyFingerprint, preflightRevision: p.revision, workspaceFingerprint: p.workspaceFingerprint,
            workspacePolicy: { mode: 'ISOLATED_WORKTREE', startPolicy: 'CLEAN_HEAD', expectedBaseRevision: p.headRevision, preflightRevision: p.revision },
            agentProfileId: request.agentProfileId, agentProfileRevision: request.agentProfileRevision,
            ...(request.modelSettings ? { modelSettings: { providerId: request.modelSettings.providerId, modelAlias: request.modelSettings.modelAlias } } : {}) } };
        this.store.transact(() => {
          const now = new Date().toISOString();
          this.store.db.prepare('INSERT INTO tasks(task_id,project_id,display_name,created_at,updated_at,revision) VALUES(?,?,?,?,?,1)').run(taskId, request.projectId, facts.create.title ?? null, now, now);
          this.store.ledgerBegin({ requestKey: request.requestKey, route: 'TASK_CREATE', bodyDigest: canonicalDigest(request), subjectId: taskId });
          this.store.saveLaunch(taskId, request.requestKey, facts);
        });
        ledger = this.store.ledgerGet(request.requestKey)!;
      }
    }
    const row = this.row(ledger.subjectId!);
    const f = this.facts(row)!;
    const { client } = await this.client(f.connectionId, ctx, f.storeId);
    try {
      if (!f.session) {
        const session = await client.createSession(f.create, child(request.requestKey, 'create'));
        if (!session.sessionId || !Number.isSafeInteger(session.sessionVersion)) throw new Error('Invalid source session acceptance');
        f.session = { sessionId: session.sessionId, sessionVersion: session.sessionVersion };
        f.executionBinding={kind:'ACS_SESSION',connectionId:f.connectionId,storeId:f.storeId,sessionId:session.sessionId};
        f.message = { clientMessageId: child(request.requestKey, 'message'), content: request.instruction, expectedSessionVersion: session.sessionVersion };
        this.store.saveLaunch(row.taskId, request.requestKey, f);
      }
      if (!f.acceptance) {
        f.acceptance = await client.sendSessionMessage(f.session.sessionId, f.message!, child(request.requestKey, 'send'));
        f.runId = f.acceptance.runId ?? undefined;
        if(f.executionBinding)f.executionBinding.initialRunId=f.runId;
        this.store.saveLaunch(row.taskId, request.requestKey, f);
      }
      f.submissionError = undefined;
      this.store.saveLaunch(row.taskId, request.requestKey, f);
      const outcome = { status: 201, body: this.envelope(this.index(this.row(row.taskId))) };
      this.store.ledgerSettle(request.requestKey, outcome.status, outcome.body);
      return outcome;
    } catch (error) {
      const problem = error as {code?: string; message?: string};
      f.submissionError = { code: problem.code ?? 'DISPATCH_UNCONFIRMED', message: problem.code ? (problem.message ?? problem.code).slice(0,1024) : 'ACS 回复未确认，请按原提交核对' };
      this.store.saveLaunch(row.taskId, request.requestKey, f);
      // An error after dispatch is not proof of rejection. Replay frozen source keys.
      return { status: 202, body: this.envelope(this.index(this.row(row.taskId)), ['TASK_CREATE']) };
    }
  }
  /** History is bounded; only source-observed message links are persisted. */
  async messages(id: string, query: URLSearchParams, ctx: GatewayCallContext) {
    if(this.native.is(id))return this.native.read(id,'messages',query);
    if ([...query.keys()].some(k => !['cursor', 'limit'].includes(k))) return invalid();
    const op = {action: 'TASK_MESSAGES', taskId: id, cursor: query.get('cursor') ?? undefined, limit: query.get('limit') ?? undefined};
    if (!validPersonalOperation(op)) return invalid();
    const f = this.facts(this.row(id));
    if (!f?.session) return fail('SESSION_UNBOUND', '任务尚未绑定源会话');
    const {client} = await this.client(f.connectionId, ctx, f.storeId);
    const page = await client.pageSessionMessages(f.session.sessionId, {cursor: op.cursor, limit: Number(op.limit ?? 30)});
    if (page.sessionId !== f.session.sessionId || !Array.isArray(page.items)) return fail('SESSION_BINDING_MISMATCH', '源历史所属会话不一致');
    // §8.3: messageTransportVersion is gateway-generated on the native
    // path only; a source-supplied same-name field is never trusted.
    delete (page as Record<string, unknown>).messageTransportVersion;
    this.observeMessages(id, page.items);
    return {status: 200, body: this.envelope(page)};
  }
  observeMessages(id: string, items: import('../../../codeagent-desktop/packages/protocol/src/index').SessionMessagePageResponse['items']) {
    this.store.transact(() => {
      for (const m of items) if (m.id && m.clientMessageId) this.store.db.prepare(`
        INSERT INTO personal_task_messages(task_id,client_message_id,message_id,run_id,observed_at) VALUES(?,?,?,?,?)
        ON CONFLICT(task_id,message_id) DO UPDATE SET run_id=COALESCE(excluded.run_id,run_id), observed_at=excluded.observed_at
      `).run(id, m.clientMessageId, m.id, m.runId ?? null, this.store.now());
    });
  }
  async selectRun(f: AcsTaskLaunchFacts, ctx: GatewayCallContext, requested?: string) {
    if (requested && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(requested)) return invalid();
    const observedAt = this.store.now();
    const conversation: import('../../../codeagent-desktop/packages/protocol/src/personal-task').TaskConversationRef = {
      initialRunId: f.runId, selectionReason: 'NONE', observedAt,
    };
    if (!f.session) return {conversation, run: undefined};
    const {client} = await this.client(f.connectionId, ctx, f.storeId);
    const session = await client.getSession(f.session.sessionId);
    if (session.sessionId !== f.session.sessionId) return fail('SESSION_BINDING_MISMATCH', '源会话身份不一致');
    conversation.activeRunId = session.activeRunId ?? undefined;
    let selected = requested ?? conversation.activeRunId;
    if (!selected) {
      const page = await client.pageSessionMessages(f.session.sessionId, {limit: 30});
      if (page.sessionId !== f.session.sessionId || !Array.isArray(page.items)) return fail('SESSION_BINDING_MISMATCH', '源历史所属会话不一致');
      const taskId = this.store.ledgerGet(f.request.requestKey)?.subjectId;
      if (taskId) this.observeMessages(taskId, page.items);
      selected = [...page.items].reverse().find(m => m.runId)?.runId ?? f.runId;
    }
    if (selected) {
      // Explicit history selection must have a message link, initial binding, or current active binding.
      if (requested && requested !== f.runId && requested !== session.activeRunId) {
        const linked = this.store.db.prepare(`SELECT 1 FROM personal_task_messages m JOIN tasks t ON t.task_id=m.task_id
          WHERE m.run_id=? AND json_extract(t.launch_json,'$.session.sessionId')=? AND json_extract(t.launch_json,'$.storeId')=?`).get(requested, f.session.sessionId, f.storeId);
        if (!linked) return fail('RUN_BINDING_MISMATCH', '请先从本会话历史选择运行');
      }
      const run = await client.getRun(selected);
      if (run.runId !== selected || run.sessionId !== f.session.sessionId || (selected === f.runId && f.acceptance?.taskId && run.taskId !== f.acceptance.taskId)) return fail('RUN_BINDING_MISMATCH', '源运行不属于本会话');
      conversation.selectedRunId = selected;
      conversation.selectionReason = requested ? 'USER_HISTORY' : session.activeRunId ? 'ACTIVE' : 'LATEST_MESSAGE_RUN';
      return {conversation, run};
    }
    return {conversation, run: undefined};
  }
  async detail(id: string, ctx: GatewayCallContext, query = new URLSearchParams()) {
    if(this.native.is(id)){if(query.size)return invalid();return this.native.detail(id);}
    if ([...query.keys()].some(k => k !== 'runId')) return invalid();
    const row = this.row(id), f = this.facts(row);
    const detail: PersonalTaskDetail = { ...this.index(row), core: 'ACS', executionBinding:f?.executionBinding, sourceStoreId: f?.storeId, conversation: f?.lastObserved?.conversation, instruction: f?.request.instruction, request: f?.request, launchDefaultModel: f?.defaultModel, submissionError: f?.submissionError,
      acceptance: f?.acceptance, session: f?.lastObserved?.session, run: f?.lastObserved?.run, observedAt: f?.lastObserved?.observedAt ?? new Date().toISOString() };
    detail.runId = detail.run?.runId ?? detail.runId;
    if (query.has('runId') && detail.run?.runId !== query.get('runId')) {detail.run = undefined; detail.runId = query.get('runId')!;}
    if (f?.session) try {
      const { client } = await this.client(f.connectionId, ctx, f.storeId);
      const session = await client.getSession(f.session.sessionId);
      detail.session = { sessionId: session.sessionId, sessionVersion: session.sessionVersion, agentProfileId: session.agentProfileId,
        agentProfileName: session.agentProfileName, agentProfileRevision: session.agentProfileRevision,
        modelSettings: session.modelSettings, workspaceBinding: session.workspaceBinding, activeRunId: session.activeRunId };
      if (!f.runId && f.acceptance?.messageId) {
        const page = await client.pageSessionMessages(f.session.sessionId, { aroundMessageId: f.acceptance.messageId, limit: 20 });
        const message = page.items.find(m => m.clientMessageId === f.message?.clientMessageId);
        if (message?.runId) { f.runId = message.runId; this.store.saveLaunch(id, f.request.requestKey, f); }
      }
      const selected = await this.selectRun(f, ctx, query.get('runId') ?? undefined);
      detail.conversation = selected.conversation;
      detail.run = selected.run;
      detail.runId = selected.run?.runId;
      detail.observedAt = new Date().toISOString();
      f.lastObserved = { conversation: detail.conversation, session: detail.session, run: detail.run, observedAt: detail.observedAt };
      this.store.saveLaunch(id, f.request.requestKey, f);
    } catch (e) { detail.sourceError = e instanceof ManagementError ? e.message : 'ACS 当前不可读；不推断任务失败'; }
    return { status: 200, body: this.envelope(detail) };
  }
  async taskMetrics(id: string, ctx: GatewayCallContext, query = new URLSearchParams()) {
    if(this.native.is(id)){if(query.size)return invalid();return this.native.metrics(id);}
    if ([...query.keys()].some(k => k !== 'runId')) return invalid();
    let f = this.facts(this.row(id));
    if (f) {
      const selected = await this.selectRun(f, ctx, query.get('runId') ?? undefined);
      f = {...f, runId: selected.run?.runId, acceptance: {...f.acceptance, taskId: selected.run?.taskId}};
    }
    return { status: 200, body: this.envelope(await this.metrics.read(f)) };
  }
  // ---- reliable task control delegates (PersonalTaskControls) ----
  commands(taskId: string, query: URLSearchParams, ctx: GatewayCallContext) {
    if(this.native.is(taskId))return this.native.read(taskId,'input-requests',query);
    return this.controls.commands(taskId, query, ctx);
  }
  commandCreate(taskId: string, body: unknown, ctx: GatewayCallContext) {
    if(this.native.is(taskId))return this.native.input(taskId,body);
    return this.controls.commandCreate(taskId, body, ctx);
  }
  command(taskId: string, requestKey: string, ctx: GatewayCallContext) {
    if(this.native.is(taskId))return this.native.request(taskId,requestKey);
    return this.controls.command(taskId, requestKey, ctx);
  }
  async leaf(id: string, kind: 'activities' | 'output', ctx: GatewayCallContext, query = new URLSearchParams()) {
    if(this.native.is(id)){const q=new URLSearchParams(query);if(q.has('afterCursor')){q.set('cursor',q.get('afterCursor')!);q.delete('afterCursor');}return this.native.read(id,kind==='activities'?'events':'output',q);}
    if ([...query.keys()].some(k => !['afterCursor', 'limit', 'runId'].includes(k))) return invalid();
    const afterCursor = query.has('afterCursor') ? Number(query.get('afterCursor')) : undefined;
    const limit = Number(query.get('limit') ?? 50);
    if ((afterCursor !== undefined && (!Number.isSafeInteger(afterCursor) || afterCursor < 0)) || !Number.isInteger(limit) || limit < 1 || limit > 100) return invalid();
    const f = this.facts(this.row(id));
    if (!f?.session) return { status: 200, body: this.envelope(null) };
    const selected = await this.selectRun(f, ctx, query.get('runId') ?? undefined);
    if (!selected.run) return { status: 200, body: this.envelope(null) };
    const { client } = await this.client(f.connectionId, ctx, f.storeId);
    return { status: 200, body: this.envelope(kind === 'activities' ? await client.getRunActivities(selected.run.runId, { limit, afterCursor }) : await client.getRunOutput(selected.run.runId)) };
  }
  /**
   * SSE leaf for `Accept: text/event-stream` activity requests. Only native
   * WORKER_LOCAL tasks have a live event source; the upstream open stream is
   * returned for the HTTP layer to pipe, never wrapped in the JSON envelope.
   * `afterCursor` maps to the worker-events/1 `cursor` exactly like `leaf`.
   */
  async leafStream(id: string, kind: 'activities' | 'output', query = new URLSearchParams(), signal?: AbortSignal) {
    if (!this.native.is(id) || kind !== 'activities') return invalid('事件流仅适用于本机原生任务');
    const q = new URLSearchParams(query);
    if (q.has('afterCursor')) { q.set('cursor', q.get('afterCursor')!); q.delete('afterCursor'); }
    if (q.has('runId')) q.delete('runId');
    return this.native.eventStream(id, q, signal);
  }
}
