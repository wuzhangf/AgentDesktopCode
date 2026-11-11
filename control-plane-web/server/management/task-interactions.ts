import type { PersonalTaskMessageRequest, PersonalTaskInteractionView } from '../../../codeagent-desktop/packages/protocol/src/personal-task';
import type { SessionMessageResponse, OperationReceiptResponse } from '../../../codeagent-desktop/packages/protocol/src/index';
import { validPersonalOperation } from '../../../codeagent-desktop/packages/protocol/src/personal';
import { ServiceProblem } from '../../../codeagent-desktop/packages/service-client/src/index';
import { canonicalDigest } from './canonical';
import { ManagementError, invalid } from './errors';
import type { ManagementStore } from './registry-store';
import type { PersonalTasks } from './tasks';
import type { GatewayCallContext } from './service';
interface Row {
  request_key: string; task_id: string; request_json: string; source_binding_json: string;
  wire_body: string; created_at: string; dispatch_started_at?: string; observation_json?: string;
}
const conflict = (): never => {throw new ManagementError(409, 'IDEMPOTENCY_CONFLICT', '原提交已冻结，请保持原正文和目标', false);};
export class PersonalTaskInteractions {
  private flights = new Map<string, {digest: string; promise: Promise<{status: number; body: unknown}>}>();
  constructor(private store: ManagementStore, private tasks: PersonalTasks) {}
  private row(key: string) {return this.store.db.prepare('SELECT * FROM personal_interaction_requests WHERE request_key=?').get(key) as unknown as Row | undefined;}
  private view(row: Row): PersonalTaskInteractionView {
    const binding = JSON.parse(row.source_binding_json);
    return {taskId: row.task_id, request: JSON.parse(row.request_json), sessionId: binding.sessionId,
      storeId: binding.storeId, createdAt: row.created_at, dispatchStartedAt: row.dispatch_started_at,
      ...(row.observation_json ? JSON.parse(row.observation_json) : {})};
  }
  private observe(row: Row, patch: Partial<PersonalTaskInteractionView>) {
    const prior = this.view(this.row(row.request_key)!);
    const observation = {acceptance: prior.acceptance, receipt: prior.receipt, sourceError: prior.sourceError, sourceRejection: prior.sourceRejection, ...patch};
    this.store.db.prepare('UPDATE personal_interaction_requests SET observation_json=? WHERE request_key=?').run(JSON.stringify(observation), row.request_key);
  }
  private async client(row: Row, ctx: GatewayCallContext) {
    const b = JSON.parse(row.source_binding_json);
    const f = this.tasks.facts(this.tasks.row(row.task_id));
    if (!f?.session || f.connectionId !== b.connectionId || f.storeId !== b.storeId || f.session.sessionId !== b.sessionId) throw new ManagementError(409, 'SOURCE_IDENTITY_CHANGED', '原请求来源已变化', false);
    return (await this.tasks.client(b.connectionId, ctx, b.storeId)).client;
  }
  async create(taskId: string, body: unknown, ctx: GatewayCallContext) {
    const request = body as PersonalTaskMessageRequest;
    if (!validPersonalOperation({action: 'TASK_MESSAGE_CREATE', taskId, key: request?.requestKey, body})) return invalid();
    const digest = canonicalDigest(request), key = request.requestKey;
    const ledger = this.store.ledgerGet(key);
    if (ledger && (ledger.route !== 'TASK_MESSAGE_CREATE' || ledger.subjectId !== taskId || ledger.bodyDigest !== digest)) conflict();
    const flight = this.flights.get(key);
    if (flight) {if (flight.digest !== digest) conflict(); return flight.promise;}
    const work = this.dispatch(taskId, request, digest, ctx);
    this.flights.set(key, {digest, promise: work});
    try {return await work;} finally {this.flights.delete(key);}
  }
  private async dispatch(taskId: string, request: PersonalTaskMessageRequest, digest: string, ctx: GatewayCallContext) {
    let row = this.row(request.requestKey);
    if (!row) {
      const f = this.tasks.facts(this.tasks.row(taskId));
      if (!f?.session || !f.acceptance) throw new ManagementError(409, 'SESSION_UNBOUND', '首消息尚未受理，请先核对原提交', false);
      await this.tasks.client(f.connectionId, ctx, f.storeId);
      const wire = {clientMessageId: request.clientMessageId, content: request.content, expectedSessionVersion: request.expectedSessionVersion};
      this.store.transact(() => {
        if (this.store.ledgerGet(request.requestKey)) conflict();
        this.store.ledgerBegin({requestKey: request.requestKey, route: 'TASK_MESSAGE_CREATE', bodyDigest: digest, subjectId: taskId});
        this.store.db.prepare(`INSERT INTO personal_interaction_requests(request_key,task_id,request_json,source_binding_json,wire_body,created_at) VALUES(?,?,?,?,?,?)`)
          .run(request.requestKey, taskId, JSON.stringify(request), JSON.stringify({connectionId: f.connectionId, storeId: f.storeId, sessionId: f.session!.sessionId}), JSON.stringify(wire), this.store.now());
      });
      row = this.row(request.requestKey)!;
    }
    const client = await this.client(row, ctx);
    const known = this.view(row);
    if (known.acceptance || known.receipt?.status === 'NOT_APPLIED' || known.sourceRejection) return {status: 200, body: this.tasks.envelope(known)};
    // Explicit same-key replay only. GET never reaches this source POST.
    const b = JSON.parse(row.source_binding_json);
    this.store.db.prepare('UPDATE personal_interaction_requests SET dispatch_started_at=COALESCE(dispatch_started_at,?) WHERE request_key=?').run(this.store.now(), row.request_key);
    try {
      const accepted = await client.sendSessionMessage(b.sessionId, JSON.parse(row.wire_body), row.request_key);
      this.accept(row, accepted);
    } catch (e) {
      if (e instanceof ServiceProblem && ['SESSION_VERSION_CONFLICT', 'VERSION_CONFLICT', 'INVALID_REQUEST', 'SESSION_ARCHIVED', 'SESSION_INTERACTION_UNSUPPORTED', 'IDEMPOTENCY_PAYLOAD_MISMATCH'].includes(e.code) && e.status < 500) this.observe(row, {sourceRejection: {code: e.code, message: e.message}});
      else this.observe(row, {sourceError: {code: e instanceof ServiceProblem ? e.code : 'SOURCE_REPLY_UNCONFIRMED', message: e instanceof ServiceProblem ? e.message : '源回复未确认，请查询原请求'}});
    }
    const view = this.view(this.row(row.request_key)!);
    return {status: view.acceptance ? 201 : 202, body: this.tasks.envelope(view)};
  }
  private accept(row: Row, accepted: SessionMessageResponse) {
    const request = JSON.parse(row.request_json) as PersonalTaskMessageRequest;
    if (!accepted.messageId || accepted.clientMessageId !== request.clientMessageId) throw new ManagementError(502, 'MESSAGE_BINDING_MISMATCH', '源消息与原请求不一致', false);
    this.observe(row, {acceptance: accepted, sourceError: undefined});
    this.store.db.prepare(`INSERT INTO personal_task_messages(task_id,client_message_id,message_id,run_id,observed_at) VALUES(?,?,?,?,?)
      ON CONFLICT(task_id,message_id) DO UPDATE SET run_id=COALESCE(excluded.run_id,run_id),observed_at=excluded.observed_at`)
      .run(row.task_id, request.clientMessageId, accepted.messageId, accepted.runId ?? null, this.store.now());
  }
  async request(taskId: string, key: string, ctx: GatewayCallContext) {
    if (!validPersonalOperation({action: 'TASK_INTERACTION_REQUEST', taskId, requestKey: key})) return invalid();
    const row = this.row(key);
    if (!row || row.task_id !== taskId) throw new ManagementError(404, 'REQUEST_NOT_FOUND', '原请求不存在', false);
    try {
      const client = await this.client(row, ctx), b = JSON.parse(row.source_binding_json);
      const prior = this.view(row);
      const receipt: OperationReceiptResponse = prior.acceptance?.receiptId
        ? await client.getOperationReceipt(prior.acceptance.receiptId)
        : await client.lookupOperationReceipt({operation: 'session.message', resourceId: b.sessionId, idempotencyKey: key});
      if (receipt.operation !== 'session.message' || receipt.resourceId !== b.sessionId) throw new ManagementError(502, 'RECEIPT_BINDING_MISMATCH', '源回执不属于原会话', false);
      this.observe(row, {receipt, sourceError: undefined});
      if (receipt.status === 'APPLIED' && receipt.result) this.accept(row, receipt.result as SessionMessageResponse);
    } catch(e) {
      this.observe(row, {sourceError: {code: e instanceof ServiceProblem || e instanceof ManagementError ? e.code : 'SOURCE_REPLY_UNCONFIRMED', message: '原请求仍待核对；查询不重发消息'}});
    }
    return {status: 200, body: this.tasks.envelope(this.view(this.row(key)!))};
  }
}
