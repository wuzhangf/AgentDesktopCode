// Read-side state normalization (§4.1). Raw lifecycle/outcome/native_status are
// never overwritten; classification adds activityState + qualityReasons.
import {
  KNOWN_TERMINAL_OUTCOMES, LIFECYCLE, ACTIVITY_STATE, SUCCESS_RATE_OUTCOMES,
} from '../../shared/contracts/enums.mjs';

const KNOWN_NATIVE_TERMINAL_HINTS = new Set([
  'SUCCESS', 'COMPLETED', 'FAILED', 'ERROR', 'CANCELLED', 'TIMED_OUT',
]);

/**
 * Classify one entity row ({lifecycle, outcome, native_status, ended_at}).
 * Returns { activityState, isTrustedTerminal, knownOutcome, qualityReasons[] }.
 */
export function classifyEntity(e) {
  const reasons = [];
  const lifecycle = e.lifecycle;
  const outcome = e.outcome ?? null;
  const native = e.native_status ?? null;
  const knownOutcome = outcome != null && KNOWN_TERMINAL_OUTCOMES.includes(outcome);
  const unrecognizedOutcome = outcome != null && !KNOWN_TERMINAL_OUTCOMES.includes(outcome);

  let conflict = false;
  if (lifecycle === LIFECYCLE.TERMINAL && outcome == null) {
    reasons.push('TERMINAL_WITHOUT_OUTCOME');
    conflict = true;
  }
  if ((lifecycle === LIFECYCLE.REGISTERED || lifecycle === LIFECYCLE.STARTED) && knownOutcome) {
    reasons.push('OPEN_LIFECYCLE_WITH_TERMINAL_OUTCOME');
    conflict = true;
  }
  if (lifecycle === LIFECYCLE.STARTED && native != null && ['FAILED', 'ERROR', 'CANCELLED'].includes(native)) {
    reasons.push('NATIVE_TERMINAL_STATUS_WITH_OPEN_LIFECYCLE');
    conflict = true;
  }
  if (unrecognizedOutcome) reasons.push('UNRECOGNIZED_ENUM');
  if (lifecycle === LIFECYCLE.OUTCOME_UNKNOWN) reasons.push('OUTCOME_UNKNOWN');

  const isTrustedTerminal =
    lifecycle === LIFECYCLE.TERMINAL && knownOutcome && !conflict && e.ended_at != null;

  let activityState;
  if (conflict) activityState = ACTIVITY_STATE.STATE_CONFLICT;
  else if (lifecycle === LIFECYCLE.TERMINAL) activityState = ACTIVITY_STATE.COMPLETED;
  else if (native === 'PAUSED' || e.paused) activityState = ACTIVITY_STATE.PAUSED;
  else if (lifecycle === LIFECYCLE.REGISTERED || lifecycle === LIFECYCLE.STARTED) {
    activityState = ACTIVITY_STATE.UNCLOSED;
  } else activityState = ACTIVITY_STATE.ACTIVITY_UNKNOWN;

  return { activityState, isTrustedTerminal, knownOutcome, conflict, qualityReasons: reasons };
}

/**
 * Outcome counters for a created cohort (registered in window), per SQL-A.
 * rows: entity rows; returns counts incl. unclosed / outcome_unknown / conflict.
 */
export function countCreatedCohort(rows) {
  const c = {
    registered: rows.length, succeeded: 0, failed: 0, timedOut: 0,
    cancelled: 0, rejected: 0, skipped: 0, outcomeUnknown: 0,
    unclosed: 0, conflict: 0, knownTerminal: 0,
  };
  for (const r of rows) {
    const cls = classifyEntity(r);
    if (cls.conflict) c.conflict += 1;
    if (r.lifecycle === LIFECYCLE.TERMINAL && cls.knownOutcome) {
      c.knownTerminal += 1;
      if (r.outcome === 'SUCCEEDED') c.succeeded += 1;
      else if (r.outcome === 'FAILED') c.failed += 1;
      else if (r.outcome === 'TIMED_OUT') c.timedOut += 1;
      else if (r.outcome === 'CANCELLED') c.cancelled += 1;
      else if (r.outcome === 'REJECTED') c.rejected += 1;
      else if (r.outcome === 'SKIPPED') c.skipped += 1;
    } else if (r.lifecycle === LIFECYCLE.OUTCOME_UNKNOWN) {
      c.outcomeUnknown += 1;
    } else if (r.lifecycle === LIFECYCLE.REGISTERED || r.lifecycle === LIFECYCLE.STARTED) {
      c.unclosed += 1;
    } else {
      c.outcomeUnknown += 1;
    }
  }
  return c;
}

/**
 * Completed cohort rates (§4.2): trusted TERMINAL rows ending in window.
 * Returns {succeeded, failed, timedOut, excluded, denominator, successRate...}
 */
export function completedOutcomeStats(rows) {
  const s = { succeeded: 0, failed: 0, timedOut: 0, cancelled: 0, rejected: 0, skipped: 0, excluded: 0, missingEndedAt: 0 };
  for (const r of rows) {
    const cls = classifyEntity(r);
    if (cls.conflict) { s.excluded += 1; continue; }
    if (r.lifecycle !== LIFECYCLE.TERMINAL || !cls.knownOutcome) { s.excluded += 1; continue; }
    if (r.outcome === 'SUCCEEDED') s.succeeded += 1;
    else if (r.outcome === 'FAILED') s.failed += 1;
    else if (r.outcome === 'TIMED_OUT') s.timedOut += 1;
    else if (r.outcome === 'CANCELLED') s.cancelled += 1;
    else if (r.outcome === 'REJECTED') s.rejected += 1;
    else if (r.outcome === 'SKIPPED') s.skipped += 1;
  }
  const denominator = s.succeeded + s.failed + s.timedOut;
  const allKnown = denominator + s.cancelled + s.rejected + s.skipped;
  return {
    ...s,
    denominator,
    allKnownTerminal: allKnown,
    successRate: denominator ? s.succeeded / denominator : null,
    failureRate: denominator ? s.failed / denominator : null,
    timeoutRate: denominator ? s.timedOut / denominator : null,
    cancelShare: allKnown ? s.cancelled / allKnown : null,
    rejectShare: allKnown ? s.rejected / allKnown : null,
  };
}

/** Whether a native_status contradicts a known outcome (quality-only signal). */
export function nativeContradicts(outcome, native) {
  if (outcome == null || native == null) return false;
  if (KNOWN_TERMINAL_OUTCOMES.includes(outcome)) {
    if (outcome === 'SUCCEEDED' && ['FAILED', 'ERROR', 'TIMED_OUT'].includes(native)) return true;
    if (outcome === 'FAILED' && ['SUCCESS', 'COMPLETED'].includes(native)) return true;
  }
  return false;
}
