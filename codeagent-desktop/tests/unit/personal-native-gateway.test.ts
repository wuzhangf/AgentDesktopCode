import {createServer} from 'node:http';
import {once} from 'node:events';
import type {AddressInfo} from 'node:net';
import {describe, expect, it} from 'vitest';
import {personalGatewayClient} from '../../electron/main/service/personalGateway';
import {validPersonalOperation} from '../../packages/protocol/src/personal';

describe('Electron production personal gateway transport', () => {
  it('keeps the owner cookie/tab in main and sends the exact original mutation key over real HTTP', async () => {
    const seen: {url: string; headers: import('node:http').IncomingHttpHeaders; body: unknown}[] = [];
    const server = createServer(async (request, response) => {
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      seen.push({url: request.url!, headers: request.headers, body: chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined});
      response.writeHead(200, {'content-type': 'application/json', 'set-cookie': 'personal_control=local-owner-cookie; HttpOnly; SameSite=Strict; Path=/api/personal'});
      response.end(JSON.stringify({meta: {supportedActions: ['TASK_CREATE']}, data: {taskId: 'task-1'}}));
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const client = personalGatewayClient(origin);
      await client.personalOperation({action: 'PROJECTS_AVAILABLE'});
      const body = {requestKey: 'original-key', projectId: 'project-1', engineId: 'macos' as const, optionsRevision: 'a'.repeat(64), instruction: 'Run the registered workflow'};
      await client.personalOperation({action: 'TASK_CREATE', key: body.requestKey, body});
      expect(seen.map(value => value.url)).toEqual(['/api/personal/v1/projects/available', '/api/personal/v1/tasks']);
      expect(seen[0]!.headers.authorization).toBeUndefined();
      expect(seen[0]!.headers.cookie).toBeUndefined();
      expect(seen[1]!.headers.cookie).toBe('personal_control=local-owner-cookie');
      expect(seen[0]!.headers['x-personal-tab']).toBe(seen[1]!.headers['x-personal-tab']);
      expect(seen[1]!.headers['x-personal-control']).toBe('1');
      expect(seen[1]!.headers.origin).toBe(origin);
      expect(seen[1]!.headers['idempotency-key']).toBe(body.requestKey);
      expect(seen[1]!.body).toEqual(body);
    } finally {server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));}
  });

  it.each(['https://127.0.0.1:1', 'http://example.com', 'http://127.0.0.1:1/api', 'http://user:password@127.0.0.1:1', 'http://127.0.0.1:1/?token=secret'])('rejects unsafe configured gateway %s', endpoint => {
    expect(() => personalGatewayClient(endpoint)).toThrow();
  });
});

describe('bounded Mac desktop consumer operations', () => {
  const stop = {requestKey: 'stop-1', kind: 'STOP' as const, generation: 'generation-1', nativeSessionId: null, nativeTurnId: null, targetCommandId: 'command-1'};
  it('admits only a guarded native STOP and content-addressed artifact read', () => {
    expect(validPersonalOperation({action: 'TASK_COMMAND_CREATE', taskId: 'task-1', key: stop.requestKey, body: stop})).toBe(true);
    expect(validPersonalOperation({action: 'TASK_COMMAND_CREATE', taskId: 'task-1', key: stop.requestKey, body: {...stop, generation: undefined}})).toBe(false);
    expect(validPersonalOperation({action: 'TASK_COMMAND_CREATE', taskId: 'task-1', key: 'new-key', body: stop})).toBe(false);
    expect(validPersonalOperation({action: 'TASK_COMMAND_CREATE', taskId: 'task-1', key: stop.requestKey, body: {...stop, kind: 'NATIVE_FOLLOW_UP', content: 'not exposed'}})).toBe(false);
    expect(validPersonalOperation({action: 'NATIVE_ARTIFACT', taskId: 'task-1', entityId: 'file-' + 'a'.repeat(64)})).toBe(true);
    expect(validPersonalOperation({action: 'NATIVE_ARTIFACT', taskId: 'task-1', entityId: 'arbitrary-file'})).toBe(false);
    expect(validPersonalOperation({action: 'NATIVE_ARTIFACTS', taskId: 'task-1', url: 'http://127.0.0.1/other'})).toBe(false);
  });
});
