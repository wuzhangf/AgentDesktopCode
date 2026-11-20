import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { canonicalize } from '@tufjs/canonical-json';
import { stageVerifiedRelease } from '../src/verify-release.mjs';
import { confirmSparkleCandidate, startSparkleSession } from '../src/sparkle-session.mjs';
import { selectWindowsRelease } from '../src/windows-release.mjs';

const recordPath = 'channels/stable.json';
const artifactPath = 'agent-link/releases/link-42/Agent-Link.zip';
const archive = Buffer.from('synthetic archive bytes');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const describe = bytes => ({ length: bytes.length, hashes: { sha256: digest(bytes) } });

function keyPair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const model = {
    keytype: 'ed25519',
    scheme: 'ed25519',
    keyval: { public: publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex') },
  };
  return { model, privateKey, id: digest(canonicalize(model)) };
}

function signed(type, version, fields, keys) {
  const expires = new Date(Date.now() + 7 * 86_400_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const content = { _type: type, version, spec_version: '1.0.31', expires, ...fields };
  const body = Buffer.from(canonicalize(content));
  return Buffer.from(JSON.stringify({
    signed: content,
    signatures: keys.map(({ id, privateKey }) => ({
      keyid: id, sig: sign(null, body, privateKey).toString('hex'),
    })),
  }));
}

async function repository(t) {
  const directory = await mkdtemp(join(tmpdir(), 'link-tuf-test-'));
  const files = new Map();
  const requests = [];
  const server = createServer((request, reply) => {
    requests.push(request.url);
    const contents = files.get(request.url);
    if (!contents) {
      reply.writeHead(404).end();
      return;
    }
    reply.writeHead(200, { 'content-length': contents.length }).end(contents);
  });
  t.after(async () => {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await rm(directory, { recursive: true, force: true });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = 'http://127.0.0.1:' + server.address().port;
  const metadataDir = join(directory, 'cache');
  const stagingParent = join(directory, 'staging');
  await Promise.all([mkdir(metadataDir), mkdir(stagingParent)]);

  const initial = keyPair();
  const rotated = keyPair();
  const root = (version, key, signatures) => signed('root', version, {
    consistent_snapshot: false,
    keys: { [key.id]: key.model },
    roles: Object.fromEntries(['root', 'targets', 'snapshot', 'timestamp'].map(role =>
      [role, { keyids: [key.id], threshold: 1 }])),
  }, signatures);
  await writeFile(join(metadataDir, 'root.json'), root(1, initial, [initial]));
  const installed = { platform: 'linux', arch: 'x86_64', channel: 'stable',
    buildNumber: 41, bootstrapVersion: 1, stateVersion: 1 };
  const baseRelease = {
    schemaVersion: 'link-release/1', product: 'agent-link', displayVersion: '0.2.1',
    releaseId: 'link-42', platform: 'linux', arch: 'x86_64', channel: 'stable',
    buildNumber: 42, availability: 'published',
    compatibility: { bootstrapMinVersion: 1, stateReadVersions: [1], stateWriteVersion: 1 },
    artifact: { path: artifactPath, length: archive.length, sha256: digest(archive) },
  };
  const options = (current = installed) => ({
    metadataDir, metadataBaseUrl: origin + '/metadata/', targetBaseUrl: origin + '/targets/',
    releaseRecordPath: recordPath, installed: current, stagingParent,
  });
  return {
    files, installed, requests, stagingParent, options,
    publish({ version = 1, release = {}, expired = false, rotate = false } = {}) {
      const key = rotate ? rotated : initial;
      if (rotate) files.set('/metadata/2.root.json', root(2, rotated, [initial, rotated]));
      const record = Buffer.from(JSON.stringify({ ...baseRelease, ...release }));
      const targets = signed('targets', version, {
        targets: { [recordPath]: describe(record), [artifactPath]: describe(archive) },
      }, [key]);
      const snapshot = signed('snapshot', version, {
        meta: { 'targets.json': { version, ...describe(targets) } },
      }, [key]);
      const timestamp = signed('timestamp', version, {
        meta: { 'snapshot.json': { version, ...describe(snapshot) } },
        ...(expired ? { expires: '2000-01-01T00:00:00Z' } : {}),
      }, [key]);
      files.set('/metadata/targets.json', targets);
      files.set('/metadata/snapshot.json', snapshot);
      files.set('/metadata/timestamp.json', timestamp);
      files.set('/targets/' + recordPath, record);
      files.set('/targets/' + artifactPath, archive);
    },
    stage(current = installed) {
      return stageVerifiedRelease(options(current));
    },
  };
}

test('rotates trusted root and stages verified archive for each desktop platform', async t => {
  const repo = await repository(t);
  for (const [version, platform] of ['macos', 'windows', 'linux'].entries()) {
    repo.publish({ version: version + 1, rotate: true, release: { platform } });
    const result = await repo.stage({ ...repo.installed, platform });
    assert.equal(result.release.buildNumber, 42);
    assert.equal(result.release.platform, platform);
    assert.deepEqual(await readFile(result.archivePath), archive);
  }
});

test('Windows verifier stages signed archives, checks rollout and rechecks withdrawal before commitment', async t => {
  const repo = await repository(t);
  const options = { ...repo.options({ ...repo.installed, platform: 'windows' }), cohort: '12'.repeat(16) };
  options.archiveCache = join(options.stagingParent, 'retained-windows.zip');
  const release = { platform: 'windows', minOS: 'windows-11', withdrawnBuilds: [],
    rollout: { cohortSeed: 'windows-test', percentage: 100 } };
  repo.publish({ release });
  const bundled = process.env.AGENT_LINK_WINDOWS_TEST_VERIFIER;
  const result = bundled
    ? await callWindowsVerifier(bundled, options)
    : await selectWindowsRelease(options);
  assert.equal(result.state, 'candidate');
  assert.deepEqual(result.target, { buildNumber: 42, archiveLength: archive.length, archiveSha256: digest(archive) });
  assert.deepEqual(await readFile(result.archivePath), archive);
  assert.deepEqual(await readFile(options.archiveCache), archive);
  const firstDownloadCount = repo.requests.filter(path => path === '/targets/' + artifactPath).length;
  const confirmed = await selectWindowsRelease(options, true);
  assert.deepEqual(confirmed, { state: 'candidate', withdrawn: [], target: result.target });
  assert.equal(repo.requests.filter(path => path === '/targets/' + artifactPath).length, firstDownloadCount);

  repo.files.delete('/targets/' + artifactPath);
  const resumed = await selectWindowsRelease(options);
  assert.equal(resumed.state, 'candidate');
  assert.deepEqual(await readFile(resumed.archivePath), archive);
  assert.equal(repo.requests.filter(path => path === '/targets/' + artifactPath).length, firstDownloadCount);

  repo.publish({ version: 2, release: { ...release, rollout: { ...release.rollout, percentage: 0 } } });
  assert.deepEqual(await selectWindowsRelease(options), { state: 'deferred', withdrawn: [] });
  repo.publish({ version: 3, release: { ...release, withdrawnBuilds: [41] } });
  assert.deepEqual(await selectWindowsRelease(options, true), { state: 'repair', withdrawn: [41] });
  repo.publish({ version: 4, release: { ...release, withdrawnBuilds: [42] } });
  assert.deepEqual(await selectWindowsRelease({ ...options, installed: { ...options.installed, buildNumber: 42 } }),
    { state: 'repair', withdrawn: [42] });
  assert.equal(repo.requests.filter(path => path === '/targets/' + artifactPath).length, firstDownloadCount);
  repo.publish({ version: 5, release: { ...release, withdrawnBuilds: [40] } });
  await writeFile(options.archiveCache, Buffer.alloc(archive.length, 0x31));
  repo.files.set('/targets/' + artifactPath, Buffer.alloc(archive.length, 0x2a));
  assert.deepEqual(await selectWindowsRelease(options), { state: 'download-deferred', withdrawn: [40] });
});

async function callWindowsVerifier(bundle, options) {
  const request = join(options.stagingParent, 'windows-verification.json');
  await writeFile(request, JSON.stringify(options));
  const { stdout } = await promisify(execFile)(process.execPath, [bundle, request]);
  return JSON.parse(stdout);
}

test('refuses expired and replayed metadata', async t => {
  const repo = await repository(t);
  repo.publish({ expired: true });
  await assert.rejects(repo.stage());
  repo.publish({ version: 3 });
  await repo.stage();
  repo.publish({ version: 1 });
  await assert.rejects(repo.stage());
});

test('allows checking current signed metadata and rollout without fetching archives', async t => {
  const repo = await repository(t);
  repo.publish();
  const { release, archivePath } = await stageVerifiedRelease({ ...repo.options(), metadataOnly: true });
  assert.equal(release.buildNumber, 42);
  assert.equal(archivePath, undefined);
  await assert.rejects(stageVerifiedRelease({ ...repo.options(),
    authorizeArchive: () => { throw new Error('Outside rollout'); },
  }), /Outside rollout/);
  assert.ok(!repo.requests.includes('/targets/' + artifactPath));
  assert.deepEqual(await readdir(repo.stagingParent), []);
});

test('keeps ineligible releases away from the archive download', async t => {
  const repo = await repository(t);
  const cases = [
    [{ platform: 'macos' }, /platform/],
    [{ arch: 'arm64' }, /architecture/],
    [{ channel: 'preview' }, /channel/],
    [{ availability: 'withdrawn' }, /unavailable/],
    [{ buildNumber: 41 }, /newer/],
    [{ compatibility: { bootstrapMinVersion: 2, stateReadVersions: [1], stateWriteVersion: 1 } }, /bootstrap/],
    [{ artifact: { path: '../archive', length: archive.length, sha256: digest(archive) } }, /descriptor/],
    [{ releaseId: 'different-release' }, /descriptor/],
    [{ artifact: { path: artifactPath, length: archive.length, sha256: '1'.repeat(64) } }, /disagree/],
  ];
  for (const [version, [release, expected]] of cases.entries()) {
    repo.publish({ version: version + 1, release });
    await assert.rejects(repo.stage(), expected);
  }
  assert.ok(!repo.requests.includes('/targets/' + artifactPath));
  assert.deepEqual(await readdir(repo.stagingParent), []);
});

test('removes staging data when the archive differs from its verified metadata', async t => {
  const repo = await repository(t);
  repo.publish();
  repo.files.set('/targets/' + artifactPath, Buffer.alloc(archive.length, 8));
  await assert.rejects(repo.stage());
  assert.deepEqual(await readdir(repo.stagingParent), []);
});

test('Sparkle receives only the archive and EdDSA signature from the verified TUF record', async t => {
  const repo = await repository(t);
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const options = { ...repo.options({ ...repo.installed, platform: 'macos' }),
    archiveCache: join(repo.stagingParent, '..', 'verified-macos.zip'),
    sparkleEdPublicKey: publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64') };
  const artifact = { path: artifactPath, length: archive.length, sha256: digest(archive) };
  const edSignature = sign(null, archive, privateKey).toString('base64');
  const release = { platform: 'macos', minOS: 'macos-15.0', withdrawnBuilds: [],
    artifact: { ...artifact, sparkleEdSignature: edSignature } };
  repo.publish({ release });
  const staged = await startSparkleSession(options);
  try {
    const { candidate } = staged;
    assert.equal(candidate.buildNumber, 42);
    assert.equal(candidate.sha256, digest(archive));
    const approval = await confirmSparkleCandidate(options);
    assert.equal(approval.sha256, candidate.sha256);
    assert.equal(approval.sparkleEdSignature, candidate.sparkleEdSignature);
    const feed = await (await fetch(candidate.feedURL)).text();
    assert.ok(feed.includes('sparkle:edSignature="' + edSignature + '"'));
    assert.ok(feed.includes('url="' + candidate.fileURL + '"'));
    assert.ok(feed.includes('<sparkle:minimumSystemVersion>15.0</sparkle:minimumSystemVersion>'));
    const file = await fetch(candidate.fileURL);
    assert.equal(file.headers.get('content-length'), String(archive.length));
    assert.deepEqual(Buffer.from(await file.arrayBuffer()), archive);
    assert.equal((await fetch(new URL('/another.zip', candidate.feedURL))).status, 404);
  } finally { await staged.close(); }
  assert.deepEqual(await readdir(repo.stagingParent), []);
  assert.deepEqual(await readFile(options.archiveCache), archive);

  const archiveRequest = '/targets/' + artifactPath;
  const requestsBeforeRetry = repo.requests.filter(path => path === archiveRequest).length;
  repo.files.delete(archiveRequest);
  const cached = await startSparkleSession(options);
  await cached.close();
  assert.equal(repo.requests.filter(path => path === archiveRequest).length, requestsBeforeRetry);
  await writeFile(options.archiveCache, Buffer.alloc(archive.length));
  await assert.rejects(startSparkleSession(options));
  assert.ok(repo.requests.filter(path => path === archiveRequest).length > requestsBeforeRetry);

  repo.publish({ version: 2, release: { ...release, withdrawnBuilds: [repo.installed.buildNumber] } });
  await assert.rejects(confirmSparkleCandidate(options), /trusted version for recovery/);
  repo.publish({ version: 3, release: { ...release, artifact: {
    ...artifact, sparkleEdSignature: sign(null, Buffer.from('different archive'), privateKey).toString('base64'),
  } } });
  await assert.rejects(startSparkleSession(options), /signature does not match/);
  assert.deepEqual(await readdir(repo.stagingParent), []);
});
