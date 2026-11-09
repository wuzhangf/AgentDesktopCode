import { describe, expect, it, vi } from 'vitest';
import { collaborationDefinition, createCollaborationHandler } from '../../electron/main/ipc/collaboration';
import { ServiceClient } from '../../packages/service-client/src/index';
import { IpcRegistry } from '../../electron/main/ipc/registry';
import { validCollaborationOperation } from '../../packages/protocol/src/collaboration';
describe('fixed collaboration IPC', () => {
  it('rejects untrusted senders and arbitrary transport fields before contacting the service', async () => {
    const registry = new IpcRegistry(); registry.register(collaborationDefinition); const execute = vi.fn(async () => ({})); const handler = createCollaborationHandler(registry, execute);
    expect(await handler('https://untrusted.invalid/', { action: 'FOUNDATION', subjectId: 'session-one' })).toHaveProperty('code', 'IPC_REJECTED');
    expect(await handler('app://codeagent/index.html', { action: 'FOUNDATION', subjectId: 'session-one', url: 'https://outside.invalid/' })).toHaveProperty('code', 'IPC_REJECTED');
    expect(execute).not.toHaveBeenCalled();
  });
  it('admits typed use cases and preserves the original idempotency key', async () => {
    const registry = new IpcRegistry(); registry.register(collaborationDefinition); const execute = vi.fn(async () => ({ state: 'QUEUED' })); const handler = createCollaborationHandler(registry, execute);
    const request = { action: 'TURN', subjectId: 'aux-one', key: 'intent-one', body: { schemaVersion: 'auxiliary-turn/1', turnId: 'intent-one', expectedSessionVersion: '1', packageId: 'package-one', question: 'Evidence?' } };
    await handler('app://codeagent/index.html', request); await handler('app://codeagent/index.html', request); expect(execute).toHaveBeenNthCalledWith(1, request); expect(execute).toHaveBeenNthCalledWith(2, request);
  });
  it('bounds payloads and refuses path traversal, missing keys and unused body fields', () => {
    for (const request of [ { action: 'FOUNDATION', subjectId: '..' }, { action: 'TURN_RESULT', subjectId: 'aux' }, { action: 'TURN', subjectId: 'aux', body: {} }, { action: 'FOUNDATION', subjectId: 'sid', body: {} }, { action: 'PREFLIGHT', subjectId: 'rid', body: { text: 'x'.repeat(33000) } } ]) expect(validCollaborationOperation(request)).toBe(false);
  });
  it.each(['CANCEL_BOUNDARY', 'CANCEL_HANDOFF'] as const)('sends %s only to its fixed scoped cancellation endpoint', async (action) => {
    const fetchImpl = vi.fn(async (_url: URL | RequestInfo, _init?: RequestInit) => new Response('{"state":"CANCELLED"}', { status: 200 }));
    const client = new ServiceClient({ baseUrl: 'http://127.0.0.1:1', token: crypto.randomUUID(), fetchImpl: fetchImpl as typeof fetch });
    const registry = new IpcRegistry(); registry.register(collaborationDefinition); const handler = createCollaborationHandler(registry, (operation) => client.collaboration(operation));
    const operation = { action, subjectId: 'run-one', entityId: 'intent-one', key: 'cancel-one' };
    expect(validCollaborationOperation(operation)).toBe(true); expect(validCollaborationOperation({ ...operation, body: {} })).toBe(false); expect(validCollaborationOperation({ ...operation, key: undefined })).toBe(false);
    await handler('app://codeagent/index.html', operation);
    const [url, init] = fetchImpl.mock.calls[0]!; expect(String(url)).toBe(`http://127.0.0.1:1/api/v2/runs/run-one/${action === 'CANCEL_BOUNDARY' ? 'boundary-requests' : 'assignment-transitions'}/intent-one/cancel`);
    expect(init?.method).toBe('POST'); expect(init?.headers).toHaveProperty('idempotency-key', 'cancel-one');
  });

});
