import assert from 'node:assert/strict';
import { createWriteStream } from 'node:fs';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import test from 'node:test';
import { createGzip } from 'node:zlib';
import tar from 'tar-stream';
import { extractLinuxArchive } from '../src/linux-archive.mjs';

async function fixture(t, headers) {
  const root = await mkdtemp(join(tmpdir(), 'link-linux-tar-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const archive = join(root, 'archive.tar.gz');
  const pack = tar.pack();
  const done = pipeline(pack, createGzip(), createWriteStream(archive));
  for (const header of headers) pack.entry(header, header.type === 'file' ? 'fixture' : '');
  pack.finalize();
  await done;
  return { archive, dest: join(root, 'payload') };
}

test('extracts regular payload files with private permissions', async t => {
  const { archive, dest } = await fixture(t, [
    { name: './', type: 'directory' },
    { name: './runtime/', type: 'directory' },
    { name: './runtime/node', type: 'file', mode: 0o755 },
  ]);
  await extractLinuxArchive(archive, dest);
  assert.equal(await readFile(join(dest, 'runtime/node'), 'utf8'), 'fixture');
  assert.equal((await stat(join(dest, 'runtime/node'))).mode & 0o777, 0o600);
});

test('rejects absolute names, parent components, nonfiles and duplicate names', async t => {
  const invalid = [
    [{ name: '/', type: 'directory' }],
    [{ name: './runtime/../node', type: 'file' }],
    [{ name: './runtime/node', type: 'symlink', linkname: 'node-fixture' }],
    [{ name: './runtime/node', type: 'file' }, { name: 'runtime/node', type: 'file' }],
  ];
  for (const headers of invalid) {
    const { archive, dest } = await fixture(t, headers);
    await assert.rejects(extractLinuxArchive(archive, dest), /unsupported or duplicate entry/);
  }
});
