/**
 * Per-run artifact root: `.local/personal-e2e/<run-id>/`.
 * One directory per invocation; a diagnostic re-run uses a new run id so the
 * first failure record is never overwritten.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const RUN_ID = process.env.PERSONAL_E2E_RUN_ID
  ?? new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);

export const ARTIFACTS_ROOT = resolve(process.cwd(), '.local', 'personal-e2e', RUN_ID);

export function caseDir(caseId: string): string {
  const dir = resolve(ARTIFACTS_ROOT, caseId);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function writeJson(path: string, value: unknown): void {
  mkdirSync(resolve(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2), 'utf8');
}
