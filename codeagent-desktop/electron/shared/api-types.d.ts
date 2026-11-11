/**
 * Shared desktop <-> preload API contract.
 *
 * Service DTOs are aliases of the generated protocol contract. The only
 * additional envelope is the explicit error returned by Electron main when
 * IPC admission or service proxying fails.
 */
export type JsonValue = string | number | boolean | null | JsonObject | JsonValue[];
export interface JsonObject {
  [key: string]: JsonValue;
}

import type {
  ModelCatalogResponse,
  AgentProfilesResponse,
  PermissionMode,
  ExecutionPolicyResponse,
  ExecutionPolicyUpdateRequest,
  ExecutionPolicyDefaultsResponse,
  AutomationControlRequest,
  AutomationControlResponse,
  ApprovalsListResponse,
  ApprovalRequestV2,
  ApprovalDecisionRequest,
  ApprovalControlRequest,
  ApprovalAdvanceRequest,
  ApprovalDecisionResponse,
  RunControlRequest,
  TerminalControlAcquireRequest,
  TerminalControlRenewRequest,
  TerminalControlReleaseRequest,
  TerminalControlResponse,
  TerminalCloseRequest,
  SessionSummaryPageResponse,
  SessionSummaryResponse,
  SessionMetadataResponse,
  SessionMessagePageResponse,
  SessionHistoryMessageResponse,
  MessageContentPageResponse,
  FailureDescriptor,
  RunSchedulingProjection,
  OperationOutcome,
  WorkspaceMode,
  WorkspaceStartPolicy,
  WorkspacePolicy,
  WorkspaceBindingResponse,
  WorkspaceLaneCreateRequest,
  WorkspaceLaneBindRequest,
  WorkspaceLaneReopenRequest,
  WorkspaceLaneReleaseRequest,
  WorkspaceLaneResponse,
  DeliveryCreateRequest,
  DeliveryPrepareRequest,
  DeliveryDecisionRequest,
  DeliveryApplyRequest,
  DeliveryReconcileRequest,
  DeliveryResponse,
  DeliveryChangesResponse,
  CommandReceiptResponse,
  DeliveryCommandResponse,
  DeliveryListResponse,
  McpServerConfigRequest,
  McpServerConfigRequestFields,
  McpServerUpdateRequest,
  McpServerUpdateRequestFields,
  McpConnectionAction,
  McpAuthActionResponse,
  McpPromptListResponse,
  McpPromptResolveRequest,
  McpPromptResolveResponse,
  McpResourceTemplateListResponse,
  McpToolListResponse,
  McpServerDetailResponse,
  McpOperationResponse,
  McpToolDescriptorView,
  ExtensionInvocationView,
  ExtensionInvocationActionRequest,
  ExtensionTestExecutionRequest,
  ExtensionTestExecutionResponse,
  SkillImportSourceResponse,
  SkillImportPreviewResponse,
  SkillImportRequest,
  SkillVersionSelectRequest,
  SkillVersionListResponse,
  SkillManifestResponse,
  ExecutionExtensionsResponse,
  ExtensionInvocationListResponse,
  EnvironmentFeaturesResponse,
  EnvironmentFeatureCard,
  EnvironmentFeatureCheck,
  EnvironmentFeatureAction,
  EnvironmentFeatureId,
  EnvironmentFeatureState,
  EnvironmentFeatureInstallation,
  EnvironmentFeatureCheckStatus,
  EnvironmentFeatureActionKind,
  EnvironmentFeatureUpdateRequest,
  ManagedModelProvidersResponse,
  ManagedModelProvider,
  ManagedModelProviderRequest,
  ManagedModel,
  ManagedModelRequest,
  ManagedCredentialKind,
  ManagedRecordSource,
  ManagedDeleteResponse,
  WebSearchProvidersResponse,
  WebSearchProvider,
  WebSearchProviderRequest,
  WebSearchCredentialKind,
  WebSearchRecordSource,
  ProjectBuildPlanResponse,
  BuildPlanOverrideRequest,
  BuildPlanOverrideResponse,
  BuildPlanPreviewResponse,
  BuildPlanActionName,
  BuildPlanActionView,
  BuildPlanOverrideView,
  BuildPlanReadiness,
  BuildPlanTargetView,
  VerificationProfileView,
  VerificationProfileListResponse,
  VerificationProfileRequest,
  SessionEnvironmentSection,
  SessionEnvironmentTarget,
  SessionEnvironmentToolchainRow,
  SessionEnvironmentVerification,
  SessionSummaryDetail
} from '../../packages/protocol/src/index.js';
export type { SessionSummaryPageResponse, SessionSummaryResponse, SessionMetadataResponse,
  SessionMessagePageResponse, SessionHistoryMessageResponse, MessageContentPageResponse };
export type { PermissionMode, ExecutionPolicyResponse, ExecutionPolicyUpdateRequest,
  AgentProfilesResponse,
  ExecutionPolicyDefaultsResponse, AutomationControlRequest, AutomationControlResponse,
  ApprovalsListResponse, ApprovalRequestV2,
  ApprovalDecisionRequest, ApprovalControlRequest, ApprovalDecisionResponse,
  ApprovalAdvanceRequest, RunControlRequest, TerminalControlAcquireRequest, TerminalControlRenewRequest,
   TerminalControlReleaseRequest, TerminalControlResponse, TerminalCloseRequest };
export type { FailureDescriptor, RunSchedulingProjection, OperationOutcome,
  WorkspaceMode, WorkspaceStartPolicy, WorkspacePolicy, WorkspaceBindingResponse,
  WorkspaceLaneCreateRequest, WorkspaceLaneBindRequest, WorkspaceLaneReopenRequest,
  WorkspaceLaneReleaseRequest, WorkspaceLaneResponse, DeliveryCreateRequest,
  DeliveryPrepareRequest, DeliveryDecisionRequest, DeliveryApplyRequest,
  DeliveryReconcileRequest, DeliveryResponse, CommandReceiptResponse,
  DeliveryChangesResponse, DeliveryCommandResponse, DeliveryListResponse };
export type { EnvironmentFeaturesResponse, EnvironmentFeatureCard,
  EnvironmentFeatureCheck, EnvironmentFeatureAction, EnvironmentFeatureId,
  EnvironmentFeatureState, EnvironmentFeatureInstallation,
  EnvironmentFeatureCheckStatus, EnvironmentFeatureActionKind,
  EnvironmentFeatureUpdateRequest,
  ManagedModelProvidersResponse, ManagedModelProvider, ManagedModel,
  ManagedModelProviderRequest, ManagedModelRequest, ManagedCredentialKind,
  RemoteModelsProbeRequest, RemoteModelsProbeResponse,
  ManagedRecordSource, ManagedDeleteResponse,
  WebSearchProvidersResponse, WebSearchProvider, WebSearchProviderRequest,
  WebSearchCredentialKind, WebSearchRecordSource,
  ProjectBuildPlanResponse, BuildPlanOverrideRequest,
  BuildPlanOverrideResponse, BuildPlanPreviewResponse,
  BuildPlanActionName, BuildPlanActionView, BuildPlanOverrideView,
  BuildPlanReadiness, BuildPlanTargetView,
  VerificationProfileView, VerificationProfileListResponse,
  VerificationProfileRequest,
  SessionEnvironmentSection, SessionEnvironmentTarget,
  SessionEnvironmentToolchainRow, SessionEnvironmentVerification,
  SessionSummaryDetail };
import type { DesktopPreferencesResponse, DesktopPreferencesUpdateRequest } from './settings-types';
// WU01 (uplift design §5): Hub association DTOs live in service-client
// until the next contract snapshot import regenerates protocol types.
import type {
  HubConnectionActionKind,
  HubConnectionRequest,
  HubConnectionResponse,
  HubConnectionUpdateRequest
} from '../../packages/service-client/src/index.js';
import type {
  HubResourceListResponse,
  HubResourceSession,
  HubSessionAcquireRequest,
  HubSessionControlRequest,
  HubSessionControlResponse,
  HubSessionListResponse
} from '../../packages/protocol/src/index.js';

export interface ProjectSummary { projectId: string; displayName?: string | null; workspaceAlias: string; [key: string]: JsonValue; }
export interface ProjectSessionPreflight { projectId: string; workspaceAlias: string; workspaceId?: string; headRevision?: string; workspaceFingerprint?: string; revision: string; policyFingerprint: string; authorityStatus: string; allowedIntents: Array<'ASK' | 'CODE' | 'PLAN' | (string & {})>; suggestedWriteScope: string[]; writeScopeCeiling: string[]; modelAlias?: string | null; modelAvailability: string; }
export interface SessionModelSettings { providerId?: string | null; modelAlias?: string | null; catalogRevision?: string | null; reasoningMode?: 'DEFAULT' | 'OFF' | 'EFFORT' | 'MANUAL_BUDGET'; reasoningOptionId?: string | null; reasoningBudgetTokens?: number | null; contextMode?: 'AUTO' | 'PRESET' | 'CUSTOM'; contextPresetId?: string | null; contextMaxTokens?: number | null; outputMode?: 'AUTO' | 'CUSTOM'; outputMaxTokens?: number | null; }
export interface SessionDirectory { id: string; path: string; writeEnabled: boolean; }
export interface SessionCreateRequestV2DirectoryFields { contextDirectories?: string[]; directories?: SessionDirectory[] | null; directoryPolicyVersion?: 2 | null; }
export interface SessionPatchRequestV2DirectoryFields { contextDirectories?: string[]; directories?: SessionDirectory[] | null; directoryPolicyVersion?: 2 | null; replaceLegacyDirectoryPolicy?: boolean | null; }
export interface SessionCreateRequest { contextDirectories?: string[]; directories?: SessionDirectory[] | null; directoryPolicyVersion?: 2 | null; }
export interface SessionPatchRequest { contextDirectories?: string[]; directories?: SessionDirectory[] | null; directoryPolicyVersion?: 2 | null; replaceLegacyDirectoryPolicy?: boolean | null; }
export interface SessionCreateRequest { schemaVersion?: string; title?: string | null; /** Empty/omitted for an ordinary workspace-free chat. */ workspaceAlias?: string | null; interactionMode?: string | null; intent?: 'ASK' | 'REVIEW' | 'EXPLAIN' | 'DESIGN' | 'IMPLEMENT' | null; executionMode?: string | null; autonomyLevel?: string | null; permissionMode?: 'WORKSPACE' | 'FULL_ACCESS' | null; policyFingerprint?: string | null; preflightRevision?: string | null; workspaceFingerprint?: string | null; writeAllow?: string[]; writeForbid?: string[]; verificationLevel?: string | null; maxModelTurns?: number; maxEditAttempts?: number; workspacePolicy?: WorkspacePolicy | null; modelSettings?: SessionModelSettings | null; agentProfileId?: string | null; agentProfileRevision?: string | null; readonlyResearchMode?: 'AUTO' | 'OFF' | string | null; initialWorkspaceListing?: boolean | null; }
export interface SessionPatchRequest { expectedSessionVersion: number; title?: string | null; /** Empty string removes workspace membership; a valid alias moves it. */ workspaceAlias?: string | null; interactionMode?: string | null; intent?: 'ASK' | 'REVIEW' | 'EXPLAIN' | 'DESIGN' | 'IMPLEMENT' | null; executionMode?: string | null; autonomyLevel?: string | null; permissionMode?: 'WORKSPACE' | 'FULL_ACCESS' | null; policyFingerprint?: string | null; preflightRevision?: string | null; workspaceFingerprint?: string | null; writeAllow?: string[]; writeForbid?: string[]; verificationLevel?: string | null; maxModelTurns?: number | null; maxEditAttempts?: number | null; modelAlias?: string | null; modelSettings?: SessionModelSettings | null; }
export interface SessionMessageRequest {
  clientMessageId: string;
  content: string;
  expectedSessionVersion: number;
  attachments?: Array<{
    clientAttachmentId?: string | null;
    name: string;
    mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif' | 'application/pdf' | 'text/plain' | 'text/markdown' | (string & {});
    dataBase64?: string;
    detail?: 'AUTO' | 'LOW' | 'HIGH' | 'ORIGINAL' | null;
    sourceAttachmentRef?: { messageId: string; attachmentId: string } | null;
  }>;
}
export interface SessionAttachmentSummary { id?: string | null; name?: string | null; mediaType?: string | null; sizeBytes?: number | null; sha256?: string | null; width?: number | null; height?: number | null; }
export interface SessionAttachmentBytesResponse { mediaType: string; dataBase64: string; sizeBytes: number; }
export interface SessionMessageResponse { messageId?: string | null; clientMessageId?: string | null; taskId?: string | null; runId?: string | null; status?: string | null; sessionVersion?: number; eventCursor?: number; receiptId?: string | null; attachments?: Array<{ clientAttachmentId?: string | null; attachmentId?: string | null; name?: string | null; kind?: string | null; mediaType?: string | null; sizeBytes?: number; status?: 'ACCEPTED' | 'REJECTED' | (string & {}); reasonCode?: string | null }>; }
export interface SessionForkRequest { expectedSessionVersion: number; copyPolicy?: 'MESSAGES_ONLY' | 'MESSAGES_AND_SETTINGS' | 'MESSAGES_ONLY_READ_ONLY' | 'FORK_SNAPSHOT'; title?: string | null; reason?: string | null; forkPoint?: { messageId?: string | null; eventId?: string | null } | null; }
export interface SessionArchiveRequest { expectedSessionVersion: number; reason?: string | null; }
export interface PendingCommandApproval { runId?: string; approvalId: string; fingerprint: string; executable: string; arguments: string[]; workingDirectory: string; timeoutMillis: number; createdAtMillis?: number; environmentVariableNames: string[]; stdinPresent: boolean; expiresAtMillis: number; }
export interface PendingSandboxApproval {
  approvalId: string;
  fingerprint: string;
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
export interface PendingTerminalApproval {
  approvalId: string;
  fingerprint: string;
  businessSessionId: string;
  runId: string;
  workspaceExecutionId: string;
  workspaceLineageId: string;
  agentReadAllowed: boolean;
  agentInputAllowed: boolean;
  executable: string;
  arguments: string[];
  workingDirectory: string;
  columns: number;
  rows: number;
  lifetimeScope: string;
  inputPolicy: string;
  terminalMode: string;
  profile: string;
  networkIntent: string;
  maxLifetimeMillis: number;
  createdAtMillis: number;
  expiresAtMillis: number;
}
export interface SessionResponse extends SessionCreateRequest { sessionId: string; sessionVersion: number; modelAlias?: string | null; workspaceId?: string | null; workspaceLineageId?: string | null; agentProfileName?: string | null; agentProfileRevision?: string | null; readonlyResearchEnabled?: boolean | null; readonlyResearchReasonCode?: string | null; contextRevision?: number | null; activeRunId?: string | null; pendingCommandApproval?: PendingCommandApproval | null; status?: string | null; modelSettingsRevision?: number; modelSettingsState?: 'READY' | 'PENDING' | 'PREPARING' | 'APPLIED' | 'FAILED'; workspaceBinding?: WorkspaceBindingResponse | null; messages?: Array<{ id?: string; clientMessageId?: string | null; content?: string; role?: string; status?: string | null; taskId?: string | null; runId?: string | null; attachments?: SessionAttachmentSummary[] | null; createdAt?: string | null; updatedAt?: string | null; reasoning?: string | null; reasoningTruncated?: boolean | null }>; eventCursor?: number; receiptId?: string | null; }
export interface SessionResponse { directoryPolicyVersion?: number; directoryAccess?: { savedSessionVersion?: number; savedWriteMode?: string; entries?: Array<{ id: string; writable: boolean; immutable?: boolean; reason: string; coveredByDirectoryId?: string | null }>; activeTurn?: { runId: string; sessionVersion: number; writeMode: string; scopeHash: string } | null; } | null; }

export interface DesktopWindowState { isMaximized: boolean; isMinimized: boolean; }
export interface DesktopDirectoryChoice { selected: boolean; path?: string; reason?: string; }
export interface RunListResponse {
  items?: ValidatedRunStateResponse[];
  truncated?: boolean;
}
export interface RunListQuery { workspaceAlias?: string; sessionId?: string; limit?: number; }
export interface AttentionItem { attentionId?: string; sourceType?: string | null; sourceId?: string | null; sessionId?: string | null; missionId?: string | null; summary?: string | null; [key: string]: JsonValue; }
export interface SpecCreateRequest { title?: string | null; goal: string; workspaceAlias: string; sourceMessageId?: string | null; }
export interface SpecRevisionRequest { expectedRevision: number; title?: string | null; goal?: string | null; sourceMessageId?: string | null; }
export interface SpecApprovalDecisionRequest { approvalId?: string; expectedRevision: number; decision: 'APPROVE' | 'REJECT'; contractFingerprint?: string | null; policyFingerprint?: string | null; workspaceBaselineFingerprint?: string | null; planFingerprint?: string | null; reason?: string | null; }
export interface SpecApprovalResponse { approvalId?: string; specId?: string; revision?: number; decision?: string | null; [key: string]: JsonValue; }
export interface SpecConversionResponse { specId?: string; revision?: number; taskId?: string | null; taskFingerprint?: string | null; status?: string | null; }
export interface SpecResponse { specId: string; sessionId?: string | null; revision: number; status?: string | null; approvalId?: string | null; contractMarkdown?: string | null; contractFingerprint?: string | null; policyFingerprint?: string | null; workspaceBaselineFingerprint?: string | null; planFingerprint?: string | null; }
export interface CommandApprovalDecision { fingerprint: string; decision: 'APPROVE' | 'REJECT'; }
export interface TerminalApprovalDecision { fingerprint: string; decision: 'APPROVE' | 'REJECT'; }
export interface BudgetApprovalDecision { decision: 'APPROVE' | 'REJECT'; requestFingerprint: string; approverId?: string | null; comment?: string | null; }
export interface BudgetApprovalTopUp { maxSteps: number; maxModelHttpRequests: number; maxRecoveryRequests: number; additionalRunMillis: number; maxCostMicros: number; }
export interface BudgetApprovalResponse {
  runId: string;
  approvalId: string;
  status: 'PENDING' | 'APPROVED' | 'DENIED' | 'EXPIRED' | (string & {});
  checkpointRef?: string | null;
  requestFingerprint: string;
  createdAt?: number;
  expiresAt?: number;
  request?: { requestedTopUp?: BudgetApprovalTopUp; maximumAllowedTopUp?: BudgetApprovalTopUp; [key: string]: JsonValue };
  decision?: string | null;
  approverId?: string | null;
  comment?: string | null;
  decidedAt?: number | null;
  approvedTopUp?: BudgetApprovalTopUp;
}
export interface RunActionResponse { [key: string]: JsonValue; }
export interface RunDeliveryResponse { status?: 'PENDING' | 'AVAILABLE' | 'PARTIAL' | 'UNAVAILABLE'; artifactsReady?: boolean; stateVersion?: number; changeArtifactRef?: string | null; evidenceManifestRef?: { manifestId?: string; sha256?: string; stateVersion?: number }; }
export interface WorkspaceConflictResponse {
  schemaVersion?: string;
  conflictId: string;
  origin?: string | null;
  originRef?: { runId?: string | null; deliveryId?: string | null; laneId?: string | null; syncSessionId?: string | null; revision?: number | null } | null;
  projectId?: string | null;
  endpointId?: string | null;
  runId: string;
  sessionId?: string | null;
  path: string;
  kind?: string | null;
  expectedVersion?: string | null;
  actualVersion?: string | null;
  state: 'OPEN' | 'RESOLVING' | 'RESOLVED' | 'DISMISSED' | 'STALE' | string;
  stateVersion: number;
  currentContent?: string | null;
  proposedContent?: string | null;
  resolutionRef?: string | null;
  baseVersionToken?: string | null;
  baseContentRef?: string | null;
  currentContentRef?: string | null;
  proposedContentRef?: string | null;
  proposedByteLength?: number | null;
  blobStoreRef?: string | null;
  base?: { ref?: string | null; version?: string | null } | null;
  current?: { ref?: string | null; version?: string | null } | null;
  proposed?: { ref?: string | null; version?: string | null } | null;
  autoMerge?: { status?: string | null; previewRef?: string | null; reason?: string | null } | null;
  allowedActions?: string[];
  resolution?: { choice?: string | null; resultRef?: string | null; resolvedBy?: string | null; resolvedAt?: string | null; appliedOperationId?: string | null } | null;
  limits?: { maxContentBytes?: number; previewTruncated?: boolean | null } | null;
}
export interface WorkspaceConflictListResponse { runId: string; items: WorkspaceConflictResponse[]; }
export interface WorkspaceConflictResolveRequest {
  expectedStateVersion?: number;
  expectedCurrentHash?: string | null;
  choice: 'KEEP_CURRENT' | 'USE_PROPOSED' | 'MERGED_CONTENT' | 'AUTO_MERGED' | 'DISMISS';
  resolutionContent?: string | null;
  resolutionRef?: string | null;
  operationId?: string | null;
}
export interface WorkspaceConflictResolveBatchRequest {
  syncSessionId?: string | null;
  items: Array<{
    conflictId: string;
    expectedStateVersion?: number;
    expectedCurrentHash?: string | null;
    choice: 'KEEP_CURRENT' | 'USE_PROPOSED' | 'MERGED_CONTENT' | 'AUTO_MERGED' | 'DISMISS';
    resolutionContent?: string | null;
    resolutionRef?: string | null;
  }>;
}
export interface WorkspaceConflictResolveBatchResponse {
  appliedPaths: string[];
  pendingPaths: string[];
  failedPaths: Array<Record<string, unknown>>;
  items: WorkspaceConflictResponse[];
}
export interface WorkspaceContentsResponse { ref: string; sha256: string; byteLength: number; }
export interface WorkspaceContentReadResponse { contentBase64: string; truncated: boolean; totalBytes?: number | null; }
export interface WorkspaceConflictProposalStatus { proposalId: string; status: 'PENDING' | 'READY' | 'FAILED' | string; proposalRef?: string | null; error?: string | null; }
export interface WorkspaceConflictAutoMergeResponse { status?: string | null; previewRef?: string | null; reason?: string | null; }
export interface ValidatedRunStateResponse { runId: string; taskId: string; state: string; stateVersion: number; changedFileCount: number; sourceStatus?: string; sessionId?: string; workspaceAlias?: string; outcomeSeverity?: 'OK' | 'WARNING' | 'ERROR'; verificationV2?: Record<string, JsonValue>; delivery?: RunDeliveryResponse; failure?: FailureDescriptor; scheduling?: RunSchedulingProjection; reasonCode?: string; workspaceConflicts?: WorkspaceConflictResponse[]; }
export interface DiffPageResponse { runId: string; stateVersion: number; artifactId?: string | null; baselineFingerprint?: string | null; endFingerprint?: string | null; baselineContentManifestRef?: string | null; endContentManifestRef?: string | null; deltaSemantic?: string | null; complete?: boolean; baseRevision?: string | null; incompleteReason?: string | null; stale?: boolean; truncated?: boolean; page?: number; pageSize?: number; hasMore?: boolean; files: Array<{ path?: string; changeType?: string; binary?: boolean; patch?: string | null; truncated?: boolean }>; }
export interface FileReadResponse { projectId: string; fileRef: string; revisionRef: string; mediaType: string; encoding: 'UTF-8' | 'BINARY'; contentText?: string | null; contentBytes: number; sha256: string; truncated: boolean; stale: boolean; }
export interface ReviewRunResponse { reviewId: string; runId: string; stateVersion?: number; status?: string | null; complete?: boolean; sourceArtifactId?: string | null; reportArtifactId?: string | null; reportStatus?: 'PARTIAL' | 'AVAILABLE' | null; reportContent?: string | null; reportSha256?: string | null; reportComplete?: boolean; findings: Array<{ findingId?: string; severity?: string | null; file?: string | null; line?: number | null; message?: string | null; fixTaskId?: string | null }>; }

/** Run activity projection (design 2026-09-02 §10.3), service-folded from the durable journal. */
export interface RunActivityTarget { ref: string; status: string; }
export interface RunActivity {
  activityId: string;
  runId: string;
  kind: string;
  status: string;
  toolName?: string | null;
  capabilityId?: string | null;
  detail?: string | null;
  commandPreview?: string | null;
  redactionState?: string | null;
  targets?: RunActivityTarget[];
  startedAt?: string | null;
  finishedAt?: string | null;
  durationMillis?: number | null;
  resultSummary?: string | null;
  reasonCode?: string | null;
  truncated?: boolean | null;
  startCursor?: number;
  endCursor?: number;
  groupId?: string | null;
  groupPurpose?: string | null;
  groupStartNote?: string | null;
  groupSummary?: string | null;
  groupStatus?: string | null;
  groupStartedAt?: string | null;
  groupFinishedAt?: string | null;
  fileRef?: string | null;
  fileName?: string | null;
  relativeDirectory?: string | null;
  startLine?: number | null;
  endLine?: number | null;
  bytesRead?: number | null;
  fileSizeBytes?: number | null;
  workingDirectory?: string | null;
  failure?: FailureDescriptor;
  scheduling?: RunSchedulingProjection;
  effectState?: 'NOT_APPLIED' | 'APPLIED' | 'UNKNOWN';
  /** Execution-evidence refs (design 2026-09-26 WU-1): identifiers and
   * record-relative artifact paths only — never raw output. */
  executionId?: string | null;
  commandId?: string | null;
  evidenceState?: string | null;
  evidenceArtifacts?: string[] | null;
}
/**
 * Session execution-evidence record/page/artifact-slice (design 2026-09-26
 * §10.2): post-snapshot additive contract, mirrors the canonical OpenAPI.
 */
export interface SessionExecutionRecord {
  executionId: string;
  kind: string;
  toolId?: string | null;
  sessionId?: string | null;
  runId?: string | null;
  state: string;
  createdAt: number;
  expiredAt?: number | null;
  expiredReason?: string | null;
  outcome?: { [key: string]: unknown } | null;
  receipt?: { [key: string]: unknown } | null;
  commandRecords?: Array<{ [key: string]: unknown }>;
  transitions?: Array<{ state?: string; detail?: string | null }>;
  executionsRoot?: string | null;
}
export interface SessionExecutionPage {
  sessionId: string;
  executions: SessionExecutionRecord[];
  count: number;
  nextCursor?: string | null;
  executionsRoot?: string | null;
}
export interface SessionExecutionArtifactSlice {
  executionId: string;
  path: string;
  content: string;
  offset: number;
  totalBytes: number;
  hasMore: boolean;
}
export interface RunActivitySummary {
  completeness: 'LIVE_LOWER_BOUND' | 'TERMINAL_EXACT' | 'INCOMPLETE' | (string & {});
  activityCount: number;
  runningCount?: number;
  succeededCount?: number;
  partialCount?: number;
  failedCount?: number;
  uniqueReadFileCount?: number;
  uniqueWrittenFileCount?: number;
  commandCount?: number;
  startedAt?: string | null;
  finishedAt?: string | null;
  updatedAt?: string | null;
  sourceCursor?: number;
  productSequenceGap?: boolean | null;
}
export interface RunActivityListResponse {
  runId: string;
  runStateVersion: number;
  snapshotCursor: number;
  retentionFloor?: number;
  complete: boolean;
  reasonCode?: string | null;
  truncated?: boolean;
  items: RunActivity[];
  summary: RunActivitySummary;
}
/** One round's assembled text inside a snapshot (design 2026-09-19 §5.4/§5.5-B). */
export interface RunTextSegmentResponse {
  roundId: string;
  roundOrdinal?: number | null;
  text: string;
  truncated: boolean;
  complete: boolean;
  lastSequence: number;
}
/** Display-reasoning snapshot (design 2026-09-18): provider-returned public thinking text only. */
export interface RunReasoningResponse {
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
  reasonCode?: string | null;
  truncated?: boolean;
  segments?: RunTextSegmentResponse[] | null;
}
/** Visible-output snapshot (design 2026-09-19 §5.5-B): per-round display text. */
export interface RunOutputResponse {
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
  reasonCode?: string | null;
  truncated?: boolean;
  segments?: RunTextSegmentResponse[] | null;
}
export interface FixTaskRequest { workspaceAlias: string; goal: string; }
export interface FixTaskResponse { taskId: string; taskFingerprint?: string | null; findingId: string; }
export interface NativeOpenIntent { intentId: string; projectId: string; action?: string; root?: string; fileRef?: string; }
export interface WorkspaceExecutionCreateRequest { workspaceAlias: string; kind: 'CHECKOUT' | 'WORKTREE' | 'READ_ONLY_SNAPSHOT'; ownerType: 'RUN' | 'MISSION_WORK_ITEM' | 'SESSION'; ownerId: string; baselineRevision?: string | null; startPolicy?: 'CLEAN_HEAD' | 'USER_WIP_SNAPSHOT' | 'APPROVED_DELIVERY' | 'FORK_SNAPSHOT' | 'CURRENT_WORKTREE' | 'REQUIRE_KNOWN_LINEAGE' | 'REQUIRE_CLEAN' | 'READ_ONLY_CURRENT' | null; wipSnapshotId?: string | null; }
export interface WorkspaceExecutionResponse { workspaceExecutionId: string; projectId: string; workspaceRef: string; state: string; stateVersion: number; [key: string]: JsonValue; }
export interface WorkspaceExecutionListResponse { projectId: string; items: WorkspaceExecutionResponse[]; }
export interface MissionBudget { maxModelTurns: number; maxToolCalls: number; maxWallClockMillis: number; maxWorkItems: number; }
export interface MissionCreateRequest { title: string; goal: string; workspaceAlias: string; sourceSpecId?: string | null; budget?: MissionBudget; }
export interface MissionApprovalDecisionRequest { approvalId?: string | null; expectedMissionVersion: number; decision: 'APPROVE' | 'REJECT'; planFingerprint?: string | null; policyFingerprint?: string | null; baseSnapshotFingerprint?: string | null; reason?: string | null; }
export interface MissionResponse { missionId: string; sessionId: string; title?: string | null; goal?: string | null; status: string; revision: number; stateVersion: number; planFingerprint?: string | null; pendingRevisionFingerprint?: string | null; }
export interface PolicyLayerUpdateRequest { maximumAutonomy: 'OFF' | 'LOW' | 'MEDIUM' | 'HIGH'; expectedRevision?: number | null; }
export interface PolicyLayersResponse { layers: Array<{ layer: string; maximumAutonomy?: string | null; revision: number }>; effectiveMaximumAutonomy: string; effectiveRevision: number; }
export interface ProductSettingsResponse { revision: number; traceExportEnabled: boolean; localOnly: boolean; eventJournalRetentionDays: number; telemetryMinimal: boolean; }
export interface ProductSettingsUpdateRequest { traceExportEnabled?: boolean | null; localOnly?: boolean | null; eventJournalRetentionDays?: number | null; expectedRevision?: number | null; }
export interface KnowledgeItemResponse { knowledgeId: string; status: 'PENDING' | 'CONFIRMED' | 'REJECTED'; content: string; sourceRef?: string | null; }
export interface KnowledgeListResponse { items: KnowledgeItemResponse[]; facts: KnowledgeItemResponse[]; }
export interface KnowledgeSuggestRequest { content: string; sourceRef?: string | null; }
export interface EvidenceBundleResponse { runId: string; generatedAt?: string; complete?: boolean; items?: Array<Record<string, JsonValue>>; stateVersion?: number | null; artifactsReady?: boolean | null; deliveryStatus?: 'PENDING' | 'AVAILABLE' | 'PARTIAL' | 'UNAVAILABLE' | null; changeArtifactRef?: string | null; manifestRef?: { manifestId?: string; sha256?: string; stateVersion?: number }; verificationV2?: Record<string, JsonValue> | null; outcomeSeverity?: 'OK' | 'WARNING' | 'ERROR' | null; }
export interface SourceFetchRequest { sourceType: 'WEB' | 'ISSUE' | 'DOCS'; uri: string; maxBytes?: number | null; }
export interface SourceFetchResponse { sourceType?: string | null; sourceUri?: string | null; finalUri?: string | null; contentText?: string | null; untrustedContent?: boolean | null; [key: string]: JsonValue; }
export interface McpServerSummary { serverId?: string | null; status?: 'READY' | 'UNAVAILABLE' | 'DISABLED' | null; reason?: string | null; resourceCount?: number | null; }
export interface McpResourceDescriptor { uri?: string | null; name?: string | null; mimeType?: string | null; description?: string | null; }
export interface McpResourceReadResponse { serverId?: string | null; uri?: string | null; mimeType?: string | null; contentText?: string | null; untrustedContent?: boolean | null; [key: string]: JsonValue; }
export interface SkillRegisterRequest { name: string; version: string; source: string; scope: 'PROJECT' | 'USER'; projectAlias?: string | null; instructions: string; permissions?: string[]; }
export interface SkillRecordResponse { skillId?: string | null; name?: string | null; version?: string | null; status?: string | null; [key: string]: JsonValue; }
export interface SkillStatusRequest { status: string; expectedRevision: number; }
export interface HookSummary { hookName?: string | null; event?: string | null; status?: string | null; [key: string]: JsonValue; }
export interface HookExecutionListResponse { items?: Array<Record<string, JsonValue>>; truncated?: boolean; }
export type TerminalOutputMode = 'RAW_VT' | 'PLAIN_TEXT';
export interface TerminalSessionCreateRequest {
  workspaceExecutionId: string;
  createdByRunId?: string | null;
  profile?: 'DIRECT_PROCESS' | 'USER_SHELL' | 'AGENT_SHELL' | 'DEBUGGER_CLI' | (string & {});
  executable: string;
  arguments?: string[];
  workingDirectory?: string;
  columns?: number;
  rows?: number;
  lifetimeScope?: 'RUN' | 'BUSINESS_SESSION' | 'WORKSPACE' | (string & {});
  inputPolicy?: 'NONE' | 'BOUNDED_TEXT' | 'RAW' | 'USER_ONLY' | (string & {});
  terminalMode?: 'LINE_STREAM' | 'FULL_VT' | (string & {});
  networkIntent?: 'INHERIT' | 'DENY' | 'ALLOW' | (string & {});
  maxLifetimeMillis?: number;
  workspaceLineageId?: string | null;
  leaseId?: string | null;
}
export interface TerminalAllowedActions {
  canReadOutput: boolean;
  canWriteInput: boolean;
  canResize: boolean;
  canInterrupt: boolean;
  canTerminate: boolean;
  canClose: boolean;
  canAgentWrite: boolean;
  canUserWrite: boolean;
}
export interface TerminalSessionResponse {
  terminalSessionId: string;
  businessSessionId: string;
  workspaceExecutionId?: string | null;
  createdByRunId?: string | null;
  serviceInstanceId: string;
  state: string;
  stateVersion: number;
  lifetimeScope: string;
  profile: string;
  terminalMode: string;
  inputPolicy: string;
  controller: string;
  columns: number;
  rows: number;
  outputCursor?: string | null;
  outputBytes: number;
  inputVersion: number;
  startedAt?: string | null;
  lastActivityAt?: string | null;
  expiresAt?: string | null;
  exitCode?: number | null;
  terminalCause?: string | null;
  controlState: 'FREE' | 'ACTIVATING' | 'HELD' | 'RELEASING' | 'RECONCILE_REQUIRED' | 'CLOSED' | (string & {});
  controlVersion: number;
  controlEpoch: number;
  canAcquire: boolean;
  canInput: boolean;
  safeHolderLabel?: string | null;
  remainingControlTtlMillis: number;
  allowedActions: TerminalAllowedActions;
}
export interface TerminalOutputResponse {
  terminalSessionId: string;
  startCursor?: string | null;
  nextCursor?: string | null;
  startOffset: number;
  endOffset: number;
  dataBase64?: string | null;
  plainText?: string | null;
  mode: TerminalOutputMode;
  state: string;
  eof: boolean;
  historyIncomplete: boolean;
  gap: boolean;
  serviceInstanceId: string;
}
export interface TerminalInputRequest {
  operationId: string;
  expectedStateVersion: number;
  expectedInputVersion: number;
  encoding?: 'UTF8' | 'BASE64' | (string & {});
  text?: string | null;
  dataBase64?: string | null;
  controller?: 'USER' | 'AGENT' | (string & {}) | null;
  leaseId: string;
  controlEpoch: number;
}
export interface TerminalInputResponse { operationId: string; inputVersion: number; delivery: string; }
export interface TerminalResizeRequest { operationId: string; expectedStateVersion: number; columns: number; rows: number; resizeSequence: number; leaseId: string; controlEpoch: number; }
export interface TerminalResizeResponse { columns: number; rows: number; resizeSequence: number; }
export interface TerminalSignalRequest { operationId: string; expectedStateVersion: number; signal: 'INTERRUPT' | 'TERMINATE' | 'KILL' | (string & {}); graceMillis?: number; forceAfterGrace?: boolean; leaseId: string; controlEpoch: number; }
export interface TerminalSignalResponse { signal: string; delivery: string; stateVersion: number; accepted: boolean; }
export interface TerminalCloseResponse { accepted: boolean; finalState: string; }

export type SupervisorStatus = 'ATTACHED' | 'OWNED_READY' | 'START_FAILED' | 'DEGRADED';

export interface DesktopCapabilities {
  serviceInstanceId?: string;
  storeId?: string;
  bootId?: string;
  multiClient?: {
    contractVersion: string;
    mode: string;
    lifecycle: string;
    registrationRequiredForMutation: boolean;
    limits?: JsonObject;
  };
  compatible: boolean;
  operations?: OperationCapability[];
  features: {
    sessionV2: boolean;
    durableEvents: boolean;
    visibleOutputStream: boolean;
    worktreeExecution: boolean;
    mission: boolean;
    mcpHost: boolean;
    servicePty: boolean;
    readOnlySources: boolean;
    mcpReadOnlySource: boolean;
    skillsCatalog: boolean;
    hooks: boolean;
    readOnlySubagent: boolean;
    /** Rollout scope: null | 'WORKSPACE_ALLOWLIST' | 'ALL_ELIGIBLE_WORKSPACES' */
    readOnlySubagentAvailability?: string | null;
  };
  limits: {
    maxDiffBytes: number;
    maxEventPage: number;
    maxVisibleDeltaChars: number;
    maxReadOnlySubagentTasksPerBatch?: number;
    maxReadOnlySubagentBatchesPerRun?: number;
    maxReadOnlySubagentParallelism?: number;
  };
}

export interface OperationCapability {
  id: string;
  availability: 'AVAILABLE' | 'DEGRADED' | 'UNAVAILABLE';
  reasonCode?: string | null;
  limits?: JsonObject;
  contractVersion: string;
}

export interface DesktopBootstrap {
  /** Explicit local management surface; never an ACS capability handshake. */
  personalGatewayConfigured?: boolean;
  /** How the desktop relates to the Service — SHARED_ATTACH means the
   * Service belongs to an external launcher and cannot be restarted here. */
  serviceMode?: 'SHARED_ATTACH' | 'OWNED_PRIVATE';
  status: SupervisorStatus;
  serviceInstanceId?: string;
  protocolVersion?: string;
  capabilities?: DesktopCapabilities;
  /** public-safe, non-secret explanation for degraded states */
  message?: string;
}

export interface DesktopError {
  error: string;
  code: 'IPC_REJECTED' | 'SERVICE_NOT_CONNECTED' | 'PROTOCOL_INCOMPATIBLE' | 'PROXY_FAILED' | (string & {});
  status?: number;
  failure?: FailureDescriptor;
  scheduling?: RunSchedulingProjection;
  reasonCode?: string;
  operationOutcome?: OperationOutcome;
  receiptId?: string;
  correlationId?: string;
}

export type DesktopResult<T> = T | DesktopError;
export type DesktopSessionCreateRequest = SessionCreateRequest;

export interface DesktopServiceStatus {
  state: string;
  serviceInstanceId?: string;
  ownedPid?: number;
  ownedPort?: number;
  encryptionAvailable: boolean;
  tokenPersisted: boolean;
  /** Authoritative Java /api/v2/scheduler/overview projection when connected. */
  scheduler?: SchedulerOverviewResponse;
}

export interface SchedulerOverviewResponse {
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

export interface DesktopProjectRegistrationResult {
  registered: boolean;
  projectId?: string;
  displayName?: string;
  reason?: string;
}

export interface DesktopDiagnostics {
  serviceState: string;
  ownedProcess: { pid: number; port: number; nonce: string } | null;
  logLocation: string;
  encryptionAvailable: boolean;
}

export interface ConversationExportSaveRequest {
  suggestedName: string;
  format: 'markdown' | 'txt' | 'json' | 'csv' | 'html' | 'pdf';
  content: string;
}

export interface ConversationExportSaveResponse {
  canceled: boolean;
  filePath?: string;
  bytes?: number;
}

export interface DurableEventFrameLike {
  cursor: number;
  type: string;
  payload: JsonValue;
}

export interface NativeTaskEventFrameLike {
  cursor: number;
  type: string;
  payload: JsonValue;
}

/**
 * Per-task worker-events/1 push envelope (main -> renderer, channel
 * 'app/events/native'): `frames` carries batched OUTPUT_DELTA /
 * ASSISTANT_MESSAGE rows; `status`/`resync` carry honest stream health so a
 * dropped or conflicting cursor is never shown as a seamless feed.
 */
export interface NativeTaskEventPush {
  taskId: string;
  frames?: NativeTaskEventFrameLike[];
  status?: 'CONNECTED' | 'DISCONNECTED' | 'RECONNECTING' | 'SUBSCRIBED' | 'UNSUBSCRIBED';
  resync?: 'CURSOR_EXPIRED' | 'GAP' | 'EXHAUSTED';
}

export interface EventStatusLike {
  status?: string;
  resync?: string;
}

export interface DesktopApi {
  writableCollaboration?(request: import("../../packages/protocol/src/writable-collaboration").WritableOperation): Promise<DesktopResult<import("../../packages/protocol/src/writable-collaboration").WritableResponse>>;
  collaboration(request: import("../../packages/protocol/src/collaboration").CollaborationOperation): Promise<DesktopResult<import("../../packages/protocol/src/collaboration").CollaborationResource>>;
  /** PAE P8: bounded /api/personal/v1 operation dispatch (P0 frozen
   * whitelist via validPersonalOperation; optional — absent on builds
   * without the personal channel). */
  saveNativeArtifact?(request: {taskId:string;artifactId:string;sourceStoreId:string;sha256:string;path:string}): Promise<DesktopResult<{canceled:boolean;sha256?:string}>>;
  personalOperation?(op: import("../../packages/protocol/src/personal").PersonalOperation): Promise<DesktopResult<import("../../packages/protocol/src/personal").PersonalEnvelope<unknown>>>;
  /** UCA-001 C4: bounded `client-access/1` operations against the personal
   * access server configured for this profile. Main owns the binding, the
   * message/action binding and the idempotency identity; the renderer only
   * submits frozen operation shapes. */
  personalAccess?(op: import("../../packages/client-access/src/operations").PersonalAccessOperation): Promise<DesktopResult<unknown>>;
  bootstrap(): Promise<DesktopBootstrap>;
  controlWindow(action: 'MINIMIZE' | 'TOGGLE_MAXIMIZE' | 'CLOSE'): Promise<{ ok: boolean }>;
  onWindowState(listener: (state: DesktopWindowState) => void): () => void;
  openExternalHttps(url: string): Promise<void>;
  restartService(): Promise<DesktopBootstrap>;
  serviceStatus(): Promise<DesktopServiceStatus>;
  chooseAndRegisterProject(): Promise<DesktopProjectRegistrationResult>;
  chooseDirectory(): Promise<DesktopResult<DesktopDirectoryChoice>>;
  diagnostics(): Promise<DesktopDiagnostics>;
  saveConversationExport(request: ConversationExportSaveRequest): Promise<DesktopResult<ConversationExportSaveResponse>>;

  listProjects(): Promise<DesktopResult<ProjectSummary[]>>;
  getProjectSessionPreflight(projectId: string): Promise<DesktopResult<ProjectSessionPreflight>>;
  /** Build-plan surface (design 2026-09-26 §7.2): dry-run plan view. */
  getProjectBuildPlan(projectId: string): Promise<DesktopResult<ProjectBuildPlanResponse>>;
  /** Validated override upsert; the service re-validates authoritatively. */
  putProjectBuildPlanOverride(projectId: string, body: BuildPlanOverrideRequest): Promise<DesktopResult<BuildPlanOverrideResponse>>;
  /** Side-effect-free preview of a candidate override. */
  previewProjectBuildPlan(projectId: string, body: BuildPlanOverrideRequest): Promise<DesktopResult<BuildPlanPreviewResponse>>;
  /** Verification-profile surface (design 2026-09-26 §7.4/§10.2). */
  getProjectVerificationProfiles(projectId: string): Promise<DesktopResult<VerificationProfileListResponse>>;
  /** CAS-guarded profile upsert; the run snapshots the enabled "default" profile. */
  putProjectVerificationProfile(projectId: string, profileId: string, body: VerificationProfileRequest): Promise<DesktopResult<VerificationProfileView>>;
  listSessions(): Promise<DesktopResult<SessionResponse[]>>;
  listAgentProfiles?: () => Promise<DesktopResult<AgentProfilesResponse>>;
  getSession(sessionId: string): Promise<DesktopResult<SessionResponse>>;
  /** 2026-09-05 history pagination (design §5); present since contract v3, absence means legacy service. */
  listSessionSummaries(query?: { workspaceAlias?: string; archived?: 'ACTIVE' | 'ARCHIVED' | 'ALL'; q?: string; limit?: number; cursor?: string }): Promise<DesktopResult<SessionSummaryPageResponse>>;
  getSessionSummary(sessionId: string, options?: { refreshEnvironment?: boolean }): Promise<DesktopResult<SessionSummaryDetail>>;
  getSessionMetadata(sessionId: string): Promise<DesktopResult<SessionMetadataResponse>>;
  pageSessionMessages(sessionId: string, query?: { limit?: number; cursor?: string; aroundMessageId?: string }): Promise<DesktopResult<SessionMessagePageResponse>>;
  getMessageContentPage(sessionId: string, messageId: string, query?: { cursor?: string; maxBytes?: number }): Promise<DesktopResult<MessageContentPageResponse>>;
  createSession(body: SessionCreateRequest, idempotencyKey?: string): Promise<DesktopResult<SessionResponse>>;
  patchSession(sessionId: string, body: SessionPatchRequest): Promise<DesktopResult<SessionResponse>>;
  sendSessionMessage(sessionId: string, body: SessionMessageRequest, idempotencyKey?: string): Promise<DesktopResult<SessionMessageResponse>>;
  /** 长输入设计 §6.3：已接受附件的内容读取（text/plain；Markdown 不渲染为 HTML）。 */
  getSessionAttachmentContent(sessionId: string, messageId: string, attachmentId: string): Promise<DesktopResult<string>>;
  getSessionAttachmentBytes(sessionId: string, messageId: string, attachmentId: string): Promise<DesktopResult<SessionAttachmentBytesResponse>>;
  forkSession(sessionId: string, body: SessionForkRequest): Promise<DesktopResult<SessionResponse>>;
  archiveSession(sessionId: string, body: SessionArchiveRequest): Promise<DesktopResult<SessionResponse>>;
  listRuns(query: RunListQuery): Promise<DesktopResult<RunListResponse>>;
  listAttention(): Promise<DesktopResult<AttentionItem[]>>;

  listTerminalSessions(businessSessionId: string): Promise<DesktopResult<TerminalSessionResponse[]>>;
  createTerminalSession(businessSessionId: string, body: TerminalSessionCreateRequest): Promise<DesktopResult<TerminalSessionResponse>>;
  getTerminalSession(terminalSessionId: string): Promise<DesktopResult<TerminalSessionResponse>>;
  getTerminalOutput(terminalSessionId: string, query?: { cursor?: string; maxBytes?: number; waitMillis?: number; mode?: TerminalOutputMode }): Promise<DesktopResult<TerminalOutputResponse>>;
  writeTerminalInput(terminalSessionId: string, body: TerminalInputRequest): Promise<DesktopResult<TerminalInputResponse>>;
  resizeTerminalSession(terminalSessionId: string, body: TerminalResizeRequest): Promise<DesktopResult<TerminalResizeResponse>>;
  signalTerminalSession(terminalSessionId: string, body: TerminalSignalRequest): Promise<DesktopResult<TerminalSignalResponse>>;
  acquireTerminalControl(terminalSessionId: string, body: TerminalControlAcquireRequest): Promise<DesktopResult<TerminalControlResponse>>;
  renewTerminalControl(terminalSessionId: string, body: TerminalControlRenewRequest): Promise<DesktopResult<TerminalControlResponse>>;
  releaseTerminalControl(terminalSessionId: string, body: TerminalControlReleaseRequest): Promise<DesktopResult<TerminalControlResponse>>;
  closeTerminalSession(terminalSessionId: string, body: TerminalCloseRequest): Promise<DesktopResult<TerminalCloseResponse>>;

  createSpec(sessionId: string, body: SpecCreateRequest): Promise<DesktopResult<SpecResponse>>;
  getSpec(specId: string): Promise<DesktopResult<SpecResponse>>;
  reviseSpec(specId: string, body: SpecRevisionRequest): Promise<DesktopResult<SpecResponse>>;
  decideSpecApproval(specId: string, approvalId: string, body: Omit<SpecApprovalDecisionRequest, 'approvalId'>): Promise<DesktopResult<SpecApprovalResponse>>;
  convertSpecToAct(specId: string, body: { expectedRevision: number }): Promise<DesktopResult<SpecConversionResponse>>;
  decideCommandApproval(runId: string, body: CommandApprovalDecision): Promise<DesktopResult<RunActionResponse>>;
  decideSandboxApproval(runId: string, body: CommandApprovalDecision): Promise<DesktopResult<RunActionResponse>>;
  pendingSandboxApproval(runId: string): Promise<DesktopResult<PendingSandboxApproval | null>>;
  decideTerminalApproval(runId: string, body: TerminalApprovalDecision): Promise<DesktopResult<RunActionResponse>>;
  pendingTerminalApproval(runId: string): Promise<DesktopResult<PendingTerminalApproval | null>>;
  decideBudgetApproval(runId: string, body: BudgetApprovalDecision): Promise<DesktopResult<BudgetApprovalResponse>>;
  decideWriteApproval(runId: string, body: Pick<CommandApprovalDecision, 'decision'>): Promise<DesktopResult<RunActionResponse>>;
  pendingWriteApproval(runId: string): Promise<DesktopResult<Record<string, unknown> | null>>;
  getExecutionPolicy(sessionId: string, projectId?: string): Promise<DesktopResult<ExecutionPolicyResponse>>;
  updateExecutionPolicy(sessionId: string, body: ExecutionPolicyUpdateRequest, projectId?: string): Promise<DesktopResult<ExecutionPolicyResponse>>;
  getAutomationControl(sessionId: string): Promise<DesktopResult<AutomationControlResponse>>;
  controlAutomation(sessionId: string, body: AutomationControlRequest): Promise<DesktopResult<AutomationControlResponse>>;
  getExecutionPolicyDefaults(projectId: string): Promise<DesktopResult<ExecutionPolicyDefaultsResponse>>;
  updateExecutionPolicyDefaults(projectId: string, body: ExecutionPolicyUpdateRequest): Promise<DesktopResult<ExecutionPolicyDefaultsResponse>>;
  getMyExecutionPolicyDefaults(): Promise<DesktopResult<ExecutionPolicyDefaultsResponse>>;
  updateMyExecutionPolicyDefaults(body: ExecutionPolicyUpdateRequest): Promise<DesktopResult<ExecutionPolicyDefaultsResponse>>;
  listApprovals(sessionId: string, query?: { cursor?: string; limit?: number }): Promise<DesktopResult<ApprovalsListResponse>>;
  getApproval(approvalId: string): Promise<DesktopResult<ApprovalRequestV2>>;
  decideApproval(approvalId: string, body: ApprovalDecisionRequest): Promise<DesktopResult<ApprovalDecisionResponse>>;
  advanceApproval(approvalId: string, body: ApprovalAdvanceRequest): Promise<DesktopResult<ApprovalDecisionResponse>>;
  controlApproval(approvalId: string, body: ApprovalControlRequest): Promise<DesktopResult<ApprovalDecisionResponse>>;
  cancelRun(runId: string): Promise<DesktopResult<RunActionResponse>>;
  interruptRun(runId: string, options: { expectedStateVersion?: number }): Promise<DesktopResult<ValidatedRunStateResponse>>;
  controlRun(runId: string, body: RunControlRequest): Promise<DesktopResult<ValidatedRunStateResponse>>;
  continueRun(runId: string, options?: { expectedStateVersion?: number; message?: string }): Promise<DesktopResult<ValidatedRunStateResponse>>;

  getRunDiff(runId: string, query: { page?: number; pageSize?: number }): Promise<DesktopResult<DiffPageResponse>>;
  getRunActivities(runId: string, query?: { afterCursor?: number; limit?: number }): Promise<DesktopResult<RunActivityListResponse>>;
  getRunReasoning(runId: string): Promise<DesktopResult<RunReasoningResponse>>;
  getRunOutput(runId: string): Promise<DesktopResult<RunOutputResponse>>;
  // Session execution-evidence reads (design 2026-09-26 §10.2): identifiers
  // and bounded artifact slices only — never eager raw output.
  listSessionExecutions(sessionId: string, query?: { runId?: string | null; limit?: number }): Promise<DesktopResult<SessionExecutionPage>>;
  getSessionExecution(sessionId: string, executionId: string): Promise<DesktopResult<SessionExecutionRecord>>;
  readSessionExecutionArtifact(sessionId: string, executionId: string, path: string, query?: { offset?: number; maxBytes?: number }): Promise<DesktopResult<SessionExecutionArtifactSlice>>;
  listRunWorkspaceConflicts(runId: string): Promise<DesktopResult<WorkspaceConflictListResponse>>;
  getWorkspaceConflict(conflictId: string): Promise<DesktopResult<WorkspaceConflictResponse>>;
  resolveWorkspaceConflict(conflictId: string, body: WorkspaceConflictResolveRequest, idempotencyKey?: string): Promise<DesktopResult<WorkspaceConflictResponse>>;
  autoMergeWorkspaceConflict(conflictId: string, idempotencyKey?: string): Promise<DesktopResult<WorkspaceConflictAutoMergeResponse>>;
  dismissWorkspaceConflict(conflictId: string, idempotencyKey?: string): Promise<DesktopResult<WorkspaceConflictResponse>>;
  resolveWorkspaceConflictsBatch(body: WorkspaceConflictResolveBatchRequest, idempotencyKey?: string): Promise<DesktopResult<WorkspaceConflictResolveBatchResponse>>;
  listWorkspaceConflicts(filters?: { projectId?: string; origin?: string; runId?: string; state?: string; cursor?: string; limit?: number }): Promise<DesktopResult<WorkspaceConflictResponse[]>>;
  requestWorkspaceConflictProposal(conflictId: string, idempotencyKey?: string): Promise<DesktopResult<WorkspaceConflictProposalStatus>>;
  pollWorkspaceConflictProposal(proposalId: string): Promise<DesktopResult<WorkspaceConflictProposalStatus>>;
  getWorkspaceContent(ref: string, query?: { offset?: number; limit?: number }): Promise<DesktopResult<WorkspaceContentReadResponse>>;
  putWorkspaceContent(contentBase64: string, idempotencyKey?: string): Promise<DesktopResult<WorkspaceContentsResponse>>;
  readProjectFile(projectId: string, fileRef: string, query?: { revision?: string }): Promise<DesktopResult<FileReadResponse>>;
  getRunReview(runId: string): Promise<DesktopResult<ReviewRunResponse>>;
  getRunEvidence(runId: string): Promise<DesktopResult<EvidenceBundleResponse>>;
  createFixTask(findingId: string, body: FixTaskRequest): Promise<DesktopResult<FixTaskResponse>>;
  revealProjectFile(projectId: string, fileRef: string): Promise<DesktopResult<NativeOpenIntent>>;

  listWorkspaceExecutions(projectId: string): Promise<DesktopResult<WorkspaceExecutionListResponse>>;
  createWorkspaceExecution(body: WorkspaceExecutionCreateRequest): Promise<DesktopResult<WorkspaceExecutionResponse>>;
  handoffWorkspaceExecution(workspaceExecutionId: string, expectedStateVersion?: number): Promise<DesktopResult<WorkspaceExecutionResponse>>;
  reclaimWorkspaceExecution(workspaceExecutionId: string, expectedStateVersion?: number): Promise<DesktopResult<WorkspaceExecutionResponse>>;
  createWorkspaceLane(body: WorkspaceLaneCreateRequest): Promise<DesktopResult<WorkspaceLaneResponse>>;
  getWorkspaceLane(workspaceLaneId: string): Promise<DesktopResult<WorkspaceLaneResponse>>;
  bindWorkspaceLane(workspaceLaneId: string, body: WorkspaceLaneBindRequest): Promise<DesktopResult<WorkspaceLaneResponse>>;
  reopenWorkspaceLane(workspaceLaneId: string, body: WorkspaceLaneReopenRequest): Promise<DesktopResult<WorkspaceLaneResponse>>;
  releaseWorkspaceLane(workspaceLaneId: string, body: WorkspaceLaneReleaseRequest): Promise<DesktopResult<WorkspaceLaneResponse>>;
  createDelivery(body: DeliveryCreateRequest): Promise<DesktopResult<DeliveryCommandResponse>>;
  getDelivery(deliveryId: string): Promise<DesktopResult<DeliveryResponse>>;
  getDeliveryChanges(deliveryId: string): Promise<DesktopResult<DeliveryChangesResponse>>;
  prepareDelivery(deliveryId: string, body: DeliveryPrepareRequest): Promise<DesktopResult<DeliveryCommandResponse>>;
  decideDelivery(deliveryId: string, body: DeliveryDecisionRequest): Promise<DesktopResult<DeliveryCommandResponse>>;
  applyDelivery(deliveryId: string, body: DeliveryApplyRequest): Promise<DesktopResult<DeliveryCommandResponse>>;
  reconcileDelivery(deliveryId: string, body: DeliveryReconcileRequest): Promise<DesktopResult<DeliveryCommandResponse>>;
  rebaseDelivery(deliveryId: string, body: { expectedStateVersion?: number | null }): Promise<DesktopResult<DeliveryCommandResponse>>;
  listProjectDeliveries(projectId: string, query?: { cursor?: string; limit?: number }): Promise<DesktopResult<DeliveryListResponse>>;

  listMissions(sessionId?: string): Promise<DesktopResult<MissionResponse[]>>;
  getMission(missionId: string): Promise<DesktopResult<MissionResponse>>;
  createMission(sessionId: string, body: MissionCreateRequest): Promise<DesktopResult<MissionResponse>>;
  decideMissionApproval(missionId: string, approvalId: string, body: Omit<MissionApprovalDecisionRequest, 'approvalId'>): Promise<DesktopResult<MissionResponse>>;
  startMission(missionId: string, expectedMissionVersion: number): Promise<DesktopResult<MissionResponse>>;
  pauseMission(missionId: string, expectedMissionVersion: number): Promise<DesktopResult<MissionResponse>>;
  resumeMission(missionId: string, expectedMissionVersion: number): Promise<DesktopResult<MissionResponse>>;
  cancelMission(missionId: string, expectedMissionVersion: number): Promise<DesktopResult<MissionResponse>>;

  listPolicyLayers(): Promise<DesktopResult<PolicyLayersResponse>>;
  updatePolicyLayer(layer: 'PROJECT' | 'USER', maximumAutonomy: PolicyLayerUpdateRequest['maximumAutonomy'], expectedRevision?: number): Promise<DesktopResult<PolicyLayersResponse>>;
  getProductSettings(): Promise<DesktopResult<ProductSettingsResponse>>;
  updateProductSettings(body: ProductSettingsUpdateRequest): Promise<DesktopResult<ProductSettingsResponse>>;
  listKnowledge(): Promise<DesktopResult<KnowledgeListResponse>>;
  suggestKnowledge(content: KnowledgeSuggestRequest['content'], sourceRef?: KnowledgeSuggestRequest['sourceRef']): Promise<DesktopResult<KnowledgeItemResponse>>;
  confirmKnowledge(knowledgeId: string): Promise<DesktopResult<KnowledgeItemResponse>>;

  // settings center (SET-2/SET-3)
  getDesktopPreferences(): Promise<DesktopResult<DesktopPreferencesResponse>>;
  updateDesktopPreferences(body: DesktopPreferencesUpdateRequest): Promise<DesktopResult<DesktopPreferencesResponse>>;
  getModelCatalog(): Promise<DesktopResult<ModelCatalogResponse>>;
  /** Fixed-intent: opens Main's own diagnostics folder; renderer never passes a path. */
  revealDiagnosticsFolder(): Promise<DesktopResult<{ revealed: boolean; reason?: string }>>;
  /** Main generates a redacted, bounded diagnostics text into the clipboard. */
  copyDiagnostics(): Promise<DesktopResult<{ copied: boolean; bytes?: number }>>;
  getAboutInfo(): Promise<DesktopResult<{ desktopVersion: string; electronVersion: string; chromeVersion: string; nodeVersion: string }>>;
  /** Approval attention ping: flashes the taskbar when a new approval waits. No payload, no secrets. */
  approvalPing(): Promise<DesktopResult<{ pinged: boolean }>>;

  fetchSource(body: SourceFetchRequest): Promise<DesktopResult<SourceFetchResponse>>;
  listMcpServers(): Promise<DesktopResult<McpServerSummary[]>>;
  listMcpResources(serverId: string): Promise<DesktopResult<McpResourceDescriptor[]>>;
  readMcpResource(serverId: string, uri: string): Promise<DesktopResult<McpResourceReadResponse>>;
  registerSkill(body: SkillRegisterRequest): Promise<DesktopResult<SkillRecordResponse>>;
  listSkills(): Promise<DesktopResult<SkillRecordResponse[]>>;
  changeSkillStatus(skillId: string, body: SkillStatusRequest): Promise<DesktopResult<SkillRecordResponse>>;
  listHooks(): Promise<DesktopResult<HookSummary[]>>;
  listHookExecutions(): Promise<DesktopResult<HookExecutionListResponse>>;

  // ---- governed extension surface (capability uplift WU07) ----
  // Configuration and evidence only; the renderer never executes.
  listMcpServersGoverned(): Promise<DesktopResult<McpServerDetailResponse[]>>;
  createMcpServer(body: McpServerConfigRequest & McpServerConfigRequestFields): Promise<DesktopResult<McpServerDetailResponse>>;
  getMcpServer(serverId: string): Promise<DesktopResult<McpServerDetailResponse>>;
  updateMcpServer(serverId: string, body: McpServerUpdateRequest & McpServerUpdateRequestFields): Promise<DesktopResult<McpServerDetailResponse>>;
  setMcpServerStatus(serverId: string, body: { enabled: boolean; expectedRevision: number }): Promise<DesktopResult<McpServerDetailResponse>>;
  requestMcpConnectionAction(serverId: string, action: McpConnectionAction): Promise<DesktopResult<McpOperationResponse>>;
  getMcpOperation(operationId: string): Promise<DesktopResult<McpOperationResponse>>;
  listMcpServerTools(serverId: string, options?: { cursor?: string; limit?: number }): Promise<DesktopResult<McpToolListResponse>>;
  refreshMcpServerCatalog(serverId: string): Promise<DesktopResult<McpOperationResponse>>;
  /** OAuth consent (WU08/WU09): START returns {loginUrl, operationId}; tokens never leave the service. */
  requestMcpAuthAction(serverId: string, action: 'START' | 'CANCEL' | 'REVOKE'): Promise<DesktopResult<McpAuthActionResponse>>;
  listMcpPrompts(serverId: string): Promise<DesktopResult<McpPromptListResponse>>;
  resolveMcpPrompt(serverId: string, body: McpPromptResolveRequest): Promise<DesktopResult<McpPromptResolveResponse>>;
  listMcpResourceTemplates(serverId: string): Promise<DesktopResult<McpResourceTemplateListResponse>>;
  /**
   * Opens the main-process directory picker and registers the chosen
   * directory as an import source. Returns the opaque sourceHandle — the
   * renderer never supplies or sees filesystem paths.
   */
  /** Governed skill view (`?view=governed`): status/revision/version state. */
  listSkillsGoverned(): Promise<DesktopResult<SkillRecordResponse[]>>;
  pickSkillImportSource(displayName?: string | null): Promise<DesktopResult<SkillImportSourceResponse>>;
  previewSkillImport(sourceHandle: string): Promise<DesktopResult<SkillImportPreviewResponse>>;
  importSkillPackage(body: SkillImportRequest): Promise<DesktopResult<SkillRecordResponse>>;
  listSkillVersions(skillId: string): Promise<DesktopResult<SkillVersionListResponse>>;
  selectSkillVersion(skillId: string, body: SkillVersionSelectRequest): Promise<DesktopResult<SkillRecordResponse>>;
  getExecutionExtensions(executionId: string): Promise<DesktopResult<ExecutionExtensionsResponse>>;
  listExtensionInvocations(executionId: string, options?: { cursor?: string; limit?: number }): Promise<DesktopResult<ExtensionInvocationListResponse>>;
  /** WU08 operator action; RECONCILE re-reads the row and never re-sends. */
  requestExtensionInvocationAction(executionId: string, invocationId: string, body: ExtensionInvocationActionRequest): Promise<DesktopResult<ExtensionInvocationView>>;
  /** One governed tool call on the public route; IPC validates the flat shape. */
  createExtensionTestExecution(body: {
    sessionId?: string | null;
    serverId: string;
    toolId: string;
    arguments?: { [key: string]: unknown } | null;
  }): Promise<DesktopResult<ExtensionTestExecutionResponse>>;
  getSkillManifest(skillId: string, versionDigest: string): Promise<DesktopResult<SkillManifestResponse>>;

  // ---- WU01 Hub associations (uplift design §5) ----
  // Fixed-base-URL records; credentialRef is a slot NAME — token material
  // lives in the service secret store and never crosses IPC.
  listHubConnections(): Promise<DesktopResult<HubConnectionResponse[]>>;
  registerHubConnection(body: HubConnectionRequest): Promise<DesktopResult<HubConnectionResponse>>;
  getHubConnection(hubConnectionId: string): Promise<DesktopResult<HubConnectionResponse>>;
  updateHubConnection(hubConnectionId: string, body: HubConnectionUpdateRequest): Promise<DesktopResult<HubConnectionResponse>>;
  requestHubConnectionAction(hubConnectionId: string, action: HubConnectionActionKind): Promise<DesktopResult<HubConnectionResponse>>;
  /** Materialize the managed MCP server for this Hub's /mcp endpoint. */
  registerHubManagedServer(hubConnectionId: string): Promise<DesktopResult<HubConnectionResponse>>;
  /** Live /api/v1/capabilities probe through the typed client. */
  getHubCapabilities(hubConnectionId: string): Promise<DesktopResult<Record<string, unknown>>>;

  // ---- Hub resource sessions (agent-hand roadmap W3/P1) ----
  // Hub-owned session schema proxied through the service. The control
  // response is the authoritative receipt — adopt state only from it.
  listHubResources(hubConnectionId: string): Promise<DesktopResult<HubResourceListResponse>>;
  listHubSessions(hubConnectionId: string): Promise<DesktopResult<HubSessionListResponse>>;
  acquireHubSession(hubConnectionId: string, body: HubSessionAcquireRequest): Promise<DesktopResult<HubResourceSession>>;
  controlHubSession(hubConnectionId: string, sessionId: string, body: HubSessionControlRequest): Promise<DesktopResult<HubSessionControlResponse>>;

  // ---- environment feature surface (settings design) ----
  // Capability cards with desired/effective state and typed fix actions.
  // Writes persist server-side and apply at the next service restart.
  getEnvironmentFeatures(): Promise<DesktopResult<EnvironmentFeaturesResponse>>;
  updateEnvironmentFeature(featureId: string, body: {
    enabled?: boolean;
    entries?: Record<string, string | null>;
    expectedRevision?: number;
  }): Promise<DesktopResult<EnvironmentFeatureCard>>;
  preflightEnvironmentFeature(featureId: string): Promise<DesktopResult<EnvironmentFeatureCard>>;
  // Two-level managed model catalog. apiKey is write-only — stored in the
  // OS-protected store by the service and never echoed back.
  listManagedModelProviders(): Promise<DesktopResult<ManagedModelProvidersResponse>>;
  probeRemoteProviderModels(body: RemoteModelsProbeRequest): Promise<DesktopResult<RemoteModelsProbeResponse>>;
  upsertModelProvider(providerId: string, body: ManagedModelProviderRequest): Promise<DesktopResult<ManagedModelProvider>>;
  deleteModelProvider(providerId: string, expectedRevision?: number, replaceDefault?: string): Promise<DesktopResult<ManagedDeleteResponse>>;
  upsertProviderModel(providerId: string, modelId: string, body: ManagedModelRequest): Promise<DesktopResult<ManagedModel>>;
  deleteProviderModel(providerId: string, modelId: string, expectedRevision?: number, replaceDefault?: string): Promise<DesktopResult<ManagedDeleteResponse>>;
  // Managed web-search records (V026): several profiles may coexist, at
  // most one is enabled and owns the applied web.* configuration. apiKey
  // is write-only — the service stores it in the record's DPAPI blob and
  // never echoes material back.
  listWebSearchProviders(): Promise<DesktopResult<WebSearchProvidersResponse>>;
  upsertWebSearchProvider(providerId: string, body: WebSearchProviderRequest): Promise<DesktopResult<WebSearchProvider>>;
  deleteWebSearchProvider(providerId: string, expectedRevision?: number): Promise<DesktopResult<ManagedDeleteResponse>>;

  onDurableEvents(listener: (frames: DurableEventFrameLike[]) => void): () => void;
  /** Per-task native worker-events/1 stream pushes (optional — absent on
   * builds without the personal stream bridge). Subscribe through the
   * bounded personalOperation TASK_EVENTS_SUBSCRIBE first. */
  onNativeTaskEvents?(listener: (push: NativeTaskEventPush) => void): () => void;
  onEventStatus(listener: (status: EventStatusLike) => void): () => void;
}
