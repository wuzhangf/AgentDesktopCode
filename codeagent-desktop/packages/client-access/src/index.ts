/**
 * `client-access/1` transport port (UCA-001 §C4).
 *
 * This is the typed desktop counterpart of the reference consumer
 * `AgentDesktopCode/client-access/client-access.mjs`. It is a transport,
 * not a router: source kinds and engine names are display information only and
 * are never used to choose a code path. Trusted connection setup supplies the
 * origin, a fixed base path and the authentication material; the server never
 * gets to return a URL that the client would follow.
 *
 * Deliberate invariants carried over from the reference port:
 * - only the fixed protocol paths are reachable (no generic proxy);
 * - redirects are rejected and responses are bounded (262144 bytes);
 * - a dispatched intention is persisted before the request leaves and is only
 *   looked up afterwards — it is never automatically posted again;
 * - pending records carry the frozen operation and locator, never credentials;
 * - a connection epoch invalidates in-flight results after disconnect/connect.
 *
 * Nothing here is product policy: products own the durable pending store, the
 * connection identity and the UI that displays full question context before an
 * approval shape is used.
 */

export const CLIENT_ACCESS_VERSION = 'client-access/1';
export const MAX_REQUEST_BYTES = 65536;
export const MAX_TEXT_BYTES = 8192;
export const MAX_RESPONSE_BYTES = 262144;

export type AccessErrorCode =
  | 'UNTRUSTED_ORIGIN'
  | 'INVALID_CONNECTION_BINDING'
  | 'INVALID_PATH'
  | 'INVALID_REQUEST'
  | 'REQUEST_TOO_LARGE'
  | 'SOURCE_OUTCOME_UNCONFIRMED'
  | 'SOURCE_RESPONSE_TOO_LARGE'
  | 'INVALID_SOURCE_RESPONSE'
  | 'SOURCE_UNAVAILABLE'
  | 'STALE_CONNECTION'
  | 'PROTOCOL_VERSION_UNSUPPORTED'
  | 'CAPABILITY_UNAVAILABLE'
  | 'IDEMPOTENCY_CONFLICT'
  | 'SOURCE_IDENTITY_CHANGED'
  | 'UNSUPPORTED_REPRESENTATION'
  | 'NOT_FOUND'
  | (string & {});

export class AccessError extends Error {
  readonly code: AccessErrorCode;
  readonly status: number;
  constructor(code: AccessErrorCode, status = 0) {
    super(code);
    this.name = 'AccessError';
    this.code = code;
    this.status = status;
  }
}

export interface ManifestLimits {
  requestBytes?: number;
  textBytes?: number;
  replyPageBytes?: number;
  [key: string]: unknown;
}

export interface ManifestFeatures {
  conversationCreate?: boolean;
  replyContent?: boolean;
  [key: string]: unknown;
}

export interface Manifest {
  protocolVersion: string;
  storeId: string;
  authBinding?: string;
  replyDelivery?: string;
  limits?: ManifestLimits;
  features?: ManifestFeatures;
  bootId?: string;
  authorizationRevision?: string;
  [key: string]: unknown;
}

export type Availability = 'AVAILABLE' | 'UNAVAILABLE' | 'UNSUPPORTED';

export interface AgentDescriptor {
  agentRef: string;
  displayName: string;
  sourceKind: string;
  availability: Availability;
  reasonCode: string | null;
  engineId?: string;
  [key: string]: unknown;
}

export interface AgentList {
  items: AgentDescriptor[];
  [key: string]: unknown;
}

export interface ConversationSummary {
  agentRef: string;
  conversationRef: string;
  title: string;
  [key: string]: unknown;
}

export interface ConversationPage {
  items: ConversationSummary[];
  nextCursor: string | null;
  truncated?: boolean;
  [key: string]: unknown;
}

/** Action shapes the protocol freezes; anything else is not addressable. */
export type ActionInputKind = 'NONE' | 'TEXT' | 'CONFIRM' | 'SELECT' | 'DECISION';
export type ActionId =
  | 'execution.supplement'
  | 'execution.stop'
  | 'execution.pause'
  | 'execution.resume_paused'
  | 'execution.resume_waiting'
  | 'input.respond';

export interface ActionDescriptor {
  actionId: string;
  label?: string;
  availability: Availability;
  reasonCode: string | null;
  inputKind: ActionInputKind | (string & {});
  binding: string | null;
  context?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface ConversationMessageBinding {
  availability: Availability;
  reasonCode: string | null;
  meaning: string;
  binding: string;
  [key: string]: unknown;
}

export interface ConversationExecution {
  executionRef: string;
  sourceState: string | null;
  [key: string]: unknown;
}

export interface ConversationView {
  agentRef: string;
  conversationRef: string;
  title: string;
  observedAt: string;
  sourceState: string | null;
  executions: ConversationExecution[];
  message: ConversationMessageBinding;
  actions: ActionDescriptor[];
  actionsTruncated?: boolean;
  [key: string]: unknown;
}

export interface Reply {
  replyRef: string;
  role?: 'user' | 'assistant';
  text: string;
  contentRevision: string;
  textComplete: boolean;
  [key: string]: unknown;
}

export interface ReplyPage {
  representation: 'MESSAGES' | 'TEXT_SNAPSHOT';
  revision: string;
  unchanged?: boolean;
  items?: Reply[];
  snapshot?: Reply;
  nextCursor?: string | null;
  coverage?: string;
  [key: string]: unknown;
}

export interface ReplyContent {
  replyRef: string;
  contentRevision: string;
  text: string;
  nextCursor: string | null;
  complete: boolean;
  coverage?: string;
  [key: string]: unknown;
}

export interface Receipt {
  requestId: string;
  accepted: boolean | null;
  sourceStatus: string;
  consumed: boolean | null;
  observedAt: string;
  conversationRef?: string;
  executionRef?: string;
  [key: string]: unknown;
}

export type ReceiptLocator =
  | { kind: 'CREATE_CONVERSATION'; requestId: string; agentRef: string }
  | { kind: 'MESSAGE'; requestId: string; conversationRef: string; binding: string }
  | { kind: 'ACTION'; requestId: string; conversationRef: string; binding: string; actionId: string };

/** Durable product-owned intent store; never holds credentials. */
export interface PendingStore {
  set(key: string, value: PendingRecord): Promise<void>;
  get(key: string): Promise<PendingRecord | null>;
}

export interface PendingRecord {
  scope: string;
  path: string;
  body: unknown;
  locator: ReceiptLocator;
  dispatched: boolean;
}

export interface PreparedIntention {
  storageKey: string;
  record: PendingRecord;
}

export interface ClientAccessOptions {
  origin: string;
  basePath?: string;
  authorization?: string;
  connectionId: string;
  pending: PendingStore;
  fetch?: typeof globalThis.fetch;
}

export const memoryPending = (): PendingStore => {
  const values = new Map<string, PendingRecord>();
  return {
    async set(key, value) { values.set(key, clone(value)); },
    async get(key) { return clone(values.get(key) ?? null); }
  };
};

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;
const REF = '[acberp]1\\.[A-Za-z0-9_-]+';
const encode = (ref: string): string => encodeURIComponent(ref);
const utf8 = (value: string): number => new TextEncoder().encode(value).length;

/**
 * The only reachable protocol paths. Exported so the surface allowlist can be
 * asserted directly instead of inferred from request recording.
 */
export function isAllowedRequestPath(method: 'GET' | 'POST', resource: string): boolean {
  const allowed = method === 'GET'
    ? new RegExp(`^/(manifest|agents|agents/${REF}/conversations|conversations/${REF}(?:/replies(?:/${REF}/content)?)?)$`)
    : new RegExp(`^/(receipts/lookup|agents/${REF}/conversations|conversations/${REF}/(?:messages|actions))$`);
  return allowed.test(resource);
}

export class ClientAccess {
  readonly origin: string;
  readonly basePath: string;
  readonly connectionId: string;
  private readonly authorization: string | undefined;
  private readonly pending: PendingStore;
  private readonly fetchImpl: typeof globalThis.fetch;
  private epoch = 0;
  manifest: Manifest | undefined;
  scope: string | undefined;

  constructor(options: ClientAccessOptions) {
    const url = new URL(options.origin);
    const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
    if (url.username || url.password || url.search || url.hash || url.pathname !== '/'
        || !(url.protocol === 'https:' || (url.protocol === 'http:' && loopback))) {
      throw new AccessError('UNTRUSTED_ORIGIN');
    }
    const basePath = options.basePath ?? '';
    if (typeof basePath !== 'string' || (basePath !== '' && basePath !== '/' && !/^\/[A-Za-z0-9/_-]+$/.test(basePath))
        || basePath.includes('//')) {
      throw new AccessError('INVALID_CONNECTION_BINDING');
    }
    if (!options.pending?.set || !options.pending?.get
        || typeof options.connectionId !== 'string' || !options.connectionId || options.connectionId.length > 256) {
      throw new AccessError('INVALID_CONNECTION_BINDING');
    }
    this.origin = url.origin;
    this.basePath = basePath.replace(/\/$/, '');
    this.authorization = options.authorization;
    this.connectionId = options.connectionId;
    this.pending = options.pending;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
  }

  async #call<T>(method: 'GET' | 'POST', path: string, body?: unknown, key?: string): Promise<T> {
    const epoch = this.epoch;
    if (!path.startsWith('/') || path.includes('://') || path.includes('..')) throw new AccessError('INVALID_PATH');
    const resource = path.split('?')[0] ?? '';
    if (!isAllowedRequestPath(method, resource)) throw new AccessError('INVALID_PATH');

    const headers: Record<string, string> = { 'X-Client-Access-Version': CLIENT_ACCESS_VERSION };
    if (this.authorization) headers.Authorization = this.authorization;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (key) headers['Idempotency-Key'] = key;
    const encoded = body === undefined ? undefined : JSON.stringify(body);
    if (encoded && utf8(encoded) > MAX_REQUEST_BYTES) throw new AccessError('REQUEST_TOO_LARGE');

    let response: Response;
    try {
      response = await this.fetchImpl(this.origin + this.basePath + path, {
        method, headers, body: encoded, redirect: 'error', credentials: 'same-origin'
      });
    } catch {
      throw new AccessError('SOURCE_OUTCOME_UNCONFIRMED');
    }

    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (reader) {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!value) continue;
          size += value.byteLength;
          if (size > MAX_RESPONSE_BYTES) { await reader.cancel(); throw new AccessError('SOURCE_RESPONSE_TOO_LARGE'); }
          chunks.push(value);
        }
      } catch (error) {
        if (error instanceof AccessError) throw error;
        throw new AccessError('SOURCE_OUTCOME_UNCONFIRMED');
      }
    }
    if (epoch !== this.epoch) throw new AccessError('STALE_CONNECTION');

    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    let result: { error?: { code?: string } } & Record<string, unknown>;
    try {
      result = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as typeof result;
    } catch {
      throw new AccessError('INVALID_SOURCE_RESPONSE');
    }
    if (!response.ok) throw new AccessError(result.error?.code ?? 'SOURCE_UNAVAILABLE', response.status);
    return result as T;
  }

  async connect(): Promise<Manifest> {
    this.epoch += 1;
    const manifest = await this.#call<Manifest>('GET', '/manifest');
    if (manifest.protocolVersion !== CLIENT_ACCESS_VERSION || typeof manifest.storeId !== 'string'
        || manifest.replyDelivery !== 'POLL') {
      throw new AccessError('PROTOCOL_VERSION_UNSUPPORTED');
    }
    this.manifest = manifest;
    // Connection identity includes the authenticated device/principal supplied by
    // trusted setup; caches and pending intentions are isolated by it.
    this.scope = JSON.stringify([
      this.origin, this.basePath, this.connectionId, manifest.storeId, manifest.authorizationRevision ?? null
    ]);
    return manifest;
  }

  disconnect(): void {
    this.epoch += 1;
    this.manifest = undefined;
    this.scope = undefined;
  }

  agents(): Promise<AgentList> { return this.#call<AgentList>('GET', '/agents'); }
  conversations(agentRef: string): Promise<ConversationPage> {
    return this.#call<ConversationPage>('GET', `/agents/${encode(agentRef)}/conversations`);
  }
  conversation(ref: string): Promise<ConversationView> {
    return this.#call<ConversationView>('GET', `/conversations/${encode(ref)}`);
  }
  replies(ref: string, options: { cursor?: string; ifRevision?: string } = {}): Promise<ReplyPage> {
    if (options.cursor && options.ifRevision) throw new AccessError('INVALID_REQUEST');
    const query = new URLSearchParams(
      options.cursor ? { cursor: options.cursor } : options.ifRevision ? { ifRevision: options.ifRevision } : {}
    );
    return this.#call<ReplyPage>('GET', `/conversations/${encode(ref)}/replies?${query.toString()}`);
  }
  content(ref: string, replyRef: string, cursor?: string): Promise<ReplyContent> {
    const query = new URLSearchParams(cursor ? { cursor } : {});
    return this.#call<ReplyContent>(
      'GET', `/conversations/${encode(ref)}/replies/${encode(replyRef)}/content?${query.toString()}`
    );
  }

  async prepare(requestId: string, path: string, body: unknown, locator: ReceiptLocator): Promise<PreparedIntention> {
    if (!this.scope || !ID_PATTERN.test(requestId)) throw new AccessError('INVALID_REQUEST');
    const record: PendingRecord = { scope: this.scope, path, body: clone(body), locator: clone(locator), dispatched: false };
    const storageKey = `${this.scope}:${requestId}`;
    const old = await this.pending.get(storageKey);
    if (old && JSON.stringify([old.path, old.body, old.locator]) !== JSON.stringify([record.path, record.body, record.locator])) {
      throw new AccessError('IDEMPOTENCY_CONFLICT');
    }
    if (!old) await this.pending.set(storageKey, record);
    return { storageKey, record: old ?? record };
  }

  async dispatch(prepared: PreparedIntention): Promise<Receipt> {
    const { storageKey, record } = prepared;
    if (record.scope !== this.scope) throw new AccessError('SOURCE_IDENTITY_CHANGED');
    // Persist before sending: even a crash before the request leaves keeps an
    // unresolved intention that is looked up later instead of re-posted.
    if (record.dispatched) return this.lookupRecord(record);
    record.dispatched = true;
    await this.pending.set(storageKey, record);
    return this.#call<Receipt>('POST', record.path, record.body, requestIdOf(record.body));
  }

  lookupRecord(record: PendingRecord): Promise<Receipt> {
    if (record.scope !== this.scope) throw new AccessError('SOURCE_IDENTITY_CHANGED');
    return this.#call<Receipt>('POST', '/receipts/lookup', record.locator);
  }

  async lookup(requestId: string): Promise<Receipt> {
    if (!this.scope) throw new AccessError('INVALID_REQUEST');
    const record = await this.pending.get(`${this.scope}:${requestId}`);
    if (!record) throw new AccessError('NOT_FOUND', 404);
    return this.lookupRecord(record);
  }

  async create(agentRef: string, requestId: string): Promise<Receipt> {
    if (!this.manifest?.features?.conversationCreate) throw new AccessError('CAPABILITY_UNAVAILABLE');
    return this.dispatch(await this.prepare(
      requestId,
      `/agents/${encode(agentRef)}/conversations`,
      { requestId },
      { kind: 'CREATE_CONVERSATION', requestId, agentRef }
    ));
  }

  async send(view: ConversationView, text: string, requestId: string): Promise<Receipt> {
    if (view.message?.availability !== 'AVAILABLE' || !text?.trim() || utf8(text) > MAX_TEXT_BYTES) {
      throw new AccessError('CAPABILITY_UNAVAILABLE');
    }
    const body = { requestId, text, binding: view.message.binding };
    return this.dispatch(await this.prepare(
      requestId,
      `/conversations/${encode(view.conversationRef)}/messages`,
      body,
      { kind: 'MESSAGE', requestId, conversationRef: view.conversationRef, binding: body.binding }
    ));
  }

  async action(
    view: ConversationView,
    descriptor: ActionDescriptor,
    input: Record<string, unknown>,
    requestId: string
  ): Promise<Receipt> {
    const shapes: Record<string, readonly string[]> = {
      NONE: [], TEXT: ['text'], CONFIRM: ['confirmed'], SELECT: ['value'], DECISION: ['decision']
    };
    const known = [
      'execution.supplement', 'execution.stop', 'execution.pause',
      'execution.resume_paused', 'execution.resume_waiting', 'input.respond'
    ];
    const fields = shapes[descriptor.inputKind];
    if (!known.includes(descriptor.actionId) || !fields || descriptor.availability !== 'AVAILABLE'
        || !descriptor.binding
        || !view.actions.some((candidate) => candidate.actionId === descriptor.actionId
          && candidate.binding === descriptor.binding)
        || JSON.stringify(Object.keys(input).sort()) !== JSON.stringify([...fields].sort())) {
      throw new AccessError('CAPABILITY_UNAVAILABLE');
    }
    const body = { requestId, actionId: descriptor.actionId, binding: descriptor.binding, input };
    return this.dispatch(await this.prepare(
      requestId,
      `/conversations/${encode(view.conversationRef)}/actions`,
      body,
      {
        kind: 'ACTION', requestId, conversationRef: view.conversationRef,
        binding: body.binding, actionId: body.actionId
      }
    ));
  }
}

function requestIdOf(body: unknown): string | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const requestId = (body as { requestId?: unknown }).requestId;
  return typeof requestId === 'string' ? requestId : undefined;
}

/**
 * Snapshot replaces snapshot; an unchanged poll never erases visible text.
 * MESSAGES pages replace the page, so the caller keeps its own accumulation.
 */
export function applyReplies(previous: ReplyPage | undefined, page: ReplyPage): ReplyPage {
  if (page.unchanged) return previous ?? page;
  if (page.representation === 'TEXT_SNAPSHOT') return { ...page, items: [], snapshot: page.snapshot };
  if (page.representation !== 'MESSAGES') throw new AccessError('UNSUPPORTED_REPRESENTATION');
  return page;
}

/** Public text projection used by the panel; snapshot wins, otherwise the last items. */
export function visibleText(page: ReplyPage | undefined): string {
  if (!page) return '';
  if (page.snapshot?.text) return page.snapshot.text;
  return (page.items ?? []).map((item) => item.text ?? '').join('\n');
}
