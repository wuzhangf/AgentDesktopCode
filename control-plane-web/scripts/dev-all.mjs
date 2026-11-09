// Dev launcher: API server (8788) + Vite dev server (5180) in one process.
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, '..');

const procs = [
  spawn('node', ['server/main.mjs'], { cwd: appRoot, stdio: 'inherit' }),
  spawn('pnpm', ['exec', 'vite'], { cwd: appRoot, stdio: 'inherit', shell: process.platform === 'win32' }),
];
for (const p of procs) p.on('exit', (code) => { if (code) console.error(`child exited ${code}`); });
const stop = () => { for (const p of procs) p.kill(); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
