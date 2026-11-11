/**
 * PRE-004 / PRE-005 —— 两个恢复场景，不能合并成一句「断网重试」。
 *
 * PRE-004：源端已受理、BFF 没拿到响应（代理 DROP_AFTER_SOURCE_REPLY）。
 * PRE-005：BFF 已冻结、请求还没转发（代理 HOLD_BEFORE_FORWARD），随后 BFF
 *          被非正常结束，重开同一端口与同一状态库，由用户显式续接。
 *
 * 两者都要求：原 requestKey 不变、源端只受理一次、恢复期间不产生新的业务 POST。
 */
import { join } from 'node:path';
import { test, expect } from '../fixtures/personal-real';
import { caseDir, writeJson } from '../fixtures/run-artifacts';

const INSTRUCTION = 'Change x.txt from v1 to v2 in the isolated workspace, then report the result.';
const COMMAND_POST = /^\/api\/v2\/runs\/[^/]+\/commands$/;

test.use({ personalRealOptions: { proxy: true, observation: true, foundation: true } });

async function createTask(page: any, personalReal: any): Promise<string> {
  await page.goto(`${personalReal.url}/personal.html#/tasks`);
  const select = page.getByLabel('项目', { exact: true });
  await expect(select.locator('option').nth(1), '项目列表未加载').toBeAttached({ timeout: 30_000 });
  await select.selectOption((await select.locator('option').nth(1).getAttribute('value'))!);
  await page.getByLabel('任务要求', { exact: true }).fill(INSTRUCTION);
  await page.getByRole('button', { name: '开始任务', exact: true }).click();
  await page.waitForURL(/#\/tasks\/task-/, { timeout: 60_000 });
  return page.url().split('/tasks/')[1]!.split(/[?#]/)[0]!;
}

async function pollBff(personalReal: any, taskId: string, predicate: (view: any) => boolean, what: string, timeout = 120_000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const response = await personalReal.bff(`/api/personal/v1/tasks/${taskId}/commands`);
    const view = response.body?.data;
    if (predicate(view)) return view;
    if (Date.now() > deadline) throw new Error(`等待「${what}」超时：${JSON.stringify(view).slice(0, 900)}`);
    await new Promise((done) => setTimeout(done, 500));
  }
}

/** 源端命令列表（直读 ACS，不经 BFF）。 */
async function sourceCommandPage(personalReal: any, runId: string): Promise<{ status: number; items: any[]; raw: unknown }> {
  const response = await personalReal.acsSession(`/api/v2/runs/${runId}/commands?limit=50`);
  const body = response.body as any;
  const items = Array.isArray(body) ? body : body?.items ?? [];
  return { status: response.status, items, raw: body };
}

async function sourceCommands(personalReal: any, runId: string): Promise<any[]> {
  return (await sourceCommandPage(personalReal, runId)).items;
}

/** 源端受理是 202 异步落库：轮询到命令出现，而不是立刻断言。 */
async function waitForSourceCommand(personalReal: any, runId: string, predicate: (item: any) => boolean, what: string, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  let last: { status: number; items: any[]; raw: unknown } = { status: 0, items: [], raw: null };
  for (;;) {
    last = await sourceCommandPage(personalReal, runId);
    const hit = last.items.filter(predicate);
    if (hit.length) return hit;
    if (Date.now() > deadline) {
      throw new Error(`等待源端命令「${what}」超时：status=${last.status} body=${JSON.stringify(last.raw).slice(0, 400)}`);
    }
    await new Promise((done) => setTimeout(done, 300));
  }
}

test.describe('恢复场景', () => {
  test('PRE-004 @p0 源端已受理但 BFF 未确认：刷新/新 context 只读恢复，最终 APPLIED，无第二次源 POST', async ({ page, browser, personalReal }) => {
    test.setTimeout(300_000);
    const { gate, proxy } = personalReal;
    expect(proxy, '本用例需要故障注入代理').toBeTruthy();
    const taskId = await createTask(page, personalReal);
    await gate.waitForRequest(1);
    const running = await pollBff(personalReal, taskId, view =>
      view?.run?.state === 'RUNNING' && (view.allowedIntents ?? []).includes('PAUSE'), 'RUNNING 可暂停', 60_000);
    const runId = running.run.runId;

    proxy!.addRule({ path: COMMAND_POST, mode: 'dropAfterReply' });
    await expect(page.getByRole('button', { name: '暂停', exact: true })).toBeVisible({ timeout: 30_000 });
    await page.getByRole('button', { name: '暂停', exact: true }).click();

    // 等代理把「源端已回、客户端被断」这一步做完。
    const deadline = Date.now() + 60_000;
    while (!proxy!.facts.some(fact => fact.droppedClientReply)) {
      if (Date.now() > deadline) throw new Error(`代理未观察到命令 POST：${JSON.stringify(proxy!.facts)}`);
      await new Promise((done) => setTimeout(done, 200));
    }
    const droppedFacts = proxy!.facts.filter(fact => fact.droppedClientReply);
    expect(droppedFacts, '只应有一次被断的源 POST').toHaveLength(1);

    // 源端确实已受理（202 异步落库，轮询到命令出现）；BFF 只知道「未确认」。
    const afterDrop = await waitForSourceCommand(personalReal, runId, item => item.intent === 'PAUSE',
      `PAUSE 落库；代理事实：${JSON.stringify(proxy!.facts)}；runId=${runId}`);
    expect(afterDrop).toHaveLength(1);
    const unconfirmed = await pollBff(personalReal, taskId, view =>
      (view.pendingRequests ?? []).some((p: any) => p.request.intent === 'PAUSE' && !p.receipt?.terminal), 'BFF 保留未确认请求', 30_000);
    const key = unconfirmed.pendingRequests[0].commandId as string;
    expect(unconfirmed.pendingRequests[0].dispatchStartedAt, 'BFF 应记录已派发时间').toBeTruthy();

    // 恢复：刷新页面 → 服务端列表里仍有该请求（不依赖本地 marker）。
    proxy!.clearRules();
    await page.reload();
    await expect(page.getByText('运行控制')).toBeVisible({ timeout: 60_000 });
    const recovered = await pollBff(personalReal, taskId, view =>
      (view.pendingRequests ?? []).some((p: any) => p.commandId === key), '刷新后仍能从服务端看到原请求', 60_000);
    expect(recovered.pendingRequests.some((p: any) => p.commandId === key)).toBe(true);

    // 新 context 同样能发现它（无本地存储）。
    const fresh = await browser.newContext();
    try {
      const freshPage = await fresh.newPage();
      await freshPage.goto(`${personalReal.url}/personal.html#/tasks/${taskId}`);
      await expect(freshPage.getByText('运行控制')).toBeVisible({ timeout: 60_000 });
    } finally { await fresh.close(); }

    // 放行模型调用 → Product 消费 PAUSE → BFF 对账得到 APPLIED。
    gate.allow(1);
    const applied = await pollBff(personalReal, taskId, view => {
      const all = [...(view.pendingRequests ?? []), ...(view.sourceCommands?.items ?? [])];
      const hit = all.find((item: any) => (item.commandId ?? item.request?.requestKey) === key);
      const receipt = hit?.receipt ?? hit;
      return receipt?.phase === 'APPLIED' && view?.run?.state === 'PAUSED';
    }, 'PAUSE APPLIED 且 PAUSED', 150_000);
    expect(applied.run.state).toBe('PAUSED');

    // 源端只受理一次、只转发一次：没有第二个 POST。
    const sourcePause = (await sourceCommands(personalReal, runId)).filter(item => item.intent === 'PAUSE');
    expect(sourcePause, `源端出现重复命令：${JSON.stringify(sourcePause)}`).toHaveLength(1);
    expect(proxy!.facts.filter(fact => fact.path === droppedFacts[0]!.path), '恢复过程不得再次 POST 源端').toHaveLength(1);

    writeJson(join(caseDir('PRE-004'), 'evidence.json'), {
      taskId, runId, key, intent: 'PAUSE',
      proxyFacts: proxy!.facts, sourceCommands: sourcePause.map(item => ({ commandId: item.commandId, intent: item.intent, phase: item.phase })),
      finalRunState: applied.run.state,
    });
  });

  test('PRE-005 @p0 BFF 已冻结但源未受理：非正常结束+重启后显式续接，原键转发一次并 APPLIED', async ({ page, browser, personalReal }) => {
    test.setTimeout(300_000);
    const { gate, proxy } = personalReal;
    const taskId = await createTask(page, personalReal);
    await gate.waitForRequest(1);
    const running = await pollBff(personalReal, taskId, view =>
      view?.run?.state === 'RUNNING' && (view.allowedIntents ?? []).includes('PAUSE'), 'RUNNING 可暂停', 60_000);
    const runId = running.run.runId;

    proxy!.addRule({ path: COMMAND_POST, mode: 'hold' });
    await expect(page.getByRole('button', { name: '暂停', exact: true })).toBeVisible({ timeout: 30_000 });
    await page.getByRole('button', { name: '暂停', exact: true }).click();

    // 等代理扣住命令请求，并确认 BFF 已把冻结请求落盘（有 dispatchStartedAt）。
    const deadline = Date.now() + 60_000;
    while (!proxy!.held.length) {
      if (Date.now() > deadline) throw new Error('代理没有扣住命令 POST');
      await new Promise((done) => setTimeout(done, 100));
    }
    // 冻结正文用的是源端契约字段 commandId（BFF 保证 commandId == requestKey）。
    const heldBody = JSON.parse(proxy!.held[0]!.body) as { commandId?: string; requestKey?: string; intent: string; expectedStateVersion?: number };
    const key = (heldBody.commandId ?? heldBody.requestKey)!;
    const frozen = await pollBff(personalReal, taskId, view =>
      (view.pendingRequests ?? []).some((p: any) => p.commandId === key && !!p.dispatchStartedAt),
      `冻结请求已落盘（key=${key}，held=${proxy!.held[0]!.body.slice(0, 200)}）`, 30_000);
    expect(frozen.pendingRequests[0].request.intent).toBe('PAUSE');

    // 非正常结束 BFF，并取消代理上的原连接：源端从未见过这个键。
    await personalReal.killBffHard();
    proxy!.held[0]!.cancel();
    const beforeRestart = await sourceCommands(personalReal, runId);
    expect(beforeRestart.filter(item => item.commandId === key), '源端不得出现该命令').toHaveLength(0);

    // 同端口、同状态库重启；新 context（无本地存储）从服务端找回请求。
    await personalReal.restartBff();
    const fresh = await browser.newContext();
    let afterCheck: any;
    let afterResume: any;
    try {
      const freshPage = await fresh.newPage();
      await freshPage.goto(`${personalReal.url}/personal.html#/tasks/${taskId}`);
      await expect(freshPage.getByText('运行控制')).toBeVisible({ timeout: 60_000 });
      const recovered = await pollBff(personalReal, taskId, view =>
        (view.pendingRequests ?? []).some((p: any) => p.commandId === key), '重启后仍能找回原请求', 60_000);
      expect(recovered.pendingRequests.some((p: any) => p.commandId === key)).toBe(true);

      // 显式核对：只读 GET，源端 404，业务 POST 计数不增长（会话登记不算业务写）。
      const commandPosts = () => proxy!.facts.filter(fact => COMMAND_POST.test(fact.path)).length;
      const postsBeforeCheck = commandPosts();
      await freshPage.getByRole('button', { name: '核对结果' }).first().click();
      await freshPage.waitForTimeout(2_000);
      afterCheck = await personalReal.bff(`/api/personal/v1/tasks/${taskId}/commands/${key}`);
      expect(commandPosts(), '核对不得产生业务 POST').toBe(postsBeforeCheck);
      expect((await sourceCommands(personalReal, runId)).filter(item => item.commandId === key)).toHaveLength(0);

      // 显式续接：原 key/原正文转发一次，源端唯一受理，最终 APPLIED。
      proxy!.clearRules();
      await freshPage.getByRole('button', { name: '核对并继续原控制请求' }).first().click();
      gate.allow(1);
      const applied = await pollBff(personalReal, taskId, view => {
        const all = [...(view.pendingRequests ?? []), ...(view.sourceCommands?.items ?? [])];
        const hit = all.find((item: any) => (item.commandId ?? item.request?.requestKey) === key);
        const receipt = hit?.receipt ?? hit;
        return receipt?.phase === 'APPLIED' && view?.run?.state === 'PAUSED';
      }, '续接后 APPLIED', 180_000);
      afterResume = applied;
    } finally { await fresh.close(); }

    const sourcePause = (await sourceCommands(personalReal, runId)).filter(item => item.intent === 'PAUSE');
    expect(sourcePause, `源端应唯一受理：${JSON.stringify(sourcePause)}`).toHaveLength(1);
    expect(sourcePause[0].commandId).toBe(key);
    expect(sourcePause[0].intent).toBe(heldBody.intent);

    writeJson(join(caseDir('PRE-005'), 'evidence.json'), {
      taskId, runId, key,
      frozenBody: heldBody,
      sourceCommandIds: sourcePause.map(item => item.commandId),
      afterCheck: afterCheck?.body?.data ?? null,
      finalRunState: afterResume?.run?.state ?? null,
      proxyFacts: proxy!.facts,
    });
  });
});
