/**
 * SourceReader — the read-only seam over registered worker-local hosts
 * (design §3.1). Every call is a GET against the Java-compatible `/local/v1`
 * surface; this module has no input/interaction path, so a reader grant can
 * never steer a source task.
 *
 * Reuse boundary: LocalTaskAccess keeps owning the device-token/scope route
 * table. This adapter talks to the same LocalTransport the task routes use —
 * loopback-pinned origins, bearer from the connection registry, bounded
 * bodies — but never consults device grants; the xagt reader grant is the
 * only authorization checked (in read-service.ts).
 */
import { LocalTransportError } from '../local-transport.js';
import type { LocalTransportLike } from '../local-tasks.js';
import type { RawResult } from '../local-transport.js';
import { GatewayError, hashBytes, isRecord } from '../protocol.js';
import { LIMITS, xfail } from './common.js';

export interface EngineRow {
  engineId: string;
  engineVersion?: string;
  availability?: string;
  sourceKind?: string;
  capabilities?: Record<string, unknown>;
}

export interface BackendCatalog {
  storeId: string;
  engines: EngineRow[];
  projects: { projectId: string; displayName?: string }[];
}

export interface TaskRow {
  taskId: string;
  projectId: string;
  engineId: string;
  state: string;
  displayName?: string;
}

export interface VendorSessionRow {
  id: string;
  title: string;
  at: string;
  engine: string;
  source: string;
  cwd?: string;
  live?: boolean;
}

const num = (v: unknown): number | undefined => {
  if (typeof v === 'number' && Number.isSafeInteger(v)) return v;
  if (typeof v === 'string' && /^(0|[1-9][0-9]*)$/.test(v)) return Number(v);
  return undefined;
};

export class SourceReader {
  constructor(private readonly transport: LocalTransportLike) {}

  /** Bounded GET with error mapping: transport throw → SOURCE_OFFLINE, non-200 → mapped code. */
  private async get(
    connectionId: string,
    tail: string,
    storeId: string | undefined,
    deadlineMillis: number,
  ): Promise<Record<string, unknown>> {
    let result: RawResult;
    try {
      result = await this.transport.raw(
        connectionId, 'GET', tail, undefined, undefined, storeId, deadlineMillis);
    } catch (error) {
      if (error instanceof LocalTransportError || !(error instanceof GatewayError)) {
        xfail('SOURCE_OFFLINE', '来源当前离线。', true);
      }
      if (error instanceof GatewayError && error.code === 'SCAN_TIME_BUDGET_EXCEEDED') {
        xfail('SOURCE_OFFLINE', '来源响应超出时限。', true);
      }
      if (error instanceof GatewayError && error.code === 'LOCAL_SOURCE_UPGRADE_REQUIRED') {
        xfail('UNSUPPORTED', '来源版本不满足 storeGuard 要求。');
      }
      xfail('SOURCE_UNAVAILABLE', '来源响应无效。', true);
    }
    if (result.status === 404) xfail('NOT_FOUND');
    // Upstream 410 = FILE_EXPIRED (staged-file TTL) — the object is gone,
    // not an authorization issue (the source knows nothing about grants).
    if (result.status === 410) xfail('NOT_FOUND', '来源对象已过期。');
    if (result.status === 400) xfail('INVALID_REQUEST', '来源拒绝了读取参数。');
    if (result.status !== 200 || !isRecord(result.data)) {
      const code = isRecord(result.data) && typeof result.data.code === 'string'
        ? result.data.code : '';
      if (code === 'ARTIFACT_CHANGED' || code === 'FILE_CHANGED' || code === 'FILE_NOT_AVAILABLE') {
        xfail('MATERIAL_CHANGED');
      }
      xfail('SOURCE_UNAVAILABLE', `来源返回 ${result.status}。`, true);
    }
    return result.data;
  }

  // -- catalog -------------------------------------------------------------

  private readonly catalogCache = new Map<string, { at: number; value: BackendCatalog }>();

  /** /identity + /engines + /projects — cached ≤5 s (directory metadata budget). */
  async catalog(connectionId: string, deadlineMillis: number): Promise<BackendCatalog> {
    const cached = this.catalogCache.get(connectionId);
    if (cached !== undefined && cached.at + LIMITS.catalogCacheMillis > Date.now()) {
      return cached.value;
    }
    let storeId: string;
    try {
      storeId = await this.transport.identity(connectionId, deadlineMillis);
    } catch (error) {
      if (error instanceof GatewayError && error.code === 'LOCAL_SOURCE_UPGRADE_REQUIRED') {
        xfail('UNSUPPORTED', '来源版本不满足 storeGuard 要求。');
      }
      xfail('SOURCE_OFFLINE', '来源当前离线。', true);
    }
    const [engines, projects] = await Promise.all([
      this.get(connectionId, '/engines', storeId, deadlineMillis),
      this.get(connectionId, '/projects', storeId, deadlineMillis),
    ]);
    const engineRows: EngineRow[] = [];
    for (const item of Array.isArray(engines.items) ? engines.items : []) {
      if (!isRecord(item) || typeof item.engineId !== 'string') continue;
      engineRows.push({
        engineId: item.engineId,
        ...(typeof item.engineVersion === 'string' ? { engineVersion: item.engineVersion } : {}),
        ...(typeof item.availability === 'string' ? { availability: item.availability } : {}),
        ...(typeof item.sourceKind === 'string' ? { sourceKind: item.sourceKind } : {}),
        ...(isRecord(item.capabilities) ? { capabilities: item.capabilities } : {}),
      });
    }
    const projectRows: { projectId: string; displayName?: string }[] = [];
    for (const item of Array.isArray(projects.items) ? projects.items : []) {
      if (!isRecord(item) || typeof item.projectId !== 'string') continue;
      projectRows.push({
        projectId: item.projectId,
        ...(typeof item.displayName === 'string' ? { displayName: item.displayName } : {}),
      });
    }
    const value: BackendCatalog = { storeId, engines: engineRows, projects: projectRows };
    this.catalogCache.set(connectionId, { at: Date.now(), value });
    return value;
  }

  // -- sessions ------------------------------------------------------------

  async listTasks(connectionId: string, storeId: string, deadlineMillis: number): Promise<TaskRow[]> {
    const data = await this.get(connectionId, '/tasks', storeId, deadlineMillis);
    const out: TaskRow[] = [];
    for (const item of Array.isArray(data.items) ? data.items : []) {
      if (!isRecord(item) || typeof item.taskId !== 'string') continue;
      out.push({
        taskId: item.taskId,
        projectId: typeof item.projectId === 'string' ? item.projectId : '',
        engineId: typeof item.engineId === 'string' ? item.engineId : '',
        state: typeof item.state === 'string' ? item.state : 'UNKNOWN',
      });
    }
    return out;
  }

  /** worker-local-history/2 — one page of vendor sessions for the backend's own engine. */
  async listVendorSessions(
    connectionId: string,
    opts: { q?: string; engine?: string; cursor?: string; limit: number },
    storeId: string | undefined,
    deadlineMillis: number,
  ): Promise<{ items: VendorSessionRow[]; pageCursor?: string; pageEngine?: string; reportedEngines: string[] }> {
    const params = new URLSearchParams();
    params.set('limit', String(Math.min(50, Math.max(1, opts.limit))));
    if (opts.q !== undefined && opts.q !== '') params.set('q', opts.q);
    // The upstream requires `engine` alongside `cursor` — the cursor payload
    // binds before.engine === selected (cli-bridge host.mjs /history).
    if (opts.engine !== undefined) params.set('engine', opts.engine);
    if (opts.cursor !== undefined) params.set('cursor', opts.cursor);
    const data = await this.get(connectionId, `/history?${params}`, storeId, deadlineMillis)
      .catch(error => {
        // Native-only workers expose managed tasks but may have no vendor catalog.
        if (opts.cursor === undefined && error instanceof GatewayError && error.code === 'NOT_FOUND') {
          return { items: [], pages: [] };
        }
        throw error;
      });
    const items: VendorSessionRow[] = [];
    for (const item of Array.isArray(data.items) ? data.items : []) {
      // Rows without an engine or id could never be re-read — drop them.
      if (!isRecord(item) || typeof item.id !== 'string' || item.id === ''
          || typeof item.engine !== 'string' || item.engine === '') continue;
      items.push({
        id: item.id,
        title: typeof item.title === 'string' ? item.title : '',
        at: typeof item.at === 'string' ? item.at : '',
        engine: item.engine,
        source: typeof item.source === 'string' ? item.source : '',
        ...(typeof item.cwd === 'string' ? { cwd: item.cwd } : {}),
        ...(typeof item.live === 'boolean' ? { live: item.live } : {}),
      });
    }
    let pageCursor: string | undefined;
    let pageEngine: string | undefined;
    const reportedEngines: string[] = [];
    for (const page of Array.isArray(data.pages) ? data.pages : []) {
      if (!isRecord(page) || typeof page.engine !== 'string') continue;
      reportedEngines.push(page.engine);
      // pages[] is per-engine — resume the engine we are actually paging.
      if (typeof page.cursor === 'string'
          && (opts.engine === undefined || page.engine === opts.engine)) {
        pageCursor = page.cursor;
        pageEngine = page.engine;
      }
    }
    return {
      items, reportedEngines,
      ...(pageCursor !== undefined ? { pageCursor } : {}),
      ...(pageEngine !== undefined ? { pageEngine } : {}),
    };
  }

  // -- managed task reads ----------------------------------------------------

  async facts(connectionId: string, taskId: string, storeId: string | undefined, deadlineMillis: number): Promise<Record<string, unknown>> {
    return this.get(connectionId, `/tasks/${encodeURIComponent(taskId)}`, storeId, deadlineMillis);
  }

  async events(
    connectionId: string, taskId: string,
    opts: { cursor?: number; limit: number },
    storeId: string | undefined,
    deadlineMillis: number,
  ): Promise<{ items: Record<string, unknown>[]; nextCursor: string; cursorExpired: boolean }> {
    const params = new URLSearchParams();
    params.set('limit', String(Math.min(100, Math.max(1, opts.limit))));
    if (opts.cursor !== undefined) params.set('cursor', String(opts.cursor));
    const data = await this.get(connectionId, `/tasks/${encodeURIComponent(taskId)}/events?${params}`, storeId, deadlineMillis);
    const items = (Array.isArray(data.items) ? data.items : []).filter(isRecord);
    return {
      items,
      nextCursor: typeof data.nextCursor === 'string' ? data.nextCursor
        : typeof data.cursor === 'string' ? data.cursor : String(opts.cursor ?? 0),
      cursorExpired: data.cursorExpired === true,
    };
  }

  async inputRequests(connectionId: string, taskId: string, storeId: string | undefined, deadlineMillis: number): Promise<Record<string, unknown>[]> {
    const data = await this.get(connectionId, `/tasks/${encodeURIComponent(taskId)}/input-requests`, storeId, deadlineMillis);
    return (Array.isArray(data.items) ? data.items : []).filter(isRecord);
  }

  async output(connectionId: string, taskId: string, storeId: string | undefined, deadlineMillis: number): Promise<{ text: string; coverage?: string }> {
    const data = await this.get(connectionId, `/tasks/${encodeURIComponent(taskId)}/output`, storeId, deadlineMillis);
    return {
      text: typeof data.text === 'string' ? data.text : '',
      ...(typeof data.coverage === 'string' ? { coverage: data.coverage } : {}),
    };
  }

  /** native-messages/1 — `before` reads the page ENDING before that sequence. */
  async messages(
    connectionId: string, taskId: string,
    opts: { before?: number; limit: number },
    storeId: string | undefined,
    deadlineMillis: number,
  ): Promise<{
    items: Record<string, unknown>[];
    firstSequence: number | null;
    latestSequence: number | null;
    hasMore: boolean;
  }> {
    const params = new URLSearchParams();
    params.set('limit', String(Math.min(100, Math.max(1, opts.limit))));
    if (opts.before !== undefined) params.set('before', String(opts.before));
    const data = await this.get(connectionId, `/tasks/${encodeURIComponent(taskId)}/messages?${params}`, storeId, deadlineMillis);
    const items = (Array.isArray(data.items) ? data.items : []).filter(isRecord);
    return {
      items,
      firstSequence: num(data.firstSequence) ?? (items.length > 0 ? num(items[0]!.sequence) ?? null : null),
      latestSequence: num(data.latestSequence) ?? null,
      hasMore: data.hasMore === true,
    };
  }

  /** worker-vendor-transcript/1 — `before` = exclusive message index bound. */
  async transcript(
    connectionId: string,
    opts: { sessionId: string; engine: string; before?: number; limit: number },
    storeId: string | undefined,
    deadlineMillis: number,
  ): Promise<{ items: Record<string, unknown>[]; olderBefore?: number }> {
    const params = new URLSearchParams();
    params.set('engine', opts.engine);
    params.set('limit', String(Math.min(20, Math.max(1, opts.limit))));
    if (opts.before !== undefined) params.set('before', String(opts.before));
    const data = await this.get(
      connectionId, `/history/sessions/${encodeURIComponent(opts.sessionId)}?${params}`, storeId, deadlineMillis);
    const items = (Array.isArray(data.items) ? data.items : []).filter(isRecord);
    return {
      items,
      ...(num(data.before) !== undefined ? { olderBefore: num(data.before) } : {}),
    };
  }

  // -- materials -------------------------------------------------------------

  async stagedFiles(connectionId: string, taskId: string, storeId: string | undefined, deadlineMillis: number): Promise<Record<string, unknown>[]> {
    const data = await this.get(connectionId, `/tasks/${encodeURIComponent(taskId)}/files`, storeId, deadlineMillis);
    return (Array.isArray(data.items) ? data.items : []).filter(isRecord);
  }

  async stagedFileMeta(connectionId: string, taskId: string, fileId: string, storeId: string | undefined, deadlineMillis: number): Promise<Record<string, unknown>> {
    return this.get(connectionId, `/tasks/${encodeURIComponent(taskId)}/files/${encodeURIComponent(fileId)}`, storeId, deadlineMillis);
  }

  /** worker-local-file-chunk/1 — offsets are 262144-aligned. */
  async stagedChunk(
    connectionId: string, taskId: string, fileId: string, sha256: string, offset: number,
    storeId: string | undefined, deadlineMillis: number,
  ): Promise<{ bytes: Uint8Array; sizeBytes: number }> {
    const data = await this.get(
      connectionId,
      `/tasks/${encodeURIComponent(taskId)}/files/${encodeURIComponent(fileId)}/chunks/${sha256}/${offset}`,
      storeId, deadlineMillis);
    if (typeof data.bytes !== 'string' || typeof data.chunkSHA256 !== 'string') {
      xfail('SOURCE_UNAVAILABLE', '来源分块响应不完整。', true);
    }
    const bytes = Buffer.from(data.bytes as string, 'base64');
    if (hashBytes(new Uint8Array(bytes)) !== data.chunkSHA256) xfail('MATERIAL_CHANGED');
    return { bytes: new Uint8Array(bytes), sizeBytes: num(data.sizeBytes) ?? 0 };
  }

  /** mac-artifact/1 manifest — safe to call only when facts show a sealed manifest. */
  async artifactManifest(connectionId: string, taskId: string, storeId: string | undefined, deadlineMillis: number): Promise<Record<string, unknown>[]> {
    const data = await this.get(connectionId, `/tasks/${encodeURIComponent(taskId)}/artifacts`, storeId, deadlineMillis);
    return (Array.isArray(data.items) ? data.items : []).filter(isRecord);
  }

  async artifactGet(connectionId: string, taskId: string, artifactId: string, storeId: string | undefined, deadlineMillis: number): Promise<{ bytes: Uint8Array; sha256: string }> {
    const data = await this.get(
      connectionId, `/tasks/${encodeURIComponent(taskId)}/artifacts/${encodeURIComponent(artifactId)}`, storeId, deadlineMillis);
    if (typeof data.bytes !== 'string' || typeof data.sha256 !== 'string') {
      xfail('SOURCE_UNAVAILABLE', '来源成果响应不完整。', true);
    }
    const bytes = Buffer.from(data.bytes as string, 'base64');
    if (hashBytes(new Uint8Array(bytes)) !== data.sha256) xfail('MATERIAL_CHANGED');
    return { bytes: new Uint8Array(bytes), sha256: data.sha256 as string };
  }

  async artifactChunk(
    connectionId: string, taskId: string, artifactId: string, sha256: string, offset: number,
    storeId: string | undefined, deadlineMillis: number,
  ): Promise<{ bytes: Uint8Array; sizeBytes: number }> {
    const data = await this.get(
      connectionId,
      `/tasks/${encodeURIComponent(taskId)}/artifacts/${encodeURIComponent(artifactId)}/chunks/${sha256}/${offset}`,
      storeId, deadlineMillis);
    if (typeof data.bytes !== 'string' || typeof data.chunkSHA256 !== 'string') {
      xfail('SOURCE_UNAVAILABLE', '来源分块响应不完整。', true);
    }
    const bytes = Buffer.from(data.bytes as string, 'base64');
    if (hashBytes(new Uint8Array(bytes)) !== data.chunkSHA256) xfail('MATERIAL_CHANGED');
    return { bytes: new Uint8Array(bytes), sizeBytes: num(data.sizeBytes) ?? 0 };
  }
}

export { num };
