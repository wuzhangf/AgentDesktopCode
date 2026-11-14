import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import { GatewayStore } from '../src/store.js';
import { Devices, INVITE_TTL } from '../src/devices.js';
import {
  GatewayError,
  hash,
  secret,
  type Device,
  type Invite,
  type LaunchScope,
  type Pairing,
  type Resource,
  type ScopeRecord,
} from '../src/protocol.js';

type Json = Record<string, unknown>;

let dir: string;
let store: GatewayStore;
let devices: Devices;
let key: Uint8Array;
let counter = 0;

const next = (prefix: string) => `${prefix}-${++counter}`;

const expectFail = (fn: () => unknown, code: string, status?: number): GatewayError => {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(GatewayError);
    const e = error as GatewayError;
    expect(e.code).toBe(code);
    if (status !== undefined) expect(e.httpStatus).toBe(status);
    return e;
  }
  throw new Error(`expected failure ${code}`);
};

const acsRes = (sessionId: string, backend: string): Resource =>
  ({ kind: 'ACS_SESSION', backendStoreId: backend, sessionId });
const localRes = (taskId: string, backend = 'wl-1'): Resource =>
  ({ kind: 'WORKER_LOCAL', backendStoreId: backend, taskId });
const launch = (engineId: string, projectId = 'p1', backend = 'wl-1'): LaunchScope =>
  ({ backendStoreId: backend, projectId, engineId });

const invite = (
  sessions = ['sess-1'],
  actions = ['OBSERVE', 'CONTROL'],
  requestId = next('inv'),
): Json => devices.invitation(requestId, sessions, actions, 'cert-fp-1');

const inviteResources = (
  resources: Resource[],
  launchScopes: LaunchScope[],
  actions: string[],
  requestId = next('inv'),
): Json => devices.invitationResources(requestId, resources, launchScopes, actions, 'cert-fp-1');

const requestPairing = (inv: Json, rid = next('pr'), poll = secret(), label = 'Phone'): Json =>
  devices.request({
    pairingRequestId: rid,
    inviteId: inv.inviteId,
    pollingSecretHash: hash(poll),
    inviteSecret: inv.inviteSecret,
    installationId: 'inst-1',
    label,
  });

/** request → decide(approve) → redeem; returns the issued credentials. */
const mintDevice = (opts: {
  sessions?: string[];
  actions?: string[];
  resources?: Resource[];
  launchScopes?: LaunchScope[];
  label?: string;
} = {}): { invite: Json; rid: string; poll: string; issued: Json } => {
  const inv = opts.resources !== undefined || opts.launchScopes !== undefined
    ? inviteResources(opts.resources ?? [], opts.launchScopes ?? [], opts.actions ?? ['OBSERVE', 'CONTROL'])
    : invite(opts.sessions ?? ['sess-1'], opts.actions ?? ['OBSERVE', 'CONTROL']);
  const rid = next('pr');
  const poll = secret();
  requestPairing(inv, rid, poll, opts.label ?? 'Phone');
  devices.decide(rid, true);
  const issued = devices.redeem(rid, poll, `red-${rid}`);
  return { invite: inv, rid, poll, issued };
};

const deviceRecord = (deviceId: string): Device => store.get<Device>('device', deviceId)!;
const pairingRecord = (rid: string): Pairing => store.get<Pairing>('pairing', rid)!;
const patch = <T>(kind: string, id: string, apply: (value: T) => void): T => {
  const value = store.get<T>(kind, id)!;
  apply(value);
  store.put(kind, id, value);
  return value;
};

const fakeDevice = (id: string, over: Partial<Device> = {}): void => {
  store.put('device', id, {
    id, state: 'ACTIVE', scopeVersion: 2, revision: 1,
    accessExpiry: Date.now() + 60_000,
    absoluteExpiry: Date.now() + 60_000,
    idleExpiry: Date.now() + 60_000,
    recoverUntil: 0, spentRefresh: [],
    resources: [], launchScopes: [], actions: ['OBSERVE'],
    ...over,
  });
};

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dgw-'));
  store = new GatewayStore(dir);
  key = randomBytes(32);
  counter = 0;
  devices = new Devices(store, () => key, () => undefined, undefined, 'https://gw.test');
});

afterEach(() => {
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('host identity', () => {
  it('creates the identity host once and verifies the key check', () => {
    devices.ensureHost();
    const host = devices.hostRecord();
    expect(host.id).toBeTruthy();
    expect(host.storeId).toMatch(/^pa-/);
    expect(host.keyCheck).toBeTruthy();
    expect(devices.hostRecord()).toEqual(host);
    expect(devices.keyCheckOk()).toBe(true);
    const status = devices.ownerStatus();
    expect(status.personalHostId).toBe(host.id);
    expect(status.storeId).toBe(host.storeId);
    expect(status.origin).toBe('https://gw.test');
    expect(status.enabled).toBe(true);
  });

  it('uses a provided storeId and detects a mismatched one (HOST_IDENTITY_CHANGED)', () => {
    // fresh database — the provided storeId wins
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'dgw-'));
    try {
      const store2 = new GatewayStore(dir2);
      const fresh = new Devices(store2, () => key, () => undefined, 'pa-fixed', 'https://gw.test');
      expect(fresh.hostRecord().storeId).toBe('pa-fixed');
      store2.close();
    } finally {
      fs.rmSync(dir2, { recursive: true, force: true });
    }
    // the existing host carries a different generated storeId → identity check
    expectFail(
      () => new Devices(store, () => key, () => undefined, 'pa-other', 'https://gw.test'),
      'HOST_IDENTITY_CHANGED', 503,
    );
  });

  it('detects a wrong seal key (STORE_KEY_INVALID) and rotates on previous key', () => {
    expectFail(
      () => new Devices(store, () => randomBytes(32), () => undefined),
      'STORE_KEY_INVALID', 500,
    );
    const newKey = randomBytes(32);
    const rotated = new Devices(store, () => newKey, () => key);
    expect(rotated.keyCheckOk()).toBe(true);
    // the check was re-sealed under the new key — a new-key-only reader is fine
    const converged = new Devices(store, () => newKey, () => undefined);
    expect(converged.keyCheckOk()).toBe(true);
  });
});

describe('invitations', () => {
  it('issues the personal-pairing-invite/1 shape and binds the certificate fingerprint', () => {
    const out = invite(['sess-1', 'sess-2']);
    expect(out.schemaVersion).toBe('personal-pairing-invite/1');
    expect(out.origin).toBe('https://gw.test');
    expect(out.personalHostId).toBe(devices.hostRecord().id);
    expect(out.storeId).toBe(devices.hostRecord().storeId);
    expect(out.inviteId).toBeTruthy();
    expect(typeof out.inviteSecret).toBe('string');
    expect(out.certificateSha256).toBe('cert-fp-1');
    expect(out.expiresAt).toBeGreaterThan(Date.now());
    expect(out.expiresAt).toBeLessThanOrEqual(Date.now() + INVITE_TTL);
  });

  it('replays an invitation idempotently and mismatches on payload drift', () => {
    const first = invite(['sess-1'], ['OBSERVE', 'CONTROL'], 'inv-replay');
    const again = invite(['sess-1'], ['OBSERVE', 'CONTROL'], 'inv-replay');
    expect(again.inviteSecret).toBe(first.inviteSecret);
    expectFail(
      () => invite(['sess-2'], ['OBSERVE', 'CONTROL'], 'inv-replay'),
      'IDEMPOTENCY_PAYLOAD_MISMATCH', 409,
    );
    expectFail(
      () => invite(['sess-1'], ['OBSERVE'], 'inv-replay'),
      'IDEMPOTENCY_PAYLOAD_MISMATCH', 409,
    );
  });

  it('fails PAIRING_EXPIRED when replaying an expired invite', () => {
    const inv = invite(['sess-1'], ['OBSERVE'], 'inv-old');
    patch<Invite>('invite', inv.inviteId as string, (v) => { v.expiresAt = Date.now() - 1; });
    expectFail(
      () => invite(['sess-1'], ['OBSERVE'], 'inv-old'),
      'PAIRING_EXPIRED', 410,
    );
  });

  it('caps pending invites at PAIRING_LIMIT', () => {
    // Unscanned invites are superseded on each mint; only invites bound to a
    // live pairing hold a slot.
    for (let i = 0; i < 4; i++) requestPairing(invite([`s${i}`]));
    expectFail(() => invite(['s5']), 'PAIRING_LIMIT', 429);
  });

  it('supersedes unclaimed invites instead of exhausting the pool', () => {
    const first = invite(['s1']);
    let last: Json = first;
    for (let i = 0; i < 6; i++) last = invite([`s${i}`]);
    expectFail(() => requestPairing(first), 'PAIRING_EXPIRED', 410);
    expect(requestPairing(last).state).toBe('PENDING');
  });

  it('frees an invitation slot after redemption without making the QR reusable', () => {
    const paired = mintDevice();
    for (let i = 0; i < 4; i++) requestPairing(invite([`s${i}`]));
    expectFail(() => requestPairing(paired.invite), 'INVITATION_BOUND', 409);
    expectFail(() => invite(['s5']), 'PAIRING_LIMIT', 429);
  });

  it('validates the legacy sessions scope contract', () => {
    expectFail(() => invite([], ['OBSERVE']), 'INVALID_SCOPE', 400);
    expectFail(() => invite(['s', 's'], ['OBSERVE']), 'INVALID_SCOPE', 400);
    expectFail(() => invite(['s'], ['CONTROL']), 'INVALID_SCOPE', 400);
    expectFail(() => invite(['s'], ['OBSERVE', 'LAUNCH']), 'INVALID_SCOPE', 400);
  });

  it('invitationResources honors the resource-form scope contract', () => {
    const storeId = devices.hostRecord().storeId;
    const out = inviteResources(
      [localRes('task-1'), acsRes('sess-9', storeId)],
      [launch('pi')],
      ['OBSERVE', 'CONTROL', 'LAUNCH'],
    );
    expect(out.inviteSecret).toBeTruthy();
    // ACS_SESSION bound to a different backend is rejected
    expectFail(
      () => inviteResources([acsRes('sess-1', 'other-store')], [], ['OBSERVE']),
      'INVALID_SCOPE', 400,
    );
    // LAUNCH requires launch scopes and vice versa
    expectFail(
      () => inviteResources([localRes('t')], [], ['OBSERVE', 'LAUNCH']),
      'INVALID_SCOPE', 400,
    );
    // GRAPHICS_ACT requires CONTROL
    expectFail(
      () => inviteResources([localRes('t')], [], ['OBSERVE', 'GRAPHICS_ACT']),
      'INVALID_SCOPE', 400,
    );
    // empty scope is a valid connection-only invite — pairing must not
    // require a live agent source
    const bare = inviteResources([], [], ['OBSERVE']);
    expect(bare.inviteSecret).toBeTruthy();
    // LAUNCH still requires launch scopes
    expectFail(() => inviteResources([], [], ['OBSERVE', 'LAUNCH']), 'INVALID_SCOPE', 400);
  });
});

describe('pairing flow: request → decide → redeem', () => {
  it('runs the full flow and issues credentials', () => {
    const inv = invite(['sess-1', 'sess-2']);
    const rid = next('pr');
    const poll = secret();
    const view = requestPairing(inv, rid, poll);
    expect(view.pairingRequestId).toBe(rid);
    expect(view.state).toBe('PENDING');
    expect(view.checkWords).toBe(hash(`${rid}:${inv.inviteId}`).substring(0, 12));
    expect(view.sessions).toEqual(['sess-1', 'sess-2']);
    expect(view.actions).toEqual(['CONTROL', 'OBSERVE']);
    expect(view.deviceGrantId).toBeUndefined();

    const decided = devices.decide(rid, true);
    expect(decided.state).toBe('APPROVED');

    const issued = devices.redeem(rid, poll, `red-${rid}`);
    expect(issued.deviceGrantId).toBeTruthy();
    expect(issued.grantRevision).toBe('1');
    expect(typeof issued.accessToken).toBe('string');
    expect(typeof issued.refreshToken).toBe('string');
    expect(issued.accessExpiresAt).toBeGreaterThan(Date.now());

    const d = deviceRecord(issued.deviceGrantId as string);
    expect(d.state).toBe('ACTIVE');
    expect(d.revision).toBe(1);
    expect(d.scopeVersion).toBe(2);
    expect(d.accessHash).toBe(hash(issued.accessToken as string));
    expect(d.refreshHash).toBe(hash(issued.refreshToken as string));
    expect(d.absoluteExpiry).toBeGreaterThan(Date.now() + 29 * 86_400_000);
    expect(d.idleExpiry).toBeGreaterThan(Date.now() + 6 * 86_400_000);

    // deviceGrantId surfaces in the redeemed pairing view
    expect(devices.observePairing(rid, poll).deviceGrantId).toBe(issued.deviceGrantId);
  });

  it('requires a client-supplied 64-hex polling hash and bounds label to 80', () => {
    const inv = invite();
    expectFail(() => devices.request({
      pairingRequestId: next('pr'), inviteId: inv.inviteId,
      pollingSecretHash: secret(), inviteSecret: inv.inviteSecret,
      installationId: 'inst-1', label: 'Phone',
    }), 'INVALID_REQUEST', 400);
    expectFail(() => devices.request({
      pairingRequestId: next('pr'), inviteId: inv.inviteId,
      pollingSecretHash: hash('ok').toUpperCase(), inviteSecret: inv.inviteSecret,
      installationId: 'inst-1', label: 'Phone',
    }), 'INVALID_REQUEST', 400);
    expectFail(() => devices.request({
      pairingRequestId: next('pr'), inviteId: inv.inviteId,
      pollingSecretHash: hash('ok'), inviteSecret: inv.inviteSecret,
      installationId: 'inst-1', label: 'x'.repeat(81),
    }), 'INVALID_REQUEST', 400);
  });

  it('rejects bad invite secrets and missing invites with PAIRING_UNAUTHORIZED', () => {
    const inv = invite();
    expectFail(() => devices.request({
      pairingRequestId: next('pr'), inviteId: inv.inviteId,
      pollingSecretHash: hash('p'), inviteSecret: 'wrong',
      installationId: 'inst-1', label: 'Phone',
    }), 'PAIRING_UNAUTHORIZED', 401);
    expectFail(() => devices.request({
      pairingRequestId: next('pr'), inviteId: 'inv-missing',
      pollingSecretHash: hash('p'), inviteSecret: 'whatever',
      installationId: 'inst-1', label: 'Phone',
    }), 'PAIRING_UNAUTHORIZED', 401);
  });

  it('fails PAIRING_EXPIRED for lapsed invites', () => {
    const inv = invite();
    patch<Invite>('invite', inv.inviteId as string, (v) => { v.expiresAt = Date.now() - 1; });
    expectFail(() => requestPairing(inv), 'PAIRING_EXPIRED', 410);
  });

  it('replays request() idempotently and mismatches on different payloads', () => {
    const inv = invite();
    const rid = next('pr');
    const poll = secret();
    const first = requestPairing(inv, rid, poll);
    const again = requestPairing(inv, rid, poll);
    expect(again).toEqual(first);
    // different label or different poll hash under the same request id → mismatch
    expectFail(() => requestPairing(inv, rid, poll, 'Tablet'), 'IDEMPOTENCY_PAYLOAD_MISMATCH', 409);
    expectFail(() => requestPairing(inv, rid, secret()), 'IDEMPOTENCY_PAYLOAD_MISMATCH', 409);
  });

  it('binds an invite to its first pairing request (INVITATION_BOUND)', () => {
    const inv = invite();
    requestPairing(inv);
    expectFail(() => requestPairing(inv), 'INVITATION_BOUND', 409);
  });

  it('hides pairings behind PAIRING_UNAUTHORIZED for wrong polls and missing ids', () => {
    const inv = invite();
    const rid = next('pr');
    requestPairing(inv, rid, secret());
    expectFail(() => devices.observePairing(rid, 'wrong-poll'), 'PAIRING_UNAUTHORIZED', 401);
    expectFail(() => devices.observePairing('pr-missing', 'whatever'), 'PAIRING_UNAUTHORIZED', 401);
  });

  it('reports EXPIRED in the view for lapsed non-redeemed pairings', () => {
    const inv = invite();
    const rid = next('pr');
    const poll = secret();
    requestPairing(inv, rid, poll);
    patch<Pairing>('pairing', rid, (p) => { p.expiresAt = Date.now() - 1; });
    expectFail(() => devices.observePairing(rid, poll), 'PAIRING_EXPIRED', 410);
    expectFail(() => devices.decide(rid, true), 'PAIRING_EXPIRED', 410);
    // the owner listing still shows the record, as EXPIRED
    const listed = devices.requests().find((r) => r.pairingRequestId === rid);
    expect(listed?.state).toBe('EXPIRED');
  });
});

describe('pairing auto-approve', () => {
  const enableAutoApprove = (): void => {
    devices = new Devices(store, () => key, () => undefined, undefined, 'https://gw.test', undefined, true);
  };

  it('approves at request time on invite secret and redeems without decide', () => {
    enableAutoApprove();
    const inv = invite();
    const rid = next('pr');
    const poll = secret();
    const view = requestPairing(inv, rid, poll);
    expect(view.state).toBe('APPROVED');
    expect(view.checkWords).toBe(hash(`${rid}:${inv.inviteId}`).substring(0, 12));

    // same-state owner replay stays idempotent; rejection is closed post-approve
    expect(devices.decide(rid, true).state).toBe('APPROVED');
    expectFail(() => devices.decide(rid, false), 'PAIRING_DECIDED', 409);

    const issued = devices.redeem(rid, poll, `red-${rid}`);
    expect(issued.deviceGrantId).toBeTruthy();
    expect(deviceRecord(issued.deviceGrantId as string).state).toBe('ACTIVE');
  });

  it('enforces DEVICE_LIMIT at request time without persisting a pairing', () => {
    enableAutoApprove();
    for (let i = 0; i < 4; i++) fakeDevice(next('fd'));
    const inv = invite();
    const rid = next('pr');
    expectFail(() => requestPairing(inv, rid, secret()), 'DEVICE_LIMIT', 429);
    expect(store.get('pairing', rid)).toBeUndefined();
  });
});

describe('member-attested pairing (relay ingress)', () => {
  const memberScope = (): ScopeRecord => ({
    resources: [localRes('task-1')],
    launchScopes: [launch('macos', 'p1'), launch('macos', 'p2')],
    actions: ['OBSERVE', 'CONTROL', 'INTERACT', 'LAUNCH'],
  });
  const memberPairing = (rid = next('pr'), poll = secret(), label = 'Phone'): Json =>
    devices.memberRequest!({
      pairingRequestId: rid,
      installationId: 'inst-member-1',
      label,
      pollingSecretHash: hash(poll),
      member: true,
    }, memberScope());

  it('creates an APPROVED pairing with the caller scope and redeems a device', () => {
    const rid = next('pr');
    const poll = secret();
    const view = memberPairing(rid, poll);
    expect(view.state).toBe('APPROVED');
    expect(view.launchScopes).toEqual(memberScope().launchScopes);
    expect(view.actions).toEqual([...memberScope().actions!].sort());

    const issued = devices.redeem(rid, poll, `red-${rid}`);
    expect(issued.deviceGrantId).toBeTruthy();
    const d = deviceRecord(issued.deviceGrantId as string);
    expect(d.state).toBe('ACTIVE');
    expect(d.resources).toEqual(memberScope().resources);
    expect(d.launchScopes).toEqual(memberScope().launchScopes);
    expect(d.actions).toEqual([...memberScope().actions!].sort());
    // the device view exposes the same member scope
    const shown = devices.devices().find((v) => v.deviceGrantId === issued.deviceGrantId);
    expect(shown?.launchScopes).toEqual(memberScope().launchScopes);
  });

  it('replays idempotently and mismatches on payload drift', () => {
    const rid = next('pr');
    const poll = secret();
    const first = memberPairing(rid, poll);
    expect(memberPairing(rid, poll)).toEqual(first);
    expectFail(() => memberPairing(rid, poll, 'Tablet'), 'IDEMPOTENCY_PAYLOAD_MISMATCH', 409);
    expectFail(() => memberPairing(rid, secret()), 'IDEMPOTENCY_PAYLOAD_MISMATCH', 409);
  });

  it('validates the polling hash and label bound like invite pairing', () => {
    expectFail(() => devices.memberRequest!({
      pairingRequestId: next('pr'), installationId: 'inst-1', label: 'Phone',
      pollingSecretHash: 'not-hex', member: true,
    }, memberScope()), 'INVALID_REQUEST', 400);
    expectFail(() => devices.memberRequest!({
      pairingRequestId: next('pr'), installationId: 'inst-1', label: 'x'.repeat(81),
      pollingSecretHash: hash('p'), member: true,
    }, memberScope()), 'INVALID_REQUEST', 400);
  });

  it('hides pairings behind PAIRING_UNAUTHORIZED for wrong polls', () => {
    const rid = next('pr');
    memberPairing(rid, secret());
    expectFail(() => devices.observePairing(rid, 'wrong-poll'), 'PAIRING_UNAUTHORIZED', 401);
    expectFail(() => devices.redeem(rid, 'wrong-poll', 'red-x'), 'PAIRING_UNAUTHORIZED', 401);
  });

  it('enforces DEVICE_LIMIT without persisting a pairing', () => {
    for (let i = 0; i < 4; i++) fakeDevice(next('fd'));
    const rid = next('pr');
    expectFail(() => memberPairing(rid), 'DEVICE_LIMIT', 429);
    expect(store.get('pairing', rid)).toBeUndefined();
  });
});

describe('LAN discovery pairing (Bonjour)', () => {
  const discoveryPairing = (rid = next('pr'), poll = secret(), label = 'Phone', installation = 'inst-disc-1'): Json =>
    devices.discoveryRequest!({
      pairingRequestId: rid,
      installationId: installation,
      label,
      pollingSecretHash: hash(poll),
      discovery: true,
    }, {
      resources: [localRes('task-1')],
      launchScopes: [launch('macos', 'p1')],
      actions: ['OBSERVE', 'CONTROL', 'INTERACT', 'LAUNCH'],
    });

  it('lands PENDING — never auto-approved — then owner approval redeems', () => {
    const rid = next('pr');
    const poll = secret();
    const view = discoveryPairing(rid, poll);
    expect(view.state).toBe('PENDING');
    // Owner approval flips it through the same pairing-requests surface as
    // an unsealed invite.
    devices.decide(rid, true);
    const issued = devices.redeem(rid, poll, `red-${rid}`);
    expect(issued.deviceGrantId).toBeTruthy();
    const d = deviceRecord(issued.deviceGrantId as string);
    expect(d.state).toBe('ACTIVE');
    expect(d.launchScopes).toEqual([launch('macos', 'p1')]);
  });

  it('rejects unapproved redemption', () => {
    const rid = next('pr');
    const poll = secret();
    discoveryPairing(rid, poll);
    expectFail(() => devices.redeem(rid, poll, `red-${rid}`), 'PAIRING_NOT_APPROVED', 409);
  });

  it('caps unanswered discovery requests so a hostile LAN cannot flood', () => {
    for (let i = 0; i < 8; i++) discoveryPairing(next('pr'), secret(), 'Phone', `inst-flood-${i}`);
    expectFail(() => discoveryPairing(next('pr'), secret(), 'Phone', 'inst-flood-9'), 'PAIRING_LIMIT', 429);
  });

  it('supersedes a retried discovery request from the same installation', () => {
    const poll1 = secret();
    const rid1 = next('pr');
    discoveryPairing(rid1, poll1);
    discoveryPairing(next('pr'));
    expectFail(() => devices.observePairing(rid1, poll1), 'PAIRING_EXPIRED', 410);
    for (let i = 0; i < 10; i++) discoveryPairing(next('pr'));
  });

  it('replays idempotently and mismatches on payload drift', () => {
    const rid = next('pr');
    const poll = secret();
    const first = discoveryPairing(rid, poll);
    expect(discoveryPairing(rid, poll)).toEqual(first);
    expectFail(() => discoveryPairing(rid, poll, 'Tablet'), 'IDEMPOTENCY_PAYLOAD_MISMATCH', 409);
  });

  it('hides pairings behind PAIRING_UNAUTHORIZED for wrong polls', () => {
    const rid = next('pr');
    discoveryPairing(rid, secret());
    expectFail(() => devices.observePairing(rid, 'wrong-poll'), 'PAIRING_UNAUTHORIZED', 401);
  });
});

describe('decide', () => {
  it('approves and rejects with idempotent same-state replay', () => {
    const inv = invite();
    const rid = next('pr');
    const poll = secret();
    requestPairing(inv, rid, poll);
    expect(devices.decide(rid, false).state).toBe('REJECTED');
    expect(devices.decide(rid, false).state).toBe('REJECTED'); // idempotent
    expectFail(() => devices.decide(rid, true), 'PAIRING_DECIDED', 409);

    const inv2 = invite();
    const rid2 = next('pr');
    requestPairing(inv2, rid2, secret());
    expect(devices.decide(rid2, true).state).toBe('APPROVED');
    expect(devices.decide(rid2, true).state).toBe('APPROVED');
    expectFail(() => devices.decide(rid2, false), 'PAIRING_DECIDED', 409);
  });

  it('fails NOT_FOUND for unknown pairings', () => {
    expectFail(() => devices.decide('pr-none', true), 'NOT_FOUND', 404);
  });

  it('enforces DEVICE_LIMIT at approve time', () => {
    for (let i = 0; i < 4; i++) fakeDevice(next('fd'));
    const inv = invite();
    const rid = next('pr');
    requestPairing(inv, rid, secret());
    expectFail(() => devices.decide(rid, true), 'DEVICE_LIMIT', 429);
    // rejection is still allowed under the limit
    expect(devices.decide(rid, false).state).toBe('REJECTED');
  });
});

describe('redeem', () => {
  it('requires APPROVED state', () => {
    const inv = invite();
    const rid = next('pr');
    const poll = secret();
    requestPairing(inv, rid, poll);
    expectFail(() => devices.redeem(rid, poll, `red-${rid}`), 'PAIRING_NOT_APPROVED', 409);
    devices.decide(rid, false);
    expectFail(() => devices.redeem(rid, poll, `red-${rid}`), 'PAIRING_NOT_APPROVED', 409);
  });

  it('replays redemption idempotently and rejects a different redemption id', () => {
    const inv = invite();
    const rid = next('pr');
    const poll = secret();
    requestPairing(inv, rid, poll);
    devices.decide(rid, true);
    const issued = devices.redeem(rid, poll, `red-${rid}`);
    const replay = devices.redeem(rid, poll, `red-${rid}`);
    expect(replay).toEqual(issued);
    expectFail(() => devices.redeem(rid, poll, `red-other-${rid}`), 'PAIRING_REDEEMED', 409);
  });

  it('fails RECOVERY_EXPIRED once the recovery window lapses', () => {
    const inv = invite();
    const rid = next('pr');
    const poll = secret();
    requestPairing(inv, rid, poll);
    devices.decide(rid, true);
    devices.redeem(rid, poll, `red-${rid}`);
    patch<Pairing>('pairing', rid, (p) => { p.recoverUntil = Date.now() - 1; });
    expectFail(() => devices.redeem(rid, poll, `red-${rid}`), 'RECOVERY_EXPIRED', 410);
  });

  it('enforces DEVICE_LIMIT at redeem when devices arrive after approval', () => {
    const inv = invite();
    const rid = next('pr');
    const poll = secret();
    requestPairing(inv, rid, poll);
    devices.decide(rid, true); // approved while zero devices exist
    for (let i = 0; i < 4; i++) fakeDevice(next('fd'));
    expectFail(() => devices.redeem(rid, poll, `red-${rid}`), 'DEVICE_LIMIT', 429);
  });

  it('enforces DEVICE_HISTORY_LIMIT at 128 records', () => {
    const inv = invite();
    const rid = next('pr');
    const poll = secret();
    requestPairing(inv, rid, poll);
    for (let i = 0; i < 128; i++) {
      fakeDevice(next('hd'), { state: 'REVOKED', absoluteExpiry: Date.now() - 1 });
    }
    devices.decide(rid, true);
    expectFail(() => devices.redeem(rid, poll, `red-${rid}`), 'DEVICE_HISTORY_LIMIT', 429);
  });
});

describe('authenticate + authorize', () => {
  it('authenticates a minted access token', () => {
    const { issued } = mintDevice();
    const d = devices.authenticate(issued.accessToken as string);
    expect(d.id).toBe(issued.deviceGrantId);
    expect(d.sessions).toEqual(['sess-1']);
  });

  it('fails ACCESS_UNAUTHORIZED for unknown tokens', () => {
    expectFail(() => devices.authenticate('bogus'), 'ACCESS_UNAUTHORIZED', 401);
  });

  it('distinguishes ACCESS_EXPIRED from DEVICE_EXPIRED', () => {
    const { issued } = mintDevice();
    const did = issued.deviceGrantId as string;
    patch<Device>('device', did, (d) => { d.accessExpiry = Date.now() - 1; });
    expectFail(() => devices.authenticate(issued.accessToken as string), 'ACCESS_EXPIRED', 401);
    patch<Device>('device', did, (d) => { d.accessExpiry = Date.now() + 60_000; d.idleExpiry = Date.now() - 1; });
    expectFail(() => devices.authenticate(issued.accessToken as string), 'DEVICE_EXPIRED', 401);
    patch<Device>('device', did, (d) => { d.idleExpiry = Date.now() + 60_000; d.absoluteExpiry = Date.now() - 1; });
    expectFail(() => devices.authenticate(issued.accessToken as string), 'DEVICE_EXPIRED', 401);
  });

  it('authorize checks session membership and action', () => {
    const { issued } = mintDevice({ sessions: ['sess-1'], actions: ['OBSERVE', 'CONTROL'] });
    expect(devices.authorize(issued.accessToken as string, 'sess-1', 'CONTROL').id)
      .toBe(issued.deviceGrantId);
    expectFail(() => devices.authorize(issued.accessToken as string, 'sess-2', 'CONTROL'),
      'DEVICE_SCOPE_DENIED', 403);
    expectFail(() => devices.authorize(issued.accessToken as string, 'sess-1', 'INTERACT'),
      'DEVICE_SCOPE_DENIED', 403);
    // authorizeDevice rechecks by id without a token
    expect(devices.authorizeDevice(issued.deviceGrantId as string, 'sess-1', 'OBSERVE').id)
      .toBe(issued.deviceGrantId);
    expectFail(() => devices.authorizeDevice(issued.deviceGrantId as string, 'sess-9', 'OBSERVE'),
      'DEVICE_SCOPE_DENIED', 403);
  });

  it('authorizeLocal / authorizeLocalDevice check WORKER_LOCAL resources', () => {
    const { issued } = mintDevice({ resources: [localRes('task-1')], actions: ['OBSERVE', 'INTERACT'] });
    expect(devices.authorizeLocal(issued.accessToken as string, 'wl-1', 'task-1', 'INTERACT').id)
      .toBe(issued.deviceGrantId);
    expectFail(() => devices.authorizeLocal(issued.accessToken as string, 'wl-1', 'task-2', 'INTERACT'),
      'DEVICE_SCOPE_DENIED', 403);
    expectFail(() => devices.authorizeLocal(issued.accessToken as string, 'wl-1', 'task-1', 'CONTROL'),
      'DEVICE_SCOPE_DENIED', 403);
    expect(devices.authorizeLocalDevice(issued.deviceGrantId as string, 'wl-1', 'task-1', 'OBSERVE').id)
      .toBe(issued.deviceGrantId);
  });

  it('authorizeLaunch requires LAUNCH action plus a matching launch scope', () => {
    const { issued } = mintDevice({
      launchScopes: [launch('pi', 'proj-1')],
      actions: ['OBSERVE', 'CONTROL', 'LAUNCH'],
    });
    expect(devices.authorizeLaunch(issued.accessToken as string, 'wl-1', 'proj-1', 'pi').id)
      .toBe(issued.deviceGrantId);
    expectFail(() => devices.authorizeLaunch(issued.accessToken as string, 'wl-1', 'proj-1', 'codex'),
      'DEVICE_SCOPE_DENIED', 403);
    const { issued: noLaunch } = mintDevice();
    expectFail(() => devices.authorizeLaunch(noLaunch.accessToken as string, 'wl-1', 'p', 'pi'),
      'DEVICE_SCOPE_DENIED', 403);
  });

  it('activeDevices skips revoked/expired grants; activeDevice throws on them', () => {
    const a = mintDevice();
    const b = mintDevice();
    devices.revoke(b.issued.deviceGrantId as string);
    const ids = devices.activeDevices().map((d) => d.id);
    expect(ids).toContain(a.issued.deviceGrantId);
    expect(ids).not.toContain(b.issued.deviceGrantId);
    expect(devices.activeDevice(a.issued.deviceGrantId as string).id).toBe(a.issued.deviceGrantId);
    expectFail(() => devices.activeDevice(b.issued.deviceGrantId as string), 'DEVICE_REVOKED', 401);
    expectFail(() => devices.activeDevice('missing'), 'DEVICE_REVOKED', 401);
  });
});

describe('refresh', () => {
  it('rotates tokens and honors the old access token inside a grace window', () => {
    const { issued } = mintDevice();
    const next = devices.refresh(issued.refreshToken as string, 'rr-1');
    expect(next.refreshToken).not.toBe(issued.refreshToken);
    expect(next.accessToken).not.toBe(issued.accessToken);
    expect(next.deviceGrantId).toBe(issued.deviceGrantId);
    // In-flight callers keep working: the previous access token resolves
    // through the grace window instead of 401-ing as "revoked".
    expect(devices.authenticate(issued.accessToken as string).id).toBe(issued.deviceGrantId);
    expect(devices.authenticate(next.accessToken as string).id).toBe(issued.deviceGrantId);
    const d = deviceRecord(issued.deviceGrantId as string);
    expect(d.previousRefreshHash).toBe(hash(issued.refreshToken as string));
    expect(d.spentRefresh).toContain(hash(issued.refreshToken as string));
    expect(d.refreshRequestId).toBe('rr-1');
    expect(d.recoverUntil).toBeGreaterThan(Date.now());
    expect(d.envelope).toBeTruthy();
    expect(d.accessGrace?.map((g) => g.hash)).toContain(hash(issued.accessToken as string));
    // Past the grace window the rotated-out token is dead for real.
    patch<Device>('device', issued.deviceGrantId as string, (d) => {
      d.accessGrace = d.accessGrace?.map((g) => ({ ...g, until: Date.now() - 1 }));
    });
    expectFail(() => devices.authenticate(issued.accessToken as string), 'ACCESS_UNAUTHORIZED', 401);
  });

  it('replays the grace window: same requestId + old secret → identical issued payload', () => {
    const { issued } = mintDevice();
    const rotated = devices.refresh(issued.refreshToken as string, 'rr-2');
    const replay = devices.refresh(issued.refreshToken as string, 'rr-2');
    expect(replay).toEqual(rotated);
    expect(deviceRecord(issued.deviceGrantId as string).state).toBe('ACTIVE');
    // the CURRENT secret under the same request id rotates again (fresh request ids matter)
    const second = devices.refresh(rotated.refreshToken as string, 'rr-3');
    expect(second.refreshToken).not.toBe(rotated.refreshToken);
    // the first secret is now stale beyond grace → committed revocation
    expectFail(() => devices.refresh(issued.refreshToken as string, 'rr-4'), 'REFRESH_REUSE', 401);
    expect(deviceRecord(issued.deviceGrantId as string).state).toBe('REVOKED');
  });

  it('commits REVOKED on refresh reuse and fails REFRESH_REUSE', () => {
    const { issued } = mintDevice();
    const rotated = devices.refresh(issued.refreshToken as string, 'rr-5');
    expectFail(() => devices.refresh(issued.refreshToken as string, 'rr-different'), 'REFRESH_REUSE', 401);
    const d = deviceRecord(issued.deviceGrantId as string);
    expect(d.state).toBe('REVOKED');
    expect(d.revision).toBe(2);
    expect(d.envelope).toBeUndefined();
    // revocation committed even though the call failed
    expectFail(() => devices.authenticate(rotated.accessToken as string), 'DEVICE_REVOKED', 401);
  });

  it('grace replay ends when the recovery window lapses', () => {
    const { issued } = mintDevice();
    devices.refresh(issued.refreshToken as string, 'rr-6');
    patch<Device>('device', issued.deviceGrantId as string, (d) => { d.recoverUntil = Date.now() - 1; });
    expectFail(() => devices.refresh(issued.refreshToken as string, 'rr-6'), 'REFRESH_REUSE', 401);
    expect(deviceRecord(issued.deviceGrantId as string).state).toBe('REVOKED');
  });

  it('fails ACCESS_UNAUTHORIZED for unknown refresh secrets and DEVICE_REVOKED for revoked devices', () => {
    const { issued } = mintDevice();
    expectFail(() => devices.refresh('bogus', 'rr-x'), 'ACCESS_UNAUTHORIZED', 401);
    devices.revoke(issued.deviceGrantId as string);
    expectFail(() => devices.refresh(issued.refreshToken as string, 'rr-y'), 'DEVICE_REVOKED', 401);
  });

  it('fails REPAIR_REQUIRED when spentRefresh exceeds 4096', () => {
    const { issued } = mintDevice();
    patch<Device>('device', issued.deviceGrantId as string, (d) => {
      d.spentRefresh = Array.from({ length: 4096 }, (_, i) => `spent-${i}`);
    });
    expectFail(() => devices.refresh(issued.refreshToken as string, 'rr-cap'), 'REPAIR_REQUIRED', 409);
  });
});

describe('revoke', () => {
  it('marks REVOKED monotonically and clears recovery state', () => {
    const { issued } = mintDevice();
    const rotated = devices.refresh(issued.refreshToken as string, 'rr-v'); // sets envelope/recoverUntil
    devices.revoke(issued.deviceGrantId as string);
    const d = deviceRecord(issued.deviceGrantId as string);
    expect(d.state).toBe('REVOKED');
    expect(d.revision).toBe(2);
    expect(d.envelope).toBeUndefined();
    devices.revoke(issued.deviceGrantId as string); // idempotent — no second bump
    expect(deviceRecord(issued.deviceGrantId as string).revision).toBe(2);
    // the current (post-rotation) access token resolves to the revoked grant
    expectFail(() => devices.authenticate(rotated.accessToken as string), 'DEVICE_REVOKED', 401);
    expectFail(() => devices.revoke('missing'), 'NOT_FOUND', 404);
  });
});

describe('updateScope / updateScopeResources', () => {
  it('CAS-updates a legacy-sessions device and replays by requestId', () => {
    const { issued } = mintDevice({ sessions: ['sess-1'] });
    const did = issued.deviceGrantId as string;
    const view = devices.updateScope(did, 'sc-1', '1', ['sess-2', 'sess-3'], ['OBSERVE', 'INTERACT']);
    expect(view.deviceGrantId).toBe(did);
    expect(view.grantRevision).toBe('2');
    expect(view.scopeVersion).toBe(2);
    expect(view.sessions).toEqual(['sess-2', 'sess-3']);
    expect(view.actions).toEqual(['INTERACT', 'OBSERVE']);
    expect(view.resources).toEqual([
      { kind: 'ACS_SESSION', backendStoreId: devices.hostRecord().storeId, sessionId: 'sess-2' },
      { kind: 'ACS_SESSION', backendStoreId: devices.hostRecord().storeId, sessionId: 'sess-3' },
    ]);
    // exact replay returns the stored result
    expect(devices.updateScope(did, 'sc-1', '1', ['sess-2', 'sess-3'], ['OBSERVE', 'INTERACT']))
      .toEqual(view);
    // payload drift under the same requestId mismatches
    expectFail(
      () => devices.updateScope(did, 'sc-1', '1', ['sess-2'], ['OBSERVE', 'INTERACT']),
      'IDEMPOTENCY_PAYLOAD_MISMATCH', 409,
    );
  });

  it('fails GRANT_REVISION_CONFLICT on a stale expected revision', () => {
    const { issued } = mintDevice();
    expectFail(
      () => devices.updateScope(issued.deviceGrantId as string, 'sc-2', '9', ['s1'], ['OBSERVE']),
      'GRANT_REVISION_CONFLICT', 409,
    );
    expectFail(
      () => devices.updateScope(issued.deviceGrantId as string, 'sc-3', 'abc', ['s1'], ['OBSERVE']),
      'INVALID_REQUEST', 400,
    );
  });

  it('requires the v2 client for devices carrying non-ACS resources or launch scopes', () => {
    const { issued } = mintDevice({ resources: [localRes('t1')] });
    expectFail(
      () => devices.updateScope(issued.deviceGrantId as string, 'sc-4', '1', ['s1'], ['OBSERVE']),
      'SCOPE_V2_CLIENT_REQUIRED', 409,
    );
    const { issued: launched } = mintDevice({
      launchScopes: [launch('pi')], actions: ['OBSERVE', 'LAUNCH'],
    });
    expectFail(
      () => devices.updateScope(launched.deviceGrantId as string, 'sc-5', '1', ['s1'], ['OBSERVE']),
      'SCOPE_V2_CLIENT_REQUIRED', 409,
    );
  });

  it('updateScopeResources replaces the full resource scope', () => {
    const { issued } = mintDevice({ resources: [localRes('t1')] });
    const did = issued.deviceGrantId as string;
    const view = devices.updateScopeResources(
      did, 'sc-6', '1',
      [localRes('t2'), acsRes('s9', devices.hostRecord().storeId)],
      [launch('codex', 'p2')],
      ['OBSERVE', 'CONTROL', 'LAUNCH'],
    );
    expect(view.grantRevision).toBe('2');
    expect(view.sessions).toEqual(['s9']);
    expect(view.launchScopes).toEqual([{ backendStoreId: 'wl-1', projectId: 'p2', engineId: 'codex' }]);
    // validation still applies (LAUNCH ⇔ launch scopes)
    expectFail(
      () => devices.updateScopeResources(did, 'sc-7', '2', [localRes('t3')], [], ['OBSERVE', 'LAUNCH']),
      'INVALID_SCOPE', 400,
    );
  });

  it('evicts the oldest half of scope history at the limit instead of failing', () => {
    const { issued } = mintDevice();
    for (let i = 0; i < 128; i++) {
      store.put('scope-change', `old-${i}`, { fingerprint: `f${i}`, result: '{}', at: i });
    }
    const view = devices.updateScope(issued.deviceGrantId as string, 'sc-8', '1', ['s1'], ['OBSERVE']);
    expect(view.grantRevision).toBe('2');
    // oldest 64 evicted; newest 64 + the fresh record remain.
    expect(store.ids('scope-change')).toHaveLength(65);
    expect(store.get('scope-change', 'old-0')).toBeUndefined();
    expect(store.get('scope-change', 'old-127')).toBeDefined();
  });

  it('evicts legacy scope-change rows (no timestamp) first', () => {
    const { issued } = mintDevice();
    for (let i = 0; i < 128; i++) {
      store.put('scope-change', `old-${i}`, { fingerprint: `f${i}`, result: '{}' });
    }
    const view = devices.updateScope(issued.deviceGrantId as string, 'sc-9', '1', ['s1'], ['OBSERVE']);
    expect(view.grantRevision).toBe('2');
    expect(store.ids('scope-change')).toHaveLength(65);
  });
});

describe('appendLaunchedTask', () => {
  const launched = () => mintDevice({
    launchScopes: [launch('pi', 'proj-1')],
    actions: ['OBSERVE', 'CONTROL', 'LAUNCH'],
  });

  it('appends the exact worker-local resource on revision match', () => {
    const { issued } = launched();
    const did = issued.deviceGrantId as string;
    devices.appendLaunchedTask(did, 1, 'wl-1', 'proj-1', 'pi', 'task-77');
    const d = deviceRecord(did);
    expect(d.revision).toBe(2);
    expect(d.resources).toContainEqual({ kind: 'WORKER_LOCAL', backendStoreId: 'wl-1', taskId: 'task-77' });
    // idempotent — already contained
    devices.appendLaunchedTask(did, 2, 'wl-1', 'proj-1', 'pi', 'task-77');
    expect(deviceRecord(did).revision).toBe(2);
  });

  it('fails GRANT_REVISION_CONFLICT on stale revision, missing LAUNCH or wrong launch triple', () => {
    const { issued } = launched();
    const did = issued.deviceGrantId as string;
    expectFail(() => devices.appendLaunchedTask(did, 9, 'wl-1', 'proj-1', 'pi', 't1'),
      'GRANT_REVISION_CONFLICT', 409);
    expectFail(() => devices.appendLaunchedTask(did, 1, 'wl-1', 'proj-1', 'codex', 't1'),
      'GRANT_REVISION_CONFLICT', 409);
    const { issued: plain } = mintDevice();
    expectFail(() => devices.appendLaunchedTask(plain.deviceGrantId as string, 1, 'wl-1', 'p', 'pi', 't'),
      'GRANT_REVISION_CONFLICT', 409);
  });

  it('enforces SCOPE_RESOURCE_LIMIT at 100 resources', () => {
    const { issued } = launched();
    const did = issued.deviceGrantId as string;
    patch<Device>('device', did, (d) => {
      d.resources = Array.from({ length: 100 }, (_, i) => localRes(`fill-${i}`));
    });
    expectFail(() => devices.appendLaunchedTask(did, 1, 'wl-1', 'proj-1', 'pi', 'overflow'),
      'SCOPE_RESOURCE_LIMIT', 429);
  });
});

describe('owner views', () => {
  it('devices() lists deviceViews; requests() lists pairingViews', () => {
    const { issued, rid } = mintDevice({ label: 'Tablet' });
    const list = devices.devices();
    expect(list).toHaveLength(1);
    expect(list[0].deviceGrantId).toBe(issued.deviceGrantId);
    expect(list[0].label).toBe('Tablet');
    expect(list[0].grantRevision).toBe('1');
    const reqs = devices.requests();
    expect(reqs).toHaveLength(1);
    expect(reqs[0].pairingRequestId).toBe(rid);
    expect(reqs[0].state).toBe('REDEEMED');
  });

  it('host() returns the deviceView plus schema/capabilities block', () => {
    const { issued } = mintDevice({ actions: ['OBSERVE', 'CONTROL', 'APPROVE'] });
    const d = devices.authenticate(issued.accessToken as string);
    const view = devices.host(d, 'boot-1');
    expect(view.schemaVersion).toBe('personal-agent-access/1');
    expect(view.personalHostId).toBe(devices.hostRecord().id);
    expect(view.storeId).toBe(devices.hostRecord().storeId);
    expect(view.bootId).toBe('boot-1');
    expect(view.origin).toBe('https://gw.test');
    const caps = view.capabilities as Json;
    expect(caps.observe).toBe(true);
    expect(caps.control).toBe(true);
    expect(caps.approve).toBe(true);
    expect(caps.interact).toBe(false);
    expect(caps.assign).toBe(false);
    expect(caps.collaborate).toBe(false);
    expect(caps.adopt).toBe(false);
    expect(caps.sse).toBe(false);
    expect(caps.push).toBe(false);
  });
});

describe('cleanup', () => {
  it('deletes invites RECOVERY_TTL past expiry and clears lapsed envelopes', () => {
    // expired invite lives RECOVERY_TTL past expiry then dies
    const inv = invite(['s1'], ['OBSERVE'], 'inv-dead');
    patch<Invite>('invite', inv.inviteId as string, (v) => { v.expiresAt = Date.now() - 121_000; });
    // a redeemed pairing keeps its envelope until recoverUntil lapses
    const { rid } = mintDevice();
    patch<Pairing>('pairing', rid, (p) => { p.recoverUntil = Date.now() - 1; });
    // device envelope cleared once recoverUntil lapses
    const second = mintDevice();
    patch<Device>('device', second.issued.deviceGrantId as string, (d) => {
      d.envelope = 'sealed';
      d.recoverUntil = Date.now() - 1;
    });
    devices.requests(); // cleanup runs inside this transaction
    expect(store.get('invite', inv.inviteId as string)).toBeUndefined();
    expect(pairingRecord(rid).envelope).toBeUndefined();
    expect(deviceRecord(second.issued.deviceGrantId as string).envelope).toBeUndefined();
  });

  it('deletes pairings RECOVERY_TTL past max(expiresAt, recoverUntil) and devices at absoluteExpiry', () => {
    const inv = invite();
    const rid = next('pr');
    requestPairing(inv, rid, secret());
    patch<Pairing>('pairing', rid, (p) => {
      p.expiresAt = Date.now() - 300_000;
      p.recoverUntil = Date.now() - 300_000;
    });
    const { issued } = mintDevice();
    patch<Device>('device', issued.deviceGrantId as string, (d) => { d.absoluteExpiry = Date.now() - 1; });
    devices.requests();
    expect(store.get('pairing', rid)).toBeUndefined();
    expect(store.get('device', issued.deviceGrantId as string)).toBeUndefined();
  });
});
