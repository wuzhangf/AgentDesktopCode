import assert from 'node:assert/strict';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {_electron as electron, expect} from '@playwright/test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const output = path.resolve(process.env.MAC_E2E_OUTPUT_DIR ?? '');
assert(process.env.MAC_E2E_READY_FILE && process.env.CODEAGENT_PERSONAL_ENDPOINT && process.env.MAC_E2E_OUTPUT_DIR, 'Run through verify-web-electron.py with its isolated runtime');
const ready = JSON.parse(await readFile(process.env.MAC_E2E_READY_FILE, 'utf8'));
assert.equal(ready.lane, 'electron');
assert.equal(ready.managementOrigin, process.env.CODEAGENT_PERSONAL_ENDPOINT);
await mkdir(output, {recursive: false});
const report = {schemaVersion: 'mac-electron-e2e/1', result: 'FAIL', transport: 'real Electron renderer → sandbox preload → IPC → main HTTP → production personal gateway → fixed Mac Host', identity: ready.identity, phases: []};
let app, page;
const errors = [];
async function launch() {
  const env = {...process.env, CODEAGENT_DESKTOP_PROFILE: 'mac-001-electron'};
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({executablePath: require('electron'), args: [root], cwd: root, env, timeout: 30_000});
  page = await app.firstWindow();
  page.on('pageerror', error => errors.push(error.message));
  await expect(page.getByRole('heading', {name: 'Mac 任务', exact: true})).toBeVisible();
  const security = await app.evaluate(({BrowserWindow}) => {
    const preferences = BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences();
    return {sandbox: preferences.sandbox, contextIsolation: preferences.contextIsolation, nodeIntegration: preferences.nodeIntegration};
  });
  assert.deepEqual(security, {sandbox: true, contextIsolation: true, nodeIntegration: false});
  report.security = security;
}
const facts = async () => JSON.parse(await page.getByTestId('task-facts').textContent());
const screenshot = name => page.screenshot({path: path.join(output, name + '.png'), fullPage: false});
async function choose(label) {
  await page.getByLabel('Mac 项目', {exact: true}).selectOption({label});
  await expect(page.getByTestId('mac-preflight')).toContainText('MAC_MANAGED', {timeout: 30_000});
}
async function waitFacts(predicate, timeout = 600_000) {
  let value;
  await expect.poll(async () => {try {value = await facts(); return predicate(value);} catch {return false;}}, {timeout, intervals: [500, 1000, 2500]}).toBe(true);
  return value;
}
try {
  await launch();
  await choose(ready.projectLabel);
  await page.getByLabel('Mac 任务要求', {exact: true}).fill('Run the registered Apple validation workflow and preserve its actual results.');
  await page.getByRole('button', {name: '开始 Mac 任务', exact: true}).click();
  await expect(page.getByTestId('task-facts')).toBeAttached({timeout: 120_000});
  const original = await facts(), key = await page.getByLabel('原请求键', {exact: true}).inputValue();
  assert.equal(original.request.requestKey, key);
  assert.equal(original.core, 'MACOS');
  assert.equal(original.sourceStoreId, ready.identity.storeId);
  report.create = original;
  report.originalRequestKey = key;
  report.phases.push('real UI create');
  await screenshot('01-created');
  await app.close(); app = undefined;
  await launch();
  await expect(page.getByLabel('原请求键', {exact: true})).toHaveValue(key);
  await page.getByRole('button', {name: '只读恢复原请求', exact: true}).click();
  await expect(page.getByTestId('task-id')).toHaveText(original.taskId);
  await waitFacts(value => value.taskId === original.taskId, 30_000);
  if (!(await facts()).accepted) {
    await page.getByRole('button', {name: '使用原键继续核对提交', exact: true}).click();
  }
  const completed = await waitFacts(value => value.accepted && value.native?.state === 'SUCCEEDED' && value.native.quiescent === true);
  assert.equal(completed.taskId, original.taskId);
  assert.equal(completed.request.requestKey, key);
  assert.equal(completed.native.engineId, 'macos');
  assert.equal(completed.executionBinding.workerId, ready.identity.workerId);
  report.completed = completed;
  report.phases.push('process restart → original-key recovery → actual Apple SUCCEEDED/quiescent');
  await expect(page.getByTestId('native-output')).not.toBeEmpty();
  await expect(page.getByTestId('native-activity')).not.toBeEmpty();
  await expect.poll(() => page.getByRole('button', {name: /^核验成果 /}).count(), {timeout: 30_000}).toBe(3);
  const artifactLabels = await page.getByRole('button', {name: /^核验成果 /}).allTextContents();
  assert.equal(artifactLabels.filter(value => value === '核验成果 verification-report').length, 1);
  assert.equal(artifactLabels.filter(value => /^核验成果 .+\.log$/.test(value)).length, 1);
  assert.equal(artifactLabels.filter(value => /^核验成果 .+-tests\.json$/.test(value)).length, 1);
  report.artifactPaths = artifactLabels.map(value => value.slice('核验成果 '.length));
  const verify = page.getByRole('button', {name: /^核验成果 /});
  for (let index = 0; index < await verify.count(); index++) {
    await expect(verify.nth(index)).toBeEnabled();
    await verify.nth(index).click();
    await expect.poll(() => page.getByTestId('verified-artifact').count()).toBe(index + 1);
  }
  report.artifactHashes = await page.getByTestId('verified-artifact').allTextContents();
  report.output = JSON.parse(await page.getByTestId('native-output').textContent());
  report.activities = JSON.parse(await page.getByTestId('native-activity').textContent());
  report.phases.push('public output/activity + actual artifact bytes SHA-256');
  await screenshot('02-completed-artifacts');
  await choose(ready.stopProjectLabel);
  await page.getByLabel('Mac 任务要求', {exact: true}).fill('Run the registered Apple validation workflow for the isolated STOP scope verification.');
  await page.getByRole('button', {name: '开始 Mac 任务', exact: true}).click();
  const running = await waitFacts(value => value.taskId !== original.taskId && value.native?.capabilities?.stop === true && value.native?.generation && value.native.currentCommandId && value.native.state === 'VERIFYING' && !value.native.quiescent, 120_000);
  let verifyingEvent;
  await expect.poll(async () => {
    try {
      const events = JSON.parse(await page.getByTestId('native-activity').textContent());
      const productEvents = events.items.filter(value => value.taskId === running.native.taskId && value.kind === 'PRODUCT_STATE');
      verifyingEvent = productEvents.at(-1);
      return (verifyingEvent?.phase ?? verifyingEvent?.fields?.phase) === 'verifying';
    } catch {return false;}
  }, {timeout: 30_000, intervals: [500, 1000]}).toBe(true);
  report.beforeStop = await facts();
  assert.equal(report.beforeStop.native.state, 'VERIFYING');
  report.stopDispatchObservation = {publicState: report.beforeStop.native.state, publicEvent: verifyingEvent};
  await page.getByRole('button', {name: '停止 Mac 任务', exact: true}).click();
  await expect(page.getByTestId('stop-facts')).toBeVisible({timeout: 30_000});
  await expect.poll(async () => {const value = JSON.parse(await page.getByTestId('stop-facts').textContent()); return value.receipt?.state;}, {timeout: 60_000}).toBe('OBSERVED');
  const stopped = await waitFacts(value => value.native?.remoteStopConfirmed === true && typeof value.native.localQuiescent === 'boolean', 120_000);
  report.stopped = stopped;
  report.stop = JSON.parse(await page.getByTestId('stop-facts').textContent());
  assert.equal(report.stop.request.generation, running.native.generation);
  assert.equal(report.stop.request.targetCommandId, running.native.currentCommandId);
  await page.getByRole('button', {name: '只读核对停止请求', exact: true}).click();
  await expect(page.getByRole('button', {name: '只读核对停止请求', exact: true})).toBeEnabled();
  report.phases.push('real guarded STOP + original stop request read reconciliation');
  await screenshot('03-stop-scope');
  assert.deepEqual(errors, []);
  report.result = 'PASS';
} catch (error) {
  report.error = {name: error.name, message: error.message};
  if (page) await screenshot('failure').catch(() => {});
} finally {
  report.rendererErrors = errors;
  if (app) await app.close().catch(() => {});
  await writeFile(path.join(output, 'result.json'), JSON.stringify(report, null, 2) + '\n');
  process.stdout.write(JSON.stringify({result: report.result, report: path.join(output, 'result.json'), phases: report.phases}) + '\n');
}
if (report.result !== 'PASS') process.exitCode = 1;
