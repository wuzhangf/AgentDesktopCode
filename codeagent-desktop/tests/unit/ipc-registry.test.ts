import { describe, expect, it } from 'vitest';
import {
  IpcRegistry,
  approvalPingDefinition,
  bootstrapDefinition,
  chooseAndRegisterDefinition,
  diagnosticsDefinition,
  openExternalDefinition,
  serviceRestartDefinition,
  serviceStatusDefinition,
  specsCreateDefinition,
  executionPolicyGetDefinition,
  executionPolicyUpdateDefinition,
  executionPolicyDefaultsGetDefinition,
  executionPolicyDefaultsUpdateDefinition,
  automationControlGetDefinition,
  automationControlUpdateDefinition,
  approvalsListDefinition,
  approvalGetDefinition,
  approvalDecideDefinition,
  approvalAdvanceDefinition,
  approvalControlDefinition,
  terminalApprovalDefinition,
  terminalApprovalPendingDefinition,
  workspaceLaneCreateDefinition,
  workspaceLaneGetDefinition,
  workspaceLaneBindDefinition,
  workspaceLaneReopenDefinition,
  workspaceLaneReleaseDefinition,
  deliveryCreateDefinition,
  deliveryGetDefinition,
  deliveryPrepareDefinition,
  deliveryDecideDefinition,
  deliveryApplyDefinition,
  deliveryReconcileDefinition,
  deliveryListDefinition,
  environmentFeatureUpdateDefinition,
  modelProviderModelUpsertDefinition,
  isTrustedSender,
  MAX_IPC_PAYLOAD_CHARS
} from '../../electron/main/ipc/registry';

const TRUSTED = 'app://codeagent/index.html';

function fullRegistry(): IpcRegistry {
  const registry = new IpcRegistry();
  registry.register(bootstrapDefinition);
  registry.register(serviceRestartDefinition);
  registry.register(serviceStatusDefinition);
  registry.register(chooseAndRegisterDefinition);
  registry.register(diagnosticsDefinition);
  registry.register(openExternalDefinition);
  return registry;
}

describe('malicious IPC fixtures (design §6.2/§14.2)', () => {
  it('trusts only the bundled app://codeagent origin', () => {
    expect(isTrustedSender('app://codeagent/index.html')).toBe(true);
    expect(isTrustedSender('https://evil.example/')).toBe(false);
    expect(isTrustedSender('file:///C:/Windows/system32/config')).toBe(false);
    expect(isTrustedSender('app://evil/index.html')).toBe(false);
    expect(isTrustedSender(undefined)).toBe(false);
    expect(isTrustedSender('not a url')).toBe(false);
  });

  it('rejects unregistered channels even from a trusted sender', () => {
    const registry = fullRegistry();
    const result = registry.admit('app/steal-token', TRUSTED, undefined);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('unknown channel');
  });

  it('rejects every channel from an untrusted sender', () => {
    const registry = fullRegistry();
    for (const channel of registry.channels()) {
      const result = registry.admit(channel, 'https://evil.example/', undefined);
      expect(result.ok).toBe(false);
    }
  });

  it('rejects oversized payloads before schema validation', () => {
    const registry = fullRegistry();
    const oversized = 'x'.repeat(MAX_IPC_PAYLOAD_CHARS + 1);
    const result = registry.admit('app/bootstrap', TRUSTED, oversized);
    expect(result.ok).toBe(false);
  });

  it('rejects schema violations per channel', () => {
    const registry = fullRegistry();
    expect(registry.admit('app/bootstrap', TRUSTED, { injection: true }).ok).toBe(false);
    expect(registry.admit('app/service/restart', TRUSTED, [1, 2, 3]).ok).toBe(false);
    expect(registry.admit('app/openExternalHttps', TRUSTED, { url: 'file:///etc/passwd' }).ok).toBe(false);
    expect(registry.admit('app/openExternalHttps', TRUSTED, { url: 'javascript:alert(1)' }).ok).toBe(false);
    expect(registry.admit('app/openExternalHttps', TRUSTED, { url: 'https://user:pass@x.example/' }).ok).toBe(false);
  });

  it('admits well-formed calls from the trusted origin', () => {
    const registry = fullRegistry();
    expect(registry.admit('app/bootstrap', TRUSTED, undefined).ok).toBe(true);
    expect(registry.admit('app/service/restart', TRUSTED, null).ok).toBe(true);
    expect(
      registry.admit('app/openExternalHttps', TRUSTED, { url: 'https://example.com/doc' }).ok
    ).toBe(true);
  });

  it('refuses duplicate channel registration', () => {
    const registry = new IpcRegistry();
    registry.register(bootstrapDefinition);
    expect(() => registry.register(bootstrapDefinition)).toThrow();
  });

  it('admits the approval ping with no payload and rejects anything else', () => {
    const registry = new IpcRegistry();
    registry.register(approvalPingDefinition);
    expect(registry.admit('app/approvals/ping', TRUSTED, undefined).ok).toBe(true);
    expect(registry.admit('app/approvals/ping', TRUSTED, null).ok).toBe(true);
    expect(registry.admit('app/approvals/ping', TRUSTED, { runId: 'x' }).ok).toBe(false);
    expect(registry.admit('app/approvals/ping', 'https://evil.example/', undefined).ok).toBe(false);
  });

  it('admits spec creation with a sessionId envelope', () => {
    const registry = new IpcRegistry();
    registry.register(specsCreateDefinition);

    const admitted = registry.admit('app/specs/create', TRUSTED, {
      sessionId: 'session-1',
      body: { goal: '整理实现步骤', workspaceAlias: 'sample' }
    });

    expect(admitted).toEqual({
      ok: true,
      value: {
        sessionId: 'session-1',
        body: { goal: '整理实现步骤', workspaceAlias: 'sample' }
      }
    });
    expect(registry.admit('app/specs/create', TRUSTED, {
      id: 'session-1',
      body: { goal: '整理实现步骤' }
    }).ok).toBe(false);
  });

  it('bounds v2 permission and approval identities before proxying', () => {
    const registry = new IpcRegistry();
    registry.register(executionPolicyGetDefinition);
    registry.register(executionPolicyUpdateDefinition);
    registry.register(executionPolicyDefaultsGetDefinition);
    registry.register(executionPolicyDefaultsUpdateDefinition);
    registry.register(automationControlGetDefinition);
    registry.register(automationControlUpdateDefinition);
    registry.register(approvalsListDefinition);
    registry.register(approvalGetDefinition);
    registry.register(approvalDecideDefinition);
    registry.register(approvalAdvanceDefinition);
    registry.register(approvalControlDefinition);
    expect(registry.admit('app/execution-policy/get', TRUSTED, { sessionId: 's1', projectId: 'p1' }).ok).toBe(true);
    expect(registry.admit('app/execution-policy/get', TRUSTED, { sessionId: '../secret' }).ok).toBe(false);
    expect(registry.admit('app/execution-policy/update', TRUSTED, { id: 's1', body: { expectedRevision: 1 } }).ok).toBe(true);
    expect(registry.admit('app/execution-policy/defaults/get', TRUSTED, { projectId: 'p1' }).ok).toBe(true);
    expect(registry.admit('app/execution-policy/defaults/update', TRUSTED, { id: 'p1', body: { expectedRevision: 1 } }).ok).toBe(true);
    expect(registry.admit('app/automation-controls/get', TRUSTED, { sessionId: 's1' }).ok).toBe(true);
    expect(registry.admit('app/automation-controls/update', TRUSTED, { id: 's1', body: { expectedVersion: 1, control: 'PAUSE_AUTOMATION' } }).ok).toBe(true);
    expect(registry.admit('app/automation-controls/update', TRUSTED, { id: 's1', body: { expectedVersion: 1, control: 'INVALID' } }).ok).toBe(false);
    expect(registry.admit('app/approvals/v2/list', TRUSTED, { sessionId: 's1', limit: 100 }).ok).toBe(true);
    expect(registry.admit('app/approvals/v2/list', TRUSTED, { sessionId: 's1', limit: 1000 }).ok).toBe(false);
    expect(registry.admit('app/approvals/v2/decide', TRUSTED, { id: 'a1', body: { expectedVersion: 1 } }).ok).toBe(true);
    expect(registry.admit('app/approvals/v2/advance', TRUSTED, { id: 'a1', body: { expectedVersion: 1 } }).ok).toBe(true);
    expect(registry.admit('app/approvals/v2/get', TRUSTED, { approvalId: 'a1' }).ok).toBe(true);
    expect(registry.admit('app/approvals/v2/control', TRUSTED, { id: 'a1', body: { expectedVersion: 1, control: 'CANCEL' } }).ok).toBe(true);
  });

  it('bounds Agent terminal approval identities before proxying', () => {
    const registry = new IpcRegistry();
    registry.register(terminalApprovalDefinition);
    registry.register(terminalApprovalPendingDefinition);
    expect(registry.admit('app/approvals/terminal', TRUSTED, {
      id: 'run-1', body: { fingerprint: 'fp-1', decision: 'APPROVE' }
    }).ok).toBe(true);
    expect(registry.admit('app/approvals/terminal', TRUSTED, {
      id: '../run', body: { fingerprint: 'fp-1', decision: 'APPROVE' }
    }).ok).toBe(false);
    expect(registry.admit('app/approvals/terminal/pending', TRUSTED, {
      id: 'run-1'
    }).ok).toBe(true);
    expect(registry.admit('app/approvals/terminal/pending', TRUSTED, {
      id: 'run/1'
    }).ok).toBe(false);
  });

  it('bounds workspace lane and delivery identities, rejecting unsafe paths', () => {
    const registry = new IpcRegistry();
    [workspaceLaneCreateDefinition, workspaceLaneGetDefinition, workspaceLaneBindDefinition,
      workspaceLaneReopenDefinition, workspaceLaneReleaseDefinition, deliveryCreateDefinition,
      deliveryGetDefinition, deliveryPrepareDefinition, deliveryDecideDefinition,
      deliveryApplyDefinition, deliveryReconcileDefinition, deliveryListDefinition]
      .forEach((definition) => registry.register(definition));
    expect(registry.admit('app/workspace-lanes/create', TRUSTED, { sessionId: 's1', projectId: 'p1' }).ok).toBe(true);
    expect(registry.admit('app/workspace-lanes/get', TRUSTED, { workspaceLaneId: '../secret' }).ok).toBe(false);
    expect(registry.admit('app/workspace-lanes/lane', TRUSTED, { workspaceLaneId: 'lane-1', body: { runId: 'r1' } }).ok).toBe(false);
    expect(registry.admit('app/workspace-lanes/create', TRUSTED, { sessionId: 's1', projectId: 'p1', baselineRevision: '' }).ok).toBe(false);
    expect(registry.admit('app/deliveries/create', TRUSTED, { projectId: 'p1', workspaceLaneId: 'lane-1' }).ok).toBe(true);
    expect(registry.admit('app/deliveries/get', TRUSTED, { deliveryId: 'd/1' }).ok).toBe(false);
    expect(registry.admit('app/deliveries/list', TRUSTED, { projectId: 'p1', cursor: 42 }).ok).toBe(false);
    expect(registry.admit('app/deliveries/list', TRUSTED, { projectId: 'p1', limit: 101 }).ok).toBe(false);
  });

  it('keeps omitted feature entries absent instead of fabricating an empty map', () => {
    const registry = new IpcRegistry();
    registry.register(environmentFeatureUpdateDefinition);
    const admitted = registry.admit('app/environment/feature-update', TRUSTED, {
      featureId: 'TERMINAL', enabled: false, expectedRevision: 3
    });
    expect(admitted.ok).toBe(true);
    // undefined — not {} — so the service preserves the stored entries.
    expect(admitted.ok && admitted.value.entries).toBeUndefined();
    const withEntries = registry.admit('app/environment/feature-update', TRUSTED, {
      featureId: 'TERMINAL',
      entries: { 'terminal.allowed-executables': 'cmd.exe', 'terminal.enabled': null }
    });
    expect(withEntries.ok).toBe(true);
    if (withEntries.ok) {
      expect(withEntries.value.entries).toEqual({
        'terminal.allowed-executables': 'cmd.exe',
        'terminal.enabled': null
      });
    }
  });

  it('accepts model ids containing slash-separated vendor namespaces', () => {
    const registry = new IpcRegistry();
    registry.register(modelProviderModelUpsertDefinition);
    expect(registry.admit('app/model-providers/model-upsert', TRUSTED, {
      providerId: 'provider-a', modelId: 'provider-a/model-a', body: { enabled: true }
    }).ok).toBe(true);
    expect(registry.admit('app/model-providers/model-upsert', TRUSTED, {
      providerId: 'p1', modelId: 'bad id', body: {}
    }).ok).toBe(false);
  });
});
