/**
 * management.db schema migrations (PAE task §8 item 8; design §13).
 *
 * The registry database owns a `management_schema_migrations` version table.
 * Migrations are ordered integer versions, applied once inside an IMMEDIATE
 * transaction, and recorded with a source checksum so post-merge drift is
 * detectable (applied rows are never re-run).
 *
 * P7 seam: report table definitions are authored by
 * `server/management/reports/**` (P7 owns that directory) and registered here
 * via `registerManagementMigration` — or passed to the store as
 * `options.extraMigrations`. Convention: namespace `p7-reports`, versions ≥
 * 100 so the P5 core schema (versions 1..99) always lands first. P5 is the
 * single registrar; reports never open a second schema runner or database.
 */
import type { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';

export interface ManagementMigration {
  /** Globally unique positive integer; applied in ascending order. */
  version: number;
  /** Owning package namespace, e.g. 'p5-core' or 'p7-reports'. */
  namespace: string;
  /** Stable migration name recorded in the version table. */
  name: string;
  /** DDL/DML body; already runs inside the migration transaction. */
  up(db: DatabaseSync): void;
}

const registered: ManagementMigration[] = [];

/**
 * Register an extra migration for the management database. P7 calls this from
 * `server/management/reports/` module init (before the store opens) or passes
 * migrations via `ManagementStoreOptions.extraMigrations`.
 */
export function registerManagementMigration(migration: ManagementMigration): void {
  if (!Number.isSafeInteger(migration.version) || migration.version < 1) {
    throw new Error('Management migration version must be a positive integer');
  }
  if (!migration.namespace || !migration.name || typeof migration.up !== 'function') {
    throw new Error('Management migration requires namespace, name and up()');
  }
  registered.push(migration);
}

function checksum(migration: ManagementMigration): string {
  return createHash('sha256')
    .update(migration.namespace + ':' + migration.name + ':' + migration.up.toString(), 'utf8')
    .digest('hex');
}

/**
 * Apply every pending migration (built-ins + `registerManagementMigration`
 * extras + `extra` options) in version order. Returns applied versions for
 * diagnostics; drift between an applied row and current source is reported
 * through `drift` instead of aborting boot.
 */
export function runMigrations(
  db: DatabaseSync,
  builtins: readonly ManagementMigration[],
  extra: readonly ManagementMigration[] = [],
): { applied: number[]; drift: string[] } {
  db.exec(`CREATE TABLE IF NOT EXISTS management_schema_migrations(
    version INTEGER PRIMARY KEY,
    namespace TEXT NOT NULL,
    name TEXT NOT NULL,
    checksum TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )`);
  const seen = new Map<number, ManagementMigration>();
  for (const m of [...builtins, ...registered, ...extra]) {
    const prev = seen.get(m.version);
    if (prev) {
      throw new Error(`Management migration version ${m.version} claimed by both ${prev.namespace}/${prev.name} and ${m.namespace}/${m.name}`);
    }
    seen.set(m.version, m);
  }
  const applied = new Map<number, { checksum: string; name: string }>();
  for (const row of db.prepare('SELECT version, name, checksum FROM management_schema_migrations').all() as { version: number; name: string; checksum: string }[]) {
    applied.set(row.version, { checksum: row.checksum, name: row.name });
  }
  const nowApplied: number[] = [];
  const drift: string[] = [];
  for (const version of [...seen.keys()].sort((a, b) => a - b)) {
    const migration = seen.get(version)!;
    const prior = applied.get(version);
    const sum = checksum(migration);
    if (prior) {
      if (prior.checksum !== sum) drift.push(`${migration.namespace}/${migration.name}@${version}`);
      continue;
    }
    db.exec('BEGIN IMMEDIATE');
    try {
      migration.up(db);
      db.prepare('INSERT INTO management_schema_migrations(version, namespace, name, checksum, applied_at) VALUES(?,?,?,?,?)')
        .run(version, migration.namespace, migration.name, sum, new Date().toISOString());
      db.exec('COMMIT');
      nowApplied.push(version);
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
      throw error;
    }
  }
  return { applied: nowApplied, drift };
}
