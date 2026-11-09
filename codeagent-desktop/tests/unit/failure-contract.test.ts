import { describe, expect, it } from 'vitest';
import {
  decodeFailure,
  decodeScheduling,
  decideFailurePresentation,
  legacyRetryableFromFailure
} from '../../packages/protocol/src/failureContract';
import {
  validateProblem,
  validateRunActivityListResponse,
  validateRunActivityResponse,
  validateRunStateResponse
} from '../../packages/protocol/src/validators';
import { decodeActivityEvent } from '../../src/renderer/app/activity/decodeActivityEvent';
import { decodeRunFailure } from '../../src/renderer/app/failureDecoder';

const failure = {
  schemaVersion: '1',
  code: 'MODEL_RESPONSE_INCOMPLETE',
  domain: 'MODEL_PROTOCOL',
  phase: 'RECEIVE',
  disposition: 'USER_ACTION_REQUIRED',
  effectState: 'NOT_APPLIED',
  safeMessage: '模型响应不完整，请继续。',
  recovery: {
    mode: 'NEW_MODEL_ATTEMPT',
    actor: 'RUNTIME',
    automatic: false,
    actionIds: ['NEW_MODEL_ATTEMPT', 'CONTINUE_RESPONSE']
  }
} as const;

const scheduling = {
  schemaVersion: '1',
  runId: 'run-1',
  state: 'SUSPENDED',
  primaryReason: 'SESSION_ACTIVE_RUN_EXISTS',
  secondaryReasons: ['WAITING_FOR_RESOURCE'],
  queuePosition: 2,
  approximate: true,
  activeClaims: ['session:session-1']
} as const;

describe('Failure Contract v1 client boundary', () => {
  it('keeps failure, scheduling and reasonCode on the validated RunState projection', () => {
    const run = validateRunStateResponse({
      runId: 'run-1', taskId: 'task-1', state: 'RUNNING', stateVersion: 3,
      changedFileCount: 0, failure, scheduling, reasonCode: 'SESSION_ACTIVE_RUN_EXISTS'
    });
    expect(run.failure?.code).toBe('MODEL_RESPONSE_INCOMPLETE');
    expect(run.scheduling?.primaryReason).toBe('SESSION_ACTIVE_RUN_EXISTS');
    expect(run.reasonCode).toBe('SESSION_ACTIVE_RUN_EXISTS');
  });

  it('uses only typed facts for retry and fails closed for unknown code/effect', () => {
    const retryable = decodeFailure(failure);
    expect(retryable).toBeDefined();
    expect(decideFailurePresentation(retryable).showRetry).toBe(true);
    expect(legacyRetryableFromFailure(retryable)).toBe(true);

    const unknown = decodeFailure({
      ...failure,
      code: 'SERVICE_ADDED_CODE',
      effectState: 'UNKNOWN',
      recovery: { ...failure.recovery, mode: 'RETRY_OPERATION', actionIds: ['RETRY_OPERATION'] }
    });
    expect(unknown).toBeDefined();
    expect(decideFailurePresentation(unknown).catalogKnown).toBe(false);
    expect(decideFailurePresentation(unknown).showRetry).toBe(false);
    expect(legacyRetryableFromFailure(unknown)).toBe(false);

    const automatic = decodeFailure({
      ...failure,
      disposition: 'AUTO_RECOVERING',
      recovery: { ...failure.recovery, automatic: true }
    });
    expect(legacyRetryableFromFailure(automatic)).toBe(false);
  });

  it('preserves additive fields in Problem and activity decoders', () => {
    const problem = validateProblem({
      code: 'MODEL_RESPONSE_INCOMPLETE', status: 502, message: 'legacy message',
      failure, scheduling, reasonCode: 'WAITING_FOR_RESOURCE', operationOutcome: 'NOT_APPLIED'
    });
    expect(problem.failure?.code).toBe('MODEL_RESPONSE_INCOMPLETE');
    expect(problem.scheduling?.state).toBe('SUSPENDED');
    expect(problem.reasonCode).toBe('WAITING_FOR_RESOURCE');

    const activity = validateRunActivityResponse({
      activityId: 'activity-1', runId: 'run-1', kind: 'COMMAND', status: 'FAILED',
      reasonCode: 'TOOL_EXECUTION_FAILED', failure, scheduling, effectState: 'NOT_APPLIED',
      groupId: 'verify', groupPurpose: '验证修复',
      fileRef: 'apps/codeagent-desktop/src/App.tsx', fileName: 'App.tsx',
      relativeDirectory: 'apps/codeagent-desktop/src', startLine: 12, endLine: 24,
      bytesRead: 6000, fileSizeBytes: 24000, workingDirectory: 'apps/codeagent-desktop'
    });
    expect(activity.failure?.effectState).toBe('NOT_APPLIED');
    expect(activity.scheduling?.queuePosition).toBe(2);
    expect(activity.reasonCode).toBe('TOOL_EXECUTION_FAILED');
    expect(activity.fileRef).toBe('apps/codeagent-desktop/src/App.tsx');
    expect(activity.startLine).toBe(12);
    expect(activity.bytesRead).toBe(6000);

    const decoded = decodeActivityEvent('tool.failed', {
      runId: 'run-1', status: 'FAILED', cursor: 8, occurredAt: '2026-09-05T00:00:00Z',
      payload: {
        activityId: 'activity-1', activityKind: 'FILE_READ', reasonCode: 'TOOL_EXECUTION_FAILED', failure, scheduling,
        fileRef: 'apps/codeagent-desktop/src/App.tsx', startLine: 12, endLine: 24, bytesRead: 6000
      }
    });
    expect(decoded?.activity.failure?.code).toBe('MODEL_RESPONSE_INCOMPLETE');
    expect(decoded?.activity.scheduling?.primaryReason).toBe('SESSION_ACTIVE_RUN_EXISTS');
    expect(decoded?.activity.reasonCode).toBe('TOOL_EXECUTION_FAILED');
    expect(decoded?.activity.fileRef).toBe('apps/codeagent-desktop/src/App.tsx');
    expect(decoded?.activity.endLine).toBe(24);
  });

  it('uses the list runId when legacy activity items omit it', () => {
    const snapshot = validateRunActivityListResponse({
      runId: 'run-legacy', runStateVersion: 4, snapshotCursor: 7,
      complete: false, items: [{
        activityId: 'activity-legacy', runId: null,
        kind: 'MODEL', status: 'RUNNING'
      }],
      summary: {}
    });

    expect(snapshot.runId).toBe('run-legacy');
    expect(snapshot.items[0]?.runId).toBe('run-legacy');
  });

  it('retains unknown scheduling reason codes without inventing a retry', () => {
    const decoded = decodeScheduling({ state: 'NEW_SERVICE_STATE', primaryReason: 'SERVICE_NEW_REASON' });
    expect(decoded?.state).toBe('UNKNOWN');
    expect(decoded?.primaryReason).toBe('SERVICE_NEW_REASON');
    expect(decideFailurePresentation(undefined).showRetry).toBe(false);
  });

  it('classifies workspace recovery failures without making them retryable', () => {
    const resourceBusy = decodeFailure({
      ...failure,
      code: 'RESOURCE_BUSY',
      effectState: 'UNKNOWN',
      safeMessage: 'Workspace resource is not available: RESOURCE_BUSY',
      recovery: { mode: 'NONE', actor: 'RUNTIME', automatic: false, actionIds: [] }
    });
    expect(decideFailurePresentation(resourceBusy).catalogKnown).toBe(true);
    expect(decideFailurePresentation(resourceBusy).headline).toBe('工作区资源暂时不可用');
    expect(decideFailurePresentation(resourceBusy).showRetry).toBe(false);
  });

  it('allows retry when the service proves resource contention did not apply', () => {
    const resourceBusy = decodeFailure({
      ...failure,
      code: 'RESOURCE_BUSY',
      domain: 'ENVIRONMENT',
      phase: 'ADMISSION',
      disposition: 'USER_ACTION_REQUIRED',
      effectState: 'NOT_APPLIED',
      recovery: {
        mode: 'RETRY_OPERATION', actor: 'RUNTIME', automatic: false,
        sameInputAllowed: true, attemptsUsed: 0, maxAttempts: 0,
        actionIds: ['RETRY_OPERATION']
      }
    });
    expect(decideFailurePresentation(resourceBusy).showRetry).toBe(true);
  });

  it('projects legacy run failure fields without claiming an effect or retry', () => {
    const run = decodeRunFailure({
      runId: 'run-legacy', taskId: 'task-legacy', state: 'FAILED', stateVersion: 4,
      failureCode: 'LEGACY_TOOL_FAILED', failureMessage: '旧服务返回的安全原因',
      terminationCode: 'PROCESS_FAILED'
    });
    expect(run?.code).toBe('LEGACY_TOOL_FAILED');
    expect(run?.safeMessage).toBe('旧服务返回的安全原因');
    expect(run?.effectState).toBe('UNKNOWN');
    expect(decideFailurePresentation(run).showRetry).toBe(false);
    expect(decodeRunFailure({
      runId: 'completed', state: 'COMPLETED', terminationCode: 'COMPLETED'
    })).toBeUndefined();
  });
});
