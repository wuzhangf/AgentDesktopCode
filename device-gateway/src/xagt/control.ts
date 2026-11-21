import { randomBytes } from 'node:crypto';
import type { GatewayAuth, GatewayLocalTasks, GatewayStoreView, JsonObject, LocalTaskResult } from '../context.js';
import { constantEqual, fail, GatewayError, hash, id, isRecord, seal, text, unseal } from '../protocol.js';
import { errorBody } from './common.js';

export type ControlOperation = 'launch' | 'stop' | 'approve';
const KIND = 'xagt-control-grant';
const PURPOSE = 'xagt-control-device';
const PREFIX = '/personal/v1/local-tasks/';
const deviceAction = { stop: 'CONTROL', approve: 'APPROVE' } as const;

interface Grant {
  ref: string;
  tokenHash: string;
  deviceEnvelope: string;
  deviceId: string;
  revision: number;
  membership: string;
  expiresAt: number;
  operation: ControlOperation;
  clientKey: string;
  requestKey: string;
  backend: string;
  path: string;
  receiptPath: string;
  body: JsonObject;
  task?: string;
  question?: string;
  questionFingerprint?: string;
  originalTaskState?: string;
  dispatched?: boolean;
  revoked?: boolean;
}

interface Dependencies {
  store: Pick<GatewayStoreView, 'get' | 'put' | 'list'>;
  local: Pick<GatewayLocalTasks, 'remote'>;
  auth: Pick<GatewayAuth, 'authenticate' | 'authorizeLocal' | 'authorizeLaunch'>;
  storeKey: () => Uint8Array;
  membership: () => string;
}

function exact(input: unknown, fields: readonly string[]): JsonObject {
  if (!isRecord(input) || Object.keys(input).some(key => !fields.includes(key))) fail('INVALID_REQUEST', 400);
  return input;
}

function key(input: JsonObject, field: string): string {
  const value = text(input, field);
  id(value);
  return value;
}

function object(reply: LocalTaskResult): JsonObject {
  if (reply.status < 200 || reply.status >= 300) {
    fail(isRecord(reply.body) && typeof reply.body.code === 'string' ? reply.body.code : 'SOURCE_UNAVAILABLE', reply.status);
  }
  if (!isRecord(reply.body)) fail('LOCAL_REPLY_INVALID', 502);
  return reply.body;
}

function guard(facts: JsonObject): JsonObject {
  return {
    generation: key(facts, 'generation'), nativeSessionId: key(facts, 'nativeSessionId'),
    targetCommandId: key(facts, 'currentCommandId'),
    ...(facts.nativeTurnId == null ? {} : { nativeTurnId: key(facts, 'nativeTurnId') }),
  };
}

export class ControlMcp {
  private readonly busy = new Set<string>();

  constructor(private readonly deps: Dependencies) {}

  async issue(input: unknown): Promise<JsonObject> {
    if (!isRecord(input)) fail('INVALID_REQUEST', 400);
    const operation = input.operation;
    if (operation !== 'launch' && operation !== 'stop' && operation !== 'approve') fail('INVALID_REQUEST', 400);
    const fields = ['operation', 'deviceToken', 'backendStoreId', 'requestKey', 'expiresAt'];
    const body = exact(input, [...fields, ...(operation === 'launch' ? ['projectId', 'engineId', 'instruction']
      : operation === 'stop' ? ['taskId'] : ['taskId', 'inputRequestId', 'response'])]);
    const token = text(body, 'deviceToken');
    const backend = key(body, 'backendStoreId');
    const clientKey = key(body, 'requestKey');
    const expiresAt = Date.parse(text(body, 'expiresAt'));
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now() || expiresAt > Date.now() + 86_400_000) fail('INVALID_REQUEST', 400);
    const membership = this.deps.membership();
    const device = await this.deps.auth.authenticate(token);
    const ref = `xct-${hash(JSON.stringify([device.id, clientKey])).slice(0, 40)}`;
    const requestKey = `xagt-control-${ref.slice(4)}`;
    const writer = `xcw-${randomBytes(24).toString('base64url')}`;
    const base = PREFIX + backend;
    const common = { ref, tokenHash: hash(writer), deviceEnvelope: seal(token, this.deps.storeKey(), PURPOSE),
      deviceId: device.id, revision: device.revision, membership, operation: operation as ControlOperation,
      clientKey, requestKey, backend, expiresAt };
    let grant: Grant;
    if (operation === 'launch') {
      const projectId = key(body, 'projectId'), engineId = key(body, 'engineId');
      if (engineId !== 'sage-pi') fail('NATIVE_ACTION_UNSUPPORTED', 409);
      const instruction = text(body, 'instruction');
      if (!instruction.trim() || Buffer.byteLength(instruction) > 16_384) fail('INVALID_REQUEST', 400);
      const preflight = object(await this.deps.local.remote(token, 'POST', `${base}/task-preflights`,
        { projectId, engineId }, null, null));
      if (preflight.projectId !== projectId || preflight.engineId !== engineId) fail('LOCAL_BINDING_MISMATCH', 409);
      grant = { ...common, path: `${base}/tasks`, receiptPath: `${base}/task-requests/${requestKey}`,
        body: { requestKey, projectId, engineId, optionsRevision: text(preflight, 'optionsRevision'), instruction } };
    } else {
      const task = key(body, 'taskId');
      const taskPath = `${base}/tasks/${task}`;
      await this.deps.auth.authorizeLocal(token, backend, task, deviceAction[operation]);
      const facts = await this.read(token, taskPath);
      if (facts.taskId !== task || facts.engineId !== 'sage-pi') fail('NATIVE_ACTION_UNSUPPORTED', 409);
      const round = guard(facts);
      if (operation === 'stop') {
        if (!isRecord(facts.capabilities) || facts.capabilities.stop !== true || facts.quiescent === true) fail('NATIVE_ACTION_UNSUPPORTED', 409);
        grant = { ...common, task, path: `${taskPath}/commands`, receiptPath: `${taskPath}/requests/${requestKey}`,
          body: { requestKey, intent: 'STOP', ...round } };
      } else {
        const question = key(body, 'inputRequestId');
        const pending = await this.question(token, taskPath, question);
        const response = exact(body.response, ['confirmed', 'value']);
        if (pending.method === 'confirm') {
          if (Object.keys(response).length !== 1 || typeof response.confirmed !== 'boolean') fail('INVALID_REQUEST', 400);
        } else if (pending.method === 'select') {
          if (Object.keys(response).length !== 1 || typeof response.value !== 'string'
            || !Array.isArray(pending.options) || !pending.options.includes(response.value)) fail('INVALID_REQUEST', 400);
        } else fail('NATIVE_ACTION_UNSUPPORTED', 409);
        grant = { ...common, task, question, questionFingerprint: this.questionFingerprint(pending),
          path: `${taskPath}/input-requests/${question}/responses`, receiptPath: `${taskPath}/requests/${requestKey}`,
          body: { requestKey, response, ...round } };
      }
    }
    await this.current(grant, token, true);
    if (this.deps.store.get(KIND, ref)) fail('IDEMPOTENCY_CONFLICT', 409);
    this.deps.store.put(KIND, ref, grant);
    return { credentialRef: ref, operation, requestKey: clientKey, token: writer, expiresAt: new Date(expiresAt).toISOString() };
  }

  revoke(ref: string): void {
    const grant = this.deps.store.get<Grant>(KIND, ref);
    if (!grant) fail('NOT_FOUND', 404);
    this.deps.store.put(KIND, ref, { ...grant, revoked: true });
  }

  async renew(ref: string, input: unknown): Promise<JsonObject> {
    if (this.busy.has(ref)) fail('BUSY', 409);
    const grant = this.deps.store.get<Grant>(KIND, ref);
    if (!grant) fail('NOT_FOUND', 404);
    const token = text(exact(input, ['deviceToken']), 'deviceToken');
    this.busy.add(ref);
    try {
      await this.current(grant, token, !grant.dispatched);
      this.deps.store.put(KIND, ref, { ...grant, deviceEnvelope: seal(token, this.deps.storeKey(), PURPOSE) });
      return { credentialRef: ref, operation: grant.operation };
    } finally { this.busy.delete(ref); }
  }

  async rpc(writer: string | undefined, input: unknown): Promise<JsonObject> {
    if (!writer?.startsWith('xcw-')) fail('ACCESS_UNAUTHORIZED', 401);
    const fingerprint = hash(writer);
    const grant = this.deps.store.list<Grant>(KIND).find(row => constantEqual(fingerprint, row.tokenHash));
    if (!grant) fail('ACCESS_UNAUTHORIZED', 401);
    const args = exact(input, ['version', 'operation', 'arguments']);
    if (args.version !== 1 || (args.operation !== 'status' && args.operation !== grant.operation)) fail('SCOPE_DENIED', 403);
    exact(args.arguments, []);
    if (this.busy.has(grant.ref)) fail('BUSY', 409);
    this.busy.add(grant.ref);
    try {
      const token = unseal(grant.deviceEnvelope, this.deps.storeKey(), PURPOSE);
      const write = args.operation !== 'status' && !grant.dispatched && grant.originalTaskState === undefined;
      await this.current(grant, token, write);
      if (!write) {
        const result = grant.dispatched ? await this.lookup(grant, token)
          : this.view(grant, grant.originalTaskState === undefined ? 'READY' : 'ORIGINAL_RUN_ENDED');
        return { version: 1, ok: true, result };
      }
      const originalTaskState = grant.task ? await this.checkRound(grant, token) : undefined;
      await this.current(grant, token, true);
      if (originalTaskState !== undefined) {
        const settled = { ...grant, originalTaskState };
        this.deps.store.put(KIND, grant.ref, settled);
        return { version: 1, ok: true, result: this.view(settled, 'ORIGINAL_RUN_ENDED') };
      }
      this.deps.store.put(KIND, grant.ref, { ...grant, dispatched: true });
      try {
        const receipt = object(await this.deps.local.remote(token, 'POST', grant.path, grant.body, grant.requestKey, null));
        await this.current({ ...grant, dispatched: true }, token, false);
        return { version: 1, ok: true, result: this.project(grant, receipt) };
      } catch (error) {
        if (error instanceof GatewayError && error.httpStatus < 500) throw error;
        return { version: 1, ok: true, result: this.view(grant, 'UNKNOWN') };
      }
    } catch (error) {
      return { version: 1, ok: false, error: errorBody(error) };
    } finally { this.busy.delete(grant.ref); }
  }

  private async current(grant: Grant, token: string, write: boolean): Promise<void> {
    this.check(grant, write);
    const device = grant.task ? await this.deps.auth.authorizeLocal(token, grant.backend, grant.task,
      deviceAction[grant.operation as 'stop' | 'approve']) : await this.deps.auth.authorizeLaunch(token, grant.backend,
      text(grant.body, 'projectId'), text(grant.body, 'engineId'));
    if (device.id !== grant.deviceId || (device.revision !== grant.revision &&
        !(grant.operation === 'launch' && !write && grant.dispatched && device.revision === grant.revision + 1))) {
      fail('GRANT_REVISION_CHANGED', 409);
    }
    this.check(grant, write);
  }

  private check(grant: Grant, write: boolean): void {
    if (this.deps.store.get<Grant>(KIND, grant.ref)?.revoked) fail('SCOPE_DENIED', 403);
    if (this.deps.membership() !== grant.membership) fail('MEMBER_SESSION_CHANGED', 409);
    if (write && Date.now() >= grant.expiresAt) fail('GRANT_EXPIRED', 409);
  }

  private async read(token: string, path: string): Promise<JsonObject> {
    return object(await this.deps.local.remote(token, 'GET', path, null, null, null));
  }

  private async question(token: string, taskPath: string, question: string): Promise<JsonObject> {
    const pending = await this.read(token, `${taskPath}/input-requests`);
    const found = Array.isArray(pending.items) && pending.items.find(row => isRecord(row) &&
      row.inputRequestId === question && row.state === 'PENDING');
    if (!isRecord(found)) fail('NATIVE_INPUT_EXPIRED', 409);
    return found;
  }

  private questionFingerprint(row: JsonObject): string {
    return hash(JSON.stringify([row.inputRequestId, row.method, row.title, row.message, row.options]));
  }

  private async checkRound(grant: Grant, token: string): Promise<string | undefined> {
    const taskPath = `${PREFIX}${grant.backend}/tasks/${grant.task}`;
    const facts = await this.read(token, taskPath);
    const current = guard(facts);
    if (facts.taskId !== grant.task || facts.engineId !== 'sage-pi' ||
      ['generation', 'nativeSessionId', 'nativeTurnId', 'targetCommandId'].some(field => current[field] !== grant.body[field])) {
      fail('NATIVE_TARGET_CHANGED', 409);
    }
    if (grant.question && grant.questionFingerprint !== this.questionFingerprint(await this.question(token, taskPath, grant.question))) {
      fail('NATIVE_INPUT_EXPIRED', 409);
    }
    if (grant.operation === 'stop' && facts.quiescent === true) {
      const state = text(facts, 'state');
      if (['SUCCEEDED', 'FAILED', 'CANCELLED', 'BUDGET_EXCEEDED', 'BINDING_UNAVAILABLE'].includes(state)) return state;
    }
    return undefined;
  }

  private async lookup(grant: Grant, token: string): Promise<JsonObject> {
    try {
      const receipt = await this.read(token, grant.receiptPath);
      await this.current(grant, token, false);
      return this.project(grant, receipt);
    } catch (error) {
      if (!(error instanceof GatewayError) || (error.httpStatus !== 404 && error.httpStatus < 500)) throw error;
      return this.view(grant, 'UNKNOWN');
    }
  }

  private project(grant: Grant, receipt: JsonObject): JsonObject {
    const expected = { launch: 'LAUNCH', stop: 'STOP', approve: 'INPUT_RESPONSE' }[grant.operation];
    if (receipt.requestKey !== grant.requestKey || receipt.operation !== expected || receipt.backendStoreId !== grant.backend
      || (grant.task !== undefined && receipt.taskId !== grant.task)) fail('LOCAL_REPLY_INVALID', 502);
    if (receipt.state === 'REJECTED') return this.view(grant, 'REJECTED');
    if (receipt.state !== 'OBSERVED') return this.view(grant, 'UNKNOWN');
    const source = isRecord(receipt.source) ? receipt.source : {};
    const effect = grant.operation === 'launch' && typeof receipt.taskId === 'string' ? 'TASK_CREATED'
      : grant.operation === 'stop' && source.kind === 'STOP' && source.state === 'APPLIED' ? 'STOPPED'
      : grant.operation === 'approve' && source.kind === 'INPUT_RESPONSE' && source.state === 'CONSUMED' ? 'ANSWERED' : 'ACCEPTED';
    return { ...this.view(grant, effect), ...(typeof receipt.taskId === 'string' ? { taskId: receipt.taskId } : {}) };
  }

  private view(grant: Grant, state: string): JsonObject {
    return { credentialRef: grant.ref, requestKey: grant.clientKey, operation: grant.operation, state,
      ...(grant.task ? { taskId: grant.task } : {}), ...(grant.question ? { inputRequestId: grant.question } : {}),
      ...(grant.originalTaskState === undefined ? {} : { originalTaskState: grant.originalTaskState }) };
  }
}
