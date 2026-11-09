import {useEffect, useLayoutEffect, useMemo, useRef, useState} from 'react';
import {ConversationMessage} from '../app/conversation/ConversationMessage';
import {ConversationHeaderFrame, HeaderAction} from '../app/conversation/ConversationHeader';
import {VirtualMessageWindow} from '../app/conversation/VirtualMessageWindow';
import {Icon} from '../app/Icon';
import {useNativeConversation} from './useNativeConversation';
import {nativeReceiptLabel, nativeReceiptSettled, nativeStatus, pendingQuestions, type NativeMessageRow} from './nativeConversationModel';
import type {NativeActivityRow} from './nativeActivityModel';
import {nativeLiveTailText, nativeThinkingBlocks} from '../app/activity/nativeVisibleTextProjection';
import {readStored, writeStored} from './personalGateway';
import {NativeQuestion} from './NativeQuestion';

const ENGINE_LABELS: Record<string, string> = {pi: 'Pi', codex: 'Codex', macos: 'Mac', codep: 'Codep'};
const ACTIVITY_LABELS = {running: '执行中', completed: '已完成', failed: '失败', rejected: '已拒绝', unknown: '结果未报告'};
const EVENT_LABELS: Record<string, string> = {
  THINKING_DELTA: '思考中', OUTPUT_DELTA: '生成中', TOOL_START: '执行工具', TOOL_END: '工具完成',
  INPUT_REQUESTED: '等待你的回答', INPUT_CONSUMED: '已接收输入', ASSISTANT_MESSAGE: '已生成回复',
  ACCEPTED: '已受理', QUEUED: '排队中', ADMITTED: '已准入执行', NATIVE_SETTLED: '本轮已结束',
  NATIVE_FAILURE: '来源报告失败', STOP_APPLIED: '已停止', CHECKPOINT_REFRESHED: '检查点已保存',
};
const fmtClock = (iso?: string | null) => iso && Number.isFinite(Date.parse(iso)) ? new Date(iso).toTimeString().slice(0, 8) : '';
const fmtAgo = (ms: number) => ms >= 86400000 ? `${Math.floor(ms / 86400000)}天${Math.floor(ms % 86400000 / 3600000)}小时`
  : ms >= 3600000 ? `${Math.floor(ms / 3600000)}小时${Math.round(ms % 3600000 / 60000)}分`
  : ms >= 60000 ? `${Math.floor(ms / 60000)}分${Math.round(ms % 60000 / 1000)}秒`
  : `${Math.max(0, Math.floor(ms / 1000))}秒`;

function ActivityItems({items, running}: {items: NativeActivityRow[]; running: boolean}) {
  return <ol className="native-process-list">{items.map(item => {
    const dur = item.occurredAt && item.endedAt ? Date.parse(item.endedAt) - Date.parse(item.occurredAt) : null;
    const at = fmtClock(item.occurredAt);
    return <li key={item.id} data-state={item.state}>
      <div className="native-process-line">
        <span className="native-process-label">{item.detail
          ? <><span className="native-process-kind">{item.label}</span><span className="native-process-detail">{item.detail}</span></>
          : item.label}</span>
        <span className="native-process-meta">{dur !== null && dur >= 0 ? `+${Math.max(1, Math.round(dur / 1000))}s ` : ''}{at} · {item.state === 'running' && !running ? '结果未报告' : ACTIVITY_LABELS[item.state]}</span>
      </div>
      {item.result ? <details className="native-activity-result"><summary>查看结果</summary><pre>{item.result}</pre></details> : null}
    </li>;
  })}</ol>;
}

/** A task owns its view/controller lifetime, including when mounted outside App. */
export function NativeConversation({taskId, sendShortcut = 'ENTER'}: {taskId: string; sendShortcut?: 'ENTER' | 'MOD_ENTER'}) {
  return <NativeConversationView key={taskId} taskId={taskId} sendShortcut={sendShortcut} />;
}

function NativeConversationView({taskId, sendShortcut}: {taskId: string; sendShortcut: 'ENTER' | 'MOD_ENTER'}) {
  const conv = useNativeConversation(taskId);
  const draftKey = `desktop.personal.draft.${taskId}`;
  const [draft, setDraft] = useState(() => readStored<string>(draftKey) ?? '');
  const [draftError, setDraftError] = useState('');
  const [infoSection, setInfoSection] = useState<'status' | 'artifacts' | 'diagnostics' | null>(null);
  const [processOpen, setProcessOpen] = useState(true);
  const [readingHistory, setReadingHistory] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const proj = conv.projection;
  const native = conv.detail?.native;
  const engineLabel = ENGINE_LABELS[native?.engineId ?? ''] ?? native?.engineId ?? '来源待确认';
  const running = native?.quiescent !== true;
  const canSteer = running && native?.capabilities?.steer === true;
  const canFollowUp = !canSteer && native?.capabilities?.followUp === true;
  const canSend = (canSteer || canFollowUp) && !!native?.generation && !!native.nativeSessionId && !!native.currentCommandId
    && !conv.detail?.sourceError && !conv.readErrors['任务状态'];
  // Public input is bounded in UTF-8 bytes (16,384), not UTF-16 units.
  const draftBytes = new TextEncoder().encode(draft).length;
  const sendDisabled = conv.busy || !!conv.pendingInput || !canSend || !draft.trim() || draftBytes > 16384;
  const questions = pendingQuestions(conv.inputRequests);
  const status = nativeStatus(native);
  const legacyBlock = proj.legacyBlock && proj.legacyBlock !== 'EMPTY' ? proj.legacyBlock : undefined;
  const legacyEmpty = proj.legacyBlock === 'EMPTY';
  const accumulated = legacyBlock
    ? {text: legacyBlock.text, textTruncated: legacyBlock.textTruncated}
    : proj.accumulatedText ? {text: proj.accumulatedText, textTruncated: false} : undefined;
  const hasReadErrors = !!conv.detail?.sourceError || Object.keys(conv.readErrors).length > 0;
  // worker-events/1 live tail (§8.4): an ephemeral generating row pinned at
  // the transcript end. It is a visibility accelerator only — the row
  // clears as soon as the structured transcript owns the terminal message.
  // The SSE subscribe replays the full event window on every open — folded
  // deltas are history, not live generation. The tail may only render while
  // the task itself reports an unfinished state; a settled task's replayed
  // buckets are residue, never a "generating" row.
  const taskSettled = ['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(
    String(native?.state ?? ''),
  );
  // Live tasks get a 1 s ticker so the progress line can report elapsed,
  // deadline-remaining and seconds-since-last-event honestly.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (taskSettled) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [taskSettled]);
  const [stopArmedUntil, setStopArmedUntil] = useState(0);
  useEffect(() => {
    if (!stopArmedUntil) return;
    const timer = setTimeout(() => setStopArmedUntil(0), Math.max(1, stopArmedUntil - Date.now()));
    return () => clearTimeout(timer);
  }, [stopArmedUntil]);
  const stopArmed = Date.now() < stopArmedUntil;
  function requestStop() {
    if (conv.stopRequest) { void conv.reconcileStop(); return; }
    if (stopArmed) { setStopArmedUntil(0); void conv.stop(); return; }
    setStopArmedUntil(Date.now() + 5000);
  }
  // Per-turn grouping: tool activity carries the input's requestKey as
  // commandId, so each run renders under its own user turn instead of one
  // undifferentiated task-level block.
  const activityGroups = useMemo(() => {
    const groups = new Map<string, NativeActivityRow[]>();
    for (const item of conv.activity.items) {
      const key = item.commandId ?? item.segmentId ?? '';
      const list = groups.get(key) ?? [];
      list.push(item);
      groups.set(key, list);
    }
    return groups;
  }, [conv.activity]);
  const liveTail = taskSettled || !native?.state ? '' : nativeLiveTailText(conv.liveStream);
  // The interruption note claims "已收到内容保留" — only meaningful after
  // the stream actually delivered frames; a subscribe failure at PREPARING
  // must not raise a false transport alarm.
  const streamHadContent = conv.liveStream.lastCursor > 0
    || conv.liveStream.turns.size > 0 || conv.liveStream.thinking.size > 0;
  const streamNote = !taskSettled && streamHadContent && (conv.streamStatus === 'reconnecting' || conv.liveStream.interrupted)
    ? '实时输出中断，已收到内容保留，正在重连' : undefined;
  // Chat view: the task instruction is the first user message; settled
  // sends stay as durable user bubbles (pi never echoes them back), a
  // structured row carrying the same requestKey owns the merge instead.
  const sentRows: NativeMessageRow[] = conv.sentInputs
    .filter(sent => !proj.rows.some(row => row.role === 'user' && row.sourceRequestKey === sent.requestKey))
    .map(sent => ({id: `sent-${sent.requestKey}`, role: 'user' as const, text: sent.content, statusLabel: '已送达', commandId: sent.requestKey}));
  const instruction = conv.detail?.instruction?.trim();
  // input.consumed already echoes the instruction as a transcript user row on
  // both workers — the synthetic row is a fallback for sources that don't.
  const instructionEchoed = instruction
    ? proj.rows.some(row => row.role === 'user' && row.text === instruction)
    : false;
  const transcriptRows: NativeMessageRow[] = [
    ...(instruction && !instructionEchoed ? [{id: 'native-instruction', role: 'user' as const, text: instruction, statusLabel: '任务要求', commandId: conv.detail?.request?.requestKey}] : []),
    ...(accumulated ? [{id: 'legacy-output', role: 'assistant' as const, text: accumulated.text, textTruncated: accumulated.textTruncated}] : []),
    ...proj.rows,
    ...sentRows,
    ...(liveTail ? [{id: 'native-live-tail', role: 'assistant' as const, text: liveTail, statusLabel: streamNote ?? '生成中'}] : []),
  ];

  // Progress line model: what the model is doing RIGHT NOW, in one glance.
  const runningTool = [...conv.activity.items].reverse().find(i => i.state === 'running');
  const silentMs = native?.lastEventAt && Number.isFinite(Date.parse(native.lastEventAt)) ? Math.max(0, now - Date.parse(native.lastEventAt)) : undefined;
  const deadlineRemainMs = native?.deadlineEpochMillis ? Number(native.deadlineEpochMillis) - now : undefined;
  const phase = taskSettled
    ? (native?.reasonCode === 'TASK_DEADLINE_EXCEEDED' ? '到执行时限自动停止' : status.label)
    : questions.length ? '等待你的回答'
    : native?.launchState === 'QUEUED' ? `排队中${native.queue?.position ? ` · 第 ${native.queue.position} 位` : ''}${native.queue?.activeTasks != null && native.queue?.maxActiveTasks != null ? ` · 槽位 ${native.queue.activeTasks}/${native.queue.maxActiveTasks}` : ''}`
    : native?.launchState === 'PREPARING' || native?.state === 'PREPARING' ? '准备中'
    : native?.launchState === 'RESTORING' ? '恢复中'
    : runningTool ? `${runningTool.label}${runningTool.detail ? ` · ${runningTool.detail.slice(0, 80)}` : ''}`
    : liveTail || native?.lastEventKind === 'OUTPUT_DELTA' ? '生成中'
    : native?.lastEventKind === 'THINKING_DELTA' ? '思考中'
    : native?.lastEventKind ? (EVENT_LABELS[native.lastEventKind] ?? status.label)
    : status.label;
  const lastEventText = native?.lastEventKind ? `${EVENT_LABELS[native.lastEventKind] ?? native.lastEventKind} ${fmtClock(native.lastEventAt)}`.trim() : '';
  const claimedKeys = new Set(transcriptRows.filter(r => r.commandId).map(r => r.commandId as string));
  const orphanGroups = [...activityGroups.entries()].filter(([key]) => !key || !claimedKeys.has(key));
  // Turn-activity blocks: the turn that owns the latest input stays expanded
  // so live tool steps are visible; older turns collapse but remember a
  // manual toggle either way.
  const latestTurnKey = transcriptRows.map(r => r.commandId).filter((k): k is string => !!k).at(-1);
  const turnToggle = useRef(new Map<string, boolean>());

  useLayoutEffect(() => {
    if (pinned.current && scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [proj.rows, conv.activity, conv.artifacts, liveTail]);

  function updateDraft(value: string) {
    setDraft(value);
    try { writeStored(draftKey, value); setDraftError(''); }
    catch { setDraftError('草稿未能保存到本机，请保留当前页面。'); }
  }
  async function submit() {
    if (sendDisabled) return;
    const sent = draft;
    const persisted = await conv.sendMessage(sent.trim());
    if (persisted) setDraft(current => {
      if (current !== sent) return current;
      try { writeStored(draftKey, ''); } catch { /* Pending request is already durable. */ }
      return '';
    });
  }
  function jumpToNewer() {
    pinned.current = true;
    setReadingHistory(false);
    void conv.loadNewer().finally(() => {
      if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    });
  }
  function jumpToBottom() {
    pinned.current = true;
    setReadingHistory(false);
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }
  const renderMessage = (row: NativeMessageRow) => {
    const turnActivity = row.commandId ? activityGroups.get(row.commandId) : undefined;
    return <div className="message-turn" key={row.id} data-testid={row.id === 'legacy-output' ? 'native-accumulated-output' : undefined}>
      {row.id === 'legacy-output' ? <span className="native-history-note">累计公开输出 · 来源未提供这部分逐条历史{row.textTruncated ? ' · 正文已截断' : ''}</span> : null}
      <ConversationMessage role={row.role} text={row.text} pending={row.pending} testId={`native-message-${row.id}`}
        status={<>{row.pending ? `本端发送 · ${row.receipt ?? '待核对'}` : (row.statusLabel ?? row.receipt)}{row.textTruncated && row.id !== 'legacy-output' ? ' · 正文已截断' : ''}{row.mergedLocalRequest ? ' · 已对齐来源行' : ''}</>} />
      {row.diagnostics && row.diagnostics.length > 0
        ? <details className="native-message-diagnostics"><summary>来源定位</summary>
            <dl>{row.diagnostics.map((entry) => <div key={entry.label}><dt>{entry.label}</dt><dd>{entry.value}</dd></div>)}</dl>
          </details>
        : null}
      {turnActivity?.length ? (() => {
        const turnKey = row.commandId as string;
        const open = turnToggle.current.get(turnKey) ?? turnKey === latestTurnKey;
        return <details className="native-activity native-turn-activity" data-testid="native-turn-activity" open={open}
          onToggle={e => turnToggle.current.set(turnKey, e.currentTarget.open)}>
          <summary>本轮执行过程 · {turnActivity.length} 项{turnActivity.at(-1)?.state === 'running' ? ` · ${turnActivity.at(-1)!.label}` : ''}</summary>
          <ActivityItems items={turnActivity} running={running} />
        </details>;
      })() : null}
    </div>;
  };

  return <section className="conversation native-conversation" data-testid="native-conversation" aria-label="原生任务对话">
    <ConversationHeaderFrame title={conv.detail?.displayName ?? '原生任务'} status={status} statusTestId="native-task-state"
      meta={<span className="native-engine" data-testid="native-task-engine">{engineLabel}</span>}>
      {!taskSettled && native?.capabilities?.stop
        ? <HeaderAction label={stopArmed ? '确认停止？' : '停止'} icon="stop" testId="native-stop"
            disabled={conv.busy || (!conv.stopRequest && (!native?.generation || !native?.currentCommandId))}
            onClick={requestStop} />
        : null}
      <HeaderAction label="状态" icon="play" dotTone={status.tone} onClick={() => setInfoSection('status')} />
      <HeaderAction label="成果" icon="file" disabled={conv.artifacts === undefined} onClick={() => setInfoSection('artifacts')} />
      <HeaderAction label="诊断" icon="settings" onClick={() => setInfoSection('diagnostics')} />
    </ConversationHeaderFrame>
    {hasReadErrors ? <div className="native-observation" role="status">
      <span>观察中断，保留上次事实 · {[...(conv.detail?.sourceError ? ['来源连接'] : []), ...Object.keys(conv.readErrors)].join('、')}暂不可读</span><button type="button" onClick={() => void conv.refresh()}>重新读取</button>
    </div> : null}
    {native?.state === 'UNKNOWN' ? <div className="native-observation" role="status" data-testid="native-unknown-notice">
      <span>任务状态未知（宿主可能重启过），无法安全续跑；建议新建任务继续，本任务可保留查看历史。</span>
    </div> : null}
    <div className="conversation-scroll" ref={scrollRef} data-testid="native-conversation-body" onScroll={event => {
      const el = event.currentTarget; pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; setReadingHistory(!pinned.current);
    }}>
      <div className="messages" data-testid="native-message-list">
        {proj.structured && proj.paging && proj.hasMoreHistory
          ? <button type="button" className="native-load-earlier" data-testid="native-load-earlier" disabled={conv.pagingBusy} onClick={() => void conv.loadEarlier()}>加载较早内容</button>
          : null}
        {proj.structured && !proj.paging
          ? <p className="native-history-note" data-testid="native-paging-note">此连接未提供消息分页，仅显示来源返回的有界快照；更早历史可能未包含在内。</p>
          : null}
        {!proj.structured && conv.messagesView
          ? <p className="native-history-note" data-testid="native-legacy-note">此来源不提供逐条消息核对与分页，显示为来源返回的有界快照。</p>
          : null}
        {legacyEmpty
          ? <p className="native-history-note" data-testid="native-legacy-empty">此任务在逐条对话边界之前没有可展示的累计公开输出{proj.coverage ? `；覆盖范围：${proj.coverage}` : ''}。</p>
          : null}
        <VirtualMessageWindow messages={transcriptRows} containerRef={scrollRef} renderRow={renderMessage} />
        {nativeThinkingBlocks(conv.liveStream).map(bucket => (
          <details key={`thinking-${bucket.nativeTurnId}`} className="round-thinking is-standalone native-thinking" open={!taskSettled || undefined}>
            <summary className="round-thinking-summary">
              <span className="round-thinking-glyph">◌</span>
              <span className="round-thinking-label">思考</span>
            </summary>
            <div className="round-thinking-text" data-testid={`native-thinking-${bucket.nativeTurnId}`}>{bucket.text}{bucket.truncated ? ' …（思考已截断）' : ''}</div>
          </details>
        ))}
        {(() => {
          const items = orphanGroups.flatMap(([, rows]) => rows);
          if (!items.length && !conv.activity.catchingUp) return null;
          const failed = items.filter(i => i.state === 'failed' || i.state === 'rejected').length;
          const kinds = [...items.reduce((m, i) => m.set(i.label, (m.get(i.label) ?? 0) + 1), new Map<string, number>())]
            .sort((a, b) => b[1] - a[1]).slice(0, 4).map(([label, n]) => `${label} ${n}`).join(' · ');
          const times = items.map(i => [i.occurredAt, i.endedAt]).flat().filter((v): v is string => !!v).map(v => Date.parse(v)).filter(Number.isFinite);
          const spanMs = times.length >= 2 ? Math.max(...times) - Math.min(...times) : 0;
          const span = spanMs >= 1000 ? `${String(Math.floor(spanMs / 60000)).padStart(2, '0')}:${String(Math.round(spanMs % 60000 / 1000)).padStart(2, '0')}` : '';
          return (
            <div className="run-process-fold native-process" data-testid="native-process">
              <button className="run-process-summary" type="button" aria-expanded={processOpen} onClick={() => setProcessOpen(open => !open)}>
                <span className="run-process-caret">▸</span>
                <span className="run-process-label">执行过程</span>
                <span className="run-process-fact">· {items.length} 项操作</span>
                {failed ? <span className="run-process-fact is-failed">· {failed} 项失败</span> : null}
                {span ? <span className="run-process-fact">· {span}</span> : null}
                <span className="run-process-spacer" />
                {kinds ? <span className="run-process-kinds">{kinds}</span> : null}
                {conv.activity.catchingUp ? <span className="run-process-badge">正在同步</span> : null}
                {conv.activity.trimmed || conv.activity.expired ? <span className="run-process-badge">记录不完整</span> : null}
              </button>
              {processOpen ? <ActivityItems items={items} running={running} /> : null}
            </div>
          );
        })()}
        {!liveTail && streamNote ? <p className="native-history-note" data-testid="native-stream-note">{streamNote}</p> : null}
        {transcriptRows.length === 0 && !legacyEmpty ? <div className="message-empty" data-testid="native-messages-empty"><Icon name="chat" size={24} /><p>等待来源发布公开消息</p><span>任务状态、待处理问题和执行活动会分别更新。</span></div> : null}
      </div>
    </div>
    {infoSection ? <div className="modal-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) setInfoSection(null); }}>
      <section className="file-reference-pane native-info-dialog" role="dialog" aria-modal="true" aria-label="任务详情">
        <header className="modal-header">
          <div>
            <span className="eyebrow">原生任务</span>
            <h2>任务详情</h2>
            <p>执行过程、成果与诊断都在这里；对话区只保留消息。</p>
          </div>
          <button type="button" className="icon-button" aria-label="关闭任务详情" onClick={() => setInfoSection(null)}><Icon name="x" size={17} /></button>
        </header>
        <div className="native-info-body">
          <section className="native-status-summary" aria-label="任务摘要" data-testid="native-status-summary">
            <dl>
              <div><dt>当前状态</dt><dd>{status.label}{native?.launchState ? ` · ${native.launchState}` : ''}</dd></div>
              {native?.queue ? <div><dt>排队</dt><dd>第 {native.queue.position ?? '—'} 位 · 执行 {native.queue.activeTasks ?? '—'}/{native.queue.maxActiveTasks ?? '—'}</dd></div> : null}
              {native?.createdAt ? <div><dt>已运行</dt><dd>{fmtAgo((native.endedAt ? Date.parse(native.endedAt) : now) - Date.parse(native.createdAt))}</dd></div> : null}
              {lastEventText ? <div><dt>最近事件</dt><dd>{lastEventText}</dd></div> : null}
              {!taskSettled && silentMs !== undefined ? <div><dt>距上次事件</dt><dd>{fmtAgo(silentMs)}</dd></div> : null}
              {!taskSettled && native?.launchState === 'QUEUED'
                ? (native?.deadlineMs ? <div><dt>执行时限</dt><dd>{fmtAgo(native.deadlineMs)} · 开跑起算</dd></div> : null)
                : !taskSettled && deadlineRemainMs !== undefined ? <div><dt>剩余时限</dt><dd>{deadlineRemainMs > 0 ? fmtAgo(deadlineRemainMs) : '已到时'}</dd></div> : null}
              {native?.reasonCode ? <div><dt>原因</dt><dd>{native.reasonCode === 'TASK_DEADLINE_EXCEEDED' ? '到执行时限自动停止' : native.reasonCode}</dd></div> : null}
              {native?.usage ? <div><dt>Token 用量</dt><dd>输入 {native.usage.input ?? 0} · 输出 {native.usage.output ?? 0}{native.usage.cacheRead ? ` · 缓存读 ${native.usage.cacheRead}` : ''}</dd></div> : null}
            </dl>
          </section>
          {conv.pendingInput ? <div className="native-receipt" role="status" data-testid="native-input-pending">
            <span>{nativeReceiptLabel(String(conv.inputReceipt?.source?.state ?? conv.inputReceipt?.state ?? 'UNKNOWN'))}</span>
            <button type="button" disabled={conv.busy} onClick={() => void conv.reconcileInput()}>核对发送结果</button>
            {nativeReceiptSettled(conv.inputReceipt) ? <button type="button" onClick={conv.acknowledgeInput}>保留回执并继续</button> : null}
          </div> : null}
          <div className="native-conversation-controls">
            {native?.capabilities?.stop || conv.stopRequest ? <button type="button" data-armed={stopArmed || undefined} disabled={conv.busy || (!conv.stopRequest && (!native?.generation || !native?.currentCommandId))} onClick={requestStop}>{conv.stopRequest ? '查看停止状态' : stopArmed ? '再点一次确认停止' : '停止原生任务'}</button> : null}
            {native?.capabilities?.pause ? <button type="button" disabled={conv.busy || !!conv.pendingInput} onClick={() => void conv.control('PAUSE')}>请求边界暂停</button> : null}
            {native?.capabilities?.resume ? <button type="button" disabled={conv.busy || !!conv.pendingInput} onClick={() => void conv.control('RESUME')}>按来源方式继续</button> : null}
            {conv.stopReceipt ? <span role="status" data-testid="native-stop-receipt">停止请求 · {nativeReceiptLabel(String(conv.stopReceipt.source?.state ?? conv.stopReceipt.state))}</span> : null}
            {nativeReceiptSettled(conv.stopReceipt) ? <button type="button" onClick={conv.acknowledgeStop}>保留回执并继续</button> : null}
          </div>
          <details className="native-activity" open={infoSection === 'status' || undefined}>
            <summary>执行过程 <span>{conv.activity.items.length} 项工具活动{conv.activity.catchingUp ? ' · 正在同步后续记录' : ''}</span></summary>
            {conv.activity.items.length ? <ActivityItems items={conv.activity.items} running={running} /> : <p className="native-history-note">{taskSettled ? '任务已结束，未读取到工具级公开活动。' : '尚无已读取的公开工具活动。'}</p>}
            <p className="native-history-note">按来源公开事件显示；工具完成不代表任务或测试通过。</p>
            {conv.activity.trimmed || conv.activity.expired ? <p className="native-history-note">仅展示当前保留的活动窗口，历史不完整。</p> : null}
          </details>
          {conv.artifacts ? <section className="native-artifacts" aria-label="成果">
            <h3>成果</h3>
            {conv.artifacts.items.length === 0 ? <p className="native-history-note">来源暂未提供可读取的成果；详细原因见诊断。</p> : null}
            {conv.artifacts.items.map(item => <div className="native-artifact" key={item.artifactId}>
              <div><strong>{item.path}</strong><span>{item.status === 'AVAILABLE' ? '可读取' : '暂不可读取'}</span></div>
              <div className="native-artifact-actions">
                <button type="button" disabled={conv.busy || item.status !== 'AVAILABLE'} onClick={() => void conv.verify(item)}>核验成果</button>
                <button type="button" disabled={conv.busy || item.status !== 'AVAILABLE' || !item.sha256} onClick={() => void conv.save(item)}>保存成果</button>
              </div>
              {conv.verified[item.artifactId] ? <details><summary>已核验摘要</summary><code data-testid="verified-artifact">{conv.verified[item.artifactId]}</code></details> : null}
            </div>)}
            <p className="native-history-note">此处展示来源成果文件，尚无结构化变更审阅。</p>
          </section> : null}
          <details className="native-diagnostics" open={infoSection === 'diagnostics' || undefined}><summary>任务诊断</summary>
            <p>任务：{taskId} · 存储：{conv.detail?.sourceStoreId ?? '未知'} · 原生会话：{native?.nativeSessionId ?? '尚未报告'}</p>
            <p data-testid="native-messages-facts">消息：{proj.structured ? '逐条 native-messages/1' : '旧快照格式'} · 分页：{proj.paging ? '支持' : '未提供'} · 模式：{proj.historyMode ?? '—'} · 覆盖：{proj.coverage ?? '未知'}</p>
            {native && ['codex', 'codep'].includes(native.engineId) ? <p>此来源未提供严格暂停；下一轮操作以来源能力为准。</p> : null}
            <pre data-testid="native-facts">{JSON.stringify({detail: conv.detail, readErrors: conv.readErrors, activity: conv.activity, output: conv.output, artifacts: conv.artifacts, inputReceipt: conv.inputReceipt, stopReceipt: conv.stopReceipt, transcriptRevision: conv.transcript.transcriptRevision}, null, 2)}</pre>
          </details>
        </div>
        <div className="modal-footer">
          <button type="button" className="secondary-button" onClick={() => setInfoSection(null)}>关闭</button>
        </div>
      </section>
    </div> : null}
    <div className="composer-area native-composer-area">
      {readingHistory || proj.hasNewer ? <button className="native-jump" type="button" data-testid="native-newer-notice" onClick={proj.hasNewer && proj.paging ? jumpToNewer : jumpToBottom}>{proj.hasNewer ? '有新消息，查看最新' : '回到最新内容'}</button> : null}
      <div className="native-question-dock">{questions.map(q => <NativeQuestion key={q.inputRequestId} question={q} disabled={conv.busy || !!conv.pendingInput} answer={r => void conv.respondInput(q, r)} />)}</div>
      <div className="native-progress-line" data-testid="native-progress" role="status">
        {taskSettled
          ? <span>{status.label}{native?.reasonCode === 'TASK_DEADLINE_EXCEEDED' ? ' · 到执行时限自动停止' : ''}{native?.endedAt ? ` · ${fmtClock(native.endedAt)}` : ''}</span>
          : native?.state === 'UNKNOWN'
            ? <span>状态未知 · 宿主可能重启过 · 无法安全续跑</span>
            : <>
                <span className="native-progress-phase">{phase}</span>
                {lastEventText ? <span className="native-progress-fact">最近事件 · {lastEventText}</span> : null}
                {silentMs !== undefined && silentMs > 15000 && native?.launchState !== 'QUEUED' ? <span className="native-progress-stall" data-testid="native-progress-stall">无响应 {fmtAgo(silentMs)}</span> : null}
                {conv.streamStatus === 'reconnecting' ? <span className="native-progress-fact">实时流重连中</span> : null}
                {native?.launchState === 'QUEUED'
                  ? (native?.deadlineMs ? <span className="native-progress-fact">时限 {fmtAgo(native.deadlineMs)} · 开跑起算</span> : null)
                  : deadlineRemainMs !== undefined ? <span className="native-progress-fact" data-tone={deadlineRemainMs < 120000 ? 'warn' : undefined}>时限剩余 {deadlineRemainMs > 0 ? fmtAgo(deadlineRemainMs) : '0秒'}</span> : null}
                {native?.createdAt ? <span className="native-progress-fact">已运行 {fmtAgo(now - Date.parse(native.createdAt))}</span> : null}
              </>}
      </div>
      <form className="composer" onSubmit={event => { event.preventDefault(); void submit(); }}>
        <div className="composer-main"><textarea aria-label="输入消息" data-testid="native-composer" value={draft}
          placeholder={canSteer ? '补充当前任务…' : canFollowUp ? '下一轮继续…' : taskSettled ? '任务已结束，草稿保留；新指令请新建原生任务' : '可以先写草稿，等待来源可接收输入'}
          onChange={e => updateDraft(e.target.value)} onKeyDown={e => { const mod = e.ctrlKey || e.metaKey; const submitKey = sendShortcut === 'MOD_ENTER' ? (e.key === 'Enter' && mod) : (e.key === 'Enter' && !e.shiftKey); if (submitKey && !e.nativeEvent.isComposing) { e.preventDefault(); e.currentTarget.form?.requestSubmit(); } }} /></div>
        <div className="composer-footer"><div className="composer-footer-left"><span className="composer-chip" data-testid="native-task-model">{native?.executionOptions?.model ?? native?.configuredModel ?? '来源未报告模型'}</span></div>
          <div className="composer-footer-right"><button type="submit" className="composer-action" title={draftBytes > 16384 ? '输入超过 16384 字节上限' : canSteer ? '补充当前任务' : '下一轮继续'} aria-label={canSteer ? '补充当前任务' : '发送'} disabled={sendDisabled}><Icon name="send" size={15} /></button></div>
        </div>
      </form>
      {conv.error || draftError || conv.detail?.submissionError || draftBytes > 16384 ? <p role="alert" data-testid="native-error" className="native-error">{draftBytes > 16384 ? '输入超过 16384 字节上限' : conv.error || draftError || conv.detail?.submissionError?.message}</p> : null}
    </div>
  </section>;
}
