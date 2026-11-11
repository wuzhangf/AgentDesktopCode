import {describe, it, expect} from 'vitest';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ManagementStore} from '../server/management/registry-store';
import {ConnectionHub} from '../server/management/upstream';
import {PersonalTasks} from '../server/management/tasks';
import {TaskMetricsReader} from '../server/management/task-metrics';
import type {GatewayCallContext} from '../server/management/service';
function fixture(path = ':memory:', source = upstream()) {
  const store = new ManagementStore({path}), hub = new ConnectionHub(store, () => 'fixture', source.fetchImpl);
  hub.provision([{connectionId:'acs',kind:'ACS_DIRECT',baseUrl:'http://127.0.0.1:7777',tokenRef:'memory-fixture'}]);
  if (!store.getTask('task-one')) {
    store.upsertTask({taskId:'task-one'});
    store.ledgerBegin({requestKey:'launch',route:'TASK_CREATE',bodyDigest:'fixture',subjectId:'task-one'});
    store.saveLaunch('task-one','launch',{request:{requestKey:'launch',projectId:'p',instruction:'first'},connectionId:'acs',storeId:'store-one',create:{},session:{sessionId:'sid',sessionVersion:1},message:{clientMessageId:'first-client',content:'first',expectedSessionVersion:1},acceptance:{messageId:'first',clientMessageId:'first-client',taskId:'source-first',runId:'run-one'},runId:'run-one'});
  }
  const tasks = new PersonalTasks(store,hub,'test',new TaskMetricsReader());
  const ctx: GatewayCallContext = {requestId:'test',acsSessionFor:async()=>({clientSessionId:'client',token:crypto.randomUUID(),storeId:'store-one'})};
  return {store,tasks,ctx,source};
}
function upstream() {
  const seen: {path:string; method:string; key:string|null; body:any}[] = [];
  const accepted = new Map<string,any>(), commands = new Map<string,any>();
  let active = 'run-one', lose = false, lookup404 = false;
  const boundaries=new Map<string,any>(),handoffs=new Map<string,any>();
  let approvalVersion=7,turnState='SUCCEEDED';
  const page:any = {schemaVersion:'session-message-page/1',sessionId:'sid',transcriptRevision:'1',items:[{id:'first',clientMessageId:'first-client',runId:'run-one',role:'USER',status:'COMPLETED',content:'first',createdAt:1}],hasOlder:false,hasNewer:false,rangeComplete:true};
  const fetchImpl: typeof fetch = async (url, init) => {
    const path = new URL(String(url)).pathname, method = init?.method ?? 'GET', key = new Headers(init?.headers).get('idempotency-key'), body = init?.body ? JSON.parse(String(init.body)) : null;
    seen.push({path,method,key,body});
    const json = (data:any,status=200) => new Response(JSON.stringify(data),{status,headers:{'content-type':'application/json'}});
    if (path === '/api/v2/sessions/sid') return json({sessionId:'sid',sessionVersion:2,activeRunId:active || null});
    if (path === '/api/v2/sessions/sid/foundation') return json({schemaVersion:'session-foundation/1',storeId:'store-one',sessionId:'sid',executionOwnership:'HOST_SESSION',capabilities:{commandReceiptV1:'READY'}});
    if (path.endsWith('/messages') && method === 'POST') {
      if (!accepted.has(key!)) {
        if (body.expectedSessionVersion !== 2) return json({code:'SESSION_VERSION_CONFLICT',status:409,message:'stale session version'},409);
        const response = {messageId:'second',clientMessageId:body.clientMessageId,taskId:'source-second',runId:'run-two',status:active ? 'QUEUED' : 'ACCEPTED',receiptId:'receipt-two'};
        accepted.set(key!,response); page.items.push({id:'second',...response,role:'USER',content:body.content,createdAt:2});
      }
      if (lose) {lose=false;throw new Error('reply lost after source acceptance');}
      return json(accepted.get(key!),202);
    }
    if (path.endsWith('/messages')) return json(page);
    if (path === '/api/v2/operations/lookup' || path === '/api/v2/operations/receipt-two') {
      const result = accepted.get(key ?? 'message-key');
      if (lookup404 || !result) return json({code:'OPERATION_NOT_FOUND',status:404},404);
      return json({receiptId:'receipt-two',operation:'session.message',resourceId:'sid',status:'APPLIED',requestHash:'hash',createdAtMillis:1,result});
    }
    if(path==='/api/v2/agent-profiles')return json({profiles:[{id:'profile-one',name:'Code',revision:'profile-r1'}],loadErrors:[]});
    if(path==='/api/v2/model-catalog')return json({items:[{providerId:'fixture',modelAlias:'model-one',configured:true,availability:'AVAILABLE'}]});
    if(path==='/api/v2/sessions/sid/observation-snapshots')return json({snapshotId:'snap-one',sessionId:'sid',runId:active,capturedAt:'2026-10-19T00:00:00Z'});
    if(path==='/api/v2/sessions/sid/context-packages')return json({packageId:'package-one',sessionId:'sid'});
    if(path==='/api/v2/sessions/sid/auxiliary-sessions'&&method==='GET')return json({items:[{sessionId:'aux-one',parentSessionId:'sid',state:'ACTIVE'}]});
    if(path==='/api/v2/sessions/sid/auxiliary-sessions')return json({sessionId:'aux-one',parentSessionId:'sid'});
    if(path==='/api/v2/sessions/aux-one/foundation')return json({sessionId:'aux-one',parentSessionId:'sid',sessionVersion:'9007199254740993'});
    if(path==='/api/v2/sessions/aux-one/auxiliary-turns')return json({sessionId:'aux-one',turnId:body.turnId,state:'QUEUED',packageId:'package-one'});
    if(path.startsWith('/api/v2/sessions/aux-one/auxiliary-turns/'))return json({sessionId:'aux-one',turnId:path.split('/').at(-1),state:turnState,packageId:'package-one',answer:'side answer'});
    if(path==='/api/v2/runs/run-one/execution-segments')return json({current:{executionEpoch:'1'}});
    if(path==='/api/v2/runs/run-one/boundary-requests'&&method==='POST') {const v={runId:'run-one',sessionId:'sid',requestId:key,state:'PENDING',kind:body.kind};boundaries.set(key!,v);return json(v);}
    if(path.startsWith('/api/v2/runs/run-one/boundary-requests/'))return json(boundaries.get(path.split('/').at(-1)!)??{code:'BOUNDARY_INPUT_NOT_FOUND'},boundaries.has(path.split('/').at(-1)!)?200:404);
    if(path==='/api/v2/runs/run-one/assignment-transitions/preflight')return json({runId:'run-one',state:'ELIGIBLE',sourceEpoch:'1',runStateVersion:'9007199254740993',modelSettingsRevision:'9007199254740994',preflightDigest:'preflight-digest'});
    if(path==='/api/v2/runs/run-one/assignment-transitions'&&method==='POST'){const v={runId:'run-one',transitionId:key,state:'ACCEPTED'};handoffs.set(key!,v);return json(v);}
    if(path.startsWith('/api/v2/runs/run-one/assignment-transitions/'))return json(handoffs.get(path.split('/').at(-1)!));
    if(path==='/api/v2/approvals/budget-one')return json({approvalId:'budget-one',kind:'BUDGET',runId:'run-one',version:7,requestFingerprint:'budget-fingerprint',decisionStatus:'PENDING',allowedActions:['APPROVE','DENY']});
    if(path==='/api/v2/approvals/approval-one')return json({approvalId:'approval-one',sessionId:'sid',runId:'run-one',version:approvalVersion,requestFingerprint:'fingerprint-one',allowedActions:['APPROVE','DENY'],requiresUserAction:true});
    if(path==='/api/v2/approvals/approval-foreign')return json({approvalId:'approval-foreign',sessionId:'foreign',runId:'foreign',version:7,requestFingerprint:'fingerprint-one',allowedActions:['APPROVE']});
    if(path==='/api/v2/approvals/approval-one/decisions'){approvalVersion++;return json({approvalId:'approval-one',decision:body.decision});}
    const cmd = path.match(/\/runs\/([^/]+)\/commands(?:\/([^/]+))?$/);
    if (cmd) {
      if (method === 'POST') {
        const receipt = {schemaVersion:'run-command-receipt/1',commandId:key,receiptId:'rcpt-'+key,sessionId:'sid',runId:cmd[1],intent:body.intent,phase:'ACCEPTED',receiptRevision:'1',acceptedAt:'2026-10-19T00:00:00Z',actor:{principalId:'p',clientSessionId:'client'},acceptedStateVersion:2,observedStateVersion:2,observedRunState:'RUNNING',terminal:false};
        commands.set(key!,receipt);return json(receipt,202);
      }
      if (cmd[2]) return commands.has(cmd[2]) ? json(commands.get(cmd[2])) : json({code:'CONTROL_NOT_FOUND',status:404,message:'command not found'},404);
      return json({items:[...commands.values()].filter(c=>c.runId===cmd[1]),nextBefore:null});
    }
    const run = path.match(/\/runs\/([^/]+)$/);
    if (run) return json({runId:run[1],sessionId:run[1] === 'foreign' ? 'someone-else' : 'sid',taskId:run[1] === 'run-one' ? 'source-first' : 'source-second',state:'RUNNING',stateVersion:2,availableActions:['PAUSE','STOP'],changedFileCount:0});
    return json({});
  };
  return {seen,fetchImpl,accepted,commands,page,boundaries,handoffs,setTurnState:(state:string)=>{turnState=state;},setActive:(id:string)=>{active=id;},lose:()=>{lose=true;},lookup404:(v:boolean)=>{lookup404=v;}};
}
const body = {requestKey:'message-key',clientMessageId:'second-client',content:'second',expectedSessionVersion:2};
const data = (out:any) => out.body.data;
describe('personal conversation and multi-run bindings',()=>{
  it('freezes and recovers an accepted message after restart by lookup, without reposting',async()=>{
    const path=join(mkdtempSync(join(tmpdir(),'personal-interaction-')),'management.db');
    const f=fixture(path);f.source.lose();
    expect((await f.tasks.interactions.create('task-one',body,f.ctx)).status).toBe(202);
    const frozen:any=f.store.db.prepare('SELECT * FROM personal_interaction_requests').get();expect(frozen.dispatch_started_at).toBeTruthy();
    f.store.close();const next=fixture(path,f.source);
    try {
      const before=f.source.seen.filter(x=>x.path.endsWith('/messages')&&x.method==='POST').length;
      const result=data(await next.tasks.interactions.request('task-one',body.requestKey,next.ctx));
      expect(result.acceptance.messageId).toBe('second');expect(result.acceptance.status).toBe('QUEUED');
      expect(f.source.seen.filter(x=>x.path.endsWith('/messages')&&x.method==='POST')).toHaveLength(before);
      expect(f.source.seen.find(x=>x.path==='/api/v2/operations/lookup')).toMatchObject({key:body.requestKey,body:{operation:'session.message',resourceId:'sid',idempotencyKey:body.requestKey}});
      await expect(next.tasks.interactions.create('task-one',{...body,content:'changed'},next.ctx)).rejects.toMatchObject({status:409});
      await expect(next.tasks.interactions.request('another-task',body.requestKey,next.ctx)).rejects.toMatchObject({status:404});
    }finally{next.store.close();}
  });
  it('lookup 404 never resends, explicit replay preserves the original body and key',async()=>{
    const f=fixture();try{
      f.source.lose();await f.tasks.interactions.create('task-one',body,f.ctx);f.source.lookup404(true);
      const before=f.source.seen.filter(x=>x.path.endsWith('/messages')&&x.method==='POST').length;
      expect(data(await f.tasks.interactions.request('task-one',body.requestKey,f.ctx)).acceptance).toBeUndefined();
      expect(f.source.seen.filter(x=>x.path.endsWith('/messages')&&x.method==='POST')).toHaveLength(before);
      await f.tasks.interactions.create('task-one',body,f.ctx);expect(f.source.accepted.size).toBe(1);
      const posts=f.source.seen.filter(x=>x.path.endsWith('/messages')&&x.method==='POST');expect(posts[0]).toEqual(posts[1]);
    }finally{f.store.close();}
  });
  it('selects active/latest/history separately and rejects foreign or unobserved runs',async()=>{
    const f=fixture();try{
      await f.tasks.interactions.create('task-one',body,f.ctx);f.source.setActive('run-two');
      expect(data(await f.tasks.detail('task-one',f.ctx)).conversation).toMatchObject({initialRunId:'run-one',activeRunId:'run-two',selectedRunId:'run-two'});
      expect(data(await f.tasks.detail('task-one',f.ctx,new URLSearchParams('runId=run-one'))).runId).toBe('run-one');
      expect(data(await f.tasks.detail('task-one',f.ctx,new URLSearchParams('runId=foreign'))).sourceError).toBeTruthy();
      await expect(f.tasks.leaf('task-one','output',f.ctx,new URLSearchParams('runId=unobserved'))).rejects.toMatchObject({code:'RUN_BINDING_MISMATCH'});
      f.source.setActive('');expect(data(await f.tasks.detail('task-one',f.ctx)).runId).toBe('run-two');
      expect(f.tasks.facts(f.tasks.row('task-one'))!.runId).toBe('run-one');
    }finally{f.store.close();}
  });
  it('keeps old pending controls on their frozen Run and permits controls on a new Run',async()=>{
    const f=fixture();try{
      await f.tasks.commandCreate('task-one',{requestKey:'stop-first',targetRunId:'run-one',intent:'STOP'},f.ctx);
      await f.tasks.interactions.create('task-one',body,f.ctx);f.source.setActive('run-two');
      await f.tasks.commandCreate('task-one',{requestKey:'pause-second',targetRunId:'run-two',intent:'PAUSE',expectedStateVersion:2},f.ctx);
      const view=data(await f.tasks.commands('task-one',new URLSearchParams('runId=run-two'),f.ctx));
      expect(view.run.runId).toBe('run-two');expect(view.allowedIntents).toContain('STOP');
      expect(view.pendingRequests.map((r:any)=>r.targetRunId).sort()).toEqual(['run-one','run-two']);
      const start=f.source.seen.length;await f.tasks.command('task-one','stop-first',f.ctx);
      expect(f.source.seen.slice(start).some(x=>x.path==='/api/v2/runs/run-one/commands/stop-first')).toBe(true);
    }finally{f.store.close();}
  });
  it('retains version conflicts for new intent and rejects changed store writes',async()=>{
    const f=fixture();try{
      const result=data(await f.tasks.interactions.create('task-one',{...body,expectedSessionVersion:1},f.ctx));
      expect(result.sourceRejection.code).toBe('SESSION_VERSION_CONFLICT');
      const changed:GatewayCallContext={...f.ctx,acsSessionFor:async()=>({clientSessionId:'client',token:crypto.randomUUID(),storeId:'other'})};
      await expect(f.tasks.interactions.create('task-one',{...body,requestKey:'changed-store'},changed)).rejects.toMatchObject({code:'SOURCE_IDENTITY_CHANGED'});
    }finally{f.store.close();}
  });
});

describe('personal durable engagement inputs',()=>{
  it('side question freezes each exact step once and GET never creates another model turn',async()=>{
    const f=fixture();try{
      const request={kind:'SIDE_QUESTION',requestKey:'side-key',targetRunId:'run-one',question:'What is the progress?'};
      expect((await f.tasks.engagements.create('task-one',request,f.ctx)).status).toBe(202);
      await f.tasks.engagements.idle();
      const before=f.source.seen.filter(x=>x.method==='POST').length;
      const result=data(await f.tasks.engagements.request('task-one','side-key',f.ctx));
      expect(result.result).toMatchObject({state:'SUCCEEDED',answer:'side answer'});
      expect(Object.keys(result.steps)).toEqual(['snapshot','package','auxiliary','turn']);
      expect(f.source.seen.find(x=>x.path.endsWith('/auxiliary-turns')&&x.method==='POST')?.body).toMatchObject({expectedSessionVersion:'9007199254740993',researchTasks:[]});
      await f.tasks.engagements.request('task-one','side-key',f.ctx);await f.tasks.engagements.create('task-one',request,f.ctx);
      expect(f.source.seen.filter(x=>x.method==='POST')).toHaveLength(before);
      await expect(f.tasks.engagements.create('task-one',{...request,question:'changed'},f.ctx)).rejects.toMatchObject({code:'IDEMPOTENCY_CONFLICT'});
    }finally{await f.tasks.engagements.idle();f.store.close();}
  });
  it('boundary accepted and consumed are distinct, query observes the original request',async()=>{
    const f=fixture();try{
      const request={kind:'BOUNDARY',requestKey:'boundary-key',targetRunId:'run-one',source:{schemaVersion:'run-boundary-request/1',requestId:'boundary-key',kind:'CONTEXT_ADVICE',expectedExecutionEpoch:'1',text:'advice',sourceRefs:[]}};
      await f.tasks.engagements.create('task-one',request,f.ctx);await f.tasks.engagements.idle();
      expect(data(await f.tasks.engagements.request('task-one','boundary-key',f.ctx)).result.state).toBe('PENDING');
      f.source.boundaries.get('boundary-key').state='CONSUMED';
      expect(data(await f.tasks.engagements.request('task-one','boundary-key',f.ctx)).result.state).toBe('CONSUMED');
      expect(f.source.seen.filter(x=>x.method==='POST'&&x.path.endsWith('/boundary-requests'))).toHaveLength(1);
    }finally{await f.tasks.engagements.idle();f.store.close();}
  });
  it('preflight does not handoff, confirmation freezes exact decimal versions and catalog target',async()=>{
    const f=fixture();try{
      const request={kind:'PREFLIGHT',requestKey:'preflight-key',targetRunId:'run-one',source:{schemaVersion:'assignment-transition-request/1',target:{harnessId:'product-code',agentProfileId:'profile-one',agentProfileRevision:'profile-r1',modelSelection:{mode:'KEEP_EFFECTIVE'}},pendingInputPolicy:'CANCEL_PENDING'}};
      await f.tasks.engagements.create('task-one',request,f.ctx);await f.tasks.engagements.idle();
      expect(f.source.handoffs.size).toBe(0);
      await f.tasks.engagements.create('task-one',{kind:'HANDOFF',requestKey:'handoff-key',targetRunId:'run-one',preflightKey:'preflight-key'},f.ctx);await f.tasks.engagements.idle();
      expect(f.source.seen.find(x=>x.path.endsWith('/assignment-transitions')&&x.method==='POST')?.body).toMatchObject({expectedRunStateVersion:'9007199254740993',expectedModelSettingsRevision:'9007199254740994',expectedExecutionEpoch:'1',transitionId:'handoff-key'});
      await expect(f.tasks.engagements.create('task-one',{...request,requestKey:'bad-target',source:{...request.source,target:{...request.source.target,agentProfileRevision:'old'}}},f.ctx)).rejects.toMatchObject({code:'PROFILE_UNAVAILABLE'});
    }finally{await f.tasks.engagements.idle();f.store.close();}
  });
  it('approval verifies scope, original version and fingerprint; GET never decides or refreshes guards',async()=>{
    const f=fixture();try{
      const request={kind:'APPROVAL_DECISION',requestKey:'approve-key',targetRunId:'run-one',approvalId:'approval-one',source:{expectedVersion:7,requestFingerprint:'fingerprint-one',decision:'APPROVE'}};
      await expect(f.tasks.engagements.create('task-one',{...request,approvalId:'approval-foreign'},f.ctx)).rejects.toMatchObject({status:403});
      await expect(f.tasks.engagements.create('task-one',{...request,source:{...request.source,expectedVersion:6}},f.ctx)).rejects.toMatchObject({code:'APPROVAL_VERSION_CONFLICT'});
      await f.tasks.engagements.create('task-one',request,f.ctx);await f.tasks.engagements.idle();
      await f.tasks.engagements.request('task-one','approve-key',f.ctx);await f.tasks.engagements.create('task-one',request,f.ctx);
      expect(f.source.seen.filter(x=>x.method==='POST'&&x.path.endsWith('/decisions'))).toHaveLength(1);
    }finally{await f.tasks.engagements.idle();f.store.close();}
  });
});

it('resolves legacy BUDGET approval through its source Run before projecting session and actions',async()=>{
  const f=fixture();try{
    const budget=data(await f.tasks.engagements.approvals('task-one',new URLSearchParams(),f.ctx,'budget-one'));
    expect(budget).toMatchObject({sessionId:'sid',requiresUserAction:true,kind:'BUDGET'});
    expect(f.source.seen.some(x=>x.path==='/api/v2/runs/run-one')).toBe(true);
  }finally{f.store.close();}
});

it('new controls require targetRunId while frozen legacy requests keep their original Run',async()=>{
  const f=fixture();try{
    const original={requestKey:'legacy-stop',intent:'STOP'};
    await expect(f.tasks.commandCreate('task-one',original,f.ctx)).rejects.toMatchObject({code:'TARGET_RUN_REQUIRED'});
    const {canonicalDigest}=await import('../server/management/canonical');
    f.store.transact(()=>{
      f.store.ledgerBegin({requestKey:original.requestKey,route:'TASK_COMMAND_CREATE',subjectId:'task-one',bodyDigest:canonicalDigest(original)});
      f.store.insertControlRequest({requestKey:original.requestKey,taskId:'task-one',requestJson:JSON.stringify(original),sourceBindingJson:JSON.stringify({connectionId:'acs',storeId:'store-one',sessionId:'sid',runId:'run-one',taskId:'source-first'}),sourceRequestJson:JSON.stringify({schemaVersion:'run-command/1',commandId:original.requestKey,intent:'STOP',reasonCode:'PERSONAL_TASK_CONTROL'}),createdAt:f.store.now()});
    });
    await f.tasks.interactions.create('task-one',body,f.ctx);f.source.setActive('run-two');
    await f.tasks.commandCreate('task-one',original,f.ctx);
    expect(f.source.seen.filter(x=>x.method==='POST'&&x.path.endsWith('/commands')).at(-1)?.path).toBe('/api/v2/runs/run-one/commands');
  }finally{f.store.close();}
});

it('uses one default sidecar and refuses a second question while the first is unresolved',async()=>{
  const f=fixture();try{
    f.source.setTurnState('RUNNING');
    const request={kind:'SIDE_QUESTION',requestKey:'side-first',targetRunId:'run-one',question:'first question'};
    await Promise.all([f.tasks.engagements.create('task-one',request,f.ctx),f.tasks.engagements.create('task-one',request,f.ctx)]);await f.tasks.engagements.idle();
    await expect(f.tasks.engagements.create('task-one',{...request,requestKey:'side-second',question:'second question'},f.ctx)).rejects.toMatchObject({code:'SIDE_QUESTION_PENDING'});
    f.source.setTurnState('SUCCEEDED');await f.tasks.engagements.create('task-one',{...request,requestKey:'side-second',question:'second question'},f.ctx);await f.tasks.engagements.idle();
    expect(f.source.seen.filter(x=>x.method==='POST'&&x.path.endsWith('/auxiliary-sessions'))).toHaveLength(1);
    expect(f.source.seen.filter(x=>x.method==='POST'&&x.path.endsWith('/observation-snapshots'))).toHaveLength(2);
    expect(f.source.seen.filter(x=>x.method==='POST'&&x.path.endsWith('/auxiliary-turns'))).toHaveLength(2);
  }finally{await f.tasks.engagements.idle();f.store.close();}
});
