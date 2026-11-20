import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { request } from 'node:https';
import type { TLSSocket } from 'node:tls';
import type { GatewayAuth, GatewayLocalTasks, GatewayStoreView, GatewayWorkHandoffs, JsonObject, LocalTaskResult } from '../context.js';
import type { MemberCluster } from '../member-cluster.js';
import { constantEqual, fail, hash, isRecord, seal, text, unseal } from '../protocol.js';
import { errorBody, XagtError } from './common.js';
import { HandoffActionService } from './handoff-action.js';
import { advancePeerImport } from './handoff-transfer.js';

const ACTOR = 'xagt-handoff-actor';
const PURPOSE = 'xagt-handoff-device';
const TYPES = ['prepare', 'status', 'confirm', 'advance'];
const PATH = '/personal/v1/work-handoffs';
const fingerprint = (value: string) => hash(`xagt-handoff-writer:${value}`);
const identifier = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

interface TargetPeer {
  origin: string;
  certSha256: string;
  deviceEnvelope: string;
}

interface SuccessorBinding {
  delegationRef: string;
  sourceExecutionRef: string;
  targetInstanceId: string;
  targetHostRef: string;
}

interface Actor {
  ref: string;
  actionId?: string;
  sourceRequestKey: string;
  sourceDeviceId: string;
  sourceDeviceRevision: number;
  sourceEnvelope: string;
  tokenHash: string;
  memberIdentity: string;
  expiresAt: number;
  revoked?: boolean;
  target?: TargetPeer;
  successor?: SuccessorBinding;
  report?: JsonObject;
  successorRecorded?: boolean;
}

interface Dependencies {
  store: Pick<GatewayStoreView, 'get' | 'put' | 'list' | 'delete'>;
  handoffs: GatewayWorkHandoffs;
  auth: GatewayAuth;
  local: Pick<GatewayLocalTasks, 'nativeCall' | 'okNative'>;
  member: Pick<MemberCluster, 'delegationIdentity' | 'delegationRequest'>;
  storeKey: () => Uint8Array;
  hostRef: string;
}

const exact = (body: unknown, keys: string[]): JsonObject => {
  if (!isRecord(body) || Object.keys(body).some(key => !keys.includes(key))) fail('INVALID_REQUEST', 400);
  return body;
};

function publicStatus(view: JsonObject, transfer?: JsonObject): JsonObject {
  const result: JsonObject = {};
  for (const key of ['handoffId', 'requestKey', 'phase', 'state', 'pendingReason', 'candidateMaterialDigest',
    'candidateRevision', 'materialRevision', 'materialDigest', 'sourceSealed', 'targetTaskRef', 'reasonCode']) {
    if (view[key] !== undefined) result[key] = view[key];
  }
  if (transfer) result.transfer = transfer;
  return result;
}

function payload(reply: LocalTaskResult): JsonObject {
  if (reply.status < 200 || reply.status >= 300) {
    fail(isRecord(reply.body) && typeof reply.body.code === 'string' ? reply.body.code : 'HANDOFF_PEER_UNAVAILABLE', reply.status);
  }
  if (!isRecord(reply.body)) fail('LOCAL_REPLY_INVALID', 502);
  return reply.body;
}

function peerOrigin(value: string): string {
  let origin: URL;
  try { origin = new URL(value); } catch { return fail('INVALID_REQUEST', 400); }
  if (origin.protocol !== 'https:' || origin.pathname !== '/' || origin.username || origin.password
    || origin.search || origin.hash) fail('INVALID_REQUEST', 400);
  return origin.origin;
}

export class HandoffMcp {
  private readonly actions: HandoffActionService;
  private readonly active = new Set<string>();

  constructor(private readonly deps: Dependencies) {
    this.actions = new HandoffActionService({
      store: deps.store, handoffs: deps.handoffs,
      ownerRevision: () => deps.member.delegationIdentity(),
      resolveCredential: async credentialRef => (
        await this.current(credentialRef, false)).token,
      sourceRound: async source => {
        if (source.kind !== 'WORKER_LOCAL') fail('HANDOFF_ENGINE_UNSUPPORTED', 409);
        const backend = text(source, 'storeId');
        const task = text(source, 'taskId');
        if (!identifier.test(backend) || !identifier.test(task)) fail('INVALID_REQUEST', 400);
        const facts = deps.local.okNative(await deps.local.nativeCall(backend, 'GET', `/tasks/${task}`, null, undefined));
        if (!isRecord(facts) || facts.taskId !== task || facts.engineId !== 'sage-pi') fail('LOCAL_BINDING_MISMATCH', 409);
        return facts;
      },
    });
  }

  async issue(input: unknown): Promise<JsonObject> {
    const body = exact(input, ['sourceDeviceToken', 'sourceRef', 'targetAgentRef', 'targetPreflight',
      'targetConnection', 'options', 'requestKey', 'expiresAt', 'sourceDelegation']);
    const source = exact(body.sourceRef, ['kind', 'storeId', 'taskId', 'engineId']);
    if (source.kind !== 'WORKER_LOCAL') fail('HANDOFF_ENGINE_UNSUPPORTED', 409);
    const targetAgent = exact(body.targetAgentRef, ['hostKey', 'kind', 'storeId', 'engineId', 'projectRef', 'policyPresetId']);
    const nativePi = targetAgent.kind === 'WORKER_LOCAL' && ['pi', 'sage-pi'].includes(String(targetAgent.engineId));
    const remoteAcs = targetAgent.kind === 'ACS' && targetAgent.hostKey !== 'local'
      && targetAgent.engineId == null && targetAgent.policyPresetId == null;
    if (!nativePi && !remoteAcs) fail('HANDOFF_ENGINE_UNSUPPORTED', 409);
    const memberIdentity = this.deps.member.delegationIdentity();
    const sourceToken = text(body, 'sourceDeviceToken');
    const device = await this.deps.auth.authorizeLocal(sourceToken, text(source, 'storeId'), text(source, 'taskId'), 'OBSERVE');
    if (!device.actions?.includes('HANDOFF')) fail('SCOPE_DENIED', 403);
    const expiresAt = Date.parse(text(body, 'expiresAt'));
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now() || expiresAt > Date.now() + 86_400_000) fail('INVALID_REQUEST', 400);
    let target: TargetPeer | undefined;
    if (targetAgent.hostKey !== 'local') {
      if (!isRecord(body.targetPreflight) || body.targetPreflight.sourceHostRef !== this.deps.hostRef) {
        fail('HANDOFF_TARGET_PREFLIGHT_INVALID', 403);
      }
      const connection = exact(body.targetConnection, ['origin', 'certSha256', 'deviceToken']);
      const origin = peerOrigin(text(connection, 'origin'));
      const certSha256 = text(connection, 'certSha256').replace(/:/g, '').toLowerCase();
      if (!/^[a-f0-9]{64}$/.test(certSha256)) fail('INVALID_REQUEST', 400);
      target = { origin, certSha256, deviceEnvelope: seal(text(connection, 'deviceToken'), this.deps.storeKey(), PURPOSE) };
    } else if (body.targetConnection !== undefined) fail('INVALID_REQUEST', 400);
    const successor = body.sourceDelegation === undefined ? undefined
      : this.bindDelegation(body.sourceDelegation, source, targetAgent, memberIdentity);
    if (successor && !target) fail('INVALID_REQUEST', 400);
    const ref = `xhc-${randomUUID()}`;
    const token = `xhw-${randomBytes(24).toString('base64url')}`;
    const actor: Actor = {
      ref, sourceRequestKey: text(body, 'requestKey'), sourceDeviceId: device.id, sourceDeviceRevision: device.revision,
      sourceEnvelope: seal(sourceToken, this.deps.storeKey(), PURPOSE), tokenHash: fingerprint(token), memberIdentity,
      expiresAt, target, successor,
    };
    this.deps.store.put(ACTOR, ref, actor);
    try {
      const action = await this.actions.issue({ credentialRef: ref, authRevision: memberIdentity, sourceRef: source,
        targetAgentRef: targetAgent, targetPreflight: body.targetPreflight, options: body.options,
        requestKey: actor.sourceRequestKey, expiresAt: new Date(expiresAt).toISOString() });
      this.deps.store.put(ACTOR, ref, { ...actor, actionId: String(action.actionId) });
      return { credentialRef: ref, actionId: action.actionId, expiresAt: new Date(expiresAt).toISOString(), token };
    } catch (error) {
      this.deps.store.delete(ACTOR, ref);
      throw error;
    }
  }

  private bindDelegation(input: unknown, source: JsonObject, target: JsonObject, memberIdentity: string): SuccessorBinding {
    const args = exact(input, ['delegationRef', 'permitRef', 'requestKey', 'sourceExecutionRef', 'targetInstanceId']);
    const delegationRef = text(args, 'delegationRef'), permitRef = text(args, 'permitRef'), requestKey = text(args, 'requestKey');
    const sourceExecutionRef = text(args, 'sourceExecutionRef'), targetInstanceId = text(args, 'targetInstanceId');
    if (![delegationRef, permitRef, requestKey, sourceExecutionRef, targetInstanceId].every(value => identifier.test(value))) {
      fail('INVALID_REQUEST', 400);
    }
    const sourceKey = `xagt-offline-${hash(JSON.stringify([permitRef, delegationRef, requestKey])).slice(0, 48)}`;
    const intent = this.deps.store.get<JsonObject>('xagt-offline-intent', `${permitRef}:${requestKey}`);
    const grant = this.deps.store.list<JsonObject>('xagt-offline-target').find(row => row.permitRef === permitRef);
    if (!intent || intent.sourceKey !== sourceKey || intent.executionRef !== sourceExecutionRef || !grant
      || grant.memberBinding !== memberIdentity || grant.backendStoreId !== source.storeId || grant.taskId !== source.taskId) {
      fail('HANDOFF_SOURCE_EXECUTION_MISMATCH', 409);
    }
    return { delegationRef, sourceExecutionRef, targetInstanceId, targetHostRef: text(target, 'hostKey') };
  }

  revoke(ref: string): void {
    const actor = this.deps.store.get<Actor>(ACTOR, ref);
    if (!actor) fail('NOT_FOUND', 404);
    this.deps.store.put(ACTOR, ref, { ...actor, revoked: true });
  }

  async renew(ref: string, input: unknown): Promise<JsonObject> {
    const args = exact(input, ['sourceDeviceToken', 'targetDeviceToken', 'targetOrigin']);
    if (args.sourceDeviceToken === undefined && args.targetDeviceToken === undefined
      || args.targetOrigin !== undefined && args.targetDeviceToken === undefined) fail('INVALID_REQUEST', 400);
    const actor = this.deps.store.get<Actor>(ACTOR, ref);
    if (!actor?.actionId) fail('NOT_FOUND', 404);
    if (this.active.has(ref)) fail('BUSY', 409);
    this.active.add(ref);
    try {
      this.check(actor, true);
      const replacement = { ...actor };
      if (args.sourceDeviceToken !== undefined) {
        const token = text(args, 'sourceDeviceToken');
        this.verifySourceDevice(actor, await this.deps.auth.authenticate(token));
        replacement.sourceEnvelope = seal(token, this.deps.storeKey(), PURPOSE);
      }
      if (args.targetDeviceToken !== undefined) {
        if (!actor.target) fail('HANDOFF_TARGET_PREFLIGHT_REQUIRED', 409);
        const audience = await this.actions.peerAudience(actor.actionId);
        const token = text(args, 'targetDeviceToken');
        const peer = { ...actor.target, ...(args.targetOrigin === undefined ? {} : { origin: peerOrigin(text(args, 'targetOrigin')) }) };
        const host = payload(await pinnedCall(peer, token, 'GET', ['host'], undefined, undefined, () => this.check(actor, true)));
        if (host.personalHostId !== audience.hostRef || host.deviceGrantId !== audience.deviceId
          || !Array.isArray(host.actions) || !host.actions.includes('HANDOFF')) fail('GRANT_REVISION_CONFLICT', 409);
        replacement.target = { ...peer, deviceEnvelope: seal(token, this.deps.storeKey(), PURPOSE) };
      }
      this.check(actor, true);
      if (args.sourceDeviceToken !== undefined) {
        this.verifySourceDevice(actor, await this.deps.auth.authenticate(text(args, 'sourceDeviceToken')));
        this.check(actor, true);
      }
      this.deps.store.put(ACTOR, ref, replacement);
      return { credentialRef: ref, requestKey: actor.sourceRequestKey, sourceRenewed: args.sourceDeviceToken !== undefined,
        targetRenewed: args.targetDeviceToken !== undefined };
    } finally { this.active.delete(ref); }
  }

  private check(actor: Actor, write: boolean): void {
    const current = this.deps.store.get<Actor>(ACTOR, actor.ref);
    if (!current || current.revoked) fail('SCOPE_DENIED', 403);
    if (actor.memberIdentity !== this.deps.member.delegationIdentity()) fail('MEMBER_SESSION_CHANGED', 409);
    if (write && actor.expiresAt <= Date.now()) fail('GRANT_EXPIRED', 409);
  }

  private async current(ref: string, write: boolean): Promise<{ actor: Actor; token: string }> {
    const actor = this.deps.store.get<Actor>(ACTOR, ref);
    if (!actor) fail('NOT_FOUND', 404);
    this.check(actor, write);
    const token = unseal(actor.sourceEnvelope, this.deps.storeKey(), PURPOSE);
    this.verifySourceDevice(actor, await this.deps.auth.authenticate(token));
    this.check(actor, write);
    return { actor, token };
  }

  private verifySourceDevice(actor: Actor, device: Awaited<ReturnType<GatewayAuth['authenticate']>>): void {
    if (device.id !== actor.sourceDeviceId || device.revision !== actor.sourceDeviceRevision
      || !device.actions?.includes('HANDOFF')) fail('GRANT_REVISION_CONFLICT', 409);
  }

  async rpc(token: string | undefined, input: unknown): Promise<JsonObject> {
    if (!token?.startsWith('xhw-')) fail('ACCESS_UNAUTHORIZED', 401);
    const key = fingerprint(token);
    const actor = this.deps.store.list<Actor>(ACTOR).find(entry => constantEqual(entry.tokenHash, key));
    if (!actor?.actionId) fail('ACCESS_UNAUTHORIZED', 401);
    const { operation, arguments: arg, version } = exact(input, ['version', 'operation', 'arguments']);
    if (version !== 1 || typeof operation !== 'string' || !TYPES.includes(operation)) fail('INVALID_REQUEST', 400);
    if (this.active.has(actor.ref)) fail('BUSY', 409);
    const args = exact(arg, operation === 'confirm' ? ['expectedMaterialRevision', 'expectedMaterialDigest'] : []);
    if (operation === 'confirm' && (typeof args.expectedMaterialRevision !== 'number' || !Number.isSafeInteger(args.expectedMaterialRevision)
      || args.expectedMaterialRevision < 1 || typeof args.expectedMaterialDigest !== 'string'
      || !/^[a-f0-9]{64}$/.test(args.expectedMaterialDigest))) fail('INVALID_REQUEST', 400);
    this.active.add(actor.ref);
    try {
      await this.current(actor.ref, operation !== 'status');
      let result: JsonObject;
      if (operation === 'status') result = this.statusView(actor, await this.actions.status(actor.actionId));
      else if (operation === 'prepare') result = publicStatus(await this.actions.prepare(actor.actionId));
      else if (operation === 'confirm') result = publicStatus(await this.actions.confirm(actor.actionId, args));
      else result = await this.advance(actor, actor.actionId);
      await this.current(actor.ref, false);
      return { version: 1, ok: true, result };
    } catch (error) {
      return { version: 1, ok: false, error: errorBody(error) };
    } finally { this.active.delete(actor.ref); }
  }

  private async advance(actor: Actor, actionId: string): Promise<JsonObject> {
    const status = await this.actions.status(actionId);
    if (status.phase === 'TAKEN_OVER') return this.publishSuccessor(actor, status);
    if (['FAILED', 'CANCELLED'].includes(String(status.phase))) return publicStatus(status);
    if (status.phase !== 'TARGET_STARTING' || !actor.target) return publicStatus(await this.actions.advance(actionId, {}));
    const peer = actor.target;
    const { token } = await this.current(actor.ref, true);
    const transfer = await advancePeerImport({ handoffId: text(status, 'handoffId'),
      requestKey: actor.sourceRequestKey, sourceHostRef: this.deps.hostRef,
      sourceGet: async (tail, query) => {
        await this.current(actor.ref, true);
        return payload(await this.deps.handoffs.remote(token, 'GET', tail, null, null, query ?? null));
      },
      targetCall: async (method, tail, body, key) => {
        await this.current(actor.ref, true);
        return payload(await pinnedCall(peer, unseal(peer.deviceEnvelope, this.deps.storeKey(), PURPOSE),
          method, tail, body, key, () => this.check(actor, true)));
      },
    });
    if (!transfer.importBinding?.consumptionReport) return publicStatus(status, { state: transfer.state });
    if (actor.successor) {
      const { actor: current } = await this.current(actor.ref, true);
      this.deps.store.put(ACTOR, actor.ref, { ...current, report: transfer.importBinding.consumptionReport });
    }
    return this.publishSuccessor(actor, await this.actions.advance(actionId, { importBinding: transfer.importBinding }));
  }

  private statusView(actor: Actor, status: JsonObject): JsonObject {
    const current = this.deps.store.get<Actor>(ACTOR, actor.ref);
    return { ...publicStatus(status), ...(status.phase === 'TAKEN_OVER' && current?.successor
      ? { successorState: current.successorRecorded ? 'RECORDED' : 'PENDING' } : {}) };
  }

  private async publishSuccessor(actor: Actor, status: JsonObject): Promise<JsonObject> {
    const { actor: current } = await this.current(actor.ref, true);
    if (status.phase === 'TAKEN_OVER' && current.successor && !current.successorRecorded && current.report
      && status.handoffId === current.report.handoffId && status.targetTaskRef === current.report.targetTaskRef) {
      const { delegationRef, ...binding } = current.successor;
      try {
        await this.deps.member.delegationRequest('POST', `/delegations/${delegationRef}/handoffs`, {
          ...binding, materialDigest: text(status, 'materialDigest'), report: current.report,
        });
        const verified = await this.current(actor.ref, false);
        this.deps.store.put(ACTOR, actor.ref, { ...verified.actor, successorRecorded: true });
      } catch { /* The next explicit advance reconciles the same verified report. */ }
    }
    return this.statusView(actor, status);
  }
}

function pinnedCall(peer: TargetPeer, token: string, method: 'GET' | 'POST', tail: string[], body: unknown,
  key: string | undefined, guard: () => void): Promise<LocalTaskResult> {
  const hostProbe = method === 'GET' && tail.length === 1 && tail[0] === 'host';
  if (!hostProbe && (!tail.every(part => identifier.test(part)) || tail[0] !== 'imports')) fail('INVALID_REQUEST', 400);
  return new Promise((resolve, reject) => {
    const origin = new URL(peer.origin);
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const req = request({ protocol: 'https:', hostname: origin.hostname.replace(/^\[|\]$/g, ''),
      port: origin.port || 443, path: hostProbe ? '/personal/v1/host' : `${PATH}/${tail.join('/')}`,
      method, agent: false, rejectUnauthorized: false,
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json',
        ...(key === undefined ? {} : { 'Idempotency-Key': key }),
        ...(payload === undefined ? {} : { 'Content-Type': 'application/json', 'Content-Length': payload.length }) },
    });
    const timer = setTimeout(() => req.destroy(new XagtError('HANDOFF_PEER_TIMEOUT',
      '目标 Link 回执未返回，可继续核对原导入。', true, 503)), tail.at(-1) === 'start' ? 50_000 : 9_000);
    req.on('error', error => { clearTimeout(timer); reject(error); });
    req.on('socket', socket => (socket as TLSSocket).once('secureConnect', () => {
      try {
        const raw = (socket as TLSSocket).getPeerCertificate().raw;
        if (!raw || createHash('sha256').update(raw).digest('hex') !== peer.certSha256) fail('PEER_TLS_MISMATCH', 502);
        guard();
        req.end(payload);
      } catch (error) { req.destroy(error instanceof Error ? error : undefined); }
    }));
    req.on('response', response => {
      const received: Buffer[] = [];
      let length = 0;
      response.on('data', (chunk: Buffer) => {
        length += chunk.length;
        if (length > 256 * 1024) req.destroy(new Error('target reply too large'));
        else received.push(chunk);
      });
      response.on('error', error => { clearTimeout(timer); reject(error); });
      response.on('end', () => {
        clearTimeout(timer);
        try {
          guard();
          resolve({ status: response.statusCode ?? 502, body: JSON.parse(Buffer.concat(received).toString('utf8')) });
        } catch (error) { reject(error); }
      });
    });
  });
}
