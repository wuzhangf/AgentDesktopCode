/** Only public tool facts, never inferred ACS rounds or private protocol payloads. */
export interface NativeActivityRow {
  id: string;
  label: string;
  detail?: string;
  state: 'running' | 'completed' | 'failed' | 'rejected' | 'unknown';
  occurredAt?: string;
  endedAt?: string;
}
export interface NativeActivityView {
  items: NativeActivityRow[];
  cursor: string;
  catchingUp: boolean;
  trimmed: boolean;
  expired: boolean;
}
export const emptyNativeActivity = (): NativeActivityView => ({items: [], cursor: '0', catchingUp: false, trimmed: false, expired: false});
const record = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
const str = (v: unknown) => typeof v === 'string' ? v : '';
const TOOL_LABELS: Record<string, string> = {
  read: '读取文件', read_file: '读取文件', write: '写入文件', edit: '修改文件',
  bash: '执行命令', exec: '执行命令', grep: '搜索内容', find: '查找文件', ls: '列出目录',
  commandExecution: '执行命令', fileChange: '修改文件', mcpToolCall: '调用工具', dynamicToolCall: '调用工具',
  webSearch: '网页搜索', imageGeneration: '生成图片', collabAgentToolCall: '协作工具', subAgentActivity: '子代理活动',
};

export function mergeNativeActivity(previous: NativeActivityView, pageValue: unknown, pageSize = 100): NativeActivityView {
  const page = record(pageValue);
  if (!Array.isArray(page.items) || page.items.length > pageSize) throw new Error('活动响应格式无效');
  const cursor = str(page.cursor);
  // Matches the existing management gateway's decimal cursor bound, without Number rounding.
  if (!/^[0-9]{1,18}$/.test(cursor) || BigInt(cursor) < BigInt(previous.cursor)) throw new Error('活动游标无效');
  if (page.items.length && BigInt(cursor) === BigInt(previous.cursor) && page.cursorExpired !== true) throw new Error('活动游标未前进');
  const items = new Map(previous.items.map(row => [row.id, row]));
  for (const value of page.items) {
    const event = record(value), payload = event.payload ? record(event.payload) : event;
    const kind = str(event.kind || event.type);
    const start = kind === 'TOOL_START' || kind === 'tool.started';
    const end = kind === 'TOOL_END' || kind === 'tool.completed';
    if (!start && !end) continue;
    const toolId = str(payload.toolCallId || payload.nativeItemId);
    if (!toolId) continue;
    const id = JSON.stringify([event.segmentId, event.nativeTurnId ?? payload.nativeTurnId, toolId]);
    const old = items.get(id);
    const status = str(payload.status);
    const state: NativeActivityRow['state'] = start ? 'running'
      : payload.isError === true || status === 'failed' ? 'failed'
      : status === 'declined' || status === 'rejected' ? 'rejected'
      : payload.isError === false || ['completed', 'succeeded'].includes(status) ? 'completed' : 'unknown';
    if (start && old && old.state !== 'running') continue;
    const toolName = str(payload.toolName || payload.type);
    const at = str(event.occurredAt || event.observedAt) || undefined;
    const detail = (str(payload.detail) || (end ? str(payload.error) : '')).slice(0, 200) || old?.detail;
    items.set(id, {id, label: TOOL_LABELS[toolName] ?? (toolName ? `工具 · ${toolName.slice(0, 100)}` : old?.label ?? '工具操作'), detail, state,
      occurredAt: old?.occurredAt ?? at, endedAt: end ? at : old?.endedAt});
  }
  return {items: [...items.values()].slice(-200), cursor, catchingUp: page.items.length === pageSize,
    trimmed: previous.trimmed || items.size > 200, expired: previous.expired || page.cursorExpired === true};
}
