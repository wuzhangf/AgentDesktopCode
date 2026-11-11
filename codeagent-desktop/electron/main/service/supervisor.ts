/**
 * Service supervisor (MC-WU03): explicit shared attach / owned private.
 *
 * Rules implemented here:
 * - attach endpoints must be loopback; fail closed otherwise;
 * - bundled start uses a random free port, a random 256-bit token and a
 *   startup nonce passed only via child environment (never argv);
 * - only the child process spawned by this supervisor instance may be
 *   stopped, and only through the stored process handle (never by port
 *   search or arbitrary pid);
 * - capability handshake validates protocol compatibility before the
 *   desktop treats the service as ready; version skew fails closed.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import net from 'node:net';
import { generateServiceToken, generateStartNonce } from './token';

export type SupervisorState =
  | 'BOOTING'
  | 'TRY_ATTACH'
  | 'ATTACHED'
  | 'STARTING'
  | 'OWNED_READY'
  | 'START_FAILED';

export interface CapabilityHandshake {
  serviceInstanceId: string;
  storeId?: string;
  bootId?: string;
  protocolVersion: string;
  minDesktopProtocol?: string;
  features?: Record<string, unknown>;
  limits?: Record<string, unknown>;
  multiClient?: MultiClientCapability;
  operations: CapabilityOperation[];
}

export interface MultiClientCapability {
  contractVersion: string;
  mode: string;
  lifecycle: string;
  registrationRequiredForMutation: boolean;
  limits?: Record<string, unknown>;
}

export interface CapabilityOperation {
  id: string;
  availability: 'AVAILABLE' | 'DEGRADED' | 'UNAVAILABLE';
  reasonCode?: string;
  limits?: Record<string, unknown>;
  contractVersion: string;
}

export interface AttachConfig {
  /** loopback http endpoint of an already running service */
  endpoint?: string;
  /** bearer token for the configured service */
  token?: string;
}

export type ServiceConnectionMode = 'SHARED_ATTACH' | 'OWNED_PRIVATE';

export interface BundledServiceConfig {
  command: string;
  args: string[];
  cwd?: string;
  handshakeTimeoutMs?: number;
}

export type AttachOrStartResult =
  | { mode: 'ATTACHED'; capabilities: CapabilityHandshake; token: string }
  | { mode: 'OWNED_READY'; capabilities: CapabilityHandshake; port: number; token: string };

export type StopOwnedResult = 'STOPPED' | 'ALREADY_EXITED' | 'NOT_OWNED';

/**
 * The owned service refused a restart-prepare because work is executing.
 * The desktop surfaces this as a refusal — it never kills a busy child.
 */
export class ServiceBusyError extends Error {
  constructor(
    message: string,
    public readonly activeRuns?: number,
    public readonly queuedRuns?: number
  ) {
    super(message);
    this.name = 'ServiceBusyError';
  }
}

export class HandshakeError extends Error {
  constructor(
    public readonly code: 'NON_LOOPBACK' | 'HTTP_ERROR' | 'INVALID_CAPABILITIES' | 'INCOMPATIBLE_VERSION' | 'TIMEOUT' | 'CHILD_EXITED' | 'SPAWN_FAILED',
    message: string
  ) {
    super(message);
    this.name = 'HandshakeError';
  }
}

const MIN_DESKTOP_PROTOCOL = '2.0';
const PROTOCOL_VERSION_PATTERN = /^\d+(?:\.\d+)+$/;

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

export function isLoopbackEndpoint(endpoint: string): boolean {
  try {
    const parsed = new URL(endpoint);
    if (parsed.protocol !== 'http:') return false;
    const host = parsed.hostname;
    if (!(host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]')) return false;
    return parsed.username.length === 0 && parsed.password.length === 0
      && parsed.search.length === 0 && parsed.hash.length === 0
      && (parsed.pathname === '' || parsed.pathname === '/');
  } catch {
    return false;
  }
}

export function validateCapabilities(payload: unknown): { ok: true; value: CapabilityHandshake } | { ok: false; reason: string } {
  if (typeof payload !== 'object' || payload === null) {
    return { ok: false, reason: 'capabilities payload is not an object' };
  }
  const record = payload as Record<string, unknown>;
  if (typeof record.serviceInstanceId !== 'string' || record.serviceInstanceId.length === 0
      || record.serviceInstanceId.length > 256 || /[\u0000-\u001f\u007f]/.test(record.serviceInstanceId)) {
    return { ok: false, reason: 'serviceInstanceId missing' };
  }
  if (typeof record.protocolVersion !== 'string' || !PROTOCOL_VERSION_PATTERN.test(record.protocolVersion)) {
    return { ok: false, reason: 'protocolVersion missing' };
  }
  const rawMinDesktop = record.minDesktopProtocol;
  if (rawMinDesktop !== undefined && (typeof rawMinDesktop !== 'string' || rawMinDesktop.length === 0)) {
    return { ok: false, reason: 'minDesktopProtocol is invalid' };
  }
  const minDesktop = typeof rawMinDesktop === 'string' ? rawMinDesktop : MIN_DESKTOP_PROTOCOL;
  if (!PROTOCOL_VERSION_PATTERN.test(minDesktop)) {
    return { ok: false, reason: 'minDesktopProtocol is invalid' };
  }
  for (const [name, candidate] of [['features', record.features], ['limits', record.limits] as const]) {
    if (candidate !== undefined && (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate))) {
      return { ok: false, reason: `${name} is invalid` };
    }
  }
  for (const name of ['storeId', 'bootId'] as const) {
    const value = record[name];
    if (value !== undefined && (typeof value !== 'string' || value.length === 0
        || value.length > 256 || /[\u0000-\u001f\u007f]/.test(value))) {
      return { ok: false, reason: `${name} is invalid` };
    }
  }
  let multiClient: MultiClientCapability | undefined;
  if (record.multiClient !== undefined) {
    if (typeof record.multiClient !== 'object' || record.multiClient === null
        || Array.isArray(record.multiClient)) {
      return { ok: false, reason: 'multiClient is invalid' };
    }
    const candidate = record.multiClient as Record<string, unknown>;
    if (typeof candidate.contractVersion !== 'string' || candidate.contractVersion.length === 0
        || typeof candidate.mode !== 'string' || candidate.mode.length === 0
        || typeof candidate.lifecycle !== 'string' || candidate.lifecycle.length === 0
        || typeof candidate.registrationRequiredForMutation !== 'boolean') {
      return { ok: false, reason: 'multiClient is invalid' };
    }
    if (candidate.limits !== undefined && (typeof candidate.limits !== 'object'
        || candidate.limits === null || Array.isArray(candidate.limits))) {
      return { ok: false, reason: 'multiClient.limits is invalid' };
    }
    multiClient = {
      contractVersion: candidate.contractVersion,
      mode: candidate.mode,
      lifecycle: candidate.lifecycle,
      registrationRequiredForMutation: candidate.registrationRequiredForMutation,
      ...(candidate.limits && typeof candidate.limits === 'object'
        ? { limits: candidate.limits as Record<string, unknown> } : {})
    };
  }
  // fail closed when the desktop protocol is older than what the service requires
  if (compareVersions(MIN_DESKTOP_PROTOCOL, minDesktop) < 0) {
    return {
      ok: false,
      reason: `desktop protocol ${MIN_DESKTOP_PROTOCOL} is older than required ${minDesktop}`
    };
  }
  if (!Array.isArray(record.operations)) {
    return { ok: false, reason: 'operations missing' };
  }
  const operations: CapabilityOperation[] = [];
  for (const [index, value] of record.operations.entries()) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return { ok: false, reason: `operations[${index}] is not an object` };
    }
    const operation = value as Record<string, unknown>;
    if (typeof operation.id !== 'string' || operation.id.length === 0
        || (operation.availability !== 'AVAILABLE'
          && operation.availability !== 'DEGRADED'
          && operation.availability !== 'UNAVAILABLE')
        || typeof operation.contractVersion !== 'string' || operation.contractVersion.length === 0) {
      return { ok: false, reason: `operations[${index}] is invalid` };
    }
    const reasonCode = operation.reasonCode;
    if (reasonCode !== undefined && reasonCode !== null && typeof reasonCode !== 'string') {
      return { ok: false, reason: `operations[${index}].reasonCode is invalid` };
    }
    const operationLimits = operation.limits;
    if (operationLimits !== undefined && operationLimits !== null
        && (typeof operationLimits !== 'object' || Array.isArray(operationLimits))) {
      return { ok: false, reason: `operations[${index}].limits is invalid` };
    }
    operations.push({
      id: operation.id,
      availability: operation.availability,
      ...(typeof reasonCode === 'string' ? { reasonCode } : {}),
      ...(operationLimits && typeof operationLimits === 'object' ? { limits: operationLimits as Record<string, unknown> } : {}),
      contractVersion: operation.contractVersion
    });
  }
  return {
    ok: true,
    value: {
      serviceInstanceId: record.serviceInstanceId,
      ...(typeof record.storeId === 'string' ? { storeId: record.storeId } : {}),
      ...(typeof record.bootId === 'string' ? { bootId: record.bootId } : {}),
      protocolVersion: record.protocolVersion,
      minDesktopProtocol: minDesktop,
      features: (typeof record.features === 'object' && record.features !== null ? record.features : undefined) as
        | Record<string, unknown>
        | undefined,
      limits: (typeof record.limits === 'object' && record.limits !== null ? record.limits : undefined) as
        | Record<string, unknown>
        | undefined,
      ...(multiClient ? { multiClient } : {}),
      operations
    }
  };
}

export async function handshake(
  endpoint: string,
  token: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 5000
): Promise<CapabilityHandshake> {
  if (!isLoopbackEndpoint(endpoint)) {
    throw new HandshakeError('NON_LOOPBACK', `endpoint is not loopback: host must be 127.0.0.1/localhost/::1`);
  }
  if (!token || token.trim().length === 0) {
    throw new HandshakeError('INVALID_CAPABILITIES', 'missing bearer token');
  }
  let response: Response;
  try {
    response = await fetchImpl(new URL('/api/v2/capabilities', endpoint), {
      headers: { authorization: `Bearer ${token}` },
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch (err) {
    throw new HandshakeError('TIMEOUT', `capability handshake failed: ${String(err)}`);
  }
  if (!response.ok) {
    throw new HandshakeError('HTTP_ERROR', response.status === 401 || response.status === 403
      ? `capability handshake returned HTTP ${response.status}（凭证与该 Service 不匹配；若 Service 已重启或更换，请用启动方的凭证重新连接）`
      : `capability handshake returned HTTP ${response.status}`);
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch (err) {
    throw new HandshakeError('INVALID_CAPABILITIES', `capability response is not valid JSON: ${String(err)}`);
  }
  const validated = validateCapabilities(body);
  if (!validated.ok) {
    throw new HandshakeError('INVALID_CAPABILITIES', validated.reason);
  }
  return validated.value;
}

export function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address && typeof address === 'object') {
        const port = address.port;
        server.close(() => resolve(port));
      } else {
        server.close();
        reject(new Error('failed to obtain a free port'));
      }
    });
  });
}

interface OwnedChild {
  child: ChildProcess;
  pid: number;
  nonce: string;
  port: number;
  /** bearer token minted for this child; used for the lifecycle API */
  token: string;
  startedAt: number;
  stopRequested: boolean;
  /** set only when the supervisor deliberately replaces a healthy child */
  intentionalStop: boolean;
}

const HANDSHAKE_RETRY_MS = 100;
/** Graceful-shutdown window before falling back to a kill signal. */
const CHILD_EXIT_GRACE_MS = 10_000;
/** Bound on the wait after a kill — a stuck child aborts the restart. */
const CHILD_EXIT_KILL_MS = 5_000;

export interface SupervisorOptions {
  /** injectable for deterministic tests; defaults to a random 256-bit token */
  tokenGenerator?: () => string;
  /** called when an owned child that reached OWNED_READY dies unexpectedly (design §6.4 rule 5) */
  onOwnedExit?: (info: { pid: number; port: number; exitCode: number | null }) => void;
}

export class ServiceSupervisor {
  private state: SupervisorState = 'BOOTING';
  private owned: OwnedChild | null = null;
  private readonly tokenGenerator: () => string;
  private readonly onOwnedExit?: SupervisorOptions['onOwnedExit'];

  constructor(options: SupervisorOptions = {}) {
    this.tokenGenerator = options.tokenGenerator ?? generateServiceToken;
    this.onOwnedExit = options.onOwnedExit;
  }

  getState(): SupervisorState {
    return this.state;
  }

  /**
   * Identity of the owned child, for diagnostics only. Contains no token.
   */
  getOwnedProcessInfo(): { pid: number; nonce: string; port: number; startedAt: number } | null {
    if (!this.owned) return null;
    const { pid, nonce, port, startedAt } = this.owned;
    return { pid, nonce, port, startedAt };
  }

  async attachOrStart(
    attach: AttachConfig,
    bundled?: BundledServiceConfig,
    mode: ServiceConnectionMode = 'SHARED_ATTACH'
  ): Promise<AttachOrStartResult> {
    this.state = 'TRY_ATTACH';
    if (mode === 'SHARED_ATTACH') {
      if (!attach.endpoint || !attach.token) {
        this.state = 'START_FAILED';
        throw new HandshakeError('INVALID_CAPABILITIES', 'SHARED_ATTACH requires an endpoint and token');
      }
      try {
        const capabilities = await handshake(attach.endpoint, attach.token);
        this.state = 'ATTACHED';
        return { mode: 'ATTACHED', capabilities, token: attach.token };
      } catch (err) {
        this.state = 'START_FAILED';
        // SHARED_ATTACH never creates a local child after a failed attach.
        throw err;
      }
    }

    // OWNED_PRIVATE is deliberately opt-in. It may attach only when no child
    // launch configuration was supplied; a configured child is always started
    // with a fresh token generated below.
    if (bundled) return this.startBundled(bundled);
    if (attach.endpoint && attach.token) {
      try {
        const capabilities = await handshake(attach.endpoint, attach.token);
        this.state = 'ATTACHED';
        return { mode: 'ATTACHED', capabilities, token: attach.token };
      } catch (err) {
        this.state = 'START_FAILED';
        throw err;
      }
    }
    if (!bundled) {
      this.state = 'START_FAILED';
      throw new HandshakeError('INVALID_CAPABILITIES', 'OWNED_PRIVATE requires a bundled service config');
    }
    throw new Error('unreachable');
  }

  private async startBundled(bundled: BundledServiceConfig): Promise<AttachOrStartResult> {
    this.state = 'STARTING';
    const port = await pickFreePort();
    // token/nonce are generated here and passed only through the child environment
    const token = this.tokenGenerator();
    const nonce = generateStartNonce();
    let child: ChildProcess;
    try {
      child = spawn(bundled.command, bundled.args, {
        cwd: bundled.cwd,
        env: {
          ...process.env,
          CODEAGENT_SERVICE_PORT: String(port),
          CODEAGENT_SERVICE_TOKEN: token,
          CODEAGENT_SERVICE_NONCE: nonce
        },
        stdio: ['ignore', 'ignore', 'pipe'],
        windowsHide: true
      });
    } catch (err) {
      this.state = 'START_FAILED';
      throw new HandshakeError('SPAWN_FAILED', `bundled service could not be started: ${String(err)}`);
    }
    let spawnError: Error | undefined;
    child.on('error', (error) => {
      spawnError = error;
    });
    if (typeof child.pid !== 'number') {
      this.state = 'START_FAILED';
      safeKill(child);
      throw new HandshakeError('SPAWN_FAILED', 'bundled service did not expose a process id');
    }
    // stderr is piped but never consumed; drain it so a chatty child can
    // never fill the OS pipe buffer and block on write.
    child.stderr?.resume();
    const owned: OwnedChild = {
      child,
      pid: child.pid,
      nonce,
      port,
      token,
      startedAt: Date.now(),
      stopRequested: false,
      intentionalStop: false
    };
    this.owned = owned;
    const deadline = Date.now() + (bundled.handshakeTimeoutMs ?? 10_000);
    let exitCode: number | null | undefined = undefined;
    let ready = false;
    child.on('exit', (code) => {
      exitCode = code;
      // a deliberate replacement (restart) is not an unexpected exit
      if (ready && !owned.intentionalStop && this.onOwnedExit) {
        this.onOwnedExit({ pid: child.pid as number, port, exitCode: code ?? null });
      }
    });
    try {
      while (Date.now() < deadline) {
        if (spawnError) {
          throw new HandshakeError('SPAWN_FAILED', `bundled service failed to start: ${String(spawnError)}`);
        }
        if (exitCode !== undefined) {
          throw new HandshakeError('CHILD_EXITED', `bundled service exited early with code ${String(exitCode)}`);
        }
        try {
          const capabilities = await handshake(`http://127.0.0.1:${port}`, token, fetch, 1500);
          ready = true;
          this.state = 'OWNED_READY';
          // This is the exact bearer used by the child handshake and must be
          // used by Main for every subsequent request to this child.
          return { mode: 'OWNED_READY', capabilities, port, token };
        } catch {
          await delay(HANDSHAKE_RETRY_MS);
        }
      }
      throw new HandshakeError('TIMEOUT', 'bundled service did not become ready in time');
    } catch (err) {
      this.state = 'START_FAILED';
      this.stopOwnedChild(owned);
      throw err;
    }
  }

  /**
   * Re-runs ATTACH_OR_START after a failure (degraded shell "restart").
   * A previous failed start attempt's records are dropped first; a running
   * owned child is stopped so we never leak a second writer.
   *
   * Restart of a live owned child is a controlled lifecycle (design
   * 2026-10-08 §5.3/MC-08): restart-prepare admits only an idle service
   * (BUSY refuses — a run must never be killed mid-flight), shutdown
   * exits the child through its own shutdown hooks, and the supervisor
   * waits for the process to actually exit before spawning the next
   * writer. A child that predates the lifecycle API falls back to a
   * kill + wait — the second spawn still never overlaps the first.
   */
  async restart(
    attach: AttachConfig,
    bundled?: BundledServiceConfig,
    mode: ServiceConnectionMode = 'SHARED_ATTACH'
  ): Promise<AttachOrStartResult> {
    const owned = this.owned;
    if (owned && owned.child.exitCode === null && owned.child.signalCode === null) {
      // replacing a live child on purpose must not surface as a crash event
      owned.intentionalStop = true;
      owned.stopRequested = true;
      const graceful = await this.requestGracefulShutdown(owned);
      if (!graceful) {
        safeKill(owned.child);
      }
      // Never spawn a second owner while the first still holds the state
      // directory (owner.lock / SQLite). A child that ignores both the
      // graceful endpoint and the kill signal aborts the restart instead.
      const exited = await this.awaitExit(owned, CHILD_EXIT_GRACE_MS);
      if (!exited && !graceful) {
        throw new HandshakeError(
          'CHILD_EXITED', 'owned service did not exit; restart aborted to keep a single state writer');
      }
      if (!exited) {
        safeKill(owned.child);
        const killed = await this.awaitExit(owned, CHILD_EXIT_KILL_MS);
        if (!killed) {
          throw new HandshakeError(
            'CHILD_EXITED', 'owned service did not exit after kill; restart aborted to keep a single state writer');
        }
      }
    }
    this.owned = null;
    return this.attachOrStart(attach, bundled, mode);
  }

  /**
   * Runs the lifecycle restart protocol against the owned child:
   * restart-prepare (nonce + bearer) → shutdown. Returns true when the
   * child acknowledged shutdown, false when the surface is unsupported
   * or unreachable (legacy children keep the kill path). A BUSY answer
   * throws {@link ServiceBusyError} — the restart is refused, the child
   * keeps running.
   */
  private async requestGracefulShutdown(owned: OwnedChild): Promise<boolean> {
    const endpoint = `http://127.0.0.1:${owned.port}`;
    const headers = {
      authorization: `Bearer ${owned.token}`,
      'x-service-nonce': owned.nonce,
      'content-type': 'application/json'
    };
    try {
      const prepare = await fetch(`${endpoint}/api/v2/local-lifecycle/restart-prepare`, {
        method: 'POST', headers, body: '{}',
        signal: AbortSignal.timeout(3000)
      });
      if (!prepare.ok) return false;
      const prepared = await prepare.json() as {
        state?: string; restartToken?: string; activeRuns?: number; queuedRuns?: number;
      };
      if (prepared.state === 'UNSUPPORTED') return false;
      if (prepared.state === 'BUSY') {
        // The child is still alive and healthy — only the restart is refused.
        owned.intentionalStop = false;
        owned.stopRequested = false;
        throw new ServiceBusyError(
          'service has active runs; restart refused', prepared.activeRuns, prepared.queuedRuns);
      }
      if (prepared.state !== 'READY' || !prepared.restartToken) return false;
      const shutdown = await fetch(`${endpoint}/api/v2/local-lifecycle/shutdown`, {
        method: 'POST', headers, body: JSON.stringify({ restartToken: prepared.restartToken }),
        signal: AbortSignal.timeout(3000)
      });
      return shutdown.ok;
    } catch (err) {
      if (err instanceof ServiceBusyError) throw err;
      return false;
    }
  }

  /** Resolves true when the child exits within {@code timeoutMs}. */
  private awaitExit(owned: OwnedChild, timeoutMs: number): Promise<boolean> {
    const child = owned.child;
    if (child.exitCode !== null || child.signalCode !== null) {
      return Promise.resolve(true);
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        child.removeListener('exit', onExit);
        resolve(false);
      }, timeoutMs);
      const onExit = (): void => {
        clearTimeout(timer);
        resolve(true);
      };
      child.once('exit', onExit);
    });
  }

  private stopOwnedChild(owned: OwnedChild): void {
    owned.intentionalStop = true;
    if (!owned.stopRequested && owned.child.exitCode === null && owned.child.signalCode === null) {
      owned.stopRequested = true;
      safeKill(owned.child);
    }
    if (this.owned === owned) this.owned = null;
  }

  /**
   * Stops only the child this supervisor spawned, idempotently.
   * There is intentionally no API to stop a process by pid or port:
   * unknown Java processes must never be touched (design 6.4 rule 4).
   *
   * Note: on Windows a killed child may never report an exitCode, but its
   * signalCode becomes SIGTERM, so termination is detected via either.
   */
  stopOwned(): StopOwnedResult {
    const owned = this.owned;
    if (!owned) return 'NOT_OWNED';
    const exited =
      (owned.child.exitCode !== null && owned.child.exitCode !== undefined) ||
      owned.child.signalCode !== null;
    if (exited) return 'ALREADY_EXITED';
    if (owned.stopRequested) {
      // signal already sent; the OS may still be tearing the process down
      return 'STOPPED';
    }
    owned.stopRequested = true;
    safeKill(owned.child);
    return 'STOPPED';
  }
}

function safeKill(child: ChildProcess): void {
  try {
    child.kill();
  } catch {
    // A spawn failure can leave a ChildProcess without an OS handle. There is
    // nothing to clean up in that case, and the original spawn error remains
    // the authoritative failure.
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
