import {test,expect} from '../fixtures/personal-real';

test('PCI-001 同 Session 后续消息产生新 Run，历史选择和重启保持原绑定',async({page,personalReal},testInfo)=>{
  const release=personalReal.gate.autoRelease();
  try {
    await page.goto(`${personalReal.url}/personal.html#/tasks`);
    const project=page.getByLabel('项目',{exact:true});
    await expect(project.locator('option').nth(1)).toBeAttached({timeout:30000});
    await project.selectOption((await project.locator('option').nth(1).getAttribute('value'))!);
    await page.getByLabel('任务要求',{exact:true}).fill('Change x.txt from v1 to v2 in the isolated workspace, then report the result.');
    await page.getByRole('button',{name:'开始任务',exact:true}).click();
    await page.waitForURL(/#\/tasks\/task-/, {timeout:60000});
    const id=page.url().split('/tasks/')[1]!.split(/[?#]/)[0]!;
    await expect(page.getByText('状态：已完成',{exact:true})).toBeVisible({timeout:180000});
    const first=await personalReal.bff<any>(`/api/personal/v1/tasks/${id}`);
    expect(first.body.data.runId).toBeTruthy();
    await expect(page.getByLabel('后续消息',{exact:true})).toBeEnabled();
    await page.getByLabel('后续消息',{exact:true}).fill('Confirm the current x.txt result and report completion.');
    await page.getByRole('button',{name:'发送后续消息',exact:true}).click();
    await expect(page.getByLabel('原消息请求')).toContainText('源已受理',{timeout:30000});
    await expect.poll(async()=>{
      const current=await personalReal.bff<any>(`/api/personal/v1/tasks/${id}`);
      return current.body.data.runId;
    },{timeout:120000}).not.toBe(first.body.data.runId);
    const second=await personalReal.bff<any>(`/api/personal/v1/tasks/${id}`);
    expect(second.body.data.sessionId).toBe(first.body.data.sessionId);
    expect(second.body.data.conversation.initialRunId).toBe(first.body.data.runId);
    expect(second.body.data.runId).toBeTruthy();
    await expect(page.getByLabel('查看运行').locator(`option[value="${first.body.data.runId}"]`)).toBeAttached();
    await page.getByLabel('查看运行').selectOption(first.body.data.runId);
    await expect.poll(async()=>{
      const out=await personalReal.bff<any>(`/api/personal/v1/tasks/${id}/commands?runId=${first.body.data.runId}`);
      return out.body.data.run?.runId;
    }).toBe(first.body.data.runId);
    const history=await personalReal.bff<any>(`/api/personal/v1/tasks/${id}/messages`);
    expect(history.body.data.items.some((m:any)=>m.content?.includes('Confirm the current'))).toBe(true);
    await personalReal.restartBff();await page.reload();
    const recovered=await personalReal.bff<any>(`/api/personal/v1/tasks/${id}`);
    expect(recovered.body.data.sessionId).toBe(first.body.data.sessionId);
    expect(recovered.body.data.runId).toBe(second.body.data.runId);
    expect(recovered.body.data.conversation.initialRunId).toBe(first.body.data.runId);
    await expect(page.getByLabel('后续消息',{exact:true})).toBeVisible();
    await page.getByLabel('输入意图',{exact:true}).scrollIntoViewIfNeeded();
    await page.screenshot({path:testInfo.outputPath('conversation.png')});
  }finally{release();}
});

test.describe('真实交互与兼容接管',()=>{
  test.use({personalRealOptions:{observation:true,foundation:true,collaboration:true}});
  async function running(page:import('@playwright/test').Page,f:import('../fixtures/personal-real').PersonalRealFixture){
    await page.goto(`${f.url}/personal.html#/tasks`);
    const project=page.getByLabel('项目',{exact:true});await expect(project.locator('option').nth(1)).toBeAttached({timeout:30000});
    await project.selectOption((await project.locator('option').nth(1).getAttribute('value'))!);
    await page.getByLabel('任务要求',{exact:true}).fill('Change x.txt from v1 to v2 in the isolated workspace, then report the result.');
    await page.getByRole('button',{name:'开始任务',exact:true}).click();await page.waitForURL(/#\/tasks\/task-/,{timeout:60000});
    await f.gate.waitForRequest(1);return page.url().split('/tasks/')[1]!.split(/[?#]/)[0]!;
  }
  async function original(f:import('../fixtures/personal-real').PersonalRealFixture,id:string,key:string){return (await f.bff<any>(`/api/personal/v1/tasks/${id}/interaction-requests/${key}`)).body.data;}
  test('PCI-002 运行中建议真实消费，普通消息排队，旁支与主汇报分别查询源结果',async({page,personalReal:f})=>{
    const id=await running(page,f),first=(await f.bff<any>(`/api/personal/v1/tasks/${id}`)).body.data;
    await page.getByLabel('输入意图',{exact:true}).selectOption('BOUNDARY');
    await page.getByLabel('后续消息',{exact:true}).fill('Keep the original goal and report progress at the next safe boundary.');
    await expect(page.getByRole('button',{name:'发送当前执行建议',exact:true})).toBeEnabled({timeout:30000});
    await page.getByRole('button',{name:'发送当前执行建议',exact:true}).click();
    let adviceKey='';await expect.poll(async()=>{const out=await f.bff<any>(`/api/personal/v1/tasks/${id}/interactions?runId=${first.runId}`);adviceKey=out.body.data.requests.find((r:any)=>r.request.kind==='BOUNDARY')?.request.requestKey??'';return adviceKey;}).not.toBe('');
    await expect.poll(async()=> (await original(f,id,adviceKey)).result?.state).toBe('PENDING');
    f.gate.allow(1);await f.gate.waitForRequest(2);
    await expect.poll(async()=> (await original(f,id,adviceKey)).result?.state,{timeout:30000}).toBe('CONSUMED');
    const sid=first.sessionId,detail=(await f.bff<any>(`/api/personal/v1/tasks/${id}`)).body.data;
    const queued=await f.bff<any>(`/api/personal/v1/tasks/${id}/messages`,{method:'POST',body:{requestKey:'pci-queued',clientMessageId:'pci-queued-client',content:'After completion, confirm the result.',expectedSessionVersion:detail.session.sessionVersion}});
    expect(queued.body.data.acceptance.status).toBe('QUEUED');
    const side=await f.bff<any>(`/api/personal/v1/tasks/${id}/side-questions`,{method:'POST',body:{kind:'SIDE_QUESTION',requestKey:'pci-side',targetRunId:first.runId,question:'Summarize the visible progress.',researchCount:0}});
    expect(side.status).toBe(202);
    // Main call 2 stays in flight. Release only the independent sidecar model calls.
    const {existsSync,readdirSync}=await import('node:fs'),{join}=await import('node:path');
    const timer=setInterval(()=>{const gate=join(f.root,'gate');for(const name of readdirSync(gate)){const m=/^request-(\d+)$/.exec(name);if(m&&Number(m[1])>=3&&!existsSync(join(gate,`allow-${m[1]}`)))f.gate.allow(Number(m[1]));}},100);
    try{
      await expect.poll(async()=> (await original(f,id,'pci-side')).result?.state,{timeout:90000}).toBe('SUCCEEDED');
      const answer=await original(f,id,'pci-side');expect(answer.result.answer).toBeTruthy();
      await f.bff<any>(`/api/personal/v1/tasks/${id}/side-questions`,{method:'POST',body:{kind:'SIDE_QUESTION',requestKey:'pci-side-second',targetRunId:first.runId,question:'Summarize once more from the current snapshot.',researchCount:0}});
      await expect.poll(async()=> (await original(f,id,'pci-side-second')).result?.state,{timeout:90000}).toBe('SUCCEEDED');
      const secondSide=await original(f,id,'pci-side-second');expect(secondSide.steps.auxiliary.sessionId).toBe(answer.steps.auxiliary.sessionId);
      const before=readdirSync(join(f.root,'gate')).filter(n=>n.startsWith('request-')).length;
      await original(f,id,'pci-side');await original(f,id,'pci-side');
      expect(readdirSync(join(f.root,'gate')).filter(n=>n.startsWith('request-')).length).toBe(before);
      expect((await f.bff<any>(`/api/personal/v1/tasks/${id}`)).body.data.runId).toBe(first.runId);
      const interactions=(await f.bff<any>(`/api/personal/v1/tasks/${id}/interactions?runId=${first.runId}`)).body.data;
      const reportKey='pci-report';const report=await f.bff<any>(`/api/personal/v1/tasks/${id}/boundary-requests`,{method:'POST',body:{kind:'BOUNDARY',requestKey:reportKey,targetRunId:first.runId,source:{schemaVersion:'run-boundary-request/1',requestId:reportKey,kind:'REQUEST_REPORT',expectedExecutionEpoch:interactions.segments.current.executionEpoch,text:'Report progress and continue the original task.',sourceRefs:[]}}});
      expect(report.status).toBe(202);
      await expect.poll(async()=> (await original(f,id,reportKey)).result?.state).toBe('PENDING');
      f.gate.allow(2);
      await expect.poll(async()=> (await original(f,id,reportKey)).result?.state,{timeout:90000}).toBe('ANSWERED');
      const result=await original(f,id,reportKey);expect(result.result.reportMessage.id).toBe(result.result.messageId);
      expect(result.binding.sessionId).toBe(sid);
    }finally{clearInterval(timer);}
  });
  test('PCI-003 预检不暂停，确认同 product-code 接管后源证明 ACTIVE',async({page,personalReal:f})=>{
    const id=await running(page,f),detail=(await f.bff<any>(`/api/personal/v1/tasks/${id}`)).body.data;
    const catalog=(await f.bff<any>(`/api/personal/v1/tasks/${id}/interaction-catalog`)).body.data;
    const profile=catalog.profiles.profiles.find((p:any)=>p.id===detail.session.agentProfileId)??catalog.profiles.profiles[0];expect(profile).toBeTruthy();
    const preflight=await f.bff<any>(`/api/personal/v1/tasks/${id}/handoffs/preflight`,{method:'POST',body:{kind:'PREFLIGHT',requestKey:'pci-preflight',targetRunId:detail.runId,source:{schemaVersion:'assignment-transition-request/1',target:{harnessId:'product-code',agentProfileId:profile.id,agentProfileRevision:profile.revision,modelSelection:{mode:'KEEP_EFFECTIVE'}},pendingInputPolicy:'CANCEL_PENDING'}}});
    expect(preflight.status).toBe(202);await expect.poll(async()=> (await original(f,id,'pci-preflight')).result?.state,{timeout:30000}).toBe('ELIGIBLE');
    const still=(await f.bff<any>(`/api/personal/v1/tasks/${id}`)).body.data;expect(still.run.state).toBe('RUNNING');
    const accepted=await f.bff<any>(`/api/personal/v1/tasks/${id}/handoffs`,{method:'POST',body:{kind:'HANDOFF',requestKey:'pci-handoff',targetRunId:detail.runId,preflightKey:'pci-preflight'}});expect(accepted.status).toBe(202);
    await expect.poll(async()=> (await original(f,id,'pci-handoff')).result?.state).toMatch(/ACCEPTED|QUIESCING/);
    const release=f.gate.autoRelease();try{await expect.poll(async()=> (await original(f,id,'pci-handoff')).result?.state,{timeout:150000}).toBe('ACTIVE');}finally{release();}
    const result=await original(f,id,'pci-handoff');expect(result.result.sourceEpoch).not.toBe(result.result.targetEpoch);
    expect(result.result.runId).toBe(detail.runId);
  });
});

test.describe('真实消息丢响应恢复',()=>{
  test.use({personalRealOptions:{proxy:true,observation:true,foundation:true}});
  test('PCI-004 源消息受理后代理丢回复，重启 BFF 按原 key 查回，不再次发送',async({page,personalReal:f})=>{
    const release=f.gate.autoRelease();try{
      await page.goto(`${f.url}/personal.html#/tasks`);const project=page.getByLabel('项目',{exact:true});
      await expect(project.locator('option').nth(1)).toBeAttached({timeout:30000});await project.selectOption((await project.locator('option').nth(1).getAttribute('value'))!);
      await page.getByLabel('任务要求',{exact:true}).fill('Change x.txt from v1 to v2 in the isolated workspace, then report the result.');
      await page.getByRole('button',{name:'开始任务',exact:true}).click();await page.waitForURL(/#\/tasks\/task-/,{timeout:60000});
      const id=page.url().split('/tasks/')[1]!.split(/[?#]/)[0]!;await expect(page.getByText('状态：已完成',{exact:true})).toBeVisible({timeout:180000});
      const first=(await f.bff<any>(`/api/personal/v1/tasks/${id}`)).body.data;
      f.proxy!.addRule({path:/^\/api\/v2\/sessions\/[^/]+\/messages$/,mode:'dropAfterReply'});
      const body={requestKey:'pci-lost-message',clientMessageId:'pci-lost-client',content:'Confirm completion.',expectedSessionVersion:first.session.sessionVersion};
      const lost=await f.bff<any>(`/api/personal/v1/tasks/${id}/messages`,{method:'POST',body});expect(lost.status).toBe(202);expect(lost.body.data.acceptance).toBeUndefined();
      expect(f.proxy!.facts.filter(v=>v.droppedClientReply&&v.path.endsWith('/messages'))).toHaveLength(1);
      const before=f.proxy!.facts.filter(v=>v.path.endsWith('/messages')).length;f.proxy!.clearRules();
      await f.restartBff();await page.reload();
      const read=await f.bff<any>(`/api/personal/v1/tasks/${id}/interaction-requests/${body.requestKey}`);
      expect(read.body.data.receipt.status).toBe('APPLIED');expect(read.body.data.acceptance.clientMessageId).toBe(body.clientMessageId);
      await f.bff<any>(`/api/personal/v1/tasks/${id}/messages`);await f.bff<any>(`/api/personal/v1/tasks/${id}/interaction-requests/${body.requestKey}`);
      expect(f.proxy!.facts.filter(v=>v.path.endsWith('/messages'))).toHaveLength(before);
      const history=(await f.acsSession<any>(`/api/v2/sessions/${first.sessionId}/messages?limit=100`)).body;
      expect(history.items.filter((m:any)=>m.clientMessageId===body.clientMessageId&&String(m.role).toLowerCase()==='user')).toHaveLength(1);
    }finally{release();}
  });
});
