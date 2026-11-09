/**
 * Typed sub-routes inside the Settings surface (settings design §5.1).
 * No React Router: the surface owns a typed route id; the shell renders
 * the matching page. Search indexes only these local public labels.
 */

export type SettingsRoute =
  | 'OVERVIEW'
  | 'GENERAL'
  | 'APPEARANCE'
  | 'MODELS'
  | 'PERMISSIONS'
  | 'PROJECTS_SESSIONS'
  | 'PRIVACY_EVIDENCE'
  | 'KNOWLEDGE'
  | 'EXTENSIONS'
  | 'FEATURES'
  | 'SERVICE'
  | 'RUNTIME'
  | 'DIAGNOSTICS'
  | 'ABOUT';

export type SettingsRouteGroup = 'common' | 'governance' | 'capabilities' | 'advanced';

export const SETTINGS_ROUTE_GROUP_LABELS: Record<SettingsRouteGroup, string> = {
  common: '常用',
  governance: '权限与数据',
  capabilities: '能力',
  advanced: '高级'
};

export interface SettingsRouteDefinition {
  id: SettingsRoute;
  label: string;
  description: string;
  group: SettingsRouteGroup;
  /** zh-CN synonyms for local search; never config values, only metadata */
  keywords: string[];
}

export const SETTINGS_ROUTES: SettingsRouteDefinition[] = [
  {
    id: 'OVERVIEW',
    label: '概览',
    description: '配置状态、来源和需要处理的事项',
    group: 'common',
    keywords: ['overview', '状态', '摘要', '健康']
  },
  {
    id: 'GENERAL',
    label: '通用',
    description: '语言、通知、启动与输入偏好',
    group: 'common',
    keywords: ['general', '通知', '语言', '快捷键', '发送', 'notification']
  },
  {
    id: 'APPEARANCE',
    label: '外观',
    description: '主题、密度、缩放与动效',
    group: 'common',
    keywords: ['appearance', 'theme', '主题', '密度', '缩放', '字号', '动效']
  },
  {
    id: 'MODELS',
    label: 'Agent 与模型',
    description: '模型目录、可用性与当前会话模型',
    group: 'common',
    keywords: ['models', 'model', '模型', '可用性']
  },
  {
    id: 'PERMISSIONS',
    label: '权限',
    description: '组织 / 项目 / 个人策略与有效上限',
    group: 'governance',
    keywords: ['permissions', 'policy', '策略', '自治', '上限']
  },
  {
    id: 'PROJECTS_SESSIONS',
    label: '项目与会话',
    description: '项目默认值、当前会话规则和作用域',
    group: 'governance',
    keywords: ['projects', 'sessions', '项目', '会话', '写范围']
  },
  {
    id: 'PRIVACY_EVIDENCE',
    label: '隐私与证据',
    description: '仅本机处理、Trace 导出与事件保留',
    group: 'governance',
    keywords: ['privacy', 'evidence', '隐私', 'trace', 'local-only', '保留']
  },
  {
    id: 'KNOWLEDGE',
    label: '知识',
    description: '待确认建议与已确认事实',
    group: 'governance',
    keywords: ['knowledge', 'memory', '知识', '建议', '确认']
  },
  {
    id: 'EXTENSIONS',
    label: '扩展',
    description: 'MCP、Skills 与 Hooks 的状态摘要',
    group: 'capabilities',
    keywords: ['extensions', 'mcp', 'skills', 'hooks', '扩展']
  },
  {
    id: 'FEATURES',
    label: '功能与环境',
    description: 'Sandbox、Web 搜索、终端、模型、MCP 与 Skills 的就绪状态与前置检查',
    group: 'capabilities',
    keywords: ['features', 'environment', 'sandbox', 'websearch', 'terminal', '模型', '沙箱', '终端', '功能', '环境', '就绪']
  },
  {
    id: 'SERVICE',
    label: 'Service',
    description: '连接、实例、协议与重启',
    group: 'advanced',
    keywords: ['service', '服务', '重启', '连接', '协议']
  },
  {
    id: 'RUNTIME',
    label: '运行时',
    description: '执行、Sandbox、Terminal 的安全投影',
    group: 'advanced',
    keywords: ['runtime', 'sandbox', 'terminal', '运行时', '能力']
  },
  {
    id: 'DIAGNOSTICS',
    label: '诊断',
    description: '日志位置、加密能力与配置健康',
    group: 'advanced',
    keywords: ['diagnostics', '诊断', '日志', '加密']
  },
  {
    id: 'ABOUT',
    label: '关于',
    description: 'Desktop 与 Service 版本信息',
    group: 'advanced',
    keywords: ['about', '版本', 'version']
  }
];

export function routeDefinition(route: SettingsRoute): SettingsRouteDefinition {
  return SETTINGS_ROUTES.find((candidate) => candidate.id === route) ?? SETTINGS_ROUTES[0]!;
}

/**
 * Local search index over public metadata only (design §5.4): labels,
 * descriptions and synonyms. Config values, knowledge content and secret
 * state are never part of the index.
 */
export function searchSettingsRoutes(query: string): SettingsRouteDefinition[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return [];
  return SETTINGS_ROUTES.filter((route) => {
    const haystack = [route.label, route.description, ...route.keywords].join(' ').toLowerCase();
    return haystack.includes(normalized);
  });
}
