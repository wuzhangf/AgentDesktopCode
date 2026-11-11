// NEW (Codex structured conversation phase 1, design 2026-10-29 §5/§7/§9):
// pure projection coverage for the native-messages/1 transcript — merge
// order, revision guards, paging edges, LEGACY_PREFIX and the local-pending
// visual merge. Decimal sequences stay BigInt-compared end to end.
import {describe, expect, it, vi, afterEach} from 'vitest';
import {
  createSerialPoll,
  emptyNativeTranscript,
  mergeNativeMessagePage,
  nativeMessageStatusLabel,
  nativePendingSyncLabel,
  projectNativeConversation,
  sortedNativeItems,
  type NativeTranscript,
} from '../../src/renderer/personal/nativeConversationModel';
import {
  NATIVE_MESSAGE_SCHEMA_VERSION,
  NATIVE_MESSAGE_TRANSPORT_VERSION,
  type NativeMessageItem,
  type NativeMessagePage,
} from '../../packages/protocol/src/native-task';
import type {NativeInput} from '../../packages/protocol/src/native-task';

function item(sequence: string | number, revision: string | number, role: string, text: string, status: string, extra: Partial<NativeMessageItem> = {}): NativeMessageItem {
  return {messageId: `m-${sequence}`, sequence: String(sequence), revision: String(revision), role, text, status, ...extra};
}

function page(items: NativeMessageItem[], over: Partial<NativeMessagePage> = {}): NativeMessagePage {
  return {
    messageSchemaVersion: NATIVE_MESSAGE_SCHEMA_VERSION,
    taskId: 'local-1',
    storeId: 'store-1',
    transcriptRevision: '1',
    items,
    firstSequence: items[0]?.sequence ?? null,
    cursor: items[0]?.sequence ?? null,
    latestSequence: items[items.length - 1]?.sequence ?? null,
    hasMore: false,
    cursorExpired: false,
    historyMode: 'STRUCTURED_FROM_START',
    legacy: null,
    text: '累计输出不应作为正文',
    coverage: 'BOUNDED_PUBLIC_MESSAGES',
    messageTransportVersion: NATIVE_MESSAGE_TRANSPORT_VERSION,
    ...over,
  };
}

function transcript(pages: ([NativeMessagePage] | [NativeMessagePage, 'RECENT' | 'OLDER' | 'NEWER' | 'REFRESH', string?])[]): NativeTranscript {
  let t = emptyNativeTranscript('local:t1');
  for (const [p, direction = 'RECENT', bound] of pages) t = mergeNativeMessagePage(t, p, direction, {bound});
  return t;
}

describe('native-messages/1 transcript merge', () => {
  it('keeps disjoint recent snapshots reachable through the first unread cursor', () => {
    let t = transcript([[page([item(1, 1, 'user', 'first', 'ACCEPTED'), item(2, 1, 'assistant', 'second', 'COMPLETED')])]]);
    t = mergeNativeMessagePage(t, page([item(8, 1, 'assistant', 'eighth', 'COMPLETED')], {hasMore: true}), 'RECENT');
    expect(t.hasNewer).toBe(true);
    expect(t.newerCursor).toBe('2');
    t = mergeNativeMessagePage(t, page([item(3, 1, 'assistant', 'third', 'COMPLETED'), item(4, 1, 'assistant', 'fourth', 'COMPLETED')], {latestSequence: '8', hasMore: true}), 'NEWER', {bound: '2'});
    expect(t.newerCursor).toBe('4');
    t = mergeNativeMessagePage(t, page([5, 6, 7, 8].map(seq => item(seq, 1, 'assistant', String(seq), 'COMPLETED')), {hasMore: false}), 'NEWER', {bound: '4'});
    expect(t.hasNewer).toBe(false);
    expect(sortedNativeItems(t).map(row => row.sequence)).toEqual(['1', '2', '3', '4', '5', '6', '7', '8']);
  });

  it('does not let a slower forward snapshot claim coverage of a newer tail', () => {
    let t = transcript([[page([item(1, 1, 'assistant', 'one', 'COMPLETED')])]]);
    t = mergeNativeMessagePage(t, page([item(10, 1, 'assistant', 'ten', 'COMPLETED')], {hasMore: true}), 'RECENT');
    t = mergeNativeMessagePage(t, page([item(2, 1, 'assistant', 'two', 'COMPLETED')], {latestSequence: '2', hasMore: false}), 'NEWER', {bound: '1'});
    expect(t.hasNewer).toBe(true);
    expect(t.newerCursor).toBe('2');
  });

  it('orders rows by decimal sequence including values past the JS safe range', () => {
    // Two near-i64-max sequences only distinguishable by BigInt compare.
    const t = transcript([[page([
      item('9223372036854775807', 1, 'assistant', 'max', 'COMPLETED'),
      item('9', 1, 'user', '九', 'ACCEPTED'),
      item('9223372036854775806', 1, 'assistant', 'max-1', 'COMPLETED'),
      item('10', 1, 'assistant', '十', 'COMPLETED'),
    ])]]);
    expect(sortedNativeItems(t).map((i) => i.sequence)).toEqual(['9', '10', '9223372036854775806', '9223372036854775807']);
    const proj = projectNativeConversation(t, undefined);
    expect(proj.rows.map((r) => r.id)).toEqual(sortedNativeItems(t).map((i) => `source-${i.messageId}`));
  });

  it('keeps two identical bodies as two rows and never merges by text', () => {
    const t = transcript([[page([
      item('4', 1, 'user', '相同正文', 'CONSUMED', {sourceRequestKey: 'k-a'}),
      item('7', 1, 'user', '相同正文', 'ACCEPTED', {sourceRequestKey: 'k-b'}),
    ])]]);
    const proj = projectNativeConversation(t, undefined);
    expect(proj.rows.filter((r) => r.text === '相同正文')).toHaveLength(2);
    expect(proj.rows[0]!.id).not.toBe(proj.rows[1]!.id);
  });

  it('keeps the higher decimal revision for the same messageId (10 > 9, not lexicographic)', () => {
    let t = transcript([[page([item('3', 10, 'user', '受理后正文', 'CONSUMED')])]]);
    // An older snapshot still carrying revision 9 must not downgrade the row.
    t = mergeNativeMessagePage(t, page([item('3', 9, 'user', '受理后正文', 'ACCEPTED')]), 'REFRESH', {bound: '5'});
    const rows = projectNativeConversation(t, undefined).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('CONSUMED');
    expect(rows[0]!.statusLabel).toBe('来源已消费');
    expect(rows[0]!.diagnostics?.find((d) => d.label === '修订')?.value).toBe('10');
  });

  it('older pages move the history edge and record the bound; REFRESH merges rows without moving edges', () => {
    let t = transcript([[page([item('9', 1, 'assistant', 'a9', 'COMPLETED'), item('10', 1, 'assistant', 'a10', 'COMPLETED')], {hasMore: true})]]);
    expect(t.hasMoreHistory).toBe(true);
    t = mergeNativeMessagePage(t, page([item('5', 1, 'assistant', 'a5', 'COMPLETED'), item('6', 1, 'assistant', 'a6', 'COMPLETED')], {hasMore: true}), 'OLDER', {bound: '9'});
    expect(t.earliestLoaded).toBe('5');
    expect(t.historyBounds).toEqual(['9']);
    expect(t.hasMoreHistory).toBe(true);
    // Interior window re-read after a transcriptRevision move: same window
    // rows merge but the edge, bounds and direction flags stay put.
    t = mergeNativeMessagePage(t, page([item('5', 2, 'assistant', 'a5-updated', 'COMPLETED')], {hasMore: true}), 'REFRESH', {bound: '9'});
    expect(t.earliestLoaded).toBe('5');
    expect(t.historyBounds).toEqual(['9']);
    expect(t.hasMoreHistory).toBe(true);
    expect(sortedNativeItems(t).find((i) => i.messageId === 'm-5')!.revision).toBe('2');
    expect(sortedNativeItems(t).find((i) => i.messageId === 'm-5')!.text).toBe('a5-updated');
    // A recent page arriving after deep paging does not re-raise the edge.
    t = mergeNativeMessagePage(t, page([item('9', 1, 'assistant', 'a9', 'COMPLETED'), item('10', 1, 'assistant', 'a10', 'COMPLETED')], {hasMore: true}), 'RECENT');
    expect(t.hasMoreHistory).toBe(true);
    t = mergeNativeMessagePage(t, page([], {hasMore: false, firstSequence: null, cursor: null}), 'OLDER', {bound: '5'});
    expect(t.hasMoreHistory).toBe(false);
    t = mergeNativeMessagePage(t, page([item('11', 1, 'assistant', 'a11', 'COMPLETED')], {hasMore: true}), 'RECENT');
    expect(t.hasMoreHistory).toBe(false); // historyLoaded: tail read no longer owns the edge
  });

  it('flags newer source sequences until a cursor read catches up', () => {
    let t = transcript([[page([item('9', 1, 'assistant', 'a9', 'COMPLETED')], {latestSequence: '12'})]]);
    expect(t.hasNewer).toBe(true);
    t = mergeNativeMessagePage(t, page([item('10', 1, 'assistant', 'a10', 'COMPLETED'), item('11', 1, 'assistant', 'a11', 'COMPLETED'), item('12', 1, 'assistant', 'a12', 'COMPLETED')], {latestSequence: '12', hasMore: false}), 'NEWER', {bound: '9'});
    expect(t.hasNewer).toBe(false);
    expect(t.newestLoaded).toBe('12');
  });

  it('raises transcriptRevision monotonically — a slow older snapshot is not a regression', () => {
    let t = transcript([[page([item('9', 1, 'assistant', 'a9', 'COMPLETED')], {transcriptRevision: '5'})]]);
    t = mergeNativeMessagePage(t, page([item('9', 2, 'assistant', 'a9v2', 'COMPLETED')], {transcriptRevision: '3'}), 'REFRESH', {bound: '9'});
    expect(t.transcriptRevision).toBe('5');
    expect(sortedNativeItems(t)[0]!.revision).toBe('2');
  });

  it('drops a whole page whose taskId/storeId conflicts with the binding or learned scope', () => {
    let t = emptyNativeTranscript('local:t1');
    const foreign = page([item('1', 1, 'user', '别任务正文', 'ACCEPTED')], {taskId: 'other-task'});
    const same = mergeNativeMessagePage(t, foreign, 'RECENT', {expectedTaskId: 'local-1', expectedStoreId: 'store-1'});
    expect(same).toBe(t); // rejected pages return the previous transcript identity
    t = mergeNativeMessagePage(t, page([item('1', 1, 'user', '本任务', 'ACCEPTED')]), 'RECENT');
    expect(t.pageTaskId).toBe('local-1');
    const again = mergeNativeMessagePage(t, page([item('2', 1, 'user', '换库任务', 'ACCEPTED')], {storeId: 'store-2'}), 'RECENT');
    expect(again.items.size).toBe(1); // learned scope rejected the store-2 page
  });

  it('ignores non-native-messages payloads and malformed items', () => {
    let t = emptyNativeTranscript('local:t1');
    const legacyPayload = {items: [{role: 'assistant', text: '旧 Pi 快照'}], text: '累计'} as unknown as NativeMessagePage;
    expect(mergeNativeMessagePage(t, legacyPayload, 'RECENT')).toBe(t);
    t = mergeNativeMessagePage(t, page([
      item('1', 1, 'assistant', '合法', 'COMPLETED'),
      {messageId: '', sequence: '2', revision: '1', role: 'user', text: '坏行', status: 'ACCEPTED'} as NativeMessageItem,
      {messageId: 'bad-seq', sequence: 'abc', revision: '1', role: 'user', text: '坏序号', status: 'ACCEPTED'} as unknown as NativeMessageItem,
    ]), 'RECENT');
    expect(t.items.size).toBe(1);
  });
});

describe('native-messages/1 projection', () => {
  it('shows frozen legacy block for LEGACY_PREFIX even when items exist — never as an empty-list fallback', () => {
    const legacy = {text: '冻结累计输出', textTruncated: false};
    const t = transcript([[page([item('9', 1, 'assistant', '新回复', 'COMPLETED')], {historyMode: 'LEGACY_PREFIX', legacy})]]);
    const proj = projectNativeConversation(t, undefined);
    expect(proj.legacyBlock).toEqual({text: '冻结累计输出', textTruncated: false});
    expect(proj.rows).toHaveLength(1); // the new structured row still renders
    expect(proj.accumulatedText).toBeUndefined(); // page.text is not a second body
  });

  it('reports EMPTY for a legacy block without text and hides the block for STRUCTURED_FROM_START', () => {
    const legacyPrefix = transcript([[page([], {historyMode: 'LEGACY_PREFIX', legacy: null, firstSequence: null, latestSequence: null})]]);
    expect(projectNativeConversation(legacyPrefix, undefined).legacyBlock).toBe('EMPTY');
    const structured = transcript([[page([item('1', 1, 'user', '要求', 'ACCEPTED')])]]);
    expect(projectNativeConversation(structured, undefined).legacyBlock).toBeUndefined();
  });

  it('keeps the legacy snapshot path for pre-schema sources (Pi items, Codex text)', () => {
    let t = emptyNativeTranscript('local:t1');
    t = {...t, legacyView: {items: [{role: 'user', text: '第一条'}, {role: 'assistant', text: '回复'}], text: '备用累计', coverage: 'PUBLIC'}};
    const proj = projectNativeConversation(t, undefined);
    expect(proj.structured).toBe(false);
    expect(proj.rows.map((r) => r.id)).toEqual(['source-0', 'source-1']); // array-index keys only on the legacy path
    // Items already display the snapshot — cumulative text is not a second body.
    expect(proj.accumulatedText).toBeUndefined();
    const codex = projectNativeConversation({...t, legacyView: {text: '累计助手输出'}}, undefined);
    expect(codex.rows).toHaveLength(0);
    expect(codex.accumulatedText).toBe('累计助手输出');
  });

  it('merges a local pending write into the source row by actual sourceRequestKey only', () => {
    const t = transcript([[page([
      item('3', 1, 'user', '本端要求', 'ACCEPTED', {sourceRequestKey: 'desktop-input-k1'}),
      item('4', 1, 'user', '手机端要求', 'CONSUMED', {sourceRequestKey: 'mobile-hash-9'}),
    ])]]);
    const request: NativeInput = {
      kind: 'NATIVE_FOLLOW_UP', requestKey: 'desktop-input-k1', content: '本端要求',
      generation: 'g1', nativeSessionId: 's1', targetCommandId: 'cmd1',
    };
    const proj = projectNativeConversation(t, {request, receiptState: 'ACCEPTED'});
    expect(proj.rows).toHaveLength(2); // one visual row, not two
    expect(proj.rows[0]!.mergedLocalRequest).toBe(true);
    expect(proj.rows[0]!.pending).toBeUndefined(); // still a source row
    expect(proj.rows[1]!.sourceRequestKey).toBe('mobile-hash-9'); // other-end row stays visible
    // A pending key that never matches a source row keeps its own syncing row.
    const unmatched = projectNativeConversation(t, {
      request: {...request, requestKey: 'desktop-input-new', content: '还没读到的本地行'},
      receiptState: 'OBSERVED',
    });
    expect(unmatched.rows).toHaveLength(3);
    expect(unmatched.rows[2]!.id).toBe('pending-desktop-input-new');
    expect(unmatched.rows[2]!.receipt).toBe('来源已受理，历史同步中');
    // Identical text alone must NOT merge — the requestKey is the only join.
    const lookalike = projectNativeConversation(t, {
      request: {...request, requestKey: 'desktop-input-other', content: '本端要求'},
      receiptState: undefined,
    });
    expect(lookalike.rows).toHaveLength(3);
    expect(lookalike.rows[2]!.receipt).toBe('本地待确认 · 结果待核对');
  });

  it('labels user and assistant statuses honestly', () => {
    expect(nativeMessageStatusLabel('user', 'ACCEPTED')).toBe('来源已受理');
    expect(nativeMessageStatusLabel('user', 'CONSUMED')).toBe('来源已消费');
    expect(nativeMessageStatusLabel('user', 'REJECTED')).toBe('来源已拒绝');
    expect(nativeMessageStatusLabel('user', 'UNKNOWN')).toBe('结果待核对');
    expect(nativeMessageStatusLabel('assistant', 'COMPLETED')).toBe('本条回复已完成');
    expect(nativeMessageStatusLabel('assistant', 'COMPLETED')).not.toContain('任务已完成');
    expect(nativePendingSyncLabel('CONSUMED')).toBe('来源已消费，历史同步中');
    expect(nativePendingSyncLabel('APPLIED')).toBe('来源已确认，历史同步中');
    expect(nativePendingSyncLabel('REJECTED')).toBe('来源已拒绝');
    expect(nativePendingSyncLabel(undefined)).toBe('本地待确认 · 结果待核对');
    const t = transcript([[page([item('2', 1, 'assistant', '完成正文', 'COMPLETED')])]]);
    expect(projectNativeConversation(t, undefined).rows[0]!.statusLabel).toBe('本条回复已完成');
  });

  it('flags textTruncated rows and keeps internal ids in diagnostics', () => {
    const t = transcript([[page([item('5', 1, 'assistant', '截断正文', 'COMPLETED', {textTruncated: true, commandId: 'cmd-9', nativeTurnId: 'turn-7'})])]]);
    const row = projectNativeConversation(t, undefined).rows[0]!;
    expect(row.textTruncated).toBe(true);
    const labels = row.diagnostics?.map((d) => `${d.label}=${d.value}`) ?? [];
    expect(labels).toContain('消息 ID=m-5');
    expect(labels).toContain('命令=cmd-9');
    expect(labels).toContain('原生轮次=turn-7');
  });
});

describe('serial poll scheduler', () => {
  afterEach(() => vi.useRealTimers());

  it('never overlaps rounds — a slow read defers the next one', async () => {
    vi.useFakeTimers();
    let running = 0;
    const calls: number[] = [];
    const gate: {release?: () => void} = {};
    const poll = createSerialPoll(async () => {
      running += 1;
      calls.push(Date.now());
      await new Promise<void>((resolve) => { gate.release = resolve; });
      running -= 1;
    }, 2500);
    await vi.advanceTimersByTimeAsync(20000); // far past several intervals
    expect(calls).toHaveLength(1); // still inside the first round — nothing stacked
    gate.release!();
    await vi.advanceTimersByTimeAsync(2499);
    expect(calls).toHaveLength(1); // the interval only starts after the run ends
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toHaveLength(2); // next round fires a full interval later
    poll.cancel();
  });

  it('cancel stops future rounds', async () => {
    vi.useFakeTimers();
    let count = 0;
    const poll = createSerialPoll(async () => { count += 1; }, 2500);
    await vi.advanceTimersByTimeAsync(0);
    poll.cancel();
    await vi.advanceTimersByTimeAsync(10000);
    expect(count).toBe(1);
  });
});
