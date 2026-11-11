import type { DesktopCapabilities } from '../../../../electron/shared/api-types';

/**
 * History cache-key factories (2026-09-05 design §5.3). Every key carries the
 * service scope so a service switch or authorization change can never reuse
 * another instance's cached history. Cursors travel in pageParam, never as a
 * growing root key.
 */

export type HistoryScope = readonly [string, string];

export function historyScope(capabilities: DesktopCapabilities | null | undefined): HistoryScope {
  // The verified connection context from Main; a missing identity degrades to
  // a per-boot value rather than silently sharing caches across services.
  return [
    capabilities?.serviceInstanceId ?? 'unknown-instance',
    capabilities?.bootId ?? 'unknown-boot'
  ] as const;
}

export interface SessionListFilter {
  workspaceAlias?: string | null;
  /** ACTIVE | ARCHIVED | ALL — the rail shows every session, matching the legacy array. */
  archived?: 'ACTIVE' | 'ARCHIVED' | 'ALL';
  q?: string;
}

export const historyKeys = {
  sessionList: (scope: HistoryScope, filter: SessionListFilter) =>
    ['sessionList', ...scope, { ...filter, sort: 'recent-v1' }] as const,
  sessionSummary: (scope: HistoryScope, sessionId: string) =>
    ['sessionSummary', ...scope, sessionId] as const,
  sessionMetadata: (scope: HistoryScope, sessionId: string) =>
    ['sessionMetadata', ...scope, sessionId] as const,
  /** anchor carries pageSize (and, for recovery chains, the aroundMessageId); cursors stay in pageParam. */
  sessionMessages: (scope: HistoryScope, sessionId: string,
      anchor: { pageSize: number; aroundMessageId?: string }) =>
    ['sessionMessages', ...scope, sessionId, { ...anchor }] as const,
  messageContent: (scope: HistoryScope, sessionId: string, messageId: string,
      contentRevision: string) =>
    ['messageContent', ...scope, sessionId, messageId, contentRevision] as const
};
