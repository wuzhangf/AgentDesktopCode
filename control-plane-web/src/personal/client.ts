// PAE P6 个人管理面 — `/api/personal/v1` 传输层。
// 两个实现共用同一 PersonalOperation 白名单（P0 冻结 §4，protocol/personal.ts）：
// - createFetchTransport：浏览器同源 fetch（Web 与「窄接口」展示面）
// - createDesktopTransport：Electron preload 暴露的 window.codeAgentDesktop
//   窄桥（P8 装配 IPC 通道 app/personal）。window.codeAgentDesktop 只在本文件
//   做结构探测，不进入任何页面组件——页面只见到 PersonalGateway typed port。
import {
  PERSONAL_API_PREFIX,
  PERSONAL_ROUTES,
  decodePersonalError,
  validPersonalEnvelope,
  validPersonalOperation,
  type PersonalEnvelope,
  type PersonalOperation,
} from '../../../codeagent-desktop/packages/protocol/src/personal';

/** 一次 transport 调用 = 一条冻结的 PersonalOperation → 一个 envelope。 */
export type PersonalTransport = (operation: PersonalOperation) => Promise<PersonalEnvelope<unknown>>;

/** 页面拿到的错误形态：稳定 code + retryable + requestId（freeze §4 {error}）。 */
export class PersonalClientError extends Error {
  code: string;
  retryable: boolean;
  status?: number;
  requestId?: string;
  constructor(code: string, message: string, opts: { retryable?: boolean; status?: number; requestId?: string } = {}) {
    super(message);
    this.name = 'PersonalClientError';
    this.code = code;
    this.retryable = opts.retryable ?? false;
    this.status = opts.status;
    this.requestId = opts.requestId;
  }
}

const ROUTE_MARKERS = [
  ['{project}', 'projectId'],
  ['{operation}', 'operationId'],
  ['{worker}', 'workerId'],
  ['{task}', 'taskId'],
  ['{action}', 'actionId'],
  ['{report}', 'reportId'],
  ['{requestKey}', 'requestKey'],
  ['{entity}', 'entityId'],
] as const;

/** operation → 已替换路径参数的路径尾部（与 ServiceClient.personalOperation 同序）。 */
export function personalOperationTail(operation: PersonalOperation): { method: 'GET' | 'POST'; tail: string } {
  const route = PERSONAL_ROUTES[operation.action];
  let tail = route.tail;
  for (const [marker, field] of ROUTE_MARKERS) {
    if (tail.includes(marker)) {
      tail = tail.replace(marker, encodeURIComponent((operation as unknown as Record<string, string>)[field]));
    }
  }
  return { method: route.method, tail };
}

const TAB_STORAGE_KEY = 'pae.personal.tabId';
let memoryTabId: string | undefined;

/** P5 网关浏览器会话身份（`x-personal-tab`，冻结 ID 正则）。按 tab 稳定：
 * sessionStorage 持久（刷新不丢、新 tab 新身份）；无 storage 环境退回内存值。 */
export function resolvePersonalTabId(storage?: Pick<Storage, 'getItem' | 'setItem'>): string {
  try {
    const store = storage ?? (typeof sessionStorage !== 'undefined' ? sessionStorage : undefined);
    const existing = store?.getItem(TAB_STORAGE_KEY) ?? memoryTabId;
    if (existing && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(existing)) return existing;
    const id = `tab-${crypto.randomUUID()}`;
    try { store?.setItem(TAB_STORAGE_KEY, id); } catch { /* storage full/blocked — memory id still works */ }
    memoryTabId = id;
    return id;
  } catch {
    return (memoryTabId ??= `tab-${crypto.randomUUID()}`);
  }
}

/** P5 网关同源守卫头：每个 API 请求必带（server/management README §P8）。
 * `personal_control` cookie 由首个响应种下，credentials:'same-origin' 自动携带。 */
export function personalControlHeaders(tabId?: string): Record<string, string> {
  return { 'x-personal-control': '1', 'x-personal-tab': tabId ?? resolvePersonalTabId() };
}

/** 同源 fetch 实现（Web）。写操作把 requestKey 同时写进 body 与
 * Idempotency-Key 头——与 ServiceClient.requestPersonal 语义一致；
 * envelope 守卫 fail-closed；{error} 形状映射为 PersonalClientError。 */
export function createFetchTransport(opts: { fetchImpl?: typeof fetch; prefix?: string; tabId?: string } = {}): PersonalTransport {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const prefix = opts.prefix ?? '';
  return async (operation) => {
    if (!validPersonalOperation(operation)) {
      throw new PersonalClientError('INVALID_OPERATION', '操作不属于已登记的个人管理动作');
    }
    const { method, tail } = personalOperationTail(operation);
    let path = `${prefix}${PERSONAL_API_PREFIX}${tail}`;
    if ((operation.action === 'OPERATION_EVENTS' || operation.action === 'TASKS' || operation.action === 'TASK_MESSAGES' || operation.action === 'TASK_APPROVALS' || operation.action === 'TASK_INTERACTIONS')) {
      const query = new URLSearchParams();
      if (operation.cursor) query.set('cursor', operation.cursor);
      if (operation.limit) query.set('limit', operation.limit);
      // native-messages/1 paging（design §8.1）：仅 TASK_MESSAGES 固定
      // operation 携带 before；其余 operation 的游标语义不变。
      if (operation.action === 'TASK_MESSAGES' && operation.before) query.set('before', operation.before);
      if (query.size) path += `?${query}`;
    }
    if (operation.action === 'TASK_ACTIVITY') {
      const query = new URLSearchParams();
      if (operation.afterCursor) query.set('afterCursor', operation.afterCursor);
      if (operation.limit) query.set('limit', operation.limit);
      if (query.size) path += `?${query}`;
    }
    if (operation.action === 'TASK_COMMANDS') {
      const query = new URLSearchParams();
      if (operation.limit) query.set('limit', operation.limit);
      if (operation.before) query.set('before', operation.before);
      if (query.size) path += `?${query}`;
    }
    if ('runId' in operation && operation.runId) path += `${path.includes('?') ? '&' : '?'}runId=${encodeURIComponent(operation.runId)}`;
    const headers: Record<string, string> = { accept: 'application/json', ...personalControlHeaders(opts.tabId) };
    let payload: string | undefined;
    if (method === 'POST' && 'body' in operation && 'key' in operation) {
      headers['content-type'] = 'application/json';
      headers['idempotency-key'] = operation.key;
      payload = JSON.stringify({ ...operation.body, requestKey: operation.key });
    }
    const response = await fetchImpl(path, {
      method, headers, body: payload, credentials: 'same-origin',
    });
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const problem = decodePersonalError(body);
      if (problem) {
        throw new PersonalClientError(problem.code, problem.message ?? `请求失败 (${response.status})`, {
          retryable: problem.retryable, status: response.status, requestId: problem.requestId,
        });
      }
      throw new PersonalClientError(`HTTP_${response.status}`, `请求失败 (${response.status})`, { status: response.status });
    }
    if (!validPersonalEnvelope(body)) {
      throw new PersonalClientError('PROTOCOL_ERROR', '个人管理服务返回了无法识别的回执形态', { status: response.status });
    }
    return body;
  };
}

/**
 * Desktop 窄桥接口（P8 装配）：preload 在 window.codeAgentDesktop 上暴露
 * `personalOperation(operation)`，main 进程经 IPC `app/personal` 调
 * ServiceClient.personalOperation。返回 DesktopResult<T> = T | DesktopError
 * 或直接 envelope — 两种都接受，便于 IPC handler 直接转发。
 */
export interface PersonalDesktopBridge {
  personalOperation?: (operation: PersonalOperation) => Promise<unknown>;
}

interface DesktopErrorLike { error: string; code: string; status?: number }

function isDesktopError(result: unknown): result is DesktopErrorLike {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return false;
  const r = result as Record<string, unknown>;
  return typeof r.error === 'string' && typeof r.code === 'string' && !('data' in r);
}

export function createDesktopTransport(bridge: PersonalDesktopBridge): PersonalTransport {
  return async (operation) => {
    if (!validPersonalOperation(operation)) {
      throw new PersonalClientError('INVALID_OPERATION', '操作不属于已登记的个人管理动作');
    }
    if (typeof bridge.personalOperation !== 'function') {
      throw new PersonalClientError('NO_DESKTOP_BRIDGE', '本机 Desktop 通道未装配个人管理操作');
    }
    const result = await bridge.personalOperation(operation);
    // IPC admission failures arrive as {error:string, code:string}（registry.ts 惯例）。
    if (isDesktopError(result)) {
      throw new PersonalClientError(result.code, result.error, { status: result.status });
    }
    // 服务端 {error:{code,...}} 经 DesktopResult 透传时仍按冻结形状解码。
    const problem = decodePersonalError(result);
    if (problem && !validPersonalEnvelope(result)) {
      throw new PersonalClientError(problem.code, problem.message ?? '个人管理服务错误', {
        retryable: problem.retryable, requestId: problem.requestId,
      });
    }
    if (!validPersonalEnvelope(result)) {
      throw new PersonalClientError('PROTOCOL_ERROR', '个人管理通道返回了无法识别的回执形态');
    }
    return result;
  };
}
