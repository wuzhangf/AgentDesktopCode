import { describe, expect, it, vi } from 'vitest';
import { bindingFor, releaseBinding } from '../src/bindings.js';
import type { Device } from '../src/protocol.js';
import type { GatewayContext } from '../src/context.js';

interface Call { method: string; path: string; key?: string; binding?: string; }

const device: Device = { id: '11111111-2222-3333-4444-555555555555', label: 'phone' } as Device;

const ctxWith = (responder: (call: Call) => { status: number; body: unknown }) => {
  const calls: Call[] = [];
  const ctx = {
    acs: {
      call: (method: string, path: string, _body: unknown, key?: string, binding?: string) => {
        calls.push({ method, path, key, binding });
        const reply = responder({ method, path, key, binding });
        return Promise.resolve({ status: reply.status, body: new TextEncoder().encode(JSON.stringify(reply.body)), contentType: 'application/json' });
      },
      callJson: () => Promise.reject(new Error('unused')),
    },
  } as unknown as GatewayContext;
  return { ctx, calls };
};

const registerReply = (token: string, remaining: number) =>
  ({ status: 201, body: { clientSessionId: `cs-${token}`, clientSessionToken: token, remainingTtlMillis: remaining } });

const dateNow = () => vi.spyOn(Date, 'now');

describe('client-session bindings', () => {
  it('registers once and reuses the token inside the lease', async () => {
    const { ctx, calls } = ctxWith((c) => {
      if (c.path === '/api/v2/client-sessions') return registerReply('tok-a', 90000);
      throw new Error(`unexpected ${c.method} ${c.path}`);
    });
    const first = await bindingFor(ctx, device);
    const second = await bindingFor(ctx, device);
    expect(first).toBe('tok-a');
    expect(second).toBe('tok-a');
    expect(calls.filter((c) => c.path === '/api/v2/client-sessions')).toHaveLength(1);
  });

  it('heartbeats near expiry and keeps the same token', async () => {
    let now = 1_000_000;
    const clock = dateNow().mockImplementation(() => now);
    try {
      const { ctx, calls } = ctxWith((c) => {
        if (c.path === '/api/v2/client-sessions') return registerReply('tok-b', 90000);
        if (c.path === '/api/v2/client-sessions/cs-tok-b/heartbeat' && c.method === 'POST'
            && c.binding === 'tok-b') {
          return { status: 200, body: { clientSessionId: 'cs-tok-b', serverTimeMillis: now, remainingTtlMillis: 90000 } };
        }
        throw new Error(`unexpected ${c.method} ${c.path}`);
      });
      expect(await bindingFor(ctx, device)).toBe('tok-b');
      now += 80_000; // inside the 15s heartbeat margin
      expect(await bindingFor(ctx, device)).toBe('tok-b');
      expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
        'POST /api/v2/client-sessions',
        'POST /api/v2/client-sessions/cs-tok-b/heartbeat',
      ]);
      now += 10_000; // renewed lease is fresh
      expect(await bindingFor(ctx, device)).toBe('tok-b');
      expect(calls).toHaveLength(2);
    } finally {
      clock.mockRestore();
    }
  });

  it('re-registers with a new key after the lease is gone upstream', async () => {
    let now = 1_000_000;
    const clock = dateNow().mockImplementation(() => now);
    try {
      const { ctx, calls } = ctxWith((c) => {
        if (c.path === '/api/v2/client-sessions') {
          return calls.length === 1 ? registerReply('tok-old', 90000) : registerReply('tok-new', 90000);
        }
        if (c.path.includes('/heartbeat')) return { status: 401, body: { code: 'CLIENT_SESSION_EXPIRED' } };
        throw new Error(`unexpected ${c.method} ${c.path}`);
      });
      expect(await bindingFor(ctx, device)).toBe('tok-old');
      now += 80_000; // near expiry → heartbeat → upstream says expired → re-register
      expect(await bindingFor(ctx, device)).toBe('tok-new');
      const regs = calls.filter((c) => c.path === '/api/v2/client-sessions');
      expect(regs).toHaveLength(2);
      expect(regs[0].key).not.toBe(regs[1].key); // REGISTRATION_EXPIRED needs a fresh key
      expect(calls[1].path).toContain('/heartbeat');
    } finally {
      clock.mockRestore();
    }
  });

  it('skips the doomed heartbeat when the lease already expired locally', async () => {
    let now = 1_000_000;
    const clock = dateNow().mockImplementation(() => now);
    try {
      const { ctx, calls } = ctxWith((c) => {
        if (c.path === '/api/v2/client-sessions') return registerReply('tok-r', 90000);
        throw new Error(`unexpected ${c.method} ${c.path}`);
      });
      expect(await bindingFor(ctx, device)).toBe('tok-r');
      now += 91_000; // past expiry — no heartbeat attempt, straight to register
      expect(await bindingFor(ctx, device)).toBe('tok-r');
      expect(calls).toHaveLength(2);
      expect(calls.every((c) => c.path === '/api/v2/client-sessions')).toBe(true);
    } finally {
      clock.mockRestore();
    }
  });

  it('shares one in-flight registration across concurrent callers', async () => {
    const { ctx, calls } = ctxWith((c) => {
      if (c.path === '/api/v2/client-sessions') return registerReply('tok-c', 90000);
      throw new Error(`unexpected ${c.method} ${c.path}`);
    });
    const [a, b, c] = await Promise.all([bindingFor(ctx, device), bindingFor(ctx, device), bindingFor(ctx, device)]);
    expect([a, b, c]).toEqual(['tok-c', 'tok-c', 'tok-c']);
    expect(calls).toHaveLength(1);
  });

  it('retries registration after a failed register', async () => {
    let attempts = 0;
    const { ctx } = ctxWith((c) => {
      if (c.path === '/api/v2/client-sessions') {
        attempts += 1;
        return attempts === 1 ? { status: 503, body: { code: 'X' } } : registerReply('tok-ok', 90000);
      }
      throw new Error(`unexpected ${c.method} ${c.path}`);
    });
    await expect(bindingFor(ctx, device)).rejects.toMatchObject({ code: 'UPSTREAM_UNAVAILABLE' });
    expect(await bindingFor(ctx, device)).toBe('tok-ok');
    expect(attempts).toBe(2);
  });

  it('release revokes upstream and forces re-registration on next use', async () => {
    const { ctx, calls } = ctxWith((c) => {
      if (c.path === '/api/v2/client-sessions') return registerReply('tok-d', 90000);
      if (c.method === 'DELETE' && c.path === '/api/v2/client-sessions/cs-tok-d') {
        return { status: 204, body: {} };
      }
      throw new Error(`unexpected ${c.method} ${c.path}`);
    });
    expect(await bindingFor(ctx, device)).toBe('tok-d');
    await releaseBinding(ctx, device.id);
    expect(calls[1]).toMatchObject({ method: 'DELETE', binding: 'tok-d' });
    expect(await bindingFor(ctx, device)).toBe('tok-d');
    expect(calls.filter((x) => x.path === '/api/v2/client-sessions' && x.method === 'POST')).toHaveLength(2);
  });
});
