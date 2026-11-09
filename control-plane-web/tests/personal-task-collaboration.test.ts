import {describe,it,expect} from 'vitest';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ManagementStore} from '../server/management/registry-store';
import {ConnectionHub} from '../server/management/upstream';
import {PersonalTasks} from '../server/management/tasks';
import {TaskMetricsReader} from '../server/management/task-metrics';
import {taskCollaborationPort} from '../src/personal/collaboration';
import {writableAdoptionEffects,mergeWritableProjection,type WritableRecord} from '../../codeagent-desktop/packages/protocol/src/writable-collaboration';
const record=(kind:string,id:string,group='g')=>({schemaVersion:'writable-collaboration-record/1',kind,entityId:id,groupId:group,revision:'9007199254740993',state:'READY'});
function source(){
  const calls:{path:string;method:string;body:any}[]=[],groups=new Map<string,any>();let lose=false,foreign=false,wrongReply=false;
  const fetchImpl:typeof fetch=async(url,init)=>{
    const path=new URL(String(url)).pathname,method=init?.method??'GET',body=init?.body?JSON.parse(String(init.body)):undefined;calls.push({path,method,body});
    const json=(data:any,status=200)=>new Response(JSON.stringify(data),{status,headers:{'content-type':'application/json'}});
    if(path==='/api/v2/sessions/s')return json({sessionId:'s',sessionVersion:2,activeRunId:'r'});
    if(path==='/api/v2/runs/r')return json({runId:'r',sessionId:foreign?'other':'s',taskId:'source-task',state:'RUNNING',stateVersion:2,availableActions:['STOP'],changedFileCount:0});
    if(path.endsWith('/foundation'))return json({sessionId:'s',capabilities:{'run.writableCollaborationV1':'READY'}});
    if(path.endsWith('/execution-segments'))return json({current:{executionEpoch:'1'}});
    const base='/api/v2/runs/r/collaboration-groups';
    if(path===base&&method==='POST'){
      const row={...record('GROUP',body.requestId,'index'),graph:body.graph,children:[],candidates:[],selections:[],previews:[],adoptions:[]};groups.set(body.requestId,row);
      if(lose){lose=false;throw new Error('reply lost after commit');}return json(wrongReply?{...row,entityId:'another-request'}:row,202);
    }
    if(path===base)return json({items:[...groups.values()]});
    if(path.startsWith(base+'/')){
      const parts=path.slice(base.length+1).split('/'),group=groups.get(parts[0]!);if(!group)return json({code:'NOT_FOUND',message:'not found'},404);
      if(parts.length===1)return json(group);
      if(parts[1]==='adoptions'&&method==='POST'){const value={...record('ADOPTION',body.adoptionId,parts[0]),state:'WAITING_BOUNDARY',contentApplied:false};group.adoptions.push(value);if(lose){lose=false;throw new Error('adopt reply lost');}return json(value,202);}
      if(parts[1]==='candidates')return json(record('CANDIDATE',parts[2]!,parts[0]));
    }
    return json({code:'NOT_FOUND'},404);
  };
  return {fetchImpl,calls,groups,lose:()=>{lose=true;},foreign:()=>{foreign=true;},wrongReply:()=>{wrongReply=true;}};
}
function fixture(path=':memory:',up=source()){
  const store=new ManagementStore({path}),hub=new ConnectionHub(store,()=>crypto.randomUUID(),up.fetchImpl);
  hub.provision([{connectionId:'acs',kind:'ACS_DIRECT',baseUrl:'http://127.0.0.1:7777',tokenRef:'memory'}]);
  if(!store.getTask('t')){store.upsertTask({taskId:'t'});store.ledgerBegin({requestKey:'launch',route:'TASK_CREATE',bodyDigest:'test',subjectId:'t'});store.saveLaunch('t','launch',{request:{requestKey:'launch',projectId:'p',instruction:'do'},connectionId:'acs',storeId:'store',create:{},session:{sessionId:'s',sessionVersion:1},runId:'r',acceptance:{messageId:'m',clientMessageId:'m',taskId:'source-task',runId:'r'}});}
  const tasks=new PersonalTasks(store,hub,'test',new TaskMetricsReader()),ctx={requestId:'test',acsSessionFor:async()=>({clientSessionId:'c',token:crypto.randomUUID(),storeId:'store'})};
  return {store,tasks,ctx,up,api:tasks.collaboration};
}
const create=(key='g')=>({requestKey:key,targetRunId:'r',operation:{action:'CREATE',body:{schemaVersion:'collaboration-group-create/1',requestId:key,expectedExecutionEpoch:'1',graph:{schemaVersion:'collaboration-graph/1',samePathMode:'REJECT',requestedParallelism:1,units:[{unitId:'u',kind:'WRITE_CANDIDATE',objective:'edit',readScope:['x.txt'],writeScope:['x.txt'],dependsOn:[],required:true,allowNoChanges:false}]}}}});
const data=(value:any)=>value.body.data;
describe('task-bound writable collaboration',()=>{
  it('does not bind a different source receipt to the frozen request and recovers only its own entity',async()=>{
    const f=fixture();try{f.up.wrongReply();await f.api.create('t',create(),f.ctx);await f.api.idle();const row=f.store.db.prepare('SELECT facts_json FROM personal_collaboration_requests').get() as {facts_json:string};expect(JSON.parse(row.facts_json).reply).toBeUndefined();const own=data(await f.api.request('t','g',f.ctx));expect(own.observation.entityId).toBe('g');expect(f.up.calls.filter(c=>c.method==='POST')).toHaveLength(1);}finally{f.store.close();}
  });
  it('keeps partial effects and failed validation separate from committed main context',()=>{
    expect(writableAdoptionEffects({...record('ADOPTION','a'),state:'WAITING_BOUNDARY',effectState:'NOT_APPLIED',verificationPassed:false,contextCommitted:false} as WritableRecord)).toEqual({file:'未应用',verification:'未运行',context:'尚未提交'});
    expect(writableAdoptionEffects({...record('ADOPTION','a'),state:'RECONCILIATION_REQUIRED',contentApplied:true,verificationPassed:false,contextCommitted:false} as WritableRecord)).toEqual({file:'已写入',verification:'失败',context:'未证明提交'});
    expect(writableAdoptionEffects({...record('ADOPTION','a'),state:'UNKNOWN',effectState:'PARTIAL'} as WritableRecord).file).toBe('部分写入');
  });
  it('does not revive a cancelled child with a delayed older observation, and merges budget dimensions independently',()=>{
    const old={...record('GROUP','g','index'),revision:'5',children:[{...record('CHILD','child'),revision:'12',state:'CANCELLED'}],sharedBudget:{LOGICAL_CALL:{revision:'9',spent:'3'},EDIT_ATTEMPT:{revision:'3',spent:'1'}}} as unknown as WritableRecord;
    const incoming={...old,revision:'6',children:[{...record('CHILD','child'),revision:'11',state:'RUNNING'}],sharedBudget:{LOGICAL_CALL:{revision:'8',spent:'2'},EDIT_ATTEMPT:{revision:'4',spent:'2'}}} as unknown as WritableRecord;
    const merged=mergeWritableProjection(old,incoming);expect(merged.children?.[0]?.state).toBe('CANCELLED');expect(merged.sharedBudget?.LOGICAL_CALL?.spent).toBe('3');expect(merged.sharedBudget?.EDIT_ATTEMPT?.spent).toBe('2');
  });
  it('freezes once before dispatch and same-key concurrent submissions never duplicate POST',async()=>{
    const f=fixture();try{await Promise.all([f.api.create('t',create(),f.ctx),f.api.create('t',create(),f.ctx)]);await f.api.idle();expect(f.up.calls.filter(c=>c.method==='POST')).toHaveLength(1);expect(data(await f.api.request('t','g',f.ctx)).observation.entityId).toBe('g');
      await expect(f.api.create('t',{...create(),operation:{...create().operation,body:{...create().operation.body,expectedExecutionEpoch:'2'}}},f.ctx)).rejects.toMatchObject({code:'IDEMPOTENCY_CONFLICT'});
    }finally{f.store.close();}
  });
  it('recovers committed CREATE after reply loss and restart exclusively through GET',async()=>{
    const path=join(mkdtempSync(join(tmpdir(),'pcc-journal-')),'db');const f=fixture(path);f.up.lose();await f.api.create('t',create(),f.ctx);await f.api.idle();f.store.close();const next=fixture(path,f.up);
    try{const before=f.up.calls.filter(c=>c.method==='POST').length;const view=data(await next.api.request('t','g',next.ctx));expect(view.observation.entityId).toBe('g');expect(view.state).toBe('OBSERVED');await next.api.create('t',create(),next.ctx);expect(f.up.calls.filter(c=>c.method==='POST')).toHaveLength(before);}finally{next.store.close();}
  });
  it('recovers the original ADOPTION identity, preserving independent file, verification and context facts',async()=>{
    const f=fixture();try{await f.api.create('t',create(),f.ctx);await f.api.idle();const group=f.up.groups.get('g');group.previews.push(record('PREVIEW','preview'));group.selections.push(record('SELECTION','selection'));f.up.lose();
      const input={requestKey:'adopt',targetRunId:'r',operation:{action:'ADOPT',groupId:'g',body:{schemaVersion:'collaboration-adoption/1',adoptionId:'adopt',expectedRunStateVersion:'9007199254740993',expectedExecutionEpoch:'1',selectionId:'selection',selectionFingerprint:'selection-fingerprint',previewId:'preview',previewFingerprint:'preview-fingerprint',mode:'STRICT'}}};
      await f.api.create('t',input,f.ctx);await f.api.idle();group.adoptions[0]={...group.adoptions[0],state:'RECONCILIATION_REQUIRED',contentApplied:true,verificationPassed:false,contextCommitted:false};
      const before=f.up.calls.filter(c=>c.method==='POST').length;const observed=data(await f.api.request('t','adopt',f.ctx)).observation;
      expect(observed).toMatchObject({entityId:'adopt',contentApplied:true,verificationPassed:false,contextCommitted:false});await f.api.request('t','adopt',f.ctx);expect(f.up.calls.filter(c=>c.method==='POST')).toHaveLength(before);
    }finally{f.store.close();}
  });
  it('rejects foreign Run and nested resource before source dispatch',async()=>{
    const f=fixture();try{await f.api.create('t',create(),f.ctx);await f.api.idle();await expect(f.api.read('t',['resources','CANDIDATE','foreign'],new URLSearchParams({groupId:'g'}),f.ctx)).rejects.toMatchObject({code:'COLLABORATION_RESOURCE_NOT_FOUND'});expect(f.up.calls.some(c=>c.path.endsWith('/candidates/foreign'))).toBe(false);f.up.foreign();await expect(f.api.read('t',[],new URLSearchParams(),f.ctx)).rejects.toMatchObject({code:'RUN_BINDING_MISMATCH'});}finally{f.store.close();}
  });
  it('rejects source URL/body injection, key mismatch, path traversal and unbounded file reads',async()=>{
    const f=fixture();try{await expect(f.api.create('t',{...create(),url:'http://foreign'},f.ctx)).rejects.toBeTruthy();await expect(f.api.create('t',{...create(),operation:{...create().operation,runId:'other'}},f.ctx)).rejects.toBeTruthy();await expect(f.api.create('t',{...create(),requestKey:'different'},f.ctx)).rejects.toBeTruthy();
      for(const path of ['../x.txt','C:/x.txt','a\\x.txt','a/../x.txt'])await expect(f.api.read('t',['files'],new URLSearchParams({kind:'CANDIDATE_FILES',groupId:'g',entityId:'c',path}),f.ctx)).rejects.toBeTruthy();
      await expect(f.api.read('t',['files'],new URLSearchParams({kind:'CANDIDATE_FILES',groupId:'g',entityId:'c',limit:'65537'}),f.ctx)).rejects.toBeTruthy();expect(f.up.calls.filter(c=>c.method==='POST')).toHaveLength(0);
    }finally{f.store.close();}
  });
  it('checks original store on request lookup and never substitutes current source',async()=>{
    const f=fixture();try{await f.api.create('t',create(),f.ctx);await f.api.idle();await expect(f.api.request('t','g',{...f.ctx,acsSessionFor:async()=>({clientSessionId:'c',token:'fixture',storeId:'replacement'})})).rejects.toMatchObject({code:'SOURCE_IDENTITY_CHANGED'});}finally{f.store.close();}
  });
  it('maps typed operations only to fixed owner routes with no source Run injection',async()=>{
    const calls:any[]=[];const fetchImpl:typeof fetch=async(url,init)=>{calls.push({path:String(url),method:init?.method,body:init?.body?JSON.parse(String(init.body)):undefined});return new Response(JSON.stringify({data:{source:{items:[]}},meta:{source:'test'}}),{status:200});};const port=taskCollaborationPort('t',fetchImpl);
    await port.operation({...create().operation,runId:'r',key:'g'} as any);expect(calls[0]).toMatchObject({path:'/api/personal/v1/tasks/t/collaboration/operations',method:'POST',body:create()});
    await port.operation({action:'PREVIEW_FILES',runId:'r',groupId:'g',entityId:'p',side:'CURRENT',path:'a b.txt',limit:'20'});expect(calls[1].method).toBe('GET');expect(calls[1].path).toContain('/files?runId=r&kind=PREVIEW_FILES&groupId=g&entityId=p');expect(calls[1].path).toContain('path=a+b.txt');
  });
});
