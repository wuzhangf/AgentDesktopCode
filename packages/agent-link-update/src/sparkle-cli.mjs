import { readFile } from 'node:fs/promises';
import { startSparkleSession } from './sparkle-session.mjs';

async function main() {
  const options = JSON.parse(await readFile(process.argv[2], 'utf8'));
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
  process.stderr.write(String(error?.message ?? 'Update verification failed') + '\n');
  process.exitCode = 1;
});
