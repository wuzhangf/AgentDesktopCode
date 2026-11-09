/** Formal model choice and Apple task creation through the real production UI. */
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,stat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium,_electron as electron,expect} from '@playwright/test';
const ready=JSON.parse(await readFile(process.env.MAC_REPAIR_E2E_READY,'utf8')),out=process.env.MAC_REPAIR_E2E_OUTPUT,web=ready.lane==='web';await mkdir(out,{recursive:false});
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),require=createRequire(import.meta.url),sha=b=>createHash('sha256').update(b).digest('hex');
const report={schemaVersion:'mac-native-repair-client/1',result:'FAIL',lane:ready.lane,model:ready.model,phases:[]},records=[],errors=[];let page,app,context;
function observe(){page.on('pageerror',e=>errors.push(e.message));page.on('response',async r=>{const u=new URL(r.url());if(!u.pathname.startsWith('/api/personal/v1/'))return;try{records.push({path:u.pathname,method:r.request().method(),status:r.status(),data:(await r.json()).data});}catch{}});}
async function launch(){
 if(web){context=await chromium.launchPersistentContext(path.join(out,'browser-profile'),{headless:true,acceptDownloads:true,viewport:{width:1440,height:1100}});page=context.pages()[0]??await context.newPage();observe();await page.goto(ready.managementOrigin+'/personal.html#/tasks');}
 else{const env={...process.env,CODEAGENT_DESKTOP_PROFILE:'native-model-repair'};delete env.ELECTRON_RUN_AS_NODE;app=await electron.launch({executablePath:require('electron'),args:[root],cwd:root,env,timeout:30000});page=await app.firstWindow();observe();await expect(page.getByRole('heading',{name:'Mac 任务',exact:true})).toBeVisible();report.security=await app.evaluate(({BrowserWindow})=>{const p=BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences();return {sandbox:p.sandbox,contextIsolation:p.contextIsolation,nodeIntegration:p.nodeIntegration};});assert.deepEqual(report.security,{sandbox:true,contextIsolation:true,nodeIntegration:false});}
}
async function close(){if(app){await app.close();app=undefined;}if(context){await context.close();context=undefined;}}
async function facts(id){if(!web){try{return JSON.parse(await page.getByTestId('task-facts').textContent({timeout:1000}));}catch{return undefined;}}return records.filter(r=>r.path==='/api/personal/v1/tasks/'+id&&r.method==='GET'&&r.status===200).at(-1)?.data;}
async function waitFacts(id,test){let v;await expect.poll(async()=>{v=await facts(id);return !!v&&test(v);},{timeout:1200000,intervals:[500,1000,2500]}).toBe(true);return v;}
try{
 await launch();const select=page.getByLabel(web?'项目':'Mac 项目',{exact:true});await expect(select).toBeVisible();const option=select.locator('option').filter({hasText:ready.projectLabel});await expect(option).toHaveCount(1);await select.selectOption(await option.getAttribute('value'));
 const models=page.getByLabel('Mac 模型',{exact:true});await expect(models).toBeVisible();await models.selectOption(ready.model);await page.getByLabel(web?'任务要求':'Mac 任务要求',{exact:true}).fill('Repair the frozen Project39 XCTest with the selected native model, adopt only its authorized sealed source, rebuild and rerun the same frozen test.');
 let task;
 if(web){const response=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/personal/v1/tasks'&&r.request().method()==='POST');await page.getByRole('button',{name:'开始任务',exact:true}).click();const r=await response;assert.equal(r.status(),202);const body=r.request().postDataJSON();assert.deepEqual(body.executionOptions,{model:ready.model,accessMode:'WORKSPACE'});const d=(await r.json()).data;assert.equal(d.accepted,false);await page.waitForURL(new RegExp('#/tasks/'+d.taskId+'$'));task={id:d.taskId,key:body.requestKey,url:page.url()};}
 else{await page.getByRole('button',{name:'开始 Mac 任务',exact:true}).click();const d=await waitFacts(undefined,v=>!!v.taskId);assert.equal(d.accepted,false);assert.deepEqual(d.request.executionOptions,{model:ready.model,accessMode:'WORKSPACE'});task={id:d.taskId,key:d.request.requestKey};}
 report.create=task;report.phases.push('visible configured model choice → formal Mac Apple task create; actual accepted reply lost');
 await close();await writeFile(ready.restartRequest,'restart');await expect.poll(async()=>stat(ready.restartAck).then(()=>true,()=>false),{timeout:30000}).toBe(true);await launch();
 if(web){await page.goto(task.url);await page.getByRole('button',{name:'核对原提交',exact:true}).click();}
 else{await expect(page.getByLabel('原请求键',{exact:true})).toHaveValue(task.key);await page.getByRole('button',{name:'只读恢复原请求',exact:true}).click();const d=await waitFacts(task.id,v=>v.taskId===task.id);if(!d.accepted)await page.getByRole('button',{name:'使用原键继续核对提交',exact:true}).click();}
 report.phases.push('client/BFF cold restart → original request key reconciliation, no replacement create');
 if(ready.scenario==='stop'){
  await expect.poll(async()=>stat(ready.stopReady).then(()=>true,()=>false),{timeout:1200000,intervals:[100,250]}).toBe(true);
  report.beforeStop=JSON.parse(await readFile(ready.stopReady,'utf8'));assert.equal(report.beforeStop.model,ready.model);assert.equal(report.beforeStop.parentTaskID,(await waitFacts(task.id,d=>d.accepted)).native.taskId);
  const button=page.getByRole('button',{name:web?'停止原生任务':'停止 Mac 任务',exact:true});await expect(button).toBeEnabled();await button.click();
  await expect(page.getByRole('button',{name:'只读核对停止请求',exact:true})).toBeVisible();const url=page.url();await close();await launch();if(web)await page.goto(url);
  await page.getByRole('button',{name:'只读核对停止请求',exact:true}).click();
  report.stopped=await waitFacts(task.id,d=>d.native?.intakeClosed===true&&d.native?.state==='RECOVERY_REQUIRED');assert.equal(report.stopped.native.quiescent,false);assert.equal(report.stopped.native.remoteStopConfirmed,false);
  if(web){await expect(page.getByText(/停止原请求：/)).toContainText('REQUESTED');report.stop=await page.getByText(/停止原请求：/).textContent();}
  else{await expect.poll(async()=>JSON.parse(await page.getByTestId('stop-facts').textContent()).receipt?.state).toBe('OBSERVED');report.stop=JSON.parse(await page.getByTestId('stop-facts').textContent());}
  report.phases.push('real model file-tool event observed while native child RUNNING → parent guarded STOP → lost STOP reply → client cold restart and original STOP lookup; UNKNOWN remains explicit');
  await page.screenshot({path:path.join(out,'stopped.png'),fullPage:true});assert.deepEqual(errors,[]);report.result='PASS';
 }else{
 const completed=await waitFacts(task.id,d=>d.accepted&&d.native?.state==='SUCCEEDED'&&d.native?.quiescent===true);assert.equal(completed.request.requestKey,task.key);assert.equal(completed.native.executionOptions.model,ready.model);assert.equal(completed.executionBinding.storeId,ready.identity.storeId);report.completed=completed;
 if(web){
  await expect(page.getByRole('button',{name:'下载文件',exact:true})).toHaveCount(5,{timeout:30000});const artifacts=records.filter(r=>r.path==='/api/personal/v1/tasks/'+task.id+'/artifacts'&&r.status===200).at(-1).data.items;report.artifactHashes=[];
  for(let i=0;i<5;i++){const promise=page.waitForEvent('download');await page.getByRole('button',{name:'下载文件',exact:true}).nth(i).click();const download=await promise,bytes=await readFile(await download.path()),meta=artifacts[i];assert.equal(sha(bytes),meta.sha256);report.artifactHashes.push({artifactId:meta.artifactId,path:meta.path,sha256:sha(bytes)});if(meta.path==='verification-report'){const snapshot=JSON.parse(bytes);assert.deepEqual(snapshot.reports.map(r=>r.status),['failed','passed']);assert.equal(snapshot.delegation.sourceID,'mac-local-code');assert.match(snapshot.delegation.authority,/^mac-host:\/\//);report.verification={reports:snapshot.reports,delegation:snapshot.delegation,candidate:snapshot.candidate};}}
 }else{
  const buttons=page.getByRole('button',{name:/^核验成果 /});await expect(buttons).toHaveCount(5,{timeout:30000});
  for(let i=0;i<5;i++){await expect(buttons.nth(i)).toBeEnabled();await buttons.nth(i).click();await expect(page.getByTestId('verified-artifact')).toHaveCount(i+1);}
  report.artifactHashes=await page.getByTestId('verified-artifact').allTextContents();report.output=JSON.parse(await page.getByTestId('native-output').textContent());
 }
 report.phases.push('native Host code role → immutable source → isolated adoption → actual Apple failed/passed → all five published artifact hashes verified in UI');await page.screenshot({path:path.join(out,'completed.png'),fullPage:true});assert.deepEqual(errors,[]);report.result='PASS';
 }
}catch(error){report.error={name:error.name,message:error.message};await page?.screenshot({path:path.join(out,'failure.png'),fullPage:true}).catch(()=>{});}finally{report.rendererErrors=errors;await close();await writeFile(path.join(out,'result.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({result:report.result,lane:ready.lane,model:ready.model,error:report.error}));}
if(report.result!=='PASS')process.exitCode=1;
