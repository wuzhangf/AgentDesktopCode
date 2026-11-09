/**
 * DET — Worker detail: tabs, layered health, manual probe, capability-driven
 * action bar, :key switching without state bleed, DRAINING latch.
 */
import { test, expect } from '../fixtures/console';
import {
  healthBaseOf, seedExternal, seedManaged, setStub, startHealthStub, startManagedViaApi,
  type HealthStub,
} from '../fixtures/seed';

let stub: HealthStub | null = null;
test.afterEach(async () => {
  await stub?.close();
  stub = null;
});

test.describe('Worker 详情与健康', () => {
  test('E2E-UI-030 tab 切换与内容渲染', async ({ page, console }) => {
    seedManaged(console.handle.store, 'm-one');
    await page.goto(`${console.url}/#/manage/workers/m-one`);
    await expect(page.getByRole('heading', { name: 'm-one', level: 1 })).toBeVisible();

    const tabs = ['概况', '健康', '任务', '配置', '日志与维护'];
    for (const label of tabs) {
      const tab = page.getByRole('tab', { name: label });
      await tab.click();
      await expect(tab).toHaveAttribute('aria-selected', 'true');
      await expect(page.getByRole('tab', { selected: true })).toHaveCount(1);
    }

    await page.getByRole('tab', { name: '概况' }).click();
    await expect(page.getByText('进程归属')).toBeVisible();

    await page.getByRole('tab', { name: '健康' }).click();
    for (const layer of ['HOST', 'DAEMON', 'ENGINE', 'TOOLCHAIN']) {
      await expect(page.getByTestId(`health-layer-${layer}`)).toBeVisible();
    }

    await page.getByRole('tab', { name: '任务' }).click();
    await expect(page.getByText('任务执行记录')).toBeVisible();

    await page.getByRole('tab', { name: '配置' }).click();
    await expect(page.getByText('有效配置')).toBeVisible();
    await expect(page.getByText('已脱敏 — 密钥不会出现在此处')).toBeVisible();
  });

  test('E2E-UI-031 分层健康四层齐全且未观测层不伪造', async ({ page, console }) => {
    stub = await startHealthStub();
    seedExternal(console.handle.store, 'e-one', { healthUrl: stub.url });

    await page.goto(`${console.url}/#/manage/workers/e-one`);
    await page.getByRole('button', { name: '检查连接' }).click();
    await page.getByRole('tab', { name: '健康' }).click();

    await expect(page.getByTestId('health-layer-HOST')).toHaveAttribute('data-layer-state', 'OK');
    await expect(page.getByTestId('health-layer-DAEMON')).toHaveAttribute('data-layer-state', 'OK');
    await expect(page.getByTestId('health-layer-ENGINE')).toBeVisible();
    await expect(page.getByTestId('health-layer-TOOLCHAIN')).toHaveAttribute('data-layer-state', 'UNKNOWN');
    await expect(page.getByTestId('health-layer-TOOLCHAIN')).toContainText('未采集');
  });

  test('E2E-UI-032 手动探测跟随真实状态翻转', async ({ page, console, request }) => {
    stub = await startHealthStub();
    seedExternal(console.handle.store, 'e-one', { healthUrl: stub.url });

    let probes = 0;
    page.on('request', (r) => {
      if (r.method() === 'POST' && /\/api\/manage\/workers\/[^/]+\/check$/.test(r.url())) probes++;
    });

    await page.goto(`${console.url}/#/manage/workers/e-one`);
    await page.getByRole('tab', { name: '健康' }).click();
    await expect(page.getByTestId('health-layer-DAEMON')).toHaveAttribute('data-layer-state', 'OK');

    stub.set({ ready: false });
    await page.getByRole('button', { name: '检查连接' }).click();
    await expect(page.getByTestId('health-layer-DAEMON')).toHaveAttribute('data-layer-state', 'DEGRADED');
    await expect(page.getByText(/观测时间/)).toBeVisible();

    stub.set({ ready: true });
    await page.getByRole('button', { name: '检查连接' }).click();
    await expect(page.getByTestId('health-layer-DAEMON')).toHaveAttribute('data-layer-state', 'OK');
    expect(probes, '两次手动探测都应真的打到后端').toBe(2);

    // The API agrees with what the page showed.
    const detail = await (await request.get(`${console.url}/api/manage/workers/e-one`)).json();
    expect(detail.daemonReady).toBe(true);
  });

  test('E2E-UI-033 受管 Worker 能力按钮齐全且可用', async ({ page, console }) => {
    seedManaged(console.handle.store, 'm-one');
    await page.goto(`${console.url}/#/manage/workers/m-one`);

    for (const label of ['启动', '停止', '重启', '停止接单', '检查连接']) {
      await expect(page.getByRole('button', { name: label, exact: true })).toBeEnabled();
    }
    // 导出诊断包 lives in the journal/maintenance tab card.
    await expect(page.getByRole('button', { name: '导出诊断包' })).toHaveCount(0);
    await page.getByRole('tab', { name: '日志与维护' }).click();
    await expect(page.getByRole('button', { name: '导出诊断包' })).toBeEnabled();
  });

  test('E2E-UI-034 外部 Worker 无生命周期能力且后端拒绝', async ({ page, console, request }) => {
    stub = await startHealthStub();
    seedExternal(console.handle.store, 'e-one', { healthUrl: stub.url });

    await page.goto(`${console.url}/#/manage/workers/e-one`);
    for (const label of ['启动', '停止', '重启', '停止接单']) {
      await expect(page.getByRole('button', { name: label, exact: true })).toHaveCount(0);
    }
    await expect(page.getByRole('status')).toContainText('外部连接实例');
    await expect(page.getByRole('button', { name: '检查连接' })).toBeVisible();

    const res = await request.post(`${console.url}/api/manage/workers/e-one/operations`, {
      headers: { 'x-manage-control': '1', 'content-type': 'application/json' },
      data: { operationId: 'op-ext-stop', kind: 'STOP' },
    });
    expect(res.status()).toBe(409);
    expect((await res.json()).code).toBe('NOT_MANAGED');
  });

  test('E2E-UI-035 :key 切换不残留上一台 Worker 的状态', async ({ page, console }) => {
    const store = console.handle.store;
    seedManaged(store, 'a-down');
    stub = await startHealthStub();
    seedExternal(store, 'b-up', { healthUrl: stub.url });

    await page.goto(`${console.url}/#/manage/workers/a-down`);
    await expect(page.getByRole('heading', { name: 'a-down', level: 1 })).toBeVisible();
    await page.getByRole('button', { name: '检查连接' }).click();
    await page.getByRole('tab', { name: '健康' }).click();
    await expect(page.getByTestId('health-layer-HOST')).toHaveAttribute('data-layer-state', 'UNKNOWN');

    // Same-route navigation to another worker must reset local state.
    await page.getByRole('navigation', { name: '主导航' }).getByRole('link', { name: '我的 Workers' }).click();
    await page.getByTestId('worker-card').filter({ hasText: 'b-up' }).click();

    await expect(page).toHaveURL(/#\/manage\/workers\/b-up$/);
    await expect(page.getByRole('heading', { name: 'b-up', level: 1 })).toBeVisible();
    await page.getByRole('tab', { name: '健康' }).click();
    await expect(page.getByTestId('health-layer-HOST')).toHaveAttribute('data-layer-state', 'OK');
    await expect(page.getByTestId('worker-gate-badge')).toHaveAttribute('data-accepting', 'YES');
    await expect(page.getByText('尚未启动')).toHaveCount(0);
  });

  test('E2E-UI-036 DRAINING 锁存如实提示且不假装可逆', async ({ page, console, request }) => {
    seedManaged(console.handle.store, 'm-drain');
    const started = await startManagedViaApi(request, console.url, 'm-drain');
    expect(started.state).toBe('SUCCEEDED');
    await setStub(request, healthBaseOf(console.handle.store, 'm-drain'), { draining: true });

    await page.goto(`${console.url}/#/manage/workers/m-drain`);
    await expect(page.getByTestId('worker-gate-badge')).toHaveAttribute('data-accepting', 'NO_DRAINING');
    await expect(page.getByTestId('worker-gate-badge')).toContainText('DRAINING');
    await expect(page.getByText('daemon 已锁存 DRAINING，恢复接单需要重启进程。')).toBeVisible();
  });
});
