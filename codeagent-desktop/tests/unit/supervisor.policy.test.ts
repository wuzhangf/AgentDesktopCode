import { describe, expect, it } from 'vitest';
import {
  HandshakeError,
  compareVersions,
  isLoopbackEndpoint,
  validateCapabilities
} from '../../electron/main/service/supervisor';

describe('loopback policy (design 6.4 rule 1)', () => {
  it('accepts only loopback http endpoints', () => {
    expect(isLoopbackEndpoint('http://127.0.0.1:8080')).toBe(true);
    expect(isLoopbackEndpoint('http://localhost:8080')).toBe(true);
    expect(isLoopbackEndpoint('http://[::1]:8080')).toBe(true);
    expect(isLoopbackEndpoint('https://127.0.0.1:8080')).toBe(false);
    expect(isLoopbackEndpoint('http://10.1.2.3:8080')).toBe(false);
    expect(isLoopbackEndpoint('http://example.com')).toBe(false);
    expect(isLoopbackEndpoint('http://127.0.0.1:8080/path')).toBe(false);
    expect(isLoopbackEndpoint('http://127.0.0.1:8080?token=secret')).toBe(false);
    expect(isLoopbackEndpoint('http://user:pass@127.0.0.1:8080')).toBe(false);
    expect(isLoopbackEndpoint('not a url')).toBe(false);
  });
});

describe('version compatibility (fail closed)', () => {
  it('compares dotted versions numerically', () => {
    expect(compareVersions('2.1', '2.0')).toBeGreaterThan(0);
    expect(compareVersions('2.0', '2.0')).toBe(0);
    expect(compareVersions('2.10', '2.9')).toBeGreaterThan(0);
    expect(compareVersions('1.9', '2.0')).toBeLessThan(0);
  });

  it('accepts a compatible capability payload', () => {
    const result = validateCapabilities({
      serviceInstanceId: 'svc-1',
      protocolVersion: '2.1',
      minDesktopProtocol: '2.0',
      features: { sessionV2: true },
      operations: [{ id: 'session.create.inspect', availability: 'AVAILABLE', contractVersion: '2.1' }]
    });
    expect(result.ok).toBe(true);
  });

  it('fails closed when the service requires a newer desktop protocol', () => {
    const result = validateCapabilities({
      serviceInstanceId: 'svc-1',
      protocolVersion: '3.0',
      minDesktopProtocol: '2.5'
    });
    expect(result.ok).toBe(false);
  });

  it('fails closed on malformed payloads', () => {
    expect(validateCapabilities(null).ok).toBe(false);
    expect(validateCapabilities({}).ok).toBe(false);
    expect(validateCapabilities({ serviceInstanceId: 'svc', protocolVersion: '' }).ok).toBe(false);
    expect(validateCapabilities({ serviceInstanceId: 'svc', protocolVersion: '2.x', operations: [] }).ok).toBe(false);
    expect(validateCapabilities({ serviceInstanceId: 'svc', protocolVersion: '2.1', minDesktopProtocol: '2.x', operations: [] }).ok).toBe(false);
    expect(validateCapabilities({ serviceInstanceId: 'svc', protocolVersion: '2.1', features: [], operations: [] }).ok).toBe(false);
    expect(validateCapabilities({ serviceInstanceId: 'svc', protocolVersion: '2.1', minDesktopProtocol: 2, operations: [] }).ok).toBe(false);
  });
});

describe('handshake error typing', () => {
  it('rejects non-loopback endpoints before any network call', async () => {
    const err = await handshakeExpectError('http://10.1.2.3:9999', 'tok');
    expect(err).toBeInstanceOf(HandshakeError);
    expect((err as HandshakeError).code).toBe('NON_LOOPBACK');
  });

  it('rejects missing tokens before any network call', async () => {
    const err = await handshakeExpectError('http://127.0.0.1:9999', '');
    expect((err as HandshakeError).code).toBe('INVALID_CAPABILITIES');
  });

  it('does not follow redirects while carrying the bearer token', async () => {
    const { handshake } = await import('../../electron/main/service/supervisor');
    let requestInit: RequestInit | undefined;
    const response = await handshake('http://127.0.0.1:9999', 'token', async (_input, init) => {
      requestInit = init;
      return new Response(JSON.stringify({
        serviceInstanceId: 'svc-redirect-test',
        protocolVersion: '2.1',
        operations: []
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    expect(response.serviceInstanceId).toBe('svc-redirect-test');
    expect(requestInit?.redirect).toBe('error');
  });
});

async function handshakeExpectError(endpoint: string, token: string): Promise<unknown> {
  const { handshake } = await import('../../electron/main/service/supervisor');
  try {
    await handshake(endpoint, token);
    return null;
  } catch (err) {
    return err;
  }
}
