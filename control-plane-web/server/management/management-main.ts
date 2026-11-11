import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createManagementServer } from './server';
import { personalInstall } from './personal-install';

// Layout: source is server/management/*, the built bundle is .local/management-server/*.
// Either way the app root is two levels up — do not depend on the caller's cwd.
const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const port = Number(process.env.PERSONAL_CONSOLE_PORT ?? 8860);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid PERSONAL_CONSOLE_PORT');
const root = resolve(appRoot, process.env.PERSONAL_CONSOLE_ROOT ?? '.local/personal-console');
const dist = resolve(appRoot, process.env.PERSONAL_CONSOLE_DIST ?? 'dist');
const personalGateway = personalInstall(resolve(process.env.PERSONAL_DATA_DIR ?? resolve(root, 'personal')), dist);
if (process.env.PERSONAL_CONTROL_PORT) console.warn('PERSONAL_CONTROL_PORT retired; use PERSONAL_CONSOLE_PORT (one listener)');
const { server, store, ready } = createManagementServer({
  root, dist, personalGateway, obsApiUrl: process.env.PERSONAL_OBS_API_URL ?? null,
});
void ready.catch(() => console.warn('Worker reconciliation unavailable; personal task API remains available'));
server.listen(port, '127.0.0.1',
  () => console.log(`Personal console: http://127.0.0.1:${port}/  state=${root}`));
let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => {
  if (stopping) return;
  stopping = true;
  // Managed workers keep running — the next boot re-adopts them by pid+ownership.
  server.close(); server.closeAllConnections();
  void personalGateway.close().finally(() => { try { store.close(); } catch {} });
});
