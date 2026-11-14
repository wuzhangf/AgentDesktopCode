/**
 * LocalTransport — port of Java `PersonalLocalTaskAccess.raw()/identity()`.
 *
 * A fixed, store-bound channel to one registered worker-local host. Callers
 * pass Java-style tails: anything not starting with `/worker-host/` is resolved
 * under `/local/v1` (so `raw('GET','/identity')` hits `/local/v1/identity` and
 * `/worker-host/v1/manifest` stays verbatim).
 *
 * Result-style: non-2xx HTTP statuses are returned, never thrown. Only
 * transport-level failures throw GatewayError:
 *   - missing/misconfigured connection          → LOCAL_SOURCE_UNAVAILABLE 503
 *   - non-loopback baseUrl                       → LOCAL_SOURCE_UNAVAILABLE 503
 *   - unresolvable tokenRef                      → LOCAL_UPSTREAM_AUTH_MISSING 503
 *   - fetch failure (timeout/refused/redirect)   → LOCAL_SOURCE_UNAVAILABLE 503
 *   - exhausted deadline                         → SCAN_TIME_BUDGET_EXCEEDED 503
 *   - response body > 1 MiB                      → LOCAL_RESPONSE_TOO_LARGE 502
 *   - body that is not a JSON object             → LOCAL_REPLY_INVALID 502
 *
 * Empty bodies parse to `{code:'LOCAL_SOURCE_UNAVAILABLE'}` — Java's exact
 * void-reply behaviour (`input==null` → synthetic code object).
 */
import { fail, GatewayError, id, isRecord } from './protocol';

/** Network-level failure — the IOException analogue callers recover as LOCAL_REPLY_UNCONFIRMED. */
export class LocalTransportError extends GatewayError {}

export interface ConnectionRowLite {
  connectionId: string;
  kind: string;
  baseUrl?: string;
  tokenRef?: string;
  displayName?: string;
}

export interface RawResult {
  status: number;
  data: unknown;
}

export interface ConnectionRegistryLite {
  getConnection(id: string): ConnectionRowLite | undefined;
  listConnections?(): ConnectionRowLite[];
}

const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
const MAX_RESPONSE_BYTES = 1024 * 1024;
/** Java raw(): default deadline now+45s; connectTimeout min(3000, remaining). */
const DEFAULT_DEADLINE_MS = 45_000;
const JAVA_READ_TIMEOUT_MS = 12_000;

export class LocalTransport {
  constructor(
    private readonly registry: ConnectionRegistryLite,
    private readonly tokenResolver: (ref: string) => string | undefined,
    private readonly fetchImpl: typeof fetch = fetch,
    /** The configured primary upstream (WORKER_LOCAL_*); falls back to the first row. */
    private readonly primaryConnectionId?: string,
  ) {}

  /**
   * The primary worker-local upstream (Java binds exactly one origin). With
   * extra engine rows registered, the configured primary connectionId wins;
   * otherwise the first registered `worker-local` row. None → unavailable.
   */
  workerLocal(): ConnectionRowLite {
    const rows = this.workerLocalRows();
    if (rows.length === 0) fail('LOCAL_SOURCE_UNAVAILABLE', 503);
    return rows.find((r) => r.connectionId === this.primaryConnectionId) ?? rows[0]!;
  }

  /**
   * Every registered worker-local candidate (the gateway may front several
   * loopback hosts — one per engine). Callers resolve the row whose
   * `/identity` storeId matches the request's backend segment.
   */
  workerLocalRows(): ConnectionRowLite[] {
    return this.registry.listConnections?.().filter((r) => r.kind === 'worker-local') ?? [];
  }

  /** Candidates with the primary upstream first — catalogs keep the primary backend as their head. */
  orderedWorkerLocalRows(): ConnectionRowLite[] {
    const rows = this.workerLocalRows();
    if (this.primaryConnectionId === undefined) return rows;
    const primary = rows.findIndex((r) => r.connectionId === this.primaryConnectionId);
    if (primary <= 0) return rows;
    return [rows[primary]!, ...rows.slice(0, primary), ...rows.slice(primary + 1)];
  }

  /** Loopback-only origin + resolved bearer; throws before any request is made. */
  private origin(connectionId: string): { origin: string; token: string } {
    const row = this.registry.getConnection(connectionId);
    if (!row || row.kind !== 'worker-local' || typeof row.baseUrl !== 'string' || row.baseUrl.length === 0) {
      fail('LOCAL_SOURCE_UNAVAILABLE', 503);
    }
    let url: URL;
    try {
      url = new URL(row.baseUrl);
    } catch {
      fail('LOCAL_SOURCE_UNAVAILABLE', 503);
    }
    const schemeOk = url.protocol === 'http:' || url.protocol === 'https:';
    const host = url.hostname.toLowerCase();
    // Self-registered workers (tokenRef `worker:*`) redeemed an owner-minted
    // invite, so remote origins are authorized; env/supervisor rows stay
    // loopback-only. Either way: no userinfo, path, query or fragment.
    const hostOk = LOOPBACK_HOSTNAMES.has(host) || (row.tokenRef?.startsWith('worker:') ?? false);
    if (!schemeOk || !hostOk || url.username !== '' || url.password !== ''
        || (url.pathname !== '' && url.pathname !== '/') || url.search !== '' || url.hash !== '') {
      fail('LOCAL_SOURCE_UNAVAILABLE', 503);
    }
    const token = row.tokenRef ? this.tokenResolver(row.tokenRef) : undefined;
    if (typeof token !== 'string' || token.length === 0) {
      fail('LOCAL_UPSTREAM_AUTH_MISSING', 503);
    }
    return { origin: url.origin, token };
  }

  private static remaining(deadlineMillis?: number): number {
    if (deadlineMillis === undefined) return DEFAULT_DEADLINE_MS;
    const left = deadlineMillis - Date.now();
    if (left <= 0) fail('SCAN_TIME_BUDGET_EXCEEDED', 503);
    return left;
  }

  /**
   * One bounded request. `storeId` becomes `X-Worker-Local-Store`; `key`
   * becomes `Idempotency-Key` verbatim (Java raw(method,path,body,key,store)).
   */
  async raw(
    connectionId: string,
    method: 'GET' | 'POST',
    tail: string,
    body?: unknown,
    key?: string,
    storeId?: string,
    deadlineMillis?: number,
  ): Promise<RawResult> {
    const { origin, token } = this.origin(connectionId);
    const remaining = LocalTransport.remaining(deadlineMillis);
    const path = tail.startsWith('/worker-host/') ? tail : `/local/v1${tail}`;
    const headers: Record<string, string> = {
      authorization: `Bearer ${token}`,
      accept: 'application/json',
    };
    if (storeId !== undefined) headers['x-worker-local-store'] = storeId;
    if (key !== undefined) headers['idempotency-key'] = key;
    let payload: string | undefined;
    if (body !== undefined) {
      headers['content-type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    let response: Response;
    try {
      response = await this.fetchImpl(`${origin}${path}`, {
        method,
        headers,
        body: payload,
        redirect: 'error',
        signal: AbortSignal.timeout(Math.min(JAVA_READ_TIMEOUT_MS, remaining)),
      });
    } catch (error) {
      if (error instanceof GatewayError) throw error;
      throw new LocalTransportError('LOCAL_SOURCE_UNAVAILABLE', 503);
    }
    const parts: Uint8Array[] = [];
    let size = 0;
    const reader = response.body?.getReader();
    if (reader) {
      try {
        for (;;) {
          const part = await reader.read();
          if (part.done) break;
          size += part.value.byteLength;
          if (size > MAX_RESPONSE_BYTES) {
            try { await reader.cancel(); } catch { /* best effort */ }
            fail('LOCAL_RESPONSE_TOO_LARGE', 502);
          }
          parts.push(part.value);
        }
      } catch (error) {
        if (error instanceof GatewayError) throw error;
        throw new LocalTransportError('LOCAL_SOURCE_UNAVAILABLE', 503);
      } finally {
        reader.releaseLock();
      }
    }
    const text = Buffer.concat(parts.map((p) => Buffer.from(p))).toString('utf8');
    // Java: input==null → Result(status, {code:'LOCAL_SOURCE_UNAVAILABLE'}).
    if (text.length === 0) return { status: response.status, data: { code: 'LOCAL_SOURCE_UNAVAILABLE' } };
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      fail('LOCAL_REPLY_INVALID', 502);
    }
    if (!isRecord(data)) fail('LOCAL_REPLY_INVALID', 502);
    return { status: response.status, data };
  }

  /**
   * Store-guard handshake (Java identity()): 200 + storeGuard 'HEADER_V1' +
   * a well-formed storeId or the host is not usable.
   */
  async identity(connectionId: string, deadlineMillis?: number): Promise<string> {
    const result = await this.raw(connectionId, 'GET', '/identity', undefined, undefined, undefined, deadlineMillis);
    const data = result.data;
    if (result.status !== 200 || !isRecord(data)) fail('LOCAL_SOURCE_UNAVAILABLE', 503);
    if (data.storeGuard !== 'HEADER_V1') fail('LOCAL_SOURCE_UPGRADE_REQUIRED', 409);
    const storeId = data.storeId;
    id(storeId); // Java id() → INVALID_REQUEST on malformed ids
    return storeId as string;
  }
}
