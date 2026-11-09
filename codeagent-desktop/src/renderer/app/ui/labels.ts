/**
 * Central human-language maps (ui-polish-plan-2026-10 §5.4). Every renderer
 * surface shows these labels instead of raw service codes. Unmapped values
 * fail closed by rendering the raw value — never a blank or a fake state.
 */
import { activityKindLabel } from '../activity/activityPresentation';

/** Canonical run-state label. Merges the old sessionStatus.runStateLabel and
 * the fuzzy fallback previously kept inside ActivitySummaryPanel. */
export function runStateLabel(state: string | null | undefined): string {
  switch (state) {
    case 'RUNNING': return '执行中…';
    case 'QUEUED': return '排队中';
    case 'WAITING_APPROVAL': return '待审批';
    case 'WAITING_BUDGET_APPROVAL': return '待预算审批';
    case 'PAUSED': return '已暂停 · 可继续';
    case 'COMPLETED':
    case 'SUCCEEDED': return '已完成';
    case 'FAILED': return '已失败';
    case 'CANCELLED': return '已取消';
    case 'INTERRUPTED': return '已停止';
    case 'NEEDS_ATTENTION': return '需要注意';
    default: break;
  }
  if (!state) return '未知';
  const normalized = state.toUpperCase();
  if (normalized.includes('FAIL') || normalized.includes('ERROR')) return '已失败';
  if (normalized.includes('CANCEL')) return '已取消';
  if (normalized.includes('WAIT')) return '等待中';
  if (normalized.includes('SUCC') || normalized === 'DONE') return '已完成';
  if (normalized.includes('RUN') || normalized === 'IN_PROGRESS') return '运行中';
  return state;
}

/** Human label for a diff change type; unmapped values stay raw. */
export function changeTypeLabel(changeType?: string | null): string {
  switch (changeType) {
    case 'ADDED': return '新增';
    case 'DELETED': return '删除';
    case 'RENAMED': return '重命名';
    case 'MODIFIED': return '修改';
    case null:
    case undefined:
    case 'UNKNOWN': return '未知变更';
    default: return changeType;
  }
}

const ACTION_LABELS: Record<string, string> = {
  decision: '决策中',
  tool_call: '调用工具',
  edit: '编辑文件',
  shell: '执行命令',
  read: '读取文件',
  plan: '规划'
};

const GENERIC_KIND_LABEL = activityKindLabel('__unmapped__');

/** Label for the free-form `detail`/`action` strings activities carry. The
 * common service verbs map to Chinese; known run-activity kinds reuse the
 * timeline vocabulary; anything else renders raw. */
export function activityActionLabel(action: string | null | undefined): string {
  if (!action) return '';
  const mapped = ACTION_LABELS[action.toLowerCase()];
  if (mapped) return mapped;
  const kindLabel = activityKindLabel(action);
  return kindLabel === GENERIC_KIND_LABEL ? action : kindLabel;
}

/** Environment-target issue codes (SessionEnvironmentSection.targets[].issue). */
export function envIssueLabel(issue: string | null | undefined): string {
  switch (issue) {
    case 'TOOLCHAIN_NOT_FOUND': return '未找到工具链';
    case 'BUILD_SCRIPT_MISSING': return '缺少构建脚本';
    default: return issue ?? '';
  }
}

/** Service-owned terminal session states (TerminalSessionResponse.state). */
export function terminalStateLabel(state: string | null | undefined): string {
  switch (state) {
    case 'RUNNING': return '运行中';
    case 'STARTING': return '启动中';
    case 'EXITED': return '已退出';
    case 'TERMINATED': return '已终止';
    case 'FAILED': return '失败';
    case 'LOST': return '已失效';
    case 'CLOSED': return '已关闭';
    case 'IDLE': return '未启动';
    default: return state ?? '未知';
  }
}
