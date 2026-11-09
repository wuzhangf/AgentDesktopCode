/**
 * Real Java service attach E2E against an explicitly supplied external
 * package. The client no longer owns a server reactor module, so this gate
 * is opt-in and never searches the client source tree for a service jar.
 * Set AGENT_CODE_REAL_SERVICE_E2E=1, AGENT_CODE_REAL_SERVICE_JAR and
 * AGENT_CODE_REAL_SERVICE_CP to run it.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ServiceClient, ServiceProblem } from '../../packages/service-client/src/index';

const repoRoot = path.resolve(__dirname, '..', '..', '..', '..');
const jarPath = process.env.AGENT_CODE_REAL_SERVICE_JAR ?? '';
const cpPath = process.env.AGENT_CODE_REAL_SERVICE_CP ?? '';
const available = process.env.AGENT_CODE_REAL_SERVICE_E2E === '1' && fs.existsSync(jarPath) && fs.existsSync(cpPath);
const javaMainClass = process.env.AGENT_CODE_REAL_SERVICE_MAIN ?? 'com.sage.agentcode.local.AgentCodeLocalMain';

/**
 * Java Properties.load reads ISO-8859-1, so every path written into
 * service.properties must be ASCII. Localized Windows profiles make
 * os.tmpdir() non-ASCII; the repo-local target directory is ASCII and
 * already git-ignored.
 */
function asciiTempRoot(): string {
  const root = path.join(repoRoot, 'apps', 'codeagent-desktop', 'target');
  fs.mkdirSync(root, { recursive: true });
  return root;
}

describe.skipIf(!available)('real Java Business service attach', () => {
  const token = randomUUID();
  let java: ChildProcess | null = null;
  let port = 0;
  let workDir: string;

  beforeAll(async () => {
    // describe.skipIf handles the missing-prerequisite case; this throw is a
    // defensive fail-closed only (e.g. jar removed between module load and run).
    if (!available) {
      throw new Error(
        'SKIPPED_PREREQUISITE: build the real Java service and dependency classpath before running this gate'
      );
    }
    workDir = fs.mkdtempSync(path.join(asciiTempRoot(), 'real-java-e2e-'));
    const workspace = path.join(workDir, 'workspace');
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(path.join(workspace, 'README.md'), 'fixture\n');
    git(workspace, 'init');
    git(workspace, 'config', 'user.email', 'test@example.invalid');
    git(workspace, 'config', 'user.name', 'test');
    git(workspace, 'add', '.');
    git(workspace, 'commit', '-m', 'initial');

    port = await freePort();
    const stateDir = path.join(workDir, 'state');
    const modelConfig = path.join(workDir, 'model-providers.properties');
    fs.writeFileSync(modelConfig, [
      'MODEL_DEFAULT_MODEL=e2e-chat-model',
      'MODEL_PROVIDER_DEFAULT=e2e-provider',
      'PROVIDER_1_ID=e2e-provider',
      'PROVIDER_1_DIALECT=OPENAI_CHAT_COMPLETIONS',
      'PROVIDER_1_BASE_URL=https://example.invalid/v1',
      'PROVIDER_1_API_KEY_ENV=BUSINESS_AGENT_E2E_MISSING_KEY',
      'PROVIDER_1_MODEL_1_ID=e2e-chat-model',
      'PROVIDER_1_MODEL_1_CAPABILITIES=STREAMING_TEXT'
    ].join('\n'));
    const serviceProperties = [
      `server.host=127.0.0.1`,
      `server.port=${port}`,
      'auth.token-env=WORKER_PHASE2_E2E_TOKEN',
      `business.runtime.provenance.required=false`,
      `state.dir=${stateDir.replace(/\\/g, '/')}`,
      `model.config=${modelConfig.replace(/\\/g, '/')}`,
      `workspace.sample=${workspace.replace(/\\/g, '/')}`,
      `agent.profiles.directory=${path.join(workDir, 'agents').replace(/\\/g, '/')}`,
      `logging.dir=${path.join(workDir, 'logs').replace(/\\/g, '/')}`
    ].join('\n');
    fs.mkdirSync(path.join(workDir, 'agents'), { recursive: true });
    fs.writeFileSync(path.join(workDir, 'agents', 'java-specialist.json'), JSON.stringify({
      schemaVersion: 'agent-profile/1.0',
      id: 'java-specialist',
      name: 'Java Specialist',
      description: 'Fixture specialist profile for the real service contract E2E.',
      instructions: 'Prefer small, test-backed Java changes and explain affected call paths.',
      readonlyResearchDefault: 'AUTO'
    }, null, 2));
    fs.writeFileSync(path.join(workDir, 'service.properties'), serviceProperties);

    const cp = fs.readFileSync(cpPath, 'utf8').trim();
    java = spawn(process.env.AGENT_CODE_REAL_SERVICE_JAVA ?? 'java', [
      '-Dbusiness.runtime.provenance.required=false',
      '-cp', `${jarPath};${cp}`,
      javaMainClass,
      '--config', path.join(workDir, 'service.properties')
    ], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true, env: { ...process.env, WORKER_PHASE2_E2E_TOKEN: token, BUSINESS_AGENT_E2E_MISSING_KEY: '' } });
    java.stderr?.on('data', () => { /* diagnostics only; not asserted */ });
    await waitForLive();
  }, 60000);

  afterAll(() => {
    java?.kill();
  });

  function git(dir: string, ...args: string[]): void {
    const result = require('node:child_process').spawnSync(
      'git', ['-C', dir, ...args], { encoding: 'utf8' }
    );
    if (result.status !== 0) throw new Error(`git fixture failed: ${result.stderr}`);
  }

  async function freePort(): Promise<number> {
    const net = await import('node:net');
    return new Promise((resolve, reject) => {
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
  }

  async function waitForLive(): Promise<void> {
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/health/live`);
        if (res.ok) return;
      } catch { /* retry */ }
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error('real Java service did not become live');
  }

  it('capability handshake succeeds with the real service', async () => {
    const client = new ServiceClient({ baseUrl: `http://127.0.0.1:${port}`, token });
    const capabilities = await client.getCapabilities();
    expect(capabilities.protocolVersion).toBe('2.2');
    expect(capabilities.features.sessionV2).toBe(true);
    expect(capabilities.features.visibleOutputStream).toBe(true);
    expect(capabilities.serviceInstanceId).not.toBe('');
    expect(capabilities.operations.find((operation) => operation.id === 'session.message.send.image')?.availability)
      .toBe('UNAVAILABLE');
    expect(capabilities.operations.find((operation) => operation.id === 'session.message.send.image')?.reasonCode)
      .toBe('IMAGE_MODEL_INPUT_NOT_CONFIGURED');
  });

  it('projects list contains the configured workspace without its path', async () => {
    const client = new ServiceClient({ baseUrl: `http://127.0.0.1:${port}`, token });
    const projects = await client.listProjects();
    expect(projects.length).toBeGreaterThanOrEqual(1);
    expect(projects.some((p) => p.projectId === 'sample')).toBe(true);
    const serialized = JSON.stringify(projects);
    // the canonical filesystem root must never leak into the projection
    expect(serialized).not.toContain(workDir);
    expect(serialized).not.toContain('workspacePath');
  });

  it('returns a root-free session preflight with honest model availability', async () => {
    const client = new ServiceClient({ baseUrl: `http://127.0.0.1:${port}`, token });
    const preflight = await client.getProjectSessionPreflight('sample');
    expect(preflight.projectId).toBe('sample');
    expect(preflight.allowedIntents).toEqual(expect.arrayContaining(['ASK', 'PLAN']));
    expect(preflight.revision).not.toBe('');
    expect(preflight.policyFingerprint).not.toBe('');
    expect(preflight.modelAvailability).toBe('UNCONFIGURED');
    expect(JSON.stringify(preflight)).not.toContain(workDir);
  });

  it('missing runs answer a typed problem', async () => {
    const client = new ServiceClient({ baseUrl: `http://127.0.0.1:${port}`, token });
    await expect(client.getRun('does-not-exist')).rejects.toBeInstanceOf(ServiceProblem);
    await expect(client.getRun('does-not-exist')).rejects.toMatchObject({ status: 404 });
  });

  it('model catalog stays public-safe', async () => {
    const client = new ServiceClient({ baseUrl: `http://127.0.0.1:${port}`, token });
    const catalog = await client.getModelCatalog();
    expect(catalog.items.length).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(catalog).toLowerCase()).not.toContain('apikey');
  });

  it('session v2 create/list/get round-trips against the real service', async () => {
    const client = new ServiceClient({ baseUrl: `http://127.0.0.1:${port}`, token });
    const preflight = await client.getProjectSessionPreflight('sample');
    const created = await client.createSession({
      workspaceAlias: 'sample',
      executionMode: 'INSPECT',
      verificationLevel: 'NONE',
      writeAllow: [],
      writeForbid: [],
      policyFingerprint: preflight.policyFingerprint,
      preflightRevision: preflight.revision,
      workspaceFingerprint: preflight.workspaceFingerprint
    });
    expect(created.sessionId).not.toBe('');
    expect(created.sessionVersion).toBe(1);

    const list = await client.listSessions();
    expect(list.some((s) => s.sessionId === created.sessionId)).toBe(true);

    const fetched = await client.getSession(created.sessionId);
    expect(fetched.workspaceAlias).toBe('sample');

    // optimistic conflict: stale expectedSessionVersion fails closed
    await expect(
      client.patchSession(created.sessionId, {
        expectedSessionVersion: 999,
        title: 'renamed'
      })
    ).rejects.toMatchObject({ code: 'SESSION_VERSION_CONFLICT', status: 409 });
  });

  it('loads a specialist profile and persists its session snapshot', async () => {
    const client = new ServiceClient({ baseUrl: `http://127.0.0.1:${port}`, token });
    const catalog = await client.listAgentProfiles();
    const profile = catalog.profiles.find((item) => item.id === 'java-specialist');
    expect(profile).toMatchObject({ id: 'java-specialist', name: 'Java Specialist' });
    expect(profile?.description).toContain('real service contract E2E');
    expect(JSON.stringify(catalog)).not.toContain('Prefer small, test-backed');

    const preflight = await client.getProjectSessionPreflight('sample');
    const created = await client.createSession({
      workspaceAlias: 'sample',
      executionMode: 'INSPECT',
      verificationLevel: 'NONE',
      writeAllow: [],
      writeForbid: [],
      policyFingerprint: preflight.policyFingerprint,
      preflightRevision: preflight.revision,
      workspaceFingerprint: preflight.workspaceFingerprint,
      agentProfileId: 'java-specialist',
      agentProfileRevision: profile?.revision,
      readonlyResearchMode: 'OFF'
    });
    expect(created).toMatchObject({
      agentProfileId: 'java-specialist',
      agentProfileName: 'Java Specialist',
      readonlyResearchMode: 'OFF'
    });

    const fetched = await client.getSession(created.sessionId);
    expect(fetched).toMatchObject({
      agentProfileId: 'java-specialist',
      agentProfileName: 'Java Specialist',
      agentProfileRevision: profile?.revision,
      readonlyResearchMode: 'OFF'
    });
  });
});
