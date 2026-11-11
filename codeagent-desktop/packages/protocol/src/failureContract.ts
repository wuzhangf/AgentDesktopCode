/**
 * Client-side wire types and safe presentation rules for Failure Contract v1.
 *
 * The service remains authoritative. This module only decodes bounded public
 * fields and decides which already-authorized UI actions may be shown.
 */

export type ExtensibleString<Known extends string> = Known | (string & {});

export type FailureCode =
  | 'MODEL_TOOL_ARGUMENTS_INVALID'
  | 'MODEL_RESPONSE_INCOMPLETE'
  | 'MODEL_STREAM_TERMINATOR_MISSING'
  | 'PATH_OUTSIDE_WORKSPACE'
  | 'RUN_DEADLINE_REACHED'
  | 'TIMEOUT'
  | 'NON_ZERO_EXIT'
  | 'EXECUTABLE_DENIED'
  | 'COMMAND_POLICY_DENIED'
  | 'WORKSPACE_PATH_DENIED'
  | 'SHELL_UNAVAILABLE_ON_PLATFORM'
  | 'EXECUTABLE_NOT_FOUND'
  | 'COMMAND_APPROVAL_FAILED'
  | 'COMMAND_APPROVAL_INVALID'
  | 'COMMAND_APPROVAL_TIMED_OUT'
  | 'COMMAND_DENIED_BY_USER'
  | 'SEMANTIC_NOT_CONFIGURED'
  | 'SEMANTIC_REQUIRED_UNAVAILABLE'
  | 'SEMANTIC_REQUIRED_NOT_JAVA_WORKSPACE'
  | 'SEMANTIC_START_FAILED'
  | 'SEMANTIC_IMPORT_TIMEOUT'
  | 'SEMANTIC_QUERY_TIMEOUT'
  | 'SEMANTIC_PROCESS_EXITED'
  | 'SEMANTIC_INVALID_LOCATION'
  | 'SEMANTIC_UNAVAILABLE'
  | 'MODEL_TOOL_NOT_DECLARED'
  | 'MODEL_TOOL_CALL_ID_INVALID'
  | 'MODEL_TOOL_CALL_COUNT_EXCEEDED'
  | 'MODEL_STRUCTURED_OUTPUT_INVALID'
  | 'MODEL_RESPONSE_PARSE'
  | 'MODEL_PROTOCOL_REGENERATION_EXHAUSTED'
  | 'MODEL_FINAL_OUTPUT_MISSING'
  | 'PREFLIGHT_FILE_NOT_FOUND'
  | 'ABSOLUTE_PATH_NOT_ALLOWED'
  | 'PROTECTED_PATH'
  | 'MESSAGE_ROLE_INVALID'
  | 'CONTEXT_INPUT_TOOL_PAIRING_INVALID'
  | 'CONTEXT_COMPACTION_TOOL_PAIRING_INVALID'
  | 'MODEL_REQUEST_FINAL_TOOL_PAIRING_INVALID'
  | 'INPUT_CONTEXT_INTEGRITY_FAILED'
  | 'CHECKPOINT_CONVERSATION_INCOMPLETE'
  | 'PROMPT_CONTEXT_BUDGET_EXCEEDED'
  | 'CONTEXT_BUDGET_EXCEEDED'
  | 'CONTEXT_COMPACTION_NO_EFFECT'
  | 'MODEL_CALL_BUDGET_EXHAUSTED'
  | 'EDIT_ATTEMPT_BUDGET_EXHAUSTED'
  | 'MAX_STEPS_REACHED'
  | 'PROVIDER_PAUSED'
  | 'MODIFICATION_FAILED'
  | 'WORKSPACE_LEASE_LOST'
  | 'PENDING_MUTATION_RECONCILIATION_REQUIRED'
  | 'VERIFICATION_FAILED'
  | 'CAUSAL_VERIFICATION_BLOCKED'
  | 'NO_PROGRESS_BLOCKED'
  | 'CONTEXT_COMPACTION_FAILED'
  | 'CANCELLED'
  | 'BUDGET_APPROVAL_REQUIRED'
  | 'INTERRUPTED_FOR_HUMAN'
  | 'STAGE_BASELINE_MISMATCH'
  | 'PROVIDER_ERROR_UNCLASSIFIED'
  | 'INTERNAL_FAILURE_UNCLASSIFIED'
  | 'RUNTIME_ERROR';

export type FailureDomain =
  | 'MODEL_AUTH'
  | 'MODEL_RATE_LIMIT'
  | 'MODEL_TRANSPORT'
  | 'MODEL_PROTOCOL'
  | 'CONTEXT'
  | 'TOOL_INPUT'
  | 'TOOL_EXECUTION'
  | 'WORKSPACE_SCOPE'
  | 'PERMISSION'
  | 'BUDGET'
  | 'VERIFICATION'
  | 'SERVICE_TRANSPORT'
  | 'CLIENT_PROTOCOL'
  | 'ENVIRONMENT'
  | 'INTERNAL';

export type FailurePhase =
  | 'ADMISSION'
  | 'PREPARE'
  | 'REQUEST'
  | 'RECEIVE'
  | 'VALIDATE'
  | 'EXECUTE'
  | 'VERIFY'
  | 'PERSIST'
  | 'PROJECT'
  | 'DELIVER';

export type FailureDisposition =
  | 'AUTO_RECOVERING'
  | 'USER_ACTION_REQUIRED'
  | 'OPERATOR_ACTION_REQUIRED'
  | 'TERMINAL';

export type EffectState = 'NOT_APPLIED' | 'APPLIED' | 'UNKNOWN';

export type RecoveryMode =
  | 'NONE'
  | 'MODEL_REPAIR_INPUT'
  | 'NEW_MODEL_ATTEMPT'
  | 'RESUME_CHECKPOINT'
  | 'RETRY_OPERATION'
  | 'RECONCILE_THEN_RETRY';

export type RecoveryActor = 'RUNTIME' | 'MODEL' | 'USER' | 'OPERATOR';

export interface RecoveryDirective {
  mode: RecoveryMode;
  actor: RecoveryActor;
  automatic: boolean;
  sameInputAllowed: boolean;
  attemptsUsed: number;
  maxAttempts: number;
  retryAfterMillis?: number | null;
  checkpointRef?: string | null;
  reconcileRef?: string | null;
  actionIds: string[];
}

export interface SafeFailureContext {
  correlationId?: string;
  providerRequestId?: string;
  clientRequestId?: string;
  runId?: string;
  activityId?: string;
  toolCallId?: string;
  toolName?: string;
  capabilityId?: string;
  transport?: string;
  dialect?: string;
  finishReason?: string;
  httpStatus?: number;
  failureStage?: string;
  fieldName?: string;
  argumentCharsObserved?: number;
  outputTokens?: number;
  pathRef?: string;
  policyRevision?: string;
  catalogVersion?: string;
  traceRef?: string;
}

export interface FailureCause {
  code: string;
  message?: string;
}

export interface FailureDescriptor {
  schemaVersion: string;
  code: ExtensibleString<FailureCode>;
  /** Unknown forward enum values are degraded, never used to authorize an action. */
  domain: FailureDomain | 'UNKNOWN';
  phase: FailurePhase | 'UNKNOWN';
  disposition: FailureDisposition | 'UNKNOWN';
  effectState: EffectState;
  safeMessage: string;
  recovery: RecoveryDirective;
  context?: SafeFailureContext;
  causes: FailureCause[];
}

export interface AgentUiFailure extends FailureDescriptor {
  catalogKnown: boolean;
}

export type RunSchedulingState =
  | 'ACCEPTED'
  | 'ELIGIBLE'
  | 'CLAIMING_RESOURCES'
  | 'DISPATCH_PENDING'
  | 'DISPATCHED'
  | 'SUSPENDED'
  | 'RECOVERING'
  | 'TERMINAL';

export type RunQueueReason =
  | 'GLOBAL_CAPACITY'
  | 'PROJECT_CAPACITY'
  | 'SESSION_ACTIVE_RUN'
  | 'CHECKOUT_WRITER_BUSY'
  | 'WORKTREE_PROVISIONING'
  | 'WORKTREE_CAPACITY'
  | 'MODEL_CAPACITY'
  | 'PROCESS_CAPACITY'
  | 'BUILD_CAPACITY'
  | 'PORT_NAMESPACE_UNAVAILABLE'
  | 'PROVIDER_BACKOFF'
  | 'SERVICE_DRAINING'
  | 'RECOVERY_BARRIER'
  | 'SESSION_ACTIVE_RUN_EXISTS'
  | 'RUN_QUEUE_FULL'
  | 'PROJECT_QUEUE_FULL'
  | 'RESOURCE_CAPACITY_EXHAUSTED'
  | 'DIRTY_BASELINE_REQUIRES_DECISION'
  | 'NON_GIT_WRITE_ISOLATION_UNAVAILABLE'
  | 'WORKTREE_PROVISION_FAILED'
  | 'STALE_WORKSPACE_EPOCH'
  | 'DISPATCH_ACK_TIMEOUT'
  | 'EXECUTION_OUTCOME_UNKNOWN'
  | 'CHECKPOINT_NOT_RESUMABLE'
  | 'EFFECTIVE_CONFIG_CHANGED'
  | 'RUNTIME_PROVENANCE_MISMATCH'
  | 'CONFIGURATION_CONFLICT'
  | 'PRODUCT_SUSPENDABLE_EXECUTION_UNAVAILABLE'
  | 'WAITING_APPROVAL_HOLDING_SLOT';

export interface RunSchedulingProjection {
  schemaVersion?: string;
  runId?: string | null;
  state?: RunSchedulingState | 'UNKNOWN';
  primaryReason?: ExtensibleString<RunQueueReason> | null;
  secondaryReasons: Array<ExtensibleString<RunQueueReason>>;
  queuePosition?: number | null;
  approximate?: boolean;
  admittedAt?: string | null;
  eligibleAt?: string | null;
  lastProgressAt?: string | null;
  executionMode?: string | null;
  workspaceRef?: string | null;
  activeClaims: string[];
}

export type OperationOutcome = 'NOT_APPLIED' | 'APPLIED' | 'UNKNOWN';

const FAILURE_CODES = new Set<string>([
  'MODEL_TOOL_ARGUMENTS_INVALID',
  'MODEL_RESPONSE_INCOMPLETE',
  'MODEL_STREAM_TERMINATOR_MISSING',
  'PATH_OUTSIDE_WORKSPACE',
  'RUN_DEADLINE_REACHED', 'TIMEOUT', 'NON_ZERO_EXIT',
  'EXECUTABLE_DENIED', 'COMMAND_POLICY_DENIED', 'WORKSPACE_PATH_DENIED',
  'SHELL_UNAVAILABLE_ON_PLATFORM', 'EXECUTABLE_NOT_FOUND',
  'COMMAND_APPROVAL_FAILED', 'COMMAND_APPROVAL_INVALID',
  'COMMAND_APPROVAL_TIMED_OUT', 'COMMAND_DENIED_BY_USER',
  'SEMANTIC_NOT_CONFIGURED', 'SEMANTIC_REQUIRED_UNAVAILABLE',
  'SEMANTIC_REQUIRED_NOT_JAVA_WORKSPACE', 'SEMANTIC_START_FAILED',
  'SEMANTIC_IMPORT_TIMEOUT', 'SEMANTIC_QUERY_TIMEOUT',
  'SEMANTIC_PROCESS_EXITED', 'SEMANTIC_INVALID_LOCATION',
  'SEMANTIC_UNAVAILABLE', 'MODEL_TOOL_NOT_DECLARED',
  'MODEL_TOOL_CALL_ID_INVALID', 'MODEL_TOOL_CALL_COUNT_EXCEEDED',
  'MODEL_STRUCTURED_OUTPUT_INVALID', 'MODEL_RESPONSE_PARSE',
  'MODEL_PROTOCOL_REGENERATION_EXHAUSTED', 'MODEL_FINAL_OUTPUT_MISSING',
  'PREFLIGHT_FILE_NOT_FOUND', 'ABSOLUTE_PATH_NOT_ALLOWED', 'PROTECTED_PATH',
  'MESSAGE_ROLE_INVALID', 'CONTEXT_INPUT_TOOL_PAIRING_INVALID',
  'CONTEXT_COMPACTION_TOOL_PAIRING_INVALID',
  'MODEL_REQUEST_FINAL_TOOL_PAIRING_INVALID', 'INPUT_CONTEXT_INTEGRITY_FAILED',
  'CHECKPOINT_CONVERSATION_INCOMPLETE', 'PROMPT_CONTEXT_BUDGET_EXCEEDED',
  'CONTEXT_BUDGET_EXCEEDED', 'CONTEXT_COMPACTION_NO_EFFECT',
  'MODEL_CALL_BUDGET_EXHAUSTED', 'EDIT_ATTEMPT_BUDGET_EXHAUSTED',
  'MAX_STEPS_REACHED', 'PROVIDER_PAUSED', 'MODIFICATION_FAILED',
  'WORKSPACE_LEASE_LOST', 'RESOURCE_BUSY', 'RESOURCE_CAPACITY',
  'RESOURCE_NAMESPACE_BUSY', 'RESOURCE_LOCK_UNAVAILABLE',
  'WORKSPACE_WRITER_EXISTS', 'WORKSPACE_LOCKED', 'WORKSPACE_LEASE_BUSY',
  'EXECUTION_OUTCOME_UNKNOWN',
  'PENDING_MUTATION_RECONCILIATION_REQUIRED',
  'VERIFICATION_FAILED', 'CAUSAL_VERIFICATION_BLOCKED', 'NO_PROGRESS_BLOCKED',
  'CONTEXT_COMPACTION_FAILED', 'CANCELLED', 'BUDGET_APPROVAL_REQUIRED',
  'INTERRUPTED_FOR_HUMAN', 'STAGE_BASELINE_MISMATCH',
  'PROVIDER_ERROR_UNCLASSIFIED',
  'INTERNAL_FAILURE_UNCLASSIFIED',
  'RUNTIME_ERROR'
]);

const FAILURE_DOMAINS = new Set<FailureDomain>([
  'MODEL_AUTH', 'MODEL_RATE_LIMIT', 'MODEL_TRANSPORT', 'MODEL_PROTOCOL',
  'CONTEXT', 'TOOL_INPUT', 'TOOL_EXECUTION', 'WORKSPACE_SCOPE', 'PERMISSION',
  'BUDGET', 'VERIFICATION', 'SERVICE_TRANSPORT', 'CLIENT_PROTOCOL',
  'ENVIRONMENT', 'INTERNAL'
]);
const FAILURE_PHASES = new Set<FailurePhase>([
  'ADMISSION', 'PREPARE', 'REQUEST', 'RECEIVE', 'VALIDATE', 'EXECUTE',
  'VERIFY', 'PERSIST', 'PROJECT', 'DELIVER'
]);
const FAILURE_DISPOSITIONS = new Set<FailureDisposition>([
  'AUTO_RECOVERING', 'USER_ACTION_REQUIRED', 'OPERATOR_ACTION_REQUIRED', 'TERMINAL'
]);
const RECOVERY_MODES = new Set<RecoveryMode>([
  'NONE', 'MODEL_REPAIR_INPUT', 'NEW_MODEL_ATTEMPT', 'RESUME_CHECKPOINT',
  'RETRY_OPERATION', 'RECONCILE_THEN_RETRY'
]);
const RECOVERY_ACTORS = new Set<RecoveryActor>(['RUNTIME', 'MODEL', 'USER', 'OPERATOR']);
const SCHEDULING_STATES = new Set<RunSchedulingState>([
  'ACCEPTED', 'ELIGIBLE', 'CLAIMING_RESOURCES', 'DISPATCH_PENDING',
  'DISPATCHED', 'SUSPENDED', 'RECOVERING', 'TERMINAL'
]);

/** Actions are identifiers, never service-provided labels, URLs or commands. */
export const SAFE_FAILURE_ACTION_IDS = [
  'CANCEL_RECOVERY',
  'CHECK_EXECUTION_RESULT',
  'CONTINUE_RESPONSE',
  'COPY_DIAGNOSTIC',
  'EDIT_TOOL_INPUT',
  'NEW_MODEL_ATTEMPT',
  'OPEN_TRACE',
  'RECONCILE',
  'RETRY_OPERATION',
  'RETRY_WITH_RECONCILIATION',
  'RESUME_CHECKPOINT',
  'SHOW_TOOL_DETAILS'
] as const;

export type SafeFailureActionId = (typeof SAFE_FAILURE_ACTION_IDS)[number];

const SAFE_FAILURE_ACTION_SET = new Set<string>(SAFE_FAILURE_ACTION_IDS);
const MAX_TEXT = 512;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function boundedString(value: unknown, max = MAX_TEXT): string | undefined {
  if (typeof value !== 'string' || value.trim().length === 0) return undefined;
  return value.slice(0, max);
}

function nonNegativeInteger(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

function enumValue<T extends string>(value: unknown, values: ReadonlySet<T>): T | 'UNKNOWN' {
  return typeof value === 'string' && values.has(value as T) ? value as T : 'UNKNOWN';
}

function decodeContext(value: unknown): SafeFailureContext | undefined {
  if (!isRecord(value)) return undefined;
  const context: Record<string, string | number> = {};
  const stringFields: Array<keyof SafeFailureContext> = [
    'correlationId', 'providerRequestId', 'clientRequestId', 'runId', 'activityId',
    'toolCallId', 'toolName', 'capabilityId', 'transport', 'dialect', 'finishReason',
    'failureStage', 'fieldName', 'pathRef', 'policyRevision', 'catalogVersion', 'traceRef'
  ];
  for (const field of stringFields) {
    const valueForField = boundedString(value[field]);
    if (valueForField !== undefined) context[field] = valueForField;
  }
  const argumentCharsObserved = nonNegativeInteger(value.argumentCharsObserved, -1);
  if (argumentCharsObserved >= 0) context.argumentCharsObserved = argumentCharsObserved;
  const outputTokens = nonNegativeInteger(value.outputTokens, -1);
  if (outputTokens >= 0) context.outputTokens = outputTokens;
  const httpStatus = nonNegativeInteger(value.httpStatus, -1);
  if (httpStatus >= 100 && httpStatus <= 599) context.httpStatus = httpStatus;
  return Object.keys(context).length > 0 ? context : undefined;
}

function decodeRecovery(value: unknown, effectState: EffectState): RecoveryDirective {
  const raw = isRecord(value) ? value : {};
  const mode = enumValue(raw.mode, RECOVERY_MODES);
  const actor = enumValue(raw.actor, RECOVERY_ACTORS);
  const attemptsUsed = nonNegativeInteger(raw.attemptsUsed, 0);
  const maxAttempts = Math.max(attemptsUsed, nonNegativeInteger(raw.maxAttempts, 0));
  const retryAfterMillis = typeof raw.retryAfterMillis === 'number'
    && Number.isSafeInteger(raw.retryAfterMillis) && raw.retryAfterMillis >= 0
    ? raw.retryAfterMillis : undefined;
  const actionIds = Array.isArray(raw.actionIds)
    ? raw.actionIds
      .map((action) => boundedString(action, 128))
      .filter((action): action is string => action !== undefined)
      .slice(0, 16)
    : [];
  // Unknown/invalid recovery data is deliberately reduced to a terminal-safe
  // no-op. automatic recovery can never be enabled for UNKNOWN effects.
  const automatic = raw.automatic === true && effectState === 'NOT_APPLIED';
  return {
    mode: mode === 'UNKNOWN' ? 'NONE' : mode,
    actor: actor === 'UNKNOWN' ? 'RUNTIME' : actor,
    automatic,
    sameInputAllowed: raw.sameInputAllowed === true,
    attemptsUsed,
    maxAttempts,
    ...(retryAfterMillis !== undefined ? { retryAfterMillis } : {}),
    ...(boundedString(raw.checkpointRef) !== undefined ? { checkpointRef: boundedString(raw.checkpointRef) } : {}),
    ...(boundedString(raw.reconcileRef) !== undefined ? { reconcileRef: boundedString(raw.reconcileRef) } : {}),
    actionIds
  };
}

/** Decode only the public Failure Contract fields; arbitrary maps are dropped. */
export function decodeFailure(value: unknown): FailureDescriptor | undefined {
  if (!isRecord(value)) return undefined;
  const code = boundedString(value.code, 128);
  if (code === undefined) return undefined;
  const effectState: EffectState = value.effectState === 'NOT_APPLIED'
    || value.effectState === 'APPLIED' || value.effectState === 'UNKNOWN'
    ? value.effectState : 'UNKNOWN';
  const causes = Array.isArray(value.causes)
    ? value.causes.slice(0, 4).flatMap((cause): FailureCause[] => {
      if (!isRecord(cause)) return [];
      const causeCode = boundedString(cause.code, 128);
      if (causeCode === undefined) return [];
      const message = boundedString(cause.message, 512);
      return [{ code: causeCode, ...(message !== undefined ? { message } : {}) }];
    })
    : [];
  return {
    schemaVersion: boundedString(value.schemaVersion, 32) ?? '1',
    code: code as ExtensibleString<FailureCode>,
    domain: enumValue(value.domain, FAILURE_DOMAINS),
    phase: enumValue(value.phase, FAILURE_PHASES),
    disposition: enumValue(value.disposition, FAILURE_DISPOSITIONS),
    effectState,
    safeMessage: boundedString(value.safeMessage, 2000) ?? '执行失败，详情待确认。',
    recovery: decodeRecovery(value.recovery, effectState),
    context: decodeContext(value.context),
    causes
  };
}

export function toAgentUiFailure(value: FailureDescriptor): AgentUiFailure {
  return { ...value, catalogKnown: isKnownFailureCode(value.code) };
}

export function isKnownFailureCode(code: string): boolean {
  return FAILURE_CODES.has(code);
}

/** Decode the additive scheduling projection while retaining unknown reason codes. */
export function decodeScheduling(value: unknown): RunSchedulingProjection | undefined {
  if (!isRecord(value)) return undefined;
  const queuePosition = typeof value.queuePosition === 'number'
    && Number.isSafeInteger(value.queuePosition) && value.queuePosition >= 0
    ? value.queuePosition : undefined;
  const secondaryReasons = Array.isArray(value.secondaryReasons)
    ? value.secondaryReasons
      .map((reason) => boundedString(reason, 128))
      .filter((reason): reason is string => reason !== undefined)
      .slice(0, 16) as Array<ExtensibleString<RunQueueReason>>
    : [];
  const activeClaims = Array.isArray(value.activeClaims)
    ? value.activeClaims
      .map((claim) => boundedString(claim, 256))
      .filter((claim): claim is string => claim !== undefined)
      .slice(0, 32)
    : [];
  const primaryReason = boundedString(value.primaryReason, 128);
  return {
    ...(boundedString(value.schemaVersion, 32) !== undefined ? { schemaVersion: boundedString(value.schemaVersion, 32) } : {}),
    ...(boundedString(value.runId) !== undefined ? { runId: boundedString(value.runId) } : {}),
    ...(SCHEDULING_STATES.has(value.state as RunSchedulingState)
      ? { state: value.state as RunSchedulingState }
      : value.state !== undefined ? { state: 'UNKNOWN' as const } : {}),
    ...(primaryReason !== undefined ? { primaryReason: primaryReason as ExtensibleString<RunQueueReason> } : {}),
    secondaryReasons,
    ...(queuePosition !== undefined ? { queuePosition } : {}),
    ...(typeof value.approximate === 'boolean' ? { approximate: value.approximate } : {}),
    ...(boundedString(value.admittedAt) !== undefined ? { admittedAt: boundedString(value.admittedAt) } : {}),
    ...(boundedString(value.eligibleAt) !== undefined ? { eligibleAt: boundedString(value.eligibleAt) } : {}),
    ...(boundedString(value.lastProgressAt) !== undefined ? { lastProgressAt: boundedString(value.lastProgressAt) } : {}),
    ...(boundedString(value.executionMode) !== undefined ? { executionMode: boundedString(value.executionMode) } : {}),
    ...(boundedString(value.workspaceRef) !== undefined ? { workspaceRef: boundedString(value.workspaceRef) } : {}),
    activeClaims
  };
}

export interface FailurePresentationDecision {
  catalogKnown: boolean;
  headline: string;
  detail: string;
  effectState: EffectState;
  actionIds: SafeFailureActionId[];
  showRetry: boolean;
  showReconcile: boolean;
  showCancelRecovery: boolean;
}

function headlineFor(code: string, catalogKnown: boolean): string {
  if (!catalogKnown) return '发生未识别的执行错误';
  switch (code) {
    case 'MODEL_TOOL_ARGUMENTS_INVALID': return '工具参数无法使用';
    case 'MODEL_RESPONSE_INCOMPLETE': return '模型响应不完整';
    case 'MODEL_STREAM_TERMINATOR_MISSING': return '模型响应未正常结束';
    case 'PATH_OUTSIDE_WORKSPACE': return '目标路径不在工作区范围内';
    case 'NON_ZERO_EXIT': return '命令执行失败';
    case 'TIMEOUT': return '命令执行超时';
    case 'RUN_DEADLINE_REACHED': return '运行达到时间限制';
    case 'COMMAND_POLICY_DENIED': return '命令被执行策略拒绝';
    case 'EXECUTABLE_NOT_FOUND': return '找不到要执行的程序';
    case 'SHELL_UNAVAILABLE_ON_PLATFORM': return '当前平台不支持该 Shell';
    case 'SEMANTIC_NOT_CONFIGURED':
    case 'SEMANTIC_REQUIRED_UNAVAILABLE': return 'Java 语义能力不可用';
    case 'PROVIDER_ERROR_UNCLASSIFIED': return '模型服务返回了未分类错误';
    case 'RESOURCE_BUSY':
    case 'RESOURCE_CAPACITY':
    case 'RESOURCE_NAMESPACE_BUSY':
    case 'RESOURCE_LOCK_UNAVAILABLE':
    case 'WORKSPACE_WRITER_EXISTS':
    case 'WORKSPACE_LOCKED':
    case 'WORKSPACE_LEASE_BUSY': return '工作区资源暂时不可用';
    case 'EXECUTION_OUTCOME_UNKNOWN': return '执行结果未确认';
    case 'RUNTIME_ERROR': return '执行失败';
    default: return '执行失败';
  }
}

function hasAction(actions: ReadonlySet<SafeFailureActionId>, ...ids: SafeFailureActionId[]): boolean {
  return ids.some((id) => actions.has(id));
}

/**
 * Decide presentation from typed service facts only. HTTP status and message
 * are intentionally absent from this function.
 */
export function decideFailurePresentation(
  failure: FailureDescriptor | AgentUiFailure | null | undefined
): FailurePresentationDecision {
  const decoded = failure === undefined || failure === null ? undefined : failure;
  const catalogKnown = decoded !== undefined && isKnownFailureCode(decoded.code);
  if (decoded === undefined) {
    return {
      catalogKnown: false,
      headline: '请求失败',
      detail: '请求未能完成。',
      effectState: 'UNKNOWN',
      actionIds: [],
      showRetry: false,
      showReconcile: false,
      showCancelRecovery: false
    };
  }
  const actionIds = decoded.recovery.actionIds
    .filter((id): id is SafeFailureActionId => SAFE_FAILURE_ACTION_SET.has(id)) as SafeFailureActionId[];
  const actions = new Set<SafeFailureActionId>(actionIds);
  const safeForRetry = catalogKnown
    && decoded.effectState === 'NOT_APPLIED'
    && decoded.disposition === 'USER_ACTION_REQUIRED'
    && (decoded.recovery.actor === 'RUNTIME' || decoded.recovery.actor === 'USER')
    && !decoded.recovery.automatic;
  const showRetry = safeForRetry && (
    (decoded.recovery.mode === 'RETRY_OPERATION' && hasAction(actions, 'RETRY_OPERATION'))
    || (decoded.recovery.mode === 'NEW_MODEL_ATTEMPT' && hasAction(actions, 'NEW_MODEL_ATTEMPT', 'CONTINUE_RESPONSE', 'RETRY_OPERATION'))
    || (decoded.recovery.mode === 'RESUME_CHECKPOINT' && hasAction(actions, 'RESUME_CHECKPOINT'))
  );
  return {
    catalogKnown,
    headline: headlineFor(decoded.code, catalogKnown),
    detail: decoded.safeMessage,
    effectState: decoded.effectState,
    actionIds,
    showRetry,
    showReconcile: decoded.effectState === 'UNKNOWN'
      && decoded.recovery.mode === 'RECONCILE_THEN_RETRY'
      && hasAction(actions, 'CHECK_EXECUTION_RESULT', 'RECONCILE', 'RETRY_WITH_RECONCILIATION'),
    showCancelRecovery: decoded.disposition === 'AUTO_RECOVERING'
      && hasAction(actions, 'CANCEL_RECOVERY')
  };
}

/** Compatibility-only projection; unknown code/effect is never retryable. */
export function legacyRetryableFromFailure(failure: FailureDescriptor | undefined): boolean {
  if (failure === undefined || !isKnownFailureCode(failure.code)) return false;
  return failure.effectState === 'NOT_APPLIED'
    && failure.disposition === 'USER_ACTION_REQUIRED'
    && !failure.recovery.automatic
    && (failure.recovery.mode === 'NEW_MODEL_ATTEMPT'
      || failure.recovery.mode === 'RETRY_OPERATION'
      || failure.recovery.mode === 'RESUME_CHECKPOINT')
    && (failure.recovery.actor === 'RUNTIME' || failure.recovery.actor === 'USER');
}
