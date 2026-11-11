/**
 * OPS — managed lifecycle through the UI: START / STOP / RESTART, busy gating,
 * readyz verification, receipt-fetch failure and double-submit dedupe.
 */
import { test, expect } from '../fixtures/console';
import { seedManaged, startManagedViaApi } from '../fixtures/seed';

const OPS_POST = '**/api/manage/workers/*/operations';

test.describe('生命周期操作', () => {
  test('E2E-UI-040 START 全链路：回执 → 进程归属 → 接单', async ({ page, console }) => {
    seedManaged(console.handle.store, 'm-one');
    await page.goto(`${console.url}/#/manage/workers/m-one`);

    await page.getByRole('button', { name: '启动' }).click();
    const receipt = page.getByTestId('op-receipt');
    await expect(receipt).toBeVisible();
    await expect(receipt).toHaveAttribute('data-op-state', 'SUCCEEDED');

    // Steps are inspectable and expanding them must not trigger row selection.
    await receipt.getByText(/步$/).first().click();
    await expect(receipt.locator('ol li').first()).toBeVisible();
    await expect(page).toHaveURL(/#\/manage\/workers\/m-one$/);

    await page.getByRole('tab', { name: '概况' }).click();
    await expect(page.locator('section').filter({ hasText: '进程归属' }).first()).toContainText(/pid \d+/);
    await expect(page.getByTestId('worker-gate-badge')).toHaveAttribute('data-accepting', 'YES');
  });

  test('E2E-UI-041 STOP 确认双分支', async ({ page, console, request }) => {
    seedManaged(console.handle.store, 'm-one');
    await startManagedViaApi(request, console.url, 'm-one');

    let posts = 0;
    await page.route(OPS_POST, async (route) => { posts++; await route.continue(); });
    await page.goto(`${console.url}/#/manage/workers/m-one`);

    // (a) dismiss → nothing is sent
    page.once('dialog', (d) => d.dismiss());
    await page.getByRole('button', { name: '停止', exact: true }).click();
    await expect.poll(() => posts, { message: '取消确认后不应发出请求' }).toBe(0);

    // (b) accept → real op, process gone, connection honestly UNKNOWN
    page.once('dialog', (d) => d.accept());
    await page.getByRole('button', { name: '停止', exact: true }).click();
    await expect(page.getByTestId('op-receipt')).toHaveAttribute('data-op-state', 'SUCCEEDED');
    expect(posts).toBe(1);

    await page.getByRole('tab', { name: '概况' }).click();
    await expect(page.locator('section').filter({ hasText: '进程归属' }).first()).toContainText('未采集');
    await expect(page.getByTestId('worker-gate-badge')).toHaveAttribute('data-accepting', 'UNKNOWN');
  });

  test('E2E-UI-042 RESTART 换新进程与新 instanceId', async ({ page, console, request }) => {
    seedManaged(console.handle.store, 'm-one');
    await startManagedViaApi(request, console.url, 'm-one');
    const before = await (await request.get(`${console.url}/api/manage/workers/m-one`)).json();
    expect(before.instanceId).toBeTruthy();

    page.once('dialog', (d) => d.accept());
    await page.goto(`${console.url}/#/manage/workers/m-one`);
    await page.getByRole('button', { name: '重启' }).click();
    await expect(page.getByTestId('op-receipt')).toHaveAttribute('data-op-state', 'SUCCEEDED');

    const after = await (await request.get(`${console.url}/api/manage/workers/m-one`)).json();
    expect(after.instanceId).toBeTruthy();
    expect(after.instanceId).not.toBe(before.instanceId);
    expect(after.ownership.pid).not.toBe(before.ownership.pid);
  });

  test('E2E-UI-043 操作进行中按钮全部禁用，终态后解锁', async ({ page, console }) => {
    seedManaged(console.handle.store, 'm-one');
    let release: (() => void) | null = null;
    const gate = new Promise<void>((r) => { release = r; });
    await page.route(OPS_POST, async (route) => { await gate; await route.continue(); });

    await page.goto(`${console.url}/#/manage/workers/m-one`);
    await page.getByRole('button', { name: '启动' }).click();

    for (const label of ['启动', '停止', '重启', '停止接单']) {
      await expect(page.getByRole('button', { name: label, exact: true })).toBeDisabled();
    }

    release!();
    await expect(page.getByTestId('op-receipt')).toHaveAttribute('data-op-state', 'SUCCEEDED');
    await expect(page.getByRole('button', { name: '停止', exact: true })).toBeEnabled();
  });

  test('E2E-UI-045 回执查询失败时解锁并停止轮询（回归）', async ({ page, console, request }) => {
    seedManaged(console.handle.store, 'm-one');
    await startManagedViaApi(request, console.url, 'm-one');

    let gets = 0;
    await page.route('**/api/manage/operations/*', async (route) => {
      gets++;
      if (gets <= 2) { await route.abort('failed'); return; }   // first try + retry
      await route.continue();
    });

    page.once('dialog', (d) => d.accept());
    await page.goto(`${console.url}/#/manage/workers/m-one`);
    await page.getByRole('button', { name: '停止', exact: true }).click();

    await expect(page.getByText(/操作回执拉取失败/)).toBeVisible();
    await expect(page.getByRole('button', { name: '停止', exact: true })).toBeEnabled();
    const settled = gets;
    // Polling must not keep hammering a dead receipt.
    await expect.poll(async () => { await page.waitForTimeout(1_500); return gets; }).toBe(settled);
  });

  test('E2E-UI-046 操作记录与 API 一致', async ({ page, console, request }) => {
    seedManaged(console.handle.store, 'm-one');
    const op = await startManagedViaApi(request, console.url, 'm-one');

    await page.goto(`${console.url}/#/manage/workers/m-one`);
    await expect(page.getByRole('row', { name: /启动/ }).first()).toContainText('成功');

    const api = await (await request.get(`${console.url}/api/manage/operations/${op.operationId}`)).json();
    expect(api.state).toBe('SUCCEEDED');
    const list = await (await request.get(`${console.url}/api/manage/operations?workerKey=m-one`)).json();
    expect(list.map((o: any) => o.operationId)).toContain(op.operationId);
  });

  test('E2E-UI-047 双击提交只产生一个操作（回归）', async ({ page, console, request }) => {
    seedManaged(console.handle.store, 'm-one');
    let posts = 0;
    await page.route(OPS_POST, async (route) => { posts++; await route.continue(); });

    await page.goto(`${console.url}/#/manage/workers/m-one`);
    await page.getByRole('button', { name: '启动' }).dblclick();
    await expect(page.getByTestId('op-receipt')).toHaveAttribute('data-op-state', 'SUCCEEDED');
    expect(posts, '双击只应发出一次操作请求').toBe(1);

    const list = await (await request.get(`${console.url}/api/manage/operations?workerKey=m-one`)).json();
    expect(list).toHaveLength(1);
  });
});

/**
 * Separate block: this stub never reports ready, so START must end in
 * VERIFY_FAILED — and the shorter ready budget keeps the test fast.
 */
test.describe('readyz 未就绪', () => {
  test.use({ consoleOptions: { stubEnv: { STUB_READY: '0' }, deps: { readyBudgetMs: 2_500 } } });

  test('E2E-UI-044 readyz 未就绪 → VERIFY_FAILED 且不谎报成功', async ({ page, console }) => {
    seedManaged(console.handle.store, 'm-slow');
    await page.goto(`${console.url}/#/manage/workers/m-slow`);
    await page.getByRole('button', { name: '启动' }).click();

    const receipt = page.getByTestId('op-receipt');
    await expect(receipt).toHaveAttribute('data-op-state', 'VERIFY_FAILED');
    await expect(receipt).toContainText('NOT_READY');
    await expect(receipt).toContainText('校验未通过');
    await expect(page.getByRole('button', { name: '启动', exact: true })).toBeEnabled();
  });
});
