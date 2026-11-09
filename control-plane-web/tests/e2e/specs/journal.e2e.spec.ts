/**
 * JRN — journal views: worker detail 任务 tab, the aggregated 任务 page, the
 * no-journal-capability path and read-only guarantees.
 */
import { test, expect } from '../fixtures/console';
import { seedExternal, seedJournalDb, seedManaged, startHealthStub, type HealthStub } from '../fixtures/seed';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let stub: HealthStub | null = null;
test.afterEach(async () => {
  await stub?.close();
  stub = null;
});

test.describe('journal 与任务页', () => {
  test('E2E-UI-060 外部 Worker 的 journal 行如实展示', async ({ page, console }) => {
    stub = await startHealthStub();
    const stateDir = mkdtempSync(join(tmpdir(), 'pc-journal-'));
    seedJournalDb(stateDir);
    seedExternal(console.handle.store, 'e-one', { healthUrl: stub.url, stateDir });

    await page.goto(`${console.url}/#/manage/workers/e-one`);
    await page.getByRole('tab', { name: '任务' }).click();

    const row = page.getByRole('row').filter({ hasText: 'execution_journal' }).first();
    await expect(row).toContainText('att-seed-1');
    await expect(row).toContainText('FINISHED');
    await expect(row).toContainText('run=run-seed-1');
    await expect(page.getByText(/schema 7/)).toBeVisible();
  });

  test('E2E-UI-061 任务页聚合真实行且不编造', async ({ page, console, request }) => {
    stub = await startHealthStub();
    const stateDir = mkdtempSync(join(tmpdir(), 'pc-journal-'));
    seedJournalDb(stateDir);
    seedExternal(console.handle.store, 'has-journal', { healthUrl: stub.url, stateDir });
    seedExternal(console.handle.store, 'no-journal', { healthUrl: stub.url });

    await page.goto(`${console.url}/#/manage/tasks`);
    await expect(page.getByRole('heading', { name: '任务执行记录（只读）', level: 1 })).toBeVisible();
    await expect(page.getByRole('row', { name: /has-journal/ })).toContainText('att-seed-1');
    await expect(page.getByRole('row', { name: /no-journal/ })).toHaveCount(0);

    const api = await (await request.get(`${console.url}/api/manage/workers/no-journal/journal`)).json();
    expect(api.code).toBe('NO_JOURNAL');
  });

  test('E2E-UI-062 无 journal 能力的 Worker 给出明确说明', async ({ page, console }) => {
    stub = await startHealthStub();
    seedExternal(console.handle.store, 'e-one', { healthUrl: stub.url });   // no stateDir

    await page.goto(`${console.url}/#/manage/workers/e-one`);
    await page.getByRole('tab', { name: '任务' }).click();

    // Honest surface: missing capability renders as an empty state with a
    // clear hint — not as a red error banner with a dead-end retry.
    await expect(page.getByText('无执行记录')).toBeVisible();
    await expect(page.getByText(/无 journal 读取能力/)).toBeVisible();
    await expect(page.getByRole('status').filter({ hasText: 'NO_JOURNAL' })).toHaveCount(0);

    await page.getByRole('tab', { name: '日志与维护' }).click();
    await expect(page.getByText(/无 journal 读取能力/)).toBeVisible();
    await expect(page.getByRole('status').filter({ hasText: 'NO_JOURNAL' })).toHaveCount(0);
  });

  test('E2E-UI-063 journal 视图只读，无编辑/删除入口', async ({ page, console }) => {
    stub = await startHealthStub();
    const stateDir = mkdtempSync(join(tmpdir(), 'pc-journal-'));
    seedJournalDb(stateDir);
    seedExternal(console.handle.store, 'e-one', { healthUrl: stub.url, stateDir });

    await page.goto(`${console.url}/#/manage/workers/e-one`);
    await page.getByRole('tab', { name: '日志与维护' }).click();
    await expect(page.getByRole('row', { name: /att-seed-1/ }).first()).toBeVisible();

    for (const name of ['编辑', '删除', '移除', '清空']) {
      await expect(page.getByRole('button', { name })).toHaveCount(0);
    }
  });

  test('E2E-UI-060b 受管 Worker 的 journal 只读视图可读', async ({ page, console }) => {
    const w = seedManaged(console.handle.store, 'm-one');
    seedJournalDb((w.config as any).dirs.state);

    await page.goto(`${console.url}/#/manage/workers/m-one`);
    await page.getByRole('tab', { name: '日志与维护' }).click();
    await expect(page.getByRole('row', { name: /cmd-seed-1/ }).first()).toBeVisible();
    await expect(page.getByText(/journal.db/)).toBeVisible();
  });
});
