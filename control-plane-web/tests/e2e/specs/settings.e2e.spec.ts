/**
 * SET — 设置 page: read, persist, local ACS validation, stale-cache guard,
 * install check, save failure.
 */
import { test, expect } from '../fixtures/console';
import { makeFakeRelease } from '../fixtures/seed';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const gotoSettings = async (page: import('@playwright/test').Page, console: {url: string}) => {
  await page.goto(`${console.url}/#/manage/settings`);
  await expect(page.getByRole('heading', { name: '设置', level: 1 })).toBeVisible();
};

const releaseRootInput = (page: import('@playwright/test').Page) => page.getByPlaceholder('如 D:\\project\\worker-release');

test.describe('设置', () => {
  test('E2E-UI-080 读取后端默认设置', async ({ page, console }) => {
    await gotoSettings(page, console);
    await expect(releaseRootInput(page)).toHaveValue('');
    await expect(page.locator('main').getByRole('combobox')).toHaveValue('fixture');
    await expect(page.getByText('未配置 ACS 连接。')).toBeVisible();
    await expect(page.getByText('与服务器一致')).toBeVisible();
  });

  test('E2E-UI-081 保存并持久化', async ({ page, console, request }) => {
    const release = makeFakeRelease(mkdtempSync(join(tmpdir(), 'pc-rel-')));
    await gotoSettings(page, console);

    await releaseRootInput(page).fill(release);
    await page.locator('main').getByRole('combobox').selectOption('codex');
    await page.getByRole('button', { name: '保存' }).click();
    await expect(page.getByText(/已保存/)).toBeVisible();

    await page.reload();
    await expect(releaseRootInput(page)).toHaveValue(release);
    await expect(page.locator('main').getByRole('combobox')).toHaveValue('codex');

    const api = await (await request.get(`${console.url}/api/manage/settings`)).json();
    expect(api.releaseRoot).toBe(release);
    expect(api.defaultProvider).toBe('codex');
  });

  test('E2E-UI-082 ACS 半行在本地拦截，不发 PUT（回归）', async ({ page, console }) => {
    let puts = 0;
    await page.route('**/api/manage/settings', async (route) => {
      if (route.request().method() === 'PUT') puts++;
      await route.continue();
    });
    await gotoSettings(page, console);

    await page.getByRole('button', { name: '添加' }).click();
    await expect(page.getByTestId('settings-acs-row')).toHaveCount(1);
    await page.getByPlaceholder('名称').fill('acs-only-name');

    await page.getByRole('button', { name: '保存' }).click();
    await expect(page.getByRole('status')).toContainText('ACS 连接行不完整');
    await expect.poll(() => puts, { message: '本地校验失败不应发 PUT' }).toBe(0);
  });

  test('E2E-UI-083 保存后不被迟到的旧 GET 回写（回归）', async ({ page, console }) => {
    let stale: any = null;
    let hold = false;
    let release: (() => void) | null = null;
    let gate = new Promise<void>((r) => { release = r; });

    await page.route('**/api/manage/settings', async (route) => {
      if (route.request().method() !== 'GET') { await route.continue(); return; }
      if (hold) {
        await gate;
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(stale) });
        return;
      }
      const res = await route.fetch();
      stale = await res.json();
      await route.fulfill({ response: res });
    });

    await gotoSettings(page, console);
    await expect(releaseRootInput(page)).toHaveValue('');

    // From here the next GET returns the pre-save snapshot, late.
    hold = true;
    await page.locator('main').getByRole('combobox').selectOption('pi');
    await page.getByRole('button', { name: '保存' }).click();
    await expect(page.getByText(/已保存/)).toBeVisible();

    release!();
    await expect(page.locator('main').getByRole('combobox')).toHaveValue('pi');
  });

  test('E2E-UI-084 检查安装逐条渲染 findings（检查输入框里的值，不要求先保存）', async ({ page, console }) => {
    const release = makeFakeRelease(mkdtempSync(join(tmpdir(), 'pc-rel-')));
    await gotoSettings(page, console);
    await releaseRootInput(page).fill(release);

    // BUG-02 fixed: the check uses the input value, not the saved setting.
    await page.getByRole('button', { name: '检查安装' }).click();
    await expect(page.getByText('worker dist lib')).toBeVisible();
    await expect(page.getByText('worker manifest')).toBeVisible();
    await expect(page.getByText('worker-testkit jar')).toBeVisible();
    await expect(page.getByText('java', { exact: true })).toBeVisible();
    // The fake tree satisfies the four file-level findings, and the report
    // names the path that was actually checked — the unsaved input.
    await expect(page.getByText('manifest.json 存在')).toBeVisible();
    await expect(page.getByText(`releaseRoot ${release}`)).toBeVisible();
  });

  test('E2E-UI-085 保存失败展示错误并保留输入', async ({ page, console }) => {
    await page.route('**/api/manage/settings', async (route) => {
      if (route.request().method() === 'PUT') { await route.abort('failed'); return; }
      await route.continue();
    });
    await gotoSettings(page, console);

    await releaseRootInput(page).fill('D:/kept-on-failure');
    await page.getByRole('button', { name: '保存' }).click();

    await expect(page.getByRole('status')).toBeVisible();
    await expect(releaseRootInput(page)).toHaveValue('D:/kept-on-failure');
    await expect(page.getByText('有未保存修改')).toBeVisible();
  });
});
