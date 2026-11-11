import { test, expect } from '../fixtures/personal-ui';
import {
  createTaskViaUi, gotoTasks, personalApi, receiptValue, taskDetail, waitForControl,
} from '../fixtures/assertions';

const MARKER_PREFIX = 'pae.personal.taskControl.';

async function markers(page: any): Promise<string[]> {
  return page.evaluate((prefix: string) => {
    const out: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith(prefix)) out.push(key);
    }
    return out;
  }, MARKER_PREFIX);
}

test.describe('控制恢复', () => {
  test('PUI-013 @p0 BFF 已完成但浏览器未收到响应：标记保留、只读核对', async ({ page, personalUi }) => {
    await gotoTasks(page, personalUi.url);
    const taskId = await createTaskViaUi(page, 'PUI-013 响应丢失');
    await waitForControl(page, taskId, (v) => (v.allowedIntents ?? []).includes('PAUSE'), 'PAUSE 可用');

    // 真实请求送达 BFF 与源端，但浏览器拿不到已完成响应。
    await page.route('**/api/personal/v1/tasks/*/commands', async (route) => {
      if (route.request().method() !== 'POST') { await route.fallback(); return; }
      await route.fetch();
      await route.abort('failed');
    });
    await page.getByRole('button', { name: '暂停', exact: true }).click();
    await expect(page.getByText(/请求失败|Failed to fetch|NetworkError/).first()).toBeVisible({ timeout: 20_000 });
    const kept = await markers(page);
    expect(kept.length, '提交结果未确认时必须保留本地核对标记').toBe(1);
    const commandId = kept[0]!.slice(MARKER_PREFIX.length);
    expect(personalUi.source.commandAttempts().filter((a: any) => a.commandId === commandId)).toHaveLength(1);

    await page.unroute('**/api/personal/v1/tasks/*/commands');
    await page.reload();
    // 服务端已有这条登记：重载后按服务端记录收敛，且不补发任何 POST。
    await expect(page.getByText('已登记控制请求')).toBeVisible({ timeout: 20_000 });
    const attemptsBefore = personalUi.source.commandAttempts().length;
    expect(await markers(page), '服务端已登记时本地标记应被核对清除').toHaveLength(0);
    await page.getByRole('button', { name: '核对结果' }).click();
    await expect(page.getByText('已受理/处理中')).toBeVisible({ timeout: 20_000 });
    expect(personalUi.source.commandAttempts().length, '核对只能读，不得重发').toBe(attemptsBefore);
    expect(await markers(page)).toHaveLength(0);
  });

  test('PUI-014 @p0 本地已冻结但源端无记录：同键原样重放', async ({ page, personalUi }) => {
    await gotoTasks(page, personalUi.url);
    const taskId = await createTaskViaUi(page, 'PUI-014 冻结后重放');
    const view = await waitForControl(page, taskId, (v) => (v.allowedIntents ?? []).includes('PAUSE'), 'PAUSE 可用');

    // 传输层不确定：源端没有登记任何命令。
    personalUi.source.failNext(
      { method: 'POST', path: /^\/api\/v2\/runs\/[^/]+\/commands$/ },
      { status: 503, body: { code: 'UPSTREAM_UNAVAILABLE', message: 'transport lost', status: 503 } },
    );
    await page.getByRole('button', { name: '暂停', exact: true }).click();
    const pending = await waitForControl(page, taskId, (v) => (v.pendingRequests ?? []).length === 1, 'PAUSE 未决');
    const commandId = pending.pendingRequests[0].commandId as string;
    expect(personalUi.source.acceptedCommands()).not.toContain(commandId);
    await expect(page.getByText(/核对失败：UPSTREAM_UNAVAILABLE/)).toBeVisible({ timeout: 20_000 });

    // 核对并继续：只允许冻结正文 + 原键重放。
    await page.getByRole('button', { name: '核对并继续原控制请求' }).click();
    await waitForControl(page, taskId, (v) => receiptValue(v, commandId) !== undefined, '原键重放已登记');
    // 两次派发（第一次传输不确定、第二次同键重放），但只被源端受理一次。
    const posts = personalUi.source.audit.filter((f) => f.method === 'POST' && f.path.endsWith('/commands'));
    expect(posts, `命令 POST 次数：${JSON.stringify(posts)}`).toHaveLength(2);
    const attempts = personalUi.source.commandAttempts().filter((a: any) => a.commandId === commandId);
    expect(attempts).toHaveLength(1);
    expect(attempts[0].intent).toBe('PAUSE');
    expect(attempts[0].expectedStateVersion).toBe(view.run.stateVersion);
    expect(personalUi.source.acceptedCommands().filter((id: string) => id === commandId)).toHaveLength(1);
  });

  test('PUI-021 @p1 本地存储不可写时仍提交一次并明确提示核对', async ({ page, personalUi }) => {
    await page.addInitScript(() => {
      const original = Storage.prototype.setItem;
      Storage.prototype.setItem = function setItem(this: Storage, key: string, value: string) {
        if (key.startsWith('pae.personal.taskControl.')) throw new DOMException('quota exceeded', 'QuotaExceededError');
        return original.call(this, key, value);
      };
    });
    await gotoTasks(page, personalUi.url);
    const taskId = await createTaskViaUi(page, 'PUI-021 存储不可写');
    await waitForControl(page, taskId, (v) => (v.allowedIntents ?? []).includes('PAUSE'), 'PAUSE 可用');
    await page.getByRole('button', { name: '暂停', exact: true }).click();

    await expect(page.getByText('无法写入本地核对标记：当前页面关闭前请先核对结果')).toBeVisible({ timeout: 20_000 });
    const pending = await waitForControl(page, taskId, (v) => (v.pendingRequests ?? []).length === 1, 'PAUSE 仍登记');
    const commandId = pending.pendingRequests[0].commandId as string;
    expect(personalUi.source.commandAttempts().filter((a: any) => a.commandId === commandId)).toHaveLength(1);
    expect(await markers(page)).toHaveLength(0);
  });
});
