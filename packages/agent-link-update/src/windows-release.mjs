import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { stageVerifiedRelease } from './verify-release.mjs';

export async function selectWindowsRelease(options, confirmOnly = false) {
  if (options.installed?.platform !== 'windows' || options.installed.arch !== 'x86_64' ||
      typeof options.cohort !== 'string' || !/^[a-f0-9]{32}$/.test(options.cohort)) {
    throw new Error('Invalid Windows update settings');
  }
  let selection;
  try {
    const { archivePath, stagingDir, fromCache } = await stageVerifiedRelease({
      ...options, metadataOnly: confirmOnly, allowCurrent: true,
      authorizeArchive(release) {
        selection = reviewRelease(release, options);
        if (selection.state !== 'candidate') throw new Error('Signed Windows release is deferred');
      },
    });
    if (!confirmOnly && options.archiveCache && !fromCache) {
      const retained = join(stagingDir, 'retained');
      try {
        await copyFile(archivePath, retained, constants.COPYFILE_EXCL);
        await rename(retained, options.archiveCache);
      } catch {
        // The verified staging copy remains usable and the launcher removes the staging directory.
      }
    }
    return confirmOnly ? selection : { ...selection, archivePath };
  } catch (error) {
    if (!selection) throw error;
    return selection.state === 'candidate' ? { state: 'download-deferred', withdrawn: selection.withdrawn } : selection;
  }
}

function reviewRelease(release, options) {
  const withdrawn = release.withdrawnBuilds;
  if (!Array.isArray(withdrawn) || withdrawn.some(build => !Number.isSafeInteger(build) || build <= 0)) {
    throw new Error('Invalid signed Windows withdrawal list');
  }
  if (withdrawn.includes(options.installed.buildNumber)) return { state: 'repair', withdrawn };
  if (release.buildNumber === options.installed.buildNumber || withdrawn.includes(release.buildNumber) ||
      release.compatibility.stateWriteVersion !== options.installed.stateVersion || release.minOS !== 'windows-11') {
    return { state: 'deferred', withdrawn };
  }
  const { cohortSeed, percentage } = release.rollout ?? {};
  if (typeof cohortSeed !== 'string' || !cohortSeed || !Number.isInteger(percentage) || percentage < 0 || percentage > 100) {
    throw new Error('Invalid signed Windows rollout');
  }
  const bucket = createHash('sha256').update(options.cohort).update('\0').update(cohortSeed)
    .digest().readUInt32BE() / 2 ** 32;
  if (bucket >= percentage / 100) return { state: 'deferred', withdrawn };
  const target = { buildNumber: release.buildNumber, archiveLength: release.artifact.length,
    archiveSha256: release.artifact.sha256 };
  return { state: 'candidate', withdrawn, target };
}
