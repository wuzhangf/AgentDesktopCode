import { createConnection } from 'node:net';
import { fail } from './protocol.js';

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
};

export function taskFileBinding(socket: string, key: string, command: string): TaskFileBinding {
  function ask(request: object, field: 'key' | 'deviceId', pattern: RegExp): Promise<string | undefined> {
    return new Promise((resolve) => {
      const connection = createConnection({ path: socket });
      let reply = Buffer.alloc(0);
      const finish = (value?: string) => { connection.destroy(); resolve(value); };
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
          const result = JSON.parse(reply.toString('utf8', 4, 4 + size));
          const value = result[field];
          finish(typeof value === 'string' && pattern.test(value) ? value : undefined);
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
    const token = await ask({ method: 'authorize', attachment, sourceKey }, 'key', /^[a-f0-9]{64}$/);
    if (!token) fail('LINK_FILE_ATTACHMENT_UNAVAILABLE', 409);
    return { id: 'sage-link', command, args: ['--bridge', socket, token] };
  };
  bind.deviceId = () => ask({ method: 'device' }, 'deviceId', /^[a-zA-Z0-9_-]{1,64}$/);
  return bind;
}
