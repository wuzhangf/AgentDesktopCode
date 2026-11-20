import { spawnSync } from 'node:child_process';
import {
  closeSync, constants, fstatSync, linkSync, mkdtempSync, openSync, readSync,
  realpathSync, rmdirSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parseEnv } from 'node:util';
import { installationPaths, unitUsesPrefix } from './install-transaction.mjs';
import { isWithdrawn, manifestName, readSlot } from './slots.mjs';

const service = 'agent-link.service';
const timer = 'agent-link-update.timer';
const activeStates = ['active', 'inactive', 'failed', 'activating', 'deactivating', 'reloading', 'maintenance'];
const serviceResults = ['success', 'resources', 'protocol', 'timeout', 'exit-code', 'signal', 'core-dump',
  'watchdog', 'start-limit-hit', 'oom-kill', 'exec-condition'];
const updateOutcomes = ['scheduled', 'checking', 'waiting-window', 'busy', 'retry', 'current', 'skipped', 'committed'];
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;

function readSmall(path, decode = value => value, limit = 8192) {
  let fd;
  try {
    if (realpathSync(dirname(path)) !== dirname(path)) return { state: 'unreadable' };
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > limit) return { state: 'unreadable' };
    const bytes = Buffer.alloc(limit + 1);
    const length = readSync(fd, bytes, 0, bytes.length, 0);
    if (length > limit) return { state: 'unreadable' };
    const value = decode(bytes.toString('utf8', 0, length));
    return value === undefined ? { state: 'unreadable' } : { state: 'read', value };
  } catch (error) {
    return { state: error.code === 'ENOENT' ? 'missing' : 'unreadable' };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function build(value) {
  const match = /^versions\/([1-9][0-9]*)$/.exec(value);
  const number = Number(match?.[1]);
  return Number.isSafeInteger(number) ? number : null;
}

function release(directory, expectedBuild) {
  return readSmall(join(directory, manifestName), text => {
    const manifest = JSON.parse(text);
    if (manifest?.schemaVersion !== 1 || manifest.product !== 'Agent Link' ||
        manifest.platform !== 'linux' || manifest.arch !== 'x64' ||
        typeof manifest.version !== 'string' || manifest.version.length > 64 ||
        !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9_.-]+)?(?:\+[A-Za-z0-9_.-]+)?$/.test(manifest.version) ||
        !Number.isSafeInteger(manifest.buildNumber) || manifest.buildNumber <= 0 ||
        (expectedBuild !== null && manifest.buildNumber !== expectedBuild)) return;
    return { version: manifest.version, buildNumber: manifest.buildNumber };
  }, 128 * 1024);
}

function slot(program, name) {
  try {
    if (realpathSync(program) !== program) return { state: 'unreadable' };
    const value = readSlot(program, name);
    if (!value) return { state: 'missing' };
    const number = build(value);
    return number === null ? { state: 'unreadable' } : { state: 'read', value, number };
  } catch (error) {
    return { state: error.code === 'ENOENT' ? 'missing' : 'unreadable' };
  }
}

function queryUnit(name) {
  const properties = 'LoadState,ActiveState,Result,ExecMainStatus,FragmentPath,UnitFileState';
  const result = spawnSync('systemctl', ['--user', '--no-pager', 'show', name, '--property=' + properties], {
    encoding: 'utf8', timeout: 2000, maxBuffer: 32 * 1024, env: { ...process.env, LC_ALL: 'C' },
  });
  if (result.status !== 0) return;
  return Object.fromEntries(Array.from(result.stdout.matchAll(/^([A-Za-z]+)=(.*)$/gm), match => [match[1], match[2]]));
}

function unitStatus(name, paths, query) {
  const properties = query(name);
  if (!properties) return { state: 'unavailable' };
  if (properties.LoadState === 'not-found') return { state: 'not-loaded' };
  const unit = join(paths.unitDir, name);
  // The timer has no ExecStart. Its associated update service carries the prefix.
  const owner = name === timer ? join(paths.unitDir, 'agent-link-update.service') : unit;
  const command = readSmall(owner, data => data.split('\n').find(line => line.startsWith('ExecStart=')));
  if (properties.FragmentPath !== unit || command.state !== 'read' ||
      !unitUsesPrefix(command.value, paths.prefix)) return { state: 'different-installation' };
  const state = activeStates.includes(properties.ActiveState) ? properties.ActiveState : 'unknown';
  if (name === timer) {
    const enabled = ['enabled', 'enabled-runtime', 'disabled', 'static', 'linked', 'linked-runtime']
      .includes(properties.UnitFileState) ? properties.UnitFileState : null;
    return { state, mode: enabled };
  }
  const result = serviceResults.includes(properties.Result) ? properties.Result : null;
  const exitStatus = /^(?:0|[1-9][0-9]{0,2})$/.test(properties.ExecMainStatus) &&
    Number(properties.ExecMainStatus) <= 255 ? Number(properties.ExecMainStatus) : null;
  return { state, result, exitStatus };
}

function operatingSystem() {
  const os = readSmall('/usr/lib/os-release', text => {
    const values = parseEnv(text);
    return {
      distribution: /^[a-z0-9-]{1,24}$/.test(values.ID ?? '') ? values.ID : null,
      version: /^[0-9]{1,3}(?:\.[0-9]{1,3}){0,3}$/.test(values.VERSION_ID ?? '') ? values.VERSION_ID : null,
    };
  });
  return { platform: 'linux', architecture: process.arch === 'x64' ? 'x86_64' : process.arch, ...os.value };
}

export function collectDiagnostics(source, prefix, query = queryUnit) {
  const paths = installationPaths(prefix);
  const { program, updateRoot } = paths;
  const selected = slot(program, 'current');
  const previous = slot(program, 'previous');
  const selectedRelease = selected.value ? release(join(program, selected.value), selected.number)
    : selected.state === 'missing' ? release(paths.prefix, null) : { state: 'unreadable' };
  const archiveRelease = release(source, null);
  const pending = readSmall(join(program, 'pending'), text => uuid.test(text.trim()) ? text.trim() : undefined);
  const transaction = readSmall(join(program, 'transaction.json'), text => {
    const operationId = JSON.parse(text)?.operationId;
    return typeof operationId === 'string' && uuid.test(operationId) ? operationId : undefined;
  });
  const failed = readSmall(join(program, 'last-failed-build'), text => build(text.trim()) ?? undefined);
  const lastResult = readSmall(join(program, 'install-result.json'), text => {
    const value = JSON.parse(text);
    if (typeof value?.operationId !== 'string' || !uuid.test(value.operationId) ||
        !['installed', 'restored', 'recovery-required'].includes(value.outcome)) return;
    const buildNumber = build(value.candidate);
    if (buildNumber !== null) return { operationId: value.operationId, buildNumber, outcome: value.outcome };
  });
  const repair = readSmall(join(program, 'repair-required'), text => build(text.trim()) ?? undefined);
  const settings = readSmall(join(updateRoot, 'settings.json'), text => {
    const channel = JSON.parse(text)?.channel;
    return ['stable', 'preview'].includes(channel) ? channel : undefined;
  });
  const schedule = readSmall(join(updateRoot, 'automatic.json'), text => {
    const value = JSON.parse(text);
    if (!updateOutcomes.includes(value?.outcome) || !Number.isSafeInteger(value.nextCheckAt) ||
        value.nextCheckAt < 0) return;
    return { outcome: value.outcome, nextCheckAt: value.nextCheckAt };
  });
  const gateway = unitStatus(service, paths, query);
  const updateTimer = unitStatus(timer, paths, query);
  const codes = [];
  let withdrawn = null;
  try {
    if (selected.value && realpathSync(updateRoot) === updateRoot) withdrawn = isWithdrawn(updateRoot, selected.value);
  } catch (error) {
    if (error.code === 'ENOENT') withdrawn = selected.value ? false : null;
    else codes.push('WITHDRAWAL_STATE_UNREADABLE');
  }
  const sources = {
    packageManifest: archiveRelease.state, selectedRelease: selectedRelease.state,
    currentSlot: selected.state, previousSlot: previous.state, installMarker: pending.state,
    installationJournal: transaction.state, failedBuild: failed.state, repairStatus: repair.state,
    installationResult: lastResult.state, channelSettings: settings.state, updateSchedule: schedule.state,
  };
  if (Object.values(sources).includes('unreadable')) codes.push('DIAGNOSTIC_SOURCE_UNREADABLE');
  if (pending.state !== 'missing') codes.push('INSTALLATION_PENDING');
  if (failed.value) codes.push('CANDIDATE_INSTALLATION_FAILED');
  if (withdrawn || repair.value) codes.push('SIGNED_REPAIR_REQUIRED');
  if (gateway.state === 'failed') codes.push('GATEWAY_SERVICE_FAILED');
  if (gateway.state === 'unavailable') codes.push('USER_SERVICE_MANAGER_UNAVAILABLE');
  if (schedule.value?.outcome === 'retry') codes.push('UPDATE_RETRY_SCHEDULED');
  const installState = pending.state !== 'missing' ? 'switching'
    : transaction.state !== 'missing' ? 'recovery-cleanup'
      : withdrawn || repair.value ? 'repair-required'
        : selectedRelease.value ? (selected.value ? 'installed' : 'legacy')
          : selectedRelease.state === 'missing' && selected.state === 'missing' ? 'not-installed' : 'unavailable';
  return {
    schemaVersion: 'agent-link-diagnostics/1', generatedAt: new Date().toISOString(),
    product: 'agent-link', system: operatingSystem(), package: archiveRelease.value ?? null,
    installation: {
      state: installState, selectedRelease: selectedRelease.value ?? null, selectedBuild: selected.number ?? null,
      previousBuild: previous.number ?? null, failedBuild: failed.value ?? null, selectedBuildWithdrawn: withdrawn,
      operationId: pending.value && pending.value === transaction.value ? pending.value : null,
      lastResult: lastResult.value ?? null,
    },
    gateway, updates: { channel: settings.value ?? (settings.state === 'missing' ? 'unconfigured' : 'unavailable'),
      schedule: schedule.value ?? null, timer: updateTimer },
    errorCodes: codes, sources,
  };
}

export function writeDiagnostics(output, report) {
  const destination = resolve(output);
  const directory = mkdtempSync(join(dirname(destination), '.agent-link-diagnostics-'));
  const temporary = join(directory, 'report.json');
  try {
    writeFileSync(temporary, JSON.stringify(report, null, 2) + '\n', { mode: 0o600, flag: 'wx', flush: true });
    linkSync(temporary, destination);
  } finally {
    try { unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    rmdirSync(directory);
  }
}
