import { randomBytes, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync,
  renameSync, rmSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { homedir, hostname } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { parseEnv } from 'node:util';
import { pruneVersions, readSlot, setSlot, stageVersion, syncPath, writeAtomic } from './slots.mjs';

const service = 'agent-link.service';
const preparation = '/api/v2/personal-access/update-preparation';

export class InstallationDeferred extends Error {}

export function systemctl(...args) {
  const run = spawnSync('systemctl', ['--user', ...args], { encoding: 'utf8', timeout: 25_000 });
  if (run.status !== 0) throw new Error(`systemctl ${args[0]} failed: ${run.stderr?.trim() || run.error?.message || run.status}`);
  return run.stdout.trim();
}

function canonical(path) {
  if (!path || /[\u0000-\u001f\u007f]/.test(path)) throw new Error('Invalid installation path');
  const full = resolve(path);
  if (existsSync(full)) return realpathSync(full);
  return join(canonical(dirname(full)), full.split('/').at(-1));
}

function overlaps(first, second) {
  const child = (parent, path) => {
    const suffix = relative(parent, path);
    return suffix === '' || (!isAbsolute(suffix) && suffix !== '..' && !suffix.startsWith('../'));
  };
  return child(first, second) || child(second, first);
}

const quote = value => '"' + String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"') + '"';
const unitPath = value => quote(value.replaceAll('%', '%%'));
const execPath = value => unitPath(value.replaceAll('$', '$$'));

async function probePort(host) {
  const server = createServer();
  await new Promise((done, reject) => server.once('error', reject).listen(0, host, done));
  const { port } = server.address();
  await new Promise(done => server.close(done));
  return port;
}

async function defaults({ bind, port }, data, project, prefix) {
  const token = () => randomBytes(32).toString('hex');
  return {
    DEVICE_GATEWAY_DATA_DIR: data,
    DEVICE_GATEWAY_BIND: bind ?? '0.0.0.0',
    DEVICE_GATEWAY_PORT: port ?? await probePort('0.0.0.0'),
    DEVICE_GATEWAY_OWNER_BIND: '127.0.0.1',
    DEVICE_GATEWAY_OWNER_PORT: await probePort('127.0.0.1'),
    DEVICE_GATEWAY_OWNER_TOKEN: token(),
    DEVICE_GATEWAY_OWNER_CLIENT_TOKEN: token(),
    DEVICE_GATEWAY_HOOKS_PORT: await probePort('127.0.0.1'),
    DEVICE_GATEWAY_HOOKS_TOKEN: token(),
    DEVICE_GATEWAY_DISPLAY_NAME: hostname().split('.')[0],
    DEVICE_GATEWAY_PROFILE: 'LOCAL_CLI',
    CLI_BRIDGE_HOST: join(prefix, 'cli-bridge.mjs'),
    CLI_BRIDGE_PROJECT: project,
  };
}

async function owner(config, method = 'GET', path = preparation, operationId) {
  const port = Number(config.DEVICE_GATEWAY_OWNER_PORT);
  const host = config.DEVICE_GATEWAY_OWNER_BIND ?? '127.0.0.1';
  if (!Number.isInteger(port) || port < 1 || port > 65535 ||
      !['127.0.0.1', '::1', 'localhost'].includes(host) ||
      !config.DEVICE_GATEWAY_OWNER_TOKEN || !config.DEVICE_GATEWAY_OWNER_CLIENT_TOKEN) {
    throw new Error('Invalid local owner configuration');
  }
  const reply = await fetch(`http://${host === '::1' ? '[::1]' : host}:${port}${path}`, {
    method, redirect: 'error', signal: AbortSignal.timeout(method === 'GET' ? 750 : 6500),
    headers: {
      Authorization: `Bearer ${config.DEVICE_GATEWAY_OWNER_TOKEN}`,
      'X-Client-Session': config.DEVICE_GATEWAY_OWNER_CLIENT_TOKEN,
      'Content-Type': 'application/json',
    },
    ...(operationId !== undefined ? { body: JSON.stringify({ operationId }) } : {}),
  });
  if (reply.status === 409 && path === preparation && method === 'POST') {
    throw new InstallationDeferred('Gateway update check returned HTTP 409');
  }
  if (!reply.ok) throw new Error(`Gateway update check returned HTTP ${reply.status}`);
  return reply.json();
}

async function reserve(config, operationId) {
  const reply = await owner(config, 'POST', preparation, operationId);
  if (reply.state !== 'held' || reply.operationId !== operationId || typeof reply.bootId !== 'string') {
    const reason = /^[A-Z_]+$/.test(reply.reason ?? '') ? reply.reason : 'UNCONFIRMED';
    throw new InstallationDeferred(`Gateway cannot stop for installation: ${reason}`);
  }
  const live = await owner(config);
  if (live.state !== 'held' || live.operationId !== operationId || live.bootId !== reply.bootId ||
      !Number.isSafeInteger(live.expiresAt) || live.expiresAt < Date.now() + 5_000) {
    throw new InstallationDeferred('Gateway installation reservation is no longer valid');
  }
}

async function awaitCandidate(config, operationId) {
  for (let attempt = 0; attempt < 30; attempt++) {
    const state = await owner(config).catch(() => undefined);
    if (state?.state === 'starting' && state.ready === true && state.operationId === operationId &&
        typeof state.bootId === 'string') return;
    const status = systemctl('show', service, '--property=SubState', '--value');
    if (['dead', 'failed', 'auto-restart'].includes(status)) break;
    await delay(250);
  }
  throw new Error('Candidate gateway did not pass startup health');
}

function optionalFile(path) {
  if (!existsSync(path)) return undefined;
  if (!lstatSync(path).isFile() || realpathSync(path) !== path) throw new Error('Installation file must be regular');
  return readFileSync(path);
}

function unitFor(source, launcher, prefix, project, data, config, envFile) {
  const values = {
    '@START@': `${execPath(launcher)} ${execPath(prefix)} ${execPath(project)}`,
    '@DATA@': unitPath(data), '@CONFIG@': unitPath(config), '@PROJECT@': unitPath(project),
    '@ENV_FILE@': envFile.replaceAll('%', '%%'),
  };
  return readFileSync(join(source, 'systemd/agent-link.service'), 'utf8')
    .replace(/@[A-Z_]+@/g, name => values[name]);
}

function syncSnapshot(path) {
  const metadata = lstatSync(path);
  if (metadata.isDirectory()) {
    for (const name of readdirSync(path)) syncSnapshot(join(path, name));
  }
  if (metadata.isFile() || metadata.isDirectory()) syncPath(path);
}

function recoveryDirectory(recovery, data) {
  if (typeof recovery !== 'string' || dirname(recovery) !== dirname(data) ||
      !/^\.agent-link-recovery-[A-Za-z0-9]+$/.test(relative(dirname(data), recovery)) ||
      realpathSync(recovery) !== recovery || !lstatSync(recovery).isDirectory()) {
    throw new Error('Invalid installation recovery directory');
  }
  return recovery;
}

function restore({ program, marker, journal, data, unit, envFile }, change) {
  const recovery = recoveryDirectory(change.recovery, data);
  if (systemctl('show', service, '--property=FragmentPath', '--value')) systemctl('stop', service);
  setSlot(program, 'current', change.current);
  setSlot(program, 'previous', change.previous);

  const restoreData = join(recovery, 'restore-data');
  const failedData = join(recovery, 'failed-data');
  if (change.hadData) {
    rmSync(restoreData, { recursive: true, force: true });
    cpSync(join(recovery, 'original-data'), restoreData, { recursive: true, verbatimSymlinks: true });
    syncSnapshot(restoreData);
  }
  rmSync(failedData, { recursive: true, force: true });
  if (existsSync(data)) renameSync(data, failedData);
  if (change.hadData) renameSync(restoreData, data);
  syncPath(dirname(data));

  if (change.hadUnit) writeAtomic(unit, readFileSync(join(recovery, 'original-unit')), 0o644);
  else if (existsSync(unit)) {
    if (systemctl('show', service, '--property=FragmentPath', '--value')) systemctl('disable', unit);
    rmSync(unit);
    syncPath(dirname(unit));
  }
  if (!change.hadEnv) rmSync(envFile, { force: true });
  // Record a completed restoration before letting the old service admit work.
  writeAtomic(journal, JSON.stringify({ ...change, restored: true }));
  rmSync(marker);
  syncPath(program);
  systemctl('daemon-reload');
  if (change.wasActive) systemctl('start', service);
}

export function installationPaths(requestedPrefix) {
  const home = homedir();
  const prefix = canonical(requestedPrefix ?? join(process.env.XDG_DATA_HOME ?? join(home, '.local/share'), 'agent-link'));
  const xdgConfig = canonical(process.env.XDG_CONFIG_HOME ?? join(home, '.config'));
  const config = canonical(join(xdgConfig, 'agent-link'));
  const unitDir = canonical(join(xdgConfig, 'systemd/user'));
  return { home, prefix, xdgConfig, config, unitDir, program: join(prefix, 'program'), updateRoot: join(prefix, 'updates') };
}

export async function install({ source, args, release, confirmCandidate, authorizeStop, recoverOnly = false }) {
  const { home, prefix, config, unitDir, program, updateRoot } = installationPaths(args.prefix);
  const marker = join(program, 'pending');
  const journal = join(program, 'transaction.json');
  const lastFailure = join(program, 'last-failed-build');
  const envFile = join(config, 'env');
  const unit = join(unitDir, service);
  const oldEnv = optionalFile(envFile);
  const prior = oldEnv ? parseEnv(oldEnv.toString()) : undefined;
  const configuredData = prior?.DEVICE_GATEWAY_DATA_DIR ?? join(prefix, 'data');
  if (!isAbsolute(configuredData)) throw new Error('Agent Link state needs an absolute directory');
  const data = canonical(configuredData);
  const project = canonical(prior?.CLI_BRIDGE_PROJECT ?? args.project ?? join(home, 'agent-link-projects'));
  if (overlaps(prefix, config) || overlaps(program, data) || overlaps(program, project) ||
      overlaps(data, project) || overlaps(data, config) || overlaps(updateRoot, data) ||
      overlaps(updateRoot, project) || (source && overlaps(source, program))) {
    throw new Error('Program, configuration, project and state directories must be separate');
  }
  systemctl('show-environment');
  const oldUnit = optionalFile(unit);
  const installedUnit = systemctl('show', service, '--property=FragmentPath', '--value');
  const serviceState = systemctl('show', service, '--property=ActiveState', '--value');
  if (!['inactive', 'failed', 'active'].includes(serviceState)) throw new Error('The user service is changing state');
  const active = serviceState === 'active';
  if ((installedUnit && canonical(installedUnit) !== unit) || (active && !prior) ||
      (oldUnit && !oldUnit.toString().includes(unitPath(prefix).slice(1, -1) + '/'))) {
    throw new Error('The user service belongs to a different installation');
  }
  mkdirSync(program, { recursive: true, mode: 0o700 });
  if (realpathSync(program) !== program) throw new Error('Program directory must be local');
  const transaction = { program, marker, journal, data, unit, envFile };
  if (existsSync(journal)) {
    const priorChange = JSON.parse(readFileSync(journal, 'utf8'));
    if (priorChange.data !== data) throw new Error('The interrupted installation used a different state directory');
    const interrupted = existsSync(marker);
    if (interrupted) restore(transaction, priorChange);
    else if (priorChange.restored && priorChange.wasActive) {
      systemctl('daemon-reload');
      systemctl('start', service);
    }
    if ((interrupted || priorChange.restored) && priorChange.releaseId &&
        /^versions\/[1-9][0-9]*$/.test(priorChange.candidate)) {
      writeAtomic(lastFailure, priorChange.candidate + '\n');
    }
    if (interrupted || priorChange.restored) pruneVersions(program, [priorChange.current, priorChange.previous]);
    if (existsSync(priorChange.recovery)) {
      rmSync(recoveryDirectory(priorChange.recovery, data), { recursive: true });
    }
    rmSync(journal);
    syncPath(program);
    return install({ source, args, release, confirmCandidate, authorizeStop, recoverOnly });
  }
  // The marker is created before the journal and before touching live files.
  if (existsSync(marker)) {
    rmSync(marker);
    syncPath(program);
  }
  if (recoverOnly) return { active };
  if (release && !active) throw new InstallationDeferred('Gateway is stopped');
  const current = readSlot(program, 'current');
  const previous = readSlot(program, 'previous');
  const candidate = stageVersion(program, source, release);
  if (current && Number(candidate.split('/')[1]) < Number(current.split('/')[1])) {
    pruneVersions(program, [current, previous]);
    throw new Error('An older build cannot replace the current program');
  }
  const operationId = randomUUID();
  const desired = prior ?? await defaults(args, data, project, prefix);
  const candidateUnit = unitFor(join(program, candidate), join(program, 'current/launch.sh'), prefix, project, data, config, envFile);
  if (current === candidate && active && oldUnit?.toString() === candidateUnit) {
    console.log('Agent Link is current');
    return;
  }
  mkdirSync(config, { recursive: true, mode: 0o700 });
  mkdirSync(unitDir, { recursive: true });
  mkdirSync(project, { recursive: true });
  mkdirSync(dirname(data), { recursive: true });
  const recovery = mkdtempSync(join(dirname(data), '.agent-link-recovery-'));
  let stopped = false;
  let committed = false;
  let recoverable = false;
  let change;
  try {
    await confirmCandidate?.();
    try {
      if (active) {
        await reserve(desired, operationId);
        authorizeStop?.();
        systemctl('stop', service);
        stopped = true;
      }
    } finally {
      if (active && !stopped) await owner(desired, 'POST', preparation + '/release', operationId).catch(() => {});
    }
    const hadData = existsSync(data);
    if (hadData) {
      if (!lstatSync(data).isDirectory()) throw new Error('Agent Link state is not a directory');
      const snapshot = join(recovery, 'original-data');
      cpSync(data, snapshot, { recursive: true, verbatimSymlinks: true });
      syncSnapshot(snapshot);
    }
    if (oldUnit) writeAtomic(join(recovery, 'original-unit'), oldUnit);
    syncPath(recovery);
    syncPath(dirname(recovery));
    writeAtomic(marker, operationId + '\n');
    const record = { recovery, data, current, previous, hadData, operationId,
      candidate, ...(release ? { releaseId: release.releaseId, sha256: release.artifact.sha256 } : {}),
      hadUnit: Boolean(oldUnit), hadEnv: Boolean(oldEnv), wasActive: active };
    writeAtomic(journal, JSON.stringify(record));
    change = record;
    mkdirSync(data, { recursive: true, mode: 0o700 });
    if (!oldEnv) writeAtomic(envFile, Object.entries(desired).map(([key, value]) => `${key}=${quote(value)}\n`).join(''));
    setSlot(program, 'current', candidate);
    writeAtomic(unit, candidateUnit, 0o644);
    systemctl('daemon-reload');
    if (!systemctl('show', service, '--property=FragmentPath', '--value')) systemctl('link', unit);
    systemctl('start', service);
    await awaitCandidate(desired, operationId);
    systemctl('enable', unit);
    if (current !== candidate) setSlot(program, 'previous', current);
    rmSync(marker);
    committed = true;
    syncPath(program);
    pruneVersions(program, [candidate, current === candidate ? previous : current]);
    if (optionalFile(lastFailure)?.toString().trim() === candidate) rmSync(lastFailure);
    console.log(`agent-link.service: active (build ${candidate.split('/')[1]})`);
    console.log(`hooks installer: ${join(program, 'current/hooks/install.py')}`);
  } catch (error) {
    if (committed) throw error;
    try {
      if (change) {
        restore(transaction, change);
        writeAtomic(lastFailure, candidate + '\n');
      }
      else {
        rmSync(marker, { force: true });
        syncPath(program);
        if (stopped) systemctl('start', service);
      }
      recoverable = true;
    } catch (recoveryError) {
      throw new Error(`${error.message}. Recovery failed: ${recoveryError.message}. Preserved state at ${recovery}`, { cause: error });
    }
    throw error;
  } finally {
    if (committed || recoverable) {
      rmSync(journal, { force: true });
      syncPath(program);
      rmSync(recovery, { recursive: true, force: true });
      if (recoverable) pruneVersions(program, [current, previous]);
    }
  }
}
