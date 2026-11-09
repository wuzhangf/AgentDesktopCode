import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { ServiceClient, ServiceProblem } from '../../codeagent-desktop/packages/service-client/src/index';
import { validWritableOperation } from '../../codeagent-desktop/packages/protocol/src/writable-collaboration';
import { validCollaborationOperation } from '../../codeagent-desktop/packages/protocol/src/collaboration';

interface Options {
  baseUrl: string; token: string; dist: string;
  fixture?: { url: string; token: string };
}
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const COOKIE = 'worker_control';
const TTL = 20 * 60_000;
class Rejected extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}
const reject = (message = 'Invalid bounded control operation'): never => { throw new Rejected(400, 'INVALID_REQUEST', message); };
function object(value: unknown): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return reject();
  return value as Record<string, any>;
}
function exact(value: Record<string, any>, keys: string[]) {
  if (Object.keys(value).some(key => !keys.includes(key))) reject();
}
function id(value: unknown): string { if (typeof value !== 'string' || !ID.test(value)) return reject(); return value; }
export function loopbackUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Worker control requires an HTTP loopback origin');
  }
  return url.origin;
}
async function body(req: IncomingMessage): Promise<Record<string, any>> {
  if (req.headers['content-type'] !== 'application/json') throw new Rejected(415, 'JSON_REQUIRED', 'Use application/json');
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1024 * 1024) throw new Rejected(413, 'REQUEST_TOO_LARGE', 'Request exceeds 1 MiB');
    chunks.push(Buffer.from(chunk));
  }
  try { return object(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
  catch (error) { if (error instanceof Rejected) throw error; return reject('Invalid JSON'); }
}

/** Local BFF. No browser-supplied URL, token, filesystem root or arbitrary HTTP proxy. */
export function createWorkerControlServer(options: Options) {
  const baseUrl = loopbackUrl(options.baseUrl);
  if (options.fixture) loopbackUrl(options.fixture.url);
  const browsers = new Map<string, { client: ServiceClient; clientId: string; token: string; seen: number }>();
  const send = (res: ServerResponse, status: number, value: unknown, headers = {}) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store',
      'x-content-type-options': 'nosniff', ...headers });
    res.end(JSON.stringify(value));
  };
  const clientFetch: typeof fetch = (input, init) => fetch(input, { ...init, redirect: 'error' });
  const client = (clientSessionToken?: string) => new ServiceClient({ baseUrl, token: options.token, clientSessionToken, fetchImpl: clientFetch });
  const cookie = (req: IncomingMessage) => req.headers.cookie?.split(';').map(part => part.trim()).find(part => part.startsWith(COOKIE + '='))?.slice(COOKIE.length + 1);
  const fixture = async (action: string, payload: object = {}) => {
    if (!options.fixture) throw new Rejected(409, 'FIXTURE_UNAVAILABLE', 'This connection uses an existing Host');
    const response = await fetch(options.fixture.url + '/' + action, { method: 'POST', redirect: 'error',
      headers: { Authorization: 'Bearer ' + options.fixture.token, 'content-type': 'application/json' },
      body: JSON.stringify(payload), signal: AbortSignal.timeout(20_000) });
    if (!response.ok) throw new Rejected(response.status, 'FIXTURE_FAILED', 'Fixture operation failed');
    return response.json();
  };
  const server = createServer(async (req, res) => {
    try {
      const host = req.headers.host ?? '';
      if (!/^(localhost|127\.0\.0\.1|\[::1\]):[0-9]+$/.test(host)) throw new Rejected(403, 'HOST_REJECTED', 'Loopback host required');
      const url = new URL(req.url ?? '/', 'http://' + host);
      if (!url.pathname.startsWith('/api/worker/')) {
        if (req.method !== 'GET') throw new Rejected(405, 'METHOD_NOT_ALLOWED', 'GET required');
        const relative = url.pathname === '/' ? 'worker.html' : decodeURIComponent(url.pathname).slice(1);
        if (relative !== 'worker.html' && !relative.startsWith('assets/')) throw new Rejected(404, 'NOT_FOUND', 'Page not found');
        const file = resolve(options.dist, relative);
        if (!file.startsWith(resolve(options.dist) + sep)) throw new Rejected(404, 'NOT_FOUND', 'Page not found');
        let bytes: Buffer; try { bytes = await readFile(file); } catch { throw new Rejected(404, 'NOT_FOUND', 'Build the Web app first'); }
        res.writeHead(200, { 'content-type': ({ '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' } as Record<string, string>)[extname(file)] ?? 'application/octet-stream',
          'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer',
          'content-security-policy': "default-src 'self'; connect-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'" });
        res.end(bytes); return;
      }
      if (req.method !== 'POST') throw new Rejected(405, 'METHOD_NOT_ALLOWED', 'POST required');
      if (req.headers['x-worker-control'] !== '1'
        || req.headers.origin && req.headers.origin !== 'http://' + host
        || req.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(String(req.headers['sec-fetch-site']))) {
        throw new Rejected(403, 'ORIGIN_REJECTED', 'Same-origin control request required');
      }
      const payload = await body(req);
      const tab = id(req.headers['x-worker-tab']);
      const sessionCookie = cookie(req);
      let browser = browsers.get((sessionCookie ?? '') + ':' + tab);
      if (url.pathname === '/api/worker/connect') {
        exact(payload, []);
        if (!browser) {
          if (browsers.size >= 64) throw new Rejected(429, 'CLIENT_LIMIT', 'Close idle clients before registering more');
          const initial = client(); await initial.getCapabilities();
          const key = randomUUID();
          const registered = await initial.registerClientSession({ registrationKey: key, clientId: key,
            processInstanceId: randomUUID(), clientKind: 'WEB_TAB', protocols: ['v2'], displayLabel: 'Local Worker Web' });
          const session = sessionCookie && ID.test(sessionCookie) ? sessionCookie : randomUUID();
          browser = { client: client(registered.clientSessionToken), clientId: registered.clientSessionId, token: registered.clientSessionToken, seen: Date.now() };
          browsers.set(session + ':' + tab, browser);
          if (!sessionCookie) res.setHeader('Set-Cookie', `${COOKIE}=${session}; HttpOnly; SameSite=Strict; Path=/api/worker`);
        }
        browser.seen = Date.now();
        send(res, 200, { mode: options.fixture ? 'FIXTURE' : 'CONNECTED', registered: true, clientKind: 'WEB_TAB', clientId: browser.clientId }); return;
      }
      if (!browser || Date.now() - browser.seen > TTL) throw new Rejected(401, 'WEB_CLIENT_REQUIRED', 'Connect the local Web client first');
      browser.seen = Date.now();
      if (url.pathname !== '/api/worker/call') throw new Rejected(404, 'NOT_FOUND', 'Control operation not found');
      const p = payload; let result: unknown;
      switch (p.action) {
        case 'SESSIONS': exact(p, ['action']); result = await browser.client.listSessions(); break;
        case 'SESSION': exact(p, ['action', 'id']); result = await browser.client.getSession(id(p.id)); break;
        case 'MESSAGE_CONTENT':
          exact(p, ['action', 'id', 'messageId', 'maxBytes']);
          if (p.maxBytes !== 65536) reject();
          result = await browser.client.getMessageContentPage(id(p.id), id(p.messageId), { maxBytes: 65536 }); break;
        case 'RUN': exact(p, ['action', 'id']); result = await browser.client.getRun(id(p.id)); break;
        case 'PROFILES': exact(p, ['action']); result = await browser.client.listAgentProfiles(); break;
        case 'MODELS': exact(p, ['action']); result = await browser.client.getModelCatalog(); break;
        case 'COLLABORATION':
          exact(p, ['action', 'operation']);
          if (!validCollaborationOperation(p.operation)) reject();
          result = await browser.client.collaboration(p.operation); break;
        case 'CAPABILITIES': exact(p, ['action']); result = await browser.client.getCapabilities(); break;
        case 'ACTIVITIES': exact(p, ['action', 'id']); result = await browser.client.getRunActivities(id(p.id), { limit: 50 }); break;
        case 'DIFF': exact(p, ['action', 'id']); result = await browser.client.getRunDiff(id(p.id)); break;
        case 'SNAPSHOT':
        case 'SNAPSHOT_ITEMS':
        case 'COMMAND_RECEIPT': {
          exact(p, ['action', 'id', 'entityId']);
          const path = p.action === 'COMMAND_RECEIPT' ? `/api/v2/runs/${id(p.id)}/commands/${id(p.entityId)}`
            : `/api/v2/sessions/${id(p.id)}/observation-snapshots/${id(p.entityId)}${p.action === 'SNAPSHOT_ITEMS' ? '/items?limit=30' : ''}`;
          const response = await clientFetch(baseUrl + path, { headers: { Authorization: 'Bearer ' + options.token,
            'X-CodeAgent-Client-Token': browser.token }, signal: AbortSignal.timeout(10_000) });
          result = await response.json();
          if (!response.ok) { send(res, response.status, result); return; }
          break;
        }
        case 'WRITABLE':
          exact(p, ['action', 'operation']); if (!validWritableOperation(p.operation)) reject();
          result = await browser.client.writableCollaboration(p.operation); break;
        case 'COMMAND': {
          exact(p, ['action', 'runId', 'key', 'intent', 'version']); id(p.runId); id(p.key);
          if (!['PAUSE', 'RESUME', 'STOP'].includes(p.intent) || !Number.isSafeInteger(p.version) || p.version < (p.intent === 'STOP' ? -1 : 0)) reject();
          // Use the foundation command contract, preserving the exact intent/key on a retry.
          const response = await clientFetch(baseUrl + `/api/v2/runs/${p.runId}/commands`, {
            method: 'POST', headers: { Authorization: 'Bearer ' + options.token, 'content-type': 'application/json',
              'X-CodeAgent-Client-Token': browser.token, 'Idempotency-Key': p.key },
            body: JSON.stringify({ schemaVersion: 'run-command/1', commandId: p.key, intent: p.intent, expectedStateVersion: p.version }),
            signal: AbortSignal.timeout(10_000),
          });
          result = await response.json();
          if (!response.ok) { send(res, response.status, { error: (result as any).detail ?? (result as any).message ?? 'Run command rejected', code: (result as any).code, status: response.status }); return; }
          break;
        }
        case 'FIXTURE_START': exact(p, ['action']); result = await fixture('start'); break;
        case 'FIXTURE_RELEASE': exact(p, ['action']); result = await fixture('release'); break;
        case 'FIXTURE_STATUS': exact(p, ['action']); result = await fixture('status'); break;
        case 'FIXTURE_FINISH': exact(p, ['action']); result = await fixture('finish'); break;
        default: reject();
      }
      send(res, 200, result);
    } catch (error) {
      if (error instanceof ServiceProblem) send(res, error.status >= 400 ? error.status : 502,
        { error: error.message, code: error.code, status: error.status, ...error.details });
      else if (error instanceof Rejected) send(res, error.status, { error: error.message, code: error.code, status: error.status });
      else send(res, 502, { error: 'Host unavailable or incompatible; retain the original operation before reconnecting', code: 'HOST_UNAVAILABLE', status: 502 });
    }
  });
  const timer = setInterval(() => {
    for (const [key, browser] of browsers) {
      if (Date.now() - browser.seen > TTL) {
        browsers.delete(key); void browser.client.revokeClientSession(browser.clientId).catch(() => {});
      } else void browser.client.heartbeatClientSession(browser.clientId).catch(() => {});
    }
  }, 30_000);
  timer.unref();
  server.on('close', () => { clearInterval(timer); browsers.clear(); });
  return server;
}
