import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { fail, GatewayError, isRecord } from './protocol.js';

type Json = Record<string, unknown>;
type MemberMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';
const linkRoute = '/api/daily/v1/member/link/v2';
const route = `${linkRoute}/cluster`;
const selfRoute = `${route}/self`;
const identifier = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(value);

interface MemberClusterIdentity {
  origin: string;
  bearer: string;
  instanceId: string;
  memberId: string;
  workspaceId: string;
}
const readIdentity = (file: string): MemberClusterIdentity | undefined => {
  try {
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.size > 16_384 || (process.platform !== 'win32' && (stat.mode & 0o077) !== 0)) return;
    const values = new Map(readFileSync(file, 'utf8').split(/\r?\n/).flatMap(line => {
      const match = /^PAC_RELAY_([A-Z_]+)=(.*)$/.exec(line);
      return match ? [[match[1]!, match[2]!.trim()] as const] : [];
    }));
    const origin = values.get('MEMBER_ORIGIN');
    const bearer = values.get('AGENT_ACCESS_TOKEN');
    const instanceId = values.get('AGENT_INSTANCE_ID');
    const memberId = values.get('MEMBER_ID');
    const workspaceId = values.get('WORKSPACE_ID');
    if (!origin || !bearer || !identifier(instanceId) || !identifier(memberId) || !identifier(workspaceId)) return;
    const parsed = new URL(origin);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password ||
        parsed.pathname !== '/' || parsed.search || parsed.hash) return;
    return { origin: parsed.origin, bearer, instanceId, memberId, workspaceId };
  } catch { return; }
};
const stableId = (value: string): string => 'agt-' + createHash('sha256').update(value).digest('hex').slice(0, 32);

export class MemberCluster {
  private timer?: ReturnType<typeof setTimeout>;
  private readonly shutdown = new AbortController();

  constructor(
    private readonly sessionFile: string,
    private readonly catalog: () => Promise<Json>,
    private readonly displayName: () => string,
    private readonly fetcher: typeof fetch = fetch,
    private readonly expectedOrigin?: string,
  ) {}

  stop(): void {
    this.shutdown.abort();
    clearTimeout(this.timer);
  }

  start(): void {
    void this.sync().finally(() => this.schedule());
  }

  private schedule(): void {
    if (this.shutdown.signal.aborted) return;
    this.timer = setTimeout(() => void this.sync().finally(() => this.schedule()), 30_000);
    this.timer.unref();
  }

  private identity(): MemberClusterIdentity {
    const value = readIdentity(this.sessionFile);
    if (!value) fail('MEMBER_SESSION_REQUIRED', 409);
    if (this.expectedOrigin !== undefined && value.origin !== this.expectedOrigin) fail('MEMBER_SESSION_ORIGIN_MISMATCH', 409);
    return value;
  }
  private assertCurrent(identity: MemberClusterIdentity): void {
    const current = this.identity();
    if (current.origin !== identity.origin || current.instanceId !== identity.instanceId ||
        current.memberId !== identity.memberId || current.workspaceId !== identity.workspaceId ||
        current.bearer !== identity.bearer) fail('MEMBER_SESSION_CHANGED', 409);
  }

  private async request(identity: MemberClusterIdentity, method: MemberMethod, path: string, body?: Json): Promise<Json> {
    this.assertCurrent(identity);
    try {
      const response = await this.fetcher(identity.origin + path, {
        method,
        redirect: 'error',
        signal: AbortSignal.any([AbortSignal.timeout(8000), this.shutdown.signal]),
        headers: { Authorization: `Bearer ${identity.bearer}`, 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const value: unknown = response.status === 204 ? {} : await response.json();
      if (!response.ok || !isRecord(value)) fail(isRecord(value) && typeof value.code === 'string' ? value.code : 'MEMBER_CLUSTER_UNAVAILABLE', response.status || 503);
      this.assertCurrent(identity);
      return value;
    } catch (error) {
      if (error instanceof GatewayError) throw error;
      fail('MEMBER_CLUSTER_UNAVAILABLE', 503);
    }
  }
  async sync(): Promise<void> {
    try {
      const identity = this.identity();
      const source = await this.catalog();
      const raw = Array.isArray(source.targets) ? source.targets : [];
      const grouped = new Map<string, { agentId: string; reportedName: string; engineId: string; targets: Json[] }>();
      for (const item of raw) {
        if (!isRecord(item) || item.sourceKind !== 'NATIVE' || !identifier(item.engineId)
          || !identifier(item.backendId) || !identifier(item.projectId)) continue;
        const profile = typeof item.profileId === 'string' && identifier(item.profileId) ? item.profileId : item.engineId;
        const engineId = item.engineId;
        const backendId = item.backendId;
        const agentId = stableId(`${identity.instanceId}:${engineId}:${profile}:${backendId}`);
        const row = grouped.get(agentId) ?? { agentId, reportedName: engineId, engineId, targets: [] };
        if (!row.targets.some(target => target.backendId === backendId && target.projectId === item.projectId)) {
          row.targets.push({ backendId, projectId: item.projectId });
        }
        grouped.set(agentId, row);
      }
      await this.request(identity, 'PUT', selfRoute, { displayName: this.displayName().slice(0, 80), agents: [...grouped.values()] });
    } catch { /* best effort; reads remain fail-closed */ }
  }
  async directory(): Promise<Json> {
    return this.request(this.identity(), 'GET', route);
  }

  delegationIdentity(): string {
    const identity = this.identity();
    return createHash('sha256').update(JSON.stringify([
      identity.origin, identity.memberId, identity.workspaceId, identity.instanceId,
    ])).digest('hex');
  }

  async delegationRequest(method: MemberMethod, path: string, body?: Json): Promise<Json> {
    if (!/^\/delegations(?:\/[A-Za-z0-9_.-]+)*(?:\?(?:after|limit)=\d+)?$/.test(path)
      || /(?:^|\/)\.{1,2}(?:\/|\?|$)/.test(path)) fail('INVALID_REQUEST', 400);
    return this.request(this.identity(), method, linkRoute + path, body);
  }

  async authorizeInteraction(callerInstanceId: string, expectedBinding?: string): Promise<string> {
    const identity = this.identity();
    const binding = createHash('sha256').update(JSON.stringify([
      identity.origin, identity.memberId, identity.workspaceId, identity.instanceId, callerInstanceId,
    ])).digest('hex');
    if (expectedBinding !== undefined && expectedBinding !== binding) fail('MEMBER_SESSION_CHANGED', 409);
    const directory = await this.request(identity, 'GET', route);
    if (directory.schemaVersion !== 'member-cluster/1' || !Array.isArray(directory.computers)) {
      fail('MEMBER_CLUSTER_UNAVAILABLE', 503);
    }
    const computers = directory.computers;
    const registered = (instanceId: string) => computers.some(computer =>
      isRecord(computer) && computer.instanceId === instanceId);
    if (!registered(identity.instanceId) || !registered(callerInstanceId)) fail('SCOPE_DENIED', 403);
    return binding;
  }
}
