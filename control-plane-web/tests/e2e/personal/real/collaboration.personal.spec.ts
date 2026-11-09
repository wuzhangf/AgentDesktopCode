import {test,expect} from '../fixtures/personal-real';

test.use({personalRealOptions:{observation:true,foundation:true,collaboration:true,writable:true,proxy:true}});
test('PCC-001 个人任务真实双子执行、无写入预览、采纳丢回复后只读恢复',async({page,personalReal:f},testInfo)=>{
  await page.goto(`${f.url}/personal.html#/tasks`);
  const project=page.getByLabel('项目',{exact:true});await expect(project.locator('option').nth(1)).toBeAttached({timeout:30000});await project.selectOption((await project.locator('option').nth(1).getAttribute('value'))!);
  await page.getByLabel('任务要求',{exact:true}).fill('PARENT_MAIN_INSPECT: incorporate authorized x.txt and y.txt candidates in the managed workspace and report the verification.');
  await page.getByRole('button',{name:'开始任务',exact:true}).click();await page.waitForURL(/#\/tasks\/task-/,{timeout:60000});
  const id=page.url().split('/tasks/')[1]!.split(/[?#]/)[0]!,base=`/api/personal/v1/tasks/${id}/collaboration`;
  await f.gate.waitForRequest(1);
  const first=(await f.bff<any>(`/api/personal/v1/tasks/${id}`)).body.data;
  await page.getByText('写候选、协作计划与显式采纳',{exact:true}).click();
  const units=page.getByRole('group',{name:/^子任务 [12]$/});await expect(units).toHaveCount(2);
  for(let i=0;i<2;i++){
    const unit=units.nth(i),name=i?'Y':'X';
    await page.getByLabel('目标',{exact:true}).nth(i).fill(`CHILD_WRITE_${name}: change ${name.toLowerCase()}.txt from v1 to v2 without processes.`);
    await page.getByLabel(/^读取范围/).nth(i).fill(`${name.toLowerCase()}.txt`);
    await page.getByLabel(/^写入范围/).nth(i).fill(`${name.toLowerCase()}.txt`);
  }
  await page.getByLabel('子任务名称',{exact:true}).nth(0).fill('修改 X');
  await page.getByLabel('子任务名称',{exact:true}).nth(1).fill('修改 Y');
  await page.getByRole('button',{name:'创建计划草稿',exact:true}).click();
  let gid='';await expect.poll(async()=>{const r=(await f.bff<any>(base)).body.data;gid=r.source.items?.[0]?.entityId??'';return gid;},{timeout:30000}).not.toBe('');
  const group=async()=>(await f.bff<any>(`${base}/groups/${gid}?runId=${first.runId}`)).body.data;
  await expect(page.getByRole('button',{name:'确认授权 / 当前 epoch 重新授权',exact:true})).toBeEnabled({timeout:30000});
  await page.getByRole('button',{name:'确认授权 / 当前 epoch 重新授权',exact:true}).click();
  await expect.poll(async()=>(await group()).state).toBe('AUTHORIZED');
  await page.getByRole('button',{name:'明确开始 / 继续未派发项',exact:true}).click();
  await expect.poll(async()=>(await group()).state).toBe('WAITING_FREEZE');
  f.gate.allow(1);await f.gate.waitForRequest(2);
  await expect.poll(async()=>(await group()).state,{timeout:90000}).toBe('READY');
  const ready=await group();expect(ready.candidates).toHaveLength(2);
  expect(ready.children.filter((v:any)=>!v.start).every((v:any)=>v.quiescent&&v.state==='CANDIDATE_READY')).toBe(true);
  const rejected={requestKey:'pcc-stale-selection',targetRunId:first.runId,operation:{action:'SELECT',groupId:gid,body:{schemaVersion:'collaboration-selection/1',selectionId:'pcc-stale-selection',expectedGraphRevision:'0',dependencyPolicy:'REQUIRE_CLOSURE',units:ready.candidates.map((c:any)=>({unitId:c.unitId,candidateId:c.entityId,candidateFingerprint:c.candidateFingerprint}))}}};
  expect((await f.bff<any>(base+'/operations',{method:'POST',body:rejected})).status).toBe(202);
  await expect.poll(async()=>(await f.bff<any>(base+'/requests/pcc-stale-selection')).body.data.state).toBe('REJECTED');
  expect((await f.bff<any>(base+'/operations',{method:'POST',body:{...rejected,operation:{...rejected.operation,body:{...rejected.operation.body,expectedGraphRevision:ready.revision}}}})).status).toBe(409);
  const childHistory=(await f.bff<any>(`${base}/groups/${gid}/executions/${ready.children.find((c:any)=>!c.start).entityId}/messages`)).body.data;
  expect(childHistory.messages.some((m:any)=>m.role.toLowerCase()==='user')).toBe(true);expect(childHistory.messages.some((m:any)=>m.role.toLowerCase()==='assistant')).toBe(true);
  const selection=page.getByRole('group',{name:'只选择完整候选；依赖必须闭合'});
  await expect(selection.getByRole('checkbox')).toHaveCount(2);
  await selection.getByRole('checkbox').nth(0).check();await selection.getByRole('checkbox').nth(1).check();
  await page.getByRole('button',{name:'固定本次选择',exact:true}).click();
  await expect(page.getByRole('button',{name:'创建新集成预览',exact:true})).toBeEnabled();await page.getByRole('button',{name:'创建新集成预览',exact:true}).click();
  await expect.poll(async()=>(await group()).previews?.length).toBe(1);
  const preview=(await group()).previews[0];expect(preview.state).toBe('READY');expect(preview.conflicts??[]).toEqual([]);
  for(const file of ['x.txt','y.txt']){
    const current=(await f.bff<any>(`${base}/files?kind=PREVIEW_FILES&groupId=${gid}&entityId=${preview.entityId}&side=CURRENT&path=${file}`)).body.data;
    expect(Buffer.from(current.content,'base64').toString()).toBe('v1');
    const proposed=(await f.bff<any>(`${base}/files?kind=PREVIEW_FILES&groupId=${gid}&entityId=${preview.entityId}&side=INTEGRATION&path=${file}`)).body.data;
    expect(Buffer.from(proposed.content,'base64').toString()).toBe('v2');
  }
  f.proxy!.addRule({path:/\/collaboration-groups\/[^/]+\/adoptions$/,mode:'dropAfterReply'});
  await page.getByRole('button',{name:'明确采纳此完整预览并验证主上下文',exact:true}).click();
  await expect.poll(async()=>(await group()).adoptions?.length).toBe(1);
  const adoption=(await group()).adoptions[0],writes=f.proxy!.facts.filter(v=>v.path.endsWith('/adoptions')).length;
  f.proxy!.clearRules();await f.restartBff();await page.reload();
  const recovered=await f.bff<any>(`${base}/requests/${adoption.entityId}`);expect(recovered.body.data.observation.entityId).toBe(adoption.entityId);
  f.gate.allow(2);await f.gate.waitForRequest(3);
  await expect.poll(async()=>{const a=(await group()).adoptions[0];return {content:a.contentApplied,verification:a.verificationPassed,context:a.contextCommitted};},{timeout:90000}).toEqual({content:true,verification:true,context:true});
  await f.bff(`${base}/requests/${adoption.entityId}`);expect(f.proxy!.facts.filter(v=>v.path.endsWith('/adoptions')).length).toBe(writes);
  const {readFileSync}=await import('node:fs'),{join}=await import('node:path');expect(readFileSync(join(f.root,'host','workspace','x.txt'),'utf8')).toBe('v1');expect(readFileSync(join(f.root,'host','workspace','y.txt'),'utf8')).toBe('v1');
  if(await page.locator('details.writable-collaboration-panel').getAttribute('open')===null)await page.getByText('写候选、协作计划与显式采纳',{exact:true}).click();
  await expect(page.getByLabel('协作计划',{exact:true})).toHaveValue(gid);
  await expect(page.getByLabel('不可变预览',{exact:true})).toHaveValue(preview.entityId);
  await expect(page.getByText(/文件：已写入；验证：通过；主上下文：已提交/)).toBeVisible({timeout:30000});
  await page.getByText(/文件：已写入；验证：通过；主上下文：已提交/).scrollIntoViewIfNeeded();
  await page.screenshot({path:testInfo.outputPath('adoption.png')});
  const cancelCreate={requestKey:'pcc-cancel-group',targetRunId:first.runId,operation:{action:'CREATE',body:{schemaVersion:'collaboration-group-create/1',requestId:'pcc-cancel-group',expectedExecutionEpoch:'1',graph:{schemaVersion:'collaboration-graph/1',samePathMode:'REJECT',requestedParallelism:1,units:[{unitId:'cancel-unit',kind:'READ_ONLY',objective:'inspect current x',readScope:['x.txt'],writeScope:[],dependsOn:[],required:false,allowNoChanges:true}]}}}};
  expect((await f.bff<any>(base+'/operations',{method:'POST',body:cancelCreate})).status).toBe(202);
  await expect.poll(async()=>(await f.bff<any>(base+'/requests/pcc-cancel-group')).body.data.observation?.state).toBe('DRAFT');
  expect((await f.bff<any>(base+'/operations',{method:'POST',body:{requestKey:'pcc-cancel',targetRunId:first.runId,operation:{action:'CANCEL_GROUP',groupId:'pcc-cancel-group',body:{schemaVersion:'collaboration-action/1',requestId:'pcc-cancel'}}}})).status).toBe(202);
  await expect.poll(async()=>(await f.bff<any>(base+'/requests/pcc-cancel')).body.data.observation?.state).toBe('CANCELLED');
  expect((await f.bff<any>(`/api/personal/v1/tasks/${id}`)).body.data.run.state).toBe('RUNNING');
  const release=f.gate.autoRelease();try{await expect.poll(async()=>(await f.bff<any>(`/api/personal/v1/tasks/${id}`)).body.data.run.state,{timeout:90000}).toBe('COMPLETED');}finally{release();}
});
