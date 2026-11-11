import { join } from 'node:path';
import { test, expect } from '../fixtures/personal-ui';
import {
  createTaskViaUi, gotoTasks, personalApi, receiptValue, waitForControl,
} from '../fixtures/assertions';
import { caseDir, writeJson } from '../fixtures/run-artifacts';

const PAUSED_RUN = {
  state: 'PAUSED', sourceStatus: 'PAUSED_FOR_HUMAN', stateVersion: 6,
  checkpointAvailable: true, availableActions: ['RESUME', 'STOP'], controlState: 'NONE',
};

async function createRunningTask(page: any, personalUi: any, instruction: string) {
  await gotoTasks(page, personalUi.url);
  const taskId = await createTaskViaUi(page, instruction);
  await expect(page.getByText('状态：执行中')).toBeVisible({ timeout: 20_000 });
  const view = await waitForControl(page, taskId, (v) => v.run?.state === 'RUNNING' && (v.allowedIntents ?? []).includes('PAUSE'), 'RUNNING 可暂停');
  return { taskId, view };
}

test.describe('运行控制', () => {
  test('PUI-010 @p0 暂停登记→已生效，按钮约束跟随源端投影', async ({ page, personalUi }) => {
    const { taskId, view } = await createRunningTask(page, personalUi, 'PUI-010 暂停后继续');
    const runId = view.run.runId;
    const sessionId = view.run.sessionId;
    expect(view.run.stateVersion).toBe(5);
    await expect(page.getByRole('button', { name: '暂停', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '停止', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '继续', exact: true })).toHaveCount(0);

    await page.getByRole('button', { name: '暂停', exact: true }).click();
    const pending = await waitForControl(page, taskId, (v) => (v.pendingRequests ?? []).length === 1, 'PAUSE 已登记');
    const commandId = pending.pendingRequests[0].commandId as string;
    expect(pending.pendingRequests[0].request.expectedStateVersion).toBe(5);
    // 控制请求不得乐观改写运行状态。
    await expect(page.getByText('状态：执行中')).toBeVisible();
    await expect(page.getByText('已受理/处理中')).toBeVisible({ timeout: 20_000 });
    const attempts = personalUi.source.commandAttempts().filter((a: any) => a.commandId === commandId);
    expect(attempts, '同一命令只派发一次').toHaveLength(1);
    expect(attempts[0].intent).toBe('PAUSE');

    // 源端在下一个边界消费 PAUSE → 回执 APPLIED，运行进入暂停。
    personalUi.source.setCommand(commandId, {
      schemaVersion: 'run-command-receipt/1',
      receiptId: 'receipt-pui-010',
      runId, sessionId, intent: 'PAUSE', phase: 'APPLIED', receiptRevision: '2',
      acceptedAt: '2026-10-19T00:00:06Z',
      actor: { principalId: 'personal-web', clientSessionId: 'client-session-test' },
      expectedStateVersion: 5, acceptedStateVersion: 6, observedStateVersion: 6,
      observedRunState: 'PAUSED_FOR_HUMAN', resultCode: 'PRODUCT_CONTROL_CONSUMED',
      terminal: true, consumptionProof: { boundary: 'TURN_END' },
    });
    personalUi.source.setRun(runId, PAUSED_RUN);

    await expect(page.getByText('状态：已暂停')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole('button', { name: '继续', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '暂停', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: '停止', exact: true })).toBeVisible();

    const settled = await waitForControl(page, taskId, (v) => receiptValue(v, commandId)?.phase === 'APPLIED', 'APPLIED 回执可见');
    expect(settled.run.runId).toBe(runId);
    expect(settled.run.sessionId).toBe(sessionId);
    expect(personalUi.source.commandAttempts().filter((a: any) => a.commandId === commandId)).toHaveLength(1);
  });

  test('PUI-011 @p0 继续只在已暂停且有检查点时提供，且沿用原运行', async ({ page, personalUi }) => {
    const { taskId, view } = await createRunningTask(page, personalUi, 'PUI-011 继续条件');
    const runId = view.run.runId;

    // 可重试暂停：只允许停止。
    personalUi.source.setRun(runId, { state: 'PAUSED', sourceStatus: 'PAUSED_RETRYABLE', stateVersion: 6, checkpointAvailable: false, availableActions: ['STOP'] });
    await waitForControl(page, taskId, (v) => (v.allowedIntents ?? []).join(',') === 'STOP', 'PAUSED_RETRYABLE 只允许 STOP');
    await page.reload();
    await expect(page.getByRole('button', { name: '停止', exact: true })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole('button', { name: '继续', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: '暂停', exact: true })).toHaveCount(0);

    // 人工暂停但没有检查点：仍不提供继续。
    personalUi.source.setRun(runId, { state: 'PAUSED', sourceStatus: 'PAUSED_FOR_HUMAN', stateVersion: 7, checkpointAvailable: false, availableActions: ['RESUME', 'STOP'] });
    await waitForControl(page, taskId, (v) => (v.allowedIntents ?? []).join(',') === 'STOP', '无检查点不提供 RESUME');
    await page.reload();
    await expect(page.getByRole('button', { name: '继续', exact: true })).toHaveCount(0);

    // 有检查点：继续可用，且必须携带当前 stateVersion。
    personalUi.source.setRun(runId, { ...PAUSED_RUN, stateVersion: 8 });
    await waitForControl(page, taskId, (v) => (v.allowedIntents ?? []).includes('RESUME'), 'RESUME 可用');
    await page.reload();
    await expect(page.getByRole('button', { name: '继续', exact: true })).toBeVisible({ timeout: 20_000 });
    await page.getByRole('button', { name: '继续', exact: true }).click();
    const resumed = await waitForControl(page, taskId, (v) => (v.pendingRequests ?? []).some((p: any) => p.request.intent === 'RESUME'), 'RESUME 已登记');
    const resume = resumed.pendingRequests.find((p: any) => p.request.intent === 'RESUME');
    expect(resume.request.expectedStateVersion).toBe(8);
    const attempt = personalUi.source.commandAttempts().find((a: any) => a.commandId === resume.commandId);
    expect(attempt!.expectedStateVersion).toBe(8);

    personalUi.source.setCommand(resume.commandId, {
      ...receiptValue(resumed, resume.commandId),
      phase: 'APPLIED', receiptRevision: '3', terminal: true,
      observedRunState: 'RUNNING', resultCode: 'PRODUCT_CONTROL_CONSUMED',
      consumptionProof: { boundary: 'TURN_START' },
    });
    personalUi.source.setRun(runId, { state: 'RUNNING', sourceStatus: 'RUNNING', stateVersion: 9, checkpointAvailable: true, availableActions: ['PAUSE', 'STOP'] });
    await expect(page.getByText('状态：执行中')).toBeVisible({ timeout: 30_000 });
    const after = await waitForControl(page, taskId, (v) => v.run?.state === 'RUNNING' && (v.allowedIntents ?? []).includes('PAUSE'), 'RESUME 后回到 RUNNING');
    expect(after.run.runId, '继续不得更换运行').toBe(runId);
  });

  test('PUI-012 @p0 停止确认可取消；确认后只提交一条不带版本号的 STOP', async ({ page, personalUi }) => {
    const { taskId, view } = await createRunningTask(page, personalUi, 'PUI-012 停止确认');
    const runId = view.run.runId;

    // 取消：不得产生任何控制写入。
    page.once('dialog', async (dialog) => {
      expect(dialog.message()).toContain('停止当前执行');
      await dialog.dismiss();
    });
    await page.getByRole('button', { name: '停止', exact: true }).click();
    await page.waitForTimeout(500);
    expect(personalUi.source.commandAttempts(), '取消确认不得提交 STOP').toHaveLength(0);
    await expect(page.getByRole('button', { name: '停止', exact: true })).toBeVisible();

    // 确认：一条 STOP，且不携带 expectedStateVersion。
    page.once('dialog', (dialog) => dialog.accept());
    await page.getByRole('button', { name: '停止', exact: true }).click();
    const pending = await waitForControl(page, taskId, (v) => (v.pendingRequests ?? []).length === 1, 'STOP 已登记');
    const commandId = pending.pendingRequests[0].commandId as string;
    const attempts = personalUi.source.commandAttempts().filter((a: any) => a.commandId === commandId);
    expect(attempts).toHaveLength(1);
    expect(attempts[0].intent).toBe('STOP');
    expect(attempts[0].expectedStateVersion, 'STOP 不得携带版本号').toBeUndefined();
    // 未终结的 STOP 抑制第二个 STOP。
    await expect(page.getByRole('button', { name: '停止', exact: true })).toHaveCount(0);

    // 源端终态：回执 APPLIED，运行取消，按钮全部消失。
    personalUi.source.setCommand(commandId, {
      ...receiptValue(pending, commandId),
      phase: 'APPLIED', receiptRevision: '2', terminal: true,
      observedRunState: 'CANCELLED', resultCode: 'TARGET_TERMINAL_CANCELLED',
      evidenceRef: 'run-terminal:cancelled',
    });
    personalUi.source.setRun(runId, { state: 'CANCELLED', sourceStatus: 'CANCELLED', stateVersion: 10, availableActions: [] });
    await expect(page.getByText('状态：已取消')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole('button', { name: '停止', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: '暂停', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: '继续', exact: true })).toHaveCount(0);
  });

  test('PUI-015 @p0 源端拒绝暂停时页面必须显示可核对的原因', async ({ page, personalUi }) => {
    const { taskId } = await createRunningTask(page, personalUi, 'PUI-015 源端拒绝暂停');
    const keys: string[] = [];
    page.on('request', (request) => {
      if (request.method() !== 'POST' || !request.url().includes('/commands')) return;
      try { keys.push((request.postDataJSON() as { requestKey: string }).requestKey); } catch { /* ignore */ }
    });
    personalUi.source.failNext(
      { method: 'POST', path: /^\/api\/v2\/runs\/[^/]+\/commands$/ },
      { status: 409, body: { code: 'STATE_VERSION_CONFLICT', message: 'state version changed', status: 409 } },
    );
    await page.getByRole('button', { name: '暂停', exact: true }).click();
    await page.waitForTimeout(1_500);

    const key = keys[0];
    expect(key, '应产生一条控制提交').toBeTruthy();
    const record = await personalApi(page, `/api/personal/v1/tasks/${taskId}/commands/${key}`);
    const list = await personalApi(page, `/api/personal/v1/tasks/${taskId}/commands`);
    const evidence = {
      rejection: record.body?.data?.sourceRejection ?? null,
      pendingInList: (list.body?.data?.pendingRequests ?? []).length,
      historyInList: (list.body?.data?.sourceCommands?.items ?? []).length,
      allowedIntents: list.body?.data?.allowedIntents ?? [],
      tail: (await page.locator('body').innerText()).slice(-600),
    };
    // 服务端确实记录了源端明确拒绝（不是传输不确定）。
    expect(evidence.rejection, `服务端未记录明确拒绝：${JSON.stringify(evidence)}`).toMatchObject({ code: 'STATE_VERSION_CONFLICT' });

    // 页面必须让用户看到「被拒绝」和原因，而不是静默恢复原状。
    const visible = await page.getByText(/STATE_VERSION_CONFLICT|已拒绝|版本.*(冲突|变化|已变)/).first()
      .isVisible().catch(() => false);
    writeJson(join(caseDir('PUI-015'), 'evidence.json'), { ...evidence, pageShowsReason: visible });
    expect(visible, `页面未展示源端拒绝原因（产品缺陷，服务端已记录）：${JSON.stringify(evidence)}`).toBe(true);
  });

  test('PUI-016 @p1 其他端命令可见，未决控制请求抑制新的暂停/继续', async ({ page, personalUi }) => {
    const { taskId, view } = await createRunningTask(page, personalUi, 'PUI-016 其他端命令');
    const runId = view.run.runId;
    personalUi.source.setCommand('other-tab:cmd-01', {
      schemaVersion: 'run-command-receipt/1', receiptId: 'receipt-other-1', runId, intent: 'PAUSE',
      phase: 'APPLIED', receiptRevision: '4', acceptedAt: '2026-10-19T00:01:00Z',
      actor: { principalId: 'other-tab', clientSessionId: 'other' },
      acceptedStateVersion: 5, observedStateVersion: 6, observedRunState: 'PAUSED_FOR_HUMAN', terminal: true,
    });
    await page.reload();
    await expect(page.getByText('源端命令历史（含其他端发起）')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole('button', { name: '暂停', exact: true })).toBeVisible();

    // 本端登记一个未决 PAUSE 后，暂停/继续都不再提供，停止仍可用。
    await page.getByRole('button', { name: '暂停', exact: true }).click();
    await waitForControl(page, taskId, (v) => (v.pendingRequests ?? []).length === 1, '未决 PAUSE');
    await expect(page.getByRole('button', { name: '暂停', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: '继续', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: '停止', exact: true })).toBeVisible();
  });

  test('PUI-017 @p1 回执阶段文案与含冒号游标的历史翻页', async ({ page, personalUi }) => {
    const { taskId, view } = await createRunningTask(page, personalUi, 'PUI-017 阶段与翻页');
    const runId = view.run.runId;
    const phases: [string, string][] = [
      ['ACCEPTED', '已受理/处理中'], ['DISPATCHING', '已受理/处理中'], ['REQUESTED', '已受理/处理中'],
      ['APPLIED', '已生效'], ['NOOP', '源端已处于目标状态，无需执行'],
      ['REJECTED', '已拒绝'], ['SUPERSEDED', '已被后续控制取代'], ['UNKNOWN', '结果尚未确认'],
    ];
    // 先放 18 条填充（更早），再放 8 种阶段（最新页可见），总数 > 20 才有「更早」。
    for (let i = 0; i < 18; i++) {
      personalUi.source.setCommand(`ext:${taskId}:filler-${String(i).padStart(2, '0')}`, {
        schemaVersion: 'run-command-receipt/1', receiptId: `receipt-filler-${i}`, runId, intent: 'STOP',
        phase: 'APPLIED', receiptRevision: '9', acceptedAt: `2026-10-19T00:01:${String(i).padStart(2, '0')}Z`,
        actor: { principalId: 'other-tab', clientSessionId: 'other' },
        acceptedStateVersion: 5, observedStateVersion: 5, observedRunState: 'CANCELLED', terminal: true,
      });
    }
    phases.forEach(([phase], index) => {
      personalUi.source.setCommand(`ext:${taskId}:${String(index + 1).padStart(2, '0')}`, {
        schemaVersion: 'run-command-receipt/1', receiptId: `receipt-phase-${index}`, runId, intent: 'PAUSE',
        phase, receiptRevision: String(index + 1), acceptedAt: `2026-10-19T00:02:${String(index).padStart(2, '0')}Z`,
        actor: { principalId: 'other-tab', clientSessionId: 'other' },
        acceptedStateVersion: 5, observedStateVersion: 5, observedRunState: 'RUNNING',
        resultCode: phase === 'REJECTED' ? 'RUN_STATE_UNCHANGED' : undefined, terminal: phase !== 'UNKNOWN',
      });
    });
    await page.reload();
    const control = page.locator('section.card').filter({ hasText: '运行控制' }).first();
    for (const [, label] of phases) {
      await expect(control.getByText(label, { exact: false }).first()).toBeVisible({ timeout: 20_000 });
    }

    // 超过一页后翻页：before 携带含冒号的 commandId，不得出现协议错误。
    await page.getByRole('button', { name: '更早' }).click();
    await expect(page.getByRole('button', { name: '回到最新' })).toBeVisible();
    await expect(page.getByText(/PROTOCOL_ERROR|INVALID_OPERATION|请求失败/)).toHaveCount(0);
  });

  test('PUI-018 @p1 运行已终态但本地 STOP 未确认时保留待核对状态', async ({ page, personalUi }) => {
    const { taskId, view } = await createRunningTask(page, personalUi, 'PUI-018 终态与未决停止');
    const runId = view.run.runId;

    // 停止的传输结果不确定：本地保留未决请求。
    personalUi.source.failNext({ method: 'POST', path: /^\/api\/v2\/runs\/[^/]+\/commands$/ }, { status: 503, body: { code: 'UPSTREAM_UNAVAILABLE', message: 'transport lost', status: 503 } });
    page.once('dialog', (dialog) => dialog.accept());
    await page.getByRole('button', { name: '停止', exact: true }).click();
    const pending = await waitForControl(page, taskId, (v) => (v.pendingRequests ?? []).length === 1, 'STOP 未决');
    const commandId = pending.pendingRequests[0].commandId as string;

    // 源端先进入终态（例如其它端已停止）：未决请求不得被吞掉。
    personalUi.source.setRun(runId, { state: 'CANCELLED', sourceStatus: 'CANCELLED', stateVersion: 10, availableActions: [] });
    await page.reload();
    await expect(page.getByText('状态：已取消')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText('已登记控制请求')).toBeVisible();
    await expect(page.getByRole('button', { name: '核对结果' })).toBeVisible();

    // 源端补上终态回执后，待核对项收敛。
    personalUi.source.setCommand(commandId, {
      schemaVersion: 'run-command-receipt/1',
      receiptId: 'receipt-pui-018',
      runId,
      sessionId: 'session-one',
      intent: 'STOP',
      phase: 'APPLIED',
      receiptRevision: '2',
      acceptedAt: '2026-10-19T00:05:00Z',
      actor: { principalId: 'personal-web', clientSessionId: 'client-session-test' },
      acceptedStateVersion: 10,
      observedStateVersion: 10,
      observedRunState: 'CANCELLED',
      resultCode: 'TARGET_TERMINAL_CANCELLED',
      evidenceRef: 'run-terminal:cancelled',
      terminal: true,
    });
    await page.getByRole('button', { name: '核对结果' }).click();
    await expect(page.getByText('已登记控制请求')).toHaveCount(0, { timeout: 20_000 });
  });

  test('PUI-022 @p1 轮询只做只读核对，离开详情后停止', async ({ page, personalUi }) => {
    const { taskId } = await createRunningTask(page, personalUi, 'PUI-022 轮询收敛');
    const posts: string[] = [];
    const reads: string[] = [];
    page.on('request', (request) => {
      if (!request.url().includes('/api/personal/v1/tasks/')) return;
      if (request.method() === 'POST') posts.push(request.url());
      else if (request.url().includes('/commands')) reads.push(request.url());
    });

    await page.getByRole('button', { name: '暂停', exact: true }).click();
    await waitForControl(page, taskId, (v) => (v.pendingRequests ?? []).length === 1, 'PAUSE 未决');
    const postsAfterClick = posts.length;
    await page.waitForTimeout(4_000);
    expect(posts.length, '等待回执期间不得重复派发控制请求').toBe(postsAfterClick);

    // 离开详情：不再有该任务的命令读取。
    await page.getByRole('link', { name: '返回任务列表' }).click();
    await page.waitForURL(/#\/tasks$/);
    await page.waitForTimeout(500);
    const readsAtLeave = reads.length;
    await page.waitForTimeout(2_000);
    expect(reads.length, '离开详情后不得继续轮询控制视图').toBe(readsAtLeave);
  });
});
