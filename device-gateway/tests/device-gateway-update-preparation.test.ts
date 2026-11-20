import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { request } from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { buildContext, type BuiltGateway } from '../src/gateway-main.js';
import { createGatewayListener, createHooksListener, createOwnerListener, createRelayListener } from '../src/http.js';
import { hash, secret } from '../src/protocol.js';
import { provisionTlsMaterial } from '../src/tls.js';

const root = '/api/v2/personal-access/update-preparation';
const port = (server: Server): number => (server.address() as AddressInfo).port;
async function listen(server: Server) {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
}

it('reserves idle workers and gates owner, phone, relay and hook intake', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'gateway-update-'));
  const servers: Server[] = [];
  let gateway: BuiltGateway | undefined;
  const reservations = new Map<string, string>();
  let busyWorker = true;
  let replaceWorker = false;
  const worker = (storeId: string) => createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json');
    const bootId = replaceWorker && storeId === 'worker-two' && reservations.has(storeId) ? 'restarted' : 'boot';
    if (req.url === '/local/v1/identity') {
      res.end(JSON.stringify({ storeId, bootId, storeGuard: 'HEADER_V1' }));
      return;
    }
    if (req.headers['x-worker-local-store'] !== storeId || !req.url?.startsWith('/local/v1/update-reservation')) {
      res.writeHead(404).end('{}');
      return;
    }
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const { operationId } = JSON.parse(raw);
    const response = { schemaVersion: 'worker-update-reservation/1', storeId, bootId, operationId };
    if (req.url.endsWith('/release')) {
      reservations.delete(storeId);
      res.end(JSON.stringify({ ...response, state: 'released' }));
    } else if (storeId === 'worker-two' && busyWorker) {
      res.end(JSON.stringify({ ...response, state: 'busy' }));
    } else {
      reservations.set(storeId, operationId);
      res.end(JSON.stringify({ ...response, state: 'held', expiresAt: Date.now() + 30_000 }));
    }
  });
  try {
    const first = worker('worker-one');
    const second = worker('worker-two');
    servers.push(first, second);
    await Promise.all([listen(first), listen(second)]);
    const tls = provisionTlsMaterial(join(directory, 'tls'), { commonName: 'localhost' });
    gateway = buildContext({
      dataDir: join(directory, 'store'), storeKey: randomBytes(32), tls, bind: '127.0.0.1', port: 9443,
      ownerBind: '127.0.0.1', ownerPort: 0, ownerToken: 'fixture-owner', ownerClientToken: 'fixture-session',
      localCliOnly: true,
      workerLocal: { connectionId: 'first', url: 'http://127.0.0.1:' + port(first), token: 'worker-one' },
      extraWorkerLocals: [{ connectionId: 'second', url: 'http://127.0.0.1:' + port(second), token: 'worker-two' }],
    });
    const listener = { ctx: gateway.ctx, bind: '127.0.0.1', port: 0 };
    const owner = createOwnerListener({ ...listener, ownerToken: 'fixture-owner', ownerClientToken: 'fixture-session' });
    const hooks = createHooksListener({ ...listener, hooksToken: 'fixture-hooks' });
    const phone = createGatewayListener({ ...listener, tls });
    const relay = createRelayListener({ ...listener, tls });
    servers.push(owner, hooks, phone, relay);
    await Promise.all([listen(owner), listen(hooks), listen(phone), listen(relay)]);
    const invite = gateway.devices.invitationResources('fixture-invite', [], [
      { backendStoreId: 'worker-one', projectId: 'workspace', engineId: 'codex' },
    ], ['OBSERVE', 'LAUNCH', 'APPROVE'], 'fixture-pin');
    const polling = secret();
    gateway.devices.request({ pairingRequestId: 'fixture-pair', inviteId: invite.inviteId,
      inviteSecret: invite.inviteSecret, pollingSecretHash: hash(polling), installationId: 'phone', label: 'Phone' });
    gateway.devices.decide('fixture-pair', true);
    const device = gateway.devices.redeem('fixture-pair', polling, 'fixture-redeem');

    const local = async (server: Server, path: string, bearer: string, body?: unknown, clientToken?: string) => {
      const response = await fetch('http://127.0.0.1:' + port(server) + path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { authorization: 'Bearer ' + bearer, 'content-type': 'application/json',
          ...(clientToken ? { 'x-client-session': clientToken } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: response.status, body: await response.json() as Record<string, unknown> };
    };
    const control = (path: string, body?: unknown) => local(owner, path, 'fixture-owner', body, 'fixture-session');
    const callPhone = (server: Server, path: string, body?: object) => new Promise<{
      status: number; body: Record<string, unknown>;
    }>((resolve, reject) => {
      const req = request({ hostname: '127.0.0.1', port: port(server), path, ca: tls.cert,
        method: body ? 'POST' : 'GET',
        headers: { authorization: 'Bearer ' + device.accessToken, 'content-type': 'application/json' },
      }, res => {
        let text = '';
        res.on('data', chunk => { text += chunk; });
        res.on('end', () => resolve({ status: res.statusCode!, body: JSON.parse(text) }));
      });
      req.on('error', reject);
      req.end(body ? JSON.stringify(body) : undefined);
    });

    const operation = { operationId: 'update-run' };
    expect((await local(owner, root, 'fixture-owner', operation)).status).toBe(401);
    gateway.ctx.startupUpdate = { operationId: operation.operationId, ready: false };
    expect((await local(owner, root, 'fixture-owner')).status).toBe(401);
    expect(await control(root)).toMatchObject({
      status: 200, body: { state: 'starting', operationId: operation.operationId, ready: false },
    });
    gateway.ctx.startupUpdate.ready = true;
    expect((await control(root)).body).toMatchObject({
      ready: true, storeId: gateway.ctx.config.storeId, personalHostId: expect.any(String), deviceCount: 1,
    });
    expect((await control(root + '/release', operation)).status).toBe(503);
    expect((await control('/api/v2/personal-access/link-state')).status).toBe(503);
    expect((await local(hooks, '/hooks/v1/enabled', 'fixture-hooks')).status).toBe(503);
    for (const ingress of [phone, relay]) {
      expect((await callPhone(ingress, '/personal/v1/host')).status).toBe(503);
    }
    delete gateway.ctx.startupUpdate;

    const requestApproval = { approvalId: 'fixture-approval', agent: 'codex', toolName: 'apply_patch', question: 'Proceed?' };
    expect((await local(hooks, '/hooks/v1/approvals', 'fixture-hooks', requestApproval)).status).toBe(201);
    expect((await control(root, operation)).body.reason).toBe('PENDING_APPROVAL');
    await local(hooks, '/hooks/v1/approvals/fixture-approval/cancel', 'fixture-hooks', {});

    const finish = gateway.ctx.updatePreparation!.admit();
    expect((await control(root, operation)).body.reason).toBe('GATEWAY_ACTIVITY');
    finish();

    expect((await control(root, operation)).body.reason).toBe('WORKER_ACTIVITY');
    expect(reservations.size).toBe(0);
    busyWorker = false;
    replaceWorker = true;
    expect((await control(root, operation)).body.reason).toBe('WORKER_UNCONFIRMED');
    expect(reservations.size).toBe(0);
    replaceWorker = false;
    expect((await control(root, operation)).body).toMatchObject({ state: 'held', workerCount: 2 });
    expect((await control(root + '/release', { operationId: 'other' })).status).toBe(409);

    for (const ingress of [phone, relay]) {
      expect((await callPhone(ingress, '/personal/v1/host')).body.maintenance).toBe('INSTALLING_UPDATE');
      const reply = await callPhone(ingress, '/personal/v1/local-tasks/worker-one/tasks', {});
      expect(reply).toMatchObject({ status: 503, body: { code: 'UPDATE_IN_PROGRESS' } });
    }
    expect((await local(hooks, '/hooks/v1/approvals', 'fixture-hooks', requestApproval)).status).toBe(503);
    expect((await control(root + '/release', operation)).body.state).toBe('idle');
    expect(reservations.size).toBe(0);
    expect((await callPhone(phone, '/personal/v1/host')).body.maintenance).toBeUndefined();
  } finally {
    for (const server of servers.reverse()) {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
    gateway?.store.close();
    rmSync(directory, { recursive: true, force: true });
  }
}, 15_000);
