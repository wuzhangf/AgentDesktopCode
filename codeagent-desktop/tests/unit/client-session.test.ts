import { describe, expect, it } from 'vitest';
import { ServiceClient } from '../../packages/service-client/src/index';

describe('ServiceClient client-session transport', () => {
  it('registers without a session secret and sends it on later requests', async () => {
    const seen: Array<{ path: string; clientToken: string | null; key: string | null }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const headers = new Headers(init?.headers);
      seen.push({
        path: new URL(url).pathname,
        clientToken: headers.get('X-CodeAgent-Client-Token'),
        key: headers.get('Idempotency-Key')
      });
      if (new URL(url).pathname === '/api/v2/client-sessions') {
        return new Response(JSON.stringify({
          clientSessionId: 's1', clientSessionToken: 'x'.repeat(64),
          storeId: 'store', bootId: 'boot', ttlMillis: 90000,
          remainingTtlMillis: 90000, acceptedProtocols: ['v2']
        }), { status: 201, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({
        clientSessionId: 's1', serverTimeMillis: 1, remainingTtlMillis: 89999
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const registration = new ServiceClient({ baseUrl: 'http://service.test', token: 'bearer', fetchImpl });
    const result = await registration.registerClientSession({
      registrationKey: 'r1', clientId: 'c1', processInstanceId: 'p1',
      clientKind: 'ELECTRON', protocols: ['v2']
    }, 'r1');
    expect(result.clientSessionId).toBe('s1');
    const connected = new ServiceClient({
      baseUrl: 'http://service.test', token: 'bearer',
      clientSessionToken: result.clientSessionToken, fetchImpl
    });
    await connected.heartbeatClientSession('s1', 'heartbeat-1');
    expect(seen).toEqual([
      { path: '/api/v2/client-sessions', clientToken: null, key: 'r1' },
      { path: '/api/v2/client-sessions/s1/heartbeat', clientToken: 'x'.repeat(64), key: 'heartbeat-1' }
    ]);
  });
});
