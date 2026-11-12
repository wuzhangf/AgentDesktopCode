/**
 * Devices — port of the Java PersonalAccessService onto the generic
 * kind→payload GatewayStore. Satisfies the `GatewayAuth` contract in
 * context.ts: every public method returns the Java view object shape as a
 * plain JSON-ready object (pairingView/deviceView/issued/host/ownerStatus/
 * invitation), with grantRevision serialized as a STRING.
 *
 * Lifecycle state lives on the pairing/device records themselves
 * (fingerprint, requestId binding, envelope, refreshRequestId,
 * previousRefreshHash, recoverUntil, accessHash/refreshHash/spentRefresh) —
 * there are no specialized idempotency/recovery/token tables.
 *
 * Record payloads never persist `sessions` (Java write-only field derived on
 * read by normalize()); the personal_scope_v2_* triggers enforce that.
 */
import { randomUUID } from 'node:crypto';
import {
  constantEqual,
  fail,
  GatewayError,
  hash,
  id,
  normalizeScope,
  permitsLaunch,
  scopeContains,
  seal,
  secret,
  text,
  unseal,
  type Device,
  type Host,
  type Invite,
  type LaunchScope,
  type Pairing,
  type Resource,
  type ScopeChange,
  type ScopeRecord,
} from './protocol.js';
import type { GatewayStore } from './store.js';
import {
  acs,
  checkedLaunchScopes,
  checkedResources,
  validateResourceActions,
  validateScope,
} from './scope.js';

export const ACCESS_TTL = 300_000;
export const RECOVERY_TTL = 120_000;
/** Pairing invitations are carried to a person and entered by hand; the
 *  recovery window above is for machine retries, not for humans. */
export const INVITE_TTL = 30 * 60_000;
export const FAMILY_TTL = 30 * 86_400_000;
export const IDLE_TTL = 7 * 86_400_000;

const MAX_ACTIVE_DEVICES = 4;
const MAX_PENDING_INVITES = 4;
const MAX_PENDING_DISCOVERY = 8;
const DEVICE_HISTORY_LIMIT = 128;
const SCOPE_HISTORY_LIMIT = 128;
const SCOPE_RESOURCE_LIMIT = 100;
const SPENT_REFRESH_LIMIT = 4096;

const KEY_CHECK_PLAINTEXT = 'host-key-check';
const POLL_PATTERN = /^[0-9a-f]{64}$/;
const REVISION_PATTERN = /^[1-9][0-9]{0,18}$/;

type Json = Record<string, unknown>;
type KeySource = Uint8Array | (() => Uint8Array) | (() => Uint8Array | undefined);

const sortedActions = (actions: string[] | undefined): string[] =>
  [...new Set(actions ?? [])].sort();

/** Deterministic canonicalization for scope-change/invitation fingerprints. */
const canonical = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object' && value.constructor === Object) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = canonical(v);
    }
    return out;
  }
  return value;
};

const scopeFingerprint = (value: unknown): string => hash(JSON.stringify(canonical(value)));

export class Devices {
  private readonly keyFn: () => Uint8Array | undefined;
  private readonly previousKeyFn: () => Uint8Array | undefined;
  private readonly clock: () => number;
  private readonly origin: string;
  private readonly alternateOrigins: string[];
  private readonly expectedStoreId?: string;
  private storeId = '';

  /**
   * Java constructor shape: (store, key[, previousKey], storeId, origin, clock).
   * storeId/origin/clock are optional: a provided storeId is enforced against
   * the persisted host record (HOST_IDENTITY_CHANGED 503 on mismatch);
   * when absent the persisted host storeId (or a generated one) is used.
   */
  constructor(
    private readonly store: GatewayStore,
    sealKey: KeySource,
    previousSealKey?: KeySource,
    storeId?: string,
    origin?: string,
    clock?: () => number,
    private readonly pairingAutoApprove = false,
    alternateOrigins: string[] = [],
  ) {
    this.keyFn = typeof sealKey === 'function' ? sealKey : () => sealKey;
    this.previousKeyFn = typeof previousSealKey === 'function'
      ? previousSealKey
      : () => previousSealKey as Uint8Array | undefined;
    this.clock = clock ?? (() => Date.now());
    const exactHttps = (value: string): string => {
      const url = new URL(value);
      if (url.protocol !== 'https:' || url.hostname === '' || url.username !== ''
        || url.password !== '' || url.search !== '' || url.hash !== ''
        || !(url.pathname === '' || url.pathname === '/')) {
        throw new Error('Exact HTTPS origin required');
      }
      return value.replace(/\/$/, '');
    };
    this.origin = origin === undefined ? '' : exactHttps(origin);
    // Ordered after the primary origin; phones probe the whole list and use
    // whichever connects (LAN vs tailnet needs no user decision).
    this.alternateOrigins = alternateOrigins.map(exactHttps)
      .filter((o) => o !== this.origin);
    this.expectedStoreId = storeId;
    this.ensureHost();
  }

  private now(): number {
    return this.clock();
  }

  private key(): Uint8Array {
    const key = this.keyFn();
    if (key == null || key.length !== 32) {
      throw new Error('personal access seal key must be 256 bits');
    }
    return key;
  }

  private sealJson(value: unknown): string {
    return seal(JSON.stringify(value), this.key(), this.storeId);
  }

  private unsealJson<T>(envelope: string): T {
    return JSON.parse(this.unseal(envelope)) as T;
  }

  private unseal(envelope: string): string {
    try {
      return unseal(envelope, this.key(), this.storeId);
    } catch (error) {
      const previous = this.previousKeyFn();
      if (previous != null && previous.length === 32) {
        return unseal(envelope, previous, this.storeId);
      }
      throw error;
    }
  }

  // -------------------------------------------------------------------------
  // Host identity / key check (Java constructor bootstrap + Host record)
  // -------------------------------------------------------------------------

  /**
   * Contract entry point (GatewayAuth.ensureHost): run the Java constructor
   * bootstrap idempotently. Use hostRecord() when the record itself is needed.
   */
  ensureHost(): void {
    this.bootstrapHost();
  }

  /** Current persisted host record (Java store.get 'host'/'identity'). */
  hostRecord(): Host {
    return this.requireHost();
  }

  /**
   * Java constructor bootstrap: create or verify the 'host'/'identity' record,
   * verify seal-key continuity via keyCheck, then upgrade every scoped record
   * under the same transaction.
   */
  private bootstrapHost(): Host {
    return this.store.transaction(() => {
      let h = this.store.get<Host>('host', 'identity');
      if (h == null) {
        h = {
          id: randomUUID(),
          storeId: this.expectedStoreId ?? `pa-${secret()}`,
        };
        this.storeId = h.storeId;
        h.keyCheck = seal(KEY_CHECK_PLAINTEXT, this.key(), h.storeId);
        this.store.put('host', 'identity', h);
      } else {
        this.storeId = h.storeId;
        if (this.expectedStoreId !== undefined && this.expectedStoreId !== h.storeId) {
          fail('HOST_IDENTITY_CHANGED', 503);
        }
        if (!this.keyCheckOk()) {
          const previous = this.previousKeyFn();
          let rotated = false;
          if (previous != null && previous.length === 32) {
            try {
              if (unseal(h.keyCheck!, previous, h.storeId) === KEY_CHECK_PLAINTEXT) {
                h.keyCheck = seal(KEY_CHECK_PLAINTEXT, this.key(), h.storeId);
                this.store.put('host', 'identity', h);
                rotated = true;
              }
            } catch { /* previous key does not match either */ }
          }
          if (!rotated) fail('STORE_KEY_INVALID', 500);
        }
      }
      // Upgrade under the same transaction — a previous binary cannot
      // silently drop new scope restrictions.
      for (const value of this.store.list<Invite>('invite')) this.putScope('invite', value.id, value);
      for (const value of this.store.list<Pairing>('pairing')) this.putScope('pairing', value.id, value);
      for (const value of this.store.list<Device>('device')) this.putScope('device', value.id, value);
      return h;
    });
  }

  /** True when the persisted keyCheck unseals with the current key. */
  keyCheckOk(): boolean {
    const h = this.store.get<Host>('host', 'identity');
    if (h?.keyCheck == null) return false;
    try {
      return unseal(h.keyCheck, this.key(), h.storeId) === KEY_CHECK_PLAINTEXT;
    } catch {
      return false;
    }
  }

  private requireHost(): Host {
    const h = this.store.get<Host>('host', 'identity');
    if (h == null) fail('HOST_IDENTITY_CHANGED', 503);
    return h;
  }

  // -------------------------------------------------------------------------
  // Invitations (owner-facing)
  // -------------------------------------------------------------------------

  invitation(requestId: string, sessions: string[], actions: string[], fingerprint: string): Json {
    validateScope(sessions, actions);
    return this.invitationScoped(
      requestId, acs(this.storeId, sessions), [], actions, fingerprint,
      scopeFingerprint([sessions, sortedActions(actions)]),
    );
  }

  invitationResources(
    requestId: string,
    resources: Resource[],
    launchScopes: LaunchScope[],
    actions: string[],
    fingerprint: string,
  ): Json {
    const checked = checkedResources(this.storeId, resources);
    const launches = checkedLaunchScopes(launchScopes);
    validateResourceActions(checked, launches, actions);
    return this.invitationScoped(
      requestId, checked, launches, actions, fingerprint,
      scopeFingerprint([checked, launches, sortedActions(actions)]),
    );
  }

  /** Owner read-only recovery: never cleanup, recreate, rotate secrets, or extend TTL. */
  invitationById(requestId: string): Json {
    id(requestId);
    const invite = this.store.get<Invite>('invite', requestId);
    if (invite == null) fail('NOT_FOUND', 404);
    if (invite.expiresAt <= this.now()) fail('PAIRING_EXPIRED', 410);
    if (!invite.envelope) fail('PAIRING_RECOVERY_UNAVAILABLE', 409);
    return this.unsealJson<Json>(invite.envelope);
  }

  private invitationScoped(
    requestId: string,
    resources: Resource[],
    launches: LaunchScope[],
    actions: string[],
    fingerprint: string,
    fp: string,
  ): Json {
    id(requestId);
    return this.store.transaction(() => {
      this.cleanup();
      const old = this.store.get<Invite>('invite', requestId);
      if (old != null) {
        if (fp !== old.fingerprint) fail('IDEMPOTENCY_PAYLOAD_MISMATCH', 409);
        if (old.expiresAt <= this.now()) fail('PAIRING_EXPIRED', 410);
        return this.unsealJson<Json>(old.envelope!);
      }
      // A never-claimed invite holds a slot yet proves nothing — supersede it
      // so a fresh QR always unsticks the owner after abandoned attempts.
      for (const item of this.store.list<Invite>('invite')) {
        if (item.requestId == null && item.expiresAt > this.now()) {
          item.expiresAt = this.now();
          this.putScope('invite', item.id, item);
        }
      }
      let pending = 0;
      for (const item of this.store.list<Invite>('invite')) {
        if (item.expiresAt <= this.now()) continue;
        const state = item.requestId == null ? undefined : this.store.get<Pairing>('pairing', item.requestId)?.state;
        if (state !== 'REDEEMED' && state !== 'REJECTED') pending++;
      }
      if (pending >= MAX_PENDING_INVITES) fail('PAIRING_LIMIT', 429);
      const value: Invite = {
        id: requestId,
        expiresAt: this.now() + INVITE_TTL,
        resources,
        launchScopes: launches,
        actions: sortedActions(actions),
        fingerprint: fp,
      };
      const inviteSecret = secret();
      value.secretHash = hash(inviteSecret);
      const host = this.requireHost();
      const out: Json = {
        schemaVersion: 'personal-pairing-invite/1',
        origin: this.origin,
        ...(this.alternateOrigins.length === 0 ? {}
          : { origins: [this.origin, ...this.alternateOrigins] }),
        personalHostId: host.id,
        storeId: this.storeId,
        inviteId: value.id,
        inviteSecret,
        expiresAt: value.expiresAt,
        certificateSha256: fingerprint,
      };
      value.envelope = this.sealJson(out);
      this.putScope('invite', value.id, value);
      return out;
    });
  }

  // -------------------------------------------------------------------------
  // Pairing (device-facing)
  // -------------------------------------------------------------------------

  request(body: Json): Json {
    const rid = text(body, 'pairingRequestId');
    const inviteId = text(body, 'inviteId');
    const poll = text(body, 'pollingSecretHash');
    id(rid);
    id(inviteId);
    const installation = text(body, 'installationId');
    id(installation);
    const label = text(body, 'label');
    if (label.length > 80 || !POLL_PATTERN.test(poll)) fail('INVALID_REQUEST', 400);
    return this.store.transaction(() => {
      const i = this.store.get<Invite>('invite', inviteId);
      if (i != null) normalizeScope(i, this.storeId);
      if (i == null || !constantEqual(i.secretHash, hash(text(body, 'inviteSecret')))) {
        fail('PAIRING_UNAUTHORIZED', 401);
      }
      if (i.expiresAt <= this.now()) fail('PAIRING_EXPIRED', 410);
      const fp = hash(JSON.stringify([inviteId, installation, label, poll]));
      const previous = this.store.get<Pairing>('pairing', rid);
      if (previous != null) {
        if (fp !== previous.fingerprint) fail('IDEMPOTENCY_PAYLOAD_MISMATCH', 409);
        return this.pairingView(previous);
      }
      if (i.requestId != null) fail('INVITATION_BOUND', 409);
      // Auto-approve: possession of the invite secret (carried in the QR the
      // owner just generated) is the authorization, so the pairing skips the
      // PENDING owner decision. The active-device cap still applies.
      if (this.pairingAutoApprove) this.requireDeviceSlot();
      i.requestId = rid;
      this.putScope('invite', i.id, i);
      const p: Pairing = {
        id: rid,
        inviteId: i.id,
        installationId: installation,
        label,
        pollHash: poll,
        fingerprint: fp,
        expiresAt: i.expiresAt,
        state: this.pairingAutoApprove ? 'APPROVED' : 'PENDING',
        checkWords: hash(`${rid}:${inviteId}`).substring(0, 12),
        recoverUntil: 0,
        resources: i.resources,
        launchScopes: i.launchScopes,
        actions: i.actions,
      };
      this.store.put('pairing', rid, p);
      return this.pairingView(p);
    });
  }

  /**
   * Member-attested pairing — relay ingress already proves member
   * authorization, so there is no invitation to redeem. The pairing record
   * snapshots the caller-supplied member scope and is created APPROVED;
   * observe/redemption/polling semantics are identical to invite pairing.
   */
  memberRequest(body: Json, scope: ScopeRecord): Json {
    const rid = text(body, 'pairingRequestId');
    const installation = text(body, 'installationId');
    const label = text(body, 'label');
    const poll = text(body, 'pollingSecretHash');
    id(rid);
    id(installation);
    if (label.length > 80 || !POLL_PATTERN.test(poll)) fail('INVALID_REQUEST', 400);
    return this.store.transaction(() => {
      this.cleanup();
      const fp = hash(JSON.stringify(['member', installation, label, poll]));
      const previous = this.store.get<Pairing>('pairing', rid);
      if (previous != null) {
        if (fp !== previous.fingerprint) fail('IDEMPOTENCY_PAYLOAD_MISMATCH', 409);
        return this.pairingView(previous);
      }
      this.requireDeviceSlot();
      const p: Pairing = {
        id: rid,
        installationId: installation,
        label,
        pollHash: poll,
        fingerprint: fp,
        expiresAt: this.now() + INVITE_TTL,
        state: 'APPROVED',
        checkWords: hash(`member:${rid}`).substring(0, 12),
        recoverUntil: 0,
        resources: scope.resources ?? [],
        launchScopes: scope.launchScopes ?? [],
        actions: sortedActions(scope.actions),
      };
      this.store.put('pairing', rid, p);
      return this.pairingView(p);
    });
  }

  /**
   * LAN discovery pairing — a Bonjour-discovered phone has no sealed invite,
   * and LAN presence alone proves nothing (shared networks are hostile), so
   * the request is created PENDING and the owner decides through the normal
   * pairing-requests surface. Scope is the same local catalog member pairing
   * grants: the owner's explicit approval is the grant.
   */
  discoveryRequest(body: Json, scope: ScopeRecord): Json {
    const rid = text(body, 'pairingRequestId');
    const installation = text(body, 'installationId');
    const label = text(body, 'label');
    const poll = text(body, 'pollingSecretHash');
    id(rid);
    id(installation);
    if (label.length > 80 || !POLL_PATTERN.test(poll)) fail('INVALID_REQUEST', 400);
    return this.store.transaction(() => {
      this.cleanup();
      const fp = hash(JSON.stringify(['discovery', installation, label, poll]));
      const previous = this.store.get<Pairing>('pairing', rid);
      if (previous != null) {
        if (fp !== previous.fingerprint) fail('IDEMPOTENCY_PAYLOAD_MISMATCH', 409);
        return this.pairingView(previous);
      }
      // A retry from the same installation orphans its previous unanswered
      // ask — expire it so repeated attempts cannot self-lock the owner's
      // pending list. Cap what remains: a hostile LAN client must not flood.
      // Member pairings never sit PENDING.
      for (const p of this.store.list<Pairing>('pairing')) {
        if (p.state === 'PENDING' && p.inviteId == null && p.installationId === installation && p.id !== rid) {
          p.expiresAt = this.now();
          this.putScope('pairing', p.id, p);
        }
      }
      const pending = this.store.list<Pairing>('pairing')
        .filter((p) => p.state === 'PENDING' && p.inviteId == null && p.expiresAt > this.now()).length;
      if (pending >= MAX_PENDING_DISCOVERY) fail('PAIRING_LIMIT', 429);
      const p: Pairing = {
        id: rid,
        installationId: installation,
        label,
        pollHash: poll,
        fingerprint: fp,
        expiresAt: this.now() + INVITE_TTL,
        state: 'PENDING',
        checkWords: hash(`discovery:${rid}`).substring(0, 12),
        recoverUntil: 0,
        resources: scope.resources ?? [],
        launchScopes: scope.launchScopes ?? [],
        actions: sortedActions(scope.actions),
      };
      this.store.put('pairing', rid, p);
      return this.pairingView(p);
    });
  }

  observePairing(rid: string, poll: string): Json {
    return this.store.transaction(() => this.pairingView(this.pairing(rid, poll)));
  }

  requests(): Json[] {
    return this.store.transaction(() => {
      this.cleanup();
      return this.store.list<Pairing>('pairing').map((p) => this.pairingView(p));
    });
  }

  /** Owner approve/reject. Same-state replay is idempotent; opposite → PAIRING_DECIDED. */
  decide(rid: string, approve: boolean): Json {
    id(rid);
    return this.store.transaction(() => {
      const p = this.store.get<Pairing>('pairing', rid);
      if (p == null) fail('NOT_FOUND', 404);
      if (p.expiresAt <= this.now()) fail('PAIRING_EXPIRED', 410);
      const next = approve ? 'APPROVED' : 'REJECTED';
      if (p.state !== 'PENDING') {
        if (next !== p.state) fail('PAIRING_DECIDED', 409);
        return this.pairingView(p);
      }
      if (approve) {
        this.requireDeviceSlot();
      }
      p.state = next;
      this.store.put('pairing', rid, p);
      return this.pairingView(p);
    });
  }

  /** Active-device cap shared by request() auto-approve and owner approve. */
  private requireDeviceSlot(): void {
    let active = 0;
    for (const d of this.store.list<Device>('device')) {
      if (d.state === 'ACTIVE' && d.absoluteExpiry > this.now()) active++;
    }
    if (active >= MAX_ACTIVE_DEVICES) fail('DEVICE_LIMIT', 429);
  }

  redeem(rid: string, poll: string, redemptionId: string): Json {
    id(redemptionId);
    return this.store.transaction(() => {
      const p = this.pairing(rid, poll);
      if (p.state === 'REDEEMED') {
        const d = this.store.get<Device>('device', p.deviceId!);
        this.active(d);
        if (redemptionId !== p.redemptionId) fail('PAIRING_REDEEMED', 409);
        if (p.recoverUntil <= this.now() || p.envelope == null) fail('RECOVERY_EXPIRED', 410);
        return this.unsealJson<Json>(p.envelope);
      }
      if (p.state !== 'APPROVED') fail('PAIRING_NOT_APPROVED', 409);
      const devices = this.store.list<Device>('device');
      if (devices.length >= DEVICE_HISTORY_LIMIT) fail('DEVICE_HISTORY_LIMIT', 429);
      let activeCount = 0;
      for (const current of devices) {
        if (current.state === 'ACTIVE' && current.absoluteExpiry > this.now()) activeCount++;
      }
      if (activeCount >= MAX_ACTIVE_DEVICES) fail('DEVICE_LIMIT', 429);
      // Member-attested pairings carry their scope on the pairing record
      // itself — there is no invitation row to re-read.
      const granted: ScopeRecord = p.inviteId != null
        ? this.store.get<Invite>('invite', p.inviteId)!
        : p;
      normalizeScope(granted, this.storeId);
      const d: Device = {
        id: randomUUID(),
        label: p.label,
        installationId: p.installationId,
        resources: granted.resources,
        launchScopes: granted.launchScopes,
        actions: granted.actions,
        state: 'ACTIVE',
        revision: 1,
        scopeVersion: 2,
        absoluteExpiry: this.now() + FAMILY_TTL,
        idleExpiry: this.now() + IDLE_TTL,
        recoverUntil: 0,
        spentRefresh: [],
        accessExpiry: 0,
      };
      const issued = this.issue(d);
      this.putScope('device', d.id, d);
      p.deviceId = d.id;
      p.state = 'REDEEMED';
      p.redemptionId = redemptionId;
      p.envelope = this.sealJson(issued);
      p.recoverUntil = this.now() + RECOVERY_TTL;
      this.putScope('pairing', p.id, p);
      return issued;
    });
  }

  // -------------------------------------------------------------------------
  // Tokens
  // -------------------------------------------------------------------------

  refresh(token: string, requestId: string): Json {
    id(requestId);
    const digest = hash(token);
    // A detected reuse must commit revocation before returning an error.
    const result = this.store.transaction(() => {
      for (const d of this.store.list<Device>('device')) {
        if (digest !== d.refreshHash && !(d.spentRefresh ?? []).includes(digest)) continue;
        this.active(d);
        if (digest === d.refreshHash) {
          (d.spentRefresh ??= []).push(digest);
          if (d.spentRefresh.length > SPENT_REFRESH_LIMIT) fail('REPAIR_REQUIRED', 409);
          const issued = this.issue(d);
          d.refreshRequestId = requestId;
          d.previousRefreshHash = digest;
          d.recoverUntil = this.now() + RECOVERY_TTL;
          d.envelope = this.sealJson(issued);
          d.idleExpiry = Math.min(this.now() + IDLE_TTL, d.absoluteExpiry);
          this.putScope('device', d.id, d);
          return issued;
        }
        if (digest === d.previousRefreshHash && requestId === d.refreshRequestId
          && d.recoverUntil > this.now()) {
          return this.unsealJson<Json>(d.envelope!);
        }
        d.state = 'REVOKED';
        d.revision++;
        d.envelope = undefined;
        this.putScope('device', d.id, d);
        return { reused: true, deviceGrantId: d.id };
      }
      return fail('ACCESS_UNAUTHORIZED', 401);
    });
    if (result.reused === true) fail('REFRESH_REUSE', 401);
    return result;
  }

  authenticate(token: string): Device {
    const digest = hash(token);
    return this.store.transaction(() => {
      for (const d of this.store.list<Device>('device')) {
        if (constantEqual(d.accessHash, digest)) {
          this.active(d);
          if (d.accessExpiry <= this.now()) fail('ACCESS_EXPIRED', 401);
          return d;
        }
      }
      return fail('ACCESS_UNAUTHORIZED', 401);
    });
  }

  authorize(token: string, sessionId: string, action: string): Device {
    const d = this.authenticate(token);
    if (!(d.sessions ?? []).includes(sessionId) || !(d.actions ?? []).includes(action)) {
      fail('DEVICE_SCOPE_DENIED', 403);
    }
    return d;
  }

  /** Recheck an admitted background input against the current grant, not a rotated access token. */
  authorizeDevice(deviceId: string, sessionId: string, action: string): Device {
    return this.store.transaction(() => {
      const d = this.store.get<Device>('device', deviceId);
      this.active(d);
      if (!(d.sessions ?? []).includes(sessionId) || !(d.actions ?? []).includes(action)) {
        fail('DEVICE_SCOPE_DENIED', 403);
      }
      return d;
    });
  }

  authorizeLocal(token: string, backendStoreId: string, taskId: string, action: string): Device {
    const d = this.authenticate(token);
    if (!(d.actions ?? []).includes(action)
      || !scopeContains(d, 'WORKER_LOCAL', backendStoreId, taskId)) {
      fail('DEVICE_SCOPE_DENIED', 403);
    }
    return d;
  }

  /** Recheck a native resource for a background projection without retaining a bearer token. */
  authorizeLocalDevice(deviceId: string, backendStoreId: string, taskId: string, action: string): Device {
    return this.store.transaction(() => {
      const d = this.store.get<Device>('device', deviceId);
      this.active(d);
      if (!(d.actions ?? []).includes(action)
        || !scopeContains(d, 'WORKER_LOCAL', backendStoreId, taskId)) {
        fail('DEVICE_SCOPE_DENIED', 403);
      }
      return d;
    });
  }

  authorizeLaunch(token: string, backendStoreId: string, projectId: string, engineId: string): Device {
    const d = this.authenticate(token);
    if (!(d.actions ?? []).includes('LAUNCH')
      || !permitsLaunch(d, backendStoreId, projectId, engineId)) {
      fail('DEVICE_SCOPE_DENIED', 403);
    }
    return d;
  }

  /** Snapshot active grants for bounded background projections. */
  activeDevices(): Device[] {
    return this.store.transaction(() => {
      const out: Device[] = [];
      for (const d of this.store.list<Device>('device')) {
        try {
          this.active(d);
          out.push(d);
        } catch (error) {
          if (!(error instanceof GatewayError)) throw error;
        }
      }
      return out;
    });
  }

  /** Current record for one grant; throws when the device is revoked or expired. */
  activeDevice(deviceId: string): Device {
    id(deviceId);
    return this.store.transaction(() => {
      const d = this.store.get<Device>('device', deviceId);
      this.active(d);
      return d;
    });
  }

  revoke(deviceId: string): void {
    id(deviceId);
    this.store.transaction(() => {
      const d = this.store.get<Device>('device', deviceId);
      if (d == null) fail('NOT_FOUND', 404);
      if (d.state !== 'REVOKED') {
        d.state = 'REVOKED';
        d.revision++;
        d.envelope = undefined;
        this.putScope('device', deviceId, d);
      }
    });
  }

  /** Only a proven original launch may append its exact task; unrelated project tasks remain denied. */
  appendLaunchedTask(
    deviceId: string,
    expectedRevision: number,
    backendStoreId: string,
    projectId: string,
    engineId: string,
    taskId: string,
  ): void {
    id(taskId);
    this.store.transaction(() => {
      const d = this.store.get<Device>('device', deviceId);
      this.active(d);
      if (scopeContains(d, 'WORKER_LOCAL', backendStoreId, taskId)) return;
      if (d.revision !== expectedRevision
        || !(d.actions ?? []).includes('LAUNCH')
        || !permitsLaunch(d, backendStoreId, projectId, engineId)) {
        fail('GRANT_REVISION_CONFLICT', 409);
      }
      if ((d.resources ?? []).length >= SCOPE_RESOURCE_LIMIT) fail('SCOPE_RESOURCE_LIMIT', 429);
      d.resources = [...(d.resources ?? []), { kind: 'WORKER_LOCAL', backendStoreId, taskId }];
      d.revision++;
      this.putScope('device', deviceId, d);
    });
  }

  // -------------------------------------------------------------------------
  // Owner CAS scope updates — durable exact replay.
  // -------------------------------------------------------------------------

  updateScope(
    deviceId: string,
    requestId: string,
    expectedRevision: string,
    sessions: string[],
    actions: string[],
  ): Json {
    validateScope(sessions, actions);
    this.store.transaction(() => {
      if (this.store.get<ScopeChange>('scope-change', requestId) != null) return;
      const current = this.store.get<Device>('device', deviceId);
      this.active(current);
      if ((current.launchScopes ?? []).length > 0
        || (current.resources ?? []).some((r) => r.kind !== 'ACS_SESSION')) {
        fail('SCOPE_V2_CLIENT_REQUIRED', 409);
      }
    });
    return this.updateScopeChecked(
      deviceId, requestId, expectedRevision,
      acs(this.storeId, sessions), [], actions,
      scopeFingerprint([deviceId, expectedRevision, sessions, sortedActions(actions)]),
    );
  }

  updateScopeResources(
    deviceId: string,
    requestId: string,
    expectedRevision: string,
    resources: Resource[],
    launchScopes: LaunchScope[],
    actions: string[],
  ): Json {
    const checked = checkedResources(this.storeId, resources);
    const launches = checkedLaunchScopes(launchScopes);
    validateResourceActions(checked, launches, actions);
    return this.updateScopeChecked(
      deviceId, requestId, expectedRevision,
      checked, launches, actions,
      scopeFingerprint([deviceId, expectedRevision, checked, launches, sortedActions(actions)]),
    );
  }

  private updateScopeChecked(
    deviceId: string,
    requestId: string,
    expectedRevision: string,
    resources: Resource[],
    launches: LaunchScope[],
    actions: string[],
    fp: string,
  ): Json {
    id(deviceId);
    id(requestId);
    if (expectedRevision == null || !REVISION_PATTERN.test(expectedRevision)) {
      fail('INVALID_REQUEST', 400);
    }
    return this.store.transaction(() => {
      const old = this.store.get<ScopeChange>('scope-change', requestId);
      if (old != null) {
        if (fp !== old.fingerprint) fail('IDEMPOTENCY_PAYLOAD_MISMATCH', 409);
        return JSON.parse(old.result) as Json;
      }
      const d = this.store.get<Device>('device', deviceId);
      this.active(d);
      if (String(d.revision) !== expectedRevision) fail('GRANT_REVISION_CONFLICT', 409);
      if (this.store.list<ScopeChange>('scope-change').length >= SCOPE_HISTORY_LIMIT) {
        fail('SCOPE_HISTORY_LIMIT', 429);
      }
      d.resources = resources;
      d.launchScopes = launches;
      d.actions = sortedActions(actions);
      d.scopeVersion = 2;
      d.revision++;
      this.putScope('device', deviceId, d);
      const result = this.deviceView(d);
      const change: ScopeChange = { fingerprint: fp, result: JSON.stringify(result) };
      this.store.put('scope-change', requestId, change);
      return result;
    });
  }

  // -------------------------------------------------------------------------
  // Owner views
  // -------------------------------------------------------------------------

  devices(): Json[] {
    return this.store.transaction(() =>
      this.store.list<Device>('device').map((d) => this.deviceView(d)));
  }

  ownerStatus(): Json {
    return this.store.transaction(() => {
      const h = this.requireHost();
      return {
        enabled: true,
        personalHostId: h.id,
        storeId: this.storeId,
        origin: this.origin,
      };
    });
  }

  host(d: Device, bootId: string): Json {
    return this.store.transaction(() => {
      const h = this.requireHost();
      const actions = d.actions ?? [];
      return {
        ...this.deviceView(d),
        schemaVersion: 'personal-agent-access/1',
        personalHostId: h.id,
        storeId: this.storeId,
        bootId,
        origin: this.origin,
        capabilities: {
          observe: true,
          control: actions.includes('CONTROL'),
          interact: actions.includes('INTERACT'),
          approve: actions.includes('APPROVE'),
          assign: actions.includes('ASSIGN'),
          collaborate: actions.includes('COLLABORATE'),
          adopt: actions.includes('ADOPT'),
          sse: false,
          push: false,
        },
      };
    });
  }

  // -------------------------------------------------------------------------
  // Internals — views, token issue, scope normalization, cleanup.
  // -------------------------------------------------------------------------

  private issue(d: Device): Json {
    const accessToken = secret();
    const refreshToken = secret();
    d.accessHash = hash(accessToken);
    d.accessExpiry = this.now() + ACCESS_TTL;
    d.refreshHash = hash(refreshToken);
    return {
      deviceGrantId: d.id,
      grantRevision: String(d.revision),
      accessToken,
      refreshToken,
      accessExpiresAt: d.accessExpiry,
    };
  }

  private pairing(rid: string, poll: string): Pairing {
    id(rid);
    const p = this.store.get<Pairing>('pairing', rid);
    if (p == null || !constantEqual(p.pollHash, hash(poll))) fail('PAIRING_UNAUTHORIZED', 401);
    if (p.expiresAt <= this.now() && p.state !== 'REDEEMED') fail('PAIRING_EXPIRED', 410);
    return p;
  }

  private pairingView(p: Pairing): Json {
    normalizeScope(p, this.storeId);
    const state = p.expiresAt <= this.now() && p.state !== 'REDEEMED' ? 'EXPIRED' : p.state;
    const out: Json = {
      pairingRequestId: p.id,
      label: p.label ?? null,
      state: state ?? null,
      checkWords: p.checkWords ?? null,
      expiresAt: p.expiresAt,
      sessions: p.sessions ?? [],
      actions: p.actions ?? [],
      resources: p.resources ?? [],
      launchScopes: p.launchScopes ?? [],
    };
    if (p.deviceId != null) out.deviceGrantId = p.deviceId;
    return out;
  }

  private deviceView(d: Device): Json {
    normalizeScope(d, this.storeId);
    return {
      deviceGrantId: d.id,
      label: d.label ?? null,
      state: d.state ?? null,
      grantRevision: String(d.revision),
      scopeVersion: d.scopeVersion ?? 1,
      sessions: d.sessions ?? [],
      actions: d.actions ?? [],
      resources: d.resources ?? [],
      launchScopes: d.launchScopes ?? [],
    };
  }

  private active(d: Device | null | undefined): asserts d is Device {
    if (d != null) normalizeScope(d, this.storeId);
    if (d == null || d.state !== 'ACTIVE') fail('DEVICE_REVOKED', 401);
    if (d.absoluteExpiry <= this.now() || d.idleExpiry <= this.now()) fail('DEVICE_EXPIRED', 401);
  }

  /**
   * Java cleanup(): invites die RECOVERY_TTL past expiry; pairing/device
   * envelopes are cleared once the recovery window lapses; pairings die
   * RECOVERY_TTL past max(expiresAt, recoverUntil); devices die at
   * absoluteExpiry. Runs inside invitationScoped() and requests() writes.
   */
  private cleanup(): void {
    const now = this.now();
    for (const i of this.store.list<Invite>('invite')) {
      if (i.expiresAt + RECOVERY_TTL < now) this.store.delete('invite', i.id);
    }
    for (const p of this.store.list<Pairing>('pairing')) {
      if (p.recoverUntil <= now) {
        p.envelope = undefined;
        this.putScope('pairing', p.id, p);
      }
      if (Math.max(p.expiresAt, p.recoverUntil) + RECOVERY_TTL < now) {
        this.store.delete('pairing', p.id);
      }
    }
    for (const d of this.store.list<Device>('device')) {
      if (d.recoverUntil <= now && d.envelope != null) {
        d.envelope = undefined;
        this.putScope('device', d.id, d);
      }
      if (d.absoluteExpiry < now) this.store.delete('device', d.id);
    }
  }

  /**
   * Java putScope(): normalize scope fields, clamp legacy devices to
   * scopeVersion 2 (retaining only OBSERVE/CONTROL), and persist the record
   * without the write-only `sessions` field (required by the
   * personal_scope_v2_* triggers).
   */
  private putScope(kind: string, id: string, value: ScopeRecord): void {
    normalizeScope(value, this.storeId);
    if (kind === 'device') {
      const d = value as Device;
      if ((d.scopeVersion ?? 1) < 2) {
        d.actions = (d.actions ?? []).filter((a) => a === 'OBSERVE' || a === 'CONTROL');
        d.scopeVersion = 2;
      }
    }
    this.store.put(kind, id, { ...value, sessions: undefined });
  }
}
