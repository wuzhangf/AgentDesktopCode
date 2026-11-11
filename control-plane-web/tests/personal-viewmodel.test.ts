// PAE P6 — 视图模型纯函数测试源码（本轮不运行）。
// 覆盖：待处理合并、supportedActions 门禁（未声明即不支持）、轮询节奏、
// 任务启动检查（纯 Design 不强迫环境）、原操作恢复登记与最近任务。
import { describe, it, expect } from 'vitest';
import {
  attentionTarget, canWrite, fmtBytesOrUnknown, fmtIso, launchBlocked, launchChecks,
  listPendingOperations, listRecentTasks, mergeAttention, operationPollInterval,
  readPendingOperation, recordRecentTask, clearPendingOperation, writePendingOperation,
} from '../src/personal/viewmodel';
import type { PersonalAttentionItem, PersonalMeta, PersonalWorkerView } from '../../codeagent-desktop/packages/protocol/src/personal';

function fakeStorage(): Storage {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => { m.set(k, String(v)); },
    removeItem: (k: string) => { m.delete(k); },
    clear: () => m.clear(),
    key: (i: number) => [...m.keys()][i] ?? null,
    get length() { return m.size; },
  } as unknown as Storage;
}

const meta = (actions: string[]): PersonalMeta => ({
  source: 't', instance: 't', controlPlaneId: 'cp', observedAt: '2026-10-18T00:00:00Z',
  revision: '1', supportedActions: actions, reasonCodes: [],
});

describe('supportedActions 门禁（未声明即不支持，禁止静默回退）', () => {
  it('名单缺失或为空一律不支持', () => {
    expect(canWrite(meta(['ENVIRONMENT_OPERATION']), 'ENVIRONMENT_OPERATION', false)).toBe(true);
    expect(canWrite(meta([]), 'ENVIRONMENT_OPERATION', false)).toBe(false);
    expect(canWrite(undefined, 'ENVIRONMENT_OPERATION', false)).toBe(false);
    expect(canWrite(meta(['ENVIRONMENT_PLAN']), 'ENVIRONMENT_OPERATION', false)).toBe(false);
  });
  it('只读面隐藏全部写动作', () => {
    expect(canWrite(meta(['ACTION_RUN']), 'ACTION_RUN', true)).toBe(false);
  });
});

describe('待处理合并（同根因去重）', () => {
  const items: PersonalAttentionItem[] = [
    { kind: 'ENV_MISSING', projectId: 'p1', reasonCode: 'TOOLCHAIN_MISSING', message: '缺 JDK 21', observedAt: '2026-10-18T00:58:00Z' },
    { kind: 'ENV_MISSING', projectId: 'p1', reasonCode: 'TOOLCHAIN_MISSING', message: '缺 JDK 21（wrapper 来源）', observedAt: '2026-10-18T00:57:00Z' },
    { kind: 'TASK_QUESTION', refId: 't1', projectId: 'p1', message: '任务等待确认', observedAt: '2026-10-17T10:00:00Z' },
  ];
  it('同 kind+根因+reasonCode 合并并保留最新文案', () => {
    const merged = mergeAttention(items);
    expect(merged).toHaveLength(2);
    const env = merged.find(m => m.kind === 'ENV_MISSING')!;
    expect(env.count).toBe(2);
    expect(env.message).toBe('缺 JDK 21');
  });
  it('直达原对象：操作 > 任务 > 项目', () => {
    expect(attentionTarget({ kind: 'x', message: '', operationId: 'op1', projectId: 'p1', count: 1 }))
      .toEqual({ type: 'operation', operationId: 'op1', projectId: 'p1' });
    expect(attentionTarget({ kind: 'x', message: '', refId: 't1', projectId: 'p1', count: 1 }))
      .toEqual({ type: 'task', taskId: 't1', projectId: 'p1' });
    expect(attentionTarget({ kind: 'x', message: '', projectId: 'p1', count: 1 }))
      .toEqual({ type: 'project', projectId: 'p1' });
    expect(attentionTarget({ kind: 'x', message: '', count: 1 }).type).toBe('none');
  });
});

describe('操作状态轮询节奏', () => {
  it('QUEUED/RUNNING 快轮询，UNKNOWN 慢核对，其余不轮询', () => {
    expect(operationPollInterval('QUEUED')).toBe(1500);
    expect(operationPollInterval('RUNNING')).toBe(1500);
    expect(operationPollInterval('UNKNOWN')).toBe(5000);
    expect(operationPollInterval('READY')).toBe(false);
    expect(operationPollInterval('FAILED')).toBe(false);
    expect(operationPollInterval('NEEDS_INPUT')).toBe(false);
  });
});

describe('任务启动检查（仅查所需能力）', () => {
  const workers: PersonalWorkerView[] = [{
    workerId: 'w1', connectionKind: 'DAEMON',
    capabilities: { projectEnvironmentPrepareV1: true, environmentBoundExecutionV1: true, adaptiveActionV1: true },
  }];
  it('纯 Design 不要求环境就绪', () => {
    const checks = launchChecks({ kind: 'design', projectId: 'p1', core: 'acs', env: null, envLoaded: false, workers });
    expect(checks.find(c => c.id === 'env')?.state).toBe('not-required');
    expect(launchBlocked(checks)).toBe(false);
  });
  it('代码任务要求环境 READY + 绑定执行能力', () => {
    const blocked = launchChecks({ kind: 'code', projectId: 'p1', core: 'acs', env: { projectId: 'p1', needs: [], have: [], missing: [], state: 'QUEUED' }, envLoaded: true, workers });
    expect(blocked.find(c => c.id === 'env')?.state).toBe('blocked');
    expect(launchBlocked(blocked)).toBe(true);
    const okRun = launchChecks({ kind: 'code', projectId: 'p1', core: 'acs', env: { projectId: 'p1', needs: [], have: [], missing: [], state: 'READY' }, envLoaded: true, workers });
    expect(launchBlocked(okRun)).toBe(false);
  });
  it('环境未读取显示 unknown；无绑定执行能力的 Worker 阻断', () => {
    const noWorkers = launchChecks({ kind: 'code', projectId: 'p1', core: 'acs', env: null, envLoaded: false, workers: [] });
    expect(noWorkers.find(c => c.id === 'exec')?.state).toBe('blocked');
    const loading = launchChecks({ kind: 'code', projectId: 'p1', core: 'acs', env: null, envLoaded: false, workers: null });
    expect(loading.find(c => c.id === 'env')?.state).toBe('unknown');
  });
  it('未选项目/核心即阻断', () => {
    const checks = launchChecks({ kind: 'design', projectId: '', workers: null, envLoaded: false });
    expect(checks.find(c => c.id === 'project')?.state).toBe('blocked');
    expect(checks.find(c => c.id === 'core')?.state).toBe('blocked');
  });
});

describe('原操作恢复登记（localStorage，本机记录非服务端事实）', () => {
  it('写入→读取→清除→列出', () => {
    const store = fakeStorage();
    const rec = { operationId: 'op-1', requestKey: 'rk-1', submittedAt: '2026-10-18T01:00:00Z' };
    writePendingOperation('p1', rec, store);
    expect(readPendingOperation('p1', store)).toEqual(rec);
    expect(listPendingOperations(store)).toEqual([{ projectId: 'p1', ...rec }]);
    clearPendingOperation('p1', store);
    expect(readPendingOperation('p1', store)).toBeNull();
  });
  it('坏 JSON 不抛错，返回 null', () => {
    const store = fakeStorage();
    store.setItem('pae.p6.pendingOp.p9', '{oops');
    expect(readPendingOperation('p9', store)).toBeNull();
  });
});

describe('最近任务记录', () => {
  it('去重前移且封顶 8 条', () => {
    const store = fakeStorage();
    for (let i = 0; i < 10; i++) recordRecentTask(`t-${i}`, 'p1', store);
    recordRecentTask('t-9', 'p1', store);
    const list = listRecentTasks(store);
    expect(list[0].taskId).toBe('t-9');
    expect(list).toHaveLength(8);
  });
});

describe('展示小工具', () => {
  it('字节/时间未知显示未知，不显示 0', () => {
    expect(fmtBytesOrUnknown(null)).toBe('未知');
    expect(fmtBytesOrUnknown(undefined)).toBe('未知');
    expect(fmtBytesOrUnknown(512)).toBe('512 B');
    expect(fmtIso(null)).toBe('未知');
    expect(fmtIso('not-a-date')).toBe('未知');
    expect(fmtIso('2026-10-18T00:00:00Z')).not.toBe('未知');
  });
});
