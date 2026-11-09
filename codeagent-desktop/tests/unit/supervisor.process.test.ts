/**
 * Deterministic supervisor E2E against a stub service (no Java, no network
 * beyond loopback). Covers design 6.4: ATTACH_OR_START, capability
 * handshake, owned-process shutdown, and never touching unknown processes.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  HandshakeError,
  ServiceSupervisor
} from '../../electron/main/service/supervisor';

const STUB = path.resolve(__dirname, '../fixtures/stub-service.mjs');
const TEST_TOKEN = 'unit-test-token-0123456789abcdef-0123456789abcdef';

let stubProc: ChildProcess | null = null;
let stubPort = 0;

beforeAll(async () => {
  // start a stub service on a random port with a known token for attach tests
  const { pickFreePort } = await import('../../electron/main/service/supervisor');
  stubPort = await pickFreePort();
  stubProc = spawn(process.execPath, [STUB], {
    env: {
      ...process.env,
      CODEAGENT_SERVICE_PORT: String(stubPort),
      CODEAGENT_SERVICE_TOKEN: TEST_TOKEN
    },
    stdio: 'ignore',
    windowsHide: true
  });
  await waitForStub(stubPort);
});

afterAll(() => {
  stubProc?.kill();
});

async function waitForStub(port: number): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      if (res.ok) return;
    } catch {
      // retry
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('stub service did not start');
}

/**
 * Polls until the owned child has fully exited (Windows kill is
 * asynchronous; Node may learn about the exit later than the OS).
 */
async function waitForOwnedExit(supervisor: ServiceSupervisor, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (supervisor.stopOwned() === 'ALREADY_EXITED') return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('owned process did not exit in time');
}

describe('ATTACH to a configured loopback service', () => {
  it('handshakes with the correct bearer token', async () => {
    const supervisor = new ServiceSupervisor();
    const result = await supervisor.attachOrStart({
      endpoint: `http://127.0.0.1:${stubPort}`,
      token: TEST_TOKEN
    });
    expect(result.mode).toBe('ATTACHED');
    expect(result.capabilities.serviceInstanceId).toBe('svc-stub-0001');
    expect(result.capabilities.protocolVersion).toBe('2.1');
    expect(supervisor.getState()).toBe('ATTACHED');
    // attached external services are never owned, never stopped
    expect(supervisor.getOwnedProcessInfo()).toBeNull();
    expect(supervisor.stopOwned()).toBe('NOT_OWNED');
  });

  it('fails closed on a wrong bearer token', async () => {
    const supervisor = new ServiceSupervisor();
    await expect(
      supervisor.attachOrStart({ endpoint: `http://127.0.0.1:${stubPort}`, token: 'wrong' })
    ).rejects.toMatchObject({ code: 'HTTP_ERROR' });
    expect(supervisor.getState()).toBe('START_FAILED');
  });

  it('refuses non-loopback endpoints without any network call', async () => {
    const supervisor = new ServiceSupervisor();
    await expect(
      supervisor.attachOrStart({ endpoint: 'http://10.9.9.9:1', token: TEST_TOKEN })
    ).rejects.toMatchObject({ code: 'NON_LOOPBACK' });
  });
});

describe('START bundled service (owned child)', () => {
  it('starts the stub with env-only token and reaches OWNED_READY', async () => {
    const supervisor = new ServiceSupervisor({ tokenGenerator: () => TEST_TOKEN });
    const result = await supervisor.attachOrStart(
      {},
      { command: process.execPath, args: [STUB], handshakeTimeoutMs: 15000 },
      'OWNED_PRIVATE'
    );
    expect(result.mode).toBe('OWNED_READY');
    if (result.mode !== 'OWNED_READY') return;
    expect(result.capabilities.serviceInstanceId).toBe('svc-stub-0001');
    // the token reached the child via environment: the stub only answers
    // capabilities when Authorization matches its env token
    const owned = supervisor.getOwnedProcessInfo();
    expect(owned).not.toBeNull();
    expect(owned?.port).toBe(result.port);
    expect(result.token).toBe(TEST_TOKEN);
    // owned process shutdown: first call signals the child; repeated calls
    // are idempotent and eventually report ALREADY_EXITED
    expect(supervisor.stopOwned()).toBe('STOPPED');
    expect(supervisor.stopOwned()).toBe('STOPPED');
    await waitForOwnedExit(supervisor);
    expect(supervisor.stopOwned()).toBe('ALREADY_EXITED');
  });

  it('does not fall back to bundled start in the default shared mode', async () => {
    const supervisor = new ServiceSupervisor({ tokenGenerator: () => TEST_TOKEN });
    await expect(supervisor.attachOrStart(
      { endpoint: `http://127.0.0.1:1`, token: TEST_TOKEN },
      { command: process.execPath, args: [STUB], handshakeTimeoutMs: 15000 }
    )).rejects.toBeInstanceOf(HandshakeError);
    expect(supervisor.getState()).toBe('START_FAILED');
  });

  it('starts a child only when owned private mode is explicit', async () => {
    const supervisor = new ServiceSupervisor({ tokenGenerator: () => TEST_TOKEN });
    const result = await supervisor.attachOrStart(
      {},
      { command: process.execPath, args: [STUB], handshakeTimeoutMs: 15000 },
      'OWNED_PRIVATE'
    );
    expect(result.mode).toBe('OWNED_READY');
    expect(supervisor.stopOwned()).toBe('STOPPED');
  });

  it('reports START_FAILED when the bundled child exits early', async () => {
    const supervisor = new ServiceSupervisor();
    await expect(
      supervisor.attachOrStart(
        {},
        { command: process.execPath, args: ['-e', 'process.exit(3)'], handshakeTimeoutMs: 5000 },
        'OWNED_PRIVATE'
      )
    ).rejects.toMatchObject({ code: 'CHILD_EXITED' });
    expect(supervisor.getState()).toBe('START_FAILED');
  });

  it('reports SPAWN_FAILED when the bundled command cannot be started', async () => {
    const supervisor = new ServiceSupervisor();
    await expect(
      supervisor.attachOrStart(
        {},
        { command: 'codeagent-command-that-does-not-exist', args: [], handshakeTimeoutMs: 5000 },
        'OWNED_PRIVATE'
      )
    ).rejects.toMatchObject({ code: 'SPAWN_FAILED' });
    expect(supervisor.getState()).toBe('START_FAILED');
    expect(supervisor.getOwnedProcessInfo()).toBeNull();
  });

  it('restart waits for the owned child to exit before respawning (single-writer)', async () => {
    const supervisor = new ServiceSupervisor({ tokenGenerator: () => TEST_TOKEN });
    const first = await supervisor.attachOrStart(
      {},
      { command: process.execPath, args: [STUB], handshakeTimeoutMs: 15000 },
      'OWNED_PRIVATE'
    );
    expect(first.mode).toBe('OWNED_READY');
    const firstPid = supervisor.getOwnedProcessInfo()?.pid;
    expect(firstPid).toBeDefined();
    // The stub has no lifecycle API, so restart uses the kill path — the
    // ordering guarantee under test is the awaited exit before respawn.
    const restarted = await supervisor.restart(
      {},
      { command: process.execPath, args: [STUB], handshakeTimeoutMs: 15000 },
      'OWNED_PRIVATE'
    );
    expect(restarted.mode).toBe('OWNED_READY');
    const second = supervisor.getOwnedProcessInfo();
    expect(second?.pid).toBeDefined();
    expect(second?.pid).not.toBe(firstPid);
    // The replaced child is fully exited — never left running as a second
    // writer against the same state directory.
    expect(() => process.kill(firstPid as number, 0)).toThrow();
    expect(supervisor.stopOwned()).toBe('STOPPED');
  });
});

describe('owned-process isolation (design 6.4 rule 4)', () => {
  it('a supervisor without ownership never stops foreign processes', async () => {
    const decoy = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 30000)'], {
      stdio: 'ignore',
      windowsHide: true
    });
    try {
      const stranger = new ServiceSupervisor();
      expect(stranger.stopOwned()).toBe('NOT_OWNED');
      // decoy must still be alive
      expect(decoy.pid).toBeDefined();
      expect(() => process.kill(decoy.pid as number, 0)).not.toThrow();
      // there is deliberately no API to stop by pid/port
      const supervisorApi = Object.getOwnPropertyNames(Object.getPrototypeOf(stranger));
      expect(supervisorApi).not.toContain('stopByPid');
      expect(supervisorApi).not.toContain('stopByPort');
    } finally {
      decoy.kill();
    }
  });

  it('handshake errors carry stable codes for UI mapping', () => {
    expect(new HandshakeError('NON_LOOPBACK', 'x').code).toBe('NON_LOOPBACK');
    expect(new HandshakeError('TIMEOUT', 'x').code).toBe('TIMEOUT');
  });
});
