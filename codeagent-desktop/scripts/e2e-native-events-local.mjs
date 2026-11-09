// Local E2E witness (worker-events/1 → personal gateway → Electron main → IPC
// → renderer). Requires a running management server at
// CODEAGENT_PERSONAL_ENDPOINT and an existing native taskId (arg 1).
// Not part of `pnpm test`; run manually for real-chain evidence.
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from '@playwright/test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const taskId = process.argv[2];
if (!taskId || !process.env.CODEAGENT_PERSONAL_ENDPOINT) {
  console.error('usage: CODEAGENT_PERSONAL_ENDPOINT=… node scripts/e2e-native-events-local.mjs <taskId>');
  process.exit(2);
}
const env = { ...process.env, CODEAGENT_DESKTOP_PROFILE: 'native-events-e2e' };
delete env.ELECTRON_RUN_AS_NODE;

const app = await electron.launch({
  executablePath: require('electron'),
  args: [root, '--enable-logging'],
  cwd: root,
  env,
  timeout: 30_000,
});
app.process().stdout.on('data', chunk => process.stdout.write('[main] ' + String(chunk).replace(/\n/g, '\n[main] ')));
app.process().stderr.on('data', chunk => process.stdout.write('[main!] ' + String(chunk).replace(/\n/g, '\n[main!] ')));

const page = await app.firstWindow();
page.on('console', msg => {
  const text = msg.text();
  if (text.includes('native-events-recv')) console.log('[page-recv]', text.slice(0, 300));
  else if (msg.type() === 'error' || msg.type() === 'warning') console.log('[page]', msg.type(), text.slice(0, 300));
});
page.on('pageerror', error => console.log('[pageerror]', error.message));

const t0 = Date.now();
const dumpBody = async () => {
  const text = await page.locator('body').innerText().catch(e => `<unreadable: ${e.message}>`);
  console.log(`[e2e] body@${((Date.now() - t0) / 1000).toFixed(0)}s:\n${text.slice(0, 1200)}`);
};

console.log('[e2e] waiting for sidebar native section');
// The section renders whenever the personal gateway is configured; the list
// <ul> only exists once items load — wait for the section, then branch.
await page.getByTestId('sidebar-section-native').waitFor({ timeout: 60_000 }).catch(async (e) => {
  console.log('[e2e] sidebar-section-native missing:', e.message.split('\n')[0]);
  await dumpBody();
  await page.screenshot({ path: path.join(root, '.local-e2e-native.png') }).catch(() => {});
  await app.close();
  process.exit(3);
});
await dumpBody();

// Wait until the native task index has items (empty state is a <p>, list is a <ul>).
const list = page.getByTestId('native-task-list');
const emptyNote = page.locator('#sidebar-native-items');
try {
  await list.waitFor({ timeout: 30_000 });
} catch {
  console.log('[e2e] native-task-list not rendered; sidebar content:',
    JSON.stringify(await emptyNote.innerText().catch(() => '<none>')));
  await dumpBody();
  await page.screenshot({ path: path.join(root, '.local-e2e-native.png') }).catch(() => {});
  await app.close();
  process.exit(4);
}

const row = page.getByTestId(`native-task-row-${taskId}`);
await row.waitFor({ timeout: 30_000 });
console.log('[e2e] clicking native task row →', taskId);
await row.click();
await page.getByTestId('native-conversation').waitFor({ timeout: 30_000 });
console.log('[e2e] native-conversation mounted; observing live tail + transcript');

// Observe the live tail + transcript for up to 90 s — log EVERY sample so the
// typewriter progression is visible, not just state transitions.
const deadline = Date.now() + 90_000;
let sample = 0;
while (Date.now() < deadline) {
  const tail = await page.getByTestId('native-message-native-live-tail').textContent().catch(() => null);
  const msgs = await page.locator('.message-turn').count().catch(() => 0);
  const note = await page.getByTestId('native-stream-note').first().textContent().catch(() => null);
  sample += 1;
  if (sample <= 12 || tail === null || sample % 20 === 0) {
    console.log(`[e2e] t=${((Date.now() - t0) / 1000).toFixed(1)}s liveTail=${JSON.stringify(tail)} messageTurns=${msgs} note=${JSON.stringify(note)}`);
  }
  await new Promise(r => setTimeout(r, 200));
}
const facts = await page.getByTestId('native-facts').textContent().catch(() => '<none>');
console.log('[e2e] final native-facts:', facts?.slice(0, 2000));
const body = await page.locator('.native-conversation').innerText().catch(() => '<none>');
console.log('[e2e] final conversation text:\n' + body.slice(0, 2500));
await page.screenshot({ path: path.join(root, '.local-e2e-native.png') }).catch(() => {});
console.log('[e2e] done; closing');
await app.close();
