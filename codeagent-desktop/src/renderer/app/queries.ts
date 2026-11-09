import { DesktopProxyError, unwrap } from '../../../packages/protocol/src/proxy-result';
import type { ProxyResult } from '../../../packages/protocol/src/proxy-result';
export { DesktopProxyError, unwrap } from '../../../packages/protocol/src/proxy-result';
export type { ProxyResult } from '../../../packages/protocol/src/proxy-result';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { settingsKeys } from './settings/settingsKeys';
import { HistoryRefreshCoordinator } from './data/HistoryRefreshCoordinator';
import type { DirtyResource } from './data/historyRefreshTypes';
import type {
  ApprovalRequestV2,
  ApprovalsListResponse,
  AutomationControlResponse,
  ExecutionPolicyDefaultsResponse,
  ExecutionPolicyResponse,
  SessionExecutionRecord
} from '../../../electron/shared/api-types';
import {
  decodeScheduling,
  type FailureDescriptor,
  type RunSchedulingProjection
} from '../../../packages/protocol/src/failureContract';
import { decodeRunFailure } from './failureDecoder';
export { decodeRunFailure } from './failureDecoder';

/**
 * Server-cache hooks for the workbench (desktop design §6.1/§12.2).
 * TanStack Query owns the server cache; the renderer holds no second
 * domain state machine. Durable events only trigger invalidation.
 */

export interface SessionLike {
  sessionPurpose?: 'MAIN' | 'AUXILIARY_READ_ONLY' | 'DELEGATED_WRITE_CANDIDATE' | (string & {});
  sessionId: string;
  sessionVersion: number;
  title?: string | null;
  workspaceAlias?: string | null;
  workspaceId?: string | null;
  workspaceLineageId?: string | null;
  agentProfileId?: string | null;
  agentProfileName?: string | null;
  agentProfileRevision?: string | null;
  readonlyResearchMode?: 'AUTO' | 'OFF' | string | null;
  readonlyResearchEnabled?: boolean | null;
  readonlyResearchReasonCode?: string | null;
  initialWorkspaceListing?: boolean | null;
  contextRevision?: number | null;
  intent?: 'ASK' | 'REVIEW' | 'EXPLAIN' | 'DESIGN' | 'IMPLEMENT' | string | null;
  executionMode?: string | null;
  permissionMode?: 'WORKSPACE' | 'FULL_ACCESS' | string | null;
  verificationLevel?: string | null;
  status?: string | null;
  activeRunId?: string | null;
  /** Additive projection for a command approval opened by an ordinary chat turn. */
  pendingCommandApproval?: {
    runId: string;
    approvalId: string;
    fingerprint: string;
    executable: string;
    arguments: string[];
    workingDirectory?: string | null;
    timeoutMillis?: number;
    createdAtMillis?: number;
    expiresAtMillis?: number;
  } | null;
  /** EW9: model policy projection. */
  modelAlias?: string | null;
  modelSettings?: {
    providerId?: string | null;
    modelAlias?: string | null;
    catalogRevision?: string | null;
    reasoningMode?: 'DEFAULT' | 'OFF' | 'EFFORT' | 'MANUAL_BUDGET';
    reasoningOptionId?: string | null;
    reasoningBudgetTokens?: number | null;
    contextMode?: 'AUTO' | 'PRESET' | 'CUSTOM';
    contextPresetId?: string | null;
    contextMaxTokens?: number | null;
    outputMode?: 'AUTO' | 'CUSTOM';
    outputMaxTokens?: number | null;
  } | null;
  modelSettingsRevision?: number;
  modelSettingsState?: 'READY' | 'PENDING' | 'PREPARING' | 'APPLIED' | 'FAILED';
  writeAllow?: string[] | null;
  writeForbid?: string[] | null;
  contextDirectories?: string[] | null;
  directoryPolicyVersion?: number;
  directories?: SessionDirectoryLike[] | null;
  directoryAccess?: DirectoryAccessLike | null;
  /** Session-owned lane projection; safe aliases only, no lease/fence/path. */
  workspaceBinding?: WorkspaceBindingLike | null;
  /** List-view recency + preview (mirrors SessionResponse; absent on old fixtures). */
  createdAt?: number | null;
  updatedAt?: number | null;
  archivedAt?: number | null;
  messages?: Array<{
    id: string;
    clientMessageId?: string | null;
    role: string;
    /** Null on DEFERRED bodies; the full text loads through the content endpoint. */
    content?: string | null;
    contentState?: 'INLINE' | 'DEFERRED';
    contentPreview?: string | null;
    contentRevision?: string;
    contentBytes?: number;
    status?: string | null;
    taskId?: string | null;
    runId?: string | null;
    /** Provider-returned display reasoning for ordinary-chat assistant turns
     * (design 2026-09-18); run-scoped turns use /runs/{id}/reasoning. */
    reasoning?: string | null;
    reasoningTruncated?: boolean | null;
    attachments?: Array<{
      id?: string | null;
      name?: string | null;
      mediaType?: string | null;
      sizeBytes?: number | null;
      sha256?: string | null;
    }> | null;
  }>;
}

export interface RunLike {
  runId: string;
  taskId: string;
  state: string;
  /** Original service status; public WAITING_APPROVAL is intentionally broad. */
  sourceStatus?: string | null;
  stateVersion: number;
  workspaceAlias?: string | null;
  sessionId?: string | null;
  /** Optional change count shown in the Git directory overview. */
  changedFileCount?: number;
  /** Additive V2 (design 2026-09-02 §11.4): outcome severity + structured verification; absent on older services. */
  outcomeSeverity?: string | null;
  verificationV2?: RunVerificationV2Like | null;
  /** Terminal artifact barrier; absent means a legacy service response. */
  delivery?: RunDeliveryLike | null;
  /** Additive Failure Contract v1; absent on old services. */
  failure?: FailureDescriptor | null;
  /** Legacy run failure fields retained for older Service projections. */
  failureCode?: string | null;
  failureMessage?: string | null;
  terminationCode?: string | null;
  /** Additive scheduler projection; absent on old services. */
  scheduling?: RunSchedulingProjection | null;
  /** Additive reason code from the authoritative run projection. */
  reasonCode?: string | null;
  workspaceConflicts?: WorkspaceConflictLike[];
  /** WU-05 (design §6.5): attention sub-record; clearedAt != null enables continue. */
  attention?: { clearedAt?: string | null; openCount?: number } | null;
  /** WU-05: run-id this run continues from / the follow-up run-id. */
  continuationOf?: string | null;
  continuedBy?: string | null;
  /** Optional timing facts from newer services; older DTOs omit them. */
  queuedAt?: string | null;
  startedAt?: string | null;
  finishedAt?: string | null;
  updatedAt?: string | null;
  durationMillis?: number | null;
}

export interface SessionDirectoryLike {
  id: string;
  path: string;
  writeEnabled: boolean;
}

export interface DirectoryAccessLike {
  savedSessionVersion?: number;
  savedWriteMode?: 'NONE' | 'ROOTS' | 'ALL' | string;
  entries?: Array<{
    id?: string;
    writable?: boolean;
    immutable?: boolean;
    reason?: 'DIRECT' | 'ANCESTOR' | 'READ_ONLY_SESSION' | 'NOT_GRANTED' | 'FULL_ACCESS' | 'DEFAULT_WORKSPACE' | string;
    coveredByDirectoryId?: string | null;
  }>;
  activeTurn?: {
    runId?: string;
    sessionVersion?: number;
    writeMode?: 'NONE' | 'ROOTS' | 'ALL' | string;
    scopeHash?: string;
  } | null;
}

export interface WorkspaceConflictLike {
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
  state: string;
  stateVersion: number;
  currentContent?: string | null;
  proposedContent?: string | null;
  resolutionRef?: string | null;
  baseVersionToken?: string | null;
  baseContentRef?: string | null;
  currentContentRef?: string | null;
  proposedContentRef?: string | null;
  proposedByteLength?: number | null;
  base?: { ref?: string | null; version?: string | null } | null;
  current?: { ref?: string | null; version?: string | null } | null;
  proposed?: { ref?: string | null; version?: string | null } | null;
  autoMerge?: { status?: string | null; previewRef?: string | null; reason?: string | null } | null;
  allowedActions?: string[];
  resolution?: { choice?: string | null; resultRef?: string | null; resolvedBy?: string | null; resolvedAt?: string | null; appliedOperationId?: string | null } | null;
  limits?: { maxContentBytes?: number; previewTruncated?: boolean | null } | null;
}

export interface RunDeliveryLike {
  status?: string | null;
  artifactsReady?: boolean | null;
  stateVersion?: number | null;
  changeArtifactRef?: string | null;
  evidenceManifestRef?: {
    manifestId?: string | null;
    sha256?: string | null;
    stateVersion?: number | null;
  } | null;
}

/** Structured verification projection mirrored from Business RunRecord.verificationV2. */
export interface RunVerificationV2Like {
  overall?: string | null;
  requiredLanesPassed?: boolean | null;
  warnings?: string[] | null;
  lanes?: Array<{
    planId?: string | null;
    lane?: string | null;
    disposition?: string | null;
    passed?: boolean | null;
    attributionKinds?: string | null;
    attributionConfidence?: string | null;
  }> | null;
}

export interface ProjectLike {
  projectId: string;
  displayName?: string | null;
  workspaceAlias: string;
  vcsKind?: string | null;
  branchDisplay?: string | null;
  headShortRevision?: string | null;
  authorityStatus?: string | null;
  dirtySummary?: string | null;
  runningCount?: number;
  attentionCount?: number;
}

export interface AttentionLike {
  attentionId: string;
  sourceId?: string | null;
  attentionType?: string | null;
  sessionId?: string | null;
  summary?: string | null;
  status?: string | null;
}

export interface WorkspaceBindingLike {
  workspaceLaneId?: string | null;
  workspaceExecutionId?: string | null;
  workspaceRef?: string | null;
  mode?: string | null;
  baseRevision?: string | null;
  baseSource?: string | null;
  state?: string | null;
  integrationState?: string | null;
  latestDeliveryId?: string | null;
  stateVersion?: number | null;
}

/** Server projection of the delivery review aggregate (review P0-04). */
export interface DeliveryReviewLike {
  deliveryId: string;
  projectId?: string | null;
  workspaceLaneId?: string | null;
  /** WU-06 (design §5.2): durable sync-session this delivery ran under. */
  syncSessionId?: string | null;
  state?: string | null;
  stateVersion?: number | null;
  changeSetFingerprint?: string | null;
  baseRevision?: string | null;
  expectedTargetOid?: string | null;
  targetFingerprint?: string | null;
  preflightTargetFingerprint?: string | null;
  preflightConflictPaths?: string[] | null;
  targetPolicy?: string | null;
  approvalFingerprint?: string | null;
  integrationAttemptId?: string | null;
  targetBeforeOid?: string | null;
  targetAfterOid?: string | null;
  journalRef?: string | null;
  conflictSummary?: string | null;
  receiptId?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
}

export interface DeliveryChangesLike {
  deliveryId: string;
  changeSetFingerprint?: string | null;
  baseRevision?: string | null;
  targetLabel?: string | null;
  targetFingerprint?: string | null;
  canApply?: boolean;
  conflictPaths?: string[];
  files?: Array<{
    path: string;
    changeType: string;
    beforeSha256?: string | null;
    afterSha256?: string | null;
    beforeText?: string | null;
    afterText?: string | null;
  }>;
}

export function decodeRunLike(value: unknown): RunLike {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('RUN_STATE_INVALID');
  }
  const raw = value as Record<string, unknown>;
  if (typeof raw.runId !== 'string' || typeof raw.taskId !== 'string'
      || typeof raw.state !== 'string' || typeof raw.stateVersion !== 'number') {
    throw new Error('RUN_STATE_INVALID');
  }
  return {
    runId: raw.runId,
    taskId: raw.taskId,
    state: raw.state,
    sourceStatus: typeof raw.sourceStatus === 'string' ? raw.sourceStatus : null,
    stateVersion: raw.stateVersion,
    changedFileCount: typeof raw.changedFileCount === 'number' && Number.isFinite(raw.changedFileCount)
      ? raw.changedFileCount : undefined,
    workspaceAlias: typeof raw.workspaceAlias === 'string' ? raw.workspaceAlias : null,
    sessionId: typeof raw.sessionId === 'string' ? raw.sessionId : null,
    outcomeSeverity: typeof raw.outcomeSeverity === 'string' ? raw.outcomeSeverity : null,
    verificationV2: typeof raw.verificationV2 === 'object' && raw.verificationV2 !== null
      ? raw.verificationV2 as RunVerificationV2Like : null,
    delivery: typeof raw.delivery === 'object' && raw.delivery !== null
      ? raw.delivery as RunDeliveryLike : null,
    failure: decodeRunFailure(raw) ?? null,
    failureCode: typeof raw.failureCode === 'string' ? raw.failureCode.slice(0, 128) : null,
    failureMessage: typeof raw.failureMessage === 'string' ? raw.failureMessage.slice(0, 2000) : null,
    terminationCode: typeof raw.terminationCode === 'string' ? raw.terminationCode.slice(0, 128) : null,
    scheduling: raw.scheduling === null ? null : decodeScheduling(raw.scheduling),
    reasonCode: typeof raw.reasonCode === 'string' ? raw.reasonCode : null,
    queuedAt: typeof raw.queuedAt === 'string' ? raw.queuedAt : null,
    startedAt: typeof raw.startedAt === 'string' ? raw.startedAt : null,
    finishedAt: typeof raw.finishedAt === 'string' ? raw.finishedAt : null,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : null,
    durationMillis: typeof raw.durationMillis === 'number' && Number.isFinite(raw.durationMillis)
      ? raw.durationMillis : null,
    attention: typeof raw.attention === 'object' && raw.attention !== null
      ? {
          clearedAt: typeof (raw.attention as Record<string, unknown>).clearedAt === 'string'
            ? (raw.attention as Record<string, unknown>).clearedAt as string : null,
          openCount: typeof (raw.attention as Record<string, unknown>).openCount === 'number'
            ? (raw.attention as Record<string, unknown>).openCount as number : undefined
        }
      : null,
    continuationOf: typeof raw.continuationOf === 'string' ? raw.continuationOf : null,
    continuedBy: typeof raw.continuedBy === 'string' ? raw.continuedBy : null,
    workspaceConflicts: Array.isArray(raw.workspaceConflicts)
      ? raw.workspaceConflicts.filter((item): item is Record<string, unknown> =>
          typeof item === 'object' && item !== null && !Array.isArray(item)
          && typeof (item as Record<string, unknown>).conflictId === 'string'
          && typeof (item as Record<string, unknown>).path === 'string')
        .map((item) => ({
          conflictId: item.conflictId as string,
          runId: typeof item.runId === 'string' ? item.runId : raw.runId as string,
          sessionId: typeof item.sessionId === 'string' ? item.sessionId : null,
          path: item.path as string,
          kind: typeof item.kind === 'string' ? item.kind : null,
          expectedVersion: typeof item.expectedVersion === 'string' ? item.expectedVersion : null,
          actualVersion: typeof item.actualVersion === 'string' ? item.actualVersion : null,
          state: typeof item.state === 'string' ? item.state : 'OPEN',
          stateVersion: typeof item.stateVersion === 'number' ? item.stateVersion : 1,
          currentContent: typeof item.currentContent === 'string' ? item.currentContent : null,
          proposedContent: typeof item.proposedContent === 'string' ? item.proposedContent : null,
          resolutionRef: typeof item.resolutionRef === 'string' ? item.resolutionRef : null
        }))
      : []
  };
}

export function useProjects() {
  return useQuery({
    queryKey: ['projects'],
    queryFn: async () => unwrap(await window.codeAgentDesktop.listProjects()) as ProjectLike[]
  });
}

export interface ProjectSessionPreflightLike {
  projectId: string;
  workspaceAlias: string;
  workspaceId?: string;
  headRevision?: string;
  workspaceFingerprint?: string;
  revision: string;
  policyFingerprint: string;
  authorityStatus: string;
  allowedIntents: string[];
  suggestedWriteScope: string[];
  writeScopeCeiling: string[];
  modelAlias?: string | null;
  modelAvailability: string;
}

export function useProjectSessionPreflight(projectId: string | null, enabled = true) {
  return useQuery({
    queryKey: ['project-session-preflight', projectId],
    enabled: enabled && projectId !== null,
    // Preflight is read-only and can race the Service becoming ready after
    // bootstrap. A single transient fetch failure must not permanently lock
    // the Code entry point until the user reloads the desktop app.
    retry: 3,
    retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 5000),
    refetchOnReconnect: true,
    refetchOnWindowFocus: true,
    queryFn: async () => unwrap(await window.codeAgentDesktop.getProjectSessionPreflight(
      projectId as string
    )) as ProjectSessionPreflightLike
  });
}

export function useSessions(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: ['sessions'],
    enabled: options?.enabled ?? true,
    queryFn: async () => (unwrap<SessionLike[]>(await window.codeAgentDesktop.listSessions())).filter((session) => session.sessionPurpose == null || session.sessionPurpose === 'MAIN')
  });
}

export function useSession(sessionId: string | null, options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: ['sessions', sessionId],
    enabled: (options?.enabled ?? true) && sessionId !== null,
    // Ordinary chat commits its turn only after the synchronous model call
    // returns and has no Run to advertise. Keep the selected legacy detail
    // warm so a missed event cannot leave the transcript stale until the next
    // navigation.
    refetchInterval: sessionId !== null ? 2_000 : false,
    refetchOnReconnect: true,
    queryFn: async () => {
      const session = unwrap(await window.codeAgentDesktop.getSession(sessionId as string)) as SessionLike;
      // The service serializes message roles in enum case ('ASSISTANT'); the
      // renderer model is lowercase ('assistant') — normalize at the boundary.
      for (const message of session.messages ?? []) {
        if (typeof message.role === 'string') message.role = message.role.toLowerCase();
      }
      return session;
    }
  });
}

/**
 * Model-catalog refs are provider-qualified (e.g. "commandcode-chat/mimo-v2.6-flash")
 * for `defaultModel` and stored session/profile aliases, while catalog entries
 * carry a bare `modelAlias` plus `providerId`. Match against both forms so a
 * stored ref resolves to its catalog entry instead of looking unavailable.
 */
export function modelCatalogEntryRef(entry: { providerId?: string | null; modelAlias: string }): string {
  return entry.providerId ? `${entry.providerId}/${entry.modelAlias}` : entry.modelAlias;
}

export function modelCatalogEntryMatches(
  entry: { providerId?: string | null; modelAlias: string },
  modelRef: string | null | undefined
): boolean {
  return Boolean(modelRef) && (entry.modelAlias === modelRef || modelCatalogEntryRef(entry) === modelRef);
}

export interface AgentProfileLike {
  id: string;
  name: string;
  description: string;
  revision: string;
  readonlyResearchDefault: 'AUTO' | 'OFF' | string;
  modelSettings?: SessionLike['modelSettings'];
}

export interface AgentProfilesLike {
  profiles: AgentProfileLike[];
  loadErrors?: Array<{ fileName: string; code: string; message: string }>;
}

const DEFAULT_AGENT_PROFILE: AgentProfileLike = {
  id: 'default',
  name: '默认智能体',
  description: '使用宿主默认的完整 CodeAgent 能力',
  revision: 'builtin-default',
  readonlyResearchDefault: 'AUTO'
};

export function useAgentProfiles(enabled = true) {
  return useQuery({
    queryKey: ['agent-profiles'],
    enabled,
    retry: false,
    queryFn: async (): Promise<AgentProfilesLike> => {
      const listAgentProfiles = window.codeAgentDesktop.listAgentProfiles;
      if (typeof listAgentProfiles !== 'function') {
        return { profiles: [DEFAULT_AGENT_PROFILE], loadErrors: [] };
      }
      return unwrap(await listAgentProfiles()) as AgentProfilesLike;
    }
  });
}

/**
 * Single Run query-key factory (design §8.4): every reader and every
 * invalidation must derive Run cache keys from here. The historical bug this
 * closes — reading `getQueryData(['runs'])` while the real key carries
 * workspace/session parameters — silently verified a cache that never
 * existed, so terminal convergence retried forever.
 */
export function runsQueryKey(query: { workspaceAlias?: string; sessionId?: string }) {
  return ['runs', query.workspaceAlias ?? null, query.sessionId ?? null] as const;
}

export function useRuns(query: { workspaceAlias?: string; sessionId?: string }, options?: { poll?: boolean }) {
  return useQuery({
    queryKey: runsQueryKey(query),
    queryFn: async () => {
      const response = unwrap(await window.codeAgentDesktop.listRuns(query)) as {
        items?: unknown[];
      };
      return (response.items ?? []).map(decodeRunLike);
    },
    // Safety net for a missed durable frame: every non-terminal state must
    // keep polling, including approval waits.  The previous predicate only
    // covered RUNNING/QUEUED, so a run could stop refreshing exactly when it
    // entered WAITING_APPROVAL and leave the composer looking stuck.
    refetchInterval: (query) => {
      if (options?.poll) return 2_000;
      const items = query.state.data ?? [];
      const hasLive = items.some((run) => [
        'RUNNING',
        'QUEUED',
        'WAITING_APPROVAL',
        'WAITING_BUDGET_APPROVAL'
      ].includes(run.state));
      return hasLive ? 2_000 : false;
    },
    refetchOnReconnect: true
  });
}

export function useAttention() {
  return useQuery({
    queryKey: ['attention'],
    queryFn: async () => {
      const body = unwrap(await window.codeAgentDesktop.listAttention()) as {
        items?: AttentionLike[];
      };
      return body.items ?? [];
    }
  });
}

// ---- Unified permission / approval v2 projections ----

export type ExecutionPolicyLike = ExecutionPolicyResponse;
export type ApprovalRequestLike = ApprovalRequestV2;

/**
 * Compatibility projection for services that predate the COMMAND approval
 * kind.  The service remains the authority for allowedActions and all other
 * approval fields; the renderer only repairs the type label when the record
 * explicitly identifies the process capability family.
 */
export function normalizeApprovalForRenderer(approval: ApprovalRequestLike): ApprovalRequestLike {
  if (approval.kind !== 'UNKNOWN' || !/^process(?:\.|$)/i.test(approval.agentId)) return approval;
  return { ...approval, kind: 'COMMAND' };
}

function normalizeApprovalsForRenderer(response: ApprovalsListResponse): ApprovalsListResponse {
  return {
    ...response,
    items: response.items.map(normalizeApprovalForRenderer)
  };
}

/** Service-owned policy snapshot. The query key includes the session so a
 * fast session switch cannot render or mutate the previous session's mode. */
export function useExecutionPolicy(sessionId: string | null, projectId: string | null = null, enabled = true) {
  return useQuery({
    queryKey: ['execution-policy', sessionId, projectId],
    enabled: enabled && sessionId !== null && typeof window.codeAgentDesktop.getExecutionPolicy === 'function',
    retry: false,
    queryFn: async () => unwrap(await window.codeAgentDesktop.getExecutionPolicy(sessionId as string, projectId ?? undefined)) as ExecutionPolicyLike
  });
}

export function useExecutionPolicyDefaults(projectId: string | null, enabled = true) {
  return useQuery({
    queryKey: ['execution-policy-defaults', projectId],
    enabled: enabled && projectId !== null && typeof window.codeAgentDesktop.getExecutionPolicyDefaults === 'function',
    retry: false,
    queryFn: async () => unwrap(await window.codeAgentDesktop.getExecutionPolicyDefaults(projectId as string)) as ExecutionPolicyDefaultsResponse
  });
}

/** The caller's durable user-scope default applied to every new session. */
export function useMyExecutionPolicyDefaults(enabled = true) {
  return useQuery({
    queryKey: ['execution-policy-defaults', 'me'],
    enabled: enabled && typeof window.codeAgentDesktop.getMyExecutionPolicyDefaults === 'function',
    retry: false,
    queryFn: async () => unwrap(await window.codeAgentDesktop.getMyExecutionPolicyDefaults()) as ExecutionPolicyDefaultsResponse
  });
}

/** Durable per-session automatic-dispatch pause state. This is a projection;
 * the Service remains the only authority for whether queued work dispatches. */
export function useAutomationControl(sessionId: string | null, enabled = true) {
  return useQuery({
    queryKey: ['automation-control', sessionId],
    enabled: enabled && sessionId !== null && typeof window.codeAgentDesktop.getAutomationControl === 'function',
    retry: false,
    queryFn: async () => unwrap(await window.codeAgentDesktop.getAutomationControl(sessionId as string)) as AutomationControlResponse
  });
}

export function useSessionApprovals(sessionId: string | null, enabled = true) {
  return useQuery({
    queryKey: ['approvals', sessionId],
    enabled: enabled && sessionId !== null && typeof window.codeAgentDesktop.listApprovals === 'function',
    retry: false,
    refetchInterval: (query) => {
      const items = (query.state.data as ApprovalsListResponse | undefined)?.items ?? [];
      // The first request can race the Product's approval creation. Keep a
      // lightweight selected-session poll even when the previous snapshot
      // was empty, otherwise a newly-created process approval can remain
      // invisible until a manual refresh or another event invalidates it.
      return items.some((item) => item.decisionStatus === 'PENDING' || item.decisionStatus === 'WAITING_DELAY') ? 1000 : 2000;
    },
    queryFn: async () => normalizeApprovalsForRenderer(
      unwrap(await window.codeAgentDesktop.listApprovals(sessionId as string, { limit: 100 })) as ApprovalsListResponse
    )
  });
}

export function useApproval(approvalId: string | null, enabled = true) {
  return useQuery({
    queryKey: ['approval', approvalId],
    enabled: enabled && approvalId !== null && typeof window.codeAgentDesktop.getApproval === 'function',
    retry: false,
    queryFn: async () => normalizeApprovalForRenderer(
      unwrap(await window.codeAgentDesktop.getApproval(approvalId as string)) as ApprovalRequestLike
    )
  });
}

/** Capability lookup is a pure projection of the bootstrap handshake. */
export function capabilityOperation(capabilities: { operations?: Array<{ id: string; availability: string; reasonCode?: string | null }> } | undefined, operationId: string) {
  return capabilities?.operations?.find((operation) => operation.id === operationId) ?? null;
}

// ---- EW6: diff / review / evidence projections ----

export interface DiffFileLike {
  path: string;
  changeType?: string | null;
  binary?: boolean;
  patch?: string | null;
  truncated?: boolean;
  /** RENAMED files carry their pre-change ref; a write activity that names
   * the old path still matches the diff entry. */
  previousFileRef?: string | null;
}

export interface DiffPageLike {
  runId: string;
  stateVersion: number;
  artifactId?: string | null;
  baselineFingerprint?: string | null;
  endFingerprint?: string | null;
  baselineContentManifestRef?: string | null;
  endContentManifestRef?: string | null;
  deltaSemantic?: string | null;
  complete?: boolean;
  baseRevision?: string | null;
  incompleteReason?: string | null;
  stale?: boolean;
  truncated?: boolean;
  page?: number;
  pageSize?: number;
  hasMore?: boolean;
  files?: DiffFileLike[];
}

export interface FileReadLike {
  projectId: string;
  fileRef: string;
  revisionRef: string;
  mediaType: string;
  encoding: 'UTF-8' | 'BINARY';
  contentText?: string | null;
  contentBytes: number;
  sha256: string;
  truncated: boolean;
  stale: boolean;
}

export function useProjectFile(projectId: string | null, fileRef: string | null) {
  return useQuery({
    queryKey: ['project-file', projectId, fileRef],
    enabled: projectId !== null && fileRef !== null,
    retry: false,
    queryFn: async () => unwrap(await window.codeAgentDesktop.readProjectFile(
      projectId as string,
      fileRef as string
    )) as FileReadLike
  });
}

export function useRunDiff(runId: string | null, page: number, pageSize: number) {
  return useQuery({
    queryKey: ['diff', runId, page, pageSize],
    enabled: runId !== null,
    // The terminal event can reach the renderer just before the service
    // listener persists the immutable change artifact. Retry that narrow
    // handoff race, but keep all other errors fail-closed.
    retry: (failureCount, error) => {
      const message = error instanceof Error ? error.message : String(error);
      const code = error instanceof DesktopProxyError ? error.code : null;
      return (code === 'CHANGE_ARTIFACT_NOT_RECORDED'
        || message.includes('CHANGE_ARTIFACT_NOT_RECORDED')) && failureCount < 3;
    },
    retryDelay: (failureCount) => 250 * (failureCount + 1),
    queryFn: async () => unwrap(await window.codeAgentDesktop.getRunDiff(runId as string, { page, pageSize })) as DiffPageLike
  });
}

export interface RunDiffFilesResult {
  /** Matched diff entries in the order the paths were requested. */
  files: DiffFileLike[];
  /** Requested refs absent from every scanned page — the path display
   * text, already normalized to `/` separators. */
  missingPaths: string[];
  stale: boolean;
  complete: boolean;
  /** False when the scan hit its page bound while hasMore was still true —
   * a missing match may simply live on an unscanned page. */
  scannedAll: boolean;
}

/** Normalize a service-owned file ref/diff path for matching. Absolute
 * paths and `.`/`..` segments fail closed; the compare key folds case
 * because workspace lanes on Windows are case-insensitive. */
function diffPathKey(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().replaceAll('\\', '/').replace(/^\.\//, '');
  if (!normalized || normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized)) return null;
  const parts = normalized.split('/').filter(Boolean);
  if (parts.length === 0 || parts.some((part) => part === '.' || part === '..')) return null;
  return parts.join('/').toLowerCase();
}

const DIFF_FILE_SCAN_PAGES = 10;
const DIFF_FILE_SCAN_PAGE_SIZE = 100;

/**
 * Bounded per-path lookup over the paged run diff (EW6): a 修改文件 row
 * needs the patch for its own targets, not the whole change artifact.
 * Paging stops as soon as every requested path matched; the result keeps
 * the coverage flag so the UI can label partial scans honestly. The diff
 * is cumulative for the run (START_CONTENT_TO_END_CONTENT) and only exists
 * once the terminal change artifact is recorded.
 */
export function useRunDiffFiles(runId: string | null, paths: ReadonlyArray<string>, enabled = true) {
  const requestKey = paths.join('\u0001');
  return useQuery({
    queryKey: ['run-diff-files', runId, requestKey],
    enabled: enabled && runId !== null && paths.length > 0
      && typeof window !== 'undefined'
      && typeof window.codeAgentDesktop?.getRunDiff === 'function',
    retry: (failureCount, error) => {
      const code = error instanceof DesktopProxyError ? error.code : null;
      const message = error instanceof Error ? error.message : String(error);
      return (code === 'CHANGE_ARTIFACT_NOT_RECORDED'
        || message.includes('CHANGE_ARTIFACT_NOT_RECORDED')) && failureCount < 3;
    },
    retryDelay: (failureCount) => 250 * (failureCount + 1),
    queryFn: async (): Promise<RunDiffFilesResult> => {
      const wanted = new Map<string, string>();
      for (const raw of paths) {
        const key = diffPathKey(raw);
        if (key !== null && !wanted.has(key)) {
          wanted.set(key, raw.trim().replaceAll('\\', '/'));
        }
      }
      const matched = new Map<string, DiffFileLike>();
      let stale = false;
      let complete = true;
      let scannedAll = true;
      for (let page = 0; page < DIFF_FILE_SCAN_PAGES; page += 1) {
        const response = unwrap(await window.codeAgentDesktop.getRunDiff(
          runId as string, { page, pageSize: DIFF_FILE_SCAN_PAGE_SIZE })) as DiffPageLike;
        stale = stale || response.stale === true;
        if (response.complete === false) complete = false;
        for (const file of response.files ?? []) {
          for (const candidate of [file.path, file.previousFileRef]) {
            const key = diffPathKey(candidate);
            if (key !== null && wanted.has(key) && !matched.has(key)) matched.set(key, file);
          }
        }
        if (matched.size === wanted.size || response.hasMore !== true) break;
        if (page === DIFF_FILE_SCAN_PAGES - 1) scannedAll = false;
      }
      return {
        files: [...wanted.keys()]
          .map((key) => matched.get(key))
          .filter((file): file is DiffFileLike => file !== undefined),
        missingPaths: [...wanted.entries()]
          .filter(([key]) => !matched.has(key))
          .map(([, display]) => display),
        stale,
        complete,
        scannedAll
      };
    }
  });
}

export type RunDiffSummary = { files: number; additions: number; deletions: number; complete: boolean };

/**
 * Whole-run diff summary shared by the activity panel and the composer diff
 * strip (ui-polish-plan-2026-10 §6.4). The query key is intentionally the
 * legacy `activity-summary-diff` so both consumers share one cache entry.
 */
export function useRunDiffSummary(runId: string | null, enabled = true) {
  return useQuery({
    queryKey: ['activity-summary-diff', runId],
    enabled: enabled && runId !== null && typeof window.codeAgentDesktop.getRunDiff === 'function',
    retry: false,
    queryFn: async (): Promise<RunDiffSummary> => {
      const files = new Map<string, { patch?: string | null }>();
      let page = 0;
      let complete = true;
      for (let request = 0; request < 100; request += 1) {
        const response = unwrap(await window.codeAgentDesktop.getRunDiff(runId as string, { page, pageSize: 100 })) as DiffPageLike;
        for (const file of response.files ?? []) files.set(file.path ?? `file-${files.size}`, file);
        complete = complete && response.complete !== false;
        if (!response.hasMore) break;
        page += 1;
      }
      let additions = 0;
      let deletions = 0;
      for (const file of files.values()) {
        for (const line of (file.patch ?? '').split('\n')) {
          if (line.startsWith('+++') || line.startsWith('---')) continue;
          if (line.startsWith('+')) additions += 1;
          if (line.startsWith('-')) deletions += 1;
        }
      }
      return { files: files.size, additions, deletions, complete };
    }
  });
}

export function useRunWorkspaceConflicts(runId: string | null) {
  return useQuery({
    queryKey: ['workspace-conflicts', runId],
    enabled: runId !== null && typeof window.codeAgentDesktop.listRunWorkspaceConflicts === 'function',
    retry: false,
    queryFn: async () => unwrap(await window.codeAgentDesktop.listRunWorkspaceConflicts(runId as string)) as {
      runId: string;
      items: WorkspaceConflictLike[];
    }
  });
}

export function useResolveWorkspaceConflict() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      conflictId: string;
      body: {
        expectedStateVersion?: number;
        expectedCurrentHash?: string | null;
        choice: 'KEEP_CURRENT' | 'USE_PROPOSED' | 'MERGED_CONTENT' | 'AUTO_MERGED' | 'DISMISS';
        resolutionContent?: string | null;
        resolutionRef?: string | null;
      };
    }) => unwrap(await window.codeAgentDesktop.resolveWorkspaceConflict(input.conflictId, input.body)),
    onSuccess: (result: unknown) => {
      const conflict = result as { runId?: string };
      void queryClient.invalidateQueries({ queryKey: ['runs'] });
      void queryClient.invalidateQueries({ queryKey: ['workspace-conflicts-filtered'] });
      if (conflict.runId) void queryClient.invalidateQueries({ queryKey: ['workspace-conflicts', conflict.runId] });
    }
  });
}

/**
 * WU-05 (design §6.5): POST /api/v2/runs/{id}/continue — creates the linked
 * follow-up run once the run's workspace attention is cleared.  The server
 * returns the NEW run; the original stays NEEDS_ATTENTION w/ continuedBy.
 */
export function useContinueRun() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { runId: string; expectedStateVersion?: number | null; message?: string | null }) =>
      unwrap(await window.codeAgentDesktop.continueRun(input.runId, {
        expectedStateVersion: input.expectedStateVersion ?? undefined,
        message: input.message ?? undefined
      })),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['runs'] });
      void queryClient.invalidateQueries({ queryKey: ['session'] });
      void queryClient.invalidateQueries({ queryKey: ['sessions'] });
      void queryClient.invalidateQueries({ queryKey: ['workspace-conflicts'] });
      void queryClient.invalidateQueries({ queryKey: ['workspace-conflicts-filtered'] });
    }
  });
}

/** Index-filtered conflict collection (design §6.4); groups by origin in the Changes sidebar. */
export function useWorkspaceConflictsFiltered(filters: {
  projectId?: string | null; origin?: string | null; runId?: string | null;
  state?: string | null; cursor?: string | null; limit?: number;
} | null) {
  return useQuery({
    queryKey: ['workspace-conflicts-filtered', filters?.projectId ?? null, filters?.origin ?? null,
      filters?.runId ?? null, filters?.state ?? null, filters?.cursor ?? null, filters?.limit ?? 50],
    enabled: filters !== null && typeof window.codeAgentDesktop.listWorkspaceConflicts === 'function',
    retry: false,
    queryFn: async () => unwrap(await window.codeAgentDesktop.listWorkspaceConflicts({
      projectId: filters?.projectId ?? undefined,
      origin: filters?.origin ?? undefined,
      runId: filters?.runId ?? undefined,
      state: filters?.state ?? undefined,
      cursor: filters?.cursor ?? undefined,
      limit: filters?.limit
    })) as WorkspaceConflictLike[]
  });
}

export function useWorkspaceConflictAutoMerge() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (conflictId: string) =>
      unwrap(await window.codeAgentDesktop.autoMergeWorkspaceConflict(conflictId)),
    onSuccess: (_result, conflictId) => {
      void queryClient.invalidateQueries({ queryKey: ['workspace-conflicts'] });
      void queryClient.invalidateQueries({ queryKey: ['workspace-conflicts-filtered'] });
      void queryClient.invalidateQueries({ queryKey: ['workspace-conflict', conflictId] });
    }
  });
}

export function useDismissWorkspaceConflict() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (conflictId: string) =>
      unwrap(await window.codeAgentDesktop.dismissWorkspaceConflict(conflictId)),
    onSuccess: (result: unknown) => {
      const conflict = result as { runId?: string };
      void queryClient.invalidateQueries({ queryKey: ['runs'] });
      void queryClient.invalidateQueries({ queryKey: ['workspace-conflicts-filtered'] });
      if (conflict.runId) void queryClient.invalidateQueries({ queryKey: ['workspace-conflicts', conflict.runId] });
    }
  });
}

export function useResolveWorkspaceConflictsBatch() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      body: {
        syncSessionId?: string | null;
        items: Array<{
          conflictId: string;
          expectedStateVersion?: number;
          expectedCurrentHash?: string | null;
          choice: 'KEEP_CURRENT' | 'USE_PROPOSED' | 'MERGED_CONTENT' | 'AUTO_MERGED' | 'DISMISS';
          resolutionContent?: string | null;
          resolutionRef?: string | null;
        }>;
      };
    }) => unwrap(await window.codeAgentDesktop.resolveWorkspaceConflictsBatch(input.body)),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['runs'] });
      void queryClient.invalidateQueries({ queryKey: ['workspace-conflicts'] });
      void queryClient.invalidateQueries({ queryKey: ['workspace-conflicts-filtered'] });
    }
  });
}

export function useWorkspaceConflictProposal(conflictId: string | null, proposalId: string | null) {
  return useQuery({
    queryKey: ['workspace-conflict-proposal', conflictId, proposalId],
    enabled: conflictId !== null && proposalId !== null
      && typeof window.codeAgentDesktop.pollWorkspaceConflictProposal === 'function',
    refetchInterval: (query) => {
      const status = query.state.data
        ? String((query.state.data as { status?: string }).status ?? '') : '';
      return status === 'PENDING' ? 1500 : false;
    },
    retry: false,
    queryFn: async () => unwrap(await window.codeAgentDesktop.pollWorkspaceConflictProposal(
      proposalId as string)) as { proposalId: string; status: string; proposalRef?: string | null; error?: string | null }
  });
}

export function useRequestWorkspaceConflictProposal() {
  return useMutation({
    mutationFn: async (conflictId: string) =>
      unwrap(await window.codeAgentDesktop.requestWorkspaceConflictProposal(conflictId)) as {
        proposalId: string; status: string;
      }
  });
}

/** Reads a checksum-addressed blob through the main proxy (bounded). */
export async function readWorkspaceContentText(
  ref: string, maxBytes = 2 * 1024 * 1024
): Promise<{ text: string; truncated: boolean; totalBytes: number | null }> {
  const out = unwrap(await window.codeAgentDesktop.getWorkspaceContent(ref, { limit: maxBytes })) as {
    contentBase64: string; truncated: boolean; totalBytes?: number | null;
  };
  const bytes = Uint8Array.from(atob(out.contentBase64), (c) => c.charCodeAt(0));
  return {
    text: new TextDecoder('utf-8').decode(bytes),
    truncated: out.truncated,
    totalBytes: out.totalBytes ?? null
  };
}

export interface FindingLike {
  findingId: string;
  severity?: string | null;
  file?: string | null;
  line?: number | null;
  message?: string | null;
  fixTaskId?: string | null;
}

export interface ReviewRunLike {
  reviewId: string;
  runId: string;
  stateVersion?: number;
  status?: string | null;
  complete?: boolean;
  sourceArtifactId?: string | null;
  findings?: FindingLike[];
}

export function useRunReview(runId: string | null) {
  return useQuery({
    queryKey: ['review', runId],
    enabled: runId !== null,
    retry: false,
    queryFn: async () => unwrap(await window.codeAgentDesktop.getRunReview(runId as string)) as ReviewRunLike
  });
}

export interface EvidenceItemLike {
  evidenceId: string;
  layer: string;
  status: string;
  summary?: Record<string, unknown>;
}

export interface EvidenceBundleLike {
  runId: string;
  generatedAt?: string;
  complete?: boolean;
  items?: EvidenceItemLike[];
  stateVersion?: number | null;
  artifactsReady?: boolean | null;
  deliveryStatus?: string | null;
  changeArtifactRef?: string | null;
  manifestRef?: {
    manifestId?: string | null;
    sha256?: string | null;
    stateVersion?: number | null;
  } | null;
  verificationV2?: RunVerificationV2Like | null;
  outcomeSeverity?: string | null;
}

export function useRunEvidence(runId: string | null) {
  return useQuery({
    queryKey: ['evidence', runId],
    enabled: runId !== null,
    retry: false,
    queryFn: async () => unwrap(await window.codeAgentDesktop.getRunEvidence(runId as string)) as EvidenceBundleLike
  });
}

// ---- Run activity snapshot (design 2026-09-02 §11.2) ----

export interface RunActivityListItem {
  activityId: string;
  runId: string;
  kind: string;
  status: string;
  attempt?: number | null;
  outcomeVersion?: number | null;
  /** Model-interaction round key (design 2026-09-19 §5.1); absent on
   * legacy/runtime-owned items — never inferred downstream. */
  roundId?: string | null;
  roundOrdinal?: number | null;
  toolName?: string | null;
  capabilityId?: string | null;
  detail?: string | null;
  commandPreview?: string | null;
  redactionState?: string | null;
  targets?: Array<{ ref: string; status: string }>;
  startedAt?: string | null;
  finishedAt?: string | null;
  durationMillis?: number | null;
  resultSummary?: string | null;
  reasonCode?: string | null;
  failure?: FailureDescriptor | null;
  scheduling?: RunSchedulingProjection | null;
  effectState?: 'NOT_APPLIED' | 'APPLIED' | 'UNKNOWN' | null;
  truncated?: boolean | null;
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
  /** Execution-evidence references (design 2026-09-26 WU-1): opaque ids and
   * record-relative artifact paths — artifact bytes are fetched separately
   * through the session execution artifact endpoint. */
  executionId?: string | null;
  commandId?: string | null;
  evidenceState?: string | null;
  evidenceArtifacts?: string[] | null;
}

export interface RunActivitySnapshot {
  runId: string;
  runStateVersion: number;
  snapshotCursor: number;
  complete: boolean;
  reasonCode?: string | null;
  truncated?: boolean;
  items: RunActivityListItem[];
  summary: {
    completeness: string;
    activityCount: number;
    runningCount?: number;
    succeededCount?: number;
    partialCount?: number;
    failedCount?: number;
    uniqueReadFileCount?: number;
    uniqueWrittenFileCount?: number;
    commandCount?: number;
  };
}

/** Service-folded activity snapshot; live deltas merge on top in App state.
 * `options.enabled` gates the fetch so historical activity loads only when
 * the user expands its entry (design §9.1), not on session open. */
export function useRunActivities(runId: string | null, options?: { enabled?: boolean; live?: boolean }) {
  return useQuery({
    queryKey: ['activities', runId],
    enabled: (options?.enabled ?? true) && runId !== null,
    retry: 1,
    // The snapshot is the normal durable fold. While a Run is active, keep a
    // bounded read-after-write fallback so a temporarily unavailable SSE
    // stream cannot hide all tool execution from the conversation.  `complete`
    // means the current snapshot page is complete; it does not mean the Run
    // is terminal, so an active Run must continue polling for new activities.
    refetchInterval: (query) => {
      if (!options?.live) return false;
      return 2_000;
    },
    refetchOnReconnect: true,
    staleTime: Infinity,
    queryFn: async () => unwrap(await window.codeAgentDesktop.getRunActivities(runId as string)) as RunActivitySnapshot
  });
}

// ---- Session execution evidence (design 2026-09-26 §10.2 / WU-1) ----

export interface SessionExecutionArtifactSliceView {
  executionId: string;
  path: string;
  content: string;
  offset: number;
  totalBytes: number;
  hasMore: boolean;
}

/**
 * On-demand bounded artifact slice for one execution reference published on
 * an activity. `enabled` must stay false until the user expands the log —
 * artifact fetches are never speculative. The service enforces session
 * ownership and per-request byte bounds.
 */
export function useSessionExecutionArtifact(
  sessionId: string | null,
  executionId: string | null,
  path: string | null,
  options?: { enabled?: boolean; offset?: number; maxBytes?: number }
) {
  const apiAvailable = typeof window !== 'undefined'
    && typeof window.codeAgentDesktop?.readSessionExecutionArtifact === 'function';
  const offset = options?.offset ?? 0;
  const maxBytes = options?.maxBytes ?? 65536;
  return useQuery({
    queryKey: ['session-execution-artifact', sessionId, executionId, path, offset, maxBytes],
    enabled: (options?.enabled ?? true)
      && sessionId !== null && executionId !== null && path !== null && apiAvailable,
    retry: false,
    staleTime: Infinity,
    queryFn: async () => unwrap(await window.codeAgentDesktop.readSessionExecutionArtifact(
      sessionId as string,
      executionId as string,
      path as string,
      { offset, maxBytes }
    )) as SessionExecutionArtifactSliceView
  });
}

/**
 * One journaled execution record (design 2026-09-26 §10.2): identifiers and
 * per-command metadata (argv/cwd/state/exitCode) — artifact bytes stay behind
 * the bounded slice endpoint. Fetched only while the activity row is open.
 */
export function useSessionExecution(
  sessionId: string | null,
  executionId: string | null,
  options?: { enabled?: boolean }
) {
  const apiAvailable = typeof window !== 'undefined'
    && typeof window.codeAgentDesktop?.getSessionExecution === 'function';
  return useQuery({
    queryKey: ['session-execution', sessionId, executionId],
    enabled: (options?.enabled ?? true)
      && sessionId !== null && executionId !== null && apiAvailable,
    retry: false,
    // A still-running execution keeps mutating its record; a finished one is
    // immutable, so a short staleness window is enough.
    staleTime: 15_000,
    queryFn: async () => unwrap(await window.codeAgentDesktop.getSessionExecution(
      sessionId as string, executionId as string
    )) as SessionExecutionRecord
  });
}

// ---- EW7: service-owned workspace executions ----

export interface WorkspaceExecutionLike {
  workspaceExecutionId: string;
  projectId: string;
  kind?: string | null;
  baselineRevision?: string | null;
  workspaceRef?: string | null;
  ownerType?: string | null;
  ownerId?: string | null;
  state?: string | null;
  dirtySummary?: string | null;
  leaseExpiresAt?: string | null;
  stateVersion?: number;
  leaseExpired?: boolean;
}

export function useWorkspaceExecutions(projectId: string | null, options?: { live?: boolean }) {
  return useQuery({
    queryKey: ['workspace-executions', projectId],
    enabled: projectId !== null,
    retry: false,
    refetchInterval: options?.live ? 2_000 : false,
    refetchOnReconnect: true,
    queryFn: async () => {
      const body = unwrap(await window.codeAgentDesktop.listWorkspaceExecutions(projectId as string)) as {
        items?: WorkspaceExecutionLike[];
      };
      return body.items ?? [];
    }
  });
}

// ---- EW8: mission control ----

export interface MissionBudgetLike {
  maxModelTurns?: number;
  maxToolCalls?: number;
  maxWallClockMillis?: number;
  maxWorkItems?: number;
}

export interface MissionLike {
  missionId: string;
  sessionId: string;
  /** Optional service-provided approval id; legacy services use the plan slot. */
  approvalId?: string | null;
  title?: string | null;
  goal?: string | null;
  status?: string | null;
  revision?: number;
  stateVersion?: number;
  budget?: MissionBudgetLike;
  consumedBudget?: MissionBudgetLike;
  workItemStatuses?: Record<string, string>;
  workItemFailures?: Record<string, string>;
  allowedActions?: string[];
  pendingRevisionFingerprint?: string | null;
}

export function useMissions(sessionId: string | null) {
  const apiAvailable = typeof window !== 'undefined'
    && typeof window.codeAgentDesktop?.listMissions === 'function';
  return useQuery({
    queryKey: ['missions', sessionId],
    // sessionId null = service-level cross-session overview (GET /missions
    // without filter); the surface no longer dead-ends on "pick a session".
    enabled: apiAvailable,
    retry: false,
    queryFn: async () => {
      const body = unwrap(await window.codeAgentDesktop.listMissions(sessionId ?? undefined));
      return (Array.isArray(body) ? body : []) as MissionLike[];
    }
  });
}

export type ConnectionState = 'CONNECTING' | 'CONNECTED' | 'RECONNECTING' | 'DISCONNECTED' | 'UNKNOWN';

export interface SpecLike {
  specId: string;
  sessionId?: string | null;
  revision: number;
  status?: string | null;
  contractMarkdown?: string | null;
  contractFingerprint?: string | null;
  policyFingerprint?: string | null;
  workspaceBaselineFingerprint?: string | null;
  planFingerprint?: string | null;
  approvalId?: string | null;
}

export function useSpec(specId: string | null) {
  return useQuery({
    queryKey: ['specs', specId],
    enabled: specId !== null,
    queryFn: async () => unwrap(await window.codeAgentDesktop.getSpec(specId as string)) as SpecLike
  });
}

interface DurableEnvelopeFields {
  runId: string | null;
  sessionId: string | null;
  aggregateVersion: number | null;
}

/** Decodes the envelope headers the routing matrix needs (design §8.1):
 * resourceId routing comes from the envelope, never from type-name guesses. */
function envelopeFields(payload: unknown): DurableEnvelopeFields {
  if (typeof payload !== 'object' || payload === null) {
    return { runId: null, sessionId: null, aggregateVersion: null };
  }
  const envelope = payload as {
    runId?: unknown;
    sessionId?: unknown;
    aggregate?: { version?: unknown } | null;
  };
  return {
    runId: typeof envelope.runId === 'string' ? envelope.runId : null,
    sessionId: typeof envelope.sessionId === 'string' ? envelope.sessionId : null,
    aggregateVersion: typeof envelope.aggregate?.version === 'number'
      ? envelope.aggregate.version
      : null
  };
}

const SESSION_EVENT_TYPES = new Set([
  'session.created', 'session.updated', 'session.archived', 'session.forked'
]);

/**
 * Durable events are routed by envelope ids through the coordinator
 * (§8.1/§8.2): output appends never touch history caches, ordinary run state
 * changes coalesce to ≤2 refreshes/second per resource, and only
 * terminal/approval marks preempt. Optional frameSink receives raw frames
 * (EW4 visible output stream) without building a second state machine here.
 */
export function useDurableEvents(
  onResync: () => void,
  frameSink?: (frame: { cursor: number; type: string; payload: unknown }) => void
): ConnectionState {
  const queryClient = useQueryClient();
  const [state, setState] = useState<ConnectionState>('UNKNOWN');
  const sinkRef = frameSink;
  const resyncRef = onResync;
  const coordinatorRef = useRef<HistoryRefreshCoordinator | null>(null);
  if (!coordinatorRef.current) coordinatorRef.current = new HistoryRefreshCoordinator();

  // The subscription stays ref-stable; invalidations translate exact resource
  // keys, never wildcard prefixes that would fan out into every cached query.
  useEffect(() => {
    const coordinator = coordinatorRef.current;
    if (!coordinator) return;
    return coordinator.subscribe((resources: DirtyResource[]) => {
      for (const resource of resources) {
        if (resource.kind === 'session-list') {
          void queryClient.invalidateQueries({ queryKey: ['sessions'], exact: true });
          // Paginated rail chains (2026-09-05 design §5.3).
          void queryClient.invalidateQueries({ queryKey: ['sessionList'] });
        } else if (resource.kind === 'session-detail') {
          void queryClient.invalidateQueries({
            queryKey: ['sessions', resource.sessionId],
            exact: true
          });
          // Metadata and every message chain of exactly this session.
          void queryClient.invalidateQueries({
            predicate: (query) => {
              const key = query.queryKey;
              if (['collaboration-foundation', 'collaboration-auxiliary-list', 'collaboration-turn-list', 'collaboration-turn'].includes(String(key[0]))) return key[1] === resource.sessionId;
              if (key[0] === 'sessionMetadata') return key[key.length - 1] === resource.sessionId;
              if (key[0] === 'sessionMessages') {
                return key.length >= 4 && key[key.length - 2] === resource.sessionId;
              }
              return false;
            }
          });
        } else if (resource.kind === 'sessions-all') {
          void queryClient.invalidateQueries({ queryKey: ['sessions'] });
          void queryClient.invalidateQueries({ queryKey: ['sessionList'] });
          void queryClient.invalidateQueries({ queryKey: ['sessionMetadata'] });
          void queryClient.invalidateQueries({ queryKey: ['sessionMessages'] });
        } else if (resource.kind === 'runs') {
          void queryClient.invalidateQueries({ queryKey: ['runs'] });
          void queryClient.invalidateQueries({ predicate: (query) => ['collaboration-segments', 'collaboration-boundaries', 'collaboration-handoffs', 'collaboration-boundary', 'collaboration-handoff'].includes(String(query.queryKey[0])) });
        } else if (resource.kind === 'attention') {
          void queryClient.invalidateQueries({ queryKey: ['attention'] });
        }
      }
    });
  }, [queryClient]);

  // Ordinary refreshes pause while the page is hidden or the service is
  // unreachable; terminal/approval marks stay live (design §8.2.4).
  useEffect(() => {
    const onVisibility = () => {
      coordinatorRef.current?.setPaused(document.hidden);
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, []);
  useEffect(() => {
    coordinatorRef.current?.setPaused(state === 'DISCONNECTED' || state === 'RECONNECTING');
  }, [state]);

  useEffect(() => {
    const coordinator = coordinatorRef.current;
    const unsubscribeEvents = window.codeAgentDesktop.onDurableEvents((frames) => {
      for (const frame of frames) {
        if (sinkRef) {
          try { sinkRef(frame); } catch { /* renderer reducers never break on events */ }
        }
        if (!coordinator) continue;
        const { runId, sessionId, aggregateVersion } = envelopeFields(frame.payload);

        // 1. Streaming output/reasoning: the chunk store reducers are the
        // only consumers. No history HTTP at any rate (design R-gate G03).
        if (frame.type === 'run.output.append' || frame.type === 'run.reasoning.append') continue;

        // 2. Terminal: version-driven authoritative read (§8.4), preempting
        // the coalescing window once per terminal transition, plus one
        // bounded delayed re-sync for post-terminal message persistence.
        if (frame.type === 'run.terminal') {
          coordinator.markDirty({ kind: 'attention' }, 'priority');
          readAfterTerminal(queryClient, runId, sessionId, aggregateVersion);
          window.setTimeout(() => {
            void queryClient.invalidateQueries({ queryKey: ['runs'] });
            refreshSessionScope(queryClient, sessionId);
            void queryClient.invalidateQueries(
              runId ? { queryKey: ['activities', runId] } : { queryKey: ['activities'] });
            void queryClient.invalidateQueries(
              runId ? { queryKey: ['reasoning', runId] } : { queryKey: ['reasoning'] });
            void queryClient.invalidateQueries(
              runId ? { queryKey: ['output', runId] } : { queryKey: ['output'] });
          }, 800);
          continue;
        }

        // 3. Artifact readiness: the explicit barrier for artifact-backed
        // projections of this run only.
        if (frame.type === 'run.artifacts.ready') {
          void queryClient.invalidateQueries(
            runId ? { queryKey: ['evidence', runId] } : { queryKey: ['evidence'] });
          void queryClient.invalidateQueries(
            runId ? { queryKey: ['diff', runId] } : { queryKey: ['diff'] });
          void queryClient.invalidateQueries(
            runId ? { queryKey: ['activities', runId] } : { queryKey: ['activities'] });
          continue;
        }

        // 4. Ordinary run state changes: coalesced refresh of the run list,
        // the owning session detail and attention. Legacy envelopes without
        // a sessionId degrade to one coalesced whole-prefix refresh.
        if (frame.type.startsWith('collaboration.')) {
          if (sessionId) coordinator.markDirty({ kind: 'session-detail', sessionId });
          if (runId) coordinator.markDirty({ kind: 'runs' });
          continue;
        }

        if (frame.type.startsWith('run.')) {
          coordinator.markDirty({ kind: 'runs' });
          if (sessionId) coordinator.markDirty({ kind: 'session-detail', sessionId });
          else coordinator.markDirty({ kind: 'sessions-all' });
          coordinator.markDirty({ kind: 'attention' });
          continue;
        }

        // 5. Session lifecycle and message persistence: precise list merge
        // plus the owning session's detail.
        if (SESSION_EVENT_TYPES.has(frame.type) || frame.type.startsWith('message.')) {
          coordinator.markDirty({ kind: 'session-list' });
          if (sessionId) coordinator.markDirty({ kind: 'session-detail', sessionId });
          continue;
        }

        // Settings events invalidate exactly their own queries (settings
        // design §8.2); they must never fan out into a global refetch.
        if (frame.type === 'settings.updated') {
          void queryClient.invalidateQueries({ queryKey: settingsKeys.product });
          continue;
        }
        if (frame.type === 'policy.updated') {
          void queryClient.invalidateQueries({ queryKey: settingsKeys.policyLayers });
          void queryClient.invalidateQueries({ queryKey: ['project-session-preflight'] });
          continue;
        }
        if (frame.type.startsWith('approval.')) {
          // Approval events are projections only; the next query obtains the
          // authoritative version and allowedActions from the service.
          void queryClient.invalidateQueries({ queryKey: ['approvals'] });
          void queryClient.invalidateQueries({ queryKey: ['approval'] });
          coordinator.markDirty({ kind: 'attention' }, 'priority');
          continue;
        }
        if (frame.type === 'execution.policy.updated') {
          void queryClient.invalidateQueries({ queryKey: ['execution-policy'] });
          continue;
        }
        if (frame.type === 'automation.control.updated' || frame.type === 'execution.automation.updated') {
          void queryClient.invalidateQueries({ queryKey: ['automation-control'] });
          continue;
        }
        if (frame.type === 'memory.knowledge.confirmed') {
          void queryClient.invalidateQueries({ queryKey: settingsKeys.knowledge });
          continue;
        }

        // Unknown family (legacy service or a newer publisher): one coalesced
        // conservative refresh instead of a per-frame global invalidate.
        coordinator.markDirty({ kind: 'attention' });
      }
    });
    const unsubscribeStatus = window.codeAgentDesktop.onEventStatus((status) => {
      if (status.resync) {
        resyncRef();
        void queryClient.invalidateQueries();
        setState('CONNECTING');
        return;
      }
      if (status.status === 'CONNECTED') setState('CONNECTED');
      else if (status.status === 'RECONNECTING') setState('RECONNECTING');
      else if (status.status === 'DISCONNECTED') setState('DISCONNECTED');
    });
    return () => {
      unsubscribeEvents();
      unsubscribeStatus();
    };
  }, [queryClient, sinkRef, resyncRef]);

  return state;
}

/** Refreshes the session scope a terminal transition touched: the owning
 * session when the envelope identifies it, otherwise the whole prefix
 * (legacy envelopes) — never a silent skip of the transcript. */
function refreshSessionScope(
  queryClient: ReturnType<typeof useQueryClient>,
  sessionId: string | null
): void {
  void queryClient.refetchQueries({ queryKey: ['sessions'], exact: true });
  if (sessionId != null) {
    void queryClient.refetchQueries({ queryKey: ['sessions', sessionId], exact: true });
    void queryClient.refetchQueries({
      predicate: (query) => isSessionHistoryQuery(query.queryKey, sessionId),
      type: 'active'
    });
  } else {
    void queryClient.refetchQueries({ queryKey: ['sessions'] });
  }
}

/**
 * Refreshes both history channels after a message is accepted. The paginated
 * channel does not use ['sessions', sessionId], so refreshing that legacy key
 * alone leaves the conversation visually unchanged until a later event.
 */
export function invalidateSessionHistory(
  queryClient: ReturnType<typeof useQueryClient>,
  sessionId: string
): void {
  void queryClient.invalidateQueries({ queryKey: ['sessions', sessionId], exact: true });
  // The paginated rail is keyed by sessionList rather than ['sessions']; a
  // successful ordinary send must move its preview/recency immediately too.
  void queryClient.invalidateQueries({ queryKey: ['sessionList'] });
  void queryClient.invalidateQueries({
    predicate: (query) => isSessionHistoryQuery(query.queryKey, sessionId)
  });
}

function isSessionHistoryQuery(queryKey: readonly unknown[], sessionId: string): boolean {
  if (queryKey[0] === 'sessionMetadata') return queryKey.at(-1) === sessionId;
  return queryKey[0] === 'sessionMessages'
    && queryKey.length >= 4
    && queryKey.at(-2) === sessionId;
}

/**
 * Read-after-terminal with a single correct Run key source (design §8.4):
 * version evidence is checked across every live `runsQueryKey(...)` cache
 * entry, not against the bare `['runs']` key that never held data.
 */
function readAfterTerminal(
  queryClient: ReturnType<typeof useQueryClient>,
  runId: string | null,
  sessionId: string | null,
  targetVersion: number | null
): void {
  void (async () => {
    try {
      // No version evidence (older service or flat fixture): one best-effort
      // refetch plus the session scope, never a loop.
      if (runId == null || targetVersion == null) {
        await queryClient.refetchQueries({ queryKey: ['runs'] });
        refreshSessionScope(queryClient, sessionId);
        return;
      }
      const observed = () => {
        for (const [, data] of queryClient.getQueriesData<RunLike[]>({ queryKey: ['runs'] })) {
          const run = data?.find((item) => item.runId === runId);
          if (run && run.stateVersion >= targetVersion
            && (run.delivery == null || run.delivery.artifactsReady === true)) {
            return true; // authoritative state + artifacts readable
          }
        }
        return false;
      };
      if (observed()) return;
      await queryClient.refetchQueries({ queryKey: ['runs'] });
      // One bounded retry: the terminal intent commits state before this
      // frame is relayed, but a slow store write can still lose the race once.
      if (!observed()) await queryClient.refetchQueries({ queryKey: ['runs'] });
      // The owning session converges precisely; other cached sessions keep
      // their content (terminal events must not storm every history page).
      refreshSessionScope(queryClient, sessionId);
      await queryClient.refetchQueries(
        runId != null ? { queryKey: ['evidence', runId] } : { queryKey: ['evidence'] });
      await queryClient.refetchQueries(
        runId != null ? { queryKey: ['diff', runId] } : { queryKey: ['diff'] });
      await queryClient.refetchQueries(
        runId != null ? { queryKey: ['activities', runId] } : { queryKey: ['activities'] });
      await queryClient.refetchQueries(
        runId != null ? { queryKey: ['reasoning', runId] } : { queryKey: ['reasoning'] });
      await queryClient.refetchQueries(
        runId != null ? { queryKey: ['output', runId] } : { queryKey: ['output'] });
    } catch {
      // Refresh is best-effort; a broken refetch must not
      // wedge the UI in a refresh loop.
    }
  })();
}

// Live output/reasoning folds live in the DOM-free projection module so
// unit tests can exercise them under the non-DOM tests tsconfig; the
// symbols are re-exported here to keep existing import sites stable.
export {
  MAX_VISIBLE_OUTPUT_CHARS,
  MAX_VISIBLE_REASONING_CHARS,
  reduceVisibleOutput,
  reduceVisibleReasoning
} from './activity/visibleTextProjection';
export type {
  RoundTextState,
  VisibleOutputState,
  VisibleReasoningState
} from './activity/visibleTextProjection';

/** One round's assembled text inside a snapshot (design 2026-09-19 §5.4/§5.5-B). */
export interface RunTextSegment {
  roundId: string;
  roundOrdinal?: number | null;
  text: string;
  truncated: boolean;
  complete: boolean;
  lastSequence: number;
}

/** Authoritative reasoning fold from the durable run journal; mirrors
 * RunReasoningResponse (design 2026-09-18). */
export interface RunReasoningSnapshot {
  runId: string;
  runStateVersion: number;
  snapshotCursor: number;
  retentionFloor?: number;
  text?: string | null;
  receivedBytes: number;
  totalBytes: number;
  droppedChunks: number;
  lastSequence: number;
  terminal: boolean;
  complete: boolean;
  /** TERMINAL_EXACT / LIVE_LOWER_BOUND / INCOMPLETE machine reason. */
  reasonCode?: string | null;
  truncated: boolean;
  /** Per-round display reasoning. Empty on legacy streams. */
  segments?: RunTextSegment[] | null;
}

/**
 * Reasoning snapshot fold. Same gating as activities: historical reasoning
 * loads only when the user expands its entry; while a Run is active a
 * bounded poll covers replay after reconnect, and run.terminal triggers one
 * authoritative refetch through readAfterTerminal.
 */
export function useRunReasoning(runId: string | null, options?: { enabled?: boolean; live?: boolean }) {
  return useQuery({
    queryKey: ['reasoning', runId],
    enabled: (options?.enabled ?? true) && runId !== null,
    retry: 1,
    refetchInterval: () => (options?.live ? 2_000 : false),
    refetchOnReconnect: true,
    staleTime: Infinity,
    queryFn: async () => unwrap(await window.codeAgentDesktop.getRunReasoning(runId as string)) as RunReasoningSnapshot
  });
}

/** Authoritative visible-output fold; mirrors RunOutputResponse
 * (design 2026-09-19 §5.5-B). */
export interface RunOutputSnapshot {
  runId: string;
  runStateVersion: number;
  snapshotCursor: number;
  retentionFloor?: number;
  text?: string | null;
  receivedBytes: number;
  totalBytes: number;
  droppedChunks: number;
  lastSequence: number;
  terminal: boolean;
  complete: boolean;
  reasonCode?: string | null;
  truncated: boolean;
  /** Per-round visible output segments. Empty on legacy streams. */
  segments?: RunTextSegment[] | null;
}

/**
 * Output snapshot fold. Same gating as the reasoning snapshot: expanded
 * history loads on demand, live runs poll, and run.terminal triggers one
 * authoritative refetch through readAfterTerminal.
 */
export function useRunOutput(runId: string | null, options?: { enabled?: boolean; live?: boolean }) {
  return useQuery({
    queryKey: ['output', runId],
    enabled: (options?.enabled ?? true) && runId !== null,
    retry: 1,
    refetchInterval: () => (options?.live ? 2_000 : false),
    refetchOnReconnect: true,
    staleTime: Infinity,
    queryFn: async () => unwrap(await window.codeAgentDesktop.getRunOutput(runId as string)) as RunOutputSnapshot
  });
}
