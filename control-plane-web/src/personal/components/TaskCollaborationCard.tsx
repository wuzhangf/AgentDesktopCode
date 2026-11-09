import {useEffect,useMemo,useState} from 'react';
import {useQuery,useQueryClient} from '@tanstack/react-query';
import {WritableCollaborationPanel,type WritableCollaborationClient} from '../../../../codeagent-desktop/src/renderer/app/WritableCollaborationPanel';
import {type WritableOperation} from '../../../../codeagent-desktop/packages/protocol/src/writable-collaboration';
import {taskCollaborationPort,type CollaborationRequestView} from '../collaboration';
import {PersonalClientError} from '../client';
import {usePersonalGateway,usePersonalSurface} from '../hooks';
import {Card} from '../../components/ui/primitives';
import './task-collaboration.css';

export function TaskCollaborationCard({taskId,runId,sessionId,storeId}:{taskId:string;runId?:string;sessionId?:string;storeId?:string}){
  const surface=usePersonalSurface();
  if(!runId||!sessionId||surface.kind!=='web')return null;
  return <BoundCollaboration key={`${taskId}:${storeId}:${runId}`} {...{taskId,runId,sessionId,storeId}} readonly={surface.readonly}/>;
}
function BoundCollaboration({taskId,runId,sessionId,storeId,readonly}:{taskId:string;runId:string;sessionId:string;storeId?:string;readonly:boolean}){
  const gateway=usePersonalGateway(),cache=useQueryClient();
  const port=useMemo(()=>taskCollaborationPort(taskId),[taskId]);
  const storageKey=`personal.collaboration:${taskId}:${storeId}:${runId}`;
  const [frozen,setFrozen]=useState<WritableOperation|undefined>(()=>{try{const v=JSON.parse(localStorage.getItem(storageKey)??'null');return v?.runId===runId?v:undefined;}catch{return undefined;}});
  const [restoredKey]=useState(()=>frozen&&'key' in frozen?frozen.key:undefined);
  const [error,setError]=useState('');
  const [panelGeneration,setPanelGeneration]=useState(0),[notDispatched,setNotDispatched]=useState(false);
  const persist=(operation?:WritableOperation)=>{if(operation)localStorage.setItem(storageKey,JSON.stringify(operation));else localStorage.removeItem(storageKey);setFrozen(operation);};
  const root=useQuery({queryKey:['personal-collaboration',taskId,storeId,runId],queryFn:()=>port.root(runId),refetchInterval:5000,retry:false});
  const [recovered,setRecovered]=useState<CollaborationRequestView>();
  const result=(view:CollaborationRequestView)=>{
    setRecovered(view);
    if(view.state==='REJECTED'){persist();return {error:view.sourceError?.message??'源拒绝了原请求',code:view.sourceError?.code,status:view.sourceError?.status??409,failure:{effectState:'NOT_APPLIED'}};}
    if(view.observation||view.reply){
      const observed=view.observation??view.reply!;
      try{const preferences=JSON.parse(localStorage.getItem(storageKey+':view')??'{}'),op=view.operation;
        if(op.action==='CREATE')preferences.groupId=observed.entityId;else if('groupId' in op)preferences.groupId=op.groupId;
        if(op.action==='SELECT'){preferences.selectionId=observed.entityId;preferences.previewId='';}
        if(op.action==='PREVIEW'||op.action==='REVISE')preferences.previewId=observed.entityId;
        localStorage.setItem(storageKey+':view',JSON.stringify(preferences));
      }catch{/* source identities remain available from the durable journal */}
      persist();return observed;
    }
    return undefined;
  };
  const frozenKey=frozen&&'key' in frozen?frozen.key:undefined;
  const original=useQuery({queryKey:['personal-collaboration-request',storageKey,frozenKey],enabled:!!frozenKey&&frozenKey===restoredKey,queryFn:()=>port.request(frozenKey!),refetchInterval:frozenKey===restoredKey?1500:false,retry:false});
  useEffect(()=>{
    if(frozenKey&&original.data&&result(original.data)){setPanelGeneration(v=>v+1);void cache.invalidateQueries({queryKey:['personal-collaboration',taskId]});void cache.invalidateQueries({queryKey:['writable',storageKey,runId]});}
  },[frozenKey,original.data]);
  const client=useMemo<WritableCollaborationClient>(()=>{const children=new Map<string,{groupId:string;entityId:string}>();return {
    writableCollaboration:async operation=>{
      if(!('key' in operation)){
        const value=await port.operation(operation);
        if(operation.action==='GROUP'&&'children' in value&&Array.isArray(value.children))for(const row of value.children)if(row.sessionId)children.set(row.sessionId,{groupId:operation.groupId,entityId:row.entityId});
        return value;
      }
      if(readonly)throw new Error('当前为只读面');
      // The frozen body reaches storage before the first network write. Refresh only reads it.
      let previous:WritableOperation|undefined;try{previous=JSON.parse(localStorage.getItem(storageKey)??'null')??undefined;}catch{throw new Error('原请求存储不可读，请先核对');}
      if(previous&&'key' in previous&&previous.key!==operation.key)throw new Error('先核对原协作请求，避免重复采纳');
      persist(operation);
      let view:CollaborationRequestView;
      if(previous){try{view=await port.request(operation.key);}catch(e){if(!(e instanceof PersonalClientError)||e.status!==404)throw e;view=await port.operation(operation) as CollaborationRequestView;}}
      else view=await port.operation(operation) as CollaborationRequestView;
      for(let i=0;i<20;i++){
        const value=result(view);if(value){await cache.invalidateQueries({queryKey:['personal-collaboration',taskId]});return value;}
        if(!view.pending)break;
        await new Promise(resolve=>setTimeout(resolve,300));view=await port.request(operation.key);
      }
      throw new Error('原请求已保存；请核对原结果，刷新不会重发');
    },
    collaboration:async operation=>{const value=await port.root(runId);if(operation.action==='FOUNDATION'&&operation.subjectId===sessionId)return value.foundation;if(operation.action==='SEGMENTS'&&operation.subjectId===runId)return value.segments;throw new Error('仅开放当前任务 foundation/segments');},
    listAgentProfiles:async()=>(await gateway.taskInteractionCatalog(taskId)).data.profiles,
    getModelCatalog:async()=>(await gateway.taskInteractionCatalog(taskId)).data.models,
    getSession:async id=>{const child=children.get(id);if(!child)throw new Error('子会话不在当前源协作组内');return port.child(runId,child.groupId,child.entityId);},
  };},[port,taskId,runId,sessionId,readonly,storageKey,gateway,cache]);
  const recover=async(key:string)=>{setError('');setNotDispatched(false);try{const value=await port.request(key);if(result(value))setPanelGeneration(v=>v+1);await cache.invalidateQueries({queryKey:['writable',storageKey,runId]});}catch(e){setNotDispatched(e instanceof PersonalClientError&&e.status===404);setError((e as Error).message);}};
  const continueOriginal=async()=>{if(!frozen)return;setError('');try{await client.writableCollaboration(frozen);setPanelGeneration(v=>v+1);}catch(e){setError((e as Error).message);}};
  const pending=root.data?.requests.filter(v=>v.state==='UNKNOWN')??[];
  return <div className="personal-collaboration"><Card title="多 Agent 分工与结果采纳" sub="源协作组、子执行与采纳分别查询；只作用于原父执行目录">
    {root.isError&&<p role="alert">协作来源暂不可读：{root.error.message}</p>}
    {frozen&&'key' in frozen&&<p role="status">原 {frozen.action} 请求待核对 <button onClick={()=>void recover(frozen.key)}>查询原请求结果</button></p>}
    {notDispatched&&frozen&&!readonly&&<button onClick={()=>void continueOriginal()}>按保存的原 key 和载荷继续提交</button>}
    {pending.filter(v=>!frozen||!('key'in frozen)||v.requestKey!==frozen.key).map(v=><p key={v.requestKey}>原 {v.operation.action}：结果待确认 <button onClick={()=>void recover(v.requestKey)}>核对此请求</button></p>)}
    {recovered&&<p role="status">原请求：{recovered.state}；{recovered.observation?.state??recovered.reply?.state??recovered.sourceError?.message??'尚未确认效果'}</p>}
    {error&&<p role="alert">{error}</p>}
    <fieldset disabled={!!frozen||pending.length>0} style={{border:0,padding:0,minWidth:0}}>
      <WritableCollaborationPanel key={panelGeneration} sessionId={sessionId} runId={runId} client={client} defaultUnitCount={2} personalFriendly readOnly={readonly} cacheScope={storageKey}/>
    </fieldset>
  </Card></div>;
}
