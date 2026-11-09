// Optional gui-sessions.db adapter (§10.1): separate read-only connection;
// absence degrades the Sessions surface only, never the observation pages.
// GUI schema (this repo): sessions(id,title,...,created_at), messages(id,session_id,...).

export function listSessions(ctx, p) {
  const db = ctx.guiDb;
  if (!db) return null;
  const limit = Math.min(p?.limit ?? 100, 200);
  const rows = db.prepare(`
    SELECT s.id AS session_id, s.title, s.status, s.mode, s.workspace_alias,
           s.created_at, s.updated_at, s.archived_at,
           (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id) message_count
    FROM sessions s ORDER BY s.updated_at DESC LIMIT ?`).all(limit);
  return { available: true, rows, note: '会话来自可选 GUI 库，与观测库读取时点不保证一致。' };
}

export function sessionDetail(ctx, p) {
  const db = ctx.guiDb;
  if (!db) return null;
  const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(p?.sessionId);
  if (!session) return { available: true, session: null, messages: [] };
  const messages = db.prepare(`
    SELECT id, session_id, role, content, status, task_id, run_id, created_at, updated_at
    FROM messages WHERE session_id = ? ORDER BY created_at, rowid LIMIT 1000`).all(p.sessionId);
  return { available: true, session, messages };
}
