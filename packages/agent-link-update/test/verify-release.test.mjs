import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { canonicalize } from '@tufjs/canonical-json';
import { stageVerifiedRelease } from '../src/verify-release.mjs';
import { confirmSparkleCandidate, startSparkleSession } from '../src/sparkle-session.mjs';
import { selectWindowsRelease } from '../src/windows-release.mjs';
import { isWithdrawn, rememberWithdrawals } from '../../../agent-link-linux/slots.mjs';

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

test('publisher stages platform releases, withdraws a build and rotates signing roles', {
  skip: !process.env.AGENT_LINK_PUBLISH_PYTHON && 'Set AGENT_LINK_PUBLISH_PYTHON to test the publisher',
}, async t => {
  const repo = await repository(t);
  const options = repo.options();
  const directory = join(options.stagingParent, 'publisher');
  const rootsDir = join(directory, 'roots');
  await mkdir(rootsDir, { recursive: true });
  const roles = () => ({ root: [keyPair(), keyPair()], targets: [keyPair()],
    snapshot: [keyPair()], timestamp: [keyPair()] });
  const provision = async (version, keys, previousRoot = []) => {
    const root = signed('root', version, {
      consistent_snapshot: true,
      keys: Object.fromEntries(Object.values(keys).flat().map(({ id, model }) => [id, model])),
      roles: Object.fromEntries(Object.entries(keys).map(([role, pairs]) =>
        [role, { keyids: pairs.map(({ id }) => id), threshold: pairs.length }])),
    }, [...previousRoot, ...keys.root]);
    await writeFile(join(rootsDir, version + '.root.json'), root);
    return root;
  };
  const initial = roles();
  await writeFile(join(options.metadataDir, 'root.json'), await provision(1, initial));
  const credentials = ({ targets, snapshot, timestamp }) => Object.fromEntries(
    Object.entries({ targets, snapshot, timestamp }).filter(([, pairs]) => pairs).map(([role, pairs]) =>
      ['AGENT_LINK_TUF_' + role.toUpperCase() + '_KEYS', JSON.stringify(pairs.map(({ privateKey }) =>
        privateKey.export({ type: 'pkcs8', format: 'pem' })))]),
  );
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('AGENT_LINK_TUF_')));
  const manifest = join(directory, 'manifest.json');
  async function publish(name, keys, { entries, previous } = {}) {
    const output = join(directory, name);
    if (entries) await writeFile(manifest, JSON.stringify(entries));
    await promisify(execFile)(process.env.AGENT_LINK_PUBLISH_PYTHON, [
      fileURLToPath(new URL('../publisher/publish.py', import.meta.url)),
      entries ? 'stage' : 'refresh-timestamp',
      '--root-dir', rootsDir, '--output', output,
      ...(previous ? ['--previous', previous] : ['--initial']),
      ...(entries ? ['--manifest', manifest] : []),
    ], { env: { ...env, ...credentials(keys) }, timeout: 10_000 });
    return output;
  }
  async function serve(output) {
    // Overlay immutable objects, then promote the mutable timestamp.
    const timestamp = 'metadata/timestamp.json';
    const names = await readdir(output, { recursive: true, withFileTypes: true });
    for (const file of names.filter(file => file.isFile())) {
      const path = join(file.parentPath, file.name).slice(output.length + 1);
      if (path !== timestamp) repo.files.set('/' + path, await readFile(join(output, path)));
    }
    repo.files.set('/' + timestamp, await readFile(join(output, timestamp)));
  }
  const entries = [
    ['macos', 'arm64', '15.0', '.zip', 'stable'],
    ['windows', 'x86_64', 'windows-11', '.zip', 'stable'],
    ['linux', 'x86_64', 'ubuntu-24.04', '.tar.gz', 'stable'],
    ['linux', 'x86_64', 'ubuntu-24.04', '.tar.gz', 'preview'],
  ].map(([platform, arch, minOS, extension, channel]) => ({
    archive: 'link-42-' + platform + extension,
    ...(platform === 'macos' ? { sparkleEdSignature: Buffer.alloc(64, 7).toString('base64') } : {}),
    release: { releaseId: 'link-42', displayVersion: '0.2.1', buildNumber: 42, availability: 'published',
      platform, arch, channel, minOS, compatibility: { bootstrapMinVersion: 1, stateReadVersions: [1],
        stateWriteVersion: 1, contractsRevision: 'release-test' },
      rollout: { cohortSeed: 'link-42', percentage: 100 }, withdrawnBuilds: [] },
  }));
  const archives = new Map();
  async function writeArchive({ archive: name, release }) {
    const path = join(directory, name);
    if (release.platform === 'macos') {
      await writeFile(path, name);
    } else {
      await promisify(execFile)(process.env.AGENT_LINK_PUBLISH_PYTHON, ['-c', `
import io, json, sys, tarfile, zipfile
path, platform, version, build = sys.argv[1:]
manifest = {"schemaVersion": 1, "product": "Agent Link", "version": version, "buildNumber": int(build)}
if platform == "linux":
    data = json.dumps({**manifest, "platform": "linux", "arch": "x64"}).encode()
    info = tarfile.TarInfo("./release-manifest.json")
    info.size = len(data)
    with tarfile.open(path, "w:gz") as archive:
        archive.addfile(info, io.BytesIO(data))
else:
    data = json.dumps({**manifest, "fileVersion": "1." + version}).encode("utf-8-sig")
    with zipfile.ZipFile(path, "w") as archive:
        archive.writestr("release-manifest.json", data)
`, path, release.platform, release.displayVersion, String(release.buildNumber)]);
    }
    archives.set(name, await readFile(path));
  }
  for (const entry of entries.slice(0, 3)) await writeArchive(entry);
  const windowsInstaller = 'agent-link-0.2.1-windows.msi';
  const macInstaller = 'Agent-Link-macOS-arm64.dmg';
  await writeFile(join(directory, windowsInstaller), windowsInstaller);
  await writeFile(join(directory, macInstaller), macInstaller);
  function approval(update, installer = update) {
    return {
      qualifiedInstallerSha256: digest(archives.get(installer) ?? installer),
      qualifiedUpdateSha256: digest(archives.get(update)),
      publishedAt: '2026-11-21T00:00:00Z', releaseNotes: 'Qualified release notes', installation: 'Installer instructions',
      ...(installer !== update ? { installer } : {}),
    };
  }
  entries[0].download = approval(entries[0].archive, macInstaller);
  entries[1].download = approval(entries[1].archive, windowsInstaller);
  entries[2].download = approval(entries[2].archive);
  async function catalog(output) {
    const raw = await readFile(join(output, 'catalog.json'));
    const signedTarget = join(output, 'targets', 'publication', digest(raw) + '.catalog.json');
    assert.deepEqual(await readFile(signedTarget), raw);
    const value = JSON.parse(raw);
    assert.equal(value.schemaVersion, 'link-download-catalog/1');
    return value.releases;
  }
  const read = ({ platform, arch, channel }, observeRecord) => stageVerifiedRelease({
    ...options, installed: { ...repo.installed, platform, arch, channel },
    releaseRecordPath: 'channels/' + channel + '/' + platform + '-' + arch + '.json', observeRecord,
  });
  await assert.rejects(publish('wrong-role', { ...initial, targets: initial.timestamp }, { entries }),
    { stderr: /Supply valid keys assigned to the targets role/ });
  await assert.rejects(publish('unqualified', initial, { entries: [{
    ...entries[1], download: { ...entries[1].download, qualifiedInstallerSha256: digest('different MSI') },
  }] }), { stderr: /Public installer bytes differ from the qualified digest/ });
  const wrongWindows = { ...entries[1].release, displayVersion: '0.2.2' };
  await assert.rejects(publish('wrong-windows-version', initial, { entries: [{
    ...entries[1], release: wrongWindows,
  }] }), { stderr: /Public windows package manifest differs/ });
  const wrongLinux = { ...entries[2].release, buildNumber: 43 };
  await assert.rejects(publish('wrong-linux-build', initial, { entries: [{
    ...entries[2], release: wrongLinux,
  }] }), { stderr: /Public linux package manifest differs/ });
  await writeFile(join(directory, 'example.tar.gz'), 'example archive');
  archives.set('example.tar.gz', Buffer.from('example archive'));
  await assert.rejects(publish('example-linux-package', initial, { entries: [{
    ...entries[2], archive: 'example.tar.gz', download: approval('example.tar.gz'),
  }] }), { stderr: /Cannot read the public linux package manifest/ });
  const first = await publish('first', initial, { entries });
  await serve(first);
  for (const entry of entries) {
    const candidate = await read(entry.release);
    assert.equal(candidate.release.buildNumber, 42);
    assert.equal(candidate.release.channel, entry.release.channel);
    assert.deepEqual(await readFile(candidate.archivePath), archives.get(entry.archive));
  }
  const available = await catalog(first);
  assert.equal(available.length, 3);
  assert(available.every(row => row.channel === 'stable' && row.availability === 'published'));
  const publicMac = available.find(row => row.platform === 'macos');
  assert.equal(publicMac.artifact.sha256, digest(macInstaller));
  assert(publicMac.artifact.path.endsWith('.dmg'));
  assert.equal(repo.files.get('/targets/' + publicMac.artifact.path.replace(macInstaller,
    publicMac.artifact.sha256 + '.' + macInstaller)).toString(), macInstaller);
  const publicWindows = available.find(row => row.platform === 'windows');
  assert.equal(publicWindows.artifact.sha256, digest(windowsInstaller));
  assert(publicWindows.artifact.path.endsWith('.msi'));
  assert.equal(repo.files.get('/targets/' + publicWindows.artifact.path.replace(windowsInstaller,
    publicWindows.artifact.sha256 + '.' + windowsInstaller)).toString(), windowsInstaller);

  const linux = entries[2].release;
  const withdrawn = await publish('withdraw', initial, { previous: first,
    entries: [{ release: { ...linux, availability: 'withdrawn' } }] });
  await serve(withdrawn);
  const observed = [];
  await assert.rejects(read(linux, record => observed.push(record.withdrawnBuilds)), /unavailable/);
  assert.equal((await catalog(withdrawn)).find(row => row.platform === 'linux').availability, 'withdrawn');
  assert.deepEqual(observed, [[42]]);
  assert.equal((await read(entries[3].release)).release.buildNumber, 42);
  await assert.rejects(publish('republish', initial, { previous: withdrawn, entries: [{ release: linux }] }),
    { stderr: /withdrawn build needs a higher repair build/ });
  await writeFile(join(directory, 'different.tar.gz'), 'different archive');
  await assert.rejects(publish('collide', initial, { previous: withdrawn, entries: [{
    archive: 'different.tar.gz', release: { ...linux, channel: 'preview', releaseId: 'different' },
  }] }), { stderr: /build number already identifies another release/ });

  const middle = roles();
  const rotated = roles();
  await provision(2, middle, initial.root);
  await provision(3, rotated, middle.root);
  await assert.rejects(publish('renew-old-root', initial, { previous: withdrawn }),
    { stderr: /Stage new targets after root rotation/ });
  const repair = { ...linux, releaseId: 'link-43', buildNumber: 43, displayVersion: '0.2.2' };
  const next = [{ archive: 'repair.tar.gz', release: repair }];
  await writeArchive(next[0]);
  next[0].download = approval(next[0].archive);
  await assert.rejects(publish('stale-keys', initial, { previous: withdrawn, entries: next }),
    { stderr: /Supply valid keys assigned to the targets role/ });
  const repaired = await publish('repair', rotated, { previous: withdrawn, entries: next });
  await serve(repaired);
  const candidate = await read(linux);
  assert.equal(candidate.release.buildNumber, 43);
  assert.deepEqual(candidate.release.withdrawnBuilds, [42]);
  assert.deepEqual(repo.requests.filter(path => /[23]\.root\.json$/.test(path)).slice(-2),
    ['/metadata/2.root.json', '/metadata/3.root.json']);
  assert.deepEqual(await readFile(candidate.archivePath), archives.get(next[0].archive));
  assert.deepEqual((await catalog(repaired)).filter(row => row.platform === 'linux')
    .map(row => [row.buildNumber, row.availability]), [[42, 'withdrawn'], [43, 'published']]);
  await assert.rejects(publish('cross-channel-collision', rotated, { previous: repaired, entries: [{
    archive: entries[2].archive, release: { ...repair, channel: 'preview' },
  }] }), { stderr: /published build number or archive path already identifies another release/ });
  await assert.rejects(publish('changed-seed', rotated, { previous: repaired, entries: [{
    release: { ...repair, rollout: { cohortSeed: 'changed', percentage: 25 } },
  }] }), { stderr: /must keep its rollout seed/ });
  const paused = await publish('pause', rotated, { previous: repaired, entries: [{
    release: { ...repair, rollout: { ...repair.rollout, percentage: 0 } },
  }] });
  assert.equal((await catalog(paused)).find(row => row.buildNumber === 43).availability, 'paused');

  const renewed = await publish('renew', { timestamp: rotated.timestamp }, { previous: repaired });
  for (const name of ['3.targets.json', '3.snapshot.json']) {
    assert.deepEqual(await readFile(join(renewed, 'metadata', name)), await readFile(join(repaired, 'metadata', name)));
  }
  assert.deepEqual(await catalog(renewed), await catalog(repaired));
  await serve(renewed);
  const timestamp = JSON.parse(repo.files.get('/metadata/timestamp.json')).signed;
  assert.equal(timestamp.version, 4);
  assert.equal(timestamp.meta['snapshot.json'].version, 3);
  assert.equal((await read(linux)).release.buildNumber, 43);
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
  assert.deepEqual(await selectWindowsRelease(options, true),
    { state: 'candidate', withdrawn: [41], target: result.target });
  const repair = await selectWindowsRelease(options);
  assert.deepEqual(await readFile(repair.archivePath), archive);
  assert.deepEqual(repair.withdrawn, [41]);
  repo.publish({ version: 4, release: { ...release, withdrawnBuilds: [42] } });
  assert.deepEqual(await selectWindowsRelease({ ...options, installed: { ...options.installed, buildNumber: 42 } }),
    { state: 'repair', withdrawn: [42] });
  assert.equal(repo.requests.filter(path => path === '/targets/' + artifactPath).length, firstDownloadCount);
  repo.publish({ version: 5, release: { ...release, withdrawnBuilds: [40] } });
  await writeFile(options.archiveCache, Buffer.alloc(archive.length, 0x31));
  repo.files.set('/targets/' + artifactPath, Buffer.alloc(archive.length, 0x2a));
  assert.deepEqual(await selectWindowsRelease(options), { state: 'download-deferred', withdrawn: [40] });
  repo.publish({ version: 6, release: { ...release, withdrawnBuilds: [41],
    rollout: { ...release.rollout, percentage: 0 } } });
  assert.deepEqual(await selectWindowsRelease(options), { state: 'repair', withdrawn: [41] });
  repo.publish({ version: 7, release: { ...release, buildNumber: 40, withdrawnBuilds: [41] } });
  await assert.rejects(selectWindowsRelease(options), /build number must be newer/);
});

async function callWindowsVerifier(bundle, options) {
  const request = join(options.stagingParent, 'windows-verification.json');
  await writeFile(request, JSON.stringify(options));
  const { stdout } = await promisify(execFile)(process.execPath, [bundle, request, '--parent-stdin'], { timeout: 5000 });
  return JSON.parse(stdout);
}

test('Windows verifier stops when the launcher pipe closes during metadata refresh', { timeout: 8000 }, async t => {
  const repo = await repository(t);
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const options = { ...repo.options({ ...repo.installed, platform: 'windows' }), cohort: '12'.repeat(16),
    metadataBaseUrl: 'http://127.0.0.1:' + server.address().port + '/metadata/' };
  const request = join(repo.stagingParent, 'windows-orphan.json');
  await writeFile(request, JSON.stringify(options));
  const verifier = process.env.AGENT_LINK_WINDOWS_TEST_VERIFIER ??
    fileURLToPath(new URL('../src/windows-cli.mjs', import.meta.url));
  const child = spawn(process.execPath, [verifier, request, '--parent-stdin'], { stdio: ['pipe', 'ignore', 'ignore'] });
  const exited = once(child, 'exit');
  const fetching = once(server, 'request');
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill(); });
  const first = await Promise.race([fetching.then(() => 'fetching'), exited.then(() => 'exited')]);
  assert.equal(first, 'fetching');
  child.stdin.end();
  assert.deepEqual(await exited, [1, null]);
});

test('refuses expired and replayed metadata', async t => {
  const repo = await repository(t);
  repo.publish({ expired: true });
  await assert.rejects(repo.stage());
  repo.publish({ version: 3 });
  await repo.stage();
  repo.publish({ version: 1 });
  await assert.rejects(repo.stage());
});

test('withdrawal observation requires a verified record for the installed platform and channel', async t => {
  const repo = await repository(t);
  const observed = [];
  const options = { ...repo.options(), observeRecord: record => observed.push(record) };
  repo.publish({ release: { availability: 'withdrawn', withdrawnBuilds: [41] } });
  await assert.rejects(stageVerifiedRelease(options), /unavailable/);
  assert.deepEqual(observed.map(record => [record.availability, record.withdrawnBuilds]), [['withdrawn', [41]]]);
  repo.publish({ version: 2, release: { channel: 'preview', withdrawnBuilds: [42] } });
  await assert.rejects(stageVerifiedRelease(options), /unavailable/);
  repo.publish({ version: 3, release: { withdrawnBuilds: [43] } });
  repo.files.set('/targets/' + recordPath, Buffer.from('unverified changes'));
  await assert.rejects(stageVerifiedRelease(options));
  assert.equal(observed.length, 1);
});

test('Linux persists withdrawn builds across newer records and permits unrelated repairs', async t => {
  const root = await mkdtemp(join(tmpdir(), 'link-linux-withdrawals-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  rememberWithdrawals(root, { availability: 'withdrawn', buildNumber: 42, withdrawnBuilds: [41] });
  rememberWithdrawals(root, { availability: 'published', buildNumber: 43, withdrawnBuilds: [] });
  assert.equal(isWithdrawn(root, 'versions/41'), true);
  assert.equal(isWithdrawn(root, 'versions/42'), true);
  assert.equal(isWithdrawn(root, 'versions/43'), false);
  assert.throws(() => rememberWithdrawals(root, { availability: 'published', withdrawnBuilds: ['43'] }),
    /Invalid signed Linux withdrawal list/);
  assert.equal(isWithdrawn(root, 'versions/43'), false);
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

test('Sparkle CLI reports the authenticated current build without offering an archive', async t => {
  const repo = await repository(t);
  const { publicKey } = generateKeyPairSync('ed25519');
  const options = { ...repo.options({ ...repo.installed, platform: 'macos', buildNumber: 42 }),
    sparkleEdPublicKey: publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64') };
  const request = join(repo.stagingParent, '..', 'sparkle-verification.json');
  await writeFile(request, JSON.stringify(options));
  const cli = fileURLToPath(new URL('../src/sparkle-cli.mjs', import.meta.url));
  const run = (...args) => promisify(execFile)(process.execPath, [cli, request, ...args], { timeout: 5000 });
  repo.publish({ release: { platform: 'macos' } });
  const result = await run();
  assert.deepEqual(JSON.parse(result.stdout), { status: 'current' });
  assert.equal(repo.requests.includes('/targets/' + artifactPath), false);
  await assert.rejects(run('--confirm'), { code: 1, stdout: '' });
  repo.publish({ version: 2, release: { platform: 'macos', availability: 'withdrawn' } });
  await assert.rejects(run(), { code: 1, stdout: '' });
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
