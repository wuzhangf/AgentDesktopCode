import { describe, expect, it } from 'vitest';
import { ServiceClient } from '../../packages/service-client/src/index';

describe('ServiceClient receipt and snapshot transport', () => {
  it('binds receipt lookup and snapshot continuation to the service session', async () => {
    const calls: Array<{ url: string; method: string; key: string | null; body: string | null }> = [];
    const receiptId = `rcpt_${'a'.repeat(64)}`;
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const headers = new Headers(init?.headers);
      calls.push({
        url,
        method: init?.method ?? 'GET',
        key: headers.get('Idempotency-Key'),
        body: typeof init?.body === 'string' ? init.body : null
      });
      if (url.includes('/operations/lookup')) {
        return new Response(JSON.stringify({
          receiptId,
          operation: 'session.patch',
          resourceId: 'session-1',
          status: 'APPLIED',
          requestHash: 'hash',
          createdAtMillis: 1,
          result: { sessionId: 'session-1' }
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (url.includes('/event-snapshots')) {
        return new Response(JSON.stringify({
          consistency: 'RESOURCE_VERSIONED',
          events: [],
          nextCursor: 8,
          scannedThroughCursor: 8,
          highWaterMark: 8,
          retentionFloor: 0,
          snapshotCursor: 8,
          nextPageToken: null,
          expiresAt: 9_000,
          complete: true,
          truncated: false,
          responseBytes: 64
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({
        receiptId,
        operation: 'session.patch',
        resourceId: 'session-1',
        status: 'APPLIED',
        requestHash: 'hash',
        createdAtMillis: 1
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const client = new ServiceClient({
      baseUrl: 'http://service.test',
      token: 'bearer',
      clientSessionToken: 'session-token',
      fetchImpl
    });

    const receipt = await client.lookupOperationReceipt({
      operation: 'session.patch', resourceId: 'session-1', idempotencyKey: 'lookup-key'
    });
    const snapshot = await client.getEventSnapshot('SESSION', {
      scopeId: 'session/1', pageSize: 100, snapshotToken: 'opaque-token'
    });

    expect(receipt.receiptId).toBe(receiptId);
    expect(snapshot.highWaterMark).toBe(8);
    expect(calls[0]).toMatchObject({
      method: 'POST',
      key: 'lookup-key',
      body: JSON.stringify({ operation: 'session.patch', resourceId: 'session-1', idempotencyKey: 'lookup-key' })
    });
    expect(calls[1]?.url).toBe(
      'http://service.test/api/v2/event-snapshots?scopeType=SESSION&scopeId=session%2F1&pageSize=100&snapshotToken=opaque-token'
    );
    expect(calls[1]?.key).toBeNull();
  });
});
