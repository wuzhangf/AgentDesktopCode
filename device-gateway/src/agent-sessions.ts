/**
 * AgentSessionAccess — node:typescript port of Java PersonalAgentSessionAccess.
 *
 * Durable device-namespaced ledgers backing the phone-initiated ACS session
 * surface: session create, auxiliary-turn deliver, and project material
 * uploads. Every admitted request is stored under kind 'session-create' /
 * 'acs-aux-deliver' / 'acs-material' BEFORE the upstream dispatch, frozen wire
 * and all, so a lost reply is recovered through the original namespaced key —
 * never by substituting a new one. A source-reported status never elevates the
 * PAC view.
 *
 * Upstream seam: the adapter supplies the fixed loopback ACS call resolved per
 * device (Java Upstream.call/callBytes — binding() resolved inside).
 */
import {
  exact,
  fail,
  GatewayError,
  hash,
  hashBytes,
  id,
  isRecord,
  text,
} from './protocol.js';
import type { Device } from './protocol.js';
import type {
  GatewayAuth,
  GatewayStoreView,
  JsonObject,
  MaybePromise,
} from './context.js';

// ---------------------------------------------------------------------------
// Upstream seam + reply/result shapes (Java Upstream/Reply/Result).
// ---------------------------------------------------------------------------

export interface AgentUpstreamReply {
  status: number;
  body: unknown;
}

export interface AgentUpstream {
  call(device: Device, method: string, path: string, body: unknown, key: string | undefined): MaybePromise<AgentUpstreamReply>;
  /** Raw-byte channel for upstream routes whose contract is non-JSON —
   *  material chunk PUTs carry raw bytes plus a ?digest= query, never the
   *  JSON relay shape the device sends to PAC. */
  callBytes(device: Device, method: string, path: string, body: Uint8Array, key: string | undefined): MaybePromise<AgentUpstreamReply>;
}

export interface AgentResult {
  status: number;
  body: unknown;
}

/** Durable request record; the audit projection never stores message bodies. */
interface AgentRequestRecord {
  deviceId: string;
  clientKey: string;
  sourceKey?: string;
  operation?: string;
  sessionId?: string;
  auxSessionId?: string;
  turnId?: string;
  runId?: string;
  boundaryRequestId?: string;
  answerDigest?: string;
  hash?: string;
  state?: string; // SAVED | DISPATCHED | OBSERVED | REJECTED | UNKNOWN | ACCEPTED_OWNER_ONLY
  code?: string;
  /** Material-upload binding: owning project, upload key and upstream tail. */
  projectId?: string;
  uploadKey?: string;
  route?: string;
  routeMethod?: string;
  grantRevision: number;
  /** Local ledger fact: when this record first reached DISPATCHED. 0 = legacy. */
  dispatchedAt?: number;
  wire?: JsonObject;
  result?: unknown;
}

const CREATE_KIND = 'session-create';
const DELIVER_KIND = 'acs-aux-deliver';
const MATERIAL_KIND = 'acs-material';

const MATERIAL_MEDIA = new Set(['image/png', 'image/jpeg', 'text/plain', 'text/markdown', 'application/json']);

const asObj = (v: unknown): JsonObject => (isRecord(v) ? v : {});
const asText = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback);
const asLong = (v: unknown, fallback = 0): number => (typeof v === 'number' ? v : fallback);
const asBool = (v: unknown): boolean => v === true;

/** Java digest(body) — sha256 of the JSON serialization. */
const digest = (body: unknown): string => hash(JSON.stringify(body ?? null));

/**
 * Java PersonalAgentSessionAccess. Store-kind ledgers are device-namespaced;
 * the namespaced sourceKey makes replays idempotent upstream.
 */
export class AgentSessionAccess {
  private readonly flights = new Set<string>();

  constructor(
    private readonly store: GatewayStoreView,
    private readonly auth: GatewayAuth,
    private readonly upstream: AgentUpstream,
    /** Java namespace = ownerStatus().personalHostId. */
    private readonly namespace: string,
  ) {}

  private sourceKey(did: string, clientKey: string): string {
    return `mobile-${hash(`${this.namespace}:${did}:${clientKey}`)}`;
  }

  private recordKey(did: string, key: string): string {
    return `${did}:${key}`;
  }

  private save(kind: string, request: AgentRequestRecord): void {
    this.store.transaction(() => {
      this.store.put(kind, this.recordKey(request.deviceId, request.clientKey), request);
    });
  }

  private find(kind: string, did: string, key: string): AgentRequestRecord | undefined {
    return this.store.transaction(() =>
      this.store.get<AgentRequestRecord>(kind, this.recordKey(did, key)));
  }

  private historyLimit(kind: string, did: string): void {
    const count = this.store.transaction(() =>
      this.store.list<AgentRequestRecord>(kind).filter((item) => item.deviceId === did).length);
    if (count >= 128) fail('AGENT_REQUEST_HISTORY_LIMIT', 429);
  }

  // ---- POST /personal/v1/agent/sessions ----

  /**
   * CREATE-grant session creation. The client allowlist is strict; the server
   * injects origin from the authenticated device and never accepts a
   * client-supplied origin field. The same Idempotency-Key (namespaced) is
   * forwarded upstream, whose durable createOperation ledger guarantees the
   * replay returns the same session.
   */
  async createSession(token: string, body: unknown, key: string): Promise<AgentResult> {
    const b = exact(body, 'requestKey', 'title', 'agentProfileId', 'intent', 'interactionMode',
      'modelSettings', 'directories', 'workspaceAlias');
    id(key);
    if (key !== text(b, 'requestKey')) fail('IDEMPOTENCY_KEY_MISMATCH', 400);
    if ('title' in b) text(b, 'title');
    for (const field of ['agentProfileId', 'intent', 'interactionMode', 'workspaceAlias']) {
      if (field in b && b[field] !== null) text(b, field);
    }
    if ('modelSettings' in b && !isRecord(b.modelSettings)) fail('INVALID_REQUEST', 400);
    if ('directories' in b && !Array.isArray(b.directories)) fail('INVALID_REQUEST', 400);

    let device = await this.auth.authenticate(token);
    if (!(device.actions ?? []).includes('CREATE')) fail('DEVICE_SCOPE_DENIED', 403);

    const origin: JsonObject = {
      clientType: 'MOBILE',
      appDisplayName: 'personal-agent-access/1',
      actorDisplayName: device.label,
      deviceDisplayName: device.label,
      recordedAt: Date.now(),
    };
    const wire: JsonObject = { schemaVersion: 'business-session/2.0' };
    for (const field of ['title', 'workspaceAlias', 'interactionMode', 'intent', 'agentProfileId', 'modelSettings', 'directories']) {
      if (field in b) wire[field] = b[field];
    }
    wire.origin = origin;
    // Idempotency binds the client payload, not the server-injected origin
    // timestamp; the frozen wire (including origin) is stored on the record.
    const fingerprint = `${digest(b)}:${key}`;

    let request: AgentRequestRecord;
    let recover = false;
    device = await this.auth.authenticate(token);
    if (!(device.actions ?? []).includes('CREATE')) fail('DEVICE_SCOPE_DENIED', 403);
    const found = this.find(CREATE_KIND, device.id, key);
    if (found !== undefined) {
      if (found.hash !== fingerprint) fail('IDEMPOTENCY_PAYLOAD_MISMATCH', 409);
      request = found;
      recover = true;
    } else if (this.find(DELIVER_KIND, device.id, key) !== undefined
        || this.find(MATERIAL_KIND, device.id, key) !== undefined) {
      fail('IDEMPOTENCY_PAYLOAD_MISMATCH', 409);
    } else {
      this.historyLimit(CREATE_KIND, device.id);
      request = {
        deviceId: device.id, clientKey: key,
        sourceKey: this.sourceKey(device.id, key),
        operation: 'SESSION_CREATE',
        hash: fingerprint, grantRevision: device.revision,
        wire, state: 'SAVED',
      };
      this.save(CREATE_KIND, request);
      recover = false;
    }
    if (!recover) {
      if (device.revision !== request!.grantRevision) fail('GRANT_REVISION_CONFLICT', 409);
      request!.state = 'DISPATCHED';
      request!.dispatchedAt = Date.now();
      this.save(CREATE_KIND, request!);
      this.flights.add(`create:${this.recordKey(device.id, key)}`);
    }
    if (recover) return this.sessionRequest(token, key);
    try {
      const reply = await this.upstream.call(device, 'POST', '/api/v2/sessions', request!.wire, request!.sourceKey);
      await this.acceptCreate(request!, reply);
    } catch (error) {
      if (error instanceof GatewayError && !isTransport(error)) {
        request!.code = error.code;
        request!.state = request!.sessionId !== undefined ? 'ACCEPTED_OWNER_ONLY' : 'UNKNOWN';
        this.save(CREATE_KIND, request!);
        if (request!.sessionId !== undefined || error.httpStatus === 401) throw error;
      } else {
        request!.state = 'UNKNOWN';
        request!.code = 'LOCAL_REPLY_UNCONFIRMED';
        this.save(CREATE_KIND, request!);
      }
    } finally {
      this.flights.delete(`create:${this.recordKey(request!.deviceId, request!.clientKey)}`);
    }
    return this.createView(token, request!);
  }

  /** Bind the returned session to the device resource scope; a reply that does
   *  not carry the exact new session never becomes visible to the device. */
  private async acceptCreate(r: AgentRequestRecord, reply: AgentUpstreamReply): Promise<void> {
    if (reply.status < 200 || reply.status >= 300) {
      r.code = reply.body == null ? 'LOCAL_SOURCE_UNAVAILABLE' : asText(asObj(reply.body).code, 'LOCAL_SOURCE_UNAVAILABLE');
      r.state = [400, 403, 409, 422, 428].includes(reply.status) ? 'REJECTED' : 'UNKNOWN';
      this.save(CREATE_KIND, r);
      return;
    }
    if (!isRecord(reply.body)) fail('LOCAL_REPLY_INVALID', 502);
    const session = asText(reply.body.sessionId);
    id(session);
    r.sessionId = session;
    r.result = reply.body;
    r.state = 'ACCEPTED_OWNER_ONLY';
    this.save(CREATE_KIND, r);
    await this.auth.appendCreatedSession(r.deviceId, r.grantRevision, session);
    r.state = 'OBSERVED';
    r.code = undefined;
    this.save(CREATE_KIND, r);
  }

  private async createView(token: string, r: AgentRequestRecord): Promise<AgentResult> {
    if (r.sessionId !== undefined) await this.auth.authorize(token, r.sessionId, 'OBSERVE');
    else {
      const d = await this.auth.authenticate(token);
      if (!(d.actions ?? []).includes('CREATE')) fail('DEVICE_SCOPE_DENIED', 403);
    }
    return { status: 200, body: requestView(r) };
  }

  // ---- GET /personal/v1/agent/session-requests/{key} ----

  /** Receipt lookup for create/deliver/material ledgers. A 404 never implies a
   *  new key may be safely submitted; it only means this device never admitted
   *  one. */
  async sessionRequest(token: string, key: string): Promise<AgentResult> {
    const device = await this.auth.authenticate(token);
    let r = this.find(CREATE_KIND, device.id, key);
    let kind = CREATE_KIND;
    if (r === undefined) { kind = DELIVER_KIND; r = this.find(DELIVER_KIND, device.id, key); }
    if (r === undefined) { kind = MATERIAL_KIND; r = this.find(MATERIAL_KIND, device.id, key); }
    if (r === undefined) fail('NOT_FOUND', 404);
    if (!this.flights.add(`request:${this.recordKey(device.id, key)}`)) {
      return { status: 200, body: requestView(r) };
    }
    try {
      if (kind === CREATE_KIND) await this.recoverCreate(token, r);
      else if (kind === MATERIAL_KIND) await this.recoverMaterial(token, r);
      else await this.recoverDeliver(token, r);
      return { status: 200, body: requestView(r) };
    } finally {
      this.flights.delete(`request:${this.recordKey(device.id, key)}`);
    }
  }

  /**
   * Lost-create recovery replays the identical frozen wire under the original
   * namespaced key. The upstream createOperation ledger makes the replay
   * return the same session row instead of creating a second one; a durable
   * upstream refusal is never redispatched.
   */
  private async recoverCreate(token: string, r: AgentRequestRecord): Promise<void> {
    if (r.sessionId !== undefined) {
      if (r.state === 'ACCEPTED_OWNER_ONLY') {
        try {
          await this.auth.appendCreatedSession(r.deviceId, r.grantRevision, r.sessionId);
          r.state = 'OBSERVED';
          r.code = undefined;
          this.save(CREATE_KIND, r);
        } catch (error) {
          if (!(error instanceof GatewayError)) throw error;
          // Grant revision changed; stay recoverable.
        }
      }
      return;
    }
    if (r.state === 'REJECTED') return;
    await this.auth.authenticate(token);
    const device = await this.auth.authenticate(token);
    try {
      const reply = await this.upstream.call(device, 'POST', '/api/v2/sessions', r.wire, r.sourceKey);
      await this.acceptCreate(r, reply);
    } catch (error) {
      if (error instanceof GatewayError) {
        r.code = isTransport(error) ? 'LOCAL_REPLY_UNCONFIRMED' : error.code;
        this.save(CREATE_KIND, r);
        if (!isTransport(error) && error.httpStatus === 401) throw error;
      } else {
        r.code = 'LOCAL_REPLY_UNCONFIRMED';
        this.save(CREATE_KIND, r);
      }
    }
  }

  // ---- POST /personal/v1/agent/sessions/{aux}/auxiliary-turns/{tid}/deliver ----

  /**
   * One-shot auxiliary-answer delivery into the parent session's active run as
   * a CONTEXT_ADVICE boundary input. The auxiliary session must resolve back
   * to a device-authorized parent, the turn must be terminal SUCCEEDED, and
   * the delivery binds the exact answer digest. Parent admission follows the
   * actual source state; a missing run or a stale epoch is a truthful 409.
   */
  async deliver(token: string, auxSessionId: string, turnId: string, body: unknown, key: string): Promise<AgentResult> {
    const b = exact(body, 'requestKey', 'expectedAnswerRevision');
    id(key); id(auxSessionId); id(turnId);
    if (key !== text(b, 'requestKey')) fail('IDEMPOTENCY_KEY_MISMATCH', 400);
    const expectedDigest = 'expectedAnswerRevision' in b && b.expectedAnswerRevision !== null
      ? text(b, 'expectedAnswerRevision') : null;

    let device = await this.auth.authenticate(token);
    // Ownership resolution: aux -> parent must be an authorized device session.
    const aux = await this.upstream.call(device, 'GET', `/api/v2/sessions/${auxSessionId}`, undefined, undefined);
    if (aux.status === 404) fail('DEVICE_SCOPE_DENIED', 403);
    if (aux.status !== 200) fail('UPSTREAM_UNAVAILABLE', 503);
    const auxValue = asObj(aux.body);
    const purpose = asText(auxValue.sessionPurpose);
    if (auxValue.sessionId !== auxSessionId || purpose !== 'AUXILIARY_READ_ONLY') {
      fail('DEVICE_SCOPE_DENIED', 403);
    }
    const parent = asText(auxValue.parentSessionId);
    id(parent);
    await this.auth.authorize(token, parent, 'INTERACT');
    if (device.revision !== (await this.auth.authenticate(token)).revision) {
      fail('GRANT_REVISION_CONFLICT', 409);
    }

    // Turn must be terminal SUCCEEDED inside this aux session; answer binds by digest.
    const turn = await this.upstream.call(device, 'GET', `/api/v2/sessions/${auxSessionId}/auxiliary-turns/${turnId}`, undefined, undefined);
    if (turn.status === 404) fail('AUXILIARY_TURN_NOT_FOUND', 404);
    if (turn.status !== 200) fail('UPSTREAM_UNAVAILABLE', 503);
    const turnValue = asObj(turn.body);
    if (turnValue.turnId !== turnId || turnValue.sessionId !== auxSessionId
        || turnValue.parentSessionId !== parent) {
      fail('LOCAL_BINDING_MISMATCH', 409);
    }
    if (asText(turnValue.state) !== 'SUCCEEDED') fail('AUXILIARY_ANSWER_NOT_TERMINAL', 409);
    const answer = typeof turnValue.answer === 'string' ? turnValue.answer : null;
    if (answer === null || answer.trim() === '') fail('AUXILIARY_ANSWER_NOT_TERMINAL', 409);
    if (Buffer.from(answer, 'utf8').length > 8192) fail('AUXILIARY_ANSWER_TOO_LARGE', 422);
    const answerDigest = hash(answer);
    if (expectedDigest !== null && expectedDigest !== answerDigest) fail('AUXILIARY_ANSWER_CHANGED', 409);

    // Parent admission follows actual source state.
    const parentSession = await this.upstream.call(device, 'GET', `/api/v2/sessions/${parent}`, undefined, undefined);
    if (parentSession.status !== 200 || parentSession.body == null) fail('UPSTREAM_UNAVAILABLE', 503);
    const runId = asText(asObj(parentSession.body).activeRunId);
    if (runId === '') fail('AUX_DELIVERY_UNAVAILABLE', 409);
    id(runId);
    const run = await this.upstream.call(device, 'GET', `/api/v2/runs/${runId}`, undefined, undefined);
    if (run.status !== 200 || run.body == null || asObj(run.body).sessionId !== parent) {
      fail('AUX_DELIVERY_UNAVAILABLE', 409);
    }
    const segments = await this.upstream.call(device, 'GET', `/api/v2/runs/${runId}/execution-segments`, undefined, undefined);
    if (segments.status !== 200 || segments.body == null) fail('AUX_DELIVERY_UNAVAILABLE', 409);
    // The current assignment's epoch is the only value checkCurrent accepts.
    const segmentsBody = asObj(segments.body);
    let epoch = asText(asObj(segmentsBody.current).executionEpoch);
    if (epoch === '') {
      for (const item of (Array.isArray(segmentsBody.items) ? segmentsBody.items : [])) {
        const candidate = asObj(item).executionEpoch;
        if (typeof candidate === 'string') epoch = candidate;
      }
    }
    if (!/^[0-9]+$/.test(epoch)) fail('AUX_DELIVERY_UNAVAILABLE', 409);

    const wire: JsonObject = {
      schemaVersion: 'run-boundary-request/1',
      kind: 'CONTEXT_ADVICE',
      expectedExecutionEpoch: epoch,
      text: answer,
      sourceRefs: [`auxiliary-turn:${auxSessionId}/${turnId}`],
    };

    const fingerprint = `${digest(wire)}:${auxSessionId}:${turnId}:${key}`;
    let request: AgentRequestRecord;
    let fresh = false;
    device = await this.auth.authorize(token, parent, 'INTERACT');
    const found = this.find(DELIVER_KIND, device.id, key);
    if (found !== undefined) {
      if (found.hash !== fingerprint) fail('IDEMPOTENCY_PAYLOAD_MISMATCH', 409);
      request = found;
    } else if (this.find(CREATE_KIND, device.id, key) !== undefined
        || this.find(MATERIAL_KIND, device.id, key) !== undefined) {
      fail('IDEMPOTENCY_PAYLOAD_MISMATCH', 409);
    } else {
      this.historyLimit(DELIVER_KIND, device.id);
      request = {
        deviceId: device.id, clientKey: key,
        sourceKey: this.sourceKey(device.id, key),
        operation: 'AUX_DELIVER',
        sessionId: parent, auxSessionId, turnId, runId,
        answerDigest,
        hash: fingerprint, grantRevision: device.revision,
        wire: { ...wire, requestId: this.sourceKey(device.id, key) },
        state: 'DISPATCHED', dispatchedAt: Date.now(),
      };
      this.save(DELIVER_KIND, request);
      this.flights.add(`deliver:${this.recordKey(device.id, key)}`);
      fresh = true;
    }
    if (!fresh) return this.sessionRequest(token, key);
    try {
      const reply = await this.upstream.call(device, 'POST',
        `/api/v2/runs/${request!.runId}/boundary-requests`, request!.wire, request!.sourceKey);
      this.acceptDeliver(request!, reply);
    } catch (error) {
      request!.state = 'UNKNOWN';
      request!.code = error instanceof GatewayError && !isTransport(error) ? error.code : 'LOCAL_REPLY_UNCONFIRMED';
      this.save(DELIVER_KIND, request!);
    } finally {
      this.flights.delete(`deliver:${this.recordKey(request!.deviceId, request!.clientKey)}`);
    }
    return { status: 200, body: requestView(request!) };
  }

  private acceptDeliver(r: AgentRequestRecord, reply: AgentUpstreamReply): void {
    if (reply.status >= 200 && reply.status < 300) {
      const body = asObj(reply.body);
      if (body.requestId !== r.sourceKey || body.runId !== r.runId) {
        fail('LOCAL_BINDING_MISMATCH', 409);
      }
      r.boundaryRequestId = asText(body.requestId);
      r.result = reply.body;
      r.state = 'OBSERVED';
      r.code = undefined;
    } else {
      r.state = [400, 403, 409, 422, 428].includes(reply.status) ? 'REJECTED' : 'UNKNOWN';
      r.code = reply.body == null ? 'LOCAL_REPLY_UNCONFIRMED' : asText(asObj(reply.body).code, 'LOCAL_REPLY_UNCONFIRMED');
    }
    this.save(DELIVER_KIND, r);
  }

  /** Deliver recovery: the upstream boundary-request id IS the original
   *  namespaced key, so the receipt is queried in place; a durable 404 after
   *  a prior dispatch redispatches the identical wire (upstream replay keeps
   *  it once-only). */
  private async recoverDeliver(token: string, r: AgentRequestRecord): Promise<void> {
    await this.auth.authorize(token, r.sessionId!, 'INTERACT');
    if (r.state === 'REJECTED') return;
    const device = await this.auth.authenticate(token);
    try {
      const found = await this.upstream.call(device, 'GET',
        `/api/v2/runs/${r.runId}/boundary-requests/${r.sourceKey}`, undefined, undefined);
      if (found.status === 200) {
        this.acceptDeliver(r, found);
      } else if (found.status === 404) {
        const replay = await this.upstream.call(device, 'POST',
          `/api/v2/runs/${r.runId}/boundary-requests`, r.wire, r.sourceKey);
        this.acceptDeliver(r, replay);
      } else {
        r.code = found.body == null ? 'LOCAL_REPLY_UNCONFIRMED' : asText(asObj(found.body).code, 'LOCAL_REPLY_UNCONFIRMED');
      }
    } catch (error) {
      // Java catches only IOException here — a business refusal propagates.
      if (error instanceof GatewayError && !isTransport(error)) throw error;
      r.code = 'LOCAL_REPLY_UNCONFIRMED';
    }
    this.save(DELIVER_KIND, r);
    await this.auth.authorize(token, r.sessionId!, 'INTERACT');
  }

  // ---- /personal/v1/agent/projects/{project}/material-uploads family ----

  /** Resolve the upload/create target to an authorized device session (or a
   *  CREATE grant for createKey). Returns the bound session id or null. */
  private async materialAuthority(token: string, target: unknown, action: string): Promise<string | null> {
    if (!isRecord(target)) fail('INVALID_REQUEST', 400);
    const bound = target.taskId != null ? text(target, 'taskId')
      : target.sessionId != null ? text(target, 'sessionId') : null;
    if (bound !== null) { id(bound); await this.auth.authorize(token, bound, action); return bound; }
    if (target.createKey != null) {
      id(text(target, 'createKey'));
      const d = await this.auth.authenticate(token);
      if (!(d.actions ?? []).includes('CREATE')) fail('DEVICE_SCOPE_DENIED', 403);
      return null;
    }
    fail('LOCAL_BINDING_MISMATCH', 409);
  }

  private async fetchUpload(token: string, project: string, uploadKey: string): Promise<JsonObject> {
    const device = await this.auth.authenticate(token);
    const reply = await this.upstream.call(device, 'GET', `/api/v2/projects/${project}/material-uploads/${uploadKey}`, undefined, undefined);
    if (reply.status === 404) fail('NOT_FOUND', 404);
    if (reply.status < 200 || reply.status >= 300 || !isRecord(reply.body)) {
      fail('UPSTREAM_UNAVAILABLE', 503);
    }
    if (asText(reply.body.uploadKey, uploadKey) !== uploadKey) fail('LOCAL_BINDING_MISMATCH', 409);
    return reply.body;
  }

  private materialCreateFields(body: JsonObject): void {
    const target = body.target;
    if (!isRecord(target)) fail('INVALID_REQUEST', 400);
    exact(target, 'taskId', 'sessionId', 'createKey');
    if (Object.keys(target).length !== 1) fail('INVALID_REQUEST', 400);
    const name = text(body, 'displayName');
    if (!/^[A-Za-z0-9][A-Za-z0-9._ -]{0,119}$/.test(name) || name.includes('..')) fail('INVALID_REQUEST', 400);
    const media = text(body, 'mediaType');
    if (!MATERIAL_MEDIA.has(media)) fail('MATERIAL_MEDIA_UNSUPPORTED', 422);
    const size = body.sizeBytes;
    if (typeof size !== 'number' || !Number.isInteger(size) || size <= 0
        || size > (media.startsWith('image/') ? 5_242_880 : 1_048_576)) {
      fail('MATERIAL_SIZE_EXCEEDED', 422);
    }
    if (!/^[a-f0-9]{64}$/.test(text(body, 'sha256'))) fail('INVALID_REQUEST', 400);
  }

  private materialChunkFields(body: JsonObject): void {
    const chunkDigest = text(body, 'chunkDigest');
    if (!/^[a-f0-9]{64}$/.test(chunkDigest)) fail('INVALID_REQUEST', 400);
    let bytes: Buffer;
    try { bytes = Buffer.from(text(body, 'dataBase64'), 'base64'); }
    catch { fail('INVALID_REQUEST', 400); }
    if (bytes!.length === 0 || bytes!.length > 262_144) fail('MATERIAL_CHUNK_TOO_LARGE', 422);
    if (hashBytes(new Uint8Array(bytes!)) !== chunkDigest) fail('MATERIAL_CHUNK_DIGEST_MISMATCH', 409);
  }

  /** ACS project material profile: same shape as native, forwarded to
   *  /api/v2/projects/{project}/material-uploads. An absent upstream route is
   *  passed through honestly as UNKNOWN + source code; never fabricated. */
  async materialUpload(
    token: string, project: string, tail: string[], method: string,
    body: unknown, key: string | null,
  ): Promise<AgentResult> {
    if (['POST', 'PUT'].includes(method) && !isRecord(body)) fail('INVALID_REQUEST', 400);
    const tailPath = tail.length === 0 ? '' : `/${tail.join('/')}`;
    const route = `/api/v2/projects/${project}/material-uploads${tailPath}`;
    if (method === 'POST' && tail.length === 0) {
      this.materialCreateFields(asObj(body));
      const bound = await this.materialAuthority(token, asObj(body).target, 'INTERACT');
      return this.ledgerMaterial(token, project, null, 'MATERIAL_UPLOAD_CREATE', 'POST', route,
        asObj(body), key!, ['requestKey', 'target', 'displayName', 'mediaType', 'sizeBytes', 'sha256'],
        bound, undefined, true);
    }
    if (method === 'GET' && tail.length === 1) {
      const upload = await this.fetchUpload(token, project, tail[0]!);
      await this.materialAuthority(token, upload.target, 'OBSERVE');
      return { status: 200, body: uploadView(upload) };
    }
    if (method === 'PUT' && tail.length === 3 && tail[1] === 'chunks') {
      if (!/^[0-9]+$/.test(tail[2]!)) fail('INVALID_REQUEST', 400);
      this.materialChunkFields(asObj(body));
      const upload = await this.fetchUpload(token, project, tail[0]!);
      const bound = await this.materialAuthority(token, upload.target, 'INTERACT');
      return this.ledgerMaterial(token, project, tail[0]!, 'MATERIAL_UPLOAD_CHUNK', 'PUT', route,
        asObj(body), key!, ['requestKey', 'chunkDigest', 'dataBase64'], bound,
        async () => { await this.materialAuthority(token, (await this.fetchUpload(token, project, tail[0]!)).target, 'INTERACT'); }, true);
    }
    if (method === 'POST' && tail.length === 2 && tail[1] === 'seal') {
      if (!/^[a-f0-9]{64}$/.test(text(asObj(body), 'sha256'))) fail('INVALID_REQUEST', 400);
      const upload = await this.fetchUpload(token, project, tail[0]!);
      const bound = await this.materialAuthority(token, upload.target, 'INTERACT');
      return this.ledgerMaterial(token, project, tail[0]!, 'MATERIAL_UPLOAD_SEAL', 'POST', route,
        asObj(body), key!, ['requestKey', 'sha256'], bound,
        async () => { await this.materialAuthority(token, (await this.fetchUpload(token, project, tail[0]!)).target, 'INTERACT'); }, true);
    }
    if (method === 'DELETE' && tail.length === 1) {
      id(key!);
      const upload = await this.fetchUpload(token, project, tail[0]!);
      const bound = await this.materialAuthority(token, upload.target, 'INTERACT');
      return this.ledgerMaterial(token, project, tail[0]!, 'MATERIAL_UPLOAD_CANCEL', 'DELETE', route,
        { requestKey: key! }, key!, ['requestKey'], bound,
        async () => { await this.materialAuthority(token, (await this.fetchUpload(token, project, tail[0]!)).target, 'INTERACT'); }, false);
    }
    fail('OPERATION_NOT_ALLOWED', 403);
  }

  /** Durable acs-material ledger; replays the identical wire under the
   *  original namespaced key via session-requests recovery. */
  private async ledgerMaterial(
    token: string, project: string, uploadKey: string | null, operation: string,
    httpMethod: string, route: string, body: JsonObject, key: string, whitelist: string[],
    boundSession: string | null, binding: (() => Promise<void>) | undefined, wireBody: boolean,
  ): Promise<AgentResult> {
    exact(body, ...whitelist);
    id(key);
    if (key !== text(body, 'requestKey')) fail('IDEMPOTENCY_KEY_MISMATCH', 400);
    let device = await this.auth.authenticate(token);
    const fingerprint = `${digest(body)}:${operation}${uploadKey === null ? '' : `:${uploadKey}`}`;
    if (this.find(MATERIAL_KIND, device.id, key) === undefined && binding !== undefined) await binding();
    let request: AgentRequestRecord;
    let recover = false;
    device = await this.auth.authenticate(token);
    const found = this.find(MATERIAL_KIND, device.id, key);
    if (found !== undefined) {
      if (found.hash !== fingerprint || found.projectId !== project) {
        fail('IDEMPOTENCY_PAYLOAD_MISMATCH', 409);
      }
      request = found;
      recover = true;
    } else if (this.find(CREATE_KIND, device.id, key) !== undefined
        || this.find(DELIVER_KIND, device.id, key) !== undefined) {
      fail('IDEMPOTENCY_PAYLOAD_MISMATCH', 409);
    } else {
      this.historyLimit(MATERIAL_KIND, device.id);
      request = {
        deviceId: device.id, clientKey: key,
        sourceKey: this.sourceKey(device.id, key),
        operation, sessionId: boundSession ?? undefined,
        projectId: project, uploadKey: uploadKey ?? undefined,
        route, routeMethod: httpMethod,
        hash: fingerprint, grantRevision: device.revision,
        wire: wireBody ? { ...body, requestKey: this.sourceKey(device.id, key) } : undefined,
        state: 'DISPATCHED', dispatchedAt: Date.now(),
      };
      this.save(MATERIAL_KIND, request);
      this.flights.add(`material:${this.recordKey(device.id, key)}`);
      recover = false;
    }
    if (recover) return this.sessionRequest(token, key);
    try {
      const reply = await this.materialDispatch(device, request!);
      this.acceptMaterial(request!, reply);
    } catch (error) {
      request!.state = 'UNKNOWN';
      request!.code = error instanceof GatewayError && !isTransport(error) ? error.code : 'LOCAL_REPLY_UNCONFIRMED';
      this.save(MATERIAL_KIND, request!);
    } finally {
      this.flights.delete(`material:${this.recordKey(request!.deviceId, request!.clientKey)}`);
    }
    const after = await this.auth.authenticate(token);
    if (after.revision !== request!.grantRevision) fail('GRANT_REVISION_CONFLICT', 409);
    return { status: 200, body: requestView(request!) };
  }

  /** Chunk PUTs travel upstream as raw bytes under a ?digest= query — the
   *  JSON relay shape ({dataBase64,chunkDigest}) is PAC-side only. Bytes and
   *  digest are re-derived from the frozen wire, so a replay dispatches
   *  byte-identically to the original dispatch. */
  private async materialDispatch(device: Device, request: AgentRequestRecord): Promise<AgentUpstreamReply> {
    if (request.operation === 'MATERIAL_UPLOAD_CHUNK') {
      let bytes: Buffer;
      try { bytes = Buffer.from(text(request.wire, 'dataBase64'), 'base64'); }
      catch { fail('LOCAL_REQUEST_CORRUPT', 500); }
      return this.upstream.callBytes(device, request.routeMethod!,
        `${request.route}?digest=${text(request.wire, 'chunkDigest')}`, new Uint8Array(bytes!), request.sourceKey);
    }
    return this.upstream.call(device, request.routeMethod!, request.route!, request.wire, request.sourceKey);
  }

  private acceptMaterial(r: AgentRequestRecord, reply: AgentUpstreamReply): void {
    r.result = reply.body;
    r.state = reply.status >= 200 && reply.status < 300 ? 'OBSERVED'
      : [400, 403, 409, 422, 428].includes(reply.status) ? 'REJECTED' : 'UNKNOWN';
    r.code = reply.status >= 400
      ? (reply.body == null ? 'LOCAL_REPLY_UNCONFIRMED' : asText(asObj(reply.body).code, 'LOCAL_REPLY_UNCONFIRMED'))
      : undefined;
  }

  /** Material recovery replays the stored wire verbatim; the upstream ledger
   *  (or an honest 404 while the route is unimplemented) decides the outcome. */
  private async recoverMaterial(token: string, r: AgentRequestRecord): Promise<void> {
    if (r.state === 'REJECTED') return;
    const device = await this.auth.authenticate(token);
    if (device.revision !== r.grantRevision) fail('GRANT_REVISION_CONFLICT', 409);
    if (r.sessionId !== undefined) await this.auth.authorize(token, r.sessionId, 'INTERACT');
    try {
      const reply = await this.materialDispatch(device, r);
      this.acceptMaterial(r, reply);
    } catch (error) {
      r.code = error instanceof GatewayError && !isTransport(error) ? error.code : 'LOCAL_REPLY_UNCONFIRMED';
    }
    this.save(MATERIAL_KIND, r);
    if ((await this.auth.authenticate(token)).revision !== r.grantRevision) fail('GRANT_REVISION_CONFLICT', 409);
  }
}

/** Java BusinessException-vs-IOException split for the dispatch catch:
 *  transport-class codes map to the IOException path (UNKNOWN +
 *  LOCAL_REPLY_UNCONFIRMED), everything else is a business refusal. */
const isTransport = (error: GatewayError): boolean =>
  ['UPSTREAM_UNAVAILABLE', 'UPSTREAM_OUTCOME_UNKNOWN', 'BODY_TOO_LARGE'].includes(error.code);

const requestView = (r: AgentRequestRecord): JsonObject => {
  const out: JsonObject = {
    schemaVersion: 'personal-agent-request/1',
    requestKey: r.clientKey,
    operation: r.operation,
    state: r.state,
    sessionId: r.sessionId ?? null,
  };
  if (r.auxSessionId !== undefined) out.auxiliarySessionId = r.auxSessionId;
  if (r.turnId !== undefined) out.auxiliaryTurnId = r.turnId;
  if (r.runId !== undefined) out.runId = r.runId;
  if (r.boundaryRequestId !== undefined) out.boundaryRequestId = r.boundaryRequestId;
  // Ledger fact only: when PAC first dispatched this request. Legacy records
  // without the stamp omit the field — never inferred.
  if ((r.dispatchedAt ?? 0) > 0) out.dispatchStartedAt = r.dispatchedAt;
  if (r.answerDigest !== undefined) out.answerSha256 = r.answerDigest;
  if (r.projectId !== undefined) out.projectId = r.projectId;
  if (r.uploadKey !== undefined) out.uploadKey = r.uploadKey;
  if (r.code !== undefined) out.code = r.code;
  if (r.result !== undefined && r.result !== null) {
    const source: JsonObject = {};
    const result = asObj(r.result);
    for (const field of ['sessionId', 'title', 'workspaceAlias', 'receiptId', 'createdAt',
      'requestId', 'runId', 'kind', 'state', 'sequence', 'contentHash',
      'uploadKey', 'nextOffset', 'sealedBytes', 'chunkCount', 'materialRef', 'mediaType',
      'sizeBytes', 'expiresAt', 'updatedAt']) {
      if (field in result) source[field] = result[field];
    }
    out.source = source;
  }
  return out;
};

const uploadView = (upload: JsonObject): JsonObject => {
  const out: JsonObject = {};
  for (const field of ['schemaVersion', 'uploadKey', 'target', 'displayName', 'mediaType', 'mediaRole',
    'sizeBytes', 'sha256', 'nextOffset', 'sealedBytes', 'chunkCount', 'state', 'expiresAt',
    'materialRef', 'requestKey', 'createdAt', 'updatedAt', 'reasonCode', 'code']) {
    if (field in upload) out[field] = upload[field];
  }
  return out;
};

export type { AgentRequestRecord };
