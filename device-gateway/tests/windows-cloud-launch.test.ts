import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import type { GatewayContext } from '../src/context';
import { createOwnerListener } from '../src/http';
import { GatewayStore } from '../src/store';
import { LocalTaskAccess, type LocalAuthLike, type LocalTransportLike } from '../src/local-tasks';
import { LocalTransportError } from '../src/local-transport';
import { WindowsCloudLaunch } from '../src/windows-cloud-launch';
import { UpdatePreparation } from '../src/update-preparation';

it('uses the Windows grant file through the local owner route and fences a stale member view', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'link-windows-owner-'));
  const origin = 'https://hosted.test';
  const session = join(dir, 'connector.env');
  const grantFile = join(dir, 'windows-cloud-launch.json');
  const project = { backendStoreId: 'store', projectId: 'project', engineId: 'pi' };
  const fixtureGrant = { schemaVersion: 'windows-cloud-launch-grant/1', revision: 4,
    memberId: 'member', workspaceId: 'workspace', instanceId: 'instance',
    controls: true, approvals: false, launchScopes: [project] };
  function writeSession(member: string): void {
    writeFileSync(session, [
      `PAC_RELAY_MEMBER_ORIGIN=${origin}`, 'PAC_RELAY_CLIENT_ID=agent-link',
      'PAC_RELAY_AGENT_ACCESS_TOKEN=fixture', `PAC_RELAY_MEMBER_ID=${member}`,
      'PAC_RELAY_WORKSPACE_ID=workspace', 'PAC_RELAY_AGENT_INSTANCE_ID=instance',
    ].join('\n'));
  }
  writeSession('member');
  writeFileSync(grantFile, JSON.stringify(fixtureGrant));
  const store = new GatewayStore(dir);
  const transport = {} as LocalTransportLike;
  const catalog = new LocalTaskAccess({} as LocalAuthLike, transport, store);
  vi.spyOn(catalog, 'ownerCatalog').mockResolvedValue({ backendStoreId: 'store',
    projects: [{ projectId: 'project' }], engines: [{ engineId: 'pi' }] });
  const hosted = vi.fn<typeof fetch>().mockImplementation(() => Promise.reject(Error('Cloud must not be called')));
  const launch = new WindowsCloudLaunch(store, catalog, transport, 'host', origin, session, grantFile,
    hosted, false, undefined, 'file');
  const ctx = { cloudLaunchGrant: request => launch.ownerGrant(request) } as GatewayContext;
  const server = createOwnerListener({ ctx, ownerToken: 'fixture-owner', ownerClientToken: 'fixture-client',
    bind: '127.0.0.1', port: 0 });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const path = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v2/personal-access/cloud-launch-grant`;
  const headers = { Authorization: 'Bearer fixture-owner', 'X-Client-Session': 'fixture-client',
    'Content-Type': 'application/json' };
  const put = (body: unknown) => fetch(path, { headers, method: 'PUT', body: JSON.stringify(body) });
  try {
    const anonymous = await fetch(path);
    expect(anonymous.status).toBe(401);
    await anonymous.text();
    const original = await (await fetch(path, { headers })).json() as Record<string, unknown>;
    expect(original).toMatchObject({ revision: 4, launchScopes: [project],
      targets: [{ backendId: 'store', projectId: 'project', engineId: 'pi' }] });
    const update = { expectedScope: original.scope, expectedRevision: 4,
      launchScopes: [project], controls: true, approvals: true };
    expect(await (await put({ ...update, launchScopes: [{ ...project, engineId: 'unlisted' }] })).json())
      .toMatchObject({ code: 'CLOUD_TARGET_UNAVAILABLE' });
    expect(await (await put(update)).json()).toMatchObject({ revision: 5, approvals: true });
    expect(JSON.parse(readFileSync(grantFile, 'utf8'))).toEqual({ ...fixtureGrant, revision: 5, approvals: true });
    expect(await (await put(update)).json()).toMatchObject({ code: 'CLOUD_GRANT_CHANGED' });

    writeSession('other-member');
    const current = await (await fetch(path, { headers })).json() as Record<string, unknown>;
    expect(current).toMatchObject({ revision: 0, launchScopes: [] });
    expect(current.scope).not.toBe(original.scope);
    expect(await (await put({ ...update, expectedRevision: 0 })).json())
      .toMatchObject({ code: 'CLOUD_SESSION_CHANGED' });

    writeSession('member');
    expect(await (await put({ ...update, expectedRevision: 5, launchScopes: [] })).json())
      .toMatchObject({ revision: 6, launchScopes: [], controls: false, approvals: false });
    expect(JSON.parse(readFileSync(grantFile, 'utf8'))).toEqual({
      ...fixtureGrant, revision: 6, controls: false, approvals: false, launchScopes: [],
    });
    expect(hosted).not.toHaveBeenCalled();
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

it.skipIf(typeof process.getuid !== 'function')('waits for a live target and avoids publication after concurrent revocation', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'link-owner-cloud-'));
  const session = join(dir, 'member-session.env');
  const origin = 'https://hosted.test';
  writeFileSync(session, [
    `PAC_RELAY_MEMBER_ORIGIN=${origin}`, 'PAC_RELAY_CLIENT_ID=agent-link',
    'PAC_RELAY_AGENT_ACCESS_TOKEN=fixture', 'PAC_RELAY_MEMBER_ID=member',
    'PAC_RELAY_WORKSPACE_ID=workspace', 'PAC_RELAY_AGENT_INSTANCE_ID=instance',
  ].join('\n'), { mode: 0o600 });
  const store = new GatewayStore(dir);
  const transport = {} as LocalTransportLike;
  const catalog = new LocalTaskAccess({} as LocalAuthLike, transport, store);
  const readCatalog = vi.spyOn(catalog, 'ownerCatalog').mockResolvedValue({ backendStoreId: 'store',
    projects: [{ projectId: 'project' }], engines: [{ engineId: 'pi' }] });
  const published: unknown[] = [];
  let revokeDuringLookup = false;
  const launch = new WindowsCloudLaunch(store, catalog, transport, 'host', origin, session, '',
    async (input, init) => {
      if (init?.method === 'GET' && new URL(String(input)).pathname.endsWith('/targets')) {
        if (revokeDuringLookup) {
          revokeDuringLookup = false;
          await launch.ownerGrant({ expectedRevision: 1, launchScopes: [], controls: false, approvals: false });
        }
        return Response.json({ revision: 0 });
      }
      if (init?.method === 'PUT' && typeof init.body === 'string') {
        published.push(JSON.parse(init.body).targets);
        return Response.json({});
      }
      throw Error('Unexpected Hosted request');
    }, false, undefined, 'store');
  try {
    const grant = { expectedRevision: 0, launchScopes: [{ backendStoreId: 'store', projectId: 'project', engineId: 'pi' }],
      controls: false, approvals: false };
    expect(await launch.ownerGrant(grant)).toMatchObject({ revision: 1 });
    readCatalog.mockResolvedValueOnce({});
    await launch.tick();
    expect(published).toEqual([[]]);
    revokeDuringLookup = true;
    await launch.tick();
    expect(published).toEqual([[]]);
    await launch.tick();
    expect(published).toEqual([[], []]);
    expect(await launch.ownerGrant()).toMatchObject({ revision: 2, launchScopes: [] });
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

it('publishes only owner-approved targets and recovers both replies across restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'windows-cloud-test-'));
  const session = join(dir, 'connector.env');
  const grant = join(dir, 'grant.json');
  const origin = 'https://hosted.test';
  writeFileSync(session, [
    `PAC_RELAY_MEMBER_ORIGIN=${origin}`, 'PAC_RELAY_CLIENT_ID=agent-link',
    'PAC_RELAY_AGENT_ACCESS_TOKEN=fixture', 'PAC_RELAY_MEMBER_ID=member',
    'PAC_RELAY_WORKSPACE_ID=workspace', 'PAC_RELAY_AGENT_INSTANCE_ID=instance',
  ].join('\n'));
  const target = { sourceKind: 'NATIVE', backendId: 'store', projectId: 'project', engineId: 'pi', capabilityRevision: '1' };
  const savedGrant = { schemaVersion: 'windows-cloud-launch-grant/1', revision: 1,
    memberId: 'member', workspaceId: 'workspace', instanceId: 'instance', controls: true, approvals: true,
    launchScopes: [{ backendStoreId: 'store', projectId: 'project', engineId: 'pi' }] };
  writeFileSync(grant, JSON.stringify(savedGrant));
  const command = { commandId: 'delivery', workId: 'work', kind: 'link.task.launch.v2', deliveryGeneration: 1,
    payload: { target: { ...target, instanceId: 'instance' }, payloadDigest: 'digest', nativeRequestKey: 'original-key',
      instruction: { text: 'Run fixture' }, attachments: [], parameters: {} } };
  const withdrawn = { ...command, commandId: 'withdrawn', workId: 'withdrawn-work',
    payload: { ...command.payload, nativeRequestKey: 'withdrawn-key', payloadDigest: 'withdrawn-digest' } };
  const row = { connectionId: 'backend', kind: 'WORKER_LOCAL' };
  const task = { taskId: 'native-task', engineId: 'pi', state: 'RUNNING', generation: 'generation',
    nativeSessionId: 'session', nativeTurnId: 'turn', currentCommandId: 'run', capabilities: { stop: true } };
  let sourceKey: string | undefined;
  let launches = 0;
  let stops = 0;
  let stopKey: string | undefined;
  let approvalKey: string | undefined;
  let approvalWrites = 0;
  let approvalConsumed = false;
  let questionReads = 0;
  let beforeInputFailed = false;
  const stopReceipt = { state: 'SUCCEEDED', result: { taskId: task.taskId, state: 'CANCELLED' } };
  const transport: LocalTransportLike = {
    workerLocal: () => row, workerLocalRows: () => [row], identity: async () => 'store',
    rawBytes: async () => { throw Error('not used'); },
    raw: async (_connection, method, tail, body, key) => {
      switch (`${method} ${tail}`) {
        case 'POST /task-preflights': return { status: 200, data: { optionsRevision: 'options' } };
        case 'POST /tasks':
          launches++;
          sourceKey = key;
          throw new LocalTransportError('LOCAL_SOURCE_UNAVAILABLE', 503);
        case `GET /task-requests/${sourceKey}`: return { status: 200, data: task };
        case 'GET /tasks/native-task':
          if (questionReads === 3 && !beforeInputFailed) {
            beforeInputFailed = true;
            throw new LocalTransportError('LOCAL_SOURCE_UNAVAILABLE', 503);
          }
          return { status: 200, data: task };
        case 'GET /tasks/native-task/input-requests':
          questionReads++;
          return { status: 200, data: { items: [{ inputRequestId: 'question',
            method: 'confirm', title: '授权验收操作', message: '批准本轮操作',
            state: approvalConsumed ? 'ANSWERED' : 'PENDING',
            generation: 'generation', nativeSessionId: 'session',
            nativeTurnId: 'turn', targetCommandId: 'run',
          }] } };
        case 'POST /tasks/native-task/input-requests/question/responses':
          expect(body).toEqual({ requestKey: key, response: { confirmed: true },
            generation: 'generation', nativeSessionId: 'session', nativeTurnId: 'turn', targetCommandId: 'run' });
          approvalWrites++;
          approvalKey = key;
          throw new LocalTransportError('LOCAL_SOURCE_UNAVAILABLE', 503);
        case `GET /tasks/native-task/interaction-requests/${approvalKey}`:
          return { status: 200, data: { taskId: task.taskId, kind: 'INPUT_RESPONSE',
            state: approvalConsumed ? 'CONSUMED' : 'DISPATCHING' } };
        case 'POST /tasks/native-task/commands':
          expect(body).toEqual({ requestKey: key, intent: 'STOP', generation: 'generation',
            nativeSessionId: 'session', nativeTurnId: 'turn', targetCommandId: 'run' });
          stops++;
          stopKey = key;
          task.state = 'CANCELLED';
          return { status: 200, data: stopReceipt };
        case `GET /tasks/native-task/interaction-requests/${stopKey}`: return { status: 200, data: stopReceipt };
        default: return { status: 404, data: { code: 'NOT_FOUND' } };
      }
    },
  };
  let receiptPosts = 0;
  let accepted = false;
  const publications: unknown[] = [];
  const events: Record<string, unknown>[] = [];
  const results: unknown[] = [];
  let actionAccepted = false;
  let staleRejected = false;
  let approvalAccepted = false;
  let staleApprovalRejected = false;
  let withdrawDuringAuthorize = false;
  let withdrawalReported = false;
  const expiresAt = new Date(Date.now() + 25_000).toISOString();
  const hosted: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : String(input));
    expect(url.origin).toBe(origin);
    const path = url.pathname.replace('/api/daily/v1/member/link/v2', '');
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    switch (`${init?.method} ${path}`) {
      case 'GET /instances/instance/targets': return Response.json({ revision: publications.length });
      case 'PUT /instances/instance/targets': publications.push(body.targets); return Response.json({});
      case 'GET /task-claims': {
        if (withdrawDuringAuthorize) return Response.json({ commands: [withdrawn] });
        if (!accepted) return Response.json({ commands: [command] });
        const execution = events[0];
        if (!execution || actionAccepted) return Response.json({ commands: [] });
        if (!approvalAccepted) {
          const [question] = execution.pendingInputs as Record<string, unknown>[];
          expect(question).toMatchObject({ questionId: 'question', kind: 'CONFIRM', round: 1 });
          const approval = (commandId: string, fingerprint: unknown) => ({
            commandId, workId: 'work', kind: 'link.task.action.v2', deliveryGeneration: 1, claimUntil: expiresAt,
            payload: { operationId: commandId, kind: 'approval_response', workId: 'work', expiresAt,
              payload: { activeRunId: execution.activeRunId, executionEpoch: execution.executionEpoch,
                questionId: question.questionId, round: question.round, fingerprint, decision: 'approve' } },
          });
          return Response.json({ commands: [approval('stale-approval', 'retired'), approval('approve', question.fingerprint)] });
        }
        const stop = (commandId: string, activeRunId: unknown) => ({
          commandId, workId: 'work', kind: 'link.task.action.v2', deliveryGeneration: 1, claimUntil: expiresAt,
          payload: { operationId: commandId, kind: 'stop', workId: 'work', expiresAt,
            payload: { activeRunId, executionEpoch: execution.executionEpoch } },
        });
        return Response.json({ commands: [stop('stale-stop', 'retired-run'), stop('stop', execution.activeRunId)] });
      }
      case 'POST /task-claims/delivery/authorize': return Response.json({
        action: 'dispatch', requestKey: 'original-key', payloadDigest: 'digest',
        dispatchBefore: new Date(Date.now() + 25_000).toISOString(),
      });
      case 'POST /task-claims/withdrawn/authorize':
        writeFileSync(grant, JSON.stringify({ ...savedGrant, revision: 2, launchScopes: [],
          controls: false, approvals: false }));
        return Response.json({ action: 'dispatch', requestKey: 'withdrawn-key', payloadDigest: 'withdrawn-digest',
          dispatchBefore: new Date(Date.now() + 25_000).toISOString() });
      case 'GET /tasks/withdrawn-work/agent': return Response.json({
        nativeRequestKey: 'withdrawn-key', payloadDigest: 'withdrawn-digest',
        dispatch: { commandId: 'withdrawn', deliveryGeneration: 1 },
      });
      case 'POST /task-claims/withdrawn/receipt':
        expect(body).toEqual({ deliveryGeneration: 1, outcome: 'not_accepted' });
        withdrawalReported = true;
        return Response.json({});
      case 'GET /tasks/work/agent': return Response.json({ nativeRequestKey: 'original-key', payloadDigest: 'digest', execution: events.at(-1),
        dispatch: { commandId: 'delivery', deliveryGeneration: 1 } });
      case 'POST /task-claims/delivery/receipt':
        expect(body).toEqual({ deliveryGeneration: 1, outcome: 'accepted', nativeTaskId: 'native-task' });
        accepted = true;
        if (++receiptPosts === 1) throw Error('lost receipt response after acceptance');
        return Response.json({});
      case 'POST /task-claims/stale-stop/receipt':
        expect(body).toEqual({ deliveryGeneration: 1, outcome: 'conflict', detail: 'stale_execution' });
        staleRejected = true;
        return Response.json({});
      case 'POST /task-claims/stale-approval/receipt':
        expect(body).toEqual({ deliveryGeneration: 1, outcome: 'conflict', detail: 'stale_approval' });
        staleApprovalRejected = true;
        return Response.json({});
      case 'POST /task-claims/approve/receipt':
        expect(body).toEqual({ deliveryGeneration: 1, outcome: 'executed' });
        approvalAccepted = true;
        return Response.json({});
      case 'POST /task-claims/stop/receipt':
        expect(body).toEqual({ deliveryGeneration: 1, outcome: 'executed' });
        actionAccepted = true;
        return Response.json({});
      case 'POST /tasks/work/observations': events.push(body); return Response.json({});
      case 'PUT /tasks/work/results/primary': results.push(body); return Response.json({});
      default: throw Error(`Unexpected Hosted call ${path}`);
    }
  };

  let store = new GatewayStore(dir);
  const update = new UpdatePreparation('test-boot', { ...transport, workerLocalRows: () => [] }, () => false);
  const build = () => {
    const catalog = new LocalTaskAccess({} as LocalAuthLike, transport, store);
    vi.spyOn(catalog, 'ownerCatalog').mockResolvedValue({ backendStoreId: 'store',
      projects: [{ projectId: 'project' }, { projectId: 'another-project' }], engines: [{ engineId: 'pi' }] });
    return new WindowsCloudLaunch(store, catalog, transport, 'host', origin, session, grant, hosted, false, update);
  };
  try {
    expect((await update.prepare('test-update')).state).toBe('held');
    await build().tick();
    expect(publications).toHaveLength(0);
    expect(launches).toBe(0);
    await update.release('test-update');
    await build().tick();
    expect(publications).toEqual([[target]]);
    expect(launches).toBe(1);
    expect(sourceKey).toMatch(/^mobile-[a-f0-9]{64}$/);
    expect(receiptPosts).toBe(1);
    store.close();
    store = new GatewayStore(dir);
    await build().tick();
    expect(launches).toBe(1);
    expect(receiptPosts).toBe(2);
    expect(staleApprovalRejected).toBe(true);
    expect(beforeInputFailed).toBe(true);
    expect(approvalAccepted).toBe(false);
    expect(approvalWrites).toBe(0);
    store.close();
    store = new GatewayStore(dir);
    await build().tick();
    expect(approvalWrites).toBe(1);
    approvalConsumed = true;
    store.close();
    store = new GatewayStore(dir);
    await build().tick();
    expect(approvalAccepted).toBe(true);
    expect(approvalWrites).toBe(1);
    expect(staleRejected).toBe(true);
    expect(actionAccepted).toBe(true);
    expect(stops).toBe(1);
    await build().tick();
    expect(events).toEqual([
      expect.objectContaining({ state: 'waiting_approval', nativeTaskId: 'native-task',
        supportedActions: ['stop', 'approval_response'] }),
      expect.objectContaining({ state: 'running', nativeTaskId: 'native-task',
        supportedActions: ['stop'], pendingInputs: [] }),
      expect.objectContaining({ state: 'cancelled', nativeTaskId: 'native-task' }),
    ]);
    expect(results).toEqual([expect.objectContaining({ refs: [{ ref: 'native://store/tasks/native-task', mediaType: 'application/json' }] })]);
    withdrawDuringAuthorize = true;
    await build().tick();
    expect(withdrawalReported).toBe(true);
    expect(launches).toBe(1);
    await build().tick();
    expect(publications).toEqual([[target], []]);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

it('ignores malformed session files and clears targets when the session rotates', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'windows-cloud-test-'));
  const session = join(dir, 'connector.env');
  const grant = join(dir, 'grant.json');
  const origin = 'https://hosted.test';
  const base = (extra: string[]) => writeFileSync(session, [
    `PAC_RELAY_MEMBER_ORIGIN=${origin}`, 'PAC_RELAY_CLIENT_ID=agent-link',
    'PAC_RELAY_AGENT_ACCESS_TOKEN=fixture', 'PAC_RELAY_MEMBER_ID=member',
    'PAC_RELAY_WORKSPACE_ID=workspace', 'PAC_RELAY_AGENT_INSTANCE_ID=instance',
    ...extra,
  ].join('\n'));
  writeFileSync(grant, JSON.stringify({ schemaVersion: 'windows-cloud-launch-grant/1', revision: 1,
    memberId: 'member', workspaceId: 'workspace', instanceId: 'instance',
    launchScopes: [{ backendStoreId: 'store', projectId: 'project', engineId: 'pi' }] }));
  let calls = 0;
  const hosted: typeof fetch = async () => { calls++; return Response.json({ commands: [] }); };
  const transport: LocalTransportLike = {
    workerLocal: () => { throw Error('not used'); }, workerLocalRows: () => [],
    identity: async () => 'store', rawBytes: async () => { throw Error('not used'); },
    raw: async () => { throw Error('not used'); },
  };
  const store = new GatewayStore(dir);
  const catalog = new LocalTaskAccess({} as LocalAuthLike, transport, store);
  vi.spyOn(catalog, 'ownerCatalog').mockResolvedValue({ backendStoreId: 'store', projects: [], engines: [] });
  const build = (recoveryOnly = false) =>
    new WindowsCloudLaunch(store, catalog, transport, 'host', origin, session, grant, hosted, recoveryOnly);
  try {
    // Wrong origin: a connector file for another hosted realm must idle.
    writeFileSync(session, `PAC_RELAY_MEMBER_ORIGIN=https://other.test\nPAC_RELAY_CLIENT_ID=agent-link\n` +
      'PAC_RELAY_AGENT_ACCESS_TOKEN=fixture\nPAC_RELAY_MEMBER_ID=member\n' +
      'PAC_RELAY_WORKSPACE_ID=workspace\nPAC_RELAY_AGENT_INSTANCE_ID=instance\n');
    await build().tick();
    // Wrong client: a non agent-link session (e.g. a phone session file) must idle.
    writeFileSync(session, `PAC_RELAY_MEMBER_ORIGIN=${origin}\nPAC_RELAY_CLIENT_ID=phone\n` +
      'PAC_RELAY_AGENT_ACCESS_TOKEN=fixture\nPAC_RELAY_MEMBER_ID=member\n' +
      'PAC_RELAY_WORKSPACE_ID=workspace\nPAC_RELAY_AGENT_INSTANCE_ID=instance\n');
    await build().tick();
    expect(calls).toBe(0);
    // A Mac-written file omits the refresh token — the consumer never reads it.
    base([]);
    await build(true).tick();
    expect(calls).toBe(0);
    await build().tick();
    expect(calls).toBeGreaterThan(0);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
