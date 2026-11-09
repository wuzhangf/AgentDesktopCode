/**
 * UCA-001 C4: main-process personal-access session.
 *
 * The session owns the trusted connection binding, the write-only token and
 * the durable pending store. These tests pin the parts the renderer must not
 * be able to influence: binding resolution, action availability, and the fact
 * that a restart resumes the original lookup instead of re-posting a message.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PersonalAccessSession } from '../../electron/main/personal-access/session';
import type { SecretStore } from '../../electron/main/bootstrap/secureConfig';

const manifest = {
  protocolVersion: 'client-access/1',
  storeId: 'store-session-A',
  authBinding: 'device',
  replyDelivery: 'POLL',
  limits: { requestBytes: 65536, textBytes: 8192, replyPageBytes: 262144 },
  features: { conversationCreate: true, replyContent: true },
  authorizationRevision: '3'
};

const view = {
  agentRef: 'a1.agent',
  conversationRef: 'c1.conv',
  title: '会话',
  observedAt: '2026-10-24T00:00:00Z',
  sourceState: 'RUNNING',
  executions: [],
  message: { availability: 'AVAILABLE', reasonCode: null, meaning: 'append', binding: 'b1.send' },
  actions: [{ actionId: 'execution.stop', label: '停止', availability: 'AVAILABLE', reasonCode: null, inputKind: 'NONE', binding: 'b1.stop' }],
  actionsTruncated: false
};

function secretStore(available = true): SecretStore {
  return {
    isEncryptionAvailable: () => available,
    encrypt: (plain) => available ? Buffer.from(`enc:${plain}`, 'utf8') : null,
    decrypt: (encrypted) => {
      const text = encrypted.toString('utf8');
      return text.startsWith('enc:') ? text.slice(4) : null;
    }
  };
}

interface Recorded { method: string; url: string; body?: Record<string, unknown> }

function recordingFetch(handler: (request: Recorded) => unknown) {
  const requests: Recorded[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const recorded: Recorded = {
      method: init?.method ?? 'GET',
      url: String(input),
      ...(typeof init?.body === 'string' ? { body: JSON.parse(init.body) as Record<string, unknown> } : {})
    };
    requests.push(recorded);
    const payload = handler(recorded);
    return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { requests, fetchImpl };
}

describe('personal-access session', () => {
  let directory: string;

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-session-'));
  });

  afterEach(() => {
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it('refuses operations before a binding is configured', async () => {
    const session = new PersonalAccessSession({ directory, connectionId: 'profile-a', secretStore: secretStore() });
    await expect(session.execute({ action: 'AGENTS' })).rejects.toMatchObject({ code: 'NOT_CONFIGURED' });
    expect(session.status()).toMatchObject({ configured: false, connected: false, hasToken: false });
  });

  it('persists only the non-secret binding and encrypts the token', () => {
    const session = new PersonalAccessSession({ directory, connectionId: 'profile-a', secretStore: secretStore() });
    const status = session.configure({
      action: 'CONFIGURE',
      origin: 'http://127.0.0.1:9443',
      basePath: '/personal/v1/client/',
      token: 'super-secret-token'
    });
    expect(status).toMatchObject({ configured: true, hasToken: true, tokenPersisted: true });
    const config = fs.readFileSync(path.join(directory, 'personal-access.json'), 'utf8');
    expect(config).toContain('/personal/v1/client');
    expect(config).not.toContain('super-secret-token');
    const tokenFile = fs.readFileSync(path.join(directory, 'personal-access-token.enc'), 'utf8');
    expect(tokenFile.startsWith('enc:')).toBe(true);
  });

  it('keeps the token session-only when OS encryption is unavailable', () => {
    const session = new PersonalAccessSession({ directory, connectionId: 'profile-a', secretStore: secretStore(false) });
    const status = session.configure({ action: 'CONFIGURE', origin: 'http://127.0.0.1:9443', token: 'tok' });
    expect(status).toMatchObject({ hasToken: true, tokenPersisted: false, encryptionAvailable: false });
    expect(fs.existsSync(path.join(directory, 'personal-access-token.enc'))).toBe(false);
  });

  it('rejects untrusted origins and unreadable CA files', () => {
    const session = new PersonalAccessSession({ directory, connectionId: 'profile-a', secretStore: secretStore() });
    expect(() => session.configure({ action: 'CONFIGURE', origin: 'http://example.com' }))
      .toThrow(expect.objectContaining({ code: 'UNTRUSTED_ORIGIN' }));
    expect(() => session.configure({ action: 'CONFIGURE', origin: 'https://127.0.0.1', caPemPath: path.join(directory, 'missing.pem') }))
      .toThrow(expect.objectContaining({ code: 'CA_UNREADABLE' }));
    const notPem = path.join(directory, 'not-a-cert.pem');
    fs.writeFileSync(notPem, 'not a certificate');
    expect(() => session.configure({ action: 'CONFIGURE', origin: 'https://127.0.0.1', caPemPath: notPem }))
      .toThrow(expect.objectContaining({ code: 'CA_UNREADABLE' }));
  });

  it('connects, reports the manifest, and disconnects without losing the binding', async () => {
    const { fetchImpl } = recordingFetch((request) => request.url.endsWith('/manifest') ? manifest : {});
    const session = new PersonalAccessSession({ directory, connectionId: 'profile-a', secretStore: secretStore(), fetchImpl });
    session.configure({ action: 'CONFIGURE', origin: 'http://127.0.0.1:9443', basePath: '/personal/v1/client', token: 'tok' });
    const connected = await session.execute({ action: 'CONNECT' }) as { connected: boolean; manifest?: { storeId: string } };
    expect(connected.connected).toBe(true);
    expect(connected.manifest?.storeId).toBe('store-session-A');

    const disconnected = await session.execute({ action: 'DISCONNECT' }) as { connected: boolean; configured: boolean };
    expect(disconnected).toMatchObject({ connected: false, configured: true });
  });

  it('resolves the message binding in main instead of trusting the renderer', async () => {
    const { requests, fetchImpl } = recordingFetch((request) => {
      if (request.url.endsWith('/manifest')) return manifest;
      if (request.url.endsWith('/conversations/c1.conv')) return view;
      return { requestId: 'req-1', accepted: true, sourceStatus: 'ACCEPTED', consumed: true, observedAt: 'now' };
    });
    const session = new PersonalAccessSession({ directory, connectionId: 'profile-a', secretStore: secretStore(), fetchImpl });
    session.configure({ action: 'CONFIGURE', origin: 'http://127.0.0.1:9443', basePath: '/personal/v1/client', token: 'tok' });
    await session.execute({ action: 'CONNECT' });
    await session.execute({ action: 'SEND', conversationRef: 'c1.conv', text: '你好', requestId: 'req-1' });

    const post = requests.find((request) => request.method === 'POST');
    expect(post?.url).toContain('/conversations/c1.conv/messages');
    expect(post?.body).toEqual({ requestId: 'req-1', text: '你好', binding: 'b1.send' });
  });

  it('rejects actions the current view does not declare', async () => {
    const { fetchImpl } = recordingFetch((request) => {
      if (request.url.endsWith('/manifest')) return manifest;
      if (request.url.endsWith('/conversations/c1.conv')) return view;
      return {};
    });
    const session = new PersonalAccessSession({ directory, connectionId: 'profile-a', secretStore: secretStore(), fetchImpl });
    session.configure({ action: 'CONFIGURE', origin: 'http://127.0.0.1:9443', basePath: '/personal/v1/client', token: 'tok' });
    await session.execute({ action: 'CONNECT' });
    await expect(session.execute({
      action: 'ACTION', conversationRef: 'c1.conv', actionId: 'execution.pause', input: {}, requestId: 'req-2'
    })).rejects.toMatchObject({ code: 'CAPABILITY_UNAVAILABLE' });
  });

  it('resumes the original intention after a restart instead of re-posting', async () => {
    const { requests, fetchImpl } = recordingFetch((request) => {
      if (request.url.endsWith('/manifest')) return manifest;
      if (request.url.endsWith('/conversations/c1.conv')) return view;
      if (request.url.endsWith('/receipts/lookup')) {
        return { requestId: 'req-9', accepted: true, sourceStatus: 'APPLIED', consumed: true, observedAt: 'now' };
      }
      return { requestId: 'req-9', accepted: true, sourceStatus: 'ACCEPTED', consumed: false, observedAt: 'now' };
    });

    const first = new PersonalAccessSession({ directory, connectionId: 'profile-a', secretStore: secretStore(), fetchImpl });
    first.configure({ action: 'CONFIGURE', origin: 'http://127.0.0.1:9443', basePath: '/personal/v1/client', token: 'tok' });
    await first.execute({ action: 'CONNECT' });
    await first.execute({ action: 'SEND', conversationRef: 'c1.conv', text: '一次', requestId: 'req-9' });

    // A new process/profile session reads the same durable pending directory.
    const second = new PersonalAccessSession({ directory, connectionId: 'profile-a', secretStore: secretStore(), fetchImpl });
    await second.execute({ action: 'CONNECT' });
    const receipt = await second.execute({ action: 'LOOKUP', requestId: 'req-9' }) as { sourceStatus: string };

    expect(receipt.sourceStatus).toBe('APPLIED');
    expect(requests.filter((request) => request.method === 'POST' && request.url.endsWith('/messages'))).toHaveLength(1);
    expect(requests.filter((request) => request.url.endsWith('/receipts/lookup'))).toHaveLength(1);
  });

  it('keeps the token out of the pending record', async () => {
    const { fetchImpl } = recordingFetch((request) => {
      if (request.url.endsWith('/manifest')) return manifest;
      if (request.url.endsWith('/conversations/c1.conv')) return view;
      return { requestId: 'req-11', accepted: true, sourceStatus: 'ACCEPTED', consumed: false, observedAt: 'now' };
    });
    const session = new PersonalAccessSession({ directory, connectionId: 'profile-a', secretStore: secretStore(), fetchImpl });
    session.configure({ action: 'CONFIGURE', origin: 'http://127.0.0.1:9443', basePath: '/personal/v1/client', token: 'tok-abc' });
    await session.execute({ action: 'CONNECT' });
    await session.execute({ action: 'SEND', conversationRef: 'c1.conv', text: 'x', requestId: 'req-11' });

    const pendingDir = path.join(directory, 'pending');
    const files = fs.readdirSync(pendingDir);
    expect(files).toHaveLength(1);
    const record = fs.readFileSync(path.join(pendingDir, files[0]!), 'utf8');
    expect(record).not.toContain('tok-abc');
    expect(record).not.toContain('Authorization');
  });
});
