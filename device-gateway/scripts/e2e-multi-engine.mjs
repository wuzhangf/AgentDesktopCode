// Repeatable live e2e: real pi host + real codex host + real device-gateway +
// a deterministic loopback model fixture. Drives the real phone contract:
// owner invitation → phone pairing request → owner approval → redeem →
// device token → per-backend options/preflight/launch → task SUCCEEDED.
// Fresh temp state per run — no code changes or cleanup needed between runs.
//
//   node scripts/e2e-multi-engine.mjs [run-label]
//
// Workers repo location: WORKERS_ROOT env, default <repo>/../workers-repo/workers (set WORKERS_ROOT).
// Codex engine binary:    CODEX_EXECUTABLE env, default the pinned
//                         workers/codex/vendor/.../codex binary.

import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'; // gateway phone listener uses a self-signed cert

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, '..');
const repoRoot = resolve(appRoot, '..');
const workersRoot = resolve(process.env.WORKERS_ROOT ?? join(repoRoot, '..', 'AgentWorkersCode'));
const piMain = join(workersRoot, 'pi', 'dist', 'host', 'main.js');
const codexWorker = join(workersRoot, 'codex', 'target', 'debug', 'codex-native-worker');
const codexExecutable = process.env.CODEX_EXECUTABLE
  ?? join(repoRoot, '.local', 'e2e-pac', 'package', 'vendor', 'aarch64-apple-darwin', 'bin', 'codex');
const gatewayEntry = join(appRoot, 'dist', 'device-gateway.mjs');
for (const [name, path] of [['pi host', piMain], ['codex worker', codexWorker], ['codex executable', codexExecutable], ['gateway', gatewayEntry]]) {
  assert(existsSync(path), `MISSING_${name.toUpperCase().replace(' ', '_')} ${path}`);
}

const sha256 = value => createHash('sha256').update(value).digest('hex');
const delay = ms => new Promise(r => setTimeout(r, ms));
const log = line => console.log(`[e2e] ${line}`);
const baseEnv = { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR };

const root = mkdtempSync(join(tmpdir(), 'pac-e2e-'));
const children = [];
const spawnLogged = (name, cmd, args, env) => {
  const child = spawn(cmd, args, { env: { ...baseEnv, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', err = '';
  child.stdout.on('data', b => { out += b.toString(); if (out.length > 65536) out = out.slice(-65536); });
  child.stderr.on('data', b => { err += b.toString(); if (err.length > 65536) err = err.slice(-65536); });
  children.push(child);
  return { child, out: () => out, err: () => err };
};
const cleanup = async keep => {
  for (const child of children.splice(0)) if (child.exitCode === null) { child.kill('SIGTERM'); }
  await delay(300);
  for (const child of children) if (child.exitCode === null) child.kill('SIGKILL');
  if (!keep) execFileSync('rm', ['-rf', root]);
};
const fail = async error => {
  console.error(`[e2e] FAIL ${error.message}\n[e2e] state kept at ${root}`);
  await cleanup(true);
  process.exit(1);
};

const readyLine = async (proc, name, pattern, timeoutMs = 60000) => {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const hit = pattern.exec(proc.out());
    if (hit) return hit;
    assert.equal(proc.child.exitCode, null, `${name}_EXITED ${proc.err().slice(-2000)}`);
    await delay(50);
  }
  throw new Error(`${name}_READY_TIMEOUT ${proc.err().slice(-2000)}`);
};

// ── deterministic loopback model fixture (Responses SSE + chat completions) ──
const MODEL_NAME = 'e2e-fixture-model';
const fixtureReply = 'E2E_MODEL_REPLY';
let fixtureRequests = 0;
const model = createServer(async (req, res) => {
  try {
    let raw = '';
    for await (const bytes of req) raw += bytes;
    const body = raw ? JSON.parse(raw) : {};
    fixtureRequests++;
    if (req.url.endsWith('/responses')) {
      const item = { id: 'msg_' + randomUUID(), type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: fixtureReply, annotations: [] }] };
      const response = { id: 'resp_' + randomUUID(), object: 'response', status: 'completed', model: body.model ?? MODEL_NAME, output: [item], usage: { input_tokens: 8, output_tokens: 4, total_tokens: 12, input_tokens_details: { cached_tokens: 0 } } };
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      const send = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
      send('response.created', { response: { ...response, status: 'in_progress', output: [] } });
      send('response.output_item.added', { output_index: 0, item });
      send('response.output_item.done', { output_index: 0, item });
      send('response.completed', { response });
      res.end();
      return;
    }
    if (req.url.endsWith('/chat/completions') || req.url.endsWith('/completions')) {
      const usage = { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 };
      if (body.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        const chunk = (delta, finish) => res.write('data: ' + JSON.stringify({ id: 'chatcmpl-e2e', object: 'chat.completion.chunk', created: 1, model: body.model ?? MODEL_NAME, choices: [{ index: 0, delta, finish_reason: finish }] }) + '\n\n');
        chunk({ role: 'assistant' }, null);
        chunk({ content: fixtureReply }, null);
        chunk({}, 'stop');
        res.write('data: {"id":"chatcmpl-e2e","object":"chat.completion.chunk","created":1,"model":"' + (body.model ?? MODEL_NAME) + '","choices":[],"usage":' + JSON.stringify(usage) + '}\n\n');
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'chatcmpl-e2e', object: 'chat.completion', created: 1, model: body.model ?? MODEL_NAME, choices: [{ index: 0, message: { role: 'assistant', content: fixtureReply }, finish_reason: 'stop' }], usage }));
      return;
    }
    res.writeHead(404).end('FIXTURE_ROUTE ' + req.url);
  } catch (error) {
    res.writeHead(500).end('FIXTURE_FAILURE ' + error.message);
  }
});
await new Promise(r => model.listen(0, '127.0.0.1', r));
const modelBase = `http://127.0.0.1:${model.address().port}/v1`;
log(`model fixture ${modelBase}`);

// ── worker token shared by every local host (mirrors LocalSessionSecrets) ──
const workerToken = randomBytes(32).toString('hex');
const workerEnv = {
  WORKER_LOCAL_TOKEN: workerToken,
  MODEL_DEFAULT_MODEL: MODEL_NAME,
  MODEL_BASE_URL: modelBase,
  MODEL_API_KEY: 'e2e-loopback-sentinel',
};

const gitInit = dir => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'README.md'), 'e2e workspace\n');
  execFileSync('git', ['init', dir], { stdio: 'ignore' });
  execFileSync('git', ['-C', dir, 'add', '.'], { stdio: 'ignore' });
  execFileSync('git', ['-C', dir, '-c', 'user.name=E2E', '-c', 'user.email=e2e@example.invalid', 'commit', '-m', 'baseline'], { stdio: 'ignore' });
};

// ── pi host (primary backend) ──
const piState = join(root, 'pi-state'), piProject = join(root, 'pi-workspace');
gitInit(piProject);
execFileSync('node', [piMain, 'init', '--state', piState, '--project', piProject, '--project-id', 'pi-workspace'], { env: { ...baseEnv, ...workerEnv }, stdio: 'pipe' });
const pi = spawnLogged('pi', 'node', [piMain, 'serve', '--state', piState, '--port', '0'], workerEnv);
const piReady = await readyLine(pi, 'PI', /LOCAL_TASK_READY (\{.*\})/).catch(fail);
const piOrigin = JSON.parse(piReady[1]).url;
const piIdentity = await (await fetch(piOrigin + '/local/v1/identity', { headers: { authorization: 'Bearer ' + workerToken } })).json();
const piStore = piIdentity.storeId;
log(`pi ready ${piOrigin} store=${piStore}`);

// ── codex host (extra backend) ──
const codexState = join(root, 'codex-state'), codexProject = join(root, 'codex-workspace');
gitInit(codexProject);
execFileSync(codexWorker, ['init', '--state', codexState, '--executable', codexExecutable, '--project', codexProject, '--project-id', 'codex-workspace', '--tool-profile', 'macos-in-process-v1', '--model', MODEL_NAME, '--base-url', modelBase], { env: { ...baseEnv, ...workerEnv }, stdio: 'pipe' });
const codex = spawnLogged('codex', codexWorker, ['serve', '--state', codexState, '--port', '0'], workerEnv);
const codexReady = await readyLine(codex, 'CODEX', /LOCAL_TASK_READY (\{.*\}|http:\/\/\S+)/).catch(fail);
const codexOrigin = codexReady[1].startsWith('{') ? JSON.parse(codexReady[1]).url : codexReady[1];
const codexIdentity = await (await fetch(codexOrigin + '/local/v1/identity', { headers: { authorization: 'Bearer ' + workerToken } })).json();
const codexStore = codexIdentity.storeId;
log(`codex ready ${codexOrigin} store=${codexStore}`);

// ── device-gateway ──
const freePort = async () => { const s = createServer(); await new Promise(r => s.listen(0, '127.0.0.1', r)); const p = s.address().port; await new Promise(r => s.close(r)); return p; };
const phonePort = await freePort(), ownerPort = await freePort();
const ownerToken = 'e2e-owner-' + randomBytes(16).toString('hex');
const ownerClient = 'e2e-owner-client-' + randomBytes(16).toString('hex');
mkdirSync(join(root, 'gateway-data'), { recursive: true });
mkdirSync(join(root, 'gateway-tls'), { recursive: true });
const gateway = spawnLogged('gateway', 'node', [gatewayEntry], {
  DEVICE_GATEWAY_BIND: '127.0.0.1',
  DEVICE_GATEWAY_PORT: String(phonePort),
  DEVICE_GATEWAY_OWNER_BIND: '127.0.0.1',
  DEVICE_GATEWAY_OWNER_PORT: String(ownerPort),
  DEVICE_GATEWAY_DATA_DIR: join(root, 'gateway-data'),
  DEVICE_GATEWAY_TLS_DIR: join(root, 'gateway-tls'),
  DEVICE_GATEWAY_TLS_CN: '127.0.0.1',
  DEVICE_GATEWAY_OWNER_TOKEN: ownerToken,
  DEVICE_GATEWAY_OWNER_CLIENT_TOKEN: ownerClient,
  DEVICE_GATEWAY_ALLOW_UNLICENSED_DEVELOPMENT: '1',
  DEVICE_GATEWAY_PAIRING_AUTO_APPROVE: '0',
  WORKER_LOCAL_URL: piOrigin,
  WORKER_LOCAL_TOKEN: workerToken,
  WORKER_LOCAL_CONNECTION_ID: 'e2e-pi',
  WORKER_LOCAL_EXTRA: JSON.stringify([{ url: codexOrigin, token: workerToken, connectionId: 'e2e-codex' }]),
});
const ownerBase = `http://127.0.0.1:${ownerPort}`;
const ownerHeaders = { authorization: 'Bearer ' + ownerToken, 'x-client-session': ownerClient, 'content-type': 'application/json' };
const ownerCall = async (method, path, body) => {
  const r = await fetch(ownerBase + path, { method, headers: ownerHeaders, body: body ? JSON.stringify(body) : undefined });
  const data = await r.json().catch(() => ({}));
  return { status: r.status, data };
};
let gatewayUp = false;
for (let i = 0; i < 400 && !gatewayUp; i++) {
  assert.equal(gateway.child.exitCode, null, 'GATEWAY_EXITED ' + gateway.err().slice(-2000));
  const r = await ownerCall('GET', '/api/v2/personal-access/pairing-requests').catch(() => ({ status: 0 }));
  if (r.status === 200) gatewayUp = true; else await delay(50);
}
assert(gatewayUp, 'GATEWAY_READY_TIMEOUT ' + gateway.err().slice(-2000));
log(`gateway phone=https://127.0.0.1:${phonePort} owner=${ownerBase}`);

const phoneBase = `https://127.0.0.1:${phonePort}`;
const phoneCall = async (method, path, { token, body, idem } = {}) => {
  const r = await fetch(phoneBase + path, { method, headers: { ...(token ? { authorization: 'Bearer ' + token } : {}), ...(body ? { 'content-type': 'application/json' } : {}), ...(idem ? { 'idempotency-key': idem } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const data = await r.json().catch(() => ({}));
  return { status: r.status, data };
};

try {
  // ── 1. owner creates invitation with both engine launch scopes ──
  const launchScopes = [
    { backendStoreId: piStore, projectId: 'pi-workspace', engineId: 'pi' },
    { backendStoreId: codexStore, projectId: 'codex-workspace', engineId: 'codex' },
  ];
  const invite = await ownerCall('POST', '/api/v2/personal-access/pairing-invitations', {
    requestId: 'inv-' + randomUUID(),
    resources: [],
    launchScopes,
    actions: ['OBSERVE', 'CONTROL', 'INTERACT', 'LAUNCH'],
  });
  assert.equal(invite.status, 201, 'INVITE ' + JSON.stringify(invite.data));
  log(`invitation ${invite.data.inviteId}`);

  // ── 2. phone submits pairing request ──
  const pollSecret = 'poll-' + randomBytes(16).toString('hex');
  const pair = await phoneCall('POST', '/personal/v1/pairing-requests', {
    body: {
      pairingRequestId: 'pair-' + randomUUID(),
      inviteId: invite.data.inviteId,
      inviteSecret: invite.data.inviteSecret,
      installationId: 'e2e-phone-' + randomUUID(),
      label: 'E2E Phone',
      pollingSecretHash: sha256(pollSecret),
    },
  });
  assert.equal(pair.status, 202, 'PAIR ' + JSON.stringify(pair.data));
  assert.equal(pair.data.state, 'PENDING');
  const pairId = pair.data.pairingRequestId ?? pair.data.id;
  log(`pairing request ${pairId} state=PENDING`);

  // ── 3. owner observes and approves ──
  const requests = await ownerCall('GET', '/api/v2/personal-access/pairing-requests');
  assert.equal(requests.status, 200);
  const pending = (requests.data.items ?? requests.data).find(r => (r.pairingRequestId ?? r.id) === pairId);
  assert(pending, 'PAIRING_NOT_VISIBLE_TO_OWNER');
  const decide = await ownerCall('POST', `/api/v2/personal-access/pairing-requests/${pairId}/decisions`, { approve: true });
  assert.ok([200, 201, 202, 204].includes(decide.status), 'DECIDE ' + JSON.stringify(decide.data));
  log('owner approved');

  // ── 4. phone redeems → device token ──
  const redeem = await phoneCall('POST', `/personal/v1/pairing-requests/${pairId}/redemptions`, { token: pollSecret, body: { redemptionId: 'redeem-' + randomUUID() } });
  assert.equal(redeem.status, 200, 'REDEEM ' + JSON.stringify(redeem.data));
  const deviceToken = redeem.data.accessToken ?? redeem.data.device?.accessToken;
  assert(deviceToken, 'NO_ACCESS_TOKEN ' + JSON.stringify(redeem.data).slice(0, 500));
  log('device redeemed, token issued');

  // ── 5. phone reads scope + per-backend options ──
  const localTasks = await phoneCall('GET', '/personal/v1/local-tasks', { token: deviceToken });
  assert.equal(localTasks.status, 200, 'LOCAL_TASKS ' + JSON.stringify(localTasks.data));
  const granted = localTasks.data.launchScopes ?? [];
  assert.equal(granted.length, 2, 'LAUNCH_SCOPES ' + JSON.stringify(granted));
  log(`launch scopes granted: ${granted.map(s => s.engineId + '@' + s.projectId).join(', ')}`);

  const launchOn = async (store, projectId, engineId, label) => {
    const options = await phoneCall('GET', `/personal/v1/local-tasks/${store}/options`, { token: deviceToken });
    assert.equal(options.status, 200, `${label} OPTIONS ` + JSON.stringify(options.data).slice(0, 400));
    const projects = options.data.projects ?? [];
    const engines = options.data.engines ?? [];
    assert(projects.some(p => (p.projectId ?? p.id) === projectId), `${label} PROJECT_MISSING ` + JSON.stringify(projects).slice(0, 300));
    assert(engines.some(e => (e.engineId ?? e.id) === engineId), `${label} ENGINE_MISSING ` + JSON.stringify(engines).slice(0, 300));

    const preflight = await phoneCall('POST', `/personal/v1/local-tasks/${store}/task-preflights`, { token: deviceToken, body: { projectId, engineId } });
    assert.equal(preflight.status, 200, `${label} PREFLIGHT ` + JSON.stringify(preflight.data).slice(0, 400));

    const requestKey = 'e2e-task-' + randomUUID();
    const created = await phoneCall('POST', `/personal/v1/local-tasks/${store}/tasks`, {
      token: deviceToken, idem: requestKey,
      body: { requestKey, projectId, engineId, optionsRevision: preflight.data.optionsRevision, instruction: 'Reply with the marker text only. Do not modify files.' },
    });
    assert.equal(created.status, 200, `${label} LAUNCH ` + JSON.stringify(created.data).slice(0, 400));
    const taskId = created.data.taskId;
    log(`${label} task ${taskId} launched on ${engineId}@${projectId}`);

    let detail;
    const deadline = Date.now() + 120000;
    while (Date.now() < deadline) {
      const r = await phoneCall('GET', `/personal/v1/local-tasks/${store}/tasks/${taskId}`, { token: deviceToken });
      assert.equal(r.status, 200, `${label} READ ` + JSON.stringify(r.data).slice(0, 300));
      detail = r.data;
      if (['SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT', 'REJECTED', 'UNKNOWN'].includes(detail.state)) break;
      await delay(500);
    }
    assert.equal(detail.state, 'SUCCEEDED', `${label} TERMINAL ` + JSON.stringify({ state: detail.state, reason: detail.reasonCode }));
    const output = await phoneCall('GET', `/personal/v1/local-tasks/${store}/tasks/${taskId}/output`, { token: deviceToken });
    log(`${label} task SUCCEEDED output=${JSON.stringify((output.data?.text ?? output.data ?? '').toString().slice(0, 80))}`);
    return { taskId, detail };
  };

  const piResult = await launchOn(piStore, 'pi-workspace', 'pi', 'pi');
  const codexResult = await launchOn(codexStore, 'codex-workspace', 'codex', 'codex');

  // ── 6. unknown backend is rejected, real backends unaffected ──
  const bogus = await phoneCall('GET', `/personal/v1/local-tasks/${'x'.repeat(64)}/options`, { token: deviceToken });
  assert.ok([400, 401, 403, 404, 502].includes(bogus.status), 'BOGUS_BACKEND ' + bogus.status);

  console.log(JSON.stringify({
    result: 'PASS',
    backends: { pi: piStore, codex: codexStore },
    tasks: { pi: piResult.taskId, codex: codexResult.taskId },
    modelRequests: fixtureRequests,
    run: root,
  }));
  await cleanup(false);
  process.exit(0);
} catch (error) {
  await fail(error);
}
