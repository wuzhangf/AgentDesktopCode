import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';

// Three-lane render parity: same markdown-heavy prompt through the real UI on
// ACS session, Pi native task, Codep native task. Captures rendered innerHTML
// tag histograms + screenshots so renderer differences are measurable, not
// eyeballed.
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const require=createRequire(path.join(root,'package.json'));
const webRequire=createRequire(path.resolve(root,'../control-plane-web/package.json'));
const {_electron,expect}=webRequire('@playwright/test');
const output=path.resolve(process.env.PC_E2E_OUTPUT);await mkdir(output,{recursive:true});
const env={...process.env,CODEAGENT_DESKTOP_PROFILE:'lane-compare',CODEAGENT_DESKTOP_PROFILE_ROOT:path.join(output,'profiles')};delete env.ELECTRON_RUN_AS_NODE;
const PROMPT='Reply using markdown with exactly these elements: a level-2 heading, one bullet list of 3 items, one **bold** word, one `inline code` span, and a fenced code block containing print(42). Then one short closing line.';
const report={schemaVersion:'lane-render-compare/1',result:'FAIL',lanes:{},domDiffs:[]};
function histogram(html){
  const tags={};
  for(const m of html.matchAll(/<([a-zA-Z][a-zA-Z0-9]*)\b/g)) tags[m[1].toLowerCase()]=(tags[m[1].toLowerCase()]||0)+1;
  const classes=new Set();
  for(const m of html.matchAll(/class="([^"]+)"/g)) m[1].split(/\s+/).forEach(c=>classes.add(c));
  return {tags,classes:[...classes].sort()};
}
let app,page;
async function settle(waiter,timeout=240000){
  const t0=Date.now();
  while(Date.now()-t0<timeout){
    const s=await waiter();
    if(s)return s;
    await page.waitForTimeout(3000);
  }
  return null;
}
try{
  app=await _electron.launch({executablePath:require('electron'),args:[root],cwd:root,env});
  page=await app.firstWindow();
  await page.waitForTimeout(6000);

  // ---------- ACS lane ----------
  await page.getByRole('radio',{name:'智能体会话'}).click().catch(()=>{});
  const goal=page.getByLabel('说说想做什么');
  await expect(goal).toBeVisible({timeout:20000});
  await goal.fill(PROMPT);
  await page.getByRole('button',{name:'开始会话'}).click();
  const conv=page.locator('.conversation').first();
  await expect(conv).toBeVisible({timeout:30000});
  const acsDone=await settle(async()=>/SUCCEEDED|FAILED/.test(await conv.innerText())?true:null,300000);
  report.lanes.acs={settled:!!acsDone};
  await page.screenshot({path:path.join(output,'lane-acs.png')});
  report.lanes.acs.dom=histogram(await conv.innerHTML().catch(()=> ''));

  // ---------- native lanes (Pi + Codep launcher form) ----------
  await page.getByRole('button',{name:/新建会话/}).first().click();
  await page.waitForTimeout(1200);
  await page.locator('[data-testid="new-session-source-native"]').click();
  await page.waitForTimeout(800);
  const projSel=page.locator('select[aria-label="原生项目"]');
  await projSel.waitFor({timeout:15000});
  const options=await projSel.locator('option').allInnerTexts();
  report.projectOptions=options;
  const instr=page.locator('[data-testid="native-instruction"]');
  const engSel=page.locator('select[aria-label="原生引擎"]');
  // Discover which project exposes which engine: the engine select lists the
  // worker's engineIds bound to the chosen project.
  const engineProject={};
  for(const opt of options.filter(o=>o.trim()&&o!=='选择已登记项目')){
    await projSel.selectOption({label:opt});
    await page.waitForTimeout(700);
    if(await engSel.count()){
      for(const v of await engSel.locator('option').evaluateAll(os=>os.map(o=>o.value))){
        if(v)engineProject[v]=opt;
      }
    }
  }
  report.engineProject=engineProject;
  async function nativeLane(label,optText,engineId){
    await projSel.selectOption({label:optText});
    await page.waitForTimeout(600);
    if(await engSel.count()){
      const vals=await engSel.locator('option').evaluateAll(os=>os.map(o=>o.value));
      if(vals.includes(engineId))await engSel.selectOption(engineId);
    }
    await instr.fill(PROMPT+' ['+label+']');
    await page.locator('[data-testid="native-create"]').click();
    const ncv=page.getByTestId('native-conversation');
    await expect(ncv).toBeVisible({timeout:30000});
    const done=await settle(async()=>{
      const t=await ncv.innerText();
      return /已完成|SUCCEEDED|FAILED|已取消/.test(t)?t:null;
    },300000);
    report.lanes[label]={settled:!!done,tail:done?done.slice(-200):null};
    await page.screenshot({path:path.join(output,'lane-'+label+'.png')});
    report.lanes[label].dom=histogram(await ncv.innerHTML());
    await page.getByRole('button',{name:/新建会话/}).first().click();
    await page.waitForTimeout(1000);
    await page.locator('[data-testid="new-session-source-native"]').click();
    await page.waitForTimeout(800);
  }
  if(engineProject.pi)await nativeLane('pi',engineProject.pi,'pi');
  if(engineProject.codep)await nativeLane('codep',engineProject.codep,'codep');

  // ---------- DOM diff on the render-bearing tags ----------
  const interesting=['h1','h2','h3','ul','ol','li','strong','em','code','pre','blockquote','table','a'];
  const lanes=Object.entries(report.lanes);
  for(const [name,l] of lanes){
    report.lanes[name].interesting={};
    for(const t of interesting)report.lanes[name].interesting[t]=l.dom.tags[t]||0;
  }
  const keys=lanes.map(([n])=>n);
  for(const t of interesting){
    const counts=lanes.map(([,l])=>l.interesting[t]);
    if(new Set(counts).size>1)report.domDiffs.push({tag:t,counts:Object.fromEntries(keys.map((k,i)=>[k,counts[i]]))});
  }
  assert(lanes.length===3,'expected 3 lanes, got '+keys.join(','));
  assert(lanes.every(([,l])=>l.settled),'a lane never settled');
  assert(report.domDiffs.length===0,'render tag diffs: '+JSON.stringify(report.domDiffs));
  report.result='RENDER_PARITY_PROVEN';
}catch(error){report.error=error.message;if(page){try{await page.screenshot({path:path.join(output,'failed.png')})}catch{}}}
finally{if(app)await app.close();await writeFile(path.join(output,'result.json'),JSON.stringify(report,null,2));}
console.log(JSON.stringify({result:report.result,lanes:Object.fromEntries(Object.entries(report.lanes).map(([k,v])=>[k,{settled:v.settled,interesting:v.interesting}])),domDiffs:report.domDiffs,projects:report.projectOptions,error:report.error}));
if(report.result==='FAIL')process.exitCode=1;
