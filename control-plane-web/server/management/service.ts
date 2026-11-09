/**
 * Personal management service (PAE task §8): the /api/personal/v1 gateway
 * logic — registration queries, readiness aggregation, environment
 * plan/operation flows, action history, attention merge and report
 * references.
 *
 * Design rules honored here (freeze §0/§2/§4/§5.1, design §10.2/§11):
 * - Writes run through the request ledger: the key association is persisted
 *   BEFORE any external dispatch; replays return the recorded response;
 *   same key + different body is IDEMPOTENCY_CONFLICT. Refresh/restart/
 *   timeout recovery re-checks the original key — a second client click can
 *   never produce a second external effect.
 * - GET handlers never install, pull, spawn or probe beyond fixed read-only
 *   upstream surfaces. Plan preview is always a dry run.
 * - Readiness facts are layered (connection / model / toolchain / service /
 *   dependency / environment) per host+engine+project+action and persist
 *   with observedAt+source; an offline upstream yields stale facts, not an
 *   automatic failure verdict.
 * - Connection kinds keep real capability differences: only DAEMON rows with
 *   a configured /env/v1 channel can prepare; ACS_DIRECT and CORE_LOCAL stay
 *   read/plan-only (a local launcher is not a daemon, a direct ACS session
 *   has no Docker install right).
 */
import { createHash, randomUUID } from 'node:crypto';
import {
  ENVIRONMENT_OPERATION_STATES,
  PERSONAL_ID_PATTERN,
  validPersonalOperation,
  type AdaptiveActionDescriptor,
  type ActionTrialReceiptView,
  type PersonalActionRunRequest,
  type PersonalActionSaveRequest,
  type PersonalAttentionItem,
  type PersonalEnvelope,
  type PersonalEnvironmentOperation,
  type PersonalEnvironmentPlanPreview,
  type PersonalEnvironmentPlanRequest,
  type PersonalEnvironmentOperationRequest,
  type PersonalEnvironmentRequirement,
  type PersonalEnvironmentFact,
  type PersonalMeta,
  type PersonalOperationCancelRequest,
  type PersonalOperationEventsPage,
  type PersonalOverview,
  type PersonalProjectRegistrationRequest,
  type PersonalProjectView,
  type PersonalReportFile,
  type PersonalReportRequest,
  type PersonalWorkerView,
  type ProjectEnvironmentView,
  type ReportDescriptor,
} from '../../../codeagent-desktop/packages/protocol/src/personal';
import type { JsonValue } from '../../../codeagent-desktop/packages/protocol/src/index';
import { ServiceProblem } from '../../../codeagent-desktop/packages/service-client/src/index';
import { canonicalDigest } from './canonical';
import { ManagementError, invalid, conflict } from './errors';
import {
  bodyDigestOf,
  connectionCapabilities,
  upstreamBodyDigest,
  type AcsSessionHandle,
  type ConnectionHub,
  type EnvProblem,
} from './upstream';
import type {
  ConnectionRow,
  EnvOperationRow,
  ManagementStore,
  ProjectRow,
  TaskActionRow,
} from './registry-store';

const ID = PERSONAL_ID_PATTERN;
const DECIMAL = /^(0|[1-9][0-9]{0,18})$/;
const TERMINAL_STATES = new Set(['READY', 'FAILED', 'CANCELED']);
const EVENT_LIMIT_MAX = 256;

export interface BrowserBinding {
  /** Per-tab browser session key; also the upstream client-session scope. */
  tabId: string;
}

/**
 * Per-request context: requestId for the {error} correlation field plus the
 * browser-session-bound upstream client-session factory. The service is
 * shared across requests, so upstream sessions arrive per call — never held
 * in mutable service state.
 */
export interface GatewayCallContext {
  requestId: string;
  acsSessionFor(connectionId: string): Promise<AcsSessionHandle | undefined>;
}

/** P7 seam: report tasks/results provider (task §8 route surface). */
export interface PersonalReportProvider {
  listReports(): Promise<ReportDescriptor[]>;
  createReport(request: PersonalReportRequest): Promise<ReportDescriptor>;
  getReport(reportId: string): Promise<ReportDescriptor | undefined>;
  listReportFiles(reportId: string): Promise<PersonalReportFile[]>;
}

/** Execution seam: trial-run an already-declared action (never argv/script). */
export interface AdaptiveActionRunner {
  run(request: {
    taskId: string;
    actionId: string;
    action: TaskActionRow;
    project?: ProjectRow;
    inputs?: Record<string, JsonValue>;
    requestKey: string;
    observedAt: string;
  }): Promise<ActionTrialReceiptView>;
}

export interface ManagementServiceOptions {
  store: ManagementStore;
  hub: ConnectionHub;
  /** Process boot identity (changes per restart; controlPlaneId is stable). */
  instanceId?: string;
  reportProvider?: PersonalReportProvider;
  actionRunner?: AdaptiveActionRunner;
  now?: () => Date;
}

interface RouteOutcome {
  status: number;
  body: unknown;
}

export class PersonalManagementService {
  private readonly store: ManagementStore;
  private readonly hub: ConnectionHub;
  private readonly instanceId: string;
  private readonly nowFn: () => Date;
  private reportProvider?: PersonalReportProvider;
  private actionRunner?: AdaptiveActionRunner;

  constructor(options: ManagementServiceOptions) {
    this.store = options.store;
    this.hub = options.hub;
    this.instanceId = options.instanceId ?? randomUUID();
    this.reportProvider = options.reportProvider;
    this.actionRunner = options.actionRunner;
    this.nowFn = options.now ?? (() => new Date());
  }

  setReportProvider(provider: PersonalReportProvider | undefined): void { this.reportProvider = provider; }
  setActionRunner(runner: AdaptiveActionRunner | undefined): void { this.actionRunner = runner; }
  get controlPlaneId(): string { return this.store.controlPlaneId; }

  private now(): string { return this.nowFn().toISOString(); }

  private meta(extra: {
    observedAt?: string; supportedActions?: string[]; reasonCodes?: string[]; revision?: string;
  } = {}): PersonalMeta {
    return {
      source: 'personal-management',
      instance: this.instanceId,
      controlPlaneId: this.store.controlPlaneId,
      observedAt: extra.observedAt ?? this.now(),
      revision: extra.revision ?? String(this.store.registryRevision()),
      supportedActions: extra.supportedActions ?? [],
      reasonCodes: extra.reasonCodes ?? [],
    };
  }

  private envelope<T>(data: T, meta?: Partial<Parameters<PersonalManagementService['meta']>[0]>): PersonalEnvelope<T> {
    return { meta: this.meta(meta ?? {}), data };
  }

  /**
   * Idempotent write shell (task §8.5): persist the key association first,
   * then dispatch. A SETTLED row replays verbatim; a PENDING row means a
   * previous attempt ended mid-flight, so the route body is re-entered —
   * safe because every downstream effect is keyed by the same requestKey.
   */
  private async idempotent(route: string, requestKey: string, body: unknown,
      requestId: string, subjectId: string | undefined,
      fn: () => Promise<RouteOutcome>): Promise<RouteOutcome> {
    const bodyDigest = bodyDigestOf(body);
    const prior = this.store.ledgerGet(requestKey);
    if (prior) {
      if (prior.bodyDigest !== bodyDigest || prior.route !== route) {
        return {
          status: 409,
          body: { error: { code: 'IDEMPOTENCY_CONFLICT', retryable: false, requestId,
            message: 'requestKey was already used with a different request body' } },
        };
      }
      if (prior.state === 'SETTLED' && prior.responseBody) {
        return { status: prior.responseStatus ?? 200, body: JSON.parse(prior.responseBody) };
      }
      // PENDING → resume the original dispatch below.
    } else {
      this.store.ledgerBegin({ requestKey, route, bodyDigest, subjectId });
    }
    try {
      const outcome = await fn();
      this.store.ledgerSettle(requestKey, outcome.status, outcome.body);
      return outcome;
    } catch (error) {
      const mapped = this.asFinalError(error, requestId);
      if (mapped) {
        this.store.ledgerSettle(requestKey, mapped.status, mapped.body);
        return mapped;
      }
      throw error; // transient: row stays PENDING so a retry resumes the key
    }
  }

  /** Deterministic (non-retryable) failures are recorded and replayed. */
  private asFinalError(error: unknown, requestId: string): RouteOutcome | undefined {
    if (error instanceof ManagementError && !error.retryable) {
      return {
        status: error.status,
        body: { error: { code: error.code, message: error.message, retryable: false, requestId } },
      };
    }
    const status = (error as { status?: number })?.status;
    if (error instanceof ServiceProblem && status && status < 500 && !error.retryable) {
      return {
        status,
        body: { error: { code: error.code, message: error.message, retryable: false, requestId } },
      };
    }
    const env = error as EnvProblem | undefined;
    if (env && env.code && status && status < 500 && env.retryable !== true) {
      return {
        status,
        body: { error: { code: env.code, message: env.message, retryable: false, requestId } },
      };
    }
    return undefined;
  }

  private opView(row: EnvOperationRow): PersonalEnvironmentOperation {
    return {
      operationId: row.operationId,
      requestKey: row.requestKey,
      kind: row.kind,
      state: row.state,
      projectId: row.projectId,
      environmentId: row.environmentId ?? null,
      revision: String(row.revision),
      cursor: row.upstreamEventCursor ?? null,
      progress: row.progress ?? null,
      reasonCode: row.reasonCode ?? null,
      resultRef: row.resultRef ?? null,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  private projectView(row: ProjectRow): PersonalProjectView {
    return {
      projectId: row.projectId,
      projectRef: row.projectRef,
      displayName: row.displayName ?? null,
      registeredAt: row.registeredAt,
      updatedAt: row.updatedAt,
      revision: String(row.revision),
    };
  }

  // ------------------------------------------------------------------
  // Projects
  // ------------------------------------------------------------------

  async overview(ctx: GatewayCallContext): Promise<RouteOutcome> {
    const projects = this.store.listProjects().map((p) => this.projectView(p));
    const workers: PersonalWorkerView[] = [];
    for (const row of this.store.listConnections()) {
      workers.push(await this.workerView(row));
    }
    const attention = await this.attention(ctx);
    const supportedActions = ['REGISTER_PROJECT'];
    if (this.reportProvider) supportedActions.push('REPORT_CREATE');
    return {
      status: 200,
      body: this.envelope<PersonalOverview>({ projects, workers, attention },
        { supportedActions }),
    };
  }

  async listProjects(): Promise<RouteOutcome> {
    return {
      status: 200,
      body: this.envelope(this.store.listProjects().map((p) => this.projectView(p)),
        { supportedActions: ['REGISTER_PROJECT'] }),
    };
  }

  async getProject(projectId: string): Promise<RouteOutcome> {
    const row = this.store.getProject(projectId);
    if (!row) throw new ManagementError(404, 'PROJECT_NOT_REGISTERED', 'Unknown project id', false);
    return { status: 200, body: this.envelope(this.projectView(row)) };
  }

  /**
   * Register a reference to an already-registered upstream projectRef on the
   * primary connection (freeze §4). The browser submits ids only.
   */
  async registerProject(body: unknown, ctx: GatewayCallContext): Promise<RouteOutcome> {
    const request = this.writeBody<PersonalProjectRegistrationRequest>(
      { action: 'REGISTER_PROJECT', key: (body as any)?.requestKey, body });
    return this.idempotent('REGISTER_PROJECT', request.requestKey, body, ctx.requestId, undefined,
      async () => {
        const selected = request.connectionId ? this.store.getConnection(request.connectionId) : undefined;
        if (request.connectionId && !selected) throw new ManagementError(404,'CONNECTION_MISSING','登记的连接不存在',false);
        const { connection, handle } = selected ? {connection:selected,handle:this.hub.handle(selected)} : this.hub.primary();
        if(connection.kind === 'WORKER_LOCAL'){
          const projects=await this.hub.local<{items:{projectId:string}[]}>(connection.connectionId,'GET','/projects');
          if(!projects.items.some(p=>p.projectId===request.projectRef))throw new ManagementError(404,'PROJECT_NOT_REGISTERED','本机 owner 尚未登记该项目',false);
        }
        // Verify the referenced project exists upstream before registering.
        if (handle.hasAcs()) {
          await handle.acs(await ctx.acsSessionFor(connection.connectionId)).getProject(request.projectRef);
        } else if (handle.hasEnv()) {
          await handle.env().inspectProject({ projectRef: request.projectRef });
        }
        const duplicate = this.store.findProjectByRef(connection.connectionId, request.projectRef);
        if (duplicate) {
          return { status: 200, body: this.envelope(this.projectView(duplicate), { supportedActions: ['PROJECT_ENVIRONMENT'] }) };
        }
        const row = this.store.insertProject({
          projectId: `prj-${randomUUID()}`,
          projectRef: request.projectRef,
          connectionId: connection.connectionId,
          displayName: request.displayName,
          notes: request.notes,
        });
        return {
          status: 200,
          body: this.envelope(this.projectView(row),
            { supportedActions: ['PROJECT_ENVIRONMENT'] }),
        };
      });
  }

  // ------------------------------------------------------------------
  // Project environment readiness (layered, stale-tolerant)
  // ------------------------------------------------------------------

  async getProjectEnvironment(projectId: string, ctx: GatewayCallContext): Promise<RouteOutcome> {
    const { project, handle } = this.hub.forProject(projectId);
    const subject = `project:${projectId}`;
    const observedAt = this.now();
    const needs: PersonalEnvironmentRequirement[] = [];
    const have: PersonalEnvironmentFact[] = [];
    const missing: PersonalEnvironmentRequirement[] = [];
    const warnings: string[] = [];
    const reasonCodes: string[] = [];
    const supportedCores = new Set<string>();
    let reachable = false;
    let observedStale = false;

    const remember = (layer: string, facts: {
      factKey: string; kind?: string; name?: string; version?: string;
      state?: string; detail?: string; source?: string;
    }[]) => {
      this.store.putFacts(subject, layer, facts, observedAt);
      for (const fact of facts) {
        if (fact.state && ['PRESENT', 'READY', 'CONNECTED', 'ENABLED'].includes(fact.state)) {
          have.push({ factId: fact.factKey,
            kind: (fact.kind as PersonalEnvironmentFact['kind']) ?? 'DEPENDENCY_ENTRY',
            name: fact.name ?? null, version: fact.version ?? null,
            detailRef: fact.source ?? null, observedAt });
        }
      }
    };

    if (handle.hasAcs()) {
      const client = handle.acs(await ctx.acsSessionFor(project.connectionId));
      // Connection + model layers
      try {
        const preflight = await client.getProjectSessionPreflight(project.projectRef);
        reachable = true;
        remember('CONNECTION', [{ factKey: 'connection', kind: 'DEPENDENCY_ENTRY', name: project.connectionId, state: 'CONNECTED', source: 'session-preflight' }]);
        supportedCores.add('ACS');
        needs.push({ kind: 'MODEL', name: preflight.modelAlias ?? 'model', source: 'session-preflight',
          detail: preflight.modelAvailability ?? undefined });
        if (preflight.modelAvailability && preflight.modelAvailability !== 'AVAILABLE') {
          missing.push({ kind: 'MODEL', name: preflight.modelAlias ?? 'model', source: 'session-preflight',
            detail: preflight.modelAvailability });
          if (!reasonCodes.includes('DEPENDENCY_UNAVAILABLE')) reasonCodes.push('DEPENDENCY_UNAVAILABLE');
        }
        remember('MODEL', [{
          factKey: `model:${preflight.modelAlias ?? 'default'}`, kind: 'DEPENDENCY_ENTRY',
          name: preflight.modelAlias ?? 'model',
          state: preflight.modelAvailability ?? 'UNKNOWN', source: 'session-preflight',
        }]);
      } catch (error) {
        this.noteUpstreamFailure(error, warnings, reasonCodes);
        observedStale = true;
      }
      // Toolchain + project-dependency layers from the build plan.
      try {
        const plan = await client.getProjectBuildPlan(project.projectRef);
        const facts: { factKey: string; kind: string; name?: string; version?: string; state: string; detail?: string; source?: string }[] = [];
        for (const target of plan.targets ?? []) {
          needs.push({ kind: 'TOOLCHAIN', name: target.tool, source: `build-plan:${target.targetId}` });
          for (const [action, view] of Object.entries(target.actions ?? {})) {
            if (view.disabled) continue;
            for (const check of view.readiness ?? []) {
              const key = `${target.targetId}:${action}:${check.id ?? check.check ?? facts.length}`;
              const state = check.severity === 'PASS' || check.passed ? 'PRESENT'
                : check.inconclusive ? 'UNKNOWN' : 'MISSING';
              facts.push({ factKey: key, kind: 'TOOL_VERSION', name: check.check ?? `${target.tool}:${action}`,
                state, detail: check.message ?? undefined, source: `build-plan:${target.targetId}` });
              if (state === 'MISSING') {
                missing.push({ kind: 'DEPENDENCY', name: check.check ?? `${target.tool}:${action}`,
                  source: `build-plan:${target.targetId}`, detail: check.message ?? undefined });
                if (!reasonCodes.includes('TOOLCHAIN_MISSING')) reasonCodes.push('TOOLCHAIN_MISSING');
              }
            }
          }
        }
        remember('TOOLCHAIN', facts);
        if (plan.recipeLoadWarnings?.length) warnings.push(...plan.recipeLoadWarnings.slice(0, 16));
        if (plan.truncated) warnings.push('build plan was truncated upstream');
      } catch (error) {
        this.noteUpstreamFailure(error, warnings, reasonCodes);
        observedStale = true;
      }
      // Service layer: MCP servers + environment feature cards.
      try {
        const servers = await client.listMcpServersGoverned();
        const facts = (servers ?? []).map((server) => ({
          factKey: `mcp:${server.serverId ?? '?'}`, kind: 'SERVICE_HEALTH',
          name: server.displayName ?? server.serverId ?? undefined,
          state: server.connectionState ?? 'UNKNOWN',
          detail: server.stateReason ?? undefined, source: 'mcp-governed',
        }));
        remember('SERVICE', facts);
        for (const server of servers ?? []) {
          if (server.enabled === false) continue;
          if (server.connectionState && !['READY', 'DISABLED'].includes(server.connectionState)) {
            missing.push({ kind: 'SERVICE', name: server.displayName ?? server.serverId ?? 'mcp-server',
              source: 'mcp-governed', detail: server.stateReason ?? server.connectionState });
            if (!reasonCodes.includes('SERVICE_UNREADY')) reasonCodes.push('SERVICE_UNREADY');
          }
        }
      } catch (error) {
        this.noteUpstreamFailure(error, warnings, reasonCodes);
        observedStale = true;
      }
      try {
        const features = await client.getEnvironmentFeatures();
        remember('ENVIRONMENT', (features.features ?? []).map((card) => ({
          factKey: `feature:${card.featureId}`, kind: 'DEPENDENCY_ENTRY',
          name: card.title ?? String(card.featureId),
          state: card.state ?? (card.effectiveEnabled ? 'ENABLED' : 'DISABLED'),
          source: 'environment-features',
        })));
      } catch (error) {
        this.noteUpstreamFailure(error, warnings, reasonCodes);
        observedStale = true;
      }
    } else if (handle.hasEnv()) {
      // Daemon path: the worker managed channel is authoritative for
      // requirements and READY environments.
      try {
        const report = await handle.env().inspectProject({ projectRef: project.projectRef });
        reachable = true;
        for (const req of this.arrayOf(report, 'requirements')) {
          const r = req as Record<string, unknown>;
          needs.push({ requirementId: typeof r.requirementId === 'string' ? r.requirementId : null,
            kind: typeof r.kind === 'string' ? r.kind : 'DEPENDENCY',
            name: typeof r.name === 'string' ? r.name : 'requirement',
            version: typeof r.version === 'string' ? r.version : null,
            source: 'env-inspect', detail: typeof r.detail === 'string' ? r.detail : null });
        }
        for (const miss of this.arrayOf(report, 'missing')) {
          const r = miss as Record<string, unknown>;
          missing.push({ kind: typeof r.kind === 'string' ? r.kind : 'DEPENDENCY',
            name: typeof r.name === 'string' ? r.name : 'missing item',
            version: typeof r.version === 'string' ? r.version : null,
            source: 'env-inspect', detail: typeof r.detail === 'string' ? r.detail : null });
        }
        for (const warn of this.arrayOf(report, 'warnings')) {
          if (typeof warn === 'string') warnings.push(warn.slice(0, 512));
        }
        remember('DEPENDENCY', [
          ...needs.map((n, i) => ({ factKey: `need:${i}`, kind: 'DEPENDENCY_ENTRY', name: n.name, version: n.version ?? undefined, state: 'REQUIRED', source: 'env-inspect' })),
          ...missing.map((m, i) => ({ factKey: `missing:${i}`, kind: 'DEPENDENCY_ENTRY', name: m.name, version: m.version ?? undefined, state: 'MISSING', source: 'env-inspect' })),
        ]);
      } catch (error) {
        this.noteUpstreamFailure(error, warnings, reasonCodes);
        observedStale = true;
      }
      try {
        const environments = await handle.env().listEnvironments(project.projectRef);
        const items = Array.isArray(environments) ? environments : this.arrayOf(environments, 'items');
        const ready = (items as Record<string, unknown>[]).filter((env) =>
          env && (env.state === 'READY' || env.readiness === 'READY'));
        remember('ENVIRONMENT', (items as Record<string, unknown>[]).map((env, i) => ({
          factKey: `env:${String(env?.environmentId ?? i)}`, kind: 'DEPENDENCY_ENTRY',
          name: String(env?.environmentId ?? 'environment'),
          version: env?.revision !== undefined ? String(env.revision) : undefined,
          state: String(env?.state ?? 'UNKNOWN'), source: 'env-list',
        })));
        const selected = this.store.getProjectEnvironment(projectId);
        if (!selected?.environmentId && ready.length) {
          const env = ready[0]!;
          this.store.upsertProjectEnvironment(projectId, {
            environmentId: String(env.environmentId),
            environmentRevision: env.revision !== undefined ? String(env.revision) : undefined,
          });
        }
      } catch (error) {
        this.noteUpstreamFailure(error, warnings, reasonCodes);
        observedStale = true;
      }
    } else {
      warnings.push('connection provides neither ACS service nor managed-environment channel');
      reasonCodes.push('BACKEND_UNAVAILABLE');
      observedStale = true;
    }

    // Stale fallback: an unreachable layer keeps its last stored facts.
    if (observedStale) {
      const stored = this.store.listFacts(subject);
      const haveKeys = new Set(have.map((h) => h.factId));
      for (const fact of stored) {
        if (fact.state === 'PRESENT' || fact.state === 'READY') {
          if (!haveKeys.has(fact.factKey)) {
            have.push({ factId: fact.factKey, kind: (fact.kind as PersonalEnvironmentFact['kind']) ?? 'DEPENDENCY_ENTRY',
              name: fact.name ?? null, version: fact.version ?? null, detailRef: fact.source ?? null,
              observedAt: fact.observedAt });
          }
        } else if (fact.state === 'MISSING' || fact.state === 'UNKNOWN') {
          if (!missing.some((m) => `${m.source}:${m.name}` === `${fact.source}:${fact.name}`)) {
            missing.push({ kind: fact.kind === 'SERVICE_HEALTH' ? 'SERVICE' : 'DEPENDENCY',
              name: fact.name ?? fact.factKey, version: fact.version ?? null,
              source: fact.source ?? null, detail: `last observed ${fact.observedAt}` });
          }
        }
      }
    }

    const selection = this.store.getProjectEnvironment(projectId);
    const pending = this.store.listEnvOperations(projectId)
      .find((op) => !TERMINAL_STATES.has(op.state));
    const state = !reachable && observedStale && !this.store.listFacts(subject).length
      ? 'UNKNOWN'
      : missing.length ? 'NEEDS_INPUT' : 'READY';
    const supportedActions = ['ENVIRONMENT_PLAN'];
    if (connectionCapabilities(handle.row, !!this.actionRunner).projectEnvironmentPrepareV1) {
      supportedActions.push('ENVIRONMENT_OPERATION');
    }
    const view: ProjectEnvironmentView = {
      projectId,
      environmentId: selection?.environmentId ?? null,
      environmentRevision: selection?.environmentRevision ?? null,
      state,
      needs, have, missing,
      warnings: warnings.length ? warnings.slice(0, 32) : undefined,
      supportedCores: [...supportedCores],
      planDigest: selection?.planDigest ?? null,
      imageDigest: null,
      activeOperationId: pending?.operationId ?? null,
      observedAt: observedStale ? (this.store.listFacts(subject)[0]?.observedAt ?? observedAt) : observedAt,
    };
    return { status: 200, body: this.envelope(view, { supportedActions, reasonCodes }) };
  }

  private noteUpstreamFailure(error: unknown, warnings: string[], reasonCodes: string[]): void {
    const message = error instanceof Error ? error.message : 'upstream unavailable';
    warnings.push(`upstream observation failed: ${message.slice(0, 256)}`);
    if (!reasonCodes.includes('BACKEND_UNAVAILABLE')) reasonCodes.push('BACKEND_UNAVAILABLE');
  }

  private arrayOf(container: unknown, key: string): unknown[] {
    if (!container || typeof container !== 'object' || Array.isArray(container)) return [];
    const value = (container as Record<string, unknown>)[key];
    return Array.isArray(value) ? value : [];
  }

  // ------------------------------------------------------------------
  // Environment plan preview — dry run only, never installs (task §8.3)
  // ------------------------------------------------------------------

  async previewEnvironmentPlan(projectId: string, body: unknown, ctx: GatewayCallContext): Promise<RouteOutcome> {
    const request = this.writeBody<PersonalEnvironmentPlanRequest>(
      { action: 'ENVIRONMENT_PLAN', projectId, key: (body as any)?.requestKey, body });
    return this.idempotent('ENVIRONMENT_PLAN', request.requestKey, body, ctx.requestId, projectId,
      async () => {
        const { project, handle } = this.hub.forProject(projectId);
        const selection = this.store.getProjectEnvironment(projectId);
        this.checkRevision(request.expectedRevision, selection?.revision ?? 0);
        const observedAt = this.now();
        let preview: PersonalEnvironmentPlanPreview;
        if (handle.hasEnv()) {
          const intent = {
            schemaVersion: 'project-environment-intent/v1',
            projectRef: project.projectRef,
            targetDirectories: [] as string[],
            runtimeRequirements: [] as unknown[],
            serviceRequirements: [] as unknown[],
            preferredBackend: request.preferredBackend ?? 'ANY',
            credentialRefs: [] as string[],
            revision: request.expectedRevision !== undefined ? Number(request.expectedRevision) : 0,
            toolchainSelections: (request.toolchainSelections ?? []).map((s) => ({
              tool: s.tool, version: s.version, source: s.source ?? 'user',
            })),
          };
          const plan = await handle.env().planEnvironment(intent, true);
          const p = plan as Record<string, unknown>;
          preview = {
            planId: typeof p.planId === 'string' ? p.planId : null,
            planDigest: typeof p.planDigest === 'string' ? p.planDigest : canonicalDigest(plan),
            steps: this.arrayOf(p, 'dependencySteps').map((step) => {
              const s = step as Record<string, unknown>;
              return { stepId: typeof s.stepId === 'string' ? s.stepId : null,
                kind: typeof s.kind === 'string' ? s.kind : null,
                ref: typeof s.ref === 'string' ? s.ref : null,
                summary: typeof s.summary === 'string' ? s.summary.slice(0, 512) : null };
            }),
            estimatedDownloadBytes: null,
            estimatedDiskBytes: null,
            missing: this.arrayOf(p, 'missing').map((m) => {
              const s = m as Record<string, unknown>;
              return { kind: 'DEPENDENCY', name: String(s.name ?? 'missing'), source: 'env-plan' };
            }),
            warnings: this.arrayOf(p, 'warnings').filter((w): w is string => typeof w === 'string').slice(0, 32),
            expiresAt: null,
          };
        } else if (handle.hasAcs()) {
          // ACS build-plan is a resolver dry run upstream — preview only.
          const plan = await handle.acs(await ctx.acsSessionFor(project.connectionId))
            .getProjectBuildPlan(project.projectRef);
          preview = {
            planId: `acs-build-plan:${project.projectRef}`,
            planDigest: canonicalDigest(plan),
            steps: (plan.targets ?? []).flatMap((target) => Object.entries(target.actions ?? {})
              .filter(([, view]) => !view.disabled)
              .map(([action, view]) => ({
                stepId: `${target.targetId}:${action}`,
                kind: 'BUILD_ACTION',
                ref: target.tool,
                summary: `${target.tool} ${action} via ${view.runner ?? 'default runner'} (${view.planSource ?? 'DETECTED'})`,
              }))).slice(0, 128),
            estimatedDownloadBytes: null,
            estimatedDiskBytes: null,
            missing: (plan.targets ?? []).flatMap((target) => Object.values(target.actions ?? {})
              .flatMap((view) => (view.readiness ?? [])
                .filter((check) => !(check.severity === 'PASS' || check.passed))
                .map((check) => ({
                  kind: 'DEPENDENCY',
                  name: check.check ?? `${target.tool}`,
                  source: `build-plan:${target.targetId}`,
                  detail: check.message ?? undefined,
                })))).slice(0, 64),
            warnings: (plan.recipeLoadWarnings ?? []).slice(0, 32),
            expiresAt: null,
          };
        } else {
          throw conflict('CAPABILITY_OFF',
            'connection supports neither plan preview channel');
        }
        // Record the default environment selection's latest plan digest.
        this.store.upsertProjectEnvironment(projectId, { planDigest: preview.planDigest ?? undefined });
        return {
          status: 200,
          body: this.envelope(preview, { observedAt, supportedActions: ['ENVIRONMENT_PLAN'] }),
        };
      });
  }

  // ------------------------------------------------------------------
  // Environment operations: prepare / cleanup / retire + cancel + inputs
  // ------------------------------------------------------------------

  async startEnvironmentOperation(projectId: string, body: unknown, ctx: GatewayCallContext): Promise<RouteOutcome> {
    const request = this.writeBody<PersonalEnvironmentOperationRequest>(
      { action: 'ENVIRONMENT_OPERATION', projectId, key: (body as any)?.requestKey, body });
    return this.idempotent('ENVIRONMENT_OPERATION', request.requestKey, body, ctx.requestId, projectId,
      () => this.dispatchEnvironmentOperation(projectId, request, ctx.requestId));
  }

  /** Re-entrant dispatch: resumable after a mid-flight crash via requestKey. */
  private async dispatchEnvironmentOperation(projectId: string,
      request: PersonalEnvironmentOperationRequest, requestId: string): Promise<RouteOutcome> {
    const { project, handle } = this.hub.forProject(projectId);
    // Revision check before any record is written so a conflicted request
    // leaves no phantom QUEUED row.
    if (request.expectedRevision !== undefined) {
      const selection = this.store.getProjectEnvironment(projectId);
      this.checkRevision(request.expectedRevision, selection?.revision ?? 0);
    }
    let op = this.store.getEnvOperationByRequestKey(request.requestKey);
    if (!op) {
      op = this.store.insertEnvOperation({
        operationId: `eop-${randomUUID()}`,
        requestKey: request.requestKey,
        kind: request.kind,
        projectId,
        connectionId: project.connectionId,
        planDigest: request.planDigest,
        environmentId: request.environmentId,
        environmentRevision: request.environmentRevision,
        expectedRevision: request.expectedRevision,
        state: 'QUEUED',
      });
      this.store.appendOperationEvent({
        operationId: op.operationId, kind: 'ACCEPTED', state: 'QUEUED',
        message: 'operation registered; dispatch pending',
      });
    }
    if (op.upstreamOperationId) {
      const merged = await this.refreshUpstreamOperation(op);
      return {
        status: 200,
        body: this.envelope({ operationId: merged.operationId, state: merged.state },
          { supportedActions: ['OPERATION_CANCEL', 'OPERATION_INPUT'] }),
      };
    }
    const caps = connectionCapabilities(handle.row, !!this.actionRunner);
    if (!caps.projectEnvironmentPrepareV1) {
      this.store.updateEnvOperation(op.operationId, {
        state: 'FAILED', reasonCode: 'BACKEND_UNAVAILABLE',
      });
      this.store.appendOperationEvent({
        operationId: op.operationId, kind: 'REJECTED', state: 'FAILED',
        message: `connection kind ${handle.kind} has no managed-environment channel`,
      });
      return {
        status: 409,
        body: { error: { code: 'CAPABILITY_OFF',
          message: `environment operations require a DAEMON connection with a managed-environment channel (got ${handle.kind})`,
          retryable: false, requestId } },
      };
    }
    // Dispatch to the worker env channel with the original requestKey so an
    // upstream retry or our own resume converges on the same operation.
    const upstreamBody: Record<string, unknown> = {
      requestKey: request.requestKey,
      kind: request.kind,
      projectRef: project.projectRef,
    };
    if (request.planDigest) upstreamBody.planDigest = request.planDigest;
    if (request.environmentId) upstreamBody.environmentId = request.environmentId;
    if (request.environmentRevision) upstreamBody.environmentRevision = request.environmentRevision;
    upstreamBody.bodyDigest = upstreamBodyDigest(upstreamBody);
    const accepted = await handle.env().startOperation(upstreamBody as {
      requestKey: string; bodyDigest: string; kind: string;
      planDigest?: string; environmentId?: string; environmentRevision?: string; projectRef?: string;
    });
    const next = this.store.updateEnvOperation(op.operationId, {
      state: this.normalizeState(accepted.state),
      upstreamOperationId: accepted.operationId,
    });
    this.store.appendOperationEvent({
      operationId: op.operationId, kind: 'DISPATCHED', state: next.state,
      message: `accepted upstream as ${accepted.operationId}`,
    });
    return {
      status: 200,
      body: this.envelope({ operationId: op.operationId, state: next.state },
        { supportedActions: ['OPERATION_CANCEL', 'OPERATION_INPUT'] }),
    };
  }

  private normalizeState(state: string): string {
    return (ENVIRONMENT_OPERATION_STATES as readonly string[]).includes(state) ? state : 'UNKNOWN';
  }

  private checkRevision(expectedRevision: string | undefined, actual: number): void {
    if (expectedRevision === undefined) return;
    if (!DECIMAL.test(expectedRevision)) throw invalid('expectedRevision must be a decimal revision');
    if (BigInt(expectedRevision) !== BigInt(actual)) {
      throw conflict('REVISION_CONFLICT',
        `expected revision ${expectedRevision} but current revision is ${actual}; refresh and retry`);
    }
  }

  /**
   * Merge the upstream truth into our record. FAILED/CANCELED are only
   * written when the upstream writer reported them or the operation was
   * locally refused before dispatch — never inferred from a lost connection.
   */
  private async refreshUpstreamOperation(op: EnvOperationRow): Promise<EnvOperationRow> {
    if (!op.upstreamOperationId) return op;
    const connection = this.store.getConnection(op.connectionId);
    if (!connection?.envBaseUrl) return op;
    const upstream = await this.hub.handle(connection).env()
      .getOperation(op.upstreamOperationId) as Record<string, unknown>;
    const patch: Parameters<ManagementStore['updateEnvOperation']>[1] = {};
    if (typeof upstream.state === 'string') patch.state = this.normalizeState(upstream.state);
    if (typeof upstream.reasonCode === 'string' || upstream.reasonCode === null) {
      patch.reasonCode = upstream.reasonCode as string | null;
    }
    if (typeof upstream.resultRef === 'string' || upstream.resultRef === null) {
      patch.resultRef = upstream.resultRef as string | null;
    }
    if (typeof upstream.cursor === 'string' || upstream.cursor === null) {
      patch.upstreamEventCursor = upstream.cursor as string | null;
    }
    if (typeof upstream.progress === 'number') patch.progress = upstream.progress;
    return this.store.updateEnvOperation(op.operationId, patch);
  }

  async getEnvironmentOperation(operationId: string): Promise<RouteOutcome> {
    let op = this.store.getEnvOperation(operationId);
    if (!op) throw new ManagementError(404, 'OPERATION_NOT_FOUND', 'Unknown operationId', false);
    let stale = false;
    if (op.upstreamOperationId && !TERMINAL_STATES.has(op.state)) {
      try {
        op = await this.refreshUpstreamOperation(op);
      } catch {
        stale = true; // offline: serve last observed state, never auto-fail
      }
    }
    return {
      status: 200,
      body: this.envelope(this.opView(op), {
        observedAt: op.lastObservedAt ?? op.updatedAt,
        supportedActions: TERMINAL_STATES.has(op.state)
          ? [] : ['OPERATION_CANCEL', 'OPERATION_INPUT', 'OPERATION_EVENTS'],
        reasonCodes: stale ? ['BACKEND_UNAVAILABLE'] : [],
      }),
    };
  }

  async getEnvironmentOperationEvents(operationId: string,
      query: { cursor?: string; limit?: string }): Promise<RouteOutcome> {
    const op = this.store.getEnvOperation(operationId);
    if (!op) throw new ManagementError(404, 'OPERATION_NOT_FOUND', 'Unknown operationId', false);
    const limit = query.limit !== undefined ? Number(query.limit) : 50;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > EVENT_LIMIT_MAX) {
      throw invalid('limit must be an integer in [1,256]');
    }
    // Pull upstream events forward first (bounded, cursor-resumed).
    if (op.upstreamOperationId) {
      const connection = this.store.getConnection(op.connectionId);
      if (connection?.envBaseUrl) {
        try {
          const page = await this.hub.handle(connection).env()
            .getOperationEvents(op.upstreamOperationId, {
              cursor: op.upstreamEventCursor ?? undefined, limit: EVENT_LIMIT_MAX,
            }) as Record<string, unknown>;
          for (const event of this.arrayOf(page, 'events')) {
            const e = event as Record<string, unknown>;
            const upstreamId = typeof e.eventId === 'string' ? e.eventId : undefined;
            if (upstreamId && this.store.hasUpstreamEvent(op.operationId, upstreamId)) continue;
            this.store.appendOperationEvent({
              operationId: op.operationId,
              occurredAt: typeof e.occurredAt === 'string' ? e.occurredAt : undefined,
              kind: typeof e.kind === 'string' ? e.kind.slice(0, 64) : undefined,
              state: typeof e.state === 'string' ? this.normalizeState(e.state) : undefined,
              message: typeof e.message === 'string' ? e.message.slice(0, 4096) : undefined,
              upstreamEventId: upstreamId,
            });
          }
          if (typeof page.nextCursor === 'string' || page.nextCursor === null) {
            this.store.updateEnvOperation(op.operationId,
              { upstreamEventCursor: page.nextCursor as string | null });
          }
        } catch {
          // Upstream offline: fall back to the locally persisted event log.
        }
      }
    }
    const afterSeq = this.decodeCursor(query.cursor);
    const rows = this.store.listOperationEvents(operationId, afterSeq, limit + 1);
    const pageRows = rows.slice(0, limit);
    const nextCursor = rows.length > limit ? this.encodeCursor(pageRows[pageRows.length - 1]!.seq) : null;
    const data: PersonalOperationEventsPage = {
      events: pageRows.map((row) => ({
        eventId: `oev-${row.seq}`,
        occurredAt: row.occurredAt,
        kind: row.kind ?? null,
        state: (row.state as PersonalOperationEventsPage['events'][number]['state']) ?? null,
        message: row.message ?? null,
      })),
      nextCursor,
    };
    return { status: 200, body: this.envelope(data, { observedAt: op.lastObservedAt }) };
  }

  /** Opaque local cursor: base64url of the last served seq. */
  private encodeCursor(seq: number): string {
    return Buffer.from(JSON.stringify({ seq }), 'utf8').toString('base64url');
  }

  private decodeCursor(cursor: string | undefined): number {
    if (cursor === undefined) return 0;
    try {
      const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { seq?: number };
      if (!parsed || typeof parsed.seq !== 'number' || !Number.isSafeInteger(parsed.seq) || parsed.seq < 0) {
        throw invalid('invalid events cursor');
      }
      return parsed.seq;
    } catch (error) {
      if (error instanceof ManagementError) throw error;
      throw invalid('invalid events cursor');
    }
  }

  async cancelEnvironmentOperation(operationId: string, body: unknown, ctx: GatewayCallContext): Promise<RouteOutcome> {
    const request = this.writeBody<PersonalOperationCancelRequest>(
      { action: 'OPERATION_CANCEL', operationId, key: (body as any)?.requestKey, body });
    return this.idempotent('OPERATION_CANCEL', request.requestKey, body, ctx.requestId, operationId,
      async () => {
        let op = this.store.getEnvOperation(operationId);
        if (!op) throw new ManagementError(404, 'OPERATION_NOT_FOUND', 'Unknown operationId', false);
        this.checkRevision(request.expectedRevision, op.revision);
        if (TERMINAL_STATES.has(op.state)) {
          throw conflict('OPERATION_NOT_CANCELABLE', `operation is already ${op.state}`);
        }
        this.store.appendOperationEvent({
          operationId, kind: 'CANCEL_REQUESTED', state: op.state,
          message: 'cancel requested',
        });
        if (op.upstreamOperationId) {
          const connection = this.store.getConnection(op.connectionId);
          if (connection?.envBaseUrl) {
            const receipt = await this.hub.handle(connection).env().cancelOperation(
              op.upstreamOperationId,
              { requestKey: request.requestKey, expectedRevision: request.expectedRevision },
            );
            // §5.1 addendum: cancel receipt reuses the operation view. When the
            // receipt carries no state the last observed state stands — the
            // cancel intent is recorded and the next query reconciles.
            const state = (receipt as Record<string, unknown>).state;
            if (typeof state === 'string') {
              op = this.store.updateEnvOperation(operationId, {
                state: this.normalizeState(state),
              });
            } else {
              op = this.store.updateEnvOperation(operationId, {});
            }
          }
        } else {
          // Never dispatched upstream — local refusal: the stop is proven.
          op = this.store.updateEnvOperation(operationId, { state: 'CANCELED' });
          this.store.appendOperationEvent({ operationId, kind: 'CANCELED', state: 'CANCELED' });
        }
        return {
          status: 200,
          body: this.envelope(this.opView(op!)),
        };
      });
  }

  /** NEEDS_INPUT continuation (freeze §5.1 addendum route). */
  async submitOperationInput(operationId: string, body: unknown, ctx: GatewayCallContext): Promise<RouteOutcome> {
    const request = this.validOperationInputBody(body);
    return this.idempotent('OPERATION_INPUT', request.requestKey, body, ctx.requestId, operationId,
      async () => {
        let op = this.store.getEnvOperation(operationId);
        if (!op) throw new ManagementError(404, 'OPERATION_NOT_FOUND', 'Unknown operationId', false);
        this.checkRevision(request.expectedRevision, op.revision);
        if (op.state !== 'NEEDS_INPUT') {
          throw conflict('OPERATION_NOT_AWAITING_INPUT', `operation is ${op.state}, not NEEDS_INPUT`);
        }
        if (!op.upstreamOperationId) {
          throw conflict('OPERATION_NOT_AWAITING_INPUT',
            'operation has no upstream continuation channel');
        }
        const connection = this.store.getConnection(op.connectionId);
        if (!connection?.envBaseUrl) {
          throw conflict('CHANNEL_NOT_PROVISIONED',
            'operation connection has no managed-environment channel');
        }
        const receipt = await this.hub.handle(connection).env().submitOperationInput(
          op.upstreamOperationId,
          {
            inputRequestId: request.inputRequestId,
            operationId: op.upstreamOperationId,
            expectedRevision: request.expectedRevision,
            commandKey: request.requestKey,
            payload: request.payload,
            payloadDigest: canonicalDigest(request.payload),
          },
        );
        const state = (receipt as Record<string, unknown>).state;
        op = this.store.updateEnvOperation(operationId,
          typeof state === 'string' ? { state: this.normalizeState(state) } : {});
        this.store.appendOperationEvent({
          operationId, kind: 'INPUT_ACCEPTED', state: op.state,
          message: `input ${request.inputRequestId} forwarded`,
        });
        return { status: 200, body: this.envelope(this.opView(op)) };
      });
  }

  /** Local validation for the §5.1 route until P0 adds it to the union. */
  private validOperationInputBody(body: unknown): {
    requestKey: string; inputRequestId: string; expectedRevision?: string; payload: unknown;
  } {
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw invalid();
    const value = body as Record<string, unknown>;
    const allowed = ['requestKey', 'inputRequestId', 'expectedRevision', 'payload'];
    if (Object.keys(value).some((key) => !allowed.includes(key))) throw invalid();
    if (typeof value.requestKey !== 'string' || !ID.test(value.requestKey)) throw invalid();
    if (typeof value.inputRequestId !== 'string' || !ID.test(value.inputRequestId)) throw invalid();
    if (value.expectedRevision !== undefined
        && (typeof value.expectedRevision !== 'string' || !DECIMAL.test(value.expectedRevision))) {
      throw invalid();
    }
    try {
      if (new TextEncoder().encode(JSON.stringify(value.payload ?? null)).length > 16384) {
        throw invalid('payload exceeds 16 KiB');
      }
    } catch { throw invalid('payload must be JSON-serializable'); }
    return {
      requestKey: value.requestKey,
      inputRequestId: value.inputRequestId,
      expectedRevision: value.expectedRevision as string | undefined,
      payload: value.payload,
    };
  }

  // ------------------------------------------------------------------
  // Workers
  // ------------------------------------------------------------------

  private async workerView(row: ConnectionRow): Promise<PersonalWorkerView> {
    const subject = `worker:${row.connectionId}`;
    const caps = connectionCapabilities(row, !!this.actionRunner);
    let connectionState = 'CONFIGURED';
    let observedAt = this.now();
    const reasonCodes: string[] = [];
    let version: string | undefined;
    let nativeCores:string[]=[];
    try {
      if (row.kind === 'DAEMON' && row.envBaseUrl) {
        const probe = await this.hub.handle(row).env().probe();
        connectionState = probe.reachable ? 'CONNECTED' : 'UNREACHABLE';
        if (!probe.reachable) reasonCodes.push('BACKEND_UNAVAILABLE');
      } else if(row.kind==='WORKER_LOCAL'){
        const identity=await this.hub.local<{schemaVersion:string}>(row.connectionId,'GET','/identity');
        const engines=await this.hub.local<{items:{engineId:string}[]}>(row.connectionId,'GET','/engines');
        connectionState='CONNECTED';version=identity.schemaVersion;nativeCores=engines.items.map(e=>e.engineId.toUpperCase());
      } else if (row.baseUrl) {
        const capsResponse = await this.hub.handle(row).acs().getCapabilities();
        connectionState = 'CONNECTED';
        version = `acs-protocol/${capsResponse.protocolVersion}`;
      } else {
        connectionState = 'UNCONFIGURED';
        reasonCodes.push('BACKEND_UNAVAILABLE');
      }
      this.store.putFacts(subject, 'CONNECTION', [{
        factKey: 'connection', kind: 'DEPENDENCY_ENTRY', name: row.connectionId,
        state: connectionState, detail: version, source: row.kind, 
      }], observedAt);
    } catch (error) {
      const stored = this.store.listFacts(subject);
      const last = stored.find((f) => f.factKey === 'connection');
      connectionState = 'UNREACHABLE';
      observedAt = last?.observedAt ?? observedAt;
      reasonCodes.push('BACKEND_UNAVAILABLE');
      if (error instanceof ManagementError && error.code.startsWith('CREDENTIAL')) {
        connectionState = 'CREDENTIAL_REQUIRED';
        reasonCodes.length = 0;
        reasonCodes.push('CREDENTIAL_REQUIRED');
      }
      this.store.putFacts(subject, 'CONNECTION', [{
        factKey: 'connection', kind: 'DEPENDENCY_ENTRY', name: row.connectionId,
        state: connectionState, source: row.kind,
      }], this.now());
    }
    return {
      workerId: row.connectionId,
      displayName: row.displayName ?? null,
      connectionKind: row.kind,
      connectionState,
      capabilities: { ...caps },
      supportedCores: row.kind==='WORKER_LOCAL'?nativeCores:row.baseUrl ? ['ACS'] : [],
      version: version ?? null,
      platform: null,
      operatorState: row.kind === 'DAEMON'
        ? (connectionState === 'CONNECTED' ? 'OPERATOR_CHANNEL_READY' : 'UNKNOWN')
        : 'NOT_PROVISIONED',
      revision: String(row.revision),
      observedAt,
      reasonCodes,
    };
  }

  async listWorkers(): Promise<RouteOutcome> {
    const workers: PersonalWorkerView[] = [];
    for (const row of this.store.listConnections()) workers.push(await this.workerView(row));
    return { status: 200, body: this.envelope(workers) };
  }

  async getWorker(workerId: string): Promise<RouteOutcome> {
    const row = this.store.getConnection(workerId);
    if (!row) throw new ManagementError(404, 'WORKER_NOT_FOUND', 'Unknown worker id', false);
    return { status: 200, body: this.envelope(await this.workerView(row)) };
  }

  // ------------------------------------------------------------------
  // Attention aggregation (overview): merged by root cause
  // ------------------------------------------------------------------

  private async attention(ctx: GatewayCallContext): Promise<PersonalAttentionItem[]> {
    const merged = new Map<string, PersonalAttentionItem>();
    const add = (item: PersonalAttentionItem) => {
      const key = `${item.kind}|${item.refId ?? ''}|${item.projectId ?? ''}|${item.reasonCode ?? ''}`;
      const prior = merged.get(key);
      if (!prior || ((item.observedAt ?? '') > (prior.observedAt ?? ''))) merged.set(key, item);
    };
    const now = this.now();
    // Upstream attention (ACS-capable connections only).
    for (const row of this.store.listConnections()) {
      if (!row.baseUrl||row.kind==='WORKER_LOCAL') continue;
      try {
        const items = await this.hub.handle(row).acs(await ctx.acsSessionFor(row.connectionId)).listAttention();
        for (const item of items.slice(0, 64)) {
          add({
            kind: 'UPSTREAM_ATTENTION',
            refId: item.attentionId ?? item.sourceId ?? null,
            projectId: this.store.findProjectByRef(row.connectionId, item.sourceId ?? '')?.projectId ?? null,
            reasonCode: null,
            message: (item.summary ?? item.attentionType ?? 'upstream attention').slice(0, 512),
            observedAt: item.createdAt ?? now,
          });
        }
      } catch {
        add({
          kind: 'CONNECTION_UNREACHABLE', refId: row.connectionId,
          reasonCode: 'BACKEND_UNAVAILABLE',
          message: `connection ${row.connectionId} is not reachable; last known facts are shown where stored`,
          observedAt: now,
        });
      }
      // Deliveries needing a decision (registered projects on this connection).
      for (const project of this.store.listProjects().filter((p) => p.connectionId === row.connectionId)) {
        try {
          const page = await this.hub.handle(row).acs(await ctx.acsSessionFor(row.connectionId))
            .listProjectDeliveries(project.projectRef, { limit: 16 });
          for (const delivery of page.items ?? []) {
            if (['NEEDS_ATTENTION', 'CONFLICT', 'FAILED', 'UNKNOWN'].includes(delivery.state)) {
              add({
                kind: 'DELIVERY_PENDING', refId: delivery.deliveryId, projectId: project.projectId,
                reasonCode: null,
                message: `delivery ${delivery.deliveryId} is ${delivery.state}`,
                observedAt: delivery.updatedAt ?? delivery.createdAt ?? now,
              });
            }
          }
        } catch { /* delivery listing is best-effort for the digest */ }
      }
    }
    // Pending environment operations.
    for (const op of this.store.listPendingEnvOperations()) {
      if (op.state === 'NEEDS_INPUT') {
        add({ kind: 'OPERATION_NEEDS_INPUT', refId: op.operationId, operationId: op.operationId,
          projectId: op.projectId, reasonCode: (op.reasonCode as PersonalAttentionItem['reasonCode']) ?? null,
          message: `environment ${op.kind.toLowerCase()} is waiting for input`, observedAt: op.updatedAt });
      } else if (op.state === 'UNKNOWN') {
        add({ kind: 'OPERATION_UNKNOWN', refId: op.operationId, operationId: op.operationId,
          projectId: op.projectId, reasonCode: 'EFFECT_UNKNOWN',
          message: `environment ${op.kind.toLowerCase()} effect is unknown; reconcile by original key`,
          observedAt: op.updatedAt });
      }
    }
    // Stored missing facts summarized per project (no fresh probing on overview).
    for (const project of this.store.listProjects()) {
      const missingCount = this.store.listFacts(`project:${project.projectId}`)
        .filter((f) => f.state === 'MISSING').length;
      if (missingCount) {
        add({ kind: 'PROJECT_ENVIRONMENT_INCOMPLETE', refId: project.projectId,
          projectId: project.projectId, reasonCode: 'TOOLCHAIN_MISSING',
          message: `${missingCount} recorded requirement(s) missing on ${project.displayName ?? project.projectRef}`,
          observedAt: project.updatedAt });
      }
    }
    return [...merged.values()].slice(0, 128);
  }

  // ------------------------------------------------------------------
  // Task actions (history + run/save split semantics)
  // ------------------------------------------------------------------

  private actionIdFor(targetId: string, action: string): string {
    const digest = createHash('sha256').update(`${targetId}:${action}`, 'utf8').digest('hex').slice(0, 12);
    return `bp.${action.toLowerCase()}.${digest}`;
  }

  private actionView(row: TaskActionRow): AdaptiveActionDescriptor {
    return {
      actionId: row.actionId,
      actionVersion: null,
      name: row.name ?? row.actionId,
      scope: row.scope ?? 'TASK',
      objective: null,
      targetDirectory: row.sourceTarget ?? null,
      interpreter: null,
      timeoutMillis: null,
      provenance: row.provenance ?? null,
      planDigest: row.planDigest ?? null,
      saved: !!row.saved,
      revision: String(row.revision),
    };
  }

  async listTaskActions(taskId: string, ctx: GatewayCallContext): Promise<RouteOutcome> {
    const task = this.store.getTask(taskId);
    if (!task) throw new ManagementError(404, 'TASK_NOT_FOUND', 'Unknown task id', false);
    const rows = new Map<string, TaskActionRow>();
    for (const row of this.store.listTaskActions(taskId)) rows.set(row.actionId, row);
    if (task.projectId) {
      try {
        const { project, handle } = this.hub.forProject(task.projectId);
        if (handle.hasAcs()) {
          const plan = await handle.acs(await ctx.acsSessionFor(project.connectionId))
            .getProjectBuildPlan(project.projectRef);
          for (const target of plan.targets ?? []) {
            for (const [action, view] of Object.entries(target.actions ?? {})) {
              if (view.disabled) continue;
              const actionId = this.actionIdFor(target.targetId, action);
              const existing = rows.get(actionId);
              // Refresh the alias when the plan fingerprint moved; a saved
              // (user-owned) row keeps its saved flag and name.
              if (!existing || (!existing.saved && existing.planDigest !== (view.planFingerprint ?? undefined))) {
                rows.set(actionId, this.store.upsertTaskAction({
                  taskId, actionId,
                  name: existing?.saved ? existing.name : `${target.tool} ${action}`,
                  scope: existing?.scope ?? 'PROJECT', provenance: 'BUILD_PLAN',
                  sourceTarget: target.targetId, sourceAction: action,
                  planDigest: view.planFingerprint ?? undefined,
                }));
              }
            }
          }
        }
      } catch { /* build plan unavailable: registry rows still served */ }
    }
    return {
      status: 200,
      body: this.envelope([...rows.values()].map((row) => this.actionView(row)),
        { supportedActions: this.actionRunner ? ['ACTION_RUN', 'ACTION_SAVE'] : ['ACTION_SAVE'] }),
    };
  }

  async runTaskAction(taskId: string, actionId: string, body: unknown, ctx: GatewayCallContext): Promise<RouteOutcome> {
    const request = this.writeBody<PersonalActionRunRequest>(
      { action: 'ACTION_RUN', taskId, actionId, key: (body as any)?.requestKey, body });
    return this.idempotent('ACTION_RUN', request.requestKey, body, ctx.requestId, `${taskId}:${actionId}`,
      async () => {
        const task = this.store.getTask(taskId);
        if (!task) throw new ManagementError(404, 'TASK_NOT_FOUND', 'Unknown task id', false);
        const action = this.store.getTaskAction(taskId, actionId);
        if (!action) throw new ManagementError(404, 'ACTION_NOT_FOUND', 'Unknown actionId for this task', false);
        this.checkRevision(request.expectedRevision, task.revision);
        if (!this.actionRunner) {
          return {
            status: 409,
            body: { error: { code: 'ADAPTIVE_ACTION_UNAVAILABLE',
              message: 'no adaptive-action execution provider is registered on this install',
              retryable: false, requestId: ctx.requestId } },
          };
        }
        const project = task.projectId ? this.store.getProject(task.projectId) : undefined;
        const receipt = await this.actionRunner.run({
          taskId, actionId, action, project,
          inputs: request.inputs, requestKey: request.requestKey,
          observedAt: this.now(),
        });
        if (receipt.trialId) {
          this.store.insertActionTrial({
            trialId: receipt.trialId, requestKey: request.requestKey, taskId, actionId,
            planDigest: receipt.planDigest ?? undefined,
            bindingDigest: receipt.bindingDigest ?? undefined,
            exitStatus: receipt.exitStatus === undefined || receipt.exitStatus === null
              ? undefined : String(receipt.exitStatus),
            evidenceVerdict: receipt.evidenceVerdict ?? undefined,
            outputRefs: receipt.outputRefs ?? [], reportRefs: receipt.reportRefs ?? [],
            startedAt: receipt.startedAt ?? undefined, endedAt: receipt.endedAt ?? undefined,
          });
        }
        return { status: 200, body: this.envelope(receipt) };
      });
  }

  async saveTaskAction(taskId: string, actionId: string, body: unknown, ctx: GatewayCallContext): Promise<RouteOutcome> {
    const request = this.writeBody<PersonalActionSaveRequest>(
      { action: 'ACTION_SAVE', taskId, actionId, key: (body as any)?.requestKey, body });
    return this.idempotent('ACTION_SAVE', request.requestKey, body, ctx.requestId, `${taskId}:${actionId}`,
      async () => {
        const task = this.store.getTask(taskId);
        if (!task) throw new ManagementError(404, 'TASK_NOT_FOUND', 'Unknown task id', false);
        if (!this.store.getTaskAction(taskId, actionId)) {
          throw new ManagementError(404, 'ACTION_NOT_FOUND', 'Unknown actionId for this task', false);
        }
        this.checkRevision(request.expectedRevision, task.revision);
        const row = this.store.upsertTaskAction({
          taskId, actionId, name: request.name, scope: request.scope,
          provenance: 'USER_SAVE', saved: true,
        });
        return { status: 200, body: this.envelope(this.actionView(row)) };
      });
  }

  // ------------------------------------------------------------------
  // Reports (P7 provider seam — P5 owns the routes, not the provider)
  // ------------------------------------------------------------------

  private reports(): PersonalReportProvider {
    if (!this.reportProvider) {
      throw new ManagementError(503, 'REPORT_PROVIDER_NOT_CONFIGURED',
        'No report provider is registered on this install', true);
    }
    return this.reportProvider;
  }

  async listReports(): Promise<RouteOutcome> {
    const items = this.reportProvider ? await this.reportProvider.listReports() : [];
    return {
      status: 200,
      body: this.envelope(items, {
        supportedActions: this.reportProvider ? ['REPORT_CREATE'] : [],
        reasonCodes: this.reportProvider ? [] : ['REPORT_PROVIDER_NOT_CONFIGURED'],
      }),
    };
  }

  async createReport(body: unknown, ctx: GatewayCallContext): Promise<RouteOutcome> {
    const request = this.writeBody<PersonalReportRequest>(
      { action: 'REPORT_CREATE', key: (body as any)?.requestKey, body });
    return this.idempotent('REPORT_CREATE', request.requestKey, body, ctx.requestId, undefined,
      async () => {
        const descriptor = await this.reports().createReport(request);
        return { status: 200, body: this.envelope(descriptor) };
      });
  }

  async getReport(reportId: string): Promise<RouteOutcome> {
    const descriptor = await this.reports().getReport(reportId);
    if (!descriptor) throw new ManagementError(404, 'REPORT_NOT_FOUND', 'Unknown report id', false);
    return { status: 200, body: this.envelope(descriptor) };
  }

  async listReportFiles(reportId: string): Promise<RouteOutcome> {
    return { status: 200, body: this.envelope(await this.reports().listReportFiles(reportId)) };
  }

  // ------------------------------------------------------------------
  // Write-body validation via the frozen operation whitelist.
  // ------------------------------------------------------------------

  private writeBody<T extends { requestKey: string }>(operation: Record<string, unknown>): T {
    const body = operation.body;
    if (!validPersonalOperation(operation)) throw invalid();
    return body as T;
  }
}
