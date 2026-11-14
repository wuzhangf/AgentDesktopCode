import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { unwrap, useSession, useSessions, type SessionLike } from '../queries';
import { capabilityOperation } from '../queries';
import { historyKeys, historyScope, type SessionListFilter } from './historyKeys';
import type {
  DesktopCapabilities,
  MessageContentPageResponse,
  SessionHistoryMessageResponse,
  SessionMessagePageResponse,
  SessionMetadataResponse,
  SessionSummaryResponse,
  SessionSummaryPageResponse
} from '../../../../electron/shared/api-types';

/**
 * Dual-channel history hooks (2026-09-05 design §5.1/§11 HP-5): the paginated
 * endpoints are chosen only when the service capability says AVAILABLE; an
 * older service keeps the legacy array/detail routes through a compat adapter
 * that never invents fields. 401/403/503 never trigger a protocol fallback —
 * only an explicit missing capability does.
 */

export type HistoryChannel = 'paginated' | 'legacy';

export function historyPaginationAvailable(
  capabilities: DesktopCapabilities | null | undefined
): boolean {
  return capabilityOperation(capabilities ?? undefined, 'session.summary.list')?.availability === 'AVAILABLE';
}

/** Normalized rail item; legacy rows map into the same shape (§5.1 compat). */
export interface SessionListItem {
  sessionId: string;
  sessionVersion: number;
  title?: string | null;
  workspaceAlias?: string | null;
  agentProfileId?: string | null;
  agentProfileName?: string | null;
  agentProfileRevision?: string | null;
  status?: string | null;
  interactionMode?: string;
  executionMode?: string;
  autonomyLevel?: string;
  verificationLevel?: string;
  maxModelTurns?: number;
  maxEditAttempts?: number;
  activeRunId?: string | null;
  activeRunObservation?: 'KNOWN' | 'UNKNOWN';
  modelAlias?: string | null;
  writeAllow?: string[] | null;
  writeForbid?: string[] | null;
  directoryPolicyVersion?: number;
  directories?: SessionLike['directories'];
  directoryAccess?: SessionLike['directoryAccess'];
  createdAt?: number | null;
  updatedAt?: number | null;
  archivedAt?: number | null;
  readRevision?: string;
  /** Legacy-channel rows carry recent messages for preview/content search; summaries never do. */
  messages?: SessionLike['messages'];
}

function fromSummary(item: SessionSummaryResponse): SessionListItem {
  return {
    sessionId: item.sessionId,
    sessionVersion: item.sessionVersion,
    title: item.title,
    workspaceAlias: item.workspaceAlias,
    agentProfileId: item.agentProfileId,
    agentProfileName: item.agentProfileName,
    agentProfileRevision: item.agentProfileRevision,
    status: item.status,
    interactionMode: item.interactionMode,
    activeRunId: item.activeRunId,
    activeRunObservation: item.activeRunObservation === 'UNKNOWN' ? 'UNKNOWN' : 'KNOWN',
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    archivedAt: item.archivedAt,
    readRevision: item.readRevision
  };
}

function fromLegacy(session: SessionLike): SessionListItem {
  return {
    sessionId: session.sessionId,
    sessionVersion: session.sessionVersion,
    title: session.title,
    workspaceAlias: session.workspaceAlias,
    agentProfileId: session.agentProfileId,
    agentProfileName: session.agentProfileName,
    agentProfileRevision: session.agentProfileRevision,
    status: session.status,
    activeRunId: session.activeRunId,
    activeRunObservation: 'KNOWN',
    modelAlias: session.modelAlias,
    writeAllow: session.writeAllow,
    writeForbid: session.writeForbid,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    archivedAt: session.archivedAt,
    messages: session.messages
  };
}

export interface HistorySessionListState {
  sessions: SessionListItem[];
  channel: HistoryChannel;
  hasMore: boolean;
  loadMore: (() => void) | null;
  isLoadingMore: boolean;
  /** The rail render waits for exactly one channel. */
  isPending: boolean;
}

/**
 * Session rail source: paginated 50-row summary pages when the capability is
 * present, otherwise one legacy array fetch. The two channels never mix —
 * `channel` tells the UI which one produced the rows.
 */
export function useHistorySessions(capabilities: DesktopCapabilities | null | undefined,
    filter: SessionListFilter = {}): HistorySessionListState {
  const paginated = historyPaginationAvailable(capabilities);
  const scope = historyScope(capabilities);

  const legacy = useSessions({ enabled: !paginated });
  const pages = useInfiniteQuery({
    queryKey: historyKeys.sessionList(scope, { ...filter, archived: filter.archived ?? 'ALL' }),
    enabled: paginated,
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam }): Promise<SessionSummaryPageResponse> =>
      unwrap(await window.codeAgentDesktop.listSessionSummaries({
      archived: filter.archived ?? 'ALL',
      workspaceAlias: filter.workspaceAlias ?? undefined,
      q: filter.q ?? undefined,
      limit: 50,
      cursor: pageParam
      })) as SessionSummaryPageResponse,
    getNextPageParam: (lastPage) => (lastPage.hasMore && lastPage.nextCursor
      ? lastPage.nextCursor : undefined),
    staleTime: 30_000
  });

  return useMemo(() => {
    if (paginated) {
      const items = (pages.data?.pages ?? []).flatMap((page) => page.items.map(fromSummary));
      const hasMore = pages.hasNextPage;
      return {
        sessions: items,
        channel: 'paginated' as const,
        hasMore,
        loadMore: hasMore && !pages.isFetchingNextPage
          ? () => { void pages.fetchNextPage(); }
          : null,
        isLoadingMore: pages.isFetchingNextPage,
        isPending: pages.isPending
      };
    }
    return {
      sessions: (legacy.data ?? []).map(fromLegacy),
      channel: 'legacy' as const,
      hasMore: false,
      loadMore: null,
      isLoadingMore: false,
      isPending: legacy.isPending
    };
  }, [paginated, pages.data, pages.hasNextPage, pages.isFetchingNextPage,
    pages.isPending, legacy.data, legacy.isPending]);
}

/** Detail view model shaped like the legacy SessionLike so the transcript keeps one render path. */
export type HistorySessionDetail = SessionLike & {
  readRevision?: string;
  transcriptRevision?: string;
  activeRunObservation?: 'KNOWN' | 'UNKNOWN';
};

export interface HistorySessionDetailState {
  session: HistorySessionDetail | null;
  channel: HistoryChannel;
  /** Older history can be appended only on the paginated channel. */
  hasOlder: boolean;
  /** Returns 'revision-changed' when the chain must be rebuilt around an anchor. */
  loadOlder: (() => Promise<'ok' | 'revision-changed' | 'error'>) | null;
  isLoadingOlder: boolean;
  /** §7.3: rebuild the read chain around a visible message after 409. */
  recoverAround: ((messageId: string) => void) | null;
  isPending: boolean;
}

function detailFromMetadata(metadata: SessionMetadataResponse): HistorySessionDetail {
  const pendingCommandApproval = (metadata as SessionMetadataResponse & {
    pendingCommandApproval?: SessionLike['pendingCommandApproval'];
  }).pendingCommandApproval;
  return {
    sessionId: metadata.sessionId,
    sessionVersion: metadata.sessionVersion,
    title: metadata.title,
    workspaceAlias: metadata.workspaceAlias,
    agentProfileId: metadata.agentProfileId,
    agentProfileName: metadata.agentProfileName,
    agentProfileRevision: metadata.agentProfileRevision,
    intent: metadata.intent,
    executionMode: metadata.executionMode,
    permissionMode: metadata.permissionMode,
    verificationLevel: metadata.verificationLevel,
    status: metadata.status,
    activeRunId: metadata.activeRunId,
    pendingCommandApproval,
    modelAlias: metadata.modelAlias,
    writeAllow: metadata.writeAllow ?? [],
    writeForbid: metadata.writeForbid ?? [],
    contextDirectories: metadata.contextDirectories ?? [],
    directoryPolicyVersion: metadata.directoryPolicyVersion,
    directories: metadata.directories,
    directoryAccess: metadata.directoryAccess,
    createdAt: metadata.createdAt,
    updatedAt: metadata.updatedAt,
    archivedAt: metadata.archivedAt,
    readRevision: metadata.readRevision,
    transcriptRevision: metadata.transcriptRevision,
    activeRunObservation: metadata.activeRunObservation === 'UNKNOWN' ? 'UNKNOWN' : 'KNOWN'
  };
}

function messageFromPage(item: SessionHistoryMessageResponse): NonNullable<SessionLike['messages']>[number] {
  return {
    id: item.id,
    clientMessageId: item.clientMessageId,
    // The service serializes roles in enum case ('ASSISTANT'); the renderer
    // model is lowercase — normalize at the boundary like the legacy path.
    role: typeof item.role === 'string' ? item.role.toLowerCase() : item.role,
    status: item.status,
    taskId: item.taskId,
    runId: item.runId,
    content: item.contentState === 'INLINE' ? item.content ?? '' : null,
    contentState: item.contentState === 'DEFERRED' ? 'DEFERRED' : 'INLINE',
    contentPreview: item.contentPreview ?? null,
    contentRevision: item.contentRevision,
    contentBytes: item.contentBytes,
    reasoning: item.reasoning ?? null,
    reasoningTruncated: item.reasoningTruncated ?? null,
    attachments: (item.attachments ?? []).map((attachment: { id?: string | null; name?: string | null; mediaType?: string | null; sizeBytes?: number | null; sha256?: string | null; width?: number | null; height?: number | null }) => ({
      id: attachment.id, name: attachment.name, mediaType: attachment.mediaType,
      sizeBytes: attachment.sizeBytes, sha256: attachment.sha256,
      width: attachment.width, height: attachment.height
    }))
  };
}

function isRevisionChanged(error: unknown): boolean {
  return error instanceof Error && error.message.includes('HISTORY_REVISION_CHANGED');
}

/**
 * Conversation source: metadata + keyset message pages on the paginated
 * channel, the legacy session view otherwise. `loadOlder` walks the before
 * chain; a 409 mid-walk returns 'revision-changed' so the caller can
 * re-anchor around its first visible message (§7.3, one automatic rebuild).
 */
export function useHistorySessionDetail(sessionId: string | null,
    capabilities: DesktopCapabilities | null | undefined,
    options: { pageSize?: number; poll?: boolean } = {}): HistorySessionDetailState {
  const paginated = historyPaginationAvailable(capabilities);
  const pageSize = options.pageSize ?? 30;
  const scope = historyScope(capabilities);
  const queryClient = useQueryClient();
  // null anchor = tail chain; a messageId switches to an around-recovery chain.
  const [recoveryAnchor, setRecoveryAnchor] = useState<{ sessionId: string | null; anchor: string | null }>(
    { sessionId: null, anchor: null });

  const legacy = useSession(sessionId, { enabled: !paginated, poll: options.poll });
  const metadata = useQuery({
    queryKey: historyKeys.sessionMetadata(scope, sessionId ?? 'none'),
    enabled: paginated && sessionId !== null,
    staleTime: 15_000,
    refetchInterval: sessionId !== null && options.poll ? 5_000 : false,
    refetchOnReconnect: true,
    queryFn: async () => unwrap(await window.codeAgentDesktop.getSessionMetadata(sessionId as string)) as SessionMetadataResponse
  });
  const chainKey = historyKeys.sessionMessages(scope, sessionId ?? 'none', {
    pageSize,
    ...(recoveryAnchor.anchor && recoveryAnchor.sessionId === sessionId
      ? { aroundMessageId: recoveryAnchor.anchor } : {})
  });
  const messages = useInfiniteQuery({
    queryKey: chainKey,
    enabled: paginated && sessionId !== null,
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam }): Promise<SessionMessagePageResponse> => {
      const around = chainKey[4] as { aroundMessageId?: string };
      if (pageParam === undefined && around.aroundMessageId) {
        // First page of a recovery chain: anchored around the visible message.
        return unwrap(await window.codeAgentDesktop.pageSessionMessages(sessionId as string, {
          limit: pageSize,
          aroundMessageId: around.aroundMessageId
        }));
      }
      return unwrap(await window.codeAgentDesktop.pageSessionMessages(sessionId as string, {
        limit: pageSize,
        cursor: pageParam
      }));
    },
    getPreviousPageParam: (firstPage) => (firstPage.hasOlder && firstPage.beforeCursor
      ? firstPage.beforeCursor : undefined),
    // Newer content arrives through coordinator invalidation of this chain,
    // not through forward paging (§7.3: a plain after-cursor would miss old
    // message edits).
    getNextPageParam: () => undefined,
    refetchInterval: sessionId !== null && options.poll ? 5_000 : false,
    refetchOnReconnect: true,
    staleTime: 30_000
  });

  const recoverAround = paginated && sessionId !== null
    ? (messageId: string) => {
      setRecoveryAnchor({ sessionId, anchor: messageId });
      // The old chain is replaced wholesale by the new around-chain (§6.3:
      // pages from different revisions are never merged).
      void queryClient.removeQueries({
        predicate: (query) => query.queryKey[0] === 'sessionMessages'
          && query.queryKey[2] === sessionId
          && query.queryKey !== chainKey
      });
    }
    : null;

  const loadOlder = paginated && sessionId !== null && messages.hasPreviousPage
    ? async (): Promise<'ok' | 'revision-changed' | 'error'> => {
      try {
        await messages.fetchPreviousPage();
        return 'ok';
      } catch (error) {
        return isRevisionChanged(error) ? 'revision-changed' : 'error';
      }
    }
    : null;

  return useMemo(() => {
    if (!paginated) {
      return {
        session: (legacy.data ?? null) as HistorySessionDetail | null,
        channel: 'legacy' as const,
        hasOlder: false,
        loadOlder: null,
        isLoadingOlder: false,
        recoverAround: null,
        isPending: legacy.isPending
      };
    }
    const base = metadata.data ? detailFromMetadata(metadata.data) : null;
    if (base === null) {
      return {
        session: null, channel: 'paginated' as const, hasOlder: false, loadOlder: null,
        isLoadingOlder: false, recoverAround, isPending: metadata.isPending || messages.isPending
      };
    }
    const pagesCopy = [...(messages.data?.pages ?? [])].reverse();
    const items = pagesCopy.flatMap((page) => page.items.map(messageFromPage));
    const oldestPage = (messages.data?.pages ?? [])[0];
    return {
      session: { ...base, messages: items },
      channel: 'paginated' as const,
      hasOlder: Boolean(oldestPage?.hasOlder),
      loadOlder,
      isLoadingOlder: messages.isFetchingPreviousPage,
      recoverAround,
      isPending: metadata.isPending || messages.isPending
    };
  }, [paginated, legacy.data, legacy.isPending, metadata.data, metadata.isPending,
    messages.data, messages.isPending, messages.isFetchingPreviousPage,
    messages.hasPreviousPage, loadOlder, recoverAround]);
}

/**
 * Bounded full-content read for one DEFERRED body (design §7.2): segments
 * concatenate only while contentRevision stays identical; a mid-read revision
 * change aborts with the typed error so no torn text is ever shown or copied.
 */
export async function readFullMessageContent(sessionId: string, messageId: string,
    first: MessageContentPageResponse, maxBytes = 65_536,
    maxTotalBytes = 8 * 1024 * 1024): Promise<string> {
  let text = first.text;
  let cursor: string | null = first.nextCursor;
  let guard = 0;
  while (cursor !== null) {
    guard += 1;
    if (guard > 512 || text.length * 3 > maxTotalBytes) {
      throw new Error('HISTORY_CONTENT_TOO_LARGE');
    }
    const segment = unwrap(await window.codeAgentDesktop.getMessageContentPage(
      sessionId, messageId, { cursor, maxBytes })) as MessageContentPageResponse;
    if (segment.contentRevision !== first.contentRevision) {
      throw new Error('HISTORY_REVISION_CHANGED');
    }
    text += segment.text;
    cursor = segment.nextCursor;
  }
  return text;
}
