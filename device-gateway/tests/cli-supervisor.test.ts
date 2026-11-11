/**
 * CliSupervisor: whitelist detection, per-engine bridge spawn args, runtime
 * connection registration, token map wiring, and failure isolation.
 * spawn/fetch are faked — the real bridge path is exercised e2e separately.
 */
import { describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import {
  CliSupervisor,
  cliPresent,
  cliTokenRef,
  detectLocalClis,
  type ConnectionUpsert,
} from '../src/cli-supervisor';

const tmp = (): string => mkdtempSync(join(tmpdir(), 'cli-sup-'));

const fakeChild = (): ChildProcess => {
  const emitter = new EventEmitter();
  const child = emitter as unknown as ChildProcess & { killed?: string };
  child.stdout = new EventEmitter() as never;
  child.stderr = new EventEmitter() as never;
  child.kill = () => true;
  return child;
};

describe('cli presence detection', () => {
  it('finds engines whose binaries exist in the scanned dirs', () => {
    const dir = tmp();
    try {
      const names = process.platform === 'win32' ? ['pi.cmd', 'codex.cmd'] : ['pi', 'codex'];
      for (const name of names) writeFileSync(join(dir, name), 'x');
      expect(detectLocalClis(['pi', 'codex', 'claude'], [dir])).toEqual(['pi', 'codex']);
      expect(cliPresent('claude', [dir])).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns an empty list when nothing is installed', () => {
    const dir = tmp();
    // The npm-shim dir on this machine may genuinely hold whitelisted CLIs —
    // isolate the scan from %APPDATA% for the "nothing installed" case.
    const oldAppdata = process.env.APPDATA;
    delete process.env.APPDATA;
    try {
      expect(detectLocalClis(['pi', 'codex', 'claude'], [dir])).toEqual([]);
    } finally {
      if (oldAppdata !== undefined) process.env.APPDATA = oldAppdata;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('CliSupervisor.start', () => {
  const setup = () => {
    const rows: ConnectionUpsert[] = [];
    const tokens = new Map<string, string>();
    const spawned: { cmd: string; args: string[]; env: Record<string, string | undefined> }[] = [];
    const logs: { event: string; fields: Record<string, unknown> }[] = [];
    const stateRoot = tmp();
    const projectDir = tmp();
    const fetchFn = async (url: string | URL) =>
      new Response('{}', { status: String(url).endsWith('/local/v1/identity') ? 200 : 404 });
    const deps = {
      upsertConnection: (row: ConnectionUpsert) => rows.push(row),
      tokens,
      log: (event: string, fields: Record<string, unknown>) => logs.push({ event, fields }),
      fetchFn: fetchFn as typeof fetch,
      spawnChild: ((cmd: string, args: string[], opts: { env: Record<string, string | undefined> }) => {
        spawned.push({ cmd, args, env: opts.env });
        return fakeChild();
      }) as typeof import('node:child_process').spawn,
    };
    return { rows, tokens, spawned, logs, stateRoot, projectDir, deps };
  };

  it('spawns a bridge per detected engine and registers worker-local rows', async () => {
    const { rows, tokens, spawned, stateRoot, projectDir, deps } = setup();
    const binDir = tmp();
    try {
      writeFileSync(join(binDir, process.platform === 'win32' ? 'pi.cmd' : 'pi'), 'x');
      const supervisor = new CliSupervisor(
        { bridgePath: '/b/host.mjs', stateRoot, projectDir, projectId: 'demo', engines: ['pi'] },
        deps,
      );
      // Restrict detection to engines present in binDir by stubbing PATH.
      const oldPath = process.env.PATH;
      process.env.PATH = binDir;
      const children = await supervisor.start();
      if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath;

      expect(children).toHaveLength(1);
      expect(spawned).toHaveLength(1);
      const call = spawned[0]!;
      expect(call.args.slice(0, 3)).toEqual(['/b/host.mjs', 'serve', '--engine']);
      expect(call.args).toContain('pi');
      expect(call.args).toContain('demo');
      expect(call.args).toContain('--project-id');
      const token = call.env['WORKER_LOCAL_TOKEN'];
      expect(typeof token).toBe('string');
      expect(token!.length).toBeGreaterThanOrEqual(24);

      expect(rows).toHaveLength(1);
      const row = rows[0]!;
      expect(row.kind).toBe('worker-local');
      expect(row.connectionId).toBe('cli:pi');
      expect(row.tokenRef).toBe(cliTokenRef('pi'));
      expect(row.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      // Token resolves through the shared map the gateway tokenResolver uses.
      expect(tokens.get('cli:pi')).toBe(token);
    } finally {
      rmSync(binDir, { recursive: true, force: true });
      rmSync(stateRoot, { recursive: true, force: true });
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('a bridge that never answers identity is killed and skipped', async () => {
    const { rows, spawned, logs, stateRoot, projectDir, deps } = setup();
    deps.fetchFn = (async () => { throw new Error('refused'); }) as typeof fetch;
    const binDir = tmp();
    try {
      writeFileSync(join(binDir, process.platform === 'win32' ? 'codex.cmd' : 'codex'), 'x');
      const supervisor = new CliSupervisor(
        { bridgePath: '/b/host.mjs', stateRoot, projectDir, healthTimeoutMillis: 400, engines: ['codex'] },
        deps,
      );
      const oldPath = process.env.PATH;
      process.env.PATH = binDir;
      const children = await supervisor.start();
      if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath;

      expect(children).toHaveLength(0);
      expect(rows).toHaveLength(0);
      expect(spawned).toHaveLength(1);
      expect(logs.some((l) => l.event === 'cli-supervisor.engine-failed'
        && l.fields['engineId'] === 'codex')).toBe(true);
    } finally {
      rmSync(binDir, { recursive: true, force: true });
      rmSync(stateRoot, { recursive: true, force: true });
      rmSync(projectDir, { recursive: true, force: true });
    }
  });
});
