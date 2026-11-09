/**
 * Records what this run actually tested: repository HEADs, the built dist
 * digest, the isolated runtime inputs and tool versions. Non-secret only —
 * no bearer, cookie or token ever lands here.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { ARTIFACTS_ROOT, RUN_ID, writeJson } from './fixtures/run-artifacts';

function git(cwd: string, args: string[]): string | null {
  try {
    return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

function dirDigest(dir: string): { files: number; sha256: string } | null {
  if (!existsSync(dir)) return null;
  const hash = createHash('sha256');
  let files = 0;
  const walk = (current: string) => {
    for (const name of readdirSync(current).sort()) {
      const full = resolve(current, name);
      const stat = statSync(full);
      if (stat.isDirectory()) walk(full);
      else {
        files += 1;
        hash.update(name);
        hash.update(readFileSync(full));
      }
    }
  };
  walk(dir);
  return { files, sha256: hash.digest('hex') };
}

export default function globalSetup(): void {
  const app = process.cwd();
  const workspace = resolve(app, '..', '..');
  const repos = ['AgentDesktopCode', 'AgentCodeService', 'AgentProducts', 'AgentFramework']
    .map((name) => {
      const cwd = resolve(workspace, name);
      if (!existsSync(cwd)) return { repo: name, present: false };
      const dirty = git(cwd, ['status', '--porcelain']);
      return {
        repo: name,
        present: true,
        branch: git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']),
        head: git(cwd, ['rev-parse', 'HEAD']),
        worktreeDirty: dirty ? dirty.split('\n').filter(Boolean).length : 0,
      };
    });
  const runtime = process.env.PERSONAL_E2E_RUNTIME ?? null;
  writeJson(resolve(ARTIFACTS_ROOT, 'manifest.json'), {
    runId: RUN_ID,
    startedAt: new Date().toISOString(),
    app,
    repositories: repos,
    dist: dirDigest(resolve(app, 'dist')),
    managementServer: existsSync(resolve(app, '.local/management-server/management-server.mjs')),
    runtime: runtime
      ? { dir: runtime, inputs: existsSync(resolve(runtime, 'inputs.json')) ? resolve(runtime, 'inputs.json') : null }
      : null,
    toolchain: {
      node: process.version,
      platform: process.platform,
    },
    projects: ['personal-ui', 'personal-real'],
  });
}
