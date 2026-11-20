import { randomUUID } from 'node:crypto';
import type { GatewayStoreView, JsonObject } from '../context.js';
import { fail, isRecord } from '../protocol.js';
import type { PeerStore } from './peer-reader.js';
import { canSeeBackend, canUsePeer, type ReaderAccess, type ReaderGrant } from './reader-access.js';

export interface ImportedOrigin {
  sourceHostRef: string;
  sourceKeyId: string;
  sourceHandoffId: string;
  manifestDigest: string;
  sourceStoreId: string;
  sourceTaskId: string;
  targetProjectId: string;
  publicFacts: JsonObject;
}

export type ResolveImportedOrigin = (importId: string, targetStoreId: string, targetTaskId: string) => Promise<ImportedOrigin>;

interface OriginGrant {
  handoffRef: string;
  readerId: string;
  readerRevision: number;
  memberBinding: string;
  importId: string;
  targetStoreId: string;
  targetTaskId: string;
  peerId?: string;
  peerRevision?: number;
  sourceHostRef: string;
  sourceKeyId: string;
  manifestDigest: string;
}

const KIND = 'xagt-origin-grant';
const isId = (raw: unknown): raw is string => typeof raw === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(raw);

export class OriginGrants {
  constructor(private readonly store: Pick<GatewayStoreView, 'get' | 'put' | 'delete' | 'list'>,
    private readonly readers: ReaderAccess,
    private readonly peers: PeerStore,
    private readonly resolveImported: ResolveImportedOrigin,
    private readonly memberIdentity: () => string) {}

  async create(input: unknown): Promise<JsonObject> {
    if (!isRecord(input) || Object.keys(input).some(key =>
      !['readerId', 'importId', 'targetStoreId', 'targetTaskId', 'sourcePeerId'].includes(key))) fail('INVALID_REQUEST', 400);
    const { readerId, importId, targetStoreId, targetTaskId, sourcePeerId } = input;
    if (!isId(readerId) || !isId(importId) || !isId(targetStoreId) || !isId(targetTaskId)
      || (sourcePeerId !== undefined && !isId(sourcePeerId))) fail('INVALID_REQUEST', 400);
    const reader = this.readers.get(readerId);
    if (reader.state !== 'ACTIVE' || Date.parse(reader.expiresAt) <= Date.now()) fail('GRANT_EXPIRED', 410);
    this.requireTarget(reader, targetStoreId, targetTaskId);
    const peer = sourcePeerId === undefined ? undefined : this.peers.require(sourcePeerId);
    if (peer && !canUsePeer(reader, peer.peerId)) fail('SCOPE_DENIED', 403);
    const memberBinding = this.memberIdentity();
    const source = await this.resolveImported(importId, targetStoreId, targetTaskId);
    if (memberBinding !== this.memberIdentity()) fail('MEMBER_SESSION_CHANGED', 409);
    this.requireCurrent(reader);
    if (peer && !canSeeBackend(reader, source.sourceStoreId)) fail('SCOPE_DENIED', 403);
    const handoffRef = `xhg-${randomUUID()}`;
    const grant: OriginGrant = {
      handoffRef, readerId, readerRevision: reader.grantRevision, memberBinding, importId, targetStoreId, targetTaskId,
      peerId: peer?.peerId, peerRevision: peer?.revision, sourceHostRef: source.sourceHostRef,
      sourceKeyId: source.sourceKeyId, manifestDigest: source.manifestDigest,
    };
    this.store.put(KIND, handoffRef, grant);
    return { handoffRef, readerId, sourceHostRef: grant.sourceHostRef, manifestDigest: grant.manifestDigest };
  }

  remove(handoffRef: string): void {
    this.store.delete(KIND, handoffRef);
  }

  list(reader: ReaderGrant): { handoffRef: string }[] {
    this.requireCurrent(reader);
    const memberBinding = this.memberIdentity();
    return this.store.list<OriginGrant>(KIND)
      .filter(row => row.readerId === reader.readerId && row.readerRevision === reader.grantRevision && row.memberBinding === memberBinding)
      .slice(0, 50).map(({ handoffRef }) => ({ handoffRef }));
  }

  async resolve(reader: ReaderGrant, handoffRef: unknown): Promise<ImportedOrigin & { peerId?: string }> {
    if (!isId(handoffRef)) fail('INVALID_REQUEST', 400);
    const grant = this.store.get<OriginGrant>(KIND, handoffRef);
    if (!grant || grant.readerId !== reader.readerId || grant.readerRevision !== reader.grantRevision
      || grant.memberBinding !== this.memberIdentity()) fail('NOT_FOUND', 404);
    this.requireTarget(reader, grant.targetStoreId, grant.targetTaskId);
    const source = await this.resolveImported(grant.importId, grant.targetStoreId, grant.targetTaskId);
    this.requireCurrent(reader);
    if (!this.store.get(KIND, handoffRef) || grant.memberBinding !== this.memberIdentity() || source.sourceHostRef !== grant.sourceHostRef
      || source.sourceKeyId !== grant.sourceKeyId || source.manifestDigest !== grant.manifestDigest) fail('NOT_FOUND', 404);
    const peer = grant.peerId === undefined ? undefined : this.peers.get(grant.peerId);
    const peerId = peer && peer.revision === grant.peerRevision && canUsePeer(reader, peer.peerId)
      && canSeeBackend(reader, source.sourceStoreId) ? peer.peerId : undefined;
    return { ...source, peerId };
  }

  private requireCurrent(reader: ReaderGrant): void {
    const current = this.readers.get(reader.readerId);
    if (current.state !== 'ACTIVE' || current.grantRevision !== reader.grantRevision
      || Date.parse(current.expiresAt) <= Date.now()) fail('GRANT_EXPIRED', 410);
  }

  private requireTarget(reader: ReaderGrant, storeId: string, taskId: string): void {
    if (!canSeeBackend(reader, storeId) || !reader.tasks.includes(taskId)) fail('SCOPE_DENIED', 403);
  }
}
