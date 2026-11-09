/**
 * PRE-002 —— 真实控制闭环：gate 内 PAUSE → 源受理后 BFF 真重启 →
 * 放行 → APPLIED → RESUME → 下一 gate → STOP。
 *
 * gate 协议由夹具模型提供：第 n 次模型调用写 `request-<n>` 并阻塞到
 * `allow-<n>` 出现。因此「模型调用在飞行中」是确定事件，控制命令打在真实
 * RUNNING 的 Run 上，不靠 sleep 猜时序。
 */
import { join } from 'node:path';
import { test, expect } from '../fixtures/personal-real';
import { caseDir, writeJson } from '../fixtures/run-artifacts';

const INSTRUCTION = 'Change x.txt from v1 to v2 in the isolated workspace, then report the result.';

/** 源端回执：pending 行包着 receipt，历史行本身就是 receipt。 */
function receiptFor(view: any, intent: string): any {
  const all = [...(view.pendingRequests ?? []), ...(view.sourceCommands?.items ?? [])];
  const hit = all.find(item => (item.request?.intent ?? item.intent) === intent);
  return hit?.receipt ?? hit;
}

async function readControl(page: any, taskId: string): Promise<any> {
  return page.evaluate(async (id: string) => {
    const response = await fetch(`/api/personal/v1/tasks/${id}/commands`, {
      headers: { 'x-personal-control': '1', 'x-personal-tab': sessionStorage.getItem('pae.personal.tabId') ?? '' },
    });
    return (await response.json()).data;
  }, taskId);
}

async function pollControl(page: any, taskId: string, predicate: (view: any) => boolean, what: string, timeout = 120_000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const view = await readControl(page, taskId);
    if (predicate(view)) return view;
    if (Date.now() > deadline) throw new Error(`等待「${what}」超时：${JSON.stringify(view).slice(0, 900)}`);
    await page.waitForTimeout(500);
  }
}

test.describe('真实控制', () => {
  test('PRE-002 @p0 PAUSE→BFF 重启→APPLIED→RESUME→STOP 全程同一 task/session/run', async ({ page, personalReal }) => {
    test.setTimeout(300_000);
    const { gate } = personalReal;
    await page.goto(`${personalReal.url}/personal.html#/tasks`);
    const select = page.getByLabel('项目', { exact: true });
    await expect(select.locator('option').nth(1), '项目列表未加载').toBeAttached({ timeout: 30_000 });
    const value = await select.locator('option').nth(1).getAttribute('value');
    await select.selectOption(value!);
    await page.getByLabel('任务要求', { exact: true }).fill(INSTRUCTION);
    await page.getByRole('button', { name: '开始任务', exact: true }).click();
    await page.waitForURL(/#\/tasks\/task-/, { timeout: 60_000 });
    const taskId = page.url().split('/tasks/')[1]!.split(/[?#]/)[0]!;

    // 找一个「模型调用在飞行中且 Run 可暂停」的时刻。
    let running: any = null;
    let seq = 0;
    while (!running) {
      await gate.waitForRequest(seq + 1);
      running = await pollControl(page, taskId, view =>
        view?.run?.state === 'RUNNING' && (view.allowedIntents ?? []).includes('PAUSE')
        && (view.allowedIntents ?? []).includes('STOP') && typeof view.run.stateVersion === 'number',
      `第 ${seq + 1} 次模型调用期间的 RUNNING+PAUSE`, 15_000).catch(() => null);
      seq += 1;
      if (!running) {
        gate.allow(seq);
        if (seq > 6) throw new Error('Run 始终未进入可控 RUNNING');
      }
    }
    const runId = running.run.runId;
    const sessionId = running.run.sessionId;

    // 真实按钮 PAUSE（源受理后回执尚未终结）。
    await expect(page.getByRole('button', { name: '暂停', exact: true })).toBeVisible({ timeout: 30_000 });
    await page.getByRole('button', { name: '暂停', exact: true }).click();
    await pollControl(page, taskId, view =>
      (view.pendingRequests ?? []).some((p: any) => p.request.intent === 'PAUSE')
      || (view.sourceCommands?.items ?? []).some((i: any) => i.intent === 'PAUSE'), 'PAUSE 已登记', 30_000);

    // 源已受理、回执未确认时 BFF 真重启；重开页面必须从服务端找回该请求。
    await personalReal.restartBff();
    await page.reload();
    await expect(page.getByText('运行控制')).toBeVisible({ timeout: 60_000 });
    const recovered = await pollControl(page, taskId, view =>
      (view.pendingRequests ?? []).some((p: any) => p.request.intent === 'PAUSE')
      || (view.sourceCommands?.items ?? []).some((i: any) => i.intent === 'PAUSE'), 'BFF 重启后 PAUSE 仍在', 60_000);
    expect(recovered.pendingRequests.length + (recovered.sourceCommands?.items ?? []).length).toBeGreaterThan(0);

    // 放行模型调用：Product 在下一个边界消费 PAUSE → APPLIED → PAUSED。
    gate.allow(seq);
    const paused = await pollControl(page, taskId, view => {
      const receipt = receiptFor(view, 'PAUSE');
      return view?.run?.state === 'PAUSED' && view?.run?.sourceStatus === 'PAUSED_FOR_HUMAN'
        && receipt?.phase === 'APPLIED';
    }, 'PAUSED + APPLIED 回执', 150_000);
    await expect(page.getByText('状态：已暂停')).toBeVisible({ timeout: 30_000 });
    expect(paused.allowedIntents ?? []).toContain('RESUME');
    expect(paused.allowedIntents ?? []).toContain('STOP');
    expect(paused.allowedIntents ?? []).not.toContain('PAUSE');

    // RESUME 后同一 Run 继续，并在下一次 gate 处证明工作树就地恢复。
    await expect(page.getByRole('button', { name: '继续', exact: true })).toBeVisible({ timeout: 30_000 });
    await page.getByRole('button', { name: '继续', exact: true }).click();
    await gate.waitForRequest(seq + 1);
    seq += 1;
    const resumed = await pollControl(page, taskId, view =>
      view?.run?.state === 'RUNNING' && (view.allowedIntents ?? []).includes('PAUSE'), 'RESUME 后 RUNNING', 120_000);
    expect(resumed.run.runId).toBe(runId);
    expect(resumed.run.sessionId).toBe(sessionId);

    // 飞行中 STOP，随后放行模型调用，Product 必须真正取消同一 Run。
    page.once('dialog', dialog => void dialog.accept());
    await expect(page.getByRole('button', { name: '停止', exact: true })).toBeVisible({ timeout: 30_000 });
    await page.getByRole('button', { name: '停止', exact: true }).click();
    gate.allow(seq);
    const stopped = await pollControl(page, taskId, view =>
      view?.run?.state === 'CANCELLED' && receiptFor(view, 'STOP')?.phase === 'APPLIED', 'CANCELLED + APPLIED 回执', 150_000);
    expect(stopped.allowedIntents ?? []).toHaveLength(0);

    // 三意图各一条唯一源命令，绑定未变。
    const history: any[] = stopped.sourceCommands?.items ?? [];
    for (const intent of ['PAUSE', 'RESUME', 'STOP']) {
      expect(history.filter(item => item.intent === intent), `${intent} 源命令数量`).toHaveLength(1);
    }
    const detail = await page.evaluate(async (id: string) => {
      const response = await fetch(`/api/personal/v1/tasks/${id}`, {
        headers: { 'x-personal-control': '1', 'x-personal-tab': sessionStorage.getItem('pae.personal.tabId') ?? '' },
      });
      return (await response.json()).data;
    }, taskId);
    expect(detail.run.runId).toBe(runId);
    expect(detail.session.sessionId).toBe(sessionId);

    writeJson(join(caseDir('PRE-002'), 'evidence.json'), {
      taskId, runId, sessionId,
      pause: { receipt: receiptFor(paused, 'PAUSE'), allowedIntents: paused.allowedIntents },
      resume: { receipt: receiptFor(resumed, 'RESUME'), run: resumed.run },
      stop: { receipt: receiptFor(stopped, 'STOP'), run: stopped.run },
      sourceCommands: history.map(item => ({
        commandId: item.commandId, intent: item.intent, phase: item.phase, terminal: item.terminal,
        consumptionProof: item.consumptionProof ?? null, evidenceRef: item.evidenceRef ?? null,
      })),
      recoveredAfterRestart: (recovered.pendingRequests ?? []).map((p: any) => p.commandId),
    });
  });
});
