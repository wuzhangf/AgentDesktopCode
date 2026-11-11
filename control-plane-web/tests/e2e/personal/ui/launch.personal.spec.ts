import { test, expect } from '../fixtures/personal-ui';
import {
  PROJECT_NAME, createTaskViaUi, gotoTasks, personalApi, taskDetail,
} from '../fixtures/assertions';

/**
 * PUI-003/004/005/006 — 按项目名称提交、显式选择、防重复点击、回复丢失后按原键恢复。
 */
test.describe('任务提交', () => {
  test('PUI-003 @p0 按项目名称选择并提交，源端只收到一条创建与原消息', async ({ page, personalUi }) => {
    await gotoTasks(page, personalUi.url);
    const instruction = 'PUI-003 在隔离工作树把 x.txt 从 v1 改为 v2';

    // 项目下拉按显示名选择；选择即自动登记（不需要手填 ID/URL/token）。
    const select = page.getByLabel('项目', { exact: true });
    await expect(select.locator('option', { hasText: PROJECT_NAME }).first()).toBeAttached();
    const value = await select.locator('option', { hasText: PROJECT_NAME }).first().getAttribute('value');
    await select.selectOption(value!);
    await page.getByLabel('任务要求', { exact: true }).fill(instruction);

    const start = page.getByRole('button', { name: '开始任务', exact: true });
    await expect(start).toBeEnabled({ timeout: 20_000 });
    await start.click();
    await page.waitForURL(/#\/tasks\/task-/);
    const taskId = page.url().split('/tasks/')[1]!;

    await expect(page.getByRole('heading', { name: instruction })).toBeVisible();
    await expect(page.getByText('状态：执行中')).toBeVisible({ timeout: 20_000 });

    const writes = personalUi.source.writes();
    expect(writes.sessions, '源端会话创建尝试').toBe(1);
    expect(writes.messages, '源端消息发送尝试').toBe(1);
    expect(writes.commands, '未点击控制前不得有控制命令').toBe(0);

    const detail = await taskDetail(page, taskId);
    expect(detail.session?.sessionId).toBe('session-one');
    expect(detail.run?.runId).toBe('run-one');
    expect(detail.workspaceBinding ?? detail.session?.workspaceBinding).toBeTruthy();

    // 页面不接受手填地址/凭据/任意 ID。
    await expect(page.locator('input[aria-label*="token" i], input[aria-label*="地址" i], input[aria-label*="token"], input[type="password"]')).toHaveCount(0);
  });

  test('PUI-004 @p1 显式 Agent/模型按目录解析，不可用模型不出现', async ({ page, personalUi }) => {
    await gotoTasks(page, personalUi.url);
    await page.getByLabel('项目', { exact: true }).selectOption(
      (await page.getByLabel('项目', { exact: true }).locator('option', { hasText: PROJECT_NAME }).first().getAttribute('value'))!,
    );
    await page.getByText('Agent 与模型（默认沿用 ACS 配置）').click();
    await expect(page.getByLabel('Agent', { exact: true }).locator('option', { hasText: '代码 Agent' })).toBeAttached();
    await page.getByLabel('Agent', { exact: true }).selectOption({ label: '代码 Agent' });
    await page.getByLabel('模型', { exact: true }).selectOption({ label: 'fixture / fixture-model' });
    await expect(page.getByLabel('模型', { exact: true }).locator('option', { hasText: 'unavailable-model' })).toHaveCount(0);

    await page.getByLabel('任务要求', { exact: true }).fill('PUI-004 显式选择 Agent 与模型');
    await page.getByRole('button', { name: '开始任务', exact: true }).click();
    await page.waitForURL(/#\/tasks\/task-/);

    await expect(page.getByText(/Agent：代码 Agent/)).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText(/配置模型：fixture-model/)).toBeVisible();
    const detail = await taskDetail(page, page.url().split('/tasks/')[1]!);
    expect(detail.request?.agentProfileId).toBe('code-profile');
    expect(detail.request?.modelSettings?.modelAlias).toBe('fixture-model');
  });

  test('PUI-004b @p1 模型目录不可读时默认提交仍可用', async ({ page, personalUi }) => {
    personalUi.source.failNext({ method: 'GET', path: /^\/api\/v2\/model-catalog$/ }, { status: 503 });
    await gotoTasks(page, personalUi.url);
    await page.getByLabel('项目', { exact: true }).selectOption(
      (await page.getByLabel('项目', { exact: true }).locator('option', { hasText: PROJECT_NAME }).first().getAttribute('value'))!,
    );
    await page.getByLabel('任务要求', { exact: true }).fill('PUI-004b 目录不可读仍按默认模型提交');
    const start = page.getByRole('button', { name: '开始任务', exact: true });
    await expect(start).toBeEnabled({ timeout: 20_000 });
    await start.click();
    await page.waitForURL(/#\/tasks\/task-/);
    await expect(page.getByText('状态：执行中')).toBeVisible({ timeout: 20_000 });
    expect(personalUi.source.writes().messages).toBe(1);
  });

  test('PUI-005 @p0 提交进行中重复点击不产生第二次创建', async ({ page, personalUi }) => {
    const hold = personalUi.source.holdNext({ method: 'POST', path: /^\/api\/v2\/sessions$/ });
    await gotoTasks(page, personalUi.url);
    await page.getByLabel('项目', { exact: true }).selectOption(
      (await page.getByLabel('项目', { exact: true }).locator('option', { hasText: PROJECT_NAME }).first().getAttribute('value'))!,
    );
    await page.getByLabel('任务要求', { exact: true }).fill('PUI-005 重复点击只允许一次创建');
    await page.getByRole('button', { name: '开始任务', exact: true }).click();
    await hold.entered;

    const busy = page.getByRole('button', { name: '正在提交…' });
    await expect(busy).toBeVisible();
    await expect(busy).toBeDisabled();
    // 第二次点击即便命中同一坐标也不会派发（按钮已禁用）。
    await busy.click({ force: true }).catch(() => undefined);
    const sessionPosts = () => personalUi.source.attempts().sessions;
    expect(sessionPosts(), '点击进行中不得有第二次会话创建').toBe(1);

    hold.release();
    await page.waitForURL(/#\/tasks\/task-/);
    expect(sessionPosts()).toBe(1);
    expect(personalUi.source.uniqueWrites().sessions).toBe(1);
  });

  test('PUI-005b @p1 同一 requestKey 并发提交只登记一个任务', async ({ page, personalUi }) => {
    await gotoTasks(page, personalUi.url);
    const firstTask = await createTaskViaUi(page, 'PUI-005b 建立已登记项目');
    const { projectId } = await taskDetail(page, firstTask);

    const before = personalUi.source.uniqueWrites();
    const outcome = await page.evaluate(async ({ projectId, key }) => {
      const headers = {
        'content-type': 'application/json',
        'x-personal-control': '1',
        'x-personal-tab': sessionStorage.getItem('pae.personal.tabId') ?? '',
        'idempotency-key': key,
      };
      const body = JSON.stringify({ requestKey: key, projectId, instruction: 'PUI-005b 并发同键提交' });
      const send = () => fetch('/api/personal/v1/tasks', { method: 'POST', headers, body, credentials: 'same-origin' })
        .then(async (r) => ({ status: r.status, body: await r.json() }));
      return Promise.all([send(), send()]);
    }, { projectId, key: `web-launch-concurrent-${Date.now()}` });

    expect(outcome.map((o) => o.status)).toEqual([201, 201]);
    expect(outcome[0]!.body.data.taskId).toBe(outcome[1]!.body.data.taskId);
    const after = personalUi.source.uniqueWrites();
    expect(after.messages - before.messages, '并发同键只允许一条源消息').toBe(1);
  });

  test('PUI-006 @p0 创建回复丢失后按原键恢复，刷新不重发', async ({ page, personalUi }) => {
    personalUi.source.failNext({ method: 'POST', path: /^\/api\/v2\/sessions$/ }, { dropAfterHandling: true });
    await gotoTasks(page, personalUi.url);
    await page.getByLabel('项目', { exact: true }).selectOption(
      (await page.getByLabel('项目', { exact: true }).locator('option', { hasText: PROJECT_NAME }).first().getAttribute('value'))!,
    );
    await page.getByLabel('任务要求', { exact: true }).fill('PUI-006 创建回复丢失');
    await page.getByRole('button', { name: '开始任务', exact: true }).click();
    await page.waitForURL(/#\/tasks\/task-/);

    await expect(page.getByText('状态：提交尚待核对')).toBeVisible({timeout:20000});
    await expect(page.getByRole('button', { name: '核对并继续原提交' })).toBeVisible();
    expect(personalUi.source.uniqueWrites().sessions, '源端只应有一个会话').toBe(1);
    const attemptsAfterLoss = personalUi.source.writes().sessions;

    // 只读刷新不得补发源请求。
    await page.reload();
    await expect(page.getByText('状态：提交尚待核对')).toBeVisible({timeout:20000});
    expect(personalUi.source.writes().sessions, '刷新不得重发创建').toBe(attemptsAfterLoss);

    await page.getByRole('button', { name: '核对并继续原提交' }).click();
    await expect(page.getByText('状态：执行中')).toBeVisible({ timeout: 20_000 });
    expect(personalUi.source.uniqueWrites().sessions, '恢复后仍只有一个会话').toBe(1);
    expect(personalUi.source.uniqueWrites().messages, '恢复后仍只有一条原消息').toBe(1);
  });

  test('PUI-006b @p1 消息回复丢失后恢复同一任务与运行', async ({ page, personalUi }) => {
    personalUi.source.failNext({ method: 'POST', path: /^\/api\/v2\/sessions\/[^/]+\/messages$/ }, { dropAfterHandling: true });
    await gotoTasks(page, personalUi.url);
    const taskId = await createTaskViaUi(page, 'PUI-006b 消息回复丢失').catch(async () => {
      // createTaskViaUi 已跳转到详情；若等待 URL 失败，仍从当前 URL 取 taskId。
      return page.url().split('/tasks/')[1]!.split(/[?#]/)[0]!;
    });
    await expect(page.getByRole('button',{name:'核对并继续原提交',exact:true})).toBeVisible({timeout:20000});
    expect((await taskDetail(page,taskId)).accepted).toBe(false);
    expect(personalUi.source.uniqueWrites().messages).toBe(1);

    await page.getByRole('button', { name: '核对并继续原提交' }).click();
    await expect(page.getByText('状态：执行中')).toBeVisible({ timeout: 20_000 });
    const detail = await taskDetail(page, taskId);
    expect(detail.runId).toBeTruthy();
    expect(personalUi.source.uniqueWrites().messages).toBe(1);
  });
});
