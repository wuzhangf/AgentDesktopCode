import { test, expect } from '../fixtures/personal-ui';
import {
  PROJECT_NAME, createTaskViaUi, gotoTasks, personalApi, taskDetail,
} from '../fixtures/assertions';

/**
 * PUI-001/002/007/008 — 个人入口、空/不可达、服务端列表发现与分页、任务切换。
 */
test.describe('个人入口与列表', () => {
  test('PUI-001 @p0 个人入口与旧管理链接跳转', async ({ page, personalUi }) => {
    await gotoTasks(page, personalUi.url);

    // 旧链接：/manage/tasks、projects、usage 都切到当前 personal 目标。
    await page.goto(`${personalUi.url}/index.html#/manage/tasks`);
    await page.waitForURL(/#\/tasks$/, { timeout: 20_000 });
    await expect(page.getByRole('heading', { name: '任务', exact: true })).toBeVisible();

    await page.goto(`${personalUi.url}/index.html#/manage/projects`);
    await page.waitForURL(/#\/projects$/, { timeout: 20_000 });
    await expect(page.getByRole('heading', { name: '项目', exact: true })).toBeVisible();

    await page.goto(`${personalUi.url}/index.html#/manage/usage`);
    await page.waitForURL(/#\/tasks$/, { timeout: 20_000 });

    // Worker 管理外链仍指原管理面，不被个人页吞掉。
    const workerLink = page.getByRole('link', { name: /Worker 管理/ });
    await expect(workerLink).toHaveAttribute('href', /index\.html#\/manage\/workers$/);
  });

  test.describe('源端没有可用项目', () => {
    test.use({ personalUiOptions: { projects: [] } });

    test('PUI-002 @p0 无项目时不出现可提交的假项目', async ({ page, personalUi }) => {
    await gotoTasks(page, personalUi.url);
    await expect(page.getByText('暂无项目，请在本机项目管理入口登记项目后刷新。')).toBeVisible();
    const start = page.getByRole('button', { name: '开始任务', exact: true });
    await expect(start).toBeDisabled();
    expect(personalUi.source.writes()).toEqual({ sessions: 0, messages: 0, commands: 0 });

    // 源端目录恢复后按真实项目渲染，不需要重启页面。
    personalUi.source.setProjects([{
      projectId: 'source-one', workspaceAlias: 'sample', displayName: PROJECT_NAME,
      branchDisplay: 'main', headShortRevision: 'head1', authorityStatus: 'AUTHORITATIVE',
    }]);
    await page.reload();
    await expect(page.getByLabel('项目', { exact: true }).locator('option', { hasText: PROJECT_NAME }).first()).toBeAttached();
    });
  });

  test('PUI-007 @p0 无本地存储的新 context 仍能从服务端发现原任务', async ({ page, personalUi, browser }) => {
    await gotoTasks(page, personalUi.url);
    const instruction = 'PUI-007 在隔离工作树把 x.txt 从 v1 改为 v2';
    const taskId = await createTaskViaUi(page, instruction);
    const original = await taskDetail(page, taskId);

    const fresh = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN' });
    const freshPage = await fresh.newPage();
    try {
      await gotoTasks(freshPage, personalUi.url);
      await expect(freshPage.getByRole('link', { name: instruction })).toBeVisible({ timeout: 20_000 });
      await freshPage.getByRole('link', { name: instruction }).click();
      await freshPage.waitForURL(new RegExp(`#/tasks/${taskId}$`));
      await expect(freshPage.getByRole('heading', { name: instruction })).toBeVisible();
      // 原绑定不变：sessionId / runId 与首个 context 读到的一致。
      const reread = await taskDetail(freshPage, taskId);
      expect(reread.sessionId).toBe(original.sessionId);
      expect(reread.runId).toBe(original.runId);
    } finally {
      await fresh.close();
    }
  });

  test('PUI-008 @p1 列表分页与任务切换不残留游标', async ({ page, personalUi }) => {
    await gotoTasks(page, personalUi.url);
    const firstTask = await createTaskViaUi(page, 'PUI-008 任务 A');

    // 追加持久列表（超出默认页大小 30）；这是数据准备，不是被测用户动作。
    const seeded: string[] = [];
    for (let i = 0; i < 31; i++) {
      // key 与 body.requestKey 必须是同一个值：分两次取 Date.now() 会跨毫秒。
      const seedKey = `web-launch-seed-${i}-${Date.now()}`;
      const response = await personalApi(page, '/api/personal/v1/tasks', {
        method: 'POST',
        key: seedKey,
        body: {
          requestKey: seedKey,
          projectId: (await taskDetail(page, firstTask)).projectId,
          instruction: `PUI-008 分页种子 ${i}`,
        },
      });
      expect(response.status, JSON.stringify(response.body).slice(0, 300)).toBe(201);
      seeded.push(response.body.data.taskId);
      await page.waitForTimeout(3);
    }

    await gotoTasks(page, personalUi.url);
    const rows = page.locator('a[href*="#/tasks/task-"]');
    await expect(rows).toHaveCount(30);
    await page.getByRole('button', { name: '下一页' }).click();
    await expect(rows).toHaveCount(2);
    await page.getByRole('button', { name: '回到首页' }).click();
    await expect(rows).toHaveCount(30);

    // A 的源端历史超过一页 → 出现「更早」；切到 B 后游标必须重置。
    const aRun = (await taskDetail(page, firstTask)).runId;
    for (let i = 1; i <= 21; i++) {
      personalUi.source.setCommand(`ext:${firstTask}:${String(i).padStart(2, '0')}`, {
        schemaVersion: 'run-command-receipt/1',
        receiptId: `receipt-ext-${i}`,
        runId: aRun,
        intent: 'PAUSE',
        phase: 'APPLIED',
        receiptRevision: String(i),
        acceptedAt: `2026-10-19T00:00:${String(i).padStart(2, '0')}Z`,
        actor: { principalId: 'other-tab', clientSessionId: 'other' },
        acceptedStateVersion: 5,
        observedStateVersion: 5,
        observedRunState: 'PAUSED',
        terminal: true,
      });
    }
    await page.goto(`${personalUi.url}/personal.html#/tasks/${firstTask}`);
    await expect(page.getByRole('button', { name: '更早' })).toBeVisible({ timeout: 20_000 });
    await page.getByRole('button', { name: '更早' }).click();
    await expect(page.getByRole('button', { name: '回到最新' })).toBeVisible();

    await page.goto(`${personalUi.url}/personal.html#/tasks/${seeded[0]}`);
    await expect(page.getByText('运行控制')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole('button', { name: '回到最新' })).toHaveCount(0);
  });
});
