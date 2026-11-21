import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { parseArgs, parseEnv } from 'node:util';
import { install, installationPaths } from './install-transaction.mjs';
import { configureUpdater } from './configure-update.mjs';
import { collectDiagnostics, writeDiagnostics } from './diagnostics.mjs';

const source = dirname(fileURLToPath(import.meta.url));
const ownerRoot = '/api/v2/personal-access';

function ownerClient(failureCode) {
  const { config } = installationPaths();
  const local = parseEnv(readFileSync(join(config, 'env'), 'utf8'));
  const port = Number(local.DEVICE_GATEWAY_OWNER_PORT);
  const host = local.DEVICE_GATEWAY_OWNER_BIND ?? '127.0.0.1';
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !['127.0.0.1', '::1', 'localhost'].includes(host) ||
      !local.DEVICE_GATEWAY_OWNER_TOKEN || !local.DEVICE_GATEWAY_OWNER_CLIENT_TOKEN) {
    throw new Error('Invalid local owner configuration');
  }
  const endpoint = `http://${host === '::1' ? '[::1]' : host}:${port}${ownerRoot}`;
  return async (method, path, body) => {
    let response;
    try {
      response = await fetch(endpoint + path, { method, redirect: 'error', signal: AbortSignal.timeout(20000),
        headers: { Authorization: 'Bearer ' + local.DEVICE_GATEWAY_OWNER_TOKEN,
          'X-Client-Session': local.DEVICE_GATEWAY_OWNER_CLIENT_TOKEN, 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch { throw new Error('The Agent Link user service is unavailable'); }
    const result = await response.json();
    if (!response.ok) {
      const code = /^[A-Z0-9_]+$/.test(result?.code ?? '') ? result.code : failureCode;
      throw new Error(code);
    }
    return result;
  };
}

async function member() {
  const { values, positionals } = parseArgs({ args: process.argv.slice(3), allowPositionals: true,
    options: { origin: { type: 'string' } } });
  const [action] = positionals;
  if (positionals.length !== 1 || !['login', 'status', 'logout'].includes(action) ||
      (values.origin !== undefined && action !== 'login')) {
    throw new Error('Usage: sh install.sh member login [--origin HTTPS_ORIGIN] | status | logout');
  }
  const owner = ownerClient('MEMBER_REQUEST_FAILED');
  const path = '/member-session';
  if (action === 'status') {
    console.log((await owner('GET', path)).state);
    return;
  }
  if (action === 'logout') {
    const result = await owner('DELETE', path);
    console.log(result.remoteRevoked === false ? 'Signed out locally. Device revocation could not be confirmed.' : 'Signed out.');
    return;
  }
  const login = await owner('POST', path + '/login', { origin: values.origin });
  console.log(`Open ${login.verificationUrl} and approve device code ${login.userCode}.`);
  let retryAfterMs = login.retryAfterMs;
  while (Date.now() < login.expiresAt) {
    await delay(Math.max(100, retryAfterMs));
    const result = await owner('POST', path + '/poll', { id: login.id });
    if (result.state === 'signed_in') { console.log('Signed in.'); return; }
    if (result.state === 'denied') throw new Error('Device authorization declined');
    if (result.state !== 'pending') break;
    retryAfterMs = result.retryAfterMs;
  }
  throw new Error('Device authorization expired');
}

const identifier = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const scheduleGrantUsage = [
  'Usage: sh install.sh schedule-grant list',
  '       sh install.sh schedule-grant show DEVICE_ID',
  '       sh install.sh schedule-grant set DEVICE_ID --expected-revision REV --scope BACKEND/PROJECT/ENGINE [--scope ...]',
  '       sh install.sh schedule-grant withdraw DEVICE_ID --expected-revision REV',
].join('\n');

async function scheduleGrant() {
  const { values, positionals } = parseArgs({ args: process.argv.slice(3), allowPositionals: true,
    options: { 'expected-revision': { type: 'string' }, scope: { type: 'string', multiple: true } } });
  const [action, deviceId] = positionals;
  const write = action === 'set' || action === 'withdraw';
  const scope = values.scope ?? [];
  const revisionText = values['expected-revision'];
  const revision = Number(revisionText);
  if (action === 'help' && positionals.length === 1 && revisionText === undefined && !scope.length) {
    console.log(scheduleGrantUsage);
    return;
  }
  if (!['list', 'show', 'set', 'withdraw'].includes(action) ||
      positionals.length !== (action === 'list' ? 1 : 2) ||
      (action !== 'list' && !identifier.test(deviceId)) ||
      (write
        ? !/^\d+$/.test(revisionText ?? '') || !Number.isSafeInteger(revision)
        : revisionText !== undefined) ||
      (action === 'set' ? scope.length === 0 : scope.length !== 0)) {
    throw new Error(scheduleGrantUsage);
  }
  const launchScopes = scope.map(value => {
    const ids = value.split('/');
    if (ids.length !== 3 || !ids.every(id => identifier.test(id))) {
      throw new Error('Use BACKEND/PROJECT/ENGINE for each --scope. Run schedule-grant list to see the device targets.');
    }
    const [backendStoreId, projectId, engineId] = ids;
    return { backendStoreId, projectId, engineId };
  });
  const owner = ownerClient('SCHEDULE_GRANT_REQUEST_FAILED');
  if (action === 'list') {
    const devices = await owner('GET', '/devices');
    const view = devices.map(({ deviceGrantId, label, state, actions, launchScopes }) => ({
      deviceGrantId, label, state,
      eligibleTargets: state === 'ACTIVE' && actions.includes('LAUNCH')
        ? launchScopes.filter(target => target.engineId !== 'macos') : [],
    }));
    console.log(JSON.stringify(view, null, 2));
    return;
  }
  const path = `/devices/${deviceId}/local-schedule-grant`;
  try {
    const result = write
      ? await owner('PUT', path, { expectedRevision: revision, launchScopes })
      : await owner('GET', path);
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    if (error.message === 'REVISION_CONFLICT') {
      throw new Error('REVISION_CONFLICT. Run schedule-grant show again before changing this device.');
    }
    throw error;
  }
}

async function scheduleTransfer() {
  const usage = 'Usage: sh install.sh schedule-transfer local|cloud RULE_ID --request-key KEY --expected-revision REV';
  const { values, positionals } = parseArgs({ args: process.argv.slice(3), allowPositionals: true,
    options: { 'request-key': { type: 'string' }, 'expected-revision': { type: 'string' } } });
  const [destination, ruleId] = positionals;
  const requestKey = values['request-key'];
  const revision = values['expected-revision'];
  const expectedRevision = Number(revision);
  if (positionals.length !== 2 || !['local', 'cloud'].includes(destination) ||
      !identifier.test(ruleId ?? '') || !identifier.test(requestKey ?? '') ||
      !/^\d+$/.test(revision ?? '') || expectedRevision < 1 || expectedRevision >= 2_147_483_647) {
    throw new Error(usage);
  }
  const owner = ownerClient('SCHEDULE_TRANSFER_REQUEST_FAILED');
  const receipt = await owner('POST', `/schedule-ownership/${ruleId}`, { destination, requestKey, expectedRevision });
  console.log(JSON.stringify(receipt, null, 2));
}

async function main() {
  if (process.argv[2] === 'member') return member();
  if (process.argv[2] === 'schedule-grant') return scheduleGrant();
  if (process.argv[2] === 'schedule-transfer') return scheduleTransfer();
  if (process.argv[2] === 'diagnostics') {
    const { values } = parseArgs({ args: process.argv.slice(3),
      options: { prefix: { type: 'string' }, output: { type: 'string' } } });
    const report = collectDiagnostics(source, values.prefix);
    if (values.output === undefined) console.log(JSON.stringify(report, null, 2));
    else {
      try { writeDiagnostics(values.output, report); }
      catch (error) {
        throw new Error(error.code === 'EEXIST' ? 'The output file already exists' : 'Could not write the diagnostic report');
      }
      console.log('Saved the Agent Link diagnostic report.');
    }
    return;
  }
  const { values: args } = parseArgs({
    options: Object.fromEntries(['prefix', 'project', 'bind', 'port'].map(name => [name, { type: 'string' }])),
  });
  await install({ source, args });
  try {
    configureUpdater(args.prefix);
  } catch (error) {
    throw new Error(`Updater configuration failed after program installation: ${error.message}`, { cause: error });
  }
}

main().catch(error => {
  const command = ['member', 'schedule-grant', 'schedule-transfer', 'diagnostics'].includes(process.argv[2])
    ? process.argv[2] : 'install';
  console.error(`agent-link ${command}: ${error.message}`);
  process.exitCode = 1;
});
