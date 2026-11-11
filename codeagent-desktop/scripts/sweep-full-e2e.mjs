// Comprehensive UI E2E sweep for codeagent-desktop — attaches to the running
// Electron via CDP :9333 and walks every reachable surface per PLAN.md.
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const webRequire=createRequire(path.resolve(root,'../control-plane-web/package.json'));
const {chromium,expect}=webRequire('@playwright/test');
const OUT='D:/E2E-Test/electron/2026-11-04-02';
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
  // DOM dispatch: floating layers (e.g. collaboration panel) can physically
  // occlude a pane's close button — recorded as a finding, not a blocker.
  for(let i=0;i<4;i++){
    const done=await page.evaluate(()=>{
      const el=[...document.querySelectorAll('[aria-label]')].find(e=>/^关闭(面板|目录面板|状态面板|导出面板|终端面板|任务详情)$/.test(e.getAttribute('aria-label')||'')&&e.offsetParent!==null);
      if(!el)return true;
      el.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true}));
      return false;
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
const state=async()=>txt('.status-pill, [data-testid="native-task-state"]');

// ---------- A. shell & navigation ----------
await page.reload({waitUntil:'domcontentloaded'});
await page.waitForTimeout(3500);
await shot('01-home');step('home');
// sidebar sections presence
const sections=await page.locator('.rail-section').allTextContents();
find('rail-sections: '+sections.map(s=>s.slice(0,24)).join(' | '));
await shot('02-sidebar');
// rail menu
await page.getByLabel('更多会话栏操作').click().catch(()=>{});
await page.waitForTimeout(500);
await shot('03-rail-menu');step('rail-menu');
await page.keyboard.press('Escape');await page.waitForTimeout(300);
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
const radios=await sourceWrap.locator('button').allTextContents();
find('new-session-sources: '+radios.join('|'));
const nativeRadio=sourceWrap.getByRole('radio',{name:'原生任务'});
await closePanes();
if(await nativeRadio.count()){await nativeRadio.click();await page.waitForTimeout(1200);await shot('11-source-native');}
else skip('native source radio not found');
step('source-native');
// back to agent source, pick workspace project
await sourceWrap.getByRole('radio',{name:'智能体会话'}).click().catch(()=>{});
await page.waitForTimeout(600);
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
// reset project back to plain conversation for C section
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
// running state
for(let i=0;i<24;i++){if(await page.locator('button[aria-label="终止运行"]').count())break;await page.waitForTimeout(1000);}
await shot('22-acs-running');step('acs-running');
// wait for run end
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
// conversation header panels
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
// directory chip
const dirChip=page.locator('button.directory-trigger, button:has-text("目录")').first();
if(await dirChip.count()){await dirChip.click();await page.waitForTimeout(1200);await shot('28-directory');step('directory');await dirChip.click().catch(()=>{});}
else skip('directory chip absent');
// export panel — collaboration panel can overlap the header; collapse it first
await page.evaluate(()=>{document.querySelectorAll('details.collaboration-panel[open]').forEach(d=>d.removeAttribute('open'));});
await page.waitForTimeout(300);
const expBtn=page.getByTestId('conversation-export-button');
if(await expBtn.count()&&!(await expBtn.isDisabled())){
  await page.evaluate(()=>{const el=document.querySelector('[data-testid="conversation-export-button"]');el?.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true}));});
  await page.waitForTimeout(1000);await shot('29-export');step('export');
  await closePanes();
}
else skip('export disabled/absent');
// sidebar row for the new session
await shot('30-acs-row');step('acs-done');

// ---------- D. native lane: pi full lifecycle ----------
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
const idEl=page.getByTestId('task-id');
const prevId=((await idEl.count()?await idEl.textContent():'')??'').trim();
await page.getByRole('button',{name:'开始原生任务',exact:true}).click();
let piTaskId='';
for(let i=0;i<40;i++){const t=((await idEl.textContent())??'').trim();if(t.length>0&&t!==prevId){piTaskId=t;break;}await page.waitForTimeout(500);}
report.piTaskId=piTaskId;step('pi-created '+piTaskId);
await shot('41-pi-created');
const piRow=page.getByTestId('native-task-row-'+piTaskId);
await expect(piRow).toBeVisible({timeout:30000});
await piRow.click();
await expect(page.getByTestId('native-conversation')).toBeVisible({timeout:15000});
await page.waitForTimeout(5000);
await shot('42-pi-running');step('pi-running');
await page.getByRole('button',{name:'状态',exact:true}).first().click();
await page.waitForTimeout(1200);
await shot('43-pi-status-dialog');step('pi-status-dialog');
await page.getByLabel('关闭任务详情').first().click().catch(()=>{});
await page.waitForTimeout(400);
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
await shot('46-pi-artifacts-or-disabled');step('pi-artifacts');
await page.getByLabel('关闭任务详情').first().click().catch(()=>{});
await page.waitForTimeout(400);
await page.getByRole('button',{name:'诊断',exact:true}).first().click().catch(()=>{});
await page.waitForTimeout(1000);
await shot('47-pi-diag');step('pi-diag');
await page.getByLabel('关闭任务详情').first().click().catch(()=>{});
await page.waitForTimeout(400);
const noteCount=await page.locator('[data-testid="native-stream-note"]').count();
find('pi-settled-stream-note='+noteCount);
const ncomposer=page.locator('textarea').last();
await ncomposer.fill('e2e 草稿留存测试');
const otherRow=page.locator('[data-testid^="native-task-row-"]').nth(1);
if(await otherRow.count()){await otherRow.click();await page.waitForTimeout(800);await piRow.click();await page.waitForTimeout(800);}
const draftVal=await ncomposer.inputValue().catch(()=> '');
find('native-draft-persist='+(draftVal.includes('e2e 草稿留存测试')));
await shot('48-draft');
const cancelledTask='task-f2851dad-8ef9-4eb6-abef-bf17418da2f0';
const crow=page.getByTestId('native-task-row-'+cancelledTask);
if(await crow.count()){await crow.click();await page.waitForTimeout(2000);await shot('49-cancelled');step('cancelled-view');}
else skip('cancelled task row absent');
await shot('50-sidebar-native');

// ---------- E. cross-cutting ----------
await page.getByLabel('个人接入').click().catch(()=>{});
await page.waitForTimeout(1200);await shot('60-personal-access');step('personal-access');
await page.getByLabel('设置').click().catch(()=>{});
await page.waitForTimeout(1200);await shot('61-settings');step('settings');
find('UNREACHABLE: CommandPalette never opens (commandPaletteOpen has no setter call) - EXTENSIONS/MISSIONS surfaces unreachable in this build');
await goWorkspace();
await shot('70-final-workspace');

await writeFile(`${OUT}/result.json`,JSON.stringify(report,null,2));
console.log('DONE '+JSON.stringify({shots:report.shots.length,errors:report.errors.length,skipped:report.skipped.length,finds:report.finds.length,piFinalState:report.piFinalState}));
await b.close();
