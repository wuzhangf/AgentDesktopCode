/**
 * Diagnostics export — everything an operator needs, nothing a secret would
 * touch: controlToken is never serialized, env VALUES never read, acsConnections
 * carry the env-var NAME only.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { WorkerDetail } from '../../shared/management/api';
import type { ExternalConfig, ManagedConfig, WorkerRow } from './store';
import { gateFileOf } from './probe';
import { journalPathFor } from './journal';
import { ID } from './store';

const SECRETISH = /token|secret|password|credential|apikey|api_key/i;

/** config → Record<string,string> with every secret-ish leaf stripped. */
export function sanitizedConfig(w: WorkerRow): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (prefix: string, v: unknown) => {
    if (v == null) return;
    if (typeof v === 'object' && !Array.isArray(v)) {
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) walk(prefix ? `${prefix}.${k}` : k, x);
    } else if (!SECRETISH.test(prefix)) out[prefix] = String(v);
  };
  if (w.kind === 'MANAGED') {
    const c = w.config as ManagedConfig;
    walk('', { releaseRoot: c.releaseRoot, provider: c.provider, workerId: c.workerId,
      dirs: c.dirs, ports: c.ports, configFile: c.configFile, pid: c.pid,
      startedAt: c.startedAt, drainTimeoutMillis: c.drainTimeoutMillis });
    // controlToken / spawnOverride deliberately absent.
  } else {
    const c = w.config as ExternalConfig;
    walk('', { healthUrl: c.healthUrl, stateDir: c.stateDir });
  }
  return out;
}

export function pathsOf(w: WorkerRow): WorkerDetail['paths'] {
  if (w.kind === 'MANAGED') {
    const c = w.config as ManagedConfig;
    return { stateDir: c.dirs.state, workDir: c.dirs.work,
      journalFile: journalPathFor(c.dirs.state), configFile: c.configFile, gateFile: gateFileOf(c) };
  }
  const c = w.config as ExternalConfig;
  return { stateDir: c.stateDir, workDir: null,
    journalFile: journalPathFor(c.stateDir), configFile: null, gateFile: null };
}

export function consoleVersion(appRoot?: string): string {
  // Candidates in order: explicit appRoot, the bundle's own directory (the
  // packaged payload ships server/package.json beside management-server.mjs so
  // relocation onto any cwd still reports the payload version), then the
  // historical fallback of process.cwd() used by the dev tree.
  let bundleDir: string | null = null;
  try { bundleDir = dirname(fileURLToPath(import.meta.url)); } catch { /* non-ESM host */ }
  for (const dir of [appRoot, bundleDir, process.cwd()]) {
    if (!dir) continue;
    try {
      const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
      if (typeof pkg.version === 'string') return pkg.version;
    } catch { /* try next candidate */ }
  }
  return '0.0.0';
}

export function isId(value: unknown): value is string {
  return typeof value === 'string' && ID.test(value);
}
