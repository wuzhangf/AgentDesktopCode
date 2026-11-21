import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { request } from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { buildContext, type BuiltGateway } from '../src/gateway-main.js';
import { createGatewayListener, createOwnerListener } from '../src/http.js';
import { LocalSchedules } from '../src/local-schedules.js';
import type { LocalTaskAccess } from '../src/local-tasks.js';
import { hash, secret, type Device } from '../src/protocol.js';
import { provisionTlsMaterial } from '../src/tls.js';

const target = { backendStoreId: 'native-schedule-store', projectId: 'workspace', engineId: 'codex' };
const input = { target, requestKey: 'schedule-1', instruction: 'Write a sandbox marker',
  timezone: 'UTC', schedule: { kind: 'interval', everySeconds: 300 } };
const ownerRoot = '/api/v2/personal-access';
const phoneRoot = '/personal/v1';
const rulePath = '/local-schedules';
const ownerHeaders = { Authorization: 'Bearer fixture-owner', 'X-Client-Session': 'fixture-client' };
type Json = Record<string, unknown>;

async function listen(server: Server): Promise<number> {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

it('enforces explicit per-phone schedule grants through native dispatch and receipt recovery', async () => {
  const root = mkdtempSync(join(tmpdir(), 'link-phone-schedules-'));
  const tls = provisionTlsMaterial(join(root, 'tls'), { commonName: 'localhost' });
  const receipts = new Map<string, string>();
  let preflight: (() => Promise<void>) | undefined;
  let preflightError: unknown;
  let dropReceipt = false;
  let submissions = 0;
  let now = Date.now();
  let built: BuiltGateway | undefined;
  let owner: Server | undefined;
  let phone: Server | undefined;
  const worker = createServer(async (req, res) => {
    function respond(status: number, body: object) {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    }
    if (req.headers.authorization !== 'Bearer fixture-worker') return respond(401, {});
    if (req.url === '/local/v1/identity') return respond(200, { storeId: target.backendStoreId, storeGuard: 'HEADER_V1' });
    if (req.url === '/local/v1/projects') return respond(200, { items: [{ projectId: target.projectId }] });
    if (req.url === '/local/v1/engines') return respond(200, { items: [{ engineId: target.engineId }] });
    if (req.url === '/local/v1/task-preflights') {
      const hook = preflight;
      preflight = undefined;
      try { await hook?.(); }
      catch (error) { preflightError = error; return respond(500, { code: 'PREFLIGHT_HOOK_FAILED' }); }
      return respond(200, { optionsRevision: 'options-1' });
    }
    const receipt = (requestKey: string, taskId: string) => ({
      requestKey, taskId, operation: 'LAUNCH', state: 'ACCEPTED', result: { taskId, engineId: target.engineId },
    });
    if (req.url === '/local/v1/tasks' && req.method === 'POST') {
      submissions++;
      const key = String(req.headers['idempotency-key']);
      const taskId = `native-scheduled-${receipts.size + 1}`;
      receipts.set(key, taskId);
      if (dropReceipt) return res.destroy();
      return respond(201, receipt(key, taskId));
    }
    if (req.url?.startsWith('/local/v1/task-requests/')) {
      const key = req.url.split('/').at(-1)!;
      const taskId = receipts.get(key);
      if (taskId) return respond(200, receipt(key, taskId));
    }
    if (req.url?.startsWith('/local/v1/tasks/native-scheduled-')) {
      return respond(200, { taskId: req.url.split('/').at(-1), state: 'SUCCEEDED' });
    }
    return respond(404, { code: 'NOT_FOUND' });
  });

  try {
    const sourcePort = await listen(worker);
    const options = { dataDir: join(root, 'store'), storeKey: randomBytes(32), tls, bind: '127.0.0.1', port: 9443,
      ownerBind: '127.0.0.1', ownerPort: 0, ownerToken: 'fixture-owner', ownerClientToken: 'fixture-client',
      localCliOnly: true, workerLocal: { connectionId: 'native-worker', url: `http://127.0.0.1:${sourcePort}`, token: 'fixture-worker' } };
    async function start() {
      built = buildContext(options);
      built.ctx.localSchedules = new LocalSchedules(built.store, String(built.devices.ownerStatus().personalHostId),
        built.ctx.localTasks as LocalTaskAccess, built.ctx.updatePreparation, () => now, built.devices);
      owner = createOwnerListener({ ctx: built.ctx, bind: '127.0.0.1', port: 0,
        ownerToken: options.ownerToken, ownerClientToken: options.ownerClientToken });
      phone = createGatewayListener({ ctx: built.ctx, tls, bind: '127.0.0.1', port: 0 });
      [ownerPort, phonePort] = await Promise.all([listen(owner), listen(phone)]);
    }
    let ownerPort = 0, phonePort = 0;
    await start();
    const scheduler = () => built!.ctx.localSchedules!;
    function pair(name: string) {
      const devices = built!.devices;
      const invite = devices.invitationResources(`invite-${name}`, [], [target], ['OBSERVE', 'LAUNCH'], 'fixture-pin');
      const poll = secret();
      devices.request({ pairingRequestId: name, inviteId: invite.inviteId, inviteSecret: invite.inviteSecret,
        pollingSecretHash: hash(poll), installationId: name, label: name });
      devices.decide(name, true);
      const issued = devices.redeem(name, poll, `redeem-${name}`);
      const token = String(issued.accessToken);
      return { id: devices.authenticate(token).id, token };
    }
    const first = pair('first');
    const second = pair('second');
    async function ownerCall(method: string, path: string, body?: object) {
      const response = await fetch(`http://127.0.0.1:${ownerPort}${ownerRoot}${path}`, {
        method, headers: { ...ownerHeaders, 'Content-Type': 'application/json' },
        ...(body && { body: JSON.stringify(body) }), signal: AbortSignal.timeout(2500),
      });
      return { status: response.status, body: response.status === 204 ? {} : await response.json() as Json };
    }
    function phoneCall(method: string, path: string, token?: string, body?: object) {
      return new Promise<{ status: number; body: Json }>((resolve, reject) => {
        const req = request({ hostname: '127.0.0.1', port: phonePort, path: phoneRoot + path, method, ca: tls.cert,
          headers: { ...(token && { Authorization: `Bearer ${token}` }), 'Content-Type': 'application/json' },
          signal: AbortSignal.timeout(2500) }, res => {
          const chunks: Buffer[] = [];
          res.on('data', chunk => chunks.push(chunk));
          res.on('end', () => resolve({ status: res.statusCode!, body: JSON.parse(Buffer.concat(chunks).toString()) }));
        });
        req.on('error', reject);
        req.end(body && JSON.stringify(body));
      });
    }

    const grantPath = (device: typeof first) => `/devices/${device.id}/local-schedule-grant`;
    const putGrant = (device: typeof first, expectedRevision: number, launchScopes = [target]) =>
      ownerCall('PUT', grantPath(device), { expectedRevision, launchScopes });
    expect((await phoneCall('GET', rulePath)).status).toBe(401);
    expect((await phoneCall('POST', rulePath, first.token, input)).status).toBe(403);
    expect((await phoneCall('GET', '/host', first.token)).body.capabilities).toMatchObject({ localSchedules: false });
    const forgedOwner = await fetch(`http://127.0.0.1:${ownerPort}${ownerRoot}${grantPath(first)}`, {
      method: 'PUT', headers: { Authorization: `Bearer ${first.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ expectedRevision: 0, launchScopes: [target] }), signal: AbortSignal.timeout(2500),
    });
    expect(forgedOwner.status).toBe(401);
    expect((await ownerCall('GET', grantPath(first))).body).toEqual({ revision: 0, launchScopes: [] });
    expect((await putGrant(first, 0, [{ ...target, projectId: 'outside-scope' }])).status).toBe(403);
    expect((await putGrant(first, 0)).status).toBe(200);
    expect((await putGrant(second, 0)).status).toBe(200);
    expect((await putGrant(first, 0, [])).status).toBe(409);
    expect((await phoneCall('GET', '/host', first.token)).body.capabilities).toMatchObject({ localSchedules: true });
    expect((await phoneCall('POST', rulePath, first.token, { ...input, target: { ...target, projectId: 'outside-scope' } })).status)
      .toBe(403);
    const one = await phoneCall('POST', rulePath, first.token, input);
    const two = await phoneCall('POST', rulePath, second.token, input);
    expect(one.status).toBe(201);
    expect(two.status).toBe(201);
    expect(one.body.ruleId).not.toBe(two.body.ruleId);
    expect(await phoneCall('POST', rulePath, first.token, input)).toEqual(one);
    const onePath = `${rulePath}/${one.body.ruleId}`;
    expect((await phoneCall('GET', rulePath, first.token)).body).toMatchObject({ items: [one.body], targets: [target] });
    expect((await phoneCall('GET', onePath + '/occurrences', second.token)).status).toBe(404);
    expect((await phoneCall('PUT', onePath, second.token, { expectedRevision: 1, paused: true })).status).toBe(404);
    const ownerRule = await ownerCall('POST', rulePath, input);
    expect(ownerRule.status).toBe(201);
    expect(built!.store.list('local-schedule-rules')).toMatchObject([{ ruleId: ownerRule.body.ruleId }]);
    expect((await phoneCall('GET', rulePath, first.token)).body.items).toEqual([one.body]);
    expect((await ownerCall('PUT', `${rulePath}/${two.body.ruleId}`, { expectedRevision: 1, paused: true })).status).toBe(200);
    expect((await ownerCall('PUT', `${rulePath}/${ownerRule.body.ruleId}`, { expectedRevision: 1, paused: true })).status).toBe(200);

    preflight = async () => {
      const scope = `/devices/${first.id}/scope`;
      expect((await ownerCall('PUT', scope, { requestId: 'remove-launch', expectedGrantRevision: '1',
        resources: [], launchScopes: [], actions: ['OBSERVE'] })).status).toBe(200);
      expect((await ownerCall('PUT', scope, { requestId: 'restore-launch', expectedGrantRevision: '2',
        resources: [], launchScopes: [target], actions: ['OBSERVE', 'LAUNCH'] })).status).toBe(200);
    };
    now += 300_000;
    await scheduler().tick();
    expect(preflightError).toBeUndefined();
    expect(submissions).toBe(0);
    expect((await ownerCall('GET', onePath + '/occurrences')).body).toMatchObject({
      items: [{ state: 'cancelled', code: 'SCHEDULE_GRANT_REQUIRED' }],
    });
    expect((await phoneCall('GET', rulePath, first.token)).status).toBe(403);
    expect((await putGrant(first, 2)).status).toBe(200);
    expect((await phoneCall('GET', onePath, first.token)).body).toMatchObject({ authorizationRequired: true, nextFireAt: null });
    now += 300_000;
    await scheduler().tick();
    expect(submissions).toBe(0);
    expect((await phoneCall('PUT', onePath, first.token, { expectedRevision: 1, paused: false })).body)
      .toMatchObject({ authorizationRequired: false, nextFireAt: new Date(now + 300_000).toISOString() });
    now += 300_000;
    await scheduler().tick();
    expect(submissions).toBe(1);
    expect(built!.devices.authorizeLocal(first.token, target.backendStoreId, 'native-scheduled-1', 'OBSERVE').id).toBe(first.id);
    expect((await phoneCall('GET', '/local-tasks', first.token)).body).toMatchObject({
      resources: [{ backendStoreId: target.backendStoreId, taskId: 'native-scheduled-1' }],
    });
    expect(() => built!.devices.authorizeLocal(second.token, target.backendStoreId, 'native-scheduled-1', 'OBSERVE'))
      .toThrowError('DEVICE_SCOPE_DENIED');

    dropReceipt = true;
    now += 300_000;
    await scheduler().tick();
    expect(submissions).toBe(2);
    expect(built!.store.list('local-schedule-active')).toEqual([]);
    expect(built!.store.list('local-schedule-phone-active')).toEqual(expect.arrayContaining([
      expect.objectContaining({ ruleId: one.body.ruleId, state: 'submitting' }),
    ]));
    expect((await putGrant(first, 3, [])).status).toBe(200);
    expect((await phoneCall('GET', onePath + '/occurrences', first.token)).status).toBe(403);
    await Promise.all([close(phone!), close(owner!)]);
    phone = undefined;
    owner = undefined;
    built!.store.close();
    built = undefined;
    await start();
    await scheduler().tick();
    await scheduler().tick();
    expect((await ownerCall('GET', onePath + '/occurrences')).body).toMatchObject({
      items: [{ state: 'succeeded', taskId: 'native-scheduled-2', sequence: 3 },
        { state: 'succeeded', taskId: 'native-scheduled-1', sequence: 2 }, { state: 'cancelled', sequence: 1 }],
    });
    expect(() => built!.devices.authorizeLocal(first.token, target.backendStoreId, 'native-scheduled-2', 'OBSERVE'))
      .toThrowError('DEVICE_SCOPE_DENIED');
    const secondPath = `${rulePath}/${two.body.ruleId}`;
    // A downgraded gateway updates the ordinary revision without the schedule
    // marker. Even identical launch scopes require fresh consent on return.
    const beforeDowngrade = built!.store.get<Device>('device', second.id)!;
    built!.store.put('device', second.id, { ...beforeDowngrade, revision: beforeDowngrade.revision + 1 });
    expect((await phoneCall('GET', '/host', second.token)).body.capabilities).toMatchObject({ localSchedules: false });
    expect((await ownerCall('GET', grantPath(second))).body).toEqual({ revision: 1, launchScopes: [] });
    expect((await putGrant(second, 1)).status).toBe(200);
    expect((await phoneCall('PUT', secondPath, second.token, { expectedRevision: 2, paused: false })).status).toBe(200);
    expect((await ownerCall('DELETE', `/devices/${second.id}`)).status).toBe(204);
    now += 300_000;
    await scheduler().tick();
    expect(submissions).toBe(2);
    expect((await phoneCall('GET', secondPath, second.token)).status).toBe(401);
    expect((await ownerCall('GET', secondPath)).body).toMatchObject({ authorizationRequired: true, nextFireAt: null });
  } finally {
    if (phone) await close(phone);
    if (owner) await close(owner);
    built?.store.close();
    if (worker.listening) await close(worker);
    rmSync(root, { recursive: true, force: true });
  }
});
