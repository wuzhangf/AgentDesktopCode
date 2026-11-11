/**
 * Listeners — two separate servers like Java:
 *
 *   Phone listener (HTTPS, createGatewayListener): every request →
 *   handlePhoneRoute (the /personal/v1 table rejects non-matching paths
 *   itself, exactly like Java's single remote() context).
 *
 *   Owner listener (plain HTTP, createOwnerListener): loopback bind only —
 *   Java installs ownerHandler ONLY on the original owner listener, whose
 *   own gate re-checks the loopback peer + bearer + client-session token.
 *
 * Request normalization:
 *   - raw path/query preserved verbatim (Java getRawPath/getRawQuery — the
 *     INVALID_REQUEST path guard must see %/../ // undecoded);
 *   - rawBody: whole body drained once up to a hard cap (default 16MiB, the
 *     Java messageBudget ceiling); oversize sets bodyError lazily;
 *   - Authorization / Idempotency-Key counts kept (Java header() requires
 *     exactly one value);
 *   - clientSessionHeader: first X-Client-Session, else
 *     X-CodeAgent-Client-Token (Java's wire name) — the owner gate accepts
 *     either spelling;
 *   - clientIp: socket peer only — no X-Forwarded-For trust.
 */
import * as http from 'node:http';
import * as https from 'node:https';
import { isIP } from 'node:net';
import type { GatewayContext, HttpRequest, HttpResponse } from './context.js';
import { handlePhoneRoute } from './phone-api.js';
import { handleOwnerRoute } from './owner-api.js';
import { handleHooksRoute } from './hooks-api.js';
import { attachRequestMeta } from './request-meta.js';

export interface TlsKeyCertMaterial {
  key: Buffer | string;
  cert: Buffer | string;
  ca?: Buffer | string;
}

export interface TlsPfxMaterial {
  pfx: Buffer | string;
  passphrase?: string;
}

export interface GatewayListenerOptions {
  tls: TlsKeyCertMaterial | TlsPfxMaterial;
  ctx: GatewayContext;
  /** Required explicit bind address — no wildcard default. */
  bind: string;
  /** Required listen port, [1,65535]. */
  port: number;
  /** Hard cap on drained request bodies (default 16MiB = Java messageBudget). */
  maxRawBody?: number;
}

export interface OwnerListenerOptions {
  ctx: GatewayContext;
  ownerToken: string;
  /** Required owner client-session token (registry-token analogue). */
  ownerClientToken: string;
  /** Required loopback bind address — non-loopback is rejected. */
  bind: string;
  /** Required owner listen port, [1,65535]. */
  port: number;
  maxRawBody?: number;
}

const DEFAULT_MAX_RAW = 16 * 1024 * 1024;

const requireBind = (bind: string, name: string): string => {
  if (bind === '') throw new Error(`${name}: an explicit bind address is required`);
  if (isIP(bind) === 0 && bind !== 'localhost') {
    throw new Error(`${name}: bind address ${JSON.stringify(bind)} is not an IP literal or localhost`);
  }
  return bind;
};

const requirePort = (port: number, name: string): number => {
  // 0 = OS-assigned port (tests embed listeners); the env entry point still
  // requires [1,65535] explicitly.
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error(`${name}: port must be an integer in [0,65535]`);
  }
  return port;
};

/** Loopback-only check for the owner listener bind address. */
const requireLoopbackBind = (bind: string): string => {
  const b = requireBind(bind, 'owner listener');
  const host = b.startsWith('[') ? b.slice(1, -1) : b;
  const loopback = host === 'localhost' || host === '::1'
    || (isIP(host) === 4 && host.split('.').every((p) => /^\d{1,3}$/.test(p)) && host.startsWith('127.'));
  if (!loopback) {
    throw new Error(`owner listener: bind address ${JSON.stringify(bind)} is not loopback`);
  }
  return b;
};

/** Request-target parse preserving the raw path — URL() would resolve `..`. */
const parseTarget = (target: string): { path: string; rawQuery: string | null } => {
  const q = target.indexOf('?');
  if (q < 0) return { path: target, rawQuery: null };
  return { path: target.slice(0, q), rawQuery: target.slice(q + 1) };
};

/** Count and first value per header name (Java getRequestHeaders() semantics). */
const headerIndex = (rawHeaders: string[]): Map<string, { count: number; first: string | undefined }> => {
  const out = new Map<string, { count: number; first: string | undefined }>();
  for (let i = 0; i + 1 < rawHeaders.length; i += 2) {
    const name = rawHeaders[i].toLowerCase();
    const entry = out.get(name);
    if (entry) entry.count++;
    else out.set(name, { count: 1, first: rawHeaders[i + 1] });
  }
  return out;
};

const send = (res: http.ServerResponse, out: HttpResponse): void => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (out.status === 204) {
    res.writeHead(204);
    res.end();
    return;
  }
  const bytes = out.bodyBytes !== undefined
    ? Buffer.from(out.bodyBytes)
    : Buffer.from(JSON.stringify(out.body ?? null), 'utf8');
  res.setHeader('Content-Type', out.contentType ?? 'application/json; charset=utf-8');
  res.writeHead(out.status, { 'Content-Length': bytes.length });
  res.end(bytes);
};

/**
 * Drain the body once up to maxRawBody. The oversize outcome is reported
 * lazily via HttpRequest.bodyError so routes that never read a body are
 * unaffected — the socket is still drained for connection hygiene.
 */
const readRawBody = (req: http.IncomingMessage, maxRawBody: number): Promise<{
  rawBody: Uint8Array;
  bodyError?: 'BODY_TOO_LARGE';
}> => new Promise((resolve, reject) => {
  const chunks: Buffer[] = [];
  let size = 0;
  let tooLarge = false;
  req.on('data', (chunk: Buffer) => {
    if (tooLarge) return;
    size += chunk.length;
    if (size > maxRawBody) {
      tooLarge = true;
      chunks.length = 0;
      return;
    }
    chunks.push(chunk);
  });
  req.on('end', () => {
    resolve({
      rawBody: new Uint8Array(Buffer.concat(chunks)),
      ...(tooLarge ? { bodyError: 'BODY_TOO_LARGE' as const } : {}),
    });
  });
  req.on('error', reject);
});

const toHttpRequest = async (
  req: http.IncomingMessage, maxRawBody: number,
): Promise<HttpRequest> => {
  const { path, rawQuery } = parseTarget(req.url ?? '/');
  const { rawBody, bodyError } = await readRawBody(req, maxRawBody);
  const headers = headerIndex(req.rawHeaders);

  const authorization = headers.get('authorization');
  const authValue = authorization?.first;
  // Java bearer(): exactly one Authorization value, `Bearer ` + at least one char.
  const accessToken = authorization?.count === 1 && authValue !== undefined
    && authValue.startsWith('Bearer ') && authValue.length >= 8
    ? authValue.substring(7)
    : undefined;
  const idempotency = headers.get('idempotency-key');

  const request: HttpRequest = {
    method: req.method ?? 'GET',
    path,
    query: new URLSearchParams(rawQuery ?? ''),
    rawQuery,
    rawBody,
    ...(bodyError !== undefined ? { bodyError } : {}),
    ...(accessToken !== undefined ? { accessToken } : {}),
    ...(authValue !== undefined ? { authorization: authValue } : {}),
    authorizationCount: authorization?.count ?? 0,
    ...(idempotency?.first !== undefined ? { idempotencyKey: idempotency.first } : {}),
    idempotencyKeyCount: idempotency?.count ?? 0,
    ...(headers.get('x-client-access-version')?.first !== undefined
      ? { clientAccessVersion: headers.get('x-client-access-version')!.first } : {}),
    ...(headers.get('x-client-session')?.first !== undefined
      || headers.get('x-codeagent-client-token')?.first !== undefined
      ? {
        clientSessionHeader: headers.get('x-client-session')?.first
          ?? headers.get('x-codeagent-client-token')!.first,
      }
      : {}),
    clientIp: req.socket.remoteAddress ?? '',
  };
  return request;
};

const dispatch = (
  req: http.IncomingMessage, res: http.ServerResponse, maxRawBody: number,
  handle: (request: HttpRequest) => Promise<HttpResponse>,
): void => {
  void (async () => {
    const request = await toHttpRequest(req, maxRawBody);
    attachRequestMeta(request, {
      contentType: headerIndex(req.rawHeaders).get('content-type')?.first,
    });
    send(res, await handle(request));
  })().catch((error: unknown) => {
    // Listener-level failure (socket/body read) — never leak internals.
    console.error('device-gateway: listener error:', error);
    try {
      if (!res.headersSent) {
        send(res, { status: 500, body: { code: 'INTERNAL', detail: 'INTERNAL' } });
      } else {
        res.end();
      }
    } catch {
      req.socket.destroy();
    }
  });
};

/** Phone listener — HTTPS on the explicitly configured bind/port. */
export function createGatewayListener(opts: GatewayListenerOptions): https.Server {
  const bind = requireBind(opts.bind, 'gateway listener');
  const port = requirePort(opts.port, 'gateway listener');
  const maxRawBody = opts.maxRawBody ?? DEFAULT_MAX_RAW;
  const tlsOptions: https.ServerOptions = 'pfx' in opts.tls
    ? { pfx: opts.tls.pfx, passphrase: opts.tls.passphrase }
    : { key: opts.tls.key, cert: opts.tls.cert, ...(opts.tls.ca !== undefined ? { ca: opts.tls.ca } : {}) };

  const server = https.createServer({
    ...tlsOptions,
    minVersion: 'TLSv1.2',
    maxVersion: 'TLSv1.3',
  });

  server.on('request', (req, res) => {
    dispatch(req, res, maxRawBody, (request) => handlePhoneRoute(opts.ctx, request));
  });
  return server;
}

/** Local connector ingress uses the exact phone handler, TLS identity and
 * device authorization. It is never an owner or arbitrary-proxy endpoint. */
export function createRelayListener(opts: Omit<GatewayListenerOptions, 'bind'>): https.Server {
  return createGatewayListener({ ...opts, bind: '127.0.0.1' });
}

export interface HooksListenerOptions {
  ctx: GatewayContext;
  /** Local hook bearer — distinct from ownerToken and any device grant. */
  hooksToken: string;
  /** Required loopback bind address — non-loopback is rejected. */
  bind: string;
  port: number;
  maxRawBody?: number;
}

/**
 * Hooks listener — plain HTTP on a loopback-only bind, gated by the local
 * hooks token. Serves only the /hooks/v1 table (src/hooks-api.ts).
 */
export function createHooksListener(opts: HooksListenerOptions): http.Server {
  const bind = requireLoopbackBind(opts.bind);
  const port = requirePort(opts.port, 'hooks listener');
  const maxRawBody = opts.maxRawBody ?? DEFAULT_MAX_RAW;
  if (opts.hooksToken === '') throw new Error('hooks listener: hooksToken is required');

  const server = http.createServer();
  server.on('request', (req, res) => {
    dispatch(req, res, maxRawBody, (request) => handleHooksRoute(opts.ctx, request, opts.hooksToken));
  });
  return server;
}

/**
 * Owner listener — plain HTTP on a loopback-only bind, matching Java's
 * separate owner listener (its own gate also verifies the loopback peer).
 */
export function createOwnerListener(opts: OwnerListenerOptions): http.Server {
  const bind = requireLoopbackBind(opts.bind);
  const port = requirePort(opts.port, 'owner listener');
  const maxRawBody = opts.maxRawBody ?? DEFAULT_MAX_RAW;
  if (opts.ownerToken === '') throw new Error('owner listener: ownerToken is required');
  if (opts.ownerClientToken === '') {
    throw new Error('owner listener: ownerClientToken is required (Java registry token analogue)');
  }

  const server = http.createServer();
  server.on('request', (req, res) => {
    dispatch(req, res, maxRawBody, (request) => handleOwnerRoute(opts.ctx, request, {
      ownerToken: opts.ownerToken,
      ownerClientToken: opts.ownerClientToken,
    }));
  });
  return server;
}

export { attachRequestMeta };
