/**
 * ACS upstream seam — port of PersonalAccessServer.call()/callDeadline() and
 * the ClientAccessService SourcePort closure.
 *
 * Java contract being reproduced:
 *  - fixed loopback http upstream (constructor rejects https/userinfo/
 *    non-loopback/query/fragment/non-empty path);
 *  - Authorization: Bearer <ownerToken> on every call;
 *  - X-CodeAgent-Client-Token carries the per-device client-session binding
 *    (Java binding(device) minted in ClientSessionRegistry — here it is the
 *    opaque token produced by bindings.ts);
 *  - Idempotency-Key forwarded verbatim when present;
 *  - setInstanceFollowRedirects(false) → redirect:'manual';
 *  - bounded reply bytes (Java read(in,max) → BODY_TOO_LARGE 413);
 *  - connectTimeout≈3s/readTimeout≈12s collapsed into one 15s deadline —
 *    timeout → UPSTREAM_OUTCOME_UNKNOWN 504, other I/O → UPSTREAM_UNAVAILABLE
 *    503 (Java SocketTimeoutException/Exception split at remote()).
 */
import { fail, GatewayError } from './protocol.js';
import type { Device } from './protocol.js';
import type { AcsReply, GatewayAcs, JsonObject } from './context.js';

/** Java ClientSessionApiHandler.CLIENT_TOKEN_HEADER. */
export const CLIENT_TOKEN_HEADER = 'x-codeagent-client-token';

const DEFAULT_MAX_REPLY = 1_048_576;
const CLIENT_MAX_REPLY = 262_144;
const DEADLINE_MS = 15_000;

export interface AcsClientOptions {
  /** Fixed loopback http origin, e.g. http://127.0.0.1:8080 — validated like Java. */
  origin: string;
  /** Owner bearer sent to the upstream on every call. */
  ownerToken: string;
  /** Binding resolver — Java binding(device); wiring installs bindings.ts. */
  binding?: (device: Device) => string | undefined;
  fetchImpl?: typeof fetch;
}

/**
 * Java constructor check: scheme http, no user info, loopback host, no query,
 * no fragment, empty path. Throws Error('LOCAL_ORIGIN_INVALID: ...') so the
 * entry point can wrap it as a config failure.
 */
export function validateLoopbackOrigin(origin: string): URL {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    throw new Error(`LOCAL_ORIGIN_INVALID: ${origin} is not a valid URL`);
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const loopback = host === 'localhost' || host === '::1'
    || /^127(?:\.[0-9]{1,3}){3}$/.test(host);
  if (url.protocol !== 'http:' || url.username !== '' || url.password !== ''
    || !loopback || url.search !== '' || url.hash !== ''
    || !(url.pathname === '' || url.pathname === '/')) {
    throw new Error('LOCAL_ORIGIN_INVALID: fixed local ACS upstream must be a plain http://loopback[:port] origin');
  }
  return url;
}

const parseJson = (bytes: Uint8Array): unknown => {
  try {
    return JSON.parse(Buffer.from(bytes).toString('utf8'));
  } catch {
    // Java: mapper.readTree failure inside remote() → generic Exception.
    fail('UPSTREAM_UNAVAILABLE', 503);
  }
};

const isTimeout = (error: unknown): boolean =>
  error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');

export function createAcsClient(opts: AcsClientOptions): GatewayAcs {
  const base = validateLoopbackOrigin(opts.origin);
  const origin = base.origin;
  const fetchImpl = opts.fetchImpl ?? fetch;

  const call = async (
    method: string,
    path: string,
    body: Uint8Array | undefined,
    key: string | undefined,
    binding: string | undefined,
    maxReplyBytes = DEFAULT_MAX_REPLY,
  ): Promise<AcsReply> => {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${opts.ownerToken}`,
      Accept: 'application/json',
    };
    if (binding !== undefined) headers[CLIENT_TOKEN_HEADER] = binding;
    if (key !== undefined) headers['Idempotency-Key'] = key;
    if (body !== undefined) headers['Content-Type'] = 'application/json';

    let res: Response;
    try {
      res = await fetchImpl(`${origin}${path}`, {
        method,
        headers,
        ...(body !== undefined ? { body: Buffer.from(body) } : {}),
        redirect: 'manual',
        signal: AbortSignal.timeout(DEADLINE_MS),
      });
    } catch (error) {
      if (isTimeout(error)) fail('UPSTREAM_OUTCOME_UNKNOWN', 504);
      fail('UPSTREAM_UNAVAILABLE', 503);
    }

    // Java read(in,max): accumulate bounded bytes; oversize → BODY_TOO_LARGE.
    const chunks: Buffer[] = [];
    let size = 0;
    if (res.body !== null) {
      const reader = res.body.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > maxReplyBytes) {
            await reader.cancel().catch(() => undefined);
            fail('BODY_TOO_LARGE', 413);
          }
          chunks.push(Buffer.from(value));
        }
      } catch (error) {
        if (error instanceof GatewayError) throw error;
        if (isTimeout(error)) fail('UPSTREAM_OUTCOME_UNKNOWN', 504);
        fail('UPSTREAM_UNAVAILABLE', 503);
      }
    }
    return {
      status: res.status,
      body: new Uint8Array(Buffer.concat(chunks)),
      contentType: res.headers.get('content-type') ?? 'application/octet-stream',
    };
  };

  const callJson = async (
    device: Device, method: string, path: string, body: unknown, key: string | undefined,
  ): Promise<unknown> => {
    let reply: AcsReply;
    try {
      reply = await call(
        method, path,
        body === undefined ? undefined : new Uint8Array(Buffer.from(JSON.stringify(body), 'utf8')),
        key,
        opts.binding?.(device),
        CLIENT_MAX_REPLY,
      );
    } catch (error) {
      // Java /client closure: BODY_TOO_LARGE on the bounded reply →
      // SOURCE_RESPONSE_TOO_LARGE; everything else propagates.
      if (error instanceof GatewayError && error.code === 'BODY_TOO_LARGE') {
        fail('SOURCE_RESPONSE_TOO_LARGE', 503);
      }
      throw error;
    }
    const result = parseJson(reply.body);
    if (reply.status < 200 || reply.status >= 300) {
      const code = typeof (result as JsonObject)?.code === 'string'
        ? (result as JsonObject).code as string
        : 'SOURCE_UNAVAILABLE';
      fail(code, reply.status);
    }
    return result;
  };

  return { call, callJson };
}
