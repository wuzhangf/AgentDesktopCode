/**
 * Runtime schema validation for key responses (desktop design §9.1).
 * Unknown enum values degrade to UNKNOWN; malformed payloads fail closed
 * with a typed error instead of misjudging permissions or terminal state.
 */

import type { components } from './openapi-schema.gen';
import {
  decodeFailure,
  decodeScheduling,
  type FailureDescriptor,
  type EffectState,
  type OperationOutcome,
  type RunSchedulingProjection
} from './failureContract';

export class ProtocolValidationError extends Error {
  constructor(
    public readonly schema: string,
    message: string
  ) {
    super(message);
    this.name = 'ProtocolValidationError';
  }
}

function requireObject(schema: string, value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ProtocolValidationError(schema, 'payload is not an object');
  }
  return value as Record<string, unknown>;
}

function requireString(schema: string, value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ProtocolValidationError(schema, `${field} must be a non-empty string`);
  }
  return value;
}

function optionalString(schema: string, value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    throw new ProtocolValidationError(schema, `${field} must be a string when present`);
  }
  return value;
}

function requireBoolean(schema: string, value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') {
    throw new ProtocolValidationError(schema, `${field} must be a boolean`);
  }
  return value;
}

function requireNumber(schema: string, value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ProtocolValidationError(schema, `${field} must be a finite number`);
  }
  return value;
}

function optionalNumberAtLeast(schema: string, value: unknown, field: string, minimum: number): number | undefined {
  if (value === undefined || value === null) return undefined;
  const number = requireNumber(schema, value, field);
  if (number < minimum) {
    throw new ProtocolValidationError(schema, `${field} must be at least ${minimum}`);
  }
  return number;
}

/** int64 contract fields must stay inside the JS safe-integer range —
 * PAUSE/RESUME version guards depend on exact comparisons. */
function requireSafeInteger(schema: string, value: unknown, field: string): number {
  const number = requireNumber(schema, value, field);
  if (!Number.isSafeInteger(number)) {
    throw new ProtocolValidationError(schema, `${field} must be a safe integer`);
  }
  return number;
}

function optionalSafeInteger(schema: string, value: unknown, field: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  return requireSafeInteger(schema, value, field);
}

const RUN_STATES = [
  'QUEUED', 'RUNNING', 'WAITING_APPROVAL', 'PAUSE_REQUESTED', 'PAUSED',
  'CANCEL_REQUESTED', 'VALIDATING', 'NEEDS_ATTENTION', 'COMPLETED', 'FAILED',
  'CANCELLED', 'UNKNOWN'
] as const;

export type ValidatedRunState = (typeof RUN_STATES)[number];

/** Unknown internal states degrade to UNKNOWN (desktop design §9.1). */
export function degradeRunState(raw: unknown): ValidatedRunState {
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new ProtocolValidationError('RunState', 'state must be a non-empty string');
  }
  return (RUN_STATES as readonly string[]).includes(raw)
    ? (raw as ValidatedRunState)
    : 'UNKNOWN';
}

export interface ValidatedCapabilities {
  serviceInstanceId: string;
  protocolVersion: string;
  minDesktopProtocol?: string;
  features: {
    sessionV2: boolean;
    durableEvents: boolean;
    visibleOutputStream: boolean;
    worktreeExecution: boolean;
    mission: boolean;
    mcpHost: boolean;
    servicePty: boolean;
  };
  limits: { maxDiffBytes: number; maxEventPage: number; maxVisibleDeltaChars: number };
  operations: ValidatedOperationCapability[];
}

export interface ValidatedOperationCapability {
  id: string;
  availability: 'AVAILABLE' | 'DEGRADED' | 'UNAVAILABLE' | 'BLOCKED';
  reasonCode?: string;
  limits: Record<string, unknown>;
  contractVersion: string;
}

function validateOperation(value: unknown, index: number): ValidatedOperationCapability {
  const operation = requireObject(`CapabilityResponse.operations[${index}]`, value);
  const availability = operation.availability;
  if (availability !== 'AVAILABLE' && availability !== 'DEGRADED' && availability !== 'UNAVAILABLE' && availability !== 'BLOCKED') {
    throw new ProtocolValidationError(`CapabilityResponse.operations[${index}]`, 'availability is invalid');
  }
  const limits = operation.limits === undefined || operation.limits === null
    ? {}
    : requireObject(`CapabilityResponse.operations[${index}].limits`, operation.limits);
  const reasonCode = operation.reasonCode === undefined || operation.reasonCode === null
    ? undefined
    : requireString(`CapabilityResponse.operations[${index}]`, operation.reasonCode, 'reasonCode');
  return {
    id: requireString(`CapabilityResponse.operations[${index}]`, operation.id, 'id'),
    availability,
    ...(reasonCode ? { reasonCode } : {}),
    limits,
    contractVersion: requireString(`CapabilityResponse.operations[${index}]`, operation.contractVersion, 'contractVersion')
  };
}

export function validateCapabilities(payload: unknown): ValidatedCapabilities {
  const raw = requireObject('CapabilityResponse', payload);
  const features = requireObject('CapabilityResponse.features', raw.features);
  const limits = requireObject('CapabilityResponse.limits', raw.limits);
  if (!Array.isArray(raw.operations)) {
    throw new ProtocolValidationError('CapabilityResponse.operations', 'operations must be an array');
  }
  return {
    serviceInstanceId: requireString('CapabilityResponse', raw.serviceInstanceId, 'serviceInstanceId'),
    protocolVersion: requireString('CapabilityResponse', raw.protocolVersion, 'protocolVersion'),
    minDesktopProtocol: optionalString('CapabilityResponse', raw.minDesktopProtocol, 'minDesktopProtocol'),
    features: {
      sessionV2: requireBoolean('CapabilityResponse.features', features.sessionV2, 'sessionV2'),
      durableEvents: requireBoolean('CapabilityResponse.features', features.durableEvents, 'durableEvents'),
      visibleOutputStream: requireBoolean('CapabilityResponse.features', features.visibleOutputStream, 'visibleOutputStream'),
      worktreeExecution: requireBoolean('CapabilityResponse.features', features.worktreeExecution, 'worktreeExecution'),
      mission: requireBoolean('CapabilityResponse.features', features.mission, 'mission'),
      mcpHost: requireBoolean('CapabilityResponse.features', features.mcpHost, 'mcpHost'),
      servicePty: requireBoolean('CapabilityResponse.features', features.servicePty, 'servicePty')
    },
    limits: {
      maxDiffBytes: requireNumber('CapabilityResponse.limits', limits.maxDiffBytes, 'maxDiffBytes'),
      maxEventPage: requireNumber('CapabilityResponse.limits', limits.maxEventPage, 'maxEventPage'),
      maxVisibleDeltaChars: requireNumber('CapabilityResponse.limits', limits.maxVisibleDeltaChars, 'maxVisibleDeltaChars')
    },
    operations: raw.operations.map(validateOperation)
  };
}

export interface ValidatedSchedulerOverview {
  schemaVersion: string;
  bootId?: string;
  schedulerMode?: string;
  recoveryBarrier?: string;
  provenanceFingerprint?: string;
  configFingerprint?: string;
  activeRuns: number;
  maxActiveRuns: number;
  queuedRuns: number;
  resourcePools: Array<Record<string, unknown>>;
}

/** Java SchedulerOverviewResponse v1: preserve unknown mode/barrier values. */
export function validateSchedulerOverview(payload: unknown): ValidatedSchedulerOverview {
  const raw = requireObject('SchedulerOverviewResponse', payload);
  if (!Array.isArray(raw.resourcePools)) {
    throw new ProtocolValidationError('SchedulerOverviewResponse', 'resourcePools must be an array');
  }
  return {
    schemaVersion: requireString('SchedulerOverviewResponse', raw.schemaVersion, 'schemaVersion'),
    bootId: optionalString('SchedulerOverviewResponse', raw.bootId, 'bootId'),
    schedulerMode: optionalString('SchedulerOverviewResponse', raw.schedulerMode, 'schedulerMode'),
    recoveryBarrier: optionalString('SchedulerOverviewResponse', raw.recoveryBarrier, 'recoveryBarrier'),
    provenanceFingerprint: optionalString('SchedulerOverviewResponse', raw.provenanceFingerprint, 'provenanceFingerprint'),
    configFingerprint: optionalString('SchedulerOverviewResponse', raw.configFingerprint, 'configFingerprint'),
    activeRuns: requireNumber('SchedulerOverviewResponse', raw.activeRuns, 'activeRuns'),
    maxActiveRuns: requireNumber('SchedulerOverviewResponse', raw.maxActiveRuns, 'maxActiveRuns'),
    queuedRuns: requireNumber('SchedulerOverviewResponse', raw.queuedRuns, 'queuedRuns'),
    resourcePools: raw.resourcePools.map((pool, index) => requireObject(`SchedulerOverviewResponse.resourcePools[${index}]`, pool))
  };
}

export interface ValidatedRunStateResponse {
  startedAt?: string;
  finishedAt?: string;
  queuedAt?: string;
  updatedAt?: string;
  summary?: string;
  failureMessage?: string;
  runId: string;
  taskId: string;
  state: ValidatedRunState;
  sourceStatus?: string;
  stateVersion: number;
  changedFileCount: number;
  sessionId?: string;
  workspaceAlias?: string;
  outcomeSeverity?: 'OK' | 'WARNING' | 'ERROR';
  verificationV2?: { [key: string]: unknown };
  delivery?: components['schemas']['RunDeliveryResponse'];
  failure?: FailureDescriptor;
  scheduling?: RunSchedulingProjection;
  reasonCode?: string;
  workspaceConflicts?: components['schemas']['WorkspaceConflictResponse'][];
  /** WU-05 (design §6.5): attention sub-record {reason, openCount, resolvedCount, dismissedCount, clearedAt}; opaque map. */
  attention?: { [key: string]: unknown };
  continuationOf?: string;
  continuedBy?: string;
  /** Reliable run control (run-command/1): additive control projection;
   * absent on services that predate the commands surface. */
  controlState?: string;
  controlCommandId?: string;
  checkpointAvailable?: boolean;
  availableActions?: string[];
}

const DELIVERY_STATUSES = ['PENDING', 'AVAILABLE', 'PARTIAL', 'UNAVAILABLE'] as const;
const OUTCOME_SEVERITIES = ['OK', 'WARNING', 'ERROR'] as const;

function optionalDelivery(value: unknown): components['schemas']['RunDeliveryResponse'] | undefined {
  if (value === undefined || value === null) return undefined;
  const raw = requireObject('RunStateResponse.delivery', value);
  const status = raw.status === undefined || raw.status === null
    ? undefined
    : (typeof raw.status === 'string' && (DELIVERY_STATUSES as readonly string[]).includes(raw.status)
      ? raw.status as components['schemas']['RunDeliveryResponse']['status']
      : 'UNAVAILABLE');
  if (raw.artifactsReady !== undefined && raw.artifactsReady !== null
    && typeof raw.artifactsReady !== 'boolean') {
    throw new ProtocolValidationError('RunStateResponse.delivery', 'artifactsReady must be boolean');
  }
  if (raw.stateVersion !== undefined && raw.stateVersion !== null) {
    requireNumber('RunStateResponse.delivery', raw.stateVersion, 'stateVersion');
  }
  const ref = raw.evidenceManifestRef;
  if (ref !== undefined && ref !== null) requireObject('RunStateResponse.delivery.evidenceManifestRef', ref);
  return {
    status,
    artifactsReady: raw.artifactsReady as boolean | undefined,
    stateVersion: raw.stateVersion as number | undefined,
    changeArtifactRef: optionalString('RunStateResponse.delivery', raw.changeArtifactRef, 'changeArtifactRef'),
    evidenceManifestRef: ref as components['schemas']['EvidenceManifestRef'] | undefined
  };
}

export function validateRunStateResponse(payload: unknown): ValidatedRunStateResponse {
  const raw = requireObject('RunStateResponse', payload);
  const severity = raw.outcomeSeverity === undefined || raw.outcomeSeverity === null
    ? undefined
    : (typeof raw.outcomeSeverity === 'string'
      && (OUTCOME_SEVERITIES as readonly string[]).includes(raw.outcomeSeverity)
      ? raw.outcomeSeverity as 'OK' | 'WARNING' | 'ERROR'
      : undefined);
  const verification = raw.verificationV2 === undefined || raw.verificationV2 === null
    ? undefined : requireObject('RunStateResponse.verificationV2', raw.verificationV2);
  const workspaceConflicts = raw.workspaceConflicts === undefined || raw.workspaceConflicts === null
    ? undefined
    : validateWorkspaceConflicts(raw.workspaceConflicts);
  return {
    startedAt: optionalString('RunStateResponse', raw.startedAt, 'startedAt'),
    finishedAt: optionalString('RunStateResponse', raw.finishedAt, 'finishedAt'),
    queuedAt: optionalString('RunStateResponse', raw.queuedAt, 'queuedAt'),
    updatedAt: optionalString('RunStateResponse', raw.updatedAt, 'updatedAt'),
    summary: optionalString('RunStateResponse', raw.summary, 'summary'),
    failureMessage: optionalString('RunStateResponse', raw.failureMessage, 'failureMessage'),
    runId: requireString('RunStateResponse', raw.runId, 'runId'),
    taskId: requireString('RunStateResponse', raw.taskId, 'taskId'),
    state: degradeRunState(raw.state),
    sourceStatus: optionalString('RunStateResponse', raw.sourceStatus, 'sourceStatus'),
    // int64 source versions must stay exact: PAUSE/RESUME commands carry
    // expectedStateVersion compared against this value.
    stateVersion: requireSafeInteger('RunStateResponse', raw.stateVersion, 'stateVersion'),
    changedFileCount: requireNumber('RunStateResponse', raw.changedFileCount, 'changedFileCount'),
    sessionId: optionalString('RunStateResponse', raw.sessionId, 'sessionId'),
    workspaceAlias: optionalString('RunStateResponse', raw.workspaceAlias, 'workspaceAlias'),
    outcomeSeverity: severity,
    verificationV2: verification,
    delivery: optionalDelivery(raw.delivery),
    failure: raw.failure === undefined || raw.failure === null ? undefined : requireFailure(raw.failure),
    scheduling: raw.scheduling === undefined || raw.scheduling === null ? undefined : requireScheduling(raw.scheduling),
    reasonCode: optionalString('RunStateResponse', raw.reasonCode, 'reasonCode'),
    workspaceConflicts,
    attention: raw.attention === undefined || raw.attention === null
      ? undefined
      : requireObject('RunStateResponse.attention', raw.attention) as { [key: string]: unknown },
    continuationOf: optionalString('RunStateResponse', raw.continuationOf, 'continuationOf'),
    continuedBy: optionalString('RunStateResponse', raw.continuedBy, 'continuedBy'),
    controlState: optionalString('RunStateResponse', raw.controlState, 'controlState'),
    controlCommandId: optionalString('RunStateResponse', raw.controlCommandId, 'controlCommandId'),
    checkpointAvailable: raw.checkpointAvailable === undefined || raw.checkpointAvailable === null
      ? undefined : requireBoolean('RunStateResponse', raw.checkpointAvailable, 'checkpointAvailable'),
    availableActions: raw.availableActions === undefined || raw.availableActions === null
      ? undefined
      : Array.isArray(raw.availableActions)
        ? raw.availableActions.map((item, index) =>
          requireString('RunStateResponse', item, `availableActions[${index}]`))
        : (() => { throw new ProtocolValidationError('RunStateResponse', 'availableActions must be an array'); })()
  };
}

function validateWorkspaceConflicts(value: unknown): components['schemas']['WorkspaceConflictResponse'][] {
  if (!Array.isArray(value)) {
    throw new ProtocolValidationError('RunStateResponse.workspaceConflicts', 'must be an array');
  }
  return value.map((item, index) => {
    const raw = requireObject(`WorkspaceConflictResponse[${index}]`, item);
    const state = raw.state;
    if (state !== 'OPEN' && state !== 'RESOLVING' && state !== 'RESOLVED' && state !== 'DISMISSED' && state !== 'STALE') {
      throw new ProtocolValidationError(`WorkspaceConflictResponse[${index}]`, 'state is invalid');
    }
    return {
      schemaVersion: optionalString(`WorkspaceConflictResponse[${index}]`, raw.schemaVersion, 'schemaVersion')
        ?? 'workspace-conflict/2',
      conflictId: requireString(`WorkspaceConflictResponse[${index}]`, raw.conflictId, 'conflictId'),
      runId: requireString(`WorkspaceConflictResponse[${index}]`, raw.runId, 'runId'),
      sessionId: optionalString(`WorkspaceConflictResponse[${index}]`, raw.sessionId, 'sessionId'),
      path: requireString(`WorkspaceConflictResponse[${index}]`, raw.path, 'path'),
      kind: optionalString(`WorkspaceConflictResponse[${index}]`, raw.kind, 'kind'),
      expectedVersion: optionalString(`WorkspaceConflictResponse[${index}]`, raw.expectedVersion, 'expectedVersion'),
      actualVersion: optionalString(`WorkspaceConflictResponse[${index}]`, raw.actualVersion, 'actualVersion'),
      state,
      stateVersion: requireNumber(`WorkspaceConflictResponse[${index}]`, raw.stateVersion, 'stateVersion'),
      currentContent: optionalString(`WorkspaceConflictResponse[${index}]`, raw.currentContent, 'currentContent'),
      proposedContent: optionalString(`WorkspaceConflictResponse[${index}]`, raw.proposedContent, 'proposedContent'),
      resolutionRef: optionalString(`WorkspaceConflictResponse[${index}]`, raw.resolutionRef, 'resolutionRef')
    };
  });
}

function requireFailure(value: unknown): FailureDescriptor {
  const decoded = decodeFailure(value);
  if (decoded === undefined) {
    throw new ProtocolValidationError('FailureDescriptor', 'failure must contain a public code');
  }
  return decoded;
}

function requireScheduling(value: unknown): RunSchedulingProjection {
  const decoded = decodeScheduling(value);
  if (decoded === undefined) {
    throw new ProtocolValidationError('RunSchedulingResponse', 'scheduling must be an object');
  }
  return decoded;
}

/** Validate list items through the same additive Run decoder as getRun(). */
export function validateRunListResponse(payload: unknown): {
  items: ValidatedRunStateResponse[];
  truncated: boolean;
} {
  const raw = requireObject('RunListResponse', payload);
  if (!Array.isArray(raw.items)) {
    throw new ProtocolValidationError('RunListResponse', 'items must be an array');
  }
  return {
    items: raw.items.map((item) => validateRunStateResponse(item)),
    truncated: raw.truncated === undefined || raw.truncated === null
      ? false : requireBoolean('RunListResponse', raw.truncated, 'truncated')
  };
}

const TERMINAL_STATES = [
  'PENDING_APPROVAL', 'STARTING', 'RUNNING', 'INTERRUPTING', 'EXITED',
  'TERMINATING', 'TERMINATED', 'FAILED', 'LOST', 'CLOSED', 'UNKNOWN'
] as const;

export type ValidatedTerminalState = (typeof TERMINAL_STATES)[number];
export type ValidatedTerminalSessionResponse = Omit<components['schemas']['TerminalSessionResponse'], 'state'> & {
  state: ValidatedTerminalState;
};

export function degradeTerminalState(raw: unknown): ValidatedTerminalState {
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new ProtocolValidationError('TerminalSessionResponse', 'state must be a non-empty string');
  }
  return (TERMINAL_STATES as readonly string[]).includes(raw)
    ? (raw as ValidatedTerminalState)
    : 'UNKNOWN';
}

function validateTerminalActions(value: unknown): components['schemas']['TerminalAllowedActions'] {
  const actions = requireObject('TerminalSessionResponse.allowedActions', value);
  const names = [
    'canReadOutput', 'canWriteInput', 'canResize', 'canInterrupt',
    'canTerminate', 'canClose', 'canAgentWrite', 'canUserWrite'
  ] as const;
  for (const name of names) requireBoolean('TerminalSessionResponse.allowedActions', actions[name], name);
  return actions as components['schemas']['TerminalAllowedActions'];
}

/** Unknown terminal states degrade to UNKNOWN and revoke all mutations. */
export function validateTerminalSessionResponse(payload: unknown): ValidatedTerminalSessionResponse {
  const raw = requireObject('TerminalSessionResponse', payload);
  const state = degradeTerminalState(raw.state);
  const actions = validateTerminalActions(raw.allowedActions);
  const session: ValidatedTerminalSessionResponse = {
    ...(raw as components['schemas']['TerminalSessionResponse']),
    terminalSessionId: requireString('TerminalSessionResponse', raw.terminalSessionId, 'terminalSessionId'),
    businessSessionId: requireString('TerminalSessionResponse', raw.businessSessionId, 'businessSessionId'),
    serviceInstanceId: requireString('TerminalSessionResponse', raw.serviceInstanceId, 'serviceInstanceId'),
    state,
    stateVersion: requireNumber('TerminalSessionResponse', raw.stateVersion, 'stateVersion'),
    columns: requireNumber('TerminalSessionResponse', raw.columns, 'columns'),
    rows: requireNumber('TerminalSessionResponse', raw.rows, 'rows'),
    outputBytes: requireNumber('TerminalSessionResponse', raw.outputBytes, 'outputBytes'),
    inputVersion: requireNumber('TerminalSessionResponse', raw.inputVersion, 'inputVersion'),
    allowedActions: actions
  };
  if (state === 'UNKNOWN') {
    session.allowedActions = {
      canReadOutput: false, canWriteInput: false, canResize: false,
      canInterrupt: false, canTerminate: false, canClose: false,
      canAgentWrite: false, canUserWrite: false
    };
  }
  return session;
}

export function validateTerminalOutputResponse(payload: unknown): components['schemas']['TerminalOutputResponse'] {
  const raw = requireObject('TerminalOutputResponse', payload);
  const mode = raw.mode;
  if (mode !== 'RAW_VT' && mode !== 'PLAIN_TEXT') {
    throw new ProtocolValidationError('TerminalOutputResponse', 'mode is invalid');
  }
  return {
    ...(raw as components['schemas']['TerminalOutputResponse']),
    terminalSessionId: requireString('TerminalOutputResponse', raw.terminalSessionId, 'terminalSessionId'),
    startOffset: requireNumber('TerminalOutputResponse', raw.startOffset, 'startOffset'),
    endOffset: requireNumber('TerminalOutputResponse', raw.endOffset, 'endOffset'),
    mode,
    state: requireString('TerminalOutputResponse', raw.state, 'state'),
    eof: requireBoolean('TerminalOutputResponse', raw.eof, 'eof'),
    historyIncomplete: requireBoolean('TerminalOutputResponse', raw.historyIncomplete, 'historyIncomplete'),
    gap: requireBoolean('TerminalOutputResponse', raw.gap, 'gap'),
    serviceInstanceId: requireString('TerminalOutputResponse', raw.serviceInstanceId, 'serviceInstanceId')
  };
}

export interface ValidatedProblem {
  code: string;
  status: number;
  message: string;
  raw: Record<string, unknown>;
  failure?: FailureDescriptor;
  scheduling?: RunSchedulingProjection;
  reasonCode?: string;
  operationOutcome?: OperationOutcome;
  receiptId?: string;
  correlationId?: string;
}

export function validateProblem(payload: unknown): ValidatedProblem {
  const raw = requireObject('Problem', payload);
  const message = optionalString('Problem', raw.message, 'message')
    ?? optionalString('Problem', raw.detail, 'detail');
  if (message === undefined) {
    throw new ProtocolValidationError('Problem', 'message or detail must be a non-empty string');
  }
  const operationOutcome = raw.operationOutcome === 'NOT_APPLIED'
    || raw.operationOutcome === 'APPLIED' || raw.operationOutcome === 'UNKNOWN'
    ? raw.operationOutcome as OperationOutcome : undefined;
  return {
    code: requireString('Problem', raw.code, 'code'),
    status: requireNumber('Problem', raw.status, 'status'),
    message,
    raw,
    failure: raw.failure === undefined || raw.failure === null ? undefined : requireFailure(raw.failure),
    scheduling: raw.scheduling === undefined || raw.scheduling === null ? undefined : requireScheduling(raw.scheduling),
    reasonCode: optionalString('Problem', raw.reasonCode, 'reasonCode'),
    operationOutcome,
    receiptId: optionalString('Problem', raw.receiptId, 'receiptId'),
    correlationId: optionalString('Problem', raw.correlationId, 'correlationId')
  };
}

function validateActivityTarget(value: unknown, index: number): components['schemas']['RunActivityTargetResponse'] {
  const raw = requireObject(`RunActivityResponse.targets[${index}]`, value);
  const status = ['REQUESTED', 'SUCCEEDED', 'FAILED', 'PARTIAL', 'UNKNOWN'].includes(String(raw.status))
    ? raw.status as components['schemas']['RunActivityTargetResponse']['status']
    : 'UNKNOWN';
  return {
    ref: requireString(`RunActivityResponse.targets[${index}]`, raw.ref, 'ref'),
    status
  };
}

/** Decode the bounded public fields of one activity snapshot item. */
export function validateRunActivityResponse(payload: unknown): Omit<components['schemas']['RunActivityResponse'], 'failure'> & {
  failure?: FailureDescriptor;
  scheduling?: RunSchedulingProjection;
  effectState?: import('./failureContract').EffectState;
  // Decoded fields the committed OpenAPI snapshot does not declare yet:
  // grouped-activity chrome, bounded file context, and the execution-evidence
  // references carried by newer service projections.
  groupId?: string;
  groupPurpose?: string;
  groupStartNote?: string;
  groupSummary?: string;
  groupStatus?: string;
  groupStartedAt?: string;
  groupFinishedAt?: string;
  fileRef?: string;
  fileName?: string;
  relativeDirectory?: string;
  startLine?: number;
  endLine?: number;
  bytesRead?: number;
  fileSizeBytes?: number;
  workingDirectory?: string;
  executionId?: string;
  commandId?: string;
  evidenceState?: string;
  evidenceArtifacts?: string[];
} {
  const raw = requireObject('RunActivityResponse', payload);
  const result = {
    activityId: requireString('RunActivityResponse', raw.activityId, 'activityId'),
    runId: requireString('RunActivityResponse', raw.runId, 'runId'),
    kind: requireString('RunActivityResponse', raw.kind, 'kind'),
    status: requireString('RunActivityResponse', raw.status, 'status'),
    toolName: optionalString('RunActivityResponse', raw.toolName, 'toolName'),
    capabilityId: optionalString('RunActivityResponse', raw.capabilityId, 'capabilityId'),
    detail: optionalString('RunActivityResponse', raw.detail, 'detail'),
    commandPreview: optionalString('RunActivityResponse', raw.commandPreview, 'commandPreview'),
    redactionState: ['NONE', 'REDACTED', 'WITHHELD'].includes(String(raw.redactionState))
      ? raw.redactionState as components['schemas']['RunActivityResponse']['redactionState']
      : undefined,
    targets: raw.targets === undefined || raw.targets === null ? undefined
      : Array.isArray(raw.targets) ? raw.targets.map(validateActivityTarget)
      : (() => { throw new ProtocolValidationError('RunActivityResponse', 'targets must be an array'); })(),
    startedAt: optionalString('RunActivityResponse', raw.startedAt, 'startedAt'),
    finishedAt: optionalString('RunActivityResponse', raw.finishedAt, 'finishedAt'),
    durationMillis: raw.durationMillis === undefined || raw.durationMillis === null
      ? undefined : requireNumber('RunActivityResponse', raw.durationMillis, 'durationMillis'),
    resultSummary: optionalString('RunActivityResponse', raw.resultSummary, 'resultSummary'),
    reasonCode: optionalString('RunActivityResponse', raw.reasonCode, 'reasonCode'),
    truncated: raw.truncated === undefined || raw.truncated === null
      ? undefined : requireBoolean('RunActivityResponse', raw.truncated, 'truncated'),
    startCursor: raw.startCursor === undefined || raw.startCursor === null
      ? undefined : requireNumber('RunActivityResponse', raw.startCursor, 'startCursor'),
    endCursor: raw.endCursor === undefined || raw.endCursor === null
      ? undefined : requireNumber('RunActivityResponse', raw.endCursor, 'endCursor'),
    groupId: optionalString('RunActivityResponse', raw.groupId, 'groupId'),
    groupPurpose: optionalString('RunActivityResponse', raw.groupPurpose, 'groupPurpose'),
    groupStartNote: optionalString('RunActivityResponse', raw.groupStartNote, 'groupStartNote'),
    groupSummary: optionalString('RunActivityResponse', raw.groupSummary, 'groupSummary'),
    groupStatus: optionalString('RunActivityResponse', raw.groupStatus, 'groupStatus'),
    groupStartedAt: optionalString('RunActivityResponse', raw.groupStartedAt, 'groupStartedAt'),
    groupFinishedAt: optionalString('RunActivityResponse', raw.groupFinishedAt, 'groupFinishedAt'),
    fileRef: optionalString('RunActivityResponse', raw.fileRef, 'fileRef'),
    fileName: optionalString('RunActivityResponse', raw.fileName, 'fileName'),
    relativeDirectory: optionalString('RunActivityResponse', raw.relativeDirectory, 'relativeDirectory'),
    startLine: optionalNumberAtLeast('RunActivityResponse', raw.startLine, 'startLine', 1),
    endLine: optionalNumberAtLeast('RunActivityResponse', raw.endLine, 'endLine', 1),
    bytesRead: optionalNumberAtLeast('RunActivityResponse', raw.bytesRead, 'bytesRead', 0),
    fileSizeBytes: optionalNumberAtLeast('RunActivityResponse', raw.fileSizeBytes, 'fileSizeBytes', 0),
    workingDirectory: optionalString('RunActivityResponse', raw.workingDirectory, 'workingDirectory'),
    failure: raw.failure === undefined || raw.failure === null ? undefined : requireFailure(raw.failure),
    scheduling: raw.scheduling === undefined || raw.scheduling === null ? undefined : requireScheduling(raw.scheduling),
    effectState: raw.effectState === 'NOT_APPLIED' || raw.effectState === 'APPLIED' || raw.effectState === 'UNKNOWN'
      ? raw.effectState as EffectState : undefined,
    // Execution-evidence references (design 2026-09-26 WU-1): opaque ids and
    // record-relative artifact paths only — the service never returns raw
    // stdout/stderr on this response.
    executionId: optionalString('RunActivityResponse', raw.executionId, 'executionId'),
    commandId: optionalString('RunActivityResponse', raw.commandId, 'commandId'),
    evidenceState: optionalString('RunActivityResponse', raw.evidenceState, 'evidenceState'),
    evidenceArtifacts: raw.evidenceArtifacts === undefined || raw.evidenceArtifacts === null
      ? undefined
      : Array.isArray(raw.evidenceArtifacts)
        ? raw.evidenceArtifacts.filter((item): item is string => typeof item === 'string')
        : (() => { throw new ProtocolValidationError('RunActivityResponse', 'evidenceArtifacts must be an array'); })()
  };
  return result;
}

/** Validate an activity snapshot without dropping completeness/reasonCode. */
export function validateRunActivityListResponse(payload: unknown): {
  runId: string;
  runStateVersion: number;
  snapshotCursor: number;
  retentionFloor?: number;
  complete: boolean;
  reasonCode?: string;
  truncated?: boolean;
  items: ReturnType<typeof validateRunActivityResponse>[];
  summary: components['schemas']['RunActivitySummaryResponse'];
} {
  const raw = requireObject('RunActivityListResponse', payload);
  if (!Array.isArray(raw.items)) throw new ProtocolValidationError('RunActivityListResponse', 'items must be an array');
  const summary = requireObject('RunActivityListResponse.summary', raw.summary) as components['schemas']['RunActivitySummaryResponse'];
  const runId = requireString('RunActivityListResponse', raw.runId, 'runId');
  return {
    runId,
    runStateVersion: requireNumber('RunActivityListResponse', raw.runStateVersion, 'runStateVersion'),
    snapshotCursor: requireNumber('RunActivityListResponse', raw.snapshotCursor, 'snapshotCursor'),
    retentionFloor: raw.retentionFloor === undefined || raw.retentionFloor === null
      ? undefined : requireNumber('RunActivityListResponse', raw.retentionFloor, 'retentionFloor'),
    complete: requireBoolean('RunActivityListResponse', raw.complete, 'complete'),
    reasonCode: optionalString('RunActivityListResponse', raw.reasonCode, 'reasonCode'),
    truncated: raw.truncated === undefined || raw.truncated === null
      ? undefined : requireBoolean('RunActivityListResponse', raw.truncated, 'truncated'),
    // Older service projections leave the per-item runId null even though the
    // list envelope carries the authoritative runId. Preserve those snapshots
    // instead of rejecting the entire activity list and rendering the generic
    // "waiting for execution details" state.
    items: raw.items.map((item) => {
      if (typeof item === 'object' && item !== null && !Array.isArray(item)) {
        const itemObject = item as Record<string, unknown>;
        if (itemObject.runId === undefined || itemObject.runId === null) {
          return validateRunActivityResponse({ ...itemObject, runId });
        }
      }
      return validateRunActivityResponse(item);
    }),
    summary
  };
}

/** Validate a display-reasoning snapshot without dropping completeness flags. */
export function validateRunReasoningResponse(payload: unknown): {
  runId: string;
  runStateVersion: number;
  snapshotCursor: number;
  retentionFloor?: number;
  text: string;
  receivedBytes: number;
  totalBytes: number;
  droppedChunks: number;
  lastSequence: number;
  terminal: boolean;
  complete: boolean;
  reasonCode?: string;
  truncated: boolean;
  segments?: {
    roundId: string;
    roundOrdinal?: number | null;
    text: string;
    truncated: boolean;
    complete: boolean;
    lastSequence: number;
  }[];
} {
  const raw = requireObject('RunReasoningResponse', payload);
  return {
    runId: requireString('RunReasoningResponse', raw.runId, 'runId'),
    runStateVersion: requireNumber('RunReasoningResponse', raw.runStateVersion, 'runStateVersion'),
    snapshotCursor: requireNumber('RunReasoningResponse', raw.snapshotCursor, 'snapshotCursor'),
    retentionFloor: raw.retentionFloor === undefined || raw.retentionFloor === null
      ? undefined : requireNumber('RunReasoningResponse', raw.retentionFloor, 'retentionFloor'),
    text: typeof raw.text === 'string' ? raw.text : '',
    receivedBytes: requireNumber('RunReasoningResponse', raw.receivedBytes, 'receivedBytes'),
    totalBytes: requireNumber('RunReasoningResponse', raw.totalBytes, 'totalBytes'),
    droppedChunks: requireNumber('RunReasoningResponse', raw.droppedChunks, 'droppedChunks'),
    lastSequence: requireNumber('RunReasoningResponse', raw.lastSequence, 'lastSequence'),
    terminal: requireBoolean('RunReasoningResponse', raw.terminal, 'terminal'),
    complete: requireBoolean('RunReasoningResponse', raw.complete, 'complete'),
    reasonCode: optionalString('RunReasoningResponse', raw.reasonCode, 'reasonCode'),
    truncated: raw.truncated === undefined || raw.truncated === null
      ? false : requireBoolean('RunReasoningResponse', raw.truncated, 'truncated'),
    segments: validateRunTextSegments('RunReasoningResponse', raw.segments)
  };
}

/** Per-round text segment shared by the reasoning/output snapshots
 * (design 2026-09-19 §5.4/§5.5-B). Missing segments must not fail the
 * snapshot; malformed entries are skipped rather than dropping the array. */
function validateRunTextSegments(owner: string, value: unknown): {
  roundId: string;
  roundOrdinal?: number | null;
  text: string;
  truncated: boolean;
  complete: boolean;
  lastSequence: number;
}[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) return undefined;
  const segments: {
    roundId: string;
    roundOrdinal?: number | null;
    text: string;
    truncated: boolean;
    complete: boolean;
    lastSequence: number;
  }[] = [];
  for (const item of value) {
    if (typeof item !== 'object' || item === null) continue;
    const raw = item as Record<string, unknown>;
    if (typeof raw.roundId !== 'string' || raw.roundId.length === 0) continue;
    segments.push({
      roundId: raw.roundId,
      roundOrdinal: raw.roundOrdinal === undefined || raw.roundOrdinal === null
        ? null : requireNumber(owner, raw.roundOrdinal, 'roundOrdinal'),
      text: typeof raw.text === 'string' ? raw.text : '',
      truncated: raw.truncated === true,
      complete: raw.complete === true,
      lastSequence: typeof raw.lastSequence === 'number' ? raw.lastSequence : 0
    });
  }
  return segments;
}

/** Validate a visible-output snapshot; mirrors the reasoning fold
 * (design 2026-09-19 §5.5-B). */
export function validateRunOutputResponse(payload: unknown): {
  runId: string;
  runStateVersion: number;
  snapshotCursor: number;
  retentionFloor?: number;
  text: string;
  receivedBytes: number;
  totalBytes: number;
  droppedChunks: number;
  lastSequence: number;
  terminal: boolean;
  complete: boolean;
  reasonCode?: string;
  truncated: boolean;
  segments?: {
    roundId: string;
    roundOrdinal?: number | null;
    text: string;
    truncated: boolean;
    complete: boolean;
    lastSequence: number;
  }[];
} {
  const raw = requireObject('RunOutputResponse', payload);
  return {
    runId: requireString('RunOutputResponse', raw.runId, 'runId'),
    runStateVersion: requireNumber('RunOutputResponse', raw.runStateVersion, 'runStateVersion'),
    snapshotCursor: requireNumber('RunOutputResponse', raw.snapshotCursor, 'snapshotCursor'),
    retentionFloor: raw.retentionFloor === undefined || raw.retentionFloor === null
      ? undefined : requireNumber('RunOutputResponse', raw.retentionFloor, 'retentionFloor'),
    text: typeof raw.text === 'string' ? raw.text : '',
    receivedBytes: requireNumber('RunOutputResponse', raw.receivedBytes, 'receivedBytes'),
    totalBytes: requireNumber('RunOutputResponse', raw.totalBytes, 'totalBytes'),
    droppedChunks: requireNumber('RunOutputResponse', raw.droppedChunks, 'droppedChunks'),
    lastSequence: requireNumber('RunOutputResponse', raw.lastSequence, 'lastSequence'),
    terminal: requireBoolean('RunOutputResponse', raw.terminal, 'terminal'),
    complete: requireBoolean('RunOutputResponse', raw.complete, 'complete'),
    reasonCode: optionalString('RunOutputResponse', raw.reasonCode, 'reasonCode'),
    truncated: raw.truncated === undefined || raw.truncated === null
      ? false : requireBoolean('RunOutputResponse', raw.truncated, 'truncated'),
    segments: validateRunTextSegments('RunOutputResponse', raw.segments)
  };
}

// ---- Reliable run commands (run-command/1; personal task control §6) ----
// commandId == Idempotency-Key; receiptRevision is a decimal string that is
// never converted to number for ordering — use receiptRevisionValue.

const RUN_COMMAND_PHASES = [
  'ACCEPTED', 'DISPATCHING', 'REQUESTED', 'APPLIED', 'NOOP', 'REJECTED',
  'UNKNOWN', 'SUPERSEDED'
] as const;
const RECEIPT_REVISION_PATTERN = /^(0|[1-9][0-9]*)$/;

/** Ordering handle for decimal receipt revisions; bigint keeps the full
 * int64 range that a number comparison would silently collapse. */
export function receiptRevisionValue(revision: string): bigint {
  if (!RECEIPT_REVISION_PATTERN.test(revision)) {
    throw new ProtocolValidationError('RunCommandReceipt', 'receiptRevision must be a decimal integer string');
  }
  return BigInt(revision);
}

export function validateRunCommandReceipt(payload: unknown): components['schemas']['RunCommandReceipt'] {
  const raw = requireObject('RunCommandReceipt', payload);
  if (raw.schemaVersion !== 'run-command-receipt/1') {
    throw new ProtocolValidationError('RunCommandReceipt', 'schemaVersion must be run-command-receipt/1');
  }
  const intent = raw.intent;
  if (intent !== 'PAUSE' && intent !== 'RESUME' && intent !== 'STOP') {
    throw new ProtocolValidationError('RunCommandReceipt', 'intent is invalid');
  }
  const phase = raw.phase;
  if (!(RUN_COMMAND_PHASES as readonly string[]).includes(phase as string)) {
    throw new ProtocolValidationError('RunCommandReceipt', 'phase is invalid');
  }
  const receiptRevision = requireString('RunCommandReceipt', raw.receiptRevision, 'receiptRevision');
  receiptRevisionValue(receiptRevision);
  const actor = requireObject('RunCommandReceipt.actor', raw.actor);
  const proof = raw.consumptionProof === undefined || raw.consumptionProof === null
    ? undefined
    : requireObject('RunCommandReceipt.consumptionProof', raw.consumptionProof);
  if (proof) {
    for (const [name, entry] of Object.entries(proof)) {
      if (typeof entry !== 'string') {
        throw new ProtocolValidationError('RunCommandReceipt.consumptionProof', `${name} must be a string`);
      }
    }
  }
  return {
    schemaVersion: 'run-command-receipt/1',
    commandId: requireString('RunCommandReceipt', raw.commandId, 'commandId'),
    receiptId: requireString('RunCommandReceipt', raw.receiptId, 'receiptId'),
    sessionId: optionalString('RunCommandReceipt', raw.sessionId, 'sessionId'),
    runId: requireString('RunCommandReceipt', raw.runId, 'runId'),
    intent,
    reasonCode: optionalString('RunCommandReceipt', raw.reasonCode, 'reasonCode'),
    phase: phase as components['schemas']['RunCommandReceipt']['phase'],
    receiptRevision,
    acceptedAt: requireString('RunCommandReceipt', raw.acceptedAt, 'acceptedAt'),
    actor: {
      principalId: requireString('RunCommandReceipt.actor', actor.principalId, 'principalId'),
      clientSessionId: requireString('RunCommandReceipt.actor', actor.clientSessionId, 'clientSessionId')
    },
    expectedStateVersion: optionalSafeInteger('RunCommandReceipt', raw.expectedStateVersion, 'expectedStateVersion'),
    acceptedStateVersion: requireSafeInteger('RunCommandReceipt', raw.acceptedStateVersion, 'acceptedStateVersion'),
    observedStateVersion: requireSafeInteger('RunCommandReceipt', raw.observedStateVersion, 'observedStateVersion'),
    observedRunState: requireString('RunCommandReceipt', raw.observedRunState, 'observedRunState'),
    resultCode: optionalString('RunCommandReceipt', raw.resultCode, 'resultCode'),
    terminal: requireBoolean('RunCommandReceipt', raw.terminal, 'terminal'),
    evidenceRef: optionalString('RunCommandReceipt', raw.evidenceRef, 'evidenceRef'),
    consumptionProof: proof as Record<string, string> | undefined
  };
}

export function validateRunCommandPage(payload: unknown): components['schemas']['RunCommandPage'] {
  const raw = requireObject('RunCommandPage', payload);
  if (!Array.isArray(raw.items)) {
    throw new ProtocolValidationError('RunCommandPage', 'items must be an array');
  }
  return {
    items: raw.items.map((item) => validateRunCommandReceipt(item)),
    nextBefore: optionalString('RunCommandPage', raw.nextBefore, 'nextBefore')
  };
}

/** Narrow session-foundation view consumed by reliable task control: the
 * pinned schemaVersion, identity and ownership fields plus the capabilities
 * map (commandReceiptV1 advertises the run-command surface; values such as
 * READY/DISABLED/UNSUPPORTED pass through verbatim). Remaining fields are
 * carried through loosely rather than asserted one by one. */
export interface ValidatedSessionFoundation {
  schemaVersion: 'session-foundation/1';
  storeId: string;
  sessionId: string;
  sessionVersion?: string;
  executionOwnership: string;
  activeRunId?: string;
  runState?: string;
  runStateVersion?: string;
  capabilities: Record<string, string>;
}

export function validateSessionFoundation(payload: unknown): ValidatedSessionFoundation {
  const raw = requireObject('SessionFoundationResponse', payload);
  if (raw.schemaVersion !== 'session-foundation/1') {
    throw new ProtocolValidationError('SessionFoundationResponse', 'schemaVersion must be session-foundation/1');
  }
  const capabilities = requireObject('SessionFoundationResponse.capabilities', raw.capabilities);
  const checked: Record<string, string> = {};
  for (const [name, entry] of Object.entries(capabilities)) {
    if (typeof entry !== 'string') {
      throw new ProtocolValidationError('SessionFoundationResponse.capabilities', `${name} must be a string`);
    }
    checked[name] = entry;
  }
  return {
    ...raw,
    schemaVersion: 'session-foundation/1',
    storeId: requireString('SessionFoundationResponse', raw.storeId, 'storeId'),
    sessionId: requireString('SessionFoundationResponse', raw.sessionId, 'sessionId'),
    sessionVersion: optionalString('SessionFoundationResponse', raw.sessionVersion, 'sessionVersion'),
    executionOwnership: requireString('SessionFoundationResponse', raw.executionOwnership, 'executionOwnership'),
    activeRunId: optionalString('SessionFoundationResponse', raw.activeRunId, 'activeRunId'),
    runState: optionalString('SessionFoundationResponse', raw.runState, 'runState'),
    runStateVersion: optionalString('SessionFoundationResponse', raw.runStateVersion, 'runStateVersion'),
    capabilities: checked
  };
}
