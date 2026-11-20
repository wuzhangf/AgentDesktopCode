import { randomUUID } from 'node:crypto';
import { lstatSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { CloudAcs, cloudIdentifier as identifier } from './cloud-acs.js';
import { LocalTaskAccess, type LocalAuthLike, type LocalStoreLike, type LocalTransportLike } from './local-tasks.js';
import { fail, GatewayError, hash, isRecord, permitsLaunch, scopeContains, type Device, type LaunchScope } from './protocol.js';
import type { TaskFileBinding } from './sage-link-files.js';
import type { UpdatePreparation } from './update-preparation.js';
import type { CloudMemberIdentity, LinuxMemberEnrollment } from './linux-member.js';

type Json = Record<string, unknown>;
const root = '/api/daily/v1/member/link/v2';
const kind = 'link.task.launch.v2';
const actionKind = 'link.task.action.v2';
const journal = 'windows-cloud-launch';
const actions = 'windows-cloud-action';
const fileGrantSchema = 'windows-cloud-launch-grant/1';
const time = (value: unknown): number => typeof value === 'string' ? Date.parse(value) : NaN;

interface Session extends CloudMemberIdentity {
  scope: string;
}

interface Grant {
  revision: number;
  scopes: LaunchScope[];
  controls: boolean;
  approvals: boolean;
}

const sessionScope = ({ origin, memberId, workspaceId, instanceId }: CloudMemberIdentity): string =>
  hash(JSON.stringify([origin, memberId, workspaceId, instanceId]));

export function clearCloudOwnerGrant(store: LocalStoreLike, identity: CloudMemberIdentity): void {
  const scope = sessionScope(identity);
  const grant = store.get<Grant>('cloud-owner-grants', scope);
  if (grant?.scopes.length) {
    store.put('cloud-owner-grants', scope, { revision: grant.revision + 1, scopes: [], controls: false, approvals: false });
  }
}

type CloudAction = 'message' | 'stop' | 'approval_response';
type PendingApproval = {
  kind: 'CONFIRM';
  questionId: string;
  fingerprint: string;
  round: number;
  summary: string;
};

interface Action {
  id: string;
  commandId: string;
  scope: string;
  workId: string;
  generation: number;
  kind: CloudAction;
  requestKey: string;
  fingerprint: string;
  outcome?: 'executed' | 'expired' | 'conflict';
  detail?: string;
  closed?: boolean;
}

interface Delivery {
  id: string;
  workId: string;
  generation: number;
  digest: string;
  nativeKey: string;
  scope: string;
  grantRevision: number;
  target: Json;
  phase: 'claimed' | 'submitting' | 'receipt' | 'tracking' | 'result' | 'closed';
  taskId?: string;
  outcome?: 'accepted' | 'not_accepted';
  observedState?: string;
  resultObservedAt?: string;
  activeRunId?: string;
  executionEpoch?: number;
  supportedActions?: string[];
  pendingInputs?: PendingApproval[];
  eventNumber?: number;
  pendingObservation?: Json;
  hasAttachment?: boolean;
  pendingFilePublication?: boolean;
  acs?: {
    content: string;
    create: Json;
    dispatchBefore: number;
    sessionId?: string;
    message?: Json;
    lookupOnly?: boolean;
  };
}

export class WindowsCloudLaunch {
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = true;
  private backoff = 3000;
  private readonly abort = new AbortController();

  constructor(
    private readonly store: LocalStoreLike,
    private readonly localCatalog: LocalTaskAccess | undefined,
    private readonly transport: LocalTransportLike,
    private readonly hostId: string,
    private readonly origin: string,
    private readonly sessionFile: string,
    private readonly grantFile: string,
    private readonly fetcher: typeof fetch = fetch,
    private readonly recoveryOnly = false,
    private readonly updatePreparation?: UpdatePreparation,
    private readonly ownerGrantStorage?: 'store' | 'file',
    private readonly linuxMember?: LinuxMemberEnrollment,
    private readonly acs?: CloudAcs,
    private readonly taskFiles?: TaskFileBinding,
  ) {}

  start(): void {
    this.stopped = false;
    void this.schedule();
  }

  stop(): void {
    this.stopped = true;
    this.abort.abort();
    this.linuxMember?.stop();
    clearTimeout(this.timer);
  }

  private async schedule(): Promise<void> {
    try {
      await this.tick();
      this.backoff = 3000;
    } catch {
      this.backoff = Math.min(60_000, this.backoff * 2);
    } finally {
      if (!this.stopped) this.timer = setTimeout(() => void this.schedule(), this.backoff);
    }
  }

  private windowsLogoutPending(): boolean {
    if (this.ownerGrantStorage !== 'file') return false;
    try {
      lstatSync(this.sessionFile + '.logout');
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code !== 'ENOENT';
    }
  }

  private session(): Session | undefined {
    if (this.linuxMember) {
      const identity = this.linuxMember.current();
      return identity && { ...identity, scope: sessionScope(identity) };
    }
    try {
      if (this.windowsLogoutPending()) return;
      if (this.ownerGrantStorage === 'store') {
        const file = lstatSync(this.sessionFile);
        if (!file.isFile() || file.uid !== process.getuid?.() || (file.mode & 0o077) !== 0 || file.size > 65536) return;
      }
      const values = new Map(readFileSync(this.sessionFile, 'utf8').split(/\r?\n/).flatMap(line => {
        const match = /^PAC_RELAY_([A-Z_]+)=(.*)$/.exec(line);
        return match ? [[match[1]!, match[2]!.trim()] as const] : [];
      }));
      const bearer = values.get('AGENT_ACCESS_TOKEN');
      const memberId = values.get('MEMBER_ID');
      const workspaceId = values.get('WORKSPACE_ID');
      const instanceId = values.get('AGENT_INSTANCE_ID');
      if (!bearer || !identifier(memberId) || !identifier(workspaceId) || !identifier(instanceId)
          || values.get('MEMBER_ORIGIN') !== this.origin || values.get('CLIENT_ID') !== 'agent-link'
          || this.windowsLogoutPending()) return;
      const identity = { origin: this.origin, bearer, memberId, workspaceId, instanceId };
      return { ...identity, scope: sessionScope(identity) };
    } catch { return; }
  }

  private grant(session: Session): Grant | undefined {
    if (this.ownerGrantStorage === 'store') return this.store.get<Grant>('cloud-owner-grants', session.scope) ?? undefined;
    try {
      const value: unknown = JSON.parse(readFileSync(this.grantFile, 'utf8').replace(/^\uFEFF/, ''));
      if (!isRecord(value) || value.schemaVersion !== fileGrantSchema
          || value.memberId !== session.memberId || value.workspaceId !== session.workspaceId
          || value.instanceId !== session.instanceId || typeof value.revision !== 'number'
          || !Number.isSafeInteger(value.revision) || value.revision < 1
          || !Array.isArray(value.launchScopes) || value.launchScopes.length > 100) return;
      const scopes: LaunchScope[] = [];
      for (const scope of value.launchScopes) {
        if (!isRecord(scope) || !identifier(scope.backendStoreId) || !identifier(scope.projectId)
            || !identifier(scope.engineId) || scope.engineId === 'macos') return;
        scopes.push({ backendStoreId: scope.backendStoreId, projectId: scope.projectId, engineId: scope.engineId });
      }
      return { revision: value.revision, scopes, controls: value.controls === true,
        approvals: value.approvals === true };
    } catch { return; }
  }

  private saveGrant(session: Session, grant: Grant): void {
    if (this.ownerGrantStorage === 'store') {
      this.store.put('cloud-owner-grants', session.scope, grant);
      return;
    }
    // Keep the existing Windows file as the single grant record so older
    // packaged versions also see permission changes after a rollback.
    const { memberId, workspaceId, instanceId } = session;
    const { revision, scopes, controls, approvals } = grant;
    const temporary = this.grantFile + '.' + randomUUID() + '.tmp';
    try {
      writeFileSync(temporary, JSON.stringify({ schemaVersion: fileGrantSchema,
        memberId, workspaceId, instanceId, revision, launchScopes: scopes, controls, approvals }),
      { flag: 'wx', mode: 0o600, flush: true });
      renameSync(temporary, this.grantFile);
    } finally { rmSync(temporary, { force: true }); }
  }

  async ownerGrant(request?: Json): Promise<Json> {
    if (!this.ownerGrantStorage || this.recoveryOnly) fail('OPERATION_NOT_ALLOWED', 403);
    const session = this.session();
    if (!session) fail('CLOUD_SESSION_REQUIRED', 409);
    if (request && (this.ownerGrantStorage === 'file' || request.expectedScope !== undefined)
        && request.expectedScope !== session.scope) fail('CLOUD_SESSION_CHANGED', 409);
    const catalog = Array.isArray(request?.launchScopes) && request.launchScopes.length === 0
      ? [] : await this.targets(session);
    if (this.session()?.scope !== session.scope) fail('CLOUD_SESSION_CHANGED', 409);
    let grant = this.grant(session);
    if (request !== undefined) {
      const selection = request.launchScopes;
      if (!Number.isSafeInteger(request.expectedRevision) || !Array.isArray(selection) || selection.length > 100 ||
          typeof request.controls !== 'boolean' || typeof request.approvals !== 'boolean') {
        fail('CLOUD_GRANT_INVALID', 400);
      }
      if (request.expectedRevision !== (grant?.revision ?? 0)) fail('CLOUD_GRANT_CHANGED', 409);
      const scopes: LaunchScope[] = [];
      for (const entry of selection) {
        if (!isRecord(entry) || !identifier(entry.backendStoreId) || !identifier(entry.projectId) ||
            !identifier(entry.engineId)) fail('CLOUD_GRANT_INVALID', 400);
        const scope = { backendStoreId: entry.backendStoreId, projectId: entry.projectId, engineId: entry.engineId };
        if (!catalog.some(target => this.matches(scope, target)) ||
            scopes.some(other => other.backendStoreId === scope.backendStoreId &&
              other.projectId === scope.projectId && other.engineId === scope.engineId)) {
          fail('CLOUD_TARGET_UNAVAILABLE', 409);
        }
        scopes.push(scope);
      }
      const next = { revision: (grant?.revision ?? 0) + 1, scopes,
        controls: scopes.length > 0 && request.controls, approvals: scopes.length > 0 && request.approvals };
      const previousScopes = grant?.scopes ?? [];
      const sameScopes = previousScopes.length === scopes.length && scopes.every(scope => previousScopes.some(other =>
        other.backendStoreId === scope.backendStoreId && other.projectId === scope.projectId && other.engineId === scope.engineId));
      if (!grant || !sameScopes ||
          grant.controls !== next.controls || grant.approvals !== next.approvals) {
        this.saveGrant(session, next);
        grant = next;
      }
    }
    return { revision: grant?.revision ?? 0, launchScopes: grant?.scopes ?? [],
      scope: session.scope, controls: grant?.controls ?? false, approvals: grant?.approvals ?? false, targets: catalog };
  }

  private async hosted(session: Session, method: 'GET' | 'POST' | 'PUT', path: string, body?: Json): Promise<Json> {
    if (this.session()?.scope !== session.scope) fail('CLOUD_SESSION_CHANGED', 409);
    const response = await this.fetcher(`${session.origin}${root}${path}`, {
      method, redirect: 'error',
      signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(8000)]),
      headers: { Authorization: `Bearer ${session.bearer}`, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const reply: unknown = await response.json();
    if (!response.ok) {
      fail(isRecord(reply) && typeof reply.code === 'string' ? reply.code : 'CLOUD_REQUEST_FAILED', response.status);
    }
    if (!isRecord(reply)) fail('CLOUD_RESPONSE_INVALID', 502);
    return reply;
  }

  private save(row: Delivery): void { this.store.put(journal, row.id, row); }

  async tick(): Promise<void> {
    if (this.updatePreparation?.preparing) return;
    const finish = this.updatePreparation?.admit();
    try { await this.deliver(); }
    finally { finish?.(); }
  }

  private async deliver(): Promise<void> {
    try { await this.linuxMember?.refresh(); }
    catch (error) { if (!this.linuxMember?.current()) throw error; }
    const session = this.session();
    if (!session) return;
    const grant = this.grant(session);
    const prior = this.store.get<{ checkedAt: number; grant: string }>('windows-cloud-directory', session.scope);
    // Existing receipts and observations keep moving when publication or
    // claiming hits a temporary endpoint error.
    for (const row of this.store.list<Delivery>(journal)) {
      if (row.scope !== session.scope || row.phase === 'closed' || row.phase === 'claimed') continue;
      try { await this.resume(session, row); } catch { /* the original journal entry remains */ }
    }
    for (const action of this.store.list<Action>(actions)) {
      if (action.scope !== session.scope || action.closed) continue;
      try { await this.resumeAction(session, action); } catch { /* keep the original action outbox */ }
    }
    if (this.recoveryOnly || (!grant && !prior)) return;
    const targets = grant?.scopes.length ? await this.targets(session, grant) : [];
    const directoryDigest = hash(JSON.stringify([grant ?? null, targets]));
    if (!prior || prior.grant !== directoryDigest || Date.now() - prior.checkedAt > 30_000) {
      if (!await this.publish(session, grant, targets)) return;
      this.store.put('windows-cloud-directory', session.scope, { checkedAt: Date.now(), grant: directoryDigest });
    }
    if (!grant || targets.length === 0 || this.abort.signal.aborted) return;
    const kinds = grant.controls || grant.approvals ? `${kind},${actionKind}` : kind;
    const batch = await this.hosted(session, 'GET', `/task-claims?limit=4&kinds=${kinds}`);
    for (const command of Array.isArray(batch.commands) ? batch.commands : []) {
      try {
        if (isRecord(command) && command.kind === actionKind) await this.consumeAction(session, command);
        else await this.consume(session, grant, command);
      } catch { /* leave this delivery for recovery */ }
    }
  }

  private async publish(session: Session, grant: Grant | undefined, targets: Json[]): Promise<boolean> {
    const unchanged = () => JSON.stringify(this.grant(session) ?? null) === JSON.stringify(grant ?? null);
    if (!unchanged()) return false;
    const path = `/instances/${session.instanceId}/targets`;
    const previous = await this.hosted(session, 'GET', path);
    if (!unchanged()) return false;
    await this.hosted(session, 'PUT', path, { expectedRevision: previous.revision, targets });
    return unchanged();
  }

  private async targets(session: Session, grant?: Grant): Promise<Json[]> {
    let targets = await this.nativeTargets(grant);
    const fileDeviceId = grant && targets.some(target => target.engineId === 'sage-pi')
      ? await this.taskFiles?.deviceId?.() : undefined;
    if (fileDeviceId) {
      targets = targets.map(target => target.engineId === 'sage-pi' ? { ...target, fileDeviceId } : target);
    }
    const acs = this.acs;
    if (!acs) return targets;
    if (!grant) {
      try {
        const projects = await acs.catalog(session.scope);
        targets.push(...projects.map(project => ({ ...project, engineId: 'acs' })));
      } catch (error) {
        if (!(error instanceof GatewayError) || error.httpStatus < 500) throw error;
      }
      return targets;
    }
    for (const scope of grant.scopes.filter(scope => scope.engineId === 'acs' && scope.backendStoreId === acs.backendId)) {
      let revision: string | undefined;
      try { revision = await acs.preflight(session.scope, scope.projectId); }
      catch (error) {
        if (!(error instanceof GatewayError) || error.httpStatus < 500) throw error;
      }
      if (revision) targets.push({ sourceKind: 'ACS', backendId: scope.backendStoreId,
        projectId: scope.projectId, capabilityRevision: revision });
    }
    return targets;
  }

  private async nativeTargets(grant?: Grant): Promise<Json[]> {
    if (!this.localCatalog) return [];
    let catalog: Json;
    try { catalog = await this.localCatalog.ownerCatalog(); }
    catch (error) {
      if (error instanceof GatewayError && error.code === 'LOCAL_SOURCE_UNAVAILABLE') return [];
      throw error;
    }
    const entries = this.localCatalog.linkTargets(catalog).targets;
    return Array.isArray(entries) ? entries.filter(target => isRecord(target) && target.sourceKind === 'NATIVE'
      && (this.ownerGrantStorage !== 'file' || target.engineId !== 'macos')
      && (!grant || grant.scopes.some(scope => this.matches(scope, target)))) : [];
  }

  private matches(scope: LaunchScope, target: Json): boolean {
    return scope.backendStoreId === target.backendId && scope.projectId === target.projectId
      && scope.engineId === (target.sourceKind === 'ACS' ? 'acs' : target.engineId);
  }

  private async consume(session: Session, grant: Grant, command: unknown): Promise<void> {
    if (!isRecord(command) || command.kind !== kind || !identifier(command.commandId)
        || !identifier(command.workId) || typeof command.deliveryGeneration !== 'number'
        || !isRecord(command.payload)) return;
    const payload = command.payload;
    if (!isRecord(payload.target) || payload.target.instanceId !== session.instanceId
        || !identifier(payload.nativeRequestKey) || typeof payload.payloadDigest !== 'string') return;
    const id = hash(`${session.scope}:${command.commandId}`);
    const old = this.store.get<Delivery>(journal, id);
    if (old && (old.workId !== command.workId || old.digest !== payload.payloadDigest
        || old.nativeKey !== payload.nativeRequestKey)) {
      fail('CLOUD_REQUEST_CONFLICT', 409);
    }
    const row: Delivery = { ...(old ?? {
      id, scope: session.scope, workId: command.workId, digest: payload.payloadDigest,
      nativeKey: payload.nativeRequestKey, target: payload.target,
      grantRevision: grant.revision, phase: 'claimed',
    }), generation: command.deliveryGeneration };
    this.save(row);
    if (row.phase !== 'claimed') return this.resume(session, row);
    const target = row.target;
    const instruction = isRecord(payload.instruction) ? payload.instruction.text : undefined;
    const scope = grant.scopes.find(entry => this.matches(entry, target));
    const revision = typeof target.capabilityRevision === 'string' ? target.capabilityRevision : undefined;
    const acs = target.sourceKind === 'ACS' && target.backendId === this.acs?.backendId;
    const attachment = this.attachment(payload, target);
    const supported = row.grantRevision === grant.revision && scope && typeof instruction === 'string'
      && instruction.trim() && instruction.length <= 16_000
      && isRecord(payload.parameters)
      && (acs ? this.acsParameters(payload.parameters, scope.projectId) && attachment === null
        : target.sourceKind === 'NATIVE' && attachment !== undefined && Object.keys(payload.parameters).length === 0);
    const path = `/task-claims/${command.commandId}`;
    let acsRevision: string | undefined;
    let preflight;
    if (supported) {
      if (acs) {
        acsRevision = await this.acs!.preflight(session.scope, scope.projectId);
        if (!acsRevision) return;
      } else {
        const live = (await this.nativeTargets(grant)).find(entry => this.matches(scope, entry));
        // Let Hosted redeliver the same request when the bridge is ready.
        if (!live) return;
        if (revision === undefined || revision === live.capabilityRevision) {
          preflight = await this.local(session, row, access => access.remote(row.id, 'POST',
            `/personal/v1/local-tasks/${scope.backendStoreId}/task-preflights`,
            { projectId: scope.projectId, engineId: scope.engineId }, null, null));
        }
      }
    }
    if (this.grant(session)?.revision !== grant.revision) return;
    const authorization = await this.hosted(session, 'POST', `${path}/authorize`, { deliveryGeneration: row.generation });
    if (authorization.requestKey !== row.nativeKey) fail('CLOUD_REQUEST_CONFLICT', 409);
    if (authorization.action === 'lookup') {
      if (old?.phase === 'claimed') {
        // Dispatches always cross the persisted submitting boundary first.
        // A surviving claimed row proves the source call did not start.
        row.phase = 'receipt';
        row.outcome = 'not_accepted';
      } else {
        // The prior gateway's journal may be unavailable. Never replay.
        row.phase = 'submitting';
        if (acs) row.acs = { content: '', create: {}, dispatchBefore: 0, lookupOnly: true };
      }
      this.save(row);
      return this.resume(session, row);
    }
    if (authorization.action !== 'dispatch' || authorization.payloadDigest !== row.digest) {
      fail('CLOUD_REQUEST_CONFLICT', 409);
    }
    const deadline = time(authorization.dispatchBefore);
    if (!supported || this.session()?.scope !== session.scope || this.grant(session)?.revision !== row.grantRevision
        || !(Date.now() < deadline)) {
      row.phase = 'receipt';
      row.outcome = 'not_accepted';
    } else if (acs) {
      if (!acsRevision || acsRevision !== revision) {
        row.phase = 'receipt';
        row.outcome = 'not_accepted';
      } else {
        const parameters = payload.parameters as Json;
        row.acs = { content: instruction, dispatchBefore: deadline,
          create: { schemaVersion: 'business-session/2.0', workspaceAlias: scope.projectId,
            intent: 'IMPLEMENT', ...(isRecord(parameters.modelSettings) ? { modelSettings: parameters.modelSettings } : {}) } };
        row.phase = 'submitting';
        this.save(row);
        await this.createAcs(session, row);
      }
    } else if (!preflight || !isRecord(preflight.body) || typeof preflight.body.optionsRevision !== 'string' ||
        (attachment && preflight.body.sageLinkFiles !== true)) {
      row.phase = 'receipt';
      row.outcome = 'not_accepted';
    } else {
      const launch = { requestKey: row.nativeKey, projectId: scope.projectId,
        engineId: scope.engineId, optionsRevision: preflight.body.optionsRevision, instruction,
        ...(attachment ? { linkFile: attachment } : {}) };
      row.hasAttachment = attachment != null;
      row.phase = 'submitting';
      this.save(row);
      const result = await this.local(session, row, access => access.remote(row.id, 'POST',
        `/personal/v1/local-tasks/${scope.backendStoreId}/tasks`, launch, row.nativeKey, null), deadline);
      this.adopt(row, result.body);
    }
    this.save(row);
    await this.resume(session, row);
  }

  private attachment(payload: Json, target: Json): Json | null | undefined {
    if (!Array.isArray(payload.attachments)) return;
    if (payload.attachments.length === 0) return null;
    const file = payload.attachments[0];
    const expiresAt = isRecord(file) ? time(file.expiresAt) : NaN;
    if (target.sourceKind !== 'NATIVE' || target.engineId !== 'sage-pi' || payload.attachments.length !== 1 ||
        !isRecord(file) || !identifier(file.transferID) || file.requestID !== payload.nativeRequestKey ||
        file.projectID !== target.projectId || typeof file.signature !== 'string' ||
        !/^[A-Za-z0-9+/]{86}==$/.test(file.signature) || !(Date.now() < expiresAt)) return;
    return { ...file, expiresAt: Math.floor(expiresAt / 1000) };
  }

  private acsParameters(parameters: Json, project: string): boolean {
    return Object.keys(parameters).every(key => ['projectId', 'creationScopeRef', 'modelSettings'].includes(key))
      && (parameters.projectId === undefined || parameters.projectId === project)
      && (parameters.creationScopeRef === undefined || parameters.creationScopeRef === project);
  }

  private assertAcsGrant(session: Session, row: Delivery, deadline?: number): void {
    const grant = this.grant(session);
    if (this.abort.signal.aborted || this.session()?.scope !== session.scope ||
        grant?.revision !== row.grantRevision || row.target.backendId !== this.acs?.backendId ||
        !grant.scopes.some(scope => this.matches(scope, row.target))) fail('CLOUD_SCOPE_CHANGED', 403);
    if (deadline !== undefined && !(Date.now() < deadline)) fail('CLOUD_DISPATCH_EXPIRED', 409);
  }

  private async createAcs(session: Session, row: Delivery): Promise<void> {
    const intent = row.acs!;
    const key = `cloud-create-${row.id}`;
    const result = await this.acs!.call(session.scope, 'POST', '/api/v2/sessions', intent.create, key,
      () => this.assertAcsGrant(session, row, intent.dispatchBefore));
    if (result.status >= 200 && result.status < 300 && isRecord(result.body) && identifier(result.body.sessionId)) {
      intent.sessionId = result.body.sessionId;
    } else if ([400, 403, 422, 428].includes(result.status)) {
      row.outcome = 'not_accepted';
      row.phase = 'receipt';
    }
    this.save(row);
  }

  private async resumeAcs(session: Session, row: Delivery): Promise<void> {
    const intent = row.acs;
    if (!intent || !this.acs) return;
    this.assertAcsGrant(session, row);
    if (!intent.sessionId) {
      const key = `cloud-create-${row.id}`;
      const receipt = await this.acs.call(session.scope, 'POST', '/api/v2/operations/lookup-created-session',
        { idempotencyKey: key }, key);
      if (receipt.status !== 200 || !isRecord(receipt.body) || receipt.body.operation !== 'session.create' ||
          !identifier(receipt.body.resourceId)) return;
      intent.sessionId = receipt.body.resourceId;
      this.save(row);
    }
    const sid = intent.sessionId;
    const key = `cloud-message-${row.id}`;
    if (intent.message || intent.lookupOnly) {
      const receipt = await this.acs.call(session.scope, 'POST', '/api/v2/operations/lookup',
        { operation: 'session.message', resourceId: sid, idempotencyKey: key }, key);
      if (receipt.status === 200 && isRecord(receipt.body) && receipt.body.operation === 'session.message' &&
          receipt.body.resourceId === sid && isRecord(receipt.body.result)) {
        this.acceptAcsMessage(row, receipt.body.result);
        return;
      }
      if (receipt.status !== 404) return;
    }
    if (!(Date.now() < intent.dispatchBefore)) {
      if (!intent.message && !intent.lookupOnly) {
        row.outcome = 'not_accepted';
        row.phase = 'receipt';
        this.save(row);
      }
      return;
    }
    if (!intent.message) {
      const summary = await this.acs.call(session.scope, 'GET', `/api/v2/sessions/${sid}/summary`);
      if (summary.status !== 200 || !isRecord(summary.body) || summary.body.sessionId !== sid ||
          !Number.isSafeInteger(summary.body.sessionVersion)) return;
      intent.message = { clientMessageId: key, content: intent.content, expectedSessionVersion: summary.body.sessionVersion };
      this.save(row);
    }
    const result = await this.acs.call(session.scope, 'POST', `/api/v2/sessions/${sid}/messages`,
      intent.message, key, () => this.assertAcsGrant(session, row, intent.dispatchBefore));
    if (result.status >= 200 && result.status < 300 && isRecord(result.body)) {
      this.acceptAcsMessage(row, result.body);
    } else if ([400, 403, 408, 409, 422, 428].includes(result.status)) {
      // The synthetic session is private to this dispatch. An ambiguous
      // response stays in the original receipt lookup path.
      if (result.status !== 409 && result.status !== 408) {
        row.outcome = 'not_accepted';
        row.phase = 'receipt';
        this.save(row);
      }
    }
  }

  private acceptAcsMessage(row: Delivery, message: Json): void {
    if (!row.acs?.sessionId) return;
    row.taskId = row.acs.sessionId;
    if (identifier(message.runId)) row.activeRunId = message.runId;
    row.outcome = 'accepted';
    row.phase = 'receipt';
    this.save(row);
  }

  private adopt(row: Delivery, view: unknown): void {
    if (!isRecord(view)) return;
    if (identifier(view.taskId) && view.state === 'OBSERVED') {
      row.taskId = view.taskId;
      row.outcome = 'accepted';
      row.phase = 'receipt';
    } else if (view.state === 'REJECTED') {
      row.outcome = 'not_accepted';
      row.phase = 'receipt';
    }
  }

  private async resume(session: Session, row: Delivery): Promise<void> {
    const backend = row.target.backendId;
    if (!identifier(backend)) return;
    const rootPath = `/personal/v1/local-tasks/${backend}`;
    if (row.phase === 'submitting' && row.target.sourceKind === 'ACS') {
      await this.resumeAcs(session, row);
    } else if (row.phase === 'submitting') {
      const reply = await this.local(session, row, access => access.remote(row.id, 'GET',
        `${rootPath}/task-requests/${row.nativeKey}`, null, null, null));
      this.adopt(row, reply.body);
      this.save(row);
    }
    if (row.phase === 'receipt') {
      const view = await this.hosted(session, 'GET', `/tasks/${row.workId}/agent`);
      const dispatch = view.dispatch;
      if (!isRecord(dispatch) || view.nativeRequestKey !== row.nativeKey || view.payloadDigest !== row.digest) return;
      const command = dispatch.commandId;
      if (!identifier(command) || !row.outcome || dispatch.deliveryGeneration !== row.generation) return;
      const body = { deliveryGeneration: row.generation, outcome: row.outcome,
        ...(row.taskId ? { nativeTaskId: row.taskId } : {}),
        ...(row.target.sourceKind === 'ACS' && row.taskId ? { sessionId: row.taskId,
          ...(row.activeRunId ? { activeRunId: row.activeRunId } : {}) } : {}) };
      try { await this.hosted(session, 'POST', `/task-claims/${command}/receipt`, body); }
      catch (error) {
        if (!(error instanceof GatewayError) || error.code !== 'STALE_COMMAND_CLAIM') throw error;
        await this.hosted(session, 'POST', `/task-claims/${command}/reconcile`, body);
      }
      row.phase = row.taskId ? 'tracking' : 'closed';
      this.save(row);
    }
    if (row.phase === 'tracking' && row.taskId) {
      if (row.target.sourceKind === 'ACS') await this.observeAcs(session, row, row.taskId);
      else await this.observe(session, row, rootPath, row.taskId);
    }
    if (row.phase === 'result' && row.taskId) {
      await this.hosted(session, 'PUT', `/tasks/${row.workId}/results/primary`, {
        operationId: `win-result-${row.id}`, expectedVersion: 1,
        refs: [{ ref: row.target.sourceKind === 'ACS'
          ? `acs://${backend}/sessions/${row.taskId}` : `native://${backend}/tasks/${row.taskId}`,
        mediaType: 'application/json' }],
        availability: 'available',
        observedAt: row.resultObservedAt,
      });
      if (row.hasAttachment && this.taskFiles?.results) {
        const publication = await this.local(session, row, access =>
          access.taskFileResults(row.id, backend, row.taskId!, row.nativeKey));
        for (const artifact of publication.files) {
          const { transferId, sizeBytes, sha256 } = artifact;
          if (!identifier(transferId) || !Number.isSafeInteger(sizeBytes) ||
              typeof sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(sha256)) {
            fail('LINK_FILE_RESULTS_UNAVAILABLE', 503);
          }
          await this.hosted(session, 'PUT', `/tasks/${row.workId}/results/file-${transferId}`, {
            operationId: `win-file-${transferId}`, expectedVersion: 1,
            refs: [{ ref: `link-file://${transferId}`, sizeBytes, sha256,
              mediaType: 'application/octet-stream' }],
            availability: 'available', observedAt: row.resultObservedAt,
            ...(row.activeRunId ? { sourceRevision: row.activeRunId } : {}),
          });
        }
        if (publication.pending > 0 || row.pendingFilePublication) {
          await this.hosted(session, 'PUT', `/tasks/${row.workId}/results/encrypted-publication`, {
            operationId: `win-publish-${row.id}`, expectedVersion: 1, refs: [],
            availability: publication.pending > 0 ? 'pending' : 'available',
            observedAt: row.resultObservedAt,
          });
          if (publication.pending > 0) {
            row.pendingFilePublication = true;
            this.save(row);
            return;
          }
        }
      }
      row.phase = 'closed';
      this.save(row);
    }
  }

  private async observeAcs(session: Session, row: Delivery, sid: string): Promise<void> {
    if (!row.pendingObservation) {
      this.assertAcsGrant(session, row);
      const summary = await this.acs!.call(session.scope, 'GET', `/api/v2/sessions/${sid}/summary`);
      if (summary.status !== 200 || !isRecord(summary.body) || summary.body.sessionId !== sid) return;
      const run = identifier(summary.body.activeRunId) ? summary.body.activeRunId : row.activeRunId;
      if (!run) return;
      const detail = await this.acs!.call(session.scope, 'GET', `/api/v2/runs/${run}`);
      if (detail.status !== 200 || !isRecord(detail.body) || detail.body.sessionId !== sid ||
          typeof detail.body.state !== 'string') return;
      const sourceState = detail.body.state;
      const state = ({
        QUEUED: 'queued', RUNNING: 'running', VALIDATING: 'running', PAUSE_REQUESTED: 'running',
        CANCEL_REQUESTED: 'running', PAUSED: 'waiting_input', WAITING_APPROVAL: 'waiting_approval',
        COMPLETED: 'succeeded', FAILED: 'failed', CANCELLED: 'cancelled', NEEDS_ATTENTION: 'waiting_input',
      } as Record<string, string>)[sourceState];
      if (!state || (state === row.observedState && run === row.activeRunId)) return;
      row.eventNumber = (row.eventNumber ?? 0) + 1;
      row.pendingObservation = { state, sourceState, nativeTaskId: sid, sessionId: sid, activeRunId: run,
        eventId: `win-${row.id}-${row.eventNumber}`, observedAt: new Date().toISOString(),
        executionEpoch: (row.executionEpoch ?? 1) + (row.activeRunId && row.activeRunId !== run ? 1 : 0),
        supportedActions: [] };
      this.save(row);
    }
    await this.flushObservation(session, row);
  }

  private async observe(session: Session, row: Delivery, rootPath: string, taskId: string): Promise<void> {
    if (!row.pendingObservation) {
      const reply = await this.local(session, row, access => access.remote(row.id, 'GET',
        `${rootPath}/tasks/${taskId}`, null, null, null));
      if (!isRecord(reply.body) || reply.body.taskId !== taskId) return;
      const sourceState = reply.body.state;
      const state = typeof sourceState === 'string' ? ({
        QUEUED: 'queued', DISPATCHED: 'queued', RUNNING: 'running', SUCCEEDED: 'succeeded',
        FAILED: 'failed', TIMED_OUT: 'failed', CANCELLED: 'cancelled',
        WAITING_INPUT: 'waiting_input', WAITING_APPROVAL: 'waiting_approval',
      } as Record<string, string>)[sourceState] : undefined;
      if (!state) return;
      const pins = this.pins(reply.body);
      const run = pins ? `win-run-${hash(JSON.stringify(pins))}` : undefined;
      const epoch = (row.executionEpoch ?? 1) + (row.activeRunId && row.activeRunId !== run ? 1 : 0);
      const pendingInputs = await this.pendingApprovals(session, row, `${rootPath}/tasks/${taskId}`, reply.body, pins, epoch);
      const supported = this.supportedActions(session, reply.body, pins, pendingInputs);
      const projectedState = pendingInputs.length > 0 && ['running', 'waiting_input'].includes(state)
        ? 'waiting_approval' : state;
      if (projectedState === row.observedState && run === row.activeRunId &&
          JSON.stringify(supported) === JSON.stringify(row.supportedActions) &&
          JSON.stringify(pendingInputs) === JSON.stringify(row.pendingInputs ?? [])) return;
      row.eventNumber = (row.eventNumber ?? 0) + 1;
      row.pendingObservation = { state: projectedState, sourceState, nativeTaskId: taskId,
        eventId: `win-${row.id}-${row.eventNumber}`, observedAt: new Date().toISOString(),
        executionEpoch: epoch, activeRunId: run, supportedActions: supported, pendingInputs };
      this.save(row);
    }
    await this.flushObservation(session, row);
  }

  private async flushObservation(session: Session, row: Delivery): Promise<void> {
    if (!row.pendingObservation) return;
    await this.hosted(session, 'POST', `/tasks/${row.workId}/observations`, row.pendingObservation);
    row.observedState = row.pendingObservation.state as string;
    row.activeRunId = row.pendingObservation.activeRunId as string | undefined;
    row.executionEpoch = row.pendingObservation.executionEpoch as number;
    row.supportedActions = row.pendingObservation.supportedActions as string[];
    row.pendingInputs = row.pendingObservation.pendingInputs as PendingApproval[] | undefined;
    if (['succeeded', 'failed', 'cancelled'].includes(row.observedState)) {
      row.phase = 'result';
      row.resultObservedAt = row.pendingObservation.observedAt as string;
    }
    delete row.pendingObservation;
    this.save(row);
  }

  private pins(facts: Json): Json | undefined {
    const { generation, nativeSessionId, nativeTurnId, currentCommandId } = facts;
    if (!identifier(generation) || typeof nativeSessionId !== 'string' || !nativeSessionId
        || !identifier(currentCommandId)) return;
    return { generation, nativeSessionId, targetCommandId: currentCommandId,
      ...(typeof nativeTurnId === 'string' && nativeTurnId ? { nativeTurnId } : {}) };
  }

  private supportedActions(session: Session, facts: Json, pins: Json | undefined,
    pending: PendingApproval[]): CloudAction[] {
    if (this.recoveryOnly || !pins) return [];
    const capabilities = isRecord(facts.capabilities) ? facts.capabilities : {};
    const grant = this.grant(session);
    return [...(grant?.controls && capabilities.followUp === true ? ['message' as const] : []),
      ...(grant?.controls && capabilities.stop === true ? ['stop' as const] : []),
      ...(grant?.approvals && pending.length > 0 ? ['approval_response' as const] : [])];
  }

  private async pendingApprovals(session: Session, row: Delivery, route: string,
    facts: Json, pins: Json | undefined, epoch: number): Promise<PendingApproval[]> {
    if (this.recoveryOnly || !this.grant(session)?.approvals || !pins?.nativeTurnId || !['pi', 'sage-pi'].includes(String(facts.engineId)) ||
        !['RUNNING', 'WAITING_INPUT', 'WAITING_APPROVAL'].includes(String(facts.state))) return [];
    const reply = await this.local(session, row, access => access.remote(row.id, 'GET',
      `${route}/input-requests`, null, null, null));
    const questions = isRecord(reply.body) && Array.isArray(reply.body.items) ? reply.body.items : [];
    const pending: PendingApproval[] = [];
    const seen = new Set<string>();
    for (const q of questions.filter(isRecord)) {
      if (q.state !== 'PENDING' || q.method !== 'confirm' || !identifier(q.inputRequestId) ||
          q.generation !== pins.generation || q.nativeSessionId !== pins.nativeSessionId ||
          q.nativeTurnId !== pins.nativeTurnId || q.targetCommandId !== pins.targetCommandId ||
          typeof q.title !== 'string' || !q.title.trim()) continue;
      const summary = [q.title, typeof q.message === 'string' ? q.message : '']
        .map(field => field.trim()).filter(Boolean).join('\n');
      if (Buffer.byteLength(summary) > 1024) continue;
      if (seen.has(q.inputRequestId) || pending.length === 32) return [];
      seen.add(q.inputRequestId);
      pending.push({ kind: 'CONFIRM', questionId: q.inputRequestId, round: epoch,
        summary,
        fingerprint: hash(JSON.stringify([pins, q.inputRequestId, q.title, q.message ?? null])) });
    }
    return pending.sort((a, b) => a.questionId.localeCompare(b.questionId));
  }

  private launchFor(action: Action): Delivery | undefined {
    return this.store.list<Delivery>(journal).find(row => row.scope === action.scope && row.workId === action.workId);
  }

  private async consumeAction(session: Session, command: Json): Promise<void> {
    if (!identifier(command.commandId) || !identifier(command.workId) ||
        !Number.isSafeInteger(command.deliveryGeneration) || !isRecord(command.payload)) return;
    const payload = command.payload;
    if (!identifier(payload.operationId) || payload.workId !== command.workId ||
        !isRecord(payload.payload) ||
        (payload.kind !== 'message' && payload.kind !== 'stop' && payload.kind !== 'approval_response')) return;
    const id = hash(`${session.scope}:${command.commandId}`);
    const fingerprint = hash(JSON.stringify(payload));
    const existing = this.store.get<Action>(actions, id);
    if (existing && existing.fingerprint !== fingerprint) fail('CLOUD_ACTION_CONFLICT', 409);
    const action: Action = { ...(existing ?? { id, scope: session.scope, commandId: command.commandId,
      workId: command.workId, fingerprint, kind: payload.kind, requestKey: `win-action-${id}` }),
      generation: command.deliveryGeneration as number };
    if (existing) {
      this.store.put(actions, id, action);
      // The local input ledger is written before any Worker dispatch. Only
      // a missing local row under a freshly claimed delivery permits another
      // admission attempt, with the original key and current guards.
      if (await this.resumeAction(session, action) !== 'unstarted') return;
    }
    const launch = this.launchFor(action);
    const deadline = Math.min(time(payload.expiresAt), time(command.claimUntil));
    const decide = (outcome: Action['outcome'], detail: string) => {
      action.outcome = outcome;
      action.detail = detail;
      this.store.put(actions, id, action);
    };
    if (!(Date.now() < deadline)) decide('expired', 'action_deadline');
    else if (!launch?.taskId || !identifier(launch.target.backendId)) decide('conflict', 'work_binding_missing');
    else {
      const taskPath = `/personal/v1/local-tasks/${launch.target.backendId}/tasks/${launch.taskId}`;
      const work = await this.hosted(session, 'GET', `/tasks/${action.workId}/agent`);
      const execution = isRecord(work.execution) ? work.execution : {};
      const input = payload.payload;
      const current = await this.local(session, launch, access => access.remote(launch.id, 'GET', taskPath,
        null, null, null));
      const facts = isRecord(current.body) ? current.body : {};
      const pins = this.pins(facts);
      const run = pins ? `win-run-${hash(JSON.stringify(pins))}` : undefined;
      const pending = action.kind === 'approval_response'
        ? await this.pendingApprovals(session, launch, taskPath, facts, pins, launch.executionEpoch ?? 1) : [];
      if (!pins || !run || run !== launch.activeRunId || run !== input.activeRunId || run !== execution.activeRunId
          || input.executionEpoch !== launch.executionEpoch || input.executionEpoch !== execution.executionEpoch
          || execution.nativeTaskId !== launch.taskId || !this.supportedActions(session, facts, pins, pending).includes(action.kind)) {
        decide('conflict', 'stale_execution');
      } else if (action.kind === 'approval_response' &&
          (!pending.some(q => q.questionId === input.questionId && q.round === input.round && q.fingerprint === input.fingerprint)
            || (input.decision !== 'approve' && input.decision !== 'reject'))) {
        decide('conflict', 'stale_approval');
      } else if (action.kind === 'message' && (typeof input.text !== 'string' || !input.text.trim()
          || Buffer.byteLength(input.text, 'utf8') > 16384)) {
        decide('conflict', 'message_invalid');
      } else {
        const body = { ...pins, requestKey: action.requestKey,
          ...(action.kind === 'stop' ? { intent: 'STOP' }
            : action.kind === 'approval_response' ? { response: { confirmed: input.decision === 'approve' } }
              : { kind: 'NATIVE_FOLLOW_UP', content: input.text }) };
        const tail = action.kind === 'stop' ? 'commands'
          : action.kind === 'approval_response' ? `input-requests/${String(input.questionId)}/responses` : 'messages';
        this.store.put(actions, id, action);
        try {
          const reply = await this.local(session, launch, access => access.remote(launch.id, 'POST',
            `${taskPath}/${tail}`, body, action.requestKey, null), deadline, action.kind);
          if (isRecord(reply.body) && reply.body.state === 'REJECTED') decide('conflict', 'source_rejected');
        } catch (error) {
          if (!(error instanceof GatewayError) || ![400, 403, 409, 422].includes(error.httpStatus)) throw error;
          decide('conflict', 'source_guard_rejected');
        }
      }
    }
    await this.resumeAction(session, action);
  }

  private async resumeAction(session: Session, action: Action): Promise<void | 'unstarted'> {
    if (action.closed) return;
    if (!action.outcome) {
      const launch = this.launchFor(action);
      if (!launch?.taskId || !identifier(launch.target.backendId)) return;
      const route = `/personal/v1/local-tasks/${launch.target.backendId}/tasks/${launch.taskId}`;
      let reply;
      try {
        reply = await this.local(session, launch, access => access.remote(launch.id, 'GET',
          `${route}/requests/${action.requestKey}`, null, null, null));
      } catch (error) {
        if (error instanceof GatewayError && error.httpStatus === 404 && error.code === 'NOT_FOUND') {
          return 'unstarted';
        }
        throw error;
      }
      if (!isRecord(reply.body)) return;
      if (reply.body.state === 'REJECTED') {
        action.outcome = 'conflict';
        action.detail = 'source_rejected';
      } else if (reply.body.state === 'OBSERVED') {
        const source = isRecord(reply.body.source) ? reply.body.source : {};
        const end = isRecord(source.result) ? source.result.state : undefined;
        if (action.kind === 'stop' && source.state !== 'STOPPED' &&
            !(source.state === 'SUCCEEDED' && ['CANCELLED', 'STOPPED'].includes(String(end)))) return;
        if (action.kind === 'message' && !['ACCEPTED', 'SUCCEEDED'].includes(String(source.state))) return;
        if (action.kind === 'approval_response' &&
            (source.kind !== 'INPUT_RESPONSE' || source.taskId !== launch.taskId || source.state !== 'CONSUMED')) return;
        action.outcome = 'executed';
      } else return;
      this.store.put(actions, action.id, action);
    }
    await this.hosted(session, 'POST', `/task-claims/${action.commandId}/receipt`, {
      deliveryGeneration: action.generation, outcome: action.outcome, detail: action.detail,
    });
    action.closed = true;
    this.store.put(actions, action.id, action);
  }

  private async local<T>(session: Session, row: Delivery,
    operation: (access: LocalTaskAccess) => Promise<T>, deadline?: number, control?: CloudAction): Promise<T> {
    const principal = `win-cloud-${hash(JSON.stringify([row.scope, row.grantRevision]))}`;
    const assertCurrent = (): Grant => {
      const grant = this.grant(session);
      if (this.abort.signal.aborted || this.session()?.scope !== session.scope || grant?.revision !== row.grantRevision
          || !grant.scopes.some(scope => this.matches(scope, row.target))
          || control && !(control === 'approval_response' ? grant.approvals : grant.controls)) {
        fail('CLOUD_SCOPE_CHANGED', 403);
      }
      return grant;
    };
    const device = (): Device => {
      // Old receipts need the original local principal. For read/lookup
      // operations, derive only its already-journaled scope even after
      // withdrawal. Any new execution still requires the current grant.
      if (this.abort.signal.aborted || this.session()?.scope !== session.scope) fail('CLOUD_SCOPE_CHANGED', 403);
      const target = row.target;
      if (!identifier(target.backendId) || !identifier(target.projectId) || !identifier(target.engineId)) {
        fail('CLOUD_SCOPE_CHANGED', 403);
      }
      const scopes = deadline !== undefined ? assertCurrent().scopes
        : [{ backendStoreId: target.backendId, projectId: target.projectId, engineId: target.engineId }];
      return { id: principal, revision: row.grantRevision, state: 'ACTIVE', scopeVersion: 2,
        actions: ['OBSERVE', 'LAUNCH',
          ...(control === 'approval_response' ? ['APPROVE'] : control ? ['INTERACT', 'CONTROL'] : [])],
        launchScopes: scopes,
        resources: this.store.get('windows-cloud-resources', principal) ?? [],
        absoluteExpiry: 0, idleExpiry: 0, accessExpiry: 0, recoverUntil: 0, spentRefresh: [] };
    };
    const authenticate = (token: string): Device => {
      if (token !== row.id) fail('CLOUD_SCOPE_CHANGED', 403);
      return device();
    };
    const authorize = (backend: string, task: string, action: string): Device => {
      const current = device();
      if (!current.actions?.includes(action) || !scopeContains(current, 'WORKER_LOCAL', backend, task)) {
        fail('CLOUD_SCOPE_CHANGED', 403);
      }
      return current;
    };
    const auth: LocalAuthLike = {
      ownerStatus: () => ({ personalHostId: this.hostId }), authenticate,
      activeDevice: value => value === principal ? device() : fail('CLOUD_SCOPE_CHANGED', 403),
      authorizeLaunch: (token, backend, project, engine) => {
        const current = authenticate(token);
        if (!this.matches({ backendStoreId: backend, projectId: project, engineId: engine }, row.target)
            || !permitsLaunch(current, backend, project, engine)) fail('CLOUD_SCOPE_CHANGED', 403);
        return current;
      },
      authorizeLocal: (token, backend, task, action) => { authenticate(token); return authorize(backend, task, action); },
      authorizeLocalDevice: (value, backend, task, action) => value === principal
        ? authorize(backend, task, action) : fail('CLOUD_SCOPE_CHANGED', 403),
      appendLaunchedTask: (value, revision, backend, project, engine, taskId) => {
        const current = device();
        if (value !== principal || revision !== current.revision ||
            !this.matches({ backendStoreId: backend, projectId: project, engineId: engine }, row.target)) {
          fail('CLOUD_SCOPE_CHANGED', 403);
        }
        if (!scopeContains(current, 'WORKER_LOCAL', backend, taskId)) {
          this.store.put('windows-cloud-resources', principal,
            [...(current.resources ?? []), { kind: 'WORKER_LOCAL', backendStoreId: backend, taskId }]);
        }
      },
    };
    return operation(new LocalTaskAccess(auth, this.transport, this.store, this.taskFiles,
      deadline === undefined ? undefined : () => { assertCurrent(); return deadline; }));
  }
}
