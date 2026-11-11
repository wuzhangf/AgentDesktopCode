// @vitest-environment jsdom
// PAE P6 — 页面行为测试源码（本轮不运行，统一合并后执行）。
// 覆盖任务单 §9 关键交互语义：
// - E05：试跑成功后保存失败——回执保留，绝不触发第二次执行；
// - 只读面（手机式窄接口）：写按钮不显示；
// - 总览：同根因待处理合并呈现。
import { describe, it, expect, afterEach } from 'vitest';
import { fireEvent, render, screen, waitFor, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';
import type { PersonalEnvelope, PersonalOperation } from '../../codeagent-desktop/packages/protocol/src/personal';
import { PersonalClientError, type PersonalTransport } from '../src/personal/client';
import { personalGateway, type PersonalSurface } from '../src/personal/port';
import { PersonalGatewayProvider } from '../src/personal/hooks';
import { ActionsPanel } from '../src/personal/components/ActionsPanel';
import { EnvironmentPanel } from '../src/personal/components/EnvironmentPanel';
import { TaskControlCard } from '../src/personal/components/TaskControlCard';
import OverviewPage from '../src/personal/pages/OverviewPage';
import { createDemoTransport } from '../src/personal/demo';

// vitest runs without globals, so RTL auto-cleanup is off — unmount explicitly
// between tests or stacked renders make earlier buttons visible to later queries.
afterEach(cleanup);

const META_ALL = {
  source: 'test', instance: 't', controlPlaneId: 'cp', observedAt: '2026-10-18T00:00:00Z',
  revision: '1',
  supportedActions: ['ENVIRONMENT_PLAN', 'ENVIRONMENT_OPERATION', 'OPERATION_CANCEL', 'ACTION_RUN', 'ACTION_SAVE', 'REGISTER_PROJECT', 'REPORT_CREATE'],
  reasonCodes: [],
};
const envOf = <T,>(data: T): PersonalEnvelope<T> => ({ meta: META_ALL, data });

function surfaceOf(transport: PersonalTransport, readonly = false): PersonalSurface {
  return { kind: 'web', readonly, transport, gateway: personalGateway(transport), label: 'test' };
}

function renderWith(node: ReactNode, transport: PersonalTransport, readonly = false) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 0 } } });
  return render(
    <QueryClientProvider client={qc}>
      <PersonalGatewayProvider surface={surfaceOf(transport, readonly)}>
        <MemoryRouter>{node}</MemoryRouter>
      </PersonalGatewayProvider>
    </QueryClientProvider>,
  );
}

const DEMO_ACTION = {
  actionId: 'a-1', actionVersion: '2', name: '运行项目测试', scope: 'TASK',
  objective: '试跑声明动作', saved: false, revision: '2',
};

describe('常用动作 — 试跑与保存是分离效果（E05）', () => {
  it('试跑成功后保存失败：回执保留且不再执行', async () => {
    const calls: PersonalOperation[] = [];
    const transport: PersonalTransport = async (op) => {
      calls.push(op);
      if (op.action === 'TASK_ACTIONS') return envOf([DEMO_ACTION]);
      if (op.action === 'ACTION_RUN') return envOf({
        trialId: 'trial-1', actionId: 'a-1', exitStatus: 0, evidenceVerdict: 'PASS',
        startedAt: '2026-10-18T00:00:00Z', endedAt: '2026-10-18T00:00:03Z',
      });
      if (op.action === 'ACTION_SAVE') throw new PersonalClientError('SAVE_FAILED', '登记库暂时不可用');
      return envOf({});
    };
    renderWith(<ActionsPanel taskId="t-1" />, transport);
    fireEvent.click(await screen.findByText('试跑'));
    await screen.findByText('试跑通过');
    fireEvent.click(screen.getByText(/保存为项目动作/));
    fireEvent.click(await screen.findByText('确认保存'));
    await screen.findByText(/保存失败/);
    // 执行结果保留、保存错误单独呈现、没有第二次执行
    expect(screen.getByText('试跑通过')).toBeTruthy();
    expect(screen.getByText(/未再次执行/)).toBeTruthy();
    expect(calls.filter(c => c.action === 'ACTION_RUN')).toHaveLength(1);
    expect(calls.filter(c => c.action === 'ACTION_SAVE')).toHaveLength(1);
  });
});

describe('项目运行环境页（§9.2）', () => {
  const ENV_VIEW = {
    projectId: 'p1', state: 'FAILED', needs: [{ kind: 'TOOL', name: 'jdk', version: '21', source: 'mvnw' }],
    have: [], missing: [{ kind: 'TOOL', name: 'jdk', version: '21' }], supportedCores: ['acs'],
  };
  const transportFor = (): PersonalTransport => async (op) => {
    if (op.action === 'PROJECT_ENVIRONMENT') return envOf(ENV_VIEW);
    return envOf({});
  };
  it('supportedActions 声明写动作时显示版本选择与一键准备', async () => {
    renderWith(<EnvironmentPanel projectId="p1" />, transportFor());
    await screen.findByText('一键准备');
    await screen.findByText('生成计划预览');
    // 「缺少」同时是栏目标题与缺失项徽标——断言其出现而非唯一。
    expect(screen.getAllByText('缺少').length).toBeGreaterThan(0);
  });
  it('只读面（窄接口）不显示任何写按钮', async () => {
    renderWith(<EnvironmentPanel projectId="p1" />, transportFor(), true);
    await screen.findByText('需要');
    expect(screen.queryByText('一键准备')).toBeNull();
    expect(screen.queryByText('生成计划预览')).toBeNull();
    expect(screen.getByText(/只读视图/)).toBeTruthy();
  });
});

describe('总览 — 同根因待处理合并（§9.5）', () => {
  it('示例 transport 的两条 ENV_MISSING 合并为一条并标注数量', async () => {
    renderWith(<OverviewPage />, createDemoTransport());
    await waitFor(() => expect(screen.getByText(/2 条同根因/)).toBeTruthy());
  });
});

describe('任务控制卡 — 可靠控制读视图（§6.1/§6.2）', () => {
  const RECEIPT = {
    schemaVersion: 'run-command-receipt/1', commandId: 'cmd-1', receiptId: 'rcpt-1',
    sessionId: 's-1', runId: 'r-1', intent: 'STOP', phase: 'APPLIED', receiptRevision: '1',
    acceptedAt: '2026-10-18T00:00:00Z',
    actor: { principalId: 'p-1', clientSessionId: 'cs-1' },
    acceptedStateVersion: 1, observedStateVersion: 2, observedRunState: 'CANCELLED', terminal: true,
  };
  const controlView = (taskId: string, nextBefore: string | null) => envOf({
    taskId, observedAt: '2026-10-18T00:00:01Z', allowedIntents: [], reasonCodes: [],
    pendingRequests: [], sourceCommands: { items: [RECEIPT], nextBefore },
  });

  it('示例面不发控制查询，只显示说明（控制请求以真实 BFF 为准）', async () => {
    const calls: PersonalOperation[] = [];
    const transport: PersonalTransport = async (op) => { calls.push(op); return envOf({}); };
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 0 } } });
    const surface: PersonalSurface = { kind: 'demo', readonly: false, transport, gateway: personalGateway(transport), label: '示例数据' };
    render(
      <QueryClientProvider client={qc}>
        <PersonalGatewayProvider surface={surface}>
          <MemoryRouter><TaskControlCard taskId="t-1" /></MemoryRouter>
        </PersonalGatewayProvider>
      </QueryClientProvider>,
    );
    expect(await screen.findByText(/示例数据不提供任务控制/)).toBeTruthy();
    expect(calls.filter(c => c.action === 'TASK_COMMANDS' || c.action === 'TASK_COMMAND_CREATE' || c.action === 'TASK_COMMAND')).toHaveLength(0);
  });

  it('切换任务时源端历史翻页游标重置（before 只对同一 Run 有意义）', async () => {
    const calls: PersonalOperation[] = [];
    const transport: PersonalTransport = async (op) => {
      calls.push(op);
      if (op.action === 'TASK_COMMANDS') {
        const firstPage = op.before === undefined;
        return controlView(op.taskId, firstPage ? 'cmd-1' : null);
      }
      return envOf({});
    };
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 0 } } });
    const surface = surfaceOf(transport);
    const tree = (taskId: string) => (
      <QueryClientProvider client={qc}>
        <PersonalGatewayProvider surface={surface}>
          <MemoryRouter><TaskControlCard taskId={taskId} /></MemoryRouter>
        </PersonalGatewayProvider>
      </QueryClientProvider>
    );
    const { rerender } = render(tree('t-1'));
    fireEvent.click(await screen.findByText('更早'));
    await waitFor(() => expect(calls.some(c => c.action === 'TASK_COMMANDS' && c.before === 'cmd-1')).toBe(true));
    rerender(tree('t-2'));
    await waitFor(() => expect(calls.some(c => c.action === 'TASK_COMMANDS' && c.taskId === 't-2')).toBe(true));
    // 新任务的查询不得携带上一个任务的源游标。
    const forT2 = calls.filter((c): c is Extract<PersonalOperation, { action: 'TASK_COMMANDS' }> => c.action === 'TASK_COMMANDS' && c.taskId === 't-2');
    expect(forT2.length).toBeGreaterThan(0);
    expect(forT2.every(c => c.before === undefined)).toBe(true);
  });
});
