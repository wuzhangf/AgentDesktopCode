import {useLayoutEffect, useRef, useState} from 'react';
import {ConversationMessage} from '../app/conversation/ConversationMessage';
import {ConversationHeaderFrame, HeaderAction} from '../app/conversation/ConversationHeader';
import {VirtualMessageWindow} from '../app/conversation/VirtualMessageWindow';
import {Icon} from '../app/Icon';
import {useNativeConversation} from './useNativeConversation';
import {nativeReceiptLabel, nativeReceiptSettled, nativeStatus, pendingQuestions, type NativeMessageRow} from './nativeConversationModel';
import {nativeLiveTailText, nativeThinkingBlocks} from '../app/activity/nativeVisibleTextProjection';
import {readStored, writeStored} from './personalGateway';
import {NativeQuestion} from './NativeQuestion';

const ENGINE_LABELS: Record<string, string> = {pi: 'Pi', codex: 'Codex', macos: 'Mac', codep: 'Codep'};
const ACTIVITY_LABELS = {running: '执行中', completed: '已完成', failed: '失败', rejected: '已拒绝', unknown: '结果未报告'};

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
    .map(sent => ({id: `sent-${sent.requestKey}`, role: 'user' as const, text: sent.content, statusLabel: '已送达'}));
  const instruction = conv.detail?.instruction?.trim();
  // input.consumed already echoes the instruction as a transcript user row on
  // both workers — the synthetic row is a fallback for sources that don't.
  const instructionEchoed = instruction
    ? proj.rows.some(row => row.role === 'user' && row.text === instruction)
    : false;
  const transcriptRows: NativeMessageRow[] = [
    ...(instruction && !instructionEchoed ? [{id: 'native-instruction', role: 'user' as const, text: instruction, statusLabel: '任务要求'}] : []),
    ...(accumulated ? [{id: 'legacy-output', role: 'assistant' as const, text: accumulated.text, textTruncated: accumulated.textTruncated}] : []),
    ...proj.rows,
    ...sentRows,
    ...(liveTail ? [{id: 'native-live-tail', role: 'assistant' as const, text: liveTail, statusLabel: streamNote ?? '生成中'}] : []),
  ];

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
  const renderMessage = (row: NativeMessageRow) => <div className="message-turn" key={row.id} data-testid={row.id === 'legacy-output' ? 'native-accumulated-output' : undefined}>
    {row.id === 'legacy-output' ? <span className="native-history-note">累计公开输出 · 来源未提供这部分逐条历史{row.textTruncated ? ' · 来源已标记截断' : ''}</span> : null}
    <ConversationMessage role={row.role} text={row.text} pending={row.pending} testId={`native-message-${row.id}`}
      status={<>{row.pending ? `本端发送 · ${row.receipt ?? '待核对'}` : (row.statusLabel ?? row.receipt)}{row.textTruncated && row.id !== 'legacy-output' ? ' · 正文已截断' : ''}{row.mergedLocalRequest ? ' · 已对齐来源行' : ''}</>} />
    {row.diagnostics && row.diagnostics.length > 0
      ? <details className="native-message-diagnostics"><summary>来源定位</summary>
          <dl>{row.diagnostics.map((entry) => <div key={entry.label}><dt>{entry.label}</dt><dd>{entry.value}</dd></div>)}</dl>
        </details>
      : null}
  </div>;

  return <section className="conversation native-conversation" data-testid="native-conversation" aria-label="原生任务对话">
    <ConversationHeaderFrame title={conv.detail?.displayName ?? '原生任务'} status={status} statusTestId="native-task-state"
      meta={<span className="native-engine" data-testid="native-task-engine">{engineLabel}</span>}>
      {!taskSettled && native?.capabilities?.stop
        ? <HeaderAction label="停止" icon="stop" testId="native-stop"
            disabled={conv.busy || (!conv.stopRequest && (!native?.generation || !native?.currentCommandId))}
            onClick={() => void (conv.stopRequest ? conv.reconcileStop() : conv.stop())} />
        : null}
      <HeaderAction label="状态" icon="play" dotTone={status.tone} onClick={() => setInfoSection('status')} />
      <HeaderAction label="成果" icon="file" disabled={conv.artifacts === undefined} onClick={() => setInfoSection('artifacts')} />
      <HeaderAction label="诊断" icon="settings" onClick={() => setInfoSection('diagnostics')} />
    </ConversationHeaderFrame>
    {hasReadErrors ? <div className="native-observation" role="status">
      <span>观察中断，保留上次事实 · {[...(conv.detail?.sourceError ? ['来源连接'] : []), ...Object.keys(conv.readErrors)].join('、')}暂不可读</span><button type="button" onClick={() => void conv.refresh()}>重新读取</button>
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
          const items = conv.activity.items;
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
              {processOpen ? <ol className="native-process-list">{items.map(item => {
                const dur = item.occurredAt && item.endedAt ? Date.parse(item.endedAt) - Date.parse(item.occurredAt) : null;
                const at = item.occurredAt && Number.isFinite(Date.parse(item.occurredAt)) ? new Date(item.occurredAt).toTimeString().slice(0, 8) : '';
                return <li key={item.id} data-state={item.state}>
                  <span className="native-process-label">{item.label}{item.detail ? <span className="native-process-detail"> · {item.detail}</span> : null}</span>
                  <span className="native-process-meta">{dur !== null && dur >= 0 ? `+${Math.max(1, Math.round(dur / 1000))}s ` : ''}{at} · {ACTIVITY_LABELS[item.state]}</span>
                </li>;
              })}</ol> : null}
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
          {conv.pendingInput ? <div className="native-receipt" role="status" data-testid="native-input-pending">
            <span>{nativeReceiptLabel(String(conv.inputReceipt?.source?.state ?? conv.inputReceipt?.state ?? 'UNKNOWN'))}</span>
            <button type="button" disabled={conv.busy} onClick={() => void conv.reconcileInput()}>核对发送结果</button>
            {nativeReceiptSettled(conv.inputReceipt) ? <button type="button" onClick={conv.acknowledgeInput}>保留回执并继续</button> : null}
          </div> : null}
          <div className="native-conversation-controls">
            {native?.capabilities?.stop || conv.stopRequest ? <button type="button" disabled={conv.busy || (!conv.stopRequest && (!native?.generation || !native?.currentCommandId))} onClick={() => void (conv.stopRequest ? conv.reconcileStop() : conv.stop())}>{conv.stopRequest ? '查看停止状态' : '停止原生任务'}</button> : null}
            {native?.capabilities?.pause ? <button type="button" disabled={conv.busy || !!conv.pendingInput} onClick={() => void conv.control('PAUSE')}>请求边界暂停</button> : null}
            {native?.capabilities?.resume ? <button type="button" disabled={conv.busy || !!conv.pendingInput} onClick={() => void conv.control('RESUME')}>按来源方式继续</button> : null}
            {conv.stopReceipt ? <span role="status" data-testid="native-stop-receipt">停止请求 · {nativeReceiptLabel(String(conv.stopReceipt.source?.state ?? conv.stopReceipt.state))}</span> : null}
            {nativeReceiptSettled(conv.stopReceipt) ? <button type="button" onClick={conv.acknowledgeStop}>保留回执并继续</button> : null}
          </div>
          <details className="native-activity" open={infoSection === 'status' || undefined}>
            <summary>执行过程 <span>{conv.activity.items.length} 项工具活动{conv.activity.catchingUp ? ' · 正在同步后续记录' : ''}</span></summary>
            {conv.activity.items.length ? <ol className="native-activity-list">{conv.activity.items.map(item => <li key={item.id} data-state={item.state}>
              <span>{item.label}</span><span>{item.state === 'running' && !running ? '结果未报告' : ACTIVITY_LABELS[item.state]}</span>
            </li>)}</ol> : <p className="native-history-note">{taskSettled ? '任务已结束，未读取到工具级公开活动。' : '尚无已读取的公开工具活动。'}</p>}
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
