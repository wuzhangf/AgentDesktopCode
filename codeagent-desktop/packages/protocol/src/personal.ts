import { validNativeInput, supportedNativeEngine } from './native-task';
import { validTaskEngagement } from './personal-interaction';
import type { JsonValue } from './index';
/**
 * Personal management gateway contract `/api/personal/v1`
 * (PAE P0 contract freeze 2026-10-18 §4; design §10.2/§11).
 *
 * Hand-authored like writable-collaboration.ts: this is the third channel
 * beside read-only `/api/v2` observation and the `/api/worker` lab BFF and
 * must not be merged into either. All DTOs carry the Personal/Environment
 * qualifiers so they never collide with the `/api/v2/environment/features`
 * feature-card surface.
 *
 * Frozen vocabulary (freeze §2/§4):
 * - EnvironmentOperationState: QUEUED|RUNNING|NEEDS_INPUT|READY|FAILED|CANCELED|UNKNOWN
 * - EnvironmentReasonCode: the eleven environment-domain codes of freeze §2
 * - PersonalConnectionKind: CORE_LOCAL|DAEMON|ACS_DIRECT
 * - capability names projectEnvironmentPrepareV1 / environmentBoundExecutionV1 / adaptiveActionV1
 *
 * Every response uses the envelope {meta:{source,instance,controlPlaneId,
 * observedAt,revision,supportedActions[],reasonCodes[]}, data}; errors use
 * {error:{code,message,retryable,requestId}}. Write bodies carry
 * {requestKey, expectedRevision?, ...}; the browser only submits registered
 * IDs and non-secret version selections — never URLs, host paths or shell.
 */
export type PersonalConnectionKind = 'CORE_LOCAL' | 'DAEMON' | 'ACS_DIRECT' | 'WORKER_LOCAL';
export const PERSONAL_CONNECTION_KINDS: readonly PersonalConnectionKind[] = ['CORE_LOCAL', 'DAEMON', 'ACS_DIRECT', 'WORKER_LOCAL'];
export type EnvironmentOperationState = 'QUEUED' | 'RUNNING' | 'NEEDS_INPUT' | 'READY' | 'FAILED' | 'CANCELED' | 'UNKNOWN';
export const ENVIRONMENT_OPERATION_STATES: readonly EnvironmentOperationState[] = ['QUEUED', 'RUNNING', 'NEEDS_INPUT', 'READY', 'FAILED', 'CANCELED', 'UNKNOWN'];
export type EnvironmentReasonCode = 'TOOLCHAIN_MISSING' | 'VERSION_CONFLICT' | 'DEPENDENCY_UNAVAILABLE' | 'NETWORK_DENIED' | 'CREDENTIAL_REQUIRED' | 'SERVICE_UNREADY' | 'PLATFORM_UNSUPPORTED' | 'BACKEND_UNAVAILABLE' | 'PLAN_INVALID' | 'RESOURCE_EXHAUSTED' | 'EFFECT_UNKNOWN';
export const ENVIRONMENT_REASON_CODES: readonly EnvironmentReasonCode[] = ['TOOLCHAIN_MISSING', 'VERSION_CONFLICT', 'DEPENDENCY_UNAVAILABLE', 'NETWORK_DENIED', 'CREDENTIAL_REQUIRED', 'SERVICE_UNREADY', 'PLATFORM_UNSUPPORTED', 'BACKEND_UNAVAILABLE', 'PLAN_INVALID', 'RESOURCE_EXHAUSTED', 'EFFECT_UNKNOWN'];
export type EnvironmentOperationKind = 'PREPARE' | 'CLEANUP' | 'RETIRE';
export const ENVIRONMENT_OPERATION_KINDS: readonly EnvironmentOperationKind[] = ['PREPARE', 'CLEANUP', 'RETIRE'];
export type EnvironmentBackendPreference = 'HOST' | 'OCI_DOCKER' | 'OCI_PODMAN' | 'ANY';
export const ENVIRONMENT_BACKEND_PREFERENCES: readonly EnvironmentBackendPreference[] = ['HOST', 'OCI_DOCKER', 'OCI_PODMAN', 'ANY'];
export type ProjectedCheckStatus = 'PASS' | 'FAIL' | 'BLOCKED' | 'INCONCLUSIVE' | 'NOT_APPLICABLE' | 'DISABLED';
export const PROJECTED_CHECK_STATUSES: readonly ProjectedCheckStatus[] = ['PASS', 'FAIL', 'BLOCKED', 'INCONCLUSIVE', 'NOT_APPLICABLE', 'DISABLED'];
export type AdaptiveActionScope = 'TASK' | 'PROJECT';
export const ADAPTIVE_ACTION_SCOPES: readonly AdaptiveActionScope[] = ['TASK', 'PROJECT'];
export type EnvironmentReadinessFactKind = 'TOOL_VERSION' | 'WRITABLE_PATH' | 'SERVICE_HEALTH' | 'DEPENDENCY_ENTRY';
export const ENVIRONMENT_READINESS_FACT_KINDS: readonly EnvironmentReadinessFactKind[] = ['TOOL_VERSION', 'WRITABLE_PATH', 'SERVICE_HEALTH', 'DEPENDENCY_ENTRY'];
export const PERSONAL_API_PREFIX = '/api/personal/v1';
/** Joint capabilities (freeze §2): only advertised when install-side channel,
 * real binding consumption and measured readiness are all present. */
export const PERSONAL_CAPABILITY = Object.freeze({
  PROJECT_ENVIRONMENT_PREPARE_V1: 'projectEnvironmentPrepareV1',
  ENVIRONMENT_BOUND_EXECUTION_V1: 'environmentBoundExecutionV1',
  ADAPTIVE_ACTION_V1: 'adaptiveActionV1'
});
export type PersonalCapabilityName = typeof PERSONAL_CAPABILITY[keyof typeof PERSONAL_CAPABILITY];
export const PERSONAL_CAPABILITY_NAMES: readonly PersonalCapabilityName[] = [PERSONAL_CAPABILITY.PROJECT_ENVIRONMENT_PREPARE_V1, PERSONAL_CAPABILITY.ENVIRONMENT_BOUND_EXECUTION_V1, PERSONAL_CAPABILITY.ADAPTIVE_ACTION_V1];
export const PERSONAL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
export const PERSONAL_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;

export interface PersonalMeta {
  source: string;
  instance: string;
  controlPlaneId: string;
  /** UTC RFC-3339 of the authoritative observation; stale facts keep it. */
  observedAt: string;
  revision: string;
  supportedActions: string[];
  reasonCodes: string[];
}
export interface PersonalEnvelope<T> {
  meta: PersonalMeta;
  data: T;
}
export interface PersonalErrorBody {
  code: string;
  message?: string;
  retryable?: boolean;
  requestId?: string;
}

export interface PersonalAttentionItem {
  kind: string;
  refId?: string | null;
  projectId?: string | null;
  operationId?: string | null;
  reasonCode?: EnvironmentReasonCode | (string & {}) | null;
  message: string;
  observedAt?: string | null;
}
export interface PersonalOverview {
  projects?: PersonalProjectView[];
  workers?: PersonalWorkerView[];
  attention?: PersonalAttentionItem[];
}
export interface PersonalProjectView {
  projectId: string;
  projectRef: string;
  displayName?: string | null;
  registeredAt?: string | null;
  updatedAt?: string | null;
  revision?: string | null;
}
/** Register a reference to an already-registered projectRef (freeze §4). */
export interface PersonalProjectRegistrationRequest {
  requestKey: string;
  connectionId?: string;
  projectRef: string;
  displayName?: string;
  notes?: string;
}

export interface PersonalEnvironmentRequirement {
  requirementId?: string | null;
  kind: string;
  name: string;
  version?: string | null;
  source?: string | null;
  detail?: string | null;
}
export interface PersonalEnvironmentFact {
  factId?: string | null;
  /** readinessFacts vocabulary (freeze §1): TOOL_VERSION|WRITABLE_PATH|SERVICE_HEALTH|DEPENDENCY_ENTRY. */
  kind: EnvironmentReadinessFactKind | (string & {});
  name?: string | null;
  version?: string | null;
  detailRef?: string | null;
  observedAt?: string | null;
}
/** Project readiness view (needs/have/missing); never an install trigger. */
export interface ProjectEnvironmentView {
  projectId: string;
  environmentId?: string | null;
  environmentRevision?: string | null;
  state?: EnvironmentOperationState | (string & {}) | null;
  needs: PersonalEnvironmentRequirement[];
  have: PersonalEnvironmentFact[];
  missing: PersonalEnvironmentRequirement[];
  warnings?: string[];
  supportedCores?: string[];
  planDigest?: string | null;
  imageDigest?: string | null;
  activeOperationId?: string | null;
  observedAt?: string | null;
}
export interface PersonalToolchainSelection {
  tool: string;
  version: string;
  source?: string | null;
}
/** Plan preview request (freeze §4): preview only — prepares nothing. */
export interface PersonalEnvironmentPlanRequest {
  requestKey: string;
  expectedRevision?: string;
  preferredBackend?: EnvironmentBackendPreference;
  toolchainSelections?: PersonalToolchainSelection[];
  notes?: string;
}
export interface PersonalPlanStepView {
  stepId?: string | null;
  kind?: string | null;
  ref?: string | null;
  summary?: string | null;
}
export interface PersonalEnvironmentPlanPreview {
  planId?: string | null;
  planDigest?: string | null;
  steps?: PersonalPlanStepView[];
  /** Unknown costs stay null; the UI shows unknown, never an estimate. */
  estimatedDownloadBytes?: number | null;
  estimatedDiskBytes?: number | null;
  missing?: PersonalEnvironmentRequirement[];
  warnings?: string[];
  expiresAt?: string | null;
}

/** Prepare/cleanup/retire command (freeze §4); idempotent on requestKey+body. */
export interface PersonalEnvironmentOperationRequest {
  requestKey: string;
  kind: EnvironmentOperationKind;
  expectedRevision?: string;
  planDigest?: string;
  environmentId?: string;
  environmentRevision?: string;
}
export interface PersonalOperationCancelRequest {
  requestKey: string;
  expectedRevision?: string;
}
export interface PersonalOperationAccepted {
  operationId: string;
  state: EnvironmentOperationState | (string & {});
}
export interface PersonalEnvironmentOperation {
  operationId: string;
  requestKey?: string | null;
  kind: EnvironmentOperationKind | (string & {});
  state: EnvironmentOperationState | (string & {});
  projectId?: string | null;
  environmentId?: string | null;
  revision?: string | null;
  cursor?: string | null;
  progress?: number | null;
  reasonCode?: EnvironmentReasonCode | (string & {}) | null;
  resultRef?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
}
export interface PersonalOperationEvent {
  eventId?: string | null;
  occurredAt?: string | null;
  kind?: string | null;
  state?: EnvironmentOperationState | (string & {}) | null;
  message?: string | null;
}
/** Bounded page; nextCursor is opaque and resumes the original operation. */
export interface PersonalOperationEventsPage {
  events: PersonalOperationEvent[];
  nextCursor?: string | null;
}

export interface PersonalWorkerCapabilities {
  projectEnvironmentPrepareV1?: boolean;
  environmentBoundExecutionV1?: boolean;
  adaptiveActionV1?: boolean;
  [name: string]: boolean | undefined;
}
export interface PersonalWorkerView {
  workerId: string;
  displayName?: string | null;
  connectionKind: PersonalConnectionKind | (string & {});
  connectionState?: string | null;
  capabilities?: PersonalWorkerCapabilities;
  supportedCores?: string[];
  version?: string | null;
  platform?: string | null;
  operatorState?: string | null;
  revision?: string | null;
  observedAt?: string | null;
  reasonCodes?: (EnvironmentReasonCode | (string & {}))[];
}

export interface AdaptiveActionDescriptor {
  actionId: string;
  actionVersion?: string | null;
  name?: string | null;
  scope?: AdaptiveActionScope | (string & {});
  objective?: string | null;
  targetDirectory?: string | null;
  interpreter?: string | null;
  timeoutMillis?: number | null;
  provenance?: string | null;
  planDigest?: string | null;
  saved?: boolean | null;
  revision?: string | null;
}
/** Trial run: bounded declared inputs only, never script bytes or argv. */
export interface PersonalActionRunRequest {
  requestKey: string;
  expectedRevision?: string;
  inputs?: Record<string, JsonValue>;
}
/** Save is a separate effect from run; a failed save never re-executes. */
export interface PersonalActionSaveRequest {
  requestKey: string;
  expectedRevision?: string;
  name?: string;
  scope?: AdaptiveActionScope;
}
export interface ActionTrialReceiptView {
  trialId: string;
  actionId?: string | null;
  planDigest?: string | null;
  bindingDigest?: string | null;
  exitStatus?: number | string | null;
  evidenceVerdict?: ProjectedCheckStatus | (string & {}) | null;
  outputRefs?: string[];
  reportRefs?: string[];
  startedAt?: string | null;
  endedAt?: string | null;
}

export interface PersonalReportRequest {
  requestKey: string;
  sourceRef: string;
  sourceVersion?: string;
  sourceDigest?: string;
  reportProfileRef?: string;
  providerRef?: string;
  outputFormat?: string;
  /** User-chosen data scope for external providers (design §12). */
  dataScope?: string[];
}
export interface ReportDescriptor {
  reportId: string;
  requestKey?: string | null;
  sourceRef?: string | null;
  sourceVersion?: string | null;
  sourceDigest?: string | null;
  reportProfileRef?: string | null;
  providerRef?: string | null;
  outputFormat?: string | null;
  state: string;
  dataScope?: string[];
  resultDigest?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  error?: { code?: string; message?: string | null } | null;
}
export interface PersonalReportFile {
  fileId?: string | null;
  name: string;
  mediaType?: string | null;
  sizeBytes?: number | null;
  digest?: string | null;
}

/** Client-facing write input: the transport generates requestKey when the
 * caller omits it, or passes a supplied requestKey through unchanged so a
 * retried/renewed submit keeps idempotent identity (freeze §4). */
export type PersonalWriteInput<T extends { requestKey: string }> = Omit<T, 'requestKey'> & { requestKey?: string };
export type PersonalProjectRegistrationInput = PersonalWriteInput<PersonalProjectRegistrationRequest>;
export type PersonalEnvironmentPlanInput = PersonalWriteInput<PersonalEnvironmentPlanRequest>;
export type PersonalEnvironmentOperationInput = PersonalWriteInput<PersonalEnvironmentOperationRequest>;
export type PersonalOperationCancelInput = PersonalWriteInput<PersonalOperationCancelRequest>;
export type PersonalActionRunInput = PersonalWriteInput<PersonalActionRunRequest>;
export type PersonalActionSaveInput = PersonalWriteInput<PersonalActionSaveRequest>;
export type PersonalReportInput = PersonalWriteInput<PersonalReportRequest>;

/** Fixed use cases crossing the personal boundary, never an arbitrary
 * HTTP URL/method/header proxy (collaboration.ts precedent). `key` is the
 * transport idempotency handle and must equal body.requestKey on writes. */
export type PersonalOperation =
  | { action: 'PROJECTS_AVAILABLE' }
  | { action: 'TASK_OPTIONS'; projectId: string }
  | { action: 'NATIVE_SOURCE_TASKS'; projectId: string }
  | { action: 'NATIVE_TASK_ADOPT'; projectId: string; key: string; body: {requestKey:string;localTaskId:string} }
  | { action: 'TASK_CREATE'; key: string; body: import('./personal-task').PersonalTaskCreate }
  | { action: 'TASKS'; cursor?: string; limit?: string }
  | { action: 'TASK_REQUEST'; requestKey: string }
  | { action: 'TASK' | 'TASK_OUTPUT' | 'TASK_METRICS'; taskId: string; runId?: string }
  | { action: 'TASK_ACTIVITY'; taskId: string; runId?: string; afterCursor?: string; limit?: string }
  // Stream control ops (worker-events/1): SUBSCRIBE carries the resume
  // cursor and is consumed by Electron main — it opens the same activities
  // leaf with Accept: text/event-stream. UNSUBSCRIBE tears the main-side
  // subscription down; it never reaches the gateway as a request.
  | { action: 'TASK_EVENTS_SUBSCRIBE'; taskId: string; afterCursor?: string }
  | { action: 'TASK_EVENTS_UNSUBSCRIBE'; taskId: string }
  | { action: 'TASK_COMMANDS'; taskId: string; runId?: string; limit?: string; before?: string }
  | { action: 'TASK_COMMAND_CREATE'; taskId: string; key: string; body: import('./personal-task').PersonalTaskCommandRequest | Extract<import('./native-task').NativeInput, {kind:'STOP'|'PAUSE'|'RESUME'}> }
  | {action:'NATIVE_MESSAGE_CREATE';taskId:string;key:string;body:Extract<import('./native-task').NativeInput,{kind:'NATIVE_STEER'|'NATIVE_FOLLOW_UP'}>}
  | {action:'NATIVE_INPUT_RESPONSE';taskId:string;entityId:string;key:string;body:Extract<import('./native-task').NativeInput,{kind:'INPUT_RESPONSE'}>}
  | { action: 'NATIVE_INPUTS' | 'NATIVE_ARTIFACTS'; taskId: string }
  | { action: 'NATIVE_ARTIFACT'; taskId: string; entityId: string }
  | { action: 'TASK_INTERACTIONS' | 'TASK_INTERACTION_CATALOG'; taskId: string; runId?: string; cursor?: string; limit?: string }
  | { action: 'TASK_BOUNDARY_CREATE' | 'TASK_SIDE_QUESTION_CREATE' | 'TASK_HANDOFF_PREFLIGHT' | 'TASK_HANDOFF_CREATE' | 'TASK_APPROVAL_DECISION' | 'TASK_BOUNDARY_CANCEL' | 'TASK_HANDOFF_CANCEL'; taskId: string; entityId?: string; key: string; body: import('./personal-interaction').TaskEngagementRequest }
  | {action:'TASK_BOUNDARY_RESULT'|'TASK_HANDOFF_RESULT';taskId:string;entityId:string;runId?:string}
  | { action: 'TASK_ENGAGEMENT'; taskId: string; requestKey: string }
  | { action: 'TASK_APPROVALS'; taskId: string; cursor?: string; limit?: string }
  | { action: 'TASK_APPROVAL'; taskId: string; requestKey: string }
  | { action: 'TASK_MESSAGES'; taskId: string; cursor?: string; before?: string; limit?: string }
  | { action: 'TASK_MESSAGE_CREATE'; taskId: string; key: string; body: import('./personal-task').PersonalTaskMessageRequest }
  | { action: 'TASK_INTERACTION_REQUEST'; taskId: string; requestKey: string }
  | { action: 'TASK_COMMAND'; taskId: string; requestKey: string }
  | { action: 'OVERVIEW' | 'PROJECTS' | 'WORKERS' | 'REPORTS' }
  | { action: 'PROJECT' | 'PROJECT_ENVIRONMENT'; projectId: string }
  | { action: 'REGISTER_PROJECT'; key: string; body: PersonalProjectRegistrationRequest }
  | { action: 'ENVIRONMENT_PLAN'; projectId: string; key: string; body: PersonalEnvironmentPlanRequest }
  | { action: 'ENVIRONMENT_OPERATION'; projectId: string; key: string; body: PersonalEnvironmentOperationRequest }
  | { action: 'OPERATION'; operationId: string }
  | { action: 'OPERATION_EVENTS'; operationId: string; cursor?: string; limit?: string }
  | { action: 'OPERATION_CANCEL'; operationId: string; key: string; body: PersonalOperationCancelRequest }
  | { action: 'WORKER'; workerId: string }
  | { action: 'TASK_ACTIONS'; taskId: string }
  | { action: 'ACTION_RUN'; taskId: string; actionId: string; key: string; body: PersonalActionRunRequest }
  | { action: 'ACTION_SAVE'; taskId: string; actionId: string; key: string; body: PersonalActionSaveRequest }
  | { action: 'REPORT_CREATE'; key: string; body: PersonalReportRequest }
  | { action: 'REPORT' | 'REPORT_FILES'; reportId: string };
interface PersonalRoute { method: 'GET' | 'POST'; tail: string }
export const PERSONAL_ROUTES: Record<PersonalOperation['action'], PersonalRoute> = {
  PROJECTS_AVAILABLE: { method: 'GET', tail: '/projects/available' },
  TASK_OPTIONS: { method: 'GET', tail: '/projects/{project}/task-options' },
  NATIVE_SOURCE_TASKS: {method:'GET',tail:'/projects/{project}/native-tasks'},
  NATIVE_TASK_ADOPT: {method:'POST',tail:'/projects/{project}/native-task-adoptions'},
  TASK_CREATE: { method: 'POST', tail: '/tasks' },
  TASKS: { method: 'GET', tail: '/tasks' },
  TASK_REQUEST: { method: 'GET', tail: '/tasks/requests/{requestKey}' },
  TASK: { method: 'GET', tail: '/tasks/{task}' },
  TASK_ACTIVITY: { method: 'GET', tail: '/tasks/{task}/activities' },
  TASK_EVENTS_SUBSCRIBE: { method: 'GET', tail: '/tasks/{task}/activities' },
  TASK_EVENTS_UNSUBSCRIBE: { method: 'GET', tail: '/tasks/{task}/activities' },
  TASK_OUTPUT: { method: 'GET', tail: '/tasks/{task}/output' },
  TASK_METRICS: { method: 'GET', tail: '/tasks/{task}/metrics' },
  TASK_COMMANDS: { method: 'GET', tail: '/tasks/{task}/commands' },
  NATIVE_MESSAGE_CREATE: {method:'POST',tail:'/tasks/{task}/messages'},
  NATIVE_INPUT_RESPONSE: {method:'POST',tail:'/tasks/{task}/input-requests/{entity}/responses'},
  NATIVE_INPUTS: {method:'GET',tail:'/tasks/{task}/input-requests'},
  NATIVE_ARTIFACTS: {method:'GET',tail:'/tasks/{task}/artifacts'},
  NATIVE_ARTIFACT: {method:'GET',tail:'/tasks/{task}/artifacts/{entity}'},
  TASK_COMMAND_CREATE: { method: 'POST', tail: '/tasks/{task}/commands' },
  TASK_INTERACTIONS: {method:'GET',tail:'/tasks/{task}/interactions'},
  TASK_INTERACTION_CATALOG: {method:'GET',tail:'/tasks/{task}/interaction-catalog'},
  TASK_BOUNDARY_CREATE: {method:'POST',tail:'/tasks/{task}/boundary-requests'},
  TASK_SIDE_QUESTION_CREATE: {method:'POST',tail:'/tasks/{task}/side-questions'},
  TASK_HANDOFF_PREFLIGHT: {method:'POST',tail:'/tasks/{task}/handoffs/preflight'},
  TASK_HANDOFF_CREATE: {method:'POST',tail:'/tasks/{task}/handoffs'},
  TASK_APPROVAL_DECISION: {method:'POST',tail:'/tasks/{task}/approvals/{entity}/decisions'},
  TASK_BOUNDARY_CANCEL: {method:'POST',tail:'/tasks/{task}/boundary-requests/{entity}/cancel'},
  TASK_HANDOFF_CANCEL: {method:'POST',tail:'/tasks/{task}/handoffs/{entity}/cancel'},
  TASK_BOUNDARY_RESULT: {method:'GET',tail:'/tasks/{task}/boundary-requests/{entity}'},
  TASK_HANDOFF_RESULT: {method:'GET',tail:'/tasks/{task}/handoffs/{entity}'},
  TASK_ENGAGEMENT: {method:'GET',tail:'/tasks/{task}/interaction-requests/{requestKey}'},
  TASK_APPROVALS: {method:'GET',tail:'/tasks/{task}/approvals'},
  TASK_APPROVAL: {method:'GET',tail:'/tasks/{task}/approvals/{requestKey}'},
  TASK_MESSAGES: { method: 'GET', tail: '/tasks/{task}/messages' },
  TASK_MESSAGE_CREATE: { method: 'POST', tail: '/tasks/{task}/messages' },
  TASK_INTERACTION_REQUEST: { method: 'GET', tail: '/tasks/{task}/interaction-requests/{requestKey}' },
  TASK_COMMAND: { method: 'GET', tail: '/tasks/{task}/commands/{requestKey}' },
  OVERVIEW: { method: 'GET', tail: '/overview' },
  PROJECTS: { method: 'GET', tail: '/projects' },
  REGISTER_PROJECT: { method: 'POST', tail: '/projects' },
  PROJECT: { method: 'GET', tail: '/projects/{project}' },
  PROJECT_ENVIRONMENT: { method: 'GET', tail: '/projects/{project}/environment' },
  ENVIRONMENT_PLAN: { method: 'POST', tail: '/projects/{project}/environment/plans' },
  ENVIRONMENT_OPERATION: { method: 'POST', tail: '/projects/{project}/environment/operations' },
  OPERATION: { method: 'GET', tail: '/environment-operations/{operation}' },
  OPERATION_EVENTS: { method: 'GET', tail: '/environment-operations/{operation}/events' },
  OPERATION_CANCEL: { method: 'POST', tail: '/environment-operations/{operation}/cancel' },
  WORKERS: { method: 'GET', tail: '/workers' },
  WORKER: { method: 'GET', tail: '/workers/{worker}' },
  TASK_ACTIONS: { method: 'GET', tail: '/tasks/{task}/actions' },
  ACTION_RUN: { method: 'POST', tail: '/tasks/{task}/actions/{action}:run' },
  ACTION_SAVE: { method: 'POST', tail: '/tasks/{task}/actions/{action}:save' },
  REPORTS: { method: 'GET', tail: '/reports' },
  REPORT_CREATE: { method: 'POST', tail: '/reports' },
  REPORT: { method: 'GET', tail: '/reports/{report}' },
  REPORT_FILES: { method: 'GET', tail: '/reports/{report}/files' }
};

const ID = PERSONAL_ID_PATTERN;
const DECIMAL = /^(0|[1-9][0-9]{0,18})$/;
const CONTROL = /[\u0000-\u001f\u007f]/;
const BODY_KEYS: Record<string, readonly string[]> = {
  TASK_CREATE: ['requestKey', 'projectId', 'title', 'instruction', 'agentProfileId', 'agentProfileRevision', 'modelSettings', 'engineId', 'optionsRevision', 'executionOptions'],
  TASK_COMMAND_CREATE: ['requestKey', 'targetRunId', 'intent', 'expectedStateVersion'],
  TASK_MESSAGE_CREATE: ['requestKey', 'clientMessageId', 'content', 'expectedSessionVersion'],
  REGISTER_PROJECT: ['requestKey', 'projectRef', 'displayName', 'notes', 'connectionId'],
  ENVIRONMENT_PLAN: ['requestKey', 'expectedRevision', 'preferredBackend', 'toolchainSelections', 'notes'],
  ENVIRONMENT_OPERATION: ['requestKey', 'expectedRevision', 'kind', 'planDigest', 'environmentId', 'environmentRevision'],
  OPERATION_CANCEL: ['requestKey', 'expectedRevision'],
  ACTION_RUN: ['requestKey', 'expectedRevision', 'inputs'],
  ACTION_SAVE: ['requestKey', 'expectedRevision', 'name', 'scope'],
  REPORT_CREATE: ['requestKey', 'sourceRef', 'sourceVersion', 'sourceDigest', 'reportProfileRef', 'providerRef', 'outputFormat', 'dataScope']
};
function boundedText(value: unknown, max: number, multiline = false): boolean {
  return typeof value === 'string' && value.length <= max && (multiline ? !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value) : !CONTROL.test(value));
}
function optionalText(value: unknown, max: number): boolean { return value === undefined || boundedText(value, max); }
function plainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}
function personalBodyValid(action: string, body: unknown): boolean {
  if(action==='NATIVE_TASK_ADOPT')return plainObject(body)&&Object.keys(body).sort().join(',')==='localTaskId,requestKey'&&typeof body.requestKey==='string'&&ID.test(body.requestKey)&&typeof body.localTaskId==='string'&&ID.test(body.localTaskId);
  if(action==='NATIVE_MESSAGE_CREATE') return validNativeInput(body)&&(body.kind==='NATIVE_STEER'||body.kind==='NATIVE_FOLLOW_UP');
  if(action==='NATIVE_INPUT_RESPONSE') return validNativeInput(body)&&body.kind==='INPUT_RESPONSE';
  if (action === 'TASK_COMMAND_CREATE' && validNativeInput(body)) return ['STOP','PAUSE','RESUME'].includes(body.kind);
  const engagementKinds: Record<string,string> = {TASK_BOUNDARY_CREATE:'BOUNDARY',TASK_SIDE_QUESTION_CREATE:'SIDE_QUESTION',TASK_HANDOFF_PREFLIGHT:'PREFLIGHT',TASK_HANDOFF_CREATE:'HANDOFF',TASK_APPROVAL_DECISION:'APPROVAL_DECISION',TASK_BOUNDARY_CANCEL:'CANCEL_BOUNDARY',TASK_HANDOFF_CANCEL:'CANCEL_HANDOFF'};
  if (action in engagementKinds) return validTaskEngagement(body) && body.kind === engagementKinds[action];
  if (!plainObject(body) || Object.keys(body).length > 64) return false;
  const allowed = BODY_KEYS[action];
  if (!allowed || Object.keys(body).some(key => !allowed.includes(key))) return false;
  if (typeof body.requestKey !== 'string' || !ID.test(body.requestKey)) return false;
  if (body.expectedRevision !== undefined && (typeof body.expectedRevision !== 'string' || !DECIMAL.test(body.expectedRevision))) return false;
  switch (action) {
    case 'TASK_CREATE':
      if (body.executionOptions !== undefined) {
        const o = body.executionOptions;
        if (body.engineId !== 'macos' || !plainObject(o) || Object.keys(o).sort().join(',') !== 'accessMode,model' || typeof o.model !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(o.model) || !['READ_ONLY','WORKSPACE'].includes(String(o.accessMode))) return false;
      }
      if (body.engineId !== undefined && (!supportedNativeEngine(body.engineId) || typeof body.optionsRevision !== 'string' || !/^[a-f0-9]{64}$/.test(body.optionsRevision) || body.agentProfileId !== undefined || body.agentProfileRevision !== undefined || body.modelSettings !== undefined)) return false;
      if (body.engineId === undefined && body.optionsRevision !== undefined) return false;
      if (typeof body.projectId !== 'string' || !ID.test(body.projectId) || !optionalText(body.title, 256) || !boundedText(body.instruction, 16384, true) || !String(body.instruction).trim() || new TextEncoder().encode(String(body.instruction)).length > 16384) return false;
      for (const key of ['agentProfileId', 'agentProfileRevision']) if (!optionalText(body[key], 128)) return false;
      if (body.modelSettings !== undefined) {
        const m = body.modelSettings;
        if (!plainObject(m) || Object.keys(m).some(k => !['providerId', 'modelAlias', 'catalogRevision'].includes(k)) || !['providerId', 'modelAlias', 'catalogRevision'].every(k => boundedText(m[k], 256) && !!m[k])) return false;
      }
      return true;
    case 'TASK_MESSAGE_CREATE':
      return typeof body.clientMessageId === 'string' && ID.test(body.clientMessageId)
        && boundedText(body.content, 32768, true) && String(body.content).trim().length > 0
        && new TextEncoder().encode(String(body.content)).length <= 32768
        && typeof body.expectedSessionVersion === 'number' && Number.isSafeInteger(body.expectedSessionVersion) && body.expectedSessionVersion >= 0;
    case 'TASK_COMMAND_CREATE':
      if (body.targetRunId !== undefined && (typeof body.targetRunId !== 'string' || !ID.test(body.targetRunId))) return false;
      // requestKey/intent identity: commandId == requestKey == Idempotency-Key.
      // PAUSE/RESUME carry the source expectedStateVersion (safe integer in
      // 0..2^53-1); STOP accepts a stale version and must not carry one.
      if (body.intent !== 'PAUSE' && body.intent !== 'RESUME' && body.intent !== 'STOP') return false;
      if (body.intent === 'STOP') return body.expectedStateVersion === undefined;
      return typeof body.expectedStateVersion === 'number'
        && Number.isSafeInteger(body.expectedStateVersion)
        && body.expectedStateVersion >= 0
        && body.expectedStateVersion <= 9007199254740991;
    case 'REGISTER_PROJECT':
      if (body.connectionId !== undefined && (typeof body.connectionId !== 'string' || !ID.test(body.connectionId))) return false;
      return typeof body.projectRef === 'string' && ID.test(body.projectRef) && optionalText(body.displayName, 256) && optionalText(body.notes, 4096);
    case 'ENVIRONMENT_PLAN':
      if (body.preferredBackend !== undefined && !ENVIRONMENT_BACKEND_PREFERENCES.includes(body.preferredBackend as EnvironmentBackendPreference)) return false;
      if (!optionalText(body.notes, 4096)) return false;
      return body.toolchainSelections === undefined || (Array.isArray(body.toolchainSelections) && body.toolchainSelections.length <= 32 && body.toolchainSelections.every(sel => plainObject(sel) && Object.keys(sel).every(k => ['tool', 'version', 'source'].includes(k)) && boundedText(sel.tool, 128) && boundedText(sel.version, 128) && optionalText(sel.source, 64)));
    case 'ENVIRONMENT_OPERATION':
      if (typeof body.kind !== 'string' || !ENVIRONMENT_OPERATION_KINDS.includes(body.kind as EnvironmentOperationKind)) return false;
      if (body.planDigest !== undefined && (typeof body.planDigest !== 'string' || !PERSONAL_DIGEST_PATTERN.test(body.planDigest))) return false;
      if (body.environmentId !== undefined && (typeof body.environmentId !== 'string' || !ID.test(body.environmentId))) return false;
      return body.environmentRevision === undefined || (typeof body.environmentRevision === 'string' && DECIMAL.test(body.environmentRevision));
    case 'ACTION_RUN':
      if (body.inputs === undefined) return true;
      try { return plainObject(body.inputs) && Object.keys(body.inputs).length <= 64 && new TextEncoder().encode(JSON.stringify(body.inputs)).length <= 16384; } catch { return false; }
    case 'ACTION_SAVE':
      return optionalText(body.name, 256) && (body.scope === undefined || ADAPTIVE_ACTION_SCOPES.includes(body.scope as AdaptiveActionScope));
    case 'REPORT_CREATE':
      if (!boundedText(body.sourceRef, 512)) return false;
      for (const field of ['sourceVersion', 'outputFormat'] as const) if (!optionalText(body[field], 128)) return false;
      for (const field of ['reportProfileRef', 'providerRef'] as const) if (!optionalText(body[field], 512)) return false;
      if (body.sourceDigest !== undefined && (typeof body.sourceDigest !== 'string' || !PERSONAL_DIGEST_PATTERN.test(body.sourceDigest))) return false;
      return body.dataScope === undefined || (Array.isArray(body.dataScope) && body.dataScope.length <= 64 && body.dataScope.every(item => boundedText(item, 256)));
    default:
      return true;
  }
}
export function validPersonalOperation(input: unknown): input is PersonalOperation {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return false;
  const value = input as Record<string, unknown>; const action = value.action;
  if (typeof action !== 'string' || !Object.hasOwn(PERSONAL_ROUTES, action)) return false;
  const route = PERSONAL_ROUTES[action as PersonalOperation['action']]; const keys = ['action'];
  for (const [marker, field] of [['{project}', 'projectId'], ['{operation}', 'operationId'], ['{worker}', 'workerId'], ['{task}', 'taskId'], ['{action}', 'actionId'], ['{report}', 'reportId'], ['{requestKey}', 'requestKey'], ['{entity}', 'entityId']] as const) {
    if (route.tail.includes(marker)) { if (typeof value[field] !== 'string' || !ID.test(value[field])) return false; keys.push(field); }
  }
  if (route.method === 'POST') {
    if (typeof value.key !== 'string' || !ID.test(value.key) || !personalBodyValid(action, value.body)) return false;
    if ((value.body as Record<string, unknown>).requestKey !== value.key) return false;
    if(action==='NATIVE_INPUT_RESPONSE' && (value.body as Record<string,unknown>).inputRequestId!==value.entityId) return false;
    if (action!=='NATIVE_INPUT_RESPONSE' && route.tail.includes('{entity}') && (value.body as Record<string,unknown>).resourceId !== value.entityId && (value.body as Record<string,unknown>).approvalId !== value.entityId) return false;
    keys.push('key', 'body');
  } else if (value.key !== undefined || value.body !== undefined) return false;
  if (action === 'OPERATION_EVENTS' || action === 'TASKS' || action === 'TASK_MESSAGES' || action === 'TASK_APPROVALS' || action === 'TASK_INTERACTIONS') {
    keys.push('cursor', 'limit');
    if (value.cursor !== undefined && (typeof value.cursor !== 'string' || value.cursor.length > 1024 || CONTROL.test(value.cursor))) return false;
    if (value.limit !== undefined && (typeof value.limit !== 'string' || !DECIMAL.test(value.limit) || BigInt(value.limit) < 1n || BigInt(value.limit) > 256n)) return false;
  }
  if (['TASK', 'TASK_OUTPUT', 'TASK_METRICS', 'TASK_ACTIVITY', 'TASK_COMMANDS', 'TASK_INTERACTIONS', 'TASK_INTERACTION_CATALOG', 'TASK_BOUNDARY_RESULT', 'TASK_HANDOFF_RESULT'].includes(action)) {
    keys.push('runId');
    if (value.runId !== undefined && (typeof value.runId !== 'string' || !ID.test(value.runId))) return false;
  }
  if (action === 'TASK_MESSAGES') {
    // native-messages/1 paging (design §5.3/§8.1): `before` is a canonical
    // decimal i64 sequence bound and is mutually exclusive with `cursor`;
    // the page limit matches the Host's 1..100. `cursor` intentionally stays
    // a bounded opaque string at this layer — the same operation also serves
    // the ACS session backend whose signed h1.* tokens are backend-specific,
    // so decimal sequence enforcement lives in the native read path.
    keys.push('before');
    if (value.limit !== undefined && BigInt(String(value.limit)) > 100n) return false;
    if (value.before !== undefined && (typeof value.before !== 'string' || !DECIMAL.test(value.before) || BigInt(value.before) < 1n || BigInt(value.before) > 9223372036854775807n)) return false;
    if (value.cursor !== undefined && value.before !== undefined) return false;
  }
  if (action === 'TASK_ACTIVITY') {
    keys.push('afterCursor', 'limit');
    if (value.afterCursor !== undefined && (typeof value.afterCursor !== 'string' || !DECIMAL.test(value.afterCursor))) return false;
    if (value.limit !== undefined && (typeof value.limit !== 'string' || !DECIMAL.test(value.limit) || BigInt(value.limit) < 1n || BigInt(value.limit) > 100n)) return false;
  }
  if (action === 'TASK_EVENTS_SUBSCRIBE') {
    // Resume cursor is the same bounded decimal event sequence the activity
    // leaf already accepts; Electron main mirrors it into Last-Event-ID.
    keys.push('afterCursor');
    if (value.afterCursor !== undefined && (typeof value.afterCursor !== 'string' || !DECIMAL.test(value.afterCursor))) return false;
  }
  if (action === 'TASK_COMMANDS') {
    keys.push('limit', 'before');
    if (value.limit !== undefined && (typeof value.limit !== 'string' || !DECIMAL.test(value.limit) || BigInt(value.limit) < 1n || BigInt(value.limit) > 100n)) return false;
    // before is a source commandId passthrough — it may contain ':' and so
    // intentionally does not use the stricter PERSONAL_ID_PATTERN.
    if (value.before !== undefined && (typeof value.before !== 'string' || value.before.length > 128 || CONTROL.test(value.before))) return false;
  }
  if (action === 'NATIVE_ARTIFACT' && !/^file-[a-f0-9]{64}$/.test(String(value.entityId))) return false;
  if (Object.keys(value).some(key => !keys.includes(key))) return false;
  try { return new TextEncoder().encode(JSON.stringify(value)).length <= 65536; } catch { return false; }
}
/** Envelope guard: meta+data presence only; consumers degrade absent members
 * instead of misjudging freshness or authority (validators.ts precedent). */
export function validPersonalEnvelope(input: unknown): input is PersonalEnvelope<unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return false;
  const meta = (input as Record<string, unknown>).meta;
  return !!meta && typeof meta === 'object' && !Array.isArray(meta) && 'data' in (input as Record<string, unknown>);
}
/** Decode the frozen {error:{code,message,retryable,requestId}} shape. */
export function decodePersonalError(payload: unknown): PersonalErrorBody | undefined {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return undefined;
  const error = (payload as Record<string, unknown>).error;
  if (!error || typeof error !== 'object' || Array.isArray(error)) return undefined;
  const body = error as Record<string, unknown>;
  if (typeof body.code !== 'string' || body.code.length === 0) return undefined;
  return {
    code: body.code,
    message: typeof body.message === 'string' ? body.message : undefined,
    retryable: typeof body.retryable === 'boolean' ? body.retryable : undefined,
    requestId: typeof body.requestId === 'string' ? body.requestId : undefined
  };
}
