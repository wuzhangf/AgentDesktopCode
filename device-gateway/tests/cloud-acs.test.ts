import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createAcsClient } from '../src/acs';
import { bindingFor } from '../src/bindings';
import { CloudAcs } from '../src/cloud-acs';
import type { GatewayContext } from '../src/context';
import { GatewayStore } from '../src/store';
import type { LocalTransportLike } from '../src/local-tasks';
import { WindowsCloudLaunch } from '../src/windows-cloud-launch';

const realOrigin = process.env.WA_TEST_ACS_ORIGIN;
const realToken = process.env.WA_TEST_ACS_TOKEN;

it.each(['session', 'message'] as const)('reconciles an ACS %s response after withdrawing the local grant', async stopAfter => {
  const dir = mkdtempSync(join(tmpdir(), 'windows-acs-cloud-test-'));
  const origin = 'https://hosted.test';
  const session = join(dir, 'connector.env');
  const grant = join(dir, 'grant.json');
  writeFileSync(session, [
    `PAC_RELAY_MEMBER_ORIGIN=${origin}`, 'PAC_RELAY_CLIENT_ID=agent-link',
    'PAC_RELAY_AGENT_ACCESS_TOKEN=fixture', 'PAC_RELAY_MEMBER_ID=member',
    'PAC_RELAY_WORKSPACE_ID=workspace', 'PAC_RELAY_AGENT_INSTANCE_ID=instance',
  ].join('\n'));
  const project = realOrigin ? 'control' : 'project';
  const instruction = realOrigin ? 'Reply with WA001-ACS-CLOUD-OK. Do not change files.' : 'execute the original instruction';
  let createKey: string | undefined;
  let messageKey: string | undefined;
  let creates = 0;
  let messages = 0;
  let sessionId = 'sid';
  let revoked = false;
  let delayMessageReceipt = true;
  const callsAfterRevocation: string[] = [];
  const realAcs = realOrigin && realToken ? createAcsClient({ origin: realOrigin, ownerToken: realToken }) : undefined;
  const bindingContext = { acs: realAcs } as GatewayContext;
  const acs = new CloudAcs('acs-store', {
    call: async (device, method, path, body, key, before) => {
      if (revoked) callsAfterRevocation.push(`${method} ${path}`);
      if (path === '/api/v2/operations/lookup' && delayMessageReceipt) {
        await before?.();
        expect(key).toBe(messageKey);
        return { status: 404, body: {} };
      }
      if (realAcs) {
        const binding = await bindingFor(bindingContext, device);
        await before?.();
        const response = await realAcs.call(method, path,
          body == null ? undefined : Buffer.from(JSON.stringify(body)), key, binding);
        const observed = JSON.parse(Buffer.from(response.body).toString('utf8'));
        if (method === 'POST' && path === '/api/v2/sessions') {
          expect(response.status).toBeLessThan(300);
          sessionId = observed.sessionId;
          createKey = key;
          creates++;
          throw Error('lost real ACS create reply');
        }
        if (method === 'POST' && path === `/api/v2/sessions/${sessionId}/messages`) {
          expect(response.status).toBeLessThan(300);
          messageKey = key;
          messages++;
          throw Error('lost real ACS message reply');
        }
        if (path.endsWith('/lookup-created-session')) expect(key).toBe(createKey);
        if (path === '/api/v2/operations/lookup') expect(key).toBe(messageKey);
        return { status: response.status, body: observed };
      }
      await before?.();
      switch (`${method} ${path}`) {
        case 'GET /api/v2/projects':
          return { status: 200, body: [{ projectId: project, workspaceAlias: project,
            authorityStatus: 'AVAILABLE' }] };
        case 'GET /api/v2/projects/project/session-preflight':
          return { status: 200, body: { projectId: 'project', workspaceAlias: 'project',
            authorityStatus: 'AVAILABLE', modelAvailability: 'AVAILABLE', allowedIntents: ['CODE'],
            revision: 'rev', workspaceFingerprint: 'tree', policyFingerprint: 'policy' } };
        case 'POST /api/v2/sessions':
          expect(body).toMatchObject({ workspaceAlias: 'project', intent: 'IMPLEMENT' });
          createKey = key;
          creates++;
          throw Error('lost ACS create reply');
        case 'POST /api/v2/operations/lookup-created-session':
          expect(key).toBe(createKey);
          return { status: 200, body: { operation: 'session.create', resourceId: 'sid' } };
        case 'GET /api/v2/sessions/sid/summary':
          return { status: 200, body: { sessionId: 'sid', sessionVersion: 1, activeRunId: 'run' } };
        case 'POST /api/v2/sessions/sid/messages':
          expect(body).toEqual({ clientMessageId: key, content: 'execute the original instruction', expectedSessionVersion: 1 });
          messageKey = key;
          messages++;
          throw Error('lost ACS message reply');
        case 'POST /api/v2/operations/lookup':
          expect(key).toBe(messageKey);
          expect(body).toMatchObject({ operation: 'session.message', resourceId: 'sid' });
          return { status: 200, body: { operation: 'session.message', resourceId: 'sid', result: { runId: 'run' } } };
        case 'GET /api/v2/runs/run':
          return { status: 200, body: { sessionId: 'sid', state: 'COMPLETED' } };
        default: throw Error('Unexpected ACS call');
      }
    },
  });
  let target: Record<string, unknown> = {};
  let receipt: Record<string, unknown> | undefined;
  let result: Record<string, unknown> | undefined;
  const events: Record<string, unknown>[] = [];
  const hosted: typeof fetch = async (input, init) => {
    const path = new URL(String(input)).pathname.split('/link/v2')[1];
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    switch (`${init?.method} ${path}`) {
      case 'GET /instances/instance/targets': return Response.json({ revision: 0 });
      case 'PUT /instances/instance/targets':
        if (revoked) expect(body.targets).toEqual([]);
        else {
          [target] = body.targets;
          expect(target).toMatchObject({ sourceKind: 'ACS', backendId: 'acs-store', projectId: project });
        }
        return Response.json({});
      case 'GET /task-claims':
        return Response.json({ commands: receipt ? [] : [{ commandId: 'delivery', workId: 'work',
          kind: 'link.task.launch.v2', deliveryGeneration: 1, payload: {
            target: { ...target, instanceId: 'instance' }, payloadDigest: 'digest',
            nativeRequestKey: 'original', attachments: [], parameters: {},
            instruction: { text: instruction },
          } }] });
      case 'POST /task-claims/delivery/authorize':
        return Response.json({ action: 'dispatch', requestKey: 'original', payloadDigest: 'digest',
          dispatchBefore: new Date(Date.now() + 35_000).toISOString() });
      case 'GET /tasks/work/agent':
        return Response.json({ nativeRequestKey: 'original', payloadDigest: 'digest',
          dispatch: { commandId: 'delivery', deliveryGeneration: 1 } });
      case 'POST /task-claims/delivery/receipt': receipt = body; return Response.json({});
      case 'POST /tasks/work/observations': events.push(body); return Response.json({});
      case 'PUT /tasks/work/results/primary': result = body; return Response.json({});
      default: throw Error('Unexpected Hosted call');
    }
  };
  let store = new GatewayStore(dir);
  const build = () => new WindowsCloudLaunch(store, undefined, {} as LocalTransportLike,
    'host', origin, session, grant, hosted, false, undefined, 'file', undefined, acs);
  try {
    const directory = await build().ownerGrant();
    expect(directory.targets).toContainEqual(expect.objectContaining({
      sourceKind: 'ACS', backendId: 'acs-store', projectId: project, engineId: 'acs',
    }));
    const grantRequest = { expectedRevision: directory.revision, expectedScope: directory.scope,
      launchScopes: [{ backendStoreId: 'acs-store', projectId: project, engineId: 'acs' }],
      controls: false, approvals: false };
    await expect(build().ownerGrant({ ...grantRequest, expectedScope: 'other-member' }))
      .rejects.toMatchObject({ code: 'CLOUD_SESSION_CHANGED' });
    await expect(build().ownerGrant(grantRequest)).resolves.toMatchObject({ revision: 1 });
    const restart = () => {
      store.close();
      store = new GatewayStore(dir);
      return build();
    };
    await build().tick();
    if (stopAfter === 'message') {
      await restart().tick();
      await build().tick();
      expect(messages).toBe(1);
      expect(receipt).toBeUndefined();
    }
    await expect(build().ownerGrant({ ...grantRequest, expectedRevision: 1, launchScopes: [] }))
      .resolves.toMatchObject({ revision: 2, launchScopes: [] });
    revoked = true;
    delayMessageReceipt = false;
    await restart().tick();
    if (realAcs && stopAfter === 'message') {
      for (let attempt = 0; attempt < 40 && !result; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 1000));
        await build().tick();
      }
    }
    expect(creates).toBe(1);
    if (stopAfter === 'session') {
      expect(messages).toBe(0);
      expect(receipt).toMatchObject({ outcome: 'not_accepted' });
      expect(callsAfterRevocation).toEqual(['POST /api/v2/operations/lookup-created-session']);
      expect(events).toEqual([]);
      return;
    }
    expect(messages).toBe(1);
    expect(callsAfterRevocation[0]).toBe('POST /api/v2/operations/lookup');
    expect(callsAfterRevocation.slice(1)).toEqual(
      callsAfterRevocation.slice(1).filter(call => call.startsWith('GET /api/v2/runs/')),
    );
    expect(receipt).toMatchObject({ outcome: 'accepted', sessionId, nativeTaskId: sessionId });
    expect(events.at(-1)).toMatchObject({ sessionId, activeRunId: expect.any(String), state: 'succeeded' });
    expect(result).toMatchObject({ refs: [{ ref: `acs://acs-store/sessions/${sessionId}` }] });
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}, realOrigin ? 90_000 : 5000);
