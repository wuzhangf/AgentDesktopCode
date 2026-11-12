import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { GatewayStore } from '../src/store.js';
import { buildContext, type GatewayBootstrapOptions } from '../src/gateway-main.js';
import { normalizeScope, type Device, type ScopeRecord } from '../src/protocol.js';
import {
  allows,
  checkedLaunchScopes,
  checkedResources,
  parseScope,
  scopeFingerprint,
  validateResourceActions,
  validateScope,
} from '../src/scope.js';

let dir: string;
let store: GatewayStore;

const acsRes = (sessionId: string, backend = 'pa-test') => ({ kind: 'ACS_SESSION', backendStoreId: backend, sessionId });
const localRes = (taskId: string, backend = 'wl-1') => ({ kind: 'WORKER_LOCAL', backendStoreId: backend, taskId });
const launch = (engineId: string, projectId = 'p1', backend = 'wl-1') => ({ backendStoreId: backend, projectId, engineId });

const deviceFixture = (id: string, over: Partial<Device> = {}): Device => ({
  id,
  state: 'ACTIVE',
  scopeVersion: 2,
  revision: 1,
  accessExpiry: Date.now() + 1000,
  absoluteExpiry: Date.now() + 1000,
  idleExpiry: Date.now() + 1000,
  recoverUntil: 0,
  spentRefresh: [],
  resources: [],
  launchScopes: [],
  actions: ['OBSERVE'],
  ...over,
});

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dgw-'));
  store = new GatewayStore(dir);
});

afterEach(() => {
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('migrations', () => {
  it('releases the store when context assembly fails', () => {
    store.close();
    expect(() => buildContext({dataDir: dir, storeKey: new Uint8Array(32),
      tls: {cert: Buffer.from('invalid certificate')}} as GatewayBootstrapOptions)).toThrow();
    store = new GatewayStore(dir);
  });

  it('the writer lock is shared across processes and released after an abrupt exit', async () => {
    store.close();
    const child = spawn(process.execPath, ['-e', `
      const {DatabaseSync} = require('node:sqlite');
      const lock = new DatabaseSync(process.argv[1]);
      lock.exec('BEGIN EXCLUSIVE; CREATE TABLE IF NOT EXISTS owner_lock(id INTEGER)');
      process.stdout.write('locked');
      setInterval(() => {}, 1000);
    `, path.join(dir, 'device-gateway-writer.db')], {stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true});
    const exited = once(child, 'exit');
    try {
      await Promise.race([once(child.stdout, 'data'), exited.then(() => {throw new Error('lock helper exited early');})]);
      expect(() => new GatewayStore(dir)).toThrowError(/GATEWAY_STORE_IN_USE/);
    } finally {
      child.kill();
      await exited;
    }
    store = new GatewayStore(dir);
  });

  it('refuses unknown schemas without rewriting records and releases its writer lock', () => {
    store.put('host', 'identity', {storeId: 'preserved'});
    const future = store.schemaVersion() + 1;
    store.db.prepare('INSERT INTO migrations VALUES(?,?,?)').run(future, 'future', '2026-10-29');
    store.close();
    expect(() => new GatewayStore(dir)).toThrowError(/GATEWAY_SCHEMA_UNSUPPORTED/);
    // Inspect through a raw connection: unsupported opens must leave data alone.
    const db = new DatabaseSync(path.join(dir, 'device-gateway.db'));
    try {
      expect(JSON.parse((db.prepare("SELECT payload FROM personal_access_record WHERE kind='host'").get() as {payload: string}).payload))
        .toEqual({storeId: 'preserved'});
      db.prepare('DELETE FROM migrations WHERE version=?').run(future);
    } finally { db.close(); }
    store = new GatewayStore(dir);
    expect(store.get('host', 'identity')).toEqual({storeId: 'preserved'});
  });

  it('rejects a concurrent ledger writer and allows reopening after close', () => {
    expect(() => new GatewayStore(dir)).toThrowError(/GATEWAY_STORE_IN_USE/);
    store.close();
    store = new GatewayStore(dir);
    expect(store.schemaVersion()).toBe(2);
  });

  it('applies versioned steps and reports schemaVersion', () => {
    expect(store.schemaVersion()).toBe(2);
    const rows = store.db.prepare('SELECT version, name FROM migrations ORDER BY version').all() as { name: string }[];
    expect(rows.map((r) => r.name)).toEqual(['device-gateway-core', 'personal-access-model']);
    const tables = (store.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[])
      .map((r) => r.name);
    expect(tables).toContain('personal_access_record');
    expect(tables).toContain('personal_access_record_order');
    expect(tables).toContain('personal_access_sequence');
    expect(tables).toContain('registry_connections');
    // the invented specialized tables are gone
    expect(tables).not.toContain('records');
    expect(tables).not.toContain('device_requests');
    expect(tables).not.toContain('device_inbox_items');
    expect(tables).not.toContain('device_source_cursors');
    expect(tables).not.toContain('device_list_revisions');
  });
});

describe('generic records', () => {
  it('put/get/list/delete round-trips per kind', () => {
    store.put('host', 'identity', { id: 'h1', storeId: 'pa-x' });
    expect(store.get<{ storeId: string }>('host', 'identity')?.storeId).toBe('pa-x');

    store.put('pairing', 'p1', { id: 'p1', resources: [], launchScopes: [] });
    store.put('pairing', 'p2', { id: 'p2', resources: [], launchScopes: [] });
    expect(store.list<{ id: string }>('pairing').map((p) => p.id)).toEqual(['p1', 'p2']);

    store.put('device', 'd1', deviceFixture('d1'));
    expect(store.get<Device>('device', 'd1')?.state).toBe('ACTIVE');

    store.delete('pairing', 'p1');
    expect(store.get('pairing', 'p1')).toBeUndefined();
    expect(store.list('pairing')).toHaveLength(1);
    expect(store.get('device', 'd1')).toBeDefined();
  });

  it('upserts payloads on the same (kind,id) key', () => {
    store.put('pairing', 'p1', { id: 'p1', resources: [], launchScopes: [], state: 'PENDING' });
    store.put('pairing', 'p1', { id: 'p1', resources: [], launchScopes: [], state: 'APPROVED' });
    expect(store.get<{ state: string }>('pairing', 'p1')?.state).toBe('APPROVED');
  });

  it('enforces the resource-scope v2 trigger on device/pairing/invite kinds', () => {
    // no resources array → rejected
    expect(() => store.put('device', 'x', { id: 'x' })).toThrowError(/RESOURCE_SCOPE_V2_REQUIRED/);
    // sessions persisted → rejected (write-only field, derived on read)
    expect(() => store.put('pairing', 'x', { resources: [], sessions: ['s1'] }))
      .toThrowError(/RESOURCE_SCOPE_V2_REQUIRED/);
    // compliant payloads pass
    store.put('device', 'ok', { id: 'ok', resources: [] });
    store.put('invite', 'ok', { id: 'ok', resources: [] });
    expect(store.get('device', 'ok')).toBeDefined();
    // the trigger does not guard other kinds
    store.put('scope-change', 'r1', { fingerprint: 'f', result: '{}' });
    expect(store.get('scope-change', 'r1')).toBeDefined();
  });

  it('rolls back multi-writes when a transaction fails; nested calls join the outer tx', () => {
    expect(() => store.transaction(() => {
      store.put('host', 'a', { id: 'a' });
      store.transaction(() => store.put('host', 'b', { id: 'b' }));
      throw new Error('boom');
    })).toThrow('boom');
    expect(store.get('host', 'a')).toBeUndefined();
    expect(store.get('host', 'b')).toBeUndefined();
  });
});

describe('ordered records', () => {
  it('allocates a stable sequence on first putOrdered and keeps it on replace', () => {
    store.putOrdered('local-launch', 'k1', { deviceId: 'd1', state: 'SAVED' });
    expect(store.sequence('local-launch', 'k1')).toBe(1);
    store.putOrdered('local-launch', 'k2', { deviceId: 'd1', state: 'SAVED' });
    expect(store.sequence('local-launch', 'k2')).toBe(2);
    store.putOrdered('local-launch', 'k1', { deviceId: 'd1', state: 'OBSERVED' });
    expect(store.sequence('local-launch', 'k1')).toBe(1); // stable across replacement
    expect(store.get<{ state: string }>('local-launch', 'k1')?.state).toBe('OBSERVED');
    // a different kind has its own sequence space
    store.putOrdered('local-input', 'k1', { deviceId: 'd1' });
    expect(store.sequence('local-input', 'k1')).toBe(1);
    expect(store.sequence('local-launch', 'missing')).toBe(0);
  });

  it('listOrdered returns DESC pages honoring beforeSequence', () => {
    for (let i = 1; i <= 5; i++) store.putOrdered('inbox-item', `i${i}`, { deviceId: 'd1', n: i });
    const first = store.listOrdered<{ n: number }>('inbox-item', 0, 2);
    expect(first.map((r) => r.sequence)).toEqual([5, 4]);
    const next = store.listOrdered<{ n: number }>('inbox-item', first[1].sequence, 2);
    expect(next.map((r) => r.sequence)).toEqual([3, 2]);
    const last = store.listOrdered<{ n: number }>('inbox-item', next[1].sequence, 5);
    expect(last.map((r) => r.sequence)).toEqual([1]);
  });

  it('listOrderedForDevice filters by payload.deviceId', () => {
    store.putOrdered('local-launch', 'a', { deviceId: 'd1' });
    store.putOrdered('local-launch', 'b', { deviceId: 'd2' });
    store.putOrdered('local-launch', 'c', { deviceId: 'd1' });
    const rows = store.listOrderedForDevice<{ deviceId: string }>('local-launch', 'd1', 10);
    expect(rows.map((r) => r.value.deviceId)).toEqual(['d1', 'd1']);
    expect(rows.map((r) => r.sequence)).toEqual([3, 1]);
  });

  it('listOrderedForDeviceSources filters device+grant+sourceKeys before LIMIT', () => {
    const item = (id: string, deviceId: string, grantRevision: number, sourceKey: string) =>
      store.putOrdered('inbox-item', id, { itemId: id, deviceId, grantRevision, sourceKey });
    item('a', 'd1', 1, 'src-1');
    item('b', 'd1', 2, 'src-1'); // wrong grant
    item('c', 'd2', 1, 'src-1'); // wrong device
    item('d', 'd1', 1, 'src-2'); // wrong source
    item('e', 'd1', 1, 'src-1');
    const rows = store.listOrderedForDeviceSources<{ itemId: string }>(
      'inbox-item', 'd1', 1, 0, 10, ['src-1']);
    expect(rows.map((r) => r.value.itemId)).toEqual(['e', 'a']);
    const cursor = store.listOrderedForDeviceSources<{ itemId: string }>(
      'inbox-item', 'd1', 1, rows[0].sequence, 10, ['src-1']);
    expect(cursor.map((r) => r.value.itemId)).toEqual(['a']);
    // empty sourceKeys short-circuits to []
    expect(store.listOrderedForDeviceSources('inbox-item', 'd1', 1, 0, 10, [])).toEqual([]);
  });

  it('listOrderedForSources filters payload.sourceKey ∈ keys', () => {
    store.putOrdered('cursor', 'c1', { sourceKey: 'src-1' });
    store.putOrdered('cursor', 'c2', { sourceKey: 'src-2' });
    store.putOrdered('cursor', 'c3', { sourceKey: 'src-1' });
    const rows = store.listOrderedForSources<{ sourceKey: string }>('cursor', ['src-1'], 0, 10);
    expect(rows.map((r) => r.value.sourceKey)).toEqual(['src-1', 'src-1']);
    expect(store.listOrderedForSources('cursor', [], 0, 10)).toEqual([]);
    expect(store.listOrderedForSources('cursor', ['src-1'], 3, 10).map((r) => r.sequence)).toEqual([1]);
  });

  it('bounds limits to [1, 5001]', () => {
    expect(() => store.listOrdered('inbox-item', 0, 0)).toThrowError(/invalid bounded limit/);
    expect(() => store.listOrdered('inbox-item', 0, 5002)).toThrowError(/invalid bounded limit/);
    expect(() => store.listOrderedForDevice('k', 'd', 0)).toThrowError(/invalid bounded limit/);
  });

  it('deleteOrdered removes record and sequence; re-putOrdered allocates a new one', () => {
    store.putOrdered('local-launch', 'k1', { deviceId: 'd1' });
    store.putOrdered('local-launch', 'k2', { deviceId: 'd1' });
    store.deleteOrdered('local-launch', 'k1');
    expect(store.get('local-launch', 'k1')).toBeUndefined();
    expect(store.sequence('local-launch', 'k1')).toBe(0);
    store.putOrdered('local-launch', 'k1', { deviceId: 'd1' });
    expect(store.sequence('local-launch', 'k1')).toBe(3); // sequence space is monotonic
  });
});

describe('registry connections', () => {
  it('upsertConnection is register-once and validates kind', () => {
    const row = store.upsertConnection({ connectionId: 'c1', kind: 'worker-local', baseUrl: 'http://127.0.0.1:9' });
    expect(row.revision).toBe(1);
    expect(row.baseUrl).toBe('http://127.0.0.1:9');
    const again = store.upsertConnection({ connectionId: 'c1', kind: 'acs', displayName: 'changed' });
    expect(again.kind).toBe('worker-local');
    expect(again.displayName).toBeUndefined();
    expect(store.getConnection('c1')?.kind).toBe('worker-local');
    store.upsertConnection({ connectionId: 'c2', kind: 'env' });
    expect(store.listConnections().map((c) => c.connectionId)).toEqual(['c1', 'c2']);
    expect(store.getProject('anything')).toBeUndefined();
    expect(() => store.upsertConnection({ connectionId: 'c3', kind: 'bogus' })).toThrowError(/INVALID_REQUEST/);
  });
});

describe('scope helpers (Java validators)', () => {
  it('checkedResources validates kind/binding/dedup and sorts by canonical key', () => {
    const checked = checkedResources('pa-test', [
      localRes('t2'),
      acsRes('s1'),
      localRes('t1'),
    ]);
    // sorted by canonical key string
    expect(checked.map((r) => r.kind === 'ACS_SESSION' ? r.sessionId : r.taskId))
      .toEqual(['s1', 't1', 't2']);
    expect(checked[0]).toEqual({ kind: 'ACS_SESSION', backendStoreId: 'pa-test', sessionId: 's1' });
    // ACS_SESSION must bind the host store
    expect(() => checkedResources('pa-test', [acsRes('s1', 'other-store')])).toThrowError(/INVALID_SCOPE/);
    // cross-field payloads rejected
    expect(() => checkedResources('pa-test', [{ ...acsRes('s1'), taskId: 't' }])).toThrowError(/INVALID_SCOPE/);
    expect(() => checkedResources('pa-test', [{ ...localRes('t'), sessionId: 's' }])).toThrowError(/INVALID_SCOPE/);
    // unknown kind
    expect(() => checkedResources('pa-test', [{ kind: 'NOPE', backendStoreId: 'x' }])).toThrowError(/INVALID_SCOPE/);
    // duplicate canonical keys
    expect(() => checkedResources('pa-test', [localRes('t'), localRes('t')])).toThrowError(/INVALID_SCOPE/);
    // >100 cap
    expect(() => checkedResources('pa-test', Array.from({ length: 101 }, (_, i) => localRes(`t${i}`))))
      .toThrowError(/INVALID_SCOPE/);
    // malformed ids surface INVALID_REQUEST via id()
    expect(() => checkedResources('pa-test', [{ kind: 'WORKER_LOCAL', backendStoreId: 'x', taskId: '!!' }]))
      .toThrowError(/INVALID_REQUEST/);
  });

  it('checkedLaunchScopes validates engine/dedup and sorts', () => {
    const checked = checkedLaunchScopes([launch('pi'), launch('codex')]);
    expect(checked.map((s) => s.engineId)).toEqual(['codex', 'pi']);
    expect(() => checkedLaunchScopes([launch('vim')])).toThrowError(/INVALID_SCOPE/);
    expect(() => checkedLaunchScopes([launch('pi'), launch('pi')])).toThrowError(/INVALID_SCOPE/);
    expect(() => checkedLaunchScopes([{ backendStoreId: 'x', projectId: '!!', engineId: 'pi' }]))
      .toThrowError(/INVALID_REQUEST/);
    expect(checkedLaunchScopes(undefined)).toEqual([]);
  });

  it('validateScope enforces the legacy sessions contract', () => {
    validateScope(['s1', 's2'], ['OBSERVE', 'CONTROL']); // ok
    expect(() => validateScope([], ['OBSERVE'])).toThrowError(/INVALID_SCOPE/);
    expect(() => validateScope(['s1', 's1'], ['OBSERVE'])).toThrowError(/INVALID_SCOPE/);
    expect(() => validateScope(['s1'], ['CONTROL'])).toThrowError(/INVALID_SCOPE/); // no OBSERVE
    expect(() => validateScope(['s1'], ['OBSERVE', 'LAUNCH'])).toThrowError(/INVALID_SCOPE/); // not in legacy set
    expect(() => validateScope(['!!bad'], ['OBSERVE'])).toThrowError(/INVALID_REQUEST/);
    expect(() => validateScope(Array.from({ length: 101 }, (_, i) => `s${i}`), ['OBSERVE']))
      .toThrowError(/INVALID_SCOPE/);
  });

  it('validateResourceActions enforces the resource-form contract', () => {
    validateResourceActions([localRes('t')], [], ['OBSERVE']);
    validateResourceActions([], [launch('pi')], ['OBSERVE', 'LAUNCH']);
    validateResourceActions([localRes('t')], [], ['OBSERVE', 'CONTROL', 'GRAPHICS_ACT']);
    // empty scope is a valid connection-only grant (pair without a live source)
    validateResourceActions([], [], ['OBSERVE']);
    // missing OBSERVE
    expect(() => validateResourceActions([localRes('t')], [], ['CONTROL'])).toThrowError(/INVALID_SCOPE/);
    // action outside the twelve
    expect(() => validateResourceActions([localRes('t')], [], ['OBSERVE', 'WAT'])).toThrowError(/INVALID_SCOPE/);
    // GRAPHICS_ACT requires CONTROL
    expect(() => validateResourceActions([localRes('t')], [], ['OBSERVE', 'GRAPHICS_ACT']))
      .toThrowError(/INVALID_SCOPE/);
    // LAUNCH iff launch scopes non-empty
    expect(() => validateResourceActions([localRes('t')], [], ['OBSERVE', 'LAUNCH']))
      .toThrowError(/INVALID_SCOPE/);
    expect(() => validateResourceActions([], [launch('pi')], ['OBSERVE'])).toThrowError(/INVALID_SCOPE/);
  });

  it('allows() is a pure membership check (scope-level rules live in validateResourceActions)', () => {
    expect(allows({ actions: ['OBSERVE', 'CONTROL'] }, 'CONTROL')).toBe(true);
    expect(allows({ actions: ['OBSERVE'] }, 'CONTROL')).toBe(false);
    expect(allows({ actions: ['OBSERVE', 'GRAPHICS_ACT'] }, 'GRAPHICS_ACT')).toBe(true);
    expect(allows({ actions: ['OBSERVE'] }, 'NOT_A_THING')).toBe(false);
  });
});

describe('scope helpers (body parse / fingerprints)', () => {
  it('parseScope accepts a valid scope and canonicalizes entries', () => {
    const parsed = parseScope({
      resources: [localRes('t1')],
      launchScopes: [launch('pi')],
      actions: ['CONTROL', 'OBSERVE'],
    });
    expect(parsed.actions).toEqual(['CONTROL', 'OBSERVE']);
    expect(parsed.resources![0].taskId).toBe('t1');
    expect(parsed.launchScopes![0].engineId).toBe('pi');
  });

  it('parseScope rejects wrong kinds, unknown fields, dups and oversize inputs', () => {
    expect(() => parseScope({ resources: [{ kind: 'OTHER', backendStoreId: 'wl-1', taskId: 't' }] }))
      .toThrowError(/INVALID_REQUEST/);
    expect(() => parseScope({ bogus: 1 })).toThrowError(/INVALID_REQUEST/);
    expect(() => parseScope({ resources: [localRes('t1'), localRes('t1')] }))
      .toThrowError(/INVALID_REQUEST/);
    expect(() => parseScope({ sessions: Array.from({ length: 513 }, (_, i) => `s${i}`) }))
      .toThrowError(/INVALID_REQUEST/);
    expect(() => parseScope({ resources: Array.from({ length: 129 }, (_, i) => localRes(`t${i}`)) }))
      .toThrowError(/INVALID_REQUEST/);
    expect(() => parseScope({ actions: ['OBSERVE', 'NOT_A_THING'] })).toThrowError(/INVALID_ACTION/);
    expect(() => parseScope({ launchScopes: [launch('vim')] })).toThrowError(/INVALID_REQUEST/);
    expect(() => parseScope({ resources: [{ kind: 'ACS_SESSION', backendStoreId: 'wl-1', sessionId: 's', taskId: 't' }] }))
      .toThrowError(/INVALID_REQUEST/);
  });

  it('parseScope cross-checks sessions against ACS_SESSION resources', () => {
    expect(() => parseScope({
      resources: [acsRes('s1')],
      sessions: ['s1'],
    })).not.toThrow();
    expect(() => parseScope({
      resources: [acsRes('s1')],
      sessions: ['s2'],
    })).toThrowError(/INVALID_REQUEST/);
  });

  it('normalizeScope derives sessions from this host\'s ACS_SESSION resources', () => {
    const scoped = normalizeScope(
      {
        resources: [acsRes('s1', 'pa-me'), acsRes('s2', 'other'), localRes('t1')],
      } as ScopeRecord,
      'pa-me',
    );
    expect(scoped.sessions).toEqual(['s1']);
    const legacy = normalizeScope({ sessions: ['a', 'b'] } as ScopeRecord, 'pa-me');
    expect(legacy.resources).toEqual([acsRes('a', 'pa-me'), acsRes('b', 'pa-me')]);
  });

  it('scopeFingerprint is order-insensitive and change-sensitive', () => {
    const a = parseScope({ actions: ['OBSERVE', 'CONTROL'], resources: [localRes('t1')] });
    const b = parseScope({ actions: ['CONTROL', 'OBSERVE'], resources: [localRes('t1')] });
    expect(scopeFingerprint(a)).toBe(scopeFingerprint(b));
    const c = parseScope({ actions: ['OBSERVE'], resources: [localRes('t2')] });
    expect(scopeFingerprint(c)).not.toBe(scopeFingerprint(a));
  });
});
