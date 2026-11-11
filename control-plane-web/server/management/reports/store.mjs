// Report output store: real files under <outputDir>/<reportId>/, written
// atomically (tmp + fsync + rename) so a crash mid-write never leaves a
// half file that could be mistaken for a result. Paths are contained —
// reportId is validated against the frozen id pattern before touching fs.
import { mkdirSync, openSync, writeSync, fsyncSync, closeSync, renameSync, rmSync, statSync, readFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { PERSONAL_ID_PATTERN } from '../../../shared/contracts/personal-enums.mjs';
import { digestBytes } from './canonical.mjs';
import { REPORT_ERROR } from './ports.mjs';

export class ReportOutputError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

/** Create the report output store. `outputDir` is supplied by the mount
 * layer (install-local, never committed); the store creates it lazily. */
export function createReportOutputStore({ outputDir, maxFileBytes = 4 * 1024 * 1024 } = {}) {
  if (typeof outputDir !== 'string' || outputDir.length === 0) {
    throw new ReportOutputError(REPORT_ERROR.OUTPUT_WRITE_FAILED, 'report outputDir is required');
  }
  const root = resolve(outputDir);

  function reportDir(reportId) {
    if (!PERSONAL_ID_PATTERN.test(reportId)) {
      throw new ReportOutputError(REPORT_ERROR.OUTPUT_WRITE_FAILED, `invalid reportId ${reportId}`);
    }
    const dir = join(root, reportId);
    const resolved = resolve(dir);
    if (resolved !== root && !resolved.startsWith(root + sep)) {
      throw new ReportOutputError(REPORT_ERROR.OUTPUT_WRITE_FAILED, 'report path escapes output dir');
    }
    return resolved;
  }

  /** Atomic write: tmp file in the same directory, fsync, then rename over
   * the destination. Returns {name, sizeBytes, digest, relPath}. */
  function writeFileAtomic(reportId, name, bytes) {
    if (!/^[\w.-]{1,64}$/.test(name) || name.includes('..')) {
      throw new ReportOutputError(REPORT_ERROR.OUTPUT_WRITE_FAILED, `invalid output file name ${name}`);
    }
    if (bytes.byteLength > maxFileBytes) {
      throw new ReportOutputError(REPORT_ERROR.OUTPUT_WRITE_FAILED,
        `output ${name} exceeds maxFileBytes (${bytes.byteLength} > ${maxFileBytes})`);
    }
    const dir = reportDir(reportId);
    mkdirSync(dir, { recursive: true });
    const final = join(dir, name);
    const tmp = join(dir, `.tmp-${randomUUID()}`);
    let fd = null;
    try {
      fd = openSync(tmp, 'w');
      writeSync(fd, bytes);
      fsyncSync(fd);
      closeSync(fd); fd = null;
      renameSync(tmp, final);
    } catch (err) {
      try { if (fd !== null) closeSync(fd); } catch { /* best effort */ }
      try { rmSync(tmp, { force: true }); } catch { /* best effort */ }
      throw new ReportOutputError(REPORT_ERROR.OUTPUT_WRITE_FAILED,
        `cannot write report output: ${String(err?.message ?? err)}`);
    }
    const digest = digestBytes(bytes);
    // relPath is a stored logical path — keep it POSIX so a database row is
    // stable across hosts (resolve() handles '/' on Windows fine).
    return { name, sizeBytes: bytes.byteLength, digest, relPath: `${reportId}/${name}` };
  }

  /** Bounded read of a previously written output file (only used by ops
   * tooling/tests; the frozen wire surface returns file metadata only). */
  function readFileBounded(relPath, cap = maxFileBytes) {
    const abs = resolve(root, relPath);
    if (abs !== root && !abs.startsWith(root + sep)) {
      throw new ReportOutputError(REPORT_ERROR.NOT_FOUND ?? 'NOT_FOUND', 'file path escapes output dir');
    }
    const st = statSync(abs);
    if (st.size > cap) {
      throw new ReportOutputError(REPORT_ERROR.SOURCE_TOO_LARGE, `file exceeds read cap (${st.size} > ${cap})`);
    }
    return readFileSync(abs);
  }

  function exists(relPath) {
    try { statSync(resolve(root, relPath)); return true; } catch { return false; }
  }

  return { root, writeFileAtomic, readFileBounded, exists, maxFileBytes };
}
