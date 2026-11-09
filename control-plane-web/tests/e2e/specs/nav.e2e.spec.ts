/**
 * NAV — shell, routing and the analytics isolation boundary.
 * Every console URL is a hash route: `http://host/#/manage/...`.
 */
import { test, expect } from '../fixtures/console';

test.describe('导航与外壳', () => {
  test('E2E-UI-001 首屏重定向到总览', async ({ page, console }) => {
    await page.goto(console.url);
    await expect(page).toHaveURL(/#\/manage$/);
    await expect(page.getByRole('heading', { name: '总览' })).toBeVisible();

    const nav = page.getByRole('navigation', { name: '主导航' });
    await expect(nav.getByRole('link')).toHaveCount(7);
    for (const label of ['总览', '我的 Workers', '任务', '项目', '用量', '设置', '测试实验室']) {
      await expect(nav.getByRole('link', { name: label })).toBeVisible();
    }
  });

  test('E2E-UI-002 侧栏导航切换页面与 active 态', async ({ page, console }) => {
    await page.goto(`${console.url}/#/manage`);
    const nav = page.getByRole('navigation', { name: '主导航' });

    const cases = [
      { label: '我的 Workers', hash: /#\/manage\/workers$/, heading: '我的 Workers' },
      { label: '任务', hash: /#\/manage\/tasks$/, heading: '任务执行记录（只读）' },
      { label: '项目', hash: /#\/manage\/projects$/, heading: '项目' },
      { label: '用量', hash: /#\/manage\/usage$/, heading: '用量' },
      { label: '设置', hash: /#\/manage\/settings$/, heading: '设置' },
      { label: '测试实验室', hash: /#\/manage\/lab$/, heading: '测试实验室' },
      { label: '总览', hash: /#\/manage$/, heading: '总览' },
    ];
    for (const c of cases) {
      const link = nav.getByRole('link', { name: c.label });
      await link.click();
      await expect(page).toHaveURL(c.hash);
      await expect(page.getByRole('heading', { name: c.heading, level: 1 })).toBeVisible();
      await expect(link).toHaveClass(/active/);
    }
  });

  test('E2E-UI-003 旧 analytics 裸路径重写到 /analysis/*', async ({ page, console }) => {
    await page.goto(`${console.url}/#/models?callId=abc`);
    await expect(page).toHaveURL(/#\/analysis\/models\?callId=abc/);
    await expect(page).not.toHaveURL(/#\/manage/);

    // A bare unknown path is NOT an analytics root → console overview.
    await page.goto(`${console.url}/#/bogus`);
    await expect(page).toHaveURL(/#\/manage$/);
  });

  test('E2E-UI-004 管理页不产生 /api/v2 流量（回归）', async ({ page, console }) => {
    const seen: string[] = [];
    await page.route('**/api/v2/**', async (route) => {
      seen.push(route.request().url());
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    });

    await page.goto(`${console.url}/#/manage`);
    await expect(page.getByRole('heading', { name: '总览' })).toBeVisible();
    await page.goto(`${console.url}/#/manage/workers`);
    await expect(page.getByRole('heading', { name: '我的 Workers' })).toBeVisible();
    expect(seen, `管理页不应请求观测 API：${seen.join(', ')}`).toHaveLength(0);

    // The analytics shell still talks to it — the isolation is scoped, not global.
    await page.goto(`${console.url}/#/analysis/overview`);
    await expect.poll(() => seen.length, { message: '分析页应请求 /api/v2/meta/sources' }).toBeGreaterThan(0);
  });

  test('E2E-UI-005 未知 manage 路径兜底到总览', async ({ page, console }) => {
    for (const bad of ['#/manage/nope', '#/manage/workers/a/b/c']) {
      await page.goto(`${console.url}/${bad}`);
      await expect(page).toHaveURL(/#\/manage$/);
      await expect(page.getByRole('heading', { name: '总览' })).toBeVisible();
    }
  });

  test('E2E-UI-006 不存在的 workerKey 显示错误而非空白', async ({ page, console }) => {
    await page.goto(`${console.url}/#/manage/workers/ghost`);
    await expect(page.getByRole('status')).toContainText('未知 worker');
    await expect(page.getByRole('status')).toContainText('NOT_FOUND');
  });
});
