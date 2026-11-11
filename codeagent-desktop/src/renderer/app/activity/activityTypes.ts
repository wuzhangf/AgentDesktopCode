/**
 * Typed renderer projection of run tool activities (design 2026-09-02 §11.2).
 * The service journal stays authoritative; this projection can always be
 * rebuilt from a getRunActivities snapshot plus subsequent durable frames.
 */

import type { FailureDescriptor, RunSchedulingProjection, EffectState } from '../../../../packages/protocol/src/failureContract';

/** One tool activity item as returned by the service activity snapshot. */
export interface RunActivity {
  activityId: string;
  runId: string;
  kind: string;
  status: string;
  /** Child attempt/version facts used to reject stale terminal updates. */
  attempt?: number | null;
  outcomeVersion?: number | null;
  /**
   * Model-interaction round key (design 2026-09-19 §5.1): the Product
   * logical model-call id shared by every product of one call. Absent on
   * legacy or runtime-owned items; grouping never infers it.
   */
  roundId?: string | null;
  /** Optional 1-based round order inside the run. */
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
  effectState?: EffectState | null;
  truncated?: boolean | null;
  startCursor?: number;
  endCursor?: number;

  /** Optional structured purpose facts. Older services omit these fields. */
  groupId?: string | null;
  groupPurpose?: string | null;
  groupStartNote?: string | null;
  groupSummary?: string | null;
  groupStatus?: string | null;
  groupStartedAt?: string | null;
  groupFinishedAt?: string | null;

  /**
   * Execution-evidence references (design 2026-09-26 WU-1): the journaled
   * execution id, command id, record state and record-relative artifact
   * paths. Identifiers only — artifact bytes are fetched separately through
   * the session execution artifact endpoint. Absent on legacy events.
   */
  executionId?: string | null;
  commandId?: string | null;
  evidenceState?: string | null;
  evidenceArtifacts?: string[] | null;

  /** Optional trusted file-read facts. Never derive these from text. */
  fileRef?: string | null;
  fileName?: string | null;
  relativeDirectory?: string | null;
  startLine?: number | null;
  endLine?: number | null;
  bytesRead?: number | null;
  fileSizeBytes?: number | null;
  workingDirectory?: string | null;
}

/** Live durable frame envelope (BusinessEventEnvelope JSON over SSE). */
export interface ActivityEventEnvelope {
  eventId?: string;
  cursor?: number;
  type?: string;
  runId?: string;
  status?: string | null;
  occurredAt?: string;
  failure?: unknown;
  scheduling?: unknown;
  reasonCode?: unknown;
  payload?: {
    activityId?: unknown;
    attempt?: unknown;
    outcomeVersion?: unknown;
    roundId?: unknown;
    roundOrdinal?: unknown;
    activityKind?: unknown;
    toolName?: unknown;
    capabilityId?: unknown;
    detail?: unknown;
    commandPreview?: unknown;
    redactionState?: unknown;
    requestedTargetRefs?: unknown;
    succeededTargetRefs?: unknown;
    failedTargetRefs?: unknown;
    resultSummary?: unknown;
    durationMillis?: unknown;
    truncated?: unknown;
    failure?: unknown;
    scheduling?: unknown;
    reasonCode?: unknown;
    effectState?: unknown;
    groupId?: unknown;
    groupPurpose?: unknown;
    groupStartNote?: unknown;
    groupSummary?: unknown;
    groupStatus?: unknown;
    groupStartedAt?: unknown;
    groupFinishedAt?: unknown;
    fileRef?: unknown;
    fileName?: unknown;
    relativeDirectory?: unknown;
    startLine?: unknown;
    endLine?: unknown;
    bytesRead?: unknown;
    fileSizeBytes?: unknown;
    workingDirectory?: unknown;
    executionId?: unknown;
    commandId?: unknown;
    evidenceState?: unknown;
    evidenceArtifacts?: unknown;
  } | null;
}

/** Per-run projection state: insertion order + items by activityId. */
export interface RunActivityProjection {
  runId: string;
  /** Journal cursor up to which the last service snapshot is authoritative. */
  snapshotCursor: number;
  byId: Map<string, RunActivity>;
  order: string[];
}
