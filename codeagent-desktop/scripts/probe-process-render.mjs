import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const require=createRequire(path.join(root,'package.json'));
const webRequire=createRequire(path.resolve(root,'../control-plane-web/package.json'));
const {_electron,expect}=webRequire('@playwright/test');
const OUT=process.env.PC_E2E_OUTPUT||'E:/project/e2e-electron-pi+codex/process-probe';
const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
const PROFILE=process.env.PROBE_PROFILE||'proc-probe';
const PROFILE_ROOT=process.env.PROBE_PROFILE_ROOT||path.join(OUT,'_profiles');
const app=await _electron.launch({executablePath:require('electron'),args:[root],cwd:root,env:{...env,CODEAGENT_DESKTOP_PROFILE:PROFILE,CODEAGENT_DESKTOP_PROFILE_ROOT:PROFILE_ROOT}});
const page=await app.firstWindow();
await page.waitForTimeout(6000);
// open native launcher, pick engine from arg
const engine=process.env.PROBE_ENGINE||'codep';
await page.getByRole('button',{name:/新建会话/}).first().click();
await page.waitForTimeout(1000);
await page.locator('[data-testid="new-session-source-native"]').click();
await page.waitForTimeout(700);
const projSel=page.locator('select[aria-label="原生项目"]');
const opts=await projSel.locator('option').allInnerTexts();
console.log('PROJECTS',JSON.stringify(opts));
// find project for engine
let proj=null;
for(const o of opts.filter(o=>o.trim()&&o!=='选择已登记项目')){
  await projSel.selectOption({label:o});
  await page.waitForTimeout(600);
  const vals=await page.locator('select[aria-label="原生引擎"] option').evaluateAll(os=>os.map(o=>o.value));
  if(vals.includes(engine)){proj=o;break}
}
if(!proj){console.log('NO_PROJECT_FOR',engine);await app.close();process.exit(1)}
await page.locator('select[aria-label="原生引擎"]').selectOption(engine);
await page.locator('[data-testid="native-instruction"]').fill('Use your tools: list the files in the project root with the ls tool, read README.md if it exists, then write a one-paragraph summary of what this project is.');
await page.locator('[data-testid="native-create"]').click();
await expect(page.getByTestId('native-conversation')).toBeVisible({timeout:30000});
await mkdir(OUT,{recursive:true});
// sample while running
let settled=false;const shots=[];
for(let i=0;i<120;i++){
  const t=await page.getByTestId('native-conversation').innerText();
  const proc=await page.getByTestId('native-process').count();
  const think=await page.locator('[data-testid^="native-thinking-"]').count();
  const tail=await page.locator('[data-testid="native-message-native-live-tail"]').count();
  if(i%10===0||proc&&!shots.includes('proc')||think&&!shots.includes('think')){
    const name=`s${String(i).padStart(3,'0')}`;
    await page.screenshot({path:path.join(OUT,name+'.png')});shots.push(name);
  }
  if(/已完成|FAILED|已取消/.test(t)&&!tail){settled=true;await page.waitForTimeout(1500);break}
  await page.waitForTimeout(2500);
}
await page.screenshot({path:path.join(OUT,'final.png')});
const facts={
  settled,
  processBlock:await page.getByTestId('native-process').count(),
  processRows:await page.locator('.native-process-list li').count(),
  processHeader:await page.locator('.run-process-summary').innerText().catch(()=>null),
  thinkingBlocks:await page.locator('[data-testid^="native-thinking-"]').count(),
  rows:(await page.locator('.native-process-list li').allInnerTexts()).slice(0,8),
};
await writeFile(path.join(OUT,'facts.json'),JSON.stringify(facts,null,2));
console.log(JSON.stringify(facts,null,1));
await app.close();
