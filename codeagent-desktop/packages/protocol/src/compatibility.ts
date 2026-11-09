/**
 * Desktop/Service compatibility matrix and protocol constants (desktop
 * design §9.1/§9.2). Version skew fails closed: the desktop never "tries
 * anyway" against an incompatible service.
 */

/** Maximum protocol version this desktop implements. */
export const DESKTOP_PROTOCOL_VERSION = '2.1';
/** Minimum service protocol this desktop accepts. */
export const MIN_SERVICE_PROTOCOL = '2.0';

export type ProtocolCompatibility =
  | { compatible: true }
  | { compatible: false; reason: 'SERVICE_TOO_OLD' | 'SERVICE_TOO_NEW'; detail: string };

export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((p) => Number.parseInt(p, 10));
  const pb = b.split('.').map((p) => Number.parseInt(p, 10));
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const va = Number.isFinite(pa[i]) ? (pa[i] as number) : 0;
    const vb = Number.isFinite(pb[i]) ? (pb[i] as number) : 0;
    if (va !== vb) return va - vb;
  }
  return 0;
}

/**
 * Checks a capability handshake against this desktop's compatibility
 * matrix. A service older than our floor or newer than our ceiling both
 * fail closed with a stable reason for the incompatible page.
 */
export function checkServiceCompatibility(capabilities: {
  protocolVersion: string;
  minDesktopProtocol?: string;
}): ProtocolCompatibility {
  if (compareVersions(capabilities.protocolVersion, MIN_SERVICE_PROTOCOL) < 0) {
    return {
      compatible: false,
      reason: 'SERVICE_TOO_OLD',
      detail: `service protocol ${capabilities.protocolVersion} < desktop floor ${MIN_SERVICE_PROTOCOL}`
    };
  }
  const requiredDesktop =
    capabilities.minDesktopProtocol && capabilities.minDesktopProtocol.length > 0
      ? capabilities.minDesktopProtocol
      : '2.0';
  if (compareVersions(DESKTOP_PROTOCOL_VERSION, requiredDesktop) < 0) {
    return {
      compatible: false,
      reason: 'SERVICE_TOO_NEW',
      detail: `service requires desktop ${requiredDesktop} > desktop ${DESKTOP_PROTOCOL_VERSION}`
    };
  }
  return { compatible: true };
}
