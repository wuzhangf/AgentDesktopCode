/**
 * Bounded desktop surface for `client-access/1` (UCA-001 C4).
 *
 * The renderer never supplies a URL, method, header or credential. It submits
 * one of these frozen operations; main resolves the connection binding, the
 * message/action binding and the idempotency key. `requestId` is supplied by
 * the renderer so a retried send reuses the original durable intention instead
 * of minting a second one.
 *
 * Action input shapes are frozen to the six protocol action ids. The panel must
 * display the full question context (`ConversationView.actions[].context`)
 * before it offers an approval shape.
 */

export const PERSONAL_ACCESS_ACTIONS = [
  'STATUS', 'CONFIGURE', 'CONNECT', 'DISCONNECT',
  'AGENTS', 'CONVERSATIONS', 'CONVERSATION', 'REPLIES', 'CONTENT',
  'SEND', 'ACTION', 'LOOKUP'
] as const;

export type PersonalAccessAction = typeof PERSONAL_ACCESS_ACTIONS[number];

export type PersonalAccessActionInput =
  | { text: string }
  | { confirmed: boolean }
  | { value: string }
  | { decision: string }
  | Record<string, never>;

export type PersonalAccessOperation =
  | { action: 'STATUS' }
  | { action: 'CONFIGURE'; origin: string; basePath?: string; caPemPath?: string; token?: string }
  | { action: 'CONNECT' | 'DISCONNECT' }
  | { action: 'AGENTS' }
  | { action: 'CONVERSATIONS'; agentRef: string }
  | { action: 'CONVERSATION'; conversationRef: string }
  | { action: 'REPLIES'; conversationRef: string; cursor?: string; ifRevision?: string }
  | { action: 'CONTENT'; conversationRef: string; replyRef: string; cursor?: string }
  | { action: 'SEND'; conversationRef: string; text: string; requestId: string }
  | { action: 'ACTION'; conversationRef: string; actionId: string; input: PersonalAccessActionInput; requestId: string }
  | { action: 'LOOKUP'; requestId: string };

/**
 * The six frozen action ids. The input SHAPE is not derived from the id here:
 * the descriptor's `inputKind` is authoritative, and the transport port rejects
 * a mismatch between the descriptor shape and the submitted keys.
 */
export const ACTION_IDS = Object.freeze([
  'execution.supplement', 'execution.stop', 'execution.pause',
  'execution.resume_paused', 'execution.resume_waiting', 'input.respond'
]);

/** Protocol action ids that carry no input at all. */
export const NO_INPUT_ACTIONS: readonly string[] = Object.freeze([
  'execution.stop', 'execution.pause', 'execution.resume_paused', 'execution.resume_waiting'
]);

const REF_PATTERN = /^[acberp]1\.[A-Za-z0-9_-]+$/;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;
const BASE_PATH_PATTERN = /^\/?[A-Za-z0-9/_-]*$/;
const CONTROL = /[\u0000-\u001f\u007f]/;
const MAX_REF = 2800;
const MAX_TEXT_BYTES = 8192;
const MAX_CURSOR = 1024;
const MAX_PAYLOAD_BYTES = 65536;

const isObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

const boundedRef = (value: unknown): value is string =>
  typeof value === 'string' && value.length >= 4 && value.length <= MAX_REF && REF_PATTERN.test(value);

const boundedCursor = (value: unknown): value is string =>
  typeof value === 'string' && value.length >= 4 && value.length <= MAX_REF && REF_PATTERN.test(value);

const boundedText = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0 && !CONTROL.test(value)
  && new TextEncoder().encode(value).length <= MAX_TEXT_BYTES;

/** Origin accepted by the port: https anywhere, http only on loopback. */
export function validPersonalAccessOrigin(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2048) return false;
  try {
    const url = new URL(value);
    if (url.username || url.password || url.search || url.hash || url.pathname !== '/') return false;
    if (url.protocol === 'https:') return true;
    return url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  } catch {
    return false;
  }
}

export function validBasePath(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 512 && BASE_PATH_PATTERN.test(value) && !value.includes('//');
}

/** Exactly one of the four frozen input shapes; no free-form keys. */
function validActionInput(input: unknown): input is Record<string, unknown> {
  if (!isObject(input)) return false;
  const keys = Object.keys(input);
  if (keys.length === 0) return true;
  if (keys.length !== 1) return false;
  switch (keys[0]) {
    case 'text':
      return boundedText(input.text);
    case 'value':
      return boundedText(input.value);
    case 'decision':
      return boundedText(input.decision);
    case 'confirmed':
      return typeof input.confirmed === 'boolean';
    default:
      return false;
  }
}

export function validPersonalAccessOperation(payload: unknown): payload is PersonalAccessOperation {
  if (!isObject(payload)) return false;
  const action = payload.action;
  if (typeof action !== 'string' || !PERSONAL_ACCESS_ACTIONS.includes(action as PersonalAccessAction)) return false;
  const keys = new Set(['action']);
  switch (action) {
    case 'STATUS':
    case 'CONNECT':
    case 'DISCONNECT':
    case 'AGENTS':
      break;
    case 'CONFIGURE':
      if (!validPersonalAccessOrigin(payload.origin)) return false;
      keys.add('origin');
      if (payload.basePath !== undefined) {
        if (!validBasePath(payload.basePath)) return false;
        keys.add('basePath');
      }
      if (payload.caPemPath !== undefined) {
        if (typeof payload.caPemPath !== 'string' || payload.caPemPath.length > 1024 || CONTROL.test(payload.caPemPath)) return false;
        keys.add('caPemPath');
      }
      if (payload.token !== undefined) {
        if (typeof payload.token !== 'string' || payload.token.length === 0 || payload.token.length > 8192 || CONTROL.test(payload.token)) return false;
        keys.add('token');
      }
      break;
    case 'CONVERSATIONS':
      if (!boundedRef(payload.agentRef)) return false;
      keys.add('agentRef');
      break;
    case 'CONVERSATION':
      if (!boundedRef(payload.conversationRef)) return false;
      keys.add('conversationRef');
      break;
    case 'REPLIES':
      if (!boundedRef(payload.conversationRef)) return false;
      keys.add('conversationRef');
      if (payload.cursor !== undefined) {
        if (!boundedCursor(payload.cursor)) return false;
        keys.add('cursor');
      }
      if (payload.ifRevision !== undefined) {
        if (!boundedCursor(payload.ifRevision)) return false;
        keys.add('ifRevision');
      }
      if (payload.cursor !== undefined && payload.ifRevision !== undefined) return false;
      break;
    case 'CONTENT':
      if (!boundedRef(payload.conversationRef) || !boundedRef(payload.replyRef)) return false;
      keys.add('conversationRef');
      keys.add('replyRef');
      if (payload.cursor !== undefined) {
        if (!boundedCursor(payload.cursor)) return false;
        keys.add('cursor');
      }
      break;
    case 'SEND':
      if (!boundedRef(payload.conversationRef) || !boundedText(payload.text)) return false;
      if (typeof payload.requestId !== 'string' || !REQUEST_ID_PATTERN.test(payload.requestId)) return false;
      keys.add('conversationRef');
      keys.add('text');
      keys.add('requestId');
      break;
    case 'ACTION':
      if (!boundedRef(payload.conversationRef)) return false;
      if (typeof payload.actionId !== 'string' || !ACTION_IDS.includes(payload.actionId)) return false;
      if (!validActionInput(payload.input)) return false;
      // Ids whose shape is frozen by the protocol: stop/pause/resume carry no
      // input, supplement always carries text. `input.respond` keeps the
      // descriptor's CONFIRM/SELECT/DECISION shape.
      if (NO_INPUT_ACTIONS.includes(payload.actionId) && Object.keys(payload.input).length > 0) return false;
      if (payload.actionId === 'execution.supplement' && !('text' in payload.input)) return false;
      if (typeof payload.requestId !== 'string' || !REQUEST_ID_PATTERN.test(payload.requestId)) return false;
      keys.add('conversationRef');
      keys.add('actionId');
      keys.add('input');
      keys.add('requestId');
      break;
    case 'LOOKUP':
      if (typeof payload.requestId !== 'string' || !REQUEST_ID_PATTERN.test(payload.requestId)) return false;
      keys.add('requestId');
      break;
    default:
      return false;
  }
  if (Object.keys(payload).some((key) => !keys.has(key))) return false;
  try {
    return new TextEncoder().encode(JSON.stringify(payload)).length <= MAX_PAYLOAD_BYTES;
  } catch {
    return false;
  }
}
