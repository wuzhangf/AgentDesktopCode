/**
 * Offline view over the daemon journal (state.dir/journal.db, SQLite WAL).
 * Read-only + query_only; tolerates missing tables/columns — the daemon
 * schema evolves, we project what exists.
 */
import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { JournalRow, WorkerJournalView } from '../../shared/management/api';

type Projector = { key: (r: any) => string; state?: string; detail?: (r: any) => string | null; time: string[] };

const clip = (v: unknown, n = 160): string | null => {
  if (v == null) return null;
  const s = String(v);
  return s.length > n ? s.slice(0, n) + '…' : s;
};
const extra = (r: any, col: string) => r[col] != null && r[col] !== '' ? ` ${col.replace('last_', '')}=${clip(r[col], 80)}` : '';

const TABLES: Record<string, Projector> = {
  worker_identity: { key: r => r.worker_id, state: 'instance_id', time: ['updated_at'],
    detail: r => `deployment=${r.deployment_id ?? '?'} boot=${clip(r.boot_id, 12) ?? '?'}` },
  command_inbox: { key: r => r.command_id, state: 'state', time: ['acked_at', 'received_at'],
    detail: r => `${r.command_type ?? ''}${r.intake_status ? ' intake=' + r.intake_status : ''}${extra(r, 'last_error')}` },
  execution_journal: { key: r => r.attempt_id, state: 'state', time: ['updated_at'],
    detail: r => `${r.outcome ?? ''}${r.engine_run_id ? ' run=' + clip(r.engine_run_id, 24) : ''}${clip(r.detail, 100) ? ' ' + clip(r.detail, 100) : ''}`.trim() },
  event_outbox: { key: r => r.event_id, state: 'status', time: ['acked_at', 'created_at'],
    detail: r => `${r.event_type ?? ''}${extra(r, 'last_error')}` },
  finish_journal: { key: r => r.attempt_id, state: 'local_state', time: ['finalized_at', 'submitted_at'],
    detail: r => `finish=${clip(r.finish_id, 40) ?? '?'}${extra(r, 'last_error')}` },
  artifact_manifest: { key: r => r.artifact_id, state: 'status', time: ['uploaded_at'],
    detail: r => `${r.kind ?? ''} ${clip(r.digest, 16) ?? ''}`.trim() },
  approval_inbox: { key: r => r.approval_request_id, state: 'state', time: ['decided_at', 'requested_at'],
    detail: r => r.decision ?? null },
  recovery_task: { key: r => r.task_id, state: 'status', time: ['updated_at'],
    detail: r => `${r.kind ?? ''} → ${clip(r.target_id, 60) ?? ''}${extra(r, 'last_error')}` },
  worker_execution_guard: { key: r => r.holder_id, state: 'state', time: ['updated_at'],
    detail: r => r.holder_kind ?? null },
  attempt_facts: { key: r => `${r.attempt_id}:${r.key}`, time: ['created_at'],
    detail: r => clip(r.value, 120) },
  stage_execution_journal: { key: r => r.stage_binding_id, state: 'state', time: ['updated_at'],
    detail: r => `${r.stage_kind ?? ''}${r.reason ? ' ' + clip(r.reason, 80) : ''}` },
  stage_effect_journal: { key: r => r.effect_id, state: 'invoke_state', time: ['updated_at'],
    detail: r => `${r.kind ?? ''}${r.action ? '/' + r.action : ''}${r.outcome ? ' → ' + r.outcome : ''}` },
  stage_artifact_journal: { key: r => r.artifact_id, state: 'status', time: ['updated_at'],
    detail: r => r.kind ?? null },
  stage_finish_journal: { key: r => r.finish_id, state: 'local_state', time: ['updated_at'],
    detail: r => r.semantic_outcome ?? null },
};

export function readJournal(journalFile: string, limit = 50): WorkerJournalView {
  const cap = Math.max(1, Math.min(500, Math.trunc(limit) || 50));
  if (!existsSync(journalFile)) {
    return { rows: [], truncated: false, journalFile, schemaVersion: null, note: 'journal 文件不存在' };
  }
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(journalFile, { readOnly: true, timeout: 1000 });
    db.exec('PRAGMA query_only = ON');
    const schemaVersion = (db.prepare('PRAGMA user_version').get() as any)?.user_version ?? null;
    const tables = new Map<string, Set<string>>();
    for (const t of db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as any[]) {
      tables.set(t.name, new Set((db.prepare(`PRAGMA table_info(${t.name})`).all() as any[]).map(c => c.name)));
    }
    const rows: JournalRow[] = [];
    for (const [table, p] of Object.entries(TABLES)) {
      const cols = tables.get(table);
      if (!cols) continue;
      const timeCol = p.time.find(c => cols.has(c));
      const stateCol = p.state && cols.has(p.state) ? p.state : null;
      let list: any[];
      try {
        list = db.prepare(`SELECT * FROM "${table}"${timeCol ? ` ORDER BY "${timeCol}" DESC` : ''} LIMIT ?`).all(cap) as any[];
      } catch { continue; }
      for (const r of list) {
        let key: string;
        try { key = p.key(r); } catch { continue; }
        if (key == null || key === '') continue;
        rows.push({ table, key: clip(key, 120) ?? '', state: stateCol ? clip(r[stateCol], 60) : null,
          detail: p.detail ? p.detail(r) : null, updatedAt: timeCol ? clip(r[timeCol], 40) : null });
      }
    }
    rows.sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
    return { rows: rows.slice(0, cap), truncated: rows.length > cap, journalFile, schemaVersion,
      note: 'daemon 运行中时为 WAL 只读快照' };
  } catch (e: any) {
    return { rows: [], truncated: false, journalFile, schemaVersion: null,
      note: `journal 不可读: ${clip(e?.message ?? e, 120)}` };
  } finally { db?.close(); }
}

export function journalPathFor(stateDir: string | null): string | null {
  return stateDir ? join(stateDir, 'journal.db') : null;
}
