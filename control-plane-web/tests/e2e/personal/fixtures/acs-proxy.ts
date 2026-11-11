/**
 * BFF ↔ ACS 故障注入代理（只服务真实链路用例，不进入产品代码）。
 *
 * 两个恢复场景需要「源端已受理但 BFF 没拿到响应」与「BFF 已冻结但请求还没
 * 转发」，这两种时序无法用真实 ACS 自己制造：
 * - `dropAfterReply`：把命令 POST 正常转发给 ACS，拿到响应后**丢掉客户端连接**，
 *   于是源端留下命令、BFF 只知道「未确认」。
 * - `hold`：扣住命令 POST 不转发，等用例确认 BFF 已把冻结请求落盘后再决定
 *   转发还是丢弃。
 *
 * 代理是透明的：除被规则命中的请求外，一律原样转发（含状态码、响应体与
 * content-type），并把每个命令 POST 记进 audit，供「业务写入计数」取证。
 */
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface ProxyFact {
  method: string;
  path: string;
  at: string;
  forwarded: boolean;
  droppedClientReply: boolean;
  /** 源端实际返回的状态码（转发失败时为空）。 */
  upstreamStatus?: number;
  upstreamError?: string;
}

export interface HeldCommand {
  readonly path: string;
  readonly body: string;
  /** 放行：真正转发给 ACS。 */
  release(): Promise<void>;
  /** 丢弃：不转发，直接断开（模拟 BFF 与源端之间连接被取消）。 */
  cancel(): void;
}

export type ProxyMode = 'hold' | 'dropAfterReply';

export interface AcsProxy {
  readonly url: string;
  readonly facts: ProxyFact[];
  /** 命中规则且仍在扣留中的命令。 */
  readonly held: HeldCommand[];
  addRule(rule: { path: RegExp; mode: ProxyMode }): void;
  clearRules(): void;
  close(): Promise<void>;
}

const FORWARD_HEADER_BLOCKLIST = new Set(['host', 'connection', 'content-length', 'transfer-encoding', 'keep-alive']);

export async function startAcsProxy(target: string): Promise<AcsProxy> {
  const rules: { path: RegExp; mode: ProxyMode }[] = [];
  const facts: ProxyFact[] = [];
  const held: HeldCommand[] = [];
  const openSockets = new Set<import('node:net').Socket>();

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://proxy.invalid');
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks);
    const rule = rules.find(item => item.path.test(url.pathname));

    const forward = async (): Promise<{ status: number; headers: Record<string, string | string[]>; body: Buffer }> => {
      const headers: Record<string, string | string[]> = {};
      for (const [key, value] of Object.entries(req.headers)) {
        if (value === undefined || FORWARD_HEADER_BLOCKLIST.has(key.toLowerCase())) continue;
        headers[key] = value;
      }
      return new Promise((resolve, reject) => {
        const upstream = httpRequest(`${target}${url.pathname}${url.search}`, { method: req.method, headers }, response => {
          const parts: Buffer[] = [];
          response.on('data', (chunk: Buffer) => parts.push(chunk));
          response.on('end', () => resolve({
            status: response.statusCode ?? 502,
            headers: response.headers as Record<string, string | string[]>,
            body: Buffer.concat(parts),
          }));
        });
        upstream.on('error', reject);
        upstream.setTimeout(60_000, () => upstream.destroy(new Error('proxy upstream timeout')));
        if (body.length) upstream.write(body);
        upstream.end();
      });
    };

    const reply = (outcome: { status: number; headers: Record<string, string | string[]>; body: Buffer }) => {
      const headers: Record<string, string | string[]> = { ...outcome.headers };
      delete headers['content-length'];
      delete headers['transfer-encoding'];
      res.writeHead(outcome.status, headers);
      res.end(outcome.body);
    };

    if (rule?.mode === 'hold' && req.method === 'POST') {
      const fact: ProxyFact = { method: req.method, path: url.pathname, at: new Date().toISOString(), forwarded: false, droppedClientReply: false };
      facts.push(fact);
      const entry: HeldCommand = {
        path: url.pathname,
        body: body.toString('utf8'),
        async release() {
          fact.forwarded = true;
          reply(await forward());
        },
        cancel() { res.destroy(); },
      };
      held.push(entry);
      // 扣留：不写响应，连接保持打开直到 release()/cancel() 或客户端超时。
      return;
    }

    if (rule?.mode === 'dropAfterReply' && req.method === 'POST') {
      // droppedClientReply 只在「源端已回、客户端已断」都完成时才置位，
      // 否则用例会在转发还在飞的时候就去读源端。
      const fact: ProxyFact = { method: req.method, path: url.pathname, at: new Date().toISOString(), forwarded: true, droppedClientReply: false };
      facts.push(fact);
      try { fact.upstreamStatus = (await forward()).status; } catch (error) { fact.upstreamError = String(error); }
      fact.droppedClientReply = true;
      res.destroy();
      return;
    }

    if (req.method === 'POST') {
      facts.push({ method: req.method, path: url.pathname, at: new Date().toISOString(), forwarded: true, droppedClientReply: false });
    }
    try { reply(await forward()); } catch (error) {
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ code: 'PROXY_UPSTREAM_FAILED', message: String(error) }));
    }
  });

  server.on('connection', socket => {
    openSockets.add(socket);
    socket.on('close', () => openSockets.delete(socket));
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    facts,
    held,
    addRule(rule) { rules.push(rule); },
    clearRules() { rules.length = 0; },
    async close() {
      for (const socket of openSockets) socket.destroy();
      await new Promise<void>(done => server.close(() => done()));
    },
  };
}
