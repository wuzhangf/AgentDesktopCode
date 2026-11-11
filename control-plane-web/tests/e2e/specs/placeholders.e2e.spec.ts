/**
 * PLH — increment-B placeholders, the lab entry page and /worker.html.
 */
import { test, expect } from '../fixtures/console';

test.describe('占位页与边界', () => {
  test('E2E-UI-095 项目/用量占位且不请求管理数据', async ({ page, console }) => {
    const calls: string[] = [];
    page.on('request', (r) => {
      if (/\/api\/manage\/(workers|operations|overview)/.test(r.url())) calls.push(r.url());
    });

    await page.goto(`${console.url}/#/manage/projects`);
    await expect(page.getByRole('heading', { name: '项目', level: 1 })).toBeVisible();
    await expect(page.getByRole('status')).toContainText('本页在增量 B 交付');
    await expect(page.getByText('当前版本尚无项目实体')).toBeVisible();

    await page.goto(`${console.url}/#/manage/usage`);
    await expect(page.getByRole('heading', { name: '用量', level: 1 })).toBeVisible();
    await expect(page.getByRole('status')).toContainText('本页在增量 B 交付');
    await expect(page.getByText('当前版本不展示估算或演示数字')).toBeVisible();

    expect(calls, `占位页不应拉取管理数据：${calls.join(', ')}`).toHaveLength(0);
  });

  test('E2E-UI-096 测试实验室指向独立入口', async ({ page, console }) => {
    await page.goto(`${console.url}/#/manage/lab`);
    await expect(page.getByRole('heading', { name: '测试实验室', level: 1 })).toBeVisible();
    await expect(page.getByText('Worker Lab 测试页')).toBeVisible();
    const lab = page.getByRole('link', { name: 'http://127.0.0.1:8796/worker.html' });
    await expect(lab).toHaveAttribute('href', 'http://127.0.0.1:8796/worker.html');
    await expect(lab).toHaveAttribute('target', '_blank');
    await expect(page.getByRole('link', { name: '/analysis/overview' })).toHaveAttribute('href', '#/analysis/overview');
  });

  test('E2E-UI-097 /worker.html 由静态服务直接返回（非 SPA 兜底）', async ({ page, console, request }) => {
    const res = await request.get(`${console.url}/worker.html`);
    expect(res.status()).toBe(200);
    const body = await res.text();
    expect(body).toContain('id="root"');
    expect(body).not.toContain('Worker 管理台');   // index.html title — would mean SPA fallback

    await page.goto(`${console.url}/worker.html`);
    await expect(page.locator('#root')).toBeAttached();
  });
});
