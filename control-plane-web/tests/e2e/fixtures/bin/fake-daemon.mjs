/**
 * Fake worker daemon for E2E — standalone node process, no dependencies.
 * Protocol mirrors the real daemon surface the console consumes:
 *   GET  /health/live  → 200 {"status":"live"}
 *   GET  /readyz       → {ready, workerId, instanceId, draining, installGate, attemptId, providerBundle}
 *   POST /__ctl        → runtime knobs (test-only): {ready?, draining?, attemptId?, workerId?, instanceId?}
 *   GET  /__ctl        → current in-memory state
 *
 * argv: <stateDir> <healthPort>. installGate is derived from
 * <stateDir>/maintenance/install-gate.json exactly like the daemon:
 * absent → 'disarmed', state DISARMED → 'disarmed', anything else → 'ARMED',
 * unparsable → 'UNREADABLE' (daemon fails closed).
 */
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const stateDir = process.argv[2];
const port = Number(process.argv[3]);
if (!stateDir || !Number.isInteger(port)) {
  console.error('usage: fake-daemon.mjs <stateDir> <healthPort>');
  process.exit(2);
}

const state = {
  ready: process.env.STUB_READY !== '0',
  draining: process.env.STUB_DRAINING === '1',
  attemptId: process.env.STUB_ATTEMPT ?? '',
  workerId: process.env.STUB_WORKER_ID ?? 'w-stub',
  instanceId: `inst-${process.pid}`,
  providerBundle: process.env.STUB_PROVIDER_BUNDLE ?? 'provider-bundle=fixture',
};

function gateState() {
  const file = join(stateDir, 'maintenance', 'install-gate.json');
  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (e) {
    // No gate file (or no dir yet) → the daemon treats the gate as open.
    return e && e.code === 'ENOENT' ? 'disarmed' : 'UNREADABLE';
  }
  try {
    const parsed = JSON.parse(raw);
    return String(parsed?.state ?? '').toUpperCase() === 'DISARMED' ? 'disarmed' : 'ARMED';
  } catch {
    return 'UNREADABLE';
  }
}

function readyz() {
  return {
    ready: state.ready,
    workerId: state.workerId,
    instanceId: state.instanceId,
    draining: state.draining,
    installGate: gateState(),
    attemptId: state.attemptId,
    providerBundle: state.providerBundle,
  };
}

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text) return resolve({});
      try { resolve(JSON.parse(text)); } catch { resolve(null); }
    });
  });
}

const server = createServer(async (req, res) => {
  const path = (req.url ?? '/').split('?')[0];

  if (req.method === 'GET' && path === '/health/live') {
    json(res, 200, { status: 'live' });
    return;
  }
  if (req.method === 'GET' && path === '/readyz') {
    json(res, state.ready ? 200 : 503, readyz());
    return;
  }
  if (path === '/__ctl') {
    if (req.method === 'GET') { json(res, 200, { ...state, installGate: gateState() }); return; }
    if (req.method === 'POST') {
      const patch = await readBody(req);
      if (patch == null) { json(res, 400, { error: 'invalid json' }); return; }
      if (typeof patch.ready === 'boolean') state.ready = patch.ready;
      if (typeof patch.draining === 'boolean') state.draining = patch.draining;
      if (typeof patch.attemptId === 'string') state.attemptId = patch.attemptId;
      if (typeof patch.workerId === 'string') state.workerId = patch.workerId;
      // Re-roll instance id to model a process restart (RESTART assertions).
      if (patch.instanceId === 'rotate') state.instanceId = `inst-${Date.now()}`;
      else if (typeof patch.instanceId === 'string') state.instanceId = patch.instanceId;
      json(res, 200, { ...state, installGate: gateState() });
      return;
    }
  }
  json(res, 404, { error: 'not found' });
});

server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`fake-daemon listening :${port} state=${stateDir}\n`);
});

for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => process.exit(0));
