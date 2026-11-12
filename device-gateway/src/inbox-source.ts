/**
 * Inbox SourceReader for ACS_SESSION resources — port of
 * PersonalAccessServer.readInboxSource(). Every category is read from the
 * real owner contract: pending approvals from requiresUserAction/
 * decisionStatus, results from concrete assistant messages, attention from
 * the public run state. Generic status words are never treated as a result.
 *
 * Per-branch unreadable sources leave that kind unverified this round —
 * Java catches BusinessException|IOException per section; our ACS seam
 * reports both as GatewayError, so only GatewayError is swallowed.
 */
import { fail, GatewayError, id, isRecord } from './protocol.js';
import type { Device, Resource, Signal, SourceRead } from './protocol.js';
import type { GatewayAcs, GatewayAuth, GatewayLocalTasks, JsonObject } from './context.js';
import type { InboxSourceReader } from './inbox.js';

export interface InboxSourceDeps {
  /** Undefined → ACS reads stay unverified (upstream calls throw). */
  acs?: GatewayAcs;
  localTasks?: GatewayLocalTasks;
  auth: Pick<GatewayAuth, 'authorizeDevice'>;
  /** Java binding(device) — per-device client-session token or undefined;
   * may resolve asynchronously (first call registers the session upstream). */
  binding: (device: Device) => string | undefined | Promise<string | undefined>;
}

const TERMINAL_STATUSES = new Set([
  'APPROVED', 'DENIED', 'EXPIRED', 'CANCELLED', 'REPLACED', 'SUPERSEDED', 'TIMED_OUT', 'TIMEOUT', 'CONSUMED',
]);
const PENDING_STATUSES = new Set(['PENDING', 'WAITING', 'WAITING_DELAY', 'PAUSED_DELAY', 'NEEDS_INPUT']);

const asObj = (v: unknown): JsonObject => (isRecord(v) ? v : {});
const asArr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const asText = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback);
const asLong = (v: unknown): number => (typeof v === 'number' ? v : 0);

const inboxTitle = (value: string, fallback: string): string => {
  const trimmed = value.trim().replace(/\s+/g, ' ');
  if (trimmed === '') return fallback;
  return trimmed.length > 120 ? trimmed.substring(0, 120) : trimmed;
};

const parseJson = (bytes: Uint8Array): unknown => {
  try {
    return JSON.parse(Buffer.from(bytes).toString('utf8'));
  } catch {
    fail('UPSTREAM_UNAVAILABLE', 503);
  }
};

export function createInboxSourceReader(deps: InboxSourceDeps): InboxSourceReader {
  const callDeadline = async (
    method: string, path: string, deadlineMillis: number, device: Device,
  ): Promise<{ status: number; body: unknown }> => {
    if (deps.acs === undefined) fail('UPSTREAM_UNAVAILABLE', 503);
    const remaining = deadlineMillis - Date.now();
    if (remaining <= 0) fail('SCAN_TIME_BUDGET_EXCEEDED', 503);
    const reply = await deps.acs.call(method, path, undefined, undefined, await deps.binding(device), 1_048_576);
    return { status: reply.status, body: parseJson(reply.body) };
  };

  const approvalSession = async (approval: JsonObject, device: Device, deadlineMillis: number): Promise<string> => {
    let sid = asText(approval.sessionId);
    const rid = asText(approval.runId);
    if (sid === '' && asText(approval.kind) !== 'BUDGET') fail('APPROVAL_BINDING_MISMATCH', 403);
    if (rid !== '') {
      id(rid);
      const run = await callDeadline('GET', `/api/v2/runs/${rid}`, deadlineMillis, device);
      if (run.status !== 200) fail('NOT_FOUND', 404);
      const owner = asText(asObj(run.body).sessionId);
      id(owner);
      if (sid !== '' && sid !== owner) fail('APPROVAL_BINDING_MISMATCH', 403);
      sid = owner;
    }
    id(sid);
    return sid;
  };

  return async (device: Device, resource: Resource, deadlineMillis: number): Promise<SourceRead> => {
    if (resource.kind === 'WORKER_LOCAL') {
      if (deps.localTasks === undefined) fail('LOCAL_SOURCE_NOT_CONFIGURED', 409);
      return deps.localTasks.signal(device, resource, deadlineMillis);
    }
    if (resource.kind !== 'ACS_SESSION') fail('INVALID_SCOPE', 400);
    const read: SourceRead = { signals: [], verifiedKinds: new Set<string>(), coverage: 'CURRENT_STATE', truncated: false };
    const sid = resource.sessionId!;
    await deps.auth.authorizeDevice(device.id, sid, 'OBSERVE');

    // ---- NEEDS_INPUT: pending approvals -----------------------------------
    try {
      const approvals = await callDeadline('GET', `/api/v2/sessions/${sid}/approvals`, deadlineMillis, device);
      if (approvals.status === 200 || approvals.status === 404) {
        read.verifiedKinds.add('NEEDS_INPUT');
        if (approvals.status === 200) {
          for (const row of asArr(asObj(approvals.body).items).map(asObj)) {
            // A decided approval keeps requiresUserAction set in some rows;
            // terminal statuses never need input again.
            const status = asText(row.decisionStatus).toUpperCase();
            if (TERMINAL_STATUSES.has(status)) continue;
            const action = row.requiresUserAction;
            const pending = typeof action === 'boolean' ? action : PENDING_STATUSES.has(status);
            if (!pending || typeof row.approvalId !== 'string') continue;
            let bound: string;
            try {
              bound = await approvalSession(row, device, deadlineMillis);
            } catch (unbound) {
              if (unbound instanceof GatewayError) continue;
              throw unbound;
            }
            if (bound !== sid) continue;
            const approvalId = asText(row.approvalId);
            const signal: Signal = {
              kind: 'NEEDS_INPUT',
              eventKey: `approval:${approvalId}`,
              sourceRevision: `${approvalId}:${asText(row.requestVersion, '0')}`,
              coverage: 'CURRENT_STATE',
              subject: {
                type: 'APPROVAL',
                approvalId,
                sessionId: sid,
                runId: asText(row.runId),
                requestVersion: asText(row.requestVersion),
                decisionStatus: asText(row.decisionStatus),
              },
              title: inboxTitle(asText(row.publicSummary, asText(row.kind)), '待审批'),
            };
            read.signals.push(signal);
          }
        }
      }
    } catch (unreadable) {
      if (!(unreadable instanceof GatewayError)) throw unreadable;
    }

    // ---- RESULT_READY: latest concrete assistant message -------------------
    let lastRunId: string | null = null;
    try {
      const messages = await callDeadline('GET', `/api/v2/sessions/${sid}/messages?limit=30`, deadlineMillis, device);
      if (messages.status === 200 || messages.status === 404) {
        read.verifiedKinds.add('RESULT_READY');
        if (messages.status === 200) {
          const page = asObj(messages.body);
          if (asText(page.sessionId) !== sid) fail('DEVICE_SCOPE_DENIED', 403);
          let latest: JsonObject | null = null;
          for (const item of asArr(page.items).map(asObj)) {
            if (isTextual(item.runId)) lastRunId = asText(item.runId);
            if (asText(item.role).toLowerCase() !== 'assistant') continue;
            const hasContent = asLong(item.contentBytes) > 0
              || asText(item.content) !== '' || asText(item.contentPreview) !== '';
            const attachments = Array.isArray(item.attachments) && item.attachments.length > 0;
            if (hasContent || attachments) latest = item;
          }
          if (latest !== null) {
            const messageId = asText(latest.id);
            if (messageId !== '') {
              const signal: Signal = {
                kind: 'RESULT_READY',
                eventKey: `message:${messageId}`,
                sourceRevision: `${messageId}:${asText(latest.contentRevision, '0')}`,
                coverage: 'CURRENT_STATE',
                subject: {
                  type: 'MESSAGE',
                  messageId,
                  sessionId: sid,
                  runId: asText(latest.runId),
                  contentRevision: asText(latest.contentRevision),
                },
                title: inboxTitle(asText(latest.contentPreview, asText(latest.content)), '结果就绪'),
              };
              read.signals.push(signal);
            }
          }
        }
      }
    } catch (unreadable) {
      if (!(unreadable instanceof GatewayError)) throw unreadable;
    }

    // ---- ATTENTION_REQUIRED: public run state ------------------------------
    try {
      const summary = await callDeadline('GET', `/api/v2/sessions/${sid}/summary`, deadlineMillis, device);
      if (summary.status === 404) {
        read.verifiedKinds.add('ATTENTION_REQUIRED');
      } else if (summary.status === 200) {
        const runId = asText(asObj(summary.body).activeRunId, lastRunId ?? '');
        if (runId === '') {
          read.verifiedKinds.add('ATTENTION_REQUIRED');
        } else {
          const run = await callDeadline('GET', `/api/v2/runs/${runId}`, deadlineMillis, device);
          if (run.status === 200 || run.status === 404) {
            if (run.status === 200) {
              const value = asObj(run.body);
              if (asText(value.sessionId) !== sid) fail('DEVICE_SCOPE_DENIED', 403);
              const state = asText(value.state);
              if (state === 'FAILED' || state === 'NEEDS_ATTENTION') {
                const signal: Signal = {
                  kind: 'ATTENTION_REQUIRED',
                  eventKey: `run:${runId}`,
                  sourceRevision: `${runId}:${asText(value.stateVersion, '0')}`,
                  coverage: 'CURRENT_STATE',
                  subject: {
                    type: 'RUN',
                    runId,
                    sessionId: sid,
                    state,
                    stateVersion: asText(value.stateVersion),
                    sourceStatus: asText(value.sourceStatus),
                  },
                  title: inboxTitle(asText(value.failureCode, state), '需要注意'),
                };
                read.signals.push(signal);
              }
            }
            read.verifiedKinds.add('ATTENTION_REQUIRED');
          }
        }
      }
    } catch (unreadable) {
      if (!(unreadable instanceof GatewayError)) throw unreadable;
    }

    await deps.auth.authorizeDevice(device.id, sid, 'OBSERVE');
    return read;
  };
}

const isTextual = (v: unknown): v is string => typeof v === 'string';
