import { describe, expect, it, vi } from 'vitest';
import {
  ConnectionCoordinator,
  buildElectronProfilePathPlan,
  buildSecondInstanceIntent,
  validateSecondInstanceIntent,
  type ConnectionTarget
} from '../../electron/main/service/connectionCoordinator';

const capabilities = {
  serviceInstanceId: 'svc-test', protocolVersion: '2.1',
  operations: [{ id: 'read', availability: 'AVAILABLE' as const, contractVersion: '2.1' }]
};

function target(): ConnectionTarget {
  return { mode: 'SHARED_ATTACH', attach: { endpoint: 'http://127.0.0.1:8765', token: 'attach-token' } };
}

describe('ConnectionCoordinator', () => {
  it('coalesces duplicate bootstrap calls into one supervisor call', async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const attachOrStart = vi.fn(async () => {
      await pending;
      return { mode: 'ATTACHED' as const, capabilities, token: 'attach-token' };
    });
    const supervisor = { attachOrStart, restart: vi.fn(), stopOwned: vi.fn() };
    const coordinator = new ConnectionCoordinator({ supervisor: supervisor as never });
    const first = coordinator.connect(target());
    const second = coordinator.connect(target());
    expect(first).toBe(second);
    release();
    await expect(first).resolves.toMatchObject({ generation: 1, token: 'attach-token' });
    expect(attachOrStart).toHaveBeenCalledTimes(1);
  });

  it('drops an obsolete generation and never publishes its result', async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const attachOrStart = vi.fn(async () => {
      markStarted();
      await pending;
      return { mode: 'ATTACHED' as const, capabilities, token: 'attach-token' };
    });
    const supervisor = { attachOrStart, restart: vi.fn(), stopOwned: vi.fn() };
    const generations: number[] = [];
    const coordinator = new ConnectionCoordinator({ supervisor: supervisor as never, onGenerationChanged: (g) => generations.push(g) });
    const old = coordinator.connect(target());
    await started;
    const newer = coordinator.connect({ ...target(), attach: { endpoint: 'http://127.0.0.1:8766', token: 'new-token' } });
    release();
    await expect(old).rejects.toThrow('obsolete generation');
    expect(generations).toEqual([1, 2]);
    expect(coordinator.isCurrentGeneration(1)).toBe(false);
    await expect(newer).resolves.toMatchObject({ generation: 2, token: 'attach-token' });
    expect(attachOrStart).toHaveBeenCalledTimes(2);
  });

  it('does not coalesce an explicit restart with an active target', async () => {
    const attachOrStart = vi.fn(async () => ({ mode: 'ATTACHED' as const, capabilities, token: 'attach-token' }));
    const restart = vi.fn(async () => ({ mode: 'ATTACHED' as const, capabilities, token: 'attach-token' }));
    const supervisor = { attachOrStart, restart, stopOwned: vi.fn() };
    const coordinator = new ConnectionCoordinator({ supervisor: supervisor as never });
    await coordinator.connect(target());
    const result = await coordinator.restart(target());
    expect(result.generation).toBe(2);
    expect(restart).toHaveBeenCalledTimes(1);
    expect(attachOrStart).toHaveBeenCalledTimes(1);
  });
});

describe('profile and second-instance safe seams', () => {
  it('maps profile paths without sharing directories', () => {
    const a = { userDataDir: 'a/user', sessionDataDir: 'a/session', crashDumpsDir: 'a/crash', logsDir: 'a/logs' } as never;
    const b = { userDataDir: 'b/user', sessionDataDir: 'b/session', crashDumpsDir: 'b/crash', logsDir: 'b/logs' } as never;
    expect(buildElectronProfilePathPlan(a).userData).not.toBe(buildElectronProfilePathPlan(b).userData);
    expect(buildElectronProfilePathPlan(a)).toEqual({ userData: 'a/user', sessionData: 'a/session', crashDumps: 'a/crash', logs: 'a/logs' });
  });

  it('allows only a public FOCUS intent and flags credential override', () => {
    expect(buildSecondInstanceIntent({ CODEAGENT_SERVICE_TOKEN: 'secret' }, { profileId: 'desktop-a', endpoint: 'http://127.0.0.1:8765', buildId: 'dev' }))
      .toEqual({ kind: 'FOCUS', profileId: 'desktop-a', credentialOverridePresent: true, endpoint: 'http://127.0.0.1:8765', buildId: 'dev' });
    expect(validateSecondInstanceIntent({ kind: 'FOCUS', profileId: 'desktop-a', credentialOverridePresent: true, token: 'secret' })).toBeNull();
    expect(validateSecondInstanceIntent({ kind: 'FOCUS', profileId: 'desktop-a', credentialOverridePresent: true, endpoint: 'http://127.0.0.1:8765/path' })).toBeNull();
    expect(validateSecondInstanceIntent({ kind: 'OPEN_WINDOW', argv: ['secret'] })).toBeNull();
  });
});
