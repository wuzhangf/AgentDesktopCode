import { readFile } from 'node:fs/promises';
import { confirmSparkleCandidate, startSparkleSession } from './sparkle-session.mjs';
import { CurrentBuildError } from './verify-release.mjs';

const confirming = process.argv[3] === '--confirm';

async function main() {
  const options = JSON.parse(await readFile(process.argv[2], 'utf8'));
  if (confirming) {
    process.stdout.write(JSON.stringify(await confirmSparkleCandidate(options)) + '\n');
    return;
  }
  const session = await startSparkleSession(options);
  let closing = false;
  async function stop() {
    if (closing) return;
    closing = true;
    try { await session.close(); }
    finally { process.exit(0); }
  }
  process.stdin.once('end', stop);
  process.stdin.once('error', stop);
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  process.stdin.resume();
  process.stdout.write(JSON.stringify(session.candidate) + '\n');
}

void main().catch(error => {
  if (!confirming && error instanceof CurrentBuildError) {
    process.stdout.write(JSON.stringify({ status: 'current' }) + '\n');
    return;
  }
  process.stderr.write(String(error?.message ?? 'Update verification failed') + '\n');
  process.exitCode = 1;
});
