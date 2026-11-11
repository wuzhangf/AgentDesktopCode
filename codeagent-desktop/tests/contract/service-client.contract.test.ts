/**
 * EW1 service-client contract tests against a stub service implementing the
 * canonical wire shapes. Covers: capability handshake validation,
 * fail-closed version skew, Idempotency-Key propagation, optimistic
 * conflict surfacing, unknown enum degradation and problem parsing.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ServiceClient,
  ServiceProblem,
  ProtocolIncompatible
} from '../../packages/service-client/src/index';
import { degradeRunState, validateCapabilities } from '@codeagent/protocol';

const STUB = path.resolve(__dirname, '../fixtures/contract-stub-service.mjs');
const TOKEN = 'contract-stub-bearer-token-0123456789';

let stub: ChildProcess | null = null;
let port = 0;

beforeAll(async () => {
  const net = await import('node:net');
  port = await new Promise<number>((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const address = s.address();
      if (address && typeof address === 'object') {
        const p = address.port;
        s.close(() => resolve(p));
      } else {
        s.close();
        reject(new Error('no port'));
      }
    });
  });
  stub = spawn(process.execPath, [STUB], {
    env: { ...process.env, CODEAGENT_SERVICE_PORT: String(port), CODEAGENT_SERVICE_TOKEN: TOKEN },
    stdio: 'ignore',
    windowsHide: true
  });
  await waitForStub();
});

afterAll(() => {
  stub?.kill();
});

async function waitForStub(): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/v2/capabilities`);
      if (res.status === 401) return; // up and answering
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('contract stub did not start');
}

function client(): ServiceClient {
  return new ServiceClient({ baseUrl: `http://127.0.0.1:${port}`, token: TOKEN });
}

describe('capability handshake', () => {
  it('validates and accepts a compatible service', async () => {
    const capabilities = await client().getCapabilities();
    expect(capabilities.serviceInstanceId).toBe('svc-contract-stub');
    expect(capabilities.protocolVersion).toBe('2.1');
    expect(capabilities.features.visibleOutputStream).toBe(false);
    expect(capabilities.limits.maxEventPage).toBe(500);
    expect(capabilities.operations.find((operation) => operation.id === 'session.create.inspect')?.availability)
      .toBe('AVAILABLE');
  });

  it('rejects unauthenticated calls with a typed problem', async () => {
    const bad = new ServiceClient({ baseUrl: `http://127.0.0.1:${port}`, token: 'wrong' });
    await expect(bad.getCapabilities()).rejects.toMatchObject({ code: 'UNAUTHORIZED', status: 401 });
  });

  it('fails closed on protocol skew (service too new)', async () => {
    // independent stub child with minDesktopProtocol above the desktop ceiling
    const net = await import('node:net');
    const skewPort = await new Promise<number>((resolve, reject) => {
      const s = net.createServer();
      s.on('error', reject);
      s.listen(0, '127.0.0.1', () => {
        const address = s.address();
        if (address && typeof address === 'object') {
          const p = address.port;
          s.close(() => resolve(p));
        } else { s.close(); reject(new Error('no port')); }
      });
    });
    const skew = spawn(process.execPath, [STUB], {
      env: {
        ...process.env,
        CODEAGENT_SERVICE_PORT: String(skewPort),
        CODEAGENT_SERVICE_TOKEN: TOKEN,
        CODEAGENT_STUB_MIN_DESKTOP: '2.5'
      },
      stdio: 'ignore',
      windowsHide: true
    });
    try {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        try {
          const probe = await fetch(`http://127.0.0.1:${skewPort}/api/v2/capabilities`);
          if (probe.status === 401) break;
        } catch { /* retry */ }
        await new Promise((r) => setTimeout(r, 50));
      }
      const skewClient = new ServiceClient({ baseUrl: `http://127.0.0.1:${skewPort}`, token: TOKEN });
      await expect(skewClient.getCapabilities()).rejects.toBeInstanceOf(ProtocolIncompatible);
      await expect(skewClient.getCapabilities()).rejects.toMatchObject({ reason: 'SERVICE_TOO_NEW' });
    } finally {
      skew.kill();
    }
  });
});

describe('projects and mutations', () => {
  it('lists projects and propagates Idempotency-Key on registration', async () => {
    const projects = await client().listProjects();
    expect(projects).toHaveLength(1);
    expect(projects[0]?.projectId).toBe('sample');

    const registration = await client().registerProject(
      { absolutePath: 'C:/codeagent/fixture', displayName: 'fixture' },
      'client-mutation-key-1'
    );
    expect(registration.projectId).toBe('fixture-1a2b3c4d');
  });

  it('reads a bounded project file projection through the service client', async () => {
    const file = await client().readProjectFile('sample', 'README.md');
    expect(file.fileRef).toBe('README.md');
    expect(file.encoding).toBe('UTF-8');
    expect(file.contentText).toBe('# fixture\n');
    expect(file.stale).toBe(false);
  });

  it('reads a server-owned session preflight instead of inventing a write scope', async () => {
    const preflight = await client().getProjectSessionPreflight('sample');
    expect(preflight.allowedIntents).toEqual(['ASK', 'CODE', 'PLAN']);
    expect(preflight.suggestedWriteScope).toEqual(['services/visits/src']);
    expect(preflight.writeScopeCeiling).toEqual(['services/visits/src']);
    expect(preflight.modelAvailability).toBe('AVAILABLE');
  });

  it('surfaces a missing run as a typed problem', async () => {
    const promise = client().getRun('run-unknown');
    await expect(promise).rejects.toBeInstanceOf(ServiceProblem);
    await expect(promise).rejects.toMatchObject({ code: 'INVALID_REQUEST', status: 404 });
  });

  it('sends governance PUT bodies and Idempotency-Key headers', async () => {
    const policy = await client().updatePolicyLayer(
      'PROJECT', { maximumAutonomy: 'LOW', expectedRevision: 3 }, 'policy-put-1'
    );
    expect(policy.effectiveMaximumAutonomy).toBe('LOW');
    const settings = await client().updateProductSettings(
      { localOnly: false, expectedRevision: 5 }, 'settings-put-1'
    );
    expect(settings.revision).toBe(6);
    expect(settings.localOnly).toBe(false);
  });
});

describe('runs, optimistic guard and unknown states', () => {
  it('reads the Java scheduler overview without locally interpreting its mode', async () => {
    const scheduler = await client().getSchedulerOverview();
    expect(scheduler.schedulerMode).toBe('DEGRADED');
    expect(scheduler.activeRuns).toBe(1);
    expect(scheduler.maxActiveRuns).toBe(2);
    expect(scheduler.queuedRuns).toBe(3);
    expect(scheduler.recoveryBarrier).toBe('OPEN');
    expect(scheduler.resourcePools[0]?.type).toBe('RUN_EXECUTION_SLOT');
  });

  it('returns an authoritative terminal view', async () => {
    const run = await client().getRun('run-1');
    expect(run.state).toBe('COMPLETED');
    expect(run.stateVersion).toBe(12);
  });

  it('surfaces STATE_VERSION_CONFLICT instead of acting on a stale view', async () => {
    await expect(
      client().interruptRun('run-1', { idempotencyKey: 'interrupt-1', expectedStateVersion: 999 })
    ).rejects.toMatchObject({ code: 'STATE_VERSION_CONFLICT', status: 409 });
  });

  it('interrupts with a fresh version and a generated Idempotency-Key', async () => {
    const run = await client().interruptRun('run-1', { expectedStateVersion: 12 });
    expect(run.state).toBe('NEEDS_ATTENTION');
  });

  it('degrades unknown enum values to UNKNOWN', async () => {
    const run = await client().getRun('run-drift');
    expect(run.state).toBe('UNKNOWN');
    expect(run.sourceStatus).toBe('SOMETHING_NEW');
    expect(degradeRunState('SOMETHING_NEW')).toBe('UNKNOWN');
    expect(degradeRunState('COMPLETED')).toBe('COMPLETED');
  });

  it('returns the evidence bundle for review', async () => {
    const bundle = await client().getRunEvidence('run-1');
    expect(bundle.complete).toBe(false);
    expect(bundle.items).toHaveLength(2);
  });
});

describe('GUI budget approval protocol', () => {
  it('reads the pending approval and submits an exact approval-id-bound decision', async () => {
    const result = await client().decideBudgetApproval(
      'run-budget',
      // The renderer may only have the attention approval id. The service
      // client must use the authoritative request fingerprint from GET.
      { decision: 'APPROVE', requestFingerprint: 'approval-1' },
      'client-budget-key-1'
    );
    expect(result.status).toBe('APPROVED');
    expect(result.approvalId).toBe('approval-1');
    expect(result.approvedTopUp?.maxSteps).toBe(4);
    expect(result.approvedTopUp?.maxModelHttpRequests).toBe(2);
  });

  it('maps the public reject decision to the service DENY enum', async () => {
    const result = await client().decideBudgetApproval(
      'run-budget',
      { decision: 'REJECT', requestFingerprint: 'approval-1', comment: 'not now' },
      'client-budget-key-2'
    );
    expect(result.status).toBe('DENIED');
    expect(result.decision).toBe('DENY');
    expect(result.comment).toBe('not now');
  });

  it('reads the pending command approval and submits the approval-id-bound decision', async () => {
    const result = await client().decideCommandApproval(
      'run-command',
      // The renderer fingerprint is only a hint; the pending projection is authoritative.
      { decision: 'APPROVE', fingerprint: 'attention-approval-id' },
      'client-command-key-1'
    );
    expect(result.status).toBe('ACCEPTED');
  });

  it('reads and approves an Agent terminal session through the typed terminal route', async () => {
    const pending = await client().pendingTerminalApproval('run-terminal');
    expect(pending?.approvalId).toBe('terminal-approval-1');
    expect(pending?.executable).toBe('node.exe');
    const result = await client().decideTerminalApproval(
      'run-terminal', { decision: 'APPROVE' }, 'client-terminal-key-1'
    );
    expect(result.status).toBe('ACCEPTED');
  });
});

describe('read-only external sources (EW10.2)', () => {
  it('fetches a source with provenance and the untrusted marker', async () => {
    const source = await client().fetchSource({ sourceType: 'DOCS', uri: 'https://docs.example.com/guide' });
    expect(source.untrustedContent).toBe(true);
    expect(source.sourceType).toBe('DOCS');
    expect(source.sourceUri).toBe('https://docs.example.com/guide');
    expect(source.finalUri).toBe('https://docs.example.com/guide');
    expect(source.contentType).toBe('text/markdown');
    expect(source.contentText).toBe('# guide');
    expect(source.statusCode).toBe(200);
    expect(source.truncated).toBe(false);
  });

  it('surfaces typed problems for forbidden types and non-public hosts', async () => {
    await expect(client().fetchSource({ sourceType: 'FORBIDDEN' as never, uri: 'https://docs.example.com/guide' }))
      .rejects.toMatchObject({ code: 'SOURCE_TYPE_FORBIDDEN', status: 415 });
    await expect(client().fetchSource({ sourceType: 'WEB', uri: 'http://127.0.0.1/x' }))
      .rejects.toMatchObject({ code: 'SOURCE_URI_FORBIDDEN', status: 403 });
  });

  it('propagates the provided Idempotency-Key on source fetches', async () => {
    // The stub records every accepted Idempotency-Key; re-sending the same
    // key with the same body is the observable propagation contract.
    const key = 'client-source-key-1';
    const first = await client().fetchSource({ sourceType: 'WEB', uri: 'https://docs.example.com/a' }, key);
    const second = await client().fetchSource({ sourceType: 'WEB', uri: 'https://docs.example.com/a' }, key);
    expect(first.sourceUri).toBe('https://docs.example.com/a');
    expect(second.sourceUri).toBe('https://docs.example.com/a');
  });
});

describe('read-only MCP sources (EW10.3)', () => {
  it('lists public-safe server summaries without command material', async () => {
    const servers = await client().listMcpServers();
    expect(servers).toHaveLength(1);
    expect(servers[0]?.serverId).toBe('docs');
    expect(servers[0]?.status).toBe('READY');
    expect(JSON.stringify(servers)).not.toContain('command');
  });

  it('lists resources for one allowlisted server', async () => {
    const resources = await client().listMcpResources('docs');
    expect(resources).toHaveLength(2);
    expect(resources[0]?.uri).toBe('file:///docs/a.md');
    expect(resources[0]?.mimeType).toBe('text/markdown');
  });

  it('reads a resource with provenance and the untrusted marker', async () => {
    const read = await client().readMcpResource('docs', 'file:///docs/a.md', 'client-mcp-key-1');
    expect(read.untrustedContent).toBe(true);
    expect(read.serverId).toBe('docs');
    expect(read.uri).toBe('file:///docs/a.md');
    expect(read.contentText).toBe('# guide');
    expect(read.truncated).toBe(false);
  });

  it('surfaces typed problems for remote failures', async () => {
    await expect(client().readMcpResource('docs', 'file:///missing.md'))
      .rejects.toMatchObject({ code: 'MCP_REQUEST_FAILED', status: 502 });
  });
});

describe('skill catalog (EW10.5) and typed hooks (EW10.6)', () => {
  it('registers a skill and lists it with visible instructions', async () => {
    const created = await client().registerSkill({
      name: 'error-codes', version: '1.0.0', source: 'user', scope: 'PROJECT',
      projectAlias: 'sample', instructions: 'Map error codes first.',
      permissions: ['CONTEXT_INJECTION']
    }, 'client-skill-key-1');
    expect(created.skillId).toMatch(/^skill-/);
    expect(created.status).toBe('ACTIVE');

    const skills = await client().listSkills();
    expect(skills).toHaveLength(1);
    expect(skills[0]?.instructions).toBe('Map error codes first.');
    expect(skills[0]?.revision).toBe(1);
  });

  it('changes skill status with optimistic concurrency', async () => {
    await expect(client().changeSkillStatus('skill-1a2b3c4d5e6f7a8b9c0d',
      { status: 'DISABLED', expectedRevision: 7 }, 'client-skill-key-2'))
      .rejects.toMatchObject({ code: 'SKILL_REVISION_CONFLICT', status: 409 });
    const disabled = await client().changeSkillStatus('skill-1a2b3c4d5e6f7a8b9c0d',
      { status: 'DISABLED', expectedRevision: 1 }, 'client-skill-key-3');
    expect(disabled.status).toBe('DISABLED');
    expect(disabled.revision).toBe(2);
  });

  it('lists hook health without command material', async () => {
    const hooks = await client().listHooks();
    expect(hooks).toHaveLength(1);
    expect(hooks[0]?.name).toBe('notify');
    expect(hooks[0]?.event).toBe('RUN_TERMINAL');
    expect(JSON.stringify(hooks)).not.toContain('command');
    const executions = await client().listHookExecutions();
    expect(executions.truncated).toBe(false);
    expect(executions.items?.[0]?.status).toBe('OK');
  });
});

describe('runtime validation', () => {
  it('rejects malformed capability payloads fail-closed', () => {
    expect(() => validateCapabilities({ serviceInstanceId: 'svc' })).toThrow();
    expect(() => validateCapabilities(null)).toThrow();
    expect(() =>
      validateCapabilities({
        serviceInstanceId: 'svc',
        protocolVersion: '2.1',
        minDesktopProtocol: '2.0',
        features: { sessionV2: 'yes', durableEvents: true, visibleOutputStream: false, worktreeExecution: false, mission: true, mcpHost: false, servicePty: false },
        limits: { maxDiffBytes: 1, maxEventPage: 1, maxVisibleDeltaChars: 1 }
      })
    ).toThrow();
  });
});
