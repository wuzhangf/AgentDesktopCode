import { readFile } from 'node:fs/promises';
import { selectWindowsRelease } from './windows-release.mjs';

async function main() {
  const options = JSON.parse(await readFile(process.argv[2], 'utf8'));
  const result = await selectWindowsRelease(options, process.argv[3] === 'confirm');
  process.stdout.write(JSON.stringify(result) + '\n');
}

void main().catch(error => {
  process.stderr.write(String(error?.message ?? 'Windows verification failed') + '\n');
  process.exitCode = 1;
});
