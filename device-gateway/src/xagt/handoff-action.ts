/**
 * Narrow member-MCP handoff capability.
 *
 * The coordinator remains the only component that can advance a handoff. This
 * class merely holds an owner-issued capability, rechecks its binding, and
 * calls GatewayWorkHandoffs.remote with the coordinator's normal phase keys.
 * It never returns or accepts a general worker token from the MCP surface.
 */
import { randomUUID } from 'node:crypto';
import type { GatewayStoreView, GatewayWorkHandoffs, JsonObject, LocalTaskResult } from '../context.js';
import { GatewayError, fail, hash, id, isRecord, text } from '../protocol.js';

type Json = Record<string, unknown>;
const ACTION_KIND = 'xagt-handoff-action';
const CALL_KIND = 'xagt-handoff-action-call';
const MAX_TTL = 24 * 60 * 60 * 1000;

const digest = (value: unknown): string => hash(JSON.stringify(value));
const nowIso = (now: number): string => new Date(now).toISOString();
const boundedId = (value: unknown): string => { id(value); return value as string; };
const exact = (value: unknown, fields: string[]): Json => {
  if (!isRecord(value) || Object.keys(value).some(key => !fields.includes(key))) fail('INVALID_REQUEST', 400);
  return value;
};
const json = (value: unknown): Json => { if (!isRecord(value)) fail('LOCAL_REPLY_INVALID', 502); return value; };

export interface HandoffActionDeps {
  store: Pick<GatewayStoreView, 'get' | 'put' | 'list'>;
  handoffs: Pick<GatewayWorkHandoffs, 'remote'>;
  /** Current owner/grant revision; a change invalidates every capability. */
  ownerRevision(): string | Promise<string>;
  /** Resolves an owner-issued credential reference to a coordinator token. */
  resolveCredential(credentialRef: string): string | Promise<string>;
  /** Reads the exact current source task/session round. */
  sourceRound(sourceRef: Json): Json | Promise<Json>;
  now?: () => number;
}

interface Action {
  actionId: string;
  credentialRef: string;
  authRevision: string;
  sourceRef: Json;
  targetAgentRef: Json;
  targetPreflight?: Json;
  options: Json;
  requestKey: string;
  sourceRoundFingerprint: string;
  expiresAt: string;
  createdAt: string;
  state: 'READY' | 'PREPARING' | 'ACTIVE' | 'UNKNOWN' | 'REVOKED' | 'TAKEN_OVER';
  handoffId?: string;
}

interface Call {
  actionId: string;
  operation: 'PREPARE' | 'CONFIRM' | 'ADVANCE';
  requestKey: string;
  fingerprint: string;
  state: 'DISPATCHED' | 'OBSERVED' | 'UNKNOWN';
  createdAt: string;
  updatedAt: string;
  phase?: string;
  body?: Json;
  response?: Json;
}

export class HandoffActionService {
  private readonly now: () => number;
  private readonly locks = new Map<string, Promise<void>>();

  constructor(private readonly deps: HandoffActionDeps) { this.now = deps.now ?? Date.now; }

  /** Owner-only capability mint. The credential itself is never returned. */
  async issue(body: JsonObject): Promise<JsonObject> {
    const args = exact(body, ['credentialRef', 'authRevision', 'sourceRef', 'targetAgentRef', 'targetPreflight',
      'options', 'requestKey', 'expiresAt']);
    const credentialRef = boundedId(args.credentialRef);
    const authRevision = text(args, 'authRevision');
    const requestKey = boundedId(args.requestKey);
    const expiresAt = text(args, 'expiresAt');
    const expiry = Date.parse(expiresAt);
    if (!Number.isFinite(expiry) || expiry <= this.now() || expiry > this.now() + MAX_TTL) fail('INVALID_REQUEST', 400);
    const sourceRef = exact(args.sourceRef, ['kind', 'storeId', 'sessionId', 'taskId', 'engineId']);
    const targetAgentRef = exact(args.targetAgentRef, ['hostKey', 'kind', 'storeId', 'engineId', 'projectRef', 'policyPresetId']);
    const options = args.options === undefined ? {} : json(args.options);
    const hostKey = text(targetAgentRef, 'hostKey');
    const targetPreflight = args.targetPreflight === undefined || args.targetPreflight === null
      ? undefined : exact(args.targetPreflight, ['schemaVersion', 'sourceHostRef', 'sourceRef', 'target', 'requestKey',
        'optionsRevision', 'grantRevision', 'targetDeviceId', 'issuedAt', 'expiresAt', 'kid', 'signature']);
    if (hostKey !== 'local' && targetPreflight === undefined) fail('HANDOFF_TARGET_PREFLIGHT_REQUIRED', 409);
    if (targetPreflight !== undefined) {
      if (targetPreflight.requestKey !== requestKey || targetPreflight.schemaVersion !== 'work-handoff-target-preflight/1'
        || typeof targetPreflight.signature !== 'string' || typeof targetPreflight.kid !== 'string'
        || typeof targetPreflight.expiresAt !== 'number' || targetPreflight.expiresAt <= this.now()) {
        fail('HANDOFF_TARGET_PREFLIGHT_INVALID', 403);
      }
    }
    const ownerBefore = await this.deps.ownerRevision();
    if (ownerBefore !== authRevision) fail('GRANT_REVISION_CONFLICT', 409);
    // Source facts are captured as a binding, not as a caller-provided hint.
    const round = await this.deps.sourceRound(sourceRef);
    const sourceRoundFingerprint = this.roundFingerprint(sourceRef, round);
    if (await this.deps.ownerRevision() !== authRevision) fail('GRANT_REVISION_CONFLICT', 409);
    // Resolve once at mint time to prove that the owner credential exists. The
    // raw token is retained only by the owner credential provider, not here.
    const token = await this.deps.resolveCredential(credentialRef);
    if (typeof token !== 'string' || token.length < 1) fail('ACCESS_UNAUTHORIZED', 401);
    if (await this.deps.ownerRevision() !== authRevision) fail('GRANT_REVISION_CONFLICT', 409);
    const action: Action = {
      actionId: `xha-${randomUUID()}`, credentialRef, authRevision, sourceRef, targetAgentRef,
      ...(targetPreflight === undefined ? {} : { targetPreflight }), options, requestKey, sourceRoundFingerprint,
      expiresAt, createdAt: nowIso(this.now()), state: 'READY',
    };
    this.deps.store.put(ACTION_KIND, action.actionId, action);
    return this.view(action);
  }

  async prepare(actionId: string): Promise<JsonObject> {
    return this.withActionLock(actionId, () => this.prepareUnlocked(actionId));
  }

  private async prepareUnlocked(actionId: string): Promise<JsonObject> {
    const action = await this.authorized(actionId, false, true);
    const body: Json = { requestKey: action.requestKey, sourceRef: action.sourceRef,
      targetAgentRef: action.targetAgentRef, ...(action.targetPreflight === undefined ? {} : { targetPreflight: action.targetPreflight }),
      options: action.options };
    return this.write(action, 'PREPARE', action.requestKey, body, [], true);
  }

  async status(actionId: string): Promise<JsonObject> {
    const action = await this.authorized(actionId, true, false);
    let result: Json | undefined;
    if (action.handoffId) {
      result = await this.readCoordinator(action, [action.handoffId]);
    } else {
      result = await this.readCoordinator(action, ['requests', action.requestKey]);
      if (result?.handoffId !== undefined) this.bindHandoff(action, result);
    }
    if (!result) return { schemaVersion: 'xagt-handoff-status/1', actionId, state: 'UNKNOWN', reasonCode: 'COORDINATOR_UNAVAILABLE' };
    this.updateState(action, result);
    return { ...result, actionId };
  }

  async confirm(actionId: string, body: JsonObject): Promise<JsonObject> {
    return this.withActionLock(actionId, () => this.confirmUnlocked(actionId, body));
  }

  private async confirmUnlocked(actionId: string, body: JsonObject): Promise<JsonObject> {
    const args = exact(body, ['expectedMaterialRevision', 'expectedMaterialDigest', 'allowBackgroundProgress']);
    if (!Number.isSafeInteger(args.expectedMaterialRevision) || (args.allowBackgroundProgress !== undefined && typeof args.allowBackgroundProgress !== 'boolean')) {
      fail('INVALID_REQUEST', 400);
    }
    const action = await this.authorized(actionId, false, true);
    if (!action.handoffId) fail('HANDOFF_NOT_PREPARED', 409);
    const requestKey = `handoff:${action.requestKey}:CONFIRM`;
    const wire: Json = { requestKey, expectedMaterialRevision: args.expectedMaterialRevision,
      ...(args.expectedMaterialDigest === undefined ? {} : { expectedMaterialDigest: text(args, 'expectedMaterialDigest') }),
      allowBackgroundProgress: args.allowBackgroundProgress === true,
      ...(action.targetPreflight === undefined ? {} : { targetPreflight: action.targetPreflight }) };
    return this.write(action, 'CONFIRM', requestKey, wire, [action.handoffId, 'confirm'], false);
  }

  async advance(actionId: string, body: JsonObject): Promise<JsonObject> {
    return this.withActionLock(actionId, () => this.advanceUnlocked(actionId, body));
  }

  private async advanceUnlocked(actionId: string, body: JsonObject): Promise<JsonObject> {
    const args = exact(body, ['importBinding']);
    // After confirmation the coordinator owns source sealing/target progress;
    // source round reads may legitimately disappear or change.
    const action = await this.authorized(actionId, false, false);
    const current = await this.status(actionId);
    const phase = typeof current.phase === 'string' ? current.phase : undefined;
    if (!phase || !action.handoffId) fail('HANDOFF_PHASE_MISMATCH', 409);
    const requestKey = `handoff:${action.requestKey}:${phase}`;
    const wire: Json = { requestKey, importBinding: args.importBinding ?? null,
      ...(action.targetPreflight === undefined ? {} : { targetPreflight: action.targetPreflight }) };
    return this.write(action, 'ADVANCE', requestKey, wire, [action.handoffId, 'continue'], false);
  }

  async revoke(actionId: string): Promise<void> {
    const action = this.action(actionId);
    if (action === undefined) fail('NOT_FOUND', 404);
    this.deps.store.put(ACTION_KIND, actionId, { ...action, state: 'REVOKED' });
  }

  async peerAudience(actionId: string): Promise<{ hostRef: string; deviceId: string }> {
    const action = await this.authorized(actionId, false, false);
    if (!action.targetPreflight) fail('HANDOFF_TARGET_PREFLIGHT_REQUIRED', 409);
    return { hostRef: text(action.targetAgentRef, 'hostKey'), deviceId: text(action.targetPreflight, 'targetDeviceId') };
  }

  private action(actionId: string): Action | undefined {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(actionId)) fail('INVALID_REQUEST', 400);
    return this.deps.store.get<Action>(ACTION_KIND, actionId);
  }

  private async authorized(actionId: string, allowExpiredTracking: boolean, checkSourceRound: boolean): Promise<Action> {
    const action = this.action(actionId);
    if (!action) fail('NOT_FOUND', 404);
    if (action.state === 'REVOKED') fail('SCOPE_DENIED', 403);
    if (!allowExpiredTracking && Date.parse(action.expiresAt) <= this.now()) fail('GRANT_EXPIRED', 409);
    if (await this.deps.ownerRevision() !== action.authRevision) fail('GRANT_REVISION_CONFLICT', 409);
    if (checkSourceRound) {
      const current = await this.deps.sourceRound(action.sourceRef);
      if (this.roundFingerprint(action.sourceRef, current) !== action.sourceRoundFingerprint) fail('NATIVE_TARGET_CHANGED', 409);
    }
    return action;
  }

  private async token(action: Action): Promise<string> {
    const value = await this.deps.resolveCredential(action.credentialRef);
    if (typeof value !== 'string' || value.length < 1) fail('ACCESS_UNAUTHORIZED', 401);
    return value;
  }

  private async write(action: Action, operation: Call['operation'], requestKey: string, body: Json,
    tail: string[], create: boolean): Promise<JsonObject> {
    const fingerprint = digest(body);
    const callId = `${action.actionId}:${operation}:${requestKey}`;
    const prior = this.deps.store.get<Call>(CALL_KIND, callId);
    if (prior && prior.fingerprint !== fingerprint
      && !(operation === 'ADVANCE' && this.compatibleAdvanceBody(prior.body?.importBinding, body.importBinding))) {
      fail('IDEMPOTENCY_PAYLOAD_MISMATCH', 409);
    }
    if (prior?.response) return { ...prior.response, actionId: action.actionId };
    const phase = operation === 'ADVANCE' ? requestKey.slice(requestKey.lastIndexOf(':') + 1) : undefined;
    if (prior && operation === 'ADVANCE') {
      const current = await this.status(action.actionId);
      if (typeof current.phase === 'string' && current.phase !== phase) {
        const verified = { ...current };
        prior.state = 'OBSERVED'; prior.response = verified; prior.updatedAt = nowIso(this.now());
        this.deps.store.put(CALL_KIND, callId, prior);
        return { ...verified, actionId: action.actionId };
      }
    }
    const call: Call = prior ?? { actionId: action.actionId, operation, requestKey, fingerprint,
      ...(phase === undefined ? {} : { phase }), body, state: 'DISPATCHED', createdAt: nowIso(this.now()), updatedAt: nowIso(this.now()) };
    if (prior) { call.fingerprint = fingerprint; call.body = body; call.state = 'DISPATCHED'; call.response = undefined; }
    // Durable intent exists before the coordinator write, so a lost response
    // cannot turn into a second create/confirm/advance.
    this.deps.store.put(CALL_KIND, callId, call);
    const token = await this.token(action);
    await this.authorized(action.actionId, false, operation === 'PREPARE' || operation === 'CONFIRM');
    let result: LocalTaskResult;
    try {
      result = await this.deps.handoffs.remote(token, 'POST', tail, body, requestKey, null);
    } catch (error) {
      this.ensureActive(action.actionId);
      if (create) {
        const recovered = await this.readCoordinator(action, ['requests', action.requestKey]);
        if (recovered?.handoffId !== undefined) {
          this.bindHandoff(action, recovered);
          call.state = 'OBSERVED'; call.response = recovered; call.updatedAt = nowIso(this.now());
          this.deps.store.put(CALL_KIND, callId, call);
          return { ...recovered, actionId: action.actionId };
        }
      } else if (action.handoffId) {
        const recovered = await this.readCoordinator(action, [action.handoffId]);
        if (recovered) {
          this.updateState(action, recovered);
          if (operation === 'ADVANCE' && recovered.phase === call.phase) {
            call.state = 'DISPATCHED'; call.response = undefined; call.updatedAt = nowIso(this.now());
          } else {
            call.state = 'OBSERVED'; call.response = recovered;
          }
          call.updatedAt = nowIso(this.now());
          this.deps.store.put(CALL_KIND, callId, call);
          return { ...recovered, actionId: action.actionId };
        }
      }
      call.state = 'UNKNOWN'; call.updatedAt = nowIso(this.now()); this.deps.store.put(CALL_KIND, callId, call);
      if (error instanceof GatewayError) throw error;
      fail('COORDINATOR_UNAVAILABLE', 503);
    }
    this.ensureActive(action.actionId);
    if (result.status < 200 || result.status >= 300) fail('HANDOFF_ACTION_REJECTED', result.status >= 500 ? 503 : 409);
    const response = json(result.body);
    if (operation === 'ADVANCE' && response.phase === call.phase) {
      // Same-phase progress is pending, not a spent success. Keep the durable
      // intent so the exact coordinator phase key can be retried.
      call.state = 'DISPATCHED'; call.response = undefined; call.updatedAt = nowIso(this.now());
    } else {
      call.state = 'OBSERVED'; call.response = response; call.updatedAt = nowIso(this.now());
    }
    this.deps.store.put(CALL_KIND, callId, call);
    if (create) this.bindHandoff(action, response);
    this.updateState(action, response);
    return { ...response, actionId: action.actionId };
  }

  private withActionLock<T>(actionId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(actionId) ?? Promise.resolve();
    const current = previous.then(work, work);
    const tail = current.then(() => undefined, () => undefined);
    this.locks.set(actionId, tail);
    return current.finally(() => { if (this.locks.get(actionId) === tail) this.locks.delete(actionId); });
  }

  private ensureActive(actionId: string): void {
    const current = this.action(actionId);
    if (!current || current.state === 'REVOKED') fail('SCOPE_DENIED', 403);
  }

  private compatibleAdvanceBody(before: unknown, after: unknown): boolean {
    if (before == null) return after == null || isRecord(after);
    if (!isRecord(before) || !isRecord(after)) return false;
    if (before.importId !== after.importId || before.targetTaskRef !== after.targetTaskRef) return false;
    const strip = (value: Json): Json => { const copy = { ...value }; delete copy.consumptionReport; return copy; };
    if (digest(strip(before)) !== digest(strip(after))) return false;
    return before.consumptionReport === undefined || after.consumptionReport !== undefined;
  }

  private async readCoordinator(action: Action, tail: string[]): Promise<Json | undefined> {
    try {
      const response = await this.deps.handoffs.remote(await this.token(action), 'GET', tail, null, null, null);
      if (response.status !== 200 || !isRecord(response.body)) return undefined;
      return response.body;
    } catch { return undefined; }
  }

  private bindHandoff(action: Action, response: Json): void {
    if (typeof response.handoffId !== 'string') return;
    const current = this.action(action.actionId);
    if (!current) return;
    if (current.handoffId && current.handoffId !== response.handoffId) fail('LOCAL_REPLY_INVALID', 502);
    this.deps.store.put(ACTION_KIND, action.actionId, { ...current, handoffId: response.handoffId,
      state: current.state === 'READY' || current.state === 'PREPARING' ? 'ACTIVE' : current.state });
    action.handoffId = response.handoffId;
  }

  private updateState(action: Action, response: Json): void {
    const phase = response.phase;
    const current = this.action(action.actionId);
    if (!current) return;
    const state = phase === 'TAKEN_OVER' ? 'TAKEN_OVER' : current.state === 'READY' ? 'ACTIVE' : current.state;
    this.deps.store.put(ACTION_KIND, action.actionId, { ...current, state });
  }

  private roundFingerprint(sourceRef: Json, round: Json): string {
    const sourceKind = text(sourceRef, 'kind');
    const expected = sourceKind === 'WORKER_LOCAL' ? text(sourceRef, 'taskId') : text(sourceRef, 'sessionId');
    const actual = sourceKind === 'WORKER_LOCAL' ? round.taskId : (round.sessionId ?? round.taskRef);
    if (actual !== expected) fail('LOCAL_BINDING_MISMATCH', 409);
    const selected: Json = {};
    for (const field of ['taskId', 'sessionId', 'taskRef', 'storeId', 'engineId', 'generation', 'nativeSessionId',
      'nativeTurnId', 'currentCommandId', 'sessionVersion']) {
      if (round[field] !== undefined) selected[field] = round[field];
    }
    return digest([sourceRef, selected]);
  }

  private view(action: Action): JsonObject {
    return { schemaVersion: 'xagt-handoff-action/1', actionId: action.actionId, requestKey: action.requestKey,
      sourceRef: action.sourceRef, targetAgentRef: action.targetAgentRef, expiresAt: action.expiresAt,
      state: action.state, ...(action.handoffId === undefined ? {} : { handoffId: action.handoffId }) };
  }
}
