// Read-only SQLite connection factory (§10.2). DatabaseSync with readOnly +
// connection-level query_only; WAL stays readable, no immutable=1, no DDL/DML.
import { DatabaseSync } from 'node:sqlite';

export function openReadonlyDb(path) {
  const db = new DatabaseSync(path, { readOnly: true, timeout: 1000 });
  db.exec('PRAGMA query_only = ON');
  return db;
}

/** Schema fingerprint: version + per-table column maps for capability checks. */
export function inspectSchema(db) {
  const version = db.prepare('SELECT MAX(version) v FROM obs_schema_migration').get()?.v ?? null;
  const tables = new Map();
  for (const row of db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()) {
    const cols = db.prepare(`PRAGMA table_info(${row.name})`).all().map((c) => c.name);
    tables.set(row.name, new Set(cols));
  }
  return { version, tables };
}

export function hasTable(schema, name) {
  return schema.tables.has(name);
}

export function hasColumns(schema, table, cols) {
  const t = schema.tables.get(table);
  if (!t) return false;
  return cols.every((c) => t.has(c));
}
