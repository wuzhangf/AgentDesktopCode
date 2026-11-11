import { describe, expect, it, vi } from 'vitest';
import { writableCollaborationDefinition, createWritableCollaborationHandler } from '../../electron/main/ipc/writable-collaboration';
import { IpcRegistry } from '../../electron/main/ipc/registry';
import { ServiceClient } from '../../packages/service-client/src/index';
import { validWritableOperation, mergeWritableProjection, type WritableOperation, type WritableRecord } from '../../packages/protocol/src/writable-collaboration';
const adoption = (): WritableOperation => ({ action: 'ADOPT', runId: 'run-one', groupId: 'group-one', key: 'adopt-one', body: { schemaVersion: 'collaboration-adoption/1', adoptionId: 'adopt-one', expectedRunStateVersion: '7', expectedExecutionEpoch: '3', selectionId: 'selection-one', selectionFingerprint: 'selection-hash', previewId: 'preview-one', previewFingerprint: 'preview-hash', mode: 'STRICT' } });
describe('writable collaboration authority boundary', () => {
  it('rejects forged transport and authority before contacting the service', async () => {
    const registry = new IpcRegistry(); registry.register(writableCollaborationDefinition); const execute = vi.fn(async () => ({})); const handle = createWritableCollaborationHandler(registry, execute); const original = adoption();
    for (const payload of [{ ...original, url: 'http://outside.invalid' }, { ...original, actor: 'admin' }, { ...original, groupId: '../other' }, { ...original, body: { ...('body' in original ? original.body : {}), lease: 'forged' } }]) expect(await handle('app://codeagent/index.html', payload)).toHaveProperty('code', 'IPC_REJECTED');
    expect(await handle('https://untrusted.invalid', original)).toHaveProperty('code', 'IPC_REJECTED'); expect(execute).not.toHaveBeenCalled();
  });
  it('preserves decimal versions and the exact original adoption on retry', async () => {
    const fetchImpl = vi.fn(async () => new Response('{"schemaVersion":"writable-collaboration-record/1","kind":"ADOPTION","entityId":"adopt-one","groupId":"group-one","revision":"1","state":"WAITING_BOUNDARY"}', { status: 202 })); const client = new ServiceClient({ baseUrl: 'http://127.0.0.1:1', token: crypto.randomUUID(), fetchImpl: fetchImpl as typeof fetch }); const registry = new IpcRegistry(); registry.register(writableCollaborationDefinition); const handler = createWritableCollaborationHandler(registry, operation => client.writableCollaboration(operation)); const operation = adoption(); await handler('app://codeagent/index.html', operation); await handler('app://codeagent/index.html', operation);
    const requests = fetchImpl.mock.calls as unknown as Array<[URL | RequestInfo, RequestInit]>; expect(requests).toHaveLength(2); expect(String(requests[0]![0])).toBe('http://127.0.0.1:1/api/v2/runs/run-one/collaboration-groups/group-one/adoptions'); expect(requests[0]![1].headers).toHaveProperty('idempotency-key', 'adopt-one'); expect(requests[0]![1].body).toBe(requests[1]![1].body); expect(JSON.parse(String(requests[0]![1].body)).expectedRunStateVersion).toBe('7');
  });
  it('rejects numeric or overflowing versions, traversal scopes, URL roots and oversized graphs', () => {
    const original = adoption(); if (!('body' in original)) throw new Error(); for (const version of [7, '9223372036854775808', '01']) expect(validWritableOperation({ ...original, body: { ...original.body, expectedRunStateVersion: version } })).toBe(false);
    const create = { action: 'CREATE', runId: 'run-one', key: 'group-one', body: { requestId: 'group-one', expectedExecutionEpoch: '1', graph: { units: [{ unitId: 'one', kind: 'WRITE_CANDIDATE', objective: 'edit scoped file', readScope: ['.'], writeScope: ['src/x.txt'] }] } } }; expect(validWritableOperation(create)).toBe(true);
    for (const path of ['../outside', '/absolute', 'D:/outside', 'src/../x', 'src\\x', 'src/x.']) expect(validWritableOperation({ ...create, body: { ...create.body, graph: { units: [{ ...create.body.graph.units[0], writeScope: [path] }] } } })).toBe(false);
    expect(validWritableOperation({ ...create, body: { ...create.body, graph: { units: Array(9).fill(create.body.graph.units[0]) } } })).toBe(false);
  });
  it('routes immutable preview bytes through a fixed bounded read', async () => {
    const fetchImpl = vi.fn(async () => new Response('{"content":"djI="}', { status: 200 })); const client = new ServiceClient({ baseUrl: 'http://127.0.0.1:1', token: crypto.randomUUID(), fetchImpl: fetchImpl as typeof fetch }); const operation: WritableOperation = { action: 'PREVIEW_FILES', runId: 'run', groupId: 'group', entityId: 'preview', side: 'CURRENT', path: 'src/a b.txt', offset: '0', limit: '64' }; await client.writableCollaboration(operation); const call = fetchImpl.mock.calls as unknown as Array<[URL | RequestInfo]>; expect(String(call[0]![0])).toBe('http://127.0.0.1:1/api/v2/runs/run/collaboration-groups/group/previews/preview/files?path=src%2Fa+b.txt&offset=0&limit=64&side=CURRENT'); expect(validWritableOperation({ ...operation, side: 'BASE' })).toBe(false); expect(validWritableOperation({ ...operation, limit: '65537' })).toBe(false);
  });
  it('merges child and group revisions independently so an older H0 cannot replace newer facts', () => {
    const child = (revision: string, state: string): WritableRecord => ({ schemaVersion: 'writable-collaboration-record/1', kind: 'CHILD', entityId: 'child', groupId: 'group', revision, state }); const previous: WritableRecord = { schemaVersion: 'writable-collaboration-record/1', kind: 'GROUP', entityId: 'group', groupId: 'index', revision: '8', state: 'READY', children: [child('6', 'CANDIDATE_READY')] }; const stale: WritableRecord = { ...previous, revision: '7', state: 'RUNNING', children: [child('5', 'RUNNING')] }; expect(mergeWritableProjection(previous, stale)).toMatchObject({ revision: '8', state: 'READY', children: [{ revision: '6', state: 'CANDIDATE_READY' }] }); const independentlyNewer = { ...stale, children: [child('7', 'CANCELLED')] }; expect(mergeWritableProjection(previous, independentlyNewer).children?.[0]?.state).toBe('CANCELLED');
  });
  it('requires a bounded explicit repair intent and preserves its original failed adoption route', async () => {
    const operation: WritableOperation = { action: 'REPAIR', runId: 'run', groupId: 'group', entityId: 'failed', key: 'repair', body: { schemaVersion: 'collaboration-repair-request/1', repairId: 'repair', expectedAdoptionRevision: '8', expectedRunStateVersion: '11', expectedExecutionEpoch: '2', objective: 'Repair within the original frozen scope and reserve' } };
    expect(validWritableOperation(operation)).toBe(true);
    expect(validWritableOperation({ ...operation, key: 'different-repair' })).toBe(false);
    expect(validWritableOperation({ ...operation, body: { ...operation.body, expectedAdoptionRevision: '9223372036854775808' } })).toBe(false);
    expect(validWritableOperation({ ...operation, body: { ...operation.body, budget: { logicalCalls: '1000' } } })).toBe(false);
    expect(validWritableOperation({ ...operation, body: { ...operation.body, sourceRoot: 'D:/outside' } })).toBe(false);
    expect(validWritableOperation({ ...operation, body: { ...operation.body, expectedAdoptionRevision: 8 } })).toBe(false);
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 202 })); const client = new ServiceClient({ baseUrl: 'http://127.0.0.1:1', token: crypto.randomUUID(), fetchImpl: fetchImpl as typeof fetch });
    await client.writableCollaboration(operation); const call = fetchImpl.mock.calls as unknown as Array<[URL | RequestInfo, RequestInit]>; expect(String(call[0]![0])).toBe('http://127.0.0.1:1/api/v2/runs/run/collaboration-groups/group/adoptions/failed/repairs'); expect(JSON.parse(String(call[0]![1].body))).toEqual(operation.body);
  });

  it('merges each budget dimension independently even while the group revision stays unchanged', () => {
    const account = (revision: string, spent: string) => ({ revision, limit: '20', spent, reserved: '2', deadline: '9999999999999' });
    const previous: WritableRecord = { schemaVersion: 'writable-collaboration-record/1', kind: 'GROUP', entityId: 'group', groupId: 'index', revision: '8', state: 'READY', sharedBudget: { LOGICAL_CALL: account('6', '3'), HTTP_REQUEST: account('8', '5') } };
    const next = { ...previous, sharedBudget: { LOGICAL_CALL: account('7', '4'), HTTP_REQUEST: account('7', '4') } };
    expect(mergeWritableProjection(previous, next).sharedBudget).toMatchObject({ LOGICAL_CALL: { revision: '7', spent: '4' }, HTTP_REQUEST: { revision: '8', spent: '5' } });
  });
  it('routes explicit original repair recovery without accepting a new budget or dispatch identity', async () => {
    const operation: WritableOperation = { action: 'RECOVER_REPAIR', runId: 'run', groupId: 'group', entityId: 'repair-original', key: 'recover-original', body: { schemaVersion: 'collaboration-action/1', requestId: 'recover-original', expectedRevision: '9' } };
    expect(validWritableOperation(operation)).toBe(true); expect(validWritableOperation({ ...operation, body: { ...operation.body, dispatchId: 'new-dispatch' } })).toBe(false);
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 202 })); const client = new ServiceClient({ baseUrl: 'http://127.0.0.1:1', token: crypto.randomUUID(), fetchImpl: fetchImpl as typeof fetch });
    await client.writableCollaboration(operation); const call = fetchImpl.mock.calls as unknown as Array<[URL | RequestInfo, RequestInit]>;
    expect(String(call[0]![0])).toBe('http://127.0.0.1:1/api/v2/runs/run/collaboration-groups/group/repairs/repair-original/recover');
  });

  it('merges a child attempt budget without requiring its execution record to advance', () => {
    const child = (revision: string, spent: string): WritableRecord => ({ schemaVersion: 'writable-collaboration-record/1', kind: 'CHILD', entityId: 'child', groupId: 'group', revision: '3', state: 'RUNNING', childBudget: { LOGICAL_CALL: { revision, attemptSpent: spent, attemptLimit: '6', unitSpent: spent, unitLimit: '12' } } });
    const base: WritableRecord = { schemaVersion: 'writable-collaboration-record/1', kind: 'GROUP', entityId: 'group', groupId: 'index', revision: '4', state: 'RUNNING', children: [child('6', '2')] };
    const newer = mergeWritableProjection(base, { ...base, children: [child('7', '3')] });
    expect(newer.children?.[0]?.childBudget).toMatchObject({ LOGICAL_CALL: { revision: '7', attemptSpent: '3' } });
    expect(mergeWritableProjection(newer, base).children?.[0]?.childBudget).toMatchObject({ LOGICAL_CALL: { revision: '7', attemptSpent: '3' } });
  });
});
