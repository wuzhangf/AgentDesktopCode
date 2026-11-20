import { constants } from 'node:fs';
import { copyFile, lstat, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Updater } from 'tuf-js';

const RECORD_LIMIT = 1024 * 1024;
const POSITIVE_INTEGER = value => Number.isSafeInteger(value) && value > 0;
const SAFE_TARGET_PATH = /^(?:[A-Za-z0-9_-][A-Za-z0-9._+-]*\/)*[A-Za-z0-9_-][A-Za-z0-9._+-]*$/;

export class CurrentBuildError extends Error {}

function repositoryUrl(value) {
  const url = new URL(value);
  const loopback = url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  if ((url.protocol !== 'https:' && !(loopback && url.protocol === 'http:')) ||
      url.username || url.password || url.search || url.hash) {
    throw new Error('Update repository requires HTTPS or local loopback HTTP');
  }
  return url.href;
}

function checkRelease(release, installed) {
  if (release?.schemaVersion !== 'link-release/1' || release.product !== 'agent-link' ||
      release.availability !== 'published' || release.channel !== installed.channel ||
      release.platform !== installed.platform || release.arch !== installed.arch) {
    throw new Error('Release is unavailable for this platform, architecture or channel');
  }
  if (!POSITIVE_INTEGER(release.buildNumber) || release.buildNumber < installed.buildNumber) {
    throw new Error('Release build number must be newer');
  }
  if (typeof release.releaseId !== 'string' || !/^[A-Za-z0-9_-]+$/.test(release.releaseId)) {
    throw new Error('Release has an invalid identifier');
  }
  const compatibility = release.compatibility;
  if (!POSITIVE_INTEGER(compatibility?.bootstrapMinVersion) ||
      compatibility.bootstrapMinVersion > installed.bootstrapVersion ||
      !Array.isArray(compatibility.stateReadVersions) ||
      !compatibility.stateReadVersions.includes(installed.stateVersion) ||
      !POSITIVE_INTEGER(compatibility.stateWriteVersion)) {
    throw new Error('Release cannot read the installed state or requires a newer bootstrap');
  }
  const artifact = release.artifact;
  if (typeof artifact?.path !== 'string' || !SAFE_TARGET_PATH.test(artifact.path) ||
      !artifact.path.startsWith(`agent-link/releases/${release.releaseId}/`) ||
      !POSITIVE_INTEGER(artifact.length) ||
      typeof artifact.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(artifact.sha256)) {
    throw new Error('Release has an invalid artifact descriptor');
  }
  return artifact;
}

/** Verify and stage a full archive using a provisioned TUF metadata cache. */
export async function stageVerifiedRelease({
  metadataDir, metadataBaseUrl, targetBaseUrl, releaseRecordPath, installed,
  stagingParent = tmpdir(), metadataOnly = false, allowCurrent = false, authorizeArchive, archiveCache,
}) {
  if (typeof releaseRecordPath !== 'string' || !SAFE_TARGET_PATH.test(releaseRecordPath)) {
    throw new Error('Invalid release record target path');
  }
  if (!['macos', 'windows', 'linux'].includes(installed?.platform) ||
      typeof installed.arch !== 'string' || !/^[a-z0-9_]+$/.test(installed.arch) ||
      !['stable', 'preview'].includes(installed.channel) ||
      !POSITIVE_INTEGER(installed.buildNumber) || !POSITIVE_INTEGER(installed.bootstrapVersion) ||
      !POSITIVE_INTEGER(installed.stateVersion)) {
    throw new Error('Invalid installed release state');
  }
  const updater = new Updater({
    metadataDir, metadataBaseUrl: repositoryUrl(metadataBaseUrl),
    targetBaseUrl: repositoryUrl(targetBaseUrl),
  });
  await updater.refresh();
  const recordTarget = await updater.getTargetInfo(releaseRecordPath);
  if (!recordTarget || !POSITIVE_INTEGER(recordTarget.length) || recordTarget.length > RECORD_LIMIT) {
    throw new Error('Missing or oversized verified release record');
  }
  const stagingDir = await mkdtemp(join(stagingParent, 'link-update-'));
  try {
    const recordPath = await updater.downloadTarget(recordTarget, join(stagingDir, 'release.json'));
    const release = JSON.parse(await readFile(recordPath, 'utf8'));
    const artifact = checkRelease(release, installed);
    const target = await updater.getTargetInfo(artifact.path);
    if (!target || artifact.length !== target.length || artifact.sha256 !== target.hashes.sha256) {
      throw new Error('Release artifact and trusted target metadata disagree');
    }
    const current = release.buildNumber === installed.buildNumber;
    if (current && !allowCurrent) throw new CurrentBuildError('Release build number must be newer');
    await authorizeArchive?.(release);
    if (current && !metadataOnly) throw new CurrentBuildError('Release build number must be newer');
    if (metadataOnly) {
      await rm(stagingDir, { recursive: true, force: true });
      return { release };
    }
    const archivePath = join(stagingDir, 'archive');
    if (archiveCache) {
      const cached = await lstat(archiveCache).catch(() => undefined);
      if (cached?.isFile() && cached.uid === process.getuid() && cached.size === artifact.length) {
        const copied = await copyFile(archiveCache, archivePath, constants.COPYFILE_FICLONE)
          .then(() => true, () => false);
        if (copied && await updater.findCachedTarget(target, archivePath)) {
          return { release, archivePath, stagingDir, fromCache: true };
        }
        await rm(archivePath, { force: true });
      }
    }
    await updater.downloadTarget(target, archivePath);
    return { release, archivePath, stagingDir };
  } catch (error) {
    await rm(stagingDir, { recursive: true, force: true });
    throw error;
  }
}
