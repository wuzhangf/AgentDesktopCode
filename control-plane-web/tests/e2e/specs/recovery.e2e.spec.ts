/**
 * REC — console restart: re-adoption of live workers and reconcile of
 * interrupted operations. The worker keeps running across the restart (that is
 * the product behaviour), so the fixture only reopens the BFF.
 */
import { test, expect } from '../fixtures/console';
import { seedManaged, startManagedViaApi } from '../fixtures/seed';

test.describe('控制台重启', () => {
  test('E2E-UI-053 重启后重认领存活 Worker 并可停止', async ({ page, console, request }) => {
    test.setTimeout(90_000);
    seedManaged(console.handle.store, 'm-one');
    await startManagedViaApi(request, console.url, 'm-one');
    const before = await (await request.get(`${console.url}/api/manage/workers/m-one`)).json();
    expect(before.ownership.pid).toBeTruthy();

    await console.restart();

    await page.goto(`${console.url}/#/manage/workers/m-one`);
    await expect(page.getByRole('heading', { name: 'm-one', level: 1 })).toBeVisible();
    await page.getByRole('tab', { name: '概况' }).click();

    const ownership = page.locator('section').filter({ hasText: '进程归属' }).first();
    await expect(ownership).toContainText(/pid \d+/);
    await expect(ownership).toContainText('命令行匹配');
    await expect(ownership).toContainText('命令行已验证');

    // Ownership survives the restart: STOP must still work on the live worker.
    page.once('dialog', (d) => d.accept());
    await page.getByRole('button', { name: '停止', exact: true }).click();
    await expect(page.getByTestId('op-receipt')).toHaveAttribute('data-op-state', 'SUCCEEDED');

    const after = await (await request.get(`${console.url}/api/manage/workers/m-one`)).json();
    expect(after.ownership.pid).toBeNull();
  });

  test('E2E-UI-054 重启时 RUNNING 操作按真实状态收敛（回归）', async ({ page, console, request }) => {
    test.setTimeout(90_000);
    const store = console.handle.store;
    seedManaged(store, 'm-one');
    await startManagedViaApi(request, console.url, 'm-one');

    // Simulate an op that was mid-flight when the console died.
    const now = new Date().toISOString();
    store.createOperation({
      operationId: 'op-interrupted', workerKey: 'm-one', kind: 'START', state: 'RUNNING',
      steps: [{ at: now, message: '开始执行 START' }], error: null, createdAt: now, updatedAt: now,
    });

    await console.restart();

    const op = await (await request.get(`${console.url}/api/manage/operations/op-interrupted`)).json();
    expect(['SUCCEEDED', 'VERIFY_FAILED']).toContain(op.state);
    expect(op.state).toBe('SUCCEEDED');            // the stub really is alive and ready
    expect(op.steps.map((s: any) => s.message).join()).toContain('原操作恢复校验');

    await page.goto(`${console.url}/#/manage/workers/m-one`);
    await expect(page.getByRole('row', { name: /启动/ }).first()).toContainText('成功');
    await expect(page.getByText('执行中')).toHaveCount(0);
  });
});
