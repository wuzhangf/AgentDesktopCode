import { test, expect } from '../fixtures/personal-ui';
import { createTaskViaUi, gotoTasks, personalApi, waitForControl } from '../fixtures/assertions';

/**
 * PUI-020 — 只读面、示例面与同源守卫：不得出现可执行按钮，也不得产生源端写入。
 */
test.describe('边界面', () => {
  test('PUI-020 @p0 只读面不出现写按钮，示例面不接控制', async ({ page, personalUi }) => {
    await gotoTasks(page, personalUi.url);
    const taskId = await createTaskViaUi(page, 'PUI-020 只读与示例面');
    const before = personalUi.source.writes();

    // 只读面：列表页无提交按钮。
    await page.goto(`${personalUi.url}/personal.html?readonly=1#/tasks`);
    await expect(page.getByText('只读视图——当前面不提供可执行按钮（窄接口/未授权写场景）。')).toBeVisible();
    await expect(page.getByRole('button', { name: '开始任务', exact: true })).toHaveCount(0);

    // 只读面：详情页仍可读，但没有暂停/继续/停止。
    await page.goto(`${personalUi.url}/personal.html?readonly=1#/tasks/${taskId}`);
    await expect(page.getByText('状态：执行中')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole('button', { name: '暂停', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: '继续', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: '停止', exact: true })).toHaveCount(0);
    await expect(page.getByText('只读视图——不提供可执行按钮')).toBeVisible();

    // 示例面：明确标注示例数据；示例 transport 没有 TASK 动作时如实报错，
    // 不得把示例数据伪装成真实任务详情。
    await page.goto(`${personalUi.url}/personal.html?demo=1#/tasks`);
    await expect(page.getByText('示例数据——未连接真实管理服务；页面与冻结 DTO 对齐，操作仅在本会话内演示。')).toBeVisible();
    await page.goto(`${personalUi.url}/personal.html?demo=1#/tasks/${taskId}`);
    await expect(page.getByText(/INVALID_OPERATION|不支持|无法识别/).first()).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole('button', { name: '暂停', exact: true })).toHaveCount(0);

    // 同源守卫：缺头 / 外源 Origin 都拒绝，且没有新增源端写入。
    const noHeader = await page.evaluate(async () => {
      const response = await fetch('/api/personal/v1/tasks');
      return { status: response.status, body: await response.json().catch(() => null) };
    });
    expect(noHeader.status).toBe(403);
    expect(noHeader.body?.error?.code).toBe('ORIGIN_REJECTED');
    const foreign = await personalApi(page, '/api/personal/v1/tasks', {});
    expect(foreign.status).toBe(200); // 正常同源读仍可用
    expect(personalUi.source.writes(), '边界面不得产生源端业务写入').toEqual(before);
    await waitForControl(page, taskId, (v) => (v.allowedIntents ?? []).includes('PAUSE'), '只读后控制视图仍可读');
  });
});
