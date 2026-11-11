import {
  NATIVE_MESSAGE_TRANSPORT_VERSION,
  compareNativeSequence,
  nativeMessagePage,
  validNativeSequence,
  type NativeInput,
  type NativeInputRequest,
  type NativeMessageItem,
  type NativeMessagePage,
  type NativeRequestView,
  type NativeTaskDetail,
} from '../../../packages/protocol/src/native-task';

/** Source-carried public message row from `GET /tasks/{id}/messages`.
 * Pi hosts publish `items` as an append-only snapshot of bounded public
 * messages; Codex hosts only publish cumulative `text` coverage. The
 * structured native-messages/1 page is {@link NativeMessagePage} — this
 * legacy snapshot shape stays for pre-migration sources only and its rows
 * keep array-index keys, never paging positions (design §9). */
export interface NativeSourceMessage {
  messageId?: string;
  status?: string;
  textTruncated?: boolean;
  sourceRequestKey?: string;
  role?: string;
  text?: string;
  commandId?: string;
  nativeTurnId?: string | null;
  occurredAt?: string;
}

export interface NativeMessagesView {
  messageSchemaVersion?: string;
  historyMode?: string;
  legacy?: {text?: string; textTruncated?: boolean} | null;
  hasMore?: boolean;
  text?: string;
  turns?: unknown;
  items?: NativeSourceMessage[];
  coverage?: string;
}

export interface NativeMessageRow {
  /** Structured rows: `{scope}#{messageId}` — the source-scoped stable id
   * (design §9: row key = source scope + messageId). Legacy Pi snapshot
   * rows keep `source-{index}`; local pending rows keep `pending-{key}`. */
  id: string;
  role: 'user' | 'assistant' | 'other';
  text: string;
  occurredAt?: string;
  commandId?: string;
  pending?: boolean;
  receipt?: string;
  /** Raw source status — kept for diagnostics, never rendered verbatim. */
  status?: string;
  /** Localized honest status text (§5.2): 受理/消费/拒绝/待核对 or 本条回复已完成. */
  statusLabel?: string;
  sourceRequestKey?: string;
  /** True when a local pending write merged into this source row by its
   * actual sourceRequestKey — the row stays a source row. */
  mergedLocalRequest?: boolean;
  /** Source clipped this body at a bound — never claim it is the full text. */
  textTruncated?: boolean;
  /** Internal ids for the per-row diagnostics fold. */
  diagnostics?: {label: string; value: string}[];
}

export interface PendingNativeInput {
  request: NativeInput;
  receiptState?: string;
}

// ---------------------------------------------------------------------------
// NativeTranscript — the per-task structured message store (design §5/§9).
// All sequence/revision comparisons stay decimal strings through
// compareNativeSequence (BigInt) — never JS numbers.
// ---------------------------------------------------------------------------

export interface NativeTranscript {
  /** True once a native-messages/1 page has been accepted. */
  structured: boolean;
  /** Paging requests allowed: the schema mark AND the gateway-generated
   * transport mark were both seen (design §8.3). Without it only bounded
   * snapshots are shown and `before`/`cursor` are never sent. */
  paging: boolean;
  /** Row-key scope: source storeId/taskId once the page reports it. */
  scope: string;
  /** Source ids learned from pages; a conflicting later page is dropped. */
  pageTaskId?: string;
  pageStoreId?: string;
  historyMode?: string;
  /** Frozen legacy block for LEGACY_PREFIX tasks (design §7.2). */
  legacy?: {text?: string; textTruncated?: boolean; kind?: string} | null;
  coverage?: string;
  /** Merged structured items keyed by messageId. */
  items: ReadonlyMap<string, NativeMessageItem>;
  /** Inclusive source ranges actually covered by reads. Disjoint recent
   * snapshots must not hide the unread messages between them. */
  ranges: readonly {first: string; last: string}[];
  /** Cursor immediately below the first gap, or below the unread tail. */
  newerCursor?: string;
  /** Smallest/largest sequence actually loaded (decimal strings). */
  earliestLoaded?: string;
  newestLoaded?: string;
  /** Largest sequence the source reported in any read snapshot. */
  latestSequence?: string;
  /** More older candidates exist below earliestLoaded. */
  hasMoreHistory: boolean;
  /** The newest snapshot reports messages beyond what is loaded. */
  hasNewer: boolean;
  /** Latest observed transcript revision (decimal string; only rises —
   * a slow older snapshot is not a regression per §5.4.5). */
  transcriptRevision?: string;
  /** `before` bounds of fetched history windows, fetch order (most recent
   * last) — the §5.4.2 re-read targets, at most two per revision bump. */
  historyBounds: readonly string[];
  /** True once a backward page beyond the tail has been fetched — after
   * that a recent-page read no longer decides the history edge. */
  historyLoaded: boolean;
  /** Legacy snapshot view retained for pre-native-messages sources. */
  legacyView?: NativeMessagesView;
}

export function emptyNativeTranscript(scope: string): NativeTranscript {
  return {
    structured: false,
    paging: false,
    scope,
    items: new Map<string, NativeMessageItem>(),
    ranges: [],
    hasMoreHistory: false,
    hasNewer: false,
    historyBounds: [],
    historyLoaded: false,
  };
}

/** RECENT: recent page (no query). OLDER: `before=bound` history page that
 * extends the loaded edge downward. NEWER: `cursor=bound` forward catch-up.
 * REFRESH: re-read of an already fetched history window after a
 * transcriptRevision move (§5.4.2) — merges rows only, never moves edges. */
export type NativeMessagePageDirection = 'RECENT' | 'OLDER' | 'NEWER' | 'REFRESH';

export interface NativeMessagePageMergeOptions {
  /** The `before`/`cursor` bound used for this read. */
  bound?: string;
  /** Expected source ids from the verified task binding; a page reporting
   * different ids is dropped whole (C17 — never show another task's rows). */
  expectedTaskId?: string;
  expectedStoreId?: string;
}

function validMessageItem(value: unknown): value is NativeMessageItem {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return typeof item.messageId === 'string' && item.messageId.length > 0
    && validNativeSequence(item.sequence) && validNativeSequence(item.revision)
    && typeof item.role === 'string' && typeof item.status === 'string'
    && (item.text === undefined || typeof item.text === 'string');
}

function normalizeLegacy(value: unknown): {text?: string; textTruncated?: boolean; kind?: string} | null {
  if (value == null) return null;
  if (typeof value === 'string') return {text: value};
  if (typeof value === 'object' && !Array.isArray(value)) {
    const raw = value as Record<string, unknown>;
    return {
      text: typeof raw.text === 'string' ? raw.text : undefined,
      textTruncated: raw.textTruncated === true,
      kind: typeof raw.kind === 'string' ? raw.kind : undefined,
    };
  }
  return null;
}

function maxSequence(a: string | undefined, b: string | undefined): string | undefined {
  if (a === undefined) return b;
  if (b === undefined || !validNativeSequence(b)) return a;
  return compareNativeSequence(b, a) > 0 ? b : a;
}

/**
 * Union-merge one structured page into the transcript. Same messageId keeps
 * the higher decimal-string revision so a late same-sequence update can
 * never downgrade a known status (§5.4, C14). Returns `prev` unchanged when
 * the page violates the binding fence — callers can tell a rejected page
 * apart by identity.
 */
export function mergeNativeMessagePage(
  prev: NativeTranscript,
  page: NativeMessagePage,
  direction: NativeMessagePageDirection,
  options: NativeMessagePageMergeOptions = {},
): NativeTranscript {
  if (!nativeMessagePage(page)) return prev;
  if (options.expectedTaskId && page.taskId != null && page.taskId !== options.expectedTaskId) return prev;
  if (options.expectedStoreId && page.storeId != null && page.storeId !== options.expectedStoreId) return prev;
  if (prev.pageTaskId && page.taskId != null && page.taskId !== prev.pageTaskId) return prev;
  if (prev.pageStoreId && page.storeId != null && page.storeId !== prev.pageStoreId) return prev;

  const items = new Map(prev.items);
  const pageItems: NativeMessageItem[] = [];
  for (const item of page.items ?? []) {
    if (!validMessageItem(item)) continue;
    pageItems.push(item);
    const at = items.get(item.messageId);
    if (!at || compareNativeSequence(item.revision, at.revision) >= 0) {
      items.set(item.messageId, {...item, text: typeof item.text === 'string' ? item.text : ''});
    }
  }
  let earliest = prev.earliestLoaded;
  let newest = prev.newestLoaded;
  for (const item of items.values()) {
    if (earliest === undefined || compareNativeSequence(item.sequence, earliest) < 0) earliest = item.sequence;
    if (newest === undefined || compareNativeSequence(item.sequence, newest) > 0) newest = item.sequence;
  }
  const latest = maxSequence(prev.latestSequence, validNativeSequence(page.latestSequence) ? page.latestSequence : undefined);
  const revision = validNativeSequence(page.transcriptRevision)
    && (prev.transcriptRevision === undefined || compareNativeSequence(page.transcriptRevision, prev.transcriptRevision) > 0)
    ? page.transcriptRevision
    : prev.transcriptRevision;
  const ranges = prev.ranges.map(range => ({...range}));
  const sequences = pageItems.map(item => BigInt(item.sequence));
  const first = sequences.reduce<bigint | undefined>((a, b) => a === undefined || b < a ? b : a, undefined);
  const last = sequences.reduce<bigint | undefined>((a, b) => a === undefined || b > a ? b : a, undefined);
  if (direction === 'RECENT' && first !== undefined && last !== undefined) {
    ranges.push({first: page.hasMore ? String(first) : '0', last: String(last)});
  } else if (direction === 'OLDER' && options.bound) {
    ranges.push({first: page.hasMore && first !== undefined ? String(first) : '0', last: String(BigInt(options.bound) - 1n)});
  } else if (direction === 'NEWER' && options.bound) {
    const end = !page.hasMore && validNativeSequence(page.latestSequence)
      ? BigInt(page.latestSequence) : last;
    if (end !== undefined && end > BigInt(options.bound)) {
      ranges.push({first: String(BigInt(options.bound) + 1n), last: String(end)});
    }
  }
  ranges.sort((a, b) => compareNativeSequence(a.first, b.first));
  const covered: typeof ranges = [];
  for (const range of ranges) {
    const prior = covered[covered.length - 1];
    if (prior && BigInt(range.first) <= BigInt(prior.last) + 1n) {
      if (compareNativeSequence(range.last, prior.last) > 0) prior.last = range.last;
    } else covered.push(range);
  }
  const next: NativeTranscript = {
    ...prev,
    structured: true,
    paging: prev.paging || page.messageTransportVersion === NATIVE_MESSAGE_TRANSPORT_VERSION,
    items,
    ranges: covered,
    earliestLoaded: earliest,
    newestLoaded: newest,
    latestSequence: latest,
    transcriptRevision: revision,
    historyMode: typeof page.historyMode === 'string' ? page.historyMode : prev.historyMode,
    legacy: 'legacy' in page ? normalizeLegacy(page.legacy) : prev.legacy,
    coverage: typeof page.coverage === 'string' ? page.coverage : prev.coverage,
    pageTaskId: typeof page.taskId === 'string' ? page.taskId : prev.pageTaskId,
    pageStoreId: typeof page.storeId === 'string' ? page.storeId : prev.pageStoreId,
    scope: typeof page.storeId === 'string' && typeof page.taskId === 'string'
      ? `${page.storeId}/${page.taskId}` : prev.scope,
  };
  switch (direction) {
    case 'RECENT':
      // The recent page's hasMore is about candidates below ITS first
      // sequence — once history was paged deeper those are already loaded,
      // so only the un-paged tail read owns the history edge.
      if (!prev.historyLoaded) next.hasMoreHistory = covered.length > 0 && BigInt(covered[0]!.first) > 0n;
      break;
    case 'OLDER':
      next.historyLoaded = true;
      next.hasMoreHistory = page.hasMore === true;
      if (options.bound && !prev.historyBounds.includes(options.bound)) {
        next.historyBounds = [...prev.historyBounds, options.bound];
      }
      break;
    case 'NEWER':
    case 'REFRESH':
      break;
  }
  const newerBeyondLoaded = latest !== undefined && newest !== undefined
    && compareNativeSequence(latest, newest) > 0;
  next.newerCursor = covered.length > 1 ? covered[0]!.last : newerBeyondLoaded ? newest : undefined;
  next.hasNewer = next.newerCursor !== undefined;
  return next;
}

/** Loaded items in strict source order — decimal-sequence sort via BigInt,
 * messageId tiebreak; two identical bodies stay two rows (C02). */
export function sortedNativeItems(transcript: NativeTranscript): NativeMessageItem[] {
  return [...transcript.items.values()].sort((a, b) => {
    const order = compareNativeSequence(a.sequence, b.sequence);
    if (order !== 0) return order;
    return a.messageId < b.messageId ? -1 : a.messageId > b.messageId ? 1 : 0;
  });
}

// ---------------------------------------------------------------------------
// Projection — transcript (+ local pending write) → display rows.
// ---------------------------------------------------------------------------

export interface NativeConversationProjection {
  rows: NativeMessageRow[];
  structured: boolean;
  paging: boolean;
  historyMode?: string;
  /** Frozen legacy block for LEGACY_PREFIX tasks: an independent history
   * section that never disappears because items exist (§7.2.5/§7.2.6).
   * 'EMPTY' asks the view to show a coverage note instead of an empty bubble. */
  legacyBlock?: {text: string; textTruncated: boolean} | 'EMPTY';
  /** Old-format cumulative assistant output (no messageSchemaVersion). */
  accumulatedText?: string;
  hasMoreHistory: boolean;
  hasNewer: boolean;
  coverage?: string;
}

const KNOWN_ROLES = new Set(['user', 'assistant']);

// §5.2 status labels below replace the legacy projectNativeMessages snapshot path.
/** §5.2 user-facing labels; assistant COMPLETED describes THIS reply, never
 * the whole task. Raw wire statuses stay in the diagnostics fold only. */
export function nativeMessageStatusLabel(role: string, status: string | undefined): string {
  if (role === 'user') {
    switch (status) {
      case 'ACCEPTED': return '来源已受理';
      case 'CONSUMED': return '来源已消费';
      case 'REJECTED': return '来源已拒绝';
      default: return '结果待核对';
    }
  }
  if (role === 'assistant') return status === 'COMPLETED' ? '本条回复已完成' : '结果待核对';
  return '结果待核对';
}

/** §5.4.3: a locally confirmed write whose source row has not been read yet
 * stays visible as a syncing row, never as a second user message later. */
export function nativePendingSyncLabel(receiptState: string | undefined): string {
  if (!receiptState || receiptState === 'UNKNOWN') return '本地待确认 · 结果待核对';
  if (receiptState === 'REJECTED') return '来源已拒绝';
  if (receiptState === 'CONSUMED') return '来源已消费，历史同步中';
  if (receiptState === 'APPLIED') return '来源已确认，历史同步中';
  return '来源已受理，历史同步中';
}

function structuredRow(item: NativeMessageItem): NativeMessageRow {
  const diagnostics: {label: string; value: string}[] = [];
  for (const [label, value] of [
    ['消息 ID', item.messageId],
    ['序号', item.sequence],
    ['修订', item.revision],
    ['来源请求键', item.sourceRequestKey],
    ['命令', item.commandId],
    ['原生轮次', item.nativeTurnId],
    ['generation', item.generation],
    ['segment', item.segmentId],
    ['更新时间', item.updatedAt],
  ] as [string, string | null | undefined][]) {
    if (typeof value === 'string' && value.length > 0) diagnostics.push({label, value});
  }
  return {
    id: `source-${item.messageId}`,
    role: KNOWN_ROLES.has(item.role) ? item.role as 'user' | 'assistant' : 'other',
    text: item.text,
    occurredAt: item.occurredAt ?? undefined,
    commandId: item.commandId ?? undefined,
    status: item.status,
    statusLabel: nativeMessageStatusLabel(item.role, item.status),
    sourceRequestKey: item.sourceRequestKey ?? undefined,
    textTruncated: item.textTruncated === true,
    diagnostics,
  };
}

function legacyRow(item: NativeSourceMessage, index: number, ordinal: number): NativeMessageRow {
  const role = item.role ?? '';
  const binding = JSON.stringify([role, item.commandId, item.nativeTurnId, item.occurredAt]);
  return {
    id: item.messageId ? `source-${item.messageId}` : item.occurredAt ? `source-${binding}-${ordinal}` : `source-${index}`,
    role: KNOWN_ROLES.has(role) ? role as 'user' | 'assistant' : 'other',
    text: typeof item.text === 'string' ? item.text : '',
    occurredAt: item.occurredAt,
    commandId: item.commandId,
    receipt: item.status ? nativeReceiptLabel(item.status) : undefined,
    textTruncated: item.textTruncated,
  };
}

function pendingRow(request: NativeInput, receiptState: string | undefined): NativeMessageRow {
  const content = 'content' in request ? request.content
    : request.kind === 'INPUT_RESPONSE'
      ? request.response.value ?? request.response.decision
        ?? (request.response.confirmed === true ? '确认' : request.response.confirmed === false ? '拒绝' : '')
      : '';
  return {
    id: `pending-${request.requestKey}`,
    role: 'user',
    text: content,
    pending: true,
    receipt: nativePendingSyncLabel(receiptState),
  };
}

/**
 * Project the transcript plus the locally pending write into display rows.
 * A local pending user write merges into the source row carrying its actual
 * sourceRequestKey — never by text or time matching (§9, C19/C20); a
 * pending row whose source row is not yet read stays a single syncing row
 * (§5.4.3). New-format `text` is never projected as a second body.
 */
export function projectNativeConversation(
  transcript: NativeTranscript | undefined,
  pending: PendingNativeInput | undefined,
): NativeConversationProjection {
  const rows: NativeMessageRow[] = [];
  if (transcript?.structured) {
    for (const item of sortedNativeItems(transcript)) rows.push(structuredRow(item));
  } else {
    const items = Array.isArray(transcript?.legacyView?.items) ? transcript.legacyView.items : [];
    const occurrences = new Map<string, number>();
    items.forEach((item, index) => {
      if (!item || typeof item !== 'object' || typeof item.text !== 'string') return;
      const binding = JSON.stringify([item.role, item.commandId, item.nativeTurnId, item.occurredAt]);
      const ordinal = occurrences.get(binding) ?? 0;
      occurrences.set(binding, ordinal + 1);
      rows.push(legacyRow(item, index, ordinal));
    });
  }
  // Only conversational writes surface as transcript rows — input responses,
  // stops and controls keep their own pending surfaces instead.
  if (pending && (pending.request.kind === 'NATIVE_STEER' || pending.request.kind === 'NATIVE_FOLLOW_UP')) {
    const request = pending.request;
    const merged = transcript?.structured
      ? rows.find((row) => row.role === 'user' && row.sourceRequestKey !== undefined && row.sourceRequestKey === request.requestKey)
      : undefined;
    if (merged) merged.mergedLocalRequest = true;
    else rows.push(pendingRow(request, pending.receiptState));
  }
  const legacyMode = transcript?.structured === true && transcript.historyMode === 'LEGACY_PREFIX';
  return {
    rows,
    structured: transcript?.structured === true,
    paging: transcript?.paging === true,
    historyMode: transcript?.historyMode,
    legacyBlock: legacyMode
      ? (transcript?.legacy?.text
          ? {text: transcript.legacy.text, textTruncated: transcript.legacy.textTruncated === true}
          : 'EMPTY')
      : undefined,
    accumulatedText: transcript?.structured ? undefined : nativeLegacyText(transcript?.legacyView) || undefined,
    hasMoreHistory: transcript?.hasMoreHistory === true,
    hasNewer: transcript?.hasNewer === true,
    coverage: transcript?.structured ? transcript.coverage : transcript?.legacyView?.coverage,
  };
}

/** Compatibility surface for the old items[] snapshot view — the structured
 * read path is projectNativeConversation on a NativeTranscript. */
export function projectNativeMessages(
  view: NativeMessagesView | undefined,
  pending: PendingNativeInput | undefined,
): NativeMessageRow[] {
  return projectNativeConversation({...emptyNativeTranscript('legacy'), legacyView: view}, pending).rows;
}

/** A local pending row must never hide a source's cumulative output. */
export function nativeLegacyText(view: NativeMessagesView | undefined): string {
  if (view?.messageSchemaVersion === 'native-messages/1') return view.legacy?.text ?? '';
  return Array.isArray(view?.items) && view.items.some(item => item && typeof item.text === 'string') ? '' : view?.text ?? '';
}

export function nativeReceiptLabel(state?: string): string {
  const labels: Record<string, string> = {
    ACCEPTED: '来源已受理', REQUESTED: '请求已记录，等待来源处理', OBSERVED: '已读到来源回执',
    APPLIED: '来源已应用', CONSUMED: '来源已消费', COMPLETED: '本条回复已完成',
    REJECTED: '来源已拒绝', FAILED: '来源报告失败', CANCELLED: '来源已取消',
    NOT_APPLIED: '来源未应用', UNKNOWN: '结果待核对',
  };
  return labels[state ?? ''] ?? '结果待核对';
}

/** OBSERVED can wrap REQUESTED, so observation alone must not unlock resend. */
export function nativeReceiptSettled(receipt: NativeRequestView | undefined): boolean {
  return receipt?.state === 'REJECTED' || !!receipt?.source && ['APPLIED', 'CONSUMED', 'REJECTED', 'FAILED', 'CANCELLED', 'NOT_APPLIED'].includes(String(receipt.source.state));
}

export function nativeStatus(native: NativeTaskDetail | undefined): {label: string; tone: 'neutral' | 'info' | 'warning' | 'success' | 'danger'} {
  const state = native?.state ?? '';
  if (['SUCCEEDED', 'COMPLETED'].includes(state)) return {label: '已完成', tone: 'success'};
  if (['FAILED', 'TIMED_OUT'].includes(state)) return {label: state === 'FAILED' ? '执行失败' : '执行超时', tone: 'danger'};
  if (['CANCELLED', 'INTERRUPTED', 'STOPPED'].includes(state)) return {label: '已中断', tone: 'neutral'};
  if (state === 'PAUSED') return {label: '已暂停', tone: 'warning'};
  if (state.startsWith('WAITING')) return {label: '等待处理', tone: 'warning'};
  if (['RECOVERY_REQUIRED', 'UNKNOWN', 'NEEDS_ATTENTION'].includes(state)) return {label: '需要核对', tone: 'warning'};
  if (state === 'QUEUED') return {label: '排队中', tone: 'info'};
  if (state === 'PREPARING') return {label: '准备中', tone: 'info'};
  if (state === 'RUNNING') return native?.quiescent === true ? {label: '等待中', tone: 'neutral'} : {label: '执行中', tone: 'info'};
  return {label: '等待来源状态', tone: 'neutral'};
}

/** Pending input requests that still need a user answer. */
export function pendingQuestions(items: NativeInputRequest[] | undefined): NativeInputRequest[] {
  return (items ?? []).filter((item) => item.state === 'PENDING');
}

/**
 * Serial poll scheduler (design §9 — a slow GET must never overlap rounds):
 * the next round is scheduled only after the current run finishes. First
 * run starts immediately, like the previous setInterval+immediate pattern.
 */
export function createSerialPoll(run: () => Promise<void>, intervalMs: number): {cancel: () => void} {
  let alive = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const tick = async () => {
    if (!alive) return;
    try {
      await run();
    } finally {
      if (alive) timer = setTimeout(() => void tick(), intervalMs);
    }
  };
  void tick();
  return {
    cancel() {
      alive = false;
      if (timer !== undefined) clearTimeout(timer);
    },
  };
}
