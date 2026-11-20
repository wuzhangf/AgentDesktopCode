import { createConnection } from 'node:net';
import { fail, isRecord } from './protocol.js';

export type FileAttachment = {
  transferID: string;
  requestID: string;
  projectID: string;
  expiresAt: number;
  signature: string;
};

export type TaskFileBinding = {
  (attachment: FileAttachment, sourceKey: string): Promise<{
    id: string;
    command: string;
    args: string[];
  }>;
  deviceId?(): Promise<string | undefined>;
  results?(sourceKey: string): Promise<{ files: Record<string, unknown>[]; pending: number }>;
};

export function taskFileBinding(socket: string, key: string, command: string): TaskFileBinding {
  function ask(request: object): Promise<Record<string, unknown> | undefined> {
    return new Promise((resolve) => {
      const connection = createConnection({ path: socket });
      let reply = Buffer.alloc(0);
      const finish = (value?: Record<string, unknown>) => { connection.destroy(); resolve(value); };
      connection.setTimeout(12_000, () => finish());
      connection.once('error', () => finish());
      connection.once('end', () => finish());
      connection.on('data', (data: Buffer) => {
        if (reply.length + data.length > 4096) { finish(); return; }
        reply = Buffer.concat([reply, data]);
        if (reply.length < 4) return;
        const size = reply.readUInt32BE(0);
        if (size === 0 || size > 4092) { finish(); return; }
        if (reply.length < 4 + size) return;
        try {
          const result: unknown = JSON.parse(reply.toString('utf8', 4, 4 + size));
          finish(isRecord(result) ? result : undefined);
        } catch { finish(); }
      });
      connection.once('connect', () => {
        const body = Buffer.from(JSON.stringify({ ...request, key }));
        const size = Buffer.alloc(4);
        size.writeUInt32BE(body.length);
        connection.write(Buffer.concat([size, body]));
      });
    });
  }
  const bind: TaskFileBinding = async (attachment, sourceKey) => {
    const token = (await ask({ method: 'authorize', attachment, sourceKey }))?.key;
    if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) fail('LINK_FILE_ATTACHMENT_UNAVAILABLE', 409);
    return { id: 'sage-link', command, args: ['--bridge', socket, token] };
  };
  bind.deviceId = async () => {
    const device = (await ask({ method: 'device' }))?.deviceId;
    if (typeof device === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(device)) return device;
  };
  if (socket.startsWith('\\\\')) bind.results = async sourceKey => {
    const reply = await ask({ method: 'results', sourceKey });
    const results = reply?.results;
    const pending = reply?.pending;
    if (!Array.isArray(results) || results.length > 16 || !results.every(isRecord) ||
        typeof pending !== 'number' || !Number.isSafeInteger(pending) || pending < 0 || pending > 16) {
      fail('LINK_FILE_RESULTS_UNAVAILABLE', 503);
    }
    return { files: results, pending };
  };
  return bind;
}
