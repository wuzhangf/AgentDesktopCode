// Verify ACS reasoning display end-to-end after restoring the
// reasoningWire profile on opencode-zen/deepseek-v4.1-flash.
// Drives the running Electron over CDP, polls the service reasoning
// snapshot, and checks the run-reasoning block in the DOM.
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {mkdirSync, writeFileSync} from 'node:fs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const webRequire=createRequire(path.resolve(root,'../control-plane-web/package.json'));
const {chromium}=webRequire('@playwright/test');

const OUT=process.env.VERIFY_OUT||path.resolve(root,'.local','verify-reasoning');
const SVC='http://127.0.0.1:8766';
const TOKEN=process.env.CODEAGENT_SERVICE_TOKEN||'';
mkdirSync(OUT,{recursive:true});
const report={errors:[],finds:[]};
const find=m=>{report.finds.push(m);console.log('[find]',m);};

const svcGet=async p=>{
  const r=await fetch(SVC+p,{headers:{Authorization:`Bearer ${TOKEN}`}});
  if(!r.ok)throw new Error('GET '+p+' -> '+r.status);
  return r.json();
};

const b=await chromium.connectOverCDP('http://localhost:9333');
const page=b.contexts()[0].pages()[0];
page.on('pageerror',e=>report.errors.push('pageerror: '+e.message));

// runs before send
const before=(await svcGet('/api/v2/runs')).items.map(r=>r.runId);
find('runs-before='+before.length);

// back to workspace, open launcher
const back=page.getByRole('button',{name:'返回',exact:true}).first();
if(await back.count())await back.click().catch(()=>{});
await page.locator('button[title="会话"]').first().click().catch(()=>{});
await page.waitForTimeout(1200);
if(!(await page.getByTestId('new-session').count()))
  await page.getByRole('button',{name:/新建会话/}).first().click().catch(()=>{});
await page.waitForTimeout(1000);

// bind to a workspace so the run lands in the observable lane
// (WORKSPACE=0 keeps the default ordinary-chat lane instead)
const projSel=page.getByTestId('new-session-project');
if(process.env.WORKSPACE!=='0'&&await projSel.count()){
  const opts=await projSel.locator('option').allTextContents();
  const pi=opts.findIndex(t=>/petclinic/i.test(t));
  find('project-opts='+opts.length+' petclinicIdx='+pi);
  if(pi>0)await projSel.selectOption({index:pi});
  await page.waitForTimeout(1200);
}
const PROMPT=process.env.PROMPT||'一句话介绍你自己，顺便说说你现在的心情。';

// pick the opencode-zen bound model if the selector offers a menu
const modelSel=page.getByTestId('new-session-model-selector');
if(await modelSel.count()){
  find('model-chip='+(await modelSel.textContent().catch(()=>'')).trim());
  await modelSel.click().catch(()=>{});
  await page.waitForTimeout(600);
  const opt=page.locator('[role="option"], [role="menuitem"], button').filter({hasText:/deepseek-v4\.1-flash/});
  const n=await opt.count();
  find('model-options-deepseek='+n);
  if(n){await opt.first().click();await page.waitForTimeout(400);}
  else await page.keyboard.press('Escape');
}

await page.getByLabel('说说想做什么').fill(PROMPT)
  .catch(async()=>{await page.locator('textarea').first().fill(PROMPT);});
await page.screenshot({path:OUT+'/01-draft.png'});
await page.getByRole('button',{name:/开始会话|开始聊天/}).click();
await page.waitForTimeout(2500);

// find the new run
let runId=null;
for(let i=0;i<30&&!runId;i++){
  const items=(await svcGet('/api/v2/runs')).items;
  const fresh=items.find(r=>!before.includes(r.runId));
  if(fresh)runId=fresh.runId;
  else await page.waitForTimeout(1000);
}
find('runId='+runId);

// watch for the reasoning block while it runs (any of the known folds)
const rsel='[data-testid="run-reasoning"],[data-testid="ungrouped-reasoning"],.round-thinking';
let liveSeen=false;
for(let i=0;i<40;i++){
  if(await page.locator(rsel).count()){liveSeen=true;break;}
  const stopping=await page.locator('button[aria-label="终止运行"]').count();
  if(!stopping&&i>4)break;
  await page.waitForTimeout(1500);
}
find('live-reasoning-block='+liveSeen);
if(liveSeen)await page.screenshot({path:OUT+'/02-reasoning-live.png'});

// wait for settle
let done=false;
for(let i=0;i<90;i++){
  const stopping=await page.locator('button[aria-label="终止运行"]').count();
  const queued=await page.locator('button[aria-label="排队发送"]').count();
  if(!stopping&&!queued){done=true;break;}
  await page.waitForTimeout(2500);
}
find('settled='+done);
await page.waitForTimeout(1200);
await page.screenshot({path:OUT+'/03-settled.png'});

// final DOM + snapshot check
const domReasoning=await page.locator(rsel).count();
find('dom-reasoning-elements='+domReasoning);
if(runId){
  const snap=await svcGet(`/api/v2/runs/${runId}/reasoning`);
  find('reasoning-snapshot: text.len='+ (snap.text||'').length
    +' segments='+(snap.segments||[]).length
    +' receivedBytes='+snap.receivedBytes
    +' totalBytes='+snap.totalBytes);
  report.snapshot={runId,textLen:(snap.text||'').length,segments:(snap.segments||[]).length,
    receivedBytes:snap.receivedBytes,totalBytes:snap.totalBytes,reasonCode:snap.reasonCode};
  if((snap.text||'').trim())writeFileSync(OUT+'/reasoning-text.txt',snap.text);
}

writeFileSync(OUT+'/result.json',JSON.stringify(report,null,2));
console.log('DONE errors='+report.errors.length,JSON.stringify(report.errors));
process.exit(0);
