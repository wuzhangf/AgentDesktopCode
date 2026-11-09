// Real browser -> built BFF -> current-source ACS/Product, deterministic
// PAUSE -> BFF restart -> RESUME -> STOP via the fixture model gate.
// Gate protocol: the fixture model writes request-<n> then blocks until
// allow-<n> exists; this script additionally uses restart-bff/bff-ready to
// coordinate a mid-flight BFF restart with the python harness.
import { chromium } from '@playwright/test';
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';

const URL = process.env.PERSONAL_WEB_TEST_URL;
const OUT = process.env.PERSONAL_WEB_TEST_OUT;
const GATE = process.env.PERSONAL_WEB_GATE_DIR;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const gatePath = name => path.join(GATE, name);
async function waitFile(name, timeout = 150000) {
  const deadline = Date.now() + timeout;
  while (!existsSync(gatePath(name))) {
    if (Date.now() > deadline) throw new Error('gate timeout waiting ' + name);
    await sleep(100);
  }
}
const touch = name => writeFile(gatePath(name), '');

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN' });
page.on('dialog', d => d.accept());
const errors = [];
page.on('pageerror', e => errors.push(e.message));

// Same-origin control read inside the page (carries the real personal headers).
const commands = (id, suffix = '') => page.evaluate(async ([id, suffix]) => {
  const headers = { 'x-personal-control': '1', 'x-personal-tab': sessionStorage.getItem('pae.personal.tabId') };
  const r = await fetch('/api/personal/v1/tasks/' + id + '/commands' + suffix, { headers });
  return { status: r.status, body: await r.json() };
}, [id, suffix]);
const detail = id => page.evaluate(async id => {
  const headers = { 'x-personal-control': '1', 'x-personal-tab': sessionStorage.getItem('pae.personal.tabId') };
  const r = await fetch('/api/personal/v1/tasks/' + id, { headers });
  return { status: r.status, body: await r.json() };
}, id);

async function pollUntil(fn, pred, what, timeout = 60000) {
  const deadline = Date.now() + timeout;
  let last;
  for (;;) {
    last = await fn();
    if (pred(last)) return last;
    if (Date.now() > deadline) throw new Error('poll timeout: ' + what + ' last=' + JSON.stringify(last).slice(0, 800));
    await sleep(500);
  }
}

const evidence = { steps: [] };
const step = (name, data) => evidence.steps.push({ name, ...data });

try {
  await page.goto(URL + '/personal.html#/tasks');
  const project = page.getByLabel('项目', { exact: true });
  await project.locator('option').nth(1).waitFor({ state: 'attached' });
  await project.selectOption(await project.locator('option').nth(1).getAttribute('value'));
  await page.getByLabel('任务要求', { exact: true }).fill('Change x.txt from v1 to v2 in the isolated workspace, then report the result.');
  await page.getByRole('button', { name: '开始任务', exact: true }).click();
  await page.waitForURL(/#\/tasks\/task-/, { timeout: 60000 });
  const taskId = page.url().split('/tasks/')[1];

  // Wait until the run is RUNNING with a model call in flight; earlier gated
  // requests may belong to pre-run phases (or the run view may still lag at
  // QUEUED), so poll briefly before releasing each blocked request.
  let seq = 0, running;
  for (;;) {
    await waitFile('request-' + (seq + 1));
    const view = await pollUntil(() => commands(taskId), r => {
      const v = r.body.data;
      return v?.run?.state === 'RUNNING' && (v.allowedIntents ?? []).includes('PAUSE')
        && (v.allowedIntents ?? []).includes('STOP') && typeof v.run.stateVersion === 'number';
    }, 'RUNNING+PAUSE during in-flight request ' + (seq + 1), 15000)
      .then(r => r.body.data).catch(() => null);
    if (view) { seq += 1; running = view; break; }
    seq += 1; await touch('allow-' + seq);
    if (seq > 6) throw new Error('run never reached controllable RUNNING');
  }
  step('running', { run: running.run, allowedIntents: running.allowedIntents });
  const runId = running.run.runId, sessionId = running.run.sessionId;

  // PAUSE through the real card button while request-<seq> is blocked.
  await page.getByRole('button', { name: '暂停', exact: true }).waitFor({ timeout: 30000 });
  await page.getByRole('button', { name: '暂停', exact: true }).click();
  await pollUntil(() => commands(taskId), r =>
    r.body.data?.pendingRequests?.some(p => p.request.intent === 'PAUSE')
    || r.body.data?.sourceCommands?.items?.some(i => i.intent === 'PAUSE'),
    'PAUSE request registered');
  step('pauseRegistered');

  // RC06/RC07: BFF restart while the PAUSE receipt is still unconfirmed; the
  // reopened page must recover the pending request from the server store.
  await touch('restart-bff');
  await waitFile('bff-ready');
  await page.reload();
  await page.getByText('运行控制').waitFor({ timeout: 30000 });
  const afterRestart = await pollUntil(() => commands(taskId), r =>
    (r.body.data?.pendingRequests ?? []).some(p => p.request.intent === 'PAUSE')
    || (r.body.data?.sourceCommands?.items ?? []).some(i => i.intent === 'PAUSE'),
    'PAUSE recovered after BFF restart');
  step('pauseRecoveredAfterRestart', { allowedIntents: afterRestart.body.data.allowedIntents });

  // Release the in-flight model call: the product consumes PAUSE at the next
  // boundary; the receipt must reach terminal APPLIED and the run PAUSED.
  await touch('allow-' + seq);
  const paused = await pollUntil(() => commands(taskId), r => {
    const v = r.body.data;
    const receipts = [...(v?.pendingRequests ?? []), ...(v?.sourceCommands?.items ?? [])];
    const pause = receipts.find(x => (x.request?.intent ?? x.intent) === 'PAUSE');
    const applied = (pause?.receipt ?? pause)?.phase === 'APPLIED';
    return v?.run?.state === 'PAUSED' && v?.run?.sourceStatus === 'PAUSED_FOR_HUMAN'
      && v?.run?.checkpointAvailable === true && applied;
  }, 'run PAUSED with APPLIED receipt', 120000);
  step('paused', { run: paused.body.data.run, allowedIntents: paused.body.data.allowedIntents });
  await page.getByText('状态：已暂停').waitFor({ timeout: 30000 });
  // RESUME may only be offered with a checkpoint; STOP stays available.
  if (!(paused.body.data.allowedIntents ?? []).includes('RESUME')) throw new Error('RESUME not offered while PAUSED_FOR_HUMAN');
  if (!(paused.body.data.allowedIntents ?? []).includes('STOP')) throw new Error('STOP not offered while PAUSED_FOR_HUMAN');
  if ((paused.body.data.allowedIntents ?? []).includes('PAUSE')) throw new Error('PAUSE must not be offered while PAUSED');

  // RESUME keeps the same run/session; the continuation issues the next
  // gated model call — proof the paused worktree/run resumed in place.
  await page.getByRole('button', { name: '继续', exact: true }).waitFor({ timeout: 30000 });
  await page.getByRole('button', { name: '继续', exact: true }).click();
  await waitFile('request-' + (seq + 1));
  seq += 1;
  const resumed = await pollUntil(() => commands(taskId), r =>
    r.body.data?.run?.state === 'RUNNING' && (r.body.data.allowedIntents ?? []).includes('PAUSE'),
    'run RUNNING after RESUME', 90000);
  step('resumed', { run: resumed.body.data.run });
  if (resumed.body.data.run.runId !== runId || resumed.body.data.run.sessionId !== sessionId)
    throw new Error('RESUME changed run/session binding');

  // STOP while request-<seq> is in flight; release it so the product can
  // observe the cancel; the run must end CANCELLED on the same run.
  await page.getByRole('button', { name: '停止', exact: true }).waitFor({ timeout: 30000 });
  await page.getByRole('button', { name: '停止', exact: true }).click();
  await touch('allow-' + seq);
  const stopped = await pollUntil(() => commands(taskId), r => {
    const v = r.body.data;
    const receipts = [...(v?.pendingRequests ?? []), ...(v?.sourceCommands?.items ?? [])];
    const stop = receipts.find(x => (x.request?.intent ?? x.intent) === 'STOP');
    const applied = (stop?.receipt ?? stop)?.phase === 'APPLIED';
    return v?.run?.state === 'CANCELLED' && applied;
  }, 'run CANCELLED with APPLIED STOP', 120000);
  step('stopped', { run: stopped.body.data.run, allowedIntents: stopped.body.data.allowedIntents });
  if ((stopped.body.data.allowedIntents ?? []).length !== 0) throw new Error('terminal run must not offer intents');

  // RC04 evidence: exactly one source command per intent, keys unchanged.
  const all = stopped.body.data.sourceCommands?.items ?? [];
  for (const intent of ['PAUSE', 'RESUME', 'STOP']) {
    if (all.filter(i => i.intent === intent).length !== 1)
      throw new Error('expected exactly one ' + intent + ' command: ' + JSON.stringify(all.map(i => i.intent)));
  }
  const finalDetail = await detail(taskId);
  const f = finalDetail.body.data;
  if (f.run?.runId !== runId || f.session?.sessionId !== sessionId)
    throw new Error('task detail binding changed: ' + JSON.stringify({ run: f.run?.runId, session: f.session?.sessionId }));
  step('final', { taskId, runId, sessionId, detailState: f.run?.state, detailStatus: finalDetail.status });

  if (errors.length) throw new Error('Browser errors: ' + errors.join(';'));
  await page.screenshot({ path: OUT + '/control-detail.png', fullPage: true });
  await writeFile(OUT + '/control-browser-result.json', JSON.stringify({ taskId, runId, sessionId, commands: all, ...evidence }, null, 2));
  console.log('BROWSER_CONTROL_PASS ' + taskId);
} catch (error) {
  await page.screenshot({ path: OUT + '/control-failure.png', fullPage: true }).catch(() => {});
  await writeFile(OUT + '/control-failure.txt', (await page.locator('body').innerText().catch(() => '')) + '\n' + error.stack).catch(() => {});
  throw error;
} finally { await browser.close(); }
