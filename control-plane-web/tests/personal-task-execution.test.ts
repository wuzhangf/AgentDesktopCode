import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ManagementStore } from '../server/management/registry-store';
import { ConnectionHub } from '../server/management/upstream';
import { PersonalTasks } from '../server/management/tasks';
import { TaskMetricsReader } from '../server/management/task-metrics';
import { createPersonalGateway } from '../server/management/personal-control';
import { createManagementServer } from '../server/management/server';
import { validateRunStateResponse } from '../../codeagent-desktop/packages/protocol/src/validators';
import type { GatewayCallContext } from '../server/management/service';

function upstream() {
  const creates = new Map<string,unknown>(), messages = new Map<string,unknown>();
  let lose: 'create' | 'message' | undefined;
  let pendingRun = false, invalidCatalog = false;
  const seen: {path:string; body:any; key:string|null}[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const path = new URL(String(input)).pathname, key = new Headers(init?.headers).get('idempotency-key');
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    seen.push({path,body,key});
    let data: unknown;
    if (path === '/api/v2/client-sessions') data = {clientSessionId:'client-one',clientSessionToken:crypto.randomUUID(),storeId:'store-one',bootId:'boot-one',ttlMillis:60000,remainingTtlMillis:60000,acceptedProtocols:['v2']};
    else if (path.endsWith('/session-preflight')) data = { projectId:'source-one',workspaceAlias:'sample',headRevision:'head-one',revision:'rev-one',policyFingerprint:'policy-one',workspaceFingerprint:'workspace-one',authorityStatus:'AUTHORITATIVE',allowedIntents:['CODE'],suggestedWriteScope:[],writeScopeCeiling:['.'],modelAlias:'fixture-model',modelAvailability:'AVAILABLE' };
    else if (path === '/api/v2/capabilities') data = {serviceInstanceId:'service-one',protocolVersion:'2',features:{sessionV2:true,durableEvents:true,visibleOutputStream:true,worktreeExecution:true,mission:false,mcpHost:false,servicePty:false},limits:{maxDiffBytes:1000,maxEventPage:100,maxVisibleDeltaChars:1000},operations:[{id:'unrelated.optional',availability:'BLOCKED',contractVersion:'1',limits:{}}]};
    else if (path === '/api/v2/agent-profiles') data = {profiles:[{id:'code-profile',name:'Code profile',revision:'profile-1'}],loadErrors:[]};
    else if (path === '/api/v2/model-catalog') data = invalidCatalog ? {} : {defaultModel:'fixture-model',items:[{providerId:'fixture',modelAlias:'fixture-model',availability:'AVAILABLE',configured:true}]};
    else if (path === '/api/v2/projects') data = [{projectId:'source-one',workspaceAlias:'sample',displayName:'示例项目',authorityStatus:'AUTHORITATIVE'}];
    else if (path === '/api/v2/sessions' && init?.method === 'POST') {
      if (!creates.has(key!)) creates.set(key!, {sessionId:'session-one',sessionVersion:1});
      data = creates.get(key!);
      if (lose === 'create') {lose=undefined; throw new Error('response lost after commit');}
    } else if (path === '/api/v2/sessions/session-one/messages' && init?.method === 'POST') {
      if (!messages.has(key!)) messages.set(key!, {messageId:'message-one',clientMessageId:body.clientMessageId,taskId:'source-task',runId:pendingRun ? null : 'run-one',sessionVersion:2,status:'ACCEPTED'});
      data=messages.get(key!);
      if (lose === 'message') {lose=undefined; throw new Error('response lost after commit');}
    } else if (path === '/api/v2/sessions/session-one/messages') data = {sessionId:'session-one',items:[{id:'message-one',messageId:'message-one',clientMessageId:[...seen].reverse().find(v => v.body?.clientMessageId)?.body.clientMessageId,runId:'run-one'}]};
    else if (path === '/api/v2/sessions/session-one') data = {sessionId:'session-one',sessionVersion:2,agentProfileName:'Code Agent',messages:[]};
    else if (path === '/api/v2/runs/run-one') data = {runId:'run-one',taskId:'source-task',sessionId:'session-one',state:'COMPLETED',stateVersion:3,changedFileCount:1,startedAt:'2026-10-19T00:00:00Z',finishedAt:'2026-10-19T00:00:03Z',summary:'source summary'};
    else data = {};
    return new Response(JSON.stringify(data), {status:200,headers:{'content-type':'application/json'}});
  };
  return {fetchImpl,seen,creates,messages,lose:(stage:'create'|'message')=>{lose=stage;},queue:()=>{pendingRun=true;}, invalidCatalog:()=>{invalidCatalog=true;}};
}
function fixture(path=':memory:') {
  const store = new ManagementStore({path}), source=upstream();
  const hub=new ConnectionHub(store,()=>crypto.randomUUID(),source.fetchImpl);
  hub.provision([{connectionId:'acs',kind:'ACS_DIRECT',baseUrl:'http://127.0.0.1:7777',tokenRef:'test-memory'}]);
  if (!store.getProject('p-one')) store.insertProject({projectId:'p-one',projectRef:'source-one',connectionId:'acs'});
  const metrics = new TaskMetricsReader();
  const tasks=new PersonalTasks(store,hub,'test',metrics);
  const ctx: GatewayCallContext={requestId:'test',acsSessionFor:async()=>({clientSessionId:'client',token:crypto.randomUUID(),storeId:'store-one'})};
  return {store,source,tasks,ctx};
}
const request={requestKey:'launch-one',projectId:'p-one',instruction:'修改 README'};
describe('personal task ACS dispatch and recovery',()=>{
  it('freezes safe source requests, deduplicates concurrent clicks, and lists persisted tasks',async()=>{
    const f=fixture();
    try {
      const [a,b]=await Promise.all([f.tasks.create(request,f.ctx),f.tasks.create(request,f.ctx)]);
      expect(a).toEqual(b); expect(a.status).toBe(201);
      expect(f.source.creates.size).toBe(1);expect(f.source.messages.size).toBe(1);
      const wire=f.source.seen.find(v=>v.path==='/api/v2/sessions')!.body;
      expect(wire).toMatchObject({intent:'IMPLEMENT',executionMode:'MODIFY',permissionMode:'WORKSPACE',workspacePolicy:{mode:'ISOLATED_WORKTREE',startPolicy:'CLEAN_HEAD',expectedBaseRevision:'head-one'}});
      expect(wire).not.toHaveProperty('writeAllow');expect(wire).not.toHaveProperty('executionBinding');
      expect(f.tasks.list(new URLSearchParams()).body.data.items).toHaveLength(1);
      const id=(a.body as any).data.taskId;
      expect((await f.tasks.detail(id,f.ctx)).body.data.run?.summary).toBe('source summary');
      expect((await f.tasks.taskMetrics(id,f.ctx)).body.data.metrics.every(m=>m.value===null)).toBe(true);
    } finally {f.store.close();}
  });
  it.each(['create','message'] as const)('recovers a lost %s response after restart using frozen original keys',async stage=>{
    const dir=mkdtempSync(join(tmpdir(),'web-task-recovery-')),path=join(dir,'management.db');
    const f=fixture(path); f.source.lose(stage);
    const first=await f.tasks.create(request,f.ctx);expect(first.status).toBe(202);
    expect(f.store.ledgerGet(request.requestKey)?.state).toBe('PENDING');
    const id=(first.body as any).data.taskId; f.store.close();
    const store=new ManagementStore({path}),hub=new ConnectionHub(store,()=>crypto.randomUUID(),f.source.fetchImpl);
    const tasks=new PersonalTasks(store,hub,'restart',new TaskMetricsReader());
    try {
      const before=f.source.seen.length;
      tasks.request(request.requestKey);await tasks.detail(id,f.ctx);
      expect(f.source.seen.slice(before).some(v=>v.body?.content || v.path==='/api/v2/sessions')).toBe(false);
      const recovered=await tasks.create(request,f.ctx);expect(recovered.status).toBe(201);expect((recovered.body as any).data.taskId).toBe(id);
      expect(f.source.creates.size).toBe(1);expect(f.source.messages.size).toBe(1);
      expect(store.ledgerGet(request.requestKey)?.state).toBe('SETTLED');
      await expect(tasks.create({...request,instruction:'different'},f.ctx)).rejects.toMatchObject({code:'IDEMPOTENCY_CONFLICT'});
    } finally {store.close();}
  });
  it('rejects changed body even while initial preflight is in flight',async()=>{
    const f=fixture();try {
      const first=f.tasks.create(request,f.ctx);
      await expect(f.tasks.create({...request,instruction:'different'},f.ctx)).rejects.toMatchObject({code:'IDEMPOTENCY_CONFLICT'});
      await first;
    }finally{f.store.close();}
  });
  it('binds only the original message run and refuses a changed ACS store',async()=>{
    const f=fixture();try {
      f.source.queue();const created=await f.tasks.create(request,f.ctx),id=(created.body as any).data.taskId;
      expect((created.body as any).data.runId).toBeUndefined();
      expect((await f.tasks.detail(id,f.ctx)).body.data.runId).toBe('run-one');
      const changed={...f.ctx,acsSessionFor:async()=>({clientSessionId:'client',token:crypto.randomUUID(),storeId:'other-store'})};
      expect((await f.tasks.detail(id,changed)).body.data.sourceError).toContain('身份已改变');
      await expect(f.tasks.taskMetrics(id,changed)).rejects.toMatchObject({code:'SOURCE_IDENTITY_CHANGED'});
    }finally{f.store.close();}
  });
  it('does not gate default execution on an unavailable advanced model catalog',async()=>{
    const f=fixture();try {
      f.source.invalidCatalog();
      const options=await f.tasks.options('p-one',f.ctx);
      expect(options.body.data.models).toBeNull();
      expect(options.body.meta.supportedActions).toContain('TASK_CREATE');
      expect((await f.tasks.create(request,f.ctx)).status).toBe(201);
    } finally {f.store.close();}
  });
  it('resolves explicit profile/model selections from the catalog and sends only real source settings',async()=>{
    const f=fixture();try {
      const options=await f.tasks.options('p-one',f.ctx);
      const revision=options.body.data.models!.revision;
      await f.tasks.create({...request,agentProfileId:'code-profile',agentProfileRevision:'profile-1',modelSettings:{providerId:'fixture',modelAlias:'fixture-model',catalogRevision:revision}},f.ctx);
      const wire=f.source.seen.find(v=>v.path==='/api/v2/sessions')!.body;
      expect(wire.agentProfileId).toBe('code-profile');
      expect(wire.modelSettings).toEqual({providerId:'fixture',modelAlias:'fixture-model'});
    } finally {f.store.close();}
  });
  it('preserves source timing and summary through ServiceClient validation',()=>{
    expect(validateRunStateResponse({runId:'r',taskId:'t',state:'RUNNING',stateVersion:1,changedFileCount:0,startedAt:'2026-10-19T00:00:00Z',summary:'working'})).toMatchObject({startedAt:'2026-10-19T00:00:00Z',summary:'working'});
  });
  it('mounts personal API before management body parsing and keeps its origin guard',async()=>{
    const root=mkdtempSync(join(tmpdir(),'web-task-origin-'));
    const gateway=createPersonalGateway({dataDir:join(root,'personal'),connections:[]});
    const management=createManagementServer({root:join(root,'workers'),dist:root,personalGateway:gateway});
    await new Promise<void>(resolve=>management.server.listen(0,'127.0.0.1',resolve));
    const address=management.server.address() as {port:number};
    try {
      const url=`http://127.0.0.1:${address.port}/api/personal/v1/tasks`;
      expect((await fetch(url)).status).toBe(403);
      const headers={'x-personal-control':'1','x-personal-tab':'test-tab'};
      const [first,second] = await Promise.all([fetch(url,{headers}),fetch(url,{headers})]);
      expect(first.status).toBe(200);
      expect(first.headers.get('set-cookie')).toBe(second.headers.get('set-cookie'));
      expect((await fetch(url,{method:'POST',headers:{...headers,'content-type':'application/json'},body:JSON.stringify({...request,instruction:''})})).status).toBe(400);
      expect((await fetch(url,{headers:{...headers,origin:'https://foreign.invalid'}})).status).toBe(403);
    }finally{management.server.closeAllConnections();await new Promise<void>(resolve=>management.server.close(()=>resolve()));management.store.close();await gateway.close();}
  });
});
