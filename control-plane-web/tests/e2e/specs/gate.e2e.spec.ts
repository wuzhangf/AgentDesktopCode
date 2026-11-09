/**
 * GATE — install-gate admission control (reversible) vs daemon DRAINING (latched).
 */
import { test, expect } from '../fixtures/console';
import {
  healthBaseOf, seedManaged, startManagedViaApi, writeBrokenGate, submitOpViaApi, waitOp, opId,
} from '../fixtures/seed';
import type { ManagedConfig } from '../../../server/management/store';

test.describe('接单开关', () => {
  test('E2E-UI-050 停止接单写入 gate 并被 daemon 观测', async ({ page, console, request }) => {
    seedManaged(console.handle.store, 'm-one');
    await startManagedViaApi(request, console.url, 'm-one');
    const base = healthBaseOf(console.handle.store, 'm-one');
    expect((await (await request.get(`${base}/__ctl`)).json()).installGate).toBe('disarmed');

    await page.goto(`${console.url}/#/manage/workers/m-one`);
    await expect(page.getByTestId('worker-gate-badge')).toHaveAttribute('data-accepting', 'YES');

    await page.getByRole('button', { name: '停止接单' }).click();
    await expect(page.getByTestId('op-receipt')).toHaveAttribute('data-op-state', 'SUCCEEDED');
    await expect(page.getByTestId('worker-gate-badge')).toHaveAttribute('data-accepting', 'NO_GATE');
    await expect(page.getByTestId('worker-gate-badge')).toContainText('已停止接单');

    // The daemon (stub) re-reads the gate file on every readyz.
    expect((await (await request.get(`${base}/__ctl`)).json()).installGate).toBe('ARMED');
  });

  test('E2E-UI-051 恢复接单可逆', async ({ page, console, request }) => {
    seedManaged(console.handle.store, 'm-one');
    await startManagedViaApi(request, console.url, 'm-one');
    const base = healthBaseOf(console.handle.store, 'm-one');
    const armed = await submitOpViaApi(request, console.url, 'm-one', 'GATE_ARM', opId('arm'));
    expect(armed.status).toBe(201);
    expect((await waitOp(request, console.url, armed.json.operationId)).state).toBe('SUCCEEDED');

    await page.goto(`${console.url}/#/manage/workers/m-one`);
    await expect(page.getByTestId('worker-gate-badge')).toHaveAttribute('data-accepting', 'NO_GATE');

    await page.getByRole('button', { name: '恢复接单' }).click();
    await expect(page.getByTestId('op-receipt')).toHaveAttribute('data-op-state', 'SUCCEEDED');
    await expect(page.getByTestId('worker-gate-badge')).toHaveAttribute('data-accepting', 'YES');
    expect((await (await request.get(`${base}/__ctl`)).json()).installGate).toBe('disarmed');
  });

  test('E2E-UI-052 gate 文件不可读时显示关闭而非开放（回归）', async ({ page, console, request }) => {
    seedManaged(console.handle.store, 'm-one');
    await startManagedViaApi(request, console.url, 'm-one');
    const cfg = console.handle.store.getWorker('m-one')!.config as ManagedConfig;
    const base = healthBaseOf(console.handle.store, 'm-one');

    writeBrokenGate(cfg.dirs.state);
    expect((await (await request.get(`${base}/__ctl`)).json()).installGate).toBe('UNREADABLE');

    await page.goto(`${console.url}/#/manage/workers/m-one`);
    await page.getByRole('button', { name: '检查连接' }).click();

    // Fail-closed: never advertise "open" for an unreadable gate.
    await expect(page.getByTestId('worker-gate-badge')).toHaveAttribute('data-accepting', 'NO_GATE');
    await expect(page.getByTestId('worker-gate-badge')).toContainText('已停止接单');
    await expect(page.getByTestId('worker-gate-badge')).not.toContainText('接单中');

    const detail = await (await request.get(`${console.url}/api/manage/workers/m-one`)).json();
    expect(detail.installGate).toBe('UNREADABLE');
    expect(detail.acceptingTasks).toBe('NO_GATE');
  });
});
