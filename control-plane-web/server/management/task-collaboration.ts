import {validWritableOperation, WRITABLE_ROUTES, type WritableOperation, type WritableRecord} from '../../../codeagent-desktop/packages/protocol/src/writable-collaboration';
import {ServiceProblem} from '../../../codeagent-desktop/packages/service-client/src/index';
import {canonicalDigest} from './canonical';
import {ManagementError, invalid} from './errors';
import type {ManagementStore} from './registry-store';
import type {PersonalTasks} from './tasks';
import type {GatewayCallContext} from './service';

interface Binding {connectionId:string;storeId:string;sessionId:string;runId:string}
interface Facts {dispatchStartedAt?:string;reply?:WritableRecord;observation?:WritableRecord;sourceError?:{code:string;message:string;status?:number};readError?:{code:string;message:string};rejected?:boolean}
interface Row {request_key:string;task_id:string;request_json:string;binding_json:string;facts_json:string;created_at:string}
const fail=(code:string,message:string,status=409):never=>{throw new ManagementError(status,code,message,false);};
const resourceActions=['EXECUTION','CANDIDATE','ADOPTION','REVIEW_RESULT'] as const;
/** A request journal, never a second graph/candidate authority. All GET paths are read only. */
export class PersonalTaskCollaboration {
  private jobs=new Map<string,Promise<void>>();
  private reads=new Map<string,Promise<{status:number;body:unknown}>>();
  constructor(private store:ManagementStore,private tasks:PersonalTasks){}
  private row(key:string){return this.store.db.prepare('SELECT * FROM personal_collaboration_requests WHERE request_key=?').get(key) as unknown as Row|undefined;}
  private facts(row:Row):Facts{return JSON.parse(this.row(row.request_key)!.facts_json);}
  private save(row:Row,facts:Facts){this.store.db.prepare('UPDATE personal_collaboration_requests SET facts_json=? WHERE request_key=?').run(JSON.stringify(facts),row.request_key);}
  private view(row:Row){const f=this.facts(row);return {requestKey:row.request_key,taskId:row.task_id,operation:JSON.parse(row.request_json),binding:JSON.parse(row.binding_json),createdAt:row.created_at,...f,pending:this.jobs.has(row.request_key),state:f.rejected?'REJECTED':f.reply||f.observation?'OBSERVED':'UNKNOWN'};}
  private async bound(taskId:string,ctx:GatewayCallContext,runId?:string){
    const f=this.tasks.facts(this.tasks.row(taskId));if(!f?.session)return fail('SESSION_UNBOUND','任务尚未绑定会话');
    const {client}=await this.tasks.client(f.connectionId,ctx,f.storeId),selected=await this.tasks.selectRun(f,ctx,runId);
    if(!selected.run)return fail('RUN_UNBOUND','任务尚未绑定运行');
    return {client,b:{connectionId:f.connectionId,storeId:f.storeId,sessionId:f.session.sessionId,runId:selected.run.runId} satisfies Binding};
  }
  private async client(row:Row,ctx:GatewayCallContext){
    const b=JSON.parse(row.binding_json) as Binding,f=this.tasks.facts(this.tasks.row(row.task_id));
    if(!f?.session||f.connectionId!==b.connectionId||f.storeId!==b.storeId||f.session.sessionId!==b.sessionId)return fail('SOURCE_IDENTITY_CHANGED','原协作来源已变化');
    const {client}=await this.tasks.client(b.connectionId,ctx,b.storeId),run=await client.getRun(b.runId);
    if(run.sessionId!==b.sessionId)return fail('RUN_BINDING_MISMATCH','原运行不属于此任务',403);return client;
  }
  private record(value:unknown,runId:string,groupId?:string):WritableRecord{
    const v=value as WritableRecord;
    if(!v||typeof v.entityId!=='string'||!/^\d+$/.test(v.revision)||('runId' in v&&v.runId!==runId)||groupId&&v.groupId!==groupId)return fail('COLLABORATION_BINDING_MISMATCH','协作源实体归属不一致',502);
    return v;
  }
  private operationRecord(operation:WritableOperation,value:unknown):WritableRecord{
    const kind=({CREATE:'GROUP',GROUP:'GROUP',CANCEL_GROUP:'GROUP',AUTHORIZE:'GRANT',START:'CHILD',EXECUTION:'CHILD',CANCEL_EXECUTION:'CHILD',REWORK:'CHILD',SELECT:'SELECTION',PREVIEW:'PREVIEW',REVISE:'PREVIEW',REVIEW:'REVIEW',REVIEW_RESULT:'REVIEW',CANDIDATE:'CANDIDATE',ADOPT:'ADOPTION',ADOPTION:'ADOPTION',CANCEL_ADOPTION:'ADOPTION',RECOVER_ADOPTION:'ADOPTION',REPAIR:'REPAIR',RECOVER_REPAIR:'REPAIR'} as Record<string,string>)[operation.action];
    const targetActions=['EXECUTION','CANDIDATE','ADOPTION','REVIEW_RESULT','CANCEL_EXECUTION','CANCEL_ADOPTION','RECOVER_ADOPTION','RECOVER_REPAIR'];
    const entity=operation.action==='GROUP'||operation.action==='CANCEL_GROUP'?'groupId' in operation?operation.groupId:undefined:targetActions.includes(operation.action)?'entityId' in operation?operation.entityId:undefined:'key' in operation?operation.key:undefined;
    const record=this.record(value,operation.runId,kind!=='GROUP'&&'groupId' in operation?operation.groupId:undefined);
    if(record.kind!==kind||record.entityId!==entity)return fail('COLLABORATION_RECEIPT_MISMATCH','源回复不属于原协作动作和实体',502);return record;
  }
  /** Source group membership is checked before nested operations, including file reads. */
  private async group(client:Awaited<ReturnType<PersonalTaskCollaboration['client']>>,runId:string,groupId:string){
    const value=this.record(await client.writableCollaboration({action:'GROUP',runId,groupId}),runId);
    if(value.entityId!==groupId||value.kind!=='GROUP')return fail('COLLABORATION_BINDING_MISMATCH','协作组不属于此运行',403);return value;
  }
  private async member(client:Awaited<ReturnType<PersonalTaskCollaboration['client']>>,operation:WritableOperation){
    if(!('groupId' in operation))return;
    const group=await this.group(client,operation.runId,operation.groupId);
    if(!('entityId' in operation))return;
    const field=({EXECUTION:'children',CANCEL_EXECUTION:'children',REWORK:'children',CANDIDATE:'candidates',CANDIDATE_FILES:'candidates',PREVIEW:'selections',PREVIEW_FILES:'previews',REVISE:'previews',REVIEW:'previews',REVIEW_RESULT:'reviews',ADOPTION:'adoptions',REPAIR:'adoptions',CANCEL_ADOPTION:'adoptions',RECOVER_ADOPTION:'adoptions',RECOVER_REPAIR:'repairs'} as Record<string,string>)[operation.action];
    const rows=(group as unknown as Record<string,unknown>)[field!];
    if(!Array.isArray(rows)||!rows.some(r=>r?.entityId===operation.entityId&&r?.groupId===operation.groupId&&(!('runId' in r)||r.runId===operation.runId)))return fail('COLLABORATION_RESOURCE_NOT_FOUND','资源不属于此协作组或不在当前有界索引内',403);
  }
  async read(taskId:string,tail:string[],query:URLSearchParams,ctx:GatewayCallContext){
    if(tail.length===5&&tail[0]==='groups'&&tail[2]==='executions'&&tail[4]==='messages'){
      if([...query.keys()].some(k=>k!=='runId'))return invalid();
      const {client,b}=await this.bound(taskId,ctx,query.get('runId')??undefined),op={action:'EXECUTION',runId:b.runId,groupId:tail[1],entityId:tail[3]};
      if(!validWritableOperation(op))return invalid();await this.member(client,op);
      const execution=this.record(await client.writableCollaboration(op),b.runId,tail[1]);
      if(!execution.sessionId)return fail('CHILD_SESSION_UNAVAILABLE','源子会话尚未建立');
      const session=await client.getSession(execution.sessionId);
      if(session.parentSessionId!==b.sessionId||!['AUXILIARY_READ_ONLY','DELEGATED_WRITE_CANDIDATE'].includes(session.sessionPurpose??''))return fail('COLLABORATION_BINDING_MISMATCH','子会话不属于原父会话',403);
      const page=await client.pageSessionMessages(execution.sessionId,{limit:20});
      if(page.sessionId!==execution.sessionId)return fail('COLLABORATION_BINDING_MISMATCH','子历史所属不一致',403);
      return {status:200,body:this.tasks.envelope({sessionId:page.sessionId,messages:page.items.filter(m=>[execution.objectiveMessageId,execution.resultMessageId].includes(m.id)),hasOlder:page.hasOlder,rangeComplete:page.rangeComplete})};
    }
    const allowed=['runId'];let partial:Record<string,unknown>;
    if(!tail.length)partial={action:'LIST'};
    else if(tail.length===1&&tail[0]==='activity')partial={action:'ACTIVITY'};
    else if(tail[0]==='groups'&&tail[1]&&tail.length<=3){partial={action:tail.length===2?'GROUP':tail[2]==='executions'?'EXECUTIONS':tail[2]==='adoptions'?'ADOPTIONS':'INVALID',groupId:tail[1]};}
    else if(tail[0]==='resources'&&tail.length===3&&resourceActions.includes(tail[1] as typeof resourceActions[number])){allowed.push('groupId');partial={action:tail[1],groupId:query.get('groupId'),entityId:tail[2]};}
    else if(tail[0]==='files'&&tail.length===1){allowed.push('kind','groupId','entityId','side','unitId','path','offset','limit');partial=Object.fromEntries([...query].filter(([k])=>k!=='runId'&&k!=='kind'));partial.action=query.get('kind');}
    else return invalid();
    if([...query.keys()].some(k=>!allowed.includes(k)))return invalid();
    const {client,b}=await this.bound(taskId,ctx,query.get('runId')??undefined),operation={...partial,runId:b.runId};
    if(!validWritableOperation(operation)||WRITABLE_ROUTES[operation.action].method!=='GET')return invalid();
    await this.member(client,operation);
    const result=await client.writableCollaboration(operation);
    if(['GROUP','EXECUTION','CANDIDATE','ADOPTION','REVIEW_RESULT'].includes(operation.action))this.operationRecord(operation,result);
    if(operation.action==='LIST'){
      const [foundation,segments]=await Promise.all([client.collaboration({action:'FOUNDATION',subjectId:b.sessionId}),client.collaboration({action:'SEGMENTS',subjectId:b.runId})]);
      const requests=(this.store.db.prepare('SELECT * FROM personal_collaboration_requests WHERE task_id=? ORDER BY created_at DESC LIMIT 50').all(taskId) as unknown as Row[]).filter(r=>(JSON.parse(r.binding_json) as Binding).runId===b.runId).map(r=>this.view(r));
      return {status:200,body:this.tasks.envelope({source:result,foundation,segments,binding:b,requests,requestCoverage:'LATEST_50'})};
    }
    return {status:200,body:this.tasks.envelope(result)};
  }
  async create(taskId:string,input:unknown,ctx:GatewayCallContext){
    if(!input||typeof input!=='object'||Array.isArray(input))return invalid();
    const body=input as Record<string,unknown>;
    if(Object.keys(body).sort().join(',')!=='operation,requestKey,targetRunId'||!body.operation||typeof body.operation!=='object'||Array.isArray(body.operation)||'runId' in body.operation||'key' in body.operation)return invalid();
    const operation={...body.operation,runId:body.targetRunId,key:body.requestKey};
    if(!validWritableOperation(operation)||!('key' in operation)||WRITABLE_ROUTES[operation.action].method!=='POST')return invalid();
    const key=operation.key!,digest=canonicalDigest(input),ledger=this.store.ledgerGet(key);
    if(ledger&&(ledger.route!=='TASK_COLLABORATION_CREATE'||ledger.subjectId!==taskId||ledger.bodyDigest!==digest))return fail('IDEMPOTENCY_CONFLICT','原协作请求目标和载荷已冻结');
    let row=this.row(key);
    if(!row){
      const {client,b}=await this.bound(taskId,ctx,operation.runId);await this.member(client,operation);
      this.store.transact(()=>{
        const previous=this.store.ledgerGet(key);if(previous){if(previous.route!=='TASK_COLLABORATION_CREATE'||previous.subjectId!==taskId||previous.bodyDigest!==digest)return fail('IDEMPOTENCY_CONFLICT','原协作请求已冻结');return;}
        this.store.ledgerBegin({requestKey:key,route:'TASK_COLLABORATION_CREATE',subjectId:taskId,bodyDigest:digest});
        this.store.db.prepare('INSERT INTO personal_collaboration_requests VALUES(?,?,?,?,?,?)').run(key,taskId,JSON.stringify(operation),JSON.stringify(b),'{}',this.store.now());
      });row=this.row(key)!;
    }
    await this.client(row,ctx);
    // Even explicit same-key replay observes an already dispatched request. No implicit POST retry.
    if(!this.facts(row).dispatchStartedAt&&!this.jobs.has(key)){
      const frozen=row;this.save(row,{dispatchStartedAt:this.store.now()});
      const work=(async()=>{try{const client=await this.client(frozen,ctx),wire=JSON.parse(frozen.request_json) as WritableOperation,reply=this.operationRecord(wire,await client.writableCollaboration(wire));this.save(frozen,{...this.facts(frozen),reply});}
        catch(error){const f=this.facts(frozen);f.sourceError={code:error instanceof ServiceProblem?error.code:'SOURCE_REPLY_UNCONFIRMED',message:error instanceof ServiceProblem?error.message:'源回复尚未确认，保留原请求',status:error instanceof ServiceProblem?error.status:undefined};
          f.rejected=error instanceof ServiceProblem&&[400,403,404,409,410,428].includes(error.status)&&['COLLABORATION_SCOPE_DENIED','INVALID_REQUEST','CAPABILITY_UNAVAILABLE','COLLABORATION_AUTHORITY_UNPROVEN','COLLABORATION_REVISION_CONFLICT','COLLABORATION_CANDIDATE_CHANGED','COLLABORATION_PREVIEW_CHANGED','SELECTION_NOT_DEPENDENCY_CLOSED','EXECUTION_EPOCH_CONFLICT','CHILD_PARENT_STOPPED'].includes(error.code);this.save(frozen,f);}
      })().finally(()=>this.jobs.delete(key));this.jobs.set(key,work);
    }
    return {status:202,body:this.tasks.envelope(this.view(row))};
  }
  async request(taskId:string,key:string,ctx:GatewayCallContext):Promise<{status:number;body:unknown}>{
    const row=this.row(key);if(!row||row.task_id!==taskId)return fail('REQUEST_NOT_FOUND','原协作请求不存在',404);
    const client=await this.client(row,ctx);
    const inFlight=this.reads.get(key);if(inFlight)return inFlight;
    const work=(async()=>{
      const op=JSON.parse(row.request_json) as WritableOperation;
      try{
        let observed:WritableRecord|undefined;
        if(op.action==='CREATE')observed=await this.group(client,op.runId,key);
        else if('groupId' in op){
          const group=await this.group(client,op.runId,op.groupId);
          const field=({AUTHORIZE:'authorization',START:'children',SELECT:'selections',PREVIEW:'previews',REVISE:'previews',REVIEW:'reviews',ADOPT:'adoptions',REPAIR:'repairs',REWORK:'children',CANCEL_EXECUTION:'children',CANCEL_ADOPTION:'adoptions',RECOVER_ADOPTION:'adoptions',RECOVER_REPAIR:'repairs'} as Record<string,string>)[op.action];
          const target=['CANCEL_EXECUTION','CANCEL_ADOPTION','RECOVER_ADOPTION','RECOVER_REPAIR'].includes(op.action)&&'entityId' in op?op.entityId:key;
          if(op.action==='CANCEL_GROUP')observed=group;
          else{const value=(group as unknown as Record<string,unknown>)[field!];observed=(Array.isArray(value)?value.find(r=>r?.entityId===target):value&&typeof value==='object'&&(value as WritableRecord).entityId===target?value:undefined) as WritableRecord|undefined;}
        }
        if(observed){this.operationRecord(op,observed);this.save(row,{...this.facts(row),observation:observed});}
      }catch(error){const f=this.facts(row);f.readError={code:error instanceof ServiceProblem?error.code:'SOURCE_READ_UNCONFIRMED',message:error instanceof ServiceProblem?error.message:'无法核对原协作资源'};this.save(row,f);}
      return {status:200,body:this.tasks.envelope(this.view(row))};
    })().finally(()=>this.reads.delete(key));this.reads.set(key,work);return work;
  }
  async idle(){await Promise.allSettled([...this.jobs.values()]);}
}
