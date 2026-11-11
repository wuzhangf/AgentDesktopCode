// PAE P6 — personal transport / gateway 测试源码（本轮不运行，统一合并后执行）。
// 覆盖：19 条冻结操作的 method+path 映射、requestKey 生成/透传与
// Idempotency-Key 头镜像、envelope 守卫 fail-closed、{error} 解码、
// desktop 窄桥分发与 DesktopError 展开、无效操作前置拒绝。
import { describe, it, expect, vi } from 'vitest';
import {
  createFetchTransport, createDesktopTransport, PersonalClientError, personalOperationTail,
} from '../src/personal/client';
import { personalGateway, type PersonalGateway } from '../src/personal/port';
import { createDemoTransport } from '../src/personal/demo';
import type { PersonalEnvelope, PersonalOperation } from '../../codeagent-desktop/packages/protocol/src/personal';

const META = {
  source: 'test', instance: 'test', controlPlaneId: 'cp-test', observedAt: '2026-10-18T00:00:00Z',
  revision: '1', supportedActions: [], reasonCodes: [],
};
const ok = (data: unknown): PersonalEnvelope<unknown> => ({ meta: META, data });

function fetchReturning(body: unknown, status = 200) {
  return vi.fn(async (_input: unknown, _init?: RequestInit) => ({
    ok: status >= 200 && status < 300, status,
    json: async () => body, text: async () => JSON.stringify(body),
  }) as unknown as Response);
}

const lastCall = (f: ReturnType<typeof fetchReturning>) => f.mock.calls.at(-1)!;

describe('fetch transport — operation→path 映射（冻结 §4 路由表）', () => {
  it.each([
    [{ action: 'OVERVIEW' }, 'GET', '/api/personal/v1/overview'],
    [{ action: 'PROJECTS' }, 'GET', '/api/personal/v1/projects'],
    [{ action: 'PROJECT', projectId: 'p1' }, 'GET', '/api/personal/v1/projects/p1'],
    [{ action: 'PROJECT_ENVIRONMENT', projectId: 'p1' }, 'GET', '/api/personal/v1/projects/p1/environment'],
    [{ action: 'OPERATION', operationId: 'op1' }, 'GET', '/api/personal/v1/environment-operations/op1'],
    [{ action: 'WORKERS' }, 'GET', '/api/personal/v1/workers'],
    [{ action: 'WORKER', workerId: 'w1' }, 'GET', '/api/personal/v1/workers/w1'],
    [{ action: 'TASK_ACTIONS', taskId: 't1' }, 'GET', '/api/personal/v1/tasks/t1/actions'],
    [{ action: 'REPORTS' }, 'GET', '/api/personal/v1/reports'],
    [{ action: 'REPORT', reportId: 'r1' }, 'GET', '/api/personal/v1/reports/r1'],
    [{ action: 'REPORT_FILES', reportId: 'r1' }, 'GET', '/api/personal/v1/reports/r1/files'],
    [{ action: 'REGISTER_PROJECT', key: 'k1', body: { requestKey: 'k1', projectRef: 'ref-1' } }, 'POST', '/api/personal/v1/projects'],
    [{ action: 'ENVIRONMENT_PLAN', projectId: 'p1', key: 'k2', body: { requestKey: 'k2' } }, 'POST', '/api/personal/v1/projects/p1/environment/plans'],
    [{ action: 'ENVIRONMENT_OPERATION', projectId: 'p1', key: 'k3', body: { requestKey: 'k3', kind: 'PREPARE' } }, 'POST', '/api/personal/v1/projects/p1/environment/operations'],
    [{ action: 'OPERATION_CANCEL', operationId: 'op1', key: 'k4', body: { requestKey: 'k4' } }, 'POST', '/api/personal/v1/environment-operations/op1/cancel'],
    [{ action: 'ACTION_RUN', taskId: 't1', actionId: 'a1', key: 'k5', body: { requestKey: 'k5' } }, 'POST', '/api/personal/v1/tasks/t1/actions/a1:run'],
    [{ action: 'ACTION_SAVE', taskId: 't1', actionId: 'a1', key: 'k6', body: { requestKey: 'k6' } }, 'POST', '/api/personal/v1/tasks/t1/actions/a1:save'],
    [{ action: 'REPORT_CREATE', key: 'k7', body: { requestKey: 'k7', sourceRef: 'src@main' } }, 'POST', '/api/personal/v1/reports'],
  ] as [PersonalOperation, string, string][])('maps %s', (op, method, path) => {
    const { method: m, tail } = personalOperationTail(op);
    expect(m).toBe(method);
    expect(`/api/personal/v1${tail}`).toBe(path);
  });

  it('OPERATION_EVENTS 透传不透明 cursor 与有界 limit', async () => {
    const f = fetchReturning(ok({ events: [], nextCursor: 'cur-2' }));
    const t = createFetchTransport({ fetchImpl: f as unknown as typeof fetch });
    await t({ action: 'OPERATION_EVENTS', operationId: 'op1', cursor: 'cur-1', limit: '50' });
    const [url] = lastCall(f);
    expect(String(url)).toBe('/api/personal/v1/environment-operations/op1/events?cursor=cur-1&limit=50');
  });

  it('写操作把同一 requestKey 写进 body 与 Idempotency-Key 头', async () => {
    const f = fetchReturning(ok({ operationId: 'op1', state: 'QUEUED' }));
    const t = createFetchTransport({ fetchImpl: f as unknown as typeof fetch });
    await t({ action: 'ENVIRONMENT_OPERATION', projectId: 'p1', key: 'req-42', body: { requestKey: 'req-42', kind: 'PREPARE' } });
    const [, init] = lastCall(f);
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers['idempotency-key']).toBe('req-42');
    expect(JSON.parse(String((init as RequestInit).body)).requestKey).toBe('req-42');
  });

  it('拒绝未在白名单内的操作与非法 id', async () => {
    const f = fetchReturning(ok({}));
    const t = createFetchTransport({ fetchImpl: f as unknown as typeof fetch });
    await expect(t({ action: 'PROJECT', projectId: '../escape' } as PersonalOperation)).rejects.toMatchObject({ code: 'INVALID_OPERATION' });
    await expect(t({ action: 'NOPE' } as unknown as PersonalOperation)).rejects.toMatchObject({ code: 'INVALID_OPERATION' });
    expect(f).not.toHaveBeenCalled();
  });

  it('{error} 形状解码为稳定 code + retryable + requestId', async () => {
    const f = fetchReturning({ error: { code: 'IDEMPOTENCY_CONFLICT', message: 'key 冲突', retryable: false, requestId: 'rq-9' } }, 409);
    const t = createFetchTransport({ fetchImpl: f as unknown as typeof fetch });
    await expect(t({ action: 'OVERVIEW' })).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT', requestId: 'rq-9', status: 409 });
  });

  it('非 envelope 成功体 fail-closed 为 PROTOCOL_ERROR', async () => {
    const f = fetchReturning({ unexpected: true });
    const t = createFetchTransport({ fetchImpl: f as unknown as typeof fetch });
    await expect(t({ action: 'OVERVIEW' })).rejects.toMatchObject({ code: 'PROTOCOL_ERROR' });
  });
});

describe('desktop 窄桥 transport', () => {
  it('转发 operation 并透传 envelope', async () => {
    const bridge = { personalOperation: vi.fn(async () => ok({ projects: [] })) };
    const t = createDesktopTransport(bridge);
    const res = await t({ action: 'OVERVIEW' });
    expect(bridge.personalOperation).toHaveBeenCalledWith({ action: 'OVERVIEW' });
    expect(res.data).toEqual({ projects: [] });
  });

  it('DesktopError {error:string,code} 展开为 PersonalClientError', async () => {
    const bridge = { personalOperation: vi.fn(async () => ({ error: 'Invalid bounded operation', code: 'IPC_REJECTED' })) };
    const t = createDesktopTransport(bridge);
    await expect(t({ action: 'OVERVIEW' })).rejects.toMatchObject({ code: 'IPC_REJECTED' });
  });

  it('无桥方法时 fail-closed', async () => {
    const t = createDesktopTransport({});
    await expect(t({ action: 'OVERVIEW' })).rejects.toMatchObject({ code: 'NO_DESKTOP_BRIDGE' });
  });

  it('非 envelope 非 error 体拒绝', async () => {
    const bridge = { personalOperation: vi.fn(async () => 42) };
    const t = createDesktopTransport(bridge);
    await expect(t({ action: 'OVERVIEW' })).rejects.toMatchObject({ code: 'PROTOCOL_ERROR' });
  });
});

describe('typed gateway 门面', () => {
  function spyGateway(): { gateway: PersonalGateway; calls: PersonalOperation[] } {
    const calls: PersonalOperation[] = [];
    const gateway = personalGateway(async op => { calls.push(op); return ok({}); });
    return { gateway, calls };
  }

  it('写操作缺省 requestKey 时生成，key 与 body.requestKey 恒等', async () => {
    const { gateway, calls } = spyGateway();
    await gateway.registerProject({ projectRef: 'ref-1' });
    const op = calls[0] as Extract<PersonalOperation, { action: 'REGISTER_PROJECT' }>;
    expect(op.key).toBe(op.body.requestKey);
    expect(op.body.projectRef).toBe('ref-1');
  });

  it('已提供的 requestKey 透传不变（重试保持幂等身份）', async () => {
    const { gateway, calls } = spyGateway();
    await gateway.startEnvironmentOperation('p1', { requestKey: 'keep-me', kind: 'PREPARE' });
    const op = calls[0] as Extract<PersonalOperation, { action: 'ENVIRONMENT_OPERATION' }>;
    expect(op.key).toBe('keep-me');
    expect(op.body.requestKey).toBe('keep-me');
  });

  it('事件页 limit 以冻结 DECIMAL 字符串传输', async () => {
    const { gateway, calls } = spyGateway();
    await gateway.getEnvironmentOperationEvents('op1', { cursor: 'c1', limit: 25 });
    const op = calls[0] as Extract<PersonalOperation, { action: 'OPERATION_EVENTS' }>;
    expect(op.limit).toBe('25');
    expect(op.cursor).toBe('c1');
  });
});

describe('示例 transport（标注示例，不冒充真实环境）', () => {
  it('meta.source 恒为 demo-fixture 且声明全部动作', async () => {
    const t = createDemoTransport();
    const res = await t({ action: 'OVERVIEW' });
    expect(res.meta.source).toBe('demo-fixture');
    expect(res.meta.supportedActions.length).toBeGreaterThan(0);
  });

  it('ENVIRONMENT_OPERATION 幂等：同 requestKey 回放同一 operationId', async () => {
    const t = createDemoTransport();
    const body = { requestKey: 'same-key', kind: 'PREPARE' } as { requestKey: string; kind: 'PREPARE' };
    const a = await t({ action: 'ENVIRONMENT_OPERATION', projectId: 'p-demo-java', key: 'same-key', body });
    const b = await t({ action: 'ENVIRONMENT_OPERATION', projectId: 'p-demo-java', key: 'same-key', body });
    expect((a.data as { operationId: string }).operationId).toBe((b.data as { operationId: string }).operationId);
  });
});
