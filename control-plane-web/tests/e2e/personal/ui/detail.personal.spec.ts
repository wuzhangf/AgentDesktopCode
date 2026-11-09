import { test, expect } from '../fixtures/personal-ui';
import {
  createTaskViaUi, gotoTasks, personalApi, receiptValue, taskDetail, waitForControl,
} from '../fixtures/assertions';

/**
 * PUI-009/019 — 详情核心信息、区块局部故障、控制视图失败与回执版本不倒退。
 */
test.describe('任务详情', () => {
  test('PUI-009 @p0 详情展示原请求、活动、输出与未采集用量', async ({ page, personalUi }) => {
    await gotoTasks(page, personalUi.url);
    const instruction = 'PUI-009 读取 x.txt 并改写为 v2';
    const taskId = await createTaskViaUi(page, instruction);

    await expect(page.getByRole('heading', { name: instruction })).toBeVisible();
    await expect(page.getByText('状态：执行中')).toBeVisible();
    await expect(page.getByText(/Agent：代码 Agent/)).toBeVisible();
    await expect(page.getByText(/配置模型：fixture-model/)).toBeVisible();
    await expect(page.getByText(/运行时长：/)).toBeVisible();
    await expect(page.getByText(/FILE_WRITE · SUCCEEDED/)).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText('protocol output: x.txt changed v1 -> v2')).toBeVisible();

    // 观测未接入：用量必须是「未知／未采集」，不能显示 0 伪装已采集。
    const usage = page.locator('section.card').filter({ hasText: '选中运行用量' });
    await expect(usage.getByText('未知／未采集').first()).toBeVisible({ timeout: 20_000 });
    await expect(usage).not.toContainText('0 输入 token');

    const metrics = await personalApi(page, `/api/personal/v1/tasks/${taskId}/metrics`);
    expect(metrics.body.data.reasonCodes).toContain('OBSERVATION_NOT_BOUND');
    expect(metrics.body.data.metrics.every((m: any) => m.value === null)).toBe(true);
  });

  test('PUI-009b @p1 活动区块失败只影响本卡，运行状态仍可读', async ({ page, personalUi }) => {
    await gotoTasks(page, personalUi.url);
    const taskId = await createTaskViaUi(page, 'PUI-009b 活动读取失败');
    await expect(page.getByText('状态：执行中')).toBeVisible({ timeout: 20_000 });
    // 在页面已就绪后再注入故障，并用「刷新全部」触发真实重取（避免被在途轮询吞掉）。
    personalUi.source.failNext({ method: 'GET', path: /^\/api\/v2\/runs\/[^/]+\/activities$/ }, { status: 503, times: 20 });
    await page.getByRole('button', { name: '刷新全部' }).click();

    const activityCard = page.locator('section.card').filter({ hasText: '活动' }).last();
    // 区块自身失败必须可见（服务端/源端错误原文 + 重试），且只影响本卡。
    await expect(activityCard.getByRole('status')).toBeVisible({ timeout: 20_000 });
    await expect(activityCard.getByRole('button', { name: '重试' })).toBeVisible();
    // 运行详情卡没有被活动区块的失败拖垮。
    await expect(page.getByText('运行详情')).toBeVisible();
    await expect(page.getByText('状态：执行中')).toBeVisible();
  });

  test('PUI-019 @p0 控制视图读取失败不影响详情；已存高版本回执不被低版本覆盖', async ({ page, personalUi }) => {
    await gotoTasks(page, personalUi.url);
    const taskId = await createTaskViaUi(page, 'PUI-019 控制视图局部故障');

    // 读取控制视图失败：只有控制卡降级，运行详情仍展示。
    await expect(page.getByText('状态：执行中')).toBeVisible({ timeout: 20_000 });
    personalUi.source.failNext({ method: 'GET', path: /^\/api\/v2\/runs\/[^/]+\/commands$/ }, { status: 503, times: 20 });
    await page.getByRole('button', { name: '刷新全部' }).click();
    await expect(page.getByText(/控制视图读取失败/)).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText('状态：执行中')).toBeVisible();
    personalUi.source.clearFailures();
    await page.getByRole('button', { name: '刷新全部' }).click();
    personalUi.source.clearFailures();
    await page.getByRole('button', { name: '刷新全部' }).click();

    // 恢复后发起一次 PAUSE，并把回执推进到 revision 2 / APPLIED。
    await expect(page.getByRole('button', { name: '暂停', exact: true })).toBeVisible({ timeout: 20_000 });
    await page.getByRole('button', { name: '暂停', exact: true }).click();
    const view = await waitForControl(page, taskId, (v) => (v.pendingRequests ?? []).length > 0, 'PAUSE 已登记');
    const commandId = view.pendingRequests[0].commandId as string;
    expect(commandId.startsWith('web-control-')).toBe(true);

    personalUi.source.setCommand(commandId, {
      schemaVersion: 'run-command-receipt/1',
      receiptId: 'receipt-pui-019',
      runId: view.run.runId,
      sessionId: view.run.sessionId,
      intent: 'PAUSE',
      phase: 'APPLIED',
      receiptRevision: '2',
      acceptedAt: '2026-10-19T00:00:05Z',
      actor: { principalId: 'personal-web', clientSessionId: 'client-session-test' },
      expectedStateVersion: view.run.stateVersion,
      acceptedStateVersion: 6,
      observedStateVersion: 6,
      observedRunState: 'PAUSED_FOR_HUMAN',
      resultCode: 'PRODUCT_CONTROL_CONSUMED',
      terminal: true,
      consumptionProof: { boundary: 'TURN_END' },
    });
    personalUi.source.setRun(view.run.runId, {
      state: 'PAUSED', sourceStatus: 'PAUSED_FOR_HUMAN', stateVersion: 6,
      checkpointAvailable: true, availableActions: ['RESUME', 'STOP'], controlState: 'NONE',
    });
    const applied = await waitForControl(page, taskId, (v) => receiptValue(v, commandId)?.phase === 'APPLIED', '回执 APPLIED');
    expect(receiptValue(applied, commandId).receiptRevision).toBe('2');

    // 源端回退到低版本回执：本地已存高版本不得被覆盖。
    personalUi.source.setCommand(commandId, {
      ...receiptValue(applied, commandId),
      phase: 'REQUESTED',
      receiptRevision: '1',
      terminal: false,
    });
    await page.reload();
    await expect(page.getByText('状态：已暂停')).toBeVisible({ timeout: 20_000 });
    // 单条记录读的是本地冻结回执（不是源端最新页）。
    const record = await personalApi(page, `/api/personal/v1/tasks/${taskId}/commands/${commandId}`);
    expect(record.body.data.receipt?.receiptRevision, '本地回执版本不得倒退').toBe('2');
    // 不得因为回退而重新派发同一命令。
    expect(personalUi.source.commandAttempts().filter((a) => a.commandId === commandId)).toHaveLength(1);
    void (await taskDetail(page, taskId));
  });
});
