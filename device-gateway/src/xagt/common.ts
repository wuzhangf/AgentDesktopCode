/**
 * xagt read surface — shared constants, bounded limits and the error shape.
 *
 * The eight read-only tools (`xagt_list_targets`, `xagt_list_sessions`,
 * `xagt_get_activity`, `xagt_read_history`, `xagt_search_history`,
 * `xagt_list_materials`, `xagt_read_material`) share one envelope:
 *
 *   { schemaVersion:'xagt-read/1', source, observedAt, coverage, data, nextCursor? }
 *
 * and one error shape `{code,message,retryable}`. Both the stdio MCP adapter
 * (src/xagt-mcp-main.ts) and the fixed peer RPC (POST /api/xagt/v1/read)
 * consume this module — nothing else is ever proxied.
 */
import { GatewayError } from '../protocol.js';

export const READ_API_PATH = '/api/xagt/v1/read';
export const READ_SCHEMA = 'xagt-read/1';
export const READ_RPC_VERSION = 1;

export const XAGT_TOOLS = [
  'xagt_list_targets',
  'xagt_list_sessions',
  'xagt_get_activity',
  'xagt_read_history',
  'xagt_search_history',
  'xagt_list_materials',
  'xagt_read_material',
  'xagt_list_cluster',
] as const;
export type XagtTool = (typeof XAGT_TOOLS)[number];
export const isXagtTool = (value: unknown): value is XagtTool =>
  typeof value === 'string' && (XAGT_TOOLS as readonly string[]).includes(value);

/** Bounded limits — the read surface never serves unbounded pages. */
export const LIMITS = {
  targetsDefault: 20,
  targetsMax: 50,
  sessionsDefault: 20,
  sessionsMax: 100,
  activityDefault: 50,
  activityMax: 100,
  historyDefault: 50,
  historyMax: 100,
  searchDefault: 50,
  searchMax: 100,
  materialsDefault: 50,
  materialsMax: 200,
  /** Material text paging: 16 KiB default / 32 KiB max per call. */
  materialBytesDefault: 16 * 1024,
  materialBytesMax: 32 * 1024,
  /** First phase: UTF-8 plain text, single file ≤ 1 MiB. */
  materialFileMax: 1024 * 1024,
  /** Per-message text budget; longer bodies continue via nextContentCursor. */
  messageTextMax: 16 * 1024,
  snippetMax: 512,
  queryMax: 512,
  /** Search scan budget per call — exhaustion returns a continuation cursor. */
  searchBytesBudget: 8 * 1024 * 1024,
  searchTimeBudgetMillis: 2_000,
  /** Directory metadata cache — refreshes at most every 5 s. */
  catalogCacheMillis: 5_000,
  localDeadlineMillis: 5_000,
  peerDeadlineMillis: 10_000,
  /** POST /api/xagt/v1/read body cap. */
  rpcBodyMax: 64 * 1024,
  /** MCP single-response cap — page sizes stay well under it. */
  mcpResponseMax: 256 * 1024,
  perReaderInflight: 2,
  globalInflight: 8,
  /** One management call admits at most 50 relative file names. */
  explicitFilesMax: 50,
  /** Cap on one event's serialized payload forwarded to the model. */
  eventJsonMax: 4 * 1024,
  /** Reader/material/peer list sizes. */
  grantsMax: 200,
  peersMax: 64,
  materialEntriesMax: 512,
} as const;

/**
 * Errors inside the read surface carry the wire code plus a short message and
 * a retryable hint. httpStatus matters on the management/RPC routes — tool
 * failures travel inside the {ok:false,error} envelope, so the status is only
 * consulted when an error escapes to the HTTP layer (owner API, auth gate).
 */
export class XagtError extends GatewayError {
  constructor(
    code: string,
    readonly detail: string,
    readonly retryable = false,
    httpStatus?: number,
  ) {
    super(code, httpStatus ?? STATUS[code] ?? 400);
  }
}

/** Code → HTTP status when an error reaches the owner/RPC layer. */
const STATUS: Record<string, number> = {
  INVALID_REQUEST: 400,
  VERSION_UNSUPPORTED: 400,
  ACCESS_UNAUTHORIZED: 401,
  SCOPE_DENIED: 403,
  NOT_FOUND: 404,
  GRANT_EXPIRED: 410,
  CURSOR_EXPIRED: 410,
  MATERIAL_CHANGED: 409,
  CONTENT_TOO_LARGE: 413,
  UNSUPPORTED_MEDIA: 415,
  BUSY: 429,
  UNSUPPORTED: 400,
  SOURCE_OFFLINE: 503,
  SOURCE_UNAVAILABLE: 503,
  PEER_NOT_CONFIGURED: 503,
  PEER_TLS_MISMATCH: 503,
};

export function xfail(
  code: string, detail?: string, retryable = false, httpStatus?: number,
): never {
  throw new XagtError(code, detail ?? MESSAGES[code] ?? code, retryable, httpStatus);
}

/** Short operator-facing messages per code (kept terse — model-visible). */
export const MESSAGES: Record<string, string> = {
  INVALID_REQUEST: '请求参数无效。',
  ACCESS_UNAUTHORIZED: '只读凭据无效；请在来源 Link 的管理入口重新发放。',
  GRANT_EXPIRED: '只读授权已撤销或到期；请重新授权后重试。',
  SCOPE_DENIED: '目标不在该凭据的授权范围内。',
  NOT_FOUND: '引用的对象不存在或引用已失效。',
  CURSOR_EXPIRED: '游标已过期或不再匹配查询；请从最新结果重新读取。',
  UNSUPPORTED: '该来源不支持此读取能力。',
  SOURCE_OFFLINE: '来源当前离线；可稍后重试。',
  SOURCE_UNAVAILABLE: '来源暂时不可用或返回了无法识别的数据。',
  MATERIAL_CHANGED: '来源材料已变化，请重新列出后读取。',
  CONTENT_TOO_LARGE: '材料超过 1 MiB 上限，只能返回元信息。',
  UNSUPPORTED_MEDIA: '材料不是可解码的 UTF-8 文本。',
  BUSY: '读取服务正忙，请稍后重试。',
  PEER_NOT_CONFIGURED: '目标 peer 未配置或已删除。',
  PEER_TLS_MISMATCH: 'peer 证书指纹与登记值不匹配，拒绝连接。',
  VERSION_UNSUPPORTED: '仅支持 version=1 的读取请求。',
};

export const errorBody = (error: unknown): { code: string; message: string; retryable: boolean } => {
  if (error instanceof XagtError) {
    return { code: error.code, message: error.detail, retryable: error.retryable };
  }
  if (error instanceof GatewayError) {
    return { code: error.code, message: MESSAGES[error.code] ?? error.code, retryable: false };
  }
  return { code: 'SOURCE_UNAVAILABLE', message: MESSAGES.SOURCE_UNAVAILABLE!, retryable: true };
};

// ---------------------------------------------------------------------------
// Shared envelope types.
// ---------------------------------------------------------------------------

export type CoverageLevel = 'FULL' | 'PARTIAL' | 'UNKNOWN';

export interface Coverage {
  level: CoverageLevel;
  basis: 'SOURCE_FACTS' | 'TRANSCRIPT' | 'FILE' | 'PEER';
  limitations: string[];
  range?: Record<string, unknown>;
}

export interface SourceInfo {
  deviceName: string;
  agentName: string;
  adapter: string;
  access: 'local' | 'peer';
  /** The ref this answer was resolved from (echo of the caller's argument). */
  ref: string;
}

export interface Envelope {
  schemaVersion: typeof READ_SCHEMA;
  source: SourceInfo;
  observedAt: string;
  coverage: Coverage;
  data: Record<string, unknown>;
  nextCursor?: string;
}

export interface ReaderAuthContext {
  readerId: string;
  grantRevision: number;
}

/** Read deadline budgets per channel. */
export interface Deadlines {
  local: number;
  peer: number;
}

export const DEFAULT_DEADLINES: Deadlines = {
  local: LIMITS.localDeadlineMillis,
  peer: LIMITS.peerDeadlineMillis,
};
