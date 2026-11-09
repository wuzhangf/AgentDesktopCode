/**
 * Listener tests — TLS provisioning, the phone HTTPS listener and the
 * loopback-only owner HTTP listener. Contract assertions follow Java
 * PersonalAccessServer: raw path rules, body budgets, header counts,
 * owner credentials.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as http from 'node:http';
import * as https from 'node:https';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { X509Certificate } from 'node:crypto';
import { fail } from '../src/protocol.js';
import type { Device } from '../src/protocol.js';
import type { GatewayAuth, GatewayContext } from '../src/context.js';
import { createGatewayListener, createOwnerListener, createRelayListener } from '../src/http.js';
import { certificateInfo, fingerprintOfCertPem, loadTlsMaterial, provisionTlsMaterial } from '../src/tls.js';

// ---------------------------------------------------------------------------
// TLS provisioning
// ---------------------------------------------------------------------------

describe('tls material', () => {
  let dir: string;
  beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'dg-tls-')); });
  afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

  it('provisions a self-signed cert usable by node:https', () => {
    const material = provisionTlsMaterial(dir, { commonName: 'device-gateway.test' });
    expect(material.cert.length).toBeGreaterThan(0);
    expect(material.key.length).toBeGreaterThan(0);
    const cert = new X509Certificate(material.cert);
    expect(cert.subject).toContain('device-gateway.test');
    expect(fingerprintOfCertPem(material.cert.toString('utf8'))).toBe(material.fingerprints.certSha256);
    const info = certificateInfo(material.cert.toString('utf8'));
    expect(info.notAfter).toBeGreaterThan(info.notBefore);
    expect(info.subjectAltNames.some(([, v]) => v === 'localhost')).toBe(true);
  });

  it('reloading existing material does not regenerate', () => {
    const first = provisionTlsMaterial(dir, { commonName: 'device-gateway.test' });
    const second = provisionTlsMaterial(dir, { commonName: 'device-gateway.test' });
    expect(second.cert.equals(first.cert)).toBe(true);
    const loaded = loadTlsMaterial(dir);
    expect(loaded!.cert.equals(first.cert)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Listener fixtures
// ---------------------------------------------------------------------------

const device: Device = {
  id: 'dev-1', label: 'Pixel', installationId: 'i',
  state: 'ACTIVE', scopeVersion: 1, revision: 1,
  accessExpiry: Date.now() + 60_000, absoluteExpiry: Date.now() + 60_000, idleExpiry: Date.now() + 60_000,
  recoverUntil: 0, spentRefresh: [],
  actions: ['OBSERVE'], resources: [], launchScopes: [], sessions: [],
};

const ctx = (): GatewayContext => ({
  config: { storeId: 'store-1', acsStoreId: 'acs-1', bootId: 'boot-1', origin: 'https://gw:1' },
  auth: {
    request: () => fail('INVALID_REQUEST', 400),
    observePairing: () => fail('PAIRING_UNAUTHORIZED', 401),
    redeem: () => fail('PAIRING_UNAUTHORIZED', 401),
    refresh: () => fail('INVALID_REQUEST', 400),
    authenticate: (t: string) => (t === 'dev-token' ? device : fail('ACCESS_UNAUTHORIZED', 401)),
    authorize: () => fail('DEVICE_SCOPE_DENIED', 403),
    authorizeDevice: () => device,
    authorizeLocal: () => device,
    authorizeLocalDevice: () => device,
    authorizeLaunch: () => device,
    activeDevices: () => [device],
    activeDevice: () => device,
    revoke: () => {},
    appendLaunchedTask: () => {},
    invitation: () => ({}),
    invitationResources: () => ({}),
    updateScope: () => ({}),
    updateScopeResources: () => ({}),
    devices: () => [{ deviceGrantId: 'dev-1' }],
    requests: () => [],
    ownerStatus: () => ({ enabled: true, personalHostId: 'h', storeId: 'store-1', origin: 'https://gw:1' }),
    host: (d: Device, bootId: string) => ({
      deviceGrantId: d.id, bootId, storeId: 'store-1', capabilities: { observe: true },
    }),
    ensureHost: () => {},
  } as GatewayAuth,
  inbox: {
    requestRefresh: () => {},
    scanAll: () => {},
    list: () => ({ items: [] }),
    detail: () => fail('NOT_FOUND', 404),
  },
});

interface TestResponse { status: number; body: string; headers: http.IncomingHttpHeaders }

const httpsRequest = (port: number, ca: string, opts: {
  method?: string; path: string; headers?: Record<string, string | string[]>; body?: string | Buffer;
}): Promise<TestResponse> => new Promise((resolve, reject) => {
  const req = https.request({
    host: '127.0.0.1', port, path: opts.path, method: opts.method ?? 'GET',
    ca, headers: opts.headers,
  }, (res) => {
    const chunks: Buffer[] = [];
    res.on('data', (c: Buffer) => chunks.push(c));
    res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8'), headers: res.headers }));
  });
  req.on('error', reject);
  if (opts.body !== undefined) req.write(opts.body);
  req.end();
});

const httpRequest = (port: number, opts: {
  method?: string; path: string; headers?: Record<string, string | string[]>; body?: string | Buffer;
}): Promise<TestResponse> => new Promise((resolve, reject) => {
  const req = http.request({
    host: '127.0.0.1', port, path: opts.path, method: opts.method ?? 'GET',
    headers: opts.headers,
  }, (res) => {
    const chunks: Buffer[] = [];
    res.on('data', (c: Buffer) => chunks.push(c));
    res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8'), headers: res.headers }));
  });
  req.on('error', reject);
  if (opts.body !== undefined) req.write(opts.body);
  req.end();
});

// ---------------------------------------------------------------------------
// Phone HTTPS listener
// ---------------------------------------------------------------------------

describe('loopback relay ingress', () => {
  let directory: string;
  let server: ReturnType<typeof createRelayListener>;
  let port = 0;
  let ca = '';
  beforeAll(async () => {
    directory = mkdtempSync(join(tmpdir(), 'dg-relay-'));
    const material = provisionTlsMaterial(directory, { commonName: 'localhost' });
    ca = material.cert.toString('utf8');
    server = createRelayListener({ tls: material, ctx: ctx(), port: 0 });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as { address: string; port: number };
    expect(address.address).toBe('127.0.0.1');
    port = address.port;
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
  });
  it('retains device authentication and the same PAC identity', async () => {
    expect((await httpsRequest(port, ca, { path: '/personal/v1/host' })).status).toBe(401);
    const response = await httpsRequest(port, ca, {
      path: '/personal/v1/host', headers: { authorization: 'Bearer dev-token' },
    });
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toMatchObject({ storeId: 'store-1', deviceGrantId: device.id });
  });
  it('does not turn a device credential into an owner or arbitrary proxy', async () => {
    for (const path of ['/api/v2/personal-access/status', '/api/v2/sessions']) {
      const response = await httpsRequest(port, ca, { path, headers: { authorization: 'Bearer dev-token' } });
      expect(response.status).toBe(403);
      expect(JSON.parse(response.body).code).toBe('OPERATION_NOT_ALLOWED');
    }
  });
});

describe('phone listener', () => {
  let dir: string;
  let server: ReturnType<typeof createGatewayListener>;
  let port = 0;
  let ca = '';

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'dg-http-'));
    const material = provisionTlsMaterial(dir, { commonName: 'localhost' });
    ca = material.cert.toString('utf8');
    server = createGatewayListener({
      tls: { key: material.key, cert: material.cert },
      ctx: ctx(),
      bind: '127.0.0.1',
      port: 0,
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as { port: number }).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  });

  it('missing bearer → 401 ACCESS_UNAUTHORIZED', async () => {
    const res = await httpsRequest(port, ca, { path: '/personal/v1/host' });
    expect(res.status).toBe(401);
    expect(JSON.parse(res.body).code).toBe('ACCESS_UNAUTHORIZED');
  });

  it('duplicate Authorization headers → 401 (Java exactly-one rule)', async () => {
    const res = await httpsRequest(port, ca, {
      path: '/personal/v1/host',
      headers: { authorization: ['Bearer dev-token', 'Bearer dev-token'] },
    });
    expect(res.status).toBe(401);
  });

  it('valid bearer → host view with merged capabilities', async () => {
    const res = await httpsRequest(port, ca, {
      path: '/personal/v1/host',
      headers: { authorization: 'Bearer dev-token' },
    });
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.deviceGrantId).toBe('dev-1');
    expect(body.bootId).toBe('boot-1');
    expect(body.capabilities).toMatchObject({
      executionPolicy: true, manageExecutionPolicy: false,
      localTasks: false, launch: false, inbox: true, notifications: false,
    });
  });

  it('unknown authenticated path → 403 OPERATION_NOT_ALLOWED (Java rule)', async () => {
    const res = await httpsRequest(port, ca, {
      path: '/totally/unknown',
      headers: { authorization: 'Bearer dev-token' },
    });
    expect(res.status).toBe(403);
    expect(JSON.parse(res.body).code).toBe('OPERATION_NOT_ALLOWED');
  });

  it('malformed JSON on a body route → 400 INVALID_REQUEST', async () => {
    const res = await httpsRequest(port, ca, {
      method: 'POST', path: '/personal/v1/pairing-requests',
      headers: { 'content-type': 'application/json', 'content-length': '4' },
      body: '{bad',
    });
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body).code).toBe('INVALID_REQUEST');
  });

  it('body over the 65536 route budget → 413 BODY_TOO_LARGE', async () => {
    const big = Buffer.alloc(70_000, 65);
    const res = await httpsRequest(port, ca, {
      method: 'POST', path: '/personal/v1/pairing-requests',
      headers: { 'content-type': 'application/json', 'content-length': String(big.length) },
      body: big,
    });
    expect(res.status).toBe(413);
    expect(JSON.parse(res.body).code).toBe('BODY_TOO_LARGE');
  });

  it('raw path with % → 400 INVALID_REQUEST (undecoded guard)', async () => {
    const res = await httpsRequest(port, ca, {
      path: '/personal/v1/host%20',
      headers: { authorization: 'Bearer dev-token' },
    });
    expect(res.status).toBe(400);
  });

  it('error body is application/json {code,detail} + no-store/nosniff', async () => {
    const res = await httpsRequest(port, ca, { path: '/personal/v1/host' });
    expect(res.headers['content-type']).toContain('application/json');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(JSON.parse(res.body)).toEqual({ code: 'ACCESS_UNAUTHORIZED', detail: 'ACCESS_UNAUTHORIZED' });
  });

  it('explicit bind/port are required', () => {
    expect(() => createGatewayListener({
      tls: { key: 'k', cert: 'c' }, ctx: ctx(), bind: '', port: 1,
    })).toThrow(/bind/);
    expect(() => createGatewayListener({
      tls: { key: 'k', cert: 'c' }, ctx: ctx(), bind: '127.0.0.1', port: 65_536,
    })).toThrow(/port/);
  });
});

// ---------------------------------------------------------------------------
// Owner loopback HTTP listener
// ---------------------------------------------------------------------------

describe('owner listener', () => {
  let server: ReturnType<typeof createOwnerListener>;
  let port = 0;

  beforeAll(async () => {
    server = createOwnerListener({
      ctx: ctx(),
      ownerToken: 'owner-tok',
      ownerClientToken: 'client-tok',
      bind: '127.0.0.1',
      port: 0,
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as { port: number }).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('requires Authorization + X-Client-Session', async () => {
    const missingAll = await httpRequest(port, { path: '/api/v2/personal-access/devices' });
    expect(missingAll.status).toBe(401);
    const missingSession = await httpRequest(port, {
      path: '/api/v2/personal-access/devices',
      headers: { authorization: 'Bearer owner-tok' },
    });
    expect(missingSession.status).toBe(401);
    const wrongSession = await httpRequest(port, {
      path: '/api/v2/personal-access/devices',
      headers: { authorization: 'Bearer owner-tok', 'x-client-session': 'nope' },
    });
    expect(wrongSession.status).toBe(401);
  });

  it('valid credentials → owner devices list', async () => {
    const res = await httpRequest(port, {
      path: '/api/v2/personal-access/devices',
      headers: { authorization: 'Bearer owner-tok', 'x-client-session': 'client-tok' },
    });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual([{ deviceGrantId: 'dev-1' }]);
  });

  it('Java header spelling X-CodeAgent-Client-Token also accepted', async () => {
    const res = await httpRequest(port, {
      path: '/api/v2/personal-access/devices',
      headers: { authorization: 'Bearer owner-tok', 'x-codeagent-client-token': 'client-tok' },
    });
    expect(res.status).toBe(200);
  });

  it('rejects a non-loopback bind and missing credentials at construction', () => {
    expect(() => createOwnerListener({
      ctx: ctx(), ownerToken: 't', ownerClientToken: 'c', bind: '10.0.0.5', port: 0,
    })).toThrow(/loopback/);
    expect(() => createOwnerListener({
      ctx: ctx(), ownerToken: '', ownerClientToken: 'c', bind: '127.0.0.1', port: 0,
    })).toThrow(/ownerToken/);
    expect(() => createOwnerListener({
      ctx: ctx(), ownerToken: 't', ownerClientToken: '', bind: '127.0.0.1', port: 0,
    })).toThrow(/ownerClientToken/);
  });
});
