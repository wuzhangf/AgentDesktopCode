import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { request } from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { buildContext, type BuiltGateway } from '../src/gateway-main.js';
import { createGatewayListener } from '../src/http.js';
import { hash, secret } from '../src/protocol.js';
import { provisionTlsMaterial } from '../src/tls.js';

const listen = (server: Server) => new Promise<number>((resolve) => {
  server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
});
const close = (server: Server) => new Promise<void>((resolve) => server.close(() => resolve()));

it('uses the ACS model and original create key across PAC HTTPS and a gateway restart', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pac-acs-sessions-'));
  const tls = provisionTlsMaterial(join(root, 'tls'), { commonName: 'localhost' });
  const creates = new Map<string, string>();
  let createCalls = 0;
  let settings: unknown;
  const collaborationWrites: Array<{ path: string; key: unknown; body: unknown }> = [];
  let built: BuiltGateway | undefined;
  let pac: Server | undefined;
  const upstream = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    res.setHeader('content-type', 'application/json');
    const reply = (status: number, value: unknown) => {
      res.writeHead(status);
      res.end(JSON.stringify(value));
    };
    if (req.headers.authorization !== 'Bearer fixture-acs') return reply(401, { code: 'UNAUTHORIZED' });
    if (req.url === '/api/v2/client-sessions') {
      return reply(201, { clientSessionId: 'fixture-binding', clientSessionToken: 'fixture-client', remainingTtlMillis: 90_000 });
    }
    if (req.headers['x-codeagent-client-token'] !== 'fixture-client') return reply(401, { code: 'UNBOUND' });
    if (req.url === '/api/v2/model-catalog') {
      return reply(200, { catalogRevision: 'models-1', defaultModel: 'local-model', items: [
        { providerId: 'local', modelAlias: 'local-model', configured: true, availability: 'AVAILABLE', privateField: 'internal' },
        { providerId: 'unused', modelAlias: 'other', configured: false, availability: 'AVAILABLE' },
      ] });
    }
    if (req.url === '/api/v2/sessions' && req.method === 'POST') {
      const key = String(req.headers['idempotency-key']);
      createCalls++;
      const original = creates.get(key);
      if (original === undefined) {
        creates.set(key, body);
        req.socket.destroy();
        return;
      }
      if (body !== original) return reply(409, { code: 'IDEMPOTENCY_PAYLOAD_MISMATCH' });
      return reply(201, { sessionId: 'new-session', title: 'Fixture', privateField: 'internal' });
    }
    if (req.url === '/api/v2/sessions/new-session/model-settings') {
      if (req.method === 'PATCH') {
        if (req.headers['idempotency-key'] !== 'original-model-update') return reply(400, { code: 'INVALID_REQUEST' });
        settings = JSON.parse(body);
      }
      return reply(200, { settingsRevision: settings === undefined ? 1 : 2 });
    }
    if (req.url === '/api/v2/sessions/new-session/foundation') {
      return reply(200, { schemaVersion: 'session-foundation/1', sessionId: 'new-session',
        hostId: 'acs-host', storeId: 'acs-store' });
    }
    if (req.url === '/api/v2/runs/run-1') return reply(200, { sessionId: 'new-session' });
    const group = '/api/v2/runs/run-1/collaboration-groups/group-1';
    if (req.url === group) {
      return reply(200, {
        entityId: 'group-1',
        previews: [{ entityId: 'preview-1', groupId: 'group-1' }],
        adoptions: [{ entityId: 'adoption-1', groupId: 'group-1' }],
        repairs: [{ entityId: 'repair-1', groupId: 'group-1' }],
      });
    }
    if (req.method === 'POST' && req.url?.startsWith(`${group}/`)) {
      collaborationWrites.push({ path: req.url, key: req.headers['idempotency-key'], body: JSON.parse(body) });
      return reply(202, { state: 'REQUESTED' });
    }
    return reply(404, { code: 'NOT_FOUND' });
  });
  try {
    const sourcePort = await listen(upstream);
    const options = {
      dataDir: join(root, 'store'), storeKey: randomBytes(32), tls, bind: '127.0.0.1', port: 9443,
      ownerBind: '127.0.0.1', ownerPort: 0, ownerToken: 'fixture-owner', ownerClientToken: 'fixture-owner-client',
      acsUrl: `http://127.0.0.1:${sourcePort}`, acsOwnerToken: 'fixture-acs',
    };
    built = buildContext(options);
    const invite = built.devices.invitationResources('invite', [], [], ['OBSERVE', 'CREATE', 'INTERACT', 'ADOPT'], 'fixture-pin');
    const poll = secret();
    built.devices.request({ pairingRequestId: 'pair', inviteId: invite.inviteId, inviteSecret: invite.inviteSecret,
      pollingSecretHash: hash(poll), installationId: 'fixture-phone', label: 'Fixture phone' });
    built.devices.decide('pair', true);
    const grant = built.devices.redeem('pair', poll, 'redeem');
    const startPac = async () => {
      pac = createGatewayListener({ tls, ctx: built!.ctx, bind: '127.0.0.1', port: 0 });
      return listen(pac);
    };
    let port = await startPac();
    const call = (method: string, path: string, body?: object, key?: string) =>
      new Promise<{ status: number; body: Record<string, unknown> }>((resolve, reject) => {
        const req = request({ hostname: '127.0.0.1', port, method, ca: tls.cert,
          path: `/personal/v1${path}`, headers: {
            Authorization: `Bearer ${grant.accessToken}`, ...(key ? { 'Idempotency-Key': key } : {}),
            ...(body ? { 'Content-Type': 'application/json' } : {}),
          } }, (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => resolve({ status: res.statusCode!, body: JSON.parse(Buffer.concat(chunks).toString()) }));
        });
        req.on('error', reject);
        req.end(body && JSON.stringify(body));
      });

    expect((await call('GET', '/host')).body.capabilities).toMatchObject({ create: true, sessionModelSelection: true });
    const modelSettings = { providerId: 'local', modelAlias: 'local-model', catalogRevision: 'models-1' };
    expect(await call('GET', '/agent/model-options')).toEqual({ status: 200, body: {
      schemaVersion: 'acs-model-options/1', catalogRevision: 'models-1',
      items: [{ providerId: 'local', modelAlias: 'local-model', displayName: 'local-model', availability: 'AVAILABLE' }],
      defaultSelection: { providerId: 'local', modelAlias: 'local-model' },
    } });
    const frozen = { requestKey: 'original', title: 'Fixture', modelSettings };
    const lost = await call('POST', '/agent/sessions', frozen, 'original');
    expect(lost.body).toMatchObject({ state: 'UNKNOWN', requestKey: 'original', sessionId: null });
    expect(creates.size).toBe(1);
    expect(JSON.parse([...creates.values()][0]).modelSettings).toEqual(modelSettings);
    expect((await call('GET', '/agent/sessions/new-session/model-settings')).status).toBe(403);

    // Simulate resuming a pending write left by the Windows preview ledger.
    const recordKey = `${built.devices.authenticate(String(grant.accessToken)).id}:original`;
    const pending = built.store.get<{
      clientKey: string; sourceKey: string; hash: string; grantRevision: number;
      dispatchedAt: number; wire: object; state: string;
    }>('session-create', recordKey)!;
    built.store.transaction(() => {
      built!.store.put('acs-session-create', recordKey, {
        schemaVersion: 1, clientKey: pending.clientKey, sourceKey: pending.sourceKey,
        digest: pending.hash.split(':')[0], grantRevision: pending.grantRevision,
        dispatchedAt: pending.dispatchedAt, wire: pending.wire, state: pending.state,
      });
      built!.store.delete('session-create', recordKey);
    });

    await close(pac!);
    pac = undefined;
    built.store.close();
    built = buildContext(options);
    port = await startPac();
    const recovered = await call('GET', '/agent/session-requests/original');
    expect(recovered.body).toMatchObject({ state: 'OBSERVED', requestKey: 'original', sessionId: 'new-session' });
    expect(built.store.get('acs-session-create', recordKey)).toBeUndefined();
    expect(recovered.body.source).toEqual({ sessionId: 'new-session', title: 'Fixture' });
    expect(creates.size).toBe(1);
    expect((await call('POST', '/agent/sessions', { ...frozen, title: 'Different' }, 'original')).status).toBe(409);
    expect(createCalls).toBe(2);
    const phoneStore = (await call('GET', '/host')).body.storeId;
    expect((await call('GET', '/agent/sessions/new-session/foundation')).body).toMatchObject({
      sessionId: 'new-session', hostId: 'acs-host', storeId: phoneStore, sourceStoreId: 'acs-store',
    });
    const route = '/agent/sessions/new-session/model-settings';
    expect((await call('GET', route)).body.settingsRevision).toBe(1);
    const update = { expectedSettingsRevision: 1, applyPolicy: 'NEXT_SAFE_REQUEST', settings: modelSettings };
    expect((await call('PATCH', route, update)).status).toBe(400);
    expect((await call('PATCH', route, update, 'original-model-update')).body.settingsRevision).toBe(2);
    expect(settings).toEqual(update);
    expect((await call('PATCH', route, { ...update, settings: { ...modelSettings, endpoint: 'unsafe' } },
      'invalid-model-update')).status).toBe(400);

    const group = '/agent/runs/run-1/collaboration-groups/group-1';
    const operations = [
      ['/previews/preview-1/revisions', { expectedPreviewRevision: 2 }],
      ['/previews/preview-1/reviews', { previewId: 'preview-1', purpose: 'REVIEW' }],
      ['/adoptions/adoption-1/repairs', { expectedAdoptionRevision: 1 }],
      ['/repairs/repair-1/recover', { expectedRevision: 1 }],
    ] as const;
    for (const [path, body] of operations) {
      expect((await call('POST', group + path, body, 'original-collaboration-key')).status).toBe(202);
    }
    expect(collaborationWrites).toEqual(operations.map(([path, body]) => ({
      path: `/api/v2/runs/run-1/collaboration-groups/group-1${path}`, key: 'original-collaboration-key', body,
    })));
    expect((await call('POST', `${group}/previews/foreign-preview/revisions`, {}, 'bad-preview')).status).toBe(403);
    expect((await call('POST', `${group}/repairs/foreign-repair/recover`, {}, 'bad-repair')).status).toBe(403);
    expect(collaborationWrites).toHaveLength(operations.length);
    built.devices.revoke(grant.deviceGrantId as string);
    expect((await call('GET', '/agent/session-requests/original')).status).toBe(401);
  } finally {
    if (pac) await close(pac);
    built?.store.close();
    await close(upstream);
    rmSync(root, { recursive: true, force: true });
  }
});
