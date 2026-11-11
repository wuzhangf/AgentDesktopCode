/**
 * Persistent registry for the personal management gateway
 * (PAE task §8 item 1; design §10.2).
 *
 * Owns `data/management.db` — the writable store beside read-only
 * `observations.db` (which this module never opens). Registry contents are
 * exactly: provisioned connections/workers, project associations, default
 * environment selections, task organization, pending/executed operations,
 * the idempotency ledger and last-known readiness observations. It is NOT an
 * authority for ACS/Worker execution state — upstream facts are cached with
 * `observed_at` + `source`, and stale facts are presented as stale rather
 * than auto-failed.
 *
 * The store is also the migration registrar (task §8 item 8): P5 ships the
 * core schema; P7 registers report tables through `registerManagementMigration`
 * or `extraMigrations`, never a second database.
 */
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { runMigrations, type ManagementMigration } from './migrations';
import { invalid } from './errors';
import { receiptRevisionValue } from '../../../codeagent-desktop/packages/protocol/src/validators';

const SCHEMA_VERSION = 1;

/** P5 core schema (namespace 'p5-core'). Versions 1..99 reserved for P5. */
const P5_MIGRATIONS: readonly ManagementMigration[] = [{
  version: SCHEMA_VERSION,
  namespace: 'p5-core',
  name: 'registry_tables',
  up(db) {
    db.exec(`
      CREATE TABLE management_meta(
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      -- Provisioned worker/executor connections (install-side only; the
      -- browser submits registered ids, never URLs or tokens).
      CREATE TABLE connections(
        connection_id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        display_name TEXT,
        base_url TEXT,
        token_ref TEXT,
        env_base_url TEXT,
        env_token_ref TEXT,
        registered_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 1
      );
      -- Project registrations: a local projectId bound to an upstream
      -- projectRef on one fixed connection.
      CREATE TABLE projects(
        project_id TEXT PRIMARY KEY,
        project_ref TEXT NOT NULL,
        connection_id TEXT NOT NULL REFERENCES connections(connection_id),
        display_name TEXT,
        notes TEXT,
        registered_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 1,
        UNIQUE(connection_id, project_ref)
      );
      -- Default environment selection per project (a user choice, not a
      -- readiness claim).
      CREATE TABLE project_environments(
        project_id TEXT PRIMARY KEY REFERENCES projects(project_id),
        environment_id TEXT,
        environment_revision TEXT,
        plan_digest TEXT,
        selected_at TEXT,
        updated_at TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 1
      );
      CREATE TABLE tasks(
        task_id TEXT PRIMARY KEY,
        project_id TEXT REFERENCES projects(project_id),
        display_name TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 1
      );
      -- Saved adaptive actions + alias rows resolving build-plan actions.
      CREATE TABLE task_actions(
        task_id TEXT NOT NULL,
        action_id TEXT NOT NULL,
        name TEXT,
        scope TEXT,
        provenance TEXT,
        source_target TEXT,
        source_action TEXT,
        plan_digest TEXT,
        saved INTEGER NOT NULL DEFAULT 0,
        saved_at TEXT,
        updated_at TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 1,
        PRIMARY KEY (task_id, action_id)
      );
      -- Every accepted write key, before dispatch. Replay returns the
      -- recorded response; same key + different body is a 409 conflict.
      CREATE TABLE request_ledger(
        request_key TEXT PRIMARY KEY,
        route TEXT NOT NULL,
        body_digest TEXT NOT NULL,
        subject_id TEXT,
        state TEXT NOT NULL,
        response_status INTEGER,
        response_body TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      -- Environment operations: our durable record linked to the upstream
      -- operation by upstream_operation_id (or our own requestKey upstream).
      CREATE TABLE env_operations(
        operation_id TEXT PRIMARY KEY,
        request_key TEXT NOT NULL UNIQUE REFERENCES request_ledger(request_key),
        kind TEXT NOT NULL,
        project_id TEXT NOT NULL REFERENCES projects(project_id),
        connection_id TEXT NOT NULL,
        plan_digest TEXT,
        environment_id TEXT,
        environment_revision TEXT,
        expected_revision TEXT,
        state TEXT NOT NULL,
        reason_code TEXT,
        result_ref TEXT,
        upstream_operation_id TEXT,
        upstream_event_cursor TEXT,
        progress REAL,
        revision INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_observed_at TEXT
      );
      CREATE INDEX env_operations_project ON env_operations(project_id);
      CREATE TABLE operation_events(
        operation_id TEXT NOT NULL REFERENCES env_operations(operation_id),
        seq INTEGER NOT NULL,
        occurred_at TEXT NOT NULL,
        kind TEXT,
        state TEXT,
        message TEXT,
        upstream_event_id TEXT,
        PRIMARY KEY (operation_id, seq)
      );
      -- Last-known observations keyed by subject+layer so an offline
      -- upstream shows stale facts with their real observedAt, never
      -- fabricated freshness.
      CREATE TABLE readiness_facts(
        subject TEXT NOT NULL,
        layer TEXT NOT NULL,
        fact_key TEXT NOT NULL,
        kind TEXT,
        name TEXT,
        version TEXT,
        state TEXT,
        detail TEXT,
        source TEXT,
        observed_at TEXT NOT NULL,
        PRIMARY KEY (subject, layer, fact_key)
      );
      CREATE TABLE action_trials(
        trial_id TEXT PRIMARY KEY,
        request_key TEXT NOT NULL UNIQUE REFERENCES request_ledger(request_key),
        task_id TEXT NOT NULL,
        action_id TEXT NOT NULL,
        plan_digest TEXT,
        binding_digest TEXT,
        exit_status TEXT,
        evidence_verdict TEXT,
        output_refs TEXT,
        report_refs TEXT,
        started_at TEXT,
        ended_at TEXT,
        created_at TEXT NOT NULL
      );
    `);
  },
}, {
  version: 2, namespace: 'p5-core', name: 'task_launch_facts',
  up(db) { db.exec(`ALTER TABLE tasks ADD COLUMN launch_json TEXT;
    ALTER TABLE tasks ADD COLUMN request_key TEXT;
    CREATE UNIQUE INDEX task_request_key ON tasks(request_key);
    CREATE INDEX tasks_created ON tasks(created_at, task_id);`); }
}, {
  // Reliable task control (PAUSE/RESUME/STOP): every frozen control request
  // is durably bound to its ledger row and launch facts BEFORE the first
  // source dispatch. request_key == commandId == source Idempotency-Key.
  version: 3, namespace: 'p5-core', name: 'task_control_requests',
  up(db) {
    db.exec(`
      CREATE TABLE task_control_requests(
        request_key TEXT PRIMARY KEY REFERENCES request_ledger(request_key),
        task_id TEXT NOT NULL REFERENCES tasks(task_id),
        request_json TEXT NOT NULL,
        source_binding_json TEXT NOT NULL,
        source_request_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        dispatch_started_at TEXT,
        last_receipt_json TEXT,
        receipt_observed_at TEXT,
        source_rejection_json TEXT,
        last_source_error_json TEXT
      );
      CREATE INDEX task_control_requests_task ON task_control_requests(task_id, created_at, request_key);
    `);
  }
}, {
  version: 4, namespace: 'personal-interaction', name: 'requests_and_message_links',
  up(db) { db.exec(`
    CREATE TABLE personal_interaction_requests(
      request_key TEXT PRIMARY KEY REFERENCES request_ledger(request_key),
      task_id TEXT NOT NULL REFERENCES tasks(task_id),
      request_json TEXT NOT NULL, source_binding_json TEXT NOT NULL,
      wire_body TEXT NOT NULL, created_at TEXT NOT NULL, dispatch_started_at TEXT,
      observation_json TEXT
    );
    CREATE INDEX interaction_task ON personal_interaction_requests(task_id, created_at);
    CREATE TABLE personal_task_messages(
      task_id TEXT NOT NULL REFERENCES tasks(task_id), client_message_id TEXT NOT NULL,
      message_id TEXT NOT NULL, run_id TEXT, observed_at TEXT NOT NULL,
      PRIMARY KEY(task_id, message_id)
    );
    CREATE INDEX task_message_run ON personal_task_messages(task_id, run_id);
  `); }
}, {
  version: 5, namespace: 'personal-interaction', name: 'engagement_requests',
  up(db) {db.exec(`CREATE TABLE personal_engagement_requests(
    request_key TEXT PRIMARY KEY REFERENCES request_ledger(request_key), task_id TEXT NOT NULL REFERENCES tasks(task_id),
    kind TEXT NOT NULL, request_json TEXT NOT NULL, binding_json TEXT NOT NULL, facts_json TEXT NOT NULL,
    created_at TEXT NOT NULL);
    CREATE INDEX engagement_task ON personal_engagement_requests(task_id, created_at, request_key);`);}
}, {
  version: 6, namespace: 'personal-collaboration', name: 'request_journal',
  up(db) { db.exec(`CREATE TABLE personal_collaboration_requests(
    request_key TEXT PRIMARY KEY REFERENCES request_ledger(request_key), task_id TEXT NOT NULL REFERENCES tasks(task_id),
    request_json TEXT NOT NULL, binding_json TEXT NOT NULL, facts_json TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE INDEX collaboration_task ON personal_collaboration_requests(task_id, created_at);`); }
}, {
  version: 7, namespace: 'personal-native', name: 'request_journal',
  up(db) {db.exec(`CREATE TABLE personal_native_requests(
    request_key TEXT PRIMARY KEY REFERENCES request_ledger(request_key), task_id TEXT NOT NULL REFERENCES tasks(task_id),
    request_json TEXT NOT NULL, binding_json TEXT NOT NULL, dispatch_started_at TEXT,
    observation_json TEXT, source_error TEXT, source_rejection TEXT, created_at TEXT NOT NULL);`);}
}];

import type { ConnectionRow, ProjectRow } from '../../../packages/personal-gateway-core/src/connection';
export type { ConnectionRow, ProjectRow };

export interface ProjectEnvironmentRow {
  projectId: string;
  environmentId?: string;
  environmentRevision?: string;
  planDigest?: string;
  selectedAt?: string;
  updatedAt: string;
  revision: number;
}

export interface TaskRow {
  launchJson?: string;
  requestKey?: string;
  taskId: string;
  projectId?: string;
  displayName?: string;
  createdAt: string;
  updatedAt: string;
  revision: number;
}

export interface TaskActionRow {
  taskId: string;
  actionId: string;
  name?: string;
  scope?: string;
  provenance?: string;
  sourceTarget?: string;
  sourceAction?: string;
  planDigest?: string;
  saved: number;
  savedAt?: string;
  updatedAt: string;
  revision: number;
}

/** Frozen reliable-control request (design §6.1): the personal request, the
 * source identity it was bound to and the exact wire body sent upstream, plus
 * the last confirmed observation (receipt / rejection / dispatch error). */
export interface ControlRequestRow {
  requestKey: string;
  taskId: string;
  requestJson: string;
  sourceBindingJson: string;
  sourceRequestJson: string;
  createdAt: string;
  dispatchStartedAt?: string;
  lastReceiptJson?: string;
  receiptObservedAt?: string;
  sourceRejectionJson?: string;
  lastSourceErrorJson?: string;
}

export interface LedgerRow {
  requestKey: string;
  route: string;
  bodyDigest: string;
  subjectId?: string;
  state: 'PENDING' | 'SETTLED';
  responseStatus?: number;
  responseBody?: string;
  createdAt: string;
  updatedAt: string;
}

export interface EnvOperationRow {
  operationId: string;
  requestKey: string;
  kind: string;
  projectId: string;
  connectionId: string;
  planDigest?: string;
  environmentId?: string;
  environmentRevision?: string;
  expectedRevision?: string;
  state: string;
  reasonCode?: string;
  resultRef?: string;
  upstreamOperationId?: string;
  upstreamEventCursor?: string;
  progress?: number;
  revision: number;
  createdAt: string;
  updatedAt: string;
  lastObservedAt?: string;
}

export interface OperationEventRow {
  operationId: string;
  seq: number;
  occurredAt: string;
  kind?: string;
  state?: string;
  message?: string;
  upstreamEventId?: string;
}

export interface ReadinessFactRow {
  subject: string;
  layer: string;
  factKey: string;
  kind?: string;
  name?: string;
  version?: string;
  state?: string;
  detail?: string;
  source?: string;
  observedAt: string;
}

export interface ManagementStoreOptions {
  /** Database file path (`data/management.db`); `:memory:` for tests. */
  path: string;
  /** Extra migrations (P7 report tables etc.), merged with registered ones. */
  extraMigrations?: readonly ManagementMigration[];
  /** Clock for persisted timestamps; injectable for tests. */
  now?: () => Date;
}

function str(value: unknown): string | undefined {
  return value === null || value === undefined ? undefined : String(value);
}

/** receiptRevision of a stored receipt JSON, as bigint; unparsable → 0n. */
function controlRevision(receiptJson: string): bigint {
  try {
    const revision = (JSON.parse(receiptJson) as { receiptRevision?: unknown }).receiptRevision;
    return typeof revision === 'string' ? receiptRevisionValue(revision) : 0n;
  } catch {
    return 0n;
  }
}

export class ManagementStore {
  readonly db: DatabaseSync;
  readonly controlPlaneId: string;
  private readonly nowFn: () => Date;

  constructor(options: ManagementStoreOptions) {
    this.nowFn = options.now ?? (() => new Date());
    if (options.path !== ':memory:') mkdirSync(dirname(options.path), { recursive: true });
    // Writable connection; WAL keeps reads unblocked during writes. This is
    // the ONLY writable store in the app — observations.db stays untouched.
    this.db = new DatabaseSync(options.path, { timeout: 5000 });
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA foreign_keys = ON');
    runMigrations(this.db, P5_MIGRATIONS, options.extraMigrations ?? []);
    // Stable install identity (design §10.2): generated once, never rotated.
    const existing = this.meta('controlPlaneId');
    if (existing) {
      this.controlPlaneId = existing;
    } else {
      this.controlPlaneId = randomUUID();
      this.setMeta('controlPlaneId', this.controlPlaneId);
      this.setMeta('createdAt', this.now());
    }
  }

  now(): string { return this.nowFn().toISOString(); }

  close(): void { this.db.close(); }

  /** Monotonic registry revision surfaced as meta.revision. */
  registryRevision(): number {
    return Number(this.meta('registryRevision') ?? '0');
  }

  private bump(): number {
    const next = this.registryRevision() + 1;
    this.setMeta('registryRevision', String(next));
    return next;
  }

  meta(key: string): string | undefined {
    const row = this.db.prepare('SELECT value v FROM management_meta WHERE key = ?').get(key) as { v: string } | undefined;
    return row?.v;
  }

  setMeta(key: string, value: string): void {
    this.db.prepare('INSERT INTO management_meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, value);
  }

  /** Run fn inside one transaction; bumps the registry revision on commit. */
  transact<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      this.bump();
      this.db.exec('COMMIT');
      return out;
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* rolled back */ }
      throw error;
    }
  }

  // ---- connections / workers ----

  upsertConnection(input: {
    connectionId: string; kind: string; displayName?: string;
    baseUrl?: string; tokenRef?: string; envBaseUrl?: string; envTokenRef?: string;
  }): ConnectionRow {
    const now = this.now();
    return this.transact(() => {
      this.db.prepare(`INSERT INTO connections(connection_id, kind, display_name, base_url, token_ref, env_base_url, env_token_ref, registered_at, updated_at, revision)
        VALUES(?,?,?,?,?,?,?,?,?,1)
        ON CONFLICT(connection_id) DO UPDATE SET
          kind = excluded.kind, display_name = excluded.display_name,
          base_url = excluded.base_url, token_ref = excluded.token_ref,
          env_base_url = excluded.env_base_url, env_token_ref = excluded.env_token_ref,
          updated_at = excluded.updated_at, revision = connections.revision + 1`)
        .run(input.connectionId, input.kind, input.displayName ?? null, input.baseUrl ?? null,
          input.tokenRef ?? null, input.envBaseUrl ?? null, input.envTokenRef ?? null, now, now);
      return this.getConnection(input.connectionId)!;
    });
  }

  getConnection(connectionId: string): ConnectionRow | undefined {
    const row = this.db.prepare('SELECT * FROM connections WHERE connection_id = ?').get(connectionId) as any;
    return row && {
      connectionId: row.connection_id, kind: row.kind, displayName: str(row.display_name),
      baseUrl: str(row.base_url), tokenRef: str(row.token_ref), envBaseUrl: str(row.env_base_url),
      envTokenRef: str(row.env_token_ref), registeredAt: row.registered_at, updatedAt: row.updated_at,
      revision: row.revision,
    };
  }

  listConnections(): ConnectionRow[] {
    return (this.db.prepare('SELECT * FROM connections ORDER BY connection_id').all() as any[])
      .map((row) => ({
        connectionId: row.connection_id, kind: row.kind, displayName: str(row.display_name),
        baseUrl: str(row.base_url), tokenRef: str(row.token_ref), envBaseUrl: str(row.env_base_url),
        envTokenRef: str(row.env_token_ref), registeredAt: row.registered_at, updatedAt: row.updated_at,
        revision: row.revision,
      }));
  }

  // ---- projects ----

  insertProject(input: {
    projectId: string; projectRef: string; connectionId: string;
    displayName?: string; notes?: string;
  }): ProjectRow {
    const now = this.now();
    return this.transact(() => {
      this.db.prepare(`INSERT INTO projects(project_id, project_ref, connection_id, display_name, notes, registered_at, updated_at, revision)
        VALUES(?,?,?,?,?,?,?,1)`)
        .run(input.projectId, input.projectRef, input.connectionId, input.displayName ?? null,
          input.notes ?? null, now, now);
      return this.getProject(input.projectId)!;
    });
  }

  getProject(projectId: string): ProjectRow | undefined {
    const row = this.db.prepare('SELECT * FROM projects WHERE project_id = ?').get(projectId) as any;
    return row && this.toProject(row);
  }

  findProjectByRef(connectionId: string, projectRef: string): ProjectRow | undefined {
    const row = this.db.prepare('SELECT * FROM projects WHERE connection_id = ? AND project_ref = ?')
      .get(connectionId, projectRef) as any;
    return row && this.toProject(row);
  }

  listProjects(): ProjectRow[] {
    return (this.db.prepare('SELECT * FROM projects ORDER BY registered_at, project_id').all() as any[])
      .map((row) => this.toProject(row));
  }

  private toProject(row: any): ProjectRow {
    return {
      projectId: row.project_id, projectRef: row.project_ref, connectionId: row.connection_id,
      displayName: str(row.display_name), notes: str(row.notes),
      registeredAt: row.registered_at, updatedAt: row.updated_at, revision: row.revision,
    };
  }

  upsertProjectEnvironment(projectId: string, patch: {
    environmentId?: string; environmentRevision?: string; planDigest?: string;
  }): ProjectEnvironmentRow {
    const now = this.now();
    return this.transact(() => {
      const current = this.getProjectEnvironment(projectId);
      this.db.prepare(`INSERT INTO project_environments(project_id, environment_id, environment_revision, plan_digest, selected_at, updated_at, revision)
        VALUES(?,?,?,?,?,?,1)
        ON CONFLICT(project_id) DO UPDATE SET
          environment_id = excluded.environment_id,
          environment_revision = excluded.environment_revision,
          plan_digest = excluded.plan_digest,
          selected_at = excluded.selected_at,
          updated_at = excluded.updated_at,
          revision = project_environments.revision + 1`)
        .run(projectId,
          patch.environmentId ?? current?.environmentId ?? null,
          patch.environmentRevision ?? current?.environmentRevision ?? null,
          patch.planDigest ?? current?.planDigest ?? null,
          now, now);
      return this.getProjectEnvironment(projectId)!;
    });
  }

  getProjectEnvironment(projectId: string): ProjectEnvironmentRow | undefined {
    const row = this.db.prepare('SELECT * FROM project_environments WHERE project_id = ?').get(projectId) as any;
    return row && {
      projectId: row.project_id, environmentId: str(row.environment_id),
      environmentRevision: str(row.environment_revision), planDigest: str(row.plan_digest),
      selectedAt: str(row.selected_at), updatedAt: row.updated_at, revision: row.revision,
    };
  }

  // ---- tasks & actions ----

  upsertTask(input: { taskId?: string; projectId?: string; displayName?: string }): TaskRow {
    const now = this.now();
    const taskId = input.taskId ?? randomUUID();
    return this.transact(() => {
      this.db.prepare(`INSERT INTO tasks(task_id, project_id, display_name, created_at, updated_at, revision)
        VALUES(?,?,?,?,?,1)
        ON CONFLICT(task_id) DO UPDATE SET
          project_id = excluded.project_id, display_name = excluded.display_name,
          updated_at = excluded.updated_at, revision = tasks.revision + 1`)
        .run(taskId, input.projectId ?? null, input.displayName ?? null, now, now);
      return this.getTask(taskId)!;
    });
  }

  getTask(taskId: string): TaskRow | undefined {
    const row = this.db.prepare('SELECT * FROM tasks WHERE task_id = ?').get(taskId) as any;
    return row && {
      launchJson: str(row.launch_json), requestKey: str(row.request_key),
      taskId: row.task_id, projectId: str(row.project_id), displayName: str(row.display_name),
      createdAt: row.created_at, updatedAt: row.updated_at, revision: row.revision,
    };
  }

  listTasks(limit: number, cursor?: {createdAt: string; taskId: string}): TaskRow[] {
    return (this.db.prepare('SELECT task_id FROM tasks WHERE (? IS NULL OR created_at < ? OR (created_at = ? AND task_id < ?)) ORDER BY created_at DESC, task_id DESC LIMIT ?')
      .all(cursor?.createdAt ?? null, cursor?.createdAt ?? null, cursor?.createdAt ?? null, cursor?.taskId ?? null, limit) as {task_id: string}[]).map(r => this.getTask(r.task_id)!);
  }

  saveLaunch(taskId: string, requestKey: string, facts: unknown): void {
    this.db.prepare('UPDATE tasks SET launch_json=?, request_key=?, updated_at=? WHERE task_id=?')
      .run(JSON.stringify(facts), requestKey, this.now(), taskId);
  }

  listTaskActions(taskId: string): TaskActionRow[] {
    return (this.db.prepare('SELECT * FROM task_actions WHERE task_id = ? ORDER BY action_id').all(taskId) as any[])
      .map((row) => this.toTaskAction(row));
  }

  getTaskAction(taskId: string, actionId: string): TaskActionRow | undefined {
    const row = this.db.prepare('SELECT * FROM task_actions WHERE task_id = ? AND action_id = ?')
      .get(taskId, actionId) as any;
    return row && this.toTaskAction(row);
  }

  upsertTaskAction(input: {
    taskId: string; actionId: string; name?: string; scope?: string; provenance?: string;
    sourceTarget?: string; sourceAction?: string; planDigest?: string; saved?: boolean;
  }): TaskActionRow {
    const now = this.now();
    return this.transact(() => {
      const current = this.getTaskAction(input.taskId, input.actionId);
      this.db.prepare(`INSERT INTO task_actions(task_id, action_id, name, scope, provenance, source_target, source_action, plan_digest, saved, saved_at, updated_at, revision)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,1)
        ON CONFLICT(task_id, action_id) DO UPDATE SET
          name = excluded.name, scope = excluded.scope, provenance = excluded.provenance,
          source_target = excluded.source_target, source_action = excluded.source_action,
          plan_digest = excluded.plan_digest, saved = excluded.saved, saved_at = excluded.saved_at,
          updated_at = excluded.updated_at, revision = task_actions.revision + 1`)
        .run(input.taskId, input.actionId, input.name ?? current?.name ?? null,
          input.scope ?? current?.scope ?? null, input.provenance ?? current?.provenance ?? null,
          input.sourceTarget ?? current?.sourceTarget ?? null,
          input.sourceAction ?? current?.sourceAction ?? null,
          input.planDigest ?? current?.planDigest ?? null,
          input.saved === undefined ? (current?.saved ?? 0) : (input.saved ? 1 : 0),
          input.saved ? now : (current?.savedAt ?? null), now);
      return this.getTaskAction(input.taskId, input.actionId)!;
    });
  }

  private toTaskAction(row: any): TaskActionRow {
    return {
      taskId: row.task_id, actionId: row.action_id, name: str(row.name), scope: str(row.scope),
      provenance: str(row.provenance), sourceTarget: str(row.source_target),
      sourceAction: str(row.source_action), planDigest: str(row.plan_digest),
      saved: row.saved, savedAt: str(row.saved_at), updatedAt: row.updated_at, revision: row.revision,
    };
  }

  insertActionTrial(input: {
    trialId: string; requestKey: string; taskId: string; actionId: string;
    planDigest?: string; bindingDigest?: string; exitStatus?: string;
    evidenceVerdict?: string; outputRefs?: string[]; reportRefs?: string[];
    startedAt?: string; endedAt?: string;
  }): void {
    this.db.prepare(`INSERT INTO action_trials(trial_id, request_key, task_id, action_id, plan_digest, binding_digest, exit_status, evidence_verdict, output_refs, report_refs, started_at, ended_at, created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(input.trialId, input.requestKey, input.taskId, input.actionId,
        input.planDigest ?? null, input.bindingDigest ?? null, input.exitStatus ?? null,
        input.evidenceVerdict ?? null, JSON.stringify(input.outputRefs ?? []),
        JSON.stringify(input.reportRefs ?? []), input.startedAt ?? null,
        input.endedAt ?? null, this.now());
  }

  // ---- idempotency ledger ----

  ledgerGet(requestKey: string): LedgerRow | undefined {
    const row = this.db.prepare('SELECT * FROM request_ledger WHERE request_key = ?').get(requestKey) as any;
    return row && this.toLedger(row);
  }

  /** Persist the key association BEFORE any external dispatch (task §8.5). */
  ledgerBegin(input: { requestKey: string; route: string; bodyDigest: string; subjectId?: string }): LedgerRow {
    const now = this.now();
    this.db.prepare(`INSERT INTO request_ledger(request_key, route, body_digest, subject_id, state, created_at, updated_at)
      VALUES(?,?,?,?, 'PENDING', ?, ?)`)
      .run(input.requestKey, input.route, input.bodyDigest, input.subjectId ?? null, now, now);
    return this.ledgerGet(input.requestKey)!;
  }

  ledgerSettle(requestKey: string, responseStatus: number, responseBody: unknown): LedgerRow {
    this.db.prepare(`UPDATE request_ledger SET state='SETTLED', response_status=?, response_body=?, updated_at=? WHERE request_key=?`)
      .run(responseStatus, JSON.stringify(responseBody), this.now(), requestKey);
    return this.ledgerGet(requestKey)!;
  }

  private toLedger(row: any): LedgerRow {
    return {
      requestKey: row.request_key, route: row.route, bodyDigest: row.body_digest,
      subjectId: str(row.subject_id), state: row.state, responseStatus: row.response_status ?? undefined,
      responseBody: str(row.response_body), createdAt: row.created_at, updatedAt: row.updated_at,
    };
  }

  // ---- task control requests (reliable PAUSE/RESUME/STOP) ----
  // Insert/mark helpers deliberately do NOT open their own transaction so the
  // caller can compose ledgerBegin + insertControlRequest inside one short
  // transact (nested BEGIN IMMEDIATE would fail). The read-modify-write
  // savers own a transact each and must be called outside any transaction.

  /** Frozen insert; call inside the same transact as ledgerBegin. */
  insertControlRequest(input: {
    requestKey: string; taskId: string; requestJson: string;
    sourceBindingJson: string; sourceRequestJson: string; createdAt?: string;
  }): void {
    this.db.prepare(`INSERT INTO task_control_requests(request_key, task_id, request_json, source_binding_json, source_request_json, created_at)
      VALUES(?,?,?,?,?,?)`)
      .run(input.requestKey, input.taskId, input.requestJson, input.sourceBindingJson,
        input.sourceRequestJson, input.createdAt ?? this.now());
  }

  controlRequest(requestKey: string): ControlRequestRow | undefined {
    const row = this.db.prepare('SELECT * FROM task_control_requests WHERE request_key = ?').get(requestKey) as any;
    return row && this.toControlRequest(row);
  }

  listControlRequests(taskId: string): ControlRequestRow[] {
    return (this.db.prepare('SELECT * FROM task_control_requests WHERE task_id = ? ORDER BY created_at, request_key').all(taskId) as any[])
      .map((row) => this.toControlRequest(row));
  }

  /** First source dispatch timestamp; monotonic (COALESCE keeps the first). */
  markControlDispatchStarted(requestKey: string): void {
    this.db.prepare('UPDATE task_control_requests SET dispatch_started_at = COALESCE(dispatch_started_at, ?) WHERE request_key = ?')
      .run(this.now(), requestKey);
  }

  /**
   * Record an observed source receipt. Receipt revisions are decimal strings
   * compared as bigint: a lower revision never overwrites a stored higher
   * one, and equal-revision content that differs is a protocol problem — the
   * stored observation wins. Returns whether the row was written.
   * Owns its transact; call outside any transaction.
   */
  saveControlReceipt(requestKey: string, receiptJson: string, observedAt?: string): boolean {
    return this.transact(() => {
      const current = this.controlRequest(requestKey);
      if (!current) return false;
      if (current.lastReceiptJson) {
        const oldRevision = controlRevision(current.lastReceiptJson);
        const newRevision = controlRevision(receiptJson);
        if (newRevision < oldRevision) return false;
        if (newRevision === oldRevision && current.lastReceiptJson !== receiptJson) return false;
      }
      // A fresher confirmed receipt resolves any recorded ambiguous error.
      this.db.prepare('UPDATE task_control_requests SET last_receipt_json = ?, receipt_observed_at = ?, last_source_error_json = NULL WHERE request_key = ?')
        .run(receiptJson, observedAt ?? this.now(), requestKey);
      return true;
    });
  }

  /**
   * Record a definitive source rejection; never overwrites a terminal
   * receipt (a confirmed effect beats a later ambiguous negative).
   * Owns its transact; call outside any transaction.
   */
  saveControlRejection(requestKey: string, rejectionJson: string): boolean {
    return this.transact(() => {
      const current = this.controlRequest(requestKey);
      if (!current) return false;
      if (current.lastReceiptJson) {
        try {
          if ((JSON.parse(current.lastReceiptJson) as { terminal?: unknown }).terminal === true) return false;
        } catch { /* unparsable receipt is not a terminal receipt */ }
      }
      // A definitive admission-time rejection resolves any ambiguous error.
      this.db.prepare('UPDATE task_control_requests SET source_rejection_json = ?, last_source_error_json = NULL WHERE request_key = ?')
        .run(rejectionJson, requestKey);
      return true;
    });
  }

  /** Last dispatch/reconcile error; never touches receipt or rejection. */
  saveControlError(requestKey: string, errorJson: string): void {
    this.db.prepare('UPDATE task_control_requests SET last_source_error_json = ? WHERE request_key = ?')
      .run(errorJson, requestKey);
  }

  private toControlRequest(row: any): ControlRequestRow {
    return {
      requestKey: row.request_key, taskId: row.task_id,
      requestJson: row.request_json, sourceBindingJson: row.source_binding_json,
      sourceRequestJson: row.source_request_json, createdAt: row.created_at,
      dispatchStartedAt: str(row.dispatch_started_at),
      lastReceiptJson: str(row.last_receipt_json), receiptObservedAt: str(row.receipt_observed_at),
      sourceRejectionJson: str(row.source_rejection_json), lastSourceErrorJson: str(row.last_source_error_json),
    };
  }

  // ---- environment operations ----

  insertEnvOperation(input: {
    operationId: string; requestKey: string; kind: string; projectId: string;
    connectionId: string; planDigest?: string; environmentId?: string;
    environmentRevision?: string; expectedRevision?: string; state: string;
    reasonCode?: string;
  }): EnvOperationRow {
    const now = this.now();
    this.db.prepare(`INSERT INTO env_operations(operation_id, request_key, kind, project_id, connection_id, plan_digest, environment_id, environment_revision, expected_revision, state, reason_code, revision, created_at, updated_at, last_observed_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,1,?,?,?)`)
      .run(input.operationId, input.requestKey, input.kind, input.projectId, input.connectionId,
        input.planDigest ?? null, input.environmentId ?? null, input.environmentRevision ?? null,
        input.expectedRevision ?? null, input.state, input.reasonCode ?? null, now, now, now);
    return this.getEnvOperation(input.operationId)!;
  }

  getEnvOperation(operationId: string): EnvOperationRow | undefined {
    const row = this.db.prepare('SELECT * FROM env_operations WHERE operation_id = ?').get(operationId) as any;
    return row && this.toEnvOperation(row);
  }

  getEnvOperationByRequestKey(requestKey: string): EnvOperationRow | undefined {
    const row = this.db.prepare('SELECT * FROM env_operations WHERE request_key = ?').get(requestKey) as any;
    return row && this.toEnvOperation(row);
  }

  listEnvOperations(projectId?: string): EnvOperationRow[] {
    const rows = (projectId
      ? this.db.prepare('SELECT * FROM env_operations WHERE project_id = ? ORDER BY created_at DESC').all(projectId)
      : this.db.prepare('SELECT * FROM env_operations ORDER BY created_at DESC').all()) as any[];
    return rows.map((row) => this.toEnvOperation(row));
  }

  /** Latest operation per state bucket for attention/overview. */
  listPendingEnvOperations(): EnvOperationRow[] {
    return (this.db.prepare(`SELECT * FROM env_operations WHERE state IN ('QUEUED','RUNNING','NEEDS_INPUT','UNKNOWN') ORDER BY created_at`).all() as any[])
      .map((row) => this.toEnvOperation(row));
  }

  updateEnvOperation(operationId: string, patch: {
    state?: string; reasonCode?: string | null; resultRef?: string | null;
    upstreamOperationId?: string; upstreamEventCursor?: string | null;
    progress?: number | null; environmentId?: string | null; environmentRevision?: string | null;
    observedAt?: string;
  }): EnvOperationRow {
    const now = this.now();
    const current = this.getEnvOperation(operationId);
    if (!current) throw invalid('unknown operationId');
    this.db.prepare(`UPDATE env_operations SET state=?, reason_code=?, result_ref=?, upstream_operation_id=?, upstream_event_cursor=?, progress=?, environment_id=?, environment_revision=?, revision=revision+1, updated_at=?, last_observed_at=? WHERE operation_id=?`)
      .run(patch.state ?? current.state,
        patch.reasonCode === undefined ? current.reasonCode ?? null : patch.reasonCode,
        patch.resultRef === undefined ? current.resultRef ?? null : patch.resultRef,
        patch.upstreamOperationId ?? current.upstreamOperationId ?? null,
        patch.upstreamEventCursor === undefined ? current.upstreamEventCursor ?? null : patch.upstreamEventCursor,
        patch.progress === undefined ? current.progress ?? null : patch.progress,
        patch.environmentId === undefined ? current.environmentId ?? null : patch.environmentId,
        patch.environmentRevision === undefined ? current.environmentRevision ?? null : patch.environmentRevision,
        now, patch.observedAt ?? now, operationId);
    return this.getEnvOperation(operationId)!;
  }

  appendOperationEvent(input: {
    operationId: string; occurredAt?: string; kind?: string; state?: string;
    message?: string; upstreamEventId?: string;
  }): OperationEventRow {
    const last = this.db.prepare('SELECT MAX(seq) m FROM operation_events WHERE operation_id = ?')
      .get(input.operationId) as { m: number | null };
    const seq = (last?.m ?? 0) + 1;
    this.db.prepare(`INSERT INTO operation_events(operation_id, seq, occurred_at, kind, state, message, upstream_event_id)
      VALUES(?,?,?,?,?,?,?)`)
      .run(input.operationId, seq, input.occurredAt ?? this.now(), input.kind ?? null,
        input.state ?? null, input.message === undefined ? null : input.message.slice(0, 4096),
        input.upstreamEventId ?? null);
    return { operationId: input.operationId, seq, occurredAt: input.occurredAt ?? this.now(),
      kind: input.kind, state: input.state, message: input.message, upstreamEventId: input.upstreamEventId };
  }

  listOperationEvents(operationId: string, afterSeq = 0, limit = 50): OperationEventRow[] {
    return (this.db.prepare('SELECT * FROM operation_events WHERE operation_id = ? AND seq > ? ORDER BY seq LIMIT ?')
      .all(operationId, afterSeq, limit) as any[]).map((row) => ({
        operationId: row.operation_id, seq: row.seq, occurredAt: row.occurred_at,
        kind: str(row.kind), state: str(row.state), message: str(row.message),
        upstreamEventId: str(row.upstream_event_id),
      }));
  }

  hasUpstreamEvent(operationId: string, upstreamEventId: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM operation_events WHERE operation_id = ? AND upstream_event_id = ? LIMIT 1')
      .get(operationId, upstreamEventId);
  }

  private toEnvOperation(row: any): EnvOperationRow {
    return {
      operationId: row.operation_id, requestKey: row.request_key, kind: row.kind,
      projectId: row.project_id, connectionId: row.connection_id,
      planDigest: str(row.plan_digest), environmentId: str(row.environment_id),
      environmentRevision: str(row.environment_revision), expectedRevision: str(row.expected_revision),
      state: row.state, reasonCode: str(row.reason_code), resultRef: str(row.result_ref),
      upstreamOperationId: str(row.upstream_operation_id),
      upstreamEventCursor: str(row.upstream_event_cursor), progress: row.progress ?? undefined,
      revision: row.revision, createdAt: row.created_at, updatedAt: row.updated_at,
      lastObservedAt: str(row.last_observed_at),
    };
  }

  // ---- readiness / observations ----

  /** Upsert a batch of observed facts for a subject in one transaction. */
  putFacts(subject: string, layer: string, facts: ReadonlyArray<{
    factKey: string; kind?: string; name?: string; version?: string;
    state?: string; detail?: string; source?: string;
  }>, observedAt?: string): void {
    const at = observedAt ?? this.now();
    this.transact(() => {
      const stmt = this.db.prepare(`INSERT INTO readiness_facts(subject, layer, fact_key, kind, name, version, state, detail, source, observed_at)
        VALUES(?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(subject, layer, fact_key) DO UPDATE SET
          kind = excluded.kind, name = excluded.name, version = excluded.version,
          state = excluded.state, detail = excluded.detail, source = excluded.source,
          observed_at = excluded.observed_at`);
      for (const fact of facts) {
        stmt.run(subject, layer, fact.factKey, fact.kind ?? null, fact.name ?? null,
          fact.version ?? null, fact.state ?? null, fact.detail ?? null,
          fact.source ?? null, at);
      }
    });
  }

  listFacts(subject: string): ReadinessFactRow[] {
    return (this.db.prepare('SELECT * FROM readiness_facts WHERE subject = ? ORDER BY layer, fact_key').all(subject) as any[])
      .map((row) => ({
        subject: row.subject, layer: row.layer, factKey: row.fact_key, kind: str(row.kind),
        name: str(row.name), version: str(row.version), state: str(row.state),
        detail: str(row.detail), source: str(row.source), observedAt: row.observed_at,
      }));
  }
}
