/**
 * Personal worker management console — API contract.
 * BFF: server/management/ (loopback, same-origin gated). UI: src/manage/.
 * Increment A scope: worker registry, layered health, managed lifecycle,
 * install-gate admission control, durable operations, settings, diagnostics.
 * Every field must carry real facts — unknown stays null, never faked.
 */

export const MANAGE_API_PREFIX = '/api/manage';

// ---------------------------------------------------------------- workers

export type WorkerKind = 'MANAGED' | 'EXTERNAL';
export type LayerName = 'HOST' | 'DAEMON' | 'ENGINE' | 'TOOLCHAIN';
export type LayerState = 'OK' | 'DEGRADED' | 'DOWN' | 'UNKNOWN' | 'UNMANAGED';

export interface HealthLayerResult {
  layer: LayerName;
  state: LayerState;
  /** short human summary, e.g. "进程存活 pid=1234" / "readyz 503" */
  summary: string;
  /** optional sanitized detail */
  detail?: string;
  observedAt: string; // ISO
}

export type AcceptingState =
  | 'YES'            // observed: not draining, gate open, daemon ready
  | 'NO_GATE'        // install gate ARMED
  | 'NO_DRAINING'    // daemon reports draining (latched — needs restart)
  | 'NO_NOT_READY'   // daemon live but not ready
  | 'UNKNOWN';       // unreachable / unmanaged

/** What THIS console may do to the worker — drives which buttons render. */
export type WorkerCapability =
  | 'HEALTH_PROBE'   // can GET /health/live + /readyz
  | 'JOURNAL_READ'   // state dir readable → journal.db offline view
  | 'LIFECYCLE'      // we spawned/own it: start, stop, restart
  | 'GATE'           // may write install-gate.json
  | 'DIAGNOSTICS';

export interface WorkerSummary {
  workerKey: string;          // registry id, stable
  name: string;
  kind: WorkerKind;
  machine: string;            // 'local' for increment A
  registeredAt: string;       // ISO
  lastSeenAt: string | null;  // last successful daemon observation
  connection: LayerState;     // HOST layer
  daemonReady: boolean | null;
  draining: boolean | null;
  installGate: 'ARMED' | 'DISARMED' | 'UNMOUNTED' | 'UNREADABLE' | 'UNKNOWN';
  acceptingTasks: AcceptingState;
  activeAttemptId: string | null;
  workerId: string | null;    // daemon-reported identity
  instanceId: string | null;
  provider: string | null;
  version: string | null;     // release/image digest if observed, else null
  capabilities: WorkerCapability[];
}

export interface WorkerOwnership {
  managed: boolean;
  pid: number | null;
  startedAt: string | null;
  verified: boolean;          // pid alive AND command line matches our record
  detail: string;             // e.g. "pid 1234 命令行匹配" / "外部实例，无进程所有权"
}

export interface WorkerHealth {
  checkedAt: string;
  layers: HealthLayerResult[]; // HOST, DAEMON, ENGINE, TOOLCHAIN — always all four
}

export interface WorkerDetail extends WorkerSummary {
  health: WorkerHealth;
  engine: {
    provider: string | null;
    providerBundle: string | null;    // raw AssemblyReport summary from readyz
    embeddedRuntime: string | null;   // READY|STARTING|DEAD|null
    acsConnection: string | null;     // name of configured ACS connection, if any
  };
  control: {
    kind: 'LOCAL_DEMO_PLANE' | 'NONE';
    url: string | null;               // loopback demo control plane URL (managed only)
    reachable: boolean | null;
  };
  paths: {
    stateDir: string | null;
    workDir: string | null;
    journalFile: string | null;
    configFile: string | null;
    gateFile: string | null;
  };
  ownership: WorkerOwnership;
  config: Record<string, string>;     // sanitized effective config — secrets stripped
}

// ------------------------------------------------------------------ journal

export interface JournalRow {
  table: string;         // command_inbox | execution_journal | event_outbox | finish_journal | artifact_manifest | ...
  key: string;           // primary identifier (command_id / attempt_id / event_id ...)
  state: string | null;
  detail: string | null; // short sanitized summary
  updatedAt: string | null;
}

export interface WorkerJournalView {
  rows: JournalRow[];
  truncated: boolean;
  journalFile: string;
  schemaVersion: number | null;
  note?: string;         // e.g. "daemon 运行中，WAL 只读快照"
}

// --------------------------------------------------------------- operations

export type OperationKind = 'START' | 'STOP' | 'RESTART' | 'GATE_ARM' | 'GATE_DISARM';
export type OperationState = 'PENDING' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'VERIFY_FAILED';

export interface OperationStep {
  at: string;
  message: string;
}

export interface Operation {
  operationId: string;         // client-generated idempotency key (uuid)
  workerKey: string;
  workerName: string;
  kind: OperationKind;
  state: OperationState;
  createdAt: string;
  updatedAt: string;
  /** bounded log of what was actually done/observed */
  steps: OperationStep[];
  error: { code: string; message: string } | null;
}

export interface OperationRequest {
  operationId: string;         // uuid; reused id returns the existing record
  kind: OperationKind;
}

// -------------------------------------------------------------- registration

export interface RegisterManagedWorker {
  kind: 'MANAGED';
  name: string;                    // display name
  workerId: string;                // daemon worker.id (stable deployment name)
  provider: string;                // fixture | agentcode | codex | pi
  releaseRoot?: string;            // defaults to settings.releaseRoot
}

export interface RegisterExternalWorker {
  kind: 'EXTERNAL';
  name: string;
  healthUrl: string;               // http loopback URL of daemon health server
  stateDir?: string;               // optional local journal access
}

export type RegisterWorkerRequest = RegisterManagedWorker | RegisterExternalWorker;

// ----------------------------------------------------------------- settings

export interface AcsConnection {
  name: string;
  baseUrl: string;                 // loopback URL
  tokenEnv: string;                // NAME of env var holding the bearer token — value never stored/sent
}

export interface ConsoleSettings {
  releaseRoot: string | null;      // sealed/local worker release tree root
  defaultProvider: string;
  acsConnections: AcsConnection[];
  obsApiUrl: string | null;        // observation API base for /api/v2 proxy (null → default 8788)
}

export interface InstallCheck {
  ok: boolean;
  checkedAt: string;
  releaseRoot: string | null;
  findings: { ok: boolean; item: string; detail: string }[];
}

// ----------------------------------------------------------------- overview

export type AttentionSeverity = 'ACTION' | 'WARN' | 'INFO';

export interface AttentionItem {
  id: string;
  severity: AttentionSeverity;
  message: string;
  workerKey?: string;
  operationId?: string;
}

export interface Overview {
  generatedAt: string;
  attention: AttentionItem[];
  workers: WorkerSummary[];
  runningAttempts: { workerKey: string; workerName: string; attemptId: string; state: string | null }[];
  recentOperations: Operation[];
}

// -------------------------------------------------------------- diagnostics

export interface DiagnosticsBundle {
  generatedAt: string;
  meta: { consoleVersion: string; node: string; platform: string; stateRoot: string };
  workers: WorkerDetail[];
  operations: Operation[];
  settings: Omit<ConsoleSettings, 'acsConnections'> & { acsConnections: { name: string; baseUrl: string; tokenEnv: string }[] };
  /** secrets (control tokens, env values) are never included */
}

export interface ManageMeta {
  apiVersion: 'manage/1';
  stateRoot: string;
  startedAt: string;
}

// ------------------------------------------------------------------ errors

export interface ManageProblem {
  error: string;
  code: string;      // e.g. NOT_FOUND, NOT_MANAGED, INVALID_REQUEST, WORKER_BUSY, HOST_REJECTED
  status: number;
}
