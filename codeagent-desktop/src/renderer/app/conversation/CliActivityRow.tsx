import { useContext, useState } from 'react';
import { QueryClientContext } from '@tanstack/react-query';
import type { RunActivity } from '../activity/activityTypes';
import {
  DesktopProxyError,
  useRunDiffFiles,
  useSessionExecution,
  useSessionExecutionArtifact
} from '../queries';
import { DiffPatchView, patchStats } from '../EvidencePanels';
import {
  activityKindIcon,
  activityKindIconName,
  activityKindLabel,
  activityStatusGlyph,
  activityStatusIconName,
  headerCommandText,
  isFailedStatus,
  redactionBadge
} from '../activity/activityPresentation';
import { Icon } from '../Icon';

function parseTime(value?: string | null): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function formatCliElapsed(millis: number | null | undefined): string | null {
  if (millis === null || millis === undefined || !Number.isFinite(millis) || millis < 0) return null;
  const seconds = Math.floor(millis / 1000);
  return `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`;
}

export function formatCliBytes(bytes: number | null | undefined): string | null {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return null;
  if (bytes < 1000) return `${Math.round(bytes)} B`;
  if (bytes < 1_000_000) return `${(bytes / 1000).toFixed(1).replace(/\.0$/, '')} KB`;
  return `${(bytes / 1_000_000).toFixed(1).replace(/\.0$/, '')} MB`;
}

function safeLine(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 ? value : null;
}

function basename(ref: string): string {
  const parts = ref.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? ref;
}

/** Join a known absolute workspace root with a project-relative ref for
 * display (hover tooltip). The ref stays a safe relative value; the root
 * comes from the session's default workspace directory, never from the
 * activity payload. */
function absoluteRefDisplay(root: string | null | undefined, ref: string): string | null {
  if (!root) return null;
  const trimmed = root.trim().replace(/[\\/]+$/, '');
  if (!trimmed || trimmed.length > 1024 || /[\u0000-\u001f\u007f]/.test(trimmed)) return null;
  // Fail closed: the tooltip only claims an absolute path when the root
  // actually is one (drive letter, UNC share or POSIX root).
  if (!/^(?:[a-zA-Z]:[\\/]|\\\\|\/)/.test(trimmed)) return null;
  const separator = trimmed.includes('\\') ? '\\' : '/';
  const relative = ref.split(/[\\/]/).filter(Boolean).join(separator);
  return relative ? `${trimmed}${separator}${relative}` : null;
}

export function formatCliClock(value?: string | null): string | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return null;
  const parts = new Intl.DateTimeFormat(undefined, {
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
  }).formatToParts(parsed);
  const values = new Map(parts.map((part) => [part.type, part.value]));
  const hour = values.get('hour') === '24' ? '00' : values.get('hour');
  const minute = values.get('minute');
  const second = values.get('second');
  return hour && minute && second ? `${hour}:${minute}:${second}` : null;
}

function compactPath(value: string, max = 64): string {
  if (value.length <= max) return value;
  const separator = value.includes('\\') ? '\\' : '/';
  const parts = value.split(separator).filter(Boolean);
  if (parts.length < 3) return `…${value.slice(-(max - 1))}`;
  const tail = parts.slice(-2).join(separator);
  const head = parts[0] ?? '';
  return `${head}${separator}…${separator}${tail}`;
}

/* ── Structured result-summary rendering ────────────────────────────────
 * `resultSummary` is a bounded flat string of `key value` stats plus an
 * optional trailing item list (`hits|files|items ref…`): search hits carry
 * `file:line`, lookup/list entries carry refs (directories suffixed `/`)
 * and the projector appends a `+N` overflow marker when the list was cut.
 */

const SUMMARY_LIST_LABELS = new Set(['hits', 'files', 'items']);
const SUMMARY_TWO_WORD_LABELS = new Set(['matched files']);

const SUMMARY_STAT_LABEL_ZH: Record<string, string> = {
  'matched files': '命中文件', matches: '匹配', scanned: '扫描',
  entries: '条目', files: '文件', directories: '目录', read: '读取',
  lines: '行', bytes: '字节', succeeded: '成功', partial: '部分',
  failed: '失败', exitCode: '退出码', exit: '退出码',
  ms: '毫秒', durationMillis: '毫秒', count: '数量',
  totalObserved: '观测总数', errors: '错误', warnings: '警告',
  info: '提示', truncated: '已截断', timedOut: '超时',
  cancelled: '已取消', applied: '已应用', rejected: '已拒绝',
  deleted: '已删除', changed: '已变更', state: '状态',
  stdoutBytes: 'stdout', stderrBytes: 'stderr',
  stdoutLines: 'stdout 行', stderrLines: 'stderr 行',
  stdoutTruncated: 'stdout 截断', stderrTruncated: 'stderr 截断',
  committedBytes: '提交字节', contentHash: '内容哈希',
  beforeVersion: '前版本', afterVersion: '后版本',
  writeOperationId: '写操作', expectedLength: '预期长度',
  chunkIndex: '块序号', chunkBytes: '块字节',
  acceptedBytes: '接受字节', receivedBytes: '接收字节',
  expectedNextChunk: '下一块', tailTruncated: '尾部截断',
  record: '记录', status: '状态', operation: '操作',
  alreadyAbsent: '本就缺失', filesTruncated: '文件截断',
  http: 'HTTP', chars: '字符', url: '地址',
  provider: '提供商', results: '结果', filtered: '已过滤'
};

const SUMMARY_ITEMS_LABEL_ZH: Record<string, string> = {
  hits: '命中位置', files: '命中文件', items: '条目'
};

/** Stats whose only fact is "how many" — a FILE_LIST row folds them into
 * the list label (`目录 N 个：`) instead of a separate 输出摘要 line. */
const SUMMARY_COUNT_KEYS = new Set(['entries', 'files', 'directories', 'count']);

/** Unit-valued keys render `value unit` (672 毫秒); a trailing bare unit
 * token (`read 40 lines`) folds onto the previous stat (读取 40 行). */
const SUMMARY_UNIT_KEYS = new Set(['ms', 'durationMillis', 'bytes', 'lines']);
const SUMMARY_TRAILING_UNITS = new Set(['lines', 'bytes', 'files', 'entries', 'directories', 'matches']);

interface ResultSummaryItem {
  /** Display text exactly as emitted (`ref`, `dir/`, `file:line`). */
  text: string;
  /** safeRelativeRef-cleaned link target, when publishable. */
  ref: string | null;
  line: number | null;
  /** `dir/` marker — directories are not openable file previews. */
  directory: boolean;
}

interface ParsedResultSummary {
  stats: Array<[string, string]>;
  itemsLabel: string | null;
  items: ResultSummaryItem[];
  overflow: number;
}

function isSummaryScalar(token: string): boolean {
  return /^\d/.test(token) || /^[+-]\d/.test(token) || /^(true|false)$/i.test(token);
}

function parseSummaryItem(token: string): ResultSummaryItem {
  let text = token;
  const directory = text.endsWith('/');
  if (directory) text = text.slice(0, -1); // directory marker
  let line: number | null = null;
  const lineMatch = /^(.*):(\d+)$/.exec(text);
  const refPart = lineMatch?.[1];
  const linePart = lineMatch?.[2];
  const hasLine = refPart != null && refPart.length > 0 && linePart != null;
  const refText = hasLine ? refPart : text;
  if (hasLine) line = Number.parseInt(linePart, 10);
  const ref = directory || refText.startsWith('<') ? null : safeRelativeRef(refText);
  return { text: token, ref, line, directory };
}

function parseResultSummary(text: string): ParsedResultSummary | null {
  const tokens = text.split(/\s+/).filter((token) => token.length > 0);
  if (tokens.length === 0) return null;
  const stats: Array<[string, string]> = [];
  let itemsLabel: string | null = null;
  const items: ResultSummaryItem[] = [];
  let overflow = 0;
  let i = 0;
  while (i < tokens.length) {
    const current = tokens[i];
    if (current === undefined) break;
    const next = tokens[i + 1];
    const two = i + 2 < tokens.length && next !== undefined ? `${current} ${next}` : null;
    const label = two !== null && SUMMARY_TWO_WORD_LABELS.has(two) ? two : current;
    const valueIndex = i + (label === two ? 2 : 1);
    const value = tokens[valueIndex];
    if (SUMMARY_LIST_LABELS.has(label) && value !== undefined && !isSummaryScalar(value)) {
      itemsLabel = label;
      i = valueIndex;
      break;
    }
    stats.push([label, value ?? '']);
    i = valueIndex + 1;
  }
  for (; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === undefined) continue;
    const overflowMatch = /^\+(\d+)$/.exec(token);
    const overflowAmount = overflowMatch?.[1];
    if (overflowAmount !== undefined) {
      overflow += Number.parseInt(overflowAmount, 10);
      continue;
    }
    items.push(parseSummaryItem(token));
  }
  return { stats, itemsLabel, items, overflow };
}

/** Translated stat segments of a parsed resultSummary — `值 单位` /
 * `标签 值` pieces, joined by ` · ` downstream. */
function summaryStatParts(parsed: ParsedResultSummary): string[] {
  const statParts: string[] = [];
  for (const [key, value] of parsed.stats) {
    const zh = SUMMARY_STAT_LABEL_ZH[key] ?? key;
    if (value === '') {
      const prev = statParts.length - 1;
      if (prev >= 0 && SUMMARY_TRAILING_UNITS.has(key)) {
        statParts[prev] = `${statParts[prev]} ${zh}`;
      } else {
        statParts.push(zh);
      }
    } else {
      statParts.push(SUMMARY_UNIT_KEYS.has(key) ? `${value} ${zh}` : `${zh} ${value}`);
    }
  }
  return statParts;
}

/** One-line inline form of a structured resultSummary: translated stats
 * plus any trailing item tokens as plain text — command summaries carry
 * stream counters, never openable refs. Falls back to the raw text. */
function summaryLineText(summary: string): string {
  const parsed = parseResultSummary(summary);
  if (!parsed) return summary;
  const parts = summaryStatParts(parsed);
  const tail = parsed.items.map((item) => item.text).join(' ');
  if (tail) parts.push(tail);
  if (parsed.overflow > 0) parts.push(`+${parsed.overflow}`);
  return parts.length > 0 ? parts.join(' · ') : summary;
}

/**
 * Shell-style prompt for the command line: the working directory renders as
 * a bounded two-segment tail like `repo\module>`, resolved against the
 * session workspace root when the activity only carries `.`. The full host
 * path never reaches the DOM; a missing or unusable value falls back to the
 * classic `$`.
 */
/** Last-two-segment tail of a host path — the only cwd fragment the DOM
 * shows; drive letters/scheme prefixes never reach the rendered text. */
function hostPathTail(raw: string): string | null {
  const separator = raw.includes('\\') ? '\\' : '/';
  const tail = raw.split(/[\\/]+/)
    .filter((segment) => segment !== '' && segment !== '.' && segment !== '..'
      && !/^[a-zA-Z][a-zA-Z0-9+.-]*:$/.test(segment))
    .slice(-2);
  return tail.length > 0 ? tail.join(separator) : null;
}

function commandPrompt(workspaceRoot: string | null | undefined, activity: RunActivity): string {
  const raw = activity.workingDirectory?.trim();
  const isDot = raw === '.' || raw === './' || raw === '.\\';
  const hasText = raw !== undefined && raw !== ''
    && ![...raw].some((ch) => { const code = ch.charCodeAt(0); return code < 32 || code === 127; });
  const full = isDot
    ? workspaceRoot?.trim() || null
    : hasText
      ? absoluteRefDisplay(workspaceRoot, safeRelativeRef(raw) ?? '') ?? raw
      : null;
  if (full && ![...full].some((ch) => { const code = ch.charCodeAt(0); return code < 32 || code === 127; })) {
    const tail = hostPathTail(full);
    if (tail !== null) return `${tail}>`;
  }
  return isDot ? '.>' : '$';
}

/**
 * Activity target refs are service-owned workspace-relative references. Keep
 * the renderer fail-closed as well: an invalid ref must not become a link,
 * title, or DOM text that leaks a host path.
 */
function safeRelativeRef(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const ref = value.trim();
  if (!ref || ref.length > 1024 || /[\u0000-\u001f\u007f]/.test(ref)) return null;
  if (/^(?:[a-zA-Z]:[\\/]|[\\/]{1,2}|file:|https?:)/i.test(ref)) return null;
  if (ref.split(/[\\/]/).some((part) => part === '.' || part === '..')) return null;
  return ref;
}

export interface FileReadPresentation {
  /** The exact service-owned ref to use for opening/copying, if safe. */
  fileRef: string | null;
  fileName: string | null;
  targetCount: number;
}

/**
 * Prefer additive file-read facts, then the existing typed target ref. The
 * target fallback keeps older activity contracts useful: targets[].ref is
 * already defined as a project-relative reference by the protocol.
 */
export function fileReadPresentation(activity: RunActivity): FileReadPresentation | null {
  if (activity.kind !== 'FILE_READ') return null;
  const explicitRef = safeRelativeRef(activity.fileRef);
  const targetRefs = (activity.targets ?? [])
    .map((target) => safeRelativeRef(target.ref))
    .filter((ref): ref is string => ref !== null);
  const fileRef = explicitRef ?? targetRefs[0] ?? null;
  const explicitName = activity.fileName?.trim();
  const fileName = explicitName
    ? basename(explicitName)
    : fileRef ? basename(fileRef) : null;
  return {
    fileRef,
    fileName,
    targetCount: targetRefs.length
  };
}

function statusLabel(status: string): string {
  switch (status) {
    case 'RUNNING': return '执行中';
    case 'SUCCEEDED': return '已完成';
    case 'PARTIAL': return '部分完成';
    case 'FAILED': return '失败';
    case 'TIMED_OUT': return '超时';
    case 'ABORTED': return '已中止';
    case 'REJECTED': return '已拒绝';
    case 'CANCELLED': return '已取消';
    case 'WAITING_APPROVAL': return '等待批准';
    case 'UNKNOWN': return '状态未知';
    default: return status.replaceAll('_', ' ').toLowerCase();
  }
}

function activityElapsed(activity: RunActivity, nowMs: number, observedStartedAt?: number | null): number | null {
  const startedAt = parseTime(activity.startedAt) ?? observedStartedAt ?? null;
  const finishedAt = parseTime(activity.finishedAt);
  // RUNNING items carry durationMillis=0 from the start event; the live
  // clock is authoritative until a completion lands.
  if (activity.status !== 'RUNNING'
      && typeof activity.durationMillis === 'number' && Number.isFinite(activity.durationMillis) && activity.durationMillis >= 0) {
    return activity.durationMillis;
  }
  if (startedAt === null) return null;
  return Math.max(0, (finishedAt ?? nowMs) - startedAt);
}

function rowText(activity: RunActivity): string {
  const label = activityKindLabel(activity.kind);
  const file = fileReadPresentation(activity);
  if (file) return `${label}${file.fileName ? ` · ${file.fileName}` : ''}`;
  if (activity.kind === 'COMMAND' || activity.kind === 'BUILD' || activity.kind === 'GIT') {
    const action = activity.redactionState !== 'WITHHELD' && activity.detail && activity.detail !== activity.commandPreview
      ? ` ▪ ${activity.detail}` : '';
    const head = `${label}${action}`;
    if (activity.redactionState !== 'WITHHELD' && activity.commandPreview) return `${head} · ${activity.commandPreview}`;
    return head;
  }
  return activity.detail ? `${label} · ${activity.detail}` : label;
}

/** Short label for a record-relative artifact path (stdout/stderr/…). */
function artifactLabel(path: string): string {
  const name = basename(path);
  if (name.endsWith('.stdout.log')) return 'stdout';
  if (name.endsWith('.stderr.log')) return 'stderr';
  if (name.endsWith('.stdin.log')) return 'stdin';
  if (name.endsWith('.result.json')) return 'result';
  return name;
}

/**
 * One auto-loaded stream slice inside the command transcript block (design
 * 2026-09-26 WU-1). Expanding the row is the user intent that authorizes the
 * bounded read — the slice re-requests a bigger bounded window through
 * 加载更多, never an unbounded one. A stream that comes back empty stays
 * quiet so a routine 0-byte stderr adds no noise; failures keep the
 * session-scoped error wording used by the chips section.
 */
function CommandArtifactSlice(props: {
  sessionId: string;
  executionId: string;
  path: string;
  failed: boolean;
}): React.JSX.Element | null {
  const [maxBytes, setMaxBytes] = useState(65536);
  const query = useSessionExecutionArtifact(
    props.sessionId, props.executionId, props.path, { maxBytes });
  const errorCode = query.error && typeof query.error === 'object' && 'code' in query.error
    ? String((query.error as { code?: unknown }).code) : null;
  const data = query.data;
  const isStderr = props.path.endsWith('.stderr.log');
  if (query.isPending) {
    return <pre className="cli-command-output cli-command-pending">加载日志…</pre>;
  }
  if (query.isError) {
    return (
      <span className="cli-detail-warning">
        {errorCode === 'ARTIFACT_EXPIRED'
          ? '日志已过期，证据产物已被清理'
          : `日志不可用${errorCode ? `（${errorCode}）` : ''}`}
      </span>
    );
  }
  if (!data || data.content.length === 0) return null;
  return (
    <>
      {isStderr ? <span className="cli-detail-line">stderr：</span> : null}
      <pre
        className={`cli-command-output${props.failed || isStderr ? ' is-error' : ''}`}
        data-artifact-path={data.path}
      >{data.content}</pre>
      {data.hasMore || data.totalBytes > data.content.length ? (
        <span className="cli-detail-line">
          已显示 {data.content.length} / {data.totalBytes} bytes
          {data.hasMore && maxBytes < 1048576 ? (
            <button
              type="button"
              className="cli-file-link cli-evidence-more"
              onClick={() => setMaxBytes((value) => Math.min(1048576, value * 4))}
            >加载更多</button>
          ) : null}
          {data.hasMore && maxBytes >= 1048576 ? ' · 超出单条日志上限（1MB）' : ''}
        </span>
      ) : null}
    </>
  );
}

/**
 * On-demand execution-evidence log viewer (design 2026-09-26 WU-1). The
 * activity event carries only identifiers and record-relative artifact
 * paths — the bounded UTF-8 slice is fetched through the session-scoped
 * artifact endpoint only when the user selects an artifact, and larger
 * views re-request a bigger bounded slice (never unbounded reads).
 */
function EvidenceLogSection(props: {
  sessionId?: string | null;
  executionId: string;
  artifacts: string[];
}): React.JSX.Element {
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [maxBytes, setMaxBytes] = useState(65536);
  const query = useSessionExecutionArtifact(
    props.sessionId ?? null, props.executionId, selectedPath,
    { enabled: selectedPath !== null, maxBytes });
  const errorCode = query.error && typeof query.error === 'object' && 'code' in query.error
    ? String((query.error as { code?: unknown }).code) : null;
  const data = selectedPath ? query.data : undefined;
  return (
    <div className="cli-evidence-log" data-execution-id={props.executionId}>
      <div className="cli-evidence-chips">
        <span className="cli-detail-line">执行日志：</span>
        {props.artifacts.slice(0, 16).map((path) => (
          <button
            key={path}
            type="button"
            className={`cli-evidence-chip${selectedPath === path ? ' is-active' : ''}`}
            title={path}
            onClick={() => {
              if (selectedPath === path) {
                setSelectedPath(null);
              } else {
                setMaxBytes(65536);
                setSelectedPath(path);
              }
            }}
          >{artifactLabel(path)}</button>
        ))}
      </div>
      {selectedPath ? (
        props.sessionId == null ? (
          <span className="cli-detail-warning">当前会话无法定位执行日志（缺少会话标识）</span>
        ) : query.isPending ? (
          <pre className="cli-command-output cli-command-pending">加载日志…</pre>
        ) : query.isError ? (
          <span className="cli-detail-warning">
            {errorCode === 'ARTIFACT_EXPIRED'
              ? '日志已过期，证据产物已被清理'
              : `日志不可用${errorCode ? `（${errorCode}）` : ''}`}
          </span>
        ) : data ? (
          <>
            <pre className="cli-command-output" data-artifact-path={data.path}>{data.content}</pre>
            {data.hasMore || data.totalBytes > data.content.length ? (
              <span className="cli-detail-line">
                已显示 {data.content.length} / {data.totalBytes} bytes
                {data.hasMore && maxBytes < 1048576 ? (
                  <button
                    type="button"
                    className="cli-file-link cli-evidence-more"
                    onClick={() => setMaxBytes((value) => Math.min(1048576, value * 4))}
                  >加载更多</button>
                ) : null}
                {data.hasMore && maxBytes >= 1048576 ? ' · 超出单条日志上限（1MB）' : ''}
              </span>
            ) : null}
          </>
        ) : null
      ) : null}
    </div>
  );
}

interface CommandRecordView {
  id: string;
  argvText: string | null;
  metaText: string | null;
  cwdTail: string | null;
}

/** Flat view of one persisted execution-command/1 record. */
function commandRecordView(record: { [key: string]: unknown }): CommandRecordView | null {
  if (record === null || typeof record !== 'object') return null;
  const id = typeof record.commandId === 'string' && record.commandId.length > 0
    ? record.commandId : 'cmd';
  const argv = Array.isArray(record.argv)
    ? record.argv.filter((item): item is string => typeof item === 'string' && item.length > 0)
    : [];
  const argvText = argv.length > 0 ? argv.join(' ') : null;
  const state = typeof record.state === 'string' ? record.state : null;
  const exitCode = typeof record.exitCode === 'number' && Number.isFinite(record.exitCode)
    ? Math.trunc(record.exitCode) : null;
  const started = typeof record.startedAt === 'number' ? record.startedAt : null;
  const finished = typeof record.finishedAt === 'number' ? record.finishedAt : null;
  const elapsed = started !== null && finished !== null && finished >= started
    ? formatCliElapsed(finished - started) : null;
  const meta = [
    state,
    exitCode !== null ? `退出码 ${exitCode}` : null,
    record.timedOut === true ? '已超时' : null,
    record.cancelled === true ? '已取消' : null,
    elapsed
  ].filter((value): value is string => typeof value === 'string' && value.length > 0).join(' · ');
  const cwdTail = typeof record.workingDirectory === 'string'
    ? hostPathTail(record.workingDirectory.trim()) : null;
  return { id, argvText, metaText: meta.length > 0 ? meta : null, cwdTail };
}

/** Deduped 原因/错误码 text for the command outcome segment: upstream often
 * reports the same value in both fields — one ` · ` part, not two lines. */
function commandOutcomeText(activity: RunActivity): string | null {
  const reason = typeof activity.reasonCode === 'string' && activity.reasonCode.trim()
    ? activity.reasonCode.trim() : null;
  const code = activity.failure && typeof activity.failure.code === 'string'
    && activity.failure.code.trim() ? activity.failure.code.trim() : null;
  if (reason !== null && code !== null) {
    return reason === code ? `错误码 ${code}` : `原因 ${reason} · 错误码 ${code}`;
  }
  if (reason !== null) return `原因 ${reason}`;
  return code !== null ? `错误码 ${code}` : null;
}

/**
 * Journaled per-command facts (design 2026-09-26 §10.2): the authoritative
 * argv, working-directory tail and outcome of every recorded command — where
 * the bounded activity preview only carries a template. Fetched lazily; the
 * section mounts inside the expanded details so the record read only happens
 * on user intent. Each command renders as ONE ` · `-joined line
 * (argv · state · 退出码 · elapsed · cwd); the activity-level result facts
 * (summary stats, deduped reason/error code) fold onto the line of the
 * command the result names instead of repeating as separate detail lines.
 */
function ExecutionRecordSection(props: {
  sessionId?: string | null;
  executionId: string;
  /** Record the activity result names (activity.commandId); the shared
   * outcome segments append to its line — the last command when unnamed. */
  focusCommandId?: string | null;
  /** Inline resultSummary stats; null when the log block already prints it. */
  summaryText?: string | null;
  /** Deduped 原因/错误码 text for the result line. */
  outcomeText?: string | null;
  /** Activity-level `执行结果` line shown when the record supplies no
   * command facts — keeps the outcome visible instead of a silent gap. */
  fallbackLine?: string | null;
}): React.JSX.Element | null {
  const query = useSessionExecution(props.sessionId ?? null, props.executionId);
  const errorCode = query.error && typeof query.error === 'object' && 'code' in query.error
    ? String((query.error as { code?: unknown }).code) : null;
  if (query.isPending) {
    return <span className="cli-detail-line">执行命令：加载中…</span>;
  }
  if (query.isError) {
    return (
      <>
        <span className="cli-detail-warning">
          {errorCode === 'EXECUTION_NOT_FOUND'
            ? '执行记录已不存在（可能已被清理）'
            : `执行记录不可用${errorCode ? `（${errorCode}）` : ''}`}
        </span>
        {props.fallbackLine ? <span className="cli-detail-line">执行结果：{props.fallbackLine}</span> : null}
      </>
    );
  }
  const commands = (query.data?.commandRecords ?? [])
    .map(commandRecordView)
    .filter((view): view is CommandRecordView => view !== null);
  const plannedDetail = query.data?.transitions?.find((transition) => transition.state === 'PLANNED')?.detail;
  type ExecutionBuildPlan = { planSource?: string; runner?: string; command?: string[]; workingDirectory?: string; planFingerprint?: string };
  let plan: ExecutionBuildPlan | null = null;
  if (plannedDetail?.startsWith('{')) {
    try {
      const parsed: unknown = JSON.parse(plannedDetail);
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const candidate = parsed as ExecutionBuildPlan;
        if (typeof candidate.planSource === 'string') plan = candidate;
      }
    } catch { /* Older records have a recipe id instead of JSON. */ }
  }
  const provenance = plan ? [plan.planSource, plan.runner, plan.planFingerprint?.slice(0, 12)].filter(Boolean).join(' · ') : null;
  if (commands.length === 0) {
    return <>
      {provenance ? <span className="cli-detail-line">构建方案：{provenance}</span> : null}
      {Array.isArray(plan?.command) && plan.command.every((arg) => typeof arg === 'string')
        ? <span className="cli-detail-line">未执行命令：<code>{plan.command.map((arg) => /\s/.test(arg) ? JSON.stringify(arg) : arg).join(' ')}</code></span> : null}
      {props.fallbackLine ? <span className="cli-detail-line">执行结果：{props.fallbackLine}</span> : null}
    </>;
  }
  const matchedIndex = props.focusCommandId
    ? commands.findIndex((command) => command.id === props.focusCommandId) : -1;
  // The outcome belongs to the command the result names; an unnamed result
  // lands on the last journaled command (a sequential run's final step).
  const focusIndex = matchedIndex >= 0 ? matchedIndex : commands.length - 1;
  return (
    <div className="cli-evidence-log" data-execution-id={props.executionId}>
      {provenance ? <span className="cli-detail-line">构建方案：{provenance}</span> : null}
      {commands.length > 1 ? <span className="cli-detail-line">执行命令：</span> : null}
      <ul className="cli-target-list cli-record-list">
        {commands.slice(0, 8).map((command, index) => {
          const parts = [
            command.argvText !== null ? command.id : null,
            command.metaText,
            command.cwdTail,
            index === focusIndex ? props.summaryText ?? null : null,
            index === focusIndex ? props.outcomeText ?? null : null
          ].filter((part): part is string => typeof part === 'string' && part.length > 0);
          return (
            <li key={command.id}>
              {commands.length === 1 ? <span className="cli-detail-line">执行命令：</span> : null}
              <code title={command.argvText ?? undefined}>
                {command.argvText ?? command.id}
              </code>
              {parts.length > 0 ? <span className="cli-detail-line">{parts.join(' · ')}</span> : null}
            </li>
          );
        })}
        {commands.length > 8 ? <li className="cli-detail-line">…还有 {commands.length - 8} 条命令</li> : null}
      </ul>
    </div>
  );
}

/**
 * Structured `resultSummary` for non-command rows: stats on one line
 * (known keys translated, unknown keys pass through verbatim) followed by
 * a wrapped item list whose safe refs open the file — `file:line` hits
 * land on the exact line. The full raw summary stays on the title attr.
 */
function ResultSummaryDetails(props: {
  summary: string;
  workspaceRoot?: string | null;
  runId?: string;
  /** FILE_LIST rows fold a count-only stats line into the list label
   * (`目录 N 个：`) — `输出摘要：条目 N` plus `条目：` would repeat the
   * row below it. */
  directoryList?: boolean;
  onOpenFile?: (fileRef: string, startLine?: number | null, runId?: string) => void;
}): React.JSX.Element {
  const parsed = parseResultSummary(props.summary);
  if (!parsed) {
    return <span className="cli-detail-line">输出摘要：{props.summary}</span>;
  }
  const statParts = summaryStatParts(parsed);
  const shown = parsed.items.slice(0, 12);
  const hiddenCount = parsed.items.length - shown.length + parsed.overflow;
  let itemsTitle = parsed.itemsLabel
    ? SUMMARY_ITEMS_LABEL_ZH[parsed.itemsLabel] ?? parsed.itemsLabel
    : null;
  const countStatsOnly = props.directoryList === true
    && parsed.stats.every(([key]) => SUMMARY_COUNT_KEYS.has(key));
  if (props.directoryList === true) {
    itemsTitle = '目录';
    if (countStatsOnly) {
      const numericCounts = parsed.stats
        .map(([, value]) => Number(value))
        .filter((value) => Number.isFinite(value));
      const stated = parsed.stats
        .map(([key, value]) => (key === 'entries' || key === 'count' ? Number(value) : NaN))
        .find((value) => Number.isFinite(value))
        ?? (numericCounts.length > 0 ? numericCounts.reduce((sum, value) => sum + value, 0) : null);
      const total = stated ?? parsed.items.length + parsed.overflow;
      const allDirs = parsed.items.every((item) => item.directory);
      const allFiles = parsed.items.length > 0 && parsed.items.every((item) => !item.directory);
      const noun = parsed.overflow > 0 ? '条目' : allDirs ? '目录' : allFiles ? '文件' : '条目';
      itemsTitle = `${noun} ${total} 个`;
    }
  }
  return (
    <>
      <span className="cli-detail-line" title={props.summary}>
        {countStatsOnly
          ? `${itemsTitle}${shown.length > 0 ? '：' : ''}`
          : `输出摘要：${statParts.length > 0 ? statParts.join(' · ') : props.summary}`}
      </span>
      {shown.length > 0 ? (
        <>
          {!countStatsOnly && itemsTitle ? <span className="cli-detail-line">{itemsTitle}：</span> : null}
          <ul className="cli-target-list cli-result-list">
            {shown.map((item) => (
              <li key={item.text}>
                <span className="cli-target-status" aria-hidden="true">·</span>
                {item.ref && props.onOpenFile ? (
                  <button
                    type="button"
                    className="cli-file-link cli-target-link"
                    title={`打开 ${absoluteRefDisplay(props.workspaceRoot, item.ref) ?? item.ref}${item.line !== null ? `:${item.line}` : ''}`}
                    onClick={() => props.onOpenFile?.(item.ref as string, item.line, props.runId)}
                  >{item.text}</button>
                ) : (
                  <code title={item.ref ? absoluteRefDisplay(props.workspaceRoot, item.ref) ?? item.ref : item.text}>{item.text}</code>
                )}
              </li>
            ))}
            {hiddenCount > 0 ? <li className="cli-detail-line">…还有 {hiddenCount} 条</li> : null}
          </ul>
        </>
      ) : null}
    </>
  );
}

/**
 * Expanded 变更内容 section for write-kind rows (workspace_edit /
 * workspace_write / delete). The activity payload carries only refs — the
 * honest content source is the run-level change artifact: we page the run
 * diff until the row's own file entries show, then render the unified
 * patch with the shared per-line coloring. The patch is the file's
 * cumulative run delta (start → end), labeled as such; a file edited by
 * several steps shows the same net patch on each of them. Mid-run the
 * service returns CHANGE_ARTIFACT_NOT_RECORDED and the section degrades
 * to a quiet note instead of fabricating content.
 */
function FileWriteChangeSection(props: {
  runId: string | null;
  /** Owning run reached a terminal state; null = unknown — the query
   * decides and a missing change artifact still reads as a pending note. */
  runTerminal: boolean | null;
  paths: string[];
}): React.JSX.Element | null {
  // CliActivityRow also renders outside a QueryClientProvider in unit tests —
  // degrade to nothing there; the app shell always provides one.
  const queryClient = useContext(QueryClientContext);
  if (!queryClient) return null;
  return <FileWriteChangeSectionInner {...props} />;
}

function FileWriteChangeSectionInner(props: {
  runId: string | null;
  runTerminal: boolean | null;
  paths: string[];
}): React.JSX.Element | null {
  const apiAvailable = typeof window !== 'undefined'
    && typeof window.codeAgentDesktop?.getRunDiff === 'function';
  const searching = props.runId !== null && props.runTerminal !== false
    && props.paths.length > 0 && apiAvailable;
  const diff = useRunDiffFiles(searching ? props.runId : null, props.paths, searching);
  const errorCode = diff.error instanceof DesktopProxyError ? diff.error.code : null;
  return (
    <div className="cli-write-diff" data-testid="write-diff">
      {props.paths.length === 0 ? (
        <span className="cli-detail-line">变更内容：未提供可信文件路径，无法定位 diff。</span>
      ) : null}
      {props.paths.length > 0 && props.runTerminal === false ? (
        <span className="cli-detail-line">变更内容：运行仍在进行，diff 工件将在终态后发布；文件名链接可查看最新内容。</span>
      ) : null}
      {props.paths.length > 0 && props.runTerminal !== false && props.runId === null ? (
        <span className="cli-detail-line">变更内容：缺少运行标识，无法定位 diff。</span>
      ) : null}
      {props.paths.length > 0 && props.runTerminal !== false && props.runId !== null && !apiAvailable ? (
        <span className="cli-detail-line">变更内容：当前服务不支持 diff 查询，请到 Git 变更页查看。</span>
      ) : null}
      {searching && diff.isPending ? (
        <span className="cli-detail-line">变更内容加载中…</span>
      ) : null}
      {searching && diff.isError ? (
        <span className="cli-detail-warning" data-testid="write-diff-error">
          {errorCode === 'CHANGE_ARTIFACT_NOT_RECORDED'
            ? '变更内容：运行尚未发布 diff 工件，终态后可查看。'
            : `变更内容不可用${errorCode ? `（${errorCode}）` : ''}`}
        </span>
      ) : null}
      {searching && diff.data ? (
        <>
          {diff.data.files.map((file) => {
            const stats = patchStats(file.patch);
            return (
              <div key={file.path} className="cli-write-diff-file">
                <div className="cli-write-diff-head">
                  <code title={file.path}>{file.path}</code>
                  <span className="cli-write-diff-stats">
                    <span className="git-stat-add">+{stats.additions}</span>
                    <span className="git-stat-delete">-{stats.deletions}</span>
                  </span>
                  {file.changeType && file.changeType !== 'MODIFIED' ? (
                    <span className="badge">{file.changeType}</span>
                  ) : null}
                  {file.binary ? <span className="badge">二进制</span> : null}
                  {file.truncated ? <span className="badge stale">patch 截断</span> : null}
                </div>
                {file.binary ? (
                  <span className="cli-detail-line">二进制文件不显示 patch 内容。</span>
                ) : file.patch ? (
                  <DiffPatchView patch={file.patch} />
                ) : (
                  <span className="cli-detail-line">该文件无文本 diff（变更可能仅为元数据或内容未变）。</span>
                )}
              </div>
            );
          })}
          {diff.data.missingPaths.map((path) => (
            <span key={path} className="cli-detail-line" data-testid="write-diff-missing">
              变更 diff 中未记录 <code>{path}</code>
              {diff.data.scannedAll ? '（净内容未变，或该次修改未被归因收录）' : '（diff 分页较多，未完全扫描）'}
            </span>
          ))}
          {diff.data.stale ? (
            <span className="cli-detail-warning">变更快照已过期，工作区可能已移动。</span>
          ) : null}
          {diff.data.files.length > 0 ? (
            <span className="cli-detail-line cli-write-diff-note">diff 为该文件在本次运行中的累计变更（起始内容 → 结束内容）。</span>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

/** Design 2026-09-30 §5.4.4: copies the full command; "已复制" for 2s. */
function CopyCommandButton(props: { text: string }): React.JSX.Element {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="cli-command-copy"
      aria-label="复制命令"
      title={copied ? '已复制' : '复制命令'}
      onClick={() => {
        void navigator.clipboard.writeText(props.text).then(() => {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 2000);
        });
      }}
    >
      <Icon name={copied ? 'check' : 'code'} size={13} />
      <span>{copied ? '已复制' : '复制'}</span>
    </button>
  );
}

export function CliActivityRow(props: {
  activity: RunActivity;
  nowMs: number;
  observedStartedAt?: number | null;
  defaultOpen?: boolean;
  /** Round-block rows show a command/tool kind glyph (design 2026-09-19 §3.3). */
  kindGlyph?: string;
  /** Absolute path of the session's default workspace root; used only for
   * hover tooltips, never for opening files. */
  workspaceRoot?: string | null;
  /** Owning session id for session-scoped evidence-artifact reads; null on
   * hosts that predate the evidence contract. */
  sessionId?: string | null;
  /** Owning run id; activity payloads may omit runId, so the transcript
   * passes it down for the write-diff lookup. */
  runId?: string | null;
  /** Owning run reached a terminal state — the run-diff artifact only
   * exists after that; null/undefined = unknown. */
  runTerminal?: boolean | null;
  onOpenFile?: (fileRef: string, startLine?: number | null, runId?: string) => void;
}): React.JSX.Element {
  const { activity } = props;
  const [open, setOpen] = useState(Boolean(props.defaultOpen));
  const hasFile = activity.kind === 'FILE_READ';
  // Write family (workspace_edit / workspace_write / delete / apply): the
  // row gets an expandable 变更内容 section even when the service sent no
  // other body, so a bare edit is never a dead-end line.
  const writeActivity = /WRITE|EDIT|PATCH|DELETE|APPLY|CREATE/.test(activity.kind);
  const writePaths = writeActivity
    ? [...new Set(
        [activity.fileRef, ...(activity.targets ?? []).map((target) => target.ref)]
          .map((ref) => safeRelativeRef(ref))
          .filter((ref): ref is string => ref !== null)
      )]
    : [];
  const commandActivity = activity.kind === 'COMMAND' || activity.kind === 'BUILD' || activity.kind === 'GIT';
  // Lookup kinds return a *result set*, not a primary file: every target is
  // a matched entry and stays in the expanded result list instead of being
  // promoted to a file link beside the verb.
  const resultSetKind = activity.kind === 'FILE_LOOKUP' || activity.kind === 'FILE_LIST'
    || activity.kind === 'CODE_SEARCH' || activity.kind === 'JAVA_SEMANTIC';
  const safeDetail = commandActivity && activity.redactionState === 'WITHHELD' ? null : activity.detail;
  const running = activity.status === 'RUNNING';
  const partial = activity.status === 'PARTIAL';
  const failed = isFailedStatus(activity.status);
  const elapsedMs = activityElapsed(activity, props.nowMs, props.observedStartedAt);
  // Design 2026-09-30 §5.4.3: a finished step under one second does not
  // advertise an elapsed time; running steps keep the ticking mm:ss.
  const elapsed = running ? formatCliElapsed(elapsedMs)
    : elapsedMs !== null && elapsedMs >= 1000 ? formatCliElapsed(elapsedMs) : null;
  const elapsedTitle = formatCliElapsed(elapsedMs);
  const badge = redactionBadge(activity.redactionState);
  const file = fileReadPresentation(activity);
  // §6.3: the onOpenFile+safeRelativeRef chain extends to every kind —
  // the additive file fact first, then the first valid target ref.
  const fileRef = file?.fileRef
    ?? safeRelativeRef(activity.fileRef)
    ?? (resultSetKind ? null : (activity.targets ?? [])
        .map((target) => safeRelativeRef(target.ref))
        .find((ref): ref is string => ref !== null))
    ?? null;
  const missingFileReference = hasFile && !fileRef;
  const fileName = file?.fileName
    || (activity.fileName?.trim() ? basename(activity.fileName.trim()) : fileRef ? basename(fileRef) : null);
  const filePathHint = fileRef ? absoluteRefDisplay(props.workspaceRoot, fileRef) ?? compactPath(fileRef) : null;
  const firstTargetRef = safeRelativeRef(activity.targets?.[0]?.ref);
  const displayCommand = activity.commandPreview && activity.redactionState !== 'WITHHELD'
    ? activity.commandPreview : null;
  // A file size is deliberately not used as the read quantity. It describes
  // the file, not the bytes returned by this activity. Target refs fail
  // closed for every kind: an invalid ref never becomes a link, title or
  // DOM text (§6.3 / safeRelativeRef contract).
  const detailTargets = (activity.targets ?? [])
    .map((target) => ({ ...target, ref: safeRelativeRef(target.ref) }))
    .filter((target): target is { ref: string; status: string } => target.ref !== null && target.ref !== fileRef);
  // Result-set kinds (search/glob/list/semantic) carry *input* refs in
  // targets — the search scope directory, the listed path — never per-hit
  // outcomes. They are parameters, not results: they render as a labelled
  // 范围/目录 param instead of `?`-glyphed rows that read like "?src".
  const scopeTargets = resultSetKind
    ? detailTargets.filter((target) => target.status === 'REQUESTED')
    : [];
  const visibleTargets = resultSetKind
    ? detailTargets.filter((target) => target.status !== 'REQUESTED')
    : detailTargets;
  const scopeRef = scopeTargets[0]?.ref ?? null;
  const scopeLabel = activity.kind === 'FILE_LIST' ? '目录' : '范围';
  // The scope rides on the header line when the pattern/tool name is
  // already there; without them the first ref IS the scope and stays put.
  const scopeSuffix = scopeRef !== null && (safeDetail !== null || activity.toolName)
    ? `${scopeLabel} ${compactPath(scopeRef)}`
    : null;
  // FILE_LIST: the one listed directory already rides the header — as the
  // ` · 目录 X` suffix or as the bare target ref — so a `目录：X` detail
  // line repeats it verbatim. Multi-scope rows still need the joined line.
  const singleScopeInHeader = scopeTargets.length === 1
    && (scopeSuffix !== null || scopeRef === firstTargetRef);
  const targetTitleText = activity.redactionState === 'WITHHELD' ? null
    : [
        hasFile
          ? fileName ?? safeDetail ?? activity.toolName
          : commandActivity
            ? displayCommand ?? badge
            : safeDetail ?? activity.toolName ?? firstTargetRef,
        scopeRef !== null && scopeSuffix !== null ? `${scopeLabel} ${scopeRef}` : null
      ].filter((value): value is string => typeof value === 'string' && value.length > 0)
      .join(' · ');
  const evidenceArtifacts = (activity.evidenceArtifacts ?? [])
    .filter((path): path is string => typeof path === 'string' && path.length > 0);
  const evidenceAvailable = Boolean(activity.executionId) && evidenceArtifacts.length > 0;
  // Command rows with journaled evidence print the real stdout/stderr under
  // the prompt line so the block reads as the complete interaction; the
  // stats summary moves out of the terminal-style output. Reads stay
  // session-scoped and bounded; hosts without the artifact API (or no
  // session id) keep the legacy stats-as-output fallback. Each record may
  // hold several commands — auto-print is capped, the chips below cover the
  // rest plus stdin/result artifacts.
  const artifactApiAvailable = typeof window !== 'undefined'
    && typeof window.codeAgentDesktop?.readSessionExecutionArtifact === 'function';
  const recordApiAvailable = typeof window !== 'undefined'
    && typeof window.codeAgentDesktop?.getSessionExecution === 'function';
  const streamArtifacts = evidenceArtifacts
    .filter((path) => path.endsWith('.stdout.log') || path.endsWith('.stderr.log'))
    .slice(0, 4);
  const showEvidenceLog = commandActivity && evidenceAvailable
    && activity.redactionState !== 'WITHHELD'
    && typeof props.sessionId === 'string' && props.sessionId.length > 0
    && artifactApiAvailable;
  const hasBody = Boolean(activity.commandPreview && activity.redactionState !== 'WITHHELD')
    || Boolean(safeDetail) || Boolean(activity.resultSummary) || detailTargets.length > 0
    || Boolean(activity.failure) || activity.effectState === 'UNKNOWN' || hasFile
    || evidenceAvailable || writeActivity;
  const startLine = safeLine(activity.startLine);
  const endLine = safeLine(activity.endLine);
  const lineRange = startLine !== null
    ? endLine !== null && endLine >= startLine
      ? `第 ${startLine}–${endLine} 行`
      : `第 ${startLine} 行`
    : null;
  const readBytes = formatCliBytes(activity.bytesRead);
  const fileSize = formatCliBytes(activity.fileSizeBytes);
  // Design 2026-09-30 §5.4.3: the start clock moves out of the row meta into
  // the expanded first detail line ("开始 HH:MM:SS · 耗时 mm:ss"), and the
  // meta span exposes it as its tooltip.
  const startClock = formatCliClock(activity.startedAt);
  const timingLine = [
    startClock ? `开始 ${startClock}` : null,
    elapsedTitle ? `耗时 ${elapsedTitle}` : null
  ].filter(Boolean).join(' · ');
  // Command rows: the action word (COMPILE/TEST/…) rides on the verb as
  // `构建 ▪ COMPILE`; whatever output the service can safely publish folds
  // into the terminal-style log block under the prompt line.
  const commandAction = commandActivity && safeDetail && safeDetail !== displayCommand ? safeDetail : null;
  const commandLogText = commandActivity
    ? [activity.resultSummary, activity.failure?.safeMessage]
        .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
        .join('\n')
    : '';
  const promptPrefix = commandPrompt(props.workspaceRoot, activity);
  // Command rows fold the journaled record facts and the activity outcome
  // into ONE ` · `-joined line per command — argv · state · 退出码 · 耗时 ·
  // cwd · 输出摘要 · 原因/错误码 — instead of the record list, 输出摘要, 原因
  // and 错误码 each repeating the same facts on separate lines. The summary
  // stays off the line when the legacy log block already prints it as the
  // command output (no evidence artifacts available).
  const summaryInCommandLog = commandActivity && Boolean(activity.resultSummary)
    && (!showEvidenceLog || streamArtifacts.length === 0);
  const recordSummaryText = commandActivity && activity.resultSummary && !summaryInCommandLog
    ? summaryLineText(activity.resultSummary) : null;
  const commandOutcome = commandActivity ? commandOutcomeText(activity) : null;
  const commandFallbackLine = recordSummaryText !== null || commandOutcome !== null
    ? [statusLabel(activity.status), elapsed, recordSummaryText, commandOutcome]
        .filter((value): value is string => typeof value === 'string' && value.length > 0)
        .join(' · ')
    : null;
  const canReadRecord = commandActivity && recordApiAvailable
    && typeof activity.executionId === 'string' && activity.executionId.length > 0
    && typeof props.sessionId === 'string' && props.sessionId.length > 0;
  // Command rows: the file ref is a build/module directory, not an openable
  // file — a name chip beside the verb is redundant.
  const showFileChip = !commandActivity && Boolean(fileName);
  const fileReadState = hasFile
    ? running ? '读取中'
      : isFailedStatus(activity.status) ? '读取失败'
        : activity.status === 'PARTIAL' ? '部分读取'
          : activity.status === 'CANCELLED' ? '已取消' : null
    : null;
  const statusIcon = activityStatusIconName(activity.status);
  const headerCommand = commandActivity ? headerCommandText(activity) : null;
  return (
    <article className={`cli-activity-row status-${activity.status.toLowerCase()}${failed ? ' is-attention' : ''}${partial ? ' is-partial' : ''}${open && hasBody ? ' is-open' : ''}`} data-activity-id={activity.activityId}>
      <div className={`cli-activity-line${showFileChip ? ' has-file' : ''}`}>
        <button
          type="button"
          className="cli-activity-toggle"
          aria-expanded={hasBody ? open : undefined}
          aria-label={`${statusLabel(activity.status)}：${rowText(activity)}`}
          disabled={!hasBody}
          onClick={() => { if (hasBody) setOpen((value) => !value); }}
        >
          <span className={`cli-activity-glyph${running ? ' is-running' : ''}${activity.status === 'REJECTED' || activity.status === 'CANCELLED' ? ' is-muted' : ''}`} aria-hidden="true">
            {statusIcon
              ? <Icon name={statusIcon} size={14} className={statusIcon === 'loader' ? 'icon-loader' : undefined} />
              : <span className="cli-activity-status-dot" />}
          </span>
          {/* kindGlyph nests inside the verb cell: the toggle grid has three
              columns — a fourth grid child would wrap onto an implicit row
              under the 16px glyph column and clip to nothing. */}
          <span className="cli-activity-verb">
            <span className={`cli-activity-kind kind-${activityKindIcon(activity.kind)}`} aria-hidden="true">
              <Icon name={activityKindIconName(activity.kind)} size={14} />
              {props.kindGlyph ? <span className="sr-only">{props.kindGlyph}</span> : null}
            </span>
            {activityKindLabel(activity.kind)}
            {commandAction ? <span className="cli-activity-action"> ▪ {commandAction}</span> : null}
          </span>
          <span className="cli-activity-target" title={targetTitleText ?? undefined}>
            {hasFile
              ? (fileName ? '' : safeDetail ?? activity.toolName ?? '')
              : commandActivity
              ? headerCommand ?? (badge ?? '')
              : <>
                  {safeDetail ?? activity.toolName ?? (firstTargetRef ? compactPath(firstTargetRef) : '')}
                  {scopeSuffix !== null ? <span className="cli-activity-scope"> · {scopeSuffix}</span> : null}
                </>}
          </span>
        </button>
        {showFileChip ? <span className="cli-file-sep" aria-hidden="true">·</span> : null}
        {showFileChip && fileRef && props.onOpenFile ? (
          <button
            type="button"
            className="cli-file-link"
            title={filePathHint ? `打开 ${filePathHint}` : undefined}
            onClick={() => props.onOpenFile?.(fileRef, startLine, activity.runId)}
          >{fileName}</button>
        ) : showFileChip ? <span className="cli-file-name" title={filePathHint ?? undefined}>{fileName}</span> : null}
        <span className="cli-activity-meta" title={timingLine || undefined}>
          {activity.kind === 'DELEGATION' ? <span className="cli-subagent-status">{statusLabel(activity.status)}</span> : null}
          {activity.kind === 'DELEGATION' && activity.attempt ? <span>第 {activity.attempt} 次尝试</span> : null}
          {fileReadState ? <span>{fileReadState}</span> : null}
          {lineRange ? <span>{lineRange}</span> : null}
          {readBytes ? <span>{readBytes}</span> : null}
          {activity.truncated ? <span>已截断</span> : null}
          {activity.failure ? <span className="cli-inline-error">{activity.failure.safeMessage}</span> : null}
          {elapsed ? <span>{running ? '已运行 ' : ''}{elapsed}</span> : null}
        </span>
      </div>
      {open && hasBody ? (
        <div className="cli-activity-details">
          {timingLine ? <span className="cli-detail-line cli-detail-timing">{timingLine}</span> : null}
          {displayCommand || commandLogText || showEvidenceLog ? (
            <div className="cli-command-shell">
              {displayCommand ? (
                <div className="cli-command-head">
                  <code className="cli-command-preview">{promptPrefix} {displayCommand}</code>
                  <CopyCommandButton text={displayCommand} />
                </div>
              ) : null}
              {showEvidenceLog ? (
                streamArtifacts.length > 0 ? (
                  streamArtifacts.map((path) => (
                    <CommandArtifactSlice
                      key={path}
                      sessionId={props.sessionId as string}
                      executionId={activity.executionId as string}
                      path={path}
                      failed={failed}
                    />
                  ))
                ) : commandLogText ? (
                  <pre className={`cli-command-output${failed ? ' is-error' : ''}`}>{commandLogText}</pre>
                ) : running ? (
                  <pre className="cli-command-output cli-command-pending">等待命令返回输出…</pre>
                ) : null
              ) : commandLogText ? (
                <pre className={`cli-command-output${failed ? ' is-error' : ''}`}>{commandLogText}</pre>
              ) : running ? (
                <pre className="cli-command-output cli-command-pending">等待命令返回输出…</pre>
              ) : null}
            </div>
          ) : null}
          {commandActivity ? (
            canReadRecord ? (
              <ExecutionRecordSection
                sessionId={props.sessionId}
                executionId={activity.executionId as string}
                focusCommandId={activity.commandId}
                summaryText={recordSummaryText}
                outcomeText={commandOutcome}
                fallbackLine={commandFallbackLine}
              />
            ) : commandFallbackLine !== null ? (
              <span className="cli-detail-line">执行结果：{commandFallbackLine}</span>
            ) : null
          ) : null}
          {activity.redactionState === 'WITHHELD' ? <span className="cli-detail-warning">命令内容因安全策略隐藏</span> : null}
          {safeRelativeRef(activity.workingDirectory) ? <span className="cli-detail-line">工作目录：<code title={safeRelativeRef(activity.workingDirectory) ?? undefined}>{compactPath(safeRelativeRef(activity.workingDirectory) as string, 120)}</code></span> : null}
          {missingFileReference ? <span className="cli-detail-warning">未提供可信文件路径，无法定位文件</span> : null}
          {lineRange ? <span className="cli-detail-line">读取范围：{lineRange}</span> : null}
          {activity.bytesRead !== null && activity.bytesRead !== undefined ? <span className="cli-detail-line">本次读取：{activity.bytesRead} bytes{readBytes ? `（${readBytes}）` : ''}</span> : null}
          {activity.fileSizeBytes !== null && activity.fileSizeBytes !== undefined ? <span className="cli-detail-line">文件大小：{activity.fileSizeBytes} bytes{fileSize ? `（${fileSize}）` : ''}</span> : null}
          {scopeTargets.length > 0 && !(activity.kind === 'FILE_LIST' && singleScopeInHeader) ? (
            <span className="cli-detail-line" title={scopeTargets.map((target) => target.ref).join('\n')}>
              {scopeLabel}：{scopeTargets.map((target) => compactPath(target.ref, 120)).join('、')}
            </span>
          ) : null}
          {visibleTargets.length > 0 ? (
            <ul className="cli-target-list">
              {visibleTargets.slice(0, 20).map((target) => (
                <li key={`${target.ref}-${target.status}`}>
                  <span className="cli-target-status">{activityStatusGlyph(target.status)}</span>
                  {props.onOpenFile
                    ? <button type="button" className="cli-file-link cli-target-link" title={`打开 ${absoluteRefDisplay(props.workspaceRoot, target.ref) ?? compactPath(target.ref)}`} onClick={() => props.onOpenFile?.(target.ref, null, activity.runId)}>{compactPath(target.ref)}</button>
                    : <code title={absoluteRefDisplay(props.workspaceRoot, target.ref) ?? target.ref}>{compactPath(target.ref)}</code>}
                </li>
              ))}
              {visibleTargets.length > 20 ? <li className="cli-detail-line">…还有 {visibleTargets.length - 20} 个目标</li> : null}
            </ul>
          ) : null}
          {writeActivity ? (
            <FileWriteChangeSection
              runId={props.runId ?? activity.runId ?? null}
              runTerminal={props.runTerminal ?? null}
              paths={writePaths}
            />
          ) : null}
          {!commandActivity && activity.resultSummary ? (
            <ResultSummaryDetails
              summary={activity.resultSummary}
              workspaceRoot={props.workspaceRoot}
              runId={activity.runId}
              directoryList={activity.kind === 'FILE_LIST'}
              onOpenFile={props.onOpenFile}
            />
          ) : !commandActivity && activity.status === 'RUNNING' ? <span className="cli-detail-line">{activity.kind === 'MODEL' ? '等待模型响应' : '输出摘要：等待工具返回结果'}</span> : null}
          {!commandActivity && activity.reasonCode ? <span className="cli-detail-line">原因：{activity.reasonCode}</span> : null}
          {!commandActivity && activity.failure ? <span className="cli-detail-error">{activity.failure.safeMessage} · 错误码 {activity.failure.code}</span> : null}
          {activity.effectState === 'UNKNOWN' ? <span className="cli-detail-warning">效果未知；请先查看执行结果</span> : null}
          {evidenceAvailable ? (
            <EvidenceLogSection
              sessionId={props.sessionId}
              executionId={activity.executionId as string}
              artifacts={evidenceArtifacts}
            />
          ) : null}
        </div>
      ) : null}
    </article>
  );
}
