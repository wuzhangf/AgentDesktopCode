// PAE P6 个人管理面 — 纯展示逻辑（无 React / 无 fetch），可独立测试。
// 覆盖任务单 §9：待处理合并去重、supportedActions 门禁（未声明即不支持）、
// 原操作恢复登记（localStorage）、任务启动所需能力检查、最近任务记录。
import type {
  PersonalAttentionItem,
  PersonalMeta,
  PersonalOperation,
  PersonalWorkerView,
  ProjectEnvironmentView,
} from '../../../codeagent-desktop/packages/protocol/src/personal';

// ---------- 操作状态 ----------

/** 写者未写完的活动状态：QUEUED/RUNNING 快轮询；UNKNOWN 慢轮询核对（§6 冻结语义）。 */
export function operationPollInterval(state: string | null | undefined): number | false {
  if (state === 'QUEUED' || state === 'RUNNING') return 1500;
  if (state === 'UNKNOWN') return 5000;
  return false;
}

// ---------- supportedActions 门禁 ----------

/**
 * meta.supportedActions 是服务端权威动作名单（freeze §4）。按冻结语义
 * 「未声明即不支持，禁止静默回退」：名单缺失或为空一律视为不支持，
 * 按钮不显示/不启用——手机窄接口与未授权写操作由此隐藏（§9.6）。
 */
export function supports(meta: PersonalMeta | null | undefined, action: PersonalOperation['action']): boolean {
  const list = meta?.supportedActions;
  return Array.isArray(list) ? list.includes(action) : false;
}

/** 写操作总开关：只读面（mobile/readonly）一律隐藏可执行按钮。 */
export function canWrite(meta: PersonalMeta | null | undefined, action: PersonalOperation['action'], readonly: boolean): boolean {
  return !readonly && supports(meta, action);
}

// ---------- 待处理合并（§9.5：合并同一根因重复提醒） ----------

export interface MergedAttention {
  kind: string;
  refId?: string | null;
  projectId?: string | null;
  operationId?: string | null;
  reasonCode?: string | null;
  message: string;
  observedAt?: string | null;
  /** 同根因条目数；1 表示无合并。 */
  count: number;
}

/** 同 kind + 同根因对象 + 同 reasonCode 的提醒合并为一条，保留最新文案与时间。 */
export function mergeAttention(items: readonly PersonalAttentionItem[] | null | undefined): MergedAttention[] {
  const groups = new Map<string, MergedAttention>();
  for (const item of items ?? []) {
    const root = item.operationId ?? item.refId ?? item.projectId ?? '';
    const key = `${item.kind ?? ''}|${item.reasonCode ?? ''}|${root}`;
    const existing = groups.get(key);
    if (!existing) {
      groups.set(key, {
        kind: item.kind, refId: item.refId ?? null, projectId: item.projectId ?? null,
        operationId: item.operationId ?? null, reasonCode: item.reasonCode ?? null,
        message: item.message, observedAt: item.observedAt ?? null, count: 1,
      });
    } else {
      existing.count += 1;
      if ((item.observedAt ?? '') > (existing.observedAt ?? '')) {
        existing.message = item.message;
        existing.observedAt = item.observedAt ?? null;
      }
    }
  }
  return [...groups.values()].sort((a, b) => (b.observedAt ?? '').localeCompare(a.observedAt ?? ''));
}

export type AttentionTarget =
  | { type: 'operation'; operationId: string; projectId?: string | null }
  | { type: 'task'; taskId: string; projectId?: string | null }
  | { type: 'project'; projectId: string }
  | { type: 'none' };

/** 待处理项直达原对象：原操作 > 任务 > 项目（§9.5）。 */
export function attentionTarget(item: MergedAttention): AttentionTarget {
  if (item.operationId) return { type: 'operation', operationId: item.operationId, projectId: item.projectId };
  if (item.refId) return { type: 'task', taskId: item.refId, projectId: item.projectId };
  if (item.projectId) return { type: 'project', projectId: item.projectId };
  return { type: 'none' };
}

// ---------- 原操作恢复登记（刷新/重启后按原 requestKey/operationId 续查） ----------

export interface PendingOperationRecord {
  operationId: string;
  requestKey?: string | null;
  submittedAt: string;
}

const PENDING_OP_PREFIX = 'pae.p6.pendingOp.';
const RECENT_TASKS_KEY = 'pae.p6.recentTasks';

/** 受限环境（无痕/测试）里 localStorage 可能抛错，降级为无登记。 */
function safeStorage(storage?: Storage | null): Storage | null {
  if (storage !== undefined) return storage;
  try { return globalThis.localStorage ?? null; } catch { return null; }
}

export function readPendingOperation(projectId: string, storage?: Storage | null): PendingOperationRecord | null {
  const store = safeStorage(storage);
  if (!store) return null;
  try {
    const raw = store.getItem(PENDING_OP_PREFIX + projectId);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PendingOperationRecord;
    if (typeof parsed?.operationId !== 'string' || !parsed.operationId) return null;
    return parsed;
  } catch { return null; }
}

export function writePendingOperation(projectId: string, record: PendingOperationRecord, storage?: Storage | null): void {
  const store = safeStorage(storage);
  if (!store) return;
  try { store.setItem(PENDING_OP_PREFIX + projectId, JSON.stringify(record)); } catch { /* quota/隐私模式：无登记不阻断 */ }
}

export function clearPendingOperation(projectId: string, storage?: Storage | null): void {
  const store = safeStorage(storage);
  if (!store) return;
  try { store.removeItem(PENDING_OP_PREFIX + projectId); } catch { /* ignore */ }
}

/** 全部项目的未决操作登记（总览页「原操作恢复」直达用）。 */
export function listPendingOperations(storage?: Storage | null): ({ projectId: string } & PendingOperationRecord)[] {
  const store = safeStorage(storage);
  if (!store) return [];
  const out: ({ projectId: string } & PendingOperationRecord)[] = [];
  try {
    for (let i = 0; i < store.length; i++) {
      const key = store.key(i);
      if (!key?.startsWith(PENDING_OP_PREFIX)) continue;
      const projectId = key.slice(PENDING_OP_PREFIX.length);
      const rec = readPendingOperation(projectId, store);
      if (rec) out.push({ projectId, ...rec });
    }
  } catch { /* ignore */ }
  return out.sort((a, b) => b.submittedAt.localeCompare(a.submittedAt));
}

// ---------- 最近打开的任务（本机导航辅助，非服务端事实） ----------

export interface RecentTask { taskId: string; projectId?: string | null; openedAt: string }

export function listRecentTasks(storage?: Storage | null): RecentTask[] {
  const store = safeStorage(storage);
  if (!store) return [];
  try {
    const raw = store.getItem(RECENT_TASKS_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed)
      ? parsed.filter(t => t && typeof t.taskId === 'string').slice(0, 8)
      : [];
  } catch { return []; }
}

export function recordRecentTask(taskId: string, projectId?: string | null, storage?: Storage | null): void {
  const store = safeStorage(storage);
  if (!store) return;
  try {
    const rest = listRecentTasks(store).filter(t => t.taskId !== taskId);
    rest.unshift({ taskId, projectId: projectId ?? null, openedAt: new Date().toISOString() });
    store.setItem(RECENT_TASKS_KEY, JSON.stringify(rest.slice(0, 8)));
  } catch { /* ignore */ }
}

// ---------- 任务启动检查（§9.4：仅查所需能力；纯 Design 不强迫构建环境） ----------

export type TaskKind = 'design' | 'code';

export type LaunchCheckState = 'ok' | 'blocked' | 'not-required' | 'unknown';

export interface LaunchCheck {
  id: string;
  label: string;
  state: LaunchCheckState;
  detail?: string;
}

/**
 * 启动前只检查该任务真正需要的能力：
 * - 纯设计/文档任务不要求运行环境就绪（不强迫安装构建环境）；
 * - 代码执行任务要求所选项目的运行环境 READY，且至少一个 Worker 声明
 *   environmentBoundExecutionV1（联合能力三件套齐备才广告）。
 * 环境准备能力（projectEnvironmentPrepareV1）缺失只影响「先准备环境」按钮，
 * 不作为启动阻断——已有 READY 环境不需要它。
 */
export function launchChecks(args: {
  kind: TaskKind;
  projectId: string;
  core?: string;
  env?: ProjectEnvironmentView | null;
  envLoaded: boolean;
  workers?: PersonalWorkerView[] | null;
}): LaunchCheck[] {
  const { kind, projectId, core, env, envLoaded, workers } = args;
  const checks: LaunchCheck[] = [];
  checks.push({
    id: 'project', label: '已选择已登记项目',
    state: projectId ? 'ok' : 'blocked',
    detail: projectId ? undefined : '先在项目页登记或选择一个项目',
  });
  checks.push({
    id: 'core', label: '已选择核心',
    state: core ? 'ok' : 'blocked',
    detail: core ? undefined : '选择本次任务使用的核心；未选核心不启动不探活',
  });
  if (kind === 'design') {
    checks.push({
      id: 'env', label: '运行环境',
      state: 'not-required',
      detail: '纯设计/文档任务不强制准备构建环境',
    });
    return checks;
  }
  if (!envLoaded) {
    checks.push({ id: 'env', label: '运行环境就绪', state: 'unknown', detail: '环境视图尚未读取' });
  } else if (env?.state === 'READY') {
    checks.push({ id: 'env', label: '运行环境就绪', state: 'ok', detail: env.environmentId ?? undefined });
  } else {
    checks.push({
      id: 'env', label: '运行环境就绪', state: 'blocked',
      detail: env?.state ? `当前状态：${env.state}——可先在项目页准备环境` : '尚无已就绪环境——可先在项目页准备',
    });
  }
  const bound = workers?.some(w => w.capabilities?.environmentBoundExecutionV1 === true);
  checks.push({
    id: 'exec', label: '环境绑定执行能力', state: workers == null ? 'unknown' : bound ? 'ok' : 'blocked',
    detail: workers == null ? 'Worker 能力尚未读取' : bound ? undefined : '没有 Worker 声明 environmentBoundExecutionV1（缺件报 OFF）',
  });
  const supportedCores = env?.supportedCores;
  if (supportedCores?.length && core) {
    checks.push({
      id: 'core-supported', label: '所选核心受环境支持',
      state: supportedCores.includes(core) ? 'ok' : 'blocked',
      detail: supportedCores.includes(core) ? undefined : `环境支持：${supportedCores.join('、')}`,
    });
  }
  return checks;
}

export function launchBlocked(checks: LaunchCheck[]): boolean {
  return checks.some(c => c.state === 'blocked' || c.state === 'unknown');
}

// ---------- 写请求体的冻结约束 ----------

const DECIMAL_REVISION = /^(0|[1-9][0-9]{0,18})$/;

/**
 * expectedRevision/environmentRevision 只接受十进制修订号
 * （protocol personalBodyValid：^\d+$ 且 ≤19 位）。服务端返回非十进制
 * 修订（如 'rev-2'）时前端不带 expectedRevision——宁可不声明乐观并发，
 * 也不让整个写请求因校验失败被拒。
 */
export function decimalRevision(v: string | null | undefined): string | undefined {
  return typeof v === 'string' && DECIMAL_REVISION.test(v) ? v : undefined;
}

/** 冻结的 boundedText 上限：超长直接丢字段，不截断成脏值。 */
export function boundedOrUndef(v: string | null | undefined, max: number): string | undefined {
  return typeof v === 'string' && v.length > 0 && v.length <= max ? v : undefined;
}

// ---------- 展示小工具 ----------

/** RFC-3339 UTC 字符串 → 本地短格式；无效/缺失显示「未知」。 */
export function fmtIso(iso: string | null | undefined): string {
  if (!iso) return '未知';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '未知';
  return new Date(t).toLocaleString('zh-CN', {
    hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  });
}

/** 字节/大小等可空字段：null → 未知，绝不把未知显示成 0（任务单 §9.2）。 */
export function fmtBytesOrUnknown(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '未知';
  if (n < 1024) return `${n} B`;
  if (n < 1_048_576) return `${(n / 1024).toFixed(1)} KiB`;
  if (n < 1_073_741_824) return `${(n / 1_048_576).toFixed(1)} MiB`;
  return `${(n / 1_073_741_824).toFixed(1)} GiB`;
}
