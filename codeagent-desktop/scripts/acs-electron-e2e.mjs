import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';

// ACS-lane evidence: start ACS service :8766 + gateway :8861 beforehand.
// Launches real Electron, verifies ACS attaches (banner gone), creates a
// session through the real UI, samples conversation growth, screenshots,
// then opens a native codep task for same-app rendering comparison.
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const require=createRequire(path.join(root,'package.json'));
const webRequire=createRequire(path.resolve(root,'../control-plane-web/package.json'));
const {_electron,expect}=webRequire('@playwright/test');
assert(process.env.CODEAGENT_SERVICE_ENDPOINT&&process.env.CODEAGENT_SERVICE_TOKEN&&process.env.PC_E2E_OUTPUT,'ACS endpoint+token+output required');
const output=path.resolve(process.env.PC_E2E_OUTPUT);await mkdir(output,{recursive:true});
const env={...process.env,CODEAGENT_DESKTOP_PROFILE:'acs-e2e',CODEAGENT_DESKTOP_PROFILE_ROOT:path.join(output,'profiles')};delete env.ELECTRON_RUN_AS_NODE;
const report={schemaVersion:'acs-electron-e2e/1',result:'FAIL',steps:[],samples:[]};
let app,page;
try{
 app=await _electron.launch({executablePath:require('electron'),args:[root],cwd:root,env});
 page=await app.firstWindow();
 await page.waitForTimeout(6000); // service attach + capability handshake
 report.acsBanner=await page.locator('text=ACS 会话服务未连接').count();
 await page.screenshot({path:path.join(output,'acs-start.png')});
 // New session via the real form.
 const goal=page.getByLabel('说说想做什么');
 await expect(goal).toBeVisible({timeout:20000});
 await goal.fill('Tell me a 400-word bedtime story about a paper boat crossing a harbor at night.');
 await page.getByRole('button',{name:'开始会话'}).click();
 report.steps.push('ui-create');
 const conv=page.locator('.conversation').first();
 await expect(conv).toBeVisible({timeout:30000});
 report.steps.push('conversation-mounted');
 for(let i=0;i<30;i++){
   await page.waitForTimeout(2500);
   const txt=await conv.innerText();
   report.samples.push({i,len:txt.length});
 }
 const lens=report.samples.map(s=>s.len);
 report.maxLen=Math.max(...lens);
 report.growth=lens.at(-1)-lens.find(v=>v>0);
 await page.screenshot({path:path.join(output,'acs-conversation.png')});
 // Now open a native codep task row in the same app for rendering comparison.
 const codepRow=page.locator('[data-testid^="native-task-row-"]').first();
 if(await codepRow.count()){
   await codepRow.click();
   await expect(page.getByTestId('native-conversation')).toBeVisible({timeout:15000});
   await page.waitForTimeout(1500);
   await page.screenshot({path:path.join(output,'native-comparison.png')});
   report.steps.push('native-comparison');
 }
 assert(report.acsBanner===0,'ACS banner still shown — service not attached');
 assert(lens.filter(v=>v>0).length>=2,'conversation text never appeared');
 assert(lens.at(-1)>lens.find(v=>v>0),'conversation did not grow');
 report.result='ACS_LIVE_PROVEN';
}catch(error){report.error=error.message;if(page){try{await page.screenshot({path:path.join(output,'failed.png')})}catch{}}}
finally{if(app)await app.close();await writeFile(path.join(output,'result.json'),JSON.stringify(report,null,2));}
console.log(JSON.stringify({result:report.result,acsBanner:report.acsBanner,maxLen:report.maxLen,growth:report.growth,steps:report.steps,error:report.error}));
if(report.result==='FAIL')process.exitCode=1;
