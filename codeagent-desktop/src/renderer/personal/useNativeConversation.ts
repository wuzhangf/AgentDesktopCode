import {useCallback, useEffect, useRef, useState} from 'react';
import type {PersonalTaskDetail} from '../../../packages/protocol/src/personal-task';
import type {NativeInput, NativeInputRequest, NativeRequestView} from '../../../packages/protocol/src/native-task';
import {nativeMessagePage} from '../../../packages/protocol/src/native-task';
import {personalCall, readStored, writeStored, removeStored} from './personalGateway';
import {emptyNativeActivity, mergeNativeActivity, type NativeActivityView} from './nativeActivityModel';
import {
  clearSettledNativeTurns,
  emptyNativeLiveStream,
  interruptNativeLiveStream,
  reduceNativeTaskEventBatch,
  type NativeLiveStreamState,
} from '../app/activity/nativeVisibleTextProjection';
import {
  createSerialPoll,
  emptyNativeTranscript,
  mergeNativeMessagePage,
  nativeReceiptSettled,
  projectNativeConversation,
  type NativeConversationProjection,
  type NativeMessagePageDirection,
  type NativeMessagesView,
  type NativeTranscript,
} from './nativeConversationModel';

export interface NativeArtifacts {
  items: {artifactId: string; path: string; status: string; sha256?: string}[];
  reasonCode?: string;
}

const inputKey = (taskId: string) => `desktop.personal.input.${taskId}`;
const stopKey = (taskId: string) => `desktop.personal.stop.${taskId}`;
const sentKey = (taskId: string) => `desktop.personal.sent.${taskId}`;

/** A conversational write whose receipt settled non-rejected. The pi lane
 * never echoes user rows back through the transcript (INPUT_CONSUMED carries
 * only the requestKey), so the view keeps this per-task list as the durable
 * "my message" bubble — merge by requestKey if a structured row appears. */
export interface SentNativeInput {
  requestKey: string;
  content: string;
  kind: 'NATIVE_STEER' | 'NATIVE_FOLLOW_UP';
  at: number;
}

const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

/** Expected source ids from the verified task binding — a messages page
 * reporting different ids is dropped whole (C17). */
function expectedScopeOf(detail: PersonalTaskDetail | undefined): {taskId?: string; storeId?: string} {
  const binding = detail?.executionBinding;
  return {
    taskId: binding?.kind === 'WORKER_LOCAL' ? binding.localTaskId : undefined,
    storeId: detail?.sourceStoreId,
  };
}

/** Single native write controller for one task: polls the bounded task
 * projections and owns every write (message, input response, stop,
 * pause/resume) with the source generation/session/turn/command guards.
 * Pending requests are persisted by requestKey so they stay distinct from
 * source history and survive reloads; a second surface must not send on its
 * own.
 *
 * native-messages/1 (design §9): the tail read always fetches the recent
 * page without a cursor; `before`/`cursor` are sent only after a response
 * carried both the schema mark and the gateway-generated paging mark.
 * Rounds are serial — a slow GET defers the next round instead of stacking —
 * and a per-channel read sequence drops late tail responses so an older
 * failed or slower read can never overwrite a newer good view. */
export function useNativeConversation(taskId: string): {
  detail: PersonalTaskDetail | undefined;
  projection: NativeConversationProjection;
  transcript: NativeTranscript;
  /** Old-format snapshot view for compatibility readers (undefined once the
   * structured transcript is established). */
  messagesView: NativeMessagesView | undefined;
  inputRequests: NativeInputRequest[];
  artifacts: NativeArtifacts | undefined;
  activity: NativeActivityView;
  /** Ephemeral worker-events/1 delta tail (accelerator only — the structured
   * transcript stays authoritative). */
  liveStream: NativeLiveStreamState;
  /** Honest stream transport state for the reconnect/interruption UI. */
  streamStatus: 'idle' | 'connecting' | 'live' | 'reconnecting';
  readErrors: Record<string, string>;
  output: unknown;
  error: string;
  busy: boolean;
  pagingBusy: boolean;
  pendingInput: NativeInput | undefined;
  sentInputs: SentNativeInput[];
  inputReceipt: NativeRequestView | undefined;
  stopRequest: NativeInput | undefined;
  stopReceipt: NativeRequestView | undefined;
  verified: Record<string, string>;
  sendMessage: (content: string) => Promise<boolean>;
  respondInput: (question: NativeInputRequest, response: {value?: string; confirmed?: boolean; decision?: string}) => Promise<void>;
  stop: () => Promise<void>;
  control: (kind: 'PAUSE' | 'RESUME') => Promise<void>;
  reconcileInput: () => Promise<void>;
  reconcileStop: () => Promise<void>;
  acknowledgeInput: () => void;
  acknowledgeStop: () => void;
  verify: (artifact: NativeArtifacts['items'][number]) => Promise<void>;
  save: (artifact: NativeArtifacts['items'][number]) => Promise<void>;
  refresh: () => Promise<void>;
  loadEarlier: () => Promise<void>;
  loadNewer: () => Promise<void>;
} {
  const [detail, setDetail] = useState<PersonalTaskDetail>();
  const detailRef = useRef<PersonalTaskDetail | undefined>(undefined);
  const [transcript, setTranscript] = useState<NativeTranscript>(() => emptyNativeTranscript(`local:${taskId}`));
  const transcriptRef = useRef<NativeTranscript>(transcript);
  const [inputRequests, setInputRequests] = useState<NativeInputRequest[]>([]);
  const [artifacts, setArtifacts] = useState<NativeArtifacts>();
  const [activity, setActivity] = useState<NativeActivityView>(emptyNativeActivity);
  const activityRef = useRef(activity);
  const [liveStream, setLiveStream] = useState<NativeLiveStreamState>(emptyNativeLiveStream);
  const liveStreamRef = useRef(liveStream);
  const [streamStatus, setStreamStatus] = useState<'idle' | 'connecting' | 'live' | 'reconnecting'>('idle');
  const [readErrors, setReadErrors] = useState<Record<string, string>>({});
  const [output, setOutput] = useState<unknown>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [pagingBusy, setPagingBusy] = useState(false);
  const [pendingInput, setPendingInput] = useState<NativeInput | undefined>(() => readStored<NativeInput>(inputKey(taskId)));
  const [sentInputs, setSentInputs] = useState<SentNativeInput[]>(() => readStored<SentNativeInput[]>(sentKey(taskId)) ?? []);
  const [inputReceipt, setInputReceipt] = useState<NativeRequestView>();
  const [stopRequest, setStopRequest] = useState<NativeInput | undefined>(() => readStored<NativeInput>(stopKey(taskId)));
  const [stopReceipt, setStopReceipt] = useState<NativeRequestView>();
  const [verified, setVerified] = useState<Record<string, string>>({});
  const selectedTask = useRef(taskId);
  const mounted = useRef(true);
  const writing = useRef(false);
  const refreshing = useRef<Promise<void> | null>(null);
  selectedTask.current = taskId;
  const tailReadSeq = useRef(0);
  const pageFlight = useRef<Promise<void>>(Promise.resolve());
  const native = detail?.native;
  // A settled task owns its authoritative transcript — the event stream is
  // finished by definition, so resubscribes and stale interruption marks
  // must stop rather than linger as a false "reconnecting" warning.
  const taskSettled = ['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(String(native?.state ?? ''));
  const settledRef = useRef(false);
  settledRef.current = taskSettled;

  const current = useCallback((id: string) => mounted.current && selectedTask.current === id, []);

  const readError = useCallback((label: string, message: string | undefined) => {
    setReadErrors(old => {
      const next = {...old};
      if (message === undefined) delete next[label]; else next[label] = message;
      return next;
    });
  }, []);

  const applyTranscript = useCallback((next: NativeTranscript) => {
    if (next === transcriptRef.current) return;
    transcriptRef.current = next;
    setTranscript(next);
  }, []);

  /** Identity-stable channel application: a polled read returning content
   * identical to the last applied value must not replace the state object —
   * reference churn is what re-rendered the whole conversation every 2.5 s. */
  const appliedJson = useRef<Record<string, string>>({});
  const applyStable = useCallback(<T,>(channel: string, value: T, apply: (v: T) => void) => {
    let json: string;
    try { json = JSON.stringify(value) ?? 'null'; } catch { json = ''; }
    if (appliedJson.current[channel] === json) return;
    appliedJson.current[channel] = json;
    apply(value);
  }, []);

  /** Explicit refresh/paging reads share one flight so page responses apply
   * in request order; each job still re-checks the task target so a stale
   * response cannot land on a switched task (§9 read guards). */
  const enqueuePageRead = useCallback((job: () => Promise<void>): Promise<void> => {
    const run = pageFlight.current.then(job, job);
    pageFlight.current = run.then(() => undefined, () => undefined);
    return run;
  }, []);

  const applyMessagesResult = useCallback((raw: unknown, direction: NativeMessagePageDirection, id: string, bound?: string): 'structured' | 'legacy' | 'dropped' => {
    if (nativeMessagePage(raw)) {
      const expected = expectedScopeOf(detailRef.current);
      const prev = transcriptRef.current;
      const merged = mergeNativeMessagePage(prev, raw, direction, {
        bound,
        expectedTaskId: expected.taskId,
        expectedStoreId: expected.storeId,
      });
      if (merged === prev) return 'dropped';
      const prevRevision = prev.transcriptRevision;
      applyTranscript(merged);
      // §5.4.2: a transcriptRevision move re-reads the currently visible
      // history windows — at most two per bump — so a CONSUMED update on an
      // older sequence cannot stay invisible until the user pages again.
      if (direction === 'RECENT' && merged.paging && prevRevision !== undefined
          && merged.transcriptRevision !== undefined && merged.transcriptRevision !== prevRevision
          && merged.historyBounds.length > 0) {
        for (const windowBound of merged.historyBounds.slice(-2)) {
          void enqueuePageRead(async () => {
            const page = await personalCall<unknown>({action: 'TASK_MESSAGES', taskId: id, before: windowBound, limit: '100'});
            if (!current(id)) return;
            applyMessagesResult(page, 'REFRESH', id, windowBound);
          }).catch(() => { /* a failed history refresh keeps the last good window */ });
        }
      }
      return 'structured';
    }
    const currentTranscript = transcriptRef.current;
    if (currentTranscript.structured) return 'dropped'; // never downgrade an established structured view
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      // Legacy snapshots are full-page reads: identical payload keeps the
      // existing transcript object so downstream rows are not rebuilt.
      const legacyJson = JSON.stringify(raw);
      if (appliedJson.current['legacy'] === legacyJson) return 'dropped';
      appliedJson.current['legacy'] = legacyJson;
      applyTranscript({...currentTranscript, legacyView: raw as NativeMessagesView});
      return 'legacy';
    }
    return 'dropped';
  }, [applyTranscript, applyStable, enqueuePageRead, current]);

  const refresh = useCallback((): Promise<void> => {
    if (refreshing.current) return refreshing.current;
    const id = taskId;
    const readSeq = ++tailReadSeq.current;
    const live = () => current(id) && readSeq === tailReadSeq.current;
    async function read<T>(label: string, request: () => Promise<T>, apply: (value: T) => void) {
      try {
        const value = await request();
        if (!live()) return;
        apply(value);
        readError(label, undefined);
      } catch (e) {
        if (live()) readError(label, errorText(e));
      }
    }
    const cycle = async () => {
      let value: PersonalTaskDetail | undefined;
      await read('任务状态', () => personalCall<PersonalTaskDetail>({action: 'TASK', taskId: id}), next => {
        value = next;
        detailRef.current = next;
        applyStable('detail', next, setDetail);
      });
      if (!value?.native || !live()) return;
      // §9: detail/messages/inputs/artifacts read and fail independently — a
      // slow or broken channel never blanks the rest and never drops the last
      // good view. Each channel commits as its own read settles so a ~25 s
      // Codex /messages long-poll cannot hold back approvals or artifacts.
      await Promise.all([
        read('对话', () => personalCall<unknown>({action: 'TASK_MESSAGES', taskId: id, limit: '100'}), next => {
          applyMessagesResult(next, 'RECENT', id);
        }),
        read('成果', () => personalCall<NativeArtifacts>({action: 'NATIVE_ARTIFACTS', taskId: id}), next => applyStable('artifacts', next, setArtifacts)),
        read('待处理问题', () => personalCall<{items?: NativeInputRequest[]}>({action: 'NATIVE_INPUTS', taskId: id}), next => applyStable('inputs', next.items ?? [], setInputRequests)),
        read('执行活动', () => personalCall({action: 'TASK_ACTIVITY', taskId: id, afterCursor: activityRef.current.cursor, limit: '100'}), page => {
          const next = mergeNativeActivity(activityRef.current, page);
          if (next === activityRef.current) return;
          activityRef.current = next;
          setActivity(next);
        }),
        read('公开输出', () => personalCall({action: 'TASK_OUTPUT', taskId: id}), next => applyStable('output', next, setOutput)),
      ]);
    };
    refreshing.current = cycle().finally(() => { refreshing.current = null; });
    return refreshing.current;
  }, [taskId, applyMessagesResult, current, readError]);

  /** "加载较早内容": one bounded backward page under the loaded edge. The
   * `before` bound is the loaded first sequence itself — the source reads
   * strictly below it, so the returned page covers up to firstSequence-1. */
  const loadEarlier = useCallback(async () => {
    const id = taskId;
    const currentTranscript = transcriptRef.current;
    if (!currentTranscript.structured || !currentTranscript.paging || !currentTranscript.hasMoreHistory || !currentTranscript.earliestLoaded) return;
    const bound = currentTranscript.earliestLoaded;
    setPagingBusy(true);
    try {
      await enqueuePageRead(async () => {
        const page = await personalCall<unknown>({action: 'TASK_MESSAGES', taskId: id, before: bound, limit: '100'});
        if (!current(id)) return;
        if (!nativeMessagePage(page)) { readError('对话', '来源分页响应缺少 native-messages/1 标记'); return; }
        readError('对话', undefined);
        applyMessagesResult(page, 'OLDER', id, bound);
      });
    } catch (e) {
      if (current(id)) readError('对话', errorText(e));
    } finally {
      if (current(id)) setPagingBusy(false);
    }
  }, [taskId, applyMessagesResult, enqueuePageRead, current, readError]);

  /** "查看新消息": bounded forward catch-up from the newest loaded
   * sequence; cursor reads never move the history edge (§5.4.4). */
  const loadNewer = useCallback(async () => {
    const id = taskId;
    const currentTranscript = transcriptRef.current;
    if (!currentTranscript.structured || !currentTranscript.paging || !currentTranscript.hasNewer) return;
    const cursor = currentTranscript.newerCursor ?? currentTranscript.newestLoaded ?? '0';
    setPagingBusy(true);
    try {
      await enqueuePageRead(async () => {
        const page = await personalCall<unknown>({action: 'TASK_MESSAGES', taskId: id, cursor, limit: '100'});
        if (!current(id)) return;
        if (!nativeMessagePage(page)) { readError('对话', '来源分页响应缺少 native-messages/1 标记'); return; }
        readError('对话', undefined);
        applyMessagesResult(page, 'NEWER', id, cursor);
      });
    } catch (e) {
      if (current(id)) readError('对话', errorText(e));
    } finally {
      if (current(id)) setPagingBusy(false);
    }
  }, [taskId, applyMessagesResult, enqueuePageRead, current, readError]);

  // §9: serial polling — the next round is scheduled only after the current
  // one ends, so a slow source GET can no longer overlap poll rounds. A
  // settled task drops to a slow liveness cadence: nothing new should arrive,
  // but a follow-up opened elsewhere still becomes visible.
  useEffect(() => {
    mounted.current = true;
    const poll = createSerialPoll(() => refresh(), taskSettled ? 15000 : 2500);
    return () => { mounted.current = false; poll.cancel(); };
  }, [refresh, taskSettled]);

  // worker-events/1 live tail (design §8.4): Electron main owns the SSE
  // transport end to end — the renderer only sees bounded pushes through
  // the fixed 'app/events/native' channel and the whitelisted subscribe op.
  // The stream only accelerates visibility; the 2.5 s poll above stays the
  // authoritative reconciliation path. Subscribe only after the task read
  // confirmed a WORKER_LOCAL binding — never a renderer-supplied local id.
  const nativeBound = detail?.executionBinding?.kind === 'WORKER_LOCAL';
  // A different task owns a different cursor and delta stream — never reuse
  // the prior task's ephemeral tail if taskId changes without a remount.
  useEffect(() => {
    liveStreamRef.current = emptyNativeLiveStream();
    setLiveStream(liveStreamRef.current);
    setStreamStatus('idle');
  }, [taskId]);
  useEffect(() => {
    if (!nativeBound) return;
    const api = window.codeAgentDesktop;
    if (typeof api?.onNativeTaskEvents !== 'function') return;
    const id = taskId;
    let alive = true;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let attempts = 0;
    const applyLive = (next: NativeLiveStreamState) => {
      if (next === liveStreamRef.current) return;
      liveStreamRef.current = next;
      setLiveStream(next);
    };
    const scheduleResubscribe = () => {
      // No attempt cap while the task is live: a bounded backoff keeps the
      // real-time tail recoverable instead of silently giving up after six
      // tries — the 'reconnecting' status stays visible the whole time.
      if (retryTimer !== undefined || !alive || settledRef.current) return;
      const delay = Math.min(15000, 500 * 2 ** Math.min(attempts, 5));
      attempts += 1;
      retryTimer = setTimeout(() => { retryTimer = undefined; void subscribe(); }, delay);
    };
    const subscribe = async () => {
      if (!alive || !mounted.current || settledRef.current) return;
      setStreamStatus(s => (s === 'live' ? s : 'connecting'));
      try {
        const cursor = liveStreamRef.current.lastCursor;
        await personalCall({
          action: 'TASK_EVENTS_SUBSCRIBE', taskId: id,
          ...(cursor > 0 ? { afterCursor: String(cursor) } : {}),
        });
        attempts = 0;
      } catch {
        if (!alive || !mounted.current) return;
        setStreamStatus('reconnecting');
        applyLive(interruptNativeLiveStream(liveStreamRef.current));
        scheduleResubscribe();
      }
    };
    const off = api.onNativeTaskEvents(push => {
      if (!alive || !mounted.current || push.taskId !== id) return;
      if (push.frames?.length) applyLive(reduceNativeTaskEventBatch(liveStreamRef.current, push.frames));
      if (push.resync) applyLive(interruptNativeLiveStream(liveStreamRef.current));
      if (push.status === 'CONNECTED') {
        attempts = 0;
        setStreamStatus('live');
      } else if (push.status === 'RECONNECTING' || push.status === 'DISCONNECTED') {
        setStreamStatus('reconnecting');
        applyLive(interruptNativeLiveStream(liveStreamRef.current));
        // DISCONNECTED means main dropped the subscription (generation
        // change or exhausted resyncs) — re-arm the bounded subscribe.
        if (push.status === 'DISCONNECTED') scheduleResubscribe();
      } else if (push.status === 'UNSUBSCRIBED') {
        setStreamStatus('idle');
      }
    });
    void subscribe();
    return () => {
      alive = false;
      if (retryTimer !== undefined) clearTimeout(retryTimer);
      off();
      void personalCall({ action: 'TASK_EVENTS_UNSUBSCRIBE', taskId: id }).catch(() => {});
    };
  }, [taskId, nativeBound]);

  // Terminal settle retires the stream's honest-degradation marks too: the
  // transcript is authoritative from here, so a leftover `reconnecting`
  // status or `interrupted` flag must not outlive the task.
  useEffect(() => {
    if (!taskSettled) return;
    setStreamStatus('idle');
    if (liveStreamRef.current.interrupted) {
      liveStreamRef.current = { ...liveStreamRef.current, interrupted: false };
      setLiveStream(liveStreamRef.current);
    }
  }, [taskSettled]);

  // Authoritative settle (§8.4): once a TASK_MESSAGES page proves the
  // terminal assistant row for a turn, its ephemeral delta tail clears —
  // the structured transcript owns the text from then on.
  useEffect(() => {
    const settled = new Set<string>();
    for (const item of transcript.items.values()) {
      if (item.role === 'assistant' && item.nativeTurnId && item.status === 'COMPLETED') settled.add(item.nativeTurnId);
    }
    if (settled.size === 0) return;
    const next = clearSettledNativeTurns(liveStreamRef.current, settled);
    if (next === liveStreamRef.current) return;
    liveStreamRef.current = next;
    setLiveStream(next);
  }, [transcript]);

  // §5.4.1: entering the task and returning to the foreground re-read the
  // recent page; merges keep the higher per-row revision.
  useEffect(() => {
    const onForeground = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      void refresh();
    };
    window.addEventListener('focus', onForeground);
    document.addEventListener('visibilitychange', onForeground);
    return () => {
      window.removeEventListener('focus', onForeground);
      document.removeEventListener('visibilitychange', onForeground);
    };
  }, [refresh]);

  async function work(fn: () => Promise<void>) {
    if (writing.current) return;
    writing.current = true;
    setBusy(true);
    setError('');
    try { await fn(); } catch (e) { if (mounted.current) setError(errorText(e)); } finally { writing.current = false; if (mounted.current) setBusy(false); }
  }

  const sendMessage = useCallback(async (content: string): Promise<boolean> => {
    if (!content.trim()) return false;
    // The public intake bound is 16,384 UTF-8 bytes — textarea maxLength
    // counts UTF-16 units, so the byte check lives here at the write edge.
    if (new TextEncoder().encode(content).length > 16384) {
      setError('输入超过 16384 字节的公开上限');
      return false;
    }
    if (!native?.generation || !native.nativeSessionId || !native.currentCommandId || pendingInput || writing.current) return false;
    if (detail?.sourceError || readErrors['任务状态']) return false;
    const running = native.quiescent !== true;
    const kind = running && native.capabilities?.steer ? 'NATIVE_STEER' : 'NATIVE_FOLLOW_UP';
    if (kind === 'NATIVE_STEER' && !native.capabilities?.steer) return false;
    if (kind === 'NATIVE_FOLLOW_UP' && !native.capabilities?.followUp) return false;
    const id = taskId;
    let persisted = false;
    await work(async () => {
      const request: NativeInput = {
        generation: native.generation!, nativeSessionId: native.nativeSessionId!,
        nativeTurnId: native.nativeTurnId ?? undefined, targetCommandId: native.currentCommandId!,
        requestKey: 'desktop-input-' + crypto.randomUUID(), kind, content,
      };
      writeStored(inputKey(id), request); setPendingInput(request);
      persisted = true;
      const receipt = await personalCall<NativeRequestView>({action: 'NATIVE_MESSAGE_CREATE', taskId: id, key: request.requestKey, body: request as Extract<NativeInput, {kind: 'NATIVE_STEER' | 'NATIVE_FOLLOW_UP'}>});
      if (current(id)) setInputReceipt(receipt);
      void refresh();
    });
    return persisted;
  }, [native, pendingInput, taskId, refresh, current, detail?.sourceError, readErrors]);

  const respondInput = useCallback(async (question: NativeInputRequest, response: {value?: string; confirmed?: boolean; decision?: string}) => {
    if (pendingInput) return;
    const id = taskId;
    await work(async () => {
      const request: NativeInput = {
        generation: question.generation, nativeSessionId: question.nativeSessionId,
        nativeTurnId: question.nativeTurnId, targetCommandId: question.targetCommandId,
        requestKey: 'desktop-input-' + crypto.randomUUID(), kind: 'INPUT_RESPONSE',
        inputRequestId: question.inputRequestId, response,
      };
      writeStored(inputKey(id), request); setPendingInput(request);
      const receipt = await personalCall<NativeRequestView>({action: 'NATIVE_INPUT_RESPONSE', taskId: id, entityId: question.inputRequestId, key: request.requestKey, body: request});
      if (current(id)) setInputReceipt(receipt);
      void refresh();
    });
  }, [pendingInput, taskId, refresh, current]);

  const stop = useCallback(async () => {
    if (!native || !native.capabilities?.stop || !native.generation || !native.currentCommandId) return;
    const id = taskId;
    await work(async () => {
      const request: NativeInput = {
        requestKey: 'desktop-stop-' + crypto.randomUUID(), kind: 'STOP',
        generation: native.generation!, nativeSessionId: native.nativeSessionId ?? null,
        nativeTurnId: native.nativeTurnId ?? null, targetCommandId: native.currentCommandId!,
      };
      writeStored(stopKey(id), request); setStopRequest(request);
      const receipt = await personalCall<NativeRequestView>({action: 'TASK_COMMAND_CREATE', taskId: id, key: request.requestKey, body: request as Extract<NativeInput, {kind: 'STOP'}>});
      if (current(id)) setStopReceipt(receipt);
      void refresh();
    });
  }, [native, taskId, refresh, current]);

  const control = useCallback(async (kind: 'PAUSE' | 'RESUME') => {
    if (pendingInput || !native?.generation || !native.nativeSessionId || !native.currentCommandId || !native.capabilities?.[kind === 'PAUSE' ? 'pause' : 'resume']) return;
    const id = taskId;
    await work(async () => {
      const request: NativeInput = {
        requestKey: 'desktop-control-' + crypto.randomUUID(), kind,
        generation: native.generation!, nativeSessionId: native.nativeSessionId!,
        nativeTurnId: native.nativeTurnId ?? undefined, targetCommandId: native.currentCommandId!,
      };
      writeStored(inputKey(id), request); setPendingInput(request);
      const receipt = await personalCall<NativeRequestView>({action: 'TASK_COMMAND_CREATE', taskId: id, key: request.requestKey, body: request});
      if (current(id)) setInputReceipt(receipt);
      void refresh();
    });
  }, [native, pendingInput, taskId, refresh, current]);

  const reconcileInput = useCallback(async () => {
    if (!pendingInput) return;
    const id = taskId, key = pendingInput.requestKey;
    await work(async () => {
      const receipt = await personalCall<NativeRequestView>({action: 'TASK_INTERACTION_REQUEST', taskId: id, requestKey: key});
      if (current(id)) setInputReceipt(receipt);
    });
  }, [pendingInput, taskId, current]);

  const reconcileStop = useCallback(async () => {
    if (!stopRequest) return;
    const id = taskId, key = stopRequest.requestKey;
    await work(async () => {
      const receipt = await personalCall<NativeRequestView>({action: 'TASK_INTERACTION_REQUEST', taskId: id, requestKey: key});
      if (current(id)) setStopReceipt(receipt);
    });
  }, [stopRequest, taskId, current]);

  const acknowledgeInput = useCallback(() => {
    if (!nativeReceiptSettled(inputReceipt)) return;
    removeStored(inputKey(taskId));
    setPendingInput(undefined);
    setInputReceipt(undefined);
  }, [taskId, inputReceipt]);

  // Settled, non-rejected conversational writes become durable user bubbles.
  // Rejected ones stay pending so the refusal and the draft remain visible.
  useEffect(() => {
    if (!pendingInput || !nativeReceiptSettled(inputReceipt)) return;
    const state = String(inputReceipt?.source?.state ?? inputReceipt?.state ?? '');
    if (state === 'REJECTED') return;
    if (pendingInput.kind === 'NATIVE_STEER' || pendingInput.kind === 'NATIVE_FOLLOW_UP') {
      const entry: SentNativeInput = {requestKey: pendingInput.requestKey, content: pendingInput.content, kind: pendingInput.kind, at: Date.now()};
      setSentInputs(list => {
        if (list.some(row => row.requestKey === entry.requestKey)) return list;
        const next = [...list.slice(-49), entry];
        try { writeStored(sentKey(taskId), next); } catch { /* In-memory copy still renders this session. */ }
        return next;
      });
    }
    removeStored(inputKey(taskId));
    setPendingInput(undefined);
    setInputReceipt(undefined);
  }, [pendingInput, inputReceipt, taskId]);

  const acknowledgeStop = useCallback(() => {
    if (!nativeReceiptSettled(stopReceipt)) return;
    removeStored(stopKey(taskId));
    setStopRequest(undefined);
    setStopReceipt(undefined);
  }, [taskId, stopReceipt]);

  const verify = useCallback(async (artifact: NativeArtifacts['items'][number]) => {
    await work(async () => {
      const file = await personalCall<{path: string; encoding: string; bytes: string; sha256: string}>({action: 'NATIVE_ARTIFACT', taskId, entityId: artifact.artifactId});
      if (file.encoding !== 'base64' || file.path !== artifact.path) throw new Error('成果路径或编码不一致');
      const bytes = Uint8Array.from(atob(file.bytes), (value) => value.charCodeAt(0));
      const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))).map((value) => value.toString(16).padStart(2, '0')).join('');
      if (digest !== file.sha256 || artifact.sha256 && digest !== artifact.sha256) throw new Error('成果 SHA-256 不一致');
      setVerified((value) => ({...value, [artifact.artifactId]: digest}));
    });
  }, [taskId]);

  const save = useCallback(async (artifact: NativeArtifacts['items'][number]) => {
    await work(async () => {
      if (!detail?.sourceStoreId || !artifact.sha256 || !window.codeAgentDesktop.saveNativeArtifact) throw new Error('成果保存尚不可用');
      const result = await window.codeAgentDesktop.saveNativeArtifact({taskId, artifactId: artifact.artifactId, sourceStoreId: detail.sourceStoreId, sha256: artifact.sha256, path: artifact.path});
      if ('error' in result) throw new Error(String(result.error));
      if (!result.canceled) setVerified((value) => ({...value, [artifact.artifactId]: '已保存 ' + result.sha256}));
    });
  }, [taskId, detail?.sourceStoreId]);

  const projection = projectNativeConversation(
    transcript,
    pendingInput
      ? {request: pendingInput, receiptState: inputReceipt ? String(inputReceipt.source?.state ?? inputReceipt.state) : undefined}
      : undefined,
  );

  return {
    detail, projection, transcript, messagesView: transcript.legacyView, inputRequests, artifacts, activity, output, readErrors,
    liveStream, streamStatus,
    error, busy, pagingBusy, pendingInput, sentInputs, inputReceipt, stopRequest, stopReceipt, verified,
    sendMessage, respondInput, stop, control, reconcileInput, reconcileStop,
    acknowledgeInput, acknowledgeStop, verify, save, refresh, loadEarlier, loadNewer,
  };
}
