import {randomUUID} from 'node:crypto';
import type {AvailableProject, NativeTaskLaunchFacts, PersonalTaskCreate, PersonalTaskDetail, PersonalTaskIndex} from '../../../codeagent-desktop/packages/protocol/src/personal-task';
import {nativeTaskCore, supportedNativeEngine, supportedNativeProfile, validNativeInput, validNativePreflight, registeredGraphicsPreflight, validNativeGraphicsInput, NATIVE_MESSAGE_SCHEMA_VERSION, NATIVE_MESSAGE_TRANSPORT_VERSION, type NativeGraphicsInput, type NativeGraphicsRequestView, type NativeGraphicsObservation, type NativeBinding, type NativeInput, type NativePreflight, type NativeRequestView, type NativeTaskDetail} from '../../../codeagent-desktop/packages/protocol/src/native-task';
import {canonicalDigest} from './canonical';
import {ManagementError, invalid} from './errors';
import type {ManagementStore, TaskRow} from './registry-store';
import type {ConnectionHub} from './upstream';
import type {PersonalTasks} from './tasks';

const fail=(code:string):never=>{throw new ManagementError(409,code,code,false);};
const sourceCode=(e:unknown)=>e instanceof ManagementError?e.code:'LOCAL_REPLY_UNCONFIRMED';
type RequestRow={request_key:string;task_id:string;request_json:string;binding_json:string;dispatch_started_at?:string;observation_json?:string;source_error?:string;source_rejection?:string};

/** Native dispatch only. ACS remains on the existing facade and source client. */
export class NativeTasks {
  constructor(private store:ManagementStore,private hub:ConnectionHub,private tasks:PersonalTasks){}
  facts(row:TaskRow):NativeTaskLaunchFacts|undefined{const f=row.launchJson?JSON.parse(row.launchJson):undefined;return f?.executionBinding?.kind==='WORKER_LOCAL'?f:undefined;}
  is(id:string){const row=this.store.getTask(id);return !!row&&!!this.facts(row);}
  index(row:TaskRow):PersonalTaskIndex{const f=this.facts(row)!;return {taskId:row.taskId,projectId:row.projectId,displayName:row.displayName,createdAt:row.createdAt,updatedAt:row.updatedAt,requestKey:row.requestKey,accepted:!!f.executionBinding.localTaskId,core:nativeTaskCore(f.executionBinding.engineId)};}
  private async call<T>(b:NativeBinding,method:'GET'|'POST',tail:string,body?:unknown){
    if(!supportedNativeEngine(b.engineId))return fail('NATIVE_ENGINE_UNSUPPORTED');
    if(b.authorityId){const host=await this.hub.nativeHost(b.connectionId);if(!host||host.manifest.authorityId!==b.authorityId||host.manifest.workerId!==b.workerId||host.manifest.storeId!==b.storeId||host.manifest.engine.id!==b.engineId||host.manifest.engine.version!==b.engineVersion)return fail('NATIVE_HOST_BINDING_CHANGED');}
    return this.hub.local<T>(b.connectionId,method,tail,body,b.storeId);
  }
  async available():Promise<AvailableProject[]>{
    const pages=await Promise.allSettled(this.store.listConnections().filter(c=>c.kind==='WORKER_LOCAL').map(async c=>{
      await this.hub.nativeHost(c.connectionId);
      const data=await this.hub.local<{items:{projectId:string;displayName:string;headRevision?:string|null}[]}>(c.connectionId,'GET','/projects');
      return data.items.map(p=>({projectId:`local-${canonicalDigest([c.connectionId,p.projectId]).replace(/^sha256:/,'').slice(0,32)}`,sourceProjectRef:p.projectId,displayName:p.displayName,workspaceAlias:p.projectId,headShortRevision:p.headRevision?.slice(0,8),backend:'WORKER_LOCAL' as const,connectionId:c.connectionId} as AvailableProject));
    }));const rows=pages.flatMap(p=>p.status==='fulfilled'?p.value:[]);if(pages.length&&!pages.some(p=>p.status==='fulfilled'))throw (pages[0] as PromiseRejectedResult).reason;return rows;
  }
  async options(projectId:string){
    const {project,handle}=this.hub.forProject(projectId);if(handle.kind!=='WORKER_LOCAL')return fail('LOCAL_CONNECTION_REQUIRED');
    const host=await this.hub.nativeHost(project.connectionId);
    const engines=await this.hub.local<{items:{engineId:string}[]}>(project.connectionId,'GET','/engines');
    const checked=await Promise.allSettled(engines.items.filter(e=>supportedNativeEngine(e.engineId)).map(e=>this.hub.local<NativePreflight>(project.connectionId,'POST','/task-preflights',{projectId:project.projectRef,engineId:e.engineId})));
    const items=checked.flatMap(v=>v.status==='fulfilled'&&validNativePreflight(v.value)?[v.value]:[]);
    if(host&&items.some(p=>p.engineId!==host.manifest.engine.id||p.engineVersion!==host.manifest.engine.version))return fail('NATIVE_HOST_ENGINE_MISMATCH');
    const issues=engines.items.some(e=>!supportedNativeEngine(e.engineId))?[{code:'NATIVE_ENGINE_UNSUPPORTED',message:'来源包含尚未采纳的 engine，不提供其创建能力',blocking:items.length===0}]:[];
    if(!items.length&&!issues.length)issues.push({code:'NATIVE_UNAVAILABLE',message:'本机原生程序或配置预检未通过',blocking:true});
    const canCreate=items.some(p=>!registeredGraphicsPreflight(p)||host?.manifest.contracts.includes('mac-graphics/1')&&p.macProfile?.remoteGraphicsEnabled===true);
    if(items.length&&!canCreate)issues.push({code:'REMOTE_GRAPHICS_DISABLED',message:'登记应用图形任务需要来源声明 mac-graphics/1 并显式启用远端访问',blocking:true});
    const localIdentity=items.some(p=>p.macProfile?.recipeID==='mac.local-work/1')?await this.hub.local<{storeId:string}>(project.connectionId,'GET','/identity'):undefined;
    const repairModels=(host?.manifest.contracts.includes('mac-native-model-repair/1')?items.flatMap(p=>p.macProfile?.modelRepair?.models??[]):[]).map(m=>({id:m.model,displayName:m.displayName,...(m.provider?{provider:m.provider}:{})}));
    const localModels=localIdentity?(await this.hub.local<{data:{model:string;displayName:string;provider?:string}[]}>(project.connectionId,'GET','/local-models',undefined,localIdentity.storeId)).data.map(m=>({id:m.model,displayName:m.displayName,...(m.provider?{provider:m.provider}:{})})):(repairModels.length?repairModels:undefined);
    return {status:200,body:this.tasks.envelope({preflight:null,profiles:null,models:null,native:{engines:items,...(localModels?{localModels}:{}),...(host?{host}:{})},issues},canCreate?['TASK_CREATE']:[])};
  }
  async create(request:PersonalTaskCreate){
    let ledger=this.store.ledgerGet(request.requestKey);
    if(!ledger){
      const {project,handle}=this.hub.forProject(request.projectId);if(handle.kind!=='WORKER_LOCAL'||!supportedNativeEngine(request.engineId)||!request.optionsRevision)return fail('NATIVE_SELECTION_REQUIRED');
      const identity=await this.hub.local<{storeId:string}>(project.connectionId,'GET','/identity');
      if(!identity.storeId)return fail('SOURCE_IDENTITY_REQUIRED');
      const host=await this.hub.nativeHost(project.connectionId);
      const preflight=await this.hub.local<NativePreflight>(project.connectionId,'POST','/task-preflights',{projectId:project.projectRef,engineId:request.engineId});
      if(preflight.engineId!==request.engineId||!validNativePreflight(preflight))return fail('NATIVE_PROFILE_UNSUPPORTED');
      if(registeredGraphicsPreflight(preflight)){
        if(!host?.manifest.contracts.includes('mac-graphics/1'))return fail('GRAPHICS_UNAVAILABLE');
        if(preflight.macProfile?.remoteGraphicsEnabled!==true)return fail('REMOTE_GRAPHICS_DISABLED');
      }
      if(request.executionOptions){
        if(request.engineId!=='macos')return fail('LOCAL_MODEL_SELECTION_UNSUPPORTED');
        if(preflight.macProfile?.recipeID==='apple.verify-and-repair/1'&&preflight.macProfile.modelRepair?.profile==='CODE_CANDIDATE_FILES_ONLY/1'){
          if(!host?.manifest.contracts.includes('mac-native-model-repair/1'))return fail('NATIVE_MODEL_REPAIR_UNSUPPORTED');
          if(request.executionOptions.accessMode!=='WORKSPACE'||!preflight.macProfile.modelRepair.models.some(m=>m.model===request.executionOptions!.model))return fail('LOCAL_MODEL_UNAVAILABLE');
        }else{
          if(preflight.macProfile?.recipeID!=='mac.local-work/1')return fail('LOCAL_MODEL_SELECTION_UNSUPPORTED');
          const models=await this.hub.local<{data:{model:string}[]}>(project.connectionId,'GET','/local-models',undefined,identity.storeId);
          if(!models.data.some(m=>m.model===request.executionOptions!.model))return fail('LOCAL_MODEL_UNAVAILABLE');
        }
      }
      if(request.optionsRevision!==preflight.optionsRevision)return fail('PREFLIGHT_CHANGED');
      if(host&&(host.manifest.storeId!==identity.storeId||host.manifest.engine.id!==request.engineId||host.manifest.engine.version!==preflight.engineVersion))return fail('NATIVE_HOST_ENGINE_MISMATCH');
      // Recheck after awaiting the source: another submission may have frozen this key.
      ledger=this.store.ledgerGet(request.requestKey);
      if(!ledger){
        const taskId='task-'+randomUUID();const f:NativeTaskLaunchFacts={request,executionBinding:{kind:'WORKER_LOCAL',connectionId:project.connectionId,storeId:identity.storeId,engineId:request.engineId,engineVersion:preflight.engineVersion,...(host?{authorityId:host.manifest.authorityId,workerId:host.manifest.workerId}:{})},sourceRequest:{requestKey:request.requestKey,projectId:project.projectRef,engineId:request.engineId,optionsRevision:request.optionsRevision,instruction:request.instruction,...(request.executionOptions?{executionOptions:request.executionOptions}:{})}};
        this.store.transact(()=>{const now=this.store.now();this.store.db.prepare('INSERT INTO tasks(task_id,project_id,display_name,created_at,updated_at,revision) VALUES(?,?,?,?,?,1)').run(taskId,request.projectId,request.title??request.instruction.split('\n')[0]!.slice(0,256),now,now);this.store.ledgerBegin({requestKey:request.requestKey,route:'TASK_CREATE',bodyDigest:canonicalDigest(request),subjectId:taskId});this.store.saveLaunch(taskId,request.requestKey,f);});
        ledger=this.store.ledgerGet(request.requestKey)!;
      }
    }
    const row=this.tasks.row(ledger.subjectId!),f=this.facts(row);if(!f)return fail('BACKEND_BINDING_CHANGED');
    if(f.provenance==='ADOPTED_ORIGINAL')return fail('ADOPTED_TASK_CANNOT_CREATE');
    if(ledger.bodyDigest!==canonicalDigest(request)||ledger.route!=='TASK_CREATE')return fail('IDEMPOTENCY_CONFLICT');
    if(!f.executionBinding.localTaskId&&!f.sourceRejection)try{
      let reply:{taskId:string;engineId?:string;engineVersion?:string};
      if(f.dispatchStartedAt)reply=await this.call(f.executionBinding,'GET','/task-requests/'+request.requestKey);
      else{f.dispatchStartedAt=this.store.now();this.store.saveLaunch(row.taskId,request.requestKey,f);reply=await this.call(f.executionBinding,'POST','/tasks',f.sourceRequest);}
      if(!reply.taskId||!/^native-[a-zA-Z0-9-]+$/.test(reply.taskId)||reply.engineId!==f.executionBinding.engineId||reply.engineVersion!==f.executionBinding.engineVersion)return fail('LOCAL_REPLY_INVALID');
      f.executionBinding.localTaskId=reply.taskId;f.sourceError=undefined;
    }catch(e){f.sourceError=sourceCode(e);if(e instanceof ManagementError&&e.status===409)f.sourceRejection=e.code;}
    this.store.saveLaunch(row.taskId,request.requestKey,f);
    const result={status:f.executionBinding.localTaskId?201:202,body:this.tasks.envelope(this.index(this.tasks.row(row.taskId)))};
    if(f.executionBinding.localTaskId)this.store.ledgerSettle(request.requestKey,result.status,result.body);
    return result;
  }
  private async bound(id:string){const row=this.tasks.row(id),f=this.facts(row);if(!f?.executionBinding.localTaskId)return fail('NATIVE_TASK_UNBOUND');return {row,f,b:f.executionBinding,root:'/tasks/'+f.executionBinding.localTaskId};}
  async detail(id:string){
    const row=this.tasks.row(id),f=this.facts(row)!;
    if(f.executionBinding.localTaskId)try{const observed=await this.call<NativeTaskDetail>(f.executionBinding,'GET','/tasks/'+f.executionBinding.localTaskId);if(observed.taskId!==f.executionBinding.localTaskId||observed.engineId!==f.executionBinding.engineId||observed.engineVersion!==f.executionBinding.engineVersion)return fail('NATIVE_BINDING_MISMATCH');f.lastObserved=observed;
      if(observed.graphicsProfile){
        try{await this.graphicsGate(id,observed);observed.graphicsAccess={protocolVersion:'mac-graphics/1',observe:true,capture:true,act:true};}
        catch{observed.graphicsAccess={protocolVersion:'mac-graphics/1',observe:false,capture:false,act:false};}
      }
      f.sourceError=undefined;}catch(e){f.sourceError=sourceCode(e);}
    this.store.saveLaunch(id,f.request.requestKey,f);
    const instruction=f.provenance==='ADOPTED_ORIGINAL'?{sourceProvenance:'ADOPTED_ORIGINAL' as const,instructionNotice:'来源未公开原任务要求'}:{instruction:f.request.instruction,request:f.request};
    const data:PersonalTaskDetail={...this.index(row),...instruction,core:nativeTaskCore(f.executionBinding.engineId),executionBinding:f.executionBinding,native:f.lastObserved,sourceStoreId:f.executionBinding.storeId,sourceError:f.sourceError,submissionError:f.sourceRejection?{code:f.sourceRejection,message:f.sourceRejection}:undefined,observedAt:this.store.now()};
    return {status:200,body:this.tasks.envelope(data)};
  }
  async read(id:string,kind:'events'|'output'|'metrics'|'messages'|'input-requests'|'artifacts',query=new URLSearchParams()){
    const allowed=kind==='messages'?['cursor','before','limit']:['cursor','limit'];
    if([...query.keys()].some(k=>!allowed.includes(k))||allowed.some(k=>query.getAll(k).length>1))return invalid();
    let suffix='';
    if(kind==='events'){
      const limit=Number(query.get('limit')??30),cursor=query.get('cursor');if(!Number.isInteger(limit)||limit<1||limit>100||(cursor!==null&&!/^[0-9]{1,18}$/.test(cursor)))return invalid();
      suffix=`?${cursor?'cursor='+cursor+'&':''}limit=${limit}`;
    }else if(kind==='messages'){
      // native-messages/1 paging (design §5.3/§8.1): decimal cursor
      // (0..i64::MAX) and before (1..i64::MAX) are mutually exclusive and
      // limit is 1..100, the same range the Host serves. Sequence values
      // stay decimal strings end to end — never converted through JS numbers.
      const forwarded=new URLSearchParams();
      for(const [name,raw] of query.entries()){
        if(!/^(0|[1-9][0-9]{0,18})$/.test(raw))return invalid();
        const value=BigInt(raw);
        if(value>9223372036854775807n||(name==='before'&&value<1n)||(name==='limit'&&(value<1n||value>100n)))return invalid();
        forwarded.set(name,raw);
      }
      if(forwarded.has('cursor')&&forwarded.has('before'))return invalid();
      if(forwarded.size)suffix=`?${forwarded}`;
    }else{
      const limit=Number(query.get('limit')??30),cursor=query.get('cursor');if(!Number.isInteger(limit)||limit<1||limit>100||(cursor!==null&&!/^[0-9]{1,18}$/.test(cursor)))return invalid();
    }
    const {b,root}=await this.bound(id);if(kind==='artifacts'&&b.engineId==='macos'){const task=await this.call<NativeTaskDetail>(b,'GET',root);if(task.graphicsProfile)await this.graphicsGate(id,task);}
    if(kind==='messages'){
      const data=await this.call<Record<string,unknown>>(b,'GET',root+'/messages'+suffix);
      // §8.3: the paging capability mark is generated by this gateway — a
      // source-supplied field of the same name is never trusted.
      if(data&&typeof data==='object'&&!Array.isArray(data)){delete data.messageTransportVersion;if(data.messageSchemaVersion===NATIVE_MESSAGE_SCHEMA_VERSION)data.messageTransportVersion=NATIVE_MESSAGE_TRANSPORT_VERSION;}
      return {status:200,body:this.tasks.envelope(data)};
    }
    return {status:200,body:this.tasks.envelope(await this.call<Record<string,unknown>>(b,'GET',root+'/'+kind+suffix))};
  }
  /**
   * worker-events/1 passthrough (design §8.4 stream read): the same binding
   * and storeId authorization as `read(id,'events')`, but the upstream body
   * is returned open — never JSON-buffered — for the HTTP layer to pipe.
   * Cursor semantics match the JSON leaf: decimal `cursor`, Last-Event-ID
   * handled upstream by the client.
   */
  async eventStream(id:string,query=new URLSearchParams(),signal?:AbortSignal){
    if([...query.keys()].some(k=>!['cursor','limit'].includes(k))||['cursor','limit'].some(k=>query.getAll(k).length>1))return invalid();
    const cursor=query.get('cursor');
    if(cursor!==null&&!/^[0-9]{1,18}$/.test(cursor))return invalid();
    const limit=query.get('limit');if(limit!==null&&!/^[0-9]{1,3}$/.test(limit))return invalid();
    const params=new URLSearchParams();if(cursor)params.set('cursor',cursor);if(limit)params.set('limit',limit);
    const suffix=params.size?`?${params}`:'';
    const {b,root}=await this.bound(id);
    if(!supportedNativeEngine(b.engineId))return fail('NATIVE_ENGINE_UNSUPPORTED');
    if(b.authorityId){const host=await this.hub.nativeHost(b.connectionId);if(!host||host.manifest.authorityId!==b.authorityId||host.manifest.workerId!==b.workerId||host.manifest.storeId!==b.storeId||host.manifest.engine.id!==b.engineId||host.manifest.engine.version!==b.engineVersion)return fail('NATIVE_HOST_BINDING_CHANGED');}
    return this.hub.localStream(b.connectionId,`${root}/events${suffix}`,{storeId:b.storeId,signal});
  }
  async metrics(id:string){
    const result=await this.read(id,'metrics'),d=result.body.data;const f=this.facts(this.tasks.row(id))!;
    const usage:Record<string,string>={};for(const [key,value]of Object.entries(d))if(/^usage\.[A-Za-z]+$/.test(key)&&typeof value==='string'&&/^[0-9]{1,30}$/.test(value))usage[key]=value;
    const reported=d.usageCoverage;
    const coverage:NonNullable<import('../../../codeagent-desktop/packages/protocol/src/personal-task').PersonalTaskMetrics['native']>['coverage']=reported==='NATIVE_TASK_TOTAL'||reported==='NATIVE_THREAD_TOTAL'||reported==='LAST_ASSISTANT_MESSAGE'||reported==='NO_MODEL'?reported:reported===undefined&&f.executionBinding.engineId==='pi'?'LAST_ASSISTANT_MESSAGE':reported===undefined&&(f.executionBinding.engineId==='codex'||f.executionBinding.engineId==='codep')?'NATIVE_THREAD_TOTAL':'UNKNOWN';
    return {status:200,body:this.tasks.envelope({sourceId:null,observedAt:this.store.now(),metrics:[],models:[{providerId:null,requestedModel:typeof d.configuredModel==='string'?d.configuredModel:null,resolvedModel:null,responseModel:null}],reasonCodes:['NATIVE_COST_UNKNOWN'],native:{usage,coverage,costCoverage:'UNKNOWN' as const}})};
  }
  async artifact(id:string,artifactId:string){if(!/^file-[a-f0-9]{64}$/.test(artifactId))return invalid();const {b,root}=await this.bound(id);const task=await this.call<NativeTaskDetail>(b,'GET',root);if(task.graphicsProfile)await this.graphicsGate(id,task);return {status:200,body:this.tasks.envelope(await this.call<Record<string,unknown>>(b,'GET',root+'/artifacts/'+artifactId))};}
  private requestRow(key:string){return this.store.db.prepare('SELECT * FROM personal_native_requests WHERE request_key=?').get(key) as RequestRow|undefined;}
  async request(id:string,key:string){
    const row=this.requestRow(key);if(!row||row.task_id!==id)throw new ManagementError(404,'REQUEST_NOT_FOUND','原生请求不存在',false);
    const binding=JSON.parse(row.binding_json) as NativeBinding;
    const view:NativeRequestView={kind:'WORKER_LOCAL',requestKey:key,request:JSON.parse(row.request_json),state:'UNKNOWN',sourceError:row.source_error??undefined};
    if(row.source_rejection)return {status:200,body:this.tasks.envelope({...view,state:'REJECTED' as const,sourceError:row.source_rejection})};
    if(row.observation_json){view.source=JSON.parse(row.observation_json);view.state='OBSERVED';}
    try{view.source=await this.call<Record<string,unknown>>(binding,'GET',`/tasks/${binding.localTaskId}/interaction-requests/${key}`);view.sourceError=undefined;view.state='OBSERVED';this.store.db.prepare('UPDATE personal_native_requests SET observation_json=?,source_error=NULL WHERE request_key=?').run(JSON.stringify(view.source),key);}catch(e){view.sourceError=sourceCode(e);this.store.db.prepare('UPDATE personal_native_requests SET source_error=? WHERE request_key=?').run(view.sourceError,key);}
    return {status:200,body:this.tasks.envelope(view)};
  }
  async input(id:string,body:unknown){
    if(!validNativeInput(body))return invalid();const request=body as NativeInput;const old=this.store.ledgerGet(request.requestKey);
    if(old){if(old.route!=='TASK_NATIVE_INPUT'||old.subjectId!==id||old.bodyDigest!==canonicalDigest(request))return fail('IDEMPOTENCY_CONFLICT');return this.request(id,request.requestKey);}
    const {b,root}=await this.bound(id);
    if(request.kind==='PAUSE'||request.kind==='RESUME'){
      const current=await this.call<NativeTaskDetail>(b,'GET',root);
      if(current.capabilities?.[request.kind==='PAUSE'?'pause':'resume']!==true)return fail('NATIVE_CONTROL_UNAVAILABLE');
    }
    this.store.transact(()=>{this.store.ledgerBegin({requestKey:request.requestKey,route:'TASK_NATIVE_INPUT',bodyDigest:canonicalDigest(request),subjectId:id});this.store.db.prepare('INSERT INTO personal_native_requests(request_key,task_id,request_json,binding_json,dispatch_started_at,created_at) VALUES(?,?,?,?,?,?)').run(request.requestKey,id,JSON.stringify(request),JSON.stringify(b),this.store.now(),this.store.now());});
    const {kind,...wire}=request;let tail=root+'/messages';let sourceBody:unknown=request;
    if(kind==='STOP'||kind==='PAUSE'||kind==='RESUME'){tail=root+'/commands';sourceBody={...wire,intent:kind};}
    else if(kind==='INPUT_RESPONSE'){tail=root+`/input-requests/${request.inputRequestId}/responses`;const {inputRequestId,...response}=wire as typeof wire&{inputRequestId:string};sourceBody=response;}
    try{const result=await this.call<Record<string,unknown>>(b,'POST',tail,sourceBody);this.store.db.prepare('UPDATE personal_native_requests SET observation_json=? WHERE request_key=?').run(JSON.stringify(result),request.requestKey);}catch(e){this.store.db.prepare('UPDATE personal_native_requests SET source_error=?,source_rejection=? WHERE request_key=?').run(sourceCode(e),e instanceof ManagementError&&e.status===409?e.code:null,request.requestKey);}
    return this.request(id,request.requestKey);
  }
  async sourceTasks(projectId:string){
    const {project,handle}=this.hub.forProject(projectId);if(handle.kind!=='WORKER_LOCAL')return fail('LOCAL_CONNECTION_REQUIRED');
    const host=await this.hub.nativeHost(project.connectionId);if(!host)return fail('NATIVE_HOST_UNAVAILABLE');
    const ordinary=['pi','codex','codep'].includes(host.manifest.engine.id);
    if(!ordinary&&!host.manifest.contracts.includes('mac-graphics/1'))return fail('GRAPHICS_UNAVAILABLE');
    const result=await this.hub.local<{items:(NativeTaskDetail&{goal?:string})[]}>(project.connectionId,'GET','/tasks?limit=50',undefined,host.manifest.storeId);
    return {status:200,body:this.tasks.envelope({items:result.items.filter(t=>t.projectId===project.projectRef&&(ordinary?t.engineId===host.manifest.engine.id:t.engineId==='macos'&&t.recipeID==='mac.app-workflow/1')).map(t=>({localTaskId:t.taskId,title:t.goal??('其他端任务 · '+t.taskId.slice(-8)),state:t.state}))})};
  }
  async adopt(projectId:string,body:unknown){
    const request=body as {requestKey?:unknown;localTaskId?:unknown};
    if(!request||Object.keys(request).sort().join(',')!=='localTaskId,requestKey'||typeof request.requestKey!=='string'||typeof request.localTaskId!=='string'||![request.requestKey,request.localTaskId].every(v=>/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(v)))return invalid();
    const {project,handle}=this.hub.forProject(projectId);if(handle.kind!=='WORKER_LOCAL')return fail('LOCAL_CONNECTION_REQUIRED');
    const host=await this.hub.nativeHost(project.connectionId);if(!host)return fail('NATIVE_HOST_UNAVAILABLE');
    if(['pi','codex','codep'].includes(host.manifest.engine.id)) {
      const storeId=host.manifest.storeId;
      const task=await this.hub.local<NativeTaskDetail>(project.connectionId,'GET','/tasks/'+request.localTaskId,undefined,storeId);
      if(task.taskId!==request.localTaskId||task.projectId!==project.projectRef||task.engineId!==host.manifest.engine.id||task.engineVersion!==host.manifest.engine.version||!task.currentCommandId)return fail('NATIVE_BINDING_MISMATCH');
      const digest=canonicalDigest({projectId,...request}),old=this.store.ledgerGet(request.requestKey);
      if(old){if(old.route!=='TASK_NATIVE_ADOPT'||old.bodyDigest!==digest)return fail('IDEMPOTENCY_CONFLICT');return {status:200,body:this.tasks.envelope(this.index(this.tasks.row(old.subjectId!)))};}
      const existing=this.store.listTasks(1000).find(row=>{const f=this.facts(row);return f?.executionBinding.connectionId===project.connectionId&&f.executionBinding.storeId===storeId&&f.executionBinding.localTaskId===task.taskId;});
      if(existing){const bound=this.facts(existing)!.executionBinding;if(bound.authorityId!==host.manifest.authorityId||bound.workerId!==host.manifest.workerId)return fail('NATIVE_HOST_BINDING_CHANGED');}
      const taskId=existing?.taskId??'task-'+randomUUID();
      this.store.transact(()=>{
        if(!existing){
          const now=this.store.now(),facts:NativeTaskLaunchFacts={provenance:'ADOPTED_ORIGINAL',request:{requestKey:request.requestKey as string,projectId,localTaskId:task.taskId},executionBinding:{kind:'WORKER_LOCAL',connectionId:project.connectionId,storeId,localTaskId:task.taskId,engineId:task.engineId as 'pi'|'codex'|'codep',engineVersion:task.engineVersion,authorityId:host.manifest.authorityId,workerId:host.manifest.workerId},sourceRequest:{kind:'ADOPTED_ORIGINAL',requestKey:task.currentCommandId!,projectId:project.projectRef,engineId:task.engineId},sourceObservation:{taskId:task.taskId,projectId:project.projectRef,engineId:task.engineId,engineVersion:task.engineVersion,currentCommandId:task.currentCommandId!,observedAt:now},lastObserved:task};
          this.store.db.prepare('INSERT INTO tasks(task_id,project_id,display_name,created_at,updated_at,revision) VALUES(?,?,?,?,?,1)').run(taskId,projectId,'其他端任务 · '+task.taskId.slice(-8),now,now);this.store.saveLaunch(taskId,request.requestKey as string,facts);
        }
        this.store.ledgerBegin({requestKey:request.requestKey as string,route:'TASK_NATIVE_ADOPT',bodyDigest:digest,subjectId:taskId});
      });
      return {status:200,body:this.tasks.envelope(this.index(this.tasks.row(taskId)))};
    }
    if(!host.manifest.contracts.includes('mac-graphics/1'))return fail('GRAPHICS_UNAVAILABLE');
    const storeId=host.manifest.storeId;
    const preflight=await this.hub.local<NativePreflight>(project.connectionId,'POST','/task-preflights',{projectId:project.projectRef,engineId:'macos'},storeId);
    if(!registeredGraphicsPreflight(preflight)||preflight.macProfile?.remoteGraphicsEnabled!==true)return fail('REMOTE_GRAPHICS_DISABLED');
    const task=await this.hub.local<NativeTaskDetail&{goal?:string|null;optionsRevision?:string;profileId?:string}>(project.connectionId,'GET','/tasks/'+request.localTaskId,undefined,storeId);
    if(task.taskId!==request.localTaskId||task.projectId!==project.projectRef||task.engineId!=='macos'||task.engineVersion!==host.manifest.engine.version||task.recipeID!=='mac.app-workflow/1'||!task.currentCommandId||!task.graphicsProfile||canonicalDigest(task.graphicsProfile)!==canonicalDigest(preflight.macProfile!.graphicsProfile))return fail('GRAPHICS_BINDING_MISMATCH');
    const receipt=await this.hub.local<Record<string,unknown>>(project.connectionId,'GET','/task-requests/'+task.currentCommandId,undefined,storeId);
    if(receipt.requestKey!==task.currentCommandId||receipt.taskId!==task.taskId||receipt.engineId!=='macos'||receipt.engineVersion!==task.engineVersion||receipt.projectId!==project.projectRef||receipt.profileId!=='MAC_MANAGED'||receipt.kind!=='CREATE'||!task.optionsRevision)return fail('ORIGINAL_CREATE_RECEIPT_MISMATCH');
    const old=this.store.ledgerGet(request.requestKey);
    if(old){if(old.route!=='TASK_NATIVE_ADOPT'||old.bodyDigest!==canonicalDigest({projectId,...request}))return fail('IDEMPOTENCY_CONFLICT');return {status:200,body:this.tasks.envelope(this.index(this.tasks.row(old.subjectId!)))};}
    const existing=this.store.listTasks(1000).find(row=>{const f=this.facts(row);return f?.executionBinding.connectionId===project.connectionId&&f.executionBinding.storeId===storeId&&f.executionBinding.localTaskId===task.taskId;});
    const taskId=existing?.taskId??'task-'+randomUUID();
    if(!existing){
      const facts:NativeTaskLaunchFacts={provenance:'ADOPTED_ORIGINAL',request:{requestKey:request.requestKey,projectId,localTaskId:task.taskId},executionBinding:{kind:'WORKER_LOCAL',connectionId:project.connectionId,storeId,localTaskId:task.taskId,engineId:'macos',engineVersion:task.engineVersion,authorityId:host.manifest.authorityId,workerId:host.manifest.workerId},sourceRequest:{kind:'ADOPTED_ORIGINAL',requestKey:task.currentCommandId,projectId:project.projectRef,engineId:'macos',optionsRevision:task.optionsRevision},originalCreateReceipt:{requestKey:receipt.requestKey as string,taskId:receipt.taskId as string,kind:'CREATE',engineId:receipt.engineId as string,engineVersion:receipt.engineVersion as string,projectId:receipt.projectId as string,profileId:receipt.profileId as string},lastObserved:task};
      this.store.transact(()=>{const now=this.store.now();this.store.db.prepare('INSERT INTO tasks(task_id,project_id,display_name,created_at,updated_at,revision) VALUES(?,?,?,?,?,1)').run(taskId,projectId,'已采纳登记任务 · '+task.taskId,now,now);this.store.saveLaunch(taskId,request.requestKey as string,facts);});
    }
    this.store.ledgerBegin({requestKey:request.requestKey,route:'TASK_NATIVE_ADOPT',bodyDigest:canonicalDigest({projectId,...request}),subjectId:taskId});
    return {status:200,body:this.tasks.envelope(this.index(this.tasks.row(taskId)))};
  }
  private async graphicsGate(id:string,known?:NativeTaskDetail){
    const bound=await this.bound(id),{b,f,root}=bound;
    const host=await this.hub.nativeHost(b.connectionId);
    if(b.engineId!=='macos'||!host?.manifest.contracts.includes('mac-graphics/1'))return fail('GRAPHICS_UNAVAILABLE');
    const preflight=await this.call<NativePreflight>(b,'POST','/task-preflights',{projectId:f.sourceRequest.projectId,engineId:'macos'});
    if(!registeredGraphicsPreflight(preflight)||preflight.macProfile?.remoteGraphicsEnabled!==true)return fail('REMOTE_GRAPHICS_DISABLED');
    const facts=known??await this.call<NativeTaskDetail>(b,'GET',root);
    if(facts.taskId!==b.localTaskId||facts.recipeID!=='mac.app-workflow/1'||!facts.graphicsProfile||canonicalDigest(facts.graphicsProfile)!==canonicalDigest(preflight.macProfile!.graphicsProfile))return fail('GRAPHICS_BINDING_MISMATCH');
    return {...bound,facts};
  }
  async graphicsObservations(id:string){
    const {b,root}=await this.graphicsGate(id);
    const result=await this.call<{items:NativeGraphicsObservation[]}>(b,'GET',root+'/graphics/observations');
    if(!Array.isArray(result.items)||result.items.length>50||result.items.some(o=>o.taskId!==b.localTaskId||o.schemaVersion!=='mac-graphics-observation/1'))return fail('GRAPHICS_BINDING_MISMATCH');
    return {status:200,body:this.tasks.envelope(result)};
  }
  async graphicsRequest(id:string,key:string){
    const {b}=await this.graphicsGate(id);
    const row=this.requestRow(key);if(!row||row.task_id!==id||this.store.ledgerGet(key)?.route!=='TASK_NATIVE_GRAPHICS')throw new ManagementError(404,'REQUEST_NOT_FOUND','图形原请求不存在',false);
    const binding=JSON.parse(row.binding_json) as NativeBinding;
    if(binding.storeId!==b.storeId||binding.localTaskId!==b.localTaskId)return fail('GRAPHICS_BINDING_MISMATCH');
    const view:NativeGraphicsRequestView={kind:'WORKER_LOCAL',requestKey:key,request:JSON.parse(row.request_json),state:'UNKNOWN',sourceError:row.source_error??undefined};
    try{
      view.source=await this.call(b,'GET',`/tasks/${b.localTaskId}/interaction-requests/${key}`);
      if(view.source?.requestKey!==key||view.source?.taskId!==b.localTaskId)return fail('GRAPHICS_BINDING_MISMATCH');
      view.state=view.source?.state==='UNKNOWN'?'UNKNOWN':'OBSERVED';view.sourceError=undefined;
      this.store.db.prepare('UPDATE personal_native_requests SET observation_json=?,source_error=NULL WHERE request_key=?').run(JSON.stringify(view.source),key);
    }catch(e){view.sourceError=sourceCode(e);}
    return {status:200,body:this.tasks.envelope(view)};
  }
  async graphics(id:string,route:'observe'|'capture'|'actions',body:unknown){
    if(!validNativeGraphicsInput(route,body))return invalid();const request=body as NativeGraphicsInput;
    const old=this.store.ledgerGet(request.requestKey);
    if(old){if(old.route!=='TASK_NATIVE_GRAPHICS'||old.subjectId!==id||old.bodyDigest!==canonicalDigest({route,request}))return fail('IDEMPOTENCY_CONFLICT');return this.graphicsRequest(id,request.requestKey);}
    const {b,root,facts}=await this.graphicsGate(id);
    for(const key of ['generation','nativeSessionId','segmentId','ownerEpoch'] as const)if(request.guard[key]!==facts[key])return fail('GRAPHICS_OBSERVATION_STALE');
    if(route!=='observe'&&(facts.graphicsObservationValid!==true||facts.graphicsObservationRevision!==request.observationRevision))return fail('GRAPHICS_OBSERVATION_STALE');
    if(route==='capture'&&!facts.graphicsProfile!.allowedActions.includes('capture'))return fail('GRAPHICS_ACTION_UNAVAILABLE');
    if(route==='actions'&&(!facts.graphicsProfile!.allowedActions.includes(request.action!)||!facts.graphicsProfile!.allowedElementIdentifiers.includes(request.elementIdentifier!)))return fail('GRAPHICS_ACTION_UNAVAILABLE');
    this.store.transact(()=>{this.store.ledgerBegin({requestKey:request.requestKey,route:'TASK_NATIVE_GRAPHICS',bodyDigest:canonicalDigest({route,request}),subjectId:id});this.store.db.prepare('INSERT INTO personal_native_requests(request_key,task_id,request_json,binding_json,dispatch_started_at,created_at) VALUES(?,?,?,?,?,?)').run(request.requestKey,id,JSON.stringify(request),JSON.stringify(b),this.store.now(),this.store.now());});
    try{const result=await this.call(b,'POST',root+'/graphics/'+route,request);this.store.db.prepare('UPDATE personal_native_requests SET observation_json=? WHERE request_key=?').run(JSON.stringify(result),request.requestKey);}
    catch(e){this.store.db.prepare('UPDATE personal_native_requests SET source_error=? WHERE request_key=?').run(sourceCode(e),request.requestKey);}
    return this.graphicsRequest(id,request.requestKey);
  }

}
