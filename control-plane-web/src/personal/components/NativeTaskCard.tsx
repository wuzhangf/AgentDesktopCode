import {useMemo,useState} from 'react';
import {useQuery} from '@tanstack/react-query';
import {Card,ErrorBanner} from '../../components/ui/primitives';
import {usePersonalSurface} from '../hooks';
import {NativeGraphicsSection} from './NativeGraphicsSection';
import {nativeTasks} from '../native-tasks';
import type {PersonalTaskDetail} from '../../../../codeagent-desktop/packages/protocol/src/personal-task';
import {supportedNativeEngine} from '../../../../codeagent-desktop/packages/protocol/src/native-task';
import type {NativeInput,NativeInputRequest,NativeRequestView} from '../../../../codeagent-desktop/packages/protocol/src/native-task';

const nativeStates:Record<string,string>={PAUSE_REQUESTED:'等待暂停边界',PAUSED:'已在执行边界暂停',QUEUED:'排队中',VERIFYING:'正在验收',WAITING_INPUT:'等待输入',WAITING_RESOURCE:'等待执行资源',WAITING_USER_SESSION:'需在Mac完成授权或登录',RECOVERY_REQUIRED:'效果待核对',PREPARING:'准备工作区',PREPARED:'准备就绪',RUNNING:'执行中',SUCCEEDED:'已完成',FAILED:'执行失败',CANCELLED:'已停止',UNKNOWN:'待核对',REJECTED:'未启动'};
const eventNames:Record<string,string>={agent_start:'开始处理',turn_start:'开始本轮',tool_execution_start:'执行工具',tool_execution_end:'工具执行结束',ASSISTANT_MESSAGE:'助手回复',agent_end:'本轮消息结束',extension_ui_request:'等待用户回答','turn/started':'开始本轮','turn/completed':'本轮结果已返回',OBSERVATION_GAP:'观察有缺口',INPUT_RESULT_UNCONFIRMED:'输入结果待核对'};
export function NativeTaskCard({taskId,detail}:{taskId:string;detail:PersonalTaskDetail}){
  const port=useMemo(()=>nativeTasks(taskId),[taskId]),surface=usePersonalSurface(),n=detail.native;
  const [content,setContent]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const storageKey='native.request.'+taskId;
  const [pending,setPending]=useState<NativeInput|undefined>(()=>{try{const v=localStorage.getItem(storageKey)??sessionStorage.getItem(storageKey);return v?JSON.parse(v):undefined;}catch{return undefined;}});
  const [reply,setReply]=useState<NativeRequestView>();
  const stopStorageKey='native.stop.'+taskId;
  const [stopPending,setStopPending]=useState<NativeInput|undefined>(()=>{try{const v=localStorage.getItem(stopStorageKey)??sessionStorage.getItem(stopStorageKey);if(v)localStorage.setItem(stopStorageKey,v);return v?JSON.parse(v):undefined;}catch{return undefined;}});
  const [stopReply,setStopReply]=useState<NativeRequestView>();
  const [stopBusy,setStopBusy]=useState(false);
  const output=useQuery({queryKey:['native-output',taskId],queryFn:port.output,enabled:!!n,refetchInterval:3000});
  const metrics=useQuery({queryKey:['native-metrics',taskId],queryFn:port.metrics,enabled:!!n,refetchInterval:5000});
  const inputs=useQuery({queryKey:['native-inputs',taskId],queryFn:port.inputs,enabled:!!n,refetchInterval:3000});
  const [cursor,setCursor]=useState<string>();
  const events=useQuery({queryKey:['native-events',taskId,cursor],queryFn:()=>port.events(cursor),enabled:!!n,refetchInterval:3000});
  const artifacts=useQuery({queryKey:['native-artifacts',taskId,n?.quiescent],queryFn:port.artifacts,enabled:!!n,refetchInterval:5000});
  const supported=supportedNativeEngine(n?.engineId??(detail.executionBinding?.kind==='WORKER_LOCAL'?detail.executionBinding.engineId:undefined));
  const isMac=(n?.engineId??(detail.executionBinding?.kind==='WORKER_LOCAL'?detail.executionBinding.engineId:undefined))==='macos';
  const guard=supported&&n?.generation&&n.nativeSessionId&&n.currentCommandId?{generation:n.generation,nativeSessionId:n.nativeSessionId,targetCommandId:n.currentCommandId,...(n.nativeTurnId?{nativeTurnId:n.nativeTurnId}:{})}:undefined;
  async function control(kind:'PAUSE'|'RESUME'){
    if(!guard||busy||pending||!n?.capabilities?.[kind==='PAUSE'?'pause':'resume'])return;
    const request:NativeInput={...guard,kind,requestKey:'web-control-'+crypto.randomUUID()};
    setBusy(true);setError('');try{localStorage.setItem(storageKey,JSON.stringify(request));setPending(request);setReply(await port.send(request));}catch(e){setError((e as Error).message);}finally{setBusy(false);}
  }
  const stopGuard=supported&&n?.generation&&n.currentCommandId?{generation:n.generation,nativeSessionId:n.nativeSessionId??null,nativeTurnId:n.nativeTurnId??null,targetCommandId:n.currentCommandId}:undefined;
  async function send(kind:'NATIVE_STEER'|'NATIVE_FOLLOW_UP'|'STOP',question?:NativeInputRequest,response?:{value?:string;confirmed?:boolean;decision?:string}){
    if(kind==='STOP'){await stop();return;}
    if(!guard||busy||pending)return;const key='web-native-'+crypto.randomUUID();
    const request:NativeInput=question?{generation:question.generation,nativeSessionId:question.nativeSessionId,...(question.nativeTurnId?{nativeTurnId:question.nativeTurnId}:{}),targetCommandId:question.targetCommandId,requestKey:key,kind:'INPUT_RESPONSE',inputRequestId:question.inputRequestId,response:response!}:{...guard,requestKey:key,kind,content};
    setBusy(true);setError('');
    try{sessionStorage.setItem(storageKey,JSON.stringify(request));setPending(request);setReply(await port.send(request));setContent('');await inputs.refetch();}catch(e){setError((e as Error).message);}finally{setBusy(false);}
  }
  async function stop(){if(!stopGuard||stopBusy)return;setStopBusy(true);setError('');try{if(stopPending){setStopReply(await port.request(stopPending.requestKey));return;}const request:NativeInput={...stopGuard,kind:'STOP',requestKey:'web-native-stop-'+crypto.randomUUID()};localStorage.setItem(stopStorageKey,JSON.stringify(request));setStopPending(request);setStopReply(await port.send(request));await artifacts.refetch();}catch(e){setError((e as Error).message);}finally{setStopBusy(false);}}
  async function reconcile(){if(!pending||busy)return;setBusy(true);setError('');try{setReply(await port.request(pending.requestKey));}catch(e){setError((e as Error).message);}finally{setBusy(false);}}
  async function download(id:string,expected:{path:string;sha256?:string}){try{const f=await port.artifact(id);const bytes=Uint8Array.from(atob(f.bytes),c=>c.charCodeAt(0));const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))).map(x=>x.toString(16).padStart(2,'0')).join('');if(f.path!==expected.path||digest!==f.sha256||expected.sha256&&digest!==expected.sha256)throw new Error('结果文件摘要不一致');const url=URL.createObjectURL(new Blob([bytes]));const link=document.createElement('a');link.href=url;link.download=f.path.split(/[\\/]/).at(-1)||'native-result';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}catch(e){setError((e as Error).message);}}
  function clear(){localStorage.removeItem(storageKey);sessionStorage.removeItem(storageKey);setPending(undefined);setReply(undefined);}
  return <div className="col" style={{gap:16}}><Card title={`${detail.core} 原生任务`}>
    <p>状态：{detail.sourceError?'观察中断，保留上次事实':(nativeStates[n?.state??'']??n?.state)??(detail.submissionError?'预检／受理被拒绝':'正在核对原提交')}</p>
    {n?.engineId==='macos'&&<><p style={{overflowWrap:'anywhere'}}>原任务：{n.taskId}；原会话：{n.nativeSessionId??'尚未报告'}</p><p>效果核对：{n.quiescent===true?'所有效果已静止':n.quiescent===false?'仍有未证结束的效果':'总静止状态未知'}；本地：{n.localQuiescent===true?'已静止':n.localQuiescent===false?'尚未证实静止':'未知'}；远端停止：{n.remoteStopConfirmed===true?'已确认':n.remoteStopConfirmed===false?'尚未确认':'未知'}</p></>}
    <p>程序：{n?.engineVersion??(detail.executionBinding?.kind==='WORKER_LOCAL'?detail.executionBinding.engineVersion:'未知')}；{isMac?'执行／推理信息':'配置模型'}：{n?.configuredModel??n?.executionOptions?.model??(isMac?'尚未报告，以来源实报为准':'原生默认值，尚未报告')}</p>
    {detail.executionBinding?.kind==='WORKER_LOCAL'&&detail.executionBinding.authorityId&&<p style={{overflowWrap:'anywhere'}}>宿主：{detail.executionBinding.workerId}；来源：{detail.executionBinding.authorityId}；存储：{detail.executionBinding.storeId}</p>}
    {n?.graphicsProfile?<p>登记目标：{n.graphicsProfile.windowTitle} · {n.graphicsProfile.bundleID}；此配方不读取Git工作区。</p>:<p style={{overflowWrap:'anywhere'}}>工作目录：{n?.workspace??n?.workingDirectory??(isMac?'来源未公开':'准备中')}；基线：{n?.baseCommit??(isMac?'来源未公开':'尚未报告')}</p>}
    {n?.reasonCode&&<p role="status">{n.reasonCode}</p>}{detail.sourceError&&<p role="alert">{detail.sourceError}</p>}{detail.submissionError&&<p role="alert">{detail.submissionError.message}</p>}
    {!supported&&<p role="status">此 engine 尚未采纳，交互不可用；保留原来源和已知任务事实。</p>}<p>该任务使用同一原生会话；下一轮使用新请求。暂停与接续以来源当前能力及原回执为准。</p>
    {!surface.readonly&&guard&&<>{n?.capabilities?.pause&&<button disabled={busy||!!pending} onClick={()=>void control('PAUSE')}>请求边界暂停</button>}{n?.capabilities?.resume&&<button disabled={busy||!!pending} onClick={()=>void control('RESUME')}>按来源方式继续</button>}</>}
    {!surface.readonly&&guard&&!n?.graphicsProfile&&<><label className="col">补充要求<textarea rows={4} style={{width:'100%',minHeight:80,background:'#0f172a',color:'inherit',border:'1px solid #334155',borderRadius:8,padding:10}} aria-label="原生任务补充" value={content} onChange={e=>setContent(e.target.value)} disabled={busy||!!pending} maxLength={16384}/></label><div className="row" style={{gap:8}}><button disabled={busy||!!pending||!content.trim()||!n?.capabilities?.steer} onClick={()=>void send('NATIVE_STEER')}>补充当前任务</button><button disabled={busy||!!pending||!content.trim()||!n?.capabilities?.followUp} onClick={()=>void send('NATIVE_FOLLOW_UP')}>下一轮继续</button></div></>}
    {!surface.readonly&&stopGuard&&<button disabled={stopBusy||!n?.capabilities?.stop} onClick={()=>void send('STOP')}>停止原生任务</button>}
    {pending&&<div role="status"><p>原请求：{pending.requestKey}；{reply?.source?String(reply.source.state??'已观测'):reply?.state??'待核对'}</p><button disabled={busy} onClick={()=>void reconcile()}>只读核对原请求</button>{(reply?.state==='OBSERVED'||reply?.state==='REJECTED')&&<button disabled={busy} onClick={clear}>确认回执，继续操作</button>}</div>}
    {stopPending&&<div role="status"><p>停止原请求：{stopPending.requestKey}；{String(stopReply?.source?.state??stopReply?.state??'待核对')}</p><button disabled={busy} onClick={()=>void stop()}>只读核对停止请求</button></div>}
    {error&&<p role="alert">{error}</p>}
    {inputs.data?.items.filter(q=>q.state==='PENDING').map(q=><Input key={q.inputRequestId} question={q} disabled={!supported||surface.readonly||busy||!!pending} answer={r=>void send('NATIVE_STEER',q,r)}/>)}
  </Card><NativeGraphicsSection key={taskId} taskId={taskId} detail={detail} readonly={surface.readonly}/><Card title="原生公开输出">{output.isError&&<ErrorBanner error={output.error} onRetry={()=>output.refetch()}/>}<pre style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{output.data?.text??'尚无公开消息'}</pre></Card>
  <Card title="原生活动"><div style={{maxHeight:360,overflowY:'auto'}}>{events.data?.cursorExpired&&<p role="alert">事件有缺口，当前仅展示保留记录。</p>}{events.data?.items.filter(e=>eventNames[e.kind]).map(e=><p key={e.cursor}>{e.occurredAt} · {eventNames[e.kind]}</p>)}{events.data?.items.length===30&&<button onClick={()=>setCursor(events.data!.cursor)}>后续活动</button>}{cursor&&<button onClick={()=>setCursor(undefined)}>首批活动</button>}</div></Card>
  <Card title="结果文件" sub="任务工作区中的实际文件候选，不自动写回原项目">{artifacts.isError&&<ErrorBanner error={artifacts.error} onRetry={()=>artifacts.refetch()}/>}<p>{artifacts.data?.reasonCode==='STOP_TO_SEAL_RESULTS'?'停止原生任务后，可收集工作区中的结果文件。':artifacts.data?.reasonCode}</p>{artifacts.data?.items.map(a=><p key={a.artifactId}>{a.path} · {a.status} {a.status==='AVAILABLE'&&<button onClick={()=>void download(a.artifactId,a)}>下载文件</button>}</p>)}</Card><Card title="用量">{metrics.isError&&<ErrorBanner error={metrics.error} onRetry={()=>metrics.refetch()}/>}<p>{metrics.data?.native?.coverage==='LAST_ASSISTANT_MESSAGE'?'下列为原生最后一条助手消息的报告，不是任务总量。':metrics.data?.native?.coverage==='NATIVE_TASK_TOTAL'?'下列为原生任务报告的累计值。':metrics.data?.native?.coverage==='NATIVE_THREAD_TOTAL'?'下列为原生线程报告的累计值。':metrics.data?.native?.coverage==='NO_MODEL'?(isMac?'来源报告 NO_MODEL；委派来源的用量须另按其实报核对。':'来源报告本任务没有模型用量。'):'来源未声明用量覆盖范围。'}</p>{Object.entries(metrics.data?.native?.usage??{}).map(([key,value])=><p key={key}>{({'usage.input':'输入 token','usage.output':'输出 token','usage.totalTokens':'总 token','usage.inputTokens':'输入 token','usage.outputTokens':'输出 token'} as Record<string,string>)[key]??key}：{value}</p>)}<p>费用覆盖未知；不推算账单。{isMac?'执行与推理信息以各来源实报为准。':'配置模型与原生报告用量分别保留。'}</p></Card></div>;
}
function Input({question:q,disabled,answer}:{question:NativeInputRequest;disabled:boolean;answer:(r:{value?:string;confirmed?:boolean;decision?:string})=>void}){
  const [value,setValue]=useState('');const approval=q.method.endsWith('requestApproval');
  return <fieldset disabled={disabled}><legend>{q.title||q.method}</legend>{q.scope&&<pre style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{Object.entries(q.scope).map(([key,value])=>key+': '+value).join('\n')}</pre>}{q.method==='confirm'?<><button onClick={()=>answer({confirmed:true})}>确认</button><button onClick={()=>answer({confirmed:false})}>拒绝</button></>:q.options?.length?<>{q.options.map(v=><button key={v} onClick={()=>answer(approval?{decision:v}:{value:v})}>{v}</button>)}</>:<><input aria-label="原生问题回答" value={value} onChange={e=>setValue(e.target.value)} maxLength={16384}/><button onClick={()=>answer({value})}>提交回答</button></>}</fieldset>;
}
