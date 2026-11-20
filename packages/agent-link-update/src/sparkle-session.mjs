import { createPublicKey, randomUUID, verify } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { chmod, copyFile, readFile, rename, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { stageVerifiedRelease } from './verify-release.mjs';

function base64(value, length, field) {
  if (typeof value !== 'string') throw new Error(`Missing ${field}`);
  const raw = Buffer.from(value, 'base64');
  if (raw.length !== length || raw.toString('base64') !== value) throw new Error(`Invalid ${field}`);
  return raw;
}

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' };
const xml = value => String(value).replace(/[&<>"']/g, char => ESCAPES[char]);

function macCandidate(release, options) {
  if (options.installed?.platform !== 'macos') throw new Error('Sparkle requires a Mac release');
  const { buildNumber, displayVersion, releaseId, artifact } = release;
  if (typeof displayVersion !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9.+_-]{0,63}$/.test(displayVersion)) {
    throw new Error('Invalid Mac display version');
  }
  if (release.compatibility.stateWriteVersion !== options.installed.stateVersion) {
    throw new Error('Mac release changes the local state schema');
  }
  const minimum = typeof release.minOS === 'string' && /^(?:macos-)?(\d+(?:\.\d+){1,2})$/.exec(release.minOS);
  if (!minimum) throw new Error('Invalid minimum macOS version');
  base64(artifact.sparkleEdSignature, 64, 'Sparkle archive signature');
  return { releaseId, buildNumber, displayVersion, minOS: minimum[1], length: artifact.length,
    sha256: artifact.sha256, sparkleEdSignature: artifact.sparkleEdSignature };
}

/** Recheck that the staged bytes are still approved for a recoverable installation. */
export async function confirmSparkleCandidate(options) {
  const { release } = await stageVerifiedRelease({ ...options, metadataOnly: true });
  const candidate = macCandidate(release, options);
  const denied = release.withdrawnBuilds;
  if (!Array.isArray(denied) || denied.some(build => !Number.isSafeInteger(build) || build <= 0) ||
      denied.includes(options.installed.buildNumber) || denied.includes(candidate.buildNumber)) {
    throw new Error('Mac installation requires a trusted version for recovery');
  }
  return candidate;
}

/** Serve one already authenticated archive to the native Sparkle driver. */
export async function startSparkleSession(options) {
  if (options.installed?.platform !== 'macos') throw new Error('Sparkle requires a Mac release');
  const rawKey = base64(options.sparkleEdPublicKey, 32, 'Sparkle public key');
  const publicKey = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), rawKey]),
    format: 'der', type: 'spki' });
  const { release, archivePath, stagingDir, fromCache } = await stageVerifiedRelease(options);
  let server;
  async function close() {
    if (server?.listening) {
      const stopped = new Promise(resolve => server.close(resolve));
      server.closeAllConnections();
      await stopped;
    }
    await rm(stagingDir, { recursive: true, force: true });
  }
  try {
    const candidate = macCandidate(release, options);
    const { buildNumber, displayVersion, minOS } = candidate;
    const signature = Buffer.from(candidate.sparkleEdSignature, 'base64');
    if (!verify(null, await readFile(archivePath), publicKey, signature)) {
      throw new Error('Sparkle signature does not match the verified archive');
    }
    if (options.archiveCache && !fromCache) {
      const retained = join(stagingDir, 'retained');
      try {
        await copyFile(archivePath, retained, constants.COPYFILE_FICLONE);
        await chmod(retained, 0o600);
        await rename(retained, options.archiveCache);
      } catch {
        // A cache write failure does not prevent use of this verified session.
        await rm(retained, { force: true });
      }
    }

    const prefix = '/' + randomUUID();
    const feedPath = prefix + '/appcast.xml';
    const downloadPath = prefix + '/Agent-Link.zip';
    let appcast;
    server = createServer((req, res) => {
      res.setHeader('cache-control', 'no-store');
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { allow: 'GET, HEAD' }).end();
      } else if (req.url === feedPath) {
        res.writeHead(200, { 'content-type': 'application/rss+xml; charset=utf-8', 'content-length': appcast.length });
        res.end(req.method === 'GET' ? appcast : undefined);
      } else if (req.url === downloadPath) {
        res.writeHead(200, { 'content-type': 'application/zip', 'content-length': candidate.length });
        if (req.method === 'HEAD') res.end();
        else void pipeline(createReadStream(archivePath), res).catch(() => res.destroy());
      } else {
        res.writeHead(404).end();
      }
    });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const local = 'http://127.0.0.1:' + server.address().port;
    const fileURL = local + downloadPath;
    appcast = Buffer.from(`<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0" xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle">
  <channel><title>Agent Link</title><item>
    <title>Agent Link ${xml(displayVersion)}</title>
    <sparkle:version>${buildNumber}</sparkle:version>
    <sparkle:shortVersionString>${xml(displayVersion)}</sparkle:shortVersionString>
    <sparkle:minimumSystemVersion>${minOS}</sparkle:minimumSystemVersion>
    <enclosure url="${xml(fileURL)}" length="${candidate.length}" type="application/octet-stream" sparkle:edSignature="${xml(candidate.sparkleEdSignature)}"/>
  </item></channel>
</rss>`);
    return { candidate: { ...candidate, feedURL: local + feedPath, fileURL }, close };
  } catch (error) {
    await close();
    throw error;
  }
}
