import type { DesktopLaunchProfile } from '../bootstrap/profileResolver';
import {
  ServiceSupervisor,
  type AttachConfig,
  type AttachOrStartResult,
  type BundledServiceConfig,
  type CapabilityHandshake,
  type ServiceConnectionMode
} from './supervisor';

export interface ConnectionTarget {
  mode: ServiceConnectionMode;
  attach: AttachConfig;
  bundled?: BundledServiceConfig;
}

export interface ManagedConnection {
  generation: number;
  mode: AttachOrStartResult['mode'];
  baseUrl: string;
  token: string;
  capabilities: CapabilityHandshake;
}

export class StaleConnectionError extends Error {
  constructor() {
    super('connection result belongs to an obsolete generation');
    this.name = 'StaleConnectionError';
  }
}

export interface ConnectionCoordinatorOptions {
  supervisor?: ServiceSupervisor;
  onGenerationChanged?: (generation: number) => void;
}

export class ConnectionCoordinator {
  private readonly supervisor: ServiceSupervisor;
  private readonly onGenerationChanged?: (generation: number) => void;
  private generation = 0;
  private active: ManagedConnection | null = null;
  private flight: { key: string; promise: Promise<ManagedConnection> } | null = null;
  private closed = false;

  constructor(options: ConnectionCoordinatorOptions = {}) {
    this.supervisor = options.supervisor ?? new ServiceSupervisor();
    this.onGenerationChanged = options.onGenerationChanged;
  }

  getGeneration(): number { return this.generation; }
  isCurrentGeneration(generation: number): boolean { return !this.closed && generation === this.generation; }
  getActive(): ManagedConnection | null { return this.active; }

  connect(target: ConnectionTarget): Promise<ManagedConnection> {
    return this.start(target, false);
  }

  restart(target: ConnectionTarget): Promise<ManagedConnection> {
    return this.start(target, true);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.generation += 1;
    this.active = null;
    this.supervisor.stopOwned();
  }

  private start(target: ConnectionTarget, restart: boolean): Promise<ManagedConnection> {
    if (this.closed) return Promise.reject(new Error('connection coordinator is closed'));
    const key = JSON.stringify(target);
    if (!restart && this.active?.baseUrl && this.active && key === this.activeKey) return Promise.resolve(this.active);
    // A normal duplicate bootstrap coalesces. An explicit restart must always
    // create a new generation, even when the same target is already in flight.
    if (!restart && this.flight?.key === key) return this.flight.promise;

    const previous = this.flight?.promise;
    const generation = ++this.generation;
    this.active = null;
    this.onGenerationChanged?.(generation);
    const promise = (async () => {
      await previous?.catch(() => undefined);
      if (!this.isCurrentGeneration(generation)) throw new StaleConnectionError();
      const result = restart
        ? await this.supervisor.restart(target.attach, target.bundled, target.mode)
        : await this.supervisor.attachOrStart(target.attach, target.bundled, target.mode);
      if (!this.isCurrentGeneration(generation)) {
        if (result.mode === 'OWNED_READY') this.supervisor.stopOwned();
        throw new StaleConnectionError();
      }
      const connection: ManagedConnection = {
        generation,
        mode: result.mode,
        baseUrl: result.mode === 'OWNED_READY' ? `http://127.0.0.1:${result.port}` : (target.attach.endpoint as string),
        token: result.token,
        capabilities: result.capabilities
      };
      this.active = connection;
      this.activeKey = key;
      return connection;
    })();
    this.flight = { key, promise };
    void promise.then(() => undefined, () => undefined).then(() => {
      if (this.flight?.promise === promise) this.flight = null;
    });
    return promise;
  }

  private activeKey: string | null = null;
}

export interface ElectronProfilePathPlan {
  userData: string;
  sessionData: string;
  crashDumps: string;
  logs: string;
}

export function buildElectronProfilePathPlan(profile: DesktopLaunchProfile): ElectronProfilePathPlan {
  return {
    userData: profile.userDataDir,
    sessionData: profile.sessionDataDir,
    crashDumps: profile.crashDumpsDir,
    logs: profile.logsDir
  };
}

export interface SecondInstanceIntent {
  kind: 'FOCUS';
  profileId: string;
  credentialOverridePresent: boolean;
  /** Non-secret normalized endpoint used only to detect a connection mismatch. */
  endpoint?: string;
  /** Packaged/dev build identity; never contains argv or environment values. */
  buildId?: string;
}

const SAFE_PROFILE_ID = /^[a-z0-9][a-z0-9-]{0,47}$/;
const WINDOWS_DEVICE_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/;

export function buildSecondInstanceIntent(
  env: NodeJS.ProcessEnv = process.env,
  options: { profileId?: string; endpoint?: string; buildId?: string } = {}
): SecondInstanceIntent {
  const profileId = options.profileId ?? env.CODEAGENT_DESKTOP_PROFILE ?? 'default';
  if (!SAFE_PROFILE_ID.test(profileId) || WINDOWS_DEVICE_NAME.test(profileId)) {
    throw new Error('invalid profileId for second-instance intent');
  }
  const endpoint = normalizeEndpointSummary(options.endpoint);
  const buildId = options.buildId ?? env.CODEAGENT_DESKTOP_BUILD_ID;
  return {
    kind: 'FOCUS',
    profileId,
    credentialOverridePresent: Boolean(env.CODEAGENT_SERVICE_TOKEN),
    ...(endpoint ? { endpoint } : {}),
    ...(buildId && /^[\x21-\x7e]{1,128}$/.test(buildId) ? { buildId } : {})
  };
}

export function validateSecondInstanceIntent(value: unknown): SecondInstanceIntent | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.some((key) => !['kind', 'profileId', 'credentialOverridePresent', 'endpoint', 'buildId'].includes(key))) return null;
  if (record.kind !== 'FOCUS' || typeof record.profileId !== 'string'
      || !SAFE_PROFILE_ID.test(record.profileId) || WINDOWS_DEVICE_NAME.test(record.profileId)
      || typeof record.credentialOverridePresent !== 'boolean') return null;
  const endpoint = record.endpoint;
  if (endpoint !== undefined && (typeof endpoint !== 'string' || normalizeEndpointSummary(endpoint) !== endpoint)) return null;
  const buildId = record.buildId;
  if (buildId !== undefined && (typeof buildId !== 'string' || !/^[\x21-\x7e]{1,128}$/.test(buildId))) return null;
  return {
    kind: 'FOCUS',
    profileId: record.profileId,
    credentialOverridePresent: record.credentialOverridePresent,
    ...(typeof endpoint === 'string' ? { endpoint } : {}),
    ...(typeof buildId === 'string' ? { buildId } : {})
  };
}

function normalizeEndpointSummary(endpoint: string | undefined): string | undefined {
  if (!endpoint) return undefined;
  try {
    const parsed = new URL(endpoint);
    const host = parsed.hostname.toLowerCase();
    if (parsed.protocol !== 'http:'
        || !['127.0.0.1', 'localhost', '::1', '[::1]'].includes(host)
        || parsed.username || parsed.password || parsed.search || parsed.hash
        || (parsed.pathname !== '' && parsed.pathname !== '/')) return undefined;
    return parsed.origin;
  } catch {
    return undefined;
  }
}
