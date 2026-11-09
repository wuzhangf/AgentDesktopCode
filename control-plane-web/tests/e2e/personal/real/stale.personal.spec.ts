/**
 * PRE-006 —— 陈旧标签页的版本冲突：A 标签页保留真实版本 V；B 暂停成功使版本
 * 变化；A 仍按 V 点暂停 → ACS 真实 STATE_VERSION_CONFLICT，BFF 存明确拒绝。
 *
 * 快照固定方式（设计 §8 要求写明）：A 的控制视图读取一次后，用 `page.route`
 * 把 A 后续的 GET /commands 固定为**那一次真实响应**；POST 不拦截，仍然携带
 * A 快照里的真实 stateVersion。因此「陈旧」是页面快照陈旧，不是伪造请求体。
 * B 标签页与取证读取都不经过该路由，看到的始终是服务端实时事实。
 */
import { join } from 'node:path';
import { test, expect } from '../fixtures/personal-real';
import { caseDir, writeJson } from '../fixtures/run-artifacts';

const INSTRUCTION = 'Change x.txt from v1 to v2 in the isolated workspace, then report the result.';

async function readEnvelope(page: any, path: string): Promise<any> {
  return page.evaluate(async (target: string) => {
    const response = await fetch(target, {
      headers: { 'x-personal-control': '1', 'x-personal-tab': sessionStorage.getItem('pae.personal.tabId') ?? '' },
    });
    return { status: response.status, body: await response.json().catch(() => null) };
  }, path);
}

async function pollControl(page: any, taskId: string, predicate: (view: any) => boolean, what: string, timeout = 120_000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const response = await readEnvelope(page, `/api/personal/v1/tasks/${taskId}/commands`);
    const view = response.body?.data;
    if (predicate(view)) return view;
    if (Date.now() > deadline) throw new Error(`等待「${what}」超时：${JSON.stringify(view).slice(0, 800)}`);
    await page.waitForTimeout(500);
  }
}

test.describe('陈旧标签页', () => {
  test('PRE-006 @p1 A 按陈旧版本暂停：源端真实冲突、页面显示原因、不自动换版本重试', async ({ page, context, personalReal }) => {
    test.setTimeout(300_000);
    // 已知产品缺陷（DEFECT-PUI-015 / 设计 §9.2）：BFF 记录 sourceRejection，
    // 但控制卡不再渲染被拒行，A 页面看不到原因。修复落地后移除本标记。
    test.fail(true, 'DEFECT-PUI-015: 控制卡未渲染 createTaskCommand 返回的 sourceRejection');

    await page.goto(`${personalReal.url}/personal.html#/tasks`);
    const select = page.getByLabel('项目', { exact: true });
    await expect(select.locator('option').nth(1), '项目列表未加载').toBeAttached({ timeout: 30_000 });
    await select.selectOption((await select.locator('option').nth(1).getAttribute('value'))!);
    await page.getByLabel('任务要求', { exact: true }).fill(INSTRUCTION);
    await page.getByRole('button', { name: '开始任务', exact: true }).click();
    await page.waitForURL(/#\/tasks\/task-/, { timeout: 60_000 });
    const taskId = page.url().split('/tasks/')[1]!.split(/[?#]/)[0]!;

    // 模型调用在飞行中 → Run RUNNING；A 取一次真实控制视图作为冻结快照。
    await personalReal.gate.waitForRequest(1);
    const stale = await pollControl(page, taskId, view =>
      view?.run?.state === 'RUNNING' && (view.allowedIntents ?? []).includes('PAUSE')
      && typeof view.run.stateVersion === 'number', 'A 拿到可暂停快照', 60_000);
    const staleVersion = stale.run.stateVersion;
    const runId = stale.run.runId;

    // 固定 A 的 GET 快照（POST 放行）。取证与 B 标签页不走这条路由。
    const frozen = await readEnvelope(page, `/api/personal/v1/tasks/${taskId}/commands`);
    await page.route(`**/api/personal/v1/tasks/${taskId}/commands*`, async route => {
      if (route.request().method() !== 'GET') { await route.continue(); return; }
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(frozen.body) });
    });

    let aCommandPosts = 0;
    const aPosts: string[] = [];
    page.on('request', request => {
      if (request.method() !== 'POST' || !request.url().includes(`/api/personal/v1/tasks/${taskId}/commands`)) return;
      aCommandPosts += 1;
      try { aPosts.push((request.postDataJSON() as { requestKey: string }).requestKey); } catch { /* ignore */ }
    });

    // B 标签页：真实按钮暂停成功，源端版本随之变化。
    const other = await context.newPage();
    let pausedVersion = 0;
    try {
      await other.goto(`${personalReal.url}/personal.html#/tasks/${taskId}`);
      await expect(other.getByRole('button', { name: '暂停', exact: true })).toBeVisible({ timeout: 60_000 });
      await other.getByRole('button', { name: '暂停', exact: true }).click();
      personalReal.gate.allow(1);
      const paused = await pollControl(other, taskId, view =>
        view?.run?.state === 'PAUSED' && view?.run?.stateVersion > staleVersion, 'B 暂停后版本推进', 150_000);
      pausedVersion = paused.run.stateVersion;
      expect(pausedVersion).toBeGreaterThan(staleVersion);
    } finally { await other.close(); }

    // A 仍按 V 点暂停：真实冲突，不是构造出来的请求体。
    await expect(page.getByRole('button', { name: '暂停', exact: true })).toBeVisible({ timeout: 30_000 });
    await page.getByRole('button', { name: '暂停', exact: true }).click();
    await page.waitForTimeout(2_000);
    expect(aCommandPosts, 'A 只提交一次，不自动换版本重试').toBe(1);
    const key = aPosts[0]!;

    // 取证读取从 Node 侧直读 BFF（不受 A 的冻结路由与页面焦点时序影响）。
    const record = await personalReal.bff<any>(`/api/personal/v1/tasks/${taskId}/commands/${key}`);
    const after = (await personalReal.bff<any>(`/api/personal/v1/tasks/${taskId}/commands`)).body?.data;

    const rejection = record?.body?.data?.sourceRejection ?? null;
    const visible = await page.getByText(/STATE_VERSION_CONFLICT|已拒绝|版本.*(冲突|变化|已变)/).first()
      .isVisible().catch(() => false);
    // 先落盘再断言：被拒/被接受都要能复盘真实回执。
    writeJson(join(caseDir('PRE-006'), 'evidence.json'), {
      taskId, runId, staleVersion, pausedVersion,
      commandPosts: aCommandPosts, rejection, pageShowsReason: visible,
      runStateAfter: after.run.state, stateVersionAfter: after.run.stateVersion,
      allowedIntentsAfter: after.allowedIntents,
      record: record?.body?.data ?? null,
      frozenSnapshotVersion: frozen.body?.data?.run?.stateVersion,
    });
    expect(rejection, `BFF 未记录源端明确拒绝：${JSON.stringify(record).slice(0, 900)}`).toMatchObject({ code: 'STATE_VERSION_CONFLICT' });
    expect(after.run.runId).toBe(runId);
    expect(after.run.state).toBe('PAUSED');

    // 页面必须让用户看到本次被拒绝的原因。
    expect(visible, `A 页面未展示源端拒绝原因（产品缺陷）：${JSON.stringify({ rejection, staleVersion, pausedVersion })}`).toBe(true);
  });
});
