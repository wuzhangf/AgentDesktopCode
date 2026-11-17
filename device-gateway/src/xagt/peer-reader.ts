/**
 * Peer records + the fixed outbound read channel (design §5.2).
 *
 * A peer is another Agent Link device the owner explicitly configured:
 * its HTTPS origin, its leaf-certificate SHA-256 and a reader credential the
 * SOURCE side minted. The local read service unwraps peer-bound refs and
 * forwards the same {version:1, tool, arguments} body to the peer's own
 * POST /api/xagt/v1/read — seven tools, nothing else, no chaining
 * (a receiving Link only resolves its own local refs).
 *
 * TLS is pinned, not CA-based: the socket may negotiate any self-signed
 * material, but the leaf fingerprint must equal the registered pin or the
 * call fails PEER_TLS_MISMATCH. Peer tokens are sealed with the store key,
 * same protection as device envelopes.
 */
import { request } from 'node:https';
import { createHash, randomUUID } from 'node:crypto';
import { isRecord, seal, text, unseal } from '../protocol.js';
import type { GatewayStoreView, JsonObject } from '../context.js';
import { LIMITS, MESSAGES, READ_API_PATH, READ_RPC_VERSION, XagtError, xfail } from './common.js';

const KIND = 'xagt-peer';
const SEAL_AAD = 'xagt-peer';

export interface PeerRecord {
  peerId: string;
  name: string;
  /** Exact https://host:port origin — no path/query/userinfo. */
  origin: string;
  /** Peer leaf certificate SHA-256 (lowercase hex64). */
  certSha256: string;
  /** Sealed source-issued reader token. */
  envelope: string;
  createdAt: string;
  updatedAt: string;
  revision: number;
}

export interface PeerCallResult {
  status: number;
  json: unknown;
}

const normalizeFingerprint = (value: unknown): string => {
  if (typeof value !== 'string') xfail('INVALID_REQUEST', 'certSha256 必须是证书指纹。');
  const hex = value.toLowerCase().replace(/^sha256:/, '').replace(/:/g, '');
  if (!/^[0-9a-f]{64}$/.test(hex)) xfail('INVALID_REQUEST', 'certSha256 必须是 64 位十六进制 SHA-256。');
  return hex;
};

const normalizeOrigin = (raw: unknown): string => {
  if (typeof raw !== 'string' || raw.length > 512) xfail('INVALID_REQUEST', 'origin 必须是 https://host:port。');
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    xfail('INVALID_REQUEST', 'origin 必须是 https://host:port。');
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== ''
      || (url.pathname !== '' && url.pathname !== '/') || url.search !== '' || url.hash !== '') {
    xfail('INVALID_REQUEST', 'origin 必须是纯 https://host:port。');
  }
  return url.origin;
};

export class PeerStore {
  constructor(
    private readonly store: Pick<GatewayStoreView, 'get' | 'put' | 'list' | 'delete'>,
    private readonly keyFn: () => Uint8Array,
  ) {}

  upsert(body: JsonObject): PeerRecord {
    if (this.store.list<PeerRecord>(KIND).length >= LIMITS.peersMax) {
      xfail('INVALID_REQUEST', 'peer 数量已达上限。');
    }
    const origin = normalizeOrigin(body.origin);
    const certSha256 = normalizeFingerprint(body.certSha256);
    const token = text(body, 'token');
    if (token.length > 1024) xfail('INVALID_REQUEST');
    const peerId = body.peerId === undefined ? `xgp-${randomUUID()}` : text(body, 'peerId');
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(peerId)) xfail('INVALID_REQUEST');
    const existing = this.store.get<PeerRecord>(KIND, peerId);
    const now = new Date().toISOString();
    const peer: PeerRecord = {
      peerId,
      name: body.name === undefined ? '' : text(body, 'name').slice(0, 128),
      origin,
      certSha256,
      envelope: seal(token, this.keyFn(), SEAL_AAD),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      revision: (existing?.revision ?? 0) + 1,
    };
    this.store.put(KIND, peerId, peer);
    return peer;
  }

  list(): PeerRecord[] {
    return this.store.list<PeerRecord>(KIND);
  }

  listPublic(): JsonObject[] {
    return this.list().map(({ envelope: _envelope, ...rest }) => rest as unknown as JsonObject);
  }

  get(peerId: string): PeerRecord | undefined {
    return this.store.get<PeerRecord>(KIND, peerId);
  }

  require(peerId: string): PeerRecord {
    const peer = this.get(peerId);
    if (peer === undefined) xfail('NOT_FOUND', '目标 peer 未配置。');
    return peer;
  }

  remove(peerId: string): void {
    this.require(peerId);
    this.store.delete(KIND, peerId);
  }

  /** Decrypted source-issued reader credential for outbound calls. */
  token(peer: PeerRecord): string {
    try {
      return unseal(peer.envelope, this.keyFn(), SEAL_AAD);
    } catch {
      xfail('PEER_NOT_CONFIGURED', 'peer 凭据无法解封。');
    }
  }
}

/**
 * POST {version:1, tool, arguments} to the peer's fixed read path.
 * Transport-level failures throw XagtError; non-2xx statuses come back to the
 * caller (auth/scope codes belong to the envelope layer).
 */
export const peerCall = async (
  peer: PeerRecord,
  token: string,
  tool: string,
  args: Record<string, unknown>,
  deadlineMillis: number,
): Promise<PeerCallResult> => {
  const payload = Buffer.from(JSON.stringify({ version: READ_RPC_VERSION, tool, arguments: args }), 'utf8');
  const origin = new URL(peer.origin);
  const left = deadlineMillis - Date.now();
  if (left <= 0) xfail('SOURCE_OFFLINE', 'peer 调用超出时限。', true);
  return new Promise<PeerCallResult>((resolvePromise, rejectPromise) => {
    const req = request({
      protocol: 'https:',
      hostname: origin.hostname,
      port: origin.port === '' ? 443 : Number(origin.port),
      path: READ_API_PATH,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': payload.length,
        'accept': 'application/json',
        'authorization': `Bearer ${token}`,
      },
      // Fingerprint pinning replaces CA verification for peer links — the
      // owner registered the peer's leaf hash out of band. agent:false
      // forces a fresh handshake per call — a pooled keep-alive socket
      // never re-emits secureConnect and would skip the pin check.
      rejectUnauthorized: false,
      agent: false,
      timeout: Math.min(LIMITS.peerDeadlineMillis, left),
    });
    let settled = false;
    const done = (fn: () => void): void => {
      if (!settled) { settled = true; fn(); }
    };
    req.on('socket', (socket) => {
      (socket as import('node:tls').TLSSocket).on('secureConnect', () => {
        // Fail CLOSED: any failure to obtain/verify the leaf fingerprint —
        // including getPeerCertificate throwing — kills the request.
        try {
          const cert = (socket as import('node:tls').TLSSocket).getPeerCertificate(true);
          const raw = cert?.raw as Buffer | undefined;
          const fingerprint = raw === undefined ? ''
            : createHash('sha256').update(raw).digest('hex');
          if (fingerprint !== peer.certSha256) {
            done(() => {
              req.destroy();
              rejectPromise(new XagtError('PEER_TLS_MISMATCH', MESSAGES.PEER_TLS_MISMATCH!, false));
            });
          }
        } catch {
          done(() => {
            req.destroy();
            rejectPromise(new XagtError('PEER_TLS_MISMATCH', MESSAGES.PEER_TLS_MISMATCH!, false));
          });
        }
      });
    });
    req.on('timeout', () => {
      done(() => {
        req.destroy();
        rejectPromise(new XagtError('SOURCE_OFFLINE', 'peer 连接超时。', true));
      });
    });
    req.on('error', (error: NodeJS.ErrnoException) => {
      done(() => rejectPromise(
        error.code === 'ERR_TLS_CERT_ALTNAME_INVALID' || error.message.includes('certificate')
          ? new XagtError('PEER_TLS_MISMATCH', MESSAGES.PEER_TLS_MISMATCH!, false)
          : new XagtError('SOURCE_OFFLINE', 'peer 无法连接。', true)));
    });
    req.on('response', (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (chunk: Buffer) => {
        if (settled) return; // post-abort buffered chunks must not accumulate
        size += chunk.length;
        if (size > LIMITS.mcpResponseMax) {
          done(() => {
            req.destroy();
            rejectPromise(new XagtError('SOURCE_UNAVAILABLE', 'peer 响应超过上限。', true));
          });
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => {
        done(() => {
          let json: unknown;
          try {
            json = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          } catch {
            rejectPromise(new XagtError('SOURCE_UNAVAILABLE', 'peer 响应不是 JSON。', true));
            return;
          }
          if (!isRecord(json)) {
            rejectPromise(new XagtError('SOURCE_UNAVAILABLE', 'peer 响应不是 JSON 对象。', true));
            return;
          }
          resolvePromise({ status: res.statusCode ?? 0, json });
        });
      });
    });
    req.end(payload);
  });
};
