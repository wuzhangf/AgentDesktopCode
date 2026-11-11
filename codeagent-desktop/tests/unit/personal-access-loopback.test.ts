/**
 * UCA-001 C4: loopback wire test for the personal-access session.
 *
 * Unlike the fake-fetch tests this drives a real `node:http` server over a
 * loopback socket, so the version header, JSON bodies, status handling and the
 * receipt lookup are exercised end to end. It is a protocol fixture, not a
 * real ACS/worker run: no model is called and no product store is touched.
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PersonalAccessSession } from '../../electron/main/personal-access/session';
import type { SecretStore } from '../../electron/main/bootstrap/secureConfig';

const secrets: SecretStore = {
  isEncryptionAvailable: () => true,
  encrypt: (plain) => Buffer.from(plain, 'utf8'),
  decrypt: (value) => value.toString('utf8')
};

interface Seen { method: string; path: string; version?: string; key?: string; body?: unknown }

describe('personal-access session over loopback http', () => {
  let directory: string;
  let server: http.Server;
  let origin: string;
  const seen: Seen[] = [];
  const sent = new Map<string, string>();

  beforeEach(async () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-loop-'));
    seen.length = 0;
    sent.clear();
    server = http.createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        const body = raw ? JSON.parse(raw) as Record<string, unknown> : undefined;
        const url = new URL(request.url ?? '/', 'http://127.0.0.1');
        seen.push({
          method: request.method ?? 'GET',
          path: url.pathname,
          version: request.headers['x-client-access-version'] as string | undefined,
          key: request.headers['idempotency-key'] as string | undefined,
          body
        });
        const send = (status: number, payload: unknown): void => {
          response.writeHead(status, { 'content-type': 'application/json' });
          response.end(JSON.stringify(payload));
        };
        const base = '/personal/v1/client';
        const route = url.pathname.startsWith(base) ? url.pathname.slice(base.length) : url.pathname;
        if (route === '/manifest') {
          send(200, {
            protocolVersion: 'client-access/1',
            storeId: 'store-loop',
            authBinding: 'device',
            replyDelivery: 'POLL',
            limits: { requestBytes: 65536, textBytes: 8192, replyPageBytes: 262144 },
            features: { conversationCreate: true, replyContent: true },
            authorizationRevision: '1'
          });
          return;
        }
        if (route === '/agents') {
          send(200, {
            items: [{
              agentRef: 'a1.acs', displayName: 'ACS 会话', sourceKind: 'ACS_SESSION',
              availability: 'AVAILABLE', reasonCode: null
            }]
          });
          return;
        }
        if (route === '/agents/a1.acs/conversations') {
          send(200, { items: [{ agentRef: 'a1.acs', conversationRef: 'c1.conv', title: '联调' }], nextCursor: null, truncated: false });
          return;
        }
        if (route === '/conversations/c1.conv') {
          send(200, {
            agentRef: 'a1.acs', conversationRef: 'c1.conv', title: '联调',
            observedAt: '2026-10-24T00:00:00Z', sourceState: 'RUNNING', executions: [],
            message: { availability: 'AVAILABLE', reasonCode: null, meaning: 'append', binding: 'b1.send' },
            actions: [], actionsTruncated: false
          });
          return;
        }
        if (route === '/conversations/c1.conv/replies') {
          send(200, {
            representation: 'MESSAGES', revision: '1',
            items: [{ replyRef: 'r1.out', role: 'assistant', text: 'UCA-LOOPBACK-OK', contentRevision: '1', textComplete: true }],
            nextCursor: null, coverage: 'BOUNDED_HISTORY'
          });
          return;
        }
        if (route === '/conversations/c1.conv/messages' && request.method === 'POST') {
          const requestId = String(body?.requestId ?? '');
          sent.set(requestId, 'ACCEPTED');
          send(200, { requestId, accepted: true, sourceStatus: 'ACCEPTED', consumed: false, observedAt: 'now' });
          return;
        }
        if (route === '/receipts/lookup' && request.method === 'POST') {
          const requestId = String((body as Record<string, unknown> | undefined)?.requestId ?? '');
          send(200, {
            requestId,
            accepted: true,
            sourceStatus: sent.get(requestId) ?? 'UNKNOWN',
            consumed: true,
            observedAt: 'now'
          });
          return;
        }
        send(404, { error: { code: 'NOT_FOUND' } });
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('no port');
    origin = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it('drives connect → agents → conversation → replies → send → lookup', async () => {
    const session = new PersonalAccessSession({ directory, connectionId: 'profile-loop', secretStore: secrets });
    session.configure({ action: 'CONFIGURE', origin, basePath: '/personal/v1/client', token: 'tok' });

    const status = await session.execute({ action: 'CONNECT' }) as { connected: boolean; manifest?: { storeId: string } };
    expect(status.connected).toBe(true);
    expect(status.manifest?.storeId).toBe('store-loop');

    const agents = await session.execute({ action: 'AGENTS' }) as { items: Array<{ agentRef: string }> };
    expect(agents.items[0]?.agentRef).toBe('a1.acs');

    const directoryPage = await session.execute({ action: 'CONVERSATIONS', agentRef: 'a1.acs' }) as { items: Array<{ conversationRef: string }> };
    expect(directoryPage.items[0]?.conversationRef).toBe('c1.conv');

    const view = await session.execute({ action: 'CONVERSATION', conversationRef: 'c1.conv' }) as { message: { binding: string } };
    expect(view.message.binding).toBe('b1.send');

    const page = await session.execute({ action: 'REPLIES', conversationRef: 'c1.conv' }) as { items: Array<{ text: string }> };
    expect(page.items[0]?.text).toBe('UCA-LOOPBACK-OK');

    const receipt = await session.execute({ action: 'SEND', conversationRef: 'c1.conv', text: '继续', requestId: 'req-loop-1' }) as { sourceStatus: string };
    expect(receipt.sourceStatus).toBe('ACCEPTED');

    const lookup = await session.execute({ action: 'LOOKUP', requestId: 'req-loop-1' }) as { sourceStatus: string };
    expect(lookup.sourceStatus).toBe('ACCEPTED');

    // The wire contract: version header on every call, idempotency key on the
    // write, and the source-provided binding in the body.
    expect(seen.every((request) => request.version === 'client-access/1')).toBe(true);
    const write = seen.find((request) => request.path.endsWith('/messages'));
    expect(write?.key).toBe('req-loop-1');
    expect(write?.body).toEqual({ requestId: 'req-loop-1', text: '继续', binding: 'b1.send' });
    expect(seen.some((request) => request.path.endsWith('/receipts/lookup'))).toBe(true);
  });
});
