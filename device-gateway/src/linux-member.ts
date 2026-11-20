import { randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, lstatSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname } from 'node:path';
import { fail, isRecord } from './protocol.js';

type Json = Record<string, unknown>;
const route = '/api/daily/v1/member';
const clientId = 'agent-link';
const scopes = ['work:read', 'work:write', 'sync:write', 'agent:self:read', 'agent:self:revoke'];
const identifier = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(value);
const credential = (value: unknown): value is string =>
  typeof value === 'string' && /^[\x21-\x7e]{16,4096}$/.test(value);

export interface CloudMemberIdentity {
  readonly origin: string;
  readonly memberId: string;
  readonly workspaceId: string;
  readonly instanceId: string;
  readonly bearer: string;
}

interface Session extends CloudMemberIdentity {
  readonly installationId: string;
  readonly sessionId: string;
  readonly refresh: string;
  readonly expiresAt: number;
  readonly refreshAt: number;
}

interface Pending {
  id: string;
  origin: string;
  deviceCode: string;
  expiresAt: number;
  intervalMs: number;
  nextPollAt: number;
}

function memberOrigin(value: unknown): string {
  try {
    if (typeof value !== 'string' || value.length > 512) throw Error();
    const url = new URL(value);
    if (url.protocol === 'https:' && url.pathname === '/' && !url.search && !url.hash &&
        !url.username && !url.password) return url.origin;
  } catch { /* report a bounded local error */ }
  return fail('MEMBER_ORIGIN_INVALID', 400);
}

function readSession(file: string, installationId: string): Session | undefined {
  try {
    const metadata = lstatSync(file);
    if (!metadata.isFile() || metadata.uid !== process.getuid?.() ||
        (metadata.mode & 0o077) !== 0 || metadata.size > 16384) return;
    const value: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (!isRecord(value) || value.installationId !== installationId ||
        memberOrigin(value.origin) !== value.origin || !identifier(value.sessionId) ||
        !identifier(value.memberId) || !identifier(value.workspaceId) || !identifier(value.instanceId) ||
        !credential(value.bearer) || !credential(value.refresh) || !Number.isSafeInteger(value.expiresAt) ||
        !Number.isSafeInteger(value.refreshAt)) return;
    return value as unknown as Session;
  } catch { return; }
}

function tokenSession(origin: string, installationId: string, token: Json): Session {
  if (!identifier(token.sessionId) || !identifier(token.memberId) || !identifier(token.workspaceId) ||
      !identifier(token.agentInstanceId) || !credential(token.accessToken) || !credential(token.refreshToken) ||
      typeof token.accessExpiresIn !== 'number' || !Number.isSafeInteger(token.accessExpiresIn) ||
      token.accessExpiresIn <= 0 || token.accessExpiresIn > 86400) fail('MEMBER_TOKEN_INVALID', 502);
  const expiresAt = Date.now() + token.accessExpiresIn * 1000;
  return { origin, installationId, sessionId: token.sessionId, memberId: token.memberId, workspaceId: token.workspaceId,
    instanceId: token.agentInstanceId, bearer: token.accessToken, refresh: token.refreshToken,
    expiresAt, refreshAt: expiresAt - Math.min(60_000, token.accessExpiresIn * 250) };
}

/** The Linux user service owns device authorization and token rotation. */
export class LinuxMemberEnrollment {
  private saved?: Session;
  private pending?: Pending;
  private generation = 0;
  private refreshing?: Promise<void>;
  private closed = false;

  constructor(private readonly file: string, private readonly installationId: string,
    private readonly resetGrant: (session: CloudMemberIdentity) => void,
    private readonly fetcher: typeof fetch = fetch) {
    this.saved = readSession(file, installationId);
  }

  current(): CloudMemberIdentity | undefined {
    if (this.closed || !this.saved || this.saved.expiresAt <= Date.now()) return;
    const { origin, memberId, workspaceId, instanceId, bearer } = this.saved;
    return { origin, memberId, workspaceId, instanceId, bearer };
  }

  status(): Json {
    if (this.saved) return { state: this.current() ? 'signed_in' : 'expired',
      origin: this.saved.origin, agentInstanceId: this.saved.instanceId };
    return { state: this.pending && Date.now() < this.pending.expiresAt ? 'pending' : 'signed_out' };
  }

  stop(): void {
    this.closed = true;
    this.generation++;
    this.pending = undefined;
  }

  private async request(origin: string, path: string, body?: Json, bearer?: string) {
    let response: Response;
    try {
      response = await this.fetcher(origin + route + path, {
        method: body === undefined ? 'GET' : 'POST', redirect: 'error',
        signal: AbortSignal.timeout(8000),
        headers: { ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
          'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const value: unknown = await response.json();
      if (isRecord(value)) return { ok: response.ok, status: response.status, value };
    } catch { /* credentials and provider errors are kept out of diagnostics */ }
    return fail('MEMBER_ORIGIN_UNAVAILABLE', 503);
  }

  async begin(originInput?: unknown): Promise<Json> {
    if (this.closed || this.saved) fail('MEMBER_ALREADY_LINKED', 409);
    const origin = memberOrigin(originInput ?? 'https://api.steercrew.com');
    const generation = ++this.generation;
    this.pending = undefined;
    const { ok, value } = await this.request(origin, '/oauth/device', { clientId, scope: scopes,
      binding: { installationId: this.installationId, displayName: hostname().slice(0, 80) || 'Agent Link Linux' } });
    if (generation !== this.generation) fail('MEMBER_ENROLLMENT_CHANGED', 409);
    if (!ok || !credential(value.deviceCode) || typeof value.userCode !== 'string' ||
        !/^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(value.userCode) || typeof value.verificationUri !== 'string' ||
        typeof value.expiresIn !== 'number' || !Number.isSafeInteger(value.expiresIn) || value.expiresIn <= 0 ||
        value.expiresIn > 3600 || typeof value.interval !== 'number' || !Number.isSafeInteger(value.interval) ||
        value.interval < 1 || value.interval > 120) fail('MEMBER_DEVICE_REQUEST_REJECTED', 502);
    let verification: URL;
    try { verification = new URL(value.verificationUri, origin); }
    catch { return fail('MEMBER_VERIFICATION_URL_INVALID', 502); }
    if (verification.origin !== origin || verification.pathname !== '/member/device' ||
        verification.username || verification.password || verification.hash ||
        verification.searchParams.get('userCode') !== value.userCode) fail('MEMBER_VERIFICATION_URL_INVALID', 502);
    const intervalMs = value.interval * 1000;
    const expiresAt = Date.now() + value.expiresIn * 1000;
    const id = randomUUID();
    this.pending = { id, origin, deviceCode: value.deviceCode, expiresAt, intervalMs, nextPollAt: Date.now() + intervalMs };
    return { id, verificationUrl: verification.href, userCode: value.userCode, expiresAt, retryAfterMs: intervalMs };
  }

  async poll(id: unknown): Promise<Json> {
    const pending = this.pending;
    if (!pending || id !== pending.id) fail('MEMBER_ENROLLMENT_CHANGED', 409);
    const now = Date.now();
    if (now >= pending.expiresAt) {
      this.pending = undefined;
      return { state: 'expired' };
    }
    if (now < pending.nextPollAt) return { state: 'pending',
      retryAfterMs: Number.isFinite(pending.nextPollAt) ? pending.nextPollAt - now : pending.intervalMs };
    pending.nextPollAt = Number.POSITIVE_INFINITY;
    const generation = this.generation;
    try {
      const { ok, value } = await this.request(pending.origin, '/oauth/token', { clientId,
        grantType: 'urn:ietf:params:oauth:grant-type:device_code', deviceCode: pending.deviceCode });
      if (generation !== this.generation) fail('MEMBER_ENROLLMENT_CHANGED', 409);
      if (ok) {
        const session = tokenSession(pending.origin, this.installationId, value);
        this.resetGrant(session);
        this.save(session);
        this.pending = undefined;
        return this.status();
      }
      if (value.code === 'authorization_pending' || value.code === 'slow_down') {
        if (value.code === 'slow_down') pending.intervalMs += 5000;
        return { state: 'pending', retryAfterMs: pending.intervalMs };
      }
      this.pending = undefined;
      if (value.code === 'access_denied') return { state: 'denied' };
      if (value.code === 'expired_token') return { state: 'expired' };
      return fail('MEMBER_AUTHORIZATION_REJECTED', 409);
    } finally { pending.nextPollAt = Date.now() + pending.intervalMs; }
  }

  refresh(): Promise<void> {
    if (!this.refreshing && this.saved && !this.closed && this.saved.refreshAt <= Date.now()) {
      const session = this.saved;
      this.refreshing = this.rotate(session).finally(() => { this.refreshing = undefined; });
    }
    return this.refreshing ?? Promise.resolve();
  }

  private async rotate(session: Session): Promise<void> {
    const generation = this.generation;
    const { ok, value } = await this.request(session.origin, '/oauth/token',
      { clientId, grantType: 'refresh_token', refreshToken: session.refresh });
    if (generation !== this.generation) return;
    if (!ok) {
      if (value.code === 'invalid_grant') {
        this.resetGrant(session);
        this.save(undefined);
        return;
      }
      return fail('MEMBER_REFRESH_UNAVAILABLE', 503);
    }
    const next = tokenSession(session.origin, this.installationId, value);
    if (next.memberId !== session.memberId || next.workspaceId !== session.workspaceId ||
        next.instanceId !== session.instanceId) fail('MEMBER_TOKEN_INVALID', 502);
    this.save(next);
  }

  async logout(): Promise<Json> {
    const session = this.saved;
    this.generation++;
    this.pending = undefined;
    if (session) this.resetGrant(session);
    this.save(undefined);
    if (!session) return this.status();
    let remoteRevoked = false;
    try {
      const { ok, value } = await this.request(session.origin, '/agent/self', undefined, session.bearer);
      if (ok && value.agentInstanceId === session.instanceId && Number.isSafeInteger(value.bindingRevision)) {
        const revoke = await this.request(session.origin, '/agent/self/revoke',
          { requestKey: randomUUID(), expectedBindingRevision: value.bindingRevision }, session.bearer);
        remoteRevoked = revoke.ok;
      }
    } catch { /* Local logout already took effect. */ }
    return { state: 'signed_out', remoteRevoked };
  }

  private save(session: Session | undefined): void {
    let temporary: string | undefined;
    if (session) {
      temporary = this.file + '.' + randomUUID() + '.tmp';
      try {
        const file = openSync(temporary, 'wx', 0o600);
        try {
          writeFileSync(file, JSON.stringify(session));
          fsyncSync(file);
        } finally { closeSync(file); }
        renameSync(temporary, this.file);
      } finally { rmSync(temporary, { force: true }); }
    } else {
      rmSync(this.file, { force: true });
    }
    this.saved = session;
    const directory = openSync(dirname(this.file), 'r');
    try { fsyncSync(directory); } finally { closeSync(directory); }
  }
}
