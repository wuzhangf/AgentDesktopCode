/**
 * LST — 我的 Workers list: empty state, grouping/badges, row navigation.
 */
import { test, expect } from '../fixtures/console';
import { seedExternal, seedManaged, startHealthStub, type HealthStub } from '../fixtures/seed';

let stub: HealthStub | null = null;
test.afterEach(async () => {
  await stub?.close();
  stub = null;
});

const check = (request: import('@playwright/test').APIRequestContext, console: {url: string}, key: string) => request.post(
  `${console.url}/api/manage/workers/${encodeURIComponent(key)}/check`,
  { headers: { 'x-manage-control': '1', 'content-type': 'application/json' }, data: {} },
);

test.describe('Worker 列表', () => {
  test('E2E-UI-020 空态不渲染幽灵行', async ({ page, console }) => {
    await page.goto(`${console.url}/#/manage/workers`);
    await expect(page.getByText('尚未接入 Worker')).toBeVisible();
    await expect(page.getByText('安装一个由本机管理的 Worker，或连接一个已在运行的实例。')).toBeVisible();
    await expect(page.getByRole('table')).toHaveCount(0);
  });

  test('E2E-UI-021 分组、类型徽标与连接/接单状态如实', async ({ page, console, request }) => {
    const store = console.handle.store;
    seedManaged(store, 'm-one');
    stub = await startHealthStub();
    seedExternal(store, 'e-one', { healthUrl: stub.url });

    // Probe both through the API: the list shows observed facts, not guesses.
    await check(request, console, 'm-one');
    await check(request, console, 'e-one');

    await page.goto(`${console.url}/#/manage/workers`);
    await expect(page.getByText('本机')).toBeVisible();
    await expect(page.getByText('2 个 Worker')).toBeVisible();

    const managedRow = page.getByRole('row', { name: /m-one/ });
    const externalRow = page.getByRole('row', { name: /e-one/ });
    await expect(managedRow).toContainText('受管');
    await expect(externalRow).toContainText('外部');

    // Managed worker never started: honest UNKNOWN, never a fake green.
    await expect(managedRow.getByTestId('worker-gate-badge')).toHaveAttribute('data-accepting', 'UNKNOWN');
    // External daemon is live, ready and gate-open → accepts tasks.
    await expect(externalRow.getByTestId('worker-gate-badge')).toHaveAttribute('data-accepting', 'YES');
    await expect(externalRow).toContainText('正常');
    await expect(managedRow).toContainText('未知');
  });

  test('E2E-UI-022 行点击进入详情', async ({ page, console }) => {
    stub = await startHealthStub();
    seedExternal(console.handle.store, 'e-one', { healthUrl: stub.url });

    await page.goto(`${console.url}/#/manage/workers`);
    await page.getByTestId('worker-card').filter({ hasText: 'e-one' }).click();
    await expect(page).toHaveURL(/#\/manage\/workers\/e-one$/);
    await expect(page.getByRole('heading', { name: 'e-one', level: 1 })).toBeVisible();
  });
});
