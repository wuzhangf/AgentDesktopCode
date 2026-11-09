import {useState} from 'react';
import {usePersonal,usePersonalGateway,usePersonalInvalidate,usePersonalSurface} from '../hooks';
import type {TaskEngagementRequest,TaskEngagementView} from '../../../../codeagent-desktop/packages/protocol/src/personal-interaction';
import type {PersonalTaskDetail} from '../../../../codeagent-desktop/packages/protocol/src/personal-task';
import type {CollaborationResource} from '../../../../codeagent-desktop/packages/protocol/src/collaboration';
const labels:Record<string,string>={PENDING:'已受理，待安全边界',DELIVERED:'已投递，尚未证明消费',CONSUMED:'主 Agent 已消费',ANSWERED:'主 Agent 已回答',QUEUED:'独立预算排队',RUNNING:'旁支处理中',SUCCEEDED:'旁支回答已保存',ACCEPTED:'接管已受理',QUIESCING:'等待旧写者静止',PREPARED:'恢复证据已核验',ACTIVATING:'新执行者启动中',ACTIVE:'接管完成已证明',FAILED:'源执行失败',REJECTED:'源已拒绝',CANCELLED:'已取消',EXPIRED:'已过期',OUTCOME_UNKNOWN:'结果未知，可能已产生费用',UNKNOWN:'结果未知，保留原请求'};
export function TaskEngagementPanel({taskId,detail,selectedKey,onTrack,onDraft,onRestoreRequest}: {
  taskId:string;detail?:PersonalTaskDetail;selectedKey?:string;onTrack:(key?:string)=>void;onDraft:(text:string,refs:string[])=>void;onRestoreRequest:(request:TaskEngagementRequest)=>void;
}) {
  const gateway=usePersonalGateway(),surface=usePersonalSurface(),invalidate=usePersonalInvalidate();
  const [historyCursor,setHistoryCursor]=useState<string>();
  const interactions=usePersonal(['taskInteractions',taskId,detail?.runId,historyCursor],g=>g.taskInteractions(taskId,detail?.runId,historyCursor),{enabled:!!detail?.sessionId&&surface.kind!=='demo',refetchInterval:5000});
  const catalog=usePersonal(['taskInteractionCatalog',taskId],g=>g.taskInteractionCatalog(taskId),{enabled:!!detail?.sessionId&&surface.kind!=='demo'});
  const [approvalCursor,setApprovalCursor]=useState<string>();
  const approvals=usePersonal(['taskApprovals',taskId,approvalCursor],g=>g.taskApprovals(taskId,approvalCursor),{enabled:!!detail?.sessionId&&surface.kind!=='demo',refetchInterval:5000});
  const request=usePersonal(['taskEngagement',taskId,selectedKey],g=>g.taskEngagement(taskId,selectedKey!),{enabled:!!selectedKey,refetchInterval:3000});
  const [profile,setProfile]=useState(''),[model,setModel]=useState(''),[preflightKey,setPreflightKey]=useState<string>();
  const preflight=usePersonal(['taskEngagement',taskId,preflightKey],g=>g.taskEngagement(taskId,preflightKey!),{enabled:!!preflightKey,refetchInterval:q=>q.state.data?.data.result?false:2000});
  const [busy,setBusy]=useState(false),[error,setError]=useState('');
  const submit=async(body:TaskEngagementRequest)=>{if(busy||surface.readonly)return;setBusy(true);setError('');onTrack(body.requestKey);
    try{await gateway.createTaskEngagement(taskId,body);await invalidate();}catch(e){setError((e as Error).message);}finally{setBusy(false);}};
  if(surface.kind==='demo'||!detail?.sessionId)return null;
  const requests=(interactions.data?.data.requests??[]) as TaskEngagementView[];
  const current=request.data?.data, result=current?.result;
  const rows=(value:unknown)=>Array.isArray((value as CollaborationResource)?.items)?(value as CollaborationResource).items as CollaborationResource[]:[];
  const profiles=catalog.data?.data.profiles.profiles??[],models=(catalog.data?.data.models.items??[]).filter(m=>m.configured&&m.availability==='AVAILABLE');
  const id=()=>`web-interact-${crypto.randomUUID()}`;
  const selectedProfile=profiles.find(p=>p.id===profile);
  return <section aria-label="任务交互回执">
    <h3>交互与原请求</h3>
    {interactions.isError&&<p role="alert">{interactions.error.message}</p>}
    {requests.map(r=><button key={r.request.requestKey} onClick={()=>onTrack(r.request.requestKey)}>{r.request.kind} · {r.binding.runId} · {labels[String(r.result?.state)]??r.result?.state??'结果待核对'}</button>)}
    {!!interactions.data?.data.nextCursor&&<button onClick={()=>setHistoryCursor(String(interactions.data?.data.nextCursor))}>更早交互请求</button>}{historyCursor&&<button onClick={()=>setHistoryCursor(undefined)}>最新交互请求</button>}
    {selectedKey&&<article>
      <p>原交互 {selectedKey}；运行 {current?.binding.runId??'核对中'}；{labels[String(result?.state)]??result?.state??(result?'源已返回结果':'结果待核对')}</p>
      {(current?.sourceError||request.isError)&&<p role="alert">{current?.sourceError?.message??request.error?.message} {current?.sourceError?.code}</p>}
      {current?.sourceRejection&&<p role="alert">源已拒绝本次交互：{current.sourceRejection.message}（{current.sourceRejection.code}）；已完成子步骤仍保留。</p>}
      {current?.request.kind==='SIDE_QUESTION'&&<>
        <p>冻结材料时间：{String(current.steps?.snapshot?.capturedAt??current.steps?.snapshot?.capturedTo??current.createdAt)}；主运行 {current.binding.runId}</p>
        <p>独立预留模型调用：{String(result?.reservedModelCalls??'未报告')}；token 预留：{String(result?.reservedTokenUnits??'未报告')}，不计入选中主 Run 的完整费用。</p>
        <pre style={{whiteSpace:'pre-wrap'}}>{String(result?.answer??'等待旁支源结果')}</pre>
        {result?.answer&&<button onClick={()=>onDraft(String(result.answer),[`auxiliary-turn:${current.steps?.auxiliary?.sessionId}/${result.turnId}`,`context-package:${result.packageId??current.steps?.package?.packageId}`])}>旁支答案转为建议草稿</button>}
      </>}
      {result?.reasonCode&&<p>源原因：{String(result.reasonCode)}</p>}
      {!!result?.reportMessage&&<pre style={{whiteSpace:'pre-wrap'}}>主 Agent 汇报：{String((result.reportMessage as Record<string,unknown>).content??(result.reportMessage as Record<string,unknown>).contentPreview??'仅有消息绑定，正文暂不可读')}</pre>}
      <button onClick={()=>void request.refetch()}>核对原交互</button>
      {current?.sourceError&&!current.sourceRejection&&!current.result&&!surface.readonly&&<button disabled={busy} onClick={()=>void submit(current.request)}>按原 key 继续原交互</button>}
      {current?.request.kind==='BOUNDARY'&&['PENDING','DELIVERED'].includes(String(result?.state))&&!surface.readonly&&<button disabled={busy} onClick={()=>void submit({kind:'CANCEL_BOUNDARY',requestKey:id(),targetRunId:current.binding.runId,resourceId:current.request.requestKey})}>取消本次边界请求</button>}
      {current?.request.kind==='HANDOFF'&&['ACCEPTED','QUIESCING','PREPARED','BLOCKED'].includes(String(result?.state))&&!surface.readonly&&<button disabled={busy} onClick={()=>void submit({kind:'CANCEL_HANDOFF',requestKey:id(),targetRunId:current.binding.runId,resourceId:current.request.requestKey})}>取消本次接管</button>}
      {current?.sourceRejection&&<button onClick={()=>onRestoreRequest(current.request)}>保留草稿，结束本次核对</button>}
      {current?.result&&<button onClick={()=>onTrack()}>结束核对</button>}
    </article>}
    <details><summary>源端边界与接管历史</summary>{[...rows(interactions.data?.data.boundaries),...rows(interactions.data?.data.handoffs)].map((v,i)=><p key={i}>{String(v.requestId??v.transitionId)} · {labels[String(v.state)]??v.state}</p>)}</details>
    <h3>当前会话已有审批</h3>
    {approvals.isError&&<p role="alert">{approvals.error.message}</p>}
    {approvals.data?.data.items.map(a=><article key={a.approvalId}><p>{a.kind} · {a.publicSummary} · {a.decisionStatus} · {a.executionStatus}</p>
      <p>运行 {a.runId}；版本 {a.version}</p>
      {!surface.readonly&&a.requiresUserAction&&a.allowedActions.filter(action=>['APPROVE','DENY','CANCEL','EXECUTE'].includes(action)).map(action=><button key={action} disabled={busy||a.runId!==detail.runId} onClick={()=>void submit({kind:'APPROVAL_DECISION',requestKey:id(),targetRunId:a.runId,approvalId:a.approvalId,source:{decision:action as 'APPROVE',expectedVersion:a.version,requestFingerprint:a.requestFingerprint}})}>{({APPROVE:'批准本项',DENY:'拒绝本项',CANCEL:'取消本项',EXECUTE:'执行已批准项'} as Record<string,string>)[action]}</button>)}
    </article>)}
    {approvals.data?.data.nextCursor&&<button onClick={()=>setApprovalCursor(approvals.data?.data.nextCursor??undefined)}>更多审批</button>}{approvalCursor&&<button onClick={()=>setApprovalCursor(undefined)}>最新审批</button>}
    {!surface.readonly&&<details><summary>兼容画像／模型接管</summary><p>仅限 product-code；保留源预算和截止时间。预检不会暂停任务。</p>
      <label>目标画像<select value={profile} onChange={e=>{setProfile(e.target.value);setPreflightKey(undefined);}}><option value="">选择画像</option>{profiles.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
      <label>目标模型<select value={model} onChange={e=>{setModel(e.target.value);setPreflightKey(undefined);}}><option value="">保持生效模型</option>{models.map(m=><option key={m.providerId+'/'+m.modelAlias} value={m.providerId+'/'+m.modelAlias}>{m.providerId} / {m.modelAlias}</option>)}</select></label>
      <button disabled={busy||!selectedProfile?.revision||!detail.runId} onClick={()=>{const key=id();setPreflightKey(key);void submit({kind:'PREFLIGHT',requestKey:key,targetRunId:detail.runId!,source:{schemaVersion:'assignment-transition-request/1',target:{harnessId:'product-code',agentProfileId:profile,agentProfileRevision:selectedProfile!.revision!,modelSelection:model?{mode:'EXPLICIT',settings:{modelAlias:model}}:{mode:'KEEP_EFFECTIVE'}},pendingInputPolicy:'CANCEL_PENDING'}});}}>检查兼容性</button>
      {preflight.data?.data.result&&<p>兼容性：{preflight.data.data.result.state==='ELIGIBLE'?'可接管':String(preflight.data.data.result.state)}；目标 {selectedProfile?.name}；{model||'保持当前生效模型'}；保留原预算和期限。</p>}
      <button disabled={busy||!preflightKey||!preflight.data?.data.result?.preflightDigest||!detail.runId} onClick={()=>void submit({kind:'HANDOFF',requestKey:id(),targetRunId:detail.runId!,preflightKey:preflightKey!})}>确认接管</button>
    </details>}
    {error&&<p role="alert">{error}</p>}
  </section>;
}
