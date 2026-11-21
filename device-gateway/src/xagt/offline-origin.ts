import { randomBytes, randomUUID } from 'node:crypto';
import type { GatewayStoreView, JsonObject } from '../context.js';
import type { LocalTransportLike } from '../local-tasks.js';
import type { MemberCluster } from '../member-cluster.js';
import { constantEqual, fail, GatewayError, hash, isRecord } from '../protocol.js';
import { errorBody, LIMITS } from './common.js';

const SOURCES = 'xagt-offline-origin';
const SENDS = 'xagt-offline-send';
const EVENTS = 'xagt-offline-event';
const CURSORS = 'xagt-offline-cursor';
const ACCEPTANCES = 'xagt-delegation-acceptance';
const PREFIX = '/delegations';
const tokenHash = (token: string): string => hash(`xagt-offline-origin:${token}`);
const identifier = (value: unknown): string => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(value)) fail('INVALID_REQUEST', 400);
  return value;
};
const exact = (input: unknown, fields: string[]): JsonObject => {
  if (!isRecord(input) || Object.keys(input).some(key => !fields.includes(key))) fail('INVALID_REQUEST', 400);
  return input;
};

interface Source {
  sourceSubjectRef: string;
  returnSessionRef: string;
  memberBinding: string;
  tokenHash: string;
  backendStoreId: string;
  taskId: string;
  nativeSessionId: string;
  wakeOnCompletion: boolean;
  allowAcceptance?: boolean;
  revoked?: boolean;
}

interface InboxEvent {
  sourceSubjectRef: string;
  eventId: number;
  sourceEventId: string;
  delegationRef: string;
  executionRef?: string;
  handoffRef?: string;
  targetTaskRef?: string;
  state: string;
  resumeState: 'PENDING' | 'SUBMITTING' | 'OBSERVED' | 'UNKNOWN' | 'MANUAL';
}

interface InboxPosition {
  cursor: number;
  resyncRequired?: boolean;
}

export class OfflineOrigin {
  private timer?: ReturnType<typeof setTimeout>;
  private running = false;
  private stopped = false;

  constructor(private readonly store: Pick<GatewayStoreView, 'get' | 'put' | 'list' | 'transaction'>,
    private readonly transport: LocalTransportLike,
    private readonly member: Pick<MemberCluster, 'delegationRequest' | 'delegationIdentity'>) {}

  start(): void {
    if (this.stopped || this.timer !== undefined) return;
    this.timer = setTimeout(() => void this.tick().finally(() => {
      this.timer = undefined;
      this.start();
    }), 2_000);
    this.timer.unref();
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
  }

  private authorize(source: Source): void {
    const current = this.store.get<Source>(SOURCES, source.sourceSubjectRef);
    if (this.stopped || !current || current.revoked) fail('SCOPE_DENIED', 403);
    if (source.memberBinding !== this.member.delegationIdentity()) fail('MEMBER_SESSION_CHANGED', 409);
  }

  private async native(source: Pick<Source, 'backendStoreId' | 'taskId'>, deadline: number) {
    for (const { connectionId } of this.transport.orderedWorkerLocalRows?.() ?? this.transport.workerLocalRows()) {
      let storeId: string;
      try { storeId = await this.transport.identity(connectionId, deadline); } catch { continue; }
      if (storeId !== source.backendStoreId) continue;
      const reply = await this.transport.raw(connectionId, 'GET', `/tasks/${source.taskId}`,
        undefined, undefined, source.backendStoreId, deadline);
      if (reply.status !== 200 || !isRecord(reply.data) || reply.data.taskId !== source.taskId
        || reply.data.engineId !== 'sage-pi' || typeof reply.data.nativeSessionId !== 'string') fail('NATIVE_TARGET_CHANGED', 409);
      return { connectionId, facts: reply.data, nativeSessionId: reply.data.nativeSessionId };
    }
    fail('SOURCE_OFFLINE', 503);
  }

  async create(body: unknown): Promise<JsonObject> {
    const args = exact(body, ['backendStoreId', 'taskId', 'wakeOnCompletion', 'allowAcceptance']);
    const backendStoreId = identifier(args.backendStoreId);
    const taskId = identifier(args.taskId);
    if (typeof args.wakeOnCompletion !== 'boolean' || (args.allowAcceptance !== undefined && typeof args.allowAcceptance !== 'boolean')) fail('INVALID_REQUEST', 400);
    const memberBinding = this.member.delegationIdentity();
    const { nativeSessionId } = await this.native({ backendStoreId, taskId }, Date.now() + LIMITS.peerDeadlineMillis);
    if (memberBinding !== this.member.delegationIdentity()) fail('MEMBER_SESSION_CHANGED', 409);
    const token = `xdo-${randomBytes(24).toString('base64url')}`;
    const sourceSubjectRef = `xsrc-${randomUUID()}`;
    const returnSessionRef = `xret-${randomUUID()}`;
    this.store.put(SOURCES, sourceSubjectRef, { sourceSubjectRef, returnSessionRef, tokenHash: tokenHash(token),
      memberBinding, backendStoreId, taskId, nativeSessionId, wakeOnCompletion: args.wakeOnCompletion,
      allowAcceptance: args.allowAcceptance === true } satisfies Source);
    return { sourceSubjectRef, returnSessionRef, token };
  }

  revoke(id: string): void {
    const source = this.store.get<Source>(SOURCES, identifier(id));
    if (!source) fail('NOT_FOUND', 404);
    this.store.put(SOURCES, id, { ...source, revoked: true });
  }

  private source(token: string | undefined): Source {
    if (!token?.startsWith('xdo-')) fail('ACCESS_UNAUTHORIZED', 401);
    const fingerprint = tokenHash(token);
    const source = this.store.list<Source>(SOURCES).find(row => constantEqual(row.tokenHash, fingerprint));
    if (!source) fail('ACCESS_UNAUTHORIZED', 401);
    this.authorize(source);
    return source;
  }

  private sendId(source: Source, requestKey: string): string {
    return `${source.sourceSubjectRef}:${requestKey}`;
  }

  private async lookup(source: Source, permitRef: string, requestKey: string): Promise<JsonObject> {
    const intent = this.store.get<{ permitRef: string }>(SENDS, this.sendId(source, requestKey));
    if (intent?.permitRef !== permitRef) fail('NOT_FOUND', 404);
    try {
      return await this.member.delegationRequest('GET', `${PREFIX}/by-key/${permitRef}/${requestKey}`);
    } catch (error) {
      if (error instanceof GatewayError && (error.httpStatus === 404 || error.httpStatus >= 500)) {
        return { requestKey, permitRef, state: 'unknown', reasonCode: 'QUEUE_RECEIPT_UNCONFIRMED' };
      }
      throw error;
    }
  }

  private async queue(source: Source, body: unknown): Promise<JsonObject> {
    const args = exact(body, ['permitRef', 'requestKey', 'instruction', 'queueForSeconds', 'acceptanceCriteria']);
    const permitRef = identifier(args.permitRef);
    const requestKey = identifier(args.requestKey);
    const { instruction, queueForSeconds, acceptanceCriteria } = args;
    if (typeof instruction !== 'string' || !instruction.trim() || Buffer.byteLength(instruction) > 16_384
      || (acceptanceCriteria !== undefined && (typeof acceptanceCriteria !== 'string' || acceptanceCriteria.length > 2048))
      || (queueForSeconds !== undefined && (typeof queueForSeconds !== 'number' || !Number.isInteger(queueForSeconds)
        || queueForSeconds < 60 || queueForSeconds > 86_400))) fail('INVALID_REQUEST', 400);
    const payload = { permitRef, requestKey, instruction, queueForSeconds, sourceSubjectRef: source.sourceSubjectRef,
      returnSessionRef: source.returnSessionRef };
    const id = this.sendId(source, requestKey);
    const digest = hash(JSON.stringify([payload, acceptanceCriteria]));
    const existing = this.store.get<{ digest: string }>(SENDS, id);
    if (existing) {
      if (existing.digest !== digest) fail('IDEMPOTENCY_PAYLOAD_MISMATCH', 409);
      return this.lookup(source, permitRef, requestKey);
    }
    this.store.put(SENDS, id, { permitRef, digest, payload, acceptanceCriteria });
    try {
      return await this.member.delegationRequest('POST', PREFIX, payload);
    } catch (error) {
      if (error instanceof GatewayError && error.httpStatus >= 500) {
        return { requestKey, permitRef, state: 'unknown', reasonCode: 'QUEUE_RECEIPT_UNCONFIRMED' };
      }
      throw error;
    }
  }

  private inbox(source: Source): InboxEvent[] {
    return this.store.list<InboxEvent>(EVENTS).filter(event => event.sourceSubjectRef === source.sourceSubjectRef)
      .sort((a, b) => a.eventId - b.eventId);
  }

  private async accept(source: Source, input: unknown): Promise<JsonObject> {
    if (!source.allowAcceptance) fail('SCOPE_DENIED', 403);
    const args = exact(input, ['permitRef', 'requestKey', 'acceptanceKey', 'basisEventId', 'decision', 'summary', 'evidenceRefs']);
    const permitRef = identifier(args.permitRef), requestKey = identifier(args.requestKey);
    const acceptanceKey = identifier(args.acceptanceKey);
    if (typeof args.basisEventId !== 'number' || !Number.isSafeInteger(args.basisEventId) || args.basisEventId < 1 ||
      (args.decision !== 'accepted' && args.decision !== 'changes_requested') || typeof args.summary !== 'string' ||
      !args.summary.trim() || args.summary.length > 2048 || !Array.isArray(args.evidenceRefs) ||
      args.evidenceRefs.length < 1 || args.evidenceRefs.length > 12 || args.evidenceRefs.some(ref =>
        typeof ref !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(ref))) fail('INVALID_REQUEST', 400);
    const recordKey = `${source.sourceSubjectRef}:${acceptanceKey}`;
    const fingerprint = hash(JSON.stringify([permitRef, requestKey, args.basisEventId, args.decision, args.summary, args.evidenceRefs]));
    const previous = this.store.get<{ fingerprint: string; delegationRef: string; wire: JsonObject }>(ACCEPTANCES, recordKey);
    if (previous) {
      if (previous.fingerprint !== fingerprint) fail('IDEMPOTENCY_PAYLOAD_MISMATCH', 409);
      return this.member.delegationRequest('POST', `${PREFIX}/${previous.delegationRef}/acceptances`, previous.wire);
    }
    const delegation = await this.lookup(source, permitRef, requestKey);
    const event = this.inbox(source).find(row => row.eventId === args.basisEventId && row.delegationRef === delegation.delegationRef);
    if (!event?.executionRef || !['SUCCEEDED', 'FAILED', 'HANDOFF_TAKEN_OVER'].includes(event.state)) fail('EXECUTION_CONFLICT', 409);
    const native = await this.native(source, Date.now() + LIMITS.localDeadlineMillis);
    if (native.nativeSessionId !== source.nativeSessionId) fail('NATIVE_TARGET_CHANGED', 409);
    this.authorize(source);
    const wire = { requestKey: acceptanceKey, sourceSubjectRef: source.sourceSubjectRef, returnSessionRef: source.returnSessionRef,
      executionRef: event.executionRef, basisEventId: event.eventId, decision: args.decision, summary: args.summary, evidenceRefs: args.evidenceRefs };
    const raced = this.store.get<{ fingerprint: string }>(ACCEPTANCES, recordKey);
    if (raced && raced.fingerprint !== fingerprint) fail('IDEMPOTENCY_PAYLOAD_MISMATCH', 409);
    this.store.put(ACCEPTANCES, recordKey, { fingerprint, delegationRef: event.delegationRef, wire });
    return this.member.delegationRequest('POST', `${PREFIX}/${event.delegationRef}/acceptances`, wire);
  }

  async rpc(token: string | undefined, body: unknown): Promise<JsonObject> {
    const source = this.source(token);
    const request = exact(body, ['version', 'operation', 'arguments']);
    if (request.version !== 1) fail('VERSION_UNSUPPORTED', 400);
    try {
      let result: JsonObject;
      switch (request.operation) {
        case 'queue': result = await this.queue(source, request.arguments); break;
        case 'accept': result = await this.accept(source, request.arguments); break;
        case 'lookup': {
          const args = exact(request.arguments, ['permitRef', 'requestKey']);
          result = await this.lookup(source, identifier(args.permitRef), identifier(args.requestKey));
          break;
        }
        case 'inbox': result = {
          items: this.inbox(source).slice(-50).reverse().map(({ sourceSubjectRef: _subject, ...event }) => event),
          resyncRequired: this.store.get<InboxPosition>(CURSORS, source.sourceSubjectRef)?.resyncRequired === true,
        }; break;
        default: fail('INVALID_REQUEST', 400);
      }
      this.authorize(source);
      return { version: 1, ok: true, result };
    } catch (error) { return { version: 1, ok: false, error: errorBody(error) }; }
  }

  private async receive(source: Source): Promise<void> {
    const position = this.store.get<InboxPosition>(CURSORS, source.sourceSubjectRef);
    let cursor = position?.cursor ?? 0;
    const batch = await this.member.delegationRequest('GET', `${PREFIX}/inbox/${source.sourceSubjectRef}/${source.returnSessionRef}?after=${cursor}`);
    this.authorize(source);
    if (!Array.isArray(batch.items)) fail('LOCAL_REPLY_INVALID', 502);
    const pending: InboxEvent[] = [];
    for (const event of batch.items) {
      if (!isRecord(event) || typeof event.eventId !== 'number' || !Number.isSafeInteger(event.eventId)
        || event.eventId <= cursor || event.returnSessionRef !== source.returnSessionRef) fail('LOCAL_REPLY_INVALID', 502);
      cursor = event.eventId;
      const executionRef = event.executionRef == null ? undefined : identifier(event.executionRef);
      const state = identifier(event.state).toUpperCase();
      if (typeof event.sourceEventId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(event.sourceEventId)) fail('LOCAL_REPLY_INVALID', 502);
      pending.push({ sourceSubjectRef: source.sourceSubjectRef, eventId: cursor, sourceEventId: event.sourceEventId,
        delegationRef: identifier(event.delegationRef), executionRef, state,
        ...(event.handoffRef === undefined ? {} : { handoffRef: identifier(event.handoffRef), targetTaskRef: identifier(event.targetTaskRef) }),
        resumeState: source.wakeOnCompletion && executionRef && ['SUCCEEDED', 'FAILED'].includes(state) ? 'PENDING' : 'MANUAL' });
    }
    this.store.transaction(() => {
      for (const event of pending) {
        const key = `${source.sourceSubjectRef}:${event.eventId}`;
        if (!this.store.get(EVENTS, key)) this.store.put(EVENTS, key, event);
      }
      this.store.put(CURSORS, source.sourceSubjectRef, {
        cursor, resyncRequired: position?.resyncRequired || batch.resyncRequired === true,
      } satisfies InboxPosition);
    });
  }

  private async wake(source: Source, event: InboxEvent): Promise<void> {
    const deadline = Date.now() + LIMITS.peerDeadlineMillis;
    const { connectionId, facts, nativeSessionId } = await this.native(source, deadline);
    if (nativeSessionId !== source.nativeSessionId) return;
    const key = `${source.sourceSubjectRef}:${event.eventId}`;
    const requestKey = `xagt-wake-${hash(`${source.sourceSubjectRef}:${event.delegationRef}:${event.executionRef}`).slice(0, 48)}`;
    const path = `/tasks/${source.taskId}`;
    const lookup = await this.transport.raw(connectionId, 'GET', `${path}/interaction-requests/${requestKey}`, undefined,
      undefined, source.backendStoreId, deadline);
    this.authorize(source);
    const record = (resumeState: InboxEvent['resumeState']) => this.store.put(EVENTS, key, { ...event, resumeState });
    const matches = (data: unknown) => isRecord(data) && data.taskId === source.taskId && data.requestKey === requestKey
      && data.kind === 'NATIVE_FOLLOW_UP';
    if (lookup.status === 200 && matches(lookup.data)) { record('OBSERVED'); return; }
    if (lookup.status !== 404) return;
    if (event.resumeState !== 'PENDING') { record('UNKNOWN'); return; }
    if (facts.state !== 'SUCCEEDED' || !isRecord(facts.capabilities) || facts.capabilities.followUp !== true
      || typeof facts.generation !== 'string' || typeof facts.currentCommandId !== 'string') return;
    record('SUBMITTING');
    try {
      const result = await this.transport.raw(connectionId, 'POST', `${path}/messages`, {
        requestKey, kind: 'NATIVE_FOLLOW_UP', generation: facts.generation, nativeSessionId,
        targetCommandId: facts.currentCommandId,
        ...(typeof facts.nativeTurnId === 'string' ? { nativeTurnId: facts.nativeTurnId } : {}),
        content: `Agent Link confirmed ${event.state} for delegation ${event.delegationRef} (execution ${event.executionRef}). Review the original delegation in MCP, then continue the work in this session.`,
      }, requestKey, source.backendStoreId, deadline);
      if (result.status >= 200 && result.status < 300 && matches(result.data)) record('OBSERVED');
      else if (result.status >= 400 && result.status < 500) record('MANUAL');
    } catch { /* Resume only after checking the original receipt. */ }
  }

  async tick(): Promise<void> {
    if (this.running || this.stopped) return;
    this.running = true;
    try {
      for (const source of this.store.list<Source>(SOURCES)) {
        if (source.revoked || this.stopped) continue;
        try { this.authorize(source); await this.receive(source); } catch { continue; }
        const pending = this.inbox(source).filter(event => !['OBSERVED', 'MANUAL'].includes(event.resumeState));
        for (const event of pending.slice(0, 8)) {
          try { await this.wake(source, event); } catch { /* A failed lookup does not block other events. */ }
        }
      }
    } finally { this.running = false; }
  }
}
