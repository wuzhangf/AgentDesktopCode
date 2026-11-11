// Personal management gateway enum mirror (PAE P0 contract freeze 2026-10-18
// §2/§4). Plain .mjs so the Node BFF (.mjs server) and the Vite frontend
// import the same frozen values. Enums and constants ONLY — DTO shapes stay
// in codeagent-desktop/packages/protocol/src/personal.ts (single owner); do
// not duplicate object shapes here.

export const PERSONAL_API_PREFIX = '/api/personal/v1';

// PersonalConnectionKind — how a worker/executor is attached (freeze §4).
export const PERSONAL_CONNECTION_KIND = Object.freeze({
  CORE_LOCAL: 'CORE_LOCAL',
  DAEMON: 'DAEMON',
  ACS_DIRECT: 'ACS_DIRECT',
});

// EnvironmentOperation.state — the frozen seven states (freeze §2).
// FAILED/CANCELED are written only by the operation writer after it proved
// stop; an unknown effect reads UNKNOWN, never a retried terminal guess.
export const ENVIRONMENT_OPERATION_STATE = Object.freeze({
  QUEUED: 'QUEUED',
  RUNNING: 'RUNNING',
  NEEDS_INPUT: 'NEEDS_INPUT',
  READY: 'READY',
  FAILED: 'FAILED',
  CANCELED: 'CANCELED',
  UNKNOWN: 'UNKNOWN',
});

// EnvironmentOperation.kind (freeze §1).
export const ENVIRONMENT_OPERATION_KIND = Object.freeze({
  PREPARE: 'PREPARE',
  CLEANUP: 'CLEANUP',
  RETIRE: 'RETIRE',
});

// Environment-domain reasonCode vocabulary (freeze §2, frozen).
export const ENVIRONMENT_REASON_CODE = Object.freeze({
  TOOLCHAIN_MISSING: 'TOOLCHAIN_MISSING',
  VERSION_CONFLICT: 'VERSION_CONFLICT',
  DEPENDENCY_UNAVAILABLE: 'DEPENDENCY_UNAVAILABLE',
  NETWORK_DENIED: 'NETWORK_DENIED',
  CREDENTIAL_REQUIRED: 'CREDENTIAL_REQUIRED',
  SERVICE_UNREADY: 'SERVICE_UNREADY',
  PLATFORM_UNSUPPORTED: 'PLATFORM_UNSUPPORTED',
  BACKEND_UNAVAILABLE: 'BACKEND_UNAVAILABLE',
  PLAN_INVALID: 'PLAN_INVALID',
  RESOURCE_EXHAUSTED: 'RESOURCE_EXHAUSTED',
  EFFECT_UNKNOWN: 'EFFECT_UNKNOWN',
});

// ProjectedCheckStatus — the verification-result projection (freeze §2).
// Adapters map each kernel's existing enums; old enums are not rewritten.
export const PROJECTED_CHECK_STATUS = Object.freeze({
  PASS: 'PASS',
  FAIL: 'FAIL',
  BLOCKED: 'BLOCKED',
  INCONCLUSIVE: 'INCONCLUSIVE',
  NOT_APPLICABLE: 'NOT_APPLICABLE',
  DISABLED: 'DISABLED',
});

// Joint capability names (freeze §2): advertised only when the install-side
// channel, real binding consumption and measured readiness are all present.
export const PERSONAL_CAPABILITY = Object.freeze({
  PROJECT_ENVIRONMENT_PREPARE_V1: 'projectEnvironmentPrepareV1',
  ENVIRONMENT_BOUND_EXECUTION_V1: 'environmentBoundExecutionV1',
  ADAPTIVE_ACTION_V1: 'adaptiveActionV1',
});

// EnvironmentPlan preferredBackend values (freeze §1).
export const ENVIRONMENT_BACKEND_PREFERENCE = Object.freeze({
  HOST: 'HOST',
  OCI_DOCKER: 'OCI_DOCKER',
  OCI_PODMAN: 'OCI_PODMAN',
  ANY: 'ANY',
});

// PreparedEnvironment readinessFacts.kind vocabulary (freeze §1).
export const ENVIRONMENT_READINESS_FACT_KIND = Object.freeze({
  TOOL_VERSION: 'TOOL_VERSION',
  WRITABLE_PATH: 'WRITABLE_PATH',
  SERVICE_HEALTH: 'SERVICE_HEALTH',
  DEPENDENCY_ENTRY: 'DEPENDENCY_ENTRY',
});

// AdaptiveActionPlan scope (freeze §1).
export const ADAPTIVE_ACTION_SCOPE = Object.freeze({
  TASK: 'TASK',
  PROJECT: 'PROJECT',
});

export const KNOWN_PERSONAL_CONNECTION_KINDS = Object.freeze(Object.values(PERSONAL_CONNECTION_KIND));
export const KNOWN_ENVIRONMENT_OPERATION_STATES = Object.freeze(Object.values(ENVIRONMENT_OPERATION_STATE));
export const KNOWN_ENVIRONMENT_REASON_CODES = Object.freeze(Object.values(ENVIRONMENT_REASON_CODE));
export const KNOWN_PROJECTED_CHECK_STATUSES = Object.freeze(Object.values(PROJECTED_CHECK_STATUS));
export const KNOWN_PERSONAL_CAPABILITIES = Object.freeze(Object.values(PERSONAL_CAPABILITY));

// Frozen wire formats (freeze §0): ids and sha256 digests.
export const PERSONAL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
export const PERSONAL_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
