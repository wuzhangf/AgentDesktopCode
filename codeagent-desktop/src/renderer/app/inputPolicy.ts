/**
 * 长输入与文本附件设计 §5.1/§5.3 的渲染器侧输入政策。
 * 与后端 `InputPolicy` 同规则：code points 按 Unicode code point 计数
 * （不是 JS `length`，不是 grapheme cluster）；UTF-8 字节用 TextEncoder；
 * 行数按规范化 LF 计数。服务是权威规范化者，这里只做发送前预检。
 *
 * R0 门禁仍是旧 4000/200（UTF-16 units，见 capability 回退）；
 * R1 数值只在 capability 明确发布 `input-policy/1` 且 limits 为 32000 时启用。
 */

export const INPUT_POLICY_VERSION = 'input-policy/1';
export const TITLE_MAX_CODE_POINTS = 200;
export const AUTO_TITLE_MAX_CODE_POINTS = 80;
export const MESSAGE_MAX_CODE_POINTS_R1 = 32000;
export const MESSAGE_MAX_UTF8_BYTES_R1 = 128 * 1024;
export const MESSAGE_MAX_CHARS_R0 = 4000;
export const TITLE_MAX_CHARS_R0 = 200;
export const ATTACHMENT_MAX_COUNT = 4;
export const ATTACHMENT_MAX_BYTES = 256 * 1024;
export const ATTACHMENT_TOTAL_MAX_BYTES = 512 * 1024;
export const REQUEST_MAX_UTF8_BYTES = 1024 * 1024;
export const COLLAPSE_ABOVE_CODE_POINTS = 10000;
export const COLLAPSE_ABOVE_LINES = 80;
export const SUPPORTED_ATTACHMENT_MEDIA_TYPES = ['text/plain', 'text/markdown'] as const;

/** code points 计数（与后端 InputPolicy.codePointCount 一致；不是 JS length，不是 grapheme）。 */
export function codePoints(text: string): number {
  if (!text) return 0;
  return Array.from(text).length;
}

export function utf8Bytes(text: string): number {
  if (!text) return 0;
  return new TextEncoder().encode(text).length;
}

export function lineCount(normalizedLfText: string): number {
  if (!normalizedLfText) return 0;
  let newlines = 0;
  for (let i = 0; i < normalizedLfText.length; i += 1) {
    if (normalizedLfText.charAt(i) === '\n') newlines += 1;
  }
  return newlines + 1;
}

/** 正文规范化：仅去除开头一个 BOM、CRLF/CR → LF；不删除首尾空格。 */
export function normalizeBody(content: string): string {
  let out = content;
  if (out.charAt(0) === '﻿') out = out.slice(1);
  if (out.includes('\r')) out = out.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  return out;
}

/** 自动标题派生：空白合并后截取最多 80 code points；只截标题不截正文。 */
export function autoTitle(body: string): string | null {
  const collapsed = body.replace(/\s+/g, ' ').trim();
  if (!collapsed) return null;
  let points = 0;
  let end = 0;
  for (const char of collapsed) {
    if (points >= AUTO_TITLE_MAX_CODE_POINTS) break;
    points += 1;
    end += char.length;
  }
  return collapsed.slice(0, end);
}

/** 长输入折叠：仅 UI 显示策略，不是拒绝阈值。 */
export function shouldCollapsePreview(normalized: string): boolean {
  return codePoints(normalized) > COLLAPSE_ABOVE_CODE_POINTS || lineCount(normalized) > COLLAPSE_ABOVE_LINES;
}

export interface TextInputLimits {
  policyVersion: string;
  titleMax: number;
  messageMax: number;
  messageMaxUnit: 'characters' | 'unicode_code_points';
  attachmentMaxCount: number;
  attachmentMaxBytes: number;
  attachmentTotalMaxBytes: number;
  supportedAttachmentMediaTypes: string[];
  /** R1 长正文/资料通道是否可用（capability 明确发布 input-policy/1 且 messageMax 为 32000）。 */
  r1Available: boolean;
}

interface OperationLimitsLike {
  inputPolicyVersion?: unknown;
  titleMaxCodePoints?: unknown;
  messageMaxCodePoints?: unknown;
  messageMaxUtf8Bytes?: unknown;
  attachmentMaxCount?: unknown;
  attachmentMaxBytes?: unknown;
  attachmentTotalMaxBytes?: unknown;
  supportedAttachmentMediaTypes?: unknown;
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * 从 capability 的 session.message.send.text limits 解析输入政策。
 * 缺少 R1 能力时回退为旧 4000/200 保守提示（设计 §5.3），不假定无限。
 */
export function resolveTextInputLimits(operationLimits: OperationLimitsLike | undefined | null): TextInputLimits {
  const version = typeof operationLimits?.inputPolicyVersion === 'string'
    ? operationLimits.inputPolicyVersion
    : '';
  const messageMax = asNumber(operationLimits?.messageMaxCodePoints);
  const titleMax = asNumber(operationLimits?.titleMaxCodePoints);
  const attachmentMaxCount = asNumber(operationLimits?.attachmentMaxCount);
  const attachmentMaxBytes = asNumber(operationLimits?.attachmentMaxBytes);
  const attachmentTotalMax = asNumber(operationLimits?.attachmentTotalMaxBytes);
  const mediaTypes = Array.isArray(operationLimits?.supportedAttachmentMediaTypes)
    ? (operationLimits.supportedAttachmentMediaTypes as unknown[]).filter(
      (entry): entry is string => typeof entry === 'string')
    : [];
  const r1Available = version === INPUT_POLICY_VERSION && messageMax === MESSAGE_MAX_CODE_POINTS_R1;
  return {
    policyVersion: version || 'legacy',
    titleMax: titleMax ?? TITLE_MAX_CHARS_R0,
    messageMax: messageMax ?? MESSAGE_MAX_CHARS_R0,
    messageMaxUnit: r1Available ? 'unicode_code_points' : 'characters',
    attachmentMaxCount: attachmentMaxCount ?? ATTACHMENT_MAX_COUNT,
    attachmentMaxBytes: attachmentMaxBytes ?? ATTACHMENT_MAX_BYTES,
    attachmentTotalMaxBytes: attachmentTotalMax ?? ATTACHMENT_TOTAL_MAX_BYTES,
    supportedAttachmentMediaTypes: mediaTypes.length > 0
      ? mediaTypes
      : [...SUPPORTED_ATTACHMENT_MEDIA_TYPES],
    r1Available
  };
}

export interface BodyCheck {
  ok: boolean;
  normalized: string;
  points: number;
  bytes: number;
  lines: number;
  collapsed: boolean;
  message?: string;
}

/** 发送前正文预检：R0 按 4000 字符（trim 后长度），R1 按 code points/字节双规则。 */
export function checkBodyWithinLimits(content: string, limits: TextInputLimits): BodyCheck {
  const normalized = normalizeBody(content);
  const points = codePoints(normalized);
  const bytes = utf8Bytes(normalized);
  const lines = lineCount(normalized);
  if (!normalized.trim()) {
    return { ok: false, normalized, points, bytes, lines, collapsed: false, message: '请输入任务内容。' };
  }
  if (limits.r1Available) {
    if (points > MESSAGE_MAX_CODE_POINTS_R1) {
      return {
        ok: false, normalized, points, bytes, lines, collapsed: shouldCollapsePreview(normalized),
        message: `正文超出输入上限（${points}/${MESSAGE_MAX_CODE_POINTS_R1} code points），草稿已保留，请缩短后重试。`
      };
    }
    if (bytes > MESSAGE_MAX_UTF8_BYTES_R1) {
      return {
        ok: false, normalized, points, bytes, lines, collapsed: shouldCollapsePreview(normalized),
        message: `正文超出输入上限（${bytes}/${MESSAGE_MAX_UTF8_BYTES_R1} UTF-8 字节），草稿已保留，请缩短后重试。`
      };
    }
    return { ok: true, normalized, points, bytes, lines, collapsed: shouldCollapsePreview(normalized) };
  }
  if (normalized.trim().length > MESSAGE_MAX_CHARS_R0) {
    return {
      ok: false, normalized, points, bytes, lines, collapsed: shouldCollapsePreview(normalized),
      message: `正文超出输入上限（${normalized.trim().length}/${MESSAGE_MAX_CHARS_R0} 字符），草稿已保留，请缩短后重试。`
    };
  }
  return { ok: true, normalized, points, bytes, lines, collapsed: shouldCollapsePreview(normalized) };
}

/** 服务端结构化输入错误的渲染器侧解释（设计 §7：服务只给字段错误，草稿提示由客户端生成）。 */
export function describeInputProblem(error: unknown): string | null {
  const message = error instanceof Error ? error.message : String(error ?? '');
  if (!message) return null;
  const code = (error as { code?: unknown })?.code;
  const raw = typeof code === 'string' ? code : message;
  if (/INPUT_LIMIT_EXCEEDED/.test(raw) || /INPUT_LIMIT_EXCEEDED/.test(message)) {
    const field = /field['"]?\s*[:=]\s*['"]?(\w+)/i.exec(message)?.[1]
      ?? (/title/i.test(message) ? 'title' : /content|goal|history/i.exec(message)?.[0] ?? 'content');
    const limit = /limit['"]?\s*[:=]\s*['"]?(\d+)/i.exec(message)?.[1]
      ?? /exceeds?\s+(\d+)/i.exec(message)?.[1];
    const fieldLabel = field === 'title' ? '标题' : field === 'goal' ? '任务目标' : field === 'history' ? '历史' : '正文';
    return limit
      ? `${fieldLabel}超出输入上限（上限 ${limit}），草稿已保留，请缩短后重试。`
      : `${fieldLabel}超出输入上限，草稿已保留，请缩短后重试。`;
  }
  if (/ATTACHMENT_INVALID_ENCODING/.test(raw) || /ATTACHMENT_INVALID_ENCODING/.test(message)) {
    return '附件不是合法 UTF-8 文本，已拒绝本次发送（草稿已保留）。请转存为 UTF-8 文本后重试。';
  }
  if (/ATTACHMENT_CHANNEL_UNAVAILABLE/.test(raw) || /ATTACHMENT_CHANNEL_UNAVAILABLE/.test(message)) {
    return '图片/PDF 附件暂无模型输入通道，服务端已拒绝本次发送（不会静默丢弃附件）。请移除该附件或改用文本附件。';
  }
  if (/ATTACHMENT_LIMIT_EXCEEDED/.test(raw) || /ATTACHMENT_LIMIT_EXCEEDED/.test(message)) {
    return `附件超出上限（最多 ${ATTACHMENT_MAX_COUNT} 个、单个 ≤${ATTACHMENT_MAX_BYTES / 1024} KiB、合计 ≤${ATTACHMENT_TOTAL_MAX_BYTES / 1024} KiB），草稿已保留，请调整后重试。`;
  }
  if (/ATTACHMENT_TYPE_FORBIDDEN/.test(raw) || /ATTACHMENT_TYPE_FORBIDDEN/.test(message)) {
    return '附件类型不在白名单内（仅支持 text/plain、text/markdown），已拒绝本次发送。';
  }
  if (/IDEMPOTENCY_PAYLOAD_MISMATCH/.test(raw) || /IDEMPOTENCY_PAYLOAD_MISMATCH/.test(message)) {
    return '同一消息 ID 已用于不同输入（正文/附件/顺序有变化），服务端拒绝覆盖。请更换消息后重试。';
  }
  if (/SCHEDULING_OUTCOME_UNKNOWN/.test(raw) || /SCHEDULING_OUTCOME_UNKNOWN/.test(message)) {
    return '消息已保存，但调度结果未知（未自动重建任务）。请在会话中核对任务/运行后决定是否重试。';
  }
  if (/REQUEST_BODY_TOO_LARGE|Request body exceeds 1 MiB|payload exceeds size limit/.test(message)) {
    return '请求体超过 1 MiB 上限，已拒绝发送（草稿已保留）。请缩短正文或减少附件后重试。';
  }
  return null;
}
