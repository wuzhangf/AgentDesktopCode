/**
 * Stub Business Service used only by deterministic spike tests.
 * Reads CODEAGENT_SERVICE_PORT / CODEAGENT_SERVICE_TOKEN from env and
 * answers GET /api/v2/capabilities with a minimal capability payload.
 */

import http from 'node:http';

const port = Number(process.env.CODEAGENT_SERVICE_PORT);
const token = process.env.CODEAGENT_SERVICE_TOKEN ?? '';

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
  if (url.pathname === '/api/v2/capabilities') {
    const auth = req.headers.authorization ?? '';
    if (auth !== `Bearer ${token}`) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ code: 'UNAUTHENTICATED' }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        serviceInstanceId: 'svc-stub-0001',
        protocolVersion: '2.1',
        minDesktopProtocol: '2.0',
        features: { sessionV2: true, durableEvents: true },
        limits: { maxEventPage: 500 },
        operations: [{ id: 'session.create.inspect', availability: 'AVAILABLE', contractVersion: '2.1' }]
      })
    );
    return;
  }
  if (url.pathname === '/health') {
    res.writeHead(200);
    res.end('ok');
    return;
  }
  res.writeHead(404);
  res.end();
});

server.listen(port, '127.0.0.1', () => {
  process.stdout.write('ready\n');
});
