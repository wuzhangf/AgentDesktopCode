import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';

// Start independent production gateway/Host beforehand. No credentials enter
// this driver; Electron main owns the gateway session and bounded operations.
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const require=createRequire(path.join(root,'package.json'));
const webRequire=createRequire(path.resolve(root,'../control-plane-web/package.json'));
const {_electron,expect}=webRequire('@playwright/test');
assert(process.env.CODEAGENT_PERSONAL_ENDPOINT&&process.env.PC_E2E_OUTPUT&&process.env.PC_E2E_INSTRUCTION_FILE&&process.env.PC_E2E_PROJECT,'Explicit isolated gateway, project label, instruction file and new output directory required');
const output=path.resolve(process.env.PC_E2E_OUTPUT);await mkdir(output,{recursive:false});
const instruction=await readFile(process.env.PC_E2E_INSTRUCTION_FILE,'utf8');
const env={...process.env,CODEAGENT_DESKTOP_PROFILE:'windows-native-e2e',CODEAGENT_DESKTOP_PROFILE_ROOT:path.join(output,'profiles')};delete env.ELECTRON_RUN_AS_NODE;
const report={schemaVersion:'windows-native-electron/1',result:'FAIL',steps:[],saveDialog:process.env.PC_E2E_SAVE_DIR?'instrumented-path-only':'not-automated'};
let app,page;
try{
 app=await _electron.launch({executablePath:require('electron'),args:[root],cwd:root,env});page=await app.firstWindow();
 await expect(page.getByRole('heading',{name:'原生任务',exact:true})).toBeVisible();
 await page.getByLabel('原生项目').selectOption({label:process.env.PC_E2E_PROJECT});
 await expect(page.getByTestId('mac-preflight')).toContainText(process.env.PC_E2E_ENGINE??'pi');
 await page.getByLabel('原生任务要求').fill(instruction);await page.getByRole('button',{name:'开始原生任务',exact:true}).click();
 await expect(page.getByTestId('task-id')).not.toBeEmpty();report.steps.push('ui-create');
 await expect.poll(async()=>{report.task=JSON.parse(await page.getByTestId('task-facts').textContent());return report.task.native?.state;},{timeout:Number(process.env.PC_E2E_TIMEOUT_MS??600000),intervals:[1000,3000,5000]}).toBe('SUCCEEDED');
 report.steps.push('source-succeeded');
 if(report.task.native.quiescent!==true){await page.getByRole('button',{name:'停止原生任务',exact:true}).click();await expect.poll(async()=>{report.task=JSON.parse(await page.getByTestId('task-facts').textContent());return report.task.native?.quiescent;},{timeout:60000}).toBe(true);}
 assert.equal(report.task.native.state,'SUCCEEDED','STOP cleanup must preserve the completed outcome');report.steps.push('quiescence');
 const files=page.getByRole('button',{name:/^保存成果 /});await expect.poll(()=>files.count(),{timeout:30000}).toBeGreaterThan(0);
 if(process.env.PC_E2E_SAVE_DIR){
  const dir=path.resolve(process.env.PC_E2E_SAVE_DIR);await mkdir(dir,{recursive:false});
  await app.evaluate(({dialog},directory)=>{dialog.showSaveDialog=async options=>({canceled:false,filePath:directory+'/'+options.defaultPath.split(/[\\/]/).at(-1)});},dir);
  for(let i=0;i<await files.count();i++){await files.nth(i).click();await expect(page.getByTestId('verified-artifact').nth(i)).toContainText('已保存');}
  report.steps.push('main-verified-artifact-save');report.result='DELIVERED_ORACLE_PENDING';
 }else report.result='SOURCE_COMPLETE_SAVE_NOT_RUN';
 await page.screenshot({path:path.join(output,'completed.png')});
}catch(error){report.error=error.message;if(page){report.alerts=await page.getByRole('alert').allTextContents();await page.screenshot({path:path.join(output,'failed.png')}).catch(()=>{});}}
finally{if(app)await app.close();await writeFile(path.join(output,'result.json'),JSON.stringify(report,null,2));}
console.log(JSON.stringify({result:report.result,output}));
if(report.result==='FAIL')process.exitCode=1;
