// Comprehensive UI E2E sweep for codeagent-desktop — 2026-11-04-01 run.
// Attaches to the running Electron via CDP :9333 and walks every reachable
// surface, screenshotting each state faithfully. Goal: prove the whole flow
// runs; functional blockers are fixed and re-run, UI review is out of scope.
// Evidence: E:\E2E-Test\electron\2026-11-04-01\<nn>-*.png + result.json
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const webRequire=createRequire(path.resolve(root,'../control-plane-web/package.json'));
const {chromium,expect}=webRequire('@playwright/test');
const OUT='E:/E2E-Test/electron/2026-11-04-01';
await mkdir(OUT,{recursive:true});
const report={steps:[],shots:[],finds:[],errors:[],skipped:[]};
const step=n=>{report.steps.push(n);console.log('step:',n);};
const find=n=>{report.finds.push(n);console.log('find:',n);};
const skip=n=>{report.skipped.push(n);console.log('skip:',n);};
const b=await chromium.connectOverCDP('http://localhost:9333');
const page=b.contexts()[0].pages()[0];
page.on('pageerror',e=>report.errors.push('pageerror: '+e.message));
page.on('console',m=>{if(m.type()==='error')report.errors.push('console: '+m.text().slice(0,300));});
const shot=async n=>{await page.screenshot({path:`${OUT}/${n}.png`});report.shots.push(n);};
const txt=async(sel)=>((await page.locator(sel).first().textContent().catch(()=>''))??'').trim();
const closePanes=async()=>{
  for(let i=0;i<4;i++){
    const done=await page.evaluate(()=>{
      let acted=false;
      // rail-menu backdrop closes on real mousedown (React handler) — dispatch it
      const bd=document.querySelector('.pane-menu-backdrop');
      if(bd){bd.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,cancelable:true}));acted=true;}
      const el=[...document.querySelectorAll('[aria-label]')].find(e=>/^关闭(面板|目录面板|状态面板|导出面板|终端面板|任务详情)$/.test(e.getAttribute('aria-label')||'')&&e.offsetParent!==null);
      if(el){el.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true}));acted=true;}
      return !acted;
    });
    if(done)break;
    await page.waitForTimeout(300);
  }
};
const goWorkspace=async()=>{
  const back=page.getByRole('button',{name:'返回',exact:true}).first();
  if(await back.count())await back.click().catch(()=>{});
  const done=page.getByRole('button',{name:'完成',exact:true}).first();
  if(await done.count())await done.click().catch(()=>{});
  await page.locator('button[title="会话"]').first().click().catch(()=>{});
  await page.waitForTimeout(800);
  await closePanes();
};
const closeTaskDialog=async()=>{
  const c=page.getByLabel('关闭任务详情');
  if(await c.count()){await c.first().click().catch(()=>{});await page.waitForTimeout(400);}
};

// ---------- A. shell & navigation ----------
await page.reload({waitUntil:'domcontentloaded'});
await page.waitForTimeout(3500);
await shot('01-home');step('home');
const sections=await page.locator('.rail-section').allTextContents();
find('rail-sections: '+sections.map(s=>s.slice(0,24)).join(' | '));
await shot('02-sidebar');
await page.getByLabel('更多会话栏操作').click().catch(()=>{});
await page.waitForTimeout(500);
await shot('03-rail-menu');step('rail-menu');
// backdrop closes the menu on real outside mousedown — verify it actually did
await page.evaluate(()=>{document.querySelector('.pane-menu-backdrop')?.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,cancelable:true}));});
await page.waitForTimeout(400);
find('rail-menu-outside-click-closed='+(await page.locator('.pane-menu-backdrop').count()===0));
await shot('03b-rail-menu-closed');
// bottom nav
await page.getByLabel('Git',{exact:true}).click().catch(()=>{});
await page.waitForTimeout(1200);await shot('05-nav-git');step('nav-git');
await closePanes();
await page.getByLabel('个人接入').click().catch(()=>{});
await page.waitForTimeout(1200);await shot('06-personal-access');step('nav-personal-access');
await page.getByLabel('设置').click().catch(()=>{});
await page.waitForTimeout(1200);await shot('07-settings');step('nav-settings');
const attnCount=await page.locator('button[title^="待处理"]').count();
if(attnCount){
  await page.locator('button[title^="待处理"]').first().click();
  await page.waitForTimeout(1000);await shot('08-attention');step('nav-attention');
}else skip('ATTENTION: no attention items, nav hidden');
await page.getByLabel('原生任务诊断').click().catch(()=>{});
await page.waitForTimeout(1200);await shot('09-native-diag');step('nav-native-diag');

// ---------- B. new-session launcher ----------
await goWorkspace();
await page.getByRole('button',{name:/新建会话/}).first().click().catch(()=>{});
await page.waitForTimeout(1000);
await shot('10-new-default');step('new-default');
const sourceWrap=page.getByTestId('new-session-source');
if(await sourceWrap.count()){
  const radios=await sourceWrap.locator('button').allTextContents();
  find('new-session-sources: '+radios.join('|'));
  const nativeRadio=sourceWrap.getByRole('radio',{name:'原生任务'});
  await closePanes();
  if(await nativeRadio.count()){await nativeRadio.click();await page.waitForTimeout(1200);await shot('11-source-native');}
  else skip('native source radio not found');
  step('source-native');
  await sourceWrap.getByRole('radio',{name:'智能体会话'}).click().catch(()=>{});
  await page.waitForTimeout(600);
}else skip('new-session-source absent');
const projSel=page.getByTestId('new-session-project');
if(await projSel.count()){
  const opts=await projSel.locator('option').allTextContents();
  find('new-session-projects: '+opts.join('|'));
  const pi=opts.findIndex(t=>/petclinic/i.test(t));
  if(pi>0)await projSel.selectOption({index:pi});
  await page.waitForTimeout(1500);
  await shot('12-workspace-selected');
  const profSel=page.getByLabel('专业智能体');
  if(await profSel.count()){
    const popts=await profSel.locator('option').allTextContents();
    find('agent-profiles: '+popts.join('|'));
    if(popts.length>1)await profSel.selectOption({index:1});
  }
  const modelSel=page.getByTestId('new-session-model-selector');
  if(await modelSel.count()){await modelSel.click().catch(()=>{});await page.waitForTimeout(500);await shot('14-model-menu');await page.keyboard.press('Escape');}
  await shot('13-profiles-models');
}else skip('new-session-project select absent');
step('launcher-forms');
if(await projSel.count())await projSel.selectOption({index:0}).catch(()=>{});
await page.waitForTimeout(400);

// ---------- C. ACS lane ----------
await goWorkspace();
if(!(await page.getByTestId('new-session').count()))
  await page.getByRole('button',{name:/新建会话/}).first().click().catch(()=>{});
await page.waitForTimeout(800);
await page.getByLabel('说说想做什么').fill('用一句中文自我介绍，说明你能做什么。').catch(async()=>{await page.locator('.new-session textarea, textarea').first().fill('用一句中文自我介绍，说明你能做什么。');});
await shot('20-acs-draft');
await page.getByRole('button',{name:/开始会话|开始聊天/}).click();
await page.waitForTimeout(2500);
await shot('21-acs-sent');step('acs-sent');
for(let i=0;i<24;i++){if(await page.locator('button[aria-label="终止运行"]').count())break;await page.waitForTimeout(1000);}
await shot('22-acs-running');step('acs-running');
let acsDone=false;
for(let i=0;i<72;i++){
  const stopping=await page.locator('button[aria-label="终止运行"]').count();
  const queued=await page.locator('button[aria-label="排队发送"]').count();
  if(!stopping&&!queued){acsDone=true;break;}
  await page.waitForTimeout(2500);
}
find('acs-run-done='+acsDone);
await page.waitForTimeout(1500);
await shot('23-acs-reply');step('acs-reply');
// 2026-11-06: 低频面板按钮收进「面板」菜单，菜单关闭时 testid 不挂载
const openPaneItem=async(tid)=>{
  let btn=page.getByTestId(tid);
  if(!(await btn.count())){await page.getByTestId('conversation-header-panes').click().catch(()=>{});await page.waitForTimeout(300);btn=page.getByTestId(tid);}
  return btn;
};
for(const[id,shotName]of[['conversation-header-status','24-activity-panel'],['conversation-header-evidence','25-evidence-pane'],['conversation-header-terminal','26-terminal-pane'],['conversation-header-git','27-git-pane']]){
  const btn=await openPaneItem(id);
  if(!(await btn.count())){skip(id+' absent');continue;}
  if(await btn.isDisabled()){find(id+' disabled');continue;}
  await btn.click();await page.waitForTimeout(1500);
  await shot(shotName);step(shotName);
  await closePanes();
}
const dirChip=page.locator('button.directory-trigger, button:has-text("目录")').first();
if(await dirChip.count()){await dirChip.click();await page.waitForTimeout(1200);await shot('28-directory');step('directory');await dirChip.click().catch(()=>{});}
else skip('directory chip absent');
await page.evaluate(()=>{document.querySelectorAll('details.collaboration-panel[open]').forEach(d=>d.removeAttribute('open'));});
await page.waitForTimeout(300);
const expBtn=page.getByTestId('conversation-export-button');
if(await expBtn.count()&&!(await expBtn.isDisabled())){
  await page.evaluate(()=>{const el=document.querySelector('[data-testid="conversation-export-button"]');el?.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true}));});
  await page.waitForTimeout(1000);await shot('29-export');step('export');
  await closePanes();
}
else skip('export disabled/absent');
await shot('30-acs-row');step('acs-done');

// ---------- D. native lane: pi full lifecycle ----------
const existingTaskRows=async()=>(await page.locator('[data-testid^="native-task-row-"]').evaluateAll(els=>els.map(e=>e.getAttribute('data-testid')))).filter(Boolean);
const createNativeTask=async(projectLabel,instruction)=>{
  await page.getByLabel('原生任务诊断').click();
  await expect(page.getByRole('heading',{name:'原生任务',exact:true})).toBeVisible({timeout:30000});
  const before=new Set(await existingTaskRows());
  await page.getByLabel('原生项目').selectOption({label:projectLabel});
  await page.waitForTimeout(2000);
  await page.getByLabel('原生任务要求').fill(instruction);
  await page.getByRole('button',{name:'开始原生任务',exact:true}).click();
  // current build opens the conversation on accept; taskId comes from the new sidebar row
  let taskId='';
  for(let i=0;i<60;i++){
    const rows=await existingTaskRows();
    const fresh=rows.find(r=>!before.has(r));
    if(fresh){taskId=fresh.replace('native-task-row-','');break;}
    await page.waitForTimeout(500);
  }
  if(!taskId)throw new Error('native task row never appeared for '+projectLabel);
  return taskId;
};
await page.getByLabel('原生任务诊断').click();
await expect(page.getByRole('heading',{name:'原生任务',exact:true})).toBeVisible({timeout:30000});
const projSel2=page.getByLabel('原生项目');
let projOpts=[];
for(let i=0;i<20;i++){
  projOpts=await projSel2.locator('option').allTextContents();
  if(projOpts.length>1)break;
  await page.waitForTimeout(1000);
}
find('native-projects: '+projOpts.join('|'));
const piIdx=projOpts.findIndex(t=>/e2e-scratch/i.test(t));
if(piIdx<0){skip('pi project e2e-scratch not in options');throw new Error('no pi project');}
await projSel2.selectOption({index:piIdx});
await page.waitForTimeout(2000);
await shot('40-pi-preflight');
await page.getByLabel('原生任务要求').fill('在工作区创建文件 pi-sweep.txt，内容写 "pi sweep"，然后用一句中文说明你做了什么');
await shot('40b-pi-instruction');
const beforeRows=new Set(await existingTaskRows());
await page.getByRole('button',{name:'开始原生任务',exact:true}).click();
let piTaskId='';
for(let i=0;i<60;i++){
  const rows=await existingTaskRows();
  const fresh=rows.find(r=>!beforeRows.has(r));
  if(fresh){piTaskId=fresh.replace('native-task-row-','');break;}
  await page.waitForTimeout(500);
}
report.piTaskId=piTaskId;step('pi-created '+piTaskId);
await shot('41-pi-created');
const piRow=page.getByTestId('native-task-row-'+piTaskId);
await expect(piRow).toBeVisible({timeout:30000});
if(!(await page.getByTestId('native-conversation').count()))await piRow.click();
await expect(page.getByTestId('native-conversation')).toBeVisible({timeout:15000});
await page.waitForTimeout(5000);
await shot('42-pi-running');step('pi-running');
await page.getByRole('button',{name:'状态',exact:true}).first().click();
await page.waitForTimeout(1200);
await shot('43-pi-status-dialog');step('pi-status-dialog');
await closeTaskDialog();
let piState='';
for(let i=0;i<96;i++){
  piState=(await page.getByTestId('native-task-state').textContent()||'').trim();
  if(/已完成|失败|已中断/.test(piState))break;
  if(i===30)await shot('44-pi-mid');
  await page.waitForTimeout(2500);
}
report.piFinalState=piState;step('pi-settled '+piState);
await page.waitForTimeout(1500);
await shot('45-pi-settled');
await page.getByRole('button',{name:'成果',exact:true}).first().click().catch(()=>{});
await page.waitForTimeout(1000);
await shot('46-pi-artifacts');step('pi-artifacts');
await closeTaskDialog();
await page.getByRole('button',{name:'诊断',exact:true}).first().click().catch(()=>{});
await page.waitForTimeout(1000);
await shot('47-pi-diag');step('pi-diag');
await closeTaskDialog();
const noteCount=await page.locator('[data-testid="native-stream-note"]').count();
find('pi-settled-stream-note='+noteCount);

// ---------- D2. native lane: stop flow on second task ----------
const taskId2=await createNativeTask('e2e-project','Write a very long story about a lighthouse keeper. Prose only, no tools. At least 900 words.');
report.taskId2=taskId2;step('task2-created '+taskId2);
const row2=page.getByTestId('native-task-row-'+taskId2);
await expect(row2).toBeVisible({timeout:30000});
if(!(await page.getByTestId('native-conversation').count()))await row2.click();
await expect(page.getByTestId('native-conversation')).toBeVisible({timeout:15000});
await page.waitForTimeout(3500);
await shot('50-task2-running');step('task2-running');
if(await page.locator('[data-testid="native-stop"]').count()){
  await page.locator('[data-testid="native-stop"]').click();
  await page.waitForTimeout(6000);
  report.stopResult=(await page.getByTestId('native-task-state').textContent()||'').trim();
  await shot('51-task2-stopped');step('stopped: '+report.stopResult);
  // composer state on a cancelled task
  await shot('52-task2-composer');
}else{report.stopResult='no-button';step('no-stop-button');}

// ---------- D3. draft persistence + reopen settled ----------
const ncomposer=page.locator('textarea').last();
await ncomposer.fill('e2e 草稿留存测试').catch(()=>{});
const otherRow=page.locator('[data-testid^="native-task-row-"]').nth(0);
if(await otherRow.count()){await otherRow.click();await page.waitForTimeout(800);await row2.click();await page.waitForTimeout(800);}
const draftVal=await ncomposer.inputValue().catch(()=>'');
find('native-draft-persist='+(draftVal.includes('e2e 草稿留存测试')));
await shot('53-draft');
await piRow.click().catch(()=>{});
await page.waitForTimeout(3000);
report.streamNoteOnSettled=await page.locator('[data-testid="native-stream-note"]').count();
await shot('54-reopen-settled');step('reopen-settled note='+report.streamNoteOnSettled);
await shot('55-sidebar-native');

// ---------- E. cross-cutting ----------
await page.getByLabel('个人接入').click().catch(()=>{});
await page.waitForTimeout(1200);await shot('60-personal-access');step('personal-access');
await page.getByLabel('设置').click().catch(()=>{});
await page.waitForTimeout(1200);await shot('61-settings');step('settings');
await goWorkspace();
await shot('70-final-workspace');

await writeFile(`${OUT}/result.json`,JSON.stringify(report,null,2));
console.log('DONE '+JSON.stringify({shots:report.shots.length,errors:report.errors.length,skipped:report.skipped.length,finds:report.finds.length,piFinalState:report.piFinalState,stopResult:report.stopResult}));
await b.close();
