/**
 * REG — 接入 Worker drawer: external attach, managed install, validation and
 * the ?register=1 deep-link / default-provider regressions.
 */
import { test, expect } from '../fixtures/console';
import { registerViaApi, startHealthStub, type HealthStub } from '../fixtures/seed';

let stub: HealthStub | null = null;
test.afterEach(async () => {
  await stub?.close();
  stub = null;
});

const openWorkers = async (page: import('@playwright/test').Page, console: {url: string}) => {
  await page.goto(`${console.url}/#/manage/workers`);
  await expect(page.getByRole('heading', { name: '我的 Workers' })).toBeVisible();
};

test.describe('接入 Worker', () => {
  test('E2E-UI-010 打开与关闭接入抽屉', async ({ page, console }) => {
    await openWorkers(page, console);
    await page.getByRole('button', { name: '接入 Worker' }).click();
    const dialog = page.getByRole('dialog', { name: '接入 Worker' });
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAttribute('aria-modal', 'true');

    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();

    await page.getByRole('button', { name: '接入 Worker' }).click();
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: '关闭' }).click();
    await expect(dialog).toBeHidden();
  });

  test('E2E-UI-011 登记外部 Worker 成功并显示连接结果', async ({ page, console }) => {
    stub = await startHealthStub();
    await openWorkers(page, console);
    await page.getByRole('button', { name: '接入 Worker' }).click();
    const dialog = page.getByRole('dialog', { name: '接入 Worker' });

    await dialog.getByLabel('连接已有 Worker').check();
    await dialog.getByLabel('名称').fill('外部示例');
    await dialog.getByLabel(/healthUrl/).fill(stub.url);
    await dialog.getByRole('button', { name: '登记并检查连接' }).click();

    // workerKey is derived from the ASCII-safe part of the name ('外部示例' → 'worker').
    await expect(page).toHaveURL(/#\/manage\/workers\/[a-z0-9][\w.-]*$/);
    await expect(page.getByRole('heading', { name: '外部示例', level: 1 })).toBeVisible();
    await expect(page.getByText('外部', { exact: true }).first()).toBeVisible();

    // The detail visit probed the daemon; the list must show that real result.
    await page.goto(`${console.url}/#/manage/workers`);
    const row = page.getByTestId('worker-card').filter({ hasText: '外部示例' });
    await expect(row).toBeVisible();
    await expect(page.getByRole('row', { name: /外部示例/ })).toContainText('正常');
  });

  test('E2E-UI-012 非 loopback healthUrl 被后端拒绝并展示错误码', async ({ page, console }) => {
    await openWorkers(page, console);
    await page.getByRole('button', { name: '接入 Worker' }).click();
    const dialog = page.getByRole('dialog', { name: '接入 Worker' });

    await dialog.getByLabel('连接已有 Worker').check();
    await dialog.getByLabel('名称').fill('远程示例');
    await dialog.getByLabel(/healthUrl/).fill('http://8.8.8.8:1');
    await dialog.getByRole('button', { name: '登记并检查连接' }).click();

    const banner = dialog.getByRole('status');
    await expect(banner).toContainText('loopback');
    await expect(banner).toContainText('INVALID_REQUEST');
    await expect(dialog).toBeVisible();     // stays open, nothing registered
  });

  test('E2E-UI-013 登记受管 Worker 并进入详情', async ({ page, console }) => {
    await openWorkers(page, console);
    await page.getByRole('button', { name: '接入 Worker' }).click();
    const dialog = page.getByRole('dialog', { name: '接入 Worker' });

    await dialog.getByLabel('名称').fill('受管示例');
    // workerId is seeded on the open edge; the provider follows settings.defaultProvider.
    await expect(dialog.getByLabel(/workerId/)).not.toHaveValue('');
    await expect(dialog.getByLabel(/provider/)).toHaveValue('fixture');
    await dialog.getByRole('button', { name: '登记并检查连接' }).click();

    await expect(page).toHaveURL(/#\/manage\/workers\/[a-z0-9][\w.-]*$/);
    await expect(page.getByRole('heading', { name: '受管示例', level: 1 })).toBeVisible();
    await expect(page.getByRole('button', { name: '启动' })).toBeVisible();
    await expect(page.getByText('受管', { exact: true }).first()).toBeVisible();

    await page.getByRole('tab', { name: '概况' }).click();
    const ownership = page.locator('section').filter({ hasText: '进程归属' }).first();
    await expect(ownership).toContainText('未采集');   // pid unknown, never faked
  });

  test('E2E-UI-014 ?register=1 深链只消费一次', async ({ page, console }) => {
    await page.goto(`${console.url}/#/manage/workers?register=1`);
    const dialog = page.getByRole('dialog', { name: '接入 Worker' });
    await expect(dialog).toBeVisible();
    await expect(page).not.toHaveURL(/register=1/);   // param consumed

    await dialog.getByRole('button', { name: '关闭' }).click();
    await expect(dialog).toBeHidden();

    await page.getByRole('navigation', { name: '主导航' }).getByRole('link', { name: '总览' }).click();
    await page.getByRole('navigation', { name: '主导航' }).getByRole('link', { name: '我的 Workers' }).click();
    await expect(page.getByRole('heading', { name: '我的 Workers' })).toBeVisible();
    await expect(dialog).toBeHidden();                // does not reopen
  });

  test('E2E-UI-015 抽屉 provider 采用 settings.defaultProvider', async ({ page, console, request }) => {
    const put = await request.put(`${console.url}/api/manage/settings`, {
      headers: { 'x-manage-control': '1', 'content-type': 'application/json' },
      data: { releaseRoot: null, defaultProvider: 'agentcode', acsConnections: [], obsApiUrl: null },
    });
    expect(put.status()).toBe(200);

    await openWorkers(page, console);
    await page.getByRole('button', { name: '接入 Worker' }).click();
    const dialog = page.getByRole('dialog', { name: '接入 Worker' });
    await expect(dialog.getByLabel(/provider/)).toHaveValue('agentcode');
  });

  test('E2E-UI-016 晚到的 settings 不覆盖已输入的 workerId', async ({ page, console }) => {
    let release: (() => void) | null = null;
    const gate = new Promise<void>((r) => { release = r; });
    await page.route('**/api/manage/settings', async (route) => {
      await gate;
      await route.continue();
    });

    await openWorkers(page, console);
    await page.getByRole('button', { name: '接入 Worker' }).click();
    const dialog = page.getByRole('dialog', { name: '接入 Worker' });
    const workerId = dialog.getByLabel(/workerId/);
    await workerId.fill('user-typed-id');

    release!();
    await expect(dialog.getByLabel(/provider/)).toHaveValue('fixture');   // settings landed
    await expect(workerId).toHaveValue('user-typed-id');                  // user value kept
  });

  test('E2E-UI-017 同名登记派生 workerKey 而非覆盖', async ({ request, console }) => {
    const body = { kind: 'EXTERNAL', name: 'dup', healthUrl: 'http://127.0.0.1:9' };
    const first = await registerViaApi(request, console.url, body);
    const second = await registerViaApi(request, console.url, body);
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(first.json.workerKey).toBe('dup');
    expect(second.json.workerKey).toBe('dup-2');

    const list = await (await request.get(`${console.url}/api/manage/workers`)).json();
    expect(list.map((w: any) => w.workerKey).sort()).toEqual(['dup', 'dup-2']);
  });
});
