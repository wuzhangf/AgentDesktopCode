import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { parseArgs, parseEnv } from 'node:util';
import { install, installationPaths } from './install-transaction.mjs';
import { configureUpdater } from './configure-update.mjs';
import { collectDiagnostics, writeDiagnostics } from './diagnostics.mjs';

const source = dirname(fileURLToPath(import.meta.url));

async function member() {
  const { values, positionals } = parseArgs({ args: process.argv.slice(3), allowPositionals: true,
    options: { origin: { type: 'string' } } });
  const [action] = positionals;
  if (positionals.length !== 1 || !['login', 'status', 'logout'].includes(action) ||
      (values.origin !== undefined && action !== 'login')) {
    throw new Error('Usage: sh install.sh member login [--origin HTTPS_ORIGIN] | status | logout');
  }
  const { config } = installationPaths();
  const local = parseEnv(readFileSync(join(config, 'env'), 'utf8'));
  const port = Number(local.DEVICE_GATEWAY_OWNER_PORT);
  const host = local.DEVICE_GATEWAY_OWNER_BIND ?? '127.0.0.1';
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !['127.0.0.1', '::1', 'localhost'].includes(host) ||
      !local.DEVICE_GATEWAY_OWNER_TOKEN || !local.DEVICE_GATEWAY_OWNER_CLIENT_TOKEN) {
    throw new Error('Invalid local owner configuration');
  }
  const endpoint = `http://${host === '::1' ? '[::1]' : host}:${port}/api/v2/personal-access/member-session`;
  async function call(method, path = '', body) {
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
      const code = /^[A-Z0-9_]+$/.test(result?.code ?? '') ? result.code : 'MEMBER_REQUEST_FAILED';
      throw new Error(code);
    }
    return result;
  }
  if (action === 'status') {
    console.log((await call('GET')).state);
    return;
  }
  if (action === 'logout') {
    const result = await call('DELETE');
    console.log(result.remoteRevoked === false ? 'Signed out locally. Device revocation could not be confirmed.' : 'Signed out.');
    return;
  }
  const login = await call('POST', '/login', { origin: values.origin });
  console.log(`Open ${login.verificationUrl} and approve device code ${login.userCode}.`);
  let retryAfterMs = login.retryAfterMs;
  while (Date.now() < login.expiresAt) {
    await delay(Math.max(100, retryAfterMs));
    const result = await call('POST', '/poll', { id: login.id });
    if (result.state === 'signed_in') { console.log('Signed in.'); return; }
    if (result.state === 'denied') throw new Error('Device authorization declined');
    if (result.state !== 'pending') break;
    retryAfterMs = result.retryAfterMs;
  }
  throw new Error('Device authorization expired');
}

async function main() {
  if (process.argv[2] === 'member') return member();
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
  const command = ['member', 'diagnostics'].includes(process.argv[2]) ? process.argv[2] : 'install';
  console.error(`agent-link ${command}: ${error.message}`);
  process.exitCode = 1;
});
