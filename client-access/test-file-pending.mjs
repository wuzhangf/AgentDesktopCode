import { writeFile, readFile, rename } from 'node:fs/promises';
/** Acceptance-only durable storage. Product clients use their own authenticated storage. */
export function filePending(path) {
  return {
    async get(key) { try { return JSON.parse(await readFile(path, 'utf8'))[key] ?? null; } catch (e) { if (e.code === 'ENOENT') return null; throw e; } },
    async set(key, value) {
      let values = {}; try { values = JSON.parse(await readFile(path, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
      values[key] = value; await writeFile(path + '.tmp', JSON.stringify(values)); await rename(path + '.tmp', path);
    },
  };
}
