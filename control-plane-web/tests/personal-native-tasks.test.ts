import {describe,it,expect} from 'vitest';
import {randomUUID} from 'node:crypto';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ManagementStore} from '../server/management/registry-store';
import {ConnectionHub} from '../server/management/upstream';
import {PersonalTasks} from '../server/management/tasks';
import {TaskMetricsReader} from '../server/management/task-metrics';
import {validPersonalOperation} from '../../codeagent-desktop/packages/protocol/src/personal';
import {nativeTaskCore,supportedNativeEngine,supportedNativeProfile,validNativeInput} from '../../codeagent-desktop/packages/protocol/src/native-task';
import type {GatewayCallContext} from '../server/management/service';

function fixture(path=':memory:',engineId:'pi'|'codex'|'macos'|'codep'='pi'){
  const store=new ManagementStore({path});let storeId='native-store',lose=false,loseInput=false,wrongDetail=false;
  let manifest:any,capabilities:any={items:[{schemaVersion:'worker-capability/1',id:'execution.pause',implementation:'GAP',qualification:'NOT_RUN',availability:'UNSUPPORTED'}]},manifestStatus=200;
  let taskControls={pause:false,resume:false};
  let metricFacts:any={},repair=false,localWork=false,graphics=false,remote:boolean|undefined=true,wrongProject=false,badReceipt=false,wrongRecipe=false,goal:string|null='Original Host graphics goal';
  const seen:{method:string;path:string;search:string;body:any}[]=[],creates=new Map<string,any>(),inputs=new Map<string,any>();
  let messageFacts:any;
  const fetchImpl:typeof fetch=async(input,init)=>{
    const url=new URL(String(input)),path=url.pathname,method=init?.method??'GET',body=init?.body?JSON.parse(String(init.body)):undefined;seen.push({path,search:url.search,method,body});
    let data:any;
    if(path.startsWith('/api/v2'))throw new Error('ACS offline');
    if(path==='/worker-host/v1/manifest')return new Response(JSON.stringify(manifest??{code:'NOT_FOUND'}),{status:manifest?manifestStatus:404,headers:{'content-type':'application/json'}});
    if(path==='/worker-host/v1/capabilities')data=capabilities;
    else if(path.endsWith('/identity'))data={storeId,bootId:'boot'};
    else if(path.endsWith('/projects'))data={items:[{projectId:'owned-project',displayName:'Owned Git',headRevision:'a'.repeat(40)}]};
    else if(path.endsWith('/engines'))data={items:[{engineId}]};
    else if(path.endsWith('/local-models'))data={data:[{model:'opencode-go/deepseek-v4.1-flash',displayName:'DeepSeek V4.1 Flash'}]};
    else if(repair&&path.endsWith('/task-preflights'))data={projectId:body.projectId,engineId:'macos',engineVersion:'0.73.1',optionsRevision:'a'.repeat(64),profileId:'MAC_MANAGED',profileHome:null,loadsUserExtensions:false,headRevision:'a'.repeat(40),hasUncommittedChanges:false,workingCopyPolicy:'COMMITTED_BASE_ONLY',macProfile:{recipeID:'apple.verify-and-repair/1',modelRepair:{profile:'CODE_CANDIDATE_FILES_ONLY/1',availability:'AVAILABLE',models:[{model:'opencode-go/deepseek-v4.1-flash',displayName:'DeepSeek V4.1 Flash'}]}}};
    else if(localWork&&path.endsWith('/task-preflights'))data={projectId:'this-mac',engineId:'macos',engineVersion:'0.73.1',optionsRevision:'a'.repeat(64),profileId:'MAC_MANAGED',profileHome:null,loadsUserExtensions:false,headRevision:null,treeRevision:null,hasUncommittedChanges:false,workingCopyPolicy:'OWNED_WORKSPACE_ONLY',registryDigest:'b'.repeat(64),macProfile:{recipeID:'mac.local-work/1'}};
    else if(graphics&&path.endsWith('/task-preflights'))data={projectId:body.projectId,engineId:'macos',engineVersion:'0.73.1',optionsRevision:'a'.repeat(64),profileId:'MAC_MANAGED',profileHome:null,loadsUserExtensions:false,headRevision:null,treeRevision:null,hasUncommittedChanges:false,workingCopyPolicy:'REGISTERED_TARGET_ONLY',registryDigest:'b'.repeat(64),macProfile:{recipeID:'mac.app-workflow/1',remoteGraphicsEnabled:remote,graphicsProfile:{id:'owned-project',bundleID:'fixture.app',windowTitle:'Fixture',allowedActions:['capture','setValue','press'],allowedElementIdentifiers:['field']}}};
    else if(path.endsWith('/task-preflights'))data={projectId:body.projectId,engineId,engineVersion:'0.73.1',optionsRevision:'a'.repeat(64),profileId:engineId==='macos'?'MAC_MANAGED':'USER_PROFILE',profileHome:engineId==='macos'?null:'fixture-profile',loadsUserExtensions:engineId!=='macos',headRevision:'a'.repeat(40),hasUncommittedChanges:true,workingCopyPolicy:'COMMITTED_BASE_ONLY'};
    else if(path.endsWith('/tasks')&&method==='GET')data={items:[{taskId:'native-fixture',projectId:'owned-project',engineId,state:'RUNNING'},{taskId:'native-foreign',projectId:'other-project',engineId,state:'RUNNING'}]};
    else if(path.endsWith('/tasks')&&method==='POST'){data={taskId:'native-fixture',engineId,engineVersion:'0.73.1'};creates.set(body.requestKey,data);if(lose){lose=false;throw new Error('lost accepted response');}}
    else if(path.includes('/task-requests/'))data=creates.get(path.split('/').at(-1)!)??(graphics?{requestKey:'launch-native',taskId:badReceipt?'wrong-task':'native-fixture',kind:'CREATE',engineId:'macos',engineVersion:'0.73.1',projectId:'owned-project',profileId:'MAC_MANAGED'}:undefined);
    else if(graphics&&path.includes('/graphics/')&&method==='POST'){expect(new Headers(init?.headers).get('X-Worker-Local-Store')).toBe('native-store');data={requestKey:body.requestKey,taskId:'native-fixture',state:'APPLIED',result:{outcome:'APPLIED',reasonCode:'APPLIED'}};inputs.set(body.requestKey,data);if(loseInput){loseInput=false;throw new Error('lost graphics response');}}
    else if((path.endsWith('/messages')||path.endsWith('/commands'))&&method==='POST'){data={requestKey:body.requestKey,state:'ACKNOWLEDGED'};inputs.set(body.requestKey,data);if(loseInput){loseInput=false;throw new Error('lost input response');}}
    else if(path.includes('/interaction-requests/'))data=inputs.get(path.split('/').at(-1)!);
    else if(path.endsWith('/tasks/native-fixture'))data={taskId:'native-fixture',projectId:wrongProject?'wrong-project':'owned-project',engineId:wrongDetail?'other':engineId,engineVersion:'0.73.1',state:'RUNNING',capabilities:taskControls,generation:'generation-1',nativeSessionId:'native-session',currentCommandId:'launch-native',...(graphics?{projectId:wrongProject?'wrong-project':'owned-project',profileId:'MAC_MANAGED',recipeID:wrongRecipe?'apple.verify-and-repair/1':'mac.app-workflow/1',goal,optionsRevision:'a'.repeat(64),segmentId:'segment-one',ownerEpoch:'1',graphicsProfile:{id:'owned-project',bundleID:'fixture.app',windowTitle:'Fixture',allowedActions:['capture','setValue','press'],allowedElementIdentifiers:['field']},graphicsObservationRevision:'observation-one',graphicsObservationValid:true}:{})};
    else if(path.endsWith('/metrics'))data=metricFacts;
    else if(path.endsWith('/messages')&&method==='GET')data=messageFacts??{items:[]};
    else data={items:[]};
    return new Response(JSON.stringify(data??{code:'REQUEST_NOT_FOUND'}),{status:data?200:404,headers:{'content-type':'application/json'}});
  };
  const hub=new ConnectionHub(store,()=>randomUUID(),fetchImpl);
  hub.provision([{connectionId:'native',kind:'WORKER_LOCAL',baseUrl:'http://127.0.0.1:7777',tokenRef:'memory-only'}]);
  if(!store.getProject('project-one'))store.insertProject({projectId:'project-one',projectRef:'owned-project',connectionId:'native'});
  const tasks=new PersonalTasks(store,hub,'native-tests',new TaskMetricsReader());
  const ctx:GatewayCallContext={requestId:'test',acsSessionFor:async()=>{throw new Error('Native must never register ACS session');}};
  return {store,hub,tasks,ctx,seen,creates,inputs,taskControls:(value:typeof taskControls)=>{taskControls=value;},wrongDetail:()=>{wrongDetail=true;},lose:()=>{lose=true;},loseInput:()=>{loseInput=true;},changeIdentity:()=>{storeId='replacement-store';},fetchImpl,
    host:(changes={})=>{manifest={schemaVersion:'worker-host/1',authorityId:'authority-one',storeId,workerId:'worker-one',bootId:'boot',engine:{id:engineId,version:'0.73.1'},contracts:['worker-host/1','worker-local/1'],supportedPaths:['/local/v1','/worker-host/v1'],...changes};},
    repair:()=>{repair=true;},
    localWork:()=>{localWork=true;},
    redactGoal:()=>{goal=null;},graphics:()=>{graphics=true;},omitRemote:()=>{remote=undefined;},disableRemote:()=>{remote=false;},wrongRecipe:()=>{wrongRecipe=true;},wrongProject:()=>{wrongProject=true;},badReceipt:()=>{badReceipt=true;},
    metrics:(facts:any)=>{metricFacts=facts;},capabilities:(items:any[])=>{capabilities={items};},badCapabilities:()=>{capabilities={items:[{id:'execution.pause',available:true}]};},denyManifest:()=>{manifestStatus=403;},
    messages:(facts:any)=>{messageFacts=facts;}};
}
const request={requestKey:'launch-native',projectId:'project-one',instruction:'Run native fixture',engineId:'pi' as const,optionsRevision:'a'.repeat(64)};
const input={kind:'NATIVE_STEER' as const,requestKey:'input-one',generation:'generation-1',nativeSessionId:'native-session',targetCommandId:'launch-native',content:'More context'};
describe('native ordinary tasks on the existing personal facade',()=>{
  it.each(['pi','codex','macos','codep'] as const)('consumes %s worker-host identity and honest capabilities on the existing facade',async engine=>{const f=fixture(':memory:',engine);try{f.host();const options=await f.tasks.options('project-one',f.ctx);expect(options.body.data.native?.host?.manifest.engine.id).toBe(engine);expect(options.body.data.native?.host?.capabilities[0]).toMatchObject({id:'execution.pause',implementation:'GAP',qualification:'NOT_RUN',availability:'UNSUPPORTED'});const created=await f.tasks.create({...request,engineId:engine},f.ctx);const detail=await f.tasks.detail((created.body as any).data.taskId,f.ctx);expect(detail.body.data.core).toBe(nativeTaskCore(engine));expect(detail.body.data.executionBinding).toMatchObject({storeId:'native-store',authorityId:'authority-one',workerId:'worker-one',engineId:engine});expect(f.seen.some(s=>s.path.startsWith('/api/v2'))).toBe(false);}finally{f.store.close();}});
  it('rejects incompatible discovery and malformed capability metadata without legacy fallback',async()=>{const f=fixture();try{f.host({schemaVersion:'worker-host/2'});await expect(f.tasks.options('project-one',f.ctx)).rejects.toMatchObject({code:'NATIVE_HOST_CONTRACT_MISMATCH'});f.host();f.badCapabilities();await expect(f.tasks.options('project-one',f.ctx)).rejects.toMatchObject({code:'NATIVE_HOST_CAPABILITIES_INVALID'});f.denyManifest();await expect(f.tasks.options('project-one',f.ctx)).rejects.toMatchObject({status:403});expect(f.creates.size).toBe(0);}finally{f.store.close();}});
  it('accepts additive record schema metadata but requires evidence for verified claims',async()=>{const f=fixture();try{f.host();f.capabilities([{id:'execution.messages',implementation:'IMPLEMENTED',qualification:'PARTIAL',availability:'AVAILABLE'}]);expect((await f.tasks.options('project-one',f.ctx)).body.data.native?.host?.capabilities[0]?.qualification).toBe('PARTIAL');f.capabilities([{id:'execution.messages',implementation:'IMPLEMENTED',qualification:'VERIFIED',availability:'AVAILABLE'}]);await expect(f.tasks.options('project-one',f.ctx)).rejects.toMatchObject({code:'NATIVE_HOST_CAPABILITIES_INVALID'});}finally{f.store.close();}});
  it('rejects discovery/preflight engine disagreement before dispatch',async()=>{const f=fixture();try{f.host({engine:{id:'codex',version:'0.73.1'}});await expect(f.tasks.create(request,f.ctx)).rejects.toMatchObject({code:'NATIVE_HOST_ENGINE_MISMATCH'});expect(f.creates.size).toBe(0);}finally{f.store.close();}});
  it('retains the original authority when a same-store host is replaced',async()=>{const f=fixture();try{f.host();const created=await f.tasks.create(request,f.ctx),id=(created.body as any).data.taskId;f.host({authorityId:'replacement-authority'});const view=await f.tasks.native.input(id,input);expect(view.body.data.sourceError).toBe('NATIVE_HOST_BINDING_CHANGED');expect(f.seen.some(s=>s.path.endsWith('/messages')&&s.method==='POST')).toBe(false);}finally{f.store.close();}});
  it('uses source task-total usage while preserving the legacy Pi coverage and unknown cost',async()=>{const f=fixture();try{const created=await f.tasks.create(request,f.ctx),id=(created.body as any).data.taskId;f.metrics({'usage.input':'12','usage.output':'3'});expect((await f.tasks.native.metrics(id)).body.data.native).toMatchObject({coverage:'LAST_ASSISTANT_MESSAGE',costCoverage:'UNKNOWN'});f.metrics({'usage.input':'12','usage.output':'3',usageCoverage:'NATIVE_TASK_TOTAL'});expect((await f.tasks.native.metrics(id)).body.data.native).toEqual({coverage:'NATIVE_TASK_TOTAL',costCoverage:'UNKNOWN',usage:{'usage.input':'12','usage.output':'3'}});}finally{f.store.close();}});
  it('keeps Mac model coverage honest and refuses unknown engine/profile pairs',async()=>{const f=fixture(':memory:','macos');try{f.host();const created=await f.tasks.create({...request,engineId:'macos'},f.ctx),id=(created.body as any).data.taskId;expect((await f.tasks.detail(id,f.ctx)).body.data.core).toBe('MACOS');expect((await f.tasks.options('project-one',f.ctx)).body.data.native?.engines[0]?.profileId).toBe('MAC_MANAGED');f.metrics({usageCoverage:'NO_MODEL'});expect((await f.tasks.native.metrics(id)).body.data.native?.coverage).toBe('NO_MODEL');f.metrics({});expect((await f.tasks.native.metrics(id)).body.data.native?.coverage).toBe('UNKNOWN');expect(nativeTaskCore('future')).toBe('UNSUPPORTED');expect(supportedNativeEngine('future')).toBe(false);expect(supportedNativeProfile('macos',{profileId:'USER_PROFILE'})).toBe(false);expect(supportedNativeProfile('codex',{profileId:'MAC_MANAGED',loadsUserExtensions:false})).toBe(false);f.host({engine:{id:'future',version:'1'}});await expect(f.tasks.options('project-one',f.ctx)).rejects.toMatchObject({code:'NATIVE_HOST_CONTRACT_MISMATCH'});}finally{f.store.close();}});
  it('lists local projects and checks native options without ACS',async()=>{const f=fixture();try{const p=await f.tasks.available(f.ctx);expect(p.body.data[0]).toMatchObject({backend:'WORKER_LOCAL',connectionId:'native',sourceProjectRef:'owned-project'});const o=await f.tasks.options('project-one',f.ctx);expect(o.body.data.native?.engines[0]?.profileId).toBe('USER_PROFILE');expect(o.body.meta.supportedActions).toContain('TASK_CREATE');expect(f.seen.every(s=>!s.path.startsWith('/api/v2'))).toBe(true);}finally{f.store.close();}});
  it('keeps native projects available while provisioned ACS is offline',async()=>{const f=fixture();try{f.hub.provision([{connectionId:'acs',kind:'ACS_DIRECT',baseUrl:'http://127.0.0.1:7778',tokenRef:'memory'}]);expect((await f.tasks.available(f.ctx)).body.data).toHaveLength(1);}finally{f.store.close();}});
  it('freezes one source create, independent of concurrent clicks and changed body',async()=>{const f=fixture();try{const [a,b]=await Promise.all([f.tasks.create(request,f.ctx),f.tasks.create(request,f.ctx)]);expect(a).toEqual(b);expect(f.creates.size).toBe(1);const id=(a.body as any).data.taskId;const d=await f.tasks.detail(id,f.ctx);expect(d.body.data).toMatchObject({core:'PI',executionBinding:{kind:'WORKER_LOCAL',storeId:'native-store',localTaskId:'native-fixture'}});expect(d.body.data).not.toHaveProperty('run');await expect(f.tasks.create({...request,instruction:'changed'},f.ctx)).rejects.toMatchObject({code:'IDEMPOTENCY_CONFLICT'});}finally{f.store.close();}});
  it('recovers dropped acceptance after BFF restart through GET of original key only',async()=>{const path=join(mkdtempSync(join(tmpdir(),'pcn-bff-')),'management.db'),f=fixture(path);f.lose();const a=await f.tasks.create(request,f.ctx);expect(a.status).toBe(202);const id=(a.body as any).data.taskId;f.store.close();const store=new ManagementStore({path}),hub=new ConnectionHub(store,()=>randomUUID(),f.fetchImpl),tasks=new PersonalTasks(store,hub,'restart',new TaskMetricsReader());try{const before=f.seen.length;await tasks.detail(id,f.ctx);await tasks.request(request.requestKey);const b=await tasks.create(request,f.ctx);expect(b.status).toBe(201);expect(f.seen.slice(before).some(s=>s.path.endsWith('/tasks')&&s.method==='POST')).toBe(false);expect(f.creates.size).toBe(1);}finally{store.close();}});
  it('binds input to its original target and never re-POSTs after a dropped reply',async()=>{const f=fixture();try{const a=await f.tasks.create(request,f.ctx),id=(a.body as any).data.taskId;f.loseInput();const view=await f.tasks.native.input(id,input);expect(view.body.data.state).toBe('OBSERVED');await f.tasks.native.input(id,input);expect(f.seen.filter(s=>s.path.endsWith('/messages')&&s.method==='POST')).toHaveLength(1);await expect(f.tasks.native.input(id,{...input,targetCommandId:'other-turn'})).rejects.toMatchObject({code:'IDEMPOTENCY_CONFLICT'});expect(JSON.parse(f.store.db.prepare('SELECT binding_json FROM personal_native_requests').get()!.binding_json as string)).toMatchObject({kind:'WORKER_LOCAL',localTaskId:'native-fixture',storeId:'native-store'});}finally{f.store.close();}});
  it('rejects source store replacement before any native write',async()=>{const f=fixture();try{const a=await f.tasks.create(request,f.ctx),id=(a.body as any).data.taskId;f.changeIdentity();const v=await f.tasks.native.input(id,input);expect(v.body.data.sourceError).toBe('SOURCE_IDENTITY_CHANGED');expect(f.seen.some(s=>s.path.endsWith('/messages'))).toBe(false);}finally{f.store.close();}});
  it('never replaces cached native facts with a different source engine',async()=>{const f=fixture();try{const a=await f.tasks.create(request,f.ctx),id=(a.body as any).data.taskId;await f.tasks.detail(id,f.ctx);f.wrongDetail();const detail=await f.tasks.detail(id,f.ctx);expect(detail.body.data.sourceError).toBe('NATIVE_BINDING_MISMATCH');expect(detail.body.data.native?.engineId).toBe('pi');}finally{f.store.close();}});
  it('fails closed for arbitrary paths, executable/argv and ACS native mixing',()=>{
    expect(validPersonalOperation({action:'TASK_CREATE',key:request.requestKey,body:request})).toBe(true);expect(validPersonalOperation({action:'TASK_CREATE',key:request.requestKey,body:{...request,engineId:'macos'}})).toBe(true);expect(validPersonalOperation({action:'TASK_CREATE',key:request.requestKey,body:{...request,engineId:'future'}})).toBe(false);
    for(const extra of [{executable:'evil'},{argv:['unsafe']},{modelSettings:{providerId:'x',modelAlias:'y',catalogRevision:'z'}}])expect(validPersonalOperation({action:'TASK_CREATE',key:request.requestKey,body:{...request,...extra}})).toBe(false);
    expect(validNativeInput(input)).toBe(true);expect(validNativeInput({...input,targetCommandId:undefined})).toBe(false);expect(validNativeInput({...input,method:'turn/start'})).toBe(false);
    const stop={requestKey:'stop-before-session',kind:'STOP',generation:'generation-1',nativeSessionId:null,nativeTurnId:null,targetCommandId:'launch-native'};
    expect(validNativeInput(stop)).toBe(true);expect(validNativeInput({...stop,nativeSessionId:'session',nativeTurnId:'turn'})).toBe(true);
    for(const kind of ['NATIVE_STEER','NATIVE_FOLLOW_UP'])expect(validNativeInput({...stop,kind,content:'test'})).toBe(false);
    expect(validNativeInput({...stop,kind:'INPUT_RESPONSE',inputRequestId:'question',response:{value:'answer'}})).toBe(false);
    expect(validNativeInput({...input,nativeSessionId:null})).toBe(false);expect(validNativeInput({...input,nativeTurnId:null})).toBe(false);
    for(const extra of [{nativeSessionId:undefined},{nativeSessionId:5},{nativeSessionId:''},{generation:undefined},{targetCommandId:undefined}])expect(validNativeInput({...stop,...extra})).toBe(false);
  });
});

// 新增：native-messages/1 paging on the fixed messages route — design §5.3/§8.1
// (decimal cursor/before, mutually exclusive, limit 1..100), §8.3 (the paging
// capability mark is gateway-generated, never trusted from the source),
// C12/C15/C16/C17 (malformed, duplicate, out-of-range and unknown params are
// rejected; mixed-version sources and clients degrade honestly).
describe('native structured messages page on the existing facade',()=>{
  const launch=async()=>{const f=fixture();const a=await f.tasks.create(request,f.ctx);return {f,id:(a.body as any).data.taskId as string};};
  const messageGets=(f:ReturnType<typeof fixture>)=>f.seen.filter(s=>s.path.endsWith('/messages')&&s.method==='GET');
  it('forwards only the whitelisted decimal page query on the fixed route',async()=>{
    const {f,id}=await launch();try{
      f.messages({messageSchemaVersion:'native-messages/1',items:[]});
      await f.tasks.messages(id,new URLSearchParams('before=9&limit=20'),f.ctx);
      expect(messageGets(f).at(-1)).toMatchObject({path:'/local/v1/tasks/native-fixture/messages',search:'?before=9&limit=20'});
      await f.tasks.messages(id,new URLSearchParams('cursor=0'),f.ctx);
      expect(messageGets(f).at(-1)?.search).toBe('?cursor=0');
      await f.tasks.messages(id,new URLSearchParams('limit=100'),f.ctx);
      expect(messageGets(f).at(-1)?.search).toBe('?limit=100');
      await f.tasks.messages(id,new URLSearchParams(),f.ctx);
      expect(messageGets(f).at(-1)?.search).toBe('');
      // The events tail keeps its own cursor/limit semantics — no before.
      await f.tasks.native.read(id,'events',new URLSearchParams('cursor=7&limit=30'));
      expect(f.seen.filter(s=>s.path.endsWith('/events')).at(-1)?.search).toBe('?cursor=7&limit=30');
    }finally{f.store.close();}
  });
  it('marks the page transport only when the source declares native-messages/1',async()=>{
    const {f,id}=await launch();try{
      const read=async()=>((await f.tasks.messages(id,new URLSearchParams(),f.ctx)).body.data) as Record<string,any>;
      f.messages({messageSchemaVersion:'native-messages/1',transcriptRevision:'3',items:[{messageId:'m1',sequence:'1',revision:'1',role:'user',text:'hi',status:'ACCEPTED',sourceRequestKey:'rk-1'}],firstSequence:'1',latestSequence:'1',hasMore:false,cursorExpired:false,historyMode:'STRUCTURED_FROM_START',legacy:null,text:'cumulative'});
      let body=await read();
      expect(body.messageTransportVersion).toBe('native-messages-page/1');
      expect(body.items[0].sequence).toBe('1');
      // A source-supplied same-name field is overwritten by this gateway, never trusted.
      f.messages({messageSchemaVersion:'native-messages/1',messageTransportVersion:'spoofed/9',items:[]});
      body=await read();
      expect(body.messageTransportVersion).toBe('native-messages-page/1');
      // A legacy cumulative reply keeps the old shape and gains no mark.
      f.messages({text:'cumulative output',turns:[],items:[{role:'assistant',text:'cumulative output'}],coverage:'BOUNDED_PUBLIC_MESSAGES'});
      body=await read();
      expect(body).not.toHaveProperty('messageTransportVersion');
      expect(body.coverage).toBe('BOUNDED_PUBLIC_MESSAGES');
      // A spoofed mark without the source schema is stripped outright.
      f.messages({items:[],messageTransportVersion:'native-messages-page/1'});
      body=await read();
      expect(body).not.toHaveProperty('messageTransportVersion');
    }finally{f.store.close();}
  });
  it('rejects malformed, duplicate, out-of-range and unknown page params before any source read',async()=>{
    const {f,id}=await launch();try{
      for(const q of ['before=0','before=abc','before=05','before=1.5','before=%205','before=9223372036854775808','cursor=abc','cursor=','cursor=9223372036854775808','limit=0','limit=101','limit=abc','limit=5x','foo=1','cursor=1&before=2','before=1&before=2','limit=5&limit=6','before=9&path=/etc/passwd'])
        await expect(f.tasks.messages(id,new URLSearchParams(q),f.ctx)).rejects.toMatchObject({status:400,code:'INVALID_REQUEST'});
      // `before` never leaks to the other fixed read routes.
      for(const kind of ['events','output','input-requests','artifacts'] as const)
        await expect(f.tasks.native.read(id,kind,new URLSearchParams('before=3'))).rejects.toMatchObject({status:400,code:'INVALID_REQUEST'});
      expect(messageGets(f)).toHaveLength(0);
    }finally{f.store.close();}
  });
  it('keeps ConnectionHub.local a fixed route even with the widened query keys',async()=>{
    const f=fixture();try{
      await expect(f.hub.local('native','GET','/tasks/native-fixture/messages?before=9')).resolves.toBeDefined();
      await expect(f.hub.local('native','GET','/tasks/native-fixture/messages?cursor=1&limit=50')).resolves.toBeDefined();
      await expect(f.hub.local('native','GET','/tasks/native-fixture/messages?limit=50&before=9')).resolves.toBeDefined();
      for(const tail of ['/tasks/native-fixture/messages?foo=1','/tasks/native-fixture/messages?before=abc','/tasks/native-fixture/messages?limit=','/tasks/native-fixture/messages?cursor=1%202','/tasks/native-fixture/messages?limit=1&','/tasks/native-fixture/messages?before=9&x=1','/tasks/native-fixture/messages?path=/etc/passwd','/unknown?limit=1'])
        await expect(f.hub.local('native','GET',tail)).rejects.toMatchObject({status:400,code:'INVALID_REQUEST'});
    }finally{f.store.close();}
  });
});

describe('registered graphics on the original owner facade',()=>{
 const wire={requestKey:'graphic-action',guard:{generation:'generation-1',nativeSessionId:'native-session',segmentId:'segment-one',ownerEpoch:'1'},observationRevision:'observation-one',action:'setValue',elementIdentifier:'field',value:'bounded'};
 const prepare=()=>{const f=fixture(':memory:','macos');f.graphics();f.host({contracts:['worker-host/1','worker-local/1','mac-graphics/1']});return f;};
 it('adopts only an actual registered original task and does not issue Host create',async()=>{const f=prepare();try{const result=await f.tasks.native.adopt('project-one',{requestKey:'adopt-one',localTaskId:'native-fixture'}),id=result.body.data.taskId;expect(f.creates.size).toBe(0);const view=await f.tasks.native.detail(id);expect(view.body.data.executionBinding).toMatchObject({storeId:'native-store',localTaskId:'native-fixture',authorityId:'authority-one'});expect(view.body.data.native?.graphicsAccess?.act).toBe(true);await f.tasks.native.adopt('project-one',{requestKey:'adopt-two',localTaskId:'native-fixture'});expect(f.store.listTasks(100)).toHaveLength(1);expect(f.seen.some(r=>r.method==='POST'&&r.path.endsWith('/tasks'))).toBe(false);}finally{f.store.close();}});
 it('persists original guard and graph route before dispatch and uses GET after lost reply',async()=>{const f=prepare();try{const id=(await f.tasks.native.adopt('project-one',{requestKey:'adopt',localTaskId:'native-fixture'})).body.data.taskId;f.loseInput();expect((await f.tasks.native.graphics(id,'actions',wire)).body.data.source?.state).toBe('APPLIED');await f.tasks.native.graphics(id,'actions',wire);expect(f.seen.filter(r=>r.method==='POST'&&r.path.endsWith('/graphics/actions'))).toHaveLength(1);await expect(f.tasks.native.graphics(id,'actions',{...wire,value:'different'})).rejects.toMatchObject({code:'IDEMPOTENCY_CONFLICT'});expect(JSON.parse(f.store.db.prepare('SELECT request_json FROM personal_native_requests').get()!.request_json as string)).toEqual(wire);}finally{f.store.close();}});
 it.each(['project','receipt','remote','store','recipe'] as const)('rejects wrong %s during adoption',async mode=>{const f=prepare();try{if(mode==='project')f.wrongProject();if(mode==='recipe')f.wrongRecipe();if(mode==='receipt')f.badReceipt();if(mode==='remote')f.disableRemote();if(mode==='store')f.changeIdentity();await expect(f.tasks.native.adopt('project-one',{requestKey:'denied',localTaskId:'native-fixture'})).rejects.toBeDefined();expect(f.creates.size).toBe(0);}finally{f.store.close();}});
 it('indexes a redacted original goal as adoption provenance and can never dispatch it as create',async()=>{
   const f=prepare();f.redactGoal();try{
     const result=await f.tasks.native.adopt('project-one',{requestKey:'adopt-null',localTaskId:'native-fixture'}),id=result.body.data.taskId;
     const facts=f.tasks.native.facts(f.store.getTask(id)!);
     expect(facts).toMatchObject({provenance:'ADOPTED_ORIGINAL',sourceRequest:{kind:'ADOPTED_ORIGINAL',requestKey:'launch-native'},originalCreateReceipt:{taskId:'native-fixture',requestKey:'launch-native',kind:'CREATE',engineId:'macos',engineVersion:'0.73.1',projectId:'owned-project',profileId:'MAC_MANAGED'}});
     expect(facts?.request).not.toHaveProperty('instruction');expect(facts?.sourceRequest).not.toHaveProperty('instruction');expect(facts).not.toHaveProperty('dispatchStartedAt');
     const detail=await f.tasks.native.detail(id);expect(detail.body.data.displayName).toBe('已采纳登记任务 · native-fixture');expect(detail.body.data.instructionNotice).toBe('来源未公开原任务要求');expect(detail.body.data).not.toHaveProperty('request');expect(detail.body.data).not.toHaveProperty('instruction');
     await expect(f.tasks.native.create({...request,requestKey:'adopt-null',engineId:'macos'})).rejects.toMatchObject({code:'ADOPTED_TASK_CANNOT_CREATE'});
     expect(f.seen.some(r=>r.method==='POST'&&r.path.endsWith('/tasks'))).toBe(false);
   }finally{f.store.close();}
 });
 it.each(['remote-disabled','remote-omitted','missing-contract'] as const)('rejects a new graphics create with %s before any dispatch',async mode=>{
   const f=prepare();try{if(mode==='remote-disabled')f.disableRemote();else if(mode==='remote-omitted')f.omitRemote();else f.host();
     await expect(f.tasks.native.create({...request,engineId:'macos'})).rejects.toMatchObject({code:mode==='missing-contract'?'GRAPHICS_UNAVAILABLE':'REMOTE_GRAPHICS_DISABLED'});
     expect((await f.tasks.native.options('project-one')).body.meta.supportedActions).not.toContain('TASK_CREATE');
     expect(f.creates.size).toBe(0);expect(f.seen.some(r=>r.method==='POST'&&r.path.endsWith('/tasks'))).toBe(false);
   }finally{f.store.close();}
 });
 it('keeps an opted-in graphics create as exactly the existing five source fields',async()=>{
   const f=prepare();try{const result=await f.tasks.native.create({...request,engineId:'macos'});expect(result.status).toBe(201);const calls=f.seen.filter(r=>r.method==='POST'&&r.path.endsWith('/tasks'));expect(calls).toHaveLength(1);expect(Object.keys(calls[0]!.body).sort()).toEqual(['engineId','instruction','optionsRevision','projectId','requestKey']);}finally{f.store.close();}
 });

});


describe('Mac model selection stays on the original source request',()=>{
 it('publishes actual local models and freezes selection through lost-reply recovery',async()=>{
  const f=fixture(':memory:','macos');try{f.localWork();const options=await f.tasks.options('project-one',f.ctx);expect(options.body.data.native?.localModels).toEqual([{id:'opencode-go/deepseek-v4.1-flash',displayName:'DeepSeek V4.1 Flash'}]);
   const body={...request,engineId:'macos' as const,executionOptions:{model:'opencode-go/deepseek-v4.1-flash',accessMode:'WORKSPACE' as const}};
   f.lose();expect((await f.tasks.create(body,f.ctx)).status).toBe(202);expect((await f.tasks.create(body,f.ctx)).status).toBe(201);
   const posts=f.seen.filter(s=>s.method==='POST'&&s.path.endsWith('/tasks'));expect(posts).toHaveLength(1);expect(posts[0]!.body.executionOptions).toEqual(body.executionOptions);
   await expect(f.tasks.create({...body,executionOptions:{...body.executionOptions,model:'other'}},f.ctx)).rejects.toMatchObject({code:'IDEMPOTENCY_CONFLICT'});
   await expect(f.tasks.create({...body,requestKey:'unknown-model',executionOptions:{...body.executionOptions,model:'unknown'}},f.ctx)).rejects.toMatchObject({code:'LOCAL_MODEL_UNAVAILABLE'});
  }finally{f.store.close();}
 });
 it('rejects broad execution options and selection on other recipes before dispatch',async()=>{
  for(const executionOptions of [{model:'m',accessMode:'FULL_ACCESS'},{model:'m',accessMode:'WORKSPACE',workspacePath:'/tmp'},{model:'m',accessMode:'WORKSPACE',apiKey:'no'}])expect(validPersonalOperation({action:'TASK_CREATE',key:request.requestKey,body:{...request,engineId:'macos',executionOptions}})).toBe(false);
  expect(validPersonalOperation({action:'TASK_CREATE',key:request.requestKey,body:{...request,executionOptions:{model:'m',accessMode:'WORKSPACE'}}})).toBe(false);
  const f=fixture(':memory:','macos');try{await expect(f.tasks.create({...request,engineId:'macos',executionOptions:{model:'m',accessMode:'WORKSPACE'}},f.ctx)).rejects.toMatchObject({code:'LOCAL_MODEL_SELECTION_UNSUPPORTED'});expect(f.creates.size).toBe(0);}finally{f.store.close();}
 });
});


describe('formal Apple model repair admission',()=>{
 it('freezes a configured repair model on the existing task route and recovers without a second source create',async()=>{
  const f=fixture(':memory:','macos');try{f.repair();f.host({contracts:['worker-host/1','worker-local/1','mac-native-model-repair/1']});const options=await f.tasks.options('project-one',f.ctx);expect(options.body.data.native?.localModels).toEqual([{id:'opencode-go/deepseek-v4.1-flash',displayName:'DeepSeek V4.1 Flash'}]);
   const body={...request,engineId:'macos' as const,executionOptions:{model:'opencode-go/deepseek-v4.1-flash',accessMode:'WORKSPACE' as const}};f.lose();expect((await f.tasks.create(body,f.ctx)).status).toBe(202);expect((await f.tasks.create(body,f.ctx)).status).toBe(201);const posts=f.seen.filter(s=>s.method==='POST'&&s.path.endsWith('/tasks'));expect(posts).toHaveLength(1);expect(posts[0]!.body.executionOptions).toEqual(body.executionOptions);
   for(const executionOptions of [{model:'unknown',accessMode:'WORKSPACE' as const},{model:body.executionOptions.model,accessMode:'READ_ONLY' as const}])await expect(f.tasks.create({...body,requestKey:'denied-'+executionOptions.model+'-'+executionOptions.accessMode,executionOptions},f.ctx)).rejects.toBeDefined();
   expect(f.seen.filter(s=>s.method==='POST'&&s.path.endsWith('/tasks'))).toHaveLength(1);
  }finally{f.store.close();}
 });
});

describe('native boundary controls',()=>{
 it.each(['PAUSE','RESUME'] as const)('checks current source capability and dispatches %s once',async kind=>{
  const f=fixture();try{const created=await f.tasks.create(request,f.ctx);const id=(created.body as any).data.taskId;const command={requestKey:'boundary-one',kind,generation:'generation-1',nativeSessionId:'native-session',targetCommandId:'launch-native'};
  await expect(f.tasks.native.input(id,command)).rejects.toMatchObject({code:'NATIVE_CONTROL_UNAVAILABLE'});
  expect(f.seen.filter(x=>x.method==='POST'&&x.path.endsWith('/commands'))).toHaveLength(0);
  f.taskControls({pause:true,resume:true});await f.tasks.native.input(id,command);await f.tasks.native.input(id,command);
  const writes=f.seen.filter(x=>x.method==='POST'&&x.path.endsWith('/commands'));expect(writes).toHaveLength(1);expect(writes[0].body).toEqual({...command,kind:undefined,intent:kind});
  }finally{f.store.close();}
 });
});


describe('ordinary native tasks created by another client',()=>{
 for(const engine of ['pi','codex'] as const)it(engine+' adopts the existing source binding without a second create',async()=>{
  const f=fixture(':memory:',engine);try{
   f.host();const list=(await f.tasks.native.sourceTasks('project-one')).body.data.items;
   expect(list.map(t=>t.localTaskId)).toEqual(['native-fixture']);
   const body={requestKey:'adopt-phone',localTaskId:'native-fixture'};
   const accepted=await f.tasks.native.adopt('project-one',body),id=accepted.body.data.taskId;
   expect((await f.tasks.native.adopt('project-one',body)).body.data.taskId).toBe(id);
   expect((await f.tasks.native.adopt('project-one',{...body,requestKey:'adopt-again'})).body.data.taskId).toBe(id);
   expect(f.store.listTasks(10)).toHaveLength(1);expect(f.creates.size).toBe(0);
   const facts=f.tasks.native.facts(f.store.getTask(id)!);
   expect(facts?.provenance).toBe('ADOPTED_ORIGINAL');expect(facts?.executionBinding.localTaskId).toBe('native-fixture');
   expect(f.seen.filter(x=>x.method==='POST'&&x.path.endsWith('/tasks'))).toHaveLength(0);
   f.taskControls({pause:true,resume:true});
   const {content,...guard}=input;await f.tasks.native.input(id,{...guard,kind:'PAUSE',requestKey:'pause-phone'});
   expect(f.seen.find(x=>x.method==='POST'&&x.path.endsWith('/commands'))?.body.intent).toBe('PAUSE');
   f.host({authorityId:'replacement-authority'});await expect(f.tasks.native.adopt('project-one',{...body,requestKey:'adopt-changed'})).rejects.toMatchObject({code:'NATIVE_HOST_BINDING_CHANGED'});
  }finally{f.store.close();}
 });
 it('refuses an unrelated project and exposes only fixed desktop operations',async()=>{
  const f=fixture();try{f.host();f.wrongProject();await expect(f.tasks.native.adopt('project-one',{requestKey:'wrong-scope',localTaskId:'native-fixture'})).rejects.toMatchObject({code:'NATIVE_BINDING_MISMATCH'});expect(f.store.listTasks(10)).toHaveLength(0);}finally{f.store.close();}
  expect(validPersonalOperation({action:'NATIVE_SOURCE_TASKS',projectId:'project-one'})).toBe(true);
  expect(validPersonalOperation({action:'NATIVE_TASK_ADOPT',projectId:'project-one',key:'one',body:{requestKey:'one',localTaskId:'native-fixture'}})).toBe(true);
  expect(validPersonalOperation({action:'NATIVE_TASK_ADOPT',projectId:'project-one',key:'one',body:{requestKey:'one',localTaskId:'native-fixture',instruction:'relaunch'}})).toBe(false);
 });
});
