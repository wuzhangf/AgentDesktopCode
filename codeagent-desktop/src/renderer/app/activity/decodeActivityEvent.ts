/**
 * Typed decoder for durable tool activity frames (design §11.2). Malformed
 * frames are ignored (fail-safe) — they never break the conversation and
 * never fabricate activities.
 */
import { decodeFailure, decodeScheduling, type EffectState } from '../../../../packages/protocol/src/failureContract';
import { dedupeFailureMessage } from '../failureDecoder';
import type { ActivityEventEnvelope, RunActivity } from './activityTypes';

/** Business durable event types that carry the public activity projection. */
export const ACTIVITY_EVENT_TYPES: ReadonlySet<string> = new Set([
  'tool.started',
  'tool.completed',
  'tool.failed',
  'sandbox.command.started',
  'sandbox.command.finished',
  'run.subagent.task.started',
  'run.subagent.task.completed',
  'run.subagent.task.failed',
  'run.subagent.task.cancel.requested',
  'run.subagent.task.cancelled',
  'run.subagent.batch.accepted',
  'run.subagent.batch.rejected'
]);

const COMPLETION_TYPES: ReadonlySet<string> = new Set([
  'tool.completed',
  'tool.failed',
  'sandbox.command.finished',
  'run.subagent.task.completed',
  'run.subagent.task.failed',
  'run.subagent.task.cancelled',
  'run.subagent.batch.accepted',
  'run.subagent.batch.rejected'
]);

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function asStringList(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const out: string[] = [];
  for (const item of value) {
    const text = asString(item);
    if (text) out.push(text);
  }
  return out;
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Decodes one durable frame into (runId, partial activity) or null when the
 * frame is not an activity event or carries no usable activityId.
 */
export function decodeActivityEvent(
  frameType: string,
  framePayload: unknown
): { runId: string; activity: RunActivity; completion: boolean } | null {
  if (!ACTIVITY_EVENT_TYPES.has(frameType)) return null;
  if (typeof framePayload !== 'object' || framePayload === null) return null;
  const envelope = framePayload as ActivityEventEnvelope;
  const nested = typeof envelope.payload === 'object' && envelope.payload !== null
    ? envelope.payload : null;
  // Real SSE frames nest the event payload; older renderer fixtures and
  // compatibility bridges provide the activity fields at the top level.
  const payload = nested ?? framePayload as unknown as Record<string, unknown>;
  const runId = asString(envelope.runId)
    ?? asString((payload as Record<string, unknown>).runId);
  if (!runId) return null;
  const activityId = asString((payload as Record<string, unknown>).activityId);
  if (!activityId) return null; // pre-activity legacy event: not displayable
  const completion = COMPLETION_TYPES.has(frameType);
  const status = asString(envelope.status)
    ?? asString((payload as Record<string, unknown>).status)
    ?? (completion ? 'UNKNOWN' : 'RUNNING');
  const payloadRecord = payload as Record<string, unknown>;
  const requested = asStringList(payloadRecord.requestedTargetRefs);
  const succeeded = asStringList(payloadRecord.succeededTargetRefs);
  const failed = asStringList(payloadRecord.failedTargetRefs);
  const decodedFailure = decodeFailure(payloadRecord.failure ?? envelope.failure);
  const failure = decodedFailure
    ? { ...decodedFailure, safeMessage: dedupeFailureMessage(decodedFailure.code, decodedFailure.safeMessage) }
    : decodedFailure;
  const scheduling = decodeScheduling(payloadRecord.scheduling ?? envelope.scheduling);
  const reasonCode = asString(payloadRecord.reasonCode) ?? asString(envelope.reasonCode);
  const effectState: EffectState | null = failure?.effectState
    ?? (payloadRecord.effectState === 'NOT_APPLIED' || payloadRecord.effectState === 'APPLIED' || payloadRecord.effectState === 'UNKNOWN'
      ? payloadRecord.effectState : null);
  const optionalNumber = (value: unknown): number | null =>
    typeof value === 'number' && Number.isFinite(value) ? value : null;
  const targets = requested ?? succeeded ?? failed
    ? [
        ...(requested ?? []).map((ref) => ({
          ref,
          status: succeeded?.includes(ref) ? 'SUCCEEDED'
            : failed?.includes(ref) ? 'FAILED' : 'REQUESTED'
        })),
        ...(succeeded ?? []).filter((ref) => !requested?.includes(ref))
          .map((ref) => ({ ref, status: 'SUCCEEDED' })),
        ...(failed ?? []).filter((ref) => !requested?.includes(ref))
          .map((ref) => ({ ref, status: 'FAILED' }))
      ]
    : undefined;
  const activity: RunActivity = {
    activityId,
    runId,
    kind: asString(payloadRecord.activityKind) ?? 'OTHER',
    status,
    attempt: optionalNumber(payloadRecord.attempt),
    outcomeVersion: optionalNumber(payloadRecord.outcomeVersion),
    // Missing round fields never drop the event; the item simply stays
    // ungrouped downstream (design 2026-09-19 §3.4).
    roundId: asString(payloadRecord.roundId),
    roundOrdinal: optionalNumber(payloadRecord.roundOrdinal),
    toolName: asString(payloadRecord.toolName),
    capabilityId: asString(payloadRecord.capabilityId),
    detail: asString(payloadRecord.detail)
      // §5.5-A TEXT items carry their bounded text payload directly.
      ?? asString(payloadRecord.text),
    commandPreview: asString(payloadRecord.commandPreview),
    redactionState: asString(payloadRecord.redactionState) ?? 'NONE',
    resultSummary: asString(payloadRecord.resultSummary),
    durationMillis: asNumber(payloadRecord.durationMillis),
    truncated: typeof payloadRecord.truncated === 'boolean' ? payloadRecord.truncated : null,
    reasonCode,
    failure,
    scheduling,
    effectState,
    targets,
    startedAt: completion ? null : asString(envelope.occurredAt),
    finishedAt: completion ? asString(envelope.occurredAt) : null,
    startCursor: completion ? undefined : (typeof envelope.cursor === 'number' ? envelope.cursor : undefined),
    endCursor: completion ? (typeof envelope.cursor === 'number' ? envelope.cursor : undefined) : undefined,
    groupId: asString(payloadRecord.groupId),
    groupPurpose: asString(payloadRecord.groupPurpose),
    groupStartNote: asString(payloadRecord.groupStartNote),
    groupSummary: asString(payloadRecord.groupSummary),
    groupStatus: asString(payloadRecord.groupStatus),
    groupStartedAt: asString(payloadRecord.groupStartedAt),
    groupFinishedAt: asString(payloadRecord.groupFinishedAt),
    fileRef: asString(payloadRecord.fileRef),
    fileName: asString(payloadRecord.fileName),
    relativeDirectory: asString(payloadRecord.relativeDirectory),
    startLine: optionalNumber(payloadRecord.startLine),
    endLine: optionalNumber(payloadRecord.endLine),
    bytesRead: optionalNumber(payloadRecord.bytesRead),
    fileSizeBytes: optionalNumber(payloadRecord.fileSizeBytes),
    workingDirectory: asString(payloadRecord.workingDirectory),
    // Evidence references are identifiers/record-relative paths only
    // (design 2026-09-26 WU-1); artifact bytes are fetched separately.
    executionId: asString(payloadRecord.executionId),
    commandId: asString(payloadRecord.commandId),
    evidenceState: asString(payloadRecord.evidenceState),
    evidenceArtifacts: asStringList(payloadRecord.evidenceArtifacts),
  };
  return { runId, activity, completion };
}
