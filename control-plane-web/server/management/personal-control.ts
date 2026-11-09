import {deviceScopeFields} from './device-scope';
/**
 * Personal management gateway server (PAE task §8; freeze §4 + §5.1
 * addendum; design §10.2).
 *
 * `createPersonalGateway` mirrors `worker-control.ts`: loopback Host
 * allow-list, a same-origin custom header + Origin/sec-fetch-site guard on
 * every API call, a bounded cookie+tab session map (8 tabs, 20 min TTL, 30 s
 * sweep revoking upstream client sessions), ≤1 MiB JSON bodies and the
 * frozen `{error:{code,message,retryable,requestId}}` failure shape.
 *
 * The route table is exactly the frozen `/api/personal/v1` surface (19 routes
 * plus the §5.1 `inputs` continuation). It is a third channel beside
 * read-only `/api/v2` and the `/api/worker` lab BFF — never a wildcard proxy:
 * only registered ids and non-secret version selections cross the boundary.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import {
  PERSONAL_API_PREFIX,
  PERSONAL_ID_PATTERN,
} from '../../../codeagent-desktop/packages/protocol/src/personal';
import { ServiceProblem } from '../../../codeagent-desktop/packages/service-client/src/index';
import { ManagementError, invalid, toPersonalError } from './errors';
import type { ManagementMigration } from './migrations';
import { ManagementStore } from './registry-store';
import {
  ConnectionHub,
  envSecretResolver,
  type AcsSessionHandle,
  type ConnectionProvision,
  type EnvProblem,
  type SecretResolver,
} from './upstream';
import {
  PersonalManagementService,
  type AdaptiveActionRunner,
  type GatewayCallContext,
  type PersonalReportProvider,
} from './service';
import { TaskMetricsReader } from './task-metrics';
import { PersonalTasks } from './tasks';
import { createReportsRouter } from './reports/index.mjs';
import { REPORTS_MIGRATIONS, createSqliteReportsRepository } from './reports-sqlite';

const ID = PERSONAL_ID_PATTERN;
const COOKIE = 'personal_control';
const TTL = 20 * 60_000;
const MAX_SESSIONS = 64;
const BODY_LIMIT = 1024 * 1024;

export interface PersonalGatewayOptions {
  /** Directory holding `management.db` (created when absent). */
  dataDir: string;
  observationSourceId?: string;
  observationScopeId?: string;
  /** Install-side provisioned connections; the browser never sends these. */
  connections: readonly ConnectionProvision[];
  /** Credential-ref resolver (env indirection fed by the central helper). */
  secretResolver?: SecretResolver;
  /** dist/ directory for same-origin static serving (optional). */
  dist?: string;
  /** P7 report tables / other extra migrations. */
  extraMigrations?: readonly ManagementMigration[];
  /**
   * PAE P8 mount: real P7 reports wiring. When present, the `p7-reports`
   * migration (v100, from reports/ddl.sql) is merged into the store's
   * migration set and `createReportsRouter` is mounted on the request
   * dispatch for `/api/personal/v1/reports*` — the router self-matches only
   * those paths and returns undefined otherwise, so the P5 route table
   * remains the fallback (provider-not-configured surface when this option
   * is absent).
   */
  reports?: PersonalReportsMount;
  /** P7 seam: report provider; unconfigured until registered. */
  reportProvider?: PersonalReportProvider;
  /** P1/P3 seam: adaptive-action executor; absent → ACTION_RUN reports OFF. */
  actionRunner?: AdaptiveActionRunner;
  /** Inject for tests. */
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

/** P8 mount deps for the P7 reports submodule (createReportsRouter). */
export interface PersonalReportsMount {
  /** Install-local report output root (P7 store.mjs atomic writes). */
  outputDir: string;
  /** Registered CSV/JSON data-source directory for `data:` refs (optional). */
  dataDir?: string;
  /** ReportSourceGateway for project:/delivery:/run:/session: refs — e.g.
   * `createServiceClientGateway(serviceClient)`; absent → those schemes
   * report REPORT_SOURCE_UNAVAILABLE honestly (never fabricated). */
  upstreamGateway?: unknown;
  /** Extra declared providers `{ref: impl|null}`; `local` is built in.
   * `null` = declared but not configured (surfaced, never faked). */
  providers?: Record<string, unknown>;
}

export interface PersonalGateway {
  server: Server;
  handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void>;
  store: ManagementStore;
  hub: ConnectionHub;
  service: PersonalManagementService;
  controlPlaneId: string;
  instanceId: string;
  /** Mounted P7 reports router (present only when options.reports was given);
   * exposed for diagnostics/awaited reconcile — `handle` self-limits to the
   * reports* paths. */
  reports: ReturnType<typeof createReportsRouter> | undefined;
  /** P7 registers its provider post-construction. */
  setReportProvider(provider: PersonalReportProvider | undefined): void;
  setActionRunner(runner: AdaptiveActionRunner | undefined): void;
  /** Register a task row server-side (task organization is install-owned). */
  registerTask(input: { taskId?: string; projectId?: string; displayName?: string }): string;
  close(): Promise<void>;
}

interface BrowserSession {
  cookieId: string;
  tab: string;
  createdAt: number;
  seen: number;
  /** Upstream client sessions keyed by connectionId; tokens stay here. */
  upstream: Map<string, AcsSessionHandle>;
  pending: Map<string, Promise<AcsSessionHandle>>;
}

type Params = Record<string, string>;
type Handler = (params: Params, query: URLSearchParams, body: unknown,
    ctx: GatewayCallContext) => Promise<{ status: number; body: unknown }>;

interface Route {
  method: 'GET' | 'POST';
  segments: string[];
  handler: Handler;
}

/** `:id` path params and the `:action:run` suffix form from the frozen table. */
function matchSegments(pattern: string[], parts: string[]): Params | null {
  if (pattern.length !== parts.length) return null;
  const params: Params = {};
  for (let i = 0; i < pattern.length; i++) {
    const seg = pattern[i]!;
    let part: string;
    try { part = decodeURIComponent(parts[i]!); }
    catch { return null; }
    if (!seg.startsWith(':')) {
      if (seg !== part) return null;
      continue;
    }
    const inner = seg.indexOf(':', 1);
    let name = seg;
    let suffix = '';
    if (inner > 0) { name = seg.slice(0, inner); suffix = seg.slice(inner); }
    let value = part;
    if (suffix) {
      if (!part.endsWith(suffix)) return null;
      value = part.slice(0, part.length - suffix.length);
    }
    const id = name.slice(1);
    if (!ID.test(value)) return null;
    params[id] = value;
  }
  return params;
}

export function createPersonalGateway(options: PersonalGatewayOptions): PersonalGateway {
  const store = new ManagementStore({
    path: resolve(options.dataDir, 'management.db'),
    // P8: a mounted reports surface registers the P7 ddl.sql migration in the
    // p7-reports namespace (v100+) alongside any caller-supplied extras.
    extraMigrations: options.reports
      ? [...(options.extraMigrations ?? []), ...REPORTS_MIGRATIONS]
      : options.extraMigrations,
    now: options.now,
  });
  const hub = new ConnectionHub(store, options.secretResolver ?? envSecretResolver, options.fetchImpl);
  hub.provision(options.connections);
  const instanceId = randomUUID(); // process boot identity; controlPlaneId stays stable
  const service = new PersonalManagementService({
    store, hub,
    instanceId,
    reportProvider: options.reportProvider,
    actionRunner: options.actionRunner,
    now: options.now,
  });
  const browsers = new Map<string, BrowserSession>();

  // P8 mount: real P7 reports router over the management.db repository.
  // Reconcile once at mount (restart recovery); handle() also reconciles
  // lazily on first reports traffic if this is removed.
  const reports = options.reports
    ? createReportsRouter({
        repository: createSqliteReportsRepository(store.db),
        outputDir: resolve(options.reports.outputDir),
        dataDir: options.reports.dataDir ? resolve(options.reports.dataDir) : null,
        upstreamGateway: options.reports.upstreamGateway ?? null,
        providers: options.reports.providers ?? {},
        controlPlaneId: store.controlPlaneId,
        instance: instanceId,
        now: () => (options.now ?? (() => new Date()))().getTime(),
      })
    : undefined;
  if (reports) void reports.reconcile().catch(() => { /* recovery failure must not abort boot */ });
  // Advertising consistency: with the router mounted, REPORT_CREATE is really
  // available — mirror it through the P5 provider seam so meta.supportedActions
  // on non-reports routes (overview etc.) tells the truth too. 404s map to the
  // seam's undefined; the router still owns the HTTP dispatch.
  if (reports) {
    service.setReportProvider({
      listReports: () => reports.service.listReports({ limit: 500 }),
      createReport: (request) => reports.service.createReport(request),
      getReport: (reportId) => reports.service.getReport(reportId).catch(() => undefined),
      listReportFiles: (reportId) => reports.service.listReportFiles(reportId),
    });
  }

  const metrics = new TaskMetricsReader(options.observationSourceId, options.observationScopeId);
  const tasks = new PersonalTasks(store, hub, instanceId, metrics);
  const ROUTES: Route[] = [
    { method: 'GET', segments: ['tasks', ':task', 'metrics'], handler: (p,q,_b,ctx) => tasks.taskMetrics(p.task!,ctx,q) },
    { method: 'GET', segments: ['projects', 'available'], handler: (_p,_q,_b,ctx) => tasks.available(ctx) },
    { method: 'GET', segments: ['projects', ':project', 'task-options'], handler: (p,_q,_b,ctx) => tasks.options(p.project!,ctx) },
    { method: 'POST', segments: ['tasks'], handler: (_p,_q,b,ctx) => tasks.create(b,ctx) },
    { method: 'GET', segments: ['tasks'], handler: async (_p,q) => tasks.list(q) },
    { method: 'GET', segments: ['tasks', 'requests', ':requestKey'], handler: async p => tasks.request(p.requestKey!) },
    { method: 'GET', segments: ['tasks', ':task'], handler: (p,q,_b,ctx) => tasks.detail(p.task!,ctx,q) },
    { method: 'GET', segments: ['tasks', ':task', 'activities'], handler: (p,q,_b,ctx) => tasks.leaf(p.task!,'activities',ctx,q) },
    { method: 'GET', segments: ['tasks', ':task', 'output'], handler: (p,_q,_b,ctx) => tasks.leaf(p.task!,'output',ctx,_q) },
    { method: 'GET', segments: ['tasks', ':task', 'messages'], handler: (p,q,_b,ctx) => tasks.messages(p.task!,q,ctx) },
    {method:'GET',segments:['tasks',':task','collaboration'],handler:(p,q,_b,ctx)=>tasks.collaboration.read(p.task!,[],q,ctx)},
    {method:'GET',segments:['tasks',':task','collaboration','activity'],handler:(p,q,_b,ctx)=>tasks.collaboration.read(p.task!,['activity'],q,ctx)},
    {method:'GET',segments:['tasks',':task','collaboration','groups',':group'],handler:(p,q,_b,ctx)=>tasks.collaboration.read(p.task!,['groups',p.group!],q,ctx)},
    {method:'GET',segments:['tasks',':task','collaboration','groups',':group','executions'],handler:(p,q,_b,ctx)=>tasks.collaboration.read(p.task!,['groups',p.group!,'executions'],q,ctx)},
    {method:'GET',segments:['tasks',':task','collaboration','groups',':group','executions',':entity','messages'],handler:(p,q,_b,ctx)=>tasks.collaboration.read(p.task!,['groups',p.group!,'executions',p.entity!,'messages'],q,ctx)},
    {method:'GET',segments:['tasks',':task','collaboration','groups',':group','adoptions'],handler:(p,q,_b,ctx)=>tasks.collaboration.read(p.task!,['groups',p.group!,'adoptions'],q,ctx)},
    {method:'GET',segments:['tasks',':task','collaboration','resources',':kind',':entity'],handler:(p,q,_b,ctx)=>tasks.collaboration.read(p.task!,['resources',p.kind!,p.entity!],q,ctx)},
    {method:'GET',segments:['tasks',':task','collaboration','files'],handler:(p,q,_b,ctx)=>tasks.collaboration.read(p.task!,['files'],q,ctx)},
    {method:'POST',segments:['tasks',':task','collaboration','operations'],handler:(p,_q,b,ctx)=>tasks.collaboration.create(p.task!,b,ctx)},
    {method:'GET',segments:['tasks',':task','collaboration','requests',':requestKey'],handler:(p,_q,_b,ctx)=>tasks.collaboration.request(p.task!,p.requestKey!,ctx)},
    { method: 'POST', segments: ['tasks', ':task', 'messages'], handler: (p,_q,b,ctx) => tasks.native.is(p.task!) ? tasks.native.input(p.task!,b) : tasks.interactions.create(p.task!,b,ctx) },
    { method: 'GET', segments: ['tasks', ':task', 'interaction-requests', ':requestKey'], handler: (p,_q,_b,ctx) => tasks.native.is(p.task!) ? tasks.native.request(p.task!,p.requestKey!) : store.ledgerGet(p.requestKey!)?.route === 'TASK_ENGAGEMENT_CREATE' ? tasks.engagements.request(p.task!,p.requestKey!,ctx) : tasks.interactions.request(p.task!,p.requestKey!,ctx) },
    {method:'GET',segments:['projects',':project','native-tasks'],handler:p=>tasks.native.sourceTasks(p.project!)},
    {method:'POST',segments:['projects',':project','native-task-adoptions'],handler:(p,_q,b)=>tasks.native.adopt(p.project!,b)},
    {method:'GET',segments:['tasks',':task','graphics','observations'],handler:p=>tasks.native.graphicsObservations(p.task!)},
    {method:'GET',segments:['tasks',':task','graphics','requests',':requestKey'],handler:p=>tasks.native.graphicsRequest(p.task!,p.requestKey!)},
    ...(['observe','capture','actions'] as const).map(route=>({method:'POST' as const,segments:['tasks',':task','graphics',route],handler:(p:Record<string,string>,_q:URLSearchParams,b:unknown)=>tasks.native.graphics(p.task!,route,b)})),
    {method:'GET',segments:['tasks',':task','input-requests'],handler:(p,q)=>tasks.native.read(p.task!,'input-requests',q)},
    {method:'POST',segments:['tasks',':task','input-requests',':entity','responses'],handler:(p,_q,b)=>(b as {inputRequestId?:string})?.inputRequestId===p.entity?tasks.native.input(p.task!,b):invalid()},
    {method:'GET',segments:['tasks',':task','artifacts'],handler:(p,q)=>tasks.native.read(p.task!,'artifacts',q)},
    {method:'GET',segments:['tasks',':task','artifacts',':entity'],handler:p=>tasks.native.artifact(p.task!,p.entity!)},
    {method:'GET',segments:['tasks',':task','interactions'],handler:(p,q,_b,ctx)=>tasks.engagements.read(p.task!,q,ctx)},
    {method:'GET',segments:['tasks',':task','interaction-catalog'],handler:(p,_q,_b,ctx)=>tasks.engagements.catalog(p.task!,ctx)},
    {method:'GET',segments:['tasks',':task','approvals'],handler:(p,q,_b,ctx)=>tasks.engagements.approvals(p.task!,q,ctx)},
    {method:'GET',segments:['tasks',':task','approvals',':approval'],handler:(p,q,_b,ctx)=>tasks.engagements.approvals(p.task!,q,ctx,p.approval!)},
    {method:'POST',segments:['tasks',':task','boundary-requests'],handler:(p,_q,b,ctx)=>(b as {kind?:string} | undefined)?.kind === 'BOUNDARY' ? tasks.engagements.create(p.task!,b,ctx) : invalid()},
    {method:'POST',segments:['tasks',':task','side-questions'],handler:(p,_q,b,ctx)=>(b as {kind?:string} | undefined)?.kind === 'SIDE_QUESTION' ? tasks.engagements.create(p.task!,b,ctx) : invalid()},
    {method:'POST',segments:['tasks',':task','handoffs','preflight'],handler:(p,_q,b,ctx)=>(b as {kind?:string} | undefined)?.kind === 'PREFLIGHT' ? tasks.engagements.create(p.task!,b,ctx) : invalid()},
    {method:'POST',segments:['tasks',':task','handoffs'],handler:(p,_q,b,ctx)=>(b as {kind?:string} | undefined)?.kind === 'HANDOFF' ? tasks.engagements.create(p.task!,b,ctx) : invalid()},
    {method:'POST',segments:['tasks',':task','approvals',':entity','decisions'],handler:(p,_q,b,ctx)=>p.entity === (b as {approvalId?:string}|undefined)?.approvalId && (b as {kind?:string} | undefined)?.kind === 'APPROVAL_DECISION' ? tasks.engagements.create(p.task!,b,ctx) : invalid()},
    {method:'POST',segments:['tasks',':task','boundary-requests',':entity','cancel'],handler:(p,_q,b,ctx)=>p.entity === (b as {resourceId?:string}|undefined)?.resourceId && (b as {kind?:string} | undefined)?.kind === 'CANCEL_BOUNDARY' ? tasks.engagements.create(p.task!,b,ctx) : invalid()},
    {method:'POST',segments:['tasks',':task','handoffs',':entity','cancel'],handler:(p,_q,b,ctx)=>p.entity === (b as {resourceId?:string}|undefined)?.resourceId && (b as {kind?:string} | undefined)?.kind === 'CANCEL_HANDOFF' ? tasks.engagements.create(p.task!,b,ctx) : invalid()},
    {method:'GET',segments:['tasks',':task','boundary-requests',':entity'],handler:(p,q,_b,ctx)=>tasks.engagements.resource(p.task!,'BOUNDARY_RESULT',p.entity!,q,ctx)},
    {method:'GET',segments:['tasks',':task','handoffs',':entity'],handler:(p,q,_b,ctx)=>tasks.engagements.resource(p.task!,'HANDOFF_RESULT',p.entity!,q,ctx)},
    {method:'GET',segments:['tasks',':task','side-questions',':requestKey'],handler:(p,_q,_b,ctx)=>tasks.engagements.request(p.task!,p.requestKey!,ctx)},
    // Reliable task control (design §6): commandId == requestKey == source Idempotency-Key.
    { method: 'GET', segments: ['tasks', ':task', 'commands'], handler: (p,q,_b,ctx) => tasks.commands(p.task!,q,ctx) },
    { method: 'POST', segments: ['tasks', ':task', 'commands'], handler: (p,_q,b,ctx) => tasks.commandCreate(p.task!,b,ctx) },
    { method: 'GET', segments: ['tasks', ':task', 'commands', ':requestKey'], handler: (p,_q,_b,ctx) => tasks.command(p.task!,p.requestKey!,ctx) },
    { method: 'GET', segments: ['overview'], handler: (_p, _q, _b, ctx) => service.overview(ctx) },
    { method: 'GET', segments: ['projects'], handler: () => service.listProjects() },
    { method: 'POST', segments: ['projects'], handler: (_p, _q, b, ctx) => service.registerProject(b, ctx) },
    { method: 'GET', segments: ['projects', ':project'], handler: (p) => service.getProject(p.project!) },
    { method: 'GET', segments: ['projects', ':project', 'environment'], handler: (p, _q, _b, ctx) => service.getProjectEnvironment(p.project!, ctx) },
    { method: 'POST', segments: ['projects', ':project', 'environment', 'plans'], handler: (p, _q, b, ctx) => service.previewEnvironmentPlan(p.project!, b, ctx) },
    { method: 'POST', segments: ['projects', ':project', 'environment', 'operations'], handler: (p, _q, b, ctx) => service.startEnvironmentOperation(p.project!, b, ctx) },
    { method: 'GET', segments: ['environment-operations', ':operation'], handler: (p) => service.getEnvironmentOperation(p.operation!) },
    { method: 'GET', segments: ['environment-operations', ':operation', 'events'],
      handler: (p, q) => service.getEnvironmentOperationEvents(p.operation!, {
        cursor: q.get('cursor') ?? undefined, limit: q.get('limit') ?? undefined,
      }) },
    { method: 'POST', segments: ['environment-operations', ':operation', 'cancel'], handler: (p, _q, b, ctx) => service.cancelEnvironmentOperation(p.operation!, b, ctx) },
    // §5.1 addendum: NEEDS_INPUT continuation, body {requestKey, inputRequestId, expectedRevision?, payload}.
    { method: 'POST', segments: ['environment-operations', ':operation', 'inputs'], handler: (p, _q, b, ctx) => service.submitOperationInput(p.operation!, b, ctx) },
    { method: 'GET', segments: ['workers'], handler: () => service.listWorkers() },
    { method: 'GET', segments: ['workers', ':worker'], handler: (p) => service.getWorker(p.worker!) },
    { method: 'GET', segments: ['tasks', ':task', 'actions'], handler: (p, _q, _b, ctx) => service.listTaskActions(p.task!, ctx) },
    { method: 'POST', segments: ['tasks', ':task', 'actions', ':action:run'], handler: (p, _q, b, ctx) => service.runTaskAction(p.task!, p.action!, b, ctx) },
    { method: 'POST', segments: ['tasks', ':task', 'actions', ':action:save'], handler: (p, _q, b, ctx) => service.saveTaskAction(p.task!, p.action!, b, ctx) },
    { method: 'GET', segments: ['reports'], handler: () => service.listReports() },
    { method: 'POST', segments: ['reports'], handler: (_p, _q, b, ctx) => service.createReport(b, ctx) },
    { method: 'GET', segments: ['reports', ':report'], handler: (p) => service.getReport(p.report!) },
    { method: 'GET', segments: ['reports', ':report', 'files'], handler: (p) => service.listReportFiles(p.report!) },
  ];

  const send = (res: ServerResponse, status: number, value: unknown, headers: Record<string, string> = {}) => {
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      ...headers,
    });
    res.end(JSON.stringify(value));
  };

  const cookie = (req: IncomingMessage) => req.headers.cookie
    ?.split(';').map((part) => part.trim())
    .find((part) => part.startsWith(COOKIE + '='))?.slice(COOKIE.length + 1);

  async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
    if (req.headers['content-type'] !== 'application/json') {
      throw new ManagementError(415, 'JSON_REQUIRED', 'Use application/json', false);
    }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > BODY_LIMIT) throw new ManagementError(413, 'REQUEST_TOO_LARGE', 'Request exceeds 1 MiB', false);
      chunks.push(Buffer.from(chunk as Buffer));
    }
    try {
      const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return invalid();
      return parsed as Record<string, unknown>;
    } catch (error) {
      if (error instanceof ManagementError) throw error;
      return invalid('Invalid JSON');
    }
  }

  const MIME: Record<string, string> = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
    '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
    '.json': 'application/json', '.map': 'application/json', '.woff2': 'font/woff2',
  };

  async function serveStatic(res: ServerResponse, pathname: string): Promise<void> {
    if (!options.dist) throw new ManagementError(404, 'NOT_FOUND', 'Page not found', false);
    let relative: string;
    try { relative = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).slice(1); }
    catch { throw new ManagementError(404, 'NOT_FOUND', 'Page not found', false); }
    // Bounded: real asset files only, SPA deep links fall back to index.html.
    if (relative.includes('..')) throw new ManagementError(404, 'NOT_FOUND', 'Page not found', false);
    const hasExt = /\.[A-Za-z0-9]{1,8}$/.test(relative);
    const target = hasExt || relative.startsWith('assets/') ? relative : 'index.html';
    const file = resolve(options.dist, target);
    if (!file.startsWith(resolve(options.dist) + sep)) {
      throw new ManagementError(404, 'NOT_FOUND', 'Page not found', false);
    }
    let bytes: Buffer;
    try { bytes = await readFile(file); }
    catch { throw new ManagementError(404, 'NOT_FOUND', 'Build the Web app first', false); }
    res.writeHead(200, {
      'content-type': MIME[extname(file)] ?? 'application/octet-stream',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'content-security-policy': "default-src 'self'; connect-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'",
    });
    res.end(bytes);
  }

  const handleRequest = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const requestId = randomUUID();
    const responseHeaders: Record<string, string> = {};
    try {
      const host = req.headers.host ?? '';
      if (!/^(localhost|127\.0\.0\.1|\[::1\]):[0-9]+$/.test(host)) {
        throw new ManagementError(403, 'HOST_REJECTED', 'Loopback host required', false);
      }
      const url = new URL(req.url ?? '/', 'http://' + host);
      if (!url.pathname.startsWith(PERSONAL_API_PREFIX + '/')) {
        if (req.method !== 'GET') throw new ManagementError(405, 'METHOD_NOT_ALLOWED', 'GET required', false);
        await serveStatic(res, url.pathname);
        return;
      }
      // Same-origin guard on every API call: custom header + origin/site match.
      if (req.headers['x-personal-control'] !== '1'
          || (req.headers.origin && req.headers.origin !== 'http://' + host)
          || (req.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(String(req.headers['sec-fetch-site'])))) {
        throw new ManagementError(403, 'ORIGIN_REJECTED', 'Same-origin control request required', false);
      }
      const tab = req.headers['x-personal-tab'];
      if (typeof tab !== 'string' || !ID.test(tab)) {
        throw new ManagementError(401, 'WEB_CLIENT_REQUIRED', 'A personal tab identity is required', false);
      }
      const sessionCookie = cookie(req);
      // Parallel first-page queries arrive before Set-Cookie has reached the browser.
      // Reuse that tab's short bootstrap window instead of leaking extra registrations.
      const bootstrap = !sessionCookie ? [...browsers.values()].find(s => s.tab === tab && Date.now() - s.createdAt < 10_000) : undefined;
      const cookieId = sessionCookie && ID.test(sessionCookie) ? sessionCookie : bootstrap?.cookieId ?? randomUUID();
      const key = cookieId + ':' + tab;
      let session = browsers.get(key);
      if (!session) {
        if (browsers.size >= MAX_SESSIONS) {
          throw new ManagementError(429, 'CLIENT_LIMIT', 'Close idle clients before opening more', true);
        }
        session = { cookieId, tab, createdAt: Date.now(), seen: Date.now(), upstream: new Map(), pending: new Map() };
        browsers.set(key, session);
        responseHeaders['Set-Cookie'] =
          `${COOKIE}=${cookieId}; HttpOnly; SameSite=Strict; Path=/api/personal`;
      }
      if (!sessionCookie) responseHeaders['Set-Cookie'] = `${COOKIE}=${cookieId}; HttpOnly; SameSite=Strict; Path=/api/personal`;
      session.seen = Date.now();

      const tail = url.pathname.slice(PERSONAL_API_PREFIX.length);
      const parts = tail.split('/').filter((s) => s.length > 0);
      const deviceAccess = parts[0] === 'device-access';
      const body = req.method === 'POST' || deviceAccess && req.method === 'PUT' ? await readBody(req) : undefined;
      if (req.method !== 'GET' && req.method !== 'POST' && !(deviceAccess && ['PUT', 'DELETE'].includes(req.method ?? ''))) {
        throw new ManagementError(405, 'METHOD_NOT_ALLOWED', 'GET or POST required', false);
      }
      if ((req.method === 'POST' || req.method === 'PUT') && req.headers['idempotency-key'] && req.headers['idempotency-key'] !== body?.requestKey) return invalid('Idempotency-Key must match requestKey');
      const ctx: GatewayCallContext = {
        requestId,
        acsSessionFor: async (connectionId: string) => {
          const connection = store.getConnection(connectionId);
          if (!connection?.baseUrl || connection.kind==='WORKER_LOCAL') return undefined;
          const pending = session!.pending.get(connectionId);
          if (pending) return pending;
          const work = (async () => {
            let handle = session!.upstream.get(connectionId);
            if (handle && Date.now() - (handle.checkedAt ?? 0) > 30_000) {
              try {
                await hub.handle(connection).acs(handle).heartbeatClientSession(handle.clientSessionId);
                handle.checkedAt = Date.now();
              } catch (e) {
                if (e instanceof ServiceProblem && [401, 404, 409].includes(e.status)) handle = undefined;
                else throw e;
              }
            }
            if (!handle) {
              const registration = randomUUID();
              const registered = await hub.handle(connection).openAcsSession(registration, registration, randomUUID());
              handle = { clientSessionId: registered.clientSessionId, token: registered.clientSessionToken,
                storeId: registered.storeId, bootId: registered.bootId, checkedAt: Date.now() };
              session!.upstream.set(connectionId, handle);
            }
            return handle;
          })();
          session!.pending.set(connectionId, work);
          try { return await work; } finally { session!.pending.delete(connectionId); }
        },
      };
      if (deviceAccess) {
        if (parts.length === 1 && req.method === 'GET') {
          send(res, 200, store.listConnections().filter(row => row.kind!=='WORKER_LOCAL'&&!!row.baseUrl).map(row => ({
            connectionId: row.connectionId, displayName: row.displayName ?? row.connectionId,
          })), responseHeaders); return;
        }
        const connectionId = parts[1];
        if (!connectionId || !ID.test(connectionId)) return invalid('Registered connection required');
        const row = store.getConnection(connectionId);
        if (!row?.baseUrl||row.kind==='WORKER_LOCAL') throw new ManagementError(404, 'CONNECTION_NOT_FOUND', 'Registered ACS source required', false);
        const handle = hub.handle(row), registration = await ctx.acsSessionFor(connectionId);
        if (!registration?.storeId) throw new ManagementError(409, 'SOURCE_NOT_READY', 'Source identity required', false);
        const capabilities = await handle.personalAccess(registration, 'capabilities') as Record<string, unknown>;
        if (capabilities.storeId !== registration.storeId) throw new ManagementError(409, 'HOST_IDENTITY_CHANGED', 'Owner source identity changed', false);
        if (parts.length === 3 && parts[2] === 'capabilities' && req.method === 'GET') {
          let sessions:Awaited<ReturnType<ReturnType<typeof handle.acs>['listSessions']>>=[];
          try{sessions=await handle.acs(registration).listSessions();}catch(error){if(!(capabilities.localSource as {available?:boolean}|undefined)?.available)throw error;}
          const nativeStore=(capabilities.localSource as {backendStoreId?:string}|undefined)?.backendStoreId;
          const fromBridge=(capabilities.localSource as {tasks?:Record<string,unknown>[]} | undefined)?.tasks??[];
          const indexedTasks=store.listTasks(100).flatMap(task=>{try{const launch=task.launchJson?JSON.parse(task.launchJson):undefined,b=launch?.executionBinding;return b?.kind==='WORKER_LOCAL'&&b.storeId===nativeStore&&typeof b.localTaskId==='string'?[{kind:'WORKER_LOCAL',backendStoreId:b.storeId,taskId:b.localTaskId,displayName:task.displayName}]:[];}catch{return [];}});
          const localTasks=[...new Map([...fromBridge,...indexedTasks].map(t=>[`${t.backendStoreId}:${t.taskId}`,t])).values()].slice(0,100);
          send(res, 200, {...capabilities, localTasks, sessions: sessions.slice(0, 100).map(r => ({sessionId: r.sessionId, title: r.title || '任务会话'}))}, responseHeaders); return;
        }
        let operation: import('./upstream').PersonalAccessOwnerOperation | undefined;
        let payload: Record<string, unknown> | undefined, target: string | undefined;
        const allowed = (names: string[]) => {if (!body || Object.keys(body).some(k => !names.includes(k))) invalid('Unexpected owner request field');};
        const ownerRequest = (names: string[]) => {
          allowed(names);
          const requestKey = body?.requestKey;
          if (typeof requestKey !== 'string' || !ID.test(requestKey) || !body) invalid('Original request key required');
          const rest = {...body}; delete rest.requestKey;
          return {requestId: requestKey, ...rest};
        };
        if (parts.length === 3 && req.method === 'GET' && ['devices', 'pairing-requests'].includes(parts[2]!)) operation = parts[2] as 'devices' | 'pairing-requests';
        if (parts.length === 3 && parts[2] === 'invitations' && req.method === 'POST') {
          allowed(['requestKey', 'sessions', 'resources', 'launchScopes', 'actions']); operation = 'invitations';
          payload = {requestId: body!.requestKey, ...deviceScopeFields(body!)};
        }
        if (parts.length === 5 && parts[2] === 'pairing-requests' && parts[4] === 'decisions' && req.method === 'POST') {
          allowed(['requestKey', 'approve']); operation = 'decide'; target = parts[3]; payload = {approve: body!.approve};
        }
        if (parts.length === 4 && parts[2] === 'devices' && req.method === 'DELETE') {operation = 'revoke'; target = parts[3];}
        if (parts.length === 5 && parts[2] === 'devices' && parts[4] === 'scope' && req.method === 'PUT') {
          allowed(['requestKey', 'expectedGrantRevision', 'sessions', 'resources', 'launchScopes', 'actions']); operation = 'scope'; target = parts[3];
          payload = {requestId: body!.requestKey, expectedGrantRevision: body!.expectedGrantRevision, ...deviceScopeFields(body!)};
        }
        // Notification controls are owner-only and deliberately narrower than
        // device scope. ACS remains authoritative for provider and route
        // state; the browser can only toggle an already configured route.
        if (parts.length === 3 && parts[2] === 'notification-provider' && req.method === 'GET') {
          operation = 'notification-provider';
        }
        if (parts.length === 3 && parts[2] === 'notification-provider' && req.method === 'PUT') {
          operation = 'notification-provider-update';
          payload = ownerRequest(['requestKey', 'enabled', 'expectedRevision']);
          if (typeof body!.enabled !== 'boolean') invalid('enabled must be boolean');
          if (body!.expectedRevision !== undefined && (typeof body!.expectedRevision !== 'string' || !/^\d+$/.test(body!.expectedRevision))) invalid('Invalid expectedRevision');
        }
        if (parts.length === 3 && parts[2] === 'notification-routes' && req.method === 'GET') {
          operation = 'notification-routes';
        }
        if (parts.length === 5 && parts[2] === 'devices' && parts[4] === 'notification-route' && req.method === 'GET') {
          operation = 'notification-route'; target = parts[3];
        }
        if (parts.length === 5 && parts[2] === 'devices' && parts[4] === 'notification-route' && req.method === 'PUT') {
          operation = 'notification-route-update'; target = parts[3];
          payload = ownerRequest(['requestKey', 'enabled', 'expectedGrantRevision']);
          if (typeof body!.enabled !== 'boolean') invalid('enabled must be boolean');
          if (body!.expectedGrantRevision !== undefined && (typeof body!.expectedGrantRevision !== 'string' || !/^\d+$/.test(body!.expectedGrantRevision))) invalid('Invalid expectedGrantRevision');
        }
        if (parts.length === 5 && parts[2] === 'devices' && parts[4] === 'notification-subscription' && req.method === 'GET') {
          operation = 'notification-subscription'; target = parts[3];
        }
        if (!operation) throw new ManagementError(404, 'NOT_FOUND', 'Fixed owner route required', false);
        if (target && !ID.test(target)) return invalid('Invalid owner target');
        if (payload && 'requestId' in payload && (typeof payload.requestId !== 'string' || !ID.test(payload.requestId))) return invalid('Original request key required');
        const result = await handle.personalAccess(registration, operation, payload, target);
        send(res, operation === 'invitations' ? 201 : 200, result, responseHeaders); return;
      }
      // P8 mount: P7 reports router self-matches /api/personal/v1/reports*
      // (full pathname including prefix) and returns undefined for anything
      // else — the P5 table below stays the fallback for unmounted installs.
      if (reports) {
        const outcome = await reports.handle({
          method: req.method, pathname: url.pathname,
          searchParams: url.searchParams, body,
        });
        if (outcome) {
          send(res, outcome.status, outcome.body, responseHeaders);
          return;
        }
      }
      let matched = false;
      for (const route of ROUTES) {
        if (route.method !== req.method) continue;
        const params = matchSegments(route.segments, parts);
        if (!params) continue;
        matched = true;
        // worker-events/1 SSE passthrough: the native activities leaf honours
        // Accept: text/event-stream by streaming frames instead of the JSON
        // envelope. Same bound route + binding; the body is never buffered.
        if (route.segments.join('/') === 'tasks/:task/activities'
            && (req.headers.accept ?? '').split(',').some(t => t.split(';')[0]!.trim() === 'text/event-stream')) {
          const abort = new AbortController();
          res.on('close', () => abort.abort());
          const upstream = await tasks.leafStream(params.task!, 'activities', url.searchParams, abort.signal);
          res.writeHead(200, {
            'content-type': 'text/event-stream; charset=utf-8',
            'cache-control': 'no-store',
            'x-content-type-options': 'nosniff',
            'x-accel-buffering': 'no',
            ...responseHeaders,
          });
          res.flushHeaders();
          const reader = upstream.body.getReader();
          try {
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              if (res.destroyed) break;
              if (!res.write(value)) await new Promise<void>((r) => res.once('drain', () => r()));
            }
          } catch {
            // Every failure after flushHeaders — client disconnect aborting the
            // upstream read, worker reset, mid-stream transport error — lands
            // here. Headers are already sent, so this must NOT reach the outer
            // JSON catch: send() would throw ERR_HTTP_HEADERS_SENT and crash
            // the process. Ending the response is the only legal move.
          } finally {
            try { reader.releaseLock(); } catch { /* already released */ }
            void upstream.body.cancel().catch(() => {});
            if (!res.destroyed && !res.writableEnded) res.end();
          }
          return;
        }
        const outcome = await route.handler(params, url.searchParams, body, ctx);
        send(res, outcome.status, outcome.body, responseHeaders);
        return;
      }
      if (!matched) throw new ManagementError(404, 'NOT_FOUND', 'Personal route not found', false);
    } catch (error) {
      if (error instanceof ManagementError) {
        send(res, error.status, toPersonalError(error.status, error.code, error.message, error.retryable, requestId), responseHeaders);
      } else if (error instanceof ServiceProblem) {
        const status = error.status >= 400 ? error.status : 502;
        send(res, status, toPersonalError(status, error.code, error.message, error.retryable ?? status >= 500, requestId), responseHeaders);
      } else {
        const env = error as EnvProblem | undefined;
        if (env?.code && typeof env.status === 'number' && env.status >= 400) {
          send(res, env.status, toPersonalError(env.status, env.code, env.message, env.retryable ?? false, requestId), responseHeaders);
        } else {
          send(res, 502, toPersonalError(502, 'UPSTREAM_UNAVAILABLE',
            'Upstream unavailable or incompatible; retain the original request key before retrying', true, requestId), responseHeaders);
        }
      }
    }
  };
  const server = createServer(handleRequest);

  const timer = setInterval(() => {
    for (const [key, session] of browsers) {
      if (Date.now() - session.seen > TTL) {
        browsers.delete(key);
        for (const [connectionId, handle] of session.upstream) {
          const row = store.getConnection(connectionId);
          if (row) {
            void hub.handle(row).revokeAcsSession(handle.clientSessionId).catch(() => {});
          }
        }
      }
    }
  }, 30_000);
  timer.unref();

  const close = async () => {
    clearInterval(timer);
    for (const [, session] of browsers) {
      for (const [connectionId, handle] of session.upstream) {
        const row = store.getConnection(connectionId);
        if (row) await hub.handle(row).revokeAcsSession(handle.clientSessionId).catch(() => {});
      }
    }
    browsers.clear();
    server.closeAllConnections(); // fetch keep-alive sockets must not hang close
    server.closeIdleConnections();
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    // Drain the reports job queue before closing the registry so an in-flight
    // report can persist its final state instead of dying mid-write.
    await reports?.service.executor.idle().catch(() => {});
    await tasks.engagements.idle();
    await tasks.collaboration.idle();
    await metrics.close();
    store.close();
  };
  server.on('close', () => { clearInterval(timer); });

  return {
    server,
    handleRequest,
    store,
    hub,
    service,
    controlPlaneId: store.controlPlaneId,
    instanceId,
    reports,
    setReportProvider: (provider) => service.setReportProvider(provider),
    setActionRunner: (runner) => service.setActionRunner(runner),
    registerTask: (input) => store.upsertTask(input).taskId,
    close,
  };
}
