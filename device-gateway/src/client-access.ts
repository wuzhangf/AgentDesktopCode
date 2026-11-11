/**
 * client-access — port of ClientAccessService (the structured
 * /personal/v1/client conversation contract). The ref/unref codec lives in
 * client-wire.ts; this file only wires auth + native/ACS source ports.
 *
 * Java seam mapping:
 *  - PersonalAccessService → deps.auth (authenticate/authorize/authorizeLocal)
 *  - PersonalLocalTaskAccess (nativeAccess) → deps.localTasks (optional;
 *    absent → SOURCE_UNAVAILABLE 503 on native paths, like Java's null check)
 *  - SourcePort → deps.source (the acs.callJson closure — its BODY_TOO_LARGE
 *    → SOURCE_RESPONSE_TOO_LARGE remap happens inside acs.ts)
 *  - store/boot = ownerStatus().storeId / registry bootId supplied by wiring.
 */
import { fail, GatewayError, isRecord } from './protocol.js';
import type { Device, LaunchScope, Resource } from './protocol.js';
import type {
  GatewayAuth,
  GatewayClientAccess,
  GatewayLocalTasks,
  JsonObject,
} from './context.js';
import {
  bodyText,
  digest,
  digestBytes,
  exact,
  excerpt,
  id as wireId,
  ref,
  sourceKey,
  text as wireText,
  unref,
  VERSION,
} from './client-wire.js';

// ---------------------------------------------------------------------------
// JsonNode-shaped accessors — Java path()/asText()/asBoolean() semantics on
// missing nodes: '' / false / 0.
// ---------------------------------------------------------------------------

type Node = unknown;
type Obj = JsonObject;

const obj = (): Obj => ({});
const asObj = (v: Node): Obj => (isRecord(v) ? v : {});
const asArr = (v: Node): Node[] => (Array.isArray(v) ? v : []);
const asText = (v: Node, fallback = ''): string => (typeof v === 'string' ? v : fallback);
const asBool = (v: Node): boolean => v === true;
const asLong = (v: Node): number => {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && /^-?[0-9]+$/.test(v)) return Number(v);
  return 0;
};
const isIntegral = (v: Node): boolean => typeof v === 'number' && Number.isInteger(v);
/** Jackson canConvertToInt: integral value inside the signed 32-bit range. */
const canConvertToInt = (v: Node): boolean => isIntegral(v) && (v as number) >= -2147483648 && (v as number) <= 2147483647;
const isTextual = (v: Node): v is string => typeof v === 'string';
const isMissingOrNull = (v: Node): boolean => v === undefined || v === null;
const deep = (v: Obj): Obj => JSON.parse(JSON.stringify(v)) as Obj;
const fieldNames = (v: Obj): string[] => Object.keys(v);
const has = (v: Obj, k: string): boolean => k in v;
const sizeOf = (v: Node): number => (isRecord(v) || Array.isArray(v) ? Object.keys(v).length : 0);

const now = (): string => new Date().toISOString();
const encode = (v: string): string => encodeURIComponent(v);

export interface ClientAccessSource {
  (device: Device, method: string, path: string, body: unknown, key: string | null): Promise<JsonObject>;
}

export interface ClientAccessDeps {
  auth: Pick<GatewayAuth, 'authenticate' | 'authorize' | 'authorizeLocal' | 'ownerStatus'>;
  localTasks?: GatewayLocalTasks;
  storeId: string;
  bootId: string;
  source: ClientAccessSource;
}

// Pure loc accessors — module level so both the dispatcher and the helpers
// (module-scope nativeCall) share them.
const session = (loc: Obj): string => wireId(wireText(loc, 'sessionId'));
const task = (loc: Obj): string => wireId(wireText(loc, 'taskId'));
const backend = (loc: Obj): string => wireId(wireText(loc, 'backendStoreId'));

const isNative = (loc: Node): boolean => {
  const kind = asText(asObj(loc).sourceKind);
  if (kind !== 'ACS_SESSION' && kind !== 'WORKER_NATIVE') fail('SOURCE_IDENTITY_CHANGED', 409);
  return kind === 'WORKER_NATIVE';
};

/** Java: PersonalLocalTaskAccess.remote status<200||>=300 → fail(body.code|SOURCE_UNAVAILABLE, status). */
const nativeCall = async (
  nativeAccess: GatewayLocalTasks | undefined,
  token: string, loc: Obj, method: string, tail: string, body: unknown, key: string | null,
): Promise<JsonObject> => {
  if (nativeAccess === undefined) fail('SOURCE_UNAVAILABLE', 503);
  const path = `/personal/v1/local-tasks/${backend(loc)}/tasks/${task(loc)}${tail}`;
  const result = await nativeAccess.remote(token, method, path, body, key, null);
  if (result.status < 200 || result.status >= 300) {
    const code = typeof asObj(result.body).code === 'string'
      ? asObj(result.body).code as string : 'SOURCE_UNAVAILABLE';
    fail(code, result.status);
  }
  return asObj(result.body);
};

/** Java split("/") drops trailing empty segments. */
const javaSplit = (path: string): string[] => {
  const parts = path.split('/');
  while (parts.length > 0 && parts[parts.length - 1] === '') parts.pop();
  return parts;
};

export function createClientAccess(deps: ClientAccessDeps): GatewayClientAccess {
  const { auth, source } = deps;
  const nativeAccess = deps.localTasks;
  const store = deps.storeId;
  const boot = deps.bootId;

  const location = (kind: string): Obj => ({ sourceKind: kind, storeId: store });
  const decode = (value: string, prefix: string): Obj => {
    const out = unref(value, prefix);
    if (store !== wireText(out, 'storeId')) fail('SOURCE_IDENTITY_CHANGED', 409);
    return out;
  };

  const authorize = async (token: string, loc: Obj, action: string): Promise<void> => {
    if (isNative(loc)) {
      if (nativeAccess === undefined) fail('SOURCE_UNAVAILABLE', 503);
      await auth.authorizeLocal(token, backend(loc), task(loc), action);
      await nativeAccess.verifyTaskEngine(token, backend(loc), task(loc), asText(loc.engineId));
    } else {
      await auth.authorize(token, session(loc), action);
    }
  };

  const acs = async (
    token: string, loc: Obj, method: string, tail: string, body: unknown, key: string | null, action: string,
  ): Promise<JsonObject> => {
    const d = await auth.authorize(token, session(loc), action);
    const out = asObj(await source(d, method, tail, body, key));
    await auth.authorize(token, session(loc), action);
    return out;
  };

  const native = (token: string, loc: Obj, method: string, tail: string, body: unknown, key: string | null) =>
    nativeCall(nativeAccess, token, loc, method, tail, body, key);

  const foundation = (token: string, loc: Obj) =>
    acs(token, loc, 'GET', `/api/v2/sessions/${session(loc)}/foundation`, null, null, 'OBSERVE');

  const conversation = (r: Resource, engine: string | null): Obj => {
    const out = location(r.kind === 'ACS_SESSION' ? 'ACS_SESSION' : 'WORKER_NATIVE');
    if (r.kind === 'ACS_SESSION') out.sessionId = r.sessionId;
    else { out.backendStoreId = r.backendStoreId; out.engineId = engine; out.taskId = r.taskId; }
    return out;
  };

  const agent = (loc: Obj): Obj => {
    const out = location(asText(loc.sourceKind));
    if (isNative(loc)) { out.backendStoreId = backend(loc); out.engineId = asText(loc.engineId); }
    else out.agentId = 'acs';
    return out;
  };

  const visible = async (token: string): Promise<Obj[]> => {
    const d = await auth.authenticate(token);
    const out: Obj[] = [];
    for (const r of d.resources ?? []) {
      if (r.kind === 'ACS_SESSION') {
        if ((d.actions ?? []).includes('OBSERVE')) {
          await auth.authorize(token, r.sessionId!, 'OBSERVE');
          out.push(conversation(r, null));
        }
      } else if (r.kind === 'WORKER_LOCAL' && (d.actions ?? []).includes('OBSERVE') && nativeAccess !== undefined) {
        const loc = conversation(r, 'unobserved');
        const detail = await native(token, loc, 'GET', '', null, null);
        const engine = asText(detail.engineId);
        if (engine === '') continue;
        out.push(conversation(r, engine));
      }
    }
    if ((await auth.authenticate(token)).revision !== d.revision) fail('GRANT_REVISION_CHANGED', 409);
    return out;
  };

  const query = (raw: string | null): Map<string, string> => {
    const out = new Map<string, string>();
    if (raw === null || raw === '') return out;
    if (raw.length > 4096) fail('INVALID_REQUEST', 422);
    for (const part of raw.split('&')) {
      const idx = part.indexOf('=');
      const key = idx < 0 ? part : part.slice(0, idx);
      const value = idx < 0 ? '' : part.slice(idx + 1);
      let k: string, v: string;
      try { k = decodeURIComponent(key); v = decodeURIComponent(value); }
      catch { fail('INVALID_REQUEST', 422); }
      if (!['cursor', 'limit', 'ifRevision'].includes(k!) || out.has(k!)) fail('INVALID_REQUEST', 422);
      out.set(k!, v!);
    }
    return out;
  };

  const limit = (q: Map<string, string>): number => {
    let value: number;
    try {
      value = Number.parseInt(q.get('limit') ?? '20', 10);
      if (!Number.isInteger(value)) fail('INVALID_REQUEST', 422);
    } catch {
      fail('INVALID_REQUEST', 422);
    }
    if (value! < 1 || value! > 50) fail('INVALID_REQUEST', 422);
    return value!;
  };

  const addAgent = (items: Node[], seen: Set<string>, loc: Obj, reason: string | null): void => {
    const aref = ref('a1', agent(loc));
    if (seen.has(aref)) return;
    seen.add(aref);
    const row: Obj = {
      agentRef: aref,
      displayName: isNative(loc) ? asText(loc.engineId) : 'ACS',
      sourceKind: asText(loc.sourceKind),
      availability: reason === null ? 'AVAILABLE' : 'UNAVAILABLE',
      reasonCode: reason,
    };
    if (isNative(loc)) row.engineId = asText(loc.engineId);
    items.push(row);
  };

  const validateConversation = (loc: Obj): void => {
    if (isNative(loc)) exact(loc, 'sourceKind', 'storeId', 'backendStoreId', 'engineId', 'taskId');
    else exact(loc, 'sourceKind', 'storeId', 'sessionId');
  };

  const directory = async (token: string, aref: string, q: Map<string, string>): Promise<Obj> => {
    const a = decode(aref, 'a1');
    if (isNative(a)) exact(a, 'sourceKind', 'storeId', 'backendStoreId', 'engineId');
    else {
      exact(a, 'sourceKind', 'storeId', 'agentId');
      if (asText(a.agentId) !== 'acs') fail('NOT_FOUND', 404);
    }
    let offset = 0;
    const count = limit(q);
    if (q.has('cursor')) {
      const c = decode(q.get('cursor')!, 'p1');
      exact(c, 'sourceKind', 'storeId', 'agentId', 'position');
      if (asText(c.agentId) !== aref || !canConvertToInt(c.position) || (offset = asLong(c.position)) < 0) {
        fail('CURSOR_INVALID', 409);
      }
    }
    const matched: Obj[] = [];
    for (const loc of await visible(token)) {
      if (ref('a1', agent(loc)) === aref) matched.push(loc);
    }
    const out = obj();
    const rows: Node[] = [];
    for (let i = offset; i < Math.min(matched.length, offset + count); i++) {
      rows.push({
        agentRef: aref,
        conversationRef: ref('c1', matched[i]),
        title: isNative(a) ? 'Native task' : 'ACS conversation',
      });
    }
    out.items = rows;
    const more = offset + count < matched.length;
    out.truncated = more;
    out.nextCursor = more
      ? ref('p1', { ...location(asText(a.sourceKind)), agentId: aref, position: offset + count })
      : null;
    return out;
  };

  /** Java descriptor(): addObject() the action row, then return it. */
  const pushDescriptor = (
    actions: Node[], actionId: string, kind: string, reason: string | null, binding: string | null,
  ): Obj => {
    const row: Obj = {
      actionId,
      label: actionId,
      inputKind: kind,
      availability: reason === null ? 'AVAILABLE' : 'UNAVAILABLE',
      reasonCode: reason,
      binding,
    };
    actions.push(row);
    return row;
  };

  const grant = (d: Device, action: string): string | null =>
    (d.actions ?? []).includes(action) ? null : 'SCOPE_DENIED';

  const nativeBinding = (loc: Obj, facts: Node, operation: string): Obj => {
    const b: Obj = { ...deep(loc), operation };
    const f = asObj(facts);
    for (const k of ['generation', 'nativeSessionId', 'nativeTurnId']) b[k] = f[k] ?? null;
    b.targetCommandId = f.currentCommandId ?? null;
    return b;
  };

  const view = async (token: string, loc: Obj): Promise<Obj> => {
    const d = await auth.authenticate(token);
    const out: Obj = {
      agentRef: ref('a1', agent(loc)),
      conversationRef: ref('c1', loc),
      title: isNative(loc) ? 'Native task' : 'ACS conversation',
      observedAt: now(),
      authorizationRevision: String(d.revision),
      actionsTruncated: false,
      actions: [],
      executions: [],
    };
    const actions = out.actions as Node[];
    const executions = out.executions as Node[];
    if (isNative(loc)) {
      const facts = await native(token, loc, 'GET', '', null, null);
      if (asText(loc.engineId) !== asText(facts.engineId)) fail('SOURCE_IDENTITY_CHANGED', 409);
      out.sourceState = facts.state;
      const follow = asBool(asObj(facts.capabilities).followUp);
      let reason = grant(d, 'INTERACT');
      if (reason === null && !follow) reason = 'USE_SUPPLEMENT_ACTION';
      out.message = {
        meaning: 'NATIVE_FOLLOW_UP',
        availability: reason === null ? 'AVAILABLE' : 'UNAVAILABLE',
        reasonCode: reason,
        binding: ref('b1', nativeBinding(loc, facts, 'message.send')),
      };
      for (const action of ['execution.supplement', 'execution.stop']) {
        const cap = action.endsWith('stop') ? 'stop' : 'steer';
        let r = grant(d, cap === 'stop' ? 'CONTROL' : 'INTERACT');
        if (r === null && !asBool(asObj(facts.capabilities)[cap])) r = 'SOURCE_ACTION_UNAVAILABLE';
        pushDescriptor(actions, action, cap === 'stop' ? 'NONE' : 'TEXT', r,
          ref('b1', nativeBinding(loc, facts, action)));
      }
      for (const action of ['execution.pause', 'execution.resume_paused']) {
        const row = pushDescriptor(actions, action, 'NONE', 'NATIVE_PAUSE_NOT_IMPLEMENTED', null);
        row.availability = 'UNSUPPORTED';
      }
      const qs = await native(token, loc, 'GET', '/input-requests', null, null);
      let seen = 0;
      for (const question of asArr(qs.items)) {
        if (asText(asObj(question).state) !== 'PENDING') continue;
        if (++seen > 20) { out.actionsTruncated = true; break; }
        const method = asText(asObj(question).method);
        const kind = method === 'confirm' ? 'CONFIRM'
          : method === 'select' ? 'SELECT'
            : ['input', 'editor'].includes(method) ? 'TEXT'
              : method.startsWith('item/') ? 'DECISION' : null;
        if (kind === null) continue;
        const bind: Obj = {
          ...nativeBinding(loc, question, 'input.respond'),
          inputRequestId: wireText(asObj(question), 'inputRequestId'),
          method,
        };
        bind.targetCommandId = asObj(question).targetCommandId ?? null;
        const r = grant(d, 'APPROVE');
        const a = pushDescriptor(actions, 'input.respond', kind, r, ref('b1', bind));
        const context: Obj = {};
        for (const k of ['title', 'scope', 'options']) if (has(asObj(question), k)) context[k] = asObj(question)[k];
        if (Buffer.byteLength(JSON.stringify(context), 'utf8') > 16384) {
          a.availability = 'UNAVAILABLE';
          a.reasonCode = 'SPECIALIZED_INPUT_REQUIRED';
        } else {
          a.context = context;
        }
      }
      const command = asText(facts.currentCommandId);
      if (command !== '') {
        executions.push({ executionRef: ref('e1', { ...deep(loc), runId: command }), sourceState: facts.state });
      }
    } else {
      const facts = await foundation(token, loc);
      if (session(loc) !== asText(facts.sessionId)) fail('SOURCE_IDENTITY_CHANGED', 409);
      out.sourceState = facts.runState;
      const b = { ...deep(loc), operation: 'message.send', sessionVersion: wireText(facts, 'sessionVersion') };
      const reason = grant(d, 'INTERACT');
      out.message = {
        meaning: 'SESSION_MESSAGE',
        availability: reason === null ? 'AVAILABLE' : 'UNAVAILABLE',
        reasonCode: reason,
        binding: ref('b1', b),
      };
      const run = asText(facts.activeRunId);
      if (run !== '') {
        executions.push({ executionRef: ref('e1', { ...deep(loc), runId: run }), sourceState: facts.runState });
        for (const action of ['execution.stop', 'execution.pause', 'execution.resume_paused']) {
          const intent = action.endsWith('stop') ? 'STOP' : action.endsWith('pause') ? 'PAUSE' : 'RESUME';
          const cap = asObj(asObj(facts.runControl)[intent]);
          let r = grant(d, 'CONTROL');
          if (r === null && asText(cap.availability) !== 'AVAILABLE') {
            r = asText(cap.reasonCode, 'SOURCE_CAPABILITY_UNKNOWN');
          }
          if (intent !== 'STOP' && asText(asObj(facts.capabilities).commandReceiptV1) !== 'READY') {
            r = 'SOURCE_CAPABILITY_DISABLED';
          }
          const binding: Obj = { ...deep(loc), operation: action, runId: run };
          if (intent !== 'STOP') binding.stateVersion = asText(facts.runStateVersion);
          pushDescriptor(actions, action, 'NONE', r, ref('b1', binding));
        }
      }
    }
    return out;
  };

  const binding = (loc: Obj, value: string, action: string): Obj => {
    const b = decode(value, 'b1');
    const fields: string[] = fieldNames(loc);
    fields.push('operation');
    if (isNative(loc)) {
      fields.push('generation', 'nativeSessionId', 'nativeTurnId', 'targetCommandId');
      if (action === 'input.respond') fields.push('inputRequestId', 'method');
    } else if (action === 'message.send') {
      fields.push('sessionVersion');
    } else {
      fields.push('runId');
      if (action !== 'execution.stop') fields.push('stateVersion');
    }
    exact(b, ...fields);
    const target = deep(b);
    for (const k of ['operation', 'sessionVersion', 'stateVersion', 'runId', 'generation',
      'nativeSessionId', 'nativeTurnId', 'targetCommandId', 'inputRequestId', 'method']) {
      delete target[k];
    }
    if (JSON.stringify(target) !== JSON.stringify(loc) || action !== wireText(b, 'operation')) {
      fail('TARGET_CHANGED', 409);
    }
    return b;
  };

  const key = (d: Device, loc: Obj, action: string, rid: string, b: Obj): string => {
    const type = isNative(loc) ? 'NATIVE_TASK' : action === 'message.send' ? 'CONVERSATION' : 'RUN';
    const target = isNative(loc) ? task(loc) : action === 'message.send' ? session(loc) : wireText(b, 'runId');
    return sourceKey(d.id, asText(loc.sourceKind), store, isNative(loc) ? backend(loc) : '',
      type, target, action === 'message.send' ? 'MESSAGE' : `ACTION:${action}`, wireId(rid));
  };

  const number = (node: Node, k: string): number => {
    let n: number;
    const v = wireText(asObj(node), k);
    if (!/^[0-9]{1,16}$/.test(v)) fail('INVALID_REQUEST', 422);
    try {
      n = Number(v);
    } catch {
      fail('INVALID_REQUEST', 422);
    }
    if (n! > 9007199254740991) fail('INVALID_REQUEST', 422);
    return n!;
  };

  const verifyRun = async (token: string, loc: Obj, run: string): Promise<void> => {
    const src = await acs(token, loc, 'GET', `/api/v2/runs/${run}`, null, null, 'OBSERVE');
    if (session(loc) !== asText(src.sessionId)) fail('SCOPE_DENIED', 403);
  };

  const receipt = (rid: string, loc: Obj, original: Node): Obj => {
    const o = asObj(original);
    const fact = has(o, 'source') ? asObj(o.source)
      : has(o, 'result') && isRecord(o.result) ? asObj(o.result) : o;
    const status = asText(fact.phase, asText(fact.state,
      asText(o.status, asText(fact.status, asText(o.state, 'UNCONFIRMED')))));
    const accepted = ['UNKNOWN', 'DISPATCHED', 'SAVED', 'PENDING', 'UNCONFIRMED'].includes(status)
      ? null : ['REJECTED', 'NOT_APPLIED'].includes(status) ? false : true;
    const out: Obj = {
      requestId: rid,
      sourceStatus: status,
      observedAt: now(),
      conversationRef: ref('c1', loc),
      consumed: null,
      accepted,
    };
    if (isRecord(fact.consumptionProof) && sizeOf(fact.consumptionProof) > 0) out.consumed = true;
    const run = asText(fact.runId);
    if (run !== '') out.executionRef = ref('e1', { ...deep(loc), runId: run });
    return out;
  };

  const submit = async (
    token: string, loc: Obj, body: Node, header: string | null, action: boolean,
  ): Promise<JsonObject> => {
    if (action) exact(body, 'requestId', 'actionId', 'binding', 'input');
    else exact(body, 'requestId', 'text', 'binding');
    const b0 = asObj(body);
    const rid = wireId(wireText(b0, 'requestId'));
    if (rid !== header) fail('IDEMPOTENCY_CONFLICT', 409);
    const name = action ? wireText(b0, 'actionId') : 'message.send';
    const b = binding(loc, wireText(b0, 'binding'), name);
    const d = await auth.authenticate(token);
    const skey = key(d, loc, name, rid, b);
    let result: JsonObject;
    if (isNative(loc)) {
      const intent = name === 'message.send' ? 'NATIVE_FOLLOW_UP'
        : name === 'execution.supplement' ? 'NATIVE_STEER'
          : name === 'execution.stop' ? 'STOP'
            : name === 'input.respond' ? 'INPUT_RESPONSE' : null;
      if (intent === null) fail('CAPABILITY_UNAVAILABLE', 409);
      const wire: Obj = { requestKey: skey };
      for (const k of ['generation', 'nativeSessionId', 'nativeTurnId', 'targetCommandId']) {
        if (!isMissingOrNull(b[k])) wire[k] = b[k];
      }
      let tail: string;
      if (intent === 'STOP') {
        exact(b0.input);
        wire.intent = 'STOP';
        tail = '/commands';
      } else if (intent === 'INPUT_RESPONSE') {
        const method = wireText(b, 'method');
        const input = b0.input;
        const answer: Obj = {};
        wire.response = answer;
        if (method === 'confirm') {
          exact(input, 'confirmed');
          if (typeof asObj(input).confirmed !== 'boolean') fail('INVALID_REQUEST', 422);
          answer.confirmed = asObj(input).confirmed;
        } else if (method === 'select') {
          exact(input, 'value');
          answer.value = bodyText(asObj(input), 'value');
        } else if (['input', 'editor'].includes(method)) {
          exact(input, 'text');
          answer.value = bodyText(asObj(input), 'text');
        } else if (method.startsWith('item/')) {
          exact(input, 'decision');
          answer.decision = bodyText(asObj(input), 'decision');
        } else {
          fail('CAPABILITY_UNAVAILABLE', 409);
        }
        const questionId = wireId(wireText(b, 'inputRequestId'));
        if (!(await nativeAccess!.recordedInput(token, backend(loc), task(loc), skey))) {
          let found: Node = null;
          for (const q of asArr((await native(token, loc, 'GET', '/input-requests', null, null)).items)) {
            if (asText(asObj(q).inputRequestId) === questionId) found = q;
          }
          if (found === null || asText(asObj(found).state) !== 'PENDING'
            || method !== asText(asObj(found).method)) fail('NATIVE_INPUT_EXPIRED', 409);
          const context: Obj = {};
          for (const k of ['title', 'scope', 'options']) if (has(asObj(found), k)) context[k] = asObj(found)[k];
          if (Buffer.byteLength(JSON.stringify(context), 'utf8') > 16384) fail('SPECIALIZED_INPUT_REQUIRED', 409);
          if (method === 'select' || method.startsWith('item/')) {
            const choice = asText(answer[method === 'select' ? 'value' : 'decision']);
            let allowed = false;
            for (const option of asArr(asObj(found).options)) {
              if (isTextual(option) && asText(option) === choice) allowed = true;
            }
            if (!allowed) fail('NATIVE_OPTION_NOT_ALLOWED', 422);
          }
        }
        tail = `/input-requests/${questionId}/responses`;
      } else {
        if (action) exact(b0.input, 'text');
        wire.kind = intent;
        wire.content = bodyText(action ? asObj(b0.input) : b0, 'text');
        tail = '/messages';
      }
      result = await native(token, loc, 'POST', tail, wire, skey);
    } else if (!action) {
      const wire: Obj = {
        clientMessageId: skey,
        content: bodyText(b0, 'text'),
        expectedSessionVersion: number(b, 'sessionVersion'),
      };
      result = await acs(token, loc, 'POST', `/api/v2/sessions/${session(loc)}/messages`, wire, skey, 'INTERACT');
    } else {
      exact(b0.input);
      const intent = name === 'execution.stop' ? 'STOP'
        : name === 'execution.pause' ? 'PAUSE'
          : name === 'execution.resume_paused' ? 'RESUME' : null;
      if (intent === null) fail('CAPABILITY_UNAVAILABLE', 409);
      const run = wireId(wireText(b, 'runId'));
      await verifyRun(token, loc, run);
      const wire: Obj = { schemaVersion: 'run-command/1', commandId: skey, intent };
      if (intent !== 'STOP') wire.expectedStateVersion = number(b, 'stateVersion');
      result = await acs(token, loc, 'POST', `/api/v2/runs/${run}/commands`, wire, skey, 'CONTROL');
    }
    return receipt(rid, loc, result);
  };

  const lookup = async (token: string, body: Node): Promise<JsonObject> => {
    const kind = wireText(asObj(body), 'kind');
    const action = kind === 'ACTION';
    if (!action && kind !== 'MESSAGE') fail('INVALID_REQUEST', 422);
    if (action) exact(body, 'kind', 'requestId', 'conversationRef', 'binding', 'actionId');
    else exact(body, 'kind', 'requestId', 'conversationRef', 'binding');
    const b0 = asObj(body);
    const loc = decode(wireText(b0, 'conversationRef'), 'c1');
    validateConversation(loc);
    await authorize(token, loc, 'OBSERVE');
    const name = action ? wireText(b0, 'actionId') : 'message.send';
    const b = binding(loc, wireText(b0, 'binding'), name);
    const rid = wireId(wireText(b0, 'requestId'));
    const skey = key(await auth.authenticate(token), loc, name, rid, b);
    let found: JsonObject;
    if (isNative(loc)) {
      found = await native(token, loc, 'GET', `/requests/${skey}`, null, null);
    } else if (action) {
      const run = wireId(wireText(b, 'runId'));
      await verifyRun(token, loc, run);
      found = await acs(token, loc, 'GET', `/api/v2/runs/${run}/commands/${skey}`, null, null, 'OBSERVE');
    } else {
      found = await acs(token, loc, 'POST', '/api/v2/operations/lookup',
        { operation: 'session.message', resourceId: session(loc), idempotencyKey: skey }, skey, 'OBSERVE');
      if (asText(found.operation) !== 'session.message' || session(loc) !== asText(found.resourceId)) {
        fail('SOURCE_IDENTITY_CHANGED', 409);
      }
    }
    await authorize(token, loc, 'OBSERVE');
    return receipt(rid, loc, found);
  };

  const cursor = (loc: Obj, value: string, operation: string): Obj => {
    const c = decode(value, 'p1');
    const target = deep(c);
    for (const k of ['operation', 'position', 'messageId', 'contentRevision', 'offset']) delete target[k];
    if (JSON.stringify(target) !== JSON.stringify(loc) || operation !== wireText(c, 'operation')) {
      fail('CURSOR_INVALID', 409);
    }
    return c;
  };

  /** Mac publishes a verification summary on /output, not a conversation message. */
  const nativePublicOutput = async (token: string, loc: Obj): Promise<string> => {
    let value = (await native(token, loc, 'GET', '/messages', null, null)).text;
    if (asText(loc.engineId) !== 'macos') return asText(value);
    if (!isTextual(value) || asText(value).trim() === '') {
      value = (await native(token, loc, 'GET', '/output', null, null)).text;
    }
    const output = isTextual(value) ? value : '';
    if (Buffer.byteLength(output, 'utf8') > 262144) fail('SOURCE_RESPONSE_TOO_LARGE', 503);
    return output;
  };

  const replies = async (token: string, loc: Obj, q: Map<string, string>): Promise<JsonObject> => {
    if (q.has('cursor') && q.has('ifRevision')) fail('INVALID_REQUEST', 422);
    const count = limit(q);
    const out: Obj = { coverage: isNative(loc) ? 'BOUNDED_PUBLIC_OUTPUT' : 'BOUNDED_HISTORY', items: [] };
    const items = out.items as Node[];
    if (isNative(loc)) {
      if (q.has('cursor')) fail('CURSOR_INVALID', 409);
      const output = await nativePublicOutput(token, loc);
      const rev = digestBytes(Buffer.from(output, 'utf8'));
      const unchanged = rev === q.get('ifRevision');
      out.representation = 'TEXT_SNAPSHOT';
      out.revision = rev;
      out.unchanged = unchanged;
      out.nextCursor = null;
      if (!unchanged) {
        out.snapshot = {
          replyRef: ref('r1', { ...deep(loc), messageId: 'public-output' }),
          text: excerpt(output, 2048),
          contentRevision: rev,
          textComplete: Buffer.byteLength(output, 'utf8') <= 2048,
        };
      }
    } else {
      let tail = `/api/v2/sessions/${session(loc)}/messages?limit=${count}`;
      if (q.has('cursor')) {
        tail += `&cursor=${encode(wireText(cursor(loc, q.get('cursor')!, 'replies'), 'position'))}`;
      }
      const page = await acs(token, loc, 'GET', tail, null, null, 'OBSERVE');
      if (session(loc) !== asText(page.sessionId)) fail('SOURCE_IDENTITY_CHANGED', 409);
      for (const row of asArr(page.items)) {
        const role = asText(asObj(row).role).toLowerCase();
        if (!['user', 'assistant'].includes(role)) continue;
        const content = asText(asObj(row).content, asText(asObj(row).contentPreview));
        items.push({
          replyRef: ref('r1', { ...deep(loc), messageId: wireText(asObj(row), 'id') }),
          role,
          text: excerpt(content, 2048),
          contentRevision: wireText(asObj(row), 'contentRevision'),
          textComplete: asText(asObj(row).contentState) === 'INLINE'
            && Buffer.byteLength(content, 'utf8') <= 2048,
        });
      }
      const rev = digest(items);
      const unchanged = rev === q.get('ifRevision');
      out.representation = 'MESSAGES';
      out.revision = rev;
      out.unchanged = unchanged;
      if (unchanged) items.length = 0;
      const before = asText(page.beforeCursor);
      if (asBool(page.hasOlder) && before !== '') {
        out.nextCursor = ref('p1', { ...deep(loc), operation: 'replies', position: before });
      } else {
        out.nextCursor = null;
      }
    }
    return out;
  };

  const content = async (token: string, loc: Obj, rref: string, value: string | undefined): Promise<JsonObject> => {
    const reply = decode(rref, 'r1');
    const target = deep(reply);
    delete target.messageId;
    if (JSON.stringify(target) !== JSON.stringify(loc)) fail('CURSOR_INVALID', 409);
    const mid = wireId(wireText(reply, 'messageId'));
    const cur = value === undefined ? null : cursor(loc, value, 'content');
    if (cur !== null && mid !== wireText(cur, 'messageId')) fail('CURSOR_INVALID', 409);
    const out: Obj = { replyRef: rref, coverage: isNative(loc) ? 'BOUNDED_PUBLIC_OUTPUT' : 'BOUNDED_HISTORY' };
    if (isNative(loc)) {
      if (mid !== 'public-output') fail('NOT_FOUND', 404);
      const output = await nativePublicOutput(token, loc);
      const rev = digestBytes(Buffer.from(output, 'utf8'));
      // Java cur.path("offset").asInt(-1): non-numeric or missing → -1.
      const offset = cur === null ? 0 : (typeof cur.offset === 'number' ? cur.offset : -1);
      if (cur !== null && rev !== wireText(cur, 'contentRevision')) fail('CONTENT_REVISION_CHANGED', 409);
      if (offset < 0 || offset > output.length
        || (offset > 0 && isLowSurrogate(output.charCodeAt(Math.min(offset, output.length - 1))))) {
        fail('CURSOR_INVALID', 409);
      }
      const segment = excerpt(output.substring(offset), 24000);
      const more = offset + segment.length < output.length;
      out.text = segment;
      out.contentRevision = rev;
      out.complete = !more;
      out.nextCursor = more
        ? ref('p1', { ...deep(loc), operation: 'content', messageId: mid, contentRevision: rev, offset: offset + segment.length })
        : null;
    } else {
      let path = `/api/v2/sessions/${session(loc)}/messages/${mid}/content`;
      if (cur !== null) path += `?cursor=${encode(wireText(cur, 'position'))}`;
      const page = await acs(token, loc, 'GET', path, null, null, 'OBSERVE');
      if (session(loc) !== asText(page.sessionId) || mid !== asText(page.messageId)) fail('SCOPE_DENIED', 403);
      const rev = wireText(page, 'contentRevision');
      if (cur !== null && rev !== wireText(cur, 'contentRevision')) fail('CONTENT_REVISION_CHANGED', 409);
      if (!['user', 'assistant'].includes(asText(page.role).toLowerCase())) fail('SCOPE_DENIED', 403);
      out.text = asText(page.text);
      out.contentRevision = rev;
      out.complete = asBool(page.complete);
      const next = asText(page.nextCursor);
      if (asBool(page.hasMore) && next !== '') {
        out.nextCursor = ref('p1', { ...deep(loc), operation: 'content', messageId: mid, contentRevision: rev, position: next });
      } else {
        out.nextCursor = null;
      }
    }
    if (Buffer.byteLength(JSON.stringify(out), 'utf8') > 131072) fail('SOURCE_RESPONSE_TOO_LARGE', 503);
    return out;
  };

  const handle = async (
    token: string, method: string, tail: string, body: unknown, key0: string | null, rawQuery: string | null,
  ): Promise<unknown> => {
    const d = await auth.authenticate(token);
    const q = query(rawQuery);
    let result: unknown;
    if (method === 'GET' && tail === '/manifest') {
      result = {
        protocolVersion: VERSION,
        storeId: store,
        bootId: boot,
        authBinding: 'PAC_DEVICE',
        authorizationRevision: String(d.revision),
        replyDelivery: 'POLL',
        features: { conversationCreate: false, replyContent: true },
        limits: { requestBytes: 65536, textBytes: 8192, replyPageBytes: 262144 },
      };
    } else if (method === 'GET' && tail === '/agents') {
      const n = obj();
      const items: Node[] = [];
      n.items = items;
      const seen = new Set<string>();
      for (const loc of await visible(token)) addAgent(items, seen, loc, null);
      if (nativeAccess !== undefined && (d.actions ?? []).includes('LAUNCH')) {
        for (const scope of (d.launchScopes ?? []) as LaunchScope[]) {
          const loc: Obj = { ...location('WORKER_NATIVE'), backendStoreId: scope.backendStoreId, engineId: scope.engineId };
          const aref = ref('a1', agent(loc));
          if (seen.has(aref)) continue;
          try {
            const options = await nativeAccess.remote(token, 'GET',
              `/personal/v1/local-tasks/${scope.backendStoreId}/options`, null, null, null);
            let registered = false;
            let readiness: string | null = null;
            for (const engine of asArr(asObj(options.body).engines)) {
              if (asText(asObj(engine).engineId) === scope.engineId) {
                registered = true;
                // Mac declares availability explicitly; a registered profile is not enough.
                if (scope.engineId === 'macos' && asText(asObj(engine).availability) !== 'AVAILABLE') {
                  const declared = asText(asObj(engine).reasonCode);
                  readiness = /^[A-Z][A-Z0-9_]{0,100}$/.test(declared) ? declared
                    : asText(asObj(engine).availability) === 'UNCONFIGURED'
                      ? 'SOURCE_NOT_CONFIGURED' : 'SOURCE_AVAILABILITY_UNKNOWN';
                }
              }
            }
            addAgent(items, seen, loc, registered ? readiness : 'SOURCE_NOT_CONFIGURED');
          } catch (denied) {
            if (denied instanceof GatewayError && (denied.httpStatus === 401 || denied.httpStatus === 403)) throw denied;
            addAgent(items, seen, loc, 'SOURCE_UNAVAILABLE');
          }
        }
      }
      result = n;
    } else if (method === 'POST' && tail === '/receipts/lookup') {
      result = await lookup(token, body);
    } else {
      const p = javaSplit(tail);
      if (p.length === 4 && p[1] === 'agents' && p[3] === 'conversations' && method === 'GET') {
        result = await directory(token, p[2], q);
      } else if (p.length >= 3 && p[1] === 'conversations') {
        const loc = decode(p[2], 'c1');
        validateConversation(loc);
        await authorize(token, loc, 'OBSERVE');
        if (p.length === 3 && method === 'GET') result = await view(token, loc);
        else if (p.length === 4 && method === 'POST' && ['messages', 'actions'].includes(p[3])) {
          result = await submit(token, loc, body, key0, p[3] === 'actions');
        } else if (p.length === 4 && p[3] === 'replies' && method === 'GET') {
          result = await replies(token, loc, q);
        } else if (p.length === 6 && p[3] === 'replies' && p[5] === 'content' && method === 'GET') {
          result = await content(token, loc, p[4], q.get('cursor'));
        } else {
          fail('NOT_FOUND', 404);
        }
        await authorize(token, loc, 'OBSERVE');
      } else {
        fail('NOT_FOUND', 404);
      }
    }
    if ((await auth.authenticate(token)).revision !== d.revision) fail('GRANT_REVISION_CHANGED', 409);
    if (Buffer.byteLength(JSON.stringify(result), 'utf8') > 262144) fail('SOURCE_RESPONSE_TOO_LARGE', 503);
    return result;
  };

  return { handle };
}

const isLowSurrogate = (c: number): boolean => c >= 0xdc00 && c <= 0xdfff;
