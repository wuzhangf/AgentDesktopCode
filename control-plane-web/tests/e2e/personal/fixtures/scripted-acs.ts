/**
 * Scripted ACS — 只模拟公开合同的本机 HTTP 服务（UI 项目的上游）。
 *
 * 目的：让真实浏览器 → 真实 Personal BFF → 真实 ServiceClient 的接线可测，
 * 同时把 ACS 的 HTTP 响应变成可编排材料。这里不实现调度/控制状态机：
 * 用例显式放入 RUNNING → PAUSED_FOR_HUMAN 的材料与 APPLIED 回执，夹具只负责
 * 「按键去重记录」「一次性故障」「屏障」和「脱敏请求事实」。
 *
 * 审计字段只保留 method / 路径模板 / 目标 ID / commandId / intent /
 * Idempotency-Key / 状态 / 回执 phase / 时点；不保存 Authorization、
 * client token、cookie 或任意请求头。
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';

export type CommandIntent = 'PAUSE' | 'RESUME' | 'STOP';

export interface SafeRequestFact {
  method: string;
  /** Path template, e.g. `/api/v2/runs/{run}/commands`. */
  path: string;
  targetId?: string;
  commandId?: string;
  intent?: string;
  /** PAUSE/RESUME must carry it; STOP must not. */
  expectedStateVersion?: number;
  idempotencyKey?: string;
  status?: number;
  phase?: string;
  forwarded: boolean;
  at: string;
}

export interface RequestMatch {
  method?: 'GET' | 'POST' | 'DELETE';
  path: RegExp;
}

export interface ScriptedFailure {
  status?: number;
  body?: unknown;
  /** Destroy the socket instead of replying (transport-level loss). */
  dropConnection?: boolean;
  /** Let the route commit its effect, then drop the reply (committed but unconfirmed). */
  dropAfterHandling?: boolean;
  /** How many matching requests this failure applies to (default 1). */
  times?: number;
}

export interface HeldExchange {
  /** Resolves once the request has entered the barrier. */
  readonly entered: Promise<void>;
  /** Resolve the barrier and let the request continue. */
  release(): void;
  /** Abort the request without a reply (used to model a cancelled forward). */
  cancel(): void;
  readonly released: boolean;
}

export interface ScriptedAcs {
  readonly baseUrl: string;
  readonly token: string;
  readonly storeId: string;
  readonly audit: readonly SafeRequestFact[];
  /** Mutate the run projection the consumer reads back. */
  setRun(runId: string, patch: Record<string, unknown>): void;
  /** Mutate the session foundation (identity / capabilities). */
  setFoundation(sessionId: string, patch: Record<string, unknown>): void;
  /** Put/replace a durable source receipt. */
  setCommand(commandId: string, receipt: Record<string, unknown>): void;
  /** Drop a receipt from the source command history. */
  removeCommand(commandId: string): void;
  /** Barrier: the next matching request waits until release/cancel. */
  holdNext(match: RequestMatch): HeldExchange;
  /** One-shot (or N-shot) failure for the next matching request. */
  failNext(match: RequestMatch, failure: ScriptedFailure): void;
  /** Drop every queued failure (used after asserting a degraded section). */
  clearFailures(): void;
  /** Drop every queued failure (used after asserting a degraded section). */
  clearFailures(): void;
  /** Business write counters (HTTP attempts accepted by the source), by endpoint family. */
  writes(): { sessions: number; messages: number; commands: number };
  /** Unique logical creations (one per Idempotency-Key), not HTTP attempts. */
  uniqueWrites(): { sessions: number; messages: number };
  /** Every HTTP attempt the source saw, counted at request entry (holds included). */
  attempts(): { sessions: number; messages: number };
  /** Unique accepted source command ids — never HTTP attempt counts. */
  acceptedCommands(): readonly string[];
  /** Command POST attempts observed by the source (including replays). */
  commandAttempts(): readonly {
    commandId: string; intent: string; accepted: boolean; expectedStateVersion?: number;
  }[];
  setProjects(projects: Record<string, unknown>[]): void;
  close(): Promise<void>;
}

interface Receipt extends Record<string, unknown> {
  commandId: string;
  intent: CommandIntent;
  phase: string;
  terminal: boolean;
  receiptRevision: string;
}

interface HoldEntry {
  match: RequestMatch;
  used: boolean;
  released: boolean;
  readonly entered: Promise<void>;
  readonly wait: Promise<'release' | 'cancel'>;
  markEntered(): void;
  release(): void;
  cancel(): void;
}

function createHold(match: RequestMatch): HoldEntry {
  let markEntered!: () => void;
  const entered = new Promise<void>((resolve) => { markEntered = resolve; });
  let decide!: (value: 'release' | 'cancel') => void;
  const wait = new Promise<'release' | 'cancel'>((resolve) => { decide = resolve; });
  const entry: HoldEntry = {
    match, used: false, released: false, entered, wait, markEntered,
    release() { if (entry.released) return; entry.released = true; decide('release'); },
    cancel() { if (entry.released) return; entry.released = true; decide('cancel'); },
  };
  return entry;
}

interface FailureEntry {
  match: RequestMatch;
  failure: ScriptedFailure;
  remaining: number;
}

const nowIso = () => new Date().toISOString();

function receiptOf(
  commandId: string,
  runId: string,
  intent: CommandIntent,
  phase: string,
  terminal: boolean,
  extra: Record<string, unknown> = {},
): Receipt {
  return {
    schemaVersion: 'run-command-receipt/1',
    commandId,
    receiptId: `receipt-${randomUUID()}`,
    sessionId: 'session-one',
    runId,
    intent,
    reasonCode: 'PERSONAL_TASK_CONTROL',
    phase,
    receiptRevision: '1',
    acceptedAt: nowIso(),
    actor: { principalId: 'personal-web-test', clientSessionId: 'client-session-test' },
    acceptedStateVersion: 5,
    observedStateVersion: 5,
    observedRunState: 'RUNNING',
    terminal,
    ...extra,
  } as Receipt;
}

function defaultRun(runId: string): Record<string, unknown> {
  return {
    runId,
    taskId: 'source-task',
    sessionId: 'session-one',
    state: 'RUNNING',
    sourceStatus: 'RUNNING',
    stateVersion: 5,
    controlState: 'NONE',
    checkpointAvailable: false,
    availableActions: ['PAUSE', 'STOP'],
    changedFileCount: 0,
    startedAt: '2026-10-19T00:00:00Z',
    summary: 'source summary',
  };
}

export async function startScriptedAcs(): Promise<ScriptedAcs> {
  const token = randomUUID();
  const storeId = 'store-one';
  const runs = new Map<string, Record<string, unknown>>([['run-one', defaultRun('run-one')]]);
  const foundations = new Map<string, Record<string, unknown>>();
  const commands = new Map<string, Receipt>();
  const order: string[] = [];
  const audit: SafeRequestFact[] = [];
  const holds: HoldEntry[] = [];
  const failures: FailureEntry[] = [];
  const sessionsByKey = new Map<string, Record<string, unknown>>();
  const messageSessions = new Map<string,string>(), messageContents = new Map<string,string>();
  const messagesByKey = new Map<string, Record<string, unknown>>();
  const accepted: string[] = [];
  const attempts: { commandId: string; intent: string; accepted: boolean; expectedStateVersion?: number }[] = [];
  let sessions = 0;
  let messages = 0;
  let sessionAttempts = 0;
  let messageAttempts = 0;
  let commandWrites = 0;
  let projects: Record<string, unknown>[] = [
    {
      projectId: 'source-one',
      workspaceAlias: 'sample',
      displayName: '示例项目',
      branchDisplay: 'main',
      headShortRevision: 'head1',
      authorityStatus: 'AUTHORITATIVE',
    },
  ];

  const record = (fact: Omit<SafeRequestFact, 'at' | 'forwarded'> & { forwarded?: boolean }) => {
    const entry: SafeRequestFact = { forwarded: true, ...fact, at: nowIso() };
    audit.push(entry);
    return entry;
  };

  const dropAfter = new WeakSet<ServerResponse>();
  const json = (res: ServerResponse, status: number, body: unknown) => {
    if (dropAfter.has(res)) {
      // 效果已提交，但浏览器/上游拿不到回复。
      dropAfter.delete(res);
      res.destroy();
      return;
    }
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const problem = (res: ServerResponse, status: number, code: string, message: string) =>
    json(res, status, { code, message, status });

  const matchOf = (match: RequestMatch, method: string, pathname: string) =>
    (!match.method || match.method === method) && match.path.test(pathname);

  const takeFailure = (method: string, pathname: string): FailureEntry | undefined => {
    const entry = failures.find((f) => f.remaining > 0 && matchOf(f.match, method, pathname));
    if (entry) entry.remaining -= 1;
    return entry;
  };

  const takeHold = (method: string, pathname: string): HoldEntry | undefined => {
    const entry = holds.find((h) => !h.used && matchOf(h.match, method, pathname));
    if (entry) entry.used = true;
    return entry;
  };

  const server: Server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const pathname = url.pathname;
    const method = req.method ?? 'GET';
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk as Buffer));
    const text = Buffer.concat(chunks).toString('utf8');
    let body: Record<string, unknown> = {};
    if (text) { try { body = JSON.parse(text) as Record<string, unknown>; } catch { body = {}; } }
    const key = typeof req.headers['idempotency-key'] === 'string' ? req.headers['idempotency-key'] : undefined;

    if (!/^Bearer \S+/.test(String(req.headers.authorization ?? ''))) {
      record({ method, path: pathname, status: 401 });
      problem(res, 401, 'UNAUTHORIZED', 'bearer required');
      return;
    }

    // 入口计数：屏障/故障之前的真实 HTTP 尝试（业务写入在 handler 内另行计数）。
    if (method === 'POST' && pathname === '/api/v2/sessions') sessionAttempts += 1;
    if (method === 'POST' && /^\/api\/v2\/sessions\/[^/]+\/messages$/.test(pathname)) messageAttempts += 1;

    // ---- barrier / one-shot failure (they gate the real handler) ----
    const failure = takeFailure(method, pathname);
    if (failure) {
      if (failure.failure.dropConnection) {
        record({ method, path: pathname, status: 0, idempotencyKey: key });
        res.destroy(); return;
      }
      if (!failure.failure.dropAfterHandling) {
        record({ method, path: pathname, status: failure.failure.status ?? 503, idempotencyKey: key });
        const status = failure.failure.status ?? 503;
        json(res, status, failure.failure.body ?? { code: 'SCRIPTED_FAILURE', message: 'scripted source failure', status });
        return;
      }
      // Committed-but-unconfirmed: run the real handler, drop the reply.
      dropAfter.add(res);
    }
    const hold = takeHold(method, pathname);
    if (hold) {
      record({ method, path: pathname, idempotencyKey: key });
      hold.markEntered();
      // A hold must never silently pass on timeout: an unreleased barrier is a
      // test failure, and the socket is dropped so teardown cannot hang.
      const timer = setTimeout(() => hold.cancel(), 120_000);
      const outcome = await hold.wait;
      clearTimeout(timer);
      if (outcome === 'cancel') { res.destroy(); return; }
    }

    const runMatch = pathname.match(/^\/api\/v2\/runs\/([^/]+)$/);
    const commandsMatch = pathname.match(/^\/api\/v2\/runs\/([^/]+)\/commands$/);
    const commandMatch = pathname.match(/^\/api\/v2\/runs\/([^/]+)\/commands\/([^/]+)$/);
    const activitiesMatch = pathname.match(/^\/api\/v2\/runs\/([^/]+)\/activities$/);
    const outputMatch = pathname.match(/^\/api\/v2\/runs\/([^/]+)\/output$/);
    const sessionMatch = pathname.match(/^\/api\/v2\/sessions\/([^/]+)$/);
    const messagesMatch = pathname.match(/^\/api\/v2\/sessions\/([^/]+)\/messages$/);
    const foundationMatch = pathname.match(/^\/api\/v2\/sessions\/([^/]+)\/foundation$/);
    const projectMatch = pathname.match(/^\/api\/v2\/projects\/([^/]+)$/);
    const preflightMatch = pathname.match(/^\/api\/v2\/projects\/([^/]+)\/session-preflight$/);

    // ---- identity lifecycle ----
    if (pathname === '/api/v2/client-sessions' && method === 'POST') {
      record({ method, path: '/api/v2/client-sessions', idempotencyKey: key, status: 200 });
      json(res, 200, {
        clientSessionId: 'client-session-test',
        // ServiceClient 要求 clientSessionToken 至少 32 字符。
        clientSessionToken: `client-session-token-${randomUUID()}`,
        storeId,
        bootId: 'boot-one',
        ttlMillis: 60_000,
        remainingTtlMillis: 60_000,
        acceptedProtocols: ['v2'],
      });
      return;
    }
    if (/^\/api\/v2\/client-sessions\/[^/]+\/heartbeat$/.test(pathname) && method === 'POST') {
      record({ method, path: '/api/v2/client-sessions/{id}/heartbeat', status: 200 });
      json(res, 200, { clientSessionId: 'client-session-test', ttlMillis: 60_000, remainingTtlMillis: 60_000 });
      return;
    }
    if (/^\/api\/v2\/client-sessions\/[^/]+$/.test(pathname) && method === 'DELETE') {
      record({ method, path: '/api/v2/client-sessions/{id}', status: 204 });
      res.writeHead(204); res.end(); return;
    }

    // ---- discovery ----
    if (pathname === '/api/v2/capabilities') {
      record({ method, path: pathname, status: 200 });
      json(res, 200, {
        serviceInstanceId: 'service-one',
        protocolVersion: '2',
        features: { sessionV2: true, durableEvents: true, visibleOutputStream: true, worktreeExecution: true, mission: false, mcpHost: false, servicePty: false },
        limits: { maxDiffBytes: 1_000_000, maxEventPage: 200, maxVisibleDeltaChars: 200_000 },
        operations: [{ id: 'unrelated.optional', availability: 'BLOCKED', contractVersion: '1', limits: {} }],
      });
      return;
    }
    if (pathname === '/api/v2/projects' && method === 'GET') {
      record({ method, path: pathname, status: 200 });
      json(res, 200, projects); return;
    }
    if (projectMatch && method === 'GET') {
      const projectId = decodeURIComponent(projectMatch[1]!);
      const project = projects.find((p) => p.projectId === projectId);
      record({ method, path: '/api/v2/projects/{project}', targetId: projectId, status: project ? 200 : 404 });
      if (!project) { problem(res, 404, 'PROJECT_NOT_FOUND', 'unknown project'); return; }
      json(res, 200, project); return;
    }
    if (preflightMatch) {
      record({ method, path: '/api/v2/projects/{project}/session-preflight', targetId: decodeURIComponent(preflightMatch[1]!), status: 200 });
      json(res, 200, {
        projectId: 'source-one',
        workspaceAlias: 'sample',
        headRevision: 'head-one',
        revision: 'rev-one',
        policyFingerprint: 'policy-one',
        workspaceFingerprint: 'workspace-one',
        authorityStatus: 'AUTHORITATIVE',
        allowedIntents: ['CODE'],
        suggestedWriteScope: [],
        writeScopeCeiling: ['.'],
        modelAlias: 'fixture-model',
        modelAvailability: 'AVAILABLE',
      });
      return;
    }
    if (pathname === '/api/v2/agent-profiles') {
      record({ method, path: pathname, status: 200 });
      json(res, 200, { profiles: [{ id: 'code-profile', name: '代码 Agent', revision: 'profile-1' }], loadErrors: [] });
      return;
    }
    if (pathname === '/api/v2/model-catalog') {
      record({ method, path: pathname, status: 200 });
      json(res, 200, {
        defaultModel: 'fixture-model',
        items: [
          { providerId: 'fixture', modelAlias: 'fixture-model', availability: 'AVAILABLE', configured: true },
          { providerId: 'fixture', modelAlias: 'unavailable-model', availability: 'UNAVAILABLE', configured: true },
        ],
      });
      return;
    }

    // ---- session creation / messages ----
    if (pathname === '/api/v2/sessions' && method === 'POST') {
      sessions += 1;
      const existing = key ? sessionsByKey.get(key) : undefined;
      if (!existing) {
        const created = { sessionId: sessionsByKey.size===0?'session-one':`session-${sessionsByKey.size+1}`, sessionVersion: 1, agentProfileId: 'code-profile', agentProfileName: '代码 Agent', modelSettings: { providerId: 'fixture', modelAlias: 'fixture-model' }, workspaceBinding: { mode: 'ISOLATED_WORKTREE', workspaceRef: 'ws-one', baseRevision: 'head-one' } };
        if (key) sessionsByKey.set(key, created);
        record({ method, path: '/api/v2/sessions', idempotencyKey: key, status: 201 });
        json(res, 201, created); return;
      }
      record({ method, path: '/api/v2/sessions', idempotencyKey: key, status: 200 });
      json(res, 200, existing); return;
    }
    if (messagesMatch && method === 'POST') {
      messages += 1;
      const existing = key ? messagesByKey.get(key) : undefined;
      if (!existing) {
        // 每个消息一个独立 Run：多任务用例不会共用同一运行投影。
        const runId = messages === 1 ? 'run-one' : `run-${messages}`;
        if (!runs.has(runId)) runs.set(runId, {...defaultRun(runId),sessionId:decodeURIComponent(messagesMatch[1]!)});
        const created = {
          messageId: `message-${messages}`,
          clientMessageId: String(body.clientMessageId ?? ''),
          taskId: 'source-task',
          runId,
          sessionVersion: 2,
          status: 'ACCEPTED',
        };
        if (key) {messagesByKey.set(key, created);messageSessions.set(key,decodeURIComponent(messagesMatch[1]!));messageContents.set(key,String(body.content??''));}
        record({ method, path: '/api/v2/sessions/{id}/messages', idempotencyKey: key, status: 202 });
        json(res, 202, created); return;
      }
      record({ method, path: '/api/v2/sessions/{id}/messages', idempotencyKey: key, status: 200 });
      json(res, 200, existing); return;
    }
    if (messagesMatch && method === 'GET') {
      record({ method, path: '/api/v2/sessions/{id}/messages', status: 200 });
      const items=[...messagesByKey.entries()].filter(([k])=>messageSessions.get(k)===decodeURIComponent(messagesMatch[1]!)).map(([k,m],i)=>({id:m.messageId,clientMessageId:m.clientMessageId,runId:m.runId,role:'user',status:'ACCEPTED',content:messageContents.get(k),contentState:'INLINE',contentRevision:'1',contentBytes:0,createdAt:i+1,updatedAt:i+1}));
      json(res, 200, {schemaVersion:'session-message-page/1',sessionId:decodeURIComponent(messagesMatch[1]!),transcriptRevision:'1',items,beforeCursor:null,afterCursor:null,hasOlder:false,hasNewer:false,rangeComplete:true});
      return;
    }
    if (sessionMatch && method === 'GET') {
      record({ method, path: '/api/v2/sessions/{id}', targetId: sessionMatch[1]!, status: 200 });
      json(res, 200, {
        sessionId: sessionMatch[1],
        sessionVersion: 2,
        activeRunId: [...messagesByKey.entries()].filter(([k,m])=>messageSessions.get(k)===decodeURIComponent(sessionMatch[1]!)&&!['COMPLETED','FAILED','CANCELLED'].includes(String(runs.get(String(m.runId))?.state))).at(-1)?.[1].runId??null,
        agentProfileId: 'code-profile',
        agentProfileName: '代码 Agent',
        agentProfileRevision: 'profile-1',
        modelSettings: { providerId: 'fixture', modelAlias: 'fixture-model' },
        workspaceBinding: { mode: 'ISOLATED_WORKTREE', workspaceRef: 'ws-one', baseRevision: 'head-one' },
        messages: [],
      });
      return;
    }
    if (foundationMatch) {
      const sessionId = decodeURIComponent(foundationMatch[1]!);
      const base = {
        schemaVersion: 'session-foundation/1',
        storeId,
        sessionId,
        sessionVersion: '2',
        executionOwnership: 'HOST_SESSION',
        capabilities: { commandReceiptV1: 'READY' },
      };
      record({ method, path: '/api/v2/sessions/{id}/foundation', targetId: sessionId, status: 200 });
      json(res, 200, { ...base, ...(foundations.get(sessionId) ?? {}) });
      return;
    }

    // ---- run projection ----
    if (runMatch && method === 'GET') {
      const runId = decodeURIComponent(runMatch[1]!);
      const run = runs.get(runId);
      record({ method, path: '/api/v2/runs/{run}', targetId: runId, status: run ? 200 : 404 });
      if (!run) { problem(res, 404, 'RUN_NOT_FOUND', 'unknown run'); return; }
      json(res, 200, run); return;
    }
    if (activitiesMatch && method === 'GET') {
      const runId = decodeURIComponent(activitiesMatch[1]!);
      record({ method, path: '/api/v2/runs/{run}/activities', targetId: runId, status: 200 });
      json(res, 200, {
        runId,
        runStateVersion: Number(runs.get(runId)?.stateVersion ?? 1),
        snapshotCursor: 3,
        complete: true,
        items: [{
          activityId: 'activity-one',
          runId,
          kind: 'FILE_WRITE',
          status: 'SUCCEEDED',
          detail: 'x.txt v1 → v2',
          toolName: 'workspace_edit',
          startCursor: 1,
          endCursor: 2,
          resultSummary: 'SUCCEEDED',
        }],
        summary: { completeness: 'TERMINAL_EXACT', activityCount: 1, succeededCount: 1 },
      });
      return;
    }
    if (outputMatch && method === 'GET') {
      const runId = decodeURIComponent(outputMatch[1]!);
      record({ method, path: '/api/v2/runs/{run}/output', targetId: runId, status: 200 });
      json(res, 200, {
        runId,
        runStateVersion: Number(runs.get(runId)?.stateVersion ?? 1),
        snapshotCursor: 4,
        text: 'protocol output: x.txt changed v1 -> v2',
        receivedBytes: 42,
        totalBytes: 42,
        droppedChunks: 0,
        lastSequence: 4,
        terminal: true,
        complete: true,
        truncated: false,
      });
      return;
    }

    // ---- reliable run commands ----
    if (commandsMatch && method === 'GET') {
      const runId = decodeURIComponent(commandsMatch[1]!);
      const limit = Number(url.searchParams.get('limit') ?? 20);
      const before = url.searchParams.get('before');
      record({ method, path: '/api/v2/runs/{run}/commands', targetId: runId, status: 200 });
      const newestFirst = [...order].filter(id=>commands.get(id)?.runId===runId).reverse();
      const start = before ? newestFirst.findIndex((id) => id === before) + 1 : 0;
      const slice = newestFirst.slice(start, start + limit);
      const hasMore = newestFirst.length > start + limit;
      json(res, 200, {
        items: slice.map((id) => commands.get(id)!).filter(Boolean),
        ...(hasMore && slice.length ? { nextBefore: slice[slice.length - 1] } : {}),
      });
      return;
    }
    if (commandMatch && method === 'GET') {
      const runId = decodeURIComponent(commandMatch[1]!);
      const commandId = decodeURIComponent(commandMatch[2]!);
      const observed = commands.get(commandId);
      const receipt = observed?.runId===runId?observed:undefined;
      record({ method, path: '/api/v2/runs/{run}/commands/{command}', targetId: runId, commandId, status: receipt ? 200 : 404, phase: receipt?.phase });
      if (!receipt) { problem(res, 404, 'CONTROL_NOT_FOUND', 'unknown command'); return; }
      json(res, 200, receipt); return;
    }
    if (commandsMatch && method === 'POST') {
      const runId = decodeURIComponent(commandsMatch[1]!);
      const commandId = String(body.commandId ?? key ?? '');
      const intent = String(body.intent ?? '') as CommandIntent;
      const existing = commands.get(commandId);
      commandWrites += 1;
      attempts.push({
        commandId, intent, accepted: !existing,
        expectedStateVersion: typeof body.expectedStateVersion === 'number' ? body.expectedStateVersion : undefined,
      });
      if (existing) {
        record({ method, path: '/api/v2/runs/{run}/commands', targetId: runId, commandId, intent, expectedStateVersion: typeof body.expectedStateVersion === 'number' ? body.expectedStateVersion : undefined, idempotencyKey: key, status: 200, phase: existing.phase });
        json(res, 200, existing); return;
      }
      const receipt = receiptOf(commandId, runId, intent, 'REQUESTED', false, {
        sessionId: runs.get(runId)?.sessionId ?? 'session-one',
        expectedStateVersion: body.expectedStateVersion,
        observedRunState: String(runs.get(runId)?.state ?? 'RUNNING'),
      });
      commands.set(commandId, receipt);
      order.push(commandId);
      accepted.push(commandId);
      record({ method, path: '/api/v2/runs/{run}/commands', targetId: runId, commandId, intent, expectedStateVersion: typeof body.expectedStateVersion === 'number' ? body.expectedStateVersion : undefined, idempotencyKey: key, status: 202, phase: 'REQUESTED' });
      json(res, 202, receipt);
      return;
    }

    record({ method, path: pathname, status: 404 });
    problem(res, 404, 'SCRIPTED_ACS_UNMATCHED', `unmatched ACS route ${method} ${pathname}`);
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  const baseUrl = `http://127.0.0.1:${address.port}`;

  return {
    baseUrl,
    token,
    storeId,
    get audit() { return audit; },
    setRun(runId, patch) {
      const current = runs.get(runId) ?? defaultRun(runId);
      runs.set(runId, { ...current, ...patch });
    },
    setFoundation(sessionId, patch) {
      foundations.set(sessionId, { ...(foundations.get(sessionId) ?? {}), ...patch });
    },
    setCommand(commandId, receipt) {
      const next = { ...receipt, commandId } as Receipt;
      if (!commands.has(commandId)) order.push(commandId);
      commands.set(commandId, next);
    },
    removeCommand(commandId) {
      commands.delete(commandId);
      const index = order.indexOf(commandId);
      if (index >= 0) order.splice(index, 1);
    },
    holdNext(match) {
      const entry = createHold(match);
      holds.push(entry);
      const handle: HeldExchange = {
        entered: entry.entered,
        get released() { return entry.released; },
        release: () => entry.release(),
        cancel: () => entry.cancel(),
      };
      return handle;
    },
    failNext(match, failure) {
      failures.push({ match, failure, remaining: failure.times ?? 1 });
    },
    clearFailures() { failures.length = 0; },
    writes: () => ({ sessions, messages, commands: commandWrites }),
    uniqueWrites: () => ({ sessions: sessionsByKey.size, messages: messagesByKey.size }),
    attempts: () => ({ sessions: sessionAttempts, messages: messageAttempts }),
    acceptedCommands: () => accepted,
    commandAttempts: () => attempts,
    setProjects(next) { projects = next; },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
