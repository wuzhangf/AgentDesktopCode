/**
 * CNF — sanitized config tab + diagnostics export (no secrets, no URL creds).
 */
import { test, expect } from '../fixtures/console';
import { readFileSync } from 'node:fs';
import { seedExternal, seedManaged, startHealthStub, type HealthStub } from '../fixtures/seed';
import type { ManagedConfig } from '../../../server/management/store';

const TOKEN = 'tok-SECRET-abc123';

let stub: HealthStub | null = null;
test.afterEach(async () => {
  await stub?.close();
  stub = null;
});

function managedWithToken(console: any) {
  const store = console.handle.store;
  seedManaged(store, 'm-one');
  const w = store.getWorker('m-one')!;
  const cfg = w.config as ManagedConfig;
  cfg.controlToken = TOKEN;
  cfg.ports = { control: 41001, health: 41002 };
  store.updateWorker('m-one', { config: cfg });
}

test.describe('配置与诊断', () => {
  test('E2E-UI-070 配置 tab 脱敏，不出现 controlToken', async ({ page, console }) => {
    managedWithToken(console);
    await page.goto(`${console.url}/#/manage/workers/m-one`);
    await page.getByRole('tab', { name: '配置' }).click();

    const main = page.locator('main');
    await expect(main).toContainText('provider');
    await expect(main).toContainText('fixture');
    await expect(main).toContainText('41002');
    await expect(main).not.toContainText(TOKEN);
    await expect(main).not.toContainText('controlToken');
  });

  test('E2E-UI-071 导出诊断包：可解析、含 workerKey、无令牌值', async ({ page, console }) => {
    managedWithToken(console);
    await page.goto(`${console.url}/#/manage/workers/m-one`);
    await page.getByRole('tab', { name: '日志与维护' }).click();

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: '导出诊断包' }).click(),
    ]);
    const file = await download.path();
    const doc = JSON.parse(readFileSync(file!, 'utf8'));

    expect(doc.meta.stateRoot).toBe(console.root);
    expect(doc.workers.map((w: any) => w.workerKey)).toContain('m-one');
    const text = JSON.stringify(doc);
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain('controlToken');
  });

  test('E2E-UI-072 诊断中的 healthUrl 不夹带 query/fragment（回归）', async ({ page, console }) => {
    stub = await startHealthStub();
    seedExternal(console.handle.store, 'e-one', { healthUrl: stub.url });
    await page.goto(`${console.url}/#/manage/workers/e-one`);
    await page.getByRole('tab', { name: '日志与维护' }).click();

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: '导出诊断包' }).click(),
    ]);
    const doc = JSON.parse(readFileSync((await download.path())!, 'utf8'));
    const url = doc.workers[0].config.healthUrl;
    expect(url).toBe(stub.url);
    expect(url).not.toContain('?');
    expect(url).not.toContain('#');
  });
});
