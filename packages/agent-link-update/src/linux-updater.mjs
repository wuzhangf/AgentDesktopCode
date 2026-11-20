import { createHash } from 'node:crypto';
import { constants, existsSync } from 'node:fs';
import { chmod, copyFile, readFile, realpath, readdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs, parseEnv } from 'node:util';
import { CurrentBuildError, stageVerifiedRelease } from './verify-release.mjs';
import { extractLinuxArchive } from './linux-archive.mjs';
import { install, InstallationDeferred, installationPaths } from '../../../agent-link-linux/install-transaction.mjs';
import { readSlot } from '../../../agent-link-linux/slots.mjs';
import { inMaintenanceWindow, scheduledUpdate } from '../../../agent-link-linux/update-schedule.mjs';

const packageLimit = 128 * 1024 * 1024;
class DeferredUpdate extends Error {
  constructor(message, outcome = 'skipped') {
    super(message);
    this.outcome = outcome;
  }
}

async function safeDirectory(path) {
  if (await realpath(path) !== path) throw new Error('Update directories must be local to the installation');
}

async function main() {
  const { values: args } = parseArgs({ options: { prefix: { type: 'string' }, scheduled: { type: 'boolean' } } });
  const paths = installationPaths(args.prefix);
  const { program, config, updateRoot } = paths;
  const interrupted = ['pending', 'transaction.json'].some(name => existsSync(join(program, name)));
  // Recovery takes precedence over preferences, time and network checks.
  const recovered = interrupted ? await install({ args, recoverOnly: true }) : undefined;
  await safeDirectory(updateRoot);
  const schedule = args.scheduled ? scheduledUpdate(updateRoot, config) : undefined;
  if (schedule && !schedule.due()) return;
  schedule?.begin();
  try {
    const { active } = recovered ?? await install({ args, recoverOnly: true });
    if (!active) throw new DeferredUpdate('Gateway is stopped', 'busy');
    await checkForUpdate(args, paths);
    schedule?.finish('committed');
  } catch (error) {
    schedule?.finish(error instanceof DeferredUpdate ? error.outcome
      : error instanceof CurrentBuildError ? 'current'
        : error instanceof InstallationDeferred ? 'busy' : 'retry');
    throw error;
  }
}

async function checkForUpdate(args, { program, updateRoot, config }) {
  function requireMaintenanceWindow() {
    if (args.scheduled && !inMaintenanceWindow(config)) {
      throw new DeferredUpdate('Update downloaded and verified. Waiting for the installation window.', 'waiting-window');
    }
  }
  const system = parseEnv(await readFile('/etc/os-release', 'utf8'));
  if (process.platform !== 'linux' || process.arch !== 'x64' ||
      system.ID !== 'ubuntu' || system.VERSION_ID !== '24.04') {
    throw new DeferredUpdate('Automatic updates require Ubuntu 24.04 x86_64');
  }
  const current = readSlot(program, 'current');
  if (!current) throw new Error('Missing installed Linux program version');
  const buildNumber = Number(current.split('/')[1]);
  const failed = await readFile(join(program, 'last-failed-build'), 'utf8').catch(error => {
    if (error.code === 'ENOENT') return '';
    throw error;
  });
  const metadataDir = join(updateRoot, 'metadata');
  const archiveCache = join(updateRoot, 'cached-linux-payload.tar.gz');
  await safeDirectory(metadataDir);
  for (const entry of await readdir(updateRoot, { withFileTypes: true })) {
    if (entry.isDirectory() && /^link-update-[A-Za-z0-9]+$/.test(entry.name)) {
      await rm(join(updateRoot, entry.name), { recursive: true });
    }
  }
  const settings = JSON.parse(await readFile(join(updateRoot, 'settings.json'), 'utf8'));
  const options = {
    metadataDir, metadataBaseUrl: settings.metadataBaseUrl, targetBaseUrl: settings.targetBaseUrl,
    releaseRecordPath: settings.releaseRecordPath, stagingParent: updateRoot, archiveCache,
    installed: { platform: 'linux', arch: 'x86_64', channel: settings.channel,
      buildNumber, bootstrapVersion: 1, stateVersion: 1 },
  };
  function authorizeArchive(release) {
    if (release.minOS !== 'ubuntu-24.04' || release.compatibility.stateWriteVersion !== 1 ||
        release.artifact.length > packageLimit) {
      throw new DeferredUpdate('Release platform, state compatibility or size does not allow automatic installation');
    }
    if (!Array.isArray(release.withdrawnBuilds) ||
        release.withdrawnBuilds.some(build => !Number.isSafeInteger(build) || build <= 0) ||
        release.withdrawnBuilds.includes(release.buildNumber) ||
        release.withdrawnBuilds.includes(buildNumber)) {
      throw new DeferredUpdate('A trusted rollback version is required; repair from a verified release');
    }
    if (failed.trim() === `versions/${release.buildNumber}`) {
      throw new DeferredUpdate(`Build ${release.buildNumber} previously failed startup`);
    }
    const { cohortSeed, percentage } = release.rollout ?? {};
    if (typeof settings.cohort !== 'string' || typeof cohortSeed !== 'string' || !cohortSeed ||
        !Number.isInteger(percentage) || percentage < 0 || percentage > 100) {
      throw new Error('Invalid signed rollout settings');
    }
    const bucket = createHash('sha256').update(settings.cohort).update('\0').update(cohortSeed)
      .digest().readUInt32BE() / 2 ** 32;
    if (bucket >= percentage / 100) throw new DeferredUpdate('Build is outside this installation’s rollout cohort');
  }
  const { release, archivePath, stagingDir, fromCache } = await stageVerifiedRelease({ ...options, authorizeArchive });
  try {
    if (!fromCache) {
      const retained = join(stagingDir, 'retained');
      try {
        await copyFile(archivePath, retained, constants.COPYFILE_EXCL);
        await chmod(retained, 0o600);
        await rename(retained, archiveCache);
      } catch {
        // The verified staging copy can still be installed if preserving it fails.
      }
    }
    requireMaintenanceWindow();
    const source = join(stagingDir, 'payload');
    await extractLinuxArchive(archivePath, source);
    await install({
      source, args, release,
      authorizeStop: requireMaintenanceWindow,
      confirmCandidate: async () => {
        requireMaintenanceWindow();
        const { release: latest } = await stageVerifiedRelease({ ...options, authorizeArchive, metadataOnly: true });
        if (latest.releaseId !== release.releaseId || latest.buildNumber !== release.buildNumber ||
            latest.displayVersion !== release.displayVersion || latest.artifact.path !== release.artifact.path ||
            latest.artifact.length !== release.artifact.length || latest.artifact.sha256 !== release.artifact.sha256) {
          throw new DeferredUpdate('The signed candidate changed during staging', 'retry');
        }
        requireMaintenanceWindow();
      },
    });
    await rm(archiveCache, { force: true }).catch(() => {});
  } finally {
    await rm(stagingDir, { recursive: true, force: true });
  }
}

main().catch(error => {
  const deferred = error instanceof DeferredUpdate || error instanceof CurrentBuildError || error instanceof InstallationDeferred;
  console[deferred ? 'log' : 'error'](`Agent Link updater: ${error.message}`);
  if (!deferred) process.exitCode = 1;
});
