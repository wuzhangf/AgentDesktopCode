import { describe, expect, it } from 'vitest';
import { buildExportDocument, collectExportMessages, serializeCsv, serializeHtml, serializeJson, serializeMarkdown, serializeText, type ExportMessage, type ExportOptions, type SessionExportSource } from '../../src/renderer/app/export/conversationExport';

const options: ExportOptions = {
  format: 'markdown', activities: 'NONE', includeSessionMetadata: true,
  includeTimestamps: true, redactRecognizedSecrets: true
};

const session: SessionExportSource = {
  sessionId: 'session-1', sessionVersion: 2, title: '导出测试', workspaceAlias: 'demo', activeRunId: null,
  messages: []
};

const messages: ExportMessage[] = [{
  id: 'm1', sequence: 0, role: 'user', status: 'COMMITTED', createdAt: '2026-09-16T10:00:00.000Z', runId: null,
  content: 'token=super-secret-value\n```ts\nconst answer = 1;\n```', contentRevision: '1', attachments: [{ id: 'a1', name: '截图.png', mediaType: 'image/png', sizeBytes: 12, sha256: 'hash' }]
}];

describe('conversation export serializers', () => {
  it('redacts recognized credentials in the shared document', () => {
    const doc = buildExportDocument(session, messages, options, { transcriptRevision: '7', verified: true, capturedAt: '2026-09-16T10:00:00.000Z' });
    expect(doc.messages[0]?.content).toContain('token=[REDACTED]');
    expect(doc.transformations.redactionCount).toBe(1);
    expect(doc.completeness.messages).toBe('COMPLETE');
  });

  it('keeps content and attachments in markdown, text and JSON', () => {
    const doc = buildExportDocument(session, messages, { ...options, redactRecognizedSecrets: false }, { transcriptRevision: '7', verified: true, capturedAt: '2026-09-16T10:00:00.000Z' });
    expect(serializeMarkdown(doc)).toContain('截图.png');
    expect(serializeText(doc)).toContain('const answer = 1;');
    expect(JSON.parse(serializeJson(doc)).schemaVersion).toBe('conversation-export/1');
  });

  it('escapes spreadsheet formulas and HTML message content', () => {
    const doc = buildExportDocument(session, [{ ...messages[0]!, content: '=SUM(A1:A2) <script>alert(1)</script>' }], { ...options, format: 'csv', redactRecognizedSecrets: false }, { transcriptRevision: '7', verified: true, capturedAt: '2026-09-16T10:00:00.000Z' });
    expect(serializeCsv(doc)).toContain("'=SUM(A1:A2)");
    expect(serializeHtml(doc)).not.toContain('<script>alert(1)</script>');
    expect(serializeHtml(doc)).toContain('&lt;script&gt;');
  });

  it('normalizes service role constants when collecting messages', async () => {
    const previous = (globalThis as Record<string, unknown>).codeAgentDesktop;
    (globalThis as Record<string, unknown>).codeAgentDesktop = {
      pageSessionMessages: async () => ({
        schemaVersion: 'session-message-page/1', sessionId: 'session-1', transcriptRevision: '7', beforeCursor: null, afterCursor: null,
        hasOlder: false, hasNewer: false, rangeComplete: true,
        items: [{ id: 'm-upper', clientMessageId: 'c1', role: 'USER', status: 'COMMITTED', createdAt: 0, updatedAt: 0, contentRevision: '1', contentState: 'INLINE', contentBytes: 5, content: 'hello' }]
      }),
      getSessionMetadata: async () => ({ transcriptRevision: '7' })
    };
    try {
      const result = await collectExportMessages('session-1', 'paginated', session);
      expect(result.messages[0]?.role).toBe('user');
    } finally {
      if (previous === undefined) delete (globalThis as Record<string, unknown>).codeAgentDesktop;
      else (globalThis as Record<string, unknown>).codeAgentDesktop = previous;
    }
  });
});
