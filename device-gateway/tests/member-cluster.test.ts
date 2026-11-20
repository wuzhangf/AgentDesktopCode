import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { MemberCluster } from '../src/member-cluster';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

it('publishes stable agent identities and reads the member directory', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'member-cluster-')); dirs.push(dir);
  const file = join(dir, 'connector.env');
  writeFileSync(file, [
    'PAC_RELAY_MEMBER_ORIGIN=https://member.example',
    'PAC_RELAY_AGENT_ACCESS_TOKEN=token', 'PAC_RELAY_AGENT_INSTANCE_ID=instance',
    'PAC_RELAY_MEMBER_ID=member', 'PAC_RELAY_WORKSPACE_ID=workspace',
  ].join('\n'), { mode: 0o600 });
  const requests: { url: string; method?: string; body?: string }[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    requests.push({ url: String(input), method: init?.method, body: init?.body as string | undefined });
    return Response.json({ schemaVersion: 'member-cluster/1', computers: [] });
  };
  const cluster = new MemberCluster(file, async () => ({ targets: [
    { sourceKind: 'NATIVE', engineId: 'codex', profileId: 'profile-a', backendId: 'store', projectId: 'project' },
    { sourceKind: 'NATIVE', engineId: 'codex', profileId: 'profile-a', backendId: 'store', projectId: 'other' },
    { sourceKind: 'NATIVE', engineId: 'codex', profileId: 'profile-a', backendId: 'other-store', projectId: 'other' },
  ] }), () => '测试机', fetcher);
  await cluster.sync();
  const body = JSON.parse(requests[0]!.body!);
  expect(requests[0]).toMatchObject({ url: 'https://member.example/api/daily/v1/member/link/v2/cluster/self', method: 'PUT' });
  expect(body).toMatchObject({ displayName: '测试机' });
  expect(body).not.toHaveProperty('instanceId');
  expect(body.agents).toHaveLength(2);
  expect(body.agents[0]).toMatchObject({ reportedName: 'codex', engineId: 'codex' });
  expect(body.agents[0].agentId).toMatch(/^agt-[a-f0-9]{32}$/);
  expect(body.agents.find((agent: { targets: unknown[] }) => agent.targets.length === 2)).toBeTruthy();
  await expect(cluster.directory()).resolves.toMatchObject({ schemaVersion: 'member-cluster/1' });
  expect(requests[1]).toMatchObject({ url: 'https://member.example/api/daily/v1/member/link/v2/cluster', method: 'GET' });
});
