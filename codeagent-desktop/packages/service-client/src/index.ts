import { validWritableOperation, WRITABLE_ROUTES, type WritableOperation, type WritableResponse } from '../../protocol/src/writable-collaboration';
import type { CollaborationOperation, CollaborationResource } from '../../protocol/src/collaboration';
import {
  PERSONAL_API_PREFIX,
  PERSONAL_ID_PATTERN,
  PERSONAL_ROUTES,
  decodePersonalError,
  validPersonalEnvelope,
  validPersonalOperation,
  type PersonalOperation
} from '../../protocol/src/personal';
import type {
  PersonalEnvelope,
  PersonalMeta,
  PersonalErrorBody,
  PersonalOverview,
  PersonalAttentionItem,
  PersonalProjectView,
  PersonalProjectRegistrationRequest,
  PersonalProjectRegistrationInput,
  PersonalEnvironmentRequirement,
  PersonalEnvironmentFact,
  ProjectEnvironmentView,
  PersonalToolchainSelection,
  PersonalEnvironmentPlanRequest,
  PersonalEnvironmentPlanInput,
  PersonalEnvironmentPlanPreview,
  PersonalPlanStepView,
  PersonalEnvironmentOperationRequest,
  PersonalEnvironmentOperationInput,
  PersonalOperationCancelRequest,
  PersonalOperationCancelInput,
  PersonalOperationAccepted,
  PersonalEnvironmentOperation,
  PersonalOperationEvent,
  PersonalOperationEventsPage,
  PersonalWorkerCapabilities,
  PersonalWorkerView,
  AdaptiveActionDescriptor,
  PersonalActionRunRequest,
  PersonalActionRunInput,
  PersonalActionSaveRequest,
  PersonalActionSaveInput,
  ActionTrialReceiptView,
  PersonalReportRequest,
  PersonalReportInput,
  ReportDescriptor,
  PersonalReportFile,
  PersonalConnectionKind,
  EnvironmentOperationState,
  EnvironmentOperationKind,
  EnvironmentReasonCode,
  EnvironmentBackendPreference,
  EnvironmentReadinessFactKind,
  ProjectedCheckStatus,
  AdaptiveActionScope,
  PersonalCapabilityName
} from '../../protocol/src/personal';
/**
 * Loopback service client for the Electron main (desktop design §9).
 * The renderer never touches this module; the main holds the bearer token.
 *
 * Contract rules enforced here:
 * - every mutation sends an Idempotency-Key (generated when not provided);
 * - problem responses surface as typed ServiceProblem (stable `code`);
 * - the capability handshake validates the payload AND the compatibility
 *   matrix, failing closed on version skew;
 * - Authorization and bodies are never logged.
 */
import {
  checkServiceCompatibility,
  validateCapabilities,
  validateRunStateResponse,
  validateRunListResponse,
  validateRunActivityListResponse,
  validateRunReasoningResponse,
  validateRunOutputResponse,
  validateTerminalSessionResponse,
  validateTerminalOutputResponse,
  validateSchedulerOverview,
  validateProblem,
  validateRunCommandReceipt,
  validateRunCommandPage,
  validateSessionFoundation,
  type ValidatedCapabilities,
  type ValidatedRunStateResponse,
  type ValidatedSessionFoundation,
  type CapabilityResponse,
  type ProjectSummary,
  type ProjectStatus,
  type ProjectSessionPreflight,
  type ProjectRegistrationRequest,
  type ProjectRegistrationResponse,
  type NativeOpenIntent,
  type RunListResponse,
  type SchedulerOverviewResponse,
  type EvidenceBundleResponse,
  type ModelCatalogResponse,
  type AgentProfilesResponse,
  type SessionCreateRequest,
  type SessionPatchRequest,
  type SessionMessageRequest,
  type SessionMessageResponse,
  type EventSnapshotResponse,
  type OperationLookupRequest,
  type OperationReceiptResponse,
  type SessionForkRequest,
  type SessionArchiveRequest,
  type SessionResponse,
  type SessionSummaryPageResponse,
  type SessionMetadataResponse,
  type SessionMessagePageResponse,
  type MessageContentPageResponse,
  type AttentionItem,
  type SourceFetchRequest,
  type SourceFetchResponse,
  type McpServerSummary,
  type McpResourceDescriptor,
  type McpResourceReadResponse,
  type McpServerConfigRequest,
  type McpServerUpdateRequest,
  type McpServerDetailResponse,
  type McpServerStatusRequest,
  type McpConnectionActionRequest,
  type McpOperationResponse,
  type McpToolDescriptorView,
  type McpToolListResponse,
  type McpAuthActionRequest,
  type McpAuthActionResponse,
  type McpPromptListResponse,
  type McpPromptResolveRequest,
  type McpPromptResolveResponse,
  type McpResourceTemplateListResponse,
  type SkillRegisterRequest,
  type SkillRecordResponse,
  type SkillStatusRequest,
  type SkillImportSourceRequest,
  type SkillImportSourceResponse,
  type SkillImportPreviewRequest,
  type SkillImportPreviewResponse,
  type SkillImportRequest,
  type SkillVersionSelectRequest,
  type SkillVersionListResponse,
  type SkillManifestResponse,
  type ExecutionExtensionsResponse,
  type ExtensionInvocationListResponse,
  type ExtensionInvocationActionRequest,
  type ExtensionInvocationView,
  type ExtensionTestExecutionRequest,
  type ExtensionTestExecutionResponse,
  type HookSummary,
  type HookExecutionListResponse,
  type TerminalSessionCreateRequest,
  type TerminalSessionResponse,
  type TerminalOutputMode,
  type TerminalOutputResponse,
  type TerminalInputRequest,
  type TerminalInputResponse,
  type TerminalResizeRequest,
  type TerminalResizeResponse,
  type TerminalSignalRequest,
  type TerminalSignalResponse,
  type TerminalControlAcquireRequest,
  type TerminalControlRenewRequest,
  type TerminalControlReleaseRequest,
  type TerminalControlResponse,
  type TerminalCloseRequest,
  type TerminalCloseResponse,
  type DiffPageResponse,
  type RunActivityListResponse,
  type RunActivitiesQuery,
  type SessionExecutionPage,
  type SessionExecutionRecord,
  type SessionExecutionArtifactSlice,
  type SessionExecutionsQuery,
  type SessionExecutionArtifactQuery,
  type RunReasoningResponse,
  type RunOutputResponse,
  type FileReadQuery,
  type FileReadResponse,
  type ReviewRunResponse,
  type FixTaskRequest,
  type FixTaskResponse,
  type WorkspaceExecutionCreateRequest,
  type WorkspaceExecutionHandoffRequest,
  type WorkspaceExecutionListResponse,
  type WorkspaceExecutionReclaimRequest,
  type WorkspaceExecutionLeaseRenewRequest,
  type WorkspaceExecutionResponse,
  type WorkspaceLaneCreateRequest,
  type WorkspaceLaneBindRequest,
  type WorkspaceLaneReopenRequest,
  type WorkspaceLaneReleaseRequest,
  type WorkspaceLaneResponse,
  type DeliveryCreateRequest,
  type DeliveryPrepareRequest,
  type DeliveryDecisionRequest,
  type DeliveryApplyRequest,
  type DeliveryReconcileRequest,
  type DeliveryResponse,
  type DeliveryChangesResponse,
  type DeliveryCommandResponse,
  type DeliveryListResponse,
  type MissionApprovalDecisionRequest,
  type MissionCommandRequest,
  type MissionCreateRequest,
  type MissionResponse,
  type PolicyLayerUpdateRequest,
  type PolicyLayersResponse,
  type ProductSettingsResponse,
  type ProductSettingsUpdateRequest,
  type KnowledgeItemResponse,
  type KnowledgeListResponse,
  type KnowledgeSuggestRequest,
  type SpecApprovalDecisionRequest,
  type SpecApprovalResponse,
  type SpecConversionRequest,
  type SpecConversionResponse,
  type SpecCreateRequest,
  type SpecResponse,
  type SpecRevisionRequest,
  type NativeOpenIntentRequest,
  type CommandApprovalDecision,
  type BudgetApprovalDecision,
  type BudgetApprovalResponse,
  type ExecutionPolicyResponse,
  type ExecutionPolicyUpdateRequest,
  type ExecutionPolicyDefaultsResponse,
  type AutomationControlRequest,
  type AutomationControlResponse,
  type ApprovalsListResponse,
  type ApprovalRequestV2,
  type ApprovalDecisionRequest,
  type ApprovalControlRequest,
  type ApprovalAdvanceRequest,
  type ApprovalDecisionResponse,
  type RunActionResponse,
  type RunCancelRequest,
  type RunControlRequest,
  type RunCommandRequest,
  type RunCommandReceipt,
  type RunCommandPage,
  type RunDiffQuery,
  type WorkspaceConflictResponse,
  type WorkspaceConflictListResponse,
  type WorkspaceConflictResolveRequest,
  type RunListQuery,
  type EnvironmentFeaturesResponse,
  type EnvironmentFeatureCard,
  type EnvironmentFeatureUpdateRequest,
  type ProjectBuildPlanResponse,
  type BuildPlanOverrideRequest,
  type BuildPlanOverrideResponse,
  type BuildPlanPreviewResponse,
  type VerificationProfileListResponse,
  type VerificationProfileRequest,
  type VerificationProfileView,
  type SessionSummaryDetail,
  type ManagedModelProvidersResponse,
  type ManagedModelProvider,
  type ManagedModelProviderRequest,
  type ManagedModel,
  type ManagedModelRequest,
  type ManagedDeleteResponse,
  type RemoteModelsProbeRequest,
  type RemoteModelsProbeResponse,
  type WebSearchProvidersResponse,
  type WebSearchProvider,
  type WebSearchProviderRequest,
  type JsonValue
} from '../../protocol/src/index.js';
import type {
  FailureDescriptor,
  OperationOutcome,
  RunSchedulingProjection,
  HubResourceListResponse,
  HubResourceSession,
  HubSessionAcquireRequest,
  HubSessionControlRequest,
  HubSessionControlResponse,
  HubSessionListResponse
} from '../../protocol/src/index.js';

/** workspace-conflict/2 additive segments (design §6.4); the generated
 * protocol schema trails these endpoints so the shapes are declared here. */
export interface WorkspaceConflictAutoMerge {
  status?: string | null;
  previewRef?: string | null;
  reason?: string | null;
}

export interface WorkspaceConflictResolveBatchItemRequest {
  conflictId: string;
  expectedStateVersion?: number;
  expectedCurrentHash?: string | null;
  choice: 'KEEP_CURRENT' | 'USE_PROPOSED' | 'MERGED_CONTENT' | 'AUTO_MERGED' | 'DISMISS';
  resolutionContent?: string | null;
  resolutionRef?: string | null;
}

export interface WorkspaceConflictResolveBatchRequest {
  syncSessionId?: string | null;
  items: WorkspaceConflictResolveBatchItemRequest[];
}

export interface WorkspaceConflictResolveBatchResponse {
  appliedPaths: string[];
  pendingPaths: string[];
  failedPaths: Array<Record<string, unknown>>;
  items: WorkspaceConflictResponse[];
}

export interface WorkspaceContentsResponse {
  ref: string;
  sha256: string;
  byteLength: number;
}

export interface WorkspaceConflictProposalStatus {
  proposalId: string;
  status: 'PENDING' | 'READY' | 'FAILED' | string;
  proposalRef?: string | null;
  error?: string | null;
}

export class ServiceProblem extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
    message: string,
    public readonly raw: Record<string, JsonValue>,
    public readonly details: {
      failure?: FailureDescriptor;
      scheduling?: RunSchedulingProjection;
      reasonCode?: string;
      operationOutcome?: OperationOutcome;
      receiptId?: string;
      correlationId?: string;
      /** Personal gateway {error.retryable} hint (PAE P0 freeze §4). */
      retryable?: boolean;
    } = {}
  ) {
    super(message);
    this.name = 'ServiceProblem';
  }

  get failure(): FailureDescriptor | undefined { return this.details.failure; }
  get scheduling(): RunSchedulingProjection | undefined { return this.details.scheduling; }
  get reasonCode(): string | undefined { return this.details.reasonCode; }
  get operationOutcome(): OperationOutcome | undefined { return this.details.operationOutcome; }
  get receiptId(): string | undefined { return this.details.receiptId; }
  get correlationId(): string | undefined { return this.details.correlationId; }
  get retryable(): boolean | undefined { return this.details.retryable; }
}

export class ProtocolIncompatible extends Error {
  constructor(
    public readonly reason: 'SERVICE_TOO_OLD' | 'SERVICE_TOO_NEW',
    detail: string
  ) {
    super(`service is incompatible: ${reason} (${detail})`);
    this.name = 'ProtocolIncompatible';
  }
}

/**
 * WU01 (capability uplift design §5): Hub association types. The service
 * contract snapshot pinned in service-dependency.lock.json predates these
 * endpoints, so the local interfaces below mirror the v2 DTOs; they fold
 * into generated protocol types on the next snapshot import.
 */
export interface HubConnectionRequest {
  displayName: string;
  baseUrl: string;
  credentialRef?: string | null;
  scope?: 'USER' | 'PROJECT';
  projectId?: string | null;
  enabled?: boolean;
  allowInsecureLoopback?: boolean;
}

export interface HubConnectionUpdateRequest {
  displayName?: string | null;
  credentialRef?: string | null;
  allowInsecureLoopback?: boolean | null;
  enabled?: boolean | null;
  expectedRevision: number;
}

export type HubConnectionActionKind = 'CONNECT' | 'TEST' | 'DISCONNECT' | 'DIAGNOSE';

export interface HubConnectionActionRequest {
  action: HubConnectionActionKind;
}

export interface HubConnectionResponse {
  hubConnectionId: string;
  displayName?: string | null;
  baseUrl?: string | null;
  scope?: 'USER' | 'PROJECT' | null;
  projectId?: string | null;
  enabled?: boolean | null;
  revision?: number | null;
  connectionState?: 'STOPPED' | 'CONNECTING' | 'READY' | 'FAILED' | 'DISABLED' | null;
  stateReason?: string | null;
  credentialConfigured?: boolean | null;
  insecureLoopback?: boolean | null;
  hubVersion?: string | null;
  apiVersion?: string | null;
  platform?: string | null;
  providerKinds?: string[] | null;
  catalogRevision?: number | null;
  lastDiagnosis?: string | null;
  managedServerId?: string | null;
  createdAt?: number | null;
  updatedAt?: number | null;
}

export interface ServiceClientOptions {
  baseUrl: string;
  token: string;
  /** Short-lived Service client-session secret; never persisted or exposed to renderer. */
  clientSessionToken?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/** Open event-stream handle from `personalTaskEventStream` — caller owns the
 * body (reader + abort) and must never treat it as a JSON envelope. */
export interface PersonalStreamResponse {
  status: number;
  headers: Headers;
  body: ReadableStream<Uint8Array>;
}

export interface ClientSessionRegistrationRequest {
  registrationKey: string;
  clientId: string;
  processInstanceId: string;
  clientKind: 'ELECTRON' | 'WEB_TAB' | 'CLI' | 'SWING';
  protocols: string[];
  displayLabel?: string;
}

export interface ClientSessionRegistrationResponse {
  clientSessionId: string;
  clientSessionToken: string;
  storeId: string;
  bootId: string;
  ttlMillis: number;
  remainingTtlMillis: number;
  replay?: boolean;
  acceptedProtocols: string[];
}

export interface ClientSessionHeartbeatResponse {
  clientSessionId: string;
  serverTimeMillis: number;
  remainingTtlMillis: number;
}

/** WU-12: bounded image bytes forwarded only after an explicit preview. */
export interface SessionAttachmentBytesResponse {
  mediaType: 'image/png' | 'image/jpeg' | (string & {});
  dataBase64: string;
  sizeBytes: number;
}

export type { OperationLookupRequest, OperationReceiptResponse } from '../../protocol/src/index.js';

// Personal gateway contract (PAE P0 freeze §4): the bounded-operation
// whitelist plus every DTO consumers need for typed ports.
export {
  PERSONAL_API_PREFIX,
  PERSONAL_ROUTES,
  validPersonalOperation,
  validPersonalEnvelope,
  decodePersonalError
} from '../../protocol/src/personal';
export type {
  PersonalOperation,
  PersonalEnvelope,
  PersonalMeta,
  PersonalErrorBody,
  PersonalOverview,
  PersonalAttentionItem,
  PersonalProjectView,
  PersonalProjectRegistrationRequest,
  PersonalProjectRegistrationInput,
  PersonalEnvironmentRequirement,
  PersonalEnvironmentFact,
  ProjectEnvironmentView,
  PersonalToolchainSelection,
  PersonalEnvironmentPlanRequest,
  PersonalEnvironmentPlanInput,
  PersonalEnvironmentPlanPreview,
  PersonalPlanStepView,
  PersonalEnvironmentOperationRequest,
  PersonalEnvironmentOperationInput,
  PersonalOperationCancelRequest,
  PersonalOperationCancelInput,
  PersonalOperationAccepted,
  PersonalEnvironmentOperation,
  PersonalOperationEvent,
  PersonalOperationEventsPage,
  PersonalWorkerCapabilities,
  PersonalWorkerView,
  AdaptiveActionDescriptor,
  PersonalActionRunRequest,
  PersonalActionRunInput,
  PersonalActionSaveRequest,
  PersonalActionSaveInput,
  ActionTrialReceiptView,
  PersonalReportRequest,
  PersonalReportInput,
  ReportDescriptor,
  PersonalReportFile,
  PersonalConnectionKind,
  EnvironmentOperationState,
  EnvironmentOperationKind,
  EnvironmentReasonCode,
  EnvironmentBackendPreference,
  EnvironmentReadinessFactKind,
  ProjectedCheckStatus,
  AdaptiveActionScope,
  PersonalCapabilityName
} from '../../protocol/src/personal';

export interface EventSnapshotOptions {
  scopeId?: string;
  pageSize?: number;
  snapshotToken?: string;
}

export interface InterruptOptions {
  idempotencyKey?: string;
  expectedStateVersion?: number;
}

interface PendingCommandApproval {
  approvalId?: string;
  fingerprint?: string;
}

interface PendingSandboxApproval {
  approvalId?: string;
  fingerprint?: string;
  productRunId?: string;
  invocationId?: string;
  scriptSha256?: string;
  scriptByteLength?: number;
  scriptRedactedPreview?: string;
  shell?: string;
  workingDirectoryRelative?: string;
  timeoutMillis?: number;
  backendType?: string;
  providerId?: string;
  contextName?: string;
  imageDigest?: string;
  isolationLevel?: string;
  networkPolicy?: string;
  environmentVariableNames?: string[];
  expiresAtMillis?: number;
}

interface PendingTerminalApproval {
  approvalId?: string;
  fingerprint?: string;
  businessSessionId?: string;
  runId?: string;
  workspaceExecutionId?: string;
  workspaceLineageId?: string;
  agentReadAllowed?: boolean;
  agentInputAllowed?: boolean;
  executable?: string;
  arguments?: string[];
  workingDirectory?: string;
  columns?: number;
  rows?: number;
  lifetimeScope?: string;
  inputPolicy?: string;
  terminalMode?: string;
  profile?: string;
  networkIntent?: string;
  maxLifetimeMillis?: number;
  createdAtMillis?: number;
  expiresAtMillis?: number;
}

interface TerminalApprovalDecision {
  decision: 'APPROVE' | 'REJECT';
}

function generateIdempotencyKey(): string {
  return crypto.randomUUID();
}

// Session admission/message acceptance currently crosses the Java scheduler
// boundary.  Keep a bounded but longer deadline than the generic 10s read
// timeout so normal scheduler back-pressure is not reported as a renderer
// failure.  The renderer still treats an expiry as an unknown outcome and
// retries with the same idempotency key.
const SESSION_MUTATION_TIMEOUT_MS = 30_000;
// Ordinary chat executes the model synchronously. A process approval can be
// open for the service-configured approval window (300s by default), so the
// message transport must stay alive long enough for the user's decision.
const SESSION_MESSAGE_TIMEOUT_MS = 300_000;

export class ServiceClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly clientSessionToken?: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: ServiceClientOptions) {
    if (!options.baseUrl || !options.token) {
      throw new Error('baseUrl and token are required');
    }
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.token = options.token;
    this.clientSessionToken = options.clientSessionToken;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 10_000;
  }

  /**
   * Capability handshake with runtime validation and fail-closed
   * compatibility check (desktop design §9.2).
   */
  async getCapabilities(): Promise<ValidatedCapabilities> {
    const body = await this.requestJson('GET', '/api/v2/capabilities');
    const validated = validateCapabilities(body);
    const compatibility = checkServiceCompatibility(validated);
    if (!compatibility.compatible) {
      throw new ProtocolIncompatible(compatibility.reason, compatibility.detail);
    }
    return validated;
  }

  async registerClientSession(
    request: ClientSessionRegistrationRequest,
    idempotencyKey = request.registrationKey
  ): Promise<ClientSessionRegistrationResponse> {
    const response = await this.requestJson<ClientSessionRegistrationResponse>(
      'POST', '/api/v2/client-sessions', request, idempotencyKey,
      { omitClientSessionToken: true }
    );
    if (!response || typeof response.clientSessionId !== 'string'
        || typeof response.clientSessionToken !== 'string'
        || response.clientSessionToken.length < 32
        || typeof response.storeId !== 'string' || typeof response.bootId !== 'string'
        || !Array.isArray(response.acceptedProtocols)) {
      throw new ServiceProblem('PROTOCOL_ERROR', 200,
        'client session registration response is invalid', {});
    }
    return response;
  }

  async heartbeatClientSession(
    clientSessionId: string,
    idempotencyKey = generateIdempotencyKey()
  ): Promise<ClientSessionHeartbeatResponse> {
    return this.requestJson<ClientSessionHeartbeatResponse>(
      'POST', `/api/v2/client-sessions/${enc(clientSessionId)}/heartbeat`,
      undefined, idempotencyKey
    );
  }

  async revokeClientSession(clientSessionId: string): Promise<void> {
    await this.requestJson<void>('DELETE', `/api/v2/client-sessions/${enc(clientSessionId)}`);
  }

  async getOperationReceipt(receiptId: string): Promise<OperationReceiptResponse> {
    return this.requestJson<OperationReceiptResponse>(
      'GET', `/api/v2/operations/${enc(receiptId)}`
    );
  }

  async lookupOperationReceipt(
    request: OperationLookupRequest
  ): Promise<OperationReceiptResponse> {
    return this.requestJson<OperationReceiptResponse>(
      'POST', '/api/v2/operations/lookup', request, request.idempotencyKey
    );
  }

  /** Read a bounded, scope-bound event snapshot at a fixed high-water mark. */
  async getEventSnapshot(
    scopeType: 'GLOBAL' | 'SESSION' | 'MISSION',
    options: EventSnapshotOptions = {}
  ): Promise<EventSnapshotResponse> {
    const params = new URLSearchParams({ scopeType });
    if (options.scopeId) params.set('scopeId', options.scopeId);
    if (options.pageSize !== undefined) params.set('pageSize', String(options.pageSize));
    if (options.snapshotToken) params.set('snapshotToken', options.snapshotToken);
    return this.requestJson<EventSnapshotResponse>(
      'GET', `/api/v2/event-snapshots?${params.toString()}`
    );
  }

  async listProjects(): Promise<ProjectSummary[]> {
    const body = await this.requestJson('GET', '/api/v2/projects');
    if (!Array.isArray(body)) throw new ServiceProblem('PROTOCOL_ERROR', 0, 'projects list must be an array', {});
    return body as ProjectSummary[];
  }

  async getProject(projectId: string): Promise<ProjectSummary> {
    return (await this.requestJson('GET', `/api/v2/projects/${enc(projectId)}`)) as ProjectSummary;
  }

  async getProjectStatus(projectId: string): Promise<ProjectStatus> {
    return (await this.requestJson('GET', `/api/v2/projects/${enc(projectId)}/status`)) as ProjectStatus;
  }

  async getProjectSessionPreflight(projectId: string): Promise<ProjectSessionPreflight> {
    return (await this.requestJson(
      'GET',
      `/api/v2/projects/${enc(projectId)}/session-preflight`
    )) as ProjectSessionPreflight;
  }

  async registerProject(
    request: ProjectRegistrationRequest,
    idempotencyKey = generateIdempotencyKey()
  ): Promise<ProjectRegistrationResponse> {
    return (await this.requestJson('POST', '/api/v2/projects/registrations', request, idempotencyKey)) as ProjectRegistrationResponse;
  }

  async createNativeOpenIntent(
    projectId: string,
    action: 'REVEAL' | 'IDE' | 'USER_TERMINAL' = 'REVEAL',
    idempotencyKey = generateIdempotencyKey()
  ): Promise<NativeOpenIntent> {
    return (await this.requestJson(
      'POST',
      `/api/v2/projects/${enc(projectId)}/native-open-intents`,
      { action },
      idempotencyKey
    )) as NativeOpenIntent;
  }

  // ---- Build-plan surface (design 2026-09-26 §7.2) ----
  // Plan views are resolver dry runs — no process ever spawns from
  // these endpoints.

  async getProjectBuildPlan(projectId: string): Promise<ProjectBuildPlanResponse> {
    return (await this.requestJson('GET',
      `/api/v2/projects/${enc(projectId)}/build-plan`)) as ProjectBuildPlanResponse;
  }

  async putProjectBuildPlanOverride(projectId: string, request: BuildPlanOverrideRequest,
      idempotencyKey = generateIdempotencyKey()): Promise<BuildPlanOverrideResponse> {
    return (await this.requestJson('PUT',
      `/api/v2/projects/${enc(projectId)}/build-plan/overrides`, request, idempotencyKey)) as BuildPlanOverrideResponse;
  }

  async previewProjectBuildPlan(projectId: string, request: BuildPlanOverrideRequest,
      idempotencyKey = generateIdempotencyKey()): Promise<BuildPlanPreviewResponse> {
    return (await this.requestJson('POST',
      `/api/v2/projects/${enc(projectId)}/build-plan/preview`, request, idempotencyKey)) as BuildPlanPreviewResponse;
  }

  // ---- Verification-profile surface (design 2026-09-26 §7.4/§10.2) ----

  async listProjectVerificationProfiles(projectId: string): Promise<VerificationProfileListResponse> {
    return (await this.requestJson('GET',
      `/api/v2/projects/${enc(projectId)}/verification-profiles`)) as VerificationProfileListResponse;
  }

  async putProjectVerificationProfile(projectId: string, profileId: string,
      request: VerificationProfileRequest,
      idempotencyKey = generateIdempotencyKey()): Promise<VerificationProfileView> {
    return (await this.requestJson('PUT',
      `/api/v2/projects/${enc(projectId)}/verification-profiles/${enc(profileId)}`,
      request, idempotencyKey)) as VerificationProfileView;
  }

  async listRuns(query: RunListQuery = {}): Promise<RunListResponse> {
    const params = new URLSearchParams();
    if (query.workspaceAlias) params.set('workspaceAlias', query.workspaceAlias);
    if (query.sessionId) params.set('sessionId', query.sessionId);
    if (query.limit !== undefined) params.set('limit', String(query.limit));
    const suffix = params.toString() ? `?${params.toString()}` : '';
    return validateRunListResponse(await this.requestJson('GET', `/api/v2/runs${suffix}`)) as RunListResponse;
  }

  /** Authoritative scheduler projection; clients never schedule locally. */
  async getSchedulerOverview(): Promise<SchedulerOverviewResponse> {
    return validateSchedulerOverview(
      await this.requestJson('GET', '/api/v2/scheduler/overview')
    ) as SchedulerOverviewResponse;
  }

  /** Authoritative run view; terminal state is only ever taken from here. */
  async getRun(runId: string): Promise<ValidatedRunStateResponse> {
    const body = await this.requestJson('GET', `/api/v2/runs/${enc(runId)}`);
    return validateRunStateResponse(body);
  }

  async interruptRun(
    runId: string,
    options: InterruptOptions = {}
  ): Promise<ValidatedRunStateResponse> {
    const body = await this.requestJson(
      'POST',
      `/api/v2/runs/${enc(runId)}/interrupt`,
      { expectedStateVersion: options.expectedStateVersion ?? null },
      options.idempotencyKey ?? generateIdempotencyKey()
    );
    return validateRunStateResponse(body);
  }

  async controlRun(
    runId: string,
    request: RunControlRequest,
    idempotencyKey = generateIdempotencyKey()
  ): Promise<ValidatedRunStateResponse> {
    const body = await this.requestJson(
      'POST',
      `/api/v2/runs/${enc(runId)}/controls`,
      request,
      idempotencyKey
    );
    return validateRunStateResponse(body);
  }

  // ---- Reliable run commands (run-command/1) ----
  // commandId == the Idempotency-Key: callers pass the same key they placed
  // in request.commandId so a retried submit replays the durable receipt.
  // Receipts are validated fail-closed; receiptRevision stays a decimal
  // string (compare via receiptRevisionValue, never as a number).

  async submitRunCommand(
    runId: string,
    request: RunCommandRequest,
    key: string
  ): Promise<RunCommandReceipt> {
    const body = await this.requestJson(
      'POST',
      `/api/v2/runs/${enc(runId)}/commands`,
      request,
      key
    );
    return validateRunCommandReceipt(body);
  }

  async getRunCommand(runId: string, commandId: string): Promise<RunCommandReceipt> {
    const body = await this.requestJson('GET', `/api/v2/runs/${enc(runId)}/commands/${enc(commandId)}`);
    return validateRunCommandReceipt(body);
  }

  async listRunCommands(
    runId: string,
    query: { limit?: number; before?: string } = {}
  ): Promise<RunCommandPage> {
    const params = new URLSearchParams();
    if (query.limit !== undefined) params.set('limit', String(query.limit));
    if (query.before) params.set('before', query.before);
    const suffix = params.size > 0 ? `?${params.toString()}` : '';
    const body = await this.requestJson('GET', `/api/v2/runs/${enc(runId)}/commands${suffix}`);
    return validateRunCommandPage(body);
  }

  /** Narrow typed read over the FOUNDATION collaboration channel — pins
   * session-foundation/1 and the capabilities map (commandReceiptV1). */
  async getSessionFoundation(sessionId: string): Promise<ValidatedSessionFoundation> {
    return validateSessionFoundation(
      await this.collaboration({ action: 'FOUNDATION', subjectId: sessionId })
    );
  }

  /**
   * WU-05 (design §6.5): create the linked continuation run once the run's
   * workspace attention is cleared; server rejects with
   * RUN_ATTENTION_NOT_CLEARED while conflicts remain open.
   */
  async continueRun(
    runId: string,
    options: { expectedStateVersion?: number | null; message?: string | null } = {},
    idempotencyKey = generateIdempotencyKey()
  ): Promise<ValidatedRunStateResponse> {
    const body = await this.requestJson(
      'POST',
      `/api/v2/runs/${enc(runId)}/continue`,
      {
        expectedStateVersion: options.expectedStateVersion ?? null,
        message: options.message ?? null
      },
      idempotencyKey
    );
    return validateRunStateResponse(body);
  }

  async getRunEvidence(runId: string): Promise<EvidenceBundleResponse> {
    return (await this.requestJson('GET', `/api/v2/runs/${enc(runId)}/evidence`)) as EvidenceBundleResponse;
  }

  async getModelCatalog(): Promise<ModelCatalogResponse> {
    return (await this.requestJson('GET', '/api/v2/model-catalog')) as ModelCatalogResponse;
  }

  // ---- Settings environment surface (settings design) ----
  // Feature cards carry desired/effective state plus preflight actions;
  // writes persist to the control-plane database and apply at restart.

  async getEnvironmentFeatures(): Promise<EnvironmentFeaturesResponse> {
    return (await this.requestJson('GET', '/api/v2/environment/features')) as EnvironmentFeaturesResponse;
  }

  async updateEnvironmentFeature(featureId: string, request: EnvironmentFeatureUpdateRequest,
      idempotencyKey = generateIdempotencyKey()): Promise<EnvironmentFeatureCard> {
    return (await this.requestJson('PUT',
      `/api/v2/environment/features/${enc(featureId)}`, request, idempotencyKey)) as EnvironmentFeatureCard;
  }

  async preflightEnvironmentFeature(featureId: string,
      idempotencyKey = generateIdempotencyKey()): Promise<EnvironmentFeatureCard> {
    return (await this.requestJson('POST',
      `/api/v2/environment/features/${enc(featureId)}/preflight`, {}, idempotencyKey)) as EnvironmentFeatureCard;
  }

  async listManagedModelProviders(): Promise<ManagedModelProvidersResponse> {
    return (await this.requestJson('GET', '/api/v2/model-providers')) as ManagedModelProvidersResponse;
  }

  async probeRemoteProviderModels(request: RemoteModelsProbeRequest): Promise<RemoteModelsProbeResponse> {
    return (await this.requestJson('POST',
      '/api/v2/model-providers/remote-models', request)) as RemoteModelsProbeResponse;
  }

  async upsertModelProvider(providerId: string, request: ManagedModelProviderRequest,
      idempotencyKey = generateIdempotencyKey()): Promise<ManagedModelProvider> {
    return (await this.requestJson('PUT',
      `/api/v2/model-providers/${enc(providerId)}`, request, idempotencyKey)) as ManagedModelProvider;
  }

  async deleteModelProvider(providerId: string, expectedRevision?: number,
      idempotencyKey = generateIdempotencyKey(),
      replaceDefault?: string): Promise<ManagedDeleteResponse> {
    const params = new URLSearchParams();
    if (expectedRevision !== undefined) params.set('expectedRevision', String(expectedRevision));
    if (replaceDefault) params.set('replaceDefault', replaceDefault);
    const query = params.size > 0 ? `?${params.toString()}` : '';
    return (await this.requestJson('DELETE',
      `/api/v2/model-providers/${enc(providerId)}${query}`, undefined, idempotencyKey)) as ManagedDeleteResponse;
  }

  async upsertProviderModel(providerId: string, modelId: string, request: ManagedModelRequest,
      idempotencyKey = generateIdempotencyKey()): Promise<ManagedModel> {
    return (await this.requestJson('PUT',
      `/api/v2/model-providers/${enc(providerId)}/models/${enc(modelId)}`,
      request, idempotencyKey)) as ManagedModel;
  }

  async deleteProviderModel(providerId: string, modelId: string, expectedRevision?: number,
      idempotencyKey = generateIdempotencyKey(),
      replaceDefault?: string): Promise<ManagedDeleteResponse> {
    const params = new URLSearchParams();
    if (expectedRevision !== undefined) params.set('expectedRevision', String(expectedRevision));
    if (replaceDefault) params.set('replaceDefault', replaceDefault);
    const query = params.size > 0 ? `?${params.toString()}` : '';
    return (await this.requestJson('DELETE',
      `/api/v2/model-providers/${enc(providerId)}/models/${enc(modelId)}${query}`,
      undefined, idempotencyKey)) as ManagedDeleteResponse;
  }

  // ---- Web-search records (V026) ----

  async listWebSearchProviders(): Promise<WebSearchProvidersResponse> {
    return (await this.requestJson('GET', '/api/v2/web-search-providers')) as WebSearchProvidersResponse;
  }

  async upsertWebSearchProvider(providerId: string, request: WebSearchProviderRequest,
      idempotencyKey = generateIdempotencyKey()): Promise<WebSearchProvider> {
    return (await this.requestJson('PUT',
      `/api/v2/web-search-providers/${enc(providerId)}`, request, idempotencyKey)) as WebSearchProvider;
  }

  async deleteWebSearchProvider(providerId: string, expectedRevision?: number,
      idempotencyKey = generateIdempotencyKey()): Promise<ManagedDeleteResponse> {
    const params = new URLSearchParams();
    if (expectedRevision !== undefined) params.set('expectedRevision', String(expectedRevision));
    const query = params.size > 0 ? `?${params.toString()}` : '';
    return (await this.requestJson('DELETE',
      `/api/v2/web-search-providers/${enc(providerId)}${query}`,
      undefined, idempotencyKey)) as ManagedDeleteResponse;
  }

  async listAgentProfiles(): Promise<AgentProfilesResponse> {
    return (await this.requestJson('GET', '/api/v2/agent-profiles')) as AgentProfilesResponse;
  }

  // ---- Session v2 ----

  async listSessions(): Promise<SessionResponse[]> {
    return (await this.requestJson('GET', '/api/v2/sessions')) as SessionResponse[];
  }

  async createSession(request: SessionCreateRequest, idempotencyKey = generateIdempotencyKey()): Promise<SessionResponse> {
    return (await this.requestJson(
      'POST',
      '/api/v2/sessions',
      request,
      idempotencyKey,
      { timeoutMs: SESSION_MUTATION_TIMEOUT_MS }
    )) as SessionResponse;
  }

  async writableCollaboration(operation: WritableOperation): Promise<WritableResponse> {
    if (!validWritableOperation(operation)) throw new Error('Invalid bounded writable collaboration operation');
    const route = WRITABLE_ROUTES[operation.action];
    if (operation.action === 'ACTIVITY') return this.requestJson('GET', `/api/v2/runs/${enc(operation.runId)}/collaboration-activity`) as Promise<WritableResponse>;
    const tail = route.tail.replace('{group}', 'groupId' in operation ? enc(operation.groupId) : '').replace('{entity}', 'entityId' in operation ? enc(operation.entityId) : '');
    let path = `/api/v2/runs/${enc(operation.runId)}/collaboration-groups${tail}`;
    if (operation.action === 'CANDIDATE_FILES' || operation.action === 'PREVIEW_FILES') { const query = new URLSearchParams(); for (const field of ['path', 'offset', 'limit'] as const) if (operation[field] !== undefined) query.set(field, operation[field]); if (operation.action === 'PREVIEW_FILES') { if (operation.side) query.set('side', operation.side); if (operation.unitId) query.set('unitId', operation.unitId); } if (query.size) path += `?${query}`; }
    // Paused adoption performs the real project verification before returning.
    // A normal RPC timeout must not turn a successful Maven build into an unknown outcome.
    const verification = operation.action === 'ADOPT' || operation.action === 'RECOVER_ADOPTION';
    return this.requestJson(route.method, path, 'body' in operation ? operation.body : undefined, 'key' in operation ? operation.key : undefined,
      verification ? { timeoutMs: 180_000 } : undefined) as Promise<WritableResponse>;
  }

  async collaboration(operation: CollaborationOperation): Promise<CollaborationResource> {
    const sid = `/api/v2/sessions/${enc(operation.subjectId)}`;
    const rid = `/api/v2/runs/${enc(operation.subjectId)}`;
    const get = (path: string) => this.requestJson('GET', path) as Promise<CollaborationResource>;
    const post = (path: string, body: object | undefined, key?: string) => this.requestJson('POST', path, body, key) as Promise<CollaborationResource>;
    switch (operation.action) {
      case 'FOUNDATION': return get(`${sid}/foundation`);
      case 'SEGMENTS': return get(`${rid}/execution-segments`);
      case 'AUX_LIST': return get(`${sid}/auxiliary-sessions`);
      case 'TURN_LIST': return get(`${sid}/auxiliary-turns`);
      case 'BOUNDARIES': return get(`${rid}/boundary-requests`);
      case 'HANDOFFS': return get(`${rid}/assignment-transitions`);
      case 'FREEZE_SNAPSHOT': return post(`${sid}/observation-snapshots`, operation.body, operation.key);
      case 'CREATE_PACKAGE': return post(`${sid}/context-packages`, operation.body, operation.key);
      case 'PACKAGE': return get(`${sid}/context-packages/${enc(operation.entityId)}`);
      case 'CREATE_AUX': return post(`${sid}/auxiliary-sessions`, operation.body, operation.key);
      case 'TURN': return post(`${sid}/auxiliary-turns`, operation.body, operation.key);
      case 'TURN_RESULT': return get(`${sid}/auxiliary-turns/${enc(operation.entityId)}`);
      case 'CANCEL_TURN': return post(`${sid}/auxiliary-turns/${enc(operation.entityId)}/cancel`, undefined, operation.key);
      case 'BOUNDARY': return post(`${rid}/boundary-requests`, operation.body, operation.key);
      case 'CANCEL_BOUNDARY': return post(`${rid}/boundary-requests/${enc(operation.entityId)}/cancel`, undefined, operation.key);
      case 'BOUNDARY_RESULT': return get(`${rid}/boundary-requests/${enc(operation.entityId)}`);
      case 'PREFLIGHT': return post(`${rid}/assignment-transitions/preflight`, operation.body);
      case 'HANDOFF': return post(`${rid}/assignment-transitions`, operation.body, operation.key);
      case 'CANCEL_HANDOFF': return post(`${rid}/assignment-transitions/${enc(operation.entityId)}/cancel`, undefined, operation.key);
      case 'HANDOFF_RESULT': return get(`${rid}/assignment-transitions/${enc(operation.entityId)}`);
    }
  }

  async getSession(sessionId: string): Promise<SessionResponse> {
    return (await this.requestJson('GET', `/api/v2/sessions/${enc(sessionId)}`)) as SessionResponse;
  }

  // ---- Session history pagination (2026-09-05 design §5.1) ----
  // The service gates these endpoints behind a capability; a 404 here means
  // the feature is missing on the wire, which the renderer treats as
  // capability-unavailable, never as a legacy-protocol fallback trigger.

  async listSessionSummaries(query: {
    workspaceAlias?: string;
    archived?: 'ACTIVE' | 'ARCHIVED' | 'ALL';
    q?: string;
    limit?: number;
    cursor?: string;
  } = {}): Promise<SessionSummaryPageResponse> {
    const params = new URLSearchParams();
    if (query.workspaceAlias) params.set('workspaceAlias', query.workspaceAlias);
    if (query.archived) params.set('archived', query.archived);
    if (query.q) params.set('q', query.q);
    if (typeof query.limit === 'number') params.set('limit', String(query.limit));
    if (query.cursor) params.set('cursor', query.cursor);
    const suffix = params.toString() ? `?${params.toString()}` : '';
    return (await this.requestJson('GET', `/api/v2/sessions/summaries${suffix}`)) as SessionSummaryPageResponse;
  }

  async getSessionSummary(sessionId: string, options?: { refreshEnvironment?: boolean }): Promise<SessionSummaryDetail> {
    const suffix = options?.refreshEnvironment ? '?probe=refresh' : '';
    return (await this.requestJson('GET', `/api/v2/sessions/${enc(sessionId)}/summary${suffix}`)) as SessionSummaryDetail;
  }

  async getSessionMetadata(sessionId: string): Promise<SessionMetadataResponse> {
    return (await this.requestJson('GET', `/api/v2/sessions/${enc(sessionId)}/metadata`)) as SessionMetadataResponse;
  }

  async pageSessionMessages(sessionId: string, query: {
    limit?: number;
    cursor?: string;
    aroundMessageId?: string;
  } = {}): Promise<SessionMessagePageResponse> {
    const params = new URLSearchParams();
    if (typeof query.limit === 'number') params.set('limit', String(query.limit));
    if (query.cursor) params.set('cursor', query.cursor);
    if (query.aroundMessageId) params.set('aroundMessageId', query.aroundMessageId);
    const suffix = params.toString() ? `?${params.toString()}` : '';
    return (await this.requestJson('GET', `/api/v2/sessions/${enc(sessionId)}/messages${suffix}`)) as SessionMessagePageResponse;
  }

  async getMessageContentPage(sessionId: string, messageId: string, query: {
    cursor?: string;
    maxBytes?: number;
  } = {}): Promise<MessageContentPageResponse> {
    const params = new URLSearchParams();
    if (query.cursor) params.set('cursor', query.cursor);
    if (typeof query.maxBytes === 'number') params.set('maxBytes', String(query.maxBytes));
    const suffix = params.toString() ? `?${params.toString()}` : '';
    return (await this.requestJson('GET',
      `/api/v2/sessions/${enc(sessionId)}/messages/${enc(messageId)}/content${suffix}`)) as MessageContentPageResponse;
  }

  async patchSession(sessionId: string, request: SessionPatchRequest, idempotencyKey = generateIdempotencyKey()): Promise<SessionResponse> {
    return (await this.requestJson(
      'PATCH',
      `/api/v2/sessions/${enc(sessionId)}`,
      request,
      idempotencyKey
    )) as SessionResponse;
  }

  async sendSessionMessage(
    sessionId: string,
    request: SessionMessageRequest,
    idempotencyKey = generateIdempotencyKey()
  ): Promise<SessionMessageResponse> {
    return (await this.requestJson(
      'POST',
      `/api/v2/sessions/${enc(sessionId)}/messages`,
      request,
      idempotencyKey,
      { timeoutMs: SESSION_MESSAGE_TIMEOUT_MS }
    )) as SessionMessageResponse;
  }

  /**
   * 长输入设计 §6.3：已接受附件的内容读取（text/plain；
   * Markdown 不在下载页解释为 HTML；Cache-Control: no-store 由服务返回）。
   */
  async getSessionAttachmentContent(
    sessionId: string,
    messageId: string,
    attachmentId: string
  ): Promise<string> {
    return this.requestText(
      'GET',
      `/api/v2/sessions/${enc(sessionId)}/messages/${enc(messageId)}/attachments/${enc(attachmentId)}/content`
    );
  }

  /** Image previews use the service-owned bytes route on demand. */
  async getSessionAttachmentBytes(
    sessionId: string,
    messageId: string,
    attachmentId: string
  ): Promise<SessionAttachmentBytesResponse> {
    const response = await this.requestBytes(
      'GET',
      `/api/v2/sessions/${enc(sessionId)}/messages/${enc(messageId)}/attachments/${enc(attachmentId)}/bytes`
    );
    return {
      mediaType: response.mediaType,
      dataBase64: Buffer.from(response.bytes).toString('base64'),
      sizeBytes: response.bytes.byteLength
    };
  }

  async forkSession(sessionId: string, request: SessionForkRequest, idempotencyKey = generateIdempotencyKey()): Promise<SessionResponse> {
    return (await this.requestJson(
      'POST',
      `/api/v2/sessions/${enc(sessionId)}/forks`,
      request,
      idempotencyKey
    )) as SessionResponse;
  }

  async archiveSession(sessionId: string, request: SessionArchiveRequest, idempotencyKey = generateIdempotencyKey()): Promise<SessionResponse> {
    return (await this.requestJson(
      'POST',
      `/api/v2/sessions/${enc(sessionId)}/archive`,
      request,
      idempotencyKey
    )) as SessionResponse;
  }

  async listAttention(): Promise<AttentionItem[]> {
    const body = (await this.requestJson('GET', '/api/v2/attention')) as { items?: AttentionItem[] };
    return body.items ?? [];
  }

  // ---- Stateful terminal sessions (terminal capability design §9) ----

  async listTerminalSessions(businessSessionId: string): Promise<TerminalSessionResponse[]> {
    const body = await this.requestJson(
      'GET',
      `/api/v2/sessions/${enc(businessSessionId)}/terminal-sessions`
    );
    if (!Array.isArray(body)) throw new ServiceProblem('PROTOCOL_ERROR', 0, 'terminal sessions must be an array', {});
    return body.map(validateTerminalSessionResponse) as TerminalSessionResponse[];
  }

  async createTerminalSession(
    businessSessionId: string,
    request: TerminalSessionCreateRequest,
    idempotencyKey = generateIdempotencyKey()
  ): Promise<TerminalSessionResponse> {
    return (await this.requestJson(
      'POST',
      `/api/v2/sessions/${enc(businessSessionId)}/terminal-sessions`,
      request,
      idempotencyKey
    )) as TerminalSessionResponse;
  }

  async getTerminalSession(terminalSessionId: string): Promise<TerminalSessionResponse> {
    return validateTerminalSessionResponse(await this.requestJson(
      'GET',
      `/api/v2/terminal-sessions/${enc(terminalSessionId)}`
    )) as TerminalSessionResponse;
  }

  async getTerminalOutput(
    terminalSessionId: string,
    options: {
      cursor?: string;
      maxBytes?: number;
      waitMillis?: number;
      mode?: TerminalOutputMode;
    } = {}
  ): Promise<TerminalOutputResponse> {
    const params = new URLSearchParams();
    if (options.cursor) params.set('cursor', options.cursor);
    if (options.maxBytes !== undefined) params.set('maxBytes', String(options.maxBytes));
    if (options.waitMillis !== undefined) params.set('waitMillis', String(options.waitMillis));
    if (options.mode) params.set('mode', options.mode);
    const suffix = params.toString() ? `?${params.toString()}` : '';
    return validateTerminalOutputResponse(await this.requestJson(
      'GET',
      `/api/v2/terminal-sessions/${enc(terminalSessionId)}/output${suffix}`
    )) as TerminalOutputResponse;
  }

  async writeTerminalInput(
    terminalSessionId: string,
    request: TerminalInputRequest,
    // Business binds the transport idempotency key to operationId so a
    // retry cannot accidentally replay a different input payload.
    idempotencyKey = request.operationId
  ): Promise<TerminalInputResponse> {
    return (await this.requestJson(
      'POST',
      `/api/v2/terminal-sessions/${enc(terminalSessionId)}/input`,
      request,
      idempotencyKey
    )) as TerminalInputResponse;
  }

  async resizeTerminalSession(
    terminalSessionId: string,
    request: TerminalResizeRequest,
    // Terminal mutations bind the transport idempotency key to the request
    // operationId. Using a fresh key here makes every resize fail validation
    // before the PTY can receive its new dimensions.
    idempotencyKey = request.operationId
  ): Promise<TerminalResizeResponse> {
    return (await this.requestJson(
      'POST',
      `/api/v2/terminal-sessions/${enc(terminalSessionId)}/resize`,
      request,
      idempotencyKey
    )) as TerminalResizeResponse;
  }

  async signalTerminalSession(
    terminalSessionId: string,
    request: TerminalSignalRequest,
    idempotencyKey = request.operationId
  ): Promise<TerminalSignalResponse> {
    return (await this.requestJson(
      'POST',
      `/api/v2/terminal-sessions/${enc(terminalSessionId)}/signals`,
      request,
      idempotencyKey
    )) as TerminalSignalResponse;
  }

  async acquireTerminalControl(
    terminalSessionId: string,
    request: TerminalControlAcquireRequest,
    idempotencyKey = request.operationId
  ): Promise<TerminalControlResponse> {
    return (await this.requestJson(
      'POST',
      `/api/v2/terminal-sessions/${enc(terminalSessionId)}/control/acquire`,
      request,
      idempotencyKey
    )) as TerminalControlResponse;
  }

  async renewTerminalControl(
    terminalSessionId: string,
    request: TerminalControlRenewRequest,
    idempotencyKey = request.operationId
  ): Promise<TerminalControlResponse> {
    return (await this.requestJson(
      'POST',
      `/api/v2/terminal-sessions/${enc(terminalSessionId)}/control/renew`,
      request,
      idempotencyKey
    )) as TerminalControlResponse;
  }

  async releaseTerminalControl(
    terminalSessionId: string,
    request: TerminalControlReleaseRequest,
    idempotencyKey = request.operationId
  ): Promise<TerminalControlResponse> {
    return (await this.requestJson(
      'POST',
      `/api/v2/terminal-sessions/${enc(terminalSessionId)}/control/release`,
      request,
      idempotencyKey
    )) as TerminalControlResponse;
  }

  async closeTerminalSession(
    terminalSessionId: string,
    request: TerminalCloseRequest,
    idempotencyKey = request.operationId
  ): Promise<TerminalCloseResponse> {
    return (await this.requestJson(
      'DELETE',
      `/api/v2/terminal-sessions/${enc(terminalSessionId)}`,
      request,
      idempotencyKey
    )) as TerminalCloseResponse;
  }

  // ---- Read-only external sources (EW10.2, design §10.9) ----

  /**
   * Fetch a read-only Web/issue/docs source through the Java Host adapter.
   * The response is always untrusted content with provenance; the timeout is
   * raised above the client default because the service allows up to three
   * redirect hops with its own connect/read timeouts.
   */
  async fetchSource(request: SourceFetchRequest, idempotencyKey = generateIdempotencyKey()): Promise<SourceFetchResponse> {
    return (await this.requestJson(
      'POST',
      '/api/v2/sources/fetch',
      request,
      idempotencyKey,
      { timeoutMs: 45_000 }
    )) as SourceFetchResponse;
  }

  // ---- Read-only MCP sources (EW10.3, design §10.6) ----

  /** Public-safe configured-server summaries; no command/env material. */
  async listMcpServers(): Promise<McpServerSummary[]> {
    const body = await this.requestJson('GET', '/api/v2/mcp/servers');
    if (!Array.isArray(body)) throw new ServiceProblem('PROTOCOL_ERROR', 0, 'mcp servers must be an array', {});
    return body as McpServerSummary[];
  }

  async listMcpResources(serverId: string): Promise<McpResourceDescriptor[]> {
    const body = await this.requestJson('GET', `/api/v2/mcp/servers/${enc(serverId)}/resources`);
    if (!Array.isArray(body)) throw new ServiceProblem('PROTOCOL_ERROR', 0, 'mcp resources must be an array', {});
    return body as McpResourceDescriptor[];
  }

  /** Resource content is untrusted data; the response always marks it so. */
  async readMcpResource(
    serverId: string,
    uri: string,
    idempotencyKey = generateIdempotencyKey()
  ): Promise<McpResourceReadResponse> {
    return (await this.requestJson(
      'POST',
      `/api/v2/mcp/servers/${enc(serverId)}/resources/read`,
      { uri },
      idempotencyKey,
      { timeoutMs: 30_000 }
    )) as McpResourceReadResponse;
  }

  // ---- Governed MCP surface (extension uplift WU03/WU07) ----

  /**
   * Governed server view (`?view=governed`): public-safe detail rows —
   * digests/counts/slot flags only, never executable text or env values.
   */
  async listMcpServersGoverned(): Promise<McpServerDetailResponse[]> {
    const body = await this.requestJson('GET', '/api/v2/mcp/servers?view=governed');
    if (!Array.isArray(body)) throw new ServiceProblem('PROTOCOL_ERROR', 0, 'mcp servers must be an array', {});
    return body as McpServerDetailResponse[];
  }

  /**
   * Register a configured server. The body carries slot NAMES only —
   * credential material is never sent to or stored in this client.
   */
  async createMcpServer(request: McpServerConfigRequest, idempotencyKey = generateIdempotencyKey()): Promise<McpServerDetailResponse> {
    return (await this.requestJson('POST', '/api/v2/mcp/servers', request, idempotencyKey)) as McpServerDetailResponse;
  }

  async getMcpServer(serverId: string): Promise<McpServerDetailResponse> {
    return (await this.requestJson('GET', `/api/v2/mcp/servers/${enc(serverId)}`)) as McpServerDetailResponse;
  }

  /** Mutable fields only; launch-affecting edits bump configRevision. */
  async updateMcpServer(serverId: string, request: McpServerUpdateRequest, idempotencyKey = generateIdempotencyKey()): Promise<McpServerDetailResponse> {
    return (await this.requestJson('PATCH', `/api/v2/mcp/servers/${enc(serverId)}`, request, idempotencyKey)) as McpServerDetailResponse;
  }

  async setMcpServerStatus(serverId: string, request: McpServerStatusRequest, idempotencyKey = generateIdempotencyKey()): Promise<McpServerDetailResponse> {
    return (await this.requestJson('POST', `/api/v2/mcp/servers/${enc(serverId)}/status`, request, idempotencyKey)) as McpServerDetailResponse;
  }

  /** CONNECT/TEST/DISCONNECT/RESTART — async; poll getMcpOperation. */
  async requestMcpConnectionAction(serverId: string, request: McpConnectionActionRequest, idempotencyKey = generateIdempotencyKey()): Promise<McpOperationResponse> {
    return (await this.requestJson('POST', `/api/v2/mcp/servers/${enc(serverId)}/connection-actions`, request, idempotencyKey)) as McpOperationResponse;
  }

  async getMcpOperation(operationId: string): Promise<McpOperationResponse> {
    return (await this.requestJson('GET', `/api/v2/mcp/operations/${enc(operationId)}`)) as McpOperationResponse;
  }

  /** Paged catalog snapshot tools; the response is McpToolListResponse, never a bare array. */
  async listMcpServerTools(serverId: string, options: {
    cursor?: string;
    limit?: number;
  } = {}): Promise<McpToolListResponse> {
    const params = new URLSearchParams();
    if (options.cursor) params.set('cursor', options.cursor);
    if (options.limit !== undefined) params.set('limit', String(options.limit));
    const suffix = params.size > 0 ? `?${params.toString()}` : '';
    return (await this.requestJson('GET',
      `/api/v2/mcp/servers/${enc(serverId)}/tools${suffix}`)) as McpToolListResponse;
  }

  async refreshMcpServerCatalog(serverId: string, idempotencyKey = generateIdempotencyKey()): Promise<McpOperationResponse> {
    return (await this.requestJson('POST', `/api/v2/mcp/servers/${enc(serverId)}/catalog-refresh`, {}, idempotencyKey)) as McpOperationResponse;
  }

  /**
   * OAuth public-client action (WU08/WU09): START returns a consent URL the
   * host opens externally plus an operationId to poll; tokens never leave
   * the service. CANCEL abandons the pending flow; REVOKE deletes the
   * stored credential slot.
   */
  async requestMcpAuthAction(serverId: string, request: McpAuthActionRequest,
      idempotencyKey = generateIdempotencyKey()): Promise<McpAuthActionResponse> {
    return (await this.requestJson('POST',
      `/api/v2/mcp/servers/${enc(serverId)}/auth-actions`, request, idempotencyKey,
      { timeoutMs: 30_000 })) as McpAuthActionResponse;
  }

  /** Capability-gated prompt catalog for one managed server. */
  async listMcpPrompts(serverId: string): Promise<McpPromptListResponse> {
    return (await this.requestJson('GET',
      `/api/v2/mcp/servers/${enc(serverId)}/prompts`)) as McpPromptListResponse;
  }

  /** Resolves a prompt's blocks — external untrusted content, never instructions. */
  async resolveMcpPrompt(serverId: string, request: McpPromptResolveRequest,
      idempotencyKey = generateIdempotencyKey()): Promise<McpPromptResolveResponse> {
    return (await this.requestJson('POST',
      `/api/v2/mcp/servers/${enc(serverId)}/prompts/resolve`, request, idempotencyKey,
      { timeoutMs: 30_000 })) as McpPromptResolveResponse;
  }

  /** Capability-gated resource-template list (RFC 6570 URI templates). */
  async listMcpResourceTemplates(serverId: string): Promise<McpResourceTemplateListResponse> {
    return (await this.requestJson('GET',
      `/api/v2/mcp/servers/${enc(serverId)}/resource-templates`)) as McpResourceTemplateListResponse;
  }

  // ---- Hub associations (capability uplift WU01, design §5) ----

  /** Fixed-base-URL Hub records; token material never crosses this client. */
  async listHubConnections(): Promise<HubConnectionResponse[]> {
    const body = await this.requestJson('GET', '/api/v2/hub/connections');
    if (!Array.isArray(body)) throw new ServiceProblem('PROTOCOL_ERROR', 0, 'hub connections must be an array', {});
    return body as HubConnectionResponse[];
  }

  async registerHubConnection(request: HubConnectionRequest, idempotencyKey = generateIdempotencyKey()): Promise<HubConnectionResponse> {
    return (await this.requestJson('POST', '/api/v2/hub/connections', request, idempotencyKey)) as HubConnectionResponse;
  }

  async getHubConnection(hubConnectionId: string): Promise<HubConnectionResponse> {
    return (await this.requestJson('GET',
      `/api/v2/hub/connections/${enc(hubConnectionId)}`)) as HubConnectionResponse;
  }

  /** Mutable fields only; baseUrl is immutable by contract. */
  async updateHubConnection(hubConnectionId: string, request: HubConnectionUpdateRequest, idempotencyKey = generateIdempotencyKey()): Promise<HubConnectionResponse> {
    return (await this.requestJson('PATCH', `/api/v2/hub/connections/${enc(hubConnectionId)}`, request, idempotencyKey)) as HubConnectionResponse;
  }

  /** CONNECT/TEST/DISCONNECT/DIAGNOSE — synchronous probe, returns the updated record. */
  async requestHubConnectionAction(hubConnectionId: string, request: HubConnectionActionRequest, idempotencyKey = generateIdempotencyKey()): Promise<HubConnectionResponse> {
    return (await this.requestJson('POST', `/api/v2/hub/connections/${enc(hubConnectionId)}/connection-actions`, request, idempotencyKey)) as HubConnectionResponse;
  }

  /** Materialize the managed MCP server row for this Hub's /mcp endpoint. */
  async registerHubManagedServer(hubConnectionId: string, idempotencyKey = generateIdempotencyKey()): Promise<HubConnectionResponse> {
    return (await this.requestJson('POST', `/api/v2/hub/connections/${enc(hubConnectionId)}/register-server`, {}, idempotencyKey)) as HubConnectionResponse;
  }

  /** Live /api/v1/capabilities probe through the typed client — read-only. */
  async getHubCapabilities(hubConnectionId: string): Promise<Record<string, unknown>> {
    return (await this.requestJson('GET',
      `/api/v2/hub/connections/${enc(hubConnectionId)}/capabilities`)) as Record<string, unknown>;
  }

  // ---- Hub resource sessions (agent-hand roadmap W3/P1) ----
  // Payloads are Hub-owned JSON proxied verbatim by the service; the
  // control response is the authoritative receipt — adopt UI state only
  // from it, never optimistically.

  async listHubResources(hubConnectionId: string): Promise<HubResourceListResponse> {
    return (await this.requestJson('GET',
      `/api/v2/hub/connections/${enc(hubConnectionId)}/resources`)) as HubResourceListResponse;
  }

  async listHubSessions(hubConnectionId: string): Promise<HubSessionListResponse> {
    return (await this.requestJson('GET',
      `/api/v2/hub/connections/${enc(hubConnectionId)}/sessions`)) as HubSessionListResponse;
  }

  async acquireHubSession(hubConnectionId: string, request: HubSessionAcquireRequest, idempotencyKey = generateIdempotencyKey()): Promise<HubResourceSession> {
    return (await this.requestJson('POST',
      `/api/v2/hub/connections/${enc(hubConnectionId)}/sessions`, request, idempotencyKey)) as HubResourceSession;
  }

  async controlHubSession(hubConnectionId: string, sessionId: string, request: HubSessionControlRequest, idempotencyKey = generateIdempotencyKey()): Promise<HubSessionControlResponse> {
    return (await this.requestJson('POST',
      `/api/v2/hub/connections/${enc(hubConnectionId)}/sessions/${enc(sessionId)}/control`, request, idempotencyKey)) as HubSessionControlResponse;
  }

  // ---- Governed skill packages (extension uplift WU04/WU07) ----

  /**
   * rootHint is the trusted main-process picker's opaque handle text —
   * the service re-validates the canonical root before scanning; the
   * renderer never supplies filesystem paths.
   */
  async createSkillImportSource(request: SkillImportSourceRequest, idempotencyKey = generateIdempotencyKey()): Promise<SkillImportSourceResponse> {
    return (await this.requestJson('POST', '/api/v2/skills/import-sources', request, idempotencyKey)) as SkillImportSourceResponse;
  }

  async previewSkillImport(request: SkillImportPreviewRequest, idempotencyKey = generateIdempotencyKey()): Promise<SkillImportPreviewResponse> {
    return (await this.requestJson('POST', '/api/v2/skills/import-previews', request, idempotencyKey)) as SkillImportPreviewResponse;
  }

  /** Import binds the previewed digest — drift after preview fails. */
  async importSkillPackage(request: SkillImportRequest, idempotencyKey = generateIdempotencyKey()): Promise<SkillRecordResponse> {
    return (await this.requestJson('POST', '/api/v2/skills/imports', request, idempotencyKey)) as SkillRecordResponse;
  }

  /** Governed skill view (`?view=governed`): versions, status, digests. */
  async listSkillsGoverned(): Promise<SkillRecordResponse[]> {
    const body = await this.requestJson('GET', '/api/v2/skills?view=governed');
    if (!Array.isArray(body)) throw new ServiceProblem('PROTOCOL_ERROR', 0, 'skills must be an array', {});
    return body as SkillRecordResponse[];
  }

  async listSkillVersions(skillId: string): Promise<SkillVersionListResponse> {
    return (await this.requestJson('GET', `/api/v2/skills/${enc(skillId)}/versions`)) as SkillVersionListResponse;
  }

  async getSkillManifest(skillId: string, versionDigest: string): Promise<SkillManifestResponse> {
    return (await this.requestJson('GET', `/api/v2/skills/${enc(skillId)}/versions/${enc(versionDigest)}/manifest`)) as SkillManifestResponse;
  }

  /** Pin which version new executions see — CAS on the definition revision. */
  async selectSkillVersion(skillId: string, request: SkillVersionSelectRequest, idempotencyKey = generateIdempotencyKey()): Promise<SkillRecordResponse> {
    return (await this.requestJson('POST', `/api/v2/skills/${enc(skillId)}/current-version`, request, idempotencyKey)) as SkillRecordResponse;
  }

  // ---- Extension execution evidence (WU05) ----

  /** Frozen binding for one execution (workspace run or ordinary chat). */
  async getExecutionExtensions(executionId: string): Promise<ExecutionExtensionsResponse> {
    return (await this.requestJson('GET', `/api/v2/executions/${enc(executionId)}/extensions`)) as ExecutionExtensionsResponse;
  }

  /** Durable invocation records — the evidence, not a flag. */
  async listExtensionInvocations(executionId: string, options: {
    cursor?: string;
    limit?: number;
  } = {}): Promise<ExtensionInvocationListResponse> {
    const params = new URLSearchParams();
    if (options.cursor) params.set('cursor', options.cursor);
    if (options.limit !== undefined) params.set('limit', String(options.limit));
    const suffix = params.size > 0 ? `?${params.toString()}` : '';
    return (await this.requestJson('GET',
      `/api/v2/executions/${enc(executionId)}/extension-invocations${suffix}`)) as ExtensionInvocationListResponse;
  }

  /**
   * WU06/WU08 operator action on one durable invocation: CANCEL settles the
   * row with its honest effect outcome; RESUME_INPUT answers a parked
   * WAITING_INPUT (MRTR) call; RECONCILE re-reads the durable row — it
   * never re-sends the wire request.
   */
  async requestExtensionInvocationAction(executionId: string, invocationId: string,
      request: ExtensionInvocationActionRequest,
      idempotencyKey = generateIdempotencyKey()): Promise<ExtensionInvocationView> {
    return (await this.requestJson('POST',
      `/api/v2/executions/${enc(executionId)}/extension-invocations/${enc(invocationId)}/actions`,
      request, idempotencyKey, { timeoutMs: 30_000 })) as ExtensionInvocationView;
  }

  /**
   * WU01 (design 2026-09-29 §10.1): explicit extension test execution on the
   * public route. Exactly one target operation (server + tool) per request;
   * the server answers 201 and the same Idempotency-Key replays the stored
   * outcome.
   */
  async createExtensionTestExecution(request: ExtensionTestExecutionRequest,
      idempotencyKey = generateIdempotencyKey()): Promise<ExtensionTestExecutionResponse> {
    return (await this.requestJson('POST', '/api/v2/extension-test-executions',
      request, idempotencyKey)) as ExtensionTestExecutionResponse;
  }

  // ---- Skill catalog (EW10.5) / typed hooks health (EW10.6) ----

  async registerSkill(request: SkillRegisterRequest, idempotencyKey = generateIdempotencyKey()): Promise<SkillRecordResponse> {
    return (await this.requestJson('POST', '/api/v2/skills', request, idempotencyKey)) as SkillRecordResponse;
  }

  async listSkills(): Promise<SkillRecordResponse[]> {
    const body = await this.requestJson('GET', '/api/v2/skills');
    if (!Array.isArray(body)) throw new ServiceProblem('PROTOCOL_ERROR', 0, 'skills must be an array', {});
    return body as SkillRecordResponse[];
  }

  async changeSkillStatus(
    skillId: string,
    request: SkillStatusRequest,
    idempotencyKey = generateIdempotencyKey()
  ): Promise<SkillRecordResponse> {
    return (await this.requestJson(
      'POST',
      `/api/v2/skills/${enc(skillId)}/status`,
      request,
      idempotencyKey
    )) as SkillRecordResponse;
  }

  async listHooks(): Promise<HookSummary[]> {
    const body = await this.requestJson('GET', '/api/v2/hooks');
    if (!Array.isArray(body)) throw new ServiceProblem('PROTOCOL_ERROR', 0, 'hooks must be an array', {});
    return body as HookSummary[];
  }

  async listHookExecutions(): Promise<HookExecutionListResponse> {
    return (await this.requestJson('GET', '/api/v2/hooks/executions')) as HookExecutionListResponse;
  }

  // ---- Spec / approval governance (EW5) ----

  async createSpec(sessionId: string, body: SpecCreateRequest, idempotencyKey = generateIdempotencyKey()): Promise<SpecResponse> {
    return this.requestJson<SpecResponse>('POST', `/api/v2/sessions/${enc(sessionId)}/specs`, body, idempotencyKey);
  }

  async getSpec(specId: string): Promise<SpecResponse> {
    return this.requestJson<SpecResponse>('GET', `/api/v2/specs/${enc(specId)}`);
  }

  async reviseSpec(specId: string, body: SpecRevisionRequest, idempotencyKey = generateIdempotencyKey()): Promise<SpecResponse> {
    return this.requestJson<SpecResponse>('POST', `/api/v2/specs/${enc(specId)}/revisions`, body, idempotencyKey);
  }

  async decideSpecApproval(
    specId: string,
    approvalId: string,
    body: Omit<SpecApprovalDecisionRequest, 'approvalId'>,
    idempotencyKey = generateIdempotencyKey()
  ): Promise<SpecApprovalResponse> {
    const request: SpecApprovalDecisionRequest = { ...body, approvalId };
    return this.requestJson<SpecApprovalResponse>(
      'POST',
      `/api/v2/specs/${enc(specId)}/approvals/${enc(approvalId)}/decisions`,
      request,
      idempotencyKey
    );
  }

  async convertSpecToAct(specId: string, body: SpecConversionRequest, idempotencyKey = generateIdempotencyKey()): Promise<SpecConversionResponse> {
    return this.requestJson<SpecConversionResponse>('POST', `/api/v2/specs/${enc(specId)}/convert-to-act`, body, idempotencyKey);
  }

  async decideCommandApproval(runId: string, body: CommandApprovalDecision, idempotencyKey = generateIdempotencyKey()): Promise<RunActionResponse> {
    const pending = await this.requestJson<PendingCommandApproval>(
      'GET',
      `/api/v1/gui/runs/${enc(runId)}/command-approval`
    );
    if (!pending.approvalId || !pending.fingerprint) {
      throw new ServiceProblem(
        'COMMAND_APPROVAL_NOT_PENDING',
        409,
        'service returned an incomplete command approval',
        {}
      );
    }
    return this.requestJson<RunActionResponse>(
      'POST',
      `/api/v1/gui/runs/${enc(runId)}/command-approval/${enc(pending.approvalId)}`,
      { fingerprint: pending.fingerprint, decision: body.decision },
      idempotencyKey
    );
  }

  async pendingSandboxApproval(runId: string): Promise<PendingSandboxApproval | null> {
    try {
      return await this.requestJson<PendingSandboxApproval>(
        'GET',
        `/api/v1/runs/${enc(runId)}/sandbox-approvals/pending`
      );
    } catch (error) {
      if (error instanceof ServiceProblem && error.code === 'SANDBOX_APPROVAL_NOT_PENDING') {
        return null;
      }
      throw error;
    }
  }

  async decideSandboxApproval(runId: string, body: CommandApprovalDecision, idempotencyKey = generateIdempotencyKey()): Promise<RunActionResponse> {
    const pending = await this.pendingSandboxApproval(runId);
    if (!pending || typeof pending.approvalId !== 'string' || typeof pending.fingerprint !== 'string') {
      throw new ServiceProblem(
        'SANDBOX_APPROVAL_NOT_PENDING',
        409,
        'service returned an incomplete sandbox approval',
        {}
      );
    }
    return this.requestJson<RunActionResponse>(
      'POST',
      `/api/v1/runs/${enc(runId)}/sandbox-approvals/${enc(pending.approvalId)}`,
      {
        fingerprint: pending.fingerprint,
        decision: body.decision === 'APPROVE' ? 'APPROVE_ONCE' : 'DENY'
      },
      idempotencyKey
    );
  }

  async pendingTerminalApproval(runId: string): Promise<PendingTerminalApproval | null> {
    try {
      return await this.requestJson<PendingTerminalApproval>(
        'GET',
        `/api/v1/runs/${enc(runId)}/terminal-approvals/pending`
      );
    } catch (error) {
      if (error instanceof ServiceProblem && error.code === 'TERMINAL_APPROVAL_NOT_PENDING') {
        return null;
      }
      throw error;
    }
  }

  async decideTerminalApproval(
    runId: string,
    body: TerminalApprovalDecision,
    idempotencyKey = generateIdempotencyKey()
  ): Promise<RunActionResponse> {
    const pending = await this.pendingTerminalApproval(runId);
    if (!pending || typeof pending.approvalId !== 'string' || typeof pending.fingerprint !== 'string') {
      throw new ServiceProblem(
        'TERMINAL_APPROVAL_NOT_PENDING',
        409,
        'service returned an incomplete terminal approval',
        {}
      );
    }
    return this.requestJson<RunActionResponse>(
      'POST',
      `/api/v1/runs/${enc(runId)}/terminal-approvals/${enc(pending.approvalId)}`,
      {
        fingerprint: pending.fingerprint,
        decision: body.decision === 'APPROVE' ? 'APPROVE_SESSION' : 'DENY'
      },
      idempotencyKey
    );
  }

  /**
   * Write approval (write-scope-approval/1). The pending projection carries
   * the target path, tool, operation, reason and approved scope entries; the
   * decision echoes the service-owned fingerprint. When nothing is pending
   * the projection resolves to null instead of an error so the renderer can
   * treat it as "no card".
   */
  async pendingWriteApproval(runId: string): Promise<Record<string, unknown> | null> {
    try {
      return await this.requestJson<Record<string, unknown>>(
        'GET',
        `/api/v1/runs/${enc(runId)}/write-approvals/pending`
      );
    } catch (error) {
      if (error instanceof ServiceProblem && error.code === 'WRITE_APPROVAL_NOT_PENDING') {
        return null;
      }
      throw error;
    }
  }

  async decideWriteApproval(runId: string, body: CommandApprovalDecision, idempotencyKey = generateIdempotencyKey()): Promise<RunActionResponse> {
    const pending = await this.pendingWriteApproval(runId);
    if (!pending || typeof pending.approvalId !== 'string' || typeof pending.fingerprint !== 'string') {
      throw new ServiceProblem(
        'WRITE_APPROVAL_NOT_PENDING',
        409,
        'service returned an incomplete write approval',
        {}
      );
    }
    return this.requestJson<RunActionResponse>(
      'POST',
      `/api/v1/runs/${enc(runId)}/write-approvals/${enc(pending.approvalId)}`,
      { fingerprint: pending.fingerprint, decision: body.decision },
      idempotencyKey
    );
  }

  /**
   * The GUI budget approval is an exact two-step decision protocol. The
   * pending projection supplies the approval id and requested top-up ceiling;
   * the decision endpoint then receives the service-owned wire shape. The
   * renderer intentionally remains on the smaller APPROVE/REJECT shape.
   */
  async decideBudgetApproval(
    runId: string,
    body: BudgetApprovalDecision,
    idempotencyKey = generateIdempotencyKey()
  ): Promise<BudgetApprovalResponse> {
    const pending = await this.requestJson<BudgetApprovalResponse>(
      'GET',
      `/api/v1/gui/runs/${enc(runId)}/budget-approval`
    );
    const approvalId = pending.approvalId;
    if (!approvalId) {
      throw new ServiceProblem(
        'BUDGET_APPROVAL_NOT_PENDING',
        409,
        'service returned a budget approval without an approval id',
        {}
      );
    }
    const requestFingerprint = pending.requestFingerprint ?? pending.request?.requestFingerprint;
    if (!requestFingerprint) {
      throw new ServiceProblem(
        'BUDGET_APPROVAL_NOT_PENDING',
        409,
        'service returned a budget approval without a request fingerprint',
        {}
      );
    }
    const requested = pending.request?.requestedTopUp;
    const decision = {
      decision: body.decision === 'REJECT' ? 'DENY' : 'APPROVE',
      requestFingerprint,
      idempotencyKey,
      approverId: body.approverId ?? 'desktop-user',
      comment: body.comment ?? null,
      approvedTopUp: {
        maxSteps: requested?.maxSteps ?? 0,
        maxModelHttpRequests: requested?.maxModelHttpRequests ?? 0,
        maxRecoveryRequests: requested?.maxRecoveryRequests ?? 0,
        additionalRunMillis: requested?.additionalRunMillis ?? 0,
        maxCostMicros: requested?.maxCostMicros ?? 0
      }
    };
    return this.requestJson<BudgetApprovalResponse>(
      'POST',
      `/api/v1/gui/runs/${enc(runId)}/budget-approval/${enc(approvalId)}`,
      decision,
      idempotencyKey
    );
  }

  // ---- Unified permission / approval v2 (design §12, §16) ----

  async getExecutionPolicy(sessionId: string, projectId?: string): Promise<ExecutionPolicyResponse> {
    const suffix = projectId ? `?projectId=${enc(projectId)}` : '';
    return this.requestJson<ExecutionPolicyResponse>(
      'GET', `/api/v2/sessions/${enc(sessionId)}/execution-policy${suffix}`
    );
  }

  async updateExecutionPolicy(
    sessionId: string,
    body: ExecutionPolicyUpdateRequest,
    idempotencyKey = generateIdempotencyKey(),
    projectId?: string
  ): Promise<ExecutionPolicyResponse> {
    const suffix = projectId ? `?projectId=${enc(projectId)}` : '';
    return this.requestJson<ExecutionPolicyResponse>(
      'PUT', `/api/v2/sessions/${enc(sessionId)}/execution-policy${suffix}`, body, idempotencyKey
    );
  }

  async getAutomationControl(sessionId: string): Promise<AutomationControlResponse> {
    return this.requestJson<AutomationControlResponse>(
      'GET', `/api/v2/sessions/${enc(sessionId)}/automation-controls`
    );
  }

  async controlAutomation(
    sessionId: string,
    body: AutomationControlRequest,
    idempotencyKey = generateIdempotencyKey()
  ): Promise<AutomationControlResponse> {
    return this.requestJson<AutomationControlResponse>(
      'POST', `/api/v2/sessions/${enc(sessionId)}/automation-controls`, body, idempotencyKey
    );
  }

  async getMyExecutionPolicyDefaults(): Promise<ExecutionPolicyDefaultsResponse> {
    return this.requestJson<ExecutionPolicyDefaultsResponse>(
      'GET', '/api/v2/me/execution-policy-defaults'
    );
  }

  async updateMyExecutionPolicyDefaults(
    body: ExecutionPolicyUpdateRequest,
    idempotencyKey = generateIdempotencyKey()
  ): Promise<ExecutionPolicyDefaultsResponse> {
    return this.requestJson<ExecutionPolicyDefaultsResponse>(
      'PUT', '/api/v2/me/execution-policy-defaults', body, idempotencyKey
    );
  }

  async getExecutionPolicyDefaults(projectId: string): Promise<ExecutionPolicyDefaultsResponse> {
    return this.requestJson<ExecutionPolicyDefaultsResponse>(
      'GET', `/api/v2/projects/${enc(projectId)}/execution-policy-defaults`
    );
  }

  async updateExecutionPolicyDefaults(
    projectId: string,
    body: ExecutionPolicyUpdateRequest,
    idempotencyKey = generateIdempotencyKey()
  ): Promise<ExecutionPolicyDefaultsResponse> {
    return this.requestJson<ExecutionPolicyDefaultsResponse>(
      'PUT', `/api/v2/projects/${enc(projectId)}/execution-policy-defaults`, body, idempotencyKey
    );
  }

  async listApprovals(
    sessionId: string,
    query: { cursor?: string; limit?: number } = {}
  ): Promise<ApprovalsListResponse> {
    const params = new URLSearchParams();
    if (query.cursor) params.set('cursor', query.cursor);
    if (query.limit !== undefined) params.set('limit', String(query.limit));
    const suffix = params.toString() ? `?${params.toString()}` : '';
    return this.requestJson<ApprovalsListResponse>(
      'GET', `/api/v2/sessions/${enc(sessionId)}/approvals${suffix}`
    );
  }

  async getApproval(approvalId: string): Promise<ApprovalRequestV2> {
    return this.requestJson<ApprovalRequestV2>('GET', `/api/v2/approvals/${enc(approvalId)}`);
  }

  async decideApproval(
    approvalId: string,
    body: ApprovalDecisionRequest,
    idempotencyKey = generateIdempotencyKey()
  ): Promise<ApprovalDecisionResponse> {
    return this.requestJson<ApprovalDecisionResponse>(
      'POST', `/api/v2/approvals/${enc(approvalId)}/decisions`, body, idempotencyKey
    );
  }

  async advanceApproval(
    approvalId: string,
    body: ApprovalAdvanceRequest,
    idempotencyKey = generateIdempotencyKey()
  ): Promise<ApprovalDecisionResponse> {
    return this.requestJson<ApprovalDecisionResponse>(
      'POST', `/api/v2/approvals/${enc(approvalId)}/advance`, body, idempotencyKey
    );
  }

  async controlApproval(
    approvalId: string,
    body: ApprovalControlRequest,
    idempotencyKey = generateIdempotencyKey()
  ): Promise<ApprovalDecisionResponse> {
    return this.requestJson<ApprovalDecisionResponse>(
      'POST', `/api/v2/approvals/${enc(approvalId)}/controls`, body, idempotencyKey
    );
  }

  /** Cancel never auto-resumes (desktop design §13 EW5.4). */
  async cancelRun(runId: string, idempotencyKey = generateIdempotencyKey()): Promise<RunActionResponse> {
    const request: RunCancelRequest = { fingerprint: null };
    return this.requestJson<RunActionResponse>('POST', `/api/v1/runs/${enc(runId)}/cancel`, request, idempotencyKey);
  }

  // ---- Diff / Review / Evidence (EW6) ----

  async getRunDiff(runId: string, query: RunDiffQuery = {}): Promise<DiffPageResponse> {
    const params = new URLSearchParams();
    if (query.page !== undefined) params.set('page', String(query.page));
    if (query.pageSize !== undefined) params.set('pageSize', String(query.pageSize));
    const suffix = params.toString() ? `?${params.toString()}` : '';
    return this.requestJson<DiffPageResponse>('GET', `/api/v2/runs/${enc(runId)}/diff${suffix}`);
  }

  async listRunWorkspaceConflicts(runId: string): Promise<WorkspaceConflictListResponse> {
    return this.requestJson<WorkspaceConflictListResponse>(
      'GET', `/api/v2/runs/${enc(runId)}/workspace-conflicts`
    );
  }

  async getWorkspaceConflict(conflictId: string): Promise<WorkspaceConflictResponse> {
    return this.requestJson<WorkspaceConflictResponse>(
      'GET', `/api/v2/workspace-conflicts/${enc(conflictId)}`
    );
  }

  async resolveWorkspaceConflict(
    conflictId: string,
    body: WorkspaceConflictResolveRequest,
    idempotencyKey = generateIdempotencyKey()
  ): Promise<WorkspaceConflictResponse> {
    return this.requestJson<WorkspaceConflictResponse>(
      'POST', `/api/v2/workspace-conflicts/${enc(conflictId)}/resolve`, body, idempotencyKey
    );
  }

  /** Recomputes the three-way auto-merge preview without writing (§6.4). */
  async autoMergeWorkspaceConflict(
    conflictId: string,
    idempotencyKey = generateIdempotencyKey()
  ): Promise<WorkspaceConflictAutoMerge> {
    return this.requestJson<WorkspaceConflictAutoMerge>(
      'POST', `/api/v2/workspace-conflicts/${enc(conflictId)}/auto-merge`, {}, idempotencyKey
    );
  }

  async dismissWorkspaceConflict(
    conflictId: string,
    idempotencyKey = generateIdempotencyKey()
  ): Promise<WorkspaceConflictResponse> {
    return this.requestJson<WorkspaceConflictResponse>(
      'POST', `/api/v2/workspace-conflicts/${enc(conflictId)}/dismiss`, {}, idempotencyKey
    );
  }

  /** All-or-nothing precheck, then per-path apply (design §6.4). */
  async resolveWorkspaceConflictsBatch(
    body: WorkspaceConflictResolveBatchRequest,
    idempotencyKey = generateIdempotencyKey()
  ): Promise<WorkspaceConflictResolveBatchResponse> {
    return this.requestJson<WorkspaceConflictResolveBatchResponse>(
      'POST', '/api/v2/workspace-conflicts/resolve-batch', body, idempotencyKey
    );
  }

  /** Index-filtered conflict collection query (design §6.4). */
  async listWorkspaceConflicts(filters: {
    projectId?: string; origin?: string; runId?: string;
    state?: string; cursor?: string; limit?: number;
  } = {}): Promise<WorkspaceConflictResponse[]> {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(filters)) {
      if (value !== undefined && value !== null && value !== '') {
        params.set(key, String(value));
      }
    }
    const suffix = params.toString() ? `?${params.toString()}` : '';
    return this.requestJson<WorkspaceConflictResponse[]>(
      'GET', `/api/v2/workspace-conflicts${suffix}`
    );
  }

  /** Enqueues an asynchronous AI merge proposal (read-only model call). */
  async requestWorkspaceConflictProposal(
    conflictId: string,
    idempotencyKey = generateIdempotencyKey()
  ): Promise<WorkspaceConflictProposalStatus> {
    return this.requestJson<WorkspaceConflictProposalStatus>(
      'POST', `/api/v2/workspace-conflicts/${enc(conflictId)}/proposals`, {}, idempotencyKey
    );
  }

  async pollWorkspaceConflictProposal(
    proposalId: string
  ): Promise<WorkspaceConflictProposalStatus> {
    return this.requestJson<WorkspaceConflictProposalStatus>(
      'GET', `/api/v2/workspace-conflicts/proposals/${enc(proposalId)}`
    );
  }

  /** Uploads resolution content; returns its checksum-addressed ref (§6.4). */
  async putWorkspaceContent(
    content: Uint8Array,
    idempotencyKey = generateIdempotencyKey()
  ): Promise<WorkspaceContentsResponse> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.token}`,
      'content-type': 'application/octet-stream',
      'idempotency-key': idempotencyKey
    };
    if (this.clientSessionToken) {
      headers['X-CodeAgent-Client-Token'] = this.clientSessionToken;
    }
    const response = await this.fetchImpl(new URL('/api/v2/workspace-contents', this.baseUrl), {
      method: 'PUT',
      headers,
      body: new Uint8Array(content),
      signal: AbortSignal.timeout(this.timeoutMs)
    });
    const text = await response.text();
    if (!response.ok) throw this.toProblem(response.status, text);
    return JSON.parse(text) as WorkspaceContentsResponse;
  }

  /** Reads a checksum-addressed blob with truncation metadata (§6.4). */
  async getWorkspaceContent(
    ref: string, offset = 0, limit = 0
  ): Promise<{ bytes: Uint8Array; truncated: boolean; totalBytes: number | null }> {
    const params = new URLSearchParams();
    if (offset > 0) params.set('offset', String(offset));
    if (limit > 0) params.set('limit', String(limit));
    const suffix = params.toString() ? `?${params.toString()}` : '';
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.token}`,
      accept: 'application/octet-stream, application/problem+json'
    };
    if (this.clientSessionToken) {
      headers['X-CodeAgent-Client-Token'] = this.clientSessionToken;
    }
    const response = await this.fetchImpl(
      new URL(`/api/v2/workspace-contents/${enc(ref)}${suffix}`, this.baseUrl), {
        method: 'GET',
        headers,
        signal: AbortSignal.timeout(this.timeoutMs)
      });
    if (!response.ok) {
      const text = await response.text();
      throw this.toProblem(response.status, text);
    }
    const totalHeader = response.headers.get('x-content-total-bytes');
    const bytes = new Uint8Array(await response.arrayBuffer());
    return {
      bytes,
      truncated: response.headers.get('x-content-truncated') === 'true',
      totalBytes: totalHeader == null ? null : Number(totalHeader)
    };
  }

  /** Delivery candidate rebase (design §6.6); service WU-04 endpoint. */
  async rebaseDelivery(
    deliveryId: string,
    body: { expectedStateVersion?: number | null },
    idempotencyKey = generateIdempotencyKey()
  ): Promise<DeliveryCommandResponse> {
    return this.requestJson<DeliveryCommandResponse>(
      'POST', `/api/v2/deliveries/${enc(deliveryId)}/rebase`, body, idempotencyKey
    );
  }

  /** Recoverable public activity snapshot (design 2026-09-02 §10.5). */
  async getRunActivities(runId: string, query: RunActivitiesQuery = {}): Promise<RunActivityListResponse> {
    const params = new URLSearchParams();
    if (query.afterCursor !== undefined && query.afterCursor !== null) {
      params.set('afterCursor', String(query.afterCursor));
    }
    if (query.limit !== undefined && query.limit !== null) {
      params.set('limit', String(query.limit));
    }
    const suffix = params.toString() ? `?${params.toString()}` : '';
    return validateRunActivityListResponse(
      await this.requestJson<RunActivityListResponse>('GET', `/api/v2/runs/${enc(runId)}/activities${suffix}`)
    ) as RunActivityListResponse;
  }

  /** Recoverable display-reasoning snapshot (design 2026-09-18). */
  async getRunReasoning(runId: string): Promise<RunReasoningResponse> {
    return validateRunReasoningResponse(
      await this.requestJson<RunReasoningResponse>('GET', `/api/v2/runs/${enc(runId)}/reasoning`)
    ) as RunReasoningResponse;
  }

  /** Recoverable per-round visible-output snapshot (design 2026-09-19 §5.5-B). */
  async getRunOutput(runId: string): Promise<RunOutputResponse> {
    return validateRunOutputResponse(
      await this.requestJson<RunOutputResponse>('GET', `/api/v2/runs/${enc(runId)}/output`)
    ) as RunOutputResponse;
  }

  /**
   * Session-scoped execution-evidence reads (design 2026-09-26 §10.2).
   * Records carry identifiers and metadata only — artifact content is
   * fetched separately and always bounded by the service.
   */
  async listSessionExecutions(sessionId: string, query: SessionExecutionsQuery = {}): Promise<SessionExecutionPage> {
    const params = new URLSearchParams();
    if (query.runId != null && query.runId !== '') params.set('runId', query.runId);
    if (query.kind != null && query.kind !== '') params.set('kind', query.kind);
    if (query.toolId != null && query.toolId !== '') params.set('toolId', query.toolId);
    if (query.limit !== undefined && query.limit !== null) params.set('limit', String(query.limit));
    if (query.cursor != null && query.cursor !== '') params.set('cursor', query.cursor);
    const suffix = params.toString() ? `?${params.toString()}` : '';
    return this.requestJson<SessionExecutionPage>(
      'GET', `/api/v2/sessions/${enc(sessionId)}/executions${suffix}`
    );
  }

  async getSessionExecution(sessionId: string, executionId: string): Promise<SessionExecutionRecord> {
    return this.requestJson<SessionExecutionRecord>(
      'GET', `/api/v2/sessions/${enc(sessionId)}/executions/${enc(executionId)}`
    );
  }

  /**
   * Bounded UTF-8 artifact slice. The path is a record-relative reference
   * (e.g. artifacts/cmd-001.stdout.log) already constrained server-side;
   * it is appended raw because the route rejoins undecoded segments.
   */
  async readSessionExecutionArtifact(
    sessionId: string,
    executionId: string,
    artifactPath: string,
    query: SessionExecutionArtifactQuery = {}
  ): Promise<SessionExecutionArtifactSlice> {
    const params = new URLSearchParams();
    if (query.offset !== undefined && query.offset !== null) params.set('offset', String(query.offset));
    if (query.maxBytes !== undefined && query.maxBytes !== null) params.set('maxBytes', String(query.maxBytes));
    const suffix = params.toString() ? `?${params.toString()}` : '';
    const safePath = artifactPath.replace(/^\/+/, '');
    return this.requestJson<SessionExecutionArtifactSlice>(
      'GET',
      `/api/v2/sessions/${enc(sessionId)}/executions/${enc(executionId)}/artifacts/${safePath}${suffix}`
    );
  }

  async getRunReview(runId: string): Promise<ReviewRunResponse> {
    return this.requestJson<ReviewRunResponse>('GET', `/api/v2/runs/${enc(runId)}/review`);
  }

  /** Read bounded UTF-8/binary metadata from a server-authorized file reference. */
  async readProjectFile(projectId: string, fileRef: string, query: FileReadQuery = {}): Promise<FileReadResponse> {
    const suffix = query.revision ? `?revision=${enc(query.revision)}` : '';
    return this.requestJson<FileReadResponse>(
      'GET',
      `/api/v2/projects/${enc(projectId)}/files/${enc(fileRef)}${suffix}`
    );
  }

  /** Finding → fix task; the finding id is preserved in the task lineage. */
  async createFixTask(findingId: string, body: FixTaskRequest, idempotencyKey = generateIdempotencyKey()): Promise<FixTaskResponse> {
    return this.requestJson<FixTaskResponse>('POST', `/api/v2/findings/${enc(findingId)}/fix-task`, body, idempotencyKey);
  }

  /** REVEAL_FILE via server-validated fileRef (desktop design §13 EW6.5). */
  async revealProjectFile(projectId: string, fileRef: string, idempotencyKey = generateIdempotencyKey()): Promise<NativeOpenIntent> {
    const request: NativeOpenIntentRequest = { action: 'REVEAL_FILE', fileRef };
    return this.requestJson<NativeOpenIntent>(
      'POST',
      `/api/v2/projects/${enc(projectId)}/native-open-intents`,
      request,
      idempotencyKey
    );
  }

  // ---- Service-owned workspace executions (EW7) ----

  async createWorkspaceExecution(
    body: WorkspaceExecutionCreateRequest,
    idempotencyKey = generateIdempotencyKey()
  ): Promise<WorkspaceExecutionResponse> {
    return this.requestJson<WorkspaceExecutionResponse>('POST', '/api/v2/workspace-executions', body, idempotencyKey);
  }

  async listWorkspaceExecutions(projectId: string): Promise<WorkspaceExecutionListResponse> {
    return this.requestJson<WorkspaceExecutionListResponse>('GET', `/api/v2/workspace-executions?projectId=${enc(projectId)}`);
  }

  async getWorkspaceExecution(workspaceExecutionId: string): Promise<WorkspaceExecutionResponse> {
    return this.requestJson<WorkspaceExecutionResponse>('GET', `/api/v2/workspace-executions/${enc(workspaceExecutionId)}`);
  }

  /** Stale leaseId/fencingToken fails closed server-side (WORKSPACE_LEASE_LOST). */
  async renewWorkspaceExecutionLease(
    workspaceExecutionId: string,
    body: WorkspaceExecutionLeaseRenewRequest,
    idempotencyKey = generateIdempotencyKey()
  ): Promise<WorkspaceExecutionResponse> {
    return this.requestJson<WorkspaceExecutionResponse>('POST', `/api/v2/workspace-executions/${enc(workspaceExecutionId)}/lease`, body, idempotencyKey);
  }

  async handoffWorkspaceExecution(
    workspaceExecutionId: string,
    body: WorkspaceExecutionHandoffRequest,
    idempotencyKey = generateIdempotencyKey()
  ): Promise<WorkspaceExecutionResponse> {
    return this.requestJson<WorkspaceExecutionResponse>('POST', `/api/v2/workspace-executions/${enc(workspaceExecutionId)}/handoff`, body, idempotencyKey);
  }

  async reclaimWorkspaceExecution(
    workspaceExecutionId: string,
    body: WorkspaceExecutionReclaimRequest,
    idempotencyKey = generateIdempotencyKey()
  ): Promise<WorkspaceExecutionResponse> {
    return this.requestJson<WorkspaceExecutionResponse>('POST', `/api/v2/workspace-executions/${enc(workspaceExecutionId)}/reclaim`, body, idempotencyKey);
  }

  // ---- Session-owned workspace lanes / serialized delivery ----

  async createWorkspaceLane(
    body: WorkspaceLaneCreateRequest,
    idempotencyKey = generateIdempotencyKey()
  ): Promise<WorkspaceLaneResponse> {
    return this.requestJson<WorkspaceLaneResponse>('POST', '/api/v2/workspace-lanes', body, idempotencyKey);
  }

  async getWorkspaceLane(workspaceLaneId: string): Promise<WorkspaceLaneResponse> {
    return this.requestJson<WorkspaceLaneResponse>('GET', `/api/v2/workspace-lanes/${enc(workspaceLaneId)}`);
  }

  async bindWorkspaceLane(
    workspaceLaneId: string,
    body: WorkspaceLaneBindRequest,
    idempotencyKey = generateIdempotencyKey()
  ): Promise<WorkspaceLaneResponse> {
    return this.requestJson<WorkspaceLaneResponse>('POST', `/api/v2/workspace-lanes/${enc(workspaceLaneId)}/bind`, body, idempotencyKey);
  }

  async reopenWorkspaceLane(
    workspaceLaneId: string,
    body: WorkspaceLaneReopenRequest,
    idempotencyKey = generateIdempotencyKey()
  ): Promise<WorkspaceLaneResponse> {
    return this.requestJson<WorkspaceLaneResponse>('POST', `/api/v2/workspace-lanes/${enc(workspaceLaneId)}/reopen`, body, idempotencyKey);
  }

  async releaseWorkspaceLane(
    workspaceLaneId: string,
    body: WorkspaceLaneReleaseRequest,
    idempotencyKey = generateIdempotencyKey()
  ): Promise<WorkspaceLaneResponse> {
    return this.requestJson<WorkspaceLaneResponse>('POST', `/api/v2/workspace-lanes/${enc(workspaceLaneId)}/release`, body, idempotencyKey);
  }

  async createDelivery(
    body: DeliveryCreateRequest,
    idempotencyKey = generateIdempotencyKey()
  ): Promise<DeliveryCommandResponse> {
    return this.requestJson<DeliveryCommandResponse>('POST', '/api/v2/deliveries', body, idempotencyKey);
  }

  async getDelivery(deliveryId: string): Promise<DeliveryResponse> {
    return this.requestJson<DeliveryResponse>('GET', `/api/v2/deliveries/${enc(deliveryId)}`);
  }

  async getDeliveryChanges(deliveryId: string): Promise<DeliveryChangesResponse> {
    return this.requestJson<DeliveryChangesResponse>('GET', `/api/v2/deliveries/${enc(deliveryId)}/changes`);
  }

  async prepareDelivery(
    deliveryId: string,
    body: DeliveryPrepareRequest,
    idempotencyKey = generateIdempotencyKey()
  ): Promise<DeliveryCommandResponse> {
    return this.requestJson<DeliveryCommandResponse>('POST', `/api/v2/deliveries/${enc(deliveryId)}/prepare`, body, idempotencyKey);
  }

  async decideDelivery(
    deliveryId: string,
    body: DeliveryDecisionRequest,
    idempotencyKey = generateIdempotencyKey()
  ): Promise<DeliveryCommandResponse> {
    return this.requestJson<DeliveryCommandResponse>('POST', `/api/v2/deliveries/${enc(deliveryId)}/decisions`, body, idempotencyKey);
  }

  async applyDelivery(
    deliveryId: string,
    body: DeliveryApplyRequest,
    idempotencyKey = generateIdempotencyKey()
  ): Promise<DeliveryCommandResponse> {
    return this.requestJson<DeliveryCommandResponse>('POST', `/api/v2/deliveries/${enc(deliveryId)}/apply`, body, idempotencyKey);
  }

  async reconcileDelivery(
    deliveryId: string,
    body: DeliveryReconcileRequest,
    idempotencyKey = generateIdempotencyKey()
  ): Promise<DeliveryCommandResponse> {
    return this.requestJson<DeliveryCommandResponse>('POST', `/api/v2/deliveries/${enc(deliveryId)}/reconcile`, body, idempotencyKey);
  }

  async listProjectDeliveries(
    projectId: string,
    query: { cursor?: string; limit?: number } = {}
  ): Promise<DeliveryListResponse> {
    const params = new URLSearchParams();
    if (query.cursor) params.set('cursor', query.cursor);
    if (typeof query.limit === 'number') params.set('limit', String(query.limit));
    const suffix = params.toString() ? `?${params.toString()}` : '';
    return this.requestJson<DeliveryListResponse>('GET', `/api/v2/projects/${enc(projectId)}/deliveries${suffix}`);
  }

  // ---- Mission Control (EW8) ----

  async listMissions(sessionId?: string): Promise<MissionResponse[]> {
    const suffix = sessionId ? `?sessionId=${enc(sessionId)}` : '';
    return this.requestJson<MissionResponse[]>('GET', `/api/v2/missions${suffix}`);
  }

  async createMission(
    sessionId: string,
    body: MissionCreateRequest,
    idempotencyKey = generateIdempotencyKey()
  ): Promise<MissionResponse> {
    return this.requestJson<MissionResponse>('POST', `/api/v2/missions?sessionId=${enc(sessionId)}`, body, idempotencyKey);
  }

  async getMission(missionId: string): Promise<MissionResponse> {
    return this.requestJson<MissionResponse>('GET', `/api/v2/missions/${enc(missionId)}`);
  }

  async decideMissionApproval(
    missionId: string,
    approvalId: string,
    body: Omit<MissionApprovalDecisionRequest, 'approvalId'>,
    idempotencyKey = generateIdempotencyKey()
  ): Promise<MissionResponse> {
    const request: MissionApprovalDecisionRequest = { ...body, approvalId };
    return this.requestJson<MissionResponse>('POST', `/api/v2/missions/${enc(missionId)}/approvals/${enc(approvalId)}/decisions`, request, idempotencyKey);
  }

  async startMission(
    missionId: string,
    body: MissionCommandRequest,
    idempotencyKey = generateIdempotencyKey()
  ): Promise<MissionResponse> {
    return this.requestJson<MissionResponse>('POST', `/api/v2/missions/${enc(missionId)}/start`, body, idempotencyKey);
  }

  async pauseMission(
    missionId: string,
    body: MissionCommandRequest,
    idempotencyKey = generateIdempotencyKey()
  ): Promise<MissionResponse> {
    return this.requestJson<MissionResponse>('POST', `/api/v2/missions/${enc(missionId)}/pause`, body, idempotencyKey);
  }

  async resumeMission(
    missionId: string,
    body: MissionCommandRequest,
    idempotencyKey = generateIdempotencyKey()
  ): Promise<MissionResponse> {
    return this.requestJson<MissionResponse>('POST', `/api/v2/missions/${enc(missionId)}/resume`, body, idempotencyKey);
  }

  async cancelMission(
    missionId: string,
    body: MissionCommandRequest,
    idempotencyKey = generateIdempotencyKey()
  ): Promise<MissionResponse> {
    return this.requestJson<MissionResponse>('POST', `/api/v2/missions/${enc(missionId)}/cancel`, body, idempotencyKey);
  }

  // ---- Product governance (EW9): policy layers, settings, knowledge ----

  async listPolicyLayers(): Promise<PolicyLayersResponse> {
    return this.requestJson<PolicyLayersResponse>('GET', '/api/v2/policies/layers');
  }

  async updatePolicyLayer(
    layer: 'PROJECT' | 'USER',
    body: PolicyLayerUpdateRequest,
    idempotencyKey = generateIdempotencyKey()
  ): Promise<PolicyLayersResponse> {
    return this.requestJson<PolicyLayersResponse>('PUT', `/api/v2/policies/${enc(layer)}`, body, idempotencyKey);
  }

  async getProductSettings(): Promise<ProductSettingsResponse> {
    return this.requestJson<ProductSettingsResponse>('GET', '/api/v2/settings');
  }

  async updateProductSettings(
    body: ProductSettingsUpdateRequest,
    idempotencyKey = generateIdempotencyKey()
  ): Promise<ProductSettingsResponse> {
    return this.requestJson<ProductSettingsResponse>('PUT', '/api/v2/settings', body, idempotencyKey);
  }

  async listKnowledge(): Promise<KnowledgeListResponse> {
    return this.requestJson<KnowledgeListResponse>('GET', '/api/v2/memory/knowledge');
  }

  async suggestKnowledge(
    body: KnowledgeSuggestRequest,
    idempotencyKey = generateIdempotencyKey()
  ): Promise<KnowledgeItemResponse> {
    return this.requestJson<KnowledgeItemResponse>('POST', '/api/v2/memory/knowledge', body, idempotencyKey);
  }

  async confirmKnowledge(
    knowledgeId: string,
    idempotencyKey = generateIdempotencyKey()
  ): Promise<KnowledgeItemResponse> {
    return this.requestJson<KnowledgeItemResponse>('POST', `/api/v2/memory/knowledge/${enc(knowledgeId)}/confirm`, {}, idempotencyKey);
  }

  // ---- Personal management gateway (/api/personal/v1) ----
  // PAE P0 contract freeze §4: a third channel beside read-only /api/v2
  // observation and the /api/worker lab BFF. Every response is the frozen
  // {meta,data} envelope; write bodies carry requestKey which is mirrored
  // into the Idempotency-Key header so a retried submit keeps identity.
  // GETs here are read-only projections — they never trigger installs,
  // image pulls or model calls on the gateway.

  /** Bounded-operation entry (writableCollaboration precedent): validates
   * the whitelist, substitutes registered ids, and rejects everything else. */
  async personalOperation(operation: PersonalOperation): Promise<PersonalEnvelope<unknown>> {
    if (!validPersonalOperation(operation)) throw new Error('Invalid bounded personal gateway operation');
    const route = PERSONAL_ROUTES[operation.action];
    let tail = route.tail;
    for (const [marker, field] of [['{project}', 'projectId'], ['{operation}', 'operationId'], ['{worker}', 'workerId'], ['{task}', 'taskId'], ['{action}', 'actionId'], ['{report}', 'reportId'], ['{requestKey}', 'requestKey'], ['{entity}', 'entityId']] as const) {
      if (tail.includes(marker)) {
        const value = (operation as unknown as Record<string, unknown>)[field];
        if (typeof value !== 'string') throw new Error(`Missing personal gateway route field: ${field}`);
        tail = tail.replace(marker, enc(value));
      }
    }
    let path = `${PERSONAL_API_PREFIX}${tail}`;
    if ((operation.action === 'OPERATION_EVENTS' || operation.action === 'TASKS' || operation.action === 'TASK_MESSAGES' || operation.action === 'TASK_APPROVALS' || operation.action === 'TASK_INTERACTIONS')) {
      const query = new URLSearchParams();
      if (operation.cursor) query.set('cursor', operation.cursor);
      if (operation.limit) query.set('limit', operation.limit);
      // native-messages/1 paging (design §8.1): only the TASK_MESSAGES fixed
      // operation carries `before`; every other operation keeps its cursor.
      if (operation.action === 'TASK_MESSAGES' && operation.before) query.set('before', operation.before);
      if (query.size) path += `?${query}`;
    }
    if (operation.action === 'TASK_ACTIVITY') {
      const query = new URLSearchParams();
      if (operation.afterCursor) query.set('afterCursor', operation.afterCursor);
      if (operation.limit) query.set('limit', operation.limit);
      if (query.size) path += `?${query}`;
    }
    if (operation.action === 'TASK_COMMANDS') {
      const query = new URLSearchParams();
      if (operation.limit) query.set('limit', operation.limit);
      if (operation.before) query.set('before', operation.before);
      if (query.size) path += `?${query}`;
    }
    if ('runId' in operation && operation.runId) path += `${path.includes('?') ? '&' : '?'}runId=${encodeURIComponent(operation.runId)}`;
    return this.requestPersonal(route.method, path,
      'body' in operation ? operation.body : undefined,
      'key' in operation ? operation.key : undefined);
  }

  /**
   * worker-events/1 stream open — the streaming sibling of the bounded
   * TASK_ACTIVITY read. Same fixed route (`/tasks/{task}/activities`), same
   * registered-id guard and bearer transport; only the Accept negotiation,
   * Last-Event-ID header and response shape differ. Returns the open body —
   * the caller (Electron main) owns stream lifetime through `signal`.
   * Never a generic URL/method/header proxy: path, headers and the single
   * decimal cursor query are fixed here.
   */
  async personalTaskEventStream(
    taskId: string,
    options: { afterCursor?: string; lastEventId?: string; signal?: AbortSignal } = {}
  ): Promise<PersonalStreamResponse> {
    const id = personalId(taskId, 'taskId');
    const path = `${PERSONAL_API_PREFIX}/tasks/${enc(id)}/activities`;
    const query = new URLSearchParams();
    if (options.afterCursor !== undefined) {
      if (!/^(0|[1-9][0-9]{0,18})$/.test(options.afterCursor)) throw new Error('afterCursor must be a bounded decimal event cursor');
      query.set('afterCursor', options.afterCursor);
    }
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.token}`,
      accept: 'text/event-stream'
    };
    if (this.clientSessionToken) headers['X-CodeAgent-Client-Token'] = this.clientSessionToken;
    if (options.lastEventId !== undefined) {
      if (!/^[0-9]{1,19}$/.test(options.lastEventId)) throw new Error('lastEventId must be a decimal event cursor');
      headers['last-event-id'] = options.lastEventId;
    }
    const response = await this.fetchImpl(new URL(`${path}${query.size ? `?${query}` : ''}`, this.baseUrl), {
      method: 'GET',
      headers,
      signal: options.signal ?? AbortSignal.timeout(this.timeoutMs)
    });
    if (!response.ok) throw this.toProblem(response.status, await response.text());
    const mediaType = (response.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
    if (mediaType !== 'text/event-stream') {
      void response.body?.cancel().catch(() => {});
      throw new ServiceProblem('PROTOCOL_ERROR', response.status, 'personal gateway did not negotiate an event stream', {});
    }
    if (!response.body) throw new ServiceProblem('PROTOCOL_ERROR', response.status, 'event stream has no response body', {});
    return { status: response.status, headers: response.headers, body: response.body };
  }

  async personalOverview(): Promise<PersonalEnvelope<PersonalOverview>> {
    return this.requestPersonal('GET', `${PERSONAL_API_PREFIX}/overview`);
  }

  async personalListProjects(): Promise<PersonalEnvelope<PersonalProjectView[]>> {
    return this.requestPersonal('GET', `${PERSONAL_API_PREFIX}/projects`);
  }

  async personalRegisterProject(request: PersonalProjectRegistrationInput): Promise<PersonalEnvelope<PersonalProjectView>> {
    return this.requestPersonal('POST', `${PERSONAL_API_PREFIX}/projects`, request);
  }

  async personalGetProject(projectId: string): Promise<PersonalEnvelope<PersonalProjectView>> {
    return this.requestPersonal('GET', `${PERSONAL_API_PREFIX}/projects/${enc(personalId(projectId, 'projectId'))}`);
  }

  async personalGetProjectEnvironment(projectId: string): Promise<PersonalEnvelope<ProjectEnvironmentView>> {
    return this.requestPersonal('GET', `${PERSONAL_API_PREFIX}/projects/${enc(personalId(projectId, 'projectId'))}/environment`);
  }

  /** Plan preview only — the gateway must not install or reserve resources. */
  async personalPreviewEnvironmentPlan(projectId: string, request: PersonalEnvironmentPlanInput): Promise<PersonalEnvelope<PersonalEnvironmentPlanPreview>> {
    return this.requestPersonal('POST', `${PERSONAL_API_PREFIX}/projects/${enc(personalId(projectId, 'projectId'))}/environment/plans`, request);
  }

  async personalStartEnvironmentOperation(projectId: string, request: PersonalEnvironmentOperationInput): Promise<PersonalEnvelope<PersonalOperationAccepted>> {
    return this.requestPersonal('POST', `${PERSONAL_API_PREFIX}/projects/${enc(personalId(projectId, 'projectId'))}/environment/operations`, request);
  }

  async personalGetEnvironmentOperation(operationId: string): Promise<PersonalEnvelope<PersonalEnvironmentOperation>> {
    return this.requestPersonal('GET', `${PERSONAL_API_PREFIX}/environment-operations/${enc(personalId(operationId, 'operationId'))}`);
  }

  async personalGetEnvironmentOperationEvents(operationId: string, query: { cursor?: string; limit?: number } = {}): Promise<PersonalEnvelope<PersonalOperationEventsPage>> {
    const suffix = new URLSearchParams();
    if (query.cursor) suffix.set('cursor', query.cursor);
    if (query.limit !== undefined) {
      if (!Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > 256) throw new Error('limit must be an integer in [1,256]');
      suffix.set('limit', String(query.limit));
    }
    const tail = suffix.size ? `?${suffix}` : '';
    return this.requestPersonal('GET', `${PERSONAL_API_PREFIX}/environment-operations/${enc(personalId(operationId, 'operationId'))}/events${tail}`);
  }

  async personalCancelEnvironmentOperation(operationId: string, request: PersonalOperationCancelInput): Promise<PersonalEnvelope<PersonalEnvironmentOperation>> {
    return this.requestPersonal('POST', `${PERSONAL_API_PREFIX}/environment-operations/${enc(personalId(operationId, 'operationId'))}/cancel`, request);
  }

  async personalListWorkers(): Promise<PersonalEnvelope<PersonalWorkerView[]>> {
    return this.requestPersonal('GET', `${PERSONAL_API_PREFIX}/workers`);
  }

  async personalGetWorker(workerId: string): Promise<PersonalEnvelope<PersonalWorkerView>> {
    return this.requestPersonal('GET', `${PERSONAL_API_PREFIX}/workers/${enc(personalId(workerId, 'workerId'))}`);
  }

  async personalListTaskActions(taskId: string): Promise<PersonalEnvelope<AdaptiveActionDescriptor[]>> {
    return this.requestPersonal('GET', `${PERSONAL_API_PREFIX}/tasks/${enc(personalId(taskId, 'taskId'))}/actions`);
  }

  /** Trial run of a declared action; save is a separate effect. */
  async personalRunTaskAction(taskId: string, actionId: string, request: PersonalActionRunInput): Promise<PersonalEnvelope<ActionTrialReceiptView>> {
    return this.requestPersonal('POST', `${PERSONAL_API_PREFIX}/tasks/${enc(personalId(taskId, 'taskId'))}/actions/${enc(personalId(actionId, 'actionId'))}:run`, request);
  }

  async personalSaveTaskAction(taskId: string, actionId: string, request: PersonalActionSaveInput): Promise<PersonalEnvelope<AdaptiveActionDescriptor>> {
    return this.requestPersonal('POST', `${PERSONAL_API_PREFIX}/tasks/${enc(personalId(taskId, 'taskId'))}/actions/${enc(personalId(actionId, 'actionId'))}:save`, request);
  }

  async personalListReports(): Promise<PersonalEnvelope<ReportDescriptor[]>> {
    return this.requestPersonal('GET', `${PERSONAL_API_PREFIX}/reports`);
  }

  async personalCreateReport(request: PersonalReportInput): Promise<PersonalEnvelope<ReportDescriptor>> {
    return this.requestPersonal('POST', `${PERSONAL_API_PREFIX}/reports`, request);
  }

  async personalGetReport(reportId: string): Promise<PersonalEnvelope<ReportDescriptor>> {
    return this.requestPersonal('GET', `${PERSONAL_API_PREFIX}/reports/${enc(personalId(reportId, 'reportId'))}`);
  }

  async personalListReportFiles(reportId: string): Promise<PersonalEnvelope<PersonalReportFile[]>> {
    return this.requestPersonal('GET', `${PERSONAL_API_PREFIX}/reports/${enc(personalId(reportId, 'reportId'))}/files`);
  }

  /** Personal-channel round trip: write bodies always carry requestKey —
   * generated when the caller omits it, passed through when supplied — and
   * the same value is sent as the Idempotency-Key header. Responses are
   * guarded to the frozen {meta,data} envelope and fail closed otherwise. */
  private async requestPersonal<TResponse>(
    method: 'GET' | 'POST',
    path: string,
    body?: object,
    requestKey?: string
  ): Promise<PersonalEnvelope<TResponse>> {
    let payload = body;
    let key = requestKey;
    if (method === 'POST') {
      const embedded = body && typeof (body as Record<string, unknown>).requestKey === 'string'
        ? (body as Record<string, unknown>).requestKey as string
        : undefined;
      key = key ?? embedded ?? generateIdempotencyKey();
      payload = { ...(body ?? {}), requestKey: key };
    }
    const response = await this.requestJson(method, path, payload, key);
    if (!validPersonalEnvelope(response)) {
      throw new ServiceProblem('PROTOCOL_ERROR', 0, 'personal gateway returned a malformed envelope', {});
    }
    return response as PersonalEnvelope<TResponse>;
  }

  private async requestJson<TResponse>(
    method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
    path: string,
    body?: object,
    idempotencyKey?: string,
    options?: { timeoutMs?: number; omitClientSessionToken?: boolean }
  ): Promise<TResponse> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.token}`
    };
    if (this.clientSessionToken && !options?.omitClientSessionToken) {
      headers['X-CodeAgent-Client-Token'] = this.clientSessionToken;
    }
    let payload: string | undefined;
    if (method === 'POST' || method === 'PATCH' || method === 'PUT') {
      headers['content-type'] = 'application/json';
      payload = JSON.stringify(body ?? {});
      headers['idempotency-key'] = idempotencyKey ?? generateIdempotencyKey();
    } else if (method === 'DELETE') {
      headers['idempotency-key'] = idempotencyKey ?? generateIdempotencyKey();
    }
    const response = await this.fetchImpl(new URL(path, this.baseUrl), {
      method,
      headers,
      body: payload,
      signal: AbortSignal.timeout(options?.timeoutMs ?? this.timeoutMs)
    });
    const text = await response.text();
    if (!response.ok) throw this.toProblem(response.status, text);
    if (text.length === 0) return {} as TResponse;
    try {
      return JSON.parse(text) as TResponse;
    } catch {
      throw new ServiceProblem('PROTOCOL_ERROR', response.status, 'response body is not JSON', {});
    }
  }

  private async requestText(
    method: 'GET',
    path: string,
    options?: { timeoutMs?: number }
  ): Promise<string> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.token}`,
      accept: 'text/plain, application/problem+json'
    };
    if (this.clientSessionToken) {
      headers['X-CodeAgent-Client-Token'] = this.clientSessionToken;
    }
    const response = await this.fetchImpl(new URL(path, this.baseUrl), {
      method,
      headers,
      signal: AbortSignal.timeout(options?.timeoutMs ?? this.timeoutMs)
    });
    const text = await response.text();
    if (!response.ok) throw this.toProblem(response.status, text);
    return text;
  }

  private async requestBytes(
    method: 'GET',
    path: string,
    options?: { timeoutMs?: number }
  ): Promise<{ mediaType: string; bytes: Uint8Array }> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.token}`,
      accept: 'image/png, image/jpeg, application/problem+json'
    };
    if (this.clientSessionToken) {
      headers['X-CodeAgent-Client-Token'] = this.clientSessionToken;
    }
    const response = await this.fetchImpl(new URL(path, this.baseUrl), {
      method,
      headers,
      signal: AbortSignal.timeout(options?.timeoutMs ?? this.timeoutMs)
    });
    if (!response.ok) {
      const text = await response.text();
      throw this.toProblem(response.status, text);
    }
    const mediaTypeHeader = response.headers.get('content-type');
    const mediaType = mediaTypeHeader ? (mediaTypeHeader.split(';')[0] ?? '').trim().toLowerCase() : '';
    if (mediaType !== 'image/png' && mediaType !== 'image/jpeg') {
      throw new ServiceProblem('PROTOCOL_ERROR', response.status,
        'image attachment response has an unsupported media type', {});
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > 4 * 1024 * 1024) {
      throw new ServiceProblem('ATTACHMENT_LIMIT_EXCEEDED', 413,
        'image attachment response exceeds the desktop preview limit', {});
    }
    return { mediaType, bytes };
  }

  private toProblem(status: number, text: string): ServiceProblem {
    try {
      const parsed = validateProblem(JSON.parse(text));
      return new ServiceProblem(parsed.code, parsed.status, parsed.message, parsed.raw as Record<string, JsonValue>, {
        failure: parsed.failure,
        scheduling: parsed.scheduling,
        reasonCode: parsed.reasonCode,
        operationOutcome: parsed.operationOutcome,
        receiptId: parsed.receiptId,
        correlationId: parsed.correlationId
      });
    } catch (notAProblem) {
      // Personal gateway errors use {error:{code,message,retryable,requestId}}
      // (PAE P0 freeze §4) instead of the v2 problem shape; map additively so
      // callers keep the stable code instead of a generic PROTOCOL_ERROR.
      try {
        const body = JSON.parse(text);
        const personal = decodePersonalError(body);
        if (personal) {
          return new ServiceProblem(personal.code, status, personal.message ?? 'personal gateway error',
            body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, JsonValue> : {},
            { retryable: personal.retryable, correlationId: personal.requestId });
        }
      } catch { /* fall through to the generic problem */ }
      return new ServiceProblem('PROTOCOL_ERROR', status, 'service returned a non-problem error body', {});
    }
  }
}

function enc(value: string): string {
  return encodeURIComponent(value);
}

/** Registered-id guard for /api/personal/v1 path segments (freeze §0/§4). */
function personalId(value: string, field: string): string {
  if (typeof value !== 'string' || !PERSONAL_ID_PATTERN.test(value)) {
    throw new Error(`${field} must match ${PERSONAL_ID_PATTERN}`);
  }
  return value;
}
