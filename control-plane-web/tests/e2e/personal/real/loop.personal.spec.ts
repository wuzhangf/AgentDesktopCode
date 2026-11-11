/**
 * PRE-001 / PRE-003 —— 真实链路最小闭环。
 *
 * 真实 Chromium → 构建后的 BFF → 当前源码 ACS/Product（隔离工作树）→
 * 本机协议模型（`PersonalWebFixture`，gate 放行）。不调用外部付费模型。
 *
 * 取证：页面动作 + 同源 API 读取 + 源端直读 + 文件系统事实，三者分别记录；
 * 「页面显示了什么」与「源端实际做了什么」不互相顶替。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect } from '../fixtures/personal-real';
import { caseDir, writeJson } from '../fixtures/run-artifacts';

const INSTRUCTION = 'Change x.txt from v1 to v2 in the isolated workspace, then report the result.';

/** 递归找 x.txt（隔离工作树位置由 Product 决定，测试不假设目录结构）。 */
function findFiles(root: string, name: string, out: string[] = []): string[] {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      findFiles(full, name, out);
    } else if (entry.name === name) out.push(full);
  }
  return out;
}

async function readTaskFacts(page: any, taskId: string) {
  return page.evaluate(async (id: string) => {
    const headers = { 'x-personal-control': '1', 'x-personal-tab': sessionStorage.getItem('pae.personal.tabId') ?? '' };
    const read = async (suffix: string) => {
      const response = await fetch(`/api/personal/v1/tasks/${id}${suffix}`, { headers });
      return { status: response.status, body: await response.json().catch(() => null) };
    };
    return {
      detail: await read(''), metrics: await read('/metrics'),
      activities: await read('/activities'), output: await read('/output'),
    };
  }, taskId);
}

test.describe('真实链路', () => {
  test('PRE-001 @p0 真实创建→Product 改动隔离工作树→完成，刷新/新上下文/BFF 重启仍是原任务', async ({ page, browser, personalReal }) => {
    const stopGate = personalReal.gate.autoRelease();
    try {
      await page.goto(`${personalReal.url}/personal.html#/tasks`);
      await expect(page.getByRole('heading', { name: '任务', exact: true })).toBeVisible();

      // 按项目名称选择（不是路径输入框）。项目列表是异步查询，等真实选项出现。
      const select = page.getByLabel('项目', { exact: true });
      await expect(select.locator('option').nth(1), '项目列表未加载').toBeAttached({ timeout: 30_000 });
      const options = await select.locator('option').evaluateAll(nodes =>
        nodes.map(node => ({ value: (node as HTMLOptionElement).value, label: (node as HTMLOptionElement).textContent?.trim() ?? '' }))
          .filter(option => option.value));
      expect(options.length, '源端应至少有一个可选项目').toBeGreaterThan(0);
      const chosen = options[0]!;
      await select.selectOption(chosen.value);
      await page.getByLabel('任务要求', { exact: true }).fill(INSTRUCTION);
      await expect(page.getByRole('button', { name: '开始任务', exact: true })).toBeEnabled();
      await page.getByRole('button', { name: '开始任务', exact: true }).click();
      await page.waitForURL(/#\/tasks\/task-/, { timeout: 60_000 });
      const taskId = page.url().split('/tasks/')[1]!.split(/[?#]/)[0]!;

      // 真实执行：Run 必须自己跑到终态，测试不代替任何步骤。
      await expect(page.getByText('状态：已完成')).toBeVisible({ timeout: 180_000 });
      await expect(page.getByText(/FILE_WRITE.*SUCCEEDED/)).toBeVisible({ timeout: 30_000 });
      await expect(page.getByText('总 token', { exact: true })).toBeVisible({ timeout: 15_000 });

      const facts = await readTaskFacts(page, taskId);
      const detail = facts.detail.body.data;
      const metrics: any[] = facts.metrics.body?.data?.metrics ?? [];
      expect(detail.run.state, 'Run 必须 COMPLETED').toBe('COMPLETED');

      // 用量来自协议模型真实返回的 usage；费用未采集时不得编数字。
      const usageTotal = metrics.find(m => m.metricId === 'model.usage.total.reported');
      expect(usageTotal?.value, `观测 token 未对应协议模型 usage：${JSON.stringify(metrics)}`).toBeGreaterThan(0);
      const money = metrics.filter(m => m.unit === 'money');
      for (const item of money) expect(item.value, `费用未知却给出了数字：${JSON.stringify(item)}`).toBeNull();
      await expect(page.getByText('未知／未采集')).toBeVisible();

      // 真实文件效果：原 checkout 保持 v1，隔离工作树变成 v2。
      // 隔离工作树由 Product 建在 `-Duser.home` 下（…/.business-agent-code/worktrees/<id>/<ws>），
      // 因此从用例根目录递归找，不假设它在 host/ 里。
      const original = join(personalReal.root, 'host', 'workspace', 'x.txt');
      expect(existsSync(original), `原 checkout 缺失：${original}`).toBe(true);
      expect(readFileSync(original, 'utf8'), '原 checkout 被就地修改').toBe('v1');
      const copies = findFiles(personalReal.root, 'x.txt').filter(file => file !== original);
      const changed = copies.filter(file => readFileSync(file, 'utf8') === 'v2');
      expect(changed.length, `未发现隔离工作树中的真实改动；候选：${JSON.stringify(copies)}`).toBeGreaterThan(0);

      // 刷新仍是原任务。
      await page.reload();
      await expect(page.getByText('状态：已完成')).toBeVisible({ timeout: 30_000 });
      expect(page.url()).toContain(`/tasks/${taskId}`);

      // 新 context（无本地存储）从服务端发现同一任务。
      const fresh = await browser.newContext();
      try {
        const freshPage = await fresh.newPage();
        await freshPage.goto(`${personalReal.url}/personal.html#/tasks`);
        await freshPage.getByRole('link', { name: /Change x\.txt/ }).first().click();
        await freshPage.waitForURL(new RegExp(`/tasks/${taskId}$`));
        await expect(freshPage.getByText('状态：已完成')).toBeVisible({ timeout: 30_000 });
      } finally { await fresh.close(); }

      // BFF 真重启后仍是同一 task/session/run。
      await personalReal.restartBff();
      await page.reload();
      await expect(page.getByText('状态：已完成')).toBeVisible({ timeout: 60_000 });
      const afterRestart = await readTaskFacts(page, taskId);
      expect(afterRestart.detail.body.data.runId).toBe(detail.runId);
      expect(afterRestart.detail.body.data.sessionId).toBe(detail.sessionId);

      writeJson(join(caseDir('PRE-001'), 'evidence.json'), {
        taskId, project: chosen, runId: detail.runId, sessionId: detail.sessionId,
        runState: detail.run.state, usageTotal: usageTotal?.value, moneyMetrics: money,
        originalCheckout: { path: original, content: 'v1' },
        isolatedChanged: changed,
        afterRestart: { runId: afterRestart.detail.body.data.runId, sessionId: afterRestart.detail.body.data.sessionId },
      });
    } finally { stopGate(); }
  });
});

test.describe('无观测／无 foundation', () => {
  test.use({ personalRealOptions: { observation: false, foundation: false } });

  test('PRE-003 @p0 无观测/无 foundation 仍能创建执行，只开放 STOP，用量未知', async ({ page, personalReal }) => {
    test.setTimeout(240_000);
    try {
      await page.goto(`${personalReal.url}/personal.html#/tasks`);
      const select = page.getByLabel('项目', { exact: true });
      await expect(select.locator('option').nth(1), '项目列表未加载').toBeAttached({ timeout: 30_000 });
      const value = await select.locator('option').nth(1).getAttribute('value');
      await select.selectOption(value!);
      await page.getByLabel('任务要求', { exact: true }).fill(INSTRUCTION);
      await page.getByRole('button', { name: '开始任务', exact: true }).click();
      await page.waitForURL(/#\/tasks\/task-/, { timeout: 60_000 });
      const taskId = page.url().split('/tasks/')[1]!.split(/[?#]/)[0]!;

      // 先不放行模型调用：Run 停在真实 RUNNING 上，STOP 才有可取消的对象。
      await personalReal.gate.waitForRequest(1);
      await expect(page.getByText('状态：执行中')).toBeVisible({ timeout: 60_000 });

      // foundation 关闭 → 没有 PAUSE/RESUME 能力，但 STOP 仍应可用。
      await expect(page.getByRole('button', { name: '停止', exact: true })).toBeVisible({ timeout: 30_000 });
      await expect(page.getByRole('button', { name: '暂停', exact: true })).toHaveCount(0);
      await expect(page.getByRole('button', { name: '继续', exact: true })).toHaveCount(0);

      const facts = await readTaskFacts(page, taskId);
      const metrics: any[] = facts.metrics.body?.data?.metrics ?? [];
      const usage = metrics.find(m => m.metricId === 'model.usage.total.reported');
      expect(usage?.value ?? null, `未开启观测却出现用量：${JSON.stringify(metrics)}`).toBeNull();

      page.once('dialog', dialog => void dialog.accept());
      await page.getByRole('button', { name: '停止', exact: true }).click();
      // 放行被挂起的模型调用，让 Product 在下一个边界观察取消。
      personalReal.gate.allow(1);
      // STOP 的验收口径是「已受理并实际终止」，不是某个具体显示文案：
      // 源端可能把被打断的运行落到 CANCELLED，也可能落到需要处理；两者都必须
      // 有终态回执且不再提供任何控制意图。
      const deadline = Date.now() + 150_000;
      let stopReceipt: any = null;
      let finalRun: any = null;
      for (;;) {
        const factsNow = await readTaskFacts(page, taskId);
        finalRun = factsNow.detail.body.data.run;
        const control = await page.evaluate(async (id: string) => {
          const response = await fetch(`/api/personal/v1/tasks/${id}/commands`, {
            headers: { 'x-personal-control': '1', 'x-personal-tab': sessionStorage.getItem('pae.personal.tabId') ?? '' },
          });
          return (await response.json()).data;
        }, taskId);
        const all = [...(control.pendingRequests ?? []), ...(control.sourceCommands?.items ?? [])];
        const hit = all.find((item: any) => (item.request?.intent ?? item.intent) === 'STOP');
        stopReceipt = hit?.receipt ?? hit ?? null;
        if (stopReceipt?.phase === 'APPLIED' && finalRun?.state !== 'RUNNING') break;
        if (Date.now() > deadline) {
          throw new Error(`STOP 未收敛：${JSON.stringify({ state: finalRun?.state, stopReceipt })}`);
        }
        await page.waitForTimeout(500);
      }
      expect(stopReceipt.phase, 'STOP 必须真正生效').toBe('APPLIED');
      expect(finalRun.state, 'STOP 后运行不得继续执行').not.toBe('RUNNING');
      await expect(page.getByRole('button', { name: '停止', exact: true })).toHaveCount(0);

      // 只读命令查询仍然保留；终态后不再提供任何意图。
      expect(finalRun.state).not.toBe('RUNNING');
      await expect(page.getByRole('button', { name: '停止', exact: true })).toHaveCount(0);

      writeJson(join(caseDir('PRE-003'), 'evidence.json'), {
        taskId, runId: finalRun?.runId ?? null, runState: finalRun?.state ?? null,
        sourceStatus: finalRun?.sourceStatus ?? null,
        stopReceipt: { phase: stopReceipt.phase, resultCode: stopReceipt.resultCode ?? null, terminal: stopReceipt.terminal ?? null },
        usageTotal: usage?.value ?? null,
        costUnknown: metrics.filter(m => m.unit === 'money').every(m => m.value === null),
        metricsStatus: facts.metrics.status,
      });
    } finally {
      // 收尾兜底：任何仍被挂起的模型调用都要放行，否则夹具进程不会退出。
      for (const n of [1, 2, 3]) personalReal.gate.allow(n);
    }
  });
});
