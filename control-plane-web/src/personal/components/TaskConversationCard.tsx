import {TaskEngagementPanel} from './TaskEngagementPanel';
import { useState } from 'react';
import { Card, ErrorBanner } from '../../components/ui/primitives';
import { usePersonal, usePersonalGateway, usePersonalInvalidate, usePersonalSurface } from '../hooks';
import type { PersonalTaskDetail, PersonalTaskInteractionView } from '../../../../codeagent-desktop/packages/protocol/src/personal-task';

export function TaskConversationCard({taskId, detail, selectedRun, onSelectRun}: {
  taskId: string; detail?: PersonalTaskDetail; selectedRun?: string; onSelectRun: (runId?: string) => void;
}) {
  const gateway = usePersonalGateway(), surface = usePersonalSurface(), invalidate = usePersonalInvalidate();
  const [mode,setMode] = useState<'MESSAGE'|'BOUNDARY'|'SIDE_QUESTION'>('MESSAGE');
  const [sourceRefs,setSourceRefs] = useState<string[]>([]);
  const [engagementKey,setEngagementKey] = useState<string>();
  const [researchCount,setResearchCount] = useState(0);
  const [textOnlyResearch,setTextOnlyResearch] = useState(false);
  const [cursor, setCursor] = useState<string>();
  const history = usePersonal(['taskMessages', taskId, cursor], g => g.taskMessages(taskId, cursor), {
    enabled: surface.kind !== 'demo' && !!detail?.sessionId, refetchInterval: 5000,
  });
  const plane = history.data?.meta.controlPlaneId;
  const storageKey = `pae.personal.interaction.${plane}.${taskId}`;
  const [draft, setDraft] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [pending, setPending] = useState<PersonalTaskInteractionView>();
  let marker: string | null = null;
  try {if (plane) marker = localStorage.getItem(storageKey);} catch { /* unavailable storage */ }
  let engagementMarker:string|null=null;
  try {if(plane)engagementMarker=localStorage.getItem(storageKey+'.engagement');}catch{/* unavailable */}
  const trackedEngagement=engagementKey??engagementMarker??undefined;
  const interaction=usePersonal(['taskInteractions',taskId,detail?.runId],g=>g.taskInteractions(taskId,detail?.runId),{enabled:!!detail?.sessionId&&surface.kind!=='demo',refetchInterval:5000});
  const engagement=usePersonal(['taskEngagement',taskId,trackedEngagement],g=>g.taskEngagement(taskId,trackedEngagement!),{enabled:!!trackedEngagement,refetchInterval:3000});
  const capabilities=(interaction.data?.data.foundation as {capabilities?:Record<string,string>})?.capabilities;
  const epoch=(interaction.data?.data.segments as {current?:{executionEpoch?:string}})?.current?.executionEpoch;
  const track=(value?:string)=>{setEngagementKey(value);try{if(value)localStorage.setItem(storageKey+'.engagement',value);else localStorage.removeItem(storageKey+'.engagement');}catch{/* server ledger remains authoritative */}};
  const engagementFrozen=!!trackedEngagement&&!engagement.data?.data.result&&!engagement.data?.data.sourceRejection;
  const [pendingKey, setPendingKey] = useState<string>();
  const key = pendingKey ?? marker;
  const request = usePersonal(['taskInteraction', taskId, key], g => g.taskInteractionRequest(taskId, key!), {
    enabled: !!key, refetchInterval: 5000,
  });
  const view = request.data?.data ?? pending;
  const frozen = !!key && !view?.acceptance && !view?.sourceRejection && view?.receipt?.status !== 'NOT_APPLIED';
  const remember = (value?: string) => {
    setPendingKey(value);
    try {if (value) localStorage.setItem(storageKey, value); else localStorage.removeItem(storageKey);} catch {setError('无法保存恢复标记，请在关闭页面前核对原请求');}
  };
  const submit = async (replay = false) => {
    if (busy || surface.readonly || !detail?.session || (replay && !view)) return;
    if(!replay && mode!=='MESSAGE') {
      if(!detail.runId || mode==='BOUNDARY'&&!epoch)return;
      const requestKey=`web-interact-${crypto.randomUUID()}`;
      const body:import('../../../../codeagent-desktop/packages/protocol/src/personal-interaction').TaskEngagementRequest = mode==='BOUNDARY'
        ? {kind:'BOUNDARY',requestKey,targetRunId:detail.runId,source:{schemaVersion:'run-boundary-request/1',requestId:requestKey,kind:'CONTEXT_ADVICE',expectedExecutionEpoch:epoch!,text:draft,sourceRefs}}
        : {kind:'SIDE_QUESTION',requestKey,targetRunId:detail.runId,question:draft,researchCount,textOnlyResearch};
      track(requestKey);setBusy(true);setError('');
      try{await gateway.createTaskEngagement(taskId,body);await invalidate();}catch(e){setError((e as Error).message);}finally{setBusy(false);}return;
    }
    setBusy(true); setError('');
    const body = replay ? view!.request : {requestKey: `web-message-${crypto.randomUUID()}`, clientMessageId: crypto.randomUUID(), content: draft, expectedSessionVersion: detail.session.sessionVersion};
    remember(body.requestKey);
    try {
      const result = await gateway.sendTaskMessage(taskId, body);
      setPending(result.data);
      if (result.data.acceptance) setDraft('');
      await invalidate();
    } catch(e) {setError((e as Error).message);} finally {setBusy(false);}
  };
  if (surface.kind === 'demo') return null;
  const items = history.data?.data.items ?? [];
  const intentUnavailable=mode==='BOUNDARY' ? (!epoch||detail?.runId!==detail?.conversation?.activeRunId||capabilities?.['boundary.contextAdvice']!=='READY'?'当前源端未开放执行中建议':'') : mode==='SIDE_QUESTION' ? (capabilities?.['auxiliary.question']!=='READY'?'当前源端旁支问答未就绪':researchCount>0&&draft.length>1200?'只读研究者的问题最多 1200 字符，请编辑后提交':'') : '';
  const report=async()=>{if(!detail?.runId||!epoch)return;const requestKey=`web-interact-${crypto.randomUUID()}`;track(requestKey);setBusy(true);setError('');try{await gateway.createTaskEngagement(taskId,{kind:'BOUNDARY',requestKey,targetRunId:detail.runId,source:{schemaVersion:'run-boundary-request/1',requestId:requestKey,kind:'REQUEST_REPORT',expectedExecutionEpoch:epoch,text:'请在下个安全边界汇报已完成事项、阻塞和下一步，然后继续原任务。',sourceRefs:[]}});await invalidate();}catch(e){setError((e as Error).message);}finally{setBusy(false);}};
  const runs = [...new Set([detail?.conversation?.initialRunId, detail?.conversation?.activeRunId, detail?.runId, ...items.map(m => m.runId)].filter((id): id is string => !!id))];
  return <Card title="会话与后续输入" sub="同一会话继续对话；执行中普通消息由源端排队，已受理不代表已消费">
    <label>查看运行 <select aria-label="查看运行" value={selectedRun ?? ''} onChange={e => onSelectRun(e.target.value || undefined)}>
      <option value="">跟随当前运行／最近消息</option>
      {runs.map(id => <option key={id} value={id}>{id}{id === detail?.conversation?.activeRunId ? '（当前）' : '（历史）'}</option>)}
    </select></label>
    <p>当前查看：{detail?.runId ?? '等待分配'}；选择依据：{detail?.conversation?.selectionReason ?? '尚未确认'}</p>
    {history.isError && <ErrorBanner error={history.error} onRetry={() => history.refetch()} />}
    <div aria-label="会话历史">{items.map(m => <article key={m.id} style={{marginBlock:12}}>
      <strong>{m.role}</strong> · {m.status} · {m.runId ?? '尚未分配运行'}
      <p style={{whiteSpace:'pre-wrap', overflowWrap:'anywhere'}}>{m.content ?? m.contentPreview ?? '内容尚未加载'}</p>
      {m.contentState === 'DEFERRED' && <small>当前展示内容预览</small>}
    </article>)}</div>
    {history.data?.data.hasOlder && <button onClick={() => setCursor(history.data?.data.beforeCursor ?? undefined)}>更早消息</button>}
    {cursor && <button onClick={() => setCursor(undefined)}>回到最新消息</button>}
    {((interaction.data?.data.messageRequests??[]) as {requestKey:string;createdAt:string}[]).map(r=><button key={r.requestKey} onClick={()=>{remember(r.requestKey);setPending(undefined);}}>核对历史消息提交 · {r.createdAt}</button>)}
    {key && <article aria-label="原消息请求">
      <p>原请求：{key}；{view?.acceptance ? `源已受理：${view.acceptance.status ?? 'ACCEPTED'}，运行 ${view.acceptance.runId ?? '尚未分配'}` : view?.sourceRejection || view?.receipt?.status === 'NOT_APPLIED' ? '源确认未执行；草稿保留' : '提交结果待核对，原正文已冻结'}</p>
      {view?.sourceRejection && <p role="alert">{view.sourceRejection.message}（{view.sourceRejection.code}）请结束核对并按刷新后的会话重新提交。</p>}
      {view?.sourceError && <p role="alert">{view.sourceError.message}（{view.sourceError.code}）</p>}
      {request.isError && <p role="alert">{request.error.message}</p>}
      <button disabled={busy} onClick={() => void request.refetch()}>核对原消息</button>
      {frozen && view && !surface.readonly && <button disabled={busy} onClick={() => void submit(true)}>按原 key 继续原消息</button>}
      {!frozen && <button onClick={() => {if (view?.sourceRejection || view?.receipt?.status === 'NOT_APPLIED') setDraft(view.request.content); remember(); setPending(undefined);}}>结束核对，继续编辑</button>}
    </article>}
    {!surface.readonly && <>
      <label>输入意图<select aria-label="输入意图" value={mode} disabled={busy||frozen||engagementFrozen} onChange={e=>setMode(e.target.value as typeof mode)}><option value="MESSAGE">继续对话</option><option value="BOUNDARY">补充当前执行</option><option value="SIDE_QUESTION">旁支问一下</option></select></label>
      {mode==='SIDE_QUESTION'&&<><label>只读研究者数量<select value={researchCount} onChange={e=>setResearchCount(Number(e.target.value))}><option value={0}>0（默认独立问答）</option><option value={1}>1</option><option value={2}>2</option><option value={3}>3</option></select></label>{researchCount>0&&<label><input type="checkbox" checked={textOnlyResearch} onChange={e=>setTextOnlyResearch(e.target.checked)}/>允许仅依据冻结文本研究</label>}</>}
      <label className="col" style={{gap:6,marginTop:12}}>后续消息<textarea style={{width:'100%',boxSizing:'border-box',minHeight:112,font:'inherit',color:'var(--text)',background:'var(--surface-raised)',border:'1px solid var(--border)',borderRadius:8,padding:10,resize:'vertical'}} aria-label="后续消息" value={draft} disabled={busy || frozen || engagementFrozen} onChange={e => setDraft(e.target.value)} rows={4} /></label>
      <p>{mode==='BOUNDARY'?'上下文建议将在安全边界消费；已投递不代表已消费。':mode==='SIDE_QUESTION'?'旁支使用冻结材料和独立用量，回答不会自动发给主 Agent。':detail?.conversation?.activeRunId ? '完成后继续：发送普通消息不会修改正在执行的 turn。' : '继续对话：在同一会话提交新的用户消息。'}</p>
      <button disabled={busy || frozen || engagementFrozen || !!intentUnavailable || new TextEncoder().encode(draft).length>(mode==='MESSAGE'?32768:8192) || !draft.trim() || !detail?.session || !plane} onClick={() => void submit()}>{mode==='BOUNDARY'?'发送当前执行建议':mode==='SIDE_QUESTION'?'提交旁支问题':detail?.conversation?.activeRunId ? '完成后继续' : '发送后续消息'}</button>
      {intentUnavailable&&<p role="status">{intentUnavailable}</p>}
      <button disabled={busy||engagementFrozen||!epoch||detail?.runId!==detail?.conversation?.activeRunId||capabilities?.['boundary.report']!=='READY'} onClick={()=>void report()}>请主 Agent 汇报后继续</button>
    </>}
    <TaskEngagementPanel key={taskId+':'+detail?.runId} taskId={taskId} detail={detail} selectedKey={trackedEngagement} onTrack={track} onRestoreRequest={r=>{if(r.kind==='BOUNDARY'){setDraft(r.source.text);setSourceRefs(r.source.sourceRefs??[]);setMode('BOUNDARY');}else if(r.kind==='SIDE_QUESTION'){setDraft(r.question);setMode('SIDE_QUESTION');}track();}} onDraft={(text,refs)=>{setDraft(text);setSourceRefs(refs);setMode('BOUNDARY');track();}} />
    {error && <p role="alert">{error}</p>}
  </Card>;
}
