import { chmodSync, existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { LinuxMemberEnrollment } from '../src/linux-member';

const origin = 'https://member.test';
const deviceCode = 'device-code-fixture';
const device = { deviceCode, userCode: 'ABCD-EFGH', verificationUri: '/member/device?userCode=ABCD-EFGH',
  expiresIn: 60, interval: 2 };
const token = { sessionId: 'session', memberId: 'member', workspaceId: 'workspace', agentInstanceId: 'instance',
  accessToken: 'access-token-fixture', refreshToken: 'refresh-token-fixture', accessExpiresIn: 16 };

it.skipIf(typeof process.getuid !== 'function')('enrolls privately and fences an in-flight refresh on logout', async () => {
  vi.useFakeTimers();
  const dir = mkdtempSync(join(tmpdir(), 'linux-member-'));
  const path = join(dir, 'member-session.json');
  const reset = vi.fn();
  let approved = false;
  let sendRefresh!: () => void;
  let revocations = 0;
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    expect(url.origin).toBe(origin);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (url.pathname.endsWith('/oauth/device')) {
      expect(body.binding.installationId).toBe('installation');
      return Response.json(device, { status: 201 });
    }
    if (url.pathname.endsWith('/oauth/token')) {
      if (body.grantType === 'refresh_token') {
        await new Promise<void>(resolve => { sendRefresh = resolve; });
        return Response.json({ ...token, accessToken: 'updated-access-fixture' });
      }
      expect(body.deviceCode).toBe(deviceCode);
      return approved ? Response.json(token) : Response.json({ code: 'authorization_pending' }, { status: 400 });
    }
    if (url.pathname.endsWith('/agent/self')) return Response.json({ agentInstanceId: 'instance', bindingRevision: 1 });
    if (url.pathname.endsWith('/agent/self/revoke')) {
      expect(body.expectedBindingRevision).toBe(1);
      revocations++;
      return Response.json({ changed: true });
    }
    throw Error('Unexpected member call');
  };

  try {
    const member = new LinuxMemberEnrollment(path, 'installation', reset, fetcher);
    const pending = await member.begin(origin);
    expect(pending).not.toHaveProperty('deviceCode');
    expect(await member.poll(pending.id)).toMatchObject({ state: 'pending', retryAfterMs: 2000 });
    vi.advanceTimersByTime(2000);
    expect(await member.poll(pending.id)).toMatchObject({ state: 'pending' });
    expect(existsSync(path)).toBe(false);
    approved = true;
    vi.advanceTimersByTime(2000);
    expect(await member.poll(pending.id)).toMatchObject({ state: 'signed_in', agentInstanceId: 'instance' });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(new LinuxMemberEnrollment(path, 'different-installation', reset, fetcher).status()).toEqual({ state: 'signed_out' });
    chmodSync(path, 0o644);
    expect(new LinuxMemberEnrollment(path, 'installation', reset, fetcher).status()).toEqual({ state: 'signed_out' });
    chmodSync(path, 0o600);

    const restarted = new LinuxMemberEnrollment(path, 'installation', reset, fetcher);
    expect(restarted.status()).toMatchObject({ state: 'signed_in' });
    vi.advanceTimersByTime(12001);
    const rotation = restarted.refresh();
    expect(restarted.refresh()).toBe(rotation);
    expect(await restarted.logout()).toEqual({ state: 'signed_out', remoteRevoked: true });
    sendRefresh();
    await rotation;
    expect(restarted.current()).toBeUndefined();
    expect(existsSync(path)).toBe(false);
    expect(revocations).toBe(1);
  } finally {
    vi.useRealTimers();
    rmSync(dir, { recursive: true, force: true });
  }
});

it('rejects device verification that points at a different origin', async () => {
  const fetcher: typeof fetch = async () =>
    Response.json({ ...device, verificationUri: 'https://elsewhere.test/member/device?userCode=ABCD-EFGH' }, { status: 201 });
  const member = new LinuxMemberEnrollment('/dev/null', 'installation', () => {}, fetcher);
  await expect(member.begin(origin)).rejects.toMatchObject({ code: 'MEMBER_VERIFICATION_URL_INVALID' });
  expect(member.status()).toEqual({ state: 'signed_out' });
});
