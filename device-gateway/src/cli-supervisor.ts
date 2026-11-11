/**
 * CliSupervisor — OC-G free path orchestration.
 *
 * Scans for whitelisted local agent CLIs (pi / codex / claude — the stock,
 * user-installed binaries), spawns one cli-bridge `host.mjs serve` per
 * detected engine on loopback, waits for `/local/v1/identity`, then registers
 * each bridge as a `worker-local` connection row. From that point on every
 * bridge is indistinguishable from a configured `WORKER_LOCAL_*` source —
 * LocalTaskAccess routes catalog/options/tasks by resolved storeId.
 *
 * Deliberate boundaries:
 *   - Detection is presence-only (file on PATH / %APPDATA%\npm). The bridge
 *     itself probes `<bin> --version` at startup and exits when the CLI is
 *     broken; a dead bridge simply never passes its identity health-check.
 *   - Spawned bridges get fresh random tokens; the gateway keeps them in an
 *     in-memory map (tokenRef `cli-supervisor:<engine>`), never on disk.
 *   - No restart loop in this slice — a crashed bridge stays as a stale row,
 *     which `identities()` treats as an offline host and drops from catalogs.
 *
 * Tests inject `spawnChild` / `fetchFn` / `listPathEntries`; production wires
 * the real process.spawn / fetch / PATH scan.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';

type Json = Record<string, unknown>;

export interface ConnectionUpsert {
  connectionId: string;
  kind: string;
  displayName?: string;
  baseUrl?: string;
  tokenRef?: string;
}

/** Whitelisted stock CLIs the gateway may offer as launch scopes. */
export const CLI_WHITELIST = ['pi', 'codex', 'claude'] as const;
export type CliEngineId = (typeof CLI_WHITELIST)[number];

export interface CliSupervisorOptions {
  /** Absolute path to cli-bridge host.mjs. */
  bridgePath: string;
  /** Per-engine bridge state root — `<stateRoot>/<engine>` holds the ledger. */
  stateRoot: string;
  /** Workspace directory the spawned CLIs operate on. */
  projectDir: string;
  /** worker-local project id; defaults to 'workspace'. */
  projectId?: string;
  /** Optional model override passed through to the bridge (--model). */
  model?: string;
  /** Engines to consider; defaults to the whole whitelist. */
  engines?: readonly string[];
  /** Health-check deadline per spawned bridge (ms). */
  healthTimeoutMillis?: number;
}

export interface CliSupervisorDeps {
  /** Register the bridge as a worker-local connection row. */
  upsertConnection(row: ConnectionUpsert): void;
  /**
   * Runtime token map keyed by connectionId — the same Map the gateway's
   * tokenResolver consults for `cli-supervisor:*` refs.
   */
  tokens: Map<string, string>;
  log?(event: string, fields: Json): void;
  /** Injectable seams for tests. */
  spawnChild?: typeof spawn;
  fetchFn?: typeof fetch;
}

export interface CliChild {
  engineId: string;
  connectionId: string;
  port: number;
  child: ChildProcess;
}

/** Directories scanned for CLI binaries — PATH plus the npm shim dir. */
export const listPathEntries = (): string[] => {
  const raw = process.env.PATH ?? process.env.Path ?? '';
  const dirs = raw.split(';').map((d) => d.trim()).filter(Boolean);
  if (process.platform !== 'win32') {
    return raw.split(':').map((d) => d.trim()).filter(Boolean);
  }
  return dirs;
};

/** Candidate file names for a logical CLI on this platform. */
const candidateNames = (bin: string): string[] =>
  process.platform === 'win32'
    ? [bin, `${bin}.exe`, `${bin}.cmd`, `${bin}.bat`]
    : [bin];

/** True when a whitelisted CLI binary is resolvable on this machine. */
export const cliPresent = (bin: string, dirs = listPathEntries()): boolean => {
  const names = new Set(candidateNames(bin));
  const extra = process.platform === 'win32' && process.env.APPDATA
    ? [join(process.env.APPDATA, 'npm')]
    : [];
  for (const dir of [...extra, ...dirs]) {
    try {
      for (const entry of readdirSync(dir)) if (names.has(entry)) return true;
    } catch { /* unreadable dir — skip */ }
  }
  return false;
};

/** Scan the whitelist; returns the engine ids whose binaries exist. */
export const detectLocalClis = (
  engines: readonly string[] = CLI_WHITELIST,
  dirs = listPathEntries(),
): string[] => engines.filter((e) => cliPresent(e, dirs));

const freePort = (): Promise<number> =>
  new Promise((resolvePort, rejectPort) => {
    const probe = createServer();
    probe.once('error', rejectPort);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      probe.close(() =>
        resolvePort(typeof address === 'object' && address !== null ? address.port : 0));
    });
  });

export class CliSupervisor {
  readonly children: CliChild[] = [];
  private stopped = false;

  constructor(
    private readonly opts: CliSupervisorOptions,
    private readonly deps: CliSupervisorDeps,
  ) {}

  /**
   * Detect → spawn → health-check → register each detected engine. Engines
   * are handled concurrently; a failed engine is logged and skipped without
   * blocking the rest. Safe to call fire-and-forget after listeners are up —
   * connection rows are read live by LocalTransport on each request.
   */
  async start(): Promise<CliChild[]> {
    const engines = detectLocalClis(this.opts.engines ?? CLI_WHITELIST);
    const results = await Promise.all(
      engines.map((engineId) => this.startEngine(engineId).catch((error) => {
        this.deps.log?.('cli-supervisor.engine-failed', {
          engineId,
          error: error instanceof Error ? error.message : String(error),
        });
        return undefined;
      })),
    );
    return results.filter((r): r is CliChild => r !== undefined);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const entry of this.children.splice(0)) {
      entry.child.kill();
    }
  }

  private async startEngine(engineId: string): Promise<CliChild | undefined> {
    if (!cliPresent(engineId)) return undefined;
    const connectionId = `cli:${engineId}`;
    const port = await freePort();
    if (port === 0) throw new Error('no free loopback port');
    const token = randomBytes(24).toString('base64url');
    const stateDir = join(this.opts.stateRoot, engineId);
    mkdirSync(stateDir, { recursive: true });
    const args = [
      this.opts.bridgePath,
      'serve',
      '--engine', engineId,
      '--state', stateDir,
      '--port', String(port),
      '--project', resolve(this.opts.projectDir),
      '--project-id', this.opts.projectId ?? 'workspace',
      ...(this.opts.model !== undefined ? ['--model', this.opts.model] : []),
    ];
    const spawnFn = this.deps.spawnChild ?? spawn;
    const child = spawnFn(process.execPath, args, {
      env: { ...process.env, WORKER_LOCAL_TOKEN: token },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let exited = false;
    child.once('exit', () => { exited = true; });
    child.stdout?.on('data', (chunk: Buffer) => {
      this.deps.log?.('cli-supervisor.bridge-stdout', { engineId, line: chunk.toString('utf8').trim() });
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      this.deps.log?.('cli-supervisor.bridge-stderr', { engineId, line: chunk.toString('utf8').trim() });
    });

    const fetchFn = this.deps.fetchFn ?? fetch;
    const deadline = Date.now() + (this.opts.healthTimeoutMillis ?? 10_000);
    while (Date.now() < deadline) {
      if (exited) throw new Error(`bridge for ${engineId} exited before identity`);
      try {
        const res = await fetchFn(`http://127.0.0.1:${port}/local/v1/identity`, {
          headers: { authorization: `Bearer ${token}` },
        });
        if (res.ok) {
          this.deps.upsertConnection({
            connectionId,
            kind: 'worker-local',
            baseUrl: `http://127.0.0.1:${port}`,
            tokenRef: cliTokenRef(engineId),
            displayName: `cli:${engineId}`,
          });
          this.deps.tokens.set(connectionId, token);
          const entry: CliChild = { engineId, connectionId, port, child };
          this.children.push(entry);
          this.deps.log?.('cli-supervisor.engine-ready', { engineId, connectionId, port });
          return entry;
        }
      } catch { /* bridge still booting — retry below */ }
      if (this.stopped) { child.kill(); return undefined; }
      await new Promise((r) => setTimeout(r, 150));
    }
    child.kill();
    throw new Error(`bridge for ${engineId} missed health deadline`);
  }
}

/** tokenRef shape the supervisor writes; gateway tokenResolver maps it to
 * `tokens.get('cli:' + engineId)`. */
export const cliTokenRef = (engineId: string): string => `cli-supervisor:${engineId}`;
