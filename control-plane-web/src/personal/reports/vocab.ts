// P7 report vocabulary mirror — these strings are owned by
// server/management/reports/ports.mjs; duplicated here as literals because
// the browser bundle must not import server modules (node:fs deps).

export const REPORT_STATE_LABEL: Record<string, string> = {
  QUEUED: '排队中',
  RUNNING: '生成中',
  READY: '就绪',
  FAILED: '失败',
  UNKNOWN: '未知',
};
export const REPORT_STATE_TONE: Record<string, string> = {
  QUEUED: 'plain',
  RUNNING: 'info',
  READY: 'success',
  FAILED: 'failure',
  UNKNOWN: 'unknown',
};

/** meta.supportedActions carries REPORT_PROVIDER:<ref> for every provider
 * actually configured server-side — the dropdown renders real capability. */
export const PROVIDER_ACTION_PREFIX = 'REPORT_PROVIDER:';
export const PROVIDER_NOT_CONFIGURED_CODE = 'REPORT_PROVIDER_NOT_CONFIGURED';

export const OUTPUT_FORMATS = [
  { value: 'markdown+json', label: 'Markdown + JSON' },
  { value: 'markdown', label: '仅 Markdown' },
  { value: 'json', label: '仅 JSON' },
] as const;

export const REPORT_PROFILES = [
  { value: 'local/summary', label: '确定性汇总（local/summary）' },
] as const;

export type SourceScheme = 'data' | 'project' | 'delivery' | 'run' | 'session';
export const SOURCE_SCHEMES: { value: SourceScheme; label: string; hint: string }[] = [
  { value: 'data', label: '登记数据文件 (data:)', hint: '数据目录中已登记的 .csv/.json 文件名' },
  { value: 'project', label: '项目分析 (project:)', hint: '已登记 projectId — 交付/运行事实汇总' },
  { value: 'delivery', label: '交付 (delivery:)', hint: 'deliveryId — 变更事实' },
  { value: 'run', label: '运行 (run:)', hint: 'runId — 执行步骤与结果' },
  { value: 'session', label: '会话 (session:)', hint: 'sessionId — 会话概要' },
];

/** dataScope tokens the local provider honours (ports.mjs REPORT_DATA_SCOPE). */
export const DATA_SCOPE_OPTIONS = [
  { value: 'SAMPLE_ROWS', label: '包含有界样例行' },
  { value: 'INCLUDE_SCHEMA', label: '包含字段/列结构明细' },
] as const;
