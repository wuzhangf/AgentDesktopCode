/**
 * Presentation labels for the activity timeline (design §11.4). Kind and
 * status stay stable service facts; only the display wording lives here.
 */
import type { IconName } from '../Icon';
import type { RunActivity } from './activityTypes';

export function activityKindLabel(kind: string): string {
  switch (kind) {
    case 'FILE_LIST': return '列出目录';
    case 'FILE_READ': return '读取文件';
    case 'CODE_SEARCH': return '搜索代码';
    case 'FILE_LOOKUP': return '查找文件';
    case 'WORKSPACE_ANALYSIS': return '分析工作区';
    case 'FILE_WRITE': return '修改文件';
    case 'COMMAND': return '执行命令';
    case 'BUILD': return '构建';
    case 'GIT': return '检查 Git';
    case 'JAVA_SEMANTIC': return '代码语义查询';
    case 'DELEGATION': return '子任务调研';
    case 'WEB_FETCH': return '网页抓取';
    case 'WEB_SEARCH': return '网页搜索';
    case 'MODEL': return '模型推理';
    case 'FINALIZE': return '整理结果';
    // WU08: governed extension invocations emitted by the service render as
    // their own row kind; anything else keeps the generic label.
    case 'EXTENSION': case 'MCP_TOOL': case 'MCP_RESOURCE': case 'MCP_PROMPT':
      return '扩展工具';
    case 'SKILL_SCRIPT': return 'Skill 脚本';
    default: return '执行操作';
  }
}

export function activityKindIcon(kind: string): 'search' | 'file' | 'terminal' | 'code' | 'list' | 'chat' {
  switch (kind) {
    case 'FILE_LIST': case 'FILE_LOOKUP': return 'list';
    case 'CODE_SEARCH': case 'JAVA_SEMANTIC': case 'WEB_SEARCH': return 'search';
    case 'FILE_READ': case 'WORKSPACE_ANALYSIS': case 'WEB_FETCH': return 'file';
    case 'COMMAND': case 'BUILD': case 'GIT': return 'terminal';
    case 'FILE_WRITE': return 'code';
    default: return 'chat';
  }
}

// Design 2026-09-30 §5.4.3: svg kind icon for activity rows. Reuses the
// activityKindIcon grouping; MODEL renders its own thinking glyph.
export function activityKindIconName(kind: string): IconName {
  if (kind === 'MODEL') return 'thinking';
  if (kind === 'DELEGATION') return 'chat';
  return activityKindIcon(kind);
}

// Design 2026-09-30 §3.5/§5.4.3: svg status icon for activity rows.
// REJECTED/CANCELLED are still failures but read quieter — the caller mutes.
export function activityStatusIconName(status: string): IconName | null {
  switch (status) {
    case 'RUNNING': return 'loader';
    case 'SUCCEEDED': return 'check';
    case 'FAILED': case 'TIMED_OUT': case 'ABORTED': case 'STALE':
    case 'REJECTED': case 'CANCELLED': return 'x';
    case 'WAITING_APPROVAL': return 'pause';
    case 'PARTIAL': case 'UNKNOWN': return 'alert';
    case 'REQUESTED': return null;
    default: return 'alert';
  }
}

/**
 * Compact unicode glyph for round-block activity rows (design 2026-09-19
 * §3.3): command-like kinds get a terminal glyph, other tool kinds get
 * their mapped glyph. Pure presentation; kind stays the service fact.
 */
export function activityKindGlyph(kind: string): string {
  switch (activityKindIcon(kind)) {
    case 'terminal': return '❯';
    case 'search': return '⌕';
    case 'file': return '▤';
    case 'code': return '✎';
    case 'list': return '≣';
    default: return '◦';
  }
}

export function activityStatusGlyph(status: string): string {
  switch (status) {
    case 'RUNNING': return '…';
    case 'SUCCEEDED': return '✓';
    case 'PARTIAL': return '◐';
    case 'FAILED': case 'TIMED_OUT': case 'ABORTED': case 'STALE': return '✗';
    case 'REJECTED': return '⃠';
    case 'CANCELLED': return '×';
    case 'WAITING_APPROVAL': return '⏸';
    // REQUESTED is an input/parameter ref (e.g. a search scope), not an
    // outcome — a neutral bullet instead of the ambiguous '?'.
    case 'REQUESTED': return '·';
    default: return '?';
  }
}

export function isFailedStatus(status: string): boolean {
  return status === 'FAILED' || status === 'TIMED_OUT' || status === 'ABORTED'
    || status === 'REJECTED' || status === 'UNKNOWN';
}

/** Collapsed groups hide plain success; anything else stays visible. */
export function isAttentionWorthy(activity: RunActivity): boolean {
  // A structured failure/effect is authoritative even when an older event
  // carried a misleading success status. UNKNOWN effects must stay visible.
  return activity.status !== 'SUCCEEDED'
    || activity.failure != null
    || activity.effectState === 'UNKNOWN';
}

export function formatDuration(millis?: number | null): string | null {
  if (millis === null || millis === undefined || millis < 0) return null;
  if (millis < 1000) return `${millis}ms`;
  if (millis < 60_000) return `${(millis / 1000).toFixed(1)}s`;
  const minutes = Math.floor(millis / 60_000);
  const seconds = Math.round((millis % 60_000) / 1000);
  return `${minutes}m${seconds.toString().padStart(2, '0')}s`;
}

export function redactionBadge(state?: string | null): string | null {
  if (state === 'REDACTED') return '已脱敏';
  if (state === 'WITHHELD') return '命令内容因安全策略隐藏';
  return null;
}

// Design 2026-09-30 §5.4.5: human reading for activity-history reason codes.
// Unknown codes pass through so new service codes still surface verbatim.
export function activityHistoryReasonLabel(code: string | null | undefined): string | null {
  switch (code) {
    case 'ACTIVITY_ORPHANED': return '部分工具只有开始、尚无结束记录';
    case 'ACTIVITY_EVENT_GAP': return '活动序列存在缺失或乱序';
    case 'ACTIVITY_WATERMARK_MISSING': return '缺少运行终态水位';
    case 'ACTIVITY_RETENTION_GAP': return '部分活动已按保留策略清理';
    case 'ACTIVITY_QUERY_LIMIT_REACHED': return '活动数量达到服务端单次查询上限';
    case 'ACTIVITY_PROJECTION_FAILED': return '部分工具结果无法安全展示';
    case 'ACTIVITY_DELIVERY_FAILED': return '部分活动投递失败';
    default: return code ?? null;
  }
}

const GIT_NOISE_FLAGS = new Set(['--no-pager', '--literal-pathspecs', '--no-optional-locks']);

/**
 * Design 2026-09-30 §5.4.3: compacted command text for row headers and the
 * run-status headline only. The expanded body, clipboard, title and
 * aria-label keep the full command. `git -c a=b -c c=d <cmd>` loses the
 * instrumentation noise and normalizes the executable word to `git`.
 */
export function headerCommandText(activity: {
  kind?: string | null;
  detail?: string | null;
  commandPreview?: string | null;
  redactionState?: string | null;
}): string | null {
  if (activity.redactionState === 'WITHHELD') return null;
  const raw = activity.commandPreview?.trim();
  if (!raw) return null;
  const looksGit = activity.kind === 'GIT' || /^git(?:\.exe)?\s/i.test(raw);
  if (!looksGit) return raw;
  const parts = raw.split(/\s+/);
  let index = /^git(?:\.exe)?$/i.test(parts[0] ?? '') ? 1 : 0;
  const kept: string[] = ['git'];
  while (index < parts.length) {
    const part = parts[index] as string;
    if (part === '-c') {
      index += 2; // drop `-c key=value`
      continue;
    }
    if (part.startsWith('-c') && part.length > 2) {
      index += 1; // `-ckey=value` packed form
      continue;
    }
    if (GIT_NOISE_FLAGS.has(part)) {
      index += 1;
      continue;
    }
    kept.push(part);
    index += 1;
  }
  return kept.join(' ');
}

/**
 * Folds the ordered activity list into display groups: consecutive finished
 * items of the same kind collapse into one summary row regardless of kind;
 * anything attention-worthy (failure, running, approval-waiting, redacted
 * commands) always stays individually visible.
 */
export interface ActivityDisplayGroup {
  key: string;
  kind: 'SINGLE' | 'BATCH';
  kindLabel: string;
  icon: 'search' | 'file' | 'terminal' | 'code' | 'list' | 'chat';
  items: RunActivity[];
  collapsedByDefault: boolean;
}

export function groupActivities(activities: RunActivity[]): ActivityDisplayGroup[] {
  const groups: ActivityDisplayGroup[] = [];
  let buffer: RunActivity[] = [];
  let bufferKind: string | null = null;

  const flush = (): void => {
    if (buffer.length === 0) return;
    const kind = bufferKind ?? 'OTHER';
    // Any run of 2+ consecutive plain successes of the same kind folds,
    // whatever the kind (analysis, reads, searches, builds...). Commands
    // with visible previews stay single via isAttentionWorthy only when
    // they carry non-success status; plain-success commands fold too.
    const batchable = buffer.length > 1
      && buffer.every((item) => !isAttentionWorthy(item));
    const firstActivity = buffer[0];
    if (!firstActivity) return;
    groups.push({
      key: `group-${firstActivity.activityId}-${buffer.length}`,
      kind: batchable ? 'BATCH' : 'SINGLE',
      kindLabel: activityKindLabel(kind),
      icon: activityKindIcon(kind),
      items: [...buffer],
      collapsedByDefault: batchable
    });
    buffer = [];
    bufferKind = null;
  };

  for (const activity of activities) {
    if (activity.kind === 'FINALIZE' || activity.kind === 'MODEL') continue;
    // Child delegation rows are the user's progress view. Keep every child
    // visible even when several succeeded consecutively; collapsing them
    // erased the per-subtask status that the old transcript displayed.
    if (activity.kind === 'DELEGATION') {
      flush();
      groups.push({
        key: `single-${activity.activityId}`,
        kind: 'SINGLE',
        kindLabel: activityKindLabel(activity.kind),
        icon: activityKindIcon(activity.kind),
        items: [activity],
        collapsedByDefault: false
      });
      continue;
    }
    const batchable = !isAttentionWorthy(activity);
    if (batchable && (bufferKind === activity.kind || buffer.length === 0)) {
      if (buffer.length === 0) bufferKind = activity.kind;
      buffer.push(activity);
      // Bound the buffer so one huge batch still renders bounded rows.
      if (buffer.length >= 8) flush();
      continue;
    }
    flush();
    if (batchable) {
      bufferKind = activity.kind;
      buffer.push(activity);
    } else {
      groups.push({
        key: `single-${activity.activityId}`,
        kind: 'SINGLE',
        kindLabel: activityKindLabel(activity.kind),
        icon: activityKindIcon(activity.kind),
        items: [activity],
        collapsedByDefault: false
      });
    }
  }
  flush();
  return groups;
}
