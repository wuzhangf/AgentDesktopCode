/**
 * XagtReadService — the eight read-only tool implementations shared by the
 * stdio MCP adapter and the fixed peer RPC (design §3/§7). Everything here is
 * read-only by construction:
 *
 *   - refs resolve to internal bindings only; a model can never inject a URL,
 *     path or raw source id (refs are issued by this service);
 *   - every read re-checks the reader grant against the binding — scope is an
 *     intersection, and revocation kills outstanding cursors via revision;
 *   - peer-bound refs unwrap to the remote ref the SOURCE Link issued and are
 *     forwarded as the same {version:1,tool,arguments} body; a receiving Link
 *     only resolves its own local refs, so reads never chain past one hop;
 *   - concurrency is capped (2/reader, 8 global) with BUSY on overflow;
 *     local reads run under a 5 s deadline, peer reads 10 s.
 */
import { hostname } from 'node:os';
import { hashBytes, isRecord } from '../protocol.js';
import type { GatewayStoreView } from '../context.js';
import type { LocalTransportLike } from '../local-tasks.js';
import type { ConnectionRowLite } from '../local-transport.js';
import {
  LIMITS, READ_SCHEMA, XagtError, xfail,
  type Coverage, type Envelope, type XagtTool,
} from './common.js';
import {
  canSeeBackend, canSeeClusterInstance, canSeeMaterial, canSeeTask, canSeeVendorSession, canUsePeer,
  type ReaderGrant,
} from './reader-access.js';
import type { MaterialSessionBinding, MaterialStore } from './materials.js';
import { peerCall, type PeerRecord, type PeerStore } from './peer-reader.js';
import type { SourceReader, VendorSessionRow } from './source-reader.js';
import {
  bindingKey, cursorBind, issueRef, openCursor, resolveRef, sealCursor,
  type CursorPayload,
} from './refs.js';
import type { MemberCluster } from '../member-cluster.js';
import type { OriginGrants } from './origin-grants.js';

type Json = Record<string, unknown>;

export interface XagtReadDeps {
  store: GatewayStoreView;
  transport: LocalTransportLike;
  source: SourceReader;
  peers: PeerStore;
  materials: MaterialStore;
  cursorSecret: Uint8Array;
  deviceName?: string;
  now?: () => number;
  cluster?: MemberCluster;
  origins?: OriginGrants;
}

const PAGE_CAP = 20; // vendor transcript route serves ≤20 messages per call.

const optString = (args: Json, name: string, max: number): string | undefined => {
  const v = args[name];
  if (v === undefined) return undefined;
  if (typeof v !== 'string' || v.length > max) xfail('INVALID_REQUEST', `${name} 参数无效。`);
  return v;
};

const optLimit = (args: Json, name: string, def: number, max: number): number => {
  const v = args[name];
  if (v === undefined) return def;
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 1 || v > max) {
    xfail('INVALID_REQUEST', `${name} 必须是 1..${max} 的整数。`);
  }
  return v;
};

const optSha = (args: Json, name: string): string => {
  const v = args[name];
  if (typeof v !== 'string' || !/^[0-9a-fA-F]{64}$/.test(v)) {
    xfail('INVALID_REQUEST', `${name} 必须是列表返回的 sha256。`);
  }
  return (v as string).toLowerCase();
};

/** Exact per-tool argument whitelist — extra fields are rejected (A04). */
const TOOL_ARGS: Record<XagtTool, ReadonlySet<string>> = {
  xagt_list_targets: new Set(['cursor', 'limit']),
  xagt_list_sessions: new Set(['targetRef', 'query', 'cursor', 'limit']),
  xagt_get_activity: new Set(['sessionRef', 'cursor', 'limit']),
  xagt_read_history: new Set(['sessionRef', 'cursor', 'limit', 'aroundMessageRef']),
  xagt_search_history: new Set(['sessionRef', 'query', 'cursor', 'limit']),
  xagt_list_materials: new Set(['sessionRef', 'prefix', 'cursor', 'limit']),
  xagt_read_material: new Set(['materialRef', 'expectedSha256', 'cursor', 'maxBytes']),
  xagt_list_cluster: new Set(),
  xagt_list_handoff_origins: new Set(),
  xagt_resolve_origin: new Set(['handoffRef']),
};

export class XagtReadService {
  private readonly now: () => number;
  private readonly deviceName: string;
  private globalInflight = 0;
  private readonly perReader = new Map<string, number>();
  /** Last verified storeId per connection — lets offline rows stay visible. */
  private readonly lastKnownStoreId = new Map<string, string>();

  constructor(private readonly deps: XagtReadDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.deviceName = deps.deviceName ?? hostname();
  }

  /** Tool dispatch + concurrency budget. */
  async call(reader: ReaderGrant, tool: XagtTool, args: Json): Promise<Envelope> {
    const inFlight = this.perReader.get(reader.readerId) ?? 0;
    if (inFlight >= LIMITS.perReaderInflight || this.globalInflight >= LIMITS.globalInflight) {
      xfail('BUSY', undefined, true);
    }
    for (const key of Object.keys(args)) {
      if (!TOOL_ARGS[tool].has(key)) xfail('INVALID_REQUEST', `不接受的参数字段：${key}。`);
    }
    this.perReader.set(reader.readerId, inFlight + 1);
    this.globalInflight++;
    let outcome = 'OK';
    let envelope: Envelope | undefined;
    try {
      envelope = await ((): Promise<Envelope> => {
        switch (tool) {
          case 'xagt_list_targets': return this.listTargets(reader, args);
          case 'xagt_list_sessions': return this.listSessions(reader, args);
          case 'xagt_get_activity': return this.getActivity(reader, args);
          case 'xagt_read_history': return this.readHistory(reader, args);
          case 'xagt_search_history': return this.searchHistory(reader, args);
          case 'xagt_list_materials': return this.listMaterials(reader, args);
          case 'xagt_read_material': return this.readMaterial(reader, args);
          case 'xagt_list_cluster': return this.listCluster(reader);
          case 'xagt_list_handoff_origins': return this.listOrigins(reader);
          case 'xagt_resolve_origin': return this.resolveOrigin(reader, args.handoffRef);
        }
      })();
      return envelope;
    } catch (error) {
      outcome = error instanceof XagtError ? error.code : 'SOURCE_UNAVAILABLE';
      throw error;
    } finally {
      this.perReader.set(reader.readerId, inFlight);
      this.globalInflight--;
      // Access audit — metadata only (design §13): never bodies or tokens.
      const ref = ['targetRef', 'sessionRef', 'materialRef']
        .map((k) => args[k]).find((v) => typeof v === 'string') ?? '';
      const bytes = envelope === undefined ? 0 : JSON.stringify(envelope.data).length;
      console.error(`[xagt-audit] ${JSON.stringify({
        at: new Date(this.now()).toISOString(), reader: reader.readerId, tool,
        ref, code: outcome, bytes,
      })}`);
    }
  }

  private async listOrigins(reader: ReaderGrant): Promise<Envelope> {
    if (!this.deps.origins) xfail('UNSUPPORTED');
    return this.envelope(
      { deviceName: this.deviceName, agentName: 'xagt-link', adapter: 'work-handoff', access: 'local', ref: '' },
      { level: 'FULL', basis: 'SOURCE_FACTS', limitations: [] },
      { origins: this.deps.origins.list(reader) },
    );
  }

  private async resolveOrigin(reader: ReaderGrant, handoffRef: unknown): Promise<Envelope> {
    const origins = this.deps.origins;
    if (!origins) xfail('UNSUPPORTED');
    const origin = await origins.resolve(reader, handoffRef);
    let sourceAccess = 'FROZEN_ONLY';
    let sessionRef: string | undefined;
    let peerName = origin.sourceHostRef;
    if (origin.peerId) {
      const peer = this.deps.peers.require(origin.peerId);
      peerName = peer.name || peerName;
      const targets = await this.peerTargets(peer);
      const target = targets.find(row => row.backendStoreId === origin.sourceStoreId && row.online === true);
      if (!target || typeof target.targetRef !== 'string') {
        sourceAccess = targets.some(row => row.online === true) ? 'SOURCE_NOT_SHARED' : 'SOURCE_OFFLINE';
      } else {
        try {
          const sessions = await this.listSessions(reader, { targetRef: target.targetRef, query: origin.sourceTaskId, limit: 10 });
          const items = sessions.data.sessions;
          const session = Array.isArray(items) ? items.find(row => isRecord(row) && row.kind === 'MANAGED_TASK'
            && row.title === origin.sourceTaskId && typeof row.sessionRef === 'string'
            && typeof row.projectId === 'string' && canSeeTask(reader, origin.sourceStoreId, row.projectId, origin.sourceTaskId)) : undefined;
          if (session !== undefined) {
            const bound = resolveRef(this.deps.store, session.sessionRef, 'session');
            if (bound.o !== 'p' || bound.p !== origin.peerId) xfail('SCOPE_DENIED');
            sessionRef = issueRef(this.deps.store, 'session', { ...bound, originHandoffRef: handoffRef });
            sourceAccess = 'ONLINE';
          } else sourceAccess = 'SOURCE_NOT_SHARED';
        } catch (error) {
          const denied = error instanceof XagtError && ['SCOPE_DENIED', 'GRANT_EXPIRED', 'NOT_FOUND'].includes(error.code);
          sourceAccess = denied ? 'SOURCE_NOT_SHARED' : 'SOURCE_OFFLINE';
        }
      }
    }
    const latest = await origins.resolve(reader, handoffRef);
    if (latest.peerId !== origin.peerId) { sessionRef = undefined; sourceAccess = 'FROZEN_ONLY'; }
    return this.envelope(
      { deviceName: peerName, agentName: '', adapter: 'verified-handoff-origin', access: 'local', ref: String(handoffRef) },
      { level: sourceAccess === 'ONLINE' ? 'FULL' : 'PARTIAL', basis: 'SOURCE_FACTS',
        limitations: sourceAccess === 'ONLINE' ? [] : [sourceAccess] },
      { handoffRef, sourceHandoffId: origin.sourceHandoffId, sourceHostRef: origin.sourceHostRef,
        manifestDigest: origin.manifestDigest, frozen: origin.publicFacts, sourceAccess,
        ...(sessionRef === undefined ? {} : { sessionRef, sessionCoverage: 'LIVE_AUTHORIZED_HISTORY' }) },
    );
  }

  private async listCluster(reader: ReaderGrant): Promise<Envelope> {
    const cluster = this.deps.cluster;
    if (!cluster) xfail('UNSUPPORTED');
    const value = await cluster.directory();
    if (value.schemaVersion !== 'member-cluster/1' || !Array.isArray(value.computers)) {
      xfail('UNSUPPORTED', '此 Hosted 版本不支持会员集群目录。');
    }
    const computers = Array.isArray(value.computers) ? value.computers.filter(isRecord).map(computer => {
      const instanceId = typeof computer.instanceId === 'string' ? computer.instanceId : undefined;
      if (instanceId === undefined || !canSeeClusterInstance(reader, instanceId)) return undefined;
      const agents = Array.isArray(computer.agents) ? computer.agents.filter(isRecord).map(agent => {
        const targets = Array.isArray(agent.targets) ? agent.targets.filter(isRecord).filter(target =>
          typeof target.backendId === 'string' && canSeeBackend(reader, target.backendId)
          && (reader.projects.length === 0 || typeof target.projectId === 'string' && reader.projects.includes(target.projectId)))
          .map(target => ({ backendId: target.backendId, projectId: target.projectId })) : [];
        if (targets.length === 0 || typeof agent.agentId !== 'string' || typeof agent.displayName !== 'string'
          || typeof agent.reportedName !== 'string' || typeof agent.engineId !== 'string') return undefined;
        return {
          agentId: agent.agentId, displayName: agent.displayName,
          reportedName: agent.reportedName, engineId: agent.engineId,
          ...(typeof agent.avatarRef === 'string' ? { avatarRef: agent.avatarRef } : {}),
          ...(typeof agent.profileRevision === 'number' ? { profileRevision: agent.profileRevision } : {}),
          ...(agent.status === 'available' || agent.status === 'unknown' ? { status: agent.status } : {}),
          targets,
        };
      }).filter(agent => agent !== undefined) : [];
      if (agents.length === 0) return undefined;
      return {
        instanceId,
        ...(typeof computer.deviceId === 'string' ? { deviceId: computer.deviceId } : {}),
        ...(typeof computer.displayName === 'string' ? { displayName: computer.displayName } : {}),
        ...(typeof computer.avatarRef === 'string' ? { avatarRef: computer.avatarRef } : {}),
        ...(typeof computer.profileRevision === 'number' ? { profileRevision: computer.profileRevision } : {}),
        ...(computer.status === 'online' || computer.status === 'offline' ? { status: computer.status } : {}),
        ...(typeof computer.lastSeenAt === 'string' ? { lastSeenAt: computer.lastSeenAt } : {}),
        agents,
      };
    }).filter(computer => computer !== undefined) : [];
    return this.envelope(
      { deviceName: 'Agent Link', agentName: 'xagt-link', adapter: 'member-cluster', access: 'local', ref: '' },
      { level: 'FULL', basis: 'SOURCE_FACTS', limitations: [] },
      {
        schemaVersion: 'member-cluster/1',
        counts: {
          computers: computers.length,
          onlineComputers: computers.filter(computer => computer.status === 'online').length,
          agents: computers.reduce((count, computer) => count + (computer.agents as unknown[]).length, 0),
        },
        computers,
      },
    );
  }

  // ---------------------------------------------------------------------
  // Envelope + cursor helpers.
  // ---------------------------------------------------------------------

  private envelope(source: Envelope['source'], coverage: Coverage, data: Json, nextCursor?: string): Envelope {
    return {
      schemaVersion: READ_SCHEMA,
      source,
      observedAt: new Date(this.now()).toISOString(),
      coverage,
      data,
      ...(nextCursor !== undefined ? { nextCursor } : {}),
    };
  }

  private readerCtx(reader: ReaderGrant): { readerId: string; grantRevision: number } {
    return { readerId: reader.readerId, grantRevision: reader.grantRevision };
  }

  private cursor(reader: ReaderGrant, payload: Omit<CursorPayload, 'v' | 'rid' | 'rev'> & { kind: CursorPayload['kind'] }): string {
    return sealCursor(this.deps.cursorSecret, {
      v: 1, rid: reader.readerId, rev: reader.grantRevision, ...payload,
    } as CursorPayload);
  }

  private open(
    reader: ReaderGrant, raw: string | undefined, kind: CursorPayload['kind'] | readonly CursorPayload['kind'][],
    expectedFor?: string, expectedQ?: string,
  ): CursorPayload | undefined {
    if (raw === undefined) return undefined;
    return openCursor(this.deps.cursorSecret, raw, this.readerCtx(reader), kind, expectedFor, expectedQ);
  }

  /** Local deadline — every source call is bounded to now+5 s. */
  private get deadlineLocal(): number {
    return this.now() + LIMITS.localDeadlineMillis;
  }

  private get deadlinePeer(): number {
    return this.now() + LIMITS.peerDeadlineMillis;
  }

  // ---------------------------------------------------------------------
  // Peer forwarding — unwrap local refs to remote refs, re-wrap results.
  // ---------------------------------------------------------------------

  private async peerForward(
    reader: ReaderGrant, binding: Json, tool: XagtTool, args: Json, refKey: 'targetRef' | 'sessionRef' | 'materialRef',
  ): Promise<Envelope> {
    const peerId = String(binding.p);
    if (!canUsePeer(reader, peerId)) xfail('SCOPE_DENIED');
    const originRef = typeof binding.originHandoffRef === 'string' ? binding.originHandoffRef : undefined;
    if (originRef !== undefined && (await this.deps.origins?.resolve(reader, originRef))?.peerId !== peerId) xfail('SCOPE_DENIED');
    const peer = this.deps.peers.require(peerId);
    const remoteArgs: Json = { ...args };
    remoteArgs[refKey] = binding.r;
    // A wrapped continuation cursor carries the remote cursor verbatim.
    if (typeof args.cursor === 'string') {
      const opened = this.open(reader, args.cursor, 'peer', bindingKey(binding));
      if (typeof opened?.remote !== 'string') xfail('CURSOR_EXPIRED');
      remoteArgs.cursor = opened.remote;
    }
    const { status, json } = await peerCall(peer, this.deps.peers.token(peer), tool, remoteArgs, this.deadlinePeer);
    if (status !== 200) {
      this.mapPeerStatus(status, json);
    }
    if (!isRecord(json) || json.ok !== true || !isRecord(json.result)) {
      if (isRecord(json) && json.ok === false && isRecord(json.error)) {
        const e = json.error;
        throw new XagtError(
          typeof e.code === 'string' ? e.code : 'SOURCE_UNAVAILABLE',
          typeof e.message === 'string' ? e.message.slice(0, 512) : 'peer 读取失败。',
          e.retryable === true);
      }
      xfail('SOURCE_UNAVAILABLE', 'peer 响应无效。', true);
    }
    const remote = json.result as Json;
    // Re-wrap remote refs + cursor so the model only ever sees local handles.
    const data = isRecord(remote.data) ? { ...remote.data } : {};
    if (originRef !== undefined && (await this.deps.origins?.resolve(reader, originRef))?.peerId !== peerId) xfail('SCOPE_DENIED');
    this.rewrapRefs(data, peerId, originRef);
    const remoteCursor = typeof remote.nextCursor === 'string' ? remote.nextCursor : undefined;
    const localCursor = remoteCursor !== undefined
      ? this.cursor(reader, { kind: 'peer', for: bindingKey(binding), remote: remoteCursor })
      : undefined;
    const source = isRecord(remote.source) ? remote.source : {};
    return this.envelope(
      {
        deviceName: typeof source.deviceName === 'string' ? source.deviceName : peer.name,
        agentName: typeof source.agentName === 'string' ? source.agentName : '',
        adapter: typeof source.adapter === 'string' ? source.adapter : 'xagt-peer',
        access: 'peer',
        ref: typeof args[refKey] === 'string' ? args[refKey] as string : '',
      },
      this.coverageFrom(remote.coverage),
      data,
      localCursor,
    );
  }

  private rewrapRefs(data: Json, peerId: string, originRef?: string): void {
    const wrap = (value: unknown, kind: 'target' | 'session' | 'material'): string | undefined =>
      typeof value === 'string' && value.length > 0
        ? issueRef(this.deps.store, kind, { v: 1, o: 'p', p: peerId, r: value,
          ...(originRef === undefined ? {} : { originHandoffRef: originRef }) })
        : undefined;
    for (const key of ['targets', 'sessions', 'materials', 'messages', 'matches', 'events']) {
      const list = data[key];
      if (!Array.isArray(list)) continue;
      for (const item of list) {
        if (!isRecord(item)) continue;
        for (const [field, kind] of [['targetRef', 'target'], ['sessionRef', 'session'], ['materialRef', 'material']] as const) {
          const wrapped = wrap(item[field], kind);
          if (wrapped !== undefined) item[field] = wrapped;
        }
      }
    }
    // Session-bound reads echo their ref inside source; leave as the local arg.
    for (const key of ['targetRef', 'sessionRef', 'materialRef']) {
      const wrapped = wrap(data[key], key === 'targetRef' ? 'target' : key === 'sessionRef' ? 'session' : 'material');
      if (wrapped !== undefined) data[key] = wrapped;
    }
  }

  private mapPeerStatus(status: number, json: unknown): never {
    const code = isRecord(json) && typeof json.code === 'string' ? json.code : '';
    if (status === 401) xfail('SCOPE_DENIED', 'peer 拒绝了读取凭据。');
    if (status === 403) xfail('SCOPE_DENIED');
    if (status === 404) xfail('NOT_FOUND');
    if (status === 410) xfail('GRANT_EXPIRED', 'peer 侧授权已撤销或到期。');
    if (status === 429) xfail('BUSY', 'peer 读取服务繁忙。', true);
    if (code === 'CURSOR_EXPIRED' || code === 'MATERIAL_CHANGED' || code === 'NOT_FOUND'
        || code === 'SCOPE_DENIED' || code === 'UNSUPPORTED' || code === 'CONTENT_TOO_LARGE'
        || code === 'UNSUPPORTED_MEDIA' || code === 'GRANT_EXPIRED' || code === 'BUSY'
        || code === 'INVALID_REQUEST') {
      xfail(code, undefined, code === 'BUSY');
    }
    xfail('SOURCE_UNAVAILABLE', `peer 返回 ${status}。`, true);
  }

  private coverageFrom(raw: unknown): Coverage {
    if (!isRecord(raw)) return { level: 'UNKNOWN', basis: 'PEER', limitations: [] };
    const level = raw.level === 'FULL' || raw.level === 'PARTIAL' ? raw.level : 'UNKNOWN';
    const basis = raw.basis === 'SOURCE_FACTS' || raw.basis === 'TRANSCRIPT'
      || raw.basis === 'FILE' ? raw.basis : 'PEER';
    return {
      level, basis,
      limitations: Array.isArray(raw.limitations)
        ? raw.limitations.filter((l): l is string => typeof l === 'string').slice(0, 16) : [],
      ...(isRecord(raw.range) ? { range: raw.range } : {}),
    };
  }

  // ---------------------------------------------------------------------
  // Binding helpers.
  // ---------------------------------------------------------------------

  private localBackend(binding: Json): { connectionId: string; storeId: string } {
    return { connectionId: String(binding.c ?? ''), storeId: String(binding.b ?? '') };
  }

  /** Verify the live backend identity still matches the ref's pinned storeId. */
  private async verifyBackend(binding: Json, deadline: number): Promise<string> {
    const { connectionId, storeId } = this.localBackend(binding);
    const catalog = await this.deps.source.catalog(connectionId, deadline);
    if (catalog.storeId !== storeId) xfail('NOT_FOUND', '来源身份已变化，引用失效。');
    this.lastKnownStoreId.set(connectionId, storeId);
    return storeId;
  }

  /** Managed-task scope needs the live projectId — facts() is the authority. */
  private async taskScope(
    reader: ReaderGrant, binding: Json, deadline: number,
  ): Promise<Json> {
    const { connectionId, storeId } = this.localBackend(binding);
    const facts = await this.deps.source.facts(connectionId, String(binding.t), storeId, deadline);
    const projectId = typeof facts.projectId === 'string' ? facts.projectId : '';
    if (!canSeeTask(reader, storeId, projectId, String(binding.t))) xfail('SCOPE_DENIED');
    return facts;
  }

  private sessionScope(reader: ReaderGrant, binding: Json): void {
    if (binding.o === 'p') {
      if (!canUsePeer(reader, String(binding.p))) xfail('SCOPE_DENIED');
      return;
    }
    const storeId = String(binding.b ?? '');
    if (binding.k === 'v') {
      if (!canSeeVendorSession(reader, storeId, String(binding.e ?? ''), String(binding.s ?? ''))) {
        xfail('SCOPE_DENIED');
      }
    } else {
      // Managed-task scope is re-verified against live facts by taskScope().
      if (!canSeeBackend(reader, storeId)) xfail('SCOPE_DENIED');
    }
  }

  private sessionBindingOf(entry: { session?: MaterialSessionBinding }): MaterialSessionBinding | undefined {
    return entry.session;
  }

  private matchesSession(entrySession: MaterialSessionBinding | undefined, binding: Json): boolean {
    // An unbound entry is device-wide material (design §254 — the session
    // binding is provenance, not an access grant): any local session can list
    // it. A bound entry is listed only under its own session.
    if (entrySession === undefined) return binding.o === 'l';
    if (binding.o !== 'l') return false;
    if (entrySession.backendStoreId !== String(binding.b ?? '')) return false;
    if (binding.k === 't') {
      return entrySession.kind === 'MANAGED_TASK' && entrySession.taskId === String(binding.t ?? '');
    }
    return entrySession.kind === 'VENDOR_SESSION'
      && entrySession.engine === String(binding.e ?? '')
      && entrySession.sessionId === String(binding.s ?? '');
  }

  // ---------------------------------------------------------------------
  // M1 — discovery.
  // ---------------------------------------------------------------------

  private async listTargets(reader: ReaderGrant, args: Json): Promise<Envelope> {
    const limit = optLimit(args, 'limit', LIMITS.targetsDefault, LIMITS.targetsMax);
    const qHash = cursorBind('');
    const opened = this.open(reader, optString(args, 'cursor', 4096), 'targets', undefined, qHash);
    const offset = typeof opened?.off === 'number' ? opened.off : 0;
    const deadline = this.deadlineLocal;

    const targets: Json[] = [];
    for (const row of this.deps.transport.workerLocalRows()) {
      targets.push(await this.localTarget(reader, row, deadline));
    }
    for (const peer of this.deps.peers.list()) {
      if (!canUsePeer(reader, peer.peerId)) continue;
      targets.push(...(await this.peerTargets(peer)));
    }

    const page = targets.slice(offset, offset + limit);
    const next = offset + limit < targets.length
      ? this.cursor(reader, { kind: 'targets', q: qHash, off: offset + limit })
      : undefined;
    return this.envelope(
      { deviceName: this.deviceName, agentName: 'xagt-link', adapter: 'xagt-read', access: 'local', ref: '' },
      { level: 'FULL', basis: 'SOURCE_FACTS', limitations: [] },
      { targets: page },
      next,
    );
  }

  private async localTarget(reader: ReaderGrant, row: ConnectionRowLite, deadline: number): Promise<Json> {
    const base: Json = {
      deviceName: this.deviceName,
      adapter: 'worker-local',
      access: 'local',
      connectionId: row.connectionId,
    };
    try {
      const catalog = await this.deps.source.catalog(row.connectionId, deadline);
      if (!canSeeBackend(reader, catalog.storeId)) {
        return { ...base, online: true, authorized: false, agentName: row.displayName ?? row.connectionId };
      }
      this.lastKnownStoreId.set(row.connectionId, catalog.storeId);
      const history = await this.probeHistory(row.connectionId, catalog.storeId, deadline);
      const targetRef = issueRef(this.deps.store, 'target', { v: 1, o: 'l', c: row.connectionId, b: catalog.storeId });
      const primary = catalog.engines[0];
      return {
        ...base,
        targetRef,
        online: true,
        authorized: true,
        agentName: primary?.engineId ?? row.displayName ?? row.connectionId,
        ...(primary?.engineVersion !== undefined ? { agentVersion: primary.engineVersion } : {}),
        backendStoreId: catalog.storeId,
        engineIds: catalog.engines.map((e) => e.engineId),
        projects: catalog.projects.map((p) => ({ projectId: p.projectId, ...(p.displayName !== undefined ? { displayName: p.displayName } : {}) })),
        capabilities: {
          read: {
            activity: 'SUPPORTED',
            history: history ? 'SUPPORTED' : 'UNSUPPORTED',
            search: history ? 'SUPPORTED' : 'UNSUPPORTED',
            materials: 'SUPPORTED',
          },
          ...(primary?.capabilities !== undefined ? { sourceActions: primary.capabilities } : {}),
        },
      };
    } catch {
      // Offline/unavailable source — the row stays visible when the last
      // verified identity is inside the reader's backend scope (or the grant
      // is backend-wide). Details only come from cached facts, never guessed.
      const known = this.lastKnownStoreId.get(row.connectionId);
      const authorized = known !== undefined
        ? canSeeBackend(reader, known)
        : reader.backends.includes('*');
      if (known === undefined && !authorized) {
        return { ...base, online: false, authorized: false, agentName: row.displayName ?? row.connectionId };
      }
      return {
        ...base,
        ...(authorized && known !== undefined
          ? { targetRef: issueRef(this.deps.store, 'target', { v: 1, o: 'l', c: row.connectionId, b: known }) } : {}),
        online: false,
        authorized,
        agentName: row.displayName ?? row.connectionId,
        ...(known !== undefined ? { backendStoreId: known } : {}),
      };
    }
  }

  private async probeHistory(connectionId: string, storeId: string, deadline: number): Promise<boolean> {
    try {
      await this.deps.source.listVendorSessions(connectionId, { limit: 1 }, storeId, deadline);
      return true;
    } catch {
      return false;
    }
  }

  private async peerTargets(peer: PeerRecord): Promise<Json[]> {
    const offline = {
      deviceName: peer.name || peer.peerId,
      agentName: 'xagt-link',
      adapter: 'xagt-peer',
      access: 'peer',
      peerId: peer.peerId,
      online: false,
      authorized: true,
      targetRef: issueRef(this.deps.store, 'target', { v: 1, o: 'p', p: peer.peerId }),
    };
    try {
      const { status, json } = await peerCall(
        peer, this.deps.peers.token(peer), 'xagt_list_targets', { limit: LIMITS.targetsMax }, this.deadlinePeer);
      if (status !== 200 || !isRecord(json) || json.ok !== true || !isRecord(json.result)) {
        return [offline];
      }
      const data = (json.result as Json).data;
      const items = isRecord(data) && Array.isArray(data.targets) ? data.targets : [];
      if (items.length === 0) return [offline];
      const out: Json[] = [];
      for (const item of items) {
        if (!isRecord(item) || typeof item.targetRef !== 'string') continue;
        out.push({
          ...item,
          targetRef: issueRef(this.deps.store, 'target', { v: 1, o: 'p', p: peer.peerId, r: item.targetRef }),
          deviceName: typeof item.deviceName === 'string' ? item.deviceName : peer.name,
          access: 'peer',
          peerId: peer.peerId,
        });
      }
      return out.length > 0 ? out : [offline];
    } catch {
      return [offline];
    }
  }

  // ---------------------------------------------------------------------
  // M1 — sessions.
  // ---------------------------------------------------------------------

  private async listSessions(reader: ReaderGrant, args: Json): Promise<Envelope> {
    const targetRef = optString(args, 'targetRef', 512);
    if (targetRef === undefined) xfail('INVALID_REQUEST', '缺少 targetRef。');
    const limit = optLimit(args, 'limit', LIMITS.sessionsDefault, LIMITS.sessionsMax);
    const query = optString(args, 'query', LIMITS.queryMax)?.toLowerCase();
    const binding = resolveRef(this.deps.store, targetRef, 'target');
    const forKey = bindingKey(binding);
    const qHash = cursorBind(query ?? '');

    if (binding.o === 'p') {
      return this.peerForward(reader, binding, 'xagt_list_sessions',
        { targetRef: binding.r, ...(query !== undefined ? { query } : {}), ...(args.cursor !== undefined ? { cursor: args.cursor } : {}), limit },
        'targetRef');
    }

    const opened = this.open(reader, optString(args, 'cursor', 4096), 'sessions', forKey, qHash);
    const storeId = await this.verifyBackend(binding, this.deadlineLocal);
    const { connectionId } = this.localBackend(binding);
    const deadline = this.deadlineLocal;

    // Managed tasks are a small bounded set — always enumerated first.
    const taskOffset = typeof opened?.tc === 'number' ? opened.tc : 0;
    const tasks = (await this.deps.source.listTasks(connectionId, storeId, deadline))
      .filter((t) => canSeeTask(reader, storeId, t.projectId, t.taskId))
      .filter((t) => query === undefined || t.taskId.toLowerCase().includes(query)
        || t.state.toLowerCase().includes(query));

    const sessions: Json[] = [];
    let cursorState: { tc?: number; vc?: string; ve?: string } = {};
    let remaining = limit;
    let emittedTasks = 0;
    for (const t of tasks.slice(taskOffset)) {
      if (remaining <= 0) break;
      sessions.push(this.taskSession(binding, t));
      remaining--;
      emittedTasks++;
    }
    if (taskOffset + emittedTasks < tasks.length) cursorState.tc = taskOffset + emittedTasks;
    // Vendor sessions page through the source's own cursor — the upstream
    // requires the paged engine alongside its cursor, so `ve` rides along.
    if (remaining > 0) {
      const vendorCursor = typeof opened?.vc === 'string' ? opened.vc : undefined;
      const vendorEngine = typeof opened?.ve === 'string' ? opened.ve : undefined;
      const page = await this.deps.source.listVendorSessions(
        connectionId, {
          ...(query !== undefined ? { q: query } : {}),
          ...(vendorEngine !== undefined ? { engine: vendorEngine } : {}),
          ...(vendorCursor !== undefined ? { cursor: vendorCursor } : {}),
          limit: Math.min(50, remaining + 1),
        },
        storeId, deadline);
      for (const row of page.items.slice(0, remaining)) {
        if (!canSeeVendorSession(reader, storeId, row.engine, row.id)) continue;
        sessions.push(this.vendorSession(binding, row));
      }
      if (page.pageCursor !== undefined) {
        cursorState = {
          ...cursorState, vc: page.pageCursor,
          ...(page.pageEngine !== undefined ? { ve: page.pageEngine } : {}),
        };
      }
    }
    const moreTasks = taskOffset + emittedTasks < tasks.length;
    const hasNext = moreTasks || cursorState.vc !== undefined;
    const next = hasNext
      ? this.cursor(reader, { kind: 'sessions', for: forKey, q: qHash, ...cursorState })
      : undefined;
    return this.envelope(
      this.localSource(String(binding.c), targetRef),
      { level: 'FULL', basis: 'SOURCE_FACTS', limitations: [] },
      { sessions },
      next,
    );
  }

  private taskSession(binding: Json, t: { taskId: string; engineId: string; projectId: string; state: string }): Json {
    const sessionRef = issueRef(this.deps.store, 'session', {
      v: 1, o: 'l', c: binding.c, b: binding.b, k: 't', t: t.taskId,
    });
    return {
      sessionRef,
      kind: 'MANAGED_TASK',
      title: t.taskId,
      engine: t.engineId,
      projectId: t.projectId,
      state: t.state,
      facts: { activity: 'SUPPORTED', history: 'SUPPORTED', search: 'SUPPORTED', materials: 'SUPPORTED' },
    };
  }

  private vendorSession(binding: Json, row: VendorSessionRow): Json {
    const sessionRef = issueRef(this.deps.store, 'session', {
      v: 1, o: 'l', c: binding.c, b: binding.b, k: 'v', e: row.engine, s: row.id,
    });
    return {
      sessionRef,
      kind: 'VENDOR_SESSION',
      title: row.title,
      engine: row.engine,
      source: row.source,
      at: row.at,
      liveHint: row.live === true,
      ...(row.cwd !== undefined ? { cwd: row.cwd } : {}),
      facts: { activity: 'PARTIAL', history: 'SUPPORTED', search: 'SUPPORTED', materials: 'SUPPORTED' },
    };
  }

  private localSource(connectionId: string, ref: string): Envelope['source'] {
    return {
      deviceName: this.deviceName,
      agentName: connectionId,
      adapter: 'worker-local',
      access: 'local',
      ref,
    };
  }

  // ---------------------------------------------------------------------
  // M2 — activity.
  // ---------------------------------------------------------------------

  private async getActivity(reader: ReaderGrant, args: Json): Promise<Envelope> {
    const sessionRef = optString(args, 'sessionRef', 512);
    if (sessionRef === undefined) xfail('INVALID_REQUEST', '缺少 sessionRef。');
    const limit = optLimit(args, 'limit', LIMITS.activityDefault, LIMITS.activityMax);
    const binding = resolveRef(this.deps.store, sessionRef, 'session');
    const forKey = bindingKey(binding);
    this.sessionScope(reader, binding);
    if (binding.o === 'p') {
      return this.peerForward(reader, binding, 'xagt_get_activity',
        { sessionRef: binding.r, ...(args.cursor !== undefined ? { cursor: args.cursor } : {}), limit }, 'sessionRef');
    }
    if (binding.k === 'v') {
      // Vendor sessions expose no event feed — no cursor domain exists.
      if (args.cursor !== undefined) xfail('CURSOR_EXPIRED');
      return this.vendorActivity(reader, sessionRef, binding, limit);
    }
    return this.taskActivity(reader, sessionRef, binding, limit, args, forKey);
  }

  private async taskActivity(
    reader: ReaderGrant, sessionRef: string, binding: Json, limit: number, args: Json, forKey: string,
  ): Promise<Envelope> {
    const deadline = this.deadlineLocal;
    const { connectionId, storeId } = this.localBackend(binding);
    const opened = this.open(reader, optString(args, 'cursor', 4096), 'activity', forKey);
    const facts = await this.taskScope(reader, binding, deadline);
    const eventsCursor = typeof opened?.ev === 'number' ? opened.ev : undefined;
    const [events, inputs, output] = await Promise.all([
      this.deps.source.events(connectionId, String(binding.t), { ...(eventsCursor !== undefined ? { cursor: eventsCursor } : {}), limit }, storeId, deadline),
      this.deps.source.inputRequests(connectionId, String(binding.t), storeId, deadline),
      this.deps.source.output(connectionId, String(binding.t), storeId, deadline),
    ]);
    if (events.cursorExpired) xfail('CURSOR_EXPIRED');
    const items = events.items.map((e) => {
      const { cursor, ...rest } = e;
      const json = JSON.stringify(rest);
      const bounded = json.length > LIMITS.eventJsonMax
        ? { eventTruncated: true, kind: rest.kind, occurredAt: rest.occurredAt }
        : rest;
      return { eventRef: `e${String(cursor)}`, ...bounded };
    });
    // Only mint the event cursor when the upstream gave a real sequence —
    // a malformed nextCursor must not poison the next incremental read.
    const evNext = Number(events.nextCursor);
    const next = Number.isSafeInteger(evNext)
      ? this.cursor(reader, { kind: 'activity', for: forKey, ev: evNext })
      : undefined;
    const caps = isRecord(facts.capabilities) ? facts.capabilities : {};
    const stateBucket = Math.floor(this.now() / 300_000);
      const expectedStateRef = (reader.actions ?? []).includes('INTERACT') && facts.engineId === 'sage-pi' && caps.followUp === true
      && typeof facts.generation === 'string' && typeof facts.nativeSessionId === 'string'
      && typeof facts.currentCommandId === 'string'
      ? issueRef(this.deps.store, 'state', {
      v: 1, o: 'l', c: binding.c, b: binding.b, k: 't', t: binding.t,
      p: facts.projectId, g: facts.generation, s: facts.nativeSessionId,
      ...(typeof facts.nativeTurnId === 'string' ? { turn: facts.nativeTurnId } : {}),
      cmd: facts.currentCommandId, readerId: reader.readerId, revision: reader.grantRevision,
      expiresAt: (stateBucket + 2) * 300_000,
    }) : undefined;
    return this.envelope(
      this.localSource(String(binding.c), sessionRef),
      { level: 'FULL', basis: 'SOURCE_FACTS', limitations: [] },
      {
        incremental: true,
        state: facts.state,
        reasonCode: facts.reasonCode,
        goal: facts.goal,
        displayName: facts.displayName,
        quiescent: facts.quiescent === true,
        generation: facts.generation,
        nativeSessionId: facts.nativeSessionId,
        nativeTurnId: facts.nativeTurnId,
        currentCommandId: facts.currentCommandId,
        ...(expectedStateRef === undefined ? {} : { expectedStateRef }),
        configuredModel: facts.configuredModel,
        projectId: facts.projectId,
        engineId: facts.engineId,
        sourceActions: caps,
        waitingFor: inputs.slice(0, 16),
        outputPreview: typeof output.text === 'string' ? output.text.slice(-2048) : '',
        ...(output.coverage !== undefined ? { outputCoverage: output.coverage } : {}),
        events: items,
      },
      next,
    );
  }

  /** Vendor sessions expose no event feed — honest PARTIAL over the transcript tail. */
  private async vendorActivity(
    reader: ReaderGrant, sessionRef: string, binding: Json, limit: number,
  ): Promise<Envelope> {
    const deadline = this.deadlineLocal;
    const { connectionId, storeId } = this.localBackend(binding);
    const page = await this.deps.source.transcript(
      connectionId,
      { sessionId: String(binding.s), engine: String(binding.e), limit: Math.min(5, Math.max(1, limit)) },
      storeId, deadline);
    const last = page.items.at(-1);
    return this.envelope(
      this.localSource(String(binding.c), sessionRef),
      {
        level: 'PARTIAL', basis: 'TRANSCRIPT',
        limitations: ['NO_EVENTS', 'NO_WAITING_ITEMS', 'STATE_INFERRED', 'INCREMENTAL_UNSUPPORTED'],
      },
      {
        incremental: false,
        state: 'UNKNOWN',
        messageCount: page.items.length > 0 ? Number(page.items.at(-1)!.id ?? 0) : 0,
        ...(last !== undefined ? {
          lastMessage: {
            messageRef: `v${String(last.id)}`,
            role: last.role,
            text: typeof last.text === 'string' ? last.text.slice(0, 2048) : '',
            truncated: last.truncated === true,
          },
        } : {}),
      },
    );
  }

  // ---------------------------------------------------------------------
  // M3 — history.
  // ---------------------------------------------------------------------

  private async readHistory(reader: ReaderGrant, args: Json): Promise<Envelope> {
    const sessionRef = optString(args, 'sessionRef', 512);
    if (sessionRef === undefined) xfail('INVALID_REQUEST', '缺少 sessionRef。');
    const limit = optLimit(args, 'limit', LIMITS.historyDefault, LIMITS.historyMax);
    const around = optString(args, 'aroundMessageRef', 128);
    // aroundMessageRef and cursor are mutually exclusive (design §7).
    if (around !== undefined && args.cursor !== undefined) xfail('INVALID_REQUEST', 'aroundMessageRef 与 cursor 互斥。');
    const binding = resolveRef(this.deps.store, sessionRef, 'session');
    const forKey = bindingKey(binding);
    this.sessionScope(reader, binding);
    if (binding.o === 'p') {
      return this.peerForward(reader, binding, 'xagt_read_history',
        { sessionRef: binding.r, ...(args.cursor !== undefined ? { cursor: args.cursor } : {}), ...(around !== undefined ? { aroundMessageRef: around } : {}), limit }, 'sessionRef');
    }
    const opened = this.open(
      reader, optString(args, 'cursor', 4096), ['history', 'content'], forKey);
    if (binding.k === 'v') {
      return this.vendorHistory(reader, sessionRef, binding, limit, around, opened);
    }
    return this.taskHistory(reader, sessionRef, binding, limit, around, opened, forKey);
  }

  private mapMessage(role: unknown): string {
    return role === 'user' ? 'USER' : role === 'assistant' ? 'ASSISTANT' : 'EVENT';
  }

  /** Slice a long message body into ≤messageTextMax pages with continuation. */
  private messagePage(
    reader: ReaderGrant, forKey: string, msgHash: string, marker: Json,
    text: string, sourceTruncated: boolean,
  ): { text: string; truncated: boolean; nextContentCursor?: string } {
    const off = typeof marker.off === 'number' ? marker.off : 0;
    const slice = text.slice(off, off + LIMITS.messageTextMax);
    const done = off + slice.length >= text.length;
    const truncated = sourceTruncated || !done;
    return {
      text: slice,
      truncated,
      ...(!done && !sourceTruncated ? {
        nextContentCursor: this.cursor(reader, {
          kind: 'content', for: forKey, msg: msgHash,
          seq: marker.seq, idx: marker.idx, off: off + slice.length,
        }),
      } : {}),
    };
  }

  private async taskHistory(
    reader: ReaderGrant, sessionRef: string, binding: Json, limit: number,
    around: string | undefined, opened: CursorPayload | undefined, forKey: string,
  ): Promise<Envelope> {
    const deadline = this.deadlineLocal;
    const { connectionId, storeId } = this.localBackend(binding);
    const taskId = String(binding.t);
    await this.taskScope(reader, binding, deadline);

    // Content continuation: cursor binds (session ref, message seq, offset).
    if (opened?.kind === 'content') {
      if (typeof opened.seq !== 'number') xfail('CURSOR_EXPIRED');
      const page = await this.deps.source.messages(
        connectionId, taskId, { before: opened.seq + 1, limit: 1 }, storeId, deadline);
      const item = page.items.find((m) => Number(m.sequence) === opened.seq);
      if (item === undefined || typeof item.text !== 'string') xfail('CURSOR_EXPIRED');
      const messageRef = `m${String(item.sequence)}`;
      if (opened.msg !== cursorBind(messageRef)) xfail('CURSOR_EXPIRED');
      const part = this.messagePage(reader, forKey, String(opened.msg), opened, item.text, item.textTruncated === true);
      return this.envelope(
        this.localSource(String(binding.c), sessionRef),
        { level: 'FULL', basis: 'SOURCE_FACTS', limitations: [] },
        {
          messages: [{
            messageRef, role: item.role, kind: this.mapMessage(item.role),
            text: part.text, truncated: part.truncated,
            occurredAt: item.occurredAt, updatedAt: item.updatedAt,
            status: item.status,
            ...(part.nextContentCursor !== undefined ? { nextContentCursor: part.nextContentCursor } : {}),
          }],
          historyMode: 'STRUCTURED_FROM_START',
        },
      );
    }

    // First read anchors the high-water (latest sequence) — later pages stay
    // inside that snapshot so new messages don't shift the paging window.
    let highWater = typeof opened?.hw === 'number' ? opened.hw : 0;
    let before: number | undefined;
    let pageLimit = limit;
    if (around !== undefined) {
      const seq = this.parseMessageSeq(around, 'm');
      before = seq + 6;
      pageLimit = 11;
      highWater = highWater || (await this.latestSeq(connectionId, taskId, storeId, deadline)) || 0;
    } else if (opened !== undefined && typeof opened.next === 'number') {
      before = opened.next;
      highWater = opened.hw as number;
    } else {
      const latest = await this.latestSeq(connectionId, taskId, storeId, deadline);
      highWater = latest ?? 0;
      before = highWater + 1;
    }
    const page = await this.deps.source.messages(
      connectionId, taskId, { ...(before !== undefined ? { before } : {}), limit: pageLimit }, storeId, deadline);
    const limitations: string[] = [];
    const messages = page.items.map((item) => {
      const seq = Number(item.sequence);
      const messageRef = `m${seq}`;
      const text = typeof item.text === 'string' ? item.text : '';
      const part = this.messagePage(
        reader, forKey, cursorBind(messageRef),
        { seq }, text, item.textTruncated === true);
      if (item.textTruncated === true) limitations.push('SOURCE_TRUNCATED_MESSAGES');
      return {
        messageRef, role: item.role, kind: this.mapMessage(item.role),
        text: part.text, truncated: part.truncated,
        occurredAt: item.occurredAt, updatedAt: item.updatedAt,
        ...(item.nativeTurnId !== undefined ? { nativeTurnId: item.nativeTurnId } : {}),
        status: item.status,
        ...(part.nextContentCursor !== undefined ? { nextContentCursor: part.nextContentCursor } : {}),
      };
    });
    const firstSeq = messages.length > 0 ? Number(messages[0]!.messageRef.slice(1)) : null;
    const hasOlder = firstSeq !== null && firstSeq > 1;
    const next = hasOlder
      ? this.cursor(reader, { kind: 'history', for: forKey, hw: highWater, next: firstSeq })
      : undefined;
    return this.envelope(
      this.localSource(String(binding.c), sessionRef),
      {
        level: 'FULL', basis: 'SOURCE_FACTS',
        limitations: [...new Set(limitations)],
        range: { highWater, oldestSequence: firstSeq, around: around ?? null },
      },
      { messages, historyMode: 'STRUCTURED_FROM_START' },
      next,
    );
  }

  private async latestSeq(connectionId: string, taskId: string, storeId: string, deadline: number): Promise<number | null> {
    const page = await this.deps.source.messages(connectionId, taskId, { limit: 1 }, storeId, deadline);
    return page.latestSequence;
  }

  private parseMessageSeq(ref: string, prefix: 'm' | 'v'): number {
    const match = new RegExp(`^${prefix}([1-9][0-9]*)$`).exec(ref);
    if (match === null) xfail('INVALID_REQUEST', 'aroundMessageRef 必须是本会话返回的 messageRef。');
    return Number(match[1]);
  }

  /**
   * Vendor transcripts page in ≤20-message windows, newest block first.
   * Blocks are reassembled into one ascending (chronological) page — matching
   * the managed-task history order so callers see one consistent contract.
   */
  private async vendorPage(
    connectionId: string, sessionId: string, engine: string,
    before: number | undefined, limit: number, storeId: string, deadline: number,
  ): Promise<{ items: Json[]; oldestIndex: number | null }> {
    const blocks: Json[][] = [];
    let pulled = 0;
    let bound = before;
    let oldest: number | null = null;
    while (pulled < limit) {
      const want = Math.min(PAGE_CAP, limit - pulled);
      const page = await this.deps.source.transcript(
        connectionId,
        { sessionId, engine, ...(bound !== undefined ? { before: bound } : {}), limit: want },
        storeId, deadline);
      if (page.items.length === 0) break;
      blocks.push(page.items);
      pulled += page.items.length;
      const first = Number(page.items[0]!.id);
      if (Number.isSafeInteger(first)) { oldest = first; bound = first; }
      if (page.items.length < want) break;
    }
    const items = blocks.reverse().flat().slice(0, limit);
    return { items, oldestIndex: oldest };
  }

  private async vendorHistory(
    reader: ReaderGrant, sessionRef: string, binding: Json, limit: number,
    around: string | undefined, opened: CursorPayload | undefined,
  ): Promise<Envelope> {
    const deadline = this.deadlineLocal;
    const { connectionId, storeId } = this.localBackend(binding);
    const sessionId = String(binding.s);
    const engine = String(binding.e);
    const forKey = bindingKey(binding);
    let before: number | undefined;
    let highWater = typeof opened?.hw === 'number' ? opened.hw : 0;
    if (around !== undefined) {
      before = this.parseMessageSeq(around, 'v') + 6;
    } else if (opened !== undefined && opened.kind === 'history' && typeof opened.next === 'number') {
      before = opened.next;
      highWater = opened.hw as number;
    }
    const { items, oldestIndex } = await this.vendorPage(
      // An around read is a fixed ±5 window, matching the managed path.
      connectionId, sessionId, engine, before, around !== undefined ? 11 : limit, storeId, deadline);
    if (items.length === 0 && before !== undefined) xfail('CURSOR_EXPIRED', '会话内容已轮换或游标越界。');
    const maxIndex = items.length > 0 ? Number(items.at(-1)!.id) : 0;
    if (highWater === 0) highWater = maxIndex;
    const limitations: string[] = [];
    const messages = items.map((item) => {
      const idx = Number(item.id);
      const messageRef = `v${idx}`;
      const text = typeof item.text === 'string' ? item.text : '';
      const truncated = item.truncated === true;
      if (truncated) limitations.push('SOURCE_TRUNCATES_MESSAGES');
      // The source caps message text at 4000 chars — no continuation exists.
      return {
        messageRef, role: item.role, kind: this.mapMessage(item.role),
        text: text.slice(0, LIMITS.messageTextMax), truncated,
        ...(truncated ? { sourceLimit: 4000 } : {}),
      };
    });
    const hasOlder = oldestIndex !== null && oldestIndex > 1;
    const next = hasOlder
      ? this.cursor(reader, { kind: 'history', for: forKey, hw: highWater, next: oldestIndex })
      : undefined;
    return this.envelope(
      this.localSource(String(binding.c), sessionRef),
      {
        level: limitations.length > 0 ? 'PARTIAL' : 'FULL', basis: 'TRANSCRIPT',
        limitations: [...new Set(limitations)],
        range: { highWater, oldestIndex, around: around ?? null },
      },
      { messages },
      next,
    );
  }

  // ---------------------------------------------------------------------
  // M3 — history search.
  // ---------------------------------------------------------------------

  private async searchHistory(reader: ReaderGrant, args: Json): Promise<Envelope> {
    const sessionRef = optString(args, 'sessionRef', 512);
    const query = optString(args, 'query', LIMITS.queryMax);
    if (sessionRef === undefined || query === undefined || query === '') {
      xfail('INVALID_REQUEST', '缺少 sessionRef 或 query。');
    }
    const limit = optLimit(args, 'limit', LIMITS.searchDefault, LIMITS.searchMax);
    const binding = resolveRef(this.deps.store, sessionRef, 'session');
    const forKey = bindingKey(binding);
    const qHash = cursorBind(`search:${query.toLowerCase()}`);
    this.sessionScope(reader, binding);
    if (binding.o === 'p') {
      return this.peerForward(reader, binding, 'xagt_search_history',
        { sessionRef: binding.r, query, ...(args.cursor !== undefined ? { cursor: args.cursor } : {}), limit }, 'sessionRef');
    }
    const opened = this.open(reader, optString(args, 'cursor', 4096), 'search', forKey, qHash);
    const deadline = this.deadlineLocal;
    const { connectionId, storeId } = this.localBackend(binding);
    if (binding.k !== 'v') {
      // Managed-task scope needs the live projectId — verify before scanning.
      await this.taskScope(reader, binding, deadline);
    }
    const needle = query.toLowerCase();
    const started = this.now();
    const matches: Json[] = [];
    let scannedBytes = 0;
    let before = typeof opened?.next === 'number' ? opened.next : undefined;
    let highWater = typeof opened?.hw === 'number' ? opened.hw : 0;
    let exhausted = false;
    let complete = false;

    const pushMatch = (messageRef: string, role: unknown, text: string, occurredAt?: unknown): void => {
      const idx = text.toLowerCase().indexOf(needle);
      if (idx < 0) return;
      const start = Math.max(0, idx - 192);
      const end = Math.min(text.length, idx + needle.length + 320);
      matches.push({
        messageRef, role, kind: this.mapMessage(role),
        snippet: text.slice(start, end).slice(0, LIMITS.snippetMax),
        ...(occurredAt !== undefined ? { occurredAt } : {}),
      });
    };

    for (;;) {
      if (matches.length >= limit) break;
      if (this.now() - started > LIMITS.searchTimeBudgetMillis || scannedBytes > LIMITS.searchBytesBudget) {
        exhausted = true;
        break;
      }
      if (binding.k === 'v') {
        const page = await this.deps.source.transcript(
          connectionId,
          { sessionId: String(binding.s), engine: String(binding.e), ...(before !== undefined ? { before } : {}), limit: PAGE_CAP },
          storeId, deadline);
        if (page.items.length === 0) {
          if (before !== undefined) xfail('CURSOR_EXPIRED', '会话内容已轮换或游标越界。');
          complete = true;
          break;
        }
        // Iterate newest-first inside the page so matches arrive in strict
        // recency order; `before` still anchors on the oldest index.
        for (const item of [...page.items].reverse()) {
          const text = typeof item.text === 'string' ? item.text : '';
          scannedBytes += text.length;
          pushMatch(`v${String(item.id)}`, item.role, text);
        }
        const first = Number(page.items[0]!.id);
        if (highWater === 0) highWater = Number(page.items.at(-1)!.id);
        if (!Number.isSafeInteger(first) || first <= 1) { complete = true; break; }
        before = first;
      } else {
        if (before === undefined && highWater === 0) {
          highWater = (await this.latestSeq(connectionId, String(binding.t), storeId, deadline)) ?? 0;
          before = highWater + 1;
        }
        const page = await this.deps.source.messages(
          connectionId, String(binding.t), { before: before!, limit: 100 }, storeId, deadline);
        // An empty continuation page means the window below `before` was
        // truncated/rotated — never report it as a finished scan (A11).
        if (page.items.length === 0) {
          if (opened !== undefined && scannedBytes === 0) {
            xfail('CURSOR_EXPIRED', '会话内容已轮换或游标越界。');
          }
          complete = true;
          break;
        }
        for (const item of [...page.items].reverse()) {
          const text = typeof item.text === 'string' ? item.text : '';
          scannedBytes += text.length;
          pushMatch(`m${String(item.sequence)}`, item.role, text, item.occurredAt);
        }
        const first = Number(page.items[0]!.sequence);
        if (!Number.isSafeInteger(first) || first <= 1) { complete = true; break; }
        before = first;
      }
    }
    const next = !complete && before !== undefined && before > 1
      ? this.cursor(reader, { kind: 'search', for: forKey, q: qHash, hw: highWater, next: before })
      : undefined;
    return this.envelope(
      this.localSource(String(binding.c), sessionRef),
      {
        level: complete ? 'FULL' : 'PARTIAL', basis: 'TRANSCRIPT',
        limitations: [
          ...(binding.k === 'v' ? ['SOURCE_TRUNCATES_MESSAGES'] : []),
          ...(exhausted ? ['SCAN_BUDGET_EXHAUSTED'] : []),
        ],
        range: { highWater, scannedBytes, reachedOldest: complete },
      },
      { matches: matches.slice(0, limit), searchComplete: complete, query },
      next,
    );
  }

  // ---------------------------------------------------------------------
  // M4 — materials.
  // ---------------------------------------------------------------------

  private async listMaterials(reader: ReaderGrant, args: Json): Promise<Envelope> {
    const sessionRef = optString(args, 'sessionRef', 512);
    if (sessionRef === undefined) xfail('INVALID_REQUEST', '缺少 sessionRef。');
    const prefix = optString(args, 'prefix', 256);
    const limit = optLimit(args, 'limit', LIMITS.materialsDefault, LIMITS.materialsMax);
    const binding = resolveRef(this.deps.store, sessionRef, 'session');
    const forKey = bindingKey(binding);
    this.sessionScope(reader, binding);
    if (binding.o === 'p') {
      return this.peerForward(reader, binding, 'xagt_list_materials',
        { sessionRef: binding.r, ...(prefix !== undefined ? { prefix } : {}), ...(args.cursor !== undefined ? { cursor: args.cursor } : {}), limit }, 'sessionRef');
    }
    const pHash = cursorBind(prefix ?? '');
    const opened = this.open(reader, optString(args, 'cursor', 4096), 'materials', forKey, pHash);
    const offset = typeof opened?.off === 'number' ? opened.off : 0;
    const deadline = this.deadlineLocal;
    const { connectionId, storeId } = this.localBackend(binding);
    const items: Json[] = [];

    if (binding.k === 't') {
      const facts = await this.taskScope(reader, binding, deadline);
      const taskId = String(binding.t);
      // Staged pool — the source's published text results/attachments.
      const staged = await this.deps.source.stagedFiles(connectionId, taskId, storeId, deadline);
      for (const f of staged) {
        const fileId = typeof f.fileId === 'string' ? f.fileId : typeof f.id === 'string' ? f.id as string : '';
        const sha256 = typeof f.sha256 === 'string' ? f.sha256 : '';
        const size = typeof f.size === 'number' ? f.size : 0;
        const name = typeof f.name === 'string' ? f.name : fileId;
        if (fileId === '' || sha256 === '' || (typeof f.state === 'string' && f.state !== 'staged')) continue;
        const tooLarge = size > LIMITS.materialFileMax;
        items.push({
          materialRef: issueRef(this.deps.store, 'material', {
            v: 1, o: 'l', c: binding.c, b: binding.b, k: 'f', t: taskId, f: fileId, h: sha256,
          }),
          name, mediaType: typeof f.mime === 'string' ? f.mime : 'application/octet-stream',
          sizeBytes: size, sha256, source: 'staged',
          readable: !tooLarge && size > 0,
          ...(tooLarge ? { reasonCode: 'CONTENT_TOO_LARGE' } : {}),
        });
      }
      // Sealed artifacts — only those already published in sessionFiles (the
      // /artifacts route would otherwise seal on demand: a write we must not trigger).
      const sessionFiles = isRecord(facts.sessionFiles) ? facts.sessionFiles : {};
      const listed = Array.isArray(sessionFiles.artifacts) ? sessionFiles.artifacts : [];
      if (listed.length > 0) {
        const manifest = await this.deps.source.artifactManifest(connectionId, taskId, storeId, deadline);
        for (const row of manifest) {
          const artifactId = typeof row.artifactId === 'string' ? row.artifactId : '';
          const sha256 = typeof row.sha256 === 'string' ? row.sha256 : '';
          const status = typeof row.status === 'string' ? row.status : '';
          const size = typeof row.size === 'number' ? row.size : Number(row.size ?? 0);
          if (artifactId === '' || sha256 === '' || (status !== 'AVAILABLE' && status !== 'AVAILABLE_CHUNKED')) continue;
          const tooLarge = size > LIMITS.materialFileMax;
          items.push({
            materialRef: issueRef(this.deps.store, 'material', {
              v: 1, o: 'l', c: binding.c, b: binding.b, k: 'a', t: taskId, a: artifactId, h: sha256,
            }),
            name: typeof row.path === 'string' ? row.path : artifactId,
            mediaType: 'application/octet-stream',
            sizeBytes: Number.isSafeInteger(size) ? size : 0,
            sha256, source: 'artifact',
            readable: !tooLarge && size > 0,
            ...(tooLarge ? { reasonCode: 'CONTENT_TOO_LARGE' } : {}),
          });
        }
      }
    }

    // Explicit material entries bound to this session (provenance only —
    // they expose the named files, never the whole working directory).
    for (const entry of this.deps.materials.list()) {
      if (!canSeeMaterial(reader, entry.matId)) continue;
      if (!this.matchesSession(this.sessionBindingOf(entry), binding)) continue;
      for (const rel of entry.files) {
        const meta = this.deps.materials.describe(entry, rel);
        items.push({
          materialRef: issueRef(this.deps.store, 'material', {
            v: 1, o: 'l', k: 'x', m: entry.matId, r: rel, sb: binding,
          }),
          name: rel, mediaType: 'text/plain', sizeBytes: meta.sizeBytes,
          ...(meta.sha256 !== undefined ? { sha256: meta.sha256 } : {}),
          source: 'explicit', readable: meta.readable,
          ...(meta.reasonCode !== undefined ? { reasonCode: meta.reasonCode } : {}),
        });
      }
    }

    const filtered = prefix === undefined
      ? items
      : items.filter((i) => typeof i.name === 'string' && (i.name as string).startsWith(prefix));
    const page = filtered.slice(offset, offset + limit);
    const next = offset + limit < filtered.length
      ? this.cursor(reader, { kind: 'materials', for: forKey, q: pHash, off: offset + limit })
      : undefined;
    return this.envelope(
      this.localSource(String(binding.c), sessionRef),
      { level: 'FULL', basis: 'FILE', limitations: [] },
      { materials: page },
      next,
    );
  }

  private async readMaterial(reader: ReaderGrant, args: Json): Promise<Envelope> {
    const materialRef = optString(args, 'materialRef', 512);
    if (materialRef === undefined) xfail('INVALID_REQUEST', '缺少 materialRef。');
    const expectedSha256 = optSha(args, 'expectedSha256');
    const maxBytes = optLimit(args, 'maxBytes', LIMITS.materialBytesDefault, LIMITS.materialBytesMax);
    const binding = resolveRef(this.deps.store, materialRef, 'material');
    const forKey = bindingKey(binding);
    if (binding.o === 'p') {
      if (!canUsePeer(reader, String(binding.p))) xfail('SCOPE_DENIED');
      return this.peerForward(reader, binding, 'xagt_read_material',
        { materialRef: binding.r, expectedSha256, maxBytes, ...(args.cursor !== undefined ? { cursor: args.cursor } : {}) }, 'materialRef');
    }
    const opened = this.open(reader, optString(args, 'cursor', 4096), 'material', forKey);
    // A content cursor also pins the hash it was issued for — mixing offsets
    // across a changed expectedSha256 is not a valid continuation.
    if (opened !== undefined && opened.h !== expectedSha256) xfail('CURSOR_EXPIRED');
    const offset = typeof opened?.off === 'number' ? opened.off : 0;
    const deadline = this.deadlineLocal;

    const { bytes, name } = await this.materialBytes(reader, binding, expectedSha256, deadline);
    // Strict UTF-8 — binary or other encodings are explicitly rejected.
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      xfail('UNSUPPORTED_MEDIA');
    }
    const page = this.pageText(text!, offset, maxBytes);
    const next = page.nextOffset !== undefined
      ? this.cursor(reader, { kind: 'material', for: forKey, off: page.nextOffset, h: expectedSha256 })
      : undefined;
    const source = binding.k === 'x'
      ? { deviceName: this.deviceName, agentName: 'explicit', adapter: 'material-explicit', access: 'local' as const, ref: materialRef }
      : this.localSource(String(binding.c ?? ''), materialRef);
    return this.envelope(
      source,
      { level: 'FULL', basis: 'FILE', limitations: [] },
      {
        name,
        sha256: expectedSha256,
        encoding: 'utf-8',
        text: page.text,
        lineStart: page.lineStart,
        lineEnd: page.lineEnd,
        totalBytes: bytes.length,
        offset: page.offset,
      },
      next,
    );
  }

  /** Byte paging over decoded UTF-8 text — never splits a code point. */
  private pageText(text: string, offsetBytes: number, maxBytes: number): {
    text: string; offset: number; nextOffset?: number; lineStart: number; lineEnd: number;
  } {
    const all = Buffer.from(text, 'utf8');
    if (offsetBytes < 0 || offsetBytes > all.length) xfail('CURSOR_EXPIRED');
    let end = offsetBytes;
    let out = '';
    const remaining = new TextDecoder('utf-8').decode(all.subarray(offsetBytes));
    for (const ch of remaining) {
      const w = Buffer.byteLength(ch, 'utf8');
      if (end + w > offsetBytes + maxBytes) break;
      out += ch;
      end += w;
    }
    if (out === '' && remaining.length > 0) {
      // One code point may exceed a tiny page — emit it whole (≤4 bytes).
      const first = [...remaining][0]!;
      out = first;
      end += Buffer.byteLength(first, 'utf8');
    }
    const lineStart = offsetBytes === 0 ? 1 : countLines(all.subarray(0, offsetBytes)) + 1;
    const pageLines = countLines(Buffer.from(out, 'utf8'));
    const lineEnd = out === ''
      ? Math.max(1, lineStart - 1)
      : lineStart + Math.max(0, pageLines - (out.endsWith('\n') ? 1 : 0));
    const nextOffset = end < all.length ? end : undefined;
    return { text: out, offset: offsetBytes, ...(nextOffset !== undefined ? { nextOffset } : {}), lineStart, lineEnd };
  }

  /** Fetch + verify the full material bytes for local bindings (≤1 MiB cap). */
  private async materialBytes(
    reader: ReaderGrant, binding: Json, expectedSha256: string, deadline: number,
  ): Promise<{ bytes: Uint8Array; name: string }> {
    const { connectionId, storeId } = this.localBackend(binding);
    if (binding.k === 'x') {
      // Explicit entry — the entry id AND its session binding must be in scope.
      const entry = this.deps.materials.require(String(binding.m));
      if (!canSeeMaterial(reader, entry.matId)) xfail('SCOPE_DENIED');
      const sb = binding.sb;
      if (isRecord(sb)) {
        if (sb.k === 't') {
          await this.taskScope(reader, { ...sb, o: 'l' }, deadline);
        } else if (!canSeeVendorSession(
          reader, String(sb.b ?? ''), String(sb.e ?? ''), String(sb.s ?? ''))) {
          xfail('SCOPE_DENIED');
        }
      }
      const { bytes, sha256 } = this.deps.materials.read(entry, String(binding.r));
      if (sha256 !== expectedSha256) xfail('MATERIAL_CHANGED');
      return { bytes, name: String(binding.r) };
    }
    if (binding.k === 'f' || binding.k === 'a') {
      // Staged file / sealed artifact — task scope re-check against live facts.
      const taskId = String(binding.t);
      await this.taskScope(reader, binding, deadline);
      if (binding.k === 'f') {
        const meta = await this.deps.source.stagedFileMeta(connectionId, taskId, String(binding.f), storeId, deadline);
        const sha256 = typeof meta.sha256 === 'string' ? meta.sha256 : '';
        const size = typeof meta.size === 'number' ? meta.size : 0;
        if (sha256 !== expectedSha256 || sha256 !== String(binding.h)) xfail('MATERIAL_CHANGED');
        if (size > LIMITS.materialFileMax) xfail('CONTENT_TOO_LARGE');
        const bytes = await this.pullChunks(
          (off) => this.deps.source.stagedChunk(connectionId, taskId, String(binding.f), sha256, off, storeId, deadline), size);
        if (hashBytes(bytes) !== sha256) xfail('MATERIAL_CHANGED');
        return { bytes, name: typeof meta.name === 'string' ? meta.name : String(binding.f) };
      }
      const artifactId = String(binding.a);
      // Only AVAILABLE (≤512 KiB whole) or AVAILABLE_CHUNKED (≤1 MiB) — both
      // are read-only when the manifest already exists (it must: the ref was
      // issued from a listed manifest row).
      const manifest = await this.deps.source.artifactManifest(connectionId, taskId, storeId, deadline);
      const row = manifest.find((r) => r.artifactId === artifactId);
      if (row === undefined) xfail('NOT_FOUND');
      const sha256 = typeof row.sha256 === 'string' ? row.sha256 : '';
      if (sha256 !== expectedSha256 || sha256 !== String(binding.h)) xfail('MATERIAL_CHANGED');
      const size = Number(row.size ?? 0);
      if (size > LIMITS.materialFileMax) xfail('CONTENT_TOO_LARGE');
      if (row.status === 'AVAILABLE') {
        const got = await this.deps.source.artifactGet(connectionId, taskId, artifactId, storeId, deadline);
        if (got.sha256 !== sha256) xfail('MATERIAL_CHANGED');
        return { bytes: got.bytes, name: typeof row.path === 'string' ? row.path : artifactId };
      }
      if (row.status !== 'AVAILABLE_CHUNKED') xfail('NOT_FOUND');
      const bytes = await this.pullChunks(
        (off) => this.deps.source.artifactChunk(connectionId, taskId, artifactId, sha256, off, storeId, deadline), size);
      if (hashBytes(bytes) !== sha256) xfail('MATERIAL_CHANGED');
      return { bytes, name: typeof row.path === 'string' ? row.path : artifactId };
    }
    xfail('INVALID_REQUEST');
  }

  /** 262144-aligned chunk pull, bounded to ≤1 MiB end-to-end. */
  private async pullChunks(
    fetcher: (offset: number) => Promise<{ bytes: Uint8Array; sizeBytes: number }>,
    sizeBytes: number,
  ): Promise<Uint8Array> {
    if (sizeBytes <= 0 || sizeBytes > LIMITS.materialFileMax) xfail('CONTENT_TOO_LARGE');
    const parts: Uint8Array[] = [];
    let pulled = 0;
    while (pulled < sizeBytes) {
      const chunk = await fetcher(pulled);
      // A lying source must not overrun the declared size or misreport the
      // total — the whole-file hash still verifies, but bounds stay honest.
      if (chunk.sizeBytes !== sizeBytes
          || chunk.bytes.length === 0 || chunk.bytes.length > 262144
          || pulled + chunk.bytes.length > sizeBytes) {
        xfail('MATERIAL_CHANGED');
      }
      parts.push(chunk.bytes);
      pulled += chunk.bytes.length;
    }
    const out = new Uint8Array(pulled);
    let at = 0;
    for (const part of parts) { out.set(part, at); at += part.length; }
    return out;
  }
}

const countLines = (bytes: Uint8Array): number => {
  let n = 0;
  for (const b of bytes) if (b === 0x0a) n++;
  return n;
};
