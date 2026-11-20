import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { collectDiagnostics, writeDiagnostics } from '../../../agent-link-linux/diagnostics.mjs';

const identity = '5ab3e498-a673-4b46-b3a1-cd2dc24b3ee2';
const service = 'agent-link.service';

async function fixture(t) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'agent-link-diagnostics-')));
  const previous = process.env.XDG_CONFIG_HOME;
  const config = join(directory, 'config');
  process.env.XDG_CONFIG_HOME = config;
  t.after(async () => {
    if (previous === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previous;
    await rm(directory, { recursive: true, force: true });
  });
  const source = join(directory, 'package');
  const prefix = join(directory, 'agent-link');
  const program = join(prefix, 'program');
  const updateRoot = join(prefix, 'updates');
  const units = join(config, 'systemd', 'user');
  await Promise.all([source, program, updateRoot, units].map(path => mkdir(path, { recursive: true })));
  async function manifest(path, buildNumber) {
    await mkdir(path, { recursive: true });
    await writeFile(join(path, 'release-manifest.json'), JSON.stringify({
      schemaVersion: 1, product: 'Agent Link', platform: 'linux', arch: 'x64', version: '0.2.1', buildNumber,
      versionDetails: { privatePath: '/home/private/project' },
    }));
  }
  await manifest(source, 75);
  return { directory, source, prefix, program, updateRoot, units, manifest };
}

test('projects bounded diagnostics from the selected Linux installation', async t => {
  const f = await fixture(t);
  await f.manifest(join(f.program, 'versions/74'), 74);
  await f.manifest(join(f.program, 'versions/73'), 73);
  const privateDetails = '/home/private/project with API_KEY=test-private-token';
  await Promise.all([
    symlink('versions/74', join(f.program, 'current')),
    symlink('versions/73', join(f.program, 'previous')),
    writeFile(join(f.program, 'pending'), identity + '\n'),
    writeFile(join(f.program, 'transaction.json'), JSON.stringify({ operationId: identity, data: privateDetails })),
    writeFile(join(f.program, 'last-failed-build'), 'versions/75\n'),
    writeFile(join(f.program, 'install-result.json'), JSON.stringify({
      operationId: identity, candidate: 'versions/75', outcome: 'restored', stdout: privateDetails,
    })),
    writeFile(join(f.updateRoot, 'settings.json'), JSON.stringify({
      channel: 'preview', metadataBaseUrl: 'https://private.example/' + privateDetails,
    })),
    writeFile(join(f.updateRoot, 'automatic.json'), JSON.stringify({ outcome: 'retry', nextCheckAt: 400, message: privateDetails })),
    writeFile(join(f.updateRoot, 'withdrawn-builds.json'), '[74]'),
    writeFile(join(f.units, service), `[Service]\nExecStart="${f.prefix}/program/current/launch.sh"\n`),
    writeFile(join(f.units, 'agent-link-update.service'), `[Service]\nExecStart="${f.prefix}/program/updater/node"\n`),
  ]);
  const report = collectDiagnostics(f.source, f.prefix, name => ({
    LoadState: 'loaded', ActiveState: name === service ? 'failed' : 'active',
    Result: 'exit-code', ExecMainStatus: '78', FragmentPath: join(f.units, name),
    UnitFileState: 'enabled', ExecStart: privateDetails,
  }));
  assert.equal(report.schemaVersion, 'agent-link-diagnostics/1');
  assert.deepEqual(report.package, { version: '0.2.1', buildNumber: 75 });
  assert.deepEqual(report.installation, {
    state: 'switching', selectedRelease: { version: '0.2.1', buildNumber: 74 }, selectedBuild: 74,
    previousBuild: 73, failedBuild: 75, selectedBuildWithdrawn: true, operationId: identity,
    lastResult: { operationId: identity, buildNumber: 75, outcome: 'restored' },
  });
  assert.deepEqual(report.gateway, { state: 'failed', result: 'exit-code', exitStatus: 78 });
  assert.deepEqual(report.updates, {
    channel: 'preview', schedule: { outcome: 'retry', nextCheckAt: 400 }, timer: { state: 'active', mode: 'enabled' },
  });
  assert(report.errorCodes.includes('SIGNED_REPAIR_REQUIRED'));
  assert(report.errorCodes.includes('CANDIDATE_INSTALLATION_FAILED'));
  assert(report.errorCodes.includes('UPDATE_RETRY_SCHEDULED'));
  assert(!/\/home\/private|private-token|private\.example/.test(JSON.stringify(report)));
});

test('diagnostics survives corrupt or unsafe local state and an absent user manager', async t => {
  const f = await fixture(t);
  await Promise.all([
    symlink('../../other-user/versions/73', join(f.program, 'current')),
    symlink('/dev/zero', join(f.updateRoot, 'automatic.json')),
    writeFile(join(f.updateRoot, 'settings.json'), JSON.stringify({ channel: 'invalid private value' })),
    writeFile(join(f.program, 'transaction.json'), 'x'.repeat(8193)),
    writeFile(join(f.program, 'pending'), identity),
  ]);
  const report = collectDiagnostics(f.source, f.prefix, () => undefined);
  assert.equal(report.installation.state, 'switching');
  assert.equal(report.installation.operationId, null);
  assert.equal(report.installation.selectedRelease, null);
  assert.equal(report.sources.installationJournal, 'unreadable');
  assert.equal(report.sources.currentSlot, 'unreadable');
  assert.equal(report.sources.updateSchedule, 'unreadable');
  assert.equal(report.updates.channel, 'unavailable');
  assert.deepEqual(report.gateway, { state: 'unavailable' });
  assert(report.errorCodes.includes('USER_SERVICE_MANAGER_UNAVAILABLE'));
  assert(!JSON.stringify(report).includes(identity));
  assert(!JSON.stringify(report).includes('invalid private value'));
});

test('exports a private new file and preserves existing files and symlink destinations', async t => {
  const f = await fixture(t);
  const report = collectDiagnostics(f.source, f.prefix, () => ({ LoadState: 'not-found' }));
  assert.equal(report.installation.state, 'not-installed');
  assert.equal(report.gateway.state, 'not-loaded');
  const file = join(f.directory, 'report.json');
  writeDiagnostics(file, report);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(await readFile(file)), report);
  assert.throws(() => writeDiagnostics(file, {}), { code: 'EEXIST' });
  const alias = join(f.directory, 'existing-link.json');
  await symlink(file, alias);
  assert.throws(() => writeDiagnostics(alias, {}), { code: 'EEXIST' });
  assert.deepEqual(JSON.parse(await readFile(file)), report);
});
