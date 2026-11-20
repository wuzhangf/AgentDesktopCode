import { createHash } from 'node:crypto';
import {
  chmodSync, closeSync, constants, copyFileSync, existsSync, fsyncSync, lstatSync,
  mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, readlinkSync, realpathSync,
  renameSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

export const manifestName = 'release-manifest.json';
const slotName = /^versions\/[1-9][0-9]*$/;
const executables = new Set(['runtime/node', 'install.sh', 'uninstall.sh', 'launch.sh']);
const required = [
  'device-gateway.mjs', 'cli-bridge.mjs', 'hooks/agent_pre_tool.py', 'hooks/install.py',
  'runtime/node', 'runtime/node-LICENSE', 'systemd/agent-link.service', 'install.sh',
  'uninstall.sh', 'launch.sh', 'slots.mjs', 'install.mjs',
];
const allowed = new Set([
  ...required, 'README.md', 'install-transaction.mjs', 'configure-update.mjs',
  'bootstrap/update.cjs', 'bootstrap/trust.json', 'bootstrap/root.json', 'bootstrap/THIRD-PARTY-NOTICES.txt',
  'systemd/agent-link-update.service', 'systemd/agent-link-update.timer',
]);

export const isPayloadFile = path => typeof path === 'string' &&
  (allowed.has(path) || /^adapters\/[a-zA-Z0-9_-]+\/adapter\.mjs$/.test(path));

const withdrawalFile = 'withdrawn-builds.json';
const withdrawalLimit = 1024 * 1024;
const validWithdrawals = builds => Array.isArray(builds) &&
  builds.every(build => Number.isSafeInteger(build) && build > 0);

function readWithdrawals(updateRoot) {
  const path = join(updateRoot, withdrawalFile);
  try {
    const file = lstatSync(path);
    if (!file.isFile() || file.size > withdrawalLimit) throw new Error('Invalid installed withdrawal list');
    const builds = JSON.parse(readFileSync(path, 'utf8'));
    if (!validWithdrawals(builds) || new Set(builds).size !== builds.length) {
      throw new Error('Invalid installed withdrawal list');
    }
    return builds;
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

export function rememberWithdrawals(updateRoot, release) {
  if (!validWithdrawals(release.withdrawnBuilds) ||
      (release.availability === 'withdrawn' && !validWithdrawals([release.buildNumber]))) {
    throw new Error('Invalid signed Linux withdrawal list');
  }
  const previous = readWithdrawals(updateRoot);
  const builds = new Set([...previous, ...release.withdrawnBuilds]);
  if (release.availability === 'withdrawn') builds.add(release.buildNumber);
  if (builds.size === previous.length) return;
  const contents = JSON.stringify([...builds]);
  if (Buffer.byteLength(contents) > withdrawalLimit) throw new Error('Linux withdrawal list is oversized');
  writeAtomic(join(updateRoot, withdrawalFile), contents);
}

export function isWithdrawn(updateRoot, slot) {
  return slot !== undefined && slotName.test(slot) &&
    readWithdrawals(updateRoot).includes(Number(slot.split('/')[1]));
}

export function syncPath(path) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

export function writeAtomic(path, contents, mode = 0o600) {
  const directory = dirname(path);
  const temporary = mkdtempSync(join(directory, '.write-'));
  try {
    const file = join(temporary, 'file');
    writeFileSync(file, contents, { mode, flag: 'wx' });
    syncPath(file);
    renameSync(file, path);
    syncPath(directory);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

function validateFile(root, path) {
  const file = join(root, path);
  if (!lstatSync(file).isFile() || realpathSync(file) !== file) {
    throw new Error(`Package entry is not a regular file: ${path}`);
  }
  return file;
}

function validatePackage(root) {
  const bytes = readFileSync(validateFile(root, manifestName));
  const manifest = JSON.parse(bytes);
  if (manifest.schemaVersion !== 1 || manifest.product !== 'Agent Link' ||
      manifest.platform !== 'linux' || manifest.arch !== 'x64' ||
      !Number.isSafeInteger(manifest.buildNumber) || manifest.buildNumber <= 0 ||
      !Array.isArray(manifest.files)) {
    throw new Error('Invalid Linux release manifest');
  }
  const entries = new Map();
  for (const { path, sha256 } of manifest.files) {
    if (!isPayloadFile(path) ||
        entries.has(path) || typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sha256)) {
      throw new Error('Unexpected or duplicate Linux release manifest entry');
    }
    entries.set(path, sha256);
  }
  if (required.some(path => !entries.has(path))) throw new Error('Incomplete Linux release payload');
  return { manifest, bytes, entries };
}

function checkDigest(file, expected) {
  if (createHash('sha256').update(readFileSync(file)).digest('hex') !== expected) {
    throw new Error(`Linux release component checksum mismatch: ${file.split('/').at(-1)}`);
  }
}

export function readSlot(program, name) {
  const path = join(program, name);
  let target;
  try { target = readlinkSync(path); } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
  const version = join(program, target);
  if (!slotName.test(target) || !existsSync(version) || realpathSync(version) !== version ||
      !lstatSync(version).isDirectory()) {
    throw new Error(`Invalid program slot: ${name}`);
  }
  return target;
}

export function setSlot(program, name, target) {
  if (target !== undefined && !slotName.test(target)) throw new Error('Invalid program version');
  const path = join(program, name);
  if (target === undefined) {
    rmSync(path, { force: true });
    syncPath(program);
    return;
  }
  const temporary = mkdtempSync(join(program, '.slot-'));
  try {
    const file = join(temporary, name);
    symlinkSync(target, file);
    renameSync(file, path);
    syncPath(program);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

export function stageVersion(program, source, release) {
  const root = realpathSync(source);
  const { manifest, bytes, entries } = validatePackage(root);
  if (release && (manifest.buildNumber !== release.buildNumber || manifest.version !== release.displayVersion)) {
    throw new Error('Linux package version differs from the signed release');
  }
  const target = `versions/${manifest.buildNumber}`;
  const versions = join(program, 'versions');
  mkdirSync(versions, { recursive: true, mode: 0o700 });
  if (realpathSync(versions) !== versions) throw new Error('Program versions directory must be local');
  syncPath(program);
  const path = join(program, target);
  if (existsSync(path)) {
    if (realpathSync(path) !== path) throw new Error('Program version must be local');
    const installed = validatePackage(path);
    if (!bytes.equals(installed.bytes)) throw new Error('Build number already belongs to different release bytes');
    for (const [name, hash] of entries) checkDigest(validateFile(path, name), hash);
  } else {
    const temporary = mkdtempSync(join(versions, '.stage-'));
    try {
      const directories = new Set([temporary]);
      for (const [name, hash] of entries) {
        const file = join(temporary, name);
        const dir = dirname(file);
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        directories.add(dir);
        copyFileSync(validateFile(root, name), file, constants.COPYFILE_EXCL);
        chmodSync(file, executables.has(name) ? 0o755 : 0o644);
        checkDigest(file, hash);
        syncPath(file);
      }
      const installedManifest = join(temporary, manifestName);
      writeFileSync(installedManifest, bytes, { mode: 0o644, flag: 'wx' });
      syncPath(installedManifest);
      for (const directory of directories) syncPath(directory);
      renameSync(temporary, path);
      syncPath(versions);
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  }
  return target;
}

export function pruneVersions(program, keep) {
  const versions = join(program, 'versions');
  for (const name of readdirSync(versions)) {
    const target = `versions/${name}`;
    if (slotName.test(target) && !keep.includes(target)) {
      rmSync(join(program, target), { recursive: true, force: true });
    }
  }
  syncPath(versions);
}
