// Mirror checks for the PAE P0 personal gateway enum mirror (freeze §2/§4).
// These constants must stay identical to the protocol single-owner copies in
// codeagent-desktop/packages/protocol/src/personal.ts.
import { describe, it, expect } from 'vitest';
import {
  PERSONAL_API_PREFIX,
  PERSONAL_CONNECTION_KIND,
  ENVIRONMENT_OPERATION_STATE,
  ENVIRONMENT_OPERATION_KIND,
  ENVIRONMENT_REASON_CODE,
  PROJECTED_CHECK_STATUS,
  PERSONAL_CAPABILITY,
  ENVIRONMENT_BACKEND_PREFERENCE,
  ENVIRONMENT_READINESS_FACT_KIND,
  ADAPTIVE_ACTION_SCOPE,
  KNOWN_ENVIRONMENT_OPERATION_STATES,
  KNOWN_ENVIRONMENT_REASON_CODES,
  KNOWN_PERSONAL_CONNECTION_KINDS,
  KNOWN_PERSONAL_CAPABILITIES,
  KNOWN_PROJECTED_CHECK_STATUSES,
  PERSONAL_ID_PATTERN,
  PERSONAL_DIGEST_PATTERN,
} from '../shared/contracts/personal-enums.mjs';

describe('personal gateway enum mirror (PAE P0 freeze §2/§4)', () => {
  it('freezes the seven operation states and eleven reason codes', () => {
    expect(Object.values(ENVIRONMENT_OPERATION_STATE)).toEqual([
      'QUEUED', 'RUNNING', 'NEEDS_INPUT', 'READY', 'FAILED', 'CANCELED', 'UNKNOWN',
    ]);
    expect(Object.values(ENVIRONMENT_REASON_CODE)).toEqual([
      'TOOLCHAIN_MISSING', 'VERSION_CONFLICT', 'DEPENDENCY_UNAVAILABLE',
      'NETWORK_DENIED', 'CREDENTIAL_REQUIRED', 'SERVICE_UNREADY',
      'PLATFORM_UNSUPPORTED', 'BACKEND_UNAVAILABLE', 'PLAN_INVALID',
      'RESOURCE_EXHAUSTED', 'EFFECT_UNKNOWN',
    ]);
    expect(KNOWN_ENVIRONMENT_OPERATION_STATES).toEqual(Object.values(ENVIRONMENT_OPERATION_STATE));
    expect(KNOWN_ENVIRONMENT_REASON_CODES).toEqual(Object.values(ENVIRONMENT_REASON_CODE));
  });

  it('freezes connection kinds, kinds, check status and capability names', () => {
    expect(Object.values(PERSONAL_CONNECTION_KIND)).toEqual(['CORE_LOCAL', 'DAEMON', 'ACS_DIRECT']);
    expect(Object.values(ENVIRONMENT_OPERATION_KIND)).toEqual(['PREPARE', 'CLEANUP', 'RETIRE']);
    expect(Object.values(PROJECTED_CHECK_STATUS)).toEqual([
      'PASS', 'FAIL', 'BLOCKED', 'INCONCLUSIVE', 'NOT_APPLICABLE', 'DISABLED',
    ]);
    expect(Object.values(PERSONAL_CAPABILITY)).toEqual([
      'projectEnvironmentPrepareV1', 'environmentBoundExecutionV1', 'adaptiveActionV1',
    ]);
    expect(Object.values(ENVIRONMENT_BACKEND_PREFERENCE)).toEqual(['HOST', 'OCI_DOCKER', 'OCI_PODMAN', 'ANY']);
    expect(Object.values(ENVIRONMENT_READINESS_FACT_KIND)).toEqual([
      'TOOL_VERSION', 'WRITABLE_PATH', 'SERVICE_HEALTH', 'DEPENDENCY_ENTRY',
    ]);
    expect(Object.values(ADAPTIVE_ACTION_SCOPE)).toEqual(['TASK', 'PROJECT']);
    expect(KNOWN_PERSONAL_CONNECTION_KINDS).toEqual(Object.values(PERSONAL_CONNECTION_KIND));
    expect(KNOWN_PERSONAL_CAPABILITIES).toEqual(Object.values(PERSONAL_CAPABILITY));
    expect(KNOWN_PROJECTED_CHECK_STATUSES).toEqual(Object.values(PROJECTED_CHECK_STATUS));
  });

  it('pins the api prefix and the frozen id/digest wire formats', () => {
    expect(PERSONAL_API_PREFIX).toBe('/api/personal/v1');
    expect(PERSONAL_ID_PATTERN.test('project-1.ok_2')).toBe(true);
    expect(PERSONAL_ID_PATTERN.test('-leading')).toBe(false);
    expect(PERSONAL_ID_PATTERN.test('has space')).toBe(false);
    expect(PERSONAL_ID_PATTERN.test('../path')).toBe(false);
    expect(PERSONAL_DIGEST_PATTERN.test(`sha256:${'a'.repeat(64)}`)).toBe(true);
    expect(PERSONAL_DIGEST_PATTERN.test(`sha256:${'A'.repeat(64)}`)).toBe(false);
    expect(PERSONAL_DIGEST_PATTERN.test('md5:abc')).toBe(false);
  });
});
