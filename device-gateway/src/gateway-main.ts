import { taskFileBinding } from './sage-link-files.js';
/**
 * Standalone entry: `node dist/device-gateway.mjs`.
 *
 * Bootstrap order (fail-fast with CONFIG_* codes on bad env):
 *   data dir → store key (env or generated store.key 0600) → GatewayStore →
 *   Devices (ensureHost inside the constructor; keyCheckOk verifies the seal
 *   key against the persisted host record) → fixed upstream connections
 *   (WORKER_LOCAL_* must be loopback or boot fails LOCAL_ORIGIN_INVALID) →
 *   LocalTransport → LocalTaskAccess → ACS client + ClientAccessService →
 *   PersonalInbox (+ACS source reader) → GatewayContext → TLS material →
 *   phone HTTPS listener + owner loopback HTTP listener → inbox scanner
 *   (Java scheduleWithFixedDelay(5,15,SECONDS)) → SIGTERM/SIGINT graceful
 *   close → store.close() checkpoint.
 *
 * Environment (documented names only — values live in env.properties):
 *   DEVICE_GATEWAY_DATA_DIR            data dir (default ./.device-gateway)
 *   DEVICE_GATEWAY_BIND                REQUIRED phone listener bind (no wildcard default)
 *   DEVICE_GATEWAY_PORT                REQUIRED phone port [1,65535]
 *   DEVICE_GATEWAY_OWNER_TOKEN         REQUIRED gateway owner bearer
 *   DEVICE_GATEWAY_ACS_OWNER_TOKEN     optional distinct ACS upstream bearer (defaults to owner bearer)
 *   DEVICE_GATEWAY_ACS_HANDOFF_BRIDGE  use the Windows LAN Java handoff coordinator (set by Windows Host)
 *   DEVICE_GATEWAY_OWNER_CLIENT_TOKEN  REQUIRED owner X-Client-Session check
 *   DEVICE_GATEWAY_OWNER_BIND          owner listener bind (default 127.0.0.1, loopback only)
 *   DEVICE_GATEWAY_OWNER_PORT          REQUIRED owner listener port [1,65535]
 *   DEVICE_GATEWAY_ACS_URL             optional fixed loopback ACS origin (enables ctx.acs+clientAccess)
 *   DEVICE_GATEWAY_ACS_STORE_ID        ACS store id (default = host storeId; ACS_STORE_ID fallback)
 *   DEVICE_GATEWAY_ORIGIN              public https origin for invitations
 *   DEVICE_GATEWAY_STORE_KEY           32-byte envelope key (base64|hex); else store.key
 *   DEVICE_GATEWAY_PREVIOUS_STORE_KEY  rotation key
 *   WORKER_LOCAL_URL|_TOKEN|_CONNECTION_ID  all-or-none loopback worker-local source
 *   WORKER_LOCAL_EXTRA             optional JSON array (≤8) of additional
 *                                  {url,token,connectionId} loopback worker-local
 *                                  sources — one per extra engine host
 *   PERSONAL_ENV_URL|PERSONAL_ENV_TOKEN     secondary 'env' connection row
 *   DEVICE_GATEWAY_TLS_DIR|TLS_CN|TLS_DAYS|TLS_EXTRA_NAMES  provisioning knobs
 *   DEVICE_GATEWAY_TLS_KEY|TLS_CERT|TLS_CA  inline PEM (or file paths)
 *   DEVICE_GATEWAY_DISPLAY_NAME|DEVICE_GATEWAY_VERSION   log metadata
 *   DEVICE_GATEWAY_ADVERTISE_IP   IPv4 the mDNS A record announces
 *                                  (multi-homed hosts; default = first LAN iface)
 *   DEVICE_GATEWAY_MAX_RAW_BODY        listener drain cap bytes (default 16MiB)
 *   DEVICE_GATEWAY_PAIRING_AUTO_APPROVE  LAN discovery ⇒ instant approval
 *                                  (default on; '0' requires an owner
 *                                  decision). Invite-secret pairing always
 *                                  approves — the QR is the approval.
 *   DEVICE_GATEWAY_HOOKS_PORT        optional loopback agent-hook surface
 *   DEVICE_GATEWAY_HOOKS_TOKEN       local hook bearer (else generated
 *                                  {dataDir}/hooks.token, mode 0600)
 */
import { randomBytes, randomUUID, createHmac } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname, networkInterfaces } from 'node:os';
import { isIP, type Socket } from 'node:net';
import { join, resolve } from 'node:path';
import type { GatewayContext, GatewayConfig, JsonObject } from './context.js';
import { createGatewayListener, createHooksListener, createOwnerListener, createRelayListener } from './http.js';
import { certificateInfo, fingerprintOfCertPem, provisionTlsMaterial, type TlsMaterial } from './tls.js';
import { startMdns } from './mdns.js';
import { tailscaleNames } from './tailscale.js';
import { fail, GatewayError, id, text } from './protocol.js';
import type { Device, Resource } from './protocol.js';
import { GatewayStore } from './store.js';
import { Devices } from './devices.js';
import { GatewayApprovals } from './approvals.js';
import { LocalTaskAccess } from './local-tasks.js';
import { clearCloudOwnerGrant, WindowsCloudLaunch } from './windows-cloud-launch.js';
import { LinuxMemberEnrollment } from './linux-member.js';
import { UpdatePreparation } from './update-preparation.js';
import { PersonalInbox, type InboxSourceReader } from './inbox.js';
import { LocalTransport, type ConnectionRowLite } from './local-transport.js';
import { createAcsClient } from './acs.js';
import { createClientAccess } from './client-access.js';
import { createInboxSourceReader } from './inbox-source.js';
import { bindingFor } from './bindings.js';
import { AgentSessionAccess, type AgentUpstream } from './agent-sessions.js';
import { ChildMessagesAccess } from './child-messages.js';
import { WorkHandoffAccess } from './work-handoffs.js';
import { CliSupervisor } from './cli-supervisor.js';
import { CommercialAccess } from './commercial.js';
import { ReaderAccess } from './xagt/reader-access.js';
import { PeerStore } from './xagt/peer-reader.js';
import { MaterialStore } from './xagt/materials.js';
import { SourceReader } from './xagt/source-reader.js';
import { XagtReadService } from './xagt/read-service.js';
import { createXagtHandlers } from './xagt/rpc.js';

// ---------------------------------------------------------------------------
// Env parsing helpers — fail fast with CONFIG_* codes.
// ---------------------------------------------------------------------------

const configError = (code: string, detail: string): never => {
  const error = new Error(detail) as Error & { code?: string };
  error.code = code;
  throw error;
};

const env = (name: string): string | undefined => {
  const value = process.env[name];
  return value !== undefined && value.trim() !== '' ? value.trim() : undefined;
};

const requiredEnv = (name: string): string =>
  env(name) ?? configError('CONFIG_MISSING', `required environment variable ${name} is not set`);

const requiredPort = (name: string): number => {
  const value = requiredEnv(name);
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 65_535) {
    configError('CONFIG_INVALID', `${name} must be an integer in [1,65535]`);
  }
  return n;
};

const intEnv = (name: string, fallback: number, min: number, max: number): number => {
  const value = env(name);
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) {
    configError('CONFIG_INVALID', `${name} must be an integer in [${min},${max}]`);
  }
  return n;
};

/** 32-byte key from base64 or hex. */
const parseStoreKey = (value: string, name: string): Uint8Array => {
  let bytes: Buffer;
  if (/^[0-9a-fA-F]{64}$/.test(value)) bytes = Buffer.from(value, 'hex');
  else {
    try {
      bytes = Buffer.from(value, 'base64');
    } catch {
      configError('CONFIG_INVALID', `${name} must be 32 bytes as base64 or hex`);
      return undefined as never;
    }
  }
  if (bytes.length !== 32) configError('CONFIG_INVALID', `${name} must decode to exactly 32 bytes`);
  return new Uint8Array(bytes);
};

/** Load or generate the 32-byte envelope key; persisted at {dataDir}/store.key. */
const storeKey = (dataDir: string): Uint8Array => {
  const fromEnv = env('DEVICE_GATEWAY_STORE_KEY');
  if (fromEnv !== undefined) return parseStoreKey(fromEnv, 'DEVICE_GATEWAY_STORE_KEY');
  const keyPath = join(dataDir, 'store.key');
  mkdirSync(dataDir, { recursive: true });
  if (existsSync(keyPath)) {
    const value = readFileSync(keyPath, 'utf8').trim();
    return parseStoreKey(value, `${keyPath} contents`);
  }
  const generated = randomBytes(32);
  writeFileSync(keyPath, generated.toString('base64'), { mode: 0o600 });
  try { chmodSync(keyPath, 0o600); } catch { /* advisory on Windows */ }
  return new Uint8Array(generated);
};

/** Local hook bearer: env override, else generated/persisted at {dataDir}/hooks.token. */
const hooksToken = (dataDir: string): string => {
  const fromEnv = env('DEVICE_GATEWAY_HOOKS_TOKEN');
  if (fromEnv !== undefined) return fromEnv;
  const tokenPath = join(dataDir, 'hooks.token');
  if (existsSync(tokenPath)) return readFileSync(tokenPath, 'utf8').trim();
  mkdirSync(dataDir, { recursive: true });
  const generated = randomBytes(32).toString('base64url');
  writeFileSync(tokenPath, generated, { mode: 0o600 });
  try { chmodSync(tokenPath, 0o600); } catch { /* advisory on Windows */ }
  return generated;
};

/** PEM supplied either as literal content or as a file path. */
const pemFromEnv = (name: string): string | undefined => {
  const value = env(name);
  if (value === undefined) return undefined;
  if (value.includes('-----BEGIN')) return value;
  if (!existsSync(value)) configError('CONFIG_INVALID', `${name} is neither PEM content nor an existing file path`);
  return readFileSync(value, 'utf8');
};

/** Loopback-only upstream check — Java's fixed loopback upstream rule. */
const requireLoopbackHttp = (rawUrl: string, name: string): URL => {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    configError('LOCAL_ORIGIN_INVALID', `${name} is not a valid URL`);
    return undefined as never;
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const loopback = host === 'localhost' || host === '::1' || (isIP(host) === 4 && host.startsWith('127.'));
  if (url.protocol !== 'http:' || !loopback || url.username !== '' || url.password !== ''
    || url.search !== '' || url.hash !== '' || (url.pathname !== '' && url.pathname !== '/')) {
    configError('LOCAL_ORIGIN_INVALID', `${name} must be a plain http://loopback[:port] origin`);
  }
  return url;
};

/** Public commercial issuer only; credentials and provider endpoints are never inferred. */
export const checkedDailyOrigin = (raw: string | undefined): string | undefined => {
  if (raw === undefined) return undefined;
  let url: URL;
  try { url = new URL(raw); }
  catch { return configError('DAILY_ORIGIN_INVALID', 'DEVICE_GATEWAY_DAILY_ORIGIN must be a public issuer origin'); }
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/'
      || !(url.protocol === 'https:' || url.protocol === 'http:' && ['127.0.0.1','localhost','[::1]'].includes(url.hostname))) {
    return configError('DAILY_ORIGIN_INVALID', 'DEVICE_GATEWAY_DAILY_ORIGIN must be a plain HTTPS origin (HTTP is loopback-only)');
  }
  return url.origin;
};

// ---------------------------------------------------------------------------
// Config assembly.
// ---------------------------------------------------------------------------

export interface GatewayBootstrapOptions {
  dataDir: string;
  /** Required explicit phone bind — Java PersonalAccessServer takes an explicit InetSocketAddress. */
  bind: string;
  /** Required phone port [1,65535]. */
  port: number;
  /** Required owner bearer — also sent to the ACS upstream. */
  ownerToken: string;
  /** Required owner client-session token (registry-token analogue). */
  ownerClientToken: string;
  /** Owner listener bind — must be loopback. */
  ownerBind: string;
  /** Required owner listener port [1,65535]. */
  ownerPort: number;
  /** Optional connector-only HTTPS ingress; always bound to 127.0.0.1. */
  relayPort?: number;
  /** Optional loopback agent-hook surface (approvals). */
  hooksPort?: number;
  /** Local hook bearer — env override or generated {dataDir}/hooks.token. */
  hooksToken?: string;
  storeKey: Uint8Array;
  previousStoreKey?: Uint8Array;
  acsStoreId?: string;
  /** Fixed loopback ACS origin; undefined → ctx.acs/clientAccess unwired. */
  acsUrl?: string;
  acsOwnerToken?: string;
  acsHandoffBridge?: boolean;
  origin?: string;
  workerLocal?: { url: string; token: string; connectionId: string };
  /** Additional loopback worker-local sources (e.g. per-engine companion hosts). */
  extraWorkerLocals?: { url: string; token: string; connectionId: string }[];
  /**
   * OC-G free path: scan whitelisted local CLIs (pi/codex/claude), spawn one
   * cli-bridge host.mjs per detected engine on loopback, and register each as
   * a worker-local connection — the same source kind WORKER_LOCAL_* produces.
   */
  cliBridge?: {
    bridgePath: string;
    projectDir: string;
    stateDir: string;
    projectId?: string;
    model?: string;
    engines?: string[];
  };
  personalEnv?: { url: string; token: string };
  tls: TlsMaterial;
  displayName?: string;
  version?: string;
  maxRawBody?: number;
  dailyOrigin?: string;
  dailyCA?: string;
  allowUnlicensedDevelopment?: boolean;
  localCliOnly?: boolean;
  pairingAutoApprove?: boolean;
  /** Extra dialable origins (e.g. Tailscale) phones may probe after origin. */
  alternateOrigins?: string[];
}

/** Routable LAN IPv4s become dial candidates: multicast may be filtered
 *  between a wired Mac and a wireless phone while plain TCP still works.
 *  169.254 link-local and 198.18/15 (proxy TUN fake-ip) are never dialable. */
const lanIPv4Addresses = (): string[] => {
  const out: string[] = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const iface of list ?? []) {
      if (iface.family === 'IPv4' && !iface.internal
          && !iface.address.startsWith('169.254.') && !/^198\.1[89]\./.test(iface.address)
          && !out.includes(iface.address)) {
        out.push(iface.address);
      }
    }
  }
  return out;
};

/** The dial candidate set, best-first: the Bonjour name survives DHCP
 *  renumbering, LAN IPv4s cover the same-subnet case, tailnet names cover
 *  off-LAN. Recomputed at boot and periodically — tailnet join/leave and
 *  lease changes are runtime facts, not boot constants. */
const alternateOriginList = (port: number): string[] => [
  `https://${hostname()}:${port}`,
  ...lanIPv4Addresses().map((ip) => `https://${ip}:${port}`),
  ...tailscaleNames().map((name) => `https://${name}:${port}`),
];

export const readEnvConfig = (): GatewayBootstrapOptions => {
  const dataDir = resolve(env('DEVICE_GATEWAY_DATA_DIR') ?? './.device-gateway');
  const port = requiredPort('DEVICE_GATEWAY_PORT');
  const bind = requiredEnv('DEVICE_GATEWAY_BIND');
  if (isIP(bind) === 0 && bind !== 'localhost') {
    configError('CONFIG_INVALID', 'DEVICE_GATEWAY_BIND must be an IP literal or localhost');
  }
  const ownerPort = requiredPort('DEVICE_GATEWAY_OWNER_PORT');
  const relayPort = env('DEVICE_GATEWAY_RELAY_PORT') === undefined
    ? undefined : requiredPort('DEVICE_GATEWAY_RELAY_PORT');
  if (relayPort === port || relayPort === ownerPort) {
    configError('CONFIG_INVALID', 'DEVICE_GATEWAY_RELAY_PORT must use its own port');
  }
  const hooksPort = env('DEVICE_GATEWAY_HOOKS_PORT') === undefined
    ? undefined : requiredPort('DEVICE_GATEWAY_HOOKS_PORT');
  if (hooksPort !== undefined && (hooksPort === port || hooksPort === ownerPort || hooksPort === relayPort)) {
    configError('CONFIG_INVALID', 'DEVICE_GATEWAY_HOOKS_PORT must use its own port');
  }
  const ownerBind = env('DEVICE_GATEWAY_OWNER_BIND') ?? '127.0.0.1';
  const commonName = env('DEVICE_GATEWAY_TLS_CN') ?? hostname();
  const tlsDir = resolve(env('DEVICE_GATEWAY_TLS_DIR') ?? join(dataDir, 'tls'));
  // Detected once per boot for cert SANs (existing material is reused
  // untouched); the periodic refresh in main() keeps live alternates honest.
  const tailscale = tailscaleNames();
  const lanIPv4 = lanIPv4Addresses();

  const inlineKey = pemFromEnv('DEVICE_GATEWAY_TLS_KEY');
  const inlineCert = pemFromEnv('DEVICE_GATEWAY_TLS_CERT');
  const inlineCa = pemFromEnv('DEVICE_GATEWAY_TLS_CA');
  let tls: TlsMaterial;
  if (inlineKey !== undefined || inlineCert !== undefined) {
    if (inlineKey === undefined || inlineCert === undefined) {
      configError('CONFIG_INVALID', 'DEVICE_GATEWAY_TLS_KEY and DEVICE_GATEWAY_TLS_CERT must be set together');
    }
    tls = {
      key: Buffer.from(inlineKey!, 'utf8'),
      cert: Buffer.from(inlineCert!, 'utf8'),
      ...(inlineCa !== undefined ? { ca: Buffer.from(inlineCa, 'utf8') } : {}),
      fingerprints: {
        certSha256: fingerprintOfCertPem(inlineCert!),
        ...(inlineCa !== undefined ? { caSha256: fingerprintOfCertPem(inlineCa) } : {}),
      },
    };
  } else {
    // The phone dials the advertised origin (typically a LAN IP), not the
    // machine hostname — the self-signed SANs must cover the bind address and
    // the origin host or pairing fails TLS verification on-device.
    const originHost = (() => {
      const raw = env('DEVICE_GATEWAY_ORIGIN');
      if (raw === undefined) return undefined;
      try { return new URL(raw).hostname; } catch { return undefined; }
    })();
    // DEVICE_GATEWAY_TLS_EXTRA_NAMES — comma-separated extra SANs so one
    // certificate covers every address the phone may dial. The BYO-network
    // story needs this: a Tailscale/WireGuard name or IP alongside the LAN
    // bind, letting a paired host switch origin without re-pairing.
    const extraNames = (env('DEVICE_GATEWAY_TLS_EXTRA_NAMES') ?? '')
      .split(',').map((n) => n.trim()).filter((n) => n !== '');
    // Self-detected tailnet names ride along in the cert SANs so the
    // advertised alternate origins pass hostname verification too.
    extraNames.push(...tailscale);
    extraNames.push(...lanIPv4);
    tls = provisionTlsMaterial(tlsDir, {
      commonName,
      days: intEnv('DEVICE_GATEWAY_TLS_DAYS', 825, 1, 8250),
      extraNames: [...extraNames, bind, originHost].filter(
        (n): n is string => n !== undefined && n !== 'localhost' && n !== commonName
          && n !== '0.0.0.0' && n !== '::'),
      rsa: env('DEVICE_GATEWAY_PROFILE') === 'LOCAL_CLI',
    });
  }

  const acsUrlRaw = env('DEVICE_GATEWAY_ACS_URL');
  const acsUrl = acsUrlRaw !== undefined ? requireLoopbackHttp(acsUrlRaw, 'DEVICE_GATEWAY_ACS_URL').origin : undefined;

  const workerUrl = env('WORKER_LOCAL_URL');
  const workerToken = env('WORKER_LOCAL_TOKEN');
  const workerConnection = env('WORKER_LOCAL_CONNECTION_ID');
  let workerLocal: GatewayBootstrapOptions['workerLocal'];
  if (workerUrl !== undefined || workerToken !== undefined || workerConnection !== undefined) {
    if (workerUrl === undefined || workerToken === undefined || workerConnection === undefined) {
      configError('CONFIG_MISSING', 'WORKER_LOCAL_URL, WORKER_LOCAL_TOKEN and WORKER_LOCAL_CONNECTION_ID must be set together');
    }
    workerLocal = { url: requireLoopbackHttp(workerUrl!, 'WORKER_LOCAL_URL').origin, token: workerToken!, connectionId: workerConnection! };
  }

  let extraWorkerLocals: GatewayBootstrapOptions['extraWorkerLocals'];
  const extraRaw = env('WORKER_LOCAL_EXTRA');
  if (extraRaw !== undefined) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(extraRaw);
    } catch {
      configError('CONFIG_INVALID', 'WORKER_LOCAL_EXTRA must be a JSON array of {url,token,connectionId}');
    }
    if (!Array.isArray(parsed) || parsed.length > 8) {
      configError('CONFIG_INVALID', 'WORKER_LOCAL_EXTRA must be an array of at most 8 entries');
    }
    const seen = new Set<string>();
    extraWorkerLocals = (parsed as unknown[]).map((entry, index) => {
      const row = typeof entry === 'object' && entry !== null ? entry as Record<string, unknown> : {};
      if (typeof row.url !== 'string' || typeof row.token !== 'string' || row.token.length === 0
          || row.token.length > 1024 || typeof row.connectionId !== 'string'
          || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(row.connectionId) || !seen.add(row.connectionId)) {
        configError('CONFIG_INVALID', `WORKER_LOCAL_EXTRA[${index}] must be {url,token,connectionId} with a unique id`);
      }
      return {
        url: requireLoopbackHttp(row.url as string, `WORKER_LOCAL_EXTRA[${index}].url`).origin,
        token: row.token as string,
        connectionId: row.connectionId as string,
      };
    });
  }

  const cliBridgeHost = env('CLI_BRIDGE_HOST');
  let cliBridge: GatewayBootstrapOptions['cliBridge'];
  if (cliBridgeHost !== undefined) {
    const project = env('CLI_BRIDGE_PROJECT');
    if (project === undefined) {
      configError('CONFIG_MISSING', 'CLI_BRIDGE_PROJECT is required with CLI_BRIDGE_HOST');
    }
    cliBridge = {
      bridgePath: resolve(cliBridgeHost),
      projectDir: resolve(project!),
      stateDir: resolve(env('CLI_BRIDGE_STATE_DIR') ?? join(dataDir, 'cli-bridge')),
      projectId: env('CLI_BRIDGE_PROJECT_ID'),
      model: env('CLI_BRIDGE_MODEL'),
      engines: env('CLI_BRIDGE_ENGINES')
        ?.split(',').map((s) => s.trim()).filter(Boolean),
    };
  }

  const envUrl = env('PERSONAL_ENV_URL');
  const envToken = env('PERSONAL_ENV_TOKEN');
  const personalEnv = envUrl !== undefined && envToken !== undefined
    ? { url: envUrl, token: envToken }
    : undefined;

  return {
    dataDir,
    bind,
    port,
    ownerToken: requiredEnv('DEVICE_GATEWAY_OWNER_TOKEN'),
    ownerClientToken: requiredEnv('DEVICE_GATEWAY_OWNER_CLIENT_TOKEN'),
    ownerBind,
    ownerPort,
    relayPort,
    hooksPort,
    hooksToken: hooksToken(dataDir),
    storeKey: storeKey(dataDir),
    previousStoreKey: env('DEVICE_GATEWAY_PREVIOUS_STORE_KEY') !== undefined
      ? parseStoreKey(env('DEVICE_GATEWAY_PREVIOUS_STORE_KEY')!, 'DEVICE_GATEWAY_PREVIOUS_STORE_KEY')
      : undefined,
    acsStoreId: env('DEVICE_GATEWAY_ACS_STORE_ID') ?? env('ACS_STORE_ID'),
    acsUrl,
    acsOwnerToken: env('DEVICE_GATEWAY_ACS_OWNER_TOKEN'),
    acsHandoffBridge: env('DEVICE_GATEWAY_ACS_HANDOFF_BRIDGE') === '1',
    origin: env('DEVICE_GATEWAY_ORIGIN'),
    alternateOrigins: alternateOriginList(port),
    workerLocal,
    extraWorkerLocals,
    cliBridge,
    personalEnv,
    dailyOrigin: checkedDailyOrigin(env('DEVICE_GATEWAY_DAILY_ORIGIN')),
    tls,
    displayName: env('DEVICE_GATEWAY_DISPLAY_NAME') ?? 'device-gateway',
    version: env('DEVICE_GATEWAY_VERSION') ?? '0.1.0',
    maxRawBody: env('DEVICE_GATEWAY_MAX_RAW_BODY') !== undefined
      ? intEnv('DEVICE_GATEWAY_MAX_RAW_BODY', 16 * 1024 * 1024, 65_536, 64 * 1024 * 1024)
      : undefined,
    localCliOnly: env('DEVICE_GATEWAY_PROFILE') === 'LOCAL_CLI',
    // Loopback development/e2e escape hatch: skips the Daily commercial
    // control-grant gate for mutations. Never set in deployed configurations.
    allowUnlicensedDevelopment: env('DEVICE_GATEWAY_ALLOW_UNLICENSED_DEVELOPMENT') === '1'
      ? true
      : undefined,
    // Scan-and-pair: a valid invite secret approves immediately; '0' restores
    // the owner decision step for deployments that want explicit consent.
    pairingAutoApprove: env('DEVICE_GATEWAY_PAIRING_AUTO_APPROVE') !== '0',
  };
};

// ---------------------------------------------------------------------------
// Context assembly — exported so integration tests can build ctx without the
// listener. Sibling constructors are wired per their documented signatures.
// ---------------------------------------------------------------------------

export interface BuiltGateway {
  ctx: GatewayContext;
  store: GatewayStore;
  devices: Devices;
  localTasks?: LocalTaskAccess;
  inbox: PersonalInbox;
  config: GatewayConfig;
  cliSupervisor?: CliSupervisor;
  cloudLaunch?: WindowsCloudLaunch;
}

export function buildContext(opts: GatewayBootstrapOptions): BuiltGateway {
  if (opts.localCliOnly && (opts.acsUrl || opts.personalEnv || opts.allowUnlicensedDevelopment)) {
    configError('CONFIG_INVALID', 'LOCAL_CLI cannot combine with ACS, PERSONAL_ENV or the development bypass');
  }
  const store = new GatewayStore(opts.dataDir);
  try {
    return buildStoredContext(opts, store);
  } catch (error) {
    store.close();
    throw error;
  }
}

function buildStoredContext(opts: GatewayBootstrapOptions, store: GatewayStore): BuiltGateway {
  const origin = opts.origin ?? `https://${env('DEVICE_GATEWAY_TLS_CN') ?? hostname()}:${opts.port}`;
  // Devices implements the full GatewayAuth surface; origin feeds ownerStatus().
  const devices = new Devices(store, () => opts.storeKey, () => opts.previousStoreKey, undefined, origin, undefined, opts.pairingAutoApprove === true, opts.alternateOrigins ?? []);
  devices.keyCheckOk(); // throws GatewayError('STORE_KEY_INVALID', 500) on mismatch
  const host = devices.hostRecord();

  // Legacy gateways keep the persisted registry. Agent Link assigns fresh
  // loopback endpoints on restart and uses only this boot's registrations.
  const configuredWorkers = new Map<string, ConnectionRowLite>();
  if (opts.workerLocal) {
    const row = {
      connectionId: opts.workerLocal.connectionId, kind: 'worker-local',
      baseUrl: opts.workerLocal.url, tokenRef: 'env:WORKER_LOCAL_TOKEN',
      displayName: 'worker-local',
    };
    if (opts.localCliOnly) configuredWorkers.set(row.connectionId, row);
    else store.upsertConnection(row);
  }
  for (const extra of opts.extraWorkerLocals ?? []) {
    const row = {
      connectionId: extra.connectionId,
      kind: 'worker-local',
      baseUrl: extra.url,
      tokenRef: `env:WORKER_LOCAL_EXTRA:${extra.connectionId}`,
      displayName: `worker-local:${extra.connectionId}`,
    };
    if (opts.localCliOnly) configuredWorkers.set(row.connectionId, row);
    else store.upsertConnection(row);
  }
  if (opts.personalEnv) {
    store.upsertConnection({
      connectionId: 'env',
      kind: 'env',
      envBaseUrl: opts.personalEnv.url,
      envTokenRef: 'env:PERSONAL_ENV_TOKEN',
      displayName: 'env',
    });
  }

  // LocalTaskAccess is wired only when a loopback worker-local source is
  // registered (Java: localTasks == null → LOCAL_SOURCE_NOT_CONFIGURED).
  const registry = opts.localCliOnly ? {
    getConnection: (connectionId: string) => configuredWorkers.get(connectionId),
    listConnections: () => [...configuredWorkers.values()],
  } : {
    getConnection: (connectionId: string): ConnectionRowLite | undefined => store.getConnection(connectionId),
    listConnections: (): ConnectionRowLite[] => store.listConnections(),
  };
  const extraTokens = new Map((opts.extraWorkerLocals ?? []).map((x) => [x.connectionId, x.token]));
  const tokenResolver = (ref: string): string | undefined => {
    if (ref === 'env:WORKER_LOCAL_TOKEN') return opts.workerLocal?.token;
    if (ref.startsWith('env:WORKER_LOCAL_EXTRA:')) return extraTokens.get(ref.slice('env:WORKER_LOCAL_EXTRA:'.length));
    if (ref.startsWith('cli-supervisor:')) {
      return extraTokens.get(`cli:${ref.slice('cli-supervisor:'.length)}`);
    }
    if (ref.startsWith('worker:')) {
      const cached = extraTokens.get(ref);
      if (cached !== undefined) return cached;
      // Registered worker rows survive restart; their bearers now do too.
      const persisted = store.getConnectionToken(ref.slice('worker:'.length));
      if (persisted !== undefined) { extraTokens.set(ref, persisted); return persisted; }
      return undefined;
    }
    if (ref === 'env:PERSONAL_ENV_TOKEN') return opts.personalEnv?.token;
    return undefined;
  };
  // Worker self-registration: minted secrets are single-use and boot-scoped —
  // a restart simply means the owner re-mints, matching invite semantics.
  // Registered rows ride the SAME registry listConnections() reads every
  // catalog build does, so a live worker is probed in on the next request.
  const pendingWorkerInvites = new Map<string, number>();
  const insertWorkerRow = (connectionId: string, url: string, token: string, displayName: string): JsonObject => {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(connectionId)) fail('INVALID_REQUEST', 400);
    let parsed: URL;
    try { parsed = new URL(url); } catch { fail('INVALID_REQUEST', 400); }
    if ((parsed!.protocol !== 'http:' && parsed!.protocol !== 'https:')
        || url.length > 512 || token.length === 0 || token.length > 1024) fail('INVALID_REQUEST', 400);
    const row = {
      connectionId, kind: 'worker-local', baseUrl: parsed!.origin,
      tokenRef: `worker:${connectionId}`, displayName,
    };
    if (opts.localCliOnly) configuredWorkers.set(connectionId, row);
    else {
      store.upsertConnection(row);
      store.updateConnectionBaseUrl(connectionId, parsed!.origin);
    }
    extraTokens.set(`worker:${connectionId}`, token);
    if (!opts.localCliOnly) store.putConnectionToken(connectionId, token);
    return { connectionId, registeredAt: new Date().toISOString() };
  };
  const workers: import('./context.js').GatewayWorkers = {
    mint(requestId: string) {
      id(requestId);
      const workerSecret = randomBytes(24).toString('hex');
      const expiresAt = Date.now() + 30 * 60_000;
      for (const [secret, until] of pendingWorkerInvites) {
        if (until <= Date.now()) pendingWorkerInvites.delete(secret);
      }
      if (pendingWorkerInvites.size >= 8) fail('PAIRING_LIMIT', 429);
      pendingWorkerInvites.set(workerSecret, expiresAt);
      return { workerSecret, expiresAt };
    },
    register(body: JsonObject) {
      const secret = text(body, 'workerSecret');
      const until = pendingWorkerInvites.get(secret);
      if (until === undefined) fail('WORKER_INVITE_UNKNOWN', 401);
      if (until <= Date.now()) { pendingWorkerInvites.delete(secret); fail('WORKER_INVITE_EXPIRED', 410); }
      pendingWorkerInvites.delete(secret);
      const connectionId = text(body, 'connectionId');
      const displayName = body.displayName === undefined ? `worker:${connectionId}` : text(body, 'displayName');
      return insertWorkerRow(connectionId, text(body, 'url'), text(body, 'token'), displayName);
    },
    registerDirect(body: JsonObject) {
      const connectionId = text(body, 'connectionId');
      const displayName = body.displayName === undefined ? `worker:${connectionId}` : text(body, 'displayName');
      return insertWorkerRow(connectionId, text(body, 'url'), text(body, 'token'), displayName);
    },
    remove(connectionId: string) {
      id(connectionId);
      if (opts.localCliOnly) configuredWorkers.delete(connectionId);
      else store.deleteConnection(connectionId);
      extraTokens.delete(`worker:${connectionId}`);
    },
  };
  // One shared LocalTransport — LocalTaskAccess routes and the xagt read
  // service use the same loopback-pinned, bearer-resolved channel.
  const transport = new LocalTransport(registry, tokenResolver, fetch, opts.workerLocal?.connectionId);
  let localTasks: LocalTaskAccess | undefined;
  if (opts.workerLocal !== undefined || (opts.extraWorkerLocals?.length ?? 0) > 0
      || opts.cliBridge !== undefined || workers !== undefined) {
    const socket = env('SAGE_LINK_FILE_SOCKET');
    const key = env('SAGE_LINK_FILE_GATEWAY_KEY');
    const mcp = env('SAGE_LINK_FILE_MCP');
    const fileBinding = socket?.startsWith('/') && key && /^[a-f0-9]{64}$/.test(key) && mcp?.startsWith('/')
      ? taskFileBinding(socket, key, mcp) : undefined;
    localTasks = new LocalTaskAccess(devices, transport, store, fileBinding);
  }

  // OC-G: the supervisor's spawned bridges register into the same connection
  // store + token map LocalTransport reads — runtime rows are picked up on the
  // next request; no restart needed. start() runs after listeners are up.
  const cliSupervisor = opts.cliBridge !== undefined
    ? new CliSupervisor(
      {
        bridgePath: opts.cliBridge.bridgePath,
        stateRoot: opts.cliBridge.stateDir,
        projectDir: opts.cliBridge.projectDir,
        ...(opts.cliBridge.projectId !== undefined ? { projectId: opts.cliBridge.projectId } : {}),
        ...(opts.cliBridge.model !== undefined ? { model: opts.cliBridge.model } : {}),
        ...(opts.cliBridge.engines !== undefined ? { engines: opts.cliBridge.engines } : {}),
      },
      {
        // upsertConnection is register-once; supervisor rows get a fresh port
        // per spawn, so re-point the row when it already exists. LOCAL_CLI
        // reads the boot-scoped configuredWorkers map, not the store.
        upsertConnection: (row) => {
          if (opts.localCliOnly) {
            configuredWorkers.set(row.connectionId, row);
            return;
          }
          store.upsertConnection(row);
          if (row.baseUrl !== undefined) {
            store.updateConnectionBaseUrl(row.connectionId, row.baseUrl);
          }
        },
        tokens: extraTokens,
        log: (event, fields) => console.log(JSON.stringify({ listener: 'cli-supervisor', event, ...fields })),
      },
    )
    : undefined;

  const certInfo = certificateInfo(opts.tls.cert.toString('utf8'));
  const config: GatewayConfig = {
    personalHostId:host.id,
    allowUnlicensedDevelopment:opts.allowUnlicensedDevelopment === true,
    localCliOnly:opts.localCliOnly === true,
    storeId: host.storeId,
    acsStoreId: opts.acsStoreId ?? host.storeId,
    bootId: randomUUID(),
    origin,
    certificateSha256: opts.tls.fingerprints.certSha256,
    certificatePem: opts.tls.cert.toString('utf8'),
    certificateNotBefore: certInfo.notBefore,
    certificateNotAfter: certInfo.notAfter,
    certificateNames: certInfo.subjectAltNames,
    bindAddress: opts.bind,
    port: opts.port,
    transcriptionReason: 'TRANSCRIPTION_NOT_CONFIGURED',
  };

  const ctx: GatewayContext = {
    auth: devices,
    inbox: undefined as unknown as GatewayContext['inbox'],
    workers,
    config,
    ...(localTasks !== undefined ? { localTasks } : {}),
  };
  if (!opts.allowUnlicensedDevelopment) ctx.commercial=new CommercialAccess(config,opts.tls.key,opts.dailyOrigin,opts.dailyCA);

  // ACS seam — the fixed loopback upstream (Java PersonalAccessServer's
  // upstream). When configured, binding(device) mints per-device
  // client-session tokens on the ctx-keyed bindings map.
  const acs = opts.acsUrl !== undefined
    ? createAcsClient({
      origin: opts.acsUrl,
      ownerToken: opts.acsOwnerToken ?? opts.ownerToken,
      binding: (device: Device) => bindingFor(ctx, device),
    })
    : undefined;
  if (acs !== undefined) {
    ctx.acs = acs;
    if (opts.acsHandoffBridge) ctx.acsHandoffBridge = true;
  }

  // Agent-session ledger + child-messages projection (Java
  // PersonalAgentSessionAccess / PersonalChildMessagesAccess). Java wires
  // them only when the ACS upstream exists; undefined ctx seams are the
  // null-injection equivalent (503 UPSTREAM_UNAVAILABLE per route).
  let agentUpstream: AgentUpstream | undefined;
  if (acs !== undefined) {
    const parseReply = (reply: { status: number; body: Uint8Array }) => {
      try {
        return {
          status: reply.status,
          body: reply.body.length === 0 ? null
            : JSON.parse(Buffer.from(reply.body).toString('utf8')) as unknown,
        };
      } catch {
        return fail('UPSTREAM_UNAVAILABLE', 503);
      }
    };
    agentUpstream = {
      call: async (device, method, path, body, key, beforeDispatch) => {
        const binding = await bindingFor(ctx, device);
        if (beforeDispatch !== undefined) await beforeDispatch();
        return parseReply(await acs.call(method, path,
          body == null ? undefined : new Uint8Array(Buffer.from(JSON.stringify(body), 'utf8')),
          key, binding));
      },
      callBytes: async (device, method, path, body, key) => parseReply(await acs.call(
        method, path, body, key, await bindingFor(ctx, device))),
    };
    // Java namespace = ownerStatus().personalHostId → host.id.
    ctx.agentSessions = new AgentSessionAccess(store, devices, agentUpstream, host.id);
    ctx.childMessages = new ChildMessagesAccess(devices, agentUpstream);
  }

  // The Windows ACS bridge keeps Java as the source coordinator. Its
  // gateway ledger only receives signed ACS imports from peer hosts.
  if (localTasks !== undefined) {
    const acsSourceRecovery = acs && ctx.acsHandoffBridge ? async (body: JsonObject) => {
      const binding = await bindingFor(ctx, { id: '848920e1-ecde-4e1f-8d1f-c0a2daeef703', label: 'Windows Link handoff owner' });
      const reply = await acs.call('POST', '/api/v2/personal-access/gateway-work-handoff-recovery',
        new TextEncoder().encode(JSON.stringify({ ...body, gatewayHostId: host.id })), undefined, binding);
      let value: JsonObject;
      try { value = JSON.parse(Buffer.from(reply.body).toString('utf8')); }
      catch { return fail('UPSTREAM_UNAVAILABLE', 503); }
      if (reply.status !== 200) fail(typeof value.code === 'string' ? value.code : 'UPSTREAM_UNAVAILABLE', reply.status);
      return value;
    } : undefined;
    ctx.workHandoffs = new WorkHandoffAccess(
      store, devices, agentUpstream, localTasks,
      join(opts.dataDir, 'materials'), join(opts.dataDir, 'signing'), host.id, ctx.acsHandoffBridge === true,
      acsSourceRecovery);
    if (agentUpstream === undefined) ctx.nativeLocalHandoffs = true;
  }

  // ClientAccessService is always constructible — its SourcePort fails
  // UPSTREAM_UNAVAILABLE when the ACS upstream is not configured, matching
  // the Java call() I/O error path.
  ctx.clientAccess = createClientAccess({
    auth: devices,
    ...(localTasks !== undefined ? { localTasks } : {}),
    storeId: host.storeId,
    bootId: config.bootId,
    source: async (device: Device, method: string, path: string, body: unknown, key: string | null) => {
      if (acs === undefined) fail('UPSTREAM_UNAVAILABLE', 503);
      return (await acs.callJson(device, method, path, body, key ?? undefined)) as Record<string, unknown>;
    },
  });

  // Inbox SourceReader — Java readInboxSource(): WORKER_LOCAL → localTasks
  // .signal, ACS_SESSION → the ACS call graph; anything else INVALID_SCOPE.
  const acsReader: InboxSourceReader = createInboxSourceReader({
    ...(acs !== undefined ? { acs } : {}),
    ...(localTasks !== undefined ? { localTasks } : {}),
    auth: devices,
    binding: (device: Device) => (acs !== undefined ? bindingFor(ctx, device) : undefined),
  });
  const reader: InboxSourceReader = (device: Device, resource: Resource, deadlineMillis: number) =>
    acsReader(device, resource, deadlineMillis);

  const inbox = new PersonalInbox(
    store,
    devices,
    reader,
    { storeId: host.storeId, refresher: (task) => queueMicrotask(task) },
  );
  ctx.inbox = inbox;
  const approvals = new GatewayApprovals(store, opts.localCliOnly ? {
    activeDevices: () => devices.activeDevices().filter((device) => device.actions?.includes('APPROVE')),
  } : devices);
  ctx.approvals = approvals;
  if (opts.localCliOnly) {
    ctx.updatePreparation = new UpdatePreparation(config.bootId, transport, () =>
      approvals.pending().items.length > 0);
  }

  // xagt read-only surface — reader grants + peer records + explicit material
  // entries live in the same store; the cursor key is derived from the store
  // key (a distinct HMAC domain) so cursors can't be minted off-box.
  // DEVICE_GATEWAY_XAGT_READ=off disables ONLY this surface — Agents, local
  // tasks and the old file MCP keep running (design §16).
  const xagtCursorSecret = createHmac('sha256', opts.storeKey)
    .update('xagt-cursor-v1').digest();
  const xagtPeers = new PeerStore(store, () => opts.storeKey);
  const xagtMaterials = new MaterialStore(store);
  if (env('DEVICE_GATEWAY_XAGT_READ') !== 'off' && env('DEVICE_GATEWAY_XAGT_READ') !== '0') {
    ctx.xagt = createXagtHandlers({
      readers: new ReaderAccess(store),
      peers: xagtPeers,
      materials: xagtMaterials,
      service: new XagtReadService({
        store,
        transport,
        source: new SourceReader(transport),
        peers: xagtPeers,
        materials: xagtMaterials,
        cursorSecret: new Uint8Array(xagtCursorSecret),
      }),
    });
  }

  const cloudOrigin = (env('DEVICE_GATEWAY_CLOUD_ORIGIN')
    ?? env('DEVICE_GATEWAY_WINDOWS_CLOUD_ORIGIN'))?.replace(/\/$/, '');
  const cloudSession = env('DEVICE_GATEWAY_CLOUD_SESSION')
    ?? env('DEVICE_GATEWAY_WINDOWS_CLOUD_SESSION');
  const cloudRecoveryOnly = env('DEVICE_GATEWAY_CLOUD_RECOVERY_ONLY') === '1';
  const linuxProfile = process.platform === 'linux' && opts.localCliOnly;
  const memberSession = linuxProfile && !cloudSession && !cloudRecoveryOnly
    ? env('DEVICE_GATEWAY_LINUX_MEMBER_SESSION') : undefined;
  const linuxMember = memberSession ? new LinuxMemberEnrollment(memberSession, host.id,
    session => clearCloudOwnerGrant(store, session)) : undefined;
  const ownerManagedCloud = Boolean(linuxMember || (linuxProfile && env('DEVICE_GATEWAY_CLOUD_OWNER_GRANTS') === '1'));
  const hasCloudSession = linuxMember || (cloudOrigin && /^https:\/\/[a-z0-9.:-]+$/i.test(cloudOrigin) && cloudSession);
  const cloudLaunch = hasCloudSession && localTasks
    ? new WindowsCloudLaunch(store, localTasks, transport, host.id, cloudOrigin ?? '', cloudSession ?? '',
      join(opts.dataDir, 'windows-cloud-launch.json'), fetch, cloudRecoveryOnly,
      ctx.updatePreparation, ownerManagedCloud, linuxMember) : undefined;
  if (ownerManagedCloud && cloudLaunch && !cloudRecoveryOnly) {
    ctx.cloudLaunchGrant = request => cloudLaunch.ownerGrant(request);
  }
  if (linuxMember && cloudLaunch) ctx.linuxMember = linuxMember;
  return { ctx, store, devices, localTasks, inbox, config, cliSupervisor, cloudLaunch };
}

// ---------------------------------------------------------------------------
// main() — never log secrets (tokens, keys, secrets stay out of stdout).
// ---------------------------------------------------------------------------

export async function main(): Promise<void> {
  const updateMarker = env('DEVICE_GATEWAY_STARTUP_UPDATE_FILE');
  const readUpdateMarker = (): string | undefined => {
    if (!updateMarker) return undefined;
    try {
      return readFileSync(updateMarker, 'utf8').trim();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  };
  const operationId = readUpdateMarker();
  if (operationId !== undefined && !/^[A-Za-z0-9_-]{1,128}$/.test(operationId)) {
    configError('CONFIG_INVALID', 'invalid installation operation marker');
  }
  const opts = readEnvConfig();
  mkdirSync(opts.dataDir, { recursive: true });
  const built = buildContext(opts);
  const startup = operationId === undefined ? undefined : { operationId, ready: false };
  if (startup) {
    if (!built.ctx.updatePreparation) configError('CONFIG_INVALID', 'installation check requires a local gateway');
    built.ctx.startupUpdate = startup;
  }

  const phoneServer = createGatewayListener({
    tls: { key: opts.tls.key, cert: opts.tls.cert, ...(opts.tls.ca !== undefined ? { ca: opts.tls.ca } : {}) },
    ctx: built.ctx,
    bind: opts.bind,
    port: opts.port,
    ...(opts.maxRawBody !== undefined ? { maxRawBody: opts.maxRawBody } : {}),
  });
  const ownerServer = createOwnerListener({
    ctx: built.ctx,
    ownerToken: opts.ownerToken,
    ownerClientToken: opts.ownerClientToken,
    bind: opts.ownerBind,
    port: opts.ownerPort,
    ...(opts.maxRawBody !== undefined ? { maxRawBody: opts.maxRawBody } : {}),
  });
  const relayServer = opts.relayPort === undefined ? undefined : createRelayListener({
    tls: { key: opts.tls.key, cert: opts.tls.cert, ...(opts.tls.ca !== undefined ? { ca: opts.tls.ca } : {}) },
    ctx: built.ctx,
    port: opts.relayPort,
    ...(opts.maxRawBody !== undefined ? { maxRawBody: opts.maxRawBody } : {}),
  });
  const hooksServer = opts.hooksPort === undefined ? undefined : createHooksListener({
    ctx: built.ctx,
    hooksToken: opts.hooksToken ?? hooksToken(opts.dataDir),
    bind: '127.0.0.1',
    port: opts.hooksPort,
    ...(opts.maxRawBody !== undefined ? { maxRawBody: opts.maxRawBody } : {}),
  });
  const listeners = [
    { server: phoneServer, port: opts.port, bind: opts.bind },
    { server: ownerServer, port: opts.ownerPort, bind: opts.ownerBind },
    ...(relayServer ? [{ server: relayServer, port: opts.relayPort!, bind: '127.0.0.1' }] : []),
    ...(hooksServer ? [{ server: hooksServer, port: opts.hooksPort!, bind: '127.0.0.1' }] : []),
  ];
  const startPhoneEnabled = env('DEVICE_GATEWAY_PHONE_START_DISABLED') !== '1';
  try {
    for (const listener of listeners) {
      if (listener.server === phoneServer && !startPhoneEnabled) continue;
      await new Promise<void>((resolveListen, rejectListen) => {
      listener.server.once('error', rejectListen);
      listener.server.listen(listener.port, listener.bind, () => {
        listener.server.removeListener('error', rejectListen);
        resolveListen();
      });
      });
    }
  } catch (error) {
    await Promise.all(listeners.map(({ server }) => new Promise<void>((resolveClose) => {
      if (!server.listening) return resolveClose();
      server.close(() => resolveClose());
    })));
    built.store.close();
    throw error;
  }

  let earlyStop: string | undefined;
  let handleStop = (signal: string): void => { earlyStop ??= signal; };
  const stopForTerm = (): void => handleStop('SIGTERM');
  const stopForInterrupt = (): void => handleStop('SIGINT');
  const stopForParent = (): void => handleStop('parent-stdin-closed');
  const watchParent = env('DEVICE_GATEWAY_STOP_ON_STDIN_END') === '1';
  process.on('SIGTERM', stopForTerm);
  process.on('SIGINT', stopForInterrupt);
  if (watchParent) {
    process.stdin.once('end', stopForParent);
    process.stdin.resume();
  }

  if (startup && updateMarker) {
    // All required listeners are bound. Keep requests and background work
    // fenced until the installer commits the program and state transaction.
    startup.ready = true;
    for (let marker = readUpdateMarker(); marker !== undefined && !earlyStop; marker = readUpdateMarker()) {
      if (marker !== startup.operationId) {
        configError('CONFIG_INVALID', 'installation operation changed during startup');
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (earlyStop) {
      // A health process exits while the marker is still present. Never open
      // task intake or start background work just to drain the listeners.
      await Promise.all(listeners.map(({ server }) => new Promise<void>((closed) => {
        server.close(() => closed());
        server.closeAllConnections();
      })));
      built.store.close();
      process.off('SIGTERM', stopForTerm);
      process.off('SIGINT', stopForInterrupt);
      if (watchParent) {
        process.stdin.off('end', stopForParent);
        process.stdin.pause();
      }
      return;
    }
    delete built.ctx.startupUpdate;
  }

  // Master connect switch: the owner can close the phone listener without
  // taking the loopback owner API down with it — Agent Link still manages
  // state while every phone sees the Mac go offline.
  const phoneSockets = new Set<Socket>();
  phoneServer.on('connection', (s) => { phoneSockets.add(s); s.once('close', () => phoneSockets.delete(s)); });
  phoneServer.on('secureConnection', (s) => { phoneSockets.add(s); s.once('close', () => phoneSockets.delete(s)); });
  let phoneEnabled = startPhoneEnabled;
  let changeLink = Promise.resolve();
  built.ctx.link = {
    phoneEnabled: () => phoneEnabled,
    setPhoneEnabled: (on) => {
      const change = changeLink.then(async () => {
        if (on === phoneEnabled) return;
        if (on) {
          await new Promise<void>((resolveListen, rejectListen) => {
            phoneServer.once('error', rejectListen);
            phoneServer.listen(opts.port, opts.bind, () => {
              phoneServer.removeListener('error', rejectListen);
              resolveListen();
            });
          });
        } else {
          for (const s of phoneSockets) s.destroy();
          if (phoneServer.listening) await new Promise<void>((r) => phoneServer.close(() => r()));
        }
        phoneEnabled = on;
      });
      changeLink = change.catch(() => {});
      return change;
    },
  };

  // Java: scheduleWithFixedDelay(scanAll, 5, 15, SECONDS) — first scan after
  // 5s, then a fixed 15s delay measured after each scan completes.
  let scanTimer: ReturnType<typeof setTimeout> | undefined;
  const scheduleScan = (delay: number): void => {
    scanTimer = setTimeout(() => {
      void (async () => {
        try {
          await built.inbox.scanAll();
        } catch {
          // Java swallows scan failures per round.
        }
        scheduleScan(15_000);
      })();
    }, delay);
    scanTimer.unref();
  };
  scheduleScan(5_000);

  const address = phoneServer.address();
  const boundPort = typeof address === 'object' && address !== null ? address.port : opts.port;
  const ownerAddress = ownerServer.address();
  const boundOwnerPort = typeof ownerAddress === 'object' && ownerAddress !== null
    ? ownerAddress.port : opts.ownerPort;
  console.log(JSON.stringify({
    listener: 'device-gateway',
    bind: opts.bind,
    port: boundPort,
    owner: { bind: opts.ownerBind, port: boundOwnerPort },
    ...(relayServer ? { relay: { bind: '127.0.0.1', port: opts.relayPort } } : {}),
    ...(hooksServer ? { hooks: { bind: '127.0.0.1', port: opts.hooksPort } } : {}),
    fingerprint: opts.tls.fingerprints.certSha256,
    localTasks: built.localTasks !== undefined,
    acs: built.ctx.acs !== undefined,
    ownerApi: true,
    cliSupervisor: built.cliSupervisor !== undefined,
  }));

  // OC-G: scan + spawn detected local-CLI bridges now that the HTTPS listener
  // accepts traffic; bridge rows land in the live connection registry.
  if (built.cliSupervisor !== undefined) {
    void built.cliSupervisor.start();
  }
  built.cloudLaunch?.start();
  const handoffProgress = built.ctx.nativeLocalHandoffs ? setInterval(() => {
    if (built.ctx.updatePreparation?.preparing) return;
    const finish = built.ctx.updatePreparation?.admit();
    void Promise.resolve(built.ctx.workHandoffs?.advanceConfirmedLocalHandoffs?.()).catch(() => {
      console.error(JSON.stringify({ listener: 'device-gateway', action: 'handoff-background', state: 'ERROR' }));
    }).finally(() => finish?.());
  }, 1000) : undefined;
  handoffProgress?.unref();

  // Bonjour advertisement — phones discover this host as "_agentlink._tcp".
  // The advert is public discovery facts only; pairing still needs owner
  // approval (discovery requests land PENDING). Opt out via env.
  const altsTxt = (origins: string[]): string | undefined =>
    origins.length === 0 ? undefined : origins.map((o) => new URL(o).host).join(',');
  // Multi-homed hosts (VMware/Hyper-V adapters enumerate before Wi-Fi) need
  // an explicit dial address for the Bonjour A record; without it the advert
  // announces whichever interface the OS listed first — often undialable.
  const advertiseIp = env('DEVICE_GATEWAY_ADVERTISE_IP');
  if (advertiseIp !== undefined && (isIP(advertiseIp) !== 4)) {
    configError('CONFIG_INVALID', 'DEVICE_GATEWAY_ADVERTISE_IP must be an IPv4 literal');
  }
  const mdns = env('DEVICE_GATEWAY_MDNS') === '0'
    ? { stop: () => {}, update: () => {} }
    : startMdns({
      instance: env('DEVICE_GATEWAY_MDNS_NAME') ?? hostname(),
      port: boundPort,
      address: advertiseIp ?? opts.bind,
      txt: {
        v: '1',
        host: built.config.personalHostId ?? '',
        store: built.config.storeId,
        cert: opts.tls.fingerprints.certSha256,
        ...((opts.alternateOrigins ?? []).length === 0 ? {}
          : { alts: altsTxt(opts.alternateOrigins ?? []) }),
      },
      log: (event, fields) => console.log(JSON.stringify({ listener: 'mdns', event, ...fields })),
    });

  // Live-network refresh: DHCP leases move and the tailnet joins/leaves
  // without a gateway restart. Recomputing keeps fresh invites, the host
  // view, and the mDNS alternates honest so late Tailscale setups still
  // reach already-paired phones.
  let currentAlternates = [...(opts.alternateOrigins ?? [])];
  const refreshAlternates = setInterval(() => {
    try {
      const origins = alternateOriginList(boundPort);
      if (origins.join('|') === currentAlternates.join('|')) return;
      currentAlternates = origins;
      built.devices.setAlternateOrigins(origins);
      mdns.update({
        // Only an explicit pin overrides the per-interface A record —
        // refreshing with lan[0] would re-pin to whatever enumerates first
        // (on this machine: a VMware host-only subnet phones cannot dial).
        ...(advertiseIp !== undefined ? { address: advertiseIp } : {}),
        txt: { alts: altsTxt(origins) ?? '' },
      });
    } catch { /* interface flap mid-scan — retry next round */ }
  }, 30_000);
  refreshAlternates.unref();

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(JSON.stringify({ listener: 'device-gateway', signal, action: 'shutdown' }));
    if (scanTimer !== undefined) clearTimeout(scanTimer);
    clearInterval(refreshAlternates);
    if (handoffProgress) clearInterval(handoffProgress);
    built.cloudLaunch?.stop();
    mdns.stop();
    let pending = listeners.length;
    const done = (): void => {
      if (--pending === 0) {
        void built.cliSupervisor?.stop();
        built.store.close();
        process.exit(0);
      }
    };
    for (const { server } of listeners) server.close(done);
    setTimeout(() => process.exit(1), 5_000).unref();
  };
  handleStop = shutdown;
  if (earlyStop) shutdown(earlyStop);
}

const isMain = process.argv[1] !== undefined
  && (process.argv[1].endsWith('device-gateway.mjs') || process.argv[1].endsWith('gateway-main.js'));

if (isMain) {
  main().catch((error: unknown) => {
    const code = error instanceof GatewayError ? error.code
      : error instanceof Error && 'code' in error ? String((error as Error & { code?: unknown }).code)
        : 'CONFIG_INVALID';
    console.error(JSON.stringify({ fatal: code, detail: error instanceof Error ? error.message : String(error) }));
    process.exit(1);
  });
}
