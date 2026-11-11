/**
 * OVW — 总览: deterministic attention items, honest empty state, live attempt links.
 */
import { test, expect } from '../fixtures/console';
import { seedManaged, setLastHealth } from '../fixtures/seed';

test.describe('总览', () => {
  test('E2E-UI-090 注意力条目按确定性规则生成并可跳转', async ({ page, console }) => {
    const store = console.handle.store;
    seedManaged(store, 'm-down');
    seedManaged(store, 'm-gate');
    seedManaged(store, 'm-drain');

    setLastHealth(store, 'm-down', {
      connection: 'DOWN', daemonReady: false, installGate: 'DISARMED', acceptingTasks: 'UNKNOWN',
    });
    setLastHealth(store, 'm-gate', {
      connection: 'OK', daemonReady: true, installGate: 'ARMED', acceptingTasks: 'NO_GATE',
    });
    setLastHealth(store, 'm-drain', {
      connection: 'OK', daemonReady: true, draining: true, installGate: 'DISARMED',
      acceptingTasks: 'NO_DRAINING',
    });

    await page.goto(`${console.url}/#/manage`);
    await expect(page.getByRole('heading', { name: '总览', level: 1 })).toBeVisible();

    const items = page.getByTestId('attention-item');
    await expect(items.filter({ hasText: '现已不可达' })).toHaveCount(1);
    await expect(items.filter({ hasText: 'install gate ARMED' })).toHaveCount(1);
    await expect(items.filter({ hasText: 'draining' })).toHaveCount(1);

    // Severity is carried on the item, not inferred from colour.
    await expect(items.filter({ hasText: '现已不可达' })).toHaveAttribute('data-severity', 'ACTION');
    await expect(items.filter({ hasText: 'install gate ARMED' })).toHaveAttribute('data-severity', 'WARN');

    await items.filter({ hasText: 'install gate ARMED' }).click();
    await expect(page).toHaveURL(/#\/manage\/workers\/m-gate$/);
    await expect(page.getByRole('heading', { name: 'm-gate', level: 1 })).toBeVisible();
  });

  test('E2E-UI-091 空态不编造数据', async ({ page, console }) => {
    await page.goto(`${console.url}/#/manage`);
    await expect(page.getByText('暂无待处理事项')).toBeVisible();
    await expect(page.getByText('尚未接入 Worker')).toBeVisible();
    await expect(page.getByText('当前没有进行中的任务')).toBeVisible();
    await expect(page.getByText('暂无操作记录')).toBeVisible();
    await expect(page.getByTestId('attention-item')).toHaveCount(0);
  });

  test('E2E-UI-092 进行中的工作使用真实路由链接（回归）', async ({ page, console }) => {
    const store = console.handle.store;
    seedManaged(store, 'm-live');
    setLastHealth(store, 'm-live', {
      connection: 'OK', daemonReady: true, activeAttemptId: 'att-live-1',
      installGate: 'DISARMED', acceptingTasks: 'YES',
    });

    await page.goto(`${console.url}/#/manage`);
    const link = page.getByRole('link', { name: 'm-live' }).first();
    await expect(link).toHaveAttribute('href', '#/manage/workers/m-live');
    await expect(page.getByRole('table').getByText('att-live-1')).toBeVisible();
  });
});
