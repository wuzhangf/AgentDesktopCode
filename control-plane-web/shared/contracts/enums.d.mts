export declare const LIFECYCLE: {
  readonly REGISTERED: 'REGISTERED';
  readonly STARTED: 'STARTED';
  readonly TERMINAL: 'TERMINAL';
  readonly OUTCOME_UNKNOWN: 'OUTCOME_UNKNOWN';
};
export declare const OUTCOME: {
  readonly SUCCEEDED: 'SUCCEEDED';
  readonly FAILED: 'FAILED';
  readonly TIMED_OUT: 'TIMED_OUT';
  readonly CANCELLED: 'CANCELLED';
  readonly REJECTED: 'REJECTED';
  readonly SKIPPED: 'SKIPPED';
};
export declare const KNOWN_TERMINAL_OUTCOMES: readonly string[];
export declare const SUCCESS_RATE_OUTCOMES: readonly string[];
export declare const ENTITY_KIND: {
  readonly TASK: 'TASK';
  readonly RUN: 'RUN';
  readonly RUN_SEGMENT: 'RUN_SEGMENT';
  readonly PLAN_REVISION: 'PLAN_REVISION';
  readonly STEP: 'STEP';
  readonly STEP_ATTEMPT: 'STEP_ATTEMPT';
  readonly MODEL_CALL: 'MODEL_CALL';
  readonly MODEL_ATTEMPT: 'MODEL_ATTEMPT';
  readonly TOOL_CALL: 'TOOL_CALL';
  readonly COMMAND: 'COMMAND';
  readonly DELEGATION: 'DELEGATION';
  readonly CONTEXT_SNAPSHOT: 'CONTEXT_SNAPSHOT';
  readonly CONTEXT_TRANSFORM: 'CONTEXT_TRANSFORM';
  readonly REASONING_OUTPUT: 'REASONING_OUTPUT';
  readonly COST_OBSERVATION: 'COST_OBSERVATION';
  readonly ARTIFACT: 'ARTIFACT';
};
export declare const VISIBILITY: {
  readonly TRANSPORT_ATTEMPT: 'TRANSPORT_ATTEMPT';
  readonly PORT_CALL_ONLY: 'PORT_CALL_ONLY';
  readonly INTENT: 'INTENT';
  readonly UNKNOWN: 'UNKNOWN';
};
export declare const DISPATCH_STATE: {
  readonly ATTEMPTED: 'ATTEMPTED';
  readonly RESPONSE_RECEIVED: 'RESPONSE_RECEIVED';
  readonly INTENT: 'INTENT';
  readonly UNKNOWN: 'UNKNOWN';
};
export declare const REASONING_RELATION: {
  readonly INCLUDED_IN_OUTPUT: 'INCLUDED_IN_OUTPUT';
  readonly SEPARATE: 'SEPARATE';
  readonly NOT_PRESENT: 'NOT_PRESENT';
  readonly UNKNOWN: 'UNKNOWN';
};
export declare const INPUT_COVERAGE: {
  readonly COMPLETE: 'COMPLETE';
  readonly PARTIAL: 'PARTIAL';
  readonly UNKNOWN: 'UNKNOWN';
};
export declare const TOTAL_SOURCE: {
  readonly PROVIDER: 'PROVIDER';
  readonly DERIVED: 'DERIVED';
  readonly UNKNOWN: 'UNKNOWN';
};
export declare const ACTIVITY_STATE: {
  readonly COMPLETED: 'COMPLETED';
  readonly PAUSED: 'PAUSED';
  readonly UNCLOSED: 'UNCLOSED';
  readonly ACTIVITY_UNKNOWN: 'ACTIVITY_UNKNOWN';
  readonly STATE_CONFLICT: 'STATE_CONFLICT';
};
export declare const RELATION_STATE: {
  readonly VERIFIED: 'VERIFIED';
  readonly UNVERIFIED_PARENT: 'UNVERIFIED_PARENT';
  readonly MISSING_PARENT: 'MISSING_PARENT';
  readonly ROOT_MISMATCH: 'ROOT_MISMATCH';
  readonly SELF_ROOT_WITH_PARENT: 'SELF_ROOT_WITH_PARENT';
  readonly CYCLE: 'CYCLE';
};
export declare const TIMING_QUALITY: {
  readonly EXACT: 'EXACT';
  readonly MONOTONIC: 'MONOTONIC';
  readonly WALL_CLOCK: 'WALL_CLOCK';
  readonly UNKNOWN: 'UNKNOWN';
};
export declare const SOURCE_MODE: {
  readonly SNAPSHOT: 'SNAPSHOT';
  readonly LIVE: 'LIVE';
  readonly DEMO: 'DEMO';
};
export declare const GRAIN: {
  readonly M1: '1m'; readonly M5: '5m'; readonly M15: '15m';
  readonly H1: '1h'; readonly D1: '1d';
};
export declare const GRAIN_MS: Record<string, number>;
export declare const KNOWN_ENTITY_KINDS: readonly string[];
export declare const METRIC_VERSION: string;
export declare const API_VERSION: string;
