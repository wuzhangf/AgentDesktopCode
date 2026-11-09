// Type declarations for personal-enums.mjs (PAE P0 freeze §2/§4).
// Enums/constants only; DTO types live in
// codeagent-desktop/packages/protocol/src/personal.ts.

export declare const PERSONAL_API_PREFIX: string;

export declare const PERSONAL_CONNECTION_KIND: {
  readonly CORE_LOCAL: 'CORE_LOCAL';
  readonly DAEMON: 'DAEMON';
  readonly ACS_DIRECT: 'ACS_DIRECT';
};

export declare const ENVIRONMENT_OPERATION_STATE: {
  readonly QUEUED: 'QUEUED';
  readonly RUNNING: 'RUNNING';
  readonly NEEDS_INPUT: 'NEEDS_INPUT';
  readonly READY: 'READY';
  readonly FAILED: 'FAILED';
  readonly CANCELED: 'CANCELED';
  readonly UNKNOWN: 'UNKNOWN';
};

export declare const ENVIRONMENT_OPERATION_KIND: {
  readonly PREPARE: 'PREPARE';
  readonly CLEANUP: 'CLEANUP';
  readonly RETIRE: 'RETIRE';
};

export declare const ENVIRONMENT_REASON_CODE: {
  readonly TOOLCHAIN_MISSING: 'TOOLCHAIN_MISSING';
  readonly VERSION_CONFLICT: 'VERSION_CONFLICT';
  readonly DEPENDENCY_UNAVAILABLE: 'DEPENDENCY_UNAVAILABLE';
  readonly NETWORK_DENIED: 'NETWORK_DENIED';
  readonly CREDENTIAL_REQUIRED: 'CREDENTIAL_REQUIRED';
  readonly SERVICE_UNREADY: 'SERVICE_UNREADY';
  readonly PLATFORM_UNSUPPORTED: 'PLATFORM_UNSUPPORTED';
  readonly BACKEND_UNAVAILABLE: 'BACKEND_UNAVAILABLE';
  readonly PLAN_INVALID: 'PLAN_INVALID';
  readonly RESOURCE_EXHAUSTED: 'RESOURCE_EXHAUSTED';
  readonly EFFECT_UNKNOWN: 'EFFECT_UNKNOWN';
};

export declare const PROJECTED_CHECK_STATUS: {
  readonly PASS: 'PASS';
  readonly FAIL: 'FAIL';
  readonly BLOCKED: 'BLOCKED';
  readonly INCONCLUSIVE: 'INCONCLUSIVE';
  readonly NOT_APPLICABLE: 'NOT_APPLICABLE';
  readonly DISABLED: 'DISABLED';
};

export declare const PERSONAL_CAPABILITY: {
  readonly PROJECT_ENVIRONMENT_PREPARE_V1: 'projectEnvironmentPrepareV1';
  readonly ENVIRONMENT_BOUND_EXECUTION_V1: 'environmentBoundExecutionV1';
  readonly ADAPTIVE_ACTION_V1: 'adaptiveActionV1';
};

export declare const ENVIRONMENT_BACKEND_PREFERENCE: {
  readonly HOST: 'HOST';
  readonly OCI_DOCKER: 'OCI_DOCKER';
  readonly OCI_PODMAN: 'OCI_PODMAN';
  readonly ANY: 'ANY';
};

export declare const ENVIRONMENT_READINESS_FACT_KIND: {
  readonly TOOL_VERSION: 'TOOL_VERSION';
  readonly WRITABLE_PATH: 'WRITABLE_PATH';
  readonly SERVICE_HEALTH: 'SERVICE_HEALTH';
  readonly DEPENDENCY_ENTRY: 'DEPENDENCY_ENTRY';
};

export declare const ADAPTIVE_ACTION_SCOPE: {
  readonly TASK: 'TASK';
  readonly PROJECT: 'PROJECT';
};

export declare const KNOWN_PERSONAL_CONNECTION_KINDS: readonly string[];
export declare const KNOWN_ENVIRONMENT_OPERATION_STATES: readonly string[];
export declare const KNOWN_ENVIRONMENT_REASON_CODES: readonly string[];
export declare const KNOWN_PROJECTED_CHECK_STATUSES: readonly string[];
export declare const KNOWN_PERSONAL_CAPABILITIES: readonly string[];

export declare const PERSONAL_ID_PATTERN: RegExp;
export declare const PERSONAL_DIGEST_PATTERN: RegExp;
