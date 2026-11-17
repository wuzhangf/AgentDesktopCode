/**
 * ChildMessagesAccess — node:typescript port of Java PersonalChildMessagesAccess.
 *
 * child-messages/1 projection for delegated collaboration executions. The PAC
 * never invents child history: it re-derives the delegated row identity that
 * WritableChildHistory persisted (delegated-msg-<sha256(sid\nexecution\nslot)>),
 * reads the bounded upstream message page, and reports coverage exactly as the
 * source facts allow. A childId alone never authorizes a read — the parent run,
 * the group and the execution must all bind before the child session stream is
 * touched.
 */
import {
  fail,
  hash,
  id,
  isRecord,
} from './protocol.js';
import type {
  GatewayAuth,
  JsonObject,
} from './context.js';
import type { Device } from './protocol.js';
import type { AgentUpstream } from './agent-sessions.js';

const MAX_SCAN_PAGES = 8;

const asObj = (v: unknown): JsonObject => (isRecord(v) ? v : {});
const asArr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const asText = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback);
const asLong = (v: unknown, fallback = 0): number => (typeof v === 'number' ? v : fallback);

export interface ChildMessagesResult {
  status: number;
  body: unknown;
}

/** Java delegatedId(): "delegated-msg-" + sha256(sid\nexecution\nslot). */
export const delegatedId = (session: string, execution: string, slot: string): string =>
  `delegated-msg-${hash(`${session}\n${execution}\n${slot}`)}`;

export class ChildMessagesAccess {
  constructor(
    private readonly auth: GatewayAuth,
    private readonly upstream: Pick<AgentUpstream, 'call'>,
  ) {}

  /** before/cursor/limit whitelist; before and cursor are mutually exclusive.
   *  `before` accepts a decimal seq (bounded scan resolves it) or an opaque
   *  PAC-issued prevCursor token (pass-through). `cursor` is always the
   *  PAC-issued nextCursor/prevCursor token (pass-through). */
  async messages(
    token: string, runId: string, groupId: string, childId: string, rawQuery: string | null,
  ): Promise<ChildMessagesResult> {
    let limit = 50;
    let before: string | null = null;
    let cursor: string | null = null;
    const seen = new Set<string>();
    if (rawQuery !== null && rawQuery !== '') {
      for (const pair of rawQuery.split('&')) {
        const idx = pair.indexOf('=');
        const name = decodeForm(idx < 0 ? pair : pair.slice(0, idx));
        const value = idx < 0 ? '' : decodeForm(pair.slice(idx + 1));
        if (!seen.add(name)) fail('INVALID_REQUEST', 400);
        if (name === 'limit') {
          if (!/^[0-9]+$/.test(value) || (limit = Number.parseInt(value, 10)) < 1 || limit > 100) {
            fail('INVALID_REQUEST', 400);
          }
        } else if (name === 'before') {
          if (before !== null || cursor !== null) fail('INVALID_REQUEST', 400);
          before = value;
        } else if (name === 'cursor') {
          if (cursor !== null || before !== null) fail('INVALID_REQUEST', 400);
          cursor = value;
        } else {
          fail('INVALID_REQUEST', 400);
        }
      }
    }
    for (const v of [before, cursor]) {
      if (v !== null && (v === '' || v.length > 512 || !/^[A-Za-z0-9._~=-]+$/.test(v))) {
        fail('INVALID_REQUEST', 400);
      }
    }

    const device = await this.auth.authenticate(token);
    const run = await this.upstream.call(device, 'GET', `/api/v2/runs/${runId}`, undefined, undefined);
    if (run.status === 404) fail('NOT_FOUND', 404);
    if (run.status !== 200 || run.body == null) fail('UPSTREAM_UNAVAILABLE', 503);
    const sid = asText(asObj(run.body).sessionId);
    id(sid);
    await this.auth.authorize(token, sid, 'OBSERVE');

    const group = await this.upstream.call(device, 'GET', `/api/v2/runs/${runId}/collaboration-groups/${groupId}`, undefined, undefined);
    if (group.status === 404) fail('NOT_FOUND', 404);
    if (group.status !== 200 || group.body == null || asObj(group.body).entityId !== groupId) {
      fail('LOCAL_BINDING_MISMATCH', 409);
    }
    const exec = await this.upstream.call(device, 'GET',
      `/api/v2/runs/${runId}/collaboration-groups/${groupId}/executions/${childId}`, undefined, undefined);
    if (exec.status === 404) fail('NOT_FOUND', 404);
    if (exec.status !== 200 || exec.body == null || asObj(exec.body).entityId !== childId
        || asObj(exec.body).groupId !== groupId) {
      fail('LOCAL_BINDING_MISMATCH', 409);
    }

    const out: JsonObject = {
      schemaVersion: 'child-messages/1',
      parentTaskId: sid,
      runId,
      collaborationId: groupId,
      childId,
    };
    const childSid = asObj(exec.body).sessionId;
    if (typeof childSid !== 'string' || childSid === '') {
      out.coverage = 'UNAVAILABLE';
      out.items = [];
      out.hasMoreBefore = false;
      out.hasMoreAfter = false;
      return { status: 200, body: out };
    }
    id(childSid);
    const session = await this.upstream.call(device, 'GET', `/api/v2/sessions/${childSid}`, undefined, undefined);
    if (session.status !== 200 || session.body == null || asObj(session.body).sessionId !== childSid
        || asObj(session.body).parentSessionId !== sid
        || !['AUXILIARY_READ_ONLY', 'DELEGATED_WRITE_CANDIDATE'].includes(asText(asObj(session.body).sessionPurpose))) {
      fail('DEVICE_SCOPE_DENIED', 403);
    }
    out.streamId = childSid;

    let page: JsonObject;
    const window: JsonObject[] = [];
    let moreBefore: boolean;
    let moreAfter: boolean;
    let nextCursor: string | null = null;
    let prevCursor: string | null = null;
    if (before !== null && /^[0-9]+$/.test(before)) {
      // Decimal seq: resolve by scanning newest->oldest; child streams are small.
      const target = Number.parseInt(before, 10);
      let found = false;
      let windowAnchorCut = 0;
      let anchor: JsonObject | null = null;
      page = await this.fetch(device, childSid, null, 100);
      for (let hop = 0; hop < MAX_SCAN_PAGES && !found; hop++) {
        const items = asArr(page.items).map(asObj);
        let cut = items.length;
        let lastAt = -1;
        let lastSeq = -1;
        for (let i = 0; i < items.length; i++) {
          const at = asLong(items[i]!.createdAt);
          const seq = at === lastAt ? lastSeq + 1 : at * 1000;
          lastAt = at;
          lastSeq = seq;
          if (seq >= target) { cut = i; break; }
        }
        if (cut < items.length) {
          found = true;
          anchor = page;
          windowAnchorCut = cut;
          for (let i = Math.max(0, cut - limit); i < cut; i++) window.push(items[i]!);
        } else if (page.hasOlder !== true || typeof page.beforeCursor !== 'string') {
          break;
        } else {
          page = await this.fetch(device, childSid, asText(page.beforeCursor), 100);
        }
      }
      if (!found) fail('INVALID_REQUEST', 400);
      let dropped = Math.max(0, windowAnchorCut - limit);
      let back = typeof anchor!.beforeCursor === 'string' ? anchor!.beforeCursor : null;
      let oldest = anchor!;
      while (window.length < limit && back !== null && oldest.hasOlder === true) {
        oldest = await this.fetch(device, childSid, back, 100);
        const items = asArr(oldest.items).map(asObj);
        const take = Math.min(items.length, limit - window.length);
        dropped += items.length - take;
        const head: JsonObject[] = [];
        for (let i = items.length - take; i < items.length; i++) head.push(items[i]!);
        head.push(...window);
        window.length = 0;
        window.push(...head);
        back = typeof oldest.beforeCursor === 'string' ? oldest.beforeCursor : null;
      }
      moreBefore = oldest.hasOlder === true || dropped > 0;
      prevCursor = moreBefore && typeof oldest.beforeCursor === 'string' ? oldest.beforeCursor : null;
      moreAfter = true;
      nextCursor = null;
    } else {
      const upstreamCursor = cursor !== null ? cursor : before;
      page = await this.fetch(device, childSid, upstreamCursor, limit);
      for (const item of asArr(page.items)) window.push(asObj(item));
      moreBefore = page.hasOlder === true;
      moreAfter = page.hasNewer === true;
      nextCursor = typeof page.afterCursor === 'string' ? page.afterCursor : null;
      prevCursor = typeof page.beforeCursor === 'string' ? page.beforeCursor : null;
    }
    const items: JsonObject[] = [];
    let lastAt = -1;
    let lastSeq = -1;
    let bodyCut = false;
    for (const item of window) {
      const at = asLong(item.createdAt);
      const seq = at === lastAt ? lastSeq + 1 : at * 1000;
      lastAt = at;
      lastSeq = seq;
      const row = this.project(item, childSid, childId, seq);
      if (row.textTruncated === true) bodyCut = true;
      items.push(row);
    }
    out.items = items;
    out.hasMoreBefore = moreBefore;
    out.hasMoreAfter = moreAfter;
    if (nextCursor !== null) out.nextCursor = nextCursor;
    if (prevCursor !== null) out.prevCursor = prevCursor;
    out.coverage = bodyCut ? 'PARTIAL' : this.coverage(window);
    await this.auth.authorize(token, sid, 'OBSERVE');
    return { status: 200, body: out };
  }

  /** Honest coverage: delegated child streams capture from inception, so a
   *  clean bounded page is FULL_SINCE_CAPTURE; a deferred body degrades the
   *  page to PARTIAL (never silently claimed complete). */
  private coverage(window: JsonObject[]): string {
    for (const item of window) {
      if (typeof item.id !== 'string' || typeof item.createdAt !== 'number') return 'PARTIAL';
    }
    for (const item of window) {
      if (item.contentState === 'DEFERRED') return 'PARTIAL';
    }
    return 'FULL_SINCE_CAPTURE';
  }

  private async fetch(device: Device, sid: string, cursor: string | null, limit: number): Promise<JsonObject> {
    const path = `/api/v2/sessions/${sid}/messages?limit=${limit}`
      + (cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`);
    const reply = await this.upstream.call(device, 'GET', path, undefined, undefined);
    if (reply.status !== 200 || reply.body == null) {
      const code = asText(asObj(reply.body).code);
      fail(/^[A-Z][A-Z0-9_]{0,100}$/.test(code) ? code : 'UPSTREAM_UNAVAILABLE',
        reply.status >= 400 && reply.status < 600 ? reply.status : 503);
    }
    return asObj(reply.body);
  }

  private project(item: JsonObject, childSid: string, childId: string, seq: number): JsonObject {
    const out: JsonObject = {};
    const rawId = asText(item.id);
    out.id = rawId === '' ? `seq-${seq}` : rawId;
    out.seq = String(seq);
    const kind = this.kindOf(item, rawId, childSid, childId);
    out.kind = kind;
    const content = typeof item.content === 'string' ? item.content
      : typeof item.contentPreview === 'string' ? item.contentPreview : null;
    if (content !== null) {
      const bytes = Buffer.from(content, 'utf8');
      if (bytes.length > 65_536) {
        // Bound the body and flag it — a silent cut would let the page
        // claim FULL_SINCE_CAPTURE over an incomplete row.
        let end = 65_536;
        while (end > 0 && (bytes[end]! & 0xC0) === 0x80) end--;
        out.text = bytes.subarray(0, end).toString('utf8');
        out.textTruncated = true;
      } else {
        out.text = content;
      }
    }
    // child-messages/1 §7.2 carries createdAt as an ISO instant; upstream
    // epoch millis convert deterministically, never fabricated.
    const at = asLong(item.createdAt);
    if (at > 0) out.createdAt = new Date(at).toISOString();
    // Honest dispatch-start: the user input row's durable upstream createdAt is
    // the only real fact; every other kind omits the field.
    if (kind === 'USER_INPUT' && typeof item.createdAt === 'number') {
      out.dispatchStartedAt = item.createdAt;
    }
    if (item.contentRevision != null) out.revision = asText(item.contentRevision);
    if (item.contentState === 'DEFERRED') out.contentState = 'DEFERRED';
    return out;
  }

  /** Kind mapping: re-derived delegated ids prove ASSIGNMENT/RETURN; remaining
   *  delegated-msg-* rows are status receipts; role is the fallback. */
  private kindOf(item: JsonObject, itemId: string, childSid: string, childId: string): string {
    if (itemId === delegatedId(childSid, childId, 'objective')) return 'ASSIGNMENT';
    if (itemId === delegatedId(childSid, childId, 'answer')) return 'RETURN';
    if (itemId.startsWith('delegated-msg-')) return 'STATUS';
    const role = asText(item.role);
    if (role === 'user') return 'USER_INPUT';
    if (role === 'assistant') return 'ASSISTANT_MESSAGE';
    if (role.includes('tool')) return 'TOOL_RESULT';
    return 'STATUS';
  }
}

/** URLDecoder form semantics — same rule as validateCollaborationQuery. */
const decodeForm = (value: string): string => {
  try {
    return decodeURIComponent(value.replace(/\+/g, ' '));
  } catch {
    fail('INVALID_REQUEST', 400);
  }
};

/** Honest truncation helper for upstream list endpoints that only support
 *  limit: PAC cuts the reply and marks it, never fabricates a cursor.
 *  Returns true when truncation applied. */
export const truncateItems = (reply: JsonObject, field: string, limit: number): boolean => {
  const items = reply[field];
  if (!Array.isArray(items) || items.length <= limit) return false;
  reply[field] = items.slice(0, limit);
  reply.truncated = true;
  return true;
};
