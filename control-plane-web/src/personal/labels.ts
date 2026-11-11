// PAE P6 个人管理面 — 冻结词表的中文展示标签与建议文案。
// 词表以 codeagent-desktop/packages/protocol/src/personal.ts（P0 冻结 §2/§4）
// 为唯一权威；这里只做展示映射，未知值原样显示，不回退猜测。
import type {
  EnvironmentOperationState,
  EnvironmentReasonCode,
  PersonalConnectionKind,
  ProjectedCheckStatus,
} from '../../../codeagent-desktop/packages/protocol/src/personal';

/** 环境操作七态（freeze §2）。普通界面说人话；原枚举在高级详情里仍可见。 */
export const OPERATION_STATE_LABEL: Record<string, string> = {
  QUEUED: '排队中',
  RUNNING: '进行中',
  NEEDS_INPUT: '等待你提供信息',
  READY: '环境已就绪',
  FAILED: '失败',
  CANCELED: '已取消',
  UNKNOWN: '状态待核对',
};

export const OPERATION_KIND_LABEL: Record<string, string> = {
  PREPARE: '准备环境',
  CLEANUP: '清理环境',
  RETIRE: '退役环境',
};

export const CONNECTION_KIND_LABEL: Record<string, string> = {
  CORE_LOCAL: '本机核心',
  DAEMON: '常驻 Worker',
  ACS_DIRECT: '直连服务',
};

export const CHECK_STATUS_LABEL: Record<string, string> = {
  PASS: '通过',
  FAIL: '未通过',
  BLOCKED: '被阻断',
  INCONCLUSIVE: '无法判定',
  NOT_APPLICABLE: '不适用',
  DISABLED: '已停用',
};

export const REASON_LABEL: Record<string, string> = {
  TOOLCHAIN_MISSING: '缺少工具链',
  VERSION_CONFLICT: '版本冲突',
  DEPENDENCY_UNAVAILABLE: '依赖不可用',
  NETWORK_DENIED: '网络受限',
  CREDENTIAL_REQUIRED: '需要凭据',
  SERVICE_UNREADY: '服务未就绪',
  PLATFORM_UNSUPPORTED: '平台不支持',
  BACKEND_UNAVAILABLE: '执行后端不可用',
  PLAN_INVALID: '计划无效',
  RESOURCE_EXHAUSTED: '资源不足',
  EFFECT_UNKNOWN: '效果未知',
};

/**
 * reasonCode → 给用户的下一步建议（任务单 §9.2「错误建议」）。
 * 文案只描述本界面能做的动作：调整版本、登记凭据引用、按原 key 核对等；
 * 不承诺自动修复，不引导改源码猜答案（主设计 §11.4 离线例子）。
 */
export const REASON_ADVICE: Record<EnvironmentReasonCode, string> = {
  TOOLCHAIN_MISSING: '在下方「版本选择」里选定需要的工具版本后重新生成计划；无联网时可由安装侧导入固定摘要镜像后在本页继续原操作。',
  VERSION_CONFLICT: '项目来源之间要求的版本不一致。查看各来源要求，选定一个版本后再预览计划。',
  DEPENDENCY_UNAVAILABLE: '依赖当前不可用。确认下载源可达，或改用已缓存/已登记的版本后重试。',
  NETWORK_DENIED: '该动作需要新的下载域或网络策略。到「设置与用量」确认网络策略，或由安装侧放行后重试。',
  CREDENTIAL_REQUIRED: '需要凭据引用。到「设置与用量」登记凭据引用（界面只存引用，密钥不出管理端）后重试。',
  SERVICE_UNREADY: '项目依赖的服务尚未就绪。等待服务就绪或先到 Worker 详情核对服务状态。',
  PLATFORM_UNSUPPORTED: '当前平台/架构组合不受支持。更换执行后端或平台后再生成计划。',
  BACKEND_UNAVAILABLE: '执行后端不可用。到「我的 Workers」核对 Worker/Operator 连接状态。',
  PLAN_INVALID: '计划无效。重新生成计划预览，确认缺项已补齐后再提交准备。',
  RESOURCE_EXHAUSTED: '资源不足。释放磁盘空间或并发额度后按原操作重查。',
  EFFECT_UNKNOWN: '上次操作的效果未能确认。按原 requestKey 核对原操作状态，不要重复提交。',
};

export function operationStateLabel(state: string | null | undefined): string {
  return (state && OPERATION_STATE_LABEL[state]) ?? (state || '未知');
}

export function reasonLabel(code: string | null | undefined): string {
  return (code && REASON_LABEL[code]) ?? (code || '未知原因');
}

/** reasonCode 未识别时给通用建议；已识别的给针对性建议。 */
export function reasonAdvice(code: string | null | undefined): string {
  if (!code) return '查看原操作事件获取细节。';
  return REASON_ADVICE[code as EnvironmentReasonCode] ?? '查看原操作事件获取细节，或按原 requestKey 重新核对。';
}

export function checkStatusLabel(status: string | null | undefined): string {
  return (status && CHECK_STATUS_LABEL[status]) ?? (status || '未知');
}

export function connectionKindLabel(kind: PersonalConnectionKind | (string & {}) | null | undefined): string {
  return (kind && CONNECTION_KIND_LABEL[kind]) ?? (kind || '未知');
}

/** 三个联合能力（freeze §2）的中文名；缺件报 OFF 不广告。 */
export const CAPABILITY_LABEL: Record<string, string> = {
  projectEnvironmentPrepareV1: '项目环境准备',
  environmentBoundExecutionV1: '环境绑定执行',
  adaptiveActionV1: '自适应动作',
};

/** 操作状态 → badge 色调（global.css 已有 tone 词表）。 */
export function operationStateTone(state: EnvironmentOperationState | (string & {}) | null | undefined): string {
  switch (state) {
    case 'READY': return 'success';
    case 'FAILED': return 'failure';
    case 'RUNNING': return 'info';
    case 'QUEUED': return 'plain';
    case 'NEEDS_INPUT': return 'conflict';
    case 'CANCELED': return 'plain';
    case 'UNKNOWN': return 'unknown';
    default: return 'unknown';
  }
}

export function checkStatusTone(status: ProjectedCheckStatus | (string & {}) | null | undefined): string {
  switch (status) {
    case 'PASS': return 'success';
    case 'FAIL': return 'failure';
    case 'BLOCKED': return 'conflict';
    case 'INCONCLUSIVE': return 'unknown';
    case 'NOT_APPLICABLE': return 'plain';
    case 'DISABLED': return 'plain';
    default: return 'unknown';
  }
}
