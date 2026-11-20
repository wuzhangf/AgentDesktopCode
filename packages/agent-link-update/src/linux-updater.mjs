import { createHash } from 'node:crypto';
import { readFile, realpath, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs, parseEnv } from 'node:util';
import { CurrentBuildError, stageVerifiedRelease } from './verify-release.mjs';
import { extractLinuxArchive } from './linux-archive.mjs';
import { install, InstallationDeferred, installationPaths } from '../../../agent-link-linux/install-transaction.mjs';
import { readSlot } from '../../../agent-link-linux/slots.mjs';

const packageLimit = 128 * 1024 * 1024;
class DeferredUpdate extends Error {}

async function safeDirectory(path) {
  if (await realpath(path) !== path) throw new Error('Update directories must be local to the installation');
}

async function main() {
  const { values: args } = parseArgs({ options: { prefix: { type: 'string' } } });
  const { program, updateRoot } = installationPaths(args.prefix);
  const { active } = await install({ args, recoverOnly: true });
  if (!active) throw new DeferredUpdate('Gateway is stopped');
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
  await Promise.all([safeDirectory(updateRoot), safeDirectory(metadataDir)]);
  for (const entry of await readdir(updateRoot, { withFileTypes: true })) {
    if (entry.isDirectory() && /^link-update-[A-Za-z0-9]+$/.test(entry.name)) {
      await rm(join(updateRoot, entry.name), { recursive: true });
    }
  }
  const settings = JSON.parse(await readFile(join(updateRoot, 'settings.json'), 'utf8'));
  const options = {
    metadataDir, metadataBaseUrl: settings.metadataBaseUrl, targetBaseUrl: settings.targetBaseUrl,
    releaseRecordPath: settings.releaseRecordPath, stagingParent: updateRoot,
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
  const { release, archivePath, stagingDir } = await stageVerifiedRelease({ ...options, authorizeArchive });
  try {
    const source = join(stagingDir, 'payload');
    await extractLinuxArchive(archivePath, source);
    await install({
      source, args, release,
      confirmCandidate: async () => {
        const { release: latest } = await stageVerifiedRelease({ ...options, authorizeArchive, metadataOnly: true });
        if (latest.releaseId !== release.releaseId || latest.buildNumber !== release.buildNumber ||
            latest.displayVersion !== release.displayVersion || latest.artifact.path !== release.artifact.path ||
            latest.artifact.length !== release.artifact.length || latest.artifact.sha256 !== release.artifact.sha256) {
          throw new DeferredUpdate('The signed candidate changed during staging');
        }
      },
    });
  } finally {
    await rm(stagingDir, { recursive: true, force: true });
  }
}

main().catch(error => {
  const deferred = error instanceof DeferredUpdate || error instanceof CurrentBuildError || error instanceof InstallationDeferred;
  console[deferred ? 'log' : 'error'](`Agent Link updater: ${error.message}`);
  if (!deferred) process.exitCode = 1;
});
