/**
 * Reliable personal task control (design §6): PAUSE/RESUME/STOP over the
 * frozen `/api/personal/v1/tasks/{task}/commands` routes.
 *
 * Identity rule: requestKey == commandId == the source Idempotency-Key. The
 * browser mints `web-control-<uuid>` keys; the gateway never substitutes one.
 *
 * Durability rule (落盘先行): the ledger row and the frozen control request
 * (original body + source binding + exact wire body) commit in ONE short
 * transaction before any source dispatch; `dispatch_started_at` is stamped
 * before the first source POST. No source POST is ever sent when the local
 * store cannot persist the freeze.
 *
 * Read rule: GET routes and BFF restart reconcile read-only — they observe
 * `getRunCommand`/`listRunCommands`/`getRun`/`getSessionFoundation` and fold
 * matching receipts into the store, but NEVER issue a source POST. The only
 * re-dispatch is an explicit same-key POST replay carrying the frozen body
 * against the frozen binding; a source 404 is not proof of non-execution and
 * never a reason to mint a new key.
 */
import { validPersonalOperation } from '../../../codeagent-desktop/packages/protocol/src/personal';
import type {
  PersonalTaskCommandRequest,
  PersonalTaskCommandView,
  PersonalTaskControlView,
  AcsTaskLaunchFacts,
} from '../../../codeagent-desktop/packages/protocol/src/personal-task';
import type { RunCommandReceipt, RunCommandRequest } from '../../../codeagent-desktop/packages/protocol/src/index';
import type { ValidatedRunStateResponse } from '../../../codeagent-desktop/packages/protocol/src/validators';
import { ServiceProblem, type ServiceClient } from '../../../codeagent-desktop/packages/service-client/src/index';
import { canonicalDigest } from './canonical';
import { ManagementError, invalid } from './errors';
import type { ControlRequestRow, ManagementStore } from './registry-store';
import type { ConnectionHub } from './upstream';
import type { GatewayCallContext } from './service';
import type { PersonalTasks } from './tasks';

type Intent = 'PAUSE' | 'RESUME' | 'STOP';
type Outcome = { status: number; body: unknown };

const fail = (status: number, code: string, message: string): never => {
  throw new ManagementError(status, code, message, false);
};

/** Source replies that are definitive admissions of non-execution (<500). */
const SOURCE_REJECTION_CODES = new Set([
  'STATE_VERSION_CONFLICT', 'RUN_CONTROL_PENDING', 'CAPABILITY_UNAVAILABLE',
  'IDEMPOTENCY_KEY_REUSED', 'INVALID_REQUEST', 'CLIENT_REGISTRATION_REQUIRED',
  'CONTROL_NOT_FOUND', 'RUN_NOT_FOUND',
]);

/** run.controlState values that mean a control is in flight at the source. */
const PENDING_CONTROL_STATES = new Set(['PAUSE_REQUESTED', 'RESUME_REQUESTED', 'STOP_REQUESTED']);

/** A 404 CONTROL_NOT_FOUND on the commands surface is NOT evidence that a
 * command was never executed — only a reason to re-verify then replay. */
const controlNotFound = (error: unknown): boolean =>
  error instanceof ServiceProblem && error.status === 404 && error.code === 'CONTROL_NOT_FOUND';

const errorShape = (error: unknown, observedAt: string): { code: string; message: string; observedAt: string } => ({
  code: error instanceof ServiceProblem
    ? error.code
    : error instanceof ManagementError ? error.code : 'SOURCE_REPLY_UNCONFIRMED',
  message: String((error as { message?: unknown })?.message ?? error).slice(0, 1024),
  observedAt,
});

interface SourceBinding {
  connectionId?: string;
  storeId?: string;
  sessionId?: string;
  runId?: string;
  taskId?: string;
}

export class PersonalTaskControls {
  /** requestKey single-flight: identical concurrent submits share one dispatch. */
  private readonly flights = new Map<string, { digest: string; promise: Promise<Outcome> }>();

  constructor(
    private readonly store: ManagementStore,
    private readonly hub: ConnectionHub,
    private readonly tasks: PersonalTasks,
  ) {}

  private view(row: ControlRequestRow): PersonalTaskCommandView {
    const view: PersonalTaskCommandView = {
      taskId: row.taskId,
      request: JSON.parse(row.requestJson) as PersonalTaskCommandRequest,
      commandId: row.requestKey,
      targetRunId: JSON.parse(row.sourceBindingJson).runId,
      createdAt: row.createdAt,
    };
    if (row.dispatchStartedAt) view.dispatchStartedAt = row.dispatchStartedAt;
    if (row.lastReceiptJson) {
      try { view.receipt = JSON.parse(row.lastReceiptJson) as RunCommandReceipt; } catch { /* keep corrupt out of view */ }
      if (row.receiptObservedAt) view.receiptObservedAt = row.receiptObservedAt;
    }
    if (row.sourceRejectionJson) {
      try { view.sourceRejection = JSON.parse(row.sourceRejectionJson); } catch { /* skip */ }
    }
    if (row.lastSourceErrorJson) {
      try { view.sourceError = JSON.parse(row.lastSourceErrorJson); } catch { /* skip */ }
    }
    return view;
  }

  /** Pending == no source rejection AND (no receipt or non-terminal receipt). */
  private pendingRow(row: ControlRequestRow): boolean {
    if (row.sourceRejectionJson) return false;
    if (!row.lastReceiptJson) return true;
    try {
      return (JSON.parse(row.lastReceiptJson) as { terminal?: unknown }).terminal !== true;
    } catch {
      return true; // unparsable observation can never prove settlement
    }
  }

  private pendingRows(taskId: string, runId?: string): ControlRequestRow[] {
    return this.store.listControlRequests(taskId).filter(row => this.pendingRow(row)
      && (!runId || JSON.parse(row.sourceBindingJson).runId === runId));
  }
  private frozenFacts(f: AcsTaskLaunchFacts, row: ControlRequestRow): AcsTaskLaunchFacts {
    const b = JSON.parse(row.sourceBindingJson) as SourceBinding;
    if (b.connectionId !== f.connectionId || b.storeId !== f.storeId || b.sessionId !== f.session?.sessionId) fail(409, 'SOURCE_IDENTITY_CHANGED', '原请求来源已变化');
    return {...f, runId: b.runId, acceptance: {...f.acceptance, taskId: b.taskId}};
  }

  private intentOf(row: ControlRequestRow): Intent | undefined {
    try { return (JSON.parse(row.requestJson) as PersonalTaskCommandRequest).intent; } catch { return undefined; }
  }

  /** A receipt only settles a request when it answers the frozen target. */
  private receiptMatches(receipt: RunCommandReceipt, runId: string, row: ControlRequestRow): boolean {
    return receipt.commandId === row.requestKey && receipt.runId === runId && receipt.sessionId === JSON.parse(row.sourceBindingJson).sessionId
      && receipt.intent === this.intentOf(row);
  }

  /**
   * Read-only source identity verification used before freezing a new request
   * and before replaying a frozen one: session foundation identity/ownership,
   * run binding, and (on replay) drift against the frozen source binding.
   * Throws ManagementError — nothing is persisted here. Returns the validated
   * foundation so the caller can honour the commandReceiptV1 admission switch.
   */
  private async verifyIdentity(client: ServiceClient, f: AcsTaskLaunchFacts, frozen?: ControlRequestRow) {
    const foundation = await client.getSessionFoundation(f.session!.sessionId);
    if (foundation.storeId !== f.storeId || foundation.sessionId !== f.session!.sessionId
        || foundation.executionOwnership !== 'HOST_SESSION') {
      fail(409, 'SOURCE_IDENTITY_CHANGED', '源会话身份与任务绑定不一致，已保留原请求');
    }
    const run = await client.getRun(f.runId!);
    if (run.runId !== f.runId || run.sessionId !== f.session!.sessionId
        || (f.acceptance?.taskId && run.taskId !== f.acceptance.taskId)) {
      fail(409, 'RUN_BINDING_MISMATCH', '源运行身份与原绑定不一致，已保留原请求');
    }
    if (frozen) {
      let binding: SourceBinding = {};
      try { binding = JSON.parse(frozen.sourceBindingJson) as SourceBinding; } catch { /* treated as no binding */ }
      if ((binding.connectionId && binding.connectionId !== f.connectionId)
          || (binding.storeId && binding.storeId !== f.storeId)
          || (binding.sessionId && binding.sessionId !== f.session!.sessionId)
          || (binding.runId && binding.runId !== f.runId)
          || (binding.taskId && f.acceptance?.taskId && binding.taskId !== f.acceptance.taskId)) {
        fail(409, 'SOURCE_IDENTITY_CHANGED', '冻结绑定与当前源身份漂移，保留请求不转发');
      }
    }
    return foundation;
  }

  /**
   * GET /tasks/{task}/commands — control read view. Every source call is
   * isolated: failures land in sourceError and the already-observed parts are
   * still returned, never a blanket 500. Reconciliation is read-only.
   */
  async commands(taskId: string, query: URLSearchParams, ctx: GatewayCallContext): Promise<Outcome> {
    if ([...query.keys()].some((key) => key !== 'limit' && key !== 'before' && key !== 'runId')) return invalid();
    const limitRaw = query.get('limit') ?? undefined;
    const before = query.get('before') ?? undefined;
    if (!validPersonalOperation({ action: 'TASK_COMMANDS', taskId, runId: query.get('runId') ?? undefined, limit: limitRaw, before })) return invalid();
    const limit = limitRaw === undefined ? 20 : Number(limitRaw);
    const row = this.tasks.row(taskId);
    let f = this.tasks.facts(row);
    if (f?.session) try {
      const selected = await this.tasks.selectRun(f, ctx, query.get('runId') ?? undefined);
      f = {...f, runId: selected.run?.runId, acceptance: {...f.acceptance, taskId: selected.run?.taskId}};
    } catch (error) {
      return {status: 200, body: this.tasks.envelope({taskId, observedAt: this.store.now(), allowedIntents: [],
        reasonCodes: ['RUN_UNAVAILABLE'], pendingRequests: this.pendingRows(taskId).map(r => this.view(r)),
        sourceError: errorShape(error, this.store.now())})};
    }
    const observedAt = this.store.now();
    if (!f?.runId || !f.session) {
      const view: PersonalTaskControlView = {
        taskId, observedAt, allowedIntents: [], reasonCodes: ['RUN_NOT_ASSIGNED'],
        pendingRequests: this.pendingRows(taskId).map((r) => this.view(r)),
      };
      return { status: 200, body: this.tasks.envelope(view) };
    }

    const reasonCodes: string[] = [];
    let sourceError: PersonalTaskControlView['sourceError'];
    const note = (error: unknown) => { sourceError = errorShape(error, this.store.now()); };
    let client: ServiceClient | undefined;
    try {
      ({ client } = await this.tasks.client(f.connectionId, ctx, f.storeId));
    } catch (error) {
      note(error);
      reasonCodes.push(error instanceof ManagementError && error.code === 'SOURCE_IDENTITY_CHANGED'
        ? 'SOURCE_IDENTITY_MISMATCH' : 'SOURCE_COMMANDS_UNAVAILABLE');
    }

    let identityOk = false;
    let admissionReady = false;
    let run: ValidatedRunStateResponse | undefined;
    let commandsReadable = false;
    let page: PersonalTaskControlView['sourceCommands'];
    if (client) {
      try {
        const foundation = await client.getSessionFoundation(f.session.sessionId);
        if (foundation.storeId !== f.storeId || foundation.sessionId !== f.session.sessionId
            || foundation.executionOwnership !== 'HOST_SESSION') {
          reasonCodes.push('SOURCE_IDENTITY_MISMATCH');
        } else {
          identityOk = true;
          admissionReady = foundation.capabilities.commandReceiptV1 === 'READY';
          if (!admissionReady) reasonCodes.push('FOUNDATION_ADMISSION_DISABLED');
        }
      } catch (error) { note(error); }
      try {
        const candidate = await client.getRun(f.runId);
        if (candidate.sessionId !== f.session.sessionId
            || (f.acceptance?.taskId && candidate.taskId !== f.acceptance.taskId)) {
          reasonCodes.push('RUN_BINDING_MISMATCH');
        } else {
          run = candidate;
        }
      } catch (error) {
        note(error);
        reasonCodes.push('RUN_UNAVAILABLE');
      }
      // Read-only reconcile of locally pending requests against the source.
      for (const cr of this.pendingRows(taskId)) {
        try {
          const target = this.frozenFacts(f, cr);
          const receipt = await client.getRunCommand(target.runId!, cr.requestKey);
          commandsReadable = true;
          if (this.receiptMatches(receipt, JSON.parse(cr.sourceBindingJson).runId, cr)) {
            this.store.saveControlReceipt(cr.requestKey, JSON.stringify(receipt), this.store.now());
          } else {
            this.store.saveControlError(cr.requestKey, JSON.stringify({
              code: 'SOURCE_RECEIPT_MISMATCH',
              message: 'Source receipt does not correspond to the frozen command',
              observedAt: this.store.now(),
            }));
          }
        } catch (error) {
          if (!controlNotFound(error)) {
            this.store.saveControlError(cr.requestKey, JSON.stringify(errorShape(error, this.store.now())));
          }
          // CONTROL_NOT_FOUND is not evidence of non-execution: keep pending.
        }
      }
      try {
        page = await client.listRunCommands(f.runId, { limit, before });
        commandsReadable = true;
      } catch (error) { note(error); }
      if (!commandsReadable) reasonCodes.push('SOURCE_COMMANDS_UNAVAILABLE');
    }

    const pendingAfter = this.pendingRows(taskId);
    const pendingSelected = this.pendingRows(taskId, f.runId);
    let allowedIntents: Intent[] = [];
    if (identityOk && run && commandsReadable && !reasonCodes.includes('RUN_BINDING_MISMATCH')) {
      const status = run.sourceStatus ?? run.state;
      const actions = run.availableActions ?? [];
      switch (status) {
        case 'RUNNING':
        case 'WAITING_APPROVAL':
          if (admissionReady && actions.includes('PAUSE')) allowedIntents.push('PAUSE');
          allowedIntents.push('STOP');
          break;
        case 'PAUSED_FOR_HUMAN':
          if (admissionReady && actions.includes('RESUME') && run.checkpointAvailable === true) {
            allowedIntents.push('RESUME');
          }
          allowedIntents.push('STOP');
          break;
        case 'QUEUED':
        case 'PAUSED':
        case 'PAUSED_RETRYABLE':
        case 'WAITING_BUDGET_APPROVAL':
        case 'NEEDS_ATTENTION':
        case 'VALIDATING':
        case 'PAUSE_REQUESTED':
        case 'RESUME_REQUESTED':
        case 'STOP_REQUESTED':
          allowedIntents.push('STOP');
          break;
        default:
          // Terminal/unknown/unverifiable states: read-only, no new intents.
          break;
      }
      // Pending suppression: any local pending control or a source-side
      // *_REQUESTED controlState blocks new PAUSE/RESUME; a pending STOP
      // (local row or source STOP_REQUESTED) also blocks a new STOP.
      if (pendingSelected.length || PENDING_CONTROL_STATES.has(run.controlState ?? '')) {
        allowedIntents = allowedIntents.filter((intent) => intent === 'STOP');
      }
      if (pendingSelected.some((r) => this.intentOf(r) === 'STOP') || run.controlState === 'STOP_REQUESTED') {
        allowedIntents = allowedIntents.filter((intent) => intent !== 'STOP');
      }
    }

    const view: PersonalTaskControlView = {
      taskId,
      observedAt,
      run: run ? {
        runId: run.runId, sessionId: run.sessionId, state: run.state,
        sourceStatus: run.sourceStatus, stateVersion: run.stateVersion,
        controlState: run.controlState, controlCommandId: run.controlCommandId,
        checkpointAvailable: run.checkpointAvailable, availableActions: run.availableActions,
      } : undefined,
      allowedIntents,
      reasonCodes,
      pendingRequests: pendingAfter.map((r) => this.view(r)),
      recentRequests: this.store.listControlRequests(taskId).filter(r=>JSON.parse(r.sourceBindingJson).runId===f!.runId).slice(0,limit).map(r=>this.view(r)),
      sourceCommands: page,
      sourceError,
    };
    return {
      status: 200,
      body: this.tasks.envelope(view, allowedIntents.length ? ['TASK_COMMAND_CREATE'] : []),
    };
  }

  /**
   * POST /tasks/{task}/commands — freeze then submit. The ledger row and the
   * frozen control record commit in one short transaction BEFORE any source
   * dispatch; a replay of the same key verifies identity, then either folds
   * the found receipt or resubmits the frozen wire body — never a new key.
   */
  async commandCreate(taskId: string, body: unknown, ctx: GatewayCallContext): Promise<Outcome> {
    const request = body as PersonalTaskCommandRequest;
    if (!validPersonalOperation({ action: 'TASK_COMMAND_CREATE', taskId, key: request?.requestKey, body })) {
      return invalid();
    }
    const row = this.tasks.row(taskId);
    let f = this.tasks.facts(row);
    const frozenTarget = this.store.controlRequest(request.requestKey);
    if (f && frozenTarget) f = this.frozenFacts(f, frozenTarget);
    else if (f?.session && request.targetRunId) {
      const selected = await this.tasks.selectRun(f, ctx, request.targetRunId);
      f = {...f, runId: selected.run?.runId, acceptance: {...f.acceptance, taskId: selected.run?.taskId}};
    }
    if (!f?.runId || !f.session || !f.acceptance) {
      return fail(409, 'TASK_RUN_UNBOUND', '任务尚未绑定可核对的源运行');
    }
    const digest = canonicalDigest(request);
    const ledger = this.store.ledgerGet(request.requestKey);
    if (ledger && (ledger.route !== 'TASK_COMMAND_CREATE' || ledger.subjectId !== taskId
        || ledger.bodyDigest !== digest)) {
      fail(409, 'IDEMPOTENCY_CONFLICT', '原提交已冻结，请勿修改正文或目标');
    }
    if (!frozenTarget && !request.targetRunId) fail(400, 'TARGET_RUN_REQUIRED', '新的控制请求必须明确选中运行');
    const flight = this.flights.get(request.requestKey);
    if (flight) {
      if (flight.digest !== digest) fail(409, 'IDEMPOTENCY_CONFLICT', '原提交已冻结，请勿修改正文或目标');
      return flight.promise;
    }
    const work = this.dispatch(taskId, request, f, digest, ctx);
    this.flights.set(request.requestKey, { digest, promise: work });
    try { return await work; } finally { this.flights.delete(request.requestKey); }
  }

  private async dispatch(taskId: string, request: PersonalTaskCommandRequest,
      f: AcsTaskLaunchFacts, digest: string, ctx: GatewayCallContext): Promise<Outcome> {
    const { client } = await this.tasks.client(f.connectionId, ctx, f.storeId);
    const frozen = this.store.controlRequest(request.requestKey);
    if (frozen) return this.resume(client, f, frozen, taskId);

    // New request: read-only identity verification before anything persists.
    const foundation = await this.verifyIdentity(client, f);
    // The admission switch only gates NEW PAUSE/RESUME; STOP always proceeds.
    if (request.intent !== 'STOP' && foundation.capabilities.commandReceiptV1 !== 'READY') {
      fail(409, 'FOUNDATION_ADMISSION_DISABLED', '源端当前未开放暂停/恢复接纳，停止仍可用');
    }
    const binding: SourceBinding = {
      connectionId: f.connectionId, storeId: f.storeId,
      sessionId: f.session!.sessionId, runId: f.runId,
      taskId: f.acceptance?.taskId ?? undefined,
    };
    const sourceRequest: RunCommandRequest = {
      schemaVersion: 'run-command/1',
      commandId: request.requestKey,
      intent: request.intent,
      ...(request.intent === 'STOP' ? {} : { expectedStateVersion: request.expectedStateVersion }),
      reasonCode: 'PERSONAL_TASK_CONTROL',
    };
    // Freeze: pending re-check + ledger + frozen record in ONE transaction.
    this.store.transact(() => {
      if (this.store.ledgerGet(request.requestKey)) {
        fail(409, 'IDEMPOTENCY_CONFLICT', '原提交已冻结，请勿修改正文或目标');
      }
      const pending = this.pendingRows(taskId, f.runId);
      if (request.intent === 'STOP' && pending.some((r) => this.intentOf(r) === 'STOP')) {
        fail(409, 'TASK_STOP_PENDING', '已有未确认的停止请求，请按原请求核对');
      }
      if (request.intent !== 'STOP' && pending.length) {
        fail(409, 'TASK_CONTROL_PENDING', '已有未确认的暂停/恢复请求，请按原请求核对');
      }
      this.store.ledgerBegin({
        requestKey: request.requestKey, route: 'TASK_COMMAND_CREATE',
        bodyDigest: digest, subjectId: taskId,
      });
      this.store.insertControlRequest({
        requestKey: request.requestKey, taskId,
        requestJson: JSON.stringify(request),
        sourceBindingJson: JSON.stringify(binding),
        sourceRequestJson: JSON.stringify(sourceRequest),
        createdAt: this.store.now(),
      });
    });
    // Stamped before the first source POST, outside the freeze transaction.
    this.store.markControlDispatchStarted(request.requestKey);
    return this.submit(client, f, this.store.controlRequest(request.requestKey)!);
  }

  /**
   * Replay path for a key that already has a frozen local record. First ask
   * the source for the durable receipt; only on CONTROL_NOT_FOUND re-verify
   * identity/binding and resubmit the FROZEN wire body under the same key.
   */
  private async resume(client: ServiceClient, f: AcsTaskLaunchFacts,
      frozen: ControlRequestRow, taskId: string): Promise<Outcome> {
    const key = frozen.requestKey;
    if (frozen.taskId !== taskId) fail(409, 'IDEMPOTENCY_CONFLICT', '原提交已冻结，请勿修改正文或目标');
    let receipt: RunCommandReceipt | undefined;
    try {
      receipt = await client.getRunCommand(f.runId!, key);
    } catch (error) {
      if (controlNotFound(error)) {
        try {
          await this.verifyIdentity(client, f, frozen);
        } catch (verifyError) {
          if (verifyError instanceof ManagementError) throw verifyError;
          this.store.saveControlError(key, JSON.stringify(errorShape(verifyError, this.store.now())));
          return { status: 202, body: this.tasks.envelope(this.view(this.store.controlRequest(key)!)) };
        }
        this.store.markControlDispatchStarted(key);
        return this.submit(client, f, frozen);
      }
      this.store.saveControlError(key, JSON.stringify(errorShape(error, this.store.now())));
      return { status: 202, body: this.tasks.envelope(this.view(this.store.controlRequest(key)!)) };
    }
    if (this.receiptMatches(receipt, f.runId!, frozen)) {
      this.store.saveControlReceipt(key, JSON.stringify(receipt), this.store.now());
      const outcome: Outcome = {
        status: receipt.terminal ? 200 : 202,
        body: this.tasks.envelope(this.view(this.store.controlRequest(key)!)),
      };
      this.store.ledgerSettle(key, outcome.status, outcome.body);
      return outcome;
    }
    // A receipt naming a different run/intent is a protocol problem: the
    // frozen request and the last valid observation stay untouched.
    this.store.saveControlError(key, JSON.stringify({
      code: 'SOURCE_RECEIPT_MISMATCH',
      message: 'Source receipt does not correspond to the frozen command',
      observedAt: this.store.now(),
    }));
    return { status: 202, body: this.tasks.envelope(this.view(this.store.controlRequest(key)!)) };
  }

  /** First/replayed source POST for a frozen request; records the reply. */
  private async submit(client: ServiceClient, f: AcsTaskLaunchFacts, frozen: ControlRequestRow): Promise<Outcome> {
    const key = frozen.requestKey;
    const sourceRequest = JSON.parse(frozen.sourceRequestJson) as RunCommandRequest;
    try {
      const receipt = await client.submitRunCommand(f.runId!, sourceRequest, key);
      if (!this.receiptMatches(receipt, f.runId!, frozen)
          || receipt.intent !== sourceRequest.intent) {
        this.store.saveControlError(key, JSON.stringify({
          code: 'SOURCE_RECEIPT_MISMATCH',
          message: 'Source receipt does not correspond to the frozen command',
          observedAt: this.store.now(),
        }));
        return { status: 202, body: this.tasks.envelope(this.view(this.store.controlRequest(key)!)) };
      }
      this.store.saveControlReceipt(key, JSON.stringify(receipt), this.store.now());
      const outcome: Outcome = {
        status: receipt.terminal ? 200 : 202,
        body: this.tasks.envelope(this.view(this.store.controlRequest(key)!)),
      };
      this.store.ledgerSettle(key, outcome.status, outcome.body);
      return outcome;
    } catch (error) {
      if (error instanceof ServiceProblem && SOURCE_REJECTION_CODES.has(error.code) && error.status < 500) {
        // A definitive negative: record the rejection (never over a terminal
        // receipt) and settle the ledger — the transport reply is final.
        this.store.saveControlRejection(key, JSON.stringify({
          status: error.status, code: error.code, observedAt: this.store.now(),
        }));
        const outcome: Outcome = {
          status: 200,
          body: this.tasks.envelope(this.view(this.store.controlRequest(key)!)),
        };
        this.store.ledgerSettle(key, outcome.status, outcome.body);
        return outcome;
      }
      // Ambiguous transport: the request stays pending and unconfirmed; the
      // stored receipt is never overwritten by an error.
      this.store.saveControlError(key, JSON.stringify(errorShape(error, this.store.now())));
      return { status: 202, body: this.tasks.envelope(this.view(this.store.controlRequest(key)!)) };
    }
  }

  /** GET /tasks/{task}/commands/{requestKey} — single-request reconciliation. */
  async command(taskId: string, requestKey: string, ctx: GatewayCallContext): Promise<Outcome> {
    if (!validPersonalOperation({ action: 'TASK_COMMAND', taskId, requestKey })) return invalid();
    const row = this.tasks.row(taskId);
    const cr = this.store.controlRequest(requestKey);
    if (!cr || cr.taskId !== taskId) {
      throw new ManagementError(404, 'REQUEST_NOT_FOUND', 'Original request not found', false);
    }
    if (this.pendingRow(cr)) {
      const original = this.tasks.facts(row);
      const f = original ? this.frozenFacts(original, cr) : undefined;
      if (f?.runId && f.session) {
        try {
          const { client } = await this.tasks.client(f.connectionId, ctx, f.storeId);
          const receipt = await client.getRunCommand(f.runId, requestKey);
          if (this.receiptMatches(receipt, JSON.parse(cr.sourceBindingJson).runId, cr)) {
            this.store.saveControlReceipt(requestKey, JSON.stringify(receipt), this.store.now());
          } else {
            this.store.saveControlError(requestKey, JSON.stringify({
              code: 'SOURCE_RECEIPT_MISMATCH',
              message: 'Source receipt does not correspond to the frozen command',
              observedAt: this.store.now(),
            }));
          }
        } catch (error) {
          if (!controlNotFound(error)) {
            this.store.saveControlError(requestKey, JSON.stringify(errorShape(error, this.store.now())));
          }
        }
      }
    }
    return { status: 200, body: this.tasks.envelope(this.view(this.store.controlRequest(requestKey)!)) };
  }
}
