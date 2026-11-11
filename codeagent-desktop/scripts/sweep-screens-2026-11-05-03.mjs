// Batch-3: newly wired dead entries (2026-11-05 fixes) — command palette,
// MISSIONS/EXTENSIONS rail nav, PLAN/MISSION/DETAILS header actions,
// session row menu, evidence review findings, lane + delivery sections.
// Usage: node scripts/sweep-screens-2026-11-05-03.mjs
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const webRequire = createRequire(path.resolve(root, '../control-plane-web/package.json'));
const { chromium } = webRequire('@playwright/test');
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const OUT = 'E:/E2E-Test/electron/2026-11-04-01';
mkdirSync(OUT, { recursive: true });
const manifestPath = `${OUT}/manifest.json`;
const manifest = existsSync(manifestPath)
  ? JSON.parse((await import('node:fs')).readFileSync(manifestPath, 'utf8'))
  : { shots: [], skipped: [], finds: [], errors: [] };

const run = promisify(execFile);
async function focusWindow() {
  const ps = `$ws=New-Object -ComObject WScript.Shell;$ws.AppActivate('CodeAgent Desktop')|Out-Null`;
  try { await run('powershell', ['-NoProfile', '-Command', ps]); } catch { /* best effort */ }
}
async function shot(page, group, name, desc) {
  await focusWindow();
  await page.waitForTimeout(180);
  const file = `${group}/${name}.png`;
  await page.screenshot({ path: `${OUT}/${file}` }).catch(async () => {
    await focusWindow(); await page.waitForTimeout(300);
    await page.screenshot({ path: `${OUT}/${file}` });
  });
  manifest.shots.push({ file, scenario: group, desc });
  console.log('shot:', file);
}
const skip = (testId, reason) => { manifest.skipped.push({ testId, reason }); console.log('skip:', testId, '-', reason); };
const find = (id, note) => { manifest.finds.push({ id, note }); console.log('find:', id, '-', note); };

const browser = await chromium.connectOverCDP('http://localhost:9333');
const page = browser.contexts()[0].pages()[0];
for (const dir of ['A-shell', 'C-conv', 'E-git', 'J-settings']) mkdirSync(`${OUT}/${dir}`, { recursive: true });
page.on('pageerror', (e) => manifest.errors.push(String(e)));

try {
  // 0. reload to pick up the rebuilt renderer bundle
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4000);
  await shot(page, 'N-misc', '04-reloaded', '修复后重载的工作台');

  // 1. rail nav now has 命令面板/打开任务/打开扩展
  const rail = page.locator('.rail-nav, nav');
  await shot(page, 'A-shell', '12-rail-nav-wired', 'rail 导航含新入口（命令面板/任务/扩展）');

  // 2. command palette via Ctrl+K
  await page.keyboard.press('Control+k');
  await page.waitForTimeout(400);
  if (await page.locator('.command-palette').isVisible()) {
    await shot(page, 'A-shell', '13-command-palette', '命令面板 Ctrl+K 打开');
    const search = page.locator('[data-testid="command-palette-search"]');
    if (await search.isVisible()) {
      await search.fill('设置');
      await page.waitForTimeout(300);
      await shot(page, 'A-shell', '14-command-palette-filter', '命令面板搜索过滤');
      await search.fill('');
      await page.waitForTimeout(200);
    }
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
  } else skip('command-palette', 'Ctrl+K 未打开命令面板');

  // 3. EXTENSIONS surface via rail
  const extBtn = page.locator('button[aria-label="打开扩展"]');
  if (await extBtn.count()) {
    await extBtn.click(); await page.waitForTimeout(1200);
    await shot(page, 'A-shell', '15-extensions-surface', '扩展 surface（MCP/Skills/Hooks/Hub）');
    // MCP prompts tab resolve wiring (needs a configured server)
    const serverItem = page.locator('[data-testid="mcp-server"], .mcp-record').first();
    if (await serverItem.count()) { find('extensions-surface', '扩展 surface 有真实内容'); }
  } else skip('rail-extensions', 'rail 无扩展入口');

  // 4. MISSIONS surface
  const misBtn = page.locator('button[aria-label="打开任务"]');
  if (await misBtn.count()) {
    await misBtn.click(); await page.waitForTimeout(1000);
    await shot(page, 'A-shell', '16-missions-surface', '任务 surface');
  } else skip('rail-missions', 'rail 无任务入口');

  // 5. back to workspace + session row menu
  await page.locator('button[aria-label="会话"]').first().click();
  await page.waitForTimeout(800);
  const row = page.locator('.session-row-shell').first();
  if (await row.count()) {
    await row.hover();
    await page.waitForTimeout(300);
    const more = row.locator('button[aria-label="会话操作"]');
    if (await more.count()) {
      await more.click(); await page.waitForTimeout(350);
      await shot(page, 'A-shell', '17-session-row-menu', '会话行操作菜单（置顶/重命名/副本/归档）');
      await page.keyboard.press('Escape');
    } else skip('session-row-menu', '行内无会话操作按钮');
  }

  // 6. open a workspace session → header 计划/任务/详情
  const wsSession = page.locator('.session-row', { hasText: '审查' }).first();
  const anySession = (await wsSession.count()) ? wsSession : page.locator('.session-row').first();
  await anySession.click();
  await page.waitForTimeout(1200);
  const header = page.locator('[data-testid="conversation-header"]');
  // 2026-11-06: 计划/任务/详情/证据已收进「面板」菜单，需先开菜单
  const paneItem = async (tid) => {
    let el = page.locator(`[data-testid="${tid}"]`);
    if (!(await el.count())) {
      await page.getByTestId('conversation-header-panes').click().catch(() => {});
      await page.waitForTimeout(300);
      el = page.locator(`[data-testid="${tid}"]`);
    }
    return el;
  };
  if (await header.isVisible()) {
    await shot(page, 'C-conv', '30-header-wired', '会话头部新增 计划/任务/详情');
    const planBtn = await paneItem('conversation-header-plan');
    if (await planBtn.count()) {
      await planBtn.click(); await page.waitForTimeout(600);
      await shot(page, 'C-conv', '31-plan-pane', '计划面板（spec 起草/修订）');
      const revise = page.locator('[data-testid="spec-revise"]');
      if (await revise.isVisible()) { await revise.click(); await page.waitForTimeout(300); await shot(page, 'C-conv', '32-spec-revise', 'spec 修订表单（reviseSpec 接线）'); }
      await page.keyboard.press('Escape'); await page.waitForTimeout(300);
    } else skip('header-plan', '头部无计划按钮');
    const misPaneBtn = await paneItem('conversation-header-mission');
    if (await misPaneBtn.count()) {
      await misPaneBtn.click(); await page.waitForTimeout(600);
      await shot(page, 'C-conv', '33-mission-pane', '任务面板（mission create/decide/command）');
      await page.keyboard.press('Escape'); await page.waitForTimeout(300);
    }
    const detBtn = await paneItem('conversation-header-details');
    if (await detBtn.count()) {
      await detBtn.click(); await page.waitForTimeout(800);
      await shot(page, 'C-conv', '34-details-pane', '会话详情（权限摘要 + lane 段）');
      const lane = page.locator('[data-testid="workspace-lane-section"]');
      if (await lane.isVisible()) { find('workspace-lane', 'lane 段渲染（get/reopen 接线）'); }
      await page.keyboard.press('Escape'); await page.waitForTimeout(300);
    }
  } else skip('conversation-header', '会话头部不可见');

  // 7. evidence pane → ReviewFindings
  const evBtn = await paneItem('conversation-header-evidence');
  if (await evBtn.isEnabled()) {
    await evBtn.click(); await page.waitForTimeout(900);
    const review = page.locator('[data-testid="review-findings"]');
    if (await review.count()) {
      await shot(page, 'C-conv', '35-review-findings', '评审发现（createFixTask 接线）');
      if (await page.locator('[data-testid="create-fix-task"]').count()) find('create-fix-task', 'finding→修复任务按钮渲染');
    } else skip('review-findings', '证据面板无评审区块');
    await page.keyboard.press('Escape'); await page.waitForTimeout(300);
  } else skip('evidence-review', '证据按钮不可用（无关联 run）');

  // 8. Git surface → delivery history
  await page.locator('button[aria-label="Git"]').first().click();
  await page.waitForTimeout(1200);
  const hist = page.locator('[data-testid="delivery-history"]');
  if (await hist.count()) {
    await shot(page, 'E-git', '04-delivery-history', 'Git surface 交付记录（deliveries/list 接线）');
    find('deliveries-list', '交付记录区块渲染');
  } else {
    await shot(page, 'E-git', '04-delivery-history-absent', 'Git surface（无交付记录区块—无项目?）');
    skip('deliveries-list', '交付记录区块未渲染（当前 run 无项目或列表为空）');
  }

  // 9. settings → knowledge suggest
  await page.locator('button[aria-label="设置"]').first().click();
  await page.waitForTimeout(900);
  const knowNav = page.locator('text=知识').first();
  if (await knowNav.count()) {
    await knowNav.click(); await page.waitForTimeout(800);
    const sug = page.locator('[data-testid="knowledge-suggest-toggle"]');
    if (await sug.count()) {
      await sug.click(); await page.waitForTimeout(300);
      await shot(page, 'J-settings', '30-knowledge-suggest', '知识页提交建议（suggestKnowledge 接线）');
    } else skip('knowledge-suggest', '知识页无提交建议按钮（knowledge.manage 未声明）');
    await shot(page, 'J-settings', '31-knowledge-page', '知识页');
  }
  await page.locator('button:has-text("完成"), [aria-label="完成"]').first().click().catch(() => {});
  await page.waitForTimeout(500);
  await shot(page, 'N-misc', '05-final', '收尾状态');
} catch (e) {
  manifest.errors.push('sweep exception: ' + String(e));
  console.log('ERR', e);
}
manifest.lastRun = new Date().toISOString();
manifest.counts = { shots: manifest.shots.length, skipped: manifest.skipped.length, errors: manifest.errors.length };
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
console.log('DONE', JSON.stringify(manifest.counts));
await browser.close();
