/**
 * Centralized presentation registry for settings enums and reason codes
 * (settings design §4/§11.3/§12.3).
 *
 * User-facing copy is zh-CN; canonical enum values stay available for
 * advanced details and diagnostics. Unknown values fail closed to the raw
 * value with an unknown marker instead of being silently prettified.
 */

import type { SettingsScope } from './useSettingsDraft';

export type SettingMutability = 'EDITABLE' | 'READ_ONLY' | 'MANAGED_LOCKED' | 'UNAVAILABLE';
export type ApplyMode = 'IMMEDIATE' | 'NEXT_SAFE_REQUEST' | 'NEXT_RUN' | 'NEW_SESSION' | 'RECONNECT' | 'SERVICE_RESTART';
export type Availability = 'AVAILABLE' | 'DEGRADED' | 'UNAVAILABLE' | 'UNKNOWN';

export const SCOPE_LABELS: Record<SettingsScope, string> = {
  MANAGED: '管理员',
  SERVICE_INSTANCE: 'Service 实例',
  PROJECT: '项目',
  USER: '个人',
  SESSION: '当前会话'
};

export const MUTABILITY_LABELS: Record<SettingMutability, string> = {
  EDITABLE: '可编辑',
  READ_ONLY: '只读',
  MANAGED_LOCKED: '管理员锁定',
  UNAVAILABLE: '不可用'
};

export const APPLY_MODE_LABELS: Record<ApplyMode, string> = {
  IMMEDIATE: '立即生效',
  NEXT_SAFE_REQUEST: '当前调用结束后的下一个安全请求生效',
  NEXT_RUN: '下次运行生效',
  NEW_SESSION: '新会话生效',
  RECONNECT: '重新连接后生效',
  SERVICE_RESTART: '重启 Service 后生效'
};

/** Saved-feedback copy per §7.3; kept distinct from APPLY_MODE_LABELS. */
export const SAVE_FEEDBACK_LABELS: Record<ApplyMode, string> = {
  IMMEDIATE: '已保存 · 已立即生效',
  NEXT_SAFE_REQUEST: '已保存 · 下一个安全请求生效',
  NEXT_RUN: '已保存 · 对新运行生效',
  NEW_SESSION: '已保存 · 对新会话生效',
  RECONNECT: '已保存 · 重新连接后生效',
  SERVICE_RESTART: '已保存 · 重启 Service 后生效'
};

export const AVAILABILITY_LABELS: Record<Availability, string> = {
  AVAILABLE: '可用',
  DEGRADED: '降级',
  UNAVAILABLE: '不可用',
  UNKNOWN: '未知'
};

export const MODEL_AVAILABILITY_LABELS: Record<string, string> = {
  AVAILABLE: '可用',
  UNCONFIGURED: '尚未配置',
  UNAVAILABLE: '不可用',
  UNKNOWN: '未知'
};

export const AUTONOMY_LABELS: Record<string, string> = {
  OFF: '关闭',
  LOW: '谨慎推进',
  MEDIUM: '范围内推进',
  HIGH: '连续推进'
};

export const THEME_LABELS: Record<string, string> = {
  SYSTEM: '跟随系统',
  DARK: '深色',
  LIGHT: '浅色'
};

export const DENSITY_LABELS: Record<string, string> = {
  SUMMARY: '紧凑',
  STANDARD: '标准',
  DETAILED: '宽松'
};

export const REDUCE_MOTION_LABELS: Record<string, string> = {
  SYSTEM: '跟随系统',
  ON: '减少动效',
  OFF: '正常动效'
};

export const SEND_SHORTCUT_LABELS: Record<string, string> = {
  ENTER: 'Enter 发送',
  MOD_ENTER: 'Ctrl/Cmd+Enter 发送'
};

export const LANGUAGE_LABELS: Record<string, string> = {
  SYSTEM: '跟随系统',
  'zh-CN': '简体中文',
  'en-US': 'English'
};

export const FEATURE_STATE_LABELS: Record<string, string> = {
  READY: '已就绪',
  ENABLED_NOT_READY: '已启用未就绪',
  NOT_ENABLED: '未启用',
  NOT_INSTALLED: '未安装',
  UNKNOWN: '状态未知',
  UNSUPPORTED: '当前环境不支持'
};

export const FEATURE_INSTALLATION_LABELS: Record<string, string> = {
  NOT_REQUIRED: '无需安装',
  INSTALLED: '已安装',
  MISSING: '缺失',
  UNKNOWN: '未知'
};

export const FEATURE_CHECK_LABELS: Record<string, string> = {
  PASS: '通过',
  FAIL: '失败',
  WARN: '警告',
  UNKNOWN: '未知',
  CHECKING: '检测中'
};

/** Tool effect classes on the AGENT_TOOLS catalog card. */
export const FEATURE_TOOL_EFFECT_LABELS: Record<string, string> = {
  READ: '读取',
  WRITE: '写入',
  DELETE: '删除',
  NETWORK: '网络'
};

/**
 * Service-level availability projection for a catalog tool. CONDITIONAL
 * means the run resolver assembles it per run (workspace shape, write
 * policy, run-scoped bindings); GATED means a feature prerequisite is
 * off or unready right now.
 */
export const FEATURE_TOOL_AVAILABILITY_LABELS: Record<string, string> = {
  AVAILABLE: '可用',
  CONDITIONAL: '按运行装配',
  GATED: '受门控'
};

export const FEATURE_APPLY_STATUS_LABELS: Record<string, string> = {
  APPLIED: '已应用',
  PENDING: '待重启应用',
  APPLY_FAILED: '应用失败'
};

export const MANAGED_SOURCE_LABELS: Record<string, string> = {
  FILE: '配置文件',
  DATABASE: '数据库',
  OVERRIDE: '数据库覆盖',
  FILE_IMPORT: '文件导入'
};

export const CREDENTIAL_KIND_LABELS: Record<string, string> = {
  ENV: '环境变量',
  SECRET: '系统加密存储',
  FILE_INLINE: '配置文件',
  NONE: '未配置'
};

export function featureStateLabel(state: string | null | undefined): string {
  if (!state) return '未知';
  return FEATURE_STATE_LABELS[state] ?? state;
}

/** Reason codes from the error contract (§9.6) plus capability reasons. */
const REASON_CODE_LABELS: Record<string, string> = {
  STATE_VERSION_CONFLICT: '保存冲突：设置已被其他窗口或服务端修改',
  POLICY_ELEVATION_FORBIDDEN: '不能放宽：低层策略只能保持或收紧上层限制',
  POLICY_LAYER_IMMUTABLE: '该策略层由管理员冻结，不可修改',
  MODEL_POLICY_REJECTED: '模型策略拒绝了本次修改',
  MODEL_SELECTION_AMBIGUOUS: '该模型由多个提供商提供，请明确选择提供商',
  MODEL_ALIAS_UNKNOWN: '该模型不在当前目录中',
  MODEL_UNAVAILABLE: '模型当前不可用',
  PROTOCOL_INCOMPATIBLE: '桌面与 Service 协议版本不兼容',
  SERVICE_NOT_CONNECTED: 'Service 未连接',
  IPC_REJECTED: '请求被桌面安全层拒绝',
  UNAVAILABLE: '能力不可用',
  SERVICE_INSTANCE_CHANGED: '已连接到不同的 Service 实例',
  CONFIG_SCHEMA_INVALID: '配置格式不正确',
  CONFIG_SEMANTIC_INVALID: '配置组合冲突',
  MODEL_IN_USE: '该模型或提供商仍是默认引用，请先更换默认模型',
  INVALID_CATALOG: '模型目录校验未通过',
  CONFIG_STORE_UNAVAILABLE: '配置数据库不可用',
  REVISION_CONFLICT: '保存冲突：设置已被其他窗口或服务端修改',
  SETTINGS_SAVE_TIMEOUT: '保存结果未知：请重新读取权威状态后再试'
};

/** Human copy for a reason code; unknown codes fail closed to the raw value. */
export function reasonLabel(reasonCode: string | null | undefined): string | null {
  if (!reasonCode) return null;
  return REASON_CODE_LABELS[reasonCode] ?? reasonCode;
}

/**
 * Saves surface proxy failures as `CODE: detail`. Show the mapped user copy
 * for known codes and keep the raw code visible in parentheses for unknown
 * ones — never swallow an unrecognized failure as success.
 */
export function friendlySaveError(message: string | null | undefined): string {
  if (!message) return '保存失败';
  const separator = message.indexOf(':');
  const code = separator > 0 ? message.slice(0, separator).trim() : message.trim();
  const detail = separator > 0 ? message.slice(separator + 1).trim() : '';
  const mapped = reasonLabel(code);
  if (mapped && detail) return `${mapped}（${detail}）`;
  if (mapped) return mapped;
  return detail ? message : `${message}`;
}

export function scopeLabel(scope: SettingsScope | string): string {
  return SCOPE_LABELS[scope as SettingsScope] ?? scope;
}

export function applyModeLabel(mode: ApplyMode | string): string {
  return APPLY_MODE_LABELS[mode as ApplyMode] ?? mode;
}

export function availabilityLabel(value: string | null | undefined): string {
  if (!value) return AVAILABILITY_LABELS.UNKNOWN;
  return AVAILABILITY_LABELS[value as Availability] ?? MODEL_AVAILABILITY_LABELS[value] ?? value;
}
