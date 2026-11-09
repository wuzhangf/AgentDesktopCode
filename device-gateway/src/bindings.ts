/**
 * Per-device client-session bindings — port of PersonalAccessServer's
 * `bindings` map + binding()/release().
 *
 * Java registers an ephemeral client-session token per device in
 * ClientSessionRegistry and revokes it in release(). The standalone gateway
 * has no registry, so the token is an opaque random value minted on first
 * use and dropped on release(); the ACS upstream receives it on
 * X-CodeAgent-Client-Token exactly like Java.
 *
 * Documented deviations:
 *  - no TTL/heartbeat: tokens live until release() or process exit
 *    (Java re-registers on expiry; ours re-mints on the next call after a
 *    release());
 *  - nothing survives restart, matching Java's in-memory map.
 */
import { secret } from './protocol.js';
import type { Device } from './protocol.js';
import type { GatewayContext } from './context.js';

const BINDINGS = new WeakMap<object, Map<string, string>>();

/** Java binding(device): mint once per device, reuse until release(). */
export function bindingFor(ctx: GatewayContext, device: Device): string {
  let map = BINDINGS.get(ctx);
  if (!map) {
    map = new Map();
    BINDINGS.set(ctx, map);
  }
  let token = map.get(device.id);
  if (token === undefined) {
    token = secret();
    map.set(device.id, token);
  }
  return token;
}

/** Java release(deviceId): drop the binding so the next call re-mints. */
export function releaseBinding(ctx: GatewayContext, deviceId: string): void {
  BINDINGS.get(ctx)?.delete(deviceId);
}
