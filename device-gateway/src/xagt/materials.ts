/**
 * Explicit material entries — owner-configured roots + relative file lists
 * (design §11.1 "材料来自两种明确入口…或用户授权给该会话的相对文件清单").
 *
 * An entry is a fixed {root, files[]} pair confirmed at the source machine's
 * management entry; ≤50 relative names, no recursive discovery. The optional
 * `session` binding records provenance only — it does NOT grant the working
 * directory; list_materials(sessionRef) exposes exactly the named files.
 *
 * Read-side hardening (design §5.1/A14/A15): realpath boundary inside root,
 * regular files only, .git/node_modules/secret-name denies, fd-identity
 * re-check after read, ≤1 MiB, strict UTF-8 at the service layer, bounded
 * secret scan mirroring the bridge's stagePathForTask gate.
 */
import { constants } from 'node:fs';
import { closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, normalize, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { hash, hashBytes, isRecord, text } from '../protocol.js';
import type { GatewayStoreView, JsonObject } from '../context.js';
import { LIMITS, xfail } from './common.js';

const KIND = 'xagt-material';

/** Provenance binding — mirrors the session binding stored under refs. */
export interface MaterialSessionBinding {
  backendStoreId: string;
  kind: 'MANAGED_TASK' | 'VENDOR_SESSION';
  taskId?: string;
  engine?: string;
  sessionId?: string;
}

export interface MaterialEntry {
  matId: string;
  name: string;
  /** Absolute root on THIS machine — confirmed at the owner entry. */
  root: string;
  /** ≤50 relative file names inside root. */
  files: string[];
  session?: MaterialSessionBinding;
  createdAt: string;
  revision: number;
}

const DENIED_DIRS = new Set(['.git', 'node_modules', '.hg', '.svn', '__pycache__']);
const DENIED_NAME = /(?:^|\/|\\)\.(?:env|netrc|npmrc|pypirc|aws|ssh|gnupg|kube|docker)(?:$|[./\\])/i;
const DENIED_FILE = /(?:^|[./\\])(?:id_rsa|id_dsa|id_ecdsa|id_ed25519|credentials|secrets?|private[_-]?key|.*\.(?:pem|key|p12|pfx|keystore|jks|kdbx|asc|gpg))$/i;
/** Same bounded window the bridge uses before staging. */
const SECRET_RE = /(?:sk-[A-Za-z0-9_-]{20,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|(?:api[_-]?key|password|access[_-]?token)\s*[:=]\s*["']?[^\s"']{8,})/i;

const relOk = (rel: string): boolean => {
  if (rel === '' || rel.length > 512 || isAbsolute(rel) || /^[A-Za-z]:/.test(rel) || rel.startsWith('\\\\')) return false;
  if (/[\0-\x1f]/.test(rel)) return false;
  const parts = normalize(rel).split(/[\\/]+/);
  return parts.every((p) => p !== '' && p !== '.' && p !== '..' && !DENIED_DIRS.has(p));
};

const denied = (rel: string): boolean => DENIED_NAME.test(rel) || DENIED_FILE.test(rel);

export class MaterialStore {
  constructor(private readonly store: Pick<GatewayStoreView, 'get' | 'put' | 'list' | 'delete'>) {}

  create(body: JsonObject): MaterialEntry {
    if (this.store.list<MaterialEntry>(KIND).length >= LIMITS.materialEntriesMax) {
      xfail('INVALID_REQUEST', '材料条目数量已达上限。');
    }
    const rootRaw = text(body, 'root');
    if (!isAbsolute(rootRaw) && !/^[A-Za-z]:[\\/]/.test(rootRaw)) {
      xfail('INVALID_REQUEST', 'root 必须是本机绝对路径。');
    }
    const root = resolve(rootRaw);
    const st: import('node:fs').Stats = (() => {
      try {
        return statSync(root);
      } catch {
        xfail('INVALID_REQUEST', '材料根不存在或不可访问。');
      }
    })();
    if (!st.isDirectory()) xfail('INVALID_REQUEST', '材料根必须是目录。');
    const filesValue: unknown = body.files;
    if (!Array.isArray(filesValue) || filesValue.length === 0 || filesValue.length > LIMITS.explicitFilesMax) {
      xfail('INVALID_REQUEST', `files 必须是 1..${LIMITS.explicitFilesMax} 个相对文件名。`);
    }
    const list: string[] = [];
    for (const item of filesValue as unknown[]) {
      if (typeof item !== 'string' || !relOk(item)) xfail('INVALID_REQUEST', 'files 元素必须是目录内相对路径。');
      if (denied(item)) xfail('INVALID_REQUEST', '材料清单不得包含隐藏目录或秘密文件名。');
      const rel = normalize(item).split(sep).join('/');
      if (!list.includes(rel)) list.push(rel);
    }
    let session: MaterialSessionBinding | undefined;
    if (body.session !== undefined) {
      const s: unknown = body.session;
      if (!isRecord(s)) xfail('INVALID_REQUEST');
      const sb = s as Record<string, unknown>;
      const kind = text(sb, 'kind');
      if (kind !== 'MANAGED_TASK' && kind !== 'VENDOR_SESSION') xfail('INVALID_REQUEST');
      session = { backendStoreId: text(sb, 'backendStoreId'), kind };
      if (kind === 'MANAGED_TASK') session.taskId = text(sb, 'taskId');
      else { session.engine = text(sb, 'engine'); session.sessionId = text(sb, 'sessionId'); }
    }
    const entry: MaterialEntry = {
      matId: `xgmt-${randomUUID()}`,
      name: body.name === undefined ? '' : text(body, 'name').slice(0, 128),
      root,
      files: list,
      ...(session !== undefined ? { session } : {}),
      createdAt: new Date().toISOString(),
      revision: 1,
    };
    this.store.put(KIND, entry.matId, entry);
    return entry;
  }

  list(): MaterialEntry[] {
    return this.store.list<MaterialEntry>(KIND);
  }

  get(matId: string): MaterialEntry | undefined {
    return this.store.get<MaterialEntry>(KIND, matId);
  }

  require(matId: string): MaterialEntry {
    const entry = this.get(matId);
    if (entry === undefined) xfail('NOT_FOUND');
    return entry as MaterialEntry;
  }

  remove(matId: string): void {
    this.require(matId);
    this.store.delete(KIND, matId);
  }

  /** list_materials metadata for one relative name — stat + sha256. */
  describe(entry: MaterialEntry, rel: string): {
    name: string; sizeBytes: number; sha256?: string; readable: boolean; reasonCode?: string;
  } {
    const name = rel;
    const missing = { name, sizeBytes: 0, readable: false, reasonCode: 'NOT_FOUND' };
    if (!entry.files.includes(rel) || !relOk(rel) || denied(rel)) {
      return { ...missing, reasonCode: 'SCOPE_DENIED' };
    }
    const resolved = this.resolveInside(entry, rel);
    if (resolved === undefined) return missing;
    try {
      const st = lstatSync(resolved);
      if (!st.isFile()) return missing;
      if (st.size > LIMITS.materialFileMax) {
        return { name, sizeBytes: st.size, readable: false, reasonCode: 'CONTENT_TOO_LARGE' };
      }
      const bytes = readAll(resolved, st);
      if (bytes === undefined) return missing;
      // Same bounded secret scan as read() — a file the read path would
      // refuse must not list as readable.
      try {
        scannedForSecrets(bytes);
      } catch {
        return { name, sizeBytes: bytes.length, readable: false, reasonCode: 'SCOPE_DENIED' };
      }
      return { name, sizeBytes: bytes.length, sha256: hashBytes(bytes), readable: true };
    } catch {
      return missing;
    }
  }

  private resolveInside(entry: MaterialEntry, rel: string): string | undefined {
    let rootReal: string;
    try {
      rootReal = realpathSync(entry.root);
    } catch {
      return undefined;
    }
    const candidate = join(rootReal, rel);
    let real: string;
    try {
      real = realpathSync(candidate);
    } catch {
      return undefined;
    }
    if (real !== rootReal && !real.startsWith(rootReal + sep)) return undefined;
    return real;
  }

  /**
   * read_material for explicit entries — open under the realpath boundary,
   * verify fd identity before+after read, then sha256. Returns the raw bytes;
   * UTF-8 decode + paging happen in the service layer (shared with staged
   * sources so every source gets identical text treatment).
   */
  read(entry: MaterialEntry, rel: string): { bytes: Uint8Array; sha256: string } {
    if (!entry.files.includes(rel) || !relOk(rel) || denied(rel)) xfail('SCOPE_DENIED');
    const resolved = this.resolveInside(entry, rel);
    if (resolved === undefined) xfail('NOT_FOUND');
    const st = lstatSync(resolved);
    if (!st.isFile()) xfail('NOT_FOUND');
    if (st.size > LIMITS.materialFileMax) xfail('CONTENT_TOO_LARGE');
    const fd = openSync(resolved, constants.O_RDONLY);
    try {
      const before = fstatSync(fd);
      if (!before.isFile() || before.ino !== st.ino || before.mtimeMs !== st.mtimeMs
          || before.size !== st.size) xfail('MATERIAL_CHANGED');
      const bytes = Buffer.alloc(before.size);
      if (readSync(fd, bytes, 0, before.size, 0) !== before.size) xfail('MATERIAL_CHANGED');
      const after = fstatSync(fd);
      if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ino !== before.ino) {
        xfail('MATERIAL_CHANGED');
      }
      scannedForSecrets(bytes);
      return { bytes: new Uint8Array(bytes), sha256: hashBytes(bytes) };
    } finally {
      closeSync(fd);
    }
  }
}

const readAll = (path: string, st: { size: number; ino: number; mtimeMs: number }): Buffer | undefined => {
  try {
    const fd = openSync(path, constants.O_RDONLY);
    try {
      const bytes = Buffer.alloc(st.size);
      if (readSync(fd, bytes, 0, st.size, 0) !== st.size) return undefined;
      return bytes;
    } finally {
      closeSync(fd);
    }
  } catch {
    return undefined;
  }
};

/** Bounded secret scan — mirrors stagePathForTask: first 512 KiB + env secrets. */
const scannedForSecrets = (bytes: Uint8Array): void => {
  const scanned = Buffer.from(bytes.subarray(0, 512 * 1024)).toString('utf8');
  if (SECRET_RE.test(scanned)) xfail('SCOPE_DENIED', '材料内容疑似包含凭据，未返回。');
};

export { relOk, denied };
