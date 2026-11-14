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
 *   DEVICE_GATEWAY_OWNER_TOKEN         REQUIRED owner bearer (also the ACS upstream bearer)
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
 *   DEVICE_GATEWAY_MAX_RAW_BODY        listener drain cap bytes (default 16MiB)
 *   DEVICE_GATEWAY_PAIRING_AUTO_APPROVE  invite secret ⇒ instant approval
 *                                  (default on; '0' requires owner decision)
 *   DEVICE_GATEWAY_HOOKS_PORT        optional loopback agent-hook surface
 *   DEVICE_GATEWAY_HOOKS_TOKEN       local hook bearer (else generated
 *                                  {dataDir}/hooks.token, mode 0600)
 */
import { randomBytes, randomUUID } from 'node:crypto';
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
import { PersonalInbox, type InboxSourceReader } from './inbox.js';
import { LocalTransport, type ConnectionRowLite } from './local-transport.js';
import { createAcsClient } from './acs.js';
import { createClientAccess } from './client-access.js';
import { createInboxSourceReader } from './inbox-source.js';
import { bindingFor } from './bindings.js';
import { CliSupervisor } from './cli-supervisor.js';
import { CommercialAccess } from './commercial.js';

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
  // Detected once per boot: tailnet IPv4 + MagicDNS name feed both the cert
  // SANs (provisioned certs only — existing material is reused untouched) and
  // the alternate origins phones probe when the primary LAN origin fails.
  const tailscale = tailscaleNames();
  // LAN IPv4s become dial candidates too: multicast may be filtered between
  // a wired Mac and a wireless phone while plain TCP still works — the
  // invite and the advert then carry a route that never needed mDNS.
  const lanIPv4: string[] = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const iface of list ?? []) {
      if (iface.family === 'IPv4' && !iface.internal
          // 169.254 link-local and 198.18/15 (proxy TUN fake-ip range) are
          // never dialable from a phone — keep them out of SANs/adverts.
          && !iface.address.startsWith('169.254.') && !/^198\.1[89]\./.test(iface.address)
          && !lanIPv4.includes(iface.address)) {
        lanIPv4.push(iface.address);
      }
    }
  }

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
    origin: env('DEVICE_GATEWAY_ORIGIN'),
    alternateOrigins: (() => {
      const candidates = [
        // The Bonjour name first — DHCP renumbering never invalidates it, and
        // paired phones absorb it through discovery so a stale numeric primary
        // can heal without re-pairing.
        `https://${hostname()}:${port}`,
        ...lanIPv4.map((ip) => `https://${ip}:${port}`),
        ...tailscale.map((name) => `https://${name}:${port}`),
      ];
      return candidates.length === 0 ? undefined : candidates;
    })(),
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
    if (ref.startsWith('worker:')) return extraTokens.get(ref);
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
  let localTasks: LocalTaskAccess | undefined;
  if (opts.workerLocal !== undefined || (opts.extraWorkerLocals?.length ?? 0) > 0
      || opts.cliBridge !== undefined || workers !== undefined) {
    const transport = new LocalTransport(registry, tokenResolver, fetch, opts.workerLocal?.connectionId);
    localTasks = new LocalTaskAccess(devices, transport, store);
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
        // per spawn, so re-point the row when it already exists.
        upsertConnection: (row) => {
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
      ownerToken: opts.ownerToken,
      binding: (device: Device) => bindingFor(ctx, device),
    })
    : undefined;
  if (acs !== undefined) ctx.acs = acs;

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
  ctx.approvals = new GatewayApprovals(store, opts.localCliOnly ? {
    activeDevices: () => devices.activeDevices().filter((device) => device.actions?.includes('APPROVE')),
  } : devices);

  return { ctx, store, devices, localTasks, inbox, config, cliSupervisor };
}

// ---------------------------------------------------------------------------
// main() — never log secrets (tokens, keys, secrets stay out of stdout).
// ---------------------------------------------------------------------------

export async function main(): Promise<void> {
  const opts = readEnvConfig();
  mkdirSync(opts.dataDir, { recursive: true });
  const built = buildContext(opts);

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
  try {
    for (const listener of listeners) await new Promise<void>((resolveListen, rejectListen) => {
      listener.server.once('error', rejectListen);
      listener.server.listen(listener.port, listener.bind, () => {
        listener.server.removeListener('error', rejectListen);
        resolveListen();
      });
    });
  } catch (error) {
    await Promise.all(listeners.map(({ server }) => new Promise<void>((resolveClose) => {
      if (!server.listening) return resolveClose();
      server.close(() => resolveClose());
    })));
    built.store.close();
    throw error;
  }

  // Master connect switch: the owner can close the phone listener without
  // taking the loopback owner API down with it — Agent Link still manages
  // state while every phone sees the Mac go offline.
  const phoneSockets = new Set<Socket>();
  phoneServer.on('connection', (s) => { phoneSockets.add(s); s.once('close', () => phoneSockets.delete(s)); });
  phoneServer.on('secureConnection', (s) => { phoneSockets.add(s); s.once('close', () => phoneSockets.delete(s)); });
  let phoneEnabled = true;
  built.ctx.link = {
    phoneEnabled: () => phoneEnabled,
    setPhoneEnabled: async (on) => {
      if (on === phoneEnabled) return;
      phoneEnabled = on;
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

  // Bonjour advertisement — phones discover this host as "_agentlink._tcp".
  // The advert is public discovery facts only; pairing still needs owner
  // approval (discovery requests land PENDING). Opt out via env.
  const mdns = env('DEVICE_GATEWAY_MDNS') === '0' ? { stop: () => {} } : startMdns({
    instance: env('DEVICE_GATEWAY_MDNS_NAME') ?? hostname(),
    port: boundPort,
    address: opts.bind,
    txt: {
      v: '1',
      host: built.config.personalHostId ?? '',
      store: built.config.storeId,
      cert: opts.tls.fingerprints.certSha256,
      ...(opts.alternateOrigins === undefined || opts.alternateOrigins.length === 0 ? {}
        : { alts: opts.alternateOrigins.map((o) => new URL(o).host).join(',') }),
    },
    log: (event, fields) => console.log(JSON.stringify({ listener: 'mdns', event, ...fields })),
  });

  const shutdown = (signal: string): void => {
    console.log(JSON.stringify({ listener: 'device-gateway', signal, action: 'shutdown' }));
    if (scanTimer !== undefined) clearTimeout(scanTimer);
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
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
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
