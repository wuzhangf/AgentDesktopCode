import {test,expect,type Page,type Response} from '@playwright/test';
import {createHash} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {dirname} from 'node:path';

type Facts=Record<string,any>;
function required(name:string){const value=process.env[name];if(!value)throw new Error(`${name} is required for the real Mac lane`);return value;}
function sha256(bytes:Buffer){return createHash('sha256').update(bytes).digest('hex');}

/** Passive observations only. Every mutation/download below is a visible UI click. */
function observe(page:Page){
  const records:{method:string;path:string;status:number;request?:Facts;data:Facts}[]=[];
  const errors:string[]=[];
  page.on('pageerror',error=>errors.push(error.message));
  page.on('response',async(response:Response)=>{
    const url=new URL(response.url());
    if(!url.pathname.startsWith('/api/personal/v1/'))return;
    try{
      const envelope=await response.json();
      // No headers, cookies, tokens, or artifact base64 bytes are persisted.
      const data={...envelope.data};if('bytes'in data)delete data.bytes;
      records.push({method:response.request().method(),path:url.pathname,status:response.status(),
        ...(response.request().postData()?{request:response.request().postDataJSON()}:{}),data});
    }catch{/* cancelled polling during page navigation is expected */}
  });
  return {records,errors,
    latest(path:string){return records.filter(r=>r.method==='GET'&&r.path===path&&r.status===200).at(-1)?.data;},
    async detail(taskId:string,predicate:(d:Facts)=>boolean){
      let value:Facts|undefined;
      await expect.poll(()=>{value=this.latest('/api/personal/v1/tasks/'+taskId);return value?predicate(value):false;},
        {timeout:12*60_000,intervals:[1000,2000,3000]}).toBe(true);
      return value!;
    }};
}

test('MAC-001 Web clicks → production management → locked Mac Host → Apple results and guarded STOP',async({page},testInfo)=>{
  const base=new URL(required('MAC_WEB_URL'));
  expect(['127.0.0.1','localhost','[::1]']).toContain(base.hostname);
  expect(base.protocol).toBe('http:');
  const storeId=required('MAC_WEB_EXPECTED_STORE_ID'),workerId=required('MAC_WEB_EXPECTED_WORKER_ID');
  const observation=observe(page), evidence:Facts={schemaVersion:'mac-web-real-e2e/1',status:'FAIL',result:'FAIL',scope:'REAL_BROWSER_PRODUCTION_MANAGEMENT_LOCKED_MAC_APPLE_FIXTURE',baseUrl:base.origin};
  const seenBinding=(detail:Facts)=>{
    expect(detail.core).toBe('MACOS');expect(detail.sourceError).toBeUndefined();
    expect(detail.executionBinding).toMatchObject({kind:'WORKER_LOCAL',engineId:'macos',storeId,workerId});
    expect(detail.native.taskId).toBe(detail.executionBinding.localTaskId);
    expect(detail.native.engineId).toBe('macos');
  };
  async function launch(label:string,instruction:string){
    await page.goto(new URL('/personal.html#/tasks',base).href);
    const select=page.getByLabel('项目',{exact:true});
    await expect.poll(async()=>select.locator('option').allTextContents()).toContainEqual(expect.stringContaining(label));
    const option=select.locator('option').filter({hasText:label});await expect(option).toHaveCount(1);
    await select.selectOption((await option.getAttribute('value'))!);
    await expect(page.getByLabel('原生程序',{exact:true})).toHaveValue('macos');
    await expect(page.getByText(/Mac受管验证配置/)).toBeVisible();
    await page.getByLabel('任务要求',{exact:true}).fill(instruction);
    const reply=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/personal/v1/tasks'&&r.request().method()==='POST');
    await page.getByRole('button',{name:'开始任务',exact:true}).click();
    const response=await reply;expect([201,202]).toContain(response.status());
    const request=response.request().postDataJSON();
    expect(Object.keys(request).sort()).toEqual(['engineId','instruction','optionsRevision','projectId','requestKey']);
    expect(request.engineId).toBe('macos');
    const accepted=(await response.json()).data;
    await expect(page).toHaveURL(new RegExp('#/tasks/'+accepted.taskId+'$'));
    if(!accepted.accepted){
      await expect(page.getByRole('button',{name:'核对原提交',exact:true})).toBeVisible();
      // Navigation preserves the original management record; recovery is an actual UI action.
      await page.reload();await page.getByRole('button',{name:'核对原提交',exact:true}).click();
    }
    return {taskId:accepted.taskId,requestKey:request.requestKey,initialStatus:response.status(),initiallyAccepted:accepted.accepted};
  }
  try{
    const success=await launch(required('MAC_WEB_PROJECT_LABEL'),'MAC-001 Web actual Apple validation');
    if(process.env.MAC_WEB_EXPECT_PENDING==='1')expect(success.initiallyAccepted).toBe(false);
    const completed=await observation.detail(success.taskId,d=>d.native?.state==='SUCCEEDED'&&d.native?.quiescent===true);
    seenBinding(completed);
    expect(completed.native.localQuiescent).toBe(true);expect(completed.native.remoteStopConfirmed).toBe(true);
    await expect(page.getByText('状态：已完成',{exact:true})).toBeVisible();
    await expect(page.getByText('工作目录：来源未公开；基线：来源未公开',{exact:true})).toBeVisible();
    await expect(page.getByText(/执行／推理信息：尚未报告，以来源实报为准/)).toBeVisible();
    await expect(page.getByText(/效果核对：所有效果已静止/)).toBeVisible();
    await expect(page.getByText(new RegExp('原任务：'+completed.native.taskId))).toBeVisible();
    await page.screenshot({path:testInfo.outputPath('apple-completed.png'),fullPage:true});
    const artifactPath='/api/personal/v1/tasks/'+success.taskId+'/artifacts';
    await expect.poll(()=>observation.latest(artifactPath)?.items?.filter((a:Facts)=>a.status==='AVAILABLE').length??0,
      {timeout:60_000}).toBeGreaterThanOrEqual(3);
    const artifacts=observation.latest(artifactPath)!.items as Facts[];
    const downloads:Facts[]=[];let report:Facts|undefined;
    for(const artifact of artifacts){
      expect(artifact.status).toBe('AVAILABLE');expect(artifact.sha256).toMatch(/^[a-f0-9]{64}$/);
      const row=page.locator('p').filter({hasText:artifact.path+' · AVAILABLE'});await expect(row).toHaveCount(1);
      const downloadEvent=page.waitForEvent('download');
      await row.getByRole('button',{name:'下载文件',exact:true}).click();
      const download=await downloadEvent;expect(await download.failure()).toBeNull();
      const path=await download.path();expect(path).not.toBeNull();
      const bytes=await readFile(path!);expect(sha256(bytes)).toBe(artifact.sha256);
      if(artifact.path==='verification-report')report=JSON.parse(bytes.toString('utf8')).reports.at(-1);
      const saved=testInfo.outputPath(artifact.artifactId+'-'+download.suggestedFilename());await download.saveAs(saved);
      downloads.push({artifactId:artifact.artifactId,path:artifact.path,sha256:sha256(bytes),sizeBytes:bytes.length});
    }
    expect(report).toMatchObject({status:'passed',buildSucceeded:true,installSucceeded:true});
    expect(report!.executedTestIDs).toHaveLength(1);
    await page.reload();
    const recovered=await observation.detail(success.taskId,d=>d.native?.state==='SUCCEEDED');seenBinding(recovered);
    expect(recovered.native.taskId).toBe(completed.native.taskId);
    expect(recovered.native.nativeSessionId).toBe(completed.native.nativeSessionId);
    evidence.success={...success,binding:completed.executionBinding,native:completed.native,downloads,report,reloadedOriginalTask:true};

    const stopped=await launch(required('MAC_WEB_STOP_PROJECT_LABEL'),'MAC-001 Web running STOP validation');
    const running=await observation.detail(stopped.taskId,d=>d.native?.state==='VERIFYING'&&d.native?.capabilities?.stop===true);
    seenBinding(running);await expect(page.getByText('状态：正在验收',{exact:true})).toBeVisible();
    const stopResponse=page.waitForResponse(r=>new URL(r.url()).pathname===`/api/personal/v1/tasks/${stopped.taskId}/commands`&&r.request().method()==='POST');
    await page.getByRole('button',{name:'停止原生任务',exact:true}).click();
    const response=await stopResponse;expect(response.ok()).toBe(true);
    const wire=response.request().postDataJSON();
    expect(wire).toMatchObject({kind:'STOP',generation:running.native.generation,nativeSessionId:running.native.nativeSessionId,
      targetCommandId:running.native.currentCommandId});
    const stopReceipt=(await response.json()).data;
    expect(stopReceipt.source.state).toBe('REQUESTED');
    const unknown=await observation.detail(stopped.taskId,d=>d.native?.state==='RECOVERY_REQUIRED');
    seenBinding(unknown);expect(unknown.native.quiescent).toBe(false);expect(unknown.native.localQuiescent).toBe(false);
    expect(unknown.native.remoteStopConfirmed).toBe(true);
    await expect(page.getByText('状态：效果待核对',{exact:true})).toBeVisible();
    await expect(page.getByText('工作目录：来源未公开；基线：来源未公开',{exact:true})).toBeVisible();
    await expect(page.getByText(/执行／推理信息：尚未报告，以来源实报为准/)).toBeVisible();
    await expect(page.getByText(/效果核对：仍有未证结束的效果；本地：尚未证实静止；远端停止：已确认/)).toBeVisible();
    await page.reload();
    const receiptReply=page.waitForResponse(r=>new URL(r.url()).pathname.endsWith('/interaction-requests/'+wire.requestKey));
    await page.getByRole('button',{name:'只读核对停止请求',exact:true}).click();
    expect((await receiptReply).request().method()).toBe('GET');
    expect(observation.records.filter(r=>r.method==='POST'&&r.path===`/api/personal/v1/tasks/${stopped.taskId}/commands`)).toHaveLength(1);
    await expect(page.getByText(/效果核对：仍有未证结束的效果/)).toBeVisible();
    await page.screenshot({path:testInfo.outputPath('stop-unconfirmed.png'),fullPage:true});
    evidence.stop={...stopped,binding:running.executionBinding,guard:wire,receipt:stopReceipt,native:unknown.native,readonlyReconcileAfterReload:true};
    expect(observation.errors).toEqual([]);evidence.status='PASS';evidence.result='PASS';
  }finally{
    evidence.browserErrors=observation.errors;
    evidence.requests=observation.records.map(({method,path,status,request})=>({method,path,status,...(request?{request}:{})}));
    await writeFile(testInfo.outputPath('web-evidence.json'),JSON.stringify(evidence,null,2)+'\n');
    if(process.env.MAC_WEB_EVIDENCE_FILE){await mkdir(dirname(process.env.MAC_WEB_EVIDENCE_FILE),{recursive:true});await writeFile(process.env.MAC_WEB_EVIDENCE_FILE,JSON.stringify(evidence,null,2)+'\n');}
    await testInfo.attach('web-evidence',{path:testInfo.outputPath('web-evidence.json'),contentType:'application/json'});
  }
});
