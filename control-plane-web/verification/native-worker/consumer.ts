import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {mkdtempSync, mkdirSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ManagementStore} from '../../server/management/registry-store';
import {ConnectionHub} from '../../server/management/upstream';
import {PersonalTasks} from '../../server/management/tasks';
import {TaskMetricsReader} from '../../server/management/task-metrics';
import type {GatewayCallContext} from '../../server/management/service';
import type {NativeInput, NativeTaskDetail} from '../../../codeagent-desktop/packages/protocol/src/native-task';
import type {AvailableProject} from '../../../codeagent-desktop/packages/protocol/src/personal-task';
import type {NativeInputRequest} from '../../../codeagent-desktop/packages/protocol/src/native-task';
import {fixtureApproval} from './approval';

/** Real source and existing BFF consumer; fault injection only drops accepted HTTP replies. */
async function main() {
  const url=process.env.NWF_HOST_URL, token=process.env.NWF_HOST_TOKEN;
  if(!url||!token)throw new Error('Set NWF_HOST_URL and NWF_HOST_TOKEN using the central env loader');
  const directory=process.env.NWF_CONSUMER_OUT??mkdtempSync(join(tmpdir(),'nwf-consumer-'));
  mkdirSync(directory,{recursive:true});
  const store=new ManagementStore({path:join(directory,'management.db')});
  const timeout=Number(process.env.NWF_CONSUMER_TIMEOUT_MS??180000);
  assert(Number.isSafeInteger(timeout)&&timeout>0&&timeout<=900000);
  const posts:string[]=[],lookups:string[]=[];
  let dropCreate=true,dropInput=true;
  const fetchImpl:typeof fetch=async(input,init)=>{
    const path=new URL(String(input)).pathname;
    if(init?.method==='POST')posts.push(path);
    if(path.includes('/task-requests/')||path.includes('/interaction-requests/'))lookups.push(path);
    const response=await fetch(input,{...init,redirect:'error'});
    if(response.ok&&init?.method==='POST'&&((dropCreate&&path==='/local/v1/tasks')||(dropInput&&path.endsWith('/messages')))){
      if(path.endsWith('/messages'))dropInput=false;else dropCreate=false;
      await response.arrayBuffer();throw new Error('Accepted HTTP reply intentionally dropped by consumer acceptance test');
    }
    return response;
  };
  const hub=new ConnectionHub(store,()=>token,fetchImpl);
  hub.provision([{connectionId:'native',kind:'WORKER_LOCAL',baseUrl:url,tokenRef:'memory-only'}]);
  const tasks=new PersonalTasks(store,hub,'native-consumer-acceptance',new TaskMetricsReader());
  const ctx:GatewayCallContext={requestId:'native-consumer',acsSessionFor:async()=>{throw new Error('Native source must never enter ACS');}};
  const marker='NWF_'+randomUUID().replaceAll('-','');let taskId:string|undefined,stopRequest:NativeInput|undefined;
  const writeScript=`[System.IO.File]::WriteAllText((Join-Path (Get-Location) 'native-smoke.txt'), '${marker}', [System.Text.UTF8Encoding]::new($false))`;
  const readScript="[System.IO.File]::ReadAllText((Join-Path (Get-Location) 'native-smoke.txt'))";
  const approvals=new Map<string,NativeInput>();
  const guard=(n:NativeTaskDetail)=>{assert(n.generation&&n.nativeSessionId&&n.currentCommandId,'Source must provide original input guards');return {generation:n.generation,nativeSessionId:n.nativeSessionId,targetCommandId:n.currentCommandId,...(n.nativeTurnId?{nativeTurnId:n.nativeTurnId}:{})};};
  const completed=(n:NativeTaskDetail|undefined)=>n?.state==='SUCCEEDED'||n?.turns?.[n.currentCommandId??'']?.state==='SUCCEEDED';
  const wait=async(predicate:()=>Promise<boolean>,description:string)=>{const deadline=Date.now()+timeout;while(Date.now()<deadline){if(await predicate())return;await new Promise(r=>setTimeout(r,500));}throw new Error('Timed out waiting for '+description);};
  try{
    const available=(await tasks.available(ctx)).body.data as AvailableProject[];
    const project=available.find(p=>!process.env.NWF_SOURCE_PROJECT||p.sourceProjectRef===process.env.NWF_SOURCE_PROJECT);
    assert(project?.sourceProjectRef,'Registered host must advertise the selected source project');
    store.insertProject({projectId:'acceptance-project',projectRef:project.sourceProjectRef,connectionId:'native'});
    const options=(await tasks.options('acceptance-project',ctx)).body.data;
    assert(options.native?.host,'Expected worker-host/1 source');
    const preflight=options.native.engines.find(e=>!process.env.NWF_ENGINE||e.engineId===process.env.NWF_ENGINE);
    assert(preflight,'Selected engine must pass source preflight');
    const request={requestKey:'consumer-'+randomUUID(),projectId:'acceptance-project',engineId:preflight.engineId,optionsRevision:preflight.optionsRevision,
      instruction:`Create a file named native-smoke.txt containing exactly ${marker}. Then reply with ${marker}. ${preflight.engineId==='codex'?`For this controlled acceptance test use exactly this PowerShell script through the command tool: ${writeScript} . Do not run any other shell commands.`:'Use the available file tools to write the file.'}`};
    const uncertain=await tasks.create(request,ctx);assert.equal(uncertain.status,202,'Dropped reply must remain unconfirmed');
    taskId=(uncertain.body as any).data.taskId;assert(taskId);
    const accepted=await tasks.create(request,ctx);assert.equal(accepted.status,201);
    assert.equal(posts.filter(p=>p==='/local/v1/tasks').length,1);
    assert(lookups.some(p=>p.endsWith('/task-requests/'+request.requestKey)));
    await assert.rejects(tasks.create({...request,instruction:'changed'},ctx),(e:any)=>e.code==='IDEMPOTENCY_CONFLICT');
    let detail=(await tasks.detail(taskId,ctx)).body.data;
    assert.equal(detail.executionBinding?.kind,'WORKER_LOCAL');
    assert.equal(detail.executionBinding?.storeId,options.native.host.manifest.storeId);
    assert.equal(detail.executionBinding?.authorityId,options.native.host.manifest.authorityId);
    assert.equal(detail.executionBinding?.engineVersion,preflight.engineVersion);
    const approve=async()=>{
      const page=(await tasks.native.read(taskId!,'input-requests')).body.data as {items:NativeInputRequest[]};
      for(const q of page.items.filter(q=>q.state==='PENDING')){
        const previous=approvals.get(q.inputRequestId);if(previous){await tasks.native.request(taskId!,previous.requestKey);continue;}
        assert(detail.native,'Native question must have a bound task');
        const answer=fixtureApproval(q,detail.native,[writeScript,readScript]);assert(answer,'Unrecognized fixture approval; no response was sent');
        approvals.set(q.inputRequestId,answer);await tasks.native.input(taskId!,answer);
      }
    };
    await wait(async()=>{detail=(await tasks.detail(taskId!,ctx)).body.data;const output=(await tasks.native.read(taskId!,'output')).body.data;
      await approve();
      assert(!['FAILED','REJECTED','UNKNOWN'].includes(detail.native?.state??''),'Source failed before public output');
      return typeof output.text==='string'&&output.text.includes(marker)&&detail.native?.capabilities?.followUp===true&&completed(detail.native);},'first real reply and follow-up availability');
    assert.equal(detail.native?.configuredModel,process.env.NWF_EXPECT_MODEL??'deepseek-v4.1-flash','Expected selected real model binding');
    assert(detail.native);const followupMarker=marker+'_FOLLOWUP';
    const followup:NativeInput={...guard(detail.native),requestKey:'followup-'+randomUUID(),kind:'NATIVE_FOLLOW_UP',content:`Read native-smoke.txt and reply with its exact contents followed by ${followupMarker}. ${preflight.engineId==='codex'?`Use exactly this PowerShell script through the command tool: ${readScript} . Do not run any other shell commands.`:''}`};
    const receipt=await tasks.native.input(taskId,followup);assert.equal(receipt.body.data.state,'OBSERVED');
    await tasks.native.input(taskId,followup);
    assert.equal(posts.filter(p=>p.endsWith('/messages')).length,1,'Lost input reply may only reconcile original key');
    assert(lookups.some(p=>p.endsWith('/interaction-requests/'+followup.requestKey)));
    await wait(async()=>{detail=(await tasks.detail(taskId!,ctx)).body.data;const output=(await tasks.native.read(taskId!,'output')).body.data;await approve();return typeof output.text==='string'&&output.text.includes(followupMarker)&&detail.native?.capabilities?.followUp===true&&completed(detail.native);},'same-session follow-up reply');
    assert(detail.native);const stop:NativeInput={...guard(detail.native),requestKey:'stop-'+randomUUID(),kind:'STOP'};stopRequest=stop;await tasks.native.input(taskId,stop);
    await wait(async()=>{detail=(await tasks.detail(taskId!,ctx)).body.data;const receipt=await tasks.native.request(taskId!,stop.requestKey);return receipt.body.data.source?.state==='APPLIED'&&detail.native?.quiescent===true;},'applied stop receipt and source quiescence');
    const artifacts=(await tasks.native.read(taskId,'artifacts')).body.data as {items:{artifactId:string;path:string;status:string}[]};
    const artifact=artifacts.items.find(a=>a.path==='native-smoke.txt'&&a.status==='AVAILABLE');assert(artifact,'Expected real file bytes in sealed artifact manifest');
    const file=(await tasks.native.artifact(taskId,artifact.artifactId)).body.data as {bytes:string;sha256:string};const bytes=Buffer.from(file.bytes,'base64');
    assert.equal(createHash('sha256').update(bytes).digest('hex'),file.sha256);assert.equal(bytes.toString('utf8').trim(),marker);
    const metrics=(await tasks.native.metrics(taskId)).body.data,events=(await tasks.native.read(taskId,'events')).body.data;
    const activity=events as {items:{cursor?:string;kind?:string;occurredAt?:string}[]};
    assert(activity.items.length>0&&activity.items.every(e=>typeof e.cursor==='string'&&typeof e.kind==='string'&&typeof e.occurredAt==='string'),'Events must match the existing native activity consumer');
    const evidence={status:'PASS',consumer:'PersonalTasks/NativeTasks',host:options.native.host.manifest,capabilities:options.native.host.capabilities,taskId,executionBinding:detail.executionBinding,
      sourceState:detail.native?.state,configuredModel:detail.native?.configuredModel,quiescent:detail.native?.quiescent,sourceCreates:1,sourceFollowups:1,fixtureApprovals:approvals.size,originalKeyLookups:lookups.length,artifact:{artifactId:artifact.artifactId,sha256:file.sha256,size:bytes.length},metrics,events};
    writeFileSync(join(directory,'evidence.json'),JSON.stringify(evidence,null,2));
    console.log(JSON.stringify({status:'PASS',engine:preflight.engineId,version:preflight.engineVersion,evidence:join(directory,'evidence.json')}));
  }finally{
    // Cleanup is limited to this test's task; no process discovery or global stop.
    if(taskId)try{if(stopRequest)await tasks.native.request(taskId,stopRequest.requestKey);else{const n=(await tasks.detail(taskId,ctx)).body.data.native;if(n?.generation&&n.currentCommandId&&!(n.state==='CANCELLED'&&n.quiescent))await tasks.native.input(taskId,{generation:n.generation,targetCommandId:n.currentCommandId,nativeSessionId:n.nativeSessionId??null,nativeTurnId:n.nativeTurnId??null,requestKey:'cleanup-'+randomUUID(),kind:'STOP'});}}catch{}
    store.close();
  }
}
main().catch(error=>{console.error(JSON.stringify({status:'FAIL',code:error?.code??error?.name??'ERROR',message:error?.message??'Acceptance failed'}));process.exitCode=1;});
