import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import tar from 'tar-stream';
import { isPayloadFile, manifestName } from '../../../agent-link-linux/slots.mjs';

const expandedLimit = 256 * 1024 * 1024;
const maxEntries = 128;
const directoryName = /^(?:hooks|runtime|systemd|bootstrap|adapters(?:\/[a-zA-Z0-9_-]+)?)$/;

/** Extract regular release files into a new directory owned by this session. */
export async function extractLinuxArchive(archive, destination) {
  await mkdir(destination, { mode: 0o700 });
  const seen = new Set();
  const reader = tar.extract();
  let expanded = 0;
  const limit = new Transform({
    transform(chunk, encoding, done) {
      expanded += chunk.length;
      if (expanded > expandedLimit) done(new Error('Linux archive expands beyond the installation limit'));
      else done(null, chunk);
    },
  });

  async function entry(header, stream) {
    const directory = header.type === 'directory';
    const relativeName = header.name.replace(/^\.\//, '');
    const name = directory ? relativeName.replace(/\/$/, '') : relativeName;
    const valid = directory ? name === '' || name === '.' || directoryName.test(name)
      : header.type === 'file' && (name === manifestName || isPayloadFile(name));
    const key = name === '.' ? '' : name;
    if (!valid || header.name.startsWith('/') || header.pax || !Number.isSafeInteger(header.size) || header.size < 0 ||
        header.size > expandedLimit || (directory && header.size !== 0) ||
        seen.has(key) || seen.size >= maxEntries) {
      throw new Error('Linux archive contains an unsupported or duplicate entry');
    }
    seen.add(key);
    const path = join(destination, name);
    if (directory) {
      await mkdir(path, { recursive: true, mode: 0o700 });
      for await (const _ of stream) { /* Drain the directory entry. */ }
    } else {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      await pipeline(stream, createWriteStream(path, { mode: 0o600, flags: 'wx' }));
    }
  }
  reader.on('entry', (header, stream, next) => { void entry(header, stream).then(() => next(), next); });
  await pipeline(createReadStream(archive), createGunzip(), limit, reader);
}
