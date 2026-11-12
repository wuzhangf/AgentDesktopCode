/**
 * Per-device client-session bindings — port of PersonalAccessServer's
 * `bindings` map + binding()/release().
 *
 * Java registers an ephemeral client-session token per device through
 * ClientSessionRegistry and revokes it in release(); the ACS upstream then
 * accepts the token on X-CodeAgent-Client-Token (session foundation and
 * device-scoped routes answer CLIENT_REGISTRATION_REQUIRED for unknown
 * tokens). The standalone gateway has no in-process registry, so the first
 * call for a device registers over the ACS owner channel
 * (POST /api/v2/client-sessions) and caches the issued token; release()
 * revokes via DELETE on the same route.
 *
 * The issued lease is short (ttlMillis ≈ 90s): bindingFor heartbeats the
 * registration when the remaining TTL drops under HEARTBEAT_MARGIN_MILLIS
 * (POST .../heartbeat extends expiresAt), and a heartbeat rejected upstream
 * (401/404/410 — expired, revoked, or unknown after an ACS restart) falls
 * through to a fresh registration with a NEW registrationKey — replaying the
 * old key after its registration TTL answers REGISTRATION_EXPIRED.
 *
 * Documented deviation: nothing survives restart, matching Java's in-memory
 * map — the first call after a restart simply registers again.
 */
import { fail } from './protocol.js';
import type { Device } from './protocol.js';
import type { GatewayContext } from './context.js';

interface BindingRecord {
  clientSessionId: string;
  token: string;
  /** Wall-clock ms when ACS stops accepting the token. */
  expiresAt: number;
}

interface BindingSlot {
  record?: BindingRecord;
  pending?: Promise<BindingRecord>;
}

const BINDINGS = new WeakMap<object, Map<string, BindingSlot>>();

/** Re-lease this far ahead of the stated expiry — sync and clock slack. */
const HEARTBEAT_MARGIN_MILLIS = 15_000;

const parseRecord = (body: Uint8Array): BindingRecord => {
  let parsed: { clientSessionId?: string; clientSessionToken?: string; remainingTtlMillis?: number };
  try {
    parsed = JSON.parse(Buffer.from(body).toString('utf8'));
  } catch {
    fail('UPSTREAM_UNAVAILABLE', 503);
  }
  if (typeof parsed!.clientSessionId !== 'string' || parsed!.clientSessionId === ''
    || typeof parsed!.clientSessionToken !== 'string' || parsed!.clientSessionToken === ''
    || typeof parsed!.remainingTtlMillis !== 'number') {
    fail('UPSTREAM_UNAVAILABLE', 503);
  }
  return {
    clientSessionId: parsed!.clientSessionId!,
    token: parsed!.clientSessionToken!,
    expiresAt: Date.now() + parsed!.remainingTtlMillis!,
  };
};

const register = async (ctx: GatewayContext, device: Device): Promise<BindingRecord> => {
  if (ctx.acs === undefined) fail('UPSTREAM_UNAVAILABLE', 503);
  const registrationKey = crypto.randomUUID();
  const body = new TextEncoder().encode(JSON.stringify({
    registrationKey,
    clientId: device.id,
    processInstanceId: crypto.randomUUID(),
    clientKind: 'MOBILE',
    protocols: ['business-codeagent/2'],
    displayLabel: device.label,
  }));
  const reply = await ctx.acs.call('POST', '/api/v2/client-sessions', body, registrationKey, undefined);
  if (reply.status !== 201) fail('UPSTREAM_UNAVAILABLE', 503);
  return parseRecord(reply.body);
};

/**
 * Java registry.heartbeat(): extends the lease. Returns false when the lease
 * is already gone upstream (expired/revoked/unknown → caller re-registers),
 * throws UPSTREAM_UNAVAILABLE on 5xx or a malformed 200.
 */
const heartbeat = async (ctx: GatewayContext, record: BindingRecord): Promise<boolean> => {
  const reply = await ctx.acs!.call('POST',
    `/api/v2/client-sessions/${record.clientSessionId}/heartbeat`,
    undefined, crypto.randomUUID(), record.token);
  if (reply.status === 401 || reply.status === 404 || reply.status === 410) return false;
  if (reply.status !== 200) fail('UPSTREAM_UNAVAILABLE', 503);
  let parsed: { remainingTtlMillis?: number };
  try {
    parsed = JSON.parse(Buffer.from(reply.body).toString('utf8'));
  } catch {
    fail('UPSTREAM_UNAVAILABLE', 503);
  }
  record.expiresAt = Date.now() + (parsed!.remainingTtlMillis ?? 0);
  return true;
};

const acquire = async (ctx: GatewayContext, device: Device, slot: BindingSlot): Promise<BindingRecord> => {
  // A locally-expired lease heartbeats 401 upstream for sure — skip the
  // round trip; a near-expired one may still be live (clock skew, restart).
  if (slot.record !== undefined && slot.record.expiresAt > Date.now()
      && await heartbeat(ctx, slot.record)) {
    return slot.record;
  }
  const record = await register(ctx, device);
  slot.record = record;
  return record;
};

/** Java binding(device): register once per device, heartbeat, reuse until release(). */
export function bindingFor(ctx: GatewayContext, device: Device): Promise<string> {
  let map = BINDINGS.get(ctx);
  if (!map) {
    map = new Map();
    BINDINGS.set(ctx, map);
  }
  let slot = map.get(device.id);
  if (slot === undefined) {
    slot = {};
    map.set(device.id, slot);
  }
  if (slot.pending !== undefined) return slot.pending.then((r) => r.token);
  if (slot.record !== undefined && slot.record.expiresAt - Date.now() > HEARTBEAT_MARGIN_MILLIS) {
    return Promise.resolve(slot.record.token);
  }
  slot.pending = acquire(ctx, device, slot).finally(() => { slot.pending = undefined; });
  return slot.pending.then((r) => r.token);
}

/** Java release(deviceId): revoke the registration upstream and drop the cache. */
export async function releaseBinding(ctx: GatewayContext, deviceId: string): Promise<void> {
  const map = BINDINGS.get(ctx);
  const slot = map?.get(deviceId);
  map?.delete(deviceId);
  if (slot === undefined || ctx.acs === undefined) return;
  try {
    const record = slot.record ?? await slot.pending;
    if (record === undefined) return;
    await ctx.acs.call('DELETE', `/api/v2/client-sessions/${record.clientSessionId}`,
      undefined, undefined, record.token);
  } catch {
    // Revocation is best-effort: the record is already dropped locally.
  }
}
