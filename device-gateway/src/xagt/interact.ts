/**
 * Minimal online native follow-up lane for xagt.
 *
 * This is deliberately separate from the reader RPC and from device tokens:
 * an owner mints an exact-session interact grant, the stdio client presents
 * its independent xgi bearer, and the source worker's durable interaction
 * receipt is consulted before every retry.  Only NATIVE_FOLLOW_UP is exposed;
 * there is no launch, steer, stop, or offline queue here.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import type { GatewayStoreView, HttpRequest, HttpResponse, JsonObject } from '../context.js';
import type { LocalTransportLike } from '../local-tasks.js';
import { constantEqual, GatewayError, hash, isRecord, text, fail } from '../protocol.js';
import type { MemberCluster } from '../member-cluster.js';
import { LIMITS, errorBody, xfail } from './common.js';
import type { ReaderAccess, ReaderGrant } from './reader-access.js';
import { canSeeBackend, canSeeTask } from './reader-access.js';
import { resolveRef } from './refs.js';

type Json = Record<string, unknown>;
const KIND = 'xagt-interact';
const INTENT = 'xagt-interact-intent';
const VERSION = 1;
const identifier = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(value);

export interface InteractGrant {
  interactId: string;
  readerId: string;
  callerInstanceId: string;
  memberBinding: string;
  tokenHash: string;
  state: 'ACTIVE' | 'REVOKED';
  grantRevision: number;
  createdAt: string;
  expiresAt: string;
  backendStoreId: string;
  projectId: string;
  taskId: string;
  generation: string;
  nativeSessionId: string;
  nativeTurnId?: string;
  targetCommandId: string;
  sessionRef: string;
  expectedStateRef: string;
  stateExpiresAt: number;
}

interface InteractIntent {
  writerId: string;
  requestKey: string;
  sourceKey: string;
  payloadDigest: string;
  grantId: string;
  backendStoreId: string;
  projectId: string;
  taskId: string;
  grantRevision: number;
  state: 'DISPATCHED' | 'OBSERVED' | 'REJECTED' | 'UNKNOWN';
  createdAt: string;
  updatedAt: string;
  code?: string;
  result?: Json;
}

export interface InteractDeps {
  store: Pick<GatewayStoreView, 'get' | 'put' | 'list'>;
  readers: ReaderAccess;
  transport: LocalTransportLike;
  memberCluster: Pick<MemberCluster, 'authorizeInteraction'>;
  now?: () => number;
}

const nowIso = (now: () => number): string => new Date(now()).toISOString();
const digest = (value: unknown): string => hash(JSON.stringify(value));
const keyOf = (writerId: string, requestKey: string): string => `${writerId}:${requestKey}`;
const sourceCode = (value: unknown, fallback: string): string =>
  isRecord(value) && typeof value.code === 'string' ? value.code : fallback;

const exact = (value: unknown, fields: string[]): Json => {
  if (!isRecord(value) || Object.keys(value).some(k => !fields.includes(k))) fail('INVALID_REQUEST', 400);
  return value;
};

const boundedId = (value: unknown, _name: string): string => {
  if (!identifier(value)) fail('INVALID_REQUEST', 400);
  return value;
};

const bodyText = (body: Json): string => {
  const value = body.text;
  if (typeof value !== 'string' || value.trim() === '' || Buffer.byteLength(value, 'utf8') > 16_384) {
    fail('INVALID_REQUEST', 400);
  }
  return value;
};

export class XagtInteractService {
  private readonly now: () => number;
  private readonly locks = new Map<string, Promise<void>>();

  constructor(private readonly deps: InteractDeps) { this.now = deps.now ?? Date.now; }

  private lock<T>(idValue: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(idValue) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const next = previous.then(operation);
    const tail = previous.then(() => gate).catch(() => gate);
    this.locks.set(idValue, tail);
    return next.finally(() => {
      release();
      if (this.locks.get(idValue) === tail) this.locks.delete(idValue);
    });
  }

  async create(body: JsonObject): Promise<JsonObject> {
    const parsed = exact(body, ['requestId', 'readerId', 'callerInstanceId', 'sessionRef', 'expectedStateRef', 'expiresInDays']);
    text(parsed, 'requestId');
    const readerId = boundedId(parsed.readerId, 'readerId');
    const callerInstanceId = boundedId(parsed.callerInstanceId, 'callerInstanceId');
    const reader = this.deps.readers.get(readerId);
    this.requireReaderInteract(reader);
    const sessionRef = boundedId(parsed.sessionRef, 'sessionRef');
    const expectedStateRef = boundedId(parsed.expectedStateRef, 'expectedStateRef');
    const session = resolveRef(this.deps.store, sessionRef, 'session');
    const state = resolveRef(this.deps.store, expectedStateRef, 'state');
    if (session.o !== 'l' || session.k !== 't' || state.o !== 'l' || state.k !== 't'
        || session.c !== state.c || session.b !== state.b || session.t !== state.t
        || state.readerId !== reader.readerId || state.revision !== reader.grantRevision
        || typeof state.expiresAt !== 'number' || this.now() >= state.expiresAt) fail('TARGET_CHANGED', 409);
    const backendStoreId = boundedId(session.b, 'backendStoreId');
    const projectId = boundedId(state.p, 'projectId');
    const taskId = boundedId(session.t, 'taskId');
    const generation = boundedId(state.g, 'generation');
    const nativeSessionId = text(state, 's');
    const targetCommandId = boundedId(state.cmd, 'targetCommandId');
    if (!canSeeBackend(reader, backendStoreId) || !canSeeTask(reader, backendStoreId, projectId, taskId)) {
      fail('SCOPE_DENIED', 403);
    }
    if (nativeSessionId.length === 0 || nativeSessionId.length > 256) fail('INVALID_REQUEST', 400);
    const nativeTurnId = state.turn === undefined ? undefined : text(state, 'turn');
    if (nativeTurnId !== undefined && nativeTurnId.length > 256) fail('INVALID_REQUEST', 400);
    const days = parsed.expiresInDays === undefined ? 30 : parsed.expiresInDays;
    if (typeof days !== 'number' || !Number.isInteger(days) || days < 1 || days > 30) fail('INVALID_REQUEST', 400);
    const memberBinding = await this.deps.memberCluster.authorizeInteraction(callerInstanceId);
    const currentReader = this.deps.readers.get(readerId);
    this.requireReaderInteract(currentReader);
    if (currentReader.grantRevision !== reader.grantRevision || this.now() >= state.expiresAt) fail('TARGET_CHANGED', 409);
    const token = `xgi-${randomBytes(24).toString('base64url')}`;
    const createdAt = nowIso(this.now);
    const grant: InteractGrant = {
      interactId: `xint-${randomUUID()}`, readerId, tokenHash: hash(`xagt-interact:${token}`),
      callerInstanceId, memberBinding,
      state: 'ACTIVE', grantRevision: reader.grantRevision, createdAt,
      expiresAt: new Date(this.now() + days * 86_400_000).toISOString(),
      backendStoreId, projectId, taskId, generation, nativeSessionId,
      ...(nativeTurnId === undefined ? {} : { nativeTurnId }), targetCommandId,
      sessionRef, expectedStateRef, stateExpiresAt: state.expiresAt,
    };
    this.deps.store.put(KIND, grant.interactId, grant);
    const { tokenHash: _tokenHash, memberBinding: _memberBinding, ...publicGrant } = grant;
    return { ...publicGrant, token };
  }

  revoke(interactId: string): void {
    const grant = this.get(interactId);
    this.deps.store.put(KIND, interactId, { ...grant, state: 'REVOKED', grantRevision: grant.grantRevision + 1 });
  }

  private get(interactId: string): InteractGrant {
    const value = this.deps.store.get<InteractGrant>(KIND, interactId);
    if (value === undefined) fail('NOT_FOUND', 404);
    return value;
  }

  private requireReaderInteract(reader: ReaderGrant): void {
    if (reader.state !== 'ACTIVE' || Date.parse(reader.expiresAt) <= this.now()) fail('GRANT_EXPIRED', 410);
    if (!(reader.actions ?? []).includes('INTERACT')) fail('SCOPE_DENIED', 403);
  }

  private authenticate(token: string | undefined): InteractGrant {
    if (token === undefined || !token.startsWith('xgi-')) fail('ACCESS_UNAUTHORIZED', 401);
    const tokenHash = hash(`xagt-interact:${token}`);
    const grant = this.deps.store.list<InteractGrant>(KIND)
      .find(row => constantEqual(row.tokenHash, tokenHash));
    if (grant === undefined) fail('ACCESS_UNAUTHORIZED', 401);
    if (grant.state !== 'ACTIVE' || Date.parse(grant.expiresAt) <= this.now()) fail('GRANT_EXPIRED', 410);
    return grant;
  }

  private authorize(grant: InteractGrant): ReaderGrant {
    const current = this.get(grant.interactId);
    if (current.state !== 'ACTIVE' || current.grantRevision !== grant.grantRevision ||
        Date.parse(current.expiresAt) <= this.now()) fail('GRANT_EXPIRED', 410);
    const reader = this.deps.readers.get(grant.readerId);
    this.requireReaderInteract(reader);
    if (reader.grantRevision !== grant.grantRevision
        || !canSeeBackend(reader, grant.backendStoreId)
        || !canSeeTask(reader, grant.backendStoreId, grant.projectId, grant.taskId)) {
      fail('GRANT_REVISION_CONFLICT', 409);
    }
    return reader;
  }

  private async connection(backend: string, deadline: number): Promise<string> {
    const rows = this.deps.transport.orderedWorkerLocalRows?.() ?? this.deps.transport.workerLocalRows();
    for (const row of rows) {
      try {
        if (await this.deps.transport.identity(row.connectionId, deadline) === backend) return row.connectionId;
      } catch { /* a stale row is not an authorized source */ }
    }
    fail('SOURCE_OFFLINE', 503);
  }

  private async raw(grant: InteractGrant, method: 'GET' | 'POST', tail: string,
    body: Json | undefined, key: string | undefined, deadline: number): Promise<{ status: number; data: unknown }> {
    const connectionId = await this.connection(grant.backendStoreId, deadline);
    if (method === 'POST') await this.deps.memberCluster.authorizeInteraction(grant.callerInstanceId, grant.memberBinding);
    this.authorize(grant);
    if (method === 'POST' && this.now() >= grant.stateExpiresAt) fail('TARGET_CHANGED', 409);
    try {
      return await this.deps.transport.raw(connectionId, method, tail, body, key, grant.backendStoreId, deadline);
    } catch (error) {
      if (error instanceof GatewayError) throw error;
      fail('SOURCE_OFFLINE', 503);
    }
  }

  private async facts(grant: InteractGrant, deadline: number): Promise<Json> {
    const response = await this.raw(grant, 'GET', `/tasks/${encodeURIComponent(grant.taskId)}`, undefined, undefined, deadline);
    if (response.status !== 200 || !isRecord(response.data) || response.data.taskId !== grant.taskId
        || response.data.projectId !== grant.projectId) fail('LOCAL_BINDING_MISMATCH', 409);
    const facts = response.data;
    for (const [key, value] of [['generation', grant.generation], ['nativeSessionId', grant.nativeSessionId],
      ['nativeTurnId', grant.nativeTurnId], ['currentCommandId', grant.targetCommandId]] as const) {
      if (value !== undefined && facts[key] !== value) fail('NATIVE_TARGET_CHANGED', 409);
    }
    const capabilities = isRecord(facts.capabilities) ? facts.capabilities : {};
    if (facts.engineId !== 'sage-pi' || capabilities.followUp !== true) fail('NATIVE_ACTION_UNSUPPORTED', 409);
    return facts;
  }

  private validateReceipt(grant: InteractGrant, data: unknown): Json {
    if (!isRecord(data) || data.taskId !== grant.taskId
        || data.requestKey === undefined || (data.kind !== 'NATIVE_FOLLOW_UP' && data.operation !== 'NATIVE_FOLLOW_UP')) {
      fail('LOCAL_REPLY_INVALID', 502);
    }
    return data;
  }

  private async nativeReceipt(grant: InteractGrant, requestKey: string, deadline: number): Promise<Json | undefined> {
    const response = await this.raw(grant, 'GET', `/tasks/${encodeURIComponent(grant.taskId)}/interaction-requests/${encodeURIComponent(requestKey)}`, undefined, undefined, deadline);
    if (response.status === 404) return undefined;
    if (response.status !== 200) fail(sourceCode(response.data, 'SOURCE_UNAVAILABLE'), response.status >= 500 ? 503 : 409);
    const receipt = this.validateReceipt(grant, response.data);
    if (receipt.requestKey !== requestKey) fail('LOCAL_BINDING_MISMATCH', 409);
    return receipt;
  }

  private intentView(intent: InteractIntent): JsonObject {
    return {
      requestKey: intent.requestKey, state: intent.state, observedAt: intent.updatedAt,
      ...(intent.code === undefined ? {} : { code: intent.code }),
      ...(intent.result === undefined ? {} : { result: this.sanitizeReceipt(intent.result) }),
    };
  }

  private sanitizeReceipt(value: Json): Json {
    const out: Json = {};
    for (const key of ['kind', 'operation', 'state', 'status', 'taskId', 'requestKey', 'accepted', 'outcome']) {
      if (key in value) out[key] = value[key];
    }
    return out;
  }

  async send(token: string | undefined, body: unknown): Promise<JsonObject> {
    const grant = this.authenticate(token);
    return this.lock(grant.interactId, async () => {
      this.authorize(grant);
      const parsed = exact(body, ['requestKey', 'instruction', 'mode', 'sessionRef', 'expectedStateRef']);
      const requestKey = boundedId(parsed.requestKey, 'requestKey');
      if (parsed.mode !== 'followUp') fail('OPERATION_NOT_ALLOWED', 403);
      const textValue = bodyText({ text: parsed.instruction });
      if (parsed.sessionRef !== grant.sessionRef || parsed.expectedStateRef !== grant.expectedStateRef) fail('TARGET_CHANGED', 409);
      const writer = grant.interactId;
      const intentKey = keyOf(writer, requestKey);
      const payloadDigest = digest({ requestKey, instruction: textValue, mode: parsed.mode, sessionRef: parsed.sessionRef, expectedStateRef: parsed.expectedStateRef });
      const sourceKey = `xagt-send-${hash(`${writer}:${requestKey}`).slice(0, 48)}`;
      const deadline = Date.now() + LIMITS.peerDeadlineMillis;
      const existing = this.deps.store.get<InteractIntent>(INTENT, intentKey);
      if (existing !== undefined && (existing.payloadDigest !== payloadDigest || existing.sourceKey !== sourceKey
          || existing.taskId !== grant.taskId || existing.backendStoreId !== grant.backendStoreId)) {
        fail('IDEMPOTENCY_PAYLOAD_MISMATCH', 409);
      }
      if (existing === undefined && this.now() >= grant.stateExpiresAt) fail('TARGET_CHANGED', 409);
      await this.deps.memberCluster.authorizeInteraction(grant.callerInstanceId, grant.memberBinding);
      // Always ask the native durable ledger first. This is the recovery proof;
      // a missing receipt on an existing intent must never trigger replay.
      const remote = await this.nativeReceipt(grant, sourceKey, deadline);
      this.authorize(grant);
      if (existing !== undefined) {
        if (remote !== undefined) {
          const updated: InteractIntent = { ...existing, state: 'OBSERVED', result: remote, code: undefined, updatedAt: nowIso(this.now) };
          this.deps.store.put(INTENT, intentKey, updated);
          return this.intentView(updated);
        }
        if (existing.state === 'DISPATCHED') {
          const unknown: InteractIntent = { ...existing, state: 'UNKNOWN', code: 'LOCAL_REPLY_UNCONFIRMED', updatedAt: nowIso(this.now) };
          this.deps.store.put(INTENT, intentKey, unknown);
          return this.intentView(unknown);
        }
        return this.intentView(existing);
      }
      if (remote !== undefined) {
        return { requestKey, state: 'UNKNOWN', code: 'UNBOUND_RECEIPT' };
      }
      await this.facts(grant, deadline);
      this.authorize(grant);
      const createdAt = nowIso(this.now);
      const intent: InteractIntent = {
        writerId: writer, requestKey, sourceKey, payloadDigest, grantId: grant.interactId,
        backendStoreId: grant.backendStoreId, projectId: grant.projectId, taskId: grant.taskId,
        grantRevision: grant.grantRevision, state: 'DISPATCHED', createdAt, updatedAt: createdAt,
      };
      this.deps.store.put(INTENT, intentKey, intent);
      const wire: Json = {
        requestKey: sourceKey, kind: 'NATIVE_FOLLOW_UP', content: textValue,
        generation: grant.generation, nativeSessionId: grant.nativeSessionId,
        targetCommandId: grant.targetCommandId,
        ...(grant.nativeTurnId === undefined ? {} : { nativeTurnId: grant.nativeTurnId }),
      };
      try {
        const response = await this.raw(grant, 'POST', `/tasks/${encodeURIComponent(grant.taskId)}/messages`, wire, sourceKey, deadline);
        if (response.status >= 200 && response.status < 300) {
          const receipt = this.validateReceipt(grant, response.data);
          if (receipt.requestKey !== sourceKey) fail('LOCAL_BINDING_MISMATCH', 409);
          intent.state = 'OBSERVED'; intent.result = receipt;
        } else {
          intent.state = response.status >= 400 && response.status < 500 ? 'REJECTED' : 'UNKNOWN';
          intent.code = sourceCode(response.data, 'LOCAL_REPLY_UNCONFIRMED');
        }
      } catch (error) {
        if (error instanceof GatewayError) { intent.state = 'UNKNOWN'; intent.code = error.code; }
        else { intent.state = 'UNKNOWN'; intent.code = 'LOCAL_REPLY_UNCONFIRMED'; }
      }
      intent.updatedAt = nowIso(this.now);
      this.deps.store.put(INTENT, intentKey, intent);
      this.authorize(grant);
      return this.intentView(intent);
    });
  }

  async lookup(token: string | undefined, body: unknown): Promise<JsonObject> {
    const grant = this.authenticate(token);
    return this.lock(grant.interactId, async () => {
      this.authorize(grant);
      const parsed = exact(body, ['requestKey', 'sessionRef', 'expectedStateRef']);
      const requestKey = boundedId(parsed.requestKey, 'requestKey');
      if (parsed.sessionRef !== grant.sessionRef || parsed.expectedStateRef !== grant.expectedStateRef) fail('TARGET_CHANGED', 409);
      const sourceKey = `xagt-send-${hash(`${grant.interactId}:${requestKey}`).slice(0, 48)}`;
      const existing = this.deps.store.get<InteractIntent>(INTENT, keyOf(grant.interactId, requestKey));
      await this.deps.memberCluster.authorizeInteraction(grant.callerInstanceId, grant.memberBinding);
      let remote: Json | undefined;
      try {
        remote = await this.nativeReceipt(grant, sourceKey, Date.now() + LIMITS.peerDeadlineMillis);
      } catch (error) {
        if (existing === undefined || !(error instanceof GatewayError) || error.httpStatus < 500) throw error;
        this.authorize(grant);
        return { requestKey, state: 'UNKNOWN', code: error.code };
      }
      this.authorize(grant);
      if (existing !== undefined && remote === undefined) return this.intentView(existing);
      if (remote === undefined) return { requestKey, state: 'UNKNOWN', code: 'NOT_FOUND' };
      if (existing === undefined) return { requestKey, state: 'UNKNOWN', code: 'UNBOUND_RECEIPT' };

      const updated = { ...existing, state: 'OBSERVED' as const, code: undefined, result: remote, updatedAt: nowIso(this.now) };
      this.deps.store.put(INTENT, keyOf(grant.interactId, requestKey), updated);
      return this.intentView(updated);
    });
  }

  async handle(req: HttpRequest, localCluster = false): Promise<HttpResponse> {
    if (req.method !== 'POST') xfail('INVALID_REQUEST', '仅支持 POST。', false, 404);
    if (!localCluster && req.path !== '/api/xagt/v1/interact') xfail('NOT_FOUND', undefined, false, 404);
    const body = req.body;
    const parsed = exact(body, ['version', 'operation', 'arguments']);
    if (parsed.version !== VERSION || (parsed.operation !== 'send' && parsed.operation !== 'lookup')) xfail('INVALID_REQUEST', undefined, false, 400);
    const args = isRecord(parsed.arguments) ? parsed.arguments : fail('INVALID_REQUEST', 400);
    try {
      const result = parsed.operation === 'send' ? await this.send(req.accessToken, args) : await this.lookup(req.accessToken, args);
      return { status: 200, body: { version: VERSION, ok: true, result } };
    } catch (error) {
      return { status: 200, body: { version: VERSION, ok: false, error: errorBody(error) } };
    }
  }
}
