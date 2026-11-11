/**
 * PRE-007 —— 未消费的 PAUSE 与另一端的显式 STOP。
 *
 * PAUSE 已受理但 Product 还没消费（模型调用被 gate 挂起）时，另一个标签页
 * 仍然可以发 STOP；随后放行模型调用，两条命令按源端实际结果各自收敛。
 * 这里不要求 PAUSE 一定 APPLIED：源端把它判成 SUPERSEDED 也是合法结果，
 * 测试只要求「有终态回执 + 同一 Run + 只有一个 STOP」。
 */
import { join } from 'node:path';
import { test, expect } from '../fixtures/personal-real';
import { caseDir, writeJson } from '../fixtures/run-artifacts';

const INSTRUCTION = 'Change x.txt from v1 to v2 in the isolated workspace, then report the result.';
const TERMINAL_PHASES = ['APPLIED', 'SUPERSEDED', 'NOOP', 'REJECTED'];

async function readControl(page: any, taskId: string): Promise<any> {
  return page.evaluate(async (id: string) => {
    const response = await fetch(`/api/personal/v1/tasks/${id}/commands`, {
      headers: { 'x-personal-control': '1', 'x-personal-tab': sessionStorage.getItem('pae.personal.tabId') ?? '' },
    });
    return (await response.json()).data;
  }, taskId);
}

async function pollControl(page: any, taskId: string, predicate: (view: any) => boolean, what: string, timeout = 150_000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const view = await readControl(page, taskId);
    if (predicate(view)) return view;
    if (Date.now() > deadline) throw new Error(`等待「${what}」超时：${JSON.stringify(view).slice(0, 900)}`);
    await page.waitForTimeout(500);
  }
}

function receiptFor(view: any, intent: string): any {
  const all = [...(view.pendingRequests ?? []), ...(view.sourceCommands?.items ?? [])];
  const hit = all.find(item => (item.request?.intent ?? item.intent) === intent);
  return hit?.receipt ?? hit;
}

test.describe('未消费控制', () => {
  test('PRE-007 @p1 PAUSE 未消费时另一端 STOP：同一 Run 收敛，不出现第二个未决 STOP', async ({ page, context, personalReal }) => {
    test.setTimeout(300_000);
    const { gate } = personalReal;
    await page.goto(`${personalReal.url}/personal.html#/tasks`);
    const select = page.getByLabel('项目', { exact: true });
    await expect(select.locator('option').nth(1), '项目列表未加载').toBeAttached({ timeout: 30_000 });
    await select.selectOption((await select.locator('option').nth(1).getAttribute('value'))!);
    await page.getByLabel('任务要求', { exact: true }).fill(INSTRUCTION);
    await page.getByRole('button', { name: '开始任务', exact: true }).click();
    await page.waitForURL(/#\/tasks\/task-/, { timeout: 60_000 });
    const taskId = page.url().split('/tasks/')[1]!.split(/[?#]/)[0]!;

    await gate.waitForRequest(1);
    const running = await pollControl(page, taskId, view =>
      view?.run?.state === 'RUNNING' && (view.allowedIntents ?? []).includes('PAUSE'), 'RUNNING 可暂停', 60_000);
    const runId = running.run.runId;
    const sessionId = running.run.sessionId;

    // 标签页 A：PAUSE 已登记但源端尚未消费（模型调用仍被挂起）。
    await expect(page.getByRole('button', { name: '暂停', exact: true })).toBeVisible({ timeout: 30_000 });
    await page.getByRole('button', { name: '暂停', exact: true }).click();
    const pendingPause = await pollControl(page, taskId, view =>
      (view.pendingRequests ?? []).some((p: any) => p.request.intent === 'PAUSE'), 'PAUSE 已登记', 30_000);
    expect(pendingPause.pendingRequests.some((p: any) => p.request.intent === 'PAUSE')).toBe(true);

    // 标签页 B：另一端仍可发 STOP，且未决 PAUSE 抑制了新的 PAUSE/RESUME。
    const other = await context.newPage();
    try {
      await other.goto(`${personalReal.url}/personal.html#/tasks/${taskId}`);
      await expect(other.getByText('运行控制')).toBeVisible({ timeout: 60_000 });
      await expect(other.getByRole('button', { name: '停止', exact: true })).toBeVisible({ timeout: 30_000 });
      await expect(other.getByRole('button', { name: '暂停', exact: true })).toHaveCount(0);
      await expect(other.getByRole('button', { name: '继续', exact: true })).toHaveCount(0);

      other.once('dialog', dialog => void dialog.accept());
      await other.getByRole('button', { name: '停止', exact: true }).click();
      await pollControl(other, taskId, view =>
        (view.pendingRequests ?? []).some((p: any) => p.request.intent === 'STOP'), 'STOP 已登记', 30_000);

      // 放行模型调用：Product 在下一个边界处理两条命令。
      gate.allow(1);
      // 收敛口径用「已终止」而不是某个具体字面量：真实 ACS 把被 STOP 的运行
      // 落到 NEEDS_ATTENTION / INTERRUPTED（controlState=STOPPED），不是 CANCELLED。
      const settled = await pollControl(other, taskId, view => {
        const stop = receiptFor(view, 'STOP');
        return TERMINAL_PHASES.includes(stop?.phase) && view?.run?.state !== 'RUNNING'
          && (view.pendingRequests ?? []).length === 0;
      }, 'STOP 终态回执且运行已停止', 180_000);

      const stopReceipt = receiptFor(settled, 'STOP');
      const pauseReceipt = receiptFor(settled, 'PAUSE');
      const history: any[] = settled.sourceCommands?.items ?? [];
      writeJson(join(caseDir('PRE-007'), 'evidence.json'), {
        taskId, runId, sessionId,
        run: settled.run,
        pause: pauseReceipt ? { phase: pauseReceipt.phase, resultCode: pauseReceipt.resultCode ?? null } : null,
        stop: { phase: stopReceipt.phase, resultCode: stopReceipt.resultCode ?? null },
        intents: settled.allowedIntents ?? [],
        pending: settled.pendingRequests ?? [],
        sourceCommands: history.map(item => ({ commandId: item.commandId, intent: item.intent, phase: item.phase, terminal: item.terminal })),
      });

      expect(settled.run.runId).toBe(runId);
      expect(settled.run.sessionId).toBe(sessionId);
      expect(settled.allowedIntents ?? []).toHaveLength(0);
      expect(settled.run.state, 'STOP 后不得继续执行').not.toBe('RUNNING');
      if (settled.run.controlState) expect(settled.run.controlState).toBe('STOPPED');
      // 未消费的 PAUSE 按源端实际结果收敛（APPLIED／SUPERSEDED／REJECTED 均可）。
      if (pauseReceipt) expect(TERMINAL_PHASES).toContain(pauseReceipt.phase);
      expect(history.filter(item => item.intent === 'STOP'), `STOP 命令：${JSON.stringify(history.map(i => i.intent))}`).toHaveLength(1);
      // 不存在第二个未决 STOP。
      expect((settled.pendingRequests ?? []).filter((p: any) => p.request.intent === 'STOP')).toHaveLength(0);

      // A 标签页刷新后看到同一终态（双端相互可见，没有第二个任务/Run）。
      await page.reload();
      await expect(page.getByText('运行控制')).toBeVisible({ timeout: 60_000 });
      const fromA = await pollControl(page, taskId, view => view?.run?.state === settled.run.state, 'A 看到同一 Run 终态', 60_000);
      expect(fromA.run.runId).toBe(runId);
    } finally { await other.close(); }
  });
});
