/**
 * B-side consumer for Hosted offline delegation claims.
 *
 * This is deliberately a target-side protocol boundary. The native worker is
 * never addressed with the caller's request key; a key derived from the
 * Hosted permit and delegation is used instead. Every write is preceded by a
 * fresh target, membership, lease and Hosted-authorisation check.
 */
import { createHash, randomUUID } from 'node:crypto';
import type { GatewayStoreView, JsonObject } from '../context.js';
import type { LocalTransportLike } from '../local-tasks.js';
import { GatewayError, fail, hash, isRecord, text } from '../protocol.js';
import type { MemberCluster } from '../member-cluster.js';

type Json = Record<string, unknown>;
const GRANT_KIND = 'xagt-offline-target';
const INTENT_KIND = 'xagt-offline-intent';
const QUARANTINE_KIND = 'xagt-offline-quarantine';
const MAX_LEASE_MS = 24 * 60 * 60 * 1000;
const validId = (value: unknown): value is string => typeof value === 'string'
  && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(value);
const iso = (millis: number): string => new Date(millis).toISOString();
const acceptedReceipt = (value: Json): boolean => ['ACCEPTED', 'DISPATCHING', 'ACKNOWLEDGED', 'CONSUMED'].includes(String(value.state));
const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const exact = (value: unknown, fields: string[]): Json => {
  if (!isRecord(value) || Object.keys(value).some(key => !fields.includes(key))) fail('INVALID_REQUEST', 400);
  return value;
};
const requiredId = (value: unknown): string => { if (!validId(value)) fail('INVALID_REQUEST', 400); return value; };

export interface OfflineTargetGrant {
  targetId: string;
  permitRef: string;
  sourceInstanceId: string;
  sourceSubjectRef: string;
  returnSessionRef: string;
  memberBinding: string;
  backendStoreId: string;
  projectId: string;
  taskId: string;
  generation: string;
  nativeSessionId: string;
  nativeTurnId?: string;
  targetCommandId: string;
  expiresAt: string;
  state: 'ACTIVE' | 'REVOKED';
  createdAt: string;
}

interface Intent {
  permitRef: string;
  requestKey: string;
  sourceKey: string;
  instructionDigest: string;
  state: 'DISPATCHED' | 'ACCEPTED' | 'RUNNING' | 'WAITING' | 'SUCCEEDED' | 'FAILED' | 'UNKNOWN' | 'REJECTED';
  executionRef?: string;
  createdAt: string;
  updatedAt: string;
  code?: string;
}

interface Claim {
  delegationRef: string;
  permitRef: string;
  requestKey: string;
  instruction: string;
  leaseGeneration: number;
  leaseUntil: string;
  state?: string;
  kind?: string;
}

export interface OfflineTargetDeps {
  store: Pick<GatewayStoreView, 'get' | 'put' | 'list'>;
  transport: LocalTransportLike;
  memberCluster: Pick<MemberCluster, 'delegationRequest' | 'delegationIdentity'>;
  now?: () => number;
}

type RawResponse = { status: number; data: unknown };

export class OfflineTargetService {
  private readonly now: () => number;
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = false;

  constructor(private readonly deps: OfflineTargetDeps) { this.now = deps.now ?? Date.now; }

  start(): void { this.stopped = false; void this.pollOnce().finally(() => this.schedule()); }
  stop(): void { this.stopped = true; clearTimeout(this.timer); this.timer = undefined; }
  private schedule(): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => void this.pollOnce().finally(() => this.schedule()), 15_000);
    this.timer.unref?.();
  }

  /** Owner-loopback route implementation. Pins are read from the target worker. */
  async create(body: JsonObject): Promise<JsonObject> {
    const args = exact(body, ['requestId', 'sourceInstanceId', 'sourceSubjectRef', 'returnSessionRef',
      'backendStoreId', 'projectId', 'taskId', 'expiresAt']);
    text(args, 'requestId');
    const sourceInstanceId = requiredId(args.sourceInstanceId);
    const sourceSubjectRef = requiredId(args.sourceSubjectRef);
    const returnSessionRef = requiredId(args.returnSessionRef);
    const backendStoreId = requiredId(args.backendStoreId);
    const projectId = requiredId(args.projectId);
    const taskId = requiredId(args.taskId);
    const expiresAt = text(args, 'expiresAt');
    const expiry = Date.parse(expiresAt);
    if (!Number.isFinite(expiry) || expiry <= this.now() || expiry > this.now() + MAX_LEASE_MS) fail('INVALID_REQUEST', 400);

    const beforeBinding = this.deps.memberCluster.delegationIdentity();
    const facts = await this.readFacts(backendStoreId, projectId, taskId);
    this.requireIdleRound(facts);
    const memberBinding = this.deps.memberCluster.delegationIdentity();
    if (beforeBinding !== memberBinding) fail('MEMBER_SESSION_CHANGED', 409);

    const permitRef = `xpermit-${randomUUID()}`;
    const grant: OfflineTargetGrant = {
      targetId: `xoff-${randomUUID()}`, permitRef, sourceInstanceId, sourceSubjectRef, returnSessionRef,
      memberBinding, backendStoreId, projectId, taskId,
      generation: requiredId(facts.generation), nativeSessionId: requiredId(facts.nativeSessionId),
      ...(facts.nativeTurnId == null ? {} : { nativeTurnId: requiredId(facts.nativeTurnId) }),
      targetCommandId: requiredId(facts.currentCommandId), expiresAt, state: 'ACTIVE', createdAt: iso(this.now()),
    };
    const registered = await this.deps.memberCluster.delegationRequest('POST', '/delegations/permits', {
      permitRef, sourceInstanceId, sourceSubjectRef, returnSessionRef,
      authorizationRevision: memberBinding, expiresAt,
    });
    if (registered.permitRef !== undefined && registered.permitRef !== permitRef) fail('LOCAL_REPLY_INVALID', 502);
    this.deps.store.put(GRANT_KIND, grant.targetId, grant);
    return { ...grant };
  }

  /** Fence local dispatch immediately. Repeat the Hosted update after any transport failure. */
  async revoke(targetId: string): Promise<void> {
    if (!validId(targetId)) fail('INVALID_REQUEST', 400);
    const grant = this.deps.store.get<OfflineTargetGrant>(GRANT_KIND, targetId);
    if (grant === undefined) fail('NOT_FOUND', 404);
    this.deps.store.put(GRANT_KIND, targetId, { ...grant, state: 'REVOKED' });
    await this.deps.memberCluster.delegationRequest('DELETE', `/delegations/permits/${grant.permitRef}`);
  }

  private async connection(backend: string): Promise<string> {
    for (const row of this.deps.transport.orderedWorkerLocalRows?.() ?? this.deps.transport.workerLocalRows()) {
      try { if (await this.deps.transport.identity(row.connectionId) === backend) return row.connectionId; } catch { /* try next */ }
    }
    fail('SOURCE_OFFLINE', 503);
  }

  private async raw(grant: OfflineTargetGrant, method: 'GET' | 'POST', tail: string,
    body?: Json, key?: string): Promise<RawResponse> {
    const connectionId = await this.connection(grant.backendStoreId);
    try { return await this.deps.transport.raw(connectionId, method, tail, body, key, grant.backendStoreId); }
    catch (error) { if (error instanceof GatewayError) throw error; fail('SOURCE_OFFLINE', 503); }
  }

  /** Resolve the worker identity first, then perform the final local checks. */
  private async dispatch(grant: OfflineTargetGrant, claim: Claim, body: Json, key: string): Promise<RawResponse> {
    const connectionId = await this.connection(grant.backendStoreId);
    this.beforeDispatch(grant, claim);
    try { return await this.deps.transport.raw(connectionId, 'POST', `/tasks/${encodeURIComponent(grant.taskId)}/messages`, body, key, grant.backendStoreId); }
    catch (error) { if (error instanceof GatewayError) throw error; fail('SOURCE_OFFLINE', 503); }
  }

  private async readFacts(backendStoreId: string, projectId: string, taskId: string): Promise<Json> {
    const connectionId = await this.connection(backendStoreId);
    let response: RawResponse;
    try { response = await this.deps.transport.raw(connectionId, 'GET', `/tasks/${encodeURIComponent(taskId)}`, undefined, undefined, backendStoreId); }
    catch (error) { if (error instanceof GatewayError) throw error; fail('SOURCE_OFFLINE', 503); }
    if (response.status !== 200 || !isRecord(response.data) || response.data.taskId !== taskId || response.data.projectId !== projectId) {
      fail('LOCAL_BINDING_MISMATCH', 409);
    }
    const capabilities = isRecord(response.data.capabilities) ? response.data.capabilities : {};
    if (response.data.engineId !== 'sage-pi' || capabilities.followUp !== true) fail('NATIVE_ACTION_UNSUPPORTED', 409);
    return response.data;
  }

  private requireIdleRound(facts: Json): void {
    if (facts.state !== 'SUCCEEDED' || facts.nativeIdle !== true) fail('TARGET_BUSY', 409);
    for (const field of ['generation', 'nativeSessionId', 'currentCommandId']) {
      if (!validId(facts[field])) fail('LOCAL_REPLY_INVALID', 502);
    }
    if (facts.nativeTurnId != null && !validId(facts.nativeTurnId)) fail('LOCAL_REPLY_INVALID', 502);
  }

  private async facts(grant: OfflineTargetGrant, requireIdle = false): Promise<Json> {
    const response = await this.raw(grant, 'GET', `/tasks/${encodeURIComponent(grant.taskId)}`);
    if (response.status !== 200 || !isRecord(response.data) || response.data.taskId !== grant.taskId || response.data.projectId !== grant.projectId) {
      fail('LOCAL_BINDING_MISMATCH', 409);
    }
    const facts = response.data;
    if (facts.nativeSessionId !== grant.nativeSessionId || facts.engineId !== 'sage-pi') fail('NATIVE_TARGET_CHANGED', 409);
    if (requireIdle) {
      this.requireIdleRound(facts);
      for (const [field, expected] of [['generation', grant.generation], ['nativeTurnId', grant.nativeTurnId],
        ['currentCommandId', grant.targetCommandId]] as const) {
        if (expected !== undefined && facts[field] !== expected) fail('NATIVE_TARGET_CHANGED', 409);
      }
      const capabilities = isRecord(facts.capabilities) ? facts.capabilities : {};
      if (capabilities.followUp !== true) fail('NATIVE_ACTION_UNSUPPORTED', 409);
    }
    return facts;
  }

  private async receipt(grant: OfflineTargetGrant, sourceKey: string): Promise<Json | undefined> {
    const response = await this.raw(grant, 'GET', `/tasks/${encodeURIComponent(grant.taskId)}/interaction-requests/${encodeURIComponent(sourceKey)}`);
    if (response.status === 404) return undefined;
    if (response.status !== 200 || !isRecord(response.data) || response.data.taskId !== grant.taskId
      || response.data.requestKey !== sourceKey
      || (response.data.kind !== 'NATIVE_FOLLOW_UP' && response.data.operation !== 'NATIVE_FOLLOW_UP')) fail('LOCAL_REPLY_INVALID', 502);
    for (const [field, expected] of [['generation', grant.generation], ['nativeSessionId', grant.nativeSessionId],
      ['nativeTurnId', grant.nativeTurnId], ['targetCommandId', grant.targetCommandId]] as const) {
      if (response.data[field] !== undefined && expected !== undefined && response.data[field] !== expected) fail('LOCAL_REPLY_INVALID', 502);
    }
    return response.data;
  }

  private sourceKey(grant: OfflineTargetGrant, claim: Claim): string {
    return `xagt-offline-${hash(JSON.stringify([grant.permitRef, claim.delegationRef, claim.requestKey])).slice(0, 48)}`;
  }
  private executionRef(grant: OfflineTargetGrant, sourceKey: string, receipt: Json): string {
    return `xexec-${digest([grant.permitRef, sourceKey, receipt.executionRef ?? receipt.id ?? receipt.requestKey]).slice(0, 40)}`;
  }
  private eventId(grant: OfflineTargetGrant, claim: Claim, sourceKey: string, state: string): string {
    return `xevt-${digest([grant.permitRef, claim.delegationRef, sourceKey, state]).slice(0, 40)}`;
  }
  private async observe(claim: Claim, grant: OfflineTargetGrant, state: string, sourceKey: string,
    reasonCode?: string, executionRef?: string): Promise<void> {
    await this.deps.memberCluster.delegationRequest('POST', `/delegations/${claim.delegationRef}/observe`, {
      leaseGeneration: claim.leaseGeneration, sourceEventId: this.eventId(grant, claim, sourceKey, state), state,
      observedAt: iso(this.now()), ...(reasonCode === undefined ? {} : { reasonCode }),
      ...(executionRef === undefined ? {} : { executionRef }),
    });
  }
  private intentKey(grant: OfflineTargetGrant, requestKey: string): string { return `${grant.permitRef}:${requestKey}`; }
  private instructionDigest(grant: OfflineTargetGrant, claim: Claim): string {
    return digest([grant.taskId, grant.projectId, grant.generation, grant.nativeSessionId, grant.nativeTurnId ?? null,
      grant.targetCommandId, claim.instruction]);
  }
  private quarantine(claim: Partial<Claim>, reason: string): void {
    const key = `xq-${digest([claim.delegationRef, claim.permitRef, claim.requestKey, reason]).slice(0, 40)}`;
    this.deps.store.put(QUARANTINE_KIND, key, { ...claim, reason, observedAt: iso(this.now()) });
  }
  private async quarantineAndRelease(raw: unknown, reason = 'INVALID_CLAIM'): Promise<void> {
    const claim = isRecord(raw) ? raw : {};
    const partial: Partial<Claim> = {
      ...(validId(claim.delegationRef) ? { delegationRef: claim.delegationRef } : {}),
      ...(validId(claim.permitRef) ? { permitRef: claim.permitRef } : {}),
      ...(validId(claim.requestKey) ? { requestKey: claim.requestKey } : {}),
      ...(typeof claim.leaseGeneration === 'number' && Number.isSafeInteger(claim.leaseGeneration) && claim.leaseGeneration >= 0
        ? { leaseGeneration: claim.leaseGeneration } : {}),
      ...(typeof claim.leaseUntil === 'string' ? { leaseUntil: claim.leaseUntil } : {}),
    };
    this.quarantine(partial, reason);
    if (!partial.delegationRef || partial.leaseGeneration === undefined || !partial.leaseUntil
      || !Number.isFinite(Date.parse(partial.leaseUntil)) || Date.parse(partial.leaseUntil) <= this.now()) return;
    const sourceKey = `quarantine-${digest([partial.delegationRef, partial.requestKey ?? '', partial.leaseGeneration]).slice(0, 40)}`;
    try {
      await this.deps.memberCluster.delegationRequest('POST', `/delegations/${partial.delegationRef}/observe`, {
        leaseGeneration: partial.leaseGeneration, sourceEventId: `xevt-${sourceKey}`,
        state: 'QUARANTINED', reasonCode: reason, observedAt: iso(this.now()),
      });
    } catch { /* bad rows are isolated even if Hosted is temporarily unavailable */ }
  }
  private claim(value: unknown): Claim | undefined {
    if (!isRecord(value) || !validId(value.delegationRef) || !validId(value.permitRef) || !validId(value.requestKey)
      || typeof value.instruction !== 'string' || value.instruction.trim() === '' || value.instruction.length > 16_384
      || typeof value.leaseGeneration !== 'number' || !Number.isSafeInteger(value.leaseGeneration) || value.leaseGeneration < 0
      || typeof value.leaseUntil !== 'string' || !Number.isFinite(Date.parse(value.leaseUntil))) return undefined;
    return value as unknown as Claim;
  }
  private grantFor(permitRef: string): OfflineTargetGrant | undefined {
    return this.deps.store.list<OfflineTargetGrant>(GRANT_KIND).find(row => row.permitRef === permitRef);
  }
  private leaseActive(claim: Claim): boolean { return Date.parse(claim.leaseUntil) > this.now(); }

  /** Check identity and current Hosted lease immediately before the native POST. */
  private beforeDispatch(grant: OfflineTargetGrant, claim: Claim): void {
    if (this.stopped) fail('SOURCE_STOPPING', 503);
    const current = this.deps.store.get<OfflineTargetGrant>(GRANT_KIND, grant.targetId);
    if (!current || current.state !== 'ACTIVE') fail('GRANT_REVOKED', 409);
    if (Date.parse(current.expiresAt) <= this.now()) fail('GRANT_EXPIRED', 409);
    if (!this.leaseActive(claim)) fail('LEASE_EXPIRED', 409);
    if (this.deps.memberCluster.delegationIdentity() !== current.memberBinding) fail('MEMBER_SESSION_CHANGED', 409);
  }

  private executionState(facts: Json, sourceKey: string): Intent['state'] | undefined {
    const turn = isRecord(facts.turns) ? facts.turns[sourceKey] : undefined;
    if (isRecord(turn)) {
      if (turn.state === 'SUCCEEDED') return 'SUCCEEDED';
      if (['FAILED', 'CANCELLED', 'TIMED_OUT', 'BUDGET_EXCEEDED', 'BINDING_UNAVAILABLE'].includes(String(turn.state))) return 'FAILED';
    }
    if (facts.currentCommandId !== sourceKey) return undefined;
    if (['WAITING', 'WAITING_INPUT', 'NEEDS_INPUT'].includes(String(facts.state))) return 'WAITING';
    if (facts.state === 'RUNNING') return 'RUNNING';
    return undefined;
  }
  private async reportReceipt(claim: Claim, grant: OfflineTargetGrant, intentKey: string,
    intent: Intent, receipt: Json): Promise<void> {
    const executionRef = intent.executionRef ?? this.executionRef(grant, intent.sourceKey, receipt);
    if (intent.state === 'DISPATCHED' || intent.state === 'UNKNOWN') {
      if (!acceptedReceipt(receipt)) return;
      await this.observe(claim, grant, 'ACCEPTED', intent.sourceKey, undefined, executionRef);
      intent = { ...intent, state: 'ACCEPTED', executionRef, updatedAt: iso(this.now()) };
      this.deps.store.put(INTENT_KIND, intentKey, intent);
    }
    if (!['ACCEPTED', 'RUNNING', 'WAITING'].includes(intent.state)) return;
    try {
      const facts = await this.facts(grant);
      const state = this.executionState(facts, intent.sourceKey);
      if (state && state !== intent.state) {
        await this.observe(claim, grant, state, intent.sourceKey, undefined, executionRef);
        this.deps.store.put(INTENT_KIND, intentKey, { ...intent, state, executionRef, updatedAt: iso(this.now()) });
      }
    } catch { /* accepted receipt is retained; the next tracking claim reconciles */ }
  }

  private async processClaim(raw: unknown): Promise<void> {
    const claim = this.claim(raw);
    if (!claim) { await this.quarantineAndRelease(raw); return; }
    if (!this.leaseActive(claim)) return;
    const grant = this.grantFor(claim.permitRef);
    if (!grant) { await this.quarantineAndRelease(raw, 'PERMIT_BINDING_NOT_FOUND'); return; }
    const sourceKey = this.sourceKey(grant, claim);
    const key = this.intentKey(grant, claim.requestKey);
    const expectedDigest = this.instructionDigest(grant, claim);
    const existing = this.deps.store.get<Intent>(INTENT_KIND, key);
    if (this.deps.memberCluster.delegationIdentity() !== grant.memberBinding) return;
    // A short permit may finish tracking an already accepted round, but it
    // must never open a new dispatch after the permit has expired.
    if ((!existing && Date.parse(grant.expiresAt) <= this.now()) || (grant.state === 'REVOKED' && !existing)) {
      await this.observe(claim, grant, 'REJECTED', sourceKey, grant.state === 'REVOKED' ? 'GRANT_REVOKED' : 'GRANT_EXPIRED');
      return;
    }
    if (existing && (existing.instructionDigest !== expectedDigest || existing.sourceKey !== sourceKey)) {
      await this.observe(claim, grant, 'REJECTED', sourceKey, 'IDEMPOTENCY_PAYLOAD_MISMATCH'); return;
    }
    let durable: Json | undefined;
    try { durable = await this.receipt(grant, sourceKey); }
    catch (error) {
      const reason = error instanceof GatewayError ? error.code : 'SOURCE_RECEIPT_NOT_FOUND';
      await this.observe(claim, grant, existing?.state === 'ACCEPTED' ? 'ACCEPTED' : 'UNKNOWN', sourceKey, reason, existing?.executionRef);
      return;
    }
    if (durable !== undefined) {
      let authorization: Json;
      try {
        authorization = await this.deps.memberCluster.delegationRequest('POST', `/delegations/${claim.delegationRef}/authorize`, {
          leaseGeneration: claim.leaseGeneration,
        });
      } catch { return; }
      if ((authorization.mode !== 'DISPATCH' && authorization.mode !== 'RECONCILE')
        || (authorization.leaseGeneration !== undefined && authorization.leaseGeneration !== claim.leaseGeneration)) {
        await this.observe(claim, grant, 'REJECTED', sourceKey, 'LEASE_REVOKED'); return;
      }
      if (!existing) { await this.observe(claim, grant, 'UNKNOWN', sourceKey, 'UNBOUND_RECEIPT'); return; }
      if (['DISPATCHED', 'UNKNOWN', 'ACCEPTED', 'RUNNING', 'WAITING'].includes(existing.state)) {
        await this.reportReceipt(claim, grant, key, existing, durable);
      }
      return;
    }
    if (existing) {
      try {
        const authorization = await this.deps.memberCluster.delegationRequest('POST', `/delegations/${claim.delegationRef}/authorize`, {
          leaseGeneration: claim.leaseGeneration,
        });
        if ((authorization.mode !== 'DISPATCH' && authorization.mode !== 'RECONCILE')
          || (authorization.leaseGeneration !== undefined && authorization.leaseGeneration !== claim.leaseGeneration)) return;
      } catch { return; }
      await this.observe(claim, grant, existing.state === 'ACCEPTED' ? 'ACCEPTED' : 'UNKNOWN', sourceKey,
        existing.state === 'ACCEPTED' ? undefined : 'SOURCE_RECEIPT_NOT_FOUND', existing.executionRef);
      return;
    }
    try {
      await this.facts(grant, true);
      const intent: Intent = { permitRef: grant.permitRef, requestKey: claim.requestKey, sourceKey,
        instructionDigest: expectedDigest, state: 'DISPATCHED', createdAt: iso(this.now()), updatedAt: iso(this.now()) };
      this.deps.store.put(INTENT_KIND, key, intent);
      let authorization: Json;
      try {
        authorization = await this.deps.memberCluster.delegationRequest('POST', `/delegations/${claim.delegationRef}/authorize`, {
          leaseGeneration: claim.leaseGeneration,
        });
      } catch { fail('LEASE_REVOKED', 409); }
      if (authorization.mode !== 'DISPATCH'
        || (authorization.leaseGeneration !== undefined && authorization.leaseGeneration !== claim.leaseGeneration)) fail('LEASE_REVOKED', 409);
      const response = await this.dispatch(grant, claim, {
        requestKey: sourceKey, kind: 'NATIVE_FOLLOW_UP', content: claim.instruction,
        generation: grant.generation, nativeSessionId: grant.nativeSessionId, targetCommandId: grant.targetCommandId,
        ...(grant.nativeTurnId === undefined ? {} : { nativeTurnId: grant.nativeTurnId }),
      }, sourceKey);
      if (response.status < 200 || response.status >= 300) fail('SOURCE_REJECTED', response.status >= 500 ? 503 : 409);
      const after = await this.receipt(grant, sourceKey);
      if (after === undefined || !acceptedReceipt(after)) {
        await this.observe(claim, grant, 'UNKNOWN', sourceKey, 'LOCAL_REPLY_UNCONFIRMED');
        this.deps.store.put(INTENT_KIND, key, { ...intent, state: 'UNKNOWN', code: 'LOCAL_REPLY_UNCONFIRMED', updatedAt: iso(this.now()) });
        return;
      }
      await this.reportReceipt(claim, grant, key, intent, after);
    } catch (error) {
      const code = error instanceof GatewayError ? error.code : 'SOURCE_OFFLINE';
      const definitive = new Set(['TARGET_BUSY', 'NATIVE_TARGET_CHANGED', 'LOCAL_BINDING_MISMATCH', 'GRANT_REVOKED',
        'GRANT_EXPIRED', 'LEASE_EXPIRED', 'LEASE_REVOKED', 'MEMBER_SESSION_CHANGED', 'NATIVE_ACTION_UNSUPPORTED']);
      await this.observe(claim, grant, definitive.has(code) ? 'REJECTED' : 'UNKNOWN', sourceKey, code);
      this.deps.store.put(INTENT_KIND, key, { permitRef: grant.permitRef, requestKey: claim.requestKey, sourceKey,
        instructionDigest: expectedDigest, state: definitive.has(code) ? 'REJECTED' : 'UNKNOWN',
        createdAt: iso(this.now()), updatedAt: iso(this.now()), code });
    }
  }

  async pollOnce(): Promise<void> {
    if (this.stopped) return;
    let claims: unknown;
    try { claims = (await this.deps.memberCluster.delegationRequest('GET', '/delegations/claims?limit=4')).items; }
    catch { return; }
    if (!Array.isArray(claims)) return;
    for (const claim of claims) {
      if (this.stopped) return;
      try { await this.processClaim(claim); }
      catch (error) { this.quarantine(isRecord(claim) ? claim as Partial<Claim> : {}, error instanceof GatewayError ? error.code : 'CLAIM_FAILED'); }
    }
  }
}
