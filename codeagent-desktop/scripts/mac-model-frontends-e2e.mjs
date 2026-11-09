import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,stat} from 'node:fs/promises';
import {createHash,randomBytes} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium,_electron as electron,expect} from '@playwright/test';
// Only visible production UI buttons mutate task state. Disk/HTTP observation
// independently verifies effects and original identities; no model fixtures.
const ready=JSON.parse(await readFile(process.env.MAC_MODEL_E2E_READY,'utf8')),out=process.env.MAC_MODEL_E2E_OUTPUT;
await mkdir(out,{recursive:false});
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),require=createRequire(import.meta.url),web=ready.lane==='web';
const marker='MODEL_E2E_'+randomBytes(6).toString('hex'),sha=b=>createHash('sha256').update(b).digest('hex');
const report={schemaVersion:'mac-model-frontend-client/1',lane:ready.lane,model:ready.model,result:'FAIL',phases:[]},errors=[],records=[];
let app,context,page;
function observe(){page.on('pageerror',e=>errors.push(e.message));page.on('response',async r=>{const u=new URL(r.url());if(!u.pathname.startsWith('/api/personal/v1/'))return;try{records.push({path:u.pathname,method:r.request().method(),status:r.status(),data:(await r.json()).data});}catch{}});}
async function launch(){
 if(!web){const env={...process.env,CODEAGENT_DESKTOP_PROFILE:'mac-model-e2e'};delete env.ELECTRON_RUN_AS_NODE;app=await electron.launch({executablePath:require('electron'),args:[root],cwd:root,env,timeout:30000});page=await app.firstWindow();observe();await expect(page.getByRole('heading',{name:'Mac 任务',exact:true})).toBeVisible();
 const security=await app.evaluate(({BrowserWindow})=>{const p=BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences();return {sandbox:p.sandbox,contextIsolation:p.contextIsolation,nodeIntegration:p.nodeIntegration};});assert.deepEqual(security,{sandbox:true,contextIsolation:true,nodeIntegration:false});report.security=security;
 }else{context=await chromium.launchPersistentContext(path.join(out,'browser-profile'),{headless:true,acceptDownloads:true,viewport:{width:1440,height:1000}});page=context.pages()[0]??await context.newPage();observe();await page.goto(ready.managementOrigin+'/personal.html#/tasks');}
}
async function close(){if(app){await app.close();app=undefined;}if(context){await context.close();context=undefined;}}
async function facts(id){if(!web){try{return JSON.parse(await page.getByTestId('task-facts').textContent({timeout:1000}));}catch{return undefined;}}return records.filter(r=>r.path==='/api/personal/v1/tasks/'+id&&r.method==='GET'&&r.status===200).at(-1)?.data;}
async function waitFacts(id,test,timeout=180000){let v;await expect.poll(async()=>{v=await facts(id);return !!v&&test(v);},{timeout,intervals:[200,500,1000]}).toBe(true);return v;}
async function create(instruction){
 const previous=!web?(await facts())?.taskId:undefined;
 if(web)await page.goto(ready.managementOrigin+'/personal.html#/tasks');
 const select=page.getByLabel(web?'项目':'Mac 项目',{exact:true});await expect(select).toBeVisible();const option=select.locator('option').filter({hasText:'这台 Mac'});await expect(option).toHaveCount(1);await select.selectOption(await option.getAttribute('value'));
 await expect(page.getByLabel('Mac 模型',{exact:true})).toBeVisible();await page.getByLabel('Mac 模型',{exact:true}).selectOption(ready.model);await page.getByLabel(web?'任务要求':'Mac 任务要求',{exact:true}).fill(instruction);
 if(web){const response=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/personal/v1/tasks'&&r.request().method()==='POST');await page.getByRole('button',{name:'开始任务',exact:true}).click();const r=await response;assert([201,202].includes(r.status()));const body=r.request().postDataJSON();assert.deepEqual(body.executionOptions,{model:ready.model,accessMode:'WORKSPACE'});const v=(await r.json()).data;await page.waitForURL(new RegExp('#/tasks/'+v.taskId+'$'));return {id:v.taskId,key:body.requestKey,accepted:v.accepted,url:page.url()};}
 await page.getByRole('button',{name:'开始 Mac 任务',exact:true}).click();await expect(page.getByTestId('task-facts')).toBeAttached();const d=await waitFacts(undefined,v=>!!v.taskId&&v.taskId!==previous);return {id:d.taskId,key:d.request.requestKey,accepted:d.accepted};
}
async function recover(task){if(web){await page.getByRole('button',{name:'核对原提交',exact:true}).click();}else{await expect(page.getByLabel('原请求键',{exact:true})).toHaveValue(task.key);await page.getByRole('button',{name:'只读恢复原请求',exact:true}).click();const d=await waitFacts(task.id,v=>v.taskId===task.id);if(!d.accepted)await page.getByRole('button',{name:'使用原键继续核对提交',exact:true}).click();}}
const screenshot=name=>page.screenshot({path:path.join(out,name+'.png'),fullPage:true});
try{
 await launch();const created=await create(`请使用 write 工具在当前工作目录写 proof.txt，唯一内容为 ${marker}，然后使用 read 工具读回，最后只回复该标记。不要使用 bash，不要创建其他文件。`);report.create=created;assert.equal(created.accepted,false,'accepted create reply must actually be lost');
 await close();await writeFile(ready.restartRequest,'restart');await expect.poll(async()=>stat(ready.restartAck).then(()=>true,()=>false),{timeout:30000}).toBe(true);await launch();if(web)await page.goto(created.url);await recover(created);report.phases.push('client cold restart + persisted BFF restart → original create key only');
 const completed=await waitFacts(created.id,d=>d.accepted&&d.native?.state==='SUCCEEDED');assert.equal(completed.request.requestKey,created.key);assert.equal(completed.native.executionOptions.model,ready.model);assert.equal(completed.native.executionKernel,'pi-agent-core/1.4.0');assert.equal(completed.executionBinding.storeId,ready.identity.storeId);report.completed=completed;
 if(!web){await expect(page.getByRole('button',{name:'核验成果 proof.txt',exact:true})).toBeEnabled();await page.getByRole('button',{name:'核验成果 proof.txt',exact:true}).click();await expect(page.getByTestId('verified-artifact')).toHaveCount(1);report.artifactSha256=(await page.getByTestId('verified-artifact').textContent()).match(/[a-f0-9]{64}$/)[0];}
 else{await expect(page.getByRole('button',{name:'下载文件',exact:true})).toHaveCount(1);const promise=page.waitForEvent('download');await page.getByRole('button',{name:'下载文件',exact:true}).click();const bytes=await readFile(await (await promise).path());assert.equal(bytes.toString().trim(),marker);report.artifactSha256=sha(bytes);}
 const bytes=await readFile(path.join(completed.native.workingDirectory,'proof.txt'));assert.equal(bytes.toString().trim(),marker);assert.equal(sha(bytes),report.artifactSha256);report.phases.push('real provider SDK write/read + UI artifact bytes SHA-256');await screenshot('01-artifact');
 const stopMarker='STOP_'+marker,command=`printf '${stopMarker}' > stop-started.txt; /bin/sleep 20; printf 'SHOULD_NOT_EXIST' > stop-after.txt`;
 const task=await create(`请立即使用 bash 工具严格执行这一条命令，不要先执行其他工具，也不要拆分：${command}\n这是用户授权的隔离 STOP 测试。命令结束才回复。`);report.stopCreate=task;
 const running=await waitFacts(task.id,d=>d.native?.state==='RUNNING'&&!!d.native.workingDirectory),work=running.native.workingDirectory;
 await expect.poll(async()=>readFile(path.join(work,'stop-started.txt'),'utf8').then(s=>s.trim(),()=>''),{timeout:120000,intervals:[100,200]}).toBe(stopMarker);
 const at=Date.now(),ps=execFileSync('/bin/ps',['-axo','pid=,ppid=,args='],{encoding:'utf8'}).split('\n').filter(l=>l.includes(stopMarker)&&l.includes('/bin/bash'));assert(ps.length>0,'actual shell must be alive at STOP');report.beforeStop={taskId:running.native.taskId,sourceState:'RUNNING',markerObservedAt:at,marker:stopMarker,ownedShells:ps};
 const button=page.getByRole('button',{name:web?'停止原生任务':'停止 Mac 任务',exact:true});await expect(button).toBeEnabled();await button.click();await expect(page.getByRole('button',{name:'只读核对停止请求',exact:true})).toBeVisible();
 if(web){const url=page.url();await close();await launch();await page.goto(url);}else{await close();await launch();}
 await expect(page.getByRole('button',{name:'只读核对停止请求',exact:true})).toBeVisible();await page.getByRole('button',{name:'只读核对停止请求',exact:true}).click();
 const stopped=await waitFacts(task.id,d=>d.native?.intakeClosed===true&&d.native?.state==='RECOVERY_REQUIRED');assert.equal(stopped.native.localQuiescent,false);assert.equal(stopped.native.quiescent,false);report.stopped=stopped;
 if(!web){await expect.poll(async()=>JSON.parse(await page.getByTestId('stop-facts').textContent()).receipt?.state).toBe('OBSERVED');report.stop=JSON.parse(await page.getByTestId('stop-facts').textContent());}else{await expect(page.getByText(/停止原请求：/)).toContainText('REQUESTED');report.stop=await page.getByText(/停止原请求：/).textContent();}
 await expect.poll(()=>Date.now()-at,{timeout:30000,intervals:[1000]}).toBeGreaterThan(23000);assert.equal(await stat(path.join(work,'stop-after.txt')).then(()=>true,()=>false),false,'STOP failed: delayed write ran');report.stopProbe={observedMilliseconds:Date.now()-at,delayedEffectAbsent:true,allEffectsQuiescentClaimed:false};report.phases.push('actual shell RUNNING → guarded STOP; lost source reply → original receipt; delayed write absent, UNKNOWN retained');await screenshot('02-stop');assert.deepEqual(errors,[]);report.result='PASS';
}catch(e){report.error={name:e.name,message:e.message};await screenshot('failure').catch(()=>{});}finally{report.rendererErrors=errors;await close();await writeFile(path.join(out,'result.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({result:report.result,lane:ready.lane,model:ready.model,error:report.error}));}
if(report.result!=='PASS')process.exitCode=1;
