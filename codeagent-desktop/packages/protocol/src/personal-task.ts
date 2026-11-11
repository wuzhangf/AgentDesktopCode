import type { ProjectSummary, ProjectSessionPreflight, SessionCreateRequest, SessionResponse, SessionMessageResponse, RunStateResponse, RunActivityListResponse, RunOutputResponse } from './index';

export interface PersonalTaskCreate {
  requestKey: string;
  projectId: string;
  title?: string;
  instruction: string;
  agentProfileId?: string;
  agentProfileRevision?: string;
  modelSettings?: { providerId: string; modelAlias: string; catalogRevision: string };
  engineId?: import('./native-task').NativeEngineId;
  optionsRevision?: string;
  executionOptions?: {model: string; accessMode: 'READ_ONLY' | 'WORKSPACE'};
}
export interface PersonalTaskIndex {
  taskId: string; projectId?: string; displayName?: string;
  createdAt: string; updatedAt: string; requestKey?: string;
  sessionId?: string; runId?: string; accepted: boolean;
  /** Owning core; absent only on older gateways that predate this field. */
  core?: 'ACS' | 'PI' | 'CODEX' | 'MACOS' | 'CODEP' | 'UNSUPPORTED';
}
export interface PersonalTaskOptions {
  preflight: ProjectSessionPreflight | null;
  native?: {localModels?: {id:string;displayName:string;provider?:string}[]; engines: import('./native-task').NativePreflight[]; host?: import('./native-task').NativeHostDiscovery};
  profiles: import('./index').AgentProfilesResponse | null;
  models: (import('./index').ModelCatalogResponse & {revision:string}) | null;
  issues: { code: string; message: string; blocking: boolean }[];
}
interface PersonalTaskDetailFields extends PersonalTaskIndex {
  instruction?: string;
  instructionNotice?: string;
  sourceProvenance?: 'ADOPTED_ORIGINAL';
  request?: PersonalTaskCreate;
  sourceStoreId?: string;
  conversation?: TaskConversationRef;
  launchDefaultModel?: string;
  submissionError?: {code: string; message: string};
  session?: Pick<SessionResponse, 'sessionId' | 'sessionVersion' | 'agentProfileId' | 'agentProfileName' | 'agentProfileRevision' | 'modelSettings' | 'workspaceBinding' | 'activeRunId'>;
  acceptance?: SessionMessageResponse;
  run?: import('./validators').ValidatedRunStateResponse;
  sourceError?: string;
  observedAt: string;
}
export type PersonalTaskDetail = PersonalTaskDetailFields & (
  {core:'ACS';executionBinding?:Extract<import('./native-task').PersonalExecutionBinding,{kind:'ACS_SESSION'}>;native?:never} |
  {core:'PI'|'CODEX'|'MACOS'|'CODEP'|'UNSUPPORTED';executionBinding:import('./native-task').NativeBinding;native?:import('./native-task').NativeTaskDetail;
    session?:never;run?:never;acceptance?:never;conversation?:never;launchDefaultModel?:never}
);
export interface PersonalTaskPage { items: PersonalTaskIndex[]; nextCursor: string | null }
export type AvailableProject = ProjectSummary & {connectionId?: string; backend?: 'WORKER_LOCAL'; sourceProjectRef?: string};
export type TaskActivities = RunActivityListResponse;
export type TaskOutput = RunOutputResponse;
/** Persisted dispatch facts; never a second execution state machine. */
export interface AcsTaskLaunchFacts {
  executionBinding?: Extract<import('./native-task').PersonalExecutionBinding, {kind:'ACS_SESSION'}>;
  request: PersonalTaskCreate;
  observation?: { sourceId: string; scopeId: string; fingerprint: string };
  connectionId: string;
  storeId: string;
  defaultModel?: string;
  submissionError?: {code: string; message: string};
  create: SessionCreateRequest;
  session?: { sessionId: string; sessionVersion: number };
  message?: { clientMessageId: string; content: string; expectedSessionVersion: number };
  acceptance?: SessionMessageResponse;
  runId?: string;
  lastObserved?: { conversation?: TaskConversationRef; session?: PersonalTaskDetail['session']; run?: PersonalTaskDetail['run']; observedAt: string };
}
interface NativeTaskBindingFacts {
  executionBinding: import('./native-task').NativeBinding;
  sourceError?: string;
  sourceRejection?: string;
  lastObserved?: import('./native-task').NativeTaskDetail;
}
/** Existing persisted launches omit provenance and keep their original create request. */
export interface NativeCreatedTaskLaunchFacts extends NativeTaskBindingFacts {
  provenance?: 'CREATED';
  request: PersonalTaskCreate;
  sourceRequest: {requestKey:string;projectId:string;engineId:string;optionsRevision:string;instruction:string;executionOptions?:PersonalTaskCreate['executionOptions']};
  dispatchStartedAt?: string;
}
/** An owner index of an already-created source task; never a dispatchable create. */
export interface NativeAdoptedTaskLaunchFacts extends NativeTaskBindingFacts {
  provenance: 'ADOPTED_ORIGINAL';
  request: {requestKey:string;projectId:string;localTaskId:string};
  sourceRequest: {kind:'ADOPTED_ORIGINAL';requestKey:string;projectId:string;engineId:string;optionsRevision?:string};
  originalCreateReceipt?: {requestKey:string;taskId:string;kind:'CREATE';engineId:string;engineVersion:string;projectId:string;profileId:string};
  sourceObservation?: {taskId:string;projectId:string;engineId:string;engineVersion:string;currentCommandId:string;observedAt:string};
}
export type NativeTaskLaunchFacts = NativeCreatedTaskLaunchFacts | NativeAdoptedTaskLaunchFacts;
export type TaskLaunchFacts = AcsTaskLaunchFacts | NativeTaskLaunchFacts;

export interface PersonalTaskMetrics {
  native?: {usage:Record<string,string>;coverage:'LAST_ASSISTANT_MESSAGE'|'NATIVE_THREAD_TOTAL'|'NATIVE_TASK_TOTAL'|'NO_MODEL'|'UNKNOWN';costCoverage:'UNKNOWN'};
  sourceId: string | null;
  observedAt: string | null;
  metrics: import('./metrics').MetricValue[];
  models: { providerId: string | null; requestedModel: string | null; resolvedModel: string | null; responseModel: string | null }[];
  reasonCodes: string[];
}

// ---- Reliable task control (design §6.1/§6.2) ----
// requestKey == commandId == the Idempotency-Key sent to the source run-command
// surface; the gateway never mints a second identity for a retried submit.

/** POST body for TASK_COMMAND_CREATE. PAUSE/RESUME carry the source
 * expectedStateVersion (safe integer); STOP never carries a version. */
export type PersonalTaskCommandRequest =
  | { requestKey: string; targetRunId?: string; intent: 'PAUSE' | 'RESUME'; expectedStateVersion: number }
  | { requestKey: string; targetRunId?: string; intent: 'STOP' };

/** One recorded control request: the submitted intent plus the latest
 * observed source receipt or failure fact (never a second state machine). */
export interface PersonalTaskCommandView {
  taskId: string;
  request: PersonalTaskCommandRequest;
  commandId: string;
  targetRunId?: string;
  createdAt: string;
  dispatchStartedAt?: string;
  receipt?: import('./index').RunCommandReceipt;
  receiptObservedAt?: string;
  sourceRejection?: { status: number; code: string; observedAt: string };
  sourceError?: { code: string; message: string; observedAt: string };
}

/** GET control read view: the run's control projection, the intents the
 * gateway currently allows, and the requests still awaiting a terminal
 * receipt. sourceCommands carries the raw source page when consumed. */
export interface PersonalTaskControlView {
  taskId: string;
  run?: Pick<import('./validators').ValidatedRunStateResponse,
    'runId' | 'sessionId' | 'state' | 'sourceStatus' | 'stateVersion' |
    'controlState' | 'controlCommandId' | 'checkpointAvailable' | 'availableActions'>;
  observedAt?: string;
  allowedIntents: ('PAUSE' | 'RESUME' | 'STOP')[];
  reasonCodes: string[];
  pendingRequests: PersonalTaskCommandView[];
  recentRequests?: PersonalTaskCommandView[];
  sourceCommands?: import('./index').RunCommandPage;
  sourceError?: { code: string; message: string; observedAt: string };
}

export interface TaskConversationRef {
  initialRunId?: string;
  activeRunId?: string;
  selectedRunId?: string;
  selectionReason: 'ACTIVE' | 'LATEST_MESSAGE_RUN' | 'USER_HISTORY' | 'NONE';
  observedAt: string;
}
export interface PersonalTaskMessageRequest {
  requestKey: string;
  clientMessageId: string;
  content: string;
  expectedSessionVersion: number;
}
export interface PersonalTaskInteractionView {
  taskId: string;
  request: PersonalTaskMessageRequest;
  sessionId: string;
  storeId: string;
  createdAt: string;
  dispatchStartedAt?: string;
  acceptance?: SessionMessageResponse;
  receipt?: import('./index').OperationReceiptResponse;
  sourceError?: {code: string; message: string};
  sourceRejection?: {code: string; message: string};
}
