import { describe, expect, it } from 'vitest';
import { ServiceClient } from '../../packages/service-client/src/index';

describe('ServiceClient image attachment bytes', () => {
  it('reads the bytes route with the loopback auth headers and returns bounded data', async () => {
    let seenPath = '';
    let seenAccept = '';
    const client = new ServiceClient({
      baseUrl: 'http://service.test',
      token: 'bearer-token',
      fetchImpl: async (input, init) => {
        seenPath = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url).pathname;
        seenAccept = new Headers(init?.headers).get('accept') ?? '';
        return new Response(Uint8Array.from([1, 2, 3]), {
          status: 200,
          headers: { 'content-type': 'image/png' }
        });
      }
    });

    await expect(client.getSessionAttachmentBytes('s/1', 'm 1', 'a:1')).resolves.toEqual({
      mediaType: 'image/png',
      dataBase64: 'AQID',
      sizeBytes: 3
    });
    expect(seenPath).toBe('/api/v2/sessions/s%2F1/messages/m%201/attachments/a%3A1/bytes');
    expect(seenAccept).toContain('image/png');
  });

  it('fails closed when the bytes route returns a non-image media type', async () => {
    const client = new ServiceClient({
      baseUrl: 'http://service.test',
      token: 'bearer-token',
      fetchImpl: async () => new Response('not an image', {
        status: 200,
        headers: { 'content-type': 'text/plain' }
      })
    });

    await expect(client.getSessionAttachmentBytes('s', 'm', 'a'))
      .rejects.toMatchObject({ code: 'PROTOCOL_ERROR' });
  });
});
