// Batch 4: simplified model configuration UI (quick-add card + collapsed
// session advanced options). Attaches to the running Electron via CDP.
import path from 'node:path';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const webRequire = createRequire(path.resolve(root, '../control-plane-web/package.json'));
const { chromium } = webRequire('@playwright/test');

const OUT = 'E:/E2E-Test/electron/2026-11-04-01';
const dir = path.join(OUT, 'Q-models-quick');
fs.mkdirSync(dir, { recursive: true });

const manifest = [];
const skipped = [];
const errors = [];

async function shot(page, name, desc) {
  try {
    await page.bringToFront();
    await page.waitForTimeout(250);
    const file = path.join(dir, `${name}.png`);
    await page.screenshot({ path: file });
    manifest.push({ file: `Q-models-quick/${name}.png`, desc });
    console.log(`[shot] ${name}`);
  } catch (failure) {
    errors.push({ name, error: String(failure) });
    console.log(`[err] ${name}: ${failure}`);
  }
}

const browser = await chromium.connectOverCDP('http://127.0.0.1:9333');
const context = browser.contexts()[0];
const page = context.pages().find((p) => p.url().startsWith('app://')) ?? context.pages()[0];
page.setDefaultTimeout(8000);

// Reload so the running app picks up the new bundle.
await page.reload();
await page.waitForTimeout(3000);

// Navigate to settings → models.
await page.locator('button[title="设置"]').first().click().catch(() => {});
await page.waitForTimeout(1200);
const cats = page.locator('.settings-category');
const catNames = await cats.allTextContents();
const modelIdx = catNames.findIndex((name) => /模型|model/i.test(name));
if (modelIdx >= 0) {
  await cats.nth(modelIdx).click();
  await page.waitForTimeout(1200);
} else {
  errors.push({ name: 'nav', error: `models category not found in: ${catNames.join(', ')}` });
}

await shot(page, '01-models-page-top', '模型页顶部：模型目录 + 默认模型行');
await page.evaluate(() => document.querySelector('[data-testid="quick-add-card"]')?.scrollIntoView({ block: 'center' }));
await shot(page, '02-quick-add-card', '快速接入卡：提供商预设 + Key + 模型名，三个字段');

// Expanded custom mode.
const target = page.locator('[data-testid="quick-target"]');
if (await target.isVisible().catch(() => false)) {
  await target.selectOption('custom');
  await page.waitForTimeout(300);
  await shot(page, '03-quick-add-custom', '快速接入-自定义：露出 Base URL + 协议两个额外字段，其余仍默认');
  await target.selectOption('preset:opencode-zen');
  await page.waitForTimeout(300);
  await shot(page, '04-quick-add-zen', '快速接入-OpenCode Zen 预设：协议与地址已由预设打包（含 OPENAI_RESPONSES 方言）');
} else {
  skipped.push({ name: '03-quick-add-custom', reason: 'quick-add-card not rendered (catalog unavailable)' });
}

// Provider list below the quick card.
const list = page.locator('[data-testid="provider-list"]');
if (await list.isVisible().catch(() => false)) {
  await list.scrollIntoViewIfNeeded();
  await shot(page, '05-provider-list', '提供商列表：凭据状态徽章 + 编辑/删除/添加模型入口');
}

// Session model section: advanced options collapsed by default.
const sessionSection = page.locator('[data-testid="session-model-section"]');
if (await sessionSection.isVisible().catch(() => false)) {
  await sessionSection.scrollIntoViewIfNeeded();
  await shot(page, '06-session-model-collapsed', '会话模型：模型选择为主路径，思考强度/上下文折叠在高级选项');
  const adv = page.locator('[data-testid="session-model-advanced"] > summary');
  if (await adv.isVisible().catch(() => false)) {
    await adv.click();
    await page.waitForTimeout(300);
    await shot(page, '07-session-model-advanced-open', '会话高级选项展开：思考强度 + 上下文长度');
  }
} else {
  skipped.push({ name: '06-session-model-collapsed', reason: 'no session selected' });
}

// Merge into manifest.json.
const manifestPath = path.join(OUT, 'manifest.json');
const existing = fs.existsSync(manifestPath)
  ? JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  : { shots: [], skipped: [], finds: [], errors: [] };
existing.shots = (existing.shots ?? []).filter((s) => !String(s.file).startsWith('Q-models-quick/'));
existing.shots.push(...manifest);
existing.skipped = (existing.skipped ?? []).filter((s) => !String(s.name ?? '').startsWith('0'));
for (const s of skipped) existing.skipped.push(s);
for (const e of errors) existing.errors.push(e);
fs.writeFileSync(manifestPath, JSON.stringify(existing, null, 2));
console.log(`done: ${manifest.length} shots, ${skipped.length} skipped, ${errors.length} errors`);
