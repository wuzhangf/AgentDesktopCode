import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';

// Live codep-lane evidence: start gateway + codep worker beforehand.
// Creates a task through the real UI, samples the live tail while RUNNING,
// proves growth, screenshots, then verifies the settled transcript.
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const require=createRequire(path.join(root,'package.json'));
const webRequire=createRequire(path.resolve(root,'../control-plane-web/package.json'));
const {_electron,expect}=webRequire('@playwright/test');
assert(process.env.CODEAGENT_PERSONAL_ENDPOINT&&process.env.PC_E2E_OUTPUT&&process.env.PC_E2E_PROJECT&&process.env.PC_E2E_ENGINE,'endpoint, output dir, project label, engine required');
const endpoint=process.env.CODEAGENT_PERSONAL_ENDPOINT.replace(/\/$/,'');
const output=path.resolve(process.env.PC_E2E_OUTPUT);await mkdir(output,{recursive:true});
const instruction=process.env.PC_E2E_INSTRUCTION??'Write a 900-word story about a lighthouse keeper who finds a message in a bottle. Prose only, no tools.';
const env={...process.env,CODEAGENT_DESKTOP_PROFILE:'codep-e2e',CODEAGENT_DESKTOP_PROFILE_ROOT:path.join(output,'profiles')};delete env.ELECTRON_RUN_AS_NODE;
const report={schemaVersion:'codep-electron-e2e/1',result:'FAIL',steps:[],samples:[]};
// Gateway session for state polling (same-origin control headers as the app).
let cookie='';
async function api(method,tail,body){
  const r=await fetch(endpoint+'/api/personal/v1'+tail,{method,headers:{'content-type':'application/json','x-personal-control':'1','x-personal-tab':'tab-codep-e2e-script',origin:endpoint,...(cookie?{cookie}:{})},body:body?JSON.stringify(body):undefined});
  const sc=r.headers.get('set-cookie');if(sc)cookie=sc.split(';')[0];
  return r.json();
}
let app,page;
try{
 app=await _electron.launch({executablePath:require('electron'),args:[root],cwd:root,env});
 page=await app.firstWindow();
 await page.getByLabel('原生任务诊断').click();
 await expect(page.getByRole('heading',{name:'原生任务',exact:true})).toBeVisible({timeout:30000});
 await page.getByLabel('原生项目').selectOption({label:process.env.PC_E2E_PROJECT});
 await expect(page.getByTestId('mac-preflight')).toContainText(process.env.PC_E2E_ENGINE);
 await page.getByLabel('原生任务要求').fill(instruction);
 await page.getByRole('button',{name:'开始原生任务',exact:true}).click();
 await expect(page.getByTestId('task-id')).not.toBeEmpty({timeout:15000});
 report.taskId=await page.getByTestId('task-id').textContent();
 report.steps.push('ui-create');
 // Open the task from the sidebar native list to mount the conversation.
 const row=page.getByTestId('native-task-row-'+report.taskId);
 await expect(row).toBeVisible({timeout:30000});
 await row.click();
 const conv=page.getByTestId('native-conversation');
 await expect(conv).toBeVisible({timeout:15000});
 await expect(page.getByTestId('native-task-engine')).toContainText(new RegExp(process.env.PC_E2E_ENGINE,'i'));
 report.steps.push('conversation-mounted');
 for(let i=0;i<40;i++){
   await page.waitForTimeout(2500);
   const tail=(await page.getByTestId('native-message-native-live-tail').textContent().catch(()=>''))??'';
   const detail=await api('GET','/tasks/'+report.taskId).catch(()=>({}));
   const state=detail?.data?.native?.state;
   report.samples.push({i,tailLen:tail.length,state,tailEnd:tail.slice(-60)});
   if(!report.midShot&&tail.length>800){report.midShot=true;await page.screenshot({path:path.join(output,'mid-stream.png')}).catch(()=>{});}
   if((state==='SUCCEEDED'||state==='FAILED'||state==='CANCELLED')&&tail.length===0)break;
 }
 const growing=report.samples.filter(s=>s.tailLen>0).map(s=>s.tailLen);
 report.maxTailLen=Math.max(0,...growing);
 report.growth=growing.length>=2?growing[growing.length-1]-growing[0]:0;
 const deadline=Date.now()+Number(process.env.PC_E2E_TIMEOUT_MS??420000);
 let state='';
 while(Date.now()<deadline){
   const detail=await api('GET','/tasks/'+report.taskId).catch(()=>({}));
   state=detail?.data?.native?.state??'';
   if(state==='SUCCEEDED'||state==='FAILED'||state==='CANCELLED')break;
   await page.waitForTimeout(3000);
 }
 assert.equal(state,'SUCCEEDED','task must settle SUCCEEDED');
 report.steps.push('source-succeeded');
 await page.waitForTimeout(2500); // let the renderer fold the settled transcript
 const body=await page.getByTestId('native-conversation-body').innerText();
 report.terminalTranscriptLen=body.length;
 assert(report.maxTailLen>0,'live tail never appeared');
 assert(growing.length<2||growing.at(-1)>growing[0],'live tail did not grow');
 // Terminal tasks must NOT replay-animated: no live tail after settle.
 const tailAfter=(await page.getByTestId('native-message-native-live-tail').count());
 assert.equal(tailAfter,0,'settled task still shows a live tail');
 await page.screenshot({path:path.join(output,'codep-live.png'),fullPage:false});
 report.result='LIVE_STREAM_PROVEN';
}catch(error){report.error=error.message;if(page){try{await page.screenshot({path:path.join(output,'failed.png')})}catch{}}}
finally{if(app)await app.close();await writeFile(path.join(output,'result.json'),JSON.stringify(report,null,2));}
console.log(JSON.stringify({result:report.result,taskId:report.taskId,maxTailLen:report.maxTailLen,steps:report.steps,error:report.error}));
if(report.result==='FAIL')process.exitCode=1;
