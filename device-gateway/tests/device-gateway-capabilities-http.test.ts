/** Real HTTP owner consumer → production context/catalog → fixture worker HTTP. */
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildContext, type BuiltGateway } from '../src/gateway-main.js';
import { createOwnerListener } from '../src/http.js';
import { provisionTlsMaterial } from '../src/tls.js';

async function worker(storeId: string, engineId: string, online = true) {
  const server = createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.headers.authorization !== 'Bearer fixture-worker-token') { res.writeHead(401); res.end('{}'); return; }
    if (!online) { res.writeHead(503); res.end('{"code":"OFFLINE"}'); return; }
    const body = req.url === '/local/v1/identity' ? { storeId, storeGuard: 'HEADER_V1' }
      : req.url === '/local/v1/projects' ? { items: [{ projectId: `${engineId}-workspace`, recipeID: 'office-recipe',
        availability: 'UNAVAILABLE', reasonCode: 'OFFICE_DIRECTORY_IDENTITY_CHANGED',
        workspace: '/private/fixture-workspace', env: { PRIVATE_TEST_VALUE: 'must-not-leak' } }] }
      : req.url === '/local/v1/engines' ? { items: [{ engineId, available: true, executable: '/private/fixture-engine' }] }
      : { code: 'NOT_FOUND' };
    res.end(JSON.stringify(body));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}
async function close(server: Server) {
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

describe('owner capabilities over HTTP', () => {
  it.each(['primary-only', 'primary-and-companions', 'offline-companions'] as const)(
    'serializes public catalogs with %s', async mode => {
      const root = mkdtempSync(join(tmpdir(), 'gateway-capabilities-http-'));
      const upstreams: Server[] = [];
      let owner: Server | undefined;
      let built: BuiltGateway | undefined;
      try {
        const primary = await worker('store-mac', 'macos'); upstreams.push(primary.server);
        const extras = [];
        if (mode !== 'primary-only') for (const engine of ['pi', 'codex']) {
          const source = await worker(`store-${engine}`, engine, mode !== 'offline-companions');
          upstreams.push(source.server);
          extras.push({ connectionId: `managed-${engine}`, url: source.url, token: 'fixture-worker-token' });
        }
        built = buildContext({ dataDir: join(root, 'store'), storeKey: randomBytes(32), tls: provisionTlsMaterial(join(root, 'tls'), { commonName: 'localhost' }),
          bind: '127.0.0.1', port: 9443, ownerBind: '127.0.0.1', ownerPort: 0, origin: 'https://192.0.2.41:9443',
          ownerToken: 'fixture-owner-token', ownerClientToken: 'fixture-client-token',
          workerLocal: { connectionId: 'this-mac', url: primary.url, token: 'fixture-worker-token' }, extraWorkerLocals: extras });
        owner = createOwnerListener({ ctx: built.ctx, ownerToken: 'fixture-owner-token',
          ownerClientToken: 'fixture-client-token', bind: '127.0.0.1', port: 0 });
        await new Promise<void>(resolve => owner!.listen(0, '127.0.0.1', resolve));
        const url = `http://127.0.0.1:${(owner.address() as AddressInfo).port}/api/v2/personal-access/capabilities`;
        expect((await fetch(url)).status).toBe(401);
        for (let refresh = 0; refresh < 2; refresh++) {
          const response = await fetch(url, { headers: { Authorization: 'Bearer fixture-owner-token',
            'X-CodeAgent-Client-Token': 'fixture-client-token' }, signal: AbortSignal.timeout(2000) });
          expect(response.status).toBe(200);
          const text = await response.text(); const body = JSON.parse(text);
          expect(body).toMatchObject({ enabled: true, resourceScopeVersion: 2, localSource: { available: true,
            backendStoreId: 'store-mac', projects: [{ projectId: 'macos-workspace', recipeID: 'office-recipe',
              availability: 'UNAVAILABLE', reasonCode: 'OFFICE_DIRECTORY_IDENTITY_CHANGED' }], engines: [{ engineId: 'macos' }] } });
          expect(body.supportedActions).toContain('LAUNCH');
          if (mode === 'primary-and-companions') {
            const stores = body.localSource.backends.map((row: { backendStoreId: string }) => row.backendStoreId);
            expect(stores[0]).toBe('store-mac');
            expect(stores.slice(1).sort()).toEqual(['store-codex', 'store-pi']);
            expect(body.localSource.backends[0].projects).toEqual(body.localSource.projects);
            expect(body.localSource.backends.every((row: object) => !('backends' in row))).toBe(true);
          } else { expect(body.localSource.backends).toBeUndefined(); }
          for (const secret of ['fixture-worker-token', 'fixture-owner-token', 'fixture-client-token', 'must-not-leak',
            '/private/fixture-workspace', '/private/fixture-engine']) expect(text).not.toContain(secret);
        }
      } finally {
        if (owner) await close(owner);
        built?.store.close();
        for (const server of upstreams) await close(server);
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
});
