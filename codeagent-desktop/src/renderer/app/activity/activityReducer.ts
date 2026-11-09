/**
 * Live activity projection reducer (design 2026-09-02 §11.2). Merges a
 * service snapshot (authoritative up to snapshotCursor) with subsequent
 * durable frames; replays and duplicates are idempotent by activityId.
 */
import type { RunActivity, RunActivityProjection } from './activityTypes';
import { decodeActivityEvent } from './decodeActivityEvent';

export type LiveActivityProjection = Map<string, RunActivityProjection>;

function upsert(projection: RunActivityProjection, activity: RunActivity): void {
  const current = projection.byId.get(activity.activityId);
  if (!current) {
    projection.byId.set(activity.activityId, activity);
    projection.order.push(activity.activityId);
    return;
  }
  const terminal = (status: string): boolean =>
    !['RUNNING', 'QUEUED', 'STARTING'].includes(status);
  // A task attempt has one authoritative terminal outcome. This protects a
  // timeout/cancel projection from a late worker completion even when the
  // late frame has a newer journal cursor or timestamp. Repeated copies of
  // the same terminal outcome are still merged so a later durable frame can
  // fill in the failure/summary that was missing from an earlier frame.
  if (terminal(current.status) && terminal(activity.status)) {
    const currentVersion = current.outcomeVersion ?? null;
    const incomingVersion = activity.outcomeVersion ?? null;
    if (currentVersion !== null && incomingVersion !== null
        && incomingVersion < currentVersion) {
      return;
    }
    if (current.status !== activity.status) {
      return;
    }
    projection.byId.set(activity.activityId, {
      ...current,
      ...activity,
      attempt: activity.attempt ?? current.attempt,
      outcomeVersion: activity.outcomeVersion ?? current.outcomeVersion,
      roundId: activity.roundId ?? current.roundId,
      roundOrdinal: activity.roundOrdinal ?? current.roundOrdinal,
      detail: activity.detail ?? current.detail,
      toolName: activity.toolName ?? current.toolName,
      capabilityId: activity.capabilityId ?? current.capabilityId,
      commandPreview: activity.commandPreview ?? current.commandPreview,
      startedAt: activity.startedAt ?? current.startedAt,
      finishedAt: activity.finishedAt ?? current.finishedAt,
      durationMillis: activity.durationMillis ?? current.durationMillis,
      resultSummary: activity.resultSummary ?? current.resultSummary,
      reasonCode: activity.reasonCode ?? current.reasonCode,
      failure: activity.failure ?? current.failure,
      targets: activity.targets ?? current.targets,
      groupId: activity.groupId ?? current.groupId,
      groupPurpose: activity.groupPurpose ?? current.groupPurpose,
      groupStartNote: activity.groupStartNote ?? current.groupStartNote,
      groupSummary: activity.groupSummary ?? current.groupSummary,
      groupStatus: activity.groupStatus ?? current.groupStatus,
      groupStartedAt: activity.groupStartedAt ?? current.groupStartedAt,
      groupFinishedAt: activity.groupFinishedAt ?? current.groupFinishedAt,
      fileRef: activity.fileRef ?? current.fileRef,
      fileName: activity.fileName ?? current.fileName,
      relativeDirectory: activity.relativeDirectory ?? current.relativeDirectory,
      startLine: activity.startLine ?? current.startLine,
      endLine: activity.endLine ?? current.endLine,
      bytesRead: activity.bytesRead ?? current.bytesRead,
      fileSizeBytes: activity.fileSizeBytes ?? current.fileSizeBytes,
      workingDirectory: activity.workingDirectory ?? current.workingDirectory,
      executionId: activity.executionId ?? current.executionId,
      commandId: activity.commandId ?? current.commandId,
      evidenceState: activity.evidenceState ?? current.evidenceState,
      evidenceArtifacts: activity.evidenceArtifacts ?? current.evidenceArtifacts
    });
    return;
  }
  // Completion facts win over a stale RUNNING entry regardless of arrival
  // order (snapshot and live frames may overlap around reconnects).
  if (current.status === 'RUNNING' && activity.status !== 'RUNNING') {
    projection.byId.set(activity.activityId, {
      ...activity,
      // Completion events carry outcome facts only (the completion
      // projection never repeats start-side action facts); keep the richer
      // side like the service snapshot's first-non-null fold does.
      detail: activity.detail ?? current.detail,
      toolName: activity.toolName ?? current.toolName,
      capabilityId: activity.capabilityId ?? current.capabilityId,
      commandPreview: activity.commandPreview ?? current.commandPreview,
      targets: activity.targets ?? current.targets,
      startedAt: activity.startedAt ?? current.startedAt,
      startCursor: activity.startCursor ?? current.startCursor,
      roundId: activity.roundId ?? current.roundId,
      roundOrdinal: activity.roundOrdinal ?? current.roundOrdinal,
      groupId: activity.groupId ?? current.groupId,
      groupPurpose: activity.groupPurpose ?? current.groupPurpose,
      groupStartNote: activity.groupStartNote ?? current.groupStartNote,
      groupSummary: activity.groupSummary ?? current.groupSummary,
      groupStatus: activity.groupStatus ?? current.groupStatus,
      groupStartedAt: activity.groupStartedAt ?? current.groupStartedAt,
      groupFinishedAt: activity.groupFinishedAt ?? current.groupFinishedAt,
      fileRef: activity.fileRef ?? current.fileRef,
      fileName: activity.fileName ?? current.fileName,
      relativeDirectory: activity.relativeDirectory ?? current.relativeDirectory,
      startLine: activity.startLine ?? current.startLine,
      endLine: activity.endLine ?? current.endLine,
      bytesRead: activity.bytesRead ?? current.bytesRead,
      fileSizeBytes: activity.fileSizeBytes ?? current.fileSizeBytes,
      workingDirectory: activity.workingDirectory ?? current.workingDirectory,
      executionId: activity.executionId ?? current.executionId,
      commandId: activity.commandId ?? current.commandId,
      evidenceState: activity.evidenceState ?? current.evidenceState,
      evidenceArtifacts: activity.evidenceArtifacts ?? current.evidenceArtifacts
    });
    return;
  }
  if (current.status !== 'RUNNING' && activity.status === 'RUNNING') {
    return; // already completed; a replayed start never regresses it
  }
  projection.byId.set(activity.activityId, {
    ...current,
    ...activity,
    // Keep the richer side of optional facts.
    detail: activity.detail ?? current.detail,
    toolName: activity.toolName ?? current.toolName,
    capabilityId: activity.capabilityId ?? current.capabilityId,
    commandPreview: activity.commandPreview ?? current.commandPreview,
    startedAt: activity.startedAt ?? current.startedAt,
    finishedAt: activity.finishedAt ?? current.finishedAt,
    startCursor: activity.startCursor ?? current.startCursor,
    endCursor: activity.endCursor ?? current.endCursor,
    roundId: activity.roundId ?? current.roundId,
    roundOrdinal: activity.roundOrdinal ?? current.roundOrdinal,
    targets: activity.targets ?? current.targets,
    groupId: activity.groupId ?? current.groupId,
    groupPurpose: activity.groupPurpose ?? current.groupPurpose,
    groupStartNote: activity.groupStartNote ?? current.groupStartNote,
    groupSummary: activity.groupSummary ?? current.groupSummary,
    groupStatus: activity.groupStatus ?? current.groupStatus,
    groupStartedAt: activity.groupStartedAt ?? current.groupStartedAt,
    groupFinishedAt: activity.groupFinishedAt ?? current.groupFinishedAt,
    fileRef: activity.fileRef ?? current.fileRef,
    fileName: activity.fileName ?? current.fileName,
    relativeDirectory: activity.relativeDirectory ?? current.relativeDirectory,
    startLine: activity.startLine ?? current.startLine,
    endLine: activity.endLine ?? current.endLine,
    bytesRead: activity.bytesRead ?? current.bytesRead,
    fileSizeBytes: activity.fileSizeBytes ?? current.fileSizeBytes,
    workingDirectory: activity.workingDirectory ?? current.workingDirectory,
    executionId: activity.executionId ?? current.executionId,
    commandId: activity.commandId ?? current.commandId,
    evidenceState: activity.evidenceState ?? current.evidenceState,
    evidenceArtifacts: activity.evidenceArtifacts ?? current.evidenceArtifacts
  });
}

/**
 * Snapshot items fold the full event stream server-side; a live completion
 * may have missed its start frame (join/resync mid-activity). Keep the
 * snapshot base and let only the live item's defined fields win — nulls are
 * absence, never assertions.
 */
function mergeLiveCompletion(snapshotItem: RunActivity, live: RunActivity): RunActivity {
  const liveDefined = Object.fromEntries(
    Object.entries(live).filter(([, value]) => value !== null && value !== undefined));
  const merged: RunActivity = { ...snapshotItem, ...liveDefined };
  if (snapshotItem.targets?.length && live.targets?.length) {
    const byRef = new Map(snapshotItem.targets.map((target) => [target.ref, target]));
    for (const target of live.targets) byRef.set(target.ref, target);
    merged.targets = [...byRef.values()];
  }
  return merged;
}

/** Applies one durable frame; returns the same map reference when untouched. */
export function reduceRunActivities(
  previous: LiveActivityProjection,
  frame: { cursor: number; type: string; payload: unknown }
): LiveActivityProjection {
  const decoded = decodeActivityEvent(frame.type, frame.payload);
  if (!decoded) return previous;
  const { runId, activity } = decoded;
  const existing = previous.get(runId);
  const projection: RunActivityProjection = existing ?? {
    runId,
    snapshotCursor: 0,
    byId: new Map<string, RunActivity>(),
    order: []
  };
  // Frames at or before the snapshot cursor are already folded in.
  if (projection.snapshotCursor > 0 && frame.cursor <= projection.snapshotCursor
      && projection.byId.has(activity.activityId)) {
    return previous;
  }
  upsert(projection, activity);
  const next = new Map(previous);
  next.set(runId, projection);
  return next;
}

/**
 * Seeds/merges a service snapshot (design §11.2 step 2-3): snapshot items are
 * authoritative for their cursor range, live completions observed beyond it
 * are preserved.
 */
export function mergeActivitySnapshot(
  previous: LiveActivityProjection,
  snapshot: { runId: string; snapshotCursor: number; items: RunActivity[] }
): LiveActivityProjection {
  const existing = previous.get(snapshot.runId);
  const projection: RunActivityProjection = existing ?? {
    runId: snapshot.runId,
    snapshotCursor: 0,
    byId: new Map<string, RunActivity>(),
    order: []
  };
  if (snapshot.snapshotCursor < projection.snapshotCursor) return previous;
  projection.snapshotCursor = snapshot.snapshotCursor;
  const liveCompletions = new Map<string, RunActivity>();
  for (const [id, item] of projection.byId) {
    if (item.status !== 'RUNNING') liveCompletions.set(id, item);
  }
  for (const item of snapshot.items) {
    const live = liveCompletions.get(item.activityId);
    projection.byId.set(
      item.activityId,
      live ? mergeLiveCompletion(item, live) : item);
  }
  projection.order = [...projection.byId.keys()];
  const next = new Map(previous);
  next.set(snapshot.runId, projection);
  return next;
}

/** Ordered activities of one run from the merged projection. */
export function activitiesOf(
  projections: LiveActivityProjection,
  runId: string | null | undefined
): RunActivity[] {
  if (!runId) return [];
  const projection = projections.get(runId);
  if (!projection) return [];
  return projection.order
    .map((id) => projection.byId.get(id))
    .filter((item): item is RunActivity => item !== undefined);
}
