/** client-access/1 reference port. Browser/Node fetch; no sourceKind dispatch. */
export class AccessError extends Error {
  constructor(code, status = 0) { super(code); this.code = code; this.status = status; }
}

const clone = (value) => JSON.parse(JSON.stringify(value));
const idPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;
const encode = (ref) => encodeURIComponent(ref);
export const memoryPending = () => {
  const values = new Map();
  return { async set(k, v) { values.set(k, clone(v)); }, async get(k) { return clone(values.get(k) ?? null); } };
};

export class ClientAccess {
  /** binding/credentials come from trusted connection setup, never a server-returned URL.
   * pending must implement durable set/get in a product; no credentials are written into it.
   */
  constructor({ origin, basePath, authorization, connectionId, pending, fetch: fetchImpl = globalThis.fetch }) {
    const url = new URL(origin);
    if (url.username || url.password || url.search || url.hash || url.pathname !== '/' ||
        !(url.protocol === 'https:' || url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)))
      throw new AccessError('UNTRUSTED_ORIGIN');
    if (typeof basePath !== 'string' || basePath !== '' && basePath !== '/' && !/^\/[A-Za-z0-9/_-]+$/.test(basePath) || basePath?.includes('//') || !pending?.set || !pending?.get ||
        typeof connectionId !== 'string' || !connectionId || connectionId.length > 256)
      throw new AccessError('INVALID_CONNECTION_BINDING');
    this.origin = url.origin; this.basePath = basePath.replace(/\/$/, '');
    this.authorization = authorization; this.connectionId = connectionId;
    this.pending = pending; this.fetchImpl = fetchImpl; this.epoch = 0;
  }

  async #call(method, path, body, key) {
    const epoch = this.epoch;
    if (!path.startsWith('/') || path.includes('://') || path.includes('..')) throw new AccessError('INVALID_PATH');
    const resource = path.split('?')[0];
    const a = 'a1\\.[A-Za-z0-9_-]+', c = 'c1\\.[A-Za-z0-9_-]+', r = 'r1\\.[A-Za-z0-9_-]+';
    const allowed = method === 'GET'
      ? new RegExp(`^/(manifest|agents|agents/${a}/conversations|conversations/${c}(?:/replies(?:/${r}/content)?)?)$`)
      : method === 'POST' ? new RegExp(`^/(receipts/lookup|agents/${a}/conversations|conversations/${c}/(?:messages|actions))$`) : null;
    if (!allowed?.test(resource)) throw new AccessError('INVALID_PATH');
    const headers = { 'X-Client-Access-Version': 'client-access/1' };
    if (this.authorization) headers.Authorization = this.authorization;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (key) headers['Idempotency-Key'] = key;
    const encoded = body === undefined ? undefined : JSON.stringify(body);
    if (encoded && new TextEncoder().encode(encoded).length > 65536) throw new AccessError('REQUEST_TOO_LARGE');
    let response;
    try {
      response = await this.fetchImpl(this.origin + this.basePath + path, {
        method, headers, body: encoded, redirect: 'error', credentials: 'same-origin',
      });
    } catch { throw new AccessError('SOURCE_OUTCOME_UNCONFIRMED'); }
    const reader = response.body.getReader(); const chunks = []; let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read(); if (done) break;
        size += value.byteLength;
        if (size > 262144) { await reader.cancel(); throw new AccessError('SOURCE_RESPONSE_TOO_LARGE'); }
        chunks.push(value);
      }
    } catch (e) { if (e instanceof AccessError) throw e; throw new AccessError('SOURCE_OUTCOME_UNCONFIRMED'); }
    if (epoch !== this.epoch) throw new AccessError('STALE_CONNECTION');
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    let result;
    try { result = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
    catch { throw new AccessError('INVALID_SOURCE_RESPONSE'); }
    if (!response.ok) throw new AccessError(result.error?.code ?? 'SOURCE_UNAVAILABLE', response.status);
    return result;
  }

  async connect() {
    ++this.epoch;
    const manifest = await this.#call('GET', '/manifest');
    if (manifest.protocolVersion !== 'client-access/1' || typeof manifest.storeId !== 'string' ||
        manifest.replyDelivery !== 'POLL') throw new AccessError('PROTOCOL_VERSION_UNSUPPORTED');
    this.manifest = manifest;
    // Product connection identity includes the authenticated device/principal as supplied by setup.
    this.scope = JSON.stringify([this.origin, this.basePath, this.connectionId, manifest.storeId, manifest.authorizationRevision ?? null]);
    return manifest;
  }
  disconnect() { ++this.epoch; this.manifest = undefined; this.scope = undefined; }
  agents() { return this.#call('GET', '/agents'); }
  conversations(agentRef) { return this.#call('GET', `/agents/${encode(agentRef)}/conversations`); }
  conversation(ref) { return this.#call('GET', `/conversations/${encode(ref)}`); }
  replies(ref, { cursor, ifRevision } = {}) {
    if (cursor && ifRevision) throw new AccessError('INVALID_REQUEST');
    const query = new URLSearchParams(cursor ? { cursor } : ifRevision ? { ifRevision } : {});
    return this.#call('GET', `/conversations/${encode(ref)}/replies?${query}`);
  }
  content(ref, replyRef, cursor) {
    const query = new URLSearchParams(cursor ? { cursor } : {});
    return this.#call('GET', `/conversations/${encode(ref)}/replies/${encode(replyRef)}/content?${query}`);
  }

  async prepare(requestId, path, body, locator) {
    if (!this.scope || !idPattern.test(requestId)) throw new AccessError('INVALID_REQUEST');
    const record = { scope: this.scope, path, body: clone(body), locator: clone(locator), dispatched: false };
    const storageKey = this.scope + ':' + requestId;
    const old = await this.pending.get(storageKey);
    if (old && JSON.stringify([old.path, old.body, old.locator]) !== JSON.stringify([record.path, record.body, record.locator]))
      throw new AccessError('IDEMPOTENCY_CONFLICT');
    if (!old) await this.pending.set(storageKey, record);
    return { storageKey, record: old ?? record };
  }
  async dispatch(prepared) {
    const { storageKey, record } = prepared;
    if (record.scope !== this.scope) throw new AccessError('SOURCE_IDENTITY_CHANGED');
    // Persist before sending. Even a crash before actual fetch leaves an unresolved intention.
    if (record.dispatched) return this.lookupRecord(record);
    record.dispatched = true; await this.pending.set(storageKey, record);
    return this.#call('POST', record.path, record.body, record.body.requestId);
  }
  lookupRecord(record) {
    if (record.scope !== this.scope) throw new AccessError('SOURCE_IDENTITY_CHANGED');
    return this.#call('POST', '/receipts/lookup', record.locator);
  }
  async lookup(requestId) {
    const record = await this.pending.get(this.scope + ':' + requestId);
    if (!record) throw new AccessError('NOT_FOUND', 404);
    return this.lookupRecord(record);
  }
  async create(agentRef, requestId) {
    if (!this.manifest?.features?.conversationCreate) throw new AccessError('CAPABILITY_UNAVAILABLE');
    return this.dispatch(await this.prepare(requestId, `/agents/${encode(agentRef)}/conversations`, { requestId },
      { kind: 'CREATE_CONVERSATION', requestId, agentRef }));
  }
  async send(view, text, requestId) {
    if (view.message?.availability !== 'AVAILABLE' || !text?.trim() || new TextEncoder().encode(text).length > 8192)
      throw new AccessError('CAPABILITY_UNAVAILABLE');
    const body = { requestId, text, binding: view.message.binding };
    return this.dispatch(await this.prepare(requestId, `/conversations/${encode(view.conversationRef)}/messages`, body,
      { kind: 'MESSAGE', requestId, conversationRef: view.conversationRef, binding: body.binding }));
  }
  async action(view, descriptor, input, requestId) {
    const shapes = { NONE: [], TEXT: ['text'], CONFIRM: ['confirmed'], SELECT: ['value'], DECISION: ['decision'] };
    const fields = shapes[descriptor.inputKind];
    const known = ['execution.supplement', 'execution.stop', 'execution.pause', 'execution.resume_paused', 'execution.resume_waiting', 'input.respond'];
    if (!known.includes(descriptor.actionId) || !fields || descriptor.availability !== 'AVAILABLE' || !descriptor.binding ||
        !view.actions.some(a => a.actionId === descriptor.actionId && a.binding === descriptor.binding) ||
        JSON.stringify(Object.keys(input).sort()) !== JSON.stringify([...fields].sort()))
      throw new AccessError('CAPABILITY_UNAVAILABLE');
    const body = { requestId, actionId: descriptor.actionId, binding: descriptor.binding, input };
    return this.dispatch(await this.prepare(requestId, `/conversations/${encode(view.conversationRef)}/actions`, body,
      { kind: 'ACTION', requestId, conversationRef: view.conversationRef, binding: body.binding, actionId: body.actionId }));
  }
}

/** Snapshot replaces snapshot; unchanged polling never erases visible text. */
export function applyReplies(previous, page) {
  if (page.unchanged) return previous;
  if (page.representation === 'TEXT_SNAPSHOT') return { ...page, items: [], snapshot: page.snapshot };
  if (page.representation !== 'MESSAGES') throw new AccessError('UNSUPPORTED_REPRESENTATION');
  return page;
}
