import {personalControlHeaders,PersonalClientError} from './client';
import {validNativeInput,validNativeGraphicsInput,type NativeGraphicsInput,type NativeGraphicsObservation,type NativeGraphicsArtifact,type NativeGraphicsRequestView,type NativeInput,type NativeInputRequest,type NativeRequestView} from '../../../codeagent-desktop/packages/protocol/src/native-task';
/** The same task routes and same-origin owner guard as ACS. No source URL crosses this port. */
export function nativeTasks(taskId:string,fetchImpl:typeof fetch=fetch){
  if(!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(taskId))throw new Error('Invalid task');
  const root='/api/personal/v1/tasks/'+taskId;
  async function call<T>(tail:string,body?:NativeInput|NativeGraphicsInput):Promise<T>{
    const res=await fetchImpl(root+tail,{method:body?'POST':'GET',credentials:'same-origin',cache:'no-store',headers:{...personalControlHeaders(),'content-type':'application/json',...(body?{'idempotency-key':body.requestKey}:{})},body:body?JSON.stringify(body):undefined});
    const v=await res.json();if(!res.ok)throw new PersonalClientError(v.error?.code??'LOCAL_SOURCE_UNAVAILABLE',v.error?.message??'原生任务来源暂不可读',{status:res.status});if(!v.meta||!('data'in v))throw new Error('Invalid task envelope');return v.data as T;
  }
  return {
    graphicsObservations:()=>call<{items:NativeGraphicsObservation[]}>('/graphics/observations'),
    graphicsRequest:(key:string)=>{if(!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(key))throw new Error('Invalid key');return call<NativeGraphicsRequestView>('/graphics/requests/'+key);},
    graphics:(route:'observe'|'capture'|'actions',body:NativeGraphicsInput)=>{if(!validNativeGraphicsInput(route,body))throw new Error('Invalid graphics request');return call<NativeGraphicsRequestView>('/graphics/'+route,body);},
    output:()=>call<{text:string;coverage:string}>('/output'),
    events:(cursor?:string)=>call<{items:{cursor:string;kind:string;occurredAt:string}[];cursor:string;cursorExpired:boolean}>('/activities?'+new URLSearchParams({...(cursor?{afterCursor:cursor}:{}),limit:'30'})),
    inputs:()=>call<{items:NativeInputRequest[]}>('/input-requests'),
    metrics:()=>call<import('../../../codeagent-desktop/packages/protocol/src/personal-task').PersonalTaskMetrics>('/metrics'),
    artifacts:()=>call<{items:NativeGraphicsArtifact[];reasonCode?:string}>('/artifacts'),
    artifact:(id:string)=>{if(!/^file-[a-f0-9]{64}$/.test(id))throw new Error('Invalid artifact');return call<{path:string;encoding:'base64';bytes:string;sha256:string}>('/artifacts/'+id);},
    request:(key:string)=>{if(!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(key))throw new Error('Invalid key');return call<NativeRequestView>('/interaction-requests/'+key);},
    send:(body:NativeInput)=>{if(!validNativeInput(body))throw new Error('Invalid native input');return call<NativeRequestView>(['STOP','PAUSE','RESUME'].includes(body.kind)?'/commands':body.kind==='INPUT_RESPONSE'?`/input-requests/${body.inputRequestId}/responses`:'/messages',body);},
  };
}

export async function nativeSourceTasks(projectId:string,localTaskId?:string){
  if(!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(projectId)||localTaskId&&!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(localTaskId))throw new Error('Invalid source task');
  const body=localTaskId?{requestKey:'web-adopt-'+crypto.randomUUID(),localTaskId}:undefined;
  const response=await fetch('/api/personal/v1/projects/'+projectId+(body?'/native-task-adoptions':'/native-tasks'),{method:body?'POST':'GET',credentials:'same-origin',cache:'no-store',headers:{...personalControlHeaders(),'content-type':'application/json'},body:body?JSON.stringify(body):undefined});
  const value=await response.json();if(!response.ok)throw new Error(value.error?.code??'SOURCE_UNAVAILABLE');return value.data as {items?:{localTaskId:string;title:string;state:string}[];taskId?:string};
}
