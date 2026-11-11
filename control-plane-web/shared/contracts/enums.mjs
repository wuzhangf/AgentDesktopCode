// Shared enum constants for the observation control plane (schema v1).
// Plain .mjs so both the Node BFF and the Vite frontend import the same values.

export const LIFECYCLE = Object.freeze({
  REGISTERED: 'REGISTERED',
  STARTED: 'STARTED',
  TERMINAL: 'TERMINAL',
  OUTCOME_UNKNOWN: 'OUTCOME_UNKNOWN',
});

export const OUTCOME = Object.freeze({
  SUCCEEDED: 'SUCCEEDED',
  FAILED: 'FAILED',
  TIMED_OUT: 'TIMED_OUT',
  CANCELLED: 'CANCELLED',
  REJECTED: 'REJECTED',
  SKIPPED: 'SKIPPED',
});

export const KNOWN_TERMINAL_OUTCOMES = Object.freeze([
  'SUCCEEDED', 'FAILED', 'TIMED_OUT', 'CANCELLED', 'REJECTED', 'SKIPPED',
]);

// Outcomes counted in execution_success_rate denominator (§4.2).
export const SUCCESS_RATE_OUTCOMES = Object.freeze(['SUCCEEDED', 'FAILED', 'TIMED_OUT']);

export const ENTITY_KIND = Object.freeze({
  TASK: 'TASK',
  RUN: 'RUN',
  RUN_SEGMENT: 'RUN_SEGMENT',
  PLAN_REVISION: 'PLAN_REVISION',
  STEP: 'STEP',
  STEP_ATTEMPT: 'STEP_ATTEMPT',
  MODEL_CALL: 'MODEL_CALL',
  MODEL_ATTEMPT: 'MODEL_ATTEMPT',
  TOOL_CALL: 'TOOL_CALL',
  COMMAND: 'COMMAND',
  DELEGATION: 'DELEGATION',
  CONTEXT_SNAPSHOT: 'CONTEXT_SNAPSHOT',
  CONTEXT_TRANSFORM: 'CONTEXT_TRANSFORM',
  REASONING_OUTPUT: 'REASONING_OUTPUT',
  COST_OBSERVATION: 'COST_OBSERVATION',
  ARTIFACT: 'ARTIFACT',
});

export const VISIBILITY = Object.freeze({
  TRANSPORT_ATTEMPT: 'TRANSPORT_ATTEMPT',
  PORT_CALL_ONLY: 'PORT_CALL_ONLY',
  INTENT: 'INTENT',
  UNKNOWN: 'UNKNOWN',
});

export const DISPATCH_STATE = Object.freeze({
  ATTEMPTED: 'ATTEMPTED',
  RESPONSE_RECEIVED: 'RESPONSE_RECEIVED',
  INTENT: 'INTENT',
  UNKNOWN: 'UNKNOWN',
});

export const REASONING_RELATION = Object.freeze({
  INCLUDED_IN_OUTPUT: 'INCLUDED_IN_OUTPUT',
  SEPARATE: 'SEPARATE',
  NOT_PRESENT: 'NOT_PRESENT',
  UNKNOWN: 'UNKNOWN',
});

export const INPUT_COVERAGE = Object.freeze({
  COMPLETE: 'COMPLETE',
  PARTIAL: 'PARTIAL',
  UNKNOWN: 'UNKNOWN',
});

export const TOTAL_SOURCE = Object.freeze({
  PROVIDER: 'PROVIDER',
  DERIVED: 'DERIVED',
  UNKNOWN: 'UNKNOWN',
});

// Derived read-side classification (never written back to the DB).
export const ACTIVITY_STATE = Object.freeze({
  COMPLETED: 'COMPLETED',
  PAUSED: 'PAUSED',
  UNCLOSED: 'UNCLOSED',
  ACTIVITY_UNKNOWN: 'ACTIVITY_UNKNOWN',
  STATE_CONFLICT: 'STATE_CONFLICT',
});

export const RELATION_STATE = Object.freeze({
  VERIFIED: 'VERIFIED',
  UNVERIFIED_PARENT: 'UNVERIFIED_PARENT',
  MISSING_PARENT: 'MISSING_PARENT',
  ROOT_MISMATCH: 'ROOT_MISMATCH',
  SELF_ROOT_WITH_PARENT: 'SELF_ROOT_WITH_PARENT',
  CYCLE: 'CYCLE',
});

export const TIMING_QUALITY = Object.freeze({
  EXACT: 'EXACT',
  MONOTONIC: 'MONOTONIC',
  WALL_CLOCK: 'WALL_CLOCK',
  UNKNOWN: 'UNKNOWN',
});

export const SOURCE_MODE = Object.freeze({
  SNAPSHOT: 'SNAPSHOT',
  LIVE: 'LIVE',
  DEMO: 'DEMO',
});

export const GRAIN = Object.freeze({
  M1: '1m', M5: '5m', M15: '15m', H1: '1h', D1: '1d',
});

export const GRAIN_MS = Object.freeze({
  '1m': 60_000, '5m': 300_000, '15m': 900_000, '1h': 3_600_000, '1d': 86_400_000,
});

export const KNOWN_ENTITY_KINDS = Object.freeze(Object.values(ENTITY_KIND));

export const METRIC_VERSION = '1.0';
export const API_VERSION = '2';
