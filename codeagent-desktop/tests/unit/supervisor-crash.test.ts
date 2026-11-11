/**
 * Owned-service crash/restart E2E (design §6.4 rules 5–7, EW2 acceptance).
 * Deterministic: uses the node stub service, no Java, loopback only.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ServiceSupervisor } from '../../electron/main/service/supervisor';

const STUB = path.resolve(__dirname, '../fixtures/stub-service.mjs');
const TOKEN = 'crash-restart-e2e-token-0123456789abcdef';

async function waitForExitSignal(supervisor: ServiceSupervisor, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const owned = supervisor.getOwnedProcessInfo();
    if (!owned) return;
    // poll stopOwned: once the child is gone it reports ALREADY_EXITED
    if (supervisor.stopOwned() === 'ALREADY_EXITED') return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('owned process did not exit in time');
}

describe('owned service crash and restart', () => {
  it('detects an owned child crash and restarts into OWNED_READY', async () => {
    const crashEvents: Array<{ pid: number; port: number; exitCode: number | null }> = [];
    const supervisor = new ServiceSupervisor({
      tokenGenerator: () => TOKEN,
      onOwnedExit: (info) => crashEvents.push(info)
    });

    const first = await supervisor.attachOrStart(
      {},
      { command: process.execPath, args: [STUB], handshakeTimeoutMs: 15000 },
      'OWNED_PRIVATE'
    );
    expect(first.mode).toBe('OWNED_READY');
    if (first.mode !== 'OWNED_READY') return;
    const firstPid = supervisor.getOwnedProcessInfo()?.pid;

    // simulate a crash: kill -9 style termination of the owned child
    process.kill(firstPid as number, 'SIGKILL');
    await waitForExitSignal(supervisor);
    expect(crashEvents.length).toBeGreaterThanOrEqual(1);
    expect(crashEvents[0]?.pid).toBe(firstPid);

    // degraded shell "restart": a fresh owned child comes up
    const second = await supervisor.restart(
      {},
      { command: process.execPath, args: [STUB], handshakeTimeoutMs: 15000 },
      'OWNED_PRIVATE'
    );
    expect(second.mode).toBe('OWNED_READY');
    const secondPid = supervisor.getOwnedProcessInfo()?.pid;
    expect(secondPid).not.toBe(firstPid);
    expect(supervisor.getState()).toBe('OWNED_READY');
    expect(supervisor.stopOwned()).toBe('STOPPED');
  });

  it('restart never kills an external attached service', async () => {
    // attach to the external stub
    const { pickFreePort } = await import('../../electron/main/service/supervisor');
    const port = await pickFreePort();
    const external = spawn(process.execPath, [STUB], {
      env: {
        ...process.env,
        CODEAGENT_SERVICE_PORT: String(port),
        CODEAGENT_SERVICE_TOKEN: TOKEN
      },
      stdio: 'ignore',
      windowsHide: true
    });
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/health`);
        if (res.ok) break;
      } catch { /* retry */ }
      await new Promise((r) => setTimeout(r, 50));
    }
    try {
      const supervisor = new ServiceSupervisor();
      const attached = await supervisor.attachOrStart({
        endpoint: `http://127.0.0.1:${port}`,
        token: TOKEN
      });
      expect(attached.mode).toBe('ATTACHED');
      // restart drops nothing (no owned child) and must not touch the external process
      const again = await supervisor.restart({
        endpoint: `http://127.0.0.1:${port}`,
        token: TOKEN
      });
      expect(again.mode).toBe('ATTACHED');
      // external process still alive
      expect(() => process.kill(external.pid as number, 0)).not.toThrow();
    } finally {
      external.kill();
    }
  });
});
