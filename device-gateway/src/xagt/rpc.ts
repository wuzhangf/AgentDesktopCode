/**
 * POST /api/xagt/v1/read — the fixed read RPC shared by two channels:
 *
 *   - the loopback owner listener (the local MCP stdio adapter reaches it
 *     without TLS, credentialed by a reader token);
 *   - the phone HTTPS listener (a peer Link reaches it over the pinned
 *     certificate channel with the source-issued reader token).
 *
 * Request:  {version:1, tool, arguments}
 * Success:  200 {version:1, ok:true,  result: <xagt-read/1 envelope>}
 * Failure:  200 {version:1, ok:false, error:{code,message,retryable}}
 *           — every tool-execution outcome stays in-band so peers and the
 *           MCP adapter can forward code+retryable verbatim.
 * Non-200:  auth (401/410), malformed envelope (400/413) only.
 *
 * This route is the ONLY cross-device surface: seven peer tools and one
 * loopback-only cluster tool, a
 * fixed path, bounded bodies. It is not an HTTP proxy and cannot pass paths,
 * URLs, raw source ids or continuation state it did not itself issue.
 */
import { isRecord } from '../protocol.js';
import type {
  GatewayContext, HttpRequest, HttpResponse, JsonObject, MaybePromise,
} from '../context.js';
import {
  errorBody, isXagtTool, LIMITS, READ_RPC_VERSION, XagtError, xfail,
  type XagtTool,
} from './common.js';
import type { ReaderAccess } from './reader-access.js';
import type { XagtReadService } from './read-service.js';
import type { PeerStore } from './peer-reader.js';
import type { MaterialStore } from './materials.js';
import type { XagtInteractService } from './interact.js';

const jsonBody = (req: HttpRequest, budget: number): JsonObject => {
  if (req.bodyError === 'BODY_TOO_LARGE') xfail('INVALID_REQUEST', '请求体过大。', false, 413);
  if (req.rawBody !== undefined) {
    if (req.rawBody.length > budget) xfail('INVALID_REQUEST', '请求体过大。', false, 413);
    let parsed: unknown;
    try {
      parsed = req.rawBody.length === 0 ? null : JSON.parse(Buffer.from(req.rawBody).toString('utf8'));
    } catch {
      xfail('INVALID_REQUEST', '请求体不是 JSON。', false, 400);
    }
    if (!isRecord(parsed)) xfail('INVALID_REQUEST', '请求体必须是 JSON 对象。', false, 400);
    return parsed;
  }
  if (req.body === undefined || !isRecord(req.body)) {
    xfail('INVALID_REQUEST', '请求体必须是 JSON 对象。', false, 400);
  }
  return req.body;
};

const bearer = (req: HttpRequest): string => req.accessToken ?? '';

export interface XagtDeps {
  readers: ReaderAccess;
  service: XagtReadService;
  peers: PeerStore;
  materials: MaterialStore;
  interact?: XagtInteractService;
}

export const createXagtHandlers = (deps: XagtDeps): NonNullable<GatewayContext['xagt']> => ({
  async read(req: HttpRequest, localCluster = false): Promise<HttpResponse> {
    if (req.method !== 'POST') xfail('INVALID_REQUEST', '仅支持 POST。', false, 404);
    const grant = deps.readers.authenticate(bearer(req));
    const body = jsonBody(req, LIMITS.rpcBodyMax);
    const keys = Object.keys(body);
    if (keys.some((k) => k !== 'version' && k !== 'tool' && k !== 'arguments')) {
      xfail('INVALID_REQUEST', '仅接受 {version,tool,arguments}。', false, 400);
    }
    if (body.version !== READ_RPC_VERSION) {
      xfail('VERSION_UNSUPPORTED', undefined, false, 400);
    }
    if (!isXagtTool(body.tool)) {
      xfail('INVALID_REQUEST', '未知工具。', false, 400);
    }
    if (body.tool === 'xagt_list_cluster' && !localCluster) xfail('SCOPE_DENIED');
    const args = body.arguments === undefined ? {}
      : isRecord(body.arguments) ? body.arguments
      : xfail('INVALID_REQUEST', 'arguments 必须是对象。', false, 400);
    try {
      const result = await deps.service.call(grant, body.tool as XagtTool, args as JsonObject);
      return { status: 200, body: { version: READ_RPC_VERSION, ok: true, result } };
    } catch (error) {
      const e = errorBody(error);
      return { status: 200, body: { version: READ_RPC_VERSION, ok: false, error: e } };
    }
  },

  async interact(req: HttpRequest, localCluster = false): Promise<HttpResponse> {
    if (!deps.interact) xfail('UNSUPPORTED');
    if (!localCluster && req.path !== '/api/xagt/v1/interact') xfail('NOT_FOUND', undefined, false, 404);
    const body = jsonBody(req, LIMITS.rpcBodyMax);
    // The action service performs its own independent bearer authentication;
    // this route must never accept the read credential by accident.
    return deps.interact.handle({ ...req, body }, localCluster);
  },

  createReader(body: JsonObject): MaybePromise<JsonObject> {
    const { grant, token } = deps.readers.create(body);
    return { ...grant, token };
  },
  listReaders(): MaybePromise<JsonObject> {
    return { items: deps.readers.list() };
  },
  revokeReader(readerId: string): MaybePromise<void> {
    deps.readers.revoke(readerId);
  },
  createInteract(body: JsonObject): MaybePromise<JsonObject> {
    if (!deps.interact) xfail('UNSUPPORTED');
    return deps.interact.create(body);
  },
  revokeInteract(interactId: string): MaybePromise<void> {
    if (!deps.interact) xfail('UNSUPPORTED');
    deps.interact.revoke(interactId);
  },
  upsertPeer(body: JsonObject): MaybePromise<JsonObject> {
    const peer = deps.peers.upsert(body);
    const { envelope: _envelope, ...rest } = peer;
    return rest as unknown as JsonObject;
  },
  listPeers(): MaybePromise<JsonObject> {
    return { items: deps.peers.listPublic() };
  },
  removePeer(peerId: string): MaybePromise<void> {
    deps.peers.remove(peerId);
  },
  createMaterial(body: JsonObject): MaybePromise<JsonObject> {
    return deps.materials.create(body) as unknown as JsonObject;
  },
  listMaterials(): MaybePromise<JsonObject> {
    return { items: deps.materials.list() };
  },
  removeMaterial(matId: string): MaybePromise<void> {
    deps.materials.remove(matId);
  },
});

/** Map a thrown management-side error for the owner-api catch path. */
export { XagtError };
