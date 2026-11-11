import {createHash} from 'node:crypto';
import {validTaskEngagement, type TaskEngagementRequest, type TaskEngagementView} from '../../../codeagent-desktop/packages/protocol/src/personal-interaction';
import type {CollaborationOperation, CollaborationResource, AssignmentTransitionRequest, AuxiliaryTurnRequest} from '../../../codeagent-desktop/packages/protocol/src/collaboration';
import {ServiceProblem, type ServiceClient} from '../../../codeagent-desktop/packages/service-client/src/index';
import {canonicalDigest} from './canonical';
import {ManagementError, invalid} from './errors';
import type {ManagementStore} from './registry-store';
import type {PersonalTasks} from './tasks';
import type {GatewayCallContext} from './service';
interface Binding {connectionId:string; storeId:string; sessionId:string; runId:string}
interface Facts {steps:Record<string,{wire?:CollaborationOperation; dispatchStartedAt?:string; reply?:CollaborationResource}>; result?:CollaborationResource; sourceError?:{code:string;message:string}; sourceRejection?:{code:string;message:string}; wire?:AssignmentTransitionRequest}
interface Row {request_key:string; task_id:string;kind:string;request_json:string;binding_json:string;facts_json:string;created_at:string}
const child = (key:string, stage:string) => createHash('sha256').update(key+':'+stage).digest('hex');
const field = (v:CollaborationResource|undefined,k:string) => typeof v?.[k]==='string' ? v[k] as string : '';
const fail = (code:string,message:string,status=409):never=>{throw new ManagementError(status,code,message,false);};
export class PersonalTaskEngagements {
  private jobs = new Map<string,Promise<void>>();
  private reads = new Map<string,Promise<{status:number;body:unknown}>>();
  constructor(private store:ManagementStore,private tasks:PersonalTasks) {}
  private row(key:string) {return this.store.db.prepare('SELECT * FROM personal_engagement_requests WHERE request_key=?').get(key) as unknown as Row|undefined;}
  private facts(row:Row):Facts {return JSON.parse(this.row(row.request_key)!.facts_json);}
  private save(row:Row,facts:Facts) {this.store.db.prepare('UPDATE personal_engagement_requests SET facts_json=? WHERE request_key=?').run(JSON.stringify(facts),row.request_key);}
  private view(row:Row):TaskEngagementView {
    const f=this.facts(row),b=JSON.parse(row.binding_json) as Binding;return {taskId:row.task_id,request:JSON.parse(row.request_json),binding:{sessionId:b.sessionId,storeId:b.storeId,runId:b.runId},createdAt:row.created_at,
      result:f.result,steps:Object.fromEntries(Object.entries(f.steps).flatMap(([k,v])=>v.reply ? [[k,v.reply]]:[])),sourceError:f.sourceError,sourceRejection:f.sourceRejection};
  }
  private async client(row:Row,ctx:GatewayCallContext) {
    const b=JSON.parse(row.binding_json) as Binding, f=this.tasks.facts(this.tasks.row(row.task_id));
    if (!f?.session || f.connectionId!==b.connectionId || f.storeId!==b.storeId || f.session.sessionId!==b.sessionId) return fail('SOURCE_IDENTITY_CHANGED','原请求来源已变化');
    return (await this.tasks.client(b.connectionId,ctx,b.storeId)).client;
  }
  private async bound(taskId:string,ctx:GatewayCallContext,runId?:string) {
    const f=this.tasks.facts(this.tasks.row(taskId));if(!f?.session) return fail('SESSION_UNBOUND','任务尚未绑定会话');
    const {client}=await this.tasks.client(f.connectionId,ctx,f.storeId);
    const selected=await this.tasks.selectRun(f,ctx,runId);
    return {client,f,run:selected.run,b:{connectionId:f.connectionId,storeId:f.storeId,sessionId:f.session.sessionId,runId:selected.run?.runId ?? ''}};
  }
  async catalog(taskId:string,ctx:GatewayCallContext) {
    const f=this.tasks.facts(this.tasks.row(taskId));if(!f?.session) return fail('SESSION_UNBOUND','任务尚未绑定会话');
    const {client}=await this.tasks.client(f.connectionId,ctx,f.storeId);
    const [profiles,models]=await Promise.all([client.listAgentProfiles(),client.getModelCatalog()]);
    return {status:200,body:this.tasks.envelope({profiles,models})};
  }
  async read(taskId:string,query:URLSearchParams,ctx:GatewayCallContext) {
    if([...query.keys()].some(k=>!['runId','cursor','limit'].includes(k))) return invalid();
    const limit=Number(query.get('limit')??30);if(!Number.isInteger(limit)||limit<1||limit>100)return invalid();
    let cursor:{createdAt:string;key:string}|undefined;
    if(query.has('cursor')){try{cursor=JSON.parse(Buffer.from(query.get('cursor')!,'base64url').toString('utf8'));}catch{return invalid();}
      if(!cursor||Object.keys(cursor).sort().join(',')!=='createdAt,key'||typeof cursor.createdAt!=='string'||!Number.isFinite(Date.parse(cursor.createdAt))||typeof cursor.key!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(cursor.key))return invalid();}

    const {client,b}=await this.bound(taskId,ctx,query.get('runId') ?? undefined);
    const calls:[string,Promise<unknown>][]=[['foundation',client.collaboration({action:'FOUNDATION',subjectId:b.sessionId})]];
    if(b.runId) calls.push(['segments',client.collaboration({action:'SEGMENTS',subjectId:b.runId})],['boundaries',client.collaboration({action:'BOUNDARIES',subjectId:b.runId})],['handoffs',client.collaboration({action:'HANDOFFS',subjectId:b.runId})]);
    const settled=await Promise.allSettled(calls.map(([,v])=>v));
    const data:Record<string,unknown>={runId:b.runId,sessionId:b.sessionId,sourceErrors:[]};
    settled.forEach((v,i)=>{if(v.status==='fulfilled') data[calls[i]![0]]=v.value;else (data.sourceErrors as string[]).push(calls[i]![0]);});
    const local=this.store.db.prepare(`SELECT * FROM (
      SELECT request_key,kind,created_at FROM personal_engagement_requests WHERE task_id=?
      UNION ALL SELECT request_key,'MESSAGE' AS kind,created_at FROM personal_interaction_requests WHERE task_id=?
    ) WHERE (? IS NULL OR created_at < ? OR (created_at=? AND request_key < ?)) ORDER BY created_at DESC,request_key DESC LIMIT ?`)
      .all(taskId,taskId,cursor?.createdAt??null,cursor?.createdAt??null,cursor?.createdAt??null,cursor?.key??null,limit+1) as {request_key:string;kind:string;created_at:string}[];
    data.requests=local.slice(0,limit).filter(r=>r.kind!=='MESSAGE').map(r=>this.view(this.row(r.request_key)!));
    data.messageRequests=local.slice(0,limit).filter(r=>r.kind==='MESSAGE').map(r=>({requestKey:r.request_key,createdAt:r.created_at}));
    const tail=local[limit-1];data.nextCursor=local.length>limit&&tail?Buffer.from(JSON.stringify({createdAt:tail.created_at,key:tail.request_key})).toString('base64url'):null;
    data.sourceCoverage='BOUNDARIES_128_HANDOFFS_100_MAX';
    return {status:200,body:this.tasks.envelope(data)};
  }
  /** Legacy unified BUDGET DTO omits sessionId: resolve its source Run before projecting scope. */
  private async approvalFor(client:ServiceClient,sessionId:string,approvalId:string) {
    const value=await client.getApproval(approvalId);
    if(value.kind==='BUDGET'&&!value.sessionId){
      const run=await client.getRun(value.runId);
      if(run.sessionId!==sessionId)return fail('APPROVAL_BINDING_MISMATCH','预算审批不属于本会话',403);
      return {...value,sessionId:run.sessionId,requiresUserAction:value.decisionStatus==='PENDING'&&value.allowedActions.length>0};
    }
    if(value.sessionId!==sessionId)return fail('APPROVAL_BINDING_MISMATCH','审批不属于本会话',403);
    return value;
  }
  async approvals(taskId:string,query:URLSearchParams,ctx:GatewayCallContext,approvalId?:string) {
    if([...query.keys()].some(k=>!['cursor','limit'].includes(k)))return invalid();
    const limit=Number(query.get('limit')??30);if(!Number.isInteger(limit)||limit<1||limit>100|| (query.get('cursor')?.length??0)>1024)return invalid();
    const f=this.tasks.facts(this.tasks.row(taskId));if(!f?.session)return fail('SESSION_UNBOUND','任务尚未绑定会话');
    const {client}=await this.tasks.client(f.connectionId,ctx,f.storeId);
    if(approvalId){const value=await this.approvalFor(client,f.session.sessionId,approvalId);return {status:200,body:this.tasks.envelope(value)};}
    const page=await client.listApprovals(f.session.sessionId,{cursor:query.get('cursor')??undefined,limit});
    page.items=await Promise.all(page.items.map(v=>this.approvalFor(client,f.session!.sessionId,v.approvalId)));
    return {status:200,body:this.tasks.envelope(page)};
  }
  async create(taskId:string,body:unknown,ctx:GatewayCallContext):Promise<{status:number;body:unknown}> {
    if(!validTaskEngagement(body))return invalid();const request=body,key=request.requestKey,digest=canonicalDigest(request);
    const ledger=this.store.ledgerGet(key);
    if(ledger&&(ledger.route!=='TASK_ENGAGEMENT_CREATE'||ledger.subjectId!==taskId||ledger.bodyDigest!==digest))return fail('IDEMPOTENCY_CONFLICT','原交互已冻结，请保持原正文与目标');
    let row=this.row(key);
    if(!row){
      const {client,b,run}=await this.bound(taskId,ctx,request.targetRunId);if(!run)return fail('RUN_UNBOUND','未找到选中运行');
      if(this.row(key))return this.create(taskId,request,ctx);
      const steps:Facts['steps']={};
      if(request.kind==='SIDE_QUESTION'){
        const pending=this.store.db.prepare(`SELECT * FROM personal_engagement_requests WHERE task_id=? AND kind='SIDE_QUESTION'
          AND json_extract(facts_json,'$.sourceRejection') IS NULL AND (json_extract(facts_json,'$.result.state') IS NULL
          OR json_extract(facts_json,'$.result.state') IN ('QUEUED','RUNNING','CANCEL_REQUESTED')) ORDER BY created_at DESC LIMIT 1`).get(taskId) as unknown as Row|undefined;
        if(pending){await this.request(taskId,pending.request_key,ctx);const p=this.facts(pending);
          if(!p.sourceRejection&&(!p.result||['QUEUED','RUNNING','CANCEL_REQUESTED'].includes(String(p.result.state))))return fail('SIDE_QUESTION_PENDING','已有旁支请求待核对，请先查看原结果');}
        const existing=this.store.db.prepare(`SELECT * FROM personal_engagement_requests WHERE task_id=? AND kind='SIDE_QUESTION'
          AND json_extract(facts_json,'$.steps.auxiliary.reply.sessionId') IS NOT NULL ORDER BY created_at DESC LIMIT 1`).get(taskId) as unknown as Row|undefined;
        if(existing){const prior=JSON.parse(existing.binding_json) as Binding;
          if(prior.sessionId===b.sessionId&&prior.storeId===b.storeId&&prior.connectionId===b.connectionId){
            const old=this.facts(existing).steps.auxiliary?.reply;
            const source=await client.collaboration({action:'AUX_LIST',subjectId:b.sessionId});
            const matches=Array.isArray(source.items)?source.items as CollaborationResource[]:[];
            const verified=matches.find(a=>a.sessionId===old?.sessionId&&a.parentSessionId===b.sessionId&&a.state==='ACTIVE');
            if(verified)steps.auxiliary={reply:verified};
          }
        }
      }
      let wire:AssignmentTransitionRequest|undefined;
      if(request.kind==='PREFLIGHT')await this.checkTarget(client,request.source);
      if(request.kind==='HANDOFF'){
        const prior=this.row(request.preflightKey);
        if(!prior||prior.task_id!==taskId||prior.kind!=='PREFLIGHT'||canonicalDigest(JSON.parse(prior.binding_json))!==canonicalDigest(b))return fail('PREFLIGHT_REQUIRED','先检查当前运行的兼容性');
        const p=this.facts(prior).result, original=JSON.parse(prior.request_json) as Extract<TaskEngagementRequest,{kind:'PREFLIGHT'}>;
        if(!p?.preflightDigest||!p.sourceEpoch||!p.runStateVersion||!p.modelSettingsRevision)return fail('PREFLIGHT_REQUIRED','源预检尚未完成或未给出版本证明');
        await this.checkTarget(client,original.source);
        wire={...original.source,transitionId:key,expectedExecutionEpoch:String(p.sourceEpoch),expectedRunStateVersion:String(p.runStateVersion),expectedModelSettingsRevision:String(p.modelSettingsRevision),preflightDigest:String(p.preflightDigest)};
      }
      if(request.kind==='APPROVAL_DECISION'){
        const approval=await this.approvalFor(client,b.sessionId,request.approvalId);
        if(approval.sessionId!==b.sessionId||approval.runId!==b.runId)return fail('APPROVAL_BINDING_MISMATCH','审批不属于选中会话和运行',403);
        if(approval.version!==request.source.expectedVersion||approval.requestFingerprint!==(request.source.requestFingerprint??request.source.fingerprint))return fail('APPROVAL_VERSION_CONFLICT','审批版本或指纹已变化');
        if(!approval.allowedActions.includes(request.source.decision as 'APPROVE'))return fail('APPROVAL_ACTION_UNAVAILABLE','源端不支持此审批决定');
      }
      if(request.kind==='CANCEL_BOUNDARY'||request.kind==='CANCEL_HANDOFF') await this.object(client,b,request.kind==='CANCEL_BOUNDARY'?'BOUNDARY_RESULT':'HANDOFF_RESULT',request.resourceId);
      this.store.transact(()=>{
        const current=this.store.ledgerGet(key);
        if(current){if(current.route!=='TASK_ENGAGEMENT_CREATE'||current.subjectId!==taskId||current.bodyDigest!==digest)return fail('IDEMPOTENCY_CONFLICT','原请求已冻结');return;}
        if(request.kind==='SIDE_QUESTION'&&this.store.db.prepare(`SELECT 1 FROM personal_engagement_requests WHERE task_id=? AND kind='SIDE_QUESTION' AND json_extract(facts_json,'$.sourceRejection') IS NULL AND (json_extract(facts_json,'$.result.state') IS NULL OR json_extract(facts_json,'$.result.state') IN ('QUEUED','RUNNING','CANCEL_REQUESTED')) LIMIT 1`).get(taskId))return fail('SIDE_QUESTION_PENDING','已有旁支请求待核对');
        this.store.ledgerBegin({requestKey:key,route:'TASK_ENGAGEMENT_CREATE',bodyDigest:digest,subjectId:taskId});
        this.store.db.prepare('INSERT INTO personal_engagement_requests VALUES(?,?,?,?,?,?,?)').run(key,taskId,request.kind,JSON.stringify(request),JSON.stringify(b),JSON.stringify({steps,wire}),this.store.now());
      });row=this.row(key)!;
    }
    await this.client(row,ctx); // verify store even for an explicit replay
    if(!this.jobs.has(key)&&!this.facts(row).result){
      const frozen=row;
      const work=this.execute(frozen,ctx).catch(e=>{const f=this.facts(frozen);f.sourceError={code:e instanceof ManagementError||e instanceof ServiceProblem?e.code:'SOURCE_REPLY_UNCONFIRMED',message:e instanceof ManagementError||e instanceof ServiceProblem?e.message:'源回复未确认，按原请求核对'};
        if(e instanceof ServiceProblem&&e.status<500&&['EXECUTION_EPOCH_CONFLICT','PROFILE_CHANGED','PROFILE_INCOMPATIBLE','CAPABILITY_UNAVAILABLE','SESSION_VERSION_CONFLICT','AUXILIARY_BUDGET_EXHAUSTED','BOUNDARY_INPUT_PENDING','INVALID_REQUEST','HANDOFF_QUIESCENCE_UNPROVEN'].includes(e.code))f.sourceRejection={code:e.code,message:e.message};this.save(frozen,f);}).finally(()=>this.jobs.delete(key));
      this.jobs.set(key,work);
    }
    return {status:202,body:this.tasks.envelope(this.view(row))};
  }
  private async checkTarget(client:ServiceClient,request:AssignmentTransitionRequest){
    const [profiles,catalog]=await Promise.all([client.listAgentProfiles(),client.getModelCatalog()]);
    const t=request.target;if(!profiles.profiles.some(p=>p.id===t.agentProfileId&&p.revision===t.agentProfileRevision))return fail('PROFILE_UNAVAILABLE','目标画像版本已变化');
    if(t.modelSelection?.mode==='EXPLICIT'){
      const s=t.modelSelection.settings!,alias=s.modelAlias;
      if(!catalog.items.some(m=>m.configured&&m.availability==='AVAILABLE'&&(alias===m.providerId+'/'+m.modelAlias||alias===m.modelAlias&&s.providerId===m.providerId)))return fail('MODEL_UNAVAILABLE','请选择当前目录可用模型');
    }
  }
  private async step(row:Row,name:string,client:ServiceClient,operation:CollaborationOperation){
    let f=this.facts(row),s=f.steps[name];if(s?.reply)return s.reply;
    if(!s){s={wire:operation};f.steps[name]=s;this.save(row,f);}
    s.dispatchStartedAt=s.dispatchStartedAt??this.store.now();this.save(row,f);
    const reply=await client.collaboration(s.wire!);
    const op=s.wire!,binding=JSON.parse(row.binding_json) as Binding;
    if(op.action==='BOUNDARY'&&(reply.runId!==binding.runId||reply.requestId!==op.key)
      ||op.action==='HANDOFF'&&(reply.runId!==binding.runId||reply.transitionId!==op.key)
      ||op.action==='CREATE_AUX'&&(reply.parentSessionId!==binding.sessionId||!reply.sessionId)
      ||op.action==='TURN'&&(reply.sessionId!==op.subjectId||reply.turnId!==op.body.turnId)) return fail('RESOURCE_BINDING_MISMATCH','源回复不属于冻结交互',502);
    f=this.facts(row);f.steps[name]!.reply=reply;f.sourceError=undefined;this.save(row,f);return reply;
  }
  private async execute(row:Row,ctx:GatewayCallContext){
    const client=await this.client(row,ctx),r=JSON.parse(row.request_json) as TaskEngagementRequest,b=JSON.parse(row.binding_json) as Binding;
    const key=r.requestKey;let result:CollaborationResource;
    if(r.kind==='BOUNDARY')result=await this.step(row,'boundary',client,{action:'BOUNDARY',subjectId:b.runId,key,body:r.source});
    else if(r.kind==='PREFLIGHT')result=await this.step(row,'preflight',client,{action:'PREFLIGHT',subjectId:b.runId,body:r.source});
    else if(r.kind==='HANDOFF')result=await this.step(row,'handoff',client,{action:'HANDOFF',subjectId:b.runId,key,body:this.facts(row).wire!});
    else if(r.kind==='CANCEL_BOUNDARY'||r.kind==='CANCEL_HANDOFF')result=await this.step(row,'cancel',client,{action:r.kind,subjectId:b.runId,entityId:r.resourceId,key});
    else if(r.kind==='APPROVAL_DECISION'){
      const f=this.facts(row);f.steps.decision=f.steps.decision??{dispatchStartedAt:this.store.now()};this.save(row,f);
      result=await client.decideApproval(r.approvalId,r.source,key) as unknown as CollaborationResource;
    }else{
      const snapshot=await this.step(row,'snapshot',client,{action:'FREEZE_SNAPSHOT',subjectId:b.sessionId,key:child(key,'snapshot'),body:{}});
      if(snapshot.runId&&snapshot.runId!==b.runId)return fail('SNAPSHOT_BINDING_MISMATCH','快照绑定已变化，请核对本次请求');
      const packageKey=child(key,'package');
      const pack=await this.step(row,'package',client,{action:'CREATE_PACKAGE',subjectId:b.sessionId,key:packageKey,body:{schemaVersion:'context-package-request/1',requestId:packageKey,snapshotId:field(snapshot,'snapshotId'),profile:'RESEARCH'}});
      const auxKey=child(key,'auxiliary');
      const aux=await this.step(row,'auxiliary',client,{action:'CREATE_AUX',subjectId:b.sessionId,key:auxKey,body:{schemaVersion:'auxiliary-session-create/1',requestId:auxKey,purpose:'SIDECAR_QUESTION',basePackageId:field(pack,'packageId'),title:'任务旁支问答'}});
      const auxId=field(aux,'sessionId'),turnKey=child(key,'turn');
      const foundation=await client.collaboration({action:'FOUNDATION',subjectId:auxId});
      const turn:AuxiliaryTurnRequest={schemaVersion:'auxiliary-turn/1',turnId:turnKey,expectedSessionVersion:field(foundation,'sessionVersion'),packageId:field(pack,'packageId'),question:r.question,textOnlyResearch:r.textOnlyResearch??false,
        researchTasks:Array.from({length:r.researchCount??0},(_,i)=>({taskId:'research-'+(i+1),role:(['repo-explorer','test-impact-reviewer','risk-reviewer'] as const)[i]!,question:r.question}))};
      result=await this.step(row,'turn',client,{action:'TURN',subjectId:auxId,key:turnKey,body:turn});
    }
    const facts=this.facts(row);facts.result=result;facts.sourceError=undefined;facts.sourceRejection=undefined;this.save(row,facts);
  }
  private async object(client:ServiceClient,b:Binding,action:'BOUNDARY_RESULT'|'HANDOFF_RESULT',id:string){
    const value=await client.collaboration({action,subjectId:b.runId,entityId:id});
    if(value.runId!==b.runId||(action==='BOUNDARY_RESULT'?value.requestId:value.transitionId)!==id)return fail('RESOURCE_BINDING_MISMATCH','源对象不属于原运行和请求',403);return value;
  }
  async request(taskId:string,key:string,ctx:GatewayCallContext){
    const row=this.row(key);if(!row||row.task_id!==taskId)return fail('REQUEST_NOT_FOUND','原交互不存在',404);
    if(this.jobs.has(key)){await this.client(row,ctx);return {status:200,body:this.tasks.envelope(this.view(row))};}
    const read=this.reads.get(key);if(read)return read;
    const work=this.observeRequest(taskId,key,ctx);this.reads.set(key,work);
    try{return await work;}finally{this.reads.delete(key);}
  }
  private async observeRequest(taskId:string,key:string,ctx:GatewayCallContext){
    const row=this.row(key);if(!row||row.task_id!==taskId)return fail('REQUEST_NOT_FOUND','原交互不存在',404);
    const client=await this.client(row,ctx),b=JSON.parse(row.binding_json) as Binding,r=JSON.parse(row.request_json) as TaskEngagementRequest;
    try{
      let result:CollaborationResource|undefined;
      if(r.kind==='BOUNDARY')result=await this.object(client,b,'BOUNDARY_RESULT',key);
      else if(r.kind==='HANDOFF')result=await this.object(client,b,'HANDOFF_RESULT',key);
      else if(r.kind==='CANCEL_BOUNDARY'||r.kind==='CANCEL_HANDOFF')result=await this.object(client,b,r.kind==='CANCEL_BOUNDARY'?'BOUNDARY_RESULT':'HANDOFF_RESULT',r.resourceId);
      else if(r.kind==='SIDE_QUESTION'){
        const aux=this.facts(row).steps.auxiliary?.reply;
        if(aux){result=await client.collaboration({action:'TURN_RESULT',subjectId:field(aux,'sessionId'),entityId:child(key,'turn')});if(result.sessionId!==aux.sessionId||result.turnId!==child(key,'turn'))return fail('RESOURCE_BINDING_MISMATCH','旁支结果所属不一致',502);}
      }else if(r.kind==='APPROVAL_DECISION'){
        const approval=await this.approvalFor(client,b.sessionId,r.approvalId);if(approval.sessionId!==b.sessionId||approval.runId!==b.runId)return fail('APPROVAL_BINDING_MISMATCH','审批所属已变化',403);
        // An observation of approval state does not prove which command decided it.
        const f=this.facts(row);f.steps.approvalObservation={reply:approval as unknown as CollaborationResource};this.save(row,f);
      }
      if(result && r.kind==='BOUNDARY' && r.source.kind==='REQUEST_REPORT' && result.messageId) {
        const page=await client.pageSessionMessages(b.sessionId,{aroundMessageId:String(result.messageId),limit:10});
        if(page.sessionId!==b.sessionId)return fail('SESSION_BINDING_MISMATCH','汇报消息所属不一致');
        const message=page.items.find(m=>m.id===result!.messageId);
        if(message)result={...result,reportMessage:message};
      }
      if(result){const f=this.facts(row);f.result=result;f.sourceError=undefined;this.save(row,f);}
    }catch(e){const f=this.facts(row);f.sourceError={code:e instanceof ServiceProblem||e instanceof ManagementError?e.code:'SOURCE_REPLY_UNCONFIRMED',message:'源结果当前不可读；保留原请求，不重发'};this.save(row,f);}
    return {status:200,body:this.tasks.envelope(this.view(row))};
  }
  async resource(taskId:string,action:'BOUNDARY_RESULT'|'HANDOFF_RESULT',entityId:string,query:URLSearchParams,ctx:GatewayCallContext){
    if([...query.keys()].some(k=>k!=='runId'))return invalid();
    const {client,b}=await this.bound(taskId,ctx,query.get('runId')??undefined);
    return {status:200,body:this.tasks.envelope(await this.object(client,b,action,entityId))};
  }
  async idle(){await Promise.allSettled(this.jobs.values());}
}
