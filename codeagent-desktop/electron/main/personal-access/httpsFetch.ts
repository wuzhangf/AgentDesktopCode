/**
 * CA-pinned fetch for the personal-access (PAC) connection.
 *
 * A personal access server presents a certificate that is not in the OS trust
 * store, so the connection setup may name a PEM file explicitly. Verification
 * stays on (`rejectUnauthorized: true`) and only that CA is added — we never
 * disable certificate checks and never fall back to plaintext after a TLS
 * failure. Loopback http bindings keep using the platform fetch.
 */

import https from 'node:https';
import { Readable } from 'node:stream';

export function createCaPinnedFetch(caPem: string): typeof globalThis.fetch {
  if (!caPem.includes('BEGIN CERTIFICATE')) throw new Error('CA file does not contain a PEM certificate');
  return async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url);
    if (url.protocol !== 'https:') throw new Error('pinned fetch only supports https origins');
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => { headers[key] = value; });
    const body = typeof init?.body === 'string' ? init.body : undefined;
    return await new Promise<Response>((resolve, reject) => {
      const request = https.request({
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname + url.search,
        method: init?.method ?? 'GET',
        headers,
        ca: caPem,
        rejectUnauthorized: true
      }, (response) => {
        const stream = Readable.toWeb(response) as unknown as ReadableStream<Uint8Array>;
        resolve(new Response(stream, {
          status: response.statusCode ?? 0,
          statusText: response.statusMessage ?? '',
          headers: flattenHeaders(response.headers)
        }));
      });
      request.on('error', reject);
      if (body) request.write(body);
      request.end();
    });
  };
}

function flattenHeaders(headers: NodeJS.Dict<string | string[]>): Headers {
  const result = new Headers();
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) result.append(key, item);
    } else {
      result.set(key, value);
    }
  }
  return result;
}
