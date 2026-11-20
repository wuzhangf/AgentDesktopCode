import { createHash, randomUUID } from 'node:crypto';
import { closeSync, mkdirSync, openSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

interface SendKey {
  requestKey: string;
  sessionRef: string;
  expectedStateRef: string;
}

export interface SendIntent extends SendKey {
  mode: 'followUp';
  instruction: string;
  acceptanceCriteria?: string;
}

interface RecordedSend extends SendKey {
  delegationRef: string;
  createdAt: string;
  acceptanceCriteria: string | null;
}

/** One launcher credential identifies one caller. Store its intent before any network I/O. */
export class SendJournal {
  private readonly database: DatabaseSync;
  private readonly scope: string;

  constructor(directory: string, writerCredential: string) {
    this.scope = createHash('sha256').update(writerCredential).digest('hex');
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const databasePath = join(directory, 'xagt-send.db');
    closeSync(openSync(databasePath, 'a', 0o600));
    this.database = new DatabaseSync(databasePath);
    this.database.exec(`
      PRAGMA busy_timeout=5000;
      PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS send_intents (
        scope TEXT NOT NULL,
        requestKey TEXT NOT NULL,
        delegationRef TEXT NOT NULL,
        sessionRef TEXT NOT NULL,
        expectedStateRef TEXT NOT NULL,
        instruction TEXT NOT NULL,
        acceptanceCriteria TEXT,
        createdAt TEXT NOT NULL,
        settled INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (scope, requestKey)
      )
    `);
  }

  begin(intent: SendIntent): { created: boolean; delegationRef: string; matches: boolean } {
    const delegationRef = `xdlg-${randomUUID()}`;
    const inserted = this.database.prepare(`
      INSERT INTO send_intents (scope, requestKey, delegationRef, sessionRef, expectedStateRef,
        instruction, acceptanceCriteria, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (scope, requestKey) DO NOTHING
    `).run(this.scope, intent.requestKey, delegationRef, intent.sessionRef, intent.expectedStateRef,
      intent.instruction, intent.acceptanceCriteria ?? null, new Date().toISOString());
    if (inserted.changes === 1) return { created: true, delegationRef, matches: true };
    const existing = this.database.prepare(`
      SELECT delegationRef, sessionRef, expectedStateRef, instruction, acceptanceCriteria
      FROM send_intents WHERE scope = ? AND requestKey = ?
    `).get(this.scope, intent.requestKey);
    if (existing === undefined) throw new Error('Missing recorded send');
    return {
      created: false,
      delegationRef: String(existing.delegationRef),
      matches: existing.sessionRef === intent.sessionRef && existing.expectedStateRef === intent.expectedStateRef
        && existing.instruction === intent.instruction && existing.acceptanceCriteria === (intent.acceptanceCriteria ?? null),
    };
  }

  reference(key: SendKey): string | undefined {
    const row = this.database.prepare(`
      SELECT delegationRef FROM send_intents WHERE scope = ? AND requestKey = ?
      AND sessionRef = ? AND expectedStateRef = ?
    `).get(this.scope, key.requestKey, key.sessionRef, key.expectedStateRef);
    return typeof row?.delegationRef === 'string' ? row.delegationRef : undefined;
  }

  settle(delegationRef: string): void {
    this.database.prepare('UPDATE send_intents SET settled = 1 WHERE scope = ? AND delegationRef = ?')
      .run(this.scope, delegationRef);
  }

  pending(): RecordedSend[] {
    return this.database.prepare(`
      SELECT requestKey, delegationRef, sessionRef, expectedStateRef, createdAt, acceptanceCriteria
      FROM send_intents WHERE scope = ? AND settled = 0 ORDER BY createdAt DESC, requestKey DESC LIMIT 50
    `).all(this.scope) as unknown as RecordedSend[];
  }
}
