/**
 * Reader grants — the mcp-reader authorization model for the xagt read
 * surface (design §5.1). A grant is its own credential domain, completely
 * separate from device tokens: pairing a phone never mints one and a reader
 * token never opens /personal/v1.
 *
 *   create → store {readerId, tokenHash, scope…}; the raw token is returned
 *            once, to be injected into the MCP stdio process (or into a peer
 *            Link's peer record) by the trusted launcher.
 *   revoke → state:'REVOKED' + grantRevision++ — every cursor bound to the
 *            old revision dies immediately (refs alone are not credentials;
 *            each resolve re-checks this grant).
 *
 * Scope semantics (intersection, never union):
 *   backends         allowed worker-local backendStoreIds ('*' = all local)
 *   projects/tasks   managed-task filter — explicit tasks[] wins, else
 *                    projects[] must contain the task's project; when both
 *                    are empty every task on an allowed backend is visible
 *   vendorSessions   explicit {engine,sessionId} pairs ('*' engine matches
 *                    any); allVendorSessions opens all native sessions on
 *                    allowed backends (native history cannot be reliably
 *                    attributed to projects — the design requires explicit
 *                    session scope unless the owner opts in)
 *   peers            allowed peerIds the reader may read through ('*' = all)
 *   materials        allowed material entry ids ('*' = all)
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { constantEqual, hash, isRecord, text } from '../protocol.js';
import type { GatewayStoreView, JsonObject } from '../context.js';
import { LIMITS, xfail } from './common.js';

const KIND = 'xagt-reader';

export interface VendorSessionScope {
  engine: string;
  sessionId: string;
}

export interface ReaderGrant {
  readerId: string;
  name: string;
  tokenHash: string;
  state: 'ACTIVE' | 'REVOKED';
  grantRevision: number;
  createdAt: string;
  /** epoch-millis ISO string. */
  expiresAt: string;
  backends: string[];
  projects: string[];
  tasks: string[];
  vendorSessions: VendorSessionScope[];
  allVendorSessions: boolean;
  peers: string[];
  materials: string[];
}

export const publicGrant = (g: ReaderGrant): JsonObject => {
  const { tokenHash: _tokenHash, ...rest } = g;
  return rest as unknown as JsonObject;
};

const strings = (value: unknown, name: string, max: number): string[] => {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > max) xfail('INVALID_REQUEST', `${name} 必须是 ≤${max} 项的字符串数组。`);
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string' || item.length === 0 || item.length > 256) {
      xfail('INVALID_REQUEST', `${name} 元素必须是非空字符串。`);
    }
    out.push(item);
  }
  return [...new Set(out)];
};

const vendorScopes = (value: unknown): VendorSessionScope[] => {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 200) {
    xfail('INVALID_REQUEST', 'vendorSessions 必须是 ≤200 项的 {engine,sessionId} 数组。');
  }
  const out: VendorSessionScope[] = [];
  for (const item of value) {
    if (!isRecord(item) || Object.keys(item).some((k) => k !== 'engine' && k !== 'sessionId')) {
      xfail('INVALID_REQUEST', 'vendorSessions 元素必须是精确的 {engine,sessionId}。');
    }
    const engine = text(item, 'engine');
    const sessionId = text(item, 'sessionId');
    if (engine.length > 64 || sessionId.length > 256) xfail('INVALID_REQUEST');
    out.push({ engine, sessionId });
  }
  return out;
};

export class ReaderAccess {
  constructor(private readonly store: Pick<GatewayStoreView, 'get' | 'put' | 'list' | 'delete'>) {}

  /** POST /api/v2/personal-access/mcp-readers */
  create(body: JsonObject): { grant: JsonObject; token: string } {
    if (this.store.list<ReaderGrant>(KIND).filter((g) => g.state === 'ACTIVE').length >= LIMITS.grantsMax) {
      xfail('INVALID_REQUEST', '只读授权数量已达上限。');
    }
    const name = body.name === undefined ? '' : text(body, 'name');
    if (name.length > 128) xfail('INVALID_REQUEST');
    const days = body.expiresInDays;
    const expiresInDays = days === undefined ? 30
      : typeof days === 'number' && Number.isInteger(days) && days >= 1 && days <= 365 ? days
      : xfail('INVALID_REQUEST', 'expiresInDays 必须是 1..365 的整数。');
    const grant: ReaderGrant = {
      readerId: `xgrd-${randomUUID()}`,
      name,
      tokenHash: '',
      state: 'ACTIVE',
      grantRevision: 1,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + (expiresInDays as number) * 86_400_000).toISOString(),
      backends: strings(body.backends, 'backends', 64),
      projects: strings(body.projects, 'projects', 200),
      tasks: strings(body.tasks, 'tasks', 200),
      vendorSessions: vendorScopes(body.vendorSessions),
      allVendorSessions: body.allVendorSessions === true,
      peers: strings(body.peers, 'peers', 64),
      materials: strings(body.materials, 'materials', 512),
    };
    const token = `xgr-${randomBytes(24).toString('base64url')}`;
    grant.tokenHash = hash(`xagt-reader:${token}`);
    this.store.put(KIND, grant.readerId, grant);
    return { grant: publicGrant(grant), token };
  }

  list(): JsonObject[] {
    return this.store.list<ReaderGrant>(KIND).map(publicGrant);
  }

  get(readerId: string): ReaderGrant {
    const grant = this.store.get<ReaderGrant>(KIND, readerId);
    if (grant === undefined) xfail('NOT_FOUND');
    return grant;
  }

  /** Revoke — bump the revision so outstanding cursors die with the grant. */
  revoke(readerId: string): void {
    const grant = this.get(readerId);
    this.store.put(KIND, grant.readerId, {
      ...grant, state: 'REVOKED', grantRevision: grant.grantRevision + 1,
    } satisfies ReaderGrant);
  }

  /**
   * Bearer auth for POST /api/xagt/v1/read. Revoked/expired grants fail
   * GRANT_EXPIRED so callers can distinguish "wrong token" from "was valid".
   */
  authenticate(token: string | undefined): ReaderGrant {
    if (token === undefined || !token.startsWith('xgr-')) xfail('ACCESS_UNAUTHORIZED', undefined, false, 401);
    const tokenHash = hash(`xagt-reader:${token}`);
    const grant = this.store.list<ReaderGrant>(KIND)
      .find((g) => constantEqual(g.tokenHash, tokenHash));
    if (grant === undefined) xfail('ACCESS_UNAUTHORIZED', undefined, false, 401);
    if (grant.state !== 'ACTIVE' || Date.parse(grant.expiresAt) <= Date.now()) {
      xfail('GRANT_EXPIRED', undefined, false, 410);
    }
    return grant;
  }
}

// ---------------------------------------------------------------------------
// Scope predicates — every read re-checks the grant against the binding.
// ---------------------------------------------------------------------------

const allows = (list: string[], value: string): boolean => list.includes('*') || list.includes(value);

export const canSeeBackend = (g: ReaderGrant, backendStoreId: string): boolean =>
  allows(g.backends, backendStoreId);

export const canUsePeer = (g: ReaderGrant, peerId: string): boolean =>
  allows(g.peers, peerId);

export const canSeeTask = (g: ReaderGrant, backendStoreId: string, projectId: string, taskId: string): boolean => {
  if (!canSeeBackend(g, backendStoreId)) return false;
  if (g.tasks.includes(taskId)) return true;
  if (g.tasks.length > 0) return false;
  if (g.projects.length === 0) return true;
  return allows(g.projects, projectId);
};

export const canSeeVendorSession = (
  g: ReaderGrant, backendStoreId: string, engine: string, sessionId: string,
): boolean => {
  if (!canSeeBackend(g, backendStoreId)) return false;
  if (g.allVendorSessions) return true;
  return g.vendorSessions.some(
    (v) => (v.engine === '*' || v.engine === engine) && v.sessionId === sessionId);
};

export const canSeeMaterial = (g: ReaderGrant, matId: string): boolean =>
  allows(g.materials, matId);
