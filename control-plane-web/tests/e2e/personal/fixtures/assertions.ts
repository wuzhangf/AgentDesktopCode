/**
 * Shared locators/assertions for the personal E2E suites.
 *
 * Rules (design §4.4): prefer accessible names, scope every control lookup to
 * the task detail / control card, never install a global dialog handler, and
 * never treat HTTP 200 as "the control took effect".
 */
import { expect, type Page } from '@playwright/test';

export const PROJECT_NAME = '示例项目';

export function tasksUrl(baseUrl: string): string {
  return `${baseUrl}/personal.html#/tasks`;
}

export async function gotoTasks(page: Page, baseUrl: string): Promise<void> {
  await page.goto(tasksUrl(baseUrl));
  await expect(page.getByRole('heading', { name: '任务', exact: true })).toBeVisible();
}

/** 同源个人 API 读取（真实 header/cookie，走被测 BFF）。 */
export async function personalApi<T = any>(
  page: Page,
  path: string,
  init: { method?: 'GET' | 'POST'; body?: unknown; key?: string } = {},
): Promise<{ status: number; body: T }> {
  return page.evaluate(async ([path, init]) => {
    const request = init as { method?: string; body?: unknown; key?: string };
    const headers: Record<string, string> = {
      'x-personal-control': '1',
      'x-personal-tab': sessionStorage.getItem('pae.personal.tabId') ?? '',
    };
    if (request.method === 'POST') headers['content-type'] = 'application/json';
    if (request.key) headers['idempotency-key'] = request.key;
    const response = await fetch(path as string, {
      method: request.method ?? 'GET',
      headers,
      body: request.body === undefined ? undefined : JSON.stringify(request.body),
      credentials: 'same-origin',
    });
    return { status: response.status, body: await response.json().catch(() => null) };
  }, [path, init] as const);
}

export async function controlView(page: Page, taskId: string): Promise<any> {
  const response = await personalApi(page, `/api/personal/v1/tasks/${taskId}/commands`);
  expect(response.status, `control view HTTP ${response.status}`).toBe(200);
  return response.body.data;
}

export async function taskDetail(page: Page, taskId: string): Promise<any> {
  const response = await personalApi(page, `/api/personal/v1/tasks/${taskId}`);
  expect(response.status, `task detail HTTP ${response.status}`).toBe(200);
  return response.body.data;
}

/** 通过页面选择项目名称 → 自动登记 → 填写要求 → 开始任务。 */
export async function createTaskViaUi(page: Page, instruction: string, projectName = PROJECT_NAME): Promise<string> {
  const select = page.getByLabel('项目', { exact: true });
  await expect(select.locator('option', { hasText: projectName }).first()).toBeAttached();
  const value = await select.locator('option', { hasText: projectName }).first().getAttribute('value');
  expect(value, '项目选项缺少 value').toBeTruthy();
  await select.selectOption(value!);
  await page.getByLabel('任务要求', { exact: true }).fill(instruction);
  const start = page.getByRole('button', { name: '开始任务', exact: true });
  await expect(start).toBeEnabled();
  await start.click();
  await page.waitForURL(/#\/tasks\/task-/, { timeout: 30_000 });
  const taskId = page.url().split('/tasks/')[1]!.split(/[?#]/)[0]!;
  expect(taskId).toMatch(/^task-/);
  return taskId;
}

/** 只读等待控制视图满足条件（不触发任何业务写）。 */
export async function waitForControl(
  page: Page,
  taskId: string,
  predicate: (view: any) => boolean,
  what: string,
  timeout = 20_000,
): Promise<any> {
  const deadline = Date.now() + timeout;
  let last: any;
  for (;;) {
    last = await controlView(page, taskId);
    if (predicate(last)) return last;
    if (Date.now() > deadline) {
      throw new Error(`等待「${what}」超时；最后一次控制视图：${JSON.stringify(last).slice(0, 900)}`);
    }
    await page.waitForTimeout(250);
  }
}

export function receiptOf(view: any, commandId: string): any {
  const all = [...(view.pendingRequests ?? []), ...(view.sourceCommands?.items ?? [])];
  return all.find((item: any) => (item.commandId ?? item.request?.requestKey) === commandId);
}

/** 视图里 pending 行包着 receipt，源端历史直接就是 receipt —— 两种都取值。 */
export function receiptValue(view: any, commandId: string): any {
  const item = receiptOf(view, commandId);
  return item?.receipt ?? item;
}

/** 计数辅助：断言「没有发生业务写入」时使用，不用全站请求数量猜测。 */
export function businessWrites(source: { writes(): { sessions: number; messages: number; commands: number } }) {
  return source.writes();
}
