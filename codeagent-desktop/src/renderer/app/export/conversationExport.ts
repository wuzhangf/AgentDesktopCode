import type { DesktopApi, MessageContentPageResponse, SessionHistoryMessageResponse, SessionMessagePageResponse } from '../../../../electron/shared/api-types';

export type HistoryChannel = 'paginated' | 'legacy';

export interface SessionExportSource {
  sessionId: string;
  sessionVersion?: number;
  title?: string | null;
  workspaceAlias?: string | null;
  activeRunId?: string | null;
  messages?: Array<{
    id: string;
    role: string;
    content?: string | null;
    contentState?: 'INLINE' | 'DEFERRED';
    status?: string | null;
    runId?: string | null;
    contentRevision?: string;
    attachments?: Array<{ id?: string | null; name?: string | null; mediaType?: string | null; sizeBytes?: number | null; sha256?: string | null }> | null;
  }>;
}

export type ExportFormat = 'markdown' | 'txt' | 'json' | 'csv' | 'html' | 'pdf';
export type ExportActivities = 'NONE' | 'SUMMARY';

export interface ExportOptions {
  format: ExportFormat;
  activities: ExportActivities;
  includeSessionMetadata: boolean;
  includeTimestamps: boolean;
  redactRecognizedSecrets: boolean;
}

export interface ExportAttachment {
  id: string | null;
  name: string;
  mediaType: string | null;
  sizeBytes: number | null;
  sha256: string | null;
}

export interface ExportMessage {
  id: string;
  sequence: number;
  role: 'user' | 'assistant';
  status: string | null;
  createdAt: string | null;
  runId: string | null;
  content: string;
  contentRevision: string | null;
  attachments: ExportAttachment[];
}

export interface ExportRunSummary {
  runId: string;
  state: string;
  taskId: string | null;
  messageIds: string[];
}

export interface ExportDocument {
  schemaVersion: 'conversation-export/1';
  exportedAt: string;
  snapshot: {
    capturedAt: string;
    transcriptRevision: string | null;
    consistency: 'VERIFIED_STABLE' | 'UNVERIFIED';
    activeRunAtCapture: boolean;
  };
  session: { id: string; title?: string; workspaceAlias?: string };
  options: ExportOptions;
  completeness: {
    messages: 'COMPLETE' | 'UNVERIFIED';
    activities: 'COMPLETE' | 'UNVERIFIED' | 'NOT_REQUESTED';
    attachmentMetadata: 'COMPLETE' | 'UNVERIFIED';
    attachmentBytes: 'NOT_REQUESTED';
    reasons: string[];
  };
  transformations: { redactionApplied: boolean; redactionCount: number };
  messages: ExportMessage[];
  activities: ExportRunSummary[];
}

export interface ExportProgress {
  phase: 'messages' | 'content' | 'format';
  completed: number;
  total: number;
}

function desktopApi(): DesktopApi {
  return (globalThis as unknown as { codeAgentDesktop: DesktopApi }).codeAgentDesktop;
}

function unwrapResult<T>(value: T | { error?: string }): T {
  if (value && typeof value === 'object' && 'error' in value && typeof value.error === 'string') throw new Error(value.error);
  return value as T;
}

function asExportMessage(item: SessionHistoryMessageResponse | NonNullable<SessionExportSource['messages']>[number], content: string, sequence: number): ExportMessage | null {
  const role = item.role.toLowerCase();
  if (role !== 'user' && role !== 'assistant') return null;
  const raw = item as { createdAt?: number | string | null };
  return {
    id: item.id,
    sequence,
    role,
    status: item.status ?? null,
    createdAt: typeof raw.createdAt === 'number' ? new Date(raw.createdAt).toISOString() : raw.createdAt ?? null,
    runId: item.runId ?? null,
    content,
    contentRevision: item.contentRevision ?? null,
    attachments: (item.attachments ?? []).map((attachment) => ({
      id: attachment.id ?? null,
      name: attachment.name ?? '未命名附件',
      mediaType: attachment.mediaType ?? null,
      sizeBytes: attachment.sizeBytes ?? null,
      sha256: attachment.sha256 ?? null
    }))
  };
}

/** Read the entire history chain independently from the virtualized UI list. */
export async function collectExportMessages(
  sessionId: string,
  channel: HistoryChannel,
  session: SessionExportSource,
  onProgress?: (progress: ExportProgress) => void
): Promise<{ messages: ExportMessage[]; transcriptRevision: string | null; verified: boolean }> {
  if (channel === 'legacy') {
    const source = session.messages ?? [];
    const result: ExportMessage[] = [];
    for (let i = 0; i < source.length; i += 1) {
      const item = source[i];
      if (!item) continue;
      const content = item.contentState === 'DEFERRED'
        ? await readDeferredContent(sessionId, item.id)
        : item.content ?? '';
      const mapped = asExportMessage(item, content, result.length);
      if (mapped) result.push(mapped);
      onProgress?.({ phase: 'content', completed: i + 1, total: source.length });
    }
    return { messages: result, transcriptRevision: null, verified: false };
  }

  const pages: SessionMessagePageResponse[] = [];
  let cursor: string | undefined;
  let transcriptRevision: string | null = null;
  let hasOlder = true;
  let guard = 0;
  const seenCursors = new Set<string>();
  while (hasOlder) {
    guard += 1;
    if (guard > 10_000) throw new Error('EXPORT_LIMIT_EXCEEDED');
    const page = unwrapResult(await desktopApi().pageSessionMessages(sessionId, { limit: 100, cursor })) as SessionMessagePageResponse;
    if (transcriptRevision !== null && transcriptRevision !== page.transcriptRevision) throw new Error('EXPORT_SOURCE_CHANGED');
    transcriptRevision = page.transcriptRevision;
    pages.push(page);
    hasOlder = page.hasOlder && Boolean(page.beforeCursor);
    cursor = page.beforeCursor ?? undefined;
    if (cursor !== undefined) {
      if (seenCursors.has(cursor)) throw new Error('EXPORT_SOURCE_CHANGED');
      seenCursors.add(cursor);
    }
    onProgress?.({ phase: 'messages', completed: pages.reduce((n, p) => n + p.items.length, 0), total: 0 });
  }

  const source = pages.reverse().flatMap((page) => page.items);
  const result: ExportMessage[] = [];
  for (let i = 0; i < source.length; i += 1) {
    const item = source[i];
    if (!item) continue;
    const content = item.contentState === 'DEFERRED'
      ? await readDeferredContent(sessionId, item.id)
      : item.content ?? '';
    const mapped = asExportMessage(item, content, result.length);
    if (mapped) result.push(mapped);
    onProgress?.({ phase: 'content', completed: i + 1, total: source.length });
  }
  let verified = pages.every((page) => page.rangeComplete);
  if (transcriptRevision !== null) {
    const latest = unwrapResult(await desktopApi().getSessionMetadata(sessionId)) as { transcriptRevision?: string | null };
    if (latest.transcriptRevision !== transcriptRevision) throw new Error('EXPORT_SOURCE_CHANGED');
    verified = verified && typeof latest.transcriptRevision === 'string';
  }
  return { messages: result, transcriptRevision, verified };
}

async function readDeferredContent(sessionId: string, messageId: string): Promise<string> {
  let page = unwrapResult(await desktopApi().getMessageContentPage(sessionId, messageId, { maxBytes: 256 * 1024 })) as MessageContentPageResponse;
  const revision = page.contentRevision;
  let text = page.text;
  let guard = 0;
  while (page.nextCursor !== null) {
    guard += 1;
    if (guard > 512 || new TextEncoder().encode(text).byteLength > 32 * 1024 * 1024) throw new Error('EXPORT_LIMIT_EXCEEDED');
    page = unwrapResult(await desktopApi().getMessageContentPage(sessionId, messageId, { cursor: page.nextCursor, maxBytes: 256 * 1024 })) as MessageContentPageResponse;
    if (page.contentRevision !== revision) throw new Error('EXPORT_SOURCE_CHANGED');
    text += page.text;
    if (new TextEncoder().encode(text).byteLength > 32 * 1024 * 1024) throw new Error('EXPORT_LIMIT_EXCEEDED');
  }
  return text;
}

function redactText(value: string): { text: string; count: number } {
  let count = 0;
  const text = value.replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi, (_match, prefix: string) => {
    count += 1;
    return `${prefix}[REDACTED]`;
  }).replace(/((?:api[_-]?key|token|secret|password)\s*[:=]\s*)([^\s,;]{8,})/gi, (_match, prefix: string) => {
    count += 1;
    return `${prefix}[REDACTED]`;
  });
  return { text, count };
}

export function buildExportDocument(session: SessionExportSource, messages: ExportMessage[], options: ExportOptions, meta: { transcriptRevision: string | null; verified: boolean; capturedAt: string; runs?: ExportRunSummary[] }): ExportDocument {
  let redactionCount = 0;
  const transformed = messages.map((message) => {
    if (!options.redactRecognizedSecrets) return message;
    const redacted = redactText(message.content);
    redactionCount += redacted.count;
    return { ...message, content: redacted.text };
  });
  const expectedRunIds = new Set(messages.map((message) => message.runId).filter((id): id is string => Boolean(id)));
  const availableRunIds = new Set((meta.runs ?? []).map((run) => run.runId));
  const activitiesComplete = options.activities === 'NONE'
    || [...expectedRunIds].every((runId) => availableRunIds.has(runId));
  return {
    schemaVersion: 'conversation-export/1',
    exportedAt: new Date().toISOString(),
    snapshot: {
      capturedAt: meta.capturedAt,
      transcriptRevision: meta.transcriptRevision,
      consistency: meta.verified ? 'VERIFIED_STABLE' : 'UNVERIFIED',
      activeRunAtCapture: Boolean(session.activeRunId)
    },
    session: {
      id: session.sessionId,
      ...(options.includeSessionMetadata && session.title ? { title: session.title } : {}),
      ...(options.includeSessionMetadata && session.workspaceAlias ? { workspaceAlias: session.workspaceAlias } : {})
    },
    options,
    completeness: {
      messages: meta.verified ? 'COMPLETE' : 'UNVERIFIED',
      activities: options.activities === 'NONE' ? 'NOT_REQUESTED' : (activitiesComplete ? 'COMPLETE' : 'UNVERIFIED'),
      attachmentMetadata: 'COMPLETE',
      attachmentBytes: 'NOT_REQUESTED',
      reasons: [
        ...(meta.verified ? [] : ['LEGACY_OR_SOURCE_REVISION_UNVERIFIED']),
        ...(options.activities !== 'NONE' && !activitiesComplete ? ['RUN_SUMMARY_UNAVAILABLE'] : [])
      ]
    },
    transformations: { redactionApplied: options.redactRecognizedSecrets, redactionCount },
    messages: transformed,
    activities: options.activities === 'NONE' ? [] : (meta.runs ?? [])
  };
}

function displayTime(value: string | null): string {
  return value ? new Date(value).toLocaleString() : '时间未知';
}

function attachmentText(message: ExportMessage): string {
  if (message.attachments.length === 0) return '';
  return `\n\n附件清单：${message.attachments.map((a) => `${a.name} (${a.mediaType ?? '未知类型'}, ${a.sizeBytes ?? '?'} bytes)`).join('；')}`;
}

export function serializeMarkdown(doc: ExportDocument): string {
  const title = doc.session.title ?? '未命名会话';
  const lines = [`# ${title}`, '', `- 会话 ID：${doc.session.id}`, `- 导出时间：${displayTime(doc.exportedAt)}`, `- 快照时间：${displayTime(doc.snapshot.capturedAt)}`, `- 消息完整性：${doc.completeness.messages}`, ''];
  for (const message of doc.messages) {
    lines.push(`## ${message.role === 'user' ? '用户' : '助手'}${doc.options.includeTimestamps ? ` · ${displayTime(message.createdAt)}` : ''}`);
    lines.push('', message.content || '（空消息）', attachmentText(message), '');
  }
  if (doc.activities.length > 0) {
    lines.push('## 执行过程摘要', '');
    for (const run of doc.activities) lines.push(`- run ${run.runId} · ${run.state}${run.taskId ? ` · task ${run.taskId}` : ''}`);
    lines.push('');
  }
  return lines.join('\n').replace(/\n{4,}/g, '\n\n');
}

export function serializeText(doc: ExportDocument): string {
  return serializeMarkdown(doc).replace(/^#{1,6}\s*/gm, '').replace(/^- /gm, '');
}

export function serializeJson(doc: ExportDocument): string {
  return `${JSON.stringify(doc, null, 2)}\n`;
}

function csvCell(value: string | number | null): string {
  let text = value == null ? '' : String(value);
  if (/^\s*[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

export function serializeCsv(doc: ExportDocument): string {
  const header = ['record_type', 'session_id', 'message_id', 'run_id', 'sequence', 'role', 'status', 'created_at', 'content', 'attachments_json', 'completeness'];
  const rows = [header.map(csvCell).join(',')];
  for (const message of doc.messages) rows.push([
    'message', doc.session.id, message.id, message.runId, message.sequence, message.role, message.status, message.createdAt,
    message.content, JSON.stringify(message.attachments), doc.completeness.messages
  ].map(csvCell).join(','));
  for (const run of doc.activities) rows.push([
    'activity', doc.session.id, run.messageIds[0] ?? null, run.runId, null, 'activity', run.state, null,
    `task ${run.taskId ?? 'unknown'} · ${run.state}`, '', doc.completeness.activities
  ].map(csvCell).join(','));
  return `\uFEFF${rows.join('\r\n')}\r\n`;
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export function serializeHtml(doc: ExportDocument): string {
  const title = escapeHtml(doc.session.title ?? '未命名会话');
  const body = doc.messages.map((message) => `<article class="message"><h2>${message.role === 'user' ? '用户' : '助手'}${doc.options.includeTimestamps ? ` <small>${escapeHtml(displayTime(message.createdAt))}</small>` : ''}</h2><pre>${escapeHtml(message.content || '（空消息）')}</pre>${message.attachments.length ? `<p class="attachments">附件清单：${escapeHtml(message.attachments.map((a) => a.name).join('；'))}</p>` : ''}</article>`).join('\n');
  const activityBody = doc.activities.length > 0 ? `<section class="activities"><h2>执行过程摘要</h2>${doc.activities.map((run) => `<p>run ${escapeHtml(run.runId)} · ${escapeHtml(run.state)} · task ${escapeHtml(run.taskId ?? 'unknown')}</p>`).join('')}</section>` : '';
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${title}</title><style>body{font:14px/1.6 system-ui,sans-serif;color:#202124;max-width:900px;margin:32px auto;padding:0 24px}.meta{color:#666;border-bottom:1px solid #ddd;padding-bottom:12px}.message{break-inside:auto;border-bottom:1px solid #eee;padding:14px 0}.message h2{font-size:15px;margin:0 0 8px;color:#5b4acb}.message small{font-size:11px;color:#777;font-weight:400}.message pre{white-space:pre-wrap;overflow-wrap:anywhere;font:13px/1.6 ui-monospace,monospace;background:#f6f7f9;padding:12px;border-radius:6px}.attachments{color:#666;font-size:12px}.activities{border-top:2px solid #ddd;margin-top:18px;padding-top:8px}</style></head><body><h1>${title}</h1><div class="meta">会话 ID：${escapeHtml(doc.session.id)} · 快照时间：${escapeHtml(displayTime(doc.snapshot.capturedAt))} · 消息完整性：${doc.completeness.messages}</div>${body}${activityBody}</body></html>`;
}

export function serialize(doc: ExportDocument): string {
  switch (doc.options.format) {
    case 'markdown': return serializeMarkdown(doc);
    case 'txt': return serializeText(doc);
    case 'json': return serializeJson(doc);
    case 'csv': return serializeCsv(doc);
    case 'html':
    case 'pdf': return serializeHtml(doc);
  }
}

export function exportExtension(format: ExportFormat): string {
  return format === 'markdown' ? 'md' : format;
}

export function exportMime(format: ExportFormat): string {
  return format === 'markdown' ? 'text/markdown;charset=utf-8' : format === 'txt' ? 'text/plain;charset=utf-8' : format === 'json' ? 'application/json;charset=utf-8' : format === 'csv' ? 'text/csv;charset=utf-8' : format === 'html' ? 'text/html;charset=utf-8' : 'text/html;charset=utf-8';
}
