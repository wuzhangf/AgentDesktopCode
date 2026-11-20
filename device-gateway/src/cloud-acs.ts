import type { AgentUpstream } from './agent-sessions.js';
import { fail, hash, isRecord, type Device } from './protocol.js';

type Json = Record<string, unknown>;
export const cloudIdentifier = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(value);

export class CloudAcs {
  constructor(readonly backendId: string, private readonly upstream: Pick<AgentUpstream, 'call'>) {}

  async call(scope: string, method: string, path: string, body?: Json, key?: string,
    beforeDispatch?: () => void) {
    const digest = hash('link-cloud-acs:' + scope);
    const id = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
    const device = { id, label: 'Agent Link Cloud' } as Device;
    return this.upstream.call(device, method, path, body ?? null, key, beforeDispatch);
  }

  async catalog(scope: string): Promise<Json[]> {
    const result = await this.call(scope, 'GET', '/api/v2/projects');
    if (result.status !== 200 || !Array.isArray(result.body)) return [];
    return result.body.filter(isRecord).filter(project =>
      cloudIdentifier(project.projectId) && project.workspaceAlias === project.projectId &&
      project.authorityStatus === 'AVAILABLE',
    ).map(project => ({
      sourceKind: 'ACS', backendId: this.backendId, projectId: project.projectId,
      displayName: typeof project.displayName === 'string' ? project.displayName.slice(0, 120) : project.projectId,
    }));
  }

  async preflight(scope: string, project: string): Promise<string | undefined> {
    if (!cloudIdentifier(project)) fail('INVALID_REQUEST', 400);
    const { status, body } = await this.call(scope, 'GET', `/api/v2/projects/${project}/session-preflight`);
    if (status === 200 && isRecord(body) && body.projectId === project && body.workspaceAlias === project &&
        body.authorityStatus === 'AVAILABLE' && body.modelAvailability === 'AVAILABLE' &&
        Array.isArray(body.allowedIntents) && body.allowedIntents.includes('CODE') &&
        typeof body.revision === 'string') {
      return hash(JSON.stringify([body.revision, body.workspaceFingerprint, body.policyFingerprint]));
    }
  }
}
