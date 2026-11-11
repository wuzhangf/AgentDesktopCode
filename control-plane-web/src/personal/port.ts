// PAE P6 个人管理面 — typed port（PersonalGateway）与宿主面解析。
// 页面只依赖 PersonalGateway；传输实现见 client.ts（fetch / desktop 窄桥）
// 与 demo.ts（示例数据）。window.codeAgentDesktop 的探测只发生在
// resolvePersonalSurface 一处，不进入任何组件（§9.6）。
import type {
  ActionTrialReceiptView,
  AdaptiveActionDescriptor,
  PersonalActionRunInput,
  PersonalActionRunRequest,
  PersonalActionSaveInput,
  PersonalActionSaveRequest,
  PersonalEnvelope,
  PersonalEnvironmentOperationInput,
  PersonalEnvironmentOperationRequest,
  PersonalEnvironmentPlanInput,
  PersonalEnvironmentPlanPreview,
  PersonalEnvironmentPlanRequest,
  PersonalEnvironmentOperation,
  PersonalOperation,
  PersonalOperationAccepted,
  PersonalOperationCancelInput,
  PersonalOperationCancelRequest,
  PersonalOperationEventsPage,
  PersonalOverview,
  PersonalProjectRegistrationInput,
  PersonalProjectRegistrationRequest,
  PersonalProjectView,
  PersonalReportFile,
  PersonalReportInput,
  PersonalReportRequest,
  PersonalWorkerView,
  ProjectEnvironmentView,
  ReportDescriptor,
} from '../../../codeagent-desktop/packages/protocol/src/personal';
import type {
  PersonalTaskCommandRequest,
  PersonalTaskCommandView,
  PersonalTaskControlView,
} from '../../../codeagent-desktop/packages/protocol/src/personal-task';
import { createDesktopTransport, createFetchTransport, type PersonalDesktopBridge, type PersonalTransport } from './client';
import { createDemoTransport } from './demo';

/** 页面消费的 typed 口：与 ServiceClient 的 personal* 方法一一对应。 */
export interface PersonalGateway {
  availableProjects(): Promise<PersonalEnvelope<import('../../../codeagent-desktop/packages/protocol/src/personal-task').AvailableProject[]>>;
  taskOptions(projectId: string): Promise<PersonalEnvelope<import('../../../codeagent-desktop/packages/protocol/src/personal-task').PersonalTaskOptions>>;
  createTask(body: import('../../../codeagent-desktop/packages/protocol/src/personal-task').PersonalTaskCreate): Promise<PersonalEnvelope<import('../../../codeagent-desktop/packages/protocol/src/personal-task').PersonalTaskIndex>>;
  tasks(cursor?: string): Promise<PersonalEnvelope<import('../../../codeagent-desktop/packages/protocol/src/personal-task').PersonalTaskPage>>;
  task(taskId: string, runId?: string): Promise<PersonalEnvelope<import('../../../codeagent-desktop/packages/protocol/src/personal-task').PersonalTaskDetail>>;
  taskInteractions(taskId: string, runId?: string, cursor?: string): Promise<PersonalEnvelope<Record<string, unknown>>>;
  taskInteractionCatalog(taskId: string): Promise<PersonalEnvelope<{profiles: import('../../../codeagent-desktop/packages/protocol/src/index').AgentProfilesResponse; models: import('../../../codeagent-desktop/packages/protocol/src/index').ModelCatalogResponse}>>;
  createTaskEngagement(taskId: string, body: import('../../../codeagent-desktop/packages/protocol/src/personal-interaction').TaskEngagementRequest): Promise<PersonalEnvelope<import('../../../codeagent-desktop/packages/protocol/src/personal-interaction').TaskEngagementView>>;
  taskEngagement(taskId: string, requestKey: string): Promise<PersonalEnvelope<import('../../../codeagent-desktop/packages/protocol/src/personal-interaction').TaskEngagementView>>;
  taskApprovals(taskId: string, cursor?: string): Promise<PersonalEnvelope<import('../../../codeagent-desktop/packages/protocol/src/index').ApprovalsListResponse>>;
  taskMessages(taskId: string, cursor?: string): Promise<PersonalEnvelope<import('../../../codeagent-desktop/packages/protocol/src/index').SessionMessagePageResponse>>;
  sendTaskMessage(taskId: string, body: import('../../../codeagent-desktop/packages/protocol/src/personal-task').PersonalTaskMessageRequest): Promise<PersonalEnvelope<import('../../../codeagent-desktop/packages/protocol/src/personal-task').PersonalTaskInteractionView>>;
  taskInteractionRequest(taskId: string, requestKey: string): Promise<PersonalEnvelope<import('../../../codeagent-desktop/packages/protocol/src/personal-task').PersonalTaskInteractionView>>;
  taskRequest(requestKey: string): Promise<PersonalEnvelope<import('../../../codeagent-desktop/packages/protocol/src/personal-task').PersonalTaskIndex>>;
  taskActivities(taskId: string, afterCursor?: number, runId?: string): Promise<PersonalEnvelope<import('../../../codeagent-desktop/packages/protocol/src/personal-task').TaskActivities | null>>;
  taskOutput(taskId: string, runId?: string): Promise<PersonalEnvelope<import('../../../codeagent-desktop/packages/protocol/src/personal-task').TaskOutput | null>>;
  taskMetrics(taskId: string, runId?: string): Promise<PersonalEnvelope<import('../../../codeagent-desktop/packages/protocol/src/personal-task').PersonalTaskMetrics>>;
  taskCommands(taskId: string, query?: { limit?: number; before?: string; runId?: string }): Promise<PersonalEnvelope<PersonalTaskControlView>>;
  createTaskCommand(taskId: string, body: PersonalTaskCommandRequest): Promise<PersonalEnvelope<PersonalTaskCommandView>>;
  taskCommand(taskId: string, requestKey: string): Promise<PersonalEnvelope<PersonalTaskCommandView>>;
  overview(): Promise<PersonalEnvelope<PersonalOverview>>;
  listProjects(): Promise<PersonalEnvelope<PersonalProjectView[]>>;
  registerProject(input: PersonalProjectRegistrationInput): Promise<PersonalEnvelope<PersonalProjectView>>;
  getProject(projectId: string): Promise<PersonalEnvelope<PersonalProjectView>>;
  getProjectEnvironment(projectId: string): Promise<PersonalEnvelope<ProjectEnvironmentView>>;
  previewEnvironmentPlan(projectId: string, input: PersonalEnvironmentPlanInput): Promise<PersonalEnvelope<PersonalEnvironmentPlanPreview>>;
  startEnvironmentOperation(projectId: string, input: PersonalEnvironmentOperationInput): Promise<PersonalEnvelope<PersonalOperationAccepted>>;
  getEnvironmentOperation(operationId: string): Promise<PersonalEnvelope<PersonalEnvironmentOperation>>;
  getEnvironmentOperationEvents(operationId: string, query?: { cursor?: string; limit?: number }): Promise<PersonalEnvelope<PersonalOperationEventsPage>>;
  cancelEnvironmentOperation(operationId: string, input: PersonalOperationCancelInput): Promise<PersonalEnvelope<PersonalEnvironmentOperation>>;
  listWorkers(): Promise<PersonalEnvelope<PersonalWorkerView[]>>;
  getWorker(workerId: string): Promise<PersonalEnvelope<PersonalWorkerView>>;
  listTaskActions(taskId: string): Promise<PersonalEnvelope<AdaptiveActionDescriptor[]>>;
  runTaskAction(taskId: string, actionId: string, input: PersonalActionRunInput): Promise<PersonalEnvelope<ActionTrialReceiptView>>;
  saveTaskAction(taskId: string, actionId: string, input: PersonalActionSaveInput): Promise<PersonalEnvelope<AdaptiveActionDescriptor>>;
  listReports(): Promise<PersonalEnvelope<ReportDescriptor[]>>;
  createReport(input: PersonalReportInput): Promise<PersonalEnvelope<ReportDescriptor>>;
  getReport(reportId: string): Promise<PersonalEnvelope<ReportDescriptor>>;
  listReportFiles(reportId: string): Promise<PersonalEnvelope<PersonalReportFile[]>>;
}

/** 写输入缺省 requestKey 时生成（crypto.randomUUID，符合冻结 ID 正则），
 * 已提供则透传——同一重试保持幂等身份；key 与 body.requestKey 恒等。 */
function keyed<I extends { requestKey?: string }, R extends { requestKey: string }>(
  input: I,
): { key: string; body: R } {
  const key = input.requestKey ?? crypto.randomUUID();
  return { key, body: { ...input, requestKey: key } as unknown as R };
}

/** transport → typed 门面。每个方法只组装冻结的 PersonalOperation。 */
export function personalGateway(transport: PersonalTransport): PersonalGateway {
  return {
    availableProjects: () => transport({ action: 'PROJECTS_AVAILABLE' }) as ReturnType<PersonalGateway['availableProjects']>,
    taskOptions: projectId => transport({ action: 'TASK_OPTIONS', projectId }) as ReturnType<PersonalGateway['taskOptions']>,
    createTask: body => transport({ action: 'TASK_CREATE', key: body.requestKey, body }) as ReturnType<PersonalGateway['createTask']>,
    tasks: cursor => transport({ action: 'TASKS', cursor }) as ReturnType<PersonalGateway['tasks']>,
    task: (taskId, runId) => transport({ action: 'TASK', taskId, runId }) as ReturnType<PersonalGateway['task']>,
    taskInteractions: (taskId,runId,cursor) => transport({action:'TASK_INTERACTIONS',taskId,runId,cursor}) as ReturnType<PersonalGateway['taskInteractions']>,
    taskInteractionCatalog: taskId => transport({action:'TASK_INTERACTION_CATALOG',taskId}) as ReturnType<PersonalGateway['taskInteractionCatalog']>,
    createTaskEngagement: (taskId,body) => {
      const actions = {BOUNDARY:'TASK_BOUNDARY_CREATE',SIDE_QUESTION:'TASK_SIDE_QUESTION_CREATE',PREFLIGHT:'TASK_HANDOFF_PREFLIGHT',HANDOFF:'TASK_HANDOFF_CREATE',APPROVAL_DECISION:'TASK_APPROVAL_DECISION',CANCEL_BOUNDARY:'TASK_BOUNDARY_CANCEL',CANCEL_HANDOFF:'TASK_HANDOFF_CANCEL'} as const;
      return transport({action:actions[body.kind],taskId,...('resourceId' in body?{entityId:body.resourceId}:'approvalId' in body?{entityId:body.approvalId}:{}),key:body.requestKey,body}) as ReturnType<PersonalGateway['createTaskEngagement']>;
    },
    taskEngagement: (taskId,requestKey) => transport({action:'TASK_ENGAGEMENT',taskId,requestKey}) as ReturnType<PersonalGateway['taskEngagement']>,
    taskApprovals: (taskId,cursor) => transport({action:'TASK_APPROVALS',taskId,cursor}) as ReturnType<PersonalGateway['taskApprovals']>,
    taskMessages: (taskId, cursor) => transport({action: 'TASK_MESSAGES', taskId, cursor}) as ReturnType<PersonalGateway['taskMessages']>,
    sendTaskMessage: (taskId, body) => transport({action: 'TASK_MESSAGE_CREATE', taskId, key: body.requestKey, body}) as ReturnType<PersonalGateway['sendTaskMessage']>,
    taskInteractionRequest: (taskId, requestKey) => transport({action: 'TASK_INTERACTION_REQUEST', taskId, requestKey}) as ReturnType<PersonalGateway['taskInteractionRequest']>,
    taskRequest: requestKey => transport({ action: 'TASK_REQUEST', requestKey }) as ReturnType<PersonalGateway['taskRequest']>,
    taskActivities: (taskId, afterCursor, runId) => transport({ action: 'TASK_ACTIVITY', taskId, runId, afterCursor: afterCursor === undefined ? undefined : String(afterCursor) }) as ReturnType<PersonalGateway['taskActivities']>,
    taskOutput: (taskId, runId) => transport({ action: 'TASK_OUTPUT', taskId, runId }) as ReturnType<PersonalGateway['taskOutput']>,
    taskMetrics: (taskId, runId) => transport({ action: 'TASK_METRICS', taskId, runId }) as ReturnType<PersonalGateway['taskMetrics']>,
    taskCommands: (taskId, query = {}) => transport({
      action: 'TASK_COMMANDS', taskId, runId: query.runId,
      limit: query.limit === undefined ? undefined : String(query.limit),
      before: query.before,
    }) as Promise<PersonalEnvelope<PersonalTaskControlView>>,
    createTaskCommand: (taskId, body) => transport({ action: 'TASK_COMMAND_CREATE', taskId, key: body.requestKey, body }) as Promise<PersonalEnvelope<PersonalTaskCommandView>>,
    taskCommand: (taskId, requestKey) => transport({ action: 'TASK_COMMAND', taskId, requestKey }) as Promise<PersonalEnvelope<PersonalTaskCommandView>>,
    overview: () => transport({ action: 'OVERVIEW' }) as Promise<PersonalEnvelope<PersonalOverview>>,
    listProjects: () => transport({ action: 'PROJECTS' }) as Promise<PersonalEnvelope<PersonalProjectView[]>>,
    registerProject: (input) => {
      const { key, body } = keyed<PersonalProjectRegistrationInput, PersonalProjectRegistrationRequest>(input);
      return transport({ action: 'REGISTER_PROJECT', key, body }) as Promise<PersonalEnvelope<PersonalProjectView>>;
    },
    getProject: (projectId) => transport({ action: 'PROJECT', projectId }) as Promise<PersonalEnvelope<PersonalProjectView>>,
    getProjectEnvironment: (projectId) => transport({ action: 'PROJECT_ENVIRONMENT', projectId }) as Promise<PersonalEnvelope<ProjectEnvironmentView>>,
    previewEnvironmentPlan: (projectId, input) => {
      const { key, body } = keyed<PersonalEnvironmentPlanInput, PersonalEnvironmentPlanRequest>(input);
      return transport({ action: 'ENVIRONMENT_PLAN', projectId, key, body }) as Promise<PersonalEnvelope<PersonalEnvironmentPlanPreview>>;
    },
    startEnvironmentOperation: (projectId, input) => {
      const { key, body } = keyed<PersonalEnvironmentOperationInput, PersonalEnvironmentOperationRequest>(input);
      return transport({ action: 'ENVIRONMENT_OPERATION', projectId, key, body }) as Promise<PersonalEnvelope<PersonalOperationAccepted>>;
    },
    getEnvironmentOperation: (operationId) => transport({ action: 'OPERATION', operationId }) as Promise<PersonalEnvelope<PersonalEnvironmentOperation>>,
    getEnvironmentOperationEvents: (operationId, query = {}) => transport({
      action: 'OPERATION_EVENTS', operationId,
      cursor: query.cursor, limit: query.limit === undefined ? undefined : String(query.limit),
    }) as Promise<PersonalEnvelope<PersonalOperationEventsPage>>,
    cancelEnvironmentOperation: (operationId, input) => {
      const { key, body } = keyed<PersonalOperationCancelInput, PersonalOperationCancelRequest>(input);
      return transport({ action: 'OPERATION_CANCEL', operationId, key, body }) as Promise<PersonalEnvelope<PersonalEnvironmentOperation>>;
    },
    listWorkers: () => transport({ action: 'WORKERS' }) as Promise<PersonalEnvelope<PersonalWorkerView[]>>,
    getWorker: (workerId) => transport({ action: 'WORKER', workerId }) as Promise<PersonalEnvelope<PersonalWorkerView>>,
    listTaskActions: (taskId) => transport({ action: 'TASK_ACTIONS', taskId }) as Promise<PersonalEnvelope<AdaptiveActionDescriptor[]>>,
    runTaskAction: (taskId, actionId, input) => {
      const { key, body } = keyed<PersonalActionRunInput, PersonalActionRunRequest>(input);
      return transport({ action: 'ACTION_RUN', taskId, actionId, key, body }) as Promise<PersonalEnvelope<ActionTrialReceiptView>>;
    },
    saveTaskAction: (taskId, actionId, input) => {
      const { key, body } = keyed<PersonalActionSaveInput, PersonalActionSaveRequest>(input);
      return transport({ action: 'ACTION_SAVE', taskId, actionId, key, body }) as Promise<PersonalEnvelope<AdaptiveActionDescriptor>>;
    },
    listReports: () => transport({ action: 'REPORTS' }) as Promise<PersonalEnvelope<ReportDescriptor[]>>,
    createReport: (input) => {
      const { key, body } = keyed<PersonalReportInput, PersonalReportRequest>(input);
      return transport({ action: 'REPORT_CREATE', key, body }) as Promise<PersonalEnvelope<ReportDescriptor>>;
    },
    getReport: (reportId) => transport({ action: 'REPORT', reportId }) as Promise<PersonalEnvelope<ReportDescriptor>>,
    listReportFiles: (reportId) => transport({ action: 'REPORT_FILES', reportId }) as Promise<PersonalEnvelope<PersonalReportFile[]>>,
  };
}

export type PersonalSurfaceKind = 'web' | 'desktop' | 'demo';

/** 宿主面：决定写按钮是否显示。readonly 覆盖窄接口/手机式只读场景。 */
export interface PersonalSurface {
  kind: PersonalSurfaceKind;
  /** 只读面：所有写按钮隐藏（未实现的远程写权限不显示按钮，§9.6）。 */
  readonly: boolean;
  gateway: PersonalGateway;
  transport: PersonalTransport;
  label: string;
}

interface WindowWithDesktopBridge {
  codeAgentDesktop?: PersonalDesktopBridge;
}

/**
 * 解析宿主面（顺序固定、可显式覆盖）：
 * 1. ?demo=1 → 示例数据 transport（页面持续显示示例横幅）；
 * 2. window.codeAgentDesktop.personalOperation 存在 → Desktop IPC 窄桥；
 * 3. 其余 → 同源 fetch /api/personal/v1（Web）。
 * ?readonly=1 或 ?surface=mobile → 只读面（手机式窄接口预留）。
 */
export function resolvePersonalSurface(search?: string, host?: WindowWithDesktopBridge): PersonalSurface {
  const params = new URLSearchParams(search ?? (typeof window !== 'undefined' ? window.location.search : ''));
  const readonly = params.get('readonly') === '1' || params.get('surface') === 'mobile';
  const demo = params.get('demo') === '1';
  const bridge = (host ?? (globalThis as WindowWithDesktopBridge)).codeAgentDesktop;
  let transport: PersonalTransport;
  let kind: PersonalSurfaceKind;
  if (demo) {
    kind = 'demo';
    transport = createDemoTransport();
  } else if (typeof bridge?.personalOperation === 'function') {
    kind = 'desktop';
    transport = createDesktopTransport(bridge);
  } else {
    kind = 'web';
    transport = createFetchTransport();
  }
  const label = kind === 'demo' ? '示例数据'
    : kind === 'desktop' ? '本机 Desktop 通道'
    : 'Web 管理通道';
  return { kind, readonly, transport, gateway: personalGateway(transport), label };
}
