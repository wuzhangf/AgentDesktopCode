import {validWritableOperation, WRITABLE_ROUTES, type WritableOperation, type WritableResponse, type WritableRecord} from '../../../codeagent-desktop/packages/protocol/src/writable-collaboration';
import {personalControlHeaders, PersonalClientError} from './client';
export interface CollaborationRequestView {
  requestKey:string;operation:WritableOperation;binding:{runId:string;sessionId:string;storeId:string};
  state:'UNKNOWN'|'OBSERVED'|'REJECTED';pending:boolean;reply?:WritableRecord;observation?:WritableRecord;
  sourceError?:{code:string;message:string;status?:number};
}
export interface TaskCollaborationView {
  source:{items?:WritableRecord[]};foundation:Record<string,unknown>;segments:Record<string,unknown>;
  binding:{runId:string;sessionId:string;storeId:string};requests:CollaborationRequestView[];
}
/** Typed owner transport. Only fixed task routes, never source URLs or arbitrary methods. */
export function taskCollaborationPort(taskId:string,fetchImpl:typeof fetch=fetch){
  if(!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(taskId))throw new Error('Invalid task identity');
  const root=`/api/personal/v1/tasks/${encodeURIComponent(taskId)}/collaboration`;
  async function request<T>(tail:string,body?:unknown):Promise<T>{
    const response=await fetchImpl(root+tail,{method:body?'POST':'GET',credentials:'same-origin',cache:'no-store',headers:{...personalControlHeaders(),'content-type':'application/json',...(body?{'idempotency-key':(body as {requestKey:string}).requestKey}:{})},body:body?JSON.stringify(body):undefined});
    const result=await response.json();if(!response.ok)throw new PersonalClientError(result.error?.code??'COLLABORATION_UNAVAILABLE',result.error?.message??'协作来源暂不可读',{status:response.status,retryable:result.error?.retryable});
    if(!result.meta||!('data' in result))throw new Error('Invalid personal collaboration envelope');return result.data as T;
  }
  return {
    root:(runId:string)=>request<TaskCollaborationView>('?'+new URLSearchParams({runId})),
    child:(runId:string,groupId:string,entityId:string)=>{
      if(![runId,groupId,entityId].every(id=>/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id)))throw new Error('Invalid child identity');
      return request(`/groups/${groupId}/executions/${entityId}/messages?`+new URLSearchParams({runId}));
    },
    request:(key:string)=>{if(!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(key))throw new Error('Invalid request key');return request<CollaborationRequestView>('/requests/'+encodeURIComponent(key));},
    async operation(op:WritableOperation):Promise<WritableResponse|CollaborationRequestView>{
      if(!validWritableOperation(op))throw new Error('Invalid bounded collaboration operation');
      if(WRITABLE_ROUTES[op.action].method==='POST'&&'key' in op){const {runId,key,...operation}=op;return request<CollaborationRequestView>('/operations',{targetRunId:runId,requestKey:key,operation});}
      const q=new URLSearchParams({runId:op.runId});let tail='';
      switch(op.action){
        case 'LIST':return (await request<TaskCollaborationView>('?'+q)).source as WritableResponse;
        case 'ACTIVITY':tail='/activity';break;
        case 'GROUP':tail=`/groups/${op.groupId}`;break;
        case 'EXECUTIONS':case 'ADOPTIONS':tail=`/groups/${op.groupId}/${op.action.toLowerCase()}`;break;
        case 'EXECUTION':case 'CANDIDATE':case 'ADOPTION':case 'REVIEW_RESULT':tail=`/resources/${op.action}/${op.entityId}`;q.set('groupId',op.groupId);break;
        case 'CANDIDATE_FILES':case 'PREVIEW_FILES':tail='/files';q.set('kind',op.action);q.set('groupId',op.groupId);q.set('entityId',op.entityId);for(const [k,v]of Object.entries(op))if(['side','unitId','path','offset','limit'].includes(k)&&v!==undefined)q.set(k,String(v));break;
        default:throw new Error('Unsupported collaboration route');
      }
      return request<WritableResponse>(tail+'?'+q);
    }
  };
}
