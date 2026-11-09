import { createWorkerControlServer } from './worker-control';
import { resolve } from 'node:path';

const baseUrl = process.env.WORKER_CONTROL_API_URL;
const token = process.env.WORKER_CONTROL_API_TOKEN;
if (!baseUrl || !token) throw new Error('Load WORKER_CONTROL_API_URL / WORKER_CONTROL_API_TOKEN in the environment, or use worker:fixture');
const port = Number(process.env.WORKER_CONTROL_PORT ?? 8791);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid local port');
const server = createWorkerControlServer({ baseUrl, token, dist: resolve('dist'),
  fixture: process.env.WORKER_FIXTURE_URL && process.env.WORKER_FIXTURE_TOKEN
    ? { url: process.env.WORKER_FIXTURE_URL, token: process.env.WORKER_FIXTURE_TOKEN } : undefined });
server.listen(port, '127.0.0.1', () => console.log(`Worker Web: http://127.0.0.1:${port}/worker.html`));
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => {
  server.close(); server.closeAllConnections();
});
