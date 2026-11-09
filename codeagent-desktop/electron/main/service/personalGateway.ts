import {randomUUID} from 'node:crypto';
import {ServiceClient} from '../../../packages/service-client/src/index';

let current: {origin: string; client: ServiceClient} | undefined;

/** Production personal-control owner session. Endpoint and HttpOnly cookie stay
 * in main memory; the renderer only submits the bounded PersonalOperation RPC. */
export function personalGatewayClient(endpoint: string): ServiceClient {
  const url = new URL(endpoint);
  if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)
      || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Personal gateway requires an explicit loopback HTTP origin');
  }
  if (current?.origin === url.origin) return current.client;
  const tab = randomUUID();
  let cookie: string | undefined;
  const fetchImpl: typeof fetch = async (input, init) => {
    const requestUrl = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (requestUrl.origin !== url.origin || !requestUrl.pathname.startsWith('/api/personal/v1/')) {
      throw new Error('Personal gateway request escaped the fixed API origin');
    }
    const headers = new Headers(init?.headers);
    headers.delete('authorization');
    headers.set('x-personal-control', '1');
    headers.set('x-personal-tab', tab);
    headers.set('origin', url.origin);
    if (cookie) headers.set('cookie', cookie);
    const response = await fetch(input, {...init, headers, redirect: 'error'});
    const received = response.headers.get('set-cookie')?.match(/(?:^|,\s*)personal_control=([A-Za-z0-9._-]{1,128})(?:;|$)/);
    if (received) cookie = `personal_control=${received[1]}`;
    return response;
  };
  // ServiceClient's bearer is deliberately removed by the dedicated transport:
  // production personal-control authenticates its owner cookie+tab, not ACS.
  const client = new ServiceClient({baseUrl: url.origin, token: 'unused-personal-transport', fetchImpl, timeoutMs: 120_000});
  current = {origin: url.origin, client};
  return client;
}
